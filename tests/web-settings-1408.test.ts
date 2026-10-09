/**
 * #1408 step 3: Settings in the app shell — the contracts of design §5.
 * - Apply belongs to the app before the first write: leaving while a write is in flight or accepted, or while the
 *   POST is in flight or accepted, still makes one job with the one key; progress goes on; nothing lands in a panel
 *   that is gone; coming back finds the operation, Apply stays off, and no second POST is made.
 * - A lost POST answer is retried with the same key.
 * - Staged changes: a section change keeps them and asks nothing; leaving the panel asks "Discard N pending changes?"
 *   (Cancel stays, Discard leaves and nothing staged is ever sent).
 * - #1374: mounting reads the configuration once; nothing recurring while it is open; 50 mounts leave nothing.
 * - #1423: a write an admin must confirm waits in the operation (passive polls, stopped once decided); confirmed → the
 *   operation goes on; refused → it stops and what did not land is staged again; the shell shows the request in any
 *   panel; a request from before a reload is followed again.
 * No server, no fleet: a fake fetch answers like settings-api.ts does.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire, MiniEvent } from "./helpers/mini-dom.js";

type Req = { method: string; url: string; key: string | null; body: any };
type Answer = { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;
let reqs: Req[] = [];
let routes: Array<(r: Req) => Answer | undefined> = [];
const FLEET = {
  defaults: { backend: "claude-code" },
  channels: [{ id: "main", type: "discord", bot_token_env: "AGEND_DISCORD_TOKEN", group_id: "1", access: { mode: "locked", allowed_users: ["7"] } }],
  instances: { alpha: { working_directory: "/w/a", description: "A" }, beta: { working_directory: "/w/b", description: "B" } },
};
const SCHEMA = { impacts: { "instance.description": "now", "fleet.channels": "fleet" }, order: ["now", "instance", "fleet"] };
const JOB_RUNNING = { id: "job1", status: "running", targets: [{ target: "alpha", kind: "hot", status: "running" }] };
const JOB_DONE = { id: "job1", status: "done", targets: [{ target: "alpha", kind: "hot", status: "done" }] };
function base(r: Req): Answer | undefined {
  const { method: m, url } = r;
  if (m === "GET" && url === "/api/settings/schema") return { body: SCHEMA };
  if (m === "GET" && url === "/api/settings/fleet/raw") return { body: structuredClone(FLEET) };
  if (m === "GET" && url === "/api/settings/classic") return { body: { defaults: {}, channels: {} } };
  if (m === "GET" && url === "/api/settings/connections") return { body: [{ id: "main", token_present: true }] };
  if (m === "GET" && url === "/api/settings/provider-secrets") return { status: 404, body: { error: "not found" } };
  if (m === "GET" && url === "/api/fleet") return { body: { version: "2.2.0", instances: [{ name: "alpha", status: "running" }, { name: "beta", status: "stopped" }] } };
  if (m === "GET" && url === "/api/profiles") return { body: [] };
  if (m === "GET" && url === "/api/settings/pending") return { body: [] };
  if (m === "POST" && url === "/api/settings/apply") return { body: JOB_RUNNING };
  if (m === "GET" && url === "/api/settings/apply/job1") return { body: JOB_DONE };
  if (m !== "GET") return { body: { ok: true } };
  return { status: 404, body: {} };
}
async function fetchFake(url: string, init: any = {}) {
  const headers = init.headers || {};
  const key = typeof headers.get === "function" ? headers.get("Idempotency-Key") : headers["Idempotency-Key"] ?? null;
  const r: Req = { method: init.method || "GET", url, key, body: init.body ? JSON.parse(init.body) : null };
  reqs.push(r);
  let a: Answer | undefined;
  for (const route of routes) { a = route(r); if (a) break; }
  const ans = await (a ?? base(r))!;
  if (ans instanceof Error) throw ans;
  const status = ans.status ?? 200;
  return { ok: status >= 200 && status < 300, status, json: async () => ans.body, text: async () => JSON.stringify(ans.body) };
}
const gate = <T,>() => { let open!: (v: T) => void; const p = new Promise<T>(r => { open = r; }); return { p, open }; };
const writes = () => reqs.filter(r => r.method !== "GET");
const reads = () => reqs.filter(r => r.method === "GET").map(r => r.url);

let p: AppPage;
let S: any, apply: any, confirmMod: any, app: any, nav: any, ctx: any, shell: any;
let answers: boolean[] = [];
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/settings", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  S = await import("/ui/js/panel-settings.js");
  apply = await import("/ui/js/settings-apply.js");
  confirmMod = await import("/ui/js/settings-confirm.js");
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  ctx = await import("/assets/app-ctx.js");
  shell = await import("/assets/app-shell.js");
  nav.startRouter(p.window);
});
beforeEach(async () => {
  vi.useRealTimers();
  await p.unmount();
  apply.resetOperation(); confirmMod.resetConfirmations();
  reqs = []; routes = []; answers = [];
  (globalThis as any).confirm = () => (answers.length ? answers.shift()! : true);
  nav.navigate("/settings");
});
afterEach(() => { vi.useRealTimers(); });

const mount = (section = "agents", key = `settings:${section}|1|en`) =>
  p.mount(h(S.SettingsPanel, { route: { panel: "settings", section }, navKey: key }));
const btn = (scope: any, text: string) => scope.querySelectorAll("button").find((b: any) => b.textContent.includes(text));
async function stageDescription(name: string, text: string) {
  const row = p.root.querySelectorAll(".s-row").find((r: any) => r.querySelector(".s-name")?.textContent === name);
  btn(row, "Settings").click(); await settle(4);
  const input = p.root.querySelector("#ag-desc");
  input.value = text; fire(input, "input"); await settle(2);
  btn(p.root.querySelector("dialog"), "Stage change").click(); await settle(4);
}
const op = () => app.appStore.get().settingsOp;
/** An event on the window itself (beforeunload, popstate): mini-dom's window is a bare event target. */
function winEvent(type: string) { const e = new MiniEvent(type, { cancelable: true }); e.eventPhase = 2; e.target = p.window; p.window._fire(e, false); return e; }

describe("Apply belongs to the app before the first write (§5)", () => {
  for (const hold of ["the first write in flight", "the first write accepted", "the POST in flight", "the POST accepted (job running)"] as const) {
    it(`leaving with ${hold}: one job, one key, progress goes on, nothing lands in the gone panel; back again finds it`, async () => {
      const g = gate<{ body: unknown }>();
      let held = false;
      routes.push(r => {
        if (hold === "the first write in flight" && r.method === "PATCH" && !held) { held = true; return g.p; }
        if (hold === "the POST in flight" && r.method === "POST" && r.url === "/api/settings/apply" && !held) { held = true; return g.p.then(() => ({ body: JOB_RUNNING })); }
        if (hold === "the POST accepted (job running)" && r.url === "/api/settings/apply/job1" && !held) { held = true; return g.p.then(() => ({ body: JOB_RUNNING })); }
        return undefined;
      });
      await mount(); await settle(6);
      await stageDescription("alpha", "A2");
      await stageDescription("beta", "B2");
      expect(p.root.querySelector(".s-pending")?.textContent).toContain("2");
      if (hold === "the first write accepted") routes.push(r => (r.method === "PATCH" && r.url.endsWith("/alpha") ? (async () => { await p.unmount(); return { body: { ok: true } }; })() : undefined));
      btn(p.root.querySelector(".s-pending"), "Apply changes").click();
      await settle(2);
      expect(op()).not.toBeNull();                              // handed over: the operation exists before any answer
      if (hold !== "the first write accepted") {
        if (hold === "the POST in flight" || hold === "the POST accepted (job running)") await vi.waitFor(() => expect(held).toBe(true), { timeout: 4000 });
        await p.unmount();                                      // the person leaves Settings
      }
      expect(p.root.childNodes.length).toBe(0);
      g.open({ body: { ok: true } });
      await vi.waitFor(() => expect(op().phase).toBe("done"), { timeout: 8000 });
      const w = writes();
      expect(w.filter(r => r.method === "PATCH").map(r => r.url)).toEqual(["/api/settings/fleet/instances/alpha", "/api/settings/fleet/instances/beta"]);
      expect(w.filter(r => r.method === "PATCH").map(r => r.body)).toEqual([{ description: "A2" }, { description: "B2" }]);
      const posts = w.filter(r => r.url === "/api/settings/apply");
      expect(posts).toHaveLength(1);
      expect(posts[0]!.key).toBeTruthy();
      expect(posts[0]!.body).toEqual({ idempotency_key: posts[0]!.key });
      expect(p.root.childNodes.length).toBe(0);                // nothing was drawn into a panel that is gone
      // Back to Settings: the operation is found, not started again.
      await mount(); await settle(6);
      expect(p.root.querySelector(".s-op")?.textContent).toContain("Changes applied");
      expect(writes().filter(r => r.url === "/api/settings/apply")).toHaveLength(1);
    }, 20_000);
  }

  it("coming back while the job runs: attached, Apply off, no second POST", async () => {
    const g = gate<{ body: unknown }>();
    routes.push(r => (r.url === "/api/settings/apply/job1" ? g.p : undefined));
    await mount(); await settle(6);
    await stageDescription("alpha", "A2");
    btn(p.root.querySelector(".s-pending"), "Apply changes").click();
    await vi.waitFor(() => expect(op().phase).toBe("watching"));
    await p.unmount();
    await mount(); await settle(6);
    expect(p.root.querySelector(".s-op")?.textContent).toContain("Applying");
    await stageDescription("beta", "B2");
    const applyBtn = btn(p.root.querySelector(".s-pending"), "Apply changes");
    expect(applyBtn.disabled).toBe(true);
    applyBtn.click(); await settle(4);
    expect(apply.startOperation([{ label: "x", impact: "now", request: { method: "PATCH", url: "/x", body: {} } }])).toBe(false);
    expect(writes().filter(r => r.url === "/api/settings/apply")).toHaveLength(1);
    expect(writes().filter(r => r.url === "/x")).toHaveLength(0);
    g.open({ body: JOB_DONE });
    await vi.waitFor(() => expect(op().phase).toBe("done"), { timeout: 5000 });
  }, 15_000);

  it("a POST whose answer is lost is sent again with the same key, never as a second job", async () => {
    let n = 0;
    routes.push(r => (r.url === "/api/settings/apply" && r.method === "POST" && n++ < 2 ? Promise.reject(new Error("offline")) as never : undefined));
    expect(apply.startOperation([])).toBe(true);
    await vi.waitFor(() => expect(op().phase).toBe("done"), { timeout: 9000 });
    const posts = writes().filter(r => r.url === "/api/settings/apply");
    expect(posts).toHaveLength(3);
    expect(new Set(posts.map(r => r.key)).size).toBe(1);
  }, 15_000);

  it("leaving while writes or the POST are still to come makes the browser ask; once the job exists it does not", async () => {
    const g = gate<{ body: unknown }>();
    routes.push(r => (r.method === "PATCH" ? g.p : undefined));
    apply.startOperation([{ label: "x", impact: "now", request: { method: "PATCH", url: "/api/settings/fleet/instances/alpha", body: { description: "z" } } }]);
    await settle(2);
    const before = winEvent("beforeunload");
    expect(before.defaultPrevented).toBe(true);
    g.open({ body: { ok: true } });
    await vi.waitFor(() => expect(op().phase).toBe("done"), { timeout: 5000 });
    expect(winEvent("beforeunload").defaultPrevented).toBe(false);
  }, 10_000);
});

describe("staged changes and leaving", () => {
  it("a section change is the same panel: no reload, nothing asked, the staged change stays", async () => {
    await mount("agents", "settings:agents|1|en"); await settle(6);
    await stageDescription("alpha", "A2");
    const loads = reads().filter(u => u === "/api/settings/fleet/raw").length;
    let asked = 0;
    (globalThis as any).confirm = () => { asked++; return false; };
    nav.navigate("/settings/general");
    await mount("general", "settings:general|2|en"); await settle(6);
    expect(nav.navStore.get().route).toEqual({ panel: "settings", section: "general" });
    expect(asked).toBe(0);
    expect(reads().filter(u => u === "/api/settings/fleet/raw").length).toBe(loads);
    expect(p.root.querySelector(".s-pending")?.textContent).toContain("1");
  });

  it("leaving the panel with staged changes asks first: Cancel stays; Discard leaves, and nothing staged is ever sent", async () => {
    await mount(); await settle(6);
    await stageDescription("alpha", "A2");
    const messages: string[] = [];
    (globalThis as any).confirm = (m: string) => { messages.push(m); return false; };
    nav.navigate("/ui/fleet");
    expect(messages).toEqual(["Discard 1 pending changes?"]);
    expect(nav.navStore.get().route).toEqual({ panel: "settings", section: "agents" });
    expect(p.window.location.pathname).toBe("/settings");
    // Back/Forward too: the address is put back.
    p.window.history.pushState(null, "", "/ui/fleet");
    winEvent("popstate");
    expect(messages).toHaveLength(2);
    expect(p.window.location.pathname).toBe("/settings");
    expect(nav.navStore.get().route.panel).toBe("settings");
    (globalThis as any).confirm = () => true;
    nav.navigate("/ui/fleet");
    expect(nav.navStore.get().route).toEqual({ panel: "fleet", tab: "tasks" });
    await p.unmount();
    await new Promise(r => setTimeout(r, 50));
    expect(writes()).toEqual([]);
    // Nothing staged and nothing asked after it went.
    (globalThis as any).confirm = () => { throw new Error("asked after the panel went"); };
    nav.navigate("/ui");
    expect(nav.navStore.get().route.panel).toBe("chat");
  });

  it("a staged token is held by the staged change only, and Discard drops it unsent", async () => {
    await mount("bots", "settings:bots|1|en"); await settle(6);
    btn(p.root.querySelector(".s-row"), "Settings").click(); await settle(4);
    const token = p.root.querySelector("#bot-token");
    token.value = "fake-token-value"; fire(token, "input"); await settle(2);
    btn(p.root.querySelector("dialog"), "Stage the new token").click(); await settle(2);
    expect(p.root.querySelector("#bot-token").value).toBe("");
    p.root.querySelector("dialog .dlg-x").click(); await settle(4);
    expect(p.root.querySelector(".s-pending")?.textContent).toContain("1");
    btn(p.root.querySelector(".s-pending"), "Discard").click(); await settle(6);
    expect(p.root.querySelector(".s-pending")).toBeNull();
    expect(JSON.stringify(reqs)).not.toContain("fake-token-value");
  });
});

describe("#1374 and leaks", () => {
  it("mounting reads the configuration once; while it stays open nothing is read again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "performance"] });
    const m = mount(); await vi.advanceTimersByTimeAsync(50); await m;
    expect(reads().sort()).toEqual(["/api/fleet", "/api/profiles", "/api/settings/classic", "/api/settings/connections", "/api/settings/fleet/raw",
      "/api/settings/pending", "/api/settings/provider-secrets", "/api/settings/schema"]);
    reqs = [];
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reqs).toEqual([]);
  });

  it("50 mounts leave nothing: no lease, no listener, no leave guard", async () => {
    await settle();
    const baseLeases = ctx.leaseCount(), doc = p.document.listenerCount(), win = p.window.listenerCount();
    for (let i = 0; i < 50; i++) { await mount(i % 2 ? "general" : "agents", `s:${i}`); await p.unmount(); }
    await settle(4);
    expect(ctx.leaseCount()).toBe(baseLeases);
    expect(p.document.listenerCount()).toBe(doc);
    expect(p.window.listenerCount()).toBe(win);
    (globalThis as any).confirm = () => { throw new Error("a guard is left"); };
    nav.navigate("/ui/fleet");
    expect(nav.navStore.get().route.panel).toBe("fleet");
  }, 30_000);

  it("a load that answers after the panel went is dropped", async () => {
    const g = gate<{ body: unknown }>();
    routes.push(r => (r.url === "/api/settings/fleet/raw" ? g.p : undefined));
    await mount(); await settle(2);
    await p.unmount();
    g.open({ body: structuredClone(FLEET) });
    await settle(6);
    expect(p.root.childNodes.length).toBe(0);
    expect(reads()).not.toContain("/api/settings/classic");      // the sequence stopped at the lease
  });
});

describe("#1423: a change an admin must confirm", () => {
  const VIEW = (state: string, extra: Record<string, unknown> = {}) => ({ id: "d".repeat(32), state, section: "access", requested_at: 1, requested_by: "Chrome",
    expires_at: 2, remaining_ms: 290_000, source: "web_session", summary: ["fleet access: add 9"], confirmation: { kind: "chat" }, can_withdraw: state === "pending", outcome: null, ...extra });
  const pendingAnswer = { status: 202, body: { ok: true, result: "pending_confirmation", pending_change: VIEW("pending") } };
  async function stageAccess() {
    await mount("bots", "settings:bots|1|en"); await settle(6);
    btn(p.root.querySelector(".s-row"), "Settings").click(); await settle(4);
    const input = p.root.querySelector("dialog .chips-box input");
    input.value = "9"; fire(input, "input"); await settle(2); fire(input, "keydown", { key: "Enter" }); await settle(2);
    btn(p.root.querySelector("dialog"), "Stage change").click(); await settle(4);
    if (!p.root.querySelector(".s-pending")) throw new Error("not staged: " + (p.root.querySelector("dialog")?.textContent ?? p.root.textContent).slice(0, 400));
  }

  it("waits in the operation with passive polls every 2 s; confirmed, the operation goes on to its one apply; the polls stop", async () => {
    let decided = false;
    routes.push(r => (r.method === "PUT" && r.url === "/api/settings/fleet/channels" ? pendingAnswer : undefined));
    routes.push(r => (r.url === `/api/settings/pending/${"d".repeat(32)}` ? { body: decided ? VIEW("applied", { outcome: { state: "applied", result: { ok: true } } }) : VIEW("pending") } : undefined));
    await stageAccess();
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "performance"] });
    btn(p.root.querySelector(".s-pending"), "Apply changes").click();
    await vi.advanceTimersByTimeAsync(50);
    expect(op().steps[0].status).toBe("waiting");
    expect(app.appStore.get().pendingChanges.map((x: any) => x.state)).toEqual(["pending"]);
    reqs = [];
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reqs.map(r => `${r.method} ${r.url}`)).toEqual(Array(5).fill(`GET /api/settings/pending/${"d".repeat(32)}`));
    expect(writes()).toEqual([]);                                // no apply while it waits
    decided = true;
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(op().phase).toBe("done");
    expect(writes().filter(r => r.url === "/api/settings/apply")).toHaveLength(1);
    reqs = [];
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reqs.filter(r => r.url.startsWith("/api/settings/pending"))).toEqual([]);
    expect(vi.getTimerCount(), "nothing left ticking once it is decided").toBe(0);
  }, 20_000);

  it("refused: the operation stops, the apply is never posted, and the change is staged again", async () => {
    routes.push(r => (r.method === "PUT" && r.url === "/api/settings/fleet/channels" ? pendingAnswer : undefined));
    routes.push(r => (r.url.startsWith("/api/settings/pending/") ? { body: VIEW("rejected", { outcome: { state: "rejected", reason_code: "rejected", message: "Rejected in chat." } }) } : undefined));
    await stageAccess();
    btn(p.root.querySelector(".s-pending"), "Apply changes").click();
    await vi.waitFor(() => expect(op().phase).toBe("failed"), { timeout: 6000 });
    expect(writes().filter(r => r.url === "/api/settings/apply")).toEqual([]);
    await settle(6);
    expect(p.root.querySelector(".s-pending")?.textContent).toContain("1");
    expect(p.root.querySelector(".s-op")?.textContent).toContain("Rejected in chat.");
  }, 10_000);

  it("Withdraw sends DELETE for the request, and its answer is what the card then says", async () => {
    routes.push(r => (r.method === "PUT" && r.url === "/api/settings/fleet/channels" ? pendingAnswer : undefined));
    routes.push(r => (r.method === "DELETE" ? { body: VIEW("rejected", { outcome: { state: "rejected", reason_code: "withdrawn", message: "Change withdrawn." } }) } : undefined));
    await stageAccess();
    btn(p.root.querySelector(".s-pending"), "Apply changes").click();
    await vi.waitFor(() => expect(app.appStore.get().pendingChanges).toHaveLength(1));
    const card = app.appStore.get().pendingChanges[0];
    expect(typeof card.withdraw).toBe("function");
    await card.withdraw();
    expect(writes().filter(r => r.method === "DELETE").map(r => r.url)).toEqual([`/api/settings/pending/${"d".repeat(32)}`]);
    await vi.waitFor(() => expect(op().phase).toBe("failed"));
    expect(app.appStore.get().pendingChanges[0].state).toBe("rejected");
    expect(app.appStore.get().pendingChanges[0].withdraw).toBeNull();
  }, 10_000);

  it("a request still open from before a reload is followed again when Settings mounts", async () => {
    routes.push(r => (r.url === "/api/settings/pending" ? { body: [VIEW("pending")] } : undefined));
    await mount(); await settle(6);
    expect(app.appStore.get().pendingChanges.map((x: any) => x.id)).toEqual(["d".repeat(32)]);
  });

  it("the shell shows the request in any panel, and the operation as one line outside Settings", async () => {
    app.appStore.set({ pendingChanges: [{ ...VIEW("pending"), label: "Update main access", deadline: performance.now() + 60_000, withdraw: () => {}, dismiss: null }],
      settingsOp: { id: 1, phase: "writing", error: null, job: null, lostJob: false, restart: "idle", leftover: [], steps: [{ label: "Update main access", impact: "fleet", status: "waiting", error: null, pendingId: "d" }] } });
    nav.navigate("/ui/fleet");
    const panels = new Map([["fleet", { load: async () => () => h("div", { class: "panel" }, "fleet") }], ["settings", { load: async () => () => h("div", { class: "panel" }, "settings") }]]);
    await p.mount(h(shell.Shell, { panels }));
    await settle(6);
    expect(p.root.querySelector(".pending-card")?.textContent).toContain("Waiting for confirmation");
    expect(p.root.querySelector(".pending-card")?.textContent).toContain("fleet access: add 9");
    expect(p.root.querySelector(".op-line")?.textContent).toContain("waiting for confirmation in chat");
    nav.navigate("/settings");
    await settle(6);
    expect(p.root.querySelector(".op-line")).toBeNull();          // Settings shows the operation itself
    expect(p.root.querySelector(".pending-card")).not.toBeNull();
    await p.unmount();
    app.appStore.set({ pendingChanges: [], settingsOp: null });
  });
});

describe("the other ways in: Developer YAML and the setup wizard hand over to the same runner", () => {
  it("Developer: an edited model is one operation — its writes in order, then one apply", async () => {
    await mount("advanced", "settings:advanced|1|en"); await settle(6);
    btn(p.root.querySelector(".s-dev"), "JSON").click(); await settle(2);
    btn(p.root.querySelector(".s-dev"), "Edit").click(); await settle(2);
    const ta = p.root.querySelector("textarea.s-yaml");
    const model = JSON.parse(ta.value);
    model.instances.alpha.description = "A3";
    delete model.instances.beta;
    model.instances.gamma = { working_directory: "/w/g" };
    ta.value = JSON.stringify(model); fire(ta, "input"); await settle(2);
    btn(p.root.querySelector(".s-dev"), "Apply & save").click();
    await vi.waitFor(() => expect(op().phase).toBe("done"), { timeout: 6000 });
    const order = writes().map(r => `${r.method} ${r.url}`);
    expect(order).toEqual(["PUT /api/settings/fleet/defaults", "PUT /api/settings/fleet/channels", "PATCH /api/settings/fleet/instances/alpha",
      "POST /api/settings/fleet/instances/gamma", "DELETE /api/settings/fleet/instances/beta", "POST /api/settings/apply"]);
  }, 10_000);

  it("the wizard: the commit (a write an admin may confirm), then the ordinary apply — one, owned by the app — and the token only in the commit", async () => {
    routes.push(r => {
      if (r.url === "/api/settings/quickstart/environment") return { body: { backends: ["codex"], channels: [], has_fleet: true } };
      if (r.url === "/api/settings/quickstart/probe" && r.body?.action === "verify") return { body: { identity: { valid: true, username: "bot" } } };
      if (r.url === "/api/settings/quickstart/plan") return { body: { channel: { type: "telegram" }, instance: { name: "agent-1", working_directory: "/w", backend: "codex" }, env_keys: ["AGEND_BOT_TOKEN"], warnings: [] } };
      if (r.url === "/api/settings/quickstart/commit") return { body: { ok: true, secret_mode_ok: true } };
      return undefined;
    });
    await mount(); await settle(6);
    btn(p.root.querySelector(".panel-actions"), "Setup wizard").click(); await settle(6);
    const d = () => p.root.querySelector("dialog");
    const type = async (sel: string, v: string) => { const i = d().querySelector(sel); i.value = v; fire(i, "input"); await settle(2); };
    await type("#wz-wd", "/w");
    btn(d(), "Next").click(); await settle(2);
    btn(d(), "Next").click(); await settle(2);
    await type("#wz-token", "fake-wizard-token");
    btn(d(), "Verify").click(); await settle(6);
    btn(d(), "Next").click(); await settle(6);
    btn(d(), "Create and start").click();
    await vi.waitFor(() => expect(op()?.phase).toBe("done"), { timeout: 6000 });
    const w = writes().filter(r => r.url !== "/api/settings/quickstart/probe" && r.url !== "/api/settings/quickstart/plan");
    expect(w.map(r => `${r.method} ${r.url}`)).toEqual(["POST /api/settings/quickstart/commit", "POST /api/settings/apply"]);
    expect(w[0]!.body.token).toBe("fake-wizard-token");
    expect(w[0]!.key).toBeTruthy();
    expect(JSON.stringify(writes().filter(r => r.url === "/api/settings/apply"))).not.toContain("fake-wizard-token");
    expect(p.root.querySelector("dialog")).toBeNull();
  }, 10_000);
});
