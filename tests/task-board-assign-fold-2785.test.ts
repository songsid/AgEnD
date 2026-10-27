/**
 * #2785 (c): one dispatch arrived twice — the board's "[Task board] M-n … assigned to you by X" and X's own
 * delegate_task about M-n. On the host, 29 of 31 such notices (10-20 … 10-28) came with the assigner's message naming
 * the card, −12 s … +24 s apart. The board now drops its "assigned" line when the assigner is an instance that messaged
 * the assignee about the card (or, for a sub task, its main task), waiting up to ASSIGN_HOLD_MS for that message;
 * everything else — other news on the card, a person's assignments, an assigner who never writes — is told as before.
 *
 * Isolation: fake timers and clock through the waker's deps; a temp outbox database.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { Scheduler } from "../src/scheduler/index.js";
import { FleetManager } from "../src/fleet-manager.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ASSIGN_HOLD_MS, TaskBoardWaker, namesCard } from "../src/task-board-waker.js";
import type { Wake } from "../src/scheduler/task-board.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";

const wake = (over: Partial<Wake> & { who?: string }): Wake => {
  const reasons = over.reasons ?? ["assigned"];
  const { who, ...rest } = over;
  return { instance: "dev-a", uuid: "u1", code: "M-7", title: "Build the API", parent: null, reasons, texts: {}, ...rest,
    by: Object.fromEntries(reasons.map((r) => [r, who ?? "lead"])) };
};

function rig(messaged: (from: string, to: string, codes: string[], since: number) => boolean) {
  const sent: Array<{ instance: string; message: string }> = [];
  const asked: Array<{ from: string; to: string; codes: string[]; since: number }> = [];
  const clock = { now: 1_000_000 };
  const timers: Array<{ fn: () => void; at: number; live: boolean }> = [];
  const w = new TaskBoardWaker({
    deliver: (instance, message) => { sent.push({ instance, message }); return true; },
    isInstance: (n) => ["dev-a", "dev-b", "lead"].includes(n),
    holds: (x) => x,
    card: () => undefined,
    messagedAbout: (from, to, codes, since) => { asked.push({ from, to, codes, since }); return messaged(from, to, codes, since); },
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
  return { w, sent, asked, at };
}

describe("#2785 (c): an instance's assignment is told once — by its own message", () => {
  it("the assigner already messaged about the card: no board line at all", () => {
    const { w, sent, asked, at } = rig(() => true);
    w.note([wake({})]);
    at(10_000);
    expect(sent).toEqual([]);
    // looked for the assigner's message from shortly before the assignment, about this card
    expect(asked).toEqual([{ from: "lead", to: "dev-a", codes: ["M-7"], since: 1_000_000 - ASSIGN_HOLD_MS }]);
    at(60_000);
    expect(sent).toEqual([]);
  });

  it("other news on the same card still goes — only the assigned line is dropped", () => {
    const { w, sent, at } = rig(() => true);
    w.note([wake({ reasons: ["assigned", "comment"], texts: { comment: "start with the schema" } })]);
    at(10_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toContain("new comment from lead");
    expect(sent[0]!.message).not.toContain("assigned to you");
  });

  it("the message comes during the hold: still no line; it never comes: the board tells it when the hold ends", () => {
    let written = false;
    const late = rig(() => written);
    late.w.note([wake({})]);
    late.at(10_000);
    expect(late.sent).toEqual([]);                    // waiting for the assigner
    written = true;
    late.at(ASSIGN_HOLD_MS);
    expect(late.sent).toEqual([]);                    // it came: nothing to repeat

    const never = rig(() => false);
    never.w.note([wake({})]);
    never.at(10_000);
    expect(never.sent).toEqual([]);
    never.at(ASSIGN_HOLD_MS - 1);
    expect(never.sent).toEqual([]);
    never.at(ASSIGN_HOLD_MS);
    expect(never.sent).toHaveLength(1);              // told, at most ASSIGN_HOLD_MS late
    expect(never.sent[0]!.message).toContain("M-7");
    expect(never.sent[0]!.message).toContain("assigned to you by lead");
  });

  it("a person's assignment (not an instance) is told as before, without looking", () => {
    const { w, sent, asked, at } = rig(() => true);
    w.note([wake({ who: "Ann" })]);
    at(10_000);
    expect(asked).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toContain("assigned to you by Ann");
  });

  it("a sub task counts as told when the message names its main task", () => {
    const { w, sent, asked, at } = rig((_f, _t, codes) => codes.includes("M-2006"));
    w.note([wake({ uuid: "s7", code: "S-7", parent: "M-2006" })]);
    at(10_000);
    expect(asked[0]!.codes).toEqual(["S-7", "M-2006"]);
    expect(sent).toEqual([]);
  });

  it("other cards in the same batch are not held back by one waiting assignment", () => {
    const { w, sent, at } = rig(() => false);
    w.note([wake({}), wake({ uuid: "u2", code: "M-8", reasons: ["comment"], texts: { comment: "see the log" } })]);
    at(10_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toContain("M-8");
    expect(sent[0]!.message).not.toContain("M-7");
    at(ASSIGN_HOLD_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.message).toContain("M-7");
  });

  it("a lookup that fails tells the assignment (fails open)", () => {
    const { w, sent, at } = rig(() => { throw new Error("database is closed"); });
    w.note([wake({})]);
    at(10_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toContain("assigned to you by lead");
  });
});

describe("namesCard", () => {
  it.each([
    ["Board card M-2086 = gh issue #2661", "M-2086", true],
    ["Board card S-7 (parent M-2006), issue #2650", "M-2006", true],
    ["Board card S-7 (parent M-2006)", "S-7", true],
    ["#2683 / M-2027: Prism has now asked", "M-2027", true],
    ["Board card M-2086", "M-208", false],
    ["Board card M-2086", "M-20861", false],
    ["XM-2086 is not it", "M-2086", false],
    ["no card here", "M-1", false],
  ])("%s / %s → %s", (text, code, want) => expect(namesCard(text, code)).toBe(want));
});

describe("DeliveryOutbox.recentTextsFrom", () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

  it("the source's texts to the target since a time — not other senders, not other kinds, not older ones", () => {
    const root = mkdtempSync(join(tmpdir(), "agend-2785c-")); roots.push(root);
    const outbox = new DeliveryOutbox(join(root, "outbox.db"), "boot");
    let n = 0;
    const admit = (source: string, target: string, kind: string, content: string) => outbox.admit({
      operationId: `op-${++n}`, sourceKey: `k-${n}`, sourceInstance: source, sourceDaemonBootId: "sb",
      targetInstance: target, kind: kind as never, payload: { type: kind, content, meta: {} },
    });
    admit("lead", "dev-a", "fleet_inbound", "old: Board card M-1");
    const since = new Date(Date.now() + 5).toISOString();
    const until = Date.now() + 10;
    while (Date.now() < until) { /* the next rows are admitted after `since` */ }
    admit("lead", "dev-a", "fleet_inbound", "Board card M-7 = gh issue #1");
    admit("lead", "dev-a", "steer", "and M-7 first");
    admit("other", "dev-a", "fleet_inbound", "M-7 from someone else");
    admit("lead", "dev-b", "fleet_inbound", "M-7 to someone else");
    admit("lead", "dev-a", "raw_paste", "M-7 as a raw paste");
    expect(outbox.recentTextsFrom("dev-a", "lead", since)).toEqual(["and M-7 first", "Board card M-7 = gh issue #1"]);
    outbox.close?.();
  });
});

describe("in a real FleetManager: the outbox is where the assigner's message is found", () => {
  const dirs: string[] = [];
  afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  async function assign(withDelegate: boolean) {
    vi.useFakeTimers();
    const d = mkdtempSync(join(tmpdir(), "agend-2785c-fm-")); dirs.push(d);
    writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
    const fm = new FleetManager(d) as unknown as Record<string, any>;
    fm.fleetConfig = { defaults: {}, instances: { "dev-a": {}, lead: {} } };
    fm.ensureDeliveryOutbox();
    const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
    fm.attachTaskBoard(scheduler.db);
    const card = scheduler.db.board.createCards({ kind: "instance", name: "lead" }, { cards: [{ title: "Leaderboard", assignee: "dev-a" }] }).cards[0]!;
    if (withDelegate) {
      fm.deliveryOutbox.admit({ operationId: "op-1", sourceKey: "k-1", sourceInstance: "lead", sourceDaemonBootId: "sb", targetInstance: "dev-a",
        kind: "fleet_inbound", payload: { type: "fleet_inbound", content: `Board card ${card.code} = gh issue #1: build it`, meta: {} } });
    }
    const notices = () => {
      const db = new Database(join(d, "delivery-outbox.db"), { readonly: true });
      try {
        return (db.prepare("SELECT payload_json FROM deliveries WHERE kind='system_notice'").all() as Array<{ payload_json: string }>)
          .map((r) => JSON.parse(r.payload_json).content as string);
      } finally { db.close(); }
    };
    await vi.advanceTimersByTimeAsync(ASSIGN_HOLD_MS + 1_000);
    const out = notices();
    fm.taskBoardWaker.stop();
    fm.deliveryOutbox?.close?.();
    scheduler.db.close();
    return { out, code: card.code };
  }

  it("assigned by an instance that delegated it: no board notice", async () => {
    expect((await assign(true)).out).toEqual([]);
  });

  it("assigned by an instance that wrote nothing: the board tells it", async () => {
    const { out, code } = await assign(false);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(`${code} "Leaderboard": assigned to you by lead`);
  });
});
