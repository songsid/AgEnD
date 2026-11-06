/** Versioned, bounded runtime transport. This module is safe in the standalone Windows client. */
import type { WindowsCliProbe, WindowsCliTask } from "./windows-cli.js";
import type { NativeTaskInput } from "./windows-cli-worker.js";
import { createHash } from "node:crypto";
import type { PaneMcpBody } from "./runtime-pane-mcp-protocol.js";
import type { RuntimePaneRequest, RuntimePaneSnapshot } from "./runtime-pane-protocol.js";

export const RUNTIME_PROTOCOL_VERSION = 1;
export const RUNTIME_CONNECT_PATH = "/runtime/v1/connect";
export const RUNTIME_PAIR_PATH = "/runtime/v1/pair";
export const RUNTIME_CLAIM_PATH = "/runtime/v1/claim";
export const RUNTIME_ROTATE_PATH = "/runtime/v1/rotate";
/** Public comparison value, not an authentication credential. Also works for pending v1 store records. */
export function runtimeFingerprintFromHash(digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw Error("Invalid runtime claim digest");
  return digest.slice(0, 12).toUpperCase().match(/.{4}/g)!.join("-");
}
export function runtimeClaimFingerprint(claim: string): string {
  if (!/^[a-f0-9]{64}$/.test(claim)) throw Error("Invalid runtime claim");
  return runtimeFingerprintFromHash(createHash("sha256").update(claim).digest("hex"));
}
export const RUNTIME_MAX_FRAME_BYTES = 256 * 1024;
export interface RuntimeInfo {
  version?: string;
  /** SHA-256 of the runtime program modules and package version, not a trust signature. */
  buildId?: string;
  protocolVersions: number[];
  capabilities: string[];
}
/**
 * What this AgEnD needs from any Runtime it hands work to. A Runtime that cannot offer these (it speaks no protocol this
 * AgEnD does, or lacks a required capability) was installed from another AgEnD release: the fix is to run the install
 * command again, which installs this AgEnD's own Runtime next to the old one.
 */
export const RUNTIME_REQUIRED_CAPABILITIES: readonly string[] = ["exec"];
export function runtimeInfoCompatible(info: RuntimeInfo): boolean {
  return info.protocolVersions.includes(RUNTIME_PROTOCOL_VERSION) && RUNTIME_REQUIRED_CAPABILITIES.every(capability => info.capabilities.includes(capability));
}
/** The WebSocket close reason (at most 123 bytes) AgEnD gives an incompatible Runtime; the Runtime recognises this prefix and says what to do. */
export const RUNTIME_REINSTALL_CLOSE_PREFIX = "Runtime incompatible with this AgEnD";
export const RUNTIME_REINSTALL_CLOSE_REASON = `${RUNTIME_REINSTALL_CLOSE_PREFIX}: re-run the install command`;
export const validRuntimeVersion = (value: unknown): value is string => typeof value === "string" && value.length <= 64 && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value);
/** Bounded diagnostic metadata; capabilities never replace execution authorization or pane negotiation. */
export function parseRuntimeInfo(value: unknown): RuntimeInfo | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid runtime version information");
  const input = value as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(input)) > 4096 || input.version !== undefined && !validRuntimeVersion(input.version)
    || input.buildId !== undefined && (typeof input.buildId !== "string" || !/^[a-f0-9]{64}$/.test(input.buildId))
    || !Array.isArray(input.protocolVersions) || !input.protocolVersions.length || input.protocolVersions.length > 8
    || input.protocolVersions.some(v => !Number.isInteger(v) || v < 1 || v > 255) || new Set(input.protocolVersions).size !== input.protocolVersions.length
    || !Array.isArray(input.capabilities) || input.capabilities.length > 16
    || input.capabilities.some(v => typeof v !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(v)) || new Set(input.capabilities).size !== input.capabilities.length) throw Error("Invalid runtime version information");
  return { ...(input.version !== undefined ? { version: input.version as string } : {}), ...(input.buildId !== undefined ? { buildId: input.buildId as string } : {}),
    protocolVersions: [...input.protocolVersions] as number[], capabilities: [...input.capabilities] as string[] };
}
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
  pairingFingerprint?: string;
  paneProtocol?: 1;
  runtimeInfo?: RuntimeInfo;
  runtimeCompatibility?: "compatible" | "legacy" | "incompatible" | "unknown";
}
export interface RuntimePairing { pairingId: string; code: string; expiresAt: number }
export interface RuntimePairResult { machineId: string; claimSecret: string; status: "pending"; expiresAt: number }
export type RuntimeClaimResult = { status: "pending" } | { status: "approved"; machineId: string; credential: string };
export interface RuntimeHello { v: 1; type: "hello"; bootId: string; inventory?: WindowsCliProbe; name?: string; platform?: string; paneProtocol?: 1; runtimeInfo?: RuntimeInfo }
export interface RuntimeWelcome { v: 1; type: "welcome"; machineId: string; generation: number }
export interface RuntimeRequest { v: 1; type: "request"; id: string; operation: RuntimeOperation; payload: unknown }
export interface RuntimeResponse { v: 1; type: "response"; id: string; ok: boolean; result?: unknown; error?: string }
export interface RuntimeTaskEvent { v: 1; type: "task"; seq: number; task: WindowsCliTask }
export interface RuntimeInventoryEvent { v: 1; type: "inventory"; inventory: WindowsCliProbe }
export interface RuntimeToolCall { v: 1; type: "tool.call"; id: string; runId: string; body: unknown }
export interface RuntimeToolResult { v: 1; type: "tool.result"; id: string; ok: boolean; result?: unknown; error?: string }
export interface RuntimePaneCall { v: 1; type: "pane.request"; id: string; maxAgents: number; request: RuntimePaneRequest }
export interface RuntimePaneReply { v: 1; type: "pane.response"; id: string; ok: boolean; result?: unknown; error?: string }
export interface RuntimePaneOutput { v: 1; type: "pane.output"; snapshot: RuntimePaneSnapshot }
export interface RuntimePaneToolCall { v: 1; type: "pane.tool.request"; id: string; body: PaneMcpBody }
export interface RuntimePaneToolResult { v: 1; type: "pane.tool.result"; id: string; ok: boolean; result?: unknown }
export type RuntimeServerMessage = RuntimeWelcome | RuntimeRequest | RuntimeToolResult | RuntimePaneCall | RuntimePaneToolResult;
export type RuntimeClientMessage = RuntimeHello | RuntimeResponse | RuntimeTaskEvent | RuntimeInventoryEvent | RuntimeToolCall | RuntimePaneReply | RuntimePaneOutput | RuntimePaneToolCall;
