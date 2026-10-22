/**
 * #2425: 2.3.0-beta.24 listed 28 blocked task-board cards in General's Needs you as "stuck, asking you" — weeks-old rows
 * the `task` tool kept before the board, agents' cards for themselves, a reviewer's "waiting on the author". A blocked
 * card asks the person only when the person handed it out; one an instance handed out is that instance's to decide; one
 * with no dispatcher is an instance's own wait. The same rule for Needs you and the daily summary; no card is changed.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Scheduler } from "../src/scheduler/index.js";
import { FleetManager } from "../src/fleet-manager.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fixture() {
  const d = mkdtempSync(join(tmpdir(), "needs-blocked-2425-")); dirs.push(d);
  writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
  const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
  const board = scheduler.db.board;
  const ann = { kind: "person" as const, name: "Ann" };
  const dev = { kind: "instance" as const, name: "dev-a" }, lead = { kind: "instance" as const, name: "lead" }, rev = { kind: "instance" as const, name: "reviewer" };
  // The `task` tool's rows from before the board: blocked, no dispatcher, weeks old (as on the reporting host).
  const legacy = board.createCards(dev, { cards: [{ title: "Old server migration" }, { title: "Waiting on art" }] }).cards;
  for (const c of legacy) { board.moveCard(dev, c.code, "claimed"); board.moveCard(dev, c.code, "blocked", { reason: "waiting on the designer" }); }
  const raw = (scheduler.db as any).db;
  raw.prepare("UPDATE tasks SET created_by = 'doupo-leader', updated_at = '2026-07-30T00:00:00.000Z' WHERE id = ?").run(legacy[0]!.uuid);
  // A reviewer's own card, blocked "waiting on the author".
  const review = board.createCards(rev, { cards: [{ title: "Review PR #1730" }] }).cards[0]!;
  board.moveCard(rev, review.code, "claimed"); board.moveCard(rev, review.code, "blocked", { reason: "waiting on the author" });
  // An agent-to-agent wait: lead handed it to dev-a, dev-a asks lead.
  const handed = board.createCards(lead, { cards: [{ title: "Split the API", assignee: "dev-a" }] }).cards[0]!;
  board.moveCard(dev, handed.code, "claimed"); board.moveCard(dev, handed.code, "blocked", { reason: "REST or RPC?" });
  // What does ask the person: a card Ann handed out, blocked on a question; and a card waiting for her confirmation.
  const asked = board.createCards(ann, { cards: [{ title: "Pick a season", assignee: "dev-a" }] }).cards[0]!;
  board.moveCard(dev, asked.code, "claimed"); board.moveCard(dev, asked.code, "blocked", { reason: "which season?" });
  const confirm = board.createCards(ann, { cards: [{ title: "Leaderboard", assignee: "dev-a" }] }).cards[0]!;
  board.moveCard(dev, confirm.code, "claimed"); board.moveCard(ann, confirm.code, "review");
  return { d, scheduler, board, raw, legacy, review, handed, asked, confirm };
}

describe("#2425 only what asks the person waits for the person", () => {
  it("waitingForPerson: the person's own question and confirmation; never a legacy row, an agent's own wait or an agent-to-agent one", () => {
    const f = fixture();
    try {
      const blocked = (f.raw.prepare("SELECT code FROM tasks WHERE status = 'blocked' ORDER BY code").all() as Array<{ code: string }>).map((r) => r.code);
      expect(blocked).toHaveLength(5);                                   // all five blocked cards are on the board…
      expect(f.board.waitingForPerson().map((w) => w.card.code).sort()).toEqual([f.asked.code, f.confirm.code].sort());   // …one asks Ann
    } finally { f.scheduler.db.close(); }
  });

  it("Needs you (needsYouTasks) lists the same two; the cards themselves are left as they are", () => {
    const f = fixture();
    try {
      const fm = new FleetManager(f.d) as unknown as Record<string, any>;
      fm.fleetConfig = { defaults: {}, instances: { "dev-a": {}, lead: {}, reviewer: {} } };
      fm.scheduler = f.scheduler;
      const before = f.raw.prepare("SELECT code, status, version, updated_at FROM tasks ORDER BY code").all();
      expect((fm.needsYouTasks() as Array<{ code: string; status: string }>).map((i) => [i.code, i.status]).sort())
        .toEqual([[f.asked.code, "blocked"], [f.confirm.code, "review"]].sort());
      expect(f.raw.prepare("SELECT code, status, version, updated_at FROM tasks ORDER BY code").all()).toEqual(before);
    } finally { f.scheduler.db.close(); }
  });

  it("the daily summary waits on the same two", () => {
    const f = fixture();
    try {
      const read = f.board.summaryRead("2026-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z");
      expect(read.waiting.map((c) => c.code).sort()).toEqual([f.asked.code, f.confirm.code].sort());
    } finally { f.scheduler.db.close(); }
  });
});
