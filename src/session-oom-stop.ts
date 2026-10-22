/** Authoritative instance stop, separate from an auto-wakeable pause or observational journal. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { ensureInstanceDir } from "./private-dir.js";
import { t } from "./locale.js";
import type { InteractionOwner } from "./backend/types.js";

export const SESSION_OOM_STOP_FILE = "session-oom-stop.json";
export function sessionOomStopHint(): string { return t("inst.session_oom_hold"); }
const MAX_BYTES = 4096;
export interface SessionOomStop {
  version: 1;
  id: string;
  reason: "session_oom";
  owner: InteractionOwner;
  sessionKey: string;
  configuration: string;
  stoppedAt: number;
  count: number;
  victim: { pid: number; at: number };
}
export type SessionOomStopState = { blocked: false } | { blocked: true; record: SessionOomStop | null; revision: string | null };
/** Internal action receipt: capture at the explicit command, consume only inside its serialized transition. */
export interface SessionOomRetry { readonly revision: string | null; readonly legacyRevision: string | null }
export class SessionOomStoppedError extends Error {
  readonly code = "SESSION_OOM_STOPPED";
  constructor(busy = false) { super(t(busy ? "inst.session_oom_retry_busy" : "inst.session_oom_hold")); this.name = "SessionOomStoppedError"; }
}
const owned = (uid: number) => typeof process.getuid !== "function" || uid === process.getuid();
const boundedId = (x: unknown): x is string => typeof x === "string" && x.length > 0 && Buffer.byteLength(x) <= 1024 && !/[\u0000-\u001f\u007f]/.test(x);
const integer = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const fingerprint = (stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) =>
  createHash("sha256").update(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])).digest("hex");
const legacyCache = new Map<string, { revision: string; blocked: boolean }>();
function legacyHistoryRevision(instanceDir: string): string | null {
  try {
    const stat = lstatSync(join(instanceDir, "crash-history.jsonl"));
    if (!stat.isFile() || !owned(stat.uid)) throw new SessionOomStoppedError();
    return `legacy:${fingerprint(stat)}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SessionOomStoppedError();
  }
}

/** Upgrade-only evidence: old #2446 wrote a structured stop without a session/launch owner. */
function legacySessionStop(instanceDir: string): SessionOomStopState {
  let fd: number | undefined;
  let revision: string | null = null;
  try {
    const path = join(instanceDir, "crash-history.jsonl"), stat = lstatSync(path);
    if (!stat.isFile() || !owned(stat.uid)) return { blocked: true, record: null, revision: null };
    revision = `legacy:${fingerprint(stat)}`;
    const cached = legacyCache.get(instanceDir);
    let blocked = true;
    if (cached?.revision === revision) blocked = cached.blocked;
    else {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino) return { blocked: true, record: null, revision: null };
      // The final structured record names the last crash decision. Do not scan
      // transcripts, parse human logs, or guess that an old OOM is still current.
      const bytes = Buffer.alloc(Math.min(stat.size, 64 * 1024));
      const offset = Math.max(0, stat.size - bytes.length);
      const n = readSync(fd, bytes, 0, bytes.length, offset);
      const lines = bytes.subarray(0, n).toString("utf8").trimEnd().split("\n");
      if (offset > 0 && lines.length === 1) blocked = true;
      else {
        const last = lines.at(-1);
        const record = last ? JSON.parse(last) : null;
        blocked = !!last && (!record || typeof record !== "object" || typeof record.instance !== "string"
          || typeof record.timestamp !== "string" || !Number.isFinite(Date.parse(record.timestamp))
          || !["window", "server"].includes(record.crashType) || record.reason === "session_oom");
      }
      if (legacyCache.size >= 512) legacyCache.delete(legacyCache.keys().next().value!);
      legacyCache.set(instanceDir, { revision, blocked });
    }
    return blocked ? { blocked: true, record: null, revision } : { blocked: false };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { blocked: false } : { blocked: true, record: null, revision };
  } finally { if (fd !== undefined) closeSync(fd); }
}
function valid(value: any): value is SessionOomStop {
  return value?.version === 1 && value.reason === "session_oom" && boundedId(value.id) && boundedId(value.sessionKey)
    && /^[a-f0-9]{64}$/.test(value.configuration) && boundedId(value.owner?.bootId)
    && [value.owner.spawnGeneration, value.owner.launchAttempt, value.owner.launchFenceEpoch].every(integer)
    && integer(value.stoppedAt) && integer(value.count) && value.count >= 2
    && integer(value.victim?.pid) && value.victim.pid > 0 && integer(value.victim.at);
}

/** Absence alone permits a launch; malformed, foreign, symlinked or unreadable evidence holds it. */
export function readSessionOomStop(instanceDir: string): SessionOomStopState {
  let fd: number | undefined;
  try {
    const dir = lstatSync(instanceDir);
    if (!dir.isDirectory() || !owned(dir.uid)) return { blocked: true, record: null, revision: null };
    const path = join(instanceDir, SESSION_OOM_STOP_FILE);
    let stat;
    try { stat = lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return legacySessionStop(instanceDir); throw error; }
    if (!stat.isFile() || !owned(stat.uid)) return { blocked: true, record: null, revision: null };
    // No raw contents in a receipt, error, log or caller-visible command.
    const revision = fingerprint(stat);
    if (stat.size > MAX_BYTES) return { blocked: true, record: null, revision };
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd);
      if (!opened.isFile() || !owned(opened.uid) || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > MAX_BYTES) return { blocked: true, record: null, revision: null };
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const n = readSync(fd, bytes, length, bytes.length - length, null);
        if (!n) break;
        length += n;
      }
      if (length > MAX_BYTES) return { blocked: true, record: null, revision };
      const parsed: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
      // A durable retry receipt prevents the old structured stop from being
      // re-imported on every subsequent boot. It is not an auto-retry receipt.
      const cleared = parsed as { version?: unknown; reason?: unknown; id?: unknown; clearedAt?: unknown; legacyRevision?: unknown } | null;
      if (cleared?.version === 1 && cleared.reason === "session_oom_cleared" && boundedId(cleared.id) && integer(cleared.clearedAt)
        && (cleared.legacyRevision === null || typeof cleared.legacyRevision === "string" && /^legacy:[a-f0-9]{64}$/.test(cleared.legacyRevision))) {
        // An older binary, or a failed modern marker write, may have recorded
        // a NEW stop since this retry. A receipt acknowledges only its history.
        return cleared.legacyRevision === legacyHistoryRevision(instanceDir) ? { blocked: false } : legacySessionStop(instanceDir);
      }
      return { blocked: true, record: valid(parsed) ? parsed : null, revision };
    } catch { return { blocked: true, record: null, revision }; }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { blocked: false } : { blocked: true, record: null, revision: null };
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function assertNoSessionOomStop(instanceDir: string): void {
  if (readSessionOomStop(instanceDir).blocked) throw new SessionOomStoppedError();
}

/** Call synchronously after the confirmed OOM's final owner check, before ending supervision. */
export function writeSessionOomStop(instanceDir: string, input: Omit<SessionOomStop, "version" | "id" | "reason">): SessionOomStop {
  ensureInstanceDir(instanceDir);
  const existing = readSessionOomStop(instanceDir);
  if (existing.blocked) {
    if (existing.record) return existing.record;
    throw new SessionOomStoppedError();
  }
  const record: SessionOomStop = { version: 1, id: randomUUID(), reason: "session_oom",
    owner: { bootId: input.owner.bootId, spawnGeneration: input.owner.spawnGeneration, launchAttempt: input.owner.launchAttempt, launchFenceEpoch: input.owner.launchFenceEpoch },
    sessionKey: input.sessionKey, configuration: input.configuration, stoppedAt: input.stoppedAt, count: input.count,
    victim: { pid: input.victim.pid, at: input.victim.at } };
  if (!valid(record) || Buffer.byteLength(JSON.stringify(record)) > MAX_BYTES) throw new Error("Invalid session OOM stop evidence");
  atomicWriteFileSync(join(instanceDir, SESSION_OOM_STOP_FILE), JSON.stringify(record), { mode: 0o600 });
  return record;
}

export function captureSessionOomRetry(instanceDir: string): SessionOomRetry {
  const state = readSessionOomStop(instanceDir);
  if (state.blocked && state.revision === null) throw new SessionOomStoppedError();
  return { revision: state.blocked ? state.revision : null, legacyRevision: legacyHistoryRevision(instanceDir) };
}

/** Does not authorize clearing a later OOM decision, even if it arrived while the action waited. */
export function clearSessionOomStopForRetry(instanceDir: string, retry: SessionOomRetry): void {
  const state = readSessionOomStop(instanceDir);
  if (!state.blocked) return;
  if (!state.revision || state.revision !== retry.revision) throw new SessionOomStoppedError();
  if (legacyHistoryRevision(instanceDir) !== retry.legacyRevision) throw new SessionOomStoppedError();
  try { atomicWriteFileSync(join(instanceDir, SESSION_OOM_STOP_FILE), JSON.stringify({ version: 1,
    id: randomUUID(), reason: "session_oom_cleared", clearedAt: Date.now(), legacyRevision: retry.legacyRevision }), { mode: 0o600 }); }
  catch { throw new SessionOomStoppedError(); }
  assertNoSessionOomStop(instanceDir);
}
