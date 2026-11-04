/**
 * alpha.2 (M-2300; the user, hmsg-28c87ca7; junsion's §6): an agent's Windows request (#2973: create_instance with
 * runtime "windows", update_instance_config on one — a pending SettingsConfirmationStore request, source agent_request)
 * on a fleet with NO chat connection has no General card to be confirmed in. Its owner — the `agend web --code` session on
 * this computer, web-verified (decision 28c2d3a3) — sees it in the web's Needs you and approves or rejects it there.
 * A real fleet's web server, signed in over HTTP:
 *  - GET /ui/agent-proposals: the owner reads the request (who asked, its summary, when it runs out); anyone else (from
 *    another machine, over the public link, on a chat fleet, before sign-in) reads `owner: false` and nothing;
 *  - POST /ui/agent-proposals/<id>: Approve runs the request's apply ONCE and answers applied with the new agent's name;
 *    a second click (or the host's command first) answers "no longer pending" with the request as it stands; Reject
 *    applies nothing; a request run out answers expired; a revoked owner is refused before anything, and a revocation
 *    landing after the click leaves it stale, never applied; a request that is not an agent's is not this route's;
 *  - the store's change hook fires for each step (the stream's `agent_proposals` ping, which carries nothing).
 * And the page: the Needs you panel lists it with its summary, Approve / Reject; the server's answer stays shown, with
 * the new agent's chat; a tab opened before an upgrade (no list installed) reads it itself, once.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { csrfTokenFor, tokenEpoch, type SessionRecord } from "../src/web-session.js";
import { WEB_CSRF_HEADER } from "../src/web-auth.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { setLocale } from "../src/locale.js";
import { page, h as hh, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let text = ""; res.on("data", (c: Buffer) => { text += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  });
}
const CHAT = { channel: { type: "telegram", mode: "topic", bot_token_env: "T", group_id: "-100", access: { mode: "locked", allowed_users: ["1"] } } };
async function startFleet(config: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-m2300-")); dirs.push(dir);
  const fm = new FleetManager(dir), any = fm as any;
  const sink = () => {};
  fm.logger = { info: sink, warn: sink, error: sink, debug: sink, trace: sink, fatal: sink, child: () => fm.logger } as unknown as typeof fm.logger;
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
  fm.fleetConfig = { defaults: {}, instances: {}, web: { verified_authority: { enabled: true } }, ...config } as never;
  any.initializeWebAuthTokens();
  any.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const address = (any.healthServer as Server).address();
  if (!address || typeof address === "string") throw new Error("missing TCP address");
  const port = address.port, origin = `http://127.0.0.1:${port}`, token = fm.getDashboardAccess().token!;
  const stop = () => new Promise<void>(resolve => { const s = any.healthServer as Server | null; any.healthServer = null; s ? s.close(() => resolve()) : resolve(); });
  const signIn = async (extra: Record<string, string> = {}) => {
    const code = JSON.parse((await raw(port, "POST", "/auth/issue-code", { "x-agend-token": token, origin })).body).code as string;
    const res = await raw(port, "POST", "/auth/login", { "content-type": "application/json", origin, ...extra }, JSON.stringify({ code }));
    expect(res.status).toBe(200);
    const set = res.headers["set-cookie"]; const cookie = (Array.isArray(set) ? set[0] : set)!.split(";")[0]!;
    const sessionId = cookie.split("=")[1]!;
    return { cookie, sessionId, record: any.webSessions.authenticate(sessionId, tokenEpoch(token), { touch: false }) as SessionRecord };
  };
  const list = async (cookie: string, extra: Record<string, string> = {}) => JSON.parse((await raw(port, "GET", "/ui/agent-proposals", { cookie, ...extra })).body);
  const decide = async (s: { cookie: string; sessionId: string }, id: string, decision: string, extra: Record<string, string> = {}) => {
    const r = await raw(port, "POST", `/ui/agent-proposals/${id}`, { cookie: s.cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/json",
      [WEB_CSRF_HEADER]: csrfTokenFor(s.sessionId), ...extra }, JSON.stringify({ decision }));
    return { status: r.status, body: JSON.parse(r.body) };
  };
  /** An agent's Windows request, as #2973 holds it: source agent_request, session agent:<name>; its apply counted. */
  const propose = (over: Record<string, unknown> = {}) => {
    const apply = vi.fn(async (_c: () => boolean, execution: any) => execution.commit(() => ({ name: "win-builder" })));
    const store = any.settingsGate().store;
    const view = store.propose({ session: "agent:planner", key: `agent-windows:${Math.random()}`, fingerprint: `f${Math.random()}`, bytes: 1,
      source: "agent_request", section: "channel", requestedBy: "planner",
      summary: ["Create agent win-builder", "machine: this PC (Windows)", "CLI: codex · model gpt-5.5", "directory: C:\\work\\builder", "access: workspace-write"],
      authority: { connections: [], primaryGeneral: true, unknown: false }, affectedConnections: [],
      current: () => true, unchanged: async () => true, snapshot: () => null, apply, ...over }).view;
    return { view, apply, store };
  };
  return { fm, any, port, origin, stop, signIn, list, decide, propose };
}

describe("alpha.2 the server: a web-only fleet's owner decides an agent's request", () => {
  beforeEach(() => setLocale("en"));
  it("the owner reads it — who asked, what it would do, when it runs out; Approve applies it once and names the new agent", async () => {
    const h = await startFleet();
    try {
      const s = await h.signIn();
      const changed = vi.spyOn(h.any.settingsGate().store.options, "changed");
      const { view, apply } = h.propose();
      const listed = await h.list(s.cookie);
      expect([listed.owner, listed.proposals.length, listed.proposals[0].id, listed.proposals[0].requested_by, listed.proposals[0].source, listed.proposals[0].state])
        .toEqual([true, 1, view.id, "planner", "agent_request", "pending"]);
      expect(listed.proposals[0].summary).toContain("directory: C:\\work\\builder");
      expect(listed.proposals[0].remaining_ms).toBeGreaterThan(60_000);
      const r = await h.decide(s, view.id, "confirm");
      expect([r.status, r.body.view.state, r.body.view.outcome.decided_by_label, r.body.agent, apply.mock.calls.length])
        .toEqual([200, "applied", "This computer's admin", "win-builder", 1]);
      expect(r.body.view.confirmation.kind).toBe("web");
      expect((await h.list(s.cookie)).proposals).toEqual([]);                          // decided: off the list
      // A second click: no second apply, and the request as it stands.
      const again = await h.decide(s, view.id, "confirm");
      expect([again.status, again.body.error, again.body.view.state, apply.mock.calls.length]).toEqual([409, "confirmation_not_pending", "applied", 1]);
      expect(changed.mock.calls.map((c: any[]) => c[0].state)).toEqual(["pending", "applying", "applied"]);   // each step pings the pages
    } finally { await h.stop(); }
  }, 20_000);
  it("Reject applies nothing; a request run out answers expired; the host's command first answers no longer pending", async () => {
    const h = await startFleet();
    try {
      const s = await h.signIn();
      const a = h.propose();
      const no = await h.decide(s, a.view.id, "reject");
      expect([no.status, no.body.view.state, a.apply.mock.calls.length]).toEqual([200, "rejected", 0]);
      const b = h.propose({ remainingMs: 30 });
      await new Promise(r => setTimeout(r, 60));
      const late = await h.decide(s, b.view.id, "confirm");
      expect([late.status, late.body.error, late.body.view.state, b.apply.mock.calls.length]).toEqual([409, "confirmation_not_pending", "expired", 0]);
      const c = h.propose();
      await c.store.decide(c.view.id, "confirm", { label: "host", current: () => true });   // `agend settings confirm` on the host
      const after = await h.decide(s, c.view.id, "confirm");
      expect([after.status, after.body.view.state, c.apply.mock.calls.length]).toEqual([409, "applied", 1]);
    } finally { await h.stop(); }
  }, 20_000);
  it("a revoked owner is refused before anything; a revocation after the click leaves it stale, never applied", async () => {
    const h = await startFleet();
    try {
      const s = await h.signIn();
      const a = h.propose();
      h.fm.revokeWebAuthority();
      const refused = await h.decide(s, a.view.id, "confirm");
      expect([refused.status, refused.body.error, a.apply.mock.calls.length]).toEqual([403, "owner_required", 0]);
      expect(a.store.inspect(a.view.id).state).toBe("pending");                           // still the owner's to decide later
      const s2 = await h.signIn();
      const b = h.propose({ unchanged: async () => { h.fm.revokeWebAuthority(); return true; } });
      const stale = await h.decide(s2, b.view.id, "confirm");
      expect([stale.status, stale.body.view.state, b.apply.mock.calls.length]).toEqual([200, "stale", 0]);
      // #2997 review (Prism P2): the owner signs out (its session removed) while the request is being applied: the live
      // session is asked, not the record captured at the click — stale, never applied.
      const s3 = await h.signIn();
      const c = h.propose({ unchanged: async () => { h.any.webSessions.revokeById(s3.sessionId); return true; } });
      const signedOut = await h.decide(s3, c.view.id, "confirm");
      expect([signedOut.status, signedOut.body.view.state, c.apply.mock.calls.length]).toEqual([200, "stale", 0]);
    } finally { await h.stop(); }
  }, 20_000);
  it("nobody else sees or decides it: from another machine, over the public link, a chat fleet's admin, no session", async () => {
    const h = await startFleet();
    try {
      const s = await h.signIn();
      const a = h.propose();
      const lan = { "x-forwarded-for": "10.0.0.9" };
      expect(await h.list(s.cookie, lan)).toEqual({ owner: false, proposals: [] });
      const fromLan = await h.decide(s, a.view.id, "confirm", lan);
      expect([fromLan.status, fromLan.body.error]).toEqual([403, "owner_required"]);
      const gw: any = { method: "GET", socket: { remoteAddress: "127.0.0.1" }, headers: { host: `127.0.0.1:${h.port}`, cookie: s.cookie } };
      bindGatewayRequest(gw, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://abc.trycloudflare.com", isCurrent: () => true });
      expect(h.fm.webAgentProposals(gw)).toBeNull();
      expect((await h.fm.webDecideAgentProposal(gw, a.view.id, "confirm")).status).toBe(403);
      expect((await raw(h.port, "GET", "/ui/agent-proposals")).status).not.toBe(200);   // no session: the gate
      expect(a.apply).not.toHaveBeenCalled();
      // A request that is not an agent's (a browser's own settings change) is not this route's.
      const own = h.propose({ source: "web_session", session: "browser" });
      const notMine = await h.decide(s, own.view.id, "confirm");
      expect([notMine.status, notMine.body.error, own.apply.mock.calls.length]).toEqual([404, "not_found", 0]);
    } finally { await h.stop(); }
    const c = await startFleet(CHAT);
    try {
      const s = await c.signIn();
      const a = c.propose();
      expect(await c.list(s.cookie)).toEqual({ owner: false, proposals: [] });              // a chat fleet: General's card
      expect((await c.decide(s, a.view.id, "confirm")).status).toBe(403);
      expect(a.apply).not.toHaveBeenCalled();
    } finally { await c.stop(); }
  }, 30_000);
  it("#2997 review: a web-only fleet's status frame carries the requests' revision, moving with each step; a chat fleet's has none", async () => {
    const h = await startFleet();
    try {
      const rev = () => (h.fm.getUiStatus() as any).agent_proposals_rev;
      const r0 = rev();
      const s = await h.signIn();
      const a = h.propose();
      expect(rev()).toBe(r0 + 1);
      await h.decide(s, a.view.id, "reject");
      expect(rev()).toBe(r0 + 2);
    } finally { await h.stop(); }
    const c = await startFleet(CHAT);
    try { expect((c.fm.getUiStatus() as any).agent_proposals_rev).toBeUndefined(); } finally { await c.stop(); }
  }, 20_000);
  it("a malformed decision or id is refused before anything", async () => {
    const h = await startFleet();
    try {
      const s = await h.signIn();
      const a = h.propose();
      expect((await h.decide(s, a.view.id, "approve")).status).toBe(400);
      expect((await raw(h.port, "POST", "/ui/agent-proposals/not-an-id", { cookie: s.cookie, origin: h.origin, "content-type": "application/json", [WEB_CSRF_HEADER]: csrfTokenFor(s.sessionId) }, "{}")).status).not.toBe(200);
      expect(a.apply).not.toHaveBeenCalled();
    } finally { await h.stop(); }
  }, 20_000);
});

// ── The page ──
type Req = { method: string; url: string; body: any };
let reqs: Req[] = [];
let answer: (r: Req) => unknown = () => ({});
const fetchFake = async (url: string, init: any = {}) => {
  const r: Req = { method: init.method || "GET", url, body: init.body ? JSON.parse(init.body) : null };
  reqs.push(r);
  const body = await answer(r);
  const status = body && typeof (body as any).__status === "number" ? (body as any).__status : 200;
  return { ok: status < 300, status, json: async () => body };
};
const PROPOSAL = { id: "a".repeat(32), state: "pending", section: "channel", requested_at: Date.now() - 60_000, requested_by: "planner", expires_at: Date.now() + 240_000,
  remaining_ms: 240_000, source: "agent_request", summary: ["Create agent win-builder", "directory: C:\\work\\builder", "access: workspace-write"],
  confirmation: { kind: "host_cli" }, can_withdraw: true, outcome: null };

describe("alpha.2 the page: Needs you lists an agent's request for the owner", () => {
  let p: AppPage, N: any, app: any, AP: any, I: any;
  beforeAll(async () => {
    p = page({ url: "http://127.0.0.1:19280/ui/needs", storage: { agend_tour_done: "1" } });
    (globalThis as any).fetch = fetchFake;
    app = await import("/assets/app-store.js");
    I = await import("/assets/app-i18n.js");
    N = await import("/ui/js/panel-needs.js");
    AP = await import("/ui/js/agent-proposals.js");
  });
  afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
  beforeEach(async () => { await p.unmount(); reqs = []; answer = () => ({}); N.decisions.set(() => ({})); AP.resetProposals(); app.appStore.set({ needs: [], instances: [], proposals: [] }); });
  const mount = async () => { await p.mount(hh(N.NeedsPanel, { navKey: `needs|${Math.random()}` })); await settle(4); };

  it("its summary, who asked, when it runs out; Approve posts confirm once; the answer stays with the new agent's chat", async () => {
    app.appStore.set({ proposals: [PROPOSAL] });
    await mount();
    expect(p.root.querySelector(".n-proposals .n-group-head").textContent).toBe("Agent requests");
    expect(p.root.querySelector(".n-proposals .n-title strong").textContent).toBe("Request from planner");
    expect(p.root.querySelectorAll(".n-proposals .n-detail li").map((li: any) => li.textContent)).toEqual(PROPOSAL.summary);
    expect(p.root.querySelector(".n-proposals .n-age").textContent).toContain("expires in 4 min");
    expect(reqs).toEqual([]);                                                                 // a current page: nothing read here
    answer = (r) => r.method === "POST"
      ? { view: { ...PROPOSAL, state: "applied", outcome: { state: "applied", message: "Settings change applied.", reason_code: "applied", decided_at: 1 } }, agent: "win-builder" }
      : { owner: true, proposals: [] };
    const [approve] = p.root.querySelectorAll(".n-proposals button");
    fire(approve, "click"); fire(approve, "click");
    await settle(6);
    expect(reqs.filter(r => r.method === "POST").map(r => [r.url, r.body])).toEqual([[`/ui/agent-proposals/${PROPOSAL.id}`, { decision: "confirm" }]]);
    app.appStore.set({ proposals: [] }); await settle(4);
    expect(p.root.querySelector(".n-proposals .n-title strong").textContent).toBe("Approved: the change is applied.");
    expect(p.root.querySelector(".n-proposals a").getAttribute("href")).toBe("/ui/chat/win-builder");
  });
  it("an answer that is not applied (already decided, run out, failed with its reason) is said, with no agent link", async () => {
    app.appStore.set({ proposals: [PROPOSAL] });
    await mount();
    answer = (r) => r.method === "POST"
      ? { __status: 409, error: "confirmation_not_pending", view: { ...PROPOSAL, state: "failed", outcome: { state: "failed", message: "Could not be applied.", detail: "machine offline", reason_code: "apply_failed", decided_at: 1 } } }
      : { owner: true, proposals: [] };
    fire(p.root.querySelectorAll(".n-proposals button")[1], "click");                        // Reject (the answer is the server's)
    await settle(6);
    app.appStore.set({ proposals: [] }); await settle(4);
    expect(p.root.querySelector(".n-proposals .n-title strong").textContent).toBe("It could not be applied.");
    expect(p.root.querySelector(".n-proposals .note").textContent).toBe("Reason: machine offline");
    expect(p.root.querySelector(".n-proposals a")).toBeNull();
  });
  it("a tab opened before an upgrade (app.js never installed the list): the panel reads it itself, once", async () => {
    app.appStore.set({ proposals: undefined });
    answer = () => ({ owner: true, proposals: [PROPOSAL] });
    await mount(); await settle(4);
    expect(reqs.map(r => [r.method, r.url])).toEqual([["GET", "/ui/agent-proposals"]]);
    expect(p.root.querySelector(".n-proposals .n-title strong").textContent).toBe("Request from planner");
  });
  it("a create request's summary as the owner reads it: unescaped and named — the machine, the CLI, the folder, the access", () => {
    // The server's lines exactly as the e2e run read them (the settings diff, escaped for a chat's markdown).
    const server = ["POST /ui/instances", "new\\_instance.runtime: absent → windows", "new\\_instance.topic\\_name: absent → builder",
      "new\\_instance.directory: absent → C:\\\\agend\\\\builder", "new\\_instance.backend: absent → codex", "new\\_instance.model: absent → gpt-5.5",
      "new\\_instance.sandbox: absent → workspace-write"];
    expect(N.proposalLines(server)).toEqual(["Create a Windows agent", "Runs on: windows", "Machine: This PC (Windows)", "Name: builder",
      "Folder: C:\\agend\\builder", "CLI: codex", "Model: gpt-5.5", "Access: can write in its folder"]);
    // A paired machine named instead of this PC; a change's lines; anything else as it is.
    expect(N.proposalLines(["POST /ui/instances", "new\\_instance.machineId: absent → 6f1c", "new\\_instance.sandbox: absent → read-only"]))
      .toEqual(["Create a Windows agent", "Machine: 6f1c", "Access: read-only"]);
    expect(N.proposalLines(["win-a model: gpt-5 → gpt-5.5", "something else"])).toEqual(["Change win-a · Model: gpt-5 → gpt-5.5", "something else"]);
    I.setLang("zh-TW", { store: false });
    try { expect(N.proposalLines(server).slice(0, 3)).toEqual(["建立 Windows agent", "執行於: windows", "電腦: 這台電腦（Windows）"]); }
    finally { I.setLang("en", { store: false }); }
  });
  it("#2997 review: a status frame whose revision moved reads the list again (a polling page, a reconnect, an old tab's stream)", async () => {
    const handlers: Record<string, Array<(d: unknown) => void>> = {};
    app.appStore.set({ streamOn: (name: string, fn: (d: unknown) => void) => { (handlers[name] ??= []).push(fn); return () => {}; } });
    answer = () => ({ owner: true, proposals: [] });
    AP.installProposals(); await settle(2);
    const gets = () => reqs.filter(r => r.method === "GET" && r.url === "/ui/agent-proposals").length;
    expect(gets()).toBe(1);                                                                  // read once
    for (const fn of handlers.status) fn({ instances: [], agent_proposals_rev: 3 }); await settle(2);
    expect(gets()).toBe(2);                                                                  // the first frame: read (a change before it is not missed)
    for (const fn of handlers.status) fn({ instances: [], agent_proposals_rev: 3 }); await settle(2);
    expect(gets()).toBe(2);                                                                  // the same revision: nothing
    for (const fn of handlers.status) fn({ instances: [], agent_proposals_rev: 4 }); await settle(2);
    expect(gets()).toBe(3);
    for (const fn of handlers.agent_proposals) fn({}); await settle(2);
    expect(gets()).toBe(4);                                                                  // the live ping too
    app.appStore.set({ streamOn: undefined });
  });
  it("#3008: on the public link too — this computer's admin signed in from outside reads it (the server answers anyone else empty)", async () => {
    p.document.body.dataset.publicLink = "1";
    try {
      answer = () => ({ owner: true, proposals: [PROPOSAL] });
      AP.installProposals(); await settle(3);
      expect(reqs.map(r => [r.method, r.url])).toEqual([["GET", "/ui/agent-proposals"]]);
      expect(app.appStore.get().proposals.map((x: any) => x.id)).toEqual([PROPOSAL.id]);
    } finally { delete p.document.body.dataset.publicLink; }
  });
  it("#2997 review r2: a read that failed (5xx, not a list) is never taken as read — the same revision reads again, and succeeds", async () => {
    const handlers: Record<string, Array<(d: unknown) => void>> = {};
    app.appStore.set({ streamOn: (name: string, fn: (d: unknown) => void) => { (handlers[name] ??= []).push(fn); return () => {}; } });
    const status = async (rev: number) => { for (const fn of handlers.status) fn({ instances: [], agent_proposals_rev: rev }); await settle(3); };
    answer = () => ({ owner: true, proposals: [] });
    AP.installProposals(); await settle(2);
    let mode: "500" | "bad" | "ok" = "500";
    answer = () => mode === "500" ? { __status: 500, error: "boom" } : mode === "bad" ? { owner: true } : { owner: true, proposals: [PROPOSAL] };
    await status(7);                                                                         // a request came: its read fails
    expect(app.appStore.get().proposals).toEqual([]);
    mode = "bad";
    await status(7);                                                                         // the same revision: read again (an answer with no list: not read)
    expect(app.appStore.get().proposals).toEqual([]);
    mode = "ok";
    await status(7);                                                                         // …again, and now it is read
    expect(app.appStore.get().proposals.map((x: any) => x.id)).toEqual([PROPOSAL.id]);
    const before = reqs.length;
    await status(7);                                                                         // read at 7 now: nothing more
    expect(reqs.length).toBe(before);
    app.appStore.set({ streamOn: undefined });
  });
  it("#2997 review r2: a failed read retries on its own, a bounded number of times (a stream that sends no more status frames)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let fails = 2;
      answer = () => (fails-- > 0 ? { __status: 503, error: "busy" } : { owner: true, proposals: [PROPOSAL] });
      AP.installProposals();
      await vi.advanceTimersByTimeAsync(10);
      expect(app.appStore.get().proposals).toEqual([]);
      await vi.advanceTimersByTimeAsync(5_000);                                              // retry 1: fails
      await vi.advanceTimersByTimeAsync(5_000);                                              // retry 2: read
      expect(app.appStore.get().proposals.map((x: any) => x.id)).toEqual([PROPOSAL.id]);
      const n = reqs.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reqs.length).toBe(n);                                                            // read: no more timers
      // Always failing: at most 1 + 5 reads, then it waits for a status frame or a ping.
      AP.resetProposals(); reqs = []; answer = () => ({ __status: 500, error: "down" });
      AP.installProposals();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(reqs.length).toBe(6);
    } finally { vi.useRealTimers(); }
  });
  it("#2997 review r2: a newer revision while a read is out reads once more after it; the newer list wins", async () => {
    const handlers: Record<string, Array<(d: unknown) => void>> = {};
    app.appStore.set({ streamOn: (name: string, fn: (d: unknown) => void) => { (handlers[name] ??= []).push(fn); return () => {}; } });
    answer = () => ({ owner: true, proposals: [] });
    AP.installProposals(); await settle(2);
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    let n = 0;
    answer = async () => { n++; if (n === 1) { await held; return { owner: true, proposals: [] }; } return { owner: true, proposals: [PROPOSAL] }; };
    for (const fn of handlers.status) fn({ instances: [], agent_proposals_rev: 7 });   // read 1 goes out, held
    await settle(2);
    for (const fn of handlers.status) fn({ instances: [], agent_proposals_rev: 8 });   // newer while it is out: queued, not a 2nd GET now
    await settle(2);
    expect(n).toBe(1);
    release(); await settle(6);
    expect(n).toBe(2);
    expect(app.appStore.get().proposals.map((x: any) => x.id)).toEqual([PROPOSAL.id]);
    app.appStore.set({ streamOn: undefined });
  });
  it("#2997 review: a click whose POST fails (network) while the request still waits: said here, and the next click is taken", async () => {
    app.appStore.set({ proposals: [PROPOSAL] });
    await mount();
    let fail = true;
    const realFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string, init: any = {}) => {
      if ((init.method || "GET") === "POST" && fail) { reqs.push({ method: "POST", url, body: JSON.parse(init.body) }); throw new Error("network down"); }
      return realFetch(url, init);
    };
    answer = (r) => r.method === "POST" ? { view: { ...PROPOSAL, state: "rejected", outcome: { state: "rejected", message: "Rejected.", reason_code: "rejected", decided_at: 1 } } } : { owner: true, proposals: [PROPOSAL] };
    try {
      fire(p.root.querySelectorAll(".n-proposals button")[0], "click"); await settle(6);
      expect(p.root.querySelector(".n-proposal-error").textContent).toBe(I.t("app.failed"));
      expect(p.root.querySelectorAll(".n-proposals button")[0].disabled).toBe(false);
      fail = false;
      fire(p.root.querySelectorAll(".n-proposals button")[1], "click"); await settle(6);
      expect(reqs.filter(r => r.method === "POST").map(r => r.body.decision)).toEqual(["confirm", "reject"]);   // the second click was taken
      app.appStore.set({ proposals: [] }); await settle(4);
      expect(p.root.querySelector(".n-proposals .n-title strong").textContent).toBe("Rejected: nothing was changed.");
    } finally { (globalThis as any).fetch = realFetch; }
  });
  it("alpha.2 polish: an outcome in the page's language, never the fleet's (an English page read 「變更已套用。」); a code it does not know: the server's words", () => {
    const zhServer = (state: string, reason_code: string) => ({ state, reason_code, message: "變更已套用。", decided_at: 1 });
    expect(N.outcomeText(zhServer("applied", "applied"))).toBe("Approved: the change is applied.");
    expect(N.outcomeText(zhServer("failed", "apply_failed"))).toBe("It could not be applied.");
    expect(N.outcomeText(zhServer("expired", "expired"))).toBe("This request ran out before it was decided: nothing was changed.");
    expect(N.outcomeText(zhServer("stale", "settings_changed"))).toBe("The settings changed since the request: nothing was changed.");
    expect(N.outcomeText({ state: "weird", reason_code: "new_code", message: "server words", decided_at: 1 })).toBe("server words");
    expect(N.decideErrorText({ error: "owner_required", message: "只有…" })).toBe("Only this fleet's owner, signed in on the AgEnD computer itself, can decide an agent's request.");
    expect(N.decideErrorText({ error: "confirmation_not_pending", message: "這個設定確認已不在等待中。" })).toBe("This request was already decided or ran out.");
    expect(N.decideErrorText({ error: "http_502", message: null })).toBe(I.t("app.failed"));
    I.setLang("zh-TW", { store: false });
    try { expect(N.outcomeText({ state: "applied", reason_code: "applied", message: "Change applied.", decided_at: 1 })).toBe("已核准：變更已套用。"); }
    finally { I.setLang("en", { store: false }); }
  });
  it("its words in zh-TW", () => {
    I.setLang("zh-TW", { store: false });
    try { expect(["proposals", "approve", "reject", "proposalHint"].map(k => I.t(`needs.${k}`))).toEqual(["代理人的請求", "核准", "拒絕", expect.stringContaining("核准之前")]); }
    finally { I.setLang("en", { store: false }); }
  });
});
