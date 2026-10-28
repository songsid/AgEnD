/**
 * #2801 (subtraction ③): one card sent 6–10 notices (163 on the host in 7 days). Now a card notifies only when its
 * status or assignee changes, and only to the one instance that acts next. A comment notifies nobody; neither does a
 * confirmation (the work is finished). An auto-review with gaps is one notice, to the dispatcher. News whose maker
 * messaged the recipient about the card within 2 minutes is not repeated (#2785 (c), widened). A notice still waiting
 * is withdrawn once every card on it has changed again.
 *
 * Isolation: temp databases; fake timers and clock; the delivery outbox has no pump, so every notice stays queued.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SchedulerDb } from "../src/scheduler/db.js";
import { Scheduler } from "../src/scheduler/index.js";
import type { Actor, TaskBoard } from "../src/scheduler/task-board.js";
import { TOLD_WINDOW_MS, TaskBoardWaker, namesCard } from "../src/task-board-waker.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { FleetManager } from "../src/fleet-manager.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const LEAD: Actor = { kind: "instance", name: "lead" };
const DEV: Actor = { kind: "instance", name: "dev-a" };
const DEV2: Actor = { kind: "instance", name: "dev-b" };
const REV: Actor = { kind: "instance", name: "rev" };
/** Longer than any notice waits: the 10 s gather and the 2-minute wait for its maker's own message. */
const SETTLE = TOLD_WINDOW_MS + 15_000;

const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const c of closers.splice(0)) { try { c(); } catch { /* closed */ } }
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A board with project "Game", a real delivery outbox and the waker wired to both as the fleet wires them. */
function rig() {
  vi.useFakeTimers({ now: new Date("2026-10-28T08:00:00Z") });
  const d = mkdtempSync(join(tmpdir(), "agend-2801-")); dirs.push(d);
  const db = new SchedulerDb(join(d, "scheduler.db"));
  const outbox = new DeliveryOutbox(join(d, "outbox.db"), "manager");
  const board = db.board;
  board.createProject(ANN, { name: "Game" });
  const waker = new TaskBoardWaker({
    deliver: (instance, message, key) => { outbox.admitSystemNotice(instance, key, message, new Date()); return true; },
    isInstance: (n) => ["lead", "dev-a", "dev-b", "rev"].includes(n),
    messagedAbout: (from, to, codes, since) => outbox.recentTextsFrom(to, from, new Date(since).toISOString()).some((t) => codes.some((c) => namesCard(t, c))),
    withdraw: (prefix, stale, reason) => outbox.withdrawWaitingNotices(prefix, stale, reason).length,
    changedAt: (uuid) => board.lastChangeAt(uuid),
    holds: (w) => board.wakeHolds(w),
    card: (u) => board.findCard(u),
    log: () => {},
  });
  board.onChange((c) => { waker.changed(c.changed); waker.note(c.wakes); });
  closers.push(() => waker.stop(), () => outbox.close(), () => db.close());
  let n = 0;
  /** An instance's own message (delegate_task / send_to_instance) to another. */
  const say = (from: string, to: string, content: string) => outbox.admit({
    operationId: `op-${++n}`, sourceKey: `k-${n}`, sourceInstance: from, sourceDaemonBootId: "sb", targetInstance: to,
    kind: "fleet_inbound", payload: { type: "fleet_inbound", content, meta: {} },
  });
  const rows = () => ((outbox as any).db.prepare("SELECT delivery_id AS id, source_key AS key, target_instance AS t, state, last_error AS err, payload_json FROM deliveries WHERE kind='system_notice' ORDER BY created_seq").all() as
    Array<{ id: string; key: string; t: string; state: string; err: string | null; payload_json: string }>).map((r) => ({ ...r, text: JSON.parse(r.payload_json).content as string }));
  let seen = 0;
  /** Let every notice due go out; the notices admitted since the last call, as [to, text]. */
  const settle = () => { vi.advanceTimersByTime(SETTLE); const all = rows(); const fresh = all.slice(seen); seen = all.length; return fresh.map((r) => [r.t, r.text] as const); };
  return { board, outbox, say, rows, settle };
}
const main = (board: TaskBoard, actor: Actor, extra: Record<string, unknown> = {}) =>
  board.createCards(actor, { project: "Game", cards: [{ title: "Build the leaderboard", ...extra }] }).cards[0]!;
const sub = (board: TaskBoard, actor: Actor, parent: string, extra: Record<string, unknown> = {}) =>
  board.createCards(actor, { cards: [{ parent, title: "A step", ...extra }] }).cards[0]!;
const has = (text: string) => expect.stringContaining(text);

describe("#2801: one card's life — who is told what (the issue's table)", () => {
  it("create → claim → comments → block → answer → review → send back → review → done", () => {
    const { board, settle } = rig();
    const card = main(board, LEAD, { assignee: "dev-a", needsReview: true });
    expect(settle()).toEqual([["dev-a", has(`${card.code} "Build the leaderboard": assigned to you by lead`)]]);
    board.moveCard(DEV, card.code, "claimed");
    expect(settle()).toEqual([]);                                     // its own move
    board.updateCard(REV, card.code, { comment: "mind the cache" });
    board.updateCard(LEAD, card.code, { comment: "see #12" });
    board.updateCard(ANN, card.code, { comment: "weekly, not daily" });
    expect(settle()).toEqual([]);                                     // comments: nobody
    board.moveCard(DEV, card.code, "blocked", { reason: "which API?" });
    expect(settle()).toEqual([["lead", has('you handed it out and it is blocked (@dev-a): "which API?"')]]);
    board.moveCard(LEAD, card.code, "claimed", { comment: "the v2 one" });
    expect(settle()).toEqual([["dev-a", has('lead answered your blocked question: "the v2 one"')]]);
    board.moveCard(DEV, card.code, "review", { result: "r" });
    expect(settle()).toEqual([["lead", has("ready for your confirmation (@dev-a)")]]);
    board.moveCard(LEAD, card.code, "claimed", { reason: "add tests" });
    expect(settle()).toEqual([["dev-a", has('sent back by lead: "add tests"')]]);
    board.moveCard(DEV, card.code, "review", { result: "r2" });
    expect(settle()).toEqual([["lead", has("ready for your confirmation (@dev-a)")]]);
    board.moveCard(LEAD, card.code, "done", { reason: "nice" });
    expect(settle()).toEqual([]);                                     // confirmed: the work is finished, nothing to act on
  });

  it("the person confirming a card an instance handed out tells nobody — neither its assignee nor its dispatcher", () => {
    const { board, settle } = rig();
    const card = main(board, LEAD, { assignee: "dev-a", needsReview: true });
    board.moveCard(DEV, card.code, "claimed");
    board.moveCard(DEV, card.code, "review", { result: "r" });
    settle();
    board.moveCard(ANN, card.code, "done", { reason: "good" });
    expect(settle()).toEqual([]);
  });

  it("a main task gone to review by itself with gaps: one notice, to its dispatcher, naming the gaps; the person's card: its owner", () => {
    const { board, settle } = rig();
    const m = main(board, LEAD, { assignee: "dev-a", needsReview: true, acceptance: ["resets Monday"] });
    const s = sub(board, LEAD, m.code, { assignee: "dev-b" });
    board.moveCard(DEV2, s.code, "claimed");
    settle();
    board.moveCard(DEV2, s.code, "done", { result: "looks good" });
    expect(board.getCard(m.code).status).toBe("review");
    expect(settle()).toEqual([["lead", has(`${m.code} "Build the leaderboard": you handed it out and it is ready for your confirmation (@dev-a), though`)]]);

    const p = main(board, ANN, { assignee: "dev-a", acceptance: ["resets Monday"] });
    const ps = sub(board, ANN, p.code, { assignee: "dev-b" });
    board.moveCard(DEV2, ps.code, "claimed");
    settle();
    board.moveCard(DEV2, ps.code, "done", { result: "looks good" });
    expect(settle()).toEqual([["dev-a", has(`${p.code} "Build the leaderboard": it went to the person for confirmation by itself`)]]);
  });
});

describe("#2801: news its maker already told in a message (within 2 minutes) is not repeated", () => {
  it("an assignment told before or after, a block, an answer and a review told after: no board notice", () => {
    const { board, say, settle } = rig();
    const card = main(board, LEAD, { assignee: "dev-a", needsReview: true });
    say("lead", "dev-a", `Board card ${card.code}: build it`);
    expect(settle()).toEqual([]);
    board.moveCard(DEV, card.code, "claimed");
    board.moveCard(DEV, card.code, "blocked", { reason: "which API?" });
    vi.advanceTimersByTime(60_000);
    say("dev-a", "lead", `${card.code} is blocked: which API?`);            // a minute after the change
    expect(settle()).toEqual([]);
    board.moveCard(LEAD, card.code, "claimed", { comment: "the v2 one" });
    vi.advanceTimersByTime(5_000);
    say("lead", "dev-a", `${card.code}: answered on the card — the v2 one`);
    expect(settle()).toEqual([]);
    board.moveCard(DEV, card.code, "review", { result: "r" });
    say("dev-a", "lead", `PR ready for ${card.code}`);
    expect(settle()).toEqual([]);
  });

  it("an older message, another sender's or one about another card does not count: the board tells it", () => {
    const { board, say, settle } = rig();
    const card = main(board, LEAD, { assignee: "dev-a" });
    settle();
    board.moveCard(DEV, card.code, "claimed");
    say("dev-a", "lead", `${card.code}: starting`);
    vi.advanceTimersByTime(TOLD_WINDOW_MS + 1_000);
    say("rev", "lead", `${card.code} looks blocked`);
    say("dev-a", "lead", "M-99 is blocked");
    board.moveCard(DEV, card.code, "blocked", { reason: "which API?" });
    expect(settle()).toEqual([["lead", has("you handed it out and it is blocked (@dev-a)")]]);
  });

  it("a message before a change other than an assignment did not tell it (#2801 review): the board does", () => {
    const { board, say, settle } = rig();
    const card = main(board, LEAD, { assignee: "dev-a", needsReview: true });
    settle();
    board.moveCard(DEV, card.code, "claimed");
    say("dev-a", "lead", `${card.code} going well so far`);
    vi.advanceTimersByTime(60_000);
    board.moveCard(DEV, card.code, "blocked", { reason: "which API?" });
    expect(settle()).toEqual([["lead", has("you handed it out and it is blocked (@dev-a)")]]);
  });

  it("a cancel is told at once — after a message about the card, or one right after it — never held or folded", () => {
    const { board, say, settle } = rig();
    const card = main(board, LEAD, { assignee: "dev-a" });
    settle();
    board.moveCard(DEV, card.code, "claimed");
    say("lead", "dev-a", `${card.code} looks fine so far`);
    vi.advanceTimersByTime(60_000);
    board.moveCard(LEAD, card.code, "cancelled", { reason: "dropped" });
    say("lead", "dev-a", `${card.code} is cancelled, stop`);
    vi.advanceTimersByTime(10_000);                                           // the gather only: no 2-minute wait
    expect(settle()).toEqual([["dev-a", has('cancelled by lead: "dropped" — stop working on it')]]);
  });

  it("a person's change is told at once, without waiting for a message", () => {
    const { board, settle } = rig();
    const card = main(board, ANN, { assignee: "dev-a" });
    board.moveCard(DEV, card.code, "claimed");
    board.moveCard(DEV, card.code, "review", { result: "r" });
    vi.advanceTimersByTime(SETTLE);
    settle();
    board.moveCard(ANN, card.code, "claimed", { reason: "add tests" });
    vi.advanceTimersByTime(10_000);
    expect(settle()).toEqual([["dev-a", has('sent back by Ann: "add tests"')]]);
  });
});

describe("#2801: a notice still waiting is withdrawn once its cards changed again", () => {
  it("the dispatcher's 'blocked' still queued when the person answers it: cancelled as superseded; the answer goes", () => {
    const { board, rows, settle } = rig();
    const card = main(board, LEAD, { assignee: "dev-a" });
    board.moveCard(DEV, card.code, "claimed");
    settle();
    board.moveCard(DEV, card.code, "blocked", { reason: "which API?" });
    settle();
    const blocked = rows().find((r) => r.t === "lead")!;
    expect(blocked).toMatchObject({ state: "queued", key: expect.stringMatching(new RegExp(`:cards=${card.uuid}$`)) });
    board.updateCard(ANN, card.code, { comment: "thinking" });
    expect(rows().find((r) => r.id === blocked.id)!.state).toBe("queued");   // a comment is no change
    board.moveCard(ANN, card.code, "claimed", { comment: "the v2 one" });
    expect(rows().find((r) => r.id === blocked.id)).toMatchObject({ state: "cancelled", err: "superseded: its card changed again" });
    expect(settle()).toEqual([["dev-a", has("Ann answered your blocked question")]]);
  });

  it("a busy assignee's blocked question answered: the answer waits on the card and its assignee is told so (#2801 review)", () => {
    const { board, settle } = rig();
    const [a, b] = [main(board, LEAD, { assignee: "dev-a" }), main(board, LEAD, { assignee: "dev-a" })];
    board.moveCard(DEV, a.code, "claimed");
    board.moveCard(DEV, a.code, "blocked", { reason: "which scores count?" });
    board.moveCard(DEV, b.code, "claimed");
    settle();
    board.moveCard(LEAD, a.code, "claimed", { comment: "the best of three" });
    expect(board.getCard(a.code).status).toBe("blocked");
    expect(settle()).toEqual([["dev-a", has(`${a.code} "Build the leaderboard": lead answered your blocked question: "the best of three" — kept on the card`)]]);
    // Resumed meanwhile: no longer news.
    board.moveCard(LEAD, a.code, "claimed", { comment: "and ties share a rank" });
    board.moveCard(DEV, b.code, "review", { result: "r" });
    board.moveCard(DEV, a.code, "claimed");
    expect(settle().filter(([to]) => to === "dev-a")).toEqual([]);
  });

  it("a card given to someone else: its old assignee's waiting notice is withdrawn; the new one is told", () => {
    const { board, rows, settle } = rig();
    const card = main(board, ANN, { assignee: "dev-a" });
    expect(settle()).toEqual([["dev-a", has("assigned to you by Ann")]]);
    board.updateCard(ANN, card.code, { assignee: "dev-b" });
    expect(rows().filter((r) => r.t === "dev-a").map((r) => r.state)).toEqual(["cancelled"]);
    expect(settle()).toEqual([["dev-b", has("assigned to you by Ann")]]);
  });

  it("a notice about two cards goes only once both changed; other instances' and other cards' notices stay", () => {
    const { board, rows, settle } = rig();
    const [a, b] = [main(board, LEAD, { assignee: "dev-a" }), main(board, LEAD, { assignee: "dev-b" })];
    main(board, LEAD, { assignee: "rev" });
    board.moveCard(DEV, a.code, "claimed");
    board.moveCard(DEV2, b.code, "claimed");
    settle();
    board.moveCard(DEV, a.code, "blocked", { reason: "x?" });
    board.moveCard(DEV2, b.code, "blocked", { reason: "y?" });
    settle();
    const both = rows().filter((r) => r.t === "lead" && r.state === "queued");
    expect(both).toHaveLength(1);
    expect(both[0]!.text).toMatch(/2 things on your cards/);
    const revs = rows().filter((r) => r.t === "rev").map((r) => r.id);
    board.moveCard(ANN, a.code, "claimed", { comment: "x" });
    expect(rows().find((r) => r.id === both[0]!.id)!.state).toBe("queued");
    vi.advanceTimersByTime(1_000);
    board.moveCard(ANN, b.code, "claimed", { comment: "y" });
    expect(rows().find((r) => r.id === both[0]!.id)!.state).toBe("cancelled");
    expect(rows().filter((r) => revs.includes(r.id)).map((r) => r.state)).toEqual(["queued"]);   // rev's assignment of another card
  });

  it("a notice being delivered (claimed, or begun and back to waiting) is left alone", () => {
    const { board, outbox, rows, settle } = rig();
    const card = main(board, LEAD, { assignee: "dev-a" });
    board.moveCard(DEV, card.code, "claimed");
    settle();
    board.moveCard(DEV, card.code, "blocked", { reason: "which API?" });
    settle();
    const row = rows().find((r) => r.t === "lead")!;
    const c = outbox.claimNext("manager", (t) => (t === "lead" ? "boot" : null), new Set())!;
    expect(c.deliveryId).toBe(row.id);
    expect(outbox.begin(c.deliveryId, "boot", c.attemptNo)).toBe("begun");
    // Begun (on the pane), then forced back to look pending: the attempt alone protects it.
    (outbox as any).db.prepare("UPDATE deliveries SET state='retry_wait', next_attempt_at=NULL WHERE delivery_id=?").run(row.id);
    board.moveCard(ANN, card.code, "claimed", { comment: "the v2 one" });
    expect(rows().find((r) => r.id === row.id)!.state).toBe("retry_wait");
  });
});

describe("#2801: upgrade and downgrade", () => {
  it("a notice queued before the upgrade (its key names no cards) is never withdrawn; only AgEnD's task-board notices are looked at", () => {
    const { board, outbox, rows } = rig();
    const card = main(board, LEAD, { assignee: "dev-a" });
    vi.advanceTimersByTime(1_000);
    outbox.admitSystemNotice("lead", "task-board:lead:1793000000000:1", `[Task board] ${card.code} "x": you handed it out and it is blocked`, new Date());
    outbox.admitSystemNotice("lead", `other-notice:cards=${card.uuid}`, "[Poll] results", new Date());
    outbox.admit({ operationId: "op-x", sourceKey: `task-board:x:cards=${card.uuid}`, sourceInstance: "dev-a", sourceDaemonBootId: "sb", targetInstance: "lead",
      kind: "fleet_inbound", payload: { type: "fleet_inbound", content: "hi", meta: {} } });
    board.moveCard(ANN, card.code, "cancelled", { reason: "dropped" });
    const state = (key: string) => ((outbox as any).db.prepare("SELECT state FROM deliveries WHERE source_key=?").get(key) as { state: string }).state;
    expect([state("task-board:lead:1793000000000:1"), state(`other-notice:cards=${card.uuid}`), state(`task-board:x:cards=${card.uuid}`)]).toEqual(["queued", "queued", "queued"]);
  });
});

describe("#2801 in a real FleetManager: the waker withdraws through the fleet's outbox", () => {
  it("lead's queued 'blocked' notice is cancelled once the person answers the card", async () => {
    vi.useFakeTimers();
    const d = mkdtempSync(join(tmpdir(), "agend-2801-fm-")); dirs.push(d);
    writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
    const fm = new FleetManager(d) as unknown as Record<string, any>;
    fm.fleetConfig = { defaults: {}, instances: { "dev-a": {}, lead: {} } };
    fm.ensureDeliveryOutbox();
    const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
    closers.push(() => fm.taskBoardWaker?.stop(), () => fm.deliveryOutbox?.close?.(), () => scheduler.db.close());
    fm.attachTaskBoard(scheduler.db);
    const board: TaskBoard = scheduler.db.board;
    const card = board.createCards(LEAD, { cards: [{ title: "Leaderboard", assignee: "dev-a" }] }).cards[0]!;
    board.moveCard(DEV, card.code, "claimed");
    board.moveCard(DEV, card.code, "blocked", { reason: "which API?" });
    await vi.advanceTimersByTimeAsync(SETTLE);
    const states = () => (fm.deliveryOutbox.db.prepare("SELECT target_instance AS t, state FROM deliveries WHERE kind='system_notice' ORDER BY created_seq").all() as Array<{ t: string; state: string }>);
    expect(states().filter((r) => r.t === "lead")).toEqual([{ t: "lead", state: "queued" }]);
    board.moveCard(ANN, card.code, "claimed", { comment: "v2" });
    expect(states().filter((r) => r.t === "lead")).toEqual([{ t: "lead", state: "cancelled" }]);
  });
});
