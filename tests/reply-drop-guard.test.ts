import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { daemonBudgetMs } from "../src/channel/ipc-timeouts.js";
import { Daemon, PaneStateMachine, PendingWorkTracker } from "../src/daemon.js";
import { TurnReplyGuard } from "../src/turn-reply-guard.js";
import type { Logger } from "../src/logger.js";

// Backend capability checks need no installed CLI or host PATH lookup.
vi.mock("../src/backend/types.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/backend/types.js")>(),
  resolveBinary: (name: string) => name,
}));

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

function working(observedAt = Date.now()) {
  return { state: "working", unchangedForMs: 0, observedAt, stateChangedAt: observedAt } as any;
}

/** Feed a genuinely observed busy period, then an idle edge — the confirm flow's entry. */
function busyThenIdleEdge(daemon: AnyDaemon, pane = "work finished\n❯") {
  daemon.applyInstanceStateSnapshot(working(), pane);
  daemon.applyInstanceStateSnapshot(idle(), pane);
}

/**
 * #1241: advance past the guard's idle-confirm window and deliver one more
 * steady idle snapshot, so a still-silent turn is evaluated as proven idle.
 */
async function elapseConfirmWindow(daemon: AnyDaemon, pane = "work finished\n❯") {
  await vi.advanceTimersByTimeAsync(61_000);
  daemon.applyInstanceStateSnapshot(idle(Date.now()), pane);
  await daemon.pasteLock;
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
    expect(guard.snapshot()).toMatchObject({ replyDelivered: true, completionDelivered: true, outboundDelivered: true });
  });

  it.each(["react", "edit_message"])("counts a successful %s as a delivered channel response", () => {
    const guard = new TurnReplyGuard();
    guard.arm({ chatId: "c" });
    const attempt = guard.beginToolAttempt(false, true);
    expect(guard.snapshot()).toMatchObject({
      replyAttempted: false,
      replyDelivered: false,
      completionDelivered: false,
      outboundDelivered: false,
    });

    guard.settleToolAttempt(attempt, true);
    expect(guard.snapshot()).toMatchObject({
      replyAttempted: false,
      replyDelivered: false,
      completionDelivered: true,
      outboundDelivered: true,
    });
  });

  it("tracks ordinary outbound work without treating it as a human-facing response", () => {
    const guard = new TurnReplyGuard();
    guard.arm({ chatId: "c" });
    const attempt = guard.beginToolAttempt(false, false);
    guard.settleToolAttempt(attempt, true);

    expect(guard.snapshot()).toMatchObject({
      replyDelivered: false,
      completionDelivered: false,
      outboundDelivered: true,
    });
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
      completionDelivered: false,
    });
  });

  it("permits only one recovery phase per generation", () => {
    const guard = new TurnReplyGuard();
    const generation = guard.arm({ chatId: "c" });
    expect(guard.beginRecovery(generation)).toBe(true);
    expect(guard.beginRecovery(generation)).toBe(false);
    expect(guard.snapshot()?.phase).toBe("recovering");
  });

  it("tracks work observed since the arm; a fresh generation starts unobserved (#1241)", () => {
    const guard = new TurnReplyGuard();
    guard.arm({ chatId: "c" });
    expect(guard.snapshot()).toMatchObject({ busyObserved: false, lastBusyAt: 0 });
    guard.noteTurnActivity();
    expect(guard.snapshot()).toMatchObject({ busyObserved: true });
    expect(guard.snapshot()?.lastBusyAt).toBeGreaterThan(0);

    // An obligation bump keeps the flag — same turn, same generation.
    guard.arm({ chatId: "c", messageId: "m2" });
    expect(guard.snapshot()).toMatchObject({ busyObserved: true });

    // A fresh generation (after complete) starts unobserved again.
    const generation = guard.snapshot()!.generation;
    guard.complete(generation);
    guard.arm({ chatId: "c" });
    expect(guard.snapshot()).toMatchObject({ busyObserved: false, lastBusyAt: 0 });
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

  it("reports a zero-reply turn once idle persists and queues exactly one recovery prompt (#750, #1241)", async () => {
    vi.useFakeTimers();
    const daemon = makeDaemon();
    const detected = vi.fn();
    daemon.on("reply_drop_detected", detected);
    daemon.markTurnStarted(meta(), "[user] do the task\nreply marker");
    busyThenIdleEdge(daemon);

    // The first edge only arms the confirmation window — no recovery yet.
    expect(detected).not.toHaveBeenCalled();
    expect(daemon.deliverMessage).not.toHaveBeenCalled();
    expect(daemon.turnReplyGuard.snapshot()?.phase).toBe("awaiting");

    await elapseConfirmWindow(daemon);
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
    expect(daemon.deliverMessage.mock.calls[0][0]).toContain("React with an emoji or use the reply tool");
    expect(daemon.deliverMessage.mock.calls[0][0]).not.toMatch(/👍|✅|👀|⏳|❌/); // no specific emoji
    expect(daemon.deliverMessage.mock.calls[0][0]).toContain("already replied"); // idempotent (#1241)
    expect(daemon.turnReplyGuard.snapshot()?.phase).toBe("recovering");
  });

  it("recovery prompt offers react and reply but names no specific emoji (#960)", async () => {
    // Mutation guard: if the prompt is reverted to "Use the reply tool exactly once"
    // (no react option), this test fails. Also guards against accidentally mentioning
    // reserved status emoji (👍✅👀⏳❌) which would steer agents toward system emoji.
    vi.useFakeTimers();
    const daemon = makeDaemon();
    daemon.markTurnStarted(meta(), "[user] do the task\nreply marker");
    busyThenIdleEdge(daemon);
    await elapseConfirmWindow(daemon);
    // The recovery prompt is delivered via deliverMessage — extract it.
    const prompt = daemon.deliverMessage.mock.calls[0]?.[0] as string | undefined;
    expect(prompt).toBeDefined();
    // Must offer react as an alternative to reply.
    expect(prompt).toMatch(/react.*emoji|emoji.*react/i);
    // Must still mention reply.
    expect(prompt).toContain("reply");
    // Must NOT name any specific emoji.
    expect(prompt).not.toMatch(/👍|✅|👀|⏳|❌|🎉|🙏/);
    // Must still guard against plain-text responses.
    expect(prompt).toMatch(/react or reply tool|react.*reply.*tool|reply.*react.*tool/i);
  });

  it.each(["react", "edit_message"])("does not re-prompt after a successfully delivered %s-only turn", async tool => {
    const daemon = makeDaemon();
    const detected = vi.fn();
    daemon.on("reply_drop_detected", detected);
    daemon.markTurnStarted(meta(), "[user] do the task\nreply marker");
    const socket = new EventEmitter() as any;
    daemon.socketSessionNames.set(socket, "worker");

    daemon.handleToolCall({
      tool,
      args: tool === "react" ? { message_id: "message-1", emoji: "👍" } : { message_id: "message-1", text: "done" },
      requestId: 17,
    }, socket);
    const pending = [...daemon.pendingIpcRequests.entries()].find(([key]: [string]) => key === "tool_1_17");
    expect(pending).toBeDefined();
    pending![1]({ result: { ok: true } });

    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot(idle(), "work finished\n❯");
    await daemon.pasteLock;

    expect(detected).not.toHaveBeenCalled();
    expect(daemon.deliverDaemonReply).not.toHaveBeenCalled();
    expect(daemon.deliverMessage).not.toHaveBeenCalled();
    expect(daemon.turnReplyGuard.snapshot()).toBeNull();
  });

  it("still re-prompts when a react call fails and no outbound action was delivered", async () => {
    vi.useFakeTimers();
    const daemon = makeDaemon();
    const detected = vi.fn();
    daemon.on("reply_drop_detected", detected);
    daemon.markTurnStarted(meta(), "[user] do the task\nreply marker");
    const socket = new EventEmitter() as any;
    daemon.socketSessionNames.set(socket, "worker");

    daemon.handleToolCall({ tool: "react", args: { message_id: "message-1", emoji: "👍" }, requestId: 18 }, socket);
    const pending = [...daemon.pendingIpcRequests.entries()].find(([key]: [string]) => key === "tool_1_18");
    expect(pending).toBeDefined();
    pending![1]({ result: null, error: "adapter rejected reaction" });

    busyThenIdleEdge(daemon);
    await elapseConfirmWindow(daemon);

    expect(detected).toHaveBeenCalledWith(expect.objectContaining({ reason: "no_valid_call", recoveryStarted: true }));
    expect(daemon.deliverMessage).toHaveBeenCalledTimes(1);
    expect(daemon.deliverMessage.mock.calls[0][0]).toContain("React with an emoji or use the reply tool");
  });

  it("still re-prompts when only a non-human-facing outbound succeeded", async () => {
    vi.useFakeTimers();
    const daemon = makeDaemon();
    const detected = vi.fn();
    daemon.on("reply_drop_detected", detected);
    daemon.markTurnStarted(meta(), "[user] do the task\nreply marker");
    const socket = new EventEmitter() as any;
    daemon.socketSessionNames.set(socket, "worker");

    daemon.handleToolCall({
      tool: "send_to_instance",
      args: { instance_name: "other", message: "hi" },
      requestId: 21,
    }, socket);
    const pending = [...daemon.pendingIpcRequests.entries()].find(([key]: [string]) => key.endsWith("_21"));
    expect(pending).toBeDefined();
    pending![1]({ result: { sent: true } });
    expect(daemon.turnReplyGuard.snapshot()).toMatchObject({ outboundDelivered: true, completionDelivered: false });

    busyThenIdleEdge(daemon);
    await elapseConfirmWindow(daemon);

    expect(detected).toHaveBeenCalledWith(expect.objectContaining({ reason: "no_valid_call", recoveryStarted: true }));
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
    vi.useFakeTimers();
    const daemon = makeDaemon();
    const recovered = vi.fn();
    daemon.on("reply_drop_recovered", recovered);
    daemon.markTurnStarted(meta(), "[user] do the task\nreply marker");
    busyThenIdleEdge(daemon);
    await elapseConfirmWindow(daemon);

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
    vi.useFakeTimers();
    const daemon = makeDaemon();
    const unrecovered = vi.fn();
    daemon.on("reply_drop_unrecovered", unrecovered);
    daemon.markTurnStarted(meta(), "[user] do the task\nreply marker");
    busyThenIdleEdge(daemon);
    await elapseConfirmWindow(daemon);

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

describe("reply guard false idle edge (#1241)", () => {
  /** Claude's "Background work is running" exit prompt: inputBlocked, held, never answered (#1217). */
  const DIALOG_PANE = [
    "● Running python3 - <<'EOF'",
    "   Background work is running",
    "   The following will stop when you exit:",
    "   shell · python3",
    "   ❯ 1. Exit and stop tasks",
    "     2. Move to background and exit",
    "     3. Stay",
    "   Enter to confirm · Esc to cancel",
  ].join("\n");
  const IDLE_PANE = "work finished\n❯";

  /**
   * Real backend (for true updateInputBlockedState matching) + real state
   * machine + the production capture path. The pane is the mock's.
   */
  function blockingDialogHarness() {
    const dir = mkdtempSync(join(tmpdir(), "agend-reply-guard-dialog-"));
    dirs.push(dir);
    const backend = new ClaudeCodeBackend(dir);
    const daemon = new Daemon("worker", {
      backend: "claude-code",
      working_directory: dir,
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      log_level: "silent",
    } as any, dir, true, backend, undefined, logger) as AnyDaemon;
    let pane = IDLE_PANE;
    daemon.tmux = { capturePane: vi.fn(async () => pane) };
    daemon.deliverMessage = vi.fn(async () => true);
    daemon.deliverDaemonReply = vi.fn(async () => true);
    daemon.mcpServerAlive = vi.fn(() => ({ alive: true, source: "connection" }));
    daemon.ipcServer = { broadcast: vi.fn(), send: vi.fn(() => true) };
    daemon.instanceStateMonitorActive = true;
    daemon.instanceStateMachine = new PaneStateMachine(backend.getReadyPattern(), 600_000, Date.now(), backend.getBusyPattern());
    return {
      daemon,
      setPane(next: string) { pane = next; },
      async capture() {
        await daemon.captureAndEvaluateInstanceState("test_capture", daemon.instanceStateLastOutputAt);
        await daemon.pasteLock;
      },
    };
  }

  it("a blocking dialog dissolves the pending window; idle re-accumulates after it clears (P2-2)", async () => {
    vi.useFakeTimers();
    const h = blockingDialogHarness();
    const daemon = h.daemon;
    const detected = vi.fn();
    daemon.on("reply_drop_detected", detected);
    daemon.markTurnStarted(meta(), "[user] do the task\nreply marker");
    daemon.applyInstanceStateSnapshot(working(), "spinner…");
    daemon.applyInstanceStateSnapshot(idle(), IDLE_PANE);
    expect(detected).not.toHaveBeenCalled();

    // Stdin is owned mid-window, through the true update/capture path.
    h.setPane(DIALOG_PANE);
    await vi.advanceTimersByTimeAsync(30_000);
    await h.capture();
    expect(daemon.isInputBlocked()).toBe(true);

    // Past the ORIGINAL window: no recovery on pre-dialog idle time.
    await vi.advanceTimersByTimeAsync(40_000);
    await h.capture();
    await daemon.pasteLock;
    expect(detected).not.toHaveBeenCalled();

    // The dialog clears: silence re-accumulates a FULL new window...
    h.setPane(IDLE_PANE);
    await h.capture();
    expect(daemon.isInputBlocked()).toBe(false);
    expect(detected).not.toHaveBeenCalled();
    // ...which still recovers a genuine miss when it elapses.
    await vi.advanceTimersByTimeAsync(61_000);
    await h.capture();
    await daemon.pasteLock;
    expect(detected).toHaveBeenCalledWith(expect.objectContaining({
      reason: "no_valid_call",
      recoveryStarted: true,
    }));
    expect(daemon.turnReplyGuard.snapshot()?.phase).toBe("recovering");
  });

  function replyDelivered(daemon: AnyDaemon, requestId: number) {
    const socket = new EventEmitter() as any;
    daemon.socketSessionNames.set(socket, "worker");
    daemon.handleToolCall({ tool: "reply", args: { text: "done" }, requestId }, socket);
    const pending = [...daemon.pendingIpcRequests.entries()].find(([key]: [string]) => key.startsWith("tool_"));
    expect(pending).toBeDefined();
    pending![1]({ result: { messageId: "sent-1" } });
  }

  it("holds on an idle edge with no work observed since the arm — even past the window", async () => {
    // Case 2 shape (+7s): a stale working state with no observed busy
    // snapshot behind it. The turn stays armed for its real end.
    vi.useFakeTimers();
    const daemon = makeDaemon();
    const detected = vi.fn();
    const unrecovered = vi.fn();
    daemon.on("reply_drop_detected", detected);
    daemon.on("reply_drop_unrecovered", unrecovered);
    daemon.markTurnStarted(meta(), "[user] do the task\nreply marker");

    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot(idle(), "❯");
    await daemon.pasteLock;
    expect(detected).not.toHaveBeenCalled();
    expect(daemon.turnReplyGuard.snapshot()?.phase).toBe("awaiting");

    // Case 1's +2s second edge must not end anything while still awaiting.
    await vi.advanceTimersByTimeAsync(2_000);
    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot(idle(Date.now()), "❯");
    expect(unrecovered).not.toHaveBeenCalled();
    expect(daemon.turnReplyGuard.snapshot()).not.toBeNull();

    // Past the confirm window with still no observed work: still held.
    await vi.advanceTimersByTimeAsync(61_000);
    daemon.applyInstanceStateSnapshot(idle(Date.now()), "❯");
    await daemon.pasteLock;
    expect(detected).not.toHaveBeenCalled();

    // The agent's late first reply lands; the turn completes with no recovery.
    replyDelivered(daemon, 7);
    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot(idle(Date.now()), "done\n❯");
    expect(detected).not.toHaveBeenCalled();
    expect(daemon.deliverMessage).not.toHaveBeenCalled();
    expect(daemon.turnReplyGuard.snapshot()).toBeNull();
  });

  it("holds recovery across the window while the turn continues, then completes on the late reply", async () => {
    // Case 1 shape: edge at +22s, first reply at +49s, no recovery in between.
    vi.useFakeTimers();
    const daemon = makeDaemon();
    const detected = vi.fn();
    daemon.on("reply_drop_detected", detected);
    daemon.markTurnStarted(meta(), "[user] do the task\nreply marker");
    busyThenIdleEdge(daemon);
    expect(detected).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(22_000);
    daemon.applyInstanceStateSnapshot(working(Date.now()), "still thinking…");
    await vi.advanceTimersByTimeAsync(27_000);
    replyDelivered(daemon, 8);
    daemon.applyInstanceStateSnapshot(idle(Date.now()), "done\n❯");

    expect(detected).not.toHaveBeenCalled();
    expect(daemon.deliverDaemonReply).not.toHaveBeenCalled();
    expect(daemon.deliverMessage).not.toHaveBeenCalled();
    expect(daemon.turnReplyGuard.snapshot()).toBeNull();
  });

  it("recovers a genuine miss whose only work landed before the paste confirmed (P2-1)", async () => {
    // The held writer: this delivery's output arrives while the paste is
    // still unconfirmed, i.e. before markTurnStarted arms the guard. That
    // activity must survive the arm — no post-arm busy is fabricated here.
    vi.useFakeTimers();
    const daemon = makeDaemon();
    const detected = vi.fn();
    daemon.on("reply_drop_detected", detected);
    let releasePaste!: (ok: boolean) => void;
    daemon.deliverMessage.mockImplementationOnce(() => new Promise<boolean>(resolve => { releasePaste = resolve; }));
    daemon.pushChannelMessage("do the task", meta());
    await vi.advanceTimersByTimeAsync(0); // let the paste reach deliverMessage
    vi.advanceTimersByTime(100);
    daemon.applyInstanceStateSnapshot(working(), "spinner…");
    releasePaste(true);
    await daemon.pasteLock; // markTurnStarted arms here, after the output
    expect(daemon.turnReplyGuard.snapshot()).toMatchObject({ busyObserved: true });

    // Genuine miss from here on: only idle, no reply.
    daemon.applyInstanceStateSnapshot(idle(), "work finished\n❯");
    expect(detected).not.toHaveBeenCalled();
    await elapseConfirmWindow(daemon);
    expect(detected).toHaveBeenCalledWith(expect.objectContaining({
      reason: "no_valid_call",
      recoveryStarted: true,
    }));
    expect(daemon.turnReplyGuard.snapshot()?.phase).toBe("recovering");
  });

  it("ignores work that predates the delivery's ingress when arming (P2-1)", async () => {
    // Stale output from before this delivery must not satisfy the gate.
    vi.useFakeTimers();
    const daemon = makeDaemon();
    const detected = vi.fn();
    daemon.on("reply_drop_detected", detected);
    daemon.applyInstanceStateSnapshot(working(), "older turn settling…");
    vi.advanceTimersByTime(100);
    daemon.pushChannelMessage("do the task", meta());
    await daemon.pasteLock;
    expect(daemon.turnReplyGuard.snapshot()).toMatchObject({ busyObserved: false });

    daemon.applyInstanceStateSnapshot(idle(), "work finished\n❯");
    await daemon.pasteLock;
    expect(detected).not.toHaveBeenCalled();
    await elapseConfirmWindow(daemon);
    expect(detected).not.toHaveBeenCalled();
    expect(daemon.turnReplyGuard.snapshot()?.phase).toBe("awaiting");
  });

  it("re-arms the confirmation on a later edge after the turn continued, still recovering a true miss", async () => {
    vi.useFakeTimers();
    const daemon = makeDaemon();
    const detected = vi.fn();
    daemon.on("reply_drop_detected", detected);
    daemon.markTurnStarted(meta(), "[user] do the task\nreply marker");
    busyThenIdleEdge(daemon);

    await vi.advanceTimersByTimeAsync(10_000);
    daemon.applyInstanceStateSnapshot(working(Date.now()), "back to work…");
    // A fresh edge re-arms the window instead of recovering at once.
    daemon.applyInstanceStateSnapshot(idle(Date.now()), "quiet again\n❯");
    await daemon.pasteLock;
    expect(detected).not.toHaveBeenCalled();
    expect(daemon.turnReplyGuard.snapshot()?.phase).toBe("awaiting");

    // Idle persists past the new window with no reply: a genuine miss recovers.
    await elapseConfirmWindow(daemon);
    expect(detected).toHaveBeenCalledWith(expect.objectContaining({
      reason: "no_valid_call",
      recoveryStarted: true,
    }));
    expect(daemon.turnReplyGuard.snapshot()?.phase).toBe("recovering");
  });
});
