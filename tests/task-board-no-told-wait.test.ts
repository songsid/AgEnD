/**
 * What an agent does to a card is told the way what a person does is — after the ~10 s gather — not after up
 * to two minutes, and not dropped because that agent also sent a message. "Told already" (#2785 (c), widened by #2801) is gone
 * for every kind of news it covered: assignment, start, send-back, answer, block, review, progress for followers, comments and
 * mentions. A message and the board's notice are two things (an agent that wants to tell someone something @mentions them).
 * Kept: the gather merges a card's changes; a notice still waiting is withdrawn when its card changed again (#2801); the loop
 * guard's counts; nobody is told of what they did themselves.
 *
 * Isolation: fake timers and clock; temp databases; a real FleetManager for the fleet's own wiring.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Scheduler } from "../src/scheduler/index.js";
import { FleetManager } from "../src/fleet-manager.js";
import { TaskBoardWaker } from "../src/task-board-waker.js";
import * as wakerModule from "../src/task-board-waker.js";
import type { Actor, Wake } from "../src/scheduler/task-board.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const LEAD: Actor = { kind: "instance", name: "lead" };
const DEV: Actor = { kind: "instance", name: "dev-a" };
const DEV_B: Actor = { kind: "instance", name: "dev-b" };

const wake = (over: Partial<Wake> & { who?: string }): Wake => {
  const reasons = over.reasons ?? ["assigned"];
  const { who, ...rest } = over;
  return { instance: "dev-a", uuid: "u1", code: "M-7", title: "Build the API", parent: null, reasons, texts: {}, ...rest,
    by: Object.fromEntries(reasons.map((r) => [r, who ?? "lead"])) };
};

/** A waker on a fake clock: the gather (10 s) is the only wait. */
function rig() {
  const sent: Array<{ instance: string; message: string; at: number }> = [];
  const clock = { now: 1_000_000 };
  const timers: Array<{ fn: () => void; at: number; live: boolean }> = [];
  const w = new TaskBoardWaker({
    deliver: (instance, message) => { sent.push({ instance, message, at: clock.now - 1_000_000 }); return true; },
    isInstance: (n) => ["dev-a", "dev-b", "lead"].includes(n),
    holds: (x) => x,
    card: () => undefined,
    log: () => {},
    now: () => clock.now,
    timers: { set: (fn, ms) => { const t = { fn, at: clock.now + ms, live: true }; timers.push(t); return t; }, clear: (h) => { (h as { live: boolean }).live = false; } },
  });
  /** Move the clock to `ms` after the start and run every timer due by then. */
  const at = (ms: number) => {
    clock.now = 1_000_000 + ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= clock.now).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.live = false;
      due.fn();
    }
  };
  return { w, sent, at };
}

describe("the waker: every notice goes out when the gather ends", () => {
  it("an assignment by an instance: sent at 10 s, once — nothing is held for the assigner's own message", () => {
    const { w, sent, at } = rig();
    w.note([wake({})]);
    at(9_999);
    expect(sent).toEqual([]);
    at(10_000);
    expect(sent.map((s) => [s.instance, s.at])).toEqual([["dev-a", 10_000]]);
    expect(sent[0]!.message).toContain("assigned to you by lead");
    at(10 * 60_000);
    expect(sent).toHaveLength(1);
  });

  it("each kind of news an instance makes goes at 10 s: start, send-back, answer, block, review, progress for a follower, comment, mention", () => {
    const cases: Array<[string, Partial<Wake>, string]> = [
      ["start", { reasons: ["start"] }, "lead asks you to start it"],
      ["sent_back", { reasons: ["sent_back"], texts: { sent_back: "add tests" } }, 'sent back by lead: "add tests"'],
      ["answered", { reasons: ["answered"], texts: { answered: "v2" } }, 'lead answered your blocked question: "v2"'],
      ["decide", { reasons: ["decide"], texts: { decide: "which API?" } }, "you handed it out and it is blocked"],
      ["to_confirm", { reasons: ["to_confirm"] }, "ready for your confirmation"],
      ["comment", { reasons: ["comment"], texts: { comment: "hello" } }, 'new comment from lead: "hello"'],
      ["mention", { reasons: ["mention"], texts: { mention: "@dev-a look" } }, "lead mentioned you in a comment"],
      ["progress", { reasons: ["progress"], news: { kind: "done", as: "dispatcher" } as Wake["news"] }, "finished by lead"],
    ];
    for (const [name, over, text] of cases) {
      const { w, sent, at } = rig();
      w.note([wake(over)]);
      at(10_000);
      expect(sent.map((s) => s.at), name).toEqual([10_000]);
      expect(sent[0]!.message, name).toContain(text);
    }
  });

  it("a card changed twice inside the gather is one notice (the merge is kept)", () => {
    const { w, sent, at } = rig();
    w.note([wake({ reasons: ["comment"], who: "Ann", texts: { comment: "first" } })]);
    at(3_000);
    w.note([wake({ reasons: ["comment"], who: "Ann", texts: { comment: "second" } })]);
    at(10_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toContain('"second" (+1 earlier comment');
  });

  it("the deps no longer take a 'told' lookup, and the module has no window to wait in", () => {
    expect(Object.keys(wakerModule).sort()).toEqual(["TaskBoardWaker", "cardsOfKey", "wakeMessage"]);
  });
});

describe("in a real FleetManager: an agent finishes a card, its dispatcher and watchers are told after ~10 s", () => {
  const dirs: string[] = [];
  afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  async function fleet() {
    vi.useFakeTimers();
    const d = mkdtempSync(join(tmpdir(), "agend-no-told-wait-")); dirs.push(d);
    writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
    const fm = new FleetManager(d) as unknown as Record<string, any>;
    fm.fleetConfig = { defaults: {}, instances: { "dev-a": {}, "dev-b": {}, lead: {}, docs: {} } };
    fm.ensureDeliveryOutbox();
    const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
    fm.attachTaskBoard(scheduler.db);
    const notices = () => {
      const db = new Database(join(d, "delivery-outbox.db"), { readonly: true });
      try {
        return (db.prepare("SELECT target_instance, payload_json FROM deliveries WHERE kind='system_notice' ORDER BY created_seq").all() as Array<{ target_instance: string; payload_json: string }>)
          .map((r) => ({ to: r.target_instance, text: JSON.parse(r.payload_json).content as string }));
      } finally { db.close(); }
    };
    const close = () => { fm.taskBoardWaker?.stop(); fm.deliveryOutbox?.close?.(); scheduler.db.close(); };
    return { fm, board: scheduler.db.board, notices, close };
  }

  it("lead (dispatcher) and docs (watcher) are told 10 s after dev-b finishes, although dev-b also messaged them; dev-b is not", async () => {
    const { fm, board, notices, close } = await fleet();
    const card = board.createCards(LEAD, { cards: [{ title: "Season rules", assignee: "dev-b", size: "S" }] }).cards[0]!;
    board.setWatchers(ANN, card.code, { add: ["docs"] });
    board.moveCard(DEV_B, card.code, "claimed");
    await vi.advanceTimersByTimeAsync(15_000);
    const before = notices().length;
    // dev-b's own messages about the card (what made the board hold its notice for two minutes before).
    for (const [to, n] of [["lead", 1], ["docs", 2]] as const) {
      fm.deliveryOutbox.admit({ operationId: `op-${n}`, sourceKey: `k-${n}`, sourceInstance: "dev-b", sourceDaemonBootId: "sb", targetInstance: to,
        kind: "fleet_inbound", payload: { type: "fleet_inbound", content: `${card.code} is done`, meta: {} } });
    }
    board.moveCard(DEV_B, card.code, "done", { result: "rules written" });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(notices().length).toBe(before);                                    // still gathering
    await vi.advanceTimersByTimeAsync(2_000);
    const fresh = notices().slice(before);
    expect(fresh.map((n) => n.to).sort()).toEqual(["docs", "lead"]);
    expect(fresh.find((n) => n.to === "lead")!.text).toContain("finished by dev-b");
    expect(fresh.find((n) => n.to === "docs")!.text).toContain("you watch it");
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(notices().length).toBe(before + 2);                                // once each, and not the maker
    close();
  });

  it("an assignment by an instance that also delegated it is told 10 s later, not two minutes", async () => {
    const { fm, board, notices, close } = await fleet();
    const card = board.createCards(LEAD, { cards: [{ title: "Leaderboard", assignee: "dev-a", size: "S" }] }).cards[0]!;
    fm.deliveryOutbox.admit({ operationId: "op-1", sourceKey: "k-1", sourceInstance: "lead", sourceDaemonBootId: "sb", targetInstance: "dev-a",
      kind: "fleet_inbound", payload: { type: "fleet_inbound", content: `Board card ${card.code} = gh issue #1: build it`, meta: {} } });
    await vi.advanceTimersByTimeAsync(10_500);
    const out = notices();
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toContain(`${card.code} "Leaderboard": assigned to you by lead`);
    close();
  });

  it("kept: a card that changes again while its notice waits has the waiting notice withdrawn (#2801)", async () => {
    const { fm, board, close } = await fleet();
    const card = board.createCards(LEAD, { cards: [{ title: "Leaderboard", assignee: "dev-a", size: "S" }] }).cards[0]!;
    board.moveCard(DEV, card.code, "claimed");
    await vi.advanceTimersByTimeAsync(15_000);
    board.moveCard(DEV, card.code, "blocked", { reason: "which API?" });
    await vi.advanceTimersByTimeAsync(11_000);
    const states = () => (fm.deliveryOutbox.db.prepare("SELECT target_instance AS t, state FROM deliveries WHERE kind='system_notice' AND target_instance='lead'").all() as Array<{ t: string; state: string }>);
    expect(states()).toEqual([{ t: "lead", state: "queued" }]);
    board.moveCard(ANN, card.code, "claimed", { comment: "v2" });
    expect(states()).toEqual([{ t: "lead", state: "cancelled" }]);
    close();
  });
});
