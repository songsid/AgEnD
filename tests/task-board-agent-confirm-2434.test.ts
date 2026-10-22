/**
 * #2434: a card an agent handed out is the agents' own business. The person confirms only the cards they handed out
 * (#2426's rule for a blocked card, for review too).
 *
 *   1. Defaults: an agent's main task needs no review; the person's does.
 *   2. An agent's card that asks for review: its dispatcher confirms it (or sends it back); nobody else but the person.
 *   3. Cards already stuck in review from before #2434: finished by their dispatcher as they are — nothing rewritten.
 *   4. The person's own card: unchanged — only they finish it, clear its review, or hand it to someone else.
 *   5. Notices: the dispatcher is told once that a card waits for its confirmation; never "tell the person".
 *   6. Opened on the board without a project and without review, it is still the board's (assignment notice, limit).
 *
 * Isolation: every database is a temp file; the fleet rig writes a scratch fleet.yaml and starts nothing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SchedulerDb } from "../src/scheduler/db.js";
import { Scheduler } from "../src/scheduler/index.js";
import { FleetManager } from "../src/fleet-manager.js";
import { TaskBoardError, type Actor, type TaskBoard } from "../src/scheduler/task-board.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const LEAD: Actor = { kind: "instance", name: "lead" };
const DEV: Actor = { kind: "instance", name: "dev-a" };
const OTHER: Actor = { kind: "instance", name: "dev-b" };
const dirs: string[] = [];
const dbs: SchedulerDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed by the test */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dir(): string { const d = mkdtempSync(join(tmpdir(), "task-board-2434-")); dirs.push(d); return d; }
function open(): { db: SchedulerDb; board: TaskBoard } {
  const db = new SchedulerDb(join(dir(), "scheduler.db"));
  dbs.push(db);
  return { db, board: db.board };
}
function heard(board: TaskBoard) {
  const wakes: Array<{ to: string; code: string; reasons: string[]; by: string }> = [];
  board.onChange((c) => { for (const w of c.wakes) wakes.push({ to: w.instance, code: w.code, reasons: w.reasons, by: Object.values(w.by).join(",") }); });
  return { take: () => wakes.splice(0) };
}
const card = (board: TaskBoard, actor: Actor, extra: Record<string, unknown> = {}) =>
  board.createCards(actor, { cards: [{ title: "Review PR 42", assignee: "dev-a", ...extra }] }).cards[0]!;
function refusal(fn: () => unknown): string {
  try { fn(); } catch (e) { return e instanceof TaskBoardError ? `${e.code}: ${e.message}` : String(e); }
  throw new Error("expected a refusal");
}
/** The fleet's `task` tool on a scratch board (FleetManager's handler; nothing started). */
function fleet() {
  const d = dir();
  writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
  const fm = new FleetManager(d);
  const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
  (fm as unknown as Record<string, unknown>).scheduler = scheduler;
  dbs.push(scheduler.db);
  return { db: scheduler.db, call: (instance: string, args: Record<string, unknown>) => fm.handleTaskCrudHttp(instance, args) };
}

describe("1. defaults", () => {
  it("an agent's main task needs no review and its assignee finishes it; the person's waits for them", () => {
    const { board } = open();
    const a = card(board, LEAD);
    expect([a.needsReview, a.dispatcher]).toEqual([false, { kind: "instance", name: "lead" }]);
    board.moveCard(DEV, a.code, "claimed");
    expect(board.moveCard(DEV, a.code, "done", { result: "approved, 0 findings" }).card.status).toBe("done");
    const p = card(board, ANN);
    expect([p.needsReview, p.dispatcher]).toEqual([true, { kind: "person", name: "Ann" }]);
    // The agent's own main task (nobody handed it out) too.
    expect(board.createCards(DEV, { cards: [{ title: "Notes" }] }).cards[0]!.needsReview).toBe(false);
  });
});

describe("2. an agent's card that asks for review", () => {
  it("its assignee's done goes to review; only its dispatcher (or the person) confirms it; the dispatcher may send it back", () => {
    const { board } = open();
    const a = card(board, LEAD, { needsReview: true });
    board.moveCard(DEV, a.code, "claimed");
    expect(refusal(() => board.moveCard(DEV, a.code, "done", { result: "r" }))).toBe("needs_review: M-1 needs lead's confirmation; move it to review");
    board.moveCard(DEV, a.code, "review", { result: "r" });
    expect(refusal(() => board.moveCard(DEV, a.code, "done"))).toBe("forbidden: M-1 is waiting for lead's confirmation: only they finish it");
    expect(refusal(() => board.moveCard(OTHER, a.code, "done"))).toBe("forbidden: M-1 is waiting for lead's confirmation: only they finish it");
    expect(board.waitingForPerson()).toEqual([]);                      // never in the person's Needs you
    // Sent back by its dispatcher, with a reason; resubmitted; confirmed.
    expect(refusal(() => board.moveCard(LEAD, a.code, "claimed"))).toBe("invalid: sending work back needs a reason");
    board.moveCard(LEAD, a.code, "claimed", { reason: "add the test for ties" });
    expect(board.newComments(board.getCard(a.code)).map((e) => [e.kind, e.text])).toEqual([["reject", "add the test for ties"]]);
    board.moveCard(DEV, a.code, "review", { result: "r2" });
    expect(board.moveCard(LEAD, a.code, "done", { reason: "looks right" }).card.status).toBe("done");
    expect(board.detail(a.code).comments.map((e) => [e.kind, e.text])).toContainEqual(["approve", "looks right"]);
  });

  it("#2436 review: its assignee cannot drop or replace its dispatcher to confirm it itself; the dispatcher (or the person) can hand it on", () => {
    const { board } = open();
    const a = card(board, LEAD, { needsReview: true });
    for (const to of [null, { kind: "instance" as const, name: "dev-a" }, { kind: "instance" as const, name: "dev-b" }]) {
      expect(refusal(() => board.updateCard(DEV, a.code, { dispatcher: to }))).toBe("forbidden: M-1 waits for lead's confirmation; only they hand it to someone else");
    }
    expect(refusal(() => board.updateCard(OTHER, a.code, { dispatcher: null }))).toMatch(/^forbidden: /);
    expect(board.getCard(a.code).dispatcher).toEqual({ kind: "instance", name: "lead" });
    board.moveCard(DEV, a.code, "claimed");
    board.moveCard(DEV, a.code, "review", { result: "r" });
    expect(() => board.legacyComplete(DEV, a.uuid, "did it")).toThrow(/waits for lead's confirmation/);
    // The dispatcher hands it on; the person may too. With no review, the assignee may change it as before.
    expect(board.updateCard(LEAD, a.code, { dispatcher: { kind: "instance", name: "dev-b" } }).card.dispatcher).toEqual({ kind: "instance", name: "dev-b" });
    expect(board.updateCard(ANN, a.code, { dispatcher: { kind: "instance", name: "lead" } }).card.dispatcher).toEqual({ kind: "instance", name: "lead" });
    const plain = card(board, LEAD);
    expect(board.updateCard(DEV, plain.code, { dispatcher: null }).card.dispatcher).toBeNull();
  });

  it("the person may still confirm an agent's card", () => {
    const { board } = open();
    const a = card(board, LEAD, { needsReview: true });
    board.moveCard(DEV, a.code, "claimed");
    board.moveCard(DEV, a.code, "review", { result: "r" });
    expect(board.moveCard(ANN, a.code, "done").card.status).toBe("done");
  });

  it("its dispatcher may switch its review off; its assignee and others may not", () => {
    const { board } = open();
    const a = card(board, LEAD, { needsReview: true });
    expect(refusal(() => board.updateCard(DEV, a.code, { needsReview: false }))).toBe("forbidden: only lead can clear \"needs review\" on M-1");
    expect(board.updateCard(LEAD, a.code, { needsReview: false }).card.needsReview).toBe(false);
  });

  it("nobody handed it out (an agent's own card that asks for review): its assignee confirms it — done is done", () => {
    const { board } = open();
    const own = board.createCards(DEV, { cards: [{ title: "Self-check", needsReview: true }] }).cards[0]!;
    expect(own.dispatcher).toBeNull();
    board.moveCard(DEV, own.code, "claimed");
    expect(board.moveCard(DEV, own.code, "done", { result: "r" }).card.status).toBe("done");
    expect(board.createCards(DEV, { cards: [{ title: "x", needsReview: true }] }).cards[0]!.needsReview).toBe(true);
    expect(refusal(() => board.updateCard(OTHER, "M-2", { needsReview: false }))).toMatch(/^forbidden: /);
  });

  it("through the `task` tool: done by the assignee hands it to its dispatcher; the dispatcher's done and move finish it", async () => {
    const { db, call } = fleet();
    expect(await call("lead", { action: "create", title: "Review PR 42", assignee: "dev-a", needs_review: true })).toBe("ok M-1 Review PR 42 [to do] @dev-a (v1)");
    expect((await call("dev-a", { action: "get", id: "M-1" }) as string).split("\n")[1]).toBe("dispatched by lead · lead confirms it");
    await call("dev-a", { action: "move", id: "M-1", to: "claimed" });
    expect(await call("dev-a", { action: "move", id: "M-1", to: "done", result: "r" })).toBe("ok M-1 in progress → waiting for confirmation (v3)");
    expect(await call("lead", { action: "mine" })).toContain("for you to confirm:\n M-1 Review PR 42 @dev-a — move it to done, or back to claimed with what is missing");
    expect(await call("dev-a", { action: "mine" })).toContain("waiting for confirmation:\n M-1 Review PR 42 — by lead");
    expect(await call("lead", { action: "move", id: "M-1", to: "done" })).toBe("ok M-1 waiting for confirmation → done (v4)");
    expect(db.board.getCard("M-1").status).toBe("done");
  });
});

describe("2b. the tool's done on a card the caller confirms", () => {
  it("an agent's own card that asks for review: its assignee confirms it, so the tool's done is done", async () => {
    const { db, call } = fleet();
    await call("dev-a", { action: "create", title: "Self-check", needs_review: true });
    await call("dev-a", { action: "move", id: "M-1", to: "claimed" });
    expect(await call("dev-a", { action: "move", id: "M-1", to: "done", result: "r" })).toBe("ok M-1 in progress → done (v3)");
    expect(db.board.getCard("M-1").status).toBe("done");
  });
});

describe("3. cards stuck in review from before #2434", () => {
  /** A card as the board made it before #2434: an agent's main task, review on by default, now in review. */
  function stuck(board: TaskBoard, db: SchedulerDb) {
    const a = card(board, LEAD, { needsReview: true });
    board.moveCard(DEV, a.code, "claimed");
    board.moveCard(DEV, a.code, "review", { result: "approved, CI green" });
    (db as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db.prepare("UPDATE tasks SET on_board = 0 WHERE id = ?").run(a.uuid);
    return board.getCard(a.code);
  }

  it("its dispatcher finishes it as it is — move, the tool's done, or the plain update — and nothing else changes on it", async () => {
    const { db, board } = open();
    const a = stuck(board, db);
    expect([a.onBoard, a.needsReview, board.isOnBoard(a)]).toEqual([false, true, true]);
    expect(board.moveCard(LEAD, a.code, "done").card).toMatchObject({ status: "done", needsReview: true, dispatcher: { kind: "instance", name: "lead" } });
    const b = stuck(board, db);
    expect(board.legacyComplete(LEAD, b.uuid).status).toBe("done");
    const c = stuck(board, db);
    expect(board.legacyUpdate(LEAD, c.uuid, { status: "done" }).status).toBe("done");
    // Its assignee still cannot: it was handed to it to be checked.
    const d = stuck(board, db);
    expect(() => board.legacyComplete(DEV, d.uuid)).toThrow(/cannot complete \(must be open or claimed; it waits for lead's confirmation\)/);
    expect(() => board.legacyUpdate(DEV, d.uuid, { status: "done" })).toThrow(/waiting for lead's confirmation/);
  });

  it("through the `task` tool, as M-1834 needed: the dispatcher's done finishes it", async () => {
    const { db, call } = fleet();
    const a = stuck(db.board, db);
    const answer = await call("lead", { action: "done", id: a.uuid }) as { status?: string };
    expect(answer.status).toBe("done");
  });
});

describe("4. the person's own card: unchanged", () => {
  it("only the person finishes it, clears its review or hands it to someone else", () => {
    const { board } = open();
    const p = card(board, ANN);
    board.moveCard(DEV, p.code, "claimed");
    expect(refusal(() => board.moveCard(DEV, p.code, "done", { result: "r" }))).toBe("needs_review: M-1 needs the person's confirmation; move it to review");
    expect(refusal(() => board.updateCard(DEV, p.code, { needsReview: false }))).toBe("forbidden: only a person can clear \"needs review\"");
    // Re-dispatching it to an instance would take it out of the person's confirmation.
    expect(refusal(() => board.updateCard(DEV, p.code, { dispatcher: { kind: "instance", name: "dev-a" } }))).toBe("forbidden: M-1 was handed out by the person; only they hand it to someone else");
    expect(refusal(() => board.updateCard(DEV, p.code, { dispatcher: null }))).toMatch(/^forbidden: /);
    board.moveCard(DEV, p.code, "review", { result: "r" });
    expect(refusal(() => board.moveCard(DEV, p.code, "done"))).toBe("forbidden: M-1 is waiting for the person's confirmation: only they finish it");
    expect(refusal(() => board.moveCard(LEAD, p.code, "done"))).toBe("forbidden: M-1 is waiting for the person's confirmation: only they finish it");
    expect(board.waitingForPerson().map((w) => w.card.code)).toEqual([p.code]);
    expect(board.moveCard(ANN, p.code, "done").card.status).toBe("done");
  });
});

describe("5. notices", () => {
  it("the dispatcher hears once that its card waits for its confirmation; the assignee hears who confirmed it", () => {
    const { board } = open();
    const h = heard(board);
    const a = card(board, LEAD, { needsReview: true });
    board.moveCard(DEV, a.code, "claimed");
    h.take();
    board.moveCard(DEV, a.code, "review", { result: "r" });
    expect(h.take()).toEqual([{ to: "lead", code: a.code, reasons: ["to_confirm"], by: "dev-a" }]);
    board.updateCard(DEV, a.code, { state: "done: all\nnext: nothing" });
    expect(h.take()).toEqual([]);                                      // an edit in review is no new notice
    board.moveCard(LEAD, a.code, "done");
    expect(h.take()).toEqual([{ to: "dev-a", code: a.code, reasons: ["approved"], by: "lead" }]);
    // The person's card: nobody is asked to relay it (it is in their Needs you).
    const p = card(board, ANN);
    board.moveCard(DEV, p.code, "claimed");
    h.take();
    board.moveCard(DEV, p.code, "review", { result: "r" });
    expect(h.take()).toEqual([]);
  });

  it("a to_confirm wake no longer holds once the card is the person's or no longer in review", () => {
    const { board } = open();
    const a = card(board, LEAD, { needsReview: true });
    board.moveCard(DEV, a.code, "claimed");
    board.moveCard(DEV, a.code, "review", { result: "r" });
    const wake = { instance: "lead", uuid: a.uuid, code: a.code, title: a.title, parent: null, reasons: ["to_confirm" as const], by: { to_confirm: "dev-a" }, texts: {} };
    expect(board.wakeHolds(wake)?.reasons).toEqual(["to_confirm"]);
    board.updateCard(ANN, a.code, { dispatcher: { kind: "person" } });
    expect(board.wakeHolds(wake)).toBeNull();
  });
});

describe("6. opened on the board, no project, no review", () => {
  it("still the board's: its assignee is told, and it counts toward the cards-at-once limit", () => {
    const { board } = open();
    const h = heard(board);
    const a = card(board, LEAD);
    expect(board.isOnBoard(a)).toBe(true);
    expect(h.take()).toEqual([{ to: "dev-a", code: a.code, reasons: ["assigned"], by: "lead" }]);
    const b = card(board, LEAD);
    board.moveCard(DEV, a.code, "claimed");
    expect(refusal(() => board.moveCard(DEV, b.code, "claimed"))).toMatch(/^one_at_a_time: /);
  });
});
