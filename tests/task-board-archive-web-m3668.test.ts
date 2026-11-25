/**
 * M-3668: the board's web routes with archiving (tests/task-board-archive-m3668.test.ts has the rule and the page):
 * GET /ui/tasks/board leaves archived main tasks out and says how many and after how many days; /ui/tasks/archive lists a
 * project's; search and a card's page mark one; `defaults.task_board.archive_after_days: 0` archives nothing.
 * The real web handler, a real FleetManager (no fleet; nothing spawns), a real scheduler database.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw Error("No process"); }, execFile: () => { throw Error("No CLI"); }, execFileSync: () => { throw Error("No CLI"); }, execSync: () => { throw Error("No CLI"); }, spawnSync: () => { throw Error("No CLI"); } }));
vi.mock("../src/tmux-manager.js", async (original) => ({ ...await original<typeof import("../src/tmux-manager.js")>(), TmuxManager: new Proxy({}, { get: () => () => { throw Error("No tmux"); } }) }));
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } }) }));
import { SchedulerDb } from "../src/scheduler/db.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import type { Actor, TaskBoard } from "../src/scheduler/task-board.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const DAY = 86_400_000;
const dirs: string[] = [], dbs: SchedulerDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function finished(board: TaskBoard, title: string, days: number) {
  const c = board.createCards(ANN, { cards: [{ title, assignee: "dev-a" }] }).cards[0]!;
  board.moveCard(ANN, c.code, "done", { result: "r" });
  const at = new Date(Date.now() - days * DAY).toISOString();
  (board as any).db.prepare("UPDATE tasks SET done_at = ?, updated_at = ? WHERE code = ?").run(at, at, c.code);
  return board.getCard(c.code);
}
let FleetManager: any, handleWebRequest: any;
beforeAll(async () => { ({ FleetManager } = await import("../src/fleet-manager.js")); ({ handleWebRequest } = await import("../src/web-api.js")); }, 120_000);


describe("the web routes", () => {
  const TOKEN = "c".repeat(48), HOST = "127.0.0.1:19280", ORIGIN = `http://${HOST}`;
  async function rig(taskBoard: Record<string, unknown> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "agend-3668-")); dirs.push(dir);
    const fm = new FleetManager(dir), s = fm as any;
    fm.fleetConfig = { defaults: { task_board: taskBoard }, instances: { general: { working_directory: dir, general_topic: true } } } as never;
    writeFileSync(join(dir, "web.token"), TOKEN, { mode: 0o600 }); s.initializeWebSessions();
    const db = new SchedulerDb(join(dir, "scheduler.db")); dbs.push(db);
    s.scheduler = { db };
    return { fm, board: db.board };
  }
  async function get(fm: unknown, path: string) {
    const req = Object.assign(new EventEmitter(), { method: "GET", url: path, headers: { host: HOST, origin: ORIGIN, "x-agend-token": TOKEN }, destroy: vi.fn(), socket: { destroy() {}, remoteAddress: "127.0.0.1" } });
    let status = 0, text = "";
    const res = Object.assign(new EventEmitter(), { destroyed: false, headersSent: false, setHeader() {}, writeHead: (c: number) => { status = c; }, end: (t = "") => { text = t; }, write() { return true; }, destroy: vi.fn() });
    expect(handleWebRequest(req as never, res as never, new URL(path, ORIGIN), fm as never)).toBe(true);
    for (let n = 0; n < 6; n++) await new Promise((r) => setImmediate(r));
    return { status, body: text ? JSON.parse(text) : null };
  }
  it("the board read leaves archived cards out and says so; the Archive, search and a card's page find them", async () => {
    const { fm, board } = await rig();
    const fresh = finished(board, "Fresh", 1), old = finished(board, "Shipped long ago", 5);
    const b = await get(fm, "/ui/tasks/board");
    expect([b.status, b.body.archiveAfterDays, b.body.cards.map((c: any) => c.id).includes(fresh.code), b.body.cards.map((c: any) => c.id).includes(old.code)]).toEqual([200, 3, true, false]);
    expect([b.body.stats.none.archived, b.body.stats.none.doneWeek, b.body.stats.none.archivedWeek]).toEqual([1, 2, 1]);
    const a = await get(fm, "/ui/tasks/archive?project=none");
    expect([a.status, a.body.cards.map((c: any) => c.id), a.body.total]).toEqual([200, [old.code], 1]);
    expect((await get(fm, "/ui/tasks/archive?project=x")).status).toBe(400);
    const s = await get(fm, "/ui/tasks/search?q=Shipped");
    expect(s.body.results.map((r: any) => [r.card.id, r.archived ?? false])).toEqual([[old.code, true]]);
    const d = await get(fm, `/ui/tasks/cards/${old.code}`);
    expect([d.status, d.body.archived, d.body.archiveAfterDays]).toEqual([200, true, 3]);
  });
  it("archive_after_days 0: nothing is archived (the board as before)", async () => {
    const { fm, board } = await rig({ archive_after_days: 0 });
    const old = finished(board, "Shipped long ago", 5);
    const b = await get(fm, "/ui/tasks/board");
    expect([b.body.archiveAfterDays, b.body.cards.map((c: any) => c.id).includes(old.code), b.body.stats.none.archived]).toEqual([0, true, 0]);
  });
});

// #4428 review (Prism): the Archive over the public link, and the board's "same revision" answer when time moved a card.
describe("#4428 review: the web routes", () => {
  const TOKEN = "d".repeat(48);
  /** One request as the public link's read-only page (a gateway session) — tests/web-task-board.test.ts's viaLink. */
  function viaLink(db: SchedulerDb, path: string, fleetConfig: unknown, opts: { local?: boolean; tier?: "admin" | "read" } = {}) {
    const sessions = new WebSessionStore(), exposureId = "a".repeat(32), pub = "https://sample.trycloudflare.com", local = "http://127.0.0.1:19280";
    const s = sessions.create({ tier: opts.tier ?? "read", surface: opts.local ? "local" : "gateway", exposureId: opts.local ? undefined : exposureId, label: "t", tokenEpoch: tokenEpoch(TOKEN) } as never);
    const origin = opts.local ? local : pub;
    const headers: Record<string, string> = { host: new URL(origin).host, cookie: `${opts.local ? "" : "__Host-"}agend_session=${s.sessionId}`, origin, "sec-fetch-site": "same-origin",
      "x-agend-csrf": csrfTokenFor(s.sessionId), "content-type": "application/json" };
    return new Promise<{ status: number; body: any }>((resolve) => {
      const req = Object.assign(new EventEmitter(), { method: "GET", url: path, headers, destroy: vi.fn() });
      if (!opts.local) bindGatewayRequest(req as never, { surface: "gateway", exposureId, expectedOrigin: pub, isCurrent: () => true });
      let status = 0;
      const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader() {}, writeHead: (c: number) => { status = c; },
        end: (t = "") => resolve({ status, body: t ? JSON.parse(String(t)) : null }) });
      handleWebRequest(req as never, res as never, new URL(path, origin), { webToken: TOKEN, webSessions: sessions, scheduler: { db }, fleetConfig,
        logger: { debug() {}, info() {}, warn() {}, error() {} }, getUiStatus: () => ({ instances: [] }), listWebPrompts: () => [], needsYouItems: () => [] } as never);
      req.emit("end");
    });
  }
  function scratch() {
    const dir = mkdtempSync(join(tmpdir(), "agend-4428-")); dirs.push(dir);
    const db = new SchedulerDb(join(dir, "scheduler.db")); dbs.push(db);
    return db;
  }
  const fleetConfig = { defaults: {}, instances: { "dev-a": {}, spy: { cross_instance_visibility: "hidden" } } };

  it("over the link a read-only session's Archive has no hidden instance's card: not in a page, the cursor, the total or the assignees", async () => {
    const db = scratch(), board = db.board;
    const newest = finished(board, "Visible newest", 4);
    const secret = finished(board, "SECRET_ARCHIVED", 5);
    (board as any).db.prepare("UPDATE tasks SET assignee = 'spy' WHERE code = ?").run(secret.code);
    const oldest = finished(board, "Visible oldest", 6);
    const first = await viaLink(db, "/ui/tasks/archive?project=none&limit=1", fleetConfig);
    expect([first.status, first.body.cards.map((c: any) => c.id), first.body.total, first.body.assignees]).toEqual([200, [newest.code], 2, ["dev-a"]]);
    const second = await viaLink(db, `/ui/tasks/archive?project=none&limit=1&before=${encodeURIComponent(first.body.next)}`, fleetConfig);
    expect([second.body.cards.map((c: any) => c.id), second.body.next]).toEqual([[oldest.code], null]);
    const said = JSON.stringify([first.body, second.body]);
    for (const x of [secret.uuid, secret.code, "SECRET_ARCHIVED", "spy"]) expect(said).not.toContain(x);
    // An admin's session over the link and the local page see it whole (M-3278), as the board.
    for (const opts of [{ tier: "admin" as const }, { local: true }]) {
      const all = await viaLink(db, "/ui/tasks/archive?project=none", fleetConfig, opts);
      expect([JSON.stringify(opts), all.body.total, all.body.assignees]).toEqual([JSON.stringify(opts), 3, ["dev-a", "spy"]]);
    }
  });

  it("the board's same-revision read is `unchanged` only while time has moved no card across a line; a page without the epoch gets the board", async () => {
    const db = scratch(), board = db.board;
    const c = finished(board, "Shipped", 2);
    const first = await viaLink(db, "/ui/tasks/board", fleetConfig, { local: true });
    const { rev, epoch } = first.body;
    expect([typeof epoch, first.body.cards.some((x: any) => x.id === c.code)]).toEqual(["string", true]);
    const same = await viaLink(db, `/ui/tasks/board?rev=${rev}&epoch=${encodeURIComponent(epoch)}`, fleetConfig, { local: true });
    expect([same.body.unchanged, same.body.epoch]).toEqual([true, epoch]);
    // An older page (no epoch): the board, never `unchanged`.
    expect((await viaLink(db, `/ui/tasks/board?rev=${rev}`, fleetConfig, { local: true })).body.unchanged).toBeUndefined();
    // A day and a half later (no write: the revision stays) the card is archived: the same question gets the new board.
    const later = new Date(Date.now() - 3.5 * DAY).toISOString();
    (board as any).db.prepare("UPDATE tasks SET done_at = ?, updated_at = ? WHERE code = ?").run(later, later, c.code);
    expect(board.revision()).toBe(rev);
    const moved = await viaLink(db, `/ui/tasks/board?rev=${rev}&epoch=${encodeURIComponent(epoch)}`, fleetConfig, { local: true });
    expect([moved.body.unchanged, moved.body.rev, moved.body.epoch === epoch, moved.body.cards.some((x: any) => x.id === c.code), moved.body.stats.none.archived])
      .toEqual([undefined, rev, false, false, 1]);
  });

  // #4428 review R1 (Prism, 6043264710): the board's metadata over the link is scoped to what the reader may see.
  it("over the link a read-only session's epoch and project numbers leave out hidden instances' cards (an admin and the local page count them)", async () => {
    const db = scratch(), board = db.board;
    // Prism's case: nothing visible, one hidden archived card — plus a hidden live main with a visible-looking step, and
    // one created by the hidden instance and one it handed out.
    const secret = finished(board, "SECRET_ARCHIVED", 5);
    (board as any).db.prepare("UPDATE tasks SET assignee = 'spy' WHERE code = ?").run(secret.code);
    const live = board.createCards(ANN, { cards: [{ title: "Hidden live", assignee: "spy" }] }).cards[0]!;
    const step = board.createCards(ANN, { cards: [{ parent: live.code, title: "Its step", assignee: "dev-a" }] }).cards[0]!;
    board.createCards({ kind: "instance", name: "spy" }, { cards: [{ title: "Made by the spy", assignee: "dev-a" }] });
    const handed = finished(board, "Handed out by the spy", 1);
    (board as any).db.prepare("UPDATE tasks SET dispatcher = 'spy', dispatcher_kind = 'instance' WHERE code = ?").run(handed.code);
    const link = await viaLink(db, "/ui/tasks/board", fleetConfig);
    // The one card the board shows (as before this change): the step, which names no hidden instance; its main task's
    // link is hidden (#2303). It counts in no project number: its main task is not counted.
    expect([link.body.cards.map((c: any) => c.id), link.body.epoch, link.body.stats]).toEqual([[step.code], "3:0:0:0", {}]);
    expect(JSON.stringify(link.body)).not.toMatch(/SECRET_ARCHIVED|Hidden live|Made by the spy|spy/);
    for (const opts of [{ tier: "admin" as const }, { local: true }]) {
      const all = await viaLink(db, "/ui/tasks/board", fleetConfig, opts);
      expect([JSON.stringify(opts), all.body.epoch, all.body.stats.none.archived, all.body.stats.none.mains, all.body.stats.none.doneWeek])
        .toEqual([JSON.stringify(opts), "3:1:0:0", 1, 3, 2]);
    }
    // The link's same-revision read: its own epoch answers `unchanged`; the unscoped one does not.
    const again = await viaLink(db, `/ui/tasks/board?rev=${link.body.rev}&epoch=${encodeURIComponent(link.body.epoch)}`, fleetConfig);
    expect(again.body.unchanged).toBe(true);
  });
});
