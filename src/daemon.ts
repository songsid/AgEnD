import { join, dirname, basename, resolve } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, rmSync, appendFileSync, statSync, chmodSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { InstanceConfig, RotationSnapshot, RotationSnapshotEvent } from "./types.js";
import { rotateLogIfNeeded, type Logger } from "./logger.js";
import { mcpServerState } from "./mcp-liveness.js";
import { clearPausedMarker, writePausedMarker } from "./pause-marker.js";
import { TmuxManager, resolveTmuxLogicalSize } from "./tmux-manager.js";
import { TranscriptMonitor } from "./transcript-monitor.js";
import { createTranscriptSource } from "./transcript-sources.js";
import { ProgressAccumulator, summarizeProgress } from "./tool-progress.js";
import { ContextGuardian } from "./context-guardian.js";
import { IpcServer } from "./channel/ipc-bridge.js";
import { daemonBudgetMs } from "./channel/ipc-timeouts.js";
import { MessageBus } from "./channel/message-bus.js";
import type { CliBackend, CliBackendConfig, ErrorPattern, InstanceState, InstanceStateSnapshot, StartupDialog } from "./backend/types.js";
import { shellQuote } from "./backend/types.js";
import type { ChannelAdapter, InboundMessage } from "./channel/types.js";
import { getTmuxSession } from "./config.js";
import { routeToolCall } from "./channel/tool-router.js";
import { HangDetector } from "./hang-detector.js";
import { writeSecretFile } from "./secret-file.js";
import { PaneWriteLock } from "./pane-write-lock.js";
import type { TmuxControlClient, TmuxPaneOutputEvent } from "./tmux-control.js";
import { buildFleetInstructions } from "./instructions.js";
import type { FleetInstructionsParams } from "./instructions.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Tool routing sets — module-level to avoid re-creation on every handleToolCall
const CROSS_INSTANCE_TOOLS = new Set(["send_to_instance", "list_instances", "start_instance", "restart_instance", "create_instance", "delete_instance", "replace_instance", "request_information", "delegate_task", "report_result", "describe_instance"]);
const SCHEDULE_TOOLS = new Set(["create_schedule", "list_schedules", "update_schedule", "delete_schedule"]);
const DECISION_TOOLS = new Set(["post_decision", "list_decisions", "update_decision"]);
const TASK_TOOL = "task";
// Tools whose success proves the agent got a message out this turn. While any
// of these succeeded, a dead-MCP proxy reply would double-post — suppress it.
const TURN_REPLY_TOOLS = new Set(["reply", "send_to_instance", "report_result", "request_information", "delegate_task", "broadcast"]);

/** Point a resumed CLI at its one backend-native instruction source. */
export function buildInstructionReloadNotice(binaryName: string, instanceName: string, instanceDir: string): string {
  const source = binaryName === "codex" || binaryName === "grok"
    ? "AGENTS.md"
    : binaryName === "kiro-cli"
      ? `.kiro/steering/agend-${instanceName}.md`
      : binaryName === "agy"
        ? ".agents/agents.md"
        : binaryName === "gemini"
          ? "GEMINI.md"
          : join(instanceDir, "fleet-instructions.md");
  return `[system] Your AgEnD instructions have been updated. Reload only ${source}; do not scan other instruction directories. Do not reply to this message.`;
}

export const DEFAULT_STUCK_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_STATE_IDLE_DEBOUNCE_MS = 2_000;
export const DEFAULT_STATE_SAFETY_SWEEP_MS = 60_000;
/** A foreground server/port-forward should hand control back or be acknowledged. */
export const DEFAULT_BLOCKING_PROCESS_GRACE_MS = 2 * 60_000;
const LAST_INBOUND_FILE = "last-inbound-at";

/** Minimum gap between "health check is failing" notifications for one instance. */
const HEALTH_ERROR_NOTIFY_INTERVAL_MS = 10 * 60_000;

/**
 * Whether two working directories belong to the same project, so a fleet-scoped
 * decision recorded in one reaches the other. Covers the worktree/checkout
 * layout AgEnD fleets actually use — `AgEnD`, `AgEnD-dev1`, `AgEnD-dev2`,
 * `AgEnD-reviewer`, `AgEnD-main` are one project; `DouPo_Server` is not.
 * Nesting counts too (a subdirectory of a project belongs to it).
 */
export function sameProjectFamily(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, "");
  const x = norm(a), y = norm(b);
  if (x === y) return true;
  if (x.startsWith(y + "/") || y.startsWith(x + "/")) return true;
  // Strip a trailing worktree/role suffix: "AgEnD-dev2" → "agend".
  const family = (p: string) => {
    const base = p.slice(p.lastIndexOf("/") + 1).toLowerCase();
    return base.replace(/[-_](dev\d*|main|reviewer|tester|leader|sol|codex|worktree|wt\d*)$/i, "");
  };
  const fx = family(x), fy = family(y);
  return fx.length > 0 && fx === fy;
}

/**
 * Pick the decisions worth injecting into one instance's system prompt.
 *
 * `scope: "fleet"` previously bypassed the project check outright, so every
 * instance carried every other project's playbook — measured at 8 of 14 here,
 * resent on every API call. A fleet decision must now also be relevant: global
 * (no project_root), the same project, or the same project family.
 *
 * `isDispatcher` (a general) opts out of that narrowing on purpose: it routes
 * work across all projects, so cross-project rules ("X 文件操作由 Y 負責") are
 * precisely what it must know. Narrowing a general would cause misrouting.
 */
export function selectRelevantDecisions<T extends { scope?: string; project_root?: string; title: string }>(
  all: T[],
  workDir: string,
  isDispatcher = false,
): T[] {
  return all.filter(d => {
    if (d.project_root === workDir) return true;   // own project, any scope
    if (d.scope !== "fleet") return false;         // project-scoped, elsewhere
    if (!d.project_root) return true;              // truly global
    return isDispatcher || sameProjectFamily(d.project_root, workDir);
  });
}

/** Read the last real channel inbound timestamp persisted across daemon restarts. */
export function readLastInboundAt(instanceDir: string, now = Date.now()): number | null {
  try {
    const value = Number(readFileSync(join(instanceDir, LAST_INBOUND_FILE), "utf-8").trim());
    return Number.isFinite(value) && value >= 0 && value <= now ? value : null;
  } catch {
    return null;
  }
}

/** Atomically persist the last real channel inbound timestamp. */
export function writeLastInboundAt(instanceDir: string, timestamp: number): void {
  mkdirSync(instanceDir, { recursive: true });
  const target = join(instanceDir, LAST_INBOUND_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, String(timestamp));
  renameSync(temp, target);
}

/**
 * Render the handoff/routing metadata that rides along with an inbound message
 * into the block actually pasted into the agent's pane.
 *
 * These fields were all populated by the sender (outbound-handlers builds them
 * into `ipcMeta`) and delivered over IPC, but never rendered — so the receiving
 * agent could not see them, and several documented flows could not work:
 *
 * - `report_result` requires a `correlation_id` the agent had no way to know, so
 *   the "correlation_id not recognized" warning fired on essentially every call.
 * - Delegation cancel buttons are retired by correlation id, so they never retired.
 * - `react`, `edit_message` and `reply.reply_to` need `message_id`, which the tool
 *   descriptions tell the agent to take "from the inbound block".
 * - `download_attachment` needs `attachment_file_id`.
 * - `requires_reply` was invisible, so a delegated task looked like an FYI.
 *
 * Only non-empty fields are emitted, so a plain user message gains at most a
 * message_id line.
 */
export function renderHandoffMetadata(meta: Record<string, string>): string {
  const rows: string[] = [];
  const add = (label: string, value: string | undefined) => {
    if (value && value.trim()) rows.push(`${label}: ${value.trim()}`);
  };
  add("message_id", meta.message_id);
  add("correlation_id", meta.correlation_id);
  add("request_kind", meta.request_kind);
  add("task_summary", meta.task_summary);
  add("working_directory", meta.working_directory);
  add("branch", meta.branch);
  add("attachment_file_id", meta.attachment_file_id);
  return rows.length ? `\n(${rows.join(" | ")})` : "";
}

/** Headless inactivity timer used by the daemon and unit tests. */
export class AutoPauseController {
  private pausedAt: number | null = null;

  constructor(
    private thresholdMs: number,
    private lastActivityAt = Date.now(),
  ) {}

  recordActivity(now = Date.now()): void {
    this.lastActivityAt = now;
  }

  /** Apply a new idle threshold and start a fresh countdown from this update. */
  reconfigure(thresholdMs: number, now = Date.now()): void {
    this.thresholdMs = Math.max(0, thresholdMs);
    this.lastActivityAt = now;
  }

  observe(state: InstanceState, now = Date.now()): boolean {
    if (this.pausedAt !== null || this.thresholdMs <= 0) return false;
    // Inactivity is based on the last user inbound, not on how long this daemon
    // has observed the idle pane. This preserves pause eligibility across fleet
    // restarts while still ensuring an actively working instance is never paused.
    return state === "idle" && now - this.lastActivityAt >= this.thresholdMs;
  }

  markPaused(now = Date.now()): void {
    this.pausedAt = now;
  }

  markAwake(now = Date.now()): void {
    this.pausedAt = null;
    // A deliberate wake is activity in its own right and must provide a fresh
    // window for the wake-before-deliver facade to enqueue its inbound message.
    this.lastActivityAt = now;
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
 *
 * ## Why an optional busy pattern exists
 *
 * "Motion wins" degrades badly when a backend's ready marker is *always* on
 * screen. `stuck` requires `!ready`, so for such a backend the state can only ever
 * be idle or working — the stuck edge, and with it `handleStuckTransition` and the
 * hang notification, is unreachable. A frozen CLI is then reported as idle, which
 * also clears pending work: the message the user sent is quietly booked as done.
 *
 * claude-code was exactly this case (see ClaudeCodeBackend.getReadyPattern). A
 * backend that can point at a marker meaning "generating right now" supplies
 * `getBusyPattern()`, and that match vetoes ready regardless of what the ready
 * pattern says.
 */
/**
 * A shell command reduced to the part that is safe to show: the program, and a
 * subcommand when there is one.
 *
 *   curl -H "Bearer sk-ant-…" https://api.com   →  curl
 *   npm test --env=API_KEY=xxx                  →  npm test
 *   git push origin main                        →  git push
 *
 * Arguments are dropped wholesale rather than filtered, because there is no
 * reliable way to tell a secret from an ordinary argument: tokens, bearer
 * headers, connection strings and `--password=` values all look like text. The
 * progress line is posted to a chat channel and, for a public one, so is
 * anything in it — so the rule is "never the arguments", not "not the arguments
 * that look dangerous".
 *
 * A second token is kept only when it is a bare word (`push`, `test`), which is
 * what a subcommand looks like and what a flag, path, URL, assignment or quoted
 * string does not. Everything after it goes, including `git push ORIGIN MAIN`.
 */
export function shellCommandLabel(command: string): string {
  // First line only: heredocs and multi-line scripts carry the payload.
  const tokens = (command.split("\n")[0] ?? "").trim().split(/\s+/).filter(Boolean);
  // `FOO=bar cmd …` — leading assignments are env, and their values are exactly
  // the kind of thing being protected here.
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  const program = tokens[0];
  if (!program) return "";

  const isBareWord = (t: string | undefined): boolean => !!t && /^[A-Za-z][A-Za-z0-9_-]*$/.test(t);
  const label = isBareWord(tokens[1]) ? `${program} ${tokens[1]}` : program;
  return label.length > 40 ? `${label.slice(0, 39)}…` : label;
}

export class PaneStateMachine {
  private readonly readyPattern: RegExp;
  private readonly busyPattern: RegExp | null;
  private lastPaneHash: string | null = null;
  private lastPaneChangeAt: number;
  private lastObservedAt: number;
  private stateChangedAt: number;
  private currentState: InstanceState = "idle";

  constructor(
    readyPattern: RegExp,
    private readonly stuckTimeoutMs = DEFAULT_STUCK_TIMEOUT_MS,
    now = Date.now(),
    busyPattern?: RegExp | null,
  ) {
    // Stateful g/y regexes mutate lastIndex and can alternate true/false across
    // polls. State detection must be deterministic for identical pane content.
    this.readyPattern = new RegExp(readyPattern.source, readyPattern.flags.replace(/[gy]/g, ""));
    this.busyPattern = busyPattern
      ? new RegExp(busyPattern.source, busyPattern.flags.replace(/[gy]/g, ""))
      : null;
    this.lastPaneChangeAt = now;
    this.lastObservedAt = now;
    this.stateChangedAt = now;
  }

  /** Ready, unless the backend can positively see that it is still generating. */
  private isReady(pane: string): boolean {
    if (this.busyPattern?.test(pane)) return false;
    return this.readyPattern.test(pane);
  }

  /**
   * @param now when this observation is being evaluated — drives the idle and
   *   stuck decisions.
   * @param opts.changeAt when the content is believed to have changed, if that
   *   is earlier than `now` (the tmux output timestamp). Only the elapsed-time
   *   clock uses it; defaults to `now`.
   * @param opts.settled the caller knows no output has arrived for the debounce
   *   window, so "the content differs from the last capture" says nothing about
   *   whether the CLI is still generating — decide on the patterns instead.
   *
   *   Captures are event-driven, not periodic: the one taken 2s after output
   *   stops is compared against a capture that may be a minute old, so it
   *   *always* differs. Without this flag that difference reads as "still
   *   working" and a finished turn would not be seen as idle until the next 60s
   *   safety sweep. Output timestamps are the honest liveness signal here, and
   *   the caller has them.
   * @param opts.forceBusy the backend has positively identified a still-running
   *   foreground tool even though its TUI keeps an old ready footer visible.
   */
  observe(
    pane: string,
    now = Date.now(),
    opts: { settled?: boolean; changeAt?: number; forceBusy?: boolean } = {},
  ): InstanceStateSnapshot {
    const { settled = false, changeAt = now, forceBusy = false } = opts;
    const paneHash = createHash("sha256").update(pane).digest("hex");
    const firstObservation = this.lastPaneHash === null;
    const paneChanged = this.lastPaneHash !== paneHash;
    if (paneChanged) {
      this.lastPaneHash = paneHash;
      this.lastPaneChangeAt = changeAt;
    }
    this.lastObservedAt = now;

    // Some TUIs keep their ready footer visible while a foreground tool owns
    // stdin. Backends can positively identify that tool from the pane; in that
    // case the old prompt must not clear pending work or retire Cancel.
    const ready = !forceBusy && this.isReady(pane);
    const nextState: InstanceState = firstObservation
      ? ready ? "idle" : "working"
      : paneChanged && !settled
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

  /** Record pane motion from tmux control mode without capturing pane content. */
  recordOutput(now = Date.now()): InstanceStateSnapshot {
    this.lastPaneChangeAt = now;
    this.lastObservedAt = now;
    if (this.currentState !== "working") {
      this.currentState = "working";
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

const NORMAL_ENTER_SETTLE_MS = 500;
const FIRST_ENTER_SETTLE_MS = 1_750;
const FIRST_DELIVERY_WINDOW_MS = 5_000;
/** After busy native-queue paste+Enter, wait before checking the pane for silent loss. */
const NATIVE_QUEUE_PASTE_VERIFY_MS = 2_000;
/** Enter-confirmation poll: 10 × 200ms ≈ 2s of observed silence before giving up. */
const CONFIRM_BUSY_POLLS = 10;
const CONFIRM_BUSY_POLL_MS = 200;
/**
 * Ceiling on the whole confirmation, including time re-earned after a control-mode
 * reconnect. Without it a reconnect loop could restart the poll indefinitely and
 * hold the pane write lock along with it.
 */
const CONFIRM_BUSY_MAX_WAIT_MS = 10_000;
/**
 * How long a delivery waits for an in-flight spawn. Comfortably past the default
 * 25s startup timeout plus dialog dismissal; past it we fall back to the old
 * behaviour rather than holding a message indefinitely.
 */
const SPAWN_SETTLE_MAX_WAIT_MS = 60_000;

/**
 * One-shot timing gate for the first paste after a CLI reaches its ready
 * prompt. A TUI that is still completing its first redraw can swallow Enter.
 *
 * Since the adaptive settle (see {@link waitForPasteSettle}) this value is the
 * *fallback* wait — it governs only deliveries where the pane's output cannot
 * be observed (no control mode, native-queue handoff, mid-wait reconnect, or a
 * paste that never visibly renders).
 */
export class FirstDeliveryDelay {
  private readyAt = 0;
  private pending = false;

  recordReady(now = Date.now()): void {
    this.readyAt = now;
    this.pending = true;
  }

  consume(now = Date.now()): number {
    if (!this.pending) return NORMAL_ENTER_SETTLE_MS;
    this.pending = false;
    return this.readyAt > 0 && now - this.readyAt < FIRST_DELIVERY_WINDOW_MS
      ? FIRST_ENTER_SETTLE_MS
      : NORMAL_ENTER_SETTLE_MS;
  }
}

/** Output must stay quiet this long after a paste before Enter is sent. */
const PASTE_QUIET_MS = 500;
/** Hard ceiling on the adaptive settle, measured from the paste itself. */
const PASTE_SETTLE_CAP_MS = 3_000;
const PASTE_SETTLE_POLL_MS = 100;

/** The slice of TmuxControlClient the adaptive paste settle reads. */
export interface PasteSettleObservation {
  getLastOutputAt(windowId: string): number | undefined;
  getObservationResetAt(): number;
}

export interface PasteSettleResult {
  /** Actual paste→Enter wait, measured from when the settle wait began. */
  settleMs: number;
  /** Whether the pane visibly reacted to the paste at all. */
  observedPostPasteOutput: boolean;
  /** True when the hard cap ended the wait while output was still flowing. */
  capHit: boolean;
  /** True when the fixed fallback delay governed the wait instead of quiet. */
  usedFallback: boolean;
}

/**
 * Wait until the pane has finished reacting to a paste before Enter is sent.
 *
 * A fixed post-paste delay is a bet that the TUI has consumed the paste by the
 * time it expires. The first delivery after CLI startup is where that bet loses
 * (#309): the TUI's first render is its slowest, and an Enter that lands while
 * it is still chewing on the bracketed paste is absorbed by its paste handling
 * instead of submitting. (Investigated as a tmux 3.7b regression; the 3.6b→3.7b
 * source diff shows no timing change on the paste path, so the race is ours to
 * absorb — and observing the pane beats guessing regardless of tmux version.)
 *
 * So: watch `lastOutputAt` and send Enter only once the paste's own render has
 * been quiet for {@link PASTE_QUIET_MS}. Bounded both ways —
 *
 * - never earlier than the legacy fixed delay when the paste produces no
 *   observable output at all (`usedFallback`), so panes that don't echo keep
 *   their long-standing behaviour;
 * - never later than {@link PASTE_SETTLE_CAP_MS} after the paste (`capHit`),
 *   so a chatty pane cannot stall delivery.
 *
 * A control-mode reconnect during the wait wipes the output timeline; "quiet"
 * is then indistinguishable from "blind", so the wait degrades to the fixed
 * fallback delay rather than trusting evidence it no longer has.
 */
export async function waitForPasteSettle(
  client: PasteSettleObservation,
  windowId: string,
  pasteStartedAt: number,
  fallbackMs: number,
): Promise<PasteSettleResult> {
  const settleStart = Date.now();
  const fallbackDeadline = settleStart + fallbackMs;
  const capDeadline = pasteStartedAt + PASTE_SETTLE_CAP_MS;
  let observed = false;

  for (;;) {
    const now = Date.now();

    if (client.getObservationResetAt() > pasteStartedAt) {
      const remaining = fallbackDeadline - now;
      if (remaining > 0) await new Promise(r => setTimeout(r, remaining));
      return { settleMs: Date.now() - settleStart, observedPostPasteOutput: observed, capHit: false, usedFallback: true };
    }

    const last = client.getLastOutputAt(windowId);
    if (last != null && last > pasteStartedAt) {
      observed = true;
      if (now - last >= PASTE_QUIET_MS) {
        return { settleMs: now - settleStart, observedPostPasteOutput: true, capHit: false, usedFallback: false };
      }
    } else if (now >= fallbackDeadline) {
      return { settleMs: now - settleStart, observedPostPasteOutput: false, capHit: false, usedFallback: true };
    }

    if (now >= capDeadline) {
      return { settleMs: now - settleStart, observedPostPasteOutput: observed, capHit: true, usedFallback: false };
    }

    // Sleep to the next decision point, at most one poll tick — so the normal
    // paths return at their exact deadlines instead of a poll-width late.
    let wake = capDeadline;
    if (last != null && last > pasteStartedAt) wake = Math.min(wake, last + PASTE_QUIET_MS);
    else wake = Math.min(wake, fallbackDeadline);
    await new Promise(r => setTimeout(r, Math.min(PASTE_SETTLE_POLL_MS, Math.max(1, wake - now))));
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

/**
 * Distill a pane capture into text worth relaying as a proxy reply.
 *
 * Used when the MCP server died and the turn ended with no reply: the agent's
 * final answer exists only on screen. Everything up to and including the last
 * line of the inbound message we pasted is cut (the reply starts after it),
 * lines with no letters or digits are dropped (borders, separators, spinners,
 * bare prompts), and the ready-prompt line is dropped by pattern. Returns null
 * when what remains is trivial — a proxy message must carry an answer, not
 * chrome. Secrets are redacted by sanitizePaneTail, same as stuck diagnostics.
 */
export function extractProxyReplyText(pane: string, opts: {
  inboundMarker?: string;
  readyPattern?: RegExp | null;
  maxLines?: number;
  maxChars?: number;
} = {}): string | null {
  const lines = sanitizePaneTail(pane, opts.maxLines ?? 40);
  const marker = opts.inboundMarker?.trim();
  // Require a distinctive marker: a short one ("ok") would match agent text.
  if (marker && marker.length >= 8) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes(marker)) { lines.splice(0, i + 1); break; }
    }
  }
  const ready = opts.readyPattern
    ? new RegExp(opts.readyPattern.source, opts.readyPattern.flags.replace(/[gy]/g, ""))
    : null;
  const kept = lines.filter(line => {
    const t = line.trim();
    if (!t) return true; // keep paragraph breaks; collapsed below
    if (!/[\p{L}\p{N}]/u.test(t)) return false;
    if (ready && ready.test(line)) return false;
    return true;
  });
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  // Trivial = nothing an operator could read as an answer.
  const meaningful = text.replace(/[^\p{L}\p{N}]/gu, "");
  if (meaningful.length < 2) return null;
  const maxChars = opts.maxChars ?? 3000;
  // The end of the turn is the answer — when over budget, keep the tail.
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

export type InteractivePromptKind = "sudo_password" | "password" | "confirmation" | "press_enter";

export interface InteractivePromptDetection {
  kind: InteractivePromptKind;
  prompt: string;
}

const INTERACTIVE_PROMPT_PATTERNS: ReadonlyArray<{
  kind: InteractivePromptKind;
  pattern: RegExp;
}> = [
  { kind: "sudo_password", pattern: /^\s*\[sudo\]\s+password\s+for\s+[^:\n]+:\s*$/im },
  // macOS sudo and several package installers use this exact no-echo prompt.
  // Tail-only + stability gating is what makes the otherwise-generic word safe.
  { kind: "password", pattern: /^\s*(?:Password|Passphrase):\s*$/im },
  { kind: "confirmation", pattern: /^[^\n]{0,180}(?:\([Yy]\/[Nn]\)|\[[Yy]\/[Nn]\]|\((?:yes|no)\/(?:yes|no)\))\s*:?\s*$/im },
  { kind: "confirmation", pattern: /^\s*Are you sure[^\n]{0,160}\((?:yes\/no)(?:\/\[[^\]]+\])?\)\??\s*$/im },
  { kind: "press_enter", pattern: /^\s*(?:Please\s+)?Press (?:the )?Enter(?: key)?(?: to [^\n]{0,120})?[.:…]?\s*$/im },
];

/**
 * Detect terminal prompts that require a human, but only after the pane tail is
 * unchanged and no control-mode output has arrived for the full grace period.
 * This prevents prose such as "the installer asks [Y/n]" from notifying while
 * an agent is still writing it.
 */
export class InteractivePromptDetector {
  private signature: string | null = null;
  private stableSince = 0;
  private lastOutputAt = 0;
  private notifiedSignature: string | null = null;

  constructor(private readonly stableMs = 10_000) {}

  observe(pane: string, now = Date.now(), outputAt = 0): InteractivePromptDetection | null {
    const tail = sanitizePaneTail(pane, 5);
    const tailText = tail.join("\n");
    let matched: { kind: InteractivePromptKind; prompt: string } | null = null;
    for (const candidate of INTERACTIVE_PROMPT_PATTERNS) {
      const match = tailText.match(candidate.pattern);
      if (!match) continue;
      matched = { kind: candidate.kind, prompt: match[0].trim().slice(0, 200) };
      break;
    }

    if (!matched) {
      this.reset();
      this.lastOutputAt = outputAt;
      return null;
    }

    const signature = `${matched.kind}:${tailText}`;
    const outputMoved = outputAt > this.lastOutputAt;
    if (signature !== this.signature || outputMoved) {
      this.signature = signature;
      this.stableSince = now;
      this.lastOutputAt = outputAt;
      if (signature !== this.notifiedSignature) this.notifiedSignature = null;
      return null;
    }
    this.lastOutputAt = outputAt;
    if (this.notifiedSignature === signature || now - this.stableSince < this.stableMs) return null;
    this.notifiedSignature = signature;
    return matched;
  }

  reset(): void {
    this.signature = null;
    this.stableSince = 0;
    this.notifiedSignature = null;
  }
}

export interface BlockingProcessDetection {
  activity: string;
  evidence: string;
  blockedForMs: number;
}

const BLOCKING_PROCESS_PATTERNS: ReadonlyArray<RegExp> = [
  // kubectl port-forward (including a backgrounded child whose inherited
  // stdout keeps the parent shell tool open).
  /^\s*(?:Forwarding from\s+(?:127\.0\.0\.1|localhost|\[::1\]):\d+\s+->\s+\d+|Handling connection for\s+\d+)\s*$/im,
  // Common development servers. Keep these line-shaped and require an address
  // or port so prose such as "the server is running" does not arm the detector.
  /^\s*(?:(?:INFO:\s*)?Uvicorn running on|Serving HTTP on|Listening on|Server (?:is )?(?:listening|running) (?:at|on)|Application startup complete[^\n]*(?:port|https?:\/\/))[^\n]*(?:https?:\/\/|\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]|port)\b)[^\n]*$/im,
];

/**
 * Detect a foreground shell tool which has become a long-lived server.
 *
 * Unlike the generic pane-stuck clock, this clock deliberately survives new
 * output: access logs and `Handling connection` lines are exactly why a
 * foreground server can remain blocked forever without ever looking silent.
 * Once a server marker is seen, the still-running tool identity is the stable
 * signal; the marker may scroll out of the 32-row pane.
 */
export class BlockingProcessDetector {
  private activity: string | null = null;
  private evidence: string | null = null;
  private detectedAt = 0;
  private notified = false;

  constructor(private readonly graceMs = DEFAULT_BLOCKING_PROCESS_GRACE_MS) {}

  observe(pane: string, activity: string | null, now = Date.now()): BlockingProcessDetection | null {
    const shellActivity = activity && /^(?:shell|bash|exec_command|terminal|command)(?::|$)/i.test(activity);
    if (!shellActivity) {
      this.reset();
      return null;
    }

    if (activity !== this.activity) {
      this.reset();
      this.activity = activity;
    }

    if (!this.evidence) {
      const tail = sanitizePaneTail(pane, 40).join("\n");
      for (const pattern of BLOCKING_PROCESS_PATTERNS) {
        const match = tail.match(pattern);
        if (!match) continue;
        this.evidence = match[0].trim().slice(0, 200);
        this.detectedAt = now;
        break;
      }
    }

    if (!this.evidence || this.notified || now - this.detectedAt < this.graceMs) return null;
    this.notified = true;
    return {
      activity,
      evidence: this.evidence,
      blockedForMs: now - this.detectedAt,
    };
  }

  reset(): void {
    this.activity = null;
    this.evidence = null;
    this.detectedAt = 0;
    this.notified = false;
  }
}

export class Daemon extends EventEmitter {
  private logger: Logger;
  private tmuxSessionName: string;
  private tmux: TmuxManager | null = null;
  private ipcServer: IpcServer | null = null;
  private messageBus: MessageBus;
  private transcriptMonitor: TranscriptMonitor | null = null;
  private guardian: ContextGuardian | null = null;
  private adapter: ChannelAdapter | null = null;
  private pendingIpcRequests = new Map<string, (msg: Record<string, unknown>) => void>();
  // Track chatId/threadId from inbound messages for automatic outbound routing
  private lastChatId: string | undefined;
  private lastThreadId: string | undefined;
  private lastAdapterId: string | undefined;
  // Pending ack: react 🫡 on first transcript activity after receiving a message
  private pendingAckMessage: { chatId: string; messageId: string } | null = null;
  /** Last activity published to the fleet manager; null when nothing is running. */
  private currentActivity: string | null = null;
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
  private lastHealthErrorNotifyAt = 0;
  /** CLI pane availability, independent from the daemon process and tri-state. */
  private processStatus: "running" | "crashed" | "stopped" = "running";
  private spawning = false;
  /**
   * Resolves when the in-flight spawn finishes; null when none is running.
   *
   * `spawning` alone can only be polled. Delivery needs to *wait*, and a boolean
   * poll would either busy-loop or race the flag being cleared.
   */
  private spawnSettled: Promise<void> | null = null;
  private resolveSpawnSettled: (() => void) | null = null;
  private spawnDepth = 0;
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
  /** Fallback safety sweep used only when no shared tmux control client exists. */
  private instanceStateMonitorTimer: ReturnType<typeof setInterval> | null = null;
  private instanceStateIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private instanceStateStuckTimer: ReturnType<typeof setTimeout> | null = null;
  private instanceStateOutputListener: ((event: TmuxPaneOutputEvent) => void) | null = null;
  private instanceStateOutputEventName: string | null = null;
  private instanceStateSafetyListener: (() => void) | null = null;
  private instanceStateLastOutputAt = 0;
  private instanceStateIdleDebounceMs = DEFAULT_STATE_IDLE_DEBOUNCE_MS;
  private instanceStateStuckTimeoutMs = DEFAULT_STUCK_TIMEOUT_MS;
  private instanceStateReadyPattern: RegExp | null = null;
  private instanceStateBusyPattern: RegExp | null = null;
  private instanceStateMonitorActive = false;
  private sessionCheckpointWarningEmitted = false;
  private statePollInFlight = false;
  // ── Dead-MCP proxy reply: per-turn evidence ─────────────────────────────
  // Set when an inbound message lands in the CLI; cleared on the idle edge that
  // ends the turn. With a dead MCP server and no successful channel tool call in
  // between, the agent's answer exists only on screen — the daemon relays it.
  private turnHadInbound = false;
  private turnOutboundDelivered = false;
  private turnCorrelationId: string | undefined;
  private turnInboundMarker: string | undefined;
  private proxyReplySeq = 0;
  private autoPauseController: AutoPauseController;
  private pauseRequested = false;
  /**
   * Sticky "pause as soon as possible" (auth failure). Unlike pauseRequested —
   * which the state monitor clears whenever the pane is not idle — this survives
   * busy/stuck states, because an auth error fires mid-turn and a plain pause()
   * would silently no-op exactly when we most need to stop feeding the CLI.
   */
  private pausePending = false;
  private pauseWakeState: "active" | "pausing" | "paused" | "waking" = "active";
  private pauseWakeTransition: Promise<void> | null = null;
  // Model failover: override model on next spawn when rate-limited
  private modelOverride: string | undefined;
  // Context rotation v3: ring buffers for daemon-side snapshot
  private recentUserMessages: Array<{ text: string; ts: string }> = [];
  private recentEvents: RotationSnapshotEvent[] = [];
  private recentToolActivity: string[] = [];
  private snapshotConsumed = false;
  /** Orders inbound channel messages against each other (queue-depth accounting
   *  and ⏳/👀/✅ reactions live here). It does NOT cover the other writers that
   *  reach the pane — {@link paneWriteLock} does. */
  private pasteLock: Promise<void> = Promise.resolve();
  /**
   * Fleet cancellation epoch. Queue entries retain the epoch they arrived with;
   * advancing it invalidates only work received before the cancel, never a new
   * user message which arrives immediately afterwards.
   */
  private deliveryEpoch = 0;
  /** Mutual exclusion for *every* write into the pane, whichever subsystem it
   *  comes from. See PaneWriteLock for why interleaving is destructive. */
  private readonly paneWriteLock = new PaneWriteLock();
  private pendingInstructionsUpdate: string | undefined;
  private pendingInstructionsNotice = false;
  // Whether the warmup steering-reload notice should be injected after spawn.
  // Set in trySpawn by comparing the freshly-built instructions against the
  // last value the agent was told about (prev-instructions). Skipped when
  // unchanged so agents don't waste 10-30s re-reading identical steering.
  private warmupNeeded = false;
  private lastBuiltInstructions = "";
  private pasteQueueDepth = 0;
  private firstDeliveryDelay = new FirstDeliveryDelay();
  /** Orders /steer pastes against each other. Deliberately NOT pasteLock:
   *  a steer must not queue behind the normal deliveries it exists to
   *  overtake. Pane-level exclusion still comes from paneWriteLock inside
   *  deliverMessage, so a steer and a normal delivery can never interleave
   *  their PTY writes — the steer just doesn't wait for idle. */
  private steerLock: Promise<void> = Promise.resolve();
  /** Tool lines shown in the channel processing bubble for the current turn. */
  private readonly turnProgress = new ProgressAccumulator();
  private lastProgressBroadcast = "";
  private progressBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProgressBroadcastAt = 0;
  // PTY error pattern monitoring
  private errorMonitorTimer: ReturnType<typeof setInterval> | null = null;
  private readonly interactivePromptDetector = new InteractivePromptDetector();
  private readonly blockingProcessDetector = new BlockingProcessDetector();
  /** Same 5-min gate the error monitor uses, so a dead MCP server alerts once. */
  private static readonly MCP_DEATH_COOLDOWN_MS = 5 * 60_000;
  private lastMcpDeathNotifiedAt = 0;
  private mcpDeathNotifiedForPid: number | null = null;
  /**
   * Ceiling on how long a dead MCP server waits for an idle window before the
   * auto-restart fires anyway. A toolless instance cannot reply or report, so
   * whatever a very long turn produces is stranded until the restart happens —
   * past this point interrupting the turn costs less than staying mute.
   */
  private static readonly MCP_RESTART_MAX_WAIT_MS = 30 * 60_000;
  /**
   * Sticky "restart to revive the MCP server as soon as the pane idles" — same
   * shape as pausePending, because the death is usually detected mid-turn when
   * an immediate restart would destroy in-flight work. Cleared when the server
   * turns up alive again (operator restarted, CLI reconnected) before we fire.
   */
  private mcpRestartPending = false;
  private mcpRestartStaleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Prevent in-flight monitor callbacks from re-arming after a pause. */
  private runtimeMonitorsFrozen = false;
  private errorWaitingForRecovery = false; // true = error detected, waiting for ready pattern
  private errorDetectedAt = 0;
  private errorRecoveryDeadlineAt = 0;
  private activeErrorPatternKey: string | null = null;

  /** Whether this instance is in an abnormal error state (auto-pause is normal). */
  get isErrorState(): boolean {
    return this.errorWaitingForRecovery || (this.healthCheckPaused && !this.isPaused) || Daemon.tmuxServerPaused;
  }
  get isPaused(): boolean { return this.pauseWakeState !== "active"; }
  /** Current CLI process state for status surfaces and recovery commands. */
  getProcessStatus(): "running" | "crashed" | "stopped" {
    return this.processStatus;
  }
  get lastPausedAt(): number | null { return this.autoPauseController.lastPausedAt; }
  private getPauseWakeState(): typeof this.pauseWakeState { return this.pauseWakeState; }
  /** Whether this instance is in a crash loop (3+ consecutive crashes). */
  get isCrashLoop(): boolean {
    return this.crashCount >= 3;
  }
  /** The most recent error type detected by the error monitor (e.g. "rate_limit", "auth_error"). */
  get lastErrorType(): string | null {
    return this.lastDetectedErrorType;
  }
  private lastFailoverAt = 0; // cooldown: prevent repeated failover triggers
  private static FAILOVER_COOLDOWN_MS = 5 * 60_000; // 5 minutes
  private lastErrorNotifiedAt = new Map<string, number>(); // per-pattern cooldown for all actions
  private static ERROR_COOLDOWN_MS = 5 * 60_000;
  private static ERROR_RECOVERY_TIMEOUT_MS = 5 * 60_000;

  // Count-based dedup: per error pattern, the number of occurrences already
  // accounted for. A scan counts occurrences across the WHOLE pane; count > this
  // baseline means a NEW error appeared. On recovery we absorb the current count
  // (not reset to 0) so the just-handled error doesn't re-trigger, while a later
  // new error still pushes the count higher. If occurrences scroll out of the
  // capture buffer the count drops — we lower the baseline so a re-occurrence
  // still registers as new (prevents the old hash-dedup's permanent suppression).
  private lastErrorCount = new Map<string, number>();
  private lastDetectedErrorType: string | null = null;

  private static errorPatternKey(ep: ErrorPattern): string {
    return `${ep.type}:${ep.pattern.source}`;
  }

  private clearErrorRecoveryGate(): void {
    this.errorWaitingForRecovery = false;
    this.errorDetectedAt = 0;
    this.errorRecoveryDeadlineAt = 0;
    this.activeErrorPatternKey = null;
  }

  constructor(
    private name: string,
    private config: InstanceConfig,
    private instanceDir: string,
    private topicMode = false,
    private backend?: CliBackend,
    private controlClient?: TmuxControlClient,
    rootLogger?: Logger,
    private runtimeIdentity?: FleetInstructionsParams["runtimeIdentity"],
  ) {
    super();
    if (!rootLogger) throw new Error("Daemon requires a shared root logger");
    this.runtimeIdentity ??= {
      kind: "fleet-topic",
      backend: config.backend ?? backend?.binaryName ?? "unknown",
      model: config.model ?? "default",
    };
    this.logger = rootLogger.child({ instance: name }, { level: config.log_level });
    this.tmuxSessionName = getTmuxSession();
    this.messageBus = new MessageBus();
    this.messageBus.setLogger(this.logger);
    // General is the dispatcher — it must stay warm to route messages, so it is
    // never auto-paused regardless of auto_pause_after.
    const isGeneral = config.general_topic === true || name === "general";
    const autoPauseMinutes = isGeneral ? 0 : (typeof config.auto_pause_after === "number" ? config.auto_pause_after : 0); // default: disabled
    this.autoPauseController = new AutoPauseController(
      Math.max(0, autoPauseMinutes) * 60_000,
      readLastInboundAt(instanceDir) ?? Date.now(),
    );
  }

  async start(): Promise<void> {
    mkdirSync(this.instanceDir, { recursive: true });
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
        const deliveryEpoch = this.captureDeliveryEpoch(msg.delivery_epoch);
        void this.wake().then(() => {
          this.pushChannelMessage(msg.content as string, meta, targetSession, deliveryEpoch);
        }).catch(err => {
          this.logger.error({ err: (err as Error).message }, "Wake failed for inbound delivery");
        });
      } else if (msg.type === "raw_paste") {
        // Paste raw text directly to CLI without [user:] wrapping.
        this.queueRawPaste(msg.content as string, this.captureDeliveryEpoch(msg.delivery_epoch));
      } else if (msg.type === "config_update") {
        this.applyConfigUpdate(msg.config);
      } else if (msg.type === "steer") {
        const meta = (msg.meta ?? {}) as Record<string, string>;
        this.steerMessage(msg.content as string, meta, this.captureDeliveryEpoch(msg.delivery_epoch));
      } else if (msg.type === "btw") {
        const meta = (msg.meta ?? {}) as Record<string, string>;
        this.btwMessage(msg.content as string, meta, this.captureDeliveryEpoch(msg.delivery_epoch));
      } else if (msg.type === "fleet_schedule_trigger") {
        const payload = msg.payload as Record<string, unknown>;
        const meta = msg.meta as Record<string, string>;
        const deliveryEpoch = this.captureDeliveryEpoch(msg.delivery_epoch);
        void this.wake().then(() => this.pushChannelMessage(payload.message as string, meta, undefined, deliveryEpoch)).catch(err => {
          this.logger.error({ err: (err as Error).message }, "Wake failed for scheduled delivery");
        });
      } else if (msg.type === "query_instance_state") {
        void this.respondToInstanceStateQuery(msg, socket);
      }
    });

    // 2. Tmux — ensure session, create window if not alive
    await TmuxManager.ensureSession(this.tmuxSessionName);
    this.tmux = new TmuxManager(
      this.tmuxSessionName,
      "",
      resolveTmuxLogicalSize(this.config.terminal),
    );

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
        // This path only runs when pasteQueueDepth > 0 — i.e. exactly when a real
        // delivery is already in flight or queued. Without the lock the notice and
        // that delivery race into the same pane.
        await this.paneWriteLock.run(async () => {
          await this.tmux?.pasteText(
            buildInstructionReloadNotice(this.backend?.binaryName ?? "unknown", this.name, this.instanceDir),
            this.systemPasteOptions(),
          );
        });
        // Record the value the agent has now been told about so the next
        // unchanged restart skips the reload.
        try { writeFileSync(join(this.instanceDir, "prev-instructions"), this.lastBuiltInstructions); } catch { /* best effort */ }
        this.logger.debug("Warmup sent after idle");
      } catch { /* non-fatal */ }
    })();

    if (!this.config.lightweight) {
      // 3. Pipe-pane for prompt detection. Rotate first so a ballooned log from a
      // previous stuck splash (hundreds of MB of ANSI frames) is truncated before
      // we attach — pipe-pane uses `cat >>` on the same inode, so copytruncate
      // keeps the writer attached after size resets.
      const outputLog = join(this.instanceDir, "output.log");
      rotateLogIfNeeded(outputLog);
      await this.tmux.pipeOutput(outputLog).catch(() => {});

      // 4. Transcript monitor. claude-code is handled inside the monitor
      // (statusline transcript); codex/kiro/opencode read their CLI's own
      // conversation store via a pluggable source. Backends with no known
      // source stay inert exactly as before.
      this.transcriptMonitor = new TranscriptMonitor(
        this.instanceDir,
        this.logger,
        createTranscriptSource(this.config.backend ?? "claude-code", this.config.working_directory),
      );

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
        this.recordRecentEvent({ type: "tool_use", name, preview: this.summarizeTool(name, input) });
        this.recordRecentToolActivity(this.summarizeTool(name, input));
        this.publishActivity(this.summarizeTool(name, input));
        this.recordToolProgress(name, input);
      });
      this.transcriptMonitor.on("tool_result", (name: string, _output: unknown) => {
        this.recordRecentEvent({ type: "tool_result", name });
        // The tool finished; whatever comes next has not started yet. Better to
        // show only elapsed time than to leave a stale "Bash: npm test" on screen.
        this.publishActivity(null);
      });
      this.transcriptMonitor.on("assistant_text", (text: string) => {
        this.logger.debug({ text: text.slice(0, 200) }, "Claude response");
        ackIfPending();
        this.recordRecentEvent({ type: "assistant_text", preview: text.slice(0, 100) });
      });
      this.transcriptMonitor.startPolling();

      // HangDetector is the notification bridge to the fleet manager; pane state
      // transitions below are the sole source of hang events (see hang-detector.ts).
      // `hang_detector.enabled: false` opts out of the notification entirely.
      // NOTE: `hang_detector.timeout_minutes` is NOT read here — the stuck timeout
      // the pane monitor actually uses is resolved separately below. The two have
      // long been separate; documented rather than silently ignored.
      const hangConfig = (this.config as InstanceConfig & {
        hang_detector?: { enabled?: boolean; timeout_minutes?: number };
      }).hang_detector;
      if (hangConfig?.enabled !== false) {
        this.hangDetector = new HangDetector();
      }

      // 8. Context guardian
      const statusFile = join(this.instanceDir, "statusline.json");
      this.guardian = new ContextGuardian(this.config.context_guardian, this.logger, statusFile);
      this.guardian.startWatching();

      this.guardian.on("status_update", () => {
        this.saveSessionId();
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

  /**
   * Detect a CRASHED MCP server and report it once.
   *
   * The MCP server writes its pid to channel.mcp.pid at startup and unlinks it on
   * a clean exit, so "file present + pid dead" specifically means it died without
   * cleaning up (crash / OOM / SIGKILL). A missing file is either "not started
   * yet" or "exited cleanly" — neither is an incident, and an orphan exit implies
   * the CLI itself died, which the crash detector already covers.
   *
   * The daemon deliberately does NOT try to respawn it: MCP is a stdio protocol
   * where the CLI spawns the server and owns its pipes, so a daemon-spawned
   * process would have no client reading it. Only the CLI can restore its own
   * tools — hence notify, and let the operator decide about restarting.
   */
  private checkMcpServerAlive(): void {
    if (this.isPaused) return;
    const status = mcpServerState(this.instanceDir);
    if (status.state === "unknown") return;
    if (status.state === "alive") {
      this.mcpDeathNotifiedForPid = null; // the CLI respawned it — re-arm
      this.clearMcpRestartRequest(); // tools are back — stand down a pending auto-restart
      return;
    }
    // Dead: report once per pid, and at most once per cooldown window.
    if (this.mcpDeathNotifiedForPid === status.pid) return;
    if (Date.now() - this.lastMcpDeathNotifiedAt < Daemon.MCP_DEATH_COOLDOWN_MS) return;
    this.mcpDeathNotifiedForPid = status.pid;
    this.lastMcpDeathNotifiedAt = Date.now();
    const autoRestart = this.config.mcp_auto_restart !== false;
    this.logger.error({ pid: status.pid, autoRestart }, "MCP server process is gone — instance has no agend tools");
    this.emit("mcp_died", { name: this.name, pid: status.pid, autoRestart });
    if (autoRestart) this.armMcpRestartWhenIdle();
  }

  /**
   * Arm an automatic instance restart to revive a dead MCP server. Fires on the
   * next busy→idle edge — or immediately when the pane is already idle, which is
   * the common case for a collab/chat instance parked between messages (no edge
   * would ever come). A turn that outlives MCP_RESTART_MAX_WAIT_MS is
   * force-restarted: see that constant for why staying mute costs more.
   */
  private armMcpRestartWhenIdle(): void {
    if (this.mcpRestartPending) return;
    this.mcpRestartPending = true;
    this.mcpRestartStaleTimer = setTimeout(() => {
      this.mcpRestartStaleTimer = null;
      if (!this.mcpRestartPending || this.runtimeMonitorsFrozen) return;
      this.fireMcpRestartRequest("stale_timeout");
    }, Daemon.MCP_RESTART_MAX_WAIT_MS);
    this.mcpRestartStaleTimer.unref?.();
    if (this.instanceState === "idle" && this.pasteQueueDepth === 0) {
      this.fireMcpRestartRequest("already_idle");
    }
  }

  private fireMcpRestartRequest(trigger: "already_idle" | "idle_edge" | "stale_timeout"): void {
    // A recovery is already reshaping the CLI: crash-loop handling
    // (healthCheckPaused), a respawn in flight (spawning), or a pause
    // (isPaused / frozen monitors). Each of those paths ends in a fresh CLI —
    // and with it a fresh MCP server — or in supervision ending, where a
    // restart on top would fight the recovery. Either way the revival restart
    // is moot: cancel it rather than defer it.
    if (this.healthCheckPaused || this.spawning || this.isPaused || this.runtimeMonitorsFrozen) {
      this.logger.warn({ trigger }, "MCP revival restart cancelled — instance is already pausing/spawning/recovering");
      this.clearMcpRestartRequest();
      return;
    }
    this.clearMcpRestartRequest();
    this.logger.warn({ trigger }, "Requesting instance restart to revive its MCP server");
    this.emit("mcp_restart_requested", { name: this.name, trigger });
  }

  private clearMcpRestartRequest(): void {
    this.mcpRestartPending = false;
    if (this.mcpRestartStaleTimer) {
      clearTimeout(this.mcpRestartStaleTimer);
      this.mcpRestartStaleTimer = null;
    }
  }

  private startHealthCheck(): void {
    if (this.runtimeMonitorsFrozen || this.healthCheckTimer) return;
    const { max_retries, backoff, reset_after } = this.config.restart_policy;
    // Liveness monitoring remains active when automatic restart is disabled;
    // otherwise a dead pane leaves its last idle snapshot cached forever.
    const configuredInterval = this.config.restart_policy.health_check_interval_ms ?? 30_000;
    const healthCheckIntervalMs = Math.min(
      60_000,
      configuredInterval > 0 ? configuredInterval : 30_000,
    );

    const scheduleNext = () => {
      if (this.runtimeMonitorsFrozen || this.healthCheckTimer) return;
      this.healthCheckTimer = setTimeout(async () => {
        this.healthCheckTimer = null;
        if (this.runtimeMonitorsFrozen) return;
        // The whole tick is guarded: an unguarded throw in here (a tmux hiccup,
        // ENOSPC on the crash-history write) became an unhandled rejection, which
        // the CLI turned into stopAll() + exit(1) for the ENTIRE fleet, and it also
        // ended this instance's health loop because scheduleNext() sat after the
        // throwing code. Catch, log, and keep checking.
        try {
          // Instance directory removed externally (e.g. `rm -rf ~/.agend/instances/<name>`).
          // Stop the loop permanently — otherwise every tick triggers a respawn, whose
          // writeRotationSnapshot fails with ENOENT and gets caught as "Failed to respawn",
          // spamming errors every ~30s forever.
          if (!existsSync(this.instanceDir)) {
            this.logger.warn({ instanceDir: this.instanceDir }, "Instance directory missing — stopping health check");
            this.healthCheckPaused = true;
            this.healthCheckTimer = null;
            this.emitSupervisionEnded("instance directory was removed from disk", "Recreate the instance, or delete it from fleet.yaml.");
            return;
          }
          if (!this.tmux || this.spawning || this.healthCheckPaused || Daemon.tmuxServerPaused) {
            scheduleNext();
            return;
          }
          // The CLI owns the MCP server process, so the daemon can only observe it.
          this.checkMcpServerAlive();

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
            // Instance output.log is fed by tmux pipe-pane and was previously never
            // rotated (only fleet.log / daemon.log were). Cap growth every tick.
            if (!this.config.lightweight) {
              rotateLogIfNeeded(join(this.instanceDir, "output.log"));
            }
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
            this.setProcessStatus("stopped");
            this.logger.info("CLI exited normally (code 0) — pausing health check");
            await this.tmux.killWindow();
            this.healthCheckPaused = true;
            this.emitSupervisionEnded(
              "the CLI exited normally (code 0)",
              "Nothing crashed — start it again when you need it.",
              0,
            );
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
                const currentWindowId = this.tmux.getWindowId();
                if (windows.some(w => w.id === currentWindowId)) {
                  // The exact window still exists, so `list-panes` was the query
                  // that glitched. Keep the process/state intact and retry on
                  // the next health tick instead of killing a live Kiro TUI.
                  this.logger.warn(
                    { windowId: currentWindowId },
                    `${cliLabel} pane status unavailable but window is present — deferring crash recovery`,
                  );
                  scheduleNext();
                  return;
                }
                if (windows.some(w => w.name === this.name)) nullReason = "same_name_other_window";
              } catch { nullReason = "query_error"; }
              this.logger.warn({ exitCode, nullReason }, `${cliLabel} window not found (tmux server alive)`);
            }
          } else {
            this.logger.warn({ exitCode }, `${cliLabel} process exited`);
          }
          this.setProcessStatus("crashed");

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
                this.setProcessStatus("running");
                this.logger.info("Recovered from background session conflict");
                this.emit("crash_respawn", this.name);
              } catch (err) {
                this.logger.error({ err: (err as Error).message }, "Recovery from background session conflict failed");
              }
              // Keep the loop alive: every health-check exit must either
              // scheduleNext() or deliberately set healthCheckPaused. This one
              // did neither, so a recovered instance ran UNMONITORED (while
              // isHealthCheckEffectivelyPaused still said monitoring was on)
              // until the next pause→wake cycle or fleet restart. The next tick
              // does the right thing in both outcomes: a healthy new window
              // passes the alive check, and a failed recovery hits the dead
              // window again with backgroundSessionRecoveryAttempted set — so
              // it falls through to the normal crash handling (crash counting,
              // backoff, supervision_ended when retries are exhausted).
              scheduleNext();
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

          if (max_retries <= 0) {
            this.healthCheckPaused = true;
            this.logger.warn(`${cliLabel} window died — automatic restart is disabled`);
            this.emitSupervisionEnded(
              "the CLI died and automatic restart is disabled (restart_policy.max_retries is 0)",
              "Start it manually, or raise max_retries in fleet.yaml.",
            );
            return;
          }

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
            this.healthCheckPaused = true;
            this.emitSupervisionEnded(
              `it crashed ${this.crashCount} times, exceeding restart_policy.max_retries (${max_retries})`,
              "Check the logs for the cause, then restart it.",
            );
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
            this.setProcessStatus("running");
            this.logger.info({ resumed }, `Respawned ${cliLabel} window after crash`);
            this.emit("crash_respawn", this.name);
          } catch (err) {
            this.logger.error({ err }, `Failed to respawn ${cliLabel} window`);
          }

        } catch (err) {
          this.logger.error({ err }, "Health check tick failed — continuing");
          // Surface it to the operator, not just the log — a health check that
          // keeps throwing means this instance is no longer being supervised.
          // Throttled: the tick repeats every ~30s, so an unnotified persistent
          // fault would otherwise post twice a minute forever.
          const now = Date.now();
          if (now - this.lastHealthErrorNotifyAt > HEALTH_ERROR_NOTIFY_INTERVAL_MS) {
            this.lastHealthErrorNotifyAt = now;
            this.emit("health_check_error", {
              name: this.name,
              message: err instanceof Error ? err.message : String(err),
            });
          }
          scheduleNext();
          return;
        }
        scheduleNext();
      }, healthCheckIntervalMs);
    };

    scheduleNext();
  }

  /**
   * Publish pane-process availability separately from idle/working/stuck.
   * A dead remain-on-exit pane still contains the old ready prompt, so allowing
   * the pane monitor to capture it would re-create a false idle state.
   */
  /**
   * Announce that this instance is no longer being supervised.
   *
   * Four health-check exits set `healthCheckPaused = true` and returned without
   * telling anyone: a clean CLI exit, `max_retries <= 0`, crash retries exhausted,
   * and the instance directory being deleted. Only the crash-LOOP case emitted an
   * event, so a fleet could quietly contain a dead instance that still looked fine
   * on the dashboard — while messages routed to it queued or failed with a bare ❌.
   *
   * `crash_loop` already had this treatment; this is the same bridge for the other
   * four, carrying a human-readable cause and the operator's next step.
   */
  private emitSupervisionEnded(reason: string, remedy: string, exitCode?: number): void {
    this.emit("supervision_ended", {
      name: this.name,
      reason,
      remedy,
      ...(exitCode !== undefined ? { exitCode } : {}),
    });
  }

  private setProcessStatus(status: "running" | "crashed" | "stopped"): void {
    if (this.processStatus === status) return;
    this.processStatus = status;
    if (status === "running") {
      // A successful crash respawn is a new pane generation. It is ready by
      // this point, so an error gate inherited from the dead pane must not keep
      // the new process from being monitored.
      this.clearErrorRecoveryGate();
      this.startInstanceStateMonitor();
    } else {
      this.stopInstanceStateMonitor();
      // Force the next ready capture to emit a fresh transition after respawn.
      this.instanceState = "working";
    }
    this.ipcServer?.broadcast({
      type: "instance_process_state",
      instanceName: this.name,
      status,
      observedAt: Date.now(),
    });
    this.emit("instance_process_state", { name: this.name, status });
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
    if (!this.tmux) return;
    if (!this.backend) return; // lightweight mode has no backend
    const readyPattern = this.backend.getReadyPattern();
    const busyPattern = this.backend.getBusyPattern?.() ?? null;

    this.errorMonitorTimer = setInterval(async () => {
      if (!this.tmux || this.spawning) return;
      try {
        const alive = await this.tmux.isWindowAlive();
        if (!alive) return;

        const pane = await this.tmux.capturePane();

        const interactivePrompt = this.interactivePromptDetector.observe(
          pane,
          Date.now(),
          this.instanceStateLastOutputAt,
        );
        if (interactivePrompt) {
          this.logger.warn(interactivePrompt, "Interactive terminal prompt is waiting for human input");
          this.emit("interactive_prompt", { name: this.name, ...interactivePrompt });
          // A prompt is not an error and must not enter the PTY recovery gate.
          // Continue scanning real errors in this same snapshot.
        }

        // If a backend can derive activity from this exact pane, trust its
        // explicit null (tool completed) instead of falling back to a possibly
        // stale transcript activity from the previous scan.
        const paneActivity = this.backend?.getPaneActivity
          ? this.backend.getPaneActivity(pane)
          : this.currentActivity;
        const hasPendingWork = this.pendingWork.hasPendingWork();
        if (!hasPendingWork) this.blockingProcessDetector.reset();
        const blockingProcess = hasPendingWork
          ? this.blockingProcessDetector.observe(pane, paneActivity, Date.now())
          : null;
        if (blockingProcess) {
          // Reuse the hang-notification bridge: it offers explicit Restart/Wait
          // choices and, unlike pty_error, does not retire a still-useful Cancel
          // button merely because a foreground process owns stdin.
          this.logger.warn(blockingProcess, "Foreground process is blocking the agent input loop");
          this.hangDetector?.emit("hang", { unchangedForMs: blockingProcess.blockedForMs });
        }

        // Auto-dismiss runtime dialogs (e.g. Codex rate limit model switch)
        for (const dialog of dialogs) {
          if (!dialog.pattern.test(pane)) continue;
          // These keys go straight into the pane. Sent while a message delivery is
          // mid-transaction, an `Escape` wipes the pasted text and an `Enter`
          // submits it half-composed — the user sees a message that vanished. Skip
          // (not queue) when the pane is busy: this poller runs every 5s, and the
          // dialog will still be on screen next tick.
          const dismissed = await this.paneWriteLock.tryRun(async () => {
            this.logger.info(`Auto-dismissing runtime dialog: ${dialog.description}`);
            const SPECIAL_KEYS = new Set(["Up", "Down", "Enter", "Escape", "Right", "Left"]);
            for (const key of dialog.keys) {
              if (SPECIAL_KEYS.has(key)) {
                await this.tmux!.sendSpecialKey(key as "Enter" | "Escape" | "Up" | "Down" | "Right" | "Left");
              } else {
                await this.tmux!.pasteText(key, this.systemPasteOptions());
              }
              await new Promise(r => setTimeout(r, 200));
            }
          });
          if (!dismissed) {
            this.logger.debug({ dialog: dialog.description }, "Dialog dismissal deferred — pane write in flight");
          }
          return; // Dialog handled (or deliberately deferred): skip error checks this cycle
        }

        this.evaluateErrorPatterns(pane, patterns, readyPattern, Date.now(), busyPattern);
      } catch {
        // capturePane can fail if window is transitioning — ignore
      }
    }, 5_000); // Check every 5 seconds (runtime dialogs need fast response)
  }

  /** Evaluate one pane snapshot. Kept synchronous so state-machine edges are unit-testable. */
  private evaluateErrorPatterns(
    pane: string,
    patterns: ErrorPattern[],
    readyPattern: RegExp,
    now = Date.now(),
    busyPattern: RegExp | null = null,
  ): void {
    // Count occurrences across the WHOLE pane (not just text after the last
    // ready prompt). Clone with `g` so stateful backend regexes cannot leak
    // lastIndex between monitor cycles.
    const countMatches = (pattern: RegExp): number => {
      const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
      return (pane.match(new RegExp(pattern.source, flags)) || []).length;
    };
    // Same veto as the state machine: a backend whose ready marker is permanently
    // on screen would otherwise "recover" on the very first tick after the error,
    // rebaselining the occurrence count while the error is still displayed — one
    // notification, a false recovery log, then silence.
    const looksReady = (): boolean => !busyPattern?.test(pane) && readyPattern.test(pane);

    // State: waiting for recovery. A missing/outdated ready pattern must not
    // suppress every future error forever, so the gate has a hard deadline.
    if (this.errorWaitingForRecovery) {
      if (looksReady()) {
        const downtime = Math.round((now - this.errorDetectedAt) / 1000);
        // Re-baseline EVERY pattern, not just the one that fired. Patterns
        // legitimately overlap — kiro prints one header ("having trouble
        // responding") above the specific cause — and only the first match is
        // reported before the `break`, leaving the others at a stale baseline.
        // Rebasing just the active one meant the first scan after recovery saw
        // count > seen on the very text we already reported and fired a second,
        // contradictory notification ("Rate limit") for an incident the user had
        // just been told about. Recovery means the pane is now history, so all
        // of it is history. Deliberately NOT done at detection time: a pattern
        // skipped for cooldown must keep its count unconsumed so it can still
        // fire once that cooldown expires.
        for (const ep of patterns) {
          const seen = countMatches(ep.pattern);
          // Only patterns actually present in the pane. Storing zeros would be a
          // no-op for detection (count 0 === absent) but grows the map with an
          // entry per pattern per recovery.
          if (seen > 0) this.lastErrorCount.set(Daemon.errorPatternKey(ep), seen);
        }
        this.clearErrorRecoveryGate();
        this.logger.info({ downtime_s: downtime }, "PTY error recovered — agent is ready again");
        this.emit("pty_recovered", { name: this.name, downtime_s: downtime });
        return;
      }
      if (now <= this.errorRecoveryDeadlineAt) return;

      // Re-arm the active occurrence as a reminder. Without lowering its
      // baseline, clearing the gate alone would still leave count === seen and
      // could never satisfy the promised post-timeout re-notification.
      const active = patterns.find(ep => Daemon.errorPatternKey(ep) === this.activeErrorPatternKey);
      if (active) {
        const key = Daemon.errorPatternKey(active);
        const count = countMatches(active.pattern);
        if (count > 0) this.lastErrorCount.set(key, count - 1);
      }
      this.logger.warn({ errorType: this.lastDetectedErrorType }, "PTY error recovery deadline expired — resuming error scan");
      this.clearErrorRecoveryGate();
    }

    // State: monitoring — count-based new-error detection over the full pane.
    for (const ep of patterns) {
      const key = Daemon.errorPatternKey(ep);
      const count = countMatches(ep.pattern);
      const seen = this.lastErrorCount.get(key) ?? 0;

      if (count <= seen) {
        // Occurrences scrolled out of the capture buffer → lower the baseline
        // so a future re-occurrence still counts as new (no permanent suppress).
        if (count < seen) this.lastErrorCount.set(key, count);
        continue;
      }

      // count > seen → a NEW occurrence of this exact pattern appeared.
      // Leave a cooldown-suppressed count unconsumed so it can fire once the
      // cooldown expires, but continue scanning unrelated patterns this cycle.
      if (!ep.skipCooldown) {
        const lastNotified = this.lastErrorNotifiedAt.get(key) ?? 0;
        if (now - lastNotified < Daemon.ERROR_COOLDOWN_MS) {
          this.logger.debug({ errorType: ep.type }, "PTY error suppressed (cooldown active)");
          continue;
        }
      }
      if (ep.action === "failover" && now - this.lastFailoverAt < Daemon.FAILOVER_COOLDOWN_MS) {
        this.logger.debug({ errorType: ep.type }, "PTY error suppressed (failover cooldown active)");
        continue;
      }

      this.lastErrorCount.set(key, count);
      // skipRecoveryWait: this error self-recovers (e.g. a timeout — Kiro is
      // back at its prompt immediately). Keep monitoring so the next occurrence
      // can fire without waiting for a possibly startup-only ready pattern.
      if (!ep.skipRecoveryWait) {
        this.errorWaitingForRecovery = true;
        this.errorDetectedAt = now;
        this.errorRecoveryDeadlineAt = now + Daemon.ERROR_RECOVERY_TIMEOUT_MS;
        this.activeErrorPatternKey = key;
        this.lastDetectedErrorType = ep.type;
      }
      this.lastErrorNotifiedAt.set(key, now);
      if (ep.action === "failover") this.lastFailoverAt = now;
      const message = this.resolveErrorMessage(pane, ep);
      this.logger.warn({ errorType: ep.type, action: ep.action }, `PTY error detected: ${message}`);
      this.emit("pty_error", { name: this.name, ...ep, message });

      break; // Only handle first unsuppressed new error per scan
    }
  }

  /**
   * Notification text for a detected pattern. `formatMessage` patterns build it
   * from the match so the user gets the specifics (e.g. which period and what
   * percentage remains) instead of a generic "running low".
   *
   * Uses the LAST match in the pane: an older warning may still be scrolled up
   * (10% earlier, 5% now), and the newest one is the one worth reporting.
   */
  private resolveErrorMessage(pane: string, ep: ErrorPattern): string {
    if (!ep.formatMessage) return ep.message;
    try {
      const flags = ep.pattern.flags.includes("g") ? ep.pattern.flags : ep.pattern.flags + "g";
      const matches = [...pane.matchAll(new RegExp(ep.pattern.source, flags))];
      const last = matches[matches.length - 1];
      return last ? ep.formatMessage(last) : ep.message;
    } catch (err) {
      // A bad formatter must not swallow the notification entirely.
      this.logger.debug({ err, errorType: ep.type }, "formatMessage failed — using static message");
      return ep.message;
    }
  }

  /**
   * Interrupt the CLI's current generation (cancel button / `/cancel`).
   * Direct tmux key event (not a paste) so it registers as the interrupt key.
   * kiro-cli interrupts on Ctrl+C; the others (claude-code, codex, …) on Escape.
   *
   * Deliberately NOT taken through `paneWriteLock`. Cancel is the user's way out
   * of a pane that is busy or wedged — queueing it behind the very delivery chain
   * it exists to unblock would make the button useless exactly when it is needed.
   * The cost is accepted: an Escape landing between a paste and its Enter discards
   * that message, which is what the user asked for anyway.
   */
  async sendEscape(): Promise<void> {
    const cancelKey = this.backend?.getCancelKey() ?? "Escape";
    await this.tmux?.sendSpecialKey(cancelKey as "Enter" | "Escape" | "Up" | "Down" | "Right" | "Left" | "C-c");
  }

  /**
   * Drop every not-yet-started pane delivery which predates a user cancel.
   * Promise chains cannot be removed, so entries become generation-checked
   * no-ops. An entry already past its check is allowed to finish its current PTY
   * transaction; the interrupt key still cancels the CLI generation.
   */
  clearPendingDeliveries(fleetEpoch?: number): void {
    this.deliveryEpoch = fleetEpoch === undefined
      ? this.deliveryEpoch + 1
      : Math.max(this.deliveryEpoch, fleetEpoch);
    this.logger.info({ deliveryEpoch: this.deliveryEpoch }, "Pending delivery queue cleared by user cancel");
  }

  private captureDeliveryEpoch(value: unknown): number {
    const epoch = typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : this.deliveryEpoch;
    if (epoch > this.deliveryEpoch) this.deliveryEpoch = epoch;
    return epoch;
  }

  private isDeliveryEpochCurrent(epoch: number): boolean {
    return epoch === this.deliveryEpoch;
  }

  private queueRawPaste(rawText: string, deliveryEpoch = this.deliveryEpoch): void {
    if (!this.tmux || !this.isDeliveryEpochCurrent(deliveryEpoch)) return;
    this.pasteLock = this.pasteLock.then(async () => {
      if (!this.isDeliveryEpochCurrent(deliveryEpoch)) {
        this.logger.info("Pending raw delivery dropped by user cancel");
        return;
      }
      await this.wake();
      if (!this.isDeliveryEpochCurrent(deliveryEpoch)) return;
      await this.deliverMessage(rawText, undefined, { deliveryEpoch });
      this.logger.debug({ text: rawText.slice(0, 100) }, "Raw paste delivered");
    }).catch(err => {
      this.logger.warn({ err: (err as Error).message }, "raw_paste delivery error");
    });
  }

  /** Send the backend-specific graceful quit command/key sequence. */
  private async sendQuitSequence(): Promise<boolean> {
    if (!this.tmux || !this.backend) return false;

    const quitCmd = this.backend.getQuitCommand();
    const quitKey = this.backend.getQuitKey?.();
    if (quitCmd) {
      await this.tmux.sendKeys(quitCmd);
      // Delay before Enter to prevent tmux server races when instances stop in
      // parallel (same pattern as pasteText).
      await new Promise(r => setTimeout(r, 150));
      await this.tmux.sendSpecialKey("Enter");
      return true;
    }
    if (!quitKey) return false;

    const presses = Math.max(1, Math.floor(this.backend.getQuitKeyPresses?.() ?? 1));
    for (let i = 0; i < presses; i++) {
      await this.tmux.sendSpecialKey(quitKey as "Enter" | "Escape" | "Up" | "Down" | "Right" | "Left" | "C-c" | "C-q");
      if (i + 1 < presses) await new Promise(r => setTimeout(r, 250));
    }
    return true;
  }

  async stop(): Promise<void> {
    this.logger.info("Stopping daemon instance");
    this.freezeRuntimeMonitors();
    this.pendingIpcRequests.clear();
    if (this.adapter) await this.adapter.stop();

    // Notify MCP servers of graceful shutdown (prevents reconnect attempts)
    this.ipcServer?.broadcast({ type: "shutdown" });

    // Quit CLI FIRST — this kills MCP server child processes cleanly.
    // IPC must stay open during quit so MCP servers receive the shutdown message.
    if (this.tmux) {
      this.saveSessionId();
      this.healthCheckPaused = true;
      let killed = false;
      const quitSent = await this.sendQuitSequence();
      if (quitSent) {
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
      const stoppedWindowId = this.tmux.getWindowId();
      await this.tmux.killWindow();
      // The control client is shared across the fleet and outlives this daemon, so
      // a registration left behind here is re-resolved on every reconnect forever.
      if (stoppedWindowId) this.controlClient?.unregisterWindow(stoppedWindowId);
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

  /**
   * Answer a FleetManager state query. Most callers only need the cached state,
   * but lifecycle decisions such as post-reply Cancel retirement need an
   * authoritative pane observation: after startup the last transition can stay
   * "working" even though the CLI has since settled without emitting another
   * control-mode output record.
   */
  private async respondToInstanceStateQuery(
    msg: Record<string, unknown>,
    socket: import("node:net").Socket,
  ): Promise<void> {
    try {
      if (msg.refresh === true) {
        await this.captureAndEvaluateInstanceState("state_query");
      }
      const snapshot = this.getInstanceStateSnapshot();
      this.ipcServer?.send(socket, {
        type: "instance_state_response",
        requestId: msg.requestId,
        instanceName: this.name,
        ...snapshot,
        state: this.isPaused ? "paused" : snapshot.state,
        processStatus: this.processStatus,
        pausedAt: this.lastPausedAt,
      });
    } catch (err) {
      this.logger.debug({ err: (err as Error).message }, "Instance state query failed");
    }
  }

  /** Gracefully stop the CLI while keeping its remain-on-exit tmux window. */
  /**
   * Mark the instance to pause as soon as its pane is idle. Used for auth
   * failures: pause() alone no-ops while the CLI is busy/stuck, which is the
   * usual state when the error surfaces. Cleared by a successful pause or wake.
   */
  requestPauseWhenIdle(): void {
    if (this.pauseWakeState === "paused") return;
    this.pausePending = true;
  }

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
        await this.sendQuitSequence();

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
        writePausedMarker(this.instanceDir, this.lastPausedAt ?? Date.now());
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
    // An explicit wake (e.g. after the user re-logs in) cancels a deferred
    // auth pause — otherwise the instance would pause again the moment it idles.
    this.pausePending = false;
    if (this.pauseWakeState === "active") return;
    if (this.pauseWakeState === "pausing") await this.pauseWakeTransition;
    if (this.getPauseWakeState() === "active") return;
    if (this.pauseWakeState === "waking") {
      await this.pauseWakeTransition;
      return;
    }

    this.pauseWakeState = "waking";
    this.beginSpawn();
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
      // trySpawn resolved only after the new CLI reached its ready prompt.
      // Discard any recovery gate retained while monitors were frozen.
      this.clearErrorRecoveryGate();
      clearPausedMarker(this.instanceDir);
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
      this.endSpawn();
      if (this.pauseWakeTransition === transition) this.pauseWakeTransition = null;
    }
  }

  private applyInstanceStateSnapshot(snapshot: InstanceStateSnapshot, pane?: string): void {
    const previous = this.instanceState;
    this.instanceState = snapshot.state;

    // OpenCode creates its session lazily on the first submitted message.
    // Waiting until stop/pause to persist that id loses resume state when the
    // fleet is SIGKILLed or the host reboots.
    // Idle observations are safe checkpoints; the 60s safety sweep also gives
    // us a bounded retry if session creation produced no visible state edge.
    if (snapshot.state === "idle" && this.backend?.binaryName === "opencode") {
      this.saveSessionId();
    }

    // Only a transition back to idle completes pending work. Repeated idle
    // observations between enqueue and paste must not clear a newer inbound.
    if (snapshot.state === "idle" && previous !== "idle") {
      this.pendingWork.recordIdle(snapshot.observedAt);
      // The turn is over. A transcript can end on a tool_use with no matching
      // tool_result (interrupted, crashed, cancelled), which would otherwise leave
      // the last tool pinned to the progress line for the rest of the session.
      this.publishActivity(null);
      this.resetToolProgress();
      // Must run before the mcpRestartPending branch below: the pane text is the
      // only copy of the answer, and the revival restart is about to clear it.
      this.maybeProxyReplyOnTurnEnd(pane);
    }

    if (snapshot.state !== previous) {
      this.logger.info({
        previousState: previous,
        state: snapshot.state,
        unchangedForMs: snapshot.unchangedForMs,
      }, "Instance execution state changed");
      this.emit("instance_state", { name: this.name, ...snapshot });
      this.ipcServer?.broadcast({ type: "instance_state", instanceName: this.name, ...snapshot });
      if (snapshot.state === "stuck" && pane && this.instanceStateReadyPattern) {
        this.handleStuckTransition(pane, snapshot, this.instanceStateReadyPattern);
      }
    }

    if (snapshot.state !== "idle") this.pauseRequested = false;
    // A pause deferred by an auth failure: retry the moment the pane settles.
    if (this.pausePending && snapshot.state === "idle" && this.pasteQueueDepth === 0) {
      this.pausePending = false;
      this.emit("auto_pause_requested", { name: this.name, idleSince: snapshot.stateChangedAt });
      return;
    }
    // A restart deferred by a dead MCP server: the turn it must not interrupt is
    // over. Skip auto-pause evaluation this tick — the restart supersedes it.
    if (this.mcpRestartPending && snapshot.state === "idle" && this.pasteQueueDepth === 0) {
      this.fireMcpRestartRequest("idle_edge");
      return;
    }
    if (!this.pauseRequested && this.pasteQueueDepth === 0 && this.autoPauseController.observe(snapshot.state)) {
      this.pauseRequested = true;
      this.emit("auto_pause_requested", { name: this.name, idleSince: snapshot.stateChangedAt });
    }
  }

  /**
   * An inbound message is in the CLI — the turn it starts owns the proxy-reply
   * evidence. Called after deliverMessage confirms the paste, not on arrival: a
   * message can arrive mid-turn and sit queued, and marking at arrival would let
   * the PREVIOUS turn's idle edge consume (and reset) the new turn's state.
   */
  private markTurnStarted(meta: Record<string, string>, deliveredText: string): void {
    // Channel turns only. A cross-instance inbound (from_instance, empty
    // chat_id) does not update lastChatId, so its proxy reply would land in
    // whatever USER topic spoke to this instance last — the wrong audience for
    // a task result, and a stale one (sol's review of #515).
    if (meta.from_instance || !meta.chat_id) return;
    this.turnHadInbound = true;
    this.turnOutboundDelivered = false;
    this.turnCorrelationId = meta.correlation_id || undefined;
    // The last non-empty line of what we pasted: everything on screen after it
    // is the agent's own output.
    this.turnInboundMarker = deliveredText.split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop();
  }

  /**
   * Turn ended (busy→idle edge): if the MCP server is dead and none of the
   * channel tools verifiably delivered anything this turn, the agent's answer is
   * stranded on screen — relay it. The daemon's own IPC route to the fleet
   * manager does not pass through the dead MCP server. Consuming the turn state
   * here (edge-triggered, then reset) is what makes it at most once per turn.
   */
  private maybeProxyReplyOnTurnEnd(pane?: string): void {
    const hadInbound = this.turnHadInbound;
    const delivered = this.turnOutboundDelivered;
    const correlationId = this.turnCorrelationId;
    const inboundMarker = this.turnInboundMarker;
    this.turnHadInbound = false;
    this.turnOutboundDelivered = false;
    this.turnCorrelationId = undefined;
    this.turnInboundMarker = undefined;
    if (!hadInbound || delivered || this.isPaused) return;
    // Opt-in: raw pane text can carry secrets past the regex redaction.
    if (this.config.mcp_proxy_reply !== true) return;
    // "dead" only: unknown means not started or exited cleanly — never proxy on it.
    if (mcpServerState(this.instanceDir).state !== "dead") return;
    void this.sendProxyReply(pane, inboundMarker, correlationId);
  }

  /** Relay the pane's final text to the channel, marked as a daemon proxy reply. */
  private async sendProxyReply(pane: string | undefined, inboundMarker: string | undefined, correlationId: string | undefined): Promise<void> {
    try {
      // The idle capture normally hands its pane in; fall back only when the
      // edge came from a path without one.
      if (pane === undefined) pane = await this.tmux?.capturePane();
      if (!pane) return;
      const text = extractProxyReplyText(pane, { inboundMarker, readyPattern: this.instanceStateReadyPattern });
      if (!text) {
        this.logger.debug("Dead-MCP proxy reply skipped — pane tail is trivial");
        return;
      }
      let body = `⚠️ [MCP unavailable — proxy reply]\n\n${text}`;
      if (correlationId) body += `\n\n(correlation_id: ${correlationId})`;
      const args: Record<string, unknown> = { text: body };
      // Same context-bound routing as the reply tool in handleToolCall.
      if (this.lastChatId) {
        args.chat_id = this.lastChatId;
        if (this.lastThreadId) args.thread_id = this.lastThreadId;
      }
      this.logger.warn({ correlationId }, "MCP server dead and the turn sent no reply — relaying the pane text as a proxy reply");
      this.emit("mcp_proxy_reply", { name: this.name, correlationId });
      const adapters = this.messageBus.getAllAdapters();
      if (adapters.length > 0) {
        routeToolCall(adapters[0], "reply", args, this.lastThreadId, (_result, error) => {
          if (error) this.logger.error({ error }, "Dead-MCP proxy reply failed");
        });
        return;
      }
      if (!this.ipcServer) return;
      const fleetReqId = `proxyreply_${++this.proxyReplySeq}`;
      this.ipcServer.broadcast({
        type: "fleet_outbound",
        tool: "reply",
        args,
        fleetRequestId: fleetReqId,
        adapterId: this.lastAdapterId,
      });
      const timeout = setTimeout(() => {
        this.pendingIpcRequests.delete(fleetReqId);
        this.logger.error("Dead-MCP proxy reply timed out waiting for the fleet manager");
      }, daemonBudgetMs("reply"));
      timeout.unref?.();
      this.pendingIpcRequests.set(fleetReqId, (respMsg) => {
        clearTimeout(timeout);
        if (respMsg.error) this.logger.error({ error: respMsg.error }, "Dead-MCP proxy reply failed");
        else this.logger.info("Dead-MCP proxy reply delivered");
      });
    } catch (err) {
      this.logger.error({ err: (err as Error).message }, "Dead-MCP proxy reply attempt failed");
    }
  }

  private clearInstanceStateIdleTimer(): void {
    if (this.instanceStateIdleTimer) clearTimeout(this.instanceStateIdleTimer);
    this.instanceStateIdleTimer = null;
  }

  private clearInstanceStateStuckTimer(): void {
    if (this.instanceStateStuckTimer) clearTimeout(this.instanceStateStuckTimer);
    this.instanceStateStuckTimer = null;
  }

  private scheduleInstanceStateStuckDeadline(changeAt: number): void {
    // Keep one deadline timer per instance. High-volume TUIs can emit hundreds
    // of %output records per second; replacing a long timeout for every chunk
    // would trade tmux subprocess CPU for timer churn.
    if (this.instanceStateStuckTimer) return;
    const delay = Math.max(0, changeAt + this.instanceStateStuckTimeoutMs - Date.now());
    this.instanceStateStuckTimer = setTimeout(() => {
      this.instanceStateStuckTimer = null;
      const latestChangeAt = this.instanceStateLastOutputAt || changeAt;
      if (latestChangeAt + this.instanceStateStuckTimeoutMs > Date.now()) {
        this.scheduleInstanceStateStuckDeadline(latestChangeAt);
        return;
      }
      void this.captureAndEvaluateInstanceState("stuck_deadline", this.instanceStateLastOutputAt);
    }, delay);
  }

  private scheduleInstanceStateIdleCapture(): void {
    if (this.instanceStateIdleTimer) return;
    const expectedOutputAt = this.instanceStateLastOutputAt;
    const delay = Math.max(0, expectedOutputAt + this.instanceStateIdleDebounceMs - Date.now());
    this.instanceStateIdleTimer = setTimeout(() => {
      this.instanceStateIdleTimer = null;
      const latestOutputAt = this.instanceStateLastOutputAt;
      if (latestOutputAt > expectedOutputAt
        && latestOutputAt + this.instanceStateIdleDebounceMs > Date.now()) {
        this.scheduleInstanceStateIdleCapture();
        return;
      }
      void this.captureAndEvaluateInstanceState("idle_debounce", latestOutputAt);
    }, delay);
  }

  private async captureAndEvaluateInstanceState(reason: string, expectedOutputAt = 0): Promise<void> {
    if (!this.instanceStateMonitorActive || this.runtimeMonitorsFrozen || !this.tmux || !this.instanceStateMachine || this.spawning) return;
    if (this.statePollInFlight) {
      if (reason === "idle_debounce") this.scheduleInstanceStateIdleCapture();
      return;
    }
    this.statePollInFlight = true;
    const captureStartedAt = Date.now();
    try {
      const pane = await this.tmux.capturePane();
      // Output received while capture-pane was in flight makes this snapshot
      // stale. Its output handler has already armed a new debounce.
      if ((expectedOutputAt > 0 && this.instanceStateLastOutputAt > expectedOutputAt)
        || (this.instanceStateLastOutputAt > 0 && this.instanceStateLastOutputAt >= captureStartedAt)) return;

      const observedChangeAt = expectedOutputAt || captureStartedAt;
      // One observation per capture. This used to call observe() twice with the
      // same pane: the second call always saw an unchanged pane, so the
      // "content moved → still working" branch could never fire and the state
      // came down to the busy/ready patterns alone. That is why a single
      // mismatched spinner frame was enough to report idle mid-turn.
      const settled = this.instanceStateLastOutputAt === 0
        || captureStartedAt - this.instanceStateLastOutputAt >= this.instanceStateIdleDebounceMs;
      const paneActivity = this.backend?.getPaneActivity?.(pane) ?? null;
      // The two times are genuinely different and both matter: the content
      // changed when tmux reported output (observedChangeAt), but idle/stuck are
      // decisions about *now*. The old double-observe expressed that by calling
      // observe twice, which silently disabled the "content moved" branch.
      const snapshot = this.instanceStateMachine.observe(pane, Date.now(), {
        settled,
        changeAt: observedChangeAt,
        forceBusy: paneActivity !== null,
      });
      this.applyInstanceStateSnapshot(snapshot, pane);

      // Backends without a transcript feed can still say what they are doing, if
      // their TUI names it. Free-riding on a capture that already happened: no
      // extra tmux call. Cadence is the capture cadence (idle debounce + the 60s
      // safety sweep), which matches the progress ticker's own 60s interval.
      if (this.backend?.getPaneActivity) {
        this.publishActivity(snapshot.state === "idle" ? null : paneActivity);
      }

      if (snapshot.state === "idle") {
        this.clearInstanceStateStuckTimer();
      } else if (snapshot.state === "working") {
        // If control mode missed the pane change, the safety capture becomes
        // the new progress timestamp and re-arms both deadlines.
        if (!expectedOutputAt) this.instanceStateLastOutputAt = captureStartedAt;
        this.scheduleInstanceStateStuckDeadline(this.instanceStateLastOutputAt || captureStartedAt);
      }
    } catch (err) {
      this.logger.debug({ err: (err as Error).message, reason }, "Instance state capture failed");
    } finally {
      this.statePollInFlight = false;
    }
  }

  private handleInstancePaneOutput(event: TmuxPaneOutputEvent): void {
    if (!this.instanceStateMonitorActive || this.runtimeMonitorsFrozen) return;
    const windowId = this.tmux?.getWindowId();
    if (!windowId || event.windowId !== windowId || !this.instanceStateMachine) return;
    this.instanceStateLastOutputAt = event.at;
    const snapshot = this.instanceStateMachine.recordOutput(event.at);
    this.applyInstanceStateSnapshot(snapshot);
    this.scheduleInstanceStateIdleCapture();
    this.scheduleInstanceStateStuckDeadline(event.at);
  }

  private bindInstanceStateOutputListener(windowId: string): void {
    if (!this.controlClient || !this.instanceStateMonitorActive) return;
    if (!this.instanceStateOutputListener) {
      this.instanceStateOutputListener = event => this.handleInstancePaneOutput(event);
    }
    if (this.instanceStateOutputEventName) {
      this.controlClient.removeListener(this.instanceStateOutputEventName, this.instanceStateOutputListener);
    }
    this.instanceStateOutputEventName = `output:${windowId}`;
    this.controlClient.on(this.instanceStateOutputEventName, this.instanceStateOutputListener);
  }

  private startInstanceStateMonitor(): void {
    if (this.runtimeMonitorsFrozen || !this.tmux || !this.backend || this.instanceStateMonitorActive) return;

    const rawConfig = (this.config as InstanceConfig & {
      hang_detector?: { timeout_minutes?: number; idle_debounce_ms?: number };
    }).hang_detector;
    const timeoutMinutes = rawConfig?.timeout_minutes;
    this.instanceStateStuckTimeoutMs = typeof timeoutMinutes === "number" && timeoutMinutes > 0
      ? timeoutMinutes * 60_000
      : DEFAULT_STUCK_TIMEOUT_MS;
    this.instanceStateIdleDebounceMs = typeof rawConfig?.idle_debounce_ms === "number" && rawConfig.idle_debounce_ms >= 0
      ? rawConfig.idle_debounce_ms
      : DEFAULT_STATE_IDLE_DEBOUNCE_MS;
    this.instanceStateReadyPattern = this.backend.getReadyPattern();
    this.instanceStateBusyPattern = this.backend.getBusyPattern?.() ?? null;
    this.instanceStateMachine = new PaneStateMachine(
      this.instanceStateReadyPattern,
      this.instanceStateStuckTimeoutMs,
      Date.now(),
      this.instanceStateBusyPattern,
    );
    this.instanceStateLastOutputAt = 0;
    this.instanceStateMonitorActive = true;

    if (this.controlClient) {
      this.instanceStateSafetyListener = () => { void this.captureAndEvaluateInstanceState("safety_sweep"); };
      this.bindInstanceStateOutputListener(this.tmux.getWindowId());
      this.controlClient.on("safety_sweep", this.instanceStateSafetyListener);
    } else {
      // Standalone/test fallback. Fleet production uses the one shared control
      // client and therefore one fleet-level safety sweep instead of N timers.
      this.instanceStateMonitorTimer = setInterval(() => {
        void this.captureAndEvaluateInstanceState("safety_sweep");
      }, DEFAULT_STATE_SAFETY_SWEEP_MS);
    }

    void this.captureAndEvaluateInstanceState("initial");
  }

  private stopInstanceStateMonitor(): void {
    this.instanceStateMonitorActive = false;
    this.clearInstanceStateIdleTimer();
    this.clearInstanceStateStuckTimer();
    if (this.instanceStateMonitorTimer) clearInterval(this.instanceStateMonitorTimer);
    this.instanceStateMonitorTimer = null;
    if (this.controlClient && this.instanceStateOutputListener && this.instanceStateOutputEventName) {
      this.controlClient.removeListener(this.instanceStateOutputEventName, this.instanceStateOutputListener);
    }
    if (this.controlClient && this.instanceStateSafetyListener) {
      this.controlClient.removeListener("safety_sweep", this.instanceStateSafetyListener);
    }
    this.instanceStateOutputListener = null;
    this.instanceStateOutputEventName = null;
    this.instanceStateSafetyListener = null;
  }

  private handleStuckTransition(pane: string, snapshot: InstanceStateSnapshot, readyPattern: RegExp): void {
    const deterministicReadyPattern = new RegExp(readyPattern.source, readyPattern.flags.replace(/[gy]/g, ""));
    const diagnostic = {
      backend: this.backend?.binaryName ?? this.config.backend ?? "unknown",
      paneTail: sanitizePaneTail(pane),
      readyPattern: readyPattern.toString(),
      readyMatched: deterministicReadyPattern.test(pane),
      // A pane that is stuck *while* the ready marker matches means the busy
      // pattern is what held it back — worth seeing when tuning either regex.
      busyPattern: this.instanceStateBusyPattern?.toString(),
      busyMatched: this.instanceStateBusyPattern
        ? new RegExp(this.instanceStateBusyPattern.source, this.instanceStateBusyPattern.flags.replace(/[gy]/g, "")).test(pane)
        : undefined,
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
    // A pause or stop tears the CLI down anyway — the respawn brings a fresh MCP
    // server, so a deferred MCP-revival restart is moot (and its timer must not
    // fire into a stopped daemon).
    this.clearMcpRestartRequest();
    this.interactivePromptDetector.reset();
    this.blockingProcessDetector.reset();
    this.stopInstanceStateMonitor();
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

  /**
   * Tell the fleet manager what this instance is doing right now, for the live
   * progress line on the cancel button.
   *
   * Primarily cosmetic. The foreground-process detector also uses a current
   * shell activity as one of several positive signals, but never makes a state
   * decision from an arbitrary activity label alone.
   *
   * Repeats are dropped: the ticker only edits the channel message when the text
   * changes, and a stream of identical broadcasts would defeat that.
   */
  private publishActivity(activity: string | null): void {
    const next = activity && activity.trim() ? activity.trim() : null;
    if (next === this.currentActivity) return;
    this.currentActivity = next;
    this.ipcServer?.broadcast({
      type: "instance_activity",
      instanceName: this.name,
      activity: next,
    });
  }

  /** Effective tool_progress level, hardened against junk config values.
   *  Off unless explicitly enabled: an update must never make bubbles start
   *  listing tool activity the operator did not ask to broadcast. */
  private toolProgressLevel(): "off" | "standard" | "verbose" {
    const raw = this.config.tool_progress;
    return raw === "standard" || raw === "verbose" ? raw : "off";
  }

  /**
   * Apply a tool-progress setting without restarting the CLI session.
   *
   * Drop the current accumulator at the boundary: verbose entries may contain
   * command previews which must not survive a downgrade to standard/off, and a
   * newly enabled level should start with a clean, internally consistent list.
   */
  updateToolProgress(level: InstanceConfig["tool_progress"]): void {
    const previous = this.toolProgressLevel();
    this.config.tool_progress = level;
    if (this.toolProgressLevel() !== previous) this.resetToolProgress();
  }

  /** Snapshot the configuration actually owned by this live daemon. */
  getConfigSnapshot(): InstanceConfig {
    return structuredClone(this.config);
  }

  /**
   * Apply the whitelisted hot configuration carried by FleetManager IPC.
   * null removes an optional value; invalid/unlisted fields are ignored rather
   * than allowing another client on the per-instance socket to mutate cold
   * process/session settings.
   */
  applyConfigUpdate(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const update = value as Record<string, unknown>;

    if (update.tool_progress === null || ["off", "standard", "verbose"].includes(String(update.tool_progress))) {
      this.updateToolProgress(update.tool_progress === null ? undefined : update.tool_progress as InstanceConfig["tool_progress"]);
    }
    if (typeof update.mcp_proxy_reply === "boolean") this.config.mcp_proxy_reply = update.mcp_proxy_reply;
    else if (update.mcp_proxy_reply === null) delete this.config.mcp_proxy_reply;
    if (typeof update.warm_cap === "number" && Number.isInteger(update.warm_cap) && update.warm_cap >= 0) this.config.warm_cap = update.warm_cap;
    else if (update.warm_cap === null) delete this.config.warm_cap;

    const nextAutoPause = typeof update.auto_pause_after === "number"
      && Number.isFinite(update.auto_pause_after)
      && update.auto_pause_after >= 0
      ? update.auto_pause_after
      : update.auto_pause_after === null ? 0 : undefined;
    if (nextAutoPause !== undefined) {
      const previousAutoPause = typeof this.config.auto_pause_after === "number" ? this.config.auto_pause_after : 0;
      if (update.auto_pause_after === null) delete this.config.auto_pause_after;
      else this.config.auto_pause_after = nextAutoPause;
      if (nextAutoPause !== previousAutoPause) {
        const isGeneral = this.config.general_topic === true || this.name === "general";
        this.autoPauseController.reconfigure((isGeneral ? 0 : nextAutoPause) * 60_000);
      }
    }

    for (const key of ["display_name", "description"] as const) {
      if (typeof update[key] === "string") this.config[key] = update[key] as string;
      else if (update[key] === null) delete this.config[key];
    }
    if (Array.isArray(update.tags) && update.tags.every(tag => typeof tag === "string")) this.config.tags = [...update.tags] as string[];
    else if (update.tags === null) delete this.config.tags;
    if (["trace", "debug", "info", "warn", "error"].includes(String(update.log_level))) {
      const level = update.log_level as InstanceConfig["log_level"];
      if (this.config.log_level !== level) {
        this.config.log_level = level;
        this.logger.level = level;
      }
    }
  }

  /**
   * Accumulate one semantic progress line for the channel bubble and schedule
   * a coalesced broadcast. Separate from publishActivity on purpose: that one
   * is the single-line statusline detail (terse, operator-facing), this is the
   * multi-line channel list (semantic, argument-free at `standard`) — see
   * tool-progress.ts for why the two labellers must not merge.
   */
  private recordToolProgress(name: string, input: unknown): void {
    const level = this.toolProgressLevel();
    if (level === "off") return;
    if (this.turnProgress.add(summarizeProgress(name, input, level))) {
      this.scheduleProgressBroadcast();
    }
  }

  /** Coalesce progress broadcasts: at most one per 3s, trailing edge kept. */
  private scheduleProgressBroadcast(): void {
    const MIN_INTERVAL_MS = 3_000;
    const since = Date.now() - this.lastProgressBroadcastAt;
    if (since >= MIN_INTERVAL_MS) {
      this.broadcastToolProgress();
      return;
    }
    if (this.progressBroadcastTimer) return;
    this.progressBroadcastTimer = setTimeout(() => {
      this.progressBroadcastTimer = null;
      this.broadcastToolProgress();
    }, MIN_INTERVAL_MS - since);
    this.progressBroadcastTimer.unref?.();
  }

  private broadcastToolProgress(): void {
    const rendered = this.turnProgress.render();
    if (rendered === this.lastProgressBroadcast) return;
    this.lastProgressBroadcast = rendered;
    this.lastProgressBroadcastAt = Date.now();
    this.ipcServer?.broadcast({
      type: "instance_progress",
      instanceName: this.name,
      progress: rendered,
    });
  }

  /** New turn (or turn over): drop the list and tell the fleet to clear it. */
  private resetToolProgress(): void {
    if (this.progressBroadcastTimer) {
      clearTimeout(this.progressBroadcastTimer);
      this.progressBroadcastTimer = null;
    }
    this.turnProgress.reset();
    if (this.lastProgressBroadcast !== "") {
      this.lastProgressBroadcast = "";
      this.lastProgressBroadcastAt = Date.now();
      this.ipcServer?.broadcast({ type: "instance_progress", instanceName: this.name, progress: "" });
    }
  }

  /**
   * Options for every system-initiated paste (startup notice, session snapshot,
   * runtime-dialog keys).
   *
   * One place, so the three call sites cannot drift apart on it. Backends with a
   * native input queue do not get the retry Enter: on those, a second bare Enter
   * is not the no-op the retry assumed but a queue mutation — the same reason
   * `deliverMessage` refuses to probe for busy with one.
   */
  private systemPasteOptions(): { retryEnter: boolean } {
    return { retryEnter: this.backend?.supportsQueuedInput?.() !== true };
  }

  private summarizeTool(name: string, input: unknown): string {
    const inp = input as Record<string, unknown> | null;
    if (!inp) return name;
    if (name === "Read") return `Read ${inp.file_path ?? ""}`;
    if (name === "Edit") return `Edit ${inp.file_path ?? ""}`;
    if (name === "Write") return `Write ${inp.file_path ?? ""}`;
    // Command name only — never the arguments. See shellCommandLabel.
    if (name === "Bash") return `$ ${shellCommandLabel(String(inp.command ?? ""))}`;
    if (name === "Glob") return `Glob ${inp.pattern ?? ""}`;
    if (name === "Grep") return `Grep ${inp.pattern ?? ""}`;
    if (name === "Agent") return "Agent (subagent)";
    if (name.startsWith("mcp__agend__")) return ""; // skip channel tools
    return name;
  }

  /**
   * The one place an inbound message grows its metadata wrapper ([user:]/
   * [from:] prefix, pending reactions, handoff metadata, reply instructions).
   * Both the normal queued path (pushChannelMessage) and /steer go through
   * here — a steered message must read EXACTLY like a queued one to the
   * agent, or the two drift apart in what the agent is told about replying.
   */
  private formatInboundMessage(content: string, meta: Record<string, string>): string {
    const user = meta.user || "unknown";
    const fromInstance = meta.from_instance;

    let formatted: string;
    if (fromInstance) {
      // #77: show the sender's display name for readability, keeping the machine
      // instance name in parens so the recipient's send_to_instance target is valid.
      const fromLabel = meta.from_display ? `${meta.from_display} (${fromInstance})` : fromInstance;
      formatted = `[from:${fromLabel}] ${content}`;
      formatted += renderHandoffMetadata(meta);
      // A delegated task that requires a reply must not read like a chatty FYI —
      // the "you may stay silent" line is for the latter only.
      formatted += meta.requires_reply === "true"
        ? "\n(A reply IS required: use report_result with the correlation_id above — or send_to_instance. Not direct text.)"
        : "\n(If you need to reply, use send_to_instance tool, NOT direct text. If there is nothing to add, you may stay silent.)";
    } else {
      const via = meta.source ? ` via ${meta.source}` : "";
      const idTag = meta.user_id ? `, id:${meta.user_id}` : "";
      formatted = `[user:${user}${via}${idTag}] ${content}`;
      // Reactions queued since the last real message (#432). One leading line of
      // context, present only when something is pending — a reaction no longer
      // costs a turn of its own.
      if (meta.pending_reactions) {
        formatted = `[Recent reactions: ${meta.pending_reactions}]\n${formatted}`;
      }
      formatted += renderHandoffMetadata(meta);
      formatted += "\n(Reply using the reply tool — do NOT respond with direct text)";
    }
    if (meta.reply_to_text) {
      formatted += `\n(reply_to: "${meta.reply_to_text}")`;
    }
    return formatted;
  }

  /**
   * /steer: interject into the CURRENT turn instead of queueing for idle.
   *
   * Differences from pushChannelMessage, and nothing else:
   *  - serialized on steerLock, not pasteLock — it must overtake, not queue
   *  - deliverMessage runs with { steer: true }, which takes the busy branch
   *    that pastes immediately (the codex native-queue transaction) instead of
   *    waiting for idle. Verification and silent-loss fallback are the ones
   *    that path already has: pane-capture visibility check, then one
   *    idle-gated redelivery — so on a TUI that swallows busy input the steer
   *    degrades to "next message after this turn", never silently vanishes.
   *
   * The steered text goes through formatInboundMessage so the agent sees a
   * normal inbound message, with a steering notice prepended for context.
   */
  steerMessage(content: string, meta: Record<string, string>, deliveryEpoch = this.deliveryEpoch): void {
    if (!this.isDeliveryEpochCurrent(deliveryEpoch)) return;
    this.updateLastChat(meta.chat_id, meta.thread_id, meta.adapter_id);
    this.pendingWork.recordInbound();
    this.recordRecentUserMessage(content, meta);

    const formatted = "[STEERING — mid-task course correction from the user. Fold this into the CURRENT work.]\n"
      + this.formatInboundMessage(content, meta);
    const chatId = meta.chat_id;
    const messageId = meta.message_id;
    const status = (chatId && messageId)
      ? { chatId: meta.thread_id || chatId, messageId }
      : undefined;

    this.steerLock = this.steerLock.then(async () => {
      if (!this.isDeliveryEpochCurrent(deliveryEpoch)) return;
      await this.wake();
      if (!this.isDeliveryEpochCurrent(deliveryEpoch)) return;
      if (await this.deliverMessage(formatted, status, { steer: true, deliveryEpoch })) {
        this.markTurnStarted(meta, formatted);
      }
    }).catch(err => {
      this.logger.warn({ err: (err as Error).message }, "steer delivery error");
    });
  }

  /**
   * Claude Code /btw: submit a native side-question command immediately while
   * leaving the active turn untouched. It shares the /steer serialization and
   * busy-pane delivery mechanics, but deliberately adds no AgEnD wrapper.
   */
  btwMessage(content: string, meta: Record<string, string>, deliveryEpoch = this.deliveryEpoch): void {
    if (!this.isDeliveryEpochCurrent(deliveryEpoch)) return;
    this.updateLastChat(meta.chat_id, meta.thread_id, meta.adapter_id);
    this.pendingWork.recordInbound();
    this.recordRecentUserMessage(content, meta);

    const command = `/btw ${content}`;
    const chatId = meta.chat_id;
    const messageId = meta.message_id;
    const status = (chatId && messageId)
      ? { chatId: meta.thread_id || chatId, messageId }
      : undefined;

    this.steerLock = this.steerLock.then(async () => {
      if (!this.isDeliveryEpochCurrent(deliveryEpoch)) return;
      await this.wake();
      if (!this.isDeliveryEpochCurrent(deliveryEpoch)) return;
      if (await this.deliverMessage(command, status, { steer: true, deliveryEpoch })) {
        this.markTurnStarted(meta, command);
      }
    }).catch(err => {
      this.logger.warn({ err: (err as Error).message }, "btw delivery error");
    });
  }

  /**
   * Push an inbound channel message to a specific MCP session.
   * If targetSession is provided, only send to the matching socket.
   * Otherwise send to the instance's own session (this.name).
   */
  pushChannelMessage(
    content: string,
    meta: Record<string, string>,
    _targetSession?: string,
    deliveryEpoch = this.deliveryEpoch,
  ): void {
    if (!this.isDeliveryEpochCurrent(deliveryEpoch)) {
      this.logger.info("Pending channel delivery dropped by user cancel");
      return;
    }
    if (!this.tmux) {
      this.logger.warn("Cannot push channel message: tmux not running");
      return;
    }
    // Remember (and persist) the reply target. Only real channel messages have a
    // non-empty chat_id; cross-instance messages have chat_id="" and must NOT
    // overwrite it (their reply would otherwise go nowhere).
    this.updateLastChat(meta.chat_id, meta.thread_id, meta.adapter_id);
    if (meta.chat_id) {
      const inboundAt = Date.now();
      this.autoPauseController.recordActivity(inboundAt);
      try {
        writeLastInboundAt(this.instanceDir, inboundAt);
      } catch (err) {
        this.logger.warn({ err: (err as Error).message }, "Failed to persist last inbound timestamp");
      }
    }
    if (this.pendingInstructionsUpdate) {
      writeFileSync(join(this.instanceDir, "prev-instructions"), this.pendingInstructionsUpdate);
      this.pendingInstructionsUpdate = undefined;
    }
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
        if (!this.isDeliveryEpochCurrent(deliveryEpoch)) return;
        if (await this.deliverMessage(rawText, undefined, { deliveryEpoch })) this.markTurnStarted(meta, rawText);
      }).catch(err => {
        this.logger.warn({ err: (err as Error).message }, "pasteLock raw delivery error");
      });
      return;
    }

    const formatted = this.formatInboundMessage(content, meta);

    // Serialize deliveries: each message waits for the previous to complete,
    // and each waits for the CLI to be idle before pasting. Messages are never
    // dropped for age — only an explicit user Cancel invalidates queued work.
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
        if (!this.isDeliveryEpochCurrent(deliveryEpoch)) {
          this.logger.info("Pending channel delivery dropped by user cancel");
          return;
        }
        if (this.config.pre_task_command) {
          await this.deliverMessage(this.config.pre_task_command, undefined, { deliveryEpoch });
          if (!this.isDeliveryEpochCurrent(deliveryEpoch)) return;
        }
        if (this.pendingInstructionsNotice) {
          this.pendingInstructionsNotice = false;
          await this.deliverMessage(
            buildInstructionReloadNotice(this.backend?.binaryName ?? "unknown", this.name, this.instanceDir),
            undefined,
            { deliveryEpoch },
          );
          if (!this.isDeliveryEpochCurrent(deliveryEpoch)) return;
        }
        const status = (chatId && messageId)
          ? { chatId: meta.thread_id || chatId, messageId }
          : undefined;
        // A fresh delivery begins a fresh turn — its bubble must not inherit
        // the previous turn's tool list.
        this.resetToolProgress();
        if (await this.deliverMessage(formatted, status, { deliveryEpoch })) this.markTurnStarted(meta, formatted);
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
   *   ⏳ message_queued    — CLI busy; queued locally or by the backend
   *   👀 message_delivered — pasted + Enter sent; agent now has it
   *   ✅ message_confirmed — processing observed, or native queue handoff succeeded
   *   ❌ message_failed    — tmux window gone, paste retries exhausted
   * Returns true once the message is in the CLI, false only on real delivery failure.
   *
   * Bug A (silent message loss): paste failures retry with backoff (window recovery)
   * and emit `message_failed` if all attempts fail.
   * Busy handling (UX): backends without a native input queue show ⏳ and wait for
   * idle indefinitely (a genuinely hung CLI is the hang detector's job). Backends
   * that explicitly support queued input receive one complete paste+Enter transaction
   * immediately and own the application-level queue themselves. The pasteLock remains
   * serial in both cases so separate PTY writes can never overlap.
   */
  private async deliverMessage(
    formatted: string,
    status?: { chatId: string; messageId: string },
    opts?: { steer?: boolean; deliveryEpoch?: number },
  ): Promise<boolean> {
    const cancelled = () => opts?.deliveryEpoch !== undefined
      && !this.isDeliveryEpochCurrent(opts.deliveryEpoch);
    if (cancelled()) return false;
    // Sanitize unclosed code fences — they cause CLI to wait for closure on Enter
    const fenceCount = (formatted.match(/```/g) || []).length;
    if (fenceCount % 2 !== 0) {
      // Odd number of fences = unclosed. Remove all code fences from the message.
      formatted = formatted.replace(/```/g, "");
    }

    // Before anything reads the window id: a spawn in progress is about to change it.
    await this.waitForSpawnToSettle();
    if (cancelled()) return false;

    let windowId = this.getWindowId();

    const supportsQueuedInput = this.backend?.supportsQueuedInput?.() === true;
    let handingOffToNativeQueue = false;

    // If the CLI is busy, either hand the complete submission to its native input
    // queue or wait for idle. Native queue support is an explicit backend capability:
    // normal Enter input has steering/interrupt semantics in several other CLIs.
    if (windowId && this.controlClient && !this.controlClient.isIdle(windowId)) {
      if (status) this.emit("message_queued", status);
      if (supportsQueuedInput || opts?.steer) {
        // Native queue (codex), or an explicit /steer: hand the complete
        // paste+Enter transaction to the busy CLI now. For steer this is the
        // point — the user asked to interject, and the transaction's
        // visibility check + idle-gated fallback catch TUIs that swallow
        // busy input (see steerMessage).
        handingOffToNativeQueue = true;
        this.logger.debug(
          opts?.steer ? "CLI busy — steering into the running turn" : "CLI busy — handing message to backend-native input queue",
        );
      } else {
        this.logger.debug("CLI busy — queuing message until idle");
        const becameIdle = await this.controlClient.waitUntilIdle(windowId);
        if (cancelled()) return false;
        if (!becameIdle) {
          // The pane never freed up. Report the failure instead of pasting into a
          // wedged CLI (where the text would sit unsubmitted and the next message
          // would land on top of it) — and instead of holding the queue silently.
          this.logger.error("Pane still busy after the idle wait — reporting delivery failure");
          if (status) this.emit("message_failed", status); // ❌
          return false;
        }
      }
    }

    // Everything above is *waiting*; everything below *writes*. Only the write is
    // held under the pane lock — holding it across the idle wait (up to 30 min)
    // would starve the runtime-dialog dismisser, which is often the very thing
    // that would let the pane go idle again.
    return this.paneWriteLock.run(async () => {
      if (cancelled()) return false;
      return this.writeMessageToPane(formatted, windowId, handingOffToNativeQueue, status);
    });
  }

  /**
   * The write half of a delivery: paste → Enter → confirm, with retries.
   *
   * Always called under {@link paneWriteLock}. Split out from `deliverMessage`
   * precisely so the lock's scope is visible at the call site rather than being
   * an invariant maintained by comments.
   */
  private async sendDeliveryEnter(phase: string): Promise<boolean> {
    const sent = await this.tmux!.sendSpecialKey("Enter");
    if (!sent) {
      this.logger.error({
        phase,
        tmuxError: this.tmux!.getLastSendSpecialKeyError() ?? "unknown tmux send-keys failure",
      }, "tmux send-keys Enter failed during message delivery");
    }
    return sent;
  }

  private async writeMessageToPane(
    formatted: string,
    initialWindowId: string | undefined,
    handingOffToNativeQueue: boolean,
    status?: { chatId: string; messageId: string },
  ): Promise<boolean> {
    let windowId = initialWindowId;
    // Bug A: paste with backoff. Transient failures are usually a stale window id
    // after a crash/respawn — recover by name and retry (max 3 attempts, 2s apart).
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const pasteStartedAt = Date.now();
      const pasted = await this.tmux!.pasteBuffer(formatted);
      if (!pasted) {
        this.logger.warn({ attempt }, "pasteBuffer failed — recovering window and backing off");
        windowId = (await this.recoverWindow()) ?? windowId;
        if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // Settle the bracketed paste, then submit. When control mode can observe
      // the pane, wait for the paste's own render to go quiet instead of
      // trusting a fixed delay (see waitForPasteSettle). The fixed delays —
      // including the longer one-shot first-delivery value, because the TUI may
      // still be completing its final redraw even though the prompt already
      // matched — remain the fallback when output cannot be observed.
      const fallbackMs = this.firstDeliveryDelay.consume();
      if (fallbackMs > NORMAL_ENTER_SETTLE_MS) {
        this.logger.debug({ fallbackMs }, "First delivery after ready — extending fallback settle delay");
      }
      let settle: PasteSettleResult;
      if (!handingOffToNativeQueue && windowId && this.controlClient) {
        settle = await waitForPasteSettle(this.controlClient, windowId, pasteStartedAt, fallbackMs);
      } else {
        // The codex native-queue handoff keeps its long-standing fixed timing:
        // that paste lands while the CLI is busy generating, so its output never
        // goes quiet and an adaptive wait would only ever hit the cap.
        await new Promise(r => setTimeout(r, fallbackMs));
        settle = { settleMs: fallbackMs, observedPostPasteOutput: false, capHit: false, usedFallback: true };
      }
      let enterAt = Date.now();
      if (!(await this.sendDeliveryEnter("initial-submit"))) {
        if (status) this.emit("message_failed", status); // ❌
        return false;
      }

      // Kiro's legacy TUI can swallow Enter while it is still processing a large
      // paste — not only during the post-ready redraw (#479): on slower hosts it
      // happens on ordinary deliveries too (v2.1.2 stable, WSL2 + tmux 3.4).
      // The busy confirmation below cannot be trusted to catch that: it accepts
      // ANY output after Enter, and the paste's own late render satisfies it, so
      // the message is confirmed ✅ while the text sits unsubmitted. Kiro has no
      // native input queue and a bare Enter is a no-op both at an empty prompt
      // and during generation (both verified live on kiro-cli 2.16.1), so the
      // defensive retry runs on EVERY delivery — which is also what the legacy
      // pasteText path has always done for queue-less backends. enterAt is
      // re-baselined to the second Enter so leftover paste-render output between
      // the two cannot be what "confirms" the submission.
      let enterRetry = false;
      if (this.backend?.requiresDeliveryEnterRetry?.() === true) {
        await new Promise(r => setTimeout(r, 1_000));
        const retryAt = Date.now();
        if (await this.sendDeliveryEnter("queue-less-defensive-retry")) {
          enterAt = retryAt;
          enterRetry = true;
          this.logger.debug("Sent defensive Enter retry (queue-less TUI can swallow the first)");
        }
      }
      this.logger.debug({
        observedPostPasteOutput: settle.observedPostPasteOutput,
        settleMs: settle.settleMs,
        capHit: settle.capHit,
        usedFallback: settle.usedFallback,
        enterRetry,
      }, "Delivery settle telemetry");
      if (status) this.emit("message_delivered", status); // 👀

      // Busy queue-capable CLIs (codex) may accept paste without an idle→busy
      // transition. Do NOT probe for busy — a second bare Enter can mutate the
      // queue. Instead verify the paste actually landed in the pane (TUI redraw
      // can silently swallow it). Idle submissions keep the swallowed-Enter path.
      if (handingOffToNativeQueue) {
        await new Promise(r => setTimeout(r, NATIVE_QUEUE_PASTE_VERIFY_MS));
        if (await this.nativeQueuePasteVisible(formatted)) {
          if (status) this.emit("message_confirmed", status); // ✅ native queue accepted
          return true;
        }

        // Silent loss: fall back once to the normal idle-gated path.
        this.logger.warn("Native-queue paste not visible in pane — retrying via idle-gated delivery");
        if (windowId && this.controlClient) {
          await this.controlClient.waitUntilIdle(windowId);
        }
        const repasted = await this.tmux!.pasteBuffer(formatted);
        if (!repasted) {
          this.logger.error("Idle-gated redelivery paste failed after native-queue silent loss");
          if (status) this.emit("message_failed", status); // ❌
          return false;
        }
        await new Promise(r => setTimeout(r, NORMAL_ENTER_SETTLE_MS));
        const retryAt = Date.now();
        if (!(await this.sendDeliveryEnter("native-queue-idle-redelivery"))) {
          if (status) this.emit("message_failed", status); // ❌
          return false;
        }
        if (windowId && this.controlClient) {
          let becameBusy = await this.confirmBusyAfterEnter(windowId, retryAt);
          if (!becameBusy) {
            this.logger.warn("No idle→busy after idle-gated redelivery — re-sending Enter once");
            const retry2At = Date.now();
            if (!(await this.sendDeliveryEnter("native-queue-idle-redelivery-retry"))) {
              if (status) this.emit("message_failed", status); // ❌
              return false;
            }
            becameBusy = await this.confirmBusyAfterEnter(windowId, retry2At);
          }
          if (becameBusy) {
            if (status) this.emit("message_confirmed", status); // ✅
            return true;
          }
        } else if (await this.nativeQueuePasteVisible(formatted)) {
          if (status) this.emit("message_confirmed", status); // ✅
          return true;
        }
        this.logger.error("Idle-gated redelivery also failed after native-queue silent loss");
        if (status) this.emit("message_failed", status); // ❌
        return false;
      }

      if (windowId && this.controlClient) {
        let becameBusy = await this.confirmBusyAfterEnter(windowId, enterAt);
        if (!becameBusy) {
          this.logger.warn("No idle→busy transition after Enter — re-sending Enter once");
          const retryAt = Date.now();
          if (!(await this.sendDeliveryEnter("idle-to-busy-retry"))) {
            if (status) this.emit("message_failed", status); // ❌
            return false;
          }
          becameBusy = await this.confirmBusyAfterEnter(windowId, retryAt);
        }
        if (becameBusy) {
          if (status) this.emit("message_confirmed", status); // ✅
        } else {
          // Both Enters were swallowed: the text is sitting UNSUBMITTED in the
          // CLI's input box. This used to return true, so the reaction stayed at 👀
          // forever and the next delivery pasted on top — submitting two messages
          // as one. Say so instead.
          this.logger.error("Message pasted but never submitted (no idle→busy after two Enters)");
          if (status) this.emit("message_failed", status); // ❌
          return false;
        }
      } else {
        // No control client to observe output: fall back to the legacy double-Enter.
        await new Promise(r => setTimeout(r, 1000));
        await this.sendDeliveryEnter("unobserved-defensive-retry");
        if (status) this.emit("message_confirmed", status); // ✅ (best-effort)
      }
      return true;
    }

    this.logger.error("Message delivery failed after retries — window not ready");
    if (status) this.emit("message_failed", status); // ❌
    return false;
  }

  /**
   * True when a busy native-queue paste appears to have landed: Codex shows a
   * `↳` queue marker, or a distinctive slice of the pasted text is on screen.
   * Used only to detect silent paste loss — not as a general ready check.
   */
  private async nativeQueuePasteVisible(formatted: string): Promise<boolean> {
    if (!this.tmux) return false;
    try {
      const pane = await this.tmux.capturePane();
      if (pane.includes("↳")) return true;
      for (const line of formatted.split(/\r?\n/)) {
        const t = line.trim();
        if (t.length >= 8 && pane.includes(t)) return true;
      }
      const compact = formatted.replace(/\s+/g, " ").trim();
      if (compact.length >= 8 && pane.includes(compact.slice(0, Math.min(80, compact.length)))) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Re-resolve this instance's tmux window by name (stale id after crash/respawn). */
  private async recoverWindow(): Promise<string | undefined> {
    const previousWindowId = this.tmux?.getWindowId();
    try {
      const windows = await TmuxManager.listWindows(this.tmuxSessionName);
      const match = windows.find(w => w.name === this.name);
      if (!match) return undefined;
      this.tmux = new TmuxManager(
        this.tmuxSessionName,
        match.id,
        resolveTmuxLogicalSize(this.config.terminal),
      );
      writeFileSync(join(this.instanceDir, "window-id"), match.id);
      // The window we were talking to is gone; leaving it registered means the
      // control client re-resolves a dead id — one tmux subprocess — on every
      // reconnect, for the life of the fleet process.
      if (previousWindowId && previousWindowId !== match.id) {
        this.controlClient?.unregisterWindow(previousWindowId);
      }
      await this.controlClient?.registerWindow(match.id);
      this.bindInstanceStateOutputListener(match.id);
      this.logger.info({ windowId: match.id }, "Recovered window ID for message delivery");
      return match.id;
    } catch (retryErr) {
      this.logger.error({ err: retryErr }, "Failed to recover window for message delivery");
      return undefined;
    }
  }

  /**
   * Poll up to ~2s (200ms × 10) for the pane to emit output after `since`.
   *
   * A `false` here is not "no output" — it is read as **"the message was pasted but
   * never submitted"**, which re-sends Enter and then reports ❌ to the user. So a
   * false negative costs a possible double submit and a failure notice for a
   * message that actually arrived.
   *
   * That is exactly what a control-mode reconnect used to produce. `connect()`
   * drops every output timestamp, so `hasOutputSince` answers `false` for a pane
   * that did react — the evidence was thrown away, not absent. Blind time is
   * therefore not counted against the budget: after a reset the poll restarts from
   * the moment observation resumed. A hard wall-clock cap keeps a reconnect loop
   * from extending this forever.
   */
  private async confirmBusyAfterEnter(windowId: string, since: number): Promise<boolean> {
    const client = this.controlClient!;
    const hardDeadline = Date.now() + CONFIRM_BUSY_MAX_WAIT_MS;
    let observedFrom = since;
    let polls = 0;

    while (polls < CONFIRM_BUSY_POLLS) {
      await new Promise(r => setTimeout(r, CONFIRM_BUSY_POLL_MS));
      if (client.hasOutputSince(windowId, observedFrom)) return true;

      const resetAt = client.getObservationResetAt();
      if (resetAt > observedFrom && Date.now() < hardDeadline) {
        this.logger.debug(
          { windowId, resetAt },
          "Control mode reconnected mid-confirmation — restarting the Enter check from when we could see again",
        );
        observedFrom = resetAt;
        polls = 0;
        continue;
      }
      polls++;
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
      // A message that verifiably went out stands down the dead-MCP proxy reply
      // for this turn: the agent proved it can still speak for itself.
      if (!error && result != null && TURN_REPLY_TOOLS.has(tool)) {
        this.turnOutboundDelivered = true;
      }
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
        respond(null, `Task operation timed out after ${daemonBudgetMs(tool) / 1000}s`);
      }, daemonBudgetMs(tool));
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
        respond(null, `Decision operation timed out after ${daemonBudgetMs(tool) / 1000}s`);
      }, daemonBudgetMs(tool));
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
        respond(null, `Schedule operation timed out after ${daemonBudgetMs(tool) / 1000}s`);
      }, daemonBudgetMs(tool));
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
        // Shared table, so delete_instance and the deployment tools get the same
        // budget here as the MCP client expects (the ad-hoc list omitted them).
        const crossTimeoutMs = daemonBudgetMs(tool);
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
        // Discord messages live in the channel/thread id, not the guild id in
        // chat_id. This is required for react/edit as well as reply. In
        // particular, general_topic deliberately has no configured reply thread,
        // so FleetManager cannot reconstruct this address from fleet.yaml.
        if (this.lastThreadId) args.thread_id = this.lastThreadId;
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
      this.ipcServer?.broadcast({
        type: "fleet_outbound",
        tool,
        args,
        fleetRequestId: fleetReqId,
        // Preserve the exact adapter world that supplied the chat context. An
        // instance binding is only a fallback: persisted/runtime context can be
        // from a secondary world, and message ids are not portable across bots.
        adapterId: this.lastAdapterId,
      });
      const timeout = setTimeout(() => {
        this.pendingIpcRequests.delete(outboundKey);
        respond(null, `Fleet outbound timed out after ${daemonBudgetMs(tool) / 1000}s`);
      }, daemonBudgetMs(tool));
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
        // `scope: "fleet"` used to bypass the project check entirely, so a
        // single-project worker inherited every other project's playbook (8 of
        // 14 injected here were foreign) — resent on every API call. Now a
        // fleet decision must also be RELEVANT: global (no project_root), the
        // same project, or the same project family (worktrees/checkouts of one
        // repo). A general is exempt: it dispatches across all projects, so
        // cross-project routing rules are exactly what it needs.
        decisions = selectRelevantDecisions(all, workDir, this.config.general_topic === true);
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
      AGEND_INSTANCE_KIND: this.runtimeIdentity?.kind ?? "fleet-topic",
      AGEND_BACKEND: this.runtimeIdentity?.backend ?? this.config.backend ?? this.backend?.binaryName ?? "unknown",
      AGEND_MODEL: this.runtimeIdentity?.model ?? this.config.model ?? "default",
    };
    // A general is a dispatcher, not a worker: default it to the `general` tool
    // profile instead of `full`. Every tool's schema is resent on every API call,
    // so full (44 tools) costs a general ~22k chars per turn — the single largest
    // slice of its prompt. Explicit config still wins.
    const defaultToolSet = this.config.general_topic ? "general" : undefined;
    const toolSet = this.config.tool_set ?? defaultToolSet;
    if (toolSet) mcpEnv.AGEND_TOOL_SET = toolSet;
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
        runtimeIdentity: this.runtimeIdentity,
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
        runtimeIdentity: this.runtimeIdentity,
        displayName: this.config.display_name,
        description: this.config.description,
        customPrompt: resolvedCustomPrompt,
        workflow: resolvedWorkflow,
        decisions,
      });
    }

    const agentPort = parseInt(process.env.AGEND_PORT ?? "19280", 10);

    const backendName = this.config.backend ?? "claude-code";
    const backendOptions = this.config.backend_options?.[backendName];

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
      effort: (this.config as InstanceConfig & { effort?: string }).effort,
      kiroUi: this.config.kiro_ui,
      skipResume: this.skipResume,
      instructions,
      agentMode: isCliMode ? "cli" : "mcp",
      agentPort: isCliMode ? agentPort : undefined,
      backendOptions,
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
      // Messages can arrive during a restart and be queued on pasteLock before the
      // snapshot lands; both write to the pane, so both go through the same lock.
      await this.paneWriteLock.run(() => this.tmux!.pasteText(`[system:session-snapshot]\n${snapshot}\n\nThis is a background context restore — do NOT reply to or acknowledge this message. Simply resume normal operation when the next user or instance message arrives.`, this.systemPasteOptions()));
      this.logger.info("Injected session snapshot as first message");
      this.emit("snapshot_injected", this.name);
    } catch (err) {
      this.logger.error({ err }, "Snapshot injection failed — session continues without context");
      this.emit("snapshot_failed", this.name);
    }
  }

  /**
   * Depth, not a flag: the wake path marks a spawn and then calls trySpawn, which
   * marks another. With a plain boolean the inner one's completion would clear the
   * latch while the outer spawn was still dismissing dialogs, releasing delivery
   * into exactly the window this exists to close.
   */
  private beginSpawn(): void {
    this.spawnDepth++;
    this.spawning = true;
    if (!this.spawnSettled) {
      this.spawnSettled = new Promise<void>(resolve => { this.resolveSpawnSettled = resolve; });
    }
  }

  private endSpawn(): void {
    this.spawnDepth = Math.max(0, this.spawnDepth - 1);
    if (this.spawnDepth > 0) return; // an enclosing spawn is still running
    this.spawning = false;
    const resolve = this.resolveSpawnSettled;
    this.spawnSettled = null;
    this.resolveSpawnSettled = null;
    resolve?.();
  }

  /**
   * Hold until the CLI has finished starting up.
   *
   * Startup is not a quiet period: `dismissDialogsUntilReady` is clicking through
   * trust prompts and session pickers. A pane showing a modal dialog produces no
   * output, so `waitUntilIdle` reports it idle and a queued message gets pasted
   * *into the dialog* — where the text is discarded and the Enter picks a menu
   * item. The paste and the Enter both "succeed", so this loses the message
   * without even a ❌.
   *
   * The pane write lock (#414) does not cover this: it serialises each key
   * sequence, but it is released between one dialog and the next.
   *
   * Bounded, and called BEFORE the pane lock is taken — waiting on the spawn while
   * holding the lock the spawn itself needs would deadlock.
   */
  private async waitForSpawnToSettle(): Promise<void> {
    const settled = this.spawnSettled;
    if (!settled) return;
    this.logger.debug("Holding delivery until the CLI has finished starting up");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>(resolve => {
      timer = setTimeout(resolve, SPAWN_SETTLE_MAX_WAIT_MS);
      timer.unref?.();
    });
    try {
      await Promise.race([settled, cap]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (this.spawning) {
      this.logger.warn("CLI still starting after the delivery hold — delivering anyway");
    }
  }

  /** Spawn a CLI window. Returns true if --resume was used successfully. */
  private async spawnClaudeWindow(): Promise<boolean> {
    this.beginSpawn();
    let resumedSuccessfully = false;
    try {
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
      this.endSpawn();
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
    const tokenWrite = writeSecretFile(agentTokenPath, agentToken);
    if (!tokenWrite.ok) {
      // Do not fail the spawn over it — an instance that cannot start is worse
      // than one whose token is readable. But say so, loudly: the whole point of
      // this token is that other local processes cannot use it.
      this.logger.error(
        { path: agentTokenPath, mode: tokenWrite.mode?.toString(8), reason: tokenWrite.reason },
        "Agent token file is not owner-only — other local users can impersonate this instance",
      );
    }

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
      // A crash respawn makes a brand new window. The dead one stays registered
      // unless we say so — the respawn branch above already does.
      const retired = this.tmux!.getWindowId();
      windowId = await this.tmux!.createWindow(cmd, resolvedCwd, this.name);
      if (retired && retired !== windowId) this.controlClient?.unregisterWindow(retired);
    }
    writeFileSync(join(this.instanceDir, "window-id"), windowId);

    // Enable remain-on-exit to capture exit codes on crash
    await this.tmux!.setRemainOnExit().catch(err => {
      this.logger.warn({ err }, "Failed to set remain-on-exit — exit codes will not be captured");
    });
    if (reuseWindow && !this.config.lightweight) {
      const outputLog = join(this.instanceDir, "output.log");
      rotateLogIfNeeded(outputLog);
      await this.tmux!.pipeOutput(outputLog).catch(err => {
        this.logger.warn({ err }, "Failed to restore pipe-pane after wake");
      });
    }

    // Register with control client and wait for output + idle
    await this.controlClient?.registerWindow(windowId);
    this.bindInstanceStateOutputListener(windowId);
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
    const ready = await this.dismissDialogsUntilReady(3);
    if (ready) this.firstDeliveryDelay.recordReady();
    return ready;
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
            // Restart is exactly when inbound messages pile up, and nothing gates
            // delivery on `spawning`. Take the pane lock for the key sequence so a
            // queued message cannot be pasted into a half-dismissed trust dialog.
            await this.paneWriteLock.run(async () => {
              for (const key of dialog.keys) {
                if (key === "Up" || key === "Down" || key === "Enter" || key === "Escape") {
                  await this.tmux!.sendSpecialKey(key);
                } else {
                  await this.tmux!.sendKeys(key);
                }
                await new Promise(r => setTimeout(r, 200));
              }
            });
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
    try {
      const sid = this.backend?.getSessionId();
      if (!sid) return;
      const path = join(this.instanceDir, "session-id");
      // Idle observations happen after turns. Avoid needless writes (and mtime
      // churn) while still updating the marker when /new changes the session.
      try {
        if (readFileSync(path, "utf-8").trim() === sid) return;
      } catch { /* first checkpoint */ }
      writeFileSync(path, sid);
      this.sessionCheckpointWarningEmitted = false;
      this.logger.debug("Session id checkpointed");
    } catch (err) {
      // Session discovery is best-effort and must never break the pane state
      // monitor. Existing stop/pause checkpoints get another chance later.
      if (!this.sessionCheckpointWarningEmitted) {
        this.sessionCheckpointWarningEmitted = true;
        this.logger.warn({ err: (err as Error).message }, "Session id checkpoint failed");
      }
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
