import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real Daemon/guard/state machine/fleet cancel entry points; no host lifecycle.
const hooks = vi.hoisted(() => ({
  forbidden: vi.fn((..._args: unknown[]): never => { throw new Error("Forbidden host IO in cancel-reply harness"); }),
}));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  exec: hooks.forbidden, execFile: hooks.forbidden, execSync: hooks.forbidden,
  execFileSync: hooks.forbidden, spawn: hooks.forbidden, spawnSync: hooks.forbidden, fork: hooks.forbidden,
}));
vi.mock("node:net", async importOriginal => ({
  ...await importOriginal<typeof import("node:net")>(),
  createServer: hooks.forbidden, createConnection: hooks.forbidden, connect: hooks.forbidden,
}));
vi.mock("../src/backend/factory.js", () => ({ createBackend: hooks.forbidden }));
vi.mock("../src/logger.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/logger.js")>(),
  createLogger: () => pino({ level: "silent" }),
}));

import { Daemon, PaneStateMachine } from "../src/daemon.js";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale, t } from "../src/locale.js";
import type { Logger } from "../src/logger.js";
import { TurnReplyGuard } from "../src/turn-reply-guard.js";

const dirs: string[] = [];
const logger = pino({ level: "silent" }) as Logger;
const meta = (messageId = "m1") => ({
  chat_id: "guild", thread_id: "room", adapter_id: "bot", message_id: messageId, correlation_id: `cid-${messageId}`,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

beforeEach(() => {
  hooks.forbidden.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));
  setLocale("en");
});
afterEach(() => {
  const forbiddenCalls = hooks.forbidden.mock.calls.length;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setLocale("en");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  expect(forbiddenCalls, "no process, backend construction, or socket IO").toBe(0);
});

function harness(key: "Escape" | "C-c" = "Escape") {
  const dir = mkdtempSync(join(tmpdir(), "agend-cancel-reply-"));
  dirs.push(dir);
  const backend = {
    binaryName: key === "C-c" ? "kiro-cli" : "claude", replyCompletionGuard: true,
    getReadyPattern: () => /^READY$/m, getBusyPattern: () => /WORKING/,
    getCancelKey: () => key,
  } as any;
  const daemon = new Daemon("worker", {
    backend: key === "C-c" ? "kiro-cli" : "claude-code", working_directory: dir,
    log_level: "silent", restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
  } as any, dir, true, backend, undefined, logger) as any;
  let pane = "READY";
  const writes: string[] = [];
  const interrupts: Array<{ key: string; cancelled: boolean }> = [];
  daemon.tmux = {
    capturePane: vi.fn(async () => pane),
    sendSpecialKey: vi.fn(async (key: string) => {
      interrupts.push({ key, cancelled: daemon.turnReplyGuard.snapshot()?.cancelledByUser === true });
    }),
  };
  daemon.deliverMessage = vi.fn(async (text: string, _status: unknown, opts?: { deliveryEpoch?: number }) => {
    if (opts?.deliveryEpoch !== undefined && !daemon.isDeliveryEpochCurrent(opts.deliveryEpoch)) return false;
    writes.push(text);
    return true;
  });
  daemon.deliverDaemonReply = vi.fn(async () => true);
  daemon.mcpServerAlive = vi.fn(() => ({ alive: true, source: "connection" }));
  daemon.ipcServer = { broadcast: vi.fn(), send: vi.fn(() => true) };
  daemon.instanceStateMonitorActive = true;
  daemon.instanceStateReadyPattern = backend.getReadyPattern();
  daemon.instanceStateMachine = new PaneStateMachine(backend.getReadyPattern(), 600_000, Date.now(), backend.getBusyPattern());
  daemon.wake = vi.fn(async () => {});
  // Catch an accidental lifecycle detour before it can touch the test host.
  daemon.start = hooks.forbidden;
  daemon.stop = hooks.forbidden;
  daemon.trySpawn = hooks.forbidden;
  daemon.handleCrash = hooks.forbidden;
  const detected = vi.fn();
  const unrecovered = vi.fn();
  const recovered = vi.fn();
  daemon.on("reply_drop_detected", detected);
  daemon.on("reply_drop_unrecovered", unrecovered);
  daemon.on("reply_drop_recovered", recovered);
  const fm = new FleetManager(dir) as any;
  fm.lifecycle.daemons.set("worker", daemon);
  fm.clearCancelButton = vi.fn();
  fm.resolveSlashTarget = vi.fn(() => "worker");
  return {
    daemon, fm, writes, interrupts, detected, unrecovered, recovered,
    async inbound(messageId = "m1") {
      daemon.pushChannelMessage(`task ${messageId}`, meta(messageId));
      await daemon.pasteLock;
    },
    async idle(waitForPaste = true) {
      pane = "READY";
      const outputAt = Date.now();
      daemon.instanceStateLastOutputAt = outputAt;
      daemon.applyInstanceStateSnapshot(daemon.instanceStateMachine.recordOutput(outputAt));
      vi.advanceTimersByTime(2_100);
      await daemon.captureAndEvaluateInstanceState("idle_debounce", outputAt);
      if (waitForPaste) await daemon.pasteLock;
    },
  };
}
type Harness = ReturnType<typeof harness>;
const prompts = (h: Harness) => h.writes.filter(text => text.startsWith("[system:reply-required]"));
function expectQuiet(h: Harness) {
  expect(h.detected).not.toHaveBeenCalled();
  expect(h.unrecovered).not.toHaveBeenCalled();
  expect(h.daemon.deliverDaemonReply).not.toHaveBeenCalled();
  expect(prompts(h)).toHaveLength(0);
}

let requestId = 0;
function reply(h: Harness) {
  const socket = new EventEmitter() as any;
  h.daemon.socketSessionNames.set(socket, "worker");
  const id = ++requestId;
  h.daemon.handleToolCall({ tool: "reply", requestId: id, args: { text: "already working on this reply" } }, socket);
  const pending = [...h.daemon.pendingIpcRequests.keys()].find((key: any) => key.endsWith(`_${id}`));
  expect(pending).toBeDefined();
  return {
    pending, socket, id,
    settle(result: unknown, error?: string) {
      h.daemon.routeFleetResponse({ type: "fleet_outbound_response", fleetRequestId: pending, result, error });
    },
  };
}

describe("#1199 generation-scoped cancellation evidence", () => {
  it("refuses recovery of a cancelled generation but still records an in-flight successful reply", () => {
    const guard = new TurnReplyGuard();
    const generation = guard.arm({ chatId: "c" });
    const attempt = guard.beginToolAttempt(true);
    expect(guard.cancelByUser()).toBe(generation);
    expect(guard.beginRecovery(generation)).toBe(false);
    guard.settleToolAttempt(attempt, true);
    expect(guard.snapshot()).toMatchObject({ generation, cancelledByUser: true, replyDelivered: true, completionDelivered: true });
    expect(guard.complete(generation)).toBe(true);
    expect(guard.snapshot()).toBeNull();
  });

  it("new human ingress gets a new uncancelled generation, never satisfied by the old ACK", () => {
    const guard = new TurnReplyGuard();
    const old = guard.arm({ chatId: "c", messageId: "old" });
    const attempt = guard.beginToolAttempt(true);
    guard.cancelByUser();
    const next = guard.arm({ chatId: "c", messageId: "new" });
    expect(next).toBeGreaterThan(old);
    guard.settleToolAttempt(attempt, true);
    expect(guard.snapshot()).toMatchObject({ generation: next, cancelledByUser: false, completionDelivered: false, replyAttempted: false });
    expect(guard.complete(old)).toBe(false);
    expect(guard.beginRecovery(next)).toBe(true);
  });

  it("cancel with no active turn does not cancel the next turn", () => {
    const guard = new TurnReplyGuard();
    expect(guard.cancelByUser()).toBeNull();
    const next = guard.arm({ chatId: "c" });
    expect(guard.snapshot()?.cancelledByUser).toBe(false);
    expect(guard.beginRecovery(next)).toBe(true);
  });
});

describe("#1199 real fleet cancel → real Daemon → idle", () => {
  it.each(["Escape", "C-c"] as const)("marks before sending %s, completes the cancelled turn without warning or prompt", async key => {
    const h = harness(key);
    await h.inbound();
    const generation = h.daemon.turnReplyGuard.snapshot().generation;
    expect(h.fm.cancelInstance("worker")).toBe(true);
    expect(h.interrupts).toEqual([{ key, cancelled: true }]);
    expect(h.daemon.turnReplyGuard.snapshot()).toMatchObject({ generation, cancelledByUser: true, phase: "awaiting" });
    await h.idle();
    expect(h.daemon.turnReplyGuard.snapshot()).toBeNull();
    expectQuiet(h);
  });

  it("a cancel button click uses the same synchronous guard signal", async () => {
    const h = harness();
    await h.inbound();
    h.fm.cancelButtons.set("button", { instanceName: "worker", messageId: "button" });
    h.fm.handleCancelClick("worker", null, { chatId: "guild", messageId: "button" });
    expect(h.interrupts).toEqual([{ key: "Escape", cancelled: true }]);
    await h.idle();
    expectQuiet(h);
  });

  it("topic /cancel uses the same real cancelInstance path", async () => {
    const h = harness();
    await h.inbound();
    const sendText = vi.fn(async () => ({ messageId: "cancel-confirmation" }));
    h.fm.topicCommands.getReplyAdapter = vi.fn(() => ({ sendText }));
    const handled = await h.fm.topicCommands.handleInstanceCommand({
      chatId: "guild", threadId: "room", messageId: "cancel", text: "/cancel", userId: "user", timestamp: new Date(),
    }, "worker");
    expect(handled).toBe(true);
    expect(h.interrupts).toEqual([{ key: "Escape", cancelled: true }]);
    await h.idle();
    expectQuiet(h);
  });

  it("an authorized slash /cancel uses the same real cancelInstance path", async () => {
    const h = harness();
    await h.inbound();
    // Authorization has independent coverage; this test starts after that gate.
    h.fm.authorizeSlash = vi.fn(async () => "fleet");
    h.fm.isModelAdmin = vi.fn(() => true);
    const respond = vi.fn(async () => {});
    await h.fm.dispatchSlash({ command: "cancel", channelId: "room", userId: "user", respond }, "bot", {});
    expect(respond).toHaveBeenCalledWith(t("cancel.sent", "worker"));
    expect(h.interrupts).toEqual([{ key: "Escape", cancelled: true }]);
    await h.idle();
    expectQuiet(h);
  });

  it("a stale recovery snapshot cannot restart a cancelled generation", async () => {
    const h = harness();
    await h.inbound();
    const turn = h.daemon.turnReplyGuard.snapshot();
    h.fm.cancelInstance("worker");
    h.daemon.startReplyRecovery(turn, "no_valid_call");
    expect(h.daemon.turnReplyGuard.snapshot()).toBeNull();
    expectQuiet(h);
  });

  it.each(["before cancel", "after cancel", "after cancelled idle"])("a reply acknowledged %s still returns its result", async when => {
    const h = harness();
    await h.inbound();
    const attempt = reply(h);
    const result = { messageId: "actual-delivered-reply" };
    if (when === "before cancel") attempt.settle(result);
    h.fm.cancelInstance("worker");
    if (when === "after cancelled idle") await h.idle();
    if (when !== "before cancel") attempt.settle(result);
    expect(h.daemon.ipcServer.send).toHaveBeenCalledWith(attempt.socket, expect.objectContaining({ requestId: attempt.id, result, error: undefined }));
    expect(h.daemon.pendingIpcRequests.has(attempt.pending)).toBe(false);
    if (when !== "after cancelled idle") expect(h.daemon.turnReplyGuard.snapshot()?.completionDelivered).toBe(true);
    await h.idle();
    expect(h.daemon.turnReplyGuard.snapshot()).toBeNull();
    expectQuiet(h);
  });

  it("a cancelled old reply settles normally without cancelling or fulfilling the new turn", async () => {
    const h = harness();
    await h.inbound();
    const oldGeneration = h.daemon.turnReplyGuard.snapshot().generation;
    const attempt = reply(h);
    h.fm.cancelInstance("worker");
    await h.inbound("m2");
    const newGeneration = h.daemon.turnReplyGuard.snapshot().generation;
    expect(newGeneration).toBeGreaterThan(oldGeneration);
    attempt.settle({ messageId: "old-reply" });
    expect(h.daemon.ipcServer.send).toHaveBeenCalledWith(attempt.socket, expect.objectContaining({ result: { messageId: "old-reply" } }));
    expect(h.daemon.turnReplyGuard.snapshot()).toMatchObject({ generation: newGeneration, cancelledByUser: false, completionDelivered: false });
    await h.idle();
    expect(h.detected).toHaveBeenCalledOnce();
    expect(prompts(h)).toHaveLength(1);
    expect(h.daemon.deliverDaemonReply).toHaveBeenCalledWith(t("inst.reply_drop_retrying"), "replydrop", "Reply-drop status", expect.objectContaining({ messageId: "m2" }), true);
  });

  it("a real fleet-routed, already-in-flight adapter POST is acknowledged after cancel", async () => {
    const h = harness();
    await h.inbound();
    const post = deferred<{ messageId: string; chatId: string }>();
    const sendText = vi.fn(() => post.promise);
    const adapter = { id: "bot", type: "discord", sendText };
    h.fm.adapter = adapter;
    h.fm.worlds.set("bot", { adapter });
    h.fm.classicChannels = {
      getChannelIdByInstance: () => "room", getAdapterIdByInstance: () => "bot",
    };
    h.fm.afterReplyRouted = vi.fn(); // progress/activity side effects are outside this contract
    h.fm.instanceIpcClients.set("worker", { send: (message: unknown) => { h.daemon.routeFleetResponse(message); return true; } });
    const attempt = reply(h);
    const message = h.daemon.ipcServer.broadcast.mock.calls.find(([msg]: any[]) => msg.fleetRequestId === attempt.pending)?.[0];
    expect(message).toBeDefined();
    await h.fm.handleOutboundFromInstance("worker", message);
    expect(sendText).toHaveBeenCalledOnce();
    expect(h.daemon.ipcServer.send).not.toHaveBeenCalled();
    h.fm.cancelInstance("worker");
    const result = { messageId: "platform-confirmed", chatId: "room" };
    post.resolve(result);
    await flush();
    expect(h.fm.afterReplyRouted).toHaveBeenCalledOnce();
    expect(h.daemon.ipcServer.send).toHaveBeenCalledWith(attempt.socket, expect.objectContaining({ requestId: attempt.id, result, error: undefined }));
    expect(h.daemon.turnReplyGuard.snapshot()).toMatchObject({ cancelledByUser: true, completionDelivered: true });
    await h.idle();
    expectQuiet(h);
  });

  it("non-cancelled uncertain reply remains non-retryable", async () => {
    const h = harness();
    await h.inbound();
    reply(h).settle(null, "POST outcome unknown");
    await h.idle();
    expect(prompts(h)).toHaveLength(0);
    expect(h.detected).toHaveBeenCalledWith(expect.objectContaining({ recoveryStarted: false, reason: "reply_failed_or_unknown" }));
    expect(h.daemon.deliverDaemonReply).toHaveBeenCalledWith(t("inst.reply_drop_unknown"), "replydrop", "Unconfirmed reply status", expect.anything(), true);
  });
});

describe("#1199 cancellation while awaiting recovery or ingress IO", () => {
  it("cancelling an already-running recovery turn makes its next idle intentional", async () => {
    const h = harness();
    await h.inbound();
    await h.idle();
    expect(prompts(h)).toHaveLength(1);
    h.daemon.deliverDaemonReply.mockClear();
    h.fm.cancelInstance("worker");
    await h.idle();
    expect(h.daemon.turnReplyGuard.snapshot()).toBeNull();
    expect(prompts(h)).toHaveLength(1);
    expect(h.unrecovered).not.toHaveBeenCalled();
    expect(h.daemon.deliverDaemonReply).not.toHaveBeenCalled();
  });

  it.each(["true", "false", "reject"])("an already-started malformed reply settles %s without a cancellation warning", async outcome => {
    const h = harness();
    await h.inbound();
    const pending = deferred<boolean>();
    h.daemon.deliverDaemonReply.mockImplementationOnce(() => pending.promise);
    h.daemon.queueMalformedReplyRecovery(h.daemon.turnReplyGuard.snapshot(), "already-started reply");
    expect(h.daemon.deliverDaemonReply).toHaveBeenCalledOnce();
    const event = vi.fn();
    h.daemon.on("malformed_tool_call", event);
    h.fm.cancelInstance("worker");
    if (outcome === "reject") pending.reject(new Error("reply failed")); else pending.resolve(outcome === "true");
    await h.daemon.pasteLock;
    expect(h.daemon.deliverDaemonReply).toHaveBeenCalledTimes(1); // the original request still settles; no new warning
    if (outcome === "true") expect(event).toHaveBeenCalledWith(expect.objectContaining({ recovered: true }));
    expect(h.daemon.turnReplyGuard.snapshot()).toBeNull();
    expect(h.detected).not.toHaveBeenCalled();
    expect(h.unrecovered).not.toHaveBeenCalled();
    expect(h.daemon.pasteQueueDepth).toBe(0);
  });

  it("drops queued recovery without a failed-recovery warning or leaked queue depth", async () => {
    const h = harness();
    await h.inbound();
    const hold = deferred<void>();
    h.daemon.pasteLock = hold.promise;
    await h.idle(false);
    expect(h.detected).toHaveBeenCalledOnce();
    h.daemon.deliverDaemonReply.mockClear(); // already-issued notice is not retractable
    h.fm.cancelInstance("worker");
    hold.resolve();
    await h.daemon.pasteLock;
    expect(h.daemon.turnReplyGuard.snapshot()).toBeNull();
    expect(h.daemon.pasteQueueDepth).toBe(0);
    expect(prompts(h)).toHaveLength(0);
    expect(h.unrecovered).not.toHaveBeenCalled();
    expect(h.daemon.deliverDaemonReply).not.toHaveBeenCalled();
  });

  it.each(["false", "reject"])("cancel during recovery IO suppresses its late %s failure", async outcome => {
    const h = harness();
    await h.inbound();
    const pending = deferred<boolean>();
    h.daemon.deliverMessage.mockImplementationOnce(() => pending.promise);
    await h.idle(false);
    await flush();
    h.daemon.deliverDaemonReply.mockClear();
    h.fm.cancelInstance("worker");
    if (outcome === "false") pending.resolve(false); else pending.reject(new Error("cancelled paste"));
    await h.daemon.pasteLock;
    expect(h.daemon.turnReplyGuard.snapshot()).toBeNull();
    expect(h.unrecovered).not.toHaveBeenCalled();
    expect(h.daemon.deliverDaemonReply).not.toHaveBeenCalled();
    expect(h.daemon.pasteQueueDepth).toBe(0);
  });

  it("late failed recovery cannot complete or warn for a new steered generation", async () => {
    const h = harness();
    await h.inbound();
    const pending = deferred<boolean>();
    h.daemon.deliverMessage.mockImplementationOnce(() => pending.promise);
    await h.idle(false);
    await flush();
    h.fm.cancelInstance("worker");
    // Independent steer lock may deliver new input while the old paste settles.
    h.daemon.markTurnStarted(meta("m2"), "new input", h.daemon.deliveryEpoch);
    const next = h.daemon.turnReplyGuard.snapshot().generation;
    h.daemon.deliverDaemonReply.mockClear();
    pending.reject(new Error("old recovery failed"));
    await h.daemon.pasteLock;
    expect(h.daemon.turnReplyGuard.snapshot()).toMatchObject({ generation: next, cancelledByUser: false, phase: "awaiting" });
    expect(h.unrecovered).not.toHaveBeenCalled();
    expect(h.daemon.deliverDaemonReply).not.toHaveBeenCalled();
    await h.idle();
    expect(h.detected).toHaveBeenCalledTimes(2); // old recovery plus the genuinely unanswered new turn
    expect(prompts(h)).toHaveLength(1);
  });

  it.each(["pushChannelMessage", "steerMessage", "btwMessage"])("late %s paste success cannot re-arm cancelled work", async method => {
    const h = harness();
    const pending = deferred<boolean>();
    h.daemon.deliverMessage.mockImplementationOnce(() => pending.promise);
    h.daemon[method]("task", meta());
    await flush();
    expect(h.daemon.deliverMessage).toHaveBeenCalledOnce();
    h.fm.cancelInstance("worker");
    pending.resolve(true);
    await h.daemon.pasteLock;
    await h.daemon.steerLock;
    expect(h.daemon.turnReplyGuard.snapshot()).toBeNull();
    await h.idle();
    expectQuiet(h);
    await h.inbound("new");
    await h.idle();
    expect(h.detected).toHaveBeenCalledOnce();
    expect(prompts(h)).toHaveLength(1);
  });
});
