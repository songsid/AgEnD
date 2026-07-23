import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync, rmSync, readdirSync, renameSync, copyFileSync, chmodSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgendHome, ensureWorkspaceGit } from "./paths.js";
import { sdNotify } from "./sd-notify.js";
import { isScalar, parseDocument } from "yaml";

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
import type { ChannelAdapter, InboundMessage, Choice } from "./channel/types.js";
import { createAdapter } from "./channel/factory.js";
import { createLogger, type Logger } from "./logger.js";
import { processAttachments } from "./channel/attachment-handler.js";
import { routeToolCall } from "./channel/tool-router.js";
import { Scheduler } from "./scheduler/index.js";
import type { Schedule, SchedulerConfig } from "./scheduler/index.js";
import { DEFAULT_SCHEDULER_CONFIG } from "./scheduler/index.js";
import type { FleetContext } from "./fleet-context.js";
import { TopicCommands, saveCommandForBackend, parseSaveFilename, parsePauseWakeCommand, SAVE_FILENAME_RE, SAVE_UNSUPPORTED_MSG } from "./topic-commands.js";
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
import { handleSettingsRequest, type RawConfigPatch } from "./settings-api.js";
import { setLocale, detectLocale, t } from "./locale.js";
import { handleAgentRequest, type AgentEndpointContext } from "./agent-endpoint.js";
import { ClassicChannelManager, getClassicBackendChoices, isSelectableClassicBackend, readClassicLastActivityAt } from "./classic-channel-manager.js";
import type { InstanceState, InstanceStateSnapshot } from "./backend/types.js";
import { readLastInboundAt } from "./daemon.js";
import { clearPausedMarker } from "./pause-marker.js";

import { getTmuxSession } from "./config.js";

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
  retiring?: boolean;
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

export class FleetManager implements FleetContext, LifecycleContext, ArchiverContext, StatuslineWatcherContext, OutboundContext, AgentEndpointContext {
  private children: Map<string, import("node:child_process").ChildProcess> = new Map();
  readonly lifecycle: InstanceLifecycle;
  /** @deprecated Use lifecycle.daemons — kept for backward compat */
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

  /** Primary world (first adapter) — used for fleet-level notifications */
  get primaryWorld(): AdapterWorld | undefined { return this.worlds.values().next().value as AdapterWorld | undefined; }
  readonly routing = new RoutingEngine();
  get routingTable(): Map<string, RouteTarget> { return this.routing.map; }
  instanceIpcClients: Map<string, IpcClient> = new Map();
  scheduler: Scheduler | null = null;
  private configPath: string = "";
  logger: Logger = createLogger("info");
  private topicCommands: TopicCommands;
  // sessionName → instanceName mapping for external sessions
  sessionRegistry: Map<string, string> = new Map();
  eventLog: EventLog | null = null;
  costGuard: CostGuard | null = null;
  private statuslineWatcher: StatuslineWatcher;
  private dailySummary: DailySummary | null = null;
  private webhookEmitter: WebhookEmitter | null = null;

  // Topic icon + auto-archive state
  private topicIcons: { green?: string; blue?: string; red?: string } = {};
  private lastActivity = new Map<string, number>();
  /** Latest pane-derived execution snapshot reported by each daemon. */
  private instanceStateCache = new Map<string, InstanceStateSnapshot>();
  /** Instances currently being auto-paused by warm_cap, so concurrent checks don't double-evict. */
  private warmCapEvicting = new Set<string>();
  /** Per-instance tail keeps cross-instance and scheduled deliveries FIFO. */
  private idleGatedDeliveryTails = new Map<string, Promise<void>>();
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
  // Last user message delivered to each instance — used to react ✅ on completion.
  private lastInboundMsg = new Map<string, { adapterId?: string; chatId: string; threadId?: string; messageId: string; source?: string }>();
  private topicArchiver: TopicArchiver;

  controlClient: TmuxControlClient | null = null;
  classicChannels: ClassicChannelManager | null = null;
  private pendingClassicStarts = new Map<string, PendingClassicStart>();

  // Model failover state
  private failoverActive = new Map<string, string>(); // instance → current failover model

  // IPC reconnect: tracks instances being intentionally stopped (skip reconnect)
  readonly ipcStoppingInstances = new Set<string>();

  // Adapter restart: prevents re-entrant restart attempts
  private adapterRestarting = new Set<string>();
  // Adapter isolation: track state per adapter for retry + visibility
  private adapterState = new Map<string, { status: "connected" | "retrying" | "failed"; retryCount: number; lastError?: string; retryTimer?: ReturnType<typeof setTimeout> }>();
  private collabInstances = new Set<string>();

  // Health endpoint
  private healthServer: Server | null = null;
  private healthPortRetried = false;
  private updateCheckTimer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;

  // Mirror topic: buffer cross-instance messages, flush every 3s
  private mirrorBuffer: string[] = [];
  private mirrorTimer: ReturnType<typeof setTimeout> | null = null;

  // Web UI: SSE clients + auth token
  private sseClients = new Set<import("node:http").ServerResponse>();
  private webToken: string | null = null;
  private viewToken: string | null = null;

  constructor(public dataDir: string) {
    this.lifecycle = new InstanceLifecycle(this);
    this.topicCommands = new TopicCommands(this);
    this.topicArchiver = new TopicArchiver(this);
    this.statuslineWatcher = new StatuslineWatcher(this);
  }

  // ── ArchiverContext bridge ────────────────────────────────────────────
  lastActivityMs(name: string): number {
    return this.lastActivity.get(name) ?? 0;
  }

  private getInstanceIdle(name: string): boolean {
    try {
      const widFile = join(this.getInstanceDir(name), "window-id");
      if (!existsSync(widFile)) return true;
      const wid = readFileSync(widFile, "utf-8").trim();
      return wid ? (this.controlClient?.isIdle(wid) ?? true) : true;
    } catch { return true; }
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
    // Always update adapter openChannels (including empty — clears stale entries on /stop)
    for (const [adapterId, w] of this.worlds) {
      if (typeof (w.adapter as any)?.setOpenChannels === "function") {
        const owned = channels.filter(ch => ch.adapterId === adapterId).map(ch => ch.channelId);
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

  /** Get the adapter bound to an instance, falling back to primary adapter */
  getAdapterForInstance(name: string): ChannelAdapter | null {
    const worldId = this.instanceWorldBinding.get(name);
    if (worldId) return this.worlds.get(worldId)?.adapter ?? this.adapter;
    return this.adapter;
  }

  /** Get the world for an instance */
  getWorldForInstance(name: string): AdapterWorld | undefined {
    const worldId = this.instanceWorldBinding.get(name);
    return worldId ? this.worlds.get(worldId) : (this.worlds.values().next().value as AdapterWorld | undefined);
  }

  /** Get channel config for a specific adapter (by id), falling back to primary */
  getChannelConfig(adapterId?: string): import("./types.js").ChannelConfig | undefined {
    if (adapterId) {
      const world = this.worlds.get(adapterId);
      if (world) return world.channelConfig;
    }
    return this.fleetConfig?.channel;
  }

  /** Get the group_id for an instance's bound adapter */
  getGroupIdForInstance(name: string): string {
    const world = this.getWorldForInstance(name);
    return world?.groupId ?? String(this.fleetConfig?.channel?.group_id ?? "");
  }

  /**
   * Bind an instance to a specific world (the bot that answers for it).
   * fromInbound=true (binding inferred from which adapter received a message)
   * must not override a configured identity: skip when the instance is a general
   * or has an explicit channel_id — otherwise a persona instance whose message
   * was also seen by the main bot would get rebound to the wrong bot.
   */
  bindInstanceAdapter(name: string, adapterId: string, fromInbound = false): void {
    const cfg = this.fleetConfig?.instances[name];
    if (fromInbound) {
      // Skip inbound-derived binding for any instance that doesn't have an
      // explicit channel_id — those default to primary adapter deterministically.
      // This prevents a non-deterministic race where whichever adapter delivers
      // first after restart wins the binding.
      if (cfg?.general_topic || cfg?.channel_id) return;
      if (cfg && !cfg.channel_id) return; // fleet instance without explicit binding → use primary
      // Classic instance: don't override an existing binding (authoritative from /start)
      if (this.classicChannels?.getChannelIdByInstance(name) !== undefined && this.instanceWorldBinding.has(name)) return;
    }
    this.instanceWorldBinding.set(name, adapterId);
  }

  getInstanceStatus(name: string): "running" | "paused" | "stopped" | "crashed" {
    if (this.lifecycle.isPaused(name)) return "paused";
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
    return this.instanceStateCache.get(name)?.state ?? null;
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
    });
    for (const check of this.instanceIdleWaiters.get(name) ?? []) check();
    // warm_cap: a fresh transition into idle may free this instance for eviction,
    // or (more usefully) reveal that the fleet is now over cap. Only fire on the
    // edge into idle, not on every idle heartbeat.
    if (state === "idle" && previous?.state !== "idle") this.enforceWarmCap();
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
      isGeneral: name => this.fleetConfig?.instances[name]?.general_topic === true,
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

  private waitForInstanceIdle(instanceName: string, timeoutMs: number, idleObservedAfter = 0): Promise<boolean> {
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
      const check = () => { if (isReady()) finish(true); };
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

  private async deliverWithIdleGate(
    instanceName: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<void> {
    let idleObservedAfter = this.lastDeliveryAt.get(instanceName) ?? 0;
    if (this.lifecycle.isPaused(instanceName)) {
      const wakeStartedAt = Date.now();
      await this.lifecycle.wake(instanceName, 30_000);
      // Waking added one to the warm count — make room by evicting a different
      // LRU idle instance (never this one; it's about to work).
      this.enforceWarmCap(instanceName);
      // Never satisfy a post-wake gate from a stale pre-pause cache entry.
      idleObservedAfter = Math.max(idleObservedAfter, wakeStartedAt);
    }

    const idle = await this.waitForInstanceIdle(instanceName, timeoutMs, idleObservedAfter);
    if (!idle) {
      this.logger.warn({ instanceName, timeoutMs }, "Idle gate timed out; forcing delivery");
    }
    const ipc = this.instanceIpcClients.get(instanceName);
    if (!ipc?.connected) throw new Error(`Instance '${instanceName}' IPC is unavailable`);
    ipc.send(payload);
    this.lastDeliveryAt.set(instanceName, Date.now());
  }

  /** Single delivery facade: wake paused CLIs and serialize non-user work behind idle. */
  async deliverToInstance(
    instanceName: string,
    payload: Record<string, unknown>,
    options: DeliveryOptions = {},
  ): Promise<void> {
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
        this.enforceWarmCap(instanceName); // woke one → evict a different LRU idle if over cap
      }
      const ipc = this.instanceIpcClients.get(instanceName);
      if (!ipc?.connected) throw new Error(`Instance '${instanceName}' IPC is unavailable`);
      ipc.send(payload);
      // A cross-instance item arriving before the daemon observes this turn as
      // working must not trust the stale idle snapshot from before the send.
      this.lastDeliveryAt.set(instanceName, Date.now());
      return;
    }

    const previous = this.idleGatedDeliveryTails.get(instanceName) ?? Promise.resolve();
    const delivery = previous.catch(() => {}).then(() => this.deliverWithIdleGate(
      instanceName,
      payload,
      options.idleTimeoutMs ?? 60_000,
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

  async startInstance(name: string, config: InstanceConfig, topicMode: boolean): Promise<void> {
    if (this.lifecycle.isPaused(name)) {
      this.logger.info({ name }, "Persisted paused instance — skipping startup");
      return;
    }
    if (config.general_topic) {
      // antigravity (agy) does not read MCP instructions — fleet context and
      // routing instructions are not injected, so it cannot act as a dispatcher.
      const backend = config.backend ?? this.fleetConfig?.defaults?.backend ?? "claude-code";
      if (backend === "antigravity") {
        this.logger.warn({ name }, "antigravity backend does not support MCP instructions — general dispatcher will not work correctly");
        this.notifyInstanceTopic(name, "⚠️ antigravity backend is not supported for General instances (no MCP instructions injection). Switch to claude-code or kiro-cli.");
      }
      this.ensureGeneralInstructions(config.working_directory, config.backend);
    }
    await this.lifecycle.start(name, config, topicMode);
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
  ): Promise<void> {
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
      this.logger.info({ concurrency, freeMemMB: freeMemMB, totalInstances: entries.length }, "Adaptive startup concurrency");
    }

    const byWorkDir = new Map<string, [string, InstanceConfig][]>();
    for (const [name, config] of entries) {
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
              await this.startInstance(name, config, topicMode).catch((err) =>
                this.logger.error({ err, name }, "Failed to start instance"),
              );
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

  async stopInstance(name: string): Promise<void> {
    this.failoverActive.delete(name);
    this.instanceStateCache.delete(name);
    this.lastDeliveryAt.delete(name);
    return this.lifecycle.stop(name);
  }

  /** Restart a single instance, reloading fleet.yaml first to pick up config changes. */
  async restartSingleInstance(name: string): Promise<void> {
    if (this.configPath) {
      this.loadConfig(this.configPath);
      this.routing.rebuild(this.fleetConfig!);
      this.reregisterClassicChannels();
    }
    const config = this.fleetConfig?.instances[name];
    if (config) {
      await this.stopInstance(name);
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
      const key = trimmed.slice(0, eqIdx);
      const raw = trimmed.slice(eqIdx + 1);
      const value = raw.replace(/^["'](.*)["']$/, '$1');
      // .env file always wins over inherited shell env vars, so that
      // quickstart's newly written token overrides any stale value.
      process.env[key] = value;
    }
  }

  /** Start all instances from fleet config */
  async startAll(configPath: string): Promise<void> {
    this.configPath = configPath;
    this.loadEnvFile();

    // Rotate fleet.log if oversized (before any logging)
    const { rotateLogIfNeeded } = await import("./logger.js");
    rotateLogIfNeeded(join(this.dataDir, "fleet.log"));

    const fleet = this.loadConfig(configPath);
    setLocale(detectLocale(fleet)); // user-facing text language (fleet.yaml defaults.locale / timezone)
    const topicMode = fleet.channel?.mode === "topic" || !!fleet.channels?.some(ch => ch.mode === "topic");

    // Set tmux socket isolation for custom AGEND_HOME
    const { getTmuxSocketName: getSocket } = await import("./paths.js");
    TmuxManager.setSocketName(getSocket());

    await TmuxManager.ensureSession(getTmuxSession());

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

    this.eventLog = new EventLog(join(this.dataDir, "events.db"));

    // Initialize classic channel manager. The primary adapter (channels[0])
    // migrates legacy single-bot entries and names without a suffix. Classic
    // routing does NOT go through the routing engine (single-key, can't hold two
    // bots in one channel) — it resolves per-bot via getInstanceByChannel.
    this.classicChannels = new ClassicChannelManager(this.dataDir, this.logger);
    const primaryCh = fleet.channels?.[0] ?? fleet.channel;
    if (primaryCh) this.classicChannels.setPrimaryAdapterId(primaryCh.id ?? primaryCh.type);
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
      this.ensureGeneralInstructions(generalDir, backendName);
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

    if (generals.length > 0) {
      for (const [name, cfg] of generals) {
        try {
          await this.startInstance(name, cfg, topicMode);
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

    // Signal systemd: generals ready
    sdNotify("READY=1");
    this.watchdogTimer = setInterval(() => sdNotify("WATCHDOG=1"), 30_000);

    // Phase 2: Start remaining instances with staggered concurrency
    if (others.length > 0) {
      await this.startInstancesWithConcurrency(others, topicMode);
    }

    if (topicMode && (fleet.channel || fleet.channels?.length)) {

      try {
        await this.startSharedAdapter(fleet);
      } catch (err) {
        this.logger.error({ err }, "startSharedAdapter failed — fleet continues without some adapters");
      }

      // Bind instances to their adapter (which bot answers on their behalf).
      // An explicit channel_id is authoritative — this is how a persona instance
      // picks its bot when several share one guild. Generals without a channel_id
      // fall back to a name-contains-adapterId heuristic.
      const channelConfigsForBind = fleet.channels ?? (fleet.channel ? [fleet.channel] : []);
      for (const [name, config] of Object.entries(fleet.instances)) {
        if (config.channel_id) {
          this.bindInstanceAdapter(name, config.channel_id);
          continue;
        }
        if (!config.general_topic) continue;
        for (const ch of channelConfigsForBind) {
          const id = ch.id ?? ch.type;
          if (name.includes(id)) { this.bindInstanceAdapter(name, id); break; }
        }
      }

      // Guard against a stale/invalid general topic_id. An old auto-general
      // could have written the TG-convention "1" for a Discord general; the DC
      // adapter then throws fetching channel "1" → unhandled → fleet crash loop.
      // Unbind (+ warn) so it's simply skipped, never routed to a bogus channel.
      let fixedGeneral = false;
      for (const [name, cfg] of Object.entries(this.fleetConfig!.instances)) {
        if (!cfg.general_topic || cfg.topic_id == null) continue;
        const adapterId = this.instanceWorldBinding.get(name) ?? cfg.channel_id;
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
        const channels = this.classicChannels.getAll();
        const concurrency = 3;
        let idx = 0;
        while (idx < channels.length) {
          const batch = channels.slice(idx, idx + concurrency);
          await Promise.allSettled(batch.map(ch =>
            this.startClassicInstance(
              ch.instanceName,
              this.classicChannels!.getBackendByInstance(ch.instanceName, fleetBackend),
              this.classicChannels!.getPreTaskCommand(ch.channelId, ch.adapterId),
              this.classicChannels!.getModel(ch.channelId, ch.adapterId, this.fleetConfig?.defaults?.model),
              this.classicChannels!.getAutoPauseAfter(ch.channelId, ch.adapterId, this.fleetConfig?.defaults?.auto_pause_after),
            ).catch(err =>
              this.logger.warn({ err, instanceName: ch.instanceName }, "Failed to start classic instance"))
          ));
          idx += concurrency;
        }
      }

      for (const name of Object.keys(fleet.instances)) {
        this.startStatuslineWatcher(name);
      }

      // Notify General topic that fleet is up
      const classicCount = this.classicChannels?.getAll().length ?? 0;
      const total = Object.keys(fleet.instances).length + classicCount;
      const started = this.daemons.size;
      const allNotRunning = Object.keys(fleet.instances).filter(n => !this.daemons.has(n));
      const pausedNames = allNotRunning.filter(n => this.lifecycle.isPaused(n));
      const failedNames = allNotRunning.filter(n => !this.lifecycle.isPaused(n));
      const generalName = this.findGeneralInstance();
      const generalThreadId = generalName ? fleet.instances[generalName]?.topic_id : undefined;
      const { createRequire } = await import("node:module");
      const _require = createRequire(import.meta.url);
      const agendVersion = _require("../package.json").version ?? "unknown";
      if (this.adapter && fleet.channel?.group_id) {
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

    // SIGHUP: hot-reload instance config (add/remove/restart instances)
    const onSighup = () => {
      this.logger.info("Received SIGHUP, hot-reloading config...");
      this.reconcileInstances()
        .catch(err => this.logger.error({ err }, "SIGHUP config reload failed"));
      process.once("SIGHUP", onSighup);
    };
    process.once("SIGHUP", onSighup);

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
      this.notifyInstanceTopic(generalId, `⚠️ Adapter "${adapterId}" failed to start: ${error}\nRetrying in background. Other adapters unaffected.`);
    }
  }

  /** Notify admin that a retried adapter reconnected. */
  private notifyAdapterRecovery(adapterId: string, attempts: number): void {
    const generalId = this.findGeneralInstance();
    if (generalId) {
      this.notifyInstanceTopic(generalId, `✅ Adapter "${adapterId}" reconnected (after ${attempts} ${attempts === 1 ? "retry" : "retries"}).`);
    }
  }

  /** Get adapter states for /status visibility. */
  getAdapterStates(): Map<string, { status: string; retryCount: number; lastError?: string }> {
    return this.adapterState;
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

    this.adapter.on("callback_query", safeHandler(async (data: AdapterCallbackData) => {
      if (await this.handleClassicBackendSelection(data)) return;
      if (data.callbackData.startsWith("hang:")) {
        const parts = data.callbackData.split(":");
        const action = parts[1];
        const instanceName = parts[2];
        if (action === "restart") {
          await this.stopInstance(instanceName);
          const config = this.fleetConfig?.instances[instanceName];
          if (config) {
            const topicMode = this.fleetConfig?.channel?.mode === "topic";
            await this.startInstance(instanceName, config, topicMode);
            // startInstance already calls connectIpcToInstance
          }
          this.adapter?.editMessage(data.chatId, data.messageId, `🔄 ${instanceName} restarted.`, data.threadId).catch(() => {});
        } else {
          this.adapter?.editMessage(data.chatId, data.messageId, `⏳ Continuing to wait for ${instanceName}.`, data.threadId).catch(() => {});
        }
        return;
      }
      if (data.callbackData.startsWith("cancel:")) {
        const instanceName = data.callbackData.slice("cancel:".length);
        // Idempotent: a button click only acts while the button is live. A
        // second click (entry already cleared) is a no-op — don't re-send the
        // interrupt key. (The /cancel command path calls cancelInstance directly.)
        if (this.hasCancelButton(instanceName)) this.cancelInstance(instanceName);
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
        const allowed = this.fleetConfig?.channel?.access?.allowed_users ?? [];
        if (allowed.length > 0 && !allowed.some(u => String(u) === String(data.userId))) {
          await data.respond(t("not_authorized"));
          return;
        }
        await data.respond(t("update.running"));
        const { spawn } = await import("node:child_process");
        const _cv = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8")).version ?? "";
        const _cmd = _cv.includes("beta") ? "agend update --beta" : "agend update";
        const child = spawn("sh", ["-c", `sleep 2 && ${_cmd}`], { detached: true, stdio: "ignore" });
        child.unref();
      } else if (data.command === "doctor") {
        const allowed = this.fleetConfig?.channel?.access?.allowed_users ?? [];
        if (allowed.length > 0 && !allowed.some(u => String(u) === String(data.userId))) {
          await data.respond(t("not_authorized"));
          return;
        }
        try {
          const { execSync } = await import("node:child_process");
          const backend = this.fleetConfig?.defaults?.backend || "claude-code";
          const result = execSync(`agend backend doctor ${backend}`, { timeout: 30_000, encoding: "utf-8" });
          const clean = result.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
          await data.respond(clean || "No output");
        } catch (err: any) {
          const output = (err.stdout ?? err.message ?? "Doctor failed").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
          await data.respond(output);
        }
      } else if (data.command === "status") {
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
      }
    }, this.logger, "adapter.slash_command"));

    await this.topicCommands.registerBotCommands().catch(e =>
      this.logger.warn({ err: e }, "registerBotCommands failed (non-fatal)"));

    this.adapter.on("started", safeHandler((username: string, userId?: string) => {
      this.logger.info(`Bot @${username} polling started. Ensure no other service is polling this bot token.`);
      const w = this.worlds.values().next().value as AdapterWorld | undefined;
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

    adapter.on("callback_query", safeHandler(async (data: AdapterCallbackData) => {
      if (await this.handleClassicBackendSelection(data)) return;
      if (data.callbackData.startsWith("hang:")) {
        const parts = data.callbackData.split(":");
        const action = parts[1];
        const instanceName = parts[2];
        if (action === "restart") {
          await this.stopInstance(instanceName);
          const config = this.fleetConfig?.instances[instanceName];
          if (config) {
            const topicMode = this.fleetConfig?.channel?.mode === "topic";
            await this.startInstance(instanceName, config, topicMode);
          }
          adapter.editMessage(data.chatId, data.messageId, `🔄 ${instanceName} restarted.`, data.threadId).catch(() => {});
        } else {
          adapter.editMessage(data.chatId, data.messageId, `⏳ Continuing to wait for ${instanceName}.`, data.threadId).catch(() => {});
        }
        return;
      }
      if (data.callbackData.startsWith("cancel:")) {
        const instanceName = data.callbackData.slice("cancel:".length);
        // Idempotent: only the first click (while the button is live) acts.
        if (this.hasCancelButton(instanceName)) this.cancelInstance(instanceName);
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
        const allowed = this.fleetConfig?.channel?.access?.allowed_users ?? [];
        if (allowed.length > 0 && !allowed.some(u => String(u) === String(data.userId))) {
          await data.respond(t("not_authorized"));
          return;
        }
        await data.respond(t("update.running"));
        const { spawn } = await import("node:child_process");
        const _cv = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8")).version ?? "";
        const _cmd = _cv.includes("beta") ? "agend update --beta" : "agend update";
        const child = spawn("sh", ["-c", `sleep 2 && ${_cmd}`], { detached: true, stdio: "ignore" });
        child.unref();
      } else if (data.command === "doctor") {
        const allowed = this.fleetConfig?.channel?.access?.allowed_users ?? [];
        if (allowed.length > 0 && !allowed.some(u => String(u) === String(data.userId))) {
          await data.respond(t("not_authorized"));
          return;
        }
        try {
          const { execSync } = await import("node:child_process");
          const backend = this.fleetConfig?.defaults?.backend || "claude-code";
          const result = execSync(`agend backend doctor ${backend}`, { timeout: 30_000, encoding: "utf-8" });
          const clean = result.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
          await data.respond(clean || "No output");
        } catch (err: any) {
          const output = (err.stdout ?? err.message ?? "Doctor failed").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
          await data.respond(output);
        }
      } else if (data.command === "status") {
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
  async connectIpcToInstance(name: string): Promise<void> {
    // Close existing client to prevent socket leak on reconnect
    const existing = this.instanceIpcClients.get(name);
    if (existing) {
      this.ipcStoppingInstances.add(name);
      try { existing.close(); } catch (err) { this.logger.debug({ err, name }, "IPC client close failed (likely already closed)"); }
      this.instanceIpcClients.delete(name);
      this.ipcStoppingInstances.delete(name);
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
        } else if (msg.type === "fleet_tool_status") {
          this.handleToolStatusFromInstance(name, msg);
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
        } else if (msg.type === "instance_state" || msg.type === "instance_state_response") {
          this.cacheInstanceExecutionState(name, msg);
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
        this.instanceIpcClients.delete(name);
        if (this.ipcStoppingInstances.has(name)) return;
        this.ipcReconnect(name).catch(() => {});
      });
    } catch (err) {
      this.logger.warn({ name, err }, "Failed to connect to instance IPC");
    }
  }

  /** Attempt IPC reconnection with exponential backoff */
  private async ipcReconnect(name: string): Promise<void> {
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
            try {
              const { execSync } = await import("node:child_process");
              execSync(`tmux list-panes -t "${windowId}"`, { stdio: "ignore" });
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
          return;
        } catch { /* retry */ }
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

        // Handle /cancel command
        if (text === "/cancel" || text.startsWith("/cancel@")) {
          const cancelName = this.classicChannels.getInstanceByChannel(chatId, msg.adapterId);
          if (!cancelName) {
            await msgAdapter?.sendText(chatId, t("classic.no_agent_start"));
            return;
          }
          const ok = this.cancelInstance(cancelName);
          await msgAdapter?.sendText(chatId, ok ? `🛑 已送出取消給 ${cancelName}。` : `❌ ${cancelName} 未在執行。`);
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
          if (!cmd) { await msgAdapter?.sendText(chatId, SAVE_UNSUPPORTED_MSG); return; }
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
          // Strip @bot from text and forward as /chat
          const cleanText = botUser ? text.replace(new RegExp(`@${botUser}`, "gi"), "").trim() : text;
          if (cleanText.startsWith("/raw") && !this.classicChannels.isAdmin(msg.userId)) {
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
              adapter_id: msg.adapterId,
              source: msg.source,
              ...(msg.replyToText ? { reply_to_text: msg.replyToText } : {}),
              ...extraMeta,
            },
          });
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
          adapter_id: msg.adapterId,
          source: msg.source,
          ...(msg.replyToText ? { reply_to_text: msg.replyToText } : {}),
          ...extraMeta,
        },
      });
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
      warning = `⚠️ ${instanceName} at ${Math.round(rl.five_hour_pct)}% of 5h rate limit. Responses may be slower.`;
    } else if (rl.seven_day_pct >= 95) {
      warning = `⚠️ ${instanceName} at ${Math.round(rl.seven_day_pct)}% weekly usage. Responses may be slower or fail.`;
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
    if (this.worlds.size === 0) return;
    this.touchActivity(instanceName);
    this.setTopicIcon(instanceName, "green");
    const tool = msg.tool as string;
    const args = (msg.args ?? {}) as Record<string, unknown>;
    const requestId = msg.requestId as number | undefined;
    const fleetRequestId = msg.fleetRequestId as string | undefined;
    const senderSessionName = msg.senderSessionName as string | undefined;

    const respond = (result: unknown, error?: string) => {
      const ipc = this.instanceIpcClients.get(instanceName);
      if (fleetRequestId) {
        ipc?.send({ type: "fleet_outbound_response", fleetRequestId, result, error });
      } else {
        ipc?.send({ type: "fleet_outbound_response", requestId, result, error });
      }
    };

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

    // Select adapter: use instance binding, or resolve from chatId in args
    const outAdapter = this.getAdapterForInstance(senderInstanceName ?? instanceName) ?? this.adapter;
    if (!outAdapter) { respond(null, "No adapter available"); return; }

    // For classic instances: force chat_id to channelId and clear thread_id
    // (daemon may have set chat_id to guild_id which is wrong for DC; TG may have set thread_id which causes 'thread not found')
    const classicChannelId = this.classicChannels?.getChannelIdByInstance(senderInstanceName ?? instanceName);
    if (classicChannelId) {
      args.chat_id = classicChannelId;
      delete args.thread_id;
      threadId = undefined;
    }

    // Route standard channel tools (reply, react, edit_message, download_attachment)
    if (routeToolCall(outAdapter, tool, args, threadId, respond)) {
      if (tool === "reply") {
        // Agent answered — retire its pending cancel button and mark ✅ done.
        this.clearCancelButton(instanceName);
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

  /** Handle tool status update from a daemon instance */
  private handleToolStatusFromInstance(instanceName: string, msg: Record<string, unknown>): void {
    const statusAdapter = this.getAdapterForInstance(instanceName) ?? this.adapter;
    if (!statusAdapter) return;

    const text = msg.text as string;
    const editMessageId = msg.editMessageId as string | null;
    const senderSessionName = msg.senderSessionName as string | undefined;
    const senderInstanceName = senderSessionName && this.fleetConfig?.instances[senderSessionName]
      ? senderSessionName
      : null;
    const routingConfig = senderInstanceName
      ? this.fleetConfig?.instances[senderInstanceName]
      : (senderSessionName ? undefined : this.fleetConfig?.instances[instanceName]);
    const threadId = routingConfig?.topic_id ? String(routingConfig.topic_id) : undefined;
    const chatId = statusAdapter.getChatId();
    if (!chatId) return;

    if (editMessageId) {
      statusAdapter.editMessage(chatId, editMessageId, text, threadId).catch(e => this.logger.debug({ err: e }, "Failed to edit tool status message"));
    } else {
      statusAdapter.sendText(chatId, text, { threadId }).then((sent) => {
        const ipc = this.instanceIpcClients.get(instanceName);
        ipc?.send({ type: "fleet_tool_status_ack", messageId: sent.messageId });
      }).catch(e => this.logger.warn({ err: e }, "Failed to send tool status message"));
    }
  }

  // ===================== Scheduler =====================

  private async handleScheduleTrigger(schedule: Schedule): Promise<void> {
    const { target, reply_chat_id, reply_thread_id, message, label, id, source } = schedule;

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

    const schedulerDefaults = this.fleetConfig?.defaults.scheduler;

    const retryCount = schedulerDefaults?.retry_count ?? 3;
    const retryInterval = schedulerDefaults?.retry_interval_ms ?? 30_000;

    const deliver = async (): Promise<boolean> => {
      try {
        await this.deliverToInstance(target, {
          type: "fleet_schedule_trigger",
          payload: { schedule_id: id, message: `[Scheduled] ${message}`, label },
          meta: { chat_id: reply_chat_id, thread_id: reply_thread_id, user: "scheduler" },
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
            cron: payload.cron as string,
            message: payload.message as string,
            source: instanceName,
            target: (payload.target as string) || instanceName,
            reply_chat_id: meta.chat_id,
            reply_thread_id: meta.thread_id || null,
            label: payload.label as string | undefined,
            timezone: payload.timezone as string | undefined,
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
    return this.fleetConfig?.instances[instanceName]?.display_name ?? instanceName;
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

    this.fleetConfig.instances[instanceName].display_name = displayName;
    this.saveFleetConfig();
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

    this.fleetConfig.instances[instanceName].description = description;
    this.saveFleetConfig();
    this.logger.info({ instanceName, description: description.slice(0, 80) }, "Description set");
    ipc.send({ type: "fleet_description_response", fleetRequestId, result: { description } });
  }

  // ── Agent CLI HTTP handlers ─────────────────────────────────────────

  async handleScheduleCrudHttp(instance: string, op: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.scheduler) return { error: "Scheduler not available" };
    switch (op) {
      case "create":
        return this.scheduler.create({
          cron: args.cron as string, message: args.message as string,
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
    this.fleetConfig.instances[instance].display_name = name;
    this.saveFleetConfig();
    return { display_name: name };
  }

  async handleSetDescriptionHttp(instance: string, description: string): Promise<unknown> {
    if (!this.fleetConfig) return { error: "Fleet config not available" };
    if (!description) return { error: "Description cannot be empty" };
    this.fleetConfig.instances[instance].description = description;
    this.saveFleetConfig();
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
   * document. Unknown keys, explicit overrides and comments remain untouched.
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

    // Settings edits are expressed against the raw config. Persist them even
    // when the chosen override equals the inherited effective value, a case
    // the before/after runtime diff cannot observe.
    for (const patch of explicitPatches) {
      if (patch.remove) {
        this.rawFleetDocument.deleteIn(patch.path);
      } else {
        const before = this.rawFleetDocument.getIn(patch.path);
        this.patchFleetDocument(this.rawFleetDocument, patch.path, before, patch.value);
      }
    }

    const output = String(this.rawFleetDocument);
    const tempPath = `${this.configPath}.tmp-${process.pid}`;
    writeFileSync(tempPath, output, "utf-8");
    if (existsSync(this.configPath)) chmodSync(tempPath, statSync(this.configPath).mode);
    renameSync(tempPath, this.configPath);

    this.rawFleetConfig = loadRawFleetConfig(this.configPath);
    this.savedFleetConfigSnapshot = structuredClone(this.fleetConfig);
    this.logger.info({ path: this.configPath }, "Saved fleet config (lossless patch)");
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
      for (let i = before.length - 1; i >= after.length; i--) document.deleteIn([...path, i]);
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
      document.deleteIn(path);
    } else if (path.length === 0) {
      document.contents = document.createNode(after);
    } else {
      const currentNode = document.getIn(path, true);
      if (isScalar(currentNode) && (after === null || typeof after !== "object")) {
        currentNode.value = after;
      } else {
        document.setIn(path, after);
      }
    }
  }

  async removeInstance(name: string): Promise<void> {
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
      this.notifyInstanceTopic(name,
        `⚡ Rate limit ${fiveHourPct}% — next rotation will use ${fallbackModel} (was ${primaryModel})`);

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
      this.notifyInstanceTopic(name,
        `✅ Rate limit recovered (${fiveHourPct}%) — next rotation will use ${primaryModel}`);
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

  notifyInstanceTopic(instanceName: string, text: string, extraOpts?: import("./channel/types.js").SendOpts): void {
    const adapter = this.getAdapterForInstance(instanceName) ?? this.adapter;
    if (!adapter) return;
    const channelCfg = this.getChannelConfig(this.instanceWorldBinding.get(instanceName));
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
      await data.respond(SAVE_UNSUPPORTED_MSG);
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
  private hasCancelButton(instanceName: string): boolean {
    for (const e of this.cancelButtons.values()) {
      if (e.instanceName === instanceName) return true;
    }
    return false;
  }

  async sendCancelButton(instanceName: string, correlationId?: string): Promise<void> {
    // At most one button shown per instance: retire any existing ones first
    // (delete + bounded retry). Each is tracked separately, so a failed delete
    // here doesn't strand it — it keeps retrying on its own timer.
    this.retireInstanceButtons(instanceName);

    const adapter = this.getAdapterForInstance(instanceName) ?? this.adapter;
    if (!adapter) return;
    const adapterId = this.instanceWorldBinding.get(instanceName);
    const groupId = this.getChannelConfig(adapterId)?.group_id;
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
    if (!chatId) return;

    try {
      const sent = await adapter.notifyAlert(chatId, {
        type: "cancel",
        instanceName,
        message: "👀 處理中…",
        choices: [{ id: `cancel:${instanceName}`, label: t("cancel.button") }],
      }, threadId ? { threadId } : undefined);

      // A concurrent sendCancelButton for the same instance may have posted its
      // own button while we awaited notifyAlert. Retire any other buttons for
      // this instance (not the one we just posted) so only the newest shows.
      for (const other of this.cancelButtons.values()) {
        if (other.instanceName === instanceName) this.retireButton(other);
      }

      const entry: CancelButtonEntry = {
        instanceName,
        adapterId,
        chatId: sent.chatId,
        messageId: sent.messageId,
        threadId: sent.threadId ?? threadId,
        correlationId,
        retryCount: 0,
      };
      // Idle-check backstop: every 5min, if the instance is idle, retire the
      // button. Covers turns that end without hitting a clear trigger (reply /
      // cancel / correlation). Cleared in discardButton when the entry is removed.
      entry.idleCheckTimer = setInterval(() => {
        if (!this.cancelButtons.has(entry.messageId)) { clearInterval(entry.idleCheckTimer); return; }
        if (this.getInstanceIdle(instanceName)) {
          this.logger.info({ instanceName, messageId: entry.messageId }, "Cancel button idle backstop retiring");
          this.retireButton(entry);
        }
      }, CANCEL_BTN_IDLE_CHECK_INTERVAL_MS);
      this.cancelButtons.set(sent.messageId, entry);
      this.logger.info({ instanceName, messageId: sent.messageId }, "Cancel button sent");
    } catch (e) {
      this.logger.warn({ err: (e as Error).message, instanceName }, "Failed to send cancel button");
    }
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
        this.logger.info({ instanceName: entry.instanceName, messageId: entry.messageId }, "Cancel button removed");
      })
      .catch((err: Error) => this.scheduleButtonRetry(entry, err));
  }

  /** Clear an entry's timers (retry + idle-check) and drop it from the map. */
  private discardButton(entry: CancelButtonEntry): void {
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    if (entry.idleCheckTimer) clearInterval(entry.idleCheckTimer);
    this.cancelButtons.delete(entry.messageId);
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

  /** Delete one button's message via its own adapter. Resolves on success,
   * rejects on failure so the caller can retry. */
  private deleteButtonMessage(e: CancelButtonEntry): Promise<void> {
    const adapter = (e.adapterId ? this.worlds.get(e.adapterId)?.adapter : undefined) ?? this.adapter;
    if (!adapter) return Promise.reject(new Error("no adapter for cancel button"));
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
    daemon.sendEscape().catch(e => this.logger.warn({ err: e, instanceName }, "sendEscape failed"));
    this.lastInboundMsg.delete(instanceName);
    this.clearCancelButton(instanceName);
    return true;
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
    if (!adapter) return;
    const channelCfg = this.getChannelConfig(this.instanceWorldBinding.get(instanceName));
    const groupId = channelCfg?.group_id;
    if (!groupId) return;
    const threadId = this.fleetConfig?.instances[instanceName]?.topic_id;
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

    await adapter.notifyAlert(String(groupId), {
      type: "hang",
      instanceName,
      message: `⚠️ ${instanceName} may be stuck — pane unchanged for ${unchangedMinutes}min, ready prompt not recognized`,
      choices: [
        { id: `hang:restart:${instanceName}`, label: "🔄 Force restart" },
        { id: `hang:wait:${instanceName}`, label: "⏳ Keep waiting" },
      ],
    }, {
      threadId: threadId != null ? String(threadId) : undefined,
    }).catch(e => this.logger.warn({ err: e }, "Failed to send hang notification"));
  }

  // ── Topic icon + auto-archive ─────────────────────────────────────────────

  private static INSTRUCTIONS_FILENAME: Record<string, string> = {
    "claude-code": "CLAUDE.md",
    "codex": "AGENTS.md",
    "gemini-cli": "GEMINI.md",
    "opencode": "AGENTS.md",
    "kiro-cli": ".kiro/steering/project.md",
    "mock": "CLAUDE.md",
  };

  private static GENERAL_INSTRUCTIONS = `# Fleet Coordinator

You are the fleet coordinator — the central entry point for this AgEnD fleet.
You route tasks, manage instances, enforce policies, and synthesize results.
Do NOT modify project files directly — delegate file changes to the project's instance.
You CAN write code snippets, explain code, and answer technical questions directly.

-----

## Task Classification

Classify every incoming request before acting.

### Handle Directly (ALL conditions must be true)

- No file system access needed
- No external execution needed
- Answerable from static knowledge
- ≤ 2 reasoning steps

Examples: Q&A, translation, fleet status queries, explaining a concept, writing code snippets.

### Delegate to 1 Instance

- Task scoped to a single project or repo
- Requires file access, code changes, or execution

### Coordinate Multiple Instances

- Task spans multiple repos or domains
- Requires outputs from one instance to feed into another
- Benefits from parallel execution (max 3 instances per task)

-----

## Instance Discovery (in this order)
1. list_teams()        → reuse existing teams first
2. list_instances()    → find by working_directory, description, or tags
3. describe_instance() → confirm capabilities before delegating
4. create_instance()   → only if no suitable instance exists

Rules: prefer reuse over creation. Do NOT create duplicates of running instances.

-----

## Delegation Protocol

Every delegation via send_to_instance() MUST include:

1. Task scope — what exactly to do, bounded clearly
2. Expected output — what to return and in what form
3. Policy reminder — "Follow Development Workflow policy" (for code tasks)

### Loop Prevention

- Never re-delegate a task back to the instance that sent it to you
- If a task has bounced 3 times, stop and solve locally or reduce scope

### Execution Strategy

Parallel — use only when tasks are independent with no shared state
Sequential — use when one task's output feeds into the next

-----

## Result Handling

When an instance reports back, classify the outcome:

- Success → Summarize key results for user. Omit internal coordination noise.
- Partial → State what succeeded, what remains, proposed next steps.
- Failure → Retry up to 2 times. If still failing: try alternative instance, reduce scope, or return partial result clearly marked.
- No response → Ping again after reasonable wait. If still silent: report to user with options.

### Output to User

Every final response to the user should contain:

- Result — the actual answer or deliverable
- Gaps — anything incomplete or unresolved (omit if none)

-----

## Shared Decisions

Use post_decision() / list_decisions() for any choice that affects more than 1 instance, changes an API contract, introduces a new dependency, or alters deployment process.

When instances disagree, collect both viewpoints, make a decision, and record it via post_decision.

-----

## After Restart

After a restart, run this sequence BEFORE processing any new messages:
1. list_instances()   → rebuild fleet awareness
2. list_teams()       → restore team structure
3. list_decisions()   → reload policies and conventions

Only then handle incoming requests.

-----

## Development Workflow Policy

All code changes across the fleet should follow this workflow.
The coordinator enforces compliance but does not perform these steps directly.
Remind instances of this policy when delegating code tasks.

### Workflow Stages
Design Proposed → Design Approved → Implementation → Submit for Review → Under Review → Approved → Merge

### Policy Rules

1. Design before code — developer sends design proposal to reviewer before implementation. Consensus required before proceeding.
2. Challenger pairing — every code task should have a developer + reviewer. Reviewer actively questions decisions and finds risks.
3. Verify by execution — backend/CLI changes must be tested by running them. Do not trust documentation alone.
4. Independent review — every merge requires code review from someone other than the author.
5. Root cause first — bug fixes require confirmed root cause before proposing a fix.
6. Merge conditions: tests pass, reviewer approved, branch and worktree cleaned up.

### Specialist Instance Rules

- Execute within defined scope only
- Return structured output: result, assumptions, uncertainties, verification status
- Do NOT create new instances without coordinator approval

-----

## Team Management

- Always check existing teams before creating new ones
- Default to ephemeral teams (created for a specific task, dissolved after completion)
- Clean up ephemeral teams and instances after task completion

-----

## Instance Configuration Tips

When users create specialized instances, suggest these configurations:

- **Reviewer instances**: Add \`pre_task_command: "/chat load reviewer-base"\` to reset context before each review, preventing influence from previous conversations.
- **Collab mode**: For multi-bot channels, use \`/collab\` to enable @mention-based triggering.
- **Cost control**: Set per-instance \`cost_guard\` for expensive backends.
`;

  /** Ensure the general instance has its project instructions file + knowledge */
  private ensureGeneralInstructions(workDir: string, backendName?: string): void {
    const backend = backendName ?? "claude-code";
    const filename = FleetManager.INSTRUCTIONS_FILENAME[backend] ?? "CLAUDE.md";
    const filePath = join(workDir, filename);
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) {
      writeFileSync(filePath, FleetManager.GENERAL_INSTRUCTIONS, "utf-8");
      this.logger.info({ filePath }, "Created general instance instructions file");
    }
    // Sync bundled knowledge files to general's steering directory
    this.syncGeneralKnowledge(workDir, backend);
  }

  /** Copy general-knowledge steering + skills to the general instance's workspace */
  private syncGeneralKnowledge(workDir: string, backend: string): void {
    const knowledgeDir = join(dirname(fileURLToPath(import.meta.url)), "general-knowledge");
    if (!existsSync(knowledgeDir)) return;

    // Sync steering files → .kiro/steering/ (or workDir root for non-kiro)
    const steeringDir = backend === "kiro-cli"
      ? join(workDir, ".kiro", "steering")
      : workDir;
    mkdirSync(steeringDir, { recursive: true });
    const srcSteering = join(knowledgeDir, "steering");
    if (existsSync(srcSteering)) {
      for (const file of readdirSync(srcSteering)) {
        if (!file.endsWith(".md")) continue;
        const src = join(srcSteering, file);
        const dest = join(steeringDir, file);
        const newContent = readFileSync(src, "utf-8");
        try { if (existsSync(dest) && readFileSync(dest, "utf-8") === newContent) continue; } catch {}
        writeFileSync(dest, newContent);
      }
    }

    // Sync skills → .kiro/skills/ (kiro-cli only)
    if (backend === "kiro-cli") {
      const srcSkills = join(knowledgeDir, "skills");
      if (existsSync(srcSkills)) {
        const destSkills = join(workDir, ".kiro", "skills");
        mkdirSync(destSkills, { recursive: true });
        for (const skillDir of readdirSync(srcSkills)) {
          const skillSrc = join(srcSkills, skillDir);
          if (!existsSync(join(skillSrc, "SKILL.md"))) continue;
          const skillDest = join(destSkills, skillDir);
          mkdirSync(skillDest, { recursive: true });
          const src = join(skillSrc, "SKILL.md");
          const dest = join(skillDest, "SKILL.md");
          const newContent = readFileSync(src, "utf-8");
          try { if (existsSync(dest) && readFileSync(dest, "utf-8") === newContent) continue; } catch {}
          writeFileSync(dest, newContent);
        }
      }
    }

    this.logger.debug({ knowledgeDir, steeringDir }, "Synced general knowledge files");
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

      // Strip the @mention from text
      const cleanText = text.replace(new RegExp(`<@${adapterBotUserId}>`, "g"), "").trim();
      if (!cleanText && !msg.attachments?.length) return;

      const classicAdapter = this.worlds.get(msg.adapterId ?? "")?.adapter ?? this.adapter;
      const collabReactChatId = msg.threadId ?? msg.chatId;
      if (classicAdapter && collabReactChatId && msg.messageId) {
        classicAdapter.react(collabReactChatId, msg.messageId, "👀")
          .catch(e => this.logger.debug({ err: (e as Error).message }, "Auto-react failed"));
      }

      // Block /raw bypass
      if (cleanText.startsWith("/raw ")) return;

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
        try { renameSync(tmpPath, dest); } catch { copyFileSync(tmpPath, dest); unlinkSync(tmpPath); }
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

    try {
      await this.deliverToInstance(instanceName, {
        type: "fleet_inbound",
        content: fullText,
        targetSession: instanceName,
        meta,
      });
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

  /** Read recent chat log for agent context */
  private getRecentChatLog(instanceName: string, maxLines = 10): string | undefined {
    const logDir = ClassicChannelManager.chatLogDir(instanceName);
    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(logDir, `${today}.log`);
    try {
      if (!existsSync(logFile)) return undefined;
      const lines = readFileSync(logFile, "utf-8").trim().split("\n");
      return lines.slice(-maxLines).join("\n");
    } catch { return undefined; }
  }

  /** Return a user-facing blocker without mutating ClassicBot state. */
  private validateClassicStart(channelId: string, userId: string, guildId?: string, adapterId?: string): string | undefined {
    if (!this.classicChannels) return "Classic channel manager not initialized.";
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
    const config: InstanceConfig = {
      ...DEFAULT_INSTANCE_CONFIG,
      ...this.fleetConfig?.defaults,
      working_directory: workDir,
      lightweight: true,
      ...(backend ? { backend } : {}),
      ...(model ? { model } : {}),
      ...(autoPauseAfter !== undefined ? { auto_pause_after: autoPauseAfter } : {}),
      ...(preTaskCommand ? { pre_task_command: preTaskCommand } : {}),
    };
    const topicMode = this.fleetConfig?.channel?.mode === "topic";
    await this.startInstance(instanceName, config, topicMode);
  }

  /** Handle /start slash command — register classic channel */
  async handleClassicStart(channelId: string, channelName: string, userId: string, guildId?: string, adapterId?: string, backend?: string): Promise<string> {
    const blocker = this.validateClassicStart(channelId, userId, guildId, adapterId);
    if (blocker) return blocker;
    const classicChannels = this.classicChannels;
    if (!classicChannels) return "Classic channel manager not initialized.";

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
    if (!this.classicChannels) return "Classic channel manager not initialized.";
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

  async stopAll(): Promise<void> {
    this.ipcStoppingInstances.add("__fleet_stopping__");
    sdNotify("STOPPING=1");
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
    // Cancel adapter retry timers
    for (const state of this.adapterState.values()) {
      if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = undefined; }
    }
    this.clearStatuslineWatchers();
    this.costGuard?.stop();
    this.dailySummary?.stop();
    if (this.updateCheckTimer) { clearTimeout(this.updateCheckTimer as any); clearInterval(this.updateCheckTimer as any); this.updateCheckTimer = null; }

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
      this.healthServer.close();
      this.healthServer = null;
    }

    this.eventLog?.close();

    const pidPath = join(this.dataDir, "fleet.pid");
    try { unlinkSync(pidPath); } catch (e) { this.logger.debug({ err: e }, "Failed to remove fleet PID file"); }
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
   * Fleet-level config (access, cost_guard, etc.) requires /restart to take effect.
   */
  private async reconcileInstances(): Promise<void> {
    if (!this.configPath) return;
    const oldConfig = this.fleetConfig;
    this.loadConfig(this.configPath);
    this.routing.rebuild(this.fleetConfig!);
    this.reregisterClassicChannels();
    this.scheduler?.reload();

    const newInstances = this.fleetConfig!.instances;
    const topicMode = this.fleetConfig?.channel?.mode === "topic";

    // Detect fleet-level config changes and warn
    const oldFleetLevel = JSON.stringify({ channel: oldConfig?.channel, defaults: oldConfig?.defaults });
    const newFleetLevel = JSON.stringify({ channel: this.fleetConfig?.channel, defaults: this.fleetConfig?.defaults });
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

    // Start new + restart modified instances
    for (const [name, config] of Object.entries(newInstances)) {
      if (!this.daemons.has(name)) {
        // New instance — startInstance already calls connectIpcToInstance
        this.logger.info({ name }, "New instance in config — starting");
        await this.startInstance(name, config, topicMode).catch(err =>
          this.logger.error({ err, name }, "Failed to start new instance"));
      } else if (oldConfig?.instances[name]) {
        // Restart if any config field changed
        if (JSON.stringify(oldConfig.instances[name]) !== JSON.stringify(config)) {
          this.logger.info({ name }, "Instance config changed — restarting");
          await this.stopInstance(name).catch(() => {});
          await this.startInstance(name, config, topicMode).catch(err =>
            this.logger.error({ err, name }, "Failed to restart modified instance"));
        }
      }
    }

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

    // Phase 1: generals first
    const restartEntries = Object.entries(fleet.instances);
    const restartGenerals = restartEntries.filter(([_, cfg]) => cfg.general_topic);
    const restartOthers = restartEntries.filter(([_, cfg]) => !cfg.general_topic);
    for (const [name, cfg] of restartGenerals) {
      await this.startInstance(name, cfg, topicMode).catch(err =>
        this.logger.error({ err, name }, "Failed to start general instance"));
    }
    if (restartOthers.length > 0) {
      await this.startInstancesWithConcurrency(restartOthers, topicMode);
    }

    if (topicMode) {
      this.routing.rebuild(this.fleetConfig!);
      this.reregisterClassicChannels();
      // startInstance already calls connectIpcToInstance, no need for connectToInstances here

      // Restart classic channel instances (killed during orphan cleanup)
      if (this.classicChannels) {
        const fleetBackend = this.fleetConfig?.defaults?.backend;
        const channels = this.classicChannels.getAll();
        const concurrency = 3;
        let idx = 0;
        while (idx < channels.length) {
          const batch = channels.slice(idx, idx + concurrency);
          await Promise.allSettled(batch.map(ch =>
            this.startClassicInstance(
              ch.instanceName,
              this.classicChannels!.getBackendByInstance(ch.instanceName, fleetBackend),
              this.classicChannels!.getPreTaskCommand(ch.channelId, ch.adapterId),
              this.classicChannels!.getModel(ch.channelId, ch.adapterId, this.fleetConfig?.defaults?.model),
              this.classicChannels!.getAutoPauseAfter(ch.channelId, ch.adapterId, this.fleetConfig?.defaults?.auto_pause_after),
            ).catch(err =>
              this.logger.warn({ err, instanceName: ch.instanceName }, "Failed to start classic instance"))
          ));
          idx += concurrency;
        }
      }

      for (const name of Object.keys(fleet.instances)) {
        this.startStatuslineWatcher(name);
      }
    }

    this.logger.info("Graceful restart complete");
    if (groupId && this.adapter) {
      const total = Object.keys(fleet.instances).length;
      const started = this.daemons.size;
      const allNotRunning2 = Object.keys(fleet.instances).filter(n => !this.daemons.has(n));
      const pausedNames2 = allNotRunning2.filter(n => this.lifecycle.isPaused(n));
      const failedNames = allNotRunning2.filter(n => !this.lifecycle.isPaused(n));
      const { createRequire } = await import("node:module");
      const _require2 = createRequire(import.meta.url);
      const agendVersion2 = _require2("../package.json").version ?? "unknown";
      let restartText: string;
      if (failedNames.length === 0 && pausedNames2.length === 0) {
        restartText = t("fleet.ready", started, total, agendVersion2);
      } else if (failedNames.length === 0) {
        restartText = t("fleet.ready", started, total, agendVersion2) + `\n⏸ Paused: ${pausedNames2.join(", ")}`;
      } else {
        restartText = t("fleet.ready_with_failed", started, total, agendVersion2, failedNames.join(", "))
          + (pausedNames2.length > 0 ? `\n⏸ Paused: ${pausedNames2.join(", ")}` : "");
      }
      await this.adapter.sendText(String(groupId), restartText, notifyOpts)
        .catch(e => this.logger.warn({ err: e }, "Failed to post restart completion notification"));

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
      const { execSync } = await import("node:child_process");
      const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
      const currentVersion = JSON.parse(readFileSync(pkgPath, "utf-8")).version ?? "0.0.0";
      const latest = execSync("npm view @songsid/agend version", { stdio: "pipe", timeout: 15_000 }).toString().trim();
      let target = latest;
      if (currentVersion.includes("-beta")) {
        // Beta users track the @beta channel (never fall back to @latest, which is
        // older), but should also hear when a newer STABLE ships — pick whichever
        // of beta/latest is the newest.
        let beta = "";
        try {
          beta = execSync("npm view @songsid/agend@beta version", { stdio: "pipe", timeout: 15_000 }).toString().trim();
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
          this.notifyInstanceTopic(generalId, t("update.available", `v${target}`) + ` (current: v${currentVersion})`);
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

    // Generate web token before server starts so auth is enforced from the first request.
    this.webToken = randomBytes(24).toString("hex");
    const tokenPath = join(this.dataDir, "web.token");
    writeFileSync(tokenPath, this.webToken, { mode: 0o600 });
    // Defensive: if file existed previously with looser perms, tighten it.
    try {
      chmodSync(tokenPath, 0o600);
    } catch {
      // best-effort
    }

    // Separate read-only token for the /view page: grants terminal-view + profile
    // read, but never write (POSTs still require the full web token).
    this.viewToken = randomBytes(24).toString("hex");
    const viewTokenPath = join(this.dataDir, "view.token");
    writeFileSync(viewTokenPath, this.viewToken, { mode: 0o600 });
    try { chmodSync(viewTokenPath, 0o600); } catch { /* best-effort */ }

    this.healthServer = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");

      // Public health probe — no auth required.
      if (req.method === "GET" && req.url === "/health") {
        // fallthrough to existing handler below
      } else if (req.method === "POST" && req.url === "/agent") {
        // /agent handles its own instance-level auth via X-Agend-Instance-Token
      } else if (isViewPath(new URL(req.url ?? "/", `http://localhost:${port}`).pathname)) {
        // /view routes accept the read-only view.token (or web.token) and do
        // their own per-method auth in view-api.ts — skip the web-token gate.
      } else {
        // All other endpoints require a valid token (query ?token= or X-Agend-Token header).
        // /ui/* will also re-check in web-api.ts, which is harmless.
        const parsedUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
        const headerToken = req.headers["x-agend-token"];
        const providedToken = parsedUrl.searchParams.get("token")
          ?? (typeof headerToken === "string" ? headerToken : null);
        if (!this.webToken || providedToken !== this.webToken) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
      }

      if (req.method === "GET" && req.url === "/health") {
        const instanceCount = this.fleetConfig?.instances
          ? Object.keys(this.fleetConfig.instances).length
          : 0;
        res.writeHead(200);
        res.end(JSON.stringify({
          status: "ok",
          instances: instanceCount,
          uptime: Math.floor((Date.now() - this.startedAt) / 1000),
        }));
        return;
      }

      if (req.method === "GET" && req.url === "/status") {
        const instances = Object.keys(this.fleetConfig?.instances ?? {}).map(name => {
          const statusFile = join(this.getInstanceDir(name), "statusline.json");
          let context_pct = 0;
          let cost = 0;
          try {
            const data = JSON.parse(readFileSync(statusFile, "utf-8"));
            context_pct = data.context_window?.used_percentage ?? 0;
            cost = data.cost?.total_cost_usd ?? 0;
          } catch (err) {
            this.logger.debug({ err, name }, "statusline.json read failed (/status)");
          }
          return {
            name,
            status: this.getInstanceStatus(name),
            context_pct,
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
          const backend = inst.classic
            ? this.classicChannels?.getBackendByInstance(inst.name, this.fleetConfig?.defaults.backend) ?? "claude-code"
            : config?.backend ?? "claude-code";
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
            await this.startInstance(name, config, topicMode ?? false);
            this.emitSseEvent("status", this.getUiStatus());
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: `Start failed: ${(err as Error).message}` }));
          }
        })();
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
        })();
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
        })();
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
      if (handleSettingsRequest(req, res, url, this as unknown as import("./settings-api.js").SettingsApiContext)) return;
      if (handleWebRequest(req, res, url, this as unknown as import("./web-api.js").WebApiContext)) return;

      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found" }));
    });

    this.healthServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        if (this.healthPortRetried) {
          this.logger.debug({ port }, "Health port still in use after takeover — skipping health endpoint");
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
          this.healthServer.listen(port, "127.0.0.1", () => {
            this.logger.info({ port }, "Health endpoint listening (after takeover)");
          });
        }, 1500);
        return;
      }
      this.logger.error({ err, port }, "Health server error");
    });

    this.healthServer.listen(port, "127.0.0.1", () => {
      this.logger.info({ port }, "Health endpoint listening");
    });

    this.logger.info({ url: `http://localhost:${port}/ui?token=${this.webToken}` }, "Web UI available");
    this.logger.info({ url: `http://localhost:${port}/view?token=${this.viewToken}` }, "Web View available");
  }

  getUiStatus(): unknown {
    const instances = Object.keys(this.fleetConfig?.instances ?? {}).map(name => {
      const statusFile = join(this.getInstanceDir(name), "statusline.json");
      let context_pct = 0;
      let cost = 0;
      let model = "";
      try {
        const data = JSON.parse(readFileSync(statusFile, "utf-8"));
        context_pct = data.context_window?.used_percentage ?? 0;
        cost = data.cost?.total_cost_usd ?? 0;
        model = data.model?.display_name ?? "";
      } catch (err) {
        this.logger.debug({ err, name }, "statusline.json read failed (getUiStatus)");
      }
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
