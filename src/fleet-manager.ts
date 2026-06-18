import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync, rmSync, readdirSync, renameSync, copyFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgendHome, ensureWorkspaceGit } from "./paths.js";
import { sdNotify } from "./sd-notify.js";
import yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import type { FleetConfig, InstanceConfig, ChannelConfig, CostGuardConfig, DailySummaryConfig, WebhookConfig } from "./types.js";
import { isProbeableRouteTarget, type RouteTarget } from "./fleet-context.js";
import { loadFleetConfig, DEFAULT_COST_GUARD, DEFAULT_DAILY_SUMMARY, DEFAULT_INSTANCE_CONFIG } from "./config.js";
import { EventLog } from "./event-log.js";
import { AdapterWorld } from "./adapter-world.js";
import { CostGuard, formatCents } from "./cost-guard.js";
import { TmuxManager } from "./tmux-manager.js";
import { AccessManager } from "./channel/access-manager.js";
import { IpcClient } from "./channel/ipc-bridge.js";
import type { ChannelAdapter, InboundMessage } from "./channel/types.js";
import { createAdapter } from "./channel/factory.js";
import { createLogger, type Logger } from "./logger.js";
import { processAttachments } from "./channel/attachment-handler.js";
import { routeToolCall } from "./channel/tool-router.js";
import { Scheduler } from "./scheduler/index.js";
import type { Schedule, SchedulerConfig } from "./scheduler/index.js";
import { DEFAULT_SCHEDULER_CONFIG } from "./scheduler/index.js";
import type { FleetContext } from "./fleet-context.js";
import { TopicCommands, sanitizeInstanceName } from "./topic-commands.js";
import type { HangDetector } from "./hang-detector.js";
import { DailySummary } from "./daily-summary.js";
import { WebhookEmitter } from "./webhook-emitter.js";
import { TmuxControlClient } from "./tmux-control.js";
import { safeHandler } from "./safe-async.js";
import { RoutingEngine } from "./routing-engine.js";
import { InstanceLifecycle, type LifecycleContext } from "./instance-lifecycle.js";
import { TopicArchiver, type ArchiverContext } from "./topic-archiver.js";
import { StatuslineWatcher, type StatuslineWatcherContext } from "./statusline-watcher.js";
import { outboundHandlers, type OutboundContext } from "./outbound-handlers.js";
import { handleWebRequest, broadcastSseEvent } from "./web-api.js";
import { handleAgentRequest, type AgentEndpointContext } from "./agent-endpoint.js";
import { ClassicChannelManager, classicInstanceName } from "./classic-channel-manager.js";

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

export class FleetManager implements FleetContext, LifecycleContext, ArchiverContext, StatuslineWatcherContext, OutboundContext, AgentEndpointContext {
  private children: Map<string, import("node:child_process").ChildProcess> = new Map();
  readonly lifecycle: InstanceLifecycle;
  /** @deprecated Use lifecycle.daemons — kept for backward compat */
  get daemons() { return this.lifecycle.daemons; }
  fleetConfig: FleetConfig | null = null;
  adapter: ChannelAdapter | null = null;
  readonly worlds = new Map<string, AdapterWorld>();
  readonly adapters: Map<string, ChannelAdapter> = new Map(); // derived view for backward compat
  /** Track which world each instance is bound to */
  private instanceWorldBinding = new Map<string, string>();
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
  private lastInboundUser = new Map<string, string>(); // instanceName → last username
  private topicArchiver: TopicArchiver;

  controlClient: TmuxControlClient | null = null;
  classicChannels: ClassicChannelManager | null = null;

  // Model failover state
  private failoverActive = new Map<string, string>(); // instance → current failover model

  // IPC reconnect: tracks instances being intentionally stopped (skip reconnect)
  readonly ipcStoppingInstances = new Set<string>();

  // Adapter restart: prevents re-entrant restart attempts
  private adapterRestarting = new Set<string>();
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
    this.fleetConfig = loadFleetConfig(configPath);
    return this.fleetConfig;
  }

  /** Build topic routing table: { topicId -> RouteTarget } */
  buildRoutingTable(): Map<string, RouteTarget> {
    if (this.fleetConfig) {
      this.routing.rebuild(this.fleetConfig);
      this.reregisterClassicChannels();
    }
    return this.routing.map;
  }

  /** Re-register classic channels after routing rebuild (rebuild clears the table) */
  private reregisterClassicChannels(): void {
    if (!this.classicChannels) return;
    const channels = this.classicChannels.getAll();
    for (const ch of channels) {
      this.routing.register(ch.channelId, { kind: "classic", name: ch.instanceName });
    }
    // Always update adapter openChannels (including empty — clears stale entries on /stop)
    for (const [, w] of this.worlds) {
      if (typeof (w.adapter as any)?.setOpenChannels === "function") {
        (w.adapter as any).setOpenChannels(channels.map(ch => ch.channelId));
      }
    }
    if (channels.length > 0) {
      this.logger.info({ count: channels.length }, "Registered classic channel routes");
    }
  }

  getInstanceDir(name: string): string {
    return join(this.dataDir, "instances", name);
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

  /** Bind an instance to a specific world. fromInbound=true skips general_topic to prevent overwrite. */
  bindInstanceAdapter(name: string, adapterId: string, fromInbound = false): void {
    if (fromInbound && this.fleetConfig?.instances[name]?.general_topic) return;
    this.instanceWorldBinding.set(name, adapterId);
  }

  getInstanceStatus(name: string): "running" | "stopped" | "crashed" {
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

  async startInstance(name: string, config: InstanceConfig, topicMode: boolean): Promise<void> {
    if (config.general_topic) {
      this.ensureGeneralInstructions(config.working_directory, config.backend);
    }
    await this.lifecycle.start(name, config, topicMode);
    // Auto-connect IPC — daemon.start() ensures socket is ready before resolving
    await this.connectIpcToInstance(name);
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
    const concurrency = Math.max(1, Math.min(20, raw?.concurrency ?? 10));
    const staggerMs = Math.max(0, Math.min(30_000, raw?.stagger_delay_ms ?? 500));

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
    if (!config) throw new Error(`Instance not found: ${name}`);
    await this.stopInstance(name);
    const topicMode = this.fleetConfig?.channel?.mode === "topic";
    await this.startInstance(name, config, topicMode ?? false);
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

    // Initialize classic channel manager and register existing channels in routing
    this.classicChannels = new ClassicChannelManager(this.dataDir, this.logger);
    for (const ch of this.classicChannels.getAll()) {
      this.routing.register(ch.channelId, { kind: "classic", name: ch.instanceName });
    }

    // Poll classicBot.yaml for external changes every 30s
    this.classicReloadTimer = setInterval(async () => {
      try {
        if (!this.classicChannels) return;
        const fleetBackend = this.fleetConfig?.defaults?.backend;
        const oldBackends = new Map<string, string>();
        for (const ch of this.classicChannels.getAll()) {
          oldBackends.set(ch.instanceName, this.classicChannels.getBackendByInstance(ch.instanceName, fleetBackend));
        }
        if (!this.classicChannels.checkReload()) return;
        this.reregisterClassicChannels();
        for (const ch of this.classicChannels.getAll()) {
          const newBackend = this.classicChannels.getBackendByInstance(ch.instanceName, fleetBackend);
          if (this.daemons.has(ch.instanceName) && oldBackends.get(ch.instanceName) !== newBackend) {
            this.logger.info({ instanceName: ch.instanceName, from: oldBackends.get(ch.instanceName), to: newBackend }, "Backend changed — restarting");
            await this.stopInstance(ch.instanceName).catch(() => {});
            // Small delay to let tmux window clean up
            await new Promise(r => setTimeout(r, 2000));
            await this.startClassicInstance(ch.instanceName, newBackend).catch(err =>
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
      this.notifyInstanceTopic(instance, `⚠️ ${instance} cost: ${formatCents(totalCents)} / ${formatCents(limitCents)} (${Math.round(totalCents / limitCents * 100)}%)`);
      this.webhookEmitter?.emit("cost_warning", instance, { cost_cents: totalCents, limit_cents: limitCents });
    }, this.logger, "costGuard.warn"));

    this.costGuard.on("limit", safeHandler(async (instance: string, totalCents: number, limitCents: number) => {
      this.notifyInstanceTopic(instance, `🛑 ${instance} daily limit ${formatCents(limitCents)} reached — pausing instance.`);
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

    // Auto-create general instance(s) — one per adapter that lacks a general
    const channelConfigs = fleet.channels ?? (fleet.channel ? [fleet.channel] : []);
    const generalInstances = Object.entries(fleet.instances).filter(([, inst]) => inst.general_topic === true);
    let generalsCreated = false;

    // Collect unbound generals (no channel_id set) for auto-assignment
    const unboundGenerals = generalInstances.filter(([, inst]) => !inst.channel_id);
    // Track which adapters still need a general
    const needsGeneral: Array<{ adapterId: string; ch: typeof channelConfigs[0] }> = [];

    for (const ch of channelConfigs) {
      const adapterId = ch.id ?? ch.type;
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
        const decisions = this.scheduler.db.listDecisions("", { includeArchived: false });
        if (decisions.length > 0) {
          const capped = decisions.slice(0, 20).map(d => ({ title: d.title, content: (d.content ?? "").slice(0, 200) }));
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
              this.adapter.sendText(chatId, `⚠️ General instance "${name}" failed to start:\n${errorMsg}`, { threadId: topicId }).catch(() => {});
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

      // Pre-bind general instances to their corresponding adapter
      for (const [name, config] of Object.entries(fleet.instances)) {
        if (!config.general_topic) continue;
        const channelConfigs = fleet.channels ?? (fleet.channel ? [fleet.channel] : []);
        for (const ch of channelConfigs) {
          const id = ch.id ?? ch.type;
          if (name.includes(id)) { this.bindInstanceAdapter(name, id); break; }
        }
      }

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
            this.startClassicInstance(ch.instanceName, this.classicChannels!.getBackendByInstance(ch.instanceName, fleetBackend)).catch(err =>
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
      const failedNames = Object.keys(fleet.instances).filter(n => !this.daemons.has(n));
      const generalName = this.findGeneralInstance();
      const generalThreadId = generalName ? fleet.instances[generalName]?.topic_id : undefined;
      if (this.adapter && fleet.channel?.group_id) {
        const text = failedNames.length === 0
          ? `Fleet ready. ${started}/${total} instances running.`
          : `Fleet ready. ${started}/${total} instances running. Failed: ${failedNames.join(", ")}`;
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

  /** Start the shared channel adapter(s) for topic mode */
  private async startSharedAdapter(fleet: FleetConfig): Promise<void> {
    const channelConfigs = fleet.channels ?? (fleet.channel ? [fleet.channel] : []);
    if (channelConfigs.length === 0) return;

    // Start primary adapter (first channel) — this.adapter for backward compat
    await this.startSingleAdapter(fleet, channelConfigs[0]);

    // Start additional adapters
    for (let i = 1; i < channelConfigs.length; i++) {
      await this.startAdditionalAdapter(channelConfigs[i]);
    }
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
      channelConfig.access,
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

    this.adapter.on("callback_query", safeHandler(async (data: { callbackData: string; chatId: string; threadId?: string; messageId: string }) => {
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
          this.adapter?.editMessage(data.chatId, data.messageId, `🔄 ${instanceName} restarted.`).catch(() => {});
        } else {
          this.adapter?.editMessage(data.chatId, data.messageId, `⏳ Continuing to wait for ${instanceName}.`).catch(() => {});
        }
        return;
      }
    }, this.logger, "adapter.callback_query"));

    this.adapter.on("topic_closed", safeHandler(async (data: { chatId: string; threadId: string }) => {
      // Skip unbind if we archived this topic ourselves
      if (this.topicArchiver.isArchived(data.threadId)) return;
      await this.topicCommands.handleTopicDeleted(data.threadId);
    }, this.logger, "adapter.topic_closed"));

    // Handle classic bot slash commands (/start, /stop, /chat, /compact, /save, /load)
    this.adapter.on("slash_command", safeHandler(async (data: { command: string; channelId: string; channelName: string; guildId?: string; userId: string; username?: string; text?: string; options?: Record<string, string | boolean>; respond: (text: string) => Promise<string | undefined> }) => {
      if (data.command === "start") {
        const reply = await this.handleClassicStart(data.channelId, data.channelName, data.userId, data.guildId);
        await data.respond(reply);
      } else if (data.command === "stop") {
        const reply = await this.handleClassicStop(data.channelId);
        await data.respond(reply);
      } else if (data.command === "chat") {
        const text = data.text ?? "";
        if (!text) { await data.respond("Usage: `/chat <message>`"); return; }
        const target = this.routing.resolve(data.channelId);
        if (!target || target.kind !== "classic") {
          await data.respond("No active agent in this channel. Use `/start` first.");
          return;
        }
        const replyMsgId = await data.respond("👀");
        const username = data.username ?? data.userId;
        ClassicChannelManager.logMessage(target.name, username, `/chat ${text}`, new Date());
        await this.forwardToClassicInstance(target.name, text, {
          chatId: data.channelId,
          threadId: data.channelId,
          messageId: replyMsgId ?? "",
          userId: data.userId,
          username,
          source: "discord",
          timestamp: new Date(),
        });
      } else if (data.command === "compact" || data.command === "save" || data.command === "load") {
        if (!this.classicChannels?.isAdmin(data.userId)) {
          await data.respond("⛔ This command requires admin access.");
          return;
        }
        const target = this.routing.resolve(data.channelId);
        if (!target || target.kind !== "classic") {
          await data.respond("No active agent in this channel. Use `/start` first.");
          return;
        }
        let rawCmd: string;
        if (data.command === "compact") {
          rawCmd = "/compact";
        } else if (data.command === "save") {
          const filename = data.options?.filename as string;
          if (!/^[\w.-]+$/.test(filename)) { await data.respond("⛔ Invalid filename — only letters, numbers, dots, hyphens, underscores allowed."); return; }
          rawCmd = data.options?.force ? `/chat save ${filename} -f` : `/chat save ${filename}`;
        } else {
          const filename = data.options?.filename as string;
          if (!/^[\w.-]+$/.test(filename)) { await data.respond("⛔ Invalid filename — only letters, numbers, dots, hyphens, underscores allowed."); return; }
          rawCmd = `/chat load ${filename}`;
        }
        this.pasteRawToClassicInstance(target.name, rawCmd);
        await data.respond(`✅ Sent \`${rawCmd}\` to ${target.name}`);
      } else if (data.command === "ctx") {
        const target = this.routing.resolve(data.channelId);
        if (!target) {
          await data.respond("No active agent in this channel.");
          return;
        }
        const instanceName = target.name;
        const backend = target.kind === "classic"
          ? (this.classicChannels?.getBackendByInstance(instanceName, this.fleetConfig?.defaults?.backend) ?? "claude-code")
          : (this.fleetConfig?.instances[instanceName]?.backend ?? this.fleetConfig?.defaults?.backend ?? "claude-code");
        let context: number | null = null;
        // Try statusline.json first
        try {
          const statusFile = join(this.getInstanceDir(instanceName), "statusline.json");
          if (existsSync(statusFile)) {
            const d = JSON.parse(readFileSync(statusFile, "utf-8"));
            context = d.context_window?.used_percentage ?? null;
          }
        } catch { /* ignore */ }
        // Fallback: capture tmux pane
        if (context == null) {
          try {
            const { execFileSync } = await import("node:child_process");
            const { getTmuxSocketName } = await import("./paths.js");
            const socketName = getTmuxSocketName();
            const tmuxArgs = socketName
              ? ["-L", socketName, "capture-pane", "-t", `${getTmuxSession()}:${instanceName}`, "-p"]
              : ["capture-pane", "-t", `${getTmuxSession()}:${instanceName}`, "-p"];
            const pane = execFileSync("tmux", tmuxArgs,
              { encoding: "utf-8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"] });
            const m = pane.match(/(\d+)%.*[!❯>]/m) || pane.match(/◔\s*(\d+)%/) || pane.match(/\[(\d+)%\]/);
            if (m) context = parseInt(m[1], 10);
          } catch { /* ignore */ }
        }
        if (context != null) {
          await data.respond(`📊 Context: ${context}% used\nBackend: ${backend}\nInstance: ${instanceName}`);
        } else {
          await data.respond(`Context info not available yet.\nBackend: ${backend}\nInstance: ${instanceName}`);
        }
      } else if (data.command === "collab") {
        const collabTarget = this.routing.resolve(data.channelId);
        if (collabTarget && collabTarget.kind !== "classic") {
          const allowed = this.fleetConfig?.channel?.access?.allowed_users ?? [];
          if (allowed.length > 0 && !allowed.some(u => String(u) === String(data.userId))) {
            await data.respond("⛔ Not authorized");
            return;
          }
          const isCollab = this.toggleFleetCollab(collabTarget.name);
          await data.respond(isCollab ? "🤝 Collaboration mode **ON** — bot/webhook messages reach the agent." : "💬 Collaboration mode **OFF**");
          return;
        }
        if (!this.classicChannels?.isAdmin(data.userId)) {
          await data.respond("⛔ This command requires admin access.");
          return;
        }
        if (!this.classicChannels.isClassicChannel(data.channelId)) {
          await data.respond("No active agent in this channel. Use `/start` first.");
          return;
        }
        const newState = this.classicChannels.toggleCollab(data.channelId);
        await data.respond(newState
          ? "🤝 Collaboration mode **ON** — @mention this bot to trigger the agent. Other bot messages are visible."
          : "💬 Collaboration mode **OFF** — use `/chat` to talk to the agent.");
      } else if (data.command === "update") {
        if (!this.classicChannels?.isAdmin(data.userId)) {
          await data.respond("⛔ This command requires admin access.");
          return;
        }
        await data.respond("📦 Updating AgEnD... Fleet will restart automatically.");
        const { spawn } = await import("node:child_process");
        const child = spawn("sh", ["-c", "sleep 2 && agend update"], { detached: true, stdio: "ignore" });
        child.unref();
      } else if (data.command === "doctor") {
        if (!this.classicChannels?.isAdmin(data.userId)) {
          await data.respond("⛔ This command requires admin access.");
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
      } else if (data.command === "restart") {
        const allowed = this.fleetConfig?.channel?.access?.allowed_users ?? [];
        if (allowed.length > 0 && !allowed.some(u => String(u) === String(data.userId))) {
          await data.respond("⛔ Not authorized");
          return;
        }
        await data.respond("🔄 Graceful restart — waiting for instances to idle...");
        process.kill(process.pid, "SIGUSR2");
      } else if (data.command === "compact") {
        const target = this.routing.resolve(data.channelId);
        if (!target) { await data.respond("No active agent in this channel."); return; }
        const result = await this.topicCommands.sendCompact(target.name);
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
      const adminMsg = `🆕 Bot added to new server:\n• Name: ${data.groupTitle}\n• ID: ${data.groupId}\n• Platform: ${data.source}\n\nTo allow: add \`${data.groupId}\` to classicBot.yaml \`allowed_guilds\``;
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
  private async startAdditionalAdapter(channelConfig: ChannelConfig): Promise<void> {
    const adapterId = channelConfig.id ?? channelConfig.type;
    const botToken = process.env[channelConfig.bot_token_env];
    if (!botToken) {
      this.logger.warn({ env: channelConfig.bot_token_env, adapterId }, "Bot token env not set, skipping adapter");
      return;
    }

    const accessDir = join(this.dataDir, "access");
    mkdirSync(accessDir, { recursive: true });
    const accessManager = new AccessManager(
      channelConfig.access,
      join(accessDir, `access-${adapterId}.json`),
    );
    const inboxDir = join(this.dataDir, "inbox");
    mkdirSync(inboxDir, { recursive: true });

    const adapter = await createAdapter(channelConfig, {
      id: adapterId,
      botToken,
      accessManager,
      inboxDir,
    });
    const world = new AdapterWorld(adapterId, adapter, accessManager, channelConfig);
    this.worlds.set(adapterId, world);
    (this.adapters as Map<string, ChannelAdapter>).set(adapterId, adapter);

    // Wire up event handlers (same as primary, routes through shared handleInboundMessage)
    adapter.on("message", safeHandler(async (msg: InboundMessage) => {
      await this.handleInboundMessage(msg);
    }, this.logger, `adapter[${adapterId}].message`));

    adapter.on("callback_query", safeHandler(async (data: { callbackData: string; chatId: string; threadId?: string; messageId: string }) => {
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
          adapter.editMessage(data.chatId, data.messageId, `🔄 ${instanceName} restarted.`).catch(() => {});
        } else {
          adapter.editMessage(data.chatId, data.messageId, `⏳ Continuing to wait for ${instanceName}.`).catch(() => {});
        }
      }
    }, this.logger, `adapter[${adapterId}].callback_query`));

    adapter.on("topic_closed", safeHandler(async (data: { chatId: string; threadId: string }) => {
      if (this.topicArchiver.isArchived(data.threadId)) return;
      await this.topicCommands.handleTopicDeleted(data.threadId);
    }, this.logger, `adapter[${adapterId}].topic_closed`));

    // Slash commands: classic bot + admin commands
    adapter.on("slash_command", safeHandler(async (data: { command: string; channelId: string; channelName: string; guildId?: string; userId: string; username?: string; text?: string; options?: Record<string, string | boolean>; respond: (text: string) => Promise<string | undefined> }) => {
      if (data.command === "start") {
        const reply = await this.handleClassicStart(data.channelId, data.channelName, data.userId, data.guildId);
        await data.respond(reply);
      } else if (data.command === "stop") {
        const reply = await this.handleClassicStop(data.channelId);
        await data.respond(reply);
      } else if (data.command === "chat") {
        const text = data.text ?? "";
        if (!text) { await data.respond("Usage: `/chat <message>`"); return; }
        const target = this.routing.resolve(data.channelId);
        if (!target || target.kind !== "classic") {
          await data.respond("No active agent in this channel. Use `/start` first.");
          return;
        }
        const replyMsgId = await data.respond("👀");
        const username = data.username ?? data.userId;
        ClassicChannelManager.logMessage(target.name, username, `/chat ${text}`, new Date());
        await this.forwardToClassicInstance(target.name, text, {
          chatId: data.channelId,
          threadId: data.channelId,
          messageId: replyMsgId ?? "",
          userId: data.userId,
          username,
          source: channelConfig.type,
          timestamp: new Date(),
        });
      } else if (data.command === "compact" || data.command === "save" || data.command === "load") {
        if (!this.classicChannels?.isAdmin(data.userId)) {
          await data.respond("⛔ This command requires admin access.");
          return;
        }
        const target = this.routing.resolve(data.channelId);
        if (!target || target.kind !== "classic") {
          await data.respond("No active agent in this channel. Use `/start` first.");
          return;
        }
        let rawCmd: string;
        if (data.command === "compact") {
          rawCmd = "/compact";
        } else if (data.command === "save") {
          const filename = data.options?.filename as string;
          if (!/^[\w.-]+$/.test(filename)) { await data.respond("⛔ Invalid filename — only letters, numbers, dots, hyphens, underscores allowed."); return; }
          rawCmd = data.options?.force ? `/chat save ${filename} -f` : `/chat save ${filename}`;
        } else {
          const filename = data.options?.filename as string;
          if (!/^[\w.-]+$/.test(filename)) { await data.respond("⛔ Invalid filename — only letters, numbers, dots, hyphens, underscores allowed."); return; }
          rawCmd = `/chat load ${filename}`;
        }
        this.pasteRawToClassicInstance(target.name, rawCmd);
        await data.respond(`✅ Sent \`${rawCmd}\` to ${target.name}`);
      } else if (data.command === "ctx") {
        const target = this.routing.resolve(data.channelId);
        if (!target) { await data.respond("No active agent in this channel."); return; }
        const instanceName = target.name;
        const ctxBackend = target.kind === "classic"
          ? (this.classicChannels?.getBackendByInstance(instanceName, this.fleetConfig?.defaults?.backend) ?? "claude-code")
          : (this.fleetConfig?.instances[instanceName]?.backend ?? this.fleetConfig?.defaults?.backend ?? "claude-code");
        let context: number | null = null;
        try {
          const statusFile = join(this.getInstanceDir(instanceName), "statusline.json");
          if (existsSync(statusFile)) {
            const d = JSON.parse(readFileSync(statusFile, "utf-8"));
            context = d.context_window?.used_percentage ?? null;
          }
        } catch { /* ignore */ }
        if (context != null) {
          await data.respond(`📊 Context: ${context}% used\nBackend: ${ctxBackend}\nInstance: ${instanceName}`);
        } else {
          await data.respond(`Context info not available yet.\nBackend: ${ctxBackend}\nInstance: ${instanceName}`);
        }
      } else if (data.command === "collab") {
        const collabTarget2 = this.routing.resolve(data.channelId);
        if (collabTarget2 && collabTarget2.kind !== "classic") {
          const allowed = this.fleetConfig?.channel?.access?.allowed_users ?? [];
          if (allowed.length > 0 && !allowed.some(u => String(u) === String(data.userId))) {
            await data.respond("⛔ Not authorized");
            return;
          }
          const isCollab = this.toggleFleetCollab(collabTarget2.name);
          await data.respond(isCollab ? "🤝 Collaboration mode **ON** — bot/webhook messages reach the agent." : "💬 Collaboration mode **OFF**");
          return;
        }
        if (!this.classicChannels?.isAdmin(data.userId)) {
          await data.respond("⛔ This command requires admin access.");
          return;
        }
        if (!this.classicChannels.isClassicChannel(data.channelId)) {
          await data.respond("No active agent in this channel. Use `/start` first.");
          return;
        }
        const newState = this.classicChannels.toggleCollab(data.channelId);
        await data.respond(newState
          ? "🤝 Collaboration mode **ON** — @mention this bot to trigger the agent. Other bot messages are visible."
          : "💬 Collaboration mode **OFF** — use `/chat` to talk to the agent.");
      } else if (data.command === "update") {
        if (!this.classicChannels?.isAdmin(data.userId)) {
          await data.respond("⛔ This command requires admin access.");
          return;
        }
        await data.respond("📦 Updating AgEnD... Fleet will restart automatically.");
        const { spawn } = await import("node:child_process");
        const child = spawn("sh", ["-c", "sleep 2 && agend update"], { detached: true, stdio: "ignore" });
        child.unref();
      } else if (data.command === "doctor") {
        if (!this.classicChannels?.isAdmin(data.userId)) {
          await data.respond("⛔ This command requires admin access.");
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
      } else if (data.command === "restart") {
        const allowed = this.fleetConfig?.channel?.access?.allowed_users ?? [];
        if (allowed.length > 0 && !allowed.some(u => String(u) === String(data.userId))) {
          await data.respond("⛔ Not authorized");
          return;
        }
        await data.respond("🔄 Graceful restart — waiting for instances to idle...");
        process.kill(process.pid, "SIGUSR2");
      } else if (data.command === "compact") {
        const target = this.routing.resolve(data.channelId);
        if (!target) { await data.respond("No active agent in this channel."); return; }
        const result = await this.topicCommands.sendCompact(target.name);
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
      const adminMsg = `🆕 Bot added to new server:\n• Name: ${data.groupTitle}\n• ID: ${data.groupId}\n• Platform: ${data.source}\n\nTo allow: add \`${data.groupId}\` to classicBot.yaml \`allowed_guilds\``;
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
        }
      }, this.logger, `ipc.message[${name}]`));
      // Ask daemon for any sessions that registered before we connected
      // (fixes race condition where mcp_ready was broadcast before fleet manager connected)
      ipc.send({ type: "query_sessions" });
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

    // Bot messages: only allow in collab channels or TG classic with @mention
    if (msg.isBotMessage) {
      if (!threadId) {
        // TG classic: allow if bot @mentions our bot (bot-to-bot communication)
        const world = this.worlds.get(msg.adapterId ?? "");
        const botUser = world?.botUsername;
        const mentionsUs = !!(botUser && msg.text?.toLowerCase().includes(`@${botUser.toLowerCase()}`));
        this.logger.debug({ botUser, mentionsUs, isBotMessage: true, threadId: null }, "Bot message filter (no threadId path)");
        if (!mentionsUs) return;
        // Fall through to TG classic handling below
      } else {
        const target = this.routing.resolve(threadId);
        if (!target) return;
        if (target.kind === "classic") {
          if (!this.classicChannels?.isCollab(threadId)) return;
        } else {
          if (!this.collabInstances.has(target.name)) return;
        }
        // Fall through to channel handling
      }
    }

    // Access control — classic channels are open to all, others require allowed user
    const am = (msg.adapterId ? this.worlds.get(msg.adapterId)?.accessManager : undefined) ?? this.accessManager;
    if (am && !am.isAllowed(msg.userId)) {
      const adapterGroupId = String(this.getChannelConfig(msg.adapterId)?.group_id ?? "");
      const isTelegramClassicCandidate = msg.source === "telegram" && msg.chatId !== adapterGroupId && !threadId;
      if (!isTelegramClassicCandidate) {
        const target = threadId ? this.routing.resolve(threadId) : undefined;
        this.logger.info({ userId: msg.userId, threadId, targetKind: target?.kind, targetName: (target as any)?.name }, "Access DENIED for non-allowed user");
        if (!target || target.kind !== "classic") return;
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

        // Handle /start command
        if (text === "/start" || text.startsWith("/start ")) {
          if (isPrivateChat) {
            if (!this.classicChannels.isUserAllowed(msg.userId)) {
              await msgAdapter?.sendText(chatId, "⛔ You are not in the allowed users list.");
              return;
            }
          } else {
            if (!this.classicChannels.isGroupAllowed(chatId)) {
              // Notify admin about new group wanting access
              const groupTitle = (msg as any).chatTitle || chatId;
              const adminMsg = `🆕 New group detected:\n• Name: ${groupTitle}\n• ID: ${chatId}\n• User: ${msg.username} (${msg.userId})\n• Platform: ${msg.source}\n\nTo allow: add \`${chatId}\` to classicBot.yaml \`allowed_guilds\``;
              const generalId = this.findGeneralInstance(msg.adapterId);
              if (generalId) {
                this.notifyInstanceTopic(generalId, adminMsg);
              }
              await msgAdapter?.sendText(chatId, "⏳ Access requested. Waiting for admin approval.");
              return;
            }
            if (!this.classicChannels.isAdmin(msg.userId)) {
              await msgAdapter?.sendText(chatId, "⛔ Only admins can start agents. Ask an admin to /start.");
              const generalId = this.findGeneralInstance(msg.adapterId);
              if (generalId) {
                this.notifyInstanceTopic(generalId, `🔑 User wants to /start but is not admin:\n• Name: ${msg.username}\n• ID: ${msg.userId}\n• Platform: ${msg.source}\n• Group: ${chatId}\n\nTo approve: add \`${msg.userId}\` to classicBot.yaml \`admin_users\``);
              }
              return;
            }
          }
          const channelName = msg.username || chatId;
          const reply = await this.handleClassicStart(chatId, channelName, msg.userId);
          if (msg.adapterId) this.bindInstanceAdapter(classicInstanceName(sanitizeInstanceName(channelName || chatId), chatId), msg.adapterId, true);
          await msgAdapter?.sendText(chatId, reply);
          return;
        }

        // Handle /stop command
        if (text === "/stop" || text.startsWith("/stop ")) {
          if (!this.classicChannels.isAdmin(msg.userId)) {
            await msgAdapter?.sendText(chatId, "⛔ Only admins can stop agents.");
            const generalId = this.findGeneralInstance(msg.adapterId);
            if (generalId) {
              this.notifyInstanceTopic(generalId, `🔑 User wants to /stop but is not admin:\n• Name: ${msg.username}\n• ID: ${msg.userId}\n• Platform: ${msg.source}\n• Group: ${chatId}\n\nTo approve: add \`${msg.userId}\` to classicBot.yaml \`admin_users\``);
            }
            return;
          }
          const reply = await this.handleClassicStop(chatId);
          await msgAdapter?.sendText(chatId, reply);
          return;
        }

        // Route to classic channel if registered
        const target = this.routing.resolve(chatId);
        if (target?.kind === "classic") {
          if (msg.adapterId) this.bindInstanceAdapter(target.name, msg.adapterId, true);
          // TG ClassicBot: only @mention triggers agent (both private and group).
          // /chat command is NOT supported for TG classic — use @bot instead.
          if (!isBotMentioned) {
            // No trigger: save attachments + react, log, but don't forward to agent
            const syntheticMsg = { ...msg, threadId: chatId, text: rawText.startsWith("/") ? "" : rawText };
            await this.handleClassicChannelMessage(target.name, syntheticMsg);
            return;
          }
          // Strip @bot from text and forward as /chat
          const cleanText = botUser ? text.replace(new RegExp(`@${botUser}`, "gi"), "").trim() : text;
          if (cleanText.startsWith("/raw") && !this.classicChannels.isAdmin(msg.userId)) {
            await msgAdapter?.sendText(chatId, "⛔ /raw requires admin access.");
            return;
          }
          const syntheticMsg = { ...msg, threadId: chatId, text: `/chat ${cleanText}` };
          await this.handleClassicChannelMessage(target.name, syntheticMsg);
          return;
        }

        // Handle @bot without active agent
        if (isBotMentioned) {
          await msgAdapter?.sendText(chatId, "No active agent. Use /start first.");
          return;
        }

        // Unregistered private chat: ignore (don't fall through to General)
        if (isPrivateChat) return;
        // Unregistered group: ignore
        return;
      }

      // General topic: check for /status command
      if (await this.topicCommands.handleGeneralCommand(msg)) return;

      // Forward to General Topic instance if configured
      const generalInstance = this.findGeneralInstance(msg.adapterId);
      if (generalInstance) {
        if (msg.adapterId) this.bindInstanceAdapter(generalInstance, msg.adapterId, true);
        const inboundAdapter = this.worlds.get(msg.adapterId ?? "")?.adapter ?? this.adapter!;

        // React immediately — before any other API calls
        if (msg.chatId && msg.messageId) {
          inboundAdapter.react(msg.threadId ?? msg.chatId, msg.messageId, "👀")
            .catch(e => this.logger.debug({ err: (e as Error).message }, "Auto-react failed"));
        }

        this.warnIfRateLimited(generalInstance, msg);
        const { text, extraMeta } = await processAttachments(msg, inboundAdapter, this.logger, generalInstance);
        const ipc = this.instanceIpcClients.get(generalInstance);
        if (ipc) {
          ipc.send({
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
        }
      }
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

    // Intercept admin commands (/status, /restart, /sysinfo) in general topics
    const instanceConfig = this.fleetConfig?.instances[instanceName];
    if (instanceConfig?.general_topic && await this.topicCommands.handleGeneralCommand(msg)) {
      return;
    }

    // Intercept /ctx in any instance topic
    if (await this.topicCommands.handleInstanceCommand(msg, instanceName)) {
      return;
    }

    // Bind instance to the adapter that delivered this message
    if (msg.adapterId) this.bindInstanceAdapter(instanceName, msg.adapterId, true);

    const inboundAdapter = this.worlds.get(msg.adapterId ?? "")?.adapter ?? this.adapter!;

    // React immediately — before any other Discord API calls
    if (msg.chatId && msg.messageId) {
      inboundAdapter.react(msg.threadId ?? msg.chatId, msg.messageId, "👀")
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

    const ipc = this.instanceIpcClients.get(instanceName);
    if (!ipc) {
      this.logger.warn({ instanceName }, "No IPC connection to instance");
      return;
    }

    ipc.send({
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
        source: msg.source,
        ...(msg.replyToText ? { reply_to_text: msg.replyToText } : {}),
        ...extraMeta,
      },
    });
    this.lastInboundUser.set(instanceName, msg.username);
    this.logger.info(`${msg.username} → ${instanceName}: ${(text ?? "").slice(0, 100)}`);
    this.eventLog?.logActivity("message", msg.username, (text ?? "").slice(0, 200), instanceName);
    this.emitSseEvent("message", {
      instance: instanceName, sender: msg.username,
      text: (text ?? "").slice(0, 2000), ts: new Date().toISOString(),
    });
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
    const threadId = resolveReplyThreadId(args.thread_id, routingConfig)
      ?? this.classicChannels?.getChannelIdByInstance(senderInstanceName ?? instanceName);

    // Select adapter: use instance binding, or resolve from chatId in args
    const outAdapter = this.getAdapterForInstance(senderInstanceName ?? instanceName) ?? this.adapter;
    if (!outAdapter) { respond(null, "No adapter available"); return; }

    // Route standard channel tools (reply, react, edit_message, download_attachment)
    if (routeToolCall(outAdapter, tool, args, threadId, respond)) {
      if (tool === "reply") {
        const replyTo = this.lastInboundUser.get(instanceName) ?? "user";
        this.logger.info(`${instanceName} → ${replyTo}: ${(args.text as string ?? "").slice(0, 100)}`);
        this.emitSseEvent("message", {
          instance: instanceName, sender: senderSessionName ?? instanceName,
          text: (args.text as string ?? "").slice(0, 2000),
          ts: new Date().toISOString(),
        });
        // Log bot reply to classic instance chat-log
        const isClassic = [...this.routing.entries()].some(([, t]) => t.kind === "classic" && t.name === instanceName);
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
      statusAdapter.editMessage(chatId, editMessageId, text).catch(e => this.logger.debug({ err: e }, "Failed to edit tool status message"));
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
      this.notifyInstanceTopic(target, `⏳ Schedule "${label ?? id}" deferred — rate limit at ${rl.five_hour_pct}%`);
      this.logger.info({ target, scheduleId: id, rateLimitPct: rl.five_hour_pct }, "Schedule deferred due to rate limit");
      return;
    }

    const schedulerDefaults = this.fleetConfig?.defaults.scheduler;

    const retryCount = schedulerDefaults?.retry_count ?? 3;
    const retryInterval = schedulerDefaults?.retry_interval_ms ?? 30_000;

    const deliver = (): boolean => {
      const ipc = this.instanceIpcClients.get(target);
      if (!ipc?.connected) return false;

      ipc.send({
        type: "fleet_schedule_trigger",
        payload: { schedule_id: id, message: `[Scheduled] ${message}`, label },
        meta: { chat_id: reply_chat_id, thread_id: reply_thread_id, user: "scheduler" },
      });
      return true;
    };

    if (deliver()) {
      this.scheduler!.recordRun(id, "delivered");
      if (source !== target) this.notifySourceTopic(schedule);
      return;
    }

    for (let i = 0; i < retryCount; i++) {
      await new Promise((r) => setTimeout(r, retryInterval));
      if (deliver()) {
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

  /** Save fleet config back to fleet.yaml */
  saveFleetConfig(): void {
    if (!this.fleetConfig || !this.configPath) return;
    const toSave: Record<string, unknown> = {};
    if (this.fleetConfig.project_roots) toSave.project_roots = this.fleetConfig.project_roots;
    if (this.fleetConfig.channels && this.fleetConfig.channels.length > 0) {
      toSave.channels = this.fleetConfig.channels;
    } else if (this.fleetConfig.channel) {
      toSave.channel = this.fleetConfig.channel;
    }
    if (this.fleetConfig.health_port) toSave.health_port = this.fleetConfig.health_port;
    if (Object.keys(this.fleetConfig.defaults).length > 0) toSave.defaults = this.fleetConfig.defaults;
    if (this.fleetConfig.teams && Object.keys(this.fleetConfig.teams).length > 0) {
      toSave.teams = this.fleetConfig.teams;
    }
    if (this.fleetConfig.templates && Object.keys(this.fleetConfig.templates).length > 0) {
      toSave.templates = this.fleetConfig.templates;
    }
    if (this.fleetConfig.profiles && Object.keys(this.fleetConfig.profiles).length > 0) {
      toSave.profiles = this.fleetConfig.profiles;
    }
    toSave.instances = {};
    for (const [name, inst] of Object.entries(this.fleetConfig.instances)) {
      const serialized: Record<string, unknown> = {
        working_directory: inst.working_directory,
        topic_id: inst.topic_id,
      };
      // Preserve all optional user-configured fields so saveFleetConfig() never silently drops them
      if (inst.general_topic) serialized.general_topic = true;
      if (inst.channel_id) serialized.channel_id = inst.channel_id;
      if (inst.description) serialized.description = inst.description;
      if (inst.tags?.length) serialized.tags = inst.tags;
      if (inst.model) serialized.model = inst.model;
      if (inst.model_failover?.length) serialized.model_failover = inst.model_failover;
      if (inst.worktree_source) serialized.worktree_source = inst.worktree_source;
      if (inst.backend) serialized.backend = inst.backend;
      if (inst.systemPrompt) serialized.systemPrompt = inst.systemPrompt;
      if (inst.skipPermissions) serialized.skipPermissions = inst.skipPermissions;
      if (inst.lightweight) serialized.lightweight = inst.lightweight;
      if (inst.cost_guard) serialized.cost_guard = inst.cost_guard;
      if (inst.workflow !== undefined) serialized.workflow = inst.workflow;
      if (inst.agent_mode) serialized.agent_mode = inst.agent_mode;
      (toSave.instances as Record<string, unknown>)[name] = serialized;
    }
    writeFileSync(this.configPath, yaml.dump(toSave, { lineWidth: 120 }));
    this.logger.info({ path: this.configPath }, "Saved fleet config");
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
    this.statuslineWatcher.watch(name);
  }

  reactMessageStatus(chatId: string, messageId: string, emoji: string): void {
    // Find the adapter that owns this chatId (check all adapters, not just primary)
    for (const [, w] of this.worlds) {
      if (w.type === "discord") {
        w.react(chatId, messageId, emoji)
          .catch(e => this.logger.debug({ err: (e as Error).message }, "Message status react failed"));
        return;
      }
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

  notifyInstanceTopic(instanceName: string, text: string): void {
    const adapter = this.getAdapterForInstance(instanceName) ?? this.adapter;
    if (!adapter) return;
    const channelCfg = this.getChannelConfig(this.instanceWorldBinding.get(instanceName));
    const groupId = channelCfg?.group_id;

    // Fleet topic instance
    const threadId = this.fleetConfig?.instances[instanceName]?.topic_id;
    if (threadId != null && groupId) {
      adapter.sendText(String(groupId), text, { threadId: String(threadId) })
        .catch(e => this.logger.warn({ err: e, instanceName }, "Failed to send instance topic notification"));
      return;
    }

    // Classic instance: find chatId from routing table
    for (const [chatId, target] of this.routing.entries()) {
      if (target.kind === "classic" && target.name === instanceName) {
        adapter.sendText(chatId, text)
          .catch(e => this.logger.warn({ err: e, instanceName }, "Failed to send classic notification"));
        return;
      }
    }

    // Fallback: send to group without threadId
    if (groupId) {
      adapter.sendText(String(groupId), text)
        .catch(e => this.logger.warn({ err: e, instanceName }, "Failed to send notification (no topic)"));
    }
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

  async sendHangNotification(instanceName: string): Promise<void> {
    const adapter = this.getAdapterForInstance(instanceName) ?? this.adapter;
    if (!adapter) return;
    const channelCfg = this.getChannelConfig(this.instanceWorldBinding.get(instanceName));
    const groupId = channelCfg?.group_id;
    if (!groupId) return;
    const threadId = this.fleetConfig?.instances[instanceName]?.topic_id;

    this.setTopicIcon(instanceName, "red");

    await adapter.notifyAlert(String(groupId), {
      type: "hang",
      instanceName,
      message: `⚠️ ${instanceName} appears hung (no activity for 15+ minutes)`,
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
    const isCollabMode = this.classicChannels?.isCollab(channelId) ?? false;

    // Collab mode: trigger on @mention of our bot, log all messages
    if (isCollabMode) {
      // Skip empty bot messages (e.g., reactions) — don't pollute chat log
      if (msg.isBotMessage && !text && !msg.attachments?.length) return;

      // Log every message (including other bots) to chat-logs
      const collabAttachTag = msg.attachments?.length
        ? ` [${msg.attachments.map(a => `${a.kind === "photo" ? "📷" : "📎"} ${a.filename || a.kind}`).join(", ")}]`
        : "";
      ClassicChannelManager.logMessage(instanceName, msg.username, text + collabAttachTag, msg.timestamp, msg.replyToText);
      this.logger.info({ instanceName, user: msg.username, textLen: text.length, attachments: msg.attachments?.length ?? 0, source: msg.source }, "Collab mode message");

      // Check for @mention trigger: must be exact <@BOT_USER_ID>, not @everyone/@here
      const adapterBotUserId = this.worlds.get(msg.adapterId ?? "")?.botUserId ?? this.botUserId;
      const mentionTag = adapterBotUserId ? `<@${adapterBotUserId}>` : null;
      const isMentioned = mentionTag && text.includes(mentionTag);
      if (!isMentioned) {
        // Save bare attachments (stickers, images) even without @mention
        if (msg.attachments?.length) {
          const saved = await this.saveClassicAttachment(instanceName, msg);
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

      // Save and process attachments (same as /chat mode)
      const saved = await this.saveClassicAttachment(instanceName, msg);
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
    msg: { chatId: string; threadId?: string; messageId: string; userId: string; username: string; source: string; timestamp: Date; replyToText?: string },
    extraMeta?: Record<string, string>,
  ): Promise<void> {
    const contextLines = this.classicChannels?.getContextLines(msg.chatId) ?? 5;
    const logContext = this.getRecentChatLog(instanceName, contextLines);
    const fullText = logContext
      ? `[Chat log for context]\n${logContext}\n\n[User message]\n${text}`
      : text;

    const ipc = this.instanceIpcClients.get(instanceName);
    if (!ipc) {
      this.logger.warn({ instanceName }, "Classic channel instance IPC not connected");
      return;
    }

    ipc.send({
      type: "fleet_inbound",
      content: fullText,
      targetSession: instanceName,
      meta: {
        chat_id: msg.chatId,
        message_id: msg.messageId,
        user: msg.username,
        user_id: msg.userId,
        ts: msg.timestamp.toISOString(),
        thread_id: msg.threadId ?? "",
        source: msg.source,
        ...extraMeta,
        ...(msg.replyToText ? { reply_to_text: msg.replyToText } : {}),
      },
    });
    this.lastInboundUser.set(instanceName, msg.username);
    this.logger.info(`${msg.username} → ${instanceName} (classic): ${text.slice(0, 100)}`);
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

  /** Start a classic channel instance with lightweight config */
  private async startClassicInstance(instanceName: string, backend?: string, preTaskCommand?: string, model?: string): Promise<void> {
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
      ...(preTaskCommand ? { pre_task_command: preTaskCommand } : {}),
    };
    const topicMode = this.fleetConfig?.channel?.mode === "topic";
    await this.startInstance(instanceName, config, topicMode);
  }

  /** Handle /start slash command — register classic channel */
  async handleClassicStart(channelId: string, channelName: string, userId: string, guildId?: string): Promise<string> {
    if (!this.classicChannels) return "Classic channel manager not initialized.";
    if (guildId && !this.classicChannels.isGuildAllowed(guildId)) return "⛔ This server is not in the allowed guilds list.";
    if (this.classicChannels.isClassicChannel(channelId)) return "This channel already has an active agent. Use /chat to talk.";
    if (this.routing.resolve(channelId)) return "This channel is already bound to a topic-mode instance.";

    const instanceName = classicInstanceName(sanitizeInstanceName(channelName || channelId), channelId);
    this.classicChannels.register(channelId, instanceName, channelName || channelId, userId);
    this.routing.register(channelId, { kind: "classic", name: instanceName });

    await this.startClassicInstance(instanceName, this.classicChannels.getBackend(channelId, this.fleetConfig?.defaults?.backend), this.classicChannels.getPreTaskCommand(channelId), this.classicChannels.getModel(channelId, this.fleetConfig?.defaults?.model));
    this.reregisterClassicChannels();
    this.logger.info({ channelId, instanceName, userId }, "Classic channel started");
    return `✅ Agent started in this channel. Use \`/chat <message>\` to talk.`;
  }

  /** Handle /stop slash command — unregister classic channel */
  async handleClassicStop(channelId: string): Promise<string> {
    if (!this.classicChannels) return "Classic channel manager not initialized.";
    const ch = this.classicChannels.unregister(channelId);
    if (!ch) return "No active agent in this channel.";

    this.routing.unregister(channelId);
    await this.stopInstance(ch.instanceName).catch(err =>
      this.logger.warn({ err, instanceName: ch.instanceName }, "Failed to stop classic instance"));
    this.reregisterClassicChannels();
    this.logger.info({ channelId, instanceName: ch.instanceName }, "Classic channel stopped");
    return `🛑 Agent stopped in this channel.`;
  }

  async stopAll(): Promise<void> {
    this.ipcStoppingInstances.add("__fleet_stopping__");
    sdNotify("STOPPING=1");
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
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
    this.topicArchiver.stop();

    this.scheduler?.shutdown();

    // Stop instances in parallel batches to avoid long sequential waits.
    // Concurrency limited to avoid overwhelming the tmux server.
    const STOP_CONCURRENCY = 5;
    const entries = [...this.daemons.entries()];
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

    for (const [, ipc] of this.instanceIpcClients) {
      await ipc.close();
    }
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
      await this.adapter.sendText(String(groupId), `🔄 Full restart initiated — waiting for all instances to idle, then reloading process...`)
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
      await this.adapter.sendText(String(groupId), `🔄 Graceful restart initiated — waiting for all instances to idle...`, notifyOpts)
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
            this.startClassicInstance(ch.instanceName, this.classicChannels!.getBackendByInstance(ch.instanceName, fleetBackend)).catch(err =>
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
      const failedNames = Object.keys(fleet.instances).filter(n => !this.daemons.has(n));
      const restartText = failedNames.length === 0
        ? `Fleet ready. ${started}/${total} instances running.`
        : `Fleet ready. ${started}/${total} instances running. Failed: ${failedNames.join(", ")}`;
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
        try {
          const beta = execSync("npm view @songsid/agend@beta version", { stdio: "pipe", timeout: 15_000 }).toString().trim();
          if (beta && beta !== currentVersion) target = beta;
        } catch { /* no beta tag */ }
      }
      if (target && target !== currentVersion) {
        const generalId = this.findGeneralInstance();
        if (generalId) {
          this.notifyInstanceTopic(generalId, `🆕 AgEnD v${target} available (current: v${currentVersion}). Use /update to upgrade.`);
        }
      }
    } catch { /* silent — network issues */ }
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

    this.healthServer = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");

      // Public health probe — no auth required.
      if (req.method === "GET" && req.url === "/health") {
        // fallthrough to existing handler below
      } else if (req.method === "POST" && req.url === "/agent") {
        // /agent handles its own instance-level auth via X-Agend-Instance-Token
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
        const enriched = sysInfo.instances.map(inst => {
          const config = this.fleetConfig?.instances[inst.name];
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
            description: config?.description ?? null,
            backend: config?.backend ?? "claude-code",
            tool_set: config?.tool_set ?? "full",
            general_topic: config?.general_topic ?? false,
            lastActivity: this.lastActivityMs(inst.name) || null,
            currentTask,
          };
        });
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.writeHead(200);
        res.end(JSON.stringify({
          ...sysInfo,
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

      // ── Agent CLI endpoint ─────
      if (req.url === "/agent" && req.method === "POST") {
        handleAgentRequest(req, res, this as unknown as import("./agent-endpoint.js").AgentEndpointContext);
        return;
      }

      // ── Web UI endpoints (delegated to web-api.ts) ─────

      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
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
