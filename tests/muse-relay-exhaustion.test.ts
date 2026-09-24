import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../src/daemon.js";
import { MuseBackend } from "../src/backend/muse.js";
import { MuseUsageRelay } from "../src/muse-usage-relay.js";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";

/**
 * Live-verified muse frames (see tests/muse-backend.test.ts): the input row
 * `❯` is on screen in BOTH, so only the busy pattern tells them apart — the
 * exact trap B1 fell into when the gate was transcript silence.
 */
const MUSE_WORKING = [
  "  Muse Code 1.3.0",
  "❯ Write a haiku about tmux. Nothing else.",
  "◇ Thinking (2s · esc to interrupt)",
  "────────────────────────────────────────────",
  "❯",
  "────────────────────────────────────────────",
  "  muse-spark-1.3-contributor · high · /t/c/scratchpad/muse-probe · Launch overrides",
].join("\n");
const MUSE_IDLE = [
  "  Muse Code 1.3.0",
  "❯ Write a haiku about tmux. Nothing else.",
  "◆ Panes split the dark screen",
  "  Sessions linger through the night",
  "  Detached, work survives",
  "────────────────────────────────────────────",
  "❯",
  "────────────────────────────────────────────",
  "  muse-spark-1.3-contributor · high · /t/c/scratchpad/muse-probe · Launch overrides",
].join("\n");

/**
 * #899 item 1: when the Muse usage relay's same-port recovery is exhausted,
 * the CLI must be moved back to a direct connection once idle (session
 * preserved via resume) — not left running against a dead relay port — and
 * the operator must be told on the instance topic.
 *
 * The daemon half below drives the real switchMuseToDirect with only its
 * surroundings stubbed (idle wait, spawn, relay stop); the lifecycle half
 * pins the topic notification behind the emitted event.
 */

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function makeDaemon(opts: { realBackend?: boolean; realIdleWait?: boolean; pane?: () => string | Promise<string> } = {}) {
  const instanceDir = mkdtempSync(join(tmpdir(), "agend-relay-exhaust-"));
  dirs.push(instanceDir);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const backend = opts.realBackend
    ? new MuseBackend(instanceDir)
    : { getReadyPattern: () => /❯/, binaryName: "muse", getSessionId: () => null } as any;
  const daemon = new Daemon("muse-one", {
    working_directory: "/tmp",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, instanceDir, false, backend as any,
    undefined, { child: () => logger } as any);
  const internals = daemon as unknown as {
    switchMuseToDirect(idleBudgetMs?: number, idlePollMs?: number): Promise<void>;
    waitForAuthoritativePaneIdle: (budgetMs?: number, pollMs?: number) => Promise<boolean>;
    trySpawn: (reuse: boolean, budgetMs?: number) => Promise<boolean>;
    killProcessTree: () => Promise<void>;
    beginSpawn(): void;
    endSpawn(): void;
    museUsageRelay: unknown;
    museRelayFallback: boolean;
    tmux: unknown;
    pauseWakeState: string;
  };
  // Fast, deterministic surroundings for the wiring tests; the authoritative
  // cases below run the real idle-wait against a real backend instead.
  if (!opts.realIdleWait) internals.waitForAuthoritativePaneIdle = vi.fn(async () => true);
  internals.trySpawn = vi.fn(async () => true);
  internals.killProcessTree = vi.fn(async () => {});
  internals.tmux = {
    killWindow: vi.fn(async () => {}),
    getWindowId: () => "@1",
    capturePane: async () => opts.pane?.() ?? MUSE_IDLE,
  };
  // A real relay: stop() genuinely clears the snapshot file (the M20 path),
  // and with no server it returns without touching the network.
  internals.museUsageRelay = new MuseUsageRelay({ instanceDir });
  return { daemon, internals, logger, instanceDir };
}

function seedSnapshot(instanceDir: string) {
  writeFileSync(join(instanceDir, "muse-usage.json"), JSON.stringify({
    observedAt: Date.now(),
    session: { usedPercent: 23, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
  }));
}

describe("relay exhaustion moves muse direct once idle", () => {
  it("emits, waits for idle, then respawns in place — never a bare kill", async () => {
    const { daemon, internals, instanceDir } = makeDaemon();
    seedSnapshot(instanceDir);
    const emitted: unknown[] = [];
    daemon.on("muse_relay_exhausted", payload => emitted.push(payload));

    await internals.switchMuseToDirect();

    expect(emitted).toEqual([{ name: "muse-one" }]);
    expect(internals.waitForAuthoritativePaneIdle).toHaveBeenCalledTimes(1);
    // Resume in the preserved window (reuse=true): the session survives via
    // the existing `resume <sid>` path, and the fallback flag keeps later
    // natural spawns direct too.
    expect(internals.trySpawn).toHaveBeenCalledWith(true, expect.any(Number));
    expect(internals.museRelayFallback).toBe(true);
    // M19: exhaustion must restart, never just kill the CLI and walk away.
    expect(internals.killProcessTree).not.toHaveBeenCalled();
    expect((internals.tmux as { killWindow: ReturnType<typeof vi.fn> }).killWindow).not.toHaveBeenCalled();
    // M20: the dead relay's last snapshot is cleared — usage reads
    // unavailable, not a stale list from a port nothing serves anymore.
    expect(existsSync(join(instanceDir, "muse-usage.json"))).toBe(false);
  });

  it("skips the respawn while paused but still emits and arms the fallback", async () => {
    const { daemon, internals } = makeDaemon();
    internals.pauseWakeState = "paused";
    const emitted: unknown[] = [];
    daemon.on("muse_relay_exhausted", payload => emitted.push(payload));

    await internals.switchMuseToDirect();

    expect(emitted).toEqual([{ name: "muse-one" }]);
    expect(internals.museRelayFallback).toBe(true);
    // Pause/wake owns the respawn; don't fight it mid-pause.
    expect(internals.waitForAuthoritativePaneIdle).not.toHaveBeenCalled();
    expect(internals.trySpawn).not.toHaveBeenCalled();
  });

  it("never respawns a working pane — busy frames veto even past the budget", async () => {
    // B1's core: the real backend patterns and the real idle gate decide,
    // with only the spawn itself stubbed. A transcript-silence gate would
    // have called trySpawn here; the busy pattern must veto it.
    const { daemon, internals, instanceDir } = makeDaemon({ realBackend: true, pane: () => MUSE_WORKING });
    seedSnapshot(instanceDir);
    const emitted: unknown[] = [];
    daemon.on("muse_relay_exhausted", payload => emitted.push(payload));

    await internals.switchMuseToDirect(800, 50);

    expect(emitted).toEqual([{ name: "muse-one" }]);
    expect(internals.museRelayFallback).toBe(true);
    expect(internals.trySpawn).not.toHaveBeenCalled();
    expect(internals.killProcessTree).not.toHaveBeenCalled();
  });

  it("respawns once the pane goes idle mid-wait", async () => {
    // Same real gate, but the turn ends while waiting: two busy polls, then
    // idle — the respawn must happen, still session-preserving.
    const frames = [MUSE_WORKING, MUSE_WORKING, MUSE_IDLE, MUSE_IDLE];
    const { internals } = makeDaemon({
      realBackend: true, realIdleWait: true, pane: () => frames.shift() ?? MUSE_IDLE,
    });

    await internals.switchMuseToDirect(5000, 50);

    expect(internals.trySpawn).toHaveBeenCalledWith(true, expect.any(Number));
  });

  it("aborts when the instance pauses during the final verification", async () => {
    // Exit 2: pause takes effect without bumping the generation, so the fence
    // alone cannot see it. The flip lands on the second capture — after the
    // outer guards, inside the pane-write exclusion — where the full guards
    // must catch it. Respawning a freshly paused pane strands its state.
    const made = makeDaemon({ realBackend: true, realIdleWait: true });
    let captures = 0;
    (made.internals as unknown as { tmux: unknown }).tmux = {
      killWindow: vi.fn(async () => {}),
      getWindowId: () => "@1",
      capturePane: async () => {
        if (++captures >= 2) made.internals.pauseWakeState = "paused";
        return MUSE_IDLE;
      },
    };

    await made.internals.switchMuseToDirect(5000, 50);

    expect(made.internals.trySpawn).not.toHaveBeenCalled();
    expect(made.internals.museRelayFallback).toBe(true);
  });

  it("aborts when another spawn wins the pane before the final claim (generation fence)", async () => {
    // B2's repro: a wake/restart completes while this recovery is in flight.
    // The bump lands on the second capture — after the post-wait check, inside
    // the pane-write exclusion — so only the in-lock fence can catch it. The
    // stale recovery must stand down instead of respawning the fresh process.
    const made = makeDaemon({ realBackend: true, realIdleWait: true });
    const internalsRef = made.internals;
    let captures = 0;
    (made.internals as unknown as { tmux: unknown }).tmux = {
      killWindow: vi.fn(async () => {}),
      getWindowId: () => "@1",
      capturePane: async () => {
        if (++captures >= 2) {
          internalsRef.beginSpawn();
          internalsRef.endSpawn();
        }
        return MUSE_IDLE;
      },
    };

    await made.internals.switchMuseToDirect(5000, 50);

    expect(made.internals.trySpawn).not.toHaveBeenCalled();
    expect(made.internals.museRelayFallback).toBe(true);
  });

  it("never throws when the direct resume fails — the fallback flag is the floor", async () => {
    const { internals } = makeDaemon();
    internals.trySpawn = vi.fn(async () => { throw new Error("tmux gone"); });

    await expect(internals.switchMuseToDirect()).resolves.toBeUndefined();

    expect(internals.museRelayFallback).toBe(true);
  });
});

function makeLifecycle() {
  const notifyInstanceTopic = vi.fn(() => true);
  const eventLogInsert = vi.fn();
  const ctx = {
    fleetConfig: { instances: { "muse-one": { backend: "muse" } }, defaults: {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    eventLog: { insert: eventLogInsert },
    isPlannedRestart: () => false,
    notifyInstanceTopic,
    webhookEmit() {},
    clearCancelButton() {},
    checkModelFailover() {},
    setTopicIcon() {},
    restartSingleInstance: vi.fn(async () => {}),
  } as unknown as LifecycleContext;
  const lifecycle = new InstanceLifecycle(ctx);
  const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle() {} });
  lifecycle.attachIncidentHandlers("muse-one", daemon as any);
  return { daemon, notifyInstanceTopic, eventLogInsert };
}

describe("lifecycle: muse_relay_exhausted notifies the instance topic", () => {
  it("posts where the operator is looking and records the event", () => {
    const { daemon, notifyInstanceTopic, eventLogInsert } = makeLifecycle();

    (daemon as unknown as EventEmitter).emit("muse_relay_exhausted", { name: "muse-one" });

    expect(eventLogInsert).toHaveBeenCalledWith("muse-one", "muse_relay_exhausted", {});
    expect(notifyInstanceTopic).toHaveBeenCalledWith("muse-one", expect.stringContaining("muse-one"));
  });
});
