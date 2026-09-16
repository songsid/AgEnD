import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { daemonBudgetMs } from "../src/channel/ipc-timeouts.js";
import { Daemon, PendingWorkTracker } from "../src/daemon.js";
import { TurnReplyGuard } from "../src/turn-reply-guard.js";
import type { Logger } from "../src/logger.js";

const logger = pino({ level: "silent" }) as Logger;
const dirs: string[] = [];
type AnyDaemon = any;

function makeDaemon(enabled = true, configured?: boolean): AnyDaemon {
  const dir = mkdtempSync(join(tmpdir(), "agend-reply-drop-"));
  dirs.push(dir);
  const backend = {
    binaryName: enabled ? "claude" : "codex",
    replyCompletionGuard: enabled,
  } as any;
  const daemon = new Daemon("worker", {
    backend: enabled ? "claude-code" : "codex",
    ...(configured === undefined ? {} : { reply_completion_guard: configured }),
    working_directory: dir,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    log_level: "silent",
  } as any, dir, true, backend, undefined, logger) as AnyDaemon;
  daemon.tmux = {};
  daemon.deliverMessage = vi.fn(async () => true);
  daemon.deliverDaemonReply = vi.fn(async () => true);
  daemon.mcpServerAlive = vi.fn(() => ({ alive: true, source: "connection" }));
  daemon.ipcServer = { broadcast: vi.fn(), send: vi.fn(() => true) };
  return daemon;
}

function meta(overrides: Record<string, string> = {}) {
  return {
    chat_id: "guild-1",
    thread_id: "channel-1",
    adapter_id: "discord-persona",
    message_id: "message-1",
    correlation_id: "cid-1",
    ...overrides,
  };
}

function idle(observedAt = Date.now()) {
  return { state: "idle", unchangedForMs: 0, observedAt, stateChangedAt: observedAt } as any;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("TurnReplyGuard", () => {
  it("counts only a successful adapter result, not a reply invocation", () => {
    const guard = new TurnReplyGuard();
    guard.arm({ chatId: "c" });
    const attempt = guard.beginToolAttempt(true);
    expect(guard.snapshot()).toMatchObject({ replyAttempted: true, replyDelivered: false });

    guard.settleToolAttempt(attempt, true);
    expect(guard.snapshot()).toMatchObject({ replyDelivered: true, outboundDelivered: true });
  });

  it("does not let an older in-flight reply satisfy a newer steering obligation", () => {
    const guard = new TurnReplyGuard();
    guard.arm({ chatId: "c", messageId: "m1" });
    const old = guard.beginToolAttempt(true);
    guard.arm({ chatId: "c", messageId: "m2" });
    guard.settleToolAttempt(old, true);

    expect(guard.snapshot()).toMatchObject({
      target: { messageId: "m2" },
      replyAttempted: false,
      replyDelivered: false,
    });
  });

  it("permits only one recovery phase per generation", () => {
    const guard = new TurnReplyGuard();
    const generation = guard.arm({ chatId: "c" });
    expect(guard.beginRecovery(generation)).toBe(true);
    expect(guard.beginRecovery(generation)).toBe(false);
    expect(guard.snapshot()?.phase).toBe("recovering");
  });
});

describe("Claude human-turn reply completion harness", () => {
  it("opts the production Claude backend into the guard", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-reply-guard-capability-"));
    dirs.push(dir);
    expect(new ClaudeCodeBackend(dir).replyCompletionGuard).toBe(true);
  });

  it("requires both the backend capability and the effective config switch", () => {
    const enabled = makeDaemon(true, true);
    const disabled = makeDaemon(true, false);
    const incapable = makeDaemon(false, true);

    expect(enabled.replyCompletionGuardEnabled()).toBe(true);
    expect(disabled.replyCompletionGuardEnabled()).toBe(false);
    expect(incapable.replyCompletionGuardEnabled()).toBe(false);

    disabled.applyConfigUpdate({ reply_completion_guard: true });
    expect(disabled.replyCompletionGuardEnabled()).toBe(true);
  });

  it("arms through the real human-message ingress and advances for steer and BTW", async () => {
    const daemon = makeDaemon();
    daemon.pushChannelMessage("do the task", meta());
    await daemon.pasteLock;
    expect(daemon.turnReplyGuard.snapshot()).toMatchObject({
      target: { messageId: "message-1" },
    });

    daemon.steerMessage("also check the logs", meta({ message_id: "message-2" }));
    await daemon.steerLock;
    expect(daemon.turnReplyGuard.snapshot()).toMatchObject({
      target: { messageId: "message-2" },
    });

    daemon.btwMessage("what version is installed?", meta({ message_id: "message-3" }));
    await daemon.steerLock;
    expect(daemon.turnReplyGuard.snapshot()).toMatchObject({
      target: { messageId: "message-3" },
    });
  });

  it("reports a zero-reply turn immediately and queues exactly one recovery prompt", async () => {
    const daemon = makeDaemon();
    const detected = vi.fn();
    daemon.on("reply_drop_detected", detected);
    daemon.markTurnStarted(meta(), "[user] do the task\nreply marker");
    daemon.instanceState = "working";

    daemon.applyInstanceStateSnapshot(idle(), "work finished\n❯");
    await daemon.pasteLock;

    expect(detected).toHaveBeenCalledWith(expect.objectContaining({
      name: "worker",
      correlationId: "cid-1",
      reason: "no_valid_call",
      recoveryStarted: true,
    }));
    expect(daemon.deliverDaemonReply).toHaveBeenCalledWith(
      expect.any(String), "replydrop", "Reply-drop status",
      expect.objectContaining({ adapterId: "discord-persona", chatId: "guild-1", threadId: "channel-1" }),
      true,
    );
    expect(daemon.deliverMessage).toHaveBeenCalledTimes(1);
    expect(daemon.deliverMessage.mock.calls[0][0]).toContain("Use the reply tool exactly once");
    expect(daemon.turnReplyGuard.snapshot()?.phase).toBe("recovering");
  });

  it("bounds a daemon-owned channel delivery that never receives a fleet response", async () => {
    vi.useFakeTimers();
    const daemon = makeDaemon();
    const deliver = (Daemon.prototype as any).deliverDaemonReply.call(
      daemon,
      "status",
      "replydrop",
      "Reply-drop status",
      { adapterId: "discord-persona", chatId: "guild-1", threadId: "channel-1" },
      true,
    ) as Promise<boolean>;
    let outcome: boolean | undefined;
    void deliver.then(result => { outcome = result; });

    await vi.advanceTimersByTimeAsync(daemonBudgetMs("reply"));

    expect(outcome).toBe(false);
    expect(daemon.pendingIpcRequests.size).toBe(0);
  });

  it("a successful reply in the recovery turn closes the incident", async () => {
    const daemon = makeDaemon();
    const recovered = vi.fn();
    daemon.on("reply_drop_recovered", recovered);
    daemon.markTurnStarted(meta(), "[user] do the task\nreply marker");
    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot(idle(), "work finished\n❯");
    await daemon.pasteLock;

    const socket = new EventEmitter() as any;
    daemon.socketSessionNames.set(socket, "worker");
    daemon.handleToolCall({ tool: "reply", args: { text: "done" }, requestId: 7 }, socket);
    const pending = [...daemon.pendingIpcRequests.entries()].find(([key]: [string]) => key.startsWith("tool_"));
    pending![1]({ result: { messageId: "sent-1" } });
    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot(idle(Date.now() + 1), "done\n❯");

    expect(recovered).toHaveBeenCalledOnce();
    expect(daemon.turnReplyGuard.snapshot()).toBeNull();
    expect(daemon.deliverMessage).toHaveBeenCalledTimes(1);
  });

  it("does not create a third turn when the one recovery turn is also silent", async () => {
    const daemon = makeDaemon();
    const unrecovered = vi.fn();
    daemon.on("reply_drop_unrecovered", unrecovered);
    daemon.markTurnStarted(meta(), "[user] do the task\nreply marker");
    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot(idle(), "work finished\n❯");
    await daemon.pasteLock;

    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot(idle(Date.now() + 1), "still no reply\n❯");

    expect(unrecovered).toHaveBeenCalledOnce();
    expect(daemon.deliverMessage).toHaveBeenCalledTimes(1);
    expect(daemon.turnReplyGuard.snapshot()).toBeNull();
  });

  it("does not ask the model to resend an attempted reply whose delivery is unknown", () => {
    const daemon = makeDaemon();
    daemon.markTurnStarted(meta(), "[user] do the task\nreply marker");
    const socket = new EventEmitter() as any;
    daemon.socketSessionNames.set(socket, "worker");
    daemon.handleToolCall({ tool: "reply", args: { text: "maybe delivered" }, requestId: 8 }, socket);
    const pending = [...daemon.pendingIpcRequests.entries()].find(([key]: [string]) => key.startsWith("tool_"));
    pending![1]({ result: null, error: "provider timed out" });
    daemon.instanceState = "working";

    daemon.applyInstanceStateSnapshot(idle(), "❯");

    expect(daemon.deliverDaemonReply).toHaveBeenCalledWith(
      expect.any(String), "replydrop", "Unconfirmed reply status", expect.any(Object),
      true,
    );
    expect(daemon.deliverMessage).not.toHaveBeenCalled();
    expect(daemon.turnReplyGuard.snapshot()).toBeNull();
  });

  it("does not arm the guard for /raw or cross-instance delivery", async () => {
    const daemon = makeDaemon();
    daemon.pushChannelMessage("/raw do not reply", meta());
    await daemon.pasteLock;
    expect(daemon.turnReplyGuard.snapshot()).toBeNull();

    daemon.markTurnStarted({ ...meta(), from_instance: "worker-2", chat_id: "" }, "handoff");
    expect(daemon.turnReplyGuard.snapshot()).toBeNull();
  });

  it("leaves non-opted-in backends byte-for-byte on the no-recovery path", () => {
    const daemon = makeDaemon(false);
    daemon.markTurnStarted(meta(), "[user] do the task\nreply marker");
    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot(idle(), "work finished\nREADY");

    expect(daemon.deliverDaemonReply).not.toHaveBeenCalled();
    expect(daemon.deliverMessage).not.toHaveBeenCalled();
    expect(daemon.turnReplyGuard.snapshot()).toBeNull();
  });

  it("does not consume a new obligation on a stale idle snapshot", () => {
    const daemon = makeDaemon();
    daemon.markTurnStarted(meta(), "[user] do the task\nreply marker");
    daemon.pendingWork = new PendingWorkTracker(0);
    daemon.pendingWork.recordInbound(200);
    daemon.instanceState = "working";

    daemon.applyInstanceStateSnapshot(idle(100), "old ready frame\n❯");

    expect(daemon.deliverDaemonReply).not.toHaveBeenCalled();
    expect(daemon.deliverMessage).not.toHaveBeenCalled();
    expect(daemon.turnReplyGuard.snapshot()).not.toBeNull();
  });
});
