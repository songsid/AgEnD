/**
 * #1408 §4–§5, the panels in the shell (vendored Preact into tests/helpers/mini-dom.ts):
 * - #1374 request classes: opening a chat the first time reads its history once (a navigation — it counts as use);
 *   coming back reads nothing; opening a Fleet tab reads its list; no timer of a panel reads anything.
 * - Esc stops a reply only from a mounted chat that is working, never from another panel, never through a dialog
 *   or a menu, never when the focus is outside the main area.
 * - 50 mounts and unmounts leave nothing behind: no lease, no document listener, no preview callback, no key handler.
 * - An unknown instance is the panel's "not found" state, and a remembered one that no longer exists is forgotten.
 * - The header's ⋯ offers only what fits the instance's state; a late Fleet answer never lands on another tab.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { isPassiveWebRead } from "../src/web-auth.js";

let p: AppPage;
const requests: string[] = [];
let respond: (path: string, init?: { method?: string }) => unknown = () => ({});
const fetchFake = async (path: string, init: { method?: string } = {}) => {
  requests.push(`${init.method ?? "GET"} ${path}`);
  const body = respond(path, init);
  return { ok: true, status: 200, json: async () => body };
};
const listeners = new Map<string, Set<(d: unknown) => void>>();
const stream = { on(n: string, f: (d: unknown) => void) { if (!listeners.has(n)) listeners.set(n, new Set()); listeners.get(n)!.add(f); return () => listeners.get(n)!.delete(f); } };
const emit = (n: string, d: unknown) => { for (const f of listeners.get(n) ?? []) f(d); };

let chat: any, fleet: any, shell: any, app: any, ctx: any, html: any;
const STATUS = (over: Record<string, Record<string, unknown>> = {}) => ({ uptime: 1, instances: [
  { name: "alpha", status: "running", state: "idle", execution_state: "idle", ...over.alpha },
  { name: "beta", status: "stopped", state: null, execution_state: null, ...over.beta },
] });

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/chat/alpha", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  html = (await import("/assets/app-html.js")).html;
  app = await import("/assets/app-store.js");
  ctx = await import("/assets/app-ctx.js");
  shell = await import("/assets/app-shell.js");
  chat = await import("/ui/js/panel-chat.js");
  fleet = await import("/ui/js/panel-fleet.js");
  chat.boot({ stream, boot: null, deps: { fetch: fetchFake } });
  respond = (path) => path.startsWith("/ui/history") ? { messages: [] } : {};
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount();
  requests.length = 0;
  app.applyStatus(STATUS());
  emit("status", STATUS());
});

const mountChat = (instance: string | null, navKey = `chat:${instance}|1|en`) =>
  p.mount(h(chat.ChatPanel, { route: { panel: "chat", instance }, navKey }));
const mountFleet = (tab: string, navKey = `fleet:${tab}|1|en`) => p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab }, navKey }));
const esc = (target: any = p.document.body) => { const e = fire(target, "keydown", { key: "Escape" }); shell.handleKey(e); return e; };

describe("#1374: what counts as use", () => {
  it("first visit: one history read; coming back: nothing at all", async () => {
    await mountChat("alpha");
    expect(requests).toEqual(["GET /ui/history?instance=alpha&limit=200"]);
    await p.unmount();
    await mountFleet("tasks");
    await p.unmount();
    requests.length = 0;
    await mountChat("alpha");
    expect(requests).toEqual([]);
  });

  it("opening a Fleet tab reads its list — a person's navigation, so not on the passive list; panels have no timers that read", async () => {
    respond = (path) => path === "/ui/tasks" ? { tasks: [] } : path.startsWith("/ui/history") ? { messages: [] } : {};
    await mountFleet("tasks");
    expect(requests).toEqual(["GET /ui/tasks"]);
    expect(isPassiveWebRead("GET", "/ui/tasks")).toBe(false);
    expect(isPassiveWebRead("GET", "/ui/history")).toBe(false);
    requests.length = 0;
    await new Promise(r => setTimeout(r, 1200));     // time passes with no person: nothing is read
    expect(requests).toEqual([]);
    // The passive allowlist itself is unchanged (#1374).
    for (const path of ["/ui/poll", "/ui/events", "/api/pane/x", "/api/profiles", "/api/ai-usage"]) expect(isPassiveWebRead("GET", path), path).toBe(true);
  });
});

describe("Esc stops a reply only from a working chat", () => {
  const busy = () => { const s = STATUS({ alpha: { state: "working", execution_state: "working" } }); app.applyStatus(s); emit("status", s); };
  const cancels = () => requests.filter(r => r.startsWith("POST /ui/cancel/"));

  it("in the chat, focus on the body: Esc posts one cancel for that instance", async () => {
    busy();
    await mountChat("alpha");
    const main = p.document.createElement("main"); main.id = "main"; p.document.body.appendChild(main);
    main.appendChild(p.root);                         // the shell's main area holds the panel
    p.document.body.focus?.();
    esc();
    await settle();
    expect(cancels()).toEqual(["POST /ui/cancel/alpha"]);
    // A held Esc (or a second press) while the first is on its way sends nothing more.
    esc(); await settle();
    expect(cancels()).toHaveLength(1);
    p.document.body.appendChild(p.root); main.remove();
  });

  it("not from another panel, not through a dialog or a menu, not with focus outside the main area", async () => {
    busy();
    await mountFleet("teams");
    esc(); await settle();
    expect(cancels()).toEqual([]);
    await p.unmount();
    await mountChat("alpha");
    const main = p.document.createElement("main"); main.id = "main"; p.document.body.appendChild(main); main.appendChild(p.root);
    const dlg = p.document.createElement("dialog"); dlg.setAttribute("open", ""); p.document.body.appendChild(dlg);
    esc(); await settle();
    dlg.remove();
    const menu = p.document.createElement("div"); menu.className = "menu-list"; p.document.body.appendChild(menu);
    esc(); await settle();
    menu.remove();
    const side = p.document.createElement("button"); p.document.body.appendChild(side); side.focus();
    esc(); await settle();
    expect(cancels()).toEqual([]);
    p.document.body.focus?.();
    p.document.activeElement = p.document.body;
    p.document.body.appendChild(p.root); main.remove(); side.remove();
  });

  it("once the chat is gone, Esc does nothing", async () => {
    busy();
    await mountChat("alpha");
    await p.unmount();
    esc(); await settle();
    expect(cancels()).toEqual([]);
  });
});

describe("50 mounts leave nothing behind", () => {
  it("leases, document listeners, preview callbacks and key handlers all return to where they were", async () => {
    const Preview = (globalThis as any).AgendPreview;
    await settle();
    const base = { leases: ctx.leaseCount(), doc: p.document.listenerCount(), preview: Preview.listeners() };
    for (let i = 0; i < 50; i++) {
      await mountChat(i % 2 ? "alpha" : "beta", `k${i}`);
      await p.unmount();
      await mountFleet(["tasks", "schedules", "teams", "config"][i % 4]!, `f${i}`);
      await p.unmount();
    }
    expect(ctx.leaseCount()).toBe(base.leases);
    expect(p.document.listenerCount()).toBe(base.doc);
    expect(Preview.listeners()).toBe(base.preview);
    expect(Preview.liveCount()).toBe(0);
    requests.length = 0;
    const e = esc(); await settle();
    expect(e.defaultPrevented).toBe(false);
    expect(requests).toEqual([]);
  });
});

describe("the chat's states", () => {
  it("an unknown instance is 'not found' (not an error page), and a remembered one is forgotten", async () => {
    p.storage.set("agend_last_instance", "gone");
    await mountChat("gone");
    expect(p.root.querySelector(".empty-title")?.textContent).toBe("No instance called “gone”");
    expect(p.root.querySelector(".error-state")).toBeNull();
    expect(p.storage.has("agend_last_instance")).toBe(false);
    expect(requests).toEqual([]);                     // nothing is read for a name that does not exist
  });

  it("before the first status frame: a skeleton, not 'not found'", async () => {
    app.appStore.set({ ready: false, instances: [] });
    await mountChat("alpha");
    expect(p.root.querySelector(".skeleton")).not.toBeNull();
    expect(p.root.querySelector(".empty-title")).toBeNull();
    app.applyStatus(STATUS());
  });

  it("the ⋯ menu offers what fits the state: running → restart and stop; stopped → start; delete always, last", async () => {
    const items = async (name: string) => {
      await mountChat(name);
      p.root.querySelector(".panel-head .menu > button").click(); await settle();
      const labels = p.root.querySelectorAll(".menu-item").map((b: any) => b.textContent);
      await p.unmount();
      return labels;
    };
    expect(await items("alpha")).toEqual(["Instance details", "Restart instance", "Stop instance", "Delete instance…"]);
    expect(await items("beta")).toEqual(["Instance details", "Start instance", "Delete instance…"]);
  });

  it("the composer's control is 'Stop reply', shown only while the agent works; Send hides then unless there is something to send", async () => {
    await mountChat("alpha");
    const stop = () => p.root.querySelector("#stopBtn"), send = () => p.root.querySelector("#sendBtn");
    expect(stop().hidden).toBe(true);
    expect(send().hidden).toBe(false);
    const s = STATUS({ alpha: { state: "working", execution_state: "working" } }); app.applyStatus(s); emit("status", s); await settle();
    expect(stop().hidden).toBe(false);
    expect(stop().textContent).toContain("Stop reply");
    expect(send().hidden).toBe(true);
    const box = p.root.querySelector("#msgIn"); box.value = "more"; fire(box, "input"); await settle();
    expect(send().hidden).toBe(false);
  });
});

describe("Fleet: a late answer never lands after the person moved on", () => {
  it("another tab: the old list's answer is dropped", async () => {
    let releaseTasks!: () => void;
    const tasksGate = new Promise<void>(r => { releaseTasks = r; });
    (globalThis as any).fetch = async (path: string, init: { method?: string } = {}) => {
      requests.push(`${init.method ?? "GET"} ${path}`);
      if (path === "/ui/tasks") { await tasksGate; return { ok: true, json: async () => ({ tasks: [{ id: "t1", title: "LATE", status: "open" }] }) }; }
      return { ok: true, json: async () => ({ teams: { core: { members: ["alpha"] } } }) };
    };
    await mountFleet("tasks", "fleet:tasks|1|en");
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "teams" }, navKey: "fleet:teams|2|en" }));
    releaseTasks();
    await settle(6);
    expect(p.root.innerHTML).not.toContain("LATE");
    expect(p.root.innerHTML).toContain("core");
    (globalThis as any).fetch = fetchFake;
  });

  it("the same tab again (Retry): the first answer arriving last does not replace the second (A → A′)", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(r => { releaseFirst = r; });
    let n = 0;
    (globalThis as any).fetch = async (path: string) => {
      n++;
      if (n === 1) { await firstGate; return { ok: true, json: async () => ({ tasks: [{ id: "t1", title: "STALE", status: "open" }] }) }; }
      return { ok: true, json: async () => ({ tasks: [{ id: "t2", title: "FRESH", status: "open" }] }) };
    };
    await mountFleet("tasks", "fleet:tasks|1|en");
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: "fleet:tasks|2|en" }));
    await settle(4);
    expect(p.root.innerHTML).toContain("FRESH");
    releaseFirst();
    await settle(6);
    expect(p.root.innerHTML).toContain("FRESH");
    expect(p.root.innerHTML).not.toContain("STALE");
    (globalThis as any).fetch = fetchFake;
  });
});
