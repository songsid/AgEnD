/**
 * #1044: the pause AgEnD defers when an auth error shows up mid-turn.
 *
 * Pinned first, before any guard: a genuinely expired session must still be
 * paused. It returns to its prompt after every failed turn, which is what the
 * error gate calls "recovered" — so recovery must NOT cancel the deferred
 * pause (42512a46: an expired session kept taking messages into a CLI that
 * could only fail). Then the guard: for a backend with no token-free auth check
 * (muse), a hit that is no longer at the bottom of the pane when the turn ends
 * is not paused on.
 *
 * Driven through the real Daemon error monitor and idle edge, with the real
 * MuseBackend patterns. Pane chrome is muse 1.4.1's (captured live); the error
 * sentence is from the 1.4.1 binary — a mid-session expiry cannot be captured
 * without breaking a real login.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MuseBackend } from "../src/backend/muse.js";
import { Daemon } from "../src/daemon.js";

const RULE = "─".repeat(120);
const STATUS = "  muse-spark-1.3-contributor · high · ~/wd · Launch overrides";
const AUTH = "  response failed (status 401) (still unauthorized after a token refresh; run `muse login` again)";
const idlePane = (...transcript: string[]) => [...transcript, RULE, "❯", RULE, STATUS, ""].join("\n");
const busyPane = (...transcript: string[]) => [...transcript, "◈ Thinking (12s · esc to interrupt)", RULE, "❯", RULE, STATUS, ""].join("\n");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});

function museDaemon() {
  const dir = mkdtempSync(join(tmpdir(), "agend-1044-"));
  dirs.push(dir);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const backend = new MuseBackend(dir);
  const daemon = new Daemon("muse-worker", {
    working_directory: dir, backend: "muse", log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
  } as any, dir, false, backend as any, undefined, { child: () => logger } as any) as any;
  let pane = "";
  daemon.tmux = { isWindowAlive: vi.fn(async () => true), capturePane: vi.fn(async () => pane) };
  const errors: any[] = [];
  const pauses: any[] = [];
  daemon.on("pty_error", (e: any) => errors.push(e));
  daemon.on("auto_pause_requested", (e: any) => pauses.push(e));
  // What the lifecycle does for an auth error the CLI cannot be asked about
  // (muse has no token-free check: verdict "unknown"): pause() no-ops on a busy
  // pane, so the pause is deferred to the idle edge.
  const deferLikeTheLifecycle = (opts?: object) => daemon.requestPauseWhenIdle(opts);
  const scan = async (p: string) => { pane = p; await vi.advanceTimersByTimeAsync(5_000); };
  const idleEdge = (p: string) => {
    pane = p;
    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot({ state: "idle", observedAt: Date.now(), stateChangedAt: Date.now(), unchangedForMs: 0 }, p);
  };
  return { daemon, errors, pauses, scan, idleEdge, deferLikeTheLifecycle, logger };
}

describe("pinned: a real expired session is still paused (#1044, 42512a46)", () => {
  it("auth error mid-turn → prompt back ('recovered') → the turn's idle edge pauses", async () => {
    vi.useFakeTimers();
    const { daemon, errors, pauses, scan, idleEdge, deferLikeTheLifecycle } = museDaemon();
    daemon.startErrorMonitor();
    try {
      await scan(busyPane("❯ fix the flaky test", "◆ Looking at it."));
      await scan(busyPane("❯ fix the flaky test", "◆ Looking at it.", AUTH));
      expect(errors.map(e => e.type)).toEqual(["auth_error"]);
      deferLikeTheLifecycle({ reconfirmAuth: true });
      // The CLI is back at its prompt: the gate logs "PTY error recovered".
      await scan(idlePane("❯ fix the flaky test", "◆ Looking at it.", AUTH));
      expect(daemon.errorWaitingForRecovery).toBe(false);
      idleEdge(idlePane("❯ fix the flaky test", "◆ Looking at it.", AUTH));
      expect(pauses).toHaveLength(1);
    } finally {
      daemon.freezeRuntimeMonitors();
    }
  });

  it("a stuck pane with a deferred auth pause is paused too", () => {
    const { daemon, pauses, deferLikeTheLifecycle } = museDaemon();
    deferLikeTheLifecycle({ reconfirmAuth: true });
    const p = busyPane("◆ Looking at it.", AUTH);
    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot({ state: "stuck", observedAt: Date.now(), stateChangedAt: Date.now(), unchangedForMs: 600_000 }, p);
    expect(pauses).toHaveLength(1);
    expect(daemon.pauseAllowStuck).toBe(true);
  });

  it("without a reconfirm request (a backend whose auth check said invalid) the idle edge pauses whatever the pane shows", () => {
    const { daemon, pauses, idleEdge, deferLikeTheLifecycle } = museDaemon();
    deferLikeTheLifecycle();
    idleEdge(idlePane("◆ All done.", ...Array.from({ length: 30 }, (_, i) => `  line ${i}`)));
    expect(pauses).toHaveLength(1);
  });
});

describe("the guard: an unverifiable auth hit must still be on screen when the turn ends (#1044)", () => {
  const QUOTE = "  so the refresh fails with: still unauthorized after a token refresh; run `muse login` again";

  it("a hit that scrolled on before the turn ended is not paused on", async () => {
    vi.useFakeTimers();
    const { daemon, errors, pauses, scan, idleEdge, deferLikeTheLifecycle, logger } = museDaemon();
    daemon.startErrorMonitor();
    try {
      // The #1042 shape: the pattern catches conversation text mid-turn.
      await scan(busyPane("❯ why does login fail?", "◆ Reading the client code.", QUOTE));
      expect(errors.map(e => e.type)).toEqual(["auth_error"]);
      deferLikeTheLifecycle({ reconfirmAuth: true });
      const more = Array.from({ length: 20 }, (_, i) => `  step ${i}: still working through the diff`);
      await scan(busyPane("◆ Reading the client code.", QUOTE, ...more));
      idleEdge(idlePane("◆ Reading the client code.", QUOTE, ...more, "◆ Fixed; committing now."));
      expect(pauses).toEqual([]);
      expect(daemon.pausePending).toBe(false);
      expect(daemon.authFailureUnresolved).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("Deferred auth pause dropped"));
    } finally {
      daemon.freezeRuntimeMonitors();
    }
  });

  it("an unreadable pane keeps the pause", () => {
    const { daemon, pauses, deferLikeTheLifecycle } = museDaemon();
    deferLikeTheLifecycle({ reconfirmAuth: true });
    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot({ state: "idle", observedAt: Date.now(), stateChangedAt: Date.now(), unchangedForMs: 0 }, undefined);
    expect(pauses).toHaveLength(1);
  });

  it("a pause already pending without conditions is not weakened, in either order", () => {
    for (const order of [[{}, { reconfirmAuth: true }], [{ reconfirmAuth: true }, {}]]) {
      const { daemon, pauses, idleEdge } = museDaemon();
      for (const o of order) daemon.requestPauseWhenIdle(o);
      idleEdge(idlePane("◆ All done.", ...Array.from({ length: 30 }, (_, i) => `  line ${i}`)));
      expect(pauses, JSON.stringify(order)).toHaveLength(1);
    }
  });
});

describe("the lifecycle asks for the reconfirmation only when nothing could vouch for the hit", () => {
  it("uncertain check → reconfirm; failed check → unconditional", async () => {
    const { InstanceLifecycle } = await import("../src/instance-lifecycle.js");
    const { setAuthCheckRunnerForTests } = await import("../src/login-flows.js");
    const { EventEmitter } = await import("node:events");
    try {
      for (const [result, reconfirm] of [[{ code: null, output: "" }, true], [{ code: 1, output: "Not logged in" }, false]] as const) {
        setAuthCheckRunnerForTests(async () => result);
        const lc = new InstanceLifecycle({
          fleetConfig: { instances: { worker: { backend: "codex" } }, defaults: {} },
          logger: { info() {}, warn() {}, error() {}, debug() {} }, eventLog: null,
          isPlannedRestart: () => false, notifyInstanceTopic: vi.fn(), offerBackendLogin: vi.fn(async () => {}),
          webhookEmit: vi.fn(), clearCancelButton: vi.fn(), checkModelFailover() {}, restartSingleInstance: async () => {},
          getInstanceDir: (n: string) => `/nonexistent/${n}`,
        } as any);
        const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle: vi.fn(), clearSuspectedAuthFailure: vi.fn(() => true) });
        lc.attachIncidentHandlers("worker", daemon as any);
        (lc as any).daemons.set("worker", daemon);
        const directPause = vi.spyOn(lc as any, "pause");
        daemon.emit("pty_error", { name: "worker", type: "auth_error", action: "pause", message: "401" });
        await vi.waitFor(() => expect(daemon.requestPauseWhenIdle).toHaveBeenCalled());
        if (reconfirm) {
          expect(daemon.requestPauseWhenIdle).toHaveBeenCalledWith({ reconfirmAuth: true });
          // Never the direct pause: on an idle pane it would /quit before any check.
          expect(directPause).not.toHaveBeenCalled();
        } else {
          expect(daemon.requestPauseWhenIdle, JSON.stringify(result)).toHaveBeenCalledWith({ reason: "auth" });
          expect(directPause).toHaveBeenCalledWith("worker", "auth");
        }
      }
    } finally {
      setAuthCheckRunnerForTests(null);
    }
  });

  it("a non-auth pause (e.g. a config error) is never conditional", async () => {
    const { InstanceLifecycle } = await import("../src/instance-lifecycle.js");
    const { EventEmitter } = await import("node:events");
    const lc = new InstanceLifecycle({
      fleetConfig: { instances: { worker: { backend: "codex" } }, defaults: {} },
      logger: { info() {}, warn() {}, error() {}, debug() {} }, eventLog: null,
      isPlannedRestart: () => false, notifyInstanceTopic: vi.fn(), offerBackendLogin: vi.fn(async () => {}),
      webhookEmit: vi.fn(), clearCancelButton: vi.fn(), checkModelFailover() {}, restartSingleInstance: async () => {},
      getInstanceDir: (n: string) => `/nonexistent/${n}`,
    } as any);
    const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle: vi.fn(), clearSuspectedAuthFailure: vi.fn(() => true) });
    lc.attachIncidentHandlers("worker", daemon as any);
    (lc as any).daemons.set("worker", daemon);
    daemon.emit("pty_error", { name: "worker", type: "config_error", action: "pause", message: "claude.json is corrupt" });
    await vi.waitFor(() => expect(daemon.requestPauseWhenIdle).toHaveBeenCalled());
    expect(daemon.requestPauseWhenIdle).toHaveBeenCalledWith({ reason: "error" });
  });
});

describe("#1058 review: the pane is already idle when the lifecycle's handler runs", () => {
  /**
   * The error monitor saw the hit mid-turn; by the time the async handler
   * runs, the turn has ended. A direct pause would /quit on the spot, so the
   * lifecycle must hand the decision to the daemon, which looks at once.
   */
  async function idleMuseUnderLifecycle(pane: string) {
    const { InstanceLifecycle } = await import("../src/instance-lifecycle.js");
    const { PaneStateMachine } = await import("../src/daemon.js");
    const { daemon, pauses } = museDaemon();
    daemon.tmux = { isWindowAlive: vi.fn(async () => true), capturePane: vi.fn(async () => pane), getWindowId: () => "@1" };
    // What spawn sets up: the state machine on muse's own patterns, monitor on.
    daemon.instanceStateMachine = new PaneStateMachine(daemon.backend.getReadyPattern(), 600_000, Date.now(), daemon.backend.getBusyPattern());
    daemon.instanceStateMonitorActive = true;
    daemon.instanceState = "idle";
    const lc = new InstanceLifecycle({
      fleetConfig: { instances: { "muse-worker": { backend: "muse" } }, defaults: {} },
      logger: { info() {}, warn() {}, error() {}, debug() {} }, eventLog: null,
      isPlannedRestart: () => false, notifyInstanceTopic: vi.fn(), offerBackendLogin: vi.fn(async () => {}),
      webhookEmit: vi.fn(), clearCancelButton: vi.fn(), checkModelFailover() {}, restartSingleInstance: async () => {},
      getInstanceDir: (n: string) => `/nonexistent/${n}`,
    } as any);
    lc.attachIncidentHandlers("muse-worker", daemon);
    (lc as any).daemons.set("muse-worker", daemon);
    const directPause = vi.spyOn(lc as any, "pause");
    daemon.emit("pty_error", { name: "muse-worker", type: "auth_error", action: "pause", message: "Muse authentication error" });
    await vi.waitFor(() => expect(daemon.tmux.capturePane).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 20));
    return { pauses, directPause, daemon };
  }

  it("a muse turn past its first minute is still busy: the immediate look defers, the real idle edge decides", async () => {
    const { PaneStateMachine } = await import("../src/daemon.js");
    const { daemon, pauses } = museDaemon();
    // A real failure line right at the bottom, but the turn is still running —
    // with a timer that has grown a minutes unit (#1045).
    const running = [ "◆ Looking at it.", AUTH, "◈ Thinking (1m 31s · esc to interrupt)", RULE, "❯", RULE, STATUS, "" ].join("\n");
    let pane = running;
    daemon.tmux = { isWindowAlive: vi.fn(async () => true), capturePane: vi.fn(async () => pane), getWindowId: () => "@1" };
    daemon.instanceStateMachine = new PaneStateMachine(daemon.backend.getReadyPattern(), 600_000, Date.now(), daemon.backend.getBusyPattern());
    daemon.instanceStateMonitorActive = true;
    // A stale "idle" cached from before (#1045's gap) must not decide it.
    daemon.instanceState = "idle";
    daemon.requestPauseWhenIdle({ reconfirmAuth: true });
    await vi.waitFor(() => expect(daemon.tmux.capturePane).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 20));
    expect(daemon.instanceState).toBe("working");
    expect(pauses).toEqual([]);
    expect(daemon.pausePending).toBe(true); // still deferred, not dropped
    // The turn ends with the failure still at the bottom: now it pauses.
    // The turn ends with the failure still at the bottom, and no output
    // arrives for the idle debounce: that capture is the real idle edge.
    pane = idlePane("◆ Looking at it.", AUTH);
    await new Promise(r => setTimeout(r, daemon.instanceStateIdleDebounceMs + 100));
    await daemon.captureAndEvaluateInstanceState("idle_debounce");
    expect(daemon.instanceState).toBe("idle");
    expect(pauses).toHaveLength(1);
  }, 15_000);

  it("the hit has scrolled out of the bottom rows → no pause", async () => {
    const more = Array.from({ length: 20 }, (_, i) => `  step ${i}: kept working`);
    const { pauses, directPause, daemon } = await idleMuseUnderLifecycle(
      idlePane("  so the refresh fails with: still unauthorized after a token refresh; run `muse login` again", ...more, "◆ Done."));
    expect(directPause).not.toHaveBeenCalled();
    expect(pauses).toEqual([]);
    expect(daemon.pausePending).toBe(false);
  });

  it("a real auth failure still at the bottom → paused", async () => {
    const { pauses, directPause } = await idleMuseUnderLifecycle(idlePane("◆ Looking at it.", AUTH));
    expect(directPause).not.toHaveBeenCalled(); // the pause comes from the daemon's decision
    expect(pauses).toHaveLength(1);
  });
});
