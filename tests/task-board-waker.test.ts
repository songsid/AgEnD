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
  const reasons = over.reasons ?? ["ready"];
  return { instance: "dev-a", uuid: "u1", code: "S-1", title: "Build the API", parent: "M-1", reasons, texts: {}, ...over, by: Object.fromEntries(reasons.map((r) => [r, (over as { who?: string }).who ?? "Ann"])) };
};

/** The delivery outbox as the waker sees it: each notice by its key and state, withdrawn only while it still waits (queued or retry_wait). */
function fakeOutbox() {
  const rows: Array<{ key: string; state: string; createdAt: string }> = [];
  return {
    rows,
    withdraw: (prefix: string, stale: (key: string, createdAt: string) => boolean) => {
      let n = 0;
      for (const r of rows) if ((r.state === "queued" || r.state === "retry_wait") && r.key.startsWith(prefix) && stale(r.key, r.createdAt)) { r.state = "cancelled"; n++; }
      return n;
    },
    noticeState: (key: string) => rows.find((r) => r.key === key)?.state ?? null,
  };
}

function waker(opts: { instances?: string[]; holds?: (w: Wake) => Wake | null; buttonsHere?: (instance: string, uuid: string) => boolean; outbox?: ReturnType<typeof fakeOutbox>; settled?: Array<Record<string, unknown>>; clock?: { at: number } } = {}) {
  const sent: Array<{ instance: string; message: string; key: string }> = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const w = new TaskBoardWaker({
    deliver: (instance, message, key) => { sent.push({ instance, message, key }); opts.outbox?.rows.push({ key, state: "queued", createdAt: new Date().toISOString() }); return true; },
    ...(opts.outbox ? { withdraw: opts.outbox.withdraw, noticeState: opts.outbox.noticeState } : {}),
    ...(opts.settled ? { settled: (e) => { opts.settled!.push(e as unknown as Record<string, unknown>); } } : {}),
    isInstance: (n) => (opts.instances ?? ["dev-a", "dev-b", "lead"]).includes(n),
    holds: opts.holds ?? ((x) => x),
    card: () => undefined,
    ...(opts.buttonsHere ? { buttonsHere: opts.buttonsHere } : {}),
    log: () => {},
    ...(opts.clock ? { now: () => opts.clock!.at } : {}),
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
    w.note([wake({ reasons: ["cancelled"], texts: { cancelled: "a duplicate" }, who: "Bob" } as Partial<Wake>), wake({ instance: "dev-b", uuid: "u2", code: "S-2", reasons: ["ready"] })]);
    expect(timers.map((t) => t.ms)).toEqual([10_000, 10_000]);       // one window per instance
    expect(sent).toEqual([]);
    fire();
    expect(sent.map(({ instance, message }) => ({ instance, message }))).toEqual([
      { instance: "dev-a", message: '[Task board] S-1 "Build the API": cancelled by Bob: "a duplicate" — stop working on it; sent back by Ann: "ties share a rank". Read it with: task get S-1' },
      { instance: "dev-b", message: '[Task board] S-2 "Build the API": everything it waited for is done — you can start it: claim it first (task claim S-2), then start. Read it with: task get S-2' },
    ]);
  });

  it("checks again as it goes out: what was finished, reassigned or answered meanwhile is left out", () => {
    const gone = new Set(["u2"]);
    const { w, sent, fire } = waker({ holds: (x) => (gone.has(x.uuid) ? null : x) });
    w.note([wake({}), wake({ uuid: "u2", code: "S-2" })]);
    fire();
    expect(sent.map((s) => s.message)).toEqual(['[Task board] S-1 "Build the API": everything it waited for is done — you can start it: claim it first (task claim S-1), then start. Read it with: task get S-1']);
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
      .toBe('[Task board] M-11 "Feature 11" (with 2 sub tasks): assigned to you by lead — claim it first (task claim M-11), then start. Read it with: task get M-11');
    expect(wakeMessage([main(11), main(12), main(13), main(14), sub(1, 11), sub(9, 20), wake({ uuid: "x", code: "S-30", reasons: ["sent_back"], texts: { sent_back: "redo" } })]))
      .toBe([
        "[Task board] You were assigned 4 main tasks (M-11–M-14) and 2 sub tasks.",
        '- S-30 "Build the API": sent back by Ann: "redo".',
        "Read task mine for the order and work through them one at a time, by priority; claim a card (task claim ID) before you start on it.",
      ].join("\n"));
    expect(wakeMessage([wake({}), wake({ uuid: "u2", code: "S-2", reasons: ["cancelled"] })]))
      .toBe('[Task board] 2 things on your cards:\n- S-1 "Build the API": everything it waited for is done — you can start it: claim it first (task claim S-1), then start.\n- S-2 "Build the API": cancelled by Ann — stop working on it.\nYour work: task mine');
  });

  it("#2434: the dispatcher is told a card it handed out is ready for its own confirmation, and what it lacks", () => {
    expect(wakeMessage([wake({ instance: "lead", reasons: ["to_confirm"], who: "dev-a" } as Partial<Wake>)], () => ({ assignee: "dev-a", kind: "sub", acceptance: [{ text: "a", done: false }], result: "" }) as never))
      .toBe('[Task board] S-1 "Build the API": you handed it out and it is ready for your confirmation (@dev-a), though 1 acceptance item unchecked, no result — check it, then move it to done, or back to claimed with what is missing. Read it with: task get S-1');
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

  it("a card assigned to dev-a, 10 s later, is one durable notice for dev-a — not from a person; a comment in the same window is part of it", async () => {
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
    expect(payload.content).toBe('[Task board] M-1 "Leaderboard": assigned to you by lead — claim it first (task claim M-1), then start; new comment from Ann: "weekly, not daily" — reply on the card (task update, with a comment) only if it asks or needs something from you (a person reads the card; no @ needed). Read it with: task get M-1');
    expect(payload.meta).toMatchObject({ user: "AgEnD", user_id: "agend-system", source: "agend-system" });
    fm.taskBoardWaker.stop();
    fm.deliveryOutbox?.close?.();
    scheduler.db.close();
  });

  it("a comment edited or deleted while its notice still waits in the outbox (the instance cannot take it yet): the notice is withdrawn and, for an edit, replaced with the new words", async () => {
    vi.useFakeTimers();
    const d = mkdtempSync(join(tmpdir(), "task-board-waker-")); dirs.push(d);
    writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
    const fm = new FleetManager(d) as unknown as Record<string, any>;
    fm.fleetConfig = { defaults: {}, instances: { "dev-a": {} } };
    const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
    fm.attachTaskBoard(scheduler.db);
    const board = scheduler.db.board;
    const ann = { kind: "person" as const, name: "Ann" }, dev = { kind: "instance" as const, name: "dev-a" };
    const card = board.createCards(ann, { cards: [{ title: "Leaderboard", assignee: "dev-a" }] }).cards[0]!;
    board.moveCard(dev, card.code, "claimed");
    await vi.advanceTimersByTimeAsync(10_000);                                    // the assignment's notice is out (and queued: nothing delivers it here)
    const rows = () => {
      const db = new Database(join(d, "delivery-outbox.db"), { readonly: true });
      try { return db.prepare("SELECT state, source_key, payload_json FROM deliveries ORDER BY created_seq").all() as Array<{ state: string; source_key: string; payload_json: string }>; } finally { db.close(); }
    };
    const words = (r: { payload_json: string }) => JSON.parse(r.payload_json).content as string;
    const before = rows().length;
    board.updateCard(ann, card.code, { comment: "use the old endpoint" });
    const said = board.detail(card.code).comments.at(-1)!;
    await vi.advanceTimersByTimeAsync(10_000);
    const sent = rows().slice(before);
    expect(sent.map((r) => r.state)).toEqual(["queued"]);
    expect(sent[0]!.source_key).toContain(`:comments=${said.id}:cards=`);
    expect(words(sent[0]!)).toContain("use the old endpoint");
    board.editComment(ann, card.code, said.id, "use the new endpoint");
    await vi.advanceTimersByTimeAsync(10_000);
    const afterEdit = rows().slice(before);
    expect(afterEdit.map((r) => r.state), "the first notice withdrawn, a second one queued").toEqual(["cancelled", "queued"]);
    expect(words(afterEdit[1]!)).toContain("use the new endpoint");
    expect(words(afterEdit[1]!)).not.toContain("old endpoint");
    expect(board.entryWakes(card.code).get(said.id)![0]!.key, "the comment's status follows the replacement notice").toBe(afterEdit[1]!.source_key);
    board.deleteComment(ann, card.code, said.id);
    await vi.advanceTimersByTimeAsync(10_000);
    const afterDelete = rows().slice(before);
    expect(afterDelete.map((r) => r.state), "the second one withdrawn and nothing left to tell").toEqual(["cancelled", "cancelled"]);
    fm.taskBoardWaker.stop();
    fm.deliveryOutbox?.close?.();
    scheduler.db.close();
  });

  it("the instance has been unable to take its notice for more than an hour: an edit still withdraws it, and the replacement still carries the assignment", async () => {
    vi.useFakeTimers();
    const d = mkdtempSync(join(tmpdir(), "task-board-waker-")); dirs.push(d);
    writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
    const fm = new FleetManager(d) as unknown as Record<string, any>;
    fm.fleetConfig = { defaults: {}, instances: { "dev-a": {} } };
    const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
    fm.attachTaskBoard(scheduler.db);
    const board = scheduler.db.board;
    const ann = { kind: "person" as const, name: "Ann" };
    const card = board.createCards({ kind: "instance", name: "lead" }, { cards: [{ title: "Leaderboard", assignee: "dev-a" }] }).cards[0]!;
    board.updateCard(ann, card.code, { comment: "use the old endpoint" });
    const first = board.detail(card.code).comments.at(-1)!;
    await vi.advanceTimersByTimeAsync(10_000);                                    // one notice: the assignment and the comment
    const rows = () => {
      const db = new Database(join(d, "delivery-outbox.db"), { readonly: true });
      try { return db.prepare("SELECT state, source_key, payload_json FROM deliveries ORDER BY created_seq").all() as Array<{ state: string; source_key: string; payload_json: string }>; } finally { db.close(); }
    };
    const words = (r: { payload_json: string }) => JSON.parse(r.payload_json).content as string;
    expect(rows().map((r) => r.state)).toEqual(["queued"]);
    expect(words(rows()[0]!)).toContain("assigned to you");
    await vi.advanceTimersByTimeAsync(61 * 60_000);                               // dev-a is offline for more than an hour
    board.updateCard(ann, card.code, { comment: "and mind the cache" });          // another notice that quotes a comment is handed over
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rows().map((r) => r.state)).toEqual(["queued", "queued"]);
    board.editComment(ann, card.code, first.id, "use the new endpoint");
    await vi.advanceTimersByTimeAsync(10_000);
    const after = rows();
    expect(after.map((r) => r.state), "the first notice is withdrawn; the other, about another comment, is not; a replacement is queued").toEqual(["cancelled", "queued", "queued"]);
    expect(words(after[2]!)).toContain("assigned to you");
    expect(words(after[2]!)).toContain("use the new endpoint");
    expect(words(after[2]!)).not.toContain("old endpoint");
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

describe("a notice that quotes a comment which is then edited or deleted", () => {
  /** The comments as they stand: the words now, or null for a deleted one. */
  const comments = new Map<number, string | null>();
  const holdsNow = (x: Wake): Wake | null => {
    const texts = { ...x.texts }; const reasons = [...x.reasons];
    for (const [r, id] of Object.entries(x.entries ?? {})) {
      const now = comments.get(id as number);
      if (now === null || now === undefined) { delete texts[r as keyof typeof texts]; reasons.splice(reasons.indexOf(r as never), 1); } else texts[r as keyof typeof texts] = now;
    }
    return reasons.length ? { ...x, reasons, texts } : null;
  };
  const said = (words: string, id = 12) => wake({ reasons: ["comment"], texts: { comment: words }, entries: { comment: id } });

  it("its key names the comments it quotes, before the cards", () => {
    const outbox = fakeOutbox();
    const { w, sent, fire } = waker({ outbox });
    comments.set(12, "ship it");
    w.note([said("ship it")]);
    fire();
    expect(sent[0]!.key).toMatch(/^task-board:dev-a:\d+:\d+:comments=12:cards=u1$/);
    w.note([wake({})]);                                               // no comment in it: no comments segment
    fire();
    expect(sent[1]!.key).toMatch(/^task-board:dev-a:\d+:\d+:cards=u1$/);
  });

  it("while it is still gathering: the notice says the comment's words as they are when it goes out, and leaves a deleted one out", () => {
    const outbox = fakeOutbox();
    const { w, sent, fire } = waker({ outbox, holds: holdsNow });
    comments.set(12, "the old words");
    w.note([said("the old words")]);
    comments.set(12, "the corrected words");                          // edited meanwhile
    w.recalled([{ uuid: "u1", entry: 12, deleted: false }]);
    fire();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toContain("the corrected words");
    expect(sent[0]!.message).not.toContain("the old words");
    comments.set(13, "a secret");
    w.note([said("a secret", 13)]);
    comments.set(13, null);                                           // deleted meanwhile
    w.recalled([{ uuid: "u1", entry: 13, deleted: true }]);
    fire();
    expect(sent, "nothing is left to tell").toHaveLength(1);
  });

  it("queued (the instance is offline or paused): an edit withdraws the notice and the instance gets one with the new words; a delete withdraws it and tells what else stands", () => {
    const outbox = fakeOutbox();
    const { w, sent, fire } = waker({ outbox, holds: holdsNow });
    comments.set(12, "the old words");
    w.note([{ ...said("the old words"), reasons: ["assigned", "comment"], texts: { comment: "the old words" }, by: { assigned: "Ann", comment: "Ann" } }]);
    fire();
    expect(sent).toHaveLength(1);
    expect(outbox.rows.map((r) => r.state)).toEqual(["queued"]);
    comments.set(12, "the new words");
    w.recalled([{ uuid: "u1", entry: 12, deleted: false }]);
    expect(outbox.rows.map((r) => r.state), "the first notice is withdrawn").toEqual(["cancelled"]);
    fire();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.message).toContain("the new words");
    expect(sent[1]!.message).toContain("assigned to you");              // what else it carried is told again
    expect(sent[1]!.message).not.toContain("the old words");
    comments.set(12, null);
    w.recalled([{ uuid: "u1", entry: 12, deleted: true }]);
    expect(outbox.rows.map((r) => r.state)).toEqual(["cancelled", "cancelled"]);
    fire();
    expect(sent, "the delete's replacement keeps the assignment and not the words").toHaveLength(3);
    expect(sent[2]!.message).toContain("assigned to you");
    expect(sent[2]!.message).not.toContain("new words");
  });

  it("what became of the comments the withdrawn notice carried follows the replacement: the board is told the new key and the old one it replaces", () => {
    const outbox = fakeOutbox();
    const settled: Array<Record<string, unknown>> = [];
    const { w, sent, fire } = waker({ outbox, holds: holdsNow, settled });
    comments.set(12, "the old words");
    w.note([said("the old words")]); fire();
    expect(settled).toEqual([{ uuid: "u1", instance: "dev-a", kind: "words", key: sent[0]!.key }]);   // handed over: no `replaces` for a first notice
    comments.set(12, "the new words");
    w.recalled([{ uuid: "u1", entry: 12, deleted: false }]); fire();
    expect(settled[1]).toEqual({ uuid: "u1", instance: "dev-a", kind: "words", key: sent[1]!.key, replaces: [sent[0]!.key] });
  });

  it("a hand-over the withdrawn notice carried follows the replacement too (the handoff's own settle carries the keys it replaces)", () => {
    const outbox = fakeOutbox();
    const settled: Array<Record<string, unknown>> = [];
    const { w, sent, fire } = waker({ outbox, holds: holdsNow, settled });
    comments.set(12, "ship it");
    w.note([{ ...said("ship it"), reasons: ["assigned", "comment"], texts: { comment: "ship it" }, by: { assigned: "Ann", comment: "Ann" } }]); fire();
    expect(settled.map((e) => e.kind).sort()).toEqual(["handoff", "words"]);
    settled.length = 0;
    comments.set(12, "ship it, today");
    w.recalled([{ uuid: "u1", entry: 12, deleted: false }]); fire();
    expect(settled.map((e) => [e.kind, e.key === sent[1]!.key, e.replaces]).sort()).toEqual([["handoff", true, [sent[0]!.key]], ["words", true, [sent[0]!.key]]]);
  });

  it("after a wait of more than an hour the board still hears of the replacement and the key it replaces", () => {
    const outbox = fakeOutbox();
    const settled: Array<Record<string, unknown>> = [];
    const clock = { at: Date.parse("2030-01-01T10:00:00Z") };
    const { w, sent, fire } = waker({ outbox, holds: holdsNow, settled, clock });
    comments.set(12, "the old words"); comments.set(15, "another");
    w.note([said("the old words")]); fire();
    clock.at += 61 * 60_000;
    w.note([said("another", 15)]); fire();                            // hands over another notice that quotes a comment
    comments.set(12, "the new words");
    w.recalled([{ uuid: "u1", entry: 12, deleted: false }]); fire();
    expect(sent).toHaveLength(3);
    expect(settled[2]).toEqual({ uuid: "u1", instance: "dev-a", key: sent[2]!.key, replaces: [sent[0]!.key] });
  });

  it("a notice about another comment is left alone; so is one already delivered; one whose wakes this waker no longer has is withdrawn and not replaced", () => {
    const outbox = fakeOutbox();
    const first = waker({ outbox, holds: holdsNow });
    comments.set(12, "one"); comments.set(15, "two");
    first.w.note([said("one", 12)]); first.fire();
    first.w.note([said("two", 15)]); first.fire();
    expect(outbox.rows).toHaveLength(2);
    outbox.rows[1]!.state = "delivered";                              // the second one has been taken by the instance
    comments.set(15, "two, edited");
    first.w.recalled([{ uuid: "u1", entry: 15, deleted: false }]);
    expect(outbox.rows.map((r) => r.state), "delivered cannot be called back").toEqual(["queued", "delivered"]);
    // After a restart: a new waker over the same outbox has no wakes to replace the notice with.
    const after = waker({ outbox, holds: holdsNow });
    comments.set(12, "one, edited");
    after.w.recalled([{ uuid: "u1", entry: 12, deleted: false }]);
    expect(outbox.rows.map((r) => r.state)).toEqual(["cancelled", "delivered"]);
    after.fire();
    expect(after.sent, "withdrawn, not replaced").toEqual([]);
  });

  it("a notice that has waited longer than an hour is still withdrawn and replaced, with what else it carried: the wakes are kept while it waits, not for a time", () => {
    const outbox = fakeOutbox();
    const clock = { at: Date.parse("2030-01-01T10:00:00Z") };
    const { w, sent, fire } = waker({ outbox, holds: holdsNow, clock });
    comments.set(12, "the old words"); comments.set(15, "another comment");
    w.note([{ ...said("the old words"), reasons: ["assigned", "comment"], texts: { comment: "the old words" }, by: { assigned: "Ann", comment: "Ann" } }]);
    fire();
    clock.at += 61 * 60_000;                                          // dev-a has been offline for 61 minutes
    w.note([said("another comment", 15)]); fire();                    // another notice that quotes a comment is handed over
    expect(outbox.rows.map((r) => r.state)).toEqual(["queued", "queued"]);
    comments.set(12, "the new words");
    w.recalled([{ uuid: "u1", entry: 12, deleted: false }]);
    expect(outbox.rows.map((r) => r.state), "only the notice that quotes comment 12 is withdrawn").toEqual(["cancelled", "queued"]);
    fire();
    expect(sent, "and it is replaced").toHaveLength(3);
    expect(sent[2]!.message).toContain("the new words");
    expect(sent[2]!.message).toContain("assigned to you");
    expect(sent[2]!.message).not.toContain("the old words");
    clock.at += 24 * 60 * 60_000;                                     // a day later, a delete: the assignment still stands
    comments.set(12, null);
    w.recalled([{ uuid: "u1", entry: 12, deleted: true }]);
    expect(outbox.rows.map((r) => r.state)).toEqual(["cancelled", "queued", "cancelled"]);
    fire();
    expect(sent).toHaveLength(4);
    expect(sent[3]!.message).toContain("assigned to you");
    expect(sent[3]!.message).not.toContain("new words");
  });

  it("more than 200 notices waiting: the oldest is replaced as well as the newest", () => {
    const outbox = fakeOutbox();
    const { w, sent, fire } = waker({ outbox, holds: holdsNow });
    for (let i = 0; i < 250; i++) {
      comments.set(1000 + i, `words ${i}`);
      w.note([{ ...said(`words ${i}`, 1000 + i), uuid: `u${i}`, code: `S-${i}`, reasons: ["assigned", "comment"], texts: { comment: `words ${i}` }, by: { assigned: "Ann", comment: "Ann" } }]);
      fire();
    }
    expect(outbox.rows.filter((r) => r.state === "queued")).toHaveLength(250);
    for (const i of [0, 249]) {
      comments.set(1000 + i, `edited ${i}`);
      w.recalled([{ uuid: `u${i}`, entry: 1000 + i, deleted: false }]);
    }
    fire();
    expect(outbox.rows.filter((r) => r.state === "cancelled")).toHaveLength(2);
    expect(sent).toHaveLength(251);                                   // both edits are one notice: the two cards' news gathered in one window
    expect(sent[250]!.message).toContain("edited 0");
    expect(sent[250]!.message).toContain("edited 249");
    expect(sent[250]!.message).toMatch(/assigned to you[\s\S]*assigned to you/);
  });

  it("a notice under way that goes back to waiting is still replaced; one whose delivery has settled lets go of its wakes", () => {
    const outbox = fakeOutbox();
    const { w, sent, fire } = waker({ outbox, holds: holdsNow });
    const kept = () => (w as unknown as { kept: Map<string, unknown> }).kept.size;
    comments.set(12, "one"); comments.set(15, "two"); comments.set(16, "three");
    w.note([said("one", 12)]); fire();
    outbox.rows[0]!.state = "delivering";                             // an attempt is under way: it may yet fall back to waiting
    w.note([said("two", 15)]); fire();
    expect(kept(), "neither has settled").toBe(2);
    outbox.rows[0]!.state = "retry_wait";                             // the attempt aborted
    comments.set(12, "one, edited");
    w.recalled([{ uuid: "u1", entry: 12, deleted: false }]);
    expect(outbox.rows[0]!.state).toBe("cancelled");
    fire();
    expect(sent[sent.length - 1]!.message).toContain("one, edited");
    outbox.rows[1]!.state = "delivered";                              // the second is taken; the replacement of the first fails
    outbox.rows[2]!.state = "failed";
    w.note([said("three", 16)]); fire();
    expect(kept(), "the notices that settled are let go; the ones waiting are kept").toBe(1);
  });

  it("without the delivery outbox's help nothing is withdrawn and nothing breaks", () => {
    const { w, sent, fire } = waker({ holds: holdsNow });
    comments.set(12, "x");
    w.note([said("x")]); fire();
    expect(() => w.recalled([{ uuid: "u1", entry: 12, deleted: false }])).not.toThrow();
    expect(sent).toHaveLength(1);
  });
});
