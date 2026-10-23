/**
 * The task board's wakes on the fleet's side (src/task-board-waker.ts, docs/design/task-board.md step 2): an instance's
 * news gathered into one message, merged per card with each reason's own words, checked again as it goes out, a plan
 * assigned at once told as a count; and in a real FleetManager, handed to the delivery outbox as AgEnD's notice.
 *
 * Isolation: fake timers; temp databases; a FleetManager with no fleet (nothing starts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { TaskBoardWaker, wakeMessage } from "../src/task-board-waker.js";
import type { Wake } from "../src/scheduler/task-board.js";
import { Scheduler } from "../src/scheduler/index.js";
import { FleetManager } from "../src/fleet-manager.js";

const wake = (over: Partial<Wake>): Wake => {
  const reasons = over.reasons ?? ["comment"];
  return { instance: "dev-a", uuid: "u1", code: "S-1", title: "Build the API", parent: "M-1", reasons, texts: {}, ...over, by: Object.fromEntries(reasons.map((r) => [r, (over as { who?: string }).who ?? "Ann"])) };
};

function waker(opts: { instances?: string[]; holds?: (w: Wake) => Wake | null; buttonsHere?: (instance: string, uuid: string) => boolean } = {}) {
  const sent: Array<{ instance: string; message: string }> = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const w = new TaskBoardWaker({
    deliver: (instance, message) => { sent.push({ instance, message }); return true; },
    isInstance: (n) => (opts.instances ?? ["dev-a", "dev-b", "lead"]).includes(n),
    holds: opts.holds ?? ((x) => x),
    card: () => undefined,
    ...(opts.buttonsHere ? { buttonsHere: opts.buttonsHere } : {}),
    log: () => {},
    timers: { set: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; }, clear: (h) => { (h as { live: boolean }).live = false; } },
  });
  const fire = () => { for (const t of timers.splice(0)) if (t.live) t.fn(); };
  return { w, sent, timers, fire };
}

describe("#2352: the waker asks, per card and instance, whether the buttons are in that instance's channel", () => {
  it("the dispatcher whose channel lists the card is told so; another instance, or another card, gets the old words", () => {
    const asked: string[] = [];
    const { w, sent, fire } = waker({ buttonsHere: (instance, uuid) => { asked.push(`${instance}/${uuid}`); return instance === "lead" && uuid === "u1"; } });
    w.note([wake({ instance: "lead", reasons: ["decide"], texts: { decide: "codes?" } }), wake({ instance: "lead", uuid: "u2", code: "S-2", reasons: ["decide"], texts: { decide: "names?" } })]);
    w.note([wake({ instance: "dev-b", reasons: ["decide"], texts: { decide: "codes?" } })]);
    fire();
    const to = (i: string) => sent.find((x) => x.instance === i)!.message;
    const line = (code: string) => to("lead").split("\n").find((l) => l.includes(`${code} "`))!;
    expect(line("S-1")).toContain("Answer for it in your channel");
    expect(line("S-2")).toContain("ask the person, then answer it");
    expect(to("dev-b")).toMatch(/ask the person, then answer it/);
    expect(asked.sort()).toEqual(["dev-b/u1", "lead/u1", "lead/u2"]);
  });
});

describe("gathering an instance's news", () => {
  it("one message per instance per window; a card's news merged, each reason keeping its own words", () => {
    const { w, sent, timers, fire } = waker();
    w.note([wake({ reasons: ["sent_back"], texts: { sent_back: "ties share a rank" } })]);
    w.note([wake({ reasons: ["comment"], texts: { comment: "and cache it" }, who: "Bob" } as Partial<Wake>), wake({ instance: "dev-b", uuid: "u2", code: "S-2", reasons: ["ready"] })]);
    expect(timers.map((t) => t.ms)).toEqual([10_000, 10_000]);       // one window per instance
    expect(sent).toEqual([]);
    fire();
    expect(sent).toEqual([
      { instance: "dev-a", message: '[Task board] S-1 "Build the API": sent back by Ann: "ties share a rank"; new comment from Bob: "and cache it". Read it with: task get S-1' },
      { instance: "dev-b", message: '[Task board] S-2 "Build the API": everything it waited for is done — you can start it. Read it with: task get S-2' },
    ]);
  });

  it("checks again as it goes out: what was finished, reassigned or answered meanwhile is left out", () => {
    const gone = new Set(["u2"]);
    const { w, sent, fire } = waker({ holds: (x) => (gone.has(x.uuid) ? null : x) });
    w.note([wake({}), wake({ uuid: "u2", code: "S-2" })]);
    fire();
    expect(sent.map((s) => s.message)).toEqual(['[Task board] S-1 "Build the API": new comment from Ann. Read it with: task get S-1']);
    w.note([wake({ uuid: "u2", code: "S-2" })]);
    fire();
    expect(sent).toHaveLength(1);                                      // nothing left: nothing sent
  });

  it("a name that is not one of the fleet's instances is not woken; after stop nothing is sent", () => {
    const { w, sent, fire } = waker({ instances: ["dev-a"] });
    w.note([wake({ instance: "a person typed this" })]);
    w.note([wake({})]);
    w.stop();
    fire();
    expect(sent).toEqual([]);
  });
});

describe("the message", () => {
  it("a main task assigned with its sub tasks is one line; a whole plan at once is a count", () => {
    const main = (n: number) => wake({ uuid: `m${n}`, code: `M-${n}`, title: `Feature ${n}`, parent: null, reasons: ["assigned"], who: "lead" } as Partial<Wake>);
    const sub = (n: number, of: number) => wake({ uuid: `s${n}`, code: `S-${n}`, title: `Step ${n}`, parent: `M-${of}`, reasons: ["assigned"], who: "lead" } as Partial<Wake>);
    expect(wakeMessage([main(11), sub(1, 11), sub(2, 11)]))
      .toBe('[Task board] M-11 "Feature 11" (with 2 sub tasks): assigned to you by lead. Read it with: task get M-11');
    expect(wakeMessage([main(11), main(12), main(13), main(14), sub(1, 11), sub(9, 20), wake({ uuid: "x", code: "S-30", reasons: ["sent_back"], texts: { sent_back: "redo" } })]))
      .toBe([
        "[Task board] You were assigned 4 main tasks (M-11–M-14) and 2 sub tasks.",
        '- S-30 "Build the API": sent back by Ann: "redo".',
        "Read task mine for the order and work through them one at a time, by priority.",
      ].join("\n"));
    expect(wakeMessage([wake({}), wake({ uuid: "u2", code: "S-2", reasons: ["approved"], instance: "lead" })]))
      .toBe('[Task board] 2 things on your cards:\n- S-1 "Build the API": new comment from Ann.\n- S-2 "Build the API": you handed it out; the person confirmed it.\nYour work: task mine');
  });

  it("#2434: the dispatcher is told a card it handed out is ready for its own confirmation, and what it lacks", () => {
    expect(wakeMessage([wake({ instance: "lead", reasons: ["to_confirm"], who: "dev-a" } as Partial<Wake>)], () => ({ assignee: "dev-a", kind: "sub", acceptance: [{ text: "a", done: false }], result: "" }) as never))
      .toBe('[Task board] S-1 "Build the API": you handed it out and it is ready for your confirmation (@dev-a), though 1 acceptance item unchecked, no result — check it, then move it to done, or back to claimed with what is missing. Read it with: task get S-1');
    // Confirmed by an instance: its name; by the person (their own card): "the person".
    const agent = () => ({ assignee: "dev-a", dispatcher: { kind: "instance", name: "lead" } }) as never;
    expect(wakeMessage([wake({ reasons: ["approved"], instance: "dev-a", who: "lead" } as Partial<Wake>)], agent)).toContain("lead confirmed it");
    const theirs = () => ({ assignee: "dev-a", dispatcher: { kind: "person", name: "Ann" } }) as never;
    expect(wakeMessage([wake({ reasons: ["approved"], instance: "dev-a" } as Partial<Wake>)], theirs)).toContain("the person confirmed it");
  });

  it("a card cancelled by someone else, alone or with its main task", () => {
    expect(wakeMessage([wake({ reasons: ["cancelled"], texts: { cancelled: "with its main task M-1: the feature is dropped" } })]))
      .toBe('[Task board] S-1 "Build the API": cancelled by Ann with its main task M-1: the feature is dropped — stop working on it. Read it with: task get S-1');
    expect(wakeMessage([wake({ reasons: ["cancelled"], texts: { cancelled: "duplicate of S-9" } })]))
      .toBe('[Task board] S-1 "Build the API": cancelled by Ann: "duplicate of S-9" — stop working on it. Read it with: task get S-1');
  });

  it("the dispatcher is asked to take the question to the person, and how to answer it", () => {
    expect(wakeMessage([wake({ instance: "lead", reasons: ["decide"], who: "dev-a", texts: { decide: "codes or messages?" } } as Partial<Wake>)], () => ({ assignee: "dev-a" }) as never))
      .toBe('[Task board] S-1 "Build the API": you handed it out and it is blocked (@dev-a): "codes or messages?" — ask the person, then answer it: move it back to claimed with the decision as the comment. Read it with: task get S-1');
  });

  it("#2352: when the person has the card's buttons in the dispatcher's own channel, the wake says so instead of asking it to relay", () => {
    const here = () => true;
    expect(wakeMessage([wake({ instance: "lead", reasons: ["decide"], who: "dev-a", texts: { decide: "codes or messages?" } } as Partial<Wake>)], () => ({ assignee: "dev-a" }) as never, here))
      .toBe('[Task board] S-1 "Build the API": you handed it out and it is blocked (@dev-a): "codes or messages?" — answer it yourself if you can (move it back to claimed with the decision as the comment); otherwise the person has Answer for it in your channel. Read it with: task get S-1');
    // #2434: a card to confirm is the dispatcher's own (an agent's card), whatever the lane: nothing to relay.
    expect(wakeMessage([wake({ instance: "lead", reasons: ["to_confirm"], who: "dev-a" } as Partial<Wake>)], () => ({ assignee: "dev-a", kind: "sub", acceptance: [], result: "done" }) as never, here))
      .toBe('[Task board] S-1 "Build the API": you handed it out and it is ready for your confirmation (@dev-a) — check it, then move it to done, or back to claimed with what is missing. Read it with: task get S-1');
    // Per wake: only the one whose card is laned here.
    const two = wakeMessage([wake({ instance: "lead", reasons: ["decide"] }), wake({ uuid: "u2", code: "S-2", instance: "lead", reasons: ["decide"] })],
      () => ({ assignee: "dev-a", kind: "sub", acceptance: [], result: "done" }) as never, (w) => w.code === "S-2");
    const at = (code: string) => two.split("\n").find((l) => l.includes(`${code} "`))!;
    expect(at("S-1")).toContain("ask the person, then answer it");
    expect(at("S-2")).toContain("the person has Answer for it in your channel");
  });
});

describe("in the fleet: a write's wakes reach the delivery outbox as AgEnD's notice", () => {
  const dirs: string[] = [];
  afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("a person's comment on dev-a's card, 10 s later, is one durable notice for dev-a — not from a person", async () => {
    vi.useFakeTimers();
    const d = mkdtempSync(join(tmpdir(), "task-board-waker-")); dirs.push(d);
    writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
    const fm = new FleetManager(d) as unknown as Record<string, any>;
    fm.fleetConfig = { defaults: {}, instances: { "dev-a": {} } };
    const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
    fm.attachTaskBoard(scheduler.db);
    const board = scheduler.db.board;
    const card = board.createCards({ kind: "instance", name: "lead" }, { cards: [{ title: "Leaderboard", assignee: "dev-a" }] }).cards[0]!;
    board.updateCard({ kind: "person", name: "Ann" }, card.code, { comment: "weekly, not daily" });
    const rows = () => {
      const db = new Database(join(d, "delivery-outbox.db"), { readonly: true });
      try { return db.prepare("SELECT target_instance, payload_json FROM deliveries").all() as Array<{ target_instance: string; payload_json: string }>; } finally { db.close(); }
    };
    await vi.advanceTimersByTimeAsync(9_000);
    expect(fm.deliveryOutbox ? rows() : []).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    const [row, ...more] = rows();
    expect(more).toEqual([]);
    expect(row!.target_instance).toBe("dev-a");
    const payload = JSON.parse(row!.payload_json);
    expect(payload.content).toBe('[Task board] M-1 "Leaderboard": assigned to you by lead; new comment from Ann: "weekly, not daily". Read it with: task get M-1');
    expect(payload.meta).toMatchObject({ user: "AgEnD", user_id: "agend-system", source: "agend-system" });
    fm.taskBoardWaker.stop();
    fm.deliveryOutbox?.close?.();
    scheduler.db.close();
  });

  it("the board's cards-at-once limit is each instance's board_cards_at_once, read at every claim (#2303)", () => {
    const d = mkdtempSync(join(tmpdir(), "task-board-waker-")); dirs.push(d);
    writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
    const fm = new FleetManager(d) as unknown as Record<string, any>;
    fm.fleetConfig = { defaults: {}, instances: { "dev-a": { board_cards_at_once: 2 } } };
    const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
    fm.attachTaskBoard(scheduler.db);
    const board = scheduler.db.board;
    const dev = { kind: "instance" as const, name: "dev-a" };
    const [a, b, c] = [1, 2, 3].map((n) => board.createCards({ kind: "instance", name: "lead" }, { cards: [{ title: `Card ${n}`, assignee: "dev-a" }] }).cards[0]!);
    board.moveCard(dev, a.code, "claimed");
    board.moveCard(dev, b.code, "claimed");
    expect(() => board.moveCard(dev, c.code, "claimed")).toThrow(/at most 2 cards at a time/);
    fm.fleetConfig = { defaults: {}, instances: { "dev-a": { board_cards_at_once: 3 } } };   // a fleet.yaml edit: the next claim
    expect(board.moveCard(dev, c.code, "claimed").card.status).toBe("claimed");
    fm.taskBoardWaker.stop();
    scheduler.db.close();
  });
});
