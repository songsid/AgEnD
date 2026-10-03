import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { CodexBackend } from "../src/backend/codex.js";
import { KiroBackend, type KiroCliCompatibility } from "../src/backend/kiro.js";
import type { CliBackend, CliBackendConfig } from "../src/backend/types.js";
import { Daemon, PaneStateMachine } from "../src/daemon.js";
import { setLocale, t, type Locale } from "../src/locale.js";
import type { Logger } from "../src/logger.js";

const logger = pino({ level: "silent" }) as Logger;
const dirs: string[] = [];
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "kiro-reply-guard", `${name}.pane.txt`), "utf8");
const COMPAT: KiroCliCompatibility = {
  version: "kiro-cli 2.27.1", source: "help", supportsLegacyUi: true, supportsTui: true,
  supportsV3: true, agentEngines: ["v1", "v2", "v3"], supportsEffortFlag: true,
};
type Ui = "legacy" | "tui" | "v3";
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "agend-kiro-reply-")); dirs.push(dir); return dir; };
const launch = (dir: string, ui: Ui): CliBackendConfig => ({
  workingDirectory: dir, instanceDir: dir, instanceName: "worker", mcpServers: {},
  kiroUi: ui, skipResume: true, skipPermissions: false,
});
const meta = (overrides: Record<string, string> = {}) => ({
  chat_id: "guild-1", thread_id: "channel-1", adapter_id: "discord-persona",
  message_id: "message-1", correlation_id: "cid-1", ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T00:00:00.000Z"));
  setLocale("en");
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  setLocale("en");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Real backend, ingress, state machine and idle hook; only external IO is stubbed. */
function harness(ui: Ui = "legacy", configured = true, claude = false) {
  const dir = temp();
  const backend = claude ? new ClaudeCodeBackend(dir) : new KiroBackend(dir, COMPAT);
  if (backend instanceof KiroBackend) backend.buildCommand(launch(dir, ui));
  const daemon = new Daemon("worker", {
    backend: claude ? "claude-code" : "kiro-cli", working_directory: dir,
    reply_completion_guard: configured, log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
  } as any, dir, true, backend, undefined, logger) as any;
  let pane = "";
  const writes: string[] = [];
  daemon.tmux = { capturePane: vi.fn(async () => pane) };
  daemon.deliverMessage = vi.fn(async (text: string, _status?: unknown, opts?: { deliveryEpoch?: number }) => {
    // Model the external pane writer's epoch fence, without actually writing a fleet pane.
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
  const detected = vi.fn();
  const unrecovered = vi.fn();
  daemon.on("reply_drop_detected", detected);
  daemon.on("reply_drop_unrecovered", unrecovered);
  return {
    daemon, backend, writes, detected, unrecovered,
    async inbound(content = "do the task", overrides: Record<string, string> = {}) {
      daemon.pushChannelMessage(content, meta(overrides));
      await daemon.pasteLock;
    },
    async capture(nextPane: string, waitForPaste = true) {
      pane = nextPane;
      const outputAt = Date.now();
      daemon.instanceStateLastOutputAt = outputAt;
      daemon.applyInstanceStateSnapshot(daemon.instanceStateMachine.recordOutput(outputAt));
      vi.advanceTimersByTime(2_100);
      // Drive the production capture/debounce path, including activity/dialog vetoes.
      await daemon.captureAndEvaluateInstanceState("idle_debounce", outputAt);
      if (waitForPaste) await daemon.pasteLock;
    },
  };
}

let requestSeq = 0;
function tool(daemon: any, name: string, socketOwner = "worker") {
  const socket = new EventEmitter() as any;
  daemon.socketSessionNames.set(socket, socketOwner);
  const requestId = ++requestSeq;
  daemon.handleToolCall({ tool: name, args: { text: "done", message_id: "message-1", emoji: "👍", instance_name: "other", message: "done" }, requestId }, socket);
  const pending = [...daemon.pendingIpcRequests.entries()].find(([key]: any) => key.endsWith(`_${requestId}`));
  expect(pending).toBeDefined();
  return (result: unknown, error?: string) => pending![1]({ result, error });
}
const recoveryWrites = (h: ReturnType<typeof harness>) => h.writes.filter(text => text.startsWith("[system:reply-required]"));

describe("Kiro reply guard follows the successful launch plan (#1144)", () => {
  it("is off before building a command, enables legacy/TUI, and disables v3 on the same backend", () => {
    const dir = temp();
    const backend = new KiroBackend(dir, COMPAT);
    expect(backend.replyCompletionGuard).toBe(false);
    for (const ui of ["legacy", "v3", "tui", "v3", "legacy"] as const) {
      const command = backend.buildCommand(launch(dir, ui));
      expect(command).toContain(ui === "legacy" ? "--agent-engine=v1" : ui === "tui" ? "--agent-engine=v2" : "--v3");
      expect(backend.replyCompletionGuard).toBe(ui !== "v3");
    }
  });

  it("fails closed if a subsequent command build throws", () => {
    const dir = temp();
    const backend = new KiroBackend(dir, COMPAT);
    backend.buildCommand(launch(dir, "legacy"));
    expect(backend.replyCompletionGuard).toBe(true);
    expect(() => backend.buildCommand({ ...launch(dir, "tui"), model: "bad;model" })).toThrow();
    expect(backend.replyCompletionGuard).toBe(false);
  });

  it("refused/unknown engines remain off", () => {
    for (const compat of [{ ...COMPAT, agentEngines: ["v3"] }, { ...COMPAT, source: "unknown" as const }]) {
      const dir = temp();
      const backend = new KiroBackend(dir, compat);
      expect(() => backend.buildCommand(launch(dir, "legacy"))).toThrow();
      expect(backend.replyCompletionGuard).toBe(false);
    }
  });

  it("does not opt Codex in", () => {
    const backend: CliBackend = new CodexBackend(temp());
    expect(backend.replyCompletionGuard).not.toBe(true);
  });
});

describe.each(["legacy", "tui"] as const)("Kiro %s real-pane human completion", ui => {
  const idlePane = () => fixture(`${ui}-idle`);
  const busyPane = () => fixture(`${ui}-busy`);

  it.each(["en", "zh-TW"] as Locale[])("uses existing %s notice and asks once for the missing conclusion", async locale => {
    setLocale(locale);
    const h = harness(ui);
    await h.inbound();
    expect(h.daemon.turnReplyGuard.snapshot()).toMatchObject({ completionDelivered: false, outboundDelivered: false });
    await h.capture(idlePane());
    expect(h.daemon.getInstanceState()).toBe("idle");
    expect(h.detected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: "no_valid_call", recoveryStarted: true }));
    expect(h.daemon.deliverDaemonReply).toHaveBeenCalledExactlyOnceWith(t("inst.reply_drop_retrying"), "replydrop", "Reply-drop status", expect.objectContaining({
      adapterId: "discord-persona", chatId: "guild-1", threadId: "channel-1", messageId: "message-1",
    }), true);
    expect(recoveryWrites(h)).toHaveLength(1);
    expect(recoveryWrites(h)[0]).toContain("Do not redo the work");
    expect(recoveryWrites(h)[0]).toContain("react or reply tool");
    expect(h.daemon.deliverDaemonReply.mock.calls[0][0]).not.toContain("SENTINEL_KIRO");
    expect(h.daemon.turnReplyGuard.snapshot()?.phase).toBe("recovering");
  });

  it("keeps a settled busy pane working, then recovers only after the native idle pane", async () => {
    const h = harness(ui);
    await h.inbound();
    await h.capture(busyPane());
    expect(h.daemon.getInstanceState()).toBe("working");
    expect(h.backend.getBusyPattern().test(busyPane())).toBe(true);
    expect(h.detected).not.toHaveBeenCalled();
    expect(recoveryWrites(h)).toHaveLength(0);
    expect(h.daemon.turnReplyGuard.snapshot()?.phase).toBe("awaiting");
    await h.capture(idlePane());
    expect(h.detected).toHaveBeenCalledOnce();
    expect(recoveryWrites(h)).toHaveLength(1);
  });

  it("does not mistake an old TUI working footer above a fresh prompt for current work", () => {
    const h = harness(ui);
    const pane = `${fixture("tui-busy")}\n${idlePane()}`;
    expect(h.backend.getBusyPattern().test(pane)).toBe(false);
  });

  it("keeps an unfinished foreground tool from ending the turn", async () => {
    const h = harness(ui);
    await h.inbound();
    await h.capture(`I will run a command (using tool: shell)\nPurpose: long task\n${idlePane()}`);
    expect(h.daemon.getInstanceState()).toBe("working");
    expect(h.detected).not.toHaveBeenCalled();
    expect(recoveryWrites(h)).toHaveLength(0);
    await h.capture(`I will run a command (using tool: shell)\n - Completed in 2s\n${idlePane()}`);
    expect(h.detected).toHaveBeenCalledOnce();
  });

  it.each(["reply", "react", "edit_message"])("counts successful %s without prompting again", async name => {
    const h = harness(ui);
    await h.inbound();
    tool(h.daemon, name)({ messageId: "ack-1" });
    await h.capture(idlePane());
    expect(h.detected).not.toHaveBeenCalled();
    expect(h.daemon.deliverDaemonReply).not.toHaveBeenCalled();
    expect(recoveryWrites(h)).toHaveLength(0);
    expect(h.daemon.turnReplyGuard.snapshot()).toBeNull();
  });

  it("does not resend an attempted reply with an unknown result", async () => {
    const h = harness(ui);
    await h.inbound();
    tool(h.daemon, "reply")(null, "provider timed out");
    await h.capture(idlePane());
    expect(h.detected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: "reply_failed_or_unknown", recoveryStarted: false }));
    expect(h.daemon.deliverDaemonReply.mock.calls[0][0]).toBe(t("inst.reply_drop_unknown"));
    expect(recoveryWrites(h)).toHaveLength(0);
    expect(h.daemon.turnReplyGuard.snapshot()).toBeNull();
  });

  it("failed reaction and unrelated outward activity do not satisfy the channel response", async () => {
    const h = harness(ui);
    await h.inbound();
    tool(h.daemon, "react")(null, "rejected");
    tool(h.daemon, "send_to_instance")({ sent: true, queued: true });
    expect(h.daemon.turnReplyGuard.snapshot()).toMatchObject({ completionDelivered: false, outboundDelivered: true });
    await h.capture(idlePane());
    expect(recoveryWrites(h)).toHaveLength(1);
  });

  it("a sibling MCP session cannot discharge the obligation", async () => {
    const h = harness(ui);
    await h.inbound();
    tool(h.daemon, "reply", "sibling")({ messageId: "sibling-ack" });
    await h.capture(idlePane());
    expect(recoveryWrites(h)).toHaveLength(1);
  });

  it("an older reply result cannot discharge newer human ingress", async () => {
    const h = harness(ui);
    await h.inbound();
    const settleOld = tool(h.daemon, "reply");
    await h.inbound("also check this", { message_id: "message-2", thread_id: "channel-2" });
    settleOld({ messageId: "old-ack" });
    await h.capture(idlePane());
    expect(recoveryWrites(h)).toHaveLength(1);
    expect(h.daemon.deliverDaemonReply.mock.calls[0][3]).toMatchObject({ messageId: "message-2", threadId: "channel-2" });
  });

  it("a stale idle observation cannot retire a newly delivered turn", async () => {
    const h = harness(ui);
    await h.inbound();
    h.daemon.instanceState = "working";
    h.daemon.applyInstanceStateSnapshot({ state: "idle", observedAt: Date.now() - 1, unchangedForMs: 0, stateChangedAt: Date.now() - 1 }, idlePane());
    expect(h.detected).not.toHaveBeenCalled();
    expect(h.daemon.turnReplyGuard.snapshot()).not.toBeNull();
    await h.capture(idlePane());
    expect(recoveryWrites(h)).toHaveLength(1);
  });

  it("does not end a turn while a dialog owns input", async () => {
    const h = harness(ui);
    await h.inbound();
    h.daemon.instanceState = "working";
    h.daemon.inputBlockedDialogKey = "approval";
    h.daemon.applyInstanceStateSnapshot({ state: "idle", observedAt: Date.now(), unchangedForMs: 0, stateChangedAt: Date.now() }, idlePane());
    expect(h.daemon.getInstanceState()).toBe("working");
    expect(h.detected).not.toHaveBeenCalled();
    expect(h.daemon.turnReplyGuard.snapshot()?.phase).toBe("awaiting");
  });

  it("bounds recovery to one prompt and cooldowns repeated unrecovered warnings", async () => {
    const h = harness(ui);
    for (let turn = 0; turn < 3; turn++) {
      if (turn === 2) vi.advanceTimersByTime(5 * 60_000);
      await h.inbound(`task ${turn}`);
      await h.capture(idlePane());
      await h.capture(idlePane());
      expect(h.daemon.turnReplyGuard.snapshot()).toBeNull();
    }
    expect(recoveryWrites(h)).toHaveLength(3); // one for each original turn, never a third turn
    expect(h.unrecovered).toHaveBeenCalledTimes(3);
    const warnings = h.daemon.deliverDaemonReply.mock.calls.filter((args: any[]) => args[1] === "replydropwarn");
    expect(warnings).toHaveLength(2);
    expect(warnings[0][0]).toBe(t("inst.reply_drop_unrecovered"));
  });

  it("a queued recovery prompt is fenced by cancellation", async () => {
    const h = harness(ui);
    await h.inbound();
    let release!: () => void;
    h.daemon.pasteLock = new Promise<void>(resolve => { release = resolve; });
    await h.capture(idlePane(), false);
    h.daemon.clearPendingDeliveries();
    release();
    await h.daemon.pasteLock;
    expect(recoveryWrites(h)).toHaveLength(0);
    expect(h.daemon.deliverMessage.mock.calls[1][2]).toMatchObject({ deliveryEpoch: 0 });
  });

  it("a stopped generation drops its queued recovery", async () => {
    const h = harness(ui);
    await h.inbound();
    let release!: () => void;
    h.daemon.pasteLock = new Promise<void>(resolve => { release = resolve; });
    await h.capture(idlePane(), false);
    h.daemon.fenceDeliveryWritesForStop();
    h.daemon.turnReplyGuard.reset(); // stop() resets before any await
    release();
    await h.daemon.pasteLock;
    expect(h.daemon.deliverMessage).toHaveBeenCalledTimes(1); // original ingress only
    expect(recoveryWrites(h)).toHaveLength(0);
  });

  it("retains opt-out, raw and cross-instance exclusions", async () => {
    const off = harness(ui, false);
    await off.inbound();
    await off.capture(idlePane());
    expect(off.detected).not.toHaveBeenCalled();
    expect(recoveryWrites(off)).toHaveLength(0);
    for (const [content, overrides] of [["/raw do not reply", {}], ["task from peer", { from_instance: "leader" }], ["silent schedule", { chat_id: "" }]] as const) {
      const h = harness(ui);
      await h.inbound(content, overrides);
      expect(h.daemon.turnReplyGuard.snapshot()).toBeNull();
      await h.capture(idlePane());
      expect(h.detected).not.toHaveBeenCalled();
    }
  });
});

describe("other backend guard behavior stays scoped", () => {
  it("keeps v3 disabled even when the pane matches an existing idle pattern", async () => {
    const h = harness("v3");
    await h.inbound();
    await h.capture(fixture("tui-idle"));
    expect(h.daemon.getInstanceState()).toBe("idle");
    expect(h.detected).not.toHaveBeenCalled();
    expect(recoveryWrites(h)).toHaveLength(0);
  });

  it("retains the real Claude backend control", async () => {
    const h = harness("legacy", true, true);
    await h.inbound();
    await h.capture("work finished\n❯");
    expect(h.detected).toHaveBeenCalledOnce();
    expect(recoveryWrites(h)).toHaveLength(1);
  });
});
