/** Durable machine registration and outbound-client transport; never starts a remote shell. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { readBoundedWebBody } from "./web-body.js";
import { atomicWriteFileSync } from "./atomic-write.js";
import { validateNativeTask } from "./windows-cli-worker.js";
import type { WindowsCliProbe, WindowsCliTask } from "./windows-cli.js";
import { isNativeProviderId } from "./windows-cli-providers.js";
import { RUNTIME_CLAIM_PATH, RUNTIME_CONNECT_PATH, RUNTIME_MAX_FRAME_BYTES, RUNTIME_PAIR_PATH,
  type RuntimeMachine, type RuntimeOperation, type RuntimePairing, type RuntimePairResult, type RuntimeClaimResult,
  type RuntimeRunPayload, type RuntimeServerMessage } from "./runtime-protocol.js";

const PAIR_TTL = 10 * 60_000;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const secret = () => randomBytes(32).toString("hex");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const equal = (value: string, digest: string) => /^[a-f0-9]{64}$/i.test(digest) && timingSafeEqual(Buffer.from(hash(value), "hex"), Buffer.from(digest, "hex"));
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
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
function inventory(value: unknown): WindowsCliProbe {
  if (!record(value) || typeof value.home !== "string" || value.home.length > 1024 || !Array.isArray(value.clis) || value.clis.length > 16) throw Error("Invalid runtime inventory");
  const seen = new Set<string>();
  for (const row of value.clis) {
    if (!record(row) || !isNativeProviderId(row.id) || seen.has(row.id) || !record(row.supports)
      || typeof row.runnable !== "boolean" || typeof row.readOnlySupport !== "boolean"
      || ![true, false, null].includes(row.authenticated as boolean | null)
      || !(row.path === null || text(row.path, 2048)) || !(row.version === null || text(row.version, 256))
      || typeof row.permissionNote !== "string" || row.permissionNote.length > 2048
      || !Array.isArray(row.models) || row.models.length > 256) throw Error("Invalid runtime CLI inventory");
    for (const model of row.models) if (!record(model) || !text(model.id, 256) || model.name !== undefined && !text(model.name, 256)
      || model.description !== undefined && (typeof model.description !== "string" || model.description.length > 2048)) throw Error("Invalid runtime model inventory");
    if (Object.values(row.supports).some(v => typeof v !== "boolean")) throw Error("Invalid runtime capabilities");
    seen.add(row.id);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > RUNTIME_MAX_FRAME_BYTES / 2) throw Error("Runtime inventory is too large");
  return structuredClone(value) as unknown as WindowsCliProbe;
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
interface Pending { machineId: string; generation: number; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
export interface RuntimeCoordinatorEvent { type: "machine" | "task"; machineId: string; task?: WindowsCliTask }
export interface RuntimeCoordinatorOptions {
  changed?(event?: RuntimeCoordinatorEvent): void;
  handleMcp?(machineId: string, runId: string, body: unknown): Promise<unknown>;
  /** Injectable clock for pairing expiry and offline tests. */
  now?(): number;
  requestTimeoutMs?: number;
}
export type { RuntimeMachine } from "./runtime-protocol.js";

export class RuntimeCoordinator {
  private readonly path: string;
  private state: State;
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: RUNTIME_MAX_FRAME_BYTES, perMessageDeflate: false });
  private readonly connections = new Map<string, Connection>();
  private readonly pending = new Map<string, Pending>();
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
        || row.credentialHash !== undefined && !/^[a-f0-9]{64}$/.test(row.credentialHash)
        || row.claimHash !== undefined && !/^[a-f0-9]{64}$/.test(row.claimHash))
      || new Set(this.state.machines.map(row => row.machine.id)).size !== this.state.machines.length
      || this.state.pairings.some(row => !record(row) || !UUID.test(String(row.id)) || !/^[a-f0-9]{64}$/.test(row.codeHash) || !Number.isFinite(row.expiresAt))
      || this.state.commands.some(row => !record(row) || !text(row.id, 128) || !UUID.test(String(row.machineId)) || !/^[a-f0-9]{64}$/.test(row.digest)
        || !["probe", "workspace", "run", "cancel", "reconcile", "recover"].includes(row.operation)
        || !["pending", "accepted", "failed", "uncertain"].includes(row.state) || !Number.isSafeInteger(row.seq) || row.seq < 0)) throw Error("Malformed runtime machine store");
    // A coordinator restart never grants execution authority or redelivers an in-flight command.
    for (const row of this.state.machines) if (row.machine.status === "online") row.machine.status = "offline";
    for (const command of this.state.commands) if (command.state === "pending") command.state = "uncertain";
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
  listMachines(): RuntimeMachine[] { return this.state.machines.map(row => structuredClone(row.machine)); }
  machine(id: string): RuntimeMachine | null { const row = this.state.machines.find(v => v.machine.id === id); return row ? structuredClone(row.machine) : null; }
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
    this.state.machines.push({ machine: { id: machineId, name: input.name.trim(), platform: "win32", ...(input.hostname ? { hostname: input.hostname as string } : {}), status: "pending", createdAt: this.now(), generation: 0 }, claimHash: hash(claimSecret), claimExpiresAt: pairing.expiresAt });
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
  approve(id: string): RuntimeMachine {
    const row = this.entry(id);
    if (row.machine.status !== "pending" || !row.claimExpiresAt || row.claimExpiresAt <= this.now()) throw Error("Runtime pairing is no longer pending");
    row.machine.approvedAt = this.now(); row.machine.status = "offline"; this.save(); this.emit({ type: "machine", machineId: id }); return structuredClone(row.machine);
  }
  rename(id: string, name: unknown): RuntimeMachine {
    if (!text(name, 100) || !name.trim()) throw Error("Invalid runtime machine name");
    const row = this.entry(id); row.machine.name = name.trim(); this.save(); this.emit({ type: "machine", machineId: id }); return structuredClone(row.machine);
  }
  revoke(id: string): RuntimeMachine {
    const row = this.entry(id); row.machine.status = "revoked"; delete row.credentialHash; delete row.claimHash; delete row.claimExpiresAt;
    this.save(); const connection = this.connections.get(id); if (connection) { this.connections.delete(id); this.rejectPending(connection, "Runtime machine was revoked"); connection.ws.close(1008, "Machine revoked"); }
    this.emit({ type: "machine", machineId: id }); return structuredClone(row.machine);
  }
  private rate(req: IncomingMessage, claim = false): boolean {
    const key = `${claim ? "claim" : "pair"}:${req.socket.remoteAddress ?? "unknown"}`, now = this.now();
    if (this.limits.size > 512) for (const [key, value] of this.limits) if (value.until < now) this.limits.delete(key);
    const old = this.limits.get(key), row = old && old.until > now ? old : { count: 0, until: now + 60_000 };
    this.limits.set(key, row); return ++row.count <= (claim ? 120 : 30);
  }
  handlePublicRequest(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (![RUNTIME_PAIR_PATH, RUNTIME_CLAIM_PATH].includes(url.pathname)) return false;
    const answer = (status: number, body: unknown) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); } };
    if (this.closed || req.method !== "POST" || url.search || !privateTransport(req)) { answer(403, { error: "Runtime pairing requires a protected non-browser connection" }); return true; }
    if (!this.rate(req, url.pathname === RUNTIME_CLAIM_PATH)) { answer(429, { error: "Too many runtime pairing requests" }); return true; }
    void readBoundedWebBody(req, 4096).then(bytes => {
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (url.pathname === RUNTIME_PAIR_PATH) answer(201, this.pair(value));
      else { const result = this.claim(value); answer(result.status === "pending" ? 202 : 200, result); }
    }).catch(() => answer(400, { error: "Runtime pairing request is invalid, expired or already used" }));
    return true;
  }
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    let url: URL; try { url = new URL(req.url ?? "", "http://localhost"); } catch { return false; }
    if (url.pathname !== RUNTIME_CONNECT_PATH) return false;
    const refuse = () => { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); };
    const auth = req.headers.authorization;
    if (this.closed || req.method !== "GET" || url.search || !privateTransport(req) || typeof auth !== "string" || !/^Bearer [a-f0-9]{64}$/i.test(auth)) { refuse(); return true; }
    const credential = auth.slice(7), row = this.state.machines.find(row => row.credentialHash && row.machine.status !== "revoked" && row.machine.approvedAt && equal(credential, row.credentialHash));
    if (!row) { refuse(); return true; }
    this.server.handleUpgrade(req, socket, head, ws => this.attach(ws, row)); return true;
  }
  private current(connection: Connection): boolean { return !this.closed && this.connections.get(connection.machineId) === connection && this.entry(connection.machineId).machine.status !== "revoked"; }
  private attach(ws: WebSocket, row: MachineRecord): void {
    const old = this.connections.get(row.machine.id);
    if (old) { this.rejectPending(old, "Runtime connection was replaced; execution must be reconciled"); old.ws.close(1008, "Connection replaced"); }
    row.machine.generation++; row.machine.status = "offline"; this.save();
    const connection: Connection = { ws, machineId: row.machine.id, generation: row.machine.generation, ready: false, alive: true, helloTimer: setTimeout(() => ws.close(1008, "Runtime hello required"), 10_000) };
    connection.helloTimer.unref(); this.connections.set(row.machine.id, connection);
    ws.on("pong", () => { connection.alive = true; if (this.current(connection)) row.machine.lastSeenAt = this.now(); });
    ws.on("message", (data, binary) => { if (binary) { ws.close(1008, "Runtime requires JSON text frames"); return; } void this.message(connection, data).catch(() => ws.close(1008, "Invalid runtime message")); });
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
    let changed = false;
    for (const [id, pending] of this.pending) if (pending.machineId === connection.machineId && pending.generation === connection.generation) {
      this.pending.delete(id); clearTimeout(pending.timer);
      const command = this.state.commands.find(row => row.id === id); if (command?.state === "pending") { command.state = "uncertain"; command.error = reason; changed = true; }
      pending.reject(Error(reason));
    }
    if (changed) this.save();
  }
  private validateTask(command: CommandRecord, value: unknown): WindowsCliTask {
    if (command.operation !== "run" || !record(command.payload) || !record(command.payload.task) || !record(value)) throw Error("Unexpected runtime task");
    const input = command.payload.task;
    if (value.id !== input.requestId || value.cli !== input.cli || value.cwd !== input.cwd || value.sandbox !== input.sandbox || (value.model ?? "") !== (input.model ?? "")
      || !["starting", "running", "cancelling", "completed", "failed", "cancelled"].includes(String(value.status))
      || typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt) || typeof value.output !== "string" || value.output.length > 64 * 1024
      || value.finishedAt !== undefined && (typeof value.finishedAt !== "number" || !Number.isFinite(value.finishedAt))
      || ["completed", "failed", "cancelled"].includes(String(value.status)) && (typeof value.finishedAt !== "number" || typeof value.outcomeConfirmed !== "boolean")
      || value.error !== undefined && (typeof value.error !== "string" || value.error.length > 8192)
      || value.threadId !== undefined && !text(value.threadId, 256)
      || value.threadId !== undefined && command.payload.resumeSessionId !== undefined && value.threadId !== command.payload.resumeSessionId
      || value.outcomeConfirmed !== undefined && typeof value.outcomeConfirmed !== "boolean") throw Error("Invalid runtime task snapshot");
    return { id: value.id as string, cli: value.cli as WindowsCliTask["cli"], cwd: value.cwd as string, sandbox: value.sandbox as WindowsCliTask["sandbox"], ...(value.model ? { model: value.model as string } : {}),
      status: value.status as WindowsCliTask["status"], startedAt: value.startedAt, output: value.output,
      ...(value.finishedAt !== undefined ? { finishedAt: value.finishedAt as number } : {}), ...(value.error ? { error: value.error as string } : {}), ...(value.threadId ? { threadId: value.threadId as string } : {}), ...(value.outcomeConfirmed !== undefined ? { outcomeConfirmed: value.outcomeConfirmed as boolean } : {}) };
  }
  private async message(connection: Connection, raw: RawData): Promise<void> {
    if (!this.current(connection)) return;
    const value: unknown = JSON.parse(raw.toString());
    if (!record(value) || value.v !== 1 || !text(value.type, 32)) throw Error("Invalid runtime frame");
    const row = this.entry(connection.machineId); connection.alive = true;
    if (!connection.ready) {
      if (value.type !== "hello" || !text(value.bootId, 128)) throw Error("Runtime hello required");
      connection.ready = true; connection.bootId = value.bootId; clearTimeout(connection.helloTimer);
      row.machine.bootId = value.bootId; row.machine.status = "online"; row.machine.lastSeenAt = this.now();
      if (value.inventory !== undefined) { row.machine.inventory = inventory(value.inventory); row.machine.inventoryUpdatedAt = this.now(); }
      this.save(); this.send(connection, { v: 1, type: "welcome", machineId: connection.machineId, generation: connection.generation }); this.emit({ type: "machine", machineId: connection.machineId }); return;
    }
    row.machine.lastSeenAt = this.now();
    if (value.type === "inventory") { row.machine.inventory = inventory(value.inventory); row.machine.inventoryUpdatedAt = this.now(); this.save(); this.emit({ type: "machine", machineId: connection.machineId }); return; }
    if (value.type === "task") {
      if (!record(value.task) || !Number.isSafeInteger(value.seq) || (value.seq as number) < 1) throw Error("Invalid runtime task event");
      const taskValue = value.task;
      const command = this.state.commands.find(command => command.id === taskValue.id && command.machineId === connection.machineId && command.operation === "run");
      if (!command) throw Error("Runtime task does not belong to this machine");
      const task = this.validateTask(command, value.task);
      if ((value.seq as number) <= command.seq) return;
      if (command.task && terminal(command.task) && !terminal(task)) throw Error("Runtime task cannot restart");
      command.seq = value.seq as number; command.task = task; command.state = "accepted"; this.save(); this.emit({ type: "task", machineId: connection.machineId, task }); return;
    }
    if (value.type === "response") {
      if (!text(value.id, 128) || typeof value.ok !== "boolean") throw Error("Invalid runtime response");
      const pending = this.pending.get(value.id), command = this.state.commands.find(command => command.id === value.id);
      if (!command || command.machineId !== connection.machineId) throw Error("Runtime response does not belong to this machine");
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
      if (!text(value.id, 128) || !text(value.runId, 128)) throw Error("Invalid runtime tool call");
      const command = this.state.commands.find(command => command.id === value.runId && command.machineId === connection.machineId && command.operation === "run");
      try {
        if (!command || !record(command.payload) || !record(command.payload.mcp) || command.task && terminal(command.task) || !this.options.handleMcp) throw Error("Runtime tool call has no active turn");
        const body = value.body;
        if (!record(body) || Object.keys(body).some(key => !["op", "method", "params", "callId"].includes(key))
          || body.op !== "native-mcp" || !record(body.params) || Buffer.byteLength(JSON.stringify(body)) > 64 * 1024) throw Error("Invalid runtime MCP request");
        if (body.method === "tools/list") {
          if (Object.keys(body.params).length || body.callId !== undefined) throw Error("Invalid runtime MCP listing");
        } else if (body.method === "tools/call") {
          if (!text(body.callId, 128) || !/^[A-Za-z0-9._:-]+$/.test(body.callId)
            || Object.keys(body.params).some(key => !["name", "arguments"].includes(key)) || typeof body.params.name !== "string"
            || !Array.isArray(command.payload.mcp.tools) || !command.payload.mcp.tools.includes(body.params.name)
            || body.params.arguments !== undefined && !record(body.params.arguments)) throw Error("Runtime MCP tool is outside this turn");
          stable(body.params);
        } else throw Error("Invalid runtime MCP operation");
        const result = await this.options.handleMcp(connection.machineId, value.runId, body);
        if (!this.current(connection)) return;
        this.send(connection, { v: 1, type: "tool.result", id: value.id, ok: true, result });
      } catch { if (this.current(connection)) this.send(connection, { v: 1, type: "tool.result", id: value.id, ok: false, error: "Runtime tool call was refused or its turn expired" }); }
      return;
    }
    throw Error("Unknown runtime message");
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
    const tombstones = this.state.tombstones!;
    for (const command of drop) tombstones.push({ id: command.id, machineId: command.machineId, digest: command.digest, at: now });
    this.state.commands = this.state.commands.filter(command => !drop.has(command));
    if (tombstones.length > TOMBSTONE_CAP) {
      // Oldest first, and only those past TOMBSTONE_KEEP_MS: a younger tombstone is never given up for space.
      const evictable = tombstones.filter(row => now - row.at > TOMBSTONE_KEEP_MS).sort((a, b) => a.at - b.at).slice(0, tombstones.length - TOMBSTONE_CAP);
      const gone = new Set(evictable);
      this.state.tombstones = tombstones.filter(row => !gone.has(row));
    }
    this.save();
  }
  task(id: string): WindowsCliTask | null { const task = this.state.commands.find(command => command.id === id && command.operation === "run")?.task; return task ? structuredClone(task) : null; }
  tasks(): Array<{ machineId: string; task: WindowsCliTask }> { return this.state.commands.flatMap(command => command.operation === "run" && command.task ? [{ machineId: command.machineId, task: structuredClone(command.task) }] : []); }
  hasActiveTask(machineId: string): boolean { return this.state.commands.some(command => command.machineId === machineId && command.operation === "run" && command.state !== "failed" && (!command.task || !terminal(command.task) || command.task.outcomeConfirmed === false)); }
  async call(machineId: string, operation: RuntimeOperation, payload: unknown): Promise<unknown> {
    if (this.closed || !["probe", "workspace", "run", "cancel", "reconcile", "recover"].includes(operation)) throw Error("Unsupported runtime operation");
    const machine = this.entry(machineId).machine;
    const connection = this.connections.get(machineId);
    if (machine.status !== "online" || !connection?.ready || !this.current(connection)) throw Error("Runtime machine is offline");
    let id = randomUUID(), normalized = payload;
    if (operation === "run") {
      if (!record(payload) || Object.keys(payload).some(k => !["task", "resumeSessionId", "context", "mcp"].includes(k))) throw Error("Invalid runtime run payload");
      const task = validateNativeTask(payload.task);
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
        this.pending.delete(id); command.state = "uncertain"; command.error = "Runtime acknowledgment timed out; reconcile before retrying"; this.save(); reject(Error(command.error));
      }, this.options.requestTimeoutMs ?? (operation === "probe" ? 90_000 : 30_000)); timer.unref();
      this.pending.set(id, { machineId, generation: connection.generation, resolve, reject, timer });
      try { this.send(connection, { v: 1, type: "request", id, operation, payload: normalized }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); command.state = "uncertain"; this.save(); reject(error); }
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
