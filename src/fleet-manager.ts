import { SettingsBaselines } from "./settings-baseline.js";
import { SettingsConfirmationStore, type SettingsPendingView } from "./settings-confirmation.js";
import { SettingsHttpConfirmation } from "./settings-http-confirmation.js";
import { SettingsControlServer } from "./settings-control.js";
import { SettingsExecution, settingsRevision, noteSettingsWrite, settingsFileResource, assertSettingsLease, trySettingsLease, waitSettingsLease, settingsUndo, undoSettingsPaths, type SettingsUndo, type SettingsLease } from "./settings-transaction.js";
import { performance } from "node:perf_hooks";
import { gatewayRequestContext } from "./web-request-context.js";
import { createPublicWebGateway } from "./public-web-gateway.js";
import { renderPublicLinkProgress, ThrottledMessageEditor, type PublicLinkProgress } from "./public-link-progress.js";
import { PublicWebLink, publicLinkSettings } from "./public-web-link.js";
import { TunnelPurposeLane } from "./tunnel/purpose-lane.js";
import { ManagedTunnel } from "./tunnel/manager.js";
import { withinBudget } from "./monotonic-budget.js";
import type { LoginCodeOwner } from "./web-login.js";
import { measureSyncWork } from "./sync-work-attribution.js";
import { RuntimeCpuProfiler, ProfileBusyError, profileDuration, type ProfileTicket } from "./runtime-cpu-profile.js";
import { ProfileControlServer } from "./profile-control.js";
import type { CpuProfile } from "./cpu-profile.js";
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync, rmSync, readdirSync, renameSync, copyFileSync, chmodSync, statSync, accessSync, realpathSync, constants as fsConstants, type Dirent, openSync, closeSync, fsyncSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { freemem, totalmem, cpus, homedir } from "node:os";
import { access } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { Worker } from "node:worker_threads";
import { ProbeWorkerPool, type ProbeWorker } from "./probe-worker-pool.js";
import type { BackendProbeInput, BackendProbeResult } from "./backend/cli-env-probe.js";
import { join, dirname, basename, delimiter, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { getAgendHome, ensureWorkspaceGit } from "./paths.js";
import { fleetLabel } from "./fleet-label.js";
import {
  beginFullRestartProgress as persistFullRestartProgress,
  beginUpdateProgress as persistUpdateProgress,
  clearUpdateMarker,
  isUpdateInProgress,
  readUpdateProgress,
  setUpdateProgressStage,
  updateProgressOperation,
} from "./update-marker.js";
import { formatUpdateProgress } from "./update-progress.js";
import { sdNotify, sdNotifyBlocking } from "./sd-notify.js";
import { readFleetMemory, type FleetMemory } from "./process-memory.js";
import { MemoryPressure, type MemoryPressureSnapshot } from "./memory-pressure.js";
import { replyDedupText, ReplyDeduper } from "./reply-dedup.js";
import { isMap, isScalar, parseDocument } from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import type { FleetConfig, RawFleetConfig, InstanceConfig, ChannelConfig, CostGuardConfig, DailySummaryConfig, WebhookConfig, AccessConfig } from "./types.js";

/** Fallback access policy for a channel with no `access:` block — open (no gate). */
const DEFAULT_OPEN_ACCESS: AccessConfig = { mode: "open", allowed_users: [], max_pending_codes: 0, code_expiry_minutes: 0 };
import {
  STATUS_EMOJI_CONFIG_KEYS, STATUS_EMOJI_KEYS, STATUS_EMOJI_SUGGESTIONS, TELEGRAM_REACTION_EMOJIS,
  builtinStatusEmojis, customEmojiValue, emojiImageUrl, normalizeEmoji, previewStatusEmojis, reactionForm, reactionMatchKey, resolveStatusEmojis,
  statusAvoidList, statusEmojiProblem, statusMatchKey, statusMatchKeys, textForm,
  type DeliveryStatus, type GuildEmoji, type GuildEmojiGroup, type ResolvedStatusEmojis, type StatusEmojiKey,
} from "./status-emojis.js";
import { isProbeableRouteTarget, type RouteTarget } from "./fleet-context.js";
import { loadFleetConfig, loadRawFleetConfig, DEFAULT_COST_GUARD, DEFAULT_DAILY_SUMMARY, DEFAULT_INSTANCE_CONFIG } from "./config.js";
import { EventLog } from "./event-log.js";
import { binaryProbe } from "./binary-probe.js";
import { classifySqliteOpenError } from "./sqlite-open-errors.js";
import { OutboxOpenError } from "./outbox-open-error.js";
import { AdapterWorld } from "./adapter-world.js";
import { CostGuard, formatCents } from "./cost-guard.js";
import { startEventLoopWatch, type EventLoopWatch } from "./event-loop-watch.js";
import { TmuxManager } from "./tmux-manager.js";
import { AccessManager } from "./channel/access-manager.js";
import { IpcClient } from "./channel/ipc-bridge.js";
import type { AdapterHealthSnapshot, AlertData, ChannelAdapter, InboundMessage, InboundReaction, Choice, TopicPresence, StickerInfo, StickerList, StickerPreview, StickerTarget } from "./channel/types.js";
import { createAdapter } from "./channel/factory.js";
import { isWebChannelEcho, WEB_ECHO_PREFIX } from "./web-channel-echo.js";
import { TelegramAdapter } from "./channel/adapters/telegram.js";
import { createBackend } from "./backend/factory.js";
import { readEffortMetadata } from "./backend/effort-metadata.js";
import { CLI_ENV_TTL_MS, isModelCompatible, SYSINFO_BACKEND_IDS, UnsupportedCliError, type BackendCliVersionSnapshot } from "./backend/types.js";
import { createLogger, rotateLogIfNeeded, type Logger } from "./logger.js";
import { processAttachments } from "./channel/attachment-handler.js";
import { routeToolCall } from "./channel/tool-router.js";
import { Scheduler } from "./scheduler/index.js";
import type { Schedule, ScheduleRetry, ScheduleRetryDrop, SchedulerConfig } from "./scheduler/index.js";
import { escapeTelegramHtml, scheduleClock, scheduleRetryLabel } from "./scheduler/retry-label.js";
import { DEFAULT_SCHEDULER_CONFIG } from "./scheduler/index.js";
import type { Task } from "./scheduler/types.js";
import type { FleetContext } from "./fleet-context.js";
import { TopicCommands, saveCommandForBackend, parseSaveFilename, parsePauseWakeCommand, parseCompactCommand, SAVE_FILENAME_RE, resolveInstanceContext, forgetInstanceContext, readStatuslineModel } from "./topic-commands.js";
import type { HangDetector } from "./hang-detector.js";
import { DailySummary } from "./daily-summary.js";
import { WebhookEmitter } from "./webhook-emitter.js";
import { TmuxControlClient } from "./tmux-control.js";
import { safeHandler } from "./safe-async.js";
import { RoutingEngine } from "./routing-engine.js";
import {
  InstanceLifecycle,
  SupersededStartError,
  type TransitionHandle,
  BACKEND_INSTALLATION_INFO,
  type BackendInstallationInfo,
  checkBinaryInstalled,
  type LifecycleContext,
} from "./instance-lifecycle.js";
import { TopicArchiver, type ArchiverContext } from "./topic-archiver.js";
import { StatuslineWatcher, type StatuslineWatcherContext } from "./statusline-watcher.js";
import { outboundHandlers, type OutboundContext } from "./outbound-handlers.js";
import { DeliveryOutbox, type ClaimedOutboxDelivery, type OutboxDelivery, type DeliveryStatusSelector, type DeliveryStatusPage } from "./delivery-outbox.js";

// The target Daemon can legitimately wait 30 minutes for a busy pane before
// deciding to defer before submission. This is an alert threshold only: the
// active manager/target generation pair owns the lane until the daemon reports
// a state transition or that generation is replaced.
export const DURABLE_DELIVERY_LANE_ALERT_MS = 35 * 60_000;

/**
 * #1335: Cap an unfiltered task list at 100 rows (most recently updated first).
 * Exported so the production branch can be tested directly without starting a fleet.
 * Filtered calls pass-through unchanged. Empty strings count as "not set" (P3).
 * #1336: generic over the row shape so it works on both full Task and compact rows.
 */
export const TASK_LIST_CAP = 100;

/**
 * #1336: the non-terminal statuses a bare `list` returns by default. `done`
 * and `cancelled` are excluded unless the caller passes `filter_status`.
 */
export const LIVE_TASK_STATUSES: string[] = ["open", "claimed", "blocked"];

/**
 * #1336 P2: shared normalization for filter_status across both task handlers
 * and the cap helper. Trims whitespace before dropping empties, so
 * " \t " and [" ", "\t"] both normalize to undefined (not treated as explicit
 * filters). The same result drives the live-only default and the cap decision.
 */
export function normalizeStatusFilter(v: unknown): string | string[] | undefined {
  if (typeof v === "string") {
    const s = v.trim();
    return s || undefined;
  }
  if (Array.isArray(v) && v.every(x => typeof x === "string")) {
    const arr = [...new Set((v as string[]).map(s => s.trim()).filter(s => s.length > 0))];
    return arr.length > 0 ? arr : undefined;
  }
  return undefined;
}

export function applyTaskListCap<T extends { updated_at: string }>(
  tasks: T[],
  filterAssignee: string | undefined,
  filterStatus: string | string[] | undefined,
): { tasks: T[]; omitted: number; hint: string } | T[] {
  // Use the shared normalizer so " \t " is treated identically to undefined.
  const normalized = normalizeStatusFilter(filterStatus);
  const hasStatusFilter = Array.isArray(normalized) ? normalized.length > 0 : !!normalized;
  const isFiltered = !!filterAssignee || hasStatusFilter;
  if (!isFiltered && tasks.length > TASK_LIST_CAP) {
    const omitted = tasks.length - TASK_LIST_CAP;
    tasks.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return {
      tasks: tasks.slice(0, TASK_LIST_CAP),
      omitted,
      hint: `${omitted} older task(s) omitted — use filter_assignee or filter_status to narrow results`,
    };
  }
  return tasks;
}
import { handleWebRequest, broadcastSseEvent, SSE_HEARTBEAT_MS } from "./web-api.js";
import { WebChatHistory, WEB_CHAT_TEXT_MAX, isWebMessageId, newWebMessageId, type WebChatAttachment } from "./web-chat-history.js";
import { ReplyButtonStore, parseReplyButtons, replyButtonClickText, replyButtonsFallbackText, REPLY_BUTTON_PREFIX } from "./reply-buttons.js";
import { ReplyButtonsController, type ReplyButtonsView } from "./reply-buttons-controller.js";
import { publicAttachment, sweepOrphanedUploads, WebFileLedger } from "./web-upload.js";
import { handleViewRequest, isViewPath, profileIdentities, resolveInstanceIdentity } from "./view-api.js";
import { filterUsageProviders, formatDiscordUsageActivity, getUsageSnapshot, handleUsageRequest, isUsagePath, usageProviderIdForBackend } from "./usage/usage-api.js";
import { LOGIN_FLOWS, LOGIN_BACKEND_ALIASES, type LoginFlow, type AuthCheckResult } from "./login-flows.js";
import { LoginSession } from "./login-manager.js";
import { tightenInstanceDirs } from "./private-dir.js";
import { decideSlash, type SlashFacts, type SlashScope, type SlashSpeaker } from "./slash-authz.js";
import { commandSpec, decideCommand, ruleFor, type CommandScope } from "./command-table.js";
import { runVisibilityCommand } from "./cross-instance-notice.js";
import { installedChannel, isPrereleaseVersion, updateNoticeKey } from "./update-check.js";
import { resolveInstalledAgend, updateCommand } from "./update-dispatch.js";
import { LoginController, LOGIN_TOKEN_RESEND_PREFIX, POST_LOGIN_RECOVERY_DEADLINE_MS, type PostLoginRecovery } from "./login-controller.js";
import { runBeforeDeadline } from "./deadline.js";
import { LoginWindowLock } from "./login-window-lock.js";
import { handleSettingsRequest, type RawConfigPatch } from "./settings-api.js";
import { setLocale, detectLocale, getLocale, t } from "./locale.js";
import { recentChatContext } from "./log-tail.js";
import { describeSignalSource, recordInternalRequest, withOrigin } from "./fleet-control-audit.js";
import { handleAgentRequest, ToolNotPermittedError, type AgentEndpointContext } from "./agent-endpoint.js";
import { ClassicChannelManager, getClassicBackendChoices, isSelectableClassicBackend, readClassicLastActivityAt } from "./classic-channel-manager.js";
import { assertExplicitInstanceRemoval, type ExplicitInstanceRemoval } from "./instance-removal.js";
import { validateFleetConfig } from "./config-validator.js";
import { isRemovedBackend, removedBackendMessage } from "./backend/removed.js";
import { presentationState, interactionSummary, sameInteractionOwner } from "./interaction-observation.js";
import type { InstanceState, InstanceStateSnapshot, InteractionOwner, InteractionSnapshot } from "./backend/types.js";
import { readLastInboundAt } from "./daemon.js";
import { clearPausedMarker, readPausedAt, readPauseReason, writePausedMarker } from "./pause-marker.js";
import { DEFAULT_WARM_OVERFLOW, WakeCoordinator } from "./wake-coordinator.js";
import { TargetQueueWorker } from "./target-queue-worker.js";
import { resolveDeliveryWorkerMode } from "./types.js";
import { isFleetStartCommandLine, readProcessCommandLine, releaseProcessFleetLock } from "./fleet-lock.js";
import { isSetupComplete, markSetupComplete } from "./setup-marker.js";
import { manualCleanupMessage, reapStaleTunnel } from "./tunnel/lease.js";
import { buildToolPermissionsNotice } from "./tool-permissions-notice.js";
import { NeedsYouHub, type NeedsYouWorld, type WebNeedsItem } from "./needs-you-hub.js";
import type { InstanceInput, PromptInput } from "./needs-you.js";
import { WEB_CHAT_NOTICE, WEB_REMOTE_DOCS_URL, claimNotice, hasWebChat, releaseNotice, upgradeNoticesPath } from "./upgrade-notices.js";
import { GENERAL_PAUSE_ERROR, isGeneralInstance } from "./general-instance.js";
import { buildOrgChart, type OrgChart } from "./web-org.js";
import { CacheService, WINDOWS, type CacheReport, type CacheWindow } from "./cache-service.js";
import { runWebCommand, type WebChoices, type WebCommandResult } from "./web-commands.js";
import { claudeProjectKey } from "./backend/claude-code.js";
import { sharedRolloutIndex } from "./rollout-index.js";
import {
  mayUseTool,
  resolveToolSet,
  scheduleOpRefusal,
  toolForIpcType,
  toolRefusedMessage,
  type ToolSetName,
  type ToolSink,
} from "./tool-permissions.js";
import { authorizeSession, decideWebGate, loadOrCreateWebToken, readWebToken } from "./web-auth.js";
import { bypassesWebGate, handleAuthRequest, serveSigninPage, type AuthApiContext } from "./auth-api.js";
import { isWebPageNavigation } from "./web-shell-routes.js";
import { tokenEpoch, WebSessionStore } from "./web-session.js";
import { WebLoginCodes, LOGIN_CODE_TTL_MS } from "./web-login.js";
import { allowedHostNames, applyWebSecurityHeaders, hostnameOf, isHostAllowed, WEB_HOST_REJECTED_MESSAGE } from "./web-host-guard.js";
import { createPreviewListener, previewAvailability, previewSettings, type PreviewAvailability, type PreviewListener } from "./web-preview.js";
import { fleetLevelDifferences, fleetLevelSignature } from "./fleet-level-config.js";
import { checkSelfRestartAllowance, recordSelfRestartAttempt } from "./self-restart-limit.js";
import { SecretStore } from "./secret-store.js";
import {
  opaqueId,
  safeSecretError,
  SECRET_CHALLENGE_TTL_MS,
  type ConnectionMetadata,
  type ConnectionBinding,
  type BindingProbe,
  type BindingChallenge,
  type SecretApplyJob,
  type SecretChallenge,
  type ProviderSecretChallenge,
  type ProviderSecretApplyJob,
} from "./connection-secrets.js";
import { verifyDiscordToken, verifyTelegramToken } from "./provider-probe.js";
import {
  PROVIDER_SECRET_SPECS,
  providerSecretSpec,
  providerRegistryEnvKeys,
  isReservedProviderEnvKey,
  verifyProviderSecret,
  type ProviderHttpClient,
  type ProviderSecretStatus,
} from "./provider-secret-registry.js";

/** What a reconcile has to say for itself beyond "it ran". */
interface ReconcileOutcome {
  /** Set when the new configuration was refused and the old one kept. */
  rejected?: string;
}

/** A self-restart is a whole service restart; 120s is the apply budget, not this. */
const SELF_RESTART_DEADLINE_MS = 300_000;

import {
  APPLY_FLEET_TARGET,
  ApplyJobStore,
  viewOf,
  type ApplyJob,
  type ApplyTargetKind,
  type ApplyTargetStatus,
  type SelfRestartResult,
} from "./apply-job.js";

/**
 * How the reconcile says what it is doing to whom. Passed per run, never
 * parked on the manager: two reconciles sharing one field means one job's
 * progress lands in the other job's rows.
 */
type ReconcileObserver = (
  target: string,
  kind: ApplyTargetKind,
  status: ApplyTargetStatus,
  error?: string,
) => void;
import { credentialSwitchStartsFresh, instanceCredentialProfile } from "./backend/credential-profile.js";
import { mergeBackendOptions, profileKey, profileName, profileOf, type ClassicProfile } from "./classic-bindings.js";
import {
  classifyInstanceChange,
  CLASSIC_HOT_CONFIG_KEYS,
  HOT_INSTANCE_CONFIG_KEYS,
  hotConfigUpdate,
  splitHotColdConfig,
} from "./instance-config-impact.js";
import {
  formatRestartProgressCompletion,
  RESTART_PROGRESS_TERMINAL_TIMEOUT_MS,
  RestartProgress,
  type RestartProgressTarget,
} from "./restart-progress.js";
import { launchFullRestartHelper, type FullRestartHelperHandle } from "./full-restart.js";
import { SYSTEMD_RESTART_INDETERMINATE_EXIT_CODE } from "./service-restart-selection.js";
import { collectRedundantInstanceDefaultPaths } from "./fleet-yaml-slim.js";
import { StormWindow, type StormSnapshot } from "./storm-window.js";
import { SpawnGate } from "./spawn-gate.js";
import { BackendOutageTracker } from "./backend-outage.js";
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

/**
 * Window-name shape this fleet recognises as an instance window: the
 * `-t<digits>` form every allocator emits, plus legacy `classic-` windows.
 * Startup cleanup reaps windows matching this that are no longer in
 * fleet.yaml. Keep in sync with `uniqueInstanceName` — every name it emits
 * must match here, or a deleted instance's CLI is left running (#1305 P2-3).
 */
export function isOrphanInstanceWindowName(name: string): boolean {
  return /-t\d+$/.test(name) || /^classic-/.test(name);
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
 * Reactions that are neither delivery plumbing nor meaningful conversational
 * feedback. Delivery-status emojis are configurable (#1005) and filtered by
 * FleetManager.isOwnStatusReaction, not by a fixed set.
 */
const IGNORED_REACTION_EMOJIS = new Set(["📷"]);

interface TopicProbeUnknownContext {
  instanceName: string;
  threadId: string;
  adapterId: string | undefined;
  reason: string;
  detail?: string;
}

/** Outcomes of one topic-cleanup scan, folded into the streaks once the pass ends. */
interface TopicProbePass {
  unknown: Map<string, TopicProbeUnknownContext>;
  definite: Set<string>;
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
 * One cancel-button publication attempt. The chat API call completes before a
 * message id exists, so retirement requests that arrive in that window must be
 * remembered separately from `cancelButtons`.
 */
interface CancelButtonPublication {
  generation: number;
  correlationId?: string;
  inFlight: boolean;
  retirePending: boolean;
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
  pendingChangeId?: string;
  confirmationCurrent?: () => boolean;
  requesterUserId?: string;
  publicExposureId?: string;
  dashboardOwner?: LoginCodeOwner;
  /** Callback prefix including the colon, e.g. "exit-restart:". */
  prefix: string;
  instanceName: string;
  adapterId: string;
  adapter: ChannelAdapter;
  chatId: string;
  threadId?: string;
  messageId?: string;
  /** Set when the prompt is a private interaction reply: the only way to edit it (see PrivateSentMessage). */
  retire?: (text: string) => Promise<void>;
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
  /** classic-approve only: the guild/group the prompt is about. Always a string —
   * a Discord snowflake loses precision if it ever becomes a YAML integer. */
  classicGroupId?: string;
  /**
   * classic-approve only: WHICH allow-list this request belongs to. Discord
   * guilds are gated by `allowed_guilds`, Telegram groups by `allowed_groups`,
   * and writing the wrong one changes a file without unblocking anything.
   */
  classicScope?: "guild" | "group" | "user";
  /** Original requester address; a General approval never routes through an agent. */
  classicReplyTo?: { adapterId: string; adapter: ChannelAdapter; chatId: string };
  /** classic-approve only: the user who asked, when the trigger had one. */
  classicUserId?: string;
  /** The entry's own key in pendingNonceButtons (set when posted). */
  nonce?: string;
  /**
   * Set when the prompt is also offered in the web dashboard (web track C4): what the page shows. The same
   * nonce, the same single claim and the same expiry as the platform's buttons — whoever clicks first wins.
   */
  web?: { text: string; actions: Array<{ id: string; label: string }>; expiresAt: number };
  /** When the prompt was offered (epoch ms): its age in "Needs you" (#1386). */
  createdAt?: number;
  /** interactive-assist only: the interaction wait it was raised for, so "Needs you" folds only the same wait (#1386 §3.2). */
  assistFor?: { owner: string | null; episode: number | null };
}


interface AdapterCallbackData {
  callbackData: string;
  chatId: string;
  threadId?: string;
  messageId: string;
  userId?: string;
  /** The clicker's platform name, when the adapter knows it (#1266: "who chose"). */
  username?: string;
  /**
   * Acknowledge the click, optionally with a notice only the clicker sees
   * (#1133): a Discord ephemeral follow-up, a Telegram callback answer. The
   * adapter honours the first call only.
   */
  ack?: (notice?: string) => void;
  respondPrivate?: (text: string, choices?: Choice[]) => Promise<PrivateSentMessage>;
  /**
   * Discord: the clicked message is ephemeral, so only the click's own interaction can edit it — a channel
   * fetch answers 10008 Unknown Message. Replaces the text and drops the buttons.
   */
  editClicked?: (text: string) => Promise<void>;
}

/** A message only its interaction can edit (a Discord ephemeral reply): `retire` replaces its text and drops its buttons. */
type PrivateSentMessage = import("./channel/types.js").SentMessage & { retire?: (text: string) => Promise<void> };

/** The prefix of a button's callback data, for logs (never the nonce). */
function callbackPrefix(callbackData: string): string {
  const colon = callbackData.indexOf(":");
  return colon === -1 ? "(none)" : callbackData.slice(0, colon + 1);
}

interface ClassicStartSlashData {
  command: string;
  channelId: string;
  channelName: string;
  guildId?: string;
  userId: string;
  username?: string;
  text?: string;
  options?: Record<string, string | boolean | number>;
  respond: (text: string) => Promise<string | undefined>;
  /** Remove Discord's deferred ephemeral acknowledgement after a command posts publicly. */
  dismissResponse?: () => Promise<void>;
  respondButtons?: (text: string, choices: Choice[]) => Promise<string | undefined>;
  /** The deferred reply's text replaced and its buttons dropped (an ephemeral reply cannot be fetched from its channel). */
  retireButtons?: (text: string) => Promise<void>;
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
  /**
   * Phase 2b: never wake inline. Durable dispatch to a `wake_only` target sets
   * it — the wake coordinator is that target's only waker, so a target that
   * paused after its row was claimed is handed back instead of woken here.
   */
  noInlineWake?: boolean;
  /**
   * #1426: the caller's own fence, asked wherever the delivery epoch is — through the wake, the idle wait and up to the
   * IPC hand-off itself. False drops the delivery unsent (a schedule retry past its deadline).
   */
  stillCurrent?: () => boolean;
}

const CLASSIC_BACKEND_SELECTION_TIMEOUT_MS = 60_000;
const CLASSIC_BACKEND_CALLBACK_PREFIX = "classic-backend:";
const MODEL_SELECT_CALLBACK_PREFIX = "model-select:";
const EFFORT_SELECT_CALLBACK_PREFIX = "effort-select:";
const INTERACTIVE_ASSIST_CALLBACK_PREFIX = "interactive-assist:";
const EXIT_RESTART_CALLBACK_PREFIX = "exit-restart:";
/** #1386: how long a paused instance's marker reason is reused before it is read again (transitions drop it at once). */
const NEEDS_PAUSE_TTL_MS = 10_000;
const HANG_CALLBACK_PREFIX = "hang:";
const CLEAR_CONFIRM_CALLBACK_PREFIX = "clear-confirm:";
/**
 * The prompts the web dashboard also offers: the ones about an instance's own health, which a dashboard
 * user — holding the full-fleet web credential — may answer exactly as a fleet admin on the platform may.
 * Personal or channel-bound prompts stay where they were asked: a /clear confirmation, login, a Classic
 * group's approval, tips, and the per-user /model and /effort menus (which are not nonce entries at all).
 */
const WEB_MIRRORED_PROMPT_PREFIXES: ReadonlySet<string> = new Set([
  HANG_CALLBACK_PREFIX, EXIT_RESTART_CALLBACK_PREFIX, INTERACTIVE_ASSIST_CALLBACK_PREFIX,
]);
/**
 * Where a reply goes on a fleet with no chat platform (web track C4): it is "sent" by being shown in the
 * web chat, which afterReplyRouted does for every reply. Only what routeToolCall's reply path calls exists
 * here; the path checks (assertSendable, the file count) are the reply tool's own, run before these.
 */
const WEB_ONLY_REPLY_SINK = {
  type: "web",
  supportsReplyButtons: true,                    // #1266: the web chat shows a reply's buttons itself
  sendText: async () => ({ chatId: "web", messageId: newWebMessageId() }),
  sendFile: async () => ({ chatId: "web", messageId: newWebMessageId() }),
} as unknown as ChannelAdapter;
/**
 * Where an instance-health prompt (hang, clean exit, interactive prompt) is posted on a fleet with no chat platform:
 * nowhere but the dashboard (#1307 item 6). Posting "succeeds" with an id of its own, so the prompt is armed and
 * offered on the web exactly as a platform prompt is; there are no platform buttons to edit afterwards, and the
 * outcome reaches the page through prompt_resolved as for any web-answered prompt.
 */
const WEB_ONLY_PROMPT_SINK = {
  type: "web",
  notifyAlert: async () => ({ chatId: "web", messageId: newWebMessageId() }),
  editMessage: async () => {},
  editMessageRemoveButtons: async () => {},
  sendText: async () => ({ chatId: "web", messageId: newWebMessageId() }),
} as unknown as ChannelAdapter;
const TIP_DISMISS_CALLBACK_PREFIX = "tip-dismiss:";
const TIP_UNLOCK_CALLBACK_PREFIX = "tip-unlock:";
export const LOGIN_CALLBACK_PREFIX = "login:";
/**
 * Prompt kinds that no longer exist: `/install-cli` (#1131) and the relay-mode login's
 * provider picker (#1139). Their buttons may still be on screen after an upgrade.
 */
const RETIRED_PROMPT_PREFIXES = ["install-select:", "install-login:", "login-menu:"] as const;
const NEVER_MATCHES = /(?!)/;
const CLASSIC_APPROVE_CALLBACK_PREFIX = "classic-approve:";
const LOGIN_CONFIRM_CALLBACK_PREFIX = "login-confirm:";
/** How much of the end of a Classic chat log is read for context, and the most it grows to. */
const CHAT_LOG_TAIL_BYTES = 64 * 1024;
const CHAT_LOG_TAIL_MAX_BYTES = 4 * 1024 * 1024;
const CLEAR_CONFIRM_TIMEOUT_MS = 15_000;
/** Default lifetime for long-lived nonce prompts (clear overrides this to 15s). */
const NONCE_BUTTON_TIMEOUT_MS = 15 * 60_000;
const TIP_BUTTON_TIMEOUT_MS = 24 * 60 * 60_000;
/** How long shutdown will spend retiring still-armed button prompts. */
const NONCE_RETIRE_BUDGET_MS = 5_000;
/**
 * How old the cached CLI env may be before `/model` re-probes it live.
 *
 * The cache is a file under AGEND_HOME, so it outlives the process, and the only
 * thing that refreshed it was the startup probe. That is why a newly released
 * model showed up only after `agend stop` + `agend start`: a bare `agend restart`
 * signals SIGUSR2 and restarts the instances inside the *same* manager process,
 * so nothing re-probed and `/model` kept serving a list up to 24h old.
 */
const CLI_ENV_FRESH_MS = 60 * 60 * 1000;
/**
 * Upper bound on a live probe driven by `/model`.
 *
 * A probe chains bounded leaves but is not itself bounded: claude-code runs
 * `--version` (5s) then listModels then listApiModels (an 8s AbortController
 * against api.anthropic.com), and several backends' probes carry no explicit
 * timeout at all. Awaiting that inline would make `/model` the next thing to
 * hang, so it races this deadline and falls back to the cached list.
 *
 * Must stay above CLI_PROBE_LONGEST_CHAIN_MS — the probe's bounded steps run
 * back to back, so clearing only the longest single leaf would be false
 * confidence: a deadline above 8s but below the 13s chain still truncates a
 * probe that would have succeeded. Bounding the chain rather than the leaf is
 * the lesson from the usage hang, and the tests assert against the derived
 * chain constant so raising either step cannot silently break it.
 *
 * The deadline exists to stop a probe hanging forever, not to cut short one that
 * would have finished: truncating a legitimate probe serves the previous list
 * and hides exactly the newly released model the user opened `/model` to find.
 * The wait is announced before it starts, so it reads as progress, not a stall.
 */
export const CLI_ENV_PROBE_DEADLINE_MS = 16_000;

/**
 * How many CLIs may cold-start at once, from BOTH memory and cores.
 *
 * Memory alone said 10 on any host with roughly 3GB free, so a three-core box
 * started ten CLIs together, saturated the CPU, and healthy starts then missed
 * their startup budget — which used to cost the user their conversation. Cores
 * bound how many can actually make progress; memory bounds how many fit.
 */
export function deriveSpawnConcurrency(freeMemMB: number, cores: number): number {
  const byMemory = Math.floor(freeMemMB / 300);
  return Math.max(2, Math.min(10, byMemory, Math.max(1, cores)));
}

/** #926: how often reply obligations are checked, the owner-reminder grace, and the default overdue window. */
const REPLY_OBLIGATION_SWEEP_MS = 30_000;
const REPLY_REMINDER_GRACE_MS = 60_000;
const DEFAULT_REPLY_OVERDUE_MINUTES = 15;

/**
 * The filter `list_emojis` and `list_stickers` take (#1226). Values may come from the agent CLI as strings, so a
 * limit is read as a number and the flags accept "true". No limit means all of them — never zero.
 */
function emojiListFilter(opts: Record<string, unknown>): {
  matches(...texts: string[]): boolean; limit: number; primaryOnly: boolean; withImageUrls: boolean;
} {
  const name = typeof opts.name === "string" ? opts.name.trim().toLowerCase() : "";
  const n = Number(opts.limit);
  const flag = (v: unknown) => v === true || v === "true";
  return {
    matches: (...texts) => !name || texts.some(t => t.toLowerCase().includes(name)),
    limit: Number.isInteger(n) && n >= 1 ? n : Infinity,
    primaryOnly: flag(opts.primary_only),
    withImageUrls: flag(opts.with_image_urls),
  };
}

export class FleetManager implements FleetContext, LifecycleContext, ArchiverContext, StatuslineWatcherContext, OutboundContext, AgentEndpointContext {
  private static signalTarget: FleetManager | null = null;
  private static sighupHandlerInstalled = false;

  /** Test seam: inject a spy to verify saveFleetConfig calls fsync. Default: fsyncSync. */
  fsyncForTest: ((fd: number) => void) | undefined = undefined;

  private children: Map<string, import("node:child_process").ChildProcess> = new Map();
  readonly lifecycle: InstanceLifecycle;
  readonly stormWindow: StormWindow;
  readonly spawnGate: SpawnGate;
  readonly memoryPressure: MemoryPressure;
  /** Fleet-level backend reachability memory (fed by pty_error / startup panes). */
  readonly backendOutage = new BackendOutageTracker();
  /** Stable for this FleetManager OS-process lifetime; Daemon objects have their own boot IDs. */
  readonly managerBootId = randomUUID();
  deliveryOutbox: DeliveryOutbox | null = null;
  private deliveryOutboxRecovered = false;
  /** Phase 2b: wakes paused targets for queued durable work (delivery_worker ≠ off). */
  wakeCoordinator: WakeCoordinator | null = null;
  /**
   * Phase 2c: targets whose durable lane a TargetQueueWorker owns
   * (delivery_worker: on). Granted and released only in the pump's
   * synchronous section and only while the lane is empty; the pump skips them.
   */
  readonly queueWorkers = new Map<string, TargetQueueWorker>();
  private deliveryPumpScheduled = false;
  private deliveryPumpRunning = false;
  private deliveryPumpTimer: ReturnType<typeof setTimeout> | null = null;
  /** #926: periodic reply-obligation sweep (owner reminders, requester overdue notices). */
  private replyObligationTimer: ReturnType<typeof setInterval> | null = null;
  private readonly activeDurableTargets = new Set<string>();
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
  /** Topology checks are serialized separately from config reconciliation. */
  private topicCleanupInFlight: Promise<void> | null = null;
  private topicCleanupGeneration = 0;
  private topicProbeWarnings = new Map<string, number>();
  /**
   * Consecutive unknown probe results per route (or per adapter for outage
   * class reasons). A single transient never reaches the operator; only a
   * streak of TOPIC_PROBE_UNKNOWN_ESCALATION does.
   */
  private topicProbeUnknownStreak = new Map<string, number>();
  /** Unknown results in a row before the operator is told. 3 × 5 min poller = 15 min. */
  static readonly TOPIC_PROBE_UNKNOWN_ESCALATION = 3;
  /** Reasons that describe the adapter, not one topic — counted once per adapter. */
  private static readonly TOPIC_PROBE_ADAPTER_SCOPED_REASONS = new Set([
    "owner-adapter-unavailable",
    "owner-adapter-not-ready",
    "owner-adapter-generation-changed",
    "owner-adapter-changed-before-action",
    "adapter-not-ready",
    "adapter-not-initialized",
    "adapter-generation-changed",
    "topic-close-from-unready-adapter",
    "topic-close-generation-changed",
    // Telegram probe: the transport or Telegram itself is down, not one topic.
    "transport-failed",
    "provider-unavailable",
  ]);
  logger: Logger = createLogger("info");
  /** Report each bundled skill collision once per fleet, across instance starts. */
  private skippedBundledSkills = new Set<string>();
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
  /** Adapters whose last slash command registration failed and General was told (#1131). */
  private slashRegistrationFailed = new Set<string>();
  /** Instances currently being auto-paused by warm_cap, so concurrent checks don't double-evict. */
  private warmCapEvicting = new Set<string>();
  /** Per-instance tail keeps cross-instance and scheduled deliveries FIFO. */
  private idleGatedDeliveryTails = new Map<string, Promise<boolean | void>>();
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
  /** Latest publication generation per instance. Late results from older
   * generations are retired without touching the current button. */
  private cancelButtonPublications = new Map<string, CancelButtonPublication>();
  private nextCancelButtonPublicationGeneration = 0;
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
  private webChannelEchoTails = new Map<string, {
    tail: Promise<void>;
    pending: Set<{ started: boolean; drop: () => void }>;
  }>();
  /**
   * instanceName → the reservation whose echo callback is currently running.
   * sendClassicWebEcho fences every per-entry copy against it: no new copy
   * starts after the ordering budget is gone or the delivery epoch is revoked.
   * Serialized per instance by the echo tail, so one slot is enough.
   */
  private webChannelEchoGuards = new Map<string, { epoch: number; deadlineAt: number }>();
  /** instanceName → restart currently executing; concurrent callers join it. */
  private restartsInFlight = new Map<string, Promise<void>>();
  /**
   * Delayed automatic retries for instances whose startup failed. Before this a
   * failed start was logged once and the instance stayed `stopped` until an
   * operator noticed (2026-09-03: 4 kiro instances, all victims of the same
   * backend outage during a post-update herd). instanceName → pending retry.
   */
  private startupRetries = new Map<string, { attempt: number; timer: NodeJS.Timeout }>();
  /** Bumped by every explicit stop (incl. the stop half of a restart); fences the outage hand-off. */
  private explicitStopGeneration = new Map<string, number>();
  /** instanceName → outage hand-off currently executing; a repeat joins it. */
  private handOffsInFlight = new Map<string, Promise<void>>();
  /** instanceName → explicit stop currently executing; the outage hand-off waits for it. */
  private stopsInFlight = new Map<string, Promise<void>>();
  /** Aggregation window for the "N instances failed to start" notice. */
  private startupRetryNotices = new Map<"scheduled" | "gave_up", { names: string[]; delayMs: number; timer: NodeJS.Timeout }>();
  /** Unsupported-CLI refusals waiting to go out, grouped by reason (#1109). */
  private unsupportedCliNotices = new Map<string, { names: string[]; timer: NodeJS.Timeout }>();
  private kiroIncompatNotices = new Map<string, { names: string[]; timer: NodeJS.Timeout }>();
  /** Backoff between automatic startup retries; the last step repeats while the backend is down. */
  static readonly STARTUP_RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
  /** Hard cap on automatic startup retries (3 backoff steps + up to 3 more during a backend outage). */
  static readonly STARTUP_RETRY_MAX_ATTEMPTS = 6;
  /** Re-check interval when a retry is due but the tmux storm window still blocks spawns. */
  static readonly STARTUP_RETRY_STORM_DEFER_MS = 60_000;
  static readonly STARTUP_RETRY_NOTICE_AGGREGATE_MS = 1_000;
  // Last user message delivered to each instance — used to react ✅ on completion.
  private lastInboundMsg = new Map<string, { adapterId?: string; chatId: string; threadId?: string; messageId: string; source?: string }>();
  private topicArchiver: TopicArchiver;

  controlClient: TmuxControlClient | null = null;
  classicChannels: ClassicChannelManager | null = null;
  private pendingClassicStarts = new Map<string, PendingClassicStart>();
  /** In-flight /model selections, keyed by nonce (see handleModelSelection). */
  /** In-flight /effort selections, same coordinator shape as pendingModelSelects. */
  private pendingEffortSelects = new Map<string, { instanceName: string; userId: string; channelId: string; adapterId?: string; timer: ReturnType<typeof setTimeout>; respond: (t: string) => Promise<string | undefined>; adapter?: ChannelAdapter; adapterChatId?: string; adapterThreadId?: string; menuMessageId?: string; }>();
  private pendingModelSelects = new Map<string, { instanceName: string; model: string; userId: string; channelId: string; adapterId?: string; timer: ReturnType<typeof setTimeout>; respond: (t: string) => Promise<string | undefined>; adapter?: ChannelAdapter; adapterChatId?: string; adapterThreadId?: string; menuMessageId?: string; respondChoices?: (text: string, choices: { id: string; label: string }[]) => Promise<string | undefined>; }>();
  /** nonce → pending button prompt (hang restart, interactive assist, clean-exit restart). */
  private pendingNonceButtons = new Map<string, NonceButtonEntry>();
  /** #1386 "Needs you": the list, its live chat messages and Acknowledge. Started with the fleet (finishStartup). */
  private needsYou: NeedsYouHub | null = null;
  /** When the fleet first saw an instance crashed, for its "Needs you" age; cleared when it is not. */
  private readonly needsCrashedAt = new Map<string, number>();
  /** Pause reason/time read from the marker, per paused instance; dropped on any attention change of it, and at most
   *  NEEDS_PAUSE_TTL_MS old — so a recompute does not re-read the file every time (#1386 §4.3). */
  private readonly needsPauseCache = new Map<string, { reason: string | null; pausedAt: number | null; readAt: number }>();
  /**
   * Clicks that came from the web dashboard (clickWebPrompt). Only that method adds to it, so nothing an
   * adapter emits — whatever fields its payload carries — can claim a dashboard click's authority.
   */
  private readonly webPromptClicks = new WeakSet<AdapterCallbackData>();
  /** The web clicks consumeNonceCallback actually claimed (the others were refused or lost a race). */
  private readonly webPromptClaims = new WeakSet<AdapterCallbackData>();

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
  /** Web Settings secret rotation is deliberately separate from reconnect
   * recovery: a rotation must build a fresh provider client with the new token,
   * and stale callbacks from the old client must not win. */
  private connectionSecretChallenges = new Map<string, SecretChallenge>();
  private connectionSecretChallengesByKey = new Map<string, string>();
  private connectionSecretJobs = new Map<string, SecretApplyJob>();
  private connectionSecretJobSession = new Map<string, string>();
  private connectionSecretInFlight = new Map<string, string>();
  private connectionSecretGenerations = new Map<string, number>();
  /** Local epoch that fences a challenge across adapter replacement and
   * provider reconnect generations. The adapter's own generation can reset
   * when a new adapter object is constructed, so keep an independent epoch. */
  private connectionSecretAdapterRefs = new Map<string, ChannelAdapter | undefined>();
  private connectionSecretHealthGenerations = new Map<string, number>();
  /** Generic API-key verifier/apply state.  The challenge scope contains the
   * resolved spec/env key, so a request can never retarget another provider. */
  private providerSecretChallenges = new Map<string, ProviderSecretChallenge>();
  private providerSecretChallengesByKey = new Map<string, string>();
  private providerSecretJobs = new Map<string, ProviderSecretApplyJob>();
  private providerSecretJobSession = new Map<string, string>();
  private providerSecretInFlight = new Map<string, string>();
  private providerSecretGenerations = new Map<string, number>();
  /** Test seam only; production always uses the fixed HTTPS client. */
  private providerSecretHttpClient?: ProviderHttpClient;
  /** Code-owned activation hooks; never populated from a request. */
  private providerSecretReloadHooks = new Map<string, (next: string, previous: string | undefined) => Promise<void>>();
  /** In-memory snapshots for narrow hot consumers (currently Groq voice). */
  private providerSecretHotSnapshots = new Map<string, string | undefined>();
  /** Web Settings connection-binding step-up challenges and apply jobs. */
  private connectionBindingChallenges = new Map<string, BindingChallenge>();
  private connectionBindingChallengesByKey = new Map<string, string>();
  private connectionBindingJobs = new Map<string, SecretApplyJob>();
  private connectionBindingJobSession = new Map<string, string>();
  private connectionBindingInFlight = new Map<string, string>();
  private collabInstances = new Set<string>();

  // Health endpoint
  private healthServer: Server | null = null;
  /** #1306: the preview listener (health_port + 1 by default), and whether it is listening. */
  private previewListener: PreviewListener | null = null;
  private previewListening = false;
  /** The ports the preview listener was started for, and the inputs it was built from (a reload compares them). */
  private previewPorts: { requested: number; bound: number } | null = null;
  private previewInputs = "";
  private healthPortRetried = false;
  private updateCheckTimer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | null = null;
  private updateProgressTimer: ReturnType<typeof setInterval> | null = null;
  private updateProgressEditRunning = false;
  private lastUpdateProgressText: string | null = null;
  private updateCompletionTipText: string | null = null;
  /** Injectable only to keep the chat→CLI reload hand-off deterministic in tests. */
  private fullRestartLauncher: () => Promise<FullRestartHelperHandle> = launchFullRestartHelper;
  private eventLogPruneTimer: ReturnType<typeof setInterval> | null = null;
  private outboxPruneTimer: ReturnType<typeof setInterval> | null = null;
  private logRotateTimer: ReturnType<typeof setInterval> | null = null;
  private discordPresenceTimer: ReturnType<typeof setInterval> | null = null;
  private discordPresenceEagerTimer: ReturnType<typeof setTimeout> | null = null;
  private discordPresenceEagerPending = false;
  private discordPresenceInFlight: Promise<void> | null = null;
  private static readonly DISCORD_PRESENCE_REFRESH_MS = 15 * 60_000;
  /** Days of event/activity history to keep. */
  private static readonly EVENT_LOG_RETENTION_DAYS = 30;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private eventLoopWatch: EventLoopWatch | null = null;
  private startedAt = 0;
  private stormOpenNotifyTimer: ReturnType<typeof setTimeout> | null = null;
  private memoryLogAt: number | null = null;
  private memoryDebugAt: number | null = null;
  private memoryLogLevel: MemoryPressureSnapshot["level"] | null = null;
  private memoryNoticeAt: number | null = null;
  private memoryNoticeLevel: MemoryPressureSnapshot["level"] | null = null;

  // Mirror topic: buffer cross-instance messages, flush every 3s
  private mirrorBuffer: string[] = [];
  private mirrorTimer: ReturnType<typeof setTimeout> | null = null;

  // Web UI: SSE clients + auth token
  private sseClients = new Set<import("node:http").ServerResponse>();
  /** The web chat's recent messages: what `/ui/history` serves and what a reconnecting SSE stream is sent. */
  readonly webChatHistory = new WebChatHistory();
  /** Uploaded files and the files the dashboard may fetch back (uploads, reply attachments). */
  readonly webFiles = new WebFileLedger();
  /**
   * Read from disk on every access rather than cached at startup: `agend
   * web-token rotate` runs in a separate process, and a cached copy would keep
   * authorizing revoked links and cookies until the fleet restarted.
   */
  private settingsGeneration = 0;
  private settingsRuntimeRevision = 0;
  private settingsConfirmation: SettingsHttpConfirmation | null = null;
  private settingsControl: SettingsControlServer | null = null;
  private settingsJobSettlements = new Map<string, Promise<void>>();
  private classicSettingsOwners = new WeakMap<SettingsExecution, { instanceName: string; epoch: number; daemon: object | undefined }>();

  private queueSettingsOperation(job: SecretApplyJob | ProviderSecretApplyJob, resources: string[], execution: SettingsExecution | undefined,
    run: (execution: SettingsExecution) => Promise<void>): void {
    const generation = this.settingsGeneration;
    const owned = execution ?? new SettingsExecution({ current: () => !this.shuttingDown && this.settingsGeneration === generation,
      snapshot: () => [this.settingsRuntimeRevision, this.fleetConfig, settingsRevision(join(this.dataDir, ".env"))] });
    const done = Promise.resolve().then(async () => {
      let lease: SettingsLease | null = null, admitted = false;
      try {
        lease = await waitSettingsLease(resources, () => owned.current(), performance.now() + owned.remainingMs, owned.owner);
        owned.assert(); admitted = true; await run(owned);
        if (["applied", "applied_next_use", "reloaded", "restart_required"].includes(job.result) && !owned.completed) throw new Error("missing_settings_receipt");
      } catch {
        job.status = "done"; job.finishedAt = Date.now(); job.result = admitted ? "rollback_failed" : "rolled_back";
        job.error = admitted ? "operation did not provide a committed receipt; operator attention required" : "operation was not admitted";
      } finally {
        lease?.release(); if (!execution) owned.close();
        if ("envKey" in job) { if (this.providerSecretInFlight.get(job.envKey) === job.id) this.providerSecretInFlight.delete(job.envKey); }
        else {
          if (this.connectionSecretInFlight.get(job.connectionId) === job.id) this.connectionSecretInFlight.delete(job.connectionId);
          if (this.connectionBindingInFlight.get(job.connectionId) === job.id) this.connectionBindingInFlight.delete(job.connectionId);
        }
      }
    });
    this.settingsJobSettlements ??= new Map();
    this.settingsJobSettlements.set(job.id, done);
    while (this.settingsJobSettlements.size > 128) {
      const first = this.settingsJobSettlements.keys().next().value!;
      const record = this.providerSecretJobs.get(first) ?? this.connectionSecretJobs.get(first) ?? this.connectionBindingJobs.get(first);
      if (record?.status !== "done") break; this.settingsJobSettlements.delete(first);
    }
  }

  private settingsGate(): SettingsHttpConfirmation {
    if (this.settingsConfirmation) return this.settingsConfirmation;
    const generation = this.settingsGeneration;
    const current = (): boolean => !this.shuttingDown && this.settingsGeneration === generation;
    const baselines = new SettingsBaselines({ dataDir: this.dataDir, configPath: () => this.configPath,
      config: () => this.fleetConfig, current: () => [this.settingsGeneration, this.settingsRuntimeRevision, this.shuttingDown],
      proof: (kind, target, id, binding, key) => {
        const map = kind === "provider" ? this.providerSecretChallenges : kind === "binding" ? this.connectionBindingChallenges : this.connectionSecretChallenges;
        const proof = map.get(id);
        if (!proof || proof.sessionBinding !== binding || proof.idempotencyKey !== key
          || ("specId" in proof ? proof.specId : proof.connectionId) !== target
          || proof.generation !== ("envKey" in proof ? this.providerSecretGeneration(proof.envKey) : this.secureConnectionGeneration(target))) return null;
        const remainingMs = proof.deadline === undefined ? proof.expiresAt - Date.now() : proof.deadline - performance.now();
        if (remainingMs <= 0) return null;
        const envKey = "envKey" in proof ? proof.envKey : this.secureConnectionChannel(target)?.bot_token_env ?? "";
        return { key: envKey, secret: "secret" in proof ? proof.secret : "", previous: process.env[envKey], remainingMs,
          ...( "binding" in proof ? { binding: proof.binding } : {} ),
          discard: () => { if (map.get(id) === proof) map.delete(id); if ("secret" in proof) proof.secret = ""; } };
      } });
    const store: SettingsConfirmationStore = new SettingsConfirmationStore({
      audit: (event, fields) => this.logger.info({ event: `settings_confirmation.${event}`, ...fields }, "Settings confirmation audit"),
      notify: view => view.state === "pending" ? this.promptSettingsChange(store, view) : Promise.resolve(),
    });
    const gate = new SettingsHttpConfirmation(store, {
      principal: req => {
        const auth = authorizeSession(req, this.webToken, this.webSessions, { touch: false });
        if (auth.kind !== "ok" || !current()) return null;
        const record = auth.session, sessions = this.webSessions, exposure = gatewayRequestContext(req);
        return { id: record.idHash, label: record.label, source: exposure ? "public_link" : "web_session",
          current: () => current() && sessions === this.webSessions && !!this.webToken
            && sessions!.isCurrent(record, tokenEpoch(this.webToken!)) && (!exposure || exposure.isCurrent()) };
      }, baseline: () => baselines.read(), snapshot: () => baselines.snapshot(),
      job: async id => {
        const settlement = this.settingsJobSettlements.get(id);
        if (!settlement) return false;
        await settlement;
        const job = this.providerSecretJobs.get(id) ?? this.connectionSecretJobs.get(id) ?? this.connectionBindingJobs.get(id);
        return !!job && ["applied", "applied_next_use", "reloaded"].includes(job.result);
      },
    });
    this.settingsConfirmation = gate; return gate;
  }

  private async promptSettingsChange(store: SettingsConfirmationStore, view: SettingsPendingView): Promise<void> {
    const generation = this.settingsGeneration;
    const excluded = new Set(store.affectedConnections(view.id));
    for (const [name, config] of Object.entries(this.fleetConfig?.instances ?? {})) {
      if (!config.general_topic) continue;
      const adapterId = this.getInstanceAdapterId(name), adapter = this.getAdapterForInstance(name);
      const general = this.daemons.get(name);
      if (!adapterId || !adapter || !general || excluded.has(adapterId) || !this.hasFleetAdmins(adapterId)) continue;
      const chatId = this.getGroupIdForInstance(name), topic = String(config.topic_id ?? "");
      if (!chatId || !topic) continue;
      let retired = false, attached = false;
      const postingDeadline = performance.now() + Math.min(5000, view.remaining_ms);
      const current = (): boolean => !retired && (attached || performance.now() < postingDeadline) && !this.shuttingDown && this.settingsGeneration === generation
        && this.fleetConfig?.instances[name]?.general_topic === true
        && this.daemons.get(name) === general && !this.ipcStoppingInstances.has(name)
        && this.adapterState.get(adapterId)?.status === "connected"
        && this.getInstanceAdapterId(name) === adapterId && this.getAdapterForInstance(name) === adapter
        && this.getGroupIdForInstance(name) === chatId && String(this.fleetConfig?.instances[name]?.topic_id ?? "") === topic
        && this.hasFleetAdmins(adapterId);
      if (!current()) continue;
      try {
        const posted = this.postNonceButtonPromptOrThrow({ prefix: "settings-confirm:", alertType: "clear_confirm",
          instanceName: name, adapterId, adapter, chatId, threadId: topic,
          message: `🔒 Settings change awaiting fleet-admin confirmation\nSource: ${view.source}\nRequester: ${view.requested_by}\n${view.summary.join("\n")}`,
          choices: [{ action: "confirm", label: "Confirm" }, { action: "reject", label: "Reject" }],
          expiredText: "Settings confirmation is no longer pending.", timeoutMs: view.remaining_ms,
          extra: { pendingChangeId: view.id, confirmationCurrent: current },
        });
        void posted.then(nonce => {
          if (!retired) return;
          const entry = this.pendingNonceButtons.get(nonce);
          if (entry?.pendingChangeId !== view.id) return;
          this.pendingNonceButtons.delete(nonce); clearTimeout(entry.timer);
          void this.retireNonceButtons(entry, entry.messageId ?? "", "Settings confirmation delivery expired.");
        }, () => {});
        const nonce = await withinBudget(posted, postingDeadline); attached = true;
        const retire = (): void => {
          const entry = this.pendingNonceButtons.get(nonce); if (!entry || entry.pendingChangeId !== view.id) return;
          this.pendingNonceButtons.delete(nonce); clearTimeout(entry.timer);
          void this.retireNonceButtons(entry, entry.messageId ?? "", "Settings confirmation is no longer pending.");
        };
        if (!current()) { retire(); continue; }
        if (store.attachPrompt(view.id, retire)) return;
      } catch { retired = true; this.logger.info({ id: view.id, adapterId }, "Settings confirmation prompt unavailable; trying another General or host CLI"); }
    }
    // No platform confirmation was reachable. Host inspection is still required.
    this.logger.info({ id: view.id }, "Settings change requires local `agend settings confirm <id>`");
  }

  private async handleSettingsChangeCallback(data: AdapterCallbackData, adapterId: string, adapter?: ChannelAdapter): Promise<boolean> {
    const result = this.consumeNonceCallback("settings-confirm:", /^settings-confirm:([0-9a-f]{32}):(confirm|reject)$/, data, adapterId, adapter);
    if (!result) return false;
    if (result === "consumed") return true;
    const { entry, action } = result;
    try {
      const view = await this.settingsGate().store.decide(entry.pendingChangeId!, action as "confirm" | "reject", {
        label: `fleet admin ${data.userId}`,
        current: () => entry.confirmationCurrent?.() === true && this.getAdapterForInstance(entry.instanceName) === entry.adapter
          && !!data.userId && this.isFleetAdmin(data.userId, entry.adapterId),
      });
      await this.retireNonceButtons(entry, entry.messageId ?? data.messageId, view.outcome?.message ?? "Settings change is applying.");
    } catch { await this.retireNonceButtons(entry, entry.messageId ?? data.messageId, "Settings confirmation rejected or expired."); }
    return true;
  }

  async startSettingsConfirmationControl(): Promise<void> {
    if (this.shuttingDown || this.settingsControl) return;
    const generation = this.settingsGeneration, control = new SettingsControlServer(this.dataDir, this.settingsGate().store,
      () => !this.shuttingDown && this.settingsGeneration === generation);
    this.settingsControl = control;
    try { await control.listen(); } catch (err) { if (this.settingsControl === control) this.settingsControl = null; throw err; }
  }

  private get webToken(): string | null { return readWebToken(this.dataDir); }
  /**
   * Server-side web sessions (see web-session.ts). Created with the token, not per
   * request: they are persisted, and a restart must find them again.
   */
  private webSessions: WebSessionStore | null = null;
  /** Heartbeat of the dashboard's SSE stream; public so a test can shorten it. */
  sseHeartbeatMs = SSE_HEARTBEAT_MS;
  /** The dashboard's login codes. Memory only: a code that outlives the process is a code nobody can prove was not copied. */
  private webLoginCodes: WebLoginCodes | null = null;
  /**
   * Set while a Settings apply job is driving the reconcile. The reconcile
   * stays the single doer; it just says out loud what it is doing to whom, so
   * the job's rows are the work rather than a prediction of it.
   */
  private applyJobStoreCache: ApplyJobStore | null = null;
  /** The apply that currently owns the reconcile slot, reserved synchronously
   * so a second request cannot slip in before the first one starts working. */
  private activeApplyJobId: string | null = null;
  /** The fleet-level signature this process actually came up on. */
  private appliedFleetLevel: string | null = null;
  /** The config behind that signature, kept so a "needs restart" log can name
   * which keys moved rather than just asserting that something did. */
  private startupFleetConfig: FleetConfig | null = null;
  /** Set when the file on disk and the in-memory config disagree on a
   * startup-only key at startup. See checkStartupSignatureConsistency(). */
  private fleetSignatureMismatch: string[] | null = null;
  private healthServerListening = false;

  constructor(public dataDir: string) {
    FleetManager.signalTarget = this;
    if (!FleetManager.sighupHandlerInstalled) {
      process.on("SIGHUP", () => FleetManager.signalTarget?.handleSighup());
      FleetManager.sighupHandlerInstalled = true;
    }
    this.stormWindow = new StormWindow();
    this.memoryPressure = new MemoryPressure({ onSample: snapshot => this.reportMemoryPressure(snapshot),
      onDarwinUnknown: memory => this.logger.info({ pressureRaw: memory?.darwinPressureRaw ?? null },
        "macOS kernel memory pressure unknown — no notice or admission restriction") });
    this.spawnGate = new SpawnGate({
      storm: this.stormWindow,
      memoryPressure: this.memoryPressure,
      concurrency: () => this.spawnConcurrency(),
      staggerMs: () => this.fleetConfig?.defaults?.startup?.stagger_delay_ms ?? 500,
    });
    this.bindStormWindowEvents();
    this.lifecycle = new InstanceLifecycle(this);
    this.topicCommands = new TopicCommands(this);
    this.topicArchiver = new TopicArchiver(this);
    this.statuslineWatcher = new StatuslineWatcher(this);
  }

  /** #1266: a reply's buttons — the store (reply-buttons.db) and what a click does. Created on first use. */
  private replyButtonsCtl: ReplyButtonsController | null = null;
  /** The store could not be opened in this process: buttons are offered as text until the next start. */
  private replyButtonsUnavailable = false;
  /**
   * The controller, or null when reply-buttons.db cannot be opened (#1500 review). That file holds only open choices,
   * so it never stops AgEnD: the failure is logged and posted once, replies offer their choices as text, and a click on
   * an older button is answered "closed". The file is left where it is — an open error is not proof of corruption.
   */
  replyButtons(): ReplyButtonsController | null {
    if (this.replyButtonsCtl) return this.replyButtonsCtl;
    if (this.replyButtonsUnavailable) return null;
    const path = join(this.dataDir, "reply-buttons.db");
    let store: ReplyButtonStore;
    try { store = new ReplyButtonStore(path); }
    catch (err) {
      this.replyButtonsUnavailable = true;
      this.logger.error({ err: (err as Error).message, path }, "Reply buttons unavailable: reply-buttons.db could not be opened — replies offer their choices as text");
      try { this.notifyFleetError(`⚠️ Reply buttons are off until AgEnD restarts: ${path} could not be opened (${(err as Error).message}). Replies offer their choices as text.`); }
      catch { /* the notice is best effort */ }
      return null;
    }
    this.replyButtonsCtl = new ReplyButtonsController({
      store,
      now: () => Date.now(),
      adapterFor: (adapterId) => this.worlds.get(adapterId)?.adapter ?? (adapterId === this.getPrimaryAdapterId() ? this.adapter ?? undefined : undefined),
      mayClick: (set, userId) => this.mayAnswerReplyButtons(set.instance, set.adapterId, userId),
      deliver: (set, button, by) => this.deliverReplyButtonChoice(set, button, by),
      publish: (instance, view) => this.emitSseEvent("reply_buttons", { instance, buttons: view }),
      logger: this.logger,
      setTimer: (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; },
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    this.replyButtonsStore = store;
    return this.replyButtonsCtl;
  }
  private replyButtonsStore: ReplyButtonStore | null = null;

  /**
   * #1266: who may answer a reply's buttons on a platform — whoever may message that instance there: in a ClassicBot
   * room anyone there (as a typed message), elsewhere someone the sending connection lets speak (#754/#1148), never a
   * fleet bot.
   */
  private mayAnswerReplyButtons(instance: string, adapterId: string, userId: string): boolean {
    if ([...this.worlds.values()].some(w => w.botUserId && w.botUserId === userId)) return false;
    if (this.classicChannels?.getChannelIdByInstance(instance) !== undefined) return true;
    const access = this.worlds.get(adapterId)?.accessManager ?? (adapterId === this.getPrimaryAdapterId() ? this.accessManager : null);
    return this.isFleetAdmin(userId, adapterId) || !!access?.isAllowed(userId);
  }

  /** #1266: the choice, delivered as an ordinary inbound message from whoever made it, and shown in the web chat. */
  private async deliverReplyButtonChoice(
    set: { instance: string; adapterId: string; chatId: string; threadId: string; messageId: string | null },
    button: { label: string; value: string },
    by: { userId: string; username: string; source: string },
  ): Promise<boolean> {
    const content = replyButtonClickText(button);
    const web = by.source === "web";
    const ts = new Date().toISOString();
    const messageId = web ? newWebMessageId() : (set.messageId ?? "");
    const sent = await this.deliverToInstance(set.instance, {
      type: "fleet_inbound",
      content,
      targetSession: set.instance,
      meta: {
        chat_id: set.chatId, message_id: messageId, user: by.username, user_id: by.userId, ts,
        thread_id: set.threadId, adapter_id: set.adapterId === "web" ? undefined : set.adapterId,
        source: web ? "web" : (this.worlds.get(set.adapterId)?.adapter.type ?? "web"),
      },
    });
    if (sent === false) return false;
    this.lastInboundUser.set(set.instance, by.username);
    this.emitSseEvent("message", {
      instance: set.instance, sender: by.username, role: "user", text: content, ts, ...(web ? { messageId } : {}),
    });
    return true;
  }

  private ensureDeliveryOutbox(): void {
    if (this.deliveryOutbox) return;
    const dbPath = join(this.dataDir, "delivery-outbox.db");
    let outbox: DeliveryOutbox | undefined;
    try {
      outbox = new DeliveryOutbox(dbPath, this.managerBootId);
      if (!this.deliveryOutboxRecovered) {
        const recovered = outbox.recoverForBoot(this.managerBootId);
        this.logger.info({ ...recovered }, "Recovered durable delivery outbox for this process boot");
      }
    } catch (cause) {
      // Unlike events.db, these rows cannot be discarded: queued messages and uncertain submissions are authoritative.
      // Publish only a fully recovered store. A partial open/recovery must not authorize admission on a later call.
      try { outbox?.close(); } catch { /* preserve the original failure */ }
      const error = new OutboxOpenError(dbPath, cause);
      this.logger.error({ err: cause, dbPath, kind: error.kind }, error.message);
      throw error;
    }
    this.deliveryOutbox = outbox;
    this.deliveryOutboxRecovered = true;
    outbox.on("admitted", () => { this.scheduleDeliveryOutboxPump(); this.wakeCoordinator?.kick(); });
    outbox.on("state", (event: { deliveryId?: string; state?: string }) => {
      this.scheduleDeliveryOutboxPump();
      this.wakeCoordinator?.kick();
      if (event.deliveryId && event.state === "delivered") {
        const target = outbox.get(event.deliveryId)?.targetInstance;
        if (target) this.wakeCoordinator?.noteDelivered(target);
      }
      if (event.deliveryId && (event.state === "failed" || event.state === "uncertain" || event.state === "delivered")) {
        this.needsYou?.poke();
      }
      if (event.deliveryId && (event.state === "failed" || event.state === "uncertain")) {
        const row = outbox.get(event.deliveryId);
        if (row && row.kind !== "delivery_outcome_notice" && row.kind !== "post_restart_outcome_notice") {
          const notice = t(`delivery.fleet_${row.state}`, row.targetInstance, row.operationId, row.deliveryId);
          this.logger.error({ deliveryId: row.deliveryId, operationId: row.operationId, target: row.targetInstance, state: row.state }, notice);
          this.notifyFleetError(notice);
        }
      }
    });
    outbox.on("generation_recovered", () => this.scheduleDeliveryOutboxPump());
    this.replyObligationTimer = setInterval(() => measureSyncWork("fleet.replyObligationSweep", () => this.sweepReplyObligations()), REPLY_OBLIGATION_SWEEP_MS);
    this.replyObligationTimer.unref?.();
    // #856: the text the target daemon received differs from what was
    // admitted. Transport has never been seen to do this; a warning and the
    // attempt row's flag are the whole response until it has.
    outbox.on("content_digest_mismatch", (event: { deliveryId: string; attemptNo: number; targetInstance?: string }) => {
      this.logger.warn(event, "Delivered text differs from the admitted text (content digest mismatch)");
    });
    this.wakeCoordinator = this.createWakeCoordinator();
    this.wakeCoordinator.start();
    outbox.on("expired", (event: { count?: number; uncertain?: number }) => {
      this.scheduleDeliveryOutboxPump();
      if (event.count) this.needsYou?.poke();   // #1386: rows that expired failed — they wait on someone now
      this.wakeCoordinator?.kick();
      if (event.count) this.notifyFleetError(
        t("delivery.expired", event.count, event.uncertain ?? 0),
      );
    });
    this.scheduleDeliveryOutboxPump();
  }

  /** Synchronous SQLite admission; the caller may acknowledge only after this returns. */
  admitDurableDelivery(input: {
    operationId: string;
    sourceDaemonBootId?: string;
    sourceInstance: string;
    targetInstance: string;
    targetSession?: string;
    kind: string;
    correlationId: string;
    payload: Record<string, unknown>;
  }): { deliveryId: string; state: string; duplicate: boolean } {
    const outbox = this.deliveryOutbox;
    if (!outbox) throw new Error("Durable delivery store is unavailable");
    const source = this.daemons.get(input.sourceInstance);
    const sourceDaemonBootId = input.sourceDaemonBootId ?? source?.bootId;
    if (!source || !sourceDaemonBootId || source.bootId !== sourceDaemonBootId) {
      throw new Error("Source daemon generation is no longer current; outcome is unknown");
    }
    const sourceKey = `mcp:${input.sourceInstance}:${input.operationId}:${input.targetInstance}:${input.targetSession ?? ""}:${input.kind}`;
    const admitted = outbox.admit({ ...input, sourceDaemonBootId, sourceKey });
    if (admitted.inserted) this.logger.info({
      deliveryId: admitted.delivery.deliveryId,
      operationId: input.operationId,
      source: input.sourceInstance,
      target: input.targetInstance,
      kind: input.kind,
    }, "Durable cross-instance delivery accepted");
    this.scheduleDeliveryOutboxPump();
    // Phase 2b: a paused wake_only target is woken by the coordinator, never by
    // the pump; admission must tell it, or the work waits for the watchdog.
    this.wakeCoordinator?.kick();
    return {
      deliveryId: admitted.delivery.deliveryId,
      state: admitted.delivery.state,
      duplicate: !admitted.inserted,
    };
  }

  queryDurableDeliveryStatus(callerInstance: string, selector: DeliveryStatusSelector): DeliveryStatusPage {
    this.ensureDeliveryOutbox();
    return this.deliveryOutbox!.queryStatusForInstance(callerInstance, selector);
  }

  getDaemonBootId(instanceName: string): string | undefined {
    return this.daemons.get(instanceName)?.bootId;
  }

  markDurableResponseDelivered(sourceInstance: string, operationId: string): void {
    this.deliveryOutbox?.markResponseDelivered(sourceInstance, operationId);
  }

  /** Called after a replacement Daemon object is installed in lifecycle.daemons. */
  onDaemonReady(name: string, daemonBootId: string): void {
    const outbox = this.deliveryOutbox;
    if (!outbox) return;
    for (const prior of outbox.getUnansweredAccepted(name, daemonBootId)) {
      try {
        outbox.admitPostRestartOutcomeNotice(prior, daemonBootId);
      } catch (err) {
        this.logger.error({ err, source: name, operationId: prior.operationId }, "Could not persist post-restart delivery outcome notice");
      }
    }
    // #926: a restart kills the turn that was working on a request, and a
    // resumed CLI does not pick it back up. Remind the owner once per restart.
    try {
      outbox.remindReplyObligations(name, { reason: "restart", graceMs: 0, since: new Date() });
    } catch (err) {
      this.logger.error({ err, owner: name }, "Could not persist the post-restart reply reminder");
    }
    this.scheduleDeliveryOutboxPump();
  }

  /**
   * #926: the two reply-obligation safety nets. Idle owners with an unanswered
   * request get one reminder (after the grace); requesters get one overdue
   * notice when the owner is not working and nothing came back in time.
   */
  sweepReplyObligations(now = new Date()): void {
    const outbox = this.deliveryOutbox;
    if (!outbox || this.shuttingDown) return;
    const stateOf = (name: string) => this.daemons.get(name)?.getInstanceState();
    try {
      for (const name of this.daemons.keys()) {
        if (stateOf(name) === "idle") outbox.remindReplyObligations(name, { now, graceMs: REPLY_REMINDER_GRACE_MS, reason: "turn-ended" });
      }
      const minutes = this.fleetConfig?.defaults?.reply_overdue_minutes ?? DEFAULT_REPLY_OVERDUE_MINUTES;
      outbox.notifyOverdueReplyObligations({ now, overdueMs: minutes * 60_000, ownerIdle: name => stateOf(name) !== "working" });
    } catch (err) {
      this.logger.error({ err }, "Reply-obligation sweep failed");
    }
  }

  private scheduleDeliveryOutboxPump(delayMs = 0): void {
    if (!this.deliveryOutbox || this.shuttingDown || !this.deliveryOutbox.isOpen) return;
    if (this.deliveryPumpTimer) {
      if (delayMs > 0) return;
      clearTimeout(this.deliveryPumpTimer);
      this.deliveryPumpTimer = null;
    }
    if (this.deliveryPumpRunning) {
      this.deliveryPumpScheduled = true;
      return;
    }
    this.deliveryPumpTimer = setTimeout(() => {
      this.deliveryPumpTimer = null;
      // The pump's body never awaits: the whole run is one synchronous stretch (#1235 attribution).
      void measureSyncWork("fleet.deliveryPump", () => this.runDeliveryOutboxPump());
    }, Math.max(0, delayMs));
    this.deliveryPumpTimer.unref?.();
  }

  private async runDeliveryOutboxPump(): Promise<void> {
    const outbox = this.deliveryOutbox;
    // A closed database is never queried: this runs from timers, where a throw
    // is an unhandled rejection. Checking here covers the finally block too:
    // the body below never awaits, so the database cannot close in between.
    if (!outbox || this.shuttingDown || this.deliveryPumpRunning || !outbox.isOpen) return;
    this.deliveryPumpRunning = true;
    this.deliveryPumpScheduled = false;
    try {
      outbox.expireStale(undefined, undefined, target => {
        const failure = this.wakeCoordinator?.wakeFailure(target);
        return failure ? `target could not be woken (${failure})` : undefined;
      });
      this.reconcileQueueWorkers(outbox);
      while (this.activeDurableTargets.size < 8) {
        const claimed = outbox.claimNext(
          this.managerBootId,
          // Phase 2b: a wake_only target is claimed only once it is awake; the
          // wake coordinator, not this pump, wakes it (no claim, no attempt).
          // Phase 2c: a lane a queue worker owns is never claimed here.
          target => this.queueWorkers.has(target) || this.isInstanceRestarting(target) || this.wakeCoordinator?.blocksClaim(target)
            ? null
            : this.daemons.get(target)?.bootId ?? null,
          this.activeDurableTargets,
        );
        if (!claimed) break;
        this.activeDurableTargets.add(claimed.targetInstance);
        void this.dispatchDurableDelivery(claimed).finally(() => {
          this.activeDurableTargets.delete(claimed.targetInstance);
          this.scheduleDeliveryOutboxPump();
        });
      }
    } catch (err) {
      this.logger.error({ err }, "Durable delivery dispatcher failed; committed rows remain in SQLite");
      this.scheduleDeliveryOutboxPump(5_000);
    } finally {
      this.deliveryPumpRunning = false;
      if (this.deliveryPumpScheduled) this.scheduleDeliveryOutboxPump();
      const nextRetryAt = outbox.nextRetryAt();
      if (nextRetryAt && !this.deliveryPumpTimer) {
        this.scheduleDeliveryOutboxPump(Math.max(1, Date.parse(nextRetryAt) - Date.now()));
      }
      const nextExpiryAt = outbox.nextExpiryAt();
      if (nextExpiryAt && !this.deliveryPumpTimer) {
        this.scheduleDeliveryOutboxPump(Math.max(1, Date.parse(nextExpiryAt) - Date.now()));
      }
    }
  }

  /**
   * Phase 2c ownership (design §1.5-A), called synchronously from the pump
   * before its claim loop, so a grant and the pump's own claims cannot
   * interleave. A worker is granted a target's lane only when the target is
   * `on` and its lane is empty: no row in flight in the outbox and no pump
   * dispatch holding it. It gives the lane back only when it is idle and the
   * target is no longer `on` (or has nothing pending). A flag change never
   * takes a lane mid-drain.
   */
  private reconcileQueueWorkers(outbox: DeliveryOutbox): void {
    const pendingTargets = new Set(outbox.listPending().map(row => row.targetInstance));
    for (const [target, worker] of this.queueWorkers) {
      const keep = this.deliveryWorkerMode(target) === "on" && pendingTargets.has(target);
      if (!keep && !worker.busy && !worker.inFlight) this.queueWorkers.delete(target);
    }
    for (const target of pendingTargets) {
      if (this.queueWorkers.has(target) || this.deliveryWorkerMode(target) !== "on") continue;
      const laneEmpty = !this.activeDurableTargets.has(target)
        && outbox.countForTarget(target, ["delivering", "submission_started"]) === 0;
      if (laneEmpty) this.queueWorkers.set(target, this.createQueueWorker(target));
    }
    for (const worker of this.queueWorkers.values()) void worker.drain();
  }

  private createQueueWorker(target: string): TargetQueueWorker {
    const worker: TargetQueueWorker = new TargetQueueWorker(target, {
      owns: () => this.queueWorkers.get(target) === worker,
      wanted: () => this.deliveryWorkerMode(target) === "on",
      available: () => !this.shuttingDown && this.deliveryOutbox?.isOpen === true,
      blocked: () => this.isInstanceRestarting(target) || this.wakeCoordinator?.blocksClaim(target) === true,
      daemonBootId: () => this.daemons.get(target)?.bootId ?? null,
      claim: bootId => this.deliveryOutbox?.claimNext(
        this.managerBootId,
        candidate => candidate === target ? bootId : null,
        new Set(),
      ),
      tryAcquireBudget: () => {
        if (this.activeDurableTargets.size >= 8) return false;
        this.activeDurableTargets.add(target);
        return true;
      },
      releaseBudget: () => { this.activeDurableTargets.delete(target); },
      dispatch: async claimed => {
        try {
          await this.dispatchDurableDelivery(claimed, { holdLaneOnTransportError: true });
        } finally {
          // The row's state event can fire before the hand-off settles; the
          // pump pass it starts then still sees this worker busy and keeps it
          // as owner. One kick after the dispatch has really settled lets the
          // pump release an owner that is no longer wanted (or claim the next
          // row). The no-claim path never kicks, so no retry hot loop.
          this.scheduleDeliveryOutboxPump();
        }
      },
      kickCoordinator: () => this.wakeCoordinator?.kick(),
      logger: this.logger,
    });
    return worker;
  }

  private async dispatchDurableDelivery(
    claimed: ClaimedOutboxDelivery,
    opts: {
      /**
       * Phase 2c (design §1.5-B): a transport error after the daemon began the
       * submission does not end the writer, which runs in this process. The
       * lane stays held until the daemon's verdict or the end of its
       * generation (reconciliation); the row is not terminalized here.
       */
      holdLaneOnTransportError?: boolean;
    } = {},
  ): Promise<void> {
    const outbox = this.deliveryOutbox;
    if (!outbox) return;
    const target = claimed.targetInstance;
    const attempt = claimed.attemptNo;
    const payload = { ...claimed.payload };
    const laneReleased = this.waitForDurableLaneRelease(claimed);
    const rawMeta = payload.meta && typeof payload.meta === "object"
      ? payload.meta as Record<string, unknown>
      : {};
    // Arm the visible liveness alert as soon as this generation owns the lane,
    // including time spent waiting for a handoff/idle gate to return.
    try {
      let sent: boolean | void;
      if (claimed.kind === "raw_paste") {
        if (payload.type !== "raw_paste" || typeof payload.content !== "string") {
          throw new Error("Durable raw_paste row has an invalid payload");
        }
        // Preserve the schedule's exact bytes and raw route. The target daemon
        // owns readiness, paste, one Enter, and the fenced outbox transition.
        sent = await this.deliverToInstance(target, {
          type: "raw_paste",
          content: payload.content,
          delivery_id: claimed.deliveryId,
          delivery_attempt: String(claimed.attemptNo),
        }, { waitForIdle: false, noInlineWake: this.deliveryWorkerMode(target) !== "off" });
      } else {
        payload.meta = {
          ...rawMeta,
          delivery_id: claimed.deliveryId,
          delivery_attempt: String(claimed.attemptNo),
          from_instance: typeof rawMeta.from_instance === "string" && rawMeta.from_instance
            ? rawMeta.from_instance
            : claimed.sourceInstance,
          correlation_id: claimed.correlationId ?? String(rawMeta.correlation_id ?? ""),
        };
        sent = await this.deliverToInstance(target, payload, {
          isCrossInstance: true,
          waitForIdle: claimed.kind !== "steer",
          noInlineWake: this.deliveryWorkerMode(target) !== "off",
        });
      }
      if (!sent) {
        const current = outbox.get(claimed.deliveryId);
        if (current?.state === "delivering") {
          outbox.retryBeforeBegin(claimed.deliveryId, claimed.targetDaemonBootId, claimed.attemptNo,
            "delivery was cancelled before target IPC handoff",
            Math.min(60_000, 1_000 * 2 ** Math.min(attempt - 1, 6)));
        }
      }
    } catch (err) {
      const latest = outbox.get(claimed.deliveryId);
      const reason = err instanceof Error ? err.message : String(err);
      if (opts.holdLaneOnTransportError && (latest?.state === "submission_started" || latest?.state === "reconciliation_pending")) {
        this.logger.warn({ deliveryId: claimed.deliveryId, target, attempt, err: reason },
          "Transport failed after the submission began; holding the lane for the daemon's verdict or its generation's reconciliation");
      } else if (latest?.state === "submission_started") {
        outbox.complete(claimed.deliveryId, claimed.targetDaemonBootId, claimed.attemptNo, "uncertain", reason);
      } else {
        outbox.retryBeforeBegin(claimed.deliveryId, claimed.targetDaemonBootId, claimed.attemptNo, reason,
          Math.min(60_000, 1_000 * 2 ** Math.min(attempt - 1, 6)));
      }
      this.logger.warn({ deliveryId: claimed.deliveryId, target, attempt, err: reason }, "Durable delivery dispatch deferred");
    }
    await laneReleased;
  }

  private async waitForDurableLaneRelease(claimed: ClaimedOutboxDelivery): Promise<void> {
    const outbox = this.deliveryOutbox;
    if (!outbox) return;
    const deliveryId = claimed.deliveryId;
    const released = (row: OutboxDelivery | undefined): boolean => !row
      || row.state === "queued" || row.state === "retry_wait"
      || row.state === "delivered" || row.state === "failed"
      || row.state === "uncertain" || row.state === "cancelled";
    if (released(outbox.get(deliveryId))) return;
    await new Promise<void>(resolve => {
      const finish = () => {
        clearTimeout(alertTimer);
        outbox.off("state", check);
        outbox.off("generation_recovered", check);
        resolve();
      };
      const check = () => {
        if (released(outbox.get(deliveryId))) finish();
      };
      const alertTimer = setTimeout(() => {
        const current = outbox.get(deliveryId);
        if ((current?.state === "delivering" || current?.state === "submission_started")
          && current.targetDaemonBootId === claimed.targetDaemonBootId
          && current.managerBootId === claimed.managerBootId) {
          this.notifyFleetError(
            t("delivery.lane_waiting", claimed.targetInstance, Math.round(DURABLE_DELIVERY_LANE_ALERT_MS / 60_000), deliveryId),
          );
        }
      }, DURABLE_DELIVERY_LANE_ALERT_MS);
      alertTimer.unref?.();
      outbox.on("state", check);
      outbox.on("generation_recovered", check);
      check();
    });
  }

  private spawnConcurrency(): number {
    const explicit = this.fleetConfig?.defaults?.startup?.concurrency;
    if (explicit != null) return Math.max(1, Math.min(20, explicit));
    return deriveSpawnConcurrency(Math.round(freemem() / (1024 * 1024)), cpus().length);
  }

  /** Separate cooldown: changing measurements must not create new text-throttle keys. */
  private reportMemoryPressure(snapshot: MemoryPressureSnapshot): void {
    if (this.shuttingDown) return;
    const now = Date.now();
    if (this.memoryDebugAt === null || now - this.memoryDebugAt >= 30_000) {
      this.memoryDebugAt = now;
      this.logger.debug({ hostMemory: snapshot }, "Host memory sample");
    }
    const changed = snapshot.level !== this.memoryLogLevel;
    if (this.memoryPressure.advisoryOnly()) {
      // The sampler logs the unknown kernel value once per lifecycle; no warning/cooldown here.
      this.memoryLogLevel = snapshot.level;
      return;
    }
    if (snapshot.level === "normal") {
      if (this.memoryLogLevel === "critical" || this.memoryLogLevel === "elevated") {
        this.logger.info({ hostMemory: snapshot }, "Host memory recovered");
      }
      this.memoryLogLevel = snapshot.level;
      return;
    }
    if (changed || this.memoryLogAt === null || now - this.memoryLogAt >= 10 * 60_000) {
      this.memoryLogAt = now;
      this.logger.warn({ hostMemory: snapshot }, snapshot.level === "critical"
        ? "Host memory critical — deferring new CLI spawns"
        : snapshot.level === "elevated" ? "Host memory pressure — slowing new CLI spawns"
          : "Host memory sample unavailable — slowing new CLI spawns");
    }
    this.memoryLogLevel = snapshot.level;
    if (!snapshot.memory || snapshot.level === "unknown" || (!this.adapter && this.adapters.size === 0)) return;
    const escalation = snapshot.level === "critical" && this.memoryNoticeLevel !== "critical";
    if (!escalation && this.memoryNoticeAt !== null && now - this.memoryNoticeAt < 10 * 60_000) return;
    const size = (bytes: number | null) => bytes === null ? t("memory.unknown") : `${Math.round(bytes / 1024 / 1024)} MiB`;
    const action = t(snapshot.level === "critical" ? "memory.holding" : "memory.slowing");
    const text = this.memoryPressure.platform === "darwin"
      ? t("memory.kernel_pressure", snapshot.memory.darwinPressureLevel ?? t("memory.unknown"), size(snapshot.memory.availableBytes), size(snapshot.memory.swapFreeBytes), action)
      : t("memory.pressure", t(snapshot.memory.availableKind === "available" ? "memory.available" : "memory.free", size(snapshot.memory.availableBytes)), size(snapshot.memory.swapFreeBytes), action);
    if (this.notifyFleetError(text, { throttle: false })) {
      this.memoryNoticeAt = now;
      this.memoryNoticeLevel = snapshot.level;
    }
  }

  /** Wire the one fleet-wide storm into notification and recovery surfaces. */
  private bindStormWindowEvents(): void {
    this.stormWindow.on("opened", (snapshot: StormSnapshot) => {
      if (snapshot.kind === "window_loss") {
        // The server is fine and nothing is held: only the instances that lost
        // their window are affected, they respawn at the storm rate, and their
        // per-instance incident notices fold into this one (#1127).
        this.logger.error({ ...snapshot }, "several instances lost their tmux window at once — recovering at a reduced rate");
        this.notifyFleetError(t("storm.window_loss", snapshot.affected.length, Math.round(this.stormWindow.windowLossWindowMs / 1000), this.stormWindowLossRecoveryConcurrency()));
        return;
      }
      for (const [name, daemon] of this.daemons) {
        if (!daemon.isPaused) this.stormWindow.addAffected(name);
      }
      this.logger.error({ ...snapshot }, "tmux server storm opened — holding respawns and delivery");
      if (this.stormOpenNotifyTimer) clearTimeout(this.stormOpenNotifyTimer);
      this.stormOpenNotifyTimer = setTimeout(() => {
        this.stormOpenNotifyTimer = null;
        const current = this.stormWindow.snapshot();
        this.notifyFleetError(t(
          "storm.opened",
          current.affected.length,
          this.formatStormDelay(current.backoffMs),
        ));
      }, 1_000);
      this.stormOpenNotifyTimer.unref?.();
    });
    this.stormWindow.on("extended", (snapshot: StormSnapshot) => {
      this.logger.error({ ...snapshot }, "tmux server storm repeated — backoff extended");
      this.notifyFleetError(t(
        "storm.extended",
        snapshot.crashCount,
        this.formatStormDelay(snapshot.backoffMs),
      ));
    });
    this.stormWindow.on("recovery_due", (snapshot: StormSnapshot) => {
      this.logger.warn({ ...snapshot }, "tmux storm backoff elapsed — rolling recovery started");
    });
    this.stormWindow.on("closed", (snapshot: StormSnapshot, reason: string) => {
      const unresolved = snapshot.affected.filter(name => !snapshot.recovered.includes(name));
      this.logger.info({ ...snapshot, reason, unresolved }, "tmux server storm closed");
      this.notifyFleetError(t(
        reason === "timeout" ? "storm.timed_out" : "storm.recovered",
        snapshot.recovered.length,
        snapshot.affected.length,
        unresolved.length > 0 ? unresolved.join(", ") : t("storm.none"),
      ));
    });
  }

  /** What the gate allows while any storm window is open (see SpawnGate.pump). */
  private stormWindowLossRecoveryConcurrency(): number {
    return Math.min(4, this.spawnConcurrency());
  }

  private formatStormDelay(ms: number): string {
    if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
    return `${Math.round(ms / 1_000)}s`;
  }

  stormSuppressed(kind: string): boolean {
    return this.stormWindow.shouldSuppress(kind);
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
    const started = this.startExclusiveReconcile();
    if (!started) {
      this.reloadPending = true;
      this.logger.info("Config reconciliation already running — coalesced reload request");
      return;
    }

    started.catch(err => {
      // Almost always a YAML parse error. Log-only meant the user edited
      // fleet.yaml, sent SIGHUP, and got no reaction and no explanation.
      this.logger.error({ err }, "SIGHUP config reload failed");
      const message = err instanceof Error ? err.message : String(err);
      this.notifyFleetError(t("fleet.reload_failed", message));
    });
  }

  /**
   * Take the reconcile slot, or refuse.
   *
   * Only one reconcile may touch lifecycle and config at a time — two of them
   * stop and start the same instance in parallel. SIGHUP and a Settings apply
   * are the same operation from two entrances, so they share the one slot: the
   * signal coalesces into a pending replay, the apply is told the fleet is busy.
   *
   * The returned promise is the caller's to handle; the stored one is already
   * handled, so a rejection never escapes as an unhandled rejection.
   */
  private startExclusiveReconcile(observer?: ReconcileObserver): Promise<ReconcileOutcome> | null {
    if (this.reconcileInFlight) return null;

    this.reloadPending = false;
    let settle!: (err: unknown, outcome?: ReconcileOutcome) => void;
    const caller = new Promise<ReconcileOutcome>((resolve, reject) => {
      settle = (err, outcome) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(outcome ?? {}));
    });
    this.reconcileInFlight = this.reconcileInstances(observer)
      .then(outcome => settle(null, outcome), err => settle(err))
      .finally(() => {
        this.reconcileInFlight = null;
        if (this.reloadPending && this.startupComplete) {
          this.scheduleReconcile();
        }
      });
    return caller;
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
    this.startNeedsYou();
    // Resolve whatever a previous run — or a setup host that crashed — left
    // behind. A tunnel nobody is tracking is a public entrance nobody is
    // watching, and the fleet starting is the moment there is finally a process
    // around to notice. Never throws: a lease that cannot be resolved blocks
    // the next tunnel and says so, it does not block the fleet.
    this.announceToolPermissionsChange();

    this.tightenInstanceDirectories();

    void reapStaleTunnel(this.dataDir)
      .then(outcome => {
        if (outcome.kind === "manual") this.logger.warn({ tunnel: outcome }, manualCleanupMessage(outcome));
        else if (outcome.kind === "reaped") this.logger.info({ how: outcome.how, pid: outcome.pid }, "Reaped a leftover tunnel");
      })
      .catch(err => this.logger.warn({ err }, "Tunnel reaper failed"));
    // An existing installation has never written the setup marker — it predates
    // it — so `agend setup` would open a pre-fleet form for a fleet that plainly
    // exists. A fleet that just came up on a config with agents in it is proof
    // enough that setup happened.
    if (Object.keys(this.fleetConfig?.instances ?? {}).length > 0 && !isSetupComplete(this.dataDir)) {
      markSetupComplete(this.dataDir);
    }
    // After slimFleetConfigAtStartup() and the general/topic fixups, all of
    // which may rewrite fleet.yaml — the baseline has to be what this process
    // is actually running, compared against what a reconcile would load.
    this.appliedFleetLevel = this.fleetLevelSignature();
    this.startupFleetConfig = this.fleetConfig ? structuredClone(this.fleetConfig) : null;
    this.checkStartupSignatureConsistency();
    // A job from the process that just died cannot still be running here. The
    // restart applied the saved config to every instance, so its open rows are
    // finished — by the restart, which is what the user needs told.
    for (const settled of this.applyJobs.settleAfterRestart()) {
      this.logger.info({ jobId: settled.id }, "Settings apply job settled by fleet restart");
    }
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

    // Fleet instances (fleet.yaml)
    const fleetInstances = Object.keys(this.fleetConfig?.instances ?? {}).map(name => ({
      name,
      status: this.getInstanceStatus(name),
      state: this.getInstanceExecutionState(name),
      ipc: this.instanceIpcClients.has(name),
      costCents: this.costGuard?.getDailyCostCents(name) ?? 0,
      rateLimits: this.statuslineWatcher.getRateLimits(name) ?? null,
    }));

    // Classic instances (classicBot.yaml) — dedupe against fleet
    const fleetNames = new Set(fleetInstances.map(i => i.name));
    const classicInstances = (this.classicChannels?.getAll() ?? [])
      .filter(ch => !fleetNames.has(ch.instanceName))
      .map(ch => ({
        name: ch.instanceName,
        status: this.getInstanceStatus(ch.instanceName),
        state: this.getInstanceExecutionState(ch.instanceName),
        ipc: this.instanceIpcClients.has(ch.instanceName),
        costCents: this.costGuard?.getDailyCostCents(ch.instanceName) ?? 0,
        rateLimits: this.statuslineWatcher.getRateLimits(ch.instanceName) ?? null,
      }));

    // Combined roster (matches /api/fleet and agend ls)
    const allInstances = [...fleetInstances, ...classicInstances];

    // Fleet summary counts (fleet + Classic combined)
    const running_count = allInstances.filter(i => i.status === "running").length;
    const paused_count = allInstances.filter(i => i.status === "paused").length;

    // System memory (GB, 1 decimal)
    const totalGB = totalmem() / (1024 ** 3);
    const usedGB = (totalmem() - freemem()) / (1024 ** 3);
    const system_mem_gb = {
      used: Math.round(usedGB * 10) / 10,
      total: Math.round(totalGB * 10) / 10,
    };

    // Fleet memory: O(1) cgroup read (includes entire service tree: fleet + CLIs + MCP servers)
    // This avoids blocking the event loop with per-instance tree scans.
    const fleetMem = readFleetMemory();
    const fleet_mem_mb = fleetMem.cgroupAnonBytes != null
      ? Math.round(fleetMem.cgroupAnonBytes / (1024 * 1024) * 10) / 10
      : null;

    return {
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
      memory_mb: { rss: toMB(mem.rss), heapUsed: toMB(mem.heapUsed), heapTotal: toMB(mem.heapTotal) },
      instances: fleetInstances, // SysInfo.instances is fleet-only; /api/fleet enriches with Classic
      fleet_cost_cents: this.costGuard?.getFleetTotalCents() ?? 0,
      fleet_cost_limit_cents: this.costGuard?.getLimitCents() ?? 0,
      running_count,
      paused_count,
      fleet_mem_mb,
      system_mem_gb,
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
    const raw = loadRawFleetConfig(configPath);
    const loaded = loadFleetConfig(configPath);
    this.assertProviderSecretEnvKeys(loaded);
    this.rawFleetConfig = raw;
    this.settingsRuntimeRevision++;
    this.fleetConfig = loaded;
    this.savedFleetConfigSnapshot = structuredClone(this.fleetConfig);
    this.warnAboutRemovedLoginMode(loaded);
    return this.fleetConfig;
  }

  private relayLoginModeWarned = false;

  /** `login.mode: relay` was removed (#1139). Still accepted so an upgrade cannot stop a fleet from starting. */
  private warnAboutRemovedLoginMode(config: FleetConfig): void {
    if (config.login?.mode !== "relay" || this.relayLoginModeWarned) return;
    this.relayLoginModeWarned = true;
    this.logger.warn("fleet.yaml sets login.mode: relay — the chat-relay login was removed; /login always uses the web terminal. Remove the setting.");
  }

  /**
   * A channel's configurable bot_token_env is an env-key writer too.  Refuse
   * an overlap with a registry API key (or a process-reserved key) before the
   * config becomes live; otherwise a Discord token could be written into
   * GROQ_API_KEY by a perfectly valid-looking rotation request.
   */
  private assertProviderSecretEnvKeys(config: FleetConfig): void {
    const registryKeys = providerRegistryEnvKeys();
    const channels = config.channels ?? (config.channel ? [config.channel] : []);
    for (const channel of channels) {
      const key = channel.bot_token_env;
      if (registryKeys.has(key) || isReservedProviderEnvKey(key)) {
        throw new Error(`bot_token_env ${key} conflicts with a protected provider secret key`);
      }
    }
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

  /**
   * One-time repair of what earlier versions left behind: instance directories (agent.token and the IPC
   * socket live in them) created with the process umask — typically 0775, group-writable and traversable
   * by everyone. They are made 0700 here, once, and said so once; new ones are born 0700 (ensureInstanceDir).
   * Idempotent, so a restart that finds nothing to do logs nothing. Never throws.
   */
  private tightenInstanceDirectories(): void {
    try {
      const report = tightenInstanceDirs(this.dataDir);
      if (report.tightened.length > 0) {
        this.logger.info({
          count: report.tightened.length,
          modes: [...new Set(report.tightened.map(t => t.from))],
        }, "Instance directories were open to other users; set to 0700 (they hold agent.token and the IPC socket)");
      }
      if (report.skipped.length > 0) {
        this.logger.warn({ dirs: report.skipped.map(s => `${s.dir} (${s.why})`) },
          "Could not tighten these instance directories — fix their owner/permissions by hand (chmod 700)");
      }
    } catch (err) {
      this.logger.warn({ err }, "Instance directory permission check failed");
    }
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
      if (!this.isModelAdmin(data.userId, data.channelId, adapterId)) {
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
      if (!Object.hasOwn(this.fleetConfig?.instances ?? {}, requested)) {
        await data.respond(t("instance.not_found", requested));
        return;
      }
      // #754 audit: a General speaks for its own bot's instances only.
      if (this.getInstanceAdapterId(requested) !== adapterId) {
        await data.respond(t("instance.other_bot", requested));
        return;
      }
      target = requested;
    }
    await data.respond(await this.topicCommands.runPauseWake(target, action));
  }

  /** SIGUSR2: restart the instances inside this process. Names who asked (#1120). */
  private onGracefulRestartSignal(rearm: () => void): void {
    this.logger.info(`Received SIGUSR2, initiating graceful restart... ${describeSignalSource(this.dataDir, "SIGUSR2")}`);
    this.restartInstances()
      .catch(err => this.logger.error({ err }, "Graceful restart failed"))
      .finally(rearm);
  }

  /** SIGUSR1: full process reload. Names who asked (#1120). */
  private onFullRestartSignal(): void {
    this.logger.info(`Received SIGUSR1, initiating full restart (process reload)... ${describeSignalSource(this.dataDir, "SIGUSR1")}`);
    this.gracefulShutdownForReload()
      .then(() => {
        this.logger.info("Full restart: shutdown complete, exiting for reload");
        process.exit(0);
      })
      .catch(err => {
        this.logger.error({ err }, "Full restart: graceful shutdown failed");
        process.exit(1);
      });
  }

  private async handleUpdateSlash(data: ClassicStartSlashData, adapterId: string): Promise<void> {
    const gate = this.fleetAdminGate(data.userId, adapterId);
    if (gate !== "ok") {
      await data.respond(t(gate === "disabled" ? "update.disabled" : "not_authorized"));
      return;
    }
    const messageId = await data.respond(t("update.progress.preparing", 0));
    const adapter = this.adapters.get(adapterId) ?? this.adapter;
    if (messageId && adapter) {
      const chatId = String(this.getChannelConfig(adapterId)?.group_id ?? data.channelId);
      this.beginUpdateProgress(adapter, chatId, data.channelId, messageId);
    }
    const { spawn } = await import("node:child_process");
    // Plain `agend update`: the CLI picks the channel from the version it is about to replace (a beta install
    // stays on beta). Deciding here, from the package.json next to THIS code, read a source checkout's 1.22.0 as
    // "not a beta" and sent a beta install to @latest. #1450 C5: the INSTALLED agend, verified, by absolute path.
    const installed = await resolveInstalledAgend();
    if (!installed.ok) {
      this.failUpdateProgress(`/update cannot verify the installed AgEnD (${installed.reason}). Run \`agend update\` from a shell.`);
      return;
    }
    const origin = `slash /update by ${adapterId}:${data.userId}`;
    recordInternalRequest(this.dataDir, "update", origin);
    const { command, args } = updateCommand(installed.agend);
    const child = spawn(command, args, {
      detached: true, stdio: "ignore", env: withOrigin(origin),
    });
    child.once("error", err => this.failUpdateProgress(err.message));
    child.unref();
  }

  private async handleProfileSlash(data: ClassicStartSlashData, adapterId: string): Promise<void> {
    const route = this.routing.resolve(data.channelId);
    await this.handleGeneralProfile(route?.kind === "general" ? route.name : undefined,
      data.userId, adapterId, data.options?.seconds as string | number | undefined, data.respond);
  }

  /** Typed /profile belongs only to Telegram's General dispatcher. */
  async runProfileCommand(msg: InboundMessage, seconds?: string): Promise<void> {
    if (msg.source !== "telegram") return;
    const adapterId = msg.adapterId ?? this.getPrimaryAdapterId();
    const route = msg.threadId ? this.routing.resolve(msg.threadId) : undefined;
    const general = msg.threadId ? (route?.kind === "general" ? route.name : undefined)
      : Object.keys(this.fleetConfig?.instances ?? {}).find(name => this.fleetConfig!.instances[name].general_topic
        && this.getInstanceAdapterId(name) === adapterId);
    const adapter = adapterId ? this.adapters.get(adapterId) : this.adapter;
    if (!adapter) return;
    await this.handleGeneralProfile(general, msg.userId, adapterId, seconds,
      async text => (await adapter.sendText(msg.chatId, text, { threadId: msg.threadId })).messageId);
  }

  private async handleGeneralProfile(general: string | undefined, userId: string, ingressAdapterId: string | undefined,
    seconds: string | number | undefined, respond: (text: string) => Promise<unknown>): Promise<void> {
    if (!general || !Object.hasOwn(this.fleetConfig?.instances ?? {}, general) || !this.fleetConfig?.instances[general]?.general_topic) { await respond(t("profile.general_only")); return; }
    const ownerId = this.getInstanceAdapterId(general);
    if (!ownerId || ownerId !== ingressAdapterId) { await respond(t("not_authorized")); return; }
    const gate = this.fleetAdminGate(userId, ownerId);
    if (gate !== "ok") { await respond(t(gate === "disabled" ? "profile.disabled" : "not_authorized")); return; }
    const adapter = this.getAdapterForInstance(general);
    const group = String(this.getGroupIdForInstance(general) ?? "");
    const topic = this.fleetConfig.instances[general].topic_id?.toString();
    if (!adapter || this.worlds.get(ownerId)?.adapter !== adapter || !group) { await respond(t("profile.unavailable")); return; }
    let duration: number;
    try { duration = profileDuration(seconds); }
    catch { await respond(t("profile.invalid")); return; }
    let ticket: ProfileTicket;
    try { ticket = await this.startCpuProfile(duration); }
    catch (err) {
      await respond(err instanceof ProfileBusyError ? t("profile.busy", String(err.remainingSeconds)) : t("profile.unavailable"));
      return;
    }
    // A long recording must not hold a Discord interaction (or the inbound handler) open.
    const initial = Promise.resolve().then(() => respond(t("profile.started", String(ticket.seconds))));
    void (async () => {
      await initial.catch(err => this.logger.warn({ err }, "CPU profile acknowledgement failed"));
      let message: string;
      try {
        const result = await ticket.done;
        const size = result.bytes === null ? t("profile.size_unknown") : `${(result.bytes / 1048576).toFixed(2)} MiB`;
        message = t("profile.saved", result.path, size);
      } catch { message = t("profile.failed"); }
      // Never send a delayed artifact path to a replacement adapter/topic/world.
      if (this.shuttingDown || this.getInstanceAdapterId(general) !== ownerId
        || this.getAdapterForInstance(general) !== adapter || String(this.getGroupIdForInstance(general) ?? "") !== group
        || this.fleetConfig?.instances[general]?.topic_id?.toString() !== topic
        || !this.fleetConfig?.instances[general]?.general_topic) return;
      await adapter.sendText(group, message, { threadId: topic });
    })().catch(err => this.logger.warn({ err }, "CPU profile General notice failed"));
    await initial.catch(() => {});
  }

  private async handleRestartSlash(data: ClassicStartSlashData, adapterId: string): Promise<void> {
    if (!this.isFleetAdmin(data.userId, adapterId)) {
      await data.respond(t("not_authorized"));
      return;
    }

    recordInternalRequest(this.dataDir, "restart", `slash /restart ${String(data.options?.mode ?? "graceful")} by ${adapterId}:${data.userId}`);
    if (data.options?.mode !== "full") {
      await data.respond(t("restart.graceful"));
      process.kill(process.pid, "SIGUSR2");
      return;
    }

    // Discord exposes only `full` as a choice. Keep a runtime check anyway: a
    // briefly stale command schema must never turn an unknown value into SIGUSR1.
    const messageId = await data.respond(t("restart.full_preparing"));
    const adapter = this.adapters.get(adapterId) ?? this.adapter;
    if (!messageId || !adapter) {
      this.logger.error({ adapterId, hasMessageId: !!messageId },
        "Full restart response could not be persisted — reload refused");
      await data.respond(t("restart.full_launch_failed"));
      return;
    }
    const chatId = String(this.getChannelConfig(adapterId)?.group_id ?? data.channelId);
    await this.requestFullRestart(adapter, chatId, data.channelId, messageId);
  }

  /** #1302: `/visibility [mode]`. The dispatcher has already applied the command table's fleet-admin gate. */
  private async handleVisibilitySlash(data: ClassicStartSlashData): Promise<void> {
    if (!this.fleetConfig) return;
    const mode = typeof data.options?.mode === "string" ? data.options.mode : "";
    await data.respond(runVisibilityCommand(this.fleetConfig, mode, () => this.saveFleetConfig()));
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

  /**
   * The configured world that owns `chatId`, when that is provably NOT the
   * world `target` lives in. Returns undefined when they agree, when there is
   * nothing to check, or when no configured channel claims the id.
   *
   * Deliberately one-sided: only a POSITIVE match against another channel's
   * group id counts as foreign. A chat id that matches nothing may still be
   * legitimate for this world (a classic channel, a DM), and treating
   * "unrecognised" as "wrong" would stop seeding for cases that work today.
   *
   * Read from config rather than the live worlds map on purpose: a channel
   * whose adapter failed to start still owns its group id, and the coordinates
   * are just as unusable by the target's adapter either way.
   *
   * This is the other half of what scheduleSourceAdapter fixed. That one stops
   * the trigger NOTICE being sent through the wrong bot; this one stops the
   * same coordinates being planted as the target instance's reply context,
   * which is what made its own replies fail until someone spoke to it (#752).
   */
  private scheduleChatWorldMismatch(target: string, chatId?: string): string | undefined {
    if (!chatId) return undefined;
    const targetWorld = this.getInstanceAdapterId(target);
    if (!targetWorld) return undefined;
    const channels = this.fleetConfig?.channels
      ?? (this.fleetConfig?.channel ? [this.fleetConfig.channel] : []);
    // ALL owners, not the first: a persona bot shares the primary's guild
    // (quickstart writes `group_id: primary.group_id`), so one group id is
    // legitimately claimed by two channels. Taking the first match called a
    // persona instance's own guild "another world" and stopped seeding a
    // context it can address perfectly well.
    const owners = channels.filter(ch => ch.group_id != null && String(ch.group_id) === String(chatId));
    if (owners.length === 0) return undefined;
    if (owners.some(ch => (ch.id ?? ch.type) === targetWorld)) return undefined;
    return owners[0].id ?? owners[0].type;
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
  getInstanceAdapterId(name: string): string | undefined {
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

  /** Pure read of the single daemon-owned observation; no probe/capture or second tracker. */
  getInstanceInteraction(name: string): InteractionSnapshot | null {
    if (this.lifecycle.isPaused(name) || this.instanceProcessStatus.has(name)) return null;
    const daemon = this.lifecycle.daemons.get(name);
    if (daemon?.getProcessStatus?.() !== "running") return null;
    return daemon.getInteractionSnapshot?.() ?? null;
  }

  private instancePresentation(name: string) {
    const execution_state = this.getInstanceExecutionState(name);
    const interaction = this.getInstanceInteraction(name);
    return { state: presentationState(execution_state, interaction), execution_state,
      interaction, interaction_summary: interactionSummary(interaction) };
  }

  /**
   * Subscription providers currently relevant to this fleet. Stopped/crashed
   * rows do not keep a usage card alive, while persisted paused instances do.
   * Classic channels use their effective backend merge chain, not the raw row.
   */
  getActiveUsageProviderIds(): ReadonlySet<string> {
    const providers = new Set<string>();
    // Per instance, not per backend: two agents on two kiro subscriptions are
    // two rows, and filtering by the bare backend id would hide both.
    for (const [name, backend, profile] of this.activeBackendBindings()) {
      void name;
      const provider = usageProviderIdForBackend(backend);
      if (!provider) continue;
      providers.add(profile ? `${provider}:${profile}` : provider);
    }
    return providers;
  }

  /** Subscription providers used by the running/paused instances owned by one adapter. */
  getUsageProviderIdsForAdapter(adapterId: string): ReadonlySet<string> {
    const providers = new Set<string>();
    for (const [name, backend, profile] of this.activeBackendBindings()) {
      if (this.getInstanceAdapterId(name) !== adapterId) continue;
      const provider = usageProviderIdForBackend(backend);
      if (!provider) continue;
      providers.add(profile ? `${provider}:${profile}` : provider);
    }
    return providers;
  }

  /** #1220: the login a running classic instance was launched on, from its own config; null when not running. */
  private classicLaunchedProfile(name: string): ClassicProfile | null {
    const launched = this.daemons.get(name)?.getConfigSnapshot?.();
    return launched ? profileOf(launched.backend_options, launched.backend ?? "claude-code") : null;
  }

  /**
   * #1220: whether a running classic instance's login differs from what its
   * configuration now says — compared with what it was launched on, not with an
   * earlier reading of the config (a reload consumes that), and with an invalid
   * setting as a value of its own rather than the shared login it would fall to.
   * A switch on the same backend that loses the conversation (kiro) starts fresh.
   */
  private classicProfileChange(name: string, backendChanged: boolean): { changed: boolean; startsFresh: boolean; from?: string; to?: string } {
    const launched = this.classicLaunchedProfile(name);
    if (!launched || !this.classicChannels) return { changed: false, startsFresh: false };
    const next = this.classicChannels.getCredentialProfileByInstance(name, this.fleetConfig?.defaults);
    if (profileKey(launched) === profileKey(next)) return { changed: false, startsFresh: false };
    const backend = this.classicChannels.getBackendByInstance(name, this.fleetConfig?.defaults?.backend);
    return {
      changed: true,
      // A backend change keeps its own (existing) restart semantics.
      startsFresh: !backendChanged && credentialSwitchStartsFresh(backend),
      from: profileKey(launched),
      to: profileKey(next),
    };
  }

  /** `[instance, effective backend, credential profile]` for everything that is
   * running or paused — the one place both usage views agree on who is live. */
  private activeBackendBindings(): Array<[string, string, string | null]> {
    const bindings: Array<[string, string, string | null]> = [];
    const add = (name: string, backend: string | undefined, profile: string | null) => {
      const status = this.getInstanceStatus(name);
      if (status !== "running" && status !== "paused") return;
      if (backend) bindings.push([name, backend, profile]);
    };
    for (const [name, config] of Object.entries(this.fleetConfig?.instances ?? {})) {
      // loadFleetConfig() has already merged the fleet default into each row.
      const backend = config.backend ?? this.fleetConfig?.defaults?.backend ?? "claude-code";
      add(name, backend, instanceCredentialProfile(config, this.fleetConfig?.defaults, backend));
    }
    for (const channel of this.classicChannels?.getAll() ?? []) {
      const backend = this.classicChannels?.getBackendByInstance(
        channel.instanceName,
        this.fleetConfig?.defaults?.backend,
      );
      // The login it was launched on; before a launch, the one it would get (#1220).
      add(channel.instanceName, backend, profileName(this.classicLaunchedProfile(channel.instanceName)
        ?? this.classicChannels!.getCredentialProfileByInstance(channel.instanceName, this.fleetConfig?.defaults)));
    }
    return bindings;
  }

  /** Effective backends with a running or persisted-paused fleet/Classic instance. */
  getActiveBackendIds(): ReadonlySet<string> {
    return new Set(this.activeBackendBindings().map(([, backend]) => backend));
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
    // The dashboard's "working" line and its Stop button follow the edges, not the heartbeat.
    if (previous?.state !== state) this.emitSseEvent("activity", { instance: name, state: this.getInstanceExecutionState(name) });
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
    // Bind this edge to the publication that was current when idle was
    // observed. A later inbound may start a new generation before this timer
    // fires; the old edge must not mark that newer button for retirement.
    const publication = this.cancelButtonPublications.get(name);
    const timer = setTimeout(() => {
      // Ignore a superseded timer even if it was already queued to run.
      if (this.cancelButtonIdleRetireTimers.get(name) !== timer) return;
      this.cancelButtonIdleRetireTimers.delete(name);
      if (this.getInstanceExecutionState(name) === "idle") {
        this.markCancelButtonPublicationForRetirement(name, publication);
        this.retireInstanceButtons(name);
      }
    }, CANCEL_BTN_IDLE_RETIRE_GRACE_MS);
    timer.unref?.();
    this.cancelButtonIdleRetireTimers.set(name, timer);
  }

  private cacheInstanceProcessStatus(name: string, status: unknown): void {
    // #1386: every transition into crashed is a new occurrence (a new "Needs you" item), and every other status ends
    // the previous one — at once, not when the coalesced collector next runs: running then crashed in one IPC chunk is
    // a second crash (#1398 review r2). The collector still recovers a missed running event.
    if (status === "crashed") { if (this.instanceProcessStatus.get(name) !== "crashed") this.needsCrashedAt.set(name, Date.now()); }
    else this.needsCrashedAt.delete(name);
    this.needsYou?.poke();
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
    if (this.instanceStateCache.delete(name)) this.emitSseEvent("activity", { instance: name, state: null });
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
      // A work lease (Phase 2a) keeps a just-woken or mid-submission instance
      // out of the eviction candidates; it is not idle in the sense that matters.
      isIdle: name => this.getInstanceExecutionState(name) === "idle" && !this.lifecycle.hasWorkLease(name),
      lastInboundAt: name => readLastInboundAt(this.getInstanceDir(name)) ?? 0,
    });
    for (const victim of victims) {
      this.warmCapEvicting.add(victim);
      this.logger.info({ instance: victim, warm: warm.length, cap }, "warm_cap exceeded — auto-pausing LRU idle instance");
      this.lifecycle.pause(victim, "warm_cap")
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
          // The daemon owns the backend/TTY proof and its 10s startup-input
          // timer. A cache-only query can never discover a Context-less idle
          // pane, and a second fleet timer would stack another 10s wait.
          ipc.send({ type: "query_instance_state", requestId: `idle-gate-${Date.now()}`, deliveryIdle: true });
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
   * cache-only; delivery idle gates opt into their own pane/input proof, and
   * this refresh serves lifecycle decisions where a stale state would strand UI.
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
    noInlineWake = false,
    stillCurrent?: () => boolean,
  ): Promise<boolean> {
    if (this.shuttingDown || !this.deliveryCurrent(instanceName, deliveryEpoch, stillCurrent)) return false;
    await this.holdDeliveryForStorm(instanceName, deliveryEpoch);
    if (this.shuttingDown || !this.deliveryCurrent(instanceName, deliveryEpoch, stillCurrent)) return false;
    let idleObservedAfter = this.lastDeliveryAt.get(instanceName) ?? 0;
    if (this.lifecycle.isPaused(instanceName) && noInlineWake) {
      // Paused after its row was claimed (an operator or auth pause): hand the
      // row back; the coordinator decides whether and when to wake it.
      this.wakeCoordinator?.kick();
      return false;
    }
    if (this.lifecycle.isPaused(instanceName)) {
      const wakeStartedAt = Date.now();
      await this.explicitWake(instanceName, 30_000);
      if (!this.deliveryCurrent(instanceName, deliveryEpoch, stillCurrent)) return false;
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
      () => !this.deliveryCurrent(instanceName, deliveryEpoch, stillCurrent),
    );
    if (!this.deliveryCurrent(instanceName, deliveryEpoch, stillCurrent)) {
      this.logger.info({ instanceName }, "Pending delivery dropped by user cancel");
      return false;
    }
    // A server crash can land while waitForInstanceIdle is pending. Re-check
    // immediately before the old timeout path would force text into a boot UI.
    await this.holdDeliveryForStorm(instanceName, deliveryEpoch);
    if (this.shuttingDown || !this.deliveryCurrent(instanceName, deliveryEpoch, stillCurrent)) return false;
    if (!idle) {
      this.logger.warn({ instanceName, timeoutMs }, "Idle gate timed out; forcing delivery");
    }
    const sent = await this.sendWhenConnected(instanceName, payload, deliveryEpoch, stillCurrent);
    if (!sent) return false;
    if (this.deliveryCurrent(instanceName, deliveryEpoch, stillCurrent)) {
      this.lastDeliveryAt.set(instanceName, Date.now());
    }
    return true;
  }

  private async holdDeliveryForStorm(instanceName: string, deliveryEpoch: number): Promise<void> {
    if (!this.stormWindow.isDeliveryHeld(instanceName)) return;
    this.logger.warn({ instanceName, deliveryEpoch }, "Delivery held during tmux server recovery");
    await this.stormWindow.waitForDeliveryAllowed(instanceName);
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
    stillCurrent?: () => boolean,
  ): Promise<boolean> {
    if (!this.deliveryCurrent(instanceName, deliveryEpoch, stillCurrent)) return false;
    const queued = this.ipcWaitTails.get(instanceName);
    if (!queued) {
      const ipc = this.instanceIpcClients.get(instanceName);
      if (ipc?.connected && ipc.send(payload)) return true;
    }

    const attempt = (queued ?? Promise.resolve())
      .catch(() => { /* a previous waiter's failure must not cancel this one */ })
      .then(() => {
        if (!this.deliveryCurrent(instanceName, deliveryEpoch, stillCurrent)) return false;
        return this.sendAfterIpcReturns(instanceName, payload, deliveryEpoch, stillCurrent);
      });
    // The chain stores a settled-either-way promise so one failed delivery cannot
    // wedge every later one, and so `queued` above is safe to await unguarded.
    const tail = attempt.then(() => {}, () => {});
    this.ipcWaitTails.set(instanceName, tail);
    try {
      return await attempt;
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
    stillCurrent?: () => boolean,
  ): Promise<boolean> {
    const deadline = Date.now() + IPC_RECONNECT_GRACE_MS;
    let warned = false;
    for (;;) {
      if (!this.deliveryCurrent(instanceName, deliveryEpoch, stillCurrent)) return false;
      // Re-read every round: a reconnect replaces the IpcClient object entirely,
      // so a cached reference would stay dead forever.
      const ipc = this.instanceIpcClients.get(instanceName);
      if (ipc?.connected && ipc.send(payload)) return true;
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

  /**
   * Reserve the display echo before IPC handoff: a fast reply cannot overtake
   * it. The web request settles admission without awaiting the platform POST.
   * Only accepted messages send an echo; failures release replies normally.
   * Each reservation has a 5s total monotonic ordering budget (queue/admission
   * included). Expiry drops unstarted copies and releases replies. An adapter
   * request already in flight may land late, but cannot retain the ordering lane.
   */
  /**
   * Post an owner web-chat echo to every ClassicBot channel entry opted in
   * for `instance` (#1320 part B). Per entry: the channel's own adapter, no
   * thread, mention suppression on. Returns the number of channels posted
   * to. Failures are per-entry warn-and-continue — a failed echo never fails
   * the web send. Entries without `web_echo: true` are never touched.
   *
   * Every copy is fenced at start time: an entry whose explicit world is
   * gone is skipped (only legacy adapterId-less entries fall back to the
   * primary adapter); when running under a reservation, an exhausted
   * ordering budget or a revoked delivery epoch stops the loop, and each
   * entry is re-resolved against current registration so a removed opt-in
   * or a rebound adapter is never posted through a stale route. A copy
   * already in flight may still land late — the contract permits that.
   */
  async sendClassicWebEcho(instance: string, text: string): Promise<number> {
    const guard = this.webChannelEchoGuards.get(instance);
    const handled = new Set<string>();
    let posted = 0;
    for (;;) {
      if (guard) {
        if (performance.now() >= guard.deadlineAt) {
          this.logger.warn({ instance, posted }, "Classic web echo stopped: ordering budget exhausted");
          break;
        }
        if (!this.isDeliveryEpochCurrent(instance, guard.epoch)) {
          this.logger.warn({ instance, posted }, "Classic web echo stopped: delivery epoch revoked");
          break;
        }
      }
      const entry = (this.classicChannels?.getAll() ?? [])
        .find(candidate => candidate.instanceName === instance && candidate.webEcho === true
          && !handled.has(`${candidate.channelId}#${candidate.adapterId ?? ""}`));
      if (!entry) break;
      handled.add(`${entry.channelId}#${entry.adapterId ?? ""}`);
      const worldAdapter = entry.adapterId ? this.worlds.get(entry.adapterId)?.adapter : undefined;
      if (entry.adapterId && !worldAdapter) {
        this.logger.warn({ instance, channelId: entry.channelId, adapterId: entry.adapterId },
          "Classic web echo skipped: adapter world unavailable");
        continue;
      }
      const adapter = worldAdapter ?? this.adapter;
      try {
        if (!adapter?.sendText) continue;
        await adapter.sendText(entry.channelId, text, { format: "text", allowedMentions: { parse: [] } });
        ClassicChannelManager.logMessage(instance, "web-user", text, new Date());
        posted++;
      } catch (err) {
        this.logger.warn({ err, instance, channelId: entry.channelId }, "Classic web echo failed");
      }
    }
    return posted;
  }

  reserveWebChannelEcho(instanceName: string, sendEcho: () => Promise<unknown>): (accepted: boolean) => void {
    const epoch = this.getDeliveryEpoch(instanceName);
    const deadlineAt = performance.now() + 5_000;
    let decide!: (accepted: boolean) => void;
    const admission = new Promise<boolean>(resolve => { decide = resolve; });
    const queue = this.webChannelEchoTails.get(instanceName)
      ?? { tail: Promise.resolve(), pending: new Set<{ started: boolean; drop: () => void }>() };
    const previous = queue.tail;
    let resolveDone!: () => void;
    const tail = new Promise<void>(resolve => { resolveDone = resolve; });
    let done = false, expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let guard: { epoch: number; deadlineAt: number } | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      queue.pending.delete(entry);
      if (guard && this.webChannelEchoGuards.get(instanceName) === guard) {
        this.webChannelEchoGuards.delete(instanceName);
      }
      resolveDone();
    };
    const entry = { started: false, drop: () => {
      this.logger.warn({ instanceName }, "Queued web channel echo dropped after ordering timeout");
      finish();
    } };
    const expire = () => {
      if (done) return;
      expired = true;
      this.logger.warn({ instanceName, inFlight: entry.started }, "Web channel echo ordering timed out");
      finish();
      // Do not post copies that were queued behind an ambiguous platform send.
      for (const pending of queue.pending) if (!pending.started) pending.drop();
    };
    const checkDeadline = () => {
      if (done) return;
      const remaining = deadlineAt - performance.now();
      if (remaining <= 0) expire();
      else timer = setTimeout(checkDeadline, Math.ceil(remaining));
    };
    queue.pending.add(entry);
    queue.tail = tail;
    this.webChannelEchoTails.set(instanceName, queue);
    checkDeadline();
    void Promise.all([previous, admission]).then(([, accepted]) => {
      if (done) return;
      if (!accepted || !this.isDeliveryEpochCurrent(instanceName, epoch)) { finish(); return; }
      // A delayed timer callback must not admit an already expired copy.
      if (performance.now() >= deadlineAt) { expire(); return; }
      entry.started = true;
      guard = { epoch, deadlineAt };
      this.webChannelEchoGuards.set(instanceName, guard);
      let request: Promise<unknown>;
      try { request = Promise.resolve(sendEcho()); }
      catch (err) { request = Promise.reject(err); }
      void request.then(() => {
        if (expired) this.logger.warn({ instanceName }, "Web channel echo completed late after ordering timeout");
        finish();
      }, err => {
        this.logger.warn({ err, instanceName }, expired
          ? "Web channel echo failed late after ordering timeout" : "Web channel echo failed");
        finish();
      });
    });
    void tail.then(() => {
      if (this.webChannelEchoTails.get(instanceName) === queue && queue.tail === tail && queue.pending.size === 0) {
        this.webChannelEchoTails.delete(instanceName);
      }
    });
    return decide;
  }

  /** Whether this target already has an ordinary non-user delivery in its FIFO. */
  hasPendingIdleGatedDelivery(instanceName: string): boolean {
    return this.idleGatedDeliveryTails.has(instanceName);
  }

  /** The running launch's own steer capability (#1405); undefined for a backend without one, or no running Daemon. */
  instanceLaunchSupportsSteer(instanceName: string): boolean | undefined {
    return this.daemons.get(instanceName)?.launchSupportsSteer();
  }

  /** Single delivery facade: wake paused CLIs and serialize non-user work behind idle. */
  async deliverToInstance(
    instanceName: string,
    payload: Record<string, unknown>,
    options: DeliveryOptions = {},
  ): Promise<boolean | void> {
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
        if (options.noInlineWake) { this.wakeCoordinator?.kick(); return false; }
        await this.explicitWake(instanceName, 30_000);
        if (!this.deliveryCurrent(instanceName, deliveryEpoch, options.stillCurrent)) return false;
        this.enforceWarmCap(instanceName); // woke one → evict a different LRU idle if over cap
      }
      const sent = await this.sendWhenConnected(instanceName, deliveryPayload, deliveryEpoch, options.stillCurrent);
      if (!sent) return false;
      // A cross-instance item arriving before the daemon observes this turn as
      // working must not trust the stale idle snapshot from before the send.
      if (this.deliveryCurrent(instanceName, deliveryEpoch, options.stillCurrent)) {
        this.lastDeliveryAt.set(instanceName, Date.now());
      }
      return true;
    }

    const previous = this.idleGatedDeliveryTails.get(instanceName) ?? Promise.resolve();
    const delivery = previous.catch(() => {}).then(() => this.deliverWithIdleGate(
      instanceName,
      deliveryPayload,
      options.idleTimeoutMs ?? 60_000,
      deliveryEpoch,
      options.noInlineWake === true,
      options.stillCurrent,
    ));
    this.idleGatedDeliveryTails.set(instanceName, delivery);
    try {
      return await delivery;
    } finally {
      if (this.idleGatedDeliveryTails.get(instanceName) === delivery) {
        this.idleGatedDeliveryTails.delete(instanceName);
      }
    }
  }

  /**
   * The fleet-admin list of exactly this adapter (#754): its `access.allowed_users`, read from fleet.yaml. An adapter
   * id that matches no configured channel and no running adapter has NO list — it is never answered with the primary
   * channel's, as `getChannelConfig` would. No id at all means the primary adapter, a single-adapter fleet's only one.
   */
  private adminListOf(adapterId?: string): string[] | null {
    const channels = this.fleetConfig?.channels ?? (this.fleetConfig?.channel ? [this.fleetConfig.channel] : []);
    const id = adapterId ?? this.getPrimaryAdapterId();
    if (!id) return null;
    const config = channels.find(ch => (ch.id ?? ch.type) === id) ?? this.worlds.get(id)?.channelConfig;
    return config ? (config.access?.allowed_users ?? []).map(String) : null;
  }

  /**
   * The one fleet-admin gate (#754): is this user an admin of the adapter that OWNS what they are acting on — the
   * target instance's or General's adapter, never merely the one the request arrived on. An empty list means nobody
   * (`disabled`, so the reply can say admin commands are off); an unknown adapter means nobody either (`denied`).
   * Fleet admin is an explicit config entry: a paired or open-mode user is not one.
   */
  adminGate(userId: string, ownerAdapterId?: string): "ok" | "disabled" | "denied" {
    const list = this.adminListOf(ownerAdapterId);
    if (!list) return "denied";
    if (list.length === 0) return "disabled";
    return list.includes(String(userId)) ? "ok" : "denied";
  }

  /** Fleet admin is an explicit config allowlist entry, not merely an open/paired user. See adminGate. */
  isFleetAdmin(userId: string, adapterId?: string): boolean {
    return this.adminGate(userId, adapterId) === "ok";
  }

  /** Whether this adapter has any fleet admin at all (an empty allowlist means the admin commands are off). */
  hasFleetAdmins(adapterId?: string): boolean {
    return (this.adminListOf(adapterId)?.length ?? 0) > 0;
  }

  /**
   * The one question the privileged commands (/update, /doctor, /dashboard, /collab) ask: may THIS caller,
   * through THIS adapter, run it. `disabled` is "nobody can" — an empty list — and is told apart from
   * `denied` only so the reply can say so. An empty list never means "everyone": these commands used to read
   * the primary channel's list and treat empty as open, so on a fleet that had not set one anyone who could
   * type a slash command could `/update` the host.
   */
  fleetAdminGate(userId: string, adapterId?: string): "ok" | "disabled" | "denied" {
    return this.adminGate(userId, adapterId);
  }

  private runtimeCpuProfiler: RuntimeCpuProfiler | null = null;
  private cpuProfileControl: ProfileControlServer | null = null;

  private getCpuProfiler(): RuntimeCpuProfiler {
    if (!this.runtimeCpuProfiler || (this.runtimeCpuProfiler.closed && !this.shuttingDown)) {
      this.runtimeCpuProfiler = new RuntimeCpuProfiler({ dataDir: this.dataDir,
        logger: { info: message => this.logger.info(message), warn: message => this.logger.warn(message) } });
    }
    return this.runtimeCpuProfiler;
  }

  /** Called only by cold CLI startup, after claiming the fleet singleton. */
  async startCpuProfileControl(): Promise<void> {
    if (this.shuttingDown || this.cpuProfileControl) return;
    const control = new ProfileControlServer(this.dataDir, this.getCpuProfiler());
    this.cpuProfileControl = control; // shutdown owns even an in-flight listen
    try { await control.listen(); }
    catch (err) { if (this.cpuProfileControl === control) this.cpuProfileControl = null; throw err; }
  }

  startEnvironmentCpuProfile(): Promise<CpuProfile | null> { return this.getCpuProfiler().startFromEnvironment(); }

  startCpuProfile(seconds?: string | number): Promise<ProfileTicket> {
    if (this.shuttingDown) return Promise.reject(new Error("Fleet is stopping."));
    return this.getCpuProfiler().start(seconds);
  }

  /**
   * Every Discord slash command, for every adapter, in one place (it used to be two copies that could drift).
   *
   * Two checks before any command's own code runs, and the order matters: the DOOR (src/slash-authz.ts — may
   * this caller speak here at all) and then the COMMAND TABLE (src/command-table.ts — does this command apply
   * in this kind of channel, and which kind of admin does it need). The table can only narrow what the door
   * let through. A command nobody registered is answered, not left to time out.
   *
   * The door, the table and the start of the command run in one synchronous stretch (#1399 review): no await between
   * the check and the act, so the channel's instance cannot be rebound to another bot in between.
   */
  private async dispatchSlash(data: ClassicStartSlashData, adapterId: string, adapter: ChannelAdapter): Promise<void> {
    const door = this.slashDoor(data, adapterId);
    if ("refusal" in door) {
      await data.respond(t(door.refusal)).catch(() => { /* the interaction may already be gone */ });
      return;
    }
    const scope = door.scope;

    const spec = commandSpec(data.command);
    if (!spec) {
      this.logger.info({ command: data.command, adapterId }, "Slash command is not in the command table");
      await data.respond(t("slash.unknown_command")).catch(() => { /* the interaction may already be gone */ });
      return;
    }
    const decision = decideCommand(spec, scope, {
      fleetAdmin: () => this.fleetAdminGate(data.userId, adapterId),
      channelAdmin: () => this.isModelAdmin(data.userId, data.channelId, adapterId),
      classicAdmin: () => !!this.classicChannels?.isAdmin(data.userId),
    });
    if (!decision.allow) {
      this.logger.info({ command: data.command, adapterId, scope, reply: decision.reply[0] }, "Slash command refused by the command table");
      const [key, ...args] = decision.reply;
      await data.respond(t(key, ...args)).catch(() => { /* the interaction may already be gone */ });
      return;
    }

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
      const status = this.resolveStatusEmojisFor(name, adapterId, adapter);
      const replyMsgId = await data.respond(textForm(status.platform, status.received));
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
      // load is kiro-cli/classic only — no claude-code equivalent. (Classic admins only: the command table.)
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
      // The scope the door and the table authorized is the scope this acts in. A channel can be in both the
      // ClassicBot registry and the routing table (two configurations that each validate); the door and
      // `isModelAdmin` read the registry first, so a ClassicBot admin was judged for the ClassicBot channel
      // here and must not be handed the fleet instance's collab switch by a second, routing-first lookup.
      const collabTarget2 = scope === "classic" ? undefined : this.routing.resolve(data.channelId);
      if (collabTarget2) {
        const isCollab = this.toggleFleetCollab(collabTarget2.name);
        await data.respond(isCollab ? t("collab.on") : t("collab.off"));
        return;
      }
      if (!this.classicChannels?.isClassicChannel(data.channelId, adapterId)) {
        await data.respond(t("classic.no_agent_start"));
        return;
      }
      const newState = this.classicChannels.toggleCollab(data.channelId, adapterId);
      await data.respond(newState
        ? t("collab.on.classic")
        : t("collab.off.classic"));
    } else if (data.command === "update") {
      await this.handleUpdateSlash(data, adapterId);
    } else if (data.command === "profile") {
      await this.handleProfileSlash(data, adapterId);
    } else if (data.command === "doctor") {
      await data.respond(await this.runBackendDoctor());
    } else if (data.command === "visibility") {
      await this.handleVisibilitySlash(data);
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
      // Slash commands are Discord-only; use plain lines (no markdown table)
      await this.topicCommands.sendSysInfo(text => data.respond(text), { platform: "discord" });
    } else if (data.command === "dashboard") {
      if (String(data.options?.action ?? "").trim().toLowerCase() === "revoke") {
        const result = this.revokeWebSessions();
        await data.respond(result.durable ? t("dashboard.revoked", result.count) : t("dashboard.revoked_not_durable", result.count));
      } else {
        const owner = this.dashboardOwner(data.userId, adapterId, data.channelId);
        if (!owner) { await this.sendLocalDashboard(data, adapterId); return; }
        // Discord shows a deferred reply that is never answered as "the application did not respond".
        if (!await this.showDashboardMenu(owner, data.respondButtons, data.retireButtons)) await data.respond(t("dashboard.menu_failed"));
      }
    } else if (data.command === "restart") {
      await this.handleRestartSlash(data, adapterId);
    } else if (data.command === "compact") {
      const name = this.resolveSlashTarget(data.channelId, adapterId);
      if (!name) { await data.respond(t("classic.no_agent")); return; }
      const result = await this.topicCommands.sendCompact(name, String(data.options?.instructions ?? ""));
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
    }
  }

  /**
   * The door every Discord slash command goes through (src/slash-authz.ts has the rule and the reasoning): the scope
   * it lets the command into, or the reply that refuses it. Synchronous, so the dispatch acts on what it judged.
   */
  private slashDoor(data: ClassicStartSlashData, adapterId: string): { scope: CommandScope } | { refusal: string } {
    const channelId = data.channelId;
    const classic = !!this.classicChannels?.isClassicChannel(channelId, adapterId);
    const fleetTarget = classic ? undefined : this.routing.resolve(channelId);
    const scope: SlashScope = classic ? "classic" : fleetTarget ? "fleet" : "none";
    // The table tells the General dispatcher from an instance's own channel; the door does not need to.
    const commandScope: CommandScope = classic ? "classic" : fleetTarget ? (fleetTarget.kind === "general" ? "general" : "fleet") : "none";

    let speaker: SlashSpeaker = "denied";
    if (scope !== "classic") {
      // The same world the typed-message path would consult: the adapter that owns the channel's instance,
      // else the one the command arrived on.
      const ownerId = fleetTarget ? this.getInstanceAdapterId(fleetTarget.name) : undefined;
      const ownerWorld = ownerId ? this.worlds.get(ownerId) : undefined;
      if (ownerId && !ownerWorld) {
        speaker = "owner-not-running";
      } else {
        const am = ownerWorld?.accessManager ?? this.worlds.get(adapterId)?.accessManager ?? this.accessManager;
        // An explicit fleet admin always speaks, even if the access state file disagrees with the config.
        speaker = this.isFleetAdmin(data.userId, adapterId) || (am?.isAllowed(data.userId) ?? false) ? "allowed" : "denied";
      }
    }

    const spec = commandSpec(data.command);
    const rule = spec ? ruleFor(spec, commandScope, "discord") : undefined;
    const facts: SlashFacts = {
      command: data.command,
      guildId: data.guildId,
      primaryGuildId: String(this.getChannelConfig(adapterId)?.group_id ?? ""),
      scope,
      speaker,
      // The table's level, plus the fleet-admin modes of a command whose handler decides by its options: /tips with a
      // mode saves fleet config or unlocks tips; bare /tips only draws one (#1396 review).
      fleetAdminCommand: (!!rule && "level" in rule && rule.level === "fleet-admin")
        || (data.command === "tips" && typeof data.options?.mode === "string" && data.options.mode.trim() !== ""),
      otherBotOwns: !!fleetTarget && !!this.getInstanceAdapterId(fleetTarget.name) && this.getInstanceAdapterId(fleetTarget.name) !== adapterId,
    };
    const decision = decideSlash(facts);
    if (decision.allow) return { scope: commandScope };

    this.logger.info(
      { command: data.command, reason: decision.reason, adapterId, guildId: data.guildId ?? null, channelId, scope },
      "Slash command refused",
    );
    return { refusal: decision.reason === "dm" ? "slash.dm_unsupported"
      : decision.reason === "wrong-guild" ? "slash.wrong_server"
      : decision.reason === "other-bot" ? "slash.other_bot"
      : "not_authorized" };
  }

  /** Phase 2: delivery_worker for a target (instance override → fleet default → wake_only). */
  deliveryWorkerMode(target: string): ReturnType<typeof resolveDeliveryWorkerMode> {
    return resolveDeliveryWorkerMode(this.fleetConfig, target);
  }

  /** Active instances mid-restart: they keep their warm slot through the stop → replacement gap. */
  private restartsHoldingSlot = new Set<string>();

  /**
   * Instances counted against the wake coordinator's hard cap: running
   * daemons, plus active instances whose restart is between stopping the old
   * daemon and publishing the replacement.
   */
  private warmInstanceNames(): string[] {
    const names = new Set([...this.daemons.keys()].filter(name => this.getInstanceStatus(name) === "running"));
    for (const name of this.restartsHoldingSlot) names.add(name);
    return [...names];
  }

  private createWakeCoordinator(): WakeCoordinator {
    return new WakeCoordinator({
      mode: target => this.deliveryWorkerMode(target),
      available: () => !this.shuttingDown && this.deliveryOutbox?.isOpen === true,
      listPending: () => this.deliveryOutbox?.listPending() ?? [],
      isPaused: target => this.lifecycle.isPaused(target),
      pauseReason: target => readPauseReason(this.getInstanceDir(target)),
      isRestarting: target => this.isInstanceRestarting(target),
      wake: async target => {
        await this.lifecycle.wake(target, 30_000, undefined, { source: "coordinator" });
        // The soft cap still applies: evict a different, unleased idle instance.
        this.enforceWarmCap(target);
      },
      residentNames: () => this.warmInstanceNames(),
      warmCap: () => this.fleetConfig?.defaults?.warm_cap ?? 0,
      warmOverflow: () => this.fleetConfig?.defaults?.warm_overflow ?? DEFAULT_WARM_OVERFLOW,
      wokeAt: target => this.lifecycle.wokeAtFor(target),
      notAcceptingReason: target => this.daemons.get(target)?.notAcceptingReason?.() ?? null,
      notifyTarget: (target, text) => { this.notifyInstanceTopic(target, text); },
      notifySender: (source, text) => { this.notifyInstanceTopic(source, text); },
      kickPump: () => this.scheduleDeliveryOutboxPump(),
      now: () => Date.now(),
      logger: this.logger,
    });
  }

  /** LifecycleContext: an operator or user wake clears the coordinator's park/backoff for it. */
  onExternalWake(name: string): void {
    this.wakeCoordinator?.noteExternalWake(name);
  }

  /**
   * Phase 2b shared warm-slot admission (design §1.3, §1.6) for every wake
   * that is not the coordinator's own: an operator's wake, a user's message,
   * an explicit start or a restart of a paused instance. With delivery_worker
   * off, or for a target that is not paused (an active restart is already
   * counted), nothing is reserved. A target already being woken is joined —
   * its flight holds the slot — rather than reserved twice. Otherwise a slot
   * is taken under the hard cap, an unleased idle instance is paused to make
   * one, and if none can be, the wake is refused instead of exceeding the cap.
   */
  private async acquireWakeSlot(name: string): Promise<symbol | null> {
    const coordinator = this.wakeCoordinator;
    if (!coordinator || this.deliveryWorkerMode(name) === "off" || !this.lifecycle.isPaused(name)) return null;
    if (coordinator.isWaking(name)) return null;
    let token = coordinator.tryReserve(name);
    if (!token) {
      const victim = this.lruUnleasedIdle(name);
      if (victim) {
        await this.lifecycle.pause(victim, "warm_cap");
        if (coordinator.isWaking(name)) return null;
        token = coordinator.tryReserve(name);
      }
    }
    if (!token) {
      throw new Error(`No warm slot is free for '${name}' (warm_cap + overflow reached and no idle instance can be paused); try again when one goes idle`);
    }
    return token;
  }

  private releaseWakeSlot(name: string, token: symbol | null): void {
    if (!token || !this.wakeCoordinator) return;
    this.wakeCoordinator.release(name, token);
    this.wakeCoordinator.kick();
  }

  /**
   * An operator's or user's wake (/wake, wake_instance, start_instance on a
   * paused instance, Settings, a channel message). With delivery_worker off it
   * is exactly the old lifecycle wake; otherwise it goes through the shared
   * slot admission and joins any wake already in flight for the target.
   */
  async explicitWake(name: string, timeoutMs = 30_000): Promise<void> {
    const token = await this.acquireWakeSlot(name);
    try {
      await this.lifecycle.wake(name, timeoutMs);
    } finally {
      this.releaseWakeSlot(name, token);
    }
  }

  /** The least-recently-active idle, unleased, non-general running instance other than `exclude`. */
  private lruUnleasedIdle(exclude: string): string | undefined {
    return this.warmInstanceNames()
      .filter(name => name !== exclude
        && !this.warmCapEvicting.has(name)
        && !isGeneralInstance(this.fleetConfig, name)
        && this.getInstanceExecutionState(name) === "idle"
        && !this.lifecycle.hasWorkLease(name))
      .sort((a, b) => (readLastInboundAt(this.getInstanceDir(a)) ?? 0) - (readLastInboundAt(this.getInstanceDir(b)) ?? 0))[0];
  }

  async changeInstancePauseState(name: string, action: "pause" | "wake"): Promise<"paused" | "awake" | "not_idle"> {
    if (action === "wake") {
      await this.explicitWake(name, 30_000);
      this.enforceWarmCap(name); // manual wake still respects the fleet warm cap
      return "awake";
    }
    if (isGeneralInstance(this.fleetConfig, name)) {
      throw new Error(GENERAL_PAUSE_ERROR);
    }
    await this.lifecycle.pause(name);
    return this.lifecycle.isPaused(name) ? "paused" : "not_idle";
  }

  /** Deliver an already-resolved hot snapshot without depending on IPC timing. */
  private applyHotConfigUpdate(instanceName: string, update: Record<string, unknown>): boolean {
    const daemon = this.daemons.get(instanceName);
    if (!daemon) return false;
    const ipc = this.instanceIpcClients.get(instanceName);
    const sent = ipc?.connected === true && ipc.send({ type: "config_update", config: update });
    if (!sent) {
      daemon.applyConfigUpdate(update);
      this.logger.warn({ name: instanceName }, "Config-update IPC unavailable — applied hot config in-process");
    }
    return true;
  }

  private classicBehaviorUpdate(instanceName: string): Record<string, unknown> {
    return {
      tool_progress: this.classicChannels?.getToolProgressByInstance(
        instanceName,
        this.fleetConfig?.defaults?.tool_progress,
      ) ?? "off",
      reply_completion_guard: this.classicChannels?.getReplyCompletionGuardByInstance(
        instanceName,
        this.fleetConfig?.defaults?.reply_completion_guard,
      ) ?? true,
    };
  }

  /** Compensation retains this transaction's exact instance owner across its own transitions. */
  captureClassicSettingsRestoration(instanceName: string, changedFields: string[], execution?: SettingsExecution): () => Promise<void> {
    const generation = this.settingsGeneration;
    const receipt = { instanceName, epoch: this.lifecycle.epochOf(instanceName), daemon: this.daemons.get(instanceName) as object | undefined };
    if (execution) this.classicSettingsOwners.set(execution, receipt);
    return async () => {
      const cleanup = new SettingsExecution({ current: () => !this.shuttingDown && this.settingsGeneration === generation
        && this.lifecycle.epochOf(instanceName) === receipt.epoch && this.daemons.get(instanceName) === receipt.daemon, snapshot: () => null });
      this.classicSettingsOwners.set(cleanup, receipt);
      try { cleanup.assert(); await this.restartClassicInstanceFromSettings(instanceName, changedFields, cleanup); }
      finally { cleanup.close(); }
    };
  }

  /** Apply a Settings edit to a ClassicBot channel without waiting for the poller. */
  async restartClassicInstanceFromSettings(instanceName: string, changedFields: string[] = [], execution?: SettingsExecution): Promise<void> {
    return this.lifecycle.runTransition(instanceName, transition => this.restartClassicSettingsOwned(instanceName, changedFields, execution, transition));
  }

  private async restartClassicSettingsOwned(instanceName: string, changedFields: string[], execution: SettingsExecution | undefined, transition: TransitionHandle): Promise<void> {
    const generation = this.settingsGeneration;
    const receipt = execution ? this.classicSettingsOwners.get(execution) : undefined;
    const check = (): void => {
      execution?.assert();
      if (this.shuttingDown || this.settingsGeneration !== generation || receipt &&
        (receipt.instanceName !== instanceName || receipt.epoch !== this.lifecycle.epochOf(instanceName) || receipt.daemon !== this.daemons.get(instanceName)))
        throw new Error("Classic restart superseded");
    };
    check();
    if (!this.classicChannels) throw new Error("Classic channel manager not initialized");
    const wasRunning = this.daemons.has(instanceName);
    this.classicChannels.reloadFromDisk();
    this.reportClassicUnrecoverableIds();
    this.reregisterClassicChannels();
    const channel = this.classicChannels.getAll().find(item => item.instanceName === instanceName);
    if (!channel) throw new Error("Classic channel not found after reload");
    if (!wasRunning) return;
    const hotOnly = changedFields.length > 0
      && changedFields.every(field => CLASSIC_HOT_CONFIG_KEYS.has(field));
    if (hotOnly) {
      this.applyHotConfigUpdate(instanceName, this.classicBehaviorUpdate(instanceName));
      this.logger.info({ instanceName, fields: changedFields }, "Classic instance hot config reloaded");
      return;
    }
    const stopping = this.stopInstance(instanceName, transition);
    // stop() invalidates synchronously in our transition. Keep only that exact acquisition.
    if (receipt && this.lifecycle.epochOf(instanceName) === receipt.epoch + 1 && this.daemons.get(instanceName) === receipt.daemon) receipt.epoch++;
    await stopping;
    if (receipt && this.lifecycle.epochOf(instanceName) === receipt.epoch && !this.daemons.has(instanceName)) receipt.daemon = undefined;
    check();
    const stoppedEpoch = this.lifecycle.epochOf(instanceName);
    await new Promise(resolve => setTimeout(resolve, 250)); check();
    if (this.lifecycle.epochOf(instanceName) !== stoppedEpoch) throw new Error("Classic restart superseded by stop");
    await this.startClassicInstance(
      instanceName,
      this.classicChannels.getBackendByInstance(instanceName, this.fleetConfig?.defaults?.backend),
      this.classicChannels.getPreTaskCommand(channel.channelId, channel.adapterId),
      this.classicChannels.getModel(channel.channelId, channel.adapterId, this.fleetConfig?.defaults?.model),
      this.classicChannels.getAutoPauseAfter(channel.channelId, channel.adapterId, this.fleetConfig?.defaults?.auto_pause_after),
      transition, execution,
    );
    check();
  }

  /** Reload classicBot.yaml once. Kept callable so the periodic production
   * path is covered without relying on fake timers around startAll(). */
  private async reloadClassicConfigFromDisk(): Promise<void> {
    try {
      if (!this.classicChannels) return;
      const fleetBackend = this.fleetConfig?.defaults?.backend;
      const fleetModel = this.fleetConfig?.defaults?.model;
      const oldBackends = new Map<string, string>();
      const oldModels = new Map<string, string | undefined>();
      const oldAutoPause = new Map<string, number | undefined>();
      const oldToolProgress = new Map<string, InstanceConfig["tool_progress"]>();
      const oldReplyGuard = new Map<string, boolean>();
      for (const ch of this.classicChannels.getAll()) {
        oldBackends.set(ch.instanceName, this.classicChannels.getBackendByInstance(ch.instanceName, fleetBackend));
        oldModels.set(ch.instanceName, this.classicChannels.getModel(ch.channelId, ch.adapterId, fleetModel));
        oldAutoPause.set(ch.instanceName, this.classicChannels.getAutoPauseAfter(ch.channelId, ch.adapterId, this.fleetConfig?.defaults?.auto_pause_after));
        oldToolProgress.set(ch.instanceName, this.classicChannels.getToolProgress(ch.channelId, ch.adapterId, this.fleetConfig?.defaults?.tool_progress));
        oldReplyGuard.set(ch.instanceName, this.classicChannels.getReplyCompletionGuard(ch.channelId, ch.adapterId, this.fleetConfig?.defaults?.reply_completion_guard));
      }
      if (!measureSyncWork("fleet.classicConfigReload", () => this.classicChannels!.checkReload())) return;
      // A reload can introduce a bad id (hand edit) or clear one; the
      // throttle keeps a repeated report from flooding the topic.
      this.reportClassicUnrecoverableIds();
      this.reregisterClassicChannels();
      for (const ch of this.classicChannels.getAll()) {
        const newBackend = this.classicChannels.getBackendByInstance(ch.instanceName, fleetBackend);
        const newModel = this.classicChannels.getModel(ch.channelId, ch.adapterId, fleetModel);
        const newAutoPause = this.classicChannels.getAutoPauseAfter(ch.channelId, ch.adapterId, this.fleetConfig?.defaults?.auto_pause_after);
        const newToolProgress = this.classicChannels.getToolProgress(ch.channelId, ch.adapterId, this.fleetConfig?.defaults?.tool_progress);
        const newReplyGuard = this.classicChannels.getReplyCompletionGuard(ch.channelId, ch.adapterId, this.fleetConfig?.defaults?.reply_completion_guard);
        const backendChanged = oldBackends.get(ch.instanceName) !== newBackend;
        const modelChanged = oldModels.get(ch.instanceName) !== newModel;
        const autoPauseChanged = oldAutoPause.get(ch.instanceName) !== newAutoPause;
        // #1220: a running CLI keeps the login it was launched with, so a new
        // credential_profile only takes effect through a restart.
        const { changed: profileChanged, startsFresh: profileSwitchStartsFresh, from: profileFrom, to: profileTo } =
          this.classicProfileChange(ch.instanceName, backendChanged);
        if (this.daemons.has(ch.instanceName) && (backendChanged || modelChanged || autoPauseChanged || profileChanged)) {
          this.logger.info(
            { instanceName: ch.instanceName, backendFrom: oldBackends.get(ch.instanceName), backendTo: newBackend, modelFrom: oldModels.get(ch.instanceName), modelTo: newModel,
              ...(profileChanged ? { profileFrom, profileTo } : {}) },
            "Backend/model/profile changed — restarting",
          );
          await this.stopInstance(ch.instanceName).catch(() => {});
          if (profileSwitchStartsFresh) this.writeFreshStartMarker(ch.instanceName);
          // Small delay to let tmux window clean up
          await new Promise(r => setTimeout(r, 2000));
          // The manager already holds the new backend/model/auto-pause; the
          // unattended helper reads them from it and schedules the delayed
          // retry on failure like every other unattended start.
          await this.startClassicInstanceUnattended(ch, "classic instance after backend/model change");
        } else if (this.daemons.has(ch.instanceName)
          && (oldToolProgress.get(ch.instanceName) !== newToolProgress
            || oldReplyGuard.get(ch.instanceName) !== newReplyGuard)) {
          this.applyHotConfigUpdate(ch.instanceName, {
            tool_progress: newToolProgress,
            reply_completion_guard: newReplyGuard,
          });
          this.logger.info({ instanceName: ch.instanceName }, "Classic instance hot config reloaded");
        }
      }
    } catch (err) {
      this.logger.warn({ err }, "classicBot.yaml reload error");
    }
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
    /** Phase 2a: the caller's transition, for a start made from inside a restart or wake. */
    transition?: TransitionHandle,
    execution?: SettingsExecution,
  ): Promise<void> {
    execution?.assert();
    // CLI single-instance cold starts bypass startAll. Start diagnostics before
    // any lifecycle/wake work; a shutdown must not revive the stopped sampler.
    if (!this.shuttingDown) this.memoryPressure?.start();
    // Any start supersedes a pending automatic retry (it would otherwise fire
    // into a running instance — harmless, but noisy — or race this start).
    this.cancelStartupRetry(name);
    if (resumePaused && this.lifecycle.isPaused(name)) {
      await this.explicitWake(name, 30_000);
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
    // An explicit start (CLI/API) begins a fresh idle window; boot and
    // reconcile starts keep the persisted last-inbound seed (Phase 2a).
    if (resumePaused) this.lifecycle.markActivitySeedNow(name);
    const backend = config.backend ?? this.fleetConfig?.defaults?.backend ?? "claude-code";
    if (config.general_topic) {
      this.ensureGeneralInstructions(config.working_directory, backend, name);
    } else if (kind === "fleet-topic") {
      // Workers get only role-eligible on-demand skills. Classic instances are
      // deliberately excluded: their workspace and conversation lifecycle are
      // managed independently from fleet-topic workers.
      try {
        const skillsWorkDir = this.resolveKnowledgeWorkDir(config.working_directory, backend, name);
        measureSyncWork("fleet.workerSkills", () => this.syncRoleSkills(skillsWorkDir, backend, "worker"));
      } catch (err) {
        // Skill publishing is additive. A read-only or temporarily unavailable
        // workspace must not turn an otherwise valid worker startup into a
        // fleet outage.
        this.logger.warn({ err, name, backend }, "Failed to sync worker skills — continuing startup");
      }
    }
    const receipt = execution ? this.classicSettingsOwners.get(execution) : undefined;
    const identity = { kind, backend, model: this.resolveInstanceModel(name).display };
    if (receipt) {
      await this.lifecycle.start(name, config, topicMode, identity, transition, execution, daemon => {
        // Only this transition's actual publication can acquire its replacement.
        receipt.daemon = daemon;
      });
    } else await this.lifecycle.start(name, config, topicMode, identity, transition, execution);
    execution?.assert();
    // Only clear a stale process status after a real start succeeded.  Clearing
    // it before lifecycle.start() can turn a crash-loop daemon's dead pane into
    // a falsely running instance when lifecycle.start() returns early.
    this.instanceProcessStatus.delete(name);
    // Recovery intent belongs to Daemon.start. lifecycle.start can return
    // before reaching it, so an await here is not proof the marker was read.
    // Auto-connect IPC — daemon.start() ensures socket is ready before resolving
    await this.connectIpcToInstance(name); execution?.assert();
    this.requestDiscordUsagePresenceRefresh();
  }

  /** Recreate a daemon for a marker-only paused instance after an explicit wake/delivery. */
  async startPersistedPausedInstance(name: string, transition?: TransitionHandle): Promise<void> {
    const topicMode = this.fleetConfig?.channel?.mode === "topic"
      || !!this.fleetConfig?.channels?.some(channel => channel.mode === "topic");
    const fleetConfig = this.fleetConfig?.instances[name];
    if (fleetConfig) {
      await this.startInstance(name, fleetConfig, topicMode, "fleet-topic", false, transition);
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
      transition,
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

    if (this.fleetConfig?.defaults?.startup?.concurrency == null) {
      this.logger.info({
        concurrency: this.spawnConcurrency(),
        freeMemMB: Math.round(freemem() / (1024 * 1024)),
        totalInstances: runnableEntries.length,
      }, "Adaptive startup concurrency");
    }
    await Promise.all(runnableEntries.map(([name, config]) => this.spawnGate.run({
      instanceName: name,
      workingDirectory: config.working_directory,
      reason: "startup",
      stage: "lifecycle",
    }, async () => {
      if (await this.startInstanceUnattended(name, config, topicMode, "instance")) onReady?.(name);
    })));
  }

  /**
   * Start from an UNATTENDED path (fleet startup, full restart, config
   * reconcile): nobody is watching the result, so a failure is logged and
   * handed to the delayed automatic retry instead of leaving the instance
   * `stopped` forever. Explicit operator/API starts call startInstance directly
   * and keep their synchronous error. Returns whether the instance is up.
   */
  private async startInstanceUnattended(name: string, config: InstanceConfig, topicMode: boolean, what: string): Promise<boolean> {
    try {
      await this.startInstance(name, config, topicMode);
      return this.daemons.has(name);
    } catch (err) {
      // Superseded by a stop/restart (Phase 2a): that transition owns the
      // outcome. Retrying would start an instance the operator just stopped.
      if (err instanceof SupersededStartError) return false;
      if (this.stopOnUnsupportedCli(name, err, what)) return false;
      this.logger.error({ err, name }, `Failed to start ${what}`);
      this.scheduleStartupRetry(name, 0);
      return false;
    }
  }

  // ── Delayed automatic startup retries ──────────────────────────────────

  /**
   * Schedule attempt `attempt` (0-based) of the automatic startup retry for an
   * instance whose start just failed. Backoff 1 → 5 → 15 min; while the
   * instance's backend is known to be unreachable the 15-min step repeats up to
   * STARTUP_RETRY_MAX_ATTEMPTS, after which we give up with one notice. Each
   * retry re-checks the world (still configured, not running, not paused, no
   * tmux storm) and runs through the SpawnGate as "recovery" — so a herd of
   * failed instances comes back at the gate's concurrency, never all at once.
   */
  scheduleStartupRetry(name: string, attempt: number): void {
    if (this.shuttingDown) return;
    if (this.startupRetries.has(name)) return;
    const backoff = FleetManager.STARTUP_RETRY_BACKOFF_MS;
    const outage = this.backendOutage.isActive(this.backendNameOf(name));
    const exhausted = attempt >= backoff.length && !(outage && attempt < FleetManager.STARTUP_RETRY_MAX_ATTEMPTS);
    if (attempt >= FleetManager.STARTUP_RETRY_MAX_ATTEMPTS || exhausted) {
      this.logger.error({ name, attempts: attempt }, "Giving up automatic startup retries");
      this.queueStartupRetryNotice("gave_up", name, 0);
      return;
    }
    const delayMs = backoff[Math.min(attempt, backoff.length - 1)];
    const timer = setTimeout(() => { void this.runStartupRetry(name, attempt); }, delayMs);
    timer.unref?.();
    this.startupRetries.set(name, { attempt, timer });
    this.logger.warn({ name, attempt: attempt + 1, delayMs, backendOutage: outage }, "Startup failed — automatic retry scheduled");
    if (attempt === 0) this.queueStartupRetryNotice("scheduled", name, delayMs);
  }

  /** Drop a pending automatic retry (an operator start/stop/restart supersedes it). */
  cancelStartupRetry(name: string): void {
    const pending = this.startupRetries.get(name);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.startupRetries.delete(name);
    this.logger.info({ name }, "Pending automatic startup retry cancelled");
  }

  /** Pending automatic retry, if any (status display / tests). */
  pendingStartupRetry(name: string): { attempt: number } | null {
    const pending = this.startupRetries.get(name);
    return pending ? { attempt: pending.attempt } : null;
  }

  /**
   * A daemon's crash-respawn hit the backend outage (startup_backend_unreachable):
   * stop THAT daemon and schedule the delayed retry. Serialized against the
   * operator paths: an in-flight restart is awaited first (it replaces the
   * daemon itself), the stop is identity-checked so a fresh daemon registered
   * meanwhile is never deleted, and an explicit stop/restart that began during
   * the hand-off (generation bump) owns the outcome — no retry is scheduled
   * behind an operator's back.
   */
  async handOffToStartupRetry(name: string, daemon: unknown): Promise<void> {
    const joined = this.handOffsInFlight.get(name);
    if (joined) return joined;
    const run = (async () => {
      // Let any operator restart/stop that is already executing finish first:
      // a restart replaces the daemon itself, a stop removes it — either way
      // the identity check below then sees "not ours any more" and we do
      // nothing. Loop: one operation can be chained behind another.
      for (;;) {
        const inFlight = this.restartsInFlight.get(name) ?? this.stopsInFlight.get(name);
        if (!inFlight) break;
        await inFlight.catch(() => { /* the operation reports its own failure */ });
      }
      const stopGen = this.explicitStopGeneration.get(name) ?? 0;
      if (this.lifecycle.daemons.get(name) !== daemon) return; // already replaced or stopped
      await this.lifecycle.stopIfCurrent(name, daemon);
      if (this.shuttingDown) return;
      if ((this.explicitStopGeneration.get(name) ?? 0) !== stopGen) {
        this.logger.info({ name }, "Outage hand-off superseded by an explicit stop/restart — no automatic retry");
        return;
      }
      if (this.lifecycle.daemons.has(name) || this.lifecycle.isPaused(name)) return;
      this.scheduleStartupRetry(name, 0);
    })().finally(() => this.handOffsInFlight.delete(name));
    this.handOffsInFlight.set(name, run);
    return run;
  }

  private async runStartupRetry(name: string, attempt: number): Promise<void> {
    this.startupRetries.delete(name);
    if (this.shuttingDown) return;
    if (!this.isConfiguredInstance(name)) return; // removed from fleet.yaml / classic channel meanwhile
    if (this.lifecycle.isPaused(name) || this.daemons.has(name)) return; // operator acted meanwhile
    if (this.stormWindow.isSpawnBlocked()) {
      // The tmux server is being restarted; joining that herd is what we are
      // trying to avoid. Same attempt again after the storm's own recovery.
      const timer = setTimeout(() => { void this.runStartupRetry(name, attempt); }, FleetManager.STARTUP_RETRY_STORM_DEFER_MS);
      timer.unref?.();
      this.startupRetries.set(name, { attempt, timer });
      this.logger.info({ name, attempt: attempt + 1 }, "Startup retry deferred — tmux storm window is blocking spawns");
      return;
    }
    const topicMode = this.fleetConfig?.channel?.mode === "topic"
      || !!this.fleetConfig?.channels?.some(channel => channel.mode === "topic");
    try {
      await this.spawnGate.run({
        instanceName: name,
        workingDirectory: this.fleetConfig?.instances[name]?.working_directory || this.getInstanceDir(name),
        reason: "recovery",
        stage: "lifecycle",
      }, () => this.startConfiguredInstance(name, topicMode));
      if (this.daemons.has(name)) {
        this.logger.info({ name, attempt: attempt + 1 }, "Automatic startup retry succeeded");
      }
    } catch (err) {
      // Superseded by a stop/restart: that transition owns the outcome.
      if (err instanceof SupersededStartError) return;
      // An earlier attempt could not tell (unknown probe); this one could.
      if (this.stopOnUnsupportedCli(name, err, "instance")) return;
      this.logger.error({ err, name, attempt: attempt + 1 }, "Automatic startup retry failed");
      this.scheduleStartupRetry(name, attempt + 1);
    }
  }

  /** Fleet-topic (fleet.yaml) or ClassicBot (classic channel) — both are retryable; anything else is gone. */
  private isConfiguredInstance(name: string): boolean {
    if (this.fleetConfig?.instances[name]) return true;
    return !!this.classicChannels?.getAll().some(channel => channel.instanceName === name);
  }

  /**
   * Kind-aware start for the automatic retry: fleet-topic instances come from
   * fleet.yaml, ClassicBot instances exist only in the classic channel manager
   * and must be rebuilt through startClassicInstance (a fleet.yaml lookup alone
   * silently dropped them — the retry timer fired and nothing happened).
   */
  private async startConfiguredInstance(name: string, topicMode: boolean): Promise<void> {
    const config = this.fleetConfig?.instances[name];
    if (config) {
      await this.startInstance(name, config, topicMode);
      return;
    }
    const channel = this.classicChannels?.getAll().find(item => item.instanceName === name);
    if (!channel || !this.classicChannels) throw new Error(`Instance '${name}' is no longer configured`);
    await this.startClassicInstance(
      name,
      this.classicChannels.getBackendByInstance(name, this.fleetConfig?.defaults?.backend),
      this.classicChannels.getPreTaskCommand(channel.channelId, channel.adapterId),
      this.classicChannels.getModel(channel.channelId, channel.adapterId, this.fleetConfig?.defaults?.model),
      this.classicChannels.getAutoPauseAfter(channel.channelId, channel.adapterId, this.fleetConfig?.defaults?.auto_pause_after),
    );
  }

  /**
   * Unattended ClassicBot start (fleet startup batch, full-restart batch, the
   * classicBot.yaml reconcile): same contract as startInstanceUnattended —
   * failures are logged and handed to the delayed automatic retry, whose
   * kind-aware startConfiguredInstance rebuilds the Classic instance. Returns
   * whether the instance is up.
   */
  private async startClassicInstanceUnattended(
    ch: { instanceName: string; channelId: string; adapterId?: string },
    what: string,
  ): Promise<boolean> {
    try {
      await this.startClassicInstance(
        ch.instanceName,
        this.classicChannels!.getBackendByInstance(ch.instanceName, this.fleetConfig?.defaults?.backend),
        this.classicChannels!.getPreTaskCommand(ch.channelId, ch.adapterId),
        this.classicChannels!.getModel(ch.channelId, ch.adapterId, this.fleetConfig?.defaults?.model),
        this.classicChannels!.getAutoPauseAfter(ch.channelId, ch.adapterId, this.fleetConfig?.defaults?.auto_pause_after),
      );
      return this.daemons.has(ch.instanceName);
    } catch (err) {
      if (err instanceof SupersededStartError) return false;
      this.logger.warn({ err, instanceName: ch.instanceName }, `Failed to start ${what}`);
      this.scheduleStartupRetry(ch.instanceName, 0);
      return false;
    }
  }

  private backendNameOf(name: string): string {
    const fleetDefault = this.fleetConfig?.defaults?.backend;
    const fleetInstance = this.fleetConfig?.instances[name];
    // A malformed/manual config can give a fleet and Classic entry the same
    // instance name. Fleet ownership wins, including its inherited default;
    // otherwise a Classic override could make backend-scoped recovery restart
    // the shared process under the wrong login result.
    if (fleetInstance) return fleetInstance.backend ?? fleetDefault ?? "claude-code";
    // ClassicBot channels pick their own backend; the fleet default is only the fallback.
    if (this.classicChannels?.getAll().some(channel => channel.instanceName === name)) {
      return this.classicChannels.getBackendByInstance(name, fleetDefault);
    }
    return fleetDefault ?? "claude-code";
  }

  /**
   * Every configured instance whose backend may share credentials. ClassicBot
   * rows live only in classicBot.yaml, so backend-wide operations must not use
   * fleetConfig.instances as their roster. Set keeps a malformed name collision
   * from restarting the same process twice; backendNameOf defines ownership.
   */
  private configuredBackendInstanceNames(): string[] {
    const names = new Set(Object.keys(this.fleetConfig?.instances ?? {}));
    for (const channel of this.classicChannels?.getAll() ?? []) names.add(channel.instanceName);
    return [...names];
  }

  /**
   * Probe the same executable set exposed by the web backend catalog.
   *
   * This deliberately skips the cache: an install `/login` ran can add a
   * binary to PATH while the fleet process remains alive, and the next bare
   * `/login` must see it without requiring a restart or an explicit cache
   * invalidation call. The fresh answers also refresh the shared cache that
   * `/ui/backends` reads. #1490: async and bounded, never `which` on the event loop; a probe with no answer in time
   * counts as not installed, as the old timeout did.
   */
  private async probeInstalledBackends(): Promise<Set<string>> {
    const entries = Object.entries(BACKEND_INSTALLATION_INFO);
    const found = await Promise.all(entries.map(([, info]) => binaryProbe.probe(info.binary, { fresh: true })));
    return new Set(entries.filter((_, i) => { const r = found[i]; return r.known && r.path !== null; }).map(([backend]) => backend));
  }

  /**
   * One fleet-level notice per burst, not one per instance: a post-update herd
   * fails many instances within the same second. Two notices per incident at
   * most — "N failed, retrying in X" and, if it comes to that, "gave up on N".
   */
  /**
   * The CLI refuses this instance as configured (#1109): the same binary would
   * refuse every retry, so say why once and leave it stopped. Shared by the
   * first unattended start and every scheduled retry.
   */
  private stopOnUnsupportedCli(name: string, err: unknown, what: string): boolean {
    if (!(err instanceof UnsupportedCliError)) return false;
    this.logger.error({ name, reason: err.message }, `Not starting ${what}: the installed CLI cannot run it as configured`);
    this.queueUnsupportedCliNotice(name, err.message);
    this.queueKiroIncompatNotice(name, err.message);
    return true;
  }

  /**
   * LifecycleContext: a kiro instance the installed kiro-cli cannot run as
   * configured (#1109) — at start, or at a respawn after kiro-cli replaced
   * itself. The operator already gets the plain notice; this tells every
   * General, as an agent, so it can explain the kiro engine move when asked.
   * One notice per refusal reason, like the operator's.
   */
  queueKiroIncompatNotice(name: string, reason: string): void {
    // The effective backend, ClassicBot channels included: they are not in fleetConfig.instances.
    if (this.backendNameForInstance(name) !== "kiro-cli") return;
    const pending = this.kiroIncompatNotices.get(reason);
    if (pending) {
      if (!pending.names.includes(name)) pending.names.push(name);
      return;
    }
    const timer = setTimeout(() => {
      const entry = this.kiroIncompatNotices.get(reason);
      this.kiroIncompatNotices.delete(reason);
      if (entry) this.sendKiroIncompatToGenerals(entry.names, reason);
    }, FleetManager.STARTUP_RETRY_NOTICE_AGGREGATE_MS);
    timer.unref?.();
    this.kiroIncompatNotices.set(reason, { names: [name], timer });
  }

  /**
   * Held in the delivery outbox until each General takes it: the same kiro-cli
   * may have stopped the General too, and it should still hear once it is back.
   * Admitted once per day per refusal (reason + names) and General.
   */
  private sendKiroIncompatToGenerals(names: string[], reason: string, now: Date = new Date()): void {
    const generals = Object.entries(this.fleetConfig?.instances ?? {})
      .filter(([, config]) => config.general_topic === true).map(([general]) => general);
    if (generals.length === 0) return;
    try {
      this.ensureDeliveryOutbox();
      const sorted = [...names].sort();
      const digest = createHash("sha256").update(`${reason}\u0000${sorted.join(",")}`).digest("hex").slice(0, 16);
      const content = t("fleet.kiro_incompat_general", sorted.join(", "), reason);
      for (const general of generals) {
        this.deliveryOutbox!.admitSystemNotice(general, `kiro-incompat:${now.toISOString().slice(0, 10)}:${digest}:${general}`, content, now);
      }
    } catch (err) {
      this.logger.warn({ err, names }, "Could not queue the kiro incompatibility notice for General");
    }
  }

  /**
   * One notice per refusal reason: a kiro-cli that dropped the legacy UI
   * refuses every kiro instance at once, and that is one message, not ten.
   */
  private queueUnsupportedCliNotice(name: string, reason: string): void {
    const pending = this.unsupportedCliNotices.get(reason);
    if (pending) {
      if (!pending.names.includes(name)) pending.names.push(name);
      return;
    }
    const timer = setTimeout(() => {
      const entry = this.unsupportedCliNotices.get(reason);
      this.unsupportedCliNotices.delete(reason);
      if (entry) this.notifyFleetError(t("fleet.cli_unsupported", entry.names.join(", "), reason));
    }, FleetManager.STARTUP_RETRY_NOTICE_AGGREGATE_MS);
    timer.unref?.();
    this.unsupportedCliNotices.set(reason, { names: [name], timer });
  }

  private queueStartupRetryNotice(kind: "scheduled" | "gave_up", name: string, delayMs: number): void {
    const pending = this.startupRetryNotices.get(kind);
    if (pending) {
      if (!pending.names.includes(name)) pending.names.push(name);
      return;
    }
    const timer = setTimeout(() => {
      const entry = this.startupRetryNotices.get(kind);
      this.startupRetryNotices.delete(kind);
      if (!entry) return;
      const list = entry.names.join(", ");
      if (kind === "scheduled") {
        let text = t("fleet.startup_retry_scheduled", entry.names.length, list, this.formatStormDelay(entry.delayMs));
        const downBackends = [...new Set(entry.names.map(n => this.backendNameOf(n)))].filter(b => this.backendOutage.isActive(b));
        if (downBackends.length) text += `\n${t("fleet.startup_retry_outage", downBackends.join(", "))}`;
        this.notifyFleetError(text);
      } else {
        this.notifyFleetError(t("fleet.startup_retry_gave_up", entry.names.length, list));
      }
    }, FleetManager.STARTUP_RETRY_NOTICE_AGGREGATE_MS);
    timer.unref?.();
    this.startupRetryNotices.set(kind, { names: [name], delayMs, timer });
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
    const adapterId = this.getInstanceAdapterId(generalName);
    const chatId = this.getGroupIdForInstance(generalName);
    if (!adapter || !chatId) return null;
    const topicId = this.fleetConfig?.instances[generalName]?.topic_id;
    return {
      adapter,
      resolveAdapter: adapterId ? () => this.readyProgressAdapter(adapterId) : undefined,
      chatId,
      threadId: topicId != null ? String(topicId) : undefined,
    };
  }

  /** Resolve only an adapter generation that can accept progress delivery.
   * Discord exposes direct gateway readiness; adapters without a health
   * snapshot use the fleet startup/retry state. */
  private readyProgressAdapter(adapterId: string): ChannelAdapter | undefined {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) return undefined;
    const health = adapter.getHealthSnapshot?.();
    if (health) return health.isReady ? adapter : undefined;
    return this.adapterState.get(adapterId)?.status === "connected" ? adapter : undefined;
  }

  /** Last-resort completion after RestartProgress could not deliver to its
   * adopted target. It stays bounded and never wakes a not-ready gateway. */
  private async sendFleetStartCompletionFallback(
    chatId: string,
    text: string,
    threadId?: string,
  ): Promise<boolean> {
    const adapterId = this.getPrimaryAdapterId();
    const adapter = adapterId ? this.readyProgressAdapter(adapterId) : undefined;
    if (!adapter) {
      this.logger.error({ adapterId }, "Fleet start completion fallback skipped because the primary adapter is not ready");
      return false;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ status: "timeout" }>(resolve => {
      timer = setTimeout(
        () => resolve({ status: "timeout" }),
        RESTART_PROGRESS_TERMINAL_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    const delivery = Promise.resolve()
      .then(() => adapter.sendText(chatId, text, { threadId }))
      .then<{ status: "sent" }, { status: "failed"; err: unknown }>(
        () => ({ status: "sent" }),
        err => ({ status: "failed", err }),
      );
    const result = await Promise.race([delivery, timeout]);
    if (timer) clearTimeout(timer);
    if (result.status === "sent") return true;
    if (result.status === "failed") {
      this.logger.error({ err: result.err }, "Failed to send fleet start completion fallback");
    } else {
      this.logger.error(
        { timeout_ms: RESTART_PROGRESS_TERMINAL_TIMEOUT_MS },
        "Timed out sending fleet start completion fallback",
      );
    }
    return false;
  }

  async stopInstance(name: string, transition?: TransitionHandle): Promise<void> {
    this.explicitStopGeneration.set(name, (this.explicitStopGeneration.get(name) ?? 0) + 1);
    this.cancelStartupRetry(name);
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
    // Published so the outage hand-off can wait for an explicit stop that began
    // BEFORE it (the generation fence alone only catches stops that begin after
    // the hand-off snapshotted it).
    const run = (async () => {
      try {
        await this.lifecycle.stop(name, transition);
      } finally {
        this.clearNoncePromptsForInstance(name);
      }
    })().finally(() => { if (this.stopsInFlight.get(name) === run) this.stopsInFlight.delete(name); });
    this.stopsInFlight.set(name, run);
    return run;
  }

  /** Restart a single instance, reloading fleet.yaml first to pick up config changes. */
  async restartSingleInstance(name: string, opts?: { freshStart?: boolean; explicit?: boolean }): Promise<void> {
    // One restart at a time per instance. Multiple sources can ask concurrently
    // (MCP revival, /restart, pty_error, model failover); a second stop/start
    // interleaved with the first tears down the window the first just created.
    // Later callers join the in-flight restart instead — its opts win.
    const inFlight = this.restartsInFlight.get(name);
    if (inFlight) {
      this.logger.info({ name }, "restartSingleInstance: joining the restart already in flight");
      return inFlight;
    }
    const workingDirectory = this.fleetConfig?.instances[name]?.working_directory || this.getInstanceDir(name);
    // Phase 2a: invalidate synchronously so a start still spawning does not
    // publish, then queue behind it as this instance's next transition. The
    // spawn gate is taken inside the transition, never the other way round, so
    // the start being waited for can still get its own gate slot.
    this.lifecycle.invalidate(name);
    const run = this.lifecycle.runTransition(name, transition => this.spawnGate.run({
      instanceName: name,
      workingDirectory,
      reason: "restart",
      stage: "lifecycle",
    }, () => this.doRestartSingleInstance(name, opts, transition)))
      .finally(() => {
        this.restartsInFlight.delete(name);
        this.scheduleDeliveryOutboxPump();
      });
    this.restartsInFlight.set(name, run);
    return run;
  }

  isInstanceRestarting(name: string): boolean {
    return this.restartsInFlight.has(name);
  }

  /** InstanceLifecycleContext: an explicit wake joins the restart in flight. */
  restartInFlight(name: string): Promise<void> | undefined {
    return this.restartsInFlight.get(name);
  }

  /**
   * Phase 2a: restarting a paused instance is a wake. The stop leaves the
   * pause marker in place, and the start used to skip on it ("Persisted
   * paused instance"), turning a resident pause into a marker-only one that
   * nothing would wake. Clear it before the start; if the start fails, put it
   * back so the instance stays wakeable instead of becoming plain stopped.
   */
  private async startAfterRestart(name: string, wasPaused: boolean, pausedAt: number | null,
    reason: ReturnType<typeof readPauseReason>, start: () => Promise<void>): Promise<void> {
    const instanceDir = this.getInstanceDir(name);
    if (wasPaused) clearPausedMarker(instanceDir);
    this.lifecycle.markActivitySeedNow(name);
    try {
      await start();
    } catch (err) {
      if (wasPaused && !this.daemons.has(name)) writePausedMarker(instanceDir, pausedAt ?? Date.now(), reason);
      throw err;
    } finally {
      this.lifecycle.clearActivitySeedNow(name);
    }
  }

  private async doRestartSingleInstance(name: string, opts: { freshStart?: boolean; explicit?: boolean } | undefined, transition: TransitionHandle): Promise<void> {
    if (this.configPath) {
      this.loadConfig(this.configPath);
      this.routing.rebuild(this.fleetConfig!);
      this.reregisterClassicChannels();
    }
    const config = this.fleetConfig?.instances[name];
    const wasPaused = this.lifecycle.isPaused(name);
    // A paused instance's restart is a wake: it takes a warm slot like any other
    // (refused before anything is stopped when none can be had). An active
    // restart is already counted and reserves nothing.
    const slot = await this.acquireWakeSlot(name);
    // An active instance keeps the slot it already occupies across its own
    // stop → replacement gap: counted as warm until the replacement is
    // published or the restart settles, so no other target can take it.
    if (!wasPaused) this.restartsHoldingSlot.add(name);
    try {
      await this.doRestartWithSlot(name, opts, transition, config, wasPaused);
      // An explicit restart of a paused instance is an operator wake (§1.6):
      // its success lifts the coordinator's park/backoff (the level stays).
      // Automatic restarts never do.
      if (wasPaused && opts?.explicit && this.daemons.has(name)) this.wakeCoordinator?.noteExternalWake(name);
    } finally {
      this.restartsHoldingSlot.delete(name);
      this.releaseWakeSlot(name, slot);
    }
  }

  private async doRestartWithSlot(
    name: string,
    opts: { freshStart?: boolean; explicit?: boolean } | undefined,
    transition: TransitionHandle,
    config: InstanceConfig | undefined,
    wasPaused: boolean,
  ): Promise<void> {
    const pausedAt = wasPaused ? (this.lifecycle.getLastPausedAt(name) ?? readPausedAt(this.getInstanceDir(name))) : null;
    const pauseReason = wasPaused ? readPauseReason(this.getInstanceDir(name)) : null;
    if (config) {
      await this.stopInstance(name, transition);
      if (opts?.freshStart) this.writeFreshStartMarker(name);
      const topicMode = this.fleetConfig?.channel?.mode === "topic";
      await this.startAfterRestart(name, wasPaused, pausedAt, pauseReason,
        () => this.startInstance(name, config, topicMode ?? false, "fleet-topic", false, transition));
      this.stormWindow.markRecovered(name);
      return;
    }
    // Classic instance fallback
    const channelId = this.classicChannels?.getChannelIdByInstance(name);
    if (channelId) {
      const fleetBackend = this.fleetConfig?.defaults?.backend;
      const adapterId = this.classicChannels!.getAdapterIdByInstance(name);
      await this.stopInstance(name, transition);
      await new Promise(r => setTimeout(r, 1000)); // let tmux clean up
      if (opts?.freshStart) this.writeFreshStartMarker(name);
      await this.startAfterRestart(name, wasPaused, pausedAt, pauseReason, () => this.startClassicInstance(
        name,
        this.classicChannels!.getBackendByInstance(name, fleetBackend),
        this.classicChannels!.getPreTaskCommand(channelId, adapterId),
        this.classicChannels!.getModel(channelId, adapterId, this.fleetConfig?.defaults?.model),
        this.classicChannels!.getAutoPauseAfter(channelId, adapterId, this.fleetConfig?.defaults?.auto_pause_after),
        transition,
      ));
      this.stormWindow.markRecovered(name);
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
  private loadEnvFile(owner?: symbol): void {
    const envPath = join(this.dataDir, ".env");
    if (!existsSync(envPath)) return;
    assertSettingsLease(settingsFileResource(envPath), owner);
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
    // Creates web.token if absent; the value is then read back per request by
    // the `webToken` getter, so nothing is cached here.
    loadOrCreateWebToken(this.dataDir);
    this.initializeWebSessions();
    // A `view.token` file was written here for a read-only credential that nothing
    // ever accepted. Older installs still have one; it authorizes nothing, so do
    // not leave a credential-shaped file lying around.
    try { rmSync(join(this.dataDir, "view.token"), { force: true }); } catch { /* best effort */ }
    this.healthServerListening = false;
  }

  private initializeWebSessions(): void {
    if (!this.webSessions) {
      this.webSessions = new WebSessionStore({
        dataDir: this.dataDir,
        onWarn: message => this.logger.warn(message),
      });
    }
    if (!this.webLoginCodes) {
      this.webLoginCodes = new WebLoginCodes({
        onEvent: event => {
          if (event === "burned") this.logger.warn("A web login code was used up by wrong attempts");
          else if (event === "breaker-open") this.logger.warn("Web sign-in paused: too many wrong login codes");
        },
      });
    }
  }

  /**
   * A single-use login code for the dashboard, for a channel only the operator
   * can read (`/dashboard`). Null while the panel is closed (no web.token).
   */
  issueDashboardLogin(): { display: string; expiresAt: number; ttlMinutes: number } | null {
    const token = this.webToken;
    if (!token) return null;
    this.initializeWebSessions();
    const issued = this.webLoginCodes!.issue({ tier: "admin", epoch: tokenEpoch(token) });
    return { display: issued.display, expiresAt: issued.expiresAt, ttlMinutes: Math.round(LOGIN_CODE_TTL_MS / 60_000) };
  }

  private tunnelPurposeLane: TunnelPurposeLane | null = null;
  private publicWebLink: PublicWebLink | null = null;
  private getTunnelLane(): TunnelPurposeLane {
    return this.tunnelPurposeLane ??= new TunnelPurposeLane(new ManagedTunnel({ dataDir: this.dataDir,
      log: () => this.logger.warn("Managed tunnel cleanup requires attention") }));
  }
  private publicOwnerCurrent(owner: LoginCodeOwner): boolean {
    if (this.shuttingDown || !this.hasFleetAdmins(owner.adapterId) || !this.isFleetAdmin(owner.userId, owner.adapterId)) return false;
    const configured = (this.fleetConfig?.channels ?? (this.fleetConfig?.channel ? [this.fleetConfig.channel] : [])).find(ch => (ch.id ?? ch.type) === owner.adapterId);
    if (!configured || String(configured.group_id ?? "") !== owner.chatId) return false;
    const world = this.worlds.get(owner.adapterId);
    if (!world || !owner.binding || world.adapter !== owner.binding || this.adapters.get(owner.adapterId) !== owner.binding) return false;
    return Object.entries(this.fleetConfig?.instances ?? {}).some(([name, cfg]) => cfg.general_topic
      && this.getInstanceAdapterId(name) === owner.adapterId && String(this.getGroupIdForInstance(name) ?? "") === owner.chatId
      && cfg.topic_id?.toString() === owner.threadId);
  }
  /** Exact owning General. No primary-adapter or name fallback participates in authorization. */
  private dashboardOwner(userId: string, adapterId: string, address: string, threadId?: string): LoginCodeOwner | null {
    const world = this.worlds.get(adapterId);
    if (!world || !this.hasFleetAdmins(adapterId) || !this.isFleetAdmin(userId, adapterId)) return null;
    for (const [name, cfg] of Object.entries(this.fleetConfig?.instances ?? {})) {
      if (!cfg.general_topic || this.getInstanceAdapterId(name) !== adapterId) continue;
      const group = String(this.getGroupIdForInstance(name) ?? "");
      const topic = cfg.topic_id?.toString();
      if (!topic) continue;
      const dc = world.adapter.id === adapterId && world.channelConfig.type === "discord";
      const matched = dc ? topic === address || (group === address && topic === threadId)
        : group === address && ((topic === "1" && (threadId === undefined || threadId === "1")) || topic === threadId);
      if (group && matched) return { userId, adapterId, chatId: group, threadId: topic, binding: world.adapter };
    }
    return null;
  }
  private getPublicWebLink(): PublicWebLink {
    this.initializeWebSessions();
    return this.publicWebLink ??= new PublicWebLink({
      dataDir: this.dataDir, web: () => this.fleetConfig?.web,
      permitted: owner => this.publicOwnerCurrent(owner),
      reserve: id => this.getTunnelLane().reserve("dashboard", id),
      createGateway: (exposureId, current, open, failed) => createPublicWebGateway({ exposureId, isCurrent: current, isOpen: open, onError: failed,
        dispatch: (req, res) => this.dispatchWebHttp(req, res, this.fleetConfig?.health_port ?? 19280) }),
      revoke: id => {
        this.webLoginCodes?.revokeAudience(id);
        const result = this.webSessions?.revokeExposure(id);
        if (result && !result.durable) this.logger.warn("Public session revocation could not be saved; exposure remains closed");
      },
      log: (event, exposureId) => this.logger.info({ event, exposureId }, "Public web link"),
      onCleanupUnconfirmed: (result, owner) => {
        this.logger.warn({ pid: result.confirmed ? null : result.pid }, "Public web access closed; tunnel cleanup unconfirmed");
        const world = this.worlds.get(owner.adapterId);
        if (world && world.adapter === owner.binding) void world.adapter.sendText(owner.chatId, t("dashboard.public_cleanup"), { threadId: owner.threadId }).catch(() => {});
      },
    });
  }
  getPublicWebStatus(): { state: string; expiresAt?: number; remainingSeconds?: number } {
    return this.publicWebLink?.status() ?? { state: "closed" };
  }
  async confirmPublicWebLogin(info: { label: string; handle: string; owner: LoginCodeOwner }, current: () => boolean): Promise<void> {
    if (!current() || !this.publicOwnerCurrent(info.owner)) throw new Error("public owner unavailable");
    const adapter = info.owner.binding as ChannelAdapter;
    await adapter.sendText(info.owner.chatId, t("web.public_login_notice", info.label, info.handle.slice(0, 8)), { threadId: info.owner.threadId, allowedMentions: { parse: [] } });
    if (!current() || !this.publicOwnerCurrent(info.owner)) throw new Error("public owner changed");
  }
  /** Telegram's typed command enters through the same strict owner and nonce path as Discord. */
  async dashboardMenu(msg: InboundMessage): Promise<void> {
    const id = msg.adapterId;
    const owner = id ? this.dashboardOwner(msg.userId, id, msg.chatId, msg.threadId) : null;
    if (!owner) {
      const adapter = id ? this.adapters.get(id) : undefined;
      await adapter?.sendText(msg.chatId, t("dashboard.public_general"), { threadId: msg.threadId }); return;
    }
    if (!await this.showDashboardMenu(owner)) {
      await (owner.binding as ChannelAdapter).sendText(owner.chatId, t("dashboard.menu_failed"), { threadId: owner.threadId }).catch(() => undefined);
    }
  }
  private async sendLocalDashboard(data: ClassicStartSlashData, adapterId: string): Promise<void> {
    if (this.shuttingDown || !this.hasFleetAdmins(adapterId) || !this.isFleetAdmin(data.userId, adapterId)) { await data.respond(t("not_authorized")); return; }
    const text = this.topicCommands.getDashboardText();
    const adapter = this.adapters.get(adapterId);
    const token = this.webToken;
    if (!adapter || !token) { await data.respond(text); return; }
    this.initializeWebSessions();
    const login = this.webLoginCodes!.issue({ epoch: tokenEpoch(token) });
    const current = (): boolean => !this.shuttingDown && this.adapters.get(adapterId) === adapter
      && this.webToken === token && this.hasFleetAdmins(adapterId) && this.isFleetAdmin(data.userId, adapterId);
    const privateText = `${text}\n${t("dashboard.code", login.display, Math.round(LOGIN_CODE_TTL_MS / 60_000))}`;
    const deadline = performance.now() + 10_000;
    let deliveredByDm = false;
    try {
      try {
        if (!adapter.sendDirect) throw new Error("DM unavailable");
        await withinBudget(adapter.sendDirect(data.userId, privateText, { disablePreview: true }), Math.min(deadline, performance.now() + 5_000));
        deliveredByDm = true;
      } catch (err) {
        this.logDashboardDmFailure(err);
        if (!current()) throw new Error("owner changed");
        const id = await withinBudget(data.respond(privateText), deadline); // native slash response is already ephemeral
        if (!id) throw new Error("private delivery unconfirmed");
      }
      if (!current()) throw new Error("owner changed");
      if (deliveredByDm) await withinBudget(data.respond(t("dashboard.private_sent_dm")), deadline);
    } catch (err) {
      this.webLoginCodes!.revokeIfCurrent(login.issuanceId);
      this.logger.info({ err: (err as Error)?.message }, "Dashboard private delivery was not confirmed");
      await data.respond(t("dashboard.private_failed")).catch(() => undefined);
    }
  }
  /** Why the DM did not go, for the log only (Discord 50007 = the user does not accept DMs from this server's members). */
  private logDashboardDmFailure(err: unknown): void {
    const code = (err as { code?: unknown })?.code;
    this.logger.info({ code: typeof code === "string" || typeof code === "number" ? code : undefined, err: (err as Error)?.message },
      "Dashboard DM not delivered; answering privately where the command was used");
  }
  /** False when the menu was not shown (the caller still owes the user an answer). */
  private async showDashboardMenu(owner: LoginCodeOwner, respondButtons?: ClassicStartSlashData["respondButtons"],
    retireButtons?: ClassicStartSlashData["retireButtons"]): Promise<boolean> {
    if (!this.publicOwnerCurrent(owner)) { this.logger.info("Dashboard menu not shown: the General owner changed"); return false; }
    const adapter = owner.binding as ChannelAdapter;
    const status = this.getPublicWebStatus();
    const publicAllowed = publicLinkSettings(this.fleetConfig?.web).allowed;
    const menuText = this.topicCommands.getDashboardText(false, !publicAllowed)
      + (publicAllowed ? "\n\n" + t("dashboard.public_risk") : "")
      + "\n" + t("dashboard.public_status", status.state, status.remainingSeconds ?? 0);
    const choices = [{ action: "local", label: t("dashboard.local") },
      ...(publicLinkSettings(this.fleetConfig?.web).allowed ? [{ action: "public", label: t("dashboard.public_open") }] : []),
      ...(status.state !== "closed" ? [{ action: "close", label: t("dashboard.public_close") }] : [])];
    const posted = await this.postNonceButtonPrompt({
      prefix: "dashboard:", alertType: "login", instanceName: "dashboard", adapter, adapterId: owner.adapterId,
      chatId: owner.chatId, threadId: owner.threadId, timeoutMs: 5 * 60_000,
      message: menuText,
      choices, expiredText: t("buttons.stale"), extra: { requesterUserId: owner.userId, dashboardOwner: owner, publicExposureId: this.publicWebLink?.exposureId },
      ...(respondButtons ? { deliver: async (c: Choice[]) => {
        const messageId = await respondButtons(menuText, c);
        if (!messageId) throw new Error("menu refused");
        // The menu is the command's ephemeral reply: only that interaction can collapse it.
        return { chatId: owner.chatId, threadId: owner.threadId, messageId, ...(retireButtons ? { retire: retireButtons } : {}) };
      } } : {}),
    });
    return posted !== null;
  }
  private async handleDashboardCallback(data: AdapterCallbackData, adapterId: string, adapter?: ChannelAdapter): Promise<boolean> {
    const claimed = this.consumeNonceCallback("dashboard:", /^dashboard:([0-9a-f]{32}):(local|public|close)$/, data, adapterId, adapter);
    if (claimed === null) return false;
    if (claimed === "consumed") return true;
    const { entry, action } = claimed;
    const owner = entry.dashboardOwner;
    if (!owner || !this.publicOwnerCurrent(owner)) { data.ack?.(t("not_authorized")); return true; }
    if (action === "close") {
      if (!entry.publicExposureId) return true;
      const result = await this.publicWebLink?.close("admin close", entry.publicExposureId);
      if (result?.confirmed === false) data.ack?.(t("dashboard.public_cleanup"));
      await this.retireNonceButtons(entry, entry.messageId ?? data.messageId, t("dashboard.public_closed"), data.editClicked); return true;
    }
    // The click is claimed and its buttons are spent: say so on the menu now. A public link follows each of its steps
    // there (the first one installs cloudflared, which can take a minute): on Discord through the interaction, on
    // Telegram by editing the menu message itself. Only static words and numbers — the menu may be in General.
    const progressEdit = data.editClicked ?? entry.retire;
    const progress = progressEdit && action !== "public"
      ? progressEdit(t("dashboard.private_sending")).catch(err => this.logger.debug({ err }, "Could not show the dashboard menu's progress"))
      : Promise.resolve();
    const stepsEdit = progressEdit ?? (entry.messageId && entry.adapter.editMessageRemoveButtons
      ? (text: string) => entry.adapter.editMessageRemoveButtons!(entry.chatId, entry.messageId!, text, entry.threadId) : undefined);
    const steps = action === "public" && stepsEdit ? new ThrottledMessageEditor({
      edit: stepsEdit, now: () => performance.now(), heartbeatMs: 5_000,
      // Telegram counts edits against a group's ~20 messages a minute.
      minIntervalMs: (owner.binding as ChannelAdapter).type === "telegram" ? 3_000 : 2_000,
      onError: err => this.logger.debug({ err }, "Could not show the public link's progress"),
    }) : null;
    let lastSteps: PublicLinkProgress | undefined;
    let deliveredByDm = false;
    const send = async (url: string, exposureId?: string, expiresAt?: number, current: () => boolean = () => this.publicOwnerCurrent(owner)): Promise<boolean> => {
      const token = this.webToken;
      if (!token || !current()) return false;
      this.initializeWebSessions();
      const issued = this.webLoginCodes!.issue({ epoch: tokenEpoch(token), audience: exposureId, owner });
      const text = t("dashboard.private_link", url, issued.display, Math.round(LOGIN_CODE_TTL_MS / 60_000), expiresAt ? new Date(expiresAt).toISOString() : t("dashboard.local"));
      const deadline = performance.now() + 10_000;
      const direct = owner.binding as ChannelAdapter;
      try {
        const deliver = async (c: Choice[] = []): Promise<import("./channel/types.js").SentMessage> => {
          try {
            if (!direct.sendDirect) throw new Error("DM unavailable");
            const sent = await withinBudget(direct.sendDirect(owner.userId, text, { disablePreview: true, choices: c }), Math.min(deadline, performance.now() + 5_000));
            deliveredByDm = true;
            return sent;
          } catch (err) {
            this.logDashboardDmFailure(err);
            if (direct.type !== "discord" || !data.respondPrivate || !current()) throw new Error("private delivery unavailable");
            const sent = await withinBudget(data.respondPrivate(text, c), deadline);
            return { ...sent, chatId: owner.chatId, threadId: owner.threadId };
          }
        };
        if (exposureId) await withinBudget(this.postNonceButtonPromptOrThrow({
          prefix: "dashboard:", alertType: "login", instanceName: "dashboard", adapter: direct, adapterId,
          chatId: owner.userId, message: t("dashboard.public_close"), choices: [{ action: "close", label: t("dashboard.public_close") }],
          expiredText: t("buttons.stale"), timeoutMs: 5 * 60_000, extra: { requesterUserId: owner.userId, publicExposureId: exposureId, dashboardOwner: owner }, deliver,
        }), deadline);
        else await deliver();
        if (!current() || this.webToken !== token) throw new Error("owner changed");
        return true;
      } catch (err) {
        this.webLoginCodes!.revokeIfCurrent(issued.issuanceId);
        this.logger.info({ err: (err as Error)?.message }, "Dashboard private delivery was not confirmed");
        return false;
      }
    };
    let ok = false;
    try {
      ok = action === "public"
        ? await this.getPublicWebLink().deliver(owner, link => send(link.url, link.exposureId, link.expiresAt, link.isCurrent), p => {
          lastSteps = p;
          steps?.update(() => renderPublicLinkProgress(p, performance.now()));
        })
        : await send(`http://${this.fleetConfig?.hostname || "localhost"}:${this.fleetConfig?.health_port ?? 19280}/signin`);
    } catch (err) {
      // Still closes the step editor below and tells the clicker: a throw must not leave the menu refreshing.
      this.logger.warn({ err }, "Dashboard sign-in delivery failed");
    }
    // Only safe, static words enter General; never link, code or platform error text.
    const outcome = t(!ok ? "dashboard.private_failed"
      : (owner.binding as ChannelAdapter).type !== "discord" ? "dashboard.private_sent" : deliveredByDm ? "dashboard.private_sent_dm" : "dashboard.private_sent_here");
    await progress;
    await steps?.close(); // the last step edit has landed: the outcome cannot be overwritten by it
    await this.retireNonceButtons(entry, entry.messageId ?? data.messageId,
      lastSteps ? renderPublicLinkProgress(lastSteps, performance.now(), outcome) : outcome, data.editClicked);
    return true;
  }

  /** `/dashboard revoke`: sign out every browser and withdraw any unused code. */
  revokeWebSessions(): { count: number; durable: boolean } {
    this.initializeWebSessions();
    void this.publicWebLink?.close("dashboard revoke");
    this.webLoginCodes!.revoke();
    const result = this.webSessions!.revokeAll();
    if (result.durable) this.logger.info({ count: result.count }, "Web sessions revoked (all)");
    else this.logger.warn({ count: result.count }, "Web sessions revoked in memory only — the session file could not be updated or removed");
    return result;
  }

  /** Called by the sign-in endpoint: a login the operator did not make should be visible to them. */
  onWebLogin(info: { label: string; surface: "local" | "gateway"; tier: string; handle: string }): void {
    if (this.fleetConfig?.web?.notify_login === false) return;
    // The session handle makes each notice distinct: notifyFleetError throttles by text, and a second
    // sign-in from the same kind of browser is exactly the one the operator most needs to hear about.
    this.notifyFleetError(t("web.login_notice", info.label, info.surface, info.handle.slice(0, 8)));
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

  /** Persist the public response, wait for idle, then start the canonical service restart. */
  async requestFullRestart(
    adapter: ChannelAdapter,
    chatId: string,
    threadId: string | undefined,
    messageId: string,
  ): Promise<boolean> {
    const target = {
      adapterId: adapter.id,
      chatId,
      ...(threadId ? { threadId } : {}),
      messageId,
    };
    // This check is synchronous with the marker write below. A second command
    // cannot slip through between them on Node's event loop and replace the
    // first command's delivery target or launch a competing restart helper.
    if (this.shuttingDown || isUpdateInProgress(this.dataDir)) {
      this.logger.warn({ adapterId: adapter.id }, "Full restart refused because another planned restart is active");
      await this.reportFullRestartFailure(adapter, chatId, threadId, messageId, t("restart.full_busy"));
      return false;
    }
    if (!persistFullRestartProgress(this.dataDir, target)) {
      this.logger.error({ adapterId: adapter.id }, "Full restart marker could not be persisted — reload refused");
      await this.reportFullRestartFailure(adapter, chatId, threadId, messageId, t("restart.full_launch_failed"));
      return false;
    }

    const ownedMarker = readUpdateProgress(this.dataDir);
    if (!ownedMarker) {
      this.logger.error({ adapterId: adapter.id }, "Full restart marker disappeared after persistence — reload refused");
      await this.reportFullRestartFailure(adapter, chatId, threadId, messageId, t("restart.full_launch_failed"));
      return false;
    }

    this.lastUpdateProgressText = null;
    this.updateCompletionTipText = null;
    this.startUpdateProgressMonitor(adapter);
    await this.waitForFullRestartIdleGrace();

    // An update can begin while the idle wait yields. Never launch a second
    // process replacement against a marker we no longer own.
    if (this.shuttingDown || !this.isOwnedFullRestartMarker(ownedMarker.startedAt, target)) {
      this.logger.warn({ adapterId: adapter.id }, "Full restart superseded during idle wait — reload refused");
      if (this.isOwnedFullRestartMarker(ownedMarker.startedAt, target)) clearUpdateMarker(this.dataDir);
      await this.reportFullRestartFailure(adapter, chatId, threadId, messageId, t("restart.full_busy"));
      return false;
    }

    let helper: FullRestartHelperHandle;
    try {
      helper = await this.fullRestartLauncher();
    } catch (err) {
      this.logger.error({ err }, "Full restart helper failed to spawn — reload refused");
      if (this.isOwnedFullRestartMarker(ownedMarker.startedAt, target)) clearUpdateMarker(this.dataDir);
      await this.reportFullRestartFailure(adapter, chatId, threadId, messageId, t("restart.full_launch_failed"));
      return false;
    }

    void helper.completion.then(result => {
      // A zero exit means the service manager accepted the restart. launchd
      // may report that before its SIGTERM reaches us, so only an explicit
      // helper error/non-zero exit is evidence of failure. A signal is also
      // ambiguous under systemd because this helper shares the old cgroup.
      if (this.shuttingDown || !this.isOwnedFullRestartMarker(ownedMarker.startedAt, target)) return;
      // The restart job outlived the helper's wait (systemd still running it): the new fleet settles the marker.
      if (!result.error && (result.code === 0 || result.code === null || result.code === SYSTEMD_RESTART_INDETERMINATE_EXIT_CODE)) return;
      const detail = result.error
        ? "reload helper failed after launch"
        : `reload helper exited before process hand-off (code ${result.code ?? "null"}, signal ${result.signal ?? "none"})`;
      this.logger.error({ result }, "Full restart helper exited before the fleet began shutting down");
      setUpdateProgressStage(this.dataDir, "failed", { error: detail });
    });
    return true;
  }

  private isOwnedFullRestartMarker(
    startedAt: number,
    target: { adapterId: string; chatId: string; threadId?: string; messageId: string },
  ): boolean {
    const marker = readUpdateProgress(this.dataDir);
    if (!marker || marker.startedAt !== startedAt || marker.pid !== process.pid) return false;
    if (updateProgressOperation(marker.progress) !== "full-restart") return false;
    const current = marker.progress.target;
    return current.adapterId === target.adapterId
      && current.chatId === target.chatId
      && current.threadId === target.threadId
      && current.messageId === target.messageId;
  }

  /** Give current work the same bounded idle grace used by graceful reload. */
  private async waitForFullRestartIdleGrace(): Promise<void> {
    const instanceNames = [...this.daemons.keys()];
    if (instanceNames.length === 0) return;
    const IDLE_TIMEOUT_MS = 5 * 60_000;
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error("Idle wait timed out after 5 minutes")), IDLE_TIMEOUT_MS);
    });
    try {
      await Promise.race([
        Promise.all(instanceNames.map(async name => {
          const daemon = this.daemons.get(name);
          if (!daemon) return;
          this.logger.info(`Full restart: waiting for ${name} to idle...`);
          await daemon.waitForIdle(10_000);
        })),
        deadline,
      ]);
    } catch (err) {
      this.logger.warn({ err }, "Full restart idle wait timed out — continuing with service restart");
    } finally {
      clearTimeout(timeoutHandle!);
    }
  }

  private async reportFullRestartFailure(
    adapter: ChannelAdapter,
    chatId: string,
    threadId: string | undefined,
    messageId: string,
    text: string,
  ): Promise<void> {
    try {
      await adapter.editMessage(chatId, messageId, text, threadId);
      return;
    } catch (err) {
      this.logger.warn({ err, adapterId: adapter.id }, "Failed to edit rejected full-restart request; posting a fresh notice");
    }
    try {
      await adapter.sendText(chatId, text, { threadId });
    } catch (err) {
      this.logger.error({ err, adapterId: adapter.id }, "Failed to deliver full-restart rejection");
    }
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
    this.loginWindow.reopen();                          // a stopAll → startAll restart must accept login windows again
    this.loginController?.reopen();
    const startupStartedAt = Date.now();
    FleetManager.signalTarget = this;
    this.startupComplete = false;
    // Cleared here, not at the end of doStopAll: a stop has an async tail, and
    // anything arriving during it is still part of the stop.
    this.shuttingDown = false;
    this.configPath = configPath;
    const settingsGeneration = this.settingsGeneration;
    const envLease = await waitSettingsLease([settingsFileResource(join(this.dataDir, ".env"))],
      () => !this.shuttingDown && this.settingsGeneration === settingsGeneration, performance.now() + 30_000);
    try { this.loadEnvFile(envLease.owner); } finally { envLease.release(); }
    this.ensureDeliveryOutbox();

    this.rotateFleetLogs();

    const fleet = this.loadConfig(configPath);
    this.slimFleetConfigAtStartup();
    setLocale(detectLocale(fleet)); // user-facing text language (fleet.yaml defaults.locale / timezone)
    const savedUpdateProgress = readUpdateProgress(this.dataDir);
    const pendingUpdateProgress = savedUpdateProgress
      && savedUpdateProgress.progress.stage !== "failed"
      && savedUpdateProgress.progress.stage !== "complete"
      ? savedUpdateProgress
      : null;
    const pendingProgressOperation = pendingUpdateProgress
      ? updateProgressOperation(pendingUpdateProgress.progress)
      : null;
    if (pendingUpdateProgress) {
      setUpdateProgressStage(this.dataDir, "starting", { version: pendingUpdateProgress.progress.version });
    }
    this.initializeWebAuthTokens();
    // Must run before the first General/CLI spawn: pressure can hold startup.
    // Logs remain available even before the adapters and health listener exist.
    this.memoryPressure.start();
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
        const isOrphanedInstance = !isKnownInstance && isOrphanInstanceWindowName(w.name);
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
    // The unrecoverable-id report is deliberately NOT sent here: no adapter
    // exists yet at this point in startAll(), so notifyFleetError would find
    // nothing to deliver through, drop the message silently, AND burn its
    // 10-minute throttle key on the way out. It is sent once the shared adapter
    // is up — see the adapterStartup continuation below.
    // Restore the persisted bot binding so replies/cancel go through the right
    // bot after a restart (before this, inbound would re-bind lazily).
    for (const ch of this.classicChannels.getAll()) {
      if (ch.adapterId) this.instanceWorldBinding.set(ch.instanceName, ch.adapterId);
    }

    // Poll classicBot.yaml for external changes every 30s
    this.classicReloadTimer = setInterval(() => {
      // Attributes the synchronous part, up to the reload's first await (#1235).
      void measureSyncWork("fleet.classicReload", () => this.reloadClassicConfigFromDisk());
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
      this.postDailySummary(text);
      // Rotate classic channel chat logs daily
      this.classicChannels?.rotateLogs();
      this.rotateInboxes();
      this.rotateFleetLogs();
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
    // Web uploads no message took before this restart (#1273).
    this.sweepOrphanedWebUploads();

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
        (schedule, runId, retry) => this.handleScheduleTrigger(schedule, runId, retry),
        schedulerConfig,
        (name) => this.fleetConfig?.instances?.[name] != null || !!this.classicChannels?.getAll().some(ch => ch.instanceName === name),
        (schedule, retry, reason) => this.scheduleRetryDropped(schedule, retry, reason),
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
      { mode: pendingProgressOperation === "full-restart" ? "reload" : pendingUpdateProgress ? "update" : "restart" },
    );

    if (generals.length > 0) {
      for (const [name, cfg] of generals) {
        try {
          await this.startInstance(name, cfg, topicMode);
          if (this.daemons.has(name)) startupProgress.markReady();
        } catch (err) {
          this.logger.error({ err, name }, "Failed to start general instance");
          // General is the most important instance to bring back: it also gets
          // the delayed automatic retry (the topic notice below still goes out).
          this.scheduleStartupRetry(name, 0);
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
        // Now that there is somewhere to deliver: a classicBot.yaml that already
        // holds an unmatchable id at boot is the COMMON case, and reporting it
        // before the adapter existed meant the operator heard nothing at all.
        this.reportClassicUnrecoverableIds();
      })();
      progressStart = adapterStartup.then(() => {
        if (pendingUpdateProgress) {
          const saved = pendingUpdateProgress.progress.target;
          const target: RestartProgressTarget = {
            adapter: this.adapters.get(saved.adapterId),
            // Adapter retries replace the failed object in this map. Resolve at
            // every progress delivery so the adopted update message follows the
            // live, ready generation instead of remaining pinned to a stopped
            // client. This also waits when the first generation failed before
            // any adapter object was registered.
            resolveAdapter: () => this.readyProgressAdapter(saved.adapterId),
            chatId: saved.chatId,
            threadId: saved.threadId,
          };
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
    // #1231: a stalled loop is what turns a slash command into "did not respond";
    // put each long stall in the log instead of leaving it to be guessed at.
    this.eventLoopWatch?.stop();
    this.eventLoopWatch = startEventLoopWatch({ logger: this.logger });

    // EventLog.prune() existed but was never called, so `events` and `activity`
    // grew without bound for the life of the install. Prune once at startup and
    // daily after that; the timer is unref'd so it never holds the loop open.
    this.pruneEventLog();
    this.eventLogPruneTimer = setInterval(() => this.pruneEventLog(), 24 * 60 * 60_000);
    this.eventLogPruneTimer.unref?.();

    // #1335: delivery-outbox.db and Task Board retention. Same once-at-startup
    // + daily-timer pattern; chunked DELETEs so one run cannot hold the loop.
    void this.pruneOutboxAndTasks();
    this.outboxPruneTimer = setInterval(() => { void this.pruneOutboxAndTasks(); }, 24 * 60 * 60_000);
    this.outboxPruneTimer.unref?.();

    // Same shape for logs, and for the same reason: the only sweep that
    // covered them lived inside the daily-summary callback, so it did not run at
    // all when summaries were off.
    this.rotateAllInstanceLogs();
    this.logRotateTimer = setInterval(() => {
      this.rotateFleetLogs();
      this.rotateAllInstanceLogs();
    }, 24 * 60 * 60_000);
    this.logRotateTimer.unref?.();

    // Phase 2: Start remaining instances with staggered concurrency
    if (others.length > 0) {
      await this.startInstancesWithConcurrency(others, topicMode, () => startupProgress.markReady());
    }

    if (topicMode && (fleet.channel || fleet.channels?.length)) {
      await adapterStartup;
      this.startDiscordUsagePresence();

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
            if (await this.startClassicInstanceUnattended(ch, "classic instance")) startupProgress.markReady();
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
        tipText: pendingProgressOperation === "update" && this.tipsEnabled()
          ? (() => {
              const tip = this.pickAvailableTip();
              return tip ? this.formatTip(tip) : undefined;
            })()
          : undefined,
      });
      if (!progressCompleted && fleet.channel?.group_id) {
        let text: string;
        if (pendingProgressOperation === "full-restart") {
          text = formatRestartProgressCompletion("reload", {
            running: started,
            total,
            version: agendVersion,
            pausedNames,
            failedNames,
          }, pendingUpdateProgress!.startedAt);
        } else if (failedNames.length === 0 && pausedNames.length === 0) {
          text = t("fleet.ready", started, total, agendVersion);
        } else if (failedNames.length === 0) {
          text = t("fleet.ready", started, total, agendVersion) + `\n⏸ Paused: ${pausedNames.join(", ")}`;
        } else {
          text = t("fleet.ready_with_failed", started, total, agendVersion, failedNames.join(", "))
            + (pausedNames.length > 0 ? `\n⏸ Paused: ${pausedNames.join(", ")}` : "");
        }
        await this.sendFleetStartCompletionFallback(
          String(fleet.channel.group_id),
          text,
          generalThreadId != null ? String(generalThreadId) : undefined,
        );
      }
      // After "fleet ready", so the notice is not the first thing people see of a restart.
      void this.announceWebChatOnce(agendVersion);
    }

    // Health HTTP endpoint
    this.startHealthServer(fleet.health_port ?? 19280);
    // #1266: buttons that ended while AgEnD was down (expired, or chosen before a restart) are shown as ended now.
    void this.replyButtons()?.sweep().catch(err => this.logger.warn({ err }, "Reply-button sweep failed"));

    // Daily update check — first check after 1 hour, then every 24 hours
    this.updateCheckTimer = setTimeout(() => {
      this.checkForUpdates();
      this.updateCheckTimer = setInterval(() => this.checkForUpdates(), 24 * 60 * 60 * 1000);
    }, 60 * 60 * 1000);

    const onRestart = () => this.onGracefulRestartSignal(() => process.once("SIGUSR2", onRestart));
    process.once("SIGUSR2", onRestart);

    // SIGUSR1: full process reload (graceful stop → exit → CLI restarts)
    process.once("SIGUSR1", () => this.onFullRestartSignal());

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

  /** Keep Discord profile activity aligned with the same cached usage source as /usage. */
  private startDiscordUsagePresence(): void {
    if (this.discordPresenceTimer) clearInterval(this.discordPresenceTimer);
    if (this.discordPresenceEagerTimer) {
      clearTimeout(this.discordPresenceEagerTimer);
      this.discordPresenceEagerTimer = null;
    }
    this.discordPresenceEagerPending = false;
    void this.refreshDiscordUsagePresence();
    this.discordPresenceTimer = setInterval(() => {
      void this.refreshDiscordUsagePresence();
    }, FleetManager.DISCORD_PRESENCE_REFRESH_MS);
    this.discordPresenceTimer.unref?.();
  }

  /**
   * Request one prompt presence refresh after an instance/adapter comes online.
   * Startup can bring several instances up together; a short coalescing window
   * keeps that herd on the existing shared refresh path and one usage fetch.
   */
  private requestDiscordUsagePresenceRefresh(): void {
    this.discordPresenceEagerPending = true;
    // During early fleet startup the interval is not installed yet; its first
    // refresh in startDiscordUsagePresence already covers all pending starts.
    if (!this.discordPresenceTimer || this.discordPresenceEagerTimer) return;
    this.discordPresenceEagerTimer = setTimeout(() => {
      this.discordPresenceEagerTimer = null;
      if (!this.discordPresenceEagerPending || !this.discordPresenceTimer) return;
      this.discordPresenceEagerPending = false;
      void this.refreshDiscordUsagePresence();
    }, 50);
    this.discordPresenceEagerTimer.unref?.();
  }

  private refreshDiscordUsagePresence(): Promise<void> {
    if (this.discordPresenceInFlight) return this.discordPresenceInFlight;
    const run = (async () => {
      const targets = [...this.adapters.values()]
        .filter(adapter => adapter.type === "discord" && typeof adapter.setActivity === "function");
      if (targets.length === 0) return;
      try {
        // Fetch the shared snapshot once, then scope the projection to each
        // adapter's own fleet/Classic instances.  Passing the fleet-wide active
        // set here would make every bot advertise providers owned by a sibling
        // bot (notably ClassicBot's Grok/Antigravity rows).
        const payload = await getUsageSnapshot(false);
        for (const adapter of targets) {
          try {
            const scoped = filterUsageProviders(payload, this.getUsageProviderIdsForAdapter(adapter.id));
            adapter.setActivity?.(formatDiscordUsageActivity(scoped));
          } catch {
            // Presence is cosmetic; a failed update must not affect delivery.
          }
        }
      } catch {
        // Usage providers are best-effort and may be offline. Keep the last
        // activity rather than replacing it with an untruthful blank state.
        this.logger.debug("Discord usage presence refresh skipped");
      }
    })();
    const done = run.finally(() => {
      if (this.discordPresenceInFlight === done) this.discordPresenceInFlight = null;
    });
    this.discordPresenceInFlight = done;
    return done;
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

  /**
   * Web uploads no message took before a restart (#1273): removed once older than the upload window. Younger ones
   * are looked at again when the first comes due (an unref'd timer, so it never holds the process).
   */
  private sweepOrphanedWebUploads(): void {
    // Skip what this process's ledger still holds: those are uploads made since this start, timed by the ledger.
    // (Compared the way the sweep names files: the inbox directory resolved, the file name as it is.)
    const owned = new Set([...this.webFiles.ownedPaths()].map(p => { try { return join(realpathSync(dirname(p)), basename(p)); } catch { return p; } }));
    const { deleted, nextDueInMs } = sweepOrphanedUploads(join(getAgendHome(), "workspaces"), Date.now(), undefined, owned);
    if (deleted > 0) this.logger.info({ deleted }, "Removed web uploads no message took before the restart");
    if (nextDueInMs !== null) {
      const t = setTimeout(() => this.sweepOrphanedWebUploads(), Math.max(1_000, nextDueInMs + 1_000));
      t.unref?.();
    }
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

  private bindAdapterHealth(adapter: ChannelAdapter, adapterId: string): void {
    // Discord slash command registration, every gateway ready (#1131). A
    // rejected registration leaves the previous command list in place, so a
    // new command silently never appears: log every outcome, and tell General
    // once per failure streak (a reconnect loop must not repeat it).
    adapter.on("slash_registration", (outcome: { ok: boolean; count?: number; code?: unknown; status?: unknown; message?: string }) => {
      if (this.adapters.get(adapterId) !== adapter) return;
      if (outcome.ok) {
        this.slashRegistrationFailed.delete(adapterId);
        this.logger.info({ adapterId, count: outcome.count }, "Registered Discord slash commands");
        return;
      }
      this.logger.warn({ adapterId, code: outcome.code, status: outcome.status, error: outcome.message },
        "Discord rejected the slash command registration; the previous command list stays");
      if (this.slashRegistrationFailed.has(adapterId)) return;
      const detail = [outcome.code, outcome.message].filter(v => v !== undefined && v !== "").join(" ");
      // The streak is the de-duplication (not the shared text throttle), and
      // it counts as told only once General actually got it: with nowhere to
      // post yet, the next failure tries again.
      if (this.notifyFleetError(t("discord.slash_registration_failed", adapterId, detail), { throttle: false })) {
        this.slashRegistrationFailed.add(adapterId);
      }
    });
    adapter.on("gateway_health", (snapshot: AdapterHealthSnapshot) => {
      // A token rotation tears down the old EventEmitter before constructing
      // the replacement. A late health frame from that old client must never
      // make a failed/new-generation adapter look connected.
      if (this.adapters.get(adapterId) !== adapter) return;
      const previous = this.adapterState.get(adapterId);
      const status = snapshot.status === "connected" ? "connected"
        : snapshot.status === "stopped" ? "failed"
          : "retrying";
      this.adapterState.set(adapterId, {
        status,
        retryCount: previous?.retryCount ?? 0,
        lastError: status === "connected" ? undefined : snapshot.lastReconnectReason ?? previous?.lastError,
      });
    });
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
    adapters: { total: number; connected: number; states: Record<string, string>; details: Record<string, AdapterHealthSnapshot> };
    startupComplete: boolean;
    /** See process-memory.ts: the fleet process and the whole service cgroup are
     *  reported separately because they differ by ~60x and only one of them can
     *  show a fleet-manager leak. */
    memory: FleetMemory;
    hostMemory: MemoryPressureSnapshot;
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
    const details: Record<string, AdapterHealthSnapshot> = {};
    let connected = 0;
    for (const [id, state] of this.adapterState) {
      const snapshot = this.adapters.get(id)?.getHealthSnapshot?.();
      if (snapshot) details[id] = snapshot;
      const effectiveStatus = snapshot?.status === "connected" ? "connected"
        : snapshot && snapshot.status !== "stopped" ? "retrying"
          : state.status;
      states[id] = effectiveStatus;
      if (effectiveStatus === "connected") connected++;
    }

    const problems: string[] = [];
    const hostMemory = this.memoryPressure.snapshot();
    if (!this.memoryPressure.advisoryOnly() && (hostMemory.level === "critical" || hostMemory.level === "elevated")) {
      problems.push(`host memory pressure is ${hostMemory.level}`);
    }
    if (this.adapterState.size > 0 && connected === 0) problems.push("no channel adapter is connected");
    if (counts.crashed > 0) problems.push(`${counts.crashed} instance(s) crashed`);
    for (const [id, state] of Object.entries(states)) {
      if (state !== "connected") problems.push(`adapter ${id} is ${state}`);
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
      adapters: { total: this.adapterState.size, connected, states, details },
      startupComplete: this.startupComplete,
      memory: readFleetMemory(),
      hostMemory,
      problems,
    };
  }

  /** Start the primary adapter (backward-compatible, sets this.adapter) */
  private async startSingleAdapter(fleet: FleetConfig, channelConfig: ChannelConfig, onStarted?: () => void, operation?: Pick<SettingsExecution, "owner" | "assert">): Promise<void> {
    const id = channelConfig.id ?? channelConfig.type;
    const lease = trySettingsLease([`connection:${this.dataDir}:${id}`], operation?.owner);
    if (!lease) throw new Error("connection operation is still running");
    try { await this.startSingleAdapterOwned(fleet, channelConfig, onStarted, operation ?? { owner: lease.owner, assert: () => {} }); }
    finally { lease.release(); }
  }

  private async startSingleAdapterOwned(
    fleet: FleetConfig,
    channelConfig: ChannelConfig,
    onStarted?: () => void,
    operation?: Pick<SettingsExecution, "owner" | "assert">,
  ): Promise<void> {
    const ownerId = channelConfig.id ?? channelConfig.type, generation = this.settingsGeneration;
    const check = (): void => {
      operation?.assert(); assertSettingsLease(`connection:${this.dataDir}:${ownerId}`, operation?.owner);
      if (this.shuttingDown || this.settingsGeneration !== generation) throw new Error("adapter admission superseded");
    };
    check();
    const botToken = process.env[channelConfig.bot_token_env];
    if (!botToken) {
      this.logger.warn({ env: channelConfig.bot_token_env }, "Bot token env not set, skipping shared adapter");
      return;
    }

    const accessDir = join(this.dataDir, "access");
    mkdirSync(accessDir, { recursive: true });
    const accessStatePath = join(accessDir, "access.json");
    const accessManager = new AccessManager(
      channelConfig.access ?? DEFAULT_OPEN_ACCESS,
      accessStatePath,
    );
    this.warnIfAccessModeOverridden(accessManager, accessStatePath);

    const inboxDir = join(this.dataDir, "inbox");
    mkdirSync(inboxDir, { recursive: true });

    const adapterId = channelConfig.id ?? channelConfig.type;
    const adapter = await createAdapter(channelConfig, {
      id: adapterId,
      botToken,
      accessManager,
      inboxDir,
      fleetLabel: fleetLabel(this.fleetConfig),
    });
    try { check(); } catch (err) { await adapter.stop().catch(() => {}); throw err; }
    this.adapter = adapter; this.accessManager = accessManager;
    const world = new AdapterWorld(adapterId, adapter, accessManager, channelConfig);
    this.worlds.set(adapterId, world);
    (this.adapters as Map<string, ChannelAdapter>).set(adapterId, adapter);
    this.bindAdapterHealth(adapter, adapterId);
    const isCurrentAdapter = (): boolean => this.adapters.get(adapterId) === adapter;

    adapter.on("message", safeHandler(async (msg: InboundMessage) => {
      if (!isCurrentAdapter()) return;
      await this.handleInboundMessage(msg);
    }, this.logger, "adapter.message"));

    adapter.on("reaction", safeHandler(async (r: InboundReaction) => {
      if (!isCurrentAdapter()) return;
      await this.handleInboundReaction(r);
    }, this.logger, "adapter.reaction"));

    adapter.on("callback_query", safeHandler(async (data: AdapterCallbackData) => {
      await this.receiveAdapterCallback(data, adapterId, adapter, isCurrentAdapter);
    }, this.logger, "adapter.callback_query"));

    this.bindTopicClosedHandler(adapter, adapterId, "adapter.topic_closed");

    // Handle classic bot slash commands (/start, /stop, /chat, /compact, /save, /load)
    adapter.on("slash_command", safeHandler(async (data: ClassicStartSlashData) => {
      if (!isCurrentAdapter()) return;
      await this.dispatchSlash(data, adapterId, adapter);
    }, this.logger, "adapter.slash_command"));

    // This adapter's own Telegram menus — each Telegram adapter registers its own when it starts (#1191).
    this.registerTelegramCommandsFor(channelConfig);

    // Background-probe each backend's CLI env (version/models) → cli-env cache.
    // Non-blocking: /model & status views read the cache; never delays startup.
    this.probeCliEnvs();

    adapter.on("started", safeHandler((username: string, userId?: string) => {
      if (!isCurrentAdapter()) return;
      this.logger.info(`Bot @${username} polling started. Ensure no other service is polling this bot token.`);
      // Concurrent startup can insert a secondary world first. Update the
      // configured primary world, not Map insertion order.
      const w = this.worlds.get(adapterId);
      if (w) {
        w.botUsername = username;
        if (userId) w.botUserId = userId;
      }
      if (userId) this.botUserId = userId;
      onStarted?.();
    }, this.logger, "adapter.started"));
    adapter.on("polling_conflict", safeHandler(({ attempt, delay }: { attempt: number; delay: number }) => {
      this.logger.warn(`409 Conflict (attempt ${attempt}), retry in ${delay / 1000}s`);
    }, this.logger, "adapter.polling_conflict"));
    adapter.on("handler_error", safeHandler((err: unknown) => {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Adapter handler error");
    }, this.logger, "adapter.handler_error"));
    adapter.on("error", (err: unknown) => {
      if (!isCurrentAdapter()) return;
      this.logger.error({ err }, "Primary adapter fatal error");
      this.restartAdapter(adapter, adapterId).catch(() => {});
    });

    adapter.on("new_group_detected", safeHandler(async (data: { groupId: string; groupTitle: string; source: string }) => {
      if (!isCurrentAdapter()) return;
      const adminMsg = t("alert.bot_added", data.groupTitle, data.groupId, data.source);
      const generalId = this.findGeneralInstance();
      // No user to promote: the bot was just added, nobody has run /start yet.
      if (generalId) await this.promptClassicApproval({ generalName: generalId, message: adminMsg, groupId: data.groupId, scope: data.source === "telegram" ? "group" : "guild" });
    }, this.logger, "adapter.new_group_detected"));

    // Start adapter AFTER all event listeners are registered (started event sets botUsername)
    try {
      await adapter.start(); check();
      if (!isCurrentAdapter()) throw new Error("adapter ownership changed during login");
    } catch (err) { await this.disposeSettingsAdapter(adapterId, adapter); throw err; }
    if (channelConfig.group_id) {
      adapter.setChatId(String(channelConfig.group_id));
    }
    if (this.discordPresenceTimer && adapter.type === "discord") {
      this.requestDiscordUsagePresenceRefresh();
    }

    this.startTopicCleanupPoller();

    // Prune stale external sessions every 5 minutes
    this.sessionPruneTimer = setInterval(() => {
      this.pruneStaleExternalSessions().catch(err =>
        this.logger.debug({ err }, "Session prune failed"));
    }, 5 * 60 * 1000);
  }

  /**
   * Register a Telegram connection's command menus; any other kind of channel has none to register. Started, not
   * awaited: a slow api.telegram.org must never hold up the adapter's login (each call has its own timeout). Never fatal.
   */
  private registerTelegramCommandsFor(channelConfig: ChannelConfig): void {
    if (channelConfig.type !== "telegram") return;
    void this.topicCommands.registerBotCommands(channelConfig).catch(e =>
      this.logger.warn({ err: e, adapterId: channelConfig.id ?? channelConfig.type }, "registerBotCommands failed (non-fatal)"));
  }

  /** Start an additional (non-primary) adapter */
  private async startAdditionalAdapter(channelConfig: ChannelConfig, registerCommands = true, onStarted?: () => void, operation?: Pick<SettingsExecution, "owner" | "assert">): Promise<void> {
    const id = channelConfig.id ?? channelConfig.type;
    const lease = trySettingsLease([`connection:${this.dataDir}:${id}`], operation?.owner);
    if (!lease) throw new Error("connection operation is still running");
    try { await this.startAdditionalAdapterOwned(channelConfig, registerCommands, onStarted, operation ?? { owner: lease.owner, assert: () => {} }); }
    finally { lease.release(); }
  }

  private async startAdditionalAdapterOwned(
    channelConfig: ChannelConfig,
    registerCommands = true,
    onStarted?: () => void,
    operation?: Pick<SettingsExecution, "owner" | "assert">,
  ): Promise<void> {
    const adapterId = channelConfig.id ?? channelConfig.type;
    const ownerId = channelConfig.id ?? channelConfig.type, generation = this.settingsGeneration;
    const check = (): void => {
      operation?.assert(); assertSettingsLease(`connection:${this.dataDir}:${ownerId}`, operation?.owner);
      if (this.shuttingDown || this.settingsGeneration !== generation) throw new Error("adapter admission superseded");
    };
    check();
    const botToken = process.env[channelConfig.bot_token_env];
    if (!botToken) {
      this.logger.warn({ env: channelConfig.bot_token_env, adapterId }, "Bot token env not set, skipping adapter");
      return;
    }

    const accessDir = join(this.dataDir, "access");
    mkdirSync(accessDir, { recursive: true });
    const accessStatePath = join(accessDir, `access-${adapterId}.json`);
    const accessManager = new AccessManager(
      channelConfig.access ?? DEFAULT_OPEN_ACCESS,
      accessStatePath,
    );
    this.warnIfAccessModeOverridden(accessManager, accessStatePath);
    const inboxDir = join(this.dataDir, "inbox");
    mkdirSync(inboxDir, { recursive: true });

    const adapter = await createAdapter(channelConfig, {
      id: adapterId,
      botToken,
      accessManager,
      inboxDir,
      registerCommands,
      fleetLabel: fleetLabel(this.fleetConfig),
    });
    try { check(); } catch (err) { await adapter.stop().catch(() => {}); throw err; }
    const world = new AdapterWorld(adapterId, adapter, accessManager, channelConfig);
    this.worlds.set(adapterId, world);
    (this.adapters as Map<string, ChannelAdapter>).set(adapterId, adapter);
    this.bindAdapterHealth(adapter, adapterId);
    const isCurrentAdapter = (): boolean => this.adapters.get(adapterId) === adapter;

    // Wire up event handlers (same as primary, routes through shared handleInboundMessage)
    adapter.on("message", safeHandler(async (msg: InboundMessage) => {
      if (!isCurrentAdapter()) return;
      await this.handleInboundMessage(msg);
    }, this.logger, `adapter[${adapterId}].message`));

    adapter.on("reaction", safeHandler(async (r: InboundReaction) => {
      if (!isCurrentAdapter()) return;
      await this.handleInboundReaction(r);
    }, this.logger, `adapter[${adapterId}].reaction`));

    adapter.on("callback_query", safeHandler(async (data: AdapterCallbackData) => {
      await this.receiveAdapterCallback(data, adapterId, adapter, isCurrentAdapter);
    }, this.logger, `adapter[${adapterId}].callback_query`));

    this.bindTopicClosedHandler(adapter, adapterId, `adapter[${adapterId}].topic_closed`);

    // Slash commands: classic bot + admin commands
    adapter.on("slash_command", safeHandler(async (data: ClassicStartSlashData) => {
      if (!isCurrentAdapter()) return;
      await this.dispatchSlash(data, adapterId, adapter);
    }, this.logger, `adapter[${adapterId}].slash_command`));

    adapter.on("started", safeHandler((username: string, userId?: string) => {
      if (!isCurrentAdapter()) return;
      this.logger.info(`[${adapterId}] Bot @${username} polling started.`);
      const world = this.worlds.get(adapterId);
      if (world) {
        world.botUsername = username;
        if (userId) world.botUserId = userId;
      }
      onStarted?.();
    }, this.logger, `adapter[${adapterId}].started`));

    adapter.on("new_group_detected", safeHandler(async (data: { groupId: string; groupTitle: string; source: string }) => {
      if (!isCurrentAdapter()) return;
      const adminMsg = t("alert.bot_added", data.groupTitle, data.groupId, data.source);
      const generalId = this.findGeneralInstance(adapterId);
      if (generalId) await this.promptClassicApproval({ generalName: generalId, message: adminMsg, groupId: data.groupId, scope: data.source === "telegram" ? "group" : "guild" });
    }, this.logger, `adapter[${adapterId}].new_group_detected`));
    adapter.on("error", (err: unknown) => {
      if (!isCurrentAdapter()) return;
      this.logger.error({ err, adapterId }, "Additional adapter fatal error");
      this.restartAdapter(adapter, adapterId).catch(() => {});
    });

    // A secondary Telegram connection (a ClassicBot next to a Discord fleet, say) has menus of its own to register —
    // at fleet start, on retry, and when Settings rebinds it or rotates its token: all of them start it here (#1191).
    this.registerTelegramCommandsFor(channelConfig);

    // Register lifecycle listeners before login; a fast ready/error must not be lost.
    try {
      await adapter.start(); check();
      if (!isCurrentAdapter()) throw new Error("adapter ownership changed during login");
    } catch (err) { await this.disposeSettingsAdapter(adapterId, adapter); throw err; }
    if (channelConfig.group_id) {
      adapter.setChatId(String(channelConfig.group_id));
    }
    if (this.discordPresenceTimer && adapter.type === "discord") {
      this.requestDiscordUsagePresenceRefresh();
    }

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
        } else if (toolForIpcType(msg.type) !== null) {
          // Sink 2 of 3. Each of these types IS a tool and reaches its own
          // handler without passing through the outbound path — which is how
          // `update_decision`, a coordinator-only tool, kept a way through.
          const typed = this.checkToolPermission("ipc-typed", name, toolForIpcType(msg.type)!);
          if (typed.allowed) this.dispatchTypedIpc(name, msg);
          else this.refuseTypedIpc(name, msg, typed.message);
        } else if (msg.type === "instance_process_state") {
          this.cacheInstanceProcessStatus(name, msg.status);
        } else if (msg.type === "instance_activity") {
          this.cacheInstanceActivity(name, msg.activity as string | null);
        } else if (msg.type === "instance_progress") {
          this.cacheInstanceProgress(name, (msg.progress as string) || null);
        } else if (msg.type === "cross_instance_delivery_failed") {
          const senderSession = String(msg.senderSession ?? "");
          const targetInstance = String(msg.targetInstance ?? name);
          const correlationId = String(msg.correlationId ?? "unknown");
          const error = String(msg.error ?? "unknown delivery failure");
          const displayError = error.replace(/^delivery failed: phase=(.*); proof=(.*)$/,
            (_match, phase: string, proof: string) => t("delivery.pane_failure", phase, proof));
          const senderInstance = this.instanceIpcClients.has(senderSession)
            ? senderSession
            : this.sessionRegistry.get(senderSession);
          this.logger.error({ senderSession, targetInstance, correlationId, error },
            "Cross-instance pane delivery failed after queue acceptance");
          this.eventLog?.insert(targetInstance, "cross_instance_delivery_failed", {
            from: senderSession, correlation_id: correlationId, error,
          });
          if (senderInstance) {
            this.notifyInstanceTopic(senderInstance, t(
              "cross_instance.delivery_failed_notice", targetInstance, displayError, correlationId,
            ));
            void this.deliverToInstance(senderInstance, {
              type: "fleet_inbound",
              targetSession: senderSession,
              content: t("cross_instance.delivery_failed_agent", targetInstance, displayError, correlationId),
              meta: {
                chat_id: "",
                message_id: `delivery-failed-${Date.now()}`,
                user: "AgEnD",
                user_id: "system:agend",
                ts: new Date().toISOString(),
                thread_id: "",
                request_kind: "update",
                correlation_id: correlationId,
              },
            }, { waitForIdle: true }).catch(deliveryError => {
              this.logger.error({ err: deliveryError, senderSession, correlationId },
                "Could not deliver cross-instance failure status back to sender");
            });
          }
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

  private async disposeSettingsAdapter(id: string, adapter: ChannelAdapter): Promise<void> {
    adapter.removeAllListeners(); await adapter.stop().catch(() => {});
    if (this.adapters.get(id) === adapter) this.adapters.delete(id);
    if (this.worlds.get(id)?.adapter === adapter) this.worlds.delete(id);
    if (this.adapter === adapter) this.adapter = null;
  }

  /** Restart a channel adapter after fatal error with infinite retry + 60s cap */
  private async restartAdapter(adapter: ChannelAdapter, id: string): Promise<void> {
    if (this.adapterRestarting.has(id) || this.shuttingDown || this.adapters.get(id) !== adapter) return;
    const generation = this.settingsGeneration;
    const current = (): boolean => !this.shuttingDown && this.settingsGeneration === generation && this.adapters.get(id) === adapter;
    let lease: SettingsLease | null = null;
    this.adapterRestarting.add(id);
    // Reflect reality in adapterState throughout. This loop used to leave the state
    // untouched, so getAdapterStates() — and therefore /health and the dashboard —
    // kept reporting "connected" for an adapter that had been down for hours. An
    // adapter's true status was simply not knowable from inside the process.
    const previous = this.adapterState.get(id);
    this.adapterState.set(id, { status: "retrying", retryCount: 0, lastError: previous?.lastError });
    try {
      if (adapter.reconnectGateway) {
        try {
          lease = trySettingsLease([`connection:${this.dataDir}:${id}`]);
          if (!lease || !current()) return;
          // Discord requires a fresh Client after destroy(). Its adapter owns the
          // single-flight, generation fence and bounded IDENTIFY backoff, so all
          // watchdog/manual/error triggers must converge here instead of stop/start.
          await adapter.reconnectGateway(previous?.lastError ?? "fleet adapter restart");
          if (!current()) return;
          this.adapterState.set(id, { status: "connected", retryCount: 0 });
          if (this.discordPresenceTimer && adapter.type === "discord") {
            this.requestDiscordUsagePresenceRefresh();
          }
          this.logger.info({ id }, "Adapter gateway rebuilt successfully");
        } catch (err) {
          if (current() && !this.ipcStoppingInstances.has("__fleet_stopping__")) {
            this.adapterState.set(id, {
              status: "failed",
              retryCount: previous?.retryCount ?? 0,
              lastError: (err as Error)?.message ?? String(err),
            });
          }
        }
        return;
      }
      for (let attempt = 1; ; attempt++) {
        if (!current() || this.ipcStoppingInstances.has("__fleet_stopping__")) return;
        const delay = attempt <= 3 ? 5000 * Math.pow(2, attempt - 1) : 60_000; // 5s, 10s, 20s, then 60s
        await new Promise(r => setTimeout(r, delay));
        if (!current() || this.ipcStoppingInstances.has("__fleet_stopping__")) return;
        lease = trySettingsLease([`connection:${this.dataDir}:${id}`]);
        if (!lease) return;
        try {
          await adapter.stop().catch(() => {}); if (!current()) return;
          await adapter.start(); if (!current()) return;
          this.logger.info({ id, attempt }, "Adapter restarted successfully");
          this.adapterState.set(id, { status: "connected", retryCount: 0 });
          if (this.discordPresenceTimer && adapter.type === "discord") {
            this.requestDiscordUsagePresenceRefresh();
          }
          return;
        } catch (err) {
          if (!current()) return;
          this.adapterState.set(id, {
            status: "retrying",
            retryCount: attempt,
            lastError: (err as Error)?.message ?? String(err),
          });
        }
        lease.release(); lease = null;
        if (attempt % 10 === 0) {
          this.logger.warn({ id, attempt }, "Adapter restart still failing");
        }
      }
    } finally {
      lease?.release(); this.adapterRestarting.delete(id);
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

    if (this.isOwnStatusReaction(r)) {
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

  /**
   * Which adapter's access policy governs an inbound message.
   *
   * `authoritative` means the thread resolved to an owning instance, so that
   * adapter's policy is the only one entitled to decide. A resolved owner whose
   * policy cannot be read is NOT the same as having no owner: the owner's world
   * may not exist yet (an adapter that fails its token check returns before its
   * world and AccessManager are created) while sibling bots are already live and
   * receiving copies. Falling back to a sibling's policy — or to the fleet-wide
   * one — would let the owner's rules be decided by another adapter, so callers
   * must refuse instead.
   *
   * Without an owner (classic channels, the no-thread Telegram path, unrouted
   * threads, no adapter identity) the receiving adapter's policy applies, as
   * before.
   */
  private governingAccess(
    msg: InboundMessage,
    threadId: string | undefined,
  ): { adapterId: string | undefined; authoritative: boolean } {
    if (threadId && !this.classicChannels?.hasChannel(threadId)) {
      const target = this.resolveInboundTarget(msg, threadId);
      if (target) {
        const owner = this.getInstanceAdapterId(target.name);
        if (owner) return { adapterId: owner, authoritative: true };
      }
    }
    return { adapterId: msg.adapterId, authoritative: false };
  }

  /**
   * Why this adapter should leave an inbound message to another adapter, or null
   * to handle it.
   *
   * A fleet topic is served by exactly one instance, and that instance is
   * answered by exactly one adapter. When several bots share a guild they each
   * receive their own copy of every message, so the copy that is acted on must
   * be chosen by ownership rather than by which inbound happened to fire first.
   * Ownership is per-instance — the adapter the instance is bound to, falling
   * back to channels[0] when it is not bound — so an instance answered by a
   * non-default bot still receives its own traffic, and the access policy that
   * applies is that instance's own adapter's.
   *
   * Callers must ask before claiming the shared dedup key: a copy that is going
   * to be left alone must not consume the key, or the owner's copy would be
   * discarded as a duplicate and the message lost.
   *
   * Exempt: classic channels (each bot owns its own agent there and handles its
   * own copy, which is why their dedup key is adapter-scoped), the no-thread
   * Telegram path (no thread to resolve an instance from), and messages with no
   * adapter id (single-adapter fleets).
   */
  private topicOwnerDropReason(msg: InboundMessage, threadId: string | undefined): string | null {
    if (!threadId || !msg.adapterId) return null;
    if (this.classicChannels?.hasChannel(threadId)) return null;
    const target = this.resolveInboundTarget(msg, threadId);
    if (!target) return null;
    const ownerAdapterId = this.getInstanceAdapterId(target.name);
    if (ownerAdapterId && msg.adapterId !== ownerAdapterId) {
      return `not the adapter bound to ${target.name} (that is ${ownerAdapterId})`;
    }
    return null;
  }

  /**
   * Why this adapter must ignore a bot/webhook message, or null to accept it.
   * Pure: callers rely on being able to ask before claiming the dedup key.
   */
  private botMessageDropReason(msg: InboundMessage, threadId: string | undefined): string | null {
    if (!threadId) {
      // TG classic: allow if the bot @mentions our bot or access mode is open
      const world = this.worlds.get(msg.adapterId ?? "");
      const botUser = world?.botUsername;
      const isOpen = this.getChannelConfig(msg.adapterId)?.access?.mode === "open";
      const mentionsUs = !!(botUser && msg.text?.toLowerCase().includes(`@${botUser.toLowerCase()}`));
      return (!isOpen && !mentionsUs) ? "tg-classic: not open and does not mention us" : null;
    }
    if (this.classicChannels?.hasChannel(threadId)) {
      // Classic channel (per-bot): bot messages only when THIS bot owns an
      // agent here and collab is on for it.
      if (!this.classicChannels.getInstanceByChannel(threadId, msg.adapterId)) {
        return "classic: this bot owns no agent in the channel";
      }
      if (!this.classicChannels.isCollab(threadId, msg.adapterId)) return "classic: collab off";
      return null;
    }
    const target = this.resolveInboundTarget(msg, threadId);
    if (!target) return "fleet topic: no instance routed for this thread";
    // Fleet topic: this gate lets the copy through when the adapter is open OR
    // collab is on for the instance. "Through" is not "delivered" — access
    // control runs next, and the two arms are not symmetric there:
    //
    //   open adapter   → isAllowed() returns true outright: really admitted.
    //   locked + collab → the bot's user id still has to be on the allowlist,
    //                     so the message is normally refused a few lines later
    //                     under "Access DENIED for non-allowed user".
    //
    // Collab alone therefore does not admit a bot on a locked adapter; it only
    // declines to drop the copy here and leaves the decision to access control.
    const isOpen = this.getChannelConfig(msg.adapterId)?.access?.mode === "open";
    if (!isOpen && !this.collabInstances.has(target.name)) {
      return `fleet topic: adapter not open and collab off for ${target.name}`;
    }
    return null;
  }

  /**
   * Say so when an adapter's access mode is coming from its state file rather
   * than from fleet.yaml. The state file wins by design — a pairing done at
   * runtime has to survive a restart — but that also means an edit to
   * `access.mode` silently does nothing, which is indistinguishable from the
   * fleet not having reloaded. Naming the file is what makes it fixable.
   */
  private warnIfAccessModeOverridden(accessManager: AccessManager, statePath: string): void {
    const configured = accessManager.overriddenConfigMode();
    if (!configured) return;
    this.logger.warn(
      { statePath, configured, inEffect: accessManager.getMode() },
      `access mode "${accessManager.getMode()}" comes from the state file and overrides "${configured}" in fleet.yaml; delete ${statePath} to go back to the configured value`,
    );
  }

  /**
   * #1085: the thread id inbound routing may use. Telegram topic ids are small
   * integers numbered per group, but the routing table is keyed by topic id
   * alone — so a message in topic 30 of ANY group the bot is in resolved to
   * the fleet instance that owns topic 30 of the fleet's own group (and a group
   * that never ran /start was bound by coincidence). A Telegram topic counts
   * as a fleet topic only in the fleet's group: `chat_id == group_id` of the
   * receiving bot's channel. From any other group the message is a ClassicBot
   * candidate keyed by its chat id (served only if /start registered it,
   * ignored otherwise). Discord channel ids are global, so they are unaffected.
   */
  private inboundRouteThreadId(msg: InboundMessage): string | undefined {
    const raw = msg.threadId || undefined;
    if (!raw || msg.source !== "telegram") return raw;
    const fleetGroupId = this.getChannelConfig(msg.adapterId)?.group_id;
    if (fleetGroupId != null && String(fleetGroupId) === msg.chatId) return raw;
    this.logger.debug({ adapterId: msg.adapterId, chatId: msg.chatId, threadId: raw },
      "Telegram topic outside the fleet group — not a fleet topic (#1085)");
    return undefined;
  }

  /**
   * #1085, defense in depth: a routed Telegram target must belong to the group
   * the message came from — its own world's group_id. Two Telegram fleet
   * worlds can number topics alike; a coincidence is dropped, never delivered.
   */
  /**
   * #1346: whether this copy may claim the shared dedup key for
   * command-like text. Fleet topics resolve an owning adapter and only its
   * copy proceeds. Classic targets and unknown routing keep their existing
   * handling. At the receiving Telegram world's own forum root, an explicit
   * suffix requires a known matching username before dedup; present-thread
   * copies retain their permissive handling when that identity is unknown.
   */
  private isOwnerCommandCopy(msg: InboundMessage, threadId: string | undefined): boolean {
    if (!msg.adapterId) return true;
    const suffix = msg.text?.trim().match(/^\/[\w-]+@(\S+)/)?.[1];
    if (threadId === undefined) {
      // General at the forum root belongs to the receiving world. Prove an
      // explicit suffix before shared dedup, even when there is no message id.
      // Classic/private/foreign-forum copies retain their own dispatch rules.
      const channels = this.fleetConfig?.channels ?? (this.fleetConfig?.channel ? [this.fleetConfig.channel] : []);
      const channel = channels.find(ch => (ch.id ?? ch.type) === msg.adapterId)
        ?? this.worlds.get(msg.adapterId)?.channelConfig;
      if (msg.source === "telegram" && channel?.type === "telegram"
        && channel.group_id != null && String(channel.group_id) === msg.chatId && suffix) {
        const username = this.worlds.get(msg.adapterId)?.botUsername;
        return !!username && suffix.toLowerCase() === username.toLowerCase();
      }
      return true;
    }
    const target = this.resolveInboundTarget(msg, threadId);
    if (!target || target.kind === "classic") return true;
    const owner = this.getInstanceAdapterId(target.name);
    if (owner && msg.adapterId !== owner) return false;
    // #1346 6b: /cmd@otherbot is addressed elsewhere — ignore it even on the
    // owner's copy. An unknown username can't be judged: let it through (the
    // receiver gate above still applies). Same case-insensitive rule as the
    // Telegram classic branch.
    // Hyphenated aliases count too (e.g. /install-cli): Telegram command
    // names cannot contain "-", but typed aliases can.
    if (suffix && owner) {
      const ownerUser = this.worlds.get(owner)?.botUsername;
      if (ownerUser && suffix.toLowerCase() !== ownerUser.toLowerCase()) return false;
    }
    return true;
  }

  private resolveInboundTarget(msg: InboundMessage, threadId: string): RouteTarget | undefined {
    if (msg.source !== "telegram") return this.routing.resolve(threadId);
    return this.routing.resolveAll(threadId).find(target => {
      const ownerGroupId = this.getChannelConfig(this.getInstanceAdapterId(target.name))?.group_id;
      return ownerGroupId != null && String(ownerGroupId) === msg.chatId;
    });
  }

  private async handleInboundMessage(msg: InboundMessage): Promise<void> {
    // Platform author identity is the authority. This runs before routing,
    // collab/commands/access/dedup and does not depend on any echo setting/ACK.
    const fleetBotIds = new Set<string>();
    for (const world of this.worlds.values()) {
      if (world.adapter.type !== msg.source) continue;
      const id = world.adapter.getBotUserId?.() ?? world.botUserId;
      if (id) fleetBotIds.add(id);
    }
    if (isWebChannelEcho(msg.text ?? "", msg.userId, fleetBotIds)) return;
    const configured = this.fleetConfig?.channels ?? (this.fleetConfig?.channel ? [this.fleetConfig.channel] : []);
    const identitiesPending = configured.some(channel => {
      if (channel.type !== msg.source) return false;
      const world = this.worlds.get(channel.id ?? channel.type);
      return !(world?.adapter.getBotUserId?.() ?? world?.botUserId);
    });
    // Startup/rebuild can receive a replay before another configured world's
    // authenticated ID is ready. Quarantine only bot-flagged prefix candidates;
    // humans keep flowing, and no unknown author is labelled a fleet account.
    if (identitiesPending && msg.isBotMessage === true && (msg.text ?? "").startsWith(WEB_ECHO_PREFIX)) {
      this.logger.debug({ source: msg.source, adapterId: msg.adapterId }, "Web echo candidate quarantined while bot identities are pending");
      return;
    }
    const threadId = this.inboundRouteThreadId(msg);

    this.logger.debug({ source: msg.source, chatId: msg.chatId, threadId, userId: msg.userId, isBotMessage: msg.isBotMessage, textLen: (msg.text ?? "").length, text: (msg.text ?? "").slice(0, 80) }, "handleInboundMessage entry");

    // Ownership and per-adapter filtering both run before the dedup claim below.
    // When several bots share a guild they all receive the same message; a copy
    // this adapter is going to leave alone must not consume the shared dedup key,
    // or the owning adapter's copy would be discarded as a duplicate and the
    // message lost entirely. Claiming the key only on surviving copies also keeps
    // delivery single when more than one adapter would otherwise accept it.
    // Only bot messages are settled by ownership: a bot answering in a fleet
    // topic would speak as the wrong identity, whereas a human message is just
    // input for the instance and its reply is canonicalized to the owning
    // adapter downstream — so a topic only a non-owner bot can see still works.
    const drop = msg.isBotMessage
      ? (this.topicOwnerDropReason(msg, threadId) ?? this.botMessageDropReason(msg, threadId))
      : null;
    if (drop) {
      this.logger.debug(
        { adapterId: msg.adapterId, threadId: threadId ?? null, messageId: msg.messageId, reason: drop },
        "Inbound message dropped before the dedup claim — key not consumed",
      );
      return;
    }

    // Access control — classic channels are open to all, others require an allowed
    // user. This runs before the dedup claim, and is judged by the adapter that
    // owns the topic rather than the one that happened to receive the message:
    // otherwise a sibling bot could settle the message under its own policy —
    // claiming the shared key and then refusing it, or admitting a user the
    // owning adapter does not allow — purely by arriving first.
    const governing = this.governingAccess(msg, threadId);
    const ownerWorld = governing.adapterId ? this.worlds.get(governing.adapterId) : undefined;
    if (governing.authoritative && !ownerWorld) {
      this.logger.warn(
        { adapterId: msg.adapterId, owner: governing.adapterId, threadId, messageId: msg.messageId },
        "Refusing inbound: the owning adapter is not running, so its access policy cannot be applied",
      );
      return;
    }
    const am = governing.authoritative
      ? ownerWorld?.accessManager
      : (ownerWorld?.accessManager ?? this.accessManager);
    if (am && !am.isAllowed(msg.userId)) {
      const adapterGroupId = String(this.getChannelConfig(msg.adapterId)?.group_id ?? "");
      const isTelegramClassicCandidate = msg.source === "telegram" && msg.chatId !== adapterGroupId && !threadId;
      if (!isTelegramClassicCandidate) {
        // Classic channels are open to all; check per-bot ownership (or fleet topic).
        const isClassic = !!(threadId && this.classicChannels?.hasChannel(threadId));
        this.logger.info({ userId: msg.userId, threadId, isClassic, owner: governing.adapterId }, "Access DENIED for non-allowed user");
        if (!isClassic) return;
      }
    }

    // Multi-adapter dedup: when several bots share a guild, each adapter fires
    // its own "message" event for the same underlying message. Process it once.
    // Routing (by topic/channel) and reply-adapter selection (by channel_id
    // binding) are adapter-independent, so it's safe to let whichever adapter
    // arrives first handle it.
    //
    // EXCEPTION — classic channels with same-channel multi-bot: two bots may own
    // separate agents in one channel, so each bot must process its OWN copy of
    // the message (the @mention filter downstream decides who actually forwards).
    // #1346: a non-owner adapter's copy of command-like text must not burn
    // the shared dedup key — the owner's copy still has to run the command.
    // (Non-command input keeps first-wins delivery.) Classic channels keep
    // per-adapter keys — first-/start-contact onboarding needs every copy
    // to flow — so only fleet targets are judged here; the in-handler gates
    // (owner entry check, Discord ignore) cover classic instead.
    if ((msg.messageId || (msg.source === "telegram" && threadId === undefined))
      && /^\/\w/.test(msg.text?.trim() ?? "") && !this.isOwnerCommandCopy(msg, threadId)) {
      this.logger.debug({ adapterId: msg.adapterId, threadId }, "Non-owner command copy — skipping before dedup claim");
      return;
    }

    // Key the dedup per-adapter there so a sibling bot's copy isn't dropped.
    if (msg.messageId) {
      const classicCid = threadId || msg.chatId;
      // First /start has no registration yet. A sibling can receive the same
      // targeted command first, then reject its @suffix below; it must not
      // consume the intended bot's key. Use the same Classic candidate scope
      // as routing (including foreign forum topics normalized above, #1085).
      const isTelegramClassicCandidate = msg.source === "telegram" && !threadId
        && msg.chatId !== String(this.getChannelConfig(msg.adapterId)?.group_id ?? "");
      const isClassicMsg = !!this.classicChannels
        && (this.classicChannels.hasChannel(classicCid) || isTelegramClassicCandidate);
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
          // All new starts, including explicit backend and later chooser callbacks,
          // share validateClassicStart. Existing channels are recognized first.
          const blocker = this.validateClassicStart(chatId, msg.userId, undefined, msg.adapterId);
          if (blocker) { await msgAdapter?.sendText(chatId, blocker); return; }
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
          // Channel-admin, as on Discord (#754): a fleet admin of this bot or a ClassicBot admin.
          if (!this.isModelAdmin(msg.userId, chatId, msg.adapterId)) {
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
              undefined,
              msg.adapterId,
            );
            if (fallback) await msgAdapter.sendText(chatId, fallback);
          }
          return;
        }

        // Handle /compact command (admin only)
        const classicCompact = parseCompactCommand(text);
        if (classicCompact) {
          // Channel-admin, as on Discord (#754): a fleet admin of this bot or a ClassicBot admin.
          if (!this.isModelAdmin(msg.userId, chatId, msg.adapterId)) {
            await msgAdapter?.sendText(chatId, t("cmd.admin_required", "/compact"));
            return;
          }
          const compactName = this.classicChannels.getInstanceByChannel(chatId, msg.adapterId);
          if (!compactName) {
            await msgAdapter?.sendText(chatId, t("classic.no_agent_start"));
            return;
          }
          const result = await this.topicCommands.sendCompact(compactName, classicCompact.instructions);
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
          // Channel-admin, as on Discord (#754): a fleet admin of this bot or a ClassicBot admin.
          if (!this.isModelAdmin(msg.userId, chatId, msg.adapterId)) {
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
            const syntheticMsg = { ...msg, threadId: chatId, transportThreadId: msg.threadId || undefined, text: rawText.startsWith("/") ? "" : rawText };
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
          const syntheticMsg = { ...msg, threadId: chatId, transportThreadId: msg.threadId || undefined, text: `/chat ${cleanText}` };
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

      // General topic: Discord /xxx gets the system note first (never a
      // command); other sources fall through to the handlers below.
      const generalInstance = this.findGeneralInstance(msg.adapterId);
      if (generalInstance && await this.replyDiscordNotACommand(msg, generalInstance)) return;
      if (generalInstance && await this.topicCommands.handleInstanceCommand(msg, generalInstance)) return;
      if (generalInstance && await this.topicCommands.handleGeneralCommand(msg, generalInstance)) return;

      // Forward to General Topic instance if configured
      if (generalInstance) {
        if (msg.adapterId) this.bindInstanceAdapter(generalInstance, msg.adapterId, true);
        const inboundAdapter = this.worlds.get(msg.adapterId ?? "")?.adapter ?? this.adapter!;

        // React immediately — before any other API calls — through the status
        // path, which tracks Telegram slot ownership and Discord status adds.
        if (msg.chatId && msg.messageId) {
          this.reactMessageStatus(generalInstance, msg.chatId, msg.messageId, "received", msg.threadId || undefined, msg.timestamp.getTime());
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
              thread_id: msg.threadId ?? "",
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
            instance: generalInstance, sender: msg.username, role: "user",
            text: (text ?? "").slice(0, WEB_CHAT_TEXT_MAX), ts: new Date().toISOString(),
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

    const target = this.resolveInboundTarget(msg, threadId);
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

    // #1346: on Discord, plain-text /xxx runs no command — the owner posts
    // the system note before the handlers below ever see the text.
    if (await this.replyDiscordNotACommand(msg, instanceName)) {
      return;
    }

    // Intercept /ctx /compact /collab in ANY topic (including general)
    if (await this.topicCommands.handleInstanceCommand(msg, instanceName)) {
      return;
    }

    // Intercept admin commands (/status, /restart, /sysinfo) in general topics
    const instanceConfig = this.fleetConfig?.instances[instanceName];
    if (instanceConfig?.general_topic && await this.topicCommands.handleGeneralCommand(msg, instanceName)) {
      return;
    }

    // Bind instance to the adapter that delivered this message
    if (msg.adapterId) this.bindInstanceAdapter(instanceName, msg.adapterId, true);

    const inboundAdapter = this.worlds.get(msg.adapterId ?? "")?.adapter ?? this.adapter!;

    // React immediately — before any other Discord API calls — through the
    // status path, which tracks Telegram slot ownership and Discord status adds.
    // Same bound-adapter routing as the status path itself.
    if (msg.chatId && msg.messageId) {
      this.reactMessageStatus(instanceName, msg.chatId, msg.messageId, "received", msg.threadId || undefined, msg.timestamp.getTime());
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
        // Reconciled status path (not a bare add): a retry that later
        // succeeds replaces this ❌ with ✅ instead of leaving both. Chat and
        // thread travel separately so Telegram addresses the supergroup.
        this.finishDeliveryStatus(instanceName, msg.chatId, msg.messageId, "failed", msg.threadId || undefined);
      }
      return;
    }
    this.lastInboundUser.set(instanceName, msg.username);
    this.logger.info(`${msg.username} → ${instanceName}: ${(text ?? "").slice(0, 100)}`);
    this.eventLog?.logActivity("message", msg.username, (text ?? "").slice(0, 200), instanceName);
    this.emitSseEvent("message", {
      instance: instanceName, sender: msg.username, role: "user",
      text: (text ?? "").slice(0, WEB_CHAT_TEXT_MAX), ts: new Date().toISOString(),
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
  /**
   * Would this instance be allowed to use this tool?
   *
   * Stage 1 asks and records; nothing is refused yet. The recording is not only
   * an observation window: `logActivity("tool_call")` sits on the outbound path
   * only, so today the fleet has no idea what the agent endpoint or the typed
   * IPC handlers are being asked to do — the one face with no authorization is
   * also the one face with no telemetry.
   *
   * The profile comes from the instance the socket belongs to. Deliberately not
   * `senderSessionName`, which arrives inside the message: a caller that fills
   * in its own identity has not been identified.
   */
  /**
   * Say once, at startup, what the new default means for this fleet.
   *
   * Nothing is rewritten: an explicit `tool_set: full` is a choice somebody
   * made, and marking an instance as a coordinator is a judgement about how
   * their fleet is organised. Both stay theirs — this only makes sure they are
   * not discovered by an agent failing at three in the morning.
   */
  /**
   * #1366: the first time a fleet runs 2.2 or later, tell each chat platform's General — once — that its agents can
   * now be talked to from a browser. Claimed in upgrade-notices.json before the send, released if the send fails.
   * Platforms with nowhere to post fleet notices (no group, or a Discord fleet with no General channel) are skipped
   * and not recorded, so they are told once they have one.
   */
  async announceWebChatOnce(version: string): Promise<void> {
    if (!hasWebChat(version)) return;
    const path = upgradeNoticesPath(this.dataDir);
    for (const [adapterId, world] of this.worlds) {
      if (this.shuttingDown) return;
      const target = this.fleetNoticeTarget(adapterId);
      if (!target) continue;
      if (!claimNotice(path, WEB_CHAT_NOTICE, adapterId)) continue;
      try {
        await world.adapter.sendText(target.chatId, t("upgrade.web_chat", WEB_REMOTE_DOCS_URL), target.opts);
        this.logger.info({ adapterId, notice: WEB_CHAT_NOTICE }, "Announced web chat in General");
      } catch (err) {
        const released = releaseNotice(path, WEB_CHAT_NOTICE, adapterId);
        this.logger.warn({ err, adapterId, released }, "Could not announce web chat in General — will try at the next start");
      }
    }
  }

  private announceToolPermissionsChange(): void {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 19).replace("T", " ");
      const recent = [...(this.eventLog?.toolUseByInstance(thirtyDaysAgo) ?? new Map())]
        .map(([instance, tools]) => ({ instance, tools }));
      const notice = buildToolPermissionsNotice({
        defaultsToolSet: this.fleetConfig?.defaults?.tool_set,
        instances: (this.fleetConfig?.instances ?? {}) as never,
        recent,
      });
      if (notice) this.logger.warn({ notice }, notice);
    } catch (err) {
      // Advice is not worth failing a startup over.
      this.logger.debug({ err }, "tool-permissions: could not build the migration notice");
    }
  }

  private checkToolPermission(sink: ToolSink, instanceName: string, tool: string): { allowed: boolean; message: string } {
    const profile: ToolSetName = resolveToolSet(this.fleetConfig?.instances[instanceName], instanceName);
    const allowed = mayUseTool(profile, tool);
    if (!allowed) {
      this.logger.warn({ sink, instance: instanceName, profile, tool, enforced: true }, "tool-permissions: refused");
      return { allowed: false, message: toolRefusedMessage(profile, tool) };
    }
    this.logger.debug({ sink, instance: instanceName, profile, tool, enforced: true }, "tool-permissions: allowed");
    return { allowed: true, message: "" };
  }

  private async handleOutboundFromInstance(instanceName: string, msg: Record<string, unknown>): Promise<void> {
    this.touchActivity(instanceName);
    this.setTopicIcon(instanceName, "green");
    const tool = msg.tool as string;
    const args = (msg.args ?? {}) as Record<string, unknown>;
    const requestId = msg.requestId as number | undefined;
    const fleetRequestId = msg.fleetRequestId as string | undefined;
    const senderSessionName = msg.senderSessionName as string | undefined;
    const operationId = typeof msg.operationId === "string" ? msg.operationId : undefined;
    const sourceDaemonBootId = typeof msg.sourceDaemonBootId === "string" ? msg.sourceDaemonBootId : undefined;

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

    // Sink 1 of 3, and the first thing decided. Every MCP call and every direct
    // write to channel.sock lands here, whether or not mcp-server was ever
    // involved — which is why this is the boundary and the tool list the model
    // was shown is not.
    //
    // Above the adapter check on purpose: "retry shortly" is the wrong answer
    // to a call that will never be allowed, and an agent that believes it is a
    // timing problem will keep trying.
    const permitted = this.checkToolPermission("ipc-outbound", instanceName, tool);
    if (!permitted.allowed) {
      respond(null, permitted.message);
      return;
    }

    // A fleet with no chat platform at all is driven from the web dashboard alone: a reply has nowhere
    // else to go, and "retry shortly" would have the agent retry forever. It goes to the web chat.
    const webOnlyReply = tool === "reply" && this.worlds.size === 0 && this.isWebOnlyFleet();
    if (this.worlds.size === 0 && !webOnlyReply) {
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
      ?? this.adapter
      ?? (webOnlyReply ? WEB_ONLY_REPLY_SINK : null);
    if (!outAdapter) { respond(null, "No adapter available"); return; }

    // For classic instances: force chat_id to channelId and clear thread_id
    // (daemon may have set chat_id to guild_id which is wrong for DC; TG may have set thread_id which causes 'thread not found')
    const classicChannelId = this.classicChannels?.getChannelIdByInstance(senderInstanceName ?? instanceName);
    if (classicChannelId) {
      args.chat_id = classicChannelId;
      // #1085: a Telegram forum ClassicBot replies in the topic it was asked
      // in. Any other thread_id (threadless Telegram, where it echoes the chat
      // id, or a Discord channel) is still cleared, as before.
      const topic = typeof args.thread_id === "string" ? args.thread_id : "";
      const telegram = (contextWorld?.adapter ?? outAdapter)?.type === "telegram";
      if (telegram && topic && topic !== classicChannelId) {
        threadId = topic;
      } else {
        delete args.thread_id;
        threadId = undefined;
      }
    }

    // Reply dedup: retries land here when the agent was told a send failed
    // (daemon budget elapsed, shell tool killed) while the adapter send was
    // still in flight and about to succeed. One real send, everyone gets its
    // outcome; a genuinely failed send clears the entry so a retry passes.
    if (tool === "reply") {
      // Registered synchronously before a web message is handed to this CLI.
      // This waits only on display ordering, never on the web delivery itself.
      const echoTail = this.webChannelEchoTails.get(instanceName)?.tail;
      if (echoTail) {
        const replyClient = this.instanceIpcClients.get(instanceName);
        const bindingName = senderInstanceName ?? instanceName;
        const binding = this.getAdapterForInstance(bindingName);
        const bindingGroup = this.getGroupIdForInstance(bindingName);
        const bindingTopic = this.fleetConfig?.instances[bindingName]?.topic_id;
        await echoTail;
        // A replacement daemon must not receive this old tool's response or
        // publish its reply after the new async ordering boundary.
        if (this.instanceIpcClients.get(instanceName) !== replyClient) return;
        if (this.getAdapterForInstance(bindingName) !== binding
          || this.getGroupIdForInstance(bindingName) !== bindingGroup
          || this.fleetConfig?.instances[bindingName]?.topic_id !== bindingTopic
          || (contextAdapterId && this.worlds.get(contextAdapterId)?.adapter !== outAdapter)) {
          respond(null, "Channel binding changed while waiting for the web echo");
          return;
        }
      }
      // #1266: buttons are checked before anything is sent, like stickers.
      const parsedButtons = parseReplyButtons(args.buttons, args);
      if (parsedButtons && "error" in parsedButtons) { respond(null, `reply: ${parsedButtons.error}`); return; }
      // Stickers (#1226) are checked before anything is sent: a refused one is the reply's error, not a gap.
      const stickerProblem = await this.replyStickerProblem(outAdapter, args, threadId, contextAdapterId ?? this.getInstanceAdapterId(senderInstanceName ?? instanceName));
      if (stickerProblem) { respond(null, stickerProblem); return; }
      const ticket = this.replyDeduper.begin(
        instanceName,
        replyDedupText(args),
        Array.isArray(args.files) ? args.files as string[] : [],
      );
      if (ticket.duplicate) {
        this.logger.info({ instanceName }, "Concurrent duplicate reply joined — awaiting the original send's outcome");
        ticket.subscribe(respond);
        return;
      }
      // #1266: the buttons' set, before the send (a click cannot match it until the message is known). Where buttons
      // cannot be shown, the choices go into the text instead.
      let replySet: { id: string; callbacks: Array<{ id: string; label: string }> } | null = null;
      if (parsedButtons && "buttons" in parsedButtons) {
        const buttons = outAdapter.supportsReplyButtons ? this.replyButtons() : null;
        if (buttons) {
          const outId = outAdapter === WEB_ONLY_REPLY_SINK ? "web" : ((outAdapter as { id?: unknown }).id as string | undefined) ?? contextAdapterId ?? "";
          replySet = buttons.prepare({ instance: instanceName, adapterId: outId, chatId: String(args.chat_id ?? ""), threadId }, parsedButtons.buttons);
        } else {
          args.text = `${String(args.text)}\n\n${replyButtonsFallbackText(parsedButtons.buttons)}`;
        }
      }
      const original = respond;
      const respondAndRecord = (result: unknown, error?: string) => {
        let buttonsView: ReplyButtonsView | null = null;
        if (replySet) {
          const sent = result as { messageId?: string; buttonsMessageId?: string } | null;
          const carrying = sent?.buttonsMessageId ?? sent?.messageId;
          if (!error && carrying) {
            this.replyButtonsCtl?.bind(replySet.id, carrying);
            buttonsView = this.replyButtonsCtl?.viewOf(replySet.id) ?? null;
          } else {
            this.replyButtonsCtl?.discard(replySet.id);
          }
        }
        ticket.complete(result, error);
        // Return the platform outcome first. Bookkeeping below must never turn
        // a confirmed Discord/Telegram POST into a tool error if a secondary
        // log/button side effect happens to throw.
        original(result, error);
        // The adapter resolves only after the platform POST returns. Keep
        // outward-facing logs/cancel state on the same confirmation boundary:
        // a routed-but-failed reply is not a delivered reply.
        // `statusOnly` is daemon-owned envelope metadata, not an MCP argument:
        // an agent cannot invent it to suppress the normal completion marker.
        if (!error && result != null && msg.statusOnly !== true) {
          try {
            this.afterReplyRouted(instanceName, args, senderSessionName, buttonsView);
          } catch (err) {
            this.logger.warn({ err, instanceName }, "Reply delivered but post-delivery bookkeeping failed");
          }
        } else if (!error && result != null && outAdapter === WEB_ONLY_REPLY_SINK) {
          // A daemon status line skips the bookkeeping, but on a web-only fleet the web chat is the only
          // place anyone could read it.
          this.emitSseEvent("message", {
            instance: instanceName, sender: senderSessionName ?? instanceName, role: "status",
            text: String(args.text ?? "").slice(0, WEB_CHAT_TEXT_MAX), ts: new Date().toISOString(),
          });
        }
      };
      if (routeToolCall(outAdapter, tool, args, threadId, respondAndRecord, replySet ? { replyButtons: replySet.callbacks } : {})) {
        return;
      }
      if (replySet) this.replyButtonsCtl?.discard(replySet.id);
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
      await handler(this, args, respond, {
        instanceName, requestId, fleetRequestId, senderSessionName, operationId, sourceDaemonBootId,
      });
    } else {
      respond(null, `Unknown tool: ${tool}`);
    }
  }

  /** Side effects of a routed reply: cancel-button lifecycle, logs, SSE, chat log. */
  /** No chat platform is configured at all: the web dashboard is the fleet's only surface. */
  private isWebOnlyFleet(): boolean {
    const config = this.fleetConfig;
    return config != null && !config.channel && !(config.channels?.length);
  }

  /** On a fleet with no chat platform, the dashboard is where an instance-health prompt is posted (#1307 item 6). */
  private webOnlyPromptPlace(): { adapter: ChannelAdapter; adapterId: string; chatId: string } | null {
    return this.worlds.size === 0 && this.isWebOnlyFleet() ? { adapter: WEB_ONLY_PROMPT_SINK, adapterId: "web", chatId: "web" } : null;
  }

  private afterReplyRouted(instanceName: string, args: Record<string, unknown>, senderSessionName?: string, buttons: ReplyButtonsView | null = null): void {
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
    // Files the agent attached are shown in the web chat too: registered for fetching by id (the path
    // already passed the reply tool's sendability check, and is resolved once more here), never by path.
    const replyFiles = Array.isArray(args.files) ? (args.files as unknown[]).filter((f): f is string => typeof f === "string") : [];
    const attachments = replyFiles
      .map(path => this.webFiles.registerServed({ path, instance: instanceName }))
      .filter((f): f is NonNullable<typeof f> => f !== null)
      .map(publicAttachment);
    // The one place a delivered agent reply reaches the web chat: the server marks it `agent` (#1306) — the only
    // role that may get HTML preview cards. Never inferred from the sender name or the text.
    this.emitSseEvent("message", {
      instance: instanceName, sender: senderSessionName ?? instanceName, role: "agent",
      text: (args.text as string ?? "").slice(0, WEB_CHAT_TEXT_MAX),
      ts: new Date().toISOString(),
      ...(attachments.length ? { attachments } : {}),
      ...(buttons ? { buttons } : {}),                 // #1266
    });
    // Log bot reply to classic instance chat-log
    const isClassic = this.classicChannels?.getChannelIdByInstance(instanceName) !== undefined;
    if (isClassic) {
      ClassicChannelManager.logMessage(instanceName, "bot", args.text as string ?? "", new Date());
    }
  }

  // ===================== Scheduler =====================

  private async handleScheduleTrigger(schedule: Schedule, stableRunId: string = randomUUID(), retry?: ScheduleRetry): Promise<void> {
    const { target, reply_chat_id, reply_thread_id, label, id, source, silent } = schedule;
    // #1426: the retry of a deferred occurrence says so in every status it records.
    const runStatus = (status: string) => (retry ? `deferred → ${status} (retry)` : status);

    const RATE_LIMIT_DEFER_THRESHOLD = 85;
    const rl = this.statuslineWatcher.getRateLimits(target);
    // A reading whose window has reset describes a window that no longer exists: claude-code rewrites statusline.json
    // only when it renders, so an idle instance keeps its last percentage long after the reset (#1426).
    const nowMs = Date.now();
    const windowCurrent = rl != null && (rl.five_hour_resets_at_ms === null || nowMs < rl.five_hour_resets_at_ms);
    if (rl && windowCurrent && rl.five_hour_pct > RATE_LIMIT_DEFER_THRESHOLD) {
      const resetsAtMs = rl.five_hour_resets_at_ms;
      if (retry) {
        // The window it waited for reset, and a new one is over the threshold again: deferred again — given up.
        if (retry.resets_at_ms !== null && nowMs >= retry.resets_at_ms) {
          if (this.scheduler!.endRetry(retry)) this.scheduleRetryDropped(schedule, retry, "deferred_again");
          return;
        }
        // No reset time to wait for yet (or a new one learnt): look again later, within the deadline.
        const later = this.scheduler!.postponeRetry(retry, resetsAtMs, nowMs);
        if ("dropped" in later) this.scheduleRetryDropped(schedule, later.retry, later.dropped);
        else this.logger.info({ target, scheduleId: id, runId: stableRunId, dueAt: new Date(later.due_at_ms).toISOString() }, "Schedule retry still rate limited — looking again later");
        return;
      }
      const pending = this.scheduler!.deferForRetry(schedule, stableRunId, { deferredPct: rl.five_hour_pct, resetsAtMs, nowMs });
      const dueAt = "dropped" in pending ? null : pending.due_at_ms;
      this.scheduler!.recordRun(id, "deferred", `5hr rate limit at ${rl.five_hour_pct}%`
        + (dueAt !== null ? `; retry at ${new Date(dueAt).toISOString()}` : ""));
      this.eventLog?.insert(target, "schedule_deferred", {
        schedule_id: id,
        label,
        five_hour_pct: rl.five_hour_pct,
        retry_at: dueAt !== null ? new Date(dueAt).toISOString() : null,
      });
      this.webhookEmitter?.emit("schedule_deferred", target, { schedule_id: id, label, five_hour_pct: rl.five_hour_pct });
      this.notifyInstanceTopic(target, dueAt !== null
        ? t("schedule.deferred_retry", label ?? id, rl.five_hour_pct, scheduleClock(dueAt, schedule.timezone))
        : t("schedule.deferred", label ?? id, rl.five_hour_pct));
      this.logger.info({ target, scheduleId: id, rateLimitPct: rl.five_hour_pct, retryAt: dueAt }, "Schedule deferred due to rate limit");
      if ("dropped" in pending) this.scheduleRetryDropped(schedule, pending.retry, pending.dropped);
      return;
    }
    // #1426: the retry runs now — removed first, so a crash from here loses it rather than running it twice.
    if (retry && !this.scheduler!.endRetry(retry)) return;
    // The agent sees it is a retry, and of what (a silent schedule pastes its raw command unchanged).
    const message = retry && !silent ? `${scheduleRetryLabel(retry, schedule.timezone)}\n${schedule.message}` : schedule.message;

    // Silent mode: paste directly to tmux pane — no channel message.
    if (silent) {
      // The outbox commit is the schedule's durable acceptance point. The run
      // key is the scheduled fire instant (or an invocation UUID for a manual
      // trigger), so restart/catch-up reuses the same raw paste row.
      this.ensureDeliveryOutbox();
      const runKey = encodeURIComponent(stableRunId);
      const sourceKey = `schedule:${encodeURIComponent(id)}:${runKey}:${encodeURIComponent(target)}:raw_paste`;
      const operationId = `schedule:${id}:${stableRunId}`;
      const sourceBootId = this.daemons.get(source)?.bootId ?? this.managerBootId;
      const admitted = this.deliveryOutbox!.admit({
        operationId,
        sourceKey,
        sourceInstance: source,
        sourceDaemonBootId: sourceBootId,
        targetInstance: target,
        kind: "raw_paste",
        correlationId: operationId,
        payload: {
          type: "raw_paste",
          content: message,
          schedule_id: id,
          schedule_run_id: stableRunId,
        },
      });
      this.scheduler!.recordRun(id, runStatus("queued"), `durable raw_paste delivery_id=${admitted.delivery.deliveryId}`);
      this.logger.info({ target, scheduleId: id, runId: stableRunId, deliveryId: admitted.delivery.deliveryId, duplicate: !admitted.inserted },
        "Silent schedule durably admitted as raw_paste");
      this.scheduleDeliveryOutboxPump();
      return;
    }

    const schedulerDefaults = this.fleetConfig?.defaults.scheduler;

    const retryCount = schedulerDefaults?.retry_count ?? 3;
    const retryInterval = schedulerDefaults?.retry_interval_ms ?? 30_000;

    // #1426: a retry is only good until its deadline (the next occurrence or the cap) — through the idle wait and up to
    // the IPC hand-off itself, not just when it starts.
    const retryCurrent = retry ? () => Date.now() < retry.deadline_ms : undefined;
    const deliver = async (): Promise<boolean | "past-deadline"> => {
      if (retryCurrent && !retryCurrent()) return "past-deadline";
      try {
        // A schedule has no live inbound adapter context. Seed the daemon with
        // the target instance's configured world so replies use its persona
        // after a fresh start instead of falling back to channels[0].
        const adapterId = this.getInstanceAdapterId(target);
        // ...but the stored reply coordinates belong to the chat the schedule
        // was CREATED in, which is not always the target's world. Pairing them
        // with the target's adapter hands one platform's ids to another's API:
        // a Telegram group + forum topic delivered to a Discord instance made
        // every reply on that turn fetch `/channels/<telegram topic>` and fail
        // with Unknown Channel, and because the seeding repeats on each trigger
        // it stayed broken until a real inbound overwrote the context (#752).
        const foreignWorld = this.scheduleChatWorldMismatch(target, reply_chat_id);
        if (foreignWorld) {
          this.logger.warn({ scheduleId: id, target, foreignWorld, targetWorld: adapterId, chatId: reply_chat_id },
            "Schedule reply target belongs to another channel world — not seeding chat context; the instance keeps its own last known chat");
        }
        const handed = await this.deliverToInstance(target, {
          type: "fleet_schedule_trigger",
          payload: { schedule_id: id, message: `[Scheduled] ${message}`, label },
          meta: {
            // Omitted on a mismatch: the daemon then keeps its persisted
            // last-chat, which is in the right world, instead of being
            // overwritten with coordinates the target's adapter cannot address.
            ...(foreignWorld ? {} : { chat_id: reply_chat_id, thread_id: reply_thread_id }),
            user: "scheduler",
            ...(adapterId ? { adapter_id: adapterId } : {}),
          },
        }, { waitForIdle: true, ...(retryCurrent ? { stillCurrent: retryCurrent } : {}) });
        if (handed === false && retryCurrent && !retryCurrent()) return "past-deadline";
        // A scheduled trigger also puts the instance to work — show a cancel button.
        void this.sendCancelButton(target);
        return true;
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, target }, "Scheduled wake/delivery attempt failed");
        return false;
      }
    };

    const pastDeadline = () => {
      this.scheduleRetryDropped(schedule, retry!, retry!.deadline_kind === "next_occurrence" ? "superseded" : "expired");
    };
    const first = await deliver();
    if (first === "past-deadline") { pastDeadline(); return; }
    if (first) {
      this.scheduler!.recordRun(id, runStatus("delivered"));
      if (source !== target) this.notifySourceTopic(schedule);
      return;
    }

    for (let i = 0; i < retryCount; i++) {
      await new Promise((r) => setTimeout(r, retryInterval));
      const again = await deliver();
      if (again === "past-deadline") { pastDeadline(); return; }
      if (again) {
        this.scheduler!.recordRun(id, runStatus("delivered"));
        if (source !== target) this.notifySourceTopic(schedule);
        return;
      }
    }

    this.scheduler!.recordRun(id, runStatus("instance_offline"), `retry ${retryCount}x failed`);
    this.notifyScheduleFailure(schedule);
  }

  /**
   * The adapter that can actually post into a chat, found by its group.
   *
   * A schedule records where it was created (reply_chat_id) separately from
   * what it triggers (target). Those need not share a platform: a Telegram
   * group can schedule a Discord-topic instance. Picking the adapter from the
   * target then sends a Telegram chat id through the Discord bot, which fails
   * with Unknown Channel — the source topic never hears that its schedule ran.
   *
   * When several bots share one guild, the primary wins: a persona should not
   * be the voice announcing fleet scheduling.
   */
  private adapterForChat(chatId: string): ChannelAdapter | undefined {
    const id = String(chatId);
    const matches = [...this.worlds.values()].filter(world => String(world.groupId) === id);
    if (matches.length === 0) return undefined;
    const primaryId = this.getPrimaryAdapterId();
    return (matches.find(world => world.id === primaryId) ?? matches[0]).adapter;
  }

  /**
   * The adapter that can answer a schedule in the chat it was created from.
   *
   * A schedule records its creator (source) and its trigger (target) separately,
   * and they need not share a platform — the live fleet has a Telegram group
   * scheduling a Discord-topic instance. Routing by target sends a Telegram chat
   * id through the Discord bot, which is one half of the Unknown Channel errors.
   *
   * The creator's own adapter comes first, and only when its world actually owns
   * that chat. Classic keeps its own identity, so a schedule made from a
   * persona-bound Classic channel is answered by that persona: the primary bot
   * may not even have access there, and would be the wrong voice if it did.
   * Falling back to the target's adapter is deliberately NOT an option — that is
   * the misroute itself; callers say why they stayed silent instead.
   */
  private scheduleSourceAdapter(schedule: Schedule): ChannelAdapter | undefined {
    const chatId = String(schedule.reply_chat_id);
    // New schedules carry the adapter that owned the source chat at creation.
    // Keep that persona across source-instance rebinding, but never trust a
    // stale adapter after the chat has moved to another world.
    const persistedWorld = schedule.reply_adapter_id
      ? this.worlds.get(schedule.reply_adapter_id)
      : undefined;
    if (persistedWorld && String(persistedWorld.groupId) === chatId) {
      return persistedWorld.adapter;
    }
    const sourceAdapterId = schedule.source ? this.getInstanceAdapterId(schedule.source) : undefined;
    const sourceWorld = sourceAdapterId ? this.worlds.get(sourceAdapterId) : undefined;
    if (sourceWorld && String(sourceWorld.groupId) === chatId) return sourceWorld.adapter;
    return this.adapterForChat(chatId);
  }

  private notifySourceTopic(schedule: Schedule): void {
    const adapter = this.scheduleSourceAdapter(schedule);
    if (!adapter) {
      this.logger.warn({ scheduleId: schedule.id, chatId: schedule.reply_chat_id, source: schedule.source },
        "No adapter can reach the schedule's source chat — trigger notice not sent");
      return;
    }
    const text = `⏰ Schedule "${schedule.label ?? schedule.id}" triggered, target: ${schedule.target}`;
    adapter.sendText(schedule.reply_chat_id, text, {
      threadId: schedule.reply_thread_id ?? undefined,
    }).catch((err: unknown) => this.logger.error({ err }, "Failed to send cross-instance notification"));
  }

  private notifyScheduleFailure(schedule: Schedule): void {
    // Same resolver as the success path: a failure notice was still being sent
    // through the target's adapter, so a Telegram-created schedule for a
    // Discord target announced its failure into the wrong platform.
    const adapter = this.scheduleSourceAdapter(schedule);
    if (!adapter) {
      this.logger.warn({ scheduleId: schedule.id, chatId: schedule.reply_chat_id, source: schedule.source },
        "No adapter can reach the schedule's source chat — failure notice not sent");
      return;
    }
    const text = `⏰ Schedule "${schedule.label ?? schedule.id}" trigger failed: instance ${schedule.target} is offline.`;
    adapter.sendText(schedule.reply_chat_id, text, {
      threadId: schedule.reply_thread_id ?? undefined,
    }).catch((err: unknown) => this.logger.error({ err }, "Failed to send schedule failure notification"));
  }

  /**
   * #1426: a deferred occurrence's retry will not run — superseded by the next occurrence, deferred again, or its wait
   * capped. Recorded as `deferred → skipped (…)`, and said in the schedule's own chat with its admins @mentioned:
   * this is the case that used to be a silently lost day.
   */
  private scheduleRetryDropped(schedule: Schedule, retry: ScheduleRetry, reason: ScheduleRetryDrop): void {
    const why = { superseded: "superseded", deferred_again: "deferred again", expired: "expired" }[reason];
    this.scheduler?.recordRun(schedule.id, `deferred → skipped (${why})`,
      `run ${retry.run_id} deferred at ${retry.deferred_pct}%`);
    this.eventLog?.insert(schedule.target, "schedule_retry_dropped", { schedule_id: schedule.id, label: schedule.label, run_id: retry.run_id, reason });
    this.logger.warn({ scheduleId: schedule.id, target: schedule.target, runId: retry.run_id, reason }, "Deferred schedule occurrence will not run");
    const reasonText = reason === "superseded"
      ? t("schedule.retry_reason_superseded", scheduleClock(retry.deadline_ms, schedule.timezone))
      : reason === "deferred_again" ? t("schedule.retry_reason_deferred_again")
        : t("schedule.retry_reason_expired", Math.round(Scheduler.RETRY_MAX_WAIT_MS / 60_000));
    const adapter = this.scheduleSourceAdapter(schedule);
    if (!adapter) {
      this.notifyInstanceTopic(schedule.target, t("schedule.retry_dropped", "", schedule.label ?? schedule.id,
        scheduleClock(Date.parse(retry.run_id) || retry.deferred_at_ms, schedule.timezone), retry.deferred_pct, reasonText).trimStart());
      return;
    }
    const admins = this.adminListOf(adapter.id) ?? [];
    const html = adapter.type === "telegram";
    const mention = admins.map(adminId => adapter.type === "discord" ? `<@${adminId}>`
      : html ? `<a href="tg://user?id=${encodeURIComponent(adminId)}">admin</a>` : "").filter(Boolean).join(" ");
    const due = scheduleClock(Date.parse(retry.run_id) || retry.deferred_at_ms, schedule.timezone);
    const text = html
      ? t("schedule.retry_dropped", mention, escapeTelegramHtml(schedule.label ?? schedule.id), due, retry.deferred_pct, escapeTelegramHtml(reasonText))
      : t("schedule.retry_dropped", mention, schedule.label ?? schedule.id, due, retry.deferred_pct, reasonText);
    adapter.sendText(schedule.reply_chat_id, text.trimStart(), {
      threadId: schedule.reply_thread_id ?? undefined,
      ...(html ? { format: "html" as const } : {}),
    }).catch((err: unknown) => this.logger.error({ err }, "Failed to send the deferred-schedule escalation"));
  }

  /**
   * The typed IPC messages, all through one door.
   *
   * They used to be five sibling branches on the dispatch, which is why the
   * permission question had five places to be forgotten. Routing them together
   * means the check above happens once and cannot be skipped by adding a
   * sixth — a new type has to appear in `IPC_TYPE_TOOLS` to be dispatched at
   * all.
   */
  /**
   * Answer a refused typed message the way its handler would have.
   *
   * These are request/response over IPC: dropping the message silently leaves
   * the caller waiting for a reply that never comes, and a hung agent is a
   * worse failure than a refused one.
   */
  private refuseTypedIpc(name: string, msg: Record<string, unknown>, message: string): void {
    const ipc = this.instanceIpcClients.get(name);
    const fleetRequestId = msg.fleetRequestId as string | undefined;
    if (!ipc || !fleetRequestId) return;
    const type = String(msg.type);
    const responseType = type.startsWith("fleet_schedule_") ? "fleet_schedule_response"
      : type.startsWith("fleet_decision_") ? "fleet_decision_response"
      : type === "fleet_task" ? "fleet_task_response"
      : type === "fleet_set_display_name" ? "fleet_display_name_response"
      : type === "fleet_list_emojis" || type === "fleet_set_persona_emoji" || type === "fleet_preview_emojis"
        || type === "fleet_list_stickers" || type === "fleet_preview_stickers" ? "fleet_persona_emoji_response"
      : "fleet_description_response";
    ipc.send({ type: responseType, fleetRequestId, error: message });
  }

  private dispatchTypedIpc(name: string, msg: Record<string, unknown>): void {
    const type = String(msg.type);
    if (type.startsWith("fleet_schedule_")) { this.handleScheduleCrud(name, msg); return; }
    if (type.startsWith("fleet_decision_")) { this.handleDecisionCrud(name, msg); return; }
    if (type === "fleet_task") { this.handleTaskCrud(name, msg); return; }
    if (type === "fleet_set_display_name") { this.handleSetDisplayName(name, msg); return; }
    if (type === "fleet_set_description") { this.handleSetDescription(name, msg); return; }
    if (type === "fleet_list_emojis" || type === "fleet_set_persona_emoji" || type === "fleet_preview_emojis"
      || type === "fleet_list_stickers" || type === "fleet_preview_stickers") { this.handlePersonaEmoji(name, msg); return; }
  }

  /** `list_emojis` / `set_persona_emoji` / `preview_emojis` / `list_stickers` / `preview_stickers` over IPC; the agent endpoint calls the same methods. */
  private handlePersonaEmoji(instanceName: string, msg: Record<string, unknown>): void {
    const fleetRequestId = msg.fleetRequestId as string;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    const ipc = this.instanceIpcClients.get(instanceName);
    if (!ipc) return;
    const op = msg.type === "fleet_list_emojis" ? this.listEmojisFor(instanceName, payload.refresh === true, payload)
      : msg.type === "fleet_preview_emojis" ? this.previewEmojis(instanceName, payload)
      : msg.type === "fleet_list_stickers" ? this.listStickersFor(instanceName, payload)
      : msg.type === "fleet_preview_stickers" ? this.previewStickers(instanceName, payload)
      : this.setPersonaEmoji(instanceName, payload);
    op.then(
      (r) => typeof r.error === "string"
        ? ipc.send({ type: "fleet_persona_emoji_response", fleetRequestId, error: r.error })
        : ipc.send({ type: "fleet_persona_emoji_response", fleetRequestId, result: r }),
      (err: unknown) => ipc.send({ type: "fleet_persona_emoji_response", fleetRequestId, error: (err as Error).message }),
    );
  }

  private handleScheduleCrud(instanceName: string, msg: Record<string, unknown>): void {
    const fleetRequestId = msg.fleetRequestId as string;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    const meta = (msg.meta ?? {}) as Record<string, string>;
    const ipc = this.instanceIpcClients.get(instanceName);
    if (!ipc) return;
    if (!this.scheduler) {
      // It did answer before, with whatever TypeError fell out of the try
      // block — "Cannot read properties of null (reading 'list')" is a stack
      // trace wearing an error message, and the agent reading it cannot tell
      // that the fleet simply has no scheduler.
      ipc.send({ type: "fleet_schedule_response", fleetRequestId, error: "Schedules are unavailable — the fleet scheduler is not running" });
      return;
    }

    try {
      const op = String(msg.type).replace("fleet_schedule_", "") as "create" | "list" | "update" | "delete";
      const result = this.performScheduleOp(instanceName, op, payload, {
        // The daemon sends its last chat id, which is unset until the instance
        // has had a chat message — and cross-instance traffic never sets it. So
        // a worker that only takes delegated tasks, the very instance #895 lets
        // self-schedule, hit "NOT NULL constraint failed: schedules.reply_chat_id".
        // No chat means no reply chat, exactly as on the agent endpoint.
        chatId: meta.chat_id ?? "",
        threadId: meta.thread_id || null,
        adapterId: meta.adapter_id || null,
        silent: !!(payload.silent),
      });
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
    if (!ipc) return;
    if (!this.scheduler) {
      // Returning silently left the caller waiting for a response that was
      // never coming. Over IPC that is a hang, and a hang is a worse answer
      // than an error.
      ipc.send({ type: "fleet_decision_response", fleetRequestId, error: "Decisions are unavailable — the fleet scheduler is not running" });
      return;
    }

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

  /** Inherited keys such as __proto__ must never resolve to a mutable instance. */
  private ownInstanceConfig(instanceName: string): FleetConfig["instances"][string] | undefined {
    const instances = this.fleetConfig?.instances;
    return instances && Object.hasOwn(instances, instanceName) ? instances[instanceName] : undefined;
  }

  /** Persist identity to the instance's actual config store. Classic instances
   * are registry rows in classicBot.yaml, not fleet.yaml instance entries. */
  private setInstanceDisplayName(instanceName: string, displayName: string): boolean {
    const fleetInstance = this.ownInstanceConfig(instanceName);
    if (fleetInstance) {
      fleetInstance.display_name = displayName;
      this.saveFleetConfig();
      return true;
    }
    return this.classicChannels?.setDisplayNameByInstance(instanceName, displayName) ?? false;
  }

  private setInstanceDescription(instanceName: string, description: string): boolean {
    const fleetInstance = this.ownInstanceConfig(instanceName);
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
    if (op !== "create" && op !== "list" && op !== "update" && op !== "delete") {
      return { error: `Unknown schedule op: ${op}` };
    }
    // No bound chat on this path, as before: a schedule made through the agent
    // endpoint has nowhere of its own to reply.
    return this.performScheduleOp(instance, op, args, { chatId: "", threadId: null });
  }

  /**
   * The only place an agent's request creates, changes or removes a schedule
   * (#895). The IPC handler (MCP calls, direct channel.sock writes) and the
   * agent endpoint (agent-cli, HTTP agent mode) are adapters over this, so the
   * target check cannot be present on one face and missing on the other — the
   * shape #804 had to close twice.
   *
   * `caller` is the instance the server resolved for the request; any
   * `source` in `args` is ignored, and a schedule's source is always its caller.
   * A refusal is a ToolNotPermittedError: 403 on the agent endpoint, the error
   * of the schedule response on IPC.
   */
  private performScheduleOp(
    caller: string,
    op: "create" | "list" | "update" | "delete",
    args: Record<string, unknown>,
    reply: { chatId: string; threadId: string | null; adapterId?: string | null; silent?: boolean },
  ): unknown {
    const scheduler = this.scheduler!;
    // Shape first, so the value the permission decision reads is the value the
    // scheduler gets. `target` used to be filtered through typeof for the
    // decision and passed raw to the scheduler, whose `target.startsWith`
    // then threw a TypeError for `target: 123` (#897). A non-string is refused
    // — never coerced: turning 123 into "123" would decide an identity
    // question on a value the caller did not send. `null` means absent, as
    // omitting it always did, and is removed before the scheduler sees it.
    if (args.target === null) {
      args = { ...args };
      delete args.target;
    }
    if (args.target !== undefined && typeof args.target !== "string") {
      throw new Error(`${op}_schedule: "target" must be an instance name (a string), not ${typeof args.target}.`);
    }
    if ((op === "update" || op === "delete") && typeof args.id !== "string") {
      throw new Error(`${op}_schedule: "id" must be a schedule id (a string) — get one from list_schedules.`);
    }
    const requestedTarget = args.target as string | undefined;
    if (op !== "list") {
      const profile = resolveToolSet(this.fleetConfig?.instances[caller], caller);
      const existing = op === "create" ? null : scheduler.get(args.id as string);
      const refusal = scheduleOpRefusal(profile, caller, op, { requestedTarget, existing });
      if (refusal) {
        this.logger.warn({ instance: caller, profile, op, target: requestedTarget ?? existing?.target, scheduleId: args.id },
          "tool-permissions: schedule op refused");
        throw new ToolNotPermittedError(refusal);
      }
    }
    switch (op) {
      case "create":
        return scheduler.create({
          cron: args.cron as string | undefined,
          at: args.at as string | undefined,
          message: args.message as string,
          source: caller,
          target: requestedTarget || caller,
          reply_chat_id: reply.chatId,
          reply_thread_id: reply.threadId,
          ...(reply.adapterId !== undefined ? { reply_adapter_id: reply.adapterId } : {}),
          label: args.label as string | undefined,
          timezone: args.timezone as string | undefined,
          ...(reply.silent !== undefined ? { silent: reply.silent } : {}),
        });
      case "list":
        return scheduler.list(requestedTarget);
      case "update":
        return scheduler.update(args.id as string, args as Record<string, unknown>);
      case "delete":
        scheduler.delete(args.id as string);
        return "ok";
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
    // #1336 P2: use the shared normalizer — trims whitespace AND drops empties,
    // so " \t " / [" ","\t"] are treated identically to undefined.
    const asStatusFilter = normalizeStatusFilter;
    // #1336: small write ack — identifying fields only.
    const ack = (t: Task) => ({ id: t.id, status: t.status, updated_at: t.updated_at });
    try {
      switch (action) {
        case "create": {
          const title = asStr(args.title);
          if (!title) return { error: "title is required" };
          return ack(db.createTask({
            title,
            description: asStr(args.description),
            priority: asPriority(args.priority),
            assignee: asStr(args.assignee),
            depends_on: asStrArr(args.depends_on),
            created_by: instance,
          }));
        }
        case "list": {
          const filterAssignee = asStr(args.filter_assignee) || undefined;
          const explicitStatus = asStatusFilter(args.filter_status);
          // #1336 item 1: default to live-only (no done/cancelled) unless the
          // caller explicitly asked for a status.
          const effectiveStatus = explicitStatus ?? LIVE_TASK_STATUSES;
          const verbose = args.verbose === true;
          const tasks = verbose
            ? db.listTasks({ assignee: filterAssignee, status: effectiveStatus, verbose: true })
            : db.listTasks({ assignee: filterAssignee, status: effectiveStatus });
          // #1335: cap unfiltered list. The default live-only filter does not
          // count as an explicit filter for the cap decision.
          return applyTaskListCap(tasks, filterAssignee, explicitStatus);
        }
        case "get": {
          const id = asStr(args.id);
          if (!id) return { error: "id is required" };
          return db.getTaskByPrefix(id);
        }
        case "claim": {
          const id = asStr(args.id);
          if (!id) return { error: "id is required" };
          return ack(db.claimTask(db.getTaskByPrefix(id).id, instance));
        }
        case "done": {
          const id = asStr(args.id);
          if (!id) return { error: "id is required" };
          return ack(db.completeTask(db.getTaskByPrefix(id).id, asStr(args.result)));
        }
        case "update": {
          const id = asStr(args.id);
          if (!id) return { error: "id is required" };
          return ack(db.updateTask(db.getTaskByPrefix(id).id, {
            status: asStatus(args.status),
            assignee: asStr(args.assignee),
            result: asStr(args.result),
            priority: asPriority(args.priority),
          }));
        }
        default: return { error: `Unknown task action: ${action}` };
      }
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  async handleSetDisplayNameHttp(instance: string, name: string): Promise<unknown> {
    if (!this.fleetConfig) return { error: "Fleet config not available" };
    if (!name || name.length > 30) return { error: "Name must be 1-30 characters" };
    if (!this.setInstanceDisplayName(instance, name)) return { error: `Instance '${instance}' not found` };
    return { display_name: name };
  }

  async handleListEmojisHttp(instance: string, refresh: boolean, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.listEmojisFor(instance, refresh, args);
  }

  async handleListStickersHttp(instance: string, args: Record<string, unknown>): Promise<unknown> {
    return this.listStickersFor(instance, args);
  }

  async handlePreviewStickersHttp(instance: string, args: Record<string, unknown>): Promise<unknown> {
    return this.previewStickers(instance, args);
  }

  async handleSetPersonaEmojiHttp(instance: string, args: Record<string, unknown>): Promise<unknown> {
    return this.setPersonaEmoji(instance, args);
  }

  async handlePreviewEmojisHttp(instance: string, args: Record<string, unknown>): Promise<unknown> {
    return this.previewEmojis(instance, args);
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
    if (!ipc) return;
    if (!this.scheduler) {
      // Returning silently left the caller waiting for a response that was
      // never coming. Over IPC that is a hang, and a hang is a worse answer
      // than an error.
      ipc.send({ type: "fleet_task_response", fleetRequestId, error: "The task board is unavailable — the fleet scheduler is not running" });
      return;
    }

    const db = this.scheduler.db;
    const action = payload.action as string;
    // #1336 P2: use the shared normalizer — trims whitespace AND drops empties,
    // so " \t " / [" ","\t"] are treated identically to undefined.
    const asStatusFilter = normalizeStatusFilter;
    const ack = (t: Task) => ({ id: t.id, status: t.status, updated_at: t.updated_at });

    try {
      let result: unknown;
      // Full task kept for activity logging; the IPC reply uses the compact ack.
      let logTask: Task | undefined;
      switch (action) {
        case "create":
          logTask = db.createTask({
            title: payload.title as string,
            description: payload.description as string | undefined,
            priority: payload.priority as "low" | "normal" | "high" | "urgent" | undefined,
            assignee: payload.assignee as string | undefined,
            depends_on: payload.depends_on as string[] | undefined,
            created_by: meta.instance_name || instanceName,
          });
          result = ack(logTask);
          break;
        case "list": {
          // P3: normalize empty strings to undefined — SchedulerDb.listTasks
          // ignores them but the cap logic must treat them as "not filtered".
          const filterAssignee = (payload.filter_assignee as string | undefined) || undefined;
          const explicitStatus = asStatusFilter(payload.filter_status);
          // #1336 item 1: default to live-only (no done/cancelled).
          const effectiveStatus = explicitStatus ?? LIVE_TASK_STATUSES;
          const verbose = payload.verbose === true;
          const tasks = verbose
            ? db.listTasks({ assignee: filterAssignee, status: effectiveStatus, verbose: true })
            : db.listTasks({ assignee: filterAssignee, status: effectiveStatus });
          // #1335: cap unfiltered list — the default live-only filter does not
          // count as an explicit filter.
          result = applyTaskListCap(tasks, filterAssignee, explicitStatus);
          break;
        }
        case "get":
          result = db.getTaskByPrefix(payload.id as string);
          break;
        case "claim":
          logTask = db.claimTask(db.getTaskByPrefix(payload.id as string).id, meta.instance_name || instanceName);
          result = ack(logTask);
          break;
        case "done":
          logTask = db.completeTask(db.getTaskByPrefix(payload.id as string).id, payload.result as string | undefined);
          result = ack(logTask);
          break;
        case "update":
          logTask = db.updateTask(db.getTaskByPrefix(payload.id as string).id, {
            status: payload.status as string | undefined,
            assignee: payload.assignee as string | undefined,
            result: payload.result as string | undefined,
            priority: payload.priority as string | undefined,
          } as Record<string, unknown>);
          result = ack(logTask);
          break;
        default:
          throw new Error(`Unknown task action: ${action}`);
      }
      ipc.send({ type: "fleet_task_response", fleetRequestId, result });

      // Activity log for task lifecycle events
      if (action === "create" && logTask) {
        this.eventLog?.logActivity("task_update", instanceName, `created task: ${logTask.title}`, logTask.assignee ?? undefined);
      } else if (action === "claim" && logTask) {
        this.eventLog?.logActivity("task_update", instanceName, `claimed: ${logTask.title}`);
      } else if (action === "done" && logTask) {
        this.eventLog?.logActivity("task_update", instanceName, `completed: ${logTask.title}`, undefined, logTask.result ?? undefined);
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

  async deleteForumTopic(topicId: number | string, adapterId?: string): Promise<void> {
    try {
      const adapter = (adapterId ? this.worlds.get(adapterId)?.adapter : undefined) ?? this.adapter;
      if (!adapter?.deleteTopic) return;
      await adapter.deleteTopic(topicId);
    } catch (err) {
      this.logger.warn({ err, topicId }, "Failed to delete forum topic during rollback");
    }
  }

  getForumTopicDeleter(adapterId?: string): ((topicId: number | string) => Promise<void>) | null {
    const adapter = (adapterId ? this.worlds.get(adapterId)?.adapter : undefined) ?? this.adapter;
    if (!adapter?.deleteTopic) return null;
    return (topicId) => adapter.deleteTopic!(topicId);
  }

  private topicCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private sessionPruneTimer: ReturnType<typeof setInterval> | null = null;
  private classicReloadTimer: ReturnType<typeof setInterval> | null = null;
  private botUserId: string | undefined;

  /** Periodically check if bound topics still exist. Never deletes user data. */
  private startTopicCleanupPoller(): void {
    if (this.topicCleanupTimer) clearInterval(this.topicCleanupTimer);
    const generation = ++this.topicCleanupGeneration;
    this.topicCleanupTimer = setInterval(() => { void this.scheduleTopicCleanup(generation); }, 5 * 60_000);
  }

  /** Coalesce timer ticks; an outage must not create overlapping destructive-looking scans. */
  private scheduleTopicCleanup(generation = this.topicCleanupGeneration): Promise<void> {
    if (this.topicCleanupInFlight) return this.topicCleanupInFlight;
    const run = this.runTopicCleanup(generation).finally(() => {
      if (this.topicCleanupInFlight === run) this.topicCleanupInFlight = null;
    });
    this.topicCleanupInFlight = run;
    return run;
  }

  private confirmedProbeFence(adapterId: string, adapter: ChannelAdapter): { generation?: number } | null {
    const health = adapter.getHealthSnapshot?.();
    if (health) {
      return health.status === "connected" && health.isReady
        ? { generation: health.generation }
        : null;
    }
    return this.adapterState.get(adapterId)?.status === "connected" ? {} : null;
  }

  private sameProbeFence(
    adapterId: string,
    adapter: ChannelAdapter,
    before: { generation?: number },
    result?: TopicPresence,
  ): boolean {
    const after = this.confirmedProbeFence(adapterId, adapter);
    if (!after) return false;
    if (before.generation !== after.generation) return false;
    return result?.generation === undefined || result.generation === after.generation;
  }

  private topicProbeStreakKey(threadId: string, adapterId: string | undefined, reason: string): string {
    return FleetManager.TOPIC_PROBE_ADAPTER_SCOPED_REASONS.has(reason)
      ? `adapter:${adapterId ?? "unbound"}`
      : `thread:${threadId}`;
  }

  /** A definite answer (present or missing) ends the unknown streak for that route and its adapter. */
  private clearTopicProbeUnknownStreak(threadId: string, adapterId: string | undefined): void {
    this.topicProbeUnknownStreak.delete(`thread:${threadId}`);
    this.topicProbeUnknownStreak.delete(`adapter:${adapterId ?? "unbound"}`);
  }

  /**
   * Record one unknown probe result. Nothing here can touch quarantine or
   * removal: unknown is always retained data. The only question is whether
   * the operator hears about it, and a single transient (one flaky HTTP call
   * out of dozens per pass) must not — only a streak does.
   *
   * Used directly for single-route events (channelDelete, the pre-action
   * fence). The periodic scan goes through a TopicProbePass instead, so one
   * pass over N routes of a dead adapter counts as ONE check, not N.
   */
  private warnTopicProbeUnknown(
    instanceName: string,
    threadId: string,
    adapterId: string | undefined,
    reason: string,
    detail?: string,
  ): void {
    this.noteTopicProbeUnknown(this.topicProbeStreakKey(threadId, adapterId, reason),
      { instanceName, threadId, adapterId, reason, detail });
  }

  /** One scan's worth of probe outcomes, applied to the streaks after the loop. */
  private newTopicProbePass(): TopicProbePass {
    return { unknown: new Map(), definite: new Set() };
  }

  private passTopicProbeUnknown(
    pass: TopicProbePass,
    instanceName: string,
    threadId: string,
    adapterId: string | undefined,
    reason: string,
    detail?: string,
  ): void {
    const key = this.topicProbeStreakKey(threadId, adapterId, reason);
    // First unknown per key per pass wins; the rest of the routes on a dead
    // adapter are the same observation, not additional checks.
    if (!pass.unknown.has(key)) pass.unknown.set(key, { instanceName, threadId, adapterId, reason, detail });
  }

  private passTopicProbeDefinite(pass: TopicProbePass, threadId: string, adapterId: string | undefined): void {
    pass.definite.add(`thread:${threadId}`);
    pass.definite.add(`adapter:${adapterId ?? "unbound"}`);
  }

  /**
   * Apply a pass: a definite answer resets its keys, and an adapter that
   * answered for any route this pass is evidently alive, so an unknown for the
   * same adapter key in the same pass does not count — regardless of the order
   * the routes happened to be probed in.
   */
  private applyTopicProbePass(pass: TopicProbePass): void {
    for (const key of pass.definite) this.topicProbeUnknownStreak.delete(key);
    for (const [key, ctx] of pass.unknown) {
      if (pass.definite.has(key)) continue;
      this.noteTopicProbeUnknown(key, ctx);
    }
  }

  private noteTopicProbeUnknown(
    streakKey: string,
    { instanceName, threadId, adapterId, reason, detail }: TopicProbeUnknownContext,
  ): void {
    const streak = (this.topicProbeUnknownStreak.get(streakKey) ?? 0) + 1;
    this.topicProbeUnknownStreak.set(streakKey, streak);
    if (streak < FleetManager.TOPIC_PROBE_UNKNOWN_ESCALATION) {
      this.logger.debug({ instanceName, threadId, adapterId, reason, detail, streak },
        "Topic presence not confirmed this pass — transient, retaining instance and all data");
      return;
    }
    const key = `${adapterId ?? "unbound"}:${reason}`;
    const now = Date.now();
    const last = this.topicProbeWarnings.get(key) ?? 0;
    if (now - last < FleetManager.FLEET_ERROR_THROTTLE_MS) return;
    this.topicProbeWarnings.set(key, now);
    this.logger.error({ instanceName, threadId, adapterId, reason, detail, streak },
      "Topic presence could not be confirmed repeatedly — retaining instance and all data");
    this.notifyFleetError(t("fleet.topic_probe_unknown", instanceName, adapterId ?? "unbound", streak));
  }

  /** One fixed-snapshot topology pass. Automatic evidence can only quarantine. */
  private async runTopicCleanup(generation: number): Promise<void> {
    if (generation !== this.topicCleanupGeneration || this.shuttingDown) return;
    const snapshot = [...this.routing.entries()].filter(([, target]) => isProbeableRouteTarget(target));
    const missing: Array<{
      threadId: string;
      target: RouteTarget;
      adapterId: string;
      adapter: ChannelAdapter;
      generation?: number;
    }> = [];
    const pass = this.newTopicProbePass();
    const skippedOnDemand = new Set<string>();

    for (const [threadId, target] of snapshot) {
      if (generation !== this.topicCleanupGeneration || this.shuttingDown) return;
      // The route may have been replaced while an earlier probe was in flight.
      if (this.routing.resolve(threadId) !== target) continue;
      const adapterId = this.getInstanceAdapterId(target.name);
      const adapter = adapterId ? this.adapters.get(adapterId) : undefined;
      if (!adapterId || !adapter?.probeTopicPresence) {
        this.passTopicProbeUnknown(pass, target.name, threadId, adapterId, "owner-adapter-unavailable");
        continue;
      }
      // An on-demand adapter's probe is reserved for confirming a delivery
      // failure hint (handleProviderTopicClosed); the periodic scan leaves its
      // routes alone — no probe, no unknown, no streak, no notice.
      if (adapter.topicProbePolicy?.() === "on-demand") {
        if (!skippedOnDemand.has(adapterId)) {
          skippedOnDemand.add(adapterId);
          this.logger.debug({ adapterId }, "Topic scan skipping on-demand adapter — presence is confirmed only on delivery failure");
        }
        continue;
      }
      const before = this.confirmedProbeFence(adapterId, adapter);
      if (!before) {
        this.passTopicProbeUnknown(pass, target.name, threadId, adapterId, "owner-adapter-not-ready");
        continue;
      }

      let result: TopicPresence;
      try {
        result = await adapter.probeTopicPresence(threadId);
      } catch {
        result = { status: "unknown", reason: "provider-probe-threw" };
      }
      if (generation !== this.topicCleanupGeneration || this.shuttingDown) return;
      if (!this.sameProbeFence(adapterId, adapter, before, result)) {
        this.passTopicProbeUnknown(pass, target.name, threadId, adapterId, "owner-adapter-generation-changed");
        continue;
      }
      if (result.status === "unknown") {
        this.passTopicProbeUnknown(pass, target.name, threadId, adapterId, result.reason, result.detail);
      } else {
        this.passTopicProbeDefinite(pass, threadId, adapterId);
        if (result.status === "missing") {
          missing.push({ threadId, target, adapterId, adapter, generation: result.generation });
        }
      }
    }

    if (generation !== this.topicCleanupGeneration || this.shuttingDown) return;
    // One pass, one check: streaks move by at most one per key here.
    this.applyTopicProbePass(pass);
    if (missing.length === 0) return;
    if (missing.length > 1) {
      this.logger.error({ missing: missing.map(item => ({ instanceName: item.target.name, threadId: item.threadId, adapterId: item.adapterId })) },
        "Multiple topics appeared missing in one pass — treating topology evidence as untrusted and retaining all data");
      this.notifyFleetError(t("fleet.topic_probe_bulk", missing.length));
      return;
    }

    const item = missing[0];
    if (this.routing.resolve(item.threadId) !== item.target
      || this.getInstanceAdapterId(item.target.name) !== item.adapterId
      || this.adapters.get(item.adapterId) !== item.adapter) return;
    const current = this.confirmedProbeFence(item.adapterId, item.adapter);
    if (!current || (item.generation !== undefined && current.generation !== item.generation)) {
      this.warnTopicProbeUnknown(item.target.name, item.threadId, item.adapterId, "owner-adapter-changed-before-action");
      return;
    }
    this.topicCommands.handleTopicDeleted(item.threadId, {
      source: "provider-probe",
      adapterId: item.adapterId,
      generation: item.generation,
    });
  }

  /**
   * A gateway event is only a hint. Confirm it through the passive REST probe;
   * reconnecting gateways have emitted false channelDelete events in practice.
   */
  private async handleProviderTopicClosed(threadId: string, adapterId: string, adapter: ChannelAdapter): Promise<void> {
    const target = this.routing.resolve(threadId);
    if (!target || !isProbeableRouteTarget(target)) return;
    if (this.getInstanceAdapterId(target.name) !== adapterId) return;
    if (this.adapters.get(adapterId) !== adapter) return;
    const before = this.confirmedProbeFence(adapterId, adapter);
    if (!before || !adapter.probeTopicPresence) {
      this.warnTopicProbeUnknown(target.name, threadId, adapterId, "topic-close-from-unready-adapter");
      return;
    }
    let result: TopicPresence;
    try {
      result = await adapter.probeTopicPresence(threadId);
    } catch {
      result = { status: "unknown", reason: "provider-probe-threw" };
    }
    if (this.routing.resolve(threadId) !== target
      || this.getInstanceAdapterId(target.name) !== adapterId
      || this.adapters.get(adapterId) !== adapter
      || !this.sameProbeFence(adapterId, adapter, before, result)) {
      this.warnTopicProbeUnknown(target.name, threadId, adapterId, "topic-close-generation-changed");
      return;
    }
    if (result.status === "unknown") {
      this.warnTopicProbeUnknown(target.name, threadId, adapterId, result.reason, result.detail);
      return;
    }
    this.clearTopicProbeUnknownStreak(threadId, adapterId);
    if (result.status !== "missing") {
      // The gateway said deleted, REST says present: a definite answer, so it
      // is not an unknown streak — but it is worth one debug line.
      this.logger.debug({ instanceName: target.name, threadId, adapterId },
        "channelDelete hint contradicted by REST — topic present, nothing to do");
      return;
    }
    this.topicCommands.handleTopicDeleted(threadId, {
      source: "provider-event",
      adapterId,
      generation: result.generation,
    });
  }

  private bindTopicClosedHandler(adapter: ChannelAdapter, adapterId: string, label: string): void {
    adapter.on("topic_closed", safeHandler(async (data: { chatId: string; threadId: string }) => {
      if (this.topicArchiver.isArchived(data.threadId)) return;
      await this.handleProviderTopicClosed(data.threadId, adapterId, adapter);
    }, this.logger, label));
  }

  /**
   * Remove only the volatile route. The instance config, daemon, schedules,
   * teams, metadata directory, and working tree remain untouched until an
   * authenticated explicit deletion is requested.
   */
  quarantineMissingTopic(
    threadId: string,
    target: RouteTarget,
    evidence: { source: "provider-event" | "provider-probe"; adapterId?: string; generation?: number },
  ): void {
    if (!isProbeableRouteTarget(target) || this.routing.resolve(threadId) !== target) return;
    this.routing.unregister(threadId, target.name);
    this.logger.error({ instanceName: target.name, threadId, ...evidence },
      "Topic is confirmed missing — route quarantined; instance configuration and user data were retained");
    this.notifyFleetError(t("fleet.topic_quarantined", target.name, threadId));
  }

  /**
   * Patch only values changed in the effective config into the original YAML
   * document. Unknown keys and comments remain untouched; redundant
   * non-identity instance leaves are canonicalized to inheritance afterward.
   */
  saveFleetConfig(explicitPatches: RawConfigPatch[] = []): void {
    this.publicWebLink?.refresh();
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

    noteSettingsWrite(this.configPath, this.savedFleetConfigSnapshot, this.fleetConfig);
    const output = String(this.rawFleetDocument);
    if (redundantPaths.length > 0) this.writeFleetConfigBackup(source);
    // Atomic write with fsync. The beforeRename hook runs after fsync and
    // before rename so validation failures are reported before the file is
    // replaced (#1056), and the temp file is cleaned up on any throw.
    atomicWriteFileSync(this.configPath, output, {
      mode: existsSync(this.configPath) ? statSync(this.configPath).mode : 0o644,
      fsync: this.fsyncForTest,
      beforeRename: (tempPath) => {
        // #1056 (Fable's 2.2 audit): the patcher writes leaves, not configs, so
        // a wrong patch can produce a file the validator — or the next start —
        // refuses. Load and validate what is about to replace fleet.yaml.
        const refusal = this.savedFleetConfigProblem(tempPath);
        if (refusal) throw new Error(refusal);
        if (existsSync(this.configPath)) chmodSync(tempPath, statSync(this.configPath).mode);
      },
    });

    this.rawFleetConfig = loadRawFleetConfig(this.configPath);
    this.savedFleetConfigSnapshot = structuredClone(this.fleetConfig);
    this.logger.info(
      { path: this.configPath, strippedDefaults: redundantPaths.length },
      "Saved fleet config (lossless patch)",
    );
  }

  /** Why the config written to `candidate` must not replace fleet.yaml, or null: it does not load, or it adds errors. */
  private savedFleetConfigProblem(candidate: string): string | null {
    let after;
    try { after = validateFleetConfig(loadFleetConfig(candidate)); }
    catch (err) { return `Refusing to save fleet.yaml: the result would not load (${(err as Error).message})`; }
    let had = new Set<string>();
    try {
      if (this.configPath && existsSync(this.configPath)) {
        had = new Set(validateFleetConfig(loadFleetConfig(this.configPath)).errors.map(e => `${e.path}\u0000${e.message}`));
      }
    } catch { /* the current file does not load: every error of the result counts as new */ }
    const introduced = after.errors.filter(e => !had.has(`${e.path}\u0000${e.message}`));
    return introduced.length
      ? `Refusing to save fleet.yaml: it would be invalid (${introduced.map(e => `${e.path}: ${e.message}`).join("; ")})`
      : null;
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
    if (Object.is(before, after) || JSON.stringify(before) === JSON.stringify(after)) return;

    if (Array.isArray(before) && Array.isArray(after)) {
      // Connection deltas are indexed only while the stable identities still
      // match. Never apply a stale manager's edit to a reordered world.
      if (path.length === 1 && path[0] === "channels") {
        const fresh = document.getIn(path)?.toJSON?.() ?? document.getIn(path);
        const ids = (items: any[]) => items.map(item => item?.id ?? item?.type);
        if (Array.isArray(fresh) && JSON.stringify(ids(fresh)) !== JSON.stringify(ids(before))) {
          throw new Error("Connection order changed; reload before saving");
        }
      }
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
      // #1056: a legacy `channel` is being migrated (the caller removed it and kept `channels`). The file has no
      // `channels` for the leaf patch below to land on — the snapshot's list is only the normalized alias — so a bare
      // channels[0] holding just the changed field would be written while `channel` is deleted. Move the connection
      // as it is in the file NOW (a concurrent or manual edit, an option AgEnD does not know) into channels[0]
      // first; the patch then applies only this save's own changes on top, with the usual identity/order check.
      if (path.length === 0 && this.rawFleetConfig.channel && !this.rawFleetConfig.channels
        && after.channel === undefined && Array.isArray(after.channels) && !document.hasIn(["channels"])) {
        const fresh = document.getIn(["channel"], true);
        if (isMap(fresh)) {
          const list = document.createNode([]) as ReturnType<typeof document.createNode> & { items: unknown[] };
          list.items.push(fresh.clone());
          document.setIn(["channels"], list);
        }
      }
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

  getSettingsConfigPath(): string { return this.configPath; }

  async removeInstance(name: string, authorization: ExplicitInstanceRemoval, execution?: SettingsExecution): Promise<void> {
    if (execution) return this.lifecycle.runTransition(name, transition => this.removeInstanceOwned(name, authorization, execution, transition));
    return this.removeInstanceOwned(name, authorization);
  }

  private async removeInstanceOwned(name: string, authorization: ExplicitInstanceRemoval, execution?: SettingsExecution, transition?: TransitionHandle): Promise<void> {
    execution?.assert();
    assertExplicitInstanceRemoval(authorization);
    const beforeRemoval = (): void => {
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

    };
    if (execution) execution.mutate(beforeRemoval); else beforeRemoval();
    // Capture instance dir BEFORE lifecycle.remove, which deletes the instance
    // from fleetConfig. (The backend would be unresolvable afterwards.)
    const instanceDirToClean = this.getInstanceDir(name);

    if (execution) await this.lifecycle.remove(name, authorization, execution, transition);
    else await this.lifecycle.remove(name, authorization);
    // A later same-name registration owns its files and caches.
    if (this.fleetConfig?.instances[name] || this.daemons.has(name)) return;

    execution?.assert();
    // Clean up per-instance tracking maps so they don't grow unbounded
    // as instances are created and deleted over the lifetime of the fleet.
    this.lastActivity.delete(name);
    this.lastInboundUser.delete(name);
    this.rateLimitWarnedAt.delete(name);
    // Its web chat goes with it (only after the removal succeeded): a later instance of the same name
    // must not be shown the old one's conversation, and deleted names must not pile up.
    this.webChatHistory.forget(name);
    this.webFiles.forget(name);

    // Clean up statusline watcher + instance directory
    this.statuslineWatcher.unwatch(name);
    // instanceDirToClean and effectiveBackend are captured before lifecycle.remove
    // (which deletes the instance from fleetConfig).
    try {
      rmSync(instanceDirToClean, { recursive: true, force: true });
    } catch (err) {
      this.logger.debug({ err, name }, "Instance dir cleanup failed");
    }
    // Remove the codex short home (~/.agend/cx/<hash>/) unconditionally.
    // (#953). CodexBackend.shortHomeFor is a pure path computation; the existsSync
    // guard makes this a no-op for instances that never used a short home (non-codex,
    // or codex instances on a short-enough path). Unconditional also covers instances
    // whose backend was switched away from codex before deletion — they still have a
    // short home that would otherwise be inherited by a later same-name instance.
    try {
      const { CodexBackend } = await import("./backend/codex.js");
      execution?.assert();
      const shortHome = CodexBackend.shortHomeFor(instanceDirToClean);
      if (existsSync(shortHome)) rmSync(shortHome, { recursive: true, force: true });
    } catch (err) {
      this.logger.debug({ err, name }, "Codex short home cleanup failed");
    }
    execution?.complete();
  }

  startStatuslineWatcher(name: string): void {
    if (this.lifecycle.isPaused(name)) return;
    this.statuslineWatcher.watch(name);
  }

  stopStatuslineWatcher(name: string): void {
    // Pausing stops I/O but retains the last observed limits for status views.
    this.statuslineWatcher.unwatch(name, true);
  }

  /**
   * Last delivery status applied per bot+message. Unbounded by design: any cap
   * reintroduces the hole where a forgotten ❌ can never be cleared, and an
   * entry is two short strings (id pair plus one emoji) — thousands of
   * status-reacted messages cost kilobytes. A bot restart loses it, degrading
   * to a plain add (never worse than the old behaviour).
   */
  private lastStatusEmoji = new Map<string, { emoji: string; status?: DeliveryStatus }>();
  /**
   * #1056: every status emoji each bot really stamped, per `${adapterId}:${messageId}` (match keys). A connection's
   * status set can change while AgEnD runs, so "is this a stamp?" cannot be answered from the current set alone: a
   * bot's earlier stamp in the old emoji must still be plumbing, not an agent's reaction. Unbounded for the same
   * reason as lastStatusEmoji (a few short strings per stamped message).
   */
  private stampedStatus = new Map<string, Set<string>>();
  private noteStamped(adapter: ChannelAdapter, messageId: string, emoji: string): void {
    const adapterId = typeof (adapter as { id?: unknown }).id === "string" ? (adapter as unknown as { id: string }).id : "?";
    const k = `${adapterId}:${messageId}`;
    let set = this.stampedStatus.get(k);
    if (!set) this.stampedStatus.set(k, set = new Set());
    set.add(statusMatchKey(emoji));
  }
  /**
   * One in-flight status update per bot+message: updates run strictly in call
   * order, so a delayed ❌ add can never land after a newer ✅'s removal —
   * the final state is always the latest call. Entries delete themselves when
   * the chain drains, so idle messages hold no memory.
   */
  private deliveryStatusChains = new Map<string, Promise<void>>();
  /** #725: in-flight CLI env probes, keyed by backend name. Coalesces concurrent /model requests. */
  private pendingCliEnvProbes = new Map<string, Promise<import("./backend/types.js").CliEnv | null>>();
  /** Forced vendor catalog refreshes are separate flights, but sysinfo joins either flight. */
  private pendingVendorCliEnvProbes = new Map<string, Promise<import("./backend/types.js").CliEnv | null>>();
  private pendingInstanceModelProbes = new Map<string, Promise<import("./backend/types.js").ModelOption[]>>();
  private readonly cliEnvProbePool = new ProbeWorkerPool();
  private cliEnvProbeEpoch = 0;

  /**
   * The status emojis for an instance (#1005): its own `status_emojis`, then
   * its channel's `options.status_emojis`, then the platform built-in. An
   * unusable value warns once and falls through, never failing the reaction.
   * `adapterId` pins the channel for paths that already know the bot (classic).
   */
  resolveStatusEmojisFor(
    instanceName: string, adapterId?: string, adapter?: ChannelAdapter | null,
  ): ResolvedStatusEmojis & { platform: string | undefined } {
    const worldId = adapterId ?? this.getInstanceAdapterId(instanceName);
    const channel = this.statusEmojiChannel(worldId);
    // The adapter that will react decides the vocabulary: a Telegram bot gets
    // Telegram's reaction set even if the channel lookup fell back elsewhere.
    const reacting = adapter ?? (worldId ? this.worlds.get(worldId)?.adapter : undefined) ?? this.adapter;
    const platform = reacting instanceof TelegramAdapter ? "telegram" : channel?.type;
    const resolved = resolveStatusEmojis({
      platform,
      platformConfig: channel?.options?.status_emojis,
      instanceConfig: this.fleetConfig?.instances[instanceName]?.status_emojis,
      onInvalid: (source, key, value, problem) => {
        const at = source === "instance" ? `instances.${instanceName}` : `channel ${channel?.id ?? platform ?? "?"}`;
        const once = `${at}:${key}:${String(value)}`;
        if (this.warnedStatusEmojis.has(once)) return;
        this.warnedStatusEmojis.add(once);
        this.logger.warn({ at, key, value, problem }, `Ignoring status_emojis.${key}: ${problem} — using the default`);
      },
    });
    return { ...resolved, platform };
  }
  private warnedStatusEmojis = new Set<string>();

  /**
   * The connection whose `options.status_emojis` an instance on `worldId` stamps with. #1056: read from the live config
   * first — a Settings save replaces `fleetConfig.channels`, and the running world keeps the object it started with —
   * so a change to the connection's emojis applies at the next stamp, as an instance's own override does. Only the
   * emoji options are taken from it: the platform is still the running adapter's (resolveStatusEmojisFor).
   */
  private statusEmojiChannel(worldId: string | null | undefined): ChannelConfig | undefined {
    const started = (worldId ? this.worlds.get(worldId)?.channelConfig : undefined) ?? this.getChannelConfig(worldId ?? undefined);
    if (!worldId) return started;
    const list = this.fleetConfig?.channels ?? (this.fleetConfig?.channel ? [this.fleetConfig.channel] : []);
    const live = list.find(ch => (ch.id ?? ch.type) === worldId);
    if (!live || !started) return live ?? started;
    return { ...started, options: { ...(started.options ?? {}), status_emojis: live.options?.status_emojis } } as ChannelConfig;
  }

  /**
   * A Discord connection's server emojis for the Settings picker (#1005), from
   * every server its bot can draw on (#1021): the primary `group_id` server,
   * then each other server the bot is a member of that ClassicBot's
   * `allowed_guilds` admits (unset = all, as for classic routing). A bot can
   * react with a custom emoji from any server it is in. Cached per server — a
   * server's emoji set changes rarely — and one fetch per server at a time;
   * `refresh` forces new ones. One server refusing (e.g. Missing Access) is
   * reported on that server and does not hide the others. Uses the running
   * adapter, so the bot token never leaves the server.
   */
  async listGuildEmojis(channelId: string, refresh = false): Promise<
    { ok: true; fetched_at: number; emojis: GuildEmoji[]; guilds: GuildEmojiGroup[] }
    | { ok: false; error: string }
  > {
    const world = this.worlds.get(channelId);
    if (!world) return { ok: false, error: `connection "${channelId}" is not running` };
    if (world.type !== "discord") return { ok: false, error: "only Discord has server custom emoji" };
    const adapter = world.adapter as ChannelAdapter & {
      listGuildEmojis?: (guildId?: string) => Promise<GuildEmoji[]>;
      listMemberGuilds?: () => Promise<Array<{ id: string; name: string; primary: boolean }>>;
    };
    if (!adapter.listGuildEmojis) return { ok: false, error: "this adapter cannot list server emojis" };
    const listEmojis = adapter.listGuildEmojis.bind(adapter);
    let servers: Array<{ id: string; name: string; primary: boolean }>;
    try {
      // This authenticated metadata picker is not a start/admission path. Keep
      // its existing empty-list inventory so existing channels' emoji settings
      // do not disappear when new-start access changes (#1418).
      const guildList = this.classicChannels?.getDefaults().allowed_guilds;
      const unrestrictedInventory = !!this.classicChannels && (!Array.isArray(guildList) || guildList.length === 0);
      servers = adapter.listMemberGuilds
        ? (await adapter.listMemberGuilds()).filter(g => g.primary || unrestrictedInventory || (this.classicChannels?.isGuildAllowed(g.id) ?? false))
        : [{ id: "", name: "", primary: true }];
    } catch (e) {
      return { ok: false, error: `Discord refused the server list: ${(e as Error).message}` };
    }
    const guilds = await Promise.all(servers.map(async (g): Promise<GuildEmojiGroup> => {
      const key = `${channelId}\0${g.id}`;
      const cached = this.guildEmojiCache.get(key);
      if (!refresh && cached && Date.now() - cached.fetched_at < FleetManager.GUILD_EMOJI_TTL_MS) return { ...g, ...cached };
      let pending = this.guildEmojiFetches.get(key);
      if (!pending) {
        pending = (g.id ? listEmojis(g.id) : listEmojis()).then(emojis => {
          const entry = { fetched_at: Date.now(), emojis };
          this.guildEmojiCache.set(key, entry);
          return entry;
        }).finally(() => this.guildEmojiFetches.delete(key));
        this.guildEmojiFetches.set(key, pending);
      }
      try {
        return { ...g, ...(await pending) };
      } catch (e) {
        return { ...g, error: `Discord refused the emoji list: ${(e as Error).message}` };
      }
    }));
    const listed = guilds.filter((g): g is GuildEmojiGroup & { emojis: GuildEmoji[]; fetched_at: number } => !!g.emojis);
    if (!listed.length) return { ok: false, error: guilds[0]?.error ?? "no server to list emojis from" };
    return {
      ok: true,
      fetched_at: Math.min(...listed.map(g => g.fetched_at)),
      emojis: listed.flatMap(g => g.emojis),
      guilds,
    };
  }
  private static GUILD_EMOJI_TTL_MS = 10 * 60_000;
  /** Keyed `<connection>\0<server id>`. */
  private guildEmojiCache = new Map<string, { fetched_at: number; emojis: GuildEmoji[] }>();
  private guildEmojiFetches = new Map<string, Promise<{ fetched_at: number; emojis: GuildEmoji[] }>>();

  /**
   * What `instanceName` may pick as its persona emoji (the `list_emojis`
   * tool): its current status set with where each value comes from, the
   * standard emojis its platform takes, and on Discord the server emojis its
   * bot can draw on — the same lists, and the same resolution, as the
   * Settings picker (#1005/#1021), so an agent and an operator see one truth.
   */
  async listEmojisFor(instanceName: string, refresh = false, opts: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    // Seeing is not setting: a ClassicBot instance has no per-instance stamp,
    // but it reacts in its own channel like any bot and must be able to see
    // the emojis it can use (only set_persona_emoji refuses it).
    // Own entries only: an inherited name (constructor, __proto__, toString…)
    // is not a fleet instance, as set_persona_emoji already holds.
    const self = this.ownInstanceConfig(instanceName);
    const classic = !self && this.isClassicPersonaTarget(instanceName);
    if (!self && !classic) return { error: this.personaEmojiMissing(instanceName) };
    const worldId = this.getInstanceAdapterId(instanceName);
    const { platform } = this.resolveStatusEmojisFor(instanceName);
    const channel = this.statusEmojiChannel(worldId);
    const current = previewStatusEmojis({ platform, platformConfig: channel?.options?.status_emojis, instanceConfig: self?.status_emojis });
    const out: Record<string, unknown> = {
      platform: platform ?? null,
      // #1056: progress_prefix is the emoji at the start of the progress message, not a reaction stamp.
      statuses: current.entries.map(e => ({ status: e.key, value: e.value, source: e.source, kind: e.key === "progress_prefix" ? "text_prefix" : "reaction" })),
      // #1056: say inline why the lists differ by platform, so an agent need not know it already.
      platform_note: platform === "telegram"
        ? "Telegram has no server custom emoji, so there is no server_emojis list: standard.reactions is the complete set a status reaction can use. progress_prefix is message text, not a reaction, so any single emoji works there."
        : platform === "discord"
          ? "A status reaction can be any single emoji, or a server emoji from server_emojis as <:name:id> (one of the servers this bot is in). progress_prefix is message text, not a reaction."
          : "This instance has no chat connection, so no platform rules apply yet.",
      standard: platform === "telegram"
        ? { reactions: [...TELEGRAM_REACTION_EMOJIS], note: "Telegram reacts only with these; progress_prefix may be any single emoji" }
        : { suggestions: STATUS_EMOJI_SUGGESTIONS, note: "any single emoji works" },
      ...(classic ? { note: "ClassicBot instances have no per-instance status emojis: the statuses above are the connection's, which an operator sets in Settings. You can still use any emoji listed here in your own reactions." } : {}),
    };
    if (platform === "discord" && worldId) {
      // #1226: a busy server's list was ~10k characters for an agent that wanted one emoji. Filter by name, cap
      // the count, keep to the primary server if asked, and leave the image URLs out unless asked
      // (preview_emojis is how an agent looks at one).
      const filter = emojiListFilter(opts);
      const listed = await this.listGuildEmojis(worldId, refresh);
      let left = filter.limit;
      out.server_emojis = listed.ok
        ? listed.guilds.filter(g => !filter.primaryOnly || g.primary).map(g => g.emojis
          ? {
            server: g.name || g.id, primary: g.primary,
            emojis: g.emojis.filter(e => e.available && filter.matches(e.name)).filter(() => left-- > 0).map(e => {
              const value = customEmojiValue(e);
              return filter.withImageUrls ? { value, image_url: emojiImageUrl(value) } : { value };
            }),
          }
          : { server: g.name || g.id, primary: g.primary, error: g.error })
        : { error: listed.error };
      if (!filter.withImageUrls) out.server_emojis_note = "Image URLs are left out; preview_emojis downloads the ones you want to look at (or pass with_image_urls).";
    }
    return out;
  }

  /**
   * `preview_emojis` (#1040): download a few Discord server emojis so an agent
   * can look at them before it picks one — a name and an id say nothing about
   * what an emoji looks like. The fleet fetches, not the agent (not every
   * backend can), and returns a local path per emoji to Read, as
   * download_attachment does for an attachment.
   *
   * SSRF-safe by construction: nothing from the caller reaches a URL. The
   * caller names emojis; each must be an available one in a server this bot
   * can draw on (the list set_persona_emoji checks), and the CDN URL is built
   * from that listed emoji's numeric id. Static PNG, size-capped, cached by id.
   */
  async previewEmojis(instanceName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    // Seeing, like list_emojis: ClassicBot instances may preview too.
    if (!this.ownInstanceConfig(instanceName) && !this.isClassicPersonaTarget(instanceName)) {
      return { error: this.personaEmojiMissing(instanceName) };
    }
    const wanted = args.emojis;
    if (!Array.isArray(wanted) || wanted.length === 0 || wanted.some(e => typeof e !== "string")) {
      return { error: "emojis is required: a list of <:name:id> values from list_emojis" };
    }
    if (wanted.length > FleetManager.EMOJI_PREVIEW_MAX) {
      return { error: `at most ${FleetManager.EMOJI_PREVIEW_MAX} at a time: narrow them down by name first` };
    }
    const { platform } = this.resolveStatusEmojisFor(instanceName);
    const worldId = this.getInstanceAdapterId(instanceName);
    if (platform !== "discord" || !worldId) {
      return { error: "only Discord server emojis need a preview; standard emojis are what they look like" };
    }
    const listed = await this.listGuildEmojis(worldId);
    if (!listed.ok) return { error: `cannot list this bot's server emojis: ${listed.error}` };
    const previews: Array<{ emoji: string; path: string }> = [];
    const errors: Array<{ emoji: string; error: string }> = [];
    for (const raw of wanted as string[]) {
      const e = normalizeEmoji(raw);
      if (e?.kind !== "custom") { errors.push({ emoji: raw, error: "not a server emoji (a standard emoji needs no preview)" }); continue; }
      const found = listed.emojis.find(g => g.id === e.id);
      if (!found?.available) { errors.push({ emoji: raw, error: "not a server emoji this bot can use" }); continue; }
      try {
        previews.push({ emoji: customEmojiValue(found), path: await this.fetchEmojiPreview(found.id) });
      } catch (err) {
        errors.push({ emoji: raw, error: `download failed: ${(err as Error).message}` });
      }
    }
    return { previews, errors, note: "Read each path to see the emoji (a static PNG)." };
  }

  // ── Stickers (#1226) ─────────────────────────────────────────────────────

  /** Where an instance talks: its connection, and its chat (and topic). The same address its notices go to. */
  private instanceChatTarget(instanceName: string): { worldId?: string; adapter?: ChannelAdapter; chatId?: string; threadId?: string } {
    const worldId = this.getInstanceAdapterId(instanceName);
    const adapter = (worldId ? this.worlds.get(worldId)?.adapter : undefined) ?? this.getAdapterForInstance(instanceName) ?? this.adapter ?? undefined;
    const topic = this.fleetConfig?.instances[instanceName]?.topic_id;
    const groupId = this.getChannelConfig(worldId)?.group_id;
    if (topic != null && groupId != null) return { worldId, adapter, chatId: String(groupId), threadId: String(topic) };
    const classicChat = this.classicChannels?.getChannelIdByInstance(instanceName);
    return { worldId, adapter, chatId: classicChat ?? (groupId != null ? String(groupId) : undefined) };
  }

  private static STICKER_LIST_TTL_MS = 10 * 60_000;
  /** Keyed `<connection>\0<scope key>` (a Discord channel, or "set:<name>"). */
  private stickerCache = new Map<string, { fetched_at: number; list: StickerList }>();

  /** One sticker list through the adapter, cached; `refresh` forces a fetch. Errors are the platform's, reworded. */
  private async stickerListFor(
    worldId: string, adapter: ChannelAdapter, target: StickerTarget, refresh = false,
  ): Promise<StickerList> {
    const key = `${worldId}\0${target.set ? `set:${target.set}` : `chat:${target.threadId ?? target.chatId ?? ""}`}`;
    const cached = this.stickerCache.get(key);
    if (!refresh && cached && Date.now() - cached.fetched_at < FleetManager.STICKER_LIST_TTL_MS) return cached.list;
    const list = await adapter.listStickers!(target);
    this.stickerCache.set(key, { fetched_at: Date.now(), list });
    return list;
  }

  /** The Telegram sticker sets an instance lists by default: its connection's `options.sticker_sets`. */
  private defaultStickerSets(worldId: string | undefined): string[] {
    const sets = (this.getChannelConfig(worldId)?.options as { sticker_sets?: unknown } | undefined)?.sticker_sets;
    return Array.isArray(sets) ? sets.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, 10) : [];
  }

  /**
   * `list_stickers` (#1226): the stickers this instance can send where it talks, one shape on both platforms —
   * `{ id, name, emoji_or_tags, format }` and no image URLs (preview_stickers shows them). Discord: its channel's
   * server only — a bot cannot send another server's stickers, so listing them would only cost context.
   * Telegram: the set named, or the connection's `options.sticker_sets`.
   */
  async listStickersFor(instanceName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.ownInstanceConfig(instanceName) && !this.isClassicPersonaTarget(instanceName)) {
      return { error: this.personaEmojiMissing(instanceName) };
    }
    const { worldId, adapter, chatId, threadId } = this.instanceChatTarget(instanceName);
    if (!worldId || !adapter?.listStickers) return { error: "this channel has no stickers to list" };
    const filter = emojiListFilter(args);
    const refresh = args.refresh === true || args.refresh === "true";
    const telegram = adapter.type === "telegram";
    const requested = typeof args.set === "string" && args.set.trim() ? [args.set.trim()] : [];
    const sets = telegram ? (requested.length ? requested : this.defaultStickerSets(worldId)) : [];
    if (telegram && !sets.length) {
      return { error: "name a sticker set: set=<name> (the <name> in t.me/addstickers/<name>), or have an operator add options.sticker_sets to this connection" };
    }
    const targets: StickerTarget[] = telegram ? sets.map(set => ({ set })) : [{ chatId, threadId }];
    const lists: Array<Record<string, unknown>> = [];
    let left = filter.limit;
    for (const target of targets) {
      try {
        const list = await this.stickerListFor(worldId, adapter, target, refresh);
        const stickers = list.stickers
          .filter(st => st.available && filter.matches(st.name, st.emoji_or_tags))
          .filter(() => left-- > 0)
          .map(({ id, name, emoji_or_tags, format }) => ({ id, name, emoji_or_tags, format }));
        lists.push({ scope: list.scope, stickers });
      } catch (err) {
        lists.push({ scope: target.set ? `set ${target.set}` : "this server", error: `cannot list stickers: ${(err as Error).message}` });
      }
    }
    return {
      platform: adapter.type,
      lists,
      note: "Send one with reply({ stickers: [id] }) — up to 3, never in the text. preview_stickers shows what they look like.",
    };
  }

  /**
   * `preview_stickers` (#1226), the sticker twin of preview_emojis: the fleet downloads a still picture of each named
   * sticker and returns a local path to Read. Only ids this instance's list_stickers returned (from the cache it
   * filled) — nothing the caller writes reaches a URL. A Lottie sticker, or an animated one with no thumbnail, has no
   * still picture: it is listed as preview_unavailable.
   */
  async previewStickers(instanceName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.ownInstanceConfig(instanceName) && !this.isClassicPersonaTarget(instanceName)) {
      return { error: this.personaEmojiMissing(instanceName) };
    }
    const wanted = args.stickers;
    if (!Array.isArray(wanted) || wanted.length === 0 || wanted.some(x => typeof x !== "string" || !x)) {
      return { error: "stickers is required: a list of ids from list_stickers" };
    }
    if (wanted.length > FleetManager.EMOJI_PREVIEW_MAX) return { error: `at most ${FleetManager.EMOJI_PREVIEW_MAX} at a time: narrow them down by name first` };
    const { worldId, adapter } = this.instanceChatTarget(instanceName);
    if (!worldId || !adapter?.fetchStickerPreview) return { error: "this channel has no stickers to preview" };
    const known = new Map<string, StickerInfo>();
    for (const [key, entry] of this.stickerCache) {
      if (key.startsWith(`${worldId}\0`)) for (const st of entry.list.stickers) known.set(st.id, st);
    }
    const previews: Array<{ sticker: string; name: string; path: string }> = [];
    const unavailable: Array<{ sticker: string; name: string; reason: string }> = [];
    const errors: Array<{ sticker: string; error: string }> = [];
    // In parallel: eight sequential downloads could outlast the tool's budget.
    const outcomes = await Promise.all((wanted as string[]).map(async id => {
      const st = known.get(id);
      if (!st) return { id, error: "not a sticker list_stickers returned here; list them first" };
      try {
        return { id, st, picture: await adapter.fetchStickerPreview!(st) };
      } catch (err) {
        return { id, error: `download failed: ${(err as Error).message}` };
      }
    }));
    for (const o of outcomes) {
      if ("error" in o) { errors.push({ sticker: o.id, error: o.error! }); continue; }
      if (!o.picture) { unavailable.push({ sticker: o.id, name: o.st.name, reason: `preview_unavailable: a ${o.st.format} sticker has no still picture` }); continue; }
      previews.push({ sticker: o.id, name: o.st.name, path: this.storeStickerPreview(o.id, o.picture) });
    }
    return { previews, unavailable, errors, note: "Read each path to see the sticker (a still picture)." };
  }

  /** A preview under the inbox, named by a hash of the id (a Telegram file_id is long), pruned after a day. */
  private storeStickerPreview(id: string, picture: StickerPreview): string {
    const dir = join(this.dataDir, "inbox", "sticker-previews");
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      try { if (now - statSync(join(dir, name)).mtimeMs > FleetManager.EMOJI_PREVIEW_TTL_MS) unlinkSync(join(dir, name)); } catch { /* raced */ }
    }
    const path = join(dir, `${createHash("sha256").update(id).digest("hex").slice(0, 24)}.${picture.ext}`);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, picture.bytes);
    renameSync(tmp, path);
    return path;
  }

  /**
   * `reply.stickers` (#1226), checked before anything is sent — a refused sticker is an error the agent sees, never
   * a reply that silently arrives without it. At most 3, text or stickers required. Discord: each must be an available
   * sticker of the server the reply goes to (another server's cannot be sent). Telegram: any sticker's file_id can be
   * sent anywhere; only its shape is checked here, and Telegram's own refusal still comes back as the reply's error.
   */
  async replyStickerProblem(adapter: ChannelAdapter, args: Record<string, unknown>, threadId: string | undefined, worldId: string | undefined): Promise<string | null> {
    const raw = args.stickers;
    const hasText = typeof args.text === "string" && args.text.length > 0;
    if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) return hasText ? null : "reply: text is required (or stickers)";
    if (!Array.isArray(raw) || raw.some(x => typeof x !== "string" || !x.trim())) return "reply: stickers must be a list of sticker ids from list_stickers";
    const ids = raw as string[];
    if (ids.length > 3) return "reply: at most 3 stickers per message";
    if (new Set(ids).size !== ids.length) return "reply: the same sticker twice";
    if (!adapter.sendStickers || !adapter.listStickers) return "reply: this channel cannot send stickers";
    if (adapter.type === "telegram") {
      const bad = ids.find(id => !/^[A-Za-z0-9_-]{10,255}$/.test(id));
      return bad ? `reply: ${bad} is not a Telegram sticker id (use an id from list_stickers)` : null;
    }
    const target: StickerTarget = { chatId: typeof args.chat_id === "string" ? args.chat_id : undefined, threadId };
    let list: StickerList;
    try {
      list = await this.stickerListFor(worldId ?? adapter.id ?? adapter.type, adapter, target);
      if (ids.some(id => !list.stickers.some(st => st.id === id))) list = await this.stickerListFor(worldId ?? adapter.id ?? adapter.type, adapter, target, true);
    } catch (err) {
      return `reply: cannot check the stickers for this channel: ${(err as Error).message}`;
    }
    for (const id of ids) {
      const st = list.stickers.find(x => x.id === id);
      if (!st) return `reply: sticker ${id} cannot be sent here — only stickers of this channel's server can (${list.scope}); call list_stickers`;
      if (!st.available) return `reply: sticker ${st.name} (${id}) is unavailable on this server (it lost the boost level it needs)`;
    }
    return null;
  }

  private static EMOJI_PREVIEW_MAX = 8;
  private static EMOJI_PREVIEW_MAX_BYTES = 256 * 1024;
  private static EMOJI_PREVIEW_TTL_MS = 24 * 60 * 60_000;

  /** One emoji's static PNG under the inbox, reused while fresh; stale ones are pruned. */
  private async fetchEmojiPreview(id: string): Promise<string> {
    if (!/^\d{15,25}$/.test(id)) throw new Error("not a Discord emoji id");
    const dir = join(this.dataDir, "inbox", "emoji-previews");
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      try { if (now - statSync(join(dir, name)).mtimeMs > FleetManager.EMOJI_PREVIEW_TTL_MS) unlinkSync(join(dir, name)); } catch { /* raced */ }
    }
    const path = join(dir, `${id}.png`);
    if (existsSync(path)) return path;
    const response = await fetch(`https://cdn.discordapp.com/emojis/${id}.png?size=96`, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!/^image\/png\b/.test(response.headers.get("content-type") ?? "")) throw new Error("not a PNG");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("empty response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > FleetManager.EMOJI_PREVIEW_MAX_BYTES) { await reader.cancel(); throw new Error("image too large"); }
      chunks.push(value);
    }
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, Buffer.concat(chunks));
    renameSync(tmp, path);
    return path;
  }

  /**
   * `set_persona_emoji`: `instanceName` sets one of its own status emojis —
   * `delivered` unless it names another — in its per-instance `status_emojis`
   * override (#1005 addendum 2), so its stamp is told apart from other bots'
   * on a shared message. The value is judged exactly as Settings and the
   * react path judge it (statusEmojiProblem on the instance's platform), and
   * a Discord server emoji must be one its bot can use: an emoji from a
   * server it is not in would be stored, preview fine, and fail every react.
   * An empty emoji removes that status's override.
   */
  async setPersonaEmoji(instanceName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const self = this.ownInstanceConfig(instanceName);
    if (!self) return { error: this.personaEmojiMissing(instanceName) };
    const status = (args.status ?? "delivered") as StatusEmojiKey;
    if (!STATUS_EMOJI_CONFIG_KEYS.includes(status)) {
      return { error: `status must be one of ${STATUS_EMOJI_CONFIG_KEYS.join(", ")}` };
    }
    // Only an explicit "" removes the override. The agent endpoint, typed IPC
    // and agent-cli do not run the MCP schema, so a call missing `emoji` must
    // be refused here, never read as "clear my delivered stamp".
    if (typeof args.emoji !== "string") {
      return { error: 'emoji is required: one emoji, a <:name:id> from list_emojis, or "" to remove your override' };
    }
    const raw = args.emoji.trim();
    // Whitespace is not an explicit "": a stray " " must not clear the stamp either.
    if (!raw && args.emoji !== "") {
      return { error: 'emoji is blank: pass one emoji, a <:name:id> from list_emojis, or exactly "" to remove your override' };
    }
    let value: string | undefined;
    if (raw) {
      const { platform } = this.resolveStatusEmojisFor(instanceName);
      const problem = statusEmojiProblem(platform, status, raw);
      if (problem) return { error: `${problem}. Call list_emojis for what ${platform ?? "this channel"} accepts.` };
      const e = normalizeEmoji(raw)!;
      if (e.kind === "custom") {
        const worldId = this.getInstanceAdapterId(instanceName);
        if (!worldId) return { error: "no connection to check that server emoji against" };
        const listed = await this.listGuildEmojis(worldId);
        if (!listed.ok) return { error: `cannot check that server emoji: ${listed.error}` };
        const found = listed.emojis.find(g => g.id === e.id);
        if (!found?.available) {
          return { error: `${raw} is not a server emoji this bot can use${found ? " (Discord marks it unavailable)" : ""}. Call list_emojis for the ones it can.` };
        }
        value = customEmojiValue(found);
      } else {
        value = e.value;
      }
    }
    // Re-read after the validation above, which may have waited on Discord:
    // another set_persona_emoji or a Settings save can have changed another
    // status, or replaced this instance's config object, meanwhile. Change
    // only this one key on what is there now. Ownership must still hold:
    // removal during the await must not fall through to an inherited entry.
    const current = this.ownInstanceConfig(instanceName);
    if (!current) return { error: this.personaEmojiMissing(instanceName) };
    const map = { ...(current.status_emojis ?? {}) } as Record<string, string>;
    if (value) map[status] = value;
    else delete map[status];
    if (Object.keys(map).length) current.status_emojis = map;
    else delete current.status_emojis;
    this.saveFleetConfig();
    this.logger.info({ instanceName, status, value: value ?? null }, value ? "Persona emoji set" : "Persona emoji cleared");
    const resolved = this.resolveStatusEmojisFor(instanceName);
    return { status, value: value ?? null, now: resolved[status], status_emojis: current.status_emojis ?? null };
  }

  /** A ClassicBot instance: it may see (list/preview) emojis, never set a per-instance stamp. */
  private isClassicPersonaTarget(instanceName: string): boolean {
    return this.classicChannels?.getAll().some(c => c.instanceName === instanceName) ?? false;
  }

  private personaEmojiMissing(instanceName: string): string {
    return this.classicChannels?.getAll().some(c => c.instanceName === instanceName)
      ? "ClassicBot instances have no per-instance status emojis; an operator sets the connection's in Settings"
      : `Instance '${instanceName}' not found`;
  }

  /** What the instructions tell `instanceName` not to react with (its own status set). */
  statusEmojiAvoidList(instanceName: string): string[] {
    return statusAvoidList(this.resolveStatusEmojisFor(instanceName));
  }

  /** The progress bubble's leading emoji, in the form the channel renders. */
  private progressPrefixFor(instanceName: string, elapsedMs = 0, minElapsedMs = this.progressMinElapsedMs()): string {
    const r = this.resolveStatusEmojisFor(instanceName);
    const builtin = builtinStatusEmojis(r.platform).progress_prefix;
    // Keep the built-in short/elapsed phases, but resolve their status values
    // too. A custom progress prefix takes precedence in both phases.
    // Telegram's built-in queued reaction is 👀; its elapsed *text* has always
    // used ⏳ (text is not limited to Telegram's reaction vocabulary).
    const queued = r.platform === "telegram" && r.queued === builtinStatusEmojis(r.platform).queued
      ? builtinStatusEmojis(undefined).queued : r.queued;
    const value = r.progress_prefix !== builtin ? r.progress_prefix
      : elapsedMs < minElapsedMs ? r.processing : queued;
    return textForm(r.platform, value);
  }

  /**
   * Is this inbound reaction one of the fleet's own delivery-status stamps?
   * Those are machine indicators and must not reach any instance as a user
   * reaction (#1005 point 3). When every bot's user id is known, the check
   * keys on WHO reacted: a fleet bot's reaction is a status stamp only if it
   * is in that bot's instances' status set (other bot reactions are agent
   * signals and pass), and a human's reaction always passes — whatever emoji
   * a persona picked. Without every id, fall back to the emoji alone.
   */
  isOwnStatusReaction(r: InboundReaction): boolean {
    const key = reactionMatchKey(r.emoji, r.emojiId);
    const worlds = [...this.worlds.values()];
    const names = new Set([
      ...Object.keys(this.fleetConfig?.instances ?? {}),
      ...(this.classicChannels?.getAll?.() ?? []).map(c => c.instanceName),
      ...this.instanceWorldBinding.keys(),
    ]);
    if (worlds.length > 0 && worlds.every(w => !!w.botUserId)) {
      const reactorWorlds = new Set(worlds.filter(w => w.botUserId === r.userId).map(w => w.id));
      if (reactorWorlds.size === 0) return false; // a human, or a bot outside this fleet
      // #1056: what this bot really stamped on this message, whatever its status set says now.
      if ([...reactorWorlds].some(id => this.stampedStatus.get(`${id}:${r.messageId}`)?.has(key))) return true;
      return [...names]
        .filter(n => reactorWorlds.has(this.getInstanceAdapterId(n) ?? ""))
        .some(n => statusMatchKeys(this.resolveStatusEmojisFor(n)).includes(key));
    }
    // Fallback: the built-in ladder (as before #1005) plus every value an
    // operator configured. Not the Telegram built-ins — 👎 is AgEnD's failed
    // stamp there, but also far too common a human reaction to swallow blind.
    if (worlds.some(w => this.stampedStatus.get(`${w.id}:${r.messageId}`)?.has(key))) return true;   // #1056, as above
    const keys = new Set(statusMatchKeys(builtinStatusEmojis(undefined)));
    for (const name of names) {
      const resolved = this.resolveStatusEmojisFor(name);
      const builtin = builtinStatusEmojis(resolved.platform);
      for (const k of STATUS_EMOJI_KEYS) if (resolved[k] !== builtin[k]) keys.add(statusMatchKey(resolved[k]));
    }
    return keys.has(key);
  }

  /**
   * The "received" reaction for paths that react with the inbound message's
   * own adapter rather than through reactMessageStatus (classic bots).
   */
  private receivedReactionFor(instanceName: string, adapter: ChannelAdapter, adapterId?: string): string {
    const resolved = this.resolveStatusEmojisFor(instanceName, adapterId, adapter);
    return reactionForm(resolved.platform, resolved.received);
  }

  private reactClassicReceived(instanceName: string, adapter: ChannelAdapter, msg: InboundMessage): Promise<void> {
    const emoji = this.receivedReactionFor(instanceName, adapter, msg.adapterId);
    // Classic's system receipt is status-owned too. An ordinary react call
    // would label it as an agent/other reaction and suppress later statuses.
    // #1056: recorded as this bot's stamp like the delivery statuses (provenance survives a status-set change) —
    // on Telegram once the adapter took the slot, on Discord before the add (its gateway can echo it first).
    if (adapter instanceof TelegramAdapter) {
      return adapter.reactDeliveryStatus(msg.chatId, msg.messageId, emoji, msg.timestamp.getTime()).then((took) => {
        if (took) this.noteStamped(adapter, msg.messageId, emoji);
      });
    }
    this.noteStamped(adapter, msg.messageId, emoji);
    return adapter.react(msg.threadId ?? msg.chatId, msg.messageId, emoji);
  }

  private reactClassicForwardedAttachment(
    instanceName: string, adapter: ChannelAdapter, msg: InboundMessage, kind: string,
  ): Promise<void> {
    const emoji = this.savedAttachmentReactionFor(instanceName, adapter, msg.adapterId, kind);
    // A forwarded attachment's saved stamp is ours, so later delivery statuses
    // may replace it. The receipt queued first establishes ownership; this
    // stamp cannot bootstrap an unknown slot or replace an agent's reaction.
    if (adapter instanceof TelegramAdapter) {
      return adapter.reactDeliveryStatus(msg.chatId, msg.messageId, emoji).then(() => {});
    }
    return adapter.react(msg.threadId ?? msg.chatId, msg.messageId, emoji);
  }

  /**
   * The stamp for an inbound photo / file a classic bot saved (#1080): the
   * instance's `status_emojis.photo|attachment`, then its connection's, then
   * the built-in (📸/📎, or 👌/👍 on Telegram — what these paths always stamped).
   * Anything else a saved attachment can be counts as a file.
   */
  private savedAttachmentReactionFor(
    instanceName: string, adapter: ChannelAdapter, adapterId: string | undefined, kind: string,
  ): string {
    const resolved = this.resolveStatusEmojisFor(instanceName, adapterId, adapter);
    return reactionForm(resolved.platform, kind === "photo" ? resolved.photo : resolved.attachment);
  }

  reactMessageStatus(
    instanceName: string, chatId: string, messageId: string, status: DeliveryStatus, threadId?: string, receivedAt?: number,
  ): void {
    // A message the web user sent is no message on any platform: there is nothing to react on, and an id
    // like web-… would only fail there. Its ticks are the dashboard's (web track C3).
    if (isWebMessageId(messageId)) { this.reportWebDelivery(instanceName, messageId, status); return; }
    // React via the adapter BOUND to this instance — NOT the first discord world.
    // Otherwise, in a same-channel/same-guild multi-bot setup, the inbound 👀
    // (bound bot) and the delivery/confirm reactions (some other bot) come from
    // different bots, leaving a duplicate 👀 that never turns into ✅.
    const adapter = this.getAdapterForInstance(instanceName) ?? this.adapter;
    if (!adapter) return;
    const resolved = this.resolveStatusEmojisFor(instanceName, undefined, adapter);
    const configured = resolved[status];
    // Unknown statuses stay a no-op. Every resolved Telegram value has been
    // checked against the ReactionTypeEmoji set (status-emojis.ts).
    if (!configured) return;
    const statusEmoji = reactionForm(resolved.platform, configured);
    // Bot-scoped: sibling bots reacting on the same message must not clear
    // each other's state — every removal below targets this adapter's own
    // reactions (@me on Discord, the bot's list on Telegram).
    const adapterId = typeof (adapter as { id?: unknown }).id === "string"
      ? (adapter as unknown as { id: string }).id : "?";
    const key = `${adapterId}:${chatId}:${threadId ?? ""}:${messageId}`;
    this.queueDeliveryStatusReaction(adapter, key, chatId, messageId, statusEmoji, threadId, status, status === "received" ? receivedAt : undefined);
  }

  /** One delivery report for a web user's message: recorded with it, and sent to the pages when it moved. */
  private reportWebDelivery(instanceName: string, messageId: string, status: DeliveryStatus): void {
    if (status !== "queued" && status !== "processing" && status !== "delivered" && status !== "failed") return;
    const m = this.webChatHistory.setDelivery(instanceName, messageId, status);
    if (m) this.emitSseEvent("delivery", { instance: instanceName, messageId, delivery: m.delivery });
  }

  /**
   * Apply a terminal delivery verdict. On Telegram the built-in delivered is
   * 👀 and failed is 👎; Discord shows ✅/❌ — both configurable (#1005).
   */
  finishDeliveryStatus(
    instanceName: string, chatId: string, messageId: string, status: DeliveryStatus, threadId?: string,
  ): void {
    this.reactMessageStatus(instanceName, chatId, messageId, status, threadId);
  }

  private queueDeliveryStatusReaction(
    adapter: ChannelAdapter, key: string, chatId: string, messageId: string, emoji: string | null, threadId?: string,
    status?: DeliveryStatus, receivedAt?: number,
  ): void {
    const prev = this.deliveryStatusChains.get(key) ?? Promise.resolve();
    const run = prev.then(() => this.applyDeliveryStatusReaction(adapter, key, chatId, messageId, emoji, threadId, status, receivedAt));
    this.deliveryStatusChains.set(key, run);
    void run.then(
      () => { if (this.deliveryStatusChains.get(key) === run) this.deliveryStatusChains.delete(key); },
      () => { if (this.deliveryStatusChains.get(key) === run) this.deliveryStatusChains.delete(key); },
    );
  }

  private async applyDeliveryStatusReaction(
    adapter: ChannelAdapter, key: string,
    chatId: string, messageId: string, emoji: string | null, threadId?: string, status?: DeliveryStatus, receivedAt?: number,
  ): Promise<void> {
    try {
      const target = adapter instanceof TelegramAdapter ? chatId : (threadId ?? chatId);
      const last = this.lastStatusEmoji.get(key);
      const prev = last?.emoji;
      if (adapter instanceof TelegramAdapter) {
        // The adapter owns the one-reaction slot and serializes this check
        // with agent react calls. The fleet's last emoji is not ownership.
        if (await adapter.reactDeliveryStatus(chatId, messageId, emoji, receivedAt)) {
          if (emoji == null) this.lastStatusEmoji.delete(key);
          else { this.lastStatusEmoji.set(key, { emoji, status }); this.noteStamped(adapter, messageId, emoji); }
        }
        return;
      }
      if (emoji == null) {
        if (prev && adapter.unreact) {
          await adapter.unreact(target, messageId, prev, threadId);
          this.lastStatusEmoji.delete(key);
        }
        return;
      }
      // Discord adds reactions rather than replacing a single slot.
      if (prev === emoji) return;
      // Thread-aware adapters (Discord) react where the thread is; Telegram
      // addresses the supergroup chat and ignores the thread part.
      // #972: add-only by default — only remove the failed emoji when leaving
      // the failed state. 👀/⏳/✅ stacking together is harmless; leaving ❌
      // visible after a recovery would be misleading. `prev` is the exact
      // form it was added with, so a custom emoji comes off too (#1005).
      if (last?.status === "failed" && adapter.unreact && !(adapter instanceof TelegramAdapter)) {
        // Best effort: a failed removal must not block the new status.
        await adapter.unreact(target, messageId, last.emoji, threadId).catch(e =>
          this.logger.debug({ err: (e as Error).message }, "Delivery status reaction removal failed"));
      }
      // Recorded before the add: Discord can report the reaction back before react() resolves.
      this.noteStamped(adapter, messageId, emoji);
      await adapter.react(target, messageId, emoji, threadId);
      this.lastStatusEmoji.set(key, { emoji, status });
    } catch (e) {
      this.logger.debug({ err: (e as Error).message }, "Message status react failed");
    }
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

  /** Cap both structured runtime logs and service bootstrap diagnostics. */
  private rotateFleetLogs(): void {
    rotateLogIfNeeded(join(this.dataDir, "daemon.log"));
    rotateLogIfNeeded(join(this.dataDir, "fleet.log"));
  }

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

  /** Drop event/activity rows older than the retention window. Best-effort. */
  private pruneEventLog(): void {
    try {
      this.eventLog?.prune(FleetManager.EVENT_LOG_RETENTION_DAYS);
    } catch (err) {
      this.logger.warn({ err }, "Event log prune failed");
    }
  }

  /** #1335: Prune delivery-outbox.db and Task Board in chunked async passes. */
  private async pruneOutboxAndTasks(): Promise<void> {
    const days = this.fleetConfig?.defaults?.retention_days ?? 30;
    // Outbox prune
    const outbox = this.deliveryOutbox;
    if (outbox?.isOpen) {
      try {
        const { pruned, durationMs } = await outbox.prune(days);
        if (pruned > 0) {
          this.logger.info({ pruned, durationMs: Math.round(durationMs) }, "Delivery outbox pruned");
        }
      } catch (err) {
        this.logger.warn({ err }, "Delivery outbox prune failed");
      }
    }
    // Task Board prune
    if (this.scheduler?.db) {
      try {
        const pruned = await this.scheduler.db.pruneOldTasks(days);
        if (pruned > 0) {
          this.logger.info({ pruned }, "Task board pruned");
        }
      } catch (err) {
        this.logger.warn({ err }, "Task board prune failed");
      }
    }
  }

  /**
   * #1335: True when the delivery_id was in the outbox, was pruned by
   * retention, and the caller is the original source or target (#1340 P2 🔒).
   */
  wasDeliveryIdPrunedForCaller(deliveryId: string, callerInstance: string): boolean {
    return this.deliveryOutbox?.wasDeliveryIdPrunedForCaller(deliveryId, callerInstance) ?? false;
  }

  /** How long opening events.db waits for another process's lock (a field so tests need not wait 5 s). */
  private eventLogBusyTimeoutMs = 5000;

  private openEventLog(): EventLog | null {
    const dbPath = join(this.dataDir, "events.db");
    try {
      return new EventLog(dbPath, { busyTimeoutMs: this.eventLogBusyTimeoutMs });
    } catch (err) {
      // #1490: only a file SQLite proved corrupt is moved aside. A lock (it outlasted the busy timeout), a driver that
      // cannot load (ABI), or a permission/I/O problem says nothing against the file: it stays where it is, history
      // intact, and the fleet runs without event logging until it restarts.
      const kind = classifySqliteOpenError(err);
      if (kind !== "corrupt") {
        const key = kind === "busy" ? "eventlog.locked" : kind === "abi" ? "eventlog.abi" : "eventlog.unopenable";
        this.logger.error({ err, dbPath, kind }, `events.db not opened (${kind}) — left in place; continuing without event logging`);
        try { this.notifyFleetError(t(key)); } catch { /* best effort: adapters may not be up yet; the log line stands */ }
        return null;
      }
      this.logger.error({ err, dbPath }, "events.db is corrupt — moving it aside and starting a fresh one");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      for (const suffix of ["", "-wal", "-shm"]) {
        try { renameSync(`${dbPath}${suffix}`, `${dbPath}${suffix}.corrupt-${stamp}`); } catch { /* may not exist */ }
      }
      try {
        return new EventLog(dbPath, { busyTimeoutMs: this.eventLogBusyTimeoutMs });
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
  /**
   * Surface ids that can never match into the operator's General topic.
   *
   * The load-time log is still silence for anyone not reading daemon.log, and a
   * chat that never gets in with nothing said anywhere is exactly the failure
   * this line of work exists to remove. notifyFleetError throttles by message
   * text for 10 minutes and resolves its target from config, so the 30s reload
   * poll cannot flood the topic and a down General does not swallow it.
   */
  private reportClassicUnrecoverableIds(): void {
    const bad = this.classicChannels?.getUnrecoverableIds?.() ?? [];
    if (bad.length === 0) return;
    // notifyFleetError claims its throttle key BEFORE attempting delivery, so
    // calling it with no adapter would silence this message for ten minutes
    // without anyone having seen it. Log and leave the key unspent; a later
    // call, once an adapter exists, still gets through.
    if (!this.adapter && this.adapters.size === 0) {
      this.logger.error({ ids: bad },
        "classicBot.yaml holds ids that can never match — deferring the operator notice until an adapter is up");
      return;
    }
    const list = bad.map(e => `${e.field}: ${e.value}`).join(", ");
    this.logger.error({ ids: bad }, "classicBot.yaml holds ids that can never match");
    this.notifyFleetError(t("classic.unrecoverable_ids", list));
  }

  /**
   * Where a fleet-wide notice can actually be posted, or null if nowhere.
   *
   * On Telegram a group id is itself a chat, so posting straight to it is
   * right. On Discord it is a *guild* id, and sending there makes the adapter
   * fetch a channel that does not exist — DiscordAPIError 10003 Unknown
   * Channel. That is why the daily summary never arrived on a Discord fleet:
   * it had been posting to the guild every night and only the catch handler
   * ever saw it.
   *
   * Discord therefore needs a real channel: the General topic (resolved from
   * config rather than findGeneralInstance, so a fleet-level fault can still be
   * reported while the General daemon is down), else the adapter's configured
   * general_channel_id. With neither, there is no safe target and the caller
   * should say so rather than send into a guaranteed failure.
   */
  private fleetNoticeTarget(adapterId?: string): { chatId: string; opts: import("./channel/types.js").SendOpts } | null {
    const cfg = this.getChannelConfig(adapterId);
    const groupId = cfg?.group_id;
    if (groupId == null) return null;
    const chatId = String(groupId);

    // The General must belong to the SAME adapter as the group above. Taking
    // whichever General comes first in the instance map produced a mixed target
    // on a dual-platform fleet — a Telegram group id carrying a Discord channel
    // as its thread — and made the result depend on map insertion order.
    // Resolved from config, not from a live daemon, so a fleet-level fault is
    // still reportable while the General itself is down.
    const ownerId = cfg?.id ?? cfg?.type;
    const generalTopic = Object.entries(this.fleetConfig?.instances ?? {})
      .find(([name, instance]) => instance.general_topic === true
        && this.getInstanceAdapterId(name) === ownerId)?.[1]?.topic_id;
    if (generalTopic != null) return { chatId, opts: { threadId: String(generalTopic) } };

    if (cfg?.type === "discord") {
      const configured = cfg.options?.general_channel_id;
      if (configured != null && String(configured)) {
        return { chatId, opts: { threadId: String(configured) } };
      }
      return null;   // a guild id is not a channel; sending would always fail
    }
    return { chatId, opts: {} };
  }

  /**
   * Post the daily summary where fleet-wide notices go.
   *
   * A named method rather than an inline closure so a test can drive the real
   * thing: asserting on fleetNoticeTarget alone leaves the call site free to go
   * back to posting at the bare group id, which is the defect this replaced.
   */
  private postDailySummary(text: string): void {
    const target = this.fleetNoticeTarget();
    if (!this.adapter || !target) {
      this.logger.warn("Daily summary has no postable target — set a General topic or channel.options.general_channel_id");
      return;
    }
    this.adapter.sendText(target.chatId, text, target.opts)
      .catch(e => this.logger.warn({ err: e }, "Failed to send daily summary"));
  }

  /**
   * Returns whether the notice was dispatched. `throttle: false` is for a
   * caller that does its own de-duplication (one notice per failure streak):
   * the shared 10-minute text throttle would otherwise swallow the next
   * streak's notice, and it is neither consulted nor recorded.
   */
  notifyFleetError(text: string, opts: { throttle?: boolean } = {}): boolean {
    const throttled = opts.throttle !== false;
    const now = Date.now();
    const key = text.slice(0, 200);
    const seen = throttled ? this.fleetErrorNotices.get(key) : undefined;
    if (seen && now - seen.at < FleetManager.FLEET_ERROR_THROTTLE_MS) {
      seen.suppressed++;
      return false;
    }
    const suppressed = seen?.suppressed ?? 0;
    const body = suppressed > 0
      ? `${text}\n${t("fleet.error_suppressed", suppressed, Math.round(FleetManager.FLEET_ERROR_THROTTLE_MS / 60_000))}`
      : text;

    // Resolved from config, NOT findGeneralInstance(): that requires a live daemon,
    // and a fleet-level fault is exactly when the General may be down. The topic
    // itself still exists, and notifyInstanceTopic only needs adapter + group +
    // topic_id to post into it.
    const general = Object.entries(this.fleetConfig?.instances ?? {})
      .find(([, config]) => config.general_topic === true)?.[0];

    // "dispatched", not "delivered": see notifyInstanceTopic. A platform that
    // rejects the message afterwards still consumes the throttle window, which
    // is the pre-existing semantic and not something this change alters.
    let dispatched = false;
    if (general) {
      dispatched = this.notifyInstanceTopic(general, body);
    } else {
      // No General instance — fall back to the primary channel's own notice
      // target. Posting to the bare group id looked right but is a guild id on
      // Discord, so every such fallback failed inside the catch handler.
      const target = this.fleetNoticeTarget();
      if (this.adapter && target) {
        this.adapter.sendText(target.chatId, body, target.opts)
          .catch(err => this.logger.warn({ err }, "Failed to send fleet error notification"));
        dispatched = true;
      }
    }

    if (!dispatched) {
      // Do NOT record the throttle key. It used to be claimed before delivery
      // was attempted, so a message nobody could receive — every fleet error
      // raised before adapters exist, which is when startup faults happen —
      // also suppressed the next ten minutes of identical ones. Leaving the key
      // unspent lets the next caller, once an adapter is up, actually get
      // through. The counter is not reset either: nothing was shown.
      this.logger.warn({ text: body },
        "Fleet error could not be delivered (no adapter or no target yet) — not consuming the throttle window");
      return false;
    }

    if (!throttled) return true;
    this.fleetErrorNotices.set(key, { at: now, suppressed: 0 });
    // Bound the map: it is keyed by message text, and a message with a varying
    // suffix (a path, an id) would otherwise grow it without limit.
    if (this.fleetErrorNotices.size > 100) {
      const oldest = this.fleetErrorNotices.keys().next().value;
      if (oldest !== undefined) this.fleetErrorNotices.delete(oldest);
    }
    return true;
  }

  private static readonly FLEET_ERROR_THROTTLE_MS = 10 * 60_000;
  private fleetErrorNotices = new Map<string, { at: number; suppressed: number }>();

  /**
   * Post into an instance's topic. Returns whether a send was DISPATCHED — a
   * target was resolved and sendText was called — so a caller that must not
   * lose the message (notifyFleetError, which spends a throttle key) can tell
   * that from silence. Existing callers ignore the result and are unaffected.
   *
   * Not a delivery guarantee: sendText is fire-and-forget, and a platform-side
   * rejection surfaces only as a warn in its .catch. True delivery confirmation
   * would have to make this async and change every caller.
   */
  notifyInstanceTopic(instanceName: string, text: string, extraOpts?: import("./channel/types.js").SendOpts): boolean {
    const adapter = this.getAdapterForInstance(instanceName) ?? this.adapter;
    if (!adapter) {
      // Early startup: adapters are created well after the fleet object exists.
      this.logger.warn({ instanceName }, "No adapter yet — instance topic notification not sent");
      return false;
    }
    const channelCfg = this.getChannelConfig(this.getInstanceAdapterId(instanceName));
    const groupId = channelCfg?.group_id;

    // Fleet topic instance
    const threadId = this.fleetConfig?.instances[instanceName]?.topic_id;
    if (threadId != null && groupId) {
      adapter.sendText(String(groupId), text, { threadId: String(threadId), ...extraOpts })
        .catch(e => this.logger.warn({ err: e, instanceName }, "Failed to send instance topic notification"));
      return true;
    }

    // Classic instance: find its channelId from the classic manager
    const classicChatId = this.classicChannels?.getChannelIdByInstance(instanceName);
    if (classicChatId) {
      adapter.sendText(classicChatId, text, extraOpts)
        .catch(e => this.logger.warn({ err: e, instanceName }, "Failed to send classic notification"));
      return true;
    }

    // Fallback: the instance has neither a topic nor a classic channel, so post
    // where fleet-wide notices go. Not the bare group id: on Discord that is a
    // guild, and the send fails inside the catch handler.
    const target = this.fleetNoticeTarget(this.getInstanceAdapterId(instanceName));
    if (target) {
      adapter.sendText(target.chatId, text, { ...target.opts, ...extraOpts })
        .catch(e => this.logger.warn({ err: e, instanceName }, "Failed to send notification (no topic)"));
      return true;
    }
    this.logger.warn({ instanceName }, "No postable target — instance topic notification not sent");
    return false;
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
  /** postNonceButtonPromptOrThrow, logging a failure and returning null instead. */
  private async postNonceButtonPrompt(opts: Parameters<FleetManager["postNonceButtonPromptOrThrow"]>[0]): Promise<string | null> {
    try {
      return await this.postNonceButtonPromptOrThrow(opts);
    } catch (err) {
      this.logger.warn({ err, instanceName: opts.instanceName, prefix: opts.prefix },
        "Failed to send button prompt");
      return null;
    }
  }

  /**
   * Post a nonce-armed button prompt; throws (with the nonce disarmed) when it
   * cannot be posted, so a caller that told the user "buttons posted" can
   * tell them the truth instead (#1133).
   */
  private async postNonceButtonPromptOrThrow(opts: {
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
    deliver?: (choices: Choice[]) => Promise<PrivateSentMessage>;
    extra?: Pick<NonceButtonEntry, "pendingChangeId" | "confirmationCurrent" | "requesterUserId" | "publicExposureId" | "dashboardOwner" | "generalName" | "promptKind" | "authChannelId" | "allowAnyUser" | "tipId" | "classicGroupId" | "classicUserId" | "classicScope" | "classicReplyTo" | "assistFor">;
    timeoutMs?: number;
  }): Promise<string> {
    // 16 bytes = the 128-bit capability the design claims. Telegram's 64-byte
    // callback_data cap still holds, with two prefixes tied at the longest:
    // "interactive-assist:" (19) + 32 hex + ":confirm" (8) = 59, and
    // "install-select:" (15) + 32 hex + ":" + the longest backend name
    // ("claude-code"/"antigravity", 11) = 59. The longest overall is
    // "classic-approve:" (16) + 32 hex + ":allow-admin" (12) = 60, leaving 4
    // bytes. A longer prefix or action would be silently rejected by Telegram —
    // both sets are pinned by callback_data assertions in
    // install-backend-menu.test.ts and classic-approve-buttons.test.ts.
    const nonce = randomBytes(16).toString("hex");
    const entry: NonceButtonEntry = {
      nonce,
      prefix: opts.prefix,
      instanceName: opts.instanceName,
      adapterId: opts.adapterId,
      adapter: opts.adapter,
      chatId: opts.chatId,
      threadId: opts.threadId,
      expiredText: opts.expiredText,
      createdAt: Date.now(),
      ...opts.extra,
    };
    entry.timer = setTimeout(() => {
      const pending = this.pendingNonceButtons.get(nonce);
      if (pending !== entry) return;
      this.pendingNonceButtons.delete(nonce);
      this.webPromptGone(entry, entry.expiredText);
      this.collapseNoncePrompt(entry)?.catch(err => this.logger.debug({ err, instanceName: entry.instanceName, prefix: entry.prefix },
        "Failed to expire button prompt"));
    }, opts.timeoutMs ?? NONCE_BUTTON_TIMEOUT_MS);
    entry.timer.unref?.();
    this.pendingNonceButtons.set(nonce, entry);

    try {
      const choices = opts.choices.map(c => ({ id: `${opts.prefix}${nonce}:${c.action}`, label: c.label }));
      const sent: PrivateSentMessage = opts.deliver ? await opts.deliver(choices) : await opts.adapter.notifyAlert(opts.chatId, {
        type: opts.alertType,
        instanceName: opts.instanceName,
        message: opts.message,
        choices,
      }, opts.threadId ? { threadId: opts.threadId } : undefined);
      // Bind the nonce to the provider's canonical delivery address, not the
      // logical routing input. Telegram, for example, represents General as
      // AgEnD topic "1" on input but omits message_thread_id on the wire and in
      // callback queries. Exact callback matching below remains fail-closed.
      entry.chatId = sent.chatId;
      // Preserve compatibility with adapters that predate SentMessage.threadId
      // and omit the optional property altogether. An explicit undefined is a
      // canonical flat/root delivery context (notably Telegram General).
      if (Object.prototype.hasOwnProperty.call(sent, "threadId")) {
        entry.threadId = sent.threadId;
      }
      entry.messageId = sent.messageId;
      if (sent.retire) entry.retire = sent.retire;
      // Offered on the dashboard only once it is live on the platform (a failed post is disarmed above),
      // and only if nothing claimed or expired it meanwhile.
      if (WEB_MIRRORED_PROMPT_PREFIXES.has(opts.prefix) && this.pendingNonceButtons.get(nonce) === entry) {
        entry.web = {
          text: opts.message,
          actions: opts.choices.map(c => ({ id: c.action, label: c.label })),
          expiresAt: Date.now() + (opts.timeoutMs ?? NONCE_BUTTON_TIMEOUT_MS),
        };
        this.emitSseEvent("prompt", { instance: entry.instanceName, nonce, ...entry.web });
      }
      return nonce;
    } catch (err) {
      this.pendingNonceButtons.delete(nonce);
      if (entry.timer) clearTimeout(entry.timer);
      throw err;
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
      // The clicker always hears why nothing happens (#1133); collapsing the
      // dead buttons is a courtesy that can fail (>48h on Telegram, message gone).
      data.ack?.(t("buttons.stale_notice"));
      const collapseFailed = (err: unknown) => this.logger.info({ err: (err as Error)?.message, prefix },
        "Could not collapse an expired prompt's buttons");
      if (staleHandling?.keepText && adapter?.removeMessageButtons) {
        adapter.removeMessageButtons(data.chatId, data.messageId, data.threadId).catch(collapseFailed);
      } else if (data.editClicked) {
        data.editClicked(t("buttons.stale")).catch(collapseFailed);
      } else {
        adapter?.editMessageRemoveButtons?.(
          data.chatId,
          data.messageId,
          t("buttons.stale"),
          data.threadId,
        ).catch(collapseFailed);
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
    // A dashboard click carries the full-fleet web session (checked by the web gate before it got here),
    // and is good only for a prompt that was offered on the dashboard.
    const fromWeb = this.webPromptClicks.has(data);
    const isAuthorized = fromWeb
      ? pending.web !== undefined
      : data.userId
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
    if (pending.requesterUserId && pending.requesterUserId !== data.userId) mismatchedFields.push("requester");
    if (mismatchedFields.length > 0) {
      // Deliberately does NOT consume the nonce: the real admin can still click.
      this.logger.warn({
        instanceName: pending.instanceName,
        prefix,
        userId: data.userId,
        mismatchedFields: mismatchedFields.join(","),
      }, "Rejected unauthorized or mismatched button callback");
      data.ack?.(t(isAuthorized ? "buttons.wrong_place" : "buttons.admin_only"));
      return "consumed";
    }

    data.ack?.();
    // Claim before any await: double clicks and duplicate callback delivery
    // can never act twice for state-changing actions.
    this.pendingNonceButtons.delete(match[1]);
    if (pending.timer) clearTimeout(pending.timer);
    if (fromWeb) this.webPromptClaims.add(data);
    // The dashboard's copy goes now; the outcome line follows from retireNonceButtons.
    this.webPromptGone(pending);
    return { entry: pending, action: match[2] };
  }

  /** Collapse a consumed prompt's buttons into a final status line. */
  /**
   * One button click from an adapter (#1133). Every click is acknowledged
   * once the fleet has decided — Telegram keeps a spinner until it is, and a
   * refused click acknowledges with a notice of its own (consumeNonceCallback) —
   * and a click nothing acts on is logged rather than vanishing.
   */
  private async receiveAdapterCallback(
    data: AdapterCallbackData,
    adapterId: string,
    adapter: ChannelAdapter | undefined,
    isCurrentAdapter: () => boolean,
  ): Promise<void> {
    try {
      if (!isCurrentAdapter()) {
        this.logger.info({ adapterId, prefix: callbackPrefix(data.callbackData) },
          "Button click from a replaced adapter ignored");
        return;
      }
      if (!await this.dispatchAdapterCallback(data, adapterId, adapter)) {
        this.logger.info({ adapterId, prefix: callbackPrefix(data.callbackData) },
          "Button click not handled by the fleet (adapter-level prompt or unknown button)");
      }
    } finally {
      data.ack?.();
    }
  }

  /**
   * A button from a prompt kind that no longer exists (#1131: `/install-cli`'s
   * picker and its "sign in now?" prompt; #1139: the relay login's provider picker). Still on screen after an upgrade;
   * a click gets the expired-prompt treatment — a private notice, the buttons
   * collapsed — instead of nothing.
   */
  private handleRetiredPromptButton(data: AdapterCallbackData, adapterId: string, adapter: ChannelAdapter | undefined): boolean {
    for (const prefix of RETIRED_PROMPT_PREFIXES) {
      if (this.consumeNonceCallback(prefix, NEVER_MATCHES, data, adapterId, adapter) !== null) return true;
    }
    return false;
  }

  /** Routes a click to the handler that owns its prefix; false when none does. */
  private async dispatchAdapterCallback(
    data: AdapterCallbackData,
    adapterId: string,
    adapter: ChannelAdapter | undefined,
  ): Promise<boolean> {
    if (data.callbackData.startsWith(REPLY_BUTTON_PREFIX)) {                       // #1266
      const buttons = this.replyButtons();
      if (!buttons) { data.ack?.(t("reply_buttons.closed")); return true; }
      return buttons.handleCallback(data, adapterId);
    }
    if (this.needsYou?.handleCallback(data, adapterId)) return true;
    if (await this.handleTipDismiss(data, adapterId, adapter)) return true;
    if (await this.handleTipUnlock(data, adapterId, adapter)) return true;
    if (await this.handleLoginBackendSelect(data, adapterId, adapter)) return true;
    if (await this.handleSettingsChangeCallback(data, adapterId, adapter)) return true;
    if (await this.handleDashboardCallback(data, adapterId, adapter)) return true;
    if (await this.handleClassicApproval(data, adapterId, adapter)) return true;
    if (this.handleRetiredPromptButton(data, adapterId, adapter)) return true;
    if (await this.handleLoginConfirm(data, adapterId, adapter)) return true;
    if (await this.handleLoginTokenResend(data, adapterId, adapter)) return true;
    if (await this.handleClearConfirmation(data, adapterId, adapter)) return true;
    if (await this.handleExitRestartPrompt(data, adapterId, adapter)) return true;
    if (await this.handleInteractivePromptAssist(data, adapterId, adapter)) return true;
    if (await this.handleClassicBackendSelection(data)) return true;
    if (await this.handleModelSelection(data, adapterId)) return true;
    if (await this.handleEffortSelection(data, adapterId)) return true;
    if (await this.handleHangPrompt(data, adapterId, adapter)) return true;
    if (data.callbackData.startsWith("cancel:")) {
      this.handleCancelClick(data.callbackData.slice("cancel:".length), adapter ?? null, data, adapterId);
      return true;
    }
    return false;
  }

  /**
   * A prompt the dashboard was offered is no longer open (answered on either surface, expired, or its
   * instance stopped): every page drops its buttons, and shows `outcome` when there is one.
   */
  private webPromptGone(entry: NonceButtonEntry, outcome?: string): void {
    if (!entry.web || !entry.nonce) return;
    this.emitSseEvent("prompt_resolved", { instance: entry.instanceName, nonce: entry.nonce, ...(outcome ? { outcome } : {}) });
  }

  // ── #1386 "Needs you" ─────────────────────────────────────────────────────────────────────────────────

  /** The interaction wait an instance is in now, as a comparable key: which daemon/spawn owns it, and its episode. */
  private interactionWaitKey(name: string): { owner: string | null; episode: number | null } {
    const snapshot = this.getInstanceInteraction(name);
    if (!snapshot) return { owner: null, episode: null };
    const o = snapshot.owner;
    return { owner: o ? `${o.bootId}:${o.spawnGeneration}:${o.launchAttempt}:${o.launchFenceEpoch}` : null, episode: snapshot.episode };
  }

  /** An instance's interaction observation, pause or wake changed (relayed by the lifecycle): recompute now, not at the tick. */
  onAttentionChanged(name: string): void {
    this.needsPauseCache.delete(name);
    this.needsYou?.poke();
  }

  /** The list for the web: every world's items, and those of instances with no world (#1386 §5.0). */
  needsYouItems(): WebNeedsItem[] {
    return this.needsYou?.webItems() ?? [];
  }

  /**
   * #1389: the org chart's structure for the web — the instances the dashboard lists (getUiStatus's names), General,
   * fleet.yaml's teams, each instance's description and thread link. Read on demand; the live state rides the stream.
   */
  orgChart(): OrgChart {
    const config = this.fleetConfig;
    const fleetNames = Object.keys(config?.instances ?? {});
    const classic = new Map((this.classicChannels?.getAll() ?? []).filter(ch => !fleetNames.includes(ch.instanceName)).map(ch => [ch.instanceName, ch]));
    return buildOrgChart({
      names: [...fleetNames, ...classic.keys()],
      instances: Object.fromEntries([
        ...fleetNames.map(name => [name, config?.instances[name]] as const),
        ...[...classic].map(([name, ch]) => [name, { description: ch.description }] as const),
      ]),
      teams: config?.teams,
      isGeneral: name => !classic.has(name) && isGeneralInstance(config, name),
      isClassic: name => classic.has(name),
      place: name => {
        const world = this.worlds.get(this.getInstanceAdapterId(name) ?? "");
        return world ? { type: world.type, ...(world.groupId ? { groupId: world.groupId } : {}) } : undefined;
      },
      // fleet.yaml's topic only. A ClassicBot room has none here, so no link: its channel may sit in any allowed
      // guild, not necessarily its world's group.
      topic: name => {
        const topic = config?.instances[name]?.topic_id;
        return topic != null ? String(topic) : undefined;
      },
    });
  }

  private cacheService: CacheService | null = null;
  /**
   * #1468: the prompt-cache expiry analysis for the web, per instance, over `window`. Read from each instance's
   * ledger as it is now; the first request starts the bounded, persisted catch-up over the transcripts
   * (cache-service.ts) — never a vendor call, never a synchronous transcript read.
   */
  cacheReport(window: string): Promise<CacheReport> {
    const w: CacheWindow = Object.prototype.hasOwnProperty.call(WINDOWS, window) ? window as CacheWindow : "7d";
    this.cacheService ??= new CacheService({
      // fleet.yaml's instances, then the ClassicBot rooms (their workspace under the AgEnD home, their own backend).
      instances: () => {
        const fleet = Object.entries(this.fleetConfig?.instances ?? {}).map(([name, cfg]) => ({
          name, backend: this.backendNameOf(name), workingDirectory: cfg.working_directory, ledgerPath: join(this.getInstanceDir(name), "cache-ledger.json"),
        }));
        const taken = new Set(fleet.map(i => i.name));
        const classic = (this.classicChannels?.getAll() ?? []).filter(ch => !taken.has(ch.instanceName)).map(ch => ({
          name: ch.instanceName,
          backend: this.classicChannels?.getBackendByInstance(ch.instanceName, this.fleetConfig?.defaults?.backend) ?? this.fleetConfig?.defaults?.backend ?? "claude-code",
          workingDirectory: join(getAgendHome(), "workspaces", ch.instanceName),
          ledgerPath: join(this.getInstanceDir(ch.instanceName), "cache-ledger.json"),
        }));
        return [...fleet, ...new Map(classic.map(c => [c.name, c])).values()];
      },
      claudeProjectsDir: () => join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), "projects"),
      claudeKey: claudeProjectKey,
      codexSessionsDir: () => join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "sessions"),
      listRollouts: root => sharedRolloutIndex(root).list(),
      metaPath: join(this.dataDir, "cache-codex-rollouts.json"),
      log: (level, msg, extra) => this.logger[level](extra ?? {}, msg),
    });
    return this.cacheService.report(w);
  }

  /** The web's Acknowledge (any item; a signed-in session is fleet-admin level). */
  acknowledgeNeedsItem(id: string, principal: string): { status: 200 | 400 | 404 | 409 | 500; message: string } {
    if (!this.needsYou) return { status: 409, message: t("needs.ack_already") };
    return this.needsYou.webAcknowledge(id, principal);
  }

  private needsYouInstances(): InstanceInput[] {
    const names = new Set<string>(Object.keys(this.fleetConfig?.instances ?? {}));
    for (const ch of this.classicChannels?.getAll() ?? []) names.add(ch.instanceName);
    const out: InstanceInput[] = [];
    for (const name of names) {
      // Crashed only by the authoritative reconciliation: a daemon that recovered while its "running" IPC event was
      // missed is running (getInstanceStatus clears the stale cache — before the presentation below reads it). Every
      // observation that is not crashed forgets the crash time, so a later crash is a new item (#1398 review).
      const crashed = this.instanceProcessStatus.get(name) === "crashed" && this.getInstanceStatus(name) === "crashed";
      if (crashed) { if (!this.needsCrashedAt.has(name)) this.needsCrashedAt.set(name, Date.now()); }
      else this.needsCrashedAt.delete(name);
      const p = this.instancePresentation(name);
      const wait = p.interaction ? this.interactionWaitKey(name) : null;
      let pauseReason: string | null = null, pausedAt: number | null = null;
      if (this.lifecycle.isPaused(name)) {
        const now = performance.now();
        let cached = this.needsPauseCache.get(name);
        if (!cached || now - cached.readAt >= NEEDS_PAUSE_TTL_MS) {
          const dir = this.getInstanceDir(name);
          cached = { reason: readPauseReason(dir), pausedAt: readPausedAt(dir), readAt: now };
          this.needsPauseCache.set(name, cached);
        }
        ({ reason: pauseReason, pausedAt } = cached);
      } else {
        this.needsPauseCache.delete(name);
      }
      out.push({
        name, state: p.state ?? undefined,
        interaction: p.interaction ? { kind: p.interaction.kind, owner: wait?.owner ?? null, episode: p.interaction.episode, since: p.interaction.since } : null,
        interactionSummary: p.interaction_summary ?? null,
        pauseReason, pausedAt,
        crashedAt: crashed ? (this.needsCrashedAt.get(name) ?? null) : null,
      });
    }
    return out;
  }

  private needsYouPrompts(): PromptInput[] {
    const out: PromptInput[] = [];
    for (const [nonce, e] of this.pendingNonceButtons) {
      if (!e.web || !WEB_MIRRORED_PROMPT_PREFIXES.has(e.prefix)) continue;
      out.push({
        nonce, prefix: e.prefix, instance: e.instanceName, text: e.web.text, actions: e.web.actions,
        createdAt: e.createdAt ?? Date.now(), adapterId: e.adapterId, chatId: e.chatId,
        ...(e.threadId !== undefined ? { threadId: e.threadId } : {}), ...(e.messageId ? { messageId: e.messageId } : {}),
        ...(e.assistFor ? { assistFor: e.assistFor } : {}),
      });
    }
    return out;
  }

  /**
   * Shutdown: detach the hub first — nothing reaches it from here on, and the next startAll (finishStartup) builds a
   * fresh one; the old one's late ACKs are fenced by its own stop (#1398 review) — then let it retire its live
   * messages, bounded so a platform that does not answer cannot hold the shutdown.
   */
  private stopNeedsYou(): Promise<void> | undefined {
    const hub = this.needsYou;
    this.needsYou = null;
    if (!hub) return undefined;
    return Promise.race([hub.stop(), new Promise<void>(resolve => setTimeout(resolve, 5_000).unref?.())]);
  }

  private startNeedsYou(): void {
    if (this.needsYou) return;
    const ownerOf = (instance: string): string | undefined => {
      const owner = this.getInstanceAdapterId(instance);
      return owner !== undefined && this.worlds.has(owner) ? owner : undefined;
    };
    this.needsYou = new NeedsYouHub({
      dataDir: this.dataDir,
      now: () => Date.now(),
      mono: () => performance.now(),
      setTimer: (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; },
      clearTimer: h => clearTimeout(h as ReturnType<typeof setTimeout>),
      prompts: () => this.needsYouPrompts(),
      instances: () => this.needsYouInstances(),
      deliveries: since => (this.deliveryOutbox?.isOpen ? this.deliveryOutbox.needsAttention(since) : []).map(d => ({
        deliveryId: d.deliveryId, state: d.state, source: d.sourceInstance, target: d.targetInstance, kind: d.kind,
        finishedAt: Date.parse(d.finishedAt) || 0,
      })),
      ownerOf,
      worlds: () => [...this.worlds.values()].map((w): NeedsYouWorld => ({
        id: w.id, adapter: w.adapter, place: { type: w.type, ...(w.groupId ? { groupId: w.groupId } : {}) },
      })),
      noticeTarget: world => {
        const target = this.fleetNoticeTarget(world);
        return target ? { chatId: target.chatId, ...(target.opts.threadId !== undefined ? { threadId: String(target.opts.threadId) } : {}) } : null;
      },
      instanceTopic: instance => {
        const topic = this.fleetConfig?.instances[instance]?.topic_id;
        if (topic != null) return String(topic);
        return this.classicChannels?.getChannelIdByInstance(instance) ?? undefined;
      },
      isFleetAdmin: (userId, world) => this.isFleetAdmin(userId, world),
      fleetAdmins: world => (this.getChannelConfig(world)?.access?.allowed_users ?? []).map(String),
      emitSse: (event, data) => this.emitSseEvent(event, data),
      acknowledge: (deliveryId, by) => {
        if (!this.deliveryOutbox?.isOpen) throw new Error("the delivery outbox is not open");
        return this.deliveryOutbox.acknowledge(deliveryId, by);
      },
      settings: () => ({
        liveMessage: this.fleetConfig?.needs_you?.live_message !== false,
        dm: this.fleetConfig?.needs_you?.dm === true,
      }),
      stopping: () => this.shuttingDown,
      t: (key, ...args) => t(key, ...args),
      log: (level, message, extra) => this.logger[level](extra ?? {}, message),
    });
    this.needsYou.start();
  }

  /** The prompts open on the dashboard right now (a page that loads after one was posted asks for them). */
  listWebPrompts(): Array<{ instance: string; nonce: string; text: string; actions: Array<{ id: string; label: string }>; expiresAt: number }> {
    const open: ReturnType<FleetManager["listWebPrompts"]> = [];
    for (const [nonce, e] of this.pendingNonceButtons) {
      if (e.web) open.push({ instance: e.instanceName, nonce, ...e.web });
    }
    return open;
  }

  /**
   * A click on a prompt in the web dashboard (web track C4). It is the platform click, made by the
   * dashboard: the same handler, the same single claim (whoever answers first — here or on Telegram —
   * wins), and the platform's buttons collapse to the outcome exactly as for a click there.
   *
   * The caller has passed the /ui gate (session, same origin, CSRF). Here: the prompt must be one offered
   * on the dashboard, about the instance the page named, and the action one of its own buttons.
   */
  /** #1266: a click on a reply's button in the web chat (the /ui gate is passed: a session, or the public link). */
  clickWebReplyButton(instance: string, id: string, index: number): Promise<{ status: 200 | 400 | 403 | 409; error?: string }> {
    const buttons = this.replyButtons();
    return buttons ? buttons.clickWeb(instance, id, index) : Promise.resolve({ status: 409, error: t("reply_buttons.closed") });
  }

  async clickWebPrompt(instance: string, nonce: string, action: string): Promise<{ status: 200 | 400 | 403 | 409; error?: string; outcome?: string }> {
    if (!/^[0-9a-f]{32}$/.test(nonce) || !/^[a-z][a-z-]{0,23}$/.test(action)) return { status: 400, error: "Malformed prompt answer" };
    const entry = this.pendingNonceButtons.get(nonce);
    // Unknown is the same answer as answered or expired: the page drops the buttons either way.
    if (!entry || !entry.web) return { status: 409, error: "This prompt is no longer open" };
    if (entry.instanceName !== instance) return { status: 403, error: "This prompt belongs to another instance" };
    if (!entry.web.actions.some(a => a.id === action)) return { status: 400, error: "Not one of this prompt's answers" };
    let notice: string | undefined;
    const data: AdapterCallbackData = {
      callbackData: `${entry.prefix}${nonce}:${action}`,
      // The exact place the prompt lives, so the platform-side binding checks hold as for a click there.
      chatId: entry.chatId,
      threadId: entry.threadId,
      messageId: entry.messageId ?? "",
      userId: "web-user",
      ack: n => { if (notice === undefined && n) notice = n; },
    };
    this.webPromptClicks.add(data);
    await this.dispatchAdapterCallback(data, entry.adapterId, entry.adapter);
    if (this.webPromptClaims.has(data)) return { status: 200 };
    return { status: 409, error: notice ?? "This prompt is no longer open" };
  }

  private async retireNonceButtons(
    pending: NonceButtonEntry,
    messageId: string,
    text: string,
    /** The click's own edit of a private prompt (AdapterCallbackData.editClicked); preferred over the prompt's. */
    editClicked?: (text: string) => Promise<void>,
  ): Promise<void> {
    this.webPromptGone(pending, text);
    try {
      const retire = editClicked ?? pending.retire;
      if (retire) { await retire(text); return; }
      if (!pending.adapter.editMessageRemoveButtons) throw new Error("adapter cannot remove prompt buttons");
      await pending.adapter.editMessageRemoveButtons(
        pending.chatId,
        messageId,
        text,
        pending.threadId,
      );
    } catch (err) {
      // The action was already atomically consumed. An edit failure must not
      // undo that or make the button actionable again — but the edit is the
      // only place some outcomes are told (cancel, later, a resend's result),
      // so the text goes out as a message instead (#1133).
      this.logger.warn({ err, instanceName: pending.instanceName }, "Failed to retire prompt buttons; posting the outcome instead");
      await pending.adapter.sendText(pending.chatId, text, { threadId: pending.threadId })
        .catch(sendErr => this.logger.warn({ err: sendErr, instanceName: pending.instanceName }, "Could not post a prompt's outcome"));
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
      // No allowAnyUser: unlocking changes a persistent setting, which typed and slash `/tips advanced on` reserve for a
      // fleet admin (#754 audit) — the default nonce check (fleet admin of the clicking adapter) applies.
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

  /**
   * What a confirmed /clear must still find when it acts — shared by the platform's Confirm button and the web
   * (#1269): the same daemon and IPC client, the same interaction owner, lifecycle epoch and delivery epoch as when the
   * fence was taken. Null when there is no owner to pin (then nothing may be cleared). The reads are cached and
   * synchronous; they never probe the pane.
   */
  private clearTargetFence(instanceName: string): (() => boolean) | null {
    const ipc = this.instanceIpcClients.get(instanceName);
    const daemon = this.daemons.get(instanceName);
    const epoch = this.getDeliveryEpoch(instanceName);
    // Object identity survives a resident daemon's respawn/freeze, and stop
    // invalidates its lifecycle epoch before the queued work replaces objects.
    const readOwner = (): InteractionOwner | null => {
      try {
        const owner = daemon?.getInteractionSnapshot?.()?.owner;
        if (!owner || typeof owner.bootId !== "string" || !owner.bootId
          || ![owner.spawnGeneration, owner.launchAttempt, owner.launchFenceEpoch]
            .every(n => Number.isSafeInteger(n) && n >= 0)) return null;
        return { ...owner };
      } catch { return null; }
    };
    const readLifecycleEpoch = (): number | null => {
      try {
        const value = this.lifecycle?.epochOf(instanceName);
        return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
      } catch { return null; }
    };
    const owner = readOwner(), lifecycleEpoch = readLifecycleEpoch();
    if (owner === null || lifecycleEpoch === null) return null;
    return () => {
      try {
        const currentOwner = readOwner();
        return this.daemons.get(instanceName) === daemon
          && this.instanceIpcClients.get(instanceName) === ipc
          && currentOwner !== null && sameInteractionOwner(owner, currentOwner)
          && readLifecycleEpoch() === lifecycleEpoch
          && this.isDeliveryEpochCurrent(instanceName, epoch);
      } catch { return false; }
    };
  }

  /** #1269: the web's /clear confirmations — one token per question, used once, for the instance as it was asked about. */
  private readonly webClearTokens = new Map<string, { instance: string; fence: () => boolean; deadline: number }>();

  /** #1269: an instance's chat command from the web chat (web-commands.ts); `publicLink`: a gateway request. */
  webCommand(input: { instance: string; command: string; args?: string; confirm?: string }, opts: { publicLink: boolean }): Promise<WebCommandResult> {
    const webMeta = (instance: string) => {
      const topicId = this.fleetConfig?.instances[instance]?.topic_id;
      return {
        chatId: this.getGroupIdForInstance(instance) || "", messageId: newWebMessageId(), username: "web-user", userId: "web-user",
        threadId: topicId != null ? String(topicId) : undefined, adapterId: this.getAdapterForInstance(instance)?.id ?? "", source: "web" as const,
      };
    };
    const choicesFromCache = (instance: string): WebChoices | null => {
      const cached = this.readCliEnv(this.backendNameForInstance(instance));     // the cached catalog only: never a probe here
      if (!cached?.models.length) return null;
      const current = this.resolveInstanceModel(instance).model;
      return { current, options: cached.models.map(o => ({ id: o.id, label: this.modelChoiceLabel(o, current) })) };
    };
    return runWebCommand({
      // Own entries only: a name like "__proto__" or "constructor" must not be found on the prototype (#1476 review).
      scope: (instance) => {
        const instances = this.fleetConfig?.instances;
        if (instances && Object.prototype.hasOwnProperty.call(instances, instance)) return isGeneralInstance(this.fleetConfig, instance) ? "general" : "fleet";
        return this.classicChannels?.getChannelIdByInstance(instance) !== undefined ? "classic" : null;
      },
      ctx: (instance) => this.topicCommands.getCtxText(instance),
      compact: (instance, instructions) => this.topicCommands.sendCompact(instance, instructions),
      applyModel: (instance, name) => this.applyModel(instance, name),
      modelChoices: choicesFromCache,
      applyEffort: (instance, level) => this.applyEffort(instance, level),
      effortChoices: (instance) => {
        const levels = this.effortLevelsFor(instance);
        if (!levels.length) return null;
        const current = this.resolveInstanceEffort(instance).effort;
        return { current, options: levels.map(l => ({ id: l, label: this.effortChoiceLabel(l, current) })) };
      },
      cancel: (instance) => this.cancelInstance(instance),
      steer: (instance, text) => this.topicCommands.sendSteer(instance, text, webMeta(instance)),
      btw: (instance, text) => this.topicCommands.sendBtw(instance, text, webMeta(instance)),
      pauseWake: (instance, action) => this.topicCommands.runPauseWake(instance, action),
      save: (instance, filename) => this.topicCommands.sendSave(instance, filename),
      clearAsk: (instance) => {
        if (!this.topicCommands.supportsClear(instance)) return { refused: t("clear.unsupported") };
        const fence = this.clearTargetFence(instance);
        if (!fence) return { refused: t("clear.not_connected") };
        const now = performance.now();
        for (const [k, v] of this.webClearTokens) if (v.deadline < now) this.webClearTokens.delete(k);
        const token = randomBytes(16).toString("hex");
        this.webClearTokens.set(token, { instance, fence, deadline: now + CLEAR_CONFIRM_TIMEOUT_MS });
        return { token, message: t("clear.confirm_message", instance) };
      },
      clearConfirm: async (instance, token) => {
        const entry = this.webClearTokens.get(token);
        this.webClearTokens.delete(token);                                    // used once, whatever happens next
        if (!entry || entry.instance !== instance || performance.now() > entry.deadline) return { status: 409, text: t("clear.expired", instance) };
        this.eventLog?.insert(instance, "clear_action", { action: "confirm", userId: "web" });
        // sendClear sends its first IPC synchronously: no await separates this check from the effect.
        if (this.shuttingDown || !entry.fence()) return { status: 409, text: t("menu.click_stale") };
        return { status: 200, text: await this.topicCommands.sendClear(instance) };
      },
      t: (key, ...args) => t(key, ...args),
    }, input, opts);
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

    // The nonce was claimed synchronously. Keep the exact owner across platform
    // retirement awaits; a replacement with the same name is not this clear's
    // target, and a role granted at claim time may be revoked while editing.
    const target = this.clearTargetFence(pending.instanceName);
    const groupId = this.getChannelConfig(callbackAdapterId)?.group_id;
    const current = (): boolean => {
      try { return !this.shuttingDown
      && !!data.userId && !!pending.authChannelId
      && !this.webPromptClicks.has(data) // clear is deliberately not web-mirrored
      && this.worlds.get(callbackAdapterId)?.adapter === pending.adapter
      && this.commandChannelStillTargets(pending.instanceName, pending.authChannelId, callbackAdapterId, pending.chatId)
      && this.isModelAdmin(data.userId, pending.authChannelId, callbackAdapterId)
      && (this.classicChannels?.getInstanceByChannel(pending.authChannelId, callbackAdapterId) === pending.instanceName
        ? pending.adapter.type !== "telegram" || pending.chatId === pending.authChannelId
        : String(this.getChannelConfig(callbackAdapterId)?.group_id ?? "") === pending.chatId)
      && this.getChannelConfig(callbackAdapterId)?.group_id === groupId
      && target !== null && target();
      } catch { return false; } // unavailable authority cannot admit a clear
    };
    const admitted = current();
    await this.retireNonceButtons(
      pending,
      pending.messageId ?? data.messageId,
      admitted ? t("clear.clearing", pending.instanceName) : t("menu.click_stale"),
    );
    try {
      // sendClear sends its first IPC synchronously; no await separates this
      // final check from that effect. Uncertainty/throw never reaches IPC.
      const result = admitted && current()
        ? await this.topicCommands.sendClear(pending.instanceName) : t("menu.click_stale");
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
  /**
   * Collapse every still-armed button prompt, for a fleet that is going away.
   *
   * The map is in memory; the buttons are in the chat for up to 24 hours. A
   * restart therefore leaves them looking live — pressing one takes the stale
   * branch, which acknowledges the click and drops the dismissal without
   * saying so. Retiring them here means the user meets a spent prompt instead
   * of a live-looking dead one.
   *
   * Best effort and bounded. Each collapse is a platform call, a day of tips
   * can be many of them, and shutdown still has instances to stop. Whatever
   * has not finished by the deadline is abandoned — that is exactly today's
   * behaviour, so the budget can only leave things no worse than before.
   */
  private async retirePendingNoncePrompts(budgetMs = NONCE_RETIRE_BUDGET_MS): Promise<void> {
    const entries = [...this.pendingNonceButtons.values()];
    this.pendingNonceButtons.clear();
    for (const entry of entries) { if (entry.timer) clearTimeout(entry.timer); this.webPromptGone(entry, entry.expiredText); }

    const collapses = entries
      .map(entry => this.collapseNoncePrompt(entry)?.catch(err => this.logger.debug(
        { err, instanceName: entry.instanceName, prefix: entry.prefix },
        "Failed to retire button prompt during shutdown",
      )))
      .filter(collapse => collapse !== undefined);
    if (!collapses.length) return;

    await Promise.race([
      Promise.allSettled(collapses),
      new Promise<void>(resolve => {
        const timer = setTimeout(resolve, budgetMs);
        timer.unref?.();
      }),
    ]);
  }

  clearNoncePromptsForInstance(instanceName: string): void {
    for (const [nonce, entry] of this.pendingNonceButtons) {
      if (entry.instanceName !== instanceName) continue;
      this.pendingNonceButtons.delete(nonce);
      if (entry.timer) clearTimeout(entry.timer);
      this.webPromptGone(entry, entry.expiredText);
      this.collapseNoncePrompt(entry)?.catch(err => this.logger.debug({ err, instanceName, prefix: entry.prefix },
        "Failed to collapse prompt during instance stop"));
    }
  }

  /** A lapsed prompt's buttons collapsed to its expired text — through its own interaction when it is private. */
  private collapseNoncePrompt(entry: NonceButtonEntry): Promise<void> | undefined {
    if (entry.retire) return entry.retire(entry.expiredText);
    if (!entry.messageId || !entry.adapter.editMessageRemoveButtons) return undefined;
    return entry.adapter.editMessageRemoveButtons(entry.chatId, entry.messageId, entry.expiredText, entry.threadId);
  }

  /** A clean exit is intentional from the CLI's perspective, but often not from
   * the operator's. Keep the instance notice passive and put the action in the
   * same-world General topic where an administrator can make the choice. */
  async notifyNormalExit(instanceName: string): Promise<void> {
    this.notifyInstanceTopic(instanceName, t("exit.instance_notice", instanceName));

    const web = this.webOnlyPromptPlace();
    if (web) {
      await this.postNonceButtonPrompt({
        prefix: EXIT_RESTART_CALLBACK_PREFIX, alertType: "exit_restart", instanceName, ...web,
        message: t("exit.general_notice", instanceName),
        choices: [{ action: "restart", label: t("exit.restart") }, { action: "ignore", label: t("exit.ignore") }],
        expiredText: t("exit.expired", instanceName),
      });
      return;
    }
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
    const label = this.interactivePromptLabel(kind);
    const prompt = {
      prefix: INTERACTIVE_ASSIST_CALLBACK_PREFIX, alertType: "interactive_prompt" as const, instanceName,
      message: t("interactive.general_notice", instanceName, label),
      choices: [{ action: "confirm", label: t("interactive.confirm") }, { action: "cancel", label: t("interactive.cancel") }],
      expiredText: t("interactive.expired", instanceName),
      extra: { generalName, promptKind: kind, assistFor: this.interactionWaitKey(instanceName) },
    };
    // No chat platform: the dashboard is where it is asked; Confirm still asks General to help.
    const web = this.webOnlyPromptPlace();
    if (web) { await this.postNonceButtonPrompt({ ...prompt, ...web }); return; }

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

    await this.postNonceButtonPrompt({ ...prompt, adapter, adapterId, chatId, threadId });
  }

  /**
   * Offer a one-tap re-login next to an auth alert.
   *
   * The alert already names the remedy in words (`/login <backend>`), which
   * still leaves the user to retype it somewhere. The button routes into the
   * same chooser `/login` uses, so pressing it starts the flow in place.
   *
   * Backends with no remote login flow (opencode logs in from a terminal) get
   * no button — the alert's own wording already tells them what to run.
   */
  async offerBackendLogin(targetInstance: string, backend: string): Promise<void> {
    if (!LOGIN_FLOWS[backend]) return;
    const adapterId = this.getInstanceAdapterId(targetInstance);
    const adapter = this.getAdapterForInstance(targetInstance);
    const chatId = this.getGroupIdForInstance(targetInstance);
    const topicId = this.fleetConfig?.instances[targetInstance]?.topic_id;
    const threadId = topicId != null ? String(topicId) : undefined;
    if (!adapter || !adapterId || !chatId) {
      this.logger.warn({ targetInstance, backend, adapterId, chatId },
        "Cannot address the re-login button — the alert text still names the command");
      return;
    }
    await this.postNonceButtonPrompt({
      prefix: LOGIN_CALLBACK_PREFIX,
      alertType: "login",
      instanceName: "login",
      adapter,
      adapterId,
      chatId,
      threadId,
      message: t("login.offer", backend),
      choices: [{ action: backend, label: t("login.offer_action", backend) }],
      expiredText: t("buttons.stale"),
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
  private async handleSlashSave(data: { channelId: string; userId: string; options?: Record<string, string | boolean | number>; respond: (text: string) => Promise<string | undefined> }, adapterId?: string): Promise<void> {
    // The admin of the channel's own kind (a fleet admin in a fleet channel). It used to ask for a ClassicBot
    // admin everywhere, so a fleet admin was refused in their own channel and a ClassicBot admin could paste
    // into a fleet instance.
    if (!this.isModelAdmin(data.userId, data.channelId, adapterId)) {
      await data.respond(t("admin.required"));
      return;
    }
    if (!this.classicChannels) { await data.respond(t("classic.no_agent_start")); return; }
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
  private handleCancelClick(instanceName: string, adapter: ChannelAdapter | null, data: AdapterCallbackData, adapterId: string): void {
    // #754 audit: the click names its instance in its own callback data, and Telegram delivers clicks from anyone in
    // the chat. So it may interrupt only when it comes through the instance's owning adapter (the one that posts its
    // buttons) from someone that adapter lets speak — and, on a live button, only that instance's own message.
    const owner = this.getInstanceAdapterId(instanceName);
    const live = this.cancelButtons.get(data.messageId);
    // Where the click came from: a live button's own message (and topic), or — when the fleet has no entry for the
    // message (a button being replaced, or forgotten across a restart) — the instance's destination as it is NOW, so a
    // button left behind in a channel the instance has since moved from, or a click from an unrelated chat, does not
    // cancel it (#1396 review).
    const dest = this.cancelButtonDestination(instanceName);
    const atDestination = !!owner && (live
      ? live.instanceName === instanceName && live.chatId === data.chatId
        && (live.threadId == null || this.clickAtDestination({ chatId: live.chatId, threadId: live.threadId }, data, owner))
      : !!dest && this.clickAtDestination(dest, data, owner));
    // Who may press it: in a ClassicBot chat, anyone there — exactly who a typed /cancel there answers, since ClassicBot
    // traffic is not admitted by the fleet's access policy (#1396 review); elsewhere someone the owning adapter lets speak.
    const classic = this.classicChannels?.getChannelIdByInstance(instanceName) !== undefined;
    const access = owner ? this.worlds.get(owner)?.accessManager ?? (owner === this.getPrimaryAdapterId() ? this.accessManager : null) : null;
    const speaker = !!data.userId && !!owner
      && (classic || this.isFleetAdmin(data.userId, owner) || !!access?.isAllowed(data.userId));
    if (!owner || adapterId !== owner || !speaker || !atDestination) {
      this.logger.warn({ instanceName, adapterId, owner, userId: data.userId, live: !!live, atDestination }, "Refused cancel click: not this instance's button where it is now, or not someone its adapter lets speak");
      data.ack?.(t("buttons.not_allowed"));
      return;
    }
    if (live) {
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

  /** Where an instance's cancel button is posted — and so the only place a click on it can come from. */
  private cancelButtonDestination(instanceName: string): { chatId: string; threadId?: string } | null {
    const groupId = this.getGroupIdForInstance(instanceName) || undefined;
    const topicId = this.fleetConfig?.instances[instanceName]?.topic_id;
    // Fleet topic instance.
    if (topicId != null && groupId) return { chatId: String(groupId), threadId: String(topicId) };
    // Classic instance: channelId from the classic manager; General / flat fallback: the group (no thread).
    const chatId = this.classicChannels?.getChannelIdByInstance(instanceName) ?? (groupId ? String(groupId) : undefined);
    return chatId ? { chatId } : null;
  }

  /**
   * A click came from this destination. A Discord click names the guild as its chat and the channel as its thread; a
   * Telegram click names the chat and topic, with the General topic as thread 1 or none at all.
   */
  private clickAtDestination(dest: { chatId: string; threadId?: string }, data: AdapterCallbackData, ownerAdapterId: string): boolean {
    const telegram = this.getChannelConfig(ownerAdapterId)?.type === "telegram";
    const thread = (id?: string): string | undefined => (telegram && (id === undefined || id === "1") ? undefined : id);
    if (thread(dest.threadId) !== undefined) return data.chatId === dest.chatId && thread(data.threadId) === thread(dest.threadId);
    return (thread(data.threadId) ?? data.chatId) === dest.chatId;
  }

  private hasCancelButton(instanceName: string): boolean {
    for (const e of this.cancelButtons.values()) {
      if (e.instanceName === instanceName) return true;
    }
    return false;
  }

  private beginCancelButtonPublication(
    instanceName: string,
    correlationId?: string,
  ): CancelButtonPublication {
    // A new handoff supersedes any idle timer left by the previous turn. If the
    // instance is still idle after this publication, the post-await level check
    // below starts a fresh grace period for this generation.
    this.cancelIdleButtonRetirement(instanceName);
    const publication: CancelButtonPublication = {
      generation: ++this.nextCancelButtonPublicationGeneration,
      correlationId,
      inFlight: true,
      retirePending: false,
    };
    this.cancelButtonPublications.set(instanceName, publication);
    return publication;
  }

  /** Remember a clear/cancel/idle decision that arrived before notifyAlert
   * returned a message id. `expected` fences an idle timer to its generation. */
  private markCancelButtonPublicationForRetirement(
    instanceName: string,
    expected?: CancelButtonPublication,
  ): void {
    const publication = this.cancelButtonPublications.get(instanceName);
    if (!publication?.inFlight) return;
    if (expected && publication !== expected) return;
    publication.retirePending = true;
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
    const { chatId, threadId } = this.cancelButtonDestination(instanceName) ?? {};
    if (!chatId) {
      // A button that cannot be addressed must say so — this exact silence is how
      // "the cancel button sometimes never appears" stayed unreported-in-logs.
      this.logger.warn({ instanceName, topicId, groupId }, "Cannot address cancel button (no chat id resolved)");
      return;
    }

    const publication = this.beginCancelButtonPublication(instanceName, correlationId);
    const initialProgressText = FleetManager.progressText(0, null, 1, this.progressPrefixFor(instanceName, 0, 1));

    try {
      const sent = await adapter.notifyAlert(chatId, {
        type: "cancel",
        instanceName,
        message: initialProgressText,
        choices: [{ id: `cancel:${instanceName}`, label: t("cancel.button") }],
      }, threadId ? { threadId } : undefined);

      publication.inFlight = false;

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
        lastProgressText: initialProgressText,
        // A reply can re-post the same in-flight bubble below the reply. Carry
        // its current list into that replacement; fresh inbound work must start
        // empty even if the daemon's reset broadcast is still in flight.
        toolProgress: preserveProgress ? this.instanceProgress.get(instanceName) : undefined,
      };

      // A newer send started while this API call was pending. Track this late
      // message just long enough for the normal bounded delete/retry machinery
      // to remove it; critically, do not sweep the newer generation.
      if (this.cancelButtonPublications.get(instanceName) !== publication) {
        this.cancelButtons.set(sent.messageId, entry);
        this.persistCancelButtons();
        this.logger.debug(
          { instanceName, messageId: sent.messageId, generation: publication.generation },
          "Retiring superseded cancel-button publication",
        );
        this.retireButton(entry);
        return;
      }

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

      // Retirement is normally edge-triggered, but the edge (or an explicit
      // reply/cancel clear) may have happened while notifyAlert was in flight.
      // Reconcile the level after publication so a late button cannot resurrect
      // on an already-idle instance. Preserve the existing two-second grace:
      // a working transition cancels this timer just as it does for a normal
      // idle edge.
      if (publication.retirePending) {
        this.retireButton(entry);
      } else if (this.getInstanceExecutionState(instanceName) === "idle") {
        this.scheduleIdleButtonRetirement(instanceName);
      }
    } catch (e) {
      if (this.cancelButtonPublications.get(instanceName) === publication) {
        this.cancelButtonPublications.delete(instanceName);
        // beginCancelButtonPublication cancelled the previous turn's idle
        // timer so it could not act on this generation. If the provider POST
        // failed while the instance remained idle, restore that retirement
        // opportunity for any older button still on screen.
        if (this.getInstanceExecutionState(instanceName) === "idle") {
          this.scheduleIdleButtonRetirement(instanceName);
        }
      }
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
  static progressText(elapsedMs: number, activity?: string | null, minElapsedMs = PROGRESS_MIN_ELAPSED_MS, prefix?: string): string {
    // A configured progress_prefix (#1005) leads both phases; the built-in
    // switches 👀 → ⏳ once the elapsed time shows.
    if (elapsedMs < minElapsedMs) return `${prefix ?? "👀"} 處理中…`;
    const elapsed = FleetManager.formatProgressElapsed(elapsedMs);
    const detail = FleetManager.sanitizeActivity(activity);
    return detail
      ? `${prefix ?? "⏳"} 處理中… (已進行 ${elapsed} · ${detail})`
      : `${prefix ?? "⏳"} 處理中… (已進行 ${elapsed})`;
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
    const elapsedMs = Date.now() - (entry.startedAt ?? Date.now());
    return FleetManager.bubbleText(
      elapsedMs,
      this.instanceActivity.get(entry.instanceName),
      this.progressMinElapsedMs(),
      entry.toolProgress,
      this.progressPrefixFor(entry.instanceName, elapsedMs),
    );
  }

  /** Pure composition of header + tool list, exposed for tests. */
  static bubbleText(
    elapsedMs: number,
    activity: string | undefined,
    minElapsedMs: number,
    progress: string | undefined,
    prefix?: string,
  ): string {
    const header = FleetManager.progressText(
      elapsedMs,
      // The single-line activity detail is redundant once a tool list exists.
      progress ? undefined : activity,
      minElapsedMs,
      prefix,
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
    this.markCancelButtonPublicationForRetirement(instanceName);
    this.retireInstanceButtons(instanceName);
  }

  /** Retire the cross-instance button matching a delegate→report correlation id.
   * Used by report_result, where the sender's self-derived name may not match
   * the target-address name the button was registered under. */
  clearCancelButtonByCorrelation(correlationId: string): void {
    if (!correlationId) return;
    for (const [instanceName, publication] of this.cancelButtonPublications) {
      if (publication.inFlight && publication.correlationId === correlationId) {
        this.markCancelButtonPublicationForRetirement(instanceName, publication);
      }
    }
    for (const e of [...this.cancelButtons.values()]) {
      if (e.correlationId === correlationId) this.retireButton(e);
    }
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
    // The queued web messages were just dropped with the rest: their ticks say so, on every page.
    for (const m of this.webChatHistory.cancelPending(instanceName)) {
      this.emitSseEvent("delivery", { instance: instanceName, messageId: m.messageId, delivery: m.delivery });
    }
    return true;
  }

  getDeliveryEpoch(instanceName: string): number {
    return this.deliveryEpochs.get(instanceName) ?? 0;
  }

  private isDeliveryEpochCurrent(instanceName: string, deliveryEpoch: number): boolean {
    return deliveryEpoch === this.getDeliveryEpoch(instanceName);
  }

  /** The delivery epoch, and the caller's own fence when it gave one (DeliveryOptions.stillCurrent, #1426). */
  private deliveryCurrent(instanceName: string, deliveryEpoch: number, stillCurrent?: () => boolean): boolean {
    return this.isDeliveryEpochCurrent(instanceName, deliveryEpoch) && (stillCurrent?.() ?? true);
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
  /** Web-terminal login: the only sign-in path (the chat-relay mode was removed, #1139). */
  private loginController: LoginController | null = null;
  /**
   * One login/install window fleet-wide. Claimed synchronously before the
   * first await by web login and install alike (sol B1).
   */
  private readonly loginWindow = new LoginWindowLock();
  private get webLogin(): LoginController {
    if (!this.loginController) {
      this.loginController = new LoginController({
        logger: this.logger,
        fleetConfig: () => this.fleetConfig,
        isFleetAdmin: (userId, adapterId) => this.isFleetAdmin(userId, adapterId),
        eventLog: () => this.eventLog,
        recoverBackendInstances: backend => this.recoverBackendInstances(backend),
        claimWindow: backend => this.loginWindow.tryClaim("web", backend),
        releaseWindow: claim => { this.loginWindow.release(claim); },
        isClaimCurrent: claim => this.loginWindow.isCurrent(claim),
        windowBusyMessage: () => this.loginWindow.busyMessage(),
        tunnelDataDir: () => this.dataDir,
        reserveTunnel: owner => this.getTunnelLane().reserve("login", owner),
        // Throws when the prompt cannot be posted: the controller tells the
        // user so instead of leaving "Starting…" as the last word (#1133).
        postButtons: async ({ prefix, instanceName, chat, message, choices, expiredText }) => {
          await this.postNonceButtonPromptOrThrow({
            prefix, alertType: "login", instanceName,
            adapter: chat.adapter, adapterId: chat.adapterId, chatId: chat.chatId, threadId: chat.threadId,
            message, choices, expiredText,
          });
        },
      });
    }
    return this.loginController;
  }

  /**
   * Post the backend chooser for a bare `/login`. Caller enforces admin.
   * Returns why the chooser could not be posted, for the caller to tell the
   * user (#1133); undefined when it was posted or there was nothing to choose.
   */
  async promptLoginBackends(chat: {
    adapter: ChannelAdapter; adapterId: string; chatId: string; threadId?: string;
  }): Promise<string | undefined> {
    const configured = new Set<string>();
    for (const name of this.configuredBackendInstanceNames()) {
      configured.add(this.backendNameOf(name));
    }
    const installed = await this.probeInstalledBackends();
    // One entry point for "get this CLI working" (#1131): a backend that is
    // not installed is offered too, and the click installs it first, then
    // signs in (startLoginSession routes it).
    const installable = new Set(Object.keys(BACKEND_INSTALLATION_INFO));
    const candidates = new Set<string>([...installed, ...configured, ...installable]);
    const unsupported: Array<{ backend: string; flow?: LoginFlow; status: string[] }> = [];
    const choices = [...candidates].sort().flatMap(backend => {
      const flow = LOGIN_FLOWS[backend];
      const remoteLogin = !!flow && flow.remoteLogin !== "unsupported";
      const isInstalled = installed.has(backend);
      const status: string[] = [];
      status.push(t(isInstalled ? "login.status_installed" : "login.status_not_installed"));
      if (configured.has(backend)) status.push(t("login.status_configured"));
      if (!isInstalled && installable.has(backend)) {
        status.push(t(remoteLogin ? "login.status_install_then_auth" : "login.status_install"));
        return [{ action: backend, label: `${backend} · ${status.join(" · ")}` }];
      }
      if (remoteLogin && isInstalled) {
        status.push(t("login.status_auth"));
        return [{ action: backend, label: `${backend} · ${status.join(" · ")}` }];
      }
      status.push(t("login.status_unsupported"));
      unsupported.push({ backend, flow, status });
      return [];
    });
    if (unsupported.length) {
      const guidance = unsupported.map(({ backend, flow, status }) => `${backend} · ${status.join(" · ")} — ${isRemovedBackend(backend)
        ? removedBackendMessage(backend)
        : !installed.has(backend)
        ? (BACKEND_INSTALLATION_INFO[backend] ? t("login.install_by_name", backend) : t("login.install_on_host", backend))
        : flow?.remoteLogin === "unsupported"
        ? t("login.remote_unsupported_agent_cli", backend, flow.command)
        : backend === "opencode" ? t("login.unsupported", backend) : t("login.no_remote_flow", backend)}`).join("\n");
      await chat.adapter.sendText(chat.chatId, guidance, { threadId: chat.threadId })
        .catch(err => this.logger.warn({ err }, "Failed to post unsupported login guidance"));
    }
    if (choices.length === 0) {
      if (!unsupported.length) {
        await chat.adapter.sendText(chat.chatId, t("login.none_available"), { threadId: chat.threadId })
          .catch(err => this.logger.warn({ err }, "Failed to post empty login chooser guidance"));
      }
      return;
    }
    return this.postChooser({
      prefix: LOGIN_CALLBACK_PREFIX,
      alertType: "login",
      instanceName: "login",
      adapter: chat.adapter,
      adapterId: chat.adapterId,
      chatId: chat.chatId,
      threadId: chat.threadId,
      message: `${t("login.choose_backend")}\n${t("fleet.label_line", fleetLabel(this.fleetConfig))}`,
      choices,
      expiredText: t("buttons.stale"),
    });
  }

  /** A clicked prompt's follow-up line; a failure to post it is logged, not swallowed (#1133). */
  private async postPromptOutcome(entry: NonceButtonEntry, text: string): Promise<void> {
    await entry.adapter.sendText(entry.chatId, text, { threadId: entry.threadId })
      .catch(err => this.logger.warn({ err, instanceName: entry.instanceName, prefix: entry.prefix },
        "Could not post a prompt's follow-up"));
  }

  /** A chooser prompt: undefined when posted, else the user-facing reason it was not. */
  private async postChooser(opts: Parameters<FleetManager["postNonceButtonPromptOrThrow"]>[0]): Promise<string | undefined> {
    try {
      await this.postNonceButtonPromptOrThrow(opts);
      return undefined;
    } catch (err) {
      this.logger.warn({ err, prefix: opts.prefix }, "Could not post a backend chooser");
      return t("buttons.post_failed", (err as Error)?.message ?? String(err));
    }
  }

  /**
   * Ask the General topic to approve a ClassicBot access request.
   *
   * Two affirmative buttons rather than one, when the trigger identified a
   * user. Allowing a group to talk and granting that person ClassicBot admin
   * (start/stop/model on classic channels — NOT fleet admin, which reads
   * fleet.yaml `channel.access.allowed_users`) have different blast radii, and
   * bundling them would force anyone who wants only the cheap one to accept the
   * expensive one or go edit YAML by hand.
   *
   * Built on postNonceButtonPrompt, so it inherits the canonical-address
   * binding (#682) that makes these buttons answer in a Telegram General topic.
   */
  private async promptClassicApproval(opts: {
    generalName: string;
    message: string;
    groupId: string;
    /** Discord guild, Telegram group, or Telegram private user; each has its own allowlist. */
    scope: "guild" | "group" | "user";
    userId?: string;
    replyTo?: NonceButtonEntry["classicReplyTo"];
  }): Promise<void> {
    const adapter = this.getAdapterForInstance(opts.generalName);
    // An instance with no world binding yet (fresh restart, or a fleet whose
    // primary `channel:` block carries the config) still has a usable adapter —
    // fall back to that adapter's own id rather than dropping the buttons. The
    // id only has to match what the callback arrives with, which is this same
    // adapter.
    const adapterId = this.getInstanceAdapterId(opts.generalName) ?? adapter?.id;
    const chatId = this.getGroupIdForInstance(opts.generalName);
    const topicId = this.fleetConfig?.instances[opts.generalName]?.topic_id;
    if (!adapter || !adapterId || !chatId) {
      // Never lose the notification because the buttons could not be addressed.
      this.notifyInstanceTopic(opts.generalName, opts.message);
      return;
    }
    const choices = [{ action: "allow", label: t(opts.scope === "user" ? "classic.approve_user" : "classic.approve_group") }];
    if (opts.userId) choices.push({ action: "allow-admin", label: t("classic.approve_group_admin") });
    choices.push({ action: "ignore", label: t("classic.approve_ignore") });

    await this.postNonceButtonPrompt({
      prefix: CLASSIC_APPROVE_CALLBACK_PREFIX,
      alertType: "classic_approve",
      instanceName: opts.generalName,
      adapter,
      adapterId,
      chatId,
      threadId: topicId != null ? String(topicId) : undefined,
      message: opts.message,
      choices,
      expiredText: t("buttons.stale"),
      extra: { classicGroupId: opts.groupId, classicUserId: opts.userId, classicScope: opts.scope, classicReplyTo: opts.replyTo },
    });
  }

  /**
   * Apply an approved ClassicBot access request.
   *
   * Writes through ClassicChannelManager's typed mutators rather than handing
   * General a YAML edit: the id is stored via String() so a Discord snowflake
   * cannot land as a YAML integer and lose precision, the existing save() path
   * is reused, in-memory state is correct immediately (no waiting on the 30s
   * reload poll), and a click cannot silently do nothing because General
   * happened to be paused. General is still told the outcome.
   */
  private async applyClassicApproval(
    entry: NonceButtonEntry,
    groupId: string,
    adminUserId?: string,
  ): Promise<void> {
    const classic = this.classicChannels;
    if (!classic) {
      this.notifyInstanceTopic(entry.instanceName, t("classic.approve_failed", groupId));
      return;
    }
    const scope = entry.classicScope ?? "guild";
    const access = scope === "user" ? classic.allowUser(groupId)
      : scope === "group" ? classic.allowGroup(groupId) : classic.allowGuild(groupId);
    const admin = adminUserId ? classic.addAdminUser(adminUserId) : null;

    const lines = [t(access === "added" ? "classic.approve_done_group" : "classic.approve_done_group_already", groupId)];
    if (admin) {
      lines.push(t(admin === "added" ? "classic.approve_done_admin" : "classic.approve_done_admin_already",
        adminUserId ?? ""));
    }
    this.notifyInstanceTopic(entry.instanceName, lines.join("\n"));
    await this.notifyClassicRequester(entry, "classic.request_allowed");
  }

  private async notifyClassicRequester(entry: NonceButtonEntry, key: string): Promise<void> {
    const reply = entry.classicReplyTo;
    // Do not use a replaced bot or guess a new recipient after adapter rebuild.
    if (!reply || this.worlds.get(reply.adapterId)?.adapter !== reply.adapter) return;
    try {
      await reply.adapter.sendText(reply.chatId, t(key));
    } catch (err) {
      this.logger.warn({ err, adapterId: reply.adapterId, scope: entry.classicScope }, "Could not notify Classic access requester");
    }
  }

  /** Consume a ClassicBot approval button. */
  private async handleClassicApproval(
    data: AdapterCallbackData,
    callbackAdapterId: string,
    receivingAdapter?: ChannelAdapter,
  ): Promise<boolean> {
    const claimed = this.consumeNonceCallback(
      CLASSIC_APPROVE_CALLBACK_PREFIX,
      /^classic-approve:([0-9a-f]+):(allow|allow-admin|ignore)$/,
      data,
      callbackAdapterId,
      receivingAdapter,
    );
    if (claimed === null) return false;
    if (claimed === "consumed") return true;
    const { entry, action } = claimed;
    const groupId = entry.classicGroupId ?? "";
    const userId = entry.classicUserId;

    if (action === "ignore") {
      await this.retireNonceButtons(entry, entry.messageId ?? data.messageId,
        t("classic.approve_ignored", groupId));
      await this.notifyClassicRequester(entry, "classic.request_ignored");
      return true;
    }
    const grantAdmin = action === "allow-admin" && !!userId;
    await this.retireNonceButtons(entry, entry.messageId ?? data.messageId,
      grantAdmin ? t("classic.approve_applying_admin", groupId, userId ?? "")
                 : t("classic.approve_applying", groupId));
    await this.applyClassicApproval(entry, groupId, grantAdmin ? userId : undefined);
    return true;
  }

  /**
   * Start a login session for one backend. Caller enforces admin.
   * Returns a status line to post, or null when a confirmation prompt was
   * posted instead (auth still valid — see the pre-check below).
   */
  async startLoginSession(backendArg: string, chat: {
    adapter: ChannelAdapter; adapterId: string; chatId: string; threadId?: string; userId?: string;
  }, opts: { skipAuthCheck?: boolean; tokenPresent?: boolean; tunnel?: boolean } = {}): Promise<string | null> {
    // `/login` is the one entry point (#1131): a CLI that is not installed yet
    // is installed first, and the install's success signs in (startInstallSession).
    // A confirmation click (skipAuthCheck) continues a sign-in already decided:
    // straight to it, never back through the install routing — a binary that
    // went missing meanwhile must not start an installer from a "go" button.
    if (opts.skipAuthCheck) return this.launchSignIn(backendArg, chat, opts);
    const wanted = LOGIN_BACKEND_ALIASES[backendArg.toLowerCase()] ?? backendArg.toLowerCase();
    // A removed backend (#1280) is neither installed nor signed into: say what replaces it.
    if (isRemovedBackend(wanted)) return removedBackendMessage(wanted);
    if (BACKEND_INSTALLATION_INFO[wanted] && !this.isCliInstalled(wanted)) {
      const flow = LOGIN_FLOWS[wanted];
      this.recordLoginFlow(wanted, flow && flow.remoteLogin !== "unsupported" ? "install_then_login" : "install_only", chat.userId);
      return this.startInstallSession(wanted, chat);
    }
    this.recordLoginFlow(wanted, "login", chat.userId);
    return this.launchSignIn(backendArg, chat, opts);
  }

  /** Which way a `/login` went (#1131) — so the event log shows what users actually need. */
  private recordLoginFlow(backend: string, flow: "login" | "install_then_login" | "install_only", requester?: string): void {
    try {
      this.eventLog?.insert("login", "login_entry", { backend, flow, requester: requester ?? null });
    } catch (err) {
      this.logger.debug({ err, backend, flow }, "Could not record the /login flow");
    }
  }

  /** The sign-in itself, in the web terminal, for a CLI that is installed. */
  private async launchSignIn(backendArg: string, chat: {
    adapter: ChannelAdapter; adapterId: string; chatId: string; threadId?: string; userId?: string;
  }, opts: { skipAuthCheck?: boolean; tokenPresent?: boolean; tunnel?: boolean } = {}): Promise<string | null> {
    return this.webLogin.start(backendArg, chat, opts);
  }

  /** Fleet shutdown: end any web login or install window and wait for its confirmed teardown. */
  private async shutdownLoginWindows(): Promise<void> {
    // Close the lock FIRST: in-flight starts parked in a pre-check or
    // ensureSession observe !isCurrent when they resume and stop; no new
    // window can be claimed while we stop.
    this.loginWindow.close();
    // Completion semantics live INSIDE the sessions: each awaits its own
    // confirmed cleanup, every tmux op on that path has a hard per-op bound
    // (web: abort ≤10 s + kill ≤31 s; legacy: create/list/kill ≤10 s each,
    // duplicates killed in parallel). This outer deadline is only a loud last
    // resort so `agend stop` cannot hang forever on a wedged tmux; reaching it
    // is an ERROR, logged and recorded, and it releases nothing re-claimable
    // (the lock stays closed, the controller keeps its entry). The timer is
    // cleared on success so a long-lived process never fires it spuriously.
    const SHUTDOWN_DEADLINE_MS = 120_000;
    const bounded = (p: Promise<unknown> | undefined, what: string): Promise<void> => {
      if (!p) return Promise.resolve();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>(r => {
        timer = setTimeout(() => {
          this.logger.error({ what, deadlineMs: SHUTDOWN_DEADLINE_MS }, "login window teardown still in flight at the shutdown deadline — a dedicated tmux server may survive; check `tmux -L agend-term-* ls`");
          this.eventLog?.insert("login", "login_window_shutdown_deadline", { what });
          r();
        }, SHUTDOWN_DEADLINE_MS);
        timer.unref?.();
      });
      return Promise.race([p.then(() => undefined, () => this.logger.warn({ what }, "login window shutdown failed")), deadline])
        .finally(() => { if (timer) clearTimeout(timer); });
    };
    // "cancelled" is the detail both legacy onDone handlers keep quiet about —
    // a stopping fleet must not announce "login failed — fleet shutdown".
    await Promise.all([
      bounded(this.loginController?.shutdown(), "web-login"),
      bounded(this.activeInstall?.session.cancel("cancelled"), "install"),
    ]);
  }

  /** `/login cancel` — abort the active session and remove its window. */
  async cancelLoginSession(): Promise<string> {
    // `/login cancel` also stops an install that `/login` started — and the
    // sign-in an install that just succeeded is about to hand over to.
    if (this.activeInstall) return this.cancelInstallSession();
    if (this.installHandoff) {
      const { backend } = this.installHandoff;
      this.installHandoff.cancelled = true;
      this.installHandoff = null;
      return t("login.cancelled", backend);
    }
    if (this.loginController?.isActive()) return this.loginController.cancel();
    return t("login.no_session");
  }

  /**
   * After a successful login: wake the paused instances of that backend AND
   * restart the running ones — a live CLI holds the old token in memory and
   * only re-reads credentials on process start (a paused instance's CLI is
   * already dead, so waking it respawns with the new token for free).
   */
  /**
   * Wake/restart every instance of a backend after a successful re-login.
   *
   * Bounded by a wall-clock deadline. This used to be an unbounded sequential
   * loop, and the caller only built its "login completed" message AFTER it
   * returned — so with several instances (or one slow restart) the user was
   * told nothing at all for minutes, concluded the login had hung, and
   * restarted things by hand. Instances that do not finish in time are NOT
   * cancelled: they are still coming back, and are reported as pending so the
   * message can say so instead of implying failure.
   */
  private async recoverBackendInstances(
    backend: string,
    deadlineMs = POST_LOGIN_RECOVERY_DEADLINE_MS,
  ): Promise<PostLoginRecovery> {
    const woken: string[] = [];
    const restarted: string[] = [];
    const pending: string[] = [];
    const deadline = Date.now() + deadlineMs;
    for (const name of this.configuredBackendInstanceNames()) {
      if (this.backendNameOf(name) !== backend) continue;
      const status = this.getInstanceStatus(name);
      if (status !== "paused" && status !== "running") continue;
      const result = await runBeforeDeadline(async () => {
        if (status === "paused") {
          if (this.daemons.has(name)) await this.lifecycle.wake(name, 30_000);
          else await this.startPersistedPausedInstance(name);
        } else {
          await this.restartSingleInstance(name);
        }
      }, deadline);
      if (result.status === "fulfilled") {
        (status === "paused" ? woken : restarted).push(name);
      } else if (result.status === "timeout") {
        // Out of time: record it and stop waiting, but keep walking the list —
        // the remaining instances are checked against the same deadline and
        // fall straight through, so the caller still learns about all of them.
        pending.push(name);
      } else {
        this.logger.warn({ err: (result.reason as Error)?.message, name, status }, "Post-login recovery failed");
      }
    }
    return { woken, restarted, pending };
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
      userId: data.userId,
    });
    if (text) await this.postPromptOutcome(entry, text);
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
      /^login-confirm:([0-9a-f]+):(go|go-relogin|go-tunnel|go-relogin-tunnel|cancel)$/,
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
      userId: data.userId,
    }, {
      skipAuthCheck: true,
      tokenPresent: action === "go-relogin" || action === "go-relogin-tunnel",
      // The consent is the button itself: only the explicit "Open public link" actions carry it.
      tunnel: action === "go-tunnel" || action === "go-relogin-tunnel",
    });
    if (text) await this.postPromptOutcome(entry, text);
    return true;
  }

  /** "Resend token" button (web login): only the requester may press it; the token never enters the channel. */
  private async handleLoginTokenResend(
    data: AdapterCallbackData,
    callbackAdapterId: string,
    receivingAdapter?: ChannelAdapter,
  ): Promise<boolean> {
    const claimed = this.consumeNonceCallback(
      LOGIN_TOKEN_RESEND_PREFIX,
      /^login-token:([0-9a-f]+):(resend)$/,
      data,
      callbackAdapterId,
      receivingAdapter,
    );
    if (claimed === null) return false;
    if (claimed === "consumed") return true;
    const { entry } = claimed;
    const text = await this.webLogin.resendToken(data.userId);
    await this.retireNonceButtons(entry, entry.messageId ?? data.messageId, text);
    return true;
  }

  // ── Remote CLI install (run by `/login` for a CLI that is missing) ──────────────────────────────────
  //
  // Same dedicated-window model as /login (and the same LoginSession state
  // machine — an install is a login flow with no auth hints): run the
  // installer, judge by exit code, verify the binary on a fresh login shell,
  // then sign in (the hand-off below).
  private activeInstall: {
    session: LoginSession;
    backend: string;
    chat: { adapter: ChannelAdapter; adapterId: string; chatId: string; threadId?: string };
  } | null = null;
  /** An install that succeeded, between its success line and the sign-in it hands over to (#1131). */
  private installHandoff: { backend: string; cancelled: boolean } | null = null;

  /** Start a CLI install session. Caller enforces admin. */
  async startInstallSession(backendArg: string, chat: {
    adapter: ChannelAdapter; adapterId: string; chatId: string; threadId?: string; userId?: string;
  }): Promise<string> {
    const backend = LOGIN_BACKEND_ALIASES[backendArg.toLowerCase()] ?? backendArg.toLowerCase();
    const info = BACKEND_INSTALLATION_INFO[backend];
    if (!info) return t("install.unsupported", backendArg);
    if (checkBinaryInstalled(info.binary)) return t("install.already", backend, info.binary);
    // Reserve the fleet-wide window before the first await (shared with web
    // login). Owned by this method until the session is published.
    const claim = this.loginWindow.tryClaim("install", backend);
    if (!claim) return this.loginWindow.busyMessage();

    let tmux: TmuxManager;
    try {
      const sessionName = getTmuxSession();
      await TmuxManager.ensureSession(sessionName);
      if (!this.loginWindow.isCurrent(claim)) { this.loginWindow.release(claim); return t("login.web_shutting_down"); }
      tmux = new TmuxManager(sessionName, "");
    } catch (err) {
      this.loginWindow.release(claim);
      return t("install.failed", backend, (err as Error).message);
    }
    // A synthetic flow: success is decided by the installer's exit code
    // (LoginSession treats a clean exit as success), never by pane text. The
    // session only judges that verdict; it does not read the output for URLs or prompts.
    const flow: LoginFlow = {
      backend,
      command: info.install,
      successPattern: /$^/,
      timeoutMs: 10 * 60 * 1000,
    };
    const session = new LoginSession(flow, tmux, {
      onDone: async ({ ok, detail, cleanupFailed }) => {
        this.activeInstall = null;
        this.loginWindow.release(claim);
        if (cleanupFailed) {
          await chat.adapter.sendText(chat.chatId, t("login.web_cleanup_failed", backend), { threadId: chat.threadId }).catch(() => {});
        }
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
        const installedAt = this.locateBinaryOnLoginShell(info.binary) ?? this.locateInInstallerBinDirs(info);
        if (!installedAt) {
          await chat.adapter.sendText(chat.chatId, t("install.verify_failed", backend, info.binary),
            { threadId: chat.threadId }).catch(() => {});
          return;
        }
        // #1059: make it reachable from this process too. `/login` lists what
        // `which` finds on the fleet's own PATH, and instances resolve their
        // binary the same way, so a binary only a login shell could see was
        // installed, reported as verified, and then offered nowhere.
        this.adoptBinaryDirectory(installedAt, backend);
        if (!LOGIN_FLOWS[backend]) {
          await chat.adapter.sendText(chat.chatId, t("install.success_no_login", backend),
            { threadId: chat.threadId }).catch(() => {});
          return;
        }
        // The button is deliberately best-effort: it is a short-lived
        // capability and can be lost during an adapter reconnect.  Always
        // publish a durable completion line first so a successful install can
        // never look like it silently disappeared.  Include the binary that
        // passed the fresh-login-shell verification and the exact next step.
        // Between the install ending and the sign-in starting there is no
        // session to cancel; this hand-off is what `/login cancel` stops.
        const handoff = { backend, cancelled: false };
        this.installHandoff = handoff;
        await chat.adapter.sendText(chat.chatId, t("install.success", backend, info.binary),
          { threadId: chat.threadId }).catch(err => this.logger.warn({ err, backend },
            "Failed to send durable install success notification"));
        if (handoff.cancelled || this.installHandoff !== handoff) return;
        this.installHandoff = null;
        // The user asked `/login` for a working CLI: sign in straight away
        // (#1131). The login has its own confirmation, so nothing starts
        // without a click.
        // launchSignIn, not startLoginSession: if the new binary were still
        // not visible, startLoginSession would route straight back to an install.
        const next = await this.launchSignIn(backend, chat, {}).catch((err: unknown) =>
          t("login.failed", backend, (err as Error)?.message ?? String(err)));
        if (next) {
          await chat.adapter.sendText(chat.chatId, next, { threadId: chat.threadId })
            .catch(err => this.logger.warn({ err, backend }, "Could not post the sign-in step after an install"));
        }
      },
    }, this.logger);

    this.activeInstall = { session, backend, chat };
    try {
      await session.start();
    } catch (err) {
      this.activeInstall = null;
      this.loginWindow.release(claim);
      const text = t("install.failed", backend, (err as Error).message);
      return (err as { cleanupFailed?: boolean }).cleanupFailed ? `${text}\n${t("login.web_cleanup_failed", backend)}` : text;
    }
    if (session.state === "done") {
      this.activeInstall = null;
      this.loginWindow.release(claim);
      return this.loginWindow.isClosed ? t("login.web_shutting_down") : t("install.cancelled", backend);
    }
    if (!this.loginWindow.isCurrent(claim)) {
      await session.cancel("cancelled").catch(() => { /* already finished */ });
      this.activeInstall = null;
      this.loginWindow.release(claim);
      return t("login.web_shutting_down");
    }
    return t("install.started", backend);
  }

  /** Whether this backend's CLI is on the fleet's PATH (what `/login` installs when it is not). */
  isCliInstalled(backend: string): boolean {
    const info = BACKEND_INSTALLATION_INFO[backend];
    return !!info && checkBinaryInstalled(info.binary);
  }

  /** Abort the active install (`/login cancel`) and remove its window. */
  async cancelInstallSession(): Promise<string> {
    if (!this.activeInstall) return t("install.no_session");
    const backend = this.activeInstall.backend;
    await this.activeInstall.session.cancel();
    return t("install.cancelled", backend);
  }

  /** `command -v` on a login shell, so PATH additions from rc files count. */
  /**
   * The absolute path a fresh login shell resolves `binary` to, or null. Only
   * a real executable file counts: `command -v` also answers with an alias
   * definition or a function name, neither of which a spawn could run.
   */
  private locateBinaryOnLoginShell(binary: string): string | null {
    return measureSyncWork("fleet.installLookup", () => this.locateBinaryOnLoginShellSync(binary));
  }
  private locateBinaryOnLoginShellSync(binary: string): string | null {
    try {
      const result = measureSyncWork("fleet.installLoginShell", () => spawnSync("bash", ["-lc", `command -v ${binary}`], { timeout: 10_000, stdio: "pipe", encoding: "utf8" }));
      if (result.status !== 0) return null;
      const path = String(result.stdout ?? "").trim().split("\n").pop()?.trim() ?? "";
      if (!isAbsolute(path)) return null;
      accessSync(path, fsConstants.X_OK);
      return statSync(path).isFile() ? path : null;
    } catch {
      return null;
    }
  }

  /**
   * #1092: the binary in one of the directories its own installer installs to,
   * when no login shell can see it (the installer recorded its PATH in an
   * interactive-only rc file). The same executable-file check as the login
   * shell lookup; a symlink to an executable counts, as codex's launcher is one.
   */
  private locateInInstallerBinDirs(info: BackendInstallationInfo): string | null {
    for (const dir of info.binDirs?.(process.env, homedir()) ?? []) {
      if (!isAbsolute(dir)) continue;
      const path = join(dir, info.binary);
      try {
        accessSync(path, fsConstants.X_OK);
        if (statSync(path).isFile()) return path;
      } catch { /* not there */ }
    }
    return null;
  }

  /** Put an installed binary's directory on the fleet's PATH (#1059), once. */
  private adoptBinaryDirectory(binaryPath: string, backend: string): void {
    const dir = dirname(binaryPath);
    const entries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
    if (entries.includes(dir)) return;
    process.env.PATH = [dir, ...entries].join(delimiter);
    this.logger.info({ backend, dir }, "Added the installed CLI's directory to the fleet PATH");
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
    const chat = { adapter, adapterId, chatId: data.channelId, userId: data.userId };
    if (data.options?.cancel === true) { await data.respond(await this.cancelLoginSession()); return; }
    const backend = String(data.options?.backend ?? "").trim();
    if (backend) {
      const text = await this.startLoginSession(backend, chat);
      await data.respond(text ?? t("login.confirm_posted"));
      return;
    }
    const failure = await this.promptLoginBackends(chat);
    await data.respond(failure ?? t("login.chooser_posted"));
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
    // #1386: a prompt opened or closed, or an instance's state moved — "Needs you" may have changed.
    if (event === "prompt" || event === "prompt_resolved" || event === "activity") this.needsYou?.poke();
    const onError = (err: unknown) => this.logger.debug({ err }, "SSE client write failed; evicting");
    if (event === "message" && data && typeof data === "object") {
      // A chat message: record it, and send it WITH its id so a reconnecting stream can ask for what it missed.
      const m = data as { instance?: unknown; sender?: unknown; text?: unknown; ts?: unknown; attachments?: unknown; messageId?: unknown; role?: unknown; buttons?: unknown };
      const recorded = this.webChatHistory.record({
        instance: String(m.instance ?? ""), sender: String(m.sender ?? ""), text: String(m.text ?? ""), ts: String(m.ts ?? new Date().toISOString()),
        attachments: Array.isArray(m.attachments) ? m.attachments as WebChatAttachment[] : undefined,
        messageId: typeof m.messageId === "string" ? m.messageId : undefined,
        role: typeof m.role === "string" ? m.role : undefined,
        buttons: m.buttons,
      });
      broadcastSseEvent(this.sseClients, event, recorded, onError, this.webChatHistory.cursorOf(recorded));
      return;
    }
    // #1266: a reply's buttons ended — the history shows it too (a later load, the public link's poll).
    if (event === "reply_buttons" && data && typeof data === "object") {
      const u = data as { instance?: unknown; buttons?: unknown };
      this.webChatHistory.updateButtons(String(u.instance ?? ""), u.buttons);
    }
    broadcastSseEvent(this.sseClients, event, data, onError);
  }

  listClaimedTasks(assignee: string): Array<{ id: string; title: string }> {
    try {
      return this.scheduler?.db.listTasks({ assignee, status: "claimed" }) ?? [];
    } catch { return []; }
  }

  async sendHangNotification(instanceName: string, unchangedForMs?: number): Promise<void> {
    const web = this.webOnlyPromptPlace();     // no chat platform: asked on the dashboard (#1307 item 6)
    const adapter = web?.adapter ?? this.getAdapterForInstance(instanceName) ?? this.adapter;
    const adapterId = web?.adapterId ?? this.getInstanceAdapterId(instanceName);
    // Same three-way addressing as sendCancelButton: fleet topic → group+thread,
    // Classic → its own channel (Classic instances are absent from
    // fleetConfig.instances, so the topic path can never address them), else the
    // world group flat. getGroupIdForInstance (not getChannelConfig().group_id)
    // because on channels[]-configured fleets the legacy channel: block is empty.
    const topicId = this.fleetConfig?.instances[instanceName]?.topic_id;
    const groupId = this.getGroupIdForInstance(instanceName) || undefined;
    let chatId: string | undefined;
    let threadId: string | undefined;
    if (web) {
      chatId = web.chatId;
    } else if (topicId != null && groupId) {
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
    "opencode": "AGENTS.md",
    "kiro-cli": ".kiro/steering/project.md",
    // Grok reads AGENTS.md project docs; agy reads .agents/agents.md — the
    // same files their writeConfig() appends fleet instructions to.
    "grok": "AGENTS.md",
    // muse init scaffolds AGENTS.md and the binary reads it as project rules.
    "muse": "AGENTS.md",
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

Instance discovery: start with list_instances(); follow the guidance in its response. Prefer reuse; never duplicate a running instance.

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
    measureSyncWork("fleet.generalInstructions", () => this.ensureGeneralInstructionsSync(workDir, backendName, instanceName));
  }
  private ensureGeneralInstructionsSync(workDir: string, backendName?: string, instanceName?: string): void {
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
   * antigravity) are deliberately absent: dropping files a CLI
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
    // Live-verified on muse 1.3.0: `muse skills list --source project` sees
    // .agents/skills and ignores .muse/skills.
    "muse": [".agents", "skills"],
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
        // The user's skill still wins on every sync; only the warning is deduped.
        if (!this.skippedBundledSkills.has(name)) {
          this.skippedBundledSkills.add(name);
          this.logger.warn({ skill: name, destSkills },
            "Skipping bundled skill — a skill of this name exists but was not published by AgEnD");
        }
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

  /**
   * #1346: on Discord, plain-text /xxx is never a command — the slash menu
   * is. Both fleet call sites run this BEFORE the command handlers, so even
   * the owning adapter's copy never executes text. The owning adapter posts
   * one system note and consumes the message so it never reaches the agent;
   * other adapters' copies stay silent (and the shared dedup key means
   * exactly one copy gets here). Telegram keeps text commands working —
   * text is its command path — and other sources pass through untouched.
   */
  private async replyDiscordNotACommand(msg: InboundMessage, instanceName: string): Promise<boolean> {
    if (msg.source !== "discord") return false;
    if (!/^\/\w/.test(msg.text?.trim() ?? "")) return false;
    const owner = this.getInstanceAdapterId(instanceName);
    if (msg.adapterId && owner && msg.adapterId !== owner) return false;
    const adapter = this.worlds.get(owner ?? msg.adapterId ?? "")?.adapter ?? this.adapter;
    if (!adapter) return false;
    await adapter.sendText(msg.chatId, t("cmd.not_a_command"), { threadId: msg.threadId });
    return true;
  }

  /** Handle a message in a classic channel: log it, forward only /chat messages */
  private async handleClassicChannelMessage(instanceName: string, msg: InboundMessage): Promise<void> {
    const text = msg.text ?? "";
    const channelId = msg.threadId ?? msg.chatId;
    const isCollabMode = this.classicChannels?.isCollab(channelId, msg.adapterId) ?? false;

    // #1346: Discord ClassicBot channels ignore plain-text /xxx silently —
    // no warning (multi-bot groups must not all warn), no command, and no
    // forward to the agent either. The received-reaction and chat-log paths
    // below still run (a /chat ack is not a reply). Telegram keeps working
    // (text is its command path there).
    const discordSlashText = msg.source === "discord" && /^\/\w/.test(text.trim());

    // Handle /ctx in classic mode — always, regardless of collab mode.
    // Only the adapter that owns an entry in this channel answers; the
    // per-adapter dedup key already scopes copies, this guards the rest.
    // Discord /chat still flows through (its received-reaction below is an
    // ack, not a reply); only its forward is skipped.
    if (discordSlashText && !/^\/chat(\s|$)/.test(text.trim())) return;
    if (text === "/ctx" || text.startsWith("/ctx@")) {
      if (!this.classicChannels?.getInstanceByChannel(channelId, msg.adapterId)) return;
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
            const emoji = this.savedAttachmentReactionFor(instanceName, reactAdapter, msg.adapterId, saved.kind);
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
        this.reactClassicReceived(instanceName, classicAdapter, msg)
          .catch(e => this.logger.debug({ err: (e as Error).message }, "Auto-react failed"));
      }

      // Block /raw bypass — check the mention-stripped text so the self-marker
      // prefix can't be used to sneak "/raw" past this gate.
      if (strippedText.startsWith("/raw ")) return;

      // Attachments already saved at the top of the collab block.
      if (saved && classicAdapter && collabReactChatId && msg.messageId) {
        this.reactClassicForwardedAttachment(instanceName, classicAdapter, msg, saved.kind)
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

      // #1346: Discord typed /xxx is never forwarded (reacts above already ran).
      if (!discordSlashText) await this.forwardToClassicInstance(instanceName, finalText, msg, extraMeta);
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
        const emoji = this.savedAttachmentReactionFor(instanceName, reactAdapter, msg.adapterId, saved.kind);
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
      this.reactClassicReceived(instanceName, classicMsgAdapter, msg)
        .catch(e => this.logger.debug({ err: (e as Error).message }, "Auto-react failed"));
      if (saved) {
        this.reactClassicForwardedAttachment(instanceName, classicMsgAdapter, msg, saved.kind)
          .catch(e => this.logger.debug({ err: (e as Error).message }, "Auto-react failed"));
      }
    }

    // #1346: Discord typed /chat gets its received-reaction above but is
    // never forwarded to the agent.
    if (!discordSlashText) await this.forwardToClassicInstance(instanceName, finalText, msg, extraMeta);
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
    msg: { chatId: string; threadId?: string; transportThreadId?: string; messageId: string; userId: string; username: string; source: string; timestamp: Date; replyToText?: string; adapterId?: string },
    extraMeta?: Record<string, string>,
  ): Promise<void> {
    // #1085: a Telegram forum ClassicBot is keyed by chat id (threadId), but the
    // reply context must carry the topic the message was really asked in.
    const replyThreadId = msg.transportThreadId ?? msg.threadId;
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
      thread_id: replyThreadId ?? "",
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
    this.trackInboundMsg(instanceName, { ...msg, threadId: replyThreadId });
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

  /** Return cached CLI versions immediately. Refresh is started after /sysinfo is sent. */
  getBackendCliVersionSnapshot(): BackendCliVersionSnapshot {
    const snapshot = {} as BackendCliVersionSnapshot;
    for (const backend of SYSINFO_BACKEND_IDS) {
      const cached = this.readCliEnv(backend);
      const needsRefresh = this.cliEnvNeedsRefresh(cached);
      const version = typeof cached?.version === "string" && cached.version.trim()
        ? cached.version.trim()
        : null;
      snapshot[backend] = {
        version,
        probing: needsRefresh && version === null,
      };
    }
    return snapshot;
  }

  /** Called only after the user-visible sysinfo send/respond has settled. */
  refreshBackendCliVersions(): void {
    for (const backend of SYSINFO_BACKEND_IDS) {
      if (!this.cliEnvNeedsRefresh(this.readCliEnv(backend))) continue;
      void this.probeBackendBounded(backend).catch(err => {
        this.logger.debug({ err, backend }, "Background CLI version refresh failed");
      });
    }
  }

  /** True when a cached CLI env is old enough that `/model` should re-probe. */
  private cliEnvNeedsRefresh(env: import("./backend/types.js").CliEnv | null): boolean {
    return !env || typeof env.probedAt !== "number" || Date.now() - env.probedAt >= CLI_ENV_FRESH_MS;
  }

  /**
   * Run a live probe under a deadline, falling back to whatever the cache holds.
   * A model list is an aid: a vendor that stops answering must degrade to the
   * previous list, never stall the command that asked for it.
   */
  private async probeBackendBounded(
    backend: string,
    opts: { refreshVendorCatalog?: boolean } = {},
  ): Promise<import("./backend/types.js").CliEnv | null> {
    // #725: single-flight per backend. Explicit vendor refreshes remain a
    // separate flight from an ordinary probe, while sysinfo can join either.
    const regularFlight = this.pendingCliEnvProbes.get(backend);
    const vendorFlight = this.pendingVendorCliEnvProbes.get(backend);
    if (opts.refreshVendorCatalog && vendorFlight) return vendorFlight;
    if (!opts.refreshVendorCatalog && (vendorFlight || regularFlight)) return vendorFlight ?? regularFlight!;

    if (this.shuttingDown) return null;
    const instanceDir = join(getAgendHome(), "cli-env");
    const epoch = this.cliEnvProbeEpoch;
    const input: BackendProbeInput = {
      mode: "env", backend, instanceDir,
      config: { workingDirectory: "", instanceDir, instanceName: `probe-${backend}`, mcpServers: {} },
      refreshVendorCatalog: opts.refreshVendorCatalog === true,
    };
    const bounded = this.runBackendProbeWorker(`global:${backend}`, input).then(probed => {
      if (!probed || Array.isArray(probed) || this.shuttingDown || epoch !== this.cliEnvProbeEpoch) return null;
      try { return this.persistCliEnvProbeResult(backend, probed); }
      catch (err) { this.logger.warn({ backend, err }, "CLI env cache write failed"); return null; }
    }).finally(() => {
      const flights = opts.refreshVendorCatalog ? this.pendingVendorCliEnvProbes : this.pendingCliEnvProbes;
      if (flights.get(backend) === bounded) flights.delete(backend);
    });
    (opts.refreshVendorCatalog ? this.pendingVendorCliEnvProbes : this.pendingCliEnvProbes).set(backend, bounded);
    return bounded;
  }

  private stopCliEnvProbes(): void {
    this.cliEnvProbeEpoch++;
    this.cliEnvProbePool.close();
    this.pendingCliEnvProbes.clear();
    this.pendingVendorCliEnvProbes.clear();
    this.pendingInstanceModelProbes.clear();
  }

  private runBackendProbeWorker(key: string, input: BackendProbeInput): Promise<BackendProbeResult | null> {
    if (this.shuttingDown) return Promise.resolve(null);
    this.cliEnvProbePool.reopen();
    return this.cliEnvProbePool.run(key, () => this.startCliEnvProbeWorker(input), {
      deadlineMs: CLI_ENV_PROBE_DEADLINE_MS,
      onTimeout: () => this.logger.warn({ backend: input.backend, deadlineMs: CLI_ENV_PROBE_DEADLINE_MS },
        "CLI env live probe exceeded its deadline — serving the cached model list"),
      onError: err => this.logger.warn({ backend: input.backend, err }, "CLI env worker failed to start or stop"),
    });
  }

  private startCliEnvProbeWorker(input: BackendProbeInput): ProbeWorker<BackendProbeResult> {
    const { backend } = input;
    const workerData = input;
    // `tsx src/cli.ts` needs its TS module resolver inside the separate isolate.
    // Published builds load the compiled worker and require no tsx dependency.
    const worker = import.meta.url.endsWith(".ts")
      ? new Worker(
        `const { workerData } = require("node:worker_threads"); import("tsx/esm/api").then(({ tsImport }) => tsImport(workerData.entry, workerData.entry));`,
        { eval: true, execArgv: [], workerData: { ...workerData, entry: new URL("./backend/cli-env-probe-worker.ts", import.meta.url).href } },
      )
      : new Worker(new URL("./backend/cli-env-probe-worker.js", import.meta.url), { execArgv: [], workerData });
    let settled = false;
    let resolveProbe!: (value: BackendProbeResult | null) => void;
    let markStopped!: () => void;
    const stopped = new Promise<void>(resolve => { markStopped = resolve; });
    const promise = new Promise<BackendProbeResult | null>(resolve => { resolveProbe = resolve; });
    const finish = (value: BackendProbeResult | null) => {
      if (settled) return;
      settled = true;
      resolveProbe(value);
      // Admission stays occupied until terminate resolves or an exit is seen.
      // A rejected termination does not prove the isolate has stopped.
      try {
        void worker.terminate().then(markStopped).catch(err => {
          this.logger.debug({ backend, err }, "CLI env worker termination failed");
        });
      } catch (err) {
        this.logger.debug({ backend, err }, "CLI env worker termination failed");
      }
    };
    worker.once("message", (message: { ok?: boolean; result?: BackendProbeResult | null; error?: string }) => {
      if (settled) return;
      if (!message.ok) this.logger.warn({ backend, error: message.error }, "CLI env worker failed");
      finish(message.ok ? message.result ?? null : null);
    });
    worker.once("error", err => {
      if (settled) return;
      this.logger.warn({ backend, err }, "CLI env worker crashed");
      finish(null);
    });
    worker.once("exit", code => {
      markStopped();
      if (settled) return;
      this.logger.warn({ backend, code }, "CLI env worker exited without a result");
      finish(null);
    });
    return { promise, stopped, terminate: () => { finish(null); } };
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
    return done("default", "unresolved", cliEnv ? "this CLI does not report a default" : "detected when it starts");
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

  /** Preserve the existing cache merge rules for worker probes. */
  private persistCliEnvProbeResult(
    backend: string,
    probed: Omit<import("./backend/types.js").CliEnv, "backend" | "probedAt">,
  ): import("./backend/types.js").CliEnv {
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
    // Effort levels read from --help (#1328) are a capability of one binary. A help that could not be read (absent)
    // keeps the cached levels only for that same binary: both versions known and equal, cache still valid. A help
    // that was read and lists none ([]) is an answer and is written as is, so the fallback applies.
    if (env.effortLevels === undefined) {
      const previous = this.readCliEnv(backend);
      if (previous?.effortLevels && previous.version && env.version && previous.version === env.version) {
        env.effortLevels = previous.effortLevels;
      }
    }
    const path = this.cliEnvPath(backend);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(env, null, 2));
    return env;
  }

  /** Background-probe every distinct backend in use at startup (non-blocking). */
  private probeCliEnvs(): void {
    const backends = new Set<string>();
    if (this.fleetConfig?.defaults?.backend) backends.add(this.fleetConfig.defaults.backend);
    for (const inst of Object.values(this.fleetConfig?.instances ?? {})) if (inst.backend) backends.add(inst.backend);
    for (const ch of this.classicChannels?.getAll() ?? []) if (ch.backend) backends.add(ch.backend);
    if (backends.size === 0) backends.add("claude-code");
    // #724: use the bounded variant so background startup probes cannot hang
    // indefinitely — each is wrapped by CLI_ENV_PROBE_DEADLINE_MS.
    for (const b of backends) void this.probeBackendBounded(b);
  }

  /** Best-effort model list for `/model`: cached CLI env first, else live probe. Never throws. */
  private async getModelOptions(
    instanceName: string,
    refresh = false,
    onLiveProbe?: () => void,
  ): Promise<import("./backend/types.js").ModelOption[]> {
    return (await this.getModelOptionsWithSource(instanceName, { refresh, onLiveProbe })).models;
  }

  /**
   * The model list plus where it came from. `source` is "live" only when a probe
   * actually ran and answered; a refresh that failed or ran out of time reports
   * "cache" with the previous list, so a menu can say "could not refresh"
   * instead of presenting an old list as a fresh one.
   */
  private async getModelOptionsWithSource(
    instanceName: string,
    opts: { refresh?: boolean; refreshVendorCatalog?: boolean; onLiveProbe?: () => void } = {},
  ): Promise<{ models: import("./backend/types.js").ModelOption[]; source: "live" | "cache" }> {
    const backendName = this.backendNameForInstance(instanceName);
    const cached = this.readCliEnv(backendName);
    if (!opts.refresh && cached?.models.length && !this.cliEnvNeedsRefresh(cached)) {
      return { models: cached.models, source: "cache" };
    }
    // About to go to the vendor: let the caller say so. A silent 1–10s pause on
    // an interactive command reads as another hang, which is the wrong lesson to
    // teach a user who has just been bitten by one.
    opts.onLiveProbe?.();
    // Stale, missing, or a forced refresh → probe live (also refreshes the cache).
    // A newly released model is invisible until this runs, which is why staleness
    // triggers it rather than waiting for the 24h hard expiry or a cold start.
    const env = await this.probeBackendBounded(backendName, { refreshVendorCatalog: opts.refreshVendorCatalog });
    if (env?.models.length) return { models: env.models, source: "live" };
    // Probe failed or timed out: the previous list is still the best answer.
    return { models: cached?.models ?? [], source: "cache" };
  }

  /**
   * The /model menu's choices, in the one order all three pickers share:
   * 🔄 Refresh first, then models, then (claude) "More models…". Refresh takes
   * a slot inside Discord's 25-option select cap, so it is paid for from the
   * model rows, never from "More models…".
   */
  private modelMenuChoices(
    instanceName: string,
    nonce: string,
    options: import("./backend/types.js").ModelOption[],
    currentModel: string,
  ): { id: string; label: string }[] {
    const isClaude = this.backendNameForInstance(instanceName) === "claude-code";
    const choices = [{ id: `${MODEL_SELECT_CALLBACK_PREFIX}${nonce}:__refresh__`, label: t("model.refresh") }];
    for (const o of options.slice(0, isClaude ? 23 : 24)) {
      choices.push({ id: `${MODEL_SELECT_CALLBACK_PREFIX}${nonce}:${o.id}`, label: this.modelChoiceLabel(o, currentModel) });
    }
    if (isClaude) choices.push({ id: `${MODEL_SELECT_CALLBACK_PREFIX}${nonce}:__more__`, label: t("model.more") });
    return choices;
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
      const config = structuredClone({
        workingDirectory: inst?.working_directory ?? "",
        instanceDir,
        instanceName,
        mcpServers: {},
        model: inst?.model,
        backendOptions: inst?.backend_options?.[backend] ?? this.fleetConfig?.defaults?.backend_options?.[backend],
      });
      // Include the config snapshot, so a changed provider/profile cannot join
      // a still-running probe for the previous instance configuration.
      const key = JSON.stringify({ backend, instanceDir, config });
      const pending = this.pendingInstanceModelProbes.get(key);
      if (pending) return pending;
      const epoch = this.cliEnvProbeEpoch;
      const bounded = this.runBackendProbeWorker(`instance:${backend}:${instanceDir}`, {
        mode: "models", backend, instanceDir, config,
      }).then(result => Array.isArray(result) && !this.shuttingDown && epoch === this.cliEnvProbeEpoch ? result : [])
        .finally(() => {
          if (this.pendingInstanceModelProbes.get(key) === bounded) this.pendingInstanceModelProbes.delete(key);
        });
      this.pendingInstanceModelProbes.set(key, bounded);
      return bounded;
    } catch {
      // listModels is documented never to throw, but a backend constructor can
      // (missing binary). A catalog is an aid; degrade to the account list.
      return [];
    }
  }

  /**
   * Account-wide catalog: probe cache first, live probe when the cache is
   * missing or older than the same ~1h window `/model` uses (#888).
   *
   * Previously this served anything inside the 24h hard TTL, so `list_models`
   * could answer with a day-old list `/model` had already re-probed past.
   * The probe runs under the same deadline `/model` uses: a vendor that stops
   * answering degrades to the previous list, never stalls the tool call.
   */
  private async globalModelCatalog(backend: string): Promise<ModelCatalog> {
    const cached = this.readCliEnv(backend);
    if (cached?.models?.length && !this.cliEnvNeedsRefresh(cached)) {
      return {
        backend, scope: "global", current_model: cached.currentModel ?? null,
        models: cached.models, source: "cache",
        probed_at: new Date(cached.probedAt).toISOString(),
      };
    }
    const env = await this.probeBackendBounded(backend);
    if (env?.models?.length) {
      return {
        backend, scope: "global", current_model: env.currentModel ?? null,
        models: env.models, source: "live",
        probed_at: new Date(env.probedAt).toISOString(),
      };
    }
    // Probe failed or timed out: like `/model`, the previous list is still the
    // best answer — a stale list beats an empty one.
    if (cached?.models?.length) {
      return {
        backend, scope: "global", current_model: cached.currentModel ?? null,
        models: cached.models, source: "cache",
        probed_at: new Date(cached.probedAt).toISOString(),
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
    this.pendingEffortSelects.set(nonce, { instanceName: name, userId: data.userId, channelId: data.channelId, adapterId, timer, respond: data.respond });
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
    adapterId?: string,
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
    this.pendingEffortSelects.set(nonce, { instanceName, userId, channelId, adapterId, timer, respond, adapter, adapterChatId: chatId, adapterThreadId: threadId });
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
  private async handleEffortSelection(data: AdapterCallbackData, adapterId: string): Promise<boolean> {
    if (!data.callbackData.startsWith(EFFORT_SELECT_CALLBACK_PREFIX)) return false;
    const match = data.callbackData.match(/^effort-select:([0-9a-f]+):(.+)$/);
    if (!match) return true;
    const pending = this.pendingEffortSelects.get(match[1]);
    if (!pending) return true;
    // The admin who opened the menu, through the adapter that posted it, in the same channel — and still an admin
    // when they click (#754 audit): the menu lives for a minute, and a click carries its own callback data.
    const cbChannel = data.threadId ?? data.chatId;
    if (!data.userId || data.userId !== pending.userId
      || (pending.adapterId !== undefined && pending.adapterId !== adapterId)
      || (cbChannel !== pending.channelId && data.chatId !== pending.channelId)
      || !this.menuClickStillCurrent(pending.instanceName, data.userId, pending.channelId, adapterId, pending.adapterChatId)) {
      data.ack?.(t("buttons.admin_only"));
      return true;
    }
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
        // Asked again after the progress edit awaited above: the instance may have moved, or the admin lost admin.
        result = this.menuClickStillCurrent(pending.instanceName, data.userId!, pending.channelId, adapterId, pending.adapterChatId)
          ? await this.applyEffort(pending.instanceName, level) : t("menu.click_stale");
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
    const options = await this.getModelOptions(name, isRefresh, () => {
      void data.respond(t("model.refreshing")).catch(() => { /* the menu still follows */ });
    });
    if (options.length === 0) { await data.respond(t("model.list_unavailable", name)); return; }

    // Raw id for ✓-matching options; display resolves an inherited CLI default.
    const { model: currentModel, display: currentDisplay } = this.resolveInstanceModel(name);
    const nonce = randomBytes(6).toString("hex");
    const choices = this.modelMenuChoices(name, nonce, options, currentModel);
    const timer = setTimeout(() => this.pendingModelSelects.delete(nonce), CLASSIC_BACKEND_SELECTION_TIMEOUT_MS);
    timer.unref?.();
    this.pendingModelSelects.set(nonce, { instanceName: name, model: "", userId: data.userId, channelId: data.channelId, adapterId, timer, respond: data.respond, respondChoices: data.respondChoices });
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
    adapterId?: string,
  ): Promise<string | null> {
    const options = await this.getModelOptions(instanceName);
    if (options.length === 0) {
      return t("model.list_unavailable", instanceName);
    }

    const { model: currentModel, display: currentDisplay } = this.resolveInstanceModel(instanceName);
    const nonce = randomBytes(6).toString("hex");
    const choices = this.modelMenuChoices(instanceName, nonce, options, currentModel);

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

    this.pendingModelSelects.set(nonce, { instanceName, model: "", userId, channelId, adapterId, timer, respond, adapter, adapterChatId: chatId, adapterThreadId: threadId });

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
    const env = await this.probeBackendBounded("claude-code");
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

  /**
   * "🔄 Refresh models" (#886): probe live past both caches and redraw the menu.
   *
   * Past AgEnD's cli-env cache (refresh=true) and, where the backend supports
   * it, past the CLI's own catalog cache too (codex: `codex debug models`).
   * Without the second half, a codex refresh re-read the same models_cache.json
   * and showed the old list as new.
   *
   * A failed refresh keeps the previous list and says so. It never blanks the
   * menu, because a picker with no rows cannot even offer another refresh.
   */
  private async refreshModelMenu(pending: {
    instanceName: string; userId: string; channelId: string;
    respond: (t: string) => Promise<string | undefined>;
    adapter?: ChannelAdapter; adapterChatId?: string; adapterThreadId?: string; menuMessageId?: string;
    respondChoices?: (text: string, choices: { id: string; label: string }[]) => Promise<string | undefined>;
  }): Promise<void> {
    const { models, source } = await this.getModelOptionsWithSource(pending.instanceName, {
      refresh: true, refreshVendorCatalog: true,
    });
    if (models.length === 0) {
      await pending.respond(t("model.list_unavailable", pending.instanceName)).catch(() => {});
      return;
    }
    const { model: currentModel, display: currentDisplay } = this.resolveInstanceModel(pending.instanceName);
    const nonce = randomBytes(6).toString("hex");
    const choices = this.modelMenuChoices(pending.instanceName, nonce, models, currentModel);
    const status = source === "live" ? t("model.refreshed") : t("model.refresh_failed");
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
        await pending.respondChoices(`${status}\n${t("model.menu", `**${currentDisplay}**`)}`, choices);
        return;
      }
      if (pending.adapter && pending.adapterChatId) {
        // Telegram: retire the consumed keyboard, then post the redrawn menu.
        if (pending.menuMessageId && pending.adapter.editMessageRemoveButtons) {
          await pending.adapter.editMessageRemoveButtons(
            pending.adapterChatId, pending.menuMessageId, t("model.refresh"), pending.adapterThreadId,
          ).catch(() => {});
        }
        const menuMessageId = await pending.adapter.promptUser(
          pending.adapterChatId, `${status}\n${t("model.menu", currentDisplay)}`, choices,
          { threadId: pending.adapterThreadId },
        );
        const fresh = this.pendingModelSelects.get(nonce);
        if (fresh) fresh.menuMessageId = menuMessageId;
        return;
      }
      await pending.respond(t("model.usage")).catch(() => {});
    } catch (err) {
      this.pendingModelSelects.delete(nonce);
      clearTimeout(timer);
      this.logger.warn({ err, instanceName: pending.instanceName }, "Refreshed model menu failed");
      await pending.respond(t("model.usage")).catch(() => {});
    }
  }

  /**
   * A /model or /effort menu click may still act (#1396 review): the instance is still owned by the adapter the click
   * came through (it may have been rebound since the menu opened) and the clicker is still that channel's admin. Asked
   * when the click is claimed and again right before the change is applied.
   */
  private menuClickStillCurrent(instanceName: string, userId: string, channelId: string, adapterId: string, sourceChatId?: string): boolean {
    return this.commandChannelStillTargets(instanceName, channelId, adapterId, sourceChatId)
      && this.isModelAdmin(userId, channelId, adapterId);
  }

  /** Current source-to-target mapping, including same-adapter topic moves. */
  private commandChannelStillTargets(instanceName: string, channelId: string, adapterId: string, sourceChatId?: string): boolean {
    if (this.getInstanceAdapterId(instanceName) !== adapterId) return false;
    const classic = this.classicChannels?.getInstanceByChannel(channelId, adapterId);
    if (classic !== undefined) return classic === instanceName;
    // Read the current config rather than relying on a pre-reload route cache.
    const targets = Object.entries(this.fleetConfig?.instances ?? {}).filter(([name, cfg]) =>
      cfg.topic_id != null && String(cfg.topic_id) === channelId && this.getInstanceAdapterId(name) === adapterId);
    // A duplicate within one world is ambiguous (the slash table keeps the
    // last registration). Never authorize an old menu via the first match.
    if (targets.length > 1) return false;
    const channel = this.getChannelConfig(adapterId);
    if (targets.length === 1) return targets[0][0] === instanceName
      && (channel?.type !== "telegram" || sourceChatId !== undefined
        && channel.group_id != null && String(channel.group_id) === sourceChatId);
    // Root General menus carry the group address, not the logical topic id.
    return channel?.type === "telegram" && channel.group_id != null && String(channel.group_id) === channelId
      && this.fleetConfig?.instances[instanceName]?.general_topic === true
      && this.findGeneralInstance(adapterId) === instanceName;
  }

  /** Consume a `/model` selection callback. Returns true for all model-select ids (incl. stale). */
  private async handleModelSelection(data: AdapterCallbackData, adapterId: string): Promise<boolean> {
    if (!data.callbackData.startsWith(MODEL_SELECT_CALLBACK_PREFIX)) return false;
    const match = data.callbackData.match(/^model-select:([0-9a-f]+):(.+)$/);
    if (!match) return true;
    const pending = this.pendingModelSelects.get(match[1]);
    if (!pending) return true;
    // The admin who opened the menu, through the adapter that posted it, in the same channel — and still an admin
    // when they click (#754 audit): the menu lives for a minute, and a click carries its own callback data.
    const cbChannel = data.threadId ?? data.chatId;
    if (!data.userId || data.userId !== pending.userId
      || (pending.adapterId !== undefined && pending.adapterId !== adapterId)
      || (cbChannel !== pending.channelId && data.chatId !== pending.channelId)
      || !this.menuClickStillCurrent(pending.instanceName, data.userId, pending.channelId, adapterId, pending.adapterChatId)) {
      data.ack?.(t("buttons.admin_only"));
      return true;
    }
    this.pendingModelSelects.delete(match[1]);
    clearTimeout(pending.timer);

    const model = match[2];
    // "More models…" is a navigation choice, not a model: swap the menu for the
    // full account catalog (live /v1/models with [1m] variants).
    if (model === "__more__") {
      await this.expandClaudeModelMenu(pending);
      return true;
    }
    // "🔄 Refresh models" is navigation too: re-probe past every cache and
    // redraw the same menu with what came back.
    if (model === "__refresh__") {
      await this.refreshModelMenu(pending);
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
        // Asked again after the progress edit awaited above: the instance may have moved, or the admin lost admin.
        result = this.menuClickStillCurrent(pending.instanceName, data.userId!, pending.channelId, adapterId, pending.adapterChatId)
          ? await this.applyModel(pending.instanceName, model) : t("menu.click_stale");
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
      const { strategy, levels } = readEffortMetadata(this.backendNameForInstance(instanceName), this.getInstanceDir(instanceName));
      return strategy !== "unsupported" && levels.length > 0 ? strategy : "unsupported";
    } catch { return "unsupported"; }
  }

  /** Effort levels this instance's backend actually accepts (empty = unsupported). */
  effortLevelsFor(instanceName: string): string[] {
    try {
      const { strategy, levels } = readEffortMetadata(this.backendNameForInstance(instanceName), this.getInstanceDir(instanceName));
      return strategy === "unsupported" ? [] : levels;
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
    // Reject model names with newlines or control characters: they would be
    // persisted to fleet.yaml and pasted raw into the CLI (P3 from #1490 audit).
    if (/[\x00-\x1f\x7f]/.test(model)) {
      return t("model.invalid_chars");
    }
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
      // Only the end of today's log is needed (#1161): a day's log used to be read and split whole for every message.
      return recentChatContext(logFile, maxLines, CHAT_LOG_TAIL_BYTES, CHAT_LOG_TAIL_MAX_BYTES);
    } catch { return undefined; }
  }

  /**
   * The ClassicBot /start replies say how to talk to the agent, and that differs by platform (#1196): on Telegram
   * you @mention the bot; on Discord, @mention or `/chat`. The chat's platform is the adapter it came through.
   */
  private classicStartKey(key: "classic.started" | "classic.already_active", adapterId?: string): string {
    const adapter = (adapterId ? this.worlds.get(adapterId)?.adapter : undefined) ?? this.adapter;
    return adapter?.type === "telegram" ? `${key}.telegram` : key;
  }

  /** Approval is a system notification: General's agent need not be running. */
  private findClassicApprovalGeneral(adapterId?: string): string | undefined {
    const generals = Object.entries(this.fleetConfig?.instances ?? {}).filter(([, cfg]) => cfg.general_topic === true);
    return (adapterId ? generals.find(([name, cfg]) => (cfg.channel_id ?? this.getInstanceAdapterId(name)) === adapterId) : undefined)?.[0]
      ?? generals[0]?.[0];
  }

  /** Return a user-facing blocker without mutating ClassicBot state. */
  private validateClassicStart(channelId: string, userId: string, guildId?: string, adapterId?: string): string | undefined {
    const classic = this.classicChannels;
    if (!classic) return t("classic.manager_unavailable");
    // Admission applies only to NEW channels. Revoking a start grant never
    // blocks an existing agent's chat or changes its registration.
    if (classic.isClassicChannel(channelId, adapterId)) return t(this.classicStartKey("classic.already_active", adapterId));
    if (this.routing.resolve(channelId)) return t("classic.topic_bound");
    const adapter = (adapterId ? this.worlds.get(adapterId)?.adapter : undefined) ?? this.adapter;
    // Discord DMs remain unsupported, including direct calls outside the slash door.
    if (!guildId && adapter?.type === "discord") return t("slash.dm_unsupported");
    // C is distinct from fleet admin. Only C bypasses new-channel admission.
    if (classic.isAdmin(userId)) return undefined;
    const scope = guildId ? "guild" : channelId.startsWith("-") ? "group" : "user";
    const targetId = guildId ?? (scope === "user" ? userId : channelId);
    const allowed = scope === "guild" ? classic.isGuildAllowed(targetId)
      : scope === "group" ? classic.isGroupAllowed(targetId) : classic.isUserAllowed(targetId);
    if (!allowed) {
      const generalName = this.findClassicApprovalGeneral(adapterId);
      if (generalName) {
        const message = scope === "guild" ? t("alert.unauth_guild", targetId, userId)
          : scope === "group" ? t("alert.new_group", channelId, targetId, userId, userId, "telegram")
          : t("alert.unauth_user_private", userId, userId, "telegram");
        void this.promptClassicApproval({
          generalName, message, groupId: String(targetId), scope, userId,
          replyTo: adapter ? { adapterId: adapter.id, adapter, chatId: channelId } : undefined,
        }).catch(err => this.logger.warn({ err, scope }, "Classic approval prompt failed"));
      } else {
        this.logger.warn({ adapterId, scope }, "Classic access request has no running General");
      }
      return t("classic.access_requested");
    }
    // Preserve the existing group start role. Allow only grants the group;
    // Allow+admin also gives the requester permission to start there.
    if (scope === "group") {
      const generalName = this.findClassicApprovalGeneral(adapterId);
      if (generalName) this.notifyInstanceTopic(generalName, t("alert.start_not_admin", userId, userId, "telegram", channelId));
      return t("classic.admin_only_start");
    }
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

    const blocker = this.validateClassicStart(data.channelId, data.userId, data.guildId, adapterId);
    if (blocker) { await data.respond(blocker); return; }
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
    transition?: TransitionHandle,
    execution?: SettingsExecution,
  ): Promise<void> {
    execution?.assert();
    if (this.daemons.has(instanceName)) return;
    const workDir = join(getAgendHome(), "workspaces", instanceName);
    ensureWorkspaceGit(workDir);
    const classicIdentity = this.classicChannels?.getAll().find(ch => ch.instanceName === instanceName);
    const toolProgress = classicIdentity
      ? this.classicChannels?.getToolProgress(
        classicIdentity.channelId,
        classicIdentity.adapterId,
        this.fleetConfig?.defaults?.tool_progress,
      )
      : this.fleetConfig?.defaults?.tool_progress;
    const replyCompletionGuard = classicIdentity
      ? this.classicChannels?.getReplyCompletionGuard(
        classicIdentity.channelId,
        classicIdentity.adapterId,
        this.fleetConfig?.defaults?.reply_completion_guard,
      )
      : this.fleetConfig?.defaults?.reply_completion_guard;
    const config: InstanceConfig = {
      ...DEFAULT_INSTANCE_CONFIG,
      ...this.fleetConfig?.defaults,
      working_directory: workDir,
      lightweight: true,
      tool_progress: toolProgress ?? "off",
      reply_completion_guard: replyCompletionGuard ?? true,
      ...(backend ? { backend } : {}),
      ...(model ? { model } : {}),
      ...(classicIdentity?.displayName ? { display_name: classicIdentity.displayName } : {}),
      ...(classicIdentity?.description ? { description: classicIdentity.description } : {}),
      ...(autoPauseAfter !== undefined ? { auto_pause_after: autoPauseAfter } : {}),
      ...(preTaskCommand ? { pre_task_command: preTaskCommand } : {}),
    };
    // #1220: a channel's own backend_options (credential_profile) override the
    // fleet defaults' per backend, as a fleet.yaml instance's do.
    config.backend_options = mergeBackendOptions(config.backend_options, classicIdentity?.backendOptions);
    // ClassicBot has no validator in front of its launch, and a backend that
    // cannot read a profile name falls back to the shared login. Refuse here,
    // so a bad name never runs the agent on the wrong subscription.
    const profile = profileOf(config.backend_options, config.backend ?? "claude-code");
    if (profile.state === "invalid") {
      throw new Error(`Classic instance '${instanceName}' has an invalid credential_profile (${profile.reason}) — `
        + "fix it in classicBot.yaml; it will not start on another login");
    }
    const topicMode = this.fleetConfig?.channel?.mode === "topic";
    if (execution) await this.startInstance(instanceName, config, topicMode, "classic", false, transition, execution);
    else await this.startInstance(instanceName, config, topicMode, "classic", false, transition);
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
    return t(this.classicStartKey("classic.started", adapterId));
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
    this.settingsGeneration++; this.settingsConfirmation?.store.close(); this.settingsConfirmation = null;
    const settingsControl = this.settingsControl; this.settingsControl = null;
    const settingsControlStopped = settingsControl?.close();
    const publicStopped = this.publicWebLink?.close("fleet shutdown");
    // #1386: every live "Needs you" message says the fleet stopped (capabilities revoked first) — while the
    // adapters can still edit. Bounded: a platform that does not answer must not hold the shutdown.
    const needsStopped = this.stopNeedsYou();
    this.cacheService?.stop();
    const profileStopped = this.runtimeCpuProfiler?.shutdown("fleet shutdown");
    this.ipcStoppingInstances.add("__fleet_stopping__");
    // Release held delivery promises before awaiting daemon shutdown, then
    // reject spawn work which has not started. Otherwise a storm backoff could
    // make `agend stop` wait forever for its own queue.
    this.stormWindow.shutdown();
    this.spawnGate.shutdown();
    this.memoryPressure?.stop();
    this.stopCliEnvProbes();
    for (const pending of this.startupRetries.values()) clearTimeout(pending.timer);
    this.startupRetries.clear();
    for (const pending of this.startupRetryNotices.values()) clearTimeout(pending.timer);
    this.startupRetryNotices.clear();
    if (this.stormOpenNotifyTimer) {
      clearTimeout(this.stormOpenNotifyTimer);
      this.stormOpenNotifyTimer = null;
    }
    sdNotifyBlocking("STOPPING=1");
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
    this.eventLoopWatch?.stop();
    this.eventLoopWatch = null;
    // A login/install window is a dedicated tmux server with its own TTL
    // timer and HTTP listener living in THIS process: without an explicit
    // shutdown it would outlive us as an owner-less login CLI (sol B3).
    await publicStopped;
    await profileStopped;
    await needsStopped;
    await settingsControlStopped;
    await this.cpuProfileControl?.close();
    this.cpuProfileControl = null;
    await this.shutdownLoginWindows();
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
    if (this.outboxPruneTimer) { clearInterval(this.outboxPruneTimer); this.outboxPruneTimer = null; }
    if (this.replyObligationTimer) { clearInterval(this.replyObligationTimer); this.replyObligationTimer = null; }
    this.wakeCoordinator?.stop();
    if (this.logRotateTimer) { clearInterval(this.logRotateTimer); this.logRotateTimer = null; }
    if (this.discordPresenceTimer) { clearInterval(this.discordPresenceTimer); this.discordPresenceTimer = null; }
    if (this.discordPresenceEagerTimer) { clearTimeout(this.discordPresenceEagerTimer); this.discordPresenceEagerTimer = null; }
    this.discordPresenceEagerPending = false;
    // Cancel-button timers were never cleared here. The idle-check interval is not
    // unref'd, so it held the event loop open past shutdown and kept retrying
    // deletes against an adapter that was already gone.
    for (const entry of [...this.cancelButtons.values()]) {
      if (entry.retryTimer) clearTimeout(entry.retryTimer);
      if (entry.idleCheckTimer) clearInterval(entry.idleCheckTimer);
      if (entry.progressTimer) clearInterval(entry.progressTimer);
    }
    this.cancelButtons.clear();
    this.cancelButtonPublications.clear();
    for (const timer of this.cancelButtonIdleRetireTimers.values()) clearTimeout(timer);
    this.cancelButtonIdleRetireTimers.clear();

    if (this.topicCleanupTimer) {
      clearInterval(this.topicCleanupTimer);
      this.topicCleanupTimer = null;
    }
    this.topicCleanupGeneration++;
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
    // Adapters are still connected here — they are stopped further down — so
    // this is the last moment the prompts can be collapsed.
    await this.retirePendingNoncePrompts();
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
    this.stopPreviewListener();

    // The store writes lastSeen at most once a minute; what that debounce is still holding — and any
    // write that failed and is still owed — is paid now, so a restart neither shortens the idle window
    // nor revives a session that was revoked while the disk was refusing writes.
    this.webSessions?.flush();

    this.eventLog?.close();
    this.replyButtonsCtl?.stop();
    this.replyButtonsStore?.close();
    this.replyButtonsCtl = null; this.replyButtonsStore = null;

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

    const trackedProgress = readUpdateProgress(this.dataDir);
    const trackedFullRestart = trackedProgress
      && updateProgressOperation(trackedProgress.progress) === "full-restart"
      && trackedProgress.progress.stage !== "failed"
      && trackedProgress.progress.stage !== "complete";
    if (trackedFullRestart) {
      // `/restart full` already posted and persisted one public progress message.
      // Keep that single message; the new process will adopt and finish it.
      setUpdateProgressStage(this.dataDir, "stopping");
    }

    const restartTarget = this.fleetNoticeTarget();
    if (!trackedFullRestart && this.adapter) {
      if (restartTarget) {
        await this.adapter.sendText(restartTarget.chatId, t("restart.full_initiated"), restartTarget.opts)
          .catch(e => this.logger.warn({ err: e }, "Failed to post full restart notification"));
      } else {
        // Say why nothing was posted. A restart that announces itself nowhere,
        // for a reason nobody logged, is the harder version of this bug.
        this.logger.warn("Full restart notice has no postable target — set a General topic or channel.options.general_channel_id");
      }
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
  private async reconcileInstances(observe?: ReconcileObserver): Promise<ReconcileOutcome> {
    if (!this.configPath) return {};
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
      // Reported, not swallowed: an apply job whose config was refused used to
      // mark every row done and tell the user "changes applied".
      return { rejected: why };
    }

    // Classic behavior settings share the fleet defaults but are not entries
    // in fleet.yaml. Snapshot the old effective chain before reloading the
    // Classic file so SIGHUP can hot-apply either source without waiting for
    // the 30-second Classic poller.
    const oldClassicBehavior = new Map<string, {
      backend: string;
      model?: string;
      autoPauseAfter?: number;
      toolProgress: InstanceConfig["tool_progress"];
      replyCompletionGuard: boolean;
    }>();
    if (this.classicChannels) {
      for (const ch of this.classicChannels.getAll()) {
        const runtimeConfig = this.daemons.get(ch.instanceName)?.getConfigSnapshot?.();
        oldClassicBehavior.set(ch.instanceName, {
          backend: this.classicChannels.getBackend(ch.channelId, ch.adapterId, oldConfig?.defaults?.backend),
          model: this.classicChannels.getModel(ch.channelId, ch.adapterId, oldConfig?.defaults?.model),
          autoPauseAfter: this.classicChannels.getAutoPauseAfter(ch.channelId, ch.adapterId, oldConfig?.defaults?.auto_pause_after),
          // Settings mutates FleetManager's in-memory defaults before SIGHUP.
          // The live daemon is therefore the authority for the previous hot
          // values, exactly as in the fleet-topic reconciliation below.
          toolProgress: runtimeConfig?.tool_progress
            ?? this.classicChannels.getToolProgress(ch.channelId, ch.adapterId, oldConfig?.defaults?.tool_progress),
          replyCompletionGuard: runtimeConfig?.reply_completion_guard
            ?? this.classicChannels.getReplyCompletionGuard(ch.channelId, ch.adapterId, oldConfig?.defaults?.reply_completion_guard),
        });
      }
      if (this.classicChannels.checkReload()) this.reportClassicUnrecoverableIds();
    }

    this.routing.rebuild(this.fleetConfig!);
    this.reregisterClassicChannels();
    this.scheduler?.reload();
    this.reconcilePreviewListener();
    this.publicWebLink?.refresh();

    const newInstances = this.fleetConfig!.instances;
    const topicMode = this.fleetConfig?.channel?.mode === "topic";

    // Only what a fresh process can adopt, and only relative to the signature
    // this process came up on: a Settings edit mutates this.fleetConfig in place
    // before the reload, so comparing the pre-load copy sees nothing at all.
    const newFleetLevel = this.fleetLevelSignature();
    if (this.appliedFleetLevel !== null && this.appliedFleetLevel !== newFleetLevel) {
      this.logger.warn({
        keys: fleetLevelDifferences(this.startupFleetConfig, this.fleetConfig),
      }, "Fleet-level config changed — restart AgEnD for it to take effect");
      // Terminal, and deliberately not "done": this reconcile cannot adopt a
      // fleet-level change, and saying otherwise would claim AgEnD is running
      // on a configuration it is not running on.
      observe?.(APPLY_FLEET_TARGET, "restart", "restart-required");
    }

    // Stop removed instances (skip classic bot instances — they're managed by classicBot.yaml)
    const classicNames = new Set(this.classicChannels?.getAll().map(ch => ch.instanceName) ?? []);
    for (const name of this.daemons.keys()) {
      if (!(name in newInstances) && !classicNames.has(name)) {
        this.logger.info({ name }, "Instance removed from config — stopping");
        observe?.(name, "restart", "running");
        await this.stopInstance(name)
          .then(() => observe?.(name, "restart", "done"))
          .catch(err => {
            observe?.(name, "restart", "failed", (err as Error).message);
            this.logger.error({ err, name }, "Failed to stop removed instance");
          });
      }
    }

    // Start new + reconcile modified instances. Hot values are always sent as a
    // complete snapshot: Settings mutates FleetManager's config before SIGHUP,
    // so an old/new diff alone can miss the live daemon's stale value.
    for (const [name, config] of Object.entries(newInstances)) {
      if (!this.daemons.has(name)) {
        // New instance — startInstance already calls connectIpcToInstance
        this.logger.info({ name }, "New instance in config — starting");
        observe?.(name, "restart", "running");
        await this.startInstanceUnattended(name, config, topicMode, "new instance");
        observe?.(name, "restart", "done");
      } else if (oldConfig?.instances[name]) {
        const daemon = this.daemons.get(name)!;
        const runtimeConfig = daemon.getConfigSnapshot?.() ?? oldConfig.instances[name];
        const change = classifyInstanceChange(runtimeConfig, config);
        if (change === "restart") {
          this.logger.info({ name }, "Instance config changed — restarting");
          observe?.(name, "restart", "running");
          await this.stopInstance(name).catch(() => {});
          await this.startInstanceUnattended(name, config, topicMode, "modified instance");
          observe?.(name, "restart", "done");
        } else if (change === "hot") {
          observe?.(name, "hot", "running");
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
          observe?.(name, "hot", "done");
        }
      }
    }

    // A Classic channel inherits fleet defaults beneath its own two levels.
    // Recompute that complete chain on SIGHUP. Only the two behavior switches
    // are hot; changes to backend/model/auto-pause retain the existing restart
    // semantics.
    if (this.classicChannels) {
      for (const ch of this.classicChannels.getAll()) {
        const old = oldClassicBehavior.get(ch.instanceName);
        if (!old || !this.daemons.has(ch.instanceName)) continue;
        const backend = this.classicChannels.getBackend(ch.channelId, ch.adapterId, this.fleetConfig?.defaults?.backend);
        const model = this.classicChannels.getModel(ch.channelId, ch.adapterId, this.fleetConfig?.defaults?.model);
        const autoPauseAfter = this.classicChannels.getAutoPauseAfter(ch.channelId, ch.adapterId, this.fleetConfig?.defaults?.auto_pause_after);
        const profile = this.classicProfileChange(ch.instanceName, old.backend !== backend);
        if (old.backend !== backend || old.model !== model || old.autoPauseAfter !== autoPauseAfter || profile.changed) {
          this.logger.info({ instanceName: ch.instanceName, ...(profile.changed ? { profileFrom: profile.from, profileTo: profile.to } : {}) },
            "Classic cold config changed — restarting");
          observe?.(ch.instanceName, "restart", "running");
          await this.stopInstance(ch.instanceName).catch(() => {});
          if (profile.startsFresh) this.writeFreshStartMarker(ch.instanceName);
          await this.startClassicInstanceUnattended(ch, "classic instance after fleet reload");
          observe?.(ch.instanceName, "restart", "done");
          continue;
        }
        const toolProgress = this.classicChannels.getToolProgress(ch.channelId, ch.adapterId, this.fleetConfig?.defaults?.tool_progress);
        const replyCompletionGuard = this.classicChannels.getReplyCompletionGuard(ch.channelId, ch.adapterId, this.fleetConfig?.defaults?.reply_completion_guard);
        if (old.toolProgress !== toolProgress || old.replyCompletionGuard !== replyCompletionGuard) {
          observe?.(ch.instanceName, "hot", "running");
          this.applyHotConfigUpdate(ch.instanceName, {
            tool_progress: toolProgress,
            reply_completion_guard: replyCompletionGuard,
          });
          this.logger.info({ instanceName: ch.instanceName }, "Classic inherited hot config reloaded");
          observe?.(ch.instanceName, "hot", "done");
        }
      }
    }

    // warm_cap is fleet-owned; enforce the reloaded value immediately against
    // currently idle instances instead of waiting for a future state edge.
    this.enforceWarmCap();

    // appliedFleetLevel is deliberately NOT updated here. It means "the
    // fleet-level config this process started on"; a reconcile does not restart
    // the process, so moving it would erase the fact that a restart is still
    // owed and silence every later reminder.
    this.logger.info({ running: this.daemons.size, configured: Object.keys(newInstances).length }, "Reconcile complete");
    return {};
  }

  /**
   * `{channel, cold defaults}` as one comparable string — the part of the config
   * a running fleet process cannot adopt without restarting.
   */
  private fleetLevelSignature(config: FleetConfig | null = this.fleetConfig): string {
    return fleetLevelSignature(config);
  }

  /**
   * The config a reconcile is about to load, not the one held in memory.
   *
   * Settings mutates the in-memory object and writes the file; only the file
   * goes back through defaults expansion. Forecasting from memory therefore
   * misses every instance that a changed fleet default will restart — the user
   * is told "restart AgEnD" and not told that five agents are about to go down.
   */
  private nextFleetConfig(): FleetConfig | null {
    if (!this.configPath) return this.fleetConfig;
    try {
      return loadFleetConfig(this.configPath);
    } catch (err) {
      // An unparseable file is the reconcile's problem to report; the forecast
      // falls back to what is running rather than failing the request.
      this.logger.debug({ err }, "Apply plan fell back to the in-memory config");
      return this.fleetConfig;
    }
  }

  /**
   * Does the config this process is running match the one a reconcile would
   * load off disk?
   *
   * If not, every apply reports a fleet-level change that a restart cannot
   * clear — restart, recompute, disagree again — a self-sustaining loop that
   * the rate limit can only slow to three naggings an hour. Startup rewrites
   * the file in three places before this point (slimFleetConfigAtStartup, the
   * general auto-create, the general fixup), so the two can genuinely diverge.
   *
   * An offer to restart that cannot possibly succeed is worse than no offer, so
   * the panel shows the mismatch instead of a button.
   */
  private checkStartupSignatureConsistency(): void {
    if (!this.configPath) { this.fleetSignatureMismatch = null; return; }
    let onDisk: FleetConfig | null;
    try {
      onDisk = loadFleetConfig(this.configPath);
    } catch (err) {
      this.logger.warn({ err }, "Could not re-read fleet.yaml to check the startup signature");
      this.fleetSignatureMismatch = null;
      return;
    }
    if (fleetLevelSignature(onDisk) === this.appliedFleetLevel) {
      this.fleetSignatureMismatch = null;
      return;
    }
    this.fleetSignatureMismatch = fleetLevelDifferences(this.fleetConfig, onDisk);
    this.logger.warn({
      keys: this.fleetSignatureMismatch,
      configPath: this.configPath,
    }, "fleet.yaml and the running configuration disagree on startup-only keys — every apply will ask for a restart that cannot clear it");
  }

  /**
   * Is a live adapter already long-polling this bot token?
   *
   * Telegram's `getUpdates` has exactly one consumer: a second poller takes
   * turns with the first and both miss messages. The setup wizard's "post in
   * the group and I'll detect it" step is a second poller, so it has to know
   * when the answer is "not against this token, not while I'm running".
   */
  isBotTokenInUse(token: string): boolean {
    if (!token) return false;
    const configured = this.fleetConfig?.channels
      ?? (this.fleetConfig?.channel ? [this.fleetConfig.channel] : []);
    for (const channel of configured) {
      const envVar = channel?.bot_token_env;
      if (!envVar) continue;
      // Compare the value, not the variable name: the same token can be
      // reached through a differently named variable.
      if (process.env[envVar] === token) return true;
    }
    return false;
  }

  /** Non-null when startup found the running config and fleet.yaml disagreeing. */
  fleetSignatureMismatchKeys(): string[] | null {
    return this.fleetSignatureMismatch;
  }

  /**
   * Restart AgEnD itself on behalf of a Settings apply.
   *
   * Deliberately a separate action from Apply: the panel is reachable from
   * outside the LAN, and "restart the whole fleet" must never be something a
   * single Apply click can carry along with it.
   *
   * The order below is the safety envelope, and the order matters:
   * concurrency and consistency first (cheap, and a restart during a reconcile
   * is the dangerous one), then the state checks, then the rate limit, then the
   * audit notice — and only once all of that holds is the attempt written to
   * disk and fsynced, before anything spawns.
   */
  async requestSettingsSelfRestart(jobId: string, key: string): Promise<SelfRestartResult> {
    // A retry after a lost response must not restart a second time. The key is
    // recorded on the job, which survives the restart it triggers.
    const already = this.applyJobs.findByRestartKey(key);
    if (already) return { ok: true, jobId: already.id, reused: true };

    if (this.reconcileInFlight || this.activeApplyJobId) {
      return { ok: false, status: 409, error: "a configuration reload is running — try again once it finishes" };
    }
    if (this.fleetSignatureMismatch) {
      // Restarting cannot clear this, so offering it would be a loop.
      return {
        ok: false,
        status: 409,
        error: `fleet.yaml and the running configuration disagree on ${this.fleetSignatureMismatch.join(", ")} — check daemon.log before restarting`,
      };
    }

    const job = this.applyJobs.get(jobId);
    const row = job?.targets.find(item => item.target === APPLY_FLEET_TARGET);
    if (!job || !row || row.status !== "restart-required") {
      return { ok: false, status: 409, error: "that apply has no pending fleet-level change" };
    }
    // The row alone is not enough: an old job keeps its row for the whole
    // retention window, so a change made and then reverted would still leave a
    // job that looks restartable. The live signature is the authority — and it
    // must be the same view of the config the plan uses.
    if (this.appliedFleetLevel === null || this.appliedFleetLevel === this.fleetLevelSignature(this.nextFleetConfig())) {
      return { ok: false, status: 409, error: "no fleet-level change is pending any more" };
    }

    const allowance = checkSelfRestartAllowance(this.dataDir);
    if (!allowance.allowed) {
      if (allowance.reason === "unreadable") {
        // Fail closed: with the limit's own state in doubt, "no attempts yet"
        // is the one reading that must not be assumed.
        return {
          ok: false,
          status: 503,
          error: "the restart rate-limit file cannot be read — remove self-restart.json from the data dir on the host, or run `agend restart` there",
        };
      }
      return {
        ok: false,
        status: 429,
        error: allowance.reason === "too-soon"
          ? "AgEnD was restarted from Settings very recently"
          : "too many Settings-triggered restarts in the last hour",
        retryAfterSeconds: allowance.retryAfterSeconds,
      };
    }

    // Recorded before the notice, not after. If recording keeps failing (a
    // read-only data dir), posting first would let whoever holds the token spam
    // the channel with "restarting…" notices for restarts that never happen.
    // The cost is that a failed announcement still spends an attempt, which is
    // the right way round for a rate limit.
    if (!recordSelfRestartAttempt(this.dataDir)) {
      this.logger.error("Self-restart attempt could not be recorded — refusing to restart unmetered");
      return { ok: false, status: 503, error: "could not record the restart attempt" };
    }

    // Out-of-band notice before the restart, so a panel restart is visible where
    // the admins are. Refusing when it cannot be posted is the same rule as
    // refusing when the progress marker cannot be written: no untraceable
    // restarts.
    const notice = await this.postSelfRestartNotice();
    if (!notice) {
      return {
        ok: false,
        status: 409,
        error: "no chat channel is available to announce the restart — run `agend restart` on the host instead",
      };
    }

    // Consume the row: it moves to running, which is also what lets the next
    // process settle it (settleAfterRestart only touches non-terminal rows).
    this.applyJobs.update(jobId, current => {
      const target = current.targets.find(item => item.target === APPLY_FLEET_TARGET);
      if (target) target.status = "running";
      current.restart_key = key;
      current.deadlineMs = SELF_RESTART_DEADLINE_MS;
    });
    this.emitSseEvent("apply_progress", viewOf(this.applyJobs.get(jobId)!));

    const launched = await this.requestFullRestart(notice.adapter, notice.chatId, notice.threadId, notice.messageId)
      .catch(err => {
        this.logger.error({ err }, "Settings-triggered self restart failed to launch");
        return false;
      });
    if (!launched) {
      this.applyJobs.setTargetStatus(jobId, APPLY_FLEET_TARGET, "failed", "restart could not be launched");
      this.applyJobs.finish(jobId, "restart could not be launched");
      this.emitSseEvent("apply_progress", viewOf(this.applyJobs.get(jobId)!));
      return { ok: false, status: 409, error: "the restart could not be launched — see daemon.log" };
    }
    return { ok: true, jobId };
  }

  /** The audit notice, and the message the restart progress will edit. */
  private async postSelfRestartNotice(): Promise<{
    adapter: ChannelAdapter; chatId: string; threadId: string | undefined; messageId: string;
  } | null> {
    const groupId = this.fleetConfig?.channel?.group_id;
    const adapter = this.adapter;
    if (!groupId || !adapter) return null;
    const generalName = this.findGeneralInstance();
    const rawThreadId = generalName ? this.fleetConfig?.instances[generalName]?.topic_id : undefined;
    const threadId = rawThreadId != null ? String(rawThreadId) : undefined;
    try {
      const sent = await adapter.sendText(String(groupId), t("restart.settings_triggered"), { threadId });
      if (!sent?.messageId) return null;
      return { adapter, chatId: sent.chatId, threadId: sent.threadId, messageId: sent.messageId };
    } catch (err) {
      this.logger.error({ err }, "Could not announce the Settings-triggered restart — refusing to restart silently");
      return null;
    }
  }

  /** Jobs outlive this process on purpose; see apply-job.ts. */
  get applyJobs(): ApplyJobStore {
    return (this.applyJobStoreCache ??= new ApplyJobStore(this.dataDir, Date.now, this.logger));
  }

  /** The only channel metadata exposed to the Settings secret UI. */
  listSecureConnections(): ConnectionMetadata[] {
    const channels = this.fleetConfig?.channels
      ?? (this.fleetConfig?.channel ? [this.fleetConfig.channel] : []);
    return channels.map((channel, index) => {
      const id = channel.id ?? channel.type ?? `channel-${index}`;
      const world = this.worlds.get(id);
      const state = this.adapterState.get(id);
      return {
        id,
        type: channel.type,
        token_env: channel.bot_token_env,
        token_present: !!process.env[channel.bot_token_env],
        group_id: channel.group_id != null ? String(channel.group_id) : null,
        general_channel_id: channel.options?.general_channel_id != null
          ? String(channel.options.general_channel_id)
          : null,
        status: state?.status ?? (world ? "starting" : "stopped"),
        ...(world ? { identity: { id: world.botUserId ?? null, username: world.botUsername ?? null } } : {}),
      };
    });
  }

  private secureConnectionChannel(connectionId: string): ChannelConfig | undefined {
    const channels = this.fleetConfig?.channels
      ?? (this.fleetConfig?.channel ? [this.fleetConfig.channel] : []);
    const matches = channels.filter((channel, index) => (channel.id ?? channel.type ?? `channel-${index}`) === connectionId);
    // Ambiguous fallback IDs (for example two unlabelled Discord channels)
    // must fail closed rather than rotating the first matching token.
    return matches.length === 1 ? matches[0] : undefined;
  }

  private secureConnectionGeneration(connectionId: string): number {
    const adapter = this.adapters.get(connectionId);
    const healthGeneration = adapter?.getHealthSnapshot?.().generation ?? 0;
    let generation = this.connectionSecretGenerations.get(connectionId) ?? 0;
    const previousAdapter = this.connectionSecretAdapterRefs.get(connectionId);
    const previousHealthGeneration = this.connectionSecretHealthGenerations.get(connectionId);
    if (this.connectionSecretAdapterRefs.has(connectionId) && previousAdapter !== adapter) generation++;
    if (this.connectionSecretHealthGenerations.has(connectionId) && previousHealthGeneration !== healthGeneration) generation++;
    this.connectionSecretAdapterRefs.set(connectionId, adapter);
    this.connectionSecretHealthGenerations.set(connectionId, healthGeneration);
    this.connectionSecretGenerations.set(connectionId, generation);
    return generation;
  }

  /** Provider API-key rows exposed to Settings (never the env key or secret). */
  providerSecretsEnabled(): boolean {
    return this.fleetConfig?.web?.provider_secrets === true;
  }

  listProviderSecrets(): ProviderSecretStatus[] {
    return PROVIDER_SECRET_SPECS.map(spec => ({
      id: spec.id,
      display_name: spec.displayName,
      kind: spec.kind,
      token_present: !!process.env[spec.envKey],
      verifier: spec.verifier ? "available" : "unsupported",
      activation: spec.activation,
      stale_consumers: this.providerSecretStaleConsumers(spec.envKey),
    }));
  }

  private providerSecretStaleConsumers(envKey: string): string[] {
    // A child inherits the manager's environment at spawn.  We cannot inspect
    // a child process's private environment safely, so report the conservative
    // set of already-running children; the UI can then say "restart these"
    // rather than claiming an existing process reloaded.
    if (envKey === "GROQ_API_KEY") return [];
    return [...this.children.keys()].sort();
  }

  private providerSecretGeneration(envKey: string): number {
    return this.providerSecretGenerations.get(envKey) ?? 0;
  }

  private providerSecretEnvAllowed(envKey: string): boolean {
    const configured = new Set((this.fleetConfig?.channels
      ?? (this.fleetConfig?.channel ? [this.fleetConfig.channel] : []))
      .map(channel => channel.bot_token_env));
    return !configured.has(envKey) && providerRegistryEnvKeys().has(envKey);
  }

  async verifyProviderSecret(input: {
    specId: string;
    secret: string;
    sessionBinding: string;
    idempotencyKey: string;
  }): Promise<
    | { ok: true; verification_id: string; expires_at: number; spec_id: string; activation: "next_use" | "reload_hook" }
    | { ok: false; status: "unsupported_verifier" | "provider_rejected" | "provider_unavailable" | "invalid"; error: string }
  > {
    const spec = providerSecretSpec(input.specId);
    if (!spec || !this.providerSecretEnvAllowed(spec.envKey)) {
      return { ok: false, status: "invalid", error: "provider secret is not configured" };
    }
    if (!spec.verifier) return { ok: false, status: "unsupported_verifier", error: "this provider has no supported verifier" };
    if (!input.secret || input.secret.length > 4096 || /[\r\n\0]/.test(input.secret) || /[^\x20-\x7e]/.test(input.secret)) {
      return { ok: false, status: "invalid", error: "secret is invalid" };
    }
    const challengeKey = `${input.sessionBinding}:api_key:${spec.id}:${spec.envKey}:${input.idempotencyKey}`;
    const existingId = this.providerSecretChallengesByKey.get(challengeKey);
    const existing = existingId ? this.providerSecretChallenges.get(existingId) : undefined;
    if (existing && (existing.deadline === undefined ? existing.expiresAt > Date.now() : existing.deadline > performance.now())) {
      return { ok: true, verification_id: existing.id, expires_at: existing.expiresAt, spec_id: spec.id, activation: spec.activation };
    }
    if (existingId) this.providerSecretChallengesByKey.delete(challengeKey);

    const result = await verifyProviderSecret(spec, input.secret, this.providerSecretHttpClient);
    if (!result.ok) {
      // Do not log provider detail: the HTTP verifier already redacted it and
      // this endpoint has no need to disclose whether a key was close to valid.
      this.logger.warn({ specId: spec.id, status: result.status }, "Provider API-key verification failed");
      return { ok: false, status: result.status, error: result.status === "unsupported_verifier" ? "this provider has no supported verifier" : "provider rejected or unavailable" };
    }
    const expiresAt = Date.now() + SECRET_CHALLENGE_TTL_MS;
    const challenge: ProviderSecretChallenge = {
      id: opaqueId("provider_verify"),
      specId: spec.id,
      envKey: spec.envKey,
      kind: "api_key",
      sessionBinding: input.sessionBinding,
      generation: this.providerSecretGeneration(spec.envKey),
      operation: "provider-secret.apply",
      idempotencyKey: input.idempotencyKey,
      expiresAt, deadline: performance.now() + SECRET_CHALLENGE_TTL_MS,
      secret: input.secret,
    };
    this.providerSecretChallenges.set(challenge.id, challenge);
    this.providerSecretChallengesByKey.set(challengeKey, challenge.id);
    const expiryTimer = setTimeout(() => {
      if (this.providerSecretChallenges.get(challenge.id) !== challenge) return;
      this.providerSecretChallenges.delete(challenge.id);
      if (this.providerSecretChallengesByKey.get(challengeKey) === challenge.id) this.providerSecretChallengesByKey.delete(challengeKey);
    }, SECRET_CHALLENGE_TTL_MS);
    expiryTimer.unref?.();
    return { ok: true, verification_id: challenge.id, expires_at: expiresAt, spec_id: spec.id, activation: spec.activation };
  }

  /** Naming aliases used by integrations that call this an API-key operation. */
  verifyProviderApiKey(input: Parameters<FleetManager["verifyProviderSecret"]>[0]): ReturnType<FleetManager["verifyProviderSecret"]> {
    return this.verifyProviderSecret(input);
  }

  startProviderSecretApply(input: {
    specId: string;
    verificationId: string;
    sessionBinding: string;
    idempotencyKey: string;
    execution?: SettingsExecution;
  }): { job: ProviderSecretApplyJob; reused: boolean } | { busy: ProviderSecretApplyJob | null } | { error: string } {
    for (const [jobId, job] of this.providerSecretJobs) {
      if (job.specId === input.specId && job.idempotencyKey === input.idempotencyKey
        && this.providerSecretJobSession.get(jobId) === input.sessionBinding) return { job, reused: true };
    }
    const challenge = this.providerSecretChallenges.get(input.verificationId);
    const spec = providerSecretSpec(input.specId);
    if (!challenge || (challenge.deadline === undefined ? challenge.expiresAt <= Date.now() : challenge.deadline <= performance.now())) {
      if (challenge) this.providerSecretChallenges.delete(input.verificationId);
      return { error: "verification expired; verify the secret again" };
    }
    if (!spec || challenge.specId !== spec.id || challenge.envKey !== spec.envKey || challenge.kind !== "api_key"
      || challenge.sessionBinding !== input.sessionBinding || challenge.operation !== "provider-secret.apply"
      || challenge.idempotencyKey !== input.idempotencyKey || challenge.generation !== this.providerSecretGeneration(challenge.envKey)) {
      return { error: "verification does not match this provider or session" };
    }
    const existingId = this.providerSecretInFlight.get(challenge.envKey);
    if (existingId) {
      const existing = this.providerSecretJobs.get(existingId) ?? null;
      if (existing?.idempotencyKey === input.idempotencyKey) return { job: existing, reused: true };
      return { busy: existing };
    }
    this.providerSecretChallenges.delete(input.verificationId);
    this.providerSecretChallengesByKey.delete(`${input.sessionBinding}:api_key:${spec.id}:${spec.envKey}:${input.idempotencyKey}`);
    const job: ProviderSecretApplyJob = {
      id: opaqueId("provider_apply"), specId: spec.id, envKey: spec.envKey,
      idempotencyKey: input.idempotencyKey, result: "applying", status: "running", startedAt: Date.now(),
      stale_consumers: this.providerSecretStaleConsumers(spec.envKey),
    };
    this.providerSecretJobs.set(job.id, job);
    this.providerSecretJobSession.set(job.id, input.sessionBinding);
    this.providerSecretInFlight.set(spec.envKey, job.id);
    this.queueSettingsOperation(job, [settingsFileResource(join(this.dataDir, ".env"))], input.execution, execution => this.runProviderSecretApply(job, challenge.secret, execution));
    return { job, reused: false };
  }

  startProviderApiKeyApply(input: Parameters<FleetManager["startProviderSecretApply"]>[0]): ReturnType<FleetManager["startProviderSecretApply"]> {
    return this.startProviderSecretApply(input);
  }

  getProviderSecretApply(jobId: string, sessionBinding: string): ProviderSecretApplyJob | null {
    if (this.providerSecretJobSession.get(jobId) !== sessionBinding) return null;
    return this.providerSecretJobs.get(jobId) ?? null;
  }

  getProviderApiKeyApply(jobId: string, sessionBinding: string): ProviderSecretApplyJob | null {
    return this.getProviderSecretApply(jobId, sessionBinding);
  }

  private async runProviderSecretApply(job: ProviderSecretApplyJob, secret: string, execution?: SettingsExecution): Promise<void> {
    const spec = providerSecretSpec(job.specId);
    const allowed = new Set([
      ...PROVIDER_SECRET_SPECS.map(item => item.envKey),
      ...(this.fleetConfig?.channels ?? (this.fleetConfig?.channel ? [this.fleetConfig.channel] : [])).map(channel => channel.bot_token_env),
    ]);
    let store: SecretStore | null = null;
    let before: import("./secret-store.js").SecretSnapshot | null = null;
    const previousProcessValue = process.env[job.envKey];
    let wrote = false;
    try {
      if (!spec || !this.providerSecretEnvAllowed(job.envKey)) throw new Error("provider secret is not configured");
      // Construct inside the transaction: symlink/permission refusal must
      // settle the job as a safe failure, not escape the queued microtask.
      store = new SecretStore(join(this.dataDir, ".env"), allowed, { owner: execution?.owner });
      const write = (): void => { before = store!.write(job.envKey, secret); wrote = true; process.env[job.envKey] = secret; };
      if (execution) execution.mutate(write); else write();
      if (spec.activation === "reload_hook" && spec.reloadHookId) {
        await this.runProviderSecretReloadHook(spec.reloadHookId, secret, previousProcessValue);
        execution?.assert();
        job.result = "reloaded";
      } else {
        job.result = "applied_next_use";
      }
      const commit = (): void => { this.providerSecretGenerations.set(job.envKey, this.providerSecretGeneration(job.envKey) + 1); };
      if (execution) execution.commit(commit); else commit();
      job.status = "done";
      job.finishedAt = Date.now();
    } catch (err) {
      const safe = safeSecretError(err, secret);
      this.logger.warn({ specId: job.specId, reason: safe }, "Provider API-key apply failed");
      try {
        // Memory and disk have separate receipts: a host-edited file must
        // remain, but cannot strand our owned process value or hook snapshot.
        if (wrote && process.env[job.envKey] === secret) {
          if (previousProcessValue === undefined) delete process.env[job.envKey]; else process.env[job.envKey] = previousProcessValue;
        }
        if (spec?.reloadHookId && this.providerSecretHotSnapshots.get(spec.reloadHookId) === secret) {
          if (previousProcessValue === undefined) this.providerSecretHotSnapshots.delete(spec.reloadHookId);
          else this.providerSecretHotSnapshots.set(spec.reloadHookId, previousProcessValue);
        }
        if (wrote && before && store) store.restoreIfCurrent(before);
        // SecretStore.write is itself transactional; when it fails before a
        // snapshot is returned there is no new value to roll back. Report the
        // truthful no-op rather than claiming rollback_failed.
        job.result = "rolled_back";
        if (!wrote || !before) job.error = "provider secret was not applied";
      } catch (rollbackErr) {
        this.logger.error({ specId: job.specId, reason: safeSecretError(rollbackErr, secret, previousProcessValue ? [previousProcessValue] : []) }, "Provider API-key rollback failed");
        job.result = "rollback_failed";
        job.error = "provider secret rollback failed; operator attention required";
      }
      job.status = "done";
      job.finishedAt = Date.now();
    } finally {
      if (this.providerSecretInFlight.get(job.envKey) === job.id) this.providerSecretInFlight.delete(job.envKey);
      secret = "";
    }
  }

  /** Groq is currently read from process.env per voice request, so the hook is
   * intentionally a no-op. Keeping it as a named code-owned hook makes the
   * hot activation contract explicit and gives tests a failure seam; no generic
   * SIGHUP or caller-provided hook is ever executed. */
  private async runProviderSecretReloadHook(hookId: string, _next: string, _previous: string | undefined): Promise<void> {
    if (hookId !== "groq.voice") throw new Error("unknown provider secret reload hook");
    const before = this.providerSecretHotSnapshots.get(hookId);
    this.providerSecretHotSnapshots.set(hookId, _next);
    const hook = this.providerSecretReloadHooks.get(hookId);
    try {
      if (hook) await hook(_next, before);
    } catch (err) {
      if (this.providerSecretHotSnapshots.get(hookId) === _next) {
        if (before === undefined) this.providerSecretHotSnapshots.delete(hookId);
        else this.providerSecretHotSnapshots.set(hookId, before);
      }
      throw err;
    }
  }

  private normalizeConnectionBinding(input: {
    group_id?: unknown;
    general_channel_id?: unknown;
  }): ConnectionBinding | null {
    // IDs arrive from JSON and may be Discord snowflakes.  Do not accept a
    // number here: JSON.parse may already have rounded it before verification.
    if (typeof input.group_id !== "string") return null;
    const groupId = input.group_id.trim();
    if (!groupId || groupId.length > 128 || /[\r\n\0]/.test(groupId)) return null;
    let general: string | null | undefined;
    if (input.general_channel_id === null || input.general_channel_id === undefined || input.general_channel_id === "") {
      general = input.general_channel_id === null ? null : undefined;
    } else if (typeof input.general_channel_id === "string") {
      general = input.general_channel_id.trim();
      if (!general || general.length > 128 || /[\r\n\0]/.test(general)) return null;
    } else {
      return null;
    }
    return general === undefined ? { group_id: groupId } : { group_id: groupId, general_channel_id: general };
  }

  private connectionBindingChannelConfig(channel: ChannelConfig, binding: ConnectionBinding): ChannelConfig {
    const candidate = structuredClone(channel);
    // IDs are intentionally normalized to strings at this boundary. Discord
    // snowflakes must never become YAML numbers (precision loss is silent).
    candidate.group_id = String(binding.group_id);
    if (binding.general_channel_id !== undefined) {
      const options = { ...(candidate.options ?? {}) };
      if (binding.general_channel_id === null) delete options.general_channel_id;
      else options.general_channel_id = String(binding.general_channel_id);
      if (Object.keys(options).length === 0) delete candidate.options;
      else candidate.options = options;
    }
    return candidate;
  }

  /** Verify a prospective group/guild binding without mutating fleet state. */
  async verifyConnectionBinding(input: {
    connectionId: string;
    binding: { group_id?: unknown; general_channel_id?: unknown };
    sessionBinding: string;
    idempotencyKey: string;
  }): Promise<{ ok: true; verification_id: string; expires_at: number; binding: ConnectionBinding; probe: BindingProbe } | { ok: false; error: string }> {
    const channel = this.secureConnectionChannel(input.connectionId);
    const binding = this.normalizeConnectionBinding(input.binding);
    const adapter = this.adapters.get(input.connectionId);
    if (!channel || !binding || !adapter?.verifyBinding) {
      return { ok: false, error: "connection binding is unsupported or invalid" };
    }
    const key = `${input.sessionBinding}:${input.connectionId}:${input.idempotencyKey}`;
    const existingId = this.connectionBindingChallengesByKey.get(key);
    const existing = existingId ? this.connectionBindingChallenges.get(existingId) : undefined;
    if (existing && (existing.deadline === undefined ? existing.expiresAt > Date.now() : existing.deadline > performance.now())) {
      return { ok: true, verification_id: existing.id, expires_at: existing.expiresAt, binding: existing.binding, probe: existing.probe };
    }
    if (existingId) this.connectionBindingChallengesByKey.delete(key);

    const beforeGeneration = this.secureConnectionGeneration(input.connectionId);
    let probe: BindingProbe;
    try {
      probe = await adapter.verifyBinding(binding.group_id, binding.general_channel_id ?? undefined);
    } catch (err) {
      this.logger.warn({ connectionId: input.connectionId, reason: safeSecretError(err) }, "Settings connection binding verification failed");
      return { ok: false, error: "binding verification failed" };
    }
    const afterGeneration = this.secureConnectionGeneration(input.connectionId);
    if (beforeGeneration !== afterGeneration || this.adapters.get(input.connectionId) !== adapter) {
      return { ok: false, error: "connection changed while binding was verified" };
    }
    if (probe.group_id !== binding.group_id || !probe.can_view || !probe.can_send) {
      return { ok: false, error: "provider did not confirm the requested binding" };
    }
    const expiresAt = Date.now() + SECRET_CHALLENGE_TTL_MS;
    const challenge: BindingChallenge = {
      id: opaqueId("binding_verify"),
      connectionId: input.connectionId,
      sessionBinding: input.sessionBinding,
      generation: afterGeneration,
      operation: "binding.apply",
      idempotencyKey: input.idempotencyKey,
      expiresAt, deadline: performance.now() + SECRET_CHALLENGE_TTL_MS,
      binding,
      probe,
    };
    this.connectionBindingChallenges.set(challenge.id, challenge);
    this.connectionBindingChallengesByKey.set(key, challenge.id);
    const expiryTimer = setTimeout(() => {
      if (this.connectionBindingChallenges.get(challenge.id) !== challenge) return;
      this.connectionBindingChallenges.delete(challenge.id);
      if (this.connectionBindingChallengesByKey.get(key) === challenge.id) this.connectionBindingChallengesByKey.delete(key);
    }, SECRET_CHALLENGE_TTL_MS);
    expiryTimer.unref?.();
    return { ok: true, verification_id: challenge.id, expires_at: expiresAt, binding, probe };
  }

  startConnectionBindingApply(input: {
    connectionId: string;
    verificationId: string;
    sessionBinding: string;
    idempotencyKey: string;
    execution?: SettingsExecution;
  }): { job: SecretApplyJob; reused: boolean } | { busy: SecretApplyJob | null } | { error: string } {
    for (const [jobId, job] of this.connectionBindingJobs) {
      if (job.connectionId === input.connectionId && job.idempotencyKey === input.idempotencyKey
        && this.connectionBindingJobSession.get(jobId) === input.sessionBinding) return { job, reused: true };
    }
    const challenge = this.connectionBindingChallenges.get(input.verificationId);
    if (!challenge || (challenge.deadline === undefined ? challenge.expiresAt <= Date.now() : challenge.deadline <= performance.now())) {
      this.connectionBindingChallenges.delete(input.verificationId);
      return { error: "binding verification expired; verify the binding again" };
    }
    if (challenge.connectionId !== input.connectionId || challenge.sessionBinding !== input.sessionBinding
      || challenge.operation !== "binding.apply" || challenge.idempotencyKey !== input.idempotencyKey
      || challenge.generation !== this.secureConnectionGeneration(input.connectionId)) {
      return { error: "binding verification does not match this connection or session" };
    }
    const existingId = this.connectionBindingInFlight.get(input.connectionId);
    if (existingId) {
      const existing = this.connectionBindingJobs.get(existingId) ?? null;
      if (existing?.idempotencyKey === input.idempotencyKey) return { job: existing, reused: true };
      return { busy: existing };
    }
    this.connectionBindingChallenges.delete(input.verificationId);
    this.connectionBindingChallengesByKey.delete(`${input.sessionBinding}:${input.connectionId}:${input.idempotencyKey}`);
    const job: SecretApplyJob = {
      id: opaqueId("binding_apply"), connectionId: input.connectionId, idempotencyKey: input.idempotencyKey,
      result: "applying", status: "running", startedAt: Date.now(),
    };
    this.connectionBindingJobs.set(job.id, job);
    this.connectionBindingJobSession.set(job.id, input.sessionBinding);
    this.connectionBindingInFlight.set(input.connectionId, job.id);
    this.queueSettingsOperation(job, [`connection:${this.dataDir}:${job.connectionId}`], input.execution, execution => this.runConnectionBindingApply(job, challenge.binding, execution));
    return { job, reused: false };
  }

  getConnectionBindingApply(jobId: string, sessionBinding: string): SecretApplyJob | null {
    if (this.connectionBindingJobSession.get(jobId) !== sessionBinding) return null;
    return this.connectionBindingJobs.get(jobId) ?? null;
  }

  private async runConnectionBindingApply(job: SecretApplyJob, binding: ConnectionBinding, execution?: SettingsExecution): Promise<void> {
    try {
      await this.rebuildAdapterForBinding(job.connectionId, binding, execution);
      job.result = "applied";
    } catch (err) {
      const reason = safeSecretError(err);
      job.result = /rollback failed/i.test(reason) ? "rollback_failed" : "rolled_back";
      job.error = job.result === "rollback_failed"
        ? "binding rollback failed; adapter requires operator attention"
        : "binding was not applied; previous binding was restored";
      this.logger.warn({ connectionId: job.connectionId, reason: safeSecretError(err) }, "Settings connection binding apply failed");
    } finally {
      job.status = "done";
      job.finishedAt = Date.now();
      if (this.connectionBindingInFlight.get(job.connectionId) === job.id) this.connectionBindingInFlight.delete(job.connectionId);
    }
  }

  /** Stop, rebuild and wait for a new adapter before committing YAML binding. */
  private async rebuildAdapterForBinding(connectionId: string, binding: ConnectionBinding, execution?: SettingsExecution): Promise<void> {
    const generation = this.settingsGeneration;
    const current = (): boolean => !this.shuttingDown && this.settingsGeneration === generation;
    const check = (): void => { execution?.assert(); if (!current()) throw new Error("adapter operation superseded"); };
    check();
    const channel = this.secureConnectionChannel(connectionId);
    if (!channel || !this.fleetConfig) throw new Error("connection not found");
    const candidate = this.connectionBindingChannelConfig(channel, binding);
    const oldAdapter = this.adapters.get(connectionId);
    const oldWorld = this.worlds.get(connectionId);
    const oldPrimary = this.adapter;
    const oldAccess = this.accessManager;
    const oldState = this.adapterState.get(connectionId);
    const beforeBinding = structuredClone(this.fleetConfig);
    const bindingPath = this.fleetConfig.channels
      ? ["channels", String(this.fleetConfig.channels.indexOf(channel))] : ["channel"];
    const bindingFields = [[...bindingPath, "group_id"],
      ...(binding.general_channel_id !== undefined ? [[...bindingPath, "options", "general_channel_id"]] : [])];
    let bindingUndo: SettingsUndo[] = [];
    const primary = this.getPrimaryAdapterId() === connectionId;
    if (primary && this.sessionPruneTimer) { clearInterval(this.sessionPruneTimer); this.sessionPruneTimer = null; }

    let fresh: ChannelAdapter | undefined;

    try {
      this.adapterState.set(connectionId, { status: "retrying", retryCount: oldState?.retryCount ?? 0 });
      if (oldAdapter) {
        oldAdapter.removeAllListeners();
        await oldAdapter.stop().catch(() => {}); check();
        if (this.adapters.get(connectionId) === oldAdapter) this.adapters.delete(connectionId);
        if (this.worlds.get(connectionId)?.adapter === oldAdapter) this.worlds.delete(connectionId);
        if (primary && this.adapter === oldAdapter) this.adapter = null;
      }
      let startedResolve: (() => void) | null = null;
      const started = new Promise<void>(resolve => { startedResolve = resolve; });
      const onStarted = (): void => { startedResolve?.(); };
      if (primary) await this.startSingleAdapter(this.fleetConfig, candidate, onStarted, execution);
      else await this.startAdditionalAdapter(candidate, true, onStarted, execution);
      check();
      fresh = this.adapters.get(connectionId);
      if (!fresh) throw new Error("new adapter did not start");
      const deadline = performance.now() + 15_000;
      if (!fresh.getHealthSnapshot) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("new adapter did not become ready")), Math.max(1, deadline - performance.now()));
          timer.unref?.();
        });
        try { await Promise.race([started, timeout]); check(); } finally { if (timer) clearTimeout(timer); }
      } else {
        while (performance.now() < deadline) {
          const health = fresh.getHealthSnapshot?.();
          if (health?.status === "connected" || this.adapterState.get(connectionId)?.status === "connected") break;
          await new Promise(resolve => setTimeout(resolve, 100)); check();
        }
        const health = fresh.getHealthSnapshot?.();
        if (health && health.status !== "connected" && this.adapterState.get(connectionId)?.status !== "connected") {
          throw new Error("new adapter did not become connected");
        }
      }
      if (fresh.setChatId) fresh.setChatId(String(candidate.group_id));
      // Commit only after the replacement adapter is ready. No allowlist,
      // topic, instance or schedule fields are touched here.
      const commit = (): void => {
      channel.group_id = String(binding.group_id);
      if (binding.general_channel_id !== undefined) {
        const options = { ...(channel.options ?? {}) };
        if (binding.general_channel_id === null) delete options.general_channel_id;
        else options.general_channel_id = String(binding.general_channel_id);
        if (Object.keys(options).length === 0) delete channel.options;
        else channel.options = options;
      }
      try { this.saveFleetConfig(); }
      finally { bindingUndo = settingsUndo(this.configPath, beforeBinding, this.fleetConfig, bindingFields); }
      this.routing.rebuild(this.fleetConfig!);
      this.reregisterClassicChannels();
      this.adapterState.set(connectionId, { status: "connected", retryCount: 0 });
      };
      if (execution) execution.commit(commit); else { check(); commit(); }

    } catch (err) {
      let rollbackError: unknown;
      try {
        if (bindingUndo.length) {
          const disk = undoSettingsPaths(this.configPath, loadRawFleetConfig(this.configPath), bindingUndo);
          const runtime = undoSettingsPaths(this.configPath, this.fleetConfig, bindingUndo);
          if (disk.conflicts || runtime.conflicts) throw new Error("binding rollback conflict; newer configuration retained");
          noteSettingsWrite(this.configPath, this.fleetConfig, runtime.value);
          this.fleetConfig = runtime.value;
          this.saveFleetConfig(bindingFields.map(path => {
            let value: any = disk.value; for (const key of path) value = value?.[key];
            return { path, value, ...(value === undefined ? { remove: true } : {}) };
          }));
        }
      } catch (restoreErr) { rollbackError = restoreErr; }
      if (fresh && fresh !== oldAdapter) await fresh.stop().catch(() => {});
      if (this.adapters.get(connectionId) === fresh || this.adapters.get(connectionId) === oldAdapter) {
        this.adapters.delete(connectionId);
        if (this.worlds.get(connectionId)?.adapter === fresh || this.worlds.get(connectionId)?.adapter === oldAdapter) this.worlds.delete(connectionId);
        if (primary && (this.adapter === fresh || this.adapter === oldAdapter)) this.adapter = null;
      }
      if (current()) {
        const retained = this.secureConnectionChannel(connectionId);
        if (retained) {
          const cleanup = { owner: execution?.owner ?? Symbol("adapter-cleanup"), assert: () => { if (!current()) throw new Error("cleanup superseded"); } };
          try {
            if (primary) await this.startSingleAdapter(this.fleetConfig!, retained, () => {}, cleanup);
            else await this.startAdditionalAdapter(retained, true, () => {}, cleanup);
            if (!current()) throw new Error("cleanup superseded");
            this.routing.rebuild(this.fleetConfig!); this.reregisterClassicChannels();
          } catch (restoreErr) { throw new Error(`binding rollback failed: ${safeSecretError(restoreErr)}`); }
        }
      }
      if (rollbackError) throw new Error(`binding rollback failed: ${safeSecretError(rollbackError)}`);
      throw err;
    }
  }

  async verifyConnectionSecret(input: {
    connectionId: string;
    secret: string;
    sessionBinding: string;
    idempotencyKey: string;
  }): Promise<{ ok: true; verification_id: string; expires_at: number; identity?: { id: string | null; username: string | null } } | { ok: false; error: string }> {
    const channel = this.secureConnectionChannel(input.connectionId);
    if (!channel || (channel.type !== "discord" && channel.type !== "telegram")) {
      return { ok: false, error: "connection not found or unsupported" };
    }
    if (!input.secret || input.secret.length > 4096 || /[\r\n\0]/.test(input.secret)) {
      return { ok: false, error: "secret is invalid" };
    }
    const challengeKey = `${input.sessionBinding}:${input.connectionId}:${input.idempotencyKey}`;
    const existingId = this.connectionSecretChallengesByKey.get(challengeKey);
    const existing = existingId ? this.connectionSecretChallenges.get(existingId) : undefined;
    if (existing && (existing.deadline === undefined ? existing.expiresAt > Date.now() : existing.deadline > performance.now())) {
      return { ok: true, verification_id: existing.id, expires_at: existing.expiresAt };
    }
    if (existingId) this.connectionSecretChallengesByKey.delete(challengeKey);

    // Fixed provider endpoints only. Never use a user-supplied URL and never
    // call Telegram getUpdates (the running adapter owns that long poll).
    const identity = channel.type === "discord"
      ? await verifyDiscordToken(input.secret)
      : await verifyTelegramToken(input.secret);
    if (!identity.valid) {
      this.logger.warn({ connectionId: input.connectionId, provider: channel.type }, "Settings connection secret verification failed");
      return { ok: false, error: "provider rejected the secret" };
    }

    const expiresAt = Date.now() + SECRET_CHALLENGE_TTL_MS;
    const challenge: SecretChallenge = {
      id: opaqueId("verify"),
      connectionId: input.connectionId,
      sessionBinding: input.sessionBinding,
      generation: this.secureConnectionGeneration(input.connectionId),
      operation: "secret.apply",
      idempotencyKey: input.idempotencyKey,
      expiresAt, deadline: performance.now() + SECRET_CHALLENGE_TTL_MS,
      secret: input.secret,
    };
    this.connectionSecretChallenges.set(challenge.id, challenge);
    this.connectionSecretChallengesByKey.set(challengeKey, challenge.id);
    const expiryTimer = setTimeout(() => {
      if (this.connectionSecretChallenges.get(challenge.id) !== challenge) return;
      this.connectionSecretChallenges.delete(challenge.id);
      if (this.connectionSecretChallengesByKey.get(challengeKey) === challenge.id) {
        this.connectionSecretChallengesByKey.delete(challengeKey);
      }
    }, SECRET_CHALLENGE_TTL_MS);
    expiryTimer.unref?.();
    return {
      ok: true,
      verification_id: challenge.id,
      expires_at: expiresAt,
      identity: { id: identity.id, username: identity.username },
    };
  }

  startConnectionSecretApply(input: {
    connectionId: string;
    verificationId: string;
    sessionBinding: string;
    idempotencyKey: string;
    execution?: SettingsExecution;
  }): { job: SecretApplyJob; reused: boolean } | { busy: SecretApplyJob | null } | { error: string } {
    for (const [jobId, job] of this.connectionSecretJobs) {
      if (job.connectionId === input.connectionId
        && job.idempotencyKey === input.idempotencyKey
        && this.connectionSecretJobSession.get(jobId) === input.sessionBinding) {
        return { job, reused: true };
      }
    }
    const challenge = this.connectionSecretChallenges.get(input.verificationId);
    if (!challenge || (challenge.deadline === undefined ? challenge.expiresAt <= Date.now() : challenge.deadline <= performance.now())) {
      this.connectionSecretChallenges.delete(input.verificationId);
      return { error: "verification expired; verify the secret again" };
    }
    if (challenge.connectionId !== input.connectionId
      || challenge.sessionBinding !== input.sessionBinding
      || challenge.operation !== "secret.apply"
      || challenge.idempotencyKey !== input.idempotencyKey
      || challenge.generation !== this.secureConnectionGeneration(input.connectionId)) {
      return { error: "verification does not match this connection or session" };
    }
    const existingId = this.connectionSecretInFlight.get(input.connectionId);
    if (existingId) {
      const existing = this.connectionSecretJobs.get(existingId) ?? null;
      if (existing?.idempotencyKey === input.idempotencyKey) return { job: existing, reused: true };
      return { busy: existing };
    }
    // Consume the challenge before scheduling work. A lost HTTP response can
    // retry with the same idempotency key and rejoin the job, but a second
    // request cannot replay the secret into a second adapter.
    this.connectionSecretChallenges.delete(input.verificationId);
    this.connectionSecretChallengesByKey.delete(`${input.sessionBinding}:${input.connectionId}:${input.idempotencyKey}`);
    const job: SecretApplyJob = {
      id: opaqueId("secret_apply"),
      connectionId: input.connectionId,
      idempotencyKey: input.idempotencyKey,
      result: "applying",
      status: "running",
      startedAt: Date.now(),
    };
    this.connectionSecretJobs.set(job.id, job);
    this.connectionSecretJobSession.set(job.id, input.sessionBinding);
    this.connectionSecretInFlight.set(input.connectionId, job.id);
    this.queueSettingsOperation(job, [settingsFileResource(join(this.dataDir, ".env")), `connection:${this.dataDir}:${job.connectionId}`], input.execution, execution => this.runConnectionSecretApply(job, challenge.secret, execution));
    return { job, reused: false };
  }

  getConnectionSecretApply(jobId: string, sessionBinding: string): SecretApplyJob | null {
    if (this.connectionSecretJobSession.get(jobId) !== sessionBinding) return null;
    return this.connectionSecretJobs.get(jobId) ?? null;
  }

  private async runConnectionSecretApply(job: SecretApplyJob, secret: string, execution?: SettingsExecution): Promise<void> {
    const channel = this.secureConnectionChannel(job.connectionId);
    const envKey = channel?.bot_token_env;
    const allowed = new Set((this.fleetConfig?.channels
      ?? (this.fleetConfig?.channel ? [this.fleetConfig.channel] : []))
      .map(item => item.bot_token_env));
    let before: import("./secret-store.js").SecretSnapshot | null = null;
    let oldToken: string | undefined;
    let store: SecretStore | undefined;
    const generation = this.settingsGeneration;
    let replaced = false;
    try {
      if (!channel || !envKey || !allowed.has(envKey)) throw new Error("connection is not configured for secret rotation");
      const owners = (this.fleetConfig?.channels
        ?? (this.fleetConfig?.channel ? [this.fleetConfig.channel] : []))
        .filter(item => item.bot_token_env === envKey);
      if (owners.length !== 1) throw new Error("secret key is shared by multiple connections");
      store = new SecretStore(join(this.dataDir, ".env"), allowed, { owner: execution?.owner });
      const write = (): void => {
        before = store!.write(envKey, secret); replaced = true; oldToken = process.env[envKey]; process.env[envKey] = secret;
        this.connectionSecretGenerations.set(job.connectionId, this.secureConnectionGeneration(job.connectionId) + 1);
      };
      if (execution) execution.mutate(write); else write();
      const applied = await this.rebuildAdapterForSecret(job.connectionId, channel, false, execution);
      execution?.assert();
      execution?.complete(); // Linearize success inside the runner, before its promise settles.
      if (!applied) {
        job.result = "restart_required";
        job.status = "done";
        job.finishedAt = Date.now();
        return;
      }
      job.result = "applied";
      job.status = "done";
      job.finishedAt = Date.now();
    } catch (err) {
      const message = safeSecretError(err, secret);
      this.logger.warn({ connectionId: job.connectionId, reason: message }, "Settings connection secret apply failed");
      if (!replaced || !before || !envKey) {
        job.result = "rollback_failed";
        job.error = "secret was not applied";
      } else {
        try {
          store!.restoreIfCurrent(before);
          if (process.env[envKey] === secret) { if (oldToken === undefined) delete process.env[envKey]; else process.env[envKey] = oldToken; }
          // Build a fresh adapter from the restored token. If the old adapter
          // was stopped already, this is the only safe way to return to the
          // previous runtime without claiming a disk-only rollback succeeded.
          const cleanup = { owner: execution?.owner ?? Symbol("secret-cleanup"), assert: () => {
            if (this.shuttingDown || this.settingsGeneration !== generation) throw new Error("secret cleanup superseded");
          } };
          const restored = await this.rebuildAdapterForSecret(job.connectionId, this.secureConnectionChannel(job.connectionId) ?? channel!, true, cleanup);
          if (!restored) throw new Error("adapter rollback did not become connected");
          job.result = "rolled_back";
        } catch (rollbackErr) {
          this.logger.error({ connectionId: job.connectionId, reason: safeSecretError(rollbackErr, oldToken, [secret]) }, "Settings connection secret rollback failed");
          job.result = "rollback_failed";
          job.error = "secret rollback failed; adapter is disabled";
        }
      }
      job.status = "done";
      job.finishedAt = Date.now();
    } finally {
      if (this.connectionSecretInFlight.get(job.connectionId) === job.id) this.connectionSecretInFlight.delete(job.connectionId);
      // Do not retain the token after the apply (success or rollback).
      secret = "";
    }
  }

  /** Stop the old provider client and construct a new one from process.env. */
  private async rebuildAdapterForSecret(connectionId: string, channel: ChannelConfig, force = false, execution?: Pick<SettingsExecution, "owner" | "assert">): Promise<boolean> {
    const generation = this.settingsGeneration;
    const current = (): boolean => !this.shuttingDown && this.settingsGeneration === generation;
    const check = (): void => { execution?.assert(); if (!current()) throw new Error("adapter operation superseded"); };
    check();
    const old = this.adapters.get(connectionId);
    if (!old && !force) return false; // The secret is valid on disk; the next start adopts it.
    const primary = this.getPrimaryAdapterId() === connectionId;
    const previousState = this.adapterState.get(connectionId);
    this.adapterState.set(connectionId, { status: "retrying", retryCount: previousState?.retryCount ?? 0 });
    if (primary && this.sessionPruneTimer) { clearInterval(this.sessionPruneTimer); this.sessionPruneTimer = null; }
    if (old) {
      old.removeAllListeners();
      await old.stop().catch(() => {}); check();
      if (this.adapters.get(connectionId) === old) this.adapters.delete(connectionId);
      if (this.worlds.get(connectionId)?.adapter === old) this.worlds.delete(connectionId);
      if (primary && this.adapter === old) this.adapter = null;
    }
    let startedResolve: (() => void) | null = null;
    const started = new Promise<void>(resolve => { startedResolve = resolve; });
    const onStarted = (): void => { startedResolve?.(); };
    if (primary) await this.startSingleAdapter(this.fleetConfig!, channel, onStarted, execution);
    else await this.startAdditionalAdapter(channel, true, onStarted, execution);
    check();
    const fresh = this.adapters.get(connectionId);
    if (!fresh) throw new Error("new adapter did not start");
    const deadline = performance.now() + 15_000;
    // Telegram has no gateway health snapshot. Its start() method launches the
    // grammY polling loop in the background, so completion of start() is not a
    // connected signal. The adapter's `started` event is emitted only after the
    // first provider getMe succeeds; require that event before claiming apply.
    if (!fresh.getHealthSnapshot) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("new adapter did not emit started before deadline")), Math.max(1, deadline - performance.now()));
        timer.unref?.();
      });
      try {
        await Promise.race([started, timeout]); check();
      } finally {
        if (timer) clearTimeout(timer);
      }
      this.adapterState.set(connectionId, { status: "connected", retryCount: 0 });
      return true;
    }
    while (performance.now() < deadline) {
      const health = fresh.getHealthSnapshot?.();
      if (health?.status === "connected" || this.adapterState.get(connectionId)?.status === "connected") return true;
      await new Promise(resolve => setTimeout(resolve, 100)); check();
    }
    throw new Error("new adapter did not become connected");
  }

  /**
   * What a reconcile is about to do, per target.
   *
   * A forecast, not the record: it is built from the same `classifyInstanceChange`
   * the reconcile decides with, but the rows that end up in the job are the ones
   * the reconcile reports as it works. A target the forecast missed (a Classic
   * instance inheriting a changed default) is added when it is first touched.
   */
  planConfigApply(): Array<{ target: string; kind: ApplyTargetKind }> {
    const rows: Array<{ target: string; kind: ApplyTargetKind }> = [];
    const nextConfig = this.nextFleetConfig();
    const next = nextConfig?.instances ?? {};
    const classicNames = new Set(this.classicChannels?.getAll().map(ch => ch.instanceName) ?? []);

    for (const [name, config] of Object.entries(next)) {
      const daemon = this.daemons.get(name);
      if (!daemon) { rows.push({ target: name, kind: "restart" }); continue; }
      const runtime = daemon.getConfigSnapshot?.();
      if (!runtime) continue;
      const change = classifyInstanceChange(runtime, config);
      if (change !== "none") rows.push({ target: name, kind: change === "restart" ? "restart" : "hot" });
    }
    for (const name of this.daemons.keys()) {
      if (!(name in next) && !classicNames.has(name)) rows.push({ target: name, kind: "restart" });
    }
    if (this.appliedFleetLevel !== null && this.appliedFleetLevel !== this.fleetLevelSignature(nextConfig)) {
      rows.push({ target: APPLY_FLEET_TARGET, kind: "restart" });
    }
    return rows;
  }

  /**
   * Start (or re-join) a Settings apply.
   *
   * The key is the client's. Handing back the existing job for a repeated key is
   * the whole point: the retry after a lost response must not apply everything a
   * second time.
   */
  startSettingsApply(key: string): { job: ApplyJob; reused: boolean } | { busy: ApplyJob | null } {
    // The key is checked first on purpose: a retry of the apply that is running
    // right now must get its own job back, not "busy".
    const existing = this.applyJobs.findByKey(key);
    if (existing) return { job: existing, reused: true };

    if (this.reconcileInFlight || this.activeApplyJobId) {
      return { busy: this.activeApplyJobId ? this.applyJobs.get(this.activeApplyJobId) : null };
    }

    const job = this.applyJobs.create(key, this.planConfigApply());
    // Reserved synchronously: the work starts a microtask later, and a second
    // request arriving in that gap must see the slot taken.
    this.activeApplyJobId = job.id;
    // Start after the caller has its answer, so the first thing the page renders
    // is the whole plan with every row still pending — not a job the reconcile
    // has already half-finished synchronously.
    queueMicrotask(() => void this.runSettingsApply(job.id));
    return { job, reused: false };
  }

  private async runSettingsApply(jobId: string): Promise<void> {
    const emit = (): void => {
      const job = this.applyJobs.get(jobId);
      // An accelerator only: these frames carry no event id, so a client that
      // reconnects cannot ask for what it missed. GET is the authority.
      if (job) this.emitSseEvent("apply_progress", viewOf(job));
    };
    // Passed in rather than parked on `this`: a shared field would let a second
    // reconcile redirect this job's reporting into another job's rows.
    const observer: ReconcileObserver = (target, kind, status, error) => {
      this.applyJobs.update(jobId, job => {
        let row = job.targets.find(item => item.target === target);
        if (!row) {
          row = { target, kind, status: "pending" };
          job.targets.push(row);
        }
        row.kind = kind;
        row.status = status;
        if (error) row.error = error;
      });
      emit();
    };
    emit();
    try {
      const started = this.startExclusiveReconcile(observer);
      if (!started) {
        // The slot was reserved before the microtask, so this means a SIGHUP
        // reconcile started in between. Report it instead of applying twice.
        this.applyJobs.finish(jobId, "a config reload was already running");
        return;
      }
      const outcome = await started;
      this.applyJobs.finish(jobId, outcome.rejected);
    } catch (err) {
      this.applyJobs.finish(jobId, err instanceof Error ? err.message : String(err));
    } finally {
      this.activeApplyJobId = null;
      emit();
    }
  }

  async restartInstances(): Promise<void> {
    if (!this.configPath) {
      this.logger.error("Cannot restart: no config path (was startAll called?)");
      return;
    }
    // A graceful restart keeps this manager process, so the startup probe does
    // not run again. Without this, `agend restart` left the cached CLI env
    // untouched and `/model` kept serving an old list until a cold start —
    // exactly the "only stop+start works" report. Background, never blocking:
    // /model re-probes on staleness anyway, this just makes a restart do the
    // refreshing a user expects of it.
    this.probeCliEnvs();
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
      if (await this.startInstanceUnattended(name, cfg, topicMode, "general instance")) restartProgress.markReady();
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
            if (await this.startClassicInstanceUnattended(ch, "classic instance")) restartProgress.markReady();
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
      // The same channel rule as `agend update` (#1259): an alpha follows @alpha, any other prerelease @beta.
      const channel = installedChannel(currentVersion);
      if (channel !== "latest") {
        // Prerelease users track their own channel (never fall back to @latest,
        // which is older, and an alpha is never offered @beta), but should also
        // hear when a newer STABLE ships — pick whichever is the newest.
        let pre = "";
        try {
          pre = await npmVersion(`@songsid/agend@${channel}`);
        } catch { /* no such tag */ }
        target = pre || latest;
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
        isPrereleaseVersion(currentVersion) && !isPrereleaseVersion(target) && core(target) === core(currentVersion);
      // Only notify when target is genuinely newer (semver), so a beta user on
      // 2.0.8-beta.16 is never told that stable 2.0.7 is "available".
      if (target && !betaSupersedesStable && this.semverGt(target, currentVersion)) {
        const generalId = this.findGeneralInstance();
        if (generalId) {
          // No release URL — Discord's SuppressEmbeds proved unreliable and the
          // link preview looked bad. Version + /update instruction is enough.
          this.notifyInstanceTopic(generalId, t(updateNoticeKey(currentVersion, target), `v${target}`, `v${currentVersion}`));
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

  /** Distinct rejected Host names already logged; bounded so a scanner cannot grow it. */
  private readonly rejectedHostsLogged = new Set<string>();

  /**
   * Say once per name why a request was refused, so a reverse-proxy deployment
   * that stopped working after the Host check is diagnosable from fleet.log.
   * Only the parsed host name is logged, never the raw header.
   */
  private noteRejectedHost(header: string | string[] | undefined): void {
    const name = typeof header === "string" ? (hostnameOf(header) ?? "(malformed)") : "(missing)";
    if (this.rejectedHostsLogged.has(name) || this.rejectedHostsLogged.size >= 32) return;
    this.rejectedHostsLogged.add(name);
    this.logger.warn({ host: name }, "Web request refused: Host is not allowed (add it to web.allowed_hosts if this is a proxy you run)");
  }

  /** Shared handler dispatcher; gateway admission is enforced by its separate listener. */
  private dispatchWebHttp(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, port: number): void {
    try {
      res.setHeader("Content-Type", "application/json");
      // No Referer to a tunnel host, an upstream proxy, or any page linked from
      // the panel — the dashboard URL is itself a credential-bearing address.
      res.setHeader("Referrer-Policy", "no-referrer");
      // Authorization now depends on a cookie, so a shared cache (a tunnel, a
      // corporate proxy) must not serve one visitor's response to another.
      res.setHeader("Vary", "Cookie");
      applyWebSecurityHeaders(res);

      // Before any route, /health and /agent included: loopback binding does not
      // stop DNS rebinding, and the Host the browser sends is the one thing a
      // rebinding page cannot change.
      if (!gatewayRequestContext(req) && !isHostAllowed(req.headers.host, allowedHostNames(this.fleetConfig))) {
        this.noteRejectedHost(req.headers.host);
        res.writeHead(403);
        res.end(JSON.stringify({ error: WEB_HOST_REJECTED_MESSAGE }));
        return;
      }

      const requestPath = new URL(req.url ?? "/", `http://localhost:${port}`).pathname;

      // Browsers request this automatically and AgEnD does not ship an icon.
      // It is neither user data nor an API route, so do not turn the harmless
      // probe into a noisy web-token 401 in the browser console.
      if (req.method === "GET" && requestPath === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Public: the health probe, /agent (instance-token auth of its own), the
      // sign-in surface, and /view's reads unless web.view_access says otherwise.
      if (bypassesWebGate(req, requestPath, this.fleetConfig, p => !gatewayRequestContext(req) && (isViewPath(p) || isUsagePath(p)))) {
        // fall through to the handlers below
      } else {
        // All other endpoints require a session cookie or an X-Agend-Token
        // header; a `?token=` in the URL is not a credential.
        // /ui/* will also re-check in web-api.ts, which is harmless.
        const parsedUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
        const decision = decideWebGate(req, parsedUrl, this.webToken, this.webSessions);
        if (decision.kind === "reject") {
          // A browser navigating to a panel with no cookie gets the sign-in page,
          // not a JSON error: a SameSite=Strict cookie is not sent on a link
          // followed from a chat app, and the page can tell "no session" from "cookie
          // not sent" by asking from inside the site. API callers still get JSON.
          if (decision.reason === "no-credential" && req.method === "GET"
            && String(req.headers.accept ?? "").includes("text/html")
            && isWebPageNavigation(requestPath)) {
            serveSigninPage(res, 401);
            return;
          }
          res.writeHead(decision.status);
          res.end(JSON.stringify({ error: decision.message }));
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
        try {
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
              ...this.instancePresentation(inst.name),
            };
          });
          if (!gatewayRequestContext(req)) res.setHeader("Access-Control-Allow-Origin", "*");
          res.writeHead(200);
          res.end(JSON.stringify({
            ...sysInfo,
            version: this.currentVersion,
            instances: enriched,
            publicLink: this.getPublicWebStatus(),
          }));
        } catch (err) {
          this.logger.error({ err }, "/api/fleet failed");
          if (!res.headersSent) {
            res.writeHead(500);
            res.end("Internal Server Error");
          }
        }
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
        if (!gatewayRequestContext(req)) res.setHeader("Access-Control-Allow-Origin", "*");
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
            await this.restartSingleInstance(name, { explicit: true });
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
      // A handler that throws synchronously answers this request with a 500; it must never reach the process's
      // uncaughtException handler, which stops the whole fleet (#1252 review: one file name did that).
      try {
        if (handleAuthRequest(req, res, url, this as unknown as AuthApiContext)) return;
        if (handleViewRequest(req, res, url, this as unknown as import("./view-api.js").ViewApiContext)) return;
        if (handleUsageRequest(req, res, url, this as unknown as import("./usage/usage-api.js").UsageApiContext)) return;
        const settingsNext = (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, address: URL): boolean =>
          handleSettingsRequest(request, response, address, this as unknown as import("./settings-api.js").SettingsApiContext)
          || handleWebRequest(request, response, address, this as unknown as import("./web-api.js").WebApiContext);
        if (this.settingsGate().handle(req, res, url, settingsNext)) return;
        if (settingsNext(req, res, url)) return;
      } catch (err) {
        this.logger.error({ err: (err as Error)?.message, path: url.pathname }, "Web request handler threw");
        if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: "internal error" })); }
        else res.destroy();
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found" }));
    } catch { if (!res.headersSent) { res.writeHead(400); res.end(JSON.stringify({ error: "invalid request" })); } else res.destroy(); }
  }

  private startHealthServer(port: number): void {
    this.startedAt = Date.now();
    this.healthServerListening = false;
    this.healthPortRetried = false;
    // Defensive for direct/unit callers; normal startup initializes these before adapters.
    if (!this.webToken || !this.webSessions) this.initializeWebAuthTokens();

    this.healthServer = createServer((req, res) => this.dispatchWebHttp(req, res, port));

    const markListening = (afterTakeover = false): void => {
      this.healthServerListening = true;
      this.logger.info({ port }, afterTakeover
        ? "Health endpoint listening (after takeover)"
        : "Health endpoint listening");
      // Never the token: fleet.log is readable by anything that can read the
      // data dir, is copied into bug reports, and is tailed in shared terminals.
      // `/dashboard` and `agend web` are the ways to get an authorized link.
      this.logger.info({ url: `http://localhost:${port}/ui` }, "Web UI available (open it with /dashboard or `agend web`)");
      this.logger.info({ url: `http://localhost:${port}/view` }, "Web View available");
      // #1306: the preview listener starts once the web listener is bound — its frame-ancestors name the real port.
      const bound = this.healthServer?.address();
      this.startPreviewListener(port, bound && typeof bound === "object" ? bound.port : port);
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
              // fleet.pid is a claim, not proof. A stale or wrong entry points
              // at whatever now holds that pid, and this used to SIGTERM it —
              // an unrelated process killed because a port was busy. Confirm
              // the target really is an AgEnD fleet, and when that cannot be
              // confirmed, do not signal: not killing costs a dashboard, and
              // killing costs somebody else's process.
              const commandLine = readProcessCommandLine(oldPid);
              if (isFleetStartCommandLine(commandLine)) {
                process.kill(oldPid, "SIGTERM");
                this.logger.info({ oldPid }, "Killed old fleet process");
              } else {
                this.logger.warn({
                  oldPid,
                  // Truncated: this is an unrelated process's command line, and
                  // fleet.log is copied into bug reports.
                  commandLine: commandLine ? `${commandLine.slice(0, 60)}${commandLine.length > 60 ? "…" : ""}` : "(unreadable)",
                }, "fleet.pid does not name an AgEnD fleet process — not signalling it");
              }
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

  /**
   * #1306: the preview listener, beside the web listener and closed with it. When it cannot listen (the port is
   * taken, web.preview: false), cards show Source and Download only; nothing else changes.
   */
  private startPreviewListener(requestedPort: number, boundPort: number): void {
    this.stopPreviewListener();
    this.previewPorts = { requested: requestedPort, bound: boundPort };
    this.previewInputs = this.previewInputsSignature();
    // web.preview is hot; web.preview_port and web.preview_origin are startup-only (STARTUP_ONLY_FLEET_KEYS): they
    // come from the configuration this process started on, so a reload that changes them reports "restart required"
    // and a hot re-enable never half-applies them.
    const started = (this.startupFleetConfig ?? this.fleetConfig)?.web;
    const settings = previewSettings({ preview: this.fleetConfig?.web?.preview, preview_port: started?.preview_port, preview_origin: started?.preview_origin }, requestedPort);
    if (!settings.enabled) return;
    if (settings.port === null) {
      this.logger.warn({ health_port: requestedPort }, "No port for the HTML preview listener (health_port is the highest port) — set web.preview_port; previews are off");
      return;
    }
    const listener = createPreviewListener({ settings, healthPort: boundPort, config: this.fleetConfig });
    this.previewListener = listener;
    listener.server.on("error", (err: NodeJS.ErrnoException) => {
      if (this.previewListener !== listener) return;
      this.logger.warn({ code: err.code, port: settings.port }, "Preview listener unavailable; HTML previews are off");
      this.previewListening = false;
      this.previewListener = null;
    });
    // An optional listener never takes the fleet down: a port Node refuses outright throws here, synchronously.
    try {
      listener.server.listen(settings.port, "127.0.0.1", () => { if (this.previewListener === listener) this.previewListening = true; });
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, port: settings.port }, "Preview listener cannot listen; HTML previews are off");
      this.previewListening = false;
      this.previewListener = null;
    }
  }

  /** What a reload may change hot: web.preview, and the dashboard names (the shim's allow-list and frame-ancestors). */
  private previewInputsSignature(): string {
    const c = this.fleetConfig;
    return JSON.stringify({ p: c?.web?.preview ?? null, h: c?.hostname ?? null, a: c?.web?.allowed_hosts ?? null });
  }

  /**
   * After a config reload: web.preview true→false stops the listener at once (/ui then offers no origin, boot or
   * frame-src), false→true starts it, and a change of dashboard names rebuilds it (a new boot id). preview_port and
   * preview_origin are not adopted here: they are startup-only, and the reload reports "restart required".
   */
  private reconcilePreviewListener(): void {
    if (!this.previewPorts || this.previewInputsSignature() === this.previewInputs) return;
    this.logger.info({}, "HTML preview settings changed — rebuilding the preview listener");
    this.startPreviewListener(this.previewPorts.requested, this.previewPorts.bound);
  }

  private stopPreviewListener(): void {
    this.previewListening = false;
    this.previewListener?.close();
    this.previewListener = null;
  }

  /** For one /ui load: the preview origin it may frame, and the listener's boot id (see web-preview.ts). */
  previewForUi(hostHeader: string | undefined, secure: boolean): PreviewAvailability & { boot: string | null } {
    const listener = this.previewListening ? this.previewListener : null;
    const decided = previewAvailability(listener ? listener.settings : null, hostHeader, secure, listener ? listener.origins : undefined);
    if (!listener && this.fleetConfig?.web?.preview !== false) decided.reason = "Previews are not available on this fleet right now.";
    return { ...decided, boot: listener ? listener.bootId : null };
  }

  getUiStatus(): unknown {
    return measureSyncWork("fleet.uiStatus", () => this.getUiStatusSync());
  }
  private getUiStatusSync(): unknown {
    const fleetNames = Object.keys(this.fleetConfig?.instances ?? {});
    // Classic rooms live only in classicBot.yaml — /api/profiles merges them into
    // the View roster, but previously getUiStatus skipped them so context_pct was
    // always 0 (live map miss → l?.context_pct ?? 0).
    const classicOnly = (this.classicChannels?.getAll() ?? [])
      .map(ch => ch.instanceName)
      .filter(name => !fleetNames.includes(name));
    const names = [...fleetNames, ...classicOnly];
    // The identity every page shows (alpha.2, N1): alias, description, role and tags resolved by the same rule as
    // /api/profiles (resolveInstanceIdentity) — the sidebar groups, searches and labels with it on every page.
    const classicRooms = new Map((this.classicChannels?.getAll() ?? []).map(ch => [ch.instanceName, ch]));
    const profiles = profileIdentities(this.dataDir);

    const instances = names.map(name => {
      const statusFile = join(this.getInstanceDir(name), "statusline.json");
      let cost = 0;
      try {
        const data = JSON.parse(readFileSync(statusFile, "utf-8"));
        cost = data.cost?.total_cost_usd ?? 0;
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
      // context_pct: null when unavailable, not 0
      const context_pct = context ?? null;
      // Model: Only Claude Code has live statusline; others use the effective resolver.
      // readStatuslineModel provides the /ctx-aligned display_name+id combo for Claude.
      // Non-Claude backends must NOT read statusline.json model (may be stale from previous Claude run).
      const resolved = this.resolveInstanceModel(name);
      const liveModel = backend === "claude-code" ? readStatuslineModel(this.dataDir, name) : null;
      // Display value: live model for Claude, resolved.display for others (includes "auto (default)" for Kiro)
      const model = liveModel ?? resolved.display;
      // model_source: "live" when Claude statusline succeeded, else the resolver's source
      const model_source = liveModel ? "live" : resolved.source;
      // Effort: aligned with /ctx's effortLineFor — unsupported and antigravity don't show effort.
      const effortStrategy = this.effortStrategyFor(name);
      const isAgy = backend === "antigravity" || backend === "agy";
      const effortResolved = this.resolveInstanceEffort(name);
      // Only show effort if backend supports it and it's not antigravity
      const effort = (effortStrategy === "unsupported" || isAgy) ? null : effortResolved.effort;
      const effort_source = (effortStrategy === "unsupported" || isAgy) ? null : effortResolved.source;
      const identity = resolveInstanceIdentity({ cfg: this.fleetConfig?.instances[name], classic: classicRooms.get(name), profile: profiles.get(name) });
      return {
        name,
        display_name: identity.display_name || undefined,
        description: identity.description || undefined,
        role: identity.role || undefined,
        tags: identity.tags,
        status: this.getInstanceStatus(name),
        // `state` (presentation: may be awaiting_input) and `execution_state` (working / idle / stuck, or null —
        // what the dashboard's activity events carry) come from instancePresentation (#1212).
        context_pct,
        cost,
        model,
        model_source,
        backend,
        effort,
        effort_source,
        ...this.instancePresentation(name),
      };
    });
    return {
      instances,
      publicLink: this.getPublicWebStatus(),
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
