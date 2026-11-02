/** Versioned, bounded runtime transport. This module is safe in the standalone Windows client. */
import type { WindowsCliProbe, WindowsCliTask } from "./windows-cli.js";
import type { NativeTaskInput } from "./windows-cli-worker.js";

export const RUNTIME_PROTOCOL_VERSION = 1;
export const RUNTIME_CONNECT_PATH = "/runtime/v1/connect";
export const RUNTIME_PAIR_PATH = "/runtime/v1/pair";
export const RUNTIME_CLAIM_PATH = "/runtime/v1/claim";
export const RUNTIME_MAX_FRAME_BYTES = 256 * 1024;
export type RuntimeOperation = "probe" | "workspace" | "run" | "cancel" | "reconcile" | "recover";
export interface RuntimeRunPayload {
  task: NativeTaskInput;
  resumeSessionId?: string;
  context?: string;
  /** Tool names only; coordinator credentials never cross this transport. */
  mcp?: { tools: string[] };
}
export interface RuntimeMachine {
  id: string;
  name: string;
  platform: "win32";
  hostname?: string;
  status: "pending" | "offline" | "online" | "revoked";
  createdAt: number;
  approvedAt?: number;
  lastSeenAt?: number;
  inventory?: WindowsCliProbe;
  inventoryUpdatedAt?: number;
  bootId?: string;
  generation: number;
}
export interface RuntimePairing { pairingId: string; code: string; expiresAt: number }
export interface RuntimePairResult { machineId: string; claimSecret: string; status: "pending"; expiresAt: number }
export type RuntimeClaimResult = { status: "pending" } | { status: "approved"; machineId: string; credential: string };
export interface RuntimeHello { v: 1; type: "hello"; bootId: string; inventory?: WindowsCliProbe; name?: string; platform?: string }
export interface RuntimeWelcome { v: 1; type: "welcome"; machineId: string; generation: number }
export interface RuntimeRequest { v: 1; type: "request"; id: string; operation: RuntimeOperation; payload: unknown }
export interface RuntimeResponse { v: 1; type: "response"; id: string; ok: boolean; result?: unknown; error?: string }
export interface RuntimeTaskEvent { v: 1; type: "task"; seq: number; task: WindowsCliTask }
export interface RuntimeInventoryEvent { v: 1; type: "inventory"; inventory: WindowsCliProbe }
export interface RuntimeToolCall { v: 1; type: "tool.call"; id: string; runId: string; body: unknown }
export interface RuntimeToolResult { v: 1; type: "tool.result"; id: string; ok: boolean; result?: unknown; error?: string }
export type RuntimeServerMessage = RuntimeWelcome | RuntimeRequest | RuntimeToolResult;
export type RuntimeClientMessage = RuntimeHello | RuntimeResponse | RuntimeTaskEvent | RuntimeInventoryEvent | RuntimeToolCall;
