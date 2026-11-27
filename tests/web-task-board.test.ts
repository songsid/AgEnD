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
import "../src/ui/chat-render.js";
// @ts-expect-error — a page module: plain JS, no declarations
import { createTaskRefIndex } from "../src/ui/chat-task-refs.js";

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
    const list = await h.fm.handleTaskCrudHttp("dev-a", { action: "list", detail:true }) as Array<{ id: string; status: string }>;
    expect(list.map((t) => [t.id, t.status])).toEqual([[card.uuid, "review"]]);
    // A card on the board reads as text (step 2: the agent's view of a card).
    expect(await h.fm.handleTaskCrudHttp("dev-a", { action: "get", detail:true, id: "M-1" })).toMatch(/^M-1 main task · Ship it \[waiting for the person\] @dev-a v3\n/);
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
function viaLink(db: SchedulerDb, method: string, path: string, body?: unknown, opts: { local?: boolean; fleetConfig?: unknown; needs?: unknown[]; tier?: "admin" | "read" } = {}) {
  const sessions = new WebSessionStore(), exposureId = "a".repeat(32), pub = "https://sample.trycloudflare.com", local = "http://127.0.0.1:19280";
  const s = sessions.create({ tier: opts.tier ?? "admin", surface: opts.local ? "local" : "gateway", exposureId: opts.local ? undefined : exposureId, label: "t", tokenEpoch: tokenEpoch(TOKEN) } as never);
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
  // M-3278 (decision 7933bf90): the board's writes are on the manifest too — an admin session works the board over the link.
  it("its manifest: the reads and (M-3278) the board's writes", () => {
    for (const [method, path] of [["GET", "/ui/tasks/board"], ["GET", "/ui/tasks/search"], ["GET", "/ui/tasks/cards/M-3"],
      ["POST", "/ui/tasks/cards/M-3"], ["POST", "/ui/tasks/cards/M-3/move"], ["POST", "/ui/tasks/cards/S-1/reorder"], ["POST", "/ui/tasks/projects/2"],
      ["DELETE", "/ui/tasks/cards/M-3"],
      ["POST", "/ui/tasks"], ["POST", "/ui/tasks/aaaaaaaa-0000-0000-0000-000000000001"],          // the old list's create and update
    ] as const) {
      expect(isPublicWebRoute(method, path), `${method} ${path}`).toBe(true);
    }
    expect(isPublicWebRoute("GET", "/ui/tasks/cards/M-3/move")).toBe(false);
  });

  // M-3278 (decision 7933bf90): an admin session writes the board over the link as itself (the person), never `script public-link`.
  it("M-3278: an admin session over the link writes the board as itself", async () => {
    const db = scratchDb();
    db.board.createProject(ANN, { name: "Game" });
    db.board.createCards(ANN, { project: "Game", cards: [{ title: "Ship it", assignee: "dev-a" }] });
    expect((await viaLink(db, "POST", "/ui/tasks/cards/M-1", { goal: "from the link" })).status).toBe(200);
    expect((await viaLink(db, "POST", "/ui/tasks/projects", { name: "Other" })).status).toBe(200);
    expect(db.board.getCard("M-1")).toMatchObject({ goal: "from the link" });
    expect(db.board.listProjects(true).map((p) => p.name)).toEqual(["Game", "Other"]);
    expect(JSON.stringify(db.board.detail("M-1").history)).not.toMatch(/public-link/);
  });
  it("M-3278: a read-only session reads the board and changes nothing — over the link or on the local page", async () => {
    const db = scratchDb();
    db.board.createProject(ANN, { name: "Game" });
    db.board.createCards(ANN, { project: "Game", cards: [{ title: "Ship it", assignee: "dev-a" }] });
    for (const local of [false, true]) {
      const opts = { tier: "read" as const, ...(local ? { local: true } : {}) };
      expect((await viaLink(db, "GET", "/ui/tasks/board", undefined, opts)).status, `read board local=${local}`).toBe(200);
      for (const [path, body] of [["/ui/tasks/cards/M-1", { goal: "no" }], ["/ui/tasks/projects", { name: "No" }], ["/ui/tasks", { title: "No" }]] as const) {
        const r = await viaLink(db, "POST", path, body, opts);
        expect([path, local, r.status]).toEqual([path, local, 403]);
      }
    }
    expect(db.board.getCard("M-1").goal ?? "").not.toBe("no");
    expect(db.board.listProjects(true).map((p) => p.name)).toEqual(["Game"]);
  });

  it("the old /ui/tasks routes: the person's on the local page and (M-3278) an admin's over the link; a malformed id is a 400", async () => {
    const db = scratchDb();
    const card = db.board.createCards(ANN, { cards: [{ title: "Ship it", assignee: "dev-a" }] }).cards[0]!;
    db.claimTask(card.uuid, "dev-a", { kind: "instance", name: "dev-a" });
    db.completeTask(card.uuid, "shipped", { kind: "instance", name: "dev-a" });
    // M-3278: an admin session over the link creates on the old route, as the person.
    expect((await viaLink(db, "POST", "/ui/tasks", { title: "From the link" })).status).toBe(200);
    expect(db.board.getCard("M-1").status).toBe("review");
    expect((await viaLink(db, "POST", `/ui/tasks/${card.uuid}`, { action: "update", status: "done" }, { local: true })).body.status).toBe("done");
    expect((await viaLink(db, "POST", "/ui/tasks", { title: "From the page" }, { local: true })).status).toBe(200);
    expect((await viaLink(db, "POST", "/ui/tasks/%E0%A4%A", { action: "update", status: "done" }, { local: true })).status).toBe(400);
  });

  // M-3278 (decision 7933bf90): the link's hiding applies to a read-only session there; an admin session sees the board whole.
  it("cards of instances kept out of sight (cross_instance_visibility: hidden) are left out over the link for a read-only session (M-3278: an admin's sees them); the local page shows them", async () => {
    const db = scratchDb();
    db.board.createCards(ANN, { cards: [{ title: "Open work", assignee: "dev-a" }, { title: "Secret work", assignee: "spy" },
      { title: "Handed out by the spy", assignee: "dev-a", dispatcher: { kind: "instance", name: "spy" } }] });
    const fleetConfig = { defaults: {}, instances: { "dev-a": {}, spy: { cross_instance_visibility: "hidden" } } };
    expect((await viaLink(db, "GET", "/ui/tasks/board", undefined, { fleetConfig, tier: "read" })).body.cards.map((c: any) => c.id)).toEqual(["M-1"]);
    expect((await viaLink(db, "GET", "/ui/tasks/cards/M-2", undefined, { fleetConfig, tier: "read" })).status).toBe(404);
    expect((await viaLink(db, "GET", "/ui/tasks/search?q=work", undefined, { fleetConfig, tier: "read" })).body.results.map((r: any) => r.card.id)).toEqual(["M-1"]);
    expect((await viaLink(db, "GET", "/ui/tasks/board", undefined, { fleetConfig })).body.cards.map((c: any) => c.id), "M-3278: an admin over the link").toEqual(["M-1", "M-2", "M-3"]);
    expect((await viaLink(db, "GET", "/ui/tasks/board", undefined, { fleetConfig, local: true })).body.cards.map((c: any) => c.id)).toEqual(["M-1", "M-2", "M-3"]);
  });

  // #2303 review: what a visible card shows of the cards around it follows the same rule — its children, its main
  // task, a search hit's main task title — and what an instance kept out of sight wrote on it.
  it("over the link a visible card does not show hidden related cards (children, main task, a hit's main task) or a hidden instance's words (a read-only session; M-3278)", async () => {
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
    const link = (path: string) => viaLink(db, "GET", path, undefined, { fleetConfig, tier: "read" });
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
    // M-3278: so does an admin session over the link.
    expect((await viaLink(db, "GET", "/ui/tasks/cards/M-1", undefined, { fleetConfig })).body.children.map((c: any) => c.id)).toEqual(["S-1", "S-2", "S-4"]);
    expect((await local("/ui/tasks/cards/S-3")).body.parent.title).toBe("Secret plan");
    expect((await local("/ui/tasks/search?q=step")).body.results.find((r: any) => r.card.id === "S-3").parentTitle).toBe("Secret plan");
  });
});

// #2304 review (Fable): a hidden instance's words on a visible card are not found by search, and do not count in the
// board's comment count or name its last comment — over the link; the local page is unchanged.
describe("4a. a hidden instance's comments on a visible card, over the link", () => {
  it("search does not find them; the board's commentCount, newCommentCount and lastComment leave them out (a read-only session; M-3278)", async () => {
    const db = scratchDb();
    const fleetConfig = { defaults: {}, instances: { "dev-a": {}, spy: { cross_instance_visibility: "hidden" } } };
    db.board.createCards(ANN, { cards: [{ title: "Open work", assignee: "dev-a" }, { title: "Other work", assignee: "dev-a" }] });
    db.board.updateCard(ANN, "M-1", { comment: "Ann's note" });
    db.board.updateCard({ kind: "instance", name: "spy" }, "M-1", { comment: "the vault code is 4711" });
    db.board.updateCard({ kind: "instance", name: "spy" }, "M-2", { comment: "only the spy spoke here" });
    db.board.updateCard({ kind: "instance", name: "spy" }, "M-1", { log: "vault log line" });
    const link = (path: string) => viaLink(db, "GET", path, undefined, { fleetConfig, tier: "read" });
    const local = (path: string) => viaLink(db, "GET", path, undefined, { fleetConfig, local: true });
    expect((await link("/ui/tasks/search?q=vault")).body.results).toEqual([]);
    expect((await local("/ui/tasks/search?q=vault")).body.results.map((r: any) => [r.card.id, r.match.field])).toEqual([["M-1", "log"]]);
    // M-3278: an admin session over the link finds them as the local page does.
    expect((await viaLink(db, "GET", "/ui/tasks/search?q=vault", undefined, { fleetConfig })).body.results.map((r: any) => [r.card.id, r.match.field])).toEqual([["M-1", "log"]]);
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
  // #2425/#2434: a card an instance handed out — blocked or in review — is that instance's own, never the person's Needs
  // you; so the hidden instance's card that waits for the person is one the person handed to it.
  it("a card a hidden instance holds, waiting for the person: not in the link's poll for a read-only session (title and all; M-3278: an admin's lists it), while the local page lists it; a visible one is in both", async () => {
    const h = rig();
    h.fm.fleetConfig = { ...h.fm.fleetConfig, instances: { ...(h.fm.fleetConfig as any).instances, "dev-a": {}, secret_lead: { cross_instance_visibility: "hidden" } } } as never;
    const fleetConfig = h.fm.fleetConfig;
    const lead = { kind: "instance" as const, name: "secret_lead" };
    h.db.board.createCards(ANN, { cards: [{ title: "HIDDEN_CARD_TITLE", assignee: "secret_lead" }] });          // M-1, the person's, to the hidden lead
    h.db.board.createCards(ANN, { cards: [{ title: "Open title", assignee: "dev-a" }] });                        // M-2
    h.db.board.createCards(lead, { cards: [{ title: "HIDDEN_BLOCKED_TITLE", assignee: "dev-a" }] });             // M-3, by the hidden lead
    h.db.board.moveCard(ANN, "M-1", "claimed"); h.db.board.moveCard(ANN, "M-1", "review");
    h.db.board.moveCard(ANN, "M-2", "claimed"); h.db.board.moveCard(ANN, "M-2", "blocked", { reason: "which season?" });
    h.db.board.moveCard(ANN, "M-3", "claimed"); h.db.board.moveCard(ANN, "M-3", "blocked", { reason: "PRIVATE_BLOCKED_REASON" });
    const needs = deriveNeedsYou({ prompts: [], instances: [], deliveries: [], ownerOf: () => undefined, tasks: h.s.needsYouTasks() });
    expect(needs.map((i) => i.card?.code).sort()).toEqual(["M-1", "M-2"]);                                     // M-3: the lead's to decide
    h.db.board.createCards(lead, { cards: [{ title: "Lead's own review", assignee: "dev-a", needsReview: true }] });   // M-4: the lead confirms it
    h.db.board.moveCard(ANN, "M-4", "claimed"); h.db.board.moveCard(ANN, "M-4", "review");
    expect((h.s.needsYouTasks() as Array<{ code: string }>).map((t) => t.code).sort()).toEqual(["M-1", "M-2"]);
    const link = (await viaLink(h.db, "GET", "/ui/poll", undefined, { fleetConfig, needs, tier: "read" })).body;
    expect(link.needs.map((i: any) => i.card?.code)).toEqual(["M-2"]);
    expect(JSON.stringify(link)).not.toMatch(/HIDDEN_CARD_TITLE|HIDDEN_BLOCKED_TITLE|PRIVATE_BLOCKED_REASON/);
    const local = (await viaLink(h.db, "GET", "/ui/poll", undefined, { fleetConfig, needs, local: true })).body;
    expect(local.needs.map((i: any) => i.card?.code).sort()).toEqual(["M-1", "M-2"]);
    // M-3278: an admin session over the link lists it as the local page does.
    expect((await viaLink(h.db, "GET", "/ui/poll", undefined, { fleetConfig, needs })).body.needs.map((i: any) => i.card?.code).sort()).toEqual(["M-1", "M-2"]);
    // The board says the same over the link, and the link's page has no stream for Needs you to leak through.
    expect((await viaLink(h.db, "GET", "/ui/tasks/board", undefined, { fleetConfig, tier: "read" })).body.cards.map((c: any) => c.id)).toEqual(["M-2"]);
    expect((await viaLink(h.db, "GET", "/ui/events", undefined, { fleetConfig })).status).toBe(404);
    // Visibility is read when asked: the lead shown again, its card is listed again.
    (fleetConfig as any).instances.secret_lead = {};
    expect((await viaLink(h.db, "GET", "/ui/poll", undefined, { fleetConfig, needs, tier: "read" })).body.needs.map((i: any) => i.card?.code).sort()).toEqual(["M-1", "M-2"]);
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

  it("over the public link, an instance kept out of sight is not listed to a read-only session, nor a card that names one (M-3278: an admin's has both); the local page has both", async () => {
    const db = scratchDb();
    db.board.createCards(ANN, { cards: [{ title: "Open work", assignee: "dev-a" }, { title: "Secret work", assignee: "spy" },
      { title: "Handed out by the spy", assignee: "dev-a", dispatcher: { kind: "instance", name: "spy" } }] });
    const fleetConfig = { defaults: {}, instances: { "dev-a": {}, spy: { cross_instance_visibility: "hidden" } } };
    const link = (await viaLink(db, "GET", "/ui/tasks/work", undefined, { fleetConfig, tier: "read" })).body;
    expect(link.instances.map((i: any) => [i.name, i.ready.map((c: any) => c.id)])).toEqual([["dev-a", ["M-1"]]]);
    expect((await viaLink(db, "GET", "/ui/tasks/work?instance=spy", undefined, { fleetConfig, tier: "read" })).body.instances).toEqual([]);
    const admin = (await viaLink(db, "GET", "/ui/tasks/work", undefined, { fleetConfig })).body;
    expect(admin.instances.map((i: any) => [i.name, i.ready.map((c: any) => c.id)]), "M-3278: an admin over the link").toEqual([["dev-a", ["M-1", "M-3"]], ["spy", ["M-2"]]]);
    const local = (await viaLink(db, "GET", "/ui/tasks/work", undefined, { fleetConfig, local: true })).body;
    expect(local.instances.map((i: any) => [i.name, i.ready.map((c: any) => c.id)])).toEqual([["dev-a", ["M-1", "M-3"]], ["spy", ["M-2"]]]);
    expect(isPublicWebRoute("GET", "/ui/tasks/work")).toBe(true);
    expect(isPublicWebRoute("POST", "/ui/tasks/work")).toBe(true);   // M-3278: the board's writes are routed (the handler has no POST here)
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

describe("4f. a main task kept out of sight is not numbered by its sub tasks over the link", () => {
  const fleetConfig = { defaults: {}, instances: { "dev-a": {}, ops: {}, spy: { cross_instance_visibility: "hidden" } } };
  const seed = () => {
    const db = scratchDb();
    // The main task is held by a hidden instance; its sub task by a visible one. A second, visible main task has a sub task too.
    const hidden = db.board.createCards(ANN, { cards: [{ title: "Hidden main", assignee: "spy" }] }).cards[0]!;
    const sub = db.board.createCards(ANN, { cards: [{ parent: hidden.code, title: "Visible sub", assignee: "dev-a" }] }).cards[0]!;
    const open = db.board.createCards(ANN, { cards: [{ title: "Open main", assignee: "dev-a" }] }).cards[0]!;
    const openSub = db.board.createCards(ANN, { cards: [{ parent: open.code, title: "Open sub", assignee: "dev-a" }] }).cards[0]!;
    return { db, hidden, sub, open, openSub };
  };
  const get = (db: SchedulerDb, path: string, opts: { tier?: "admin" | "read"; local?: boolean }) => viaLink(db, "GET", path, undefined, { fleetConfig, ...opts });
  const created = (body: any) => body.history.find((e: any) => e.type === "created");

  it("over the link a sub task's `card.parentId` and its \"created\" event's `parent` read as none, and the main task's number is nowhere in the read; a visible main task is still named", async () => {
    const { db, hidden, sub, open, openSub } = seed();
    const link = (await get(db, `/ui/tasks/cards/${sub.code}`, { tier: "read" })).body;
    expect(link.card.id).toBe(sub.code);
    expect(link.card.parentId, "the card's own read").toBeNull();
    expect(created(link).data.parent, "its created event").toBeNull();
    expect(link.parent).toBeNull();
    expect(JSON.stringify(link), "the hidden main task's number is not in the read at all").not.toContain(`"${hidden.code}"`);
    // …nor in the board's, the work drawer's or the search's.
    const board = (await get(db, "/ui/tasks/board", { tier: "read" })).body;
    expect(board.cards.find((c: any) => c.id === sub.code).parentId).toBeNull();
    expect(JSON.stringify(board)).not.toContain(`"${hidden.code}"`);
    const work = (await get(db, "/ui/tasks/work", { tier: "read" })).body;
    const mine = work.instances.flatMap((i: any) => [...i.doing, ...i.blocked, ...i.review, ...i.ready, ...i.waiting, ...i.mains]).filter((c: any) => c.id === sub.code);
    expect(mine.length).toBeGreaterThan(0);
    for (const c of mine) expect(c.parentId, "the work drawer").toBeNull();
    const found = (await get(db, "/ui/tasks/search?q=Visible", { tier: "read" })).body;
    expect(found.results.map((r: any) => r.card.id)).toEqual([sub.code]);
    expect(found.results[0].card.parentId, "the search").toBeNull();
    // A main task in plain sight is named, over the link and on the card.
    const shown = (await get(db, `/ui/tasks/cards/${openSub.code}`, { tier: "read" })).body;
    expect(shown.card.parentId).toBe(open.code);
    expect(created(shown).data.parent).toBe(open.code);
    expect(shown.parent?.id).toBe(open.code);
    expect((await get(db, "/ui/tasks/board", { tier: "read" })).body.cards.find((c: any) => c.id === openSub.code).parentId).toBe(open.code);
  });

  it("the local page and an admin session over the link still see the main task's number", async () => {
    const { db, hidden, sub } = seed();
    for (const opts of [{ local: true }, {}] as const) {
      const full = (await get(db, `/ui/tasks/cards/${sub.code}`, opts)).body;
      expect(full.card.parentId, JSON.stringify(opts)).toBe(hidden.code);
      expect(created(full).data.parent, JSON.stringify(opts)).toBe(hidden.code);
      expect((await get(db, "/ui/tasks/board", opts)).body.cards.find((c: any) => c.id === sub.code).parentId, JSON.stringify(opts)).toBe(hidden.code);
    }
  });
});

describe("4g. no other card number of a card kept out of sight over the link — its \"updated\" events, dependencies and cascades", () => {
  const fleetConfig = { defaults: {}, instances: { "dev-a": {}, ops: {}, spy: { cross_instance_visibility: "hidden" } } };
  const seed = () => {
    const db = scratchDb();
    db.board.setCommentRouting({ instances: () => ["dev-a", "ops", "spy"], enabled: () => true });
    // `hidden` is held by a hidden instance, `plain` by a visible one; `work` (visible) depends on both, `only` (visible) on the hidden one alone.
    const hidden = db.board.createCards(ANN, { cards: [{ title: "Hidden dependency", assignee: "spy" }] }).cards[0]!;
    const plain = db.board.createCards(ANN, { cards: [{ title: "Plain dependency", assignee: "ops" }] }).cards[0]!;
    const work = db.board.createCards(ANN, { cards: [{ title: "Visible work", assignee: "dev-a" }] }).cards[0]!;
    const only = db.board.createCards(ANN, { cards: [{ title: "Hidden only", assignee: "dev-a" }] }).cards[0]!;
    // work: [] → [hidden, plain] → [plain] → [plain, hidden], and a title change that carries a dependency change with it.
    db.board.updateCard(ANN, work.code, { dependsOn: [hidden.code, plain.code] });
    db.board.updateCard(ANN, work.code, { dependsOn: [plain.code] });
    db.board.updateCard(ANN, work.code, { dependsOn: [plain.code, hidden.code], title: "Visible work (retitled)" });
    // only: [] → [hidden] → []: a change that is only about the hidden card.
    db.board.updateCard(ANN, only.code, { dependsOn: [hidden.code] });
    db.board.updateCard(ANN, only.code, { dependsOn: [] });
    // A sub task of a visible main task that depends on the hidden card too: its `unmetDeps` follow its main task's.
    const main = db.board.createCards(ANN, { cards: [{ title: "Visible main", assignee: "dev-a", dependsOn: [hidden.code] }] }).cards[0]!;
    const sub = db.board.createCards(ANN, { cards: [{ parent: main.code, title: "Visible sub", assignee: "dev-a" }] }).cards[0]!;
    return { db, hidden, plain, work, only, main, sub };
  };
  const get = (db: SchedulerDb, path: string, opts: { tier?: "admin" | "read"; local?: boolean }) => viaLink(db, "GET", path, undefined, { fleetConfig, ...opts });
  const updates = (body: any) => body.history.filter((e: any) => e.type === "updated");

  it("over the link an \"updated\" event's `changes.dependsOn` does not number the hidden card — taken out of both lists; a change only about it is not shown; a visible card's number stays", async () => {
    const { db, hidden, plain, work, only } = seed();
    const link = (await get(db, `/ui/tasks/cards/${work.code}`, { tier: "read" })).body;
    expect(link.card.id).toBe(work.code);
    // [] → [hidden, plain] shows as [] → [plain]; [hidden, plain] → [plain] changed nothing the link sees (no event);
    // [plain] → [plain, hidden] with the title shows the title alone, the dependency change dropped (nothing visible changed).
    expect(updates(link).map((e: any) => e.data.changes)).toEqual([
      { dependsOn: { from: [], to: [plain.code] } },
      { title: { from: "Visible work", to: "Visible work (retitled)" } },
    ]);
    expect(JSON.stringify(link), "the hidden card's number is nowhere in the read").not.toContain(`"${hidden.code}"`);
    // A card whose only dependency change was about the hidden card has no \"updated\" event to show at all.
    const alone = (await get(db, `/ui/tasks/cards/${only.code}`, { tier: "read" })).body;
    expect(updates(alone)).toEqual([]);
    expect(JSON.stringify(alone)).not.toContain(`"${hidden.code}"`);
  });

  it("a card's `dependsOn` and `unmetDeps` read without the hidden card's number — on the card, its sub tasks, the board, the work drawer and the search; a visible dependency stays", async () => {
    const { db, hidden, plain, work, only, main, sub } = seed();
    const link = (await get(db, `/ui/tasks/cards/${work.code}`, { tier: "read" })).body;
    expect([link.card.dependsOn, link.card.unmetDeps], "the card's own read").toEqual([[plain.code], [plain.code]]);
    // …a main task's sub tasks are read with it, and carry their main task's unmet dependencies.
    const mainLink = (await get(db, `/ui/tasks/cards/${main.code}`, { tier: "read" })).body;
    expect([mainLink.card.dependsOn, mainLink.card.unmetDeps]).toEqual([[], []]);
    expect(mainLink.children.map((c: any) => [c.id, c.dependsOn, c.unmetDeps])).toEqual([[sub.code, [], []]]);
    expect(JSON.stringify(mainLink)).not.toContain(`"${hidden.code}"`);
    const board = (await get(db, "/ui/tasks/board", { tier: "read" })).body;
    const row = (code: string) => board.cards.find((c: any) => c.id === code);
    expect([row(work.code).dependsOn, row(work.code).unmetDeps]).toEqual([[plain.code], [plain.code]]);
    expect([row(only.code).dependsOn, row(only.code).unmetDeps]).toEqual([[], []]);
    expect([row(sub.code).dependsOn, row(sub.code).unmetDeps]).toEqual([[], []]);
    expect(JSON.stringify(board), "the board").not.toContain(`"${hidden.code}"`);
    const workRead = (await get(db, "/ui/tasks/work", { tier: "read" })).body;
    const mine = workRead.instances.flatMap((i: any) => [...i.doing, ...i.blocked, ...i.review, ...i.ready, ...i.waiting, ...i.mains]).filter((c: any) => c.id === work.code);
    expect(mine.length).toBeGreaterThan(0);
    for (const c of mine) expect([c.dependsOn, c.unmetDeps], "the work drawer").toEqual([[plain.code], [plain.code]]);
    expect(JSON.stringify(workRead), "the work drawer").not.toContain(`"${hidden.code}"`);
    const found = (await get(db, "/ui/tasks/search?q=Visible", { tier: "read" })).body;
    expect(found.results.map((r: any) => r.card.id).sort()).toEqual([main.code, sub.code, work.code].sort());
    expect(found.results.find((r: any) => r.card.id === work.code).card.dependsOn, "the search").toEqual([plain.code]);
    expect(JSON.stringify(found), "the search").not.toContain(`"${hidden.code}"`);
  });

  it("over the link `hiddenUnmet` counts the unfinished dependencies left out (how many, never which) — on the card, its sub tasks, the board, the work drawer and the search; a finished hidden dependency is not counted", async () => {
    const { db, hidden, plain, work, only, main, sub } = seed();
    // `done` is a second hidden card that is finished: its number is left out of `dependsOn` too, and it holds nothing.
    const done = db.board.createCards(ANN, { cards: [{ title: "Hidden and done", assignee: "spy", needsReview: false }] }).cards[0]!;
    db.board.moveCard(ANN, done.code, "claimed");
    db.board.moveCard(ANN, done.code, "done", { result: "finished" });
    // `lone` waits for the hidden card alone; `follower` for the hidden one and the finished one.
    const lone = db.board.createCards(ANN, { cards: [{ title: "Visible lone", assignee: "dev-a", dependsOn: [hidden.code] }] }).cards[0]!;
    const follower = db.board.createCards(ANN, { cards: [{ title: "Visible follower", assignee: "dev-a", dependsOn: [hidden.code, done.code] }] }).cards[0]!;
    const hiddenOf = (c: any) => c.hiddenUnmet;
    const link = (await get(db, `/ui/tasks/cards/${work.code}`, { tier: "read" })).body;
    expect([hiddenOf(link.card), link.card.unmetDeps]).toEqual([1, [plain.code]]);
    const loneRead = (await get(db, `/ui/tasks/cards/${lone.code}`, { tier: "read" })).body.card;
    expect([loneRead.dependsOn, loneRead.unmetDeps, hiddenOf(loneRead)], "only the hidden card is waited for: nothing numbered, one not said").toEqual([[], [], 1]);
    const mainLink = (await get(db, `/ui/tasks/cards/${main.code}`, { tier: "read" })).body;
    expect([hiddenOf(mainLink.card), mainLink.children.map(hiddenOf)], "a sub task waits for what its main task waits for").toEqual([1, [1]]);
    const board = (await get(db, "/ui/tasks/board", { tier: "read" })).body;
    const row = (code: string) => board.cards.find((c: any) => c.id === code);
    expect([work, lone, sub, plain].map((c) => hiddenOf(row(c.code))), "the board").toEqual([1, 1, 1, 0]);
    expect(hiddenOf(row(follower.code)), "a finished hidden dependency is not counted").toBe(1);
    const workRead = (await get(db, "/ui/tasks/work", { tier: "read" })).body;
    const mine = workRead.instances.flatMap((i: any) => [...i.doing, ...i.blocked, ...i.review, ...i.ready, ...i.waiting, ...i.mains]).filter((c: any) => c.id === work.code);
    expect(mine.length).toBeGreaterThan(0);
    for (const c of mine) expect(hiddenOf(c), "the work drawer").toBe(1);
    const found = (await get(db, "/ui/tasks/search?q=Visible", { tier: "read" })).body;
    expect(hiddenOf(found.results.find((r: any) => r.card.id === work.code).card), "the search").toBe(1);
  });

  it("the local page and an admin session over the link read no `hiddenUnmet`: they see the numbers themselves", async () => {
    const { db, hidden, work, main } = seed();
    for (const opts of [{ local: true }, {}] as const) {
      const full = (await get(db, `/ui/tasks/cards/${main.code}`, opts)).body;
      expect(full.card.unmetDeps, JSON.stringify(opts)).toEqual([hidden.code]);
      expect("hiddenUnmet" in full.card, JSON.stringify(opts)).toBe(false);
      const row = (await get(db, "/ui/tasks/board", opts)).body.cards.find((c: any) => c.id === work.code);
      expect("hiddenUnmet" in row, JSON.stringify(opts)).toBe(false);
    }
  });

  it("a sub task taken down with a main task kept out of sight (and brought back) does not carry that main task's number in its \"moved\" events; a visible main task's is kept", async () => {
    const db = scratchDb();
    db.board.setCommentRouting({ instances: () => ["dev-a", "ops", "spy"], enabled: () => true });
    const hiddenMain = db.board.createCards(ANN, { cards: [{ title: "Hidden main", assignee: "spy" }] }).cards[0]!;
    const sub = db.board.createCards(ANN, { cards: [{ parent: hiddenMain.code, title: "Visible sub", assignee: "dev-a" }] }).cards[0]!;
    const openMain = db.board.createCards(ANN, { cards: [{ title: "Open main", assignee: "dev-a" }] }).cards[0]!;
    const openSub = db.board.createCards(ANN, { cards: [{ parent: openMain.code, title: "Open sub", assignee: "dev-a" }] }).cards[0]!;
    for (const main of [hiddenMain, openMain]) {
      db.board.moveCard(ANN, main.code, "cancelled", { reason: "no longer needed" });
      db.board.moveCard(ANN, main.code, "open");
    }
    const moves = (body: any) => body.history.filter((e: any) => e.type === "moved").map((e: any) => e.data);
    const link = (await get(db, `/ui/tasks/cards/${sub.code}`, { tier: "read" })).body;
    expect(moves(link).map((d: any) => [d.from, d.to, d.auto])).toEqual([["open", "cancelled", true], ["cancelled", "open", true]]);
    expect(moves(link).some((d: any) => "cascade" in d || "restored" in d), "no `cascade` / `restored` of the hidden main task").toBe(false);
    expect(JSON.stringify(link)).not.toContain(`"${hiddenMain.code}"`);
    const shown = (await get(db, `/ui/tasks/cards/${openSub.code}`, { tier: "read" })).body;
    expect(moves(shown).map((d: any) => [d.cascade, d.restored])).toEqual([[openMain.code, undefined], [undefined, openMain.code]]);
  });

  it("the local page and an admin session over the link still see every number: the dependencies, the \"updated\" events and the cascades", async () => {
    const { db, hidden, plain, work, only } = seed();
    for (const opts of [{ local: true }, {}] as const) {
      const full = (await get(db, `/ui/tasks/cards/${work.code}`, opts)).body;
      expect(full.card.dependsOn, JSON.stringify(opts)).toEqual([plain.code, hidden.code]);
      expect(full.card.unmetDeps, JSON.stringify(opts)).toEqual([plain.code, hidden.code]);
      expect(updates(full).map((e: any) => e.data.changes.dependsOn), JSON.stringify(opts)).toEqual([
        { from: [], to: [hidden.code, plain.code] }, { from: [hidden.code, plain.code], to: [plain.code] }, { from: [plain.code], to: [plain.code, hidden.code] },
      ]);
      expect(updates((await get(db, `/ui/tasks/cards/${only.code}`, opts)).body).map((e: any) => e.data.changes.dependsOn), JSON.stringify(opts))
        .toEqual([{ from: [], to: [hidden.code] }, { from: [hidden.code], to: [] }]);
      expect((await get(db, "/ui/tasks/board", opts)).body.cards.find((c: any) => c.id === work.code).dependsOn, JSON.stringify(opts)).toEqual([plain.code, hidden.code]);
    }
  });
});

describe("4h. who follows a card, from the dashboard", () => {
  const fleetConfig = { defaults: {}, instances: { "dev-a": {}, ops: {}, spy: { cross_instance_visibility: "hidden" } } };
  const named = () => {
    const db = scratchDb();
    db.board.setCommentRouting({ instances: () => ["dev-a", "ops", "spy"], enabled: () => true });
    db.board.createCards(ANN, { cards: [{ title: "Work", assignee: "dev-a" }] });
    return db;
  };

  it("a signed-in person adds and removes watchers; the card's read lists them; a name that is no instance, or a field it does not take, is a 400", async () => {
    const db = named();
    const set = (body: unknown, opts: { tier?: "admin" | "read" } = {}) => viaLink(db, "POST", "/ui/tasks/cards/M-1/watchers", body, { local: true, fleetConfig, ...opts });
    const added = await set({ add: ["ops", "dev-a"] });
    expect(added.status).toBe(200);
    expect(added.body.watchers).toEqual(["ops", "dev-a"]);
    expect(added.body.card).toMatchObject({ id: "M-1", version: 1 });                 // watching does not bump the card's version
    expect((await viaLink(db, "GET", "/ui/tasks/cards/M-1", undefined, { local: true, fleetConfig })).body.watchers).toEqual(["ops", "dev-a"]);
    expect((await set({ remove: ["dev-a"] })).body.watchers).toEqual(["ops"]);
    const ghost = await set({ add: ["ghost"] });
    expect([ghost.status, ghost.body.code, ghost.body.key]).toEqual([400, "invalid", "watcher_unknown"]);
    expect((await set({ add: ["ops"], nothing: 1 })).status).toBe(400);
    expect((await set({ add: ["ops"] }, { tier: "read" })).status).toBe(403);
    expect((await viaLink(db, "POST", "/ui/tasks/cards/M-9/watchers", { add: ["ops"] }, { local: true, fleetConfig })).status).toBe(404);
  });

  it("over the link a read-only session does not see a hidden instance among a card's watchers — not in the card's read as a whole, its history, its logs, a search for it or the board (an admin session and the local page do)", async () => {
    const db = named();
    db.board.setWatchers(ANN, "M-1", { add: ["ops", "spy"] });
    db.board.setWatchers(ANN, "M-1", { remove: ["spy"] });
    db.board.setWatchers(ANN, "M-1", { add: ["spy"] });
    const get = (path: string, opts: { tier?: "admin" | "read"; local?: boolean }) => viaLink(db, "GET", path, undefined, { fleetConfig, ...opts });
    const card = await get("/ui/tasks/cards/M-1", { tier: "read" });
    expect(card.body.watchers).toEqual(["ops"]);
    expect(JSON.stringify(card.body), "the whole read").not.toContain("spy");
    for (const path of ["/ui/tasks/search?q=spy", "/ui/tasks/search?q=watchers", "/ui/tasks/search?q=%2Bspy", "/ui/tasks/board"]) {
      const body = (await get(path, { tier: "read" })).body;
      expect(JSON.stringify(body), `${path} for a read-only session`).not.toContain("spy");
    }
    expect((await get("/ui/tasks/search?q=spy", { tier: "read" })).body.results).toEqual([]);
    // An event that names a hidden instance goes whole (the first one here added ops and spy together); what the person
    // did about visible instances only stays in the history the link shows.
    db.board.setWatchers(ANN, "M-1", { add: ["dev-a"] });
    const after = (await get("/ui/tasks/cards/M-1", { tier: "read" })).body;
    expect(after.history.filter((e: any) => e.type === "logged").map((e: any) => e.data.text)).toEqual(["watchers: +dev-a"]);
    // The admin session over the link and the local page see all of it.
    for (const opts of [{}, { local: true }] as const) {
      const full = (await get("/ui/tasks/cards/M-1", opts)).body;
      expect(full.watchers).toEqual(["ops", "spy", "dev-a"]);
      expect(full.history.filter((e: any) => e.type === "logged").map((e: any) => e.data.text)).toContain("watchers: +ops, +spy");
    }
  });

  it("the card's read names its leader and a sub task's inherited watchers; over the link a hidden instance is named in neither (the leader reads as none), and the local page sees all", async () => {
    const db = named();
    const project = db.board.createProject(ANN, { name: "Game" });
    db.board.updateProject(ANN, project.id, { leadInstance: "spy" });
    db.board.setProgressRouting({ enabled: () => true, leader: () => "ops" });
    const main = db.board.createCards(ANN, { project: "Game", cards: [{ title: "Main", assignee: "dev-a" }] }).cards[0]!;
    db.board.setWatchers(ANN, main.code, { add: ["ops", "spy"] });
    const sub = db.board.createCards(ANN, { cards: [{ parent: main.code, title: "Sub" }] }).cards[0]!;
    const get = (code: string, opts: { tier?: "admin" | "read"; local?: boolean }) => viaLink(db, "GET", `/ui/tasks/cards/${code}`, undefined, { fleetConfig, ...opts });

    const local = (await get(sub.code, { local: true })).body;
    expect(local.leader).toEqual({ name: "spy", via: "project" });
    expect(local.inheritedWatchers).toEqual(["ops", "spy"]);
    expect(local.followsProgress).toBe(true);
    const link = (await get(sub.code, { tier: "read" })).body;
    expect(link.leader, "a hidden lead reads as none").toBeNull();
    expect(link.inheritedWatchers).toEqual(["ops"]);
    expect(JSON.stringify(link)).not.toContain("spy");
    // A visible leader is named over the link too, and the project's lead (here none) falls back to the board's default.
    db.board.updateProject(ANN, project.id, { leadInstance: null });
    expect((await get(main.code, { tier: "read" })).body.leader).toEqual({ name: "ops", via: "board" });
  });

  it("a sub task whose main task is kept out of sight reads no inherited watchers over the link (its `parent` reads as none): not even the visible instances among them; the local page still sees them", async () => {
    const db = named();
    // The main task is held by a hidden instance; a visible instance watches it. Its sub task is held by a visible one.
    const main = db.board.createCards(ANN, { cards: [{ title: "Hidden main", assignee: "spy" }] }).cards.find((c) => c.title === "Hidden main")!;
    db.board.setWatchers(ANN, main.code, { add: ["ops", "dev-a"] });
    const sub = db.board.createCards(ANN, { cards: [{ parent: main.code, title: "Visible sub", assignee: "dev-a" }] }).cards[0]!;
    const get = (code: string, opts: { tier?: "admin" | "read"; local?: boolean }) => viaLink(db, "GET", `/ui/tasks/cards/${code}`, undefined, { fleetConfig, ...opts });

    const link = (await get(sub.code, { tier: "read" })).body;
    expect(link.card.id).toBe(sub.code);
    expect(link.parent, "the hidden main task is not named").toBeNull();
    expect(link.inheritedWatchers, "…nor are the visible instances that watch it").toEqual([]);
    // The local page and an admin session over the link see the main task, and what follows the sub task from it.
    for (const opts of [{ local: true }, {}] as const) {
      const full = (await get(sub.code, opts)).body;
      expect(full.parent?.id, JSON.stringify(opts)).toBe(main.code);
      expect(full.inheritedWatchers, JSON.stringify(opts)).toEqual(["ops", "dev-a"]);
    }
  });
});

describe("4i. a card as a chat shows it (`/ui/tasks/refs`), over the link", () => {
  const fleetConfig = { defaults: {}, instances: { "dev-a": {}, ops: {}, spy: { cross_instance_visibility: "hidden" } } };
  const seed = () => {
    const db = scratchDb();
    const hidden = db.board.createCards(ANN, { cards: [{ title: "Hidden main for the link", assignee: "spy" }] }).cards[0]!;
    const sub = db.board.createCards(ANN, { cards: [{ parent: hidden.code, title: "Visible sub of it", assignee: "dev-a" }] }).cards[0]!;
    const open = db.board.createCards(ANN, { cards: [{ title: "Open main for the link", assignee: "ops" }] }).cards[0]!;
    return { db, hidden, sub, open };
  };
  const ask = (db: SchedulerDb, query: string, opts: { tier?: "admin" | "read"; local?: boolean }) => viaLink(db, "GET", `/ui/tasks/refs${query}`, undefined, { fleetConfig, ...opts });
  const codes = (body: any) => (body.refs as Array<{ code: string }>).map((r) => r.code);

  it("a card kept out of sight is neither answered by its number nor offered by its words, and nothing in the answer names it; the dashboard reads every card", async () => {
    const { db, hidden, sub, open } = seed();
    const byNumber = `?codes=${[hidden.code, sub.code, open.code].join(",")}`;
    const link = (await ask(db, byNumber, { tier: "read" })).body;
    expect(codes(link)).toEqual([sub.code, open.code]);
    expect(JSON.stringify(link), "the hidden card's number and title are nowhere in the answer").not.toContain(hidden.code);
    expect(JSON.stringify(link)).not.toContain("Hidden main");
    const offered = (await ask(db, "?q=", { tier: "read" })).body;
    expect(codes(offered).sort()).toEqual([sub.code, open.code].sort());
    expect(codes((await ask(db, "?q=Hidden", { tier: "read" })).body), "searched by its title").toEqual([]);
    expect(codes((await ask(db, `?q=${hidden.code}`, { tier: "read" })).body), "searched by its number").toEqual([]);
    // An admin session over the link, and the dashboard itself, read as they did before.
    expect(codes((await ask(db, byNumber, { tier: "admin" })).body)).toEqual([hidden.code, sub.code, open.code]);
    expect(codes((await ask(db, byNumber, { local: true })).body)).toEqual([hidden.code, sub.code, open.code]);
  });

  // An agent's reply names cards with `#M-n` as a person's message does, and the page draws a chip from the same answer
  // (src/ui/chat-task-refs.js, shared/chat-render.js). The writer changes nothing about what the viewer may be shown.
  it("an agent's reply that names a hidden card gets no chip over the link — the number stays text, and no title, status or owner of it is drawn; the dashboard and an admin session draw it", async () => {
    const { db, hidden, sub, open } = seed();
    const reply = `Done: #${hidden.code}, its step #${sub.code} and #${open.code}, and \`#${open.code}\` in code.`;
    const drawn = async (opts: { tier?: "admin" | "read"; local?: boolean }) => {
      const index = createTaskRefIndex(async (url: string) => { const r = await ask(db, url.slice("/ui/tasks/refs".length), opts); return { ok: r.status === 200, json: async () => r.body }; });
      index.ensure([{ role: "agent", text: reply }]);
      for (let i = 0; i < 100 && index.pending(); i++) await Promise.resolve();   // microtasks only: this file runs on fake timers
      for (let i = 0; i < 5; i++) await Promise.resolve();
      const info = (code: string) => { const v = index.get(code); return v ? { title: v.title, status: v.status, statusLabel: v.status, tip: `${v.code} · ${v.title}${v.assignee ? ` · @${v.assignee}` : ""}` } : null; };
      return (globalThis as any).AgendChatRender.renderMarkdown(reply, { htmlCards: true, taskRefs: info }) as string;
    };
    const chipsOf = (html: string) => [...html.matchAll(/data-task-ref="([MS]-\d+)"/g)].map((m) => m[1]);
    const link = await drawn({ tier: "read" });
    expect(chipsOf(link), "the visible cards are chips, in text order; the hidden one and the code are not").toEqual([sub.code, open.code]);
    expect(link, "the hidden card's number is the text the agent wrote").toContain(`#${hidden.code},`);
    for (const word of ["Hidden main", "spy"]) expect(link, `nothing of the hidden card (${word}) is drawn`).not.toContain(word);
    expect(link).toContain("Open main for the link");
    expect(chipsOf(await drawn({ tier: "admin" })), "an admin session over the link reads every card").toEqual([hidden.code, sub.code, open.code]);
    const local = await drawn({ local: true });
    expect(chipsOf(local), "the dashboard itself too").toEqual([hidden.code, sub.code, open.code]);
    expect(local).toContain("Hidden main for the link");
  });
});

describe("4e. #2756: whom a card waits for, through the routes (#2757 review: a dispatcher deleted, caches warm)", () => {
  it("lead's card in review is lead's to confirm — on the board, the card's own read and the work drawer; once lead is deleted, the person's on all three", async () => {
    const h = rig();
    const me = await h.signIn("admin");
    const lead = { kind: "instance" as const, name: "lead" }, dev = { kind: "instance" as const, name: "dev-a" };
    (h.fm.fleetConfig as any).instances.lead = { working_directory: h.dir };
    (h.fm.fleetConfig as any).instances["dev-a"] = { working_directory: h.dir };
    const card = h.db.board.createCards(lead, { cards: [{ title: "Review PR 42", assignee: "dev-a", needsReview: true }] }).cards[0]!;
    h.db.board.moveCard(dev, card.code, "claimed");
    h.db.board.moveCard(dev, card.code, "review", { result: "r" });
    const seen = async () => {
      const board = (await web(h, "/ui/tasks/board", "GET", me)).json();
      const detail = (await web(h, `/ui/tasks/cards/${card.code}`, "GET", me)).json();
      const work = (await web(h, "/ui/tasks/work?instance=dev-a", "GET", me)).json();
      const pick = (c: any) => [c.waitsForPerson, c.confirmer];
      return { board: pick(board.cards.find((c: any) => c.id === card.code)), waiting: board.stats.none.waiting, detail: pick(detail.card), work: pick(work.instances[0].review[0]) };
    };
    expect(await seen()).toEqual({ board: [false, "lead"], waiting: 0, detail: [false, "lead"], work: [false, "lead"] });
    delete (h.fm.fleetConfig as any).instances.lead;                    // deleted; the board itself unchanged (its revision too)
    expect(await seen()).toEqual({ board: [true, null], waiting: 1, detail: [true, null], work: [true, null] });
  });
});

describe("5. revisions, refusals and notes the page can say in its language", () => {
  it("a page with the current revision is told so; a write moves it", async () => {
    const db = scratchDb();
    const first = await viaLink(db, "GET", "/ui/tasks/board", undefined, { local: true });
    expect(first.body.rev).toBe(0);
    // #4428 review: with the epoch it read (where time had left the board's lines); without one, the board again.
    expect((await viaLink(db, "GET", `/ui/tasks/board?rev=0&epoch=${encodeURIComponent(first.body.epoch)}`, undefined, { local: true })).body).toEqual({ rev: 0, epoch: first.body.epoch, unchanged: true });
    expect((await viaLink(db, "GET", "/ui/tasks/board?rev=0", undefined, { local: true })).body.unchanged).toBeUndefined();
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

  it("over the public link the board is built for each read — it is filtered per request (instances kept out of sight; a read-only session, M-3278)", async () => {
    const db = scratchDb();
    const fleetConfig = { defaults: {}, instances: { quiet: { cross_instance_visibility: "hidden" } } };
    db.board.createCards(ANN, { cards: [{ title: "Seen" }, { title: "Quiet's", assignee: "quiet" }] });
    const local = await viaLink(db, "GET", "/ui/tasks/board", undefined, { local: true, fleetConfig });
    expect(local.body.cards.map((c: any) => c.title).sort()).toEqual(["Quiet's", "Seen"]);
    const views = vi.spyOn(db.board, "views");
    const l1 = await viaLink(db, "GET", "/ui/tasks/board", undefined, { fleetConfig, tier: "read" });
    const l2 = await viaLink(db, "GET", "/ui/tasks/board", undefined, { fleetConfig, tier: "read" });
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
    expect(await tool({ action: "get", detail:true, id: "M-1" })).toMatch(/comments \(1 new\):\n c\d+ admin .* \(sent back\) \[new\]: the changelog entry is missing/);
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

  it("a waiting card's lane: its project's lead (sub tasks by their main), else none; an instance's handed-out card waits for no one there (#2434)", () => {
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
    // #2425/#2434: a card waits for the person only when the person handed it out (S-1, by its main's Ann; M-3–M-5); the
    // ones an instance handed out (M-2, M-6) are that instance's own to confirm, in no Needs you and no lane.
    h.db.board.moveCard(dev, "S-1", "claimed"); h.db.board.moveCard(dev, "S-1", "blocked", { reason: "?" });
    for (const code of ["M-2", "M-3", "M-4", "M-5", "M-6"]) { h.db.board.moveCard(dev, code, "claimed"); h.db.board.moveCard(ann, code, "review"); }
    expect(lanes(h)).toEqual({ "S-1": "lead", "M-3": null, "M-4": null, "M-5": null });
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

  it("over the public link a hidden lead is not named to a read-only session (M-3278: an admin's sees it)", async () => {
    const db = scratchDb();
    db.board.createProject(ANN, { name: "Secret", leadInstance: "spy" });
    db.board.createProject(ANN, { name: "Open", leadInstance: "dev-a" });
    const fleetConfig = { defaults: {}, instances: { "dev-a": {}, spy: { cross_instance_visibility: "hidden" } } };
    const link = (await viaLink(db, "GET", "/ui/tasks/board", undefined, { fleetConfig, tier: "read" })).body;
    expect(link.projects.map((p: any) => [p.name, p.leadInstance])).toEqual([["Secret", null], ["Open", "dev-a"]]);
    expect((await viaLink(db, "GET", "/ui/tasks/board", undefined, { fleetConfig })).body.projects.map((p: any) => p.leadInstance), "M-3278: an admin over the link").toEqual(["spy", "dev-a"]);
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

  it("with needs_you.live_message off, the lane's wake keeps the ordinary words (no buttons exist)", () => {
    const h = rig();
    (h.fm.fleetConfig as any).instances = { ...(h.fm.fleetConfig as any).instances, lead: { working_directory: h.dir, channel_id: "owner", topic_id: "T5" } };
    h.fm.routing.rebuild(h.fm.fleetConfig!);
    const ann = { kind: "person" as const, name: "Ann" }, dev = { kind: "instance" as const, name: "dev-a" };
    const led = h.db.board.createProject(ann, { name: "Led", leadInstance: "lead" });
    const card = h.db.board.createCards(ann, { project: led.id, cards: [{ title: "Ties", assignee: "dev-a" }] }).cards[0]!;
    h.db.board.moveCard(dev, card.code, "claimed"); h.db.board.moveCard(ann, card.code, "review");
    // #2434: the lead's own handed-out card waits for no one: no buttons, in its channel or anywhere (before: "here").
    const own = h.db.board.createCards({ kind: "instance", name: "lead" }, { project: led.id, cards: [{ title: "Lead's", assignee: "dev-a", needsReview: true }] }).cards[0]!;
    h.db.board.moveCard(dev, own.code, "claimed"); h.db.board.moveCard(ann, own.code, "review");
    const here = (uuid: string) => h.s.taskBoardWaker ? (h.s.taskBoardWaker as any).deps.buttonsHere("lead", uuid) : undefined;
    h.s.attachTaskBoard?.(h.db);
    expect([here(card.uuid), here(own.uuid)]).toEqual([true, false]);
    (h.fm.fleetConfig as any).needs_you = { live_message: false };
    expect(here(card.uuid)).toBe(false);
  });
});
