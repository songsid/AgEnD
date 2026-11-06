/** Durable machine registration and outbound-client transport; never starts a remote shell. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { readBoundedWebBody } from "./web-body.js";
import { atomicWriteFileSync } from "./atomic-write.js";
import { validateNativeTask, type NativeTaskInput } from "./windows-cli-worker.js";
import { inventoryProbed, type WindowsCliProbe, type WindowsCliTask } from "./windows-cli.js";
import type { NativeCliRow } from "./windows-cli-worker.js";
import { isNativeProviderId } from "./windows-cli-providers.js";
import { assertCredentialProfileCli, assertCredentialProfileName, parseCredentialProfileReport } from "./runtime-credential-profiles.js";
import { parseAccountIdentity } from "./claude-auth-status.js";
import { validatePaneMcpBody, type PaneMcpBody } from "./runtime-pane-mcp-protocol.js";
import { validateRuntimePaneRequest, validateRuntimePaneSnapshot, validateRuntimePaneShutdown, type RuntimePaneRequest, type RuntimePaneSnapshot } from "./runtime-pane-protocol.js";
import { RUNTIME_CLAIM_PATH, RUNTIME_CONNECT_PATH, RUNTIME_MAX_FRAME_BYTES, RUNTIME_PAIR_PATH, RUNTIME_ROTATE_PATH, runtimeFingerprintFromHash, parseRuntimeInfo, RUNTIME_PROTOCOL_VERSION,
  type RuntimeMachine, type RuntimeOperation, type RuntimePairing, type RuntimePairResult, type RuntimeClaimResult,
  type RuntimeRunPayload, type RuntimeServerMessage, isRuntimeRemoteOperation, parseRuntimeRemotePayload, type RuntimeRemoteOperation, type RuntimeRemotePayloads } from "./runtime-protocol.js";

const PAIR_TTL = 10 * 60_000;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const secret = () => randomBytes(32).toString("hex");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const equal = (value: string, digest: string) => /^[a-f0-9]{64}$/i.test(digest) && timingSafeEqual(Buffer.from(hash(value), "hex"), Buffer.from(digest, "hex"));
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** A deliberate validation failure whose static message is safe to show the runtime; every other error (I/O, internal) is not. */
class RuntimeProtocolError extends Error {}
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\0\r\n]/.test(v);
const terminal = (task: WindowsCliTask) => !!task.finishedAt && ["completed", "failed", "cancelled"].includes(task.status);
const loopback = (address: string | undefined) => address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
function privateTransport(req: IncomingMessage): boolean {
  return req.headers.origin === undefined && req.headers.cookie === undefined
    && (loopback(req.socket.remoteAddress) || (req.socket as typeof req.socket & { encrypted?: boolean }).encrypted === true);
}
function stable(value: unknown, depth = 0): string {
  if (depth > 64) throw Error("Runtime request is too deeply nested");
  if (Array.isArray(value)) return `[${value.map(value => stable(value, depth + 1)).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key], depth + 1)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
/** The CLI rows' `supports` flags AgEnD knows; any other key a Runtime adds is not kept. */
const SUPPORT_KEYS = ["execution", "resume", "model", "mcp"] as const;
const MODEL_SOURCES = ["cli-cache", "official-catalog", "cli-list", "unavailable"] as const;
/**
 * A Runtime's inventory, copied field by field from an allowlist: a field AgEnD does not know is not kept (so it can never be stored or served back
 * by /ui/runtimes), every text field has a length limit, and the account identity and the credential profile report are accepted in their
 * closed, masked form only. A refusal names the field and the reason, never the rejected value: an unmasked e-mail must not reach a log, a close
 * reason or an error message from here.
 */
function inventory(value: unknown): WindowsCliProbe {
  if (!record(value) || typeof value.home !== "string" || value.home.length > 1024 || !Array.isArray(value.clis) || value.clis.length > 16) throw new RuntimeProtocolError("Invalid runtime inventory");
  const seen = new Set<string>(), clis: NativeCliRow[] = [];
  for (const row of value.clis) {
    if (!record(row) || !isNativeProviderId(row.id) || seen.has(row.id) || !record(row.supports)
      || typeof row.runnable !== "boolean" || typeof row.readOnlySupport !== "boolean"
      || ![true, false, null].includes(row.authenticated as boolean | null)
      || !(row.path === null || text(row.path, 2048)) || !(row.version === null || text(row.version, 256))
      || typeof row.permissionNote !== "string" || row.permissionNote.length > 2048
      || !Array.isArray(row.models) || row.models.length > 256) throw new RuntimeProtocolError("Invalid runtime CLI inventory");
    const models = row.models.map(model => {
      if (!record(model) || !text(model.id, 256) || model.name !== undefined && !text(model.name, 256)
        || model.description !== undefined && (typeof model.description !== "string" || model.description.length > 2048)) throw new RuntimeProtocolError("Invalid runtime model inventory");
      return { id: model.id as string, ...(model.name !== undefined ? { name: model.name as string } : {}), ...(model.description !== undefined ? { description: model.description as string } : {}) };
    });
    if (Object.values(row.supports).some(v => typeof v !== "boolean")) throw new RuntimeProtocolError("Invalid runtime capabilities");
    if (row.reason !== undefined && (typeof row.reason !== "string" || row.reason.length > 1024)) throw new RuntimeProtocolError("Invalid runtime CLI inventory");
    const supports = Object.fromEntries(SUPPORT_KEYS.filter(key => Object.hasOwn(row.supports as object, key)).map(key => [key, (row.supports as Record<string, boolean>)[key]]));
    const entry: NativeCliRow = { id: row.id, path: row.path as string | null, version: row.version as string | null, authenticated: row.authenticated as boolean | null, runnable: row.runnable, supports: supports as NativeCliRow["supports"],
      readOnlySupport: row.readOnlySupport, permissionNote: row.permissionNote, models,
      ...(row.reason !== undefined ? { reason: row.reason as string } : {}),
      ...((MODEL_SOURCES as readonly unknown[]).includes(row.modelsSource) ? { modelsSource: row.modelsSource as NativeCliRow["modelsSource"] } : {}) };
    seen.add(row.id); clis.push(entry);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > RUNTIME_MAX_FRAME_BYTES / 2) throw new RuntimeProtocolError("Runtime inventory is too large");
  if (value.probedAt !== undefined && value.probedAt !== null && (typeof value.probedAt !== "number" || !Number.isFinite(value.probedAt))) throw new RuntimeProtocolError("Invalid runtime inventory");
  const probe: WindowsCliProbe = { clis, home: value.home, ...(value.probedAt !== undefined ? { probedAt: value.probedAt as number | null } : {} as { probedAt: null }),
    ...(typeof value.hostname === "string" && value.hostname.trim() && value.hostname.length <= 255 && !/[\x00-\x1f\x7f]/.test(value.hostname) ? { hostname: value.hostname.trim() } : {}) };
  const field = (error: unknown): string => /^Invalid (?:credential profile report|account identity): [A-Za-z ,.]{1,48}$/.test(String((error as Error)?.message)) ? String((error as Error).message).replace(/^Invalid (?:credential profile report|account identity): /, "") : "invalid";
  if (value.credentialProfiles !== undefined) {
    try { probe.credentialProfiles = parseCredentialProfileReport(value.credentialProfiles); } catch (error) { throw new RuntimeProtocolError(`Invalid runtime credential profiles (${field(error)})`); }
  }
  const identities = new Map((value.clis as Array<Record<string, unknown>>).map(row => [row.id as string, row.identity]));
  for (const row of probe.clis) {
    const identity = identities.get(row.id);
    if (identity === undefined) continue;
    if (row.id !== "claude-code" || row.authenticated !== true) throw new RuntimeProtocolError("Invalid runtime CLI identity (only a signed-in Claude Code has one)");
    try { row.identity = parseAccountIdentity(identity); } catch (error) { throw new RuntimeProtocolError(`Invalid runtime CLI identity (${field(error)})`); }
  }
  return probe;
}
function machineView(machine: RuntimeMachine): RuntimeMachine {
  return { ...structuredClone(machine), runtimeCompatibility: machine.runtimeInfo
    ? machine.runtimeInfo.protocolVersions.includes(RUNTIME_PROTOCOL_VERSION) ? "compatible" : "incompatible"
    : machine.bootId ? "legacy" : "unknown" };
}
interface MachineRecord { machine: RuntimeMachine; credentialHash?: string; claimHash?: string; claimExpiresAt?: number }
interface PairRecord { id: string; codeHash: string; expiresAt: number }
interface CommandRecord {
  id: string; machineId: string; operation: RuntimeOperation; digest: string; payload: unknown;
  createdAt: number; state: "pending" | "accepted" | "failed" | "uncertain";
  task?: WindowsCliTask; seq: number; result?: unknown; error?: string;
}
/** A compacted settled command: enough to keep refusing its id (replay protection) without its payload or task. */
interface CommandTombstone { id: string; machineId: string; digest: string; at: number }
interface State { version: 1; machines: MachineRecord[]; pairings: PairRecord[]; commands: CommandRecord[]; tombstones?: CommandTombstone[] }
/**
 * M-2239 P2-1 (#2936 review): the journal is compacted, never just capped. A settled command (failed, or accepted with a
 * terminal, process-confirmed outcome) older than COMMAND_KEEP_MS, or the oldest settled ones beyond COMMAND_SOFT_CAP,
 * become tombstones; pending and uncertain commands are never compacted. Tombstones are evicted only beyond
 * TOMBSTONE_CAP and only when older than TOMBSTONE_KEEP_MS — a replayed id is refused for at least that long.
 */
const COMMAND_HARD_CAP = 4096, COMMAND_SOFT_CAP = 2048, COMMAND_KEEP_MS = 7 * 24 * 3_600_000;
const TOMBSTONE_CAP = 65_536, TOMBSTONE_KEEP_MS = 30 * 24 * 3_600_000;
interface Connection { ws: WebSocket; machineId: string; generation: number; bootId?: string; ready: boolean; alive: boolean; helloTimer: NodeJS.Timeout }
/**
 * alpha.2 polish: what an interrupted command becomes. A probe only reads the runner's CLI inventory — nothing to reconcile
 * if its answer was lost — so it settles as failed (compacted like any settled command); every other operation stays
 * uncertain (never compacted, never sent again). The automatic probe on connect must not leave a trail in the journal.
 */
const interrupted = (command: { operation: RuntimeOperation }): "failed" | "uncertain" => command.operation === "probe" ? "failed" : "uncertain";
interface Pending { machineId: string; generation: number; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
export interface RuntimeCoordinatorEvent { type: "machine" | "task" | "pane"; machineId: string; task?: WindowsCliTask; pane?: RuntimePaneSnapshot }
export interface RuntimeCoordinatorOptions {
  changed?(event?: RuntimeCoordinatorEvent): void;
  handlePaneMcp?(machineId: string, body: PaneMcpBody, current: () => boolean): Promise<unknown>;
  handleMcp?(machineId: string, runId: string, body: unknown): Promise<unknown>;
  /** Injectable clock for pairing expiry and offline tests. */
  now?(): number;
  requestTimeoutMs?: number;
  /** Called when AgEnD itself closes a runtime connection with a policy code, so the cause reaches the daemon log. */
  warn?(fields: { machineId: string; code: number; reason: string; detail?: string }, message: string): void;
}
export type { RuntimeMachine } from "./runtime-protocol.js";

export class RuntimeCoordinator {
  private readonly paneEpoch = randomUUID();
  private readonly path: string;
  private state: State;
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: RUNTIME_MAX_FRAME_BYTES, perMessageDeflate: false });
  private readonly connections = new Map<string, Connection>();
  private readonly pending = new Map<string, Pending>();
  private readonly paneToolPending = new Set<string>();
  private readonly panePending = new Map<string, Pending>();
  /** #3190 Part 3: remote account / CLI-install calls. Memory only, never the journal (see callAccount). */
  private readonly accountPending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: RuntimeCoordinatorEvent) => void>();
  private readonly limits = new Map<string, { count: number; until: number }>();
  private readonly heartbeat: NodeJS.Timeout;
  private closed = false;
  constructor(home: string, private readonly options: RuntimeCoordinatorOptions = {}) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.path = join(home, "runtime-machines.json");
    if (existsSync(this.path)) {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE_BYTES) throw Error("Invalid runtime machine store file");
    }
    this.state = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : { version: 1, machines: [], pairings: [], commands: [] };
    if (this.state.version !== 1 || !Array.isArray(this.state.machines) || !Array.isArray(this.state.pairings) || !Array.isArray(this.state.commands)
      || this.state.tombstones !== undefined && !Array.isArray(this.state.tombstones)) throw Error("Invalid runtime machine store");
    this.state.tombstones ??= [];
    if (this.state.machines.length > 256 || this.state.pairings.length > 16 || this.state.commands.length > COMMAND_HARD_CAP || this.state.tombstones.length > TOMBSTONE_CAP
      || this.state.tombstones.some(row => !record(row) || !text(row.id, 128) || !UUID.test(String(row.machineId)) || !/^[a-f0-9]{64}$/.test(row.digest) || !Number.isFinite(row.at))
      || this.state.machines.some(row => !record(row) || !record(row.machine) || !UUID.test(String(row.machine.id)) || !text(row.machine.name, 100)
        || row.machine.platform !== "win32" || !["pending", "offline", "online", "revoked"].includes(String(row.machine.status))
        || !Number.isSafeInteger(row.machine.generation) || row.machine.generation < 0
        || row.machine.pairingFingerprint !== undefined && (typeof row.machine.pairingFingerprint !== "string" || !/^[A-F0-9]{4}(?:-[A-F0-9]{4}){2}$/.test(row.machine.pairingFingerprint))
        || row.credentialHash !== undefined && !/^[a-f0-9]{64}$/.test(row.credentialHash)
        || row.claimHash !== undefined && !/^[a-f0-9]{64}$/.test(row.claimHash))
      || new Set(this.state.machines.map(row => row.machine.id)).size !== this.state.machines.length
      || this.state.pairings.some(row => !record(row) || !UUID.test(String(row.id)) || !/^[a-f0-9]{64}$/.test(row.codeHash) || !Number.isFinite(row.expiresAt))
      || this.state.commands.some(row => !record(row) || !text(row.id, 128) || !UUID.test(String(row.machineId)) || !/^[a-f0-9]{64}$/.test(row.digest)
        || !["probe", "workspace", "run", "cancel", "reconcile", "recover"].includes(row.operation)
        || !["pending", "accepted", "failed", "uncertain"].includes(row.state) || !Number.isSafeInteger(row.seq) || row.seq < 0)) throw Error("Malformed runtime machine store");
    // A coordinator restart never grants execution authority or redelivers an in-flight command.
    for (const row of this.state.machines) {
      if (row.machine.status === "online") row.machine.status = "offline";
      if (row.claimHash) row.machine.pairingFingerprint = runtimeFingerprintFromHash(row.claimHash);
    }
    for (const command of this.state.commands) if (command.state === "pending") command.state = interrupted(command);
    for (const row of this.state.machines) if (row.machine.runtimeInfo !== undefined) row.machine.runtimeInfo = parseRuntimeInfo(row.machine.runtimeInfo);
    this.save();
    this.heartbeat = setInterval(() => {
      for (const connection of this.connections.values()) {
        if (!connection.alive) { connection.ws.terminate(); continue; }
        connection.alive = false; connection.ws.ping();
      }
    }, 15_000);
    this.heartbeat.unref();
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private save(): void {
    const value = JSON.stringify(this.state);
    if (Buffer.byteLength(value) > MAX_STORE_BYTES) throw Error("Runtime machine journal limit reached");
    for (let attempt = 0; ; attempt++) {
      try { atomicWriteFileSync(this.path, value, { mode: 0o600 }); return; }
      catch (error) {
        // Windows scanners can briefly hold a destination open; retain atomic replacement and a bounded retry.
        if (process.platform !== "win32" || attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
      }
    }
  }
  private emit(event: RuntimeCoordinatorEvent): void {
    try { this.options.changed?.(event); } catch { /* UI observers cannot change the durable verdict. */ }
    for (const listener of this.listeners) { try { listener(structuredClone(event)); } catch { /* Observer isolation. */ } }
  }
  private entry(id: string): MachineRecord { const row = this.state.machines.find(v => v.machine.id === id); if (!row) throw Error("Runtime machine not found"); return row; }
  listMachines(): RuntimeMachine[] { return this.state.machines.map(row => machineView(row.machine)); }
  machine(id: string): RuntimeMachine | null { const row = this.state.machines.find(v => v.machine.id === id); return row ? machineView(row.machine) : null; }
  subscribe(listener: (event: RuntimeCoordinatorEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  createPairing(): RuntimePairing {
    this.state.pairings = this.state.pairings.filter(row => row.expiresAt > this.now());
    if (this.state.pairings.length >= 16) throw Error("Too many pending runtime pairing codes");
    const code = randomBytes(6).toString("hex").toUpperCase(), pairingId = randomUUID(), expiresAt = this.now() + PAIR_TTL;
    this.state.pairings.push({ id: pairingId, codeHash: hash(code), expiresAt }); this.save();
    return { pairingId, code: code.match(/.{4}/g)!.join("-"), expiresAt };
  }
  pair(input: unknown): RuntimePairResult {
    if (!record(input) || Object.keys(input).some(k => !["code", "name", "platform", "hostname"].includes(k))
      || !text(input.code, 32) || !text(input.name, 100) || !input.name.trim() || input.platform !== "win32"
      || input.hostname !== undefined && !text(input.hostname, 255)) throw Error("Invalid runtime pairing request");
    if (this.state.machines.length >= 256 || this.state.machines.filter(row => row.machine.status !== "revoked").length >= 64) throw Error("Runtime machine limit reached");
    const code = input.code.replaceAll("-", "").toUpperCase();
    const pairing = this.state.pairings.find(row => row.expiresAt > this.now() && equal(code, row.codeHash));
    if (!pairing) throw Error("Pairing code is invalid, used or expired");
    const machineId = randomUUID(), claimSecret = secret();
    this.state.pairings = this.state.pairings.filter(row => row !== pairing);
    this.state.machines.push({ machine: { id: machineId, name: input.name.trim(), platform: "win32", ...(input.hostname ? { hostname: input.hostname as string } : {}), status: "pending", createdAt: this.now(), generation: 0, pairingFingerprint: runtimeFingerprintFromHash(hash(claimSecret)) }, claimHash: hash(claimSecret), claimExpiresAt: pairing.expiresAt });
    this.save(); this.emit({ type: "machine", machineId });
    return { machineId, claimSecret, status: "pending", expiresAt: pairing.expiresAt };
  }
  claim(input: unknown): RuntimeClaimResult {
    if (!record(input) || Object.keys(input).some(k => !["machineId", "claimSecret"].includes(k)) || !text(input.machineId, 64) || !text(input.claimSecret, 128)) throw Error("Invalid runtime claim");
    const row = this.state.machines.find(row => row.machine.id === input.machineId);
    if (!row?.claimHash || !row.claimExpiresAt || row.claimExpiresAt <= this.now() || !equal(input.claimSecret, row.claimHash) || row.machine.status === "revoked") throw Error("Runtime claim is invalid or expired");
    if (!row.machine.approvedAt) return { status: "pending" };
    const credential = secret(); row.credentialHash = hash(credential); delete row.claimHash; delete row.claimExpiresAt; this.save();
    return { machineId: row.machine.id, credential, status: "approved" };
  }
  approve(id: string, fingerprint: unknown): RuntimeMachine {
    const row = this.entry(id);
    if (row.machine.status !== "pending" || !row.claimExpiresAt || row.claimExpiresAt <= this.now()) throw Error("Runtime pairing is no longer pending");
    if (!fingerprint || fingerprint !== row.machine.pairingFingerprint) throw Error("Compare the pairing fingerprint shown by this Runtime before approving");
    row.machine.approvedAt = this.now(); row.machine.status = "offline"; this.save(); this.emit({ type: "machine", machineId: id }); return structuredClone(row.machine);
  }
  rename(id: string, name: unknown): RuntimeMachine {
    if (!text(name, 100) || !name.trim()) throw Error("Invalid runtime machine name");
    const row = this.entry(id); row.machine.name = name.trim(); this.save(); this.emit({ type: "machine", machineId: id }); return structuredClone(row.machine);
  }
  revoke(id: string): RuntimeMachine {
    const row = this.entry(id); row.machine.status = "revoked"; delete row.credentialHash; delete row.claimHash; delete row.claimExpiresAt;
    this.save(); const connection = this.connections.get(id); if (connection) { this.connections.delete(id); this.rejectPending(connection, "Runtime machine was revoked"); this.options.warn?.({ machineId: id, code: 1008, reason: "Machine revoked" }, "Runtime connection closed because the machine was revoked"); connection.ws.close(1008, "Machine revoked"); }
    this.emit({ type: "machine", machineId: id }); return structuredClone(row.machine);
  }
  private credentialOwner(auth: unknown): MachineRecord | undefined {
    if (typeof auth !== "string" || !/^Bearer [a-f0-9]{64}$/i.test(auth)) return;
    return this.state.machines.find(row => row.credentialHash && row.machine.status !== "revoked" && row.machine.approvedAt && equal(auth.slice(7), row.credentialHash));
  }
  /** Valid capabilities never share the invalid-traffic bucket of a loopback proxy. Forwarding headers are untrusted. */
  private rate(key: string, limit: number): boolean {
    const now = this.now();
    for (const [id, value] of this.limits) if (value.until <= now) this.limits.delete(id);
    if (!this.limits.has(key) && this.limits.size >= 512) {
      const invalid = [...this.limits.keys()].find(id => id.startsWith("invalid:"));
      if (!invalid || key.startsWith("invalid:")) return false;
      this.limits.delete(invalid);
    }
    const old = this.limits.get(key), row = old && old.until > now ? old : { count: 0, until: now + 60_000 };
    this.limits.set(key, row); return ++row.count <= limit;
  }
  private requestRateKey(path: string, input: unknown, req: IncomingMessage): string {
    if (path === RUNTIME_ROTATE_PATH) {
      const row = this.credentialOwner(req.headers.authorization);
      if (row) return `rotate:${row.machine.id}`;
    } else if (record(input)) {
      if (path === RUNTIME_PAIR_PATH && text(input.code, 32)) {
        const code = input.code.replaceAll("-", "").toUpperCase();
        const row = this.state.pairings.find(row => row.expiresAt > this.now() && equal(code, row.codeHash));
        if (row) return `pair:${row.id}`;
      }
      if (path === RUNTIME_CLAIM_PATH && text(input.claimSecret, 128)) {
        const row = this.state.machines.find(row => row.machine.id === input.machineId && row.claimHash && row.claimExpiresAt! > this.now()
          && row.machine.status !== "revoked" && equal(input.claimSecret as string, row.claimHash));
        if (row) return `claim:${row.machine.id}`;
      }
    }
    return `invalid:${req.socket.remoteAddress ?? "unknown"}`;
  }
  rotateCredential(auth: unknown, input: unknown): { machineId: string; status: "rotated" } {
    const row = this.credentialOwner(auth);
    if (!row || !record(input) || Object.keys(input).some(key => !["machineId", "credential"].includes(key))
      || input.machineId !== row.machine.id || typeof input.credential !== "string" || !/^[a-f0-9]{64}$/.test(input.credential)) throw Error("Invalid runtime credential rotation");
    if (!equal(input.credential, row.credentialHash!)) {
      const before = { credentialHash: row.credentialHash, status: row.machine.status };
      row.credentialHash = hash(input.credential); row.machine.status = "offline";
      try { this.save(); } catch (error) { row.credentialHash = before.credentialHash; row.machine.status = before.status; throw error; }
      const connection = this.connections.get(row.machine.id);
      if (connection) { this.connections.delete(row.machine.id); this.rejectPending(connection, "Runtime credential rotated; reconnect to reconcile"); connection.ws.close(1012, "Credential rotated"); }
      this.emit({ type: "machine", machineId: row.machine.id });
    }
    return { machineId: row.machine.id, status: "rotated" };
  }
  handlePublicRequest(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (![RUNTIME_PAIR_PATH, RUNTIME_CLAIM_PATH, RUNTIME_ROTATE_PATH].includes(url.pathname)) return false;
    const answer = (status: number, body: unknown) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); } };
    if (this.closed || req.method !== "POST" || url.search || !privateTransport(req)) { answer(403, { error: "Runtime pairing requires a protected non-browser connection" }); return true; }
    let charged = false;
    void readBoundedWebBody(req, 4096).then(bytes => {
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (this.closed) { answer(403, { error: "Runtime coordinator is closed" }); return; }
      const key = this.requestRateKey(url.pathname, value, req);
      charged = true;
      if (!this.rate(key, key.startsWith("claim:") ? 120 : 30)) { answer(429, { error: "Too many runtime pairing requests" }); return; }
      if (url.pathname === RUNTIME_ROTATE_PATH) {
        if (!this.credentialOwner(req.headers.authorization)) { answer(401, { error: "Runtime credential was refused" }); return; }
        answer(200, this.rotateCredential(req.headers.authorization, value)); return;
      }
      if (url.pathname === RUNTIME_PAIR_PATH) answer(201, this.pair(value));
      else { const result = this.claim(value); answer(result.status === "pending" ? 202 : 200, result); }
    }).catch(() => {
      const allowed = charged || this.rate(`invalid:${req.socket.remoteAddress ?? "unknown"}`, 30);
      answer(allowed ? 400 : 429, { error: "Runtime pairing request is invalid, expired or already used" });
    });
    return true;
  }
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    let url: URL; try { url = new URL(req.url ?? "", "http://localhost"); } catch { return false; }
    if (url.pathname !== RUNTIME_CONNECT_PATH) return false;
    const refuse = () => { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); };
    const auth = req.headers.authorization;
    if (this.closed || req.method !== "GET" || url.search || !privateTransport(req) || typeof auth !== "string" || !/^Bearer [a-f0-9]{64}$/i.test(auth)) { refuse(); return true; }
    const row = this.credentialOwner(auth);
    if (!row) { refuse(); return true; }
    this.server.handleUpgrade(req, socket, head, ws => this.attach(ws, row)); return true;
  }
  private current(connection: Connection): boolean { return !this.closed && this.connections.get(connection.machineId) === connection && this.entry(connection.machineId).machine.status !== "revoked"; }
  private attach(ws: WebSocket, row: MachineRecord): void {
    const old = this.connections.get(row.machine.id);
    if (old) { this.rejectPending(old, "Runtime connection was replaced; execution must be reconciled"); this.options.warn?.({ machineId: row.machine.id, code: 1008, reason: "Connection replaced" }, "Runtime connection closed because the same machine credential connected again"); old.ws.close(1008, "Connection replaced"); }
    row.machine.generation++; row.machine.status = "offline"; this.save();
    const connection: Connection = { ws, machineId: row.machine.id, generation: row.machine.generation, ready: false, alive: true, helloTimer: setTimeout(() => ws.close(1008, "Runtime hello required"), 10_000) };
    connection.helloTimer.unref(); this.connections.set(row.machine.id, connection);
    ws.on("pong", () => { connection.alive = true; if (this.current(connection)) row.machine.lastSeenAt = this.now(); });
    ws.on("message", (data, binary) => { if (binary) { ws.close(1008, "Runtime requires JSON text frames"); return; } void this.message(connection, data).catch(error => {
      // The cause (a static validation message) goes to the log and, trimmed, to the runtime so its terminal can show it.
      const reason = error instanceof RuntimeProtocolError ? `Invalid runtime message: ${error.message}`.replace(/[^ -~]/g, "?").slice(0, 120) : "Invalid runtime message";
      this.options.warn?.({ machineId: connection.machineId, code: 1008, reason, detail: error instanceof Error ? error.message : String(error) }, "Runtime connection closed because of an invalid runtime message"); ws.close(1008, reason);
    }); });
    ws.on("error", () => { /* close owns disconnect handling */ });
    ws.on("close", () => {
      clearTimeout(connection.helloTimer);
      if (this.connections.get(row.machine.id) !== connection) return;
      this.connections.delete(row.machine.id); this.rejectPending(connection, "Runtime disconnected; reconcile before retrying");
      if (row.machine.status !== "revoked") row.machine.status = "offline";
      this.save(); this.emit({ type: "machine", machineId: row.machine.id });
    });
  }
  private send(connection: Connection, value: RuntimeServerMessage): void {
    if (!this.current(connection) || connection.ws.readyState !== WebSocket.OPEN) throw Error("Runtime machine is offline");
    const frame = JSON.stringify(value);
    if (Buffer.byteLength(frame) > RUNTIME_MAX_FRAME_BYTES) throw Error("Runtime response exceeds the frame limit");
    if (connection.ws.bufferedAmount > RUNTIME_MAX_FRAME_BYTES * 2) { connection.ws.close(1013, "Runtime backpressure"); throw Error("Runtime connection is too slow"); }
    connection.ws.send(frame);
  }
  private rejectPending(connection: Connection, reason: string): void {
    for (const [id, pending] of this.panePending) if (pending.machineId === connection.machineId && pending.generation === connection.generation) {
      this.panePending.delete(id); clearTimeout(pending.timer); pending.reject(Error(reason));
    }
    for (const [id, pending] of this.accountPending) if (pending.machineId === connection.machineId && pending.generation === connection.generation) {
      this.accountPending.delete(id); clearTimeout(pending.timer); pending.reject(Error(reason));
    }
    let changed = false;
    for (const [id, pending] of this.pending) if (pending.machineId === connection.machineId && pending.generation === connection.generation) {
      this.pending.delete(id); clearTimeout(pending.timer);
      const command = this.state.commands.find(row => row.id === id); if (command?.state === "pending") { command.state = interrupted(command); command.error = reason; changed = true; }
      pending.reject(Error(reason));
    }
    if (changed) this.save();
  }
  private validateTask(command: CommandRecord, value: unknown): WindowsCliTask {
    if (command.operation !== "run" || !record(command.payload) || !record(command.payload.task) || !record(value)) throw new RuntimeProtocolError("Unexpected runtime task");
    const input = command.payload.task;
    if (value.id !== input.requestId || value.cli !== input.cli || value.cwd !== input.cwd || value.sandbox !== input.sandbox || (value.model ?? "") !== (input.model ?? "")
      || !["starting", "running", "cancelling", "completed", "failed", "cancelled"].includes(String(value.status))
      || typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt) || typeof value.output !== "string" || value.output.length > 64 * 1024
      || value.finishedAt !== undefined && (typeof value.finishedAt !== "number" || !Number.isFinite(value.finishedAt))
      || ["completed", "failed", "cancelled"].includes(String(value.status)) && (typeof value.finishedAt !== "number" || typeof value.outcomeConfirmed !== "boolean")
      || value.error !== undefined && (typeof value.error !== "string" || value.error.length > 8192)
      || value.threadId !== undefined && !text(value.threadId, 256)
      || value.threadId !== undefined && command.payload.resumeSessionId !== undefined && value.threadId !== command.payload.resumeSessionId
      || value.outcomeConfirmed !== undefined && typeof value.outcomeConfirmed !== "boolean") throw new RuntimeProtocolError("Invalid runtime task snapshot");
    return { id: value.id as string, cli: value.cli as WindowsCliTask["cli"], cwd: value.cwd as string, sandbox: value.sandbox as WindowsCliTask["sandbox"], ...(value.model ? { model: value.model as string } : {}),
      status: value.status as WindowsCliTask["status"], startedAt: value.startedAt, output: value.output,
      ...(value.finishedAt !== undefined ? { finishedAt: value.finishedAt as number } : {}), ...(value.error ? { error: value.error as string } : {}), ...(value.threadId ? { threadId: value.threadId as string } : {}), ...(value.outcomeConfirmed !== undefined ? { outcomeConfirmed: value.outcomeConfirmed as boolean } : {}) };
  }
  private async message(connection: Connection, raw: RawData): Promise<void> {
    if (!this.current(connection)) return;
    const value: unknown = JSON.parse(raw.toString());
    if (!record(value) || value.v !== 1 || !text(value.type, 32)) throw new RuntimeProtocolError("Invalid runtime frame");
    const row = this.entry(connection.machineId); connection.alive = true;
    if (!connection.ready) {
      if (value.type !== "hello" || !text(value.bootId, 128)) throw new RuntimeProtocolError("Runtime hello required");
      const runtimeInfo = parseRuntimeInfo(value.runtimeInfo);
      connection.ready = true; connection.bootId = value.bootId; clearTimeout(connection.helloTimer);
      row.machine.bootId = value.bootId; row.machine.status = "online"; row.machine.lastSeenAt = this.now();
      if (runtimeInfo) row.machine.runtimeInfo = runtimeInfo; else delete row.machine.runtimeInfo;
      if (value.paneProtocol === 1) row.machine.paneProtocol = 1; else delete row.machine.paneProtocol;
      if (value.inventory !== undefined) { row.machine.inventory = inventory(value.inventory); row.machine.inventoryUpdatedAt = this.now(); }
      this.save(); this.send(connection, { v: 1, type: "welcome", machineId: connection.machineId, generation: connection.generation }); this.emit({ type: "machine", machineId: connection.machineId });
      // alpha.2 polish (dev-claude's no-chat e2e): a runner that brings no CLI inventory (just paired, nothing detected
      // yet) is asked for its own report now — its detection runs on that PC, never on this fleet's loop — so the first
      // approval of an agent's request there is not refused for "no available CLI" until someone presses Refresh.
      // (#3004 rig: the runner's hello may carry a placeholder — `probedAt: null`, no CLIs — which is no report either.)
      // (#3005 rig recheck: `force` — without it the runner answers with its cached inventory, on a fresh profile the same
      // placeholder; Refresh sends force, and so does this: detection runs on that PC.)
      if (!inventoryProbed(row.machine.inventory)) void this.call(connection.machineId, "probe", { force: true }).catch(() => { /* Refresh, or the next connect, asks again */ });
      return;
    }
    row.machine.lastSeenAt = this.now();
    if (value.type === "pane.tool.request") {
      if (row.machine.paneProtocol !== 1 || Object.keys(value).some(key => !["v", "type", "id", "body"].includes(key)) || !UUID.test(String(value.id))) throw new RuntimeProtocolError("Invalid pane MCP transport request");
      const body = validatePaneMcpBody(value.body), id = value.id as string;
      const key = `${connection.machineId}:${connection.generation}:${id}`;
      if (this.paneToolPending.size >= 128 || this.paneToolPending.has(key)) throw new RuntimeProtocolError("Pane MCP transport backlog or duplicate request");
      let active = true;
      const current = (): boolean => active && !this.closed && this.current(connection) && connection.ready && connection.ws.readyState === WebSocket.OPEN;
      this.paneToolPending.add(key);
      let timer: NodeJS.Timeout | undefined;
      try {
        if (!current() || !this.options.handlePaneMcp) throw new RuntimeProtocolError("Pane MCP scope unavailable");
        const result = await Promise.race([this.options.handlePaneMcp(connection.machineId, body, current), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { active = false; reject(Error("Pane MCP deadline")); }, 80_000); timer.unref();
        })]);
        if (current()) this.send(connection, { v: 1, type: "pane.tool.result", id, ok: true, result });
      } catch { if (current()) this.send(connection, { v: 1, type: "pane.tool.result", id, ok: false }); }
      finally { active = false; clearTimeout(timer); this.paneToolPending.delete(key); }
      return;
    }
    if (value.type === "pane.output") {
      if (row.machine.paneProtocol !== 1) throw new RuntimeProtocolError("Pane protocol was not negotiated");
      const snapshot = validateRuntimePaneSnapshot(value.snapshot);
      this.emit({ type: "pane", machineId: connection.machineId, pane: snapshot });
      return;
    }
    if (value.type === "pane.response") {
      if (row.machine.paneProtocol !== 1 || !UUID.test(String(value.id)) || typeof value.ok !== "boolean") throw new RuntimeProtocolError("Invalid pane transport response");
      const pending = this.panePending.get(value.id as string);
      if (!pending) return; // A late reply proves nothing and never replays a command.
      if (pending.machineId !== connection.machineId || pending.generation !== connection.generation) throw new RuntimeProtocolError("Pane response belongs to another connection");
      this.panePending.delete(value.id as string); clearTimeout(pending.timer);
      if (value.ok) pending.resolve(value.result);
      else pending.reject(Error(typeof value.error === "string" ? value.error.slice(0, 1000) : "Pane operation failed"));
      return;
    }
    if (value.type === "account.response") {
      if (!UUID.test(String(value.id)) || typeof value.ok !== "boolean") throw new RuntimeProtocolError("Invalid account transport response");
      const pending = this.accountPending.get(value.id as string);
      if (!pending) return; // A late reply proves nothing and is never replayed.
      if (pending.machineId !== connection.machineId || pending.generation !== connection.generation) throw new RuntimeProtocolError("Account response belongs to another connection");
      this.accountPending.delete(value.id as string); clearTimeout(pending.timer);
      // Nothing of the result or the error is logged or stored here; the error is shown to the administrator who asked, in a fixed length and without control characters.
      if (value.ok) pending.resolve(value.result);
      else pending.reject(Error(typeof value.error === "string" ? value.error.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 400) : "The operation failed on that computer"));
      return;
    }
    if (value.type === "inventory") { row.machine.inventory = inventory(value.inventory); row.machine.inventoryUpdatedAt = this.now(); this.save(); this.emit({ type: "machine", machineId: connection.machineId }); return; }
    if (value.type === "task") {
      if (!record(value.task) || !Number.isSafeInteger(value.seq) || (value.seq as number) < 1) throw new RuntimeProtocolError("Invalid runtime task event");
      const taskValue = value.task;
      const command = this.state.commands.find(command => command.id === taskValue.id && command.machineId === connection.machineId && command.operation === "run");
      if (!command) {
        // #2945 review: a reconnecting runtime republishes what it retained; a run already settled and compacted here
        // is acknowledged by its tombstone and changes nothing. An unknown id, or another machine's, still closes.
        if (this.tombstoned(connection.machineId, taskValue.id)) return;
        throw new RuntimeProtocolError("Runtime task does not belong to this machine");
      }
      const task = this.validateTask(command, value.task);
      if ((value.seq as number) <= command.seq) return;
      if (command.task && terminal(command.task) && !terminal(task)) throw new RuntimeProtocolError("Runtime task cannot restart");
      command.seq = value.seq as number; command.task = task; command.state = "accepted"; this.save(); this.emit({ type: "task", machineId: connection.machineId, task }); return;
    }
    if (value.type === "response") {
      if (!text(value.id, 128) || typeof value.ok !== "boolean") throw new RuntimeProtocolError("Invalid runtime response");
      const pending = this.pending.get(value.id), command = this.state.commands.find(command => command.id === value.id);
      if (!command || command.machineId !== connection.machineId) {
        if (!command && this.tombstoned(connection.machineId, value.id)) return;
        throw new RuntimeProtocolError("Runtime response does not belong to this machine");
      }
      if (!pending || pending.generation !== connection.generation) return;
      this.pending.delete(value.id); clearTimeout(pending.timer);
      try {
        if (!value.ok) { command.state = "failed"; command.error = typeof value.error === "string" ? value.error.slice(0, 1024) : "Runtime request failed"; this.save(); pending.reject(Error(command.error)); return; }
        let result = value.result;
        if (command.operation === "probe") { result = inventory(result); row.machine.inventory = result as WindowsCliProbe; row.machine.inventoryUpdatedAt = this.now(); }
        if (command.operation === "run") { const task = this.validateTask(command, result); if (!command.task || !terminal(command.task)) command.task = task; result = command.task; }
        command.state = "accepted"; command.result = result; this.save();
        if (command.task) this.emit({ type: "task", machineId: connection.machineId, task: command.task });
        else if (command.operation === "probe") this.emit({ type: "machine", machineId: connection.machineId });
        pending.resolve(structuredClone(result));
      } catch (error) { command.state = "uncertain"; this.save(); pending.reject(error instanceof Error ? error : Error("Invalid runtime response")); throw error; }
      return;
    }
    if (value.type === "tool.call") {
      if (!text(value.id, 128) || !text(value.runId, 128)) throw new RuntimeProtocolError("Invalid runtime tool call");
      const command = this.state.commands.find(command => command.id === value.runId && command.machineId === connection.machineId && command.operation === "run");
      try {
        if (!command || !record(command.payload) || !record(command.payload.mcp) || command.task && terminal(command.task) || !this.options.handleMcp) throw new RuntimeProtocolError("Runtime tool call has no active turn");
        const body = value.body;
        if (!record(body) || Object.keys(body).some(key => !["op", "method", "params", "callId"].includes(key))
          || body.op !== "native-mcp" || !record(body.params) || Buffer.byteLength(JSON.stringify(body)) > 64 * 1024) throw new RuntimeProtocolError("Invalid runtime MCP request");
        if (body.method === "tools/list") {
          if (Object.keys(body.params).length || body.callId !== undefined) throw new RuntimeProtocolError("Invalid runtime MCP listing");
        } else if (body.method === "tools/call") {
          if (!text(body.callId, 128) || !/^[A-Za-z0-9._:-]+$/.test(body.callId)
            || Object.keys(body.params).some(key => !["name", "arguments"].includes(key)) || typeof body.params.name !== "string"
            || !Array.isArray(command.payload.mcp.tools) || !command.payload.mcp.tools.includes(body.params.name)
            || body.params.arguments !== undefined && !record(body.params.arguments)) throw new RuntimeProtocolError("Runtime MCP tool is outside this turn");
          stable(body.params);
        } else throw new RuntimeProtocolError("Invalid runtime MCP operation");
        const result = await this.options.handleMcp(connection.machineId, value.runId, body);
        if (!this.current(connection)) return;
        this.send(connection, { v: 1, type: "tool.result", id: value.id, ok: true, result });
      } catch { if (this.current(connection)) this.send(connection, { v: 1, type: "tool.result", id: value.id, ok: false, error: "Runtime tool call was refused or its turn expired" }); }
      return;
    }
    throw new RuntimeProtocolError("Unknown runtime message");
  }
  private tombstoned(machineId: string, id: unknown): boolean {
    return typeof id === "string" && this.state.tombstones!.some(row => row.id === id && row.machineId === machineId);
  }
  /** M-2239 P2-1: settled commands to tombstones (see COMMAND_KEEP_MS); never a pending, uncertain or unconfirmed one. */
  private compact(): void {
    const now = this.now();
    const settled = (command: CommandRecord): boolean => !this.pending.has(command.id) && (command.state === "failed"
      || command.state === "accepted" && (command.operation !== "run" || !!command.task && terminal(command.task) && command.task.outcomeConfirmed === true));
    const drop = new Set(this.state.commands.filter(command => settled(command) && now - command.createdAt > COMMAND_KEEP_MS));
    const excess = this.state.commands.length - drop.size - COMMAND_SOFT_CAP;
    if (excess > 0) for (const command of this.state.commands.filter(command => settled(command) && !drop.has(command)).sort((a, b) => a.createdAt - b.createdAt).slice(0, excess)) drop.add(command);
    if (!drop.size) return;
    // Room for new tombstones without passing TOMBSTONE_CAP (what the constructor reads back, #2945 review): old ones
    // past TOMBSTONE_KEEP_MS give way, oldest first; a younger one never does. Commands beyond that room stay as they
    // are — still refused by id from the journal — until room frees up.
    const tombstones = this.state.tombstones!;
    const evictable = tombstones.filter(row => now - row.at > TOMBSTONE_KEEP_MS).sort((a, b) => a.at - b.at);
    const room = TOMBSTONE_CAP - tombstones.length + evictable.length;
    const moved = [...drop].sort((a, b) => a.createdAt - b.createdAt).slice(0, Math.max(0, room));
    if (!moved.length) return;
    const gone = new Set(evictable.slice(0, Math.max(0, tombstones.length + moved.length - TOMBSTONE_CAP)));
    const movedSet = new Set(moved);
    this.state.tombstones = [...tombstones.filter(row => !gone.has(row)),
      ...moved.map(command => ({ id: command.id, machineId: command.machineId, digest: command.digest, at: now }))];
    this.state.commands = this.state.commands.filter(command => !movedSet.has(command));
    this.save();
  }
  task(id: string): WindowsCliTask | null { const task = this.state.commands.find(command => command.id === id && command.operation === "run")?.task; return task ? structuredClone(task) : null; }
  tasks(): Array<{ machineId: string; task: WindowsCliTask }> { return this.state.commands.flatMap(command => command.operation === "run" && command.task ? [{ machineId: command.machineId, task: structuredClone(command.task) }] : []); }
  /** Include journaled sends whose acknowledgement is still missing, so reopening diagnostics cannot hide an uncertain run. */
  diagnosticTasks(machineId: string): WindowsCliTask[] {
    return this.state.commands.flatMap(command => {
      if (command.operation !== "run" || command.machineId !== machineId) return [];
      if (command.task) return [structuredClone(command.task)];
      let input: NativeTaskInput;
      try { input = validateNativeTask((command.payload as RuntimeRunPayload).task); } catch { return []; }
      const uncertain = command.state === "uncertain", rejected = command.state === "failed";
      return [{ id: command.id, cli: input.cli, cwd: input.cwd, sandbox: input.sandbox, ...(input.model ? { model: input.model } : {}),
        startedAt: command.createdAt, status: uncertain || rejected ? "failed" as const : "starting" as const, output: "",
        ...(rejected ? { outcomeConfirmed: true, error: command.error || "Runtime request failed" } : {}),
        ...(uncertain ? { outcomeConfirmed: false, error: "Remote execution outcome is unconfirmed. Reconnect this runtime to reconcile before sending another task." } : {}) }];
    }).sort((a, b) => b.startedAt - a.startedAt).slice(0, 20);
  }
  hasActiveTask(machineId: string): boolean { return this.state.commands.some(command => command.machineId === machineId && command.operation === "run" && command.state !== "failed" && (!command.task || !terminal(command.task) || command.task.outcomeConfirmed === false)); }
  paneTransportEpoch(machineId: string): string | null {
    const connection = this.connections.get(machineId);
    return connection?.ready && connection.ws.readyState === WebSocket.OPEN && this.current(connection) ? `${this.paneEpoch}:${machineId}:${connection.generation}` : null;
  }
  /** Pane input replay/sequence authority lives in its pane ledger; reads never fill the exec-task journal. */
  async callPane(machineId: string, raw: RuntimePaneRequest, maxAgents = 4): Promise<unknown> {
    const request = validateRuntimePaneRequest(raw);
    if (!Number.isInteger(maxAgents) || maxAgents < 1 || maxAgents > 16) throw Error("Invalid machine pane limit");
    const machine = this.entry(machineId).machine, connection = this.connections.get(machineId);
    if (this.closed || machine.status !== "online" || machine.paneProtocol !== 1 || !connection?.ready || !this.current(connection)) throw Error("Pane runtime is offline or unsupported");
    if (this.panePending.size >= 64) throw Error("Pane transport capacity reached");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.panePending.delete(id); reject(Error("Pane response timed out; reconcile before another input")); }, this.options.requestTimeoutMs ?? 30_000);
      timer.unref();
      this.panePending.set(id, { machineId, generation: connection.generation, resolve, reject, timer });
      try { this.send(connection, { v: 1, type: "pane.request", id, maxAgents, request }); }
      catch (error) { this.panePending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  /**
   * #3190 Part 3: one request to a paired computer's account / CLI-install operations, in an `account.request` frame answered by an `account.response`.
   * Deliberately NOT `call`: `call` writes the request and its answer to the journal on disk, and a sign-in link or one-time code must never be there.
   * This keeps the pending call in memory only, never calls `save()`, never logs the payload or the result, never replays: a lost answer is lost,
   * and the person asks again. The payload is checked here in its closed form, and the Runtime must have reported the matching capability.
   */
  async callAccount<K extends RuntimeRemoteOperation>(machineId: string, operation: K, payload: RuntimeRemotePayloads[K], timeoutMs = this.options.requestTimeoutMs ?? 30_000): Promise<unknown> {
    if (!isRuntimeRemoteOperation(operation)) throw Error("Unsupported runtime operation");
    const input = parseRuntimeRemotePayload(operation, payload);
    const machine = this.entry(machineId).machine, connection = this.connections.get(machineId);
    if (this.closed || machine.status !== "online" || !connection?.ready || !this.current(connection)) throw Error("Runtime machine is offline");
    const needed = operation === "cli.install" ? "cli-install" : "remote-signin";
    if (!machine.runtimeInfo?.capabilities.includes(needed)) throw Error("Update the Runtime on that computer to use this; it does not offer it yet");
    if (this.accountPending.size >= 16) throw Error("Too many account operations are waiting; try again shortly");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 15 * 60_000) throw Error("Invalid account operation timeout");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.accountPending.delete(id); reject(Error("That computer did not answer in time")); }, timeoutMs);
      timer.unref();
      this.accountPending.set(id, { machineId, generation: connection.generation, resolve, reject, timer });
      try { this.send(connection, { v: 1, type: "account.request", id, operation, payload: input }); }
      catch (error) { this.accountPending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  /** Explicit switch-off only, after owned pane closes. A normal hub close/restart never shuts its hosts down. */
  async shutdownPaneHosts(): Promise<void> {
    const machines = this.listMachines().filter(machine => machine.status === "online" && machine.paneProtocol === 1);
    const outcomes = await Promise.allSettled(machines.map(async machine => {
      const raw = await this.callPane(machine.id, { action: "list" }) as { hostBootId?: unknown; panes?: unknown };
      if (!raw || typeof raw.hostBootId !== "string" || !/^[a-f0-9-]{36}$/i.test(raw.hostBootId) || !Array.isArray(raw.panes) || raw.panes.length > 4096) throw Error("Pane shutdown inventory is unconfirmed");
      if (raw.panes.map(validateRuntimePaneSnapshot).some(pane => pane.state !== "exited")) throw Error("Pane shutdown still has live or unconfirmed work");
      validateRuntimePaneShutdown(await this.callPane(machine.id, { action: "shutdown", hostBootId: raw.hostBootId }), raw.hostBootId);
    }));
    if (outcomes.some(result => result.status === "rejected")) throw Error("One or more pane hosts could not confirm empty shutdown; retained work stays reserved");
  }
  async call(machineId: string, operation: RuntimeOperation, payload: unknown): Promise<unknown> {
    if (this.closed || !["probe", "workspace", "run", "cancel", "reconcile", "recover"].includes(operation)) throw Error("Unsupported runtime operation");
    const machine = this.entry(machineId).machine;
    const connection = this.connections.get(machineId);
    if (machine.status !== "online" || !connection?.ready || !this.current(connection)) throw Error("Runtime machine is offline");
    let id = randomUUID(), normalized = payload;
    if (operation === "run") {
      if (!record(payload) || Object.keys(payload).some(k => !["task", "resumeSessionId", "context", "mcp", "credentialProfile"].includes(k))) throw Error("Invalid runtime run payload");
      const task = validateNativeTask(payload.task);
      if (payload.credentialProfile !== undefined) { assertCredentialProfileName(payload.credentialProfile); assertCredentialProfileCli(task.cli); }
      if (payload.resumeSessionId !== undefined && !text(payload.resumeSessionId, 256) || payload.context !== undefined && (typeof payload.context !== "string" || payload.context.length > 2000 || payload.context.includes("\0"))) throw Error("Invalid runtime turn context");
      if (payload.mcp !== undefined && (!record(payload.mcp) || Object.keys(payload.mcp).some(k => k !== "tools") || !Array.isArray(payload.mcp.tools) || !payload.mcp.tools.length || payload.mcp.tools.length > 128 || payload.mcp.tools.some(v => typeof v !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(v)))) throw Error("Invalid runtime tool scope");
      normalized = { ...payload, task } satisfies RuntimeRunPayload; id = task.requestId as typeof id;
    }
    if (operation === "recover") {
      if (!record(payload) || Object.keys(payload).some(key => !["runId", "confirmedStopped"].includes(key))
        || !text(payload.runId, 80) || payload.confirmedStopped !== true) throw Error("Runtime recovery requires explicit stopped-process confirmation");
      const original = this.state.commands.find(command => command.id === payload.runId && command.machineId === machineId && command.operation === "run");
      if (!original) throw Error("Runtime recovery does not belong to this machine");
      // A runtime that never received the original request can still save a no-execution tombstone after manual
      // confirmation. The original is server-owned; callers cannot replace it with another task or tool scope.
      normalized = { runId: payload.runId, confirmedStopped: true, original: structuredClone(original.payload) };
    }
    const digest = hash(stable({ operation, payload: normalized }));
    if (Buffer.byteLength(JSON.stringify(normalized)) > RUNTIME_MAX_FRAME_BYTES / 2) throw Error("Runtime command payload is too large");
    const existing = this.state.commands.find(command => command.id === id);
    if (existing) {
      if (existing.machineId !== machineId || existing.digest !== digest) throw Error("Runtime task ID belongs to a different request or machine");
      if (existing.task) return structuredClone(existing.task);
      throw Error("Runtime command is already recorded; reconcile it before retrying");
    }
    const tombstone = this.state.tombstones!.find(row => row.id === id);
    if (tombstone) {
      if (tombstone.machineId !== machineId || tombstone.digest !== digest) throw Error("Runtime task ID belongs to a different request or machine");
      throw Error("Runtime command already ran and its record was compacted; do not retry it");
    }
    if (operation === "run" && this.hasActiveTask(machineId)) throw Error("Runtime machine is busy or has an unconfirmed task");
    this.compact();
    if (this.state.commands.length >= COMMAND_HARD_CAP) throw Error("Runtime command journal limit reached: too many unsettled commands; reconcile them");
    const command: CommandRecord = { id, machineId, operation, digest, payload: normalized, createdAt: this.now(), state: "pending", seq: 0 };
    // Journal is committed before the first byte reaches the execution computer. Never auto-send it again.
    this.state.commands.push(command); this.save();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); command.state = interrupted(command); command.error = command.state === "failed" ? "Runtime inventory request timed out" : "Runtime acknowledgment timed out; reconcile before retrying"; this.save(); reject(Error(command.error));
      }, this.options.requestTimeoutMs ?? (operation === "probe" ? 90_000 : 30_000)); timer.unref();
      this.pending.set(id, { machineId, generation: connection.generation, resolve, reject, timer });
      try { this.send(connection, { v: 1, type: "request", id, operation, payload: normalized }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); command.state = interrupted(command); this.save(); reject(error); }
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; clearInterval(this.heartbeat);
    for (const connection of this.connections.values()) { clearTimeout(connection.helloTimer); this.rejectPending(connection, "Runtime coordinator stopped; reconcile before retrying"); connection.ws.terminate(); }
    this.connections.clear();
    for (const row of this.state.machines) if (row.machine.status === "online") row.machine.status = "offline";
    this.save(); this.server.close(); this.listeners.clear();
  }
}
