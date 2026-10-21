/**
 * Step 2's follow-ups (#2303 review and its busy-fleet check): a wake is sent only while it can still be acted on, a
 * dispatcher's answer respects its assignee's limit, the tool's own tasks are not announced, a comment the assignee
 * has already read is not sent, and how many cards an instance may have in progress.
 *
 *   1. Checked again as it goes out: ready, start, answered, sent back (with unchanged controls).
 *   2. A dispatcher answers a blocked card of a busy assignee: the answer is kept, the card waits.
 *   3. The `task` tool's own tasks: no "assigned" notice (board cards keep theirs).
 *   4. A comment the assignee acted on within the window is not sent.
 *   5. Cards an instance opened for itself do not count; `board_cards_at_once` raises the limit.
 *
 * Isolation: temp databases; a simulated clock for the waker's 10 s window (its timers seam); nothing else runs.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SchedulerDb } from "../src/scheduler/db.js";
import { TaskBoardError, type Actor, type TaskBoard, type Wake } from "../src/scheduler/task-board.js";
import { TaskBoardWaker } from "../src/task-board-waker.js";
import { boardCardLimit } from "../src/task-board-tool.js";
import { myWorkText } from "../src/scheduler/task-board-text.js";
import { validateFleetConfig } from "../src/config-validator.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const LEAD: Actor = { kind: "instance", name: "lead" };
const DEV: Actor = { kind: "instance", name: "dev-a" };

const dirs: string[] = [];
const dbs: SchedulerDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A board with project "Game", and the fleet's waker on it with a 10 s window run by hand (`pass`). */
function rig() {
  const d = mkdtempSync(join(tmpdir(), "task-board-2303-")); dirs.push(d);
  const db = new SchedulerDb(join(d, "scheduler.db")); dbs.push(db);
  const board = db.board;
  board.createProject(ANN, { name: "Game" });
  const sent: Array<{ to: string; text: string }> = [];
  let clock = 0;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const waker = new TaskBoardWaker({
    deliver: (to, text) => { sent.push({ to, text }); return true; },
    isInstance: (n) => ["lead", "dev-a", "dev-b"].includes(n),
    holds: (w: Wake) => board.wakeHolds(w),
    card: (u) => board.findCard(u),
    log: () => {},
    timers: { set: (fn, ms) => { const t = { at: clock + ms, fn, live: true }; timers.push(t); return t; }, clear: (h) => { (h as { live: boolean }).live = false; } },
  });
  board.onChange((c) => waker.note(c.wakes));
  /** Let `ms` pass: windows that close meanwhile send. */
  const pass = (ms: number) => {
    clock += ms;
    for (const t of timers.filter((x) => x.live && x.at <= clock)) { t.live = false; t.fn(); }
  };
  const take = () => { pass(10_000); return sent.splice(0); };
  return { db, board, take, pass };
}
const main = (board: TaskBoard, actor: Actor, extra: Record<string, unknown> = {}) =>
  board.createCards(actor, { project: "Game", cards: [{ title: "Build the leaderboard", ...extra }] }).cards[0]!;
const sub = (board: TaskBoard, actor: Actor, parent: string, extra: Record<string, unknown> = {}) =>
  board.createCards(actor, { cards: [{ parent, title: "A step", ...extra }] }).cards[0]!;
function refusal(fn: () => unknown): string {
  try { fn(); } catch (e) { return e instanceof TaskBoardError ? e.code : String(e); }
  throw new Error("expected a refusal");
}

describe("1. a wake is checked again as it goes out: only what can still be acted on", () => {
  it("ready: a dependency finished and reopened within the window is not news; finished and left done, it is", () => {
    const { board, take } = rig();
    const dep = main(board, ANN, { needsReview: false });
    const next = main(board, ANN, { assignee: "dev-a", dependsOn: [dep.code] });
    take();
    board.moveCard(ANN, dep.code, "done");
    board.moveCard(ANN, dep.code, "claimed");                        // reopened before the notice went out
    expect(take()).toEqual([]);
    board.moveCard(ANN, dep.code, "done");
    expect(take()).toEqual([{ to: "dev-a", text: expect.stringContaining(`${next.code} "Build the leaderboard": everything it waited for is done`) }]);
    // Started by the instance itself before the notice went out: not news either.
    const dep2 = main(board, ANN, { needsReview: false });
    const next2 = main(board, ANN, { assignee: "dev-a", dependsOn: [dep2.code] });
    take();
    board.moveCard(ANN, dep2.code, "done");
    board.moveCard(DEV, next2.code, "claimed");
    expect(take()).toEqual([]);
  });

  it("start: started and blocked again within the window is not news; started and left in progress, it is", () => {
    const { board, take } = rig();
    const a = main(board, ANN, { assignee: "dev-a" });
    take();
    board.moveCard(ANN, a.code, "claimed");
    board.moveCard(ANN, a.code, "blocked", { reason: "waits for the art" });
    expect(take()).toEqual([]);
    board.moveCard(ANN, a.code, "claimed", { comment: "art is in" });
    expect(take().map((s) => s.text)).toEqual([expect.stringContaining("Ann answered your blocked question")]);
    const b = main(board, ANN, { assignee: "dev-b" });
    take();
    board.moveCard(ANN, b.code, "claimed");
    expect(take()).toEqual([{ to: "dev-b", text: expect.stringContaining("Ann asks you to start it") }]);
  });

  it("answered: an answer followed by a new question within the window is not sent; an answer left standing is", () => {
    const { board, take } = rig();
    const a = main(board, LEAD, { assignee: "dev-a" });
    board.moveCard(DEV, a.code, "claimed");
    board.moveCard(DEV, a.code, "blocked", { reason: "which scores count?" });
    take();
    board.moveCard(LEAD, a.code, "claimed", { comment: "the best of three" });
    board.moveCard(DEV, a.code, "blocked", { reason: "and ties?" });   // its own move: a new question
    expect(take().filter((s) => s.to === "dev-a")).toEqual([]);
    board.moveCard(LEAD, a.code, "claimed", { comment: "ties share a rank" });
    expect(take()).toEqual([{ to: "dev-a", text: expect.stringContaining('lead answered your blocked question: "ties share a rank"') }]);
  });

  it("sent back: resubmitted within the window is not news; left with the instance, it is", () => {
    const { board, take } = rig();
    const a = main(board, ANN, { assignee: "dev-a" });
    board.moveCard(DEV, a.code, "claimed");
    board.moveCard(DEV, a.code, "review", { result: "r" });
    take();
    board.moveCard(ANN, a.code, "claimed", { reason: "ties share a rank" });
    board.moveCard(DEV, a.code, "review", { result: "r2" });
    expect(take()).toEqual([]);
    board.moveCard(ANN, a.code, "claimed", { reason: "and cache it" });
    expect(take()).toEqual([{ to: "dev-a", text: expect.stringContaining('sent back by Ann: "and cache it"') }]);
  });
});

describe("2. a dispatcher answering a blocked card respects its assignee's limit", () => {
  it("busy assignee: the answer is kept as a comment, the card stays blocked; the assignee resumes it when free", () => {
    const { board, take } = rig();
    const [a, b] = [main(board, LEAD, { assignee: "dev-a" }), main(board, LEAD, { assignee: "dev-a" })];
    board.moveCard(DEV, a.code, "claimed");
    board.moveCard(DEV, a.code, "blocked", { reason: "which scores count?" });
    board.moveCard(DEV, b.code, "claimed");
    take();
    const r = board.moveCard(LEAD, a.code, "claimed", { comment: "the best of three" });
    expect(r.card.status).toBe("blocked");
    expect(r.said.map((n) => n.key)).toEqual(["answer_kept"]);
    expect(r.said[0]!.text).toContain(`dev-a is working on ${b.code}`);
    expect(board.inProgress("dev-a").map((c) => c.code)).toEqual([b.code]);
    expect(board.detail(a.code).comments.map((c) => [c.author, c.text])).toEqual([["lead", "the best of three"]]);
    expect(take()).toEqual([{ to: "dev-a", text: expect.stringContaining('new comment from lead: "the best of three"') }]);
    expect(refusal(() => board.moveCard(DEV, a.code, "claimed"))).toBe("one_at_a_time");   // still one at a time
    board.moveCard(DEV, b.code, "review", { result: "r" });
    expect(board.moveCard(DEV, a.code, "claimed").card.status).toBe("claimed");
  });

  it("idle assignee: the answer moves the card back to in progress (as before)", () => {
    const { board } = rig();
    const a = main(board, LEAD, { assignee: "dev-a" });
    board.moveCard(DEV, a.code, "claimed");
    board.moveCard(DEV, a.code, "blocked", { reason: "which scores count?" });
    const r = board.moveCard(LEAD, a.code, "claimed", { comment: "the best of three" });
    expect(r.card.status).toBe("claimed");
    expect(r.said).toEqual([]);
  });

  it("an answer still needs its words, busy or not", () => {
    const { board } = rig();
    const [a, b] = [main(board, LEAD, { assignee: "dev-a" }), main(board, LEAD, { assignee: "dev-a" })];
    board.moveCard(DEV, a.code, "claimed");
    board.moveCard(DEV, a.code, "blocked", { reason: "q" });
    board.moveCard(DEV, b.code, "claimed");
    expect(refusal(() => board.moveCard(LEAD, a.code, "claimed"))).toBe("invalid");
  });
});

describe("3. the `task` tool's own tasks are not announced", () => {
  it("assigned: a plain task handed to another instance wakes nobody; a board card does", () => {
    const { db, board, take } = rig();
    const t = db.createTask({ title: "Plain", created_by: "lead", assignee: "dev-a" }, LEAD);
    expect(take()).toEqual([]);
    db.updateTask(t.id, { assignee: "dev-b" }, LEAD);                    // given to another: no notice either
    expect(take()).toEqual([]);
    main(board, LEAD, { assignee: "dev-a" });
    expect(take()).toEqual([{ to: "dev-a", text: expect.stringContaining("assigned to you by lead") }]);
  });

  it("other news on a plain task still wakes: a question on one the instance handed out", () => {
    const { db, take } = rig();
    const t = db.createTask({ title: "Plain", created_by: "lead", assignee: "dev-a" }, LEAD);
    db.claimTask(t.id, "dev-a", DEV);
    db.updateTask(t.id, { status: "blocked", result: "which DB?" }, DEV);
    expect(take()).toEqual([{ to: "lead", text: expect.stringContaining("you handed it out and it is blocked") }]);
  });
});

describe("4. a comment its assignee acted on within the window is not sent", () => {
  it("read with its own write (the answer listed it): dropped; not acted on: sent", () => {
    const { board, take } = rig();
    const a = main(board, LEAD, { assignee: "dev-a" });
    board.moveCard(DEV, a.code, "claimed");
    take();
    board.updateCard(LEAD, a.code, { comment: "please look" });
    const r = board.moveCard(DEV, a.code, "review", { result: "r" });
    expect(r.said.map((n) => n.key)).toContain("new_comment");      // it read the comment with its own write
    expect(take()).toEqual([]);
    board.updateCard(LEAD, a.code, { comment: "one more thing" });
    expect(take()).toEqual([{ to: "dev-a", text: expect.stringContaining('new comment from lead: "one more thing"') }]);
  });
});

describe("5. how many cards an instance may have in progress", () => {
  it("cards it opened for itself neither count nor are limited; handed-out cards are, one at a time by default", () => {
    const { board } = rig();
    const [own1, own2] = [main(board, DEV), main(board, DEV)];
    board.moveCard(DEV, own1.code, "claimed");
    board.moveCard(DEV, own2.code, "claimed");                       // two of its own reviews at once
    const [h1, h2] = [main(board, LEAD, { assignee: "dev-a" }), main(board, ANN, { assignee: "dev-a" })];
    board.moveCard(DEV, h1.code, "claimed");                          // its own cards do not count
    expect(refusal(() => board.moveCard(DEV, h2.code, "claimed"))).toBe("one_at_a_time");
    const own3 = main(board, DEV);
    expect(board.moveCard(DEV, own3.code, "claimed").card.status).toBe("claimed");   // nor are they held back at the limit
    board.moveCard(DEV, own3.code, "blocked", { reason: "later" });
    expect(board.inProgress("dev-a").map((c) => c.code)).toEqual([own1.code, own2.code, h1.code]);
    // A sub task it splits off a card handed to it is that card's work: it counts.
    const s = sub(board, DEV, h2.code, { assignee: "dev-a" });
    expect(s.dispatcher).toEqual({ kind: "person", name: "Ann" });
    expect(refusal(() => board.moveCard(DEV, s.code, "claimed"))).toBe("one_at_a_time");
  });

  it("`mine` warns only past the limit, counting what it was handed (not its own cards)", () => {
    const { board } = rig();
    const [own1, own2] = [main(board, DEV), main(board, DEV)];
    board.moveCard(DEV, own1.code, "claimed");
    board.moveCard(DEV, own2.code, "claimed");
    const [h1, h2, h3] = [1, 2, 3].map(() => main(board, ANN, { assignee: "dev-a" }));
    board.moveCard(DEV, h1.code, "claimed");
    expect(myWorkText(board, "dev-a", board.myWork("dev-a"))).not.toContain("⚠");
    board.moveCard(ANN, h2.code, "claimed");                         // the person may
    expect(myWorkText(board, "dev-a", board.myWork("dev-a"))).toContain(" ⚠ 2 cards in progress: one at a time");
    board.setCardLimit(() => 2);
    expect(myWorkText(board, "dev-a", board.myWork("dev-a"))).not.toContain("⚠");
    board.moveCard(ANN, h3.code, "claimed");
    expect(myWorkText(board, "dev-a", board.myWork("dev-a"))).toContain(" ⚠ 3 cards in progress: at most 2 at a time");
  });

  it("board_cards_at_once raises the limit for that instance only, and the refusal names it", () => {
    const { board } = rig();
    board.setCardLimit((name) => (name === "dev-a" ? 2 : 1));
    const [a, b, c] = [main(board, ANN, { assignee: "dev-a" }), main(board, ANN, { assignee: "dev-a" }), main(board, ANN, { assignee: "dev-a" })];
    board.moveCard(DEV, a.code, "claimed");
    board.moveCard(DEV, b.code, "claimed");
    expect(() => board.moveCard(DEV, c.code, "claimed")).toThrow(/at most 2 cards at a time/);
    const [x, y] = [main(board, ANN, { assignee: "dev-b" }), main(board, ANN, { assignee: "dev-b" })];
    const DEV_B: Actor = { kind: "instance", name: "dev-b" };
    board.moveCard(DEV_B, x.code, "claimed");
    expect(() => board.moveCard(DEV_B, y.code, "claimed")).toThrow(/One card at a time/);
  });

  it("the fleet's setting: an instance's board_cards_at_once, else 1; validated as a whole number of at least 1", () => {
    const fleet = { defaults: {}, instances: { reviewer: { board_cards_at_once: 4 }, dev: {} } };
    expect(boardCardLimit(fleet, "reviewer")).toBe(4);
    expect(boardCardLimit(fleet, "dev")).toBe(1);
    expect(boardCardLimit(fleet, "gone")).toBe(1);
    expect(boardCardLimit(undefined, "reviewer")).toBe(1);
    const errors = (v: unknown) => validateFleetConfig({ instances: { r: { working_directory: "/tmp", board_cards_at_once: v } } } as never)
      .errors.filter((e) => e.path.endsWith("board_cards_at_once"));
    expect(errors(3)).toEqual([]);
    for (const bad of [0, -1, 1.5, "2", null]) expect(errors(bad)).toHaveLength(1);
  });
});
