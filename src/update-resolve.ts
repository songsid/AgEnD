/**
 * M-3770 slice 2.5, wiring part 6 (design update-wiring-m3770.md §6, §15; Fable's conditions): `agend update --resolve`
 * and `--recover`.
 *   --resolve                  reports the journal and the exact next step (a closing journal is closed);
 *   --resolve --clear <value>  the only thing that clears a manual-recovery `current` (the attempt's id, confirmed by
 *                              value) or sets an unknown one aside (the exact path --resolve printed) — under the home
 *                              lock, never while an owner is live or unknown; the attempt's recovery route is taken off
 *                              too (or the command to do it is said), and what wasn't checked is said;
 *   --recover                  an open attempt whose owner is PROVEN gone: in the kit's stages, its runner (run beside
 *                              the service, never as a child of this terminal); in committing before the route is off,
 *                              the route's removal with this caller's rights, journaled — the fleet finishes the rest.
 * Every effect is injected; the CLI passes the real ones.
 */
import { join } from "node:path";
import { HOME_UPDATE_LOCK_FILE } from "./home-update-lock.js";
import { acquireInstallLock, type InstallLock, type InstallLockDeps } from "./install-lock.js";
import { identityOf } from "./install-ownership.js";
import { defaultJournalIo, finishClosing, ownerState, readCurrent, resolveManual, setAsideUnknownCurrent, substep, attemptDir,
  type AttemptRecord, type JournalIo, type LivenessDeps } from "./update-journal.js";
import { verifyRecoveryKit } from "./update-recovery/kit.js";
import { removeRecoveryRoute } from "./update-recovery/route.js";
import { runnerLaunchCommand } from "./update-recovery/runner.js";
import { operatorCommand } from "./update-recovery/pre-start.js";

export interface ResolveDeps {
  liveness: LivenessDeps;
  lockDeps: InstallLockDeps;
  /** This caller's uid (the attempt's owner must be the same, and root for a system unit). */
  uid: number;
  /** The attempt's service manager reload, with this caller's rights (false: it couldn't). */
  reload(service: { kind: "systemd" | "launchd"; unit: string; fragmentPath: string }): boolean;
  plistArgs(xml: string): string[] | null;
  /**
   * Fable part 6: a user unit's runner is started with `systemd-run --user`, which needs this user's bus — absent under
   * `sudo -u`, some ssh sessions, or without lingering. The environment that reaches it (XDG_RUNTIME_DIR named
   * explicitly, never the caller's), or why it can't be reached.
   */
  userBus?(): { ok: true; env: Record<string, string> } | { ok: false; reason: string };
  io?: JournalIo;
}
export interface Said { lines: string[]; exitCode: number }

/** The stages the recovery kit's runner resumes (it refuses committing: the new fleet finishes that, §7). */
const KIT_STAGES = new Set(["opened", "barrier", "stopping", "snapshotted", "installing", "trial", "proving", "abandoning", "rolling-back"]);

const homeLock = (home: string, spec: string, d: ResolveDeps): InstallLock =>
  acquireInstallLock(home, { spec, agendHome: home }, d.lockDeps, { file: HOME_UPDATE_LOCK_FILE, name: "home update lock" });
const describe = (a: AttemptRecord) => `update attempt ${a.id}: ${a.from.version} → ${a.to.version}, ${a.stage}${a.substep ? ` (${a.substep})` : ""}`;
const routeOff = (a: AttemptRecord) => a.history.some(h => h.stage === "committing" && h.substep === "route-removed");

function lastNote(a: AttemptRecord): string[] {
  const note = [...a.history].reverse().find(h => h.note)?.note ?? (a as { outcome?: { reason?: string } }).outcome?.reason;
  return note ? [`  Why: ${note}`] : [];
}

/** `agend update --resolve`: what the journal says, and the one next step. */
export function resolveReport(home: string, d: ResolveDeps): Said {
  const io = d.io ?? defaultJournalIo;
  const read = readCurrent(home, io);
  switch (read.state) {
    case "none": return { lines: ["  Nothing to resolve: no update is in progress."], exitCode: 0 };
    case "closing": {
      const lock = homeLock(home, "resolve", d);
      if (!lock.ok) return { lines: [`  The last update (${read.attempt.id}) is closing; ${lock.reason}`], exitCode: 1 };
      try { const again = readCurrent(home, io); if (again.state === "closing") finishClosing(home, again.attempt, io); }
      finally { lock.release(); }
      return { lines: [`  The last update (${read.attempt.id}, ${read.attempt.stage}) is closed now. Nothing else to resolve.`], exitCode: 0 };
    }
    case "unknown":
      return { lines: [`  The update journal can't be read: ${read.reason}.`, `  Its pointer: ${join(home, ".update-journal", "current")}`,
        `  Look at it; once the install and the fleet are as they should be, run: agend update --resolve --clear ${join(home, ".update-journal", "current")}`], exitCode: 1 };
    case "manual":
      return { lines: [`  ${describe(read.attempt)} — it needs a person.`, ...lastNote(read.attempt), `  Its record: ${attemptDir(home, read.attempt.id)}`,
        `  Put the install and the fleet right (the record has what it did), then run: agend update --resolve --clear ${read.attempt.id}`], exitCode: 1 };
    case "open": {
      const a = read.attempt, owner = ownerState(home, a, d.liveness, io);
      const head = `  ${describe(a)}.`;
      if (owner === "live") return { lines: [head, "  Its update is still running: wait for it."], exitCode: 0 };
      if (owner === "unknown") return { lines: [head, "  Whether its update still runs can't be told; nothing is done while it can't."], exitCode: 1 };
      if (a.stage === "committing") {
        return routeOff(a) ? { lines: [head, "  The new fleet finishes it when it starts (or within a minute, if it runs)."], exitCode: 0 }
          : { lines: [head, "  The new fleet finishes it once the recovery route is off: run `agend update --recover` with the service's rights."], exitCode: 1 };
      }
      return { lines: [head, "  Its update stopped. Run: agend update --recover"], exitCode: 1 };
    }
  }
}

/** The attempt's recovery route off, with this caller's rights — or the command a person with them runs. */
function takeRouteOff(home: string, a: AttemptRecord, d: ResolveDeps, io: JournalIo): { ok: true; lines: string[] } | { ok: false; lines: string[] } {
  const service = identityOf(a)?.ownership.service ?? null;
  if (!service) return { ok: true, lines: [] };
  const off = removeRecoveryRoute(home, a, { plistArgs: d.plistArgs }, io);
  if (!off.ok) return { ok: false, lines: [`  ⚠ The recovery route on ${service.unit} is still there: ${off.reason}. Remove it with the service's rights (agend update --recover).`] };
  if (!d.reload(service)) {
    return { ok: false, lines: [`  ⚠ The recovery route on ${service.unit} is off (${off.path}), but the service manager couldn't reload: run \`systemctl${d.uid !== 0 ? " --user" : ""} daemon-reload\`.`] };
  }
  return { ok: true, lines: [`  ✓ The recovery route on ${service.unit} is off.`] };
}

/** `agend update --resolve --clear <value>`: the value confirms what the person looked at — the attempt id, or the path. */
export function resolveClear(home: string, value: string, d: ResolveDeps): Said {
  const io = d.io ?? defaultJournalIo;
  const lock = homeLock(home, "resolve --clear", d);
  if (!lock.ok) return { lines: [`  ✗ Not cleared: ${lock.reason}`], exitCode: 1 };
  try {
    const read = readCurrent(home, io);
    if (read.state === "none") return { lines: ["  Nothing to clear."], exitCode: 0 };
    if (read.state === "open" || read.state === "closing") return { lines: [`  ✗ Not cleared: ${describe(read.attempt)} isn't one a person clears — run: agend update --resolve`], exitCode: 1 };
    const unchecked = (where: string) => `  Nothing about the home or the installed package was checked; ${where}`;
    if (read.state === "unknown") {
      const pointer = join(home, ".update-journal", "current");
      if (value !== pointer) return { lines: [`  ✗ Not cleared: confirm the journal pointer --resolve named, exactly: agend update --resolve --clear ${pointer}`], exitCode: 1 };
      const aside = setAsideUnknownCurrent(home, io);
      return { lines: [`  ✓ The unreadable journal pointer was moved aside to ${aside}; updates and fleet starts are admitted again.`,
        unchecked(`the journal is in ${join(home, ".update-journal")}. If an attempt left a recovery route on the service, remove it by hand.`)], exitCode: 0 };
    }
    const a = read.attempt;
    if (value !== a.id) return { lines: [`  ✗ Not cleared: confirm the attempt --resolve named, by its id: agend update --resolve --clear ${a.id}`], exitCode: 1 };
    const owner = ownerState(home, a, d.liveness, io);
    if (owner !== "gone") return { lines: [`  ✗ Not cleared: the attempt's ${owner === "live" ? "updater or runner still runs" : "updater or runner can't be told gone"}.`], exitCode: 1 };
    resolveManual(home, a, `resolved by a person (uid ${d.uid}, confirmed ${value}) at ${io.now().toISOString()}`, io);
    const route = takeRouteOff(home, a, d, io);
    return { lines: [`  ✓ ${a.id} is resolved; updates and fleet starts are admitted again.`, ...route.lines,
      unchecked(`the attempt's record and snapshot are in ${attemptDir(home, a.id)}.`)], exitCode: 0 };
  } finally {
    lock.release();
  }
}

export type RecoverPlan =
  | { kind: "run"; command: string; args: string[]; env?: Record<string, string> }
  | { kind: "said"; said: Said };

/**
 * `agend update --recover`, for an open attempt whose owner is PROVEN gone, by this caller only when it is the attempt's
 * owner (its uid — root for a system unit): the kit's stages run the kit's runner beside the service (systemd-run,
 * waited on, its output here), never a child of this terminal; committing before the route is off takes the route off
 * under the home lock and journals it — the fleet's next pass finishes the commit.
 */
export function recoverAttempt(home: string, d: ResolveDeps): RecoverPlan {
  const io = d.io ?? defaultJournalIo;
  const read = readCurrent(home, io);
  if (read.state !== "open") return { kind: "said", said: resolveReport(home, d) };
  const a = read.attempt, owner = ownerState(home, a, d.liveness, io);
  if (owner !== "gone") return { kind: "said", said: { lines: [`  ✗ Not recovered: ${describe(a)}; its update ${owner === "live" ? "still runs" : "can't be told gone"}.`], exitCode: 1 } };
  const id = identityOf(a);
  if (!id) return { kind: "said", said: { lines: [`  ✗ Not recovered: ${describe(a)}; its recorded ownership can't be read. Run: agend update --resolve`], exitCode: 1 } };
  if (id.ownership.uid !== d.uid) {
    return { kind: "said", said: { lines: [`  ✗ Not recovered: the attempt belongs to uid ${id.ownership.uid}${id.ownership.uid === 0 ? " (root, a system service)" : ""}; run it as that user, not uid ${d.uid}.`], exitCode: 1 } };
  }
  if (a.stage === "committing") {
    if (routeOff(a)) return { kind: "said", said: resolveReport(home, d) };
    const lock = homeLock(home, "recover", d);
    if (!lock.ok) return { kind: "said", said: { lines: [`  ✗ Not recovered now: ${lock.reason} (the fleet may be finishing it; try again in a minute).`], exitCode: 1 } };
    try {
      const again = readCurrent(home, io);
      if (again.state !== "open" || again.attempt.id !== a.id || again.attempt.stage !== "committing" || routeOff(again.attempt)) return { kind: "said", said: resolveReport(home, d) };
      const route = takeRouteOff(home, again.attempt, d, io);
      if (!route.ok) return { kind: "said", said: { lines: [`  ✗ ${describe(a)}.`, ...route.lines], exitCode: 1 } };
      substep(home, again.attempt, "route-removed", io);
      return { kind: "said", said: { lines: [...route.lines, "  The new fleet finishes the update within a minute (or when it next starts)."], exitCode: 0 } };
    } finally {
      lock.release();
    }
  }
  if (!KIT_STAGES.has(a.stage)) return { kind: "said", said: resolveReport(home, d) };
  const kit = verifyRecoveryKit(home, a.id);
  if (!kit.ok) return { kind: "said", said: { lines: [`  ✗ Not recovered: the attempt's recovery kit can't be used (${kit.reason}). Run: agend update --resolve`], exitCode: 1 } };
  const launch = runnerLaunchCommand(home, a, d.uid);
  if (!launch) {
    return { kind: "said", said: { lines: [`  ✗ Not recovered here: ${describe(a)} records no service to recover beside; its runner refuses a detached fleet.`,
      `  Start the previous version yourself, then run: agend update --resolve. (The runner, for reference: ${operatorCommand(home, a.id)})`], exitCode: 1 } };
  }
  // systemd: waited on, its output piped here; the runner's own starts go through the service manager.
  const args = launch.command === "systemd-run" ? [...launch.args.slice(0, launch.args.indexOf("--collect")), "--wait", "--pipe", ...launch.args.slice(launch.args.indexOf("--collect"))] : launch.args;
  if (launch.command === "systemd-run" && launch.args[0] === "--user") {
    const bus = d.userBus?.() ?? { ok: false as const, reason: "this user's bus wasn't looked for" };
    if (!bus.ok) {
      return { kind: "said", said: { lines: [`  ✗ Not recovered from here: this user's systemd bus can't be reached (${bus.reason}).`,
        `  Run it from a login session of uid ${d.uid} (not sudo -u): agend update --recover`, `  Or the runner itself, in that session: ${operatorCommand(home, a.id)}`], exitCode: 1 } };
    }
    return { kind: "run", command: launch.command, args, env: bus.env };
  }
  return { kind: "run", command: launch.command, args };
}
