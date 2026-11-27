// M-3770 slice 2.2 (S-244): the quiescence barrier on the §2.6 journal helpers. No production caller.
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryOutbox, type NewOutboxDelivery } from "../src/delivery-outbox.js";
import { FleetManager } from "../src/fleet-manager.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { TaskBoard, TaskBoardError, type Actor } from "../src/scheduler/task-board.js";
import { DEFAULT_SCHEDULER_CONFIG } from "../src/scheduler/types.js";
import {
  ackGeneration, advance, attemptDir, consumeCancel, defaultJournalIo, listHandback, markHandback, newAttemptId, openAttempt, planGeneration, readCurrent, substep,
  type AttemptRecord, type HandbackEntry, type InboxItem, type JournalIo,
} from "../src/update-journal.js";
import { checkQuiet, type HostDeps } from "../src/update-readiness-host.js";
import {
  DEFAULT_MAX_IDLE_WAIT_MS, HONOURED_CANCEL_ACTIONS, TOO_LATE_CANCEL, QuiescenceBarrier, barrierIdle,
  cancelAllowed, cardAfterHonouredCancel, closeUnusedAttempt, handbackDue, isAgentTurn, serviceCommandRefusal,
  skipsAgentFence, stateWriteRefused, turnSource, usesQuiescenceBarrier, type BarrierSnapshot, type HandbackPorts,
} from "../src/update-quiescence.js";

const trash: string[] = [];
afterEach(() => { for (const path of trash.splice(0)) rmSync(path, { recursive: true, force: true }); });
const scratch = (prefix: string) => { const path = mkdtempSync(join(tmpdir(), prefix)); trash.push(path); return path; };

const ID = newAttemptId(new Date("2026-11-26T18:00:00Z"), "a244a244");
const init = (id = ID) => ({
  id, kind: "update" as const,
  updater: { pid: 244, start: { processStart: "Thu Nov 26 18:00:00 2026" } },
  from: { name: "@songsid/agend", version: "2.3.5-alpha", integrity: "sha512-old" },
  to: { name: "@songsid/agend", version: "2.3.6-alpha", integrity: "sha512-new" },
});
const open = (home: string, id = ID) => {
  const result = openAttempt(home, init(id));
  if (!result.ok) throw new Error(result.reason);
  return result.attempt;
};

function idle(over: Partial<BarrierSnapshot> = {}): BarrierSnapshot {
  return {
    pin: false, inPause: false, startupComplete: true, shuttingDown: false, reconcileInFlight: false,
    anotherClaim: false, scheduleInRun: false, outboxInFlight: false,
    agents: [{ process: "running", execution: "idle" }], pending: [], ...over,
  };
}
const refOf = (entry: HandbackEntry): Extract<InboxItem, { kind: "reference" }> | null =>
  entry.kind === "inbox" && entry.item.kind === "reference" ? entry.item : null;

function bodyOf(src: string, signature: string): string {
  const at = src.indexOf(signature);
  if (at < 0) throw new Error(`missing ${signature}`);
  return src.slice(at);
}
function holdBeforeSend(src: string): void {
  const send = src.indexOf("ipc.send");
  const hold = src.lastIndexOf("holdPaneSend", send);
  expect(hold).toBeGreaterThanOrEqual(0);
  expect(send).toBeGreaterThan(hold);
  expect(src.slice(hold, send)).not.toMatch(/\bawait\b/);
}

const quietDeps = (home: string): HostDeps => ({
  platform: "linux", env: {}, uid: 1, user: "u", pid: 1, homeDir: home,
  exists: async () => false, realpath: async path => path, readText: async () => null, listDir: async () => [],
  run: async () => ({ status: 0, stdout: "", stderr: "" }), listPids: async () => [],
  procArgv: async () => null, procEnv: async () => null, procUid: async () => null, freeBytes: async () => null,
  lockHolder: () => ({ state: "free" }), updateInProgress: () => false,
  journalState: () => readCurrent(home).state,
});

function outboxInput(operationId: string, target = "worker"): NewOutboxDelivery {
  return {
    operationId, sourceKey: `mcp:source:${operationId}:${target}`, sourceInstance: "source", sourceDaemonBootId: "boot",
    targetInstance: target, kind: "fleet_inbound", correlationId: operationId,
    payload: { type: "fleet_inbound", content: operationId, targetSession: target },
  };
}


/** The abandon driver's journal at the hand-back wait: abandoning, this fleet restarted as the old generation, restart-old. */
const OWN = { nonce: "e".repeat(32), pid: 7300 };
function toHandback(home: string, attempt: AttemptRecord): AttemptRecord {
  let a = attempt.stage === "abandoning" ? attempt : advance(home, attempt, "abandoning", { note: "test" });
  a = planGeneration(home, a, "old", OWN.nonce);
  a = ackGeneration(home, a, OWN.nonce, OWN.pid);
  return substep(home, a, "restart-old");
}

describe("S-244 class and the idle predicate", () => {
  it("runs only for a class Self transaction both versions speak", () => {
    expect(usesQuiescenceBarrier({ txClass: "Self", from: 3, to: 3, vTx: 3 })).toBe(true);
    expect(usesQuiescenceBarrier({ txClass: "Self", from: 2, to: 3, vTx: 3 })).toBe(false);
    expect(usesQuiescenceBarrier({ txClass: "Fleet", from: 3, to: 3, vTx: 3 })).toBe(false);
  });

  it("counts waiting as idle here, and hubUpdateIdle still treats waiting as busy", () => {
    expect(barrierIdle(idle({ agents: [{ process: "running", execution: "idle", phase: "waiting" }] }))).toBe(true);
    const hub = bodyOf(FleetManager.prototype["hubUpdateIdle"].toString(), "hubUpdateIdle");
    const at = hub.indexOf('phase === "waiting"');
    expect(at).toBeGreaterThan(0);
    expect(hub.slice(at, at + 60)).toContain("return false");
  });

  it("does not count a schedule already inside runWithLock as busy, and does not stop it", async () => {
    let release!: () => void;
    const running = new Promise<void>(resolve => { release = resolve; });
    const dir = scratch("s244-sched-");
    const scheduler = new Scheduler(join(dir, "scheduler.db"), () => running, DEFAULT_SCHEDULER_CONFIG, () => true);
    scheduler.init();
    try {
      const schedule = scheduler.create({ cron: "0 0 1 1 *", message: "later", source: "a", target: "a", reply_chat_id: "1", reply_thread_id: null });
      scheduler.trigger(schedule.id);
      expect(scheduler.scheduleInRun()).toBe(true);
      expect(barrierIdle(idle({ scheduleInRun: scheduler.scheduleInRun() }))).toBe(true);
      expect(scheduler.db.get(schedule.id)?.enabled).toBe(true);
      release();
      await running;
    } finally { scheduler.shutdown(); }
  });
});

describe("S-244 wait, second check, and the close", () => {
  it("does not set the flag during the wait, so a message is delivered", async () => {
    const home = scratch("s244-wait-");
    const barrier = new QuiescenceBarrier(home);
    let seen = false;
    const result = await barrier.waitForCandidate({
      maxMs: 60_000, pollMs: 5, idle: () => seen,
      sleep: async () => {
        expect(barrier.armed()).toBe(false);
        expect(barrier.commitTurn({ type: "fleet_inbound", content: "during the wait" }, "worker")).toBe(false);
        seen = true;
      },
    });
    expect(result).toBe("ready");
    expect(barrier.armed()).toBe(false);
  });

  it("a busy second check clears the flag, writes nothing, stays opened, and the close clears current before the wait", async () => {
    const home = scratch("s244-busy-");
    const attempt = open(home);
    const barrier = new QuiescenceBarrier(home);
    barrier.bind(attempt);
    expect(barrier.secondCheck(idle({ agents: [{ process: "running", execution: "working" }] }))).toBe("busy");
    expect(barrier.armed()).toBe(false);
    expect(listHandback(home, attempt.id)).toEqual([]);
    const openRead = readCurrent(home);
    expect(openRead).toMatchObject({ state: "open", attempt: { stage: "opened" } });
    expect(openRead.state === "open" && openRead.attempt.history).toHaveLength(1);
    expect(stateWriteRefused(openRead)).toBe(true);
    expect(await checkQuiet(quietDeps(home), home, null, false)).toMatchObject({ ok: false, code: "update-running" });

    closeUnusedAttempt(home, attempt);
    expect(readCurrent(home)).toEqual({ state: "none" });
    expect(stateWriteRefused(readCurrent(home))).toBe(false);
    expect(await checkQuiet(quietDeps(home), home, null, false)).toMatchObject({ id: "P8", ok: true });

    let delivered = false;
    const waited = await barrier.waitForCandidate({
      maxMs: 60_000, pollMs: 5, idle: () => delivered,
      sleep: async () => {
        expect(barrier.armed()).toBe(false);
        expect(barrier.commitTurn({ type: "fleet_inbound", content: "after the close" }, "worker")).toBe(false);
        delivered = true;
      },
    });
    expect(waited).toBe("ready");
    expect(listHandback(home, attempt.id)).toEqual([]);
  });

  it("a pin refuses the attempt instead of waiting it out", () => {
    const home = scratch("s244-pin-");
    const barrier = new QuiescenceBarrier(home);
    barrier.bind(open(home));
    expect(barrier.secondCheck(idle({ pin: true }))).toBe("refused");
    expect(barrier.armed()).toBe(false);
    expect(listHandback(home, ID)).toEqual([]);
    expect(readCurrent(home)).toMatchObject({ state: "open", attempt: { stage: "opened" } });
  });

  it("an idle second check holds the flag and writes the prefix as references, in created_seq order, without claiming", () => {
    const home = scratch("s244-prefix-");
    const dbPath = join(home, "outbox.db");
    const outbox = new DeliveryOutbox(dbPath, "mgr");
    const first = outbox.admit(outboxInput("op-30")).delivery;
    const second = outbox.admit(outboxInput("op-10")).delivery;
    const third = outbox.admit(outboxInput("op-20")).delivery;
    const attempt = open(home);
    const barrier = new QuiescenceBarrier(home);
    barrier.bind(attempt);
    expect(barrier.secondCheck(idle({
      pending: [
        { deliveryId: first.deliveryId, createdSeq: first.createdSeq },
        { deliveryId: third.deliveryId, createdSeq: third.createdSeq },
        { deliveryId: second.deliveryId, createdSeq: second.createdSeq },
      ],
    }))).toBe("held");
    expect(barrier.armed()).toBe(true);
    expect(readCurrent(home)).toMatchObject({ state: "open", attempt: { stage: "opened" } });
    const entries = listHandback(home, attempt.id);
    expect(entries.map(refOf)).toEqual([
      { kind: "reference", deliveryId: first.deliveryId, createdSeq: first.createdSeq },
      { kind: "reference", deliveryId: second.deliveryId, createdSeq: second.createdSeq },
      { kind: "reference", deliveryId: third.deliveryId, createdSeq: third.createdSeq },
    ]);
    expect(entries.map(entry => entry.seq)).toEqual([1, 2, 3]);
    expect(outbox.get(first.deliveryId)?.state).toBe("queued");
    expect(outbox.get(second.deliveryId)?.state).toBe("queued");
    expect(outbox.get(third.deliveryId)?.state).toBe("queued");
    outbox.close();
  });

  it("--now checks once and does not wait", async () => {
    const home = scratch("s244-now-");
    const barrier = new QuiescenceBarrier(home);
    const started = Date.now();
    const result = await barrier.waitForCandidate({
      once: true, maxMs: DEFAULT_MAX_IDLE_WAIT_MS, pollMs: 60_000, idle: () => false,
      sleep: async () => { throw new Error("the --now path waited"); },
    });
    expect(result).toBe("not-idle");
    expect(Date.now() - started).toBeLessThan(1_000);
    barrier.bind(open(home));
    expect(barrier.secondCheck(idle({ outboxInFlight: true }))).toBe("busy");
    expect(barrier.armed()).toBe(false);
    closeUnusedAttempt(home, (readCurrent(home) as { attempt: AttemptRecord }).attempt);
    expect(readCurrent(home)).toEqual({ state: "none" });
  });
});

describe("S-244 holds after the flag is up", () => {
  it("journals an ingress copy, a new outbox row, and a due schedule, and does not start them", () => {
    const home = scratch("s244-hold-");
    const attempt = open(home);
    const barrier = new QuiescenceBarrier(home);
    barrier.bind(attempt);
    const outbox = new DeliveryOutbox(join(home, "outbox.db"), "mgr");
    outbox.setQuiescence(barrier);
    expect(barrier.secondCheck(idle())).toBe("held");

    const web = { type: "fleet_inbound", content: "from the web", targetSession: "worker", meta: { source: "web" } };
    const hub = { type: "fleet_inbound", content: "from the hub", targetSession: "worker", meta: { from_display: "Hub" } };
    expect(barrier.commitTurn(web, "worker")).toBe(true);
    expect(barrier.commitTurn(hub, "worker")).toBe(false);
    expect(barrier.commitTurn({ type: "fleet_schedule_trigger", content: "already past the lock" }, "worker")).toBe(false);
    expect(isAgentTurn({ type: "fleet_inbound", content: "/status" })).toBe(false);
    expect(turnSource(web)).toBe("web");
    expect(turnSource(hub)).toBe("hub");

    const admitted = outbox.admit(outboxInput("op-new"));
    barrier.noteAdmission(admitted.delivery.deliveryId, admitted.delivery.createdSeq);
    expect(outbox.claimNext("mgr", () => "boot", new Set())).toBeUndefined();
    expect(outbox.get(admitted.delivery.deliveryId)?.state).toBe("queued");

    const dir = scratch("s244-hold-sched-");
    const fired: string[] = [];
    const scheduler = new Scheduler(join(dir, "scheduler.db"), schedule => { fired.push(schedule.id); }, DEFAULT_SCHEDULER_CONFIG, () => true);
    scheduler.init();
    scheduler.setQuiescence(barrier);
    const oneShot = scheduler.create({
      at: new Date(Date.now() + 86_400_000).toISOString(), message: "once", source: "a", target: "a", reply_chat_id: "1", reply_thread_id: null,
    });
    scheduler.trigger(oneShot.id);
    expect(fired).toEqual([]);
    expect(scheduler.db.get(oneShot.id)?.id).toBe(oneShot.id);

    const entries = listHandback(home, attempt.id);
    expect(entries.map(entry => entry.kind === "inbox" ? entry.item.kind : entry.kind)).toEqual(["copy", "reference", "deferred"]);
    const copies = entries.filter(entry => entry.kind === "inbox" && entry.item.kind === "copy");
    expect(copies.map(entry => entry.kind === "inbox" ? entry.source : "")).toEqual(["web"]);
    expect(entries.some(entry => entry.kind === "inbox" && entry.item.kind === "copy" && JSON.stringify(entry.item).includes("from the hub"))).toBe(false);
    expect(entries.some(entry => entry.kind === "deferred" && entry.job.scheduleId === oneShot.id)).toBe(true);
    scheduler.shutdown();
    outbox.close();
  });

  it("claimNext while armed writes a reference for a row the prefix missed, and claims nothing", () => {
    const home = scratch("s244-claim-");
    const attempt = open(home);
    const barrier = new QuiescenceBarrier(home);
    barrier.bind(attempt);
    const outbox = new DeliveryOutbox(join(home, "outbox.db"), "mgr");
    const admitted = outbox.admit(outboxInput("op-held"));
    outbox.setQuiescence(barrier);
    expect(barrier.secondCheck(idle())).toBe("held");
    expect(outbox.claimNext("mgr", () => "boot", new Set())).toBeUndefined();
    expect(outbox.get(admitted.delivery.deliveryId)?.state).toBe("queued");
    const refs = listHandback(home, attempt.id).map(refOf).filter(Boolean);
    expect(refs).toEqual([{ kind: "reference", deliveryId: admitted.delivery.deliveryId, createdSeq: admitted.delivery.createdSeq }]);
    expect(outbox.claimNext("mgr", () => "boot", new Set())).toBeUndefined();
    expect(listHandback(home, attempt.id)).toHaveLength(1);
    outbox.close();
  });

  it("an unarmed claimNext still claims", () => {
    const outbox = new DeliveryOutbox(join(scratch("s244-claim-free-"), "outbox.db"), "mgr");
    const admitted = outbox.admit(outboxInput("op-free"));
    const claimed = outbox.claimNext("mgr", () => "boot", new Set());
    expect(claimed?.deliveryId).toBe(admitted.delivery.deliveryId);
    expect(claimed?.state).toBe("delivering");
    outbox.close();
  });

  it("refuses a new task claim without a journal file, and an already-claimed card can still finish", () => {
    const home = scratch("s244-task-");
    const attempt = open(home);
    const barrier = new QuiescenceBarrier(home);
    barrier.bind(attempt);
    expect(barrier.secondCheck(idle())).toBe("held");
    const dir = scratch("s244-task-db-");
    const scheduler = new Scheduler(join(dir, "scheduler.db"), () => {}, DEFAULT_SCHEDULER_CONFIG, () => true);
    scheduler.init();
    const actor: Actor = { kind: "instance", name: "w" };
    const openCard = scheduler.db.createTask({ title: "Open", created_by: "w" }, actor);
    const claimed = scheduler.db.createTask({ title: "Claimed", created_by: "w" }, actor);
    scheduler.db.claimTask(claimed.id, "w", actor);
    scheduler.db.board.setQuiescence(barrier);
    expect(() => scheduler.db.claimTask(openCard.id, "w", actor)).toThrow(TaskBoardError);
    expect(scheduler.db.getTask(openCard.id)?.status).toBe("open");
    // Finishing is not a claim. An open card may still be finished, and one that is already claimed may too.
    expect(scheduler.db.completeTask(openCard.id, "finished open", actor).status).toBe("done");
    expect(scheduler.db.completeTask(claimed.id, "finished", actor).status).toBe("done");
    expect(listHandback(home, attempt.id)).toEqual([]);
    const created = scheduler.db.createTask({ title: "Still openable", created_by: "w" }, actor);
    expect(created.status).toBe("open");
    scheduler.shutdown();
  });
});

describe("S-244 hand-back", () => {
  const ports = (claims: string[], rows: Map<string, { state: string; target: string; eligible: boolean }>): HandbackPorts => ({
    log() {},
    lookup(id) { const row = rows.get(id); return row ? { state: row.state, target: row.target } : null; },
    claim(id) {
      const row = rows.get(id);
      if (!row) return "missing";
      if (row.state !== "queued" && row.state !== "retry_wait") return "settled";
      if (!row.eligible) return "ineligible";
      row.state = "delivering";
      claims.push(id);
      return "claimed";
    },
    admitCopy() { throw new Error("no copy in this walk"); },
    runDeferred() {},
    recordInterrupted() {},
  });

  it("claims queued rows, acks in-flight rows without a second claim, and holds only the same target", () => {
    const home = scratch("s244-walk-");
    let attempt = open(home);
    const barrier = new QuiescenceBarrier(home);
    barrier.bind(attempt);
    const rows = new Map([
      ["a1", { state: "retry_wait", target: "A", eligible: false }],
      ["a2", { state: "queued", target: "A", eligible: true }],
      ["b1", { state: "delivering", target: "B", eligible: true }],
      ["c1", { state: "queued", target: "C", eligible: true }],
    ]);
    expect(barrier.secondCheck(idle({ pending: [...rows.keys()].map((id, i) => ({ deliveryId: id, createdSeq: i + 1 })) }))).toBe("held");
    expect(barrier.runHandback(attempt, ports([], rows), OWN).walked).toBe(false);
    attempt = toHandback(home, attempt);
    const claims: string[] = [];
    barrier.runHandback(attempt, ports(claims, rows), OWN);
    expect(claims).toEqual(["c1"]);
    const acked = new Map(listHandback(home, attempt.id).map(entry => [refOf(entry)?.deliveryId, entry.acked]));
    expect(acked.get("a1")).toBe(false);
    expect(acked.get("a2")).toBe(false);
    expect(acked.get("b1")).toBe(true);
    expect(acked.get("c1")).toBe(true);
    rows.get("a1")!.eligible = true;
    const again: string[] = [];
    barrier.runHandback(attempt, ports(again, rows), OWN);
    expect(again).toEqual(["a1", "a2"]);
  });

  it("logs a missing row, acks it, and keeps walking", () => {
    const home = scratch("s244-missing-");
    let attempt = open(home);
    const barrier = new QuiescenceBarrier(home);
    barrier.bind(attempt);
    const dbPath = join(home, "outbox.db");
    const outbox = new DeliveryOutbox(dbPath, "mgr");
    const gone = outbox.admit(outboxInput("op-gone")).delivery;
    const stays = outbox.admit(outboxInput("op-stays", "other")).delivery;
    expect(barrier.secondCheck(idle({ pending: [
      { deliveryId: gone.deliveryId, createdSeq: gone.createdSeq },
      { deliveryId: stays.deliveryId, createdSeq: stays.createdSeq },
    ] }))).toBe("held");
    outbox.close();
    const raw = new Database(dbPath);
    raw.prepare("DELETE FROM deliveries WHERE delivery_id=?").run(gone.deliveryId);
    raw.close();
    const again = new DeliveryOutbox(dbPath, "mgr");
    const logs: Array<{ deliveryId: string; seq: number }> = [];
    const claims: string[] = [];
    attempt = toHandback(home, attempt);
    barrier.runHandback(attempt, {
      log(fields) { logs.push(fields); },
      lookup(id) { const row = again.get(id); return row ? { state: row.state, target: row.targetInstance } : null; },
      claim(id) { const result = again.claimExact(id, "mgr", "boot"); if (result === "claimed") claims.push(id); return result; },
      admitCopy() { throw new Error("no copy"); }, runDeferred() {}, recordInterrupted() {},
    }, OWN);
    expect(logs).toEqual([{ deliveryId: gone.deliveryId, seq: 1 }]);
    expect(claims).toEqual([stays.deliveryId]);
    expect(listHandback(home, attempt.id).every(entry => entry.acked)).toBe(true);
    again.close();
  });

  it("admits a copy once under the hand-back source key, and a replay reuses that row", () => {
    const home = scratch("s244-copy-");
    let attempt = open(home);
    const barrier = new QuiescenceBarrier(home);
    barrier.bind(attempt);
    expect(barrier.secondCheck(idle())).toBe("held");
    expect(barrier.commitTurn({ type: "fleet_inbound", content: "copied", targetSession: "worker", meta: { source: "adapter" } }, "worker")).toBe(true);
    const outbox = new DeliveryOutbox(join(home, "outbox.db"), "mgr");
    const inserted: boolean[] = [];
    const claims: string[] = [];
    let crash = false;
    const crashing: JournalIo = { ...defaultJournalIo, link(from, to) {
      if (crash && to.endsWith(".acked")) throw new Error("crash before ack");
      defaultJournalIo.link(from, to);
    } };
    const replaying = new QuiescenceBarrier(home, crashing);
    replaying.bind(attempt);
    const walk = () => replaying.runHandback(attempt, {
      log() {},
      lookup(id) { const row = outbox.get(id); return row ? { state: row.state, target: row.targetInstance } : null; },
      claim(id) { const result = outbox.claimExact(id, "mgr", "boot"); if (result === "claimed") claims.push(id); return result; },
      admitCopy(sourceKey, body, target) {
        const admitted = outbox.admit({
          operationId: sourceKey, sourceKey, sourceInstance: "update", sourceDaemonBootId: "updater",
          targetInstance: target, kind: "fleet_inbound", correlationId: sourceKey, payload: body as Record<string, unknown>,
        });
        inserted.push(admitted.inserted);
        return { deliveryId: admitted.delivery.deliveryId };
      },
      runDeferred() {}, recordInterrupted() {},
    }, OWN);
    attempt = toHandback(home, attempt);
    crash = true;
    expect(() => walk()).toThrow(/crash before ack/);
    expect(inserted).toEqual([true]);
    expect(claims).toHaveLength(1);
    expect(outbox.get(claims[0]!)?.state).toBe("delivering");
    crash = false;
    walk();
    expect(inserted).toEqual([true, false]);
    expect(claims).toHaveLength(1);
    expect(listHandback(home, attempt.id).every(entry => entry.acked)).toBe(true);
    outbox.close();
  });

  it("a copy whose target instance is gone is logged and acknowledged, with no row admitted", () => {
    const home = scratch("s244-copy-gone-");
    let attempt = open(home);
    const barrier = new QuiescenceBarrier(home);
    barrier.bind(attempt);
    expect(barrier.secondCheck(idle())).toBe("held");
    expect(barrier.commitTurn({ type: "user_message", content: "for a removed agent", meta: { source: "web" } }, "removed")).toBe(true);
    expect(listHandback(home, attempt.id)).toMatchObject([{ kind: "inbox", item: { kind: "copy", target: "removed" } }]);
    attempt = toHandback(home, attempt);
    const logs: string[] = [], targets: string[] = [];
    const r = barrier.runHandback(attempt, {
      log(_f, m) { logs.push(m); }, lookup() { throw new Error("no lookup for a gone target"); }, claim() { throw new Error("no claim"); },
      admitCopy(_k, _b, target) { targets.push(target); return null; }, runDeferred() {}, recordInterrupted() {},
    }, OWN);
    expect(r).toEqual({ walked: true, acked: 1 });
    expect(targets).toEqual(["removed"]);
    expect(logs).toEqual(["hand-back copy's target removed no longer exists; acknowledging and continuing"]);
    expect(listHandback(home, attempt.id).every(e => e.acked)).toBe(true);
  });

  it("a crash after the claim and before .acked claims only once on resume", () => {
    const home = scratch("s244-crash-claim-");
    let attempt = open(home);
    let crash = false;
    const barrier = new QuiescenceBarrier(home, {
      ...defaultJournalIo,
      link(from, to) {
        if (crash && to.endsWith(".acked")) throw new Error("crash before ack");
        defaultJournalIo.link(from, to);
      },
    });
    barrier.bind(attempt);
    const outbox = new DeliveryOutbox(join(home, "outbox.db"), "mgr");
    const admitted = outbox.admit(outboxInput("op-crash"));
    expect(barrier.secondCheck(idle({ pending: [{ deliveryId: admitted.delivery.deliveryId, createdSeq: admitted.delivery.createdSeq }] }))).toBe("held");
    attempt = toHandback(home, attempt);
    const claims: string[] = [];
    const walk = () => barrier.runHandback(attempt, {
      log() {},
      lookup(id) { const row = outbox.get(id); return row ? { state: row.state, target: row.targetInstance } : null; },
      claim(id) { const result = outbox.claimExact(id, "mgr", "boot"); if (result === "claimed") claims.push(id); return result; },
      admitCopy() { throw new Error("reference"); }, runDeferred() {}, recordInterrupted() {},
    }, OWN);
    crash = true;
    expect(() => walk()).toThrow(/crash before ack/);
    expect(claims).toEqual([admitted.delivery.deliveryId]);
    expect(outbox.get(admitted.delivery.deliveryId)?.state).toBe("delivering");
    crash = false;
    walk();
    expect(claims).toEqual([admitted.delivery.deliveryId]);
    expect(listHandback(home, attempt.id)[0]?.acked).toBe(true);
    outbox.close();
  });

  it("writes .started before a deferred trigger, and a replay that finds .started does not run it again", () => {
    const home = scratch("s244-defer-");
    let attempt = open(home);
    const barrier = new QuiescenceBarrier(home);
    barrier.bind(attempt);
    expect(barrier.secondCheck(idle())).toBe("held");
    const dir = scratch("s244-defer-db-");
    const fired: string[] = [];
    const scheduler = new Scheduler(join(dir, "scheduler.db"), schedule => { fired.push(schedule.id); }, DEFAULT_SCHEDULER_CONFIG, () => true);
    scheduler.init();
    scheduler.setQuiescence(barrier);
    const oneShot = scheduler.create({
      at: new Date(Date.now() + 86_400_000).toISOString(), message: "once", source: "a", target: "a", reply_chat_id: "1", reply_thread_id: null,
    });
    scheduler.trigger(oneShot.id);
    expect(scheduler.db.get(oneShot.id)).toBeTruthy();
    expect(fired).toEqual([]);
    attempt = toHandback(home, attempt);
    const deferred = listHandback(home, attempt.id).find(entry => entry.kind === "deferred");
    expect(deferred && deferred.kind === "deferred").toBe(true);
    let crash = false;
    barrier.runHandback(attempt, {
      log() {}, lookup() { return null; }, claim() { return "missing"; }, admitCopy() { throw new Error("no"); },
      runDeferred(job) {
        expect(existsSync(`${deferred!.file}.started`)).toBe(true);
        expect(existsSync(`${deferred!.file}.acked`)).toBe(false);
        fired.push(job.runId);
        if (crash) throw new Error("crash after started");
      },
      recordInterrupted(job) { scheduler.recordRun(job.scheduleId, "interrupted-by-update", job.runId); },
    }, OWN);
    // The run above completed and acked. Replay of a started-but-unacked entry is the next barrier.
    crash = true;
    const home2 = scratch("s244-defer-replay-");
    let second = open(home2, newAttemptId(new Date("2026-11-26T18:05:00Z"), "b244b244"));
    const replay = new QuiescenceBarrier(home2);
    replay.bind(second);
    expect(replay.secondCheck(idle())).toBe("held");
    const shot = scheduler.create({
      at: new Date(Date.now() + 86_400_000).toISOString(), message: "twice", source: "a", target: "a", reply_chat_id: "1", reply_thread_id: null,
    });
    // Journal the deferred file by hand through the armed barrier, then mark it started without acking.
    replay.holdSchedule(shot.id, "run-once");
    second = toHandback(home2, second);
    const entry = listHandback(home2, second.id).find(item => item.kind === "deferred");
    if (!entry || entry.kind !== "deferred") throw new Error("missing deferred entry");
    markHandback(entry, "started");
    const runsBefore = fired.length;
    replay.runHandback(second, {
      log() {}, lookup() { return null; }, claim() { return "missing"; }, admitCopy() { throw new Error("no"); },
      runDeferred() { fired.push("ran-again"); },
      recordInterrupted(job) { scheduler.recordRun(job.scheduleId, "interrupted-by-update", job.runId); },
    }, OWN);
    expect(fired.length).toBe(runsBefore);
    expect(scheduler.db.getRuns(shot.id, 5).map(run => ({ status: run.status, detail: run.detail }))).toEqual([
      { status: "interrupted-by-update", detail: "run-once" },
    ]);
    scheduler.shutdown();
  });
});

describe("S-244 cancel and the service lock", () => {
  it("slash controls skip the agent fence; stop and restart are still refused while the attempt is open", () => {
    const home = scratch("s244-lock-");
    const attempt = open(home);
    const barrier = new QuiescenceBarrier(home);
    barrier.bind(attempt);
    expect(barrier.secondCheck(idle())).toBe("held");
    for (const kind of ["status", "cancel", "update", "card-cancel", "admin", "stop", "restart"]) {
      expect(skipsAgentFence(kind)).toBe(true);
    }
    for (const content of ["/status", "/cancel", "/cancel@bot", "/update", "/update now", "/stop", "/restart"]) {
      expect(barrier.commitTurn({ type: "fleet_inbound", content }, "worker")).toBe(false);
    }
    const read = readCurrent(home);
    expect(serviceCommandRefusal(read, "stop")).toEqual({ refused: true, id: attempt.id, stage: "opened" });
    expect(serviceCommandRefusal(read, "restart")).toMatchObject({ refused: true, id: attempt.id, stage: "opened" });
    expect(serviceCommandRefusal(read, "start").refused).toBe(true);
    expect(serviceCommandRefusal(read, "service-install").refused).toBe(true);
    for (const kind of ["status", "cancel", "update", "card-cancel", "admin"]) {
      expect(serviceCommandRefusal(read, kind)).toEqual({ refused: false });
    }
    expect(readCurrent(home)).toMatchObject({ state: "open", attempt: { stage: "opened" } });
    expect(existsSync(join(attemptDir(home, attempt.id), "cancel"))).toBe(false);
  });

  it("handbackDue: only the abandoning attempt's consumed, live old generation with restart-old and no hand-back walks", () => {
    const home = scratch("s244-due-");
    const base = toHandback(home, open(home));
    const gens = (a: AttemptRecord) => a.fleets as { gen: string; nonce: string; pid?: number; consumed?: boolean; dead?: boolean }[];
    const withGen = (a: AttemptRecord, patch: Record<string, unknown>) => ({ ...a, fleets: gens(a).map(g => (g.nonce === OWN.nonce ? { ...g, ...patch } : g)) });
    const withSteps = (a: AttemptRecord, keep: (s: string | undefined) => boolean) => ({ ...a, history: a.history.filter(h => h.stage !== "abandoning" || keep(h.substep)) });
    expect(handbackDue(base, OWN)).toBe(true);
    expect(handbackDue({ ...base, stage: "rolling-back" }, OWN)).toBe(false);                                   // not abandoning
    expect(handbackDue(withSteps(base, s => s !== "restart-old"), OWN)).toBe(false);                           // the old fleet not restarted yet
    expect(handbackDue({ ...base, history: [...base.history, { stage: "abandoning", at: "x", substep: "hand-back" }] }, OWN)).toBe(false);   // done
    expect(handbackDue(base, { ...OWN, nonce: "f".repeat(32) })).toBe(false);                                 // another nonce
    expect(handbackDue(base, { ...OWN, pid: OWN.pid + 1 })).toBe(false);                                       // another process
    expect(handbackDue(withGen(base, { consumed: false }), OWN)).toBe(false);                                  // planned, not taken over
    expect(handbackDue(withGen(base, { dead: true }), OWN)).toBe(false);                                       // journaled dead
    expect(handbackDue(withGen(base, { gen: "trial" }), OWN)).toBe(false);                                     // not the old generation
  });

  it("the card cancel writes the marker only while waiting or at the barrier, and the write does not abandon", () => {
    const home = scratch("s244-cancel-");
    const attempt = open(home);
    const barrier = new QuiescenceBarrier(home);
    expect(cancelAllowed("opened")).toBe(true);
    expect(barrier.requestCancel(attempt, { reason: "not now", by: "Ada" })).toBe(true);
    expect(readCurrent(home)).toMatchObject({ state: "open", attempt: { stage: "opened" } });
    expect(JSON.parse(readFileSync(join(attemptDir(home, attempt.id), "cancel"), "utf8"))).toMatchObject({ reason: "not now", by: "Ada" });
    expect(barrier.requestCancel(attempt, { reason: "again", by: "Bea" })).toBe(false);
    expect(barrier.runHandback(attempt, { log() {}, lookup() { return null; }, claim() { return "missing"; }, admitCopy() { throw new Error("no"); }, runDeferred() {}, recordInterrupted() {} }, OWN).walked).toBe(false);

    let atBarrier = advance(home, attempt, "barrier");
    expect(barrier.requestCancel(atBarrier, { reason: "still", by: "Ada" })).toBe(false);
    atBarrier = advance(home, atBarrier, "stopping");
    const snap = advance(home, atBarrier, "snapshotted");
    expect(barrier.requestCancel(snap, { reason: "too late", by: "Ada" })).toBe(false);
    const consumed = consumeCancel(home, snap, true);
    expect(consumed.result).toBe("too-late");
    expect(consumed.attempt.stage).toBe("snapshotted");
    expect(existsSync(join(attemptDir(home, attempt.id), "cancel.ignored-snapshotted"))).toBe(true);
    expect(TOO_LATE_CANCEL).toBe("too late to cancel: the update is past the point of no return");
  });

  it("a honoured timeout or card cancel offers Update now or Keep waiting", () => {
    const home = scratch("s244-offer-");
    const attempt = open(home);
    const barrier = new QuiescenceBarrier(home);
    return barrier.waitForCandidate({
      maxMs: 0, pollMs: 5, idle: () => false, sleep: async () => { throw new Error("a zero budget waited"); },
    }).then(result => {
      expect(result).toBe("timeout");
      expect(barrier.requestCancel(attempt, { reason: "idle wait ended", by: "Ada" })).toBe(true);
      const consumed = consumeCancel(home, attempt, false);
      expect(consumed.result).toBe("honoured");
      expect(consumed.attempt.stage).toBe("abandoning");
      expect(cardAfterHonouredCancel()).toEqual({ status: "waiting", actions: [...HONOURED_CANCEL_ACTIONS] });
      expect(cardAfterHonouredCancel().actions).toEqual(["Update now", "Keep waiting"]);
    });
  });
});

describe("S-244 ingress inventory", () => {
  it("names the commit points, and the installer does not call the barrier", () => {
    const fleet = FleetManager.prototype as unknown as Record<string, { toString(): string }>;
    for (const name of ["sendWhenConnected", "handOffAfterBeforeInput", "sendAfterIpcReturns", "sendHumanControl"]) {
      holdBeforeSend(fleet[name]!.toString());
    }
    const admit = fleet.admitDurableDelivery!.toString();
    expect(admit.indexOf("noteAdmission")).toBeGreaterThan(admit.indexOf("outbox.admit"));
    const claim = (DeliveryOutbox.prototype as unknown as Record<string, { toString(): string }>).claimNextSync!.toString();
    expect(claim.indexOf("holdOutboxClaim")).toBeGreaterThanOrEqual(0);
    expect(claim.indexOf("holdOutboxClaim")).toBeLessThan(claim.indexOf("state='delivering'"));
    const move = (TaskBoard.prototype as unknown as Record<string, { toString(): string }>).applyMove!.toString();
    expect(move.indexOf("holdTaskClaim")).toBeGreaterThanOrEqual(0);
    expect(move.indexOf("holdTaskClaim")).toBeLessThan(move.indexOf("card.status ="));
    expect(move).toContain('from === "open"');
    const run = (Scheduler.prototype as unknown as Record<string, { toString(): string }>).runWithLock!.toString();
    const mark = run.indexOf("this.markHandled");
    const before = run.slice(0, mark);
    expect(before.indexOf("executing.add")).toBeGreaterThanOrEqual(0);
    expect(before.indexOf("executing.add")).toBeLessThan(before.indexOf("holdSchedule"));
    expect(before).toContain("return");
    expect(run.slice(mark)).toContain("executing.add");
    const launch = fleet.launchInstalledUpdate!.toString();
    expect(launch).not.toContain("quiescence");
    expect(launch).not.toContain("secondCheck");
    expect(launch).not.toContain("holdPaneSend");
    const hand = fleet.handOffAfterBeforeInput!.toString();
    const flag = hand.indexOf("refuseHubPane");
    expect(flag).toBeGreaterThanOrEqual(0);
    expect(flag).toBeLessThan(hand.indexOf("await beforeInput"));
    expect(flag).toBeLessThan(hand.indexOf("this.prepareClassicForPerson"));
  });

  it("does not defer the same occurrence twice, including after a new process binds the attempt", () => {
    const home = scratch("s244-dedupe-");
    const attempt = open(home);
    const barrier = new QuiescenceBarrier(home);
    barrier.bind(attempt);
    expect(barrier.secondCheck(idle())).toBe("held");
    expect(barrier.holdSchedule("sched-1", "run-1")).toBe(true);
    expect(barrier.holdSchedule("sched-1", "run-1")).toBe(true);
    expect(barrier.holdSchedule("sched-1", "run-2")).toBe(true);
    const jobs = () => listHandback(home, attempt.id).filter(entry => entry.kind === "deferred");
    expect(jobs().map(entry => entry.kind === "deferred" ? entry.job.runId : "")).toEqual(["run-1", "run-2"]);
    const again = new QuiescenceBarrier(home);
    again.bind(attempt);
    expect(again.holdSchedule("sched-1", "run-1")).toBe(false);
    again.secondCheck(idle());
    expect(again.holdSchedule("sched-1", "run-1")).toBe(true);
    expect(jobs().map(entry => entry.kind === "deferred" ? entry.job.runId : "")).toEqual(["run-1", "run-2"]);
  });
});
