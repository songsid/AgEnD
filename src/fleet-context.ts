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
  toggleFleetCollab(instanceName: string): boolean;
  /** Interrupt an instance's current generation (cancel button / /cancel). */
  cancelInstance(instanceName: string): boolean;
  startInstance(name: string, config: InstanceConfig, topicMode: boolean): Promise<void>;
  stopInstance(name: string): Promise<void>;
  connectIpcToInstance(name: string): Promise<void>;
  saveFleetConfig(): void;
  getInstanceDir(name: string): string;
  createForumTopic(topicName: string, adapterId?: string): Promise<number | string>;
  removeInstance(name: string): Promise<void>;
  getAdapterStates?(): Map<string, { status: string; retryCount: number; lastError?: string }>;
  getInstanceExecutionState?(name: string): "idle" | "working" | "stuck" | "paused" | null;
}
