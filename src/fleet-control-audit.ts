import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { readProcessCommandLine } from "./fleet-lock.js";

/**
 * Who stopped / restarted / updated the fleet (#1120).
 *
 * 2026-10-03 01:19 an unplanned `agend restart` ran from inside an agent's shell
 * (a backtick in a `gh --body "..."` was command-substituted) and the only way
 * to find the source was journal timing plus a kiro transcript: the fleet.log
 * that would have said so is truncated by the restart itself. So the CLI writes
 * one line to its OWN file before it acts, and a fleet-wide stop / restart /
 * update started from a fleet agent's session — or from a test runner — has to
 * be confirmed or is refused.
 *
 * Observability and a guard rail only: this changes nothing about delivery,
 * authorisation or what a confirmed command does.
 */

export const AUDIT_FILE = "restart-audit.log";
const AUDIT_MAX_BYTES = 512 * 1024;

/** Set by the fleet's own spawn sites: an internal, already-authorised call. */
export const ORIGIN_ENV = "AGEND_RESTART_ORIGIN";
/** The environment for a child the fleet spawns to stop / restart / update itself. */
export function withOrigin(origin: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, [ORIGIN_ENV]: origin };
}

/** Escape hatch for a test that really means to run the CLI against a scratch fleet (exactly "1"). */
export const ALLOW_TEST_ENV = "AGEND_ALLOW_TEST_FLEET_CONTROL";

export type FleetControlAction =
  | "fleet-stop" | "fleet-restart" | "fleet-restart-reload"
  | "stop" | "restart" | "update"
  | "instance-stop" | "instance-restart";

export interface CallerProcess { pid: number; command: string }

export interface CallerInfo {
  pid: number;
  /** This process first, then its parents up to the init process (bounded). */
  chain: CallerProcess[];
  cwd: string;
  user: string;
  /** stdin is a terminal: an interactive shell, not a pipe or a command substitution. */
  tty: boolean;
  /** AGEND_INSTANCE_NAME: set in every fleet agent's session, and inherited by everything it runs. */
  instance: string | null;
  /** AGEND_RESTART_ORIGIN: the fleet's own spawn site, when it was one. */
  origin: string | null;
  ssh: boolean;
}

export type Verdict =
  | { ok: true; via: "interactive" | "yes" | "origin" }
  | { ok: false; reason: "agent-session" | "test-runner" };

/** Pure: may this call go ahead? `yes` is the explicit `--yes`. */
export function judgeFleetControl(env: NodeJS.ProcessEnv, yes: boolean): Verdict {
  // First, and even for the fleet's own spawn sites: a handler a test drives for real
  // must not reach the live fleet just because it set its origin (fleet decision bd0c88aa).
  const underTestRunner = !!env.VITEST || env.NODE_ENV === "test";
  if (underTestRunner && env[ALLOW_TEST_ENV] !== "1") return { ok: false, reason: "test-runner" };
  const origin = (env[ORIGIN_ENV] ?? "").trim();
  if (origin) return { ok: true, via: "origin" };
  if ((env.AGEND_INSTANCE_NAME ?? "").trim() && !yes) return { ok: false, reason: "agent-session" };
  return { ok: true, via: yes ? "yes" : "interactive" };
}

/**
 * May this command use `--force` (an override of a safety check, e.g. `agend restart --force`, #1450 C6)? Only an
 * operator's own shell: never a fleet agent's session (even confirmed with --yes) nor a fleet-internal spawn (origin).
 */
export function forceAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return !(env.AGEND_INSTANCE_NAME ?? "").trim() && !(env[ORIGIN_ENV] ?? "").trim();
}

function parentPid(pid: number): number {
  try {
    // "pid (comm) S ppid ..." — comm may contain spaces and parentheses.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number.parseInt(rest[1] ?? "", 10);
    return Number.isInteger(ppid) ? ppid : 0;
  } catch {
    return 0;
  }
}

export function describeCaller(env: NodeJS.ProcessEnv = process.env, maxDepth = 6): CallerInfo {
  const chain: CallerProcess[] = [];
  let pid = process.pid;
  for (let depth = 0; depth < maxDepth && pid > 0; depth++) {
    chain.push({ pid, command: readProcessCommandLine(pid).slice(0, 300) });
    const next = parentPid(pid);
    if (next <= 1 || next === pid) break;
    pid = next;
  }
  let user = "";
  try { user = env.USER ?? env.LOGNAME ?? ""; } catch { /* ignore */ }
  return {
    pid: process.pid,
    chain,
    cwd: (() => { try { return process.cwd(); } catch { return ""; } })(),
    user,
    tty: !!process.stdin.isTTY,
    instance: (env.AGEND_INSTANCE_NAME ?? "").trim() || null,
    origin: (env[ORIGIN_ENV] ?? "").trim() || null,
    ssh: !!(env.SSH_CONNECTION || env.SSH_TTY),
  };
}

export interface AuditEntry {
  ts: string;
  action: FleetControlAction;
  target?: string;
  outcome: "allowed" | "refused";
  detail?: string;
  caller: CallerInfo;
}

/** Best effort: an audit line must never be the reason a restart fails. */
export function appendAudit(dataDir: string, entry: AuditEntry): void {
  try {
    const path = join(dataDir, AUDIT_FILE);
    try {
      if (existsSync(path) && statSync(path).size > AUDIT_MAX_BYTES) renameSync(path, `${path}.1`);
    } catch { /* rotation is a nicety */ }
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch { /* unwritable data dir */ }
}

/** The newest entry written within `withinMs`, for the fleet to name in its own log. */
export function readRecentAudit(dataDir: string, withinMs: number, now = Date.now()): AuditEntry | null {
  try {
    const lines = readFileSync(join(dataDir, AUDIT_FILE), "utf8").trimEnd().split("\n");
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 20; i--) {
      try {
        const entry = JSON.parse(lines[i]!) as AuditEntry;
        if (entry.outcome !== "allowed") continue;
        // A routine instance stop/restart sends no signal to the fleet process: naming it
        // would blame the wrong request for a SIGUSR1/SIGTERM it did not cause.
        if (entry.action === "instance-stop" || entry.action === "instance-restart") continue;
        const age = now - Date.parse(entry.ts);
        if (age >= 0 && age <= withinMs) return entry;
      } catch { /* a torn line */ }
    }
  } catch { /* no audit file yet */ }
  return null;
}

/** What the fleet writes into its own log when a signal arrives: who asked, if the CLI said so lately. */
export function describeSignalSource(dataDir: string, signal: string, now = Date.now()): string {
  const entry = readRecentAudit(dataDir, 2 * 60_000, now);
  return entry
    ? `${signal}: requested by ${summariseCaller(entry)} at ${entry.ts}`
    : `${signal}: no fleet-control request recorded in the last 2 minutes (a service manager, \`kill\`, or a program that signals the process directly)`;
}

/** One-line form for a log message. */
export function summariseCaller(entry: AuditEntry): string {
  const parent = entry.caller.chain[1];
  return [
    `${entry.action}${entry.target ? ` ${entry.target}` : ""}`,
    entry.caller.instance ? `from agent session ${entry.caller.instance}` : null,
    entry.caller.origin ? `origin ${entry.caller.origin}` : null,
    parent ? `parent pid ${parent.pid} (${parent.command.slice(0, 120)})` : null,
  ].filter(Boolean).join(", ");
}

export function refusalMessage(action: FleetControlAction, reason: "agent-session" | "test-runner", instance: string | null): string {
  if (reason === "test-runner") {
    return `Refusing \`agend ${commandOf(action)}\`: it was started from a test runner and would act on the real fleet. `
      + `Stub the call, or set ${ALLOW_TEST_ENV}=1 if this really targets a scratch fleet.`;
  }
  return `Refusing \`agend ${commandOf(action)}\`: it was started from the fleet agent session "${instance}", and this stops the whole fleet and every instance in it.\n`
    + `If that is what you mean, run it again with --yes. If you did not mean to run it at all, a backtick or $(...) inside a quoted shell argument may have executed it.`;
}

function commandOf(action: FleetControlAction): string {
  switch (action) {
    case "fleet-stop": return "fleet stop";
    case "fleet-restart": return "fleet restart";
    case "fleet-restart-reload": return "fleet restart --reload";
    default: return action.replace("instance-", "fleet ");
  }
}

/**
 * The CLI's gate: record the call, then let it through or refuse it. Returns
 * whether to go ahead; the caller prints nothing and exits on `false`.
 */
export function gateFleetControl(
  dataDir: string,
  action: FleetControlAction,
  opts: { yes?: boolean; target?: string },
  env: NodeJS.ProcessEnv = process.env,
  report: (message: string) => void = message => console.error(message),
): boolean {
  const caller = describeCaller(env);
  const verdict = judgeFleetControl(env, !!opts.yes);
  appendAudit(dataDir, {
    ts: new Date().toISOString(),
    action,
    ...(opts.target ? { target: opts.target } : {}),
    outcome: verdict.ok ? "allowed" : "refused",
    ...(verdict.ok ? { detail: verdict.via } : { detail: verdict.reason }),
    caller,
  });
  // The origin marker authorises THIS command only. Left in the environment it would be
  // inherited by the replacement fleet the command starts, and by every agent that fleet
  // runs: a permanent exemption from the confirmation (#1158 review).
  delete env[ORIGIN_ENV];
  if (verdict.ok) return true;
  report(refusalMessage(action, verdict.reason, caller.instance));
  return false;
}

/** Instance-level stop/restart: recorded for the trail, never blocked (agents do this routinely). */
export function recordInstanceControl(dataDir: string, action: "instance-stop" | "instance-restart", target: string, env: NodeJS.ProcessEnv = process.env): void {
  appendAudit(dataDir, {
    ts: new Date().toISOString(), action, target, outcome: "allowed", caller: describeCaller(env),
  });
}

/**
 * The fleet's own entry points (a /restart or /update slash command, the full-restart
 * helper): written by the fleet process, so the signal or child it sends next can be
 * traced to the person who asked, not just to "the fleet itself".
 */
export function recordInternalRequest(dataDir: string, action: FleetControlAction, origin: string, env: NodeJS.ProcessEnv = process.env): void {
  appendAudit(dataDir, {
    ts: new Date().toISOString(), action, outcome: "allowed", detail: "origin",
    caller: describeCaller(withOrigin(origin, env)),
  });
}
