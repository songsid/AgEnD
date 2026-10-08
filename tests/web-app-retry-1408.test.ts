/**
 * #1425 review r2/r3: the chat recovering from a failed first load sees what is open now — in order, and even when
 * its first catch-up read fails.
 *
 * Through the real entry (app.js), its Outlet, the real stream and the real chat store, in a fresh module graph per
 * case: the first import of the chat fails, the stream opens anyway and its connect frames reach no chat; Retry loads
 * the chat (?retry=1), which catches up over /ui/poll (passive):
 * - the prompt still open shows, one resolved during the gap does not, the tick is current; one EventSource, live;
 * - live events that arrive while that read is in flight win over its older snapshot (P1 resolved meanwhile stays
 *   resolved, P3 posted meanwhile stays answerable);
 * - a failed read (network or JSON) is retried and says so; when every retry fails the page says so, with Retry.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDom, settle, fire } from "./helpers/mini-dom.js";

const P1 = "a".repeat(32), P2 = "b".repeat(32), P3 = "c".repeat(32);
const MSG = { instance: "alpha", boot: 1, id: 5, role: "user", sender: "web-user", text: "hello", ts: "2026-10-09T00:00:00Z", messageId: "m5" };
const STATUS = { uptime: 1, instances: [{ name: "alpha", status: "running", state: "idle", execution_state: "idle" }] };
const prompt = (nonce: string, text: string) => ({ instance: "alpha", nonce, text, actions: [{ id: "ok", label: "OK" }], expiresAt: 9e15 });
const SNAPSHOT = { status: STATUS, messages: [], cursor: "1-5", deliveries: [{ instance: "alpha", messageId: "m5", delivery: "delivered" }], prompts: [prompt(P1, "still open")], needs: [] };

type PollAnswer = () => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
let restore: (() => void) | null = null;
// The first, un-queried import of the chat always fails here (a factory that throws leaves nothing cached between
// cases); a retry asks for ?retry=<n>, which is not mocked and loads the real module.
vi.doMock("/ui/js/panel-chat.js", async () => { throw new Error("network: the first load failed"); });
afterEach(() => { restore?.(); restore = null; vi.resetModules(); });

/** A page with the real entry, whose first chat import fails. `poll` answers each /ui/poll in turn. */
async function scenario(poll: PollAnswer[]) {
  vi.resetModules();
  const dom = installDom({ url: "http://127.0.0.1:19280/ui/chat/alpha", storage: { agend_tour_done: "1" } });
  const app = dom.document.createElement("div"); app.id = "app"; dom.document.body.appendChild(app);
  dom.document.body.setAttribute("data-mode", "full");
  const sources: any[] = [], requests: string[] = [];
  const g = globalThis as any;
  g.EventSource = class { url: string; listeners: Record<string, (e: unknown) => void> = {}; onerror: unknown = null;
    constructor(u: string) { this.url = u; sources.push(this); }
    addEventListener(n: string, f: (e: unknown) => void) { this.listeners[n] = f; } close() {} };
  let polls = 0;
  g.fetch = async (path: string, init: { method?: string } = {}) => {
    requests.push(`${init.method ?? "GET"} ${path}`);
    if (path.startsWith("/ui/poll")) return (poll[polls++] ?? poll[poll.length - 1]!)();
    // The history carries each message's current tick, as the server's web-chat history does (m.delivery).
    const json = path.startsWith("/ui/history") ? { messages: [{ ...MSG, delivery: "delivered" }] } : {};
    return { ok: !path.startsWith("/auth/"), status: path.startsWith("/auth/") ? 401 : 200, json: async () => json };
  };
  const { options } = await import("/assets/preact.module.js");
  options.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  restore = () => { dom.restore(); delete g.EventSource; delete g.fetch; };
  await import("/assets/app.js");
  await vi.waitFor(() => expect(sources.map(s => s.url)).toEqual(["/ui/events"]));
  await vi.waitFor(() => expect(app.querySelector(".error-state")).not.toBeNull());
  const send = (name: string, data: unknown, lastEventId?: string) => sources[0].listeners[name]?.({ data: JSON.stringify(data), lastEventId });
  // The connect frames go out while no chat listens.
  send("status", STATUS);
  send("prompts", [prompt(P1, "still open"), prompt(P2, "answered meanwhile")]);
  send("deliveries", [{ instance: "alpha", messageId: "m5", delivery: "queued" }]);
  return {
    app, sources, requests, send,
    retry: () => { requests.length = 0; app.querySelector(".error-state button")!.click(); },
    cards: () => app.querySelectorAll(".prompt").map((c: any) => ({ text: c.querySelector(".txt")?.textContent, done: c.className.includes("done"),
      buttons: c.querySelectorAll("button").map((b: any) => !b.disabled) })),
    polls: () => requests.filter(r => r.startsWith("GET /ui/poll")).length,
    conn: () => app.querySelector(".conn")?.textContent?.trim() ?? null,
  };
}
const answer = (body: unknown): PollAnswer => async () => ({ ok: true, json: async () => body });
function held() {
  let open!: () => void;
  const gate = new Promise<void>(r => { open = r; });
  const ans: PollAnswer = async () => { await gate; return { ok: true, json: async () => SNAPSHOT }; };
  return { open, answer: ans };
}

describe("Retry after a failed first load of the chat", () => {
  it("shows the prompt still open, not the one resolved in the gap, with the current tick — on one live stream", async () => {
    const s = await scenario([answer(SNAPSHOT)]);
    s.send("prompt_resolved", { instance: "alpha", nonce: P2, outcome: "done on Telegram" });
    s.send("delivery", { instance: "alpha", messageId: "m5", delivery: "delivered" });
    s.send("status", STATUS); s.send("status", STATUS);
    s.retry();
    await vi.waitFor(() => expect(s.cards().length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(s.app.querySelector(".tick")).not.toBeNull());
    expect(s.polls()).toBe(1);
    expect(s.requests.some(r => r.startsWith("GET /ui/history?instance=alpha"))).toBe(true);
    expect(s.sources).toHaveLength(1);
    const { appStore } = await import("/assets/app-store.js");
    expect(appStore.get().connection).toBe("live");
    expect(appStore.get().hydration).toBe("ok");
    expect(s.cards()).toEqual([{ text: "still open", done: false, buttons: [true] }]);
    expect(s.app.querySelector(".tick")!.className).toContain("tick-delivered");
    s.send("status", STATUS); await settle(4);
    expect(s.cards()).toHaveLength(1);
    await new Promise(r => setTimeout(r, 50));
    expect(s.polls()).toBe(1);
    expect(s.conn()).toBeNull();
    // The store the recovery booted is the one the page keeps.
    const chat = await import("/ui/js/panel-chat.js?retry=1");
    expect(chat.boot({ stream: { on() { return () => {}; } }, boot: null })).toBe(chat.store);
    const box = s.app.querySelector("#msgIn") as any;
    box.value = "draft"; fire(box, "input"); await settle();
    expect(chat.store.state.drafts.alpha).toBe("draft");
  });

  it("live events that arrive while the catch-up read is in flight win over its older snapshot", async () => {
    const h = held();
    const s = await scenario([h.answer]);
    s.retry();
    await vi.waitFor(() => expect(s.polls()).toBe(1));
    // While the read is on its way: P1 is answered elsewhere and P3 is posted. The read's snapshot has P1, not P3.
    s.send("prompt_resolved", { instance: "alpha", nonce: P1, outcome: "answered on Discord" });
    s.send("prompt", prompt(P3, "posted meanwhile"));
    h.open();
    await vi.waitFor(() => expect(s.cards().length).toBe(2));
    await settle(4);
    expect(s.cards()).toEqual([
      { text: "answered on Discord", done: true, buttons: [] },
      { text: "posted meanwhile", done: false, buttons: [true] },
    ]);
    // A later heartbeat, or a full prompts frame from a reconnect, keeps it so.
    s.send("status", STATUS);
    s.send("prompts", [prompt(P3, "posted meanwhile")]);
    await settle(4);
    expect(s.cards().find(c => c.text === "posted meanwhile")).toEqual({ text: "posted meanwhile", done: false, buttons: [true] });
    expect(s.sources).toHaveLength(1);
  });

  it("a fallback poll already on its way when Retry loads the chat: the catch-up joins it, and the live events after it win", async () => {
    const h = held();
    const s = await scenario([h.answer]);
    s.sources[0].onerror();                                   // the stream drops: fallback poll A after 5 s, and it hangs
    await vi.waitFor(() => expect(s.requests.filter(r => r.startsWith("GET /ui/poll"))).toHaveLength(1), { timeout: 8000 });
    s.retry();                                                // the chat loads now and catches up — on A
    await settle(6);
    expect(s.polls()).toBe(0);                                // (retry() cleared the log: no new read was made)
    h.open();
    await vi.waitFor(() => expect(s.cards()).toEqual([{ text: "still open", done: false, buttons: [true] }]));
    // The stream is back: P1 answered elsewhere, P3 posted, a new message.
    s.send("prompt_resolved", { instance: "alpha", nonce: P1, outcome: "answered on Discord" });
    s.send("prompt", prompt(P3, "posted meanwhile"));
    s.send("message", { ...MSG, id: 6, text: "later", messageId: "m6" }, "1-6");
    await settle(6);
    await new Promise(r => setTimeout(r, 6000));              // long enough for any queued or fallback read to land
    expect(s.cards()).toEqual([
      { text: "answered on Discord", done: true, buttons: [] },
      { text: "posted meanwhile", done: false, buttons: [true] },
    ]);
    expect(s.polls()).toBe(0);                                // nothing was queued behind A, and the stream speaks again
    expect(s.sources).toHaveLength(1);
  }, 25_000);

  it("a failed catch-up read (network, then bad JSON) is retried, says so meanwhile, then shows what is open", async () => {
    const s = await scenario([
      async () => { throw new Error("offline"); },
      async () => ({ ok: true, json: async () => { throw new SyntaxError("bad json"); } }),
      answer(SNAPSHOT),
    ]);
    s.retry();
    await vi.waitFor(() => expect(s.conn()).toBe("Loading what is open now…"));
    expect(s.cards()).toEqual([]);
    await vi.waitFor(() => expect(s.cards().length).toBe(1), { timeout: 6000 });
    expect(s.polls()).toBe(3);
    expect(s.conn()).toBeNull();
    expect(s.sources).toHaveLength(1);
  }, 15_000);

  it("when every retry fails the page says so (bounded), and its Retry reads again", async () => {
    const fail: PollAnswer = async () => { throw new Error("offline"); };
    const s = await scenario([fail, fail, fail, fail, answer(SNAPSHOT)]);
    s.retry();
    await vi.waitFor(() => expect(s.conn()).toContain("Could not load what is open now"), { timeout: 12_000 });
    expect(s.polls()).toBe(4);
    await new Promise(r => setTimeout(r, 1500));
    expect(s.polls()).toBe(4);                        // bounded: no loop of its own
    (s.app.querySelector(".conn button") as any).click();
    await vi.waitFor(() => expect(s.cards().length).toBe(1));
    expect(s.polls()).toBe(5);
    expect(s.conn()).toBeNull();
  }, 25_000);
});
