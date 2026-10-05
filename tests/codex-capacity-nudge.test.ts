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
const KEY = "model_error:" + new CodexBackend("/tmp/codex-capacity-nudge-key").getErrorPatterns().find(p => p.pattern.test(CAPACITY))!.pattern.source;
const IDLE = "• earlier answer\n\n› Ask Codex to do anything\n  Context 100% left";
const PANE = `• earlier answer\n\n${CAPACITY}\n\n› Ask Codex to do anything\n  Context 100% left`;

let dir: string;
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger } as any;
beforeEach(() => { vi.useFakeTimers(); dir = mkdtempSync(join(tmpdir(), "agend-capacity-nudge-")); mkdirSync(join(dir, "inst")); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); setLocale("en"); });

function rig(opts: { baselineTaken?: boolean; start?: string } = {}) {
  const screen = { text: opts.start ?? PANE, reads: 0, holdRead: null as number | null, holdPaste: false, holdEnter: false, release: null as (() => void) | null };
  const sent: string[] = [];                              // what reached the pane through paste
  const enters = { count: 0 };
  const d: any = new Daemon("cx", {
    working_directory: dir, backend: "codex", log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
  } as any, join(dir, "inst"), false, new CodexBackend(join(dir, "inst")) as any, undefined, logger);
  d.processStatus = "running";
  d.tmux = {
    isWindowAlive: async () => true,
    capturePane: async () => {
      if (screen.holdRead !== null && ++screen.reads === screen.holdRead) await new Promise<void>(resolve => { screen.release = resolve; });
      return screen.text;
    },
    capturePaneWithHistory: async () => screen.text,
    sendSpecialKey: async (key: string) => {
      if (key === "Enter") { if (screen.holdEnter) await new Promise<void>(resolve => { screen.release = resolve; }); enters.count++; }
      return true;
    },
    pasteBuffer: async (text: string) => {
      if (screen.holdPaste) await new Promise<void>(resolve => { screen.release = resolve; });
      sent.push(text);
      return true;
    },
    getLastSendSpecialKeyError: () => null,
    pasteText: async () => true,
    getWindowId: () => "@1",
  };
  const idle = { value: true };
  const realIdle = d.paneAuthoritativelyIdle.bind(d);
  d.paneAuthoritativelyIdle = (pane: string) => idle.value && realIdle(pane);
  const realSend = d.sendCapacityNudge.bind(d);
  d.sendCapacityNudge = vi.fn(realSend);                  // "was the injection even attempted" — what the poll-level checks decide
  d.confirmSubmitted = async () => "submitted";            // the pane write is what is under test, not Codex's echo
  const realSubmit = d.submitSystemPaste.bind(d);
  d.submitSystemPaste = vi.fn(realSubmit);
  const errors: any[] = [];
  d.on("pty_error", (event: any) => {
    errors.push(event);
    if (event.action === "nudge_continue") d.armCapacityNudge(event.pattern, 60_000);   // what the lifecycle does
  });
  // The first live composer of the spawn fixed what is history; here there was none yet (a clean session).
  if (opts.baselineTaken !== false) d.nudgeBaselines = new Map([[KEY, 0]]);
  d.startErrorMonitor();
  const poll = (ms = 5_000) => vi.advanceTimersByTimeAsync(ms);
  return { d, screen, sent, enters, errors, idle, poll, stop: () => clearInterval(d.errorMonitorTimer) };
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
    screen.text = `• earlier answer\n\n${CAPACITY}\n\n› keep going\n${CAPACITY}\n\n› Ask Codex to do anything\n  Context 100% left`;   // it failed again
    await poll(5_100);
    expect(errors).toHaveLength(2);                         // skipCooldown: seen at once, not after 5 minutes
    await poll(60_000);
    expect(sent).toHaveLength(2);
    stop();
  });

  describe("is cancelled — not postponed — when anything moved (decided by the poll: the injection is not even attempted)", () => {
    it("the screen changed within the minute (even if it later looks the same again)", async () => {
      const { d, screen, sent, poll, stop } = rig();
      await poll(5_100);
      screen.text = `${PANE}  typing…\n`;
      await poll(10_000);
      screen.text = PANE;
      await poll(120_000);
      expect(sent).toEqual([]);
      expect(d.sendCapacityNudge).not.toHaveBeenCalled();
      stop();
    });

    it("the capacity line scrolled away", async () => {
      const { d, screen, sent, poll, stop } = rig();
      await poll(5_100);
      screen.text = IDLE;
      await poll(120_000);
      expect(sent).toEqual([]);
      expect(d.sendCapacityNudge).not.toHaveBeenCalled();
      stop();
    });

    it("the agent started working on its own", async () => {
      const { d, sent, poll, stop } = rig();
      await poll(5_100);
      d.instanceState = "working";
      await poll(120_000);
      expect(sent).toEqual([]);
      expect(d.sendCapacityNudge).not.toHaveBeenCalled();
      stop();
    });

    it("a message is waiting for delivery (it will start a turn anyway)", async () => {
      const { d, sent, poll, stop } = rig();
      await poll(5_100);
      d.pasteQueueDepth = 1;
      await poll(120_000);
      expect(sent).toEqual([]);
      expect(d.sendCapacityNudge).not.toHaveBeenCalled();
      stop();
    });

    it("the user cancelled pending deliveries", async () => {
      const { d, sent, poll, stop } = rig();
      await poll(5_100);
      d.clearPendingDeliveries();
      await poll(120_000);
      expect(sent).toEqual([]);
      expect(d.sendCapacityNudge).not.toHaveBeenCalled();
      stop();
    });

    it("the instance is paused", async () => {
      const r = rig();
      await r.poll(5_100);
      r.d.pauseWakeState = "paused";
      await r.poll(120_000);
      expect(r.sent).toEqual([]);
      expect(r.d.sendCapacityNudge).not.toHaveBeenCalled();
      r.stop();
    });

    it("the process is not running", async () => {
      const r = rig();
      await r.poll(5_100);
      r.d.processStatus = "stopped";
      await r.poll(120_000);
      expect(r.sent).toEqual([]);
      expect(r.d.sendCapacityNudge).not.toHaveBeenCalled();
      r.stop();
    });

    it("a stop / pause (the monitors froze): dropped, and the poll does not run again anyway", async () => {
      const r = rig();
      await r.poll(5_100);
      r.d.freezeRuntimeMonitors();
      await r.poll(120_000);
      expect(r.sent).toEqual([]);
      expect(r.d.sendCapacityNudge).not.toHaveBeenCalled();
    });

    it("a poll that was already running when the monitors froze drops it at the fence", async () => {
      const r = rig();
      await r.poll(5_100);
      r.d.freezeRuntimeMonitors();
      r.d.tickCapacityNudge(PANE);                           // the in-flight poll's look
      expect(r.d.capacityNudge).toBeNull();
      expect(r.d.sendCapacityNudge).not.toHaveBeenCalled();
    });

    it("a respawn: the armed nudge is dropped with the old spawn, and nothing is sent", async () => {
      const r = rig();
      await r.poll(5_100);
      expect(r.d.capacityNudge).not.toBeNull();
      r.d.beginSpawn(); r.d.endSpawn();
      expect(r.d.capacityNudge).toBeNull();
      await r.poll(120_000);
      expect(r.sent).toEqual([]);
      r.stop();
    });

    it("a spawn generation change alone (nothing reset it) is caught by the poll's fence", async () => {
      const r = rig();
      await r.poll(5_100);
      r.d.spawnGeneration += 1;
      r.d.tickCapacityNudge(PANE);
      expect(r.d.capacityNudge).toBeNull();
      expect(r.d.sendCapacityNudge).not.toHaveBeenCalled();
    });

    it("a monitor-epoch change alone is caught too", async () => {
      const r = rig();
      await r.poll(5_100);
      r.d.launchFenceEpoch += 1;
      r.d.tickCapacityNudge(PANE);
      expect(r.d.capacityNudge).toBeNull();
      expect(r.d.sendCapacityNudge).not.toHaveBeenCalled();
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

    it("the user cancelled while it waited for the lock", async () => {
      const r = rig();
      await r.poll(5_100);
      const lock = await waitingForLock(r);
      r.d.clearPendingDeliveries();
      await lock.release(); await r.poll(1_000);
      expect(r.sent).toEqual([]);
      r.stop();
    });

    it("the instance was paused while it waited for the lock", async () => {
      const r = rig();
      await r.poll(5_100);
      const lock = await waitingForLock(r);
      r.d.pauseWakeState = "paused";
      await lock.release(); await r.poll(1_000);
      expect(r.sent).toEqual([]);
      r.stop();
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
      expect(r.d.submitSystemPaste).toHaveBeenCalledWith("keep going", "capacity-continue", expect.objectContaining({ current: expect.any(Function), accept: expect.any(Function) }));
      expect(r.sent).toEqual(["keep going"]);
      expect(r.enters.count).toBe(1);
      r.stop();
    });
  });

  describe("the paste primitive carries the nudge's own fences: a cancelled nudge adds no paste and no key", () => {
    const interruptions: Array<[string, (d: any) => void]> = [
      ["the user cancelled", d => d.clearPendingDeliveries()],
      ["the monitors froze (stop / pause)", d => d.freezeRuntimeMonitors()],
      ["the instance was paused", d => { d.pauseWakeState = "paused"; }],
      ["the process stopped", d => { d.processStatus = "stopped"; }],
      ["a message was queued for delivery", d => { d.pasteQueueDepth = 1; }],
      ["the agent started a turn", d => { d.instanceState = "working"; }],
      ["a new spawn began (nothing else changed)", d => { d.spawnGeneration += 1; }],
    ];
    /** Run to just before the nudge is due, then let `arrange` set up a hold on one of its pane operations. */
    async function dueWith(arrange: (r: ReturnType<typeof rig>) => void, thenMs = 1_500) {
      const r = rig();
      await r.poll(5_100);                                   // the error is seen and the nudge armed (due at ~65 s)
      await r.poll(59_000);
      arrange(r);
      await r.poll(thenMs);                                  // the poll that makes it due runs; the primitive starts
      return r;
    }

    it.each(interruptions)("%s while its capture is pending: nothing is pasted, no key", async (_name, interrupt) => {
      const r = await dueWith(x => { x.screen.holdRead = x.screen.reads + 2; });   // +1 = the poll's own read, +2 = the primitive's
      expect(r.sent).toEqual([]);
      interrupt(r.d);
      r.screen.release?.();
      await r.poll(5_000);
      expect(r.sent).toEqual([]);
      expect(r.enters.count).toBe(0);
    });

    it.each(interruptions)("%s while its paste is pending: no key follows", async (_name, interrupt) => {
      const r = await dueWith(x => { x.screen.holdPaste = true; });
      interrupt(r.d);
      r.screen.holdPaste = false;
      r.screen.release?.();
      await r.poll(10_000);
      expect(r.enters.count).toBe(0);                       // (the paste itself had already begun — no Enter ever submits it)
    });

    it.each(interruptions)("%s during the pause between the paste and the Enter: no key", async (_name, interrupt) => {
      const r = await dueWith(() => {}, 1_200);
      expect(r.sent).toEqual(["keep going"]);               // pasted…
      expect(r.enters.count).toBe(0);                       // …Enter not yet (settling)
      interrupt(r.d);
      await r.poll(10_000);
      expect(r.enters.count).toBe(0);
    });

    it("a draft that appeared before the primitive's capture is refused — even one that still looks like an idle composer", async () => {
      const r = await dueWith(x => { x.screen.holdRead = x.screen.reads + 2; });
      r.screen.text = PANE.replace("› Ask Codex to do anything", "› please also check the logs");   // a person typed
      r.screen.release?.();
      await r.poll(10_000);
      expect(r.sent).toEqual([]);
      expect(r.enters.count).toBe(0);
    });

    it("ONE capture decides: it is the baseline, the expected-screen check and the idle check (no second picture before the paste)", async () => {
      let holdAt = 0;
      const r = await dueWith(x => { holdAt = x.screen.reads + 2; x.screen.holdRead = holdAt; });
      r.screen.release?.();
      await r.poll(700);                                     // the paste and the Enter (after its 500 ms settle) complete; no poll is due yet
      expect(r.sent).toEqual(["keep going"]);
      expect(r.enters.count).toBe(1);
      expect(r.screen.reads).toBe(holdAt);                   // the primitive's capture was the only picture it took
    });

    it("the RETRY Enter (the first one was not seen to submit) is guarded too", async () => {
      const r = rig();
      let proofs = 0;
      r.d.confirmSubmitted = async () => (++proofs === 1 ? "stranded" : "submitted");   // the first Enter did not take
      await r.poll(5_100);
      await r.poll(59_000);
      await r.poll(1_800);                                   // paste (65.0), Enter (65.5), proof 'stranded', now in the pause before the retry
      expect(r.enters.count).toBe(1);
      r.d.freezeRuntimeMonitors();
      await r.poll(5_000);
      expect(r.enters.count).toBe(1);                       // no second Enter
    });

    it("…and so is the defensive retry of a CLI whose input row cannot be read", async () => {
      const r = rig();
      r.d.backend.isDeliveryInputReadyPane = undefined;
      r.d.systemPasteOptions = () => ({ retryEnter: true });
      r.d.confirmSubmitted = async () => "unverifiable";
      await r.poll(5_100);
      await r.poll(59_000);
      await r.poll(1_800);                                   // paste, Enter, and the 1 s pause before the defensive retry
      expect(r.enters.count).toBe(1);
      r.d.freezeRuntimeMonitors();
      await r.poll(5_000);
      expect(r.enters.count).toBe(1);
    });

    it("an untouched nudge writes the paste and the Enter, once each", async () => {
      const r = await dueWith(() => {});
      await r.poll(10_000);
      expect(r.sent).toEqual(["keep going"]);
      expect(r.enters.count).toBe(1);
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
    it("is refused for another pattern even when that text is on the screen", async () => {
      const { d, errors, poll, stop } = rig();
      await poll(5_100);
      expect(errors).toHaveLength(1);
      expect(d.armCapacityNudge(/earlier answer/, 60_000)).toBe(false);
      stop();
    });

    it("is refused for an occurrence seen under another spawn or monitors", async () => {
      const { d, errors, poll, stop } = rig();
      await poll(5_100);
      d.capacityNudge = null;
      d.lastErrorEpisode = { ...d.lastErrorEpisode, spawn: d.spawnGeneration - 1 };
      expect(d.armCapacityNudge(errors[0].pattern, 60_000)).toBe(false);
      d.lastErrorEpisode = { ...d.lastErrorEpisode, spawn: d.spawnGeneration, fence: d.launchFenceEpoch - 1 };
      expect(d.armCapacityNudge(errors[0].pattern, 60_000)).toBe(false);
      d.lastErrorEpisode = { ...d.lastErrorEpisode, fence: d.launchFenceEpoch };
      expect(d.armCapacityNudge(errors[0].pattern, 60_000)).toBe(true);
      stop();
    });

    it("is refused when the instance is paused or stopped", async () => {
      const r = rig();
      await r.poll(5_100);
      r.d.capacityNudge = null;
      r.d.pauseWakeState = "paused";
      expect(r.d.armCapacityNudge(r.errors[0].pattern, 60_000)).toBe(false);
      r.d.pauseWakeState = "active";
      r.d.processStatus = "stopped";
      expect(r.d.armCapacityNudge(r.errors[0].pattern, 60_000)).toBe(false);
      r.stop();
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

describe("scrollback from a resumed session is history, not a new capacity error (#949)", () => {
  const HISTORY = PANE;                                    // an old capacity line, and a live composer under it

  it("an old capacity line on the first live composer never arms a nudge", async () => {
    const { d, sent, poll, stop } = rig({ baselineTaken: false, start: HISTORY });
    await poll(5_100);
    expect(d.nudgeBaselines.get(KEY)).toBe(1);
    await poll(300_000);
    expect(sent).toEqual([]);
    expect(d.capacityNudge).toBeNull();
    stop();
  });

  it("…also when the resume first paints an empty startup frame and the history only appears afterwards", async () => {
    const { screen, sent, poll, stop } = rig({ baselineTaken: false, start: ">_ OpenAI Codex (v0.157.0)\n  Resuming session…" });
    await poll(5_100);
    screen.text = HISTORY;
    await poll(300_000);
    expect(sent).toEqual([]);
    stop();
  });

  it("a genuinely NEW capacity error after that history is an episode", async () => {
    const { screen, sent, errors, poll, stop } = rig({ baselineTaken: false, start: HISTORY });
    await poll(5_100);
    screen.text = `• earlier answer\n\n${CAPACITY}\n\n› go on\n${CAPACITY}\n\n› Ask Codex to do anything\n  Context 100% left`;
    await poll(5_100);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    await poll(60_000);
    expect(sent).toEqual(["keep going"]);
    stop();
  });

  it("…and so is one that arrives after the old line scrolled out of the capture", async () => {
    const { screen, sent, poll, stop } = rig({ baselineTaken: false, start: HISTORY });
    await poll(5_100);
    screen.text = IDLE;                                    // the old line is gone
    await poll(5_100);
    screen.text = PANE;                                    // a new failure
    await poll(65_000);
    expect(sent).toEqual(["keep going"]);
    stop();
  });

  it("nothing is armed before any live composer was seen", async () => {
    const { d, errors, poll, stop } = rig({ baselineTaken: false, start: CAPACITY });   // a bare line, no composer: not live
    await poll(5_100);
    expect(errors).toHaveLength(1);
    expect(d.nudgeBaselines).toBeNull();
    expect(d.armCapacityNudge(errors[0].pattern, 60_000)).toBe(false);
    stop();
  });

  it("a respawn forgets the baseline: the new spawn's first live composer fixes its own", async () => {
    const r = rig();
    await r.poll(5_100);
    r.d.beginSpawn(); r.d.endSpawn();
    expect(r.d.nudgeBaselines).toBeNull();
    r.stop();
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
