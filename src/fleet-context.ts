import type { FleetConfig, InstanceConfig } from "./types.js";
import type { ChannelAdapter, InboundMessage } from "./channel/types.js";
import type { IpcClient } from "./channel/ipc-bridge.js";
import type { Scheduler } from "./scheduler/index.js";
import type { Logger } from "./logger.js";
import type { CostGuard } from "./cost-guard.js";
import type { ClassicChannelManager } from "./classic-channel-manager.js";

export type RouteTarget =
  | { kind: "instance"; name: string }
  | { kind: "general"; name: string }
  | { kind: "classic"; name: string };

export interface SysInfo {
  uptime_seconds: number;
  memory_mb: { rss: number; heapUsed: number; heapTotal: number };
  instances: { name: string; status: string; ipc: boolean; costCents: number; rateLimits: { five_hour_pct: number; seven_day_pct: number } | null }[];
  fleet_cost_cents: number;
  fleet_cost_limit_cents: number;
  /** Counts for the fleet summary line (fleet + Classic combined) */
  running_count: number;
  paused_count: number;
  /**
   * Service cgroup anonymous memory in MB (null if not running under systemd/cgroup).
   * This is the entire fleet process tree: FleetManager, CLI agents, MCP servers, helpers.
   * Differs from per-instance RSS — it's the systemd "Memory" figure for the whole service.
   */
  fleet_mem_mb: number | null;
  /** System memory: used and total in GB */
  system_mem_gb: { used: number; total: number };
}

export function isProbeableRouteTarget(target: RouteTarget): boolean {
  return target.kind === "instance";
}

/**
 * Shared context interface for fleet sub-modules (topic commands).
 * FleetManager implements this and passes `this` to extracted handlers.
 */
export interface FleetContext {
  readonly adapter: ChannelAdapter | null;
  readonly adapters?: Map<string, ChannelAdapter>;
  readonly fleetConfig: FleetConfig | null;
  readonly routingTable: Map<string, RouteTarget>;
  readonly instanceIpcClients: Map<string, IpcClient>;
  readonly scheduler: Scheduler | null;
  readonly logger: Logger;
  readonly dataDir: string;
  readonly costGuard: CostGuard | null;
  /** Classic-bot channels (defined in classicBot.yaml, not fleet.yaml instances). */
  readonly classicChannels: ClassicChannelManager | null;

  getSysInfo(): SysInfo;
  getInstanceStatus(name: string): "running" | "paused" | "stopped" | "crashed";
  /** Current cancellation epoch stamped onto direct daemon IPC deliveries. */
  getDeliveryEpoch?(name: string): number;
  /** Subscription provider IDs used by running or paused fleet/Classic instances. */
  getActiveUsageProviderIds?(): ReadonlySet<string>;
  /** Effective backend IDs used by running or paused fleet/Classic instances. */
  getActiveBackendIds?(): ReadonlySet<string>;
  toggleFleetCollab(instanceName: string): boolean;
  /** Apply a model to an instance (runtime paste or persist + restart). Returns a status string. */
  applyModel(instanceName: string, model: string): Promise<string>;
  /** Interrupt an instance's current generation (cancel button / /cancel). */
  cancelInstance(instanceName: string): boolean;
  /** Explicit YAML allowlist entries are fleet administrators. Runtime-paired/open users are not. */
  isFleetAdmin(userId: string, adapterId?: string): boolean;
  changeInstancePauseState(name: string, action: "pause" | "wake"): Promise<"paused" | "awake" | "not_idle">;
  startInstance(name: string, config: InstanceConfig, topicMode: boolean): Promise<void>;
  stopInstance(name: string): Promise<void>;
  connectIpcToInstance(name: string): Promise<void>;
  saveFleetConfig(): void;
  getInstanceDir(name: string): string;
  createForumTopic(topicName: string, adapterId?: string): Promise<number | string>;
  removeInstance(name: string): Promise<void>;
  getAdapterStates?(): Map<string, { status: string; retryCount: number; lastError?: string }>;
  getInstanceExecutionState?(name: string): "idle" | "working" | "stuck" | "paused" | null;
  /** Live dashboard auth/readiness; URLs must not be issued before the server listens. */
  getDashboardAccess?(): { ready: boolean; token: string | null };
  /** Persist and edit one `/update` message across the fleet process restart. */
  beginUpdateProgress?(adapter: import("./channel/types.js").ChannelAdapter, chatId: string, threadId: string | undefined, messageId: string): void;
  failUpdateProgress?(message: string): void;
  /** Post one random, not-yet-dismissed tip with a dismiss button. */
  promptTip?(
    generalName: string,
    adapter: import("./channel/types.js").ChannelAdapter,
    chatId: string,
    threadId?: string,
  ): Promise<"posted" | "empty" | "unavailable">;
  /** Persistently enable advanced tips without waiting for the dismissal threshold. */
  unlockAdvancedTips?(userId: string): boolean;
  /** `/install-cli` backend chooser buttons. Caller enforces fleet-admin. */
  promptInstallBackends?(chat: {
    adapter: import("./channel/types.js").ChannelAdapter;
    adapterId: string;
    chatId: string;
    threadId?: string;
  }): Promise<void>;
  /** `/login` backend chooser buttons. Caller enforces fleet-admin. */
  promptLoginBackends?(chat: {
    adapter: import("./channel/types.js").ChannelAdapter;
    adapterId: string;
    chatId: string;
    threadId?: string;
  }): Promise<void>;
  /**
   * Start a remote login session for one backend; returns a status line, or
   * null when a still-valid-auth confirmation prompt was posted instead.
   */
  startLoginSession?(backend: string, chat: {
    adapter: import("./channel/types.js").ChannelAdapter;
    adapterId: string;
    chatId: string;
    threadId?: string;
  }, opts?: { skipAuthCheck?: boolean }): Promise<string | null>;
  /** Paste admin-supplied text (auth code / start URL) into the login window. */
  loginSubmitInput?(text: string): Promise<string>;
  /** Abort the active login session. */
  cancelLoginSession?(): Promise<string>;
  /** `/install-cli <backend>` — install a CLI in a dedicated window; returns a status line. */
  startInstallSession?(backend: string, chat: {
    adapter: import("./channel/types.js").ChannelAdapter;
    adapterId: string;
    chatId: string;
    threadId?: string;
  }): Promise<string>;
  /** Abort the active install session. */
  cancelInstallSession?(): Promise<string>;
  /** Human-readable effective model for an instance (resolves inherited defaults). */
  modelDisplayForInstance?(name: string): string;
  /**
   * Show a model-selection inline keyboard for the given instance in a TG topic.
   * Returns a fallback text message if no model list is available (caller should send it).
   * Returns null if the menu was shown successfully.
   */
  promptModelMenu?(
    instanceName: string,
    userId: string,
    channelId: string,
    adapter: import("./channel/types.js").ChannelAdapter,
    chatId: string,
    threadId?: string,
  ): Promise<string | null>;

  /** Configured effort for an instance, for display (null when unset). */
  resolveInstanceEffort?(instanceName: string): { effort: string | null; source: "instance" | "fleet-default" | "unset" };

  /** Apply a reasoning-effort level (runtime paste or persist+restart). */
  applyEffort?(instanceName: string, level: string): Promise<string>;

  /** TG inline-keyboard effort menu; same contract as promptModelMenu. */
  promptEffortMenu?(
    instanceName: string,
    userId: string,
    channelId: string,
    adapter: import("./channel/types.js").ChannelAdapter,
    chatId: string,
    threadId?: string,
  ): Promise<string | null>;

  /**
   * Post a nonce-armed confirmation before the destructive `/clear` command.
   * Returns null when the buttons were posted, otherwise a user-facing error.
   */
  promptClearConfirmation?(
    instanceName: string,
    channelId: string,
    adapter: import("./channel/types.js").ChannelAdapter,
    chatId: string,
    threadId?: string,
  ): Promise<string | null>;
}
