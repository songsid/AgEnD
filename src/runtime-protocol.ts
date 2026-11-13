/** Versioned, bounded runtime transport. This module is safe in the standalone Windows client. */
import type { WindowsCliProbe, WindowsCliTask } from "./windows-cli.js";
import type { NativeTaskInput } from "./windows-cli-worker.js";
import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import type { PaneMcpBody } from "./runtime-pane-mcp-protocol.js";
import type { RuntimePaneRequest, RuntimePaneSnapshot } from "./runtime-pane-protocol.js";
import type { RuntimeUpdateControl, RuntimeUpdateClientPhase, RuntimeUpdateServerPhase } from "./runtime-update-protocol.js";
import type { RuntimeUpdateReport, RuntimeUpdateStatusFrame } from "./runtime-update-status.js";

export const RUNTIME_PROTOCOL_VERSION = 1;
export const RUNTIME_CONNECT_PATH = "/runtime/v1/connect";
export const RUNTIME_PAIR_PATH = "/runtime/v1/pair";
export const RUNTIME_CLAIM_PATH = "/runtime/v1/claim";
export const RUNTIME_ROTATE_PATH = "/runtime/v1/rotate";
/** join with a one-time token from the install command. `enroll-hello` proves who the server is BEFORE the token is sent; `enroll` spends it. */
export const RUNTIME_ENROLL_HELLO_PATH = "/runtime/v1/enroll-hello";
export const RUNTIME_ENROLL_PATH = "/runtime/v1/enroll";
/** The token is 256 random bits behind a fixed, greppable prefix (so a secret scanner can find a leaked one). The server keeps only its SHA-256. */
export const RUNTIME_ENROLL_TOKEN_PATTERN = /^agend_enroll_[A-Za-z0-9_-]{43}$/;
/** SHA-256 of the server's enrollment public key (SPKI DER), in lower-case hex: what the install command pins. */
export const RUNTIME_SERVER_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const RUNTIME_ENROLL_NONCE_PATTERN = /^[a-f0-9]{32,64}$/;
/** Why an enrollment was refused; the Runtime turns each into one plain sentence and the next step. */
export type RuntimeEnrollRefusal = "invalid" | "expired" | "used" | "revoked" | "mismatch" | "limit";
export const RUNTIME_ENROLL_REFUSALS: readonly RuntimeEnrollRefusal[] = ["invalid", "expired", "used", "revoked", "mismatch", "limit"];
/** The non-secret id of a token: the first 64 bits of its SHA-256. The Runtime sends it with `enroll-hello` and `enroll` so the server can give a real token its own rate-limit bucket without being told the token. */
export const RUNTIME_ENROLL_TID_PATTERN = /^[a-f0-9]{16}$/;
export const runtimeEnrollTokenId = (token: string): string => createHash("sha256").update(token).digest("hex").slice(0, 16);
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
/**
 * `enroll-hello` answers with the server's identity key, a fresh X25519 key made for this one request, and an Ed25519 signature (by the identity key, so by the
 * key the install command pins) over the caller's nonce AND that fresh key. Only the holder of the identity key can sign it, and only the holder of the fresh
 * private key can later read what is sent to it, so a relay that merely forwards `enroll-hello` to the real server cannot read the token or the credential.
 */
export interface RuntimeEnrollHelloResult { publicKey: string; ephemeral: string; signature: string }
/** What `enroll` carries and answers with: AES-256-GCM boxes (base64url `iv` and `ciphertext` with its 16-byte tag at the end). Nothing secret is outside a box. */
export interface RuntimeEnrollBox { iv: string; ciphertext: string }
export interface RuntimeEnrollRequest extends RuntimeEnrollBox { nonce: string; tid: string; clientKey: string }
export interface RuntimeEnrollGrant { status: "enrolled"; machineId: string; credential: string }
/** The bytes the server signs in `enroll-hello`: this request's nonce and this request's fresh key, so the signature cannot be replayed for another request or another key. */
export function runtimeEnrollHelloMessage(nonce: string, ephemeral: string): Buffer {
  if (!RUNTIME_ENROLL_NONCE_PATTERN.test(nonce) || !BASE64URL_32.test(ephemeral)) throw Error("Invalid enrollment hello");
  return Buffer.from(`agend-runtime-enroll-hello-v2\n${nonce}\n${ephemeral}`, "utf8");
}
export function runtimeServerFingerprint(publicKeyDer: Uint8Array): string { return createHash("sha256").update(publicKeyDer).digest("hex"); }
/**
 * Client side of the server proof: the key must be an Ed25519 key whose fingerprint is EXACTLY the one pinned in the install command, and the
 * signature must cover this request's message. Anything else is false; nothing here throws on hostile input.
 */
export function verifyRuntimeServerProof(pinnedFingerprint: string, publicKey: unknown, signature: unknown, message: Uint8Array): boolean {
  try {
    if (typeof publicKey !== "string" || typeof signature !== "string" || publicKey.length > 256 || signature.length > 256
      || !RUNTIME_SERVER_FINGERPRINT_PATTERN.test(pinnedFingerprint)) return false;
    const der = Buffer.from(publicKey, "base64url");
    if (der.toString("base64url") !== publicKey) return false;
    const actual = Buffer.from(runtimeServerFingerprint(der), "hex");
    if (!timingSafeEqual(actual, Buffer.from(pinnedFingerprint, "hex"))) return false;
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519" && verify(null, message, key, Buffer.from(signature, "base64url"));
  } catch { return false; }
}
// ---- the sealed channel: X25519 key agreement, HKDF-SHA256, AES-256-GCM (all Node's own crypto) --------------------------------------------------------------
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
/** A fresh X25519 key for one request: the private key (kept in memory only) and the 32 raw public bytes as base64url. */
export function newRuntimeEnrollEphemeral(): { privateKey: KeyObject; publicKey: string } {
  const pair = generateKeyPairSync("x25519"), der = pair.publicKey.export({ type: "spki", format: "der" });
  return { privateKey: pair.privateKey, publicKey: der.subarray(der.length - 32).toString("base64url") };
}
function x25519Public(raw: string): KeyObject {
  if (!BASE64URL_32.test(raw)) throw Error("Invalid enrollment key");
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw, "base64url")]), format: "der", type: "spki" });
}
/** What both sides know after the key agreement: one key per direction, and the text that binds every box to this exchange (its nonce, token id and both fresh keys). */
export interface RuntimeEnrollChannel { requestKey: Buffer; replyKey: Buffer; context: string }
export function runtimeEnrollChannel(privateKey: KeyObject, peerPublic: string, nonce: string, tid: string, serverEphemeral: string, clientEphemeral: string): RuntimeEnrollChannel {
  if (!RUNTIME_ENROLL_NONCE_PATTERN.test(nonce) || !RUNTIME_ENROLL_TID_PATTERN.test(tid) || !BASE64URL_32.test(serverEphemeral) || !BASE64URL_32.test(clientEphemeral)) throw Error("Invalid enrollment channel");
  const shared = diffieHellman({ privateKey, publicKey: x25519Public(peerPublic) });
  if (shared.every(byte => byte === 0)) throw Error("Invalid enrollment key");   // a low-order public key makes an all-zero secret
  const context = `agend-runtime-enroll-v2\n${nonce}\n${tid}\n${serverEphemeral}\n${clientEphemeral}`;
  const keys = Buffer.from(hkdfSync("sha256", shared, Buffer.from(nonce, "utf8"), Buffer.from(context, "utf8"), 64));
  return { requestKey: keys.subarray(0, 32), replyKey: keys.subarray(32, 64), context };
}
export function sealRuntimeEnroll(key: Buffer, context: string, direction: "request" | "reply", plaintext: Buffer): RuntimeEnrollBox {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${context}\n${direction}`, "utf8"));
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { iv: iv.toString("base64url"), ciphertext: sealed.toString("base64url") };
}
/** The plaintext, or null when the box is malformed or was not sealed under this key for this exchange and direction. Never throws on hostile input. */
export function openRuntimeEnroll(key: Buffer, context: string, direction: "request" | "reply", box: unknown): Buffer | null {
  try {
    if (!box || typeof box !== "object") return null;
    const { iv, ciphertext } = box as Partial<RuntimeEnrollBox>;
    if (typeof iv !== "string" || typeof ciphertext !== "string" || iv.length !== 16 || ciphertext.length < 22 || ciphertext.length > 2800) return null;
    const ivBytes = Buffer.from(iv, "base64url"), sealed = Buffer.from(ciphertext, "base64url");
    if (ivBytes.length !== 12 || sealed.length < 17) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, ivBytes);
    decipher.setAAD(Buffer.from(`${context}\n${direction}`, "utf8")); decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  } catch { return null; }
}
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
export const RUNTIME_REMOTE_OPERATIONS = ["models.refresh", "accounts.switches", "signin.start", "signin.capture", "signin.status", "signin.write", "signin.close", "accounts.check", "accounts.signout", "accounts.remove", "cli.install", "cli.update"] as const;
export type RuntimeRemoteOperation = typeof RUNTIME_REMOTE_OPERATIONS[number];
export function isRuntimeRemoteOperation(value: unknown): value is RuntimeRemoteOperation {
  return typeof value === "string" && (RUNTIME_REMOTE_OPERATIONS as readonly string[]).includes(value);
}
export type RuntimeSignInMethod = "subscription" | "console";
export interface RuntimeSwitchStates { accounts: { on: boolean; until?: number }; install: { on: boolean; until?: number } }
export interface RuntimeRemotePayloads {
  "models.refresh": { cli: string; profile: string; actor: string };
  "accounts.switches": Record<string, never>;
  /** `profile` is a credential profile NAME. Absent, it is the computer's OWN login of a CLI that has one (Antigravity); the Runtime checks that pairing: any other CLI needs a name. */
  "signin.start": { cli: string; profile?: string; method: RuntimeSignInMethod; actor: string };
  "signin.capture": { sessionId: string };
  "signin.status": { sessionId: string };
  "signin.write": { sessionId: string; input: string };
  "signin.close": { sessionId: string };
  "accounts.check": { cli: string; profile?: string };
  /** `profile` absent: the computer's OWN login (Antigravity), signed out through the Credential Manager entry the registry names. */
  "accounts.signout": { cli: string; profile?: string; actor: string };
  "accounts.remove": { cli: string; profile: string; actor: string };
  "cli.install": { cli: string; actor: string };
  /** AGEND-153: take an installed CLI to the vendor's newest release — only for a CLI whose registry `runtime.update` is the named exception (`latest-unaudited`); the same two fields as an install. */
  "cli.update": { cli: string; actor: string };
}
const REMOTE_KEYS: { [K in RuntimeRemoteOperation]: readonly (keyof RuntimeRemotePayloads[K])[] } = {
  "models.refresh": ["cli", "profile", "actor"], "accounts.switches": [], "signin.start": ["cli", "profile", "method", "actor"], "signin.capture": ["sessionId"], "signin.status": ["sessionId"], "signin.write": ["sessionId", "input"],
  "signin.close": ["sessionId"], "accounts.check": ["cli", "profile"], "accounts.signout": ["cli", "profile", "actor"], "accounts.remove": ["cli", "profile", "actor"], "cli.install": ["cli", "actor"], "cli.update": ["cli", "actor"],
};
/** Fields that may be left out of a payload, per operation. Only `profile` of a sign-in start, a status check and a sign-out (Antigravity's own login on the computer has none). */
const REMOTE_OPTIONAL: { [K in RuntimeRemoteOperation]?: readonly string[] } = { "signin.start": ["profile"], "accounts.check": ["profile"], "accounts.signout": ["profile"] };
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
    if (value === undefined && !Object.hasOwn(input, key) && REMOTE_OPTIONAL[operation]?.includes(key)) continue;   // a field left out, not one set to something else
    if (typeof value !== "string") return fail(key);
    const pattern = key === "cli" ? /^[a-z][a-z0-9-]{0,31}$/ : key === "profile" ? (operation === "models.refresh" ? /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/ : /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/) : key === "actor" ? /^[A-Za-z0-9._:-]{1,64}$/
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
  /** Only in what the administrator's page reads: a computer still waiting for approval whose request has run out (it can no longer be approved, only dropped). */
  pairingExpired?: true;
  /** this computer joined with a one-time token from the install command (no pairing code, no approval step). Shown to the administrator, with a way to revoke. */
  enrolledVia?: "install-command";
  enrollmentId?: string;
  paneProtocol?: 1;
  runtimeInfo?: RuntimeInfo;
  updateReport?: RuntimeUpdateReport;
  runtimeCompatibility?: "compatible" | "legacy" | "incompatible" | "unknown";
}
export interface RuntimePairing { pairingId: string; code: string; expiresAt: number }
export interface RuntimePairResult { machineId: string; claimSecret: string; status: "pending"; expiresAt: number }
export type RuntimeClaimResult = { status: "pending" } | { status: "approved"; machineId: string; credential: string };
export interface RuntimeHello { v: 1; type: "hello"; bootId: string; inventory?: WindowsCliProbe; name?: string; platform?: string; paneProtocol?: 1; runtimeInfo?: RuntimeInfo; updateTrialId?: string }
export interface RuntimeWelcome { v: 1; type: "welcome"; machineId: string; generation: number; updateProtocol?: 1; updateStatusProtocol?: 1 }
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
export type RuntimeClientMessage = RuntimeHello | RuntimeResponse | RuntimeAccountReply | RuntimeTaskEvent | RuntimeInventoryEvent | RuntimeToolCall | RuntimePaneReply | RuntimePaneOutput | RuntimePaneToolCall | RuntimeUpdateControl<RuntimeUpdateClientPhase> | RuntimeUpdateStatusFrame;
