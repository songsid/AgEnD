/**
 * A main task nobody confirms goes straight to `done` when its last sub task does, and nobody wrapped it up: its definition
 * of done stayed unticked and nobody summed it up on the card. The owner heard only that the last sub task (which it handed
 * out) was finished — "step in only if it needs you" — never that the whole main task had finished, and the default
 * instructions never said to tick the definition of done or to leave a result and a comment on the main task.
 *   1. A main task nobody confirms goes straight to done when its last sub task does; its owner is sent the wrap-up notice
 *      (what was missing: unticked items, no result), as one that went to review already was. Not when nothing is missing,
 *      and not for the writer itself (its own answer says so instead).
 *   2. The notice holds while the card is in review or done and still lacks something; it drops once the owner filled it in or
 *      the card was reopened. `get` says a done main task "finished without a wrap-up" until then.
 *   3. The owner can wrap a done main task up (check, result, comment) in one update.
 *   4. The default instructions and the task-board skill tell an agent to do it.
 *
 * Isolation: every database is a temp file.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SchedulerDb } from "../src/scheduler/db.js";
import type { Actor, TaskBoard, Wake } from "../src/scheduler/task-board.js";
import { cardText } from "../src/scheduler/task-board-text.js";
import { TaskBoardWaker, wakeMessage } from "../src/task-board-waker.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const LEAD: Actor = { kind: "instance", name: "lead" };
const DEV: Actor = { kind: "instance", name: "dev-a" };
const QA: Actor = { kind: "instance", name: "qa" };
const INSTANCES = ["lead", "dev-a", "qa"];

const dirs: string[] = [], dbs: SchedulerDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function open(): TaskBoard {
  const d = mkdtempSync(join(tmpdir(), "task-board-wrap-up-")); dirs.push(d);
  const db = new SchedulerDb(join(d, "scheduler.db")); dbs.push(db);
  db.board.setCommentRouting({ instances: () => INSTANCES, enabled: () => true });
  return db.board;
}
/** What each write woke, as the fleet's waker would be handed it. */
function heard(board: TaskBoard) {
  const wakes: Wake[] = [];
  board.onChange((c) => { wakes.push(...c.wakes); });
  return { take: () => wakes.splice(0) };
}

/** An agent opens a main task for itself with a definition of done, and a sub task for dev-a and one for qa. */
function plan(board: TaskBoard, over: Record<string, unknown> = {}) {
  const main = board.createCards(LEAD, { cards: [{ title: "Publish the report", assignee: "lead", acceptance: ["report attached", "reviewer sign-off"], ...over }] }).cards[0]!;
  const [draft, review] = board.createCards(LEAD, { parent: main.code, cards: [{ title: "Draft", assignee: "dev-a" }, { title: "Review", assignee: "qa" }] }).cards;
  return { main, draft: draft!, review: review! };
}
function finishBoth(board: TaskBoard, p: ReturnType<typeof plan>, last: Actor = QA) {
  board.moveCard(DEV, p.draft.code, "claimed");
  board.moveCard(DEV, p.draft.code, "done", { result: "drafted" });
  board.moveCard(QA, p.review.code, "claimed");
  return board.moveCard(last === QA ? QA : last, p.review.code, "done", { result: "no blocking issues" });
}

describe("1. the owner of a main task that finished by itself is told to wrap it up", () => {
  it("an agent's own main task goes straight to done when its last sub task does, and its owner hears both news — the sub task, and the wrap-up", () => {
    const board = open(), w = heard(board);
    const p = plan(board);
    w.take();
    finishBoth(board, p);
    const main = board.getCard(p.main.code);
    expect(main.status).toBe("done");
    expect(main.needsReview).toBe(false);
    expect(main.acceptance.every((a) => !a.done)).toBe(true);
    const lead = w.take().filter((x) => x.instance === "lead").map((x) => ({ code: x.code, reasons: x.reasons }));
    expect(lead).toContainEqual({ code: p.main.code, reasons: ["wrap_up"] });
    // The sub task's own news (it handed it out) still comes, as before.
    expect(lead).toContainEqual({ code: p.review.code, reasons: ["progress"] });
  });

  it("the notice says what is missing and what a wrap-up is, without saying how the card got to done", () => {
    const board = open(), w = heard(board);
    const p = plan(board);
    finishBoth(board, p);
    const wrap = w.take().find((x) => x.instance === "lead" && x.code === p.main.code)!;
    const held = board.wakeHolds(wrap)!;
    const text = wakeMessage([held], (uuid) => board.findCard(uuid));
    expect(text).toContain("it is done, but 2 definition-of-done items unchecked, no result");
    expect(text).toContain("2 definition-of-done items unchecked, no result");
    expect(text).toContain("wrap it up with update: check the items that are met, result: a short summary");
    expect(text).toContain("a comment on the card for the person");
    expect(text).not.toContain("went to review");
    expect(text).not.toContain("by itself");
  });

  it("one message carries both: the finished sub task and the main task to wrap up", () => {
    const board = open(), w = heard(board);
    const p = plan(board);
    finishBoth(board, p);
    const mine = w.take().filter((x) => x.instance === "lead").map((x) => board.wakeHolds(x)).filter((x): x is Wake => x !== null);
    const text = wakeMessage(mine, (uuid) => board.findCard(uuid));
    expect(text).toContain("3 things on your cards");
    expect(text).toContain(`${p.review.code} "Review": finished by qa`);
    expect(text).toContain(`${p.main.code} "Publish the report": it is done, but 2 definition-of-done items unchecked, no result`);
  });

  it("not when nothing is missing: the definition of done is ticked and a result is written before the last sub task", () => {
    const board = open(), w = heard(board);
    const p = plan(board);
    board.updateCard(LEAD, p.main.code, { check: [1, 2], result: "All delivered." });
    w.take();
    finishBoth(board, p);
    expect(board.getCard(p.main.code).status).toBe("done");
    expect(w.take().filter((x) => x.code === p.main.code && x.reasons.includes("wrap_up"))).toEqual([]);
  });

  it("a missing result alone is enough; so are unticked items alone", () => {
    const a = open(), wa = heard(a);
    const pa = plan(a);
    a.updateCard(LEAD, pa.main.code, { check: [1, 2] });
    wa.take();
    finishBoth(a, pa);
    const noResult = wa.take().find((x) => x.code === pa.main.code && x.reasons.includes("wrap_up"))!;
    expect(wakeMessage([a.wakeHolds(noResult)!], (u) => a.findCard(u))).toContain("it is done, but no result —");

    const b = open(), wb = heard(b);
    const pb = plan(b);
    b.updateCard(LEAD, pb.main.code, { result: "ok" });
    wb.take();
    finishBoth(b, pb);
    const unticked = wb.take().find((x) => x.code === pb.main.code && x.reasons.includes("wrap_up"))!;
    expect(wakeMessage([b.wakeHolds(unticked)!], (u) => b.findCard(u))).toContain("but 2 definition-of-done items unchecked —");
  });

  it("a main task with no definition of done and no result is missing the result: the owner is told", () => {
    const board = open(), w = heard(board);
    const p = plan(board, { acceptance: [] });
    finishBoth(board, p);
    expect(w.take().filter((x) => x.instance === "lead" && x.code === p.main.code).map((x) => x.reasons)).toEqual([["wrap_up"]]);
  });

  it("the writer is not woken for its own write: it is told in the answer of the move instead", () => {
    const board = open(), w = heard(board);
    const p = plan(board, { assignee: "dev-a" });
    board.moveCard(QA, p.review.code, "claimed");
    board.moveCard(QA, p.review.code, "done", { result: "ok" });
    w.take();
    board.moveCard(DEV, p.draft.code, "claimed");
    const done = board.moveCard(DEV, p.draft.code, "done", { result: "drafted" });
    expect(board.getCard(p.main.code).status).toBe("done");
    expect(w.take().filter((x) => x.code === p.main.code && x.instance === "dev-a")).toEqual([]);
    const note = done.notes.find((n) => n.includes("every sub task is done, so it is done by itself"))!;
    expect(note).toBe(`${p.main.code} "Publish the report": every sub task is done, so it is done by itself, though 2 definition-of-done items unchecked, no result — fill that in with update (check the items that are met, result: a short summary), and tell the person on the card`);
    expect(done.said.find((n) => n.key === "main_done")?.args).toEqual([p.main.code, "Publish the report"]);
  });

  it("another instance's move is told that the owner is told", () => {
    const board = open();
    const p = plan(board);
    const done = finishBoth(board, p);
    expect(done.notes).toContain(`${p.main.code} "Publish the report": every sub task is done, so it is done by itself, though 2 definition-of-done items unchecked, no result — lead, its owner, is told to fill that in`);
  });

  it("no note when nothing is missing, and none for a main task that goes to review", () => {
    const a = open();
    const pa = plan(a);
    a.updateCard(LEAD, pa.main.code, { check: [1, 2], result: "ok" });
    expect(finishBoth(a, pa).notes.some((n) => n.includes("done by itself, though"))).toBe(false);
    expect(finishBoth(a, plan(a)).notes.some((n) => n.includes("done by itself"))).toBe(true);

    const b = open();
    const pb = plan(b, { needsReview: true, assignee: "lead" });
    const done = finishBoth(b, pb);
    expect(b.getCard(pb.main.code).status).toBe("review");
    expect(done.said.some((n) => n.key === "main_done")).toBe(false);
  });

  it("a main task with nobody to tell (unassigned) finishes quietly", () => {
    const board = open(), w = heard(board);
    const main = board.createCards(ANN, { cards: [{ title: "Loose", needsReview: false, acceptance: ["x"] }] }).cards[0]!;
    const [s] = board.createCards(ANN, { parent: main.code, cards: [{ title: "Step", assignee: "dev-a" }] }).cards;
    board.moveCard(DEV, s!.code, "claimed");
    w.take();
    board.moveCard(DEV, s!.code, "done", { result: "r" });
    expect(board.getCard(main.code).status).toBe("done");
    expect(w.take().filter((x) => x.code === main.code)).toEqual([]);
  });

  it("a main task that goes to review for the dispatcher to confirm is unchanged: the dispatcher is told, with what is missing, and the owner is not", () => {
    const board = open(), w = heard(board);
    const main = board.createCards(DEV, { cards: [{ title: "Plan", assignee: "dev-a", needsReview: true, dispatcher: { kind: "instance", name: "lead" }, acceptance: ["works"] }] }).cards[0]!;
    const [s] = board.createCards(DEV, { parent: main.code, cards: [{ title: "Step", assignee: "qa" }] }).cards;
    board.moveCard(QA, s!.code, "claimed");
    w.take();
    board.moveCard(QA, s!.code, "done", { result: "r" });
    expect(board.getCard(main.code).status).toBe("review");
    expect(w.take().filter((x) => x.code === main.code).map((x) => ({ to: x.instance, reasons: x.reasons }))).toEqual([{ to: "lead", reasons: ["to_confirm"] }]);
  });

  it("a main task the person confirms still gets its wrap-up before the person looks (review, as before)", () => {
    const board = open(), w = heard(board);
    const p = plan(board, { needsReview: true });
    finishBoth(board, p);
    expect(board.getCard(p.main.code).status).toBe("review");
    const lead = w.take().filter((x) => x.instance === "lead" && x.code === p.main.code);
    expect(lead.map((x) => x.reasons)).toEqual([["confirm_own", "wrap_up"]]);
    expect(wakeMessage(lead.map((x) => board.wakeHolds(x)!), (u) => board.findCard(u))).toContain("went to review by itself, but 2 definition-of-done items unchecked, no result");
  });
});

describe("2. the notice holds while something is missing", () => {
  it("dropped once the owner filled it in, or the person reopened the card", () => {
    const board = open(), w = heard(board);
    const p = plan(board);
    finishBoth(board, p);
    const wrap = w.take().find((x) => x.instance === "lead" && x.code === p.main.code)!;
    expect(board.wakeHolds(wrap)?.reasons).toEqual(["wrap_up"]);

    board.updateCard(LEAD, p.main.code, { check: [1, 2] });
    expect(board.wakeHolds(wrap)?.reasons).toEqual(["wrap_up"]);        // the result is still missing
    board.updateCard(LEAD, p.main.code, { result: "Delivered." });
    expect(board.wakeHolds(wrap)).toBeNull();

    board.updateCard(LEAD, p.main.code, { uncheck: [2], result: "" });
    expect(board.wakeHolds(wrap)?.reasons).toEqual(["wrap_up"]);
    board.moveCard(ANN, p.main.code, "claimed", { reason: "one more look" });      // an agent cannot add to a done card: the person reopens it
    expect(board.getCard(p.main.code).status).toBe("claimed");
    expect(board.wakeHolds(wrap)).toBeNull();
  });

  it("only the owner's: a card that changed hands is no longer the old owner's to wrap up", () => {
    const board = open(), w = heard(board);
    const p = plan(board);
    finishBoth(board, p);
    const wrap = w.take().find((x) => x.instance === "lead" && x.code === p.main.code)!;
    board.updateCard(ANN, p.main.code, { assignee: "dev-a" });
    expect(board.wakeHolds(wrap)).toBeNull();
  });

  it("`get` says a done main task finished without a wrap-up, until it is wrapped up; a sub task never does", () => {
    const board = open();
    const p = plan(board);
    finishBoth(board, p);
    const before = cardText(board, board.getCard(p.main.code));
    expect(before).toContain("finished without a wrap-up: 2 definition-of-done items unchecked, no result (fill in with update: check the items that are met, result: a short summary; comment it for the person)");
    expect(cardText(board, board.getCard(p.review.code))).not.toContain("finished without a wrap-up");
    board.updateCard(LEAD, p.main.code, { check: [1, 2], result: "Delivered." });
    expect(cardText(board, board.getCard(p.main.code))).not.toContain("finished without a wrap-up");
  });
});

describe("3. the owner wraps a done main task up in one update", () => {
  it("check, result and a comment on a done main task: all written, nothing refused, the status stays done", () => {
    const board = open(), w = heard(board);
    const p = plan(board);
    finishBoth(board, p);
    w.take();
    const out = board.updateCard(LEAD, p.main.code, { check: [1, 2], result: "The report is ready; open the attached file.", comment: `Done: the review passed; the report is attached to ${p.draft.code}.` });
    const main = board.getCard(p.main.code);
    expect(main.status).toBe("done");
    expect(main.acceptance.map((a) => a.done)).toEqual([true, true]);
    expect(main.result).toContain("The report is ready");
    expect(out.card.version).toBeGreaterThan(p.main.version);
    expect(board.entries(main.uuid, ["comment"]).some((e) => e.text.includes("the review passed"))).toBe(true);
  });
});

describe("4. through the fleet's waker", () => {
  it("what the board woke goes out as one [Task board] notice to the owner, and is dropped if the owner fills it in during the gather", () => {
    const run = (fillIn: boolean) => {
      const board = open();
      const sent: Array<{ instance: string; message: string }> = [];
      const timers: Array<{ fn: () => void; live: boolean }> = [];
      const waker = new TaskBoardWaker({
        deliver: (instance, message) => { sent.push({ instance, message }); return true; },
        isInstance: (n) => INSTANCES.includes(n),
        holds: (x) => board.wakeHolds(x),
        card: (uuid) => board.findCard(uuid),
        log: () => {},
        timers: { set: (fn) => { const t = { fn, live: true }; timers.push(t); return t; }, clear: (h) => { (h as { live: boolean }).live = false; } },
      });
      board.onChange((c) => waker.note(c.wakes));
      const p = plan(board);
      finishBoth(board, p);
      if (fillIn) board.updateCard(LEAD, p.main.code, { check: [1, 2], result: "Delivered." });
      for (const t of timers.splice(0)) if (t.live) t.fn();
      return { sent: sent.filter((x) => x.instance === "lead"), p };
    };
    const open1 = run(false);
    expect(open1.sent).toHaveLength(1);
    expect(open1.sent[0]!.message).toContain(`${open1.p.main.code} "Publish the report": it is done, but 2 definition-of-done items unchecked, no result — wrap it up with update`);
    // The sub tasks' own news stays; only the wrap-up goes once the owner already did it.
    const filled = run(true);
    expect(filled.sent.map((x) => x.message).join("\n")).not.toContain("wrap it up with update");
  });
});

describe("5. the instructions tell an agent to wrap a main task up", () => {
  const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  it("the default instructions: it finishes by itself; check, result and a comment; the notice", () => {
    const text = read("src/workflow-templates/default.md");
    expect(text).toContain("A main task you own finishes by itself when its last sub task does");
    expect(text).toContain("`check` for the definition-of-done items that are met, a `result` summary, and a `comment` for the person");
    expect(text).toContain("a main task of yours finished and still to wrap up");
  });
  it("the task-board skill: the same, with the numbers `get` shows, and not only at the end", () => {
    const text = read("src/general-knowledge/skills/task-board/SKILL.md");
    expect(text).toContain("finishes **by itself** when its last sub task is done");
    expect(text).toContain("`check: [1, 3]`");
    expect(text).toContain("Tick items as sub tasks land, not only at the end.");
  });
});
