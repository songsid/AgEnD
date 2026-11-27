/**
 * A card's handoffs and a main task's sub task moves, through the real web handler and a real FleetManager (docs/design/task-board.md,
 * "Handoffs"):
 *
 *   1. The card read carries `handoffs` (a main task's and its sub tasks' own, with how far each notice got) for a session that can write,
 *      and nothing of them to a read-only one — on the local page or over the link; never a key, a delivery id or a notice's text; an
 *      admin session's whole board names every instance.
 *   2. `subEvents` is read by every session, with the link's hiding: a sub task kept out of sight and a hidden instance's moves are left out.
 *   3. In a FleetManager: when the waker settles a handoff, or its delivery moves, the open pages are told to read the card again — the
 *      sub task's number and its main task's, nothing else.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } }) }));
import { handleWebRequest, withHandoffViews } from "../src/web-api.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { SchedulerDb } from "../src/scheduler/db.js";
import { Scheduler } from "../src/scheduler/index.js";
import { FleetManager } from "../src/fleet-manager.js";
import type { NoticeProgress } from "../src/delivery-outbox.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

const TOKEN = "d".repeat(48);
const ANN = { kind: "person" as const, name: "Ann" };
const DEV_A = { kind: "instance" as const, name: "dev-a" };
const DEV_B = { kind: "instance" as const, name: "dev-b" };
const SPY = { kind: "instance" as const, name: "spy" };
const FLEET = { defaults: {}, instances: { "dev-a": {}, "dev-b": {}, lead: {}, spy: { cross_instance_visibility: "hidden" } } };

const dirs: Array<{ dir: string; db: SchedulerDb | null }> = [];
afterEach(() => { vi.useRealTimers(); for (const h of dirs.splice(0)) { try { h.db?.close(); } catch { /* closed */ } rmSync(h.dir, { recursive: true, force: true }); } });
function scratchDb(): SchedulerDb {
  const dir = mkdtempSync(join(tmpdir(), "agend-task-handoffs-web-"));
  const db = new SchedulerDb(join(dir, "scheduler.db"));
  db.board.setCommentRouting({ instances: () => ["dev-a", "dev-b", "lead", "spy"], enabled: () => true });
  dirs.push({ dir, db });
  return db;
}

type Progress = Map<string, NoticeProgress>;
function call(db: SchedulerDb, method: string, path: string, opts: { local?: boolean; tier?: "admin" | "read"; progress?: Progress } = {}) {
  const sessions = new WebSessionStore(), exposureId = "a".repeat(32), pub = "https://sample.trycloudflare.com", local = "http://127.0.0.1:19280";
  const s = sessions.create({ tier: opts.tier ?? "admin", surface: opts.local ? "local" : "gateway", exposureId: opts.local ? undefined : exposureId, label: "t", tokenEpoch: tokenEpoch(TOKEN) } as never);
  const origin = opts.local ? local : pub;
  const headers: Record<string, string> = { host: new URL(origin).host, cookie: `${opts.local ? "" : "__Host-"}agend_session=${s.sessionId}`, origin, "sec-fetch-site": "same-origin",
    "x-agend-csrf": csrfTokenFor(s.sessionId), "content-type": "application/json" };
  return new Promise<{ status: number; body: any; raw: string }>((resolve) => {
    const req = Object.assign(new EventEmitter(), { method, url: path, headers, destroy: vi.fn() });
    if (!opts.local) bindGatewayRequest(req as never, { surface: "gateway", exposureId, expectedOrigin: pub, isCurrent: () => true });
    let status = 0;
    const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader() {}, writeHead: (c: number) => { status = c; },
      end: (t = "") => resolve({ status, raw: String(t), body: t ? JSON.parse(String(t)) : null }) });
    handleWebRequest(req as never, res as never, new URL(path, origin), { webToken: TOKEN, webSessions: sessions, scheduler: { db },
      fleetConfig: FLEET, logger: { debug() {}, info() {}, warn() {}, error() {} },
      taskWakeProgress: (keys: readonly string[]) => new Map([...(opts.progress ?? new Map())].filter(([k]) => keys.includes(k))),
      getUiStatus: () => ({ instances: [] }), listWebPrompts: () => [], needsYouItems: () => [] } as never);
    req.emit("end");
  });
}
const local = { local: true as const };
const NOW = new Date().toISOString();
const progress = (key: string, state: string, extra: Record<string, unknown> = {}): Progress => new Map([[key, { target: "dev-b", state: state as never, createdAt: NOW, finishedAt: null, consumedAt: null, ...extra } as NoticeProgress]]);

/** A main task (in a project) with S-1 (dev-a) and S-2 (dev-b, after S-1); S-1 done, so S-2 is handed to dev-b. */
function seed(db: SchedulerDb, over: { s1?: Record<string, unknown> } = {}) {
  db.board.createProject(ANN, { name: "Game" });
  const main = db.board.createCards(ANN, { project: "Game", cards: [{ title: "Build the game", needsReview: false }] }).cards[0]!;
  const s1 = db.board.createCards(ANN, { cards: [{ parent: main.code, title: "Design doc", assignee: "dev-a", needsReview: false, ...over.s1 }] }).cards[0]!;
  const s2 = db.board.createCards(ANN, { cards: [{ parent: main.code, title: "Prototype", assignee: "dev-b", dependsOn: [s1.code], needsReview: false }] }).cards[0]!;
  db.board.moveCard(s1.assignee === "spy" ? SPY : DEV_A, s1.code, "claimed", {});
  db.board.moveCard(s1.assignee === "spy" ? SPY : DEV_A, s1.code, "done", { result: "ok" });
  return { main, s1, s2, key: `task-board:dev-b:1:1:cards=${s2.uuid}` };
}
const read = async (db: SchedulerDb, code: string, opts: object = local) => (await call(db, "GET", `/ui/tasks/cards/${code}`, opts)).body;

describe("1. the card read carries handoffs for a session that can write", () => {
  it("a main task lists its sub tasks' handoffs: sending, then queued, delivered and read, from what the board kept and what the outbox says", async () => {
    const db = scratchDb();
    const { main, s2, key } = seed(db);
    const view = async (p?: Progress) => ((await read(db, main.code, { ...local, progress: p })).handoffs as any[]).filter((h) => h.card === s2.code);
    expect(await view()).toEqual([expect.objectContaining({ card: s2.code, to: "dev-b", why: "ready", after: "S-1", state: "sending" })]);
    db.board.handoffHanded(s2.uuid, "dev-b", key);
    expect((await view(progress(key, "queued")))[0].state).toBe("queued");
    expect((await view(progress(key, "delivered")))[0].state).toBe("delivered");
    expect((await view(progress(key, "delivered", { consumedAt: "2026-11-26T10:00:20Z" })))[0]).toMatchObject({ state: "read", readAt: "2026-11-26T10:00:20Z" });
    expect((await view(progress(key, "failed")))[0].state).toBe("failed");
  });

  it("the sub task's own page has its own handoffs, and the main task's the whole list; a card with none has no field at all", async () => {
    const db = scratchDb();
    const { main, s1, s2 } = seed(db);
    expect((await read(db, s2.code)).handoffs.map((h: any) => h.card)).toEqual([s2.code]);
    expect((await read(db, main.code)).handoffs.map((h: any) => h.card).sort()).toEqual([s1.code, s2.code].sort());
    const lone = db.board.createCards(ANN, { project: "Game", cards: [{ title: "No handoff", needsReview: false }] }).cards[0]!;
    expect("handoffs" in (await read(db, lone.code))).toBe(false);
  });

  it("is never shown to a read-only session — on the local page or over the link", async () => {
    const db = scratchDb();
    const { main, s2 } = seed(db);
    for (const opts of [{ tier: "read" as const, local: true as const }, { tier: "read" as const }]) {
      for (const code of [main.code, s2.code]) {
        const res = await call(db, "GET", `/ui/tasks/cards/${code}`, opts);
        expect(res.status).toBe(200);
        expect(res.body.handoffs).toBeUndefined();
        expect(res.raw).not.toContain('"handoffs"');
      }
    }
  });

  it("an admin session sees the board whole, over the link too: a hidden instance's handoff is named", async () => {
    const db = scratchDb();
    db.board.createProject(ANN, { name: "Game" });
    const main = db.board.createCards(ANN, { project: "Game", cards: [{ title: "Hidden hands", needsReview: false }] }).cards[0]!;
    const sub = db.board.createCards(ANN, { cards: [{ parent: main.code, title: "A step", assignee: "dev-a", needsReview: false }] }).cards[0]!;
    db.board.createCards(ANN, { cards: [{ parent: main.code, title: "Secret step", assignee: "spy", dependsOn: [sub.code], needsReview: false }] });
    db.board.moveCard(DEV_A, sub.code, "claimed", {});
    db.board.moveCard(DEV_A, sub.code, "done", { result: "ok" });
    expect((await read(db, main.code, local)).handoffs.map((h: any) => h.to).sort()).toEqual(["dev-a", "spy"]);
    expect((await read(db, main.code, {})).handoffs.map((h: any) => h.to).sort()).toEqual(["dev-a", "spy"]);
  });

  it("the card whose finishing readied a handoff is numbered only if the viewer may see it: one kept out of sight reads as none", () => {
    const db = scratchDb();
    const { main, s1, s2 } = seed(db);
    const ctx = { taskWakeProgress: () => new Map() } as never;
    const children = [{ id: s1.code }, { id: s2.code }];
    const ready = (hiddenCode: (c: string) => boolean) => withHandoffViews(db.board, main.code, children, ctx, () => false, hiddenCode).find((h) => h.card === s2.code)!;
    expect(ready(() => false).after, "visible: named").toBe(s1.code);
    expect(ready((c) => c === s1.code), "S-1 kept out of sight: not named").toMatchObject({ card: s2.code, why: "ready", after: null });
    expect(ready((c) => c === "M-99").after, "another hidden card changes nothing").toBe(s1.code);
    expect(JSON.stringify(withHandoffViews(db.board, main.code, children, ctx, () => false, (c) => c === s1.code).find((h) => h.card === s2.code))).not.toContain(s1.code);
    expect(withHandoffViews(db.board, main.code, children, ctx, () => false).find((h) => h.card === s2.code)!.after, "without the rule (as the tests above call it): as stored").toBe(s1.code);
  });

  it("carries no key, delivery id or notice text", async () => {
    const db = scratchDb();
    const { main, s2, key } = seed(db);
    db.board.handoffHanded(s2.uuid, "dev-b", key);
    const res = await call(db, "GET", `/ui/tasks/cards/${main.code}`, { ...local, progress: progress(key, "delivered") });
    expect(res.raw).not.toContain(key);
    expect(res.raw).not.toContain("[Task board]");
  });
});

describe("1b. the board read says when an open card was handed to its assignee", () => {
  it("`handedAt` on the card, for any session that reads the board (a time, no more: nothing of the notice's delivery)", async () => {
    const db = scratchDb();
    const { s2 } = seed(db);
    for (const opts of [local, { tier: "read" as const, local: true as const }, { tier: "read" as const }]) {
      const res = await call(db, "GET", "/ui/tasks/board", opts);
      expect(res.status).toBe(200);
      const view = res.body.cards.find((c: any) => c.id === s2.code);
      expect(view.handedAt).toBe(db.board.handoffsOf([s2.uuid])[0]!.at);
      expect(Object.keys(view).filter((k) => /key|delivery|notice/i.test(k))).toEqual([]);
    }
    expect(JSON.stringify((await call(db, "GET", "/ui/tasks/board", local)).body.cards.filter((c: any) => c.status !== "open").map((c: any) => c.handedAt))).not.toMatch(/\d{4}-/);
  });
});

describe("2. the sub task moves are every session's, with the link's hiding", () => {
  it("a read-only session reads them (they are the card's own history, as a main task's history is)", async () => {
    const db = scratchDb();
    const { main, s1, s2 } = seed(db);
    db.board.moveCard(DEV_B, s2.code, "claimed", {});
    const body = await read(db, main.code, { tier: "read", local: true });
    expect(body.subEvents.map((e: any) => [e.card, e.actor, e.data.to])).toEqual([[s1.code, "dev-a", "claimed"], [s1.code, "dev-a", "done"], [s2.code, "dev-b", "claimed"]]);
    expect(body.subEvents[0].title).toBe("Design doc");
  });

  it("over the link a hidden instance's moves and a sub task kept out of sight are left out; an admin session sees them all", async () => {
    const db = scratchDb();
    const { main, s1, s2 } = seed(db, { s1: { assignee: "spy" } });
    db.board.moveCard(DEV_B, s2.code, "claimed", {});
    const readOnly = (await read(db, main.code, { tier: "read" })).subEvents.map((e: any) => [e.card, e.actor]);
    expect(readOnly, "S-1 is the hidden instance's card: its moves, and the card, are not there").toEqual([[s2.code, "dev-b"]]);
    expect(JSON.stringify(await read(db, main.code, { tier: "read" }))).not.toContain("spy");
    expect((await read(db, main.code, local)).subEvents.map((e: any) => e.card)).toEqual([s1.code, s1.code, s2.code]);
  });
});

describe("3. in a FleetManager: the open pages are told to read the card again", () => {
  async function fleet() {
    vi.useFakeTimers();
    const d = mkdtempSync(join(tmpdir(), "task-board-handoffs-fm-")); dirs.push({ dir: d, db: null });
    writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
    const fm = new FleetManager(d) as unknown as Record<string, any>;
    fm.fleetConfig = { defaults: {}, instances: { lead: {}, "dev-a": {}, "dev-b": {}, quiet: { dashboard: { task_board: false } } } };
    fm.ensureDeliveryOutbox();
    const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
    fm.scheduler = scheduler;
    const events: Array<[string, any]> = [];
    fm.emitSseEvent = (event: string, data: any) => { events.push([event, data]); };
    fm.attachTaskBoard(scheduler.db);
    const wakeEvents = () => events.filter(([e]) => e === "task_wakes").map(([, data]) => data);
    const stop = () => { fm.taskBoardWaker.stop(); fm.deliveryOutbox?.close?.(); scheduler.db.close(); };
    return { fm, d, board: scheduler.db.board, wakeEvents, stop };
  }

  it("S-1 done: once the waker hands S-2's notice over, the page of S-2 and of its main task read again — their numbers and nothing else", async () => {
    const f = await fleet();
    f.board.createProject(ANN, { name: "Game" });
    const main = f.board.createCards(ANN, { project: "Game", cards: [{ title: "Build the game", needsReview: false }] }).cards[0]!;
    const s1 = f.board.createCards(ANN, { cards: [{ parent: main.code, title: "Design doc", assignee: "dev-a", needsReview: false }] }).cards[0]!;
    const s2 = f.board.createCards(ANN, { cards: [{ parent: main.code, title: "Prototype", assignee: "dev-b", dependsOn: [s1.code], needsReview: false }] }).cards[0]!;
    await vi.advanceTimersByTimeAsync(10_000);                                // S-1's assignment notice
    f.board.moveCard(DEV_A, s1.code, "claimed", {});
    f.board.moveCard(DEV_A, s1.code, "done", { result: "ok" });
    const before = f.wakeEvents().length;
    expect(f.board.handoffsOf([s2.uuid])[0]).toMatchObject({ why: "ready" });
    expect(f.board.handoffsOf([s2.uuid])[0]!.key).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    const handoff = f.board.handoffsOf([s2.uuid])[0]!;
    expect(handoff.key, "the outbox's key").toBeTruthy();
    const pings = f.wakeEvents().slice(before);
    expect(pings.flatMap((p) => p.ids)).toEqual(expect.arrayContaining([s2.code, main.code]));
    expect(pings.every((p) => Object.keys(p).join() === "ids")).toBe(true);
    // The row moves in the outbox: delivered, then consumed — the same two cards are told each time.
    const raw = new Database(join(f.d, "delivery-outbox.db"));
    try {
      const row = raw.prepare("SELECT delivery_id FROM deliveries WHERE source_key = ?").get(handoff.key) as { delivery_id: string };
      const n = f.wakeEvents().length;
      raw.prepare("UPDATE deliveries SET state='delivered', finished_at=?, updated_at=? WHERE source_key=?").run(new Date().toISOString(), new Date().toISOString(), handoff.key);
      f.fm.noteTaskWakeDelivery(row.delivery_id);
      expect(f.wakeEvents().slice(n).flatMap((p) => p.ids).sort()).toEqual([main.code, s2.code].sort());
      expect(f.fm.taskWakeProgress([handoff.key!]).get(handoff.key!)?.state).toBe("delivered");
    } finally { raw.close(); }
    f.stop();
  });

  it("an instance with its task board off: the handoff says so at once (no wait for the outbox) and the pages are told", async () => {
    const f = await fleet();
    f.board.createProject(ANN, { name: "Game" });
    const main = f.board.createCards(ANN, { project: "Game", cards: [{ title: "Build the game", needsReview: false }] }).cards[0]!;
    const s1 = f.board.createCards(ANN, { cards: [{ parent: main.code, title: "Design doc", assignee: "dev-a", needsReview: false }] }).cards[0]!;
    const s2 = f.board.createCards(ANN, { cards: [{ parent: main.code, title: "Prototype", assignee: "dev-b", dependsOn: [s1.code], needsReview: false }] }).cards[0]!;
    await vi.advanceTimersByTimeAsync(10_000);
    f.fm.fleetConfig = { defaults: {}, instances: { lead: {}, "dev-a": {}, "dev-b": { dashboard: { task_board: false } }, quiet: {} } };
    f.board.moveCard(DEV_A, s1.code, "claimed", {});
    f.board.moveCard(DEV_A, s1.code, "done", { result: "ok" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.board.handoffsOf([s2.uuid])[0]).toMatchObject({ to: "dev-b", skip: "board_off" });
    f.stop();
  });
});
