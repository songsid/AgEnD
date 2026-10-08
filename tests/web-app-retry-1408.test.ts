/**
 * #1425 review r2: the chat recovering from a failed first load sees what is open now.
 *
 * Through the real entry (app.js), its Outlet, the real stream and the real chat store:
 * - the first import of the chat fails, the stream opens anyway and sends its connect frames (status, open prompts,
 *   ticks) to nobody; during the gap one prompt is answered elsewhere and one message's tick moves on;
 * - Retry loads the chat (?retry=1); the store catches up once over /ui/poll (passive), so the prompt still open is
 *   there, the one resolved in the gap is not, and the tick is the current one;
 * - still exactly one EventSource and no polling loop; a second boot returns the same store.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { installDom, settle, fire } from "./helpers/mini-dom.js";

const P1 = "a".repeat(32), P2 = "b".repeat(32);
const MSG = { instance: "alpha", boot: 1, id: 5, role: "user", sender: "web-user", text: "hello", ts: "2026-10-09T00:00:00Z", messageId: "m5" };
const STATUS = { uptime: 1, instances: [{ name: "alpha", status: "running", state: "idle", execution_state: "idle" }] };
const prompt = (nonce: string, text: string) => ({ instance: "alpha", nonce, text, actions: [{ id: "ok", label: "OK" }], expiresAt: 9e15 });

let dom: ReturnType<typeof installDom>;
const sources: any[] = [];
const requests: string[] = [];
let failChat = true;

beforeAll(async () => {
  dom = installDom({ url: "http://127.0.0.1:19280/ui/chat/alpha", storage: { agend_tour_done: "1" } });
  const app = dom.document.createElement("div"); app.id = "app"; dom.document.body.appendChild(app);
  dom.document.body.setAttribute("data-mode", "full");
  const g = globalThis as any;
  g.EventSource = class { url: string; listeners: Record<string, (e: unknown) => void> = {}; onerror: unknown = null;
    constructor(u: string) { this.url = u; sources.push(this); }
    addEventListener(n: string, f: (e: unknown) => void) { this.listeners[n] = f; } close() {} };
  g.fetch = async (path: string, init: { method?: string } = {}) => {
    requests.push(`${init.method ?? "GET"} ${path}`);
    const json = path.startsWith("/ui/poll")
      // What the server holds now: P1 still open (P2 was answered during the gap), m5 delivered.
      ? { status: STATUS, messages: [], cursor: "1-5", deliveries: [{ instance: "alpha", messageId: "m5", delivery: "delivered" }], prompts: [prompt(P1, "still open")], needs: [] }
      // The history carries each message's current tick, as the server's web-chat history does (m.delivery).
      : path.startsWith("/ui/history") ? { messages: [{ ...MSG, delivery: "delivered" }] } : {};
    return { ok: !path.startsWith("/auth/"), status: path.startsWith("/auth/") ? 401 : 200, json: async () => json };
  };
  const { options } = await import("/assets/preact.module.js");
  options.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  vi.doMock("/ui/js/panel-chat.js", async () => {
    if (failChat) throw new Error("network: the first load failed");
    return await vi.importActual("/ui/js/panel-chat.js");
  });
});
afterAll(() => { dom.restore(); delete (globalThis as any).EventSource; delete (globalThis as any).fetch; vi.doUnmock("/ui/js/panel-chat.js"); });

const send = (name: string, data: unknown) => sources[0].listeners[name]?.({ data: JSON.stringify(data) });

describe("Retry after a failed first load of the chat", () => {
  it("shows the prompt still open, not the one resolved in the gap, with the current tick — on one stream", async () => {
    await import("/assets/app.js");
    await vi.waitFor(() => expect(sources.map(s => s.url)).toEqual(["/ui/events"]));   // the stream opened although the chat failed
    const root = dom.document.getElementById("app")!;
    await vi.waitFor(() => expect(root.querySelector(".error-state")).not.toBeNull());
    // The connect frames go out while nobody in the chat listens…
    send("status", STATUS);
    send("prompts", [prompt(P1, "still open"), prompt(P2, "answered meanwhile")]);
    send("deliveries", [{ instance: "alpha", messageId: "m5", delivery: "queued" }]);
    // …and during the gap one prompt is answered elsewhere and the tick moves on.
    send("prompt_resolved", { instance: "alpha", nonce: P2, outcome: "done on Telegram" });
    send("delivery", { instance: "alpha", messageId: "m5", delivery: "delivered" });
    // A healthy stream only sends status from here on.
    send("status", STATUS); send("status", STATUS);
    failChat = false;
    requests.length = 0;
    root.querySelector(".error-state button")!.click();
    await vi.waitFor(() => expect(root.querySelectorAll(".prompt").length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(root.querySelector(".tick")).not.toBeNull());
    // One passive catch-up read, then the chat's own history read; no polling loop, still one EventSource.
    expect(requests.filter(r => r.startsWith("GET /ui/poll"))).toEqual(["GET /ui/poll?after="]);
    expect(requests.some(r => r.startsWith("GET /ui/history?instance=alpha"))).toBe(true);
    expect(sources).toHaveLength(1);
    // The catch-up is one read, not the polling fallback: the connection is still the live stream.
    const { appStore } = await import("/assets/app-store.js");
    expect(appStore.get().connection).toBe("live");
    const prompts = root.querySelectorAll(".prompt").map((c: any) => c.querySelector(".txt")?.textContent);
    expect(prompts).toEqual(["still open"]);
    expect(root.innerHTML).not.toContain("answered meanwhile");
    const tick = root.querySelector(".tick");
    expect(tick?.className).toContain("tick-delivered");
    // A status heartbeat later changes nothing about that.
    send("status", STATUS); await settle(4);
    expect(root.querySelectorAll(".prompt")).toHaveLength(1);
    await new Promise(r => setTimeout(r, 50));
    expect(requests.filter(r => r.startsWith("GET /ui/poll"))).toHaveLength(1);
  });

  it("the store the recovery booted is the one the page keeps (boot is once)", async () => {
    const chat = await import("/ui/js/panel-chat.js?retry=1");
    const s1 = chat.store;
    expect(s1).toBeTruthy();
    expect(chat.boot({ stream: { on() { return () => {}; } }, boot: null })).toBe(s1);
    // The composer still works on it: a draft typed now is the store's.
    const box = dom.document.querySelector("#msgIn") as any;
    box.value = "draft"; fire(box, "input"); await settle();
    expect(s1.state.drafts.alpha).toBe("draft");
  });
});
