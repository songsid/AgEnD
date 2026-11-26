/**
 * M-3770 slice 2.1c part 2 (design update-transaction §6.2, §7): the independent recovery runner, `recover.cjs --run`,
 * and the pre-start step's launch of it.
 *
 * The runner acts for an attempt whose updater is gone:
 * 1. it refuses while the updater lives or can't be told gone, or while another runner of the attempt lives;
 * 2. it takes the same three locks as the updater, in the same order — home, prefix, service — each proven free or its
 *    holder proven gone (install-lock's owned reclaim); any failure releases what it took, in reverse;
 * 3. it records itself (`runner.json`: the bootstrap handshake's answer), then re-reads the journal under the locks;
 * 4. it acts on `recoveryPlan(…, "gone")`: a closing attempt is finished (`current` cleared); resuming an abandon, a
 *    rollback or a commit needs the restores of slice 2.3, so this kit refuses those and changes nothing;
 * 5. it releases the locks in reverse.
 *
 * The pre-start step, finding the owner gone, starts the runner OUTSIDE the service's cgroup and job (systemd-run's
 * transient unit; launchd's `submit` job), waits up to 10 s for its `runner.json`, and refuses this start either way.
 */
import { join } from "node:path";
import { acquireInstallLock, holderState, type InstallLock, type InstallLockDeps } from "../install-lock.js";
import { HOME_UPDATE_LOCK_FILE } from "../home-update-lock.js";
import { identityOf } from "../install-ownership.js";
import { finishClosing, readCurrent, readRunnerRecord, recoveryPlan, updaterState, writeRunnerRecord, type AttemptRecord, type JournalIo,
  type LivenessDeps } from "../update-journal.js";
import { kitDir, operatorCommand } from "./pre-start.js";

/** The service lock's file (service-lock.ts's SERVICE_LOCK_FILE; that module isn't bundled — it loads the home checks). */
export const SERVICE_LOCK_FILE = ".service.lock";

export interface RunnerDeps {
  pid: number;
  lock: Omit<InstallLockDeps, "pid">;
  liveness: LivenessDeps;
  io: JournalIo;
  err(line: string): void;
  out(line: string): void;
}

const startOf = (pid: number, d: RunnerDeps) => {
  const processStart = d.lock.processStart(pid);
  if (!processStart) return null;
  const ticks = d.lock.startTicks?.(pid) ?? null, boot = d.lock.bootId?.() ?? null;
  return { processStart, ...(ticks !== null && boot !== null ? { startTicks: ticks, bootId: boot } : {}) };
};

/** `recover.cjs --run`: 0 done (or nothing to do), 1 refused (words on stderr; nothing changed). */
export function runRecovery(home: string, attemptId: string, d: RunnerDeps): number {
  const refuse = (why: string) => { d.err(`AgEnD's update recovery for attempt ${attemptId} is refused: ${why}`); return 1; };
  const before = readCurrent(home, d.io);
  if (before.state === "none") { d.out("No AgEnD update attempt is open; there is nothing to recover."); return 0; }
  if (before.state === "unknown") return refuse(`the update journal can't be read (${before.reason}: ${before.path}). Run \`agend update --resolve\`.`);
  if (before.attempt.id !== attemptId) return refuse(`the journal's attempt is ${before.attempt.id}, not this kit's.`);
  if (before.state === "manual") return refuse("it needs manual recovery. Run `agend update --resolve`.");
  if (before.state === "open") {
    const updater = updaterState(before.attempt, d.liveness);
    if (updater === "live") return refuse("its updater is still running; the update owns it until it ends.");
    if (updater === "unknown") return refuse("whether its updater still runs can't be told; nothing is taken over.");
  }
  const runner = readRunnerRecord(home, attemptId, d.io);
  if (runner === "unreadable") return refuse("its recovery runner's record can't be read.");
  if (runner !== null && runner.pid !== d.pid) {
    const s = holderState({ pid: runner.pid, ...runner.start }, d.liveness);
    if (s !== "stale") return refuse(s === "live" ? `another recovery runner (pid ${runner.pid}) is acting for it.` : `whether its recovery runner (pid ${runner.pid}) still runs can't be told.`);
  }
  const prefix = identityOf(before.attempt)?.ownership.prefix;
  if (!prefix) return refuse("its recorded ownership (the npm prefix) is missing or malformed, so the prefix lock can't be taken.");

  // §3.4: home → prefix → service; released in reverse.
  const held: InstallLock[] = [];
  const releaseAll = () => { for (const l of held.reverse()) if (l.ok) l.release(); };
  const lockDeps: InstallLockDeps = { ...d.lock, pid: d.pid };
  // The service lock's record names the attempt (`attempt:<id>`): its token then admits this runner's own children.
  const locks: Array<[string, string, { file?: string; name?: string }]> = [
    [home, `recover:${attemptId}`, { file: HOME_UPDATE_LOCK_FILE, name: "home update lock" }],
    [prefix, `recover:${attemptId}`, {}],
    [home, `attempt:${attemptId}`, { file: SERVICE_LOCK_FILE, name: "service lock" }],
  ];
  for (const [dir, spec, opts] of locks) {
    const taken = acquireInstallLock(dir, { spec, agendHome: home }, lockDeps, opts);
    if (!taken.ok) { releaseAll(); return refuse(taken.reason); }
    held.push(taken);
  }
  try {
    const start = startOf(d.pid, d);
    if (!start) return refuse("this process's own start time can't be read, so it can't record itself.");
    writeRunnerRecord(home, attemptId, { pid: d.pid, start }, d.io);
    const read = readCurrent(home, d.io);                       // again, under the locks
    if (read.state === "none") { d.out("The attempt was closed meanwhile; nothing to recover."); return 0; }
    if (read.state === "unknown" || read.attempt.id !== attemptId) return refuse("the journal changed while the locks were taken.");
    const plan = recoveryPlan(read, "gone");
    switch (plan.kind) {
      case "finish-closing":
        finishClosing(home, read.attempt, d.io);
        d.out(`AgEnD update attempt ${attemptId} (${read.attempt.stage}) is closed.`);
        return 0;
      case "start": return 0;
      case "refuse": return refuse(plan.reason === "manual" ? "it needs manual recovery. Run `agend update --resolve`." : `the journal reads ${plan.reason}.`);
      default:
        // resume-abandoning / resume-rolling-back / resume-committing: the restores are slice 2.3's.
        return refuse(`it needs ${plan.kind.replace("resume-", "resuming ")} from ${read.attempt.stage}${plan.substep ? ` (${plan.substep})` : ""}, which this recovery kit can't do yet. Nothing was changed.`);
    }
  } finally {
    releaseAll();
  }
}

// ── The pre-start step's launch of the runner (§6.2) ──────────────────────────────────────────────────────────────

export interface LaunchDeps {
  /** Run a command to completion: its exit status (null: it couldn't be run). */
  run(command: string, args: string[]): number | null;
  sleep(ms: number): void;
  now(): number;
  uid(): number;
  liveness: LivenessDeps;
  io: JournalIo;
}

/** The command that starts the runner outside the service's cgroup and job, for the attempt's service manager. */
export function runnerLaunchCommand(home: string, attempt: AttemptRecord, uid: number): { command: string; args: string[] } | null {
  const service = identityOf(attempt)?.ownership.service;
  if (!service) return null;
  const kit = kitDir(home, attempt.id);
  const runner = [join(kit, "node"), join(kit, "recover.cjs"), "--home", home, "--attempt", attempt.id, "--run"];
  if (service.kind === "systemd") {
    return { command: "systemd-run", args: [...(uid !== 0 ? ["--user"] : []), `--unit=agend-update-recovery-${attempt.id}`, "--collect", "--property=KillMode=process", ...runner] };
  }
  return { command: "launchctl", args: ["submit", "-l", `com.agend.update-recovery.${attempt.id}`, "--", ...runner] };
}

/**
 * §6.2's bootstrap handshake, from the pre-start step: start the runner, then wait up to `waitMs` for its
 * `runner.json` naming a live process. The start is refused either way (the caller exits non-zero); the words say
 * whether a runner took over or the operator must run it.
 */
export function launchRunner(home: string, attempt: AttemptRecord, d: LaunchDeps, waitMs = 10_000): { started: true; pid: number } | { started: false; reason: string } {
  const cmd = runnerLaunchCommand(home, attempt, d.uid());
  const manual = `run ${operatorCommand(home, attempt.id)}`;
  if (!cmd) return { started: false, reason: `the attempt has no recorded service to start a runner beside; ${manual}` };
  const status = d.run(cmd.command, cmd.args);
  if (status !== 0) return { started: false, reason: `${cmd.command} couldn't start the recovery runner (${status === null ? "not run" : `exit ${status}`}); ${manual}` };
  const until = d.now() + waitMs;
  for (;;) {
    const r = readRunnerRecord(home, attempt.id, d.io);
    if (r !== null && r !== "unreadable" && holderState({ pid: r.pid, ...r.start }, d.liveness) === "live") return { started: true, pid: r.pid };
    if (d.now() >= until) return { started: false, reason: `the recovery runner didn't answer within ${Math.round(waitMs / 1000)} s; ${manual}` };
    d.sleep(200);
  }
}
