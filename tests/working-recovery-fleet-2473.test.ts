/** Real manager, daemon, task board and SQLite; no native CLI, tmux or network. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({ forbidden: vi.fn(() => { throw Error("forbidden native recovery effect"); }) }));
vi.mock("node:child_process", async load => ({ ...await load<typeof import("node:child_process")>(), exec: io.forbidden, execFile: io.forbidden,
  execFileSync: io.forbidden, execSync: io.forbidden, spawn: io.forbidden, spawnSync: io.forbidden, fork: io.forbidden }));
vi.mock("node:net", async load => ({ ...await load<typeof import("node:net")>(), createServer: io.forbidden, connect: io.forbidden, createConnection: io.forbidden }));
vi.mock("../src/backend/factory.js", () => ({ createBackend: io.forbidden }));
vi.mock("../src/logger.js", async load => ({ ...await load<typeof import("../src/logger.js")>(), createLogger: () => pino({ level: "silent" }) }));
import { Daemon } from "../src/daemon.js";
import { FleetManager } from "../src/fleet-manager.js";
import { Scheduler } from "../src/scheduler/index.js";
import { EventLog } from "../src/event-log.js";
import { installFleetProcessHandlers } from "../src/fleet-process-handlers.js";
import { beginUpdateProgress, setUpdateProgressStage } from "../src/update-marker.js";
const roots: string[] = [], fleets: any[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.spyOn(performance, "now").mockImplementation(() => Date.now()); io.forbidden.mockClear();
});
afterEach(() => {
  for (const fm of fleets.splice(0)) { fm.taskBoardWaker?.stop(); fm.deliveryOutbox?.close(); fm.scheduler?.db.close(); fm.eventLog?.close(); }
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); expect(io.forbidden).not.toHaveBeenCalled();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "working-recovery-fleet-")); roots.push(root);
  vi.stubEnv("AGEND_HOME", root); vi.stubEnv("HOME", root);
  const fm = new FleetManager(root) as any; fleets.push(fm);
  fm.fleetConfig = { defaults: { delivery_worker: "off" }, instances: {
    worker: { backend: "claude-code", working_directory: root }, general: { backend: "claude-code", working_directory: root, general_topic: true },
  }, web: { log_tab: true } };
  fm.scheduleDeliveryOutboxPump = vi.fn(); fm.emitSseEvent = vi.fn();
  fm.scheduler = new Scheduler(join(root, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => true);
  fm.attachTaskBoard(fm.scheduler.db); fm.eventLog = new EventLog(join(root, "events.db"));
  fm.ensureDeliveryOutbox(); clearInterval(fm.workingRecoveryTimer);
  let level = "normal";
  vi.spyOn(fm.memoryPressure, "snapshot").mockImplementation(() => ({ level, sampledAt: Date.now(), recovering: false }));
  vi.spyOn(fm.stormWindow, "isActive").mockReturnValue(false);
  const backend: any = { binaryName: "fixture", getReadyPattern: () => /^READY$/m, getBusyPattern: () => /BUSY/,
    readInputRow: (pane: string) => ({ text: pane.includes("DRAFT") ? "draft" : "", collapsedPastes: 0 }), getSessionId: () => "owned-session" };
  const dir = fm.getInstanceDir("worker"); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const d = new Daemon("worker", fm.fleetConfig.instances.worker, dir, true, backend, undefined, pino({ level: "silent" }) as any) as any;
  d.processStatus = "running"; d.instanceState = "idle"; d.recoveryBootSettled = true; d.saveSessionId();
  d.ipcServer = { broadcast: vi.fn() }; d.mcpServerAlive = () => ({ alive: true, source: "connection" });
  d.start = d.wake = d.trySpawn = d.pushChannelMessage = io.forbidden;
  const paste = vi.fn(async (_text, opts) => opts.guard()), enter = vi.fn(async () => true);
  d.tmux = { capturePane: vi.fn(async () => "READY"), getPaneInputMode: vi.fn(async () => "raw"),
    pasteBuffer: paste, sendSpecialKey: enter, getWindowId: () => "@scratch" };
  d.waitForInputTransientToClear = vi.fn(async () => true); d.confirmSubmitted = vi.fn(async () => "submitted");
  d.setDeliveryOutboxPort(fm.deliveryOutbox);
  // Only a published General owner is needed for durable summary admission. No General handler is driven.
  fm.daemons.set("general", { bootId: "general-fixture" }); fm.lifecycle.daemons.set("worker", d);
  const board = fm.scheduler.db.board, actor = { kind: "instance", name: "worker" } as const;
  const created = board.createCards(actor, { cards: [{ title: "private task text", assignee: "worker" }] }).cards[0];
  board.moveCard(actor, created.code, "claimed"); const card = board.findCard(created.uuid);
  const old: any = { version: 1, managerBootId: "previous-manager", observedAt: 1, reason: "before_stop", lastActivityAt: 1,
    observation: d.getWorkingStateObservation(), references: [{ kind: "task", id: card.uuid, version: card.version, status: card.status }], totalReferences: 1, unavailable: [] };
  fm.deliveryOutbox.observeWorkingState("worker", old);
  fm.onDaemonReady("worker", d.bootId); // real publication discovers the retained prior snapshot
  const stable = async () => { fm.startupComplete = true; fm.workingRecovery.ready(); fm.workingRecovery.tick(); await vi.advanceTimersByTimeAsync(120_000); fm.workingRecovery.tick(); };
  const dispatch = async () => {
    const row = fm.deliveryOutbox.claimNext(fm.managerBootId, (name: string) => name === "worker" ? d.bootId : null, new Set(), (r: any) => fm.recoveryDeliveryEligible(r));
    if (row) { const sending = fm.dispatchDurableDelivery(row); await vi.advanceTimersByTimeAsync(1000); await sending; }
    return row;
  };
  return { fm, d, card, board, paste, enter, stable, dispatch, pressure: (v: string) => { level = v; } };
}
describe("#2473 manager recovery wiring", () => {
  it.each(["manual_restart", "update"])("records completed SIGTERM shutdown intent as %s", async cause => {
    const f = fixture(); f.fm.daemons.delete("general");
    f.d.stop = vi.fn(async () => {});
    vi.spyOn(f.fm.memoryPressure, "sample").mockReturnValue({ level: "normal" });
    if (cause === "update") {
      beginUpdateProgress(f.fm.dataDir, { adapterId: "fixture", chatId: "chat", messageId: "message" });
      setUpdateProgressStage(f.fm.dataDir, "stopping");
    }
    const events = new Map<string, (...args: any[]) => any>();
    const runtime = { on: (event: string, fn: (...args: any[]) => any) => events.set(event, fn), exit: vi.fn() };
    installFleetProcessHandlers({ dataDir: f.fm.dataDir, manager: f.fm, runtime: runtime as any,
      describeSignal: () => "inert SIGTERM", console: { log: vi.fn(), error: vi.fn() } });
    await events.get("SIGTERM")!();
    expect(f.d.stop).toHaveBeenCalledOnce(); expect(runtime.exit).toHaveBeenCalledWith(0);
    expect(f.fm.deliveryOutbox.workingRecovery.beginRun("next-manager", 123, Date.now())).toBe(cause);
  });
  it("SIGUSR2 reaches the real in-process restart entry and refreshes its requested cause", async () => {
    const f = fixture(); f.fm.configPath = join(f.fm.dataDir, "fleet.yaml"); f.fm.daemons.delete("general");
    f.fm.probeCliEnvs = vi.fn(); f.d.waitForIdle = vi.fn(async () => {});
    f.fm.clearStatuslineWatchers = vi.fn(() => { throw Error("inert restart boundary"); });
    const actual = f.fm.restartInstances.bind(f.fm); f.fm.restartInstances = vi.fn(actual);
    f.fm.onGracefulRestartSignal(vi.fn());
    await expect(f.fm.restartInstances.mock.results[0].value).rejects.toThrow("inert restart boundary");
    expect(f.fm.workingRecoveryCause).toBe("manual_restart");
    expect(f.fm.deliveryOutbox.workingRecovery.beginRun("next-manager", 123, Date.now())).toBe("manual_restart");
  });
  it("a recovery row cannot wake a paused target, while ordinary queued work still can", async () => {
    const f = fixture(); await f.stable();
    f.fm.fleetConfig.defaults.delivery_worker = "wake_only"; f.d.pauseWakeState = "paused";
    const wake = vi.spyOn(f.fm.lifecycle, "wake").mockImplementation(async () => { f.d.pauseWakeState = "active"; });
    vi.spyOn(f.fm, "getInstanceStatus").mockReturnValue("paused");
    const coordinator = f.fm.createWakeCoordinator(); coordinator.start();
    try {
      await vi.advanceTimersByTimeAsync(10); expect(wake).not.toHaveBeenCalled();
      f.fm.deliveryOutbox.admitSystemNotice("worker", "ordinary-work", "ordinary work");
      coordinator.kick(); await vi.advanceTimersByTimeAsync(10); expect(wake).toHaveBeenCalledOnce();
    } finally { coordinator.stop(); }
  });
  it("withdraws an admitted continuation when ordinary work arrives for the same target", async () => {
    const f = fixture(); await f.stable(); const episode = f.fm.deliveryOutbox.workingRecovery.get("worker");
    const row = f.fm.deliveryOutbox.get(episode.deliveryId);
    f.fm.deliveryOutbox.admitSystemNotice("worker", "newer-work", "ordinary work");
    expect(f.fm.recoveryDeliveryEligible(row)).toBe(false);
    expect(f.fm.deliveryOutbox.get(row.deliveryId).state).toBe("cancelled");
    expect(f.paste).not.toHaveBeenCalled();
  });
  it("rechecks recovery authority after the actual writer's awaited capture", async () => {
    const f = fixture(); await f.stable();
    f.d.tmux.capturePane.mockImplementation(async () => {
      f.fm.fleetConfig.instances.worker.resume_interrupted_work = false; return "READY";
    });
    const row = await f.dispatch(); expect(row).toBeDefined();
    expect(f.paste).not.toHaveBeenCalled(); expect(f.enter).not.toHaveBeenCalled();
    expect(f.fm.deliveryOutbox.get(row.deliveryId).state).toBe("retry_wait");
  });
  it("records a prior restart request separately from the unknown observed interruption cause", async () => {
    const f = fixture(); f.fm.workingRecoveryCause = "manual_restart";
    const info = vi.spyOn(f.fm.logger, "info").mockImplementation(() => {});
    await f.stable();
    const entry = f.fm.eventLog.query({ instance: "worker", type: "working_state" })
      .find((e: any) => e.payload.reason === "advisory_background_unknown");
    expect(entry.payload).toMatchObject({ observedCause: "unknown_interruption", requestedAction: "manual_restart" });
    expect(entry.payload.message).toContain("observed cause unknown_interruption; prior requested action manual_restart");
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ observedCause: "unknown_interruption", requestedAction: "manual_restart" }),
      "Interrupted work recovery decision");
  });
  it("the General summary waits for General's own continuation instead of superseding it", async () => {
    const f = fixture();
    f.fm.fleetConfig.instances.worker.general_topic = true;
    f.fm.fleetConfig.instances.general.general_topic = false;
    await f.stable();
    const summaries = () => f.fm.deliveryOutbox.listPending().filter((r: any) => r.sourceKey?.startsWith("working-recovery-summary:"));
    expect(summaries()).toHaveLength(0);
    const row = await f.dispatch();
    expect(row.kind).toBe("working_recovery");
    expect(f.paste).toHaveBeenCalledOnce(); expect(f.enter).toHaveBeenCalledOnce();
    expect(f.fm.deliveryOutbox.get(row.deliveryId).state).toBe("delivered");
    expect(f.fm.deliveryOutbox.getWorkingState("worker").current.observation.recoveryDeliveryId).toBe(row.deliveryId);
    f.fm.workingRecovery.tick(); f.fm.workingRecovery.tick();
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0].targetInstance).toBe("worker");
  });
  it("publishes newly owned session metadata from the existing checkpoint without waiting for a state edge", () => {
    const f = fixture(), outbox = f.fm.deliveryOutbox;
    f.d.ownedWorkingSession = null; f.fm.observeWorkingState("worker", "process");
    expect(outbox.getWorkingState("worker").current.observation.sessionId).toBeNull();
    f.d.saveSessionId();
    expect(outbox.getWorkingState("worker").current.observation.sessionId).toBe("owned-session");
    const revision = outbox.getWorkingState("worker").revision;
    f.d.saveSessionId(); expect(outbox.getWorkingState("worker").revision).toBe(revision);
  });
  it("captures the task boundary before full shutdown closes the scheduler", async () => {
    const f = fixture(), outbox = f.fm.deliveryOutbox;
    // This scenario starts with current work, without a prior interruption.
    (outbox as any).db.prepare("UPDATE working_state_journal SET prior_json=NULL").run();
    f.fm.daemons.delete("general");
    f.d.stop = vi.fn(async () => { f.d.publishWorkingState("before_stop"); });
    vi.spyOn(f.fm.memoryPressure, "sample").mockReturnValue({ level: "normal" });
    await f.fm.stopAll();
    const prior = outbox.getWorkingState("worker")?.prior;
    expect(prior?.references).toEqual([{ kind: "task", id: f.card.uuid, version: f.card.version, status: "claimed" }]);
    expect(prior?.unavailable).toEqual([]); expect(f.d.stop).toHaveBeenCalledOnce();
  });
  it("publishes, revalidates a real claimed card, and dispatches one background-unknown advisory without a human turn", async () => {
    const f = fixture(); expect(f.fm.deliveryOutbox.workingRecovery.get("worker")?.outcome).toBe("deferred");
    await f.stable(); expect(f.fm.workingRecovery.stable()).toBe(true);
    expect(f.fm.workingRecovery.verdict(f.fm.deliveryOutbox.workingRecovery.get("worker"))).toMatchObject({ outcome: "ready", advisory: true });
    expect(f.fm.deliveryOutbox.workingRecovery.get("worker").outcome).toBe("admitted");
    const row = await f.dispatch(); expect(row).toBeDefined();
    expect(f.paste).toHaveBeenCalledOnce(); expect(f.enter).toHaveBeenCalledOnce();
    const text = f.paste.mock.calls[0][0]; expect(text).toContain("background state is unknown"); expect(text).toContain(f.card.uuid);
    expect(text).not.toContain("private task text"); expect(f.d.turnReplyGuard.snapshot()).toBeNull();
    expect(f.fm.deliveryOutbox.get(row.deliveryId).state).toBe("delivered"); expect(await f.dispatch()).toBeUndefined();
    const summary = f.fm.deliveryOutbox.listPending().find((r: any) => r.targetInstance === "general");
    expect(summary.payload.content).toContain("Advisory, background unknown: worker");
    expect(f.fm.eventLog.query({ instance: "worker", type: "working_state" }).some((e: any) => JSON.stringify(e).includes("advisory_background_unknown"))).toBe(true);
    expect(f.fm.deliveryOutbox.openReplyObligations("worker")).toEqual([]);
  });
  it.each(["known_background", "unknown_owner", "pressure", "opt_out"])("holds %s, preserving the episode until the condition clears", async condition => {
    const f = fixture();
    if (condition === "known_background") f.d.workingBackgroundObservation = true;
    if (condition === "unknown_owner") f.d.ownedWorkingSession = null;
    if (condition === "pressure") f.pressure("elevated");
    if (condition === "opt_out") f.fm.fleetConfig.instances.worker.resume_interrupted_work = false;
    await f.stable(); expect(await f.dispatch()).toBeUndefined(); expect(f.paste).not.toHaveBeenCalled();
    expect(f.fm.deliveryOutbox.workingRecovery.get("worker")?.outcome).toBe("deferred");
    if (condition === "unknown_owner") {
      const summary = f.fm.deliveryOutbox.listPending().find((r: any) => r.targetInstance === "general");
      expect(summary.payload.content).toContain("Deferred advisory candidates (background unknown; all other gates still apply): worker (session_unknown)");
    }
    f.d.workingBackgroundObservation = null; f.d.ownedWorkingSession = "owned-session"; f.pressure("normal");
    f.fm.fleetConfig.instances.worker.resume_interrupted_work = true;
    f.fm.workingRecovery.tick(); await vi.advanceTimersByTimeAsync(30_000); f.fm.workingRecovery.tick();
    expect(await f.dispatch()).toBeDefined(); expect(f.paste).toHaveBeenCalledOnce();
  });
  it("a hot per-instance opt-out holds an already admitted row, with no loss of the journal or duplicate admission", async () => {
    const f = fixture(); await f.stable(); const key = f.fm.deliveryOutbox.workingRecovery.get("worker").key;
    f.fm.fleetConfig.instances.worker.resume_interrupted_work = false;
    expect(await f.dispatch()).toBeUndefined(); expect(f.fm.deliveryOutbox.workingRecovery.get("worker").key).toBe(key);
    expect(f.fm.deliveryOutbox.getWorkingState("worker")).toBeDefined();
    f.fm.fleetConfig.instances.worker.resume_interrupted_work = true; expect(await f.dispatch()).toBeDefined();
    expect(f.paste).toHaveBeenCalledOnce();
  });
  it("its own real working observation during paste does not cancel the owned Enter", async () => {
    const f = fixture(); await f.stable();
    f.paste.mockImplementation(async (_text, options) => {
      f.d.applyInstanceStateSnapshot({ state: "working", observedAt: Date.now(), stateChangedAt: Date.now(), unchangedForMs: 0 });
      expect(options.guard()).toBe(true); return true;
    });
    const row = await f.dispatch(); expect(f.paste).toHaveBeenCalledOnce(); expect(f.enter).toHaveBeenCalledOnce();
    expect(f.fm.deliveryOutbox.get(row.deliveryId).state).toBe("delivered");
    expect(f.d.getWorkingRecoveryState().nativeWork).toBe(true);
  });
  it("rechecks the claimed task after admission and does not drive a completed card", async () => {
    const f = fixture(); await f.stable(); f.board.moveCard({ kind: "instance", name: "worker" }, f.card.code, "done", { result: "Fixture task complete; inert assertions checked." });
    expect(await f.dispatch()).toBeUndefined(); expect(f.paste).not.toHaveBeenCalled();
    expect(f.fm.deliveryOutbox.listPending().filter((r: any) => r.targetInstance === "worker")).toEqual([]);
  });
});
