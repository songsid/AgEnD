// M-3770 slice 2.5, wiring part 2 (design update-wiring-m3770.md §4, §10.2): the fleet's side of the control mailbox —
// its 250 ms pass answers `status` and `barrier.arm`; a held barrier goes on every gate (pane writes, the outbox, the
// scheduler, the task board) and comes down when the attempt ends; busy or refused never stays up; request-context On
// never holds; and an old fleet an abandon never stopped takes its held work back from the same pass. The fleet is a
// FleetManager prototype with only the state these paths read; nothing is started.
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { FleetManager } from "../src/fleet-manager.js";
import { askFleet, type ControlRequest } from "../src/update-control.js";
import { ackGeneration, advance, finish, listHandback, newAttemptId, openAttempt, planGeneration, readCurrent, substep, type AttemptRecord } from "../src/update-journal.js";
import { acquireServiceLock, serviceLockSenderLive } from "../src/service-lock.js";

const dirs: string[] = [], outboxes: DeliveryOutbox[] = [];
afterEach(() => { for (const o of outboxes.splice(0)) o.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const ID = newAttemptId(new Date("2026-11-27T14:00:00Z"), "e0e0e0e0");
const SELF = { nonce: "a".repeat(32), pid: process.pid };
const DRIVER = { pid: 4343, token: "t".repeat(32) };

function fleet(opts: { execution?: string; senderLive?: boolean; requestContextOn?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "control-fleet-")); dirs.push(home);
  const opened = openAttempt(home, { id: ID, kind: "update", updater: { pid: DRIVER.pid, start: { processStart: "x" } },
    from: { name: "@songsid/agend", version: "2.5.0", integrity: null }, to: { name: "@songsid/agend", version: "2.5.1", integrity: null },
    extra: { fleets: [{ gen: "old", nonce: SELF.nonce, pid: SELF.pid, plannedAt: new Date().toISOString(), consumed: true }] } });
  if (!opened.ok) throw new Error(opened.reason);
  const outbox = new DeliveryOutbox(join(home, "delivery-outbox.db"), "mgr"); outboxes.push(outbox);
  const fm = Object.create(FleetManager.prototype) as any;
  const scheduler = { setQuiescence: vi.fn(), scheduleInRun: () => false, db: { board: { setQuiescence: vi.fn() } } };
  Object.assign(fm, {
    dataDir: home, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, shuttingDown: false, startupComplete: true,
    fleetConfig: { instances: { worker: {} } }, queueWorkers: new Map(), restartsInFlight: new Set(), stopsInFlight: new Set(),
    handOffsInFlight: new Set(), ipcConnectInFlight: new Set(), ipcReconnectInFlight: new Set(), webChannelEchoTails: new Map(),
    activeDurableTargets: new Set(), deliveryPumpRunning: false, reconcileInFlight: null, topicCleanupInFlight: false,
    getInstanceStatus: () => "running", getInstanceExecutionState: () => opts.execution ?? "idle", getInstanceInteraction: () => undefined,
    hasPendingIdleGatedDelivery: () => false, deliveryOutbox: outbox, scheduler, quiescence: null,
    updateControlSelf: () => SELF, updateSenderLive: () => opts.senderLive ?? true, updateRequestContextOn: () => opts.requestContextOn ?? false,
    updateBarrier: null, updateHandbackWalkedAt: -Infinity,
  });
  Object.defineProperty(fm, "daemons", { value: new Map() });                                       // a getter on the class
  return { home, fm, outbox, scheduler, attempt: opened.attempt };
}
const arm = (f: ReturnType<typeof fleet>, seq = 1, over: Partial<ControlRequest> = {}) => {
  let t = 0;
  return askFleet(f.home, { seq, op: "barrier.arm", attemptId: ID, stage: "opened", to: { nonce: SELF.nonce }, from: DRIVER, ...over },
    { timeoutMs: 1000, pollMs: 250, now: () => t, sleep: ms => { t += ms; f.fm.updateControlTick(); } });
};

describe("M-3770 2.5 wiring part 2: the fleet answers its mailbox", () => {
  it("barrier.arm on an idle fleet: held, the barrier on every gate, the outbox's waiting rows journaled as references", () => {
    const f = fleet();
    const row = f.outbox.admit({ operationId: "o", sourceKey: "k", sourceInstance: "peer", sourceDaemonBootId: "b", targetInstance: "worker",
      kind: "fleet_inbound", payload: { type: "fleet_inbound", content: "waiting", meta: {} } }).delivery;
    const r = arm(f);
    expect(r.ok && r.response.result).toEqual({ status: "ok", value: "held" });
    expect(r.ok && r.response.by).toEqual(SELF);
    const barrier = f.fm.updateBarrier.barrier;
    expect(barrier.armed()).toBe(true);
    expect(f.fm.quiescence).toBe(barrier);
    expect(f.scheduler.setQuiescence).toHaveBeenLastCalledWith(barrier);
    expect(f.scheduler.db.board.setQuiescence).toHaveBeenLastCalledWith(barrier);
    expect((f.outbox as unknown as { quiescence: unknown }).quiescence).toBe(barrier);                // the outbox's own claim gate
    expect(listHandback(f.home, ID).map(e => e.kind === "inbox" && e.item.kind === "reference" ? e.item.deliveryId : null)).toEqual([row.deliveryId]);
    // Idempotent: asked again, the same barrier stays and answers held.
    const again = arm(f, 2);
    expect(again.ok && again.response.result).toEqual({ status: "ok", value: "held" });
    expect(f.fm.updateBarrier.barrier).toBe(barrier);
  });

  it("a busy fleet answers busy, and the barrier comes down at once", () => {
    const f = fleet({ execution: "working" });
    const r = arm(f);
    expect(r.ok && r.response.result).toEqual({ status: "ok", value: "busy" });
    expect(f.fm.updateBarrier).toBeNull();
    expect(f.fm.quiescence).toBeNull();
    expect(f.scheduler.setQuiescence).toHaveBeenLastCalledWith(null);
  });

  it("request-context On never holds (gate (b)): refused, no barrier", () => {
    const f = fleet({ requestContextOn: true });
    const r = arm(f);
    expect(r.ok && r.response.result).toEqual({ status: "ok", value: "refused" });
    expect(f.fm.updateBarrier).toBeNull();
  });

  it("a stale sender is answered stale; nothing is armed", () => {
    const f = fleet({ senderLive: false });
    const r = arm(f);
    expect(r.ok && r.response.result).toMatchObject({ status: "stale" });
    expect(f.fm.updateBarrier).toBeNull();
  });

  it("when the attempt ends, the next pass takes the barrier down", () => {
    const f = fleet();
    expect(arm(f).ok).toBe(true);
    expect(f.fm.updateBarrier).not.toBeNull();
    const ab = advance(f.home, f.attempt, "abandoning");
    finish(f.home, substep(f.home, substep(f.home, ab, "restart-old"), "hand-back"), { kind: "abandoned", reason: "test" });
    expect(readCurrent(f.home).state).toBe("none");
    f.fm.updateControlTick();
    expect(f.fm.updateBarrier).toBeNull();
    expect(f.fm.quiescence).toBeNull();
  });

  it("an old fleet an abandon never stopped walks its hand-back from the pass (at most every 10 s)", () => {
    const f = fleet();
    const walk = vi.fn();
    f.fm.walkUpdateHandback = walk;
    let a: AttemptRecord = advance(f.home, f.attempt, "abandoning");
    a = substep(f.home, a, "restart-old");
    f.fm.updateControlTick();
    f.fm.updateControlTick();
    expect(walk).toHaveBeenCalledTimes(1);
    expect(walk.mock.calls[0]![1]).toEqual(SELF);
  });
});

describe("M-3770 2.5 wiring part 2: the sender check on the real service lock", () => {
  it("live only for the lock's own holder token and pid, while it is the open attempt's updater", () => {
    const admission = createRequire(import.meta.url)("../launcher/install-admission.cjs") as { processStart(pid: number): string | null; startTicks(pid: number): string | null; bootId(): string | null };
    const home = mkdtempSync(join(tmpdir(), "control-lock-")); dirs.push(home);
    const start = admission.processStart(process.pid)!;
    const ticks = admission.startTicks(process.pid), boot = admission.bootId();
    const updaterStart = { processStart: start, ...(ticks !== null && boot !== null ? { startTicks: ticks, bootId: boot } : {}) };
    const opened = openAttempt(home, { id: ID, kind: "update", updater: { pid: process.pid, start: updaterStart },
      from: { name: "@songsid/agend", version: "2.5.0", integrity: null }, to: { name: "@songsid/agend", version: "2.5.1", integrity: null } });
    if (!opened.ok) throw new Error(opened.reason);
    const lock = acquireServiceLock(home, ID, { pid: process.pid, processStart: admission.processStart, startTicks: admission.startTicks, bootId: admission.bootId,
      newToken: () => "f".repeat(32), now: () => new Date(), log: () => {} });
    if (!lock.ok) throw new Error(lock.reason);
    const deps = { processStart: admission.processStart, startTicks: admission.startTicks, bootId: admission.bootId };
    expect(serviceLockSenderLive(home, { pid: process.pid, token: lock.token }, deps)).toBe(true);
    expect(serviceLockSenderLive(home, { pid: process.pid, token: "0".repeat(32) }, deps)).toBe(false);   // another token
    expect(serviceLockSenderLive(home, { pid: process.pid + 1, token: lock.token }, deps)).toBe(false);   // another pid
    lock.release();
    expect(serviceLockSenderLive(home, { pid: process.pid, token: lock.token }, deps)).toBe(false);      // no holder
  });
});
