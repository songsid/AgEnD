import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { CodexBackend } from "../src/backend/codex.js";
import { InstanceLifecycle, type IncidentEventSource, type LifecycleContext } from "../src/instance-lifecycle.js";
import { setLocale } from "../src/locale.js";

/**
 * Codex "Selected model is at capacity" (#905): the user is told, and about a minute later the daemon tells the agent to
 * keep going — once per episode, only into a screen that has not changed, never into a stopped / paused / busy instance.
 * The tmux is a stub serving a scripted pane; the daemon's own pane write is a spy. Nothing here starts Codex, a fleet or
 * a tmux server.
 */
const CAPACITY = "⚠ Selected model is at capacity. Please try a different model.";
const PANE = `  › earlier turn\n\n${CAPACITY}\n\n  ›  Ask Codex to do anything\n`;

let dir: string;
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger } as any;
beforeEach(() => { vi.useFakeTimers(); dir = mkdtempSync(join(tmpdir(), "agend-capacity-nudge-")); mkdirSync(join(dir, "inst")); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); setLocale("en"); });

function rig() {
  const screen = { text: PANE };
  const sent: string[] = [];
  const d: any = new Daemon("cx", {
    working_directory: dir, backend: "codex", log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
  } as any, join(dir, "inst"), false, new CodexBackend(join(dir, "inst")) as any, undefined, logger);
  d.processStatus = "running";
  d.tmux = {
    isWindowAlive: async () => true,
    capturePane: async () => screen.text,
    capturePaneWithHistory: async () => screen.text,
    sendSpecialKey: async () => true,
    pasteText: async () => true,
    getWindowId: () => "@1",
  };
  const idle = { value: true };
  d.isPaneAuthoritativelyIdle = async () => idle.value;
  d.submitSystemPaste = vi.fn(async (text: string) => { sent.push(text); return true; });
  const errors: any[] = [];
  d.on("pty_error", (event: any) => {
    errors.push(event);
    if (event.action === "nudge_continue") d.armCapacityNudge(event.pattern, 60_000);   // what the lifecycle does
  });
  d.startErrorMonitor();
  const poll = (ms = 5_000) => vi.advanceTimersByTimeAsync(ms);
  return { d, screen, sent, errors, idle, poll, stop: () => clearInterval(d.errorMonitorTimer) };
}

describe("the daemon's continue nudge", () => {
  it("is sent once, about a minute after the capacity error, and the user-facing event is still emitted", async () => {
    const { errors, sent, poll, stop } = rig();
    await poll(5_100);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: "model_error", action: "nudge_continue" });
    await poll(50_000);
    expect(sent).toEqual([]);                               // not before it is due
    await poll(10_000);
    expect(sent).toEqual(["keep going"]);
    await poll(300_000);
    expect(sent).toEqual(["keep going"]);                   // once per episode — not once per poll
    stop();
  });

  it("says it in the user's language", async () => {
    setLocale("zh-TW");
    const { sent, poll, stop } = rig();
    await poll(70_000);
    expect(sent).toEqual(["繼續"]);
    stop();
  });

  it("a NEW capacity line after the nudge is a new episode: a second nudge", async () => {
    const { screen, sent, errors, poll, stop } = rig();
    await poll(70_000);
    expect(sent).toHaveLength(1);
    screen.text = `${PANE}\n  › keep going\n${CAPACITY}\n\n  ›  Ask Codex to do anything\n`;   // it failed again
    await poll(5_100);
    expect(errors).toHaveLength(2);                         // skipCooldown: seen at once, not after 5 minutes
    await poll(60_000);
    expect(sent).toHaveLength(2);
    stop();
  });

  describe("is cancelled — not postponed — when anything moved", () => {
    it("the screen changed within the minute (even if it later looks the same again)", async () => {
      const { screen, sent, poll, stop } = rig();
      await poll(5_100);
      screen.text = `${PANE}  typing…\n`;
      await poll(10_000);
      screen.text = PANE;
      await poll(120_000);
      expect(sent).toEqual([]);
      stop();
    });

    it("the capacity line scrolled away", async () => {
      const { screen, sent, poll, stop } = rig();
      await poll(5_100);
      screen.text = "  › Ask Codex to do anything\n";
      await poll(120_000);
      expect(sent).toEqual([]);
      stop();
    });

    it("the agent started working on its own", async () => {
      const { d, sent, poll, stop } = rig();
      await poll(5_100);
      d.instanceState = "working";
      await poll(120_000);
      expect(sent).toEqual([]);
      stop();
    });

    it("a message is waiting for delivery (it will start a turn anyway)", async () => {
      const { d, sent, poll, stop } = rig();
      await poll(5_100);
      d.pasteQueueDepth = 1;
      await poll(120_000);
      expect(sent).toEqual([]);
      stop();
    });

    it("the user cancelled pending deliveries", async () => {
      const { d, sent, poll, stop } = rig();
      await poll(5_100);
      d.clearPendingDeliveries();
      await poll(120_000);
      expect(sent).toEqual([]);
      stop();
    });

    it("the instance is paused / not running", async () => {
      const paused = rig();
      await paused.poll(5_100);
      paused.d.pauseWakeState = "paused";
      await paused.poll(120_000);
      expect(paused.sent).toEqual([]);
      paused.stop();
      const down = rig();
      await down.poll(5_100);
      down.d.processStatus = "stopped";
      await down.poll(120_000);
      expect(down.sent).toEqual([]);
      down.stop();
    });

    it("a stop / pause (the monitors froze) and a respawn", async () => {
      const frozen = rig();
      await frozen.poll(5_100);
      frozen.d.freezeRuntimeMonitors();
      await frozen.poll(120_000);
      expect(frozen.sent).toEqual([]);
      const respawned = rig();
      await respawned.poll(5_100);
      respawned.d.beginSpawn(); respawned.d.endSpawn();
      await respawned.poll(120_000);
      expect(respawned.sent).toEqual([]);
      respawned.stop();
    });
  });

  describe("the injection itself re-verifies, under the pane-write lock", () => {
    /** Hold the lock so the due nudge has to wait for it; `release` lets it through. */
    async function waitingForLock(r: ReturnType<typeof rig>) {
      let release!: () => void;
      const hold = r.d.paneWriteLock.run(() => new Promise<void>(resolve => { release = resolve; }));
      await r.poll(70_000);                                  // due: the nudge now waits for the lock
      return { release: () => { release(); return hold; } };
    }

    it("a screen that changed while it waited for the lock", async () => {
      const r = rig();
      await r.poll(5_100);
      const lock = await waitingForLock(r);
      r.screen.text = `${PANE}  a person typed here\n`;
      await lock.release(); await r.poll(1_000);
      expect(r.sent).toEqual([]);
      r.stop();
    });

    it("a stop while it waited for the lock", async () => {
      const r = rig();
      await r.poll(5_100);
      const lock = await waitingForLock(r);
      r.d.freezeRuntimeMonitors();
      await lock.release(); await r.poll(1_000);
      expect(r.sent).toEqual([]);
    });

    it("a CLI that is not idle when it gets the lock", async () => {
      const r = rig();
      await r.poll(5_100);
      const lock = await waitingForLock(r);
      r.idle.value = false;
      await lock.release(); await r.poll(1_000);
      expect(r.sent).toEqual([]);
      r.stop();
    });

    it("a message queued while it waited for the lock", async () => {
      const r = rig();
      await r.poll(5_100);
      const lock = await waitingForLock(r);
      r.d.pasteQueueDepth = 1;
      await lock.release(); await r.poll(1_000);
      expect(r.sent).toEqual([]);
      r.stop();
    });

    it("an untouched one goes through the daemon's own pane-write path, exactly once", async () => {
      const r = rig();
      await r.poll(5_100);
      const lock = await waitingForLock(r);
      await lock.release(); await r.poll(1_000);
      expect(r.d.submitSystemPaste).toHaveBeenCalledTimes(1);
      expect(r.d.submitSystemPaste).toHaveBeenCalledWith("keep going", "capacity-continue");
      r.stop();
    });
  });

  describe("the due time is on the monotonic clock", () => {
    it("a wall clock stepped BACK an hour does not delay it", async () => {
      const { sent, poll, stop } = rig();
      await poll(5_100);
      vi.setSystemTime(Date.now() - 3_600_000);
      await poll(60_000);
      expect(sent).toEqual(["keep going"]);
      stop();
    });

    it("a wall clock stepped FORWARD an hour does not fire it early", async () => {
      const { sent, poll, stop } = rig();
      await poll(5_100);
      vi.setSystemTime(Date.now() + 3_600_000);
      await poll(30_000);
      expect(sent).toEqual([]);
      await poll(35_000);
      expect(sent).toEqual(["keep going"]);
      stop();
    });
  });

  describe("arming", () => {
    it("is refused for an occurrence of another pattern, or one seen under another spawn", async () => {
      const { d, errors, poll, stop } = rig();
      await poll(5_100);
      expect(errors).toHaveLength(1);
      expect(d.armCapacityNudge(/something else/, 60_000)).toBe(false);
      d.beginSpawn(); d.endSpawn();
      expect(d.armCapacityNudge(errors[0].pattern, 60_000)).toBe(false);
      stop();
    });

    it("can be cancelled by the lifecycle", async () => {
      const { d, sent, poll, stop } = rig();
      await poll(5_100);
      d.cancelCapacityNudge("retries exhausted");
      await poll(120_000);
      expect(sent).toEqual([]);
      stop();
    });
  });
});

describe("the lifecycle: the user is told, and a nudge is allowed three times per 30 minutes", () => {
  function lifecycle() {
    const notifyInstanceTopic = vi.fn(() => true);
    const restartSingleInstance = vi.fn(async () => {});
    const ctx = {
      fleetConfig: { defaults: { backend: "codex" }, instances: { general: { general_topic: true }, w: { backend: "codex" } } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      dataDir: dir, getInstanceDir: (name: string) => join(dir, name),
      eventLog: { insert: vi.fn() }, isPlannedRestart: () => false, isClassicInstance: () => false,
      notifyInstanceTopic, notifyFleetError: vi.fn(), webhookEmit: vi.fn(), clearCancelButton: vi.fn(),
      checkModelFailover: vi.fn(), restartSingleInstance, setTopicIcon: vi.fn(),
    } as unknown as LifecycleContext;
    const lc = new InstanceLifecycle(ctx);
    const pause = vi.fn(async () => "paused" as const);
    (lc as any).pause = pause;
    const arm = vi.fn(() => true);
    const cancel = vi.fn();
    const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle: vi.fn(), armCapacityNudge: arm, cancelCapacityNudge: cancel }) as IncidentEventSource & EventEmitter;
    lc.attachIncidentHandlers("w", daemon);
    (lc as any).daemons.set("w", daemon);
    const pattern = new CodexBackend(dir).getErrorPatterns().find(p => p.pattern.test(CAPACITY))!.pattern;
    const emit = () => daemon.emit("pty_error", { name: "w", type: "model_error", action: "nudge_continue", message: "x", pattern });
    return { lc, daemon, emit, arm, cancel, notifyInstanceTopic, restartSingleInstance, pause, pattern };
  }

  it("tells the user, arms a 60 s nudge, and neither restarts nor pauses", async () => {
    const { emit, arm, notifyInstanceTopic, restartSingleInstance, pause, pattern } = lifecycle();
    emit();
    await vi.advanceTimersByTimeAsync(0);
    expect(arm).toHaveBeenCalledWith(pattern, 60_000);
    expect(notifyInstanceTopic).toHaveBeenCalledWith("w", expect.stringMatching(/at capacity.*attempt 1\/3.*keep going in 60s/));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(restartSingleInstance).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });

  it("the fourth in a window is not nudged: the user is told and the instance is paused", async () => {
    const { emit, arm, cancel, notifyInstanceTopic, pause } = lifecycle();
    for (let i = 0; i < 3; i++) { emit(); await vi.advanceTimersByTimeAsync(70_000); }
    expect(arm).toHaveBeenCalledTimes(3);
    emit();
    await vi.advanceTimersByTimeAsync(0);
    expect(arm).toHaveBeenCalledTimes(3);
    expect(cancel).toHaveBeenCalledWith("retries exhausted");
    expect(notifyInstanceTopic).toHaveBeenLastCalledWith("w", expect.stringMatching(/still at capacity after 3 retries/));
    expect(pause).toHaveBeenCalledOnce();
  });

  it("the window is 30 minutes — and a wall clock that stepped back does not keep an old window alive", async () => {
    const aged = lifecycle();
    for (let i = 0; i < 3; i++) { aged.emit(); await vi.advanceTimersByTimeAsync(70_000); }
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    aged.emit();
    await vi.advanceTimersByTimeAsync(0);
    expect(aged.arm).toHaveBeenCalledTimes(4);
    expect(aged.pause).not.toHaveBeenCalled();
    const stepped = lifecycle();
    for (let i = 0; i < 3; i++) { stepped.emit(); await vi.advanceTimersByTimeAsync(70_000); }
    vi.setSystemTime(Date.now() - 3_600_000);
    stepped.emit();
    await vi.advanceTimersByTimeAsync(0);
    expect(stepped.arm).toHaveBeenCalledTimes(4);
    expect(stepped.pause).not.toHaveBeenCalled();
  });

  it("when nothing can be armed (the screen already moved on) the user still hears of it and no attempt is used", async () => {
    const { emit, arm, notifyInstanceTopic, pause } = lifecycle();
    arm.mockReturnValue(false);
    for (let i = 0; i < 5; i++) { emit(); await vi.advanceTimersByTimeAsync(0); }
    expect(notifyInstanceTopic).toHaveBeenCalledTimes(5);
    expect(notifyInstanceTopic).toHaveBeenLastCalledWith("w", expect.stringMatching(/at capacity/));
    expect(pause).not.toHaveBeenCalled();
  });

  it("says it in zh-TW", async () => {
    setLocale("zh-TW");
    const { emit, notifyInstanceTopic } = lifecycle();
    emit();
    await vi.advanceTimersByTimeAsync(0);
    expect(notifyInstanceTopic).toHaveBeenCalledWith("w", expect.stringMatching(/擁擠.*60 秒後會叫它繼續/));
  });
});
