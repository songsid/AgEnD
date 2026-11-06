/** Private, bounded state for a standalone runtime. Input prompts and provider login credentials have no journal fields. */
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { WindowsCliTask } from "./windows-cli.js";
import { atomicWriteFileSync } from "./atomic-write.js";
import { assertCredentialProfileName, validCredentialProfileName } from "./runtime-credential-profiles.js";

const MAX_JOBS = 128;
/**
 * M-2239 P2-1 (#2936 review): `used` is the replay tombstone (id → digest) — it was capped at 4096 and never pruned, so
 * a long-lived runtime stopped. It now holds up to MAX_IDS, and beyond that the oldest tombstones older than
 * ID_KEEP_MS (and with no job snapshot) give way; a younger one never does, so a replay is refused for at least that.
 */
const MAX_IDS = 65_536;
const ID_KEEP_MS = 30 * 24 * 3_600_000;
/** Kept free below MAX_STORE_BYTES when a job is accepted: its own later updates (≤ 64 KiB characters of output, UTF-8). */
const BYTE_HEADROOM = 512 * 1024;
const MAX_STORE_BYTES = 12 * 1024 * 1024;
const ID = /^[A-Za-z0-9-]{16,80}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export interface RuntimeCredentials { server: string; machineId: string; credential: string; name: string; pendingCredential?: string }
export interface RuntimeStoredJob { digest: string; seq: number; task: WindowsCliTask; uncertain: boolean }
interface Ledger { version: 1; jobs: Record<string, RuntimeStoredJob>; used: Record<string, string>; usedAt?: Record<string, number>; /** Machine these jobs were run for; a job of another pairing is unknown to this server and would be rejected. */ machineId?: string }

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function runtimeJobDigest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function privateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Runtime state must be a private real directory");
}
function readPrivate(path: string): unknown {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_STORE_BYTES) throw new Error("Invalid runtime state file");
  return JSON.parse(readFileSync(path, "utf8"));
}
function atomic(path: string, value: unknown): void {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_STORE_BYTES) throw new Error("Runtime state limit reached");
  for (let attempt = 0; ; attempt++) {
    try { atomicWriteFileSync(path, text, { mode: 0o600 }); return; }
    catch (error) {
      if (process.platform !== "win32" || attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
    }
  }
}
export function validateRuntimeServer(value: string): URL {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!["https:", ...(local ? ["http:"] : [])].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname !== "/") throw new Error("Runtime server must be an HTTPS origin (HTTP is allowed only on loopback)");
  return url;
}
export class RuntimeClientStore {
  private readonly file: string;
  private data: Ledger;
  constructor(readonly directory: string, private readonly now: () => number = Date.now) {
    privateDirectory(directory); this.file = join(directory, "jobs.json");
    this.data = existsSync(this.file) ? this.validate(readPrivate(this.file)) : { version: 1, jobs: {}, used: {} };
  }
  private unsettled(): boolean { return this.blocked() || Object.values(this.data.jobs).some(job => job.task.outcomeConfirmed === false); }
  private ledgerConflict(tail: string): Error {
    return new Error(`This profile (${this.directory}) still has an active or unconfirmed execution recorded for a different AgEnD pairing, and AgEnD would reject it. Check that no CLI process from it is left running, then delete jobs.json in that folder. ${tail}`);
  }
  /** Run before a pairing code is spent: a one-time credential must never be issued into a profile that cannot take it. */
  assertCanPair(): void { if (this.unsettled()) throw this.ledgerConflict("Nothing was paired and your pairing code is still unused; run connect-agend.bat again before the code expires."); }
  /**
   * The ledger is replayed to AgEnD on every connect, and AgEnD closes the connection for a job it did not issue to this machine, so jobs are
   * tied to the machine they ran for. Called after acquiring the profile lock, before recoverInterrupted. When the profile now belongs to a
   * different machine than the ledger's owner, settled jobs of the old pairing are dropped; an unsettled one is never discarded silently.
   * A ledger with no recorded owner (older profile) cannot be attributed to anyone: when connecting it is left exactly as it is (and unstamped,
   * unless it is empty), because stamping it would claim another server's jobs as this one's. Only a brand-new pairing (`pairing: true`) proves
   * every earlier job belongs to some other machine, so that clears an ownerless ledger too.
   */
  adoptMachine(machineId: string, pairing = false): void {
    const owner = this.data.machineId;
    if (owner === machineId) return;
    if (owner === undefined && !pairing && (Object.keys(this.data.jobs).length || Object.keys(this.data.used).length)) return;
    if (owner !== undefined || pairing) {
      if (this.unsettled()) throw this.ledgerConflict("No new pairing code is needed; connect again afterwards.");
      this.data.jobs = {}; this.data.used = {}; delete this.data.usedAt;
    }
    this.data.machineId = machineId; this.save();
  }
  /** Called only after acquiring the profile lock: reading status must not interrupt a live runtime. */
  recoverInterrupted(): void {
    let changed = false;
    for (const job of Object.values(this.data.jobs)) {
      if (!job.task.finishedAt || job.task.outcomeConfirmed === false) {
        job.uncertain = true; job.seq++;
        job.task = { ...job.task, status: "failed", finishedAt: this.now(), outcomeConfirmed: false,
          error: "Runtime restarted before execution was confirmed stopped. Verify its processes before recovery; this job will not be replayed." };
        changed = true;
      }
    }
    if (changed) this.save();
  }
  private validate(raw: unknown): Ledger {
    if (!object(raw) || raw.version !== 1 || !object(raw.jobs) || !object(raw.used)
      || Object.keys(raw.jobs).length > MAX_JOBS || Object.keys(raw.used).length > MAX_IDS) throw new Error("Invalid runtime job ledger");
    for (const [id, digest] of Object.entries(raw.used)) if (!ID.test(id) || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid runtime job identity");
    if (raw.machineId !== undefined && (typeof raw.machineId !== "string" || !UUID.test(raw.machineId))) throw new Error("Invalid runtime job ledger owner");
    if (raw.usedAt !== undefined && (!object(raw.usedAt) || Object.entries(raw.usedAt).some(([id, at]) => !Object.hasOwn(raw.used as object, id) || typeof at !== "number" || !Number.isFinite(at)))) throw new Error("Invalid runtime job identity times");
    for (const [id, value] of Object.entries(raw.jobs)) {
      if (!ID.test(id) || !object(value) || !Number.isSafeInteger(value.seq) || (value.seq as number) < 1
        || typeof value.uncertain !== "boolean" || !object(value.task) || value.task.id !== id || value.digest !== raw.used[id]
        || typeof value.task.output !== "string" || value.task.output.length > 65_536) throw new Error("Invalid runtime job snapshot");
    }
    return raw as unknown as Ledger;
  }
  private save(): void { atomic(this.file, this.data); }
  /**
   * #2945 review: the byte budget, not only the id count. Before a new job is saved the ledger must fit MAX_STORE_BYTES
   * with BYTE_HEADROOM left for that job's own updates (its output is bounded at 64 KiB characters). Room comes first
   * from settled job snapshots (finished, confirmed — never the new one, an uncertain or an unfinished one), oldest
   * first; then from replay ids past ID_KEEP_MS with no snapshot. False when even that does not make room.
   */
  private fitBytes(newId: string): boolean {
    const budget = MAX_STORE_BYTES - BYTE_HEADROOM, actual = () => Buffer.byteLength(JSON.stringify(this.data));
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    // Each removal subtracts what that member actually occupied (key, colon, value, comma; a usedAt member only when it
    // exists). The estimate only paces the loop: whenever it says "fits", the real size is measured and, if still over,
    // eviction goes on from the remaining candidates (#2945 R2: legacy ids without usedAt were over-counted).
    let size = actual();
    const fitted = (): boolean => { if (size > budget) return false; size = actual(); return size <= budget; };
    if (fitted()) return true;
    const jobs = Object.values(this.data.jobs).filter(row => row.task.id !== newId && row.task.finishedAt && !row.uncertain && row.task.outcomeConfirmed !== false)
      .sort((a, b) => a.task.startedAt - b.task.startedAt);
    for (const row of jobs) {
      size -= bytes(row.task.id) + 1 + bytes(row) + 1;
      delete this.data.jobs[row.task.id];
      if (fitted()) return true;
    }
    const now = this.now(), at = this.data.usedAt ?? {};
    const old = Object.keys(this.data.used).filter(id => !this.data.jobs[id] && now - (at[id] ?? 0) > ID_KEEP_MS).sort((a, b) => (at[a] ?? 0) - (at[b] ?? 0));
    for (const id of old) {
      size -= bytes(id) + 1 + bytes(this.data.used[id]) + 1 + (Object.hasOwn(at, id) ? bytes(id) + 1 + bytes(at[id]) + 1 : 0);
      delete this.data.used[id]; delete at[id];
      if (fitted()) return true;
    }
    return actual() <= budget;
  }
  /** Oldest first; only past ID_KEEP_MS and with no job snapshot. An id from an older ledger (no time) counts as oldest. */
  private evictTombstones(): void {
    const now = this.now(), at = this.data.usedAt ?? {};
    const old = Object.keys(this.data.used).filter(id => !this.data.jobs[id] && now - (at[id] ?? 0) > ID_KEEP_MS)
      .sort((a, b) => (at[a] ?? 0) - (at[b] ?? 0));
    for (const id of old.slice(0, Object.keys(this.data.used).length - MAX_IDS + 1)) { delete this.data.used[id]; delete at[id]; }
  }
  get(id: string): RuntimeStoredJob | null { const row = this.data.jobs[id]; return row ? structuredClone(row) : null; }
  list(): RuntimeStoredJob[] { return Object.values(this.data.jobs).map(job => structuredClone(job)); }
  blocked(): boolean { return Object.values(this.data.jobs).some(job => job.uncertain || !job.task.finishedAt); }
  accept(task: WindowsCliTask, digest: string): { duplicate: boolean; job: RuntimeStoredJob } {
    if (!ID.test(task.id) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid runtime job");
    const known = this.data.used[task.id];
    if (known !== undefined) {
      if (known !== digest) throw new Error("Execution ID belongs to different arguments");
      const old = this.get(task.id); if (!old) throw new Error("Execution ID was already used and its snapshot expired; do not retry");
      return { duplicate: true, job: old };
    }
    if (this.blocked()) throw new Error("Runtime already has an active or unconfirmed execution");
    if (Object.keys(this.data.used).length >= MAX_IDS) this.evictTombstones();
    if (Object.keys(this.data.used).length >= MAX_IDS) throw new Error("Runtime execution identity limit reached: every remembered execution is younger than 30 days");
    const before = structuredClone(this.data);
    const job: RuntimeStoredJob = { digest, seq: 1, task: { ...task, output: task.output.slice(-65_536) }, uncertain: false };
    this.data.jobs[task.id] = job; this.data.used[task.id] = digest; (this.data.usedAt ??= {})[task.id] = this.now();
    while (Object.keys(this.data.jobs).length > MAX_JOBS) {
      const oldest = Object.values(this.data.jobs).filter(row => row.task.id !== task.id && row.task.finishedAt && !row.uncertain)
        .sort((a, b) => a.task.startedAt - b.task.startedAt)[0];
      if (!oldest) { this.data = before; throw new Error("Runtime snapshot capacity reached"); }
      delete this.data.jobs[oldest.task.id];
    }
    if (!this.fitBytes(task.id)) { this.data = before; throw new Error("Runtime state limit reached: every retained execution is unsettled or younger than 30 days"); }
    try { this.save(); } catch (error) { this.data = before; throw error; }
    return { duplicate: false, job: structuredClone(job) };
  }
  update(task: WindowsCliTask): RuntimeStoredJob {
    const old = this.data.jobs[task.id]; if (!old) throw new Error("Runtime execution was not durably accepted");
    if (old.task.cli !== task.cli || old.task.cwd !== task.cwd || old.task.sandbox !== task.sandbox || old.task.model !== task.model)
      throw new Error("Runtime execution identity changed");
    const before = structuredClone(old);
    old.task = { ...task, output: task.output.slice(-65_536), ...(task.error ? { error: task.error.slice(0, 8192) } : {}) };
    old.uncertain = task.outcomeConfirmed === false;
    old.seq++;
    try { this.save(); } catch (error) { this.data.jobs[task.id] = before; throw error; }
    return structuredClone(old);
  }
  recover(id: string, confirmedStopped: unknown): RuntimeStoredJob {
    const old = this.data.jobs[id];
    if (!old?.uncertain || confirmedStopped !== true) throw new Error("Confirm the disconnected execution stopped before recovery");
    const before = structuredClone(old);
    old.uncertain = false; old.seq++;
    old.task = { ...old.task, status: "failed", finishedAt: old.task.finishedAt ?? this.now(), outcomeConfirmed: true,
      error: "Execution outcome was unknown; processes were manually confirmed stopped. This execution will not be replayed." };
    try { this.save(); } catch (error) { this.data.jobs[id] = before; throw error; }
    return structuredClone(old);
  }
  credentials(): RuntimeCredentials | null {
    const file = join(this.directory, "connection.json"); if (!existsSync(file)) return null;
    const raw = readPrivate(file);
    if (!object(raw) || typeof raw.server !== "string" || typeof raw.machineId !== "string" || !UUID.test(raw.machineId) || typeof raw.credential !== "string"
      || !/^[a-f0-9]{64}$/.test(raw.credential) || typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 100
      || raw.pendingCredential !== undefined && (typeof raw.pendingCredential !== "string" || !/^[a-f0-9]{64}$/.test(raw.pendingCredential) || raw.pendingCredential === raw.credential)) throw new Error("Invalid runtime connection");
    validateRuntimeServer(raw.server); return raw as unknown as RuntimeCredentials;
  }
  saveCredentials(value: RuntimeCredentials): void {
    validateRuntimeServer(value.server);
    if (!UUID.test(value.machineId) || !/^[a-f0-9]{64}$/.test(value.credential) || !value.name.trim() || value.name.length > 100
      || value.pendingCredential !== undefined && (!/^[a-f0-9]{64}$/.test(value.pendingCredential) || value.pendingCredential === value.credential)) throw new Error("Invalid runtime credential");
    atomic(join(this.directory, "connection.json"), value);
  }
  /**
   * The credential profile NAME this pairing uses for every agent that does not name its own (`connect --credential-profile`). A name only:
   * the folder is resolved by this Runtime under its own profile root, and nothing here leaves this computer.
   */
  credentialDefault(): string | undefined {
    const file = join(this.directory, "credential-default.json"); if (!existsSync(file)) return undefined;
    const raw = readPrivate(file);
    if (!object(raw) || raw.version !== 1 || Object.keys(raw).some(key => key !== "version" && key !== "profile") || !validCredentialProfileName(raw.profile)) throw new Error("Invalid credential profile default; run connect with --credential-profile again, or delete credential-default.json in the profile folder");
    return raw.profile;
  }
  setCredentialDefault(name: string | undefined): void {
    const file = join(this.directory, "credential-default.json");
    if (name === undefined) { if (existsSync(file)) unlinkSync(file); return; }
    atomic(file, { version: 1, profile: assertCredentialProfileName(name) });
  }
  /** Forgets the pairing and, with it, this pairing's default credential profile name (the profile folders and their sign-ins stay). */
  forgetCredentials(): void {
    const file = join(this.directory, "connection.json"); if (existsSync(file)) unlinkSync(file);
    this.setCredentialDefault(undefined);
  }
  /** PID recorded in the profile lock, if any; the lock is neither created nor removed. */
  lockHolder(): number | undefined {
    try { const lock = readPrivate(join(this.directory, "runtime.lock")); return object(lock) && Number.isSafeInteger(lock.pid) && (lock.pid as number) > 0 ? lock.pid as number : undefined; }
    catch { return undefined; }
  }
  /**
   * `notRuntimePid` is a PID the caller has positively verified is not an AgEnD Runtime process (its PID was reused by another program).
   * A lock held by any other PID that cannot be proven gone still refuses, so a running Runtime is never unlocked from here.
   */
  lock(bootId: string, systemBootId?: string, notRuntimePid?: number): () => void {
    if (systemBootId !== undefined && (typeof systemBootId !== "string" || !/^[a-f0-9]{64}$/.test(systemBootId))) throw Error("Invalid Windows boot proof");
    const path = join(this.directory, "runtime.lock");
    if (existsSync(path)) {
      const old = readPrivate(path);
      if (!object(old) || !Number.isSafeInteger(old.pid) || (old.pid as number) <= 0) throw new Error("Invalid runtime lock; inspect it before restarting");
      if (old.systemBootId !== undefined && (typeof old.systemBootId !== "string" || !/^[a-f0-9]{64}$/.test(old.systemBootId))) throw Error("Invalid runtime boot proof");
      let alive = !(systemBootId && old.systemBootId && systemBootId !== old.systemBootId) && old.pid !== notRuntimePid, denied = false;
      try { if (alive) process.kill(old.pid as number, 0); } catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code === "ESRCH") alive = false; else denied = code === "EPERM"; }
      if (alive) throw new Error(`Another runtime already uses this profile (process ${old.pid}${denied ? ", which this Windows user is not allowed to inspect" : ""}). `
        + `Close its window, or end that process in Task Manager if it is a node.exe running runtime-cli.js, then try again. `
        + `Only if you have confirmed no AgEnD Runtime is running (the number may have been reused after a restart), delete ${path} and try again.`);
      unlinkSync(path);
    }
    writeFileSync(path, JSON.stringify({ pid: process.pid, bootId, ...(systemBootId ? {systemBootId} : {}) }), { flag: "wx", mode: 0o600 });
    return () => { try { const current = readPrivate(path); if (object(current) && current.bootId === bootId) unlinkSync(path); } catch { /* already released */ } };
  }
}
