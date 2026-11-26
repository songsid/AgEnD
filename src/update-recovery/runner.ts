/**
 * M-3770 slice 2.1c part 2 (design update-transaction §6.2, §7): the independent recovery runner, `recover.cjs --run`,
 * and the pre-start step's launch of it.
 *
 * The runner acts for an attempt whose updater is gone:
 * 1. it refuses while the updater lives or can't be told gone, or while another runner of the attempt lives;
 * 2. it takes the same three locks as the updater, in the same order — home, prefix, service — each proven free or its
 *    holder proven gone (install-lock's owned reclaim); any failure releases what it took, in reverse;
 * 3. under the locks it checks everything again from fresh reads (the journal, the updater, any other runner, the
 *    recorded prefix — still the one it locked) and refuses, writing nothing, if any changed; only then does it record
 *    itself (`runner.json`: the bootstrap handshake's answer);
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
  type JournalRead, type LivenessDeps } from "../update-journal.js";
import { kitDir, operatorCommand } from "./pre-start.js";
import { rollBack } from "../update-rollback.js";
import { plistProgramArguments } from "../plist-args.js";
import type { OwnedService } from "../install-ownership.js";
import type { Exempt } from "../update-writers.js";
import type { ServiceManager } from "./service-manager.js";

/** The service lock's file (service-lock.ts's SERVICE_LOCK_FILE; that module isn't bundled — it loads the home checks). */
export const SERVICE_LOCK_FILE = ".service.lock";

export interface RunnerDeps {
  pid: number;
  lock: Omit<InstallLockDeps, "pid">;
  liveness: LivenessDeps;
  io: JournalIo;
  err(line: string): void;
  out(line: string): void;
  /** What resuming a rollback needs (S-252): the service manager, the takeover wait, the writers' proof. */
  hands?: RecoveryHands;
}

export interface RecoveryHands {
  /** The manager for the attempt's recorded service. */
  manager(service: OwnedService): ServiceManager;
  /** Wait for fleet.lock to hold a `fleet` record with this nonce: its pid, or null on timeout. */
  waitTakeover(nonce: string): number | null;
  /** §4.4 with the attempt's exempt set (its updater, this runner). */
  proveWritersGone(exempt: Exempt): { ok: true } | { ok: false; reason: string };
}

const startOf = (pid: number, d: RunnerDeps) => {
  const processStart = d.lock.processStart(pid);
  if (!processStart) return null;
  const ticks = d.lock.startTicks?.(pid) ?? null, boot = d.lock.bootId?.() ?? null;
  return { processStart, ...(ticks !== null && boot !== null ? { startTicks: ticks, bootId: boot } : {}) };
};

type Evidence = { ok: true; read: Exclude<JournalRead, { state: "none" | "unknown" }>; prefix: string } | { ok: false; done: boolean; words: string };

/**
 * Every check that decides whether this runner may act, from a fresh read: the journal (its attempt, not manual), the
 * updater (gone), any other runner (gone), and the recorded prefix. Run before the locks — to take nothing when it
 * refuses — and AGAIN under them, before anything is written (Prism #4515): evidence can change while they're taken.
 */
function evidence(home: string, attemptId: string, d: RunnerDeps): Evidence {
  const read = readCurrent(home, d.io);
  if (read.state === "none") return { ok: false, done: true, words: "No AgEnD update attempt is open; there is nothing to recover." };
  if (read.state === "unknown") return { ok: false, done: false, words: `the update journal can't be read (${read.reason}: ${read.path}). Run \`agend update --resolve\`.` };
  if (read.attempt.id !== attemptId) return { ok: false, done: false, words: `the journal's attempt is ${read.attempt.id}, not this kit's.` };
  if (read.state === "manual") return { ok: false, done: false, words: "it needs manual recovery. Run `agend update --resolve`." };
  if (read.state === "open") {
    const updater = updaterState(read.attempt, d.liveness);
    if (updater === "live") return { ok: false, done: false, words: "its updater is still running; the update owns it until it ends." };
    if (updater === "unknown") return { ok: false, done: false, words: "whether its updater still runs can't be told; nothing is taken over." };
  }
  const runner = readRunnerRecord(home, attemptId, d.io);
  if (runner === "unreadable") return { ok: false, done: false, words: "its recovery runner's record can't be read." };
  if (runner !== null && runner.pid !== d.pid) {
    const s = holderState({ pid: runner.pid, ...runner.start }, d.liveness);
    if (s !== "stale") return { ok: false, done: false, words: s === "live" ? `another recovery runner (pid ${runner.pid}) is acting for it.` : `whether its recovery runner (pid ${runner.pid}) still runs can't be told.` };
  }
  const prefix = identityOf(read.attempt)?.ownership.prefix;
  if (!prefix) return { ok: false, done: false, words: "its recorded ownership (the npm prefix) is missing or malformed, so the prefix lock can't be taken." };
  return { ok: true, read, prefix };
}

/** `recover.cjs --run`: 0 done (or nothing to do), 1 refused (words on stderr; nothing changed). */
export function runRecovery(home: string, attemptId: string, d: RunnerDeps): number {
  const refuse = (why: string) => { d.err(`AgEnD's update recovery for attempt ${attemptId} is refused: ${why}`); return 1; };
  const first = evidence(home, attemptId, d);
  if (!first.ok) { if (first.done) { d.out(first.words); return 0; } return refuse(first.words); }

  // §3.4: home → prefix → service; released in reverse.
  const held: InstallLock[] = [];
  const releaseAll = () => { for (const l of held.reverse()) if (l.ok) l.release(); };
  const lockDeps: InstallLockDeps = { ...d.lock, pid: d.pid };
  // The service lock's record names the attempt (`attempt:<id>`): its token then admits this runner's own children.
  const locks: Array<[string, string, { file?: string; name?: string }]> = [
    [home, `recover:${attemptId}`, { file: HOME_UPDATE_LOCK_FILE, name: "home update lock" }],
    [first.prefix, `recover:${attemptId}`, {}],
    [home, `attempt:${attemptId}`, { file: SERVICE_LOCK_FILE, name: "service lock" }],
  ];
  for (const [dir, spec, opts] of locks) {
    const taken = acquireInstallLock(dir, { spec, agendHome: home }, lockDeps, opts);
    if (!taken.ok) { releaseAll(); return refuse(taken.reason); }
    held.push(taken);
  }
  try {
    // Under the locks, the whole evidence again — before the handshake record or any journal write.
    const now = evidence(home, attemptId, d);
    if (!now.ok) { if (now.done) { d.out(`The attempt was closed meanwhile. ${now.words}`); return 0; } return refuse(`${now.words} (found again under the locks)`); }
    if (now.prefix !== first.prefix) return refuse(`its recorded npm prefix changed while the locks were taken (${first.prefix} → ${now.prefix}).`);
    const start = startOf(d.pid, d);
    if (!start) return refuse("this process's own start time can't be read, so it can't record itself.");
    writeRunnerRecord(home, attemptId, { pid: d.pid, start }, d.io);
    const read = now.read;
    const plan = recoveryPlan(read, "gone");
    switch (plan.kind) {
      case "finish-closing":
        finishClosing(home, read.attempt, d.io);
        d.out(`AgEnD update attempt ${attemptId} (${read.attempt.stage}) is closed.`);
        return 0;
      case "start": return 0;
      case "refuse": return refuse(plan.reason === "manual" ? "it needs manual recovery. Run `agend update --resolve`." : `the journal reads ${plan.reason}.`);
      case "resume-rolling-back": {
        // §6.2 runner steps 1–6 through the rollback driver (S-252): the refused start settled first.
        const service = identityOf(read.attempt)?.ownership.service ?? null;
        if (!d.hands) return refuse("this kit can't drive a rollback (no service manager given).");
        if (!service) return refuse("the attempt records no service to roll back through; start the previous version yourself, then run `agend update --resolve`.");
        const manager = d.hands.manager(service);
        if (!manager.waitSettled()) return refuse("the service's refused start hasn't settled; run the recovery again.");
        const self = { pid: d.pid, start };
        const res = rollBack(home, read.attempt, {
          self, liveness: d.liveness, isProcessAlive: pid => (d.liveness.exists ?? (() => true))(pid),
          proveWritersGone: () => d.hands!.proveWritersGone({ updater: read.attempt.updater, runner: self, helpers: [] }),
          plistArgs: plistProgramArguments, manager, waitTakeover: nonce => d.hands!.waitTakeover(nonce), io: d.io,
        });
        if (res.ok) { d.out(`AgEnD update attempt ${attemptId} is rolled back; the previous version runs again.`); return 0; }
        return refuse(`${res.reason}${res.manual ? " Run `agend update --resolve`." : " Run the recovery again."}`);
      }
      case "resume-committing":
        // §7 (rev 13): the new version's own fleet start finishes a commit; the old kit never does.
        return refuse(`it is committing ${read.attempt.to.version}, which only the new version's own fleet start finishes, never this recovery kit. Nothing was changed; if the fleet's start can't finish it, run \`agend update --resolve\`.`);
      default:
        // resume-abandoning: wired by a later S-252 part.
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
