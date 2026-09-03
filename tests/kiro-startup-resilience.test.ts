import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Daemon, BackendUnreachableStartupError } from "../src/daemon.js";
import { KiroBackend, KIRO_RESUME_STARTUP_BUDGET_MS } from "../src/backend/kiro.js";
import { BackendOutageTracker, BACKEND_OUTAGE_ACTIVE_MS } from "../src/backend-outage.js";
import { FleetManager } from "../src/fleet-manager.js";
import { InstanceLifecycle, type IncidentEventSource, type LifecycleContext } from "../src/instance-lifecycle.js";
import { setLocale } from "../src/locale.js";

/**
 * kiro startup resilience (2026-09-03 field incident): runtime.us-east-1.kiro.dev
 * timed out for hours. `--resume` sat blank past the 25s budget → the daemon
 * cleared the session (conversation lost) and started fresh → under the
 * post-update herd the fresh start missed too → "Failed to start instance" →
 * permanent `stopped` with no retry. Four fixes, one suite.
 */

const KIRO_COMPAT = {
  version: "kiro-cli 2.21.0", supportsRequireMcpStartup: true, supportsLegacyUi: true, supportsEffortFlag: true, source: "version" as const,
};
const OUTAGE_PANE = [
  "Picking up where we left off...",
  "Kiro is having trouble responding right now:",
  "   0: unhandled error",
  "   1: dispatch failure (timeout): request timed out: error sending request for url (https://runtime.us-east-1.kiro.dev/)",
  "Retrying in 10s...",
].join("\n");
const AUTH_PANE = "Kiro is having trouble responding right now:\n   0: unhandled error\n   2: dispatch failure (other): No token";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  setLocale("en");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const kiro = () => new KiroBackend(mkdtempSync(join(tmpdir(), "agend-kiro-be-")), KIRO_COMPAT);

// ─────────────────────────────────────────────────────────────────────────────
// #4 pattern
// ─────────────────────────────────────────────────────────────────────────────
describe("#4 kiro backend-unreachable error pattern", () => {
  const patterns = () => kiro().getErrorPatterns();
  const firstMatch = (pane: string) => patterns().find(p => p.pattern.test(pane));

  it("classifies the live outage text as a fleet-wide network error with the host in the message", () => {
    const ep = firstMatch(OUTAGE_PANE)!;
    expect(ep.type).toBe("network");
    expect(ep.fleetWide).toBe(true);
    expect(ep.action).toBe("notify");
    expect(ep.skipRecoveryWait).toBe(true);
    const m = OUTAGE_PANE.match(ep.pattern)!;
    // formatMessage receives the LAST match; the url alternative carries the host.
    const urlMatch = OUTAGE_PANE.match(/request timed out: error sending request for url \((https?:\/\/[^)\s]*kiro\.dev[^)\s]*)\)/i)!;
    expect(ep.formatMessage!(urlMatch)).toContain("runtime.us-east-1.kiro.dev");
    expect(ep.formatMessage!(m)).toContain("unreachable");
  });

  it("does not steal the auth line (`dispatch failure (other): No token`) from the auth pattern", () => {
    const ep = firstMatch(AUTH_PANE)!;
    expect(ep.type).toBe("auth_error");
    const network = patterns().find(p => p.type === "network")!;
    expect(network.pattern.test(AUTH_PANE)).toBe(false);
  });

  it("does not fire on an agent merely mentioning timeouts or kiro.dev", () => {
    const network = patterns().find(p => p.type === "network")!;
    expect(network.pattern.test("the request timed out, let me retry")).toBe(false);
    expect(network.pattern.test("docs live at https://kiro.dev/docs")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// outage tracker
// ─────────────────────────────────────────────────────────────────────────────
describe("BackendOutageTracker", () => {
  it("opens once, stays active while sightings keep coming, and ages out", () => {
    let now = 1_000_000;
    const tracker = new BackendOutageTracker(() => now);
    expect(tracker.record("kiro-cli", "a", "down").isNew).toBe(true);
    expect(tracker.record("kiro-cli", "b").isNew).toBe(false);
    expect(tracker.isActive("kiro-cli")).toBe(true);
    expect(tracker.isActive("claude-code")).toBe(false);
    expect([...tracker.active("kiro-cli")!.instances]).toEqual(["a", "b"]);
    now += BACKEND_OUTAGE_ACTIVE_MS - 1;
    expect(tracker.isActive("kiro-cli")).toBe(true);
    now += 2;
    expect(tracker.isActive("kiro-cli")).toBe(false);
    expect(tracker.record("kiro-cli", "a").isNew).toBe(true); // a new outage → notify again
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1 / #2 / #4 short-circuit — daemon spawn path
// ─────────────────────────────────────────────────────────────────────────────
interface SpawnHarness {
  daemon: any;
  dir: string;
  trySpawn: ReturnType<typeof vi.fn>;
  killed: number;
  pane: { text: string };
  outage: BackendOutageTracker;
}

function makeSpawnHarness(backend: unknown, opts: { startupTimeoutMs?: number; backendName?: string; outage?: BackendOutageTracker } = {}): SpawnHarness {
  const dir = mkdtempSync(join(tmpdir(), "agend-kiro-startup-"));
  dirs.push(dir);
  writeFileSync(join(dir, "session-id"), "sess-123");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const outage = opts.outage ?? new BackendOutageTracker();
  const daemon = new Daemon("kiro-a", {
    working_directory: "/tmp",
    backend: opts.backendName ?? "kiro-cli",
    startup_timeout_ms: opts.startupTimeoutMs,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, dir, false, backend as any, undefined, { child: () => logger } as any,
  { kind: "fleet-topic", backend: opts.backendName ?? "kiro-cli", model: "default" },
  undefined, undefined, outage) as any;
  const pane = { text: "" };
  const h: SpawnHarness = { daemon, dir, trySpawn: vi.fn(), killed: 0, pane, outage };
  daemon.trySpawn = h.trySpawn;
  daemon.killProcessTree = vi.fn(async () => { h.killed++; });
  daemon.beginSpawn = vi.fn();
  daemon.endSpawn = vi.fn();
  daemon.tmux = { killWindow: vi.fn(async () => {}), capturePane: vi.fn(async () => pane.text), getWindowId: () => "@1" };
  return h;
}

const sessionKept = (h: SpawnHarness) => existsSync(join(h.dir, "session-id"));
const budgets = (h: SpawnHarness) => h.trySpawn.mock.calls.map((c: any[]) => c[1]);

describe("#1 resume-aware startup budget", () => {
  it("gives kiro --resume the long budget and the fresh fallback the default one", async () => {
    const h = makeSpawnHarness(kiro());
    h.trySpawn.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await h.daemon.spawnClaudeWindow()).toBe(false);
    // resume, resume retry (#2), then fresh
    expect(budgets(h)).toEqual([KIRO_RESUME_STARTUP_BUDGET_MS, KIRO_RESUME_STARTUP_BUDGET_MS, undefined]);
  });

  it("never lowers a user-configured startup_timeout_ms", async () => {
    const h = makeSpawnHarness(kiro(), { startupTimeoutMs: 90_000 });
    h.trySpawn.mockResolvedValueOnce(true);
    await h.daemon.spawnClaudeWindow();
    expect(budgets(h)).toEqual([90_000]);
  });

  it("leaves backends without the capability on the default budget and the old two-attempt path", async () => {
    const plain = { binaryName: "claude", getReadyPattern: () => /❯/, getErrorPatterns: () => [] };
    const h = makeSpawnHarness(plain, { backendName: "claude-code" });
    h.trySpawn.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await h.daemon.spawnClaudeWindow()).toBe(false);
    expect(budgets(h)).toEqual([undefined, undefined]);
    expect(sessionKept(h)).toBe(false); // old behaviour: cleared after the first miss
  });
});

describe("#2 retry resume once before abandoning the session", () => {
  it("resume fails once → second resume attempt succeeds, session-id intact, reports resumed", async () => {
    const h = makeSpawnHarness(kiro());
    h.trySpawn.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await h.daemon.spawnClaudeWindow()).toBe(true);
    expect(h.trySpawn).toHaveBeenCalledTimes(2);
    expect(sessionKept(h)).toBe(true);
    expect(h.killed).toBe(1); // the failed window was torn down before the retry
    expect(h.daemon.skipResume).toBe(false);
  });

  it("resume fails twice → clears the session and starts fresh (bounded: 2 resume + 1 fresh)", async () => {
    const h = makeSpawnHarness(kiro());
    h.trySpawn.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await h.daemon.spawnClaudeWindow()).toBe(false);
    expect(h.trySpawn).toHaveBeenCalledTimes(3);
    expect(sessionKept(h)).toBe(false);
  });

  it("all three attempts fail → startup error, exactly three attempts", async () => {
    const h = makeSpawnHarness(kiro());
    h.trySpawn.mockResolvedValue(false);
    await expect(h.daemon.spawnClaudeWindow()).rejects.toThrow("CLI failed to start after retry");
    expect(h.trySpawn).toHaveBeenCalledTimes(3);
  });
});

describe("#4 short-circuit: no session burn while the backend is down", () => {
  it("fleet already knows the backend is down → resume failure throws, session kept, no fresh start", async () => {
    const outage = new BackendOutageTracker();
    outage.record("kiro-cli", "kiro-b", "down");
    const h = makeSpawnHarness(kiro(), { outage });
    h.trySpawn.mockResolvedValue(false);
    await expect(h.daemon.spawnClaudeWindow()).rejects.toBeInstanceOf(BackendUnreachableStartupError);
    expect(h.trySpawn).toHaveBeenCalledTimes(1);
    expect(sessionKept(h)).toBe(true);
    expect(h.daemon.skipResume).toBe(false); // the delayed retry will resume again
  });

  it("the failed startup pane itself shows the outage text → records the outage and throws (nothing else running yet)", async () => {
    const h = makeSpawnHarness(kiro());
    h.pane.text = OUTAGE_PANE;
    h.trySpawn.mockResolvedValue(false);
    await expect(h.daemon.spawnClaudeWindow()).rejects.toBeInstanceOf(BackendUnreachableStartupError);
    expect(h.trySpawn).toHaveBeenCalledTimes(1);
    expect(sessionKept(h)).toBe(true);
    expect(h.outage.isActive("kiro-cli")).toBe(true);
    expect(h.outage.active("kiro-cli")!.detail).toContain("runtime.us-east-1.kiro.dev");
  });

  it("an outage on a DIFFERENT backend does not short-circuit kiro", async () => {
    const outage = new BackendOutageTracker();
    outage.record("claude-code", "x");
    const h = makeSpawnHarness(kiro(), { outage });
    h.trySpawn.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await h.daemon.spawnClaudeWindow()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #4 lifecycle: one fleet-level notice per outage
// ─────────────────────────────────────────────────────────────────────────────
function makeLifecycle() {
  const notifyInstanceTopic = vi.fn();
  const notifyFleetError = vi.fn();
  const dataDir = mkdtempSync(join(tmpdir(), "agend-outage-lc-"));
  dirs.push(dataDir);
  const ctx = {
    fleetConfig: {
      defaults: { backend: "kiro-cli" },
      instances: { general: { general_topic: true }, "kiro-a": {}, "kiro-b": {}, claude: { backend: "claude-code" } },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    dataDir,
    getInstanceDir: (name: string) => { const d = join(dataDir, "instances", name); mkdirSync(d, { recursive: true }); return d; },
    eventLog: { insert: vi.fn() },
    isPlannedRestart: () => false,
    isClassicInstance: () => false,
    notifyInstanceTopic,
    notifyFleetError,
    backendOutage: new BackendOutageTracker(),
    setTopicIcon: vi.fn(),
    webhookEmit: vi.fn(),
    clearCancelButton: vi.fn(),
    checkModelFailover: vi.fn(),
    restartSingleInstance: vi.fn(async () => {}),
  } as unknown as LifecycleContext & { notifyFleetError: ReturnType<typeof vi.fn> };
  const lifecycle = new InstanceLifecycle(ctx);
  const attach = (name: string) => {
    const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle: vi.fn() }) as IncidentEventSource & EventEmitter;
    lifecycle.attachIncidentHandlers(name, daemon);
    return daemon;
  };
  return { attach, notifyInstanceTopic, notifyFleetError, ctx };
}

const flush = () => new Promise(r => setImmediate(r));

describe("#4 lifecycle: fleet-wide network errors notify once and feed the outage tracker", () => {
  it("two kiro instances reporting the outage → ONE fleet notice, no per-instance incidents, tracker active", async () => {
    const { attach, notifyInstanceTopic, notifyFleetError, ctx } = makeLifecycle();
    const a = attach("kiro-a");
    const b = attach("kiro-b");
    const evt = { type: "network", action: "notify", message: "Kiro backend unreachable — requests to runtime.us-east-1.kiro.dev are timing out", fleetWide: true };
    a.emit("pty_error", { name: "kiro-a", ...evt });
    await flush();
    b.emit("pty_error", { name: "kiro-b", ...evt });
    await flush();
    a.emit("pty_error", { name: "kiro-a", ...evt });
    await flush();

    expect(notifyFleetError).toHaveBeenCalledTimes(1);
    expect(notifyFleetError.mock.calls[0][0]).toContain("kiro-cli");
    expect(notifyFleetError.mock.calls[0][0]).toContain("runtime.us-east-1.kiro.dev");
    expect(notifyInstanceTopic).not.toHaveBeenCalled();
    expect(ctx.backendOutage!.isActive("kiro-cli")).toBe(true);
    expect([...ctx.backendOutage!.active("kiro-cli")!.instances].sort()).toEqual(["kiro-a", "kiro-b"]);
  });

  it("a plain (non-fleetWide) network error keeps the per-instance incident path", async () => {
    const { attach, notifyInstanceTopic, notifyFleetError, ctx } = makeLifecycle();
    const c = attach("claude");
    c.emit("pty_error", { name: "claude", type: "network", action: "notify", message: "Connection error" });
    await flush();
    expect(notifyFleetError).not.toHaveBeenCalled();
    expect(notifyInstanceTopic).toHaveBeenCalledTimes(1);
    expect(ctx.backendOutage!.isActive("claude-code")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3 fleet-manager: delayed automatic startup retries
// ─────────────────────────────────────────────────────────────────────────────
function makeFleet() {
  const dataDir = mkdtempSync(join(tmpdir(), "agend-startup-retry-"));
  dirs.push(dataDir);
  const fm = new FleetManager(dataDir);
  fm.fleetConfig = {
    defaults: { backend: "kiro-cli", startup: { concurrency: 4, stagger_delay_ms: 0 } },
    instances: {
      a: { working_directory: "/tmp/a" },
      b: { working_directory: "/tmp/b" },
    },
  } as any;
  const notifyFleetError = vi.fn();
  Object.assign(fm, { notifyFleetError });
  const startInstance = vi.spyOn(fm, "startInstance").mockRejectedValue(new Error("CLI failed to start after retry"));
  const cleanup = () => { fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); for (const p of (fm as any).startupRetries.values()) clearTimeout(p.timer); for (const p of (fm as any).startupRetryNotices.values()) clearTimeout(p.timer); };
  return { fm, notifyFleetError, startInstance, cleanup };
}

const entries = () => [["a", { working_directory: "/tmp/a" }], ["b", { working_directory: "/tmp/b" }]] as any;

describe("#3 delayed automatic startup retries", () => {
  beforeEach(() => vi.useFakeTimers());

  it("retries at 1m / 5m / 15m with one aggregated notice, then gives up with one notice", async () => {
    const { fm, notifyFleetError, startInstance, cleanup } = makeFleet();
    try {
      await (fm as any).startInstancesWithConcurrency(entries(), false);
      expect(startInstance).toHaveBeenCalledTimes(2);
      expect(fm.pendingStartupRetry("a")).toEqual({ attempt: 0 });
      expect(fm.pendingStartupRetry("b")).toEqual({ attempt: 0 });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(notifyFleetError).toHaveBeenCalledTimes(1);           // aggregated: both names, one message
      expect(notifyFleetError.mock.calls[0][0]).toContain("2 instance(s)");
      expect(notifyFleetError.mock.calls[0][0]).toContain("a, b");
      expect(notifyFleetError.mock.calls[0][0]).toContain("1m");

      await vi.advanceTimersByTimeAsync(60_000);
      expect(startInstance).toHaveBeenCalledTimes(4);              // attempt 1 for both
      expect(fm.pendingStartupRetry("a")).toEqual({ attempt: 1 });
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(startInstance).toHaveBeenCalledTimes(6);              // attempt 2
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(startInstance).toHaveBeenCalledTimes(8);              // attempt 3 — the last without an outage
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fm.pendingStartupRetry("a")).toBeNull();
      expect(notifyFleetError).toHaveBeenCalledTimes(2);           // the give-up notice, once for both
      expect(notifyFleetError.mock.calls[1][0]).toContain("Gave up");
      expect(notifyFleetError.mock.calls[1][0]).toContain("a, b");

      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(startInstance).toHaveBeenCalledTimes(8);              // nothing further
    } finally { cleanup(); }
  });

  it("keeps retrying every 15m while the backend outage is active, up to the hard cap", async () => {
    const { fm, notifyFleetError, startInstance, cleanup } = makeFleet();
    try {
      // The daemon's startup path records the outage it sees in its own pane
      // right before failing (noteStartupPaneForBackendOutage), so the tracker
      // is fresh at scheduling time even when nothing else is running.
      startInstance.mockImplementation(async () => { fm.backendOutage.record("kiro-cli", "a", "down"); throw new Error("backend unreachable"); });
      await (fm as any).startInstancesWithConcurrency([["a", { working_directory: "/tmp/a" }]] as any, false);
      const keepDown = () => fm.backendOutage.record("kiro-cli", "z", "down");
      keepDown();
      await vi.advanceTimersByTimeAsync(60_000); keepDown();                 // attempt 1
      await vi.advanceTimersByTimeAsync(5 * 60_000); keepDown();             // attempt 2
      await vi.advanceTimersByTimeAsync(15 * 60_000); keepDown();            // attempt 3 → continues (outage)
      expect(startInstance).toHaveBeenCalledTimes(4);
      expect(fm.pendingStartupRetry("a")).toEqual({ attempt: 3 });
      await vi.advanceTimersByTimeAsync(15 * 60_000); keepDown();            // attempt 4
      await vi.advanceTimersByTimeAsync(15 * 60_000); keepDown();            // attempt 5
      await vi.advanceTimersByTimeAsync(15 * 60_000); keepDown();            // attempt 6 → cap
      expect(startInstance).toHaveBeenCalledTimes(7);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fm.pendingStartupRetry("a")).toBeNull();
      expect(notifyFleetError).toHaveBeenCalledTimes(2);
      expect(notifyFleetError.mock.calls[0][0]).toContain("unreachable");   // first notice names the cause
    } finally { cleanup(); }
  });

  it("a retry that succeeds is silent and schedules nothing more", async () => {
    const { fm, notifyFleetError, startInstance, cleanup } = makeFleet();
    try {
      await (fm as any).startInstancesWithConcurrency([["a", { working_directory: "/tmp/a" }]] as any, false);
      startInstance.mockImplementation(async (name: string) => { (fm as any).daemons.set(name, {}); });
      await vi.advanceTimersByTimeAsync(61_000);
      expect(startInstance).toHaveBeenCalledTimes(2);
      expect(fm.pendingStartupRetry("a")).toBeNull();
      expect(notifyFleetError).toHaveBeenCalledTimes(1);                    // only the initial notice
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(startInstance).toHaveBeenCalledTimes(2);
    } finally { cleanup(); }
  });

  it("defers (without counting an attempt) while the tmux storm window blocks spawns", async () => {
    const { fm, startInstance, cleanup } = makeFleet();
    try {
      await (fm as any).startInstancesWithConcurrency([["a", { working_directory: "/tmp/a" }]] as any, false);
      await vi.advanceTimersByTimeAsync(59_000);
      fm.stormWindow.recordServerDead("b", ["b"]);                          // tmux server dies just before the retry
      expect(fm.stormWindow.isSpawnBlocked()).toBe(true);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(startInstance).toHaveBeenCalledTimes(1);                       // not retried into the storm
      expect(fm.pendingStartupRetry("a")).toEqual({ attempt: 0 });         // same attempt, re-armed
      fm.stormWindow.shutdown();                                            // storm over
      await vi.advanceTimersByTimeAsync(FleetManager.STARTUP_RETRY_STORM_DEFER_MS);
      expect(startInstance).toHaveBeenCalledTimes(2);
    } finally { cleanup(); }
  });

  it("an operator stop/start cancels the pending retry; a removed instance is skipped", async () => {
    const { fm, startInstance, cleanup } = makeFleet();
    try {
      await (fm as any).startInstancesWithConcurrency(entries(), false);
      vi.spyOn(fm.lifecycle, "stop").mockResolvedValue(undefined);
      await fm.stopInstance("a");
      expect(fm.pendingStartupRetry("a")).toBeNull();
      delete (fm.fleetConfig as any).instances.b;                           // b removed from fleet.yaml
      await vi.advanceTimersByTimeAsync(60_000);
      expect(startInstance).toHaveBeenCalledTimes(2);                       // neither retried
    } finally { cleanup(); }
  });

  it("does not schedule anything for instances that started fine", async () => {
    const { fm, startInstance, notifyFleetError, cleanup } = makeFleet();
    try {
      startInstance.mockImplementation(async (name: string) => { (fm as any).daemons.set(name, {}); });
      await (fm as any).startInstancesWithConcurrency(entries(), false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fm.pendingStartupRetry("a")).toBeNull();
      expect(notifyFleetError).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });
});
