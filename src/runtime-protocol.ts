/** Versioned, bounded runtime transport. This module is safe in the standalone Windows client. */
import type { WindowsCliProbe, WindowsCliTask } from "./windows-cli.js";
import type { NativeTaskInput } from "./windows-cli-worker.js";
import { createHash } from "node:crypto";
import type { PaneMcpBody } from "./runtime-pane-mcp-protocol.js";
import type { RuntimePaneRequest, RuntimePaneSnapshot } from "./runtime-pane-protocol.js";
import type { RuntimeUpdateControl, RuntimeUpdateClientPhase, RuntimeUpdateServerPhase } from "./runtime-update-protocol.js";

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

/**
 * #3190 Part 3a: what a fleet admin may ask of a paired computer, ONLY while the local administrator has turned the matching switch on there.
 * They travel in their own frames (`account.request` / `account.response`), NOT as a `request`: the coordinator journals every `request` and its
 * answer to disk, and a sign-in URL or one-time code must never be written there. Like the pane frames, an account frame is answered or lost,
 * never replayed, and the server keeps no record of its payload.
 * Every request carries names and ids: a CLI id, a credential profile NAME, a sign-in method, the person's name for the record. Never an argv,
 * a command, a path or an environment. Replies carry only what the dashboard may show: a switch's state, a signed-in yes/no with the masked
 * identity, a sign-in's reduced screen. No token, and no raw CLI output.
 */
export const RUNTIME_REMOTE_OPERATIONS = ["accounts.switches", "signin.start", "signin.capture", "signin.status", "signin.write", "signin.close", "accounts.check", "accounts.signout", "accounts.remove", "cli.install"] as const;
export type RuntimeRemoteOperation = typeof RUNTIME_REMOTE_OPERATIONS[number];
export function isRuntimeRemoteOperation(value: unknown): value is RuntimeRemoteOperation {
  return typeof value === "string" && (RUNTIME_REMOTE_OPERATIONS as readonly string[]).includes(value);
}
export type RuntimeSignInMethod = "subscription" | "console";
export interface RuntimeSwitchStates { accounts: { on: boolean; until?: number }; install: { on: boolean; until?: number } }
export interface RuntimeRemotePayloads {
  "accounts.switches": Record<string, never>;
  "signin.start": { cli: string; profile: string; method: RuntimeSignInMethod; actor: string };
  "signin.capture": { sessionId: string };
  "signin.status": { sessionId: string };
  "signin.write": { sessionId: string; input: string };
  "signin.close": { sessionId: string };
  "accounts.check": { cli: string; profile: string };
  "accounts.signout": { cli: string; profile: string; actor: string };
  "accounts.remove": { cli: string; profile: string; actor: string };
  "cli.install": { cli: string; actor: string };
}
const REMOTE_KEYS: { [K in RuntimeRemoteOperation]: readonly (keyof RuntimeRemotePayloads[K])[] } = {
  "accounts.switches": [], "signin.start": ["cli", "profile", "method", "actor"], "signin.capture": ["sessionId"], "signin.status": ["sessionId"], "signin.write": ["sessionId", "input"],
  "signin.close": ["sessionId"], "accounts.check": ["cli", "profile"], "accounts.signout": ["cli", "profile", "actor"], "accounts.remove": ["cli", "profile", "actor"], "cli.install": ["cli", "actor"],
};
/**
 * Closed check of a remote-operation payload: exactly the fields listed, each a short string of its own shape, and nothing else. The error names
 * the field, never its value (a rejected payload could carry a code). The CLI id and profile name are checked again, in full, where they are used.
 */
export function parseRuntimeRemotePayload<K extends RuntimeRemoteOperation>(operation: K, payload: unknown): RuntimeRemotePayloads[K] {
  const fail = (field: string): never => { throw new Error(`Invalid ${operation} request: ${field}`); };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fail("payload");
  const input = payload as Record<string, unknown>, allowed = REMOTE_KEYS[operation] as readonly string[];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) return fail("unknown field");
  for (const key of allowed) {
    const value = input[key];
    if (typeof value !== "string") return fail(key);
    const pattern = key === "cli" ? /^[a-z][a-z0-9-]{0,31}$/ : key === "profile" ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ : key === "actor" ? /^[A-Za-z0-9._:-]{1,64}$/
      : key === "sessionId" ? /^[a-f0-9]{32}$/ : key === "method" ? /^(?:subscription|console)$/ : undefined;
    if (pattern ? !pattern.test(value) : (key !== "input" || Buffer.byteLength(value, "utf8") > 4098)) return fail(key);
  }
  return input as unknown as RuntimeRemotePayloads[K];
}
export interface RuntimeRunPayload {
  task: NativeTaskInput;
  resumeSessionId?: string;
  context?: string;
  /** Tool names only; coordinator credentials never cross this transport. */
  mcp?: { tools: string[] };
  /** A credential profile NAME (a Claude sign-in kept on that computer). Never a path: the Runtime maps it to its own folder. */
  credentialProfile?: string;
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
export interface RuntimeHello { v: 1; type: "hello"; bootId: string; inventory?: WindowsCliProbe; name?: string; platform?: string; paneProtocol?: 1; runtimeInfo?: RuntimeInfo; updateTrialId?: string }
export interface RuntimeWelcome { v: 1; type: "welcome"; machineId: string; generation: number; updateProtocol?: 1 }
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
export interface RuntimeAccountCall { v: 1; type: "account.request"; id: string; operation: RuntimeRemoteOperation; payload: unknown }
export interface RuntimeAccountReply { v: 1; type: "account.response"; id: string; ok: boolean; result?: unknown; error?: string }
export type RuntimeServerMessage = RuntimeWelcome | RuntimeRequest | RuntimeToolResult | RuntimePaneCall | RuntimePaneToolResult | RuntimeAccountCall | RuntimeUpdateControl<RuntimeUpdateServerPhase>;
export type RuntimeClientMessage = RuntimeHello | RuntimeResponse | RuntimeAccountReply | RuntimeTaskEvent | RuntimeInventoryEvent | RuntimeToolCall | RuntimePaneReply | RuntimePaneOutput | RuntimePaneToolCall | RuntimeUpdateControl<RuntimeUpdateClientPhase>;
