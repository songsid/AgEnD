/**
 * #3725 review (Prism P2-1, P2-3): which run a closed Sign in dialog may end.
 *   - A dialog ends only a run its own Sign in CREATED — the server names it (`started` in the answer to that start). A start that joined a run already going (another
 *     backend's in another tab, the same backend's from a racing tab, a double click) carries none, so closing the dialog never ends it.
 *   - A dialog closed while its first start is still in flight keeps the duty: when the run turns up anyway, it is ended by its id — nothing is drawn into the closed dialog,
 *     and a run that replaced it (another id) is not touched.
 * The real modules on the mini DOM with a recording fetch; nothing reaches a server.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

type Req = { method: string; url: string; body: any };
let reqs: Req[] = [];
let answer: (r: Req) => unknown = () => ({});
const fetchFake = async (url: string, init: any = {}) => {
  const r: Req = { method: init.method || "GET", url, body: init.body ? JSON.parse(init.body) : null };
  reqs.push(r);
  const body = await answer(r);
  return { ok: true, status: 200, json: async () => body };
};

const ENDPOINT = "/ui/browser-backend-signins";
const CLAUDE_RUN = { id: "a".repeat(32), backend: "claude-code", revision: 3, phase: "code", mine: true, canAct: true, url: "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz" };
const CODEX_RUN = { id: "d".repeat(32), backend: "codex", revision: 1, phase: "waiting", mine: true, canAct: false };
const snapshot = (over: Record<string, unknown> = {}) => ({ selected: ["claude-code", "codex"], pending: ["claude-code", "codex"], skipped: [], states: { "claude-code": "invalid", codex: "invalid" }, login: null, ready: false, ...over });

let p: AppPage;
let S: any, shell: any, i18n: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/settings/agents", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  (globalThis as any).navigator.clipboard = { writeText: async () => {} };
  shell = await import("/assets/app-shell.js");
  i18n = await import("/assets/app-i18n.js");
  S = await import("/ui/js/backend-signin.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount();
  reqs = []; answer = () => ({});
  i18n.setLang("en", { store: false });
  S.signInStore.set({ loaded: false, login: null, targets: [], structured: null });
  shell.shellStore.set({ dialog: null });
});
const btn = (label: string) => p.root.querySelectorAll("button, a").find((b: any) => b.textContent.trim() === label);
const posts = (operation?: string) => reqs.filter(r => r.method === "POST" && r.url === ENDPOINT && (!operation || r.body?.operation === operation));
const closing = () => async () => { await p.unmount(); };
const mount = async (props: Record<string, unknown>) => { await p.mount(h(S.BrowserSignInDialog, { ...props, onClose: closing() })); await settle(8); };
/** Press a card's Sign in without waiting for the answer (the test decides when the server answers). */
const pressNoWait = (label: string) => { const b = btn(label) as any; expect(b, label).toBeDefined(); return b.onclick() as Promise<void>; };

describe("P2-1: a run this dialog did not create is never ended by closing it", () => {
  it("Claude Code runs in one tab; the default Codex dialog in another presses Sign in, is handed Claude's run, and closing it leaves Claude running", async () => {
    // The server's begin() for codex finds Claude's run already going and answers with it — no `started`: it created nothing.
    answer = r => r.url === ENDPOINT ? snapshot({ login: CLAUDE_RUN }) : {};
    await mount({ backend: "codex" });
    await (btn("Connect account") as any).onclick(); await settle(8);
    expect(posts("start").map(r => r.body.backend)).toEqual(["codex"]);
    reqs = [];
    fire(btn("Close"), "click"); await settle(8);
    expect(posts("cancel"), "Claude's run is not Codex's to end").toEqual([]);
  });
  it("two tabs racing the same backend: the one whose start joined the other's run ends nothing; the one that created it ends exactly its id", async () => {
    // Tab A's start created the run (names it); tab B — whose page read before that — pressed Sign in too and its start joined the run (names nothing).
    answer = r => r.url === ENDPOINT ? (r.body?.operation === "start" ? snapshot({ login: CODEX_RUN, started: CODEX_RUN.id }) : snapshot()) : {};
    await mount({ backend: "codex" });
    await (btn("Connect account") as any).onclick(); await settle(8);
    reqs = [];
    fire(btn("Close"), "click"); await settle(8);
    expect(posts("cancel").map(r => r.body)).toEqual([{ operation: "cancel", id: CODEX_RUN.id }]);

    await p.unmount(); reqs = [];
    answer = r => r.url === ENDPOINT ? (r.body?.operation === "start" ? snapshot({ login: CODEX_RUN }) : snapshot()) : {};   // B: the same run, joined
    await mount({ backend: "codex" });
    await (btn("Connect account") as any).onclick(); await settle(8);
    expect(posts("start")).toHaveLength(1);
    reqs = [];
    fire(btn("Close"), "click"); await settle(8);
    expect(posts("cancel")).toEqual([]);
  });
});

describe("P2-3: closing while the first start is still in flight", () => {
  const hold = () => { let release!: (v: unknown) => void; const gate = new Promise(r => { release = r; }); return { gate, release }; };
  it("the run the closed dialog created turns up late: it is ended by its id, and nothing is drawn into the closed dialog", async () => {
    const { gate, release } = hold();
    answer = async r => {
      if (r.url !== ENDPOINT) return {};
      if (r.method === "POST" && r.body?.operation === "start") { await gate; return snapshot({ login: CODEX_RUN, started: CODEX_RUN.id }); }
      return snapshot();
    };
    await mount({ backend: "codex" });
    const pending = pressNoWait("Connect account"); await settle(4);
    expect(posts("start")).toHaveLength(1);
    reqs = [];
    fire(btn("Close"), "click"); await settle(8);
    expect(posts("cancel"), "no run id is known yet: nothing to end at close").toEqual([]);
    release(0); await pending; await settle(8);
    expect(posts("cancel").map(r => r.body), "the late run is ended — exactly that one").toEqual([{ operation: "cancel", id: CODEX_RUN.id }]);
    expect(p.root.querySelectorAll("section"), "nothing drawn into the closed dialog").toHaveLength(0);
  });
  it("a start that joined someone else's run while the dialog closed ends nothing", async () => {
    const { gate, release } = hold();
    answer = async r => {
      if (r.url !== ENDPOINT) return {};
      if (r.method === "POST" && r.body?.operation === "start") { await gate; return snapshot({ login: CLAUDE_RUN }); }   // joined: no `started`
      return snapshot();
    };
    await mount({ backend: "codex" });
    const pending = pressNoWait("Connect account"); await settle(4);
    fire(btn("Close"), "click"); await settle(8);
    reqs = [];
    release(0); await pending; await settle(8);
    expect(posts("cancel")).toEqual([]);
  });
  it("a failed start that was in flight when the dialog closed has nothing to end and says nothing", async () => {
    const { gate, release } = hold();
    answer = async r => {
      if (r.url !== ENDPOINT) return {};
      if (r.method === "POST" && r.body?.operation === "start") { await gate; throw new Error("offline"); }
      return snapshot();
    };
    await mount({ backend: "codex" });
    const pending = pressNoWait("Connect account"); await settle(4);
    fire(btn("Close"), "click"); await settle(8);
    reqs = [];
    release(0); await pending; await settle(8);
    expect(posts("cancel")).toEqual([]);
  });
  it("the installer's list (several backends) keeps its runs, even one that arrives after it closed", async () => {
    const { gate, release } = hold();
    answer = async r => {
      if (r.url !== ENDPOINT) return {};
      if (r.method === "POST" && r.body?.operation === "start") { await gate; return snapshot({ login: CODEX_RUN, started: CODEX_RUN.id }); }
      return snapshot();
    };
    await mount({ backends: ["claude-code", "codex"] });
    const codex = p.root.querySelectorAll("section").find((s: any) => s.dataset.backend === "codex");
    const press = codex.querySelectorAll("button").find((b: any) => b.textContent.trim() === "Connect account");
    const pending = press.onclick() as Promise<void>; await settle(4);
    fire(btn("Close"), "click"); await settle(8);
    reqs = [];
    release(0); await pending; await settle(8);
    expect(posts("cancel")).toEqual([]);
  });
});
