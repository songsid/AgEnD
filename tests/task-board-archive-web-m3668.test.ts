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
    expect([b.body.stats.none.archived, b.body.stats.none.doneWeek]).toEqual([1, 2]);
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
