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
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
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
    if (typeof until === "number" && Number.isFinite(until) && until > now) result[name] = { on: true, until };
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
export const AUDIT_ACTIONS = ["switch", "profile.add", "signin", "profile.signout", "profile.remove", "cli.install"] as const;
export const AUDIT_OUTCOMES = ["started", "ok", "refused", "failed"] as const;
export const AUDIT_REASONS = ["switch_off", "invalid_request", "busy", "not_found", "not_owned", "in_use", "default_profile", "link", "unsupported", "timeout", "rate_limited", "failed"] as const;
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
}
/** What the dashboard may call a person in the record: a name or an id, not an address and not free text. */
export const AUDIT_ACTOR = /^[A-Za-z0-9._:-]{1,64}$/;
const AUDIT_DETAIL = /^(?:on|off|expired|\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][A-Za-z0-9.-]{1,32})?)$/;
const AUDIT_CLI = /^[a-z][a-z0-9-]{0,31}$/;
const AUDIT_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function validAuditActor(value: unknown): value is string { return typeof value === "string" && AUDIT_ACTOR.test(value); }

/** One line, built from checked fields only. Throws on a field that does not fit, which refuses the operation that was about to be recorded. */
export function formatAuditLine(entry: AuditEntry, now = Date.now()): string {
  if (!validAuditActor(entry.actor) || !(AUDIT_ACTIONS as readonly string[]).includes(entry.action) || !(AUDIT_OUTCOMES as readonly string[]).includes(entry.outcome)
    || entry.cli !== undefined && !AUDIT_CLI.test(entry.cli) || entry.profile !== undefined && !AUDIT_PROFILE.test(entry.profile)
    || entry.detail !== undefined && !AUDIT_DETAIL.test(entry.detail) || entry.reason !== undefined && !(AUDIT_REASONS as readonly string[]).includes(entry.reason)) throw new Error("Audit entry is not in its closed form");
  return `${JSON.stringify({ at: new Date(now).toISOString(), actor: entry.actor, action: entry.action, outcome: entry.outcome,
    ...(entry.cli !== undefined ? { cli: entry.cli } : {}), ...(entry.profile !== undefined ? { profile: entry.profile } : {}),
    ...(entry.detail !== undefined ? { detail: entry.detail } : {}), ...(entry.reason !== undefined ? { reason: entry.reason } : {}) })}\n`;
}
/**
 * Appends to `<pairing folder>\audit.jsonl` (private; a link is refused; one rotated copy past 1 MiB). Throws when it cannot write: a remote
 * operation whose record cannot be kept does not run.
 */
export function appendAudit(directory: string, entry: AuditEntry, now = Date.now()): void {
  const line = formatAuditLine(entry, now), path = join(directory, AUDIT_FILE);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Audit log must be a regular file");
    if (stat.size > MAX_AUDIT_BYTES) renameSync(path, `${path}.1`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const fd = openSync(path, "a", 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Audit log must be a regular file");
    writeSync(fd, line);
  } finally { closeSync(fd); }
}
