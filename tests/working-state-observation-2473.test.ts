/** Real Daemon/FleetManager/SQLite, with all native CLI/network boundaries forbidden. */
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({ forbidden: vi.fn(() => { throw Error("native IO forbidden in journal tests"); }) }));
vi.mock("node:child_process", async load => ({ ...await load<typeof import("node:child_process")>(), exec: io.forbidden, execFile: io.forbidden, execSync: io.forbidden,
  execFileSync: io.forbidden, spawn: io.forbidden, spawnSync: io.forbidden, fork: io.forbidden }));
vi.mock("node:net", async load => ({ ...await load<typeof import("node:net")>(), createServer: io.forbidden, createConnection: io.forbidden, connect: io.forbidden }));
vi.mock("../src/backend/factory.js", () => ({ createBackend: io.forbidden }));
vi.mock("../src/logger.js", async load => ({ ...await load<typeof import("../src/logger.js")>(), createLogger: () => pino({ level: "silent" }) }));
import { Daemon } from "../src/daemon.js";
import { FleetManager } from "../src/fleet-manager.js";
import { Scheduler } from "../src/scheduler/index.js";
import { EventLog } from "../src/event-log.js";
import type { Logger } from "../src/logger.js";

const roots: string[] = [], fleets: any[] = [];
beforeEach(() => { vi.useFakeTimers(); io.forbidden.mockClear(); });
afterEach(() => {
  for (const fm of fleets.splice(0)) { fm.taskBoardWaker?.stop(); fm.deliveryOutbox?.close(); fm.scheduler?.db.close(); fm.eventLog?.close(); }
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  expect(io.forbidden).not.toHaveBeenCalled();
});
function rig() {
  const root = mkdtempSync(join(tmpdir(), "working-observe-2473-")); roots.push(root);
  vi.stubEnv("AGEND_HOME", root); vi.stubEnv("HOME", root);
  const fm = new FleetManager(root) as any; fleets.push(fm);
  fm.fleetConfig = { defaults: {}, instances: { worker: { working_directory: root, backend: "mock" }, other: { working_directory: root, backend: "mock" } }, web: { log_tab: true } };
  fm.scheduleDeliveryOutboxPump = vi.fn(); fm.emitSseEvent = vi.fn();
  fm.ensureDeliveryOutbox(); fm.eventLog = new EventLog(join(root, "events.db"));
  fm.scheduler = new Scheduler(join(root, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => true);
  fm.attachTaskBoard(fm.scheduler.db);
  const make = (name = "worker") => {
    const backend = { binaryName: "mock", replyCompletionGuard: true, getReadyPattern: () => /^READY$/m,
      getBusyPattern: () => /WORKING/, getSessionId: io.forbidden, getCancelKey: () => "Escape" } as any;
    const dir = fm.getInstanceDir(name); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const d = new Daemon(name, { backend: "mock", working_directory: root, log_level: "silent" } as any, dir, true, backend,
      undefined, pino({ level: "silent" }) as unknown as Logger) as any;
    // No native start/wake/paste/CLI is permitted; transition tests call the real prototype with inert effects.
    d.start = d.wake = d.trySpawn = d.pushChannelMessage = io.forbidden;
    d.ipcServer = { broadcast: vi.fn(), send: vi.fn(() => true), close: vi.fn(async () => {}) };
    d.mcpServerAlive = vi.fn(() => ({ alive: true, source: "connection" }));
    d.processStatus = "running"; d.instanceState = "idle";
    fm.lifecycle.daemons.set(name, d); fm.onDaemonReady(name, d.bootId);
    return d;
  };
  const d = make();
  const entry = (name = "worker") => fm.deliveryOutbox.getWorkingState(name);
  const arm = (which = d, id = "delivery-private") => which.markTurnStarted({ chat_id: "chat-private", message_id: "message-private",
    correlation_id: "cid-private", delivery_id: id }, "must-not-copy-message-or-secret");
  return { root, fm, d, make, entry, arm };
}

/** Real pause/wake transitions; only native checkpoint/quit/spawn/monitor effects are inert. */
function inertPauseWake(d: any) {
  d.tmux = { getPaneStatus: vi.fn(async () => ({ alive: false, exitCode: 0 })) };
  d.checkpointSessionId = vi.fn(async () => {});
  d.sendQuitSequence = vi.fn(async () => {});
  d.trySpawn = vi.fn(async () => true);
  d.resumeRuntimeMonitors = vi.fn();
}

describe("#2473 stage1 production wiring", () => {
  it("records an accepted pause without another pane state edge or explicit journal refresh", async () => {
    const { d, entry } = rig(); inertPauseWake(d);
    const pausing = d.pause(); await vi.advanceTimersByTimeAsync(200); await pausing;
    expect(d.isPaused).toBe(true);
    expect(d.getWorkingStateObservation().executionState).toBe("paused");
    expect(entry().current.observation.executionState).toBe("paused");
    expect(d.sendQuitSequence).toHaveBeenCalledTimes(1);
  });
  it("records an accepted wake to the same idle state without another pane edge", async () => {
    const { d, entry } = rig(); inertPauseWake(d);
    const pausing = d.pause(); await vi.advanceTimersByTimeAsync(200); await pausing;
    await Daemon.prototype.wake.call(d);
    expect(d.isPaused).toBe(false);
    expect(d.getWorkingStateObservation().executionState).toBe("idle");
    expect(entry().current.observation.executionState).toBe("idle");
    expect(entry().current.observation.owner).toEqual(d.getInteractionSnapshot().owner);
    expect(d.trySpawn).toHaveBeenCalledTimes(1);
  });
  it("records published/working/idle edges but not heartbeat writes, without backend discovery", () => {
    const { fm, d, entry } = rig();
    expect(entry().current.observation.executionState).toBe("idle");
    const rev = entry().revision;
    const now = Date.now(); const working = { state: "working", observedAt: now, stateChangedAt: now, unchangedForMs: 0 };
    d.applyInstanceStateSnapshot(working);
    expect(entry().current.observation.executionState).toBe("working");
    const workingRev = entry().revision; expect(workingRev).toBeGreaterThan(rev);
    d.applyInstanceStateSnapshot(working); expect(entry().revision).toBe(workingRev);
    d.applyInstanceStateSnapshot({ ...working, state: "idle" });
    expect(entry().current.observation.executionState).toBe("idle");
    expect(fm.eventLog.query({ instance: "worker", type: "working_state" })).toHaveLength(3);
    expect(fm.emitSseEvent).toHaveBeenCalledWith("steps_tick", { instance: "worker" });
  });
  it("records turn/cancel/closure and preserves the existing #1209 marker semantics", () => {
    const { d, entry, arm } = rig(); arm();
    const marker = join(d.instanceDir, "in-flight-turn.json");
    expect(existsSync(marker)).toBe(true);
    expect(entry().current.observation.turn).toMatchObject({ deliveryId: "delivery-private", cancelled: false, completionDelivered: false });
    expect(JSON.stringify(entry())).not.toContain("must-not-copy");
    d.clearPendingDeliveries();
    expect(entry().current.reason).toBe("cancelled"); expect(entry().current.observation.turn.cancelled).toBe(true);
    expect(existsSync(marker)).toBe(false);
    arm(d, "next-delivery"); d.turnReplyGuard.complete(d.turnReplyGuard.snapshot().generation);
    expect(entry().current.reason).toBe("turn_closed"); expect(entry().current.observation.turn).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });
  it("observes confirmed completion before idle, with no new completion rule", async () => {
    const { d, entry, arm } = rig(); arm();
    const socket = new EventEmitter() as any; d.socketSessionNames.set(socket, "worker");
    d.handleToolCall({ tool: "reply", args: { text: "done" }, requestId: 7 }, socket);
    const pending = [...d.pendingIpcRequests.entries()].find(([key]) => String(key).endsWith("7")) as any;
    expect(pending).toBeDefined(); pending[1]({ result: { ok: true } });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(entry().current.observation.turn?.completionDelivered).toBe(true);
    expect(existsSync(join(d.instanceDir, "in-flight-turn.json"))).toBe(false);
  });
  it("captures active work before the real stop resets its guard", async () => {
    const { d, entry, arm } = rig(); arm(); await d.stop();
    expect(d.turnReplyGuard.snapshot()).toBeNull();
    expect(entry().prior?.observation.turn?.deliveryId).toBe("delivery-private");
    expect(entry().current.reason).toBe("before_stop");
  });
  it("records an idle background task from an existing pane without capturing another pane", () => {
    const { fm, d, entry } = rig();
    d.backend.backgroundWorkRunning = (pane: string) => pane.includes("BACKGROUND");
    const snapshot = { state: "idle", observedAt: Date.now(), stateChangedAt: Date.now(), unchangedForMs: 0 };
    fm.lastActivity.set("worker", 12345);
    d.applyInstanceStateSnapshot(snapshot, "BACKGROUND running");
    expect(entry().current.observation).toMatchObject({ executionState: "idle", backgroundWork: true });
    expect(entry().current.lastActivityAt).toBe(12345);
    const rev = entry().revision;
    d.applyInstanceStateSnapshot(snapshot, "BACKGROUND running"); expect(entry().revision).toBe(rev);
    d.applyInstanceStateSnapshot(snapshot, "READY"); expect(entry().current.observation.backgroundWork).toBe(false);
    d.beginSpawn(); d.endSpawn(); expect(d.getWorkingStateObservation().backgroundWork).toBeNull();
  });
  it("rejects events from a replaced daemon and from an old generation of the same daemon", () => {
    const { d, make, entry } = rig(); const old = d.getWorkingStateObservation();
    const replacement = make(); const stable = entry();
    d.emit("working_state", { reason: "execution", observation: { ...old, executionState: "working" } });
    expect(entry()).toEqual(stable);
    const beforeSpawn = replacement.getWorkingStateObservation();
    replacement.beginSpawn(); replacement.endSpawn(); const newer = entry();
    replacement.emit("working_state", { reason: "execution", observation: { ...beforeSpawn, executionState: "working" } });
    expect(entry()).toEqual(newer);
  });
  it("refreshes both sides of task reassignment using UUID/version, never card text", () => {
    const { fm, make, entry } = rig(); make("other"); const board = fm.scheduler.db.board;
    const actor = { kind: "instance", name: "worker" } as const;
    const card = board.createCards(actor, { cards: [{ title: "must-not-copy-task-title", assignee: "worker" }] }).cards[0];
    board.moveCard(actor, card.code, "claimed");
    expect(entry().current.references).toMatchObject([{ kind: "task", id: card.uuid, status: "claimed" }]);
    expect(JSON.stringify(entry())).not.toContain("must-not-copy");
    board.updateCard({ kind: "person", name: "operator" }, card.code, { assignee: "other" });
    expect(entry().current.references).toEqual([]);
    expect(entry("other").current.references).toMatchObject([{ kind: "task", id: card.uuid }]);
  });
  it("keeps source-unavailable explicit instead of inferring no work", () => {
    const { fm, entry } = rig(); fm.scheduler.db.close(); fm.scheduler = null;
    fm.observeWorkingState("worker", "tasks");
    expect(entry().current.unavailable).toEqual(["tasks"]);
  });
  it("journal failures cannot prevent cancel, marker clearing or normal task mutations", () => {
    const { fm, d, arm } = rig(); arm();
    vi.spyOn(fm.deliveryOutbox, "observeWorkingState").mockImplementation(() => { throw Error("storage unavailable"); });
    expect(() => d.clearPendingDeliveries()).not.toThrow();
    expect(existsSync(join(d.instanceDir, "in-flight-turn.json"))).toBe(false);
    const created = fm.scheduler.db.board.createCards({ kind: "instance", name: "worker" }, { cards: [{ title: "ordinary task", assignee: "worker" }] });
    expect(created.cards).toHaveLength(1);
  });
  it("never discovers a session or writes raw configuration or message text", () => {
    const { fm, d, entry } = rig();
    d.config.backend_options = { mock: { secret: "must-not-copy-config-secret" } };
    expect(() => d.getWorkingStateObservation()).not.toThrow();
    fm.observeWorkingState("worker", "execution");
    expect(entry().current.observation.sessionId).toBeNull();
    expect(JSON.stringify(entry())).not.toContain("must-not-copy");
    expect(entry().current.observation.configuration).toMatch(/^[a-f0-9]{64}$/);
  });
});
