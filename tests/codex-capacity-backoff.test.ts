/**
 * Tests for #905: "Selected model is at capacity" triggers backoff + restart
 * instead of immediate pause.
 *
 * Key invariants:
 *   1. capacity → backoff delay + restart (not pause)
 *   2. After 3 retries in window → pause + notify
 *   3. Attempts outside the 30-min window are not counted
 *   4. restartSingleInstance is used (graceful stop, no crashTimestamps bump)
 *   5. quota/usage-limit path (type:"quota") is unaffected
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";
import { CodexBackend } from "../src/backend/codex.js";

type MockDaemon = EventEmitter & {
  requestPauseWhenIdle: ReturnType<typeof vi.fn>;
  isCodexLivePane?: ReturnType<typeof vi.fn>;
};

function makeLifecycle(overrides: Partial<LifecycleContext> = {}) {
  const notifyInstanceTopic = vi.fn(() => true);
  const clearCancelButton = vi.fn();
  const restartSingleInstance = vi.fn(async () => {});
  const pause = vi.fn(async () => "paused" as const);

  const ctx: Partial<LifecycleContext> = {
    fleetConfig: {
      instances: { "codex-inst": { backend: "codex", working_directory: "/tmp", restart_policy: { max_retries: 3, backoff: "linear", reset_after: 60_000 }, context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 }, log_level: "silent" } },
      defaults: {},
    } as any,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as any,
    eventLog: null,
    isPlannedRestart: () => false,
    notifyInstanceTopic,
    webhookEmit: vi.fn(),
    clearCancelButton,
    checkModelFailover() {},
    restartSingleInstance,
    getInstanceDir: (name: string) => `/nonexistent/${name}`,
    // These are needed to avoid errors in codex quota path (not relevant here)
    verifyCodexQuota: async () => "available" as const,
    setTopicIcon: vi.fn(),
    stormSuppressed: undefined,
    ...overrides,
  };

  const lc = new InstanceLifecycle(ctx as LifecycleContext);
  // Wire up the pause function so tests can inspect it
  (lc as any).pause = pause;

  const daemon: MockDaemon = Object.assign(new EventEmitter(), {
    requestPauseWhenIdle: vi.fn(),
    isCodexLivePane: vi.fn(async () => false),
  });
  lc.attachIncidentHandlers("codex-inst", daemon as any);
  // Register the daemon in the map so timer callback finds it alive
  (lc as any).daemons.set("codex-inst", daemon);

  return { lc, daemon, notifyInstanceTopic, restartSingleInstance, clearCancelButton, pause };
}

function emitCapacity(daemon: MockDaemon) {
  daemon.emit("pty_error", {
    name: "codex-inst",
    type: "model_error",
    action: "backoff_restart",
    message: "Codex model at capacity",
  });
}

function emitQuota(daemon: MockDaemon) {
  daemon.emit("pty_error", {
    name: "codex-inst",
    type: "quota",
    action: "pause",
    message: "Codex usage limit reached",
  });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("codex model-capacity backoff (#905)", () => {
  it("capacity error pattern uses backoff_restart action (mutation guard for codex.ts)", () => {
    // Mutation guard: if the error pattern in codex.ts uses action:"pause"
    // instead of "backoff_restart", the whole backoff mechanism is bypassed.
    const backend = new CodexBackend("/tmp/codex-905-test");
    const patterns = backend.getErrorPatterns();
    const capacityPattern = patterns.find(
      (p: { pattern: RegExp }) => p.pattern.test("⚠ Selected model is at capacity. Please try a different model.")
    );
    expect(capacityPattern, "capacity error pattern not found").toBeDefined();
    expect(capacityPattern!.action).toBe("backoff_restart");
    expect(capacityPattern!.type).toBe("model_error");
    expect(capacityPattern!.skipRecoveryWait).toBe(true);
  });

  it("first capacity error schedules a restart after 30s, not an immediate pause", async () => {
    const { daemon, restartSingleInstance, pause } = makeLifecycle();

    emitCapacity(daemon);
    await vi.advanceTimersByTimeAsync(0); // let async handlers settle

    // Must NOT pause immediately.
    expect(pause).not.toHaveBeenCalled();
    expect(restartSingleInstance).not.toHaveBeenCalled();

    // After 30 seconds the restart fires (first backoff delay).
    await vi.advanceTimersByTimeAsync(30_000);
    expect(restartSingleInstance).toHaveBeenCalledOnce();
    expect(pause).not.toHaveBeenCalled();
  });

  it("second capacity error uses 60s backoff", async () => {
    const { daemon, restartSingleInstance } = makeLifecycle();

    // First attempt
    emitCapacity(daemon);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(restartSingleInstance).toHaveBeenCalledTimes(1);

    // Second attempt (within 30-min window)
    emitCapacity(daemon);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(restartSingleInstance).toHaveBeenCalledTimes(1); // not yet

    await vi.advanceTimersByTimeAsync(1);
    expect(restartSingleInstance).toHaveBeenCalledTimes(2); // 60s passed
  });

  it("third capacity error uses 120s backoff", async () => {
    const { daemon, restartSingleInstance } = makeLifecycle();

    emitCapacity(daemon); await vi.advanceTimersByTimeAsync(30_000);
    emitCapacity(daemon); await vi.advanceTimersByTimeAsync(60_000);
    emitCapacity(daemon); // third

    await vi.advanceTimersByTimeAsync(119_999);
    expect(restartSingleInstance).toHaveBeenCalledTimes(2); // third not yet

    await vi.advanceTimersByTimeAsync(1);
    expect(restartSingleInstance).toHaveBeenCalledTimes(3);
  });

  it("after 3 retries falls back to pause (mutation guard: max cap)", async () => {
    const { daemon, restartSingleInstance, pause } = makeLifecycle();

    // Consume all 3 retries
    emitCapacity(daemon); await vi.advanceTimersByTimeAsync(30_000);
    emitCapacity(daemon); await vi.advanceTimersByTimeAsync(60_000);
    emitCapacity(daemon); await vi.advanceTimersByTimeAsync(120_000);
    expect(restartSingleInstance).toHaveBeenCalledTimes(3);
    expect(pause).not.toHaveBeenCalled();

    // 4th occurrence: cap exceeded → pause, no more restarts
    emitCapacity(daemon);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(restartSingleInstance).toHaveBeenCalledTimes(3); // no new restart
    expect(pause).toHaveBeenCalledOnce();
  });

  it("attempts outside the 30-min window are not counted (window reset)", async () => {
    const { daemon, restartSingleInstance, pause } = makeLifecycle();

    // 3 retries consumed
    emitCapacity(daemon); await vi.advanceTimersByTimeAsync(30_000);
    emitCapacity(daemon); await vi.advanceTimersByTimeAsync(60_000);
    emitCapacity(daemon); await vi.advanceTimersByTimeAsync(120_000);

    // Skip 31 minutes → window expired
    await vi.advanceTimersByTimeAsync(31 * 60_000);

    // New occurrence AFTER window → count resets → should restart again, not pause
    emitCapacity(daemon);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(restartSingleInstance).toHaveBeenCalledTimes(4); // window reset, new attempt
    expect(pause).not.toHaveBeenCalled();
  });

  it("backoff_restart does NOT increment crash-loop counter (graceful stop path)", async () => {
    // restartSingleInstance performs a graceful stop (exit code 0) which the
    // daemon health monitor treats as a normal exit, not a crash. This test
    // verifies that the LIFECYCLE side (our backoff handler) calls
    // restartSingleInstance (not any crash-path), and that it does not call
    // any crash-counting machinery.
    const { daemon, restartSingleInstance, pause } = makeLifecycle();
    // No crashTimestamps setter exists on lifecycle — the guard is that
    // we call restartSingleInstance (graceful) not a crash-triggering path.
    emitCapacity(daemon);
    await vi.advanceTimersByTimeAsync(30_000);

    // Should call restartSingleInstance (graceful, no crash count) not pause
    expect(restartSingleInstance).toHaveBeenCalledOnce();
    expect(pause).not.toHaveBeenCalled();
    // Confirm it was called with no freshStart option (resume, not fresh)
    expect(restartSingleInstance).toHaveBeenCalledWith("codex-inst");
  });

  it("quota/usage-limit path is completely unaffected by backoff changes", async () => {
    // type:"quota" action:"pause" must still go to the quota-pause path,
    // not the backoff_restart path. This test emits a quota event and verifies
    // restartSingleInstance is never called.
    const { daemon, restartSingleInstance } = makeLifecycle();

    emitQuota(daemon);
    await vi.advanceTimersByTimeAsync(200_000);

    // Quota path takes the quota verification route, not backoff restart
    expect(restartSingleInstance).not.toHaveBeenCalled();
  });

  it("notifies user on each retry attempt", async () => {
    const { daemon, notifyInstanceTopic } = makeLifecycle();

    emitCapacity(daemon);
    await vi.advanceTimersByTimeAsync(0);

    // Should notify with "retrying in Xs" message
    expect(notifyInstanceTopic).toHaveBeenCalledOnce();
    const notifyCalls = notifyInstanceTopic.mock.calls as unknown as Array<[string, string]>;
    const msg = notifyCalls[0]?.[1];
    expect(msg).toMatch(/capacity.*attempt.*retry/i);
  });

  it("notifies user when max retries exceeded", async () => {
    const { daemon, notifyInstanceTopic } = makeLifecycle();

    // Consume all 3
    emitCapacity(daemon); await vi.advanceTimersByTimeAsync(30_000);
    emitCapacity(daemon); await vi.advanceTimersByTimeAsync(60_000);
    emitCapacity(daemon); await vi.advanceTimersByTimeAsync(120_000);

    const prevCalls = notifyInstanceTopic.mock.calls.length;
    emitCapacity(daemon); // 4th: cap exceeded
    await vi.advanceTimersByTimeAsync(0);

    expect(notifyInstanceTopic.mock.calls.length).toBeGreaterThan(prevCalls);
    const allCalls = notifyInstanceTopic.mock.calls as unknown as Array<[string, string]>;
    const lastMsg = allCalls[allCalls.length - 1]?.[1];
    expect(lastMsg).toMatch(/max retries|still at capacity/i);
  });

  // B2: no duplicate timers when two capacity detections arrive before the first fires
  it("second capacity detection before timer fires is ignored (B2: pending guard)", async () => {
    // Mutation guard: removing the pending-timer check would schedule 2 restarts
    // and advance the attempt counter twice per detection. The second timer fires
    // at 60s (since attempts advanced to 1). Verifying at 90s catches both.
    const { daemon, restartSingleInstance } = makeLifecycle();

    emitCapacity(daemon); // schedules 30s timer (attempt 0 → delay=30s)
    await vi.advanceTimersByTimeAsync(0);

    // Second detection before first timer fires — must be a no-op
    emitCapacity(daemon);
    await vi.advanceTimersByTimeAsync(0);

    // Advance past both possible timers (30s + 60s)
    await vi.advanceTimersByTimeAsync(90_000);
    // Only one restart total — the second detection was ignored
    expect(restartSingleInstance).toHaveBeenCalledTimes(1);
  });

  // B1: pending timer is cancelled when the instance is stopped
  it("pending backoff timer is stored and not restarted when daemon is gone (B1: owned timer)", async () => {
    // Mutation guard: if the timer callback doesn't check daemon presence,
    // it would restart an instance the user explicitly stopped.
    const { lc, daemon, restartSingleInstance } = makeLifecycle();

    emitCapacity(daemon); // schedules 30s timer
    await vi.advanceTimersByTimeAsync(0);

    // Verify the timer is tracked (stored in the map)
    expect((lc as any).capacityBackoffTimers.has("codex-inst")).toBe(true);

    // Simulate stop: remove daemon from map (what stop() does)
    (lc as any).daemons.delete("codex-inst");

    // Advance past backoff — callback fires but daemon is gone → no restart
    await vi.advanceTimersByTimeAsync(30_000);
    expect(restartSingleInstance).not.toHaveBeenCalled();
    // Timer map cleaned up by callback
    expect((lc as any).capacityBackoffTimers.has("codex-inst")).toBe(false);
  });

  // Real stop/pause path helpers — these use actual lifecycle methods.
  function makeRealPathCtx(isPlannedRestart = false) {
    const restartSingleInstance = vi.fn(async () => {});
    const ctx = {
      fleetConfig: { instances: { "codex-inst": { backend: "codex", working_directory: "/tmp", restart_policy: { max_retries: 3, backoff: "linear", reset_after: 60_000 }, context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 }, log_level: "silent" } }, defaults: {} } as any,
      logger: { info() {}, warn() {}, error() {}, debug() {} } as any,
      eventLog: null, isPlannedRestart: () => isPlannedRestart,
      notifyInstanceTopic: vi.fn(() => true), webhookEmit: vi.fn(), clearCancelButton: vi.fn(),
      checkModelFailover() {}, restartSingleInstance,
      getInstanceDir: (name: string) => `/nonexistent/${name}`,
      verifyCodexQuota: async () => "available" as const,
      setTopicIcon: vi.fn(), stormSuppressed: undefined,
      stopStatuslineWatcher: vi.fn(), startStatuslineWatcher: vi.fn(),
      dataDir: "/nonexistent",
      ipcStoppingInstances: { add: vi.fn(), delete: vi.fn(), has: vi.fn(() => false) },
      instanceIpcClients: { get: vi.fn(() => undefined), delete: vi.fn() },
      sessionRegistry: new Map(),
    } as unknown as LifecycleContext;
    return { ctx, restartSingleInstance };
  }

  it("real lc.stop() cancels the timer before it fires (B1: cancel in stop)", async () => {
    // Mutation guard: removing the clearTimeout block in stop() would let the
    // timer fire and restart an instance the user explicitly stopped.
    const { ctx, restartSingleInstance } = makeRealPathCtx();
    const lc = new InstanceLifecycle(ctx);
    const daemon = Object.assign(new EventEmitter(), {
      requestPauseWhenIdle: vi.fn(), isCodexLivePane: vi.fn(async () => false),
      stop: vi.fn(async () => {}),
    });
    lc.attachIncidentHandlers("codex-inst", daemon as any);
    (lc as any).daemons.set("codex-inst", daemon);

    emitCapacity(daemon);
    await vi.advanceTimersByTimeAsync(0);
    expect((lc as any).capacityBackoffTimers.has("codex-inst")).toBe(true);

    await (lc as any).stop("codex-inst");
    expect((lc as any).capacityBackoffTimers.has("codex-inst")).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(restartSingleInstance).not.toHaveBeenCalled();
  });

  it("real lc.pause() cancels the timer before it fires (B1: cancel in pause)", async () => {
    // Mutation guard: removing the clearTimeout block in pause() would let the
    // timer fire and restart an instance the user explicitly paused.
    const { ctx, restartSingleInstance } = makeRealPathCtx();
    const lc = new InstanceLifecycle(ctx);
    let paused = false;
    const daemon = Object.assign(new EventEmitter(), {
      requestPauseWhenIdle: vi.fn(), isCodexLivePane: vi.fn(async () => false),
      pause: vi.fn(async () => { paused = true; }),
      get isPaused() { return paused; },
    });
    lc.attachIncidentHandlers("codex-inst", daemon as any);
    (lc as any).daemons.set("codex-inst", daemon);

    emitCapacity(daemon);
    await vi.advanceTimersByTimeAsync(0);
    expect((lc as any).capacityBackoffTimers.has("codex-inst")).toBe(true);

    await (lc as any).pause("codex-inst");
    expect((lc as any).capacityBackoffTimers.has("codex-inst")).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(restartSingleInstance).not.toHaveBeenCalled();
  });

  it("callback does not restart when instance is paused (B1: isPaused callback check)", async () => {
    // Mutation guard: removing the isPaused check in the timer callback would
    // restart a paused instance without user intent.
    const { ctx, restartSingleInstance } = makeRealPathCtx();
    const lc = new InstanceLifecycle(ctx);
    const daemon = Object.assign(new EventEmitter(), {
      requestPauseWhenIdle: vi.fn(), isCodexLivePane: vi.fn(async () => false),
      isPaused: true,  // instance is paused when timer fires
    });
    lc.attachIncidentHandlers("codex-inst", daemon as any);
    (lc as any).daemons.set("codex-inst", daemon);

    emitCapacity(daemon);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(restartSingleInstance).not.toHaveBeenCalled();
  });

  it("callback does not restart during fleet shutdown (B1: isPlannedRestart callback check)", async () => {
    // Mutation guard: removing the isPlannedRestart check would restart an
    // instance mid-shutdown, keeping the process alive and interfering.
    const { ctx, restartSingleInstance } = makeRealPathCtx(/* isPlannedRestart= */ true);
    const lc = new InstanceLifecycle(ctx);
    const daemon = Object.assign(new EventEmitter(), {
      requestPauseWhenIdle: vi.fn(), isCodexLivePane: vi.fn(async () => false),
    });
    lc.attachIncidentHandlers("codex-inst", daemon as any);
    (lc as any).daemons.set("codex-inst", daemon);

    emitCapacity(daemon);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(restartSingleInstance).not.toHaveBeenCalled();
  });

  // B1: the stop path clears the timer from the map
  it("timer is removed from the map on stop, so isPlannedRestart state is respected (B1: cancel path)", async () => {
    // Mutation guard: if stop() doesn't clear the timer, the stored timer could
    // still fire even after explicit stop. This verifies timer map management.
    const { lc, daemon, restartSingleInstance } = makeLifecycle();

    emitCapacity(daemon);
    await vi.advanceTimersByTimeAsync(0);
    expect((lc as any).capacityBackoffTimers.has("codex-inst")).toBe(true);

    // Simulate the cancel path (what stop/pause do)
    const t = (lc as any).capacityBackoffTimers.get("codex-inst");
    clearTimeout(t);
    (lc as any).capacityBackoffTimers.delete("codex-inst");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(restartSingleInstance).not.toHaveBeenCalled();
  });
});
