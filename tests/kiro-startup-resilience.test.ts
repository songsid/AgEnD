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

  it("does not fire on an agent merely mentioning timeouts or kiro.dev — including the literal phrase", () => {
    const network = patterns().find(p => p.type === "network")!;
    expect(network.pattern.test("the request timed out, let me retry")).toBe(false);
    expect(network.pattern.test("docs live at https://kiro.dev/docs")).toBe(false);
    // sol's review: the bare phrase in conversation must not mark the backend down.
    expect(network.pattern.test("> Earlier we saw a dispatch failure (timeout) on that instance; the fix is in #690.")).toBe(false);
    expect(network.pattern.test("1 dispatch failure (timeout) was mentioned")).toBe(false);
  });

  it("matches kiro's numbered error row, including the live line wrapped at the pane width", () => {
    const network = patterns().find(p => p.type === "network")!;
    expect(network.pattern.test("   1: dispatch failure (timeout): request timed out: error sending request for url (https://runtime.us-east-1.kiro.dev/)")).toBe(true);
    expect(network.pattern.test("   1: dispatch failure (timeout): request timed out: error sending request for u\nrl (https://runtime.us-east-1.kiro.dev/)")).toBe(true);
    expect(network.pattern.test("1: dispatch failure (timeout)")).toBe(true);
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
    // The failed window is torn down, not left alive-but-never-ready behind a `crashed` daemon.
    expect(h.killed).toBe(1);
    expect(h.daemon.tmux.killWindow).toHaveBeenCalledTimes(1);
  });

  it("a successful resume positively clears the outage memory (a fresh start does not)", async () => {
    const outage = new BackendOutageTracker();
    outage.record("kiro-cli", "kiro-b", "down");
    const h = makeSpawnHarness(kiro(), { outage });
    h.trySpawn.mockResolvedValueOnce(true);
    // The tracker says "down" but this instance's resume comes back: outage over.
    // (isActive is consulted only after a FAILED resume, so the success path runs.)
    expect(await h.daemon.spawnClaudeWindow()).toBe(true);
    expect(outage.isActive("kiro-cli")).toBe(false);

    outage.record("kiro-cli", "kiro-b", "down");
    const fresh = makeSpawnHarness(kiro(), { outage });
    fresh.daemon.skipResume = true;
    fresh.trySpawn.mockResolvedValueOnce(true);
    expect(await fresh.daemon.spawnClaudeWindow()).toBe(false);
    expect(outage.isActive("kiro-cli")).toBe(true); // a local fresh prompt proves nothing
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

describe("#1 wake uses the resume budget too (sol blocker 1)", () => {
  function wakeable(h: SpawnHarness) {
    h.daemon.pauseWakeState = "paused";
    h.daemon.autoPauseController = { wakeOnDeliver: (fn: () => Promise<void>) => fn() };
    h.daemon.clearErrorRecoveryGate = vi.fn();
    h.daemon.resumeRuntimeMonitors = vi.fn();
    h.trySpawn.mockResolvedValue(true);
  }

  it("kiro wake passes the 60s resume budget to trySpawn instead of the caller's 30s", async () => {
    const h = makeSpawnHarness(kiro());
    wakeable(h);
    await h.daemon.wake(30_000);
    expect(h.trySpawn).toHaveBeenCalledWith(true, KIRO_RESUME_STARTUP_BUDGET_MS);
    expect(h.daemon.wakeBudgetMs(30_000)).toBe(KIRO_RESUME_STARTUP_BUDGET_MS);
    expect(h.daemon.wakeBudgetMs(120_000)).toBe(120_000); // never below the caller's
  });

  it("a backend without the capability keeps the caller's 30s (or its configured startup_timeout_ms if larger)", async () => {
    const plain = { binaryName: "claude", getReadyPattern: () => /❯/, getErrorPatterns: () => [] };
    const h = makeSpawnHarness(plain, { backendName: "claude-code" });
    wakeable(h);
    await h.daemon.wake(30_000);
    expect(h.trySpawn).toHaveBeenCalledWith(true, 30_000);
    const configured = makeSpawnHarness(plain, { backendName: "claude-code", startupTimeoutMs: 90_000 });
    expect(configured.daemon.wakeBudgetMs(30_000)).toBe(90_000);
  });
});

describe("crash-respawn during an outage hands off instead of stranding `crashed` (sol blocker 3)", () => {
  it("emits startup_backend_unreachable and pauses health monitoring when the fleet is listening", () => {
    const h = makeSpawnHarness(kiro());
    const events: unknown[] = [];
    h.daemon.on("startup_backend_unreachable", (e: unknown) => events.push(e));
    expect(h.daemon.handOffBackendUnreachableRespawn(new BackendUnreachableStartupError("kiro-cli"))).toBe(true);
    expect(events).toEqual([{ name: "kiro-a", backend: "kiro-cli" }]);
    expect(h.daemon.healthCheckPaused).toBe(true);
  });

  it("is a no-op for other errors and when nobody listens (old log-only path)", () => {
    const h = makeSpawnHarness(kiro());
    expect(h.daemon.handOffBackendUnreachableRespawn(new Error("CLI failed to start after retry"))).toBe(false);
    expect(h.daemon.handOffBackendUnreachableRespawn(new BackendUnreachableStartupError("kiro-cli"))).toBe(false);
    expect(h.daemon.healthCheckPaused).toBe(false);
  });
});

describe("a rejected start() disposes the half-started daemon (sol round 3, B1)", () => {
  it("abortStartup closes the IPC server, kills the window, removes pid/window-id, and is idempotent", async () => {
    const h = makeSpawnHarness(kiro());
    const close = vi.fn(async () => {});
    h.daemon.ipcServer = { close };
    writeFileSync(join(h.dir, "daemon.pid"), String(process.pid));
    writeFileSync(join(h.dir, "window-id"), "@1");

    await h.daemon.abortStartup();
    await h.daemon.abortStartup();

    expect(close).toHaveBeenCalledTimes(1);
    expect(h.daemon.ipcServer).toBeNull();
    expect(h.killed).toBe(1);
    expect(h.daemon.tmux.killWindow).toHaveBeenCalledTimes(1);
    expect(existsSync(join(h.dir, "daemon.pid"))).toBe(false);
    expect(existsSync(join(h.dir, "window-id"))).toBe(false);
  });

  it("the lifecycle ownership boundary aborts the daemon when start() rejects, then rethrows", async () => {
    const abortStartup = vi.fn(async () => {});
    const daemon = { start: vi.fn(async () => { throw new BackendUnreachableStartupError("kiro-cli"); }), abortStartup };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
    await expect(InstanceLifecycle.startOrDispose(daemon, "kiro-a", logger)).rejects.toBeInstanceOf(BackendUnreachableStartupError);
    expect(abortStartup).toHaveBeenCalledTimes(1);

    // A failing abort must not mask the start error.
    const daemon2 = { start: vi.fn(async () => { throw new Error("CLI failed to start after retry"); }), abortStartup: vi.fn(async () => { throw new Error("close exploded"); }) };
    await expect(InstanceLifecycle.startOrDispose(daemon2, "kiro-a", logger)).rejects.toThrow("CLI failed to start after retry");
    expect(logger.warn).toHaveBeenCalled();

    // A successful start never aborts.
    const daemon3 = { start: vi.fn(async () => {}), abortStartup: vi.fn(async () => {}) };
    await InstanceLifecycle.startOrDispose(daemon3, "kiro-a", logger);
    expect(daemon3.abortStartup).not.toHaveBeenCalled();
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
    scheduleStartupRetry: vi.fn(),
    setTopicIcon: vi.fn(),
    stopStatuslineWatcher: vi.fn(),
    instanceIpcClients: new Map(),
    ipcStoppingInstances: new Set(),
    sessionRegistry: new Map(),
    backendOutage: new BackendOutageTracker(),
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
  return { attach, notifyInstanceTopic, notifyFleetError, ctx, lifecycle };
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

  it("startup_backend_unreachable → the fleet-owned hand-off gets THIS daemon (identity), not just a name", async () => {
    const { attach, ctx } = makeLifecycle();
    const handOff = vi.fn(async () => {});
    (ctx as any).handOffToStartupRetry = handOff;
    const a = attach("kiro-a");
    a.emit("startup_backend_unreachable", { name: "kiro-a", backend: "kiro-cli" });
    await flush();
    expect(handOff).toHaveBeenCalledWith("kiro-a", a);
    expect((ctx as any).scheduleStartupRetry).not.toHaveBeenCalled(); // the fleet decides
  });

  it("without a fleet coordinator it stops only if this daemon is still the registered one", async () => {
    const { attach, ctx, lifecycle } = makeLifecycle();
    const a = attach("kiro-a");
    const fresh = { stop: vi.fn(async () => {}) };
    lifecycle.daemons.set("kiro-a", fresh as any);           // a restart already replaced it
    a.emit("startup_backend_unreachable", { name: "kiro-a", backend: "kiro-cli" });
    await flush();
    expect(fresh.stop).not.toHaveBeenCalled();
    expect(lifecycle.daemons.get("kiro-a")).toBe(fresh);
    expect((ctx as any).scheduleStartupRetry).not.toHaveBeenCalled();
  });

  it("stop() is identity-safe: a fresh daemon registered during the old one's stop survives", async () => {
    const { lifecycle } = makeLifecycle();
    const fresh = { stop: vi.fn(async () => {}) };
    const old = { stop: vi.fn(async () => { lifecycle.daemons.set("kiro-a", fresh as any); }) };
    lifecycle.daemons.set("kiro-a", old as any);
    await lifecycle.stop("kiro-a");
    expect(old.stop).toHaveBeenCalledTimes(1);
    expect(lifecycle.daemons.get("kiro-a")).toBe(fresh);
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

  it("General and other unattended starts get the retry; an explicit start keeps its synchronous error (sol blocker 2)", async () => {
    const { fm, startInstance, cleanup } = makeFleet();
    try {
      (fm.fleetConfig as any).instances.general = { working_directory: "/tmp/g", general_topic: true };
      expect(await (fm as any).startInstanceUnattended("general", (fm.fleetConfig as any).instances.general, true, "general instance")).toBe(false);
      expect(fm.pendingStartupRetry("general")).toEqual({ attempt: 0 });
      // The retry itself resolves the General config and runs through the gate.
      await vi.advanceTimersByTimeAsync(61_000);
      expect(startInstance).toHaveBeenCalledTimes(2);
      expect(startInstance.mock.calls[1][0]).toBe("general");

      // Explicit start: the error propagates, nothing is scheduled.
      startInstance.mockRestore();
      vi.spyOn(fm.lifecycle, "start").mockRejectedValue(new Error("boom"));
      await expect(fm.startInstance("a", (fm.fleetConfig as any).instances.a, false)).rejects.toThrow("boom");
      expect(fm.pendingStartupRetry("a")).toBeNull();
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

// ─────────────────────────────────────────────────────────────────────────────
// hand-off vs operator races (sol round 3, M2)
// ─────────────────────────────────────────────────────────────────────────────
describe("outage hand-off is serialized against operator stop/restart", () => {
  beforeEach(() => vi.useFakeTimers());

  function slowDaemon() {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const stop = vi.fn(async () => { await gate; });
    return { daemon: { stop } as any, release, stop };
  }
  function fleetWithDaemon() {
    const made = makeFleet();
    made.fm.setTopicIcon = vi.fn();
    const { daemon, release, stop } = slowDaemon();
    made.fm.lifecycle.daemons.set("a", daemon);
    return { ...made, daemon, release, stop };
  }

  it("plain hand-off: stops the daemon and schedules attempt 0", async () => {
    const { fm, daemon, release, cleanup } = fleetWithDaemon();
    try {
      const handOff = fm.handOffToStartupRetry("a", daemon);
      release();
      await handOff;
      expect(fm.lifecycle.daemons.has("a")).toBe(false);
      expect(fm.pendingStartupRetry("a")).toEqual({ attempt: 0 });
    } finally { cleanup(); }
  });

  it("an explicit stop during the hand-off wins: no automatic retry is scheduled behind it", async () => {
    const { fm, daemon, release, cleanup } = fleetWithDaemon();
    try {
      vi.spyOn(fm.lifecycle, "stop").mockImplementation(async (name: string) => {
        const d = fm.lifecycle.daemons.get(name); if (d) { await d.stop(); if (fm.lifecycle.daemons.get(name) === d) fm.lifecycle.daemons.delete(name); }
      });
      const handOff = fm.handOffToStartupRetry("a", daemon);
      const operatorStop = fm.stopInstance("a");            // begins while the old daemon is still stopping
      release();
      await Promise.all([handOff, operatorStop]);
      expect(fm.lifecycle.daemons.has("a")).toBe(false);
      expect(fm.pendingStartupRetry("a")).toBeNull();        // the operator's stop is not undone
    } finally { cleanup(); }
  });

  it("an operator restart during the hand-off keeps the FRESH daemon and schedules no retry", async () => {
    const { fm, daemon, release, startInstance, cleanup } = fleetWithDaemon();
    try {
      const fresh = { stop: vi.fn(async () => {}) } as any;
      startInstance.mockImplementation(async (name: string) => { fm.lifecycle.daemons.set(name, fresh); });
      vi.spyOn(fm.lifecycle, "stop").mockImplementation(async (name: string) => {
        const d = fm.lifecycle.daemons.get(name); if (d) { await d.stop(); if (fm.lifecycle.daemons.get(name) === d) fm.lifecycle.daemons.delete(name); }
      });
      const handOff = fm.handOffToStartupRetry("a", daemon);
      const restart = fm.restartSingleInstance("a");
      release();
      await vi.advanceTimersByTimeAsync(10);
      await Promise.all([handOff, restart]);
      expect(fm.lifecycle.daemons.get("a")).toBe(fresh);      // the late hand-off did not delete it
      expect(fresh.stop).not.toHaveBeenCalled();
      expect(fm.pendingStartupRetry("a")).toBeNull();
    } finally { cleanup(); }
  });

  it("REVERSE order: an explicit stop that began BEFORE the hand-off is never undone by a retry", async () => {
    const { fm, daemon, release, cleanup } = fleetWithDaemon();
    try {
      vi.spyOn(fm.lifecycle, "stop").mockImplementation(async (name: string) => {
        const d = fm.lifecycle.daemons.get(name); if (d) { await d.stop(); if (fm.lifecycle.daemons.get(name) === d) fm.lifecycle.daemons.delete(name); }
      });
      const operatorStop = fm.stopInstance("a");            // 1. begins first, blocks in old.stop()
      const handOff = fm.handOffToStartupRetry("a", daemon); // 2. health tick hands off meanwhile
      release();                                             // 3. both stops complete
      await Promise.all([operatorStop, handOff]);
      expect(fm.lifecycle.daemons.has("a")).toBe(false);
      expect(fm.pendingStartupRetry("a")).toBeNull();        // no retry one minute later
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(fm.pendingStartupRetry("a")).toBeNull();
    } finally { cleanup(); }
  });

  it("ClassicBot kiro: the hand-off's retry rebuilds the instance through startClassicInstance", async () => {
    const { fm, daemon, release, startInstance, cleanup } = fleetWithDaemon();
    try {
      // "cls" lives only in the classic channel manager, not in fleet.yaml.
      fm.lifecycle.daemons.delete("a");
      fm.lifecycle.daemons.set("cls", daemon);
      fm.classicChannels = {
        getAll: () => [{ instanceName: "cls", channelId: "c1", adapterId: "discord" }],
        getBackendByInstance: () => "kiro-cli",
        getChannelIdByInstance: () => "c1",
        getAdapterIdByInstance: () => "discord",
        getPreTaskCommand: () => undefined,
        getModel: () => undefined,
        getAutoPauseAfter: () => undefined,
      } as any;
      (fm.fleetConfig as any).defaults.backend = "claude-code";  // fleet default ≠ the channel's backend
      const startClassic = vi.spyOn(fm as any, "startClassicInstance").mockResolvedValue(undefined);

      expect((fm as any).backendNameOf("cls")).toBe("kiro-cli");
      const handOff = fm.handOffToStartupRetry("cls", daemon);
      release();
      await handOff;
      expect(fm.lifecycle.daemons.has("cls")).toBe(false);
      expect(fm.pendingStartupRetry("cls")).toEqual({ attempt: 0 });

      await vi.advanceTimersByTimeAsync(61_000);
      expect(startClassic).toHaveBeenCalledTimes(1);
      expect(startClassic.mock.calls[0][0]).toBe("cls");
      expect(startClassic.mock.calls[0][1]).toBe("kiro-cli");
      expect(startInstance).not.toHaveBeenCalled();           // not the fleet.yaml path
    } finally { cleanup(); }
  });

  it("a hand-off for a daemon that was already replaced is a no-op", async () => {
    const { fm, daemon, cleanup } = fleetWithDaemon();
    try {
      const fresh = { stop: vi.fn(async () => {}) } as any;
      fm.lifecycle.daemons.set("a", fresh);
      await fm.handOffToStartupRetry("a", daemon);
      expect(fm.lifecycle.daemons.get("a")).toBe(fresh);
      expect(fm.pendingStartupRetry("a")).toBeNull();
    } finally { cleanup(); }
  });
});
