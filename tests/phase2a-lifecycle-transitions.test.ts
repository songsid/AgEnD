/**
 * Phase 2a (design: docs/design/phase2-submit-contract.md §1.3, §3.2, §1.6),
 * lifecycle side: one transition at a time per instance, an epoch fence at the
 * publication point, restart of a paused instance as a wake (never a downgrade
 * to marker-only), and the work lease on warm-cap eviction.
 *
 * The Daemon is replaced by a controllable fake so a start can be held at the
 * exact point the real spawn cannot be cancelled (Daemon.start) and released
 * after a stop/restart has been requested.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  created: [] as any[],
  /** When set, the next Daemon.start() waits on this. */
  hold: null as null | Promise<void>,
  failNextStart: null as null | Error,
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
    seeded = false;
    pauseReasons: string[] = [];
    leaseCheck: (() => boolean) | null = null;
    constructor(public name: string) { super(); fake.created.push(this); }
    setDeliveryOutboxPort() {}
    setPeerWorkingDirectories() {}
    setStatusEmojiAvoidList() {}
    setWorkLeaseCheck(check: () => boolean) { this.leaseCheck = check; }
    seedActivityNow() { this.seeded = true; }
    requestPauseWhenIdle() {}
    async start() {
      const hold = fake.hold;
      fake.hold = null;
      if (hold) await hold;
      if (fake.failNextStart) { const err = fake.failNextStart; fake.failNextStart = null; throw err; }
      this.started = true;
    }
    async abortStartup() { this.aborted = true; }
    async stop() { this.stopped = true; }
    async pause(reason: string) { this.pauseReasons.push(reason); this.isPaused = true; }
    wakes = 0;
    async wake() { this.wakes++; this.isPaused = false; }
    get lastPausedAt() { return this.isPaused ? 1_234 : null; }
    getProcessStatus() { return "running"; }
  }
  return { ...original, Daemon: FakeDaemon };
});

import { FleetManager } from "../src/fleet-manager.js";
import { SupersededStartError, PRECLAIM_LEASE_MS } from "../src/instance-lifecycle.js";
import { hasPausedMarker, readPauseReason, readPausedAt, writePausedMarker } from "../src/pause-marker.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  fake.created.length = 0;
  fake.hold = null;
  fake.failNextStart = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fleet() {
  const dataDir = join(tmpdir(), `agend-2a-lc-${process.pid}-${Date.now()}-${dirs.length}`);
  mkdirSync(dataDir, { recursive: true });
  dirs.push(dataDir);
  const fm = new FleetManager(dataDir);
  const config = { working_directory: join(dataDir, "work"), backend: "claude-code" } as any;
  fm.fleetConfig = { defaults: {}, instances: { worker: config } } as any;
  // The IPC socket of a fake daemon never appears; the rest of startInstance is real.
  vi.spyOn(fm as any, "connectIpcToInstance").mockResolvedValue(undefined);
  // Track the number of published daemons at every registration.
  let maxPublished = 0;
  const set = fm.lifecycle.daemons.set.bind(fm.lifecycle.daemons);
  (fm.lifecycle.daemons as any).set = (k: string, v: any) => {
    const r = set(k, v);
    maxPublished = Math.max(maxPublished, [...fm.lifecycle.daemons.values()].filter((d: any) => !d.stopped).length);
    return r;
  };
  return { fm, config, dir: fm.getInstanceDir("worker"), maxPublished: () => maxPublished };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(r => { release = r; });
  return { promise, release };
}

describe("publication fence: a superseded start never registers (2a ⑤)", () => {
  it("a stop requested while the start is spawning: the start is disposed, not published", async () => {
    const { fm, config } = fleet();
    const gate = deferred();
    fake.hold = gate.promise;
    const starting = fm.lifecycle.start("worker", config, false);
    await vi.waitFor(() => expect(fake.created).toHaveLength(1));
    const stopping = fm.stopInstance("worker");
    gate.release();
    await expect(starting).rejects.toBeInstanceOf(SupersededStartError);
    await stopping;
    expect(fake.created[0].aborted).toBe(true);
    expect(fm.lifecycle.daemons.has("worker")).toBe(false);
  });

  it("a restart requested while a start is spawning: only the replacement is published, never both", async () => {
    const { fm, config, maxPublished } = fleet();
    const gate = deferred();
    fake.hold = gate.promise;
    const starting = fm.lifecycle.start("worker", config, false);
    await vi.waitFor(() => expect(fake.created).toHaveLength(1));
    const restarting = fm.restartSingleInstance("worker");
    gate.release();
    await expect(starting).rejects.toBeInstanceOf(SupersededStartError);
    await restarting;
    const [old, replacement] = fake.created;
    expect(old.aborted).toBe(true);
    expect(replacement.started).toBe(true);
    expect(fm.lifecycle.daemons.get("worker")).toBe(replacement);
    expect(maxPublished()).toBe(1);
  });

  it("an unrelated start (no stop/restart in between) still publishes", async () => {
    const { fm, config } = fleet();
    await fm.lifecycle.start("worker", config, false);
    expect(fm.lifecycle.daemons.get("worker")).toBe(fake.created[0]);
    expect(fake.created[0].aborted).toBe(false);
  });
});

describe("restart of a paused instance is a wake, never a downgrade (2a ③)", () => {
  it("a resident paused instance comes back running with no marker left", async () => {
    const { fm, config, dir } = fleet();
    await fm.startInstance("worker", config, false);
    await fm.lifecycle.pause("worker");
    writePausedMarker(dir, 1_234, "idle"); // what the real Daemon.pause writes
    expect(fm.lifecycle.isPaused("worker")).toBe(true);

    await fm.restartSingleInstance("worker");

    expect(fake.created).toHaveLength(2);
    expect(fm.lifecycle.daemons.get("worker")).toBe(fake.created[1]);
    expect(hasPausedMarker(dir)).toBe(false);
    expect(fm.getInstanceStatus("worker")).toBe("running");
    expect(fake.created[1].seeded).toBe(true);
  });

  it("a marker-only paused instance is started by restart (it used to be skipped)", async () => {
    const { fm, dir } = fleet();
    writePausedMarker(dir, 5_000, "idle");
    await fm.restartSingleInstance("worker");
    expect(fm.lifecycle.daemons.has("worker")).toBe(true);
    expect(hasPausedMarker(dir)).toBe(false);
  });

  it("if the restart's start fails, the pause marker (time and reason) is put back so it stays wakeable", async () => {
    const { fm, dir } = fleet();
    writePausedMarker(dir, 5_000, "auth");
    fake.failNextStart = new Error("spawn failed");
    await expect(fm.restartSingleInstance("worker")).rejects.toThrow("spawn failed");
    expect(fm.lifecycle.daemons.has("worker")).toBe(false);
    expect(hasPausedMarker(dir)).toBe(true);
    expect(readPausedAt(dir)).toBe(5_000);
    expect(readPauseReason(dir)).toBe("auth");
    // ...and the instance can still be woken afterwards.
    await fm.lifecycle.wake("worker");
    expect(fm.lifecycle.daemons.has("worker")).toBe(true);
    expect(hasPausedMarker(dir)).toBe(false);
  });

  it("a restart of a running (not paused) instance does not invent a marker on failure", async () => {
    const { fm, config, dir } = fleet();
    await fm.startInstance("worker", config, false);
    fake.failNextStart = new Error("spawn failed");
    await expect(fm.restartSingleInstance("worker")).rejects.toThrow("spawn failed");
    expect(hasPausedMarker(dir)).toBe(false);
  });
});

describe("wake vs stop/restart ordering (2a ④ ⑥)", () => {
  it("a marker-only wake still spawning when a stop arrives does not revive the instance", async () => {
    const { fm, dir } = fleet();
    writePausedMarker(dir, 7_000, "idle");
    const gate = deferred();
    fake.hold = gate.promise;
    const waking = fm.lifecycle.wake("worker");
    await vi.waitFor(() => expect(fake.created).toHaveLength(1));
    const stopping = fm.stopInstance("worker");
    gate.release();
    await expect(waking).rejects.toBeInstanceOf(SupersededStartError);
    await stopping;
    expect(fm.lifecycle.daemons.has("worker")).toBe(false);
    expect(fake.created[0].aborted).toBe(true);
    // It is still a paused instance (wakeable), not a running one.
    expect(hasPausedMarker(dir)).toBe(true);
  });

  it("an explicit wake during a restart joins that restart (one replacement, no second flight)", async () => {
    const { fm, dir } = fleet();
    writePausedMarker(dir, 7_000, "idle");
    const gate = deferred();
    fake.hold = gate.promise;
    const restarting = fm.restartSingleInstance("worker");
    await vi.waitFor(() => expect(fake.created).toHaveLength(1));
    const waking = fm.lifecycle.wake("worker");
    gate.release();
    await Promise.all([restarting, waking]);
    expect(fake.created).toHaveLength(1);
    expect(fm.lifecycle.daemons.get("worker")).toBe(fake.created[0]);
    // Joined, not queued behind it: no second wake transition ran afterwards.
    expect(fake.created[0].wakes).toBe(0);
  });

  it("concurrent wakes of a marker-only instance share one flight", async () => {
    const { fm, dir } = fleet();
    writePausedMarker(dir, 7_000, "idle");
    const gate = deferred();
    fake.hold = gate.promise;
    const a = fm.lifecycle.wake("worker");
    const b = fm.lifecycle.wake("worker");
    gate.release();
    await Promise.all([a, b]);
    expect(fake.created).toHaveLength(1);
    // The second caller shared the flight; it did not queue a resident wake after it.
    expect(fake.created[0].wakes).toBe(0);
  });
});

describe("a failed marker-only wake keeps the pause reason", () => {
  it("restores time and reason so the instance stays wakeable as what it was", async () => {
    const { fm, dir } = fleet();
    writePausedMarker(dir, 3_000, "auth");
    fake.failNextStart = new Error("spawn failed");
    await expect(fm.lifecycle.wake("worker")).rejects.toThrow("spawn failed");
    expect(readPausedAt(dir)).toBe(3_000);
    expect(readPauseReason(dir)).toBe("auth");
  });
});

describe("the activity seed (2a ②)", () => {
  it("a marker-only wake starts its daemon with a fresh idle window; a boot start does not", async () => {
    const { fm, config, dir } = fleet();
    await fm.startInstance("worker", config, false); // boot/reconcile path
    expect(fake.created[0].seeded).toBe(false);
    await fm.stopInstance("worker");
    writePausedMarker(dir, 9_000, "idle");
    await fm.lifecycle.wake("worker");
    expect(fake.created[1].seeded).toBe(true);
  });

  it("an explicit start (CLI/API) is seeded too", async () => {
    const { fm, config } = fleet();
    await fm.startInstance("worker", config, false, "fleet-topic", true);
    expect(fake.created[0].seeded).toBe(true);
  });
});

describe("pause reasons reach the marker writer", () => {
  it("operator pause by default, warm_cap from the warm cap, and the daemon's own reason on auto-pause", async () => {
    const { fm, config } = fleet();
    await fm.startInstance("worker", config, false);
    const daemon = fake.created[0];
    await fm.lifecycle.pause("worker");
    daemon.isPaused = false;
    await fm.lifecycle.pause("worker", "warm_cap");
    daemon.isPaused = false;
    daemon.emit("auto_pause_requested", { name: "worker", reason: "auth" });
    await vi.waitFor(() => expect(daemon.pauseReasons).toEqual(["operator", "warm_cap", "auth"]));
  });
});

describe("work lease (design §1.6)", () => {
  function withOutbox(fm: FleetManager, rows: Record<string, number>) {
    (fm as any).lifecycle.ctx.deliveryOutbox = {
      countForTarget: (_t: string, states: string[]) => states.reduce((n, s) => n + (rows[s] ?? 0), 0),
    };
  }

  it("held while a submission is in flight, with no time limit", () => {
    const { fm } = fleet();
    withOutbox(fm, { submission_started: 1 });
    expect(fm.lifecycle.hasWorkLease("worker", Date.now() + 24 * 60 * 60_000)).toBe(true);
  });

  it("pre-claim: held for PRECLAIM_LEASE_MS after a wake while work is queued, then released", () => {
    const { fm } = fleet();
    withOutbox(fm, { queued: 1 });
    expect(fm.lifecycle.hasWorkLease("worker")).toBe(false); // never woken for work
    const now = Date.now();
    fm.lifecycle.noteWokeForWork("worker", now);
    expect(fm.lifecycle.hasWorkLease("worker", now + PRECLAIM_LEASE_MS - 1)).toBe(true);
    expect(fm.lifecycle.hasWorkLease("worker", now + PRECLAIM_LEASE_MS)).toBe(false);
  });

  it("pre-claim: no queued work, no lease", () => {
    const { fm } = fleet();
    withOutbox(fm, {});
    fm.lifecycle.noteWokeForWork("worker");
    expect(fm.lifecycle.hasWorkLease("worker")).toBe(false);
  });

  it("a stop ends the pre-claim window", async () => {
    const { fm, config } = fleet();
    await fm.startInstance("worker", config, false);
    fm.lifecycle.noteWokeForWork("worker");
    await fm.stopInstance("worker");
    withOutbox(fm, { queued: 1 }); // installed after the stop: the real stop path needs the full outbox API
    expect(fm.lifecycle.hasWorkLease("worker")).toBe(false);
  });

  it("the daemon is handed the lease check", async () => {
    const { fm, config } = fleet();
    await fm.startInstance("worker", config, false);
    withOutbox(fm, { delivering: 1 });
    expect(fake.created[0].leaseCheck?.()).toBe(true);
  });

  it("warm-cap eviction skips a leased instance and evicts the unleased one", async () => {
    const { fm } = fleet();
    fm.fleetConfig = {
      defaults: { warm_cap: 1 },
      instances: { a: { working_directory: "/tmp/a" }, b: { working_directory: "/tmp/b" } },
    } as any;
    for (const name of ["a", "b"]) {
      const d: any = new EventEmitter();
      d.isPaused = false;
      d.getProcessStatus = () => "running";
      fm.lifecycle.daemons.set(name, d);
      (fm as any).instanceStateCache.set(name, { state: "idle" });
    }
    vi.spyOn(fm.lifecycle, "hasWorkLease").mockImplementation((name: string) => name === "a");
    const pause = vi.spyOn(fm.lifecycle, "pause").mockResolvedValue(undefined);
    (fm as any).enforceWarmCap();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledWith("b", "warm_cap");
  });
});

describe("delivery_worker flag skeleton (2a: setting only)", async () => {
  const { resolveDeliveryWorkerMode } = await import("../src/types.js");
  const { validateFleetConfig } = await import("../src/config-validator.js");

  it("defaults to off; instance override beats the fleet default; junk is ignored", () => {
    expect(resolveDeliveryWorkerMode({}, "w")).toBe("off");
    expect(resolveDeliveryWorkerMode({ defaults: { delivery_worker: "wake_only" } }, "w")).toBe("wake_only");
    expect(resolveDeliveryWorkerMode({ defaults: { delivery_worker: "wake_only" }, instances: { w: { delivery_worker: "on" } } }, "w")).toBe("on");
    expect(resolveDeliveryWorkerMode({ defaults: { delivery_worker: "yes" } }, "w")).toBe("off");
  });

  it("the validator rejects an unknown mode at both levels", () => {
    const base = { channel: undefined, instances: { general: { working_directory: "/tmp/g", general_topic: true } } };
    const bad = validateFleetConfig({ ...base, defaults: { delivery_worker: "always" },
      instances: { ...base.instances, w: { working_directory: "/tmp/w", delivery_worker: 1 } } });
    const paths = bad.errors.map(e => e.path);
    expect(paths).toContain("defaults.delivery_worker");
    expect(paths).toContain("instances.w.delivery_worker");
    const good = validateFleetConfig({ ...base, defaults: { delivery_worker: "off" } });
    expect(good.errors.map(e => e.path)).not.toContain("defaults.delivery_worker");
  });
});

describe("a superseded unattended start is not retried behind the operator", () => {
  it("a boot/reconcile start stopped mid-spawn schedules no startup retry", async () => {
    const { fm, config } = fleet();
    const retry = vi.spyOn(fm, "scheduleStartupRetry").mockImplementation(() => {});
    const gate = deferred();
    fake.hold = gate.promise;
    const starting = (fm as any).startInstanceUnattended("worker", config, false, "instance");
    await vi.waitFor(() => expect(fake.created).toHaveLength(1));
    const stopping = fm.stopInstance("worker");
    gate.release();
    expect(await starting).toBe(false);
    await stopping;
    expect(retry).not.toHaveBeenCalled();
    expect(fm.lifecycle.daemons.has("worker")).toBe(false);
  });

  it("an ordinary start failure still schedules the retry", async () => {
    const { fm, config } = fleet();
    const retry = vi.spyOn(fm, "scheduleStartupRetry").mockImplementation(() => {});
    fake.failNextStart = new Error("spawn failed");
    expect(await (fm as any).startInstanceUnattended("worker", config, false, "instance")).toBe(false);
    expect(retry).toHaveBeenCalledWith("worker", 0);
  });
});
