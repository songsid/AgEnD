/**
 * The task board (src/scheduler/task-board.ts, design: docs/design/task-board.md): projects → main tasks (M-n) → sub
 * tasks (S-n) on the fleet's `tasks` table, and the rules every write goes through.
 *
 *   1. Card numbers, creation defaults and the two levels.
 *   2. Projects.
 *   3. A main task with sub tasks follows them; only a person confirms it.
 *   4. Who confirms what: the review gate, results and acceptance.
 *   5. Claiming, blocking and dependencies (a cancelled dependency still holds, as the task tool always had it).
 *   6. Editing: ownership, limits, versions, cycles.
 *   7. Comments an assignee has not seen yet.
 *   8. Cancelling and restoring.
 *   9. Change notifications and search.
 *  10. The fleet's `task` tool on the same rows: its shapes kept, the review gate held.
 *  11. Migration from a database without the board, and a release without it writing rows after (downgrade).
 *  12. Retention keeps the board's record.
 *
 * Isolation: every database is a temp file; nothing else runs.
 */
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SchedulerDb } from "../src/scheduler/db.js";
import { cardCode, TaskBoardError, type Actor, type BoardChange, type TaskBoard, type WakeReason } from "../src/scheduler/task-board.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const DEV: Actor = { kind: "instance", name: "dev-a" };
const DEV2: Actor = { kind: "instance", name: "dev-b" };
const SCRIPT: Actor = { kind: "script", name: "web-token" };

const dirs: string[] = [];
const dbs: SchedulerDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed by the test */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dir(): string { const d = mkdtempSync(join(tmpdir(), "task-board-")); dirs.push(d); return d; }
function open(path = join(dir(), "scheduler.db")): { db: SchedulerDb; board: TaskBoard; path: string } {
  const db = new SchedulerDb(path);
  dbs.push(db);
  return { db, board: db.board, path };
}
/** A board with one project, "Game". */
function withProject() {
  const o = open();
  const project = o.board.createProject(ANN, { name: "Game" });
  return { ...o, project };
}
const main = (board: TaskBoard, actor: Actor, extra: Record<string, unknown> = {}) =>
  board.createCards(actor, { project: "Game", cards: [{ title: "Build the leaderboard", ...extra }] }).cards[0]!;
const sub = (board: TaskBoard, actor: Actor, parent: string, extra: Record<string, unknown> = {}) =>
  board.createCards(actor, { cards: [{ parent, title: "A step", ...extra }] }).cards[0]!;
const code = (e: unknown) => (e instanceof TaskBoardError ? e.code : String(e));
function refusal(fn: () => unknown): string {
  try { fn(); } catch (e) { return code(e); }
  throw new Error("expected a refusal");
}

describe("1. card numbers, creation defaults and the two levels", () => {
  it("main and sub tasks count separately; loose numbers, uuids and uuid prefixes all find a card", () => {
    const { board } = withProject();
    const m1 = main(board, ANN), m2 = main(board, ANN);
    const s1 = sub(board, ANN, m1.code);
    expect([m1.code, m2.code, s1.code]).toEqual(["M-1", "M-2", "S-1"]);
    expect(cardCode("m 2")).toBe("M-2");
    expect(board.findCard(" s-1 ")?.uuid).toBe(s1.uuid);
    expect(board.findCard(m2.uuid)?.code).toBe("M-2");
    expect(board.findCard(m2.uuid.slice(0, 8))?.code).toBe("M-2");
    expect(board.findCard("M-99")).toBeUndefined();
  });

  it("an instance's card is its own until assigned; a person's is nobody's", () => {
    const { board } = withProject();
    expect(main(board, DEV).assignee).toBe("dev-a");
    expect(main(board, ANN).assignee).toBeNull();
    expect(main(board, ANN, { assignee: "dev-b" }).assignee).toBe("dev-b");
  });

  it("a main task waits for the person's confirmation by default, a sub task does not; an instance cannot open a main task that skips it", () => {
    const { board } = withProject();
    const m = main(board, ANN);
    expect(m.needsReview).toBe(true);
    expect(sub(board, ANN, m.code).needsReview).toBe(false);
    expect(main(board, ANN, { needsReview: false }).needsReview).toBe(false);
    expect(refusal(() => main(board, DEV, { needsReview: false }))).toBe("forbidden");
  });

  it("a batch can point at its own earlier cards; a sub task of a sub task is refused", () => {
    const { board } = withProject();
    const { cards } = board.createCards(DEV, { project: "Game", cards: [
      { title: "Members" }, { parent: "#1", title: "Table" }, { parent: "#1", title: "Login", dependsOn: ["#2"] },
    ] });
    expect(cards.map((c) => c.code)).toEqual(["M-1", "S-1", "S-2"]);
    expect(cards[2]!.deps).toEqual([cards[1]!.uuid]);
    expect(refusal(() => sub(board, DEV, "S-1"))).toBe("invalid");
    expect(refusal(() => board.createCards(DEV, { cards: [{ title: "x", dependsOn: ["#5"] }] }))).toBe("invalid");
  });

  it("limits are checked and name the card of a batch", () => {
    const { board } = withProject();
    expect(() => board.createCards(DEV, { cards: [{ title: "ok" }, { title: "x".repeat(101) }] })).toThrow(/^card 2: the title is too long/);
  });
});

describe("2. projects", () => {
  it("names are unique (any case), not only digits; an archived project takes no new main task", () => {
    const { board } = withProject();
    expect(refusal(() => board.createProject(ANN, { name: "game" }))).toBe("invalid");
    expect(refusal(() => board.createProject(ANN, { name: "123" }))).toBe("invalid");
    const p = board.createProject(ANN, { name: "Website" });
    board.updateProject(ANN, p.id, { archived: true });
    expect(refusal(() => board.createCards(ANN, { project: "Website", cards: [{ title: "x" }] }))).toBe("invalid");
  });

  it("only a person creates or changes a project, or moves a main task to another one; its sub tasks follow", () => {
    const { board } = withProject();
    expect(refusal(() => board.createProject(DEV, { name: "Mine" }))).toBe("forbidden");
    const other = board.createProject(ANN, { name: "Website" });
    const m = main(board, DEV);
    const s = sub(board, DEV, m.code);
    expect(refusal(() => board.updateCard(DEV, m.code, { projectId: other.id }))).toBe("forbidden");
    board.updateCard(ANN, m.code, { projectId: other.id });
    expect(board.getCard(s.code).projectId).toBe(other.id);
    board.updateCard(ANN, m.code, { projectId: null });
    expect(board.getCard(m.code).projectId).toBeNull();
    expect(board.getCard(s.code).projectId).toBeNull();
  });
});

describe("3. a main task with sub tasks follows them", () => {
  it("open → in progress → review by itself; an instance cannot confirm it, a person can", () => {
    const { board } = withProject();
    const m = main(board, DEV);
    const [s1, s2] = board.createCards(DEV, { parent: m.code, cards: [{ title: "One" }, { title: "Two" }] }).cards;
    expect(board.getCard(m.code).status).toBe("open");
    board.moveCard(DEV, s1!.code, "claimed");
    expect(board.getCard(m.code).status).toBe("claimed");
    board.moveCard(DEV, s1!.code, "done", { result: "did one" });
    board.moveCard(DEV, s2!.code, "claimed");
    const { notes } = board.moveCard(DEV, s2!.code, "done", { result: "did two" });
    expect(board.getCard(m.code).status).toBe("review");
    expect(notes.join("\n")).toMatch(/waiting for the person's confirmation/);
    expect(refusal(() => board.moveCard(DEV, m.code, "done"))).toBe("forbidden");
    board.moveCard(ANN, m.code, "done");
    expect(board.getCard(m.code).status).toBe("done");
  });

  it("an instance moves the sub tasks, not the main task; only a person reopens a confirmed one by adding to it", () => {
    const { board } = withProject();
    const m = main(board, DEV);
    const s = sub(board, DEV, m.code);
    expect(refusal(() => board.moveCard(DEV, m.code, "claimed"))).toBe("forbidden");
    board.moveCard(DEV, s.code, "claimed");
    board.moveCard(DEV, s.code, "done", { result: "r" });
    board.moveCard(ANN, m.code, "done");
    expect(refusal(() => sub(board, DEV, m.code))).toBe("forbidden");
    expect(board.getCard(m.code).status).toBe("done");
    sub(board, ANN, m.code);
    expect(board.getCard(m.code).status).toBe("claimed");
  });

  it("a main task that skips the person's confirmation is done by itself", () => {
    const { board } = withProject();
    const m = main(board, ANN, { needsReview: false });
    const s = sub(board, DEV, m.code);
    board.moveCard(DEV, s.code, "claimed");
    board.moveCard(DEV, s.code, "done", { result: "r" });
    expect(board.getCard(m.code).status).toBe("done");
  });

  it("sending it back needs a reason, goes to in progress (never open), and its owner resubmits it with a result", () => {
    const { board } = withProject();
    const m = main(board, DEV);
    const s = sub(board, DEV, m.code);
    board.moveCard(DEV, s.code, "claimed");
    board.moveCard(DEV, s.code, "done", { result: "r" });
    expect(refusal(() => board.moveCard(ANN, m.code, "claimed"))).toBe("invalid");
    board.moveCard(ANN, m.code, "claimed", { reason: "the scores are wrong" });
    const back = board.getCard(m.code);
    expect(back.status).toBe("claimed");
    expect(board.newComments(back).map((e) => [e.kind, e.text])).toEqual([["reject", "the scores are wrong"]]);
    expect(refusal(() => board.moveCard(DEV, m.code, "review"))).toBe("invalid");      // no result yet
    board.moveCard(DEV, m.code, "review", { result: "fixed the sort" });
    expect(board.getCard(m.code).status).toBe("review");
  });

  it("an instance blocks the main task itself, but cannot reopen a finished one by blocking it", () => {
    const { board } = withProject();
    const m = main(board, DEV);
    const s = sub(board, DEV, m.code);
    board.moveCard(DEV, s.code, "claimed");
    board.moveCard(DEV, m.code, "blocked", { reason: "which leaderboard period?" });
    expect(board.getCard(m.code).blockedReason).toBe("which leaderboard period?");
    board.moveCard(DEV, m.code, "claimed");
    board.moveCard(DEV, s.code, "done", { result: "r" });
    board.moveCard(ANN, m.code, "done");
    expect(refusal(() => board.moveCard(DEV, m.code, "blocked", { reason: "x" }))).toBe("invalid");
  });
});

describe("4. who confirms what", () => {
  it("an instance finishes its sub task; a flagged one goes to review; an instance cannot clear the flag", () => {
    const { board } = withProject();
    const m = main(board, DEV);
    const plain = sub(board, DEV, m.code);
    const flagged = sub(board, DEV, m.code, { needsReview: true });
    board.moveCard(DEV, plain.code, "claimed");
    board.moveCard(DEV, plain.code, "done", { result: "r" });
    board.moveCard(DEV, flagged.code, "claimed");                 // one card at a time (section 13)
    expect(refusal(() => board.moveCard(DEV, flagged.code, "done", { result: "r" }))).toBe("needs_review");
    expect(refusal(() => board.updateCard(DEV, flagged.code, { needsReview: false }))).toBe("forbidden");
    board.moveCard(DEV, flagged.code, "review", { result: "r" });
    expect(board.getCard(flagged.code).status).toBe("review");
    board.updateCard(ANN, flagged.code, { needsReview: false });
    expect(board.getCard(flagged.code).needsReview).toBe(false);
  });

  it("finishing takes a result, and unchecked acceptance items take a reason", () => {
    const { board } = withProject();
    const m = main(board, DEV);
    const s = sub(board, DEV, m.code, { acceptance: ["returns 401", "has tests"] });
    board.moveCard(DEV, s.code, "claimed");
    expect(refusal(() => board.moveCard(DEV, s.code, "done"))).toBe("invalid");
    expect(() => board.moveCard(DEV, s.code, "done", { result: "r" })).toThrow(/2 acceptance item\(s\) unchecked \(1, 2\)/);
    board.updateCard(DEV, s.code, { check: [1, 2] });
    board.moveCard(DEV, s.code, "done", { result: "r" });
    expect(board.getCard(s.code).status).toBe("done");
  });

  it("a person moves anything anywhere; a card with unfinished sub tasks is never finished", () => {
    const { board } = withProject();
    const m = main(board, ANN);
    expect(board.moveCard(ANN, m.code, "done").card.status).toBe("done");
    const m2 = main(board, ANN);
    sub(board, ANN, m2.code);
    expect(refusal(() => board.moveCard(ANN, m2.code, "done"))).toBe("invalid");
  });
});

describe("5. claiming, blocking and dependencies", () => {
  it("an instance takes an unassigned card (it becomes its own), never one assigned to another", () => {
    const { board } = withProject();
    const free = main(board, ANN);
    const theirs = main(board, ANN, { assignee: "dev-b" });
    expect(board.moveCard(DEV, free.code, "claimed").card.assignee).toBe("dev-a");
    expect(refusal(() => board.moveCard(DEV, theirs.code, "claimed"))).toBe("forbidden");
  });

  it("dependencies must be done first — a cancelled one still holds — and putting a card back clears its assignee", () => {
    const { board } = withProject();
    const first = main(board, DEV);
    const second = main(board, DEV, { dependsOn: [first.code] });
    expect(refusal(() => board.moveCard(DEV, second.code, "claimed"))).toBe("blocked_by_deps");
    board.moveCard(ANN, first.code, "cancelled");
    expect(refusal(() => board.moveCard(DEV, second.code, "claimed"))).toBe("blocked_by_deps");
    board.moveCard(ANN, first.code, "open");
    board.moveCard(DEV, first.code, "claimed");
    const { notes } = board.moveCard(ANN, first.code, "done");
    expect(notes).toContain(`${second.code}'s dependencies are all done; it can start`);
    board.moveCard(DEV, second.code, "claimed");
    board.moveCard(DEV, second.code, "open");
    expect(board.getCard(second.code).assignee).toBeNull();
  });

  it("a sub task waits for its main task's dependencies too", () => {
    const { board } = withProject();
    const before = main(board, DEV);
    const m = main(board, DEV, { dependsOn: [before.code] });
    const s = sub(board, DEV, m.code);
    expect(board.view(s).unmetDeps).toEqual([before.code]);
    expect(refusal(() => board.moveCard(DEV, s.code, "claimed"))).toBe("blocked_by_deps");
  });

  it("blocking needs a reason; unblocking clears it", () => {
    const { board } = withProject();
    const c = main(board, DEV);
    board.moveCard(DEV, c.code, "claimed");
    expect(refusal(() => board.moveCard(DEV, c.code, "blocked"))).toBe("invalid");
    board.moveCard(DEV, c.code, "blocked", { reason: "need the SMTP account" });
    board.moveCard(DEV, c.code, "claimed");
    expect(board.getCard(c.code).blockedReason).toBe("");
  });
});

describe("6. editing", () => {
  it("someone else's card takes comments, not edits", () => {
    const { board } = withProject();
    const c = main(board, DEV);
    expect(refusal(() => board.updateCard(DEV2, c.code, { goal: "mine now" }))).toBe("forbidden");
    expect(board.updateCard(DEV2, c.code, { comment: "looks good" }).card.version).toBe(2);
  });

  it("state is at most five lines, and every limit is checked", () => {
    const { board } = withProject();
    const c = main(board, DEV);
    expect(refusal(() => board.updateCard(DEV, c.code, { state: "1\n2\n3\n4\n5\n6" }))).toBe("too_long");
    expect(refusal(() => board.updateCard(DEV, c.code, { goal: "x".repeat(301) }))).toBe("too_long");
  });

  it("a stale version is refused with who changed it; no change keeps the version", () => {
    const { board } = withProject();
    const c = main(board, DEV);
    board.updateCard(DEV, c.code, { state: "next: tests", version: 1 });
    expect(() => board.updateCard(ANN, c.code, { goal: "g", version: 1 })).toThrow(/M-1 changed meanwhile \(you have v1, it is v2, last changed by dev-a\)/);
    expect(board.updateCard(ANN, c.code, { goal: "g", version: 2 }).card.version).toBe(3);
    expect(board.updateCard(ANN, c.code, { goal: "g" }).notes).toEqual(["no change"]);
    expect(board.getCard(c.code).version).toBe(3);
  });

  it("replacing the checklist keeps the ticks of items whose text did not change", () => {
    const { board } = withProject();
    const c = main(board, DEV, { acceptance: ["a", "b"] });
    board.updateCard(DEV, c.code, { check: [1, 2] });
    board.updateCard(DEV, c.code, { acceptance: ["a", "b2", "c"] });
    expect(board.getCard(c.code).acceptance).toEqual([{ text: "a", done: true }, { text: "b2", done: false }, { text: "c", done: false }]);
  });

  it("a dependency loop is refused, through main and sub tasks too", () => {
    const { board } = withProject();
    const a = main(board, DEV), b = main(board, DEV, { dependsOn: ["M-1"] });
    expect(() => board.updateCard(DEV, a.code, { dependsOn: [b.code] })).toThrow(/wait on each other forever: M-1 → M-2 → M-1/);
    const s = sub(board, DEV, b.code);
    expect(refusal(() => board.updateCard(DEV, b.code, { dependsOn: [s.code] }))).toBe("invalid");
    expect(refusal(() => board.updateCard(DEV, s.code, { dependsOn: [b.code] }))).toBe("invalid");
    expect(refusal(() => board.updateCard(DEV, a.code, { dependsOn: [s.code] }))).toBe("invalid");    // a → S-1 → M-2 → a
  });

  it("an instance cannot drop someone else's unfinished dependency", () => {
    const { board } = withProject();
    const first = main(board, ANN);
    const c = main(board, ANN, { assignee: "dev-a", dependsOn: [first.code] });
    expect(refusal(() => board.updateCard(DEV, c.code, { dependsOn: [] }))).toBe("forbidden");
    board.updateCard(ANN, c.code, { dependsOn: [] });
    expect(board.getCard(c.code).deps).toEqual([]);
  });

  it("reordering places a card between two others without a new version", () => {
    const { board } = withProject();
    const a = main(board, ANN), b = main(board, ANN), c = main(board, ANN);
    board.reorder(ANN, c.code, a.code, b.code);
    expect(board.getCard(c.code).sort).toBeGreaterThan(board.getCard(a.code).sort);
    expect(board.getCard(c.code).sort).toBeLessThan(board.getCard(b.code).sort);
    expect(board.getCard(c.code).version).toBe(1);
  });

  it("placing cards between the same two again and again spreads the column out when the numbers run out", () => {
    const { board } = withProject();
    const a = main(board, ANN), b = main(board, ANN);
    const placed: string[] = [];
    for (let i = 0; i < 30; i++) {
      const c = main(board, ANN);
      board.reorder(ANN, c.code, a.code, placed[0] ?? b.code);
      placed.unshift(c.code);
    }
    const column = board.boardCards().sort((x, y) => x.sort - y.sort);
    expect(column.map((c) => c.code)).toEqual([a.code, ...placed, b.code]);
    // Thirty halvings of a gap of 1 would leave 1e-9 between neighbours; spread out, it never falls under 1e-6.
    const gaps = column.slice(1).map((c, i) => c.sort - column[i]!.sort);
    expect(Math.min(...gaps)).toBeGreaterThan(1e-6);
  });
});

describe("7. comments the assignee has not seen", () => {
  it("stay new until the assignee writes, and that write hands them over first", () => {
    const { board } = withProject();
    const c = main(board, DEV);
    board.updateCard(ANN, c.code, { comment: "use 7 days" });
    expect(board.view(board.getCard(c.code)).newCommentCount).toBe(1);
    const { notes } = board.updateCard(DEV, c.code, { state: "next: tokens" });
    expect(notes).toContain("new comment (Ann): use 7 days");
    expect(board.view(board.getCard(c.code)).newCommentCount).toBe(0);
  });
});

describe("8. cancelling and restoring", () => {
  it("cancelling a main task cancels its unfinished sub tasks; restoring brings them back where they were", () => {
    const { board } = withProject();
    const m = main(board, DEV);
    const s1 = sub(board, DEV, m.code), s2 = sub(board, DEV, m.code);
    board.moveCard(DEV, s1.code, "claimed");
    board.moveCard(DEV, s1.code, "done", { result: "r" });
    board.moveCard(DEV, s2.code, "claimed");
    board.moveCard(ANN, m.code, "cancelled");
    expect([board.getCard(s1.code).status, board.getCard(s2.code).status]).toEqual(["done", "cancelled"]);
    expect(refusal(() => board.moveCard(DEV, s2.code, "claimed"))).toBe("invalid");
    board.moveCard(ANN, m.code, "open");
    expect(board.getCard(s2.code).status).toBe("claimed");
    expect(board.getCard(m.code).status).toBe("claimed");
  });

  it("an instance cancels only what it opened, with a reason", () => {
    const { board } = withProject();
    const mine = main(board, DEV), theirs = main(board, DEV2);
    expect(refusal(() => board.moveCard(DEV, theirs.code, "cancelled", { reason: "dup" }))).toBe("forbidden");
    expect(refusal(() => board.moveCard(DEV, mine.code, "cancelled"))).toBe("invalid");
    board.moveCard(DEV, mine.code, "cancelled", { reason: "duplicate of M-2" });
  });
});

describe("9. change notifications and search", () => {
  it("a listener hears each committed write once, with the card numbers it touched — a refused write says nothing", () => {
    const { board } = withProject();
    const heard: BoardChange[] = [];
    board.onChange((c) => heard.push(c));
    const m = main(board, DEV);
    const s = sub(board, DEV, m.code);
    board.moveCard(DEV, s.code, "claimed");
    expect(() => board.moveCard(DEV, s.code, "done")).toThrow();
    board.createProject(ANN, { name: "Other" });
    expect(heard).toEqual([
      { rev: 2, ids: ["M-1"], actors: ["dev-a"], projects: false, wakes: [] },
      { rev: 3, ids: ["S-1"], actors: ["dev-a"], projects: false, wakes: [] },
      { rev: 4, ids: ["S-1", "M-1"], actors: ["dev-a"], projects: false, wakes: [] },
      { rev: 5, ids: [], actors: [], projects: true, wakes: [] },
    ]);
  });

  it("finds cards by title, fields, checklist and comments, and says where; a card number finds that card", () => {
    const { board } = withProject();
    main(board, DEV, { title: "Login API" });
    main(board, DEV, { title: "Ranking", context: "see src/rank.ts" });
    const c = main(board, DEV, { title: "Mail", acceptance: ["SMTP works"] });
    board.updateCard(ANN, c.code, { comment: "the relay host is smtp.example" });
    expect(board.search("login").map((h) => [h.card.code, h.match])).toEqual([["M-1", null]]);
    expect(board.search("rank.ts")[0]!.match).toEqual({ field: "context", text: "see src/rank.ts" });
    expect(board.search("relay")[0]!.match?.field).toBe("comment");
    expect(board.search("SMTP").map((h) => h.card.code)).toEqual(["M-3"]);
    expect(board.search("m2")[0]!.card.code).toBe("M-2");
    expect(board.search("done")).toEqual([]);      // the checklist's JSON keys are not text
  });
});

describe("9b. a board read", () => {
  it("gives every card what the card-by-card rules give: progress, unmet dependencies, comments", () => {
    const { board } = withProject();
    const before = main(board, DEV);
    const m = main(board, DEV, { dependsOn: [before.code] });
    const [a, b] = board.createCards(DEV, { parent: m.code, cards: [{ title: "a" }, { title: "b", dependsOn: ["#1"] }] }).cards;
    board.moveCard(ANN, a!.code, "claimed");
    board.moveCard(ANN, a!.code, "blocked", { reason: "why" });
    board.updateCard(ANN, b!.code, { comment: "one" });
    board.updateCard(DEV2, b!.code, { comment: "two" });
    const cards = board.boardCards();
    const views = board.views(cards);
    cards.forEach((card, i) => {
      const v = views[i]!;
      expect(v.progress, card.code).toEqual(card.kind === "main" ? board.progress(card) : null);
      expect(v.unmetDeps, card.code).toEqual(board.unmetDeps(card).map((c) => c.code));
      expect(v.newCommentCount, card.code).toBe(board.newComments(card).length);
      expect(v).toEqual(board.view(card));
    });
    expect(views.find((v) => v.id === b!.code)).toMatchObject({ dependsOn: [a!.code], unmetDeps: [a!.code, before.code], commentCount: 2, lastComment: { author: "dev-b", authorKind: "instance" } });
    expect(views.find((v) => v.id === m.code)!.progress).toEqual({ total: 2, open: 1, claimed: 0, blocked: 1, review: 0, done: 0 });
  });
});

describe("10. the fleet's `task` tool on the same rows", () => {
  it("create keeps the task's shape and puts it on the board as a main task under no project", () => {
    const { db, board } = open();
    const t = db.createTask({ title: "Fix bug", created_by: "dev-a" });
    expect(Object.keys(t).sort()).toEqual(["assignee", "code", "created_at", "created_by", "depends_on", "description", "id", "priority", "result", "status", "title", "updated_at"]);
    expect(t.code).toBe("M-1");
    expect(db.getTaskByPrefix("m1").id).toBe(t.id);       // the card number the dashboard shows
    expect(() => db.getTaskByPrefix("M-9")).toThrow(/Task "M-9" not found/);
    expect(t).toMatchObject({ status: "open", assignee: null, description: null, depends_on: [], result: null });
    const card = board.getCard(t.id);
    expect(card).toMatchObject({ code: "M-1", kind: "main", projectId: null, needsReview: false, createdBy: "dev-a" });
    expect(board.boardCards().map((c) => c.code)).toEqual(["M-1"]);
    expect(board.events(t.id).map((e) => e.type)).toEqual(["created"]);
  });

  it("claim and done move the card like the board does: versions, history, timestamps", () => {
    const { db, board } = open();
    const t = db.createTask({ title: "Fix bug", created_by: "lead" });
    db.claimTask(t.id, "dev-a", DEV);
    db.completeTask(t.id, "patched", { kind: "instance", name: "dev-a" });
    const card = board.getCard(t.id);
    expect(card).toMatchObject({ status: "done", assignee: "dev-a", result: "patched", version: 3 });
    expect(card.startedAt).not.toBeNull();
    expect(card.doneAt).not.toBeNull();
    expect(board.events(t.id).map((e) => e.type)).toEqual(["created", "assigned", "moved", "updated", "moved"]);
  });

  it("the review gate holds for the tool: done becomes review, and only a person takes it out of review to done", () => {
    const { db, board } = withProject();
    const card = main(board, ANN, { assignee: "dev-a" });
    db.claimTask(card.uuid, "dev-a", DEV);
    expect(db.completeTask(card.uuid, "r", DEV).status).toBe("review");
    expect(() => db.updateTask(card.uuid, { status: "done" }, DEV)).toThrow(/waiting for the person's confirmation/);
    expect(() => db.updateTask(card.uuid, { status: "done" }, SCRIPT)).toThrow(/waiting for the person's confirmation/);   // a token script is no person
    // Taking it back out of the person's queue says why (the tool's update has no reason to give).
    expect(() => db.updateTask(card.uuid, { status: "claimed" }, DEV)).toThrow(/taking a card back from review needs a reason/);
    board.moveCard(DEV, card.code, "claimed", { reason: "found a bug" });
    expect(board.detail(card.code).comments.map((e) => e.text)).toEqual(["withdrawn from review: found a bug"]);
    expect(db.updateTask(card.uuid, { status: "done" }, DEV).status).toBe("review");
    expect(db.updateTask(card.uuid, { status: "done" }, ANN).status).toBe("done");
  });

  it("a sub task moved by the tool moves its main task along", () => {
    const { db, board } = withProject();
    const m = main(board, ANN);
    const s = sub(board, ANN, m.code, { assignee: "dev-a" });
    db.claimTask(s.uuid, "dev-a", DEV);
    expect(board.getCard(m.code).status).toBe("claimed");
    db.completeTask(s.uuid, "r", DEV);
    expect(board.getCard(m.code).status).toBe("review");
    expect(() => db.updateTask(m.uuid, { status: "done" }, DEV)).toThrow(/has sub tasks/);
  });

  it("on the board's cards an instance is held to the board's rules; the tool's own tasks keep the old leniency", () => {
    const { db, board } = withProject();
    const done = main(board, ANN, { assignee: "dev-a" });
    board.moveCard(ANN, done.code, "done");
    const theirs = main(board, ANN, { assignee: "dev-b" });
    const before = main(board, ANN);
    const later = main(board, ANN, { dependsOn: [before.code] });
    const step = sub(board, ANN, later.code);
    expect(() => db.updateTask(done.uuid, { status: "open" }, DEV)).toThrow(/only a card in progress or blocked can go back to open/);
    expect(() => db.updateTask(theirs.uuid, { status: "cancelled" }, DEV)).toThrow(/cancel only the cards it opened/);
    expect(() => db.updateTask(theirs.uuid, { assignee: "dev-a" }, DEV)).toThrow(/you cannot reassign it/);
    expect(() => db.updateTask(theirs.uuid, { result: "mine" }, DEV)).toThrow(/you can only comment/);
    expect(() => db.claimTask(theirs.uuid, "dev-a", DEV)).toThrow(/assigned to dev-b; you cannot take it/);
    expect(() => db.claimTask(step.uuid, "dev-a", DEV)).toThrow(/waits for M-3/);           // its main task's dependency
    expect(() => db.completeTask(theirs.uuid, "r", DEV)).toThrow(/assigned to dev-b/);
    expect(board.getCard(theirs.code)).toMatchObject({ status: "open", assignee: "dev-b" });
    // A person, and the tool's own tasks: as before.
    expect(db.updateTask(done.uuid, { status: "open" }, ANN).status).toBe("open");
    const loose = db.createTask({ title: "Loose", created_by: "lead", assignee: "dev-b" });
    expect(db.updateTask(loose.id, { status: "cancelled" }, DEV).status).toBe("cancelled");
    expect(db.updateTask(loose.id, { status: "open" }, DEV).status).toBe("open");
    expect(db.claimTask(loose.id, "dev-a", DEV).assignee).toBe("dev-a");
  });

  it("errors keep their wording", () => {
    const { db } = open();
    const a = db.createTask({ title: "A", created_by: "x" });
    const b = db.createTask({ title: "B", created_by: "x", depends_on: [a.id] });
    expect(() => db.claimTask(b.id, "w", { kind: "instance", name: "w" })).toThrow(/is blocked by/);
    db.claimTask(a.id, "w", { kind: "instance", name: "w" });
    expect(() => db.claimTask(a.id, "w", { kind: "instance", name: "w" })).toThrow(/is claimed, cannot claim/);
    expect(() => db.updateTask("nope", { status: "done" }, DEV)).toThrow(/not found/i);
  });
});

describe("11. migration and a release without the board", () => {
  /** The `tasks` table as releases before the board created it, with rows. */
  function oldDatabase(path: string) {
    const raw = new Database(path);
    raw.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'normal', assignee TEXT, created_by TEXT NOT NULL, depends_on TEXT, result TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    const add = raw.prepare("INSERT INTO tasks (id, title, status, created_by, created_at, updated_at) VALUES (?, ?, ?, 'lead', ?, ?)");
    add.run("bbbbbbbb-0000-0000-0000-000000000002", "Second", "done", "2026-01-02T00:00:00.000Z", "2026-01-05T00:00:00.000Z");
    add.run("aaaaaaaa-0000-0000-0000-000000000001", "First", "open", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    raw.close();
  }

  it("existing tasks become main tasks numbered in the order they were opened; a done one gets its done time", () => {
    const path = join(dir(), "scheduler.db");
    oldDatabase(path);
    const { board } = open(path);
    expect(board.getCard("aaaaaaaa-0000-0000-0000-000000000001")).toMatchObject({ code: "M-1", kind: "main", projectId: null, version: 1 });
    expect(board.getCard("bbbbbbbb-0000-0000-0000-000000000002")).toMatchObject({ code: "M-2", doneAt: "2026-01-05T00:00:00.000Z" });
    expect(board.createCards(ANN, { cards: [{ title: "New" }] }).cards[0]!.code).toBe("M-3");
  });

  it("a row a release without the board writes (old columns only) is read, and numbered on the next open", () => {
    const { db, path, board } = open();
    const first = db.createTask({ title: "Before", created_by: "x" });
    board.updateCard(ANN, first.id, { comment: "kept" });
    db.close();
    // The release before the board: its INSERT and UPDATE name only the columns it knows.
    const raw = new Database(path);
    raw.prepare("INSERT INTO tasks (id, title, description, priority, assignee, created_by, depends_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("cccccccc-0000-0000-0000-000000000003", "From the old release", null, "normal", null, "y", null, "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
    raw.prepare("UPDATE tasks SET status = 'claimed', assignee = 'dev-a', updated_at = ? WHERE id = ?").run("2026-02-02T00:00:00.000Z", first.id);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(2);
    raw.close();
    const again = open(path);
    expect(again.board.getCard("cccccccc-0000-0000-0000-000000000003")).toMatchObject({ code: "M-2", kind: "main" });
    expect(again.board.getCard(first.id)).toMatchObject({ code: "M-1", status: "claimed", assignee: "dev-a" });
    expect(again.board.detail("M-1").comments.map((e) => e.text)).toEqual(["kept"]);
  });

  it("a sub task finished by a release without the board: its main task catches up on the next open", () => {
    const { board, path, db } = withProject();
    const m = main(board, ANN);
    const s = sub(board, ANN, m.code);
    db.close();
    const raw = new Database(path);
    raw.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(s.uuid);
    raw.close();
    expect(open(path).board.getCard(m.code).status).toBe("review");
  });

  it("opening again only reads: it does not wait for another connection's write (the CLI opens the file per command)", () => {
    const { db, path } = open();
    db.createTask({ title: "A", created_by: "x" });
    db.close();
    const raw = new Database(path);
    raw.exec("BEGIN IMMEDIATE");
    try {
      const started = Date.now();
      expect(open(path).board.getCard("M-1").title).toBe("A");
      expect(Date.now() - started).toBeLessThan(2000);       // the lock would hold it for busy_timeout (5 s), then fail
    } finally { raw.exec("ROLLBACK"); raw.close(); }
  });

  it("migrating twice changes nothing", () => {
    const { db, path } = open();
    db.createTask({ title: "A", created_by: "x" });
    db.close();
    const a = open(path); a.db.close();
    const b = open(path);
    expect(b.board.boardCards().map((c) => [c.code, c.version])).toEqual([["M-1", 1]]);
  });
});

describe("11b. a board read is bounded", () => {
  it("long-done main tasks leave the board unless asked for, but the project's numbers still count them", () => {
    const { board, db, path } = withProject();
    const old = main(board, ANN);
    board.moveCard(ANN, old.code, "done");
    const live = main(board, ANN);
    sub(board, ANN, live.code);
    db.close();
    const raw = new Database(path);
    raw.prepare("UPDATE tasks SET done_at = '2020-01-01T00:00:00.000Z' WHERE code = ?").run(old.code);
    raw.close();
    const again = open(path);
    expect(again.board.boardCards().map((c) => c.code)).toEqual(["M-2", "S-1"]);
    expect(again.board.boardCards(undefined, true).map((c) => c.code)).toEqual(["M-1", "M-2", "S-1"]);
    const stats = again.board.projectStats()[String(again.board.listProjects()[0]!.id)]!;
    expect(stats).toMatchObject({ mains: 2, units: { total: 2, done: 1, open: 1 }, percent: 50 });
  });
});

describe("12. retention keeps the board's record", () => {
  const count = (path: string, sql: string, ...args: unknown[]) => {
    const raw = new Database(path);
    try { return (raw.prepare(sql).get(...args) as { n: number }).n; } finally { raw.close(); }
  };
  /** Every row last changed long ago. */
  const age = (path: string) => { const raw = new Database(path); raw.prepare("UPDATE tasks SET updated_at = '2020-01-01T00:00:00.000Z'").run(); raw.close(); };

  it("prunes old finished work outside projects with its comments and history; an active project keeps its record", async () => {
    const { db, board, path } = withProject();
    const loose = db.createTask({ title: "Loose", created_by: "x" });
    board.updateCard(ANN, loose.id, { comment: "bye" });
    db.completeTask(loose.id, undefined, ANN);
    const kept = main(board, ANN);
    board.moveCard(ANN, kept.code, "done");
    const family = board.createCards(ANN, { cards: [{ title: "No project" }] }).cards[0]!;
    const child = sub(board, ANN, family.code);
    board.moveCard(ANN, child.code, "done");
    board.moveCard(ANN, family.code, "done");
    db.close();
    age(path);
    const again = open(path);
    expect(await again.db.pruneOldTasks(30)).toBe(3);
    expect(again.db.getTask(loose.id)).toBeNull();
    expect(again.board.findCard(family.code)).toBeUndefined();
    expect(again.board.findCard(child.code)).toBeUndefined();
    expect(again.board.findCard(kept.code)).toBeDefined();
    for (const id of [loose.id, family.uuid, child.uuid]) {
      expect(count(path, "SELECT COUNT(*) AS n FROM task_entries WHERE task_id = ?", id)).toBe(0);
      expect(count(path, "SELECT COUNT(*) AS n FROM task_events WHERE task_id = ?", id)).toBe(0);
    }
  });

  it("an archived project's finished families go when all of each is old; a recent sub task or a live dependency keeps one", async () => {
    const { db, board, path, project } = withProject();
    const done = (ref: string) => board.moveCard(ANN, ref, "done");
    const gone = main(board, ANN);
    done(sub(board, ANN, gone.code).code); done(gone.code);
    const recent = main(board, ANN);
    const late = sub(board, ANN, recent.code);
    done(late.code); done(recent.code);
    const needed = main(board, ANN);
    done(needed.code);
    board.updateProject(ANN, project.id, { archived: true });
    const waiting = board.createCards(ANN, { cards: [{ title: "Needs it", dependsOn: [needed.code] }] }).cards[0]!;
    db.close();
    age(path);
    const raw = new Database(path);
    raw.prepare("UPDATE tasks SET updated_at = ? WHERE id IN (?, ?)").run(new Date().toISOString(), late.uuid, waiting.uuid);
    raw.close();
    const again = open(path);
    expect(await again.db.pruneOldTasks(30)).toBe(2);
    expect(again.board.findCard(gone.code)).toBeUndefined();
    expect(again.board.findCard(recent.code)).toBeDefined();
    expect(again.board.findCard(late.code)).toBeDefined();
    expect(again.board.findCard(needed.code)).toBeDefined();
  });

  it("what a release without the board prunes (the task, not its comments, history or sub tasks) is cleared on the next prune", async () => {
    const { db, board, path } = withProject();
    const m = board.createCards(ANN, { cards: [{ title: "No project" }] }).cards[0]!;
    const s = sub(board, ANN, m.code);
    board.updateCard(ANN, s.code, { comment: "on the sub task" });
    board.moveCard(ANN, s.code, "done");
    board.moveCard(ANN, m.code, "done");
    board.updateCard(ANN, m.code, { comment: "on the main task" });
    db.close();
    age(path);
    // The old prune deletes rows from `tasks` only — here the main task, as if its sub task had been newer then.
    const raw = new Database(path);
    raw.prepare("DELETE FROM tasks WHERE id = ?").run(m.uuid);
    raw.close();
    const again = open(path);
    expect(await again.db.pruneOldTasks(30)).toBe(1);                 // the sub task left without its main task
    expect(again.board.findCard(s.code)).toBeUndefined();
    expect(count(path, "SELECT COUNT(*) AS n FROM task_entries")).toBe(0);
    expect(count(path, "SELECT COUNT(*) AS n FROM task_events")).toBe(0);
  });
});

describe("13. an instance works on one card of the board at a time", () => {
  it("a second card is refused while one is in progress — claiming, resuming a blocked one, taking one back from review", () => {
    const { board } = withProject();
    const m = main(board, ANN, { assignee: "dev-a" });
    const [a, b, c] = [sub(board, ANN, m.code, { assignee: "dev-a" }), sub(board, ANN, m.code, { assignee: "dev-a" }), sub(board, ANN, m.code, { assignee: "dev-a", needsReview: true })];
    board.moveCard(DEV, a.code, "claimed");
    expect(refusal(() => board.moveCard(DEV, b.code, "claimed"))).toBe("one_at_a_time");
    expect(() => board.moveCard(DEV, b.code, "claimed")).toThrow(/you already have S-1 "A step" in progress/);
    // Blocked work does not count: block it, start the next.
    board.moveCard(DEV, a.code, "blocked", { reason: "which scores count?" });
    board.moveCard(DEV, b.code, "claimed");
    expect(refusal(() => board.moveCard(DEV, a.code, "claimed"))).toBe("one_at_a_time");
    board.moveCard(DEV, b.code, "done", { result: "r" });
    board.moveCard(DEV, c.code, "claimed");
    board.moveCard(DEV, c.code, "review", { result: "r" });
    board.moveCard(DEV, a.code, "claimed");
    expect(refusal(() => board.moveCard(DEV, c.code, "claimed", { reason: "found a bug" }))).toBe("one_at_a_time");
    // The main task that follows these sub tasks is in progress too, and does not count.
    expect(board.getCard(m.code).status).toBe("claimed");
    expect(board.inProgress("dev-a").map((x) => x.code)).toEqual([a.code]);
  });

  it("the person is not limited, the tool's own tasks neither count nor are counted, and `task done` of an open card passes", () => {
    const { db, board } = withProject();
    const [x, y] = [main(board, ANN, { assignee: "dev-a" }), main(board, ANN, { assignee: "dev-a" })];
    board.moveCard(ANN, x.code, "claimed");
    board.moveCard(ANN, y.code, "claimed");                       // the person moves the instance's cards as they like
    expect(board.inProgress("dev-a")).toHaveLength(2);
    const plain = [db.createTask({ title: "P1", created_by: "dev-a" }), db.createTask({ title: "P2", created_by: "dev-a" })];
    for (const t of plain) db.claimTask(t.id, "dev-a", DEV);       // the tool's own tasks: as before
    expect(board.inProgress("dev-a").map((c) => c.code)).toEqual([x.code, y.code]);
    board.moveCard(ANN, y.code, "open");
    const z = main(board, ANN, { assignee: "dev-a", needsReview: false });
    expect(db.completeTask(z.uuid, "r", DEV).status).toBe("done");   // claimed on the way to done: no new work started
  });
});

describe("14. who handed a card out (dispatcher)", () => {
  it("defaults: the person who opened it, the instance that opened it for another, nobody for its own; sub tasks take their main task's", () => {
    const { db, board } = withProject();
    expect(main(board, ANN).dispatcher).toEqual({ kind: "person", name: "Ann" });
    const lead: Actor = { kind: "instance", name: "lead" };
    const forDev = main(board, lead, { assignee: "dev-a" });
    expect(forDev.dispatcher).toEqual({ kind: "instance", name: "lead" });
    expect(main(board, DEV).dispatcher).toBeNull();
    expect(sub(board, DEV, forDev.code, { assignee: "dev-a" }).dispatcher).toEqual({ kind: "instance", name: "lead" });
    expect(main(board, DEV, { dispatcher: { kind: "instance", name: "lead" } }).dispatcher).toEqual({ kind: "instance", name: "lead" });
    // The tool's plain create for another instance, too; and it is stored.
    const t = db.createTask({ title: "For dev-b", created_by: "lead", assignee: "dev-b" });
    expect(board.getCard(t.id).dispatcher).toEqual({ kind: "instance", name: "lead" });
  });

  it("the dispatcher edits the card and answers its blocked question with the decision; another instance does neither", () => {
    const { board } = withProject();
    const lead: Actor = { kind: "instance", name: "lead" };
    // Opened by the person, handed out through the lead: the lead neither opened it nor owns it.
    const card = main(board, ANN, { assignee: "dev-a", dispatcher: { kind: "instance", name: "lead" } });
    board.moveCard(DEV, card.code, "claimed");
    board.moveCard(DEV, card.code, "blocked", { reason: "error codes or messages?" });
    expect(board.updateCard(lead, card.code, { context: "decided by the person: codes" }).card.context).toBe("decided by the person: codes");
    expect(refusal(() => board.updateCard(DEV2, card.code, { context: "x" }))).toBe("forbidden");
    expect(refusal(() => board.moveCard(DEV2, card.code, "claimed", { comment: "codes" }))).toBe("forbidden");
    expect(() => board.moveCard(lead, card.code, "claimed")).toThrow(/takes the decision as a comment/);
    board.moveCard(lead, card.code, "claimed", { comment: "the person says: codes" });
    expect(board.getCard(card.code)).toMatchObject({ status: "claimed", assignee: "dev-a" });
    expect(board.detail(card.code).comments.map((e) => e.text)).toEqual(["the person says: codes"]);
    expect(board.newComments(board.getCard(card.code)).map((e) => e.author)).toEqual(["lead"]);       // new to its assignee
  });

  it("changed like a field: an instance names one, a person names themselves; only a person is a person", () => {
    const { board } = withProject();
    const card = main(board, DEV);
    expect(board.updateCard(DEV, card.code, { dispatcher: { kind: "instance", name: "lead" } }).card.dispatcher).toEqual({ kind: "instance", name: "lead" });
    expect(refusal(() => board.updateCard(DEV, card.code, { dispatcher: { kind: "person" } }))).toBe("forbidden");
    expect(board.updateCard(ANN, card.code, { dispatcher: { kind: "person" } }).card.dispatcher).toEqual({ kind: "person", name: "Ann" });
    expect(board.updateCard(ANN, card.code, { dispatcher: null }).card.dispatcher).toBeNull();
    expect(board.detail(card.code).history.filter((e) => e.type === "updated").map((e) => (e.data.changes as Record<string, unknown>).dispatcher))
      .toEqual([{ from: null, to: "lead" }, { from: "lead", to: "Ann" }, { from: "Ann", to: null }]);
  });
});

describe("15. whom a write wakes (step 2)", () => {
  function heard(board: TaskBoard) {
    const wakes: Array<{ to: string; code: string; reasons: string[]; by: string; texts: Record<string, string> }> = [];
    board.onChange((c) => { for (const w of c.wakes) wakes.push({ to: w.instance, code: w.code, reasons: w.reasons, by: Object.values(w.by).join(","), texts: w.texts as Record<string, string> }); });
    return { all: wakes, take: () => wakes.splice(0) };
  }
  const LEAD: Actor = { kind: "instance", name: "lead" };

  it("assigned by someone else, not by itself; an assignment waiting on dependencies wakes when they are done", () => {
    const { board } = withProject();
    const h = heard(board);
    const first = main(board, ANN, { assignee: "dev-a" });
    expect(h.take()).toEqual([{ to: "dev-a", code: first.code, reasons: ["assigned"], by: "Ann", texts: {} }]);
    main(board, DEV);                                                   // its own card: nobody hears
    expect(h.take()).toEqual([]);
    const later = main(board, ANN, { assignee: "dev-b", dependsOn: [first.code] });
    board.updateCard(ANN, later.code, { comment: "read the spec first" });
    expect(h.take()).toEqual([]);                                       // waits for M-1: read when it can start
    board.moveCard(DEV, first.code, "claimed");
    board.moveCard(ANN, first.code, "done");
    expect(h.take()).toEqual([{ to: "dev-b", code: later.code, reasons: ["ready"], by: "Ann", texts: {} }]);
  });

  it("a main task that finishes by itself readies what waited for it (the board's own move)", () => {
    const { board } = withProject();
    const h = heard(board);
    const m = main(board, ANN, { needsReview: false });
    const s = sub(board, ANN, m.code, { assignee: "dev-a" });
    const next = main(board, ANN, { assignee: "dev-b", dependsOn: [m.code] });
    h.take();
    board.moveCard(DEV, s.code, "claimed");
    board.moveCard(DEV, s.code, "done", { result: "r" });
    expect(board.getCard(m.code).status).toBe("done");
    expect(h.take()).toEqual([{ to: "dev-b", code: next.code, reasons: ["ready"], by: "dev-a", texts: {} }]);
  });

  it("comments, a send-back, an answer and a confirmation, each with its own words", () => {
    const { board } = withProject();
    const card = main(board, LEAD, { assignee: "dev-a" });
    const h = heard(board);
    board.updateCard(ANN, card.code, { comment: "cache it 30 s" });
    expect(h.take()).toEqual([{ to: "dev-a", code: card.code, reasons: ["comment"], by: "Ann", texts: { comment: "cache it 30 s" } }]);
    board.moveCard(DEV, card.code, "claimed");
    board.moveCard(DEV, card.code, "blocked", { reason: "codes or messages?" });
    // Its dispatcher hears the question, and answers it on the card.
    expect(h.take()).toEqual([{ to: "lead", code: card.code, reasons: ["decide"], by: "dev-a", texts: { decide: "codes or messages?" } }]);
    board.moveCard(LEAD, card.code, "claimed", { comment: "the person says codes" });
    expect(h.take()).toEqual([{ to: "dev-a", code: card.code, reasons: ["answered"], by: "lead", texts: { answered: "the person says codes" } }]);
    board.moveCard(DEV, card.code, "review", { result: "r", reason: "no checklist" });
    // It handed it out: it tells the person the card waits for them.
    expect(h.take()).toEqual([{ to: "lead", code: card.code, reasons: ["to_confirm"], by: "dev-a", texts: {} }]);
    board.moveCard(ANN, card.code, "claimed", { reason: "ties share a rank" });
    expect(h.take()).toEqual([{ to: "dev-a", code: card.code, reasons: ["sent_back"], by: "Ann", texts: { sent_back: "ties share a rank" } }]);
    board.moveCard(DEV, card.code, "review", { result: "r2", reason: "no checklist" });
    h.take();
    board.moveCard(ANN, card.code, "done", { reason: "nice" });
    expect(h.take()).toEqual([
      { to: "dev-a", code: card.code, reasons: ["approved"], by: "Ann", texts: { approved: "nice" } },
      { to: "lead", code: card.code, reasons: ["approved"], by: "Ann", texts: { approved: "nice" } },
    ]);
  });

  it("a card going to the person for confirmation: the instance that handed it out tells them", () => {
    const { board } = withProject();
    const card = main(board, LEAD, { assignee: "dev-a" });
    const h = heard(board);
    board.moveCard(DEV, card.code, "claimed");
    h.take();
    board.moveCard(DEV, card.code, "review", { result: "r" });
    expect(h.take()).toEqual([{ to: "lead", code: card.code, reasons: ["to_confirm"], by: "dev-a", texts: {} }]);
    const own = main(board, ANN, { assignee: "dev-a" });       // the person handed it out: nobody relays it
    h.take();
    board.moveCard(DEV, own.code, "claimed");
    board.moveCard(DEV, own.code, "review", { result: "r" });
    expect(h.take()).toEqual([]);
    const wake = { instance: "lead", uuid: card.uuid, code: card.code, title: card.title, parent: null, reasons: ["to_confirm"] as WakeReason[], by: { to_confirm: "dev-a" }, texts: {} };
    expect(board.wakeHolds(wake)?.reasons).toEqual(["to_confirm"]);
    board.updateCard(ANN, card.code, { needsReview: false });
    expect(board.waitingForPerson().map((w) => w.card.code)).toEqual([own.code]);   // not the person's to confirm any more
    expect(board.wakeHolds(wake)).toBeNull();                   // #2341 review: its confirmation switched off meanwhile
    board.updateCard(ANN, card.code, { needsReview: true });
    expect(board.wakeHolds(wake)?.reasons).toEqual(["to_confirm"]);
    board.moveCard(ANN, card.code, "done");
    expect(board.wakeHolds(wake)).toBeNull();                   // confirmed meanwhile: nothing to relay
  });

  it("a main task sent to the person by its last sub task, not wrapped up, wakes its owner to fill it in", () => {
    const { board } = withProject();
    const m = main(board, ANN, { assignee: "dev-a", acceptance: ["resets Monday"] });
    const review = sub(board, ANN, m.code, { assignee: "dev-b" });
    const h = heard(board);
    board.moveCard(DEV2, review.code, "claimed");
    h.take();
    board.moveCard(DEV2, review.code, "done", { result: "looks good" });
    expect(board.getCard(m.code).status).toBe("review");
    expect(h.take()).toEqual([{ to: "dev-a", code: m.code, reasons: ["wrap_up"], by: "dev-b", texts: {} }]);
  });

  it("cancelling a main task tells the assignees of the sub tasks it takes down, and why", () => {
    const { board } = withProject();
    const m = main(board, { kind: "instance", name: "lead" }, { assignee: "lead" });
    const [a, b] = [sub(board, ANN, m.code, { assignee: "dev-a" }), sub(board, ANN, m.code, { assignee: "dev-b" })];
    board.moveCard(DEV2, b.code, "claimed");
    board.moveCard(DEV2, b.code, "done", { result: "r" });
    const h = heard(board);
    board.moveCard(ANN, m.code, "cancelled", { reason: "the feature is dropped" });
    expect(h.take()).toEqual([
      { to: "lead", code: m.code, reasons: ["cancelled"], by: "Ann", texts: { cancelled: "the feature is dropped" } },
      { to: "dev-a", code: a.code, reasons: ["cancelled"], by: "Ann", texts: { cancelled: `with its main task ${m.code}: the feature is dropped` } },
    ]);                                                                   // dev-b's was done: not taken down
  });

  it("what no longer stands is dropped: a finished card, one now someone else's, a question already answered", () => {
    const { board } = withProject();
    const card = main(board, LEAD, { assignee: "dev-a" });
    board.updateCard(ANN, card.code, { comment: "a word" });          // a comment holds while it is unread (#2303)
    const wake = { instance: "dev-a", uuid: card.uuid, code: card.code, title: card.title, parent: null, reasons: ["comment"] as WakeReason[], by: { comment: "Ann" }, texts: {} };
    expect(board.wakeHolds(wake)?.reasons).toEqual(["comment"]);
    board.updateCard(ANN, card.code, { assignee: "dev-b" });
    expect(board.wakeHolds(wake)).toBeNull();
    board.updateCard(ANN, card.code, { assignee: "dev-a" });
    board.moveCard(DEV, card.code, "claimed");
    board.moveCard(DEV, card.code, "blocked", { reason: "?" });
    const question = { ...wake, instance: "lead", reasons: ["decide"] as WakeReason[] };
    expect(board.wakeHolds(question)?.reasons).toEqual(["decide"]);
    board.moveCard(ANN, card.code, "claimed", { comment: "answered by the person" });
    expect(board.wakeHolds(question)).toBeNull();
    board.moveCard(ANN, card.code, "done");
    expect(board.wakeHolds(wake)).toBeNull();
  });
});
