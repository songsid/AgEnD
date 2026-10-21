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
import { setLocale } from "../src/locale.js";
import { SchedulerDb } from "../src/scheduler/db.js";
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
  fm.fleetConfig = { defaults: {}, channel: owner, channels: [owner], health_port: 19280, instances: {
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
    const c = ([] as string[]).concat(out["Set-Cookie"] ?? []).find((x) => /^(__Host-)?agend_session=/.test(x))!.split(";")[0]!;
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
function viaLink(db: SchedulerDb, method: string, path: string, body?: unknown, opts: { local?: boolean; fleetConfig?: unknown } = {}) {
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
      fleetConfig: opts.fleetConfig ?? { defaults: {}, instances: {} }, logger: { debug() {}, info() {}, warn() {}, error() {} } } as never);
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
    db.board.createCards(ANN, { cards: [{ title: "Open work", assignee: "dev-a" }, { title: "Secret work", assignee: "spy" }] });
    const fleetConfig = { defaults: {}, instances: { "dev-a": {}, spy: { cross_instance_visibility: "hidden" } } };
    expect((await viaLink(db, "GET", "/ui/tasks/board", undefined, { fleetConfig })).body.cards.map((c: any) => c.id)).toEqual(["M-1"]);
    expect((await viaLink(db, "GET", "/ui/tasks/cards/M-2", undefined, { fleetConfig })).status).toBe(404);
    expect((await viaLink(db, "GET", "/ui/tasks/search?q=work", undefined, { fleetConfig })).body.results.map((r: any) => r.card.id)).toEqual(["M-1"]);
    expect((await viaLink(db, "GET", "/ui/tasks/board", undefined, { fleetConfig, local: true })).body.cards.map((c: any) => c.id)).toEqual(["M-1", "M-2"]);
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
