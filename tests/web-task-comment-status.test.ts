/**
 * A comment's status and the person's unread, through the real web handler and a real FleetManager
 * (docs/design/task-board.md, "Comment status" and "Unread"):
 *
 *   1. The card read carries each comment's status for a session that can write: sending → queued → delivered → read, from the
 *      delivery outbox — and nothing of it to a read-only session, over the link or not; nothing of an instance kept out of sight.
 *   2. GET /ui/tasks/unread and POST /ui/tasks/cards/<id>/read: the person's own, by card number; a read-only session has no
 *      one (disabled, a mark is refused); the answer carries no text.
 *   3. In a FleetManager: the waker's hand-over and the outbox's own state and consumed marks tell the open pages to read again —
 *      the card numbers only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } }) }));
import { handleWebRequest, wakeViews } from "../src/web-api.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { SchedulerDb } from "../src/scheduler/db.js";
import { Scheduler } from "../src/scheduler/index.js";
import { FleetManager } from "../src/fleet-manager.js";
import type { NoticeProgress } from "../src/delivery-outbox.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

const TOKEN = "c".repeat(48);
const ANN = { kind: "person" as const, name: "Ann" };
const WEB = { kind: "person" as const, name: "web-user" };
const DEV = { kind: "instance" as const, name: "dev-a" };
const SPY = { kind: "instance" as const, name: "spy" };
const FLEET = { defaults: {}, instances: { "dev-a": {}, lead: {}, spy: { cross_instance_visibility: "hidden" } } };

const dirs: Array<{ dir: string; db: SchedulerDb | null }> = [];
afterEach(() => { vi.useRealTimers(); for (const h of dirs.splice(0)) { try { h.db?.close(); } catch { /* closed */ } rmSync(h.dir, { recursive: true, force: true }); } });
function scratchDb(): SchedulerDb {
  const dir = mkdtempSync(join(tmpdir(), "agend-task-status-web-"));
  const db = new SchedulerDb(join(dir, "scheduler.db"));
  db.board.setCommentRouting({ instances: () => ["dev-a", "lead", "spy"], enabled: () => true });
  dirs.push({ dir, db });
  return db;
}

type Progress = Map<string, NoticeProgress>;
/** One request as an admin or read-only session, on the local page or over the temporary public link. */
function call(db: SchedulerDb, method: string, path: string, body?: unknown, opts: { local?: boolean; tier?: "admin" | "read"; progress?: Progress; name?: string; owner?: string } = {}) {
  const sessions = new WebSessionStore(), exposureId = "a".repeat(32), pub = "https://sample.trycloudflare.com", local = "http://127.0.0.1:19280";
  const s = sessions.create({ tier: opts.tier ?? "admin", surface: opts.local ? "local" : "gateway", exposureId: opts.local ? undefined : exposureId, label: "t", tokenEpoch: tokenEpoch(TOKEN), ...(opts.owner ? { owner: { adapterId: "owner", userId: opts.owner } } : {}) } as never);
  const origin = opts.local ? local : pub;
  const headers: Record<string, string> = { host: new URL(origin).host, cookie: `${opts.local ? "" : "__Host-"}agend_session=${s.sessionId}`, origin, "sec-fetch-site": "same-origin",
    "x-agend-csrf": csrfTokenFor(s.sessionId), "content-type": "application/json" };
  return new Promise<{ status: number; body: any; raw: string }>((resolve) => {
    const req = Object.assign(new EventEmitter(), { method, url: path, headers, destroy: vi.fn() });
    if (!opts.local) bindGatewayRequest(req as never, { surface: "gateway", exposureId, expectedOrigin: pub, isCurrent: () => true });
    let status = 0;
    const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader() {}, writeHead: (c: number) => { status = c; },
      end: (t = "") => resolve({ status, raw: String(t), body: t ? JSON.parse(String(t)) : null }) });
    // People kept (`owner`): each signed-in account is someone, whatever its name — two that set none are both "web-user".
    const webPerson = (owner?: { userId: string }) => ({ key: `acct:${owner?.userId ?? "operator"}`, bound: !!owner, userId: owner?.userId ?? "web-user", voterKey: `owner:${owner?.userId}`, name: "web-user", set: false });
    handleWebRequest(req as never, res as never, new URL(path, origin), { webToken: TOKEN, webSessions: sessions, scheduler: { db },
      fleetConfig: FLEET, logger: { debug() {}, info() {}, warn() {}, error() {} }, ...(opts.owner ? { webPerson } : {}),
      taskWakeProgress: (keys: readonly string[]) => new Map([...(opts.progress ?? new Map())].filter(([k]) => keys.includes(k))),
      getUiStatus: () => ({ instances: [] }), listWebPrompts: () => [], needsYouItems: () => [] } as never);
    if (body !== undefined) { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); } else { req.emit("end"); }
  });
}
const local = { local: true as const };
const seed = (db: SchedulerDb) => {
  db.board.createProject(ANN, { name: "Game" });
  return db.board.createCards(ANN, { project: "Game", cards: [{ title: "Ship it", assignee: "dev-a" }] }).cards[0]!;
};
const entryOf = (db: SchedulerDb, code = "M-1") => db.board.detail(code).comments.at(-1)!.id;
const NOW = new Date().toISOString();
const progress = (key: string, state: string, extra: Record<string, unknown> = {}): Progress => new Map([[key, { target: "dev-a", state: state as never, createdAt: NOW, finishedAt: null, consumedAt: null, ...extra } as NoticeProgress]]);

describe("1. the card read carries each comment's status", () => {
  it("sending, then queued, delivered and read — from what the board kept and what the outbox says", async () => {
    const db = scratchDb();
    const c = seed(db);
    await call(db, "POST", `/ui/tasks/cards/${c.code}`, { comment: "how is it going?" }, local);
    const id = entryOf(db);
    const read = async (p?: Progress) => (await call(db, "GET", `/ui/tasks/cards/${c.code}`, undefined, { ...local, progress: p })).body.comments.find((e: any) => e.id === id).wakes;
    expect(await read()).toEqual([expect.objectContaining({ to: "dev-a", why: "assignee", state: "sending" })]);
    db.board.wakeHanded(c.uuid, "dev-a", "task-board:dev-a:1:1:cards=" + c.uuid);
    const key = "task-board:dev-a:1:1:cards=" + c.uuid;
    expect((await read(progress(key, "queued")))[0].state).toBe("queued");
    expect((await read(progress(key, "delivered")))[0].state).toBe("delivered");
    expect((await read(progress(key, "delivered", { consumedAt: "2026-11-26T10:00:20Z" })))[0]).toMatchObject({ state: "read", readAt: "2026-11-26T10:00:20Z" });
    expect((await read(progress(key, "failed")))[0].state).toBe("failed");
  });

  it("a comment nobody was meant to hear has no status; a refusal (unknown name) is shown as skipped with its reason", async () => {
    const db = scratchDb();
    const c = seed(db);
    await call(db, "POST", `/ui/tasks/cards/${c.code}`, { comment: "to myself", to: [] }, local);
    await call(db, "POST", `/ui/tasks/cards/${c.code}`, { comment: "@nobody-here hi", to: [] }, local);
    const comments = (await call(db, "GET", `/ui/tasks/cards/${c.code}`, undefined, local)).body.comments;
    expect(comments[0].wakes).toBeUndefined();
    expect(comments[1].wakes).toEqual([expect.objectContaining({ to: "nobody-here", state: "skipped", skip: "unknown" })]);
  });

  it("is never shown to a read-only session — on the local page or over the link — and a deleted comment has none", async () => {
    const db = scratchDb();
    const c = seed(db);
    await call(db, "POST", `/ui/tasks/cards/${c.code}`, { comment: "hello" }, local);
    for (const opts of [{ tier: "read" as const, local: true as const }, { tier: "read" as const }]) {
      const body = (await call(db, "GET", `/ui/tasks/cards/${c.code}`, undefined, opts)).body;
      expect(body.comments[0].wakes).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('"wakes"');
    }
    const id = entryOf(db);
    await call(db, "POST", `/ui/tasks/cards/${c.code}/comments/${id}/delete`, {}, local);
    expect((await call(db, "GET", `/ui/tasks/cards/${c.code}`, undefined, local)).body.comments[0].wakes).toBeUndefined();
  });

  it("over the link an instance kept out of sight is not named in a status (its own session sees the board whole)", async () => {
    const db = scratchDb();
    const c = seed(db);
    await call(db, "POST", `/ui/tasks/cards/${c.code}`, { comment: "@spy and @lead", to: [] }, local);
    const names = async (opts: object) => ((await call(db, "GET", `/ui/tasks/cards/${c.code}`, undefined, opts)).body.comments[0].wakes ?? []).map((w: any) => w.to).sort();
    expect(await names(local)).toEqual(["lead", "spy"]);                         // an admin session on the local page sees it whole
    expect(await names({})).toEqual(["lead", "spy"]);                            // …and an admin session over the link too
  });

  it("carries no key, delivery id or notice text", async () => {
    const db = scratchDb();
    const c = seed(db);
    await call(db, "POST", `/ui/tasks/cards/${c.code}`, { comment: "hello" }, local);
    const key = "task-board:dev-a:9:9:cards=" + c.uuid;
    db.board.wakeHanded(c.uuid, "dev-a", key);
    const res = await call(db, "GET", `/ui/tasks/cards/${c.code}`, undefined, { ...local, progress: progress(key, "delivered") });
    expect(res.raw).not.toContain(key);
    expect(res.raw).not.toContain("[Task board]");
  });

  it("wakeViews keeps the stages apart even when the outbox has several notices", () => {
    const at = NOW;
    const views = wakeViews([{ to: "dev-a", why: "assignee", at, key: "a" }, { to: "lead", why: "mention", at, key: "b" }],
      new Map<string, NoticeProgress>([["a", { target: "dev-a", state: "delivered", createdAt: at, finishedAt: at, consumedAt: at }], ["b", { target: "lead", state: "queued", createdAt: at, finishedAt: null, consumedAt: null }]]), Date.now());
    expect(views.map((v) => [v.to, v.state])).toEqual([["dev-a", "read"], ["lead", "queued"]]);
  });
});

describe("2. the person's unread", () => {
  /** Ann (as the session's person, "web-user") asked dev-a; the floor is set first. */
  async function asked(db: SchedulerDb) {
    const c = seed(db);
    expect((await call(db, "GET", "/ui/tasks/unread", undefined, local)).body).toMatchObject({ enabled: true, total: 0 });
    await call(db, "POST", `/ui/tasks/cards/${c.code}`, { comment: "how is it going?" }, local);
    return c;
  }

  it("an answer to what the person asked is unread, with its card number, count and reason; opening the card reads it", async () => {
    const db = scratchDb();
    const c = await asked(db);
    db.board.updateCard(DEV, c.code, { comment: "going well" });
    const got = (await call(db, "GET", "/ui/tasks/unread", undefined, local)).body;
    expect(got).toMatchObject({ enabled: true, total: 1, cards: { [c.code]: { n: 1, reasons: ["answer"], by: "dev-a" } } });
    expect(got.cards[c.code].entries).toEqual([entryOf(db)]);
    const read = await call(db, "POST", `/ui/tasks/cards/${c.code}/read`, {}, local);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ ok: true, total: 0, cards: {} });
    expect((await call(db, "GET", "/ui/tasks/unread", undefined, local)).body).toMatchObject({ total: 0 });
  });

  it("works over the public link for an admin session, and says nothing to a read-only one: no one is reading", async () => {
    const db = scratchDb();
    const c = await asked(db);
    db.board.updateCard(DEV, c.code, { comment: "going well" });
    for (const opts of [{ tier: "read" as const, local: true as const }, { tier: "read" as const }]) {
      expect((await call(db, "GET", "/ui/tasks/unread", undefined, opts)).body).toEqual({ enabled: false, total: 0, cards: {} });
      expect((await call(db, "POST", `/ui/tasks/cards/${c.code}/read`, {}, opts)).status).toBe(403);
    }
    expect((await call(db, "GET", "/ui/tasks/unread", undefined, local)).body.total).toBe(1);        // still unread: a refused mark changed nothing
  });

  it("is on the public link's manifest (an admin session's), and a mark is a POST only", () => {
    expect(isPublicWebRoute("GET", "/ui/tasks/unread")).toBe(true);
    expect(isPublicWebRoute("POST", "/ui/tasks/cards/M-3/read")).toBe(true);
    expect(isPublicWebRoute("GET", "/ui/tasks/cards/M-3/read")).toBe(false);
  });

  it("a mark for a card that is not there is 404, an unknown field is 400, and neither changes anything", async () => {
    const db = scratchDb();
    const c = await asked(db);
    db.board.updateCard(DEV, c.code, { comment: "going well" });
    expect((await call(db, "POST", "/ui/tasks/cards/M-99/read", {}, local)).status).toBe(404);
    expect((await call(db, "POST", `/ui/tasks/cards/${c.code}/read`, { extra: 1 }, local)).status).toBe(400);
    expect((await call(db, "GET", "/ui/tasks/unread", undefined, local)).body.total).toBe(1);
  });

  it("an answer is no news for another person's session: each person's own", async () => {
    const db = scratchDb();
    const c = await asked(db);
    db.board.updateCard(DEV, c.code, { comment: "going well" });
    // The page's person is "web-user" (no names are kept), read by the session's key: what is theirs is theirs; a mark moves only theirs.
    const unread = async () => (await call(db, "GET", "/ui/tasks/unread", undefined, local)).body.total;
    expect(db.board.unreadFor("Ann").total).toBe(0);
    expect(await unread()).toBe(1);
    await call(db, "POST", `/ui/tasks/cards/${c.code}/read`, {}, local);
    expect(await unread()).toBe(0);
  });

  it("two accounts that are both web-user keep their own unread: a reply under one's comment is only that one's news, and a read by one does not clear the other's", async () => {
    const db = scratchDb();
    const c = seed(db);
    const asA = { ...local, owner: "a" }, asB = { ...local, owner: "b" };
    const unread = async (who: typeof asA) => (await call(db, "GET", "/ui/tasks/unread", undefined, who)).body;
    expect((await unread(asA)).total + (await unread(asB)).total).toBe(0);               // each has a floor
    await call(db, "POST", `/ui/tasks/cards/${c.code}`, { comment: "a's question", to: [] }, asA);
    const ida = db.board.detail(c.code).comments.at(-1)!.id;
    await call(db, "POST", `/ui/tasks/cards/${c.code}`, { comment: "b's question", to: [] }, asB);
    const idb = db.board.detail(c.code).comments.at(-1)!.id;
    db.board.updateCard(DEV, c.code, { comment: "to a", replyTo: ida });
    db.board.updateCard(DEV, c.code, { comment: "to b", replyTo: idb });
    expect((await unread(asA)).cards[c.code]).toMatchObject({ n: 1, entries: [ida + 2] });
    expect((await unread(asB)).cards[c.code]).toMatchObject({ n: 1, entries: [idb + 2] });
    await call(db, "POST", `/ui/tasks/cards/${c.code}/read`, {}, asA);
    expect((await unread(asA)).total, "a has read the card").toBe(0);
    expect((await unread(asB)).total, "b's mark is b's").toBe(1);
  });

  it("the first GET writes the person's floor, so comments that were already there are never unread — only what comes after is", async () => {
    const db = scratchDb();
    const c = seed(db);
    // History written before anyone asked: a question the person's session woke dev-a with, its answer, and an @ to the person.
    await call(db, "POST", `/ui/tasks/cards/${c.code}`, { comment: "how is it going?" }, local);
    db.board.updateCard(DEV, c.code, { comment: "going well" });
    db.board.updateCard(DEV, c.code, { comment: "@web-user also this" });
    const raw = (db as unknown as { db: { prepare(sql: string): { get(): { n: number } } } }).db;
    expect(raw.prepare("SELECT COUNT(*) AS n FROM task_reads_floor").get().n).toBe(0);
    const first = await call(db, "GET", "/ui/tasks/unread", undefined, local);
    expect(first.body).toEqual({ enabled: true, total: 0, cards: {} });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM task_reads_floor").get().n).toBe(1);          // the GET wrote the floor
    expect((await call(db, "GET", "/ui/tasks/unread", undefined, local)).body.total).toBe(0);     // …and a second one reads the same
    db.board.updateCard(DEV, c.code, { comment: "@web-user and now something new" });
    expect((await call(db, "GET", "/ui/tasks/unread", undefined, local)).body).toMatchObject({ total: 1, cards: { [c.code]: { n: 1, reasons: ["mention"] } } });
  });

  it("carries no comment text, only numbers, reasons and who", async () => {
    const db = scratchDb();
    const c = await asked(db);
    db.board.updateCard(DEV, c.code, { comment: "the vault code is 4711" });
    const res = await call(db, "GET", "/ui/tasks/unread", undefined, local);
    expect(res.raw).not.toContain("4711");
    expect(res.raw).not.toContain("how is it going");
  });

  it("a card handed to the person to confirm is unread until they open it", async () => {
    const db = scratchDb();
    db.board.createProject(ANN, { name: "Game" });
    const c = db.board.createCards(WEB, { project: "Game", cards: [{ title: "Ship it", assignee: "dev-a", needsReview: true, dispatcher: { kind: "person" } }] }).cards[0]!;
    await call(db, "GET", "/ui/tasks/unread", undefined, local);
    db.board.moveCard(DEV, c.code, "claimed", {});
    db.board.moveCard(DEV, c.code, "review", { result: "done and checked" });
    expect((await call(db, "GET", "/ui/tasks/unread", undefined, local)).body).toMatchObject({ total: 1, cards: { [c.code]: { reasons: ["review"] } } });
    await call(db, "POST", `/ui/tasks/cards/${c.code}/read`, {}, local);
    expect((await call(db, "GET", "/ui/tasks/unread", undefined, local)).body.total).toBe(0);
  });
});

describe("3. in a FleetManager: the open pages are told to read again", () => {
  async function fleet() {
    vi.useFakeTimers();
    const d = mkdtempSync(join(tmpdir(), "task-board-status-fm-")); dirs.push({ dir: d, db: null });
    writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
    const fm = new FleetManager(d) as unknown as Record<string, any>;
    fm.fleetConfig = { defaults: {}, instances: { lead: {}, "dev-a": {}, quiet: { dashboard: { task_board: false } } } };
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

  it("a person's comment: sending, then — once the waker hands it over — queued in the real outbox; then delivered and read as its row changes", async () => {
    const f = await fleet();
    const c = f.board.createCards(ANN, { cards: [{ title: "Leaderboard", assignee: "dev-a" }] }).cards[0]!;
    await vi.advanceTimersByTimeAsync(10_000);                                // the assignment's notice (its handoff moves too: one ping for the card)
    const afterAssignment = f.wakeEvents().length;
    f.board.updateCard(ANN, c.code, { comment: "weekly, not daily?" });
    const id = f.board.detail(c.code).comments.at(-1)!.id;
    const stateNow = () => wakeViews(f.board.entryWakes(c.code).get(id)!, f.fm.taskWakeProgress(f.board.entryWakes(c.code).get(id)!.flatMap((w) => (w.key ? [w.key] : []))), Date.now())[0]!;
    expect(stateNow().state).toBe("sending");
    expect(f.wakeEvents().slice(afterAssignment)).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stateNow().state).toBe("queued");                                  // admitted to the outbox, no daemon takes it
    expect(f.wakeEvents().slice(afterAssignment)).toEqual([{ ids: [c.code] }]);   // the card number and nothing else
    // The row moves: delivered, then the transcript shows it consumed.
    const key = f.board.entryWakes(c.code).get(id)![0]!.key!;
    const raw = new Database(join(f.d, "delivery-outbox.db"));
    try {
      const row = raw.prepare("SELECT delivery_id FROM deliveries WHERE source_key = ?").get(key) as { delivery_id: string };
      const before = f.wakeEvents().length;
      raw.prepare("UPDATE deliveries SET state='delivered', finished_at=?, updated_at=? WHERE source_key=?").run(new Date().toISOString(), new Date().toISOString(), key);
      f.fm.noteTaskWakeDelivery(row.delivery_id);
      expect(stateNow().state).toBe("delivered");
      raw.prepare("UPDATE deliveries SET consumed_at=?, consumed_via='turn' WHERE source_key=?").run(new Date().toISOString(), key);
      f.fm.noteTaskWakeDelivery(row.delivery_id);
      expect(stateNow().state).toBe("read");
      expect(f.wakeEvents().slice(before)).toEqual([{ ids: [c.code] }, { ids: [c.code] }]);
      // A delivery of something else tells nobody.
      f.fm.noteTaskWakeDelivery("no-such-delivery");
      expect(f.wakeEvents()).toHaveLength(before + 2);
    } finally { raw.close(); }
    f.stop();
  });

  it("an instance with the task board off: the comment says so at once (no wait for the 10 s), and the page is told", async () => {
    const f = await fleet();
    const c = f.board.createCards(ANN, { cards: [{ title: "Leaderboard", assignee: "dev-a" }] }).cards[0]!;
    await vi.advanceTimersByTimeAsync(10_000);
    f.board.updateCard(ANN, c.code, { comment: "@quiet are you there?", to: [] });
    const id = f.board.detail(c.code).comments.at(-1)!.id;
    expect(f.board.entryWakes(c.code).get(id)).toEqual([expect.objectContaining({ to: "quiet", skip: "board_off" })]);
    f.stop();
  });
});
