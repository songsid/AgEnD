/**
 * A card handed to the instance that works it next, and what happened to a main task's sub tasks (docs/design/task-board.md, "Handoffs"):
 *
 *   1. What the board keeps (`task_handoffs`): a sub task whose last dependency finished is `ready` for its assignee, with the card whose
 *      finishing readied it; a card given to an instance that can start at once is `assigned`; nothing for a card that still waits, for a
 *      name that is no instance of the fleet, or for a card nobody holds. The rows are not events and move no revision.
 *   2. What the waker tells the board as the news goes out, apart from the comments it may carry: handed to delivery under a key, or not
 *      sent and why — the task board off, the card started while the news gathered (not waiting), the fleet could not take it; a notice that
 *      carries a comment whose writer may not reach the instance still hands the card over.
 *   3. `subEvents`: the moves of a main task's sub tasks, in order, nothing else; the card's own detail carries them only on a main task.
 *   4. How far a handoff got is read like a comment's (`handoffViews`): sending, queued, delivered, read, failed, unconfirmed, withdrawn, lost.
 *   5. The source: the notice that hands a card over, and the card an instance reads, say to claim it before starting on it — the board shows
 *      work only once a card is claimed, and never moves the card for an agent.
 *   6. Compatibility: a database from before the table opens and grows it; the card's other reads are as they were; a pruned card takes its rows.
 *
 * Isolation: temp databases; the waker's timers seam.
 */
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SchedulerDb } from "../src/scheduler/db.js";
import { type Actor, type TaskBoard, type WakeSkip } from "../src/scheduler/task-board.js";
import { TaskBoardWaker, wakeMessage } from "../src/task-board-waker.js";
import { cardText } from "../src/scheduler/task-board-text.js";
import { handoffViews } from "../src/web-api.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const LEAD: Actor = { kind: "instance", name: "lead" };
const DEV_A: Actor = { kind: "instance", name: "dev-a" };
const DEV_B: Actor = { kind: "instance", name: "dev-b" };
const INSTANCES = ["lead", "dev-a", "dev-b", "quiet"];

const dirs: string[] = [];
const dbs: SchedulerDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "task-board-handoffs-")); dirs.push(d); return d; };

interface Rig { db: SchedulerDb; board: TaskBoard; path: string; boardOff: Set<string>; contactHeld: Set<string> }
function rig(path = join(tmp(), "scheduler.db")): Rig {
  const db = new SchedulerDb(path); dbs.push(db);
  const boardOff = new Set<string>(["quiet"]);
  const contactHeld = new Set<string>();
  db.board.setBoardOff((n) => boardOff.has(n));
  db.board.setCommentRouting({ instances: () => INSTANCES, enabled: () => true });
  db.board.setContactGate((source) => !contactHeld.has(source));
  if (!db.board.listProjects(true).length) db.board.createProject(ANN, { name: "Game" });
  return { db, board: db.board, path, boardOff, contactHeld };
}

/** A main task with two sub tasks: S-1 (dev-a), then S-2 (dev-b) once S-1 is done. */
function plan(r: Rig, over: { s2?: Record<string, unknown>; s1?: Record<string, unknown> } = {}) {
  const main = r.board.createCards(ANN, { project: "Game", cards: [{ title: "Build the game", needsReview: false }] }).cards[0]!;
  const s1 = r.board.createCards(ANN, { cards: [{ parent: main.code, title: "Design doc", assignee: "dev-a", needsReview: false, ...over.s1 }] }).cards[0]!;
  const s2 = r.board.createCards(ANN, { cards: [{ parent: main.code, title: "Prototype", assignee: "dev-b", dependsOn: [s1.code], needsReview: false, ...over.s2 }] }).cards[0]!;
  return { main, s1, s2 };
}
const finish = (r: Rig, by: Actor, code: string, extra: Record<string, unknown> = {}) => {
  r.board.moveCard(by, code, "claimed", {});
  r.board.moveCard(by, code, "done", { result: "done and checked", ...extra });
};
const rowsOf = (r: Rig, ...cards: Array<{ uuid: string }>) => r.board.handoffsOf(cards.map((c) => c.uuid));

/** The waker wired as the fleet wires it: what it settles goes to the board (a window of news is one notice). */
function wired(r: Rig, over: { deliver?: () => boolean } = {}) {
  const timers: Array<{ fn: () => void; live: boolean }> = [];
  const sent: Array<{ instance: string; key: string; message: string }> = [];
  const settled: Array<{ uuid: string; instance: string; kind?: string; key?: string; skip?: WakeSkip }> = [];
  const waker = new TaskBoardWaker({
    deliver: (instance, message, key) => { sent.push({ instance, key, message }); return over.deliver ? over.deliver() : true; },
    mayReach: (source) => !r.contactHeld.has(source),
    isInstance: (n) => INSTANCES.includes(n),
    boardOff: (n) => r.boardOff.has(n),
    holds: (w) => r.board.wakeHolds(w),
    card: (u) => r.board.findCard(u),
    settled: (e) => {
      settled.push(e);
      if (e.kind === "handoff") { if (e.key) r.board.handoffHanded(e.uuid, e.instance, e.key); else if (e.skip) r.board.handoffDropped(e.uuid, e.instance, e.skip); }
      else if (e.key) r.board.wakeHanded(e.uuid, e.instance, e.key); else if (e.skip) r.board.wakeDropped(e.uuid, e.instance, e.skip);
    },
    log: () => {},
    timers: { set: (fn) => { const t = { fn, live: true }; timers.push(t); return t; }, clear: (h) => { (h as { live: boolean }).live = false; } },
  });
  r.board.onChange((ch) => waker.note(ch.wakes));
  return { waker, sent, settled, fire: () => { for (const t of timers.splice(0)) if (t.live) t.fn(); } };
}

describe("1. what the board keeps", () => {
  it("S-1 done readies S-2 for its assignee: one row, with the card whose finishing readied it", () => {
    const r = rig();
    const { s1, s2 } = plan(r);
    expect(rowsOf(r, s2), "waiting on S-1: nothing yet").toEqual([]);
    finish(r, DEV_A, s1.code);
    expect(rowsOf(r, s2)).toEqual([expect.objectContaining({ card: s2.code, to: "dev-b", why: "ready", after: s1.code })]);
    expect(rowsOf(r, s2)[0]!.key).toBeUndefined();
    expect(rowsOf(r, s2)[0]!.skip).toBeUndefined();
  });

  it("a card given to an instance that can start at once is `assigned` (no predecessor); a card that still waits has none until it is ready", () => {
    const r = rig();
    const { s1 } = plan(r);
    expect(rowsOf(r, s1)).toEqual([expect.objectContaining({ card: s1.code, to: "dev-a", why: "assigned", after: null })]);
  });

  it("a person finishing the predecessor readies it too (by hand or by the board's own move: a done card is a done card)", () => {
    const r = rig();
    const { s1, s2 } = plan(r);
    r.board.moveCard(ANN, s1.code, "claimed", {});
    r.board.moveCard(ANN, s1.code, "done", { result: "ok" });
    expect(rowsOf(r, s2).map((h) => [h.why, h.after])).toEqual([["ready", s1.code]]);
  });

  it("each readying is its own row: a card sent back and readied again is two", () => {
    const r = rig();
    const { s1, s2 } = plan(r);
    finish(r, DEV_A, s1.code);
    r.board.moveCard(ANN, s1.code, "claimed", {});            // reopened by the person
    r.board.moveCard(DEV_A, s1.code, "done", { result: "again" });
    expect(rowsOf(r, s2).map((h) => h.why)).toEqual(["ready", "ready"]);
  });

  it("nothing for a card nobody holds, for a name that is no instance of the fleet, or when the instance started it itself", () => {
    const r = rig();
    const { s1, s2 } = plan(r, { s2: { assignee: "ghost" } });
    finish(r, DEV_A, s1.code);
    expect(rowsOf(r, s2), "an assignee that is no instance is never told").toEqual([]);
    const free = r.board.createCards(ANN, { cards: [{ parent: s2.parent ? r.board.findCard(s2.parent)!.code : "", title: "Nobody's" }] }).cards[0]!;
    expect(rowsOf(r, free), "no assignee, nobody to hand it to").toEqual([]);
  });

  it("the rows are not events and do not move the board's revision on their own", () => {
    const r = rig();
    const { s1, s2 } = plan(r);
    finish(r, DEV_A, s1.code);
    const before = { events: r.board.events(s2.uuid, 100).length };
    const rev = r.board.revision();
    expect(r.board.handoffHanded(s2.uuid, "dev-b", "task-board:dev-b:1:1:cards=" + s2.uuid)).toEqual([s2.code, s1.parent ? r.board.findCard(s1.parent)!.code : ""]);
    expect(r.board.handoffHanded(s2.uuid, "dev-b", "again"), "nothing left waiting: nothing touched").toEqual([]);
    expect({ events: r.board.events(s2.uuid, 100).length }).toEqual(before);
    expect(r.board.revision()).toBe(rev);
    expect(rowsOf(r, s2)[0]!.key).toBe("task-board:dev-b:1:1:cards=" + s2.uuid);
  });

  it("a notice withdrawn and told anew: the hand-over it carried follows the replacement (it names the keys it replaces); nothing else is touched", () => {
    const r = rig();
    const { s1, s2 } = plan(r);
    finish(r, DEV_A, s1.code);
    const first = "task-board:dev-b:1:1:cards=" + s2.uuid, second = "task-board:dev-b:2:2:cards=" + s2.uuid;
    r.board.handoffHanded(s2.uuid, "dev-b", first);
    expect(r.board.handoffHanded(s2.uuid, "dev-b", second), "no `replaces`: it already has a key").toEqual([]);
    expect(rowsOf(r, s2)[0]!.key).toBe(first);
    expect(r.board.handoffHanded(s2.uuid, "dev-b", second, ["task-board:dev-b:9:9:cards=other"]), "another notice's key is not this one's").toEqual([]);
    expect(r.board.handoffHanded(s2.uuid, "dev-b", second, [first])).toEqual([s2.code, s1.parent ? r.board.findCard(s1.parent)!.code : ""]);
    expect(rowsOf(r, s2)[0]!.key, "the replacement's key").toBe(second);
  });

  it("a replacement that is not sent: the hand-over the withdrawn notice carried takes its skip, not the withdrawn notice's state (#4573 review, for handoffs)", () => {
    const r = rig();
    const { s1, s2 } = plan(r);
    finish(r, DEV_A, s1.code);
    const first = "task-board:dev-b:1:1:cards=" + s2.uuid;
    r.board.handoffHanded(s2.uuid, "dev-b", first);
    expect(r.board.handoffDropped(s2.uuid, "dev-b", "not_waiting"), "no `replaces`: it already has a key").toEqual([]);
    expect(rowsOf(r, s2)[0]!.skip).toBeUndefined();
    expect(r.board.handoffDropped(s2.uuid, "dev-b", "not_waiting", ["task-board:dev-b:9:9:cards=other"]), "another notice's key is not this one's").toEqual([]);
    expect(r.board.handoffDropped(s2.uuid, "dev-b", "not_waiting", [first])).toEqual([s2.code, s1.parent ? r.board.findCard(s1.parent)!.code : ""]);
    expect(rowsOf(r, s2)[0]!.skip, "why the replacement was not sent").toBe("not_waiting");
    const progress = new Map([[first, { state: "cancelled" as const }]]) as unknown as Parameters<typeof handoffViews>[1];
    expect(handoffViews(rowsOf(r, s2), progress, Date.now())[0]).toMatchObject({ state: "skipped", skip: "not_waiting" });
  });

  it("a replacement not sent, then a later one that is: the hand-over takes the new key and no longer reads as skipped (`skip` cleared, as wakeHanded does)", () => {
    const r = rig();
    const { s1, s2 } = plan(r);
    finish(r, DEV_A, s1.code);
    const first = "task-board:dev-b:1:1:cards=" + s2.uuid, third = "task-board:dev-b:3:3:cards=" + s2.uuid;
    r.board.handoffHanded(s2.uuid, "dev-b", first);
    r.board.handoffDropped(s2.uuid, "dev-b", "board_off", [first]);          // the first replacement was not sent: the row keeps `first`, with a skip
    expect(rowsOf(r, s2)[0]).toMatchObject({ key: first, skip: "board_off" });
    expect(r.board.handoffHanded(s2.uuid, "dev-b", third, [first])).toEqual([s2.code, r.board.findCard(s1.parent!)!.code]);
    expect(rowsOf(r, s2)[0]!.key).toBe(third);
    expect(rowsOf(r, s2)[0]!.skip, "the skip of the earlier replacement is gone").toBeUndefined();
    const progress = new Map([[third, { state: "delivered" as const, consumedAt: null }]]) as unknown as Parameters<typeof handoffViews>[1];
    expect(handoffViews(rowsOf(r, s2), progress, Date.now())[0]).toMatchObject({ state: "delivered" });
    expect(r.board.view(r.board.getCard(s2.code)).handedAt, "and it counts as handed").toBe(rowsOf(r, s2)[0]!.at);
  });

  it("a main task's own handoff and its sub tasks' are read by the card numbers the caller names", () => {
    const r = rig();
    const main = r.board.createCards(ANN, { project: "Game", cards: [{ title: "Lead's job", assignee: "lead", needsReview: false }] }).cards[0]!;
    const sub = r.board.createCards(ANN, { cards: [{ parent: main.code, title: "A step", assignee: "dev-a", needsReview: false }] }).cards[0]!;
    expect(r.board.handoffsOf([main.uuid]).map((h) => h.card)).toEqual([main.code]);
    expect(r.board.handoffsOf([main.uuid, sub.uuid]).map((h) => h.card).sort()).toEqual([main.code, sub.code].sort());
    expect(r.board.handoffsOf([])).toEqual([]);
  });
});

describe("1b. `handedAt`: what a page may take as 'the board told its assignee about this card'", () => {
  const viewOf = (r: Rig, code: string) => r.board.view(r.board.getCard(code));
  /** The fleet's waker handed the news about `card` for `to` to delivery (the outbox key it would have). */
  const hand = (r: Rig, card: { uuid: string }, to: string, key = `task-board:${to}:1:1:cards=${card.uuid}`) => { r.board.handoffHanded(card.uuid, to, key); return key; };

  it("an open card has it once the board handed it to its current assignee and the fleet took the notice — the newest; none before, none for a card that is not open", () => {
    const r = rig();
    const { s1, s2 } = plan(r);
    expect("handedAt" in viewOf(r, s2.code), "it still waits for S-1: nothing was handed").toBe(false);
    finish(r, DEV_A, s1.code);
    expect("handedAt" in viewOf(r, s2.code), "the news is still gathering: no notice yet").toBe(false);
    hand(r, s2, "dev-b");
    const row = rowsOf(r, s2)[0]!;
    expect(viewOf(r, s2.code).handedAt).toBe(row.at);
    expect("handedAt" in viewOf(r, s1.code), "a finished card").toBe(false);
    r.board.moveCard(DEV_B, s2.code, "claimed", {});
    expect("handedAt" in viewOf(r, s2.code), "in progress: not for an open card's inference").toBe(false);
  });

  it("only the current assignee's hand-overs count: reassigned, the new one's; to a name that is no instance (never told), none", () => {
    const r = rig();
    const { s1, s2 } = plan(r);
    finish(r, DEV_A, s1.code);
    hand(r, s2, "dev-b");
    r.board.updateCard(ANN, s2.code, { assignee: "lead" });
    hand(r, s2, "lead");
    const rows = rowsOf(r, s2);
    expect(rows.map((h) => h.to)).toEqual(["dev-b", "lead"]);
    expect(viewOf(r, s2.code).handedAt, "the one handed to lead").toBe(rows.find((h) => h.to === "lead")!.at);
    r.board.updateCard(ANN, s2.code, { assignee: "ghost" });
    expect("handedAt" in viewOf(r, s2.code), "ghost was never told").toBe(false);
  });

  it("a hand-over that was not sent is not one: its task board off, the fleet could not queue it, the card no longer waited, held back — or never handed over", () => {
    for (const skip of ["board_off", "not_taken", "not_waiting", "contact_held", "lost"] as const) {
      const r = rig();
      const { s1, s2 } = plan(r);
      finish(r, DEV_A, s1.code);
      r.board.handoffDropped(s2.uuid, "dev-b", skip);
      expect(rowsOf(r, s2)[0]).toMatchObject({ skip });
      expect([skip, "handedAt" in viewOf(r, s2.code)]).toEqual([skip, false]);
      expect([skip, r.board.views(r.board.boardCards()).some((v) => v.handedAt)], "nor in the board read").toEqual([skip, false]);
    }
  });

  it("the notice's delivery: queued, failed, unconfirmed or withdrawn is not a hand-over that reached the instance; delivered (read or not), or no record in the outbox, is", () => {
    const cases: Array<[string | null, boolean]> = [["queued", false], ["delivering", false], ["submission_started", false], ["reconciliation_pending", false],
      ["failed", false], ["uncertain", false], ["cancelled", false], ["delivered", true], [null, true]];
    for (const [state, shown] of cases) {
      const r = rig();
      const { s1, s2 } = plan(r);
      finish(r, DEV_A, s1.code);
      const key = hand(r, s2, "dev-b");
      r.board.setNoticeProgress((keys) => new Map(state && keys.includes(key) ? [[key, { state }]] : []));
      expect([state, "handedAt" in viewOf(r, s2.code)]).toEqual([state, shown]);
      expect([state, r.board.views(r.board.boardCards()).some((v) => v.handedAt)], "the board read says the same").toEqual([state, shown]);
    }
  });

  it("the board read carries it on every open card, from one statement and one read of the outbox (each notice once, only the read's cards)", () => {
    const r = rig();
    const { main, s1, s2 } = plan(r);
    const other = plan(r);
    finish(r, DEV_A, s1.code);
    finish(r, DEV_A, other.s1.code);
    const key = hand(r, s2, "dev-b", "one-notice");
    hand(r, other.s2, "dev-b", "one-notice");                 // one notice carried both hand-overs
    const asked: string[][] = [];
    r.board.setNoticeProgress((keys) => { asked.push([...keys]); return new Map([[key, { state: "delivered" }]]); });
    const all = r.board.views(r.board.boardCards());
    expect(Object.fromEntries(all.filter((v) => v.handedAt).map((v) => [v.id, v.handedAt]))).toEqual({ [s2.code]: rowsOf(r, s2)[0]!.at, [other.s2.code]: rowsOf(r, other.s2)[0]!.at });
    expect(asked, "one read, the notice once").toEqual([["one-notice"]]);
    asked.length = 0;
    expect(r.board.view(r.board.getCard(main.code)).handedAt, "the main task, open or not, has no hand-over of its own here").toBeUndefined();
    expect(asked, "a card with no hand-over reads nothing of the outbox").toEqual([]);
  });
});

describe("2. what the waker settles", () => {
  it("the handoff takes the key of the notice that carried it; the notice says S-2 can start", () => {
    const r = rig();
    const { s1, s2 } = plan(r);
    const w = wired(r);
    finish(r, DEV_A, s1.code);
    w.fire();
    const toB = w.sent.filter((s) => s.instance === "dev-b");
    expect(toB).toHaveLength(1);
    expect(toB[0]!.message).toContain("you can start it");
    expect(rowsOf(r, s2)[0]!.key).toBe(toB[0]!.key);
    expect(w.settled.filter((e) => e.uuid === s2.uuid && e.kind === "handoff")).toEqual([expect.objectContaining({ instance: "dev-b", key: toB[0]!.key })]);
    expect(w.settled.filter((e) => e.uuid === s2.uuid && e.kind === "words"), "no comment was carried: nothing to say of one").toEqual([]);
  });

  it("an instance with the task board off: the handoff says so", () => {
    const r = rig();
    const { s1, s2 } = plan(r);
    const w = wired(r);
    finish(r, DEV_A, s1.code);
    r.boardOff.add("dev-b");                                  // its board was switched off while the news gathered
    w.fire();
    expect(rowsOf(r, s2)[0]).toMatchObject({ to: "dev-b", why: "ready", skip: "board_off" });
    expect(w.sent.filter((s) => s.instance === "dev-b")).toEqual([]);
  });

  it("the card started while the news gathered: the handoff no longer stands (not_waiting), and nothing is sent for it", () => {
    const r = rig();
    const { s1, s2 } = plan(r);
    const w = wired(r);
    finish(r, DEV_A, s1.code);
    r.board.moveCard(ANN, s2.code, "claimed", {});            // a person started it before the 10 s were up
    w.fire();
    expect(rowsOf(r, s2)[0]).toMatchObject({ skip: "not_waiting" });
    // (the person's own move is news of its own — "asks you to start it" — but the card is no longer "ready")
    expect(w.sent.filter((s) => s.instance === "dev-b").map((s) => s.message).join("\n")).not.toContain("you can start it");
  });

  it("the fleet could not take the notice: not_taken", () => {
    const r = rig();
    const { s1, s2 } = plan(r);
    const w = wired(r, { deliver: () => false });
    finish(r, DEV_A, s1.code);
    w.fire();
    expect(rowsOf(r, s2)[0]).toMatchObject({ skip: "not_taken" });
  });

  it("a comment in the same window whose writer may not reach the instance is held back, the card is still handed over", () => {
    const r = rig();
    const { s1, s2 } = plan(r);
    const w = wired(r);
    finish(r, DEV_A, s1.code);
    r.board.updateCard(LEAD, s2.code, { comment: "@dev-b heads up: use the shared palette" });
    r.contactHeld.add("lead");
    w.fire();
    const commentEntry = r.board.detail(s2.code).comments.at(-1)!.id;
    expect(r.board.entryWakes(s2.code).get(commentEntry)![0]).toMatchObject({ to: "dev-b", skip: "contact_held" });
    expect(rowsOf(r, s2)[0]!.key, "the handoff went").toBeTruthy();
    expect(rowsOf(r, s2)[0]!.skip).toBeUndefined();
    expect(w.sent.filter((s) => s.instance === "dev-b")).toHaveLength(1);
  });

  it("a handoff and a comment that the same notice carries are both settled, each its own way", () => {
    const r = rig();
    const { s1, s2 } = plan(r);
    const w = wired(r);
    finish(r, DEV_A, s1.code);
    r.board.updateCard(LEAD, s2.code, { comment: "@dev-b the palette is in assets/" });
    w.fire();
    const key = rowsOf(r, s2)[0]!.key!;
    const commentEntry = r.board.detail(s2.code).comments.at(-1)!.id;
    expect(r.board.entryWakes(s2.code).get(commentEntry)![0]!.key).toBe(key);
    expect(w.sent.filter((s) => s.instance === "dev-b")).toHaveLength(1);
  });
});

describe("3. what a main task lists of its sub tasks", () => {
  it("the moves of its sub tasks, oldest first, with who made them and the sub task's number and title — nothing else", () => {
    const r = rig();
    const { main, s1, s2 } = plan(r);
    finish(r, DEV_A, s1.code);
    r.board.moveCard(DEV_B, s2.code, "claimed", {});
    r.board.updateCard(ANN, s2.code, { comment: "a comment is not a move" });
    r.board.updateCard(DEV_B, s2.code, { log: "a log line is not a move" });
    const events = r.board.detail(main.code).subEvents;
    expect(events.map((e) => [e.card, e.actor, e.data.from, e.data.to])).toEqual([
      [s1.code, "dev-a", "open", "claimed"], [s1.code, "dev-a", "claimed", "done"], [s2.code, "dev-b", "open", "claimed"]]);
    expect(events[0]).toMatchObject({ title: "Design doc", actorKind: "instance" });
    expect(events.map((e) => e.id)).toEqual([...events.map((e) => e.id)].sort((a, b) => a - b));
  });

  it("only a main task has them; a sub task's own page reads its own history", () => {
    const r = rig();
    const { s1 } = plan(r);
    finish(r, DEV_A, s1.code);
    expect(r.board.detail(s1.code).subEvents).toEqual([]);
    const lone = r.board.createCards(ANN, { project: "Game", cards: [{ title: "No sub tasks" }] }).cards[0]!;
    expect(r.board.detail(lone.code).subEvents).toEqual([]);
  });

  it("the newest 80 of them, and only the data a page needs (no card uuid, no cascade marks)", () => {
    const r = rig();
    const { main, s1 } = plan(r);
    for (let i = 0; i < 45; i++) { r.board.moveCard(ANN, s1.code, "claimed", {}); r.board.moveCard(ANN, s1.code, "open", {}); }
    expect(r.board.detail(main.code).subEvents).toHaveLength(80);
    r.board.moveCard(ANN, main.code, "cancelled", { reason: "no longer needed" });
    const last = r.board.detail(main.code).subEvents.at(-1)!;
    expect(Object.keys(last).sort()).toEqual(["actor", "actorKind", "at", "card", "data", "id", "title"]);
    expect(last.data).toEqual({ from: expect.any(String), to: "cancelled", auto: true });
  });
});

describe("4. how far a handoff got", () => {
  const T0 = Date.parse("2026-11-26T10:00:00Z");
  const at = new Date(T0).toISOString();
  const row = (over: Record<string, unknown> = {}) => ({ id: 7, card: "S-2", to: "dev-b", why: "ready" as const, after: "S-1", at, key: "k1", ...over });
  const progress = (state: string, extra: Record<string, unknown> = {}) => new Map([["k1", { target: "dev-b", state: state as never, createdAt: at, finishedAt: null, consumedAt: null, ...extra }]]);

  it("each stage of the outbox has its word, as under a comment; read is the CLI's own evidence (consumed_at)", () => {
    for (const [state, want] of [["queued", "queued"], ["delivering", "queued"], ["delivered", "delivered"], ["failed", "failed"], ["uncertain", "uncertain"], ["cancelled", "withdrawn"]] as const) {
      expect([state, handoffViews([row()], progress(state), T0 + 1000)[0]!.state]).toEqual([state, want]);
    }
    expect(handoffViews([row()], progress("delivered", { consumedAt: "2026-11-26T10:00:20Z" }), T0 + 30_000)[0]).toMatchObject({ state: "read", readAt: "2026-11-26T10:00:20Z" });
  });

  it("not handed over yet is sending, and lost after a while; a reason is kept; a key the outbox lost is unknown", () => {
    expect(handoffViews([row({ key: undefined })], new Map(), T0 + 5_000)[0]).toMatchObject({ state: "sending" });
    expect(handoffViews([row({ key: undefined })], new Map(), T0 + 3 * 60_000)[0]).toMatchObject({ state: "skipped", skip: "lost" });
    expect(handoffViews([row({ key: undefined, skip: "board_off" })], new Map(), T0)[0]).toMatchObject({ state: "skipped", skip: "board_off" });
    expect(handoffViews([row()], new Map(), T0)[0]).toMatchObject({ state: "unknown" });
  });

  it("carries the card, the instance, why, the predecessor and the time — no key, no text, no delivery id", () => {
    const view = handoffViews([row()], progress("delivered"), T0)[0]!;
    expect(JSON.stringify(view)).not.toMatch(/k1|task-board|deliveryId/);
    expect(Object.keys(view).sort()).toEqual(["after", "at", "card", "id", "state", "to", "why"]);
  });
});

describe("5. the source: claim before you start", () => {
  it("the notice that hands a card over says to claim it first — assigned, and ready (the second when everything it waited for is done)", () => {
    const r = rig();
    const { s1, s2 } = plan(r);
    const w = wired(r);
    r.board.createCards(ANN, { cards: [{ parent: r.board.findCard(s1.parent!)!.code, title: "Free step", assignee: "dev-a", needsReview: false }] });
    finish(r, DEV_A, s1.code);
    w.fire();
    const toB = w.sent.find((m) => m.instance === "dev-b")!.message;
    expect(toB).toContain(`everything it waited for is done — you can start it: claim it first (task claim ${s2.code}), then start`);
    const toA = w.sent.find((m) => m.instance === "dev-a")!.message;
    expect(toA).toMatch(/assigned to you by Ann — claim it first \(task claim S-\d+\), then start/);
    // The notice never claims for it: nothing moved S-2 on its own.
    expect(r.board.findCard(s2.uuid)!.status).toBe("open");
  });

  it("a whole plan assigned at once says to claim a card before starting on it", () => {
    const r = rig();
    const main = r.board.createCards(ANN, { project: "Game", cards: [{ title: "Plan", needsReview: false }] }).cards[0]!;
    const w = wired(r);
    for (let i = 0; i < 5; i++) r.board.createCards(ANN, { cards: [{ parent: main.code, title: `Step ${i}`, assignee: "dev-a", needsReview: false }] });
    w.fire();
    expect(w.sent.find((m) => m.instance === "dev-a")!.message).toContain("claim a card (task claim ID) before you start on it");
  });

  it("task get on a card that can start says how it starts; not on a claimed one, one that waits, or one nobody has", () => {
    const r = rig();
    const { s1, s2 } = plan(r);
    const free = r.board.createCards(ANN, { cards: [{ parent: r.board.findCard(s1.parent!)!.code, title: "Nobody's", needsReview: false }] }).cards[0]!;
    const text = (code: string) => cardText(r.board, r.board.getCard(code));
    expect(text(s1.code)).toContain(`to start it: claim it first (task claim ${s1.code}), then work — the board shows dev-a on it only once it is in progress`);
    expect(text(s2.code), "it waits for S-1").not.toContain("to start it");
    expect(text(free.code), "nobody has it").not.toContain("to start it");
    r.board.moveCard(DEV_A, s1.code, "claimed", {});
    expect(text(s1.code), "claimed").not.toContain("to start it");
    r.board.moveCard(DEV_A, s1.code, "done", { result: "ok" });
    expect(text(s2.code), "ready now").toContain(`task claim ${s2.code}`);
  });

  it("wakeMessage is exact for one assigned card (the line the agent reads first)", () => {
    const wake = { instance: "dev-a", uuid: "u1", code: "S-7", title: "Build it", parent: "M-1", reasons: ["assigned"], by: { assigned: "lead" }, texts: {} } as never;
    expect(wakeMessage([wake])).toBe('[Task board] S-7 "Build it": assigned to you by lead — claim it first (task claim S-7), then start. Read it with: task get S-7');
  });
});

describe("6. compatibility", () => {
  it("a database from before the table opens and grows it; nothing else on the card is different", () => {
    const r = rig();
    const { main, s1, s2 } = plan(r);
    finish(r, DEV_A, s1.code);
    const path = r.path;
    r.db.close();
    const raw = new Database(path);
    raw.exec("DROP TABLE task_handoffs");
    raw.close();
    const again = rig(path);
    expect(again.board.handoffsOf([s2.uuid])).toEqual([]);
    expect(again.board.detail(main.code).children.map((c) => c.id)).toEqual([s1.code, s2.code]);
    expect(again.board.detail(s2.code).card.status).toBe("open");
    const check = new Database(path, { readonly: true });
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'task_handoffs'").get()).toBeTruthy();
    check.close();
  });

  it("pruning a card takes its handoffs; the sweep takes those a release without the table left behind", async () => {
    const r = rig();
    const { s1, s2 } = plan(r);
    finish(r, DEV_A, s1.code);
    expect(rowsOf(r, s2)).toHaveLength(1);
    const raw = (r.db as unknown as { db: Database.Database }).db;
    raw.prepare("INSERT INTO task_handoffs (task_id, instance, why, at) VALUES ('gone-card', 'dev-b', 'ready', '2026-11-01T00:00:00Z')").run();
    // A card with no project that finished long ago is pruned with its rows.
    const loose = r.board.createCards(DEV_A, { cards: [{ title: "Old", assignee: "dev-a" }] }).cards[0]!;
    raw.prepare("UPDATE tasks SET status = 'done', updated_at = '2020-01-01T00:00:00Z', done_at = '2020-01-01T00:00:00Z', project_id = NULL WHERE id = ?").run(loose.uuid);
    await r.db.pruneOldTasks(30);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM task_handoffs WHERE task_id = ?").get(loose.uuid)).toEqual({ n: 0 });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM task_handoffs WHERE task_id = 'gone-card'").get()).toEqual({ n: 0 });
    expect(rowsOf(r, s2), "a live card keeps its row").toHaveLength(1);
  });
});
