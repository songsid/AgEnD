/**
 * #1127: when many instances lose their tmux window at the same moment while
 * the tmux server keeps running (16 windows vanished in one second on 10-03,
 * 13:01), every daemon's health tick respawned its own CLI as if it were an
 * independent crash and the fleet saw 16 respawns and 16 notices.
 *
 * What was already true (checked on main, pinned below): a crash respawn runs
 * through the fleet SpawnGate as reason "recovery"; a null pane status is
 * re-confirmed after 1.5 s; a live MCP server gets a grace. What was missing:
 * the storm window only knew "the tmux SERVER died or was replaced", so a burst
 * of window losses on a live server was invisible to it — no rate cap beyond
 * the ordinary one, no single incident, per-instance crash counters ticking
 * toward their breaker — and a failed `list-windows` counted as "the window is
 * gone".
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../src/daemon.js";
import { FleetManager } from "../src/fleet-manager.js";
import { t } from "../src/locale.js";
import { SpawnGate } from "../src/spawn-gate.js";
import { StormWindow } from "../src/storm-window.js";
import { TmuxManager } from "../src/tmux-manager.js";

describe("StormWindow: a burst of window losses on a live server", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-03T13:01:00Z")); });
  afterEach(() => vi.useRealTimers());

  it("below the threshold it is just crashes: no window opens", () => {
    const storm = new StormWindow({ windowLossThreshold: 4 });
    const opened = vi.fn();
    storm.on("opened", opened);
    for (const name of ["a", "b", "c"]) expect(storm.noteWindowLoss(name)).toBe(false);
    expect(storm.isActive()).toBe(false);
    expect(opened).not.toHaveBeenCalled();
  });

  it("the Nth distinct loss opens ONE window, kind window_loss, holding nothing", () => {
    const storm = new StormWindow({ windowLossThreshold: 4 });
    const opened = vi.fn();
    storm.on("opened", opened);
    for (const name of ["a", "b", "c"]) storm.noteWindowLoss(name);
    expect(storm.noteWindowLoss("d")).toBe(true);
    expect(opened).toHaveBeenCalledTimes(1);
    const snapshot = storm.snapshot();
    expect(snapshot).toMatchObject({ kind: "window_loss", phase: "recovering", backoffMs: 0, retryAt: null });
    expect([...snapshot.affected].sort()).toEqual(["a", "b", "c", "d"]);
    // The server is fine: respawns are not blocked, they only run at the storm rate.
    expect(storm.isSpawnBlocked()).toBe(false);
    expect(storm.isActive()).toBe(true);
  });

  it("the same instance reporting twice is one loss", () => {
    const storm = new StormWindow({ windowLossThreshold: 3 });
    for (let i = 0; i < 6; i++) expect(storm.noteWindowLoss("a")).toBe(false);
    expect(storm.noteWindowLoss("b")).toBe(false);
    expect(storm.isActive()).toBe(false);
  });

  it("losses spread over more than the window are separate events", () => {
    const storm = new StormWindow({ windowLossThreshold: 3, windowLossWindowMs: 60_000 });
    storm.noteWindowLoss("a");
    storm.noteWindowLoss("b");
    vi.advanceTimersByTime(61_000);
    expect(storm.noteWindowLoss("c")).toBe(false);
    expect(storm.isActive()).toBe(false);
  });

  it("later losses join the open window and do not open another", () => {
    const storm = new StormWindow({ windowLossThreshold: 2 });
    const opened = vi.fn();
    storm.on("opened", opened);
    storm.noteWindowLoss("a");
    storm.noteWindowLoss("b");
    expect(storm.noteWindowLoss("late")).toBe(false);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(storm.snapshot().affected).toContain("late");
    expect(storm.needsRecovery("late")).toBe(true);
  });

  it("per-instance incident notices are folded into it while it is open", () => {
    const storm = new StormWindow({ windowLossThreshold: 2 });
    expect(storm.shouldSuppress("crash_respawn")).toBe(false);
    storm.noteWindowLoss("a");
    storm.noteWindowLoss("b");
    expect(storm.shouldSuppress("crash_respawn")).toBe(true);
    expect(storm.shouldSuppress("mcp_died")).toBe(true);
    expect(storm.shouldSuppress("mcp_auto_restart")).toBe(true);
  });

  it("it closes, once, when every affected instance has come back", () => {
    const storm = new StormWindow({ windowLossThreshold: 3 });
    const closed = vi.fn();
    storm.on("closed", closed);
    for (const name of ["a", "b", "c"]) storm.noteWindowLoss(name);
    storm.markRecovered("a");
    storm.markRecovered("b");
    expect(closed).not.toHaveBeenCalled();
    storm.markRecovered("c");
    expect(closed).toHaveBeenCalledTimes(1);
    expect(closed.mock.calls[0]![1]).toBe("recovered");
    expect(closed.mock.calls[0]![0]).toMatchObject({ kind: "window_loss", recovered: expect.arrayContaining(["a", "b", "c"]) });
    expect(storm.isActive()).toBe(false);
  });

  it("an instance that never comes back does not hold it open for ever", () => {
    const storm = new StormWindow({ windowLossThreshold: 2, recoveryTimeoutMs: 5_000 });
    const closed = vi.fn();
    storm.on("closed", closed);
    storm.noteWindowLoss("a");
    storm.noteWindowLoss("b");
    storm.markRecovered("a");
    vi.advanceTimersByTime(5_001);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(closed.mock.calls[0]![1]).toBe("timeout");
  });

  it("once closed, the losses are forgotten: the next burst is a new event", () => {
    const storm = new StormWindow({ windowLossThreshold: 2 });
    const opened = vi.fn();
    storm.on("opened", opened);
    storm.noteWindowLoss("a"); storm.noteWindowLoss("b");
    storm.markRecovered("a"); storm.markRecovered("b");
    expect(storm.isActive()).toBe(false);
    expect(storm.noteWindowLoss("a")).toBe(false);   // one loss alone is nothing again
    expect(storm.noteWindowLoss("c")).toBe(true);
    expect(opened).toHaveBeenCalledTimes(2);
  });

  it("a tmux SERVER crash while it is open turns it into a server storm (spawns held)", () => {
    const storm = new StormWindow({ windowLossThreshold: 2, backoffsMs: [30_000] });
    storm.noteWindowLoss("a"); storm.noteWindowLoss("b");
    expect(storm.isSpawnBlocked()).toBe(false);
    storm.recordServerDead("a", ["a", "b"]);
    expect(storm.snapshot().kind).toBe("server");
    expect(storm.isSpawnBlocked()).toBe(true);
  });

  it("the ordinary server-crash path is unchanged", () => {
    const storm = new StormWindow({ backoffsMs: [10] });
    expect(storm.recordServerDead("a", ["a", "b"])).toBe(true);
    expect(storm.snapshot()).toMatchObject({ kind: "server", phase: "backing_off" });
  });
});

describe("SpawnGate: the burst's respawns run at the storm rate", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-03T13:01:00Z")); });
  afterEach(() => vi.useRealTimers());

  async function respawns(count: number, makeBurst: boolean) {
    const storm = new StormWindow({ windowLossThreshold: 4 });
    const gate = new SpawnGate({ storm, concurrency: () => 10, staggerMs: () => 0, random: () => 0, lowMemoryBytes: 0 });
    if (makeBurst) for (let i = 0; i < 4; i++) storm.noteWindowLoss(`i${i}`);
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const runs = Array.from({ length: count }, (_, i) => gate.run({ instanceName: `i${i}`, workingDirectory: `/w${i}`, reason: "recovery" }, async () => {
      active++; peak = Math.max(peak, active);
      await new Promise<void>(resolve => release.push(resolve));
      active--;
    }));
    await vi.advanceTimersByTimeAsync(0);
    const startedAtOnce = active;
    while (release.length) { release.shift()!(); await vi.advanceTimersByTimeAsync(0); }
    await Promise.all(runs);
    return { startedAtOnce, peak };
  }

  it("control: without a burst the ordinary concurrency applies", async () => {
    expect(await respawns(12, false)).toEqual({ startedAtOnce: 10, peak: 10 });
  });

  it("with a burst open, at most four start at once however many died", async () => {
    expect(await respawns(12, true)).toEqual({ startedAtOnce: 4, peak: 4 });
  });
});

// ── the real health loop, over stub tmux ──

const SESSION = "agend-test";
let dirs: string[] = [];
let gateTasks: Array<{ instanceName: string; reason: string }>;

function fleet(count: number, opts: { threshold?: number; staggerMs?: number } = {}) {
  const storm = new StormWindow({ windowLossThreshold: opts.threshold ?? 4 });
  const gate = new SpawnGate({ storm, concurrency: () => 10, staggerMs: () => opts.staggerMs ?? 0, random: () => 0, lowMemoryBytes: 0 });
  const realRun = gate.run.bind(gate);
  gate.run = ((task: { instanceName: string; reason: string }, operation: () => Promise<unknown>) => {
    gateTasks.push({ instanceName: task.instanceName, reason: task.reason });
    return realRun(task as never, operation);
  }) as typeof gate.run;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const state = { active: 0, peak: 0, started: [] as string[], up: new Set<number>() };
  const daemons = Array.from({ length: count }, (_, i) => {
    const name = `inst-${i}`;
    const dir = mkdtempSync(join(tmpdir(), "agend-1127-")); dirs.push(dir);
    const daemon: any = new Daemon(name, {
      working_directory: `/tmp/work-${i}`, backend: "claude-code",
      restart_policy: { max_retries: 5, backoff: "linear", reset_after: 0, health_check_interval_ms: 1_000 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
      log_level: "silent",
    } as any, dir, false, { binaryName: "claude", getReadyPattern: () => /❯/ } as any, undefined,
      { child: () => logger } as any, undefined, gate, storm);
    daemon.tmux = {
      getPaneStatus: vi.fn(async () => state.up.has(i) ? { alive: true } : null),   // gone until it is respawned
      capturePaneWithHistory: vi.fn(async () => ""),
      killWindow: vi.fn(async () => {}),
      getWindowId: () => `@${i}`,
    };
    daemon.lastSpawnAt = 1;                                 // it has run before: a respawn is "recovery"
    daemon.setProcessStatus("running");
    // The real trySpawn (the gate) runs; only the CLI launch inside it is stubbed.
    daemon.spawnClaudeWindow = async () => { await daemon.trySpawn(false); return true; };
    daemon.trySpawnInsideGate = async () => {
      state.active++; state.peak = Math.max(state.peak, state.active); state.started.push(name);
      await new Promise(resolve => setTimeout(resolve, 3_000));   // a CLI taking 3 s to come up
      state.active--;
      state.up.add(i);                                                    // …and its window exists again
      return true;
    };
    daemon.saveSessionId = () => {};
    daemon.writeRotationSnapshot = () => {};
    daemon.injectSnapshotMessage = async () => {};
    return daemon;
  });
  // the tmux server's window list follows the stub panes
  vi.spyOn(TmuxManager, "listWindows").mockImplementation(async () => [...state.up].map(i => ({ id: `@${i}`, name: `inst-${i}` })) as never);
  return { storm, gate, daemons, logger, state };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-03T13:01:00Z"));
  gateTasks = [];
  vi.spyOn(TmuxManager, "sessionExists").mockResolvedValue(true);                // the tmux server is alive
  vi.spyOn(TmuxManager, "getServerPid").mockResolvedValue(4242);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const startAll = (daemons: any[]) => { for (const daemon of daemons) daemon.startHealthCheck(); };

describe("a burst through the real health loop", () => {
  it("pin (already true on main): a crash respawn goes through the SpawnGate as `recovery`", async () => {
    const { daemons, state } = fleet(1);
    startAll(daemons);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(gateTasks).toEqual([{ instanceName: "inst-0", reason: "recovery" }]);
    expect(state.started).toEqual(["inst-0"]);
  });

  it("16 windows gone in the same tick: ONE incident, respawns capped at four at a time, every instance back", async () => {
    const { daemons, storm, state } = fleet(16);
    const opened = vi.fn(); const closed = vi.fn();
    storm.on("opened", opened); storm.on("closed", closed);
    startAll(daemons);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(opened).toHaveBeenCalledTimes(1);                             // one aggregated incident, not sixteen
    expect(opened.mock.calls[0]![0].kind).toBe("window_loss");
    expect(state.started).toHaveLength(16);                              // every instance respawned…
    expect(new Set(state.started).size).toBe(16);                        // …exactly once
    expect(state.peak).toBeLessThanOrEqual(4);                           // …never more than four at once
    expect(closed).toHaveBeenCalledTimes(1);                             // and the incident closed with them
    expect(closed.mock.calls[0]![1]).toBe("recovered");
    expect(closed.mock.calls[0]![0].recovered).toHaveLength(16);
    expect(storm.isActive()).toBe(false);
  });

  it("control: below the threshold they are ordinary crashes — no window, ordinary concurrency", async () => {
    const { daemons, storm, state } = fleet(3);
    const opened = vi.fn();
    storm.on("opened", opened);
    startAll(daemons);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(opened).not.toHaveBeenCalled();
    expect(state.started).toHaveLength(3);
    expect(state.peak).toBe(3);
  });

  it("an instance that joins the burst is not walked toward its 3-crashes-in-5-minutes breaker", async () => {
    const { daemons, state } = fleet(5);
    // Two crashes already on record would trip the breaker on the next one…
    daemons[4].crashTimestamps = [Date.now() - 60_000, Date.now() - 30_000];
    startAll(daemons);
    await vi.advanceTimersByTimeAsync(30_000);
    // …but this one is part of a fleet-wide event (the first four made it one), so it respawns instead of pausing.
    expect(state.started).toContain("inst-4");
    expect(daemons[4].healthCheckPaused).toBe(false);
    // Stated limit: an instance that sees the loss BEFORE the burst is recognised is, at that moment, an ordinary crash.
  });

  it("control: the same history WITHOUT a burst does trip the breaker", async () => {
    const { daemons, state } = fleet(1);
    daemons[0].crashTimestamps = [Date.now() - 60_000, Date.now() - 30_000];
    startAll(daemons);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.started).toEqual([]);
    expect(daemons[0].healthCheckPaused).toBe(true);
  });
});

describe("a window that is not confirmed gone is not respawned", () => {
  it("the window is back when the daemon looks again: nothing happens", async () => {
    const { daemons, state } = fleet(1);
    (TmuxManager.listWindows as any).mockResolvedValue([{ id: "@0", name: "inst-0" }]);
    startAll(daemons);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.started).toEqual([]);
    expect(gateTasks).toEqual([]);
  });

  it("a failed list-windows is not a confirmed death: deferred for two ticks, then acted on", async () => {
    const { daemons, state, logger } = fleet(1);
    (TmuxManager.listWindows as any).mockRejectedValue(new Error("tmux busy"));
    startAll(daemons);
    await vi.advanceTimersByTimeAsync(2_800);                // two ticks (1 s interval + the 1.5 s recheck each)
    expect(state.started).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith({ failures: 1 }, expect.stringContaining("window list unavailable"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state.started).toEqual(["inst-0"]);               // persistent trouble still recovers
  });

  it("…and one failed query followed by a healthy window never respawns", async () => {
    const { daemons, state } = fleet(1);
    (TmuxManager.listWindows as any)
      .mockRejectedValueOnce(new Error("tmux busy"))
      .mockResolvedValue([{ id: "@0", name: "inst-0" }]);
    startAll(daemons);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state.started).toEqual([]);
  });
});

describe("the fleet says it once", () => {
  it("one aggregated notice when the burst opens, one when it closes — and only the affected are named", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-1127-fm-")); dirs.push(dir);
    const fm: any = new FleetManager(dir);
    const notices: string[] = [];
    fm.notifyFleetError = (text: string) => notices.push(text);
    // Sixteen running daemons; only four lose their window.
    for (let i = 0; i < 16; i++) fm.daemons.set(`inst-${i}`, { isPaused: false });
    for (const name of ["inst-0", "inst-1", "inst-2", "inst-3"]) fm.stormWindow.noteWindowLoss(name);

    expect(notices).toEqual([t("storm.window_loss", 4, 60, Math.min(4, fm.spawnConcurrency()))]);
    expect(notices[0]).toMatch(/4 instances/);
    // The server-crash handler adds EVERY running daemon; this one must not.
    expect(fm.stormWindow.snapshot().affected.sort()).toEqual(["inst-0", "inst-1", "inst-2", "inst-3"]);
    // Their per-instance incident notices fold into it.
    expect(fm.stormSuppressed("crash_respawn")).toBe(true);

    for (const name of ["inst-0", "inst-1", "inst-2"]) fm.stormWindow.markRecovered(name);
    expect(notices).toHaveLength(1);
    fm.stormWindow.markRecovered("inst-3");
    expect(notices).toHaveLength(2);
    expect(notices[1]).toBe(t("storm.recovered", 4, 4, t("storm.none")));
    fm.stormWindow.shutdown();
  });

  it("the server-crash storm still names every running daemon (unchanged)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-1127-fm-")); dirs.push(dir);
    const fm: any = new FleetManager(dir);
    fm.notifyFleetError = () => {};
    for (let i = 0; i < 6; i++) fm.daemons.set(`inst-${i}`, { isPaused: false });
    fm.stormWindow.recordServerDead("inst-0", ["inst-0"]);
    expect(fm.stormWindow.snapshot().affected.sort()).toHaveLength(6);
    fm.stormWindow.shutdown();
  });

  it("every new string exists in both languages", async () => {
    const { setLocale } = await import("../src/locale.js");
    for (const locale of ["en", "zh-TW"] as const) {
      setLocale(locale);
      expect(t("storm.window_loss", 4, 60, 4), locale).not.toBe("storm.window_loss");
    }
    setLocale("en");
  });
});
