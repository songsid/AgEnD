/**
 * The task board's web routes (/ui/tasks/board, /ui/tasks/cards…, /ui/tasks/projects…; design: docs/design/task-board.md)
 * through the real web handler, with a real FleetManager (no fleet; nothing spawns) and a real scheduler database.
 *
 *   1. A signed-in person runs a card from opening to confirming; reads return card numbers.
 *   2. The person is a signed-in session only: the header token (the CLI's, a script's — any agent here can read the
 *      token file) cannot write to the board, and on the old /ui/tasks routes it is held to an instance's rules, so it
 *      never confirms work waiting for the person.
 *   3. Refusals: a stale version is 409 with the board's code, a missing card 404, an unknown field 400.
 *   4. The public link carries the board's routes (the person works the board remotely), and nothing else under them.
 *
 * The rig is #1827's (tests/web-display-name-1827.test.ts): the real /dashboard → DM → /auth/login path signs in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw Error("No process"); }, execFile: () => { throw Error("No CLI"); }, execFileSync: () => { throw Error("No CLI"); }, execSync: () => { throw Error("No CLI"); }, spawnSync: () => { throw Error("No CLI"); } }));
vi.mock("node:inspector", () => ({ Session: class { constructor() { throw Error("No inspector"); } } }));
vi.mock("../src/backend/index.js", async original => ({ ...await original<typeof import("../src/backend/index.js")>(), createBackend: () => { throw Error("No backend"); } }));
vi.mock("../src/tmux-manager.js", async original => ({ ...await original<typeof import("../src/tmux-manager.js")>(), TmuxManager: new Proxy({}, { get: () => () => { throw Error("No tmux"); } }) }));
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } }) }));
import { FleetManager } from "../src/fleet-manager.js";
import { handleAuthRequest, type AuthApiContext } from "../src/auth-api.js";
import { handleWebRequest } from "../src/web-api.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { setLocale, t as tr } from "../src/locale.js";
import { SchedulerDb } from "../src/scheduler/db.js";
import { deriveNeedsYou } from "../src/needs-you.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

const LOCAL_HOST = "127.0.0.1:19280", LOCAL_ORIGIN = `http://${LOCAL_HOST}`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const CODE = /[A-Z0-9]{4}-[A-Z0-9]{4}/;
const TOKEN = "c".repeat(48);

let mono = 0;
const rigs: Array<{ dir: string; s: any; db: SchedulerDb }> = [];
async function flush() { for (let n = 0; n < 30; n++) await Promise.resolve(); }

/** A real FleetManager with no fleet: one Telegram bot "owner", General "T0", admin "admin"; a real scheduler database. */
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "agend-task-board-"));
  const fm = new FleetManager(dir), s = fm as any;
  const adapter = { id: "owner", type: "telegram", sendText: vi.fn(async (chat: string, _text: string, opts?: any) => ({ chatId: chat, threadId: opts?.threadId, messageId: "safe" })),
    notifyAlert: vi.fn(async (chat: string, _alert: any, opts?: any) => ({ chatId: chat, threadId: opts?.threadId, messageId: "menu" })),
    sendDirect: vi.fn(async (user: string, _text: string, _opts?: any) => ({ chatId: user, messageId: "dm" })),
    editMessageRemoveButtons: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
  const owner = { id: "owner", type: "telegram", group_id: "G", bot_token_env: "NONE", access: { mode: "open", allowed_users: ["admin"] } };
  // #2425: the board's cards in Needs you are opt-in since 2.3.0-beta.25 — these tests are about them, so asked for.
  fm.fleetConfig = { defaults: {}, needs_you: { task_board: true }, channel: owner, channels: [owner], health_port: 19280, instances: {
    general: { working_directory: dir, general_topic: true, topic_id: "T0", channel_id: "owner" },
  } } as never;
  fm.routing.rebuild(fm.fleetConfig!); s.adapters.set("owner", adapter); s.adapter = adapter;
  s.worlds.set("owner", { adapter, groupId: "G", channelConfig: owner, accessManager: { isAllowed: () => true }, stop: async () => {} });
  s.classicChannels = { isClassicChannel: () => false, hasChannel: () => false, getAll: () => [], getChannelIdByInstance: () => undefined, isCollab: () => false };
  writeFileSync(join(dir, "web.token"), TOKEN, { mode: 0o600 }); s.initializeWebSessions();
  const db = new SchedulerDb(join(dir, "scheduler.db"));
  s.scheduler = { db };

  /** The real /dashboard menu, then "local": the code the owner got by DM. */
  async function dashboardCode(user = "admin"): Promise<string> {
    adapter.notifyAlert.mockClear();
    await s.topicCommands.handleGeneralCommand({ source: "telegram", adapterId: "owner", chatId: "G", threadId: "T0", userId: user, username: user, text: "/dashboard", messageId: "in", timestamp: new Date() });
    const e = [...s.pendingNonceButtons.values()].find((x: any) => x.chatId === "G" && !x.consumed) as any;
    const before = adapter.sendDirect.mock.calls.length;
    await s.dispatchAdapterCallback({ callbackData: `dashboard:${e.nonce}:local`, chatId: e.chatId, threadId: e.threadId, messageId: e.messageId, userId: user, ack: vi.fn() }, "owner", adapter);
    await flush();
    const dm = adapter.sendDirect.mock.calls.slice(before).map(c => String(c[1])).find(text => CODE.test(text));
    if (!dm) throw new Error("no code by DM");
    return CODE.exec(dm)![0];
  }

  /** Sign in as `user` through the real auth handler: the session's cookie and id. */
  async function signIn(user = "admin"): Promise<Who> {
    const code = await dashboardCode(user);
    const headers: Record<string, string> = { host: LOCAL_HOST, "user-agent": UA, origin: LOCAL_ORIGIN, "content-type": "application/json" };
    const req = Object.assign(new EventEmitter(), { method: "POST", url: "/auth/login", headers, destroy: vi.fn() });
    let status = 0; const out: Record<string, any> = {};
    const res = { destroyed: false, headersSent: false, setHeader: (k: string, v: any) => { out[k] = v; }, writeHead: (c: number, h = {}) => { status = c; Object.assign(out, h); }, end: () => {}, destroy: vi.fn() };
    expect(handleAuthRequest(req as never, res as never, new URL("/auth/login", LOCAL_ORIGIN), fm as unknown as AuthApiContext)).toBe(true);
    req.emit("data", Buffer.from(JSON.stringify({ code }))); req.emit("end");
    await flush(); await vi.advanceTimersByTimeAsync(0); await flush();
    expect(status).toBe(200);
    const c = ([] as string[]).concat(out["Set-Cookie"] ?? []).find((x) => /^(__Host-)?agend_session_[0-9a-f]{16}=/.test(x))!.split(";")[0]!;
    return { cookie: c, sessionId: c.split("=")[1]! };
  }

  const h = { dir, fm, s, db, signIn }; rigs.push(h); return h;
}
type Rig = ReturnType<typeof rig>;
type Who = { cookie?: string; sessionId?: string; token?: string };

/** One request through the real web routes, as a page of that session (cookie, same origin, CSRF) or the CLI token. */
async function web(h: Rig, path: string, method: string, who: Who, body?: unknown) {
  const headers: Record<string, string> = { host: LOCAL_HOST, origin: LOCAL_ORIGIN, "user-agent": UA, ...(who.cookie ? { cookie: who.cookie } : {}),
    ...(who.sessionId ? { "x-agend-csrf": csrfTokenFor(who.sessionId) } : {}), ...(who.token ? { "x-agend-token": who.token } : {}),
    ...(method === "POST" ? { "content-type": "application/json" } : {}) };
  const req = Object.assign(new EventEmitter(), { method, url: path, headers, destroy: vi.fn(), socket: { destroy() {}, remoteAddress: "127.0.0.1" } });
  let status = 0, text = "";
  const res = Object.assign(new EventEmitter(), { destroyed: false, headersSent: false, setHeader() {}, writeHead: (c: number) => { status = c; }, end: (t = "") => { text = t; }, write() { return true; }, destroy: vi.fn() });
  expect(handleWebRequest(req as never, res as never, new URL(path, LOCAL_ORIGIN), h.fm as never)).toBe(true);
  if (method === "POST") { req.emit("data", Buffer.from(JSON.stringify(body ?? {}))); req.emit("end"); }
  for (let n = 0; n < 6; n++) { await flush(); await vi.advanceTimersByTimeAsync(0); }
  return { status, json: () => (text ? JSON.parse(text) : null) };
}

beforeEach(() => { setLocale("en"); vi.useFakeTimers(); mono = 0; vi.spyOn(performance, "now").mockImplementation(() => mono); });
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const h of rigs.splice(0)) {
    try { h.s.replyButtonsCtl?.stop(); h.s.replyButtonsStore?.close(); } catch { /* none */ }
    try { h.db.close(); } catch { /* closed */ }
    rmSync(h.dir, { recursive: true, force: true });
  }
});

describe("1. a signed-in person runs a card from opening to confirming", () => {
  it("project, main task, sub task; the instance finishes the sub task; the person confirms the main task", async () => {
    const h = rig();
    const me = await h.signIn("admin");
    const p = await web(h, "/ui/tasks/projects", "POST", me, { name: "Game", description: "the fish game" });
    expect(p.status).toBe(200);
    const projectId = p.json().project.id;
    const m = await web(h, "/ui/tasks/cards", "POST", me, { kind: "main", project: projectId, title: "Build the leaderboard", assignee: "dev-a", acceptance: ["top 100"] });
    expect(m.status).toBe(200);
    expect(m.json().card).toMatchObject({ id: "M-1", kind: "main", projectId, assignee: "dev-a", needsReview: true, status: "open", createdBy: "admin" });
    const s = await web(h, "/ui/tasks/cards", "POST", me, { parent: "M-1", title: "Sort the scores", assignee: "dev-a" });
    expect(s.json().card).toMatchObject({ id: "S-1", parentId: "M-1", projectId });

    // The instance works through its task tool (the same rows, the same rules).
    const dev = { kind: "instance" as const, name: "dev-a" };
    const sub = h.db.board.getCard("S-1");
    h.db.claimTask(sub.uuid, "dev-a", dev);
    h.db.completeTask(sub.uuid, "sorted with a heap", dev);

    const board = (await web(h, "/ui/tasks/board", "GET", me)).json();
    expect(board.projects.map((x: any) => x.name)).toEqual(["Game"]);
    expect(board.stats[String(projectId)]).toMatchObject({ mains: 1, waiting: 1, percent: 100, units: { total: 1, done: 1 } });
    expect(board.cards.find((c: any) => c.id === "M-1")).toMatchObject({ status: "review", progress: { total: 1, done: 1 } });

    const confirm = await web(h, "/ui/tasks/cards/M-1/move", "POST", me, { to: "done", version: h.db.board.getCard("M-1").version });
    expect(confirm.status).toBe(200);
    expect(confirm.json().card.status).toBe("done");
    const detail = (await web(h, "/ui/tasks/cards/m1", "GET", me)).json();
    expect(detail.card.id).toBe("M-1");
    expect(detail.children.map((c: any) => c.id)).toEqual(["S-1"]);
    expect(detail.history.map((e: any) => [e.actor, e.actorKind, e.type]).slice(-1)).toEqual([["admin", "person", "moved"]]);
  });

  it("comments, edits, reorder and search go through the same routes", async () => {
    const h = rig();
    const me = await h.signIn("admin");
    await web(h, "/ui/tasks/cards", "POST", me, { title: "First" });
    await web(h, "/ui/tasks/cards", "POST", me, { title: "Second" });
    expect((await web(h, "/ui/tasks/cards/M-1", "POST", me, { comment: "use the new table", goal: "faster reads", version: 1 })).json().card)
      .toMatchObject({ goal: "faster reads", version: 2, commentCount: 1 });
    expect((await web(h, "/ui/tasks/cards/M-1/reorder", "POST", me, { after: "M-2" })).status).toBe(200);
    expect((await web(h, "/ui/tasks/board", "GET", me)).json().cards.map((c: any) => c.id)).toEqual(["M-2", "M-1"]);
    const found = (await web(h, "/ui/tasks/search?q=new%20table", "GET", me)).json().results;
    expect(found.map((r: any) => [r.card.id, r.match.field])).toEqual([["M-1", "comment"]]);
  });
});

describe("2. the person is a signed-in session only", () => {
  it("the header token cannot write to the board's routes", async () => {
    const h = rig();
    const token = { token: TOKEN };
    expect((await web(h, "/ui/tasks/board", "GET", token)).status).toBe(200);
    const r = await web(h, "/ui/tasks/projects", "POST", token, { name: "Sneaky" });
    expect(r.status).toBe(403);
    expect(r.json()).toEqual({ error: "The task board takes changes from a signed-in dashboard", code: "forbidden", key: "signed_in_only" });
    expect(h.db.board.listProjects()).toEqual([]);
  });

  it("on the old /ui/tasks routes the token is held to an instance's rules: it never confirms work that waits for the person", async () => {
    const h = rig();
    const me = await h.signIn("admin");
    await web(h, "/ui/tasks/cards", "POST", me, { title: "Ship it", assignee: "dev-a" });
    const card = h.db.board.getCard("M-1");
    const token = { token: TOKEN };
    // Not the person, and not its assignee: the token finishes nothing.
    const take = await web(h, `/ui/tasks/${card.uuid}`, "POST", token, { action: "complete", result: "done, trust me" });
    expect(take.status).toBe(400);
    expect(take.json().error).toMatch(/assigned to dev-a/);
    // Its assignee finishes it: it waits for the person.
    const dev = { kind: "instance" as const, name: "dev-a" };
    expect(h.db.completeTask(card.uuid, "shipped", dev).status).toBe("review");
    const r = await web(h, `/ui/tasks/${card.uuid}`, "POST", token, { action: "update", status: "done" });
    expect(r.status).toBe(400);
    expect(r.json().error).toMatch(/waiting for the person's confirmation/);
    expect(h.db.board.getCard("M-1").status).toBe("review");
    // The signed-in person can.
    expect((await web(h, `/ui/tasks/${card.uuid}`, "POST", me, { action: "update", status: "done" })).json().status).toBe("done");
    expect(h.db.board.events(card.uuid).filter((e) => e.type === "moved").map((e) => [e.actor, e.actorKind, e.data.to])).toEqual([
      ["dev-a", "instance", "claimed"], ["dev-a", "instance", "review"], ["admin", "person", "done"],
    ]);
  });

  it("an instance's task list shows its cards waiting for the person, and takes their card numbers", async () => {
    const h = rig();
    const me = await h.signIn("admin");
    await web(h, "/ui/tasks/cards", "POST", me, { title: "Ship it", assignee: "dev-a" });
    const card = h.db.board.getCard("M-1");
    h.db.completeTask(card.uuid, "shipped", { kind: "instance", name: "dev-a" });
    const list = await h.fm.handleTaskCrudHttp("dev-a", { action: "list" }) as Array<{ id: string; status: string }>;
    expect(list.map((t) => [t.id, t.status])).toEqual([[card.uuid, "review"]]);
    // A card on the board reads as text (step 2: the agent's view of a card).
    expect(await h.fm.handleTaskCrudHttp("dev-a", { action: "get", id: "M-1" })).toMatch(/^M-1 main task · Ship it \[waiting for the person\] @dev-a v3\n/);
  });
});

describe("3. refusals", () => {
  it("a stale version is 409 with the board's code; a missing card 404; an unknown field 400", async () => {
    const h = rig();
    const me = await h.signIn("admin");
    await web(h, "/ui/tasks/cards", "POST", me, { title: "One" });
    await web(h, "/ui/tasks/cards/M-1", "POST", me, { goal: "first", version: 1 });
    const stale = await web(h, "/ui/tasks/cards/M-1", "POST", me, { goal: "second", version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.json()).toMatchObject({ code: "conflict" });
    expect(stale.json().error).toMatch(/M-1 changed meanwhile \(you have v1, it is v2, last changed by admin\)/);
    expect((await web(h, "/ui/tasks/cards/M-9", "GET", me)).status).toBe(404);
    expect((await web(h, "/ui/tasks/cards/M-9/move", "POST", me, { to: "done" })).status).toBe(404);
    expect((await web(h, "/ui/tasks/cards", "POST", me, { title: "x", internal: true })).status).toBe(400);
    expect((await web(h, "/ui/tasks/cards/M-1/move", "POST", me, { to: "finished" })).status).toBe(400);
  });
});

/**
 * One request through the real web routes as the temporary public link's page (a gateway session) or a local page, with
 * a minimal context (schedules-1724's pattern): the board's routes only need the scheduler and the fleet's config.
 */
function viaLink(db: SchedulerDb, method: string, path: string, body?: unknown, opts: { local?: boolean; fleetConfig?: unknown; needs?: unknown[] } = {}) {
  const sessions = new WebSessionStore(), exposureId = "a".repeat(32), pub = "https://sample.trycloudflare.com", local = "http://127.0.0.1:19280";
  const s = sessions.create({ tier: "admin", surface: opts.local ? "local" : "gateway", exposureId: opts.local ? undefined : exposureId, label: "t", tokenEpoch: tokenEpoch(TOKEN) } as never);
  const origin = opts.local ? local : pub;
  const headers: Record<string, string> = { host: new URL(origin).host, cookie: `${opts.local ? "" : "__Host-"}agend_session=${s.sessionId}`, origin, "sec-fetch-site": "same-origin",
    "x-agend-csrf": csrfTokenFor(s.sessionId), "content-type": "application/json" };
  return new Promise<{ status: number; body: any }>((resolve) => {
    const req = Object.assign(new EventEmitter(), { method, url: path, headers, destroy: vi.fn() });
    if (!opts.local) bindGatewayRequest(req as never, { surface: "gateway", exposureId, expectedOrigin: pub, isCurrent: () => true });
    let status = 0;
    const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader() {}, writeHead: (c: number) => { status = c; },
      end: (t = "") => resolve({ status, body: t ? JSON.parse(String(t)) : null }) });
    handleWebRequest(req as never, res as never, new URL(path, origin), { webToken: TOKEN, webSessions: sessions, scheduler: { db },
      fleetConfig: opts.fleetConfig ?? { defaults: {}, instances: {} }, logger: { debug() {}, info() {}, warn() {}, error() {} },
      getUiStatus: () => ({ instances: [] }), listWebPrompts: () => [], needsYouItems: () => opts.needs ?? [] } as never);
    if (body !== undefined) { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); } else { req.emit("end"); }
  });
}
function scratchDb(): SchedulerDb {
  const dir = mkdtempSync(join(tmpdir(), "agend-task-board-link-"));
  const db = new SchedulerDb(join(dir, "scheduler.db"));
  rigs.push({ dir, s: {}, db });
  return db;
}
const ANN = { kind: "person" as const, name: "Ann" };

describe("4. the public link reads the board and changes nothing on it", () => {
  it("its manifest: the reads; no write route of the board's own", () => {
    for (const [method, path] of [["GET", "/ui/tasks/board"], ["GET", "/ui/tasks/search"], ["GET", "/ui/tasks/cards/M-3"]] as const) {
      expect(isPublicWebRoute(method, path), `${method} ${path}`).toBe(true);
    }
    for (const [method, path] of [
      ["POST", "/ui/tasks/cards/M-3"], ["POST", "/ui/tasks/cards/M-3/move"], ["POST", "/ui/tasks/cards/S-1/reorder"], ["POST", "/ui/tasks/projects/2"],
      ["DELETE", "/ui/tasks/cards/M-3"], ["GET", "/ui/tasks/cards/M-3/move"],
      ["POST", "/ui/tasks"], ["POST", "/ui/tasks/aaaaaaaa-0000-0000-0000-000000000001"],          // the old list's create and update
    ] as const) expect(isPublicWebRoute(method, path), `${method} ${path}`).toBe(false);
  });

  it("the handlers refuse every board write over the link (403), the old /ui/tasks create and update too", async () => {
    const db = scratchDb();
    db.board.createProject(ANN, { name: "Game" });
    db.board.createCards(ANN, { project: "Game", cards: [{ title: "Ship it", assignee: "dev-a" }] });
    const refused = { error: "task_board_not_over_public_link", code: "forbidden", key: "not_over_public_link" };
    for (const [path, body] of [
      ["/ui/tasks/cards", { title: "x" }], ["/ui/tasks/cards/M-1", { goal: "x" }], ["/ui/tasks/cards/M-1/move", { to: "done" }],
      ["/ui/tasks/cards/M-1/reorder", { after: null }], ["/ui/tasks/projects", { name: "Other" }], ["/ui/tasks/projects/1", { archived: true }],
      ["/ui/tasks", { title: "x" }], [`/ui/tasks/${db.board.getCard("M-1").uuid}`, { action: "update", title: "x" }],
    ] as const) expect(await viaLink(db, "POST", path, body), path).toEqual({ status: 403, body: refused });
    expect(db.board.boardCards().map((c) => c.code)).toEqual(["M-1"]);
    expect(db.board.getCard("M-1")).toMatchObject({ status: "open", goal: "", version: 1 });
    expect(db.board.listProjects(true).map((p) => [p.name, p.archived])).toEqual([["Game", false]]);
    const read = await viaLink(db, "GET", "/ui/tasks/board");
    expect([read.status, read.body.cards.map((c: any) => c.id)]).toEqual([200, ["M-1"]]);
  });

  it("the old /ui/tasks routes: refused over the link, the person's on the local page; a malformed id is a 400", async () => {
    const db = scratchDb();
    const card = db.board.createCards(ANN, { cards: [{ title: "Ship it", assignee: "dev-a" }] }).cards[0]!;
    db.claimTask(card.uuid, "dev-a", { kind: "instance", name: "dev-a" });
    db.completeTask(card.uuid, "shipped", { kind: "instance", name: "dev-a" });
    expect((await viaLink(db, "POST", `/ui/tasks/${card.uuid}`, { action: "update", status: "done" })).status).toBe(403);
    expect(db.board.getCard("M-1").status).toBe("review");
    expect((await viaLink(db, "POST", `/ui/tasks/${card.uuid}`, { action: "update", status: "done" }, { local: true })).body.status).toBe("done");
    expect((await viaLink(db, "POST", "/ui/tasks", { title: "From the page" }, { local: true })).status).toBe(200);
    expect((await viaLink(db, "POST", "/ui/tasks/%E0%A4%A", { action: "update", status: "done" }, { local: true })).status).toBe(400);
  });

  it("cards of instances kept out of sight (cross_instance_visibility: hidden) are left out over the link; the local page shows them", async () => {
    const db = scratchDb();
    db.board.createCards(ANN, { cards: [{ title: "Open work", assignee: "dev-a" }, { title: "Secret work", assignee: "spy" },
      { title: "Handed out by the spy", assignee: "dev-a", dispatcher: { kind: "instance", name: "spy" } }] });
    const fleetConfig = { defaults: {}, instances: { "dev-a": {}, spy: { cross_instance_visibility: "hidden" } } };
    expect((await viaLink(db, "GET", "/ui/tasks/board", undefined, { fleetConfig })).body.cards.map((c: any) => c.id)).toEqual(["M-1"]);
    expect((await viaLink(db, "GET", "/ui/tasks/cards/M-2", undefined, { fleetConfig })).status).toBe(404);
    expect((await viaLink(db, "GET", "/ui/tasks/search?q=work", undefined, { fleetConfig })).body.results.map((r: any) => r.card.id)).toEqual(["M-1"]);
    expect((await viaLink(db, "GET", "/ui/tasks/board", undefined, { fleetConfig, local: true })).body.cards.map((c: any) => c.id)).toEqual(["M-1", "M-2", "M-3"]);
  });

  // #2303 review: what a visible card shows of the cards around it follows the same rule — its children, its main
  // task, a search hit's main task title — and what an instance kept out of sight wrote on it.
  it("over the link a visible card does not show hidden related cards (children, main task, a hit's main task) or a hidden instance's words", async () => {
    const db = scratchDb();
    const fleetConfig = { defaults: {}, instances: { "dev-a": {}, spy: { cross_instance_visibility: "hidden" } } };
    db.board.createCards(ANN, { cards: [{ title: "Open work", assignee: "dev-a" }, { title: "Secret plan", assignee: "dev-a", dispatcher: { kind: "instance", name: "spy" } }] });
    db.board.createCards(ANN, { parent: "M-1", cards: [{ title: "Open step", assignee: "dev-a" }, { title: "Secret step", assignee: "spy" }] });
    db.board.createCards(ANN, { parent: "M-2", cards: [{ title: "Step under the secret plan", assignee: "dev-a", dispatcher: null }] });
    db.board.updateCard({ kind: "instance", name: "spy" }, "M-1", { comment: "spy was here" });
    db.board.updateCard(ANN, "M-1", { comment: "Ann's note" });
    db.board.updateCard(ANN, "M-1", { log: "Ann's log line" });
    db.board.updateCard({ kind: "instance", name: "spy" }, "M-1", { log: "spy's log line" });
    db.board.updateCard(ANN, "S-1", { dispatcher: { kind: "instance", name: "dev-a" } });
    db.board.updateCard(ANN, "S-1", { dispatcher: null });               // its history names only visible ones
    db.board.createCards(ANN, { parent: "M-1", cards: [{ title: "Visible step, handed back", assignee: "dev-a" }] });
    db.board.updateCard(ANN, "S-4", { dispatcher: { kind: "instance", name: "spy" } });
    db.board.updateCard(ANN, "S-4", { dispatcher: null });               // hidden in its history, not on the card
    const link = (path: string) => viaLink(db, "GET", path, undefined, { fleetConfig });
    const local = (path: string) => viaLink(db, "GET", path, undefined, { fleetConfig, local: true });
    const m1 = (await link("/ui/tasks/cards/M-1")).body;
    expect(m1.children.map((c: any) => c.id)).toEqual(["S-1", "S-4"]);
    expect(m1.comments.map((c: any) => c.author)).toEqual(["Ann"]);
    expect(m1.logs.map((c: any) => c.author)).toEqual(["Ann"]);
    expect(JSON.stringify(m1)).not.toMatch(/spy|Secret/);
    const s1 = (await link("/ui/tasks/cards/S-1")).body;
    expect(s1.history.filter((e: any) => e.type === "updated")).toHaveLength(2);
    const s4 = (await link("/ui/tasks/cards/S-4")).body;
    expect(JSON.stringify(s4.history)).not.toMatch(/spy/);
    expect(JSON.stringify((await local("/ui/tasks/cards/S-4")).body.history)).toMatch(/spy/);
    const s3 = (await link("/ui/tasks/cards/S-3")).body;
    expect(s3.parent).toBeNull();
    expect(JSON.stringify(s3)).not.toMatch(/spy|Secret plan/);
    const hits = (await link("/ui/tasks/search?q=step")).body.results;
    expect(hits.map((r: any) => [r.card.id, r.parentTitle])).toEqual(expect.arrayContaining([["S-1", "Open work"], ["S-3", null]]));
    expect(hits.map((r: any) => r.card.id)).not.toContain("S-2");
    // The local page shows it all.
    const all = (await local("/ui/tasks/cards/M-1")).body;
    expect([all.children.map((c: any) => c.id), all.comments.map((c: any) => c.author), all.logs.map((c: any) => c.author)]).toEqual([["S-1", "S-2", "S-4"], ["spy", "Ann"], ["Ann", "spy"]]);
    expect((await local("/ui/tasks/cards/S-3")).body.parent.title).toBe("Secret plan");
    expect((await local("/ui/tasks/search?q=step")).body.results.find((r: any) => r.card.id === "S-3").parentTitle).toBe("Secret plan");
  });
});

// #2304 review (Fable): a hidden instance's words on a visible card are not found by search, and do not count in the
// board's comment count or name its last comment — over the link; the local page is unchanged.
describe("4a. a hidden instance's comments on a visible card, over the link", () => {
  it("search does not find them; the board's commentCount, newCommentCount and lastComment leave them out", async () => {
    const db = scratchDb();
    const fleetConfig = { defaults: {}, instances: { "dev-a": {}, spy: { cross_instance_visibility: "hidden" } } };
    db.board.createCards(ANN, { cards: [{ title: "Open work", assignee: "dev-a" }, { title: "Other work", assignee: "dev-a" }] });
    db.board.updateCard(ANN, "M-1", { comment: "Ann's note" });
    db.board.updateCard({ kind: "instance", name: "spy" }, "M-1", { comment: "the vault code is 4711" });
    db.board.updateCard({ kind: "instance", name: "spy" }, "M-2", { comment: "only the spy spoke here" });
    db.board.updateCard({ kind: "instance", name: "spy" }, "M-1", { log: "vault log line" });
    const link = (path: string) => viaLink(db, "GET", path, undefined, { fleetConfig });
    const local = (path: string) => viaLink(db, "GET", path, undefined, { fleetConfig, local: true });
    expect((await link("/ui/tasks/search?q=vault")).body.results).toEqual([]);
    expect((await local("/ui/tasks/search?q=vault")).body.results.map((r: any) => [r.card.id, r.match.field])).toEqual([["M-1", "log"]]);
    const works = (await link("/ui/tasks/search?q=work")).body.results;
    expect(works.map((r: any) => r.card.id).sort()).toEqual(["M-1", "M-2"]);
    expect(works.map((r: any) => [r.card.id, r.card.commentCount, r.card.lastComment?.author ?? null]).sort()).toEqual([["M-1", 1, "Ann"], ["M-2", 0, null]]);
    // Found by a visible comment, the match quotes it — never a hidden instance's newer one.
    db.board.updateCard(ANN, "M-2", { comment: "rollout on Monday" });
    db.board.updateCard({ kind: "instance", name: "spy" }, "M-2", { comment: "rollout secret: skip the checks" });
    expect((await link("/ui/tasks/search?q=rollout")).body.results.map((r: any) => r.match.text)).toEqual(["rollout on Monday"]);
    expect((await local("/ui/tasks/search?q=rollout")).body.results.map((r: any) => r.match.text)).toEqual(["rollout secret: skip the checks"]);
    const pick = (body: any, id: string) => body.cards.find((c: any) => c.id === id);
    const [b, l] = [(await link("/ui/tasks/board")).body, (await local("/ui/tasks/board")).body];
    expect([pick(b, "M-1").commentCount, pick(b, "M-1").newCommentCount, pick(b, "M-1").lastComment?.author]).toEqual([1, 1, "Ann"]);
    expect([pick(b, "M-2").commentCount, pick(b, "M-2").newCommentCount, pick(b, "M-2").lastComment?.author]).toEqual([1, 1, "Ann"]);
    expect([pick(l, "M-1").commentCount, pick(l, "M-1").newCommentCount, pick(l, "M-1").lastComment?.author]).toEqual([2, 2, "spy"]);
    expect(JSON.stringify(b)).not.toMatch(/spy|vault/);
    // The card's own read and its sub tasks' views follow the same rule.
    db.board.createCards(ANN, { parent: "M-2", cards: [{ title: "A step", assignee: "dev-a" }] });
    db.board.updateCard({ kind: "instance", name: "spy" }, "S-1", { comment: "spy on the step" });
    const d = (await link("/ui/tasks/cards/M-2")).body;
    expect([d.card.commentCount, d.card.lastComment?.author, d.children[0].commentCount, d.children[0].lastComment]).toEqual([1, "Ann", 0, null]);
    expect(JSON.stringify(d)).not.toMatch(/spy/);
    expect((await local("/ui/tasks/cards/M-2")).body.children[0].lastComment.author).toBe("spy");
  });
});

describe("4d. Needs you over the public link leaves out the cards the board hides there (#2306 review)", () => {
  // #2425: a blocked card an instance handed out is that instance's to decide, never the person's Needs you — so the
  // hidden lead's card waits for the person's confirmation instead (review), which is still the person's.
  it("a card a hidden instance handed out, waiting for the person: not in the link's poll (title and all), while the local page lists it; a visible one is in both", async () => {
    const h = rig();
    h.fm.fleetConfig = { ...h.fm.fleetConfig, instances: { ...(h.fm.fleetConfig as any).instances, "dev-a": {}, secret_lead: { cross_instance_visibility: "hidden" } } } as never;
    const fleetConfig = h.fm.fleetConfig;
    const lead = { kind: "instance" as const, name: "secret_lead" };
    h.db.board.createCards(lead, { cards: [{ title: "HIDDEN_CARD_TITLE", assignee: "dev-a" }] });                // M-1, by the hidden lead
    h.db.board.createCards(ANN, { cards: [{ title: "Open title", assignee: "dev-a" }] });                        // M-2
    h.db.board.createCards(lead, { cards: [{ title: "HIDDEN_BLOCKED_TITLE", assignee: "dev-a" }] });             // M-3, by the hidden lead
    h.db.board.moveCard(ANN, "M-1", "claimed"); h.db.board.moveCard(ANN, "M-1", "review");
    h.db.board.moveCard(ANN, "M-2", "claimed"); h.db.board.moveCard(ANN, "M-2", "blocked", { reason: "which season?" });
    h.db.board.moveCard(ANN, "M-3", "claimed"); h.db.board.moveCard(ANN, "M-3", "blocked", { reason: "PRIVATE_BLOCKED_REASON" });
    const needs = deriveNeedsYou({ prompts: [], instances: [], deliveries: [], ownerOf: () => undefined, tasks: h.s.needsYouTasks() });
    expect(needs.map((i) => i.card?.code).sort()).toEqual(["M-1", "M-2"]);                                     // M-3: the lead's to decide
    const link = (await viaLink(h.db, "GET", "/ui/poll", undefined, { fleetConfig, needs })).body;
    expect(link.needs.map((i: any) => i.card?.code)).toEqual(["M-2"]);
    expect(JSON.stringify(link)).not.toMatch(/HIDDEN_CARD_TITLE|HIDDEN_BLOCKED_TITLE|PRIVATE_BLOCKED_REASON/);
    const local = (await viaLink(h.db, "GET", "/ui/poll", undefined, { fleetConfig, needs, local: true })).body;
    expect(local.needs.map((i: any) => i.card?.code).sort()).toEqual(["M-1", "M-2"]);
    // The board says the same over the link, and the link's page has no stream for Needs you to leak through.
    expect((await viaLink(h.db, "GET", "/ui/tasks/board", undefined, { fleetConfig })).body.cards.map((c: any) => c.id)).toEqual(["M-2"]);
    expect((await viaLink(h.db, "GET", "/ui/events", undefined, { fleetConfig })).status).toBe(404);
    // Visibility is read when asked: the lead shown again, its card is listed again.
    (fleetConfig as any).instances.secret_lead = {};
    expect((await viaLink(h.db, "GET", "/ui/poll", undefined, { fleetConfig, needs })).body.needs.map((i: any) => i.card?.code).sort()).toEqual(["M-1", "M-2"]);
  });
});

describe("4c. who works on what: each instance's `task mine`, by /ui/tasks/work", () => {
  const ids = (w: any) => Object.fromEntries(["doing", "blocked", "review", "ready", "waiting", "mains"].map((k) => [k, w[k].map((c: any) => c.id)]).concat([["sentBack", w.sentBack], ["newComments", w.newComments]]));
  it("the fleet's instances, then anyone else holding a live card, each with its cards as task mine sorts them; one by ?instance=", async () => {
    const db = scratchDb();
    const dev = { kind: "instance" as const, name: "dev-a" };
    db.board.createCards(ANN, { cards: [{ title: "Leaderboard", assignee: "lead" }] });                       // M-1
    db.board.createCards(ANN, { parent: "M-1", cards: [{ title: "API", assignee: "dev-a" }, { title: "Page", assignee: "dev-a", dependsOn: ["S-1"] }, { title: "Review" }] });
    db.board.createCards(ANN, { cards: [{ title: "Rewards", assignee: "dev-a" }, { title: "Tuning", assignee: "Ann" }] });   // M-2, M-3
    db.board.moveCard(dev, "S-1", "claimed");
    db.board.moveCard(ANN, "M-2", "claimed"); db.board.moveCard(ANN, "M-2", "review", { result: "POST /rewards" });
    db.board.updateCard(ANN, "S-1", { comment: "cache it" });
    const fleetConfig = { defaults: {}, instances: { "dev-a": {}, lead: {}, idle: {} } };
    const { status, body } = await viaLink(db, "GET", "/ui/tasks/work", undefined, { local: true, fleetConfig });
    expect(status).toBe(200);
    expect(body.instances.map((i: any) => i.name)).toEqual(["dev-a", "lead", "idle", "Ann"]);
    const of = (n: string) => body.instances.find((i: any) => i.name === n);
    expect(ids(of("dev-a"))).toEqual({ doing: ["S-1"], blocked: [], review: ["M-2"], ready: [], waiting: ["S-2"], mains: [], sentBack: [], newComments: ["S-1"] });
    expect(of("dev-a").waiting[0].unmetDeps).toEqual(["S-1"]);
    expect(ids(of("lead"))).toMatchObject({ mains: ["M-1"], ready: ["S-3"] });                             // nobody's sub task of its main task
    expect(of("lead").mains[0].progress).toMatchObject({ total: 3, claimed: 1, open: 2 });
    expect(ids(of("idle"))).toEqual({ doing: [], blocked: [], review: [], ready: [], waiting: [], mains: [], sentBack: [], newComments: [] });
    expect(ids(of("Ann"))).toMatchObject({ ready: ["M-3"] });
    const one = await viaLink(db, "GET", "/ui/tasks/work?instance=lead", undefined, { local: true, fleetConfig });
    expect(one.body.instances.map((i: any) => i.name)).toEqual(["lead"]);
  });

  it("over the public link, an instance kept out of sight is not listed, nor a card that names one; the local page has both", async () => {
    const db = scratchDb();
    db.board.createCards(ANN, { cards: [{ title: "Open work", assignee: "dev-a" }, { title: "Secret work", assignee: "spy" },
      { title: "Handed out by the spy", assignee: "dev-a", dispatcher: { kind: "instance", name: "spy" } }] });
    const fleetConfig = { defaults: {}, instances: { "dev-a": {}, spy: { cross_instance_visibility: "hidden" } } };
    const link = (await viaLink(db, "GET", "/ui/tasks/work", undefined, { fleetConfig })).body;
    expect(link.instances.map((i: any) => [i.name, i.ready.map((c: any) => c.id)])).toEqual([["dev-a", ["M-1"]]]);
    expect((await viaLink(db, "GET", "/ui/tasks/work?instance=spy", undefined, { fleetConfig })).body.instances).toEqual([]);
    const local = (await viaLink(db, "GET", "/ui/tasks/work", undefined, { fleetConfig, local: true })).body;
    expect(local.instances.map((i: any) => [i.name, i.ready.map((c: any) => c.id)])).toEqual([["dev-a", ["M-1", "M-3"]], ["spy", ["M-2"]]]);
    expect(isPublicWebRoute("GET", "/ui/tasks/work")).toBe(true);
    expect(isPublicWebRoute("POST", "/ui/tasks/work")).toBe(false);
  });
});

describe("4b. who handed a card out, from the dashboard", () => {
  it("an instance, the person writing, or nobody; anything else is a 400", async () => {
    const db = scratchDb();
    db.board.createCards(ANN, { cards: [{ title: "Work", assignee: "dev-a" }] });
    const set = (dispatcher: unknown) => viaLink(db, "POST", "/ui/tasks/cards/M-1", { dispatcher }, { local: true });
    expect((await set({ kind: "instance", name: "lead" })).body.card.dispatcher).toEqual({ kind: "instance", name: "lead" });
    const me = (await set({ kind: "person" })).body.card.dispatcher;
    expect(me.kind).toBe("person");
    expect((await set(null)).body.card.dispatcher).toBeNull();
    expect((await set("lead")).status).toBe(400);
    expect((await set({ kind: "person", name: "Somebody else" })).status).toBe(400);
  });
});

describe("5. revisions, refusals and notes the page can say in its language", () => {
  it("a page with the current revision is told so; a write moves it", async () => {
    const db = scratchDb();
    const first = await viaLink(db, "GET", "/ui/tasks/board", undefined, { local: true });
    expect(first.body.rev).toBe(0);
    expect((await viaLink(db, "GET", "/ui/tasks/board?rev=0", undefined, { local: true })).body).toEqual({ rev: 0, unchanged: true });
    db.board.createCards(ANN, { cards: [{ title: "New" }] });
    const after = await viaLink(db, "GET", "/ui/tasks/board?rev=0", undefined, { local: true });
    expect([after.body.rev, after.body.cards.map((c: any) => c.id)]).toEqual([1, ["M-1"]]);
  });

  // #2296: every open Tasks tab reads the board after each change — on the dashboard one build per revision serves them all.
  it("the dashboard's board read is built once per revision (and done=all, and minute); a write, done=all or the next minute build it again", async () => {
    const db = scratchDb();
    db.board.createCards(ANN, { cards: [{ title: "One" }] });
    const views = vi.spyOn(db.board, "views");
    const a = await viaLink(db, "GET", "/ui/tasks/board", undefined, { local: true });
    const b = await viaLink(db, "GET", "/ui/tasks/board", undefined, { local: true });
    expect(views).toHaveBeenCalledTimes(1);
    expect(b.body).toEqual(a.body);
    expect(a.body.cards.map((c: any) => c.id)).toEqual(["M-1"]);
    await viaLink(db, "GET", "/ui/tasks/board?done=all", undefined, { local: true });
    expect(views, "done=all is a board of its own").toHaveBeenCalledTimes(2);
    db.board.createCards(ANN, { cards: [{ title: "Two" }] });
    const c = await viaLink(db, "GET", "/ui/tasks/board", undefined, { local: true });
    expect(views, "a write moved the revision").toHaveBeenCalledTimes(3);
    expect([c.body.rev, c.body.cards.map((x: any) => x.id)]).toEqual([2, ["M-1", "M-2"]]);
    vi.setSystemTime(Date.now() + 61_000);
    await viaLink(db, "GET", "/ui/tasks/board", undefined, { local: true });
    expect(views, "the next minute (the 14-day window moves)").toHaveBeenCalledTimes(4);
  });

  it("over the public link the board is built for each read — it is filtered per request (instances kept out of sight)", async () => {
    const db = scratchDb();
    const fleetConfig = { defaults: {}, instances: { quiet: { cross_instance_visibility: "hidden" } } };
    db.board.createCards(ANN, { cards: [{ title: "Seen" }, { title: "Quiet's", assignee: "quiet" }] });
    const local = await viaLink(db, "GET", "/ui/tasks/board", undefined, { local: true, fleetConfig });
    expect(local.body.cards.map((c: any) => c.title).sort()).toEqual(["Quiet's", "Seen"]);
    const views = vi.spyOn(db.board, "views");
    const l1 = await viaLink(db, "GET", "/ui/tasks/board", undefined, { fleetConfig });
    const l2 = await viaLink(db, "GET", "/ui/tasks/board", undefined, { fleetConfig });
    expect(views).toHaveBeenCalledTimes(2);
    for (const r of [l1, l2]) expect(r.body.cards.map((c: any) => c.title)).toEqual(["Seen"]);
    const again = await viaLink(db, "GET", "/ui/tasks/board", undefined, { local: true, fleetConfig });
    expect(again.body.cards.map((c: any) => c.title).sort(), "the dashboard still sees every card").toEqual(["Quiet's", "Seen"]);
  });

  it("a refusal names its key and values; a malformed card address is a 400; the old route takes only real statuses", async () => {
    const db = scratchDb();
    db.board.createProject(ANN, { name: "Game" });
    const taken = await viaLink(db, "POST", "/ui/tasks/projects", { name: "game" }, { local: true });
    expect([taken.status, taken.body.key, taken.body.args]).toEqual([400, "project_name_taken", ["game"]]);
    expect((await viaLink(db, "GET", "/ui/tasks/cards/%E0%A4%A", undefined, { local: true })).status).toBe(400);
    const t = db.createTask({ title: "Plain", created_by: "x" });
    expect((await viaLink(db, "POST", `/ui/tasks/${t.id}`, { action: "update", status: "finished" }, { local: true })).status).toBe(400);
  });

  it("a write's notes come as keys and values (every sub task done: the main task waits for you)", async () => {
    const db = scratchDb();
    db.board.createCards(ANN, { cards: [{ title: "Leaderboard" }, { parent: "#1", title: "API" }] });
    const r = await viaLink(db, "POST", "/ui/tasks/cards/S-1/move", { to: "done" }, { local: true });
    expect(r.body.notes).toEqual([{ text: 'M-1 "Leaderboard": every sub task is done; it is waiting for the person\'s confirmation', key: "review_waiting", args: ["M-1", "Leaderboard"] }]);
  });
});

describe("6. the agent learns why its work came back", () => {
  it("sent back with a reason: the tool's get, mine and its next write all carry the reason", async () => {
    const h = rig();
    const me = await h.signIn("admin");
    await web(h, "/ui/tasks/cards", "POST", me, { title: "Ship it", assignee: "dev-a" });
    const card = h.db.board.getCard("M-1");
    const tool = (args: Record<string, unknown>) => h.fm.handleTaskCrudHttp("dev-a", args);
    expect(await tool({ action: "claim", id: "M-1" })).toMatchObject({ status: "claimed" });
    expect(await tool({ action: "done", id: "M-1", result: "shipped" })).toMatchObject({ status: "review" });
    await web(h, "/ui/tasks/cards/M-1/move", "POST", me, { to: "claimed", reason: "the changelog entry is missing", version: h.db.board.getCard("M-1").version });
    expect(await tool({ action: "get", id: "M-1" })).toMatch(/comments \(1 new\):\n admin .* \(sent back\) \[new\]: the changelog entry is missing/);
    expect(await tool({ action: "mine" })).toContain("sent back to you:\n M-1 Ship it — admin: the changelog entry is missing");
    // Its next write on the card hands the reason over with the answer, and then it has seen it.
    const next = await tool({ action: "update", id: card.uuid, result: "added the changelog entry" }) as { status: string; notes?: string[] };
    expect(next).toMatchObject({ status: "claimed", notes: ["sent back (admin): the changelog entry is missing"] });
    expect((await tool({ action: "update", id: card.uuid, priority: "high" }) as { notes?: string[] }).notes).toBeUndefined();
  });
});

describe("7. a reply to a Needs you prompt is the card's words, not an instance's input (step 3)", () => {
  it("the admin's reply to the prompt stops there; any other message in the topic flows on to the instance", async () => {
    const h = rig();
    const replies: Array<{ replyTo?: string; userId: string; text: string }> = [];
    h.s.needsYou = { handleReply: vi.fn((m: { replyTo?: string; userId: string; text: string }) => { replies.push(m); return m.replyTo === "prompt-1"; }), wasTakenReply: () => false, poke() {}, stop: async () => {} };
    const routed: string[] = [];
    h.s.topicCommands.handleInstanceCommand = vi.fn(async (msg: { text: string }) => { routed.push(msg.text); return true; });
    const say = (over: Record<string, unknown>) => h.s.handleInboundMessage({ source: "telegram", adapterId: "owner", chatId: "G", threadId: "T0", messageId: `in-${Math.random()}`,
      userId: "admin", username: "admin", text: "x", timestamp: new Date(), ...over });
    await say({ replyTo: "prompt-1", text: "ties share a rank" });
    await say({ replyTo: "some-other-message", text: "just chatting" });
    await say({ text: "no reply at all" });
    expect(replies.map((r) => [r.replyTo, r.text])).toEqual([["prompt-1", "ties share a rank"], ["some-other-message", "just chatting"]]);
    expect(routed).toEqual(["just chatting", "no reply at all"]);
  });
});

describe("7b. two bots in one group: the prompt's answer is taken once, whichever bot's copy comes first (#2306 review)", () => {
  /** A second bot "sibling" in the same group: each bot gets its own copy of every message (the same message id). */
  function twoBots() {
    const h = rig();
    const sibling = { id: "sibling", type: "telegram", sendText: vi.fn(async () => ({ messageId: "x" })), stop: vi.fn(async () => {}) };
    const cfg = { id: "sibling", type: "telegram", group_id: "G", bot_token_env: "NONE", access: { mode: "open", allowed_users: ["admin"] } };
    (h.fm.fleetConfig as any).channels.push(cfg);
    h.s.adapters.set("sibling", sibling);
    h.s.worlds.set("sibling", { adapter: sibling, groupId: "G", channelConfig: cfg, accessManager: { isAllowed: () => true }, stop: async () => {} });
    // The hub's side (needs-you-tasks-2306 tests it): the prompt "prompt-1" waits for one answer, wherever it arrives.
    let open = true;
    const taken: string[] = [];
    const takenIds = new Set<string>();
    h.s.needsYou = { handleReply: vi.fn((m: { replyTo?: string; adapterId: string; text: string; chatId: string; messageId: string }) => {
      if (m.replyTo !== "prompt-1" || !open) return false;
      open = false; takenIds.add(`${m.chatId}|${m.messageId}`); taken.push(`${m.adapterId}: ${m.text}`); return true;
    }), wasTakenReply: (chatId: string, messageId: string) => takenIds.has(`${chatId}|${messageId}`), poke() {}, stop: async () => {} };
    const routed: string[] = [];
    h.s.topicCommands.handleInstanceCommand = vi.fn(async (msg: { text: string; adapterId: string }) => { routed.push(`${msg.adapterId}: ${msg.text}`); return true; });
    const copy = (adapterId: string, over: Record<string, unknown> = {}) => h.s.handleInboundMessage({ source: "telegram", adapterId, chatId: "G", threadId: "T0", messageId: "in-1",
      userId: "admin", username: "admin", replyTo: "prompt-1", text: "ties share a rank", timestamp: new Date(), ...over });
    return { copy, taken, routed };
  }

  it("the owner's copy first: one answer, nothing to the instance; the sibling's copy is a duplicate", async () => {
    const b = twoBots();
    await b.copy("owner"); await b.copy("sibling");
    expect([b.taken, b.routed]).toEqual([["owner: ties share a rank"], []]);
  });

  it("the sibling's copy first: still one answer and nothing to the instance — the owner's copy no longer slips through as input", async () => {
    const b = twoBots();
    await b.copy("sibling"); await b.copy("owner");
    expect([b.taken, b.routed]).toEqual([["sibling: ties share a rank"], []]);
  });

  it("control: a reply that is not the answer goes to the instance once, from whichever copy came first", async () => {
    const b = twoBots();
    await b.copy("sibling", { replyTo: "another-message", text: "just chatting" }); await b.copy("owner", { replyTo: "another-message", text: "just chatting" });
    expect([b.taken, b.routed.length]).toEqual([[], 1]);
  });
});

describe("#2352 a project's lead instance, and where a waiting card's buttons go", () => {
  /** The rig's fleet plus `lead` and `disp` (each with a topic of its own), `notopic` (none) and `dev-a`, on the rig's world. */
  function withLeads(h: Rig) {
    const at = (topic?: string) => ({ working_directory: h.dir, channel_id: "owner", ...(topic ? { topic_id: topic } : {}) });
    (h.fm.fleetConfig as any).instances = { ...(h.fm.fleetConfig as any).instances, lead: at("T5"), disp: at("T6"), notopic: at(), "dev-a": at("T7") };
    h.fm.routing.rebuild(h.fm.fleetConfig!);
  }
  const lanes = (h: Rig) => Object.fromEntries((h.s.needsYouTasks() as Array<{ code: string; lane?: string }>).map((i) => [i.code, i.lane ?? null]));

  it("set on a project by the person: an instance of the fleet, or none; anything else is refused and nothing changes", async () => {
    const h = rig(); withLeads(h);
    const me = await h.signIn("admin");
    const made = await web(h, "/ui/tasks/projects", "POST", me, { name: "Game", leadInstance: "lead" });
    expect([made.status, made.json().project.leadInstance]).toEqual([200, "lead"]);
    const id = made.json().project.id;
    const bad = await web(h, `/ui/tasks/projects/${id}`, "POST", me, { leadInstance: "nobody" });
    expect([bad.status, bad.json().code, bad.json().key]).toEqual([400, "invalid", "lead_not_instance"]);
    expect(h.db.board.getProject(id).leadInstance).toBe("lead");
    expect((await web(h, "/ui/tasks/projects", "POST", me, { name: "Other", leadInstance: "ghost" })).status).toBe(400);
    expect(h.db.board.listProjects(true).map((p) => p.name)).toEqual(["Game"]);
    const cleared = await web(h, `/ui/tasks/projects/${id}`, "POST", me, { leadInstance: null });
    expect([cleared.status, cleared.json().project.leadInstance]).toEqual([200, null]);
    expect((await web(h, `/ui/tasks/projects/${id}`, "POST", me, { leadInstance: "" })).json().project.leadInstance).toBe(null);
    // An instance cannot set it (the board takes project changes from the person only).
    expect(() => h.db.board.updateProject({ kind: "instance", name: "dev-a" }, id, { leadInstance: "lead" })).toThrow();
  });

  it("a waiting card's lane: the instance that handed it out, else its project's lead (sub tasks by their main), else none", () => {
    const h = rig(); withLeads(h);
    const ann = { kind: "person" as const, name: "Ann" }, dev = { kind: "instance" as const, name: "dev-a" };
    const led = h.db.board.createProject(ann, { name: "Led", leadInstance: "lead" });
    const plain = h.db.board.createProject(ann, { name: "Plain" });
    const noTopic = h.db.board.createProject(ann, { name: "NoTopic", leadInstance: "notopic" });
    const gone = h.db.board.createProject(ann, { name: "Gone", leadInstance: "removed-later" });
    h.db.board.createCards(ann, { project: led.id, cards: [{ title: "Led main", assignee: "dev-a" }] });                       // M-1
    h.db.board.createCards(ann, { parent: "M-1", cards: [{ title: "Led sub", assignee: "dev-a" }] });                           // S-1
    h.db.board.createCards({ kind: "instance", name: "disp" }, { project: led.id, cards: [{ title: "Handed out", assignee: "dev-a" }] });   // M-2
    h.db.board.createCards(ann, { project: plain.id, cards: [{ title: "Plain", assignee: "dev-a" }] });                         // M-3
    h.db.board.createCards(ann, { project: noTopic.id, cards: [{ title: "No topic", assignee: "dev-a" }] });                    // M-4
    h.db.board.createCards(ann, { project: gone.id, cards: [{ title: "Gone lead", assignee: "dev-a" }] });                     // M-5
    h.db.board.createCards({ kind: "instance", name: "notopic" }, { project: led.id, cards: [{ title: "Dispatcher w/o topic", assignee: "dev-a" }] }); // M-6
    // #2425: a blocked card waits for the person only when the person handed it out (S-1, by its main's Ann); the main
    // cards wait for the person's confirmation (review), whoever handed them out — each in its lane.
    h.db.board.moveCard(dev, "S-1", "claimed"); h.db.board.moveCard(dev, "S-1", "blocked", { reason: "?" });
    for (const code of ["M-2", "M-3", "M-4", "M-5", "M-6"]) { h.db.board.moveCard(dev, code, "claimed"); h.db.board.moveCard(ann, code, "review"); }
    expect(lanes(h)).toEqual({ "S-1": "lead", "M-2": "disp", "M-3": null, "M-4": null, "M-5": null, "M-6": null });
    // The world goes: no lane can be used there.
    h.s.worlds.delete("owner");
    expect(Object.values(lanes(h)).every((l) => l === null)).toBe(true);
  });

  it("a board from before the lead: the column is added in place, every project reads as having none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-lead-migrate-"));
    const Database = (await import("better-sqlite3")).default;
    const old = new Database(join(dir, "scheduler.db"));
    old.exec("CREATE TABLE task_projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, description TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0, sort REAL NOT NULL, created_at TEXT NOT NULL)");
    old.prepare("INSERT INTO task_projects (name, sort, created_at) VALUES ('Old', 1, '2026-10-01T00:00:00Z')").run();
    old.close();
    const db = new SchedulerDb(join(dir, "scheduler.db"));
    rigs.push({ dir, s: {}, db } as never);
    expect(db.board.listProjects(true).map((p) => [p.name, p.leadInstance])).toEqual([["Old", null]]);
    expect(db.board.updateProject(ANN, db.board.getProject("Old").id, { leadInstance: " lead " }).leadInstance).toBe("lead");
    expect(() => db.board.updateProject(ANN, db.board.getProject("Old").id, { leadInstance: "two words" })).toThrow(/instance's name/);
    const again = new SchedulerDb(join(dir, "scheduler.db"));                                                  // a second open: no duplicate column
    try { expect(again.board.getProject("Old").leadInstance).toBe("lead"); } finally { again.close(); }
  });

  it("over the public link a hidden lead is not named", async () => {
    const db = scratchDb();
    db.board.createProject(ANN, { name: "Secret", leadInstance: "spy" });
    db.board.createProject(ANN, { name: "Open", leadInstance: "dev-a" });
    const fleetConfig = { defaults: {}, instances: { "dev-a": {}, spy: { cross_instance_visibility: "hidden" } } };
    const link = (await viaLink(db, "GET", "/ui/tasks/board", undefined, { fleetConfig })).body;
    expect(link.projects.map((p: any) => [p.name, p.leadInstance])).toEqual([["Secret", null], ["Open", "dev-a"]]);
    expect(JSON.stringify(link)).not.toMatch(/spy/);
    const local = (await viaLink(db, "GET", "/ui/tasks/board", undefined, { fleetConfig, local: true })).body;
    expect(local.projects.map((p: any) => p.leadInstance)).toEqual(["spy", "dev-a"]);
    // #2355 review: the names a lead may be — the fleet's instances; over the link, not a hidden one.
    expect([local.leads, link.leads]).toEqual([["dev-a", "spy"], ["dev-a"]]);
  });
});

describe("#2341 review r2: an answer to a prompt is judged by the prompt's world, before the shared room's own access", () => {
  /**
   * Two bots in one group share General (T0, routed to the owner's `general`). The owner's world admits only "admin";
   * the sibling's admits "bob", its fleet admin, and runs `sib-dev`. A card of sib-dev's waits for an answer: its Needs
   * you list is the sibling's, so the prompt is the sibling's — in the owner's room. The real hub, the real inbound handler.
   */
  async function sharedRoom() {
    const h = rig();
    const sibling = { id: "sibling", type: "telegram",
      sendText: vi.fn(async (chatId: string, _t: string, o?: any) => ({ chatId, threadId: o?.threadId, messageId: `prompt-${sibling.sendText.mock.calls.length}` })),
      notifyAlert: vi.fn(async (chatId: string, _a: any, o?: any) => ({ chatId, threadId: o?.threadId, messageId: "live-1" })),
      editAlert: vi.fn(async () => {}), deleteMessage: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const cfg = { id: "sibling", type: "telegram", group_id: "G", bot_token_env: "NONE", access: { mode: "allowlist", allowed_users: ["bob"] } };
    (h.fm.fleetConfig as any).channels.push(cfg);
    (h.fm.fleetConfig as any).instances["sib-general"] = { working_directory: h.dir, general_topic: true, topic_id: "T0", channel_id: "sibling" };
    (h.fm.fleetConfig as any).instances["sib-dev"] = { working_directory: h.dir, topic_id: "T9", channel_id: "sibling" };
    h.fm.routing.rebuild(h.fm.fleetConfig!);
    h.s.adapters.set("sibling", sibling);
    h.s.worlds.set("sibling", { id: "sibling", adapter: sibling, groupId: "G", channelConfig: cfg, accessManager: { isAllowed: (u: string) => u === "bob", getMode: () => "allowlist" }, stop: async () => {} });
    h.s.worlds.get("owner").accessManager = { isAllowed: (u: string) => u === "admin", getMode: () => "allowlist" };
    const ann = { kind: "person" as const, name: "Ann" };
    const card = h.db.board.createCards(ann, { cards: [{ title: "Rank ties", assignee: "sib-dev" }] }).cards[0]!;
    h.db.board.moveCard(ann, card.code, "claimed"); h.db.board.moveCard(ann, card.code, "blocked", { reason: "same rank?" });
    const routed: string[] = [];
    h.s.topicCommands.handleInstanceCommand = vi.fn(async (msg: { text: string; adapterId: string }) => { routed.push(`${msg.adapterId}: ${msg.text}`); return true; });
    h.s.startNeedsYou();
    for (let n = 0; n < 6; n++) { await flush(); await vi.advanceTimersByTimeAsync(0); }
    // bob presses Answer on the sibling's live message (in T0), and the hub asks for the words there.
    const choices = sibling.notifyAlert.mock.calls.at(-1)![1].choices as Array<{ id: string; label: string }>;
    const answer = choices.find((c) => /answer/i.test(c.label) || c.id.endsWith(":answer"))!;
    const acks: string[] = [];
    h.s.needsYou.handleCallback({ callbackData: answer.id, chatId: "G", threadId: "T0", messageId: "live-1", userId: "bob", username: "bob", ack: (x?: string) => acks.push(x ?? "") }, "sibling");
    for (let n = 0; n < 6; n++) { await flush(); await vi.advanceTimersByTimeAsync(0); }
    const prompt = (await sibling.sendText.mock.results.at(-1)!.value).messageId as string;
    const copy = (adapterId: string, over: Record<string, unknown> = {}) => h.s.handleInboundMessage({ source: "telegram", adapterId, chatId: "G", threadId: "T0", messageId: "in-1",
      userId: "bob", username: "bob", replyTo: prompt, text: "ties share a rank", timestamp: new Date(), ...over });
    const status = () => h.db.board.getCard(card.code).status;
    return { h, copy, routed, status, acks, stop: () => h.s.stopNeedsYou?.() };
  }

  it.each([["the owner's (room) copy first", ["owner", "sibling"]], ["the sibling's copy first", ["sibling", "owner"]]])(
    "%s: bob's answer is taken once (the card moves on), and nothing reaches an instance", async (_n, order) => {
      const r = await sharedRoom();
      for (const a of order) await r.copy(a);
      expect([r.status(), r.routed]).toEqual(["claimed", []]);
      await r.stop();
    });

  it("controls: someone not the sibling's admin, or bob's reply to another message, is the room's ordinary input — judged by the owner's access", async () => {
    const r = await sharedRoom();
    await r.copy("owner", { userId: "eve", username: "eve", messageId: "in-2" });               // not the clicker: not the answer; eve not admitted by the room
    await r.copy("owner", { replyTo: "something-else", messageId: "in-3" });                     // bob, but not an answer: the room's owner denies bob
    expect([r.status(), r.routed]).toEqual(["blocked", []]);
    await r.copy("owner", { userId: "admin", username: "admin", replyTo: "something-else", messageId: "in-4", text: "hi" });   // the room's own admin: flows
    expect(r.routed).toEqual(["owner: hi"]);
    await r.stop();
  });
});

describe("#2355 review: a click or a reply is judged by where the card routes NOW, not by the last render", () => {
  /** The real hub on the rig's world; a project led by `lead` (topic T5), `lead2` (T6); two waiting cards of `dev-a`'s. */
  async function routed() {
    const h = rig();
    const at = (topic: string) => ({ working_directory: h.dir, channel_id: "owner", topic_id: topic });
    (h.fm.fleetConfig as any).instances = { ...(h.fm.fleetConfig as any).instances, lead: at("T5"), lead2: at("T6"), "dev-a": at("T7") };
    h.fm.routing.rebuild(h.fm.fleetConfig!);
    h.s.worlds.get("owner").id = "owner";                                                             // the hub lists worlds by id
    const adapter = h.s.adapters.get("owner");
    let n = 0;
    adapter.notifyAlert = vi.fn(async (chat: string, _a: any, o?: any) => ({ chatId: chat, threadId: o?.threadId, messageId: `live-${++n}` }));
    adapter.editAlert = vi.fn(async () => {});
    adapter.deleteMessage = vi.fn(async () => {});
    adapter.sendText = vi.fn(async (chat: string, _t: string, o?: any) => ({ chatId: chat, threadId: o?.threadId, messageId: `prompt-${++n}` }));
    const ann = { kind: "person" as const, name: "Ann" }, dev = { kind: "instance" as const, name: "dev-a" };
    const project = h.db.board.createProject(ann, { name: "Led", leadInstance: "lead" });
    const [blocked, review] = h.db.board.createCards(ann, { project: project.id, cards: [{ title: "Ties", assignee: "dev-a" }, { title: "Cache", assignee: "dev-a" }] }).cards;
    h.db.board.moveCard(dev, blocked!.code, "claimed"); h.db.board.moveCard(dev, blocked!.code, "blocked", { reason: "same rank?" });
    h.db.board.moveCard(dev, review!.code, "claimed"); h.db.board.moveCard(dev, review!.code, "review", { result: "done" });
    h.s.attachTaskBoard(h.db);                                                                        // the board's changes poke the hub
    h.s.startNeedsYou();
    const settle = async () => { for (let i = 0; i < 6; i++) { await flush(); await vi.advanceTimersByTimeAsync(0); } };
    await settle();
    /** The lane message posted in `thread`, its buttons. */
    const message = (thread: string) => {
      const call = adapter.notifyAlert.mock.calls.filter((c: any) => c[2]?.threadId === thread).at(-1);
      const sent = adapter.notifyAlert.mock.results[adapter.notifyAlert.mock.calls.indexOf(call)];
      return { call, sent };
    };
    const click = async (thread: string, label: RegExp) => {
      const { call, sent } = message(thread);
      const choice = (call![1].choices as Array<{ id: string; label: string }>).find((c) => label.test(c.label))!;
      const acks: string[] = [];
      h.s.needsYou.handleCallback({ callbackData: choice.id, chatId: "G", threadId: thread, messageId: (await sent!.value).messageId, userId: "admin", username: "admin", ack: (x?: string) => acks.push(x ?? "") }, "owner");
      return acks;
    };
    const reply = (prompt: string, thread: string, text: string) => h.s.handleInboundMessage({ source: "telegram", adapterId: "owner", chatId: "G", threadId: thread, messageId: `in-${++n}`,
      userId: "admin", username: "admin", replyTo: prompt, text, timestamp: new Date() });
    const status = (code: string) => h.db.board.getCard(code).status;
    // A refused answer is the topic's ordinary input: recorded here instead of reaching an instance.
    const routedInput: string[] = [];
    h.s.topicCommands.handleInstanceCommand = vi.fn(async (msg: { text: string }) => { routedInput.push(msg.text); return true; });
    return { h, project, blocked: blocked!, review: review!, settle, message, click, reply, status, adapter, routedInput };
  }

  it("the lead changes (the card's version does not): the old lane's Confirm, Send back and Answer are refused at once; the new lane's work", async () => {
    const r = await routed();
    expect(r.message("T5").call, "posted in lead's topic").toBeDefined();
    const version = r.h.db.board.getCard(r.review.code).version;
    // A Send back asked for in the old lane before the change: its prompt waits for a reply.
    expect(await r.click("T5", /Send back/)).toEqual([tr("needs.task_reply_asked")]);
    await r.settle();
    const prompt = (await r.adapter.sendText.mock.results.at(-1).value).messageId;

    r.h.db.board.updateProject({ kind: "person", name: "Ann" }, r.project.id, { leadInstance: "lead2" });   // no recompute here
    expect(r.h.db.board.getCard(r.review.code).version).toBe(version);
    expect(await r.click("T5", /Confirm/)).toEqual([tr("needs.task_moved")]);
    expect(await r.click("T5", /Answer/)).toEqual([tr("needs.task_moved")]);
    expect(await r.click("T5", /Send back/)).toEqual([tr("needs.task_moved")]);
    await r.reply(prompt, "T5", "tick the list");
    expect([r.status(r.review.code), r.status(r.blocked.code), r.routedInput]).toEqual(["review", "blocked", ["tick the list"]]);

    // The project change itself pokes the hub: its list follows the new lead at once (no backstop tick needed).
    await r.settle();
    expect((r.h.s.needsYou.webItems() as Array<{ lane?: string }>).map((i) => i.lane)).toEqual(["lead2", "lead2"]);
    // Control: the new lane's message, once rendered (the hub's renders are debounced), acts.
    await vi.advanceTimersByTimeAsync(60_000); await r.settle();
    expect(r.message("T6").call, "posted in lead2's topic").toBeDefined();
    expect(await r.click("T6", /Confirm/)).toEqual([expect.not.stringMatching(/another channel|wrong place|no longer|stale/i)]);
    expect(r.status(r.review.code)).toBe("done");
  });

  it("the lead's topic moves (or goes): the old topic's buttons are refused at once, though the lane's name is the same", async () => {
    const r = await routed();
    (r.h.fm.fleetConfig as any).instances.lead.topic_id = "T8";                                        // the same lane, another place
    expect(await r.click("T5", /Confirm/)).toEqual([tr("needs.task_moved")]);
    delete (r.h.fm.fleetConfig as any).instances.lead.topic_id;                                        // no channel at all
    expect(await r.click("T5", /Answer/)).toEqual([tr("needs.task_moved")]);
    expect([r.status(r.review.code), r.status(r.blocked.code)]).toEqual(["review", "blocked"]);
    // Control: put back, the same buttons act.
    (r.h.fm.fleetConfig as any).instances.lead.topic_id = "T5";
    expect(await r.click("T5", /Confirm/)).toEqual([expect.not.stringMatching(/another channel|wrong place|no longer|stale/i)]);
    expect(r.status(r.review.code)).toBe("done");
  });

  it("with needs_you.live_message off, the dispatcher's wake keeps the ordinary words (no buttons exist)", () => {
    const h = rig();
    (h.fm.fleetConfig as any).instances = { ...(h.fm.fleetConfig as any).instances, lead: { working_directory: h.dir, channel_id: "owner", topic_id: "T5" } };
    h.fm.routing.rebuild(h.fm.fleetConfig!);
    const card = h.db.board.createCards({ kind: "instance", name: "lead" }, { cards: [{ title: "Ties", assignee: "dev-a" }] }).cards[0]!;
    const here = () => h.s.taskBoardWaker ? (h.s.taskBoardWaker as any).deps.buttonsHere("lead", card.uuid) : undefined;
    h.s.attachTaskBoard?.(h.db);
    expect(here()).toBe(true);
    (h.fm.fleetConfig as any).needs_you = { live_message: false };
    expect(here()).toBe(false);
  });
});
