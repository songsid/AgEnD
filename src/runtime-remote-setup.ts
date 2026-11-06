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
import { closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeSync } from "node:fs";
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
 * Appends to `<pairing folder>\audit.jsonl` (private; a link is refused; five rotated copies, each up to about 1 MiB). Throws when it cannot write: a remote
 * operation whose record cannot be kept does not run.
 */
export function appendAudit(directory: string, entry: AuditEntry, now = Date.now()): void {
  const line = formatAuditLine(entry, now), path = join(directory, AUDIT_FILE);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Audit log must be a regular file");
    if (stat.size > MAX_AUDIT_BYTES) {
      // .4 -> .5, ... , .1 -> .2, current -> .1; the oldest copy goes.
      for (let index = AUDIT_KEEP; index >= 2; index--) { const from = `${path}.${index - 1}`; if (existsSync(from)) renameSync(from, `${path}.${index}`); }
      renameSync(path, `${path}.1`);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Two handles on the one file. `rw` (read and write, no append flag) looks at the end of the file and repairs or cuts it: on Windows a handle opened for
  // append has no right to truncate. `app` (append only) writes the record: appends stay appends, so a second process writing at the same moment (the Runtime
  // and `agend-runtime remote-setup`) is never overwritten.
  const rw = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
  try {
    const app = openSync(path, constants.O_WRONLY | constants.O_APPEND, 0o600);
    try {
      const one = fstatSync(rw), two = fstatSync(app);
      if (!one.isFile() || !two.isFile() || one.dev !== two.dev || one.ino !== two.ino) throw new Error("Audit log must be a regular file");
      const valid = repairedEnd(rw);
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
        // Cut back to the last whole record, but only if nobody else has added anything after our part (then the size is exactly what we wrote).
        try { if (done > 0 && fstatSync(rw).size === valid + done) ftruncateSync(rw, valid); } catch { /* the next append finds the incomplete tail and repairs it, or refuses */ }
        throw error;
      }
    } finally { closeSync(app); }
  } finally { closeSync(rw); }
}
const AUDIT_PREFIX = '{"at":"';
/**
 * The end of the last WHOLE record, after repairing what an interrupted write left: a tail without its newline is the front of a record that was never
 * completed. If it is the front of one of ours (it begins the way every record begins, and stays unchanged for a moment, so a record another process is
 * writing right now is not mistaken for it) it is cut off; anything else, or a last whole line that is not JSON, is damage this code does not guess about:
 * it refuses (so no operation that needs its record goes ahead on an unreadable log).
 */
function repairedEnd(fd: number): number {
  let size = fstatSync(fd).size;
  if (size === 0) return 0;
  const tailOf = (end: number): { text: string; start: number } => {
    const start = Math.max(0, end - 16 * 1024), buffer = Buffer.alloc(end - start); readSync(fd, buffer, 0, buffer.length, start);
    return { text: buffer.toString("utf8"), start };
  };
  let { text, start } = tailOf(size);
  if (!text.endsWith("\n")) {
    const lastNewline = text.lastIndexOf("\n"), cut = lastNewline < 0 ? start : start + Buffer.byteLength(text.slice(0, lastNewline + 1), "utf8");
    if (lastNewline < 0 && start > 0) throw new Error("Audit log has an unreadable tail; repair or remove it on this computer");
    const tail = text.slice(lastNewline + 1);
    if (!(AUDIT_PREFIX.startsWith(tail) || tail.startsWith(AUDIT_PREFIX))) throw new Error("Audit log has an unreadable tail; repair or remove it on this computer");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);       // a record being written by someone else would be whole by now
    if (fstatSync(fd).size !== size) return repairedEnd(fd);
    ftruncateSync(fd, cut); size = cut;
    if (size === 0) return 0;
    ({ text, start } = tailOf(size));
  }
  const lines = text.split("\n").filter(line => line.trim());
  const last = lines[lines.length - 1];
  if (last !== undefined && !(start > 0 && lines.length === 1)) {
    let parsed: unknown; try { parsed = JSON.parse(last); } catch { throw new Error("Audit log has an unreadable last record; repair or remove it on this computer"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Audit log has an unreadable last record; repair or remove it on this computer");
  }
  return size;
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
