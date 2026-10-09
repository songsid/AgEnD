import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const seams = vi.hoisted(() => ({
  source: null as any,
  forbidden: vi.fn(() => { throw new Error("forbidden host operation"); }),
}));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  exec: seams.forbidden, execFile: seams.forbidden, execSync: seams.forbidden, execFileSync: seams.forbidden,
  spawn: seams.forbidden, spawnSync: seams.forbidden, fork: seams.forbidden }));
vi.mock("node:net", async original => ({ ...await original<typeof import("node:net")>(),
  createServer: seams.forbidden, createConnection: seams.forbidden, connect: seams.forbidden }));
vi.mock("better-sqlite3", () => ({ default: seams.forbidden }));
vi.mock("../src/channel/ipc-bridge.js", () => ({ IpcServer: class extends EventEmitter { async listen() {} } }));
vi.mock("../src/tmux-manager.js", () => ({
  TmuxManager: class { static async ensureSession() {} static async listWindows() { return []; } }, resolveTmuxLogicalSize: () => ({ width: 80, height: 24 }),
}));
vi.mock("../src/transcript-sources.js", async original => ({
  ...await original<typeof import("../src/transcript-sources.js")>(), createTranscriptSource: () => seams.source,
}));
vi.mock("../src/context-guardian.js", () => ({ ContextGuardian: class extends EventEmitter { startWatching() {} } }));
import { AutoPauseController, Daemon } from "../src/daemon.js";
import { TranscriptMonitor } from "../src/transcript-monitor.js";
import { TranscriptTurnLedger } from "../src/transcript-turns.js"; // a constructed Daemon's field (#1510); Object.create skips it
import { KiroSessionSource } from "../src/transcript-sources.js";
import type { KiroDbInput, KiroDbLane, KiroDbReply } from "../src/kiro-transcript-lane.js";
const roots: string[] = [];
const monitors: TranscriptMonitor[] = [];
afterEach(() => { monitors.splice(0).forEach(m => m.stop()); roots.splice(0).forEach(dir => rmSync(dir, {recursive:true,force:true})); vi.useRealTimers(); vi.restoreAllMocks(); expect(seams.forbidden).not.toHaveBeenCalled(); });
async function flush() { for(let i=0;i<40;i++) await Promise.resolve(); }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agend-transcript-start-")); roots.push(dir);
  let resolve!: () => void; const baseline = new Promise<void>(done => { resolve = done; });
  seams.source = { initialize: vi.fn(() => baseline), poll: vi.fn(), reset: vi.fn(), close: vi.fn() };
  const d = Object.create(Daemon.prototype) as any;
  Object.assign(d, {name:"fixture", instanceDir:dir, config:{backend:"kiro-cli",working_directory:dir,hang_detector:{enabled:false}},
    tmuxSessionName:"never-connect", logger:{info:vi.fn(),warn:vi.fn(),debug:vi.fn(),error:vi.fn()},
    startupAborted:false, launchFenceEpoch:0, transcriptTurns:new TranscriptTurnLedger(),
    spawnClaudeWindow:vi.fn(async()=>false), injectSnapshotMessage:vi.fn(async()=>{}),
    maybeResumeInterruptedTurn:vi.fn(async()=>{}), runWarmupInstructionNotice:vi.fn(async()=>{}),
    attachPipePaneLog:vi.fn(async()=>{}), credentialProfileStore:vi.fn(()=>undefined),
    startHealthCheck:vi.fn(), startErrorMonitor:vi.fn(), startInstanceStateMonitor:vi.fn() });
  const polling = vi.spyOn(TranscriptMonitor.prototype,"startPolling").mockImplementation(()=>{});
  const stop = vi.spyOn(TranscriptMonitor.prototype,"stop");
  return {d, resolve, polling, stop};
}
describe("real Daemon.start baseline barrier with all host operations stubbed", () => {
  it("does not arm polling or report ready before the asynchronous baseline; then starts normally", async () => {
    const {d,resolve,polling}=fixture(); const start=d.start(); await flush();
    expect(seams.source.initialize).toHaveBeenCalledTimes(1);
    expect(polling).not.toHaveBeenCalled(); expect(d.startHealthCheck).not.toHaveBeenCalled();
    expect(d.logger.info.mock.calls.flat()).not.toContain("fixture ready");
    resolve(); await start; expect(polling).toHaveBeenCalledTimes(1); expect(d.startHealthCheck).toHaveBeenCalledTimes(1);
    expect(d.logger.info).toHaveBeenCalledWith("fixture ready");
  });
  it.each(["abort","epoch","replacement"])("%s while the baseline is pending never rearms the old launch", async mode => {
    const {d,resolve,polling,stop}=fixture(); const start=d.start(); await flush();
    expect(seams.source.initialize).toHaveBeenCalledTimes(1);
    const monitor=d.transcriptMonitor;
    if(mode==="abort")d.startupAborted=true;
    if(mode==="epoch")d.launchFenceEpoch++;
    if(mode==="replacement")d.transcriptMonitor=new TranscriptMonitor("/not-used", {debug:vi.fn()} as never, seams.source);
    resolve(); await start;
    expect(stop).toHaveBeenCalledTimes(1); expect(stop.mock.instances[0]).toBe(monitor);
    expect(seams.source.close).toHaveBeenCalledTimes(1);
    expect(polling).not.toHaveBeenCalled(); expect(d.startHealthCheck).not.toHaveBeenCalled();
  });
});

/** The worker's held baseline snapshots history when it finishes, not when
 * resetOffset is called. This reproduces the actual wake admission race. */
async function wakeFixture() {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), "agend-transcript-wake-")); roots.push(dir);
  const history = ["old_tool"];
  let finishBaseline!: () => void;
  let baselineCount = 0;
  const reads = vi.fn((input: KiroDbInput): Promise<KiroDbReply> => {
    const snapshot = (): KiroDbReply => ({
      events: { toolUses: input.baseline ? [] : history.slice(input.cursor?.historyCursor ?? 0).map(name => ({ name, input: {} })), toolResults: [], assistantTexts: [] },
      cursor: { conversationId: "fixture", historyCursor: history.length, signature: String(history.length), toolNames: [] },
    });
    if (input.baseline && ++baselineCount > 1) return new Promise(resolve => { finishBaseline = () => resolve(snapshot()); });
    return Promise.resolve(snapshot());
  });
  const lane: KiroDbLane = { acquire: () => ({ read: reads, close: vi.fn() }) };
  const source = new KiroSessionSource(dir, join(dir, "missing"), 0, join(dir, "not-opened.sqlite3"), lane);
  const monitor = new TranscriptMonitor(dir, { debug: vi.fn() } as never, source); monitors.push(monitor);
  await monitor.initialize(); monitor.stop();
  const controller = new AutoPauseController(1); controller.markPaused();
  const d = Object.setPrototypeOf(new EventEmitter(), Daemon.prototype) as any;
  Object.assign(d, {
    name: "fixture", instanceDir: dir, config: { backend: "kiro-cli", working_directory: dir },
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    startupAborted: false, launchFenceEpoch: 1, spawnGeneration: 1, spawnDepth: 0,
    runtimeMonitorsFrozen: true, healthCheckPaused: true, pauseWakeState: "paused", pauseWakeTransition: null,
    autoPauseController: controller, transcriptMonitor: monitor, instanceState: "idle",
    turnReplyGuard: { reset: vi.fn() }, interactionObservation: { reset: vi.fn() }, bootId: "fixture-boot", launchAttempt: 1,
    clearQuitRelaunchWatch: vi.fn(), clearReplyGuardConfirm: vi.fn(), clearInteractionConfirmation: vi.fn(),
    interactivePromptDetector: { reset: vi.fn() }, blockingProcessDetector: { reset: vi.fn() }, stopInstanceStateMonitor: vi.fn(),
    clearErrorRecoveryGate: vi.fn(), wakeBudgetMs: () => 1000, trySpawn: vi.fn(async () => true),
    startHealthCheck: vi.fn(), startErrorMonitor: vi.fn(), startInstanceStateMonitor: vi.fn(),
    guardian: { startWatching: vi.fn(), stop: vi.fn() }, ipcServer: { broadcast: vi.fn() },
  });
  const seen: string[] = []; monitor.on("tool_use", name => seen.push(name));
  return { d, monitor, source, history, seen, reads, finishBaseline: () => finishBaseline(), baselineCount: () => baselineCount };
}

describe("real Daemon.wake + monitor + Kiro source admission", () => {
  it("holds admission and polling until reset baseline settles, then emits new work once", async () => {
    const h = await wakeFixture(); let delivered = false;
    const waking = h.d.wake().then(() => { delivered = true; h.history.push("new_tool"); });
    await flush();
    expect(h.baselineCount()).toBe(2); expect(delivered).toBe(false);
    expect(h.d.pauseWakeState).toBe("waking"); expect(h.d.spawning).toBe(true);
    expect((h.monitor as any).pollTimer).toBeNull(); expect(h.d.startHealthCheck).not.toHaveBeenCalled();
    h.finishBaseline(); await waking;
    expect(h.d.pauseWakeState).toBe("active"); expect(h.d.spawning).toBe(false);
    expect((h.monitor as any).pollTimer).not.toBeNull(); expect(h.d.startHealthCheck).toHaveBeenCalledTimes(1);
    await h.monitor.pollIncrement(); await h.monitor.pollIncrement();
    expect(h.seen).toEqual(["new_tool"]); expect((h.source as any).cursor.historyCursor).toBe(2);
  });
  it("a concurrent wake joins initialization, rather than only the finished spawn", async () => {
    const h = await wakeFixture(); const first = h.d.wake(); await flush();
    let delivered = false; const second = h.d.wake().then(() => { delivered = true; h.history.push("joined_tool"); });
    await flush(); expect(delivered).toBe(false); expect(h.d.trySpawn).toHaveBeenCalledTimes(1);
    h.finishBaseline(); await Promise.all([first, second]); await h.monitor.pollIncrement();
    expect(h.seen).toEqual(["joined_tool"]); expect(h.baselineCount()).toBe(2);
  });
  it.each(["abort", "epoch", "spawn", "replacement", "freeze"])("%s during held baseline cannot publish active or resume monitors", async mode => {
    const h = await wakeFixture(); const outcome = h.d.wake().then(() => "admitted", () => "cancelled"); await flush();
    expect(h.baselineCount()).toBe(2);
    if (mode === "abort") h.d.startupAborted = true;
    if (mode === "epoch") h.d.launchFenceEpoch++;
    if (mode === "spawn") h.d.spawnGeneration++;
    if (mode === "freeze") h.d.freezeRuntimeMonitors();
    if (mode === "replacement") { h.d.transcriptMonitor = new TranscriptMonitor(h.d.instanceDir, h.d.logger); monitors.push(h.d.transcriptMonitor); }
    h.finishBaseline(); expect(await outcome).toBe("cancelled");
    expect(h.d.pauseWakeState).not.toBe("active"); expect(h.d.startHealthCheck).not.toHaveBeenCalled();
    expect(h.d.ipcServer.broadcast).not.toHaveBeenCalled(); expect((h.monitor as any).pollTimer).toBeNull();
  });
  it("a stop epoch during spawn is rejected before resetting or starting another baseline", async () => {
    const h = await wakeFixture(); let finishSpawn!: () => void;
    h.d.trySpawn = vi.fn(() => new Promise(resolve => { finishSpawn = () => resolve(true); }));
    const outcome = h.d.wake().then(() => "admitted", () => "cancelled"); await flush();
    h.d.launchFenceEpoch++; finishSpawn(); expect(await outcome).toBe("cancelled");
    expect(h.baselineCount()).toBe(1); expect(h.d.startHealthCheck).not.toHaveBeenCalled();
  });
});

describe("actual crash-respawn reset in the Daemon health tick", () => {
  async function crashFixture() {
    const h = await wakeFixture();
    Object.assign(h.d, {
      pauseWakeState: "active", runtimeMonitorsFrozen: false, healthCheckPaused: false,
      healthCheckTimer: null, crashCount: 0, lastCrashAt: 0, crashTimestamps: [],
      config: { ...h.d.config, restart_policy: { max_retries: 5, backoff: "linear", reset_after: 0, health_check_interval_ms: 1000 } },
      tmux: { getPaneStatus: vi.fn(async () => ({ alive: false, exitCode: 1 })), capturePaneWithHistory: vi.fn(async () => ""), killWindow: vi.fn(async () => {}) },
      checkMcpServerAlive: vi.fn(), logPaneDeath: vi.fn(), appendCrashHistory: vi.fn(), paneSaysNoConversation: () => false,
      checkpointSessionId: vi.fn(async () => {}), writeRotationSnapshot: vi.fn(), injectSnapshotMessage: vi.fn(async () => {}),
      spawnClaudeWindow: vi.fn(async () => { h.history.push("respawn_tool"); return true; }), processStatus: "running",
    });
    delete h.d.startHealthCheck; // drive the real timer and crash handler
    const kill = vi.spyOn(process, "kill").mockImplementation(seams.forbidden);
    h.d.startHealthCheck(); await vi.advanceTimersByTimeAsync(2000);
    expect(h.baselineCount()).toBe(2); expect(kill).not.toHaveBeenCalled();
    return h;
  }
  it("finishes the baseline before spawning; the replacement's first tool is observed once", async () => {
    const h = await crashFixture(); expect(h.d.spawnClaudeWindow).not.toHaveBeenCalled();
    h.finishBaseline(); await flush();
    expect(h.d.spawnClaudeWindow).toHaveBeenCalledTimes(1); expect(h.d.processStatus).toBe("running");
    await h.monitor.pollIncrement(); await h.monitor.pollIncrement(); expect(h.seen).toEqual(["respawn_tool"]);
    h.d.freezeRuntimeMonitors();
  });
  it.each(["freeze", "epoch", "spawn", "replacement", "health_pause", "abort"])("%s while reset is held prevents the stale health tick from respawning", async mode => {
    const h = await crashFixture();
    if (mode === "freeze") h.d.freezeRuntimeMonitors();
    if (mode === "epoch") h.d.launchFenceEpoch++;
    if (mode === "spawn") h.d.spawnGeneration++;
    if (mode === "health_pause") h.d.healthCheckPaused = true;
    if (mode === "abort") h.d.startupAborted = true;
    if (mode === "replacement") { h.d.transcriptMonitor = new TranscriptMonitor(h.d.instanceDir, h.d.logger); monitors.push(h.d.transcriptMonitor); }
    h.finishBaseline(); await flush(); expect(h.d.spawnClaudeWindow).not.toHaveBeenCalled();
    expect(h.d.writeRotationSnapshot).not.toHaveBeenCalled();
    h.d.freezeRuntimeMonitors();
  });
});
