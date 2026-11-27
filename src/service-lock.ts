/**
 * M-3770 slice 2.1b (design update-transaction §3.4): the service lock, `<home>/.service.lock` — the same owned-lock
 * mechanism as the prefix and home locks (install-lock.ts). The updater takes it third (home → prefix → service) and
 * holds it through an attempt. `agend start`, `stop`, `restart` and `install` take it briefly; while a live updater holds
 * it they are refused at once with the attempt and its stage — nothing is queued. A child the updater spawns to act on
 * the service is admitted by the lock record's token (`AGEND_SERVICE_LOCK_TOKEN`), only while that live holder is the
 * one that wrote it.
 */
import { ensureAgendHome } from "./agend-home.js";
import { join } from "node:path";
import { acquireInstallLock, sameStartText, type InstallLock, type InstallLockDeps } from "./install-lock.js";
import { lockHolderAt } from "./home-update-lock.js";
import { readCurrent, readRunnerRecord, type ProcessStartRecord } from "./update-journal.js";

export const SERVICE_LOCK_FILE = ".service.lock";
export const SERVICE_LOCK_TOKEN_ENV = "AGEND_SERVICE_LOCK_TOKEN";
export const serviceLockPath = (home: string) => join(home, SERVICE_LOCK_FILE);
const NAME = "service lock";

/** The updater's hold for an attempt: its record names the attempt (`targetSpec` = `attempt:<id>`). */
export function acquireServiceLock(home: string, attemptId: string, deps: InstallLockDeps): InstallLock {
  return acquireInstallLock(home, { spec: `attempt:${attemptId}`, agendHome: home }, deps, { file: SERVICE_LOCK_FILE, name: NAME });
}

export type ServiceAdmission = { ok: true; release(): void; viaToken: boolean } | { ok: false; reason: string };

/**
 * A service command's admission. Free (or a proven-stale holder): taken now, released by the caller when the command
 * ends. Held by a live updater: admitted only with that holder's token; otherwise refused, naming the attempt and its
 * stage. A holder that can't be told live or gone, or a record that can't be read, refuses too (the words name the
 * lock and the way out) — a service command never guesses that an update is over.
 *
 * A home that doesn't exist yet is created first (private, by the same checks as every start) and then admitted the
 * normal way (Prism #4499): "no home" observed once is no proof that an update won't create it and lock it a moment
 * later, while this command still runs.
 *
 * The token admits only the open attempt's own updater's child: the live holder's record is `attempt:<id>`, `current`
 * names that attempt open, and the holder is that attempt's updater or its recorded recovery runner (pid and start).
 */
export function admitServiceCommand(home: string, command: string, deps: InstallLockDeps, env: NodeJS.ProcessEnv = process.env): ServiceAdmission {
  try { ensureAgendHome(home); }
  catch (err) { return { ok: false, reason: `\`agend ${command}\` is refused: the AgEnD home ${home} can't be used (${(err as Error).message}).` }; }
  const path = serviceLockPath(home);
  const holder = lockHolderAt(path, deps);
  if (holder.state === "live") {
    const token = env[SERVICE_LOCK_TOKEN_ENV];
    if (token && token === holder.record.token && tokenBound(home, holder.record)) return { ok: true, release: () => {}, viaToken: true };
    return { ok: false, reason: refusal(home, command, holder.record.targetSpec) };
  }
  if (holder.state === "unknown" || holder.state === "unreadable") {
    return { ok: false, reason: `\`agend ${command}\` is refused: the service lock ${path} is held by a process that can't be told live or gone. If no \`agend update\` is running, run \`agend update --resolve\`.` };
  }
  const taken = acquireInstallLock(home, { spec: `command:${command}`, agendHome: home }, deps, { file: SERVICE_LOCK_FILE, name: NAME });
  if (!taken.ok) return { ok: false, reason: `\`agend ${command}\` is refused: ${taken.reason}` };
  return { ok: true, release: taken.release, viaToken: false };
}

/**
 * The live holder is the open attempt's updater: `attempt:<id>`, `current` open on that id, and the same process — pid,
 * lstart, and the start ticks and boot id whenever either side recorded them (both or neither; Prism #4499 R2).
 */
function tokenBound(home: string, record: { pid: number; processStart: string; targetSpec: string; startTicks?: string; bootId?: string }): boolean {
  const id = /^attempt:(.+)$/.exec(record.targetSpec)?.[1];
  if (!id) return false;
  const read = readCurrent(home);
  if (read.state !== "open" || read.attempt.id !== id) return false;
  // The holder is the attempt's updater, or the recovery runner recorded for it (§6.2) — by its full identity.
  const same = (who: { pid: number; start: ProcessStartRecord }) => who.pid === record.pid && sameStartText(who.start.processStart, record.processStart)
    && who.start.startTicks === record.startTicks && who.start.bootId === record.bootId;
  if (same(read.attempt.updater)) return true;
  const runner = readRunnerRecord(home, id);
  return runner !== null && runner !== "unreadable" && same(runner);
}

function refusal(home: string, command: string, spec: string): string {
  const attemptId = /^attempt:(.+)$/.exec(spec)?.[1];
  if (!attemptId) return `\`agend ${command}\` is refused: another \`agend\` command is acting on the service (${spec}); try again when it ends.`;
  const read = readCurrent(home);
  const stage = read.state === "open" || read.state === "manual" || read.state === "closing" ? read.attempt.stage : read.state;
  return `\`agend ${command}\` is refused: AgEnD is updating (attempt ${attemptId}, ${stage}). The update owns the service until it ends.`;
}
