import { join, dirname, basename, resolve } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, rmSync, appendFileSync, statSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { InstanceConfig, RotationSnapshot, RotationSnapshotEvent } from "./types.js";
import type { Logger } from "./logger.js";
import { TmuxManager } from "./tmux-manager.js";
import { TranscriptMonitor } from "./transcript-monitor.js";
import { ContextGuardian } from "./context-guardian.js";
import { IpcServer } from "./channel/ipc-bridge.js";
import { MessageBus } from "./channel/message-bus.js";
import { ToolTracker } from "./channel/tool-tracker.js";
import type { CliBackend, CliBackendConfig, ErrorPattern, InstanceState, InstanceStateSnapshot, StartupDialog } from "./backend/types.js";
import { shellQuote } from "./backend/types.js";
import type { ChannelAdapter, InboundMessage } from "./channel/types.js";
import { getTmuxSession } from "./config.js";
import { routeToolCall } from "./channel/tool-router.js";
import { HangDetector } from "./hang-detector.js";
import type { TmuxControlClient } from "./tmux-control.js";
import { buildFleetInstructions } from "./instructions.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Tool routing sets — module-level to avoid re-creation on every handleToolCall
const CROSS_INSTANCE_TOOLS = new Set(["send_to_instance", "list_instances", "start_instance", "restart_instance", "create_instance", "delete_instance", "replace_instance", "request_information", "delegate_task", "report_result", "describe_instance"]);
const SCHEDULE_TOOLS = new Set(["create_schedule", "list_schedules", "update_schedule", "delete_schedule"]);
const DECISION_TOOLS = new Set(["post_decision", "list_decisions", "update_decision"]);
const TASK_TOOL = "task";

export const DEFAULT_STUCK_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_STATE_POLL_INTERVAL_MS = 5_000;

/** Headless idle timer used by the daemon and unit tests. */
export class AutoPauseController {
  private idleSince: number | null = null;
  private pausedAt: number | null = null;

  constructor(private readonly thresholdMs: number) {}

  observe(state: InstanceState, now = Date.now()): boolean {
    if (this.pausedAt !== null || this.thresholdMs <= 0) return false;
    if (state !== "idle") {
      this.idleSince = null;
      return false;
    }
    this.idleSince ??= now;
    return now - this.idleSince >= this.thresholdMs;
  }

  markPaused(now = Date.now()): void {
    this.pausedAt = now;
  }

  markAwake(): void {
    this.pausedAt = null;
    this.idleSince = null;
  }

  async wakeOnDeliver(wake: () => Promise<void>): Promise<void> {
    if (this.pausedAt === null) return;
    await wake();
    this.markAwake();
  }

  get isPaused(): boolean { return this.pausedAt !== null; }
  get lastPausedAt(): number | null { return this.pausedAt; }
}

/**
 * Headless state machine for pane-based execution state detection.
 *
 * Pane motion wins over a ready match because several backends keep their ready
 * marker in a persistent header/footer while generating. A stable ready pane is
 * idle; changing content is working; stable non-ready content eventually sticks.
 */
export class PaneStateMachine {
  private readonly readyPattern: RegExp;
  private lastPaneHash: string | null = null;
  private lastPaneChangeAt: number;
  private lastObservedAt: number;
  private stateChangedAt: number;
  private currentState: InstanceState = "idle";

  constructor(readyPattern: RegExp, private readonly stuckTimeoutMs = DEFAULT_STUCK_TIMEOUT_MS, now = Date.now()) {
    // Stateful g/y regexes mutate lastIndex and can alternate true/false across
    // polls. State detection must be deterministic for identical pane content.
    this.readyPattern = new RegExp(readyPattern.source, readyPattern.flags.replace(/[gy]/g, ""));
    this.lastPaneChangeAt = now;
    this.lastObservedAt = now;
    this.stateChangedAt = now;
  }

  observe(pane: string, now = Date.now()): InstanceStateSnapshot {
    const paneHash = createHash("sha256").update(pane).digest("hex");
    const firstObservation = this.lastPaneHash === null;
    const paneChanged = this.lastPaneHash !== paneHash;
    if (paneChanged) {
      this.lastPaneHash = paneHash;
      this.lastPaneChangeAt = now;
    }
    this.lastObservedAt = now;

    const ready = this.readyPattern.test(pane);
    const nextState: InstanceState = firstObservation
      ? ready ? "idle" : "working"
      : paneChanged
        ? "working"
        : ready
          ? "idle"
          : now - this.lastPaneChangeAt >= this.stuckTimeoutMs
            ? "stuck"
            : "working";

    if (nextState !== this.currentState) {
      this.currentState = nextState;
      this.stateChangedAt = now;
    }
    return this.snapshot(now);
  }

  snapshot(now = Date.now()): InstanceStateSnapshot {
    return {
      state: this.currentState,
      unchangedForMs: Math.max(0, now - this.lastPaneChangeAt),
      observedAt: this.lastObservedAt,
      stateChangedAt: this.stateChangedAt,
    };
  }
}

/** Tracks whether an inbound arrived after the most recent confirmed idle prompt. */
export class PendingWorkTracker {
  private lastInboundAt = 0;
  private lastIdleAt: number;
  private sequence = 0;
  private lastInboundOrder = 0;
  private lastIdleOrder = 0;

  constructor(now = Date.now()) {
    this.lastIdleAt = now;
  }

  recordInbound(now = Date.now()): void {
    this.lastInboundAt = now;
    this.lastInboundOrder = ++this.sequence;
  }

  recordIdle(now = Date.now()): void {
    // An async pane poll can finish after a newer inbound. Do not let its stale
    // observation clear work which had not arrived when the pane was captured.
    if (now < this.lastInboundAt) return;
    this.lastIdleAt = now;
    this.lastIdleOrder = ++this.sequence;
  }

  hasPendingWork(): boolean {
    return this.lastInboundOrder > this.lastIdleOrder;
  }
}

/** Redact likely credentials and control sequences before pane text reaches logs. */
export function sanitizePaneTail(pane: string, lineCount = 5): string[] {
  const secretAssignment = /\b(token|secret|password|passwd|api[_-]?key|authorization)\b\s*[:=]\s*\S+/gi;
  const bearer = /\bBearer\s+\S+/gi;
  const knownToken = /\b(?:sk-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16})\b/g;
  const jwt = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
  const opaqueSecret = /\b[A-Za-z0-9_+/=-]{32,}\b/g;

  const lines = pane
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .split(/\r?\n/);
  while (lines.length > 0 && /^\s*$/.test(lines[lines.length - 1])) lines.pop();

  return lines
    .slice(-lineCount)
    .map(line => line
      .replace(bearer, "Bearer [REDACTED]")
      .replace(secretAssignment, "$1=[REDACTED]")
      .replace(knownToken, "[REDACTED]")
      .replace(jwt, "[REDACTED]")
      .replace(opaqueSecret, "[REDACTED]")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .slice(0, 200));
}

export class Daemon extends EventEmitter {
  private logger: Logger;
  private tmuxSessionName: string;
  private tmux: TmuxManager | null = null;
  private ipcServer: IpcServer | null = null;
  private messageBus: MessageBus;
  private transcriptMonitor: TranscriptMonitor | null = null;
  private toolTracker: ToolTracker | null = null;
  private guardian: ContextGuardian | null = null;
  private adapter: ChannelAdapter | null = null;
  private pendingIpcRequests = new Map<string, (msg: Record<string, unknown>) => void>();
  // Track chatId/threadId from inbound messages for automatic outbound routing
  private lastChatId: string | undefined;
  private lastThreadId: string | undefined;
  private lastAdapterId: string | undefined;
  // Pending ack: react 🫡 on first transcript activity after receiving a message
  private pendingAckMessage: { chatId: string; messageId: string } | null = null;
  // Tool status tracking for channel adapter
  private toolStatusMessageId: string | null = null;
  private toolStatusLines: string[] = [];
  private toolStatusDebounce: ReturnType<typeof setTimeout> | null = null;
  // Session identity: map IPC socket → sessionName (from mcp_ready)
  private socketSessionNames = new Map<import("node:net").Socket, string>();
  // Crash recovery
  private static tmuxServerCrashTimestamps: number[] = [];
  private static tmuxServerPaused = false;
  private static tmuxServerRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private healthCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private crashCount = 0;
  private lastCrashAt = 0;
  private lastSpawnAt = 0;
  private crashTimestamps: number[] = [];
  private healthCheckPaused = false;
  private spawning = false;
  private skipResume = false;
  private backgroundSessionRecoveryAttempted = false;
  /** Whether the last spawn started a fresh session (not resumed). */
  isNewSession = false;
  // Context rotation quality tracking
  private rotationStartedAt = 0;
  private preRotationContextPct = 0;
  private hangDetector: HangDetector | null = null;
  private instanceState: InstanceState = "idle";
  private instanceStateMachine: PaneStateMachine | null = null;
  private pendingWork = new PendingWorkTracker();
  private instanceStateMonitorTimer: ReturnType<typeof setInterval> | null = null;
  private statePollInFlight = false;
  private autoPauseController: AutoPauseController;
  private pauseRequested = false;
  private pauseWakeState: "active" | "pausing" | "paused" | "waking" = "active";
  private pauseWakeTransition: Promise<void> | null = null;
  // Model failover: override model on next spawn when rate-limited
  private modelOverride: string | undefined;
  // Context rotation v3: ring buffers for daemon-side snapshot
  private recentUserMessages: Array<{ text: string; ts: string }> = [];
  private recentEvents: RotationSnapshotEvent[] = [];
  private recentToolActivity: string[] = [];
  private snapshotConsumed = false;
  private pasteLock: Promise<void> = Promise.resolve();
  private pendingInstructionsUpdate: string | undefined;
  private pendingInstructionsNotice = false;
  // Whether the warmup steering-reload notice should be injected after spawn.
  // Set in trySpawn by comparing the freshly-built instructions against the
  // last value the agent was told about (prev-instructions). Skipped when
  // unchanged so agents don't waste 10-30s re-reading identical steering.
  private warmupNeeded = false;
  private lastBuiltInstructions = "";
  private pasteQueueDepth = 0;
  // PTY error pattern monitoring
  private errorMonitorTimer: ReturnType<typeof setInterval> | null = null;
  /** Prevent in-flight monitor callbacks from re-arming after a pause. */
  private runtimeMonitorsFrozen = false;
  private errorWaitingForRecovery = false; // true = error detected, waiting for ready pattern
  private errorDetectedAt = 0;

  /** Whether this instance is in an abnormal error state (auto-pause is normal). */
  get isErrorState(): boolean {
    return this.errorWaitingForRecovery || (this.healthCheckPaused && !this.isPaused) || Daemon.tmuxServerPaused;
  }
  get isPaused(): boolean { return this.pauseWakeState !== "active"; }
  get lastPausedAt(): number | null { return this.autoPauseController.lastPausedAt; }
  private getPauseWakeState(): typeof this.pauseWakeState { return this.pauseWakeState; }
  /** Whether this instance is in a crash loop (3+ consecutive crashes). */
  get isCrashLoop(): boolean {
    return this.crashCount >= 3;
  }
  private lastFailoverAt = 0; // cooldown: prevent repeated failover triggers
  private static FAILOVER_COOLDOWN_MS = 5 * 60_000; // 5 minutes
  private lastErrorNotifiedAt = new Map<string, number>(); // per-type cooldown for all actions
  private static ERROR_COOLDOWN_MS = 5 * 60_000;

  // Count-based dedup: per error type, the number of pattern occurrences already
  // accounted for. A scan counts occurrences across the WHOLE pane; count > this
  // baseline means a NEW error appeared. On recovery we absorb the current count
  // (not reset to 0) so the just-handled error doesn't re-trigger, while a later
  // new error still pushes the count higher. If occurrences scroll out of the
  // capture buffer the count drops — we lower the baseline so a re-occurrence
  // still registers as new (prevents the old hash-dedup's permanent suppression).
  private lastErrorCount = new Map<string, number>();
  private lastDetectedErrorType: string | null = null;

  constructor(
    private name: string,
    private config: InstanceConfig,
    private instanceDir: string,
    private topicMode = false,
    private backend?: CliBackend,
    private controlClient?: TmuxControlClient,
    rootLogger?: Logger,
  ) {
    super();
    if (!rootLogger) throw new Error("Daemon requires a shared root logger");
    this.logger = rootLogger.child({ instance: name }, { level: config.log_level });
    this.tmuxSessionName = getTmuxSession();
    this.messageBus = new MessageBus();
    this.messageBus.setLogger(this.logger);
    const autoPauseMinutes = typeof config.auto_pause_after === "number" ? config.auto_pause_after : 0; // default: disabled
    this.autoPauseController = new AutoPauseController(Math.max(0, autoPauseMinutes) * 60_000);
  }

  async start(): Promise<void> {
    mkdirSync(this.instanceDir, { recursive: true });
    // A daemon restart performs a normal CLI start, so any persisted auto-pause
    // marker from the previous daemon is stale.
    try { unlinkSync(join(this.instanceDir, "paused-state.json")); } catch {}
    writeFileSync(join(this.instanceDir, "daemon.pid"), String(process.pid));
    this.logger.info(`Starting ${this.name}`);

    // P1: Read crash state from previous run — skip resume if last run was a crash loop
    const crashStatePath = join(this.instanceDir, "crash-state.json");
    try {
      if (existsSync(crashStatePath)) {
        const state = JSON.parse(readFileSync(crashStatePath, "utf-8"));
        if (state.resumeDisabled) {
          this.skipResume = true;
          this.logger.warn("Previous crash loop detected — starting without resume");
        }
        unlinkSync(crashStatePath);
      }
    } catch { /* corrupt file — ignore */ }

    // Restore last reply target so a fleet-topic instance can reply correctly
    // BEFORE its first post-restart inbound arrives (otherwise lastChatId is empty
    // → reply tool sends to "" → Discord 404).
    try {
      const lastChatPath = join(this.instanceDir, "last-chat.json");
      if (existsSync(lastChatPath)) {
        const saved = JSON.parse(readFileSync(lastChatPath, "utf-8"));
        if (saved.chatId) {
          this.lastChatId = saved.chatId;
          this.lastThreadId = saved.threadId || undefined;
          this.lastAdapterId = saved.adapterId || undefined;
        }
      }
    } catch { /* corrupt/missing — ignore */ }

    // 1. IPC server — bridge between MCP server (Claude's child) and daemon
    const sockPath = join(this.instanceDir, "channel.sock");
    this.ipcServer = new IpcServer(sockPath, this.logger);
    // Forward IPC server errors as daemon events (prevents unhandled 'error' crash).
    // Guard: only forward post-listen errors — startup errors are handled by listen() rejection.
    let ipcListening = false;
    this.ipcServer.on("error", (err: Error) => {
      if (!ipcListening) return; // startup errors handled by listen() rejection
      this.logger.error({ err, name: this.name }, "IPC server error");
      this.emit("error", err);
    });
    await this.ipcServer.listen();
    ipcListening = true;

    // Permanent IPC dispatcher: routes responses to pending requests by type+id key
    this.ipcServer.on("message", (msg: Record<string, unknown>) => {
      const type = msg.type as string | undefined;
      if (!type) return;
      // Build lookup key matching the pattern used when registering
      let key: string | undefined;
      if ((type === "fleet_schedule_response" || type === "fleet_outbound_response" || type === "fleet_decision_response" || type === "fleet_task_response" || type === "fleet_display_name_response" || type === "fleet_description_response") && msg.fleetRequestId) {
        key = String(msg.fleetRequestId);
      } else if (type === "fleet_outbound_response" && msg.requestId != null) {
        key = `fleet_out_${msg.requestId}`;
      }
      if (key && this.pendingIpcRequests.has(key)) {
        const handler = this.pendingIpcRequests.get(key)!;
        this.pendingIpcRequests.delete(key);
        handler(msg);
      }
    });

    // IPC message relay: when daemon wants to push a channel message to Claude,
    // it broadcasts to all IPC clients (the MCP server is one of them).
    // When MCP server sends a tool_call, daemon handles it via the messageBus.
    this.ipcServer.on("message", (msg: Record<string, unknown>, socket: import("node:net").Socket) => {
      if (msg.type === "tool_call") {
        // MCP server forwarding a Claude tool call (reply, react, edit, download)
        this.handleToolCall(msg, socket);
      } else if (msg.type === "mcp_ready") {
        const sessionName = msg.sessionName as string | undefined;
        if (sessionName) {
          this.socketSessionNames.set(socket, sessionName);
          socket.on("close", () => {
            this.socketSessionNames.delete(socket);
            // Notify fleet manager so it can clean up sessionRegistry
            if (sessionName !== this.name) {
              this.ipcServer?.broadcast({ type: "session_disconnected", sessionName });
            }
          });
        }
        this.logger.debug({ sessionName }, "MCP channel server connected and ready");
        // Notify FleetManager's IPC client that MCP is ready
        this.ipcServer?.broadcast({ type: "mcp_ready", sessionName });
      } else if (msg.type === "query_sessions") {
        // Fleet manager asks for all registered session names (catches sessions
        // that sent mcp_ready before fleet manager connected).
        const sessions: string[] = [];
        for (const [s, sessionName] of this.socketSessionNames) {
          if (!s.destroyed && sessionName !== this.name) {
            // Individual mcp_ready for initial registration path
            this.ipcServer?.send(socket, { type: "mcp_ready", sessionName });
            sessions.push(sessionName);
          }
        }
        // Batch response for prune path
        this.ipcServer?.send(socket, { type: "query_sessions_response", sessions });
      } else if (msg.type === "fleet_inbound") {
        // Fleet manager routed a message to us (topic mode)
        const meta = msg.meta as Record<string, string>;
        const targetSession = msg.targetSession as string | undefined;
        void this.wake().then(() => {
          this.pushChannelMessage(msg.content as string, meta, targetSession);
        }).catch(err => {
          this.logger.error({ err: (err as Error).message }, "Wake failed for inbound delivery");
        });
      } else if (msg.type === "raw_paste") {
        // Paste raw text directly to CLI without [user:] wrapping.
        if (this.tmux) {
          const rawText = msg.content as string;
          this.pasteLock = this.pasteLock.then(async () => {
            await this.wake();
            await this.deliverMessage(rawText);
            this.logger.debug({ text: rawText.slice(0, 100) }, "Raw paste delivered");
          }).catch(err => {
            this.logger.warn({ err: (err as Error).message }, "raw_paste delivery error");
          });
        }
      } else if (msg.type === "fleet_schedule_trigger") {
        const payload = msg.payload as Record<string, unknown>;
        const meta = msg.meta as Record<string, string>;
        void this.wake().then(() => this.pushChannelMessage(payload.message as string, meta)).catch(err => {
          this.logger.error({ err: (err as Error).message }, "Wake failed for scheduled delivery");
        });
      } else if (msg.type === "fleet_tool_status_ack") {
        // Fleet manager sent us the messageId for our tool status message
        this.toolStatusMessageId = msg.messageId as string;
      } else if (msg.type === "query_instance_state") {
        const snapshot = this.getInstanceStateSnapshot();
        this.ipcServer?.send(socket, {
          type: "instance_state_response",
          requestId: msg.requestId,
          instanceName: this.name,
          ...snapshot,
          state: this.isPaused ? "paused" : snapshot.state,
          pausedAt: this.lastPausedAt,
        });
      }
    });

    // 2. Tmux — ensure session, create window if not alive
    await TmuxManager.ensureSession(this.tmuxSessionName);
    this.tmux = new TmuxManager(this.tmuxSessionName, "");

    // Strategy A: always start fresh Claude window (MCP server has no reconnection)
    // Kill any existing window from previous run
    const windowIdFile = join(this.instanceDir, "window-id");
    if (existsSync(windowIdFile)) {
      const savedId = readFileSync(windowIdFile, "utf-8").trim();
      if (savedId) {
        const oldTmux = new TmuxManager(this.tmuxSessionName, savedId);
        if (await oldTmux.isWindowAlive()) {
          this.saveSessionId();
          await oldTmux.killWindow();
          this.logger.info({ savedId }, "Killed old tmux window for fresh start");
        }
      }
    }

    const resumed = await this.spawnClaudeWindow();
    this.isNewSession = !resumed;
    if (!resumed) {
      await this.injectSnapshotMessage();
    } else {
      // Clean up stale snapshot file — resume restored full context, snapshot not needed
      try { unlinkSync(join(this.instanceDir, "rotation-state.json")); } catch { /* may not exist */ }
    }

    // Warmup: wait for CLI idle, then trigger steering reload — but only when
    // the instructions actually changed since the agent last saw them.
    // Skipping the no-op reload saves 10-30s of agent time on every restart
    // where instructions are unchanged.
    (async () => {
      try {
        if (!this.warmupNeeded) {
          this.logger.debug("Warmup skipped — instructions unchanged");
          return;
        }
        // Skip warmup if no one is talking to this instance (avoid triggering
        // unsolicited agent replies on idle instances after fleet restart).
        if (this.pasteQueueDepth === 0) {
          this.logger.debug("Warmup deferred — no pending inbound messages");
          // Convert to pendingInstructionsNotice so it fires on next real message.
          this.pendingInstructionsNotice = true;
          try { writeFileSync(join(this.instanceDir, "prev-instructions"), this.lastBuiltInstructions); } catch {}
          return;
        }
        const wid = existsSync(join(this.instanceDir, "window-id"))
          ? readFileSync(join(this.instanceDir, "window-id"), "utf-8").trim() : "";
        if (wid && this.controlClient) {
          await this.controlClient.waitForIdle(wid, 120_000);
        } else {
          await new Promise(r => setTimeout(r, 5000));
        }
        await this.tmux?.pasteText("[system] Your instructions/steering files have been updated. Re-read your steering files. Do not reply to this message.");
        // Record the value the agent has now been told about so the next
        // unchanged restart skips the reload.
        try { writeFileSync(join(this.instanceDir, "prev-instructions"), this.lastBuiltInstructions); } catch { /* best effort */ }
        this.logger.debug("Warmup sent after idle");
      } catch { /* non-fatal */ }
    })();

    if (!this.config.lightweight) {
      // 3. Pipe-pane for prompt detection
      const outputLog = join(this.instanceDir, "output.log");
      await this.tmux.pipeOutput(outputLog).catch(() => {});

      // 4. Transcript monitor
      this.transcriptMonitor = new TranscriptMonitor(this.instanceDir, this.logger);

      // 5. Wire transcript events
      const ackIfPending = () => {
        if (!this.pendingAckMessage || !this.adapter) return;
        const { chatId, messageId } = this.pendingAckMessage;
        this.pendingAckMessage = null;
        this.adapter.react(chatId, messageId, "🫡")
          .catch(e => this.logger.debug({ err: (e as Error).message }, "Ack react failed"));
      };
      this.transcriptMonitor.on("tool_use", (name: string, input: unknown) => {
        this.logger.debug({ tool: name }, "Tool use");
        ackIfPending();
        this.hangDetector?.recordActivity();
        this.recordRecentEvent({ type: "tool_use", name, preview: this.summarizeTool(name, input) });
        this.recordRecentToolActivity(this.summarizeTool(name, input));
      });
      this.transcriptMonitor.on("tool_result", (name: string, _output: unknown) => {
        this.hangDetector?.recordActivity();
        this.recordRecentEvent({ type: "tool_result", name });
      });
      this.transcriptMonitor.on("assistant_text", (text: string) => {
        this.logger.debug({ text: text.slice(0, 200) }, "Claude response");
        ackIfPending();
        this.hangDetector?.recordActivity();
        this.recordRecentEvent({ type: "assistant_text", preview: text.slice(0, 100) });
      });
      this.transcriptMonitor.startPolling();

      // HangDetector remains the fleet-manager notification event bridge. Its
      // legacy silence timer is intentionally not started: pane state transitions
      // below are now the sole source of hang events.
      const hangConfig = (this.config as InstanceConfig & {
        hang_detector?: { enabled?: boolean; timeout_minutes?: number };
      }).hang_detector;
      if (hangConfig?.enabled !== false) {
        this.hangDetector = new HangDetector(hangConfig?.timeout_minutes ?? 10);
      }

      // 8. Context guardian
      const statusFile = join(this.instanceDir, "statusline.json");
      this.guardian = new ContextGuardian(this.config.context_guardian, this.logger, statusFile);
      this.guardian.startWatching();

      this.guardian.on("status_update", () => {
        this.saveSessionId();
        this.hangDetector?.recordStatuslineUpdate();
      });
      // Context rotation removed: all CLI backends have built-in auto-compact.
      // Crash recovery (health check + respawn with snapshot) is retained below.

    }

    // NOTE: Do NOT set process.env.AGEND_SOCKET_PATH here — it pollutes the
    // shared fleet manager process env. Each daemon overwrites it, so the last
    // one wins, causing MCP servers (especially kiro-cli which inherits process
    // env) to connect to the wrong socket. The socket path is passed via
    // per-instance MCP config files or wrapper scripts instead.

    // 10. Health check — detect crashed tmux window and respawn
    // Re-enabled: orphan window issue fixed by killing same-name windows before respawn.
    // Without this, a dead CLI window goes undetected and messages are silently lost.
    this.startHealthCheck();
    if (!this.config.lightweight) {
      this.startErrorMonitor();
    }
    this.startInstanceStateMonitor();

    this.logger.info(`${this.name} ready`);
  }

  private startHealthCheck(): void {
    if (this.runtimeMonitorsFrozen || this.healthCheckTimer) return;
    const { max_retries, backoff, reset_after } = this.config.restart_policy;
    if (max_retries <= 0) return; // restart disabled

    const scheduleNext = () => {
      if (this.runtimeMonitorsFrozen || this.healthCheckTimer) return;
      this.healthCheckTimer = setTimeout(async () => {
        this.healthCheckTimer = null;
        if (this.runtimeMonitorsFrozen) return;
        // Instance directory removed externally (e.g. `rm -rf ~/.agend/instances/<name>`).
        // Stop the loop permanently — otherwise every tick triggers a respawn, whose
        // writeRotationSnapshot fails with ENOENT and gets caught as "Failed to respawn",
        // spamming errors every ~30s forever.
        if (!existsSync(this.instanceDir)) {
          this.logger.warn({ instanceDir: this.instanceDir }, "Instance directory missing — stopping health check");
          this.healthCheckPaused = true;
          this.healthCheckTimer = null;
          return;
        }
        if (!this.tmux || this.spawning || this.healthCheckPaused || Daemon.tmuxServerPaused) {
          scheduleNext();
          return;
        }

        // Human-readable backend label for logs (e.g. "claude", "kiro-cli")
        const cliLabel = this.backend?.binaryName ?? "CLI";

        let paneStatus = await this.tmux.getPaneStatus();
        // Auto-pause intentionally exits the pane process. A health tick that
        // began just before pause must not classify that exit as a crash.
        if (this.isPaused || this.pauseWakeState === "waking") {
          scheduleNext();
          return;
        }
        if (paneStatus?.alive) {
          scheduleNext();
          return;
        }

        // A null status is ambiguous: it can be a transient `tmux list-panes`
        // failure (e.g. tmux busy during a fleet-restart storm) rather than a
        // real exit. Re-confirm once after a short delay before treating it as
        // a crash. A non-null {alive:false} is a definite dead pane (real exit)
        // and needs no recheck.
        if (paneStatus === null) {
          await new Promise(r => setTimeout(r, 1500));
          paneStatus = await this.tmux.getPaneStatus();
          if (paneStatus?.alive) {
            this.logger.debug(`[health] ${cliLabel} pane reported gone then alive on recheck — transient query failure, ignoring`);
            scheduleNext();
            return;
          }
        }

        // paneStatus === null → window gone entirely (e.g. tmux server crash)
        // paneStatus.alive === false → pane dead, exit code available
        const exitCode = paneStatus?.exitCode;
        this.logger.debug({ exitCode }, `[health] pane exited with code: ${exitCode}`);

        // Normal exit (e.g. user Ctrl+C or /exit) — no crash, no respawn
        if (paneStatus && exitCode === 0) {
          this.logger.info("CLI exited normally (code 0) — pausing health check");
          await this.tmux.killWindow();
          this.healthCheckPaused = true;
          return;
        }

        // Distinguish tmux server crash from single window crash.
        // nullReason records *why* getPaneStatus returned null (for diagnosing
        // whether this was a real window loss or a transient query failure).
        let crashType: "server" | "window" = "window";
        let nullReason: string | undefined;
        if (!paneStatus) {
          const serverAlive = await TmuxManager.sessionExists(this.tmuxSessionName);
          if (!serverAlive) {
            crashType = "server";
            nullReason = "server_gone";
            this.logger.error(`tmux server died — all ${cliLabel} windows lost`);

            // Fleet-level circuit breaker: pause all instances on repeated tmux server crashes
            Daemon.tmuxServerCrashTimestamps.push(Date.now());
            const cutoff = Date.now() - 5 * 60_000;
            Daemon.tmuxServerCrashTimestamps = Daemon.tmuxServerCrashTimestamps.filter(t => t > cutoff);
            if (Daemon.tmuxServerCrashTimestamps.length >= 2 && !Daemon.tmuxServerPaused) {
              Daemon.tmuxServerPaused = true;
              this.logger.error("Fleet-level tmux server circuit breaker triggered — pausing all respawns for 30s");
              this.emit("tmux_server_crash", this.name);
              if (!Daemon.tmuxServerRecoveryTimer) {
                Daemon.tmuxServerRecoveryTimer = setTimeout(() => {
                  Daemon.tmuxServerRecoveryTimer = null;
                  Daemon.tmuxServerPaused = false;
                }, 30_000);
              }
              scheduleNext();
              return;
            }

            await new Promise(r => setTimeout(r, 2_000)); // let session stabilize
          } else {
            // null but server alive: window-level disappearance. Probe whether
            // the window truly no longer exists vs a transient query glitch.
            nullReason = "no_window";
            try {
              const windows = await TmuxManager.listWindows(this.tmuxSessionName);
              if (windows.some(w => w.name === this.name)) nullReason = "window_present_query_glitch";
            } catch { nullReason = "query_error"; }
            this.logger.warn({ exitCode, nullReason }, `${cliLabel} window not found (tmux server alive)`);
          }
        } else {
          this.logger.warn({ exitCode }, `${cliLabel} process exited`);
        }

        // Capture last output before killing. Best-effort even when the pane is
        // gone (paneStatus null) — gives the crash record something to diagnose
        // from instead of an empty lastOutput.
        let lastOutput: string | undefined;
        try {
          const raw = await this.tmux.capturePaneWithHistory(50);
          // Strip ANSI escape codes for readability
          const cleaned = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
          lastOutput = cleaned.trimEnd() || undefined;
        } catch { /* best effort — pane may already be gone */ }

        // Kill the dead window (remain-on-exit keeps it around) before respawn
        if (paneStatus) {
          await this.tmux.killWindow();
        }

        // Detect claude-code background session conflict — recover without counting as crash
        if (lastOutput && (lastOutput.includes("background agent") || lastOutput.includes("Session is currently running"))) {
          if (!this.backgroundSessionRecoveryAttempted) {
            this.backgroundSessionRecoveryAttempted = true;
            this.logger.warn("Detected lingering background agent session — starting fresh (no resume)");
            const sidFile = join(this.instanceDir, "session-id");
            try { unlinkSync(sidFile); } catch {}
            this.skipResume = true;
            await new Promise(r => setTimeout(r, 2_000));
            try {
              await this.spawnClaudeWindow();
              this.logger.info("Recovered from background session conflict");
              this.emit("crash_respawn", this.name);
            } catch (err) {
              this.logger.error({ err: (err as Error).message }, "Recovery from background session conflict failed");
            }
            return; // Don't count as crash
          }
          // Already attempted recovery — fall through to normal crash handling
        }

        // Detect a --continue/--resume failure (no conversation to resume). The
        // session-id file persists across the crash, so a blind respawn would add
        // --continue again and crash in the same way → loop. Clear the session id
        // and skip resume so the next spawn starts fresh. (skipResume also stops
        // saveSessionId below from resurrecting the id from statusline.json.)
        if (lastOutput && /no conversation found|no conversation to (continue|resume)|no previous (session|conversation)|--continue/i.test(lastOutput)) {
          this.logger.warn("Detected --continue/resume failure — clearing session-id; next spawn starts fresh");
          try { unlinkSync(join(this.instanceDir, "session-id")); } catch { /* may not exist */ }
          this.skipResume = true;
        }

        // Append to crash history
        this.appendCrashHistory({ exitCode, lastOutput, crashType, reason: nullReason });

        // Detect rapid crash: sliding window — 3+ crashes in 5 minutes
        this.crashTimestamps.push(Date.now());
        const crashWindowMs = 5 * 60_000;
        this.crashTimestamps = this.crashTimestamps.filter(t => t > Date.now() - crashWindowMs);

        if (this.crashTimestamps.length >= 3) {
          this.healthCheckPaused = true;
          this.logger.error(
            { crashesInWindow: this.crashTimestamps.length },
            "3+ crashes in 5 minutes — pausing respawn",
          );
          // P1: Persist crash state so next process restart skips resume
          try {
            writeFileSync(join(this.instanceDir, "crash-state.json"), JSON.stringify({
              crashesInWindow: this.crashTimestamps.length,
              lastCrashAt: Date.now(),
              resumeDisabled: true,
            }));
          } catch { /* best effort */ }
          this.emit("crash_loop", this.name);
          return; // don't schedule next — paused
        }

        // Reset crash count if enough time has passed
        if (reset_after > 0 && Date.now() - this.lastCrashAt > reset_after) {
          this.crashCount = 0;
        }

        this.crashCount++;
        this.lastCrashAt = Date.now();

        if (this.crashCount > max_retries) {
          this.logger.error({ crashCount: this.crashCount, maxRetries: max_retries }, "Max crash retries exceeded — not respawning");
          return; // don't schedule next — given up
        }

        // Calculate backoff delay
        const delay = backoff === "exponential"
          ? Math.min(1000 * Math.pow(2, this.crashCount - 1), 60_000)
          : 1000 * this.crashCount;

        this.logger.warn({ crashCount: this.crashCount, delay }, `${cliLabel} window died — respawning after backoff`);

        await new Promise(r => setTimeout(r, delay));

        try {
          this.saveSessionId();
          this.transcriptMonitor?.resetOffset();
          // Kill orphan MCP server from the crashed CLI session.
          // MCP server writes its PID to channel.mcp.pid on startup.
          try {
            const pidFile = join(this.instanceDir, "channel.mcp.pid");
            const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
            process.kill(pid, "SIGTERM");
            this.logger.info({ pid }, "Killed orphan MCP server");
          } catch { /* no pid file or process already dead */ }
          // Kill any same-name windows before respawn to prevent orphans.
          // Wrapped in try-catch: if tmux server is dead, listWindows throws —
          // must not block spawnClaudeWindow (which calls ensureSession).
          try {
            const windows = await TmuxManager.listWindows(this.tmuxSessionName);
            for (const w of windows) {
              if (w.name === this.name) {
                const tm = new TmuxManager(this.tmuxSessionName, w.id);
                await tm.killWindow();
              }
            }
          } catch { /* tmux server may be dead — ensureSession in trySpawn will recover */ }
          // Write snapshot before spawn — consumed only if resume fails
          this.writeRotationSnapshot("crash");
          // Try --resume first; spawnClaudeWindow falls back to fresh session if resume fails
          const resumed = await this.spawnClaudeWindow();
          if (!resumed) {
            // Resume failed → fresh session → inject snapshot for context
            await this.injectSnapshotMessage();
          } else {
            // Clean up stale snapshot — resume restored full context
            try { unlinkSync(join(this.instanceDir, "rotation-state.json")); } catch { /* may not exist */ }
          }
          this.logger.info({ resumed }, `Respawned ${cliLabel} window after crash`);
          this.emit("crash_respawn", this.name);
        } catch (err) {
          this.logger.error({ err }, `Failed to respawn ${cliLabel} window`);
        }

        scheduleNext();
      }, this.config.restart_policy.health_check_interval_ms ?? 30_000);
    };

    scheduleNext();
  }

  /**
   * Periodically scan PTY output for backend-defined error patterns.
   *
   * State machine to avoid false positives from stale buffer text:
   *   MONITORING → (error pattern match) → WAITING_FOR_RECOVERY → (ready pattern match) → MONITORING
   *
   * Only emits pty_error once per error occurrence. After the agent recovers
   * (ready pattern visible), it goes back to monitoring for new errors.
   */
  private startErrorMonitor(): void {
    if (this.runtimeMonitorsFrozen || this.errorMonitorTimer) return;
    const patterns = this.backend?.getErrorPatterns?.() ?? [];
    const dialogs = this.backend?.getRuntimeDialogs?.() ?? [];
    if (!patterns.length && !dialogs.length) return;
    if (!this.tmux) return;
    if (!this.backend) return; // lightweight mode has no backend
    const readyPattern = this.backend.getReadyPattern();

    this.errorMonitorTimer = setInterval(async () => {
      if (!this.tmux || this.spawning) return;
      try {
        const alive = await this.tmux.isWindowAlive();
        if (!alive) return;

        const pane = await this.tmux.capturePane();

        // Count occurrences of a pattern across the WHOLE pane (not just the text
        // after the last ready prompt — a fast recovery can put "ready" AFTER the
        // error line, which the old scanText approach missed).
        const countMatches = (pattern: RegExp): number => {
          const g = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
          return (pane.match(g) || []).length;
        };

        // Auto-dismiss runtime dialogs (e.g. Codex rate limit model switch)
        for (const dialog of dialogs) {
          if (!dialog.pattern.test(pane)) continue;
          this.logger.info(`Auto-dismissing runtime dialog: ${dialog.description}`);
          const SPECIAL_KEYS = new Set(["Up", "Down", "Enter", "Escape", "Right", "Left"]);
          for (const key of dialog.keys) {
            if (SPECIAL_KEYS.has(key)) {
              await this.tmux.sendSpecialKey(key as "Enter" | "Escape" | "Up" | "Down" | "Right" | "Left");
            } else {
              await this.tmux.pasteText(key);
            }
            await new Promise(r => setTimeout(r, 200));
          }
          return; // Dialog dismissed, skip error checks this cycle
        }

        // State: waiting for recovery — check if agent is back to ready
        if (this.errorWaitingForRecovery) {
          if (readyPattern.test(pane)) {
            const downtime = Math.round((Date.now() - this.errorDetectedAt) / 1000);
            // Absorb the current count of the just-handled error type so it isn't
            // re-triggered; a later NEW occurrence pushes the count higher again.
            if (this.lastDetectedErrorType) {
              const ep = patterns.find(p => p.type === this.lastDetectedErrorType);
              if (ep) this.lastErrorCount.set(ep.type, countMatches(ep.pattern));
            }
            this.errorWaitingForRecovery = false;
            this.errorDetectedAt = 0;
            this.logger.info({ downtime_s: downtime }, "PTY error recovered — agent is ready again");
            this.emit("pty_recovered", { name: this.name, downtime_s: downtime });
          }
          return; // Don't check for errors while waiting for recovery
        }

        // State: monitoring — count-based new-error detection over the full pane
        for (const ep of patterns) {
          const count = countMatches(ep.pattern);
          const seen = this.lastErrorCount.get(ep.type) ?? 0;

          if (count <= seen) {
            // Occurrences scrolled out of the capture buffer → lower the baseline
            // so a future re-occurrence still counts as new (no permanent suppress).
            if (count < seen) this.lastErrorCount.set(ep.type, count);
            continue;
          }

          // count > seen → a NEW occurrence of this error appeared.
          // Cooldown: 2nd-layer guard so the same type isn't re-notified within
          // the window. Leave the count unconsumed so it fires once cooldown ends.
          if (!ep.skipCooldown) {
            const lastNotified = this.lastErrorNotifiedAt.get(ep.type) ?? 0;
            if (Date.now() - lastNotified < Daemon.ERROR_COOLDOWN_MS) {
              this.logger.debug({ errorType: ep.type }, "PTY error suppressed (cooldown active)");
              break;
            }
          }
          if (ep.action === "failover" && Date.now() - this.lastFailoverAt < Daemon.FAILOVER_COOLDOWN_MS) {
            this.logger.debug({ errorType: ep.type }, "PTY error suppressed (failover cooldown active)");
            break;
          }

          this.lastErrorCount.set(ep.type, count);
          // skipRecoveryWait: this error self-recovers (e.g. a timeout — Kiro is
          // back at its prompt immediately). Its ready-pattern only matches the
          // startup banner, so entering "waiting for recovery" would never clear
          // and would block ALL future error detection. Just absorb the baseline
          // (done above) and keep monitoring so the next occurrence still fires.
          if (!ep.skipRecoveryWait) {
            this.errorWaitingForRecovery = true;
            this.errorDetectedAt = Date.now();
            this.lastDetectedErrorType = ep.type;
          }
          this.lastErrorNotifiedAt.set(ep.type, Date.now());
          if (ep.action === "failover") this.lastFailoverAt = Date.now();
          this.logger.warn({ errorType: ep.type, action: ep.action }, `PTY error detected: ${ep.message}`);
          this.emit("pty_error", { name: this.name, ...ep });

          break; // Only handle first new error per scan
        }
      } catch {
        // capturePane can fail if window is transitioning — ignore
      }
    }, 5_000); // Check every 5 seconds (runtime dialogs need fast response)
  }

  /**
   * Interrupt the CLI's current generation (cancel button / `/cancel`).
   * Direct tmux key event (not a paste) so it registers as the interrupt key.
   * kiro-cli interrupts on Ctrl+C; the others (claude-code, codex, …) on Escape.
   */
  async sendEscape(): Promise<void> {
    const cancelKey = this.backend?.getCancelKey() ?? "Escape";
    await this.tmux?.sendSpecialKey(cancelKey as "Enter" | "Escape" | "Up" | "Down" | "Right" | "Left" | "C-c");
  }

  async stop(): Promise<void> {
    this.logger.info("Stopping daemon instance");
    this.freezeRuntimeMonitors();
    if (this.toolStatusDebounce) { clearTimeout(this.toolStatusDebounce); this.toolStatusDebounce = null; }
    this.pendingIpcRequests.clear();
    this.hangDetector?.stop();
    if (this.adapter) await this.adapter.stop();

    // Notify MCP servers of graceful shutdown (prevents reconnect attempts)
    this.ipcServer?.broadcast({ type: "shutdown" });

    // Quit CLI FIRST — this kills MCP server child processes cleanly.
    // IPC must stay open during quit so MCP servers receive the shutdown message.
    if (this.tmux) {
      this.saveSessionId();
      this.healthCheckPaused = true;
      let killed = false;
      const quitCmd = this.backend?.getQuitCommand();
      const quitKey = this.backend?.getQuitKey?.();
      if (quitCmd) {
        await this.tmux.sendKeys(quitCmd);
        // Delay before Enter to prevent tmux server race when multiple
        // instances stop in parallel (same pattern as pasteText).
        await new Promise(r => setTimeout(r, 150));
        await this.tmux.sendSpecialKey("Enter");
      } else if (quitKey) {
        // Some CLIs quit via a key chord (e.g. grok Ctrl+Q), not a typed command.
        await this.tmux.sendSpecialKey(quitKey as "Enter" | "Escape" | "Up" | "Down" | "Right" | "Left" | "C-c" | "C-q");
      }
      if (quitCmd || quitKey) {
        // Wait up to 3s for graceful exit, polling every 200ms. A healthy CLI
        // exits within ~1s; a longer wait just delays the force-kill fallback.
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 200));
          const status = await this.tmux.getPaneStatus();
          if (!status || !status.alive) { killed = true; break; }
        }
      }
      if (!killed) this.logger.warn("CLI did not exit gracefully within 3s, force killing window");
      // Always kill window — remain-on-exit keeps dead panes around after CLI exits
      await this.tmux.killWindow();
      const windowIdFile = join(this.instanceDir, "window-id");
      try { unlinkSync(windowIdFile); } catch (e) { this.logger.debug({ err: e }, "Failed to remove window-id file"); }
    }

    // Close IPC AFTER CLI has exited — MCP servers are already dead at this point
    await this.ipcServer?.close();

    // Clean up backend config files
    if (this.backend?.cleanup) {
      this.backend.cleanup(this.buildBackendConfig());
    }
    // Clean up checked-out repos
    try { rmSync(join(this.instanceDir, "repos"), { recursive: true, force: true }); } catch { /* best effort */ }

    const pidPath = join(this.instanceDir, "daemon.pid");
    try {
      unlinkSync(pidPath);
    } catch (e) {
      this.logger.debug({ err: e }, "Failed to remove PID file");
    }
    try { unlinkSync(join(this.instanceDir, "paused-state.json")); } catch {}
  }

  getHangDetector(): HangDetector | null {
    return this.hangDetector;
  }

  getInstanceState(): InstanceState | "paused" {
    return this.isPaused ? "paused" : this.instanceState;
  }

  getInstanceStateSnapshot(): InstanceStateSnapshot {
    return this.instanceStateMachine?.snapshot() ?? {
      state: this.instanceState,
      unchangedForMs: 0,
      observedAt: Date.now(),
      stateChangedAt: Date.now(),
    };
  }

  /** Gracefully stop the CLI while keeping its remain-on-exit tmux window. */
  async pause(): Promise<void> {
    if (this.pauseWakeState === "paused") return;
    if (this.pauseWakeState === "pausing" || this.pauseWakeState === "waking") {
      await this.pauseWakeTransition;
      if (this.getPauseWakeState() !== "active") return;
    }
    if (this.instanceState !== "idle" || this.pasteQueueDepth > 0) {
      this.pauseRequested = false;
      return;
    }

    this.pauseWakeState = "pausing";
    this.healthCheckPaused = true;
    this.freezeRuntimeMonitors();
    const transition = (async () => {
      try {
        this.saveSessionId();
        const quitCmd = this.backend?.getQuitCommand();
        const quitKey = this.backend?.getQuitKey?.();
        if (this.tmux) {
          if (quitCmd) {
            await this.tmux.sendKeys(quitCmd);
            await new Promise(r => setTimeout(r, 150));
            await this.tmux.sendSpecialKey("Enter");
          } else if (quitKey) {
            // Key-chord quit (e.g. grok Ctrl+Q) — no typed command to send.
            await this.tmux.sendSpecialKey(quitKey as "Enter" | "Escape" | "Up" | "Down" | "Right" | "Left" | "C-c" | "C-q");
          }
        }

        let exited = false;
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 200));
          const status = await this.tmux?.getPaneStatus();
          if (status && !status.alive) { exited = true; break; }
        }
        if (!exited) {
          await this.killProcessTree("SIGTERM");
          await new Promise(r => setTimeout(r, 1_000));
          const status = await this.tmux?.getPaneStatus();
          if (status?.alive) {
            await this.killProcessTree("SIGKILL");
            await new Promise(r => setTimeout(r, 200));
          }
        }
        const finalStatus = await this.tmux?.getPaneStatus();
        if (!finalStatus || finalStatus.alive) {
          throw new Error("Auto-pause could not stop the CLI while preserving its tmux window");
        }

        this.pauseWakeState = "paused";
        this.autoPauseController.markPaused();
        writeFileSync(join(this.instanceDir, "paused-state.json"), JSON.stringify({
          paused_at: this.lastPausedAt,
        }));
        this.logger.info({ pausedAt: this.lastPausedAt }, "Instance auto-paused");
        this.ipcServer?.broadcast({
          type: "instance_state", instanceName: this.name, state: "paused", pausedAt: this.lastPausedAt,
        });
        this.emit("auto_paused", { name: this.name, pausedAt: this.lastPausedAt });
      } catch (err) {
        this.pauseWakeState = "active";
        this.healthCheckPaused = false;
        this.pauseRequested = false;
        this.resumeRuntimeMonitors();
        throw err;
      }
    })();
    this.pauseWakeTransition = transition;
    try { await transition; } finally {
      if (this.pauseWakeTransition === transition) this.pauseWakeTransition = null;
    }
  }

  /** Respawn the CLI in the preserved window and block until its prompt is ready. */
  async wake(timeoutMs = 30_000): Promise<void> {
    if (this.pauseWakeState === "active") return;
    if (this.pauseWakeState === "pausing") await this.pauseWakeTransition;
    if (this.getPauseWakeState() === "active") return;
    if (this.pauseWakeState === "waking") {
      await this.pauseWakeTransition;
      return;
    }

    this.pauseWakeState = "waking";
    this.spawning = true;
    const transition = this.autoPauseController.wakeOnDeliver(async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const ready = await Promise.race([
          this.trySpawn(true, timeoutMs),
          new Promise<false>(resolve => { timeout = setTimeout(() => resolve(false), timeoutMs); }),
        ]);
        if (!ready) throw new Error(`Wake timed out before CLI became ready (${timeoutMs}ms)`);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    });
    this.pauseWakeTransition = transition;
    try {
      await transition;
      this.pauseWakeState = "active";
      this.healthCheckPaused = false;
      this.pauseRequested = false;
      try { unlinkSync(join(this.instanceDir, "paused-state.json")); } catch {}
      this.transcriptMonitor?.resetOffset();
      this.resumeRuntimeMonitors();
      this.logger.info("Instance auto-woke");
      this.ipcServer?.broadcast({
        type: "instance_state", instanceName: this.name, state: this.instanceState, pausedAt: null,
      });
      this.emit("auto_woke", { name: this.name });
    } catch (err) {
      this.pauseWakeState = "paused";
      this.healthCheckPaused = true;
      this.logger.error({ err: (err as Error).message }, "Instance wake failed");
      throw err;
    } finally {
      this.spawning = false;
      if (this.pauseWakeTransition === transition) this.pauseWakeTransition = null;
    }
  }

  private startInstanceStateMonitor(): void {
    if (this.runtimeMonitorsFrozen || !this.tmux || !this.backend || this.instanceStateMonitorTimer) return;

    const rawConfig = (this.config as InstanceConfig & {
      hang_detector?: { timeout_minutes?: number; poll_interval_ms?: number };
    }).hang_detector;
    const timeoutMinutes = rawConfig?.timeout_minutes;
    const stuckTimeoutMs = typeof timeoutMinutes === "number" && timeoutMinutes > 0
      ? timeoutMinutes * 60_000
      : DEFAULT_STUCK_TIMEOUT_MS;
    const pollIntervalMs = typeof rawConfig?.poll_interval_ms === "number" && rawConfig.poll_interval_ms > 0
      ? rawConfig.poll_interval_ms
      : DEFAULT_STATE_POLL_INTERVAL_MS;

    const readyPattern = this.backend.getReadyPattern();
    this.instanceStateMachine = new PaneStateMachine(readyPattern, stuckTimeoutMs);

    const poll = async () => {
      if (!this.tmux || this.spawning || this.statePollInFlight) return;
      this.statePollInFlight = true;
      try {
        const paneStatus = await this.tmux.getPaneStatus();
        if (!paneStatus?.alive) return;
        const pane = await this.tmux.capturePane();
        const previous = this.instanceState;
        const snapshot = this.instanceStateMachine!.observe(pane);
        this.instanceState = snapshot.state;

        // Only a transition back to idle completes pending work. Repeated idle
        // polls between enqueue and paste must not clear a newly-recorded inbound.
        if (snapshot.state === "idle" && previous !== "idle") {
          this.pendingWork.recordIdle(snapshot.observedAt);
        }

        if (snapshot.state !== previous) {
          this.logger.info({
            previousState: previous,
            state: snapshot.state,
            unchangedForMs: snapshot.unchangedForMs,
          }, "Instance execution state changed");
          this.emit("instance_state", { name: this.name, ...snapshot });
          this.ipcServer?.broadcast({ type: "instance_state", instanceName: this.name, ...snapshot });

          // Emit exactly once per transition into stuck. Further notifications
          // require observable progress (working) or a ready prompt (idle) first.
          if (snapshot.state === "stuck") {
            this.handleStuckTransition(pane, snapshot, readyPattern);
          }
        }

        if (snapshot.state !== "idle") this.pauseRequested = false;
        if (!this.pauseRequested && this.pasteQueueDepth === 0 && this.autoPauseController.observe(snapshot.state)) {
          this.pauseRequested = true;
          this.emit("auto_pause_requested", { name: this.name, idleSince: snapshot.stateChangedAt });
        }
      } catch (err) {
        // A pane can disappear between status and capture during restart. Keep
        // the last known state and retry on the next poll.
        this.logger.debug({ err: (err as Error).message }, "Instance state poll failed");
      } finally {
        this.statePollInFlight = false;
      }
    };

    void poll();
    this.instanceStateMonitorTimer = setInterval(() => { void poll(); }, pollIntervalMs);
  }

  private handleStuckTransition(pane: string, snapshot: InstanceStateSnapshot, readyPattern: RegExp): void {
    const deterministicReadyPattern = new RegExp(readyPattern.source, readyPattern.flags.replace(/[gy]/g, ""));
    const diagnostic = {
      backend: this.backend?.binaryName ?? this.config.backend ?? "unknown",
      paneTail: sanitizePaneTail(pane),
      readyPattern: readyPattern.toString(),
      readyMatched: deterministicReadyPattern.test(pane),
      unchangedForMs: snapshot.unchangedForMs,
      pendingWork: this.pendingWork.hasPendingWork(),
    };
    if (!diagnostic.pendingWork) {
      this.logger.debug(diagnostic, "Suppressing stuck notification without pending work");
      return;
    }
    this.logger.warn(diagnostic, "Instance pane stuck with pending work");
    this.hangDetector?.emit("hang", { unchangedForMs: snapshot.unchangedForMs });
  }

  /** Stop every runtime poller/watcher while preserving IPC and daemon state. */
  private freezeRuntimeMonitors(): void {
    this.runtimeMonitorsFrozen = true;
    if (this.healthCheckTimer) { clearTimeout(this.healthCheckTimer); this.healthCheckTimer = null; }
    if (this.errorMonitorTimer) { clearInterval(this.errorMonitorTimer); this.errorMonitorTimer = null; }
    if (this.instanceStateMonitorTimer) { clearInterval(this.instanceStateMonitorTimer); this.instanceStateMonitorTimer = null; }
    this.transcriptMonitor?.stop();
    this.guardian?.stop();
  }

  /** Restore the same monitor objects after wake without adding event listeners. */
  private resumeRuntimeMonitors(): void {
    if (!this.runtimeMonitorsFrozen) return;
    this.runtimeMonitorsFrozen = false;
    this.startHealthCheck();
    if (!this.config.lightweight) {
      this.transcriptMonitor?.startPolling();
      this.guardian?.startWatching();
      this.startErrorMonitor();
    }
    this.startInstanceStateMonitor();
  }

  getMessageBus(): MessageBus {
    return this.messageBus;
  }

  // ── Tool status tracking ──────────────────────────────────────

  private summarizeTool(name: string, input: unknown): string {
    const inp = input as Record<string, unknown> | null;
    if (!inp) return name;
    if (name === "Read") return `Read ${inp.file_path ?? ""}`;
    if (name === "Edit") return `Edit ${inp.file_path ?? ""}`;
    if (name === "Write") return `Write ${inp.file_path ?? ""}`;
    if (name === "Bash") return `$ ${String(inp.command ?? "").slice(0, 50)}`;
    if (name === "Glob") return `Glob ${inp.pattern ?? ""}`;
    if (name === "Grep") return `Grep ${inp.pattern ?? ""}`;
    if (name === "Agent") return "Agent (subagent)";
    if (name.startsWith("mcp__agend__")) return ""; // skip channel tools
    return name;
  }

  private addToolStatus(name: string, input: unknown, state: "running" | "done"): void {
    const summary = this.summarizeTool(name, input);
    if (!summary) return; // skip empty (e.g., channel tools)

    if (state === "running") {
      this.toolStatusLines.push(`⏳ ${summary}`);
    } else {
      // Mark the last matching tool as done
      for (let i = this.toolStatusLines.length - 1; i >= 0; i--) {
        if (this.toolStatusLines[i].includes(name) && this.toolStatusLines[i].startsWith("⏳")) {
          this.toolStatusLines[i] = this.toolStatusLines[i].replace("⏳", "✅");
          break;
        }
      }
    }
    this.debouncedSendToolStatus();
  }

  /** Debounce tool status updates to avoid channel rate limits */
  private debouncedSendToolStatus(): void {
    if (this.toolStatusDebounce) clearTimeout(this.toolStatusDebounce);
    this.toolStatusDebounce = setTimeout(() => this.sendToolStatus(), 500);
  }

  private sendToolStatus(): void {
    const text = this.toolStatusLines.join("\n");
    if (!text) return;

    this.ipcServer?.broadcast({
      type: "fleet_tool_status",
      instanceName: this.name,
      text,
      editMessageId: this.toolStatusMessageId,
    });
  }

  /** Called by fleet manager when tool status message is sent (returns messageId) */
  setToolStatusMessageId(messageId: string): void {
    this.toolStatusMessageId = messageId;
  }

  /**
   * Push an inbound channel message to a specific MCP session.
   * If targetSession is provided, only send to the matching socket.
   * Otherwise send to the instance's own session (this.name).
   */
  pushChannelMessage(content: string, meta: Record<string, string>, _targetSession?: string): void {
    if (!this.tmux) {
      this.logger.warn("Cannot push channel message: tmux not running");
      return;
    }
    // Remember (and persist) the reply target. Only real channel messages have a
    // non-empty chat_id; cross-instance messages have chat_id="" and must NOT
    // overwrite it (their reply would otherwise go nowhere).
    this.updateLastChat(meta.chat_id, meta.thread_id, meta.adapter_id);
    if (this.pendingInstructionsUpdate) {
      writeFileSync(join(this.instanceDir, "prev-instructions"), this.pendingInstructionsUpdate);
      this.pendingInstructionsUpdate = undefined;
    }
    this.hangDetector?.recordInbound();
    this.pendingWork.recordInbound();
    // v3: record user messages for rotation snapshot
    this.recordRecentUserMessage(content, meta);

    // Format message with metadata prefix for the agent
    const user = meta.user || "unknown";
    const fromInstance = meta.from_instance;

    // /raw prefix: paste directly without [user:] wrapping (topic mode only, protected by allowed_users upstream)
    if (!fromInstance && content.startsWith("/raw ")) {
      const rawText = content.slice(5);
      this.logger.info({ user }, "Raw paste from topic mode user");
      this.pasteLock = this.pasteLock.then(async () => {
        await this.deliverMessage(rawText);
      }).catch(err => {
        this.logger.warn({ err: (err as Error).message }, "pasteLock raw delivery error");
      });
      return;
    }

    let formatted: string;
    if (fromInstance) {
      // #77: show the sender's display name for readability, keeping the machine
      // instance name in parens so the recipient's send_to_instance target is valid.
      const fromLabel = meta.from_display ? `${meta.from_display} (${fromInstance})` : fromInstance;
      formatted = `[from:${fromLabel}] ${content}\n(If you need to reply, use send_to_instance tool, NOT direct text. If there is nothing to add, you may stay silent.)`;
    } else {
      const via = meta.source ? ` via ${meta.source}` : "";
      const idTag = meta.user_id ? `, id:${meta.user_id}` : "";
      formatted = `[user:${user}${via}${idTag}] ${content}\n(Reply using the reply tool — do NOT respond with direct text)`;
    }
    if (meta.reply_to_text) {
      formatted += `\n(reply_to: "${meta.reply_to_text}")`;
    }

    // Serialize deliveries: each message waits for the previous to complete,
    // and each waits for the CLI to be idle before pasting. Messages are never
    // dropped for age — a long-busy CLI just queues them until it frees up
    // (the user can press Cancel to interrupt and let the queue drain sooner).
    const chatId = meta.chat_id;
    const messageId = meta.message_id;
    const wasQueued = this.pasteQueueDepth > 0;
    this.pasteQueueDepth++;
    if (this.pasteQueueDepth > 3) {
      this.logger.warn({ depth: this.pasteQueueDepth }, "Message delivery queue backing up");
    }
    if (wasQueued && chatId && messageId) {
      this.emit("message_queued", { chatId: meta.thread_id || chatId, messageId });
    }
    this.pasteLock = this.pasteLock.then(async () => {
      try {
        if (this.config.pre_task_command) {
          await this.deliverMessage(this.config.pre_task_command);
        }
        if (this.pendingInstructionsNotice) {
          this.pendingInstructionsNotice = false;
          await this.deliverMessage("[system] Your instructions/steering files have been updated. Re-read your steering files. Do not reply to this message.");
        }
        const status = (chatId && messageId)
          ? { chatId: meta.thread_id || chatId, messageId }
          : undefined;
        await this.deliverMessage(formatted, status);
      } finally {
        this.pasteQueueDepth--;
      }
    }).catch(err => {
      this.logger.warn({ err: (err as Error).message }, "pasteLock delivery error — chain continues");
    });
    this.logger.debug({ user: meta.user, text: content.slice(0, 100) }, "Queued channel message for delivery");
  }

  /**
   * Deliver a single message and drive its status reactions:
   *   ⏳ message_queued    — CLI busy; queued, waiting for idle
   *   👀 message_delivered — pasted + Enter sent; agent now has it
   *   ✅ message_confirmed — idle→busy transition observed; agent is processing
   *   ❌ message_failed    — tmux window gone, paste retries exhausted
   * Returns true once the message is in the CLI, false only on real delivery failure.
   *
   * Bug A (silent message loss): paste failures retry with backoff (window recovery)
   * and emit `message_failed` if all attempts fail.
   * Busy handling (UX): we never force-paste into a busy CLI and never give up on a
   * busy one — we show ⏳ and wait for idle indefinitely (a genuinely hung CLI is the
   * hang detector's job; a user who can't wait presses Cancel → Escape → idle). The
   * pasteLock is serial, so later messages naturally queue behind this wait.
   */
  private async deliverMessage(formatted: string, status?: { chatId: string; messageId: string }): Promise<boolean> {
    // Sanitize unclosed code fences — they cause CLI to wait for closure on Enter
    const fenceCount = (formatted.match(/```/g) || []).length;
    if (fenceCount % 2 !== 0) {
      // Odd number of fences = unclosed. Remove all code fences from the message.
      formatted = formatted.replace(/```/g, "");
    }

    let windowId = this.getWindowId();

    // If the CLI is busy, show ⏳ and wait for it to go idle — no timeout, no force.
    if (windowId && this.controlClient && !this.controlClient.isIdle(windowId)) {
      if (status) this.emit("message_queued", status);
      this.logger.debug("CLI busy — queuing message until idle");
      await this.controlClient.waitUntilIdle(windowId);
    }

    // Bug A: paste with backoff. Transient failures are usually a stale window id
    // after a crash/respawn — recover by name and retry (max 3 attempts, 2s apart).
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const pasted = await this.tmux!.pasteBuffer(formatted);
      if (!pasted) {
        this.logger.warn({ attempt }, "pasteBuffer failed — recovering window and backing off");
        windowId = (await this.recoverWindow()) ?? windowId;
        if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // Settle the bracketed paste, then submit.
      await new Promise(r => setTimeout(r, 500));
      const enterAt = Date.now();
      await this.tmux!.sendSpecialKey("Enter");
      if (status) this.emit("message_delivered", status); // 👀

      // Confirm the CLI accepted the message by transitioning idle→busy (new output
      // after Enter). If still idle after ~2s the Enter was likely swallowed while
      // the TUI was redrawing — re-send Enter once and re-check.
      if (windowId && this.controlClient) {
        let becameBusy = await this.confirmBusyAfterEnter(windowId, enterAt);
        if (!becameBusy) {
          this.logger.warn("No idle→busy transition after Enter — re-sending Enter once");
          const retryAt = Date.now();
          await this.tmux!.sendSpecialKey("Enter");
          becameBusy = await this.confirmBusyAfterEnter(windowId, retryAt);
        }
        if (becameBusy && status) this.emit("message_confirmed", status); // ✅
      } else {
        // No control client to observe output: fall back to the legacy double-Enter.
        await new Promise(r => setTimeout(r, 1000));
        await this.tmux!.sendSpecialKey("Enter");
        if (status) this.emit("message_confirmed", status); // ✅ (best-effort)
      }
      return true;
    }

    this.logger.error("Message delivery failed after retries — window not ready");
    if (status) this.emit("message_failed", status); // ❌
    return false;
  }

  /** Re-resolve this instance's tmux window by name (stale id after crash/respawn). */
  private async recoverWindow(): Promise<string | undefined> {
    try {
      const windows = await TmuxManager.listWindows(this.tmuxSessionName);
      const match = windows.find(w => w.name === this.name);
      if (!match) return undefined;
      this.tmux = new TmuxManager(this.tmuxSessionName, match.id);
      writeFileSync(join(this.instanceDir, "window-id"), match.id);
      await this.controlClient?.registerWindow(match.id);
      this.logger.info({ windowId: match.id }, "Recovered window ID for message delivery");
      return match.id;
    } catch (retryErr) {
      this.logger.error({ err: retryErr }, "Failed to recover window for message delivery");
      return undefined;
    }
  }

  /** Poll up to ~2s (200ms × 10) for the pane to emit output after `since`. */
  private async confirmBusyAfterEnter(windowId: string, since: number): Promise<boolean> {
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (this.controlClient!.hasOutputSince(windowId, since)) return true;
    }
    return false;
  }

  private getWindowId(): string | undefined {
    try {
      return readFileSync(join(this.instanceDir, "window-id"), "utf-8").trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** Find the IPC socket for a given sessionName */
  private findSocketBySession(sessionName: string): import("node:net").Socket | undefined {
    for (const [socket, name] of this.socketSessionNames) {
      if (name === sessionName && !socket.destroyed) return socket;
    }
    return undefined;
  }

  /**
   * Handle a tool call from the MCP server (forwarded by Claude).
   * Routes to the channel adapter via MessageBus.
   */
  private handleToolCall(msg: Record<string, unknown>, socket: import("node:net").Socket): void {
    const tool = msg.tool as string;
    const args = (msg.args ?? {}) as Record<string, unknown>;
    const requestId = msg.requestId as number;

    this.logger.debug({ tool, requestId }, "Tool call from MCP server");

    // For now, log and respond. Full adapter routing will be wired in fleet manager.
    const respond = (result: unknown, error?: string) => {
      this.ipcServer?.send(socket, { requestId, result, error });
    };

    // Repo checkout — handled locally in daemon (no fleet-manager)
    if (tool === "checkout_repo") {
      this.handleCheckoutRepo(args, respond);
      return;
    }
    if (tool === "release_repo") {
      this.handleReleaseRepo(args, respond);
      return;
    }

    if (tool === "set_display_name" || tool === "set_description") {
      const type = tool === "set_display_name" ? "fleet_set_display_name" : "fleet_set_description";
      const fleetReqId = `${tool === "set_display_name" ? "dn" : "desc"}_${requestId}`;
      this.ipcServer?.broadcast({
        type,
        payload: args,
        meta: { instance_name: this.name },
        fleetRequestId: fleetReqId,
      });
      const timeout = setTimeout(() => {
        this.pendingIpcRequests.delete(fleetReqId);
        respond(null, `${tool} timed out`);
      }, 10_000);
      this.pendingIpcRequests.set(fleetReqId, (respMsg) => {
        clearTimeout(timeout);
        respond(respMsg.result, respMsg.error as string | undefined);
      });
      return;
    }

    if (tool === TASK_TOOL) {
      const fleetReqId = `task_${requestId}`;
      this.ipcServer?.broadcast({
        type: "fleet_task",
        payload: args,
        meta: { instance_name: this.name },
        fleetRequestId: fleetReqId,
      });
      const timeout = setTimeout(() => {
        this.pendingIpcRequests.delete(fleetReqId);
        respond(null, "Task operation timed out after 30s");
      }, 30_000);
      this.pendingIpcRequests.set(fleetReqId, (respMsg) => {
        clearTimeout(timeout);
        respond(respMsg.result, respMsg.error as string | undefined);
      });
      return;
    }

    if (DECISION_TOOLS.has(tool)) {
      const typeMap: Record<string, string> = {
        post_decision: "fleet_decision_create",
        list_decisions: "fleet_decision_list",
        update_decision: "fleet_decision_update",
      };
      const fleetReqId = `dec_${requestId}`;
      this.ipcServer?.broadcast({
        type: typeMap[tool],
        payload: args,
        meta: { instance_name: this.name, working_directory: this.config.working_directory },
        fleetRequestId: fleetReqId,
      });
      const timeout = setTimeout(() => {
        this.pendingIpcRequests.delete(fleetReqId);
        respond(null, "Decision operation timed out after 30s");
      }, 30_000);
      this.pendingIpcRequests.set(fleetReqId, (respMsg) => {
        clearTimeout(timeout);
        respond(respMsg.result, respMsg.error as string | undefined);
      });
      return;
    }

    if (SCHEDULE_TOOLS.has(tool)) {
      const typeMap: Record<string, string> = {
        create_schedule: "fleet_schedule_create",
        list_schedules: "fleet_schedule_list",
        update_schedule: "fleet_schedule_update",
        delete_schedule: "fleet_schedule_delete",
      };

      // Use fleetRequestId (not requestId) to avoid MCP server resolving the
      // pending tool call prematurely when it receives the broadcast.
      const fleetReqId = `sched_${requestId}`;
      this.ipcServer?.broadcast({
        type: typeMap[tool],
        payload: args,
        meta: { chat_id: this.lastChatId, thread_id: this.lastThreadId, instance_name: this.name },
        fleetRequestId: fleetReqId,
      });

      // Wait for fleet_schedule_response via pending request map
      const timeout = setTimeout(() => {
        this.pendingIpcRequests.delete(fleetReqId);
        respond(null, "Schedule operation timed out after 30s");
      }, 30_000);
      this.pendingIpcRequests.set(fleetReqId, (respMsg) => {
        clearTimeout(timeout);
        respond(respMsg.result, respMsg.error as string | undefined);
      });
      return;
    }

    if (CROSS_INSTANCE_TOOLS.has(tool)) {
      // Route to fleet manager via IPC (topic mode only)
      if (this.topicMode && this.ipcServer) {
        // Use fleetRequestId (not requestId) to avoid MCP server resolving the
        // pending tool call prematurely when it receives the broadcast.
        const fleetReqId = `xmsg_${requestId}`;
        const senderSessionName = this.socketSessionNames.get(socket);
        this.ipcServer.broadcast({
          type: "fleet_outbound",
          tool,
          args,
          fleetRequestId: fleetReqId,
          senderSessionName,
        });
        const crossTimeoutMs = (tool === "start_instance" || tool === "create_instance" || tool === "replace_instance") ? 60_000 : 30_000;
        const timeout = setTimeout(() => {
          this.pendingIpcRequests.delete(fleetReqId);
          respond(null, `Cross-instance operation timed out after ${crossTimeoutMs / 1000}s`);
        }, crossTimeoutMs);
        this.pendingIpcRequests.set(fleetReqId, (respMsg) => {
          clearTimeout(timeout);
          respond(respMsg.result, respMsg.error as string | undefined);
        });
      } else {
        respond(null, "Cross-instance messaging requires topic mode");
      }
      return;
    }

    // Context-bound routing: reply/react/edit_message always use the daemon's last known context.
    // chat_id and thread_id are not exposed in the tool schema — daemon is solely responsible for routing.
    // Must run before IPC forwarding so topic-mode (fleet manager) also receives the correct chat_id.
    if (["reply", "react", "edit_message"].includes(tool)) {
      const adapters = this.messageBus.getAllAdapters();
      const isTopicMode = adapters.length === 0;
      if (!this.lastChatId && !isTopicMode) {
        respond(null, "No active chat context — awaiting inbound message");
        return;
      }
      if (this.lastChatId) {
        args.chat_id = this.lastChatId;
        if (tool === "reply") args.thread_id = this.lastThreadId;
      }
    }

    // Route to adapter via MessageBus
    const adapters = this.messageBus.getAllAdapters();
    if (adapters.length === 0) {
      // Topic mode: forward to fleet manager via IPC (fleet manager connected as IPC client)
      // The fleet manager's IPC client receives this and routes to shared adapter.
      // Use fleetRequestId (not requestId) to avoid other MCP sessions on this daemon
      // from prematurely resolving their pending requests when they receive the broadcast.
      const fleetReqId = `tool_${requestId}`;
      const outboundKey = fleetReqId;
      this.ipcServer?.broadcast({ type: "fleet_outbound", tool, args, fleetRequestId: fleetReqId });
      const timeout = setTimeout(() => {
        this.pendingIpcRequests.delete(outboundKey);
        respond(null, "Fleet outbound timed out after 30s");
      }, 30_000);
      this.pendingIpcRequests.set(outboundKey, (respMsg) => {
        clearTimeout(timeout);
        respond(respMsg.result, respMsg.error as string | undefined);
      });
      return;
    }

    const adapter = adapters[0];

    if (!routeToolCall(adapter, tool, args, this.lastThreadId, respond)) {
      respond(null, `Unknown tool: ${tool}`);
    }
  }

  /** Build config object for the CLI backend */
  private buildBackendConfig(): CliBackendConfig {
    const isCliMode = this.config.agent_mode === "cli" || (this.config.agent_mode == null && this.config.backend === "antigravity");
    const sockPath = join(this.instanceDir, "channel.sock");
    let serverJs = join(__dirname, "channel", "mcp-server.js");
    if (!existsSync(serverJs)) {
      serverJs = join(__dirname, "..", "dist", "channel", "mcp-server.js");
    }

    // ── Resolve workflow and systemPrompt once, share between MCP env and instructions ──
    let resolvedWorkflow: string | false | undefined;
    if (this.config.workflow === false) {
      resolvedWorkflow = false;
    } else {
      const wf = this.config.workflow ?? "builtin";
      if (wf !== "builtin") {
        let content = wf;
        if (content.startsWith("file:")) {
          try { content = readFileSync(content.slice(5), "utf-8"); } catch { content = ""; }
        }
        resolvedWorkflow = content || undefined;
      }
    }

    let resolvedCustomPrompt: string | undefined;
    if (this.config.systemPrompt) {
      // Support comma-separated file: paths for prompt modularization:
      //   systemPrompt: "file:prompts/role.md, file:prompts/rules.md, file:prompts/context.md"
      const parts = this.config.systemPrompt.split(",").map((s: string) => s.trim());
      const resolved = parts.map((part: string) => {
        if (part.startsWith("file:")) {
          try { return readFileSync(part.slice(5), "utf-8"); } catch { return ""; }
        }
        return part;
      }).filter(Boolean);
      if (resolved.length > 0) resolvedCustomPrompt = resolved.join("\n\n");
    }

    let decisions: { title: string; content: string }[] | undefined;
    if (process.env.AGEND_DECISIONS) {
      try {
        const all: { title: string; content: string; scope?: string; project_root?: string }[] = JSON.parse(process.env.AGEND_DECISIONS);
        const workDir = this.config.working_directory;
        decisions = all.filter(d => d.scope === "fleet" || d.project_root === workDir);
        // Stable ordering so identical decision sets always build byte-identical
        // instructions — otherwise source ordering jitter flips the warmup hash.
        decisions.sort((a, b) => a.title.localeCompare(b.title));
      } catch (err) {
        this.logger.warn({ err }, "AGEND_DECISIONS env var is not valid JSON — decisions will not be injected");
      }
    }

    // ── MCP server env (dual-track: still passes env vars for MCP instructions fallback) ──
    const mcpEnv: Record<string, string> = {
      AGEND_SOCKET_PATH: sockPath,
      AGEND_INSTANCE_NAME: this.name,
      AGEND_WORKING_DIR: this.config.working_directory,
    };
    if (this.config.tool_set) mcpEnv.AGEND_TOOL_SET = this.config.tool_set;
    if (this.config.display_name) mcpEnv.AGEND_DISPLAY_NAME = this.config.display_name;
    if (this.config.description) mcpEnv.AGEND_DESCRIPTION = this.config.description;
    if (resolvedWorkflow === false) mcpEnv.AGEND_WORKFLOW = "false";
    else if (resolvedWorkflow) mcpEnv.AGEND_WORKFLOW = resolvedWorkflow;
    if (resolvedCustomPrompt) mcpEnv.AGEND_CUSTOM_PROMPT = resolvedCustomPrompt;
    if (decisions && decisions.length > 0) mcpEnv.AGEND_DECISIONS = JSON.stringify(decisions);

    // ── Fleet instructions for additive system prompt injection ──
    let instructions: string;
    if (isCliMode) {
      // CLI mode: inject CLI quick reference instead of MCP tool schema
      let cliRef = "";
      try {
        const cliInstrPath = join(__dirname, "agent-cli-instructions.md");
        if (!existsSync(cliInstrPath)) {
          const altPath = join(__dirname, "..", "dist", "agent-cli-instructions.md");
          if (existsSync(altPath)) cliRef = readFileSync(altPath, "utf-8");
        } else {
          cliRef = readFileSync(cliInstrPath, "utf-8");
        }
      } catch { /* fallback to empty */ }
      instructions = buildFleetInstructions({
        instanceName: this.name,
        workingDirectory: this.config.working_directory,
        displayName: this.config.display_name,
        description: this.config.description,
        customPrompt: resolvedCustomPrompt,
        workflow: resolvedWorkflow,
        decisions,
        cliInstructions: cliRef || undefined,
      });
    } else {
      instructions = buildFleetInstructions({
        instanceName: this.name,
        workingDirectory: this.config.working_directory,
        displayName: this.config.display_name,
        description: this.config.description,
        customPrompt: resolvedCustomPrompt,
        workflow: resolvedWorkflow,
        decisions,
      });
    }

    const agentPort = parseInt(process.env.AGEND_PORT ?? "19280", 10);

    return {
      workingDirectory: this.config.working_directory,
      instanceDir: this.instanceDir,
      instanceName: this.name,
      mcpServers: isCliMode ? {} : {
        "agend": {
          command: "node",
          args: [serverJs],
          env: mcpEnv,
        },
      },
      skipPermissions: this.config.skipPermissions,
      model: this.modelOverride ?? this.config.model,
      skipResume: this.skipResume,
      instructions,
      agentMode: isCliMode ? "cli" : "mcp",
      agentPort: isCliMode ? agentPort : undefined,
    };
  }

  /**
   * After CLI is ready, paste any pending session snapshot as the first
   * user input so the agent picks up where the previous session left off.
   * This replaces the old system-prompt injection approach.
   */
  private async injectSnapshotMessage(): Promise<void> {
    if (this.snapshotConsumed) return;
    const snapshot = this.buildSnapshotPrompt();
    if (!snapshot || !this.tmux) return;
    if (this.pendingInstructionsUpdate) {
      writeFileSync(join(this.instanceDir, "prev-instructions"), this.pendingInstructionsUpdate);
      this.pendingInstructionsUpdate = undefined;
    }
    // Small delay to let the CLI fully render its ready prompt
    await new Promise(r => setTimeout(r, 1_000));
    try {
      await this.tmux.pasteText(`[system:session-snapshot]\n${snapshot}\n\nThis is a background context restore — do NOT reply to or acknowledge this message. Simply resume normal operation when the next user or instance message arrives.`);
      this.logger.info("Injected session snapshot as first message");
      this.emit("snapshot_injected", this.name);
    } catch (err) {
      this.logger.error({ err }, "Snapshot injection failed — session continues without context");
      this.emit("snapshot_failed", this.name);
    }
  }

  /** Spawn a CLI window. Returns true if --resume was used successfully. */
  private async spawnClaudeWindow(): Promise<boolean> {
    this.spawning = true;
    let resumedSuccessfully = false;
    try {
    this.toolStatusLines = [];
    this.toolStatusMessageId = null;
    if (!this.backend) {
      throw new Error("No backend configured — cannot spawn CLI window");
    }

    const attemptedResume = !this.skipResume;
    const alive = await this.trySpawn();
    if (!alive) {
      // First attempt failed (stale --resume, crash, rate limit, etc.)
      // Clean slate: clear session-id, skip resume, and retry once.
      this.logger.warn("CLI startup failed — clearing session-id and retrying without resume");
      const sidFile = join(this.instanceDir, "session-id");
      try { unlinkSync(sidFile); } catch { /* may not exist */ }
      this.skipResume = true;
      await this.killProcessTree();
      await this.tmux!.killWindow();

      const retryAlive = await this.trySpawn();
      if (!retryAlive) {
        await this.killProcessTree();
        await this.tmux!.killWindow();
        throw new Error("CLI failed to start after retry");
      }
    } else if (attemptedResume) {
      resumedSuccessfully = true;
    }

    this.lastSpawnAt = Date.now();
    this.skipResume = false; // CLI started successfully — reset for next spawn
    this.backgroundSessionRecoveryAttempted = false;
    } finally {
      this.spawning = false;
    }
    return resumedSuccessfully;
  }

  /** Kill the entire process tree of the current tmux pane (CLI + MCP server). */
  private async killProcessTree(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (!this.tmux) return;
    try {
      const pid = await TmuxManager.getPanePid(this.tmuxSessionName, this.tmux.getWindowId());
      if (pid) {
        process.kill(-pid, signal);
        this.logger.debug({ pid, signal }, "Killed process group");
      }
    } catch { /* process group may not exist or already dead */ }
  }

  /**
   * Spawn a CLI window and verify it reaches a ready state.
   * Uses control mode to wait for output, then checks pane content.
   * Handles confirmation dialogs (trust folder, bypass permissions).
   * Returns true if CLI is ready, false if it failed or got stuck.
   */
  private async trySpawn(reuseWindow = false, startupTimeoutMs?: number): Promise<boolean> {
    const backendConfig = this.buildBackendConfig();

    // Compare freshly-built instructions against the last value the agent was
    // told about. Computed for ALL backends (not gated by
    // instructionsReloadedOnResume) so the warmup steering-reload can be
    // skipped when nothing changed.
    this.lastBuiltInstructions = backendConfig.instructions ?? "";
    {
      const prevFile = join(this.instanceDir, "prev-instructions");
      let prev = "";
      try { prev = readFileSync(prevFile, "utf-8"); } catch {}
      if (!prev && backendConfig.instructions) {
        // First time (no prev-instructions file): write current hash, skip warmup.
        try { writeFileSync(prevFile, backendConfig.instructions); } catch {}
        this.warmupNeeded = false;
      } else {
        this.warmupNeeded = !!backendConfig.instructions && prev !== backendConfig.instructions;
      }

      // For backends that don't re-read instructions on resume (kiro/codex/
      // gemini), also notify the agent on next message instead of forcing a new
      // session. Resume is preserved so context isn't lost.
      if (!backendConfig.skipResume && !this.backend!.instructionsReloadedOnResume && this.warmupNeeded) {
        if (prev) {
          this.logger.info("Instructions changed — will notify agent on next message");
          this.pendingInstructionsNotice = true;
        }
        this.pendingInstructionsUpdate = backendConfig.instructions;
      }
    }

    this.backend!.writeConfig(backendConfig);
    this.backend!.preTrust?.(this.config.working_directory);

    // Resolve working directory (e.g. symlink for hidden paths)
    const resolvedCwd = this.backend!.resolveWorkingDirectory?.(this.config.working_directory, this.name) ?? this.config.working_directory;

    // Generate a fresh per-instance agent token each spawn. agent-cli reads
    // this file from <instanceDir>/agent.token (mode 0o600) and sends its
    // value in the X-Agend-Instance-Token header; the daemon-side /agent
    // endpoint verifies it matches the on-disk value for the claimed
    // instance. This prevents other local processes (even those holding
    // the global web token) from impersonating instances.
    const agentTokenPath = join(this.instanceDir, "agent.token");
    const agentToken = randomBytes(32).toString("hex");
    writeFileSync(agentTokenPath, agentToken, { mode: 0o600 });
    try { chmodSync(agentTokenPath, 0o600); } catch {}

    // AGEND_HOME points the child's agent-cli at the same data dir the daemon
    // is using, so it can locate <instanceDir>/agent.token.
    const agendHome = join(this.instanceDir, "..", "..");
    let envPrefix = `TERM=xterm-256color AGEND_INSTANCE_NAME=${shellQuote(this.name)} AGEND_HOME=${shellQuote(agendHome)}`;
    if (backendConfig.agentMode === "cli" && backendConfig.agentPort) {
      envPrefix += ` AGEND_PORT=${backendConfig.agentPort}`;
    }
    const cmd = `${envPrefix} ` + this.backend!.buildCommand(backendConfig);

    // Ensure tmux session exists (may have been destroyed if all windows died)
    await TmuxManager.ensureSession(this.tmuxSessionName);
    let windowId: string;
    if (reuseWindow) {
      this.controlClient?.unregisterWindow(this.tmux!.getWindowId());
      await this.tmux!.respawnWindow(cmd, resolvedCwd);
      windowId = this.tmux!.getWindowId();
    } else {
      windowId = await this.tmux!.createWindow(cmd, resolvedCwd, this.name);
    }
    writeFileSync(join(this.instanceDir, "window-id"), windowId);

    // Enable remain-on-exit to capture exit codes on crash
    await this.tmux!.setRemainOnExit().catch(err => {
      this.logger.warn({ err }, "Failed to set remain-on-exit — exit codes will not be captured");
    });
    if (reuseWindow && !this.config.lightweight) {
      await this.tmux!.pipeOutput(join(this.instanceDir, "output.log")).catch(err => {
        this.logger.warn({ err }, "Failed to restore pipe-pane after wake");
      });
    }

    // Register with control client and wait for output + idle
    await this.controlClient?.registerWindow(windowId);
    if (this.controlClient) {
      const total = startupTimeoutMs ?? this.config.startup_timeout_ms ?? 25_000;
      const outputTimeout = Math.round(total * 0.6);
      const idleTimeout = total - outputTimeout;
      const hasOutput = await this.controlClient.waitForOutput(windowId, outputTimeout);
      if (!hasOutput) {
        // Fallback: some TUI backends (e.g. opencode) don't trigger tmux %output events.
        // Check pane content directly for ready pattern before giving up.
        const pane = await this.tmux!.capturePane();
        if (!this.backend!.getReadyPattern().test(pane)) return false;
      } else {
        await this.controlClient.waitForIdle(windowId, idleTimeout);
      }
    } else {
      await new Promise(r => setTimeout(r, 10_000));
    }

    // Dismiss confirmation dialogs and verify CLI reached prompt.
    // With remain-on-exit, isWindowAlive() returns true even for dead panes,
    // but a startup crash would already be caught by waitForOutput/waitForIdle above.
    if (!await this.tmux!.isWindowAlive()) return false;
    return this.dismissDialogsUntilReady(3);
  }

  /**
   * Repeatedly check pane content, dismiss any confirmation dialogs,
   * and return true once CLI reaches a ready prompt.
   */
  private async dismissDialogsUntilReady(maxAttempts: number): Promise<boolean> {
    // Backend-specific startup dialogs, with hardcoded fallback for backward compat
    const startupDialogs: StartupDialog[] = this.backend?.getStartupDialogs?.() ?? [
      { pattern: /[❯›]\s*\d+\.\s*No/m, keys: ["Down", "Enter"], description: "Confirmation dialog — navigate past No" },
      { pattern: /[❯›]\s*Don't trust/m, keys: ["Up", "Up", "Enter"], description: "Trust dialog — navigate to trust option" },
      { pattern: /No, exit|No, quit|Don't trust|I accept|I trust|Yes, continue|Trust folder/i, keys: ["Enter"], description: "Generic confirmation dialog" },
      { pattern: /Resume Session/i, keys: ["Escape"], description: "Resume session picker — start fresh" },
    ];

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const pane = await this.tmux!.capturePane();

        // Try each startup dialog pattern before checking ready state
        let matched = false;
        for (const dialog of startupDialogs) {
          if (dialog.pattern.test(pane)) {
            this.logger.debug(`Dismissing startup dialog: ${dialog.description}`);
            for (const key of dialog.keys) {
              if (key === "Up" || key === "Down" || key === "Enter" || key === "Escape") {
                await this.tmux!.sendSpecialKey(key);
              } else {
                await this.tmux!.sendKeys(key);
              }
              await new Promise(r => setTimeout(r, 200));
            }
            // Wait for next screen to render
            if (this.controlClient) {
              const wid = readFileSync(join(this.instanceDir, "window-id"), "utf-8").trim();
              await this.controlClient.waitForIdle(wid, 10_000);
            } else {
              await new Promise(r => setTimeout(r, 3_000));
            }
            if (!await this.tmux!.isWindowAlive()) return false;
            matched = true;
            break;
          }
        }
        if (matched) continue;

        // CLI is ready (pattern defined by each backend)
        if (this.backend!.getReadyPattern().test(pane)) return true;

        // Fatal: command not found (must match full phrase to avoid false positives
        // like Kiro's "agent X not found, using default")
        if (/command not found|: not found$/m.test(pane)) return false;
      } catch {
        return false;
      }
    }
    // Exhausted attempts — assume ok for unknown CLI prompts
    return true;
  }

  /**
   * Update and persist the last reply target. Ignores empty chatId (cross-instance
   * messages) so it never overwrites a real channel target. Persisted to
   * last-chat.json so the reply target survives a restart (see start()).
   */
  private updateLastChat(chatId?: string, threadId?: string, adapterId?: string): void {
    if (!chatId) return;
    this.lastChatId = chatId;
    // An unthreaded inbound must clear a previous topic rather than leaking it
    // into the next reply target.
    this.lastThreadId = threadId || undefined;
    if (adapterId) this.lastAdapterId = adapterId;
    try {
      writeFileSync(join(this.instanceDir, "last-chat.json"),
        JSON.stringify({ chatId: this.lastChatId, threadId: this.lastThreadId, adapterId: this.lastAdapterId }));
    } catch { /* best effort */ }
  }

  private saveSessionId(): void {
    // When a resume failure has forced a fresh start, don't persist the stale id
    // back from statusline.json — that would re-arm --continue and re-loop.
    if (this.skipResume) return;
    const sid = this.backend?.getSessionId();
    if (sid) {
      writeFileSync(join(this.instanceDir, "session-id"), sid);
    }
  }

  private readContextPercentage(): number {
    return this.backend?.getContextUsage() ?? 0;
  }

  /** Set a model override for next spawn (used by failover logic) */
  setModelOverride(model: string | undefined): void {
    this.modelOverride = model;
  }

  /** Get the currently active model override */
  getModelOverride(): string | undefined {
    return this.modelOverride;
  }

  /** Public wrapper for graceful restart — wait for instance to be idle. */
  waitForIdle(quietMs = 5000): Promise<void> {
    return new Promise((resolve) => {
      const monitor = this.transcriptMonitor;
      // No transcript monitor (e.g. lightweight mode) — no events to wait for.
      if (!monitor) { setTimeout(resolve, quietMs); return; }

      const events = ["tool_use", "tool_result", "assistant_text"];
      let timer: ReturnType<typeof setTimeout>;
      let settled = false;

      const done = () => {
        if (settled) return;
        settled = true;
        // Always remove from the same monitor we registered on — avoids
        // imbalance if this.transcriptMonitor is later reassigned.
        events.forEach(e => monitor.removeListener(e, reset));
        resolve();
      };
      const reset = () => {
        clearTimeout(timer);
        timer = setTimeout(done, quietMs);
      };

      timer = setTimeout(done, quietMs);
      events.forEach(e => monitor.on(e, reset));
    });
  }

  // ── Context Rotation v3: Ring buffers ─────────────────────────

  private recordRecentUserMessage(content: string, meta: Record<string, string>): void {
    // Only record real user messages, not cross-instance messages
    if (!meta.user || meta.user.startsWith("instance:")) return;
    this.recentUserMessages.push({
      text: content.slice(0, 200),
      ts: meta.ts ?? new Date().toISOString(),
    });
    if (this.recentUserMessages.length > 10) this.recentUserMessages.shift();
  }

  private recordRecentEvent(event: RotationSnapshotEvent): void {
    this.recentEvents.push(event);
    if (this.recentEvents.length > 15) this.recentEvents.shift();
  }

  private recordRecentToolActivity(summary: string): void {
    if (!summary) return;
    this.recentToolActivity.push(summary);
    if (this.recentToolActivity.length > 10) this.recentToolActivity.shift();
  }

  // ── Context Rotation v3: Snapshot writer ──────────────────────

  writeRotationSnapshot(reason: string): RotationSnapshot {
    const statusline = this.readStatuslineData();
    const snapshot: RotationSnapshot = {
      instance: this.name,
      reason,
      created_at: new Date().toISOString(),
      working_directory: this.config.working_directory,
      session_id: this.backend?.getSessionId() ?? null,
      context_pct: this.readContextPercentage(),
      recent_user_messages: [...this.recentUserMessages],
      recent_events: [...this.recentEvents],
      recent_tool_activity: [...this.recentToolActivity],
      last_statusline: statusline ? {
        model: statusline.model?.display_name,
        cost_usd: statusline.cost?.total_cost_usd,
        five_hour_pct: statusline.rate_limits?.five_hour?.used_percentage,
        seven_day_pct: statusline.rate_limits?.seven_day?.used_percentage,
      } : undefined,
    };
    const snapshotPath = join(this.instanceDir, "rotation-state.json");
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
    this.snapshotConsumed = false;
    this.logger.info({
      reason,
      context_pct: snapshot.context_pct,
      user_msg_count: snapshot.recent_user_messages?.length ?? 0,
      event_count: snapshot.recent_events?.length ?? 0,
    }, "Snapshot written");
    return snapshot;
  }

  /** Collect ring buffer data for handover to a replacement instance. */
  collectHandoverContext(): string {
    const lines: string[] = [];
    if (this.recentUserMessages.length > 0) {
      lines.push("Recent user messages:");
      for (const msg of this.recentUserMessages) lines.push(`- ${msg.text}`);
      lines.push("");
    }
    if (this.recentEvents.length > 0) {
      lines.push("Recent activity:");
      for (const ev of this.recentEvents) {
        if (ev.type === "assistant_text") lines.push(`- Assistant: ${ev.preview}`);
        else lines.push(`- ${ev.name}${ev.preview ? `: ${ev.preview}` : ""}`);
      }
      lines.push("");
    }
    if (this.recentToolActivity.length > 0) {
      lines.push("Recent tool activity:");
      for (const t of this.recentToolActivity) lines.push(`- ${t}`);
      lines.push("");
    }
    const pct = this.readContextPercentage();
    if (pct != null) lines.push(`Context usage: ${pct}%`);
    return lines.join("\n").slice(0, 4000);
  }

  private appendCrashHistory(data: { exitCode?: number; lastOutput?: string; crashType: "server" | "window"; reason?: string }): void {
    try {
      const historyPath = join(this.instanceDir, "crash-history.jsonl");
      const entry = {
        timestamp: new Date().toISOString(),
        instance: this.name,
        crashType: data.crashType,
        exitCode: data.exitCode,
        reason: data.reason,
        lastOutput: data.lastOutput,
        crashCount: this.crashCount + 1,
        crashesInWindow: this.crashTimestamps.length,
      };
      appendFileSync(historyPath, JSON.stringify(entry) + "\n");

      // Rotate based on file size (cheaper than parsing every time)
      try {
        const stat = statSync(historyPath);
        if (stat.size > 512_000) {
          const content = readFileSync(historyPath, "utf-8");
          const lines = content.trim().split("\n").filter(Boolean);
          writeFileSync(historyPath, lines.slice(-50).join("\n") + "\n");
        }
      } catch { /* best effort */ }
    } catch { /* best effort */ }
  }

  private readStatuslineData(): import("./types.js").StatusLineData | null {
    try {
      const sf = join(this.instanceDir, "statusline.json");
      return JSON.parse(readFileSync(sf, "utf-8"));
    } catch {
      return null;
    }
  }

  // ── Repo Checkout ─────────────────────────────────────────

  private async handleCheckoutRepo(
    args: Record<string, unknown>,
    respond: (result: unknown, error?: string) => void,
  ): Promise<void> {
    const { execFile: execFileCb } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFileCb);

    const rawSource = args.source as string | undefined;
    if (!rawSource) { respond(null, "checkout_repo: missing required argument 'source'"); return; }
    const expanded = rawSource.replace(/^~/, process.env.HOME || "~");

    // Resolve instance name to working_directory via IPC query
    // If source doesn't look like a path, treat it as an instance name
    if (!expanded.startsWith("/")) {
      // Broadcast to get instance info — but we don't have fleet config in daemon.
      // Instead, rely on fleet manager to resolve. For now, reject non-path sources.
      respond(null, `Source must be an absolute path or ~-prefixed path. Use describe_instance to find a repo's working_directory.`);
      return;
    }
    // Normalize to collapse any `..` segments.
    const source = resolve(expanded);

    const branch = (args.branch as string) || "HEAD";
    // Validate branch ref: git refs allow [A-Za-z0-9._/-], reject `..` to prevent
    // worktreePath escape via basename(source)-${branch.replace("/", "-")}.
    // Reject leading `-` or `+` so git cannot interpret the value as an option
    // flag (e.g. `--upload-pack=...`), which execFile cannot prevent on its own.
    if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..") || /^[-+]/.test(branch)) {
      respond(null, `Invalid branch name: ${branch}`);
      return;
    }

    // Verify it's a git repo
    try {
      await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: source });
    } catch {
      respond(null, `Not a git repository: ${source}`);
      return;
    }

    const repoDir = join(this.instanceDir, "repos");
    mkdirSync(repoDir, { recursive: true });
    const safeName = `${basename(source)}-${branch.replace(/\//g, "-")}`;
    const worktreePath = join(repoDir, safeName);

    try {
      // Resolve branch/ref to verify it exists. Use `--` so git never treats
      // branch as an option flag (defense in depth on top of the regex above).
      await execFileAsync("git", ["rev-parse", "--verify", "--", branch], { cwd: source });
      await execFileAsync("git", ["worktree", "add", "--detach", worktreePath, branch], { cwd: source });
      const { stdout: commitHash } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: worktreePath });
      respond({ path: worktreePath, branch, source, commit: commitHash.trim() });
    } catch (err) {
      respond(null, `Failed to checkout: ${(err as Error).message}`);
    }
  }

  private async handleReleaseRepo(
    args: Record<string, unknown>,
    respond: (result: unknown, error?: string) => void,
  ): Promise<void> {
    const repoPath = args.path as string;
    const reposDir = join(this.instanceDir, "repos");

    // Safety: only allow releasing paths under our repos/ directory
    if (!repoPath.startsWith(reposDir)) {
      respond(null, `Cannot release path outside instance repos directory`);
      return;
    }

    try {
      const { execFile: execFileCb } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFileCb);
      await execFileAsync("git", ["worktree", "remove", "--force", repoPath]);
    } catch {
      // Fallback: rm directly if git worktree remove fails
      try { rmSync(repoPath, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    respond({ released: true, path: repoPath });
  }

  private buildSnapshotPrompt(): string | null {
    const snapshotPath = join(this.instanceDir, "rotation-state.json");
    try {
      if (!existsSync(snapshotPath)) return null;
      const snapshot: RotationSnapshot = JSON.parse(readFileSync(snapshotPath, "utf-8"));

      // Mark consumed in-memory to prevent re-injection on crash respawn.
      // Delete file so subsequent daemon restarts don't re-inject stale snapshot.
      this.snapshotConsumed = true;
      try { unlinkSync(snapshotPath); } catch { /* best effort */ }

      const lines: string[] = ["## Previous Session Snapshot", ""];
      lines.push(`Restart reason: ${snapshot.reason}`);
      if (snapshot.context_pct != null) lines.push(`Previous context usage: ${snapshot.context_pct}%`);
      if (snapshot.session_id) lines.push(`Previous session id: ${snapshot.session_id}`);
      lines.push(`Working directory: ${snapshot.working_directory}`);
      lines.push("");

      if (snapshot.recent_user_messages && snapshot.recent_user_messages.length > 0) {
        lines.push("Recent user messages:");
        for (const msg of snapshot.recent_user_messages) {
          lines.push(`- ${msg.text}`);
        }
        lines.push("");
      }

      if (snapshot.recent_events && snapshot.recent_events.length > 0) {
        lines.push("Recent activity:");
        for (const ev of snapshot.recent_events) {
          if (ev.type === "assistant_text") {
            lines.push(`- Assistant: ${ev.preview}`);
          } else {
            lines.push(`- ${ev.name}${ev.preview ? `: ${ev.preview}` : ""}`);
          }
        }
        lines.push("");
      }

      lines.push("Instruction:");
      lines.push("Resume work from this snapshot when relevant. Do not assume anything not stated here.");

      // Enforce 2000-char budget
      let result = lines.join("\n");
      if (result.length > 2000) {
        result = result.slice(0, 1997) + "...";
      }
      return result;
    } catch {
      return null;
    }
  }

}
