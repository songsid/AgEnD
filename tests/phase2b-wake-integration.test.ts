/**
 * Phase 2b end to end inside one FleetManager: a real SQLite outbox, the real
 * pump and wake coordinator, and a controllable fake Daemon (as in the 2a
 * tests). The live failure this fixes — Bug1, cid-1790837458171-wd3jvm: a
 * cross-instance message to a marker-only paused instance (paused across a
 * fleet restart) stayed queued at attempt 0 forever, because the pump never
 * claims a target without a daemon and the only wake ran after a claim.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  created: [] as any[],
  hold: null as null | Promise<void>,
  failStarts: 0,
}));

vi.mock("../src/daemon.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/daemon.js")>();
  const { EventEmitter: Emitter } = await import("node:events");
  class FakeDaemon extends Emitter {
    static seq = 0;
    readonly bootId = `boot-${++FakeDaemon.seq}`;
    isPaused = false;
    started = false;
    aborted = false;
    stopped = false;
    wakes = 0;
    pauses: string[] = [];
    constructor(public name: string) { super(); fake.created.push(this); }
    setDeliveryOutboxPort() {}
    setPeerWorkingDirectories() {}
    setStatusEmojiAvoidList() {}
    setWorkLeaseCheck() {}
    seedActivityNow() {}
    requestPauseWhenIdle() {}
    clearSuspectedAuthFailure() {}
    notAcceptingReason() { return null; }
    fenceDeliveryWritesForStop() {}
    async waitForDeliveryWritesToDrain() { return true; }
    async start() {
      const hold = fake.hold; fake.hold = null;
      if (hold) await hold;
      if (fake.failStarts > 0) { fake.failStarts--; throw new Error("spawn failed"); }
      this.started = true;
    }
    async abortStartup() { this.aborted = true; }
    async stop() { this.stopped = true; }
    async pause(reason: string) { this.pauses.push(reason); this.isPaused = true; }
    async wake() { this.wakes++; this.isPaused = false; }
    get lastPausedAt() { return this.isPaused ? 1 : null; }
    getProcessStatus() { return "running"; }
  }
  return { ...original, Daemon: FakeDaemon };
});

import { FleetManager } from "../src/fleet-manager.js";
import { hasPausedMarker, writePausedMarker } from "../src/pause-marker.js";

const dirs: string[] = [];
const fleets: FleetManager[] = [];
afterEach(() => {
  for (const fm of fleets.splice(0)) {
    fm.wakeCoordinator?.stop();
    const timer = (fm as any).replyObligationTimer; if (timer) clearInterval(timer);
    const pump = (fm as any).deliveryPumpTimer; if (pump) clearTimeout(pump);
    (fm as any).shuttingDown = true;
    try { (fm as any).deliveryOutbox?.close(); } catch { /* closed */ }
  }
  vi.restoreAllMocks();
  fake.created.length = 0; fake.hold = null; fake.failStarts = 0;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let opSeq = 0;
function fleet(mode: "off" | "wake_only", defaults: Record<string, unknown> = {}) {
  const dataDir = join(tmpdir(), `agend-2b-${process.pid}-${Date.now()}-${dirs.length}`);
  mkdirSync(dataDir, { recursive: true });
  dirs.push(dataDir);
  const fm = new FleetManager(dataDir);
  fleets.push(fm);
  const config = (name: string) => ({ working_directory: join(dataDir, `work-${name}`), backend: "claude-code" }) as any;
  fm.fleetConfig = {
    defaults: { delivery_worker: mode, ...defaults },
    instances: { worker: config("worker"), sender: config("sender"), other: config("other") },
  } as any;
  vi.spyOn(fm as any, "connectIpcToInstance").mockResolvedValue(undefined);
  vi.spyOn(fm, "notifyInstanceTopic").mockReturnValue(true);
  // The pump's hand-off: record it; the row then sits in `delivering` as if the daemon took it.
  const delivered: Array<{ target: string; opts: any; paused: boolean }> = [];
  vi.spyOn(fm, "deliverToInstance").mockImplementation(async (target: string, _payload: any, opts: any = {}) => {
    delivered.push({ target, opts, paused: fm.lifecycle.isPaused(target) });
    return true;
  });
  (fm as any).ensureDeliveryOutbox();
  const outbox = (fm as any).deliveryOutbox;
  // Through the production admission (send_to_instance's path), which needs a
  // live source daemon generation; the source is not counted as warm.
  const admit = (target = "worker", kind = "fleet_inbound") => {
    if (!fm.lifecycle.daemons.has("sender")) {
      fm.lifecycle.daemons.set("sender", { bootId: "sb", isPaused: false, getProcessStatus: () => "stopped" } as any);
    }
    const receipt = fm.admitDurableDelivery({
      operationId: `op-${++opSeq}`, sourceInstance: "sender", targetInstance: target, kind,
      correlationId: `c-${opSeq}`, payload: { type: "fleet_inbound", content: "hi", meta: {} },
    });
    return outbox.get(receipt.deliveryId);
  };
  return { fm, outbox, admit, delivered, dir: fm.getInstanceDir("worker"), config };
}

describe("Bug1: a marker-only paused target is woken and its queued work delivered (2b ①)", () => {
  it("wake_only: woken once, then claimed by the pump (attempt 1)", async () => {
    const { fm, outbox, admit, delivered, dir } = fleet("wake_only");
    writePausedMarker(dir, 1_000, "idle");
    const row = admit();
    await vi.waitFor(() => expect(delivered.map(d => d.target)).toEqual(["worker"]));
    expect(fake.created).toHaveLength(1);
    expect(fm.lifecycle.daemons.has("worker")).toBe(true);
    expect(hasPausedMarker(dir)).toBe(false);
    expect(outbox.get(row.deliveryId).attemptNo).toBe(1);
    expect(delivered[0]!.opts.noInlineWake).toBe(true);
  });

  it("off: unchanged — the row stays queued at attempt 0 and nothing is woken (the old deadlock, kept for off)", async () => {
    const { fm, outbox, admit, delivered, dir } = fleet("off");
    writePausedMarker(dir, 1_000, "idle");
    const row = admit();
    fm.wakeCoordinator!.scan();
    await new Promise(r => setTimeout(r, 50));
    expect(delivered).toEqual([]);
    expect(fake.created).toHaveLength(0);
    expect(outbox.get(row.deliveryId)).toMatchObject({ state: "queued", attemptNo: 0 });
  });
});

describe("a resident paused target (2b ②)", () => {
  it("wake_only: the pump does not claim it while paused; the coordinator wakes it, then the pump claims", async () => {
    const { fm, outbox, admit, delivered, config } = fleet("wake_only");
    await fm.startInstance("worker", config("worker"), false);
    const daemon = fake.created[0];
    daemon.isPaused = true;
    const wake = vi.spyOn(fm.lifecycle, "wake");
    const row = admit();
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(delivered[0]!.paused).toBe(false); // claimed only once awake
    expect(daemon.wakes).toBe(1);
    expect(wake).toHaveBeenCalledWith("worker", 30_000, undefined, { source: "coordinator" });
    expect(outbox.get(row.deliveryId).attemptNo).toBe(1);
  });

  it("off: the pump claims the paused target as before and leaves the wake to delivery", async () => {
    const { fm, outbox, admit, delivered, config } = fleet("off");
    await fm.startInstance("worker", config("worker"), false);
    fake.created[0].isPaused = true;
    const row = admit();
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(fake.created[0].wakes).toBe(0); // no coordinator wake
    expect(delivered[0]!.paused).toBe(true); // claimed while paused, as before 2b
    expect(delivered[0]!.opts.noInlineWake).toBe(false);
    expect(outbox.get(row.deliveryId).attemptNo).toBe(1);
  });
});

describe("wake failure keeps the row unclaimed (2b ③)", () => {
  it("marker-only target whose start fails: row queued at attempt 0, marker kept, retried after backoff", async () => {
    const { fm, outbox, admit, delivered, dir } = fleet("wake_only");
    writePausedMarker(dir, 1_000, "idle");
    fake.failStarts = 1;
    const row = admit();
    await vi.waitFor(() => expect(fm.wakeCoordinator!.wakeFailure("worker")).toBe("spawn failed"));
    expect(outbox.get(row.deliveryId)).toMatchObject({ state: "queued", attemptNo: 0 });
    expect(hasPausedMarker(dir)).toBe(true);
    expect(delivered).toEqual([]);
    // the 1 s backoff passes; the second wake succeeds and the pump claims
    await vi.waitFor(() => expect(delivered).toHaveLength(1), { timeout: 4_000 });
    expect(outbox.get(row.deliveryId).attemptNo).toBe(1);
  });

  it("rows that expire while the target cannot be woken say so", async () => {
    const { fm, outbox, admit, dir } = fleet("wake_only");
    writePausedMarker(dir, 1_000, "idle");
    fake.failStarts = 100;
    const row = admit();
    await vi.waitFor(() => expect(fm.wakeCoordinator!.wakeFailure("worker")).toBe("spawn failed"));
    outbox.expireStale(Date.now() + 25 * 60 * 60_000, undefined, (t: string) => {
      const failure = fm.wakeCoordinator!.wakeFailure(t);
      return failure ? `target could not be woken (${failure})` : undefined;
    });
    expect(outbox.get(row.deliveryId).state).toBe("failed");
    expect(outbox.get(row.deliveryId).lastError).toContain("target could not be woken (spawn failed)");
  });
});

describe("concurrent wakes never produce two writers (2b ⑨)", () => {
  it("an operator wake and the coordinator's wake of a marker-only target share one spawn", async () => {
    const { fm, admit, dir } = fleet("wake_only");
    writePausedMarker(dir, 1_000, "idle");
    let release!: () => void;
    fake.hold = new Promise<void>(r => { release = r; });
    admit();
    await vi.waitFor(() => expect(fake.created).toHaveLength(1));
    const explicit = fm.changeInstancePauseState("worker", "wake");
    release();
    await explicit;
    expect(fake.created).toHaveLength(1);
    expect(fm.lifecycle.daemons.get("worker")).toBe(fake.created[0]);
  });
});

describe("explicit wake under the hard cap (design §1.6)", () => {
  it("off: an explicit wake is exactly the old wake", async () => {
    const { fm, dir } = fleet("off", { warm_cap: 1, warm_overflow: 0 });
    writePausedMarker(dir, 1_000, "idle");
    const wake = vi.spyOn(fm.lifecycle, "wake");
    await fm.explicitWake("worker");
    expect(wake).toHaveBeenCalledWith("worker", 30_000);
  });

  it("wake_only, cap full: pauses an unleased idle instance first, then wakes", async () => {
    const { fm, config, dir } = fleet("wake_only", { warm_cap: 1, warm_overflow: 0 });
    await fm.startInstance("other", config("other"), false);
    (fm as any).instanceStateCache.set("other", { state: "idle" });
    writePausedMarker(dir, 1_000, "idle");
    await fm.explicitWake("worker");
    expect(fake.created[0].pauses).toEqual(["warm_cap"]);
    expect(fm.lifecycle.daemons.has("worker")).toBe(true);
  });

  it("wake_only, cap full and nothing evictable: refuses instead of exceeding the cap", async () => {
    const { fm, config, dir } = fleet("wake_only", { warm_cap: 1, warm_overflow: 0 });
    await fm.startInstance("other", config("other"), false);
    (fm as any).instanceStateCache.set("other", { state: "working" });
    writePausedMarker(dir, 1_000, "idle");
    await expect(fm.explicitWake("worker")).rejects.toThrow(/No warm slot is free/);
    expect(fm.lifecycle.daemons.has("worker")).toBe(false);
  });

  it("an explicit wake clears the coordinator's park for that target", async () => {
    const { fm, dir } = fleet("wake_only");
    const coordinator = fm.wakeCoordinator!;
    (coordinator as any).state("worker").parkedUntil = Date.now() + 60 * 60_000;
    writePausedMarker(dir, 1_000, "idle");
    await fm.explicitWake("worker");
    expect(coordinator.isParked("worker")).toBe(false);
  });
});

describe("boot scan", () => {
  it("rows already queued for a marker-only target when the outbox opens are woken without a new admission", async () => {
    const { fm, admit, delivered, dir } = fleet("wake_only");
    fm.wakeCoordinator!.stop(); // simulate rows that predate this coordinator
    writePausedMarker(dir, 1_000, "idle");
    admit();
    await new Promise(r => setTimeout(r, 30));
    expect(delivered).toEqual([]);
    // a fresh coordinator (as at boot) scans at start
    fm.wakeCoordinator = (fm as any).createWakeCoordinator();
    fm.wakeCoordinator!.start();
    await vi.waitFor(() => expect(delivered.map(d => d.target)).toEqual(["worker"]));
  });
});

describe("durable dispatch never wakes a wake_only target inline", () => {
  it("a target paused after its row was claimed is handed back, not woken (idle-gated and direct paths)", async () => {
    const { fm, config } = fleet("wake_only");
    (fm.deliverToInstance as any).mockRestore();
    await fm.startInstance("worker", config("worker"), false);
    fake.created[0].isPaused = true;
    const wake = vi.spyOn(fm.lifecycle, "wake");
    expect(await fm.deliverToInstance("worker", { type: "fleet_inbound", meta: { from_instance: "sender" } }, { isCrossInstance: true, noInlineWake: true })).toBe(false);
    expect(await fm.deliverToInstance("worker", { type: "raw_paste", content: "x" }, { waitForIdle: false, noInlineWake: true })).toBe(false);
    expect(wake).not.toHaveBeenCalled();
    expect(fake.created[0].wakes).toBe(0);
  });
});

describe("which wakes lift a park", () => {
  it("a lifecycle wake from anywhere but the coordinator (e.g. a user's message) lifts it; the coordinator's own does not", async () => {
    const { fm, config } = fleet("wake_only");
    await fm.startInstance("worker", config("worker"), false);
    const coordinator = fm.wakeCoordinator!;
    const park = () => { (coordinator as any).state("worker").parkedUntil = Date.now() + 60 * 60_000; };
    park();
    fake.created[0].isPaused = true;
    await fm.lifecycle.wake("worker", 30_000, undefined, { source: "coordinator" });
    expect(coordinator.isParked("worker")).toBe(true);
    fake.created[0].isPaused = true;
    await fm.lifecycle.wake("worker", 30_000);
    expect(coordinator.isParked("worker")).toBe(false);
  });
});
