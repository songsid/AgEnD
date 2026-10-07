/**
 * Phase 2c (docs/design/phase2-submit-contract.md §1.1, §1.5, §4 2c):
 * `delivery_worker: on` hands a target's durable lane to a TargetQueueWorker.
 * Real FleetManager, SQLite outbox, pump, wake coordinator and workers; the
 * daemon is a fake, and the hand-off (deliverToInstance) is scripted per call
 * to play the daemon's side: begin, then complete / hold / fail.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ created: [] as any[] }));

vi.mock("../src/daemon.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/daemon.js")>();
  const { EventEmitter: Emitter } = await import("node:events");
  class FakeDaemon extends Emitter {
    static seq = 0;
    bootId = `boot-${++FakeDaemon.seq}`;
    isPaused = false;
    holdReason: string | null = null;
    constructor(public name: string) { super(); fake.created.push(this); }
    setDeliveryOutboxPort() {}
    setPeerWorkingDirectories() {}
    setStatusEmojiAvoidList() {}
    setWorkLeaseCheck() {}
    seedActivityNow() {}
    requestPauseWhenIdle() {}
    clearSuspectedAuthFailure() {}
    notAcceptingReason() { return this.holdReason; }
    fenceDeliveryWritesForStop() {}
    async waitForDeliveryWritesToDrain() { return true; }
    async start() {}
    async abortStartup() {}
    async stop() {}
    async pause() { this.isPaused = true; }
    clearPendingDeliveries() {}
    async sendEscape() {}
    async wake() { this.isPaused = false; }
    get lastPausedAt() { return null; }
    getProcessStatus() { return "running"; }
  }
  return { ...original, Daemon: FakeDaemon };
});

import { FleetManager } from "../src/fleet-manager.js";
import { TargetQueueWorker } from "../src/target-queue-worker.js";

type Script = "complete" | "hold" | "throwAfterBegin" | "notSent" | "gated";

const dirs: string[] = [];
const fleets: FleetManager[] = [];
// #1204: the mock's 5ms setTimeout can fire after afterEach closes the DB.
// Track each handle so afterEach can cancel any that are still pending before
// closing the outbox, preventing a "database is closed" crash on teardown.
const pendingCompleteTimers = new Set<ReturnType<typeof setTimeout>>();
afterEach(async () => {
  // Cancel any complete timers that haven't fired yet before the DB closes.
  for (const t of pendingCompleteTimers) clearTimeout(t);
  pendingCompleteTimers.clear();
  for (const fm of fleets.splice(0)) {
    fm.wakeCoordinator?.stop();
    const timer = (fm as any).replyObligationTimer; if (timer) clearInterval(timer);
    const pump = (fm as any).deliveryPumpTimer; if (pump) clearTimeout(pump);
    (fm as any).shuttingDown = true;
    try { (fm as any).deliveryOutbox?.close(); } catch { /* closed */ }
  }
  vi.restoreAllMocks();
  fake.created.length = 0;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let opSeq = 0;
async function fleet(mode: "off" | "wake_only" | "on", perInstance: Record<string, string> = {}) {
  const dataDir = join(tmpdir(), `agend-2c-${process.pid}-${Date.now()}-${dirs.length}`);
  mkdirSync(dataDir, { recursive: true });
  dirs.push(dataDir);
  const fm = new FleetManager(dataDir);
  fleets.push(fm);
  const cfg = (name: string) => ({
    working_directory: join(dataDir, `w-${name}`), backend: "claude-code",
    ...(perInstance[name] ? { delivery_worker: perInstance[name] } : {}),
  }) as any;
  fm.fleetConfig = { defaults: { delivery_worker: mode }, instances: { a: cfg("a"), b: cfg("b"), sender: cfg("sender") } } as any;
  vi.spyOn(fm as any, "connectIpcToInstance").mockResolvedValue(undefined);
  vi.spyOn(fm, "notifyInstanceTopic").mockReturnValue(true);
  (fm as any).ensureDeliveryOutbox();
  const outbox = (fm as any).deliveryOutbox;
  await fm.startInstance("a", cfg("a"), false);
  await fm.startInstance("b", cfg("b"), false);
  fm.lifecycle.daemons.set("sender", { bootId: "sb", isPaused: false, getProcessStatus: () => "stopped" } as any);

  /** Per target, the next scripts for its hand-offs (default: complete). */
  const scripts = new Map<string, Script[]>();
  /** For "gated": the hand-off returns only when the test releases this. */
  const handoffGate = { promise: Promise.resolve(), release: () => {} };
  const handoffs: Array<{ target: string; deliveryId: string; attempt: number; inFlightAtHandoff: number }> = [];
  let violations = 0;
  const inFlight = (t: string) => outbox.countForTarget(t, ["delivering", "submission_started"]);
  vi.spyOn(fm, "deliverToInstance").mockImplementation(async (target: string, payload: any) => {
    const deliveryId = payload.meta?.delivery_id ?? payload.delivery_id;
    const attempt = Number(payload.meta?.delivery_attempt ?? payload.delivery_attempt);
    const n = inFlight(target);
    if (n !== 1) violations++;
    // The claim must carry this target's own daemon generation.
    if (outbox.get(deliveryId)?.targetDaemonBootId !== (fm.lifecycle.daemons.get(target) as any)?.bootId) violations++;
    handoffs.push({ target, deliveryId, attempt, inFlightAtHandoff: n });
    const script = scripts.get(target)?.shift() ?? "complete";
    if (script === "notSent") return false;
    const row = outbox.get(deliveryId);
    outbox.begin(deliveryId, row.targetDaemonBootId, attempt);
    if (script === "throwAfterBegin") throw new Error("IPC socket closed");
    if (script === "complete") {
      const handle = setTimeout(() => {
        pendingCompleteTimers.delete(handle);
        outbox.complete(deliveryId, row.targetDaemonBootId, attempt, "delivered");
      }, 5);
      pendingCompleteTimers.add(handle);
    }
    if (script === "gated") await handoffGate.promise;
    return true;
  });
  const admit = (target: string) => {
    const r = fm.admitDurableDelivery({
      operationId: `op-${++opSeq}`, sourceInstance: "sender", targetInstance: target, kind: "fleet_inbound",
      correlationId: `c-${opSeq}`, payload: { type: "fleet_inbound", content: `m${opSeq}`, meta: {} },
    });
    return r.deliveryId as string;
  };
  const gateHandoff = () => { handoffGate.promise = new Promise<void>(r => { handoffGate.release = r; }); return handoffGate; };
  return { fm, outbox, admit, scripts, handoffs, violations: () => violations, inFlight, gateHandoff };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("ownership (design §1.5-A)", () => {
  it("on: a worker owns the target's lane and delivers in created_seq order; the pump never claims it", async () => {
    const { fm, outbox, admit, handoffs } = await fleet("on");
    const ids = [admit("a"), admit("a"), admit("a")];
    await vi.waitFor(() => expect(ids.map(id => outbox.get(id).state)).toEqual(["delivered", "delivered", "delivered"]));
    expect(fm.queueWorkers.has("a") || handoffs.length === 3).toBe(true);
    expect(handoffs.map(h => h.deliveryId)).toEqual(ids);
    expect(handoffs.every(h => h.attempt === 1)).toBe(true);
  });

  it("canary: only the instance set to on gets a worker; others stay with the pump", async () => {
    const { fm, admit, scripts } = await fleet("wake_only", { a: "on" });
    scripts.set("a", ["hold"]); scripts.set("b", ["hold"]);
    admit("a"); admit("b");
    await vi.waitFor(() => expect(fm.queueWorkers.has("a")).toBe(true));
    expect(fm.queueWorkers.has("b")).toBe(false);
  });

  it("off and wake_only create no worker at all", async () => {
    for (const mode of ["off", "wake_only"] as const) {
      const { fm, outbox, admit } = await fleet(mode);
      const id = admit("a");
      await vi.waitFor(() => expect(outbox.get(id).state).toBe("delivered"));
      expect(fm.queueWorkers.size).toBe(0);
    }
  });
});

describe("one claimer, one in-flight row per target (2c ①)", () => {
  it("stress: rows to two targets while the flag flips between on and wake_only — never two in flight on a target", async () => {
    const { fm, outbox, admit, violations, inFlight } = await fleet("on");
    const ids: string[] = [];
    let maxSeen = 0;
    const sampler = setInterval(() => {
      maxSeen = Math.max(maxSeen, inFlight("a"), inFlight("b"));
    }, 1);
    for (let i = 0; i < 30; i++) {
      ids.push(admit(i % 2 ? "a" : "b"));
      if (i % 5 === 0) (fm.fleetConfig as any).defaults.delivery_worker = i % 10 === 0 ? "wake_only" : "on";
      (fm as any).scheduleDeliveryOutboxPump();
      await sleep(2);
    }
    (fm.fleetConfig as any).defaults.delivery_worker = "on";
    (fm as any).scheduleDeliveryOutboxPump();
    await vi.waitFor(() => expect(ids.every(id => outbox.get(id).state === "delivered")).toBe(true), { timeout: 10_000 });
    clearInterval(sampler);
    expect(violations()).toBe(0);
    expect(maxSeen).toBeLessThanOrEqual(1);
  });
});

describe("flag changes take effect only once the lane drains (2c ②)", () => {
  it("on → wake_only while the worker holds a row: the pump does not claim the next one until that row is done", async () => {
    const { fm, outbox, admit, scripts, handoffs } = await fleet("on");
    scripts.set("a", ["hold"]);
    const first = admit("a");
    await vi.waitFor(() => expect(outbox.get(first).state).toBe("submission_started"));
    (fm.fleetConfig as any).defaults.delivery_worker = "wake_only";
    const second = admit("a");
    (fm as any).scheduleDeliveryOutboxPump();
    await sleep(50);
    expect(fm.queueWorkers.has("a")).toBe(true); // still the owner: its lane is not empty
    expect(outbox.get(second).state).toBe("queued");
    const row = outbox.get(first);
    outbox.complete(first, row.targetDaemonBootId, row.attemptNo, "delivered");
    await vi.waitFor(() => expect(outbox.get(second).state).toBe("delivered"));
    expect(fm.queueWorkers.has("a")).toBe(false); // handed back, and the pump delivered the next row
    expect(handoffs.map(h => h.deliveryId)).toEqual([first, second]);
  });

  it("wake_only → on while the pump holds a row: no worker until the pump's row is done", async () => {
    const { fm, outbox, admit, scripts } = await fleet("wake_only");
    const grant = vi.spyOn(fm as any, "createQueueWorker");
    scripts.set("a", ["hold"]);
    const first = admit("a");
    await vi.waitFor(() => expect(outbox.get(first).state).toBe("submission_started"));
    (fm.fleetConfig as any).defaults.delivery_worker = "on";
    const second = admit("a");
    (fm as any).scheduleDeliveryOutboxPump();
    await sleep(50);
    expect(grant).not.toHaveBeenCalled(); // the pump's lane is not empty
    expect(outbox.get(second).state).toBe("queued");
    const row = outbox.get(first);
    outbox.complete(first, row.targetDaemonBootId, row.attemptNo, "delivered");
    await vi.waitFor(() => expect(outbox.get(second).state).toBe("delivered"));
    // granted only after the pump's row was done, and the worker delivered the next row
    expect(grant).toHaveBeenCalledWith("a");
  });
});

describe("an old attempt's ACK never changes a new attempt (2c ③)", () => {
  it("attempt 1 begun, its generation recovered, attempt 2 claimed: attempt 1's complete is refused", async () => {
    const { fm, outbox, admit, scripts, handoffs } = await fleet("on");
    scripts.set("a", ["hold", "hold"]);
    const id = admit("a");
    await vi.waitFor(() => expect(outbox.get(id).state).toBe("submission_started"));
    const oldBoot = outbox.get(id).targetDaemonBootId;
    // The daemon generation ends (restart): the submission needs reconciliation,
    // which here finds it was never submitted and schedules a retry.
    const daemon = fm.lifecycle.daemons.get("a") as any;
    daemon.bootId = "boot-new";
    outbox.recoverTargetGeneration("a", "boot-new");
    expect(outbox.get(id).state).toBe("reconciliation_pending");
    expect(outbox.reconcileAttempt(id, oldBoot, 1, "retry_wait", "pane shows the text was never submitted")).toBe(true);
    (fm as any).scheduleDeliveryOutboxPump();
    await vi.waitFor(() => expect(handoffs.filter(h => h.deliveryId === id)).toHaveLength(2), { timeout: 9_000 });
    expect(outbox.get(id).attemptNo).toBe(2);
    expect(outbox.complete(id, oldBoot, 1, "delivered")).toBe(false);
    expect(outbox.get(id).state).not.toBe("delivered");
  });
});

describe("a transport error after begin holds the lane (2c ④ ⑥, design §1.5-B)", () => {
  it("on: begin, then the IPC fails, then a second row: it is not claimed past the unfinished writer", async () => {
    const { fm, outbox, admit, scripts, handoffs } = await fleet("on");
    scripts.set("a", ["throwAfterBegin"]);
    const first = admit("a");
    await vi.waitFor(() => expect(handoffs).toHaveLength(1));
    await sleep(20);
    expect(outbox.get(first).state).toBe("submission_started"); // not terminalized to uncertain
    const second = admit("a");
    (fm as any).scheduleDeliveryOutboxPump();
    fm.wakeCoordinator!.scan();
    await sleep(50);
    expect(outbox.get(second).state).toBe("queued"); // ④/⑥: does not pass the writer, whatever timers fire
    expect(handoffs).toHaveLength(1);
    // The daemon's own verdict arrives: the lane is released and the next row goes.
    const row = outbox.get(first);
    outbox.complete(first, row.targetDaemonBootId, row.attemptNo, "uncertain");
    await vi.waitFor(() => expect(outbox.get(second).state).toBe("delivered"));
  });

  it("on: the writer's generation ending is not enough — the lane is released by reconciliation's verdict", async () => {
    const { fm, outbox, admit, scripts, handoffs } = await fleet("on");
    scripts.set("a", ["throwAfterBegin"]);
    const first = admit("a");
    await vi.waitFor(() => expect(handoffs).toHaveLength(1));
    const oldBoot = outbox.get(first).targetDaemonBootId;
    const second = admit("a");
    (fm.lifecycle.daemons.get("a") as any).bootId = "boot-next";
    outbox.recoverTargetGeneration("a", "boot-next");
    (fm as any).scheduleDeliveryOutboxPump();
    await sleep(50);
    expect(outbox.get(first).state).toBe("reconciliation_pending");
    expect(outbox.get(second).state).toBe("queued"); // still held: the old composer is unresolved
    expect(outbox.reconcileAttempt(first, oldBoot, 1, "uncertain", "could not prove submission")).toBe(true);
    await vi.waitFor(() => expect(outbox.get(second).state).toBe("delivered"));
    expect(handoffs[1]!.deliveryId).toBe(second);
    expect(handoffs[1]!.inFlightAtHandoff).toBe(1);
  });

  it("off: unchanged — the pump records uncertain and moves on", async () => {
    const { outbox, admit, scripts } = await fleet("off");
    scripts.set("a", ["throwAfterBegin"]);
    const first = admit("a");
    await vi.waitFor(() => expect(outbox.get(first).state).toBe("uncertain"));
  });
});

describe("busy or held targets (2c ⑤)", () => {
  it("a dialog holding the CLI's input: the worker does not claim; once it clears, it does", async () => {
    const { fm, outbox, admit } = await fleet("on");
    (fm.lifecycle.daemons.get("a") as any).holdReason = "a dialog is holding its input";
    const id = admit("a");
    await sleep(50);
    expect(outbox.get(id)).toMatchObject({ state: "queued", attemptNo: 0 });
    (fm.lifecycle.daemons.get("a") as any).holdReason = null;
    (fm as any).scheduleDeliveryOutboxPump();
    await vi.waitFor(() => expect(outbox.get(id).state).toBe("delivered"));
  });

  it("a busy (working) target is claimed and handed off through the idle gate, as before", async () => {
    const { fm, admit } = await fleet("on");
    const deliver = fm.deliverToInstance as any;
    admit("a");
    await vi.waitFor(() => expect(deliver).toHaveBeenCalled());
    expect(deliver.mock.calls[0][2]).toMatchObject({ isCrossInstance: true, waitForIdle: true, noInlineWake: true });
  });
});

describe("the shared active-delivery budget", () => {
  it("a worker's in-flight lane counts against the pump's budget and is returned after", async () => {
    const { fm, outbox, admit, scripts } = await fleet("on");
    scripts.set("a", ["hold"]);
    const id = admit("a");
    await vi.waitFor(() => expect(outbox.get(id).state).toBe("submission_started"));
    expect((fm as any).activeDurableTargets.has("a")).toBe(true);
    const row = outbox.get(id);
    outbox.complete(id, row.targetDaemonBootId, row.attemptNo, "delivered");
    await vi.waitFor(() => expect((fm as any).activeDurableTargets.has("a")).toBe(false));
  });
});


describe("the pump skips a worker-owned lane even while the worker is idle", () => {
  it("an owner that has not drained yet: the pump still leaves its row alone", async () => {
    const drain = vi.spyOn(TargetQueueWorker.prototype, "drain").mockResolvedValue(undefined);
    const { fm, outbox, admit } = await fleet("on");
    const id = admit("a");
    await sleep(50);
    expect(fm.queueWorkers.has("a")).toBe(true);
    expect(outbox.get(id)).toMatchObject({ state: "queued", attemptNo: 0 });
    drain.mockRestore();
    (fm as any).scheduleDeliveryOutboxPump();
    await vi.waitFor(() => expect(outbox.get(id).state).toBe("delivered"));
  });
});

describe("the worker respects the shared budget of 8 active lanes", () => {
  it("budget full: no claim; a freed slot lets it claim", async () => {
    const { fm, outbox, admit } = await fleet("on");
    const active: Set<string> = (fm as any).activeDurableTargets;
    for (let i = 0; i < 8; i++) active.add(`busy-${i}`);
    const id = admit("a");
    await sleep(50);
    expect(outbox.get(id)).toMatchObject({ state: "queued", attemptNo: 0 });
    active.delete("busy-0");
    (fm as any).scheduleDeliveryOutboxPump();
    await vi.waitFor(() => expect(outbox.get(id).state).toBe("delivered"));
  });
});

describe("a worker claims only its own target's rows", () => {
  it("an older row of another (held) target is never claimed by this target's worker", async () => {
    const { fm, outbox, admit, violations, handoffs } = await fleet("wake_only", { a: "on" });
    (fm.lifecycle.daemons.get("b") as any).holdReason = "a dialog is holding its input";
    const bRow = admit("b"); // older, its target is not accepting
    const aRow = admit("a");
    await vi.waitFor(() => expect(outbox.get(aRow).state).toBe("delivered"));
    await sleep(30);
    expect(outbox.get(bRow)).toMatchObject({ state: "queued", attemptNo: 0 });
    expect(handoffs.map(h => h.target)).toEqual(["a"]);
    expect(violations()).toBe(0);
  });
});

describe("a worker never touches a closed outbox", () => {
  it("after the outbox closes, a drain claims nothing and logs no failure", async () => {
    const { fm, outbox, admit, scripts } = await fleet("on");
    scripts.set("a", ["hold"]);
    const first = admit("a");
    await vi.waitFor(() => expect(outbox.get(first).state).toBe("submission_started"));
    const daemon = fm.lifecycle.daemons.get("a") as any;
    daemon.holdReason = "a dialog"; // the next row will wait, keeping the worker as owner but idle
    admit("a");
    const worker = fm.queueWorkers.get("a")!;
    const row = outbox.get(first);
    outbox.complete(first, row.targetDaemonBootId, row.attemptNo, "delivered");
    await vi.waitFor(() => expect(worker.busy).toBe(false));
    expect(fm.queueWorkers.get("a")).toBe(worker);
    const claim = vi.spyOn(outbox, "claimNext");
    const warn = vi.spyOn((fm as any).logger, "warn");
    fm.wakeCoordinator!.stop();
    outbox.close();
    daemon.holdReason = null; // nothing but the closed outbox stops it now
    await worker.drain();
    expect(claim).not.toHaveBeenCalled();
    expect(warn.mock.calls.some(c => String(c[1]).includes("Queue worker drain failed"))).toBe(false);
  });
});


describe("rollback hands the lane back after the claimed row (#1079 review P1-1)", () => {
  for (const back of ["wake_only", "off"] as const) {
    it(`on → ${back}: the next row is claimed by the pump, with the pump's semantics`, async () => {
      const { fm, outbox, admit, scripts } = await fleet("on");
      const dispatch = vi.spyOn(fm as any, "dispatchDurableDelivery");
      scripts.set("a", ["hold"]);
      const first = admit("a");
      await vi.waitFor(() => expect(outbox.get(first).state).toBe("submission_started"));
      (fm.fleetConfig as any).defaults.delivery_worker = back;
      const second = admit("a");
      (fm as any).scheduleDeliveryOutboxPump();
      await sleep(30);
      expect(outbox.get(second).state).toBe("queued");
      const row = outbox.get(first);
      outbox.complete(first, row.targetDaemonBootId, row.attemptNo, "delivered");
      await vi.waitFor(() => expect(outbox.get(second).state).toBe("delivered"));
      const byRow = new Map(dispatch.mock.calls.map(c => [(c[0] as any).deliveryId, c[1]]));
      expect(byRow.get(first)).toEqual({ holdLaneOnTransportError: true }); // the worker's row
      expect(byRow.get(second)).toBeUndefined(); // the pump's dispatch: no lane-hold option
      expect(fm.queueWorkers.has("a")).toBe(false);
    });
  }

  it("continuous admissions cannot keep a switched-back worker as owner", async () => {
    const { fm, outbox, admit, scripts } = await fleet("on");
    scripts.set("a", ["hold"]);
    const first = admit("a");
    await vi.waitFor(() => expect(outbox.get(first).state).toBe("submission_started"));
    (fm.fleetConfig as any).defaults.delivery_worker = "wake_only";
    const later = [admit("a"), admit("a"), admit("a")];
    const row = outbox.get(first);
    outbox.complete(first, row.targetDaemonBootId, row.attemptNo, "delivered");
    await vi.waitFor(() => expect(later.every(id => outbox.get(id).state === "delivered")).toBe(true));
    expect(fm.queueWorkers.has("a")).toBe(false);
  });
});

describe("an unexpired retry does not spin the claim loop (#1079 review P1-2)", () => {
  it("a row in retry_wait for ~1 s: only a handful of claim attempts, and it is retried when due", async () => {
    const { outbox, admit, scripts, handoffs } = await fleet("on");
    scripts.set("a", ["notSent"]); // first hand-off refused → retry_wait (1 s)
    const claim = vi.spyOn(outbox, "claimNext");
    const id = admit("a");
    await vi.waitFor(() => expect(outbox.get(id).state).toBe("retry_wait"));
    const before = claim.mock.calls.length;
    await sleep(300);
    expect(claim.mock.calls.length - before).toBeLessThanOrEqual(3);
    await vi.waitFor(() => expect(outbox.get(id).state).toBe("delivered"), { timeout: 4_000 });
    expect(handoffs.filter(h => h.deliveryId === id)).toHaveLength(2);
  });
});

describe("a transient claim error does not leak the budget (#1079 review P2-3)", () => {
  it("claimNext throws SQLITE_BUSY once: the budget is returned and delivery recovers", async () => {
    const { fm, outbox, admit } = await fleet("on");
    const real = outbox.claimNext.bind(outbox);
    let fail = true;
    vi.spyOn(outbox, "claimNext").mockImplementation((...args: any[]) => {
      if (fail) { fail = false; throw new Error("SQLITE_BUSY: database is locked"); }
      return real(...args);
    });
    const id = admit("a");
    await sleep(30);
    expect((fm as any).activeDurableTargets.has("a")).toBe(false);
    (fm as any).scheduleDeliveryOutboxPump();
    await vi.waitFor(() => expect(outbox.get(id).state).toBe("delivered"));
  });
});


describe("the pump is told once the claimed hand-off has settled (#1079 review r2)", () => {
  for (const back of ["off", "wake_only"] as const) {
    it(`the row completes before its hand-off returns, then on → ${back}: the idle owner is released and the next row delivered`, async () => {
      const { fm, outbox, admit, scripts, gateHandoff } = await fleet("on");
      scripts.set("a", ["gated"]);
      const gate = gateHandoff();
      const first = admit("a");
      await vi.waitFor(() => expect(outbox.get(first).state).toBe("submission_started"));
      (fm.fleetConfig as any).defaults.delivery_worker = back;
      const second = admit("a");
      const row = outbox.get(first);
      outbox.complete(first, row.targetDaemonBootId, row.attemptNo, "delivered"); // state event first…
      await sleep(30); // …its pump pass runs while the worker is still busy
      expect(fm.queueWorkers.has("a")).toBe(true);
      gate.release(); // …then the hand-off returns
      await vi.waitFor(() => expect(outbox.get(second).state).toBe("delivered"));
      expect(fm.queueWorkers.has("a")).toBe(false);
    });
  }
});


describe("event order on the real delivery path (#1079 review r2, production variant)", () => {
  it("handoff waiting in the real idle gate, off, generation requeue, then the user cancels: the pump takes over (FIFO kept)", async () => {
    const { fm, outbox, admit } = await fleet("on");
    (fm.deliverToInstance as any).mockRestore(); // the real facade: idle gate, epochs, IPC wait
    const dispatch = vi.spyOn(fm as any, "dispatchDurableDelivery");
    (fm as any).instanceStateCache.set("a", { state: "working", observedAt: Date.now() }); // the gate waits
    const first = admit("a");
    await vi.waitFor(() => expect(outbox.get(first).state).toBe("delivering"));
    const worker = fm.queueWorkers.get("a")!;
    (fm.fleetConfig as any).defaults.delivery_worker = "off";
    const second = admit("a");
    // The daemon generation changes: the claimed row is requeued and an outbox event fires
    (fm.lifecycle.daemons.get("a") as any).bootId = "boot-regen";
    outbox.recoverTargetGeneration("a", "boot-regen");
    await sleep(30); // that event's pump pass sees the worker busy and keeps it
    expect(fm.queueWorkers.get("a")).toBe(worker);
    // The user cancels: the old hand-off ends (epoch moved), the dispatch settles
    expect(fm.cancelInstance("a")).toBe(true);
    await vi.waitFor(() => expect(fm.queueWorkers.has("a")).toBe(false));
    await vi.waitFor(() => expect(outbox.get(first).state).toBe("delivering")); // re-claimed by the pump
    expect(outbox.get(first).attemptNo).toBe(2);
    expect(outbox.get(second).state).toBe("queued"); // FIFO: behind the first
    const last = dispatch.mock.calls.at(-1)!;
    expect((last[0] as any).deliveryId).toBe(first);
    expect(last[1]).toBeUndefined(); // the pump's dispatch, not the worker's
  });
});
