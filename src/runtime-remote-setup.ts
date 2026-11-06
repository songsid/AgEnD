/**
 * #3190 Part 3a: what a fleet admin may do to this Windows computer from the dashboard, and the record of it.
 *
 * Two switches, both OFF by default, set only on this computer (`agend-runtime remote-setup accounts|install on|off [--for 2h]`) and kept in
 * this pairing's own folder. The server cannot change them: nothing in the protocol writes this file. A request that needs a switch is refused
 * while it is off, with the command to run here. The switch may turn itself off after a time (`--for`); an expired switch is off.
 *
 * Every remote operation is recorded in `audit.jsonl` in the same folder: who (as the server names them), when, which operation, which
 * profile, the outcome. The record is a CLOSED shape built field by field from checked values, so a URL, a sign-in code, CLI output, a folder
 * listing or an e-mail address cannot get into it by accident.
 *
 * Built-ins only: part of the Runtime bundle.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";

/** Capabilities a Runtime reports. A capability says the Runtime can do it; the switches say whether it may, right now. */
export const REMOTE_SIGNIN_CAPABILITY = "remote-signin";
export const CLI_INSTALL_CAPABILITY = "cli-install";

export const REMOTE_SWITCHES = ["accounts", "install"] as const;
export type RemoteSwitchName = typeof REMOTE_SWITCHES[number];
export const REMOTE_SETUP_FILE = "remote-setup.json";
export const AUDIT_FILE = "audit.jsonl";
/** A switch left on is a standing offer to the fleet: it can be timed, and a timed one is bounded. */
export const MIN_SWITCH_MS = 60_000;
export const MAX_SWITCH_MS = 7 * 24 * 3_600_000;
const MAX_AUDIT_BYTES = 1024 * 1024;
/** Rotated copies kept besides the current file (`audit.jsonl.1` is the newest). */
export const AUDIT_KEEP = 5;

export interface RemoteSwitchState { on: boolean; /** Epoch ms at which a timed switch turns itself off. */ until?: number }
export type RemoteSwitches = Record<RemoteSwitchName, RemoteSwitchState>;

export function isRemoteSwitchName(value: unknown): value is RemoteSwitchName {
  return typeof value === "string" && (REMOTE_SWITCHES as readonly string[]).includes(value);
}
/** The command that turns a switch on, for a refusal. */
export function remoteSwitchCommand(name: RemoteSwitchName): string { return `agend-runtime remote-setup ${name} on [--for 2h]`; }

/** A refusal whose text is ours and safe to show anywhere: it names a switch and a command, never a path, an account or a secret. */
export class RemoteSetupRefusal extends Error {
  constructor(message: string, readonly reason: AuditReason) { super(message); this.name = "RemoteSetupRefusal"; }
}

/** `2h`, `90m` or a bare number of hours. Bounded; anything else is an error, never "cleaned up". */
export function parseSwitchDuration(text: string): number {
  const match = /^(\d{1,4}(?:\.\d{1,2})?)(h|m)?$/.exec(text.trim());
  if (!match) throw new Error("Use --for with a time such as 2h, 90m or 0.5h");
  const ms = Math.round(Number(match[1]) * (match[2] === "m" ? 60_000 : 3_600_000));
  if (!Number.isFinite(ms) || ms < MIN_SWITCH_MS || ms > MAX_SWITCH_MS) throw new Error("--for must be between 1 minute and 168 hours (7 days)");
  return ms;
}

function readPrivateJson(path: string, limit: number): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error("Unsafe remote-setup file");
  return JSON.parse(readFileSync(path, "utf8"));
}
const off = (): RemoteSwitches => ({ accounts: { on: false }, install: { on: false } });
/** The switches as they stand now. Fail closed: a missing, unreadable or malformed file is "both off"; an expired switch is off. */
export function readRemoteSwitches(directory: string, now = Date.now()): RemoteSwitches {
  const result = off();
  let value: unknown;
  try { value = readPrivateJson(join(directory, REMOTE_SETUP_FILE), 4096); } catch { return result; }
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as { version?: unknown }).version !== 1) return result;
  for (const name of REMOTE_SWITCHES) {
    const row = (value as Record<string, unknown>)[name];
    if (!row || typeof row !== "object" || Array.isArray(row) || (row as { on?: unknown }).on !== true) continue;
    const until = (row as { until?: unknown }).until;
    if (until === undefined) { result[name] = { on: true }; continue; }
    // A timed switch never reaches further than the longest a person can set it for: a clock that was moved back, or a hand-written huge
    // value, would otherwise bring an expired switch back to life.
    if (typeof until === "number" && Number.isFinite(until) && until > now && until - now <= MAX_SWITCH_MS) result[name] = { on: true, until };
  }
  return result;
}
export function remoteSwitchOn(directory: string, name: RemoteSwitchName, now = Date.now()): boolean { return readRemoteSwitches(directory, now)[name].on; }
/** Local administrator only: nothing in the Runtime protocol calls this. */
export function setRemoteSwitch(directory: string, name: RemoteSwitchName, on: boolean, forMs?: number, now = Date.now()): RemoteSwitchState {
  if (!isRemoteSwitchName(name)) throw new Error("Unknown remote-setup switch");
  if (forMs !== undefined && (!on || !Number.isFinite(forMs) || forMs < MIN_SWITCH_MS || forMs > MAX_SWITCH_MS)) throw new Error("--for applies only when turning a switch on, and must be between 1 minute and 168 hours");
  const current = readRemoteSwitches(directory, now), next: RemoteSwitchState = on ? { on: true, ...(forMs !== undefined ? { until: now + forMs } : {}) } : { on: false };
  const file: Record<string, unknown> = { version: 1 };
  for (const other of REMOTE_SWITCHES) { const state = other === name ? next : current[other]; file[other] = state.on ? { on: true, ...(state.until !== undefined ? { until: state.until } : {}) } : { on: false }; }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(join(directory, REMOTE_SETUP_FILE), JSON.stringify(file), { mode: 0o600 });
  return next;
}
/** Throws the refusal (with the command to run) while a switch is off. */
export function requireRemoteSwitch(directory: string, name: RemoteSwitchName, now = Date.now()): void {
  if (!remoteSwitchOn(directory, name, now)) throw new RemoteSetupRefusal(`This computer has "${name}" turned off. On this computer run: ${remoteSwitchCommand(name)}`, "switch_off");
}
/** A one-line status for `remote-setup status` and the Runtime's report. */
export function describeRemoteSwitches(switches: RemoteSwitches, now = Date.now()): string {
  return REMOTE_SWITCHES.map(name => {
    const state = switches[name];
    return `${name}: ${state.on ? `on${state.until !== undefined ? ` (turns off in ${Math.max(1, Math.round((state.until - now) / 60_000))} min)` : ""}` : "off"}`;
  }).join("\n");
}

/** Closed vocabulary of the audit record. Free text has no field here. */
export const AUDIT_ACTIONS = ["switch", "profile.add", "signin", "signin.write", "profile.signout", "profile.remove", "cli.install"] as const;
export const AUDIT_OUTCOMES = ["started", "ok", "refused", "failed"] as const;
export const AUDIT_REASONS = ["switch_off", "invalid_request", "busy", "not_found", "not_owned", "in_use", "default_profile", "link", "unsupported", "unconfirmed", "timeout", "rate_limited", "failed"] as const;
export type AuditAction = typeof AUDIT_ACTIONS[number];
export type AuditOutcome = typeof AUDIT_OUTCOMES[number];
export type AuditReason = typeof AUDIT_REASONS[number];
export interface AuditEntry {
  /** Who asked, as the server names them (`local` for this computer's own command). */
  actor: string;
  action: AuditAction;
  outcome: AuditOutcome;
  cli?: string;
  profile?: string;
  /** `on`, `off` or `expired` for a switch; a CLI version for an install. */
  detail?: string;
  reason?: AuditReason;
  /** How many identical refusals this one stands for (see AuditLog). Absent for a single one. */
  repeated?: number;
  /** Where the folded run began (a closed ISO time, UTC). `at` stays the time the line was written. Only present together with `repeated`. */
  since?: string;
  /** Only for `switch`: which switch, and (when it was turned on for a time) when it ends. */
  switch?: RemoteSwitchName;
  until?: string;
}
/** What the dashboard may call a person in the record: a name or an id, not an address and not free text. */
export const AUDIT_ACTOR = /^[A-Za-z0-9._:-]{1,64}$/;
const AUDIT_DETAIL = /^(?:on|off|expired|\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][A-Za-z0-9.-]{1,32})?)$/;
const AUDIT_SINCE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const AUDIT_CLI = /^[a-z][a-z0-9-]{0,31}$/;
const AUDIT_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function validAuditActor(value: unknown): value is string { return typeof value === "string" && AUDIT_ACTOR.test(value); }

/** One line, built from checked fields only. Throws on a field that does not fit, which refuses the operation that was about to be recorded. */
export function formatAuditLine(entry: AuditEntry, now = Date.now()): string {
  if (!validAuditActor(entry.actor) || !(AUDIT_ACTIONS as readonly string[]).includes(entry.action) || !(AUDIT_OUTCOMES as readonly string[]).includes(entry.outcome)
    || entry.cli !== undefined && !AUDIT_CLI.test(entry.cli) || entry.profile !== undefined && !AUDIT_PROFILE.test(entry.profile)
    || entry.detail !== undefined && !AUDIT_DETAIL.test(entry.detail) || entry.repeated !== undefined && (!Number.isSafeInteger(entry.repeated) || entry.repeated < 2 || entry.repeated > 1_000_000_000) || entry.since !== undefined && (entry.repeated === undefined || !AUDIT_SINCE.test(entry.since))
    || entry.switch !== undefined && (entry.action !== "switch" || !isRemoteSwitchName(entry.switch)) || entry.until !== undefined && (entry.action !== "switch" || !AUDIT_SINCE.test(entry.until)) || entry.reason !== undefined && !(AUDIT_REASONS as readonly string[]).includes(entry.reason)) throw new Error("Audit entry is not in its closed form");
  return `${JSON.stringify({ at: new Date(now).toISOString(), actor: entry.actor, action: entry.action, outcome: entry.outcome,
    ...(entry.cli !== undefined ? { cli: entry.cli } : {}), ...(entry.profile !== undefined ? { profile: entry.profile } : {}),
    ...(entry.detail !== undefined ? { detail: entry.detail } : {}), ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    ...(entry.repeated !== undefined ? { repeated: entry.repeated } : {}), ...(entry.since !== undefined ? { since: entry.since } : {}),
    ...(entry.switch !== undefined ? { switch: entry.switch } : {}), ...(entry.until !== undefined ? { until: entry.until } : {}) })}\n`;
}
/**
 * Lock file of the audit log, in the pairing folder. Every supported writer (the Runtime, `agend-runtime remote-setup`, a second Runtime) takes it, and holds
 * it for the whole of: rotation, the look at the end of the log, the repair, the write, and the taking back of a failed write. Nothing destructive is done to
 * the log without it, and a writer that finds it no longer owns it stops there.
 */
export const AUDIT_LOCK_FILE = "audit.lock";
/** Held while one writer takes over the lock of a process that is gone. At most one takeover at a time. */
const AUDIT_RECLAIM_FILE = `${AUDIT_LOCK_FILE}.reclaim`;
/** How long a writer waits for the one before it (it then refuses: it never touches the log without the lock), and how old a lock file that holds nothing readable must be to be cleared. Tests lower these. */
export const auditLockTiming = { waitMs: 3_000, unreadableMs: 10_000 };
const heldAuditLocks = new Set<string>();      // tokens of the lock files (the lock, or the takeover guard) this process holds right now
const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const AUDIT_BUSY = "Audit log is busy (another process is writing it, or its lock file cannot be cleared): nothing was written; try again";
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }
type AuditLockOwner = { pid: number; token: string };
/** A lock file as it was looked at: which file it is (device and inode), what it held, and when it was written. */
interface AuditLockFile { dev: number; ino: number; size: number; mtimeMs: number; raw: string; owner: AuditLockOwner | "unreadable" }
function parseAuditLockOwner(raw: string): AuditLockOwner | "unreadable" {
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; token?: unknown } | null;
    return parsed && typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0 && typeof parsed.token === "string" && /^[0-9a-f]{16}$/.test(parsed.token) ? { pid: parsed.pid, token: parsed.token } : "unreadable";
  } catch { return "unreadable"; }
}
function snapshotAuditLock(path: string): AuditLockFile | "gone" {
  let stat; try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "gone"; throw error; }
  if (!stat.isFile()) throw new Error("Audit lock must be a regular file");
  let raw = ""; try { raw = readFileSync(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "gone"; }
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, raw, owner: parseAuditLockOwner(raw) };
}
/**
 * A lock nobody is using any more: its process is gone; or it is this process's pid with a token this process does not hold (a pid that was reused); or it holds
 * nothing readable and has been like that for a while (its writer may be between creating it and filling it). A live owner's lock is never stale.
 */
function auditLockIsStale(lock: AuditLockFile): boolean {
  return lock.owner === "unreadable" ? Date.now() - lock.mtimeMs > auditLockTiming.unreadableMs : !heldAuditLocks.has(lock.owner.token) && (lock.owner.pid === process.pid || !processAlive(lock.owner.pid));
}
/** The very file that was looked at: same device and inode, same bytes. An unreadable lock is compared the same way (what was empty and old and is now a valid owner is a different lock). */
function sameAuditLockFile(before: AuditLockFile, after: AuditLockFile | "gone"): boolean {
  return after !== "gone" && after.dev === before.dev && after.ino === before.ino && after.size === before.size && after.raw === before.raw;
}
/** Creates a lock file exclusively (`O_EXCL`). Returns which file it is, or undefined when one is already there. */
function createAuditLockFile(path: string, token: string): { dev: number; ino: number } | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined; throw error; }
  try { writeSync(fd, JSON.stringify({ pid: process.pid, token })); const stat = fstatSync(fd); return { dev: stat.dev, ino: stat.ino }; }
  catch (error) { try { unlinkSync(path); } catch { /* nothing else can be done */ } throw error; }
  finally { closeSync(fd); }
}
/** Removes a lock file only if it is still the one that was made: ours by token and by file. */
function removeAuditLockFile(path: string, token: string, identity?: { dev: number; ino: number }): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const lock = snapshotAuditLock(path);
      if (lock === "gone" || lock.owner === "unreadable" || lock.owner.token !== token || (identity !== undefined && (lock.dev !== identity.dev || lock.ino !== identity.ino))) return;
      unlinkSync(path); return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; pause(10); }     // a handle another process holds for a moment (Windows)
  }
  // Still there: it is ours, so the next writer of this process clears it (same pid, token not held) and another process waits until this one ends.
}
/** Clears a lock file nobody is using, only if it is still exactly what was looked at. */
function clearStaleAuditLockFile(path: string): void {
  const seen = snapshotAuditLock(path);
  if (seen === "gone" || !auditLockIsStale(seen) || !sameAuditLockFile(seen, snapshotAuditLock(path))) return;
  try { unlinkSync(path); } catch { /* it stays; whoever needs it waits and then refuses */ }
}
/**
 * Takes over the lock of a process that is gone, keeping exclusive, identity-bound ownership through the whole takeover. Only one taker at a time (it holds the
 * reclaim file, created exclusively). Under it the lock file is looked at again: it must still be the very file that was seen to be stale (same inode, same
 * bytes; a lock that was empty and is now a valid owner is not), and stale. The new lock is written whole to a file of its own and then renamed over the old one,
 * so there is never a moment without a lock, and a file that is replaced between the last look and the rename is the only gap left. Anything uncertain: no
 * takeover (the caller waits, and refuses when the wait runs out). Nothing here ever removes a lock that was not seen to be stale.
 */
function takeOverAuditLock(directory: string, path: string, reclaimPath: string, token: string, seen: AuditLockFile): { dev: number; ino: number } | undefined {
  if (!createAuditLockFile(reclaimPath, token)) { clearStaleAuditLockFile(reclaimPath); return undefined; }     // another taker is at it (or died at it: cleared for the next try)
  heldAuditLocks.add(token);
  const next = join(directory, `${AUDIT_LOCK_FILE}.next-${token}`); let staged = false, taken = false;
  try {
    const now = snapshotAuditLock(path);
    if (now === "gone" || !sameAuditLockFile(seen, now) || !auditLockIsStale(now)) return undefined;
    if (!createAuditLockFile(next, token)) return undefined;
    staged = true;
    if (!sameAuditLockFile(seen, snapshotAuditLock(path))) return undefined;
    try { renameSync(next, path); }
    catch { if (!sameAuditLockFile(seen, snapshotAuditLock(path))) return undefined; unlinkSync(path); renameSync(next, path); }      // where a rename cannot replace
    staged = false;
    const mine = snapshotAuditLock(path);
    if (mine === "gone" || mine.owner === "unreadable" || mine.owner.token !== token) return undefined;
    taken = true; return { dev: mine.dev, ino: mine.ino };
  } catch { return undefined; }
  finally {
    if (staged) { try { unlinkSync(next); } catch { /* left behind: it holds nothing but a token */ } }
    removeAuditLockFile(reclaimPath, token);
    if (!taken) heldAuditLocks.delete(token);
  }
}
interface AuditLockHandle { release(): void; /** Throws unless this writer still owns the lock: the same file, holding its token. Called right before anything destructive and before the write. */ assertOwned(): void }
/**
 * Takes the audit lock: a file created exclusively (`O_EXCL`) that holds this process's pid and a token of its own. A lock held by a live process is waited
 * for, and when the wait runs out this THROWS: a writer that cannot have the lock never looks at the log, never repairs it and never cuts it. A lock whose
 * process is gone is taken over (`takeOverAuditLock`).
 */
function acquireAuditLock(directory: string): AuditLockHandle {
  const path = join(directory, AUDIT_LOCK_FILE), reclaimPath = join(directory, AUDIT_RECLAIM_FILE), token = randomBytes(8).toString("hex"), deadline = Date.now() + auditLockTiming.waitMs;
  const wait = (): void => { if (Date.now() >= deadline) throw new Error(AUDIT_BUSY); pause(10); };
  const owned = (identity: { dev: number; ino: number }): AuditLockHandle => {
    heldAuditLocks.add(token);
    return {
      release: () => { heldAuditLocks.delete(token); removeAuditLockFile(path, token, identity); },
      assertOwned: () => {
        const lock = snapshotAuditLock(path);
        if (!heldAuditLocks.has(token) || lock === "gone" || lock.owner === "unreadable" || lock.owner.token !== token || lock.dev !== identity.dev || lock.ino !== identity.ino)
          throw new Error("Audit log lock was lost (it was cleared or replaced while this writer held it): nothing more was done; try again");
      },
    };
  };
  for (;;) {
    if (existsSync(reclaimPath)) { clearStaleAuditLockFile(reclaimPath); wait(); continue; }       // a takeover is under way: nobody creates or takes over in the middle of it
    const made = createAuditLockFile(path, token);
    if (made) return owned(made);
    const seen = snapshotAuditLock(path);
    if (seen === "gone") { wait(); continue; }
    if (auditLockIsStale(seen)) { const taken = takeOverAuditLock(directory, path, reclaimPath, token, seen); if (taken) return owned(taken); }
    wait();
  }
}
/**
 * Appends to `<pairing folder>\audit.jsonl` (private; a link is refused; five rotated copies, each up to about 1 MiB). Throws when it cannot write: a remote
 * operation whose record cannot be kept does not run. The whole of it (rotation, the look at the end of the log, the repair, the write, the taking back of a
 * failed write) runs under the audit lock, so two writers (the Runtime and `agend-runtime remote-setup`, two Runtimes) never repair, cut and write at once.
 */
export function appendAudit(directory: string, entry: AuditEntry, now = Date.now()): void {
  const line = formatAuditLine(entry, now), path = join(directory, AUDIT_FILE);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = acquireAuditLock(directory);
  try { appendLocked(path, line, lock.assertOwned); } finally { lock.release(); }
}
function appendLocked(path: string, line: string, assertOwned: () => void): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Audit log must be a regular file");
    if (stat.size > MAX_AUDIT_BYTES) {
      assertOwned();
      // .4 -> .5, ... , .1 -> .2, current -> .1; the oldest copy goes.
      for (let index = AUDIT_KEEP; index >= 2; index--) { const from = `${path}.${index - 1}`; if (existsSync(from)) renameSync(from, `${path}.${index}`); }
      renameSync(path, `${path}.1`);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Two handles on the one file. `rw` (read and write, no append flag) looks at the end of the file and repairs or cuts it: on Windows a handle opened for
  // append has no right to truncate. `app` (append only) writes the record, so what it writes is only ever added at the end of the file.
  const rw = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
  try {
    const app = openSync(path, constants.O_WRONLY | constants.O_APPEND, 0o600);
    try {
      const one = fstatSync(rw), two = fstatSync(app);
      if (!one.isFile() || !two.isFile() || one.dev !== two.dev || one.ino !== two.ino) throw new Error("Audit log must be a regular file");
      const valid = repairedEnd(rw, assertOwned);
      assertOwned();                                  // the write itself: only while the lock is still ours
      // A record is whole or it is an error: a partial write (a full disk, an interrupted call) is never accepted as written, and what was written of it is taken back.
      const bytes = Buffer.from(line, "utf8");
      let done = 0;
      try {
        while (done < bytes.byteLength) {
          const wrote = writeSync(app, bytes, done, bytes.byteLength - done);
          if (!(wrote > 0)) throw new Error("Audit log write was incomplete");
          done += wrote;
        }
      } catch (error) {
        // Cut our part off again, but only if the file is exactly what it was after our part went in (the same length and our bytes where our part is, looked at
        // before and after) AND the lock is still ours, checked last, right before the cut. If either does not hold, nothing here is ours to cut: whatever another writer
        // committed stays, and this write still fails with its own error, so the operation that needed this record is not admitted.
        try { if (done > 0 && stillExactly(rw, valid + done, valid, bytes.subarray(0, done))) { assertOwned(); ftruncateSync(rw, valid); } } catch { /* the next append finds the incomplete tail and repairs it, or refuses */ }
        throw error;
      }
    } finally { closeSync(app); }
  } finally { closeSync(rw); }
}
const AUDIT_PREFIX = '{"at":"';
/** The file is exactly `size` bytes and holds `expected` at `from`: a snapshot looked at before and after reading it, so a writer that changed the file meanwhile (its length, or the bytes at the cut) is seen. */
function stillExactly(fd: number, size: number, from: number, expected: Buffer): boolean {
  if (fstatSync(fd).size !== size) return false;
  const buffer = Buffer.alloc(expected.length), read = readSync(fd, buffer, 0, buffer.length, from);
  return read === expected.length && buffer.equals(expected) && fstatSync(fd).size === size;
}
/**
 * The end of the last WHOLE record, after repairing what an interrupted write left: a tail without its newline is the front of a record that was never
 * completed. If it is the front of one of ours (it begins the way every record begins, and stays unchanged for a moment, so a record another process is
 * writing right now is not mistaken for it) it is cut off; anything else, or a last whole line that is not JSON, is damage this code does not guess about:
 * it refuses (so no operation that needs its record goes ahead on an unreadable log). The cut is made only on a snapshot nobody has changed (`stillExactly`)
 * and only while the lock is still this writer's (`assertOwned`, the last thing before the cut, which throws when it is not): if a writer has completed or
 * replaced that tail meanwhile the end is looked at again, and what that writer committed is never cut.
 */
function repairedEnd(fd: number, assertOwned: () => void): number {
  for (let round = 0; round < 32; round++) {
    const size = fstatSync(fd).size;
    if (size === 0) return 0;
    const start = Math.max(0, size - 16 * 1024), raw = Buffer.alloc(size - start); readSync(fd, raw, 0, raw.length, start);
    if (raw[raw.length - 1] !== 0x0a) {
      const newline = raw.lastIndexOf(0x0a), cut = start + newline + 1;
      if (newline < 0 && start > 0) throw new Error("Audit log has an unreadable tail; repair or remove it on this computer");
      const tailBytes = raw.subarray(newline + 1), tail = tailBytes.toString("utf8");
      if (!(AUDIT_PREFIX.startsWith(tail) || tail.startsWith(AUDIT_PREFIX))) throw new Error("Audit log has an unreadable tail; repair or remove it on this computer");
      pause(25);                                      // looked at again after a moment: it must be the same bytes
      if (!stillExactly(fd, size, cut, tailBytes)) continue;
      assertOwned();
      ftruncateSync(fd, cut);
      continue;
    }
    const lines = raw.toString("utf8").split("\n").filter(line => line.trim()), last = lines[lines.length - 1];
    if (last !== undefined && !(start > 0 && lines.length === 1)) {
      let parsed: unknown; try { parsed = JSON.parse(last); } catch { throw new Error("Audit log has an unreadable last record; repair or remove it on this computer"); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Audit log has an unreadable last record; repair or remove it on this computer");
    }
    return size;
  }
  throw new Error("Audit log keeps changing while it is being read; nothing was written; try again");
}

/**
 * The record of one Runtime process, with the refusals folded together.
 *
 * A refusal costs the asker nothing, and the one who asks is whoever the server says (a compromised server is the threat model), so an unbounded
 * stream of them could push the real operations out of a rotating file. So: a `refused` entry that repeats within a minute is not written again; it is
 * counted, and the count goes out with the next entry of its kind (or with the next non-refused entry, or at `flush`). The folding key is the
 * action and the reason ONLY. It must not hold the actor, the profile or the CLI, which the server chooses freely: a new name per request would
 * defeat it. What is never folded: `started`, `ok` and `failed` entries and the switch changes, which only a real operation can produce. A refusal is
 * only ever the answer to a request that changed nothing, so every check that can refuse without changing anything has to run BEFORE `started` is
 * written (RemoteAccounts does). Therefore the most refusals can write is one line per (action, reason) pair per minute. The line of a folded run carries
 * the actor, profile and CLI of the FIRST request of that run; `repeated` counts requests that may have named others.
 */
export const AUDIT_FOLD_MS = 60_000;
export class AuditLog {
  private readonly folded = new Map<string, { since: number; suppressed: number; entry: AuditEntry }>();
  constructor(private readonly directory: string, private readonly now: () => number = Date.now) {}
  /** Throws when the line cannot be written (the caller decides whether that stops its operation). */
  append(entry: AuditEntry): void {
    const now = this.now();
    // A real operation is about to start: the counts of what was folded so far go out first. Nothing else flushes: an `ok`, a `failed` or a refusal
    // must not make every request write twice, which would undo the folding.
    if (entry.outcome === "started") this.flush();
    if (entry.outcome !== "refused") { appendAudit(this.directory, entry, now); return; }
    const key = `${entry.action}\u0000${entry.reason ?? ""}`, seen = this.folded.get(key);
    if (seen && now - seen.since < AUDIT_FOLD_MS) { seen.suppressed++; return; }
    appendAudit(this.directory, { ...entry, ...(seen && seen.suppressed + 1 >= 2 ? { repeated: seen.suppressed + 1, since: new Date(seen.since).toISOString() } : {}) }, now);
    this.folded.set(key, { since: now, suppressed: 0, entry });
  }
  /** Writes what was folded and not yet written (best effort), so no count is lost when a process ends. */
  flush(): void {
    const now = this.now();
    for (const [key, seen] of [...this.folded]) {
      if (!seen.suppressed) continue;
      try { appendAudit(this.directory, { ...seen.entry, ...(seen.suppressed >= 2 ? { repeated: seen.suppressed, since: new Date(seen.since).toISOString() } : {}) }, now); seen.suppressed = 0; seen.since = now; } catch { /* kept for the next flush */ }
      this.folded.set(key, seen);
    }
  }
}
