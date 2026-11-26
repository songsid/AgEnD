/**
 * M-3770 slice 2.5 (design update-transaction §2.3, §4.2, §4.3, §5.6, §6.2; rev 13): the update driven forward by the
 * live updater — `opened` to `committed` — with its two ways back: abandon before the snapshot is published, the
 * rollback (update-rollback.ts) after it. The caller holds the three locks (home, prefix, service), has opened the
 * attempt with its proven ownership and the old fleet's generation, and releases the locks and the state lease after.
 *
 *   barrier     the fleet fences its inbound and checks again (2.2); busy → abandon (the old fleet was never stopped).
 *   stopping    the recovery kit built and, with a service, the route written and the manager reloaded (while the old
 *               fleet still runs, so every later start goes through the pre-start step); then the old fleet stopped
 *               only as the recorded `old` generation and its fleet.lock record re-taken as this attempt's fence
 *               (`ensureFence`), or the fence taken when no fleet holds it; the state lease drained. All before the
 *               snapshot, so a failure here still abandons, and a crash from here on reaches the runner (rev 13).
 *   snapshotted the home snapshotted (§5) with the writers proven gone; published.
 *   installing  the package preimage taken (§6.3) and the intent journaled; npm runs; the new tuple recorded.
 *   trial       the `trial` generation planned, handed off, started and acknowledged (`startGeneration`).
 *   proving     the trial fleet proves itself (2.4).
 *   committing  substeps, each journaled after its effect (`commitAttempt`, also the resume after a crash):
 *               `retained` (§5.6, Go back's artifacts), `route-removed` (+ reload), then the fleet's own: `left-trial`,
 *               `agents-started`, `inbox-delivered`, `deferred-run`. Then `committed`.
 *
 * Any failure before `snapshotted` runs the recorded abandon procedure (`abandonAttempt`): `restart-old` (the old
 * generation started from the fence, when it was stopped), `hand-back`, the route off, `abandoned`. From `snapshotted`
 * through `proving` it rolls back (`rollBack`). An identity check that fails after the install is manual-recovery.
 */
import { acquireFleetLock, readFleetLockRecord, type FleetLockHandle } from "./fleet-lock.js";
import { checkStage, identityOf, recordExpectedNew, recordInstallIntent, type Ownership, type Proven, type TupleRead } from "./install-ownership.js";
import { ackGeneration, advance, attemptDir, defaultJournalIo, finish, readCurrent, substep, type AttemptRecord, type Artifact, type FleetGeneration, type JournalIo } from "./update-journal.js";
import { takeAttemptPreimage } from "./update-package-restore.js";
import { buildRecoveryKit, type KitSources } from "./update-recovery/kit.js";
import { removeRecoveryRoute, writeRecoveryRoute } from "./update-recovery/route.js";
import { markRetainedUsed, recordRetained } from "./update-retained.js";
import { abandonAttempt, journalManual as manual, type UpdateResult } from "./update-abandon.js";
import { ensureFence, rollBack, startGeneration, type RollbackDeps } from "./update-rollback.js";
import { takeSnapshot } from "./update-snapshot.js";

type Check = { ok: true } | { ok: false; reason: string };

/** The fleet's own commit steps (2.4/2.5's trial fleet), each done once; a retry after a crash finds it done and says true. */
export interface CommitHands {
  leaveTrial(): boolean;
  startAgents(): boolean;
  deliverInbox(): boolean;
  runDeferred(): boolean;
}

export interface UpdateDeps extends RollbackDeps {
  /** §2.3 / 2.2: the old fleet fences its inbound and checks again; not idle (or no answer) → abandon. */
  barrier(attempt: AttemptRecord): Check;
  /** §4.2 step 3: `BEGIN EXCLUSIVE` on the state lease (60 s drain); the caller keeps it to the terminal write. */
  drain(): Check;
  /** The Node and the bundle the kit is built from (the running, old install's). */
  kit: KitSources;
  /** npm installs `plan.target` (the caller's install and its verification). */
  install(): Check;
  /** §3.1–§3.2: ownership re-proven and the live tuple read, for `checkStage` before each mutation. */
  live(): { ownership: Proven<Ownership>; tuple: TupleRead };
  /** 2.4: the trial fleet (its pid) proves itself. */
  prove(trialPid: number): Check;
  commit: CommitHands;
  /** Abandon's `hand-back`: the old fleet takes the inbox and the deferred jobs back and acknowledges them (2.2). */
  handBack(attempt: AttemptRecord): boolean;
  /** §5.7 Go back (rev 16): checked at snapshotted → installing, with the fresh snapshot taken; a refusal rolls back. */
  beforeInstall?(attempt: AttemptRecord): Check;
}

export interface UpdatePlan { target: Artifact; command: string[] }

export type { UpdateResult } from "./update-abandon.js";
export { abandonAttempt } from "./update-abandon.js";

const generationsOf = (a: AttemptRecord): FleetGeneration[] => (Array.isArray(a.fleets) ? (a.fleets as FleetGeneration[]) : []);
const didSubstep = (a: AttemptRecord, stage: string, name: string) => a.history.some(h => h.stage === stage && h.substep === name);

/** Drive `attempt` (stage `opened`) forward. */
export function runUpdate(home: string, attempt: AttemptRecord, plan: UpdatePlan, d: UpdateDeps): UpdateResult {
  const io = d.io ?? defaultJournalIo;
  let a = attempt;
  const id = identityOf(a);
  if (!id) return manual(home, a, "the attempt's recorded ownership is missing or malformed", io);
  if (a.stage !== "opened") throw new Error(`attempt ${a.id} is ${a.stage}; the forward driver starts at opened`);
  const abandon = (reason: string, fence: FleetLockHandle | null = null) => abandonAttempt(home, a, d, reason, fence);
  const back = (reason: string) => rollBackAs(home, a, d, reason, io);
  const check = (): Check & { manual?: boolean } => {
    const c = checkStage(a, d.live());
    return c.ok ? { ok: true } : { ok: false, reason: c.reason, manual: c.to === "manual-recovery" };
  };

  // barrier: the old fleet fences and checks again while the attempt is still `opened` (§2.3: its outbox prefix is written
  // at opened; the mailbox's barrier.arm is valid only there), then the stage records that it holds.
  const b = d.barrier(a);
  if (!b.ok) return abandon(b.reason);
  a = advance(home, a, "barrier", {}, io);

  // stopping: the old fleet, the fence, the drain, the kit and the route
  a = advance(home, a, "stopping", {}, io);
  const c0 = check();
  if (!c0.ok) return abandon(c0.reason);
  // The kit and the route first, while the old fleet still runs: every later start — abandon's restart of the old
  // generation included — goes through the pre-start step, which hands its nonce on (§6.2).
  const kit = buildRecoveryKit(home, a.id, d.kit, io);
  if (!kit.ok) return abandon(`the recovery kit can't be built: ${kit.reason}`);
  if (id.ownership.service) {
    const route = writeRecoveryRoute(home, a, { plistArgs: d.plistArgs }, io);
    if (!route.ok) return abandon(`the recovery route can't be written: ${route.reason}`);
    if (!d.manager.reload()) return abandon("the service manager couldn't reload with the recovery route");
  }
  let fence: FleetLockHandle;
  if (readFleetLockRecord(home) === null) {
    // No fleet holds the lock: none ran when the attempt opened, or the old one has exited since (proven gone first).
    const old = generationsOf(a).find(g => g.gen === "old" && !g.dead);
    if (old?.pid !== undefined) {
      if (d.isProcessAlive(old.pid)) return abandon(`the old fleet (pid ${old.pid}) runs without holding fleet.lock`);
      a = ackGeneration(home, a, old.nonce, old.pid, { dead: true }, io);
    }
    try { fence = acquireFleetLock(home, { pid: d.self.pid, role: "update", attemptId: a.id, isProcessAlive: d.isProcessAlive }); }
    catch (err) { return abandon(`fleet.lock can't be taken as this attempt's fence (${(err as Error).message})`); }
  } else {
    const f = ensureFence(home, a, d);
    a = f.attempt;
    if (!f.ok) return abandon(f.reason);
    fence = f.handle;
  }
  const drained = d.drain();
  if (!drained.ok) return abandon(drained.reason, fence);

  // snapshotted
  const snap = takeSnapshot(home, attemptDir(home, a.id), { proveWritersGone: d.proveWritersGone });
  if (!snap.ok) return abandon(`the snapshot failed: ${snap.reason}`, fence);
  a = advance(home, a, "snapshotted", {}, io);
  if (d.beforeInstall) {
    const gate = d.beforeInstall(a);
    if (!gate.ok) return back(gate.reason);
  }

  // installing
  const pre = takeAttemptPreimage(id.ownership, a.id);
  if (!pre.ok) return back(`the package preimage can't be taken: ${pre.reason}`);
  a = advance(home, a, "installing", {}, io);
  const c1 = check();
  if (!c1.ok) return c1.manual ? manual(home, a, c1.reason, io) : back(c1.reason);
  a = recordInstallIntent(home, a, {
    preimage: { dir: pre.dir, manifestSha256: pre.manifestSha256 },
    destination: { packagePath: id.ownership.packagePath, binLinks: Object.values(id.ownership.binLinks) },
    target: plan.target, command: plan.command,
  }, io);
  const installed = d.install();
  if (!installed.ok) return back(`the install failed: ${installed.reason}`);
  const now = d.live();
  if (now.tuple.state !== "complete") return back(`the install left a partial package (${now.tuple.reason})`);
  if (now.tuple.tuple.version !== plan.target.version) return back(`the install put ${now.tuple.tuple.version} in place, not ${plan.target.version}`);
  a = recordExpectedNew(home, a, now.tuple.tuple, io);

  // trial
  a = advance(home, a, "trial", {}, io);
  const c2 = check();
  if (!c2.ok) return c2.manual ? manual(home, a, c2.reason, io) : back(c2.reason);
  const trial = startGeneration(home, a, "trial", fence, d);
  a = trial.attempt;
  if (!trial.ok) {
    // A start still on its way is stopped before the rollback replans the handoff (its claim then fails, revoked).
    d.manager.stop();
    return back(`the trial fleet didn't come up: ${trial.reason}`);
  }
  const trialPid = generationsOf(a).find(g => g.gen === "trial" && g.consumed && !g.dead)!.pid!;

  // proving
  a = advance(home, a, "proving", {}, io);
  const proved = d.prove(trialPid);
  if (!proved.ok) return back(`the new version didn't prove itself: ${proved.reason}`);

  // committing
  a = advance(home, a, "committing", {}, io);
  return commitAttempt(home, a, d);
}

/**
 * §2.3 committing, by substep — the live updater's commit, and the resume after a crash (the fleet start's §7 row).
 * Never rolls back: a step that fails leaves the attempt in committing, to be resumed.
 */
export function commitAttempt(home: string, attempt: AttemptRecord, d: Pick<UpdateDeps, "commit" | "manager" | "plistArgs" | "io">): UpdateResult {
  const io = d.io ?? defaultJournalIo;
  let a = attempt;
  if (a.stage !== "committing") throw new Error(`attempt ${a.id} is ${a.stage}, not committing`);
  const id = identityOf(a);
  if (!id) return manual(home, a, "the attempt's recorded ownership is missing or malformed", io);
  const retry = (reason: string): UpdateResult => ({ ok: false, outcome: "retry", reason, attempt: a });
  const step = (name: string, run: () => boolean | string): UpdateResult | null => {
    if (didSubstep(a, "committing", name)) return null;
    const r = run();
    if (r !== true) return retry(typeof r === "string" ? r : `the commit step ${name} didn't complete; it resumes on the next start`);
    a = substep(home, a, name, io);
    return null;
  };
  const steps: [string, () => boolean | string][] = [
    // A go-back is not itself go-back-able: it consumes the committed entry it returned to instead (rev 16).
    ["retained", () => {
      if (a.kind === "go-back") { const r = markRetainedUsed(home, a.goBackOf!, a.id, io); return r.ok || `the Go back entry can't be marked used: ${r.reason}`; }
      const r = recordRetained(home, a, io); return r.ok || `Go back can't be recorded: ${r.reason}`;
    }],
    ["route-removed", () => {
      if (!id.ownership.service) return true;
      const r = removeRecoveryRoute(home, a, { plistArgs: d.plistArgs }, io);
      if (!r.ok) return r.reason;
      return d.manager.reload() || "the service manager couldn't reload after the route was taken off";
    }],
    ["left-trial", () => d.commit.leaveTrial()],
    ["agents-started", () => d.commit.startAgents()],
    ["inbox-delivered", () => d.commit.deliverInbox()],
    ["deferred-run", () => d.commit.runDeferred()],
  ];
  for (const [name, run] of steps) { const r = step(name, run); if (r) return r; }
  a = finish(home, a, { kind: "committed", reason: `updated to ${a.to.version}` }, io);
  return { ok: true, attempt: a };
}

/**
 * §7 (rev 13): the fleet start that `fleetStartGate` admitted for an interrupted commit finishes it with its own commit
 * hands — the attempt the journal names, if it is still this one and committing (null: nothing to resume). The caller
 * holds the home lock and fleet.lock.
 */
export function resumeCommitting(home: string, attemptId: string, d: Pick<UpdateDeps, "commit" | "manager" | "plistArgs" | "io">): UpdateResult | null {
  const read = readCurrent(home, d.io ?? defaultJournalIo);
  if (read.state !== "open" || read.attempt.id !== attemptId || read.attempt.stage !== "committing") return null;
  return commitAttempt(home, read.attempt, d);
}

function rollBackAs(home: string, attempt: AttemptRecord, d: UpdateDeps, reason: string, io: JournalIo): UpdateResult {
  const r = rollBack(home, attempt, d);
  if (r.ok) return { ok: false, outcome: "rolled-back", reason, attempt: r.attempt };
  if (r.manual) return manual(home, r.attempt, `${reason}; the rollback needs a person: ${r.reason}`, io);
  return { ok: false, outcome: "retry", reason: `${reason}; the rollback stopped: ${r.reason}`, attempt: r.attempt };
}
