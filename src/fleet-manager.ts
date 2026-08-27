import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync, rmSync, readdirSync, renameSync, copyFileSync, chmodSync, statSync, type Dirent } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { getAgendHome, ensureWorkspaceGit } from "./paths.js";
import {
  beginUpdateProgress as persistUpdateProgress,
  clearUpdateMarker,
  isUpdateInProgress,
  readUpdateProgress,
  setUpdateProgressStage,
} from "./update-marker.js";
import { formatUpdateProgress } from "./update-progress.js";
import { sdNotify, sdNotifyBlocking } from "./sd-notify.js";
import { readFleetMemory, type FleetMemory } from "./process-memory.js";
import { ReplyDeduper } from "./reply-dedup.js";
import { isMap, isScalar, parseDocument } from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import type { FleetConfig, RawFleetConfig, InstanceConfig, ChannelConfig, CostGuardConfig, DailySummaryConfig, WebhookConfig, AccessConfig } from "./types.js";

/** Fallback access policy for a channel with no `access:` block — open (no gate). */
const DEFAULT_OPEN_ACCESS: AccessConfig = { mode: "open", allowed_users: [], max_pending_codes: 0, code_expiry_minutes: 0 };
import { isProbeableRouteTarget, type RouteTarget } from "./fleet-context.js";
import { loadFleetConfig, loadRawFleetConfig, DEFAULT_COST_GUARD, DEFAULT_DAILY_SUMMARY, DEFAULT_INSTANCE_CONFIG } from "./config.js";
import { EventLog } from "./event-log.js";
import { AdapterWorld } from "./adapter-world.js";
import { CostGuard, formatCents } from "./cost-guard.js";
import { TmuxManager } from "./tmux-manager.js";
import { AccessManager } from "./channel/access-manager.js";
import { IpcClient } from "./channel/ipc-bridge.js";
import type { AlertData, ChannelAdapter, InboundMessage, InboundReaction, Choice } from "./channel/types.js";
import { createAdapter } from "./channel/factory.js";
import { createBackend } from "./backend/factory.js";
import { isModelCompatible } from "./backend/types.js";
import { createLogger, rotateLogIfNeeded, type Logger } from "./logger.js";
import { processAttachments } from "./channel/attachment-handler.js";
import { routeToolCall } from "./channel/tool-router.js";
import { Scheduler } from "./scheduler/index.js";
import type { Schedule, SchedulerConfig } from "./scheduler/index.js";
import { DEFAULT_SCHEDULER_CONFIG } from "./scheduler/index.js";
import type { FleetContext } from "./fleet-context.js";
import { TopicCommands, saveCommandForBackend, parseSaveFilename, parsePauseWakeCommand, SAVE_FILENAME_RE, resolveInstanceContext, forgetInstanceContext } from "./topic-commands.js";
import type { HangDetector } from "./hang-detector.js";
import { DailySummary } from "./daily-summary.js";
import { WebhookEmitter } from "./webhook-emitter.js";
import { TmuxControlClient } from "./tmux-control.js";
import { safeHandler } from "./safe-async.js";
import { RoutingEngine } from "./routing-engine.js";
import {
  InstanceLifecycle,
  BACKEND_INSTALLATION_INFO,
  checkBinaryInstalled,
  type LifecycleContext,
} from "./instance-lifecycle.js";
import { TopicArchiver, type ArchiverContext } from "./topic-archiver.js";
import { StatuslineWatcher, type StatuslineWatcherContext } from "./statusline-watcher.js";
import { outboundHandlers, type OutboundContext } from "./outbound-handlers.js";
import { handleWebRequest, broadcastSseEvent } from "./web-api.js";
import { handleViewRequest, isViewPath } from "./view-api.js";
import { handleUsageRequest, isUsagePath, usageProviderIdForBackend } from "./usage/usage-api.js";
import { LOGIN_FLOWS, LOGIN_BACKEND_ALIASES, checkAuthStatus, type LoginFlow } from "./login-flows.js";
import { LoginSession } from "./login-manager.js";
import { handleSettingsRequest, type RawConfigPatch } from "./settings-api.js";
import { setLocale, detectLocale, getLocale, t } from "./locale.js";
import { handleAgentRequest, type AgentEndpointContext } from "./agent-endpoint.js";
import { ClassicChannelManager, getClassicBackendChoices, isSelectableClassicBackend, readClassicLastActivityAt } from "./classic-channel-manager.js";
import { validateFleetConfig } from "./config-validator.js";
import type { InstanceState, InstanceStateSnapshot } from "./backend/types.js";
import { readLastInboundAt } from "./daemon.js";
import { clearPausedMarker } from "./pause-marker.js";
import { releaseProcessFleetLock } from "./fleet-lock.js";
import { GENERAL_PAUSE_ERROR, isGeneralInstance } from "./general-instance.js";
import { loadOrCreateWebToken, WEB_TOKEN_INVALID_MESSAGE } from "./web-auth.js";
import { RestartProgress, type RestartProgressTarget } from "./restart-progress.js";
import { collectRedundantInstanceDefaultPaths } from "./fleet-yaml-slim.js";
import {
  canUnlockAdvancedTips,
  DailyTipScheduler,
  selectTip,
  visibleTipLevels,
  type Tip,
} from "./tips.js";

import { getTmuxSession } from "./config.js";

type ManagedSkillRole = "general" | "worker";

export function resolveReplyThreadId(
  argsThreadId: unknown,
  instanceConfig?: InstanceConfig,
): string | undefined {
  if (typeof argsThreadId === "string" && argsThreadId.length > 0) {
    return argsThreadId;
  }
  if (instanceConfig?.general_topic) {
    return undefined;
  }
  return instanceConfig?.topic_id != null ? String(instanceConfig.topic_id) : undefined;
}

/**
 * Pure warm-cap victim selection (extracted for testability). Given the current
 * warm (running) instance names and a cap, return the LRU idle instances to evict
 * so the running count returns to the cap. Skips: the `exclude` instance, any
 * already-evicting, general instances (never evicted), and non-idle instances
 * (working/stuck can't be evicted). Oldest last-inbound is evicted first; a
 * missing timestamp (0) sorts oldest. cap <= 0 (or non-integer) = unlimited → [].
 */
export function selectLruEvictions(
  warm: string[],
  cap: number,
  opts: {
    exclude?: string;
    isEvicting: (name: string) => boolean;
    isGeneral: (name: string) => boolean;
    isIdle: (name: string) => boolean;
    lastInboundAt: (name: string) => number;
  },
): string[] {
  if (!Number.isInteger(cap) || cap <= 0) return [];
  if (warm.length <= cap) return [];
  const candidates = warm.filter(name =>
    name !== opts.exclude
    && !opts.isEvicting(name)
    && !opts.isGeneral(name)
    && opts.isIdle(name));
  candidates.sort((a, b) => opts.lastInboundAt(a) - opts.lastInboundAt(b));
  return candidates.slice(0, warm.length - cap);
}

/** Retry cadence for retiring a cancel button whose delete failed (e.g. a DC
 * forum thread the bot momentarily can't reach). 3 retries × 5min = 15min. */
const CANCEL_BTN_RETRY_INTERVAL_MS = 5 * 60_000;
const CANCEL_BTN_MAX_RETRIES = 3;
/** Backstop: every 5min, retire a button whose instance has gone idle. Catches
 * buttons no clear trigger reached (e.g. a scheduled/HTTP turn that never called
 * reply). 5min (not the old 2s idle-watch) so Thinking isn't misread as idle. */
const CANCEL_BTN_IDLE_CHECK_INTERVAL_MS = 5 * 60_000;
/**
 * A queued turn can produce a very short idle edge while the CLI hands off to
 * the next message. Do not retire the cancel button until that edge remains
 * idle for this long; a working/stuck report during the grace cancels it.
 */
const CANCEL_BTN_IDLE_RETIRE_GRACE_MS = 2_000;
/**
 * How long after a reply an instance gets to resume working before its cancel
 * button is retired. A short turn ends with a reply and never works again → the
 * button disappears ~2 minutes after the answer. A multi-step run replies
 * mid-flight and keeps going → the grace check sees "working" and leaves the
 * button alone (the idle edge retires it when the run really ends).
 */
const REPLY_RETIRE_GRACE_MS = 2 * 60_000;
/** Bound for the daemon to capture the pane and answer a post-reply state query. */
const REPLY_STATE_REFRESH_TIMEOUT_MS = 2_000;
/**
 * The daemon only broadcasts execution state on TRANSITIONS, so a long
 * single-state run sends nothing for hours. The idle backstop therefore pokes a
 * query each tick; a live daemon answers within milliseconds and refreshes the
 * cache. When nothing has refreshed it for this long despite those pokes, the
 * reporting chain (daemon, IPC, or state monitor) is dead and a "working" state
 * from 30 minutes ago proves nothing — the button may be retired.
 */
const STATE_REPORT_STALE_MS = 30 * 60_000;
/**
 * Unconditional ceiling on a cancel button's life. Deliberately far beyond any
 * legitimate run (multi-hour tasks are normal on this fleet): everything below
 * this is decided by real state; a button that somehow survives a full day is
 * wreckage, stuck or not.
 */
const CANCEL_BTN_MAX_LIFETIME_MS = 24 * 60 * 60_000;
/** A click on a button the fleet no longer tracks may fire at most this often. */
const STALE_CANCEL_CLICK_COOLDOWN_MS = 10_000;
/** Orphaned-button ledger, swept at startup. Lives in the fleet data dir. */
const CANCEL_BTN_LEDGER_FILE = "cancel-buttons.json";
/**
 * How often the cancel button's text is refreshed with elapsed working time.
 *
 * One edit per working instance per interval — at 60s that is trivial for both
 * platforms' rate limits, and it reads as a live counter rather than a stale
 * snapshot. Nothing new is posted, so the channel is never spammed: there is
 * exactly one progress message per turn, and it is the cancel button itself.
 */
const PROGRESS_UPDATE_INTERVAL_MS = 60_000;
/** Floor between tool-progress-driven bubble edits (Telegram flood safety). */
const TOOL_PROGRESS_EDIT_MIN_MS = 4_000;
/** Elapsed time is only shown once work has clearly outlasted a quick answer. */
/**
 * Default delay before the button starts showing elapsed time. Configurable via
 * `defaults.progress_min_elapsed` (seconds) in fleet.yaml. 30s is the balance
 * point: most quick answers finish inside it (no churn for ordinary turns),
 * while anything real shows signs of life well before the old two minutes.
 */
const PROGRESS_MIN_ELAPSED_MS = 30_000;
/** How much of a tool summary the progress line will show before eliding. */
const PROGRESS_ACTIVITY_MAX_CHARS = 48;
/**
 * Emoji AgEnD itself stamps on messages as the delivery-status ladder
 * (⏳ queued, 👀 delivered, ✅ confirmed, ❌ failed). These are machine
 * indicators, not opinions, so they never enter the reactions queue — from
 * anyone. This exact-emoji filter is the ONLY bot filtering left: bot-to-bot
 * reactions are otherwise delivered on purpose (agents signal each other), and
 * 🫡 passes too — it reads as a deliberate acknowledgement, not plumbing.
 */
const DELIVERY_STATUS_EMOJIS = new Set(["👀", "⏳", "✅", "❌"]);
/**
 * Reactions that are neither delivery plumbing nor meaningful conversational
 * feedback. Keep this separate from DELIVERY_STATUS_EMOJIS so adding a UI-only
 * emoji never changes the documented delivery-state protocol.
 */
const IGNORED_REACTION_EMOJIS = new Set(["📷"]);

const HOT_INSTANCE_CONFIG_KEYS = new Set<keyof InstanceConfig>([
  "tool_progress",
  "mcp_proxy_reply",
  "auto_pause_after",
  "warm_cap",
  "display_name",
  "description",
  "tags",
  "log_level",
]);

function splitHotColdConfig(config: InstanceConfig): {
  hot: Partial<InstanceConfig>;
  cold: Partial<InstanceConfig>;
} {
  const hot: Partial<InstanceConfig> = {};
  const cold: Partial<InstanceConfig> = {};
  for (const [key, value] of Object.entries(config) as Array<[keyof InstanceConfig, InstanceConfig[keyof InstanceConfig]]>) {
    (HOT_INSTANCE_CONFIG_KEYS.has(key) ? hot : cold)[key] = value as never;
  }
  return { hot, cold };
}

function hotConfigUpdate(config: InstanceConfig): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  for (const key of HOT_INSTANCE_CONFIG_KEYS) update[key] = config[key] ?? null;
  return update;
}
/**
 * How long a delivery waits out a disconnected instance IPC before giving up.
 *
 * Sized for a daemon restart (socket close → respawn → CLI ready), which is the
 * event this exists for. Past it the delivery fails loudly as it always did.
 */
const IPC_RECONNECT_GRACE_MS = 30_000;
const IPC_RECONNECT_POLL_MS = 250;

/** One tracked cancel button. Keyed by messageId in `cancelButtons`, so each
 * button is retired independently — replacing one never strands another. */
interface CancelButtonEntry {
  instanceName: string;
  adapterId?: string;
  chatId: string;
  messageId: string;
  threadId?: string;
  /** Set for cross-instance task/query buttons: the delegate→report correlation
   * id, used to retire the button on report_result (sender/target names are
   * derived by independent paths and don't reliably match). */
  correlationId?: string;
  retryCount: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  /** 5-min idle-check backstop; retires the button once the instance is idle. */
  idleCheckTimer?: ReturnType<typeof setInterval>;
  /** One-shot post-reply check; retires the button unless work resumed. */
  replyGraceTimer?: ReturnType<typeof setTimeout>;
  retiring?: boolean;
  /** When this button was posted; the live progress text counts from here. */
  startedAt?: number;
  /** Periodic in-place text update while the instance is still working (#409). */
  progressTimer?: ReturnType<typeof setInterval>;
  /** Last text written, so an unchanged tick skips the API call. */
  lastProgressText?: string;
  /** Last actual edit, for coalescing tool-progress edits between ticks. */
  lastProgressEditAt?: number;
  /** Pending coalesced tool-progress edit. */
  progressEditTimer?: ReturnType<typeof setTimeout>;
  /** Last non-empty semantic tool list rendered into this bubble. Kept on the
   * entry (rather than only in the per-instance live cache) so the daemon's
   * end-of-turn reset cannot erase the history immediately before retirement. */
  toolProgress?: string;
}

/**
 * Answer shape for `list_models`. `scope` reports where the LIST came from —
 * "instance" only when it was read through that instance's own backend config,
 * "global" for the account/CLI catalog — so a caller can tell an authoritative
 * per-instance list from a best-effort account-wide one.
 */
export interface ModelCatalog {
  backend: string;
  scope: "instance" | "global";
  /** Set whenever an instance was asked about, even if the list is global. */
  instance?: string;
  current_model: string | null;
  models: import("./backend/types.js").ModelOption[];
  /** "cache" = startup probe cache, "live" = probed now, "fallback" = none available. */
  source: "cache" | "live" | "fallback";
  probed_at?: string;
  /** Caveat the caller should read before trusting the list. */
  note?: string;
}

/**
 * One pending nonce-armed button prompt (hang restart offer, interactive-prompt
 * assist, clean-exit restart offer, destructive clear confirmation). They share
 * the same lifecycle:
 * posted with a 128-bit nonce in the callback data and bound to the exact
 * message/world that created them. Destructive prompts are admin-gated; the
 * informational Tip acknowledgement permits any identified click. All expire after
 * a bounded per-prompt timeout, consumed exactly once.
 */
interface NonceButtonEntry {
  /** Callback prefix including the colon, e.g. "exit-restart:". */
  prefix: string;
  instanceName: string;
  adapterId: string;
  adapter: ChannelAdapter;
  chatId: string;
  threadId?: string;
  messageId?: string;
  timer?: ReturnType<typeof setTimeout>;
  /** Text the buttons collapse to when the offer lapses (expiry or instance stop). */
  expiredText: string;
  /** interactive-assist only: the General that will receive the assist request. */
  generalName?: string;
  /** interactive-assist only: detected prompt kind (login/permission/...). */
  promptKind?: string;
  /** clear-confirm only: channel used to re-check fleet/Classic admin rights. */
  authChannelId?: string;
  /** Tip prompts are shared, informational controls any authenticated click may consume. */
  allowAnyUser?: boolean;
  /** tip-dismiss only: stable catalog id written to scheduler.db. */
  tipId?: string;
}

interface AdapterCallbackData {
  callbackData: string;
  chatId: string;
  threadId?: string;
  messageId: string;
  userId?: string;
}

interface ClassicStartSlashData {
  command: string;
  channelId: string;
  channelName: string;
  guildId?: string;
  userId: string;
  username?: string;
  text?: string;
  options?: Record<string, string | boolean>;
  respond: (text: string) => Promise<string | undefined>;
  /** Remove Discord's deferred ephemeral acknowledgement after a command posts publicly. */
  dismissResponse?: () => Promise<void>;
  respondChoices?: (text: string, choices: Choice[]) => Promise<string | undefined>;
}

interface PendingClassicStart {
  channelId: string;
  channelName: string;
  userId: string;
  guildId?: string;
  adapterId?: string;
  messageId?: string;
  timer: ReturnType<typeof setTimeout>;
  complete: (text: string, messageId?: string) => Promise<void>;
}

export interface DeliveryOptions {
  /** Explicitly identify agent-to-agent delivery when metadata is unavailable. */
  isCrossInstance?: boolean;
  /** Force or bypass the idle gate. Schedules set this explicitly. */
  waitForIdle?: boolean;
  /** Test/operational override; normal deliveries use the 60 second backstop. */
  idleTimeoutMs?: number;
}

const CLASSIC_BACKEND_SELECTION_TIMEOUT_MS = 60_000;
const CLASSIC_BACKEND_CALLBACK_PREFIX = "classic-backend:";
const MODEL_SELECT_CALLBACK_PREFIX = "model-select:";
const EFFORT_SELECT_CALLBACK_PREFIX = "effort-select:";
const INTERACTIVE_ASSIST_CALLBACK_PREFIX = "interactive-assist:";
const EXIT_RESTART_CALLBACK_PREFIX = "exit-restart:";
const HANG_CALLBACK_PREFIX = "hang:";
const CLEAR_CONFIRM_CALLBACK_PREFIX = "clear-confirm:";
const TIP_DISMISS_CALLBACK_PREFIX = "tip-dismiss:";
const TIP_UNLOCK_CALLBACK_PREFIX = "tip-unlock:";
const LOGIN_CALLBACK_PREFIX = "login:";
const LOGIN_MENU_CALLBACK_PREFIX = "login-menu:";
const LOGIN_CONFIRM_CALLBACK_PREFIX = "login-confirm:";
const INSTALL_LOGIN_CALLBACK_PREFIX = "install-login:";
const CLEAR_CONFIRM_TIMEOUT_MS = 15_000;
/** Default lifetime for long-lived nonce prompts (clear overrides this to 15s). */
const NONCE_BUTTON_TIMEOUT_MS = 15 * 60_000;
const TIP_BUTTON_TIMEOUT_MS = 24 * 60 * 60_000;
const CLI_ENV_TTL_MS = 24 * 60 * 60 * 1000; // /model reads cached CLI env within 24h

export class FleetManager implements FleetContext, LifecycleContext, ArchiverContext, StatuslineWatcherContext, OutboundContext, AgentEndpointContext {
  private static signalTarget: FleetManager | null = null;
  private static sighupHandlerInstalled = false;

  private children: Map<string, import("node:child_process").ChildProcess> = new Map();
  readonly lifecycle: InstanceLifecycle;
  /** Live view of lifecycle.daemons — used throughout; not deprecated. */
  get daemons() { return this.lifecycle.daemons; }
  fleetConfig: FleetConfig | null = null;
  private rawFleetConfig: RawFleetConfig = {};
  private rawFleetDocument: ReturnType<typeof parseDocument> | null = null;
  private savedFleetConfigSnapshot: FleetConfig | null = null;
  adapter: ChannelAdapter | null = null;
  readonly worlds = new Map<string, AdapterWorld>();
  readonly adapters: Map<string, ChannelAdapter> = new Map(); // derived view for backward compat
  /** Track which world each instance is bound to */
  private instanceWorldBinding = new Map<string, string>();
  // Dedup inbound messages seen by more than one adapter (e.g. two DC bots in the
  // same guild both receive every message). Bounded FIFO of recent message keys.
  private recentMessageIds = new Set<string>();
  private accessManager: AccessManager | null = null;

  /** Primary world (channels[0]), independent of concurrent adapter startup order. */
  get primaryWorld(): AdapterWorld | undefined {
    const adapterId = this.getPrimaryAdapterId();
    return adapterId ? this.worlds.get(adapterId) : undefined;
  }
  readonly routing = new RoutingEngine();
  get routingTable(): Map<string, RouteTarget> { return this.routing.map; }
  instanceIpcClients: Map<string, IpcClient> = new Map();
  scheduler: Scheduler | null = null;
  private configPath: string = "";
  /** SIGHUPs received before startAll finishes are replayed once startup is safe. */
  private startupComplete = false;
  /** Coalesces one or more SIGHUPs into at most one follow-up reconciliation. */
  private reloadPending = false;
  /** A running reconciliation; only one may mutate lifecycle/config state at a time. */
  private reconcileInFlight: Promise<void> | null = null;
  logger: Logger = createLogger("info");
  private topicCommands: TopicCommands;
  // sessionName → instanceName mapping for external sessions
  sessionRegistry: Map<string, string> = new Map();
  eventLog: EventLog | null = null;
  costGuard: CostGuard | null = null;
  private statuslineWatcher: StatuslineWatcher;
  private dailySummary: DailySummary | null = null;
  private dailyTipScheduler: DailyTipScheduler | null = null;
  private webhookEmitter: WebhookEmitter | null = null;

  // Topic icon + auto-archive state
  private topicIcons: { green?: string; blue?: string; red?: string } = {};
  private lastActivity = new Map<string, number>();
  /** Latest pane-derived execution snapshot reported by each daemon. */
  private instanceStateCache = new Map<string, InstanceStateSnapshot & { receivedAt: number }>();
  /** CLI pane status overrides; daemon.pid alone only proves FleetManager lives. */
  private instanceProcessStatus = new Map<string, "crashed" | "stopped">();
  /** Instances currently being auto-paused by warm_cap, so concurrent checks don't double-evict. */
  private warmCapEvicting = new Set<string>();
  /** Per-instance tail keeps cross-instance and scheduled deliveries FIFO. */
  private idleGatedDeliveryTails = new Map<string, Promise<void>>();
  /**
   * Per-instance cancellation epoch for deliveries which have not reached the
   * daemon yet. A cancel advances the epoch; queued work captures the old value
   * and becomes a no-op, while messages arriving after the click capture the new
   * value and remain deliverable.
   */
  private deliveryEpochs = new Map<string, number>();
  /** Non-user work must observe a fresh idle snapshot after the latest delivery. */
  private lastDeliveryAt = new Map<string, number>();
  /** State-cache updates wake event-driven idle waiters without busy polling. */
  private instanceIdleWaiters = new Map<string, Set<() => void>>();
  private lastInboundUser = new Map<string, string>(); // instanceName → last username
  // Active "🛑 Cancel" buttons, tracked per button (keyed by messageId) rather
  // than one-per-instance. A button is retired (deleted, with bounded retry) on
  // reply, on cancel, or when a newer button supersedes it for the same
  // instance. Per-button tracking means a failed delete never strands a button.
  private cancelButtons = new Map<string, CancelButtonEntry>();
  /** Pending idle-edge retirement, one timer per instance. */
  private cancelButtonIdleRetireTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Duplicate-reply suppression across both the MCP and HTTP reply paths. */
  readonly replyDeduper = new ReplyDeduper();
  /** instanceName → what it is doing right now, when the backend can tell us. */
  private instanceActivity = new Map<string, string>();
  /** instanceName → this turn's tool list (multi-line), for the bubble. */
  private instanceProgress = new Map<string, string>();
  /** instanceName → tail of deliveries waiting for its IPC to come back. */
  private ipcWaitTails = new Map<string, Promise<void>>();
  /** instanceName → restart currently executing; concurrent callers join it. */
  private restartsInFlight = new Map<string, Promise<void>>();
  // Last user message delivered to each instance — used to react ✅ on completion.
  private lastInboundMsg = new Map<string, { adapterId?: string; chatId: string; threadId?: string; messageId: string; source?: string }>();
  private topicArchiver: TopicArchiver;

  controlClient: TmuxControlClient | null = null;
  classicChannels: ClassicChannelManager | null = null;
  private pendingClassicStarts = new Map<string, PendingClassicStart>();
  /** In-flight /model selections, keyed by nonce (see handleModelSelection). */
  /** In-flight /effort selections, same coordinator shape as pendingModelSelects. */
  private pendingEffortSelects = new Map<string, { instanceName: string; userId: string; channelId: string; timer: ReturnType<typeof setTimeout>; respond: (t: string) => Promise<string | undefined>; adapter?: ChannelAdapter; adapterChatId?: string; adapterThreadId?: string; menuMessageId?: string; }>();
  private pendingModelSelects = new Map<string, { instanceName: string; model: string; userId: string; channelId: string; timer: ReturnType<typeof setTimeout>; respond: (t: string) => Promise<string | undefined>; adapter?: ChannelAdapter; adapterChatId?: string; adapterThreadId?: string; menuMessageId?: string; respondChoices?: (text: string, choices: { id: string; label: string }[]) => Promise<string | undefined>; }>();
  /** nonce → pending button prompt (hang restart, interactive assist, clean-exit restart). */
  private pendingNonceButtons = new Map<string, NonceButtonEntry>();

  // Model failover state
  private failoverActive = new Map<string, string>(); // instance → current failover model

  // IPC reconnect: tracks instances being intentionally stopped (skip reconnect)
  /** instance → when a click with no live button entry last fired a cancel. */
  private staleCancelClickAt = new Map<string, number>();
  readonly ipcStoppingInstances = new Set<string>();
  /** Set the moment a graceful stop begins — see isPlannedRestart(). */
  private shuttingDown = false;
  /** Coalesce concurrent connection attempts for the same daemon socket. */
  private ipcConnectInFlight = new Map<string, Promise<void>>();
  /** At most one reconnect/backoff loop may exist per instance. */
  private ipcReconnectInFlight = new Map<string, Promise<void>>();

  // Adapter restart: prevents re-entrant restart attempts
  private adapterRestarting = new Set<string>();
  // Adapter isolation: track state per adapter for retry + visibility
  private adapterState = new Map<string, { status: "connected" | "retrying" | "failed"; retryCount: number; lastError?: string; retryTimer?: ReturnType<typeof setTimeout> }>();
  private collabInstances = new Set<string>();

  // Health endpoint
  private healthServer: Server | null = null;
  private healthPortRetried = false;
  private updateCheckTimer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | null = null;
  private updateProgressTimer: ReturnType<typeof setInterval> | null = null;
  private updateProgressEditRunning = false;
  private lastUpdateProgressText: string | null = null;
  private updateCompletionTipText: string | null = null;
  private eventLogPruneTimer: ReturnType<typeof setInterval> | null = null;
  private logRotateTimer: ReturnType<typeof setInterval> | null = null;
  /** Days of event/activity history to keep. */
  private static readonly EVENT_LOG_RETENTION_DAYS = 30;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;

  // Mirror topic: buffer cross-instance messages, flush every 3s
  private mirrorBuffer: string[] = [];
  private mirrorTimer: ReturnType<typeof setTimeout> | null = null;

  // Web UI: SSE clients + auth token
  private sseClients = new Set<import("node:http").ServerResponse>();
  private webToken: string | null = null;
  private viewToken: string | null = null;
  private healthServerListening = false;

  constructor(public dataDir: string) {
    FleetManager.signalTarget = this;
    if (!FleetManager.sighupHandlerInstalled) {
      process.on("SIGHUP", () => FleetManager.signalTarget?.handleSighup());
      FleetManager.sighupHandlerInstalled = true;
    }
    this.lifecycle = new InstanceLifecycle(this);
    this.topicCommands = new TopicCommands(this);
    this.topicArchiver = new TopicArchiver(this);
    this.statuslineWatcher = new StatuslineWatcher(this);
  }

  private handleSighup(): void {
    this.logger.info("Received SIGHUP, hot-reloading config...");
    if (!this.startupComplete) {
      this.reloadPending = true;
      this.logger.info("Fleet startup is still in progress — queued config reload");
      return;
    }
    this.scheduleReconcile();
  }

  private scheduleReconcile(): void {
    if (this.reconcileInFlight) {
      this.reloadPending = true;
      this.logger.info("Config reconciliation already running — coalesced reload request");
      return;
    }

    this.reloadPending = false;
    this.reconcileInFlight = this.reconcileInstances()
      .catch(err => {
        // Almost always a YAML parse error. Log-only meant the user edited
        // fleet.yaml, sent SIGHUP, and got no reaction and no explanation.
        this.logger.error({ err }, "SIGHUP config reload failed");
        const message = err instanceof Error ? err.message : String(err);
        this.notifyFleetError(t("fleet.reload_failed", message));
      })
      .finally(() => {
        this.reconcileInFlight = null;
        if (this.reloadPending && this.startupComplete) {
          this.scheduleReconcile();
        }
      });
  }

  /**
   * Is the fleet going down (or coming back up) on purpose?
   *
   * Instances dying during a planned restart is the restart working, not an
   * incident — but the code that notices a dead pane or a dead MCP server
   * cannot tell the difference on its own. Two sources, because the noise
   * starts before this process is even told to stop: `agend update` replaces
   * the package on disk while this daemon is still running and still watching.
   */
  isPlannedRestart(): boolean {
    return this.shuttingDown || isUpdateInProgress(this.dataDir);
  }

  private finishStartup(): void {
    this.startupComplete = true;
    // We are the post-update fleet: the update is over by definition. Clearing
    // it here (rather than in the update command, which exits before the new
    // fleet is up) is what keeps the quiet window from outliving the restart.
    clearUpdateMarker(this.dataDir);
    if (this.reloadPending) this.scheduleReconcile();
    void this.sweepOrphanedCancelButtons();
  }

  // ── ArchiverContext bridge ────────────────────────────────────────────
  lastActivityMs(name: string): number {
    return this.lastActivity.get(name) ?? 0;
  }

  /**
   * Is the instance between turns?
   *
   * Prefers the daemon's pane state machine (debounced, busy-pattern aware) over
   * the control client's raw 2-second output-silence heuristic. The raw heuristic
   * reads every >2s output lull as idle — and long silent tools (a build, a test
   * run) or an LLM pause produce those constantly mid-turn. That misreading is
   * what retired cancel buttons in the middle of long work (the 5-minute backstop
   * fired during a lull) and froze their progress text (ticker skipped "idle"
   * ticks). The silence heuristic remains only as the fallback for instances
   * whose daemon has not reported a state yet.
   */
  private getInstanceIdle(name: string): boolean {
    // A daemon that is not running cannot be mid-turn. This is what a stale
    // "working" cache after a hard daemon kill (SIGKILL/OOM — no IPC crash
    // report ever arrives) must not override.
    if (this.getInstanceStatus(name) !== "running") return true;
    const state = this.getInstanceExecutionState(name);
    if (state === "working" || state === "stuck") return false;
    if (state === "idle") return true;
    try {
      const widFile = join(this.getInstanceDir(name), "window-id");
      if (!existsSync(widFile)) return true;
      const wid = readFileSync(widFile, "utf-8").trim();
      return wid ? (this.controlClient?.isIdle(wid) ?? true) : true;
    } catch { return true; }
  }

  /**
   * True when the instance claims working/stuck but nothing has refreshed that
   * claim for STATE_REPORT_STALE_MS despite the backstop's per-tick queries.
   * Measures the CACHE's age, not the button's — a healthy multi-hour run
   * answers every query and never trips this.
   */
  private stateReportDead(name: string): boolean {
    const cached = this.instanceStateCache.get(name);
    if (!cached) return false; // no claim to distrust — getInstanceIdle owns this case
    return Date.now() - cached.receivedAt > STATE_REPORT_STALE_MS;
  }

  // ── LifecycleContext bridge methods ──────────────────────────────────────
  webhookEmit(event: string, name: string, data?: Record<string, unknown>): void {
    this.webhookEmitter?.emit(event, name, data);
  }

  // ── SysInfo ────────────────────────────────────────────────────────────
  getSysInfo(): import("./fleet-context.js").SysInfo {
    const mem = process.memoryUsage();
    const toMB = (b: number) => Math.round(b / 1024 / 1024 * 10) / 10;
    const instances = Object.keys(this.fleetConfig?.instances ?? {}).map(name => ({
      name,
      status: this.getInstanceStatus(name),
      state: this.getInstanceExecutionState(name),
      ipc: this.instanceIpcClients.has(name),
      costCents: this.costGuard?.getDailyCostCents(name) ?? 0,
      rateLimits: this.statuslineWatcher.getRateLimits(name) ?? null,
    }));
    return {
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
      memory_mb: { rss: toMB(mem.rss), heapUsed: toMB(mem.heapUsed), heapTotal: toMB(mem.heapTotal) },
      instances,
      fleet_cost_cents: this.costGuard?.getFleetTotalCents() ?? 0,
      fleet_cost_limit_cents: this.costGuard?.getLimitCents() ?? 0,
    };
  }

  /** Load fleet.yaml and build routing table */
  loadConfig(configPath: string): FleetConfig {
    this.configPath = configPath;
    const source = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "{}\n";
    this.rawFleetDocument = parseDocument(source, { keepSourceTokens: true });
    if (this.rawFleetDocument.errors.length > 0) {
      throw new Error(`Invalid fleet.yaml: ${this.rawFleetDocument.errors[0].message}`);
    }
    this.rawFleetConfig = loadRawFleetConfig(configPath);
    this.fleetConfig = loadFleetConfig(configPath);
    this.savedFleetConfigSnapshot = structuredClone(this.fleetConfig);
    return this.fleetConfig;
  }

  /** User-authored fleet.yaml, before defaults are merged into instances. */
  getRawFleetConfig(): RawFleetConfig {
    return structuredClone(this.rawFleetConfig);
  }

  /** Build topic routing table: { topicId -> RouteTarget } */
  buildRoutingTable(): Map<string, RouteTarget> {
    if (this.fleetConfig) {
      this.routing.rebuild(this.fleetConfig);
      this.reregisterClassicChannels();
    }
    return this.routing.map;
  }

  /**
   * Refresh each adapter's open-channel whitelist after a classic change.
   * Classic channels are NOT registered in the routing engine (it's single-key
   * per channel — can't represent two bots in one channel); routing resolves
   * per-bot via ClassicChannelManager.getInstanceByChannel. Each adapter only
   * opens the channels IT owns so a sibling bot doesn't process another's cross-
   * guild channel.
   */
  private reregisterClassicChannels(): void {
    if (!this.classicChannels) return;
    const channels = this.classicChannels.getAll();
    // Classic's persisted adapter is authoritative. Legacy adapter-less rows
    // deterministically belong to channels[0], never to whichever bot happens
    // to deliver the first message after startup/reconnect.
    for (const ch of channels) {
      const adapterId = ch.adapterId ?? this.getPrimaryAdapterId();
      if (adapterId) this.instanceWorldBinding.set(ch.instanceName, adapterId);
    }
    // Always update adapter openChannels (including empty — clears stale entries on /stop)
    for (const [adapterId, w] of this.worlds) {
      if (typeof (w.adapter as any)?.setOpenChannels === "function") {
        const owned = channels
          .filter(ch => (ch.adapterId ?? this.getPrimaryAdapterId()) === adapterId)
          .map(ch => ch.channelId);
        (w.adapter as any).setOpenChannels(owned);
      }
    }
    if (channels.length > 0) {
      this.logger.info({ count: channels.length }, "Refreshed classic channel open-lists");
    }
  }

  getInstanceDir(name: string): string {
    return join(this.dataDir, "instances", name);
  }

  /** AgEnD package version (for the Settings "current version" / What's New). */
  get currentVersion(): string {
    try { return JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")).version ?? "unknown"; }
    catch { return "unknown"; }
  }

  /**
   * Resolve a slash-command target in a channel. Classic channels are looked up
   * per-bot (same-channel multi-bot); a fleet-topic instance is found via the
   * routing engine. Used by commands that work in BOTH contexts (/ctx, /compact,
   * /cancel). Classic-only commands (/chat, /load) must NOT use this.
   */
  private resolveSlashTarget(channelId: string, adapterId?: string): string | undefined {
    return this.classicChannels?.getInstanceByChannel(channelId, adapterId)
      ?? this.routing.resolve(channelId)?.name;
  }

  /**
   * Model switching is privileged. Fleet allowlisted admins retain authority in
   * ClassicBot channels, while ClassicBot's own admin_users may also switch the
   * model of the channel they administer.
   */
  private isModelAdmin(userId: string, channelId: string, adapterId?: string): boolean {
    if (this.isFleetAdmin(userId, adapterId)) return true;
    const isClassic = !!this.classicChannels?.getInstanceByChannel(channelId, adapterId);
    return isClassic && !!this.classicChannels?.isAdmin(userId);
  }

  private async handlePauseWakeSlash(data: ClassicStartSlashData, adapterId: string): Promise<void> {
    const action = data.command as "pause" | "wake";
    const classicName = this.classicChannels?.getInstanceByChannel(data.channelId, adapterId);
    if (classicName) {
      if (!this.classicChannels?.isAdmin(data.userId)) {
        await data.respond(t("permission.denied"));
        return;
      }
      await data.respond(await this.topicCommands.runPauseWake(classicName, action));
      return;
    }

    if (!this.isFleetAdmin(data.userId, adapterId)) {
      await data.respond(t("permission.denied"));
      return;
    }
    const route = this.routing.resolve(data.channelId);
    if (!route) {
      await data.respond(t("classic.no_agent"));
      return;
    }
    let target = route.name;
    if (route.kind === "general") {
      const requested = typeof data.options?.instance === "string" ? data.options.instance : undefined;
      if (!requested) {
        await data.respond(t(`${action}.usage`));
        return;
      }
      if (!this.fleetConfig?.instances[requested]) {
        await data.respond(t("instance.not_found", requested));
        return;
      }
      target = requested;
    }
    await data.respond(await this.topicCommands.runPauseWake(target, action));
  }

  private async handleUpdateSlash(data: ClassicStartSlashData, adapterId: string): Promise<void> {
    const allowed = this.fleetConfig?.channel?.access?.allowed_users ?? [];
    if (allowed.length > 0 && !allowed.some(u => String(u) === String(data.userId))) {
      await data.respond(t("not_authorized"));
      return;
    }
    const messageId = await data.respond(t("update.progress.preparing", 0));
    const adapter = this.adapters.get(adapterId) ?? this.adapter;
    if (messageId && adapter) {
      const chatId = String(this.getChannelConfig(adapterId)?.group_id ?? data.channelId);
      this.beginUpdateProgress(adapter, chatId, data.channelId, messageId);
    }
    const { spawn } = await import("node:child_process");
    const currentVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8")).version ?? "";
    const command = currentVersion.includes("beta") ? "agend update --beta" : "agend update";
    const child = spawn("sh", ["-c", `sleep 2 && ${command}`], { detached: true, stdio: "ignore" });
    child.once("error", err => this.failUpdateProgress(err.message));
    child.unref();
  }

  private async handleTipsSlash(data: ClassicStartSlashData, adapterId: string): Promise<void> {
    if (!this.fleetConfig) return;
    const mode = typeof data.options?.mode === "string" ? data.options.mode : "";
    if (mode === "advanced on") {
      if (!this.isFleetAdmin(data.userId, adapterId)) {
        await data.respond(t("permission.denied"));
        return;
      }
      await data.respond(this.unlockAdvancedTips(data.userId)
        ? t("tips.advanced.unlocked")
        : t("tips.unavailable"));
      return;
    }
    if (mode === "on" || mode === "off") {
      if (!this.isFleetAdmin(data.userId, adapterId)) {
        await data.respond(t("permission.denied"));
        return;
      }
      this.fleetConfig.defaults.tips = mode === "on";
      this.saveFleetConfig();
      await data.respond(t(mode === "on" ? "tips.enabled" : "tips.disabled"));
      return;
    }

    const adapter = this.adapters.get(adapterId) ?? this.adapter;
    if (!adapter) {
      await data.respond(t("tips.unavailable"));
      return;
    }
    const targetName = this.resolveSlashTarget(data.channelId, adapterId)
      ?? this.findGeneralInstance(adapterId)
      ?? "general";
    // Discord slash interactions are deferred ephemerally, but the Tip itself
    // belongs in the channel where /tips was invoked. Post there directly,
    // then delete the empty acknowledgement instead of leaving a slash corpse.
    //
    // The callback binding uses (chatId, threadId) that match what the adapter
    // emits on callback_query. Discord emits (guildId, channelId); Telegram
    // emits (supergroup chatId, topic threadId). For /tips invoked in an
    // arbitrary channel, pass the canonical group id as chatId and the
    // invocation channel as threadId, exactly as sendTipToGeneral() does.
    const chatId = this.getGroupIdForInstance(targetName) || data.channelId;
    const result = await this.promptTip(targetName, adapter, chatId, data.channelId);
    if (result === "posted" && data.dismissResponse) {
      await data.dismissResponse();
      return;
    }
    await data.respond(t(result === "posted"
      ? "tips.posted"
      : result === "empty" ? "tips.empty" : "tips.unavailable"));
  }

  /** Admin-only full conversation reset for fleet-topic and Classic instances. */
  private async handleClearSlash(data: ClassicStartSlashData, adapterId: string): Promise<void> {
    if (!this.isModelAdmin(data.userId, data.channelId, adapterId)) {
      await data.respond(t("permission.denied"));
      return;
    }
    const name = this.resolveSlashTarget(data.channelId, adapterId);
    if (!name) {
      await data.respond(t("classic.no_agent"));
      return;
    }
    const adapter = this.adapters.get(adapterId) ?? this.adapter;
    if (!adapter) {
      await data.respond(t("clear.prompt_unavailable"));
      return;
    }
    const chatId = String(this.getChannelConfig(adapterId)?.group_id ?? data.channelId);
    const fallback = await this.promptClearConfirmation(
      name,
      data.channelId,
      adapter,
      chatId,
      data.channelId,
    );
    await data.respond(fallback ?? t("clear.confirm_posted"));
  }

  /** Get the adapter bound to an instance, falling back to primary adapter */
  getAdapterForInstance(name: string): ChannelAdapter | null {
    const worldId = this.getInstanceAdapterId(name);
    if (worldId) return this.worlds.get(worldId)?.adapter ?? this.adapter;
    return this.adapter;
  }

  /** Get the world for an instance */
  getWorldForInstance(name: string): AdapterWorld | undefined {
    const worldId = this.getInstanceAdapterId(name);
    return worldId ? this.worlds.get(worldId) : undefined;
  }

  /** Get channel config for a specific adapter (by id), falling back to primary */
  getChannelConfig(adapterId?: string): import("./types.js").ChannelConfig | undefined {
    const channels = this.fleetConfig?.channels
      ?? (this.fleetConfig?.channel ? [this.fleetConfig.channel] : []);
    if (adapterId) {
      return channels.find(ch => (ch.id ?? ch.type) === adapterId)
        ?? this.worlds.get(adapterId)?.channelConfig
        ?? channels[0];
    }
    return channels[0];
  }

  /** Get the group_id for an instance's bound adapter */
  getGroupIdForInstance(name: string): string {
    const adapterId = this.getInstanceAdapterId(name);
    const world = adapterId ? this.worlds.get(adapterId) : undefined;
    return world?.groupId ?? String(this.getChannelConfig(adapterId)?.group_id ?? "");
  }

  /** Configured primary adapter id. Never infer this from Map insertion order. */
  private getPrimaryAdapterId(): string | undefined {
    const primary = this.fleetConfig?.channels?.[0] ?? this.fleetConfig?.channel;
    if (primary) return primary.id ?? primary.type;
    // Defensive compatibility for callers/tests that provide a live world but
    // no channel config. Real multi-adapter fleets always have channels[].
    return this.worlds.keys().next().value as string | undefined;
  }

  /** Warn when a coordinator's adapter identity is ambiguous to the operator. */
  private warnUnboundGeneralChannelIds(fleet: FleetConfig): void {
    const channels = fleet.channels ?? (fleet.channel ? [fleet.channel] : []);
    if (channels.length <= 1) return;

    const adapterIds = channels.map(ch => ch.id ?? ch.type);
    for (const [name, config] of Object.entries(fleet.instances)) {
      if (!config.general_topic || config.channel_id) continue;
      this.logger.warn({
        instance: name,
        defaultAdapter: adapterIds[0],
        availableAdapters: adapterIds,
      }, "General instance has no channel_id in a multi-channel fleet; defaulting to the first adapter. Set channel_id explicitly.");
    }
  }

  /**
   * Resolve the authoritative adapter identity for an instance.
   * Fleet instances without channel_id and legacy Classic entries both belong
   * to channels[0]. Runtime bindings remain available for external sessions.
   */
  private getInstanceAdapterId(name: string): string | undefined {
    const cfg = this.fleetConfig?.instances[name];
    if (cfg) return cfg.channel_id ?? this.getPrimaryAdapterId();

    if (this.classicChannels?.getChannelIdByInstance(name) !== undefined) {
      return this.classicChannels.getAdapterIdByInstance(name) ?? this.getPrimaryAdapterId();
    }

    return this.instanceWorldBinding.get(name) ?? this.getPrimaryAdapterId();
  }

  /**
   * Bind an instance to a specific world (the bot that answers for it).
   * fromInbound=true (binding inferred from which adapter received a message)
   * must not override a configured identity. Fleet instances use channel_id or
   * channels[0]; Classic instances use their persisted adapter (or channels[0]
   * for a legacy entry). Only external sessions may bind from inbound traffic.
   */
  bindInstanceAdapter(name: string, adapterId: string, fromInbound = false): void {
    if (fromInbound) {
      const configuredId = this.getInstanceAdapterId(name);
      if (this.fleetConfig?.instances[name]
        || this.classicChannels?.getChannelIdByInstance(name) !== undefined) {
        if (configuredId) this.instanceWorldBinding.set(name, configuredId);
        return;
      }
    }
    this.instanceWorldBinding.set(name, adapterId);
  }

  getInstanceStatus(name: string): "running" | "paused" | "stopped" | "crashed" {
    if (this.lifecycle.isPaused(name)) return "paused";
    const daemon = this.lifecycle.daemons.get(name) as { getProcessStatus?: () => "running" | "crashed" | "stopped" } | undefined;
    const processStatus = this.instanceProcessStatus.get(name);
    // IPC can be disconnected during a respawn, so the event which announces
    // the new live pane may be missed.  The in-process daemon is authoritative
    // in that case; do not leave a stale `crashed` cache masking an instance
    // that has already recovered and can answer messages.
    const daemonStatus = daemon?.getProcessStatus?.();
    if (daemonStatus === "running") {
      if (processStatus) this.instanceProcessStatus.delete(name);
      // A recovered in-process daemon is also the authority for clearing a
      // marker left by a crash-loop/reconnect race.  This keeps standalone
      // `agend ls` from seeing the old marker after the next API outage.
      try { unlinkSync(join(this.getInstanceDir(name), "crash-state.json")); } catch { /* absent */ }
      return "running";
    }
    if (processStatus) return processStatus;
    const pidPath = join(this.getInstanceDir(name), "daemon.pid");
    if (!existsSync(pidPath)) return "stopped";
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    try {
      process.kill(pid, 0);
      return "running";
    } catch {
      return "crashed";
    }
  }

  getInstanceExecutionState(name: string): InstanceState | null {
    if (this.lifecycle.isPaused(name)) return null;
    // Process status wins over a stale pane snapshot. A dead remain-on-exit pane
    // can still contain the old ready marker and must never surface as Idle.
    if (this.instanceProcessStatus.has(name)) return null;
    return this.instanceStateCache.get(name)?.state ?? null;
  }

  /**
   * Subscription providers currently relevant to this fleet. Stopped/crashed
   * rows do not keep a usage card alive, while persisted paused instances do.
   * Classic channels use their effective backend merge chain, not the raw row.
   */
  getActiveUsageProviderIds(): ReadonlySet<string> {
    const providers = new Set<string>();
    for (const backend of this.getActiveBackendIds()) {
      const provider = usageProviderIdForBackend(backend);
      if (provider) providers.add(provider);
    }
    return providers;
  }

  /** Effective backends with a running or persisted-paused fleet/Classic instance. */
  getActiveBackendIds(): ReadonlySet<string> {
    const backends = new Set<string>();
    const add = (name: string, backend: string | undefined) => {
      const status = this.getInstanceStatus(name);
      if (status !== "running" && status !== "paused") return;
      if (backend) backends.add(backend);
    };

    for (const [name, config] of Object.entries(this.fleetConfig?.instances ?? {})) {
      // loadFleetConfig() has already merged the fleet default into each row.
      add(name, config.backend ?? this.fleetConfig?.defaults?.backend ?? "claude-code");
    }
    for (const channel of this.classicChannels?.getAll() ?? []) {
      add(
        channel.instanceName,
        this.classicChannels?.getBackendByInstance(
          channel.instanceName,
          this.fleetConfig?.defaults?.backend,
        ),
      );
    }
    return backends;
  }

  isClassicInstance(name: string): boolean {
    return this.classicChannels?.getAll().some(channel => channel.instanceName === name) ?? false;
  }

  private cacheInstanceExecutionState(name: string, msg: Record<string, unknown>): void {
    const state = msg.state;
    if (state !== "idle" && state !== "working" && state !== "stuck") return;

    const previous = this.instanceStateCache.get(name);
    const now = Date.now();
    const numberOr = (value: unknown, fallback: number): number =>
      typeof value === "number" && Number.isFinite(value) ? value : fallback;
    this.instanceStateCache.set(name, {
      state,
      unchangedForMs: numberOr(msg.unchangedForMs, previous?.unchangedForMs ?? 0),
      observedAt: numberOr(msg.observedAt, now),
      stateChangedAt: numberOr(
        msg.stateChangedAt,
        previous?.state === state ? previous.stateChangedAt : now,
      ),
      // Fleet-manager receipt time, NOT the daemon's observation time: staleness
      // asks "is anyone still reporting", which only the receiver can date.
      receivedAt: now,
    });
    for (const check of this.instanceIdleWaiters.get(name) ?? []) check();
    // warm_cap: a fresh transition into idle may free this instance for eviction,
    // or (more usefully) reveal that the fleet is now over cap. Only fire on the
    // edge into idle, not on every idle heartbeat.
    if (state === "idle" && previous?.state !== "idle") {
      this.enforceWarmCap();
      // A queued message may turn this edge back into working almost
      // immediately. Give that handoff a short grace before retiring the button.
      this.scheduleIdleButtonRetirement(name);
    } else if (state !== "idle") {
      this.cancelIdleButtonRetirement(name);
    }
  }

  private cancelIdleButtonRetirement(name: string): void {
    const timer = this.cancelButtonIdleRetireTimers.get(name);
    if (!timer) return;
    clearTimeout(timer);
    this.cancelButtonIdleRetireTimers.delete(name);
  }

  private scheduleIdleButtonRetirement(name: string): void {
    this.cancelIdleButtonRetirement(name);
    const timer = setTimeout(() => {
      // Ignore a superseded timer even if it was already queued to run.
      if (this.cancelButtonIdleRetireTimers.get(name) !== timer) return;
      this.cancelButtonIdleRetireTimers.delete(name);
      if (this.getInstanceExecutionState(name) === "idle") {
        this.retireInstanceButtons(name);
      }
    }, CANCEL_BTN_IDLE_RETIRE_GRACE_MS);
    timer.unref?.();
    this.cancelButtonIdleRetireTimers.set(name, timer);
  }

  private cacheInstanceProcessStatus(name: string, status: unknown): void {
    if (status === "running") {
      this.instanceProcessStatus.delete(name);
      // A prior crash-loop marker is one-shot.  Successful respawn is the
      // authoritative recovery signal even when the marker outlived an IPC
      // disconnect and was not consumed by a new Daemon constructor.
      try { unlinkSync(join(this.getInstanceDir(name), "crash-state.json")); } catch { /* absent */ }
      return;
    }
    if (status !== "crashed" && status !== "stopped") return;
    this.cancelIdleButtonRetirement(name);
    this.instanceProcessStatus.set(name, status);
    // Never display the last ready prompt as current execution state after its
    // owning CLI process has exited.
    this.instanceStateCache.delete(name);
    for (const check of this.instanceIdleWaiters.get(name) ?? []) check();
  }

  /**
   * Fleet-wide warm cap: if more than `defaults.warm_cap` instances are running,
   * auto-pause the least-recently-active idle instances until back at the cap.
   * Never evicts general instances (must stay warm) or working/stuck instances
   * (only idle). 0/unset = unlimited. wake-before-deliver re-warms any evicted
   * instance when a message next arrives.
   *
   * @param exclude instance to spare (e.g. one just woken to receive a delivery).
   */
  private enforceWarmCap(exclude?: string): void {
    const cap = this.fleetConfig?.defaults?.warm_cap ?? 0;
    if (!Number.isInteger(cap) || cap <= 0) return; // 0/invalid = unlimited

    const warm: string[] = [];
    for (const name of this.daemons.keys()) {
      if (this.getInstanceStatus(name) === "running") warm.push(name);
    }
    if (warm.length <= cap) return;

    const victims = selectLruEvictions(warm, cap, {
      exclude,
      isEvicting: name => this.warmCapEvicting.has(name),
      isGeneral: name => isGeneralInstance(this.fleetConfig, name),
      isIdle: name => this.getInstanceExecutionState(name) === "idle",
      lastInboundAt: name => readLastInboundAt(this.getInstanceDir(name)) ?? 0,
    });
    for (const victim of victims) {
      this.warmCapEvicting.add(victim);
      this.logger.info({ instance: victim, warm: warm.length, cap }, "warm_cap exceeded — auto-pausing LRU idle instance");
      this.lifecycle.pause(victim)
        .catch(err => this.logger.warn({ err, instance: victim }, "warm_cap auto-pause failed"))
        .finally(() => this.warmCapEvicting.delete(victim));
    }
  }

  private waitForInstanceIdle(
    instanceName: string,
    timeoutMs: number,
    idleObservedAfter = 0,
    cancelled?: () => boolean,
  ): Promise<boolean> {
    const isReady = (): boolean => {
      const snapshot = this.instanceStateCache.get(instanceName);
      return snapshot?.state === "idle"
        && (idleObservedAfter === 0 || snapshot.observedAt > idleObservedAfter);
    };
    if (isReady()) return Promise.resolve(true);

    return new Promise(resolve => {
      let settled = false;
      const finish = (idle: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(queryTimer);
        const waiters = this.instanceIdleWaiters.get(instanceName);
        waiters?.delete(check);
        if (waiters?.size === 0) this.instanceIdleWaiters.delete(instanceName);
        resolve(idle);
      };
      const check = () => {
        if (cancelled?.()) finish(false);
        else if (isReady()) finish(true);
      };
      const query = () => {
        const ipc = this.instanceIpcClients.get(instanceName);
        if (ipc?.connected) {
          ipc.send({ type: "query_instance_state", requestId: `idle-gate-${Date.now()}` });
        }
        check();
      };
      const waiters = this.instanceIdleWaiters.get(instanceName) ?? new Set<() => void>();
      waiters.add(check);
      this.instanceIdleWaiters.set(instanceName, waiters);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      const queryTimer = setInterval(query, 1_000);
      query();
    });
  }

  /**
   * Ask the daemon to capture the pane before answering, then wait for any state
   * report produced after this request. The ordinary query is intentionally
   * cache-only (idle gates call it frequently); this opt-in refresh is reserved
   * for lifecycle decisions where a stale state would strand UI.
   */
  private refreshInstanceExecutionState(instanceName: string, timeoutMs: number): Promise<boolean> {
    const ipc = this.instanceIpcClients.get(instanceName);
    if (!ipc?.connected) return Promise.resolve(false);
    const previous = this.instanceStateCache.get(instanceName);

    return new Promise(resolve => {
      let settled = false;
      const finish = (refreshed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const waiters = this.instanceIdleWaiters.get(instanceName);
        waiters?.delete(check);
        if (waiters?.size === 0) this.instanceIdleWaiters.delete(instanceName);
        resolve(refreshed);
      };
      const check = () => {
        if (this.instanceStateCache.get(instanceName) !== previous) finish(true);
      };
      const waiters = this.instanceIdleWaiters.get(instanceName) ?? new Set<() => void>();
      waiters.add(check);
      this.instanceIdleWaiters.set(instanceName, waiters);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      timeout.unref?.();
      const sent = ipc.send({
        type: "query_instance_state",
        requestId: `reply-grace-${Date.now()}`,
        refresh: true,
      });
      if (!sent) finish(false);
    });
  }

  private async deliverWithIdleGate(
    instanceName: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
    deliveryEpoch: number,
  ): Promise<void> {
    if (!this.isDeliveryEpochCurrent(instanceName, deliveryEpoch)) return;
    let idleObservedAfter = this.lastDeliveryAt.get(instanceName) ?? 0;
    if (this.lifecycle.isPaused(instanceName)) {
      const wakeStartedAt = Date.now();
      await this.lifecycle.wake(instanceName, 30_000);
      if (!this.isDeliveryEpochCurrent(instanceName, deliveryEpoch)) return;
      // Waking added one to the warm count — make room by evicting a different
      // LRU idle instance (never this one; it's about to work).
      this.enforceWarmCap(instanceName);
      // Never satisfy a post-wake gate from a stale pre-pause cache entry.
      idleObservedAfter = Math.max(idleObservedAfter, wakeStartedAt);
    }

    const idle = await this.waitForInstanceIdle(
      instanceName,
      timeoutMs,
      idleObservedAfter,
      () => !this.isDeliveryEpochCurrent(instanceName, deliveryEpoch),
    );
    if (!this.isDeliveryEpochCurrent(instanceName, deliveryEpoch)) {
      this.logger.info({ instanceName }, "Pending delivery dropped by user cancel");
      return;
    }
    if (!idle) {
      this.logger.warn({ instanceName, timeoutMs }, "Idle gate timed out; forcing delivery");
    }
    await this.sendWhenConnected(instanceName, payload, deliveryEpoch);
    if (!this.isDeliveryEpochCurrent(instanceName, deliveryEpoch)) return;
    this.lastDeliveryAt.set(instanceName, Date.now());
  }

  /**
   * Hand a payload to an instance's IPC, waiting out a *transient* disconnect.
   *
   * A daemon that is restarting — `/restart`, crash recovery, a model switch —
   * drops its socket for a few seconds. Any message arriving in that window used
   * to fail instantly: the caller logged a warning, put ❌ on the user's message,
   * and the message was gone. The user had to notice the ❌ and retype it. That is
   * the "instance 訊息不容易掉" goal failing on the most predictable event there is.
   *
   * The wait is bounded. If the instance is genuinely down, this still throws and
   * the ❌ still appears — just for a real failure rather than a restart.
   *
   * Ordering is preserved by serialising behind any waiter already queued for this
   * instance, *including* when the socket happens to be up: otherwise a message
   * arriving after the reconnect could overtake one that has been waiting for it.
   */
  private async sendWhenConnected(
    instanceName: string,
    payload: Record<string, unknown>,
    deliveryEpoch = this.getDeliveryEpoch(instanceName),
  ): Promise<void> {
    if (!this.isDeliveryEpochCurrent(instanceName, deliveryEpoch)) return;
    const queued = this.ipcWaitTails.get(instanceName);
    if (!queued) {
      const ipc = this.instanceIpcClients.get(instanceName);
      if (ipc?.connected && ipc.send(payload)) return;
    }

    const attempt = (queued ?? Promise.resolve())
      .catch(() => { /* a previous waiter's failure must not cancel this one */ })
      .then(() => {
        if (!this.isDeliveryEpochCurrent(instanceName, deliveryEpoch)) return;
        return this.sendAfterIpcReturns(instanceName, payload, deliveryEpoch);
      });
    // The chain stores a settled-either-way promise so one failed delivery cannot
    // wedge every later one, and so `queued` above is safe to await unguarded.
    const tail = attempt.catch(() => {});
    this.ipcWaitTails.set(instanceName, tail);
    try {
      await attempt;
    } finally {
      // Only the last waiter clears the chain; while a queue is still draining the
      // map must keep pointing at it or ordering is lost.
      if (this.ipcWaitTails.get(instanceName) === tail) {
        this.ipcWaitTails.delete(instanceName);
      }
    }
  }

  /** Poll for the instance's IPC to come back, then send. Throws if it does not. */
  private async sendAfterIpcReturns(
    instanceName: string,
    payload: Record<string, unknown>,
    deliveryEpoch = this.getDeliveryEpoch(instanceName),
  ): Promise<void> {
    const deadline = Date.now() + IPC_RECONNECT_GRACE_MS;
    let warned = false;
    for (;;) {
      if (!this.isDeliveryEpochCurrent(instanceName, deliveryEpoch)) return;
      // Re-read every round: a reconnect replaces the IpcClient object entirely,
      // so a cached reference would stay dead forever.
      const ipc = this.instanceIpcClients.get(instanceName);
      if (ipc?.connected && ipc.send(payload)) return;
      if (Date.now() >= deadline) {
        throw new Error(`Instance '${instanceName}' IPC is unavailable`);
      }
      if (!warned) {
        warned = true;
        this.logger.info({ instanceName }, "Instance IPC is down — holding delivery until it reconnects");
      }
      await new Promise(resolve => setTimeout(resolve, IPC_RECONNECT_POLL_MS));
    }
  }

  /** Single delivery facade: wake paused CLIs and serialize non-user work behind idle. */
  async deliverToInstance(
    instanceName: string,
    payload: Record<string, unknown>,
    options: DeliveryOptions = {},
  ): Promise<void> {
    const deliveryEpoch = this.getDeliveryEpoch(instanceName);
    const deliveryPayload = { ...payload, delivery_epoch: deliveryEpoch };
    const meta = payload.meta && typeof payload.meta === "object"
      ? payload.meta as Record<string, unknown>
      : undefined;
    const inferredCrossInstance = (typeof meta?.from_instance === "string" && meta.from_instance.length > 0)
      || meta?.is_cross_instance === true
      || payload.is_cross_instance === true;
    const waitForIdle = options.waitForIdle
      ?? ((options.isCrossInstance ?? inferredCrossInstance) || payload.type === "fleet_schedule_trigger");

    if (!waitForIdle) {
      if (this.lifecycle.isPaused(instanceName)) {
        await this.lifecycle.wake(instanceName, 30_000);
        if (!this.isDeliveryEpochCurrent(instanceName, deliveryEpoch)) return;
        this.enforceWarmCap(instanceName); // woke one → evict a different LRU idle if over cap
      }
      await this.sendWhenConnected(instanceName, deliveryPayload, deliveryEpoch);
      if (!this.isDeliveryEpochCurrent(instanceName, deliveryEpoch)) return;
      // A cross-instance item arriving before the daemon observes this turn as
      // working must not trust the stale idle snapshot from before the send.
      this.lastDeliveryAt.set(instanceName, Date.now());
      return;
    }

    const previous = this.idleGatedDeliveryTails.get(instanceName) ?? Promise.resolve();
    const delivery = previous.catch(() => {}).then(() => this.deliverWithIdleGate(
      instanceName,
      deliveryPayload,
      options.idleTimeoutMs ?? 60_000,
      deliveryEpoch,
    ));
    this.idleGatedDeliveryTails.set(instanceName, delivery);
    try {
      await delivery;
    } finally {
      if (this.idleGatedDeliveryTails.get(instanceName) === delivery) {
        this.idleGatedDeliveryTails.delete(instanceName);
      }
    }
  }

  /** Fleet admin is an explicit config allowlist entry, not merely an open/paired user. */
  isFleetAdmin(userId: string, adapterId?: string): boolean {
    const allowed = this.getChannelConfig(adapterId)?.access?.allowed_users ?? [];
    return allowed.some(entry => String(entry) === String(userId));
  }

  async changeInstancePauseState(name: string, action: "pause" | "wake"): Promise<"paused" | "awake" | "not_idle"> {
    if (action === "wake") {
      await this.lifecycle.wake(name, 30_000);
      this.enforceWarmCap(name); // manual wake still respects the fleet warm cap
      return "awake";
    }
    if (isGeneralInstance(this.fleetConfig, name)) {
      throw new Error(GENERAL_PAUSE_ERROR);
    }
    await this.lifecycle.pause(name);
    return this.lifecycle.isPaused(name) ? "paused" : "not_idle";
  }

  /** Apply a Settings edit to a ClassicBot channel without waiting for the poller. */
  async restartClassicInstanceFromSettings(instanceName: string): Promise<void> {
    if (!this.classicChannels) throw new Error("Classic channel manager not initialized");
    const wasRunning = this.daemons.has(instanceName);
    this.classicChannels.reloadFromDisk();
    this.reregisterClassicChannels();
    const channel = this.classicChannels.getAll().find(item => item.instanceName === instanceName);
    if (!channel) throw new Error("Classic channel not found after reload");
    if (!wasRunning) return;
    await this.stopInstance(instanceName);
    await new Promise(resolve => setTimeout(resolve, 250));
    await this.startClassicInstance(
      instanceName,
      this.classicChannels.getBackendByInstance(instanceName, this.fleetConfig?.defaults?.backend),
      this.classicChannels.getPreTaskCommand(channel.channelId, channel.adapterId),
      this.classicChannels.getModel(channel.channelId, channel.adapterId, this.fleetConfig?.defaults?.model),
      this.classicChannels.getAutoPauseAfter(channel.channelId, channel.adapterId, this.fleetConfig?.defaults?.auto_pause_after),
    );
  }

  async startInstance(
    name: string,
    config: InstanceConfig,
    topicMode: boolean,
    kind: "fleet-topic" | "classic" = "fleet-topic",
    /**
     * Explicit starts (CLI/API) may resume a paused or failed daemon.  Startup
     * and reconcile calls leave this false so a persisted pause remains paused
     * across a fleet restart.
     */
    resumePaused = false,
  ): Promise<void> {
    if (resumePaused && this.lifecycle.isPaused(name)) {
      await this.lifecycle.wake(name, 30_000);
      // A successful wake clears the persisted pause marker and produces a
      // fresh instance_state snapshot.  Drop any stale process error left by a
      // pre-pause crash so /api/fleet and `agend ls` converge on running.
      this.instanceProcessStatus.delete(name);
      return;
    }
    if (this.lifecycle.isPaused(name)) {
      this.logger.info({ name }, "Persisted paused instance — skipping startup");
      return;
    }
    if (this.lifecycle.daemons.has(name)) {
      // A crash-loop daemon remains in the lifecycle map so its health monitor
      // can expose the failure.  The old start path treated that object as
      // already running and merely deleted the process-status cache, leaving a
      // dead pane (and crash marker) behind.  An explicit start is a recovery
      // request: tear down the failed daemon and build a fresh one.
      if (resumePaused) {
        const status = this.getInstanceStatus(name);
        if (status === "crashed" || status === "stopped") {
          await this.restartSingleInstance(name);
          return;
        }
      }
      this.logger.info({ name }, "Instance already running, skipping");
      return;
    }
    const backend = config.backend ?? this.fleetConfig?.defaults?.backend ?? "claude-code";
    if (config.general_topic) {
      this.ensureGeneralInstructions(config.working_directory, backend, name);
    } else if (kind === "fleet-topic") {
      // Workers get only role-eligible on-demand skills. Classic instances are
      // deliberately excluded: their workspace and conversation lifecycle are
      // managed independently from fleet-topic workers.
      try {
        const skillsWorkDir = this.resolveKnowledgeWorkDir(config.working_directory, backend, name);
        this.syncRoleSkills(skillsWorkDir, backend, "worker");
      } catch (err) {
        // Skill publishing is additive. A read-only or temporarily unavailable
        // workspace must not turn an otherwise valid worker startup into a
        // fleet outage.
        this.logger.warn({ err, name, backend }, "Failed to sync worker skills — continuing startup");
      }
    }
    await this.lifecycle.start(name, config, topicMode, {
      kind,
      backend,
      model: this.resolveInstanceModel(name).display,
    });
    // Only clear a stale process status after a real start succeeded.  Clearing
    // it before lifecycle.start() can turn a crash-loop daemon's dead pane into
    // a falsely running instance when lifecycle.start() returns early.
    this.instanceProcessStatus.delete(name);
    try { unlinkSync(join(this.getInstanceDir(name), "crash-state.json")); } catch { /* consumed or absent */ }
    // Auto-connect IPC — daemon.start() ensures socket is ready before resolving
    await this.connectIpcToInstance(name);
  }

  /** Recreate a daemon for a marker-only paused instance after an explicit wake/delivery. */
  async startPersistedPausedInstance(name: string): Promise<void> {
    const topicMode = this.fleetConfig?.channel?.mode === "topic"
      || !!this.fleetConfig?.channels?.some(channel => channel.mode === "topic");
    const fleetConfig = this.fleetConfig?.instances[name];
    if (fleetConfig) {
      await this.startInstance(name, fleetConfig, topicMode);
      return;
    }
    const channel = this.classicChannels?.getAll().find(item => item.instanceName === name);
    if (!channel || !this.classicChannels) throw new Error(`Paused instance '${name}' is no longer configured`);
    await this.startClassicInstance(
      name,
      this.classicChannels.getBackendByInstance(name, this.fleetConfig?.defaults?.backend),
      this.classicChannels.getPreTaskCommand(channel.channelId, channel.adapterId),
      this.classicChannels.getModel(channel.channelId, channel.adapterId, this.fleetConfig?.defaults?.model),
      this.classicChannels.getAutoPauseAfter(channel.channelId, channel.adapterId, this.fleetConfig?.defaults?.auto_pause_after),
    );
  }

  /**
   * Start instances with configurable concurrency and stagger delay.
   * Instances sharing the same working_directory are serialized within a group
   * to avoid config file races. Stagger delay is group-to-group, not instance-to-instance.
   * TODO: per-instance startup timeout (existing issue, not introduced here)
   */
  private async startInstancesWithConcurrency(
    entries: [string, InstanceConfig][],
    topicMode: boolean,
    onReady?: (name: string) => void,
  ): Promise<void> {
    // Persisted pauses are intentionally preserved across fleet restarts. Filter
    // them before grouping/staggering: startInstance() retains its own guard as
    // a final backstop, but putting a no-op entry in this queue still consumes a
    // full stagger slot for every distinct working directory.
    const runnableEntries = entries.filter(([name]) => !this.lifecycle.isPaused(name));
    const pausedCount = entries.length - runnableEntries.length;
    if (pausedCount > 0) {
      this.logger.info({ pausedCount }, "Paused instances excluded from startup queue");
    }
    if (runnableEntries.length === 0) return;

    const raw = this.fleetConfig?.defaults?.startup;
    const explicitConcurrency = raw?.concurrency;
    const staggerMs = Math.max(0, Math.min(30_000, raw?.stagger_delay_ms ?? 500));

    // Adaptive concurrency: if not explicitly set, estimate from available RAM.
    // Each instance uses ~300MB (tmux + CLI process + model overhead).
    const ESTIMATED_MB_PER_INSTANCE = 300;
    const { freemem } = await import("node:os");
    let concurrency: number;
    if (explicitConcurrency != null) {
      concurrency = Math.max(1, Math.min(20, explicitConcurrency));
    } else {
      const freeMemMB = Math.round(freemem() / (1024 * 1024));
      concurrency = Math.max(2, Math.min(10, Math.floor(freeMemMB / ESTIMATED_MB_PER_INSTANCE)));
      this.logger.info({ concurrency, freeMemMB: freeMemMB, totalInstances: runnableEntries.length }, "Adaptive startup concurrency");
    }

    const byWorkDir = new Map<string, [string, InstanceConfig][]>();
    for (const [name, config] of runnableEntries) {
      const dir = config.working_directory;
      if (!byWorkDir.has(dir)) byWorkDir.set(dir, []);
      byWorkDir.get(dir)!.push([name, config]);
    }
    const groups = [...byWorkDir.values()];

    let running = 0;
    let idx = 0;
    let lastStartAt = 0;
    let pendingTimer = false;

    await new Promise<void>((resolve) => {
      if (groups.length === 0) { resolve(); return; }
      const startNext = () => {
        if (pendingTimer) return;
        while (running < concurrency && idx < groups.length) {
          // Re-check memory if adaptive (no explicit concurrency set)
          if (explicitConcurrency == null && running > 0) {
            const nowFreeMB = Math.round(freemem() / (1024 * 1024));
            if (nowFreeMB < ESTIMATED_MB_PER_INSTANCE) {
              this.logger.warn({ freeMemMB: nowFreeMB, remaining: groups.length - idx }, "Low memory — pausing instance startup");
              // Wait and retry in 5s
              pendingTimer = true;
              setTimeout(() => { pendingTimer = false; startNext(); }, 5000);
              return;
            }
          }
          const now = Date.now();
          const elapsed = now - lastStartAt;
          if (lastStartAt > 0 && elapsed < staggerMs) {
            pendingTimer = true;
            setTimeout(() => { pendingTimer = false; startNext(); }, staggerMs - elapsed);
            return;
          }
          const group = groups[idx++];
          running++;
          lastStartAt = Date.now();
          (async () => {
            for (const [name, config] of group) {
              try {
                await this.startInstance(name, config, topicMode);
                if (this.daemons.has(name)) onReady?.(name);
              } catch (err) {
                this.logger.error({ err, name }, "Failed to start instance");
              }
            }
          })().finally(() => {
            running--;
            if (idx >= groups.length && running === 0) resolve();
            else startNext();
          });
        }
      };
      startNext();
    });
  }

  private runnableStartupCount(fleet: FleetConfig, includeClassic: boolean): number {
    const names = this.configuredStartupInstanceNames(fleet, includeClassic);
    let count = 0;
    for (const name of names) {
      if (!this.lifecycle.isPaused(name)) count++;
    }
    return count;
  }

  private configuredStartupInstanceNames(fleet: FleetConfig, includeClassic: boolean): string[] {
    const names = new Set(Object.keys(fleet.instances));
    if (includeClassic) {
      for (const channel of this.classicChannels?.getAll() ?? []) names.add(channel.instanceName);
    }
    return [...names];
  }

  private restartProgressTarget(): RestartProgressTarget | null {
    const generalName = this.findGeneralInstance();
    if (!generalName) return null;
    const adapter = this.getAdapterForInstance(generalName);
    const chatId = this.getGroupIdForInstance(generalName);
    if (!adapter || !chatId) return null;
    const topicId = this.fleetConfig?.instances[generalName]?.topic_id;
    return {
      adapter,
      chatId,
      threadId: topicId != null ? String(topicId) : undefined,
    };
  }

  async stopInstance(name: string): Promise<void> {
    this.failoverActive.delete(name);
    this.cancelIdleButtonRetirement(name);
    this.instanceStateCache.delete(name);
    this.instanceProcessStatus.delete(name);
    this.lastDeliveryAt.delete(name);
    // A pending hang/exit/assist offer refers to the instance being torn down;
    // left alone it would stay clickable for the rest of its 15 minutes. Clear
    // again AFTER the stop completes: the teardown itself can emit hang /
    // interactive-prompt / clean-exit events whose handlers post fresh prompts
    // while the stop is still awaiting (the TOCTOU sol's review called out).
    this.clearNoncePromptsForInstance(name);
    try {
      return await this.lifecycle.stop(name);
    } finally {
      this.clearNoncePromptsForInstance(name);
    }
  }

  /** Restart a single instance, reloading fleet.yaml first to pick up config changes. */
  async restartSingleInstance(name: string, opts?: { freshStart?: boolean }): Promise<void> {
    // One restart at a time per instance. Multiple sources can ask concurrently
    // (MCP revival, /restart, pty_error, model failover); a second stop/start
    // interleaved with the first tears down the window the first just created.
    // Later callers join the in-flight restart instead — its opts win.
    const inFlight = this.restartsInFlight.get(name);
    if (inFlight) {
      this.logger.info({ name }, "restartSingleInstance: joining the restart already in flight");
      return inFlight;
    }
    const run = this.doRestartSingleInstance(name, opts)
      .finally(() => this.restartsInFlight.delete(name));
    this.restartsInFlight.set(name, run);
    return run;
  }

  private async doRestartSingleInstance(name: string, opts?: { freshStart?: boolean }): Promise<void> {
    if (this.configPath) {
      this.loadConfig(this.configPath);
      this.routing.rebuild(this.fleetConfig!);
      this.reregisterClassicChannels();
    }
    const config = this.fleetConfig?.instances[name];
    if (config) {
      await this.stopInstance(name);
      if (opts?.freshStart) this.writeFreshStartMarker(name);
      const topicMode = this.fleetConfig?.channel?.mode === "topic";
      await this.startInstance(name, config, topicMode ?? false);
      return;
    }
    // Classic instance fallback
    const channelId = this.classicChannels?.getChannelIdByInstance(name);
    if (channelId) {
      const fleetBackend = this.fleetConfig?.defaults?.backend;
      const adapterId = this.classicChannels!.getAdapterIdByInstance(name);
      await this.stopInstance(name);
      await new Promise(r => setTimeout(r, 1000)); // let tmux clean up
      if (opts?.freshStart) this.writeFreshStartMarker(name);
      await this.startClassicInstance(
        name,
        this.classicChannels!.getBackendByInstance(name, fleetBackend),
        this.classicChannels!.getPreTaskCommand(channelId, adapterId),
        this.classicChannels!.getModel(channelId, adapterId, this.fleetConfig?.defaults?.model),
        this.classicChannels!.getAutoPauseAfter(channelId, adapterId, this.fleetConfig?.defaults?.auto_pause_after),
      );
      return;
    }
    throw new Error(`Instance not found: ${name}`);
  }

  /**
   * Mark an instance so its next daemon start skips session resume. Written AFTER
   * stop (survives the old daemon's cleanup) and BEFORE start so the respawn reads
   * it — reuses the crash-state → resumeDisabled path from crash-loop recovery.
   * One-shot: the daemon deletes it on startup.
   */
  private writeFreshStartMarker(name: string): void {
    try {
      writeFileSync(join(this.getInstanceDir(name), "crash-state.json"), JSON.stringify({ resumeDisabled: true, reason: "pty_error_restart" }));
    } catch (err) {
      this.logger.warn({ err, name }, "freshStart: failed to write crash-state marker");
    }
  }

  /** Load .env file from data dir into process.env */
  private loadEnvFile(): void {
    const envPath = join(this.dataDir, ".env");
    if (!existsSync(envPath)) return;
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      // Accept `export KEY=value` — the shell-style form people paste from their
      // .bashrc. Without this the variable landed in process.env under the key
      // "export KEY" and silently did nothing.
      const key = trimmed.slice(0, eqIdx).replace(/^export\s+/, "").trim();
      const raw = trimmed.slice(eqIdx + 1);
      const value = raw.replace(/^["'](.*)["']$/, '$1');
      // .env file always wins over inherited shell env vars, so that
      // quickstart's newly written token overrides any stale value.
      process.env[key] = value;
    }
  }

  /** Initialize auth before any adapter can answer /dashboard. */
  private initializeWebAuthTokens(): void {
    this.webToken = loadOrCreateWebToken(this.dataDir);
    this.viewToken = randomBytes(24).toString("hex");
    const viewTokenPath = join(this.dataDir, "view.token");
    writeFileSync(viewTokenPath, this.viewToken, { encoding: "utf8", mode: 0o600 });
    try { chmodSync(viewTokenPath, 0o600); } catch { /* best effort */ }
    this.healthServerListening = false;
  }

  getDashboardAccess(): { ready: boolean; token: string | null } {
    return { ready: this.healthServerListening, token: this.webToken };
  }

  beginUpdateProgress(adapter: ChannelAdapter, chatId: string, threadId: string | undefined, messageId: string): void {
    persistUpdateProgress(this.dataDir, {
      adapterId: adapter.id,
      chatId,
      ...(threadId ? { threadId } : {}),
      messageId,
    });
    this.lastUpdateProgressText = null;
    this.updateCompletionTipText = null;
    this.startUpdateProgressMonitor(adapter);
  }

  failUpdateProgress(message: string): void {
    setUpdateProgressStage(this.dataDir, "failed", { error: message });
  }

  /** The old fleet edits CLI install stages; the new fleet adopts the same message below. */
  private startUpdateProgressMonitor(initialAdapter?: ChannelAdapter): void {
    if (this.updateProgressTimer) clearInterval(this.updateProgressTimer);
    const tick = async () => {
      if (this.updateProgressEditRunning) return;
      const marker = readUpdateProgress(this.dataDir);
      if (!marker) {
        if (this.updateProgressTimer) clearInterval(this.updateProgressTimer);
        this.updateProgressTimer = null;
        return;
      }
      const target = marker.progress.target;
      const adapter = this.adapters.get(target.adapterId) ?? (initialAdapter?.id === target.adapterId ? initialAdapter : undefined);
      if (!adapter) return;
      let text = formatUpdateProgress(marker);
      // No-restart updates complete in the old fleet process, so they never
      // reach RestartProgress.finish(). Append the same optional tip here.
      if (marker.progress.stage === "complete" && this.tipsEnabled()) {
        if (this.updateCompletionTipText === null) {
          const tip = this.pickAvailableTip();
          this.updateCompletionTipText = tip ? this.formatTip(tip) : "";
        }
        if (this.updateCompletionTipText) text += `\n\n${this.updateCompletionTipText}`;
      }
      if (text === this.lastUpdateProgressText) return;
      this.updateProgressEditRunning = true;
      try {
        await adapter.editMessage(target.chatId, target.messageId, text, target.threadId);
        this.lastUpdateProgressText = text;
        if (marker.progress.stage === "failed" || marker.progress.stage === "complete") {
          clearUpdateMarker(this.dataDir);
          if (this.updateProgressTimer) clearInterval(this.updateProgressTimer);
          this.updateProgressTimer = null;
        }
      } catch (err) {
        this.logger.warn({ err }, "Failed to edit update progress");
      } finally {
        this.updateProgressEditRunning = false;
      }
    };
    void tick();
    // Poll stages faster than the elapsed-time display. npm verification and
    // service-file refresh can be short; 200ms prevents those stages from being
    // skipped while the text cache still limits normal edits to once per second.
    this.updateProgressTimer = setInterval(() => void tick(), 200);
    this.updateProgressTimer.unref?.();
  }

  /** Start all instances from fleet config */
  async startAll(configPath: string): Promise<void> {
    const startupStartedAt = Date.now();
    FleetManager.signalTarget = this;
    this.startupComplete = false;
    // Cleared here, not at the end of doStopAll: a stop has an async tail, and
    // anything arriving during it is still part of the stop.
    this.shuttingDown = false;
    this.configPath = configPath;
    this.loadEnvFile();

    // Rotate fleet.log if oversized (before any logging)
    rotateLogIfNeeded(join(this.dataDir, "fleet.log"));

    const fleet = this.loadConfig(configPath);
    this.slimFleetConfigAtStartup();
    setLocale(detectLocale(fleet)); // user-facing text language (fleet.yaml defaults.locale / timezone)
    const savedUpdateProgress = readUpdateProgress(this.dataDir);
    const pendingUpdateProgress = savedUpdateProgress
      && savedUpdateProgress.progress.stage !== "failed"
      && savedUpdateProgress.progress.stage !== "complete"
      ? savedUpdateProgress
      : null;
    if (pendingUpdateProgress) {
      setUpdateProgressStage(this.dataDir, "starting", { version: pendingUpdateProgress.progress.version });
    }
    this.initializeWebAuthTokens();
    const topicMode = fleet.channel?.mode === "topic" || !!fleet.channels?.some(ch => ch.mode === "topic");

    // Set tmux socket isolation for custom AGEND_HOME
    const { getTmuxSocketName: getSocket } = await import("./paths.js");
    TmuxManager.setSocketName(getSocket());

    await TmuxManager.ensureSession(getTmuxSession());

    // Pre-flight (advisory, fire-and-forget): warm the per-backend auth cache
    // before instances spawn, so a CLI that comes up on its sign-in screen gets
    // an instant 🔑 verdict instead of decaying into crash/MCP-died noise.
    this.lifecycle.primeAuthVerification(
      Object.values(fleet.instances).map(config =>
        config.backend ?? fleet.defaults?.backend ?? "claude-code"),
    );

    // Start tmux control mode client for idle detection
    if (!this.controlClient) {
      this.controlClient = new TmuxControlClient(getTmuxSession(), 2000, this.logger);
      this.controlClient.start();
    }
    // Stop any running daemons first (their health checks would respawn killed windows)
    for (const [name] of this.daemons) {
      await this.stopInstance(name);
    }

    // Then kill all remaining agend instance windows to prevent orphans.
    // Kill both known instance windows (stale from previous run) and orphaned
    // windows from deleted instances that are no longer in fleet.yaml.
    const agendNames = new Set(Object.keys(fleet.instances));
    agendNames.add("general");
    try {
      const existingWindows = await TmuxManager.listWindows(getTmuxSession());
      for (const w of existingWindows) {
        // Kill known instance windows (will be recreated)
        // Also kill orphaned windows: any window with a topic ID suffix (name-tNNNNN)
        // that isn't in the current config — these are leftovers from deleted instances
        const isKnownInstance = agendNames.has(w.name);
        const isOrphanedInstance = !isKnownInstance && (/-t\d+$/.test(w.name) || /^classic-/.test(w.name));
        if (isKnownInstance || isOrphanedInstance) {
          if (isOrphanedInstance) this.logger.info({ window: w.name }, "Cleaning up orphaned tmux window");
          const tm = new TmuxManager(getTmuxSession(), w.id);
          await tm.killWindow();
        }
      }
    } catch (err) {
      this.logger.debug({ err }, "Startup tmux window cleanup failed (best effort)");
    }

    const pidPath = join(this.dataDir, "fleet.pid");
    writeFileSync(pidPath, String(process.pid), "utf-8");

    this.eventLog = this.openEventLog();

    // Initialize classic channel manager. The primary adapter (channels[0])
    // migrates legacy single-bot entries and names without a suffix. Classic
    // routing does NOT go through the routing engine (single-key, can't hold two
    // bots in one channel) — it resolves per-bot via getInstanceByChannel.
    this.classicChannels = new ClassicChannelManager(this.dataDir, this.logger);
    const classicAdapters = fleet.channels?.length ? fleet.channels : (fleet.channel ? [fleet.channel] : []);
    this.classicChannels.configureAdapters(classicAdapters);
    // Restore the persisted bot binding so replies/cancel go through the right
    // bot after a restart (before this, inbound would re-bind lazily).
    for (const ch of this.classicChannels.getAll()) {
      if (ch.adapterId) this.instanceWorldBinding.set(ch.instanceName, ch.adapterId);
    }

    // Poll classicBot.yaml for external changes every 30s
    this.classicReloadTimer = setInterval(async () => {
      try {
        if (!this.classicChannels) return;
        const fleetBackend = this.fleetConfig?.defaults?.backend;
        const fleetModel = this.fleetConfig?.defaults?.model;
        const oldBackends = new Map<string, string>();
        const oldModels = new Map<string, string | undefined>();
        const oldAutoPause = new Map<string, number | undefined>();
        for (const ch of this.classicChannels.getAll()) {
          oldBackends.set(ch.instanceName, this.classicChannels.getBackendByInstance(ch.instanceName, fleetBackend));
          oldModels.set(ch.instanceName, this.classicChannels.getModel(ch.channelId, ch.adapterId, fleetModel));
          oldAutoPause.set(ch.instanceName, this.classicChannels.getAutoPauseAfter(ch.channelId, ch.adapterId, this.fleetConfig?.defaults?.auto_pause_after));
        }
        if (!this.classicChannels.checkReload()) return;
        this.reregisterClassicChannels();
        for (const ch of this.classicChannels.getAll()) {
          const newBackend = this.classicChannels.getBackendByInstance(ch.instanceName, fleetBackend);
          const newModel = this.classicChannels.getModel(ch.channelId, ch.adapterId, fleetModel);
          const newAutoPause = this.classicChannels.getAutoPauseAfter(ch.channelId, ch.adapterId, this.fleetConfig?.defaults?.auto_pause_after);
          const backendChanged = oldBackends.get(ch.instanceName) !== newBackend;
          const modelChanged = oldModels.get(ch.instanceName) !== newModel;
          const autoPauseChanged = oldAutoPause.get(ch.instanceName) !== newAutoPause;
          if (this.daemons.has(ch.instanceName) && (backendChanged || modelChanged || autoPauseChanged)) {
            this.logger.info(
              { instanceName: ch.instanceName, backendFrom: oldBackends.get(ch.instanceName), backendTo: newBackend, modelFrom: oldModels.get(ch.instanceName), modelTo: newModel },
              "Backend/model changed — restarting",
            );
            await this.stopInstance(ch.instanceName).catch(() => {});
            // Small delay to let tmux window clean up
            await new Promise(r => setTimeout(r, 2000));
            await this.startClassicInstance(
              ch.instanceName,
              newBackend,
              this.classicChannels.getPreTaskCommand(ch.channelId, ch.adapterId),
              newModel,
              newAutoPause,
            ).catch(err =>
              this.logger.warn({ err, instanceName: ch.instanceName }, "Failed to restart classic instance"));
          }
        }
      } catch (err) {
        this.logger.warn({ err }, "classicBot.yaml reload error");
      }
    }, 30_000);

    const costGuardConfig: CostGuardConfig = {
      ...DEFAULT_COST_GUARD,
      ...fleet.defaults.cost_guard,
    };
    this.costGuard = new CostGuard(costGuardConfig, this.eventLog);
    this.costGuard.startMidnightReset();

    const webhookConfigs: WebhookConfig[] = fleet.defaults.webhooks ?? [];
    if (webhookConfigs.length > 0) {
      this.webhookEmitter = new WebhookEmitter(webhookConfigs, this.logger);
      this.logger.info({ count: webhookConfigs.length }, "Webhook emitter initialized");
    }

    this.costGuard.on("warn", safeHandler((instance: string, totalCents: number, limitCents: number) => {
      this.notifyInstanceTopic(instance, t("cost.approaching", instance, formatCents(totalCents), formatCents(limitCents), Math.round(totalCents / limitCents * 100)));
      this.webhookEmitter?.emit("cost_warning", instance, { cost_cents: totalCents, limit_cents: limitCents });
    }, this.logger, "costGuard.warn"));

    this.costGuard.on("limit", safeHandler(async (instance: string, totalCents: number, limitCents: number) => {
      this.notifyInstanceTopic(instance, t("cost.limit_reached", instance, formatCents(limitCents)));
      this.eventLog?.insert(instance, "instance_paused", { reason: "cost_limit", cost_cents: totalCents });
      this.webhookEmitter?.emit("cost_limit", instance, { cost_cents: totalCents, limit_cents: limitCents });
      await this.stopInstance(instance);
    }, this.logger, "costGuard.limit"));

    const summaryConfig: DailySummaryConfig = {
      ...DEFAULT_DAILY_SUMMARY,
      ...fleet.defaults.daily_summary,
    };
    this.dailySummary = new DailySummary(summaryConfig, costGuardConfig.timezone, (text) => {
      if (!this.adapter || !this.fleetConfig?.channel?.group_id) return;
      this.adapter.sendText(String(this.fleetConfig.channel.group_id), text)
        .catch(e => this.logger.warn({ err: e }, "Failed to send daily summary"));
      // Rotate classic channel chat logs daily
      this.classicChannels?.rotateLogs();
      this.rotateInboxes();
      // Rotate fleet.log daily too (besides the startup size check above), so a
      // long-running fleet doesn't accumulate an unbounded log.
      rotateLogIfNeeded(join(this.dataDir, "fleet.log"));
      // Instance output.log is pipe-pane (TUI ANSI). Daemon health ticks rotate a
      // running instance's own log; this sweep is the safety net for every other
      // kind. One implementation, so the two cannot cover different sets.
      this.rotateAllInstanceLogs();
    }, () => {
      const instances = Object.keys(this.fleetConfig?.instances ?? {});
      const costMap = new Map<string, number>();
      for (const name of instances) {
        costMap.set(name, this.costGuard?.getDailyCostCents(name) ?? 0);
      }
      return DailySummary.generateText(
        this.eventLog!,
        instances,
        costMap,
        this.costGuard?.getFleetTotalCents() ?? 0,
      );
    });
    this.dailySummary.start();

    // Rotate classic channel chat logs daily (piggyback on daily summary timer)
    this.classicChannels?.rotateLogs();
    this.rotateInboxes();

    // Auto-create/adopt a general dispatcher — ONLY for the primary adapter.
    const channelConfigs = fleet.channels ?? (fleet.channel ? [fleet.channel] : []);
    this.warnUnboundGeneralChannelIds(fleet);
    const primaryAdapterId = channelConfigs[0] ? (channelConfigs[0].id ?? channelConfigs[0].type) : undefined;
    const generalInstances = Object.entries(fleet.instances).filter(([, inst]) => inst.general_topic === true);
    let generalsCreated = false;

    // Collect unbound generals (no channel_id set) for auto-assignment
    const unboundGenerals = generalInstances.filter(([, inst]) => !inst.channel_id);
    // Track which adapters still need a general
    const needsGeneral: Array<{ adapterId: string; ch: typeof channelConfigs[0] }> = [];

    for (const ch of channelConfigs) {
      const adapterId = ch.id ?? ch.type;
      // Only the primary adapter gets an auto-general. Secondary (persona) bots
      // answer for their explicitly-bound instances only — they don't need or
      // auto-claim a general dispatcher, and must never adopt the primary's
      // unbound general. A general a user manually bound to a secondary
      // (channel_id: <persona>) is left untouched — the auto logic just won't
      // create or reassign bindings for non-primary adapters.
      if (adapterId !== primaryAdapterId) continue;
      // Check if any general is explicitly bound to this adapter
      if (generalInstances.some(([, inst]) => inst.channel_id === adapterId)) continue;
      // Check if any general matches by name heuristic
      if (generalInstances.some(([name]) => name.includes(adapterId))) continue;
      // For single-channel setups, accept any general
      if (channelConfigs.length === 1 && generalInstances.length > 0) continue;
      needsGeneral.push({ adapterId, ch });
    }

    // Phase 1: Adopt unbound generals by topic_id match (most accurate)
    for (const need of [...needsGeneral]) {
      const matchIdx = unboundGenerals.findIndex(([, inst]) => {
        const topicId = String(inst.topic_id ?? "");
        if (need.ch.type === "discord" && need.ch.options?.general_channel_id) {
          return topicId === String(need.ch.options.general_channel_id);
        }
        if (need.ch.type === "telegram") {
          return topicId === "1" || topicId === "";
        }
        return false;
      });
      if (matchIdx >= 0) {
        const [[unboundName, unboundInst]] = unboundGenerals.splice(matchIdx, 1);
        unboundInst.channel_id = need.adapterId;
        this.logger.info({ adapter: need.adapterId, name: unboundName }, "Bound existing general to adapter (topic_id match)");
        needsGeneral.splice(needsGeneral.indexOf(need), 1);
        generalsCreated = true;
      }
    }

    // Phase 2: Adopt remaining unbound generals (first-come)
    for (const need of [...needsGeneral]) {
      if (unboundGenerals.length > 0) {
        const [[unboundName, unboundInst]] = unboundGenerals.splice(0, 1);
        unboundInst.channel_id = need.adapterId;
        this.logger.info({ adapter: need.adapterId, name: unboundName }, "Bound existing general to adapter");
        needsGeneral.splice(needsGeneral.indexOf(need), 1);
        generalsCreated = true;
        continue;
      }
      break;
    }

    // Phase 3: Create new generals for any remaining adapters
    for (const need of needsGeneral) {
      const name = channelConfigs.length > 1 ? `general-${need.adapterId}` : "general";
      if (fleet.instances[name]) continue;
      this.logger.warn({ adapter: need.adapterId, name }, "No general instance for adapter — auto-creating");
      const generalDir = join(getAgendHome(), name);
      mkdirSync(generalDir, { recursive: true });
      const backendName = fleet.defaults.backend ?? "claude-code";
      this.ensureGeneralInstructions(generalDir, backendName, name);
      fleet.instances[name] = {
        ...DEFAULT_INSTANCE_CONFIG,
        working_directory: generalDir,
        general_topic: true,
        channel_id: need.adapterId,
      };
      generalsCreated = true;
    }
    if (generalsCreated) this.saveFleetConfig();

    if (topicMode && (fleet.channel || fleet.channels?.length)) {
      const schedulerConfig: SchedulerConfig = {
        ...DEFAULT_SCHEDULER_CONFIG,
        ...this.fleetConfig?.defaults.scheduler,
      };

      this.scheduler = new Scheduler(
        join(this.dataDir, "scheduler.db"),
        (schedule) => this.handleScheduleTrigger(schedule),
        schedulerConfig,
        (name) => this.fleetConfig?.instances?.[name] != null || !!this.classicChannels?.getAll().some(ch => ch.instanceName === name),
      );
      this.scheduler.init();
      this.logger.info("Scheduler initialized");

      // Tips share the daily-report clock but remain an independent internal
      // job: disabling daily_summary must not disable tips (and vice versa).
      // The callback checks defaults.tips at fire time, so /tips on|off is hot.
      this.dailyTipScheduler = new DailyTipScheduler(
        summaryConfig,
        costGuardConfig.timezone,
        () => this.sendTipToGeneral().catch(err => {
          this.logger.warn({ err }, "Failed to send daily tip");
        }),
      );
      this.dailyTipScheduler.start();

      // Inject active decisions as env var for MCP instructions.
      // Snapshotted at startup — new decisions via post_decision are available
      // through list_decisions tool but not auto-injected until restart.
      try {
        const decisions = this.scheduler.db.listAllActiveDecisions();
        if (decisions.length > 0) {
          const capped = decisions.slice(0, 20).map(d => ({ title: d.title, content: (d.content ?? "").slice(0, 200), scope: d.scope, project_root: d.project_root }));
          process.env.AGEND_DECISIONS = JSON.stringify(capped);
          this.logger.info({ count: decisions.length, injected: capped.length }, "Injected active decisions into env");
        }
      } catch (err) {
        this.logger.debug({ err }, "Decision injection skipped (no decisions db or query failed)");
      }
    }

    // Phase 1: Start general instances first and wait for them
    const allEntries = Object.entries(fleet.instances);
    const generals = allEntries.filter(([_, cfg]) => cfg.general_topic);
    const others = allEntries.filter(([_, cfg]) => !cfg.general_topic);
    const startupProgress = new RestartProgress(
      this.runnableStartupCount(fleet, topicMode),
      pendingUpdateProgress?.startedAt ?? startupStartedAt,
      this.logger,
      { mode: pendingUpdateProgress ? "update" : "restart" },
    );

    if (generals.length > 0) {
      for (const [name, cfg] of generals) {
        try {
          await this.startInstance(name, cfg, topicMode);
          if (this.daemons.has(name)) startupProgress.markReady();
        } catch (err) {
          this.logger.error({ err, name }, "Failed to start general instance");
          const errorMsg = err instanceof Error ? err.message : String(err);
          const topicId = cfg.topic_id ? String(cfg.topic_id) : undefined;
          if (this.adapter && topicId) {
            const chatId = this.adapter.getChatId?.() ?? "";
            if (chatId) {
              this.adapter.sendText(chatId, t("general.start_failed", name, errorMsg), { threadId: topicId }).catch(() => {});
            }
          }
        }
      }
    }

    // The adapter must exist before General can receive the progress message.
    // Start it after General is ready, in parallel with the remaining CLIs, so
    // progress is visible without adding adapter startup time to the critical path.
    let adapterStartup: Promise<void> | null = null;
    let progressStart: Promise<boolean> = Promise.resolve(false);
    if (topicMode && (fleet.channel || fleet.channels?.length)) {
      // An adapter becoming reachable during startup can receive messages; make
      // all existing topic ids routable before opening that inbound path.
      this.routing.rebuild(fleet);
      this.reregisterClassicChannels();
      adapterStartup = (async () => {
        try {
          await this.startSharedAdapter(fleet);
        } catch (err) {
          this.logger.error({ err }, "startSharedAdapter failed — fleet continues without some adapters");
        }
      })();
      progressStart = adapterStartup.then(() => {
        if (pendingUpdateProgress) {
          const saved = pendingUpdateProgress.progress.target;
          const adapter = this.adapters.get(saved.adapterId);
          const target = adapter ? {
            adapter,
            chatId: saved.chatId,
            threadId: saved.threadId,
          } : null;
          return startupProgress.resume(target, saved.messageId);
        }
        return startupProgress.start(this.restartProgressTarget());
      });
    }

    // The systemd watchdog answers exactly one question: is this process still
    // turning its event loop? Pinging from a timer proves that, and after the
    // blocking child-process calls were made async it is a meaningful signal —
    // a deadlocked or frozen fleet stops pinging and systemd restarts it.
    //
    // It deliberately does NOT gate on fleet health. "No adapter connected" or
    // "an instance crashed" must not kill the process: the fleet would be restarted
    // into the same broken state, and a user who has legitimately stopped every
    // instance would get a restart loop. Those conditions surface through /health
    // (which now returns 503) and through the General-topic notifications instead.
    this.watchdogTimer = setInterval(() => sdNotify("WATCHDOG=1"), 30_000);

    // EventLog.prune() existed but was never called, so `events` and `activity`
    // grew without bound for the life of the install. Prune once at startup and
    // daily after that; the timer is unref'd so it never holds the loop open.
    this.pruneEventLog();
    this.eventLogPruneTimer = setInterval(() => this.pruneEventLog(), 24 * 60 * 60_000);
    this.eventLogPruneTimer.unref?.();

    // Same shape for pipe-pane logs, and for the same reason: the only sweep that
    // covered them lived inside the daily-summary callback, so it did not run at
    // all when summaries were off.
    this.rotateAllInstanceLogs();
    this.logRotateTimer = setInterval(() => this.rotateAllInstanceLogs(), 24 * 60 * 60_000);
    this.logRotateTimer.unref?.();

    // Phase 2: Start remaining instances with staggered concurrency
    if (others.length > 0) {
      await this.startInstancesWithConcurrency(others, topicMode, () => startupProgress.markReady());
    }

    if (topicMode && (fleet.channel || fleet.channels?.length)) {
      await adapterStartup;

      // Bind every fleet instance deterministically. Explicit channel_id wins;
      // otherwise channels[0] is authoritative. Do not infer identity from
      // concurrent adapter startup or whichever bot receives a message first.
      const primaryAdapterId = this.getPrimaryAdapterId();
      for (const [name, config] of Object.entries(fleet.instances)) {
        const adapterId = config.channel_id ?? primaryAdapterId;
        if (adapterId) this.bindInstanceAdapter(name, adapterId);
      }

      // Guard against a stale/invalid general topic_id. An old auto-general
      // could have written the TG-convention "1" for a Discord general; the DC
      // adapter then throws fetching channel "1" → unhandled → fleet crash loop.
      // Unbind (+ warn) so it's simply skipped, never routed to a bogus channel.
      let fixedGeneral = false;
      for (const [name, cfg] of Object.entries(this.fleetConfig!.instances)) {
        if (!cfg.general_topic || cfg.topic_id == null) continue;
        const adapterId = this.getInstanceAdapterId(name);
        if (this.getChannelConfig(adapterId)?.type === "discord" && !/^\d{17,}$/.test(String(cfg.topic_id))) {
          this.logger.warn({ name, topic_id: cfg.topic_id }, "Discord general topic_id is not a valid channel — unbinding to avoid a crash loop");
          delete (cfg as { topic_id?: unknown }).topic_id;
          fixedGeneral = true;
        }
      }
      if (fixedGeneral) this.saveFleetConfig();

      // Auto-create topics AFTER adapter is ready (needs adapter.createTopic)
      await this.topicCommands.autoCreateTopics();
      const routeSummary = this.routing.rebuild(this.fleetConfig!);
      this.reregisterClassicChannels();
      this.logger.info(`Routes: ${routeSummary}`);

      // Resolve topic icon emoji IDs and start idle archive poller
      await this.resolveTopicIcons();
      this.topicArchiver.startPoller();

      // IPC is already wired by startInstancesWithConcurrency → startInstance →
      // connectIpcToInstance. The previous 3s sleep + connectToInstances loop
      // was redundant.

      // Start classic channel instances (parallel, concurrency 3)
      if (this.classicChannels) {
        const fleetBackend = this.fleetConfig?.defaults?.backend;
        const channels = this.classicChannels.getAll()
          .filter(ch => !this.lifecycle.isPaused(ch.instanceName));
        const concurrency = 3;
        let idx = 0;
        while (idx < channels.length) {
          const batch = channels.slice(idx, idx + concurrency);
          await Promise.allSettled(batch.map(async ch => {
            try {
              await this.startClassicInstance(
                ch.instanceName,
                this.classicChannels!.getBackendByInstance(ch.instanceName, fleetBackend),
                this.classicChannels!.getPreTaskCommand(ch.channelId, ch.adapterId),
                this.classicChannels!.getModel(ch.channelId, ch.adapterId, this.fleetConfig?.defaults?.model),
                this.classicChannels!.getAutoPauseAfter(ch.channelId, ch.adapterId, this.fleetConfig?.defaults?.auto_pause_after),
              );
              if (this.daemons.has(ch.instanceName)) startupProgress.markReady();
            } catch (err) {
              this.logger.warn({ err, instanceName: ch.instanceName }, "Failed to start classic instance");
            }
          }));
          idx += concurrency;
        }
      }

      for (const name of Object.keys(fleet.instances)) {
        this.startStatuslineWatcher(name);
      }

      // Notify General topic that fleet is up
      const configuredNames = this.configuredStartupInstanceNames(fleet, topicMode);
      const total = configuredNames.length;
      const started = configuredNames.filter(name => this.daemons.has(name)).length;
      const allNotRunning = configuredNames.filter(name => !this.daemons.has(name));
      const pausedNames = allNotRunning.filter(n => this.lifecycle.isPaused(n));
      const failedNames = allNotRunning.filter(n => !this.lifecycle.isPaused(n));
      const generalName = this.findGeneralInstance();
      const generalThreadId = generalName ? fleet.instances[generalName]?.topic_id : undefined;
      const { createRequire } = await import("node:module");
      const _require = createRequire(import.meta.url);
      const agendVersion = _require("../package.json").version ?? "unknown";
      await progressStart;
      const progressCompleted = await startupProgress.finish({
        running: started,
        total,
        version: agendVersion,
        pausedNames,
        failedNames,
        tipText: pendingUpdateProgress && this.tipsEnabled()
          ? (() => {
              const tip = this.pickAvailableTip();
              return tip ? this.formatTip(tip) : undefined;
            })()
          : undefined,
      });
      if (!progressCompleted && this.adapter && fleet.channel?.group_id) {
        let text: string;
        if (failedNames.length === 0 && pausedNames.length === 0) {
          text = t("fleet.ready", started, total, agendVersion);
        } else if (failedNames.length === 0) {
          text = t("fleet.ready", started, total, agendVersion) + `\n⏸ Paused: ${pausedNames.join(", ")}`;
        } else {
          text = t("fleet.ready_with_failed", started, total, agendVersion, failedNames.join(", "))
            + (pausedNames.length > 0 ? `\n⏸ Paused: ${pausedNames.join(", ")}` : "");
        }
        this.adapter.sendText(String(fleet.channel.group_id), text, {
          threadId: generalThreadId != null ? String(generalThreadId) : undefined,
        }).catch(e => this.logger.warn({ err: e }, "Failed to send fleet start notification"));
      }
    }

    // Health HTTP endpoint
    this.startHealthServer(fleet.health_port ?? 19280);

    // Daily update check — first check after 1 hour, then every 24 hours
    this.updateCheckTimer = setTimeout(() => {
      this.checkForUpdates();
      this.updateCheckTimer = setInterval(() => this.checkForUpdates(), 24 * 60 * 60 * 1000);
    }, 60 * 60 * 1000);

    const onRestart = () => {
      this.logger.info("Received SIGUSR2, initiating graceful restart...");
      this.restartInstances()
        .catch(err => this.logger.error({ err }, "Graceful restart failed"))
        .finally(() => process.once("SIGUSR2", onRestart));
    };
    process.once("SIGUSR2", onRestart);

    // SIGUSR1: full process reload (graceful stop → exit → CLI restarts)
    const onFullRestart = () => {
      this.logger.info("Received SIGUSR1, initiating full restart (process reload)...");
      this.gracefulShutdownForReload()
        .then(() => {
          this.logger.info("Full restart: shutdown complete, exiting for reload");
          process.exit(0);
        })
        .catch(err => {
          this.logger.error({ err }, "Full restart: graceful shutdown failed");
          process.exit(1);
        });
    };
    process.once("SIGUSR1", onFullRestart);

    // A SIGHUP may arrive after the PID/general is available but before the
    // rest of startup finishes. Replay one coalesced reload only after all
    // startup-owned lifecycle work and signal handlers are in place.
    this.finishStartup();

    // Tell systemd we are ready only now. This used to fire right after the
    // generals started — before adapters, classic instances, topic creation and the
    // health server — so `systemctl start` returned success while the fleet was
    // still deaf: no path existed for a user message to arrive.
    sdNotify("READY=1");
    const health = this.getFleetHealth();
    if (health.status !== "ok") {
      this.logger.warn({ health }, "Fleet started with problems — see /health");
    }
  }

  /**
   * Delete inbox files older than retentionDays (by mtime). Cleans the shared
   * inbox (`<dataDir>/inbox`) and every workspace inbox
   * (`<agendHome>/workspaces/*\/inbox`). Piggybacks on the daily summary timer,
   * mirroring classic chat-log rotation (same 7-day retention).
   */
  private rotateInboxes(retentionDays = 7): number {
    const cutoff = Date.now() - retentionDays * 86400_000;
    const dirs: string[] = [join(this.dataDir, "inbox")];
    const workspacesDir = join(getAgendHome(), "workspaces");
    if (existsSync(workspacesDir)) {
      for (const ws of readdirSync(workspacesDir)) {
        dirs.push(join(workspacesDir, ws, "inbox"));
      }
    }
    let deleted = 0;
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        const full = join(dir, file);
        try {
          const st = statSync(full);
          if (st.isFile() && st.mtimeMs < cutoff) { unlinkSync(full); deleted++; }
        } catch { /* file vanished or unreadable — skip */ }
      }
    }
    if (deleted > 0) this.logger.info({ deleted }, "Rotated inbox files");
    return deleted;
  }

  /** Start the shared channel adapter(s) for topic mode */
  private async startSharedAdapter(fleet: FleetConfig): Promise<void> {
    const channelConfigs = fleet.channels ?? (fleet.channel ? [fleet.channel] : []);
    if (channelConfigs.length === 0) return;

    // Start ALL adapters in parallel — any single failure doesn't block others.
    const results = await Promise.allSettled(
      channelConfigs.map((cfg, i) =>
        i === 0
          ? this.startSingleAdapter(fleet, cfg)
          : this.startAdditionalAdapter(cfg)
      )
    );

    // Track state + schedule background retry for failures.
    for (let i = 0; i < channelConfigs.length; i++) {
      const adapterId = channelConfigs[i].id ?? channelConfigs[i].type;
      if (results[i].status === "fulfilled") {
        this.adapterState.set(adapterId, { status: "connected", retryCount: 0 });
      } else {
        const err = (results[i] as PromiseRejectedResult).reason;
        this.logger.error({ adapterId, err: (err as Error)?.message ?? err }, "Adapter startup failed — scheduling background retry");
        this.adapterState.set(adapterId, { status: "retrying", retryCount: 0, lastError: (err as Error)?.message ?? String(err) });
        this.scheduleAdapterRetry(adapterId, channelConfigs[i], i === 0 ? fleet : undefined);
        // Notify admin via whichever adapter is already up
        this.notifyAdapterFailure(adapterId, (err as Error)?.message ?? String(err));
      }
    }
  }

  /** Exponential backoff retry for a single failed adapter (background, non-blocking). */
  private scheduleAdapterRetry(adapterId: string, channelConfig: ChannelConfig, fleet?: FleetConfig): void {
    const MAX_RETRIES = 10;
    const INITIAL_DELAY_MS = 5_000;
    const MAX_DELAY_MS = 5 * 60_000;

    const state = this.adapterState.get(adapterId);
    if (!state || state.retryCount >= MAX_RETRIES) {
      if (state) {
        state.status = "failed";
        this.logger.error({ adapterId, retries: state.retryCount }, "Adapter retry exhausted — giving up");
        this.notifyAdapterFailure(adapterId, `Retry exhausted after ${state.retryCount} attempts. Check token/network and restart fleet.`);
      }
      return;
    }

    const delay = Math.min(INITIAL_DELAY_MS * Math.pow(2, state.retryCount), MAX_DELAY_MS);
    this.logger.info({ adapterId, attempt: state.retryCount + 1, delay_ms: delay }, "Scheduling adapter retry");

    state.retryTimer = setTimeout(async () => {
      state.retryCount++;
      try {
        if (fleet) {
          await this.startSingleAdapter(fleet, channelConfig);
        } else {
          await this.startAdditionalAdapter(channelConfig);
        }
        state.status = "connected";
        state.lastError = undefined;
        this.logger.info({ adapterId, attempts: state.retryCount }, "Adapter reconnected on retry");
        this.notifyAdapterRecovery(adapterId, state.retryCount);
      } catch (err) {
        state.lastError = (err as Error)?.message ?? String(err);
        this.logger.warn({ adapterId, attempt: state.retryCount, err: state.lastError }, "Adapter retry failed");
        this.scheduleAdapterRetry(adapterId, channelConfig, fleet);
      }
    }, delay);
  }

  /** Notify admin about adapter failure (uses any available adapter). */
  private notifyAdapterFailure(adapterId: string, error: string): void {
    const generalId = this.findGeneralInstance();
    if (generalId) {
      this.notifyInstanceTopic(generalId, t("adapter.start_failed", adapterId, error));
    }
  }

  /** Notify admin that a retried adapter reconnected. */
  private notifyAdapterRecovery(adapterId: string, attempts: number): void {
    const generalId = this.findGeneralInstance();
    if (generalId) {
      this.notifyInstanceTopic(generalId, t("adapter.reconnected", adapterId, attempts));
    }
  }

  /** Get adapter states for /status visibility. */
  getAdapterStates(): Map<string, { status: string; retryCount: number; lastError?: string }> {
    return this.adapterState;
  }

  /**
   * Real, checkable fleet health for `/health` and the operator.
   *
   * `status` is:
   *  - `ok`       — at least one adapter connected and every configured instance
   *                 that should be running is running
   *  - `degraded` — reachable, but something the operator should look at (an
   *                 adapter retrying, an instance crashed or stopped)
   *  - `down`     — the fleet cannot do its job: no adapter is connected, so no
   *                 message can arrive or be answered
   *
   * Deliberately does NOT gate the systemd watchdog — see the comment at the
   * WATCHDOG timer for why.
   */
  getFleetHealth(): {
    status: "ok" | "degraded" | "down";
    uptime: number;
    instances: { configured: number; running: number; crashed: number; paused: number; stopped: number };
    adapters: { total: number; connected: number; states: Record<string, string> };
    startupComplete: boolean;
    /** See process-memory.ts: the fleet process and the whole service cgroup are
     *  reported separately because they differ by ~60x and only one of them can
     *  show a fleet-manager leak. */
    memory: FleetMemory;
    problems: string[];
  } {
    const names = Object.keys(this.fleetConfig?.instances ?? {});
    const counts = { configured: names.length, running: 0, crashed: 0, paused: 0, stopped: 0 };
    for (const name of names) {
      const state = this.getInstanceStatus(name);
      if (state === "running") counts.running++;
      else if (state === "crashed") counts.crashed++;
      else if (state === "paused") counts.paused++;
      else counts.stopped++;
    }

    const states: Record<string, string> = {};
    let connected = 0;
    for (const [id, state] of this.adapterState) {
      states[id] = state.status;
      if (state.status === "connected") connected++;
    }

    const problems: string[] = [];
    if (this.adapterState.size > 0 && connected === 0) problems.push("no channel adapter is connected");
    if (counts.crashed > 0) problems.push(`${counts.crashed} instance(s) crashed`);
    for (const [id, state] of this.adapterState) {
      if (state.status !== "connected") problems.push(`adapter ${id} is ${state.status}`);
    }
    if (!this.startupComplete) problems.push("startup has not completed");

    // "down" is reserved for "cannot receive or answer a message at all". A fleet
    // with adapters configured but none connected is exactly that.
    const status = this.adapterState.size > 0 && connected === 0
      ? "down"
      : problems.length > 0 ? "degraded" : "ok";

    return {
      status,
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      instances: counts,
      adapters: { total: this.adapterState.size, connected, states },
      startupComplete: this.startupComplete,
      memory: readFleetMemory(),
      problems,
    };
  }

  /** Start the primary adapter (backward-compatible, sets this.adapter) */
  private async startSingleAdapter(fleet: FleetConfig, channelConfig: ChannelConfig): Promise<void> {
    const botToken = process.env[channelConfig.bot_token_env];
    if (!botToken) {
      this.logger.warn({ env: channelConfig.bot_token_env }, "Bot token env not set, skipping shared adapter");
      return;
    }

    const accessDir = join(this.dataDir, "access");
    mkdirSync(accessDir, { recursive: true });
    const accessManager = new AccessManager(
      channelConfig.access ?? DEFAULT_OPEN_ACCESS,
      join(accessDir, "access.json"),
    );
    this.accessManager = accessManager;
    const inboxDir = join(this.dataDir, "inbox");
    mkdirSync(inboxDir, { recursive: true });

    const adapterId = channelConfig.id ?? channelConfig.type;
    this.adapter = await createAdapter(channelConfig, {
      id: adapterId,
      botToken,
      accessManager,
      inboxDir,
    });
    const world = new AdapterWorld(adapterId, this.adapter, accessManager, channelConfig);
    this.worlds.set(adapterId, world);
    (this.adapters as Map<string, ChannelAdapter>).set(adapterId, this.adapter);

    this.adapter.on("message", safeHandler(async (msg: InboundMessage) => {
      await this.handleInboundMessage(msg);
    }, this.logger, "adapter.message"));

    this.adapter.on("reaction", safeHandler(async (r: InboundReaction) => {
      await this.handleInboundReaction(r);
    }, this.logger, "adapter.reaction"));

    this.adapter.on("callback_query", safeHandler(async (data: AdapterCallbackData) => {
      if (await this.handleTipDismiss(data, adapterId, this.adapter ?? undefined)) return;
      if (await this.handleTipUnlock(data, adapterId, this.adapter ?? undefined)) return;
      if (await this.handleLoginBackendSelect(data, adapterId, this.adapter ?? undefined)) return;
      if (await this.handleLoginMenuSelect(data, adapterId, this.adapter ?? undefined)) return;
      if (await this.handleLoginConfirm(data, adapterId, this.adapter ?? undefined)) return;
      if (await this.handleInstallLoginConfirm(data, adapterId, this.adapter ?? undefined)) return;
      if (await this.handleClearConfirmation(data, adapterId, this.adapter ?? undefined)) return;
      if (await this.handleExitRestartPrompt(data, adapterId, this.adapter ?? undefined)) return;
      if (await this.handleInteractivePromptAssist(data, adapterId, this.adapter ?? undefined)) return;
      if (await this.handleClassicBackendSelection(data)) return;
      if (await this.handleModelSelection(data)) return;
      if (await this.handleEffortSelection(data)) return;
      if (await this.handleHangPrompt(data, adapterId, this.adapter ?? undefined)) return;
      if (data.callbackData.startsWith("cancel:")) {
        this.handleCancelClick(data.callbackData.slice("cancel:".length), this.adapter, data);
        return;
      }
    }, this.logger, "adapter.callback_query"));

    this.adapter.on("topic_closed", safeHandler(async (data: { chatId: string; threadId: string }) => {
      // Skip unbind if we archived this topic ourselves
      if (this.topicArchiver.isArchived(data.threadId)) return;
      await this.topicCommands.handleTopicDeleted(data.threadId);
    }, this.logger, "adapter.topic_closed"));

    // Handle classic bot slash commands (/start, /stop, /chat, /compact, /save, /load)
    this.adapter.on("slash_command", safeHandler(async (data: ClassicStartSlashData) => {
      if (data.command === "start") {
        await this.handleClassicStartSlash(data, adapterId);
      } else if (data.command === "stop") {
        const reply = await this.handleClassicStop(data.channelId, adapterId);
        await data.respond(reply);
      } else if (data.command === "pause" || data.command === "wake") {
        await this.handlePauseWakeSlash(data, adapterId);
      } else if (data.command === "chat") {
        const text = data.text ?? "";
        if (!text) { await data.respond(t("chat.usage")); return; }
        const name = this.classicChannels?.getInstanceByChannel(data.channelId, adapterId);
        if (!name) {
          await data.respond(t("classic.no_agent_start"));
          return;
        }
        const replyMsgId = await data.respond("👀");
        const username = data.username ?? data.userId;
        ClassicChannelManager.logMessage(name, username, `/chat ${text}`, new Date());
        await this.forwardToClassicInstance(name, text, {
          chatId: data.channelId,
          threadId: data.channelId,
          messageId: replyMsgId ?? "",
          userId: data.userId,
          username,
          source: "discord",
          timestamp: new Date(),
        });
      } else if (data.command === "save") {
        await this.handleSlashSave(data, adapterId);
      } else if (data.command === "load") {
        // load is kiro-cli/classic only — no claude-code equivalent.
        if (!this.classicChannels?.isAdmin(data.userId)) {
          await data.respond(t("admin.required"));
          return;
        }
        const name = this.classicChannels?.getInstanceByChannel(data.channelId, adapterId);
        if (!name) {
          await data.respond(t("classic.no_agent_start"));
          return;
        }
        const filename = data.options?.filename as string;
        if (!SAVE_FILENAME_RE.test(filename ?? "")) { await data.respond(t("filename.invalid")); return; }
        this.pasteRawToClassicInstance(name, `/chat load ${filename}`);
        await data.respond(t("save.sent", `/chat load ${filename}`, name));
      } else if (data.command === "compact") {
        const name = this.resolveSlashTarget(data.channelId, adapterId);
        if (!name) { await data.respond(t("classic.no_agent")); return; }
        const result = await this.topicCommands.sendCompact(name);
        await data.respond(result);
      } else if (data.command === "steer") {
        const name = this.resolveSlashTarget(data.channelId, adapterId);
        if (!name) { await data.respond(t("classic.no_agent")); return; }
        const steerText = String(data.options?.message ?? "").trim();
        if (!steerText) { await data.respond(t("steer.usage")); return; }
        // chat_id/message_id stay empty: a slash interaction has no channel
        // message to react to, and an empty chat_id keeps updateLastChat from
        // rerouting the instance's replies to the slash context.
        const result = this.topicCommands.sendSteer(name, steerText, {
          chatId: "", messageId: "", username: data.username ?? "user",
          userId: data.userId ?? "", threadId: undefined, adapterId, source: "discord",
        });
        await data.respond(result);
      } else if (data.command === "btw") {
        const name = this.resolveSlashTarget(data.channelId, adapterId);
        if (!name) { await data.respond(t("classic.no_agent")); return; }
        const btwText = String(data.options?.message ?? "").trim();
        if (!btwText) { await data.respond(t("btw.usage")); return; }
        const result = this.topicCommands.sendBtw(name, btwText, {
          chatId: "", messageId: "", username: data.username ?? "user",
          userId: data.userId ?? "", threadId: undefined, adapterId, source: "discord",
        });
        await data.respond(result);
      } else if (data.command === "login") {
        await this.handleLoginSlash(data, adapterId, this.adapter!);
      } else if (data.command === "install-cli") {
        await this.handleInstallCliSlash(data, adapterId, this.adapter!);
      } else if (data.command === "clear") {
        await this.handleClearSlash(data, adapterId);
      } else if (data.command === "model") {
        await this.handleModelSlash(data, adapterId);
      } else if (data.command === "effort") {
        await this.handleEffortSlash(data, adapterId);
      } else if (data.command === "cancel") {
        const name = this.resolveSlashTarget(data.channelId, adapterId);
        if (!name) { await data.respond(t("classic.no_agent")); return; }
        const ok = this.cancelInstance(name);
        await data.respond(ok ? t("cancel.sent", name) : t("cancel.not_running", name));
      } else if (data.command === "ctx") {
        const name = this.resolveSlashTarget(data.channelId, adapterId);
        if (!name) {
          await data.respond(t("classic.no_agent"));
          return;
        }
        // Single source of truth (statusline.json + robust tmux pane fallback).
        await data.respond(await this.topicCommands.getCtxText(name));
      } else if (data.command === "collab") {
        // Classic no longer lives in the routing engine, so a routing hit here is
        // always a fleet-topic instance.
        const collabTarget = this.routing.resolve(data.channelId);
        if (collabTarget) {
          const allowed = this.fleetConfig?.channel?.access?.allowed_users ?? [];
          if (allowed.length > 0 && !allowed.some(u => String(u) === String(data.userId))) {
            await data.respond(t("not_authorized"));
            return;
          }
          const isCollab = this.toggleFleetCollab(collabTarget.name);
          await data.respond(isCollab ? t("collab.on") : t("collab.off"));
          return;
        }
        if (!this.classicChannels?.isAdmin(data.userId)) {
          await data.respond(t("admin.required"));
          return;
        }
        if (!this.classicChannels.isClassicChannel(data.channelId, adapterId)) {
          await data.respond(t("classic.no_agent_start"));
          return;
        }
        const newState = this.classicChannels.toggleCollab(data.channelId, adapterId);
        await data.respond(newState
          ? t("collab.on.classic")
          : t("collab.off.classic"));
      } else if (data.command === "update") {
        await this.handleUpdateSlash(data, adapterId);
      } else if (data.command === "doctor") {
        const allowed = this.fleetConfig?.channel?.access?.allowed_users ?? [];
        if (allowed.length > 0 && !allowed.some(u => String(u) === String(data.userId))) {
          await data.respond(t("not_authorized"));
          return;
        }
        await data.respond(await this.runBackendDoctor());
      } else if (data.command === "usage") {
        // Same permission level as /ctx (none). The reply is still ephemeral —
        // the adapter defers non-chat commands that way — so it never spams the
        // channel either way.
        try {
          const { getUsageSnapshot } = await import("./usage/usage-api.js");
          const { renderUsageMarkdown } = await import("./usage/format-rich.js");
          // slash_command is Discord-only; editReply renders Markdown natively.
          await data.respond(renderUsageMarkdown(await getUsageSnapshot(false, this.getActiveUsageProviderIds())));
        } catch (err) {
          await data.respond(t("usage.failed", (err as Error).message));
        }
      } else if (data.command === "tips") {
        await this.handleTipsSlash(data, adapterId);
      } else if (data.command === "status") {
        // Admin-gated (like the topic path): the merged table shows every
        // instance's cost and IPC health.
        if (!this.isFleetAdmin(data.userId, adapterId)) {
          await data.respond(t("cmd.admin_required", "/status"));
          return;
        }
        const text = await this.topicCommands.getStatusText();
        await data.respond(text);
      } else if (data.command === "sysinfo") {
        await data.respond(this.topicCommands.getSysInfoText());
      } else if (data.command === "dashboard") {
        // Reply is ephemeral (adapter defers non-chat commands ephemerally), so
        // the web-token-bearing URLs are only visible to the caller.
        const allowed = this.fleetConfig?.channel?.access?.allowed_users ?? [];
        if (allowed.length === 0) { await data.respond(t("dashboard.disabled")); return; }
        if (!allowed.some(u => String(u) === String(data.userId))) { await data.respond(t("not_authorized")); return; }
        await data.respond(this.topicCommands.getDashboardText());
      } else if (data.command === "restart") {
        const allowed = this.fleetConfig?.channel?.access?.allowed_users ?? [];
        if (allowed.length > 0 && !allowed.some(u => String(u) === String(data.userId))) {
          await data.respond(t("not_authorized"));
          return;
        }
        await data.respond(t("restart.graceful"));
        process.kill(process.pid, "SIGUSR2");
      } else if (data.command === "compact") {
        const name = this.resolveSlashTarget(data.channelId, adapterId);
        if (!name) { await data.respond(t("classic.no_agent")); return; }
        const result = await this.topicCommands.sendCompact(name);
        await data.respond(result);
      } else if (data.command === "steer") {
        const name = this.resolveSlashTarget(data.channelId, adapterId);
        if (!name) { await data.respond(t("classic.no_agent")); return; }
        const steerText = String(data.options?.message ?? "").trim();
        if (!steerText) { await data.respond(t("steer.usage")); return; }
        // chat_id/message_id stay empty: a slash interaction has no channel
        // message to react to, and an empty chat_id keeps updateLastChat from
        // rerouting the instance's replies to the slash context.
        const result = this.topicCommands.sendSteer(name, steerText, {
          chatId: "", messageId: "", username: data.username ?? "user",
          userId: data.userId ?? "", threadId: undefined, adapterId, source: "discord",
        });
        await data.respond(result);
      } else if (data.command === "btw") {
        const name = this.resolveSlashTarget(data.channelId, adapterId);
        if (!name) { await data.respond(t("classic.no_agent")); return; }
        const btwText = String(data.options?.message ?? "").trim();
        if (!btwText) { await data.respond(t("btw.usage")); return; }
        const result = this.topicCommands.sendBtw(name, btwText, {
          chatId: "", messageId: "", username: data.username ?? "user",
          userId: data.userId ?? "", threadId: undefined, adapterId, source: "discord",
        });
        await data.respond(result);
      } else if (data.command === "login") {
        await this.handleLoginSlash(data, adapterId, this.adapter!);
      } else if (data.command === "install-cli") {
        await this.handleInstallCliSlash(data, adapterId, this.adapter!);
      }
    }, this.logger, "adapter.slash_command"));

    await this.topicCommands.registerBotCommands().catch(e =>
      this.logger.warn({ err: e }, "registerBotCommands failed (non-fatal)"));

    // Background-probe each backend's CLI env (version/models) → cli-env cache.
    // Non-blocking: /model & status views read the cache; never delays startup.
    this.probeCliEnvs();

    this.adapter.on("started", safeHandler((username: string, userId?: string) => {
      this.logger.info(`Bot @${username} polling started. Ensure no other service is polling this bot token.`);
      // Concurrent startup can insert a secondary world first. Update the
      // configured primary world, not Map insertion order.
      const w = this.worlds.get(adapterId);
      if (w) {
        w.botUsername = username;
        if (userId) w.botUserId = userId;
      }
      if (userId) this.botUserId = userId;
    }, this.logger, "adapter.started"));
    this.adapter.on("polling_conflict", safeHandler(({ attempt, delay }: { attempt: number; delay: number }) => {
      this.logger.warn(`409 Conflict (attempt ${attempt}), retry in ${delay / 1000}s`);
    }, this.logger, "adapter.polling_conflict"));
    this.adapter.on("handler_error", safeHandler((err: unknown) => {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Adapter handler error");
    }, this.logger, "adapter.handler_error"));
    this.adapter.on("error", (err: unknown) => {
      this.logger.error({ err }, "Primary adapter fatal error");
      this.restartAdapter(this.adapter!, "primary").catch(() => {});
    });

    this.adapter.on("new_group_detected", safeHandler((data: { groupId: string; groupTitle: string; source: string }) => {
      const adminMsg = t("alert.bot_added", data.groupTitle, data.groupId, data.source);
      const generalId = this.findGeneralInstance();
      if (generalId) this.notifyInstanceTopic(generalId, adminMsg);
    }, this.logger, "adapter.new_group_detected"));

    // Start adapter AFTER all event listeners are registered (started event sets botUsername)
    await this.adapter.start();
    if (fleet.channel?.group_id) {
      this.adapter.setChatId(String(fleet.channel.group_id));
    }

    this.startTopicCleanupPoller();

    // Prune stale external sessions every 5 minutes
    this.sessionPruneTimer = setInterval(() => {
      this.pruneStaleExternalSessions().catch(err =>
        this.logger.debug({ err }, "Session prune failed"));
    }, 5 * 60 * 1000);
  }

  /** Start an additional (non-primary) adapter */
  private async startAdditionalAdapter(channelConfig: ChannelConfig, registerCommands = true): Promise<void> {
    const adapterId = channelConfig.id ?? channelConfig.type;
    const botToken = process.env[channelConfig.bot_token_env];
    if (!botToken) {
      this.logger.warn({ env: channelConfig.bot_token_env, adapterId }, "Bot token env not set, skipping adapter");
      return;
    }

    const accessDir = join(this.dataDir, "access");
    mkdirSync(accessDir, { recursive: true });
    const accessManager = new AccessManager(
      channelConfig.access ?? DEFAULT_OPEN_ACCESS,
      join(accessDir, `access-${adapterId}.json`),
    );
    const inboxDir = join(this.dataDir, "inbox");
    mkdirSync(inboxDir, { recursive: true });

    const adapter = await createAdapter(channelConfig, {
      id: adapterId,
      botToken,
      accessManager,
      inboxDir,
      registerCommands,
    });
    const world = new AdapterWorld(adapterId, adapter, accessManager, channelConfig);
    this.worlds.set(adapterId, world);
    (this.adapters as Map<string, ChannelAdapter>).set(adapterId, adapter);

    // Wire up event handlers (same as primary, routes through shared handleInboundMessage)
    adapter.on("message", safeHandler(async (msg: InboundMessage) => {
      await this.handleInboundMessage(msg);
    }, this.logger, `adapter[${adapterId}].message`));

    adapter.on("reaction", safeHandler(async (r: InboundReaction) => {
      await this.handleInboundReaction(r);
    }, this.logger, `adapter[${adapterId}].reaction`));

    adapter.on("callback_query", safeHandler(async (data: AdapterCallbackData) => {
      if (await this.handleTipDismiss(data, adapterId, adapter)) return;
      if (await this.handleTipUnlock(data, adapterId, adapter)) return;
      if (await this.handleLoginBackendSelect(data, adapterId, adapter)) return;
      if (await this.handleLoginMenuSelect(data, adapterId, adapter)) return;
      if (await this.handleLoginConfirm(data, adapterId, adapter)) return;
      if (await this.handleInstallLoginConfirm(data, adapterId, adapter)) return;
      if (await this.handleClearConfirmation(data, adapterId, adapter)) return;
      if (await this.handleExitRestartPrompt(data, adapterId, adapter)) return;
      if (await this.handleInteractivePromptAssist(data, adapterId, adapter)) return;
      if (await this.handleClassicBackendSelection(data)) return;
      if (await this.handleModelSelection(data)) return;
      if (await this.handleEffortSelection(data)) return;
      if (await this.handleHangPrompt(data, adapterId, adapter)) return;
      if (data.callbackData.startsWith("cancel:")) {
        this.handleCancelClick(data.callbackData.slice("cancel:".length), adapter, data);
        return;
      }
    }, this.logger, `adapter[${adapterId}].callback_query`));

    adapter.on("topic_closed", safeHandler(async (data: { chatId: string; threadId: string }) => {
      if (this.topicArchiver.isArchived(data.threadId)) return;
      await this.topicCommands.handleTopicDeleted(data.threadId);
    }, this.logger, `adapter[${adapterId}].topic_closed`));

    // Slash commands: classic bot + admin commands
    adapter.on("slash_command", safeHandler(async (data: ClassicStartSlashData) => {
      if (data.command === "start") {
        await this.handleClassicStartSlash(data, adapterId);
      } else if (data.command === "stop") {
        const reply = await this.handleClassicStop(data.channelId, adapterId);
        await data.respond(reply);
      } else if (data.command === "pause" || data.command === "wake") {
        await this.handlePauseWakeSlash(data, adapterId);
      } else if (data.command === "chat") {
        const text = data.text ?? "";
        if (!text) { await data.respond(t("chat.usage")); return; }
        const name = this.classicChannels?.getInstanceByChannel(data.channelId, adapterId);
        if (!name) {
          await data.respond(t("classic.no_agent_start"));
          return;
        }
        const replyMsgId = await data.respond("👀");
        const username = data.username ?? data.userId;
        ClassicChannelManager.logMessage(name, username, `/chat ${text}`, new Date());
        await this.forwardToClassicInstance(name, text, {
          chatId: data.channelId,
          threadId: data.channelId,
          messageId: replyMsgId ?? "",
          userId: data.userId,
          username,
          source: channelConfig.type,
          timestamp: new Date(),
        });
      } else if (data.command === "save") {
        await this.handleSlashSave(data, adapterId);
      } else if (data.command === "load") {
        // load is kiro-cli/classic only — no claude-code equivalent.
        if (!this.classicChannels?.isAdmin(data.userId)) {
          await data.respond(t("admin.required"));
          return;
        }
        const name = this.classicChannels?.getInstanceByChannel(data.channelId, adapterId);
        if (!name) {
          await data.respond(t("classic.no_agent_start"));
          return;
        }
        const filename = data.options?.filename as string;
        if (!SAVE_FILENAME_RE.test(filename ?? "")) { await data.respond(t("filename.invalid")); return; }
        this.pasteRawToClassicInstance(name, `/chat load ${filename}`);
        await data.respond(t("save.sent", `/chat load ${filename}`, name));
      } else if (data.command === "model") {
        await this.handleModelSlash(data, adapterId);
      } else if (data.command === "clear") {
        await this.handleClearSlash(data, adapterId);
      } else if (data.command === "effort") {
        await this.handleEffortSlash(data, adapterId);
      } else if (data.command === "cancel") {
        const name = this.resolveSlashTarget(data.channelId, adapterId);
        if (!name) { await data.respond(t("classic.no_agent")); return; }
        const ok = this.cancelInstance(name);
        await data.respond(ok ? t("cancel.sent", name) : t("cancel.not_running", name));
      } else if (data.command === "ctx") {
        const name = this.resolveSlashTarget(data.channelId, adapterId);
        if (!name) { await data.respond(t("classic.no_agent")); return; }
        // Single source of truth (statusline.json + robust tmux pane fallback).
        await data.respond(await this.topicCommands.getCtxText(name));
      } else if (data.command === "collab") {
        // Classic no longer lives in the routing engine, so a routing hit here is
        // always a fleet-topic instance.
        const collabTarget2 = this.routing.resolve(data.channelId);
        if (collabTarget2) {
          const allowed = this.fleetConfig?.channel?.access?.allowed_users ?? [];
          if (allowed.length > 0 && !allowed.some(u => String(u) === String(data.userId))) {
            await data.respond(t("not_authorized"));
            return;
          }
          const isCollab = this.toggleFleetCollab(collabTarget2.name);
          await data.respond(isCollab ? t("collab.on") : t("collab.off"));
          return;
        }
        if (!this.classicChannels?.isAdmin(data.userId)) {
          await data.respond(t("admin.required"));
          return;
        }
        if (!this.classicChannels.isClassicChannel(data.channelId, adapterId)) {
          await data.respond(t("classic.no_agent_start"));
          return;
        }
        const newState = this.classicChannels.toggleCollab(data.channelId, adapterId);
        await data.respond(newState
          ? t("collab.on.classic")
          : t("collab.off.classic"));
      } else if (data.command === "update") {
        await this.handleUpdateSlash(data, adapterId);
      } else if (data.command === "doctor") {
        const allowed = this.fleetConfig?.channel?.access?.allowed_users ?? [];
        if (allowed.length > 0 && !allowed.some(u => String(u) === String(data.userId))) {
          await data.respond(t("not_authorized"));
          return;
        }
        await data.respond(await this.runBackendDoctor());
      } else if (data.command === "usage") {
        // Same permission level as /ctx (none). The reply is still ephemeral —
        // the adapter defers non-chat commands that way — so it never spams the
        // channel either way.
        try {
          const { getUsageSnapshot } = await import("./usage/usage-api.js");
          const { renderUsageMarkdown } = await import("./usage/format-rich.js");
          // slash_command is Discord-only; editReply renders Markdown natively.
          await data.respond(renderUsageMarkdown(await getUsageSnapshot(false, this.getActiveUsageProviderIds())));
        } catch (err) {
          await data.respond(t("usage.failed", (err as Error).message));
        }
      } else if (data.command === "tips") {
        await this.handleTipsSlash(data, adapterId);
      } else if (data.command === "status") {
        // Admin-gated (like the topic path): the merged table shows every
        // instance's cost and IPC health.
        if (!this.isFleetAdmin(data.userId, adapterId)) {
          await data.respond(t("cmd.admin_required", "/status"));
          return;
        }
        const text = await this.topicCommands.getStatusText();
        await data.respond(text);
      } else if (data.command === "sysinfo") {
        await data.respond(this.topicCommands.getSysInfoText());
      } else if (data.command === "dashboard") {
        // Reply is ephemeral (adapter defers non-chat commands ephemerally), so
        // the web-token-bearing URLs are only visible to the caller.
        const allowed = this.fleetConfig?.channel?.access?.allowed_users ?? [];
        if (allowed.length === 0) { await data.respond(t("dashboard.disabled")); return; }
        if (!allowed.some(u => String(u) === String(data.userId))) { await data.respond(t("not_authorized")); return; }
        await data.respond(this.topicCommands.getDashboardText());
      } else if (data.command === "restart") {
        const allowed = this.fleetConfig?.channel?.access?.allowed_users ?? [];
        if (allowed.length > 0 && !allowed.some(u => String(u) === String(data.userId))) {
          await data.respond(t("not_authorized"));
          return;
        }
        await data.respond(t("restart.graceful"));
        process.kill(process.pid, "SIGUSR2");
      } else if (data.command === "compact") {
        const name = this.resolveSlashTarget(data.channelId, adapterId);
        if (!name) { await data.respond(t("classic.no_agent")); return; }
        const result = await this.topicCommands.sendCompact(name);
        await data.respond(result);
      } else if (data.command === "steer") {
        const name = this.resolveSlashTarget(data.channelId, adapterId);
        if (!name) { await data.respond(t("classic.no_agent")); return; }
        const steerText = String(data.options?.message ?? "").trim();
        if (!steerText) { await data.respond(t("steer.usage")); return; }
        // chat_id/message_id stay empty: a slash interaction has no channel
        // message to react to, and an empty chat_id keeps updateLastChat from
        // rerouting the instance's replies to the slash context.
        const result = this.topicCommands.sendSteer(name, steerText, {
          chatId: "", messageId: "", username: data.username ?? "user",
          userId: data.userId ?? "", threadId: undefined, adapterId, source: "discord",
        });
        await data.respond(result);
      } else if (data.command === "btw") {
        const name = this.resolveSlashTarget(data.channelId, adapterId);
        if (!name) { await data.respond(t("classic.no_agent")); return; }
        const btwText = String(data.options?.message ?? "").trim();
        if (!btwText) { await data.respond(t("btw.usage")); return; }
        const result = this.topicCommands.sendBtw(name, btwText, {
          chatId: "", messageId: "", username: data.username ?? "user",
          userId: data.userId ?? "", threadId: undefined, adapterId, source: "discord",
        });
        await data.respond(result);
      } else if (data.command === "login") {
        await this.handleLoginSlash(data, adapterId, adapter);
      } else if (data.command === "install-cli") {
        await this.handleInstallCliSlash(data, adapterId, adapter);
      }
    }, this.logger, `adapter[${adapterId}].slash_command`));

    await adapter.start();
    if (channelConfig.group_id) {
      adapter.setChatId(String(channelConfig.group_id));
    }

    adapter.on("started", safeHandler((username: string, userId?: string) => {
      this.logger.info(`[${adapterId}] Bot @${username} polling started.`);
      const world = this.worlds.get(adapterId);
      if (world) {
        world.botUsername = username;
        if (userId) world.botUserId = userId;
      }
    }, this.logger, `adapter[${adapterId}].started`));

    adapter.on("new_group_detected", safeHandler((data: { groupId: string; groupTitle: string; source: string }) => {
      const adminMsg = t("alert.bot_added", data.groupTitle, data.groupId, data.source);
      const generalId = this.findGeneralInstance(adapterId);
      if (generalId) this.notifyInstanceTopic(generalId, adminMsg);
    }, this.logger, `adapter[${adapterId}].new_group_detected`));
    adapter.on("error", (err: unknown) => {
      this.logger.error({ err, adapterId }, "Additional adapter fatal error");
      this.restartAdapter(adapter, adapterId).catch(() => {});
    });

    this.logger.info({ adapterId, type: channelConfig.type }, "Additional adapter started");
  }

  /** Connect IPC to a single instance with all handlers */
  connectIpcToInstance(name: string): Promise<void> {
    const inFlight = this.ipcConnectInFlight.get(name);
    if (inFlight) return inFlight;

    const connection = this.connectIpcToInstanceInternal(name)
      .finally(() => {
        if (this.ipcConnectInFlight.get(name) === connection) {
          this.ipcConnectInFlight.delete(name);
        }
      });
    this.ipcConnectInFlight.set(name, connection);
    return connection;
  }

  private async connectIpcToInstanceInternal(name: string): Promise<void> {
    // Close existing client to prevent socket leak on reconnect
    const existing = this.instanceIpcClients.get(name);
    if (existing) {
      // Remove application listeners before destroying the socket. Even if a
      // future regression creates two clients, the replaced one cannot keep
      // handling fleet_outbound messages as an orphan.
      existing.removeAllListeners();
      try {
        await existing.close();
      } catch (err) {
        this.logger.debug({ err, name }, "IPC client close failed (likely already closed)");
      } finally {
        if (this.instanceIpcClients.get(name) === existing) {
          this.instanceIpcClients.delete(name);
        }
      }
    }

    const sockPath = join(this.getInstanceDir(name), "channel.sock");
    if (!existsSync(sockPath)) return;

    const ipc = new IpcClient(sockPath);
    try {
      await ipc.connect();
      this.instanceIpcClients.set(name, ipc);
      ipc.on("message", safeHandler(async (msg: Record<string, unknown>) => {
        if (msg.type === "mcp_ready") {
          // Register external sessions (sessionName differs from instance name)
          const sessionName = msg.sessionName as string | undefined;
          if (sessionName && sessionName !== name) {
            this.sessionRegistry.set(sessionName, name);
            this.logger.info({ sessionName, instanceName: name }, "Registered external session");
          }
        } else if (msg.type === "session_disconnected") {
          const sessionName = msg.sessionName as string | undefined;
          if (sessionName && this.sessionRegistry.has(sessionName)) {
            this.sessionRegistry.delete(sessionName);
            this.logger.info({ sessionName, instanceName: name }, "Unregistered external session");
          }
        } else if (msg.type === "fleet_outbound") {
          // Auto-register external session on first outbound message — covers the
          // race where mcp_ready arrived before fleet manager connected and query_sessions
          // fired before the MCP server reconnected.
          const sender = msg.senderSessionName as string | undefined;
          if (sender && sender !== name && !this.sessionRegistry.has(sender)) {
            this.sessionRegistry.set(sender, name);
            this.logger.info({ sessionName: sender, instanceName: name }, "Registered external session");
          }
          await this.handleOutboundFromInstance(name, msg);
        } else if (msg.type === "fleet_schedule_create" || msg.type === "fleet_schedule_list" ||
                   msg.type === "fleet_schedule_update" || msg.type === "fleet_schedule_delete") {
          this.handleScheduleCrud(name, msg);
        } else if (msg.type === "fleet_decision_create" || msg.type === "fleet_decision_list" ||
                   msg.type === "fleet_decision_update") {
          this.handleDecisionCrud(name, msg);
        } else if (msg.type === "fleet_task") {
          this.handleTaskCrud(name, msg);
        } else if (msg.type === "fleet_set_display_name") {
          this.handleSetDisplayName(name, msg);
        } else if (msg.type === "fleet_set_description") {
          this.handleSetDescription(name, msg);
        } else if (msg.type === "instance_process_state") {
          this.cacheInstanceProcessStatus(name, msg.status);
        } else if (msg.type === "instance_activity") {
          this.cacheInstanceActivity(name, msg.activity as string | null);
        } else if (msg.type === "instance_progress") {
          this.cacheInstanceProgress(name, (msg.progress as string) || null);
        } else if (msg.type === "instance_state" || msg.type === "instance_state_response") {
          this.cacheInstanceExecutionState(name, msg);
          if (msg.type === "instance_state_response") {
            this.cacheInstanceProcessStatus(name, msg.processStatus);
          }
        }
      }, this.logger, `ipc.message[${name}]`));
      // Ask daemon for any sessions that registered before we connected
      // (fixes race condition where mcp_ready was broadcast before fleet manager connected)
      ipc.send({ type: "query_sessions" });
      // The initial state transition may have happened before FleetManager
      // connected, so seed the cache instead of waiting for another transition.
      ipc.send({ type: "query_instance_state", requestId: `fleet-state-${Date.now()}` });
      this.logger.debug({ name }, "Connected to instance IPC");
      if (!this.statuslineWatcher.has(name)) {
        this.statuslineWatcher.watch(name);
      }

      // Auto-reconnect on disconnect (unless intentionally stopping)
      ipc.on("disconnect", () => {
        // A delayed event from a replaced/stale client must never delete the
        // current connection or start another reconnect loop.
        if (this.instanceIpcClients.get(name) !== ipc) return;
        this.instanceIpcClients.delete(name);
        if (this.ipcStoppingInstances.has(name)) return;
        this.ipcReconnect(name).catch(() => {});
      });
    } catch (err) {
      this.logger.warn({ name, err }, "Failed to connect to instance IPC");
    }
  }

  /** Attempt IPC reconnection with exponential backoff */
  private ipcReconnect(name: string): Promise<void> {
    const inFlight = this.ipcReconnectInFlight.get(name);
    if (inFlight) return inFlight;

    const reconnect = this.runIpcReconnect(name)
      .finally(() => {
        if (this.ipcReconnectInFlight.get(name) === reconnect) {
          this.ipcReconnectInFlight.delete(name);
        }
      });
    this.ipcReconnectInFlight.set(name, reconnect);
    return reconnect;
  }

  private async runIpcReconnect(name: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      if (this.ipcStoppingInstances.has(name) || !this.daemons.has(name)) return;
      const delay = attempt <= 3 ? 3000 * Math.pow(2, attempt - 1) : 60_000; // 3s, 6s, 12s, then 60s
      await new Promise(r => setTimeout(r, delay));
      if (this.ipcStoppingInstances.has(name) || !this.daemons.has(name)) return;
      try {
        await this.connectIpcToInstance(name);
        if (this.instanceIpcClients.has(name)) {
          this.logger.info({ name, attempt }, "IPC reconnected");
          return;
        }
      } catch { /* retry */ }
      // Periodic pane health check (every attempt after initial 3)
      if (attempt >= 3) {
        const instanceDir = this.getInstanceDir(name);
        const windowIdPath = join(instanceDir, "window-id");
        if (existsSync(windowIdPath)) {
          const windowId = readFileSync(windowIdPath, "utf-8").trim();
          if (windowId) {
            // Async with an explicit timeout: this was execSync with NO timeout at
            // all, so a wedged tmux server blocked the whole fleet event loop
            // indefinitely — while we were here to diagnose a lost connection.
            // A timeout is also the correct signal: an unresponsive tmux server
            // means we cannot verify the pane, which is treated as dead (the same
            // conclusion the old code reached only by throwing).
            try {
              const { execFile } = await import("node:child_process");
              const { promisify } = await import("node:util");
              const { getTmuxSocketName } = await import("./paths.js");
              // Honour socket isolation: without -L this queried the user's default
              // tmux server instead of the fleet's, so under a custom AGEND_HOME the
              // check was meaningless (it reported every pane dead).
              const socket = getTmuxSocketName();
              const args = socket ? ["-L", socket, "list-panes", "-t", windowId] : ["list-panes", "-t", windowId];
              await promisify(execFile)("tmux", args, { timeout: 5_000 });
            } catch {
              // Pane dead — respawn
              this.logger.info({ name }, "Tmux pane dead after IPC loss — respawning instance");
              this.restartSingleInstance(name).catch(err =>
                this.logger.error({ name, err }, "Auto-respawn after IPC loss failed"));
              return;
            }
          }
        }
      }
      if (attempt % 10 === 0) {
        this.logger.warn({ name, attempt }, "IPC reconnect still failing");
      }
    }
  }

  /** Restart a channel adapter after fatal error with infinite retry + 60s cap */
  private async restartAdapter(adapter: ChannelAdapter, id: string): Promise<void> {
    if (this.adapterRestarting.has(id)) return;
    this.adapterRestarting.add(id);
    // Reflect reality in adapterState throughout. This loop used to leave the state
    // untouched, so getAdapterStates() — and therefore /health and the dashboard —
    // kept reporting "connected" for an adapter that had been down for hours. An
    // adapter's true status was simply not knowable from inside the process.
    const previous = this.adapterState.get(id);
    this.adapterState.set(id, { status: "retrying", retryCount: 0, lastError: previous?.lastError });
    try {
      for (let attempt = 1; ; attempt++) {
        if (this.ipcStoppingInstances.has("__fleet_stopping__")) return;
        const delay = attempt <= 3 ? 5000 * Math.pow(2, attempt - 1) : 60_000; // 5s, 10s, 20s, then 60s
        await new Promise(r => setTimeout(r, delay));
        if (this.ipcStoppingInstances.has("__fleet_stopping__")) return;
        try {
          await adapter.stop().catch(() => {});
          await adapter.start();
          this.logger.info({ id, attempt }, "Adapter restarted successfully");
          this.adapterState.set(id, { status: "connected", retryCount: 0 });
          return;
        } catch (err) {
          this.adapterState.set(id, {
            status: "retrying",
            retryCount: attempt,
            lastError: (err as Error)?.message ?? String(err),
          });
        }
        if (attempt % 10 === 0) {
          this.logger.warn({ id, attempt }, "Adapter restart still failing");
        }
      }
    } finally {
      this.adapterRestarting.delete(id);
    }
  }

  /** Handle inbound message — transcribe voice if present, then route */
  private findGeneralInstance(adapterId?: string): string | undefined {
    if (!this.fleetConfig) return undefined;
    const generals: string[] = [];
    for (const [name, config] of Object.entries(this.fleetConfig.instances)) {
      if (config.general_topic === true && this.daemons.has(name)) {
        generals.push(name);
      }
    }
    if (generals.length === 0) return undefined;
    if (generals.length === 1) return generals[0];
    if (adapterId) {
      // Prefer explicit channel_id match
      const byChannelId = generals.find(n => this.fleetConfig!.instances[n].channel_id === adapterId);
      if (byChannelId) return byChannelId;
      // Fallback: name contains adapter id
      const byName = generals.find(n => n.includes(adapterId));
      if (byName) return byName;
    }
    return generals[0];
  }

  /**
   * A user reacted to one of the bot's messages (#408).
   *
   * A reaction is context, not a message (#432, reworking #413): it never triggers
   * an agent turn and never wakes anything. It is queued in the event log and rides
   * into the instance's NEXT real message as one compact leading line —
   * `[Recent reactions: 👍×2 from hanhanv]` — after which it is marked consumed.
   * No pending reactions → no line → zero context spent, which is the common case.
   */
  private async handleInboundReaction(r: InboundReaction): Promise<void> {
    const instanceName = this.resolveSlashTarget(r.threadId ?? r.chatId, r.adapterId);
    if (!instanceName) {
      this.logger.debug({ emoji: r.emoji, chatId: r.chatId }, "Reaction in an unrouted channel — ignoring");
      return;
    }

    if (DELIVERY_STATUS_EMOJIS.has(r.emoji)) {
      this.logger.debug({ emoji: r.emoji, user: r.username }, "Ignoring delivery-status emoji as a reaction");
      return;
    }
    if (IGNORED_REACTION_EMOJIS.has(r.emoji)) {
      this.logger.debug({ emoji: r.emoji, user: r.username }, "Ignoring non-contextual emoji reaction");
      return;
    }

    this.eventLog?.logActivity("reaction", r.username, `${r.emoji} ${r.action}`, instanceName);
    if (r.action === "add") {
      this.eventLog?.addReaction(instanceName, r.messageId, r.username, r.emoji);
    } else {
      // Withdrawn before anyone saw it → it never happened. See removeReaction.
      this.eventLog?.removeReaction(instanceName, r.messageId, r.username, r.emoji);
    }
  }

  /**
   * The queued-reaction summary for an instance's next real message, or {} when
   * nothing is pending (the common case must add zero context). The consume
   * callback is separate from the fetch so reactions are only marked once the
   * message actually went out — a failed delivery keeps them queued.
   */
  private pendingReactionsMeta(instanceName: string): { meta: Record<string, string>; consume: () => void } {
    const pending = this.eventLog?.pendingReactions(instanceName);
    if (!pending) return { meta: {}, consume: () => {} };
    return {
      meta: { pending_reactions: pending.summary },
      consume: () => this.eventLog?.markReactionsConsumed(instanceName, pending.maxId),
    };
  }

  private async handleInboundMessage(msg: InboundMessage): Promise<void> {
    const threadId = msg.threadId || undefined;

    this.logger.debug({ source: msg.source, chatId: msg.chatId, threadId, userId: msg.userId, isBotMessage: msg.isBotMessage, textLen: (msg.text ?? "").length, text: (msg.text ?? "").slice(0, 80) }, "handleInboundMessage entry");

    // Multi-adapter dedup: when several bots share a guild, each adapter fires
    // its own "message" event for the same underlying message. Process it once.
    // Routing (by topic/channel) and reply-adapter selection (by channel_id
    // binding) are adapter-independent, so it's safe to let whichever adapter
    // arrives first handle it.
    //
    // EXCEPTION — classic channels with same-channel multi-bot: two bots may own
    // separate agents in one channel, so each bot must process its OWN copy of
    // the message (the @mention filter downstream decides who actually forwards).
    // Key the dedup per-adapter there so a sibling bot's copy isn't dropped.
    if (msg.messageId) {
      const classicCid = msg.threadId || msg.chatId;
      const isClassicMsg = this.classicChannels?.hasChannel(classicCid) ?? false;
      const dedupKey = isClassicMsg
        ? `${msg.source}:${msg.chatId}:${msg.messageId}:${msg.adapterId ?? ""}`
        : `${msg.source}:${msg.chatId}:${msg.messageId}`;
      if (this.recentMessageIds.has(dedupKey)) {
        this.logger.debug({ dedupKey, adapterId: msg.adapterId }, "Duplicate inbound across adapters — skipping");
        return;
      }
      this.recentMessageIds.add(dedupKey);
      if (this.recentMessageIds.size > 1000) {
        // Set preserves insertion order — drop the oldest key.
        const oldest = this.recentMessageIds.values().next().value;
        if (oldest !== undefined) this.recentMessageIds.delete(oldest);
      }
    }

    // Bot messages: only allow in collab channels or TG classic with @mention
    if (msg.isBotMessage) {
      if (!threadId) {
        // TG classic: allow if bot @mentions our bot or access mode is open
        const world = this.worlds.get(msg.adapterId ?? "");
        const botUser = world?.botUsername;
        const channelCfg = this.getChannelConfig(msg.adapterId);
        const isOpen = channelCfg?.access?.mode === "open";
        const mentionsUs = !!(botUser && msg.text?.toLowerCase().includes(`@${botUser.toLowerCase()}`));
        this.logger.debug({ botUser, mentionsUs, isOpen, isBotMessage: true, threadId: null }, "Bot message filter (no threadId path)");
        if (!isOpen && !mentionsUs) return;
        // Fall through to TG classic handling below
      } else if (this.classicChannels?.hasChannel(threadId)) {
        // Classic channel (per-bot): bot messages only when THIS bot owns an
        // agent here and collab is on for it.
        const classicName = this.classicChannels.getInstanceByChannel(threadId, msg.adapterId);
        if (!classicName) return;
        if (!this.classicChannels.isCollab(threadId, msg.adapterId)) return;
        // Fall through to channel handling
      } else {
        const target = this.routing.resolve(threadId);
        if (!target) return;
        // Fleet topic: allow if collab enabled OR access mode is open
        const channelCfg = this.getChannelConfig(msg.adapterId);
        const isOpen = channelCfg?.access?.mode === "open";
        if (!isOpen && !this.collabInstances.has(target.name)) return;
        // Fall through to channel handling
      }
    }

    // Access control — classic channels are open to all, others require allowed user
    const am = (msg.adapterId ? this.worlds.get(msg.adapterId)?.accessManager : undefined) ?? this.accessManager;
    if (am && !am.isAllowed(msg.userId)) {
      const adapterGroupId = String(this.getChannelConfig(msg.adapterId)?.group_id ?? "");
      const isTelegramClassicCandidate = msg.source === "telegram" && msg.chatId !== adapterGroupId && !threadId;
      if (!isTelegramClassicCandidate) {
        // Classic channels are open to all; check per-bot ownership (or fleet topic).
        const isClassic = !!(threadId && this.classicChannels?.hasChannel(threadId));
        this.logger.info({ userId: msg.userId, threadId, isClassic }, "Access DENIED for non-allowed user");
        if (!isClassic) return;
      }
    }
    if (threadId == null) {
      // ── Telegram Classic Mode ──
      // Messages from chats other than the primary forum group are classic mode candidates.
      // Private chats (positive chatId) and regular groups (negative, not group_id) qualify.
      const adapterGroupId = String(this.getChannelConfig(msg.adapterId)?.group_id ?? "");
      const isTelegramClassic = msg.source === "telegram" && msg.chatId !== adapterGroupId;

      if (isTelegramClassic && this.classicChannels) {
        const chatId = msg.chatId;
        const rawText = msg.text ?? "";
        // Detect @OurBot mention (only our bot, not other bots)
        const world = this.worlds.get(msg.adapterId ?? "");
        const botUser = world?.botUsername;

        // Strip @BotUsername suffix from commands — but only if it's OUR bot or no bot specified
        let text = rawText;
        const cmdMatch = rawText.match(/^(\/\w+)@(\S+)/);
        if (cmdMatch) {
          const targetBot = cmdMatch[2];
          if (botUser && targetBot.toLowerCase() !== botUser.toLowerCase()) {
            // Command targeted at another bot — ignore entirely
            return;
          }
          text = rawText.replace(/^(\/\w+)@\S+/, "$1");
        }

        const isBotMentioned = !!(botUser && text.toLowerCase().includes(`@${botUser.toLowerCase()}`));
        const isPrivateChat = !chatId.startsWith("-"); // Telegram: positive = private, negative = group
        const msgAdapter = this.worlds.get(msg.adapterId ?? "")?.adapter ?? this.adapter;

        // In a TG Classic group, ignore bare slash commands (no @bot specified).
        // Prevents multiple bots all responding to the same /ctx, /compact, etc.
        // `/cmd@otherbot` already returned above; `/cmd@mybot` set cmdMatch, so it
        // still processes. Private chat (only one bot) always processes.
        // NOTE: this also silently drops bare `/start` in a group, so group
        // onboarding now requires `/start@mybot` — consistent with the policy.
        if (!isPrivateChat && !cmdMatch && rawText.startsWith("/")) {
          return; // bare slash in group — ignore silently
        }

        // Handle /start command
        if (text === "/start" || text.startsWith("/start ")) {
          if (isPrivateChat) {
            if (!this.classicChannels.isUserAllowed(msg.userId)) {
              const generalId = this.findGeneralInstance(msg.adapterId);
              if (generalId) {
                this.notifyInstanceTopic(generalId, t("alert.unauth_user_private", msg.username, msg.userId, msg.source));
              }
              await msgAdapter?.sendText(chatId, t("classic.not_allowed_user"));
              return;
            }
          } else {
            if (!this.classicChannels.isGroupAllowed(chatId)) {
              // Notify admin about new group wanting access
              const groupTitle = (msg as any).chatTitle || chatId;
              const adminMsg = t("alert.new_group", groupTitle, chatId, msg.username, msg.userId, msg.source);
              const generalId = this.findGeneralInstance(msg.adapterId);
              if (generalId) {
                this.notifyInstanceTopic(generalId, adminMsg);
              }
              await msgAdapter?.sendText(chatId, t("classic.access_requested"));
              return;
            }
            if (!this.classicChannels.isAdmin(msg.userId)) {
              await msgAdapter?.sendText(chatId, t("classic.admin_only_start"));
              const generalId = this.findGeneralInstance(msg.adapterId);
              if (generalId) {
                this.notifyInstanceTopic(generalId, t("alert.start_not_admin", msg.username, msg.userId, msg.source, chatId));
              }
              return;
            }
          }
          const channelName = msg.username || chatId;
          const requestedBackend = text.slice("/start".length).trim().split(/\s+/, 1)[0] || undefined;
          if (requestedBackend) {
            // handleClassicStart binds the instance to this adapter authoritatively.
            const reply = await this.handleClassicStart(chatId, channelName, msg.userId, undefined, msg.adapterId, requestedBackend);
            await msgAdapter?.sendText(chatId, reply);
          } else if (msgAdapter) {
            await this.beginClassicBackendSelection({
              command: "start",
              channelId: chatId,
              channelName,
              userId: msg.userId,
              respond: async (reply: string) => (await msgAdapter.sendText(chatId, reply)).messageId,
            }, msgAdapter);
          }
          return;
        }

        // Handle /stop command
        if (text === "/stop" || text.startsWith("/stop ")) {
          if (!this.classicChannels.isAdmin(msg.userId)) {
            await msgAdapter?.sendText(chatId, t("classic.admin_only_stop"));
            const generalId = this.findGeneralInstance(msg.adapterId);
            if (generalId) {
              this.notifyInstanceTopic(generalId, t("alert.stop_not_admin", msg.username, msg.userId, msg.source, chatId));
            }
            return;
          }
          const reply = await this.handleClassicStop(chatId, msg.adapterId);
          await msgAdapter?.sendText(chatId, reply);
          return;
        }

        const pauseWake = parsePauseWakeCommand(text);
        if (pauseWake) {
          if (!this.classicChannels.isAdmin(msg.userId)) {
            await msgAdapter?.sendText(chatId, t("permission.denied"));
            return;
          }
          const name = this.classicChannels.getInstanceByChannel(chatId, msg.adapterId);
          if (!name) {
            await msgAdapter?.sendText(chatId, t("classic.no_agent_start"));
            return;
          }
          await msgAdapter?.sendText(chatId, await this.topicCommands.runPauseWake(name, pauseWake.action));
          return;
        }

        // Handle /model command (admin only)
        if (text === "/model" || text.startsWith("/model ") || text.startsWith("/model@")) {
          if (!this.isModelAdmin(msg.userId, chatId, msg.adapterId)) {
            await msgAdapter?.sendText(chatId, t("permission.denied"));
            return;
          }
          const modelName = text.replace(/^\/model(@\S+)?/, "").trim();
          const modelInstance = this.classicChannels.getInstanceByChannel(chatId, msg.adapterId);
          if (!modelInstance) {
            await msgAdapter?.sendText(chatId, t("classic.no_agent_start"));
            return;
          }
          if (modelName) {
            await msgAdapter?.sendText(chatId, await this.applyModel(modelInstance, modelName));
          } else if (msgAdapter) {
            const fallback = await this.promptModelMenu(
              modelInstance,
              msg.userId,
              chatId,
              msgAdapter,
              chatId,
            );
            if (fallback) await msgAdapter.sendText(chatId, fallback);
          }
          return;
        }

        // Handle /compact command (admin only)
        if (text === "/compact" || text.startsWith("/compact@")) {
          if (!this.classicChannels.isAdmin(msg.userId)) {
            await msgAdapter?.sendText(chatId, t("cmd.admin_required", "/compact"));
            return;
          }
          const compactName = this.classicChannels.getInstanceByChannel(chatId, msg.adapterId);
          if (!compactName) {
            await msgAdapter?.sendText(chatId, t("classic.no_agent_start"));
            return;
          }
          const result = await this.topicCommands.sendCompact(compactName);
          await msgAdapter?.sendText(chatId, result);
          return;
        }

        // /steer — interject into the running turn. Not admin-gated: anyone who
        // can talk to this agent can send it a message; steer only changes when
        // it lands, and it keeps the full [user:] formatting (unlike /raw).
        if (text === "/steer" || text.startsWith("/steer ") || text.startsWith("/steer@")) {
          const steerName = this.classicChannels.getInstanceByChannel(chatId, msg.adapterId);
          if (!steerName) {
            await msgAdapter?.sendText(chatId, t("classic.no_agent_start"));
            return;
          }
          const steerContent = text.replace(/^\/steer(@\S+)?/, "").trim();
          if (!steerContent) {
            await msgAdapter?.sendText(chatId, t("steer.usage"));
            return;
          }
          const result = this.topicCommands.sendSteer(steerName, steerContent, msg);
          await msgAdapter?.sendText(chatId, result);
          return;
        }

        // /btw — Claude Code's native side-thread command. Like /steer it is
        // not admin-gated, but it remains a distinct raw CLI command so Claude
        // does not fold the question into the active task.
        if (text === "/btw" || text.startsWith("/btw ") || text.startsWith("/btw@")) {
          const btwName = this.classicChannels.getInstanceByChannel(chatId, msg.adapterId);
          if (!btwName) {
            await msgAdapter?.sendText(chatId, t("classic.no_agent_start"));
            return;
          }
          const btwContent = text.replace(/^\/btw(@\S+)?/, "").trim();
          if (!btwContent) {
            await msgAdapter?.sendText(chatId, t("btw.usage"));
            return;
          }
          const result = this.topicCommands.sendBtw(btwName, btwContent, msg);
          await msgAdapter?.sendText(chatId, result);
          return;
        }

        // Handle /clear command (admin only) — unlike /compact this starts a
        // fresh conversation and intentionally discards the current history.
        if (text === "/clear" || text.startsWith("/clear@")) {
          if (!this.isModelAdmin(msg.userId, chatId, msg.adapterId)) {
            await msgAdapter?.sendText(chatId, t("cmd.admin_required", "/clear"));
            return;
          }
          const clearName = this.classicChannels.getInstanceByChannel(chatId, msg.adapterId);
          if (!clearName) {
            await msgAdapter?.sendText(chatId, t("classic.no_agent_start"));
            return;
          }
          if (!msgAdapter) return;
          const fallback = await this.promptClearConfirmation(
            clearName,
            chatId,
            msgAdapter,
            chatId,
          );
          if (fallback) await msgAdapter.sendText(chatId, fallback);
          return;
        }

        // Handle /cancel command
        if (text === "/cancel" || text.startsWith("/cancel@")) {
          const cancelName = this.classicChannels.getInstanceByChannel(chatId, msg.adapterId);
          if (!cancelName) {
            await msgAdapter?.sendText(chatId, t("classic.no_agent_start"));
            return;
          }
          const ok = this.cancelInstance(cancelName);
          await msgAdapter?.sendText(chatId, ok ? t("cancel.sent", cancelName) : t("cancel.not_running", cancelName));
          return;
        }

        // Handle /ctx command
        if (text === "/ctx" || text.startsWith("/ctx@")) {
          const ctxName = this.classicChannels.getInstanceByChannel(chatId, msg.adapterId);
          if (!ctxName) {
            await msgAdapter?.sendText(chatId, t("classic.no_agent_start"));
            return;
          }
          const reply = await this.topicCommands.getCtxText(ctxName);
          await msgAdapter?.sendText(chatId, reply);
          return;
        }

        // Handle /save command (admin only)
        if (text === "/save" || text.startsWith("/save ") || text.startsWith("/save@")) {
          if (!this.classicChannels.isAdmin(msg.userId)) {
            await msgAdapter?.sendText(chatId, t("cmd.admin_required", "/save"));
            return;
          }
          const saveName = this.classicChannels.getInstanceByChannel(chatId, msg.adapterId);
          if (!saveName) {
            await msgAdapter?.sendText(chatId, t("classic.no_agent_start"));
            return;
          }
          const filename = parseSaveFilename(text);
          if (!filename) { await msgAdapter?.sendText(chatId, t("save.usage")); return; }
          if (!SAVE_FILENAME_RE.test(filename)) { await msgAdapter?.sendText(chatId, t("filename.invalid")); return; }
          const backend = this.classicChannels.getBackendByInstance(saveName, this.fleetConfig?.defaults?.backend);
          const cmd = saveCommandForBackend(backend, filename);
          if (!cmd) { await msgAdapter?.sendText(chatId, t("save.unsupported")); return; }
          this.pasteRawToClassicInstance(saveName, cmd);
          await msgAdapter?.sendText(chatId, t("save.sent", cmd, saveName));
          return;
        }

        // Route to classic channel if this bot has an agent here (per-bot).
        const classicName = this.classicChannels.getInstanceByChannel(chatId, msg.adapterId);
        if (classicName) {
          if (msg.adapterId) this.bindInstanceAdapter(classicName, msg.adapterId, true);
          // TG ClassicBot: group requires @mention, private chat forwards directly.
          if (!isPrivateChat && !isBotMentioned) {
            // No trigger: save attachments + react, log, but don't forward to agent
            const syntheticMsg = { ...msg, threadId: chatId, text: rawText.startsWith("/") ? "" : rawText };
            await this.handleClassicChannelMessage(classicName, syntheticMsg);
            return;
          }
          // Keep the bot's own @mention visible to the agent as a self-marker
          // instead of stripping it (#498). Telegram never delivers a bot its
          // own messages, so the marker cannot echo back into a loop.
          const tgSelfMentionRe = botUser ? new RegExp(`@${botUser}`, "gi") : null;
          const strippedText = tgSelfMentionRe ? text.replace(tgSelfMentionRe, "").trim() : text;
          const cleanText = tgSelfMentionRe ? text.replace(tgSelfMentionRe, `@${botUser} (you)`).trim() : text;
          if (strippedText.startsWith("/raw") && !this.classicChannels.isAdmin(msg.userId)) {
            await msgAdapter?.sendText(chatId, t("cmd.admin_required", "/raw"));
            return;
          }
          const syntheticMsg = { ...msg, threadId: chatId, text: `/chat ${cleanText}` };
          await this.handleClassicChannelMessage(classicName, syntheticMsg);
          return;
        }

        // Handle @bot without active agent
        if (isBotMentioned) {
          await msgAdapter?.sendText(chatId, t("classic.no_agent_start"));
          return;
        }

        // Unregistered private chat: ignore (don't fall through to General)
        if (isPrivateChat) return;
        // Unregistered group: ignore
        return;
      }

      // General topic: check /ctx /compact /collab first, then admin commands
      const generalInstance = this.findGeneralInstance(msg.adapterId);
      if (generalInstance && await this.topicCommands.handleInstanceCommand(msg, generalInstance)) return;
      if (await this.topicCommands.handleGeneralCommand(msg)) return;

      // Forward to General Topic instance if configured
      if (generalInstance) {
        if (msg.adapterId) this.bindInstanceAdapter(generalInstance, msg.adapterId, true);
        const inboundAdapter = this.worlds.get(msg.adapterId ?? "")?.adapter ?? this.adapter!;

        // React immediately — before any other API calls. Use the adapter BOUND to
        // the instance (not whichever same-guild bot received the event first) so
        // exactly the owning bot reacts — no duplicate 👀 from a sibling bot.
        if (msg.chatId && msg.messageId) {
          const reactAdapter = this.getAdapterForInstance(generalInstance) ?? inboundAdapter;
          reactAdapter.react(msg.threadId ?? msg.chatId, msg.messageId, "👀")
            .catch(e => this.logger.debug({ err: (e as Error).message }, "Auto-react failed"));
        }

        this.warnIfRateLimited(generalInstance, msg);
        const { text, extraMeta } = await processAttachments(msg, inboundAdapter, this.logger, generalInstance);
        const generalReactions = this.pendingReactionsMeta(generalInstance);
        try {
          await this.deliverToInstance(generalInstance, {
            type: "fleet_inbound",
            content: text,
            targetSession: generalInstance,
            meta: {
              chat_id: msg.chatId,
              message_id: msg.messageId,
              user: msg.username,
              user_id: msg.userId,
              ts: msg.timestamp.toISOString(),
              thread_id: "",
              // Fleet instances have an authoritative adapter binding. Multiple
              // bots in one guild can observe the same inbound message, so the
              // adapter whose event wins dedup is not necessarily the bot that
              // owns this instance.
              adapter_id: this.getInstanceAdapterId(generalInstance) ?? msg.adapterId,
              source: msg.source,
              ...(msg.replyToText ? { reply_to_text: msg.replyToText } : {}),
              ...generalReactions.meta,
              ...extraMeta,
            },
          });
          generalReactions.consume();
          this.lastInboundUser.set(generalInstance, msg.username);
          this.logger.info(`${msg.username} → ${generalInstance}: ${(text ?? "").slice(0, 100)}`);
          this.eventLog?.logActivity("message", msg.username, (text ?? "").slice(0, 200), generalInstance);
          this.emitSseEvent("message", {
            instance: generalInstance, sender: msg.username,
            text: (text ?? "").slice(0, 2000), ts: new Date().toISOString(),
          });
          this.trackInboundMsg(generalInstance, msg);
          void this.sendCancelButton(generalInstance);
        } catch (err) {
          this.logger.warn({ err: (err as Error).message, instanceName: generalInstance }, "General wake/delivery failed");
        }
      }
      return;
    }

    // Classic channels resolve per-bot (same-channel multi-bot) — a channel can
    // host two bots' agents. If this channel is classic but THIS bot has no
    // agent here, a sibling bot owns it; skip rather than misroute to it.
    if (this.classicChannels?.hasChannel(threadId)) {
      const classicName = this.classicChannels.getInstanceByChannel(threadId, msg.adapterId);
      if (!classicName) return;
      if (msg.adapterId) this.bindInstanceAdapter(classicName, msg.adapterId, true);
      await this.handleClassicChannelMessage(classicName, msg);
      return;
    }

    const target = this.routing.resolve(threadId);
    if (!target) {
      // Only show unbound message for actual forum topics (same group, has threadId)
      const adapterGroupId = String(this.getChannelConfig(msg.adapterId)?.group_id ?? "");
      const isForumTopic = msg.source === "telegram" && msg.chatId === adapterGroupId && threadId;
      if (isForumTopic) {
        this.topicCommands.handleUnboundTopic(msg);
      }
      return;
    }

    // Classic channel: log all messages, only forward /chat to agent
    if (target.kind === "classic") {
      if (msg.adapterId) this.bindInstanceAdapter(target.name, msg.adapterId, true);
      await this.handleClassicChannelMessage(target.name, msg);
      return;
    }

    const instanceName = target.name;

    // Intercept /ctx /compact /collab in ANY topic (including general)
    if (await this.topicCommands.handleInstanceCommand(msg, instanceName)) {
      return;
    }

    // Intercept admin commands (/status, /restart, /sysinfo) in general topics
    const instanceConfig = this.fleetConfig?.instances[instanceName];
    if (instanceConfig?.general_topic && await this.topicCommands.handleGeneralCommand(msg)) {
      return;
    }

    // Bind instance to the adapter that delivered this message
    if (msg.adapterId) this.bindInstanceAdapter(instanceName, msg.adapterId, true);

    const inboundAdapter = this.worlds.get(msg.adapterId ?? "")?.adapter ?? this.adapter!;

    // React immediately — before any other Discord API calls. Use the adapter
    // BOUND to the instance (not whichever same-guild bot received the event
    // first) so exactly the owning bot reacts — no duplicate 👀 from a sibling.
    if (msg.chatId && msg.messageId) {
      const reactAdapter = this.getAdapterForInstance(instanceName) ?? inboundAdapter;
      reactAdapter.react(this.reactTarget(msg), msg.messageId, "👀")
        .catch(e => this.logger.debug({ err: (e as Error).message }, "Auto-react failed"));
    }

    // These may hit Discord API (topic icon, archive) — do after react
    if (this.topicArchiver.isArchived(threadId)) {
      await this.topicArchiver.reopen(threadId, instanceName);
    }

    this.touchActivity(instanceName);
    this.setTopicIcon(instanceName, "blue");
    this.warnIfRateLimited(instanceName, msg);

    const { text, extraMeta } = await processAttachments(msg, inboundAdapter, this.logger, instanceName);
    const reactions = this.pendingReactionsMeta(instanceName);

    try {
      await this.deliverToInstance(instanceName, {
        type: "fleet_inbound",
        content: text,
        targetSession: instanceName, // Channel messages → instance's own session
        meta: {
          chat_id: msg.chatId,
          message_id: msg.messageId,
          user: msg.username,
          user_id: msg.userId,
          ts: msg.timestamp.toISOString(),
          thread_id: msg.threadId ?? "",
          // Canonicalize the reply context to the configured world. Whichever
          // sibling bot wins inbound dedup must not decide which bot replies.
          adapter_id: this.getInstanceAdapterId(instanceName) ?? msg.adapterId,
          source: msg.source,
          ...(msg.replyToText ? { reply_to_text: msg.replyToText } : {}),
          ...reactions.meta,
          ...extraMeta,
        },
      });
      // Only after the message actually went out. A failed delivery keeps the
      // reactions queued for the retry / the next message.
      reactions.consume();
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, instanceName }, "Wake/delivery failed");
      if (msg.chatId && msg.messageId) {
        const reactAdapter = this.getAdapterForInstance(instanceName) ?? inboundAdapter;
        reactAdapter.react(this.reactTarget(msg), msg.messageId, "❌").catch(() => {});
      }
      return;
    }
    this.lastInboundUser.set(instanceName, msg.username);
    this.logger.info(`${msg.username} → ${instanceName}: ${(text ?? "").slice(0, 100)}`);
    this.eventLog?.logActivity("message", msg.username, (text ?? "").slice(0, 200), instanceName);
    this.emitSseEvent("message", {
      instance: instanceName, sender: msg.username,
      text: (text ?? "").slice(0, 2000), ts: new Date().toISOString(),
    });
    this.trackInboundMsg(instanceName, msg);
    void this.sendCancelButton(instanceName);
  }

  /** Handle outbound tool calls from a daemon instance */
  /** Warn (but don't block) when rate limits are high. 30-min debounce per instance. */
  private rateLimitWarnedAt = new Map<string, number>();
  private warnIfRateLimited(instanceName: string, msg: InboundMessage): void {
    const rl = this.statuslineWatcher.getRateLimits(instanceName);
    if (!rl) return;
    let warning = "";
    if (rl.five_hour_pct >= 95) {
      warning = t("rate_limit.five_hour", instanceName, Math.round(rl.five_hour_pct));
    } else if (rl.seven_day_pct >= 95) {
      warning = t("rate_limit.weekly", instanceName, Math.round(rl.seven_day_pct));
    }
    if (!warning) return;
    const lastWarn = this.rateLimitWarnedAt.get(instanceName) ?? 0;
    if (Date.now() - lastWarn < 30 * 60_000) return;
    this.rateLimitWarnedAt.set(instanceName, Date.now());
    const warnAdapter = this.worlds.get(msg.adapterId ?? "")?.adapter ?? this.adapter;
    if (warnAdapter && msg.chatId) {
      warnAdapter.sendText(msg.chatId, warning, { threadId: msg.threadId ?? undefined }).catch(() => {});
    }
  }

  /** Handle outbound tool calls from a daemon instance */
  private async handleOutboundFromInstance(instanceName: string, msg: Record<string, unknown>): Promise<void> {
    this.touchActivity(instanceName);
    this.setTopicIcon(instanceName, "green");
    const tool = msg.tool as string;
    const args = (msg.args ?? {}) as Record<string, unknown>;
    const requestId = msg.requestId as number | undefined;
    const fleetRequestId = msg.fleetRequestId as string | undefined;
    const senderSessionName = msg.senderSessionName as string | undefined;

    const respond = (result: unknown, error?: string) => {
      const ipc = this.instanceIpcClients.get(instanceName);
      let sent = false;
      if (fleetRequestId) {
        sent = ipc?.send({ type: "fleet_outbound_response", fleetRequestId, result, error }) ?? false;
      } else {
        sent = ipc?.send({ type: "fleet_outbound_response", requestId, result, error }) ?? false;
      }
      if (!sent) {
        this.logger.warn(
          { instanceName, tool, requestId, fleetRequestId, error },
          "Fleet outbound result could not be returned — instance IPC is disconnected",
        );
      }
    };

    if (this.worlds.size === 0) {
      respond(null, "Channel adapters are not ready — retry shortly");
      return;
    }

    // Resolve threadId: use sender's topic_id if sender is a known fleet instance,
    // fall back to general topic if sender is unknown, or IPC owner if no sender.
    const senderInstanceName = senderSessionName && this.fleetConfig?.instances[senderSessionName]
      ? senderSessionName
      : null;
    const routingConfig = senderInstanceName
      ? this.fleetConfig?.instances[senderInstanceName]
      : (senderSessionName ? undefined : this.fleetConfig?.instances[instanceName]);
    let threadId = resolveReplyThreadId(args.thread_id, routingConfig)
      ?? this.classicChannels?.getChannelIdByInstance(senderInstanceName ?? instanceName);

    // Select the adapter from the daemon's exact last-inbound context. Message
    // ids are scoped to that bot/world; routing a secondary-world id through the
    // primary adapter produces a 404. Instance binding remains the compatibility
    // fallback for older daemons and calls without a live/persisted context.
    const contextAdapterId = typeof msg.adapterId === "string" && msg.adapterId
      ? msg.adapterId
      : undefined;
    const contextWorld = contextAdapterId ? this.worlds.get(contextAdapterId) : undefined;
    if (contextAdapterId && !contextWorld) {
      respond(null, `Adapter world unavailable: ${contextAdapterId}`);
      return;
    }
    const outAdapter = contextWorld?.adapter
      ?? this.getAdapterForInstance(senderInstanceName ?? instanceName)
      ?? this.adapter;
    if (!outAdapter) { respond(null, "No adapter available"); return; }

    // For classic instances: force chat_id to channelId and clear thread_id
    // (daemon may have set chat_id to guild_id which is wrong for DC; TG may have set thread_id which causes 'thread not found')
    const classicChannelId = this.classicChannels?.getChannelIdByInstance(senderInstanceName ?? instanceName);
    if (classicChannelId) {
      args.chat_id = classicChannelId;
      delete args.thread_id;
      threadId = undefined;
    }

    // Reply dedup: retries land here when the agent was told a send failed
    // (daemon budget elapsed, shell tool killed) while the adapter send was
    // still in flight and about to succeed. One real send, everyone gets its
    // outcome; a genuinely failed send clears the entry so a retry passes.
    if (tool === "reply") {
      const ticket = this.replyDeduper.begin(
        instanceName,
        String(args.text ?? ""),
        Array.isArray(args.files) ? args.files as string[] : [],
      );
      if (ticket.duplicate) {
        this.logger.info({ instanceName }, "Concurrent duplicate reply joined — awaiting the original send's outcome");
        ticket.subscribe(respond);
        return;
      }
      const original = respond;
      const respondAndRecord = (result: unknown, error?: string) => {
        ticket.complete(result, error);
        // Return the platform outcome first. Bookkeeping below must never turn
        // a confirmed Discord/Telegram POST into a tool error if a secondary
        // log/button side effect happens to throw.
        original(result, error);
        // The adapter resolves only after the platform POST returns. Keep
        // outward-facing logs/cancel state on the same confirmation boundary:
        // a routed-but-failed reply is not a delivered reply.
        if (!error && result != null) {
          try {
            this.afterReplyRouted(instanceName, args, senderSessionName);
          } catch (err) {
            this.logger.warn({ err, instanceName }, "Reply delivered but post-delivery bookkeeping failed");
          }
        }
      };
      if (routeToolCall(outAdapter, tool, args, threadId, respondAndRecord)) {
        return;
      }
      // routeToolCall knows "reply"; not handling it means the world changed.
      ticket.complete(null, "reply not handled");
      original(null, "reply not handled");
      return;
    }

    // Route standard channel tools (reply, react, edit_message, download_attachment)
    if (routeToolCall(outAdapter, tool, args, threadId, respond)) {
      return;
    }

    // Log tool calls for activity visualization
    const senderLabel = senderSessionName ?? instanceName;
    this.eventLog?.logActivity("tool_call", senderLabel, this.summarizeToolCall(tool, args));

    // Dispatch fleet-specific tools via handler map
    const handler = outboundHandlers.get(tool);
    if (handler) {
      await handler(this, args, respond, { instanceName, requestId, fleetRequestId, senderSessionName });
    } else {
      respond(null, `Unknown tool: ${tool}`);
    }
  }

  /** Side effects of a routed reply: cancel-button lifecycle, logs, SSE, chat log. */
  private afterReplyRouted(instanceName: string, args: Record<string, unknown>, senderSessionName?: string): void {
    // A reply is NOT proof the turn is over (#410) — but it is not proof of
    // more work either. Split the difference: an instance that is clearly
    // idle loses the button now; one that looks busy keeps it (re-posted
    // below the reply so it stays last in the channel), with a 2-minute
    // grace check — if it has NOT resumed working by then, the reply was the
    // end of the turn and the button goes. A multi-step run that keeps
    // working sails through the check and keeps its button.
    if (this.getInstanceIdle(instanceName)) {
      this.clearCancelButton(instanceName);
    } else {
      void this.sendCancelButton(instanceName, undefined, true).then(() => this.armReplyGrace(instanceName));
    }
    this.reactDone(instanceName);
    const replyTo = this.lastInboundUser.get(instanceName) ?? "user";
    this.logger.info(`${instanceName} → ${replyTo}: ${(args.text as string ?? "").slice(0, 100)}`);
    this.emitSseEvent("message", {
      instance: instanceName, sender: senderSessionName ?? instanceName,
      text: (args.text as string ?? "").slice(0, 2000),
      ts: new Date().toISOString(),
    });
    // Log bot reply to classic instance chat-log
    const isClassic = this.classicChannels?.getChannelIdByInstance(instanceName) !== undefined;
    if (isClassic) {
      ClassicChannelManager.logMessage(instanceName, "bot", args.text as string ?? "", new Date());
    }
  }

  // ===================== Scheduler =====================

  private async handleScheduleTrigger(schedule: Schedule): Promise<void> {
    const { target, reply_chat_id, reply_thread_id, message, label, id, source, silent } = schedule;

    const RATE_LIMIT_DEFER_THRESHOLD = 85;
    const rl = this.statuslineWatcher.getRateLimits(target);
    if (rl && rl.five_hour_pct > RATE_LIMIT_DEFER_THRESHOLD) {
      this.scheduler!.recordRun(id, "deferred", `5hr rate limit at ${rl.five_hour_pct}%`);
      this.eventLog?.insert(target, "schedule_deferred", {
        schedule_id: id,
        label,
        five_hour_pct: rl.five_hour_pct,
      });
      this.webhookEmitter?.emit("schedule_deferred", target, { schedule_id: id, label, five_hour_pct: rl.five_hour_pct });
      this.notifyInstanceTopic(target, t("schedule.deferred", label ?? id, rl.five_hour_pct));
      this.logger.info({ target, scheduleId: id, rateLimitPct: rl.five_hour_pct }, "Schedule deferred due to rate limit");
      return;
    }

    // Silent mode: paste directly to tmux pane — no channel message.
    if (silent) {
      const ipc = this.instanceIpcClients.get(target);
      if (ipc) {
        ipc.send({
          type: "raw_paste",
          content: message,
          delivery_epoch: this.getDeliveryEpoch(target),
        });
        this.scheduler!.recordRun(id, "delivered");
        this.logger.info({ target, scheduleId: id, label }, "Silent schedule injected via raw_paste");
      } else {
        this.scheduler!.recordRun(id, "instance_offline", "IPC not connected");
        this.logger.warn({ target, scheduleId: id }, "Silent schedule: IPC not connected, skipping");
      }
      return;
    }

    const schedulerDefaults = this.fleetConfig?.defaults.scheduler;

    const retryCount = schedulerDefaults?.retry_count ?? 3;
    const retryInterval = schedulerDefaults?.retry_interval_ms ?? 30_000;

    const deliver = async (): Promise<boolean> => {
      try {
        // A schedule has no live inbound adapter context. Seed the daemon with
        // the target instance's configured world so replies use its persona
        // after a fresh start instead of falling back to channels[0].
        const adapterId = this.getInstanceAdapterId(target);
        await this.deliverToInstance(target, {
          type: "fleet_schedule_trigger",
          payload: { schedule_id: id, message: `[Scheduled] ${message}`, label },
          meta: {
            chat_id: reply_chat_id,
            thread_id: reply_thread_id,
            user: "scheduler",
            ...(adapterId ? { adapter_id: adapterId } : {}),
          },
        }, { waitForIdle: true });
        // A scheduled trigger also puts the instance to work — show a cancel button.
        void this.sendCancelButton(target);
        return true;
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, target }, "Scheduled wake/delivery attempt failed");
        return false;
      }
    };

    if (await deliver()) {
      this.scheduler!.recordRun(id, "delivered");
      if (source !== target) this.notifySourceTopic(schedule);
      return;
    }

    for (let i = 0; i < retryCount; i++) {
      await new Promise((r) => setTimeout(r, retryInterval));
      if (await deliver()) {
        this.scheduler!.recordRun(id, "delivered");
        if (source !== target) this.notifySourceTopic(schedule);
        return;
      }
    }

    this.scheduler!.recordRun(id, "instance_offline", `retry ${retryCount}x failed`);
    this.notifyScheduleFailure(schedule);
  }

  private notifySourceTopic(schedule: Schedule): void {
    const adapter = this.getAdapterForInstance(schedule.target) ?? this.adapter;
    if (!adapter) return;
    const text = `⏰ Schedule "${schedule.label ?? schedule.id}" triggered, target: ${schedule.target}`;
    adapter.sendText(schedule.reply_chat_id, text, {
      threadId: schedule.reply_thread_id ?? undefined,
    }).catch((err: unknown) => this.logger.error({ err }, "Failed to send cross-instance notification"));
  }

  private notifyScheduleFailure(schedule: Schedule): void {
    const adapter = this.getAdapterForInstance(schedule.target) ?? this.adapter;
    if (!adapter) return;
    const text = `⏰ Schedule "${schedule.label ?? schedule.id}" trigger failed: instance ${schedule.target} is offline.`;
    adapter.sendText(schedule.reply_chat_id, text, {
      threadId: schedule.reply_thread_id ?? undefined,
    }).catch((err: unknown) => this.logger.error({ err }, "Failed to send schedule failure notification"));
  }

  private handleScheduleCrud(instanceName: string, msg: Record<string, unknown>): void {
    const fleetRequestId = msg.fleetRequestId as string;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    const meta = (msg.meta ?? {}) as Record<string, string>;
    const ipc = this.instanceIpcClients.get(instanceName);
    if (!ipc) return;

    try {
      let result: unknown;

      switch (msg.type) {
        case "fleet_schedule_create": {
          const params = {
            cron: payload.cron as string | undefined,
            at: payload.at as string | undefined,
            message: payload.message as string,
            source: instanceName,
            target: (payload.target as string) || instanceName,
            reply_chat_id: meta.chat_id,
            reply_thread_id: meta.thread_id || null,
            label: payload.label as string | undefined,
            timezone: payload.timezone as string | undefined,
            silent: !!(payload.silent),
          };
          result = this.scheduler!.create(params);
          break;
        }
        case "fleet_schedule_list":
          result = this.scheduler!.list(payload.target as string | undefined);
          break;
        case "fleet_schedule_update":
          result = this.scheduler!.update(payload.id as string, payload as Record<string, unknown>);
          break;
        case "fleet_schedule_delete":
          this.scheduler!.delete(payload.id as string);
          result = "ok";
          break;
      }

      ipc.send({ type: "fleet_schedule_response", fleetRequestId, result });
    } catch (err) {
      ipc.send({ type: "fleet_schedule_response", fleetRequestId, error: (err as Error).message });
    }
  }

  private handleDecisionCrud(instanceName: string, msg: Record<string, unknown>): void {
    const fleetRequestId = msg.fleetRequestId as string;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    const meta = (msg.meta ?? {}) as Record<string, string>;
    const ipc = this.instanceIpcClients.get(instanceName);
    if (!ipc || !this.scheduler) return;

    const db = this.scheduler.db;
    const projectRoot = meta.working_directory || this.fleetConfig?.instances[instanceName]?.working_directory || "";

    try {
      let result: unknown;

      switch (msg.type) {
        case "fleet_decision_create": {
          // Prune expired decisions on create
          db.pruneExpiredDecisions();
          result = db.createDecision({
            project_root: projectRoot,
            scope: (payload.scope as "project" | "fleet" | undefined),
            title: payload.title as string,
            content: payload.content as string,
            tags: payload.tags as string[] | undefined,
            ttl_days: payload.ttl_days as number | undefined,
            created_by: instanceName,
            supersedes: payload.supersedes as string | undefined,
          });
          break;
        }
        case "fleet_decision_list":
          db.pruneExpiredDecisions();
          result = db.listDecisions(projectRoot, {
            includeArchived: payload.include_archived as boolean | undefined,
            tags: payload.tags as string[] | undefined,
          });
          break;
        case "fleet_decision_update": {
          const id = payload.id as string;
          if (payload.archive) {
            db.archiveDecision(id);
            result = { archived: true, id };
          } else {
            result = db.updateDecision(id, {
              content: payload.content as string | undefined,
              tags: payload.tags as string[] | undefined,
              ttl_days: payload.ttl_days as number | undefined,
            });
          }
          break;
        }
      }

      ipc.send({ type: "fleet_decision_response", fleetRequestId, result });
    } catch (err) {
      ipc.send({ type: "fleet_decision_response", fleetRequestId, error: (err as Error).message });
    }
  }

  /** Resolve display name for an instance, fallback to instance name. */
  resolveDisplayName(instanceName: string): string {
    return this.fleetConfig?.instances[instanceName]?.display_name
      ?? this.classicChannels?.getAll().find(ch => ch.instanceName === instanceName)?.displayName
      ?? instanceName;
  }

  /** Persist identity to the instance's actual config store. Classic instances
   * are registry rows in classicBot.yaml, not fleet.yaml instance entries. */
  private setInstanceDisplayName(instanceName: string, displayName: string): boolean {
    const fleetInstance = this.fleetConfig?.instances[instanceName];
    if (fleetInstance) {
      fleetInstance.display_name = displayName;
      this.saveFleetConfig();
      return true;
    }
    return this.classicChannels?.setDisplayNameByInstance(instanceName, displayName) ?? false;
  }

  private setInstanceDescription(instanceName: string, description: string): boolean {
    const fleetInstance = this.fleetConfig?.instances[instanceName];
    if (fleetInstance) {
      fleetInstance.description = description;
      this.saveFleetConfig();
      return true;
    }
    return this.classicChannels?.setDescriptionByInstance(instanceName, description) ?? false;
  }

  private handleSetDisplayName(instanceName: string, msg: Record<string, unknown>): void {
    const fleetRequestId = msg.fleetRequestId as string;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    const ipc = this.instanceIpcClients.get(instanceName);
    if (!ipc || !this.fleetConfig) return;

    const displayName = payload.name as string;
    if (!displayName || displayName.length > 30) {
      ipc.send({ type: "fleet_display_name_response", fleetRequestId, error: "Name must be 1-30 characters" });
      return;
    }

    if (!this.setInstanceDisplayName(instanceName, displayName)) {
      ipc.send({ type: "fleet_display_name_response", fleetRequestId, error: `Instance '${instanceName}' not found` });
      return;
    }
    this.logger.info({ instanceName, displayName }, "Display name set");
    ipc.send({ type: "fleet_display_name_response", fleetRequestId, result: { display_name: displayName } });
  }

  private handleSetDescription(instanceName: string, msg: Record<string, unknown>): void {
    const fleetRequestId = msg.fleetRequestId as string;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    const ipc = this.instanceIpcClients.get(instanceName);
    if (!ipc || !this.fleetConfig) return;

    const description = payload.description as string;
    if (!description) {
      ipc.send({ type: "fleet_description_response", fleetRequestId, error: "Description cannot be empty" });
      return;
    }

    if (!this.setInstanceDescription(instanceName, description)) {
      ipc.send({ type: "fleet_description_response", fleetRequestId, error: `Instance '${instanceName}' not found` });
      return;
    }
    this.logger.info({ instanceName, description: description.slice(0, 80) }, "Description set");
    ipc.send({ type: "fleet_description_response", fleetRequestId, result: { description } });
  }

  // ── Agent CLI HTTP handlers ─────────────────────────────────────────

  async handleScheduleCrudHttp(instance: string, op: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.scheduler) return { error: "Scheduler not available" };
    switch (op) {
      case "create":
        return this.scheduler.create({
          cron: args.cron as string | undefined,
          at: args.at as string | undefined,
          message: args.message as string,
          source: instance, target: (args.target as string) || instance,
          reply_chat_id: "", reply_thread_id: null,
          label: args.label as string | undefined,
          timezone: args.timezone as string | undefined,
        });
      case "list": return this.scheduler.list(args.target as string | undefined);
      case "update": return this.scheduler.update(args.id as string, args);
      case "delete": this.scheduler.delete(args.id as string); return "ok";
      default: return { error: `Unknown schedule op: ${op}` };
    }
  }

  async handleDecisionCrudHttp(instance: string, op: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.scheduler) return { error: "Scheduler not available" };
    const db = this.scheduler.db;
    const projectRoot = this.fleetConfig?.instances[instance]?.working_directory ?? "";
    const asStr = (v: unknown): string | undefined => typeof v === "string" ? v : undefined;
    const asNum = (v: unknown): number | undefined => typeof v === "number" ? v : undefined;
    const asStrArr = (v: unknown): string[] | undefined =>
      Array.isArray(v) && v.every(x => typeof x === "string") ? v as string[] : undefined;
    switch (op) {
      case "post": {
        const title = asStr(args.title);
        const content = asStr(args.content);
        if (!title || !content) return { error: "title and content are required" };
        const scope = args.scope === "fleet" ? "fleet" : "project";
        return db.createDecision({
          project_root: projectRoot,
          scope,
          title,
          content,
          tags: asStrArr(args.tags),
          ttl_days: asNum(args.ttl_days),
          supersedes: asStr(args.supersedes),
          created_by: instance,
        });
      }
      case "list": return db.listDecisions(projectRoot, {
        includeArchived: args.includeArchived === true,
        tags: asStrArr(args.tags),
      });
      case "update": {
        const id = asStr(args.id);
        if (!id) return { error: "id is required" };
        return db.updateDecision(id, {
          content: asStr(args.content),
          tags: asStrArr(args.tags),
          ttl_days: asNum(args.ttl_days),
        });
      }
      default: return { error: `Unknown decision op: ${op}` };
    }
  }

  async handleTaskCrudHttp(instance: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.scheduler) return { error: "Scheduler not available" };
    const db = this.scheduler.db;
    const action = args.action as string;
    const asStr = (v: unknown): string | undefined => typeof v === "string" ? v : undefined;
    const asStrArr = (v: unknown): string[] | undefined =>
      Array.isArray(v) && v.every(x => typeof x === "string") ? v as string[] : undefined;
    const asPriority = (v: unknown): "low" | "normal" | "high" | "urgent" | undefined => {
      return (v === "low" || v === "normal" || v === "high" || v === "urgent") ? v : undefined;
    };
    const asStatus = (v: unknown): "open" | "claimed" | "done" | "blocked" | "cancelled" | undefined => {
      return (v === "open" || v === "claimed" || v === "done" || v === "blocked" || v === "cancelled") ? v : undefined;
    };
    switch (action) {
      case "create": {
        const title = asStr(args.title);
        if (!title) return { error: "title is required" };
        return db.createTask({
          title,
          description: asStr(args.description),
          priority: asPriority(args.priority),
          assignee: asStr(args.assignee),
          depends_on: asStrArr(args.depends_on),
          created_by: instance,
        });
      }
      case "list": return db.listTasks({ assignee: asStr(args.filter_assignee), status: asStr(args.filter_status) });
      case "claim": {
        const id = asStr(args.id);
        if (!id) return { error: "id is required" };
        return db.claimTask(id, instance);
      }
      case "done": {
        const id = asStr(args.id);
        if (!id) return { error: "id is required" };
        return db.completeTask(id, asStr(args.result));
      }
      case "update": {
        const id = asStr(args.id);
        if (!id) return { error: "id is required" };
        return db.updateTask(id, {
          status: asStatus(args.status),
          assignee: asStr(args.assignee),
          result: asStr(args.result),
          priority: asPriority(args.priority),
        });
      }
      default: return { error: `Unknown task action: ${action}` };
    }
  }

  async handleSetDisplayNameHttp(instance: string, name: string): Promise<unknown> {
    if (!this.fleetConfig) return { error: "Fleet config not available" };
    if (!name || name.length > 30) return { error: "Name must be 1-30 characters" };
    if (!this.setInstanceDisplayName(instance, name)) return { error: `Instance '${instance}' not found` };
    return { display_name: name };
  }

  async handleSetDescriptionHttp(instance: string, description: string): Promise<unknown> {
    if (!this.fleetConfig) return { error: "Fleet config not available" };
    if (!description) return { error: "Description cannot be empty" };
    if (!this.setInstanceDescription(instance, description)) return { error: `Instance '${instance}' not found` };
    return { description };
  }

  private summarizeToolCall(tool: string, args: Record<string, unknown>): string {
    switch (tool) {
      case "send_to_instance": return `send_to_instance(${args.instance_name})`;
      case "broadcast": return `broadcast(${(args.targets as string[])?.join(", ") ?? "all"})`;

      case "request_information": return `request_information(${args.target_instance}, "${(args.question as string ?? "").slice(0, 60)}")`;
      case "delegate_task": return `delegate_task(${args.target_instance}, "${(args.task as string ?? "").slice(0, 60)}")`;
      case "report_result": return `report_result(${args.target_instance})`;
      case "task": return `task(${args.action}${args.title ? `, "${(args.title as string).slice(0, 40)}"` : args.id ? `, ${(args.id as string).slice(0, 8)}` : ""})`;
      case "post_decision": return `post_decision("${(args.title as string ?? "").slice(0, 40)}")`;
      case "list_decisions": return "list_decisions()";
      case "list_instances": return "list_instances()";
      case "describe_instance": return `describe_instance(${args.name})`;
      case "start_instance": return `start_instance(${args.name})`;
      case "create_instance": return `create_instance(${args.directory})`;
      case "delete_instance": return `delete_instance(${args.name})`;
      case "replace_instance": return `replace_instance(${args.name})`;
      default: return `${tool}()`;
    }
  }

  private handleTaskCrud(instanceName: string, msg: Record<string, unknown>): void {
    const fleetRequestId = msg.fleetRequestId as string;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    const meta = (msg.meta ?? {}) as Record<string, string>;
    const ipc = this.instanceIpcClients.get(instanceName);
    if (!ipc || !this.scheduler) return;

    const db = this.scheduler.db;
    const action = payload.action as string;

    try {
      let result: unknown;
      switch (action) {
        case "create":
          result = db.createTask({
            title: payload.title as string,
            description: payload.description as string | undefined,
            priority: payload.priority as "low" | "normal" | "high" | "urgent" | undefined,
            assignee: payload.assignee as string | undefined,
            depends_on: payload.depends_on as string[] | undefined,
            created_by: meta.instance_name || instanceName,
          });
          break;
        case "list":
          result = db.listTasks({
            assignee: payload.filter_assignee as string | undefined,
            status: payload.filter_status as string | undefined,
          });
          break;
        case "claim":
          result = db.claimTask(payload.id as string, meta.instance_name || instanceName);
          break;
        case "done":
          result = db.completeTask(payload.id as string, payload.result as string | undefined);
          break;
        case "update":
          result = db.updateTask(payload.id as string, {
            status: payload.status as string | undefined,
            assignee: payload.assignee as string | undefined,
            result: payload.result as string | undefined,
            priority: payload.priority as string | undefined,
          } as Record<string, unknown>);
          break;
        default:
          throw new Error(`Unknown task action: ${action}`);
      }
      ipc.send({ type: "fleet_task_response", fleetRequestId, result });

      // Activity log for task lifecycle events
      if (action === "create") {
        const t = result as { title: string; assignee?: string };
        this.eventLog?.logActivity("task_update", instanceName, `created task: ${t.title}`, t.assignee ?? undefined);
      } else if (action === "claim") {
        const t = result as { title: string };
        this.eventLog?.logActivity("task_update", instanceName, `claimed: ${t.title}`);
      } else if (action === "done") {
        const t = result as { title: string; result?: string };
        this.eventLog?.logActivity("task_update", instanceName, `completed: ${t.title}`, undefined, t.result ?? undefined);
      }
    } catch (err) {
      ipc.send({ type: "fleet_task_response", fleetRequestId, error: (err as Error).message });
    }
  }

  // ===================== Topic management =====================

  /** Create a forum topic via the adapter. Returns the message_thread_id. */
  async createForumTopic(topicName: string, adapterId?: string): Promise<number | string> {
    const adapter = (adapterId ? this.worlds.get(adapterId)?.adapter : undefined) ?? this.adapter;
    if (!adapter?.createTopic) {
      throw new Error("Adapter does not support topic creation");
    }
    return adapter.createTopic(topicName);
  }

  async deleteForumTopic(topicId: number | string): Promise<void> {
    try {
      if (!this.adapter?.deleteTopic) return;
      await this.adapter.deleteTopic(topicId);
    } catch (err) {
      this.logger.warn({ err, topicId }, "Failed to delete forum topic during rollback");
    }
  }

  private topicCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private sessionPruneTimer: ReturnType<typeof setInterval> | null = null;
  private classicReloadTimer: ReturnType<typeof setInterval> | null = null;
  private botUserId: string | undefined;

  /** Periodically check if bound topics still exist */
  private startTopicCleanupPoller(): void {
    this.topicCleanupTimer = setInterval(async () => {
      if (!this.fleetConfig?.channel?.group_id || !this.adapter?.topicExists) return;

      for (const [threadId, target] of this.routing.entries()) {
        try {
          if (!isProbeableRouteTarget(target)) {
            continue;
          }
          const exists = await this.adapter.topicExists(threadId);
          if (!exists) {
            await this.topicCommands.handleTopicDeleted(threadId);
          }
        } catch (err) {
          this.logger.debug({ err, threadId }, "Topic existence check failed");
        }
      }
    }, 5 * 60_000);
  }

  /**
   * Patch only values changed in the effective config into the original YAML
   * document. Unknown keys and comments remain untouched; redundant
   * non-identity instance leaves are canonicalized to inheritance afterward.
   */
  saveFleetConfig(explicitPatches: RawConfigPatch[] = []): void {
    if (!this.fleetConfig || !this.configPath) return;

    if (!this.savedFleetConfigSnapshot) this.savedFleetConfigSnapshot = structuredClone(this.fleetConfig);

    // Re-read immediately before patching so an unrelated concurrent/manual
    // edit is retained. Invalid concurrent YAML is never overwritten.
    const source = existsSync(this.configPath) ? readFileSync(this.configPath, "utf-8") : "{}\n";
    this.rawFleetDocument = parseDocument(source, { keepSourceTokens: true });
    if (this.rawFleetDocument.errors.length > 0) {
      throw new Error(`Refusing to overwrite invalid fleet.yaml: ${this.rawFleetDocument.errors[0].message}`);
    }
    this.rawFleetConfig = loadRawFleetConfig(this.configPath);

    this.patchFleetDocument(
      this.rawFleetDocument,
      [],
      this.savedFleetConfigSnapshot,
      this.fleetConfig,
    );

    // Settings edits are expressed against the raw config, so apply them before
    // canonicalization. A non-identity value equal to its inherited default is
    // intentionally stored as inheritance rather than an explicit duplicate.
    for (const patch of explicitPatches) {
      if (patch.remove) {
        // YAML's deleteIn throws when an inherited nested key has no raw parent
        // (or a legacy scalar occupies that parent). Removing an override which
        // is already absent is an idempotent no-op, not a failed Settings save.
        if (this.rawFleetDocument.hasIn(patch.path)) {
          this.rawFleetDocument.deleteIn(patch.path);
        }
      } else {
        const before = this.rawFleetDocument.getIn(patch.path);
        this.patchFleetDocument(this.rawFleetDocument, patch.path, before, patch.value);
      }
    }

    const rawAfterPatches = this.rawFleetDocument.toJS() as RawFleetConfig;
    const redundantPaths = collectRedundantInstanceDefaultPaths(rawAfterPatches);
    for (const path of redundantPaths) {
      if (this.rawFleetDocument.hasIn(path)) this.rawFleetDocument.deleteIn(path);
      // Avoid leaving empty operational maps such as `terminal: {}` while
      // preserving the instance mapping itself and all surrounding comments.
      for (let depth = path.length - 1; depth > 2; depth--) {
        const parentPath = path.slice(0, depth);
        const parent = this.rawFleetDocument.getIn(parentPath, true);
        if (!isMap(parent) || parent.items.length > 0) break;
        this.rawFleetDocument.deleteIn(parentPath);
      }
    }

    const output = String(this.rawFleetDocument);
    if (redundantPaths.length > 0) this.writeFleetConfigBackup(source);
    const tempPath = `${this.configPath}.tmp-${process.pid}`;
    writeFileSync(tempPath, output, "utf-8");
    if (existsSync(this.configPath)) chmodSync(tempPath, statSync(this.configPath).mode);
    renameSync(tempPath, this.configPath);

    this.rawFleetConfig = loadRawFleetConfig(this.configPath);
    this.savedFleetConfigSnapshot = structuredClone(this.fleetConfig);
    this.logger.info(
      { path: this.configPath, strippedDefaults: redundantPaths.length },
      "Saved fleet config (lossless patch)",
    );
  }

  /** One-time upgrade migration; invalid YAML is never rewritten. */
  private slimFleetConfigAtStartup(): void {
    const redundantPaths = collectRedundantInstanceDefaultPaths(this.rawFleetConfig);
    if (redundantPaths.length === 0) return;
    const validation = validateFleetConfig(this.rawFleetConfig);
    if (!validation.valid) {
      this.logger.warn(
        { errors: validation.errors, redundantDefaults: redundantPaths.length },
        "Skipping fleet.yaml default slimming because the raw config is invalid",
      );
      return;
    }
    try {
      this.saveFleetConfig();
      this.logger.info(
        { strippedDefaults: redundantPaths.length, backup: `${this.configPath}.bak` },
        "Slimmed redundant instance defaults in fleet.yaml",
      );
    } catch (err) {
      // A migration must not turn a previously bootable fleet into an outage.
      this.logger.warn({ err }, "Could not slim fleet.yaml; continuing with the original config");
    }
  }

  private writeFleetConfigBackup(source: string): void {
    if (!this.configPath) return;
    const backupPath = `${this.configPath}.bak`;
    const tempPath = `${backupPath}.tmp-${process.pid}`;
    writeFileSync(tempPath, source, "utf-8");
    if (existsSync(this.configPath)) chmodSync(tempPath, statSync(this.configPath).mode);
    renameSync(tempPath, backupPath);
  }

  private patchFleetDocument(
    document: ReturnType<typeof parseDocument>,
    path: Array<string | number>,
    before: unknown,
    after: unknown,
  ): void {
    if (Object.is(before, after)) return;

    if (Array.isArray(before) && Array.isArray(after)) {
      const shared = Math.min(before.length, after.length);
      for (let i = 0; i < shared; i++) {
        this.patchFleetDocument(document, [...path, i], before[i], after[i]);
      }
      // Remove from the end so YAML sequence indexes do not shift underneath us.
      for (let i = before.length - 1; i >= after.length; i--) {
        const itemPath = [...path, i];
        if (document.hasIn(itemPath)) document.deleteIn(itemPath);
      }
      for (let i = shared; i < after.length; i++) document.setIn([...path, i], after[i]);
      return;
    }

    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    if (isRecord(before) && isRecord(after)) {
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
      for (const key of keys) {
        // `channel` is a derived alias when the raw file uses `channels`.
        if (path.length === 0 && key === "channel" && this.rawFleetConfig.channels) continue;
        // Conversely, `channels` is a normalized alias for a legacy `channel`.
        // Keep the user's original shape unless the caller explicitly removed
        // `channel` (the Settings channels endpoint intentionally migrates it).
        if (path.length === 0 && key === "channels" && this.rawFleetConfig.channel && !this.rawFleetConfig.channels && after.channel !== undefined) continue;
        this.patchFleetDocument(document, [...path, key], before[key], after[key]);
      }
      return;
    }

    if (after === undefined) {
      // Effective config contains inherited objects that may not exist in the
      // raw YAML at all. yaml.deleteIn() is not idempotent for a missing nested
      // parent, so guard it explicitly.
      if (document.hasIn(path)) document.deleteIn(path);
    } else if (path.length === 0) {
      document.contents = document.createNode(after);
    } else {
      const currentNode = document.getIn(path, true);
      if (isScalar(currentNode) && (after === null || typeof after !== "object")) {
        currentNode.value = after;
      } else {
        // Use a YAML collection node for newly-added objects. Passing the raw
        // object creates a scalar wrapper: it serializes, but nested hasIn /
        // deleteIn cannot traverse it (notably when slimming create_instance).
        document.setIn(path, after !== null && typeof after === "object"
          ? document.createNode(after)
          : after);
      }
    }
  }

  async removeInstance(name: string): Promise<void> {
    // Drop cached pane context — the map is keyed by instance name and nothing
    // else evicted deleted entries, so it grew for the life of the process.
    forgetInstanceContext(name);
    // Clean up schedules (scheduler is fleet-level, not lifecycle-level)
    const config = this.fleetConfig?.instances[name];
    if (this.scheduler && config?.topic_id) {
      const count = this.scheduler.deleteByInstanceOrThread(name, String(config.topic_id));
      if (count > 0) {
        this.logger.info({ name, count }, "Cleaned up schedules for deleted instance");
      }
    }
    // Clean up team memberships
    if (this.fleetConfig?.teams) {
      for (const [teamName, team] of Object.entries(this.fleetConfig.teams)) {
        const idx = team.members.indexOf(name);
        if (idx !== -1) {
          team.members.splice(idx, 1);
          this.logger.info({ team: teamName, instance: name }, "Removed deleted instance from team");
        }
        if (team.members.length === 0) {
          delete this.fleetConfig.teams[teamName];
          this.logger.info({ team: teamName }, "Deleted empty team");
        }
      }
    }

    await this.lifecycle.remove(name);

    // Clean up per-instance tracking maps so they don't grow unbounded
    // as instances are created and deleted over the lifetime of the fleet.
    this.lastActivity.delete(name);
    this.lastInboundUser.delete(name);
    this.rateLimitWarnedAt.delete(name);

    // Clean up statusline watcher + instance directory
    this.statuslineWatcher.unwatch(name);
    try {
      rmSync(this.getInstanceDir(name), { recursive: true, force: true });
    } catch (err) {
      this.logger.debug({ err, name }, "Instance dir cleanup failed");
    }
  }

  startStatuslineWatcher(name: string): void {
    if (this.lifecycle.isPaused(name)) return;
    this.statuslineWatcher.watch(name);
  }

  stopStatuslineWatcher(name: string): void {
    // Pausing stops I/O but retains the last observed limits for status views.
    this.statuslineWatcher.unwatch(name, true);
  }

  reactMessageStatus(instanceName: string, chatId: string, messageId: string, emoji: string): void {
    // React via the adapter BOUND to this instance — NOT the first discord world.
    // Otherwise, in a same-channel/same-guild multi-bot setup, the inbound 👀
    // (bound bot) and the delivery/confirm reactions (some other bot) come from
    // different bots, leaving a duplicate 👀 that never turns into ✅.
    const adapter = this.getAdapterForInstance(instanceName) ?? this.adapter;
    // Status reactions are Discord-only (TG/others use the inbound react path).
    if (!adapter || adapter.type !== "discord") return;
    adapter.react(chatId, messageId, emoji)
      .catch(e => this.logger.debug({ err: (e as Error).message }, "Message status react failed"));
  }

  // ── Model failover ──────────────────────────────────────────────────────

  private static FAILOVER_TRIGGER_PCT = 90;
  private static FAILOVER_RECOVER_PCT = 50;

  checkModelFailover(name: string, fiveHourPct: number): void {
    const config = this.fleetConfig?.instances[name];
    if (!config?.model_failover?.length) return;

    const daemon = this.daemons.get(name);
    if (!daemon) return;

    const failoverList = config.model_failover;
    const primaryModel = failoverList[0];
    const currentFailover = this.failoverActive.get(name);

    if (fiveHourPct >= FleetManager.FAILOVER_TRIGGER_PCT && !currentFailover) {
      // Trigger failover: pick next model in list
      const fallbackModel = failoverList.length > 1 ? failoverList[1] : undefined;
      if (!fallbackModel) return;

      this.failoverActive.set(name, fallbackModel);
      daemon.setModelOverride(fallbackModel);
      this.logger.info({ instance: name, from: primaryModel, to: fallbackModel, ratePct: fiveHourPct },
        "Model failover triggered");
      this.eventLog?.insert(name, "model_failover", {
        from: primaryModel, to: fallbackModel, five_hour_pct: fiveHourPct,
      });
      this.webhookEmitter?.emit("model_failover", name, { from: primaryModel, to: fallbackModel, five_hour_pct: fiveHourPct });
      this.notifyInstanceTopic(name, t("failover.triggered", fiveHourPct, fallbackModel, primaryModel));

    } else if (fiveHourPct < FleetManager.FAILOVER_RECOVER_PCT && currentFailover) {
      // Recover: switch back to primary
      this.failoverActive.delete(name);
      daemon.setModelOverride(undefined);
      this.logger.info({ instance: name, restored: primaryModel, ratePct: fiveHourPct },
        "Model failover recovered");
      this.eventLog?.insert(name, "model_recovered", {
        restored: primaryModel, five_hour_pct: fiveHourPct,
      });
      this.webhookEmitter?.emit("model_recovered", name, { restored: primaryModel, five_hour_pct: fiveHourPct });
      this.notifyInstanceTopic(name, t("failover.recovered", fiveHourPct, primaryModel));
    }
  }

  toggleFleetCollab(instanceName: string): boolean {
    if (this.collabInstances.has(instanceName)) {
      this.collabInstances.delete(instanceName);
      return false;
    }
    this.collabInstances.add(instanceName);
    return true;
  }

  /**
   * Open the event log, tolerating a corrupt file.
   *
   * `events.db` holds history only — event rows and the activity feed. Nothing the
   * fleet needs to run depends on it, and every consumer already uses
   * `this.eventLog?.`. An unguarded `new EventLog(...)` here meant a corrupt or
   * unreadable history file (a truncated WAL after a hard kill, a full disk)
   * threw during startAll and the WHOLE FLEET FAILED TO BOOT — trading every
   * running agent for a file whose only job is reporting.
   *
   * So: try, move a bad file aside and retry once with a fresh one, and if even
   * that fails carry on without an event log.
   */
  /**
   * Run `agend backend doctor` for the fleet's default backend and return its
   * cleaned output.
   *
   * Async on purpose: this was `execSync` with a 30s timeout, reachable by any
   * allowlisted user through `/doctor`. While it ran, the entire fleet event loop
   * was frozen — no IPC, no adapter, no message delivery, no health responses,
   * and critically no WATCHDOG ping, so a slow doctor could push past
   * WatchdogSec and have systemd SIGABRT the fleet.
   */
  private async runBackendDoctor(): Promise<string> {
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    const backend = this.fleetConfig?.defaults?.backend || "claude-code";
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      // execFile with an argv array — no shell, so the backend name cannot be
      // interpreted as a command even if config is malformed.
      const { stdout } = await promisify(execFile)("agend", ["backend", "doctor", backend], {
        timeout: 30_000,
        encoding: "utf-8",
      });
      return stripAnsi(stdout) || "No output";
    } catch (err) {
      const e = err as { code?: string; stdout?: string; message?: string };
      const output = stripAnsi(e.stdout ?? "").trim();
      if (output) return output;
      if (e.code === "ENOENT") {
        return t("doctor.cli_missing");
      }
      return stripAnsi(e.message ?? "").trim() || t("doctor.failed");
    }
  }

  /** Drop event/activity rows older than the retention window. Best-effort. */
  /**
   * Cap every instance's pipe-pane log, walking the instances **directory** rather
   * than the config.
   *
   * A running instance rotates its own log on each health tick, so the ones that
   * need this are the ones nothing else looks at:
   *
   *   - deleted instances, whose directory outlives the config entry. Nothing ever
   *     touched these again. On the machine this was found on, one held 122 MB and
   *     another 74 MB, out of 622 MB of pipe-pane logs in total.
   *   - classic instances, which live in classicChannels, not fleetConfig.instances,
   *     and so were never in the old config-driven loop at all.
   *   - stopped instances, which have no health tick running.
   *
   * pipe-pane writes raw TUI output, so a wedged splash screen can emit ANSI frames
   * at animation rate. Unbounded growth here fills the disk, which takes the whole
   * fleet down rather than one instance.
   */
  private rotateAllInstanceLogs(): void {
    const root = join(this.dataDir, "instances");
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      return; // no instances directory yet
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // rotateLogIfNeeded is already best-effort and returns early on a missing
      // file, so a directory without a pipe-pane log costs one stat.
      rotateLogIfNeeded(join(root, entry.name, "output.log"));
    }
  }

  private pruneEventLog(): void {
    try {
      this.eventLog?.prune(FleetManager.EVENT_LOG_RETENTION_DAYS);
    } catch (err) {
      this.logger.warn({ err }, "Event log prune failed");
    }
  }

  private openEventLog(): EventLog | null {
    const dbPath = join(this.dataDir, "events.db");
    try {
      return new EventLog(dbPath);
    } catch (err) {
      this.logger.error({ err, dbPath }, "events.db unusable — moving it aside and starting a fresh one");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      for (const suffix of ["", "-wal", "-shm"]) {
        try { renameSync(`${dbPath}${suffix}`, `${dbPath}${suffix}.corrupt-${stamp}`); } catch { /* may not exist */ }
      }
      try {
        return new EventLog(dbPath);
      } catch (retryErr) {
        // History is worth losing; a fleet that won't start is not.
        this.logger.error({ err: retryErr, dbPath }, "Could not open a fresh events.db — continuing without event logging");
        return null;
      }
    }
  }

  /**
   * Report a fleet-level fault (not attributable to one instance) to the General
   * topic, so the operator learns about it without reading daemon.log.
   *
   * Throttled per distinct message: an unhandled rejection typically comes from a
   * loop (a poller, a repeating timer), and one channel message per occurrence
   * would bury the topic — which is worse than silence. First occurrence goes out
   * immediately, repeats are suppressed for THROTTLE_MS and then re-sent with a
   * count.
   *
   * The log line is written by the caller regardless: if every adapter is down,
   * the only notification path is the one that is broken.
   */
  notifyFleetError(text: string): void {
    const now = Date.now();
    const key = text.slice(0, 200);
    const seen = this.fleetErrorNotices.get(key);
    if (seen && now - seen.at < FleetManager.FLEET_ERROR_THROTTLE_MS) {
      seen.suppressed++;
      return;
    }
    const suppressed = seen?.suppressed ?? 0;
    this.fleetErrorNotices.set(key, { at: now, suppressed: 0 });
    // Bound the map: it is keyed by message text, and a message with a varying
    // suffix (a path, an id) would otherwise grow it without limit.
    if (this.fleetErrorNotices.size > 100) {
      const oldest = this.fleetErrorNotices.keys().next().value;
      if (oldest !== undefined) this.fleetErrorNotices.delete(oldest);
    }

    const body = suppressed > 0
      ? `${text}\n${t("fleet.error_suppressed", suppressed, Math.round(FleetManager.FLEET_ERROR_THROTTLE_MS / 60_000))}`
      : text;

    // Resolved from config, NOT findGeneralInstance(): that requires a live daemon,
    // and a fleet-level fault is exactly when the General may be down. The topic
    // itself still exists, and notifyInstanceTopic only needs adapter + group +
    // topic_id to post into it.
    const general = Object.entries(this.fleetConfig?.instances ?? {})
      .find(([, config]) => config.general_topic === true)?.[0];
    if (general) {
      this.notifyInstanceTopic(general, body);
      return;
    }
    // No General instance — fall back to the primary channel's group.
    const channelCfg = this.getChannelConfig();
    const groupId = channelCfg?.group_id;
    if (this.adapter && groupId) {
      this.adapter.sendText(String(groupId), body)
        .catch(err => this.logger.warn({ err }, "Failed to send fleet error notification"));
      return;
    }
    this.logger.warn({ text: body }, "Fleet error had no notification target (no General instance, no adapter)");
  }

  private static readonly FLEET_ERROR_THROTTLE_MS = 10 * 60_000;
  private fleetErrorNotices = new Map<string, { at: number; suppressed: number }>();

  notifyInstanceTopic(instanceName: string, text: string, extraOpts?: import("./channel/types.js").SendOpts): void {
    const adapter = this.getAdapterForInstance(instanceName) ?? this.adapter;
    if (!adapter) return;
    const channelCfg = this.getChannelConfig(this.getInstanceAdapterId(instanceName));
    const groupId = channelCfg?.group_id;

    // Fleet topic instance
    const threadId = this.fleetConfig?.instances[instanceName]?.topic_id;
    if (threadId != null && groupId) {
      adapter.sendText(String(groupId), text, { threadId: String(threadId), ...extraOpts })
        .catch(e => this.logger.warn({ err: e, instanceName }, "Failed to send instance topic notification"));
      return;
    }

    // Classic instance: find its channelId from the classic manager
    const classicChatId = this.classicChannels?.getChannelIdByInstance(instanceName);
    if (classicChatId) {
      adapter.sendText(classicChatId, text, extraOpts)
        .catch(e => this.logger.warn({ err: e, instanceName }, "Failed to send classic notification"));
      return;
    }

    // Fallback: send to group without threadId
    if (groupId) {
      adapter.sendText(String(groupId), text, extraOpts)
        .catch(e => this.logger.warn({ err: e, instanceName }, "Failed to send notification (no topic)"));
    }
  }

  // ── Nonce-armed button prompts (hang / assist / exit / clear) ──
  //
  // One shared lifecycle for every "notification with decision buttons":
  // post with a 128-bit nonce, arm a bounded expiry, bind the click to the
  // exact adapter+chat+thread+message that created it, require fleet admin for
  // actions that mutate runtime state (Tips are the harmless exception),
  // consume exactly once. The features differ only in what they post
  // and what a consumed click does.

  /**
   * Post decision buttons whose callback ids are `<prefix><nonce>:<action>`.
   * The entry is registered before the send and rolled back if the send
   * fails, so a nonce in the map always refers to a message that exists (or
   * is about to). Returns the nonce, or null when the alert could not be sent.
   */
  private async postNonceButtonPrompt(opts: {
    prefix: string;
    alertType: AlertData["type"];
    instanceName: string;
    adapter: ChannelAdapter;
    adapterId: string;
    chatId: string;
    threadId?: string;
    message: string;
    choices: Array<{ action: string; label: string }>;
    expiredText: string;
    extra?: Pick<NonceButtonEntry, "generalName" | "promptKind" | "authChannelId" | "allowAnyUser" | "tipId">;
    timeoutMs?: number;
  }): Promise<string | null> {
    // 16 bytes = the 128-bit capability the design claims. Telegram's 64-byte
    // callback_data cap still holds: longest id is "interactive-assist:" (19)
    // + 32 hex + ":confirm" (8) = 59 bytes.
    const nonce = randomBytes(16).toString("hex");
    const entry: NonceButtonEntry = {
      prefix: opts.prefix,
      instanceName: opts.instanceName,
      adapterId: opts.adapterId,
      adapter: opts.adapter,
      chatId: opts.chatId,
      threadId: opts.threadId,
      expiredText: opts.expiredText,
      ...opts.extra,
    };
    entry.timer = setTimeout(() => {
      const pending = this.pendingNonceButtons.get(nonce);
      if (pending !== entry) return;
      this.pendingNonceButtons.delete(nonce);
      if (entry.messageId && entry.adapter.editMessageRemoveButtons) {
        entry.adapter.editMessageRemoveButtons(
          entry.chatId,
          entry.messageId,
          entry.expiredText,
          entry.threadId,
        ).catch(err => this.logger.debug({ err, instanceName: entry.instanceName, prefix: entry.prefix },
          "Failed to expire button prompt"));
      }
    }, opts.timeoutMs ?? NONCE_BUTTON_TIMEOUT_MS);
    entry.timer.unref?.();
    this.pendingNonceButtons.set(nonce, entry);

    try {
      const sent = await opts.adapter.notifyAlert(opts.chatId, {
        type: opts.alertType,
        instanceName: opts.instanceName,
        message: opts.message,
        choices: opts.choices.map(c => ({ id: `${opts.prefix}${nonce}:${c.action}`, label: c.label })),
      }, opts.threadId ? { threadId: opts.threadId } : undefined);
      entry.messageId = sent.messageId;
      return nonce;
    } catch (err) {
      this.pendingNonceButtons.delete(nonce);
      if (entry.timer) clearTimeout(entry.timer);
      this.logger.warn({ err, instanceName: opts.instanceName, prefix: opts.prefix },
        "Failed to send button prompt");
      return null;
    }
  }

  /**
   * Validate a nonce-armed callback and claim it exactly once.
   *
   * Returns:
   *  - null       — the callback is not for this prefix; try the next handler
   *  - "consumed" — for this prefix but stale/denied/malformed; stop dispatch
   *  - the entry+action — the click is authorized and claimed before any await
   *
   * A stale click (expired nonce, or a pre-upgrade button whose payload no
   * longer parses) collapses the clicked message so the dead button stops
   * inviting clicks — the same courtesy the cancel button extends.
   */
  private consumeNonceCallback(
    prefix: string,
    actionRe: RegExp,
    data: AdapterCallbackData,
    callbackAdapterId: string,
    receivingAdapter?: ChannelAdapter,
    staleHandling?: {
      /** Strip only the keyboard, preserving the message text (tips stay readable). */
      keepText?: boolean;
      /** Always-delivered follow-up. Edits can fail silently — Telegram refuses
       * ANY edit on messages older than 48h, exactly the age of a restart-orphaned
       * button — so a fresh message is the only guaranteed feedback. */
      notice?: string;
    },
  ): { entry: NonceButtonEntry; action: string } | "consumed" | null {
    if (!data.callbackData.startsWith(prefix)) return null;
    const match = data.callbackData.match(actionRe);
    let pending = match ? this.pendingNonceButtons.get(match[1]) : undefined;
    // The map is shared across prompt kinds. A nonce that resolves to an entry
    // of a DIFFERENT kind is not a usable capability for this handler — treat
    // it as stale rather than acting across kinds (fail closed).
    if (pending && pending.prefix !== prefix) pending = undefined;
    if (!match || !pending) {
      const adapter = receivingAdapter ?? this.adapter;
      if (staleHandling?.keepText && adapter?.removeMessageButtons) {
        adapter.removeMessageButtons(data.chatId, data.messageId, data.threadId)
          .catch(() => { /* >48h on Telegram, or message gone — notice below still lands */ });
      } else {
        adapter?.editMessageRemoveButtons?.(
          data.chatId,
          data.messageId,
          t("buttons.stale"),
          data.threadId,
        ).catch(() => { /* message may be gone — nothing to collapse */ });
      }
      if (staleHandling?.notice) {
        adapter?.sendText(data.chatId, staleHandling.notice, { threadId: data.threadId })
          .catch(() => { /* channel gone — nothing else to do */ });
      }
      return "consumed";
    }

    // Bind the capability to the exact message/world that created it. Telegram
    // keyboards are visible to everyone, so mutating actions require fleet admin;
    // a Tip acknowledgement only records that the shared content was read.
    const isAuthorized = data.userId
      ? pending.allowAnyUser
        ? true
        : pending.authChannelId
        ? this.isModelAdmin(data.userId, pending.authChannelId, callbackAdapterId)
        : this.isFleetAdmin(data.userId, callbackAdapterId)
      : false;
    const mismatchedFields: string[] = [];
    if (pending.adapterId !== callbackAdapterId) mismatchedFields.push("adapterId");
    if (data.chatId !== pending.chatId) mismatchedFields.push("chatId");
    if (pending.threadId != null && data.threadId !== pending.threadId) mismatchedFields.push("threadId");
    if (pending.messageId != null && data.messageId !== pending.messageId) mismatchedFields.push("messageId");
    if (!isAuthorized) mismatchedFields.push("authorization");
    if (mismatchedFields.length > 0) {
      // Deliberately does NOT consume the nonce: the real admin can still click.
      this.logger.warn({
        instanceName: pending.instanceName,
        prefix,
        userId: data.userId,
        mismatchedFields: mismatchedFields.join(","),
      }, "Rejected unauthorized or mismatched button callback");
      return "consumed";
    }

    // Claim before any await: double clicks and duplicate callback delivery
    // can never act twice for state-changing actions.
    this.pendingNonceButtons.delete(match[1]);
    if (pending.timer) clearTimeout(pending.timer);
    return { entry: pending, action: match[2] };
  }

  /** Collapse a consumed prompt's buttons into a final status line. */
  private async retireNonceButtons(
    pending: NonceButtonEntry,
    messageId: string,
    text: string,
  ): Promise<void> {
    if (!pending.adapter.editMessageRemoveButtons) {
      this.logger.warn({ instanceName: pending.instanceName, adapterId: pending.adapterId },
        "Adapter cannot remove prompt buttons");
      return;
    }
    try {
      await pending.adapter.editMessageRemoveButtons(
        pending.chatId,
        messageId,
        text,
        pending.threadId,
      );
    } catch (err) {
      // The action was already atomically consumed. An edit failure must not
      // undo that or make the button actionable again.
      this.logger.warn({ err, instanceName: pending.instanceName }, "Failed to retire prompt buttons");
    }
  }

  private tipsEnabled(): boolean {
    return this.fleetConfig?.defaults.tips !== false;
  }

  private readTipState(): { dismissed: Set<string>; advancedUnlocked: boolean } | null {
    if (!this.scheduler) return null;
    try {
      return {
        dismissed: this.scheduler.db.listDismissedTipIds(),
        advancedUnlocked: this.scheduler.db.isAdvancedTipsUnlocked(),
      };
    } catch (err) {
      // Tips are additive. A damaged/locked scheduler DB must never block fleet
      // startup, update completion, or a General command.
      this.logger.warn({ err }, "Failed to read tip state");
      return null;
    }
  }

  private pickAvailableTip(): Tip | null {
    const state = this.readTipState();
    return state
      ? selectTip(state.dismissed, Math.random, state.advancedUnlocked, this.getActiveBackendIds())
      : null;
  }

  private tipText(tip: Tip): string {
    return getLocale() === "zh-TW" ? tip.text_zh : tip.text_en;
  }

  private formatTip(tip: Tip): string {
    return `💡 ${t("tips.label")}: ${this.tipText(tip)}`;
  }

  /** Persistently enable advanced tips through the admin-only slash command. */
  unlockAdvancedTips(userId: string): boolean {
    if (!this.scheduler) return false;
    try {
      this.scheduler.db.unlockAdvancedTips(userId);
      this.eventLog?.insert(this.findGeneralInstance() ?? "general", "tips_advanced_unlocked", {
        userId,
        source: "command",
      });
      return true;
    } catch (err) {
      this.logger.warn({ err, userId }, "Failed to unlock advanced tips from command");
      return false;
    }
  }

  /** Post one fresh nonce-armed tip in a known General channel. */
  async promptTip(
    generalName: string,
    adapter: ChannelAdapter,
    chatId: string,
    threadId?: string,
  ): Promise<"posted" | "empty" | "unavailable"> {
    const state = this.readTipState();
    if (!state) return "unavailable";
    if (!state.advancedUnlocked
      && visibleTipLevels(true).has("advanced")
      && canUnlockAdvancedTips(state.dismissed)) {
      return await this.promptAdvancedTipUnlock(generalName, adapter, chatId, threadId)
        ? "posted"
        : "unavailable";
    }
    const tip = selectTip(
      state.dismissed,
      Math.random,
      state.advancedUnlocked,
      this.getActiveBackendIds(),
    );
    if (!tip) return this.scheduler ? "empty" : "unavailable";
    const nonce = await this.postNonceButtonPrompt({
      prefix: TIP_DISMISS_CALLBACK_PREFIX,
      alertType: "tip",
      instanceName: generalName,
      adapter,
      adapterId: adapter.id,
      chatId,
      threadId,
      message: this.formatTip(tip),
      choices: [
        { action: "dismiss", label: t("tips.dismiss") },
        { action: "confused", label: t("tips.confused") },
      ],
      // Expiry removes only the stale button; the useful tip remains readable.
      expiredText: this.formatTip(tip),
      extra: { allowAnyUser: true, tipId: tip.id },
      timeoutMs: TIP_BUTTON_TIMEOUT_MS,
    });
    return nonce ? "posted" : "unavailable";
  }

  private async promptAdvancedTipUnlock(
    generalName: string,
    adapter: ChannelAdapter,
    chatId: string,
    threadId?: string,
  ): Promise<boolean> {
    const nonce = await this.postNonceButtonPrompt({
      prefix: TIP_UNLOCK_CALLBACK_PREFIX,
      alertType: "tip",
      instanceName: generalName,
      adapter,
      adapterId: adapter.id,
      chatId,
      threadId,
      message: t("tips.advanced.unlock_prompt"),
      choices: [{ action: "unlock", label: t("tips.advanced.unlock") }],
      expiredText: t("tips.advanced.expired"),
      extra: { allowAnyUser: true },
      timeoutMs: TIP_BUTTON_TIMEOUT_MS,
    });
    return nonce !== null;
  }

  private async sendTipToGeneral(): Promise<void> {
    if (!this.tipsEnabled()) return;
    const generalName = this.findGeneralInstance();
    if (!generalName) return;
    const adapter = this.getAdapterForInstance(generalName);
    const chatId = this.getGroupIdForInstance(generalName);
    const topicId = this.fleetConfig?.instances[generalName]?.topic_id;
    if (!adapter || !chatId) return;
    const result = await this.promptTip(
      generalName,
      adapter,
      chatId,
      topicId != null ? String(topicId) : undefined,
    );
    if (result === "unavailable") {
      this.logger.warn({ generalName }, "Daily tip could not be posted");
    }
  }

  private async handleTipDismiss(
    data: AdapterCallbackData,
    callbackAdapterId: string,
    receivingAdapter?: ChannelAdapter,
  ): Promise<boolean> {
    const claimed = this.consumeNonceCallback(
      TIP_DISMISS_CALLBACK_PREFIX,
      /^tip-dismiss:([0-9a-f]+):(dismiss|confused)$/,
      data,
      callbackAdapterId,
      receivingAdapter,
      // A restart orphans the expiry timer, so tip buttons can outlive their
      // nonce by days. Keep the tip text readable and always tell the clicker
      // what to do next (the keyboard edit itself can be refused: Telegram
      // rejects edits on messages older than 48h).
      { keepText: true, notice: t("tips.expired_use_tips") },
    );
    if (claimed === null) return false;
    if (claimed === "consumed") return true;
    const { entry: pending } = claimed;
    if (claimed.action === "confused") {
      if (!pending.tipId || !data.userId || !this.scheduler) {
        this.logger.error({ tipId: pending.tipId, userId: data.userId },
          "Tip feedback has incomplete persistence context");
        await this.retireNonceButtons(
          pending,
          pending.messageId ?? data.messageId,
          pending.expiredText,
        );
        await pending.adapter.sendText(
          pending.chatId,
          t("tips.unavailable"),
          { threadId: pending.threadId },
        );
        return true;
      }
      try {
        this.scheduler.db.recordTipFeedback(data.userId, pending.tipId, "confused");
      } catch (err) {
        this.logger.warn({ err, tipId: pending.tipId, userId: data.userId },
          "Failed to persist tip feedback");
        await this.retireNonceButtons(
          pending,
          pending.messageId ?? data.messageId,
          pending.expiredText,
        );
        await pending.adapter.sendText(
          pending.chatId,
          t("tips.unavailable"),
          { threadId: pending.threadId },
        ).catch(() => { /* feedback failure is non-fatal */ });
        return true;
      }
      this.logger.info({
        tipId: pending.tipId,
        userId: data.userId,
        feedbackType: "confused",
      }, "Tip feedback recorded");
      this.eventLog?.insert(pending.instanceName, "tip_feedback", {
        tipId: pending.tipId,
        userId: data.userId,
        feedbackType: "confused",
      });
      await this.retireNonceButtons(
        pending,
        pending.messageId ?? data.messageId,
        // Confusion is feedback, not a dismissal. Keep the Tip readable while
        // retiring this one-shot prompt; it remains eligible for future draws.
        pending.expiredText,
      );
      await pending.adapter.sendText(
        pending.chatId,
        t("tips.feedback_recorded"),
        { threadId: pending.threadId },
      ).catch(err => this.logger.warn({ err, tipId: pending.tipId },
        "Failed to acknowledge tip feedback"));
      return true;
    }
    if (!pending.tipId || !data.userId || !this.scheduler) {
      this.logger.error({ tipId: pending.tipId, userId: data.userId },
        "Tip dismissal has incomplete persistence context");
      await this.retireNonceButtons(pending, pending.messageId ?? data.messageId, t("tips.unavailable"));
      return true;
    }
    try {
      this.scheduler.db.dismissTip(data.userId, pending.tipId);
    } catch (err) {
      this.logger.warn({ err, tipId: pending.tipId, userId: data.userId },
        "Failed to persist tip dismissal");
      await this.retireNonceButtons(pending, pending.messageId ?? data.messageId, t("tips.unavailable"));
      return true;
    }
    this.eventLog?.insert(pending.instanceName, "tip_dismissed", {
      tipId: pending.tipId,
      userId: data.userId,
    });
    await this.retireNonceButtons(
      pending,
      pending.messageId ?? data.messageId,
      // Dismissal changes future selection only. Keep the useful tip text in
      // chat history and remove just the now-consumed button. Append a short
      // confirmation so the user sees feedback (unlike the pre-#605 version
      // that replaced the entire message with just the confirmation line).
      `${pending.expiredText}\n\n${t("tips.dismissed")}`,
    );
    const state = this.readTipState();
    if (state && !state.advancedUnlocked && canUnlockAdvancedTips(state.dismissed)) {
      await this.promptAdvancedTipUnlock(
        pending.instanceName,
        pending.adapter,
        pending.chatId,
        pending.threadId,
      );
    }
    return true;
  }

  private async handleTipUnlock(
    data: AdapterCallbackData,
    callbackAdapterId: string,
    receivingAdapter?: ChannelAdapter,
  ): Promise<boolean> {
    const claimed = this.consumeNonceCallback(
      TIP_UNLOCK_CALLBACK_PREFIX,
      /^tip-unlock:([0-9a-f]+):(unlock)$/,
      data,
      callbackAdapterId,
      receivingAdapter,
      { keepText: true, notice: t("tips.expired_use_tips") },
    );
    if (claimed === null) return false;
    if (claimed === "consumed") return true;
    const { entry: pending } = claimed;
    if (!data.userId || !this.scheduler) {
      await this.retireNonceButtons(pending, pending.messageId ?? data.messageId, t("tips.unavailable"));
      return true;
    }
    try {
      this.scheduler.db.unlockAdvancedTips(data.userId);
    } catch (err) {
      this.logger.warn({ err, userId: data.userId }, "Failed to unlock advanced tips");
      await this.retireNonceButtons(pending, pending.messageId ?? data.messageId, t("tips.unavailable"));
      return true;
    }
    this.eventLog?.insert(pending.instanceName, "tips_advanced_unlocked", { userId: data.userId });
    await this.retireNonceButtons(
      pending,
      pending.messageId ?? data.messageId,
      t("tips.advanced.unlocked"),
    );
    return true;
  }

  /** Post the destructive `/clear` confirmation in the invoking channel. */
  async promptClearConfirmation(
    instanceName: string,
    channelId: string,
    adapter: ChannelAdapter,
    chatId: string,
    threadId?: string,
  ): Promise<string | null> {
    if (!this.topicCommands.supportsClear(instanceName)) return t("clear.unsupported");

    const adapterId = adapter.id;
    if (!adapterId) return t("clear.prompt_unavailable");
    const nonce = await this.postNonceButtonPrompt({
      prefix: CLEAR_CONFIRM_CALLBACK_PREFIX,
      alertType: "clear_confirm",
      instanceName,
      adapter,
      adapterId,
      chatId,
      threadId,
      message: t("clear.confirm_message", instanceName),
      choices: [
        { action: "confirm", label: t("clear.confirm") },
        { action: "cancel", label: t("clear.cancel") },
      ],
      expiredText: t("clear.expired", instanceName),
      extra: { authChannelId: channelId },
      timeoutMs: CLEAR_CONFIRM_TIMEOUT_MS,
    });
    return nonce ? null : t("clear.prompt_unavailable");
  }

  /** Consume `/clear` Confirm/Cancel exactly once; only Confirm reaches IPC. */
  private async handleClearConfirmation(
    data: AdapterCallbackData,
    callbackAdapterId: string,
    receivingAdapter?: ChannelAdapter,
  ): Promise<boolean> {
    const claimed = this.consumeNonceCallback(
      CLEAR_CONFIRM_CALLBACK_PREFIX,
      /^clear-confirm:([0-9a-f]+):(confirm|cancel)$/,
      data,
      callbackAdapterId,
      receivingAdapter,
    );
    if (claimed === null) return false;
    if (claimed === "consumed") return true;
    const { entry: pending, action } = claimed;

    this.eventLog?.insert(pending.instanceName, "clear_action", { action, userId: data.userId });
    if (action === "cancel") {
      await this.retireNonceButtons(
        pending,
        pending.messageId ?? data.messageId,
        t("clear.cancelled", pending.instanceName),
      );
      return true;
    }

    await this.retireNonceButtons(
      pending,
      pending.messageId ?? data.messageId,
      t("clear.clearing", pending.instanceName),
    );
    try {
      const result = await this.topicCommands.sendClear(pending.instanceName);
      await pending.adapter.editMessage(
        pending.chatId,
        pending.messageId ?? data.messageId,
        result,
        pending.threadId,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, instanceName: pending.instanceName }, "Clear command failed");
      await pending.adapter.editMessage(
        pending.chatId,
        pending.messageId ?? data.messageId,
        t("clear.failed", pending.instanceName, message),
        pending.threadId,
      ).catch(editErr => this.logger.warn({ err: editErr, instanceName: pending.instanceName },
        "Failed to show clear command error"));
    }
    return true;
  }

  /**
   * Drop every pending prompt that refers to an instance being stopped or
   * restarted — a restart offer for an instance the operator just restarted
   * (or an assist for one they stopped) must not stay clickable for the rest
   * of its 15 minutes.
   */
  clearNoncePromptsForInstance(instanceName: string): void {
    for (const [nonce, entry] of this.pendingNonceButtons) {
      if (entry.instanceName !== instanceName) continue;
      this.pendingNonceButtons.delete(nonce);
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.messageId && entry.adapter.editMessageRemoveButtons) {
        entry.adapter.editMessageRemoveButtons(entry.chatId, entry.messageId, entry.expiredText, entry.threadId)
          .catch(err => this.logger.debug({ err, instanceName, prefix: entry.prefix },
            "Failed to collapse prompt during instance stop"));
      }
    }
  }

  /** A clean exit is intentional from the CLI's perspective, but often not from
   * the operator's. Keep the instance notice passive and put the action in the
   * same-world General topic where an administrator can make the choice. */
  async notifyNormalExit(instanceName: string): Promise<void> {
    this.notifyInstanceTopic(instanceName, t("exit.instance_notice", instanceName));

    const worldId = this.getInstanceAdapterId(instanceName);
    const generalName = this.findGeneralInstance(worldId);
    if (!generalName) {
      this.logger.warn({ instanceName, worldId }, "Normal CLI exit has no General notification target");
      return;
    }
    const adapterId = this.getInstanceAdapterId(generalName);
    const adapter = this.getAdapterForInstance(generalName);
    const chatId = this.getGroupIdForInstance(generalName);
    const topicId = this.fleetConfig?.instances[generalName]?.topic_id;
    const threadId = topicId != null ? String(topicId) : undefined;
    if (!adapter || !adapterId || !chatId) {
      this.logger.warn({ instanceName, generalName, adapterId, chatId },
        "Cannot address normal-exit restart controls");
      return;
    }

    await this.postNonceButtonPrompt({
      prefix: EXIT_RESTART_CALLBACK_PREFIX,
      alertType: "exit_restart",
      instanceName,
      adapter,
      adapterId,
      chatId,
      threadId,
      message: t("exit.general_notice", instanceName),
      choices: [
        { action: "restart", label: t("exit.restart") },
        { action: "ignore", label: t("exit.ignore") },
      ],
      expiredText: t("exit.expired", instanceName),
    });
  }

  /** Consume a clean-exit Restart/Ignore button exactly once. */
  private async handleExitRestartPrompt(
    data: AdapterCallbackData,
    callbackAdapterId: string,
    receivingAdapter?: ChannelAdapter,
  ): Promise<boolean> {
    const claimed = this.consumeNonceCallback(
      EXIT_RESTART_CALLBACK_PREFIX,
      /^exit-restart:([0-9a-f]+):(restart|ignore)$/,
      data,
      callbackAdapterId,
      receivingAdapter,
    );
    if (claimed === null) return false;
    if (claimed === "consumed") return true;
    const { entry: pending, action } = claimed;

    this.eventLog?.insert(pending.instanceName, "normal_exit_action", { action, userId: data.userId });
    if (action === "ignore") {
      await this.retireNonceButtons(
        pending,
        pending.messageId ?? data.messageId,
        t("exit.ignored", pending.instanceName),
      );
      return true;
    }

    await this.retireNonceButtons(
      pending,
      pending.messageId ?? data.messageId,
      t("exit.restarting", pending.instanceName),
    );
    try {
      await this.restartSingleInstance(pending.instanceName);
      await pending.adapter.editMessage(
        pending.chatId,
        pending.messageId ?? data.messageId,
        t("exit.restarted", pending.instanceName),
        pending.threadId,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, instanceName: pending.instanceName }, "Normal-exit restart failed");
      await pending.adapter.editMessage(
        pending.chatId,
        pending.messageId ?? data.messageId,
        t("exit.restart_failed", pending.instanceName, message),
        pending.threadId,
      ).catch(editErr => this.logger.warn({ err: editErr, instanceName: pending.instanceName },
        "Failed to show normal-exit restart error"));
    }
    return true;
  }

  private interactivePromptLabel(kind: string): string {
    const key = `interactive.kind.${kind}`;
    const translated = t(key);
    return translated === key ? kind.replaceAll("_", " ") : translated;
  }

  /**
   * Surface a stable terminal prompt in both places that matter:
   * - the blocked instance gets a plain pointer to General;
   * - General gets one-shot Confirm/Cancel controls on its own bound adapter.
   *
   * Only the prompt category crosses channels. The captured terminal line can
   * contain usernames or secret-adjacent text and stays in daemon.log.
   */
  async notifyInteractivePrompt(instanceName: string, kind: string): Promise<void> {
    this.notifyInstanceTopic(instanceName, t("interactive.instance_notice", instanceName));
    // Multi-world fleets can have one General per bot/platform. Route the assist
    // request to the General bound to the same adapter as the blocked instance.
    const generalName = this.findGeneralInstance(this.getInstanceAdapterId(instanceName));
    if (!generalName) {
      this.logger.warn({ instanceName }, "Interactive prompt has no General topic notification target");
      return;
    }

    const adapterId = this.getInstanceAdapterId(generalName);
    const adapter = this.getAdapterForInstance(generalName);
    const chatId = this.getGroupIdForInstance(generalName);
    const topicId = this.fleetConfig?.instances[generalName]?.topic_id;
    const threadId = topicId != null ? String(topicId) : undefined;
    if (!adapter || !adapterId || !chatId) {
      this.logger.warn({ instanceName, generalName, adapterId, chatId },
        "Cannot address interactive prompt assistance controls");
      return;
    }

    const label = this.interactivePromptLabel(kind);
    await this.postNonceButtonPrompt({
      prefix: INTERACTIVE_ASSIST_CALLBACK_PREFIX,
      alertType: "interactive_prompt",
      instanceName,
      adapter,
      adapterId,
      chatId,
      threadId,
      message: t("interactive.general_notice", instanceName, label),
      choices: [
        { action: "confirm", label: t("interactive.confirm") },
        { action: "cancel", label: t("interactive.cancel") },
      ],
      expiredText: t("interactive.expired", instanceName),
      extra: { generalName, promptKind: kind },
    });
  }

  /** Consume a General assist button exactly once. */
  private async handleInteractivePromptAssist(
    data: AdapterCallbackData,
    callbackAdapterId: string,
    receivingAdapter?: ChannelAdapter,
  ): Promise<boolean> {
    const claimed = this.consumeNonceCallback(
      INTERACTIVE_ASSIST_CALLBACK_PREFIX,
      /^interactive-assist:([0-9a-f]+):(confirm|cancel)$/,
      data,
      callbackAdapterId,
      receivingAdapter,
    );
    if (claimed === null) return false;
    if (claimed === "consumed") return true;
    const { entry: pending, action } = claimed;

    this.eventLog?.insert(pending.instanceName, "interactive_prompt_assist", {
      action,
      userId: data.userId,
      generalName: pending.generalName,
    });
    if (action === "cancel") {
      await this.retireNonceButtons(
        pending,
        pending.messageId ?? data.messageId,
        t("interactive.ignored", pending.instanceName),
      );
      return true;
    }

    // Fail closed on a malformed entry. generalName is set at posting time for
    // every interactive-assist entry; its absence means entry confusion, and
    // falling back to the blocked instance would type the assist text into the
    // very terminal prompt this feature exists to keep humans in front of.
    const generalName = pending.generalName;
    if (!generalName) {
      this.logger.error({ instanceName: pending.instanceName },
        "Interactive-assist entry has no General target — refusing to deliver");
      await this.retireNonceButtons(
        pending,
        pending.messageId ?? data.messageId,
        t("interactive.delivery_failed", pending.instanceName),
      );
      return true;
    }

    // Injecting into General while General itself is blocked would type into the
    // terminal prompt instead of the agent input. Fail safe and require attach.
    if (pending.instanceName === generalName) {
      await this.retireNonceButtons(
        pending,
        pending.messageId ?? data.messageId,
        t("interactive.self_assist", pending.instanceName),
      );
      return true;
    }

    await this.retireNonceButtons(
      pending,
      pending.messageId ?? data.messageId,
      t("interactive.confirmed", pending.instanceName),
    );

    try {
      await this.deliverToInstance(generalName, {
        type: "fleet_inbound",
        content: t("interactive.assist_request", pending.instanceName, this.interactivePromptLabel(pending.promptKind ?? "")),
        targetSession: generalName,
        meta: {
          chat_id: pending.chatId,
          message_id: pending.messageId ?? data.messageId,
          user: "AgEnD",
          user_id: data.userId,
          ts: new Date().toISOString(),
          thread_id: pending.threadId ?? "",
          adapter_id: pending.adapterId,
          source: pending.adapter.type,
        },
      }, {
        // This is system-generated work, not a live user message. Queue behind
        // General's current turn so Kiro/Claude do not lose it while busy.
        isCrossInstance: true,
      });
      this.logger.info({ instanceName: pending.instanceName, generalName: pending.generalName },
        "Interactive prompt assistance delivered to General");
    } catch (err) {
      this.logger.warn({ err, instanceName: pending.instanceName, generalName: pending.generalName },
        "Failed to deliver interactive prompt assistance to General");
      await pending.adapter.editMessage(
        pending.chatId,
        pending.messageId ?? data.messageId,
        t("interactive.delivery_failed", pending.instanceName),
        pending.threadId,
      );
    }
    return true;
  }

  // ── Cancel button ────────────────────────────────────────────────────
  // Sent after delivering a user message to an instance; clicking it (or
  // /cancel) sends Escape to the instance's pane to interrupt generation.

  /** Send a "🛑 Cancel" button to the instance's topic/channel after delivery. */
  /**
   * Handle the DC `/save` slash command for both classic AND fleet-topic targets.
   * Picks the backend-appropriate command (kiro → /chat save, claude → /export);
   * unsupported backends get a clear error. Routes via classic paste or fleet IPC.
   */
  private async handleSlashSave(data: { channelId: string; userId: string; options?: Record<string, string | boolean>; respond: (text: string) => Promise<string | undefined> }, adapterId?: string): Promise<void> {
    if (!this.classicChannels?.isAdmin(data.userId)) {
      await data.respond(t("admin.required"));
      return;
    }
    // Classic resolves per-bot (same-channel multi-bot); otherwise a fleet topic.
    const classicName = this.classicChannels.getInstanceByChannel(data.channelId, adapterId);
    const target: RouteTarget | undefined = classicName
      ? { kind: "classic", name: classicName }
      : this.routing.resolve(data.channelId);
    if (!target) {
      await data.respond(t("classic.no_agent_start"));
      return;
    }
    const filename = (data.options?.filename as string) ?? "";
    if (!SAVE_FILENAME_RE.test(filename)) {
      await data.respond(t("filename.invalid"));
      return;
    }
    const backend = target.kind === "classic"
      ? this.classicChannels.getBackendByInstance(target.name, this.fleetConfig?.defaults?.backend)
      : (this.fleetConfig?.instances[target.name]?.backend ?? this.fleetConfig?.defaults?.backend ?? "claude-code");
    // force (-f) is only meaningful for kiro/classic /chat save.
    const force = target.kind === "classic" && !!data.options?.force;
    const cmd = saveCommandForBackend(backend, filename, force);
    if (!cmd) {
      await data.respond(t("save.unsupported"));
      return;
    }
    if (target.kind === "classic") {
      this.pasteRawToClassicInstance(target.name, cmd);
    } else {
      this.instanceIpcClients.get(target.name)?.send({ type: "raw_paste", content: cmd });
    }
    await data.respond(t("save.sent", cmd, target.name));
  }

  /** Whether the instance currently has at least one live cancel button. */
  /**
   * A click on a cancel button, whether or not the fleet still tracks it.
   *
   * The old rule was "act only while an entry is live", which made a click on a
   * button the fleet had forgotten a silent no-op — no cancel, no message, not
   * even a log line. That is indistinguishable from a broken button, and it is
   * what the "按鈕點了沒反應" reports were: the entry is briefly absent while a
   * button is being replaced, and a delete that fails leaves the message on
   * screen with no entry at all.
   *
   * So: honour the click if the instance is actually running, and say so plainly
   * if it is not. The stale-click path is rate-limited because the original
   * concern was real — a second click must not fire a second interrupt key at an
   * instance that has already started a new turn.
   */
  private handleCancelClick(instanceName: string, adapter: ChannelAdapter | null, data: AdapterCallbackData): void {
    if (this.hasCancelButton(instanceName)) {
      this.cancelInstance(instanceName);
      return;
    }

    const lastAt = this.staleCancelClickAt.get(instanceName) ?? 0;
    if (Date.now() - lastAt < STALE_CANCEL_CLICK_COOLDOWN_MS) return;
    this.staleCancelClickAt.set(instanceName, Date.now());

    // cancelInstance returns false when there is no daemon — i.e. nothing to
    // cancel, which is the one case where the button really is dead.
    if (this.cancelInstance(instanceName)) {
      this.logger.info({ instanceName }, "Cancel click honoured with no live button entry");
      return;
    }
    this.logger.info({ instanceName }, "Cancel click on an expired button — instance not running");
    adapter?.editMessage(data.chatId, data.messageId, t("cancel.button_stale", instanceName), data.threadId)
      .catch(() => { /* the message may already be gone */ });
  }

  private hasCancelButton(instanceName: string): boolean {
    for (const e of this.cancelButtons.values()) {
      if (e.instanceName === instanceName) return true;
    }
    return false;
  }

  async sendCancelButton(instanceName: string, correlationId?: string, preserveProgress = false): Promise<void> {
    // Post first, retire after (see the tail of this method). Retiring up front
    // meant that from the delete until the new message came back — a chat API
    // round trip, and every reply goes through here — the instance had NO live
    // entry, while the old button was still on screen. A click in that window
    // hit `hasCancelButton() === false` and was silently dropped: the reported
    // "按鈕失效". If notifyAlert then failed, the button was simply gone.
    const adapter = this.getAdapterForInstance(instanceName) ?? this.adapter;
    if (!adapter) return;
    // Resolve the group through the world fallback (first world when unbound),
    // NOT through getChannelConfig(binding)?.group_id: on a fleet configured with
    // `channels:` worlds the primary `channel:` block is empty, so an instance
    // with no world binding yet (fresh restart, cross-instance delegation)
    // resolved group_id to undefined and the button silently never appeared.
    const adapterId = this.getInstanceAdapterId(instanceName);
    const groupId = this.getGroupIdForInstance(instanceName) || undefined;
    const topicId = this.fleetConfig?.instances[instanceName]?.topic_id;

    let chatId: string | undefined;
    let threadId: string | undefined;
    if (topicId != null && groupId) {
      // Fleet topic instance.
      chatId = String(groupId);
      threadId = String(topicId);
    } else {
      // Classic instance: channelId from the classic manager.
      chatId = this.classicChannels?.getChannelIdByInstance(instanceName);
      // General / flat fallback: post to the group (no thread).
      if (!chatId && groupId) chatId = String(groupId);
    }
    if (!chatId) {
      // A button that cannot be addressed must say so — this exact silence is how
      // "the cancel button sometimes never appears" stayed unreported-in-logs.
      this.logger.warn({ instanceName, topicId, groupId }, "Cannot address cancel button (no chat id resolved)");
      return;
    }

    try {
      const sent = await adapter.notifyAlert(chatId, {
        type: "cancel",
        instanceName,
        message: "👀 處理中…",
        choices: [{ id: `cancel:${instanceName}`, label: t("cancel.button") }],
      }, threadId ? { threadId } : undefined);

      const entry: CancelButtonEntry = {
        instanceName,
        adapterId,
        chatId: sent.chatId,
        messageId: sent.messageId,
        threadId: sent.threadId ?? threadId,
        correlationId,
        retryCount: 0,
        // Elapsed time is measured from when this button was posted — i.e. from
        // when the work was handed over — not from the pane's working transition,
        // which resets if the CLI blips idle mid-turn.
        startedAt: Date.now(),
        // Matches the text notifyAlert just posted, so the first 60s tick does
        // not re-edit identical text — which put a "(edited)" mark on Discord
        // with nothing visibly changed.
        lastProgressText: "👀 處理中…",
        // A reply can re-post the same in-flight bubble below the reply. Carry
        // its current list into that replacement; fresh inbound work must start
        // empty even if the daemon's reset broadcast is still in flight.
        toolProgress: preserveProgress ? this.instanceProgress.get(instanceName) : undefined,
      };
      this.startProgressTicker(entry);
      // Idle-check backstop: every 5min, if the instance is idle, retire the
      // button. Covers turns that end without hitting a clear trigger (reply /
      // cancel / correlation). Cleared in discardButton when the entry is removed.
      entry.idleCheckTimer = setInterval(() => {
        if (!this.cancelButtons.has(entry.messageId)) { clearInterval(entry.idleCheckTimer); return; }
        const reason = this.getInstanceIdle(instanceName) ? "idle"
          : this.stateReportDead(instanceName) ? "state reports stopped"
            : Date.now() - (entry.startedAt ?? 0) > CANCEL_BTN_MAX_LIFETIME_MS ? "24h ceiling"
              : null;
        if (reason) {
          this.logger.info({ instanceName, messageId: entry.messageId, reason }, "Cancel button backstop retiring");
          this.retireButton(entry);
          return;
        }
        // Still looks busy. The daemon only broadcasts on transitions, so ask for
        // a fresh snapshot — a live daemon's answer refreshes receivedAt and keeps
        // the staleness check honest; a dead one's silence is the evidence.
        this.instanceIpcClients.get(instanceName)?.send({
          type: "query_instance_state", requestId: `cancel-btn-${Date.now()}`,
        });
      }, CANCEL_BTN_IDLE_CHECK_INTERVAL_MS);
      this.cancelButtons.set(sent.messageId, entry);

      // Only now: at most one button per instance, but never zero. Covers both
      // the previous turn's button and any button a concurrent
      // sendCancelButton posted while we were awaiting notifyAlert.
      for (const other of [...this.cancelButtons.values()]) {
        if (other.instanceName === instanceName && other.messageId !== sent.messageId) {
          this.retireButton(other);
        }
      }

      this.persistCancelButtons();
      this.logger.info({ instanceName, messageId: sent.messageId }, "Cancel button sent");
    } catch (e) {
      this.logger.warn({ err: (e as Error).message, instanceName }, "Failed to send cancel button");
    }
  }

  /**
   * The cancel button's text for a given elapsed time.
   *
   * Below the threshold it keeps the original wording, so a normal quick answer
   * looks exactly as it did before. Past it, the button doubles as the live
   * progress indicator (#409) — the channel showed nothing at all during long work,
   * and once the agent had replied once there was no sign it was still going.
   */
  static progressText(elapsedMs: number, activity?: string | null, minElapsedMs = PROGRESS_MIN_ELAPSED_MS): string {
    if (elapsedMs < minElapsedMs) return "👀 處理中…";
    const elapsed = FleetManager.formatProgressElapsed(elapsedMs);
    const detail = FleetManager.sanitizeActivity(activity);
    return detail
      ? `⏳ 處理中… (已進行 ${elapsed} · ${detail})`
      : `⏳ 處理中… (已進行 ${elapsed})`;
  }

  /** Render elapsed time consistently in live and retained progress bubbles. */
  private static formatProgressElapsed(elapsedMs: number): string {
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes >= 60
      ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
      : `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }

  /** Final read-only form of a bubble that contains semantic tool history.
   * Neutral wording is intentional: the same retirement primitive is used for
   * normal completion, a mid-turn bubble replacement, and user cancellation,
   * so claiming every retained checkpoint is "completed" would be false. */
  private composeRetiredBubbleText(entry: CancelButtonEntry): string {
    const elapsed = FleetManager.formatProgressElapsed(
      Date.now() - (entry.startedAt ?? Date.now()),
    );
    return `🧾 工具歷程 (記錄至 ${elapsed})\n${entry.toolProgress}`;
  }

  /**
   * Make a tool summary safe to paste into a channel message.
   *
   * The text is agent-controlled (it is built from tool inputs — file paths,
   * shell commands), so it gets flattened to one line, capped, and stripped of
   * the two Discord mass-mention triggers. Neither channel renders it with a
   * parse mode, so no markup escaping is needed beyond that.
   */
  private static sanitizeActivity(activity?: string | null): string | null {
    if (!activity) return null;
    const flat = activity.replace(/\s+/g, " ").replace(/@(everyone|here)/g, "@​$1").trim();
    if (!flat) return null;
    return flat.length > PROGRESS_ACTIVITY_MAX_CHARS
      ? `${flat.slice(0, PROGRESS_ACTIVITY_MAX_CHARS - 1)}…`
      : flat;
  }

  /**
   * Remember what an instance is currently doing, for the progress line.
   *
   * Best-effort by design: only backends that expose a live activity feed report
   * anything, and the progress line simply omits the detail for the rest. It is
   * never used to decide anything — purely what the user is shown.
   */
  private cacheInstanceActivity(name: string, activity: string | null): void {
    if (activity) this.instanceActivity.set(name, activity);
    else this.instanceActivity.delete(name);
  }

  /**
   * Cache the turn's tool-progress list and push it into the instance's live
   * bubble, coalesced so a burst of tool events cannot flood the Bot API
   * (Telegram's flood limit is per-chat across ALL forum topics, so edits are
   * rate-limited per bubble AND ride behind the daemon-side 3s coalescer).
   */
  private cacheInstanceProgress(name: string, progress: string | null): void {
    if (progress) this.instanceProgress.set(name, progress);
    else this.instanceProgress.delete(name);
    for (const entry of this.cancelButtons.values()) {
      if (entry.instanceName !== name) continue;
      // Empty means the daemon completed/reset the turn. Clear the live cache
      // for the next turn, but retain this bubble's last non-empty list so its
      // retirement can preserve the history instead of deleting the message.
      if (progress) entry.toolProgress = progress;
      this.scheduleProgressEdit(entry);
    }
  }

  /** At most one progress-driven edit per bubble per TOOL_PROGRESS_EDIT_MIN_MS. */
  private scheduleProgressEdit(entry: CancelButtonEntry): void {
    if (entry.retiring) return;
    const since = Date.now() - (entry.lastProgressEditAt ?? 0);
    if (since >= TOOL_PROGRESS_EDIT_MIN_MS) {
      this.refreshBubble(entry);
      return;
    }
    if (entry.progressEditTimer) return; // trailing edit already scheduled
    entry.progressEditTimer = setTimeout(() => {
      entry.progressEditTimer = undefined;
      this.refreshBubble(entry);
    }, TOOL_PROGRESS_EDIT_MIN_MS - since);
    entry.progressEditTimer.unref?.();
  }

  /**
   * The ONE composer for the bubble text. Both writers — the elapsed-time
   * ticker and the tool-progress push — go through here; two independent
   * renderers editing the same message is how the progress list used to get
   * wiped by the next elapsed tick (#528 trap 2).
   */
  private composeBubbleText(entry: CancelButtonEntry): string {
    return FleetManager.bubbleText(
      Date.now() - (entry.startedAt ?? Date.now()),
      this.instanceActivity.get(entry.instanceName),
      this.progressMinElapsedMs(),
      entry.toolProgress,
    );
  }

  /** Pure composition of header + tool list, exposed for tests. */
  static bubbleText(
    elapsedMs: number,
    activity: string | undefined,
    minElapsedMs: number,
    progress: string | undefined,
  ): string {
    const header = FleetManager.progressText(
      elapsedMs,
      // The single-line activity detail is redundant once a tool list exists.
      progress ? undefined : activity,
      minElapsedMs,
    );
    return progress ? `${header}\n${progress}` : header;
  }

  /** Recompose and edit the bubble in place; skips when nothing changed. */
  private refreshBubble(entry: CancelButtonEntry): void {
    if (entry.retiring || !this.cancelButtons.has(entry.messageId)) {
      clearInterval(entry.progressTimer);
      return;
    }
    const text = this.composeBubbleText(entry);
    if (text === entry.lastProgressText) return; // nothing changed — skip the API call
    const adapter = this.getAdapterForInstance(entry.instanceName) ?? this.adapter;
    if (!adapter?.editAlert) return;

    entry.lastProgressText = text;
    entry.lastProgressEditAt = Date.now();
    adapter.editAlert(entry.chatId, entry.messageId, {
      type: "cancel",
      instanceName: entry.instanceName,
      message: text,
      choices: [{ id: `cancel:${entry.instanceName}`, label: t("cancel.button") }],
    }, entry.threadId ? { threadId: entry.threadId } : undefined)
      .catch(err => {
        // A failed progress edit must never escalate: the button still works and
        // the next tick retries. Common causes are a deleted message or a
        // rate limit.
        this.logger.debug({ err, instanceName: entry.instanceName }, "Progress edit failed");
      });
  }

  /**
   * Refresh the button's text in place while the instance keeps working.
   *
   * Uses `editAlert`, NOT `editMessage`: on Telegram the latter omits reply_markup,
   * and the Bot API treats that as "clear the keyboard" — so editing with it would
   * delete the very cancel button this is trying to keep alive.
   */
  /** Configured threshold before elapsed time appears, in ms. */
  progressMinElapsedMs(): number {
    const seconds = (this.fleetConfig?.defaults as { progress_min_elapsed?: number } | undefined)
      ?.progress_min_elapsed;
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
    return PROGRESS_MIN_ELAPSED_MS;
  }

  private startProgressTicker(entry: CancelButtonEntry): void {
    const tick = () => this.refreshBubble(entry);
    entry.progressTimer = setInterval(tick, PROGRESS_UPDATE_INTERVAL_MS);
    entry.progressTimer.unref?.();
    // One extra tick right when the threshold passes, so a 30s threshold shows
    // time at ~30s instead of waiting for the first 60s interval. Costs at most
    // one additional edit per turn that lives past the threshold.
    const firstAt = this.progressMinElapsedMs() - (Date.now() - (entry.startedAt ?? Date.now()));
    if (firstAt > 0 && firstAt < PROGRESS_UPDATE_INTERVAL_MS) {
      const firstTick = setTimeout(tick, firstAt);
      firstTick.unref?.();
    }
  }

  /**
   * After a reply: give the instance REPLY_RETIRE_GRACE_MS to resume working; if
   * it has not, retire its button. The daemon is asked for a fresh pane capture
   * before deciding. Reading only the transition cache stranded the first
   * post-restart bubble when its startup "working" report never got a matching
   * idle edge. Re-arming replaces the previous timer, so a burst of replies ends
   * with exactly one pending check.
   */
  private armReplyGrace(instanceName: string): void {
    for (const entry of this.cancelButtons.values()) {
      if (entry.instanceName !== instanceName) continue;
      if (entry.replyGraceTimer) clearTimeout(entry.replyGraceTimer);
      entry.replyGraceTimer = setTimeout(() => {
        entry.replyGraceTimer = undefined;
        if (!this.cancelButtons.has(entry.messageId)) return;
        void this.finishReplyGrace(instanceName, entry);
      }, REPLY_RETIRE_GRACE_MS);
      entry.replyGraceTimer.unref?.();
    }
  }

  private async finishReplyGrace(instanceName: string, entry: CancelButtonEntry): Promise<void> {
    const refreshed = await this.refreshInstanceExecutionState(
      instanceName,
      REPLY_STATE_REFRESH_TIMEOUT_MS,
    );
    if (!this.cancelButtons.has(entry.messageId) || entry.retiring) return;
    if (!refreshed) {
      // Fail safe: without an authoritative answer, retain a potentially live
      // Cancel button. The 5-minute/30-minute/24-hour safety nets still apply.
      this.logger.debug(
        { instanceName, messageId: entry.messageId },
        "Cancel reply-grace state refresh timed out",
      );
      return;
    }
    if (!this.getInstanceIdle(instanceName)) return; // genuine long run keeps its button
    this.logger.info(
      { instanceName, messageId: entry.messageId },
      "Cancel button retired — no work resumed after reply",
    );
    this.retireButton(entry);
  }

  /** Retire (delete) every cancel button belonging to an instance. */
  private retireInstanceButtons(instanceName: string): void {
    // Snapshot first — retireButton may delete entries from the map on success.
    for (const e of [...this.cancelButtons.values()]) {
      if (e.instanceName === instanceName) this.retireButton(e);
    }
  }

  /** Begin retiring one button (delete + bounded retry on failure). Idempotent:
   * a button already in a retire cycle is left to its own timer, so a second
   * retire request (e.g. a new send + the post-await sweep) won't double-delete. */
  private retireButton(entry: CancelButtonEntry): void {
    if (entry.retiring) return;
    entry.retiring = true;
    this.attemptButtonDelete(entry);
  }

  private attemptButtonDelete(entry: CancelButtonEntry): void {
    this.deleteButtonMessage(entry)
      .then(() => {
        this.discardButton(entry);
        this.logger.info(
          { instanceName: entry.instanceName, messageId: entry.messageId, historyPreserved: Boolean(entry.toolProgress) },
          "Cancel button retired",
        );
      })
      .catch((err: Error) => this.scheduleButtonRetry(entry, err));
  }

  /** Clear an entry's timers (retry + idle-check) and drop it from the map. */
  private discardButton(entry: CancelButtonEntry): void {
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    if (entry.idleCheckTimer) clearInterval(entry.idleCheckTimer);
    if (entry.progressTimer) clearInterval(entry.progressTimer);
    if (entry.progressEditTimer) clearTimeout(entry.progressEditTimer);
    if (entry.replyGraceTimer) clearTimeout(entry.replyGraceTimer);
    this.cancelButtons.delete(entry.messageId);
    this.persistCancelButtons();
  }

  /**
   * Mirror the live buttons to disk. The map is memory-only, so before this a
   * fleet restart orphaned every button on screen: frozen "處理中…" text and a
   * click that did nothing, forever. The ledger is tiny (a handful of rows) and
   * written on every add/remove — no debounce needed at that rate.
   */
  private persistCancelButtons(): void {
    try {
      const rows = [...this.cancelButtons.values()].map(e => ({
        instanceName: e.instanceName,
        adapterId: e.adapterId,
        chatId: e.chatId,
        messageId: e.messageId,
        threadId: e.threadId,
      }));
      writeFileSync(join(this.dataDir, CANCEL_BTN_LEDGER_FILE), JSON.stringify(rows));
    } catch (err) {
      this.logger.debug({ err }, "Cancel button ledger write failed");
    }
  }

  /**
   * Delete the previous process's buttons. Runs once adapters are up: nothing
   * from a previous fleet process can still be mid-turn from this process's
   * point of view, so every ledger row is an orphan by definition.
   */
  private async sweepOrphanedCancelButtons(): Promise<void> {
    const ledgerPath = join(this.dataDir, CANCEL_BTN_LEDGER_FILE);
    let rows: Array<{ instanceName: string; adapterId?: string; chatId: string; messageId: string; threadId?: string }>;
    try {
      if (!existsSync(ledgerPath)) return;
      rows = JSON.parse(readFileSync(ledgerPath, "utf-8"));
    } catch {
      try { unlinkSync(ledgerPath); } catch { /* corrupt ledger — drop it */ }
      return;
    }
    for (const row of rows) {
      const adapter = (row.adapterId ? this.worlds.get(row.adapterId)?.adapter : undefined)
        ?? this.getAdapterForInstance?.(row.instanceName) ?? this.adapter;
      if (!adapter?.deleteMessage) continue;
      try {
        await adapter.deleteMessage(row.chatId, row.messageId, row.threadId);
        this.logger.info({ instanceName: row.instanceName, messageId: row.messageId }, "Swept orphaned cancel button from previous run");
      } catch (err) {
        // Best effort: the message may already be gone, or too old to delete.
        this.logger.debug({ err, messageId: row.messageId }, "Orphaned cancel button sweep failed");
      }
    }
    // The current process owns the ledger from here on.
    this.persistCancelButtons();
  }

  /** Re-attempt a failed button delete up to CANCEL_BTN_MAX_RETRIES times. */
  private scheduleButtonRetry(entry: CancelButtonEntry, err: Error): void {
    if (entry.retryCount >= CANCEL_BTN_MAX_RETRIES) {
      this.discardButton(entry);
      this.logger.warn(
        { instanceName: entry.instanceName, messageId: entry.messageId, err: err.message },
        `Cancel button delete gave up after ${CANCEL_BTN_MAX_RETRIES} retries`,
      );
      return;
    }
    entry.retryCount++;
    this.logger.warn(
      { instanceName: entry.instanceName, messageId: entry.messageId, attempt: entry.retryCount, err: err.message },
      "Cancel button delete failed, will retry",
    );
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    // Continue the same retire cycle (bypass the retiring-guard in retireButton).
    entry.retryTimer = setTimeout(() => this.attemptButtonDelete(entry), CANCEL_BTN_RETRY_INTERVAL_MS);
  }

  /** Retire one cancel bubble via its own adapter. A bubble that accumulated
   * tool progress is kept as a read-only history message; a plain bubble keeps
   * the legacy delete/edit-to-checkmark behavior. Resolves on success and
   * rejects on failure so the caller can retry. */
  private deleteButtonMessage(e: CancelButtonEntry): Promise<void> {
    const adapter = (e.adapterId ? this.worlds.get(e.adapterId)?.adapter : undefined) ?? this.adapter;
    if (!adapter) return Promise.reject(new Error("no adapter for cancel button"));
    if (e.toolProgress && adapter.editMessageRemoveButtons) {
      return adapter.editMessageRemoveButtons(
        e.chatId,
        e.messageId,
        this.composeRetiredBubbleText(e),
        e.threadId,
      );
    }
    // All production adapters currently implement editMessageRemoveButtons.
    // A third-party adapter without it degrades to the legacy delete behavior:
    // removing a live Cancel control is safer than retaining an actionable,
    // untracked button forever.
    if (adapter.deleteMessage) return adapter.deleteMessage(e.chatId, e.messageId, e.threadId);
    if (adapter.editMessageRemoveButtons) return adapter.editMessageRemoveButtons(e.chatId, e.messageId, "✅", e.threadId);
    return adapter.editMessage(e.chatId, e.messageId, "✅", e.threadId);
  }

  /** Retire all cancel buttons for an instance — on reply or cancel. */
  clearCancelButton(instanceName: string): void {
    this.retireInstanceButtons(instanceName);
  }

  /** Retire the cross-instance button matching a delegate→report correlation id.
   * Used by report_result, where the sender's self-derived name may not match
   * the target-address name the button was registered under. */
  clearCancelButtonByCorrelation(correlationId: string): void {
    if (!correlationId) return;
    for (const e of [...this.cancelButtons.values()]) {
      if (e.correlationId === correlationId) this.retireButton(e);
    }
  }

  /**
   * Reaction target chat id. Telegram reactions key on the supergroup chat_id
   * (the topic thread is NOT a chat_id), so a forum-topic message must react on
   * msg.chatId — reacting on threadId silently fails. Discord reactions key on
   * the channel/thread id.
   */
  private reactTarget(msg: { source?: string; chatId: string; threadId?: string }): string {
    return msg.source === "telegram" ? msg.chatId : (msg.threadId ?? msg.chatId);
  }

  /** Remember the user message just delivered, so we can react ✅ when done. */
  private trackInboundMsg(instanceName: string, msg: { chatId: string; messageId: string; threadId?: string; adapterId?: string; source?: string }): void {
    if (!msg.chatId || !msg.messageId) return;
    this.lastInboundMsg.set(instanceName, {
      adapterId: msg.adapterId, chatId: msg.chatId, threadId: msg.threadId ?? undefined, messageId: msg.messageId, source: msg.source,
    });
  }

  /** Clear the tracked last-inbound message after the agent replies. The ✅
   * reaction is already applied by delivery confirmation (message_confirmed), so
   * reacting again here would be a duplicate API call — we only drop the entry. */
  private reactDone(instanceName: string): void {
    if (!this.lastInboundMsg.has(instanceName)) return;
    this.lastInboundMsg.delete(instanceName);
  }

  /** Interrupt an instance's current generation (cancel button / /cancel). */
  cancelInstance(instanceName: string): boolean {
    const daemon = this.daemons.get(instanceName);
    if (!daemon) return false;
    const deliveryEpoch = this.cancelPendingDeliveries(instanceName);
    daemon.clearPendingDeliveries?.(deliveryEpoch);
    daemon.sendEscape().catch(e => this.logger.warn({ err: e, instanceName }, "sendEscape failed"));
    this.lastInboundMsg.delete(instanceName);
    this.clearCancelButton(instanceName);
    return true;
  }

  getDeliveryEpoch(instanceName: string): number {
    return this.deliveryEpochs.get(instanceName) ?? 0;
  }

  private isDeliveryEpochCurrent(instanceName: string, deliveryEpoch: number): boolean {
    return deliveryEpoch === this.getDeliveryEpoch(instanceName);
  }

  /** Invalidate work queued before a user cancel and wake idle-gate waiters. */
  private cancelPendingDeliveries(instanceName: string): number {
    const next = this.getDeliveryEpoch(instanceName) + 1;
    this.deliveryEpochs.set(instanceName, next);
    for (const check of this.instanceIdleWaiters.get(instanceName) ?? []) check();
    return next;
  }

  // ── Remote CLI login (`/login`) ──────────────────────────────────────────
  //
  // One session at a time, in a dedicated tmux window — never an instance
  // pane. Credentials are per-backend (codex homes symlink auth.json to the
  // shared ~/.codex; the other CLIs use one real home), so a single sign-in
  // repairs every instance of that backend, and instance delivery, pane-state
  // detection, tool progress, and mcp_proxy_reply never observe login output.
  private activeLogin: {
    session: LoginSession;
    backend: string;
    chat: { adapter: ChannelAdapter; adapterId: string; chatId: string; threadId?: string };
  } | null = null;

  /** Post the backend chooser for a bare `/login`. Caller enforces admin. */
  async promptLoginBackends(chat: {
    adapter: ChannelAdapter; adapterId: string; chatId: string; threadId?: string;
  }): Promise<void> {
    const configured = new Set<string>();
    for (const [, config] of Object.entries(this.fleetConfig?.instances ?? {})) {
      configured.add(config.backend ?? this.fleetConfig?.defaults?.backend ?? "claude-code");
    }
    const choices = Object.keys(LOGIN_FLOWS)
      .filter(backend => configured.size === 0 || configured.has(backend))
      .map(backend => ({ action: backend, label: backend }));
    if (choices.length === 0) {
      await chat.adapter.sendText(chat.chatId, t("login.unsupported", [...configured].join(", ")),
        { threadId: chat.threadId });
      return;
    }
    await this.postNonceButtonPrompt({
      prefix: LOGIN_CALLBACK_PREFIX,
      alertType: "login",
      instanceName: "login",
      adapter: chat.adapter,
      adapterId: chat.adapterId,
      chatId: chat.chatId,
      threadId: chat.threadId,
      message: t("login.choose_backend"),
      choices,
      expiredText: t("buttons.stale"),
    });
  }

  /**
   * Start a login session for one backend. Caller enforces admin.
   * Returns a status line to post, or null when a confirmation prompt was
   * posted instead (auth still valid — see the pre-check below).
   */
  async startLoginSession(backendArg: string, chat: {
    adapter: ChannelAdapter; adapterId: string; chatId: string; threadId?: string;
  }, opts: { skipAuthCheck?: boolean } = {}): Promise<string | null> {
    const backend = LOGIN_BACKEND_ALIASES[backendArg.toLowerCase()] ?? backendArg.toLowerCase();
    const flow = LOGIN_FLOWS[backend];
    if (!flow) return t("login.unsupported", backendArg);
    if (this.activeLogin) return t("login.busy", this.activeLogin.backend);
    // Install sessions share the window namespace — never run both at once.
    if (this.activeInstall) return t("install.busy");

    // Token-free pre-check (5s cap): re-login while auth still works is
    // usually a mistake, so it needs a confirmed click. An invalid OR
    // uncertain result (timeout, missing binary) proceeds straight to login —
    // an unreliable probe must never block the re-login the admin asked for.
    if (!opts.skipAuthCheck && flow.authCheck) {
      const status = await checkAuthStatus(flow.authCheck);
      if (status === "valid") {
        await this.postNonceButtonPrompt({
          prefix: LOGIN_CONFIRM_CALLBACK_PREFIX,
          alertType: "login",
          instanceName: backend,
          adapter: chat.adapter,
          adapterId: chat.adapterId,
          chatId: chat.chatId,
          threadId: chat.threadId,
          message: t("login.still_valid", backend),
          choices: [
            { action: "go", label: t("login.relogin_go") },
            { action: "cancel", label: t("login.relogin_cancel") },
          ],
          expiredText: t("buttons.stale"),
        });
        return null;
      }
    }
    return this.launchLoginSession(flow, backend, chat);
  }

  /** Create the login window and session (pre-check already settled). */
  private async launchLoginSession(flow: LoginFlow, backend: string, chat: {
    adapter: ChannelAdapter; adapterId: string; chatId: string; threadId?: string;
  }): Promise<string> {
    if (this.activeLogin) return t("login.busy", this.activeLogin.backend);
    // Install sessions share the window namespace — never run both at once.
    if (this.activeInstall) return t("install.busy");
    const sessionName = getTmuxSession();
    await TmuxManager.ensureSession(sessionName);
    const tmux = new TmuxManager(sessionName, "");
    const session = new LoginSession(flow, tmux, {
      onMenu: async (options) => {
        await this.postNonceButtonPrompt({
          prefix: LOGIN_MENU_CALLBACK_PREFIX,
          alertType: "login",
          instanceName: backend,
          adapter: chat.adapter,
          adapterId: chat.adapterId,
          chatId: chat.chatId,
          threadId: chat.threadId,
          message: t("login.choose_provider"),
          choices: options.map((label, index) => ({ action: String(index), label })),
          expiredText: t("buttons.stale"),
        });
      },
      onAuthHint: async (url, code) => {
        await this.sendLoginSecret(chat, backend, url, code);
      },
      onNeedInput: async (promptExcerpt) => {
        await chat.adapter.sendText(chat.chatId, t("login.need_input", backend, promptExcerpt),
          { threadId: chat.threadId }).catch(() => {});
      },
      onDone: async ({ ok, detail }) => {
        this.activeLogin = null;
        let text: string;
        if (ok) {
          const { woken, restarted } = await this.recoverBackendInstances(backend);
          const none = t("login.none");
          text = t("login.success", backend,
            woken.length ? woken.join(", ") : none,
            restarted.length ? restarted.join(", ") : none);
        } else if (detail === "cancelled") {
          // The cancel command's own reply already announced this — a second
          // message here was a duplicate.
          return;
        } else {
          text = t("login.failed", backend, detail);
        }
        await chat.adapter.sendText(chat.chatId, text, { threadId: chat.threadId }).catch(() => {});
      },
    }, this.logger);

    // Claim the slot before the first await so two admins racing /login cannot
    // both create windows; release on startup failure.
    this.activeLogin = { session, backend, chat };
    try {
      await session.start();
    } catch (err) {
      this.activeLogin = null;
      return t("login.failed", backend, (err as Error).message);
    }
    return t("login.started", backend);
  }

  /** `/login code <text>` — paste admin-supplied text into the login window. */
  async loginSubmitInput(text: string): Promise<string> {
    if (!this.activeLogin) return t("login.no_session");
    const ok = await this.activeLogin.session.submitInput(text);
    return ok ? t("login.input_sent") : t("login.input_failed");
  }

  /** `/login cancel` — abort the active session and remove its window. */
  async cancelLoginSession(): Promise<string> {
    if (!this.activeLogin) return t("login.no_session");
    const backend = this.activeLogin.backend;
    await this.activeLogin.session.cancel();
    return t("login.cancelled", backend);
  }

  /**
   * The URL (+ code) is a live credential: whoever completes it binds THEIR
   * account to this fleet's CLI. Telegram gets an HTML spoiler (same treatment
   * as the dashboard token); other adapters get plain text with the warning.
   */
  private async sendLoginSecret(
    chat: { adapter: ChannelAdapter; chatId: string; threadId?: string },
    backend: string,
    url: string,
    code: string | null,
  ): Promise<void> {
    const codeLine = code ? `\n${t("login.auth_code", code)}` : "";
    try {
      if (chat.adapter.type === "telegram") {
        const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        await chat.adapter.sendText(
          chat.chatId,
          `${esc(t("login.auth_hint", backend))}\n<tg-spoiler>${esc(url)}${esc(codeLine)}</tg-spoiler>`,
          { threadId: chat.threadId, format: "html" },
        );
      } else {
        await chat.adapter.sendText(
          chat.chatId,
          `${t("login.auth_hint", backend)}\n${url}${codeLine}`,
          { threadId: chat.threadId },
        );
      }
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, backend }, "Failed to deliver login URL");
    }
  }

  /**
   * After a successful login: wake the paused instances of that backend AND
   * restart the running ones — a live CLI holds the old token in memory and
   * only re-reads credentials on process start (a paused instance's CLI is
   * already dead, so waking it respawns with the new token for free).
   */
  private async recoverBackendInstances(backend: string): Promise<{ woken: string[]; restarted: string[] }> {
    const woken: string[] = [];
    const restarted: string[] = [];
    for (const [name, config] of Object.entries(this.fleetConfig?.instances ?? {})) {
      const effective = config.backend ?? this.fleetConfig?.defaults?.backend ?? "claude-code";
      if (effective !== backend) continue;
      const status = this.getInstanceStatus(name);
      try {
        if (status === "paused") {
          if (this.daemons.has(name)) await this.lifecycle.wake(name, 30_000);
          else await this.startPersistedPausedInstance(name);
          woken.push(name);
        } else if (status === "running") {
          await this.restartSingleInstance(name);
          restarted.push(name);
        }
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, name, status }, "Post-login recovery failed");
      }
    }
    return { woken, restarted };
  }

  /** Backend chooser button → start that backend's login session. */
  private async handleLoginBackendSelect(
    data: AdapterCallbackData,
    callbackAdapterId: string,
    receivingAdapter?: ChannelAdapter,
  ): Promise<boolean> {
    const claimed = this.consumeNonceCallback(
      LOGIN_CALLBACK_PREFIX,
      /^login:([0-9a-f]+):([a-z][a-z-]*)$/,
      data,
      callbackAdapterId,
      receivingAdapter,
    );
    if (claimed === null) return false;
    if (claimed === "consumed") return true;
    const { entry, action: backend } = claimed;
    await this.retireNonceButtons(entry, entry.messageId ?? data.messageId,
      t("login.starting_backend", backend));
    const text = await this.startLoginSession(backend, {
      adapter: entry.adapter,
      adapterId: entry.adapterId,
      chatId: entry.chatId,
      threadId: entry.threadId,
    });
    if (text) await entry.adapter.sendText(entry.chatId, text, { threadId: entry.threadId }).catch(() => {});
    return true;
  }

  /** Re-login confirmation (auth pre-check said credentials still work). */
  private async handleLoginConfirm(
    data: AdapterCallbackData,
    callbackAdapterId: string,
    receivingAdapter?: ChannelAdapter,
  ): Promise<boolean> {
    const claimed = this.consumeNonceCallback(
      LOGIN_CONFIRM_CALLBACK_PREFIX,
      /^login-confirm:([0-9a-f]+):(go|cancel)$/,
      data,
      callbackAdapterId,
      receivingAdapter,
    );
    if (claimed === null) return false;
    if (claimed === "consumed") return true;
    const { entry, action } = claimed;
    const backend = entry.instanceName;
    if (action === "cancel") {
      await this.retireNonceButtons(entry, entry.messageId ?? data.messageId, t("login.cancelled", backend));
      return true;
    }
    await this.retireNonceButtons(entry, entry.messageId ?? data.messageId, t("login.starting_backend", backend));
    const text = await this.startLoginSession(backend, {
      adapter: entry.adapter,
      adapterId: entry.adapterId,
      chatId: entry.chatId,
      threadId: entry.threadId,
    }, { skipAuthCheck: true });
    if (text) await entry.adapter.sendText(entry.chatId, text, { threadId: entry.threadId }).catch(() => {});
    return true;
  }

  /** Kiro provider button → drive the CLI's arrow-key selector. */
  private async handleLoginMenuSelect(
    data: AdapterCallbackData,
    callbackAdapterId: string,
    receivingAdapter?: ChannelAdapter,
  ): Promise<boolean> {
    const claimed = this.consumeNonceCallback(
      LOGIN_MENU_CALLBACK_PREFIX,
      /^login-menu:([0-9a-f]+):(\d)$/,
      data,
      callbackAdapterId,
      receivingAdapter,
    );
    if (claimed === null) return false;
    if (claimed === "consumed") return true;
    const { entry, action } = claimed;
    const index = Number(action);
    const label = this.activeLogin?.session.flow.menu?.options[index] ?? action;
    const ok = await this.activeLogin?.session.selectMenuOption(index) ?? false;
    await this.retireNonceButtons(entry, entry.messageId ?? data.messageId,
      ok ? t("login.provider_selected", label) : t("login.no_session"));
    return true;
  }

  // ── Remote CLI install (`/install-cli`) ──────────────────────────────────
  //
  // Same dedicated-window model as /login (and the same LoginSession state
  // machine — an install is a login flow with no auth hints): run the
  // installer, judge by exit code, verify the binary on a fresh login shell,
  // then offer to chain straight into /login.
  private activeInstall: {
    session: LoginSession;
    backend: string;
    chat: { adapter: ChannelAdapter; adapterId: string; chatId: string; threadId?: string };
  } | null = null;

  /** Start a CLI install session. Caller enforces admin. */
  async startInstallSession(backendArg: string, chat: {
    adapter: ChannelAdapter; adapterId: string; chatId: string; threadId?: string;
  }): Promise<string> {
    const backend = LOGIN_BACKEND_ALIASES[backendArg.toLowerCase()] ?? backendArg.toLowerCase();
    const info = BACKEND_INSTALLATION_INFO[backend];
    if (!info) return t("install.unsupported", backendArg);
    if (checkBinaryInstalled(info.binary)) return t("install.already", backend, info.binary);
    if (this.activeInstall) return t("install.busy");
    if (this.activeLogin) return t("login.busy", this.activeLogin.backend);

    const sessionName = getTmuxSession();
    await TmuxManager.ensureSession(sessionName);
    const tmux = new TmuxManager(sessionName, "");
    // A synthetic login flow: success is decided by the installer's exit code
    // (LoginSession treats a clean exit as success), never by pane text — and
    // installer output that happens to contain a URL must not be forwarded as
    // an auth hint, hence the no-op events below.
    const flow: LoginFlow = {
      backend,
      command: info.install,
      successPattern: /$^/,
      timeoutMs: 10 * 60 * 1000,
    };
    const session = new LoginSession(flow, tmux, {
      onMenu: () => {},
      onAuthHint: () => {},
      onNeedInput: () => {},
      onDone: async ({ ok, detail }) => {
        this.activeInstall = null;
        if (!ok) {
          // A cancel is user-initiated — the cancel command's own reply already
          // said so; a second message here would be a duplicate.
          if (detail !== "cancelled") {
            await chat.adapter.sendText(chat.chatId, t("install.failed", backend, detail),
              { threadId: chat.threadId }).catch(() => {});
          }
          return;
        }
        // The installer may only have added the binary to a profile PATH; a
        // fresh login shell sees that, the fleet process's PATH may not.
        if (!this.verifyBinaryOnLoginShell(info.binary)) {
          await chat.adapter.sendText(chat.chatId, t("install.verify_failed", backend, info.binary),
            { threadId: chat.threadId }).catch(() => {});
          return;
        }
        if (!LOGIN_FLOWS[backend]) {
          await chat.adapter.sendText(chat.chatId, t("install.success_no_login", backend),
            { threadId: chat.threadId }).catch(() => {});
          return;
        }
        await this.postNonceButtonPrompt({
          prefix: INSTALL_LOGIN_CALLBACK_PREFIX,
          alertType: "login",
          instanceName: backend,
          adapter: chat.adapter,
          adapterId: chat.adapterId,
          chatId: chat.chatId,
          threadId: chat.threadId,
          message: t("install.login_prompt", backend),
          choices: [
            { action: "go", label: t("install.login_now") },
            { action: "later", label: t("install.later") },
          ],
          expiredText: t("install.later_ack", backend),
        });
      },
    }, this.logger);

    this.activeInstall = { session, backend, chat };
    try {
      await session.start();
    } catch (err) {
      this.activeInstall = null;
      return t("install.failed", backend, (err as Error).message);
    }
    return t("install.started", backend);
  }

  /** `/install-cli cancel` — abort the active install and remove its window. */
  async cancelInstallSession(): Promise<string> {
    if (!this.activeInstall) return t("install.no_session");
    const backend = this.activeInstall.backend;
    await this.activeInstall.session.cancel();
    return t("install.cancelled", backend);
  }

  /** `command -v` on a login shell, so PATH additions from rc files count. */
  private verifyBinaryOnLoginShell(binary: string): boolean {
    try {
      const result = spawnSync("bash", ["-lc", `command -v ${binary}`], { timeout: 10_000, stdio: "pipe" });
      return result.status === 0;
    } catch {
      return false;
    }
  }

  /** "Sign in now?" button after a successful install. */
  private async handleInstallLoginConfirm(
    data: AdapterCallbackData,
    callbackAdapterId: string,
    receivingAdapter?: ChannelAdapter,
  ): Promise<boolean> {
    const claimed = this.consumeNonceCallback(
      INSTALL_LOGIN_CALLBACK_PREFIX,
      /^install-login:([0-9a-f]+):(go|later)$/,
      data,
      callbackAdapterId,
      receivingAdapter,
    );
    if (claimed === null) return false;
    if (claimed === "consumed") return true;
    const { entry, action } = claimed;
    const backend = entry.instanceName;
    if (action === "later") {
      await this.retireNonceButtons(entry, entry.messageId ?? data.messageId, t("install.later_ack", backend));
      return true;
    }
    await this.retireNonceButtons(entry, entry.messageId ?? data.messageId, t("login.starting_backend", backend));
    const text = await this.startLoginSession(backend, {
      adapter: entry.adapter,
      adapterId: entry.adapterId,
      chatId: entry.chatId,
      threadId: entry.threadId,
    });
    if (text) await entry.adapter.sendText(entry.chatId, text, { threadId: entry.threadId }).catch(() => {});
    return true;
  }

  /** Discord native `/login` slash — shared by every adapter dispatch block. */
  private async handleLoginSlash(
    data: { userId?: string; channelId: string; options?: Record<string, unknown>; respond: (text: string) => Promise<unknown> },
    adapterId: string,
    adapter: ChannelAdapter,
  ): Promise<void> {
    if (!data.userId || !this.isFleetAdmin(data.userId, adapterId)) {
      await data.respond(t("permission.denied"));
      return;
    }
    const chat = { adapter, adapterId, chatId: data.channelId };
    if (data.options?.cancel === true) { await data.respond(await this.cancelLoginSession()); return; }
    const code = String(data.options?.code ?? "").trim();
    if (code) { await data.respond(await this.loginSubmitInput(code)); return; }
    const backend = String(data.options?.backend ?? "").trim();
    if (backend) {
      const text = await this.startLoginSession(backend, chat);
      await data.respond(text ?? t("login.confirm_posted"));
      return;
    }
    await this.promptLoginBackends(chat);
    await data.respond(t("login.chooser_posted"));
  }

  /** Discord native `/install-cli` slash — shared by every dispatch block. */
  private async handleInstallCliSlash(
    data: { userId?: string; channelId: string; options?: Record<string, unknown>; respond: (text: string) => Promise<unknown> },
    adapterId: string,
    adapter: ChannelAdapter,
  ): Promise<void> {
    if (!data.userId || !this.isFleetAdmin(data.userId, adapterId)) {
      await data.respond(t("permission.denied"));
      return;
    }
    if (data.options?.cancel === true) { await data.respond(await this.cancelInstallSession()); return; }
    const backend = String(data.options?.backend ?? "").trim();
    if (!backend) { await data.respond(t("install.usage")); return; }
    await data.respond(await this.startInstallSession(backend, { adapter, adapterId, chatId: data.channelId }));
  }

  queueMirrorMessage(text: string): void {
    const mirrorTopicId = this.fleetConfig?.channel?.mirror_topic_id;
    if (mirrorTopicId == null || !this.adapter) return;
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
    this.mirrorBuffer.push(`[${ts}] ${text}`);
    if (!this.mirrorTimer) {
      this.mirrorTimer = setTimeout(() => {
        const batch = this.mirrorBuffer.join("\n");
        this.mirrorBuffer = [];
        this.mirrorTimer = null;
        const groupId = this.fleetConfig?.channel?.group_id;
        if (groupId && this.adapter) {
          this.adapter.sendText(String(groupId), batch, {
            threadId: String(mirrorTopicId),
          }).catch(e => this.logger.debug({ err: e }, "Mirror topic send failed"));
        }
      }, 3000);
    }
  }

  /** Push an SSE event to all connected Web UI clients. */
  emitSseEvent(event: string, data: unknown): void {
    broadcastSseEvent(this.sseClients, event, data, (err) =>
      this.logger.debug({ err }, "SSE client write failed; evicting"),
    );
  }

  listClaimedTasks(assignee: string): Array<{ id: string; title: string }> {
    try {
      return this.scheduler?.db.listTasks({ assignee, status: "claimed" }) ?? [];
    } catch { return []; }
  }

  async sendHangNotification(instanceName: string, unchangedForMs?: number): Promise<void> {
    const adapter = this.getAdapterForInstance(instanceName) ?? this.adapter;
    const adapterId = this.getInstanceAdapterId(instanceName);
    // Same three-way addressing as sendCancelButton: fleet topic → group+thread,
    // Classic → its own channel (Classic instances are absent from
    // fleetConfig.instances, so the topic path can never address them), else the
    // world group flat. getGroupIdForInstance (not getChannelConfig().group_id)
    // because on channels[]-configured fleets the legacy channel: block is empty.
    const topicId = this.fleetConfig?.instances[instanceName]?.topic_id;
    const groupId = this.getGroupIdForInstance(instanceName) || undefined;
    let chatId: string | undefined;
    let threadId: string | undefined;
    if (topicId != null && groupId) {
      chatId = String(groupId);
      threadId = String(topicId);
    } else {
      chatId = this.classicChannels?.getChannelIdByInstance(instanceName);
      if (!chatId && groupId) chatId = String(groupId);
    }
    if (!adapter || !adapterId || !chatId) {
      this.logger.warn({ instanceName, adapterId, chatId }, "Cannot address hang notification");
      return;
    }
    const instanceHangConfig = (this.fleetConfig?.instances[instanceName] as (InstanceConfig & {
      hang_detector?: { timeout_minutes?: number };
    }) | undefined)?.hang_detector;
    const configuredMinutes = instanceHangConfig?.timeout_minutes
      ?? this.fleetConfig?.defaults?.hang_detector?.timeout_minutes
      ?? 15;
    const unchangedMinutes = unchangedForMs == null
      ? configuredMinutes
      : Math.max(1, Math.floor(unchangedForMs / 60_000));

    this.setTopicIcon(instanceName, "red");

    await this.postNonceButtonPrompt({
      prefix: HANG_CALLBACK_PREFIX,
      alertType: "hang",
      instanceName,
      adapter,
      adapterId,
      chatId,
      threadId,
      message: t("hang.detected", instanceName, unchangedMinutes),
      choices: [
        { action: "restart", label: t("hang.restart") },
        { action: "wait", label: t("hang.wait") },
      ],
      expiredText: t("hang.expired", instanceName),
    });
  }

  /**
   * Consume a hang Force-restart / Keep-waiting button exactly once. Restart
   * goes through restartSingleInstance — serialized against concurrent restart
   * sources, and with a Classic-instance fallback (the previous hand-rolled
   * stop+start silently left Classic instances stopped while reporting
   * "restarted").
   */
  private async handleHangPrompt(
    data: AdapterCallbackData,
    callbackAdapterId: string,
    receivingAdapter?: ChannelAdapter,
  ): Promise<boolean> {
    const claimed = this.consumeNonceCallback(
      HANG_CALLBACK_PREFIX,
      /^hang:([0-9a-f]+):(restart|wait)$/,
      data,
      callbackAdapterId,
      receivingAdapter,
    );
    if (claimed === null) return false;
    if (claimed === "consumed") return true;
    const { entry: pending, action } = claimed;

    this.eventLog?.insert(pending.instanceName, "hang_action", { action, userId: data.userId });
    if (action === "wait") {
      await this.retireNonceButtons(
        pending,
        pending.messageId ?? data.messageId,
        t("hang.waiting", pending.instanceName),
      );
      return true;
    }

    await this.retireNonceButtons(
      pending,
      pending.messageId ?? data.messageId,
      t("hang.restarting", pending.instanceName),
    );
    try {
      await this.restartSingleInstance(pending.instanceName);
      await pending.adapter.editMessage(
        pending.chatId,
        pending.messageId ?? data.messageId,
        t("hang.restarted", pending.instanceName),
        pending.threadId,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, instanceName: pending.instanceName }, "Hang force-restart failed");
      await pending.adapter.editMessage(
        pending.chatId,
        pending.messageId ?? data.messageId,
        t("hang.restart_failed", pending.instanceName, message),
        pending.threadId,
      ).catch(editErr => this.logger.warn({ err: editErr, instanceName: pending.instanceName },
        "Failed to show hang restart error"));
    }
    return true;
  }

  // ── Topic icon + auto-archive ─────────────────────────────────────────────

  private static INSTRUCTIONS_FILENAME: Record<string, string> = {
    "claude-code": "CLAUDE.md",
    "codex": "AGENTS.md",
    "gemini-cli": "GEMINI.md",
    "opencode": "AGENTS.md",
    "kiro-cli": ".kiro/steering/project.md",
    // Grok reads AGENTS.md project docs; agy reads .agents/agents.md — the
    // same files their writeConfig() appends fleet instructions to.
    "grok": "AGENTS.md",
    "antigravity": ".agents/agents.md",
    "mock": "CLAUDE.md",
  };

  private static GENERAL_INSTRUCTIONS = `# Fleet Coordinator

You are the fleet coordinator — the central entry point for this AgEnD fleet.
You route tasks, manage instances, enforce policies, and synthesize results.
Do NOT modify project files directly — delegate file changes to the project's instance.
You CAN write code snippets, explain code, and answer technical questions directly.

## Task Routing

- **Handle directly**: no file/exec access needed, answerable from knowledge, ≤2 reasoning steps (Q&A, translation, status queries, code snippets).
- **Delegate to 1 instance**: scoped to one project/repo, needs file access or execution.
- **Coordinate multiple**: spans repos, outputs feed each other, or parallel helps (max 3 per task).

Instance discovery order: list_teams() → list_instances() → describe_instance() → create_instance() only if nothing fits. Prefer reuse; never duplicate a running instance.

## Reply Contract

Every final response to the user contains: the result (the actual answer or deliverable) and gaps (anything incomplete — omit if none). Summarize instance reports; omit internal coordination noise.

## After Restart

BEFORE processing any new messages: 1. list_instances() 2. list_teams() 3. list_decisions(). Only then handle requests.

## Playbooks (on-demand skills)

Detailed procedures live in your skills — consult them when the situation comes up rather than from memory:
- **delegation-playbook** — delegation protocol, loop prevention, parallel vs sequential, result/failure handling, team management, instance configuration tips.
- **development-workflow** — the fleet-wide code-change policy you enforce when delegating code tasks.
Plus the operational skills (fleet-health, instance-lifecycle, scheduling, session-management, …).
`;

  /** Ensure the general instance has its project instructions file + knowledge */
  private ensureGeneralInstructions(workDir: string, backendName?: string, instanceName?: string): void {
    const backend = backendName ?? "claude-code";
    workDir = this.resolveKnowledgeWorkDir(workDir, backend, instanceName);
    const filename = FleetManager.INSTRUCTIONS_FILENAME[backend] ?? "CLAUDE.md";
    const filePath = join(workDir, filename);
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) {
      writeFileSync(filePath, FleetManager.GENERAL_INSTRUCTIONS, "utf-8");
      this.logger.info({ filePath }, "Created general instance instructions file");
    }
    // Sync bundled knowledge files to general's steering and skills directories.
    this.syncGeneralKnowledge(workDir, backend);
  }

  /** Resolve the workspace path a backend actually uses before publishing knowledge. */
  private resolveKnowledgeWorkDir(workDir: string, backend: string, instanceName?: string): string {
    // Backend resolution may create/normalize the real cwd. Instructions and
    // skills must land where the CLI actually runs, not an assumed path.
    try {
      const resolved = createBackend(backend, join(getAgendHome(), "cli-env"))
        .resolveWorkingDirectory?.(workDir, instanceName);
      if (resolved) workDir = resolved;
    } catch { /* unknown backend name — keep the raw path */ }
    return workDir;
  }

  /**
   * Where each backend natively loads on-demand skills from, relative to the
   * workspace. Backends without a native skill mechanism (opencode, grok,
   * antigravity, gemini-cli) are deliberately absent: dropping files a CLI
   * never reads is clutter, not capability. Unknown directories are ignored
   * by older CLI versions, so publishing is fail-open across upgrades.
   */
  private static SKILLS_DIR_SEGMENTS: Record<string, string[]> = {
    "kiro-cli": [".kiro", "skills"],
    "claude-code": [".claude", "skills"],
    "codex": [".agents", "skills"],
    // Live-verified: OpenCode and Antigravity scan .agents/skills; Grok's
    // vendor-canonical location is .grok/skills.
    "opencode": [".agents", "skills"],
    "grok": [".grok", "skills"],
    "antigravity": [".agents", "skills"],
  };

  /** Copy general-knowledge steering + all role-eligible skills to General. */
  private syncGeneralKnowledge(workDir: string, backend: string): void {
    const knowledgeDir = join(dirname(fileURLToPath(import.meta.url)), "general-knowledge");
    if (!existsSync(knowledgeDir)) return;

    this.syncGeneralSteering(workDir, backend, join(knowledgeDir, "steering"));

    this.syncRoleSkills(workDir, backend, "general", knowledgeDir);

    this.logger.debug({ knowledgeDir, workDir, backend }, "Synced general knowledge files");
  }

  /** Publish only the bundled skills eligible for an instance role. */
  private syncRoleSkills(workDir: string, backend: string, role: ManagedSkillRole, knowledgeDir?: string): void {
    const skillSegments = FleetManager.SKILLS_DIR_SEGMENTS[backend];
    if (!skillSegments) return;
    const root = knowledgeDir ?? join(dirname(fileURLToPath(import.meta.url)), "general-knowledge");
    if (!existsSync(root)) return;
    // Before managed-skill manifests existed, only Kiro General received
    // bundled skills. Allow that one legacy layout to be adopted so upgrades
    // can keep those copies current; other backends never had unmanaged
    // AgEnD-published skills and must retain the normal user-ownership guard.
    const adoptLegacyUnmanaged = backend === "kiro-cli" && role === "general";
    this.syncManagedSkills(
      join(workDir, ...skillSegments),
      join(root, "skills"),
      role,
      adoptLegacyUnmanaged,
    );
    this.logger.debug({ workDir, backend, role }, "Synced role-based bundled skills");
  }

  /**
   * Steering (always-on rules like core-rules.md). Kiro loads a native
   * steering directory; every other backend gets the content embedded into
   * its instructions file (CLAUDE.md / AGENTS.md / …) inside a managed marker
   * block — the previous behavior dropped bare .md files in the workspace
   * root, which no CLI ever read. The block is replaced in place on every
   * sync, so rule updates reach EXISTING workspaces; everything the user
   * wrote outside the markers is preserved byte-for-byte.
   */
  private syncGeneralSteering(workDir: string, backend: string, srcSteering: string): void {
    if (!existsSync(srcSteering)) return;
    const files = readdirSync(srcSteering).filter(f => f.endsWith(".md")).sort();
    if (files.length === 0) return;

    if (backend === "kiro-cli") {
      const steeringDir = join(workDir, ".kiro", "steering");
      mkdirSync(steeringDir, { recursive: true });
      for (const file of files) {
        const dest = join(steeringDir, file);
        const newContent = readFileSync(join(srcSteering, file), "utf-8");
        try { if (existsSync(dest) && readFileSync(dest, "utf-8") === newContent) continue; } catch { /* rewrite */ }
        writeFileSync(dest, newContent);
      }
      return;
    }

    const filename = FleetManager.INSTRUCTIONS_FILENAME[backend] ?? "CLAUDE.md";
    const instructionsPath = join(workDir, filename);
    const body = files.map(f => readFileSync(join(srcSteering, f), "utf-8").trim()).join("\n\n");
    const block = `${FleetManager.STEERING_BLOCK_BEGIN}\n${body}\n${FleetManager.STEERING_BLOCK_END}`;

    let existing = "";
    try { existing = existsSync(instructionsPath) ? readFileSync(instructionsPath, "utf-8") : ""; } catch { /* treat as empty */ }
    const beginAt = existing.indexOf(FleetManager.STEERING_BLOCK_BEGIN);
    const endAt = existing.indexOf(FleetManager.STEERING_BLOCK_END);
    let next: string;
    if (beginAt !== -1 && endAt !== -1 && endAt > beginAt) {
      next = existing.slice(0, beginAt) + block + existing.slice(endAt + FleetManager.STEERING_BLOCK_END.length);
    } else {
      next = existing.trimEnd() + (existing.trim() ? "\n\n" : "") + block + "\n";
    }
    if (next !== existing) {
      mkdirSync(dirname(instructionsPath), { recursive: true });
      writeFileSync(instructionsPath, next);
    }
  }

  private static STEERING_BLOCK_BEGIN = "<!-- >>> agend:core-rules — managed by AgEnD; edits inside this block are overwritten -->";
  private static STEERING_BLOCK_END = "<!-- <<< agend:core-rules -->";

  /**
   * Publish AgEnD's bundled skills into a CLI's native skills directory,
   * owning ONLY what we published. A manifest records which skill names AgEnD
   * wrote; a bundled rename/removal deletes the stale managed copy, while a
   * skill the user created by hand is never listed and therefore never
   * touched — even if a future bundle happens to reuse its name (the sync
   * then skips it and logs, rather than overwrite the user's work). The sole
   * migration exception is the pre-manifest Kiro General layout explicitly
   * selected by adoptLegacyUnmanaged.
   */
  private syncManagedSkills(
    destSkills: string,
    srcSkills: string,
    role: ManagedSkillRole,
    adoptLegacyUnmanaged = false,
  ): void {
    if (!existsSync(srcSkills)) return;
    mkdirSync(destSkills, { recursive: true });
    const manifestPath = join(destSkills, ".agend-managed-skills.json");
    const hadManifest = existsSync(manifestPath);
    let previouslyManaged: string[] = [];
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
      if (Array.isArray(parsed)) previouslyManaged = parsed.filter(n => typeof n === "string");
    } catch { /* first sync, or corrupt manifest — treat as owning nothing */ }

    const bundled = readdirSync(srcSkills)
      .filter(name => existsSync(join(srcSkills, name, "SKILL.md")))
      .sort();

    // Pre-manifest Kiro General copied bundled skills directly into
    // .kiro/skills. If every existing skill is still a bundled name, this is
    // the unambiguous legacy layout: adopt it once, update it below, and write
    // the ownership manifest. Any extra skill name keeps the directory fully
    // on the user-owned/collision path.
    if (!hadManifest && adoptLegacyUnmanaged) {
      const existing = readdirSync(destSkills, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && existsSync(join(destSkills, entry.name, "SKILL.md")))
        .map(entry => entry.name)
        .sort();
      if (existing.length > 0 && existing.every(name => bundled.includes(name))) {
        previouslyManaged = existing;
        this.logger.info(
          { skills: existing, destSkills },
          "Adopted legacy AgEnD skills into managed ownership",
        );
      }
    }

    const eligible = bundled.filter(name => {
      const roles = this.readManagedSkillRoles(join(srcSkills, name, "SKILL.md"));
      // General is the coordinator and receives both coordinator and worker
      // playbooks. Workers receive only skills explicitly marked for workers.
      return role === "general" || roles.includes("worker");
    });
    const managed: string[] = [];

    for (const name of eligible) {
      const destDir = join(destSkills, name);
      const dest = join(destDir, "SKILL.md");
      const isOurs = previouslyManaged.includes(name) || !existsSync(destDir);
      if (!isOurs) {
        // Name collision with a user-authored skill: theirs wins, loudly.
        this.logger.warn({ skill: name, destSkills },
          "Skipping bundled skill — a skill of this name exists but was not published by AgEnD");
        continue;
      }
      managed.push(name);
      const newContent = readFileSync(join(srcSkills, name, "SKILL.md"), "utf-8");
      try { if (existsSync(dest) && readFileSync(dest, "utf-8") === newContent) continue; } catch { /* rewrite */ }
      mkdirSync(destDir, { recursive: true });
      writeFileSync(dest, newContent);
    }

    // Remove managed skills that are no longer bundled OR no longer eligible
    // for this role. This makes a shared → general-only metadata change take
    // effect on the next worker startup instead of leaving stale capability.
    for (const stale of previouslyManaged) {
      if (eligible.includes(stale)) continue;
      try {
        rmSync(join(destSkills, stale), { recursive: true, force: true });
        this.logger.info({ skill: stale, destSkills }, "Removed retired AgEnD-managed skill");
      } catch (err) {
        this.logger.debug({ err, skill: stale }, "Failed to remove retired managed skill");
      }
    }

    try {
      writeFileSync(manifestPath, JSON.stringify(managed, null, 2) + "\n");
    } catch (err) {
      this.logger.debug({ err, manifestPath }, "Failed to write managed-skills manifest");
    }
  }

  /** Read AgEnD's roles extension from SKILL.md YAML frontmatter. */
  private readManagedSkillRoles(skillPath: string): ManagedSkillRole[] {
    const fallback: ManagedSkillRole[] = ["general"];
    try {
      const content = readFileSync(skillPath, "utf-8");
      const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (!match) return fallback;
      const document = parseDocument(match[1]);
      if (document.errors.length > 0) throw document.errors[0];
      const frontmatter = document.toJS() as { roles?: unknown } | null;
      if (!frontmatter || frontmatter.roles === undefined) return fallback;
      if (!Array.isArray(frontmatter.roles)) throw new Error("roles must be an array");
      const roles = [...new Set(frontmatter.roles)]
        .filter((value): value is ManagedSkillRole => value === "general" || value === "worker");
      if (roles.length !== frontmatter.roles.length || roles.length === 0) {
        throw new Error("roles must contain only general and/or worker");
      }
      return roles;
    } catch (err) {
      // Fail closed for workers: malformed or unknown metadata keeps the
      // backwards-compatible General-only behavior instead of leaking an
      // administrative skill into worker workspaces.
      this.logger.warn({ err, skillPath }, "Invalid bundled skill roles — defaulting to General only");
      return fallback;
    }
  }

  /** Fetch forum topic icon stickers and pick emoji IDs for each state */
  private async resolveTopicIcons(): Promise<void> {
    if (!this.adapter?.getTopicIconStickers) return;
    try {
      const stickers = await this.adapter.getTopicIconStickers();
      if (stickers.length === 0) return;

      // getForumTopicIconStickers returns a fixed set of available icons.
      // Try to match by emoji character, fall back to positional.
      const find = (targets: string[]) =>
        stickers.find((s) => targets.some((t) => s.emoji.includes(t)));

      const green = find(["🟢", "✅", "💚"]);
      const blue = find(["🔵", "💙", "📘"]);
      const red = find(["🔴", "❌", "💔"]);

      this.topicIcons = {
        green: green?.customEmojiId ?? stickers[0]?.customEmojiId,
        blue: blue?.customEmojiId ?? stickers[1]?.customEmojiId ?? stickers[0]?.customEmojiId,
        red: red?.customEmojiId ?? stickers[Math.min(5, stickers.length - 1)]?.customEmojiId,
      };
      this.logger.info({ icons: this.topicIcons }, "Resolved topic icon emoji IDs");
    } catch (err) {
      this.logger.debug({ err }, "Failed to resolve topic icons (non-fatal)");
    }
  }

  /** Set topic icon based on instance state */
  setTopicIcon(instanceName: string, state: "green" | "blue" | "red" | "remove"): void {
    const topicId = this.fleetConfig?.instances[instanceName]?.topic_id;
    const adapter = this.getAdapterForInstance(instanceName) ?? this.adapter;
    if (topicId == null || !adapter?.editForumTopic) return;

    const emojiId = state === "remove" ? "" : this.topicIcons[state];
    if (emojiId == null && state !== "remove") return;

    adapter.editForumTopic(topicId, { iconCustomEmojiId: emojiId })
      .catch((e) => this.logger.debug({ err: e, instanceName, state }, "Topic icon update failed"));
  }

  /** Track activity timestamp for idle detection */
  touchActivity(instanceName: string): void {
    this.lastActivity.set(instanceName, Date.now());
  }

  /** Start periodic idle archive checker */
  // archiveIdleTopics / reopenArchivedTopic → delegated to TopicArchiver

  private clearStatuslineWatchers(): void {
    this.statuslineWatcher.stopAll();
    this.failoverActive.clear();
  }

  // ── Classic Channel Methods ──────────────────────────────────────────

  /** Handle a message in a classic channel: log it, forward only /chat messages */
  private async handleClassicChannelMessage(instanceName: string, msg: InboundMessage): Promise<void> {
    const text = msg.text ?? "";
    const channelId = msg.threadId ?? msg.chatId;
    const isCollabMode = this.classicChannels?.isCollab(channelId, msg.adapterId) ?? false;

    // Handle /ctx in classic mode — always, regardless of collab mode
    if (text === "/ctx" || text.startsWith("/ctx@")) {
      const reply = await this.topicCommands.getCtxText(instanceName);
      const classicAdapter = this.worlds.get(msg.adapterId ?? "")?.adapter ?? this.adapter;
      if (classicAdapter) await classicAdapter.sendText(msg.threadId ?? msg.chatId, reply, { threadId: msg.threadId });
      return;
    }

    // Collab mode: trigger on @mention of our bot, log all messages
    if (isCollabMode) {
      // Skip empty bot messages (e.g., reactions) — don't pollute chat log
      if (msg.isBotMessage && !text && !msg.attachments?.length) return;

      // Save attachments FIRST so the chat-log records their inbox paths
      // (consistent with the /chat path). Otherwise a non-@mention image is
      // saved to inbox but its path never reaches the agent — the log keeps
      // only a pathless filename, so later context can't locate the file.
      const saved = msg.attachments?.length ? await this.saveClassicAttachment(instanceName, msg) : undefined;

      // Log every message (including other bots) to chat-logs
      const collabAttachTag = saved
        ? ` [${saved.kind === "photo" ? "📷" : "📎"} saved: ${saved.paths.join(", ")}]`
        : (msg.attachments?.length
            ? ` [${msg.attachments.map(a => `${a.kind === "photo" ? "📷" : "📎"} ${a.filename || a.kind}`).join(", ")}]`
            : "");
      ClassicChannelManager.logMessage(instanceName, msg.username, text + collabAttachTag, msg.timestamp, msg.replyToText);
      this.logger.info({ instanceName, user: msg.username, textLen: text.length, attachments: msg.attachments?.length ?? 0, source: msg.source }, "Collab mode message");

      // Check for @mention trigger: must be exact <@BOT_USER_ID>, not @everyone/@here.
      // Each bot matches ONLY its own id. A secondary bot must NOT fall back to the
      // process-wide botUserId (the primary's) — otherwise, in a same-channel
      // multi-bot setup, an @mention of the primary would also match the secondary
      // and BOTH bots would react 👀 and forward. Only the primary adapter may use
      // the fallback.
      const mentionWorld = this.worlds.get(msg.adapterId ?? "");
      const isPrimaryAdapter = !mentionWorld || mentionWorld.adapter === this.adapter;
      const adapterBotUserId = mentionWorld?.botUserId ?? (isPrimaryAdapter ? this.botUserId : undefined);
      const mentionTag = adapterBotUserId ? `<@${adapterBotUserId}>` : null;
      const isMentioned = mentionTag && text.includes(mentionTag);
      if (!isMentioned) {
        // Bare attachment (no @mention) — already saved above; just acknowledge.
        if (saved) {
          const reactAdapter = this.worlds.get(msg.adapterId ?? "")?.adapter ?? this.adapter;
          const noMentionReactChatId = msg.threadId ?? msg.chatId;
          if (reactAdapter && noMentionReactChatId && msg.messageId) {
            const emoji = msg.source === "telegram"
              ? (saved.kind === "photo" ? "👌" : "👍")
              : (saved.kind === "photo" ? "📸" : "📎");
            reactAdapter.react(noMentionReactChatId, msg.messageId, emoji)
              .catch(e => this.logger.debug({ err: (e as Error).message }, "Auto-react failed"));
          }
        }
        return;
      }

      // Rewrite the bot's own @mention into a readable self-marker instead of
      // stripping it (#498): when several people are tagged in one message the
      // agent must see that it is among them. Loop safety does not depend on
      // this strip — the adapter drops the bot's own messages on inbound, so a
      // reply containing the marker (or even a raw self-mention) never
      // re-enters this path.
      const selfMentionRe = new RegExp(`<@${adapterBotUserId}>`, "g");
      const strippedText = text.replace(selfMentionRe, "").trim();
      if (!strippedText && !msg.attachments?.length) return;
      const selfMarker = mentionWorld?.botUsername ? `@${mentionWorld.botUsername} (you)` : `${mentionTag} (you)`;
      const cleanText = text.replace(selfMentionRe, selfMarker).trim();

      const classicAdapter = this.worlds.get(msg.adapterId ?? "")?.adapter ?? this.adapter;
      const collabReactChatId = msg.threadId ?? msg.chatId;
      if (classicAdapter && collabReactChatId && msg.messageId) {
        classicAdapter.react(collabReactChatId, msg.messageId, "👀")
          .catch(e => this.logger.debug({ err: (e as Error).message }, "Auto-react failed"));
      }

      // Block /raw bypass — check the mention-stripped text so the self-marker
      // prefix can't be used to sneak "/raw" past this gate.
      if (strippedText.startsWith("/raw ")) return;

      // Attachments already saved at the top of the collab block.
      if (saved && classicAdapter && collabReactChatId && msg.messageId) {
        const emoji = msg.source === "telegram"
          ? (saved.kind === "photo" ? "👌" : "👍")
          : (saved.kind === "photo" ? "📸" : "📎");
        classicAdapter.react(collabReactChatId, msg.messageId, emoji)
          .catch(e => this.logger.debug({ err: (e as Error).message }, "Auto-react failed"));
      }
      // Strip saved attachment to avoid double download
      const savedKind = saved?.kind;
      const patchedAttachments = savedKind ? msg.attachments?.filter(a => a.kind !== savedKind) : msg.attachments;
      const patchedMsg = { ...msg, text: cleanText, attachments: patchedAttachments?.length ? patchedAttachments : undefined };
      const { text: processedText, extraMeta } = await processAttachments(patchedMsg, classicAdapter!, this.logger, instanceName);
      let finalText = processedText || cleanText;
      if (saved) {
        if (saved.kind === "photo") {
          extraMeta.image_path = saved.paths[0];
          if (saved.paths.length > 1) extraMeta.image_paths = saved.paths.join(",");
          const tags = saved.paths.map(p => `[📷 Image: ${p}]`).join("\n");
          finalText = `${tags}\n${finalText}`;
        } else {
          extraMeta.attachment_path = saved.paths[0];
          if (saved.paths.length > 1) extraMeta.attachment_paths = saved.paths.join(",");
          const docAtts = msg.attachments?.filter(a => a.kind === "document") ?? [];
          const tags = saved.paths.map((p, i) => {
            const filename = docAtts[i]?.filename ?? "file";
            return `[📎 File: ${filename} → ${p}]`;
          }).join("\n");
          finalText = `${tags}\n${finalText}`;
        }
      }

      await this.forwardToClassicInstance(instanceName, finalText, msg, extraMeta);
      return;
    }

    // Normal mode: /chat trigger
    const isChat = text.startsWith("/chat ") || text === "/chat";
    this.logger.info({ instanceName, user: msg.username, textLen: text.length, hasChat: isChat }, "classic channel message received");

    // Save photos/documents to workspace inbox so agent can read them later
    const saved = await this.saveClassicAttachment(instanceName, msg);

    // Log every message to the daily chat log (include saved path)
    const attachmentTag = saved ? ` [${saved.kind === "photo" ? "📷" : "📎"} saved: ${saved.paths.join(", ")}]`
      : msg.attachments?.length ? ` [${msg.attachments.map(a => `📎 ${a.kind}${a.filename ? `: ${a.filename}` : ""}`).join(", ")}]`
      : "";
    ClassicChannelManager.logMessage(instanceName, msg.username, text + attachmentTag, msg.timestamp, msg.replyToText);

    // Bare attachment without /chat: save + log only, don't trigger agent
    if (!isChat) {
      const reactAdapter = this.worlds.get(msg.adapterId ?? "")?.adapter ?? this.adapter;
      const reactChatId = msg.threadId ?? msg.chatId;
      if (saved && reactAdapter && reactChatId && msg.messageId) {
        // Telegram only supports limited emoji for reactions; use 👌 for photo, 👍 for file
        const emoji = msg.source === "telegram"
          ? (saved.kind === "photo" ? "👌" : "👍")
          : (saved.kind === "photo" ? "📸" : "📎");
        reactAdapter.react(reactChatId, msg.messageId, emoji)
          .catch(e => this.logger.debug({ err: (e as Error).message }, "Auto-react failed"));
      }
      return;
    }

    // /chat message: forward to agent
    const chatText = text.replace(/^\/chat\s*/, "").trim();
    if (!chatText && !msg.attachments?.length) return;
    // Block /raw bypass — admin commands must go through slash command gate
    if (chatText.startsWith("/raw ")) return;

    // Strip saved attachment from attachments to avoid double download
    const savedKind = saved?.kind;
    const patchedAttachments = savedKind ? msg.attachments?.filter(a => a.kind !== savedKind) : msg.attachments;
    const patchedMsg = { ...msg, text: chatText, attachments: patchedAttachments?.length ? patchedAttachments : undefined };
    const classicMsgAdapter = this.worlds.get(msg.adapterId ?? "")?.adapter ?? this.adapter!;
    const { text: processedText, extraMeta } = await processAttachments(patchedMsg, classicMsgAdapter, this.logger, instanceName);

    // Use workspace inbox path for saved attachment
    let finalText = processedText || chatText;
    if (saved) {
      if (saved.kind === "photo") {
        extraMeta.image_path = saved.paths[0];
        if (saved.paths.length > 1) extraMeta.image_paths = saved.paths.join(",");
        const tags = saved.paths.map(p => `[📷 Image: ${p}]`).join("\n");
        finalText = `${tags}\n${chatText}`;
      } else {
        extraMeta.attachment_path = saved.paths[0];
        if (saved.paths.length > 1) extraMeta.attachment_paths = saved.paths.join(",");
        const docAtts = msg.attachments?.filter(a => a.kind === "document") ?? [];
        const tags = saved.paths.map((p, i) => {
          const filename = docAtts[i]?.filename ?? "file";
          return `[📎 File: ${filename} → ${p}]`;
        }).join("\n");
        finalText = `${tags}\n${chatText}`;
      }
    }

    if (msg.chatId && msg.messageId) {
      const reactChatId = msg.threadId ?? msg.chatId;
      classicMsgAdapter.react(reactChatId, msg.messageId, "👀")
        .catch(e => this.logger.debug({ err: (e as Error).message }, "Auto-react failed"));
      if (saved) {
        const savedEmoji = msg.source === "telegram"
          ? (saved.kind === "photo" ? "👌" : "👍")
          : (saved.kind === "photo" ? "📸" : "📎");
        classicMsgAdapter.react(reactChatId, msg.messageId, savedEmoji)
          .catch(e => this.logger.debug({ err: (e as Error).message }, "Auto-react failed"));
      }
    }

    await this.forwardToClassicInstance(instanceName, finalText, msg, extraMeta);
  }

  /** Download photo or document attachment to classic instance workspace inbox. Returns { path, kind } or undefined. */
  private async saveClassicAttachment(instanceName: string, msg: InboundMessage): Promise<{ path: string; paths: string[]; kind: "photo" | "document" } | undefined> {
    const atts = msg.attachments?.filter(a => a.kind === "photo" || a.kind === "document" || a.kind === "sticker") ?? [];
    const dlAdapter = this.worlds.get(msg.adapterId ?? "")?.adapter ?? this.adapter;
    if (atts.length === 0 || !dlAdapter) return undefined;
    const paths: string[] = [];
    let kind: "photo" | "document" = "document";
    for (const att of atts) {
      try {
        const tmpPath = await dlAdapter.downloadAttachment(att.fileId);
        const inboxDir = join(getAgendHome(), "workspaces", instanceName, "inbox");
        mkdirSync(inboxDir, { recursive: true });
        const dest = join(inboxDir, basename(tmpPath));
        // Copy to destination — failure means this attachment is skipped
        try {
          copyFileSync(tmpPath, dest);
        } catch (copyErr) {
          try { unlinkSync(dest); } catch {} // clean partial
          this.logger.warn({ err: (copyErr as Error).message, instanceName, dest }, "Attachment copy failed — skipping");
          continue;
        }
        // Cleanup source — failure is non-fatal (dest already valid)
        try { unlinkSync(tmpPath); } catch (cleanupErr) {
          this.logger.debug({ tmpPath, err: (cleanupErr as Error).message }, "Orphan tmp not cleaned");
        }
        const savedKind = att.kind === "sticker" ? "photo" : att.kind;
        paths.push(dest);
        if (paths.length === 1) kind = savedKind as "photo" | "document";
        this.logger.info({ instanceName, path: dest, kind: savedKind }, "Classic attachment saved to workspace inbox");
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, instanceName }, "Classic attachment save failed");
      }
    }
    if (paths.length === 0) return undefined;
    return { path: paths[0], paths, kind };
  }

  /** Forward a message to a classic channel instance with chat log context */
  private async forwardToClassicInstance(
    instanceName: string,
    text: string,
    msg: { chatId: string; threadId?: string; messageId: string; userId: string; username: string; source: string; timestamp: Date; replyToText?: string; adapterId?: string },
    extraMeta?: Record<string, string>,
  ): Promise<void> {
    // Resolve the channel/adapter from the instance itself so per-channel context
    // config is correct even for a same-channel second bot.
    const ctxAdapterId = this.classicChannels?.getAdapterIdByInstance(instanceName);
    const ctxChannelId = this.classicChannels?.getChannelIdByInstance(instanceName) ?? msg.chatId;
    const contextLines = this.classicChannels?.getContextLines(ctxChannelId, ctxAdapterId) ?? 5;
    const logContext = this.getRecentChatLog(instanceName, contextLines);
    const fullText = logContext
      ? `[Chat log for context]\n${logContext}\n\n[User message]\n${text}`
      : text;

    const meta: Record<string, string> = {
      chat_id: msg.chatId,
      message_id: msg.messageId,
      user: msg.username,
      user_id: msg.userId,
      ts: msg.timestamp.toISOString(),
      thread_id: msg.threadId ?? "",
      ...(msg.adapterId ? { adapter_id: msg.adapterId } : {}),
      source: msg.source,
      ...extraMeta,
      ...(msg.replyToText ? { reply_to_text: msg.replyToText } : {}),
    };

    // If the triggering message carried no image of its own, surface the most
    // recent image saved earlier in this channel (logged as "[📷 saved: <path>]"
    // by an untriggered collab message) as image_path, so the agent's
    // read-the-image trigger fires instead of the path sitting inert in context.
    if (!meta.image_path && logContext) {
      const saves = [...logContext.matchAll(/\[📷 saved: ([^\]]+)\]/g)];
      if (saves.length > 0) {
        meta.image_path = saves[saves.length - 1][1].split(",")[0].trim();
      }
    }

    // Classic channels queue reactions like everyone else (#432 stored them, but
    // this path never attached them — reactions in a ClassicBot channel went into
    // the DB and were never seen again). Same contract as the topic paths:
    // consumed only after the delivery succeeded.
    const reactions = this.pendingReactionsMeta(instanceName);
    Object.assign(meta, reactions.meta);

    try {
      await this.deliverToInstance(instanceName, {
        type: "fleet_inbound",
        content: fullText,
        targetSession: instanceName,
        meta,
      });
      reactions.consume();
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, instanceName }, "Classic wake/delivery failed");
      return;
    }
    this.lastInboundUser.set(instanceName, msg.username);
    this.logger.info(`${msg.username} → ${instanceName} (classic): ${text.slice(0, 100)}`);
    this.trackInboundMsg(instanceName, msg);
    void this.sendCancelButton(instanceName);
  }

  /** Paste raw text directly to a classic instance's CLI (no [user:] wrapping) */
  private pasteRawToClassicInstance(instanceName: string, text: string): void {
    const ipc = this.instanceIpcClients.get(instanceName);
    if (!ipc) {
      this.logger.warn({ instanceName }, "Cannot paste raw: IPC not connected");
      return;
    }
    ipc.send({ type: "raw_paste", content: text });
    this.logger.info({ instanceName, text: text.slice(0, 100) }, "Raw paste sent to classic instance");
  }

  /** Resolve the backend name configured for an instance (fleet or classic). */
  private backendNameForInstance(instanceName: string): string {
    const fleetCfg = this.fleetConfig?.instances[instanceName];
    if (fleetCfg?.backend) return fleetCfg.backend;
    const classic = this.classicChannels?.getChannelIdByInstance(instanceName) !== undefined
      ? this.classicChannels?.getBackendByInstance(instanceName, this.fleetConfig?.defaults?.backend)
      : undefined;
    return classic ?? this.fleetConfig?.defaults?.backend ?? "claude-code";
  }

  private cliEnvPath(backend: string): string {
    return join(getAgendHome(), "cli-env", `${backend.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }

  /** Read the cached CLI env for a backend, or null if missing/stale/unparseable. */
  private readCliEnv(backend: string): import("./backend/types.js").CliEnv | null {
    try {
      const env = JSON.parse(readFileSync(this.cliEnvPath(backend), "utf-8")) as import("./backend/types.js").CliEnv;
      if (typeof env?.probedAt === "number" && Date.now() - env.probedAt < CLI_ENV_TTL_MS) return env;
    } catch { /* missing / stale / corrupt */ }
    return null;
  }

  /**
   * Resolve the effective model for a fleet or ClassicBot instance, plus where it
   * came from. Single source of truth for `/model` and `/ctx` — precedence:
   * per-instance → fleet defaults → classic channel → CLI's own default (from the
   * cli-env probe cache) → unresolved.
   */
  resolveInstanceModel(instanceName: string): { model: string; source: "instance" | "fleet-default" | "classic" | "cli-default" | "unresolved"; display: string; reason?: string } {
    const done = (model: string, source: "instance" | "fleet-default" | "classic" | "cli-default" | "unresolved", reason?: string) => ({
      model,
      source,
      reason,
      // Make an inherited CLI default legible instead of the bare word "default".
      display: source === "cli-default" ? `${model} (default)`
        : source === "unresolved" ? `default (${reason ?? "unresolved"})`
        : model,
    });

    const fleetInstance = this.fleetConfig?.instances[instanceName];
    if (fleetInstance) {
      if (fleetInstance.model?.trim()) return done(fleetInstance.model.trim(), "instance");
      const fleetDefault = this.fleetConfig?.defaults?.model;
      if (fleetDefault?.trim()) return done(fleetDefault.trim(), "fleet-default");
    }

    const classic = this.classicChannels?.getAll().find(ch => ch.instanceName === instanceName);
    if (classic) {
      const classicModel = this.classicChannels?.getModel(
        classic.channelId,
        classic.adapterId,
        this.fleetConfig?.defaults?.model,
      );
      if (classicModel?.trim()) return done(classicModel.trim(), "classic");
    }

    // Nothing configured → show what the CLI itself defaults to (kiro default_model,
    // grok "Default model:", codex config.toml, agy settings.json), cached by the probe.
    const cliEnv = this.readCliEnv(this.backendNameForInstance(instanceName));
    const cachedModel = cliEnv?.currentModel;
    if (cachedModel?.trim()) return done(cachedModel.trim(), "cli-default");
    // Say WHY it's unresolved: no fresh probe yet vs. the CLI not exposing a default
    // (e.g. claude-code's default is account-side, opencode's is provider-side).
    return done("default", "unresolved", cliEnv ? "this CLI does not report a default" : "not probed yet");
  }

  /** Human-readable effective model, e.g. `auto (default)`. Used by /ctx. */
  modelDisplayForInstance(instanceName: string): string {
    return this.resolveInstanceModel(instanceName).display;
  }

  private modelChoiceLabel(
    option: import("./backend/types.js").ModelOption,
    currentModel: string,
  ): string {
    const label = option.description ? `${option.label} — ${option.description}` : option.label;
    return option.id === currentModel ? `✓ ${label}` : label;
  }

  /** Probe one backend's CLI env and cache it. Best-effort; never throws. */
  private async probeBackend(backend: string): Promise<import("./backend/types.js").CliEnv | null> {
    try {
      const be = createBackend(backend, join(getAgendHome(), "cli-env"));
      if (!be.probeCLIEnv) return null;
      const probed = await be.probeCLIEnv({ workingDirectory: "", instanceDir: join(getAgendHome(), "cli-env"), instanceName: `probe-${backend}`, mcpServers: {} });
      const env: import("./backend/types.js").CliEnv = { backend, probedAt: Date.now(), ...probed };
      // An empty result must never overwrite a catalog we already have. Some
      // probes hit the network (`agy models` fetches, 5s cap), so a slow moment
      // returns [] — and writing that would blank the list for the whole 24h
      // TTL, long after the CLI recovered. Observed live: a good 11-model
      // antigravity cache replaced by an empty one. Keep the known models and
      // let the fresher currentModel/version through.
      if (!env.models?.length) {
        const previous = this.readCliEnv(backend);
        if (previous?.models?.length) env.models = previous.models;
      }
      // Same protection for the extended catalog: one offline moment must not
      // blank a good account list for the whole cache TTL.
      if (!env.apiModels?.length) {
        const previous = this.readCliEnv(backend);
        if (previous?.apiModels?.length) env.apiModels = previous.apiModels;
      }
      const path = this.cliEnvPath(backend);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(env, null, 2));
      return env;
    } catch (err) {
      this.logger.warn({ err, backend }, "CLI env probe failed");
      return null;
    }
  }

  /** Background-probe every distinct backend in use at startup (non-blocking). */
  private probeCliEnvs(): void {
    const backends = new Set<string>();
    if (this.fleetConfig?.defaults?.backend) backends.add(this.fleetConfig.defaults.backend);
    for (const inst of Object.values(this.fleetConfig?.instances ?? {})) if (inst.backend) backends.add(inst.backend);
    for (const ch of this.classicChannels?.getAll() ?? []) if (ch.backend) backends.add(ch.backend);
    if (backends.size === 0) backends.add("claude-code");
    for (const b of backends) void this.probeBackend(b);
  }

  /** Best-effort model list for `/model`: cached CLI env first, else live probe. Never throws. */
  private async getModelOptions(instanceName: string, refresh = false): Promise<import("./backend/types.js").ModelOption[]> {
    const backendName = this.backendNameForInstance(instanceName);
    if (!refresh) {
      const cached = this.readCliEnv(backendName);
      if (cached && cached.models.length) return cached.models;
    }
    // Cache miss / stale / forced refresh → probe live (also refreshes the cache).
    const env = await this.probeBackend(backendName);
    return env?.models ?? [];
  }

  /**
   * Model catalog behind the `list_models` tool.
   *
   * The two scopes are not cosmetic. "global" is the account/CLI catalog served
   * from the startup probe cache; "instance" is resolved through that instance's
   * OWN backend config, and for a Codex instance on a custom provider that is a
   * different catalog entirely — `listModels()` reads models_cache.json out of
   * the instance's private CODEX_HOME. Answering such an instance with the
   * account list would name models its CLI rejects, which is exactly the
   * mistake this tool exists to prevent.
   *
   * `scope` always describes where the returned LIST came from, not what was
   * asked for: an instance query that falls back to the account catalog reports
   * scope "global" and says so in `note`, rather than implying instance-level
   * accuracy it does not have.
   *
   * Never throws — a model listing is an aid, and failing it must not fail a turn.
   */
  async listModelCatalog(opts: { backend?: string; instanceName?: string } = {}): Promise<ModelCatalog> {
    const { instanceName } = opts;
    if (instanceName) {
      const backend = this.backendNameForInstance(instanceName);
      const resolved = this.resolveInstanceModel(instanceName);
      const currentModel = resolved.source === "unresolved" ? null : resolved.model;
      const provider = this.customProviderFor(instanceName, backend);

      const scoped = await this.instanceScopedModels(instanceName, backend);
      if (scoped.length) {
        return {
          backend, scope: "instance", instance: instanceName,
          current_model: currentModel, models: scoped, source: "live",
          ...(provider ? { note: `Catalog read through this instance's ${backend} provider "${provider}" — it may differ from the account catalog.` } : {}),
        };
      }
      // No instance-local catalog (never launched, or the backend has no
      // per-instance list). The account catalog is the best available answer,
      // but it is labelled honestly rather than dressed up as instance scope.
      const global = await this.globalModelCatalog(backend);
      return {
        ...global, instance: instanceName, current_model: currentModel,
        note: provider
          ? `No instance-local catalog yet; showing the account catalog, which may NOT match this instance's ${backend} provider "${provider}".`
          : "No instance-local catalog yet; showing the account catalog.",
      };
    }
    return this.globalModelCatalog(opts.backend ?? this.fleetConfig?.defaults?.backend ?? "claude-code");
  }

  /** The custom provider an instance overrides its backend with, if any. */
  private customProviderFor(instanceName: string, backend: string): string | null {
    const opts = this.fleetConfig?.instances?.[instanceName]?.backend_options?.[backend]
      ?? this.fleetConfig?.defaults?.backend_options?.[backend];
    const provider = (opts as { provider?: unknown } | undefined)?.provider;
    return typeof provider === "string" && provider.trim() ? provider.trim() : null;
  }

  /** Ask a backend for its catalog using ONE instance's real config. Never throws. */
  private async instanceScopedModels(instanceName: string, backend: string): Promise<import("./backend/types.js").ModelOption[]> {
    try {
      const inst = this.fleetConfig?.instances?.[instanceName];
      const instanceDir = this.getInstanceDir(instanceName);
      const be = createBackend(backend, instanceDir);
      if (!be.listModels) return [];
      return await be.listModels({
        workingDirectory: inst?.working_directory ?? "",
        instanceDir,
        instanceName,
        mcpServers: {},
        model: inst?.model,
        backendOptions: inst?.backend_options?.[backend] ?? this.fleetConfig?.defaults?.backend_options?.[backend],
      }) ?? [];
    } catch {
      // listModels is documented never to throw, but a backend constructor can
      // (missing binary). A catalog is an aid; degrade to the account list.
      return [];
    }
  }

  /** Account-wide catalog: probe cache first, live probe on miss. */
  private async globalModelCatalog(backend: string): Promise<ModelCatalog> {
    const cached = this.readCliEnv(backend);
    if (cached?.models?.length) {
      return {
        backend, scope: "global", current_model: cached.currentModel ?? null,
        models: cached.models, source: "cache",
        probed_at: new Date(cached.probedAt).toISOString(),
      };
    }
    const env = await this.probeBackend(backend);
    if (env?.models?.length) {
      return {
        backend, scope: "global", current_model: env.currentModel ?? null,
        models: env.models, source: "live",
        probed_at: new Date(env.probedAt).toISOString(),
      };
    }
    // Reported rather than thrown: "we could not enumerate" is a useful answer,
    // and the caller can still set a model by name (AgEnD passes it through).
    return {
      backend, scope: "global", current_model: env?.currentModel ?? null,
      models: [], source: "fallback",
      note: `Could not enumerate models for ${backend} (CLI missing, not logged in, or it offers no list). Model names are passed through to the CLI, so a known-good name still works.`,
    };
  }

  /** `/model` slash handler (admin only). No arg → DC menu; `/model <name>` → apply directly. */
  /** Label an effort choice, marking the one currently configured. */
  private effortChoiceLabel(level: string, current: string | null): string {
    return level === current ? `✓ ${level}` : level;
  }

  private effortMenuHeader(instanceName: string): string {
    const { effort, source } = this.resolveInstanceEffort(instanceName);
    if (!effort) return t("effort.current_default");
    return source === "fleet-default"
      ? t("effort.current_fleet", effort)
      : t("effort.current", effort);
  }

  /** `/effort` — DC Select Menu, or apply directly when a level is given. */
  private async handleEffortSlash(data: ClassicStartSlashData, adapterId: string): Promise<void> {
    if (!this.isModelAdmin(data.userId, data.channelId, adapterId)) {
      await data.respond(t("permission.denied"));
      return;
    }
    const name = this.resolveSlashTarget(data.channelId, adapterId);
    if (!name) { await data.respond(t("classic.no_agent")); return; }

    const requested = (typeof data.options?.level === "string" ? data.options.level.trim() : "")
      || (data.text?.trim() ?? "");
    if (requested) { await data.respond(await this.applyEffort(name, requested)); return; }

    const levels = this.effortLevelsFor(name);
    if (levels.length === 0) {
      await data.respond(t("effort.unsupported", this.backendNameForInstance(name)));
      return;
    }
    if (!data.respondChoices) { await data.respond(t("effort.usage", levels.join("|"))); return; }

    const current = this.resolveInstanceEffort(name).effort;
    const nonce = randomBytes(6).toString("hex");
    const choices = levels.map(l => ({
      id: `${EFFORT_SELECT_CALLBACK_PREFIX}${nonce}:${l}`,
      label: this.effortChoiceLabel(l, current),
    }));
    const timer = setTimeout(() => this.pendingEffortSelects.delete(nonce), CLASSIC_BACKEND_SELECTION_TIMEOUT_MS);
    timer.unref?.();
    this.pendingEffortSelects.set(nonce, { instanceName: name, userId: data.userId, channelId: data.channelId, timer, respond: data.respond });
    try {
      await data.respondChoices(t("effort.menu", this.effortMenuHeader(name)), choices);
    } catch (err) {
      this.pendingEffortSelects.delete(nonce);
      clearTimeout(timer);
      this.logger.warn({ err, instanceName: name }, "effort menu failed");
      await data.respond(t("effort.usage", levels.join("|")));
    }
  }

  /** TG inline-keyboard effort menu. Returns null on success, else a fallback string. */
  async promptEffortMenu(
    instanceName: string,
    userId: string,
    channelId: string,
    adapter: ChannelAdapter,
    chatId: string,
    threadId?: string,
  ): Promise<string | null> {
    const levels = this.effortLevelsFor(instanceName);
    if (levels.length === 0) {
      return t("effort.unsupported", this.backendNameForInstance(instanceName));
    }
    const current = this.resolveInstanceEffort(instanceName).effort;
    const nonce = randomBytes(6).toString("hex");
    const choices = levels.map(l => ({
      id: `${EFFORT_SELECT_CALLBACK_PREFIX}${nonce}:${l}`,
      label: this.effortChoiceLabel(l, current),
    }));
    const respond = async (text: string): Promise<string | undefined> => {
      await adapter.sendText(chatId, text, { threadId });
      return undefined;
    };
    const timer = setTimeout(() => {
      const p = this.pendingEffortSelects.get(nonce);
      if (p) {
        this.pendingEffortSelects.delete(nonce);
        p.respond(t("effort.selection_expired")).catch(() => {});
      }
    }, CLASSIC_BACKEND_SELECTION_TIMEOUT_MS);
    timer.unref?.();
    this.pendingEffortSelects.set(nonce, { instanceName, userId, channelId, timer, respond, adapter, adapterChatId: chatId, adapterThreadId: threadId });
    try {
      const menuMessageId = await adapter.promptUser(
        chatId, t("effort.menu", this.effortMenuHeader(instanceName)), choices, { threadId },
      );
      const pending = this.pendingEffortSelects.get(nonce);
      if (pending) pending.menuMessageId = menuMessageId;
      return null;
    } catch (err) {
      this.pendingEffortSelects.delete(nonce);
      clearTimeout(timer);
      this.logger.warn({ err, instanceName }, "TG effort menu failed");
      return t("effort.usage", levels.join("|"));
    }
  }

  /** Consume an `/effort` selection callback. Mirrors handleModelSelection. */
  private async handleEffortSelection(data: AdapterCallbackData): Promise<boolean> {
    if (!data.callbackData.startsWith(EFFORT_SELECT_CALLBACK_PREFIX)) return false;
    const match = data.callbackData.match(/^effort-select:([0-9a-f]+):(.+)$/);
    if (!match) return true;
    const pending = this.pendingEffortSelects.get(match[1]);
    if (!pending) return true;
    if (data.userId && data.userId !== pending.userId) return true;
    const cbChannel = data.threadId ?? data.chatId;
    if (cbChannel !== pending.channelId && data.chatId !== pending.channelId) return true;
    this.pendingEffortSelects.delete(match[1]);
    clearTimeout(pending.timer);

    const level = match[2];
    const progressText = t("effort.setting", pending.instanceName, level);
    let progressMsgId: string | undefined;
    if (pending.adapter && pending.adapterChatId) {
      const menuMessageId = pending.menuMessageId ?? data.messageId;
      if (menuMessageId && pending.adapter.editMessageRemoveButtons) {
        try {
          await pending.adapter.editMessageRemoveButtons(pending.adapterChatId, menuMessageId, progressText, pending.adapterThreadId);
          progressMsgId = menuMessageId;
        } catch { /* fall back to a new message */ }
      }
      if (!progressMsgId) {
        try {
          const sent = await pending.adapter.sendText(pending.adapterChatId, progressText, { threadId: pending.adapterThreadId });
          progressMsgId = sent.messageId;
        } catch { /* non-fatal */ }
      }
    } else {
      await pending.respond(progressText).catch(() => {});
    }

    // Background-applied and guarded for the same reason as the model path: a
    // restart backend respawns the instance here, and an unguarded rejection
    // from a menu click must not take the fleet down.
    void (async () => {
      let result: string;
      try {
        result = await this.applyEffort(pending.instanceName, level);
      } catch (err) {
        this.logger.error({ err, instance: pending.instanceName, level }, "Effort switch failed");
        result = t("effort.switch_failed", level, err instanceof Error ? err.message : String(err));
      }
      if (pending.adapter && pending.adapterChatId) {
        if (progressMsgId) {
          pending.adapter.editMessage(pending.adapterChatId, progressMsgId, result, pending.adapterThreadId).catch(() => {
            pending.adapter!.sendText(pending.adapterChatId!, result, { threadId: pending.adapterThreadId }).catch(() => {});
          });
        } else {
          pending.adapter.sendText(pending.adapterChatId, result, { threadId: pending.adapterThreadId }).catch(() => {});
        }
      } else {
        await pending.respond(result).catch(() => {});
      }
    })();
    return true;
  }

  private async handleModelSlash(data: ClassicStartSlashData, adapterId: string): Promise<void> {
    if (!this.isModelAdmin(data.userId, data.channelId, adapterId)) {
      await data.respond(t("permission.denied"));
      return;
    }
    const name = this.resolveSlashTarget(data.channelId, adapterId);
    if (!name) { await data.respond(t("classic.no_agent")); return; }

    const requested = (typeof data.options?.name === "string" ? data.options.name.trim() : "")
      || (data.text?.trim() ?? "");
    const isRefresh = requested === "--refresh" || requested === "refresh";
    if (requested && !isRefresh) { await data.respond(await this.applyModel(name, requested)); return; }

    // No arg (or --refresh) → menu. Menu is DC-only this round (respondChoices); TG uses `/model <name>`.
    if (!data.respondChoices) { await data.respond(t("model.usage")); return; }
    const options = await this.getModelOptions(name, isRefresh);
    if (options.length === 0) { await data.respond(t("model.list_unavailable", name)); return; }

    // Raw id for ✓-matching options; display resolves an inherited CLI default.
    const { model: currentModel, display: currentDisplay } = this.resolveInstanceModel(name);
    const nonce = randomBytes(6).toString("hex");
    const isClaude = this.backendNameForInstance(name) === "claude-code";
    const choices = options.slice(0, isClaude ? 24 : 25).map(o => ({
      id: `${MODEL_SELECT_CALLBACK_PREFIX}${nonce}:${o.id}`,
      label: this.modelChoiceLabel(o, currentModel),
    }));
    if (isClaude) {
      choices.push({ id: `${MODEL_SELECT_CALLBACK_PREFIX}${nonce}:__more__`, label: t("model.more") });
    }
    const timer = setTimeout(() => this.pendingModelSelects.delete(nonce), CLASSIC_BACKEND_SELECTION_TIMEOUT_MS);
    timer.unref?.();
    this.pendingModelSelects.set(nonce, { instanceName: name, model: "", userId: data.userId, channelId: data.channelId, timer, respond: data.respond, respondChoices: data.respondChoices });
    try {
      await data.respondChoices(t("model.menu", `**${currentDisplay}**`), choices);
    } catch (err) {
      this.pendingModelSelects.delete(nonce);
      clearTimeout(timer);
      this.logger.warn({ err, instanceName: name }, "model menu failed");
      await data.respond(t("model.usage"));
    }
  }

  /**
   * Show a TG inline-keyboard model-selection menu. Reuses the same
   * pendingModelSelects coordinator as the DC Select Menu path.
   * Returns null on success (menu shown), or a fallback string to send.
   */
  async promptModelMenu(
    instanceName: string,
    userId: string,
    channelId: string,
    adapter: ChannelAdapter,
    chatId: string,
    threadId?: string,
  ): Promise<string | null> {
    const options = await this.getModelOptions(instanceName);
    if (options.length === 0) {
      return t("model.list_unavailable", instanceName);
    }

    const { model: currentModel, display: currentDisplay } = this.resolveInstanceModel(instanceName);
    const nonce = randomBytes(6).toString("hex");
    const isClaude = this.backendNameForInstance(instanceName) === "claude-code";
    // Keep the more-models entry inside Discord's 25-option select cap.
    const choices = options.slice(0, isClaude ? 24 : 25).map(o => ({
      id: `${MODEL_SELECT_CALLBACK_PREFIX}${nonce}:${o.id}`,
      label: this.modelChoiceLabel(o, currentModel),
    }));
    if (isClaude) {
      choices.push({ id: `${MODEL_SELECT_CALLBACK_PREFIX}${nonce}:__more__`, label: t("model.more") });
    }

    const respond = async (text: string): Promise<string | undefined> => {
      await adapter.sendText(chatId, text, { threadId });
      return undefined;
    };

    const timer = setTimeout(() => {
      const p = this.pendingModelSelects.get(nonce);
      if (p) {
        this.pendingModelSelects.delete(nonce);
        p.respond(t("model.selection_expired")).catch(() => {});
      }
    }, CLASSIC_BACKEND_SELECTION_TIMEOUT_MS);
    timer.unref?.();

    this.pendingModelSelects.set(nonce, { instanceName, model: "", userId, channelId, timer, respond, adapter, adapterChatId: chatId, adapterThreadId: threadId });

    try {
      const menuMessageId = await adapter.promptUser(
        chatId,
        t("model.menu", currentDisplay),
        choices,
        { threadId },
      );
      const pending = this.pendingModelSelects.get(nonce);
      if (pending) pending.menuMessageId = menuMessageId;
      return null; // menu shown
    } catch (err) {
      this.pendingModelSelects.delete(nonce);
      clearTimeout(timer);
      this.logger.warn({ err, instanceName }, "TG model menu failed");
      return t("model.usage");
    }
  }

  /** Cached-or-live account catalog behind "/model → more models" (claude). */
  private async claudeApiModelOptions(): Promise<import("./backend/types.js").ModelOption[]> {
    const cached = this.readCliEnv("claude-code");
    if (cached?.apiModels?.length) return cached.apiModels;
    const env = await this.probeBackend("claude-code");
    return env?.apiModels ?? [];
  }

  /** Replace a consumed "/model" menu with the full account catalog tier. */
  private async expandClaudeModelMenu(pending: {
    instanceName: string; userId: string; channelId: string;
    respond: (t: string) => Promise<string | undefined>;
    adapter?: ChannelAdapter; adapterChatId?: string; adapterThreadId?: string; menuMessageId?: string;
    respondChoices?: (text: string, choices: { id: string; label: string }[]) => Promise<string | undefined>;
  }): Promise<void> {
    const expanded = await this.claudeApiModelOptions();
    if (!expanded.length) {
      await pending.respond(t("model.more_unavailable")).catch(() => {});
      return;
    }
    const { model: currentModel, display: currentDisplay } = this.resolveInstanceModel(pending.instanceName);
    const nonce = randomBytes(6).toString("hex");
    const choices = expanded.slice(0, 25).map(o => ({
      id: `${MODEL_SELECT_CALLBACK_PREFIX}${nonce}:${o.id}`,
      label: this.modelChoiceLabel(o, currentModel),
    }));
    const timer = setTimeout(() => {
      const p = this.pendingModelSelects.get(nonce);
      if (p) {
        this.pendingModelSelects.delete(nonce);
        p.respond(t("model.selection_expired")).catch(() => {});
      }
    }, CLASSIC_BACKEND_SELECTION_TIMEOUT_MS);
    timer.unref?.();
    this.pendingModelSelects.set(nonce, { ...pending, model: "", timer });

    try {
      if (pending.respondChoices) {
        // Discord select menu: edit the same interaction reply in place.
        await pending.respondChoices(t("model.menu", `**${currentDisplay}**`), choices);
        return;
      }
      if (pending.adapter && pending.adapterChatId) {
        // Telegram: retire the tier-1 keyboard, then post the expanded menu.
        if (pending.menuMessageId && pending.adapter.editMessageRemoveButtons) {
          await pending.adapter.editMessageRemoveButtons(
            pending.adapterChatId, pending.menuMessageId, t("model.more"), pending.adapterThreadId,
          ).catch(() => {});
        }
        const menuMessageId = await pending.adapter.promptUser(
          pending.adapterChatId, t("model.menu", currentDisplay), choices,
          { threadId: pending.adapterThreadId },
        );
        const fresh = this.pendingModelSelects.get(nonce);
        if (fresh) fresh.menuMessageId = menuMessageId;
        return;
      }
      await pending.respond(t("model.more_unavailable")).catch(() => {});
    } catch (err) {
      this.pendingModelSelects.delete(nonce);
      clearTimeout(timer);
      this.logger.warn({ err, instanceName: pending.instanceName }, "Expanded model menu failed");
      await pending.respond(t("model.more_unavailable")).catch(() => {});
    }
  }

  /** Consume a `/model` selection callback. Returns true for all model-select ids (incl. stale). */
  private async handleModelSelection(data: AdapterCallbackData): Promise<boolean> {
    if (!data.callbackData.startsWith(MODEL_SELECT_CALLBACK_PREFIX)) return false;
    const match = data.callbackData.match(/^model-select:([0-9a-f]+):(.+)$/);
    if (!match) return true;
    const pending = this.pendingModelSelects.get(match[1]);
    if (!pending) return true;
    // Only the admin who opened the menu, in the same channel, may consume it.
    if (data.userId && data.userId !== pending.userId) return true;
    const cbChannel = data.threadId ?? data.chatId;
    if (cbChannel !== pending.channelId && data.chatId !== pending.channelId) return true;
    this.pendingModelSelects.delete(match[1]);
    clearTimeout(pending.timer);

    const model = match[2];
    // "More models…" is a navigation choice, not a model: swap the menu for the
    // full account catalog (live /v1/models with [1m] variants).
    if (model === "__more__") {
      await this.expandClaudeModelMenu(pending);
      return true;
    }

    // Send immediate "⏳ Switching..." feedback, then apply in background.
    const progressText = t("model.switching", pending.instanceName, model);
    let progressMsgId: string | undefined;
    if (pending.adapter && pending.adapterChatId) {
      // TG path: turn the original menu into the progress message. This both
      // removes its inline keyboard and gives the final result a stable message
      // to edit, avoiding a stale selectable menu above a separate status post.
      const menuMessageId = pending.menuMessageId ?? data.messageId;
      if (menuMessageId && pending.adapter.editMessageRemoveButtons) {
        try {
          await pending.adapter.editMessageRemoveButtons(
            pending.adapterChatId,
            menuMessageId,
            progressText,
            pending.adapterThreadId,
          );
          progressMsgId = menuMessageId;
        } catch { /* fall back to a new progress message */ }
      }
      if (!progressMsgId) {
        try {
          const sent = await pending.adapter.sendText(pending.adapterChatId, progressText, { threadId: pending.adapterThreadId });
          progressMsgId = sent.messageId;
        } catch { /* non-fatal */ }
      }
    } else {
      // DC path: respond immediately with progress text
      await pending.respond(progressText).catch(() => {});
    }

    // Apply model in background — don't await here (keeps callback handler fast).
    // Guarded: applyModel() restarts the instance, and an unguarded rejection here
    // meant a user picking from the /model menu could take the whole fleet down.
    // On failure the user gets told, rather than the click silently doing nothing.
    void (async () => {
      let result: string;
      try {
        result = await this.applyModel(pending.instanceName, model);
      } catch (err) {
        this.logger.error({ err, instance: pending.instanceName, model }, "Model switch failed");
        result = t("model.switch_failed", model, err instanceof Error ? err.message : String(err));
      }
      if (pending.adapter && pending.adapterChatId) {
        if (progressMsgId) {
          pending.adapter.editMessage(pending.adapterChatId, progressMsgId, result, pending.adapterThreadId).catch(() => {
            pending.adapter!.sendText(pending.adapterChatId!, result, { threadId: pending.adapterThreadId }).catch(() => {});
          });
        } else {
          pending.adapter.sendText(pending.adapterChatId, result, { threadId: pending.adapterThreadId }).catch(() => {});
        }
      } else {
        await pending.respond(result).catch(() => {});
      }
    })();

    return true;
  }

  /** Apply a model to an instance: runtime paste (claude-code) or persist + restart (others). */
  /** AgEnD's canonical effort ladder, low → max. Backends expose a subset. */
  static readonly EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

  /** How this instance's backend applies an effort change. */
  effortStrategyFor(instanceName: string): "runtime" | "restart" | "unsupported" {
    try {
      const backend = createBackend(this.backendNameForInstance(instanceName), this.getInstanceDir(instanceName));
      const strategy = backend.getEffortStrategy?.() ?? "unsupported";
      // A backend claiming support but listing no levels is unusable either way.
      return strategy !== "unsupported" && (backend.getEffortLevels?.() ?? []).length > 0
        ? strategy
        : "unsupported";
    } catch { return "unsupported"; }
  }

  /** Effort levels this instance's backend actually accepts (empty = unsupported). */
  effortLevelsFor(instanceName: string): string[] {
    try {
      const backend = createBackend(this.backendNameForInstance(instanceName), this.getInstanceDir(instanceName));
      if ((backend.getEffortStrategy?.() ?? "unsupported") === "unsupported") return [];
      return backend.getEffortLevels?.() ?? [];
    } catch { return []; }
  }

  /** Configured effort for an instance: per-instance, else fleet default, else none. */
  resolveInstanceEffort(instanceName: string): { effort: string | null; source: "instance" | "fleet-default" | "unset" } {
    const own = (this.fleetConfig?.instances[instanceName] as { effort?: string } | undefined)?.effort;
    if (own) return { effort: own, source: "instance" };
    const fallback = (this.fleetConfig?.defaults as { effort?: string } | undefined)?.effort;
    if (fallback) return { effort: fallback, source: "fleet-default" };
    return { effort: null, source: "unset" };
  }

  /**
   * Clamp a canonical level to the nearest one this backend supports.
   *
   * Clamping DOWN the ladder, never up: asking for `max` on a CLI that stops at
   * `high` should get high, not silently fall to low. The caller reports the
   * clamp — a user who asks for max and quietly receives high has been told the
   * request succeeded when it did not.
   */
  static clampEffort(level: string, supported: string[]): string | null {
    if (supported.includes(level)) return level;
    const ladder = FleetManager.EFFORT_LEVELS as readonly string[];
    const wanted = ladder.indexOf(level);
    if (wanted < 0) return null;
    for (let i = wanted - 1; i >= 0; i--) {
      if (supported.includes(ladder[i])) return ladder[i];
    }
    return supported[0] ?? null;
  }

  /**
   * Apply a reasoning-effort level, mirroring applyModel's shape.
   *
   * runtime backends take `/effort <level>` in the pane and keep working;
   * restart backends only read it at launch, so it is persisted and the
   * instance respawns.
   */
  async applyEffort(instanceName: string, requested: string): Promise<string> {
    const level = requested.trim().toLowerCase();
    const backendName = this.backendNameForInstance(instanceName);
    let strategy: "runtime" | "restart" | "unsupported" = "unsupported";
    let supported: string[] = [];
    try {
      const backend = createBackend(backendName, this.getInstanceDir(instanceName));
      strategy = backend.getEffortStrategy?.() ?? "unsupported";
      supported = backend.getEffortLevels?.() ?? [];
    } catch { /* treated as unsupported below */ }

    if (strategy === "unsupported" || supported.length === 0) {
      return t("effort.unsupported", backendName);
    }
    if (!(FleetManager.EFFORT_LEVELS as readonly string[]).includes(level)) {
      return t("effort.unknown", level, FleetManager.EFFORT_LEVELS.join(", "));
    }

    const applied = FleetManager.clampEffort(level, supported);
    if (!applied) return t("effort.no_canonical", backendName);
    const warn = applied === level
      ? ""
      : t("effort.clamped", applied, level, backendName);

    // Persist either way: a runtime switch must survive the next respawn too,
    // or the instance silently reverts on restart.
    if (this.fleetConfig?.instances[instanceName]) {
      (this.fleetConfig.instances[instanceName] as { effort?: string }).effort = applied;
      this.saveFleetConfig();
    }

    if (strategy === "runtime") {
      if (!this.instanceIpcClients.get(instanceName)) return `${warn}${t("effort.not_running", instanceName)}`;
      this.pasteRawToClassicInstance(instanceName, `/effort ${applied}`);
      return `${warn}${t("effort.runtime_success", instanceName, applied)}`;
    }
    await this.restartSingleInstance(instanceName);
    return `${warn}${t("effort.restart_success", instanceName, applied)}`;
  }

  async applyModel(instanceName: string, model: string): Promise<string> {
    const backendName = this.backendNameForInstance(instanceName);
    let strategy: "runtime" | "restart" = "restart";
    try {
      strategy = createBackend(backendName, this.getInstanceDir(instanceName)).getModelSwitchStrategy?.(model) ?? "restart";
    } catch { /* default restart */ }
    const warn = isModelCompatible(backendName, model) ? "" : t("model.pattern_warning", model, backendName);

    if (strategy === "runtime" && !this.instanceIpcClients.get(instanceName)) {
      return `${warn}${t("effort.not_running", instanceName)}`;
    }

    // Persist either way: a runtime switch must survive the next respawn too,
    // or the instance silently reverts to the CLI default after a fleet restart.
    let persisted = false;
    if (this.fleetConfig?.instances[instanceName]) {
      this.fleetConfig.instances[instanceName].model = model;
      this.saveFleetConfig();
      persisted = true;
    } else if (this.classicChannels?.setModelByInstance(instanceName, model)) {
      persisted = true;
    }
    if (!persisted) return `${warn}${t("model.persist_failed", instanceName)}`;

    if (strategy === "runtime") {
      this.pasteRawToClassicInstance(instanceName, `/model ${model}`);
      return `${warn}${t("model.runtime_success", instanceName, model)}${this.effortSuffix(instanceName)}`;
    }

    await this.restartSingleInstance(instanceName);
    return `${warn}${t("model.restart_success", instanceName, model)}${this.effortSuffix(instanceName)}`;
  }

  /**
   * The trailing "Current effort: …" line for a /model reply.
   *
   * Model and effort interact (a cheaper model at max effort is a different
   * trade than a bigger one at low), so showing the effort in force right after
   * a switch saves the round trip of asking. Empty when the backend has none.
   */
  private effortSuffix(instanceName: string): string {
    if (this.effortLevelsFor(instanceName).length === 0) return "";
    const { effort, source } = this.resolveInstanceEffort(instanceName);
    if (!effort) return `\n${t("effort.current_default")}`;
    return source === "fleet-default"
      ? `\n${t("effort.current_fleet", effort)}`
      : `\n${t("effort.current", effort)}`;
  }

  /** Read recent chat log for agent context */
  private getRecentChatLog(instanceName: string, maxLines = 10): string | undefined {
    const logDir = ClassicChannelManager.chatLogDir(instanceName);
    // Use local timezone for date — must match logMessage's write path
    const tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const today = new Date().toLocaleString("sv-SE", { timeZone: tz, hour12: false }).slice(0, 10);
    const logFile = join(logDir, `${today}.log`);
    try {
      if (!existsSync(logFile)) return undefined;
      const lines = readFileSync(logFile, "utf-8").trim().split("\n");
      // The triggering message is written before forwardToClassicInstance runs
      // and is included separately under [User message]. Exclude that newest
      // log entry so the agent does not receive the same message twice. A chat
      // message may span physical lines, so remove from its timestamped entry
      // header rather than blindly dropping only the final continuation line.
      const entryHeader = /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] <.*> /;
      let currentEntryStart = lines.length - 1;
      while (currentEntryStart > 0 && !entryHeader.test(lines[currentEntryStart])) {
        currentEntryStart--;
      }
      lines.splice(currentEntryStart);
      if (lines.length === 0 || maxLines <= 0) return undefined;
      return lines.slice(-maxLines).join("\n") || undefined;
    } catch { return undefined; }
  }

  /** Return a user-facing blocker without mutating ClassicBot state. */
  private validateClassicStart(channelId: string, userId: string, guildId?: string, adapterId?: string): string | undefined {
    if (!this.classicChannels) return t("classic.manager_unavailable");
    if (guildId && !this.classicChannels.isGuildAllowed(guildId)) {
      const generalId = this.findGeneralInstance(adapterId);
      if (generalId) this.notifyInstanceTopic(generalId, t("alert.unauth_guild", guildId, userId));
      return t("classic.not_authorized_guild");
    }
    if (this.classicChannels.isClassicChannel(channelId, adapterId)) return t("classic.already_active");
    if (this.routing.resolve(channelId)) return t("classic.topic_bound");
    return undefined;
  }

  private isBackendInstalled(backend: string): boolean {
    const installation = BACKEND_INSTALLATION_INFO[backend];
    return !!installation && checkBinaryInstalled(installation.binary);
  }

  private getMissingBackendWarning(backend: string | undefined): string | undefined {
    if (!backend) return undefined;
    const installation = BACKEND_INSTALLATION_INFO[backend];
    if (!installation || this.isBackendInstalled(backend)) return undefined;
    return t("classic.backend_not_installed", backend, installation.binary, installation.install);
  }

  /** Handle Discord's required static slash choice, warning before a likely startup failure. */
  private async handleClassicStartSlash(data: ClassicStartSlashData, adapterId: string): Promise<void> {
    const requestedBackend = typeof data.options?.backend === "string" ? data.options.backend : undefined;
    if (!requestedBackend) {
      // beta.31 made this option required. Discord can briefly retain the old
      // command schema client-side, however, so stale clients may still submit
      // `/start` without it. Do not resurrect the legacy 60-second component
      // menu in that case: fail immediately and make the user invoke the newly
      // registered command, which guarantees an explicit backend choice.
      await data.respond(t("classic.backend_required"));
      return;
    }

    const warning = this.getMissingBackendWarning(requestedBackend);
    // Keep the deferred ephemeral response useful even if daemon startup later
    // fails because the executable is absent. This is advisory, not a gate.
    if (warning) await data.respond(warning);
    const reply = await this.handleClassicStart(
      data.channelId,
      data.channelName,
      data.userId,
      data.guildId,
      adapterId,
      requestedBackend,
    );
    await data.respond(warning ? `${warning}\n\n${reply}` : reply);
  }

  /** Present platform-native backend choices, then start on selection or timeout. */
  private async beginClassicBackendSelection(data: ClassicStartSlashData, adapter: ChannelAdapter): Promise<void> {
    const adapterId = adapter.id;
    const blocker = this.validateClassicStart(data.channelId, data.userId, data.guildId, adapterId);
    if (blocker) {
      await data.respond(blocker);
      return;
    }

    const nonce = randomBytes(6).toString("hex");
    const choices = getClassicBackendChoices().map(choice => ({
      id: `${CLASSIC_BACKEND_CALLBACK_PREFIX}${nonce}:${choice.id}`,
      label: `${this.isBackendInstalled(choice.id) ? "✅" : "❌"} ${choice.label}`,
    }));
    const complete = data.respondChoices
      ? async (text: string) => { await data.respond(text); }
      : async (text: string, messageId?: string) => {
          if (messageId && adapter.editMessageRemoveButtons) {
            try {
              await adapter.editMessageRemoveButtons(data.channelId, messageId, text);
              return;
            } catch { /* fall back to a new message */ }
          }
          await data.respond(text);
        };

    const timer = setTimeout(() => {
      // Timeout: cancel the selection — do NOT fall back to default.
      const p = this.pendingClassicStarts.get(nonce);
      if (p) {
        this.pendingClassicStarts.delete(nonce);
        p.complete(t("classic.selection_expired"), p.messageId).catch(() => {});
      }
    }, CLASSIC_BACKEND_SELECTION_TIMEOUT_MS);
    timer.unref?.();
    const pending: PendingClassicStart = {
      channelId: data.channelId,
      channelName: data.channelName,
      userId: data.userId,
      guildId: data.guildId,
      adapterId,
      timer,
      complete,
    };
    this.pendingClassicStarts.set(nonce, pending);

    try {
      pending.messageId = data.respondChoices
        ? await data.respondChoices(t("classic.choose_backend"), choices)
        : await adapter.promptUser(data.channelId, t("classic.choose_backend"), choices);
    } catch (err) {
      // A menu transport failure should not make /start unusable: consume the
      // pending request and immediately use the configured default.
      this.logger.warn({ err, channelId: data.channelId, adapterId }, "Classic backend menu failed; using default");
      await this.finishClassicBackendSelection(nonce);
    }
  }

  /** Consume a selection callback. Returns true for all ClassicBot callback IDs, including stale ones. */
  private async handleClassicBackendSelection(data: AdapterCallbackData): Promise<boolean> {
    if (!data.callbackData.startsWith(CLASSIC_BACKEND_CALLBACK_PREFIX)) return false;
    const match = data.callbackData.match(/^classic-backend:([0-9a-f]+):(.+)$/);
    if (!match) return true;
    const pending = this.pendingClassicStarts.get(match[1]);
    if (!pending) return true;

    // Telegram keyboards are visible to everyone in a group. Only the user who
    // issued /start may consume the pending selection.
    if (data.userId && data.userId !== pending.userId) return true;
    const callbackChannelId = data.threadId ?? data.chatId;
    if (callbackChannelId !== pending.channelId && data.chatId !== pending.channelId) return true;

    await this.finishClassicBackendSelection(match[1], match[2]);
    return true;
  }

  /** Atomically claim one pending request so timeout/click races create at most one instance. */
  private async finishClassicBackendSelection(nonce: string, backend?: string): Promise<void> {
    const pending = this.pendingClassicStarts.get(nonce);
    if (!pending) return;
    this.pendingClassicStarts.delete(nonce);
    clearTimeout(pending.timer);
    const selectedBackend = isSelectableClassicBackend(backend) ? backend : undefined;
    const effectiveBackend = selectedBackend
      ?? this.classicChannels?.getDefaults().backend
      ?? this.fleetConfig?.defaults?.backend
      ?? "claude-code";
    const warning = this.getMissingBackendWarning(effectiveBackend);
    // Show the warning before starting so it survives a missing-binary startup
    // failure. The selected backend is still attempted as requested.
    if (warning) await pending.complete(warning, pending.messageId);
    const reply = await this.handleClassicStart(
      pending.channelId,
      pending.channelName,
      pending.userId,
      pending.guildId,
      pending.adapterId,
      selectedBackend,
    );
    await pending.complete(warning ? `${warning}\n\n${reply}` : reply, pending.messageId);
  }

  /** Start a classic channel instance with lightweight config */
  private async startClassicInstance(
    instanceName: string,
    backend?: string,
    preTaskCommand?: string,
    model?: string,
    autoPauseAfter?: number,
  ): Promise<void> {
    if (this.daemons.has(instanceName)) return;
    const workDir = join(getAgendHome(), "workspaces", instanceName);
    ensureWorkspaceGit(workDir);
    const classicIdentity = this.classicChannels?.getAll().find(ch => ch.instanceName === instanceName);
    const config: InstanceConfig = {
      ...DEFAULT_INSTANCE_CONFIG,
      ...this.fleetConfig?.defaults,
      working_directory: workDir,
      lightweight: true,
      ...(backend ? { backend } : {}),
      ...(model ? { model } : {}),
      ...(classicIdentity?.displayName ? { display_name: classicIdentity.displayName } : {}),
      ...(classicIdentity?.description ? { description: classicIdentity.description } : {}),
      ...(autoPauseAfter !== undefined ? { auto_pause_after: autoPauseAfter } : {}),
      ...(preTaskCommand ? { pre_task_command: preTaskCommand } : {}),
    };
    const topicMode = this.fleetConfig?.channel?.mode === "topic";
    await this.startInstance(instanceName, config, topicMode, "classic");
  }

  /** Handle /start slash command — register classic channel */
  async handleClassicStart(channelId: string, channelName: string, userId: string, guildId?: string, adapterId?: string, backend?: string): Promise<string> {
    const blocker = this.validateClassicStart(channelId, userId, guildId, adapterId);
    if (blocker) return blocker;
    const classicChannels = this.classicChannels;
    if (!classicChannels) return t("classic.manager_unavailable");

    const instanceName = classicChannels.deriveInstanceName(channelName || channelId, channelId, adapterId);
    clearPausedMarker(this.getInstanceDir(instanceName));
    const selectedBackend = isSelectableClassicBackend(backend) ? backend : undefined;
    classicChannels.register(channelId, adapterId, instanceName, channelName || channelId, userId, selectedBackend);
    // Bind this classic instance to the bot that started it (authoritative), so
    // replies/cancel go out through that bot even though every same-guild bot
    // also sees the channel's messages.
    if (adapterId) this.bindInstanceAdapter(instanceName, adapterId);

    await this.startClassicInstance(
      instanceName,
      classicChannels.getBackend(channelId, adapterId, this.fleetConfig?.defaults?.backend),
      classicChannels.getPreTaskCommand(channelId, adapterId),
      classicChannels.getModel(channelId, adapterId, this.fleetConfig?.defaults?.model),
      classicChannels.getAutoPauseAfter(channelId, adapterId, this.fleetConfig?.defaults?.auto_pause_after),
    );
    this.reregisterClassicChannels();
    // Auto-enable collab for Discord classic channels (TG uses @mention directly without collab mode)
    if (guildId && !classicChannels.isCollab(channelId, adapterId)) {
      classicChannels.toggleCollab(channelId, adapterId);
    }
    this.logger.info({ channelId, adapterId, instanceName, userId }, "Classic channel started");
    return t("classic.started");
  }

  /** Handle /stop slash command — unregister classic channel */
  async handleClassicStop(channelId: string, adapterId?: string): Promise<string> {
    if (!this.classicChannels) return t("classic.manager_unavailable");
    const ch = this.classicChannels.unregister(channelId, adapterId);
    if (!ch) return t("classic.no_agent");

    this.instanceWorldBinding.delete(ch.instanceName);
    await this.stopInstance(ch.instanceName).catch(err =>
      this.logger.warn({ err, instanceName: ch.instanceName }, "Failed to stop classic instance"));
    clearPausedMarker(this.getInstanceDir(ch.instanceName));
    this.reregisterClassicChannels();
    this.logger.info({ channelId, adapterId, instanceName: ch.instanceName }, "Classic channel stopped");
    return t("classic.stopped");
  }

  /**
   * Idempotent while in flight: SIGINT and SIGTERM share one handler and the
   * uncaughtException path calls this too, so overlapping runs were possible —
   * each snapshotting the daemon map and calling stop() on the same daemons
   * concurrently. Deliberately NOT `async`, so callers receive the same promise
   * object rather than a fresh wrapper around it. The latch clears when the run
   * settles, so a later genuine stop (after a restart) still does the work.
   */
  stopAll(): Promise<void> {
    this.stopAllInFlight ??= this.doStopAll().finally(() => { this.stopAllInFlight = null; });
    return this.stopAllInFlight;
  }

  private stopAllInFlight: Promise<void> | null = null;

  private async doStopAll(): Promise<void> {
    this.startupComplete = false;
    this.reloadPending = false;
    // Before anything is stopped: everything that dies from here on dies
    // because we asked it to. Set synchronously — doStopAll runs to its first
    // await in the same tick as the signal handler, so no event can slip in.
    this.shuttingDown = true;
    this.ipcStoppingInstances.add("__fleet_stopping__");
    sdNotifyBlocking("STOPPING=1");
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
    // Cancel adapter retry timers
    for (const state of this.adapterState.values()) {
      if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = undefined; }
    }
    this.clearStatuslineWatchers();
    this.costGuard?.stop();
    this.dailySummary?.stop();
    this.dailyTipScheduler?.stop();
    this.dailyTipScheduler = null;
    if (this.updateCheckTimer) { clearTimeout(this.updateCheckTimer as any); clearInterval(this.updateCheckTimer as any); this.updateCheckTimer = null; }
    if (this.eventLogPruneTimer) { clearInterval(this.eventLogPruneTimer); this.eventLogPruneTimer = null; }
    if (this.logRotateTimer) { clearInterval(this.logRotateTimer); this.logRotateTimer = null; }
    // Cancel-button timers were never cleared here. The idle-check interval is not
    // unref'd, so it held the event loop open past shutdown and kept retrying
    // deletes against an adapter that was already gone.
    for (const entry of [...this.cancelButtons.values()]) {
      if (entry.retryTimer) clearTimeout(entry.retryTimer);
      if (entry.idleCheckTimer) clearInterval(entry.idleCheckTimer);
      if (entry.progressTimer) clearInterval(entry.progressTimer);
    }
    this.cancelButtons.clear();
    for (const timer of this.cancelButtonIdleRetireTimers.values()) clearTimeout(timer);
    this.cancelButtonIdleRetireTimers.clear();

    if (this.topicCleanupTimer) {
      clearInterval(this.topicCleanupTimer);
      this.topicCleanupTimer = null;
    }
    if (this.sessionPruneTimer) {
      clearInterval(this.sessionPruneTimer);
      this.sessionPruneTimer = null;
    }
    if (this.mirrorTimer) {
      clearTimeout(this.mirrorTimer);
      this.mirrorTimer = null;
      this.mirrorBuffer = [];
    }
    if (this.classicReloadTimer) {
      clearInterval(this.classicReloadTimer);
      this.classicReloadTimer = null;
    }
    for (const pending of this.pendingClassicStarts.values()) clearTimeout(pending.timer);
    this.pendingClassicStarts.clear();
    for (const pending of this.pendingNonceButtons.values()) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    this.pendingNonceButtons.clear();
    this.topicArchiver.stop();

    this.scheduler?.shutdown();

    // Stop instances in parallel batches to avoid long sequential waits.
    // Concurrency scales with fleet size — larger fleets tolerate more parallel
    // tmux ops, while small fleets stay conservative to avoid overwhelming the
    // tmux server.
    const entries = [...this.daemons.entries()];
    const STOP_CONCURRENCY = entries.length > 30 ? 15 : entries.length >= 10 ? 10 : 5;
    for (const [name] of entries) this.ipcStoppingInstances.add(name);
    for (let i = 0; i < entries.length; i += STOP_CONCURRENCY) {
      const batch = entries.slice(i, i + STOP_CONCURRENCY);
      await Promise.all(batch.map(async ([name, daemon]) => {
        try {
          await daemon.stop();
        } catch (err) {
          this.logger.warn({ name, err }, "Stop failed");
        }
        this.daemons.delete(name);
      }));
    }

    // Close IPC clients in parallel — serial close over a large fleet adds
    // noticeable latency.
    await Promise.all([...this.instanceIpcClients.values()].map(ipc =>
      Promise.resolve(ipc.close()).catch(() => { /* best effort */ })));
    this.instanceIpcClients.clear();
    this.ipcStoppingInstances.clear();

    for (const [, w] of this.worlds) {
      await w.stop().catch(() => {});
    }
    this.adapter = null;
    this.worlds.clear();
    (this.adapters as Map<string, ChannelAdapter>).clear();

    this.controlClient?.stop();
    this.controlClient = null;

    if (this.healthServer) {
      this.healthServerListening = false;
      this.healthServer.close();
      this.healthServer = null;
    }

    this.eventLog?.close();

    const pidPath = join(this.dataDir, "fleet.pid");
    try { unlinkSync(pidPath); } catch (e) { this.logger.debug({ err: e }, "Failed to remove fleet PID file"); }
    // The lock contains a nonce, so an older/shutting-down process can never
    // remove a lock acquired by a newer fleet owner.
    releaseProcessFleetLock();
  }

  /**
   * Prune stale external sessions by re-querying each daemon for live sessions.
   * Sessions in the registry that are no longer reported by any daemon are removed.
   */
  async pruneStaleExternalSessions(): Promise<number> {
    const liveSessions = new Set<string>();

    // Ask each daemon for its currently connected external sessions
    const queries = [...this.instanceIpcClients.entries()].map(([_name, ipc]) => {
      if (!ipc.connected) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          ipc.removeListener("message", handler);
          resolve();
        };
        const handler = (msg: Record<string, unknown>) => {
          if (msg.type !== "query_sessions_response") return;
          for (const s of msg.sessions as string[]) liveSessions.add(s);
          finish();
        };
        const timeout = setTimeout(finish, 5000);
        ipc.on("message", handler);
        ipc.send({ type: "query_sessions" });
      });
    });

    await Promise.all(queries);

    // Remove sessions not found in any daemon
    let pruned = 0;
    for (const [sessionName] of this.sessionRegistry) {
      if (!liveSessions.has(sessionName)) {
        this.sessionRegistry.delete(sessionName);
        this.logger.info({ sessionName }, "Pruned stale external session");
        pruned++;
      }
    }
    if (pruned > 0) {
      this.logger.info({ pruned, remaining: this.sessionRegistry.size }, "Session registry pruned");
    }
    return pruned;
  }

  /**
   * Graceful shutdown for full reload: wait for idle, notify, then stop everything.
   * The caller is expected to exit the process after this resolves.
   */
  async gracefulShutdownForReload(): Promise<void> {
    const instanceNames = [...this.daemons.keys()];
    if (instanceNames.length === 0) {
      this.logger.info("No instances to stop");
      await this.stopAll();
      return;
    }

    this.logger.info(`Full restart: waiting for ${instanceNames.length} instances to idle...`);

    const groupId = this.fleetConfig?.channel?.group_id;
    if (groupId && this.adapter) {
      await this.adapter.sendText(String(groupId), t("restart.full_initiated"))
        .catch(e => this.logger.warn({ err: e }, "Failed to post full restart notification"));
    }

    // Wait for idle with 5-minute timeout
    const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const idleDeadline = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error("Idle wait timed out after 5 minutes")), IDLE_TIMEOUT_MS);
    });

    try {
      await Promise.race([
        Promise.all(
          instanceNames.map(async (name) => {
            const daemon = this.daemons.get(name);
            if (daemon) {
              this.logger.info(`Waiting for ${name} to idle...`);
              await daemon.waitForIdle(10_000);
              this.logger.info(`${name} is idle`);
            }
          })
        ),
        idleDeadline,
      ]);
    } catch (err) {
      this.logger.warn({ err }, "Idle wait timed out — force stopping");
    } finally {
      clearTimeout(timeoutHandle!);
    }

    this.logger.info("All instances idle — stopping for reload...");
    await this.stopAll();

    // Clean up tmux session if no foreign windows remain
    try {
      const remaining = await TmuxManager.listWindows(getTmuxSession());
      if (remaining.length <= 1) {
        await TmuxManager.killSession(getTmuxSession());
        this.logger.info("Killed tmux session (clean)");
      } else {
        this.logger.warn({ remaining: remaining.map(w => w.name) }, "Windows remain after stopAll — skipping session kill");
      }
    } catch (err) {
      this.logger.debug({ err }, "Exit tmux session cleanup failed (best effort)");
    }
  }

  /**
   * Graceful restart: wait for all instances to be idle, then stop and start them.
   */
  /**
   * Hot-reload: re-read fleet.yaml and reconcile running instances.
   * Starts new, stops removed, restarts modified instances.
   * Whitelisted runtime fields are pushed into live daemons; all other instance
   * fields, plus cold fleet-level settings, retain restart semantics.
   */
  private async reconcileInstances(): Promise<void> {
    if (!this.configPath) return;
    const oldConfig = this.fleetConfig;
    const previousRawConfig = this.rawFleetConfig;
    const previousRawDocument = this.rawFleetDocument;
    const previousSavedSnapshot = this.savedFleetConfigSnapshot;

    try {
      this.loadConfig(this.configPath);
    } catch (err) {
      this.fleetConfig = oldConfig;
      this.rawFleetConfig = previousRawConfig;
      this.rawFleetDocument = previousRawDocument;
      this.savedFleetConfigSnapshot = previousSavedSnapshot;
      throw err;
    }

    const validation = validateFleetConfig(this.rawFleetConfig);
    const oldCount = Object.keys(oldConfig?.instances ?? {}).length;
    const newCount = Object.keys(this.fleetConfig?.instances ?? {}).length;
    const removedRatio = oldCount > 0 && newCount < oldCount
      ? (oldCount - newCount) / oldCount
      : 0;
    const unsafeEmpty = oldCount > 0 && newCount === 0;
    const unsafeBulkRemoval = removedRatio > 0.5;

    if (!validation.valid || unsafeEmpty || unsafeBulkRemoval) {
      this.fleetConfig = oldConfig;
      this.rawFleetConfig = previousRawConfig;
      this.rawFleetDocument = previousRawDocument;
      this.savedFleetConfigSnapshot = previousSavedSnapshot;
      this.logger.error({
        oldCount,
        newCount,
        removedRatio,
        validationErrors: validation.errors,
      }, "Refusing unsafe fleet config reload; running configuration was kept");
      // Tell the operator. A silently ignored config edit is the most confusing
      // possible outcome: they change fleet.yaml, send SIGHUP, and nothing happens
      // with no explanation anywhere they are looking.
      const why = !validation.valid
        ? t("fleet.reload_validation", validation.errors.map(e => `• ${e.path}: ${e.message}`).join("\n"))
        : unsafeEmpty
          ? t("fleet.reload_removed_all", oldCount)
          : t("fleet.reload_removed_half", oldCount, newCount);
      this.notifyFleetError(t("fleet.reload_rejected", why));
      return;
    }

    this.routing.rebuild(this.fleetConfig!);
    this.reregisterClassicChannels();
    this.scheduler?.reload();

    const newInstances = this.fleetConfig!.instances;
    const topicMode = this.fleetConfig?.channel?.mode === "topic";

    // Detect fleet-level changes which still need a restart. Hot defaults are
    // reconciled below and must not produce a misleading restart warning.
    const oldDefaultColdWithFleetFields = oldConfig?.defaults
      ? splitHotColdConfig(oldConfig.defaults as InstanceConfig).cold
      : {};
    const newDefaultColdWithFleetFields = this.fleetConfig?.defaults
      ? splitHotColdConfig(this.fleetConfig.defaults as InstanceConfig).cold
      : {};
    // `tips` is a fleet-owned hot switch; it is read at post time and never
    // belongs in a daemon config or a "restart required" warning.
    const { tips: _oldTips, ...oldDefaultCold } = oldDefaultColdWithFleetFields as Record<string, unknown>;
    const { tips: _newTips, ...newDefaultCold } = newDefaultColdWithFleetFields as Record<string, unknown>;
    const oldFleetLevel = JSON.stringify({ channel: oldConfig?.channel, defaults: oldDefaultCold });
    const newFleetLevel = JSON.stringify({ channel: this.fleetConfig?.channel, defaults: newDefaultCold });
    if (oldFleetLevel !== newFleetLevel) {
      this.logger.warn("Fleet-level config changed (channel/defaults) — use /restart for full effect");
    }

    // Stop removed instances (skip classic bot instances — they're managed by classicBot.yaml)
    const classicNames = new Set(this.classicChannels?.getAll().map(ch => ch.instanceName) ?? []);
    for (const name of this.daemons.keys()) {
      if (!(name in newInstances) && !classicNames.has(name)) {
        this.logger.info({ name }, "Instance removed from config — stopping");
        await this.stopInstance(name).catch(err =>
          this.logger.error({ err, name }, "Failed to stop removed instance"));
      }
    }

    // Start new + reconcile modified instances. Hot values are always sent as a
    // complete snapshot: Settings mutates FleetManager's config before SIGHUP,
    // so an old/new diff alone can miss the live daemon's stale value.
    for (const [name, config] of Object.entries(newInstances)) {
      if (!this.daemons.has(name)) {
        // New instance — startInstance already calls connectIpcToInstance
        this.logger.info({ name }, "New instance in config — starting");
        await this.startInstance(name, config, topicMode).catch(err =>
          this.logger.error({ err, name }, "Failed to start new instance"));
      } else if (oldConfig?.instances[name]) {
        const daemon = this.daemons.get(name)!;
        const runtimeConfig = daemon.getConfigSnapshot?.() ?? oldConfig.instances[name];
        const oldParts = splitHotColdConfig(runtimeConfig);
        const newParts = splitHotColdConfig(config);
        // Every field not explicitly classified hot is cold by default.
        if (!isDeepStrictEqual(oldParts.cold, newParts.cold)) {
          this.logger.info({ name }, "Instance config changed — restarting");
          await this.stopInstance(name).catch(() => {});
          await this.startInstance(name, config, topicMode).catch(err =>
            this.logger.error({ err, name }, "Failed to restart modified instance"));
        } else if (!isDeepStrictEqual(oldParts.hot, newParts.hot)) {
          const update = hotConfigUpdate(config);
          const ipc = this.instanceIpcClients.get(name);
          const sent = ipc?.connected === true && ipc.send({ type: "config_update", config: update });
          if (!sent) {
            // Daemon is in-process, so a reconnect gap must not leave runtime
            // state stale. Normal operation still uses the explicit IPC contract.
            daemon.applyConfigUpdate(update);
            this.logger.warn({ name }, "Config-update IPC unavailable — applied hot config in-process");
          }
          this.logger.info({ name, fields: [...HOT_INSTANCE_CONFIG_KEYS] }, "Instance hot config reloaded");
        }
      }
    }

    // warm_cap is fleet-owned; enforce the reloaded value immediately against
    // currently idle instances instead of waiting for a future state edge.
    this.enforceWarmCap();

    this.logger.info({ running: this.daemons.size, configured: Object.keys(newInstances).length }, "Reconcile complete");
  }

  async restartInstances(): Promise<void> {
    if (!this.configPath) {
      this.logger.error("Cannot restart: no config path (was startAll called?)");
      return;
    }
    const instanceNames = [...this.daemons.keys()];
    if (instanceNames.length === 0) {
      this.logger.info("No instances to restart");
      return;
    }

    this.logger.info(`Graceful restart: waiting for ${instanceNames.length} instances to idle...`);

    const groupId = this.fleetConfig?.channel?.group_id;
    const generalName = this.findGeneralInstance();
    const generalThreadId = generalName ? this.fleetConfig?.instances[generalName]?.topic_id : undefined;
    const notifyOpts = { threadId: generalThreadId != null ? String(generalThreadId) : undefined };
    if (groupId && this.adapter) {
      await this.adapter.sendText(String(groupId), t("restart.graceful_initiated"), notifyOpts)
        .catch(e => this.logger.warn({ err: e }, "Failed to post restart notification"));
    }

    const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const idleDeadline = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error("Idle wait timed out after 5 minutes")), IDLE_TIMEOUT_MS);
    });

    try {
      await Promise.race([
        Promise.all(
          instanceNames.map(async (name) => {
            const daemon = this.daemons.get(name);
            if (daemon) {
              this.logger.info(`Waiting for ${name} to idle...`);
              await daemon.waitForIdle(10_000);
              this.logger.info(`${name} is idle`);
            }
          })
        ),
        idleDeadline,
      ]);
    } catch (err) {
      this.logger.warn({ err }, "Idle wait timed out — force restarting");
    } finally {
      clearTimeout(timeoutHandle!);
    }

    this.logger.info("All instances idle — restarting...");
    const restartStartedAt = Date.now();
    // Capture the live adapter/topic before General's daemon is stopped. The
    // channel adapter remains connected throughout an in-process restart.
    const progressTarget = this.restartProgressTarget();

    this.clearStatuslineWatchers();

    for (const [, ipc] of this.instanceIpcClients) {
      await ipc.close();
    }
    this.instanceIpcClients.clear();

    await Promise.allSettled(
      instanceNames.map(name => this.stopInstance(name))
    );

    // Kill remaining orphan windows to prevent stale state on restart
    try {
      const agendNames = new Set(instanceNames);
      agendNames.add("general");
      const existingWindows = await TmuxManager.listWindows(getTmuxSession());
      for (const w of existingWindows) {
        if (agendNames.has(w.name)) {
          const tm = new TmuxManager(getTmuxSession(), w.id);
          await tm.killWindow();
        }
      }
    } catch (err) {
      this.logger.debug({ err }, "Restart tmux window cleanup failed (best effort)");
    }

    const fleet = this.loadConfig(this.configPath);
    this.fleetConfig = fleet;
    const topicMode = fleet.channel?.mode === "topic" || !!fleet.channels?.some(ch => ch.mode === "topic");
    const restartProgress = new RestartProgress(
      this.runnableStartupCount(fleet, topicMode),
      restartStartedAt,
      this.logger,
    );

    // Phase 1: generals first
    const restartEntries = Object.entries(fleet.instances);
    const restartGenerals = restartEntries.filter(([_, cfg]) => cfg.general_topic);
    const restartOthers = restartEntries.filter(([_, cfg]) => !cfg.general_topic);
    for (const [name, cfg] of restartGenerals) {
      try {
        await this.startInstance(name, cfg, topicMode);
        if (this.daemons.has(name)) restartProgress.markReady();
      } catch (err) {
        this.logger.error({ err, name }, "Failed to start general instance");
      }
    }
    // General is ready again; now its topic can own the live progress message.
    await restartProgress.start(progressTarget);
    if (restartOthers.length > 0) {
      await this.startInstancesWithConcurrency(restartOthers, topicMode, () => restartProgress.markReady());
    }

    if (topicMode) {
      this.routing.rebuild(this.fleetConfig!);
      this.reregisterClassicChannels();
      // startInstance already calls connectIpcToInstance, no need for connectToInstances here

      // Restart classic channel instances (killed during orphan cleanup)
      if (this.classicChannels) {
        const fleetBackend = this.fleetConfig?.defaults?.backend;
        const channels = this.classicChannels.getAll()
          .filter(ch => !this.lifecycle.isPaused(ch.instanceName));
        const concurrency = 3;
        let idx = 0;
        while (idx < channels.length) {
          const batch = channels.slice(idx, idx + concurrency);
          await Promise.allSettled(batch.map(async ch => {
            try {
              await this.startClassicInstance(
                ch.instanceName,
                this.classicChannels!.getBackendByInstance(ch.instanceName, fleetBackend),
                this.classicChannels!.getPreTaskCommand(ch.channelId, ch.adapterId),
                this.classicChannels!.getModel(ch.channelId, ch.adapterId, this.fleetConfig?.defaults?.model),
                this.classicChannels!.getAutoPauseAfter(ch.channelId, ch.adapterId, this.fleetConfig?.defaults?.auto_pause_after),
              );
              if (this.daemons.has(ch.instanceName)) restartProgress.markReady();
            } catch (err) {
              this.logger.warn({ err, instanceName: ch.instanceName }, "Failed to start classic instance");
            }
          }));
          idx += concurrency;
        }
      }

      for (const name of Object.keys(fleet.instances)) {
        this.startStatuslineWatcher(name);
      }
    }

    this.logger.info("Graceful restart complete");
    const configuredNames = this.configuredStartupInstanceNames(fleet, topicMode);
    const total = configuredNames.length;
    const started = configuredNames.filter(name => this.daemons.has(name)).length;
    const allNotRunning2 = configuredNames.filter(name => !this.daemons.has(name));
    const pausedNames2 = allNotRunning2.filter(n => this.lifecycle.isPaused(n));
    const failedNames = allNotRunning2.filter(n => !this.lifecycle.isPaused(n));
    const { createRequire } = await import("node:module");
    const _require2 = createRequire(import.meta.url);
    const agendVersion2 = _require2("../package.json").version ?? "unknown";
    const progressCompleted = await restartProgress.finish({
      running: started,
      total,
      version: agendVersion2,
      pausedNames: pausedNames2,
      failedNames,
    });
    if (groupId && this.adapter) {
      let restartText: string;
      if (failedNames.length === 0 && pausedNames2.length === 0) {
        restartText = t("fleet.ready", started, total, agendVersion2);
      } else if (failedNames.length === 0) {
        restartText = t("fleet.ready", started, total, agendVersion2) + `\n⏸ Paused: ${pausedNames2.join(", ")}`;
      } else {
        restartText = t("fleet.ready_with_failed", started, total, agendVersion2, failedNames.join(", "))
          + (pausedNames2.length > 0 ? `\n⏸ Paused: ${pausedNames2.join(", ")}` : "");
      }
      if (!progressCompleted) {
        await this.adapter.sendText(String(groupId), restartText, notifyOpts)
          .catch(e => this.logger.warn({ err: e }, "Failed to post restart completion notification"));
      }

      // Notify each instance's channel — staggered to avoid rate limit storm
      const instances = Object.entries(this.fleetConfig?.instances ?? {});
      this.logger.info({ count: instances.length }, "Sending restart notification to instances (staggered)");
      const BATCH_SIZE = 3;
      const BATCH_DELAY_MS = 2500;
      for (let i = 0; i < instances.length; i += BATCH_SIZE) {
        if (i > 0) await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
        const batch = instances.slice(i, i + BATCH_SIZE);
        for (const [name, config] of batch) {
          const threadId = config.topic_id != null ? String(config.topic_id) : undefined;
          const daemon = this.daemons.get(name);
          const isNewSession = daemon?.isNewSession ?? false;
          const msg = isNewSession
            ? "Fleet restart complete. Configuration changed — starting fresh session."
            : "Fleet restart complete. Continue from where you left off.";

          if (threadId) {
            this.adapter.sendText(String(groupId), msg, { threadId })
              .catch(e => this.logger.warn({ err: e, name, threadId }, "Failed to post per-instance restart notification"));
          }

          const ipc = this.instanceIpcClients.get(name);
          if (ipc?.connected) {
            ipc.send({
              type: "fleet_inbound",
              content: msg,
              meta: {
                chat_id: String(groupId),
                thread_id: threadId ?? "",
                ts: new Date().toISOString(),
              },
            });
          }
        }
      }
    }
  }

  // ── Update check ────────────────────────────────────────────────────

  private async checkForUpdates(): Promise<void> {
    try {
      // Both npm lookups are async: as execSync they froze the fleet event loop for
      // up to 15s each, and on a beta build BOTH ran — 30s with no WATCHDOG ping,
      // past WatchdogSec's half-interval and enough for systemd to SIGABRT the fleet
      // for a background version check.
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileP = promisify(execFile);
      const npmVersion = async (spec: string): Promise<string> => {
        const { stdout } = await execFileP("npm", ["view", spec, "version"], { timeout: 15_000 });
        return stdout.toString().trim();
      };
      const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
      const currentVersion = JSON.parse(readFileSync(pkgPath, "utf-8")).version ?? "0.0.0";
      const latest = await npmVersion("@songsid/agend");
      let target = latest;
      if (currentVersion.includes("-beta")) {
        // Beta users track the @beta channel (never fall back to @latest, which is
        // older), but should also hear when a newer STABLE ships — pick whichever
        // of beta/latest is the newest.
        let beta = "";
        try {
          beta = await npmVersion("@songsid/agend@beta");
        } catch { /* no beta tag */ }
        target = beta || latest;
        if (latest && this.semverGt(latest, target)) target = latest;
      }
      // A beta already at/ahead of its matching stable must NOT be told to
      // "update" to that stable — e.g. 2.0.11-beta.41 already contains everything
      // in stable 2.0.11, so semverGt(2.0.11, 2.0.11-beta.41) being true (a stable
      // outranks a prerelease of the same core) is a false positive here. Suppress
      // only that same-core stable-vs-my-beta case; a higher stable core (2.0.12)
      // or a newer beta (2.0.11-beta.50) still notifies via semverGt below.
      const core = (v: string) => v.replace(/^v/, "").split("-")[0];
      const betaSupersedesStable =
        currentVersion.includes("-") && !target.includes("-") && core(target) === core(currentVersion);
      // Only notify when target is genuinely newer (semver), so a beta user on
      // 2.0.8-beta.16 is never told that stable 2.0.7 is "available".
      if (target && !betaSupersedesStable && this.semverGt(target, currentVersion)) {
        const generalId = this.findGeneralInstance();
        if (generalId) {
          // No release URL — Discord's SuppressEmbeds proved unreliable and the
          // link preview looked bad. Version + /update instruction is enough.
          this.notifyInstanceTopic(generalId, t("update.available_current", `v${target}`, `v${currentVersion}`));
        }
      }
    } catch { /* silent — network issues */ }
  }

  /**
   * Semver "a > b". Compares major.minor.patch numerically; a version without a
   * prerelease outranks the same core with one (2.0.8 > 2.0.8-beta.16); two
   * prereleases compare identifier-by-identifier (numeric < alphanumeric, numeric
   * fields compared as numbers). Sufficient for our X.Y.Z[-beta.N] scheme.
   */
  private semverGt(a: string, b: string): boolean {
    const parse = (v: string) => {
      const [core, pre] = v.replace(/^v/, "").split("-");
      const nums = core.split(".").map(n => parseInt(n, 10) || 0);
      return { nums: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0], pre: pre ? pre.split(".") : [] };
    };
    const pa = parse(a), pb = parse(b);
    for (let i = 0; i < 3; i++) {
      if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i];
    }
    if (pa.pre.length === 0 && pb.pre.length === 0) return false;
    if (pa.pre.length === 0) return true;   // a stable, b prerelease → a > b
    if (pb.pre.length === 0) return false;  // a prerelease, b stable → a < b
    const len = Math.max(pa.pre.length, pb.pre.length);
    for (let i = 0; i < len; i++) {
      const x = pa.pre[i], y = pb.pre[i];
      if (x === undefined) return false; // a has fewer identifiers → a < b
      if (y === undefined) return true;  // a has more identifiers → a > b
      const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
      if (xn && yn) { const dx = parseInt(x, 10), dy = parseInt(y, 10); if (dx !== dy) return dx > dy; }
      else if (xn !== yn) return yn;     // numeric has lower precedence than alphanumeric
      else if (x !== y) return x > y;    // both alphanumeric
    }
    return false; // identical
  }

  // ── Health HTTP endpoint ─────────────────────────────────────────────

  private startHealthServer(port: number): void {
    this.startedAt = Date.now();
    this.healthServerListening = false;
    this.healthPortRetried = false;
    // Defensive for direct/unit callers; normal startup initializes these before adapters.
    if (!this.webToken || !this.viewToken) this.initializeWebAuthTokens();

    this.healthServer = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      const requestPath = new URL(req.url ?? "/", `http://localhost:${port}`).pathname;

      // Browsers request this automatically and AgEnD does not ship an icon.
      // It is neither user data nor an API route, so do not turn the harmless
      // probe into a noisy web-token 401 in the browser console.
      if (req.method === "GET" && requestPath === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Public health probe — no auth required.
      if (req.method === "GET" && req.url === "/health") {
        // fallthrough to existing handler below
      } else if (req.method === "POST" && req.url === "/agent") {
        // /agent handles its own instance-level auth via X-Agend-Instance-Token
      } else if (isViewPath(new URL(req.url ?? "/", `http://localhost:${port}`).pathname)) {
        // /view routes accept the read-only view.token (or web.token) and do
        // their own per-method auth in view-api.ts — skip the web-token gate.
      } else if (isUsagePath(new URL(req.url ?? "/", `http://localhost:${port}`).pathname)) {
        // /api/ai-usage is read-only GET data for the /view Usage panel — open
        // like the other /view data routes (usage-api.ts rejects non-GET).
      } else {
        // All other endpoints require a valid token (query ?token= or X-Agend-Token header).
        // /ui/* will also re-check in web-api.ts, which is harmless.
        const parsedUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
        const headerToken = req.headers["x-agend-token"];
        const providedToken = parsedUrl.searchParams.get("token")
          ?? (typeof headerToken === "string" ? headerToken : null);
        if (!this.webToken || providedToken !== this.webToken) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: WEB_TOKEN_INVALID_MESSAGE }));
          return;
        }
      }

      if (req.method === "GET" && req.url === "/health") {
        const health = this.getFleetHealth();
        // 503 when the fleet cannot do its job, so an external monitor sees it.
        // This used to always answer 200 "ok" with a count of CONFIGURED instances,
        // so every agent could be dead and every adapter down and it still looked
        // green.
        res.writeHead(health.status === "ok" ? 200 : 503);
        res.end(JSON.stringify(health));
        return;
      }

      if (req.method === "GET" && req.url === "/status") {
        const instances = Object.keys(this.fleetConfig?.instances ?? {}).map(name => {
          const statusFile = join(this.getInstanceDir(name), "statusline.json");
          let cost = 0;
          try {
            const data = JSON.parse(readFileSync(statusFile, "utf-8"));
            cost = data.cost?.total_cost_usd ?? 0;
          } catch (err) {
            this.logger.debug({ err, name }, "statusline.json read failed (/status)");
          }
          const backend = this.fleetConfig?.instances[name]?.backend
            ?? this.fleetConfig?.defaults?.backend
            ?? "claude-code";
          const { context } = resolveInstanceContext(this.dataDir, name, backend);
          return {
            name,
            status: this.getInstanceStatus(name),
            context_pct: context ?? 0,
            cost,
          };
        });
        res.writeHead(200);
        res.end(JSON.stringify({ instances }));
        return;
      }

      // Fleet API (enriched for agent board)
      if (req.method === "GET" && req.url === "/api/fleet") {
        const sysInfo = this.getSysInfo();
        const fleetInstances = sysInfo.instances.map(inst => ({ ...inst, classic: false }));
        const fleetNames = new Set(fleetInstances.map(inst => inst.name));
        const classicInstances = (this.classicChannels?.getAll() ?? [])
          .filter(channel => !fleetNames.has(channel.instanceName))
          .map(channel => ({
            name: channel.instanceName,
            status: this.getInstanceStatus(channel.instanceName),
            state: this.getInstanceExecutionState(channel.instanceName),
            ipc: this.instanceIpcClients.has(channel.instanceName),
            costCents: this.costGuard?.getDailyCostCents(channel.instanceName) ?? 0,
            rateLimits: this.statuslineWatcher.getRateLimits(channel.instanceName) ?? null,
            classic: true,
            classicName: channel.name,
            channelId: channel.channelId,
            adapterId: channel.adapterId ?? null,
          }));
        const enriched = [...fleetInstances, ...classicInstances].map(inst => {
          const config = this.fleetConfig?.instances[inst.name];
          const persistedInboundAt = readLastInboundAt(this.getInstanceDir(inst.name));
          const lastActivity = inst.classic
            ? Math.max(persistedInboundAt ?? 0, readClassicLastActivityAt(this.dataDir, inst.name) ?? 0) || null
            : (persistedInboundAt ?? this.lastActivityMs(inst.name)) || null;
          const backend = this.backendNameForInstance(inst.name);
          const resolvedModel = this.resolveInstanceModel(inst.name);
          const effortStrategy = this.effortStrategyFor(inst.name);
          const resolvedEffort = this.resolveInstanceEffort(inst.name);
          // Find claimed tasks for this instance
          let currentTask: string | null = null;
          try {
            const tasks = this.scheduler?.db.listTasks({ assignee: inst.name, status: "claimed" });
            if (tasks?.length) currentTask = tasks[0].title;
          } catch (err) {
            this.logger.debug({ err, name: inst.name }, "Scheduler listTasks failed (/api/fleet)");
          }
          return {
            ...inst,
            description: config?.description ?? ("classicName" in inst ? inst.classicName : null),
            backend,
            // Settings renders these runtime-effective values rather than the
            // sparse user-authored YAML. `auto` means the supported CLI is
            // using its own effort default; null is reserved for unsupported.
            model: resolvedModel.model,
            model_display: resolvedModel.display,
            model_source: resolvedModel.source,
            effort: effortStrategy === "unsupported" ? null : (resolvedEffort.effort ?? "auto"),
            effort_supported: effortStrategy !== "unsupported",
            tool_set: config?.tool_set ?? "full",
            general_topic: config?.general_topic ?? false,
            // User activity is persisted by the daemon, so both the board and
            // auto-pause retain an accurate age across fleet restarts.
            lastActivity,
            currentTask,
            idle: this.getInstanceIdle(inst.name),
            state: this.getInstanceExecutionState(inst.name),
          };
        });
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.writeHead(200);
        res.end(JSON.stringify({
          ...sysInfo,
          version: this.currentVersion,
          instances: enriched,
        }));
        return;
      }

      // Activity API
      if (req.method === "GET" && req.url?.startsWith("/api/activity")) {
        const url = new URL(req.url, `http://localhost:${port}`);
        const sinceParam = url.searchParams.get("since") ?? "2h";
        const limitParam = url.searchParams.get("limit") ?? "500";

        const match = sinceParam.match(/^(\d+)(m|h|d)$/);
        let sinceIso: string | undefined;
        if (match) {
          const val = parseInt(match[1], 10);
          const unit = match[2] === "d" ? 86400000 : match[2] === "h" ? 3600000 : 60000;
          sinceIso = new Date(Date.now() - val * unit).toISOString();
        }

        const rows = this.eventLog?.listActivity({ since: sinceIso, limit: parseInt(limitParam, 10) }) ?? [];
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.writeHead(200);
        res.end(JSON.stringify(rows));
        return;
      }

      // Activity viewer
      if (req.method === "GET" && (req.url === "/activity" || req.url === "/activity/")) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.writeHead(200);
        res.end(ACTIVITY_VIEWER_HTML);
        return;
      }

      // Instance start via API
      if (req.method === "POST" && req.url?.startsWith("/api/instance/") && req.url.endsWith("/start")) {
        const name = decodeURIComponent(req.url.slice("/api/instance/".length, -"/start".length));
        const config = this.fleetConfig?.instances[name];
        if (!config) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `Instance not found: ${name}` }));
          return;
        }
        (async () => {
          try {
            const topicMode = this.fleetConfig?.channel?.mode === "topic";
            await this.startInstance(name, config, topicMode ?? false, "fleet-topic", true);
            this.emitSseEvent("status", this.getUiStatus());
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: `Start failed: ${(err as Error).message}` }));
          }
          // The inner catch can itself throw (writeHead after a successful
          // writeHead is ERR_HTTP_HEADERS_SENT), and that rejection escapes the
          // IIFE. Same for the two handlers below.
        })().catch(err => this.logger.error({ err, name }, "HTTP start handler failed"));
        return;
      }

      // Instance restart (immediate, no idle wait)
      if (req.method === "POST" && req.url?.startsWith("/restart/")) {
        const name = decodeURIComponent(req.url.slice("/restart/".length));
        this.logger.info({ name }, "Instance restart requested via HTTP");
        (async () => {
          try {
            await this.restartSingleInstance(name);
            this.logger.info({ name }, "Instance restarted");
            this.emitSseEvent("status", this.getUiStatus());
            res.writeHead(200);
            res.end(JSON.stringify({ restarted: name }));
          } catch (err) {
            this.logger.error({ err, name }, "Instance restart failed");
            const status = (err as Error).message.includes("not found") ? 404 : 500;
            res.writeHead(status);
            res.end(JSON.stringify({ error: `Restart failed: ${(err as Error).message}` }));
          }
        })().catch(err => this.logger.error({ err, name }, "HTTP restart handler failed"));
        return;
      }

      if (req.method === "POST" && req.url?.startsWith("/stop/")) {
        const name = decodeURIComponent(req.url.slice("/stop/".length));
        this.logger.info({ name }, "Instance stop requested via HTTP");
        (async () => {
          try {
            // Runs inside the live fleet process: lifecycle.stop finds the
            // in-memory daemon and stops just this instance. (Doing this from a
            // detached CLI FleetManager would read the shared daemon.pid — the
            // fleet's own pid — and kill the whole fleet.)
            await this.stopInstance(name);
            this.logger.info({ name }, "Instance stopped");
            this.emitSseEvent("status", this.getUiStatus());
            res.writeHead(200);
            res.end(JSON.stringify({ stopped: name }));
          } catch (err) {
            this.logger.error({ err, name }, "Instance stop failed");
            res.writeHead(500);
            res.end(JSON.stringify({ error: `Stop failed: ${(err as Error).message}` }));
          }
        })().catch(err => this.logger.error({ err, name }, "HTTP stop handler failed"));
        return;
      }

      // ── Agent CLI endpoint ─────
      if (req.url === "/agent" && req.method === "POST") {
        handleAgentRequest(req, res, this as unknown as import("./agent-endpoint.js").AgentEndpointContext);
        return;
      }

      // ── Web UI endpoints (delegated to web-api.ts) ─────

      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (handleViewRequest(req, res, url, this as unknown as import("./view-api.js").ViewApiContext)) return;
      if (handleUsageRequest(req, res, url, this as unknown as import("./usage/usage-api.js").UsageApiContext)) return;
      if (handleSettingsRequest(req, res, url, this as unknown as import("./settings-api.js").SettingsApiContext)) return;
      if (handleWebRequest(req, res, url, this as unknown as import("./web-api.js").WebApiContext)) return;

      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found" }));
    });

    const markListening = (afterTakeover = false): void => {
      this.healthServerListening = true;
      this.logger.info({ port }, afterTakeover
        ? "Health endpoint listening (after takeover)"
        : "Health endpoint listening");
      this.logger.info({ url: `http://localhost:${port}/ui?token=${this.webToken}` }, "Web UI available");
      this.logger.info({ url: `http://localhost:${port}/view?token=${this.viewToken}` }, "Web View available");
    };

    this.healthServer.on("error", (err: NodeJS.ErrnoException) => {
      this.healthServerListening = false;
      if (err.code === "EADDRINUSE") {
        if (this.healthPortRetried) {
          this.logger.error({ err, port }, "Health port still in use after takeover — dashboard disabled");
          this.notifyFleetError(t("dashboard.port_in_use", port));
          return;
        }
        this.healthPortRetried = true;
        this.logger.warn({ port }, "Health port in use — attempting takeover");
        const pidPath = join(this.dataDir, "fleet.pid");
        try {
          if (existsSync(pidPath)) {
            const oldPid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
            if (oldPid && oldPid !== process.pid) {
              process.kill(oldPid, "SIGTERM");
              this.logger.info({ oldPid }, "Killed old fleet process");
            }
          }
        } catch (err) {
          this.logger.debug({ err }, "Old fleet process kill skipped (already gone or no permission)");
        }
        setTimeout(() => {
          if (!this.healthServer) return;
          this.healthServer.listen(port, "127.0.0.1", () => markListening(true));
        }, 1500);
        return;
      }
      this.logger.error({ err, port }, "Health server error");
      this.notifyFleetError(t("dashboard.server_failed", err.message));
    });

    this.healthServer.listen(port, "127.0.0.1", () => markListening());
  }

  getUiStatus(): unknown {
    const fleetNames = Object.keys(this.fleetConfig?.instances ?? {});
    // Classic rooms live only in classicBot.yaml — /api/profiles merges them into
    // the View roster, but previously getUiStatus skipped them so context_pct was
    // always 0 (live map miss → l?.context_pct ?? 0).
    const classicOnly = (this.classicChannels?.getAll() ?? [])
      .map(ch => ch.instanceName)
      .filter(name => !fleetNames.includes(name));
    const names = [...fleetNames, ...classicOnly];

    const instances = names.map(name => {
      const statusFile = join(this.getInstanceDir(name), "statusline.json");
      let cost = 0;
      let model = "";
      try {
        const data = JSON.parse(readFileSync(statusFile, "utf-8"));
        cost = data.cost?.total_cost_usd ?? 0;
        model = data.model?.display_name ?? "";
      } catch (err) {
        this.logger.debug({ err, name }, "statusline.json read failed (getUiStatus)");
      }
      // Align with /ctx: statusline for claude-code, pane scrape for kiro/grok/codex.
      const classic = classicOnly.includes(name);
      const backend = classic
        ? this.classicChannels!.getBackendByInstance(name, this.fleetConfig?.defaults?.backend)
        : (this.fleetConfig?.instances[name]?.backend
          ?? this.fleetConfig?.defaults?.backend
          ?? "claude-code");
      const { context } = resolveInstanceContext(this.dataDir, name, backend);
      const context_pct = context ?? 0;
      return { name, status: this.getInstanceStatus(name), context_pct, cost, model };
    });
    return {
      instances,
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }
}

const ACTIVITY_VIEWER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgEnD Activity Viewer</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace; }
  .header { padding: 16px 24px; border-bottom: 1px solid #21262d; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .header h1 { font-size: 18px; color: #58a6ff; font-weight: 600; }
  .controls { display: flex; gap: 8px; align-items: center; }
  .controls select, .controls button { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 4px 10px; font-size: 13px; cursor: pointer; }
  .controls button.active { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  .controls button:hover { border-color: #58a6ff; }
  .speed-group { display: flex; gap: 2px; }
  .speed-group button { border-radius: 0; }
  .speed-group button:first-child { border-radius: 6px 0 0 6px; }
  .speed-group button:last-child { border-radius: 0 6px 6px 0; }
  .status { font-size: 12px; color: #8b949e; margin-left: auto; }
  #diagram { padding: 24px; overflow-x: auto; }
  #diagram .mermaid { background: transparent; }
  #diagram svg { max-width: 100%; }
  .feed { padding: 12px 24px; max-height: 300px; overflow-y: auto; border-top: 1px solid #21262d; font-size: 13px; line-height: 1.8; }
  .feed-line { opacity: 0.6; }
  .feed-line.visible { opacity: 1; }
  .feed-line .time { color: #8b949e; }
  .feed-line .msg { color: #58a6ff; }
  .feed-line .tool { color: #d29922; }
  .feed-line .task { color: #3fb950; }
  /* Agent Board */
  .board { padding: 16px 24px; display: flex; gap: 12px; flex-wrap: wrap; border-bottom: 1px solid #21262d; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px 14px; min-width: 200px; flex: 1; max-width: 280px; transition: border-color 0.3s; }
  .card.flash { border-color: #58a6ff; }
  .card-header { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
  .card-header .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .card-header .dot.running { background: #3fb950; }
  .card-header .dot.stopped { background: #8b949e; }
  .card-header .dot.crashed { background: #f85149; }
  .card-header .name { font-weight: 600; font-size: 14px; }
  .card-row { font-size: 12px; color: #8b949e; line-height: 1.6; }
  .card-row span { color: #c9d1d9; }
  .card-task { font-size: 12px; color: #d29922; margin-top: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .board-empty { font-size: 13px; color: #8b949e; padding: 8px 0; }
  .section-label { font-size: 11px; color: #484f58; text-transform: uppercase; letter-spacing: 1px; padding: 10px 24px 0; }
  .tabs { display: flex; gap: 0; padding: 0 24px; border-bottom: 1px solid #21262d; }
  .tab { padding: 8px 16px; font-size: 13px; color: #8b949e; cursor: pointer; border: none; border-bottom: 2px solid transparent; background: none; }
  .tab.active { color: #58a6ff; border-bottom-color: #58a6ff; }
  .tab:hover { color: #c9d1d9; }
  .view { display: none; }
  .view.active { display: block; }
  #graphCanvas { width: 100%; background: #0d1117; display: block; }
</style>
</head>
<body>
<div class="header">
  <h1>AgEnD Activity</h1>
  <div class="controls">
    <select id="range">
      <option value="1h">1h</option>
      <option value="2h" selected>2h</option>
      <option value="4h">4h</option>
      <option value="8h">8h</option>
      <option value="24h">24h</option>
    </select>
    <button id="btnLoad">Load</button>
    <button id="btnPlay">▶ Play</button>
    <button id="btnPause" style="display:none">⏸ Pause</button>
    <div class="speed-group">
      <button class="speed" data-speed="1">1x</button>
      <button class="speed active" data-speed="2">2x</button>
      <button class="speed" data-speed="5">5x</button>
      <button class="speed" data-speed="10">10x</button>
    </div>
  </div>
  <div class="status" id="status">Ready</div>
</div>
<div class="section-label">Agents</div>
<div class="board" id="board"><div class="board-empty">Loading...</div></div>
<div class="tabs">
  <button class="tab active" data-view="graph">Network Graph</button>
  <button class="tab" data-view="seq">Sequence Diagram</button>
</div>
<div id="viewGraph" class="view active"><canvas id="graphCanvas" height="400"></canvas></div>
<div id="viewSeq" class="view"><div id="diagram"><div class="mermaid" id="mermaidEl"></div></div></div>
<div class="feed" id="feed"></div>

<script>
mermaid.initialize({ startOnLoad: false, theme: 'dark', sequence: { mirrorActors: false, messageAlign: 'left' } });

let rows = [];
let speed = 2;
let playing = false;
let playTimeout = null;
let visibleCount = 0;

document.querySelectorAll('.speed').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    speed = parseInt(btn.dataset.speed);
  });
});

document.getElementById('btnLoad').addEventListener('click', load);
document.getElementById('btnPlay').addEventListener('click', startReplay);
document.getElementById('btnPause').addEventListener('click', pauseReplay);

async function load() {
  const range = document.getElementById('range').value;
  document.getElementById('status').textContent = 'Loading...';
  try {
    const resp = await fetch('/api/activity?since=' + range + '&limit=500');
    rows = await resp.json();
    document.getElementById('status').textContent = rows.length + ' events loaded';
    visibleCount = rows.length;
    renderFull();
  } catch (e) {
    document.getElementById('status').textContent = 'Error: ' + e.message;
  }
}

function buildMermaid(entries) {
  const participants = new Set();
  entries.forEach(r => { participants.add(r.sender); if (r.receiver) participants.add(r.receiver); });
  const aliases = new Map();
  let idx = 0;
  participants.forEach(p => {
    const a = p.length > 12 ? String.fromCharCode(65 + idx++) : p;
    aliases.set(p, a);
  });

  let lines = ['sequenceDiagram'];
  aliases.forEach((a, p) => lines.push('    participant ' + a + ' as ' + p));

  entries.forEach(r => {
    const s = aliases.get(r.sender) || r.sender;
    const summary = (r.summary || '').replace(/"/g, "'").slice(0, 80);
    if (r.event === 'tool_call') {
      lines.push('    Note over ' + s + ': 🔧 ' + summary);
    } else if (r.receiver) {
      const recv = aliases.get(r.receiver) || r.receiver;
      lines.push('    ' + s + '->>' + recv + ': ' + summary);
    } else {
      lines.push('    Note over ' + s + ': ' + summary);
    }
  });
  return lines.join('\\n');
}

async function renderDiagram(entries) {
  const code = buildMermaid(entries);
  const el = document.getElementById('mermaidEl');
  el.removeAttribute('data-processed');
  el.innerHTML = code;
  try { await mermaid.run({ nodes: [el] }); } catch {}
}

function renderFeed(count) {
  const feed = document.getElementById('feed');
  feed.innerHTML = '';
  rows.forEach((r, i) => {
    const vis = i < count;
    const time = (r.timestamp || '').replace('T', ' ').slice(11, 19);
    const icon = r.event === 'message' ? '💬' : r.event === 'tool_call' ? '🔧' : '📋';
    const cls = r.event === 'tool_call' ? 'tool' : r.event === 'task_update' ? 'task' : 'msg';
    const arrow = r.receiver ? r.sender + ' → ' + r.receiver : r.sender;
    const line = document.createElement('div');
    line.className = 'feed-line' + (vis ? ' visible' : '');
    line.innerHTML = '<span class="time">' + time + '</span> ' + icon + ' <span class="' + cls + '">' + arrow + ': ' + (r.summary || '') + '</span>';
    feed.appendChild(line);
  });
  if (count > 0) feed.lastElementChild?.scrollIntoView({ behavior: 'smooth' });
}

function renderFull() {
  visibleCount = rows.length;
  renderDiagram(rows);
  renderFeed(rows.length);
}

function startReplay() {
  playing = true;
  visibleCount = 0;
  document.getElementById('btnPlay').style.display = 'none';
  document.getElementById('btnPause').style.display = '';
  stepReplay();
}

function pauseReplay() {
  playing = false;
  if (playTimeout) clearTimeout(playTimeout);
  document.getElementById('btnPlay').style.display = '';
  document.getElementById('btnPause').style.display = 'none';
}

function stepReplay() {
  if (!playing || visibleCount >= rows.length) {
    pauseReplay();
    document.getElementById('status').textContent = 'Replay complete';
    return;
  }
  visibleCount++;
  const visible = rows.slice(0, visibleCount);
  renderDiagram(visible);
  renderFeed(visibleCount);
  document.getElementById('status').textContent = visibleCount + '/' + rows.length;

  // Calculate delay from real timestamps
  let delayMs = 500;
  if (visibleCount < rows.length) {
    const curr = new Date(rows[visibleCount - 1].timestamp).getTime();
    const next = new Date(rows[visibleCount].timestamp).getTime();
    delayMs = Math.max(100, Math.min(3000, (next - curr) / speed));
  }
  playTimeout = setTimeout(stepReplay, delayMs);
}

// ── Tab switching ────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('view' + (tab.dataset.view === 'graph' ? 'Graph' : 'Seq')).classList.add('active');
    if (tab.dataset.view === 'graph') resizeCanvas();
  });
});

// ── Network Graph ────────────────────────────────
const canvas = document.getElementById('graphCanvas');
const ctx2d = canvas.getContext('2d');
let graphNodes = [];     // {name, x, y, color, isGeneral}
let graphEdges = new Map(); // "a->b" → {from, to}
let pulses = [];         // {fromX, fromY, toX, toY, progress, color}

function resizeCanvas() {
  canvas.width = canvas.parentElement.offsetWidth;
  canvas.height = 400;
  layoutNodes();
}

function layoutNodes() {
  if (graphNodes.length === 0) return;
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const radius = Math.min(cx, cy) - 60;
  // Find general (center)
  const general = graphNodes.find(n => n.isGeneral);
  const others = graphNodes.filter(n => !n.isGeneral);
  if (general) { general.x = cx; general.y = cy; }
  others.forEach((n, i) => {
    const angle = (2 * Math.PI * i / others.length) - Math.PI / 2;
    n.x = cx + radius * Math.cos(angle);
    n.y = cy + radius * Math.sin(angle);
  });
}

function updateGraphFromFleet(data) {
  const names = new Set();
  data.instances.forEach(inst => names.add(inst.name));
  // Add user node if activity mentions it
  rows.forEach(r => { names.add(r.sender); if (r.receiver) names.add(r.receiver); });
  // Rebuild nodes (preserve positions if same set)
  const oldMap = new Map(graphNodes.map(n => [n.name, n]));
  graphNodes = [...names].map(name => {
    const old = oldMap.get(name);
    const inst = data.instances.find(i => i.name === name);
    const color = !inst ? '#8b949e' : inst.status === 'running' ? '#3fb950' : inst.status === 'crashed' ? '#f85149' : '#484f58';
    return { name, x: old?.x ?? 0, y: old?.y ?? 0, color, isGeneral: inst?.general_topic ?? false };
  });
  layoutNodes();
  // Build edges from activity
  graphEdges.clear();
  rows.forEach(r => {
    if (r.receiver && r.event === 'message') {
      const key = r.sender + '->' + r.receiver;
      graphEdges.set(key, { from: r.sender, to: r.receiver });
    }
  });
}

function spawnPulse(sender, receiver, event) {
  const from = graphNodes.find(n => n.name === sender);
  const to = graphNodes.find(n => n.name === (receiver || sender));
  if (!from || !to) return;
  const colors = { message: '#58a6ff', tool_call: '#d29922', task_update: '#3fb950' };
  pulses.push({ fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, progress: 0, color: colors[event] || '#58a6ff' });
}

function drawGraph() {
  if (!ctx2d) return;
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  // Draw edges
  ctx2d.strokeStyle = '#21262d';
  ctx2d.lineWidth = 1;
  graphEdges.forEach(e => {
    const from = graphNodes.find(n => n.name === e.from);
    const to = graphNodes.find(n => n.name === e.to);
    if (from && to) {
      ctx2d.beginPath();
      ctx2d.moveTo(from.x, from.y);
      ctx2d.lineTo(to.x, to.y);
      ctx2d.stroke();
    }
  });
  // Draw pulses
  pulses = pulses.filter(p => p.progress <= 1);
  pulses.forEach(p => {
    p.progress += 0.02;
    const x = p.fromX + (p.toX - p.fromX) * p.progress;
    const y = p.fromY + (p.toY - p.fromY) * p.progress;
    ctx2d.beginPath();
    ctx2d.arc(x, y, 5, 0, Math.PI * 2);
    ctx2d.fillStyle = p.color;
    ctx2d.shadowColor = p.color;
    ctx2d.shadowBlur = 12;
    ctx2d.fill();
    ctx2d.shadowBlur = 0;
  });
  // Draw nodes
  graphNodes.forEach(n => {
    // Glow
    ctx2d.beginPath();
    ctx2d.arc(n.x, n.y, n.isGeneral ? 28 : 22, 0, Math.PI * 2);
    ctx2d.fillStyle = n.color + '22';
    ctx2d.fill();
    // Circle
    ctx2d.beginPath();
    ctx2d.arc(n.x, n.y, n.isGeneral ? 24 : 18, 0, Math.PI * 2);
    ctx2d.fillStyle = '#161b22';
    ctx2d.strokeStyle = n.color;
    ctx2d.lineWidth = 2;
    ctx2d.fill();
    ctx2d.stroke();
    // Label
    ctx2d.fillStyle = '#c9d1d9';
    ctx2d.font = (n.isGeneral ? '12' : '11') + 'px -apple-system, monospace';
    ctx2d.textAlign = 'center';
    ctx2d.fillText(n.name.length > 14 ? n.name.slice(0, 12) + '..' : n.name, n.x, n.y + (n.isGeneral ? 38 : 32));
  });
  requestAnimationFrame(drawGraph);
}

// Hook into replay: spawn pulses when stepping
const origStep = stepReplay;
stepReplay = function() {
  const prevCount = visibleCount;
  origStep();
  if (visibleCount > prevCount && visibleCount <= rows.length) {
    const r = rows[visibleCount - 1];
    spawnPulse(r.sender, r.receiver, r.event);
  }
};

// Hook into full load: spawn pulses for all visible events on load
const origRenderFull = renderFull;
renderFull = function() {
  origRenderFull();
  // Update graph nodes from fleet data (if available)
  fetch('/api/fleet').then(r => r.json()).then(data => {
    updateGraphFromFleet(data);
  }).catch(() => {
    // Fallback: build nodes from activity only
    const names = new Set();
    rows.forEach(r => { names.add(r.sender); if (r.receiver) names.add(r.receiver); });
    graphNodes = [...names].map(n => ({ name: n, x: 0, y: 0, color: '#8b949e', isGeneral: n === 'general' }));
    layoutNodes();
  });
};

resizeCanvas();
window.addEventListener('resize', resizeCanvas);
requestAnimationFrame(drawGraph);

// ── Agent Board ──────────────────────────────────

let prevBoard = '';

async function loadBoard() {
  try {
    const resp = await fetch('/api/fleet');
    const data = await resp.json();
    renderBoard(data);
  } catch {}
}

function renderBoard(data) {
  const board = document.getElementById('board');
  const cards = data.instances.map(inst => {
    const statusDot = inst.status === 'running' ? 'running' : inst.status === 'crashed' ? 'crashed' : 'stopped';
    const icon = inst.status === 'running' ? '🟢' : inst.status === 'crashed' ? '🔴' : '⚪';
    const role = inst.general_topic ? 'coordinator' : inst.description || 'worker';
    const costStr = '$' + (inst.costCents / 100).toFixed(2);
    const lastMs = inst.lastActivity;
    let lastStr = '—';
    if (lastMs) {
      const ago = Math.floor((Date.now() - lastMs) / 1000);
      lastStr = ago < 60 ? ago + 's ago' : ago < 3600 ? Math.floor(ago/60) + 'm ago' : Math.floor(ago/3600) + 'h ago';
    }
    const ipc = inst.ipc ? '✓' : '✗';
    const rl = inst.rateLimits ? ' · 5h:' + inst.rateLimits.five_hour_pct + '%' : '';
    const taskLine = inst.currentTask
      ? '<div class="card-task">📌 ' + inst.currentTask + '</div>'
      : '<div class="card-task" style="color:#484f58">(idle)</div>';
    return '<div class="card" data-name="' + inst.name + '">' +
      '<div class="card-header"><div class="dot ' + statusDot + '"></div><div class="name">' + inst.name + '</div></div>' +
      '<div class="card-row">' + role.slice(0, 30) + '</div>' +
      '<div class="card-row">Backend: <span>' + inst.backend + '</span> · Tools: <span>' + inst.tool_set + '</span></div>' +
      '<div class="card-row">IPC: <span>' + ipc + '</span> · Cost: <span>' + costStr + '</span>' + rl + '</div>' +
      '<div class="card-row">Last: <span>' + lastStr + '</span></div>' +
      taskLine +
      '</div>';
  });

  const newHtml = cards.join('');
  if (newHtml !== prevBoard) {
    board.innerHTML = newHtml;
    // Flash changed cards
    board.querySelectorAll('.card').forEach(c => {
      c.classList.add('flash');
      setTimeout(() => c.classList.remove('flash'), 1000);
    });
    prevBoard = newHtml;
  }
}

// Auto-refresh board every 10s
setInterval(loadBoard, 10000);

// Auto-load on page open
loadBoard();
load();
</script>
</body>
</html>`;
