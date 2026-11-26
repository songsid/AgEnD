/**
 * M-3770 slice 2.5 (design update-transaction §5.5, §6.2, §6.3, §3.3, §4.3): the rollback, driven end to end — by the
 * live updater when the trial fails, or by the recovery runner for a dead one. Every step is journaled after its
 * effect (or recognised on a retry), so a crash anywhere resumes at the step recorded.
 *
 *   1. `rolling-back` published (from snapshotted, installing, trial or proving).
 *   2. The fence: `fleet.lock` must be this attempt's `update` record. A live trial fleet holding it is stopped first —
 *      only when it is the recorded `trial` generation (§3.3 `stopTarget`) — and its dead record re-taken; a dead
 *      generation's record is re-taken; a dead updater's fence is adopted by the runner.
 *   3. The home restored from the snapshot (§5.5), the package from the attempt's preimage when the install was
 *      intended (§6.3), and the unit with its route KEPT (§6.2 step 3).
 *   4. The `rollback` generation planned with a fresh nonce (§3.3) and written into the fence's handoff (§4.3); the
 *      service started; the takeover awaited and acknowledged (the pre-start step hands the nonce on).
 *   5. The route taken off and the manager reloaded (§6.2 step 6), then `rolled-back` (its mark first, §2.4).
 *
 * Everything that touches the service manager or waits on a process comes through `RollbackDeps`.
 */
import { randomBytes } from "node:crypto";
import { adoptUpdateFence, readFleetLockRecord, retakeDeadFleetLock, setFleetLockHandoff, type FleetLockHandle } from "./fleet-lock.js";
import { identityOf, stopTarget } from "./install-ownership.js";
import { restoreHome, type RestoreDeps } from "./update-restore.js";
import { restorePackage, restoreUnit } from "./update-package-restore.js";
import { removeRecoveryRoute, unitPreimagePath, writeRecoveryRoute } from "./update-recovery/route.js";
import { verifyRecoveryKit } from "./update-recovery/kit.js";
import { existsSync } from "node:fs";
import { ackGeneration, advance, attemptDir, defaultJournalIo, finish, planGeneration, readCurrent, revokeHandoff, substep, voidGeneration,
  type AttemptRecord, type FleetGeneration, type JournalIo, type LivenessDeps, type ProcessStartRecord } from "./update-journal.js";

export interface RollbackDeps {
  /** Who is driving: the updater, or the recovery runner (its pid and start). */
  self: { pid: number; start: ProcessStartRecord };
  liveness: LivenessDeps;
  isProcessAlive(pid: number): boolean;
  /** §4.4 again, for the home restore. */
  proveWritersGone: RestoreDeps["proveWritersGone"];
  plistArgs(xml: string): string[] | null;
  manager: {
    /** The service's main pid now (null: none, or no service manager). */
    mainPid(): number | null;
    /** Stop the service and wait until it is inactive (or the process is gone); false: it didn't stop. */
    stop(): boolean;
    /** daemon-reload / plist reload, with no start job in progress. */
    reload(): boolean;
    /** reset-failed + start / kickstart. */
    start(): boolean;
  };
  /** Wait for fleet.lock to hold a `fleet` record with this nonce; its pid, or null on timeout. */
  waitTakeover(nonce: string): number | null;
  newNonce?(): string;
  io?: JournalIo;
}

export type RollbackResult = { ok: true; attempt: AttemptRecord } | { ok: false; manual: boolean; reason: string; attempt: AttemptRecord };

const ROLLBACK_FROM = new Set(["snapshotted", "installing", "trial", "proving"]);
const generationsOf = (a: AttemptRecord): FleetGeneration[] => (Array.isArray(a.fleets) ? (a.fleets as FleetGeneration[]) : []);
const didSubstep = (a: AttemptRecord, name: string) => a.history.some(h => h.stage === "rolling-back" && h.substep === name);

/** §3.3–§4.3: make fleet.lock this attempt's fence, owned by `self`. */
function ensureFence(home: string, attempt: AttemptRecord, d: RollbackDeps): { ok: true; handle: FleetLockHandle; attempt: AttemptRecord } | { ok: false; reason: string; attempt: AttemptRecord } {
  let a = attempt;
  for (let round = 0; round < 3; round++) {
    const rec = readFleetLockRecord(home);
    if (!rec) return { ok: false, reason: "fleet.lock is missing or unreadable during the rollback", attempt: a };
    if (rec.role === "update") {
      if (rec.attemptId !== a.id) return { ok: false, reason: `fleet.lock fences another attempt (${rec.attemptId})`, attempt: a };
      const adopted = adoptUpdateFence(home, { pid: d.self.pid, attemptId: a.id }, { isProcessAlive: d.isProcessAlive });
      return adopted.ok ? { ok: true, handle: adopted.handle, attempt: a } : { ok: false, reason: adopted.reason, attempt: a };
    }
    // A fleet holds it: only a recorded generation, identified by pid + nonce (and the service's MainPID).
    const gen = generationsOf(a).find(g => g.nonce === rec.nonce);
    if (!gen) return { ok: false, reason: `fleet.lock's holder (pid ${rec.pid}) is no recorded generation`, attempt: a };
    if (d.isProcessAlive(rec.pid)) {
      const target = stopTarget(a, { pid: rec.pid, nonce: rec.nonce }, d.manager.mainPid());
      if (!target.ok) return { ok: false, reason: target.reason, attempt: a };
      if (!d.manager.stop()) return { ok: false, reason: `the ${gen.gen} fleet (pid ${rec.pid}) didn't stop`, attempt: a };
      if (d.isProcessAlive(rec.pid)) return { ok: false, reason: `the ${gen.gen} fleet (pid ${rec.pid}) is still running after the stop`, attempt: a };
    }
    // Journaled as started and dead (stopped now, or found gone) before its record is re-taken (§4.3 rev 5).
    if (!gen.dead || gen.pid !== rec.pid) a = ackGeneration(home, a, gen.nonce, rec.pid, { dead: true }, d.io);
    const retaken = retakeDeadFleetLock(home, { pid: d.self.pid, attemptId: a.id, nonce: rec.nonce }, { isProcessAlive: d.isProcessAlive });
    if (retaken.ok) return { ok: true, handle: retaken.handle, attempt: a };
    if (!/changed during/.test(retaken.reason)) return { ok: false, reason: retaken.reason, attempt: a };
  }
  return { ok: false, reason: "fleet.lock kept changing during the rollback", attempt: a };
}

/** Roll `attempt` back. The caller holds the three locks, has re-proven ownership and is the attempt's owner. */
export function rollBack(home: string, attempt: AttemptRecord, d: RollbackDeps): RollbackResult {
  const io = d.io ?? defaultJournalIo;
  let a = attempt;
  const fail = (reason: string, manual = true): RollbackResult => ({ ok: false, manual, reason, attempt: a });
  const id = identityOf(a);
  if (!id) return fail("the attempt's recorded ownership is missing or malformed");

  // 1. rolling-back
  if (a.stage !== "rolling-back") {
    if (!ROLLBACK_FROM.has(a.stage)) return fail(`attempt ${a.id} can't roll back from ${a.stage}`);
    a = advance(home, a, "rolling-back", { note: "the update didn't prove itself" }, io);
  }

  // 2. the fence — unless the rollback generation already holds fleet.lock (a retry after its takeover): then the
  //    restores are behind us, and step 4 acknowledges it.
  const holder = readFleetLockRecord(home);
  const rollbackHolds = holder?.role === "fleet" && generationsOf(a).some(g => g.gen === "rollback" && g.nonce === holder.nonce);
  let fenceHandle: FleetLockHandle | null = null;
  if (!rollbackHolds) {
    const fence = ensureFence(home, a, d);
    a = fence.attempt;
    if (!fence.ok) return fail(fence.reason);
    fenceHandle = fence.handle;
  }

  // 3. restores
  const steps = { done: (n: string) => didSubstep(a, n), record: (n: string) => { a = substep(home, a, n, io); } };
  if (!steps.done("home-restored")) {
    const r = restoreHome(home, attemptDir(home, a.id), { proveWritersGone: d.proveWritersGone });
    if (!r.ok) return fail(r.reason, r.manual);
    steps.record("home-restored");
  }
  const intent = a.intent as { preimage?: { manifestSha256?: string } } | undefined;
  if (intent?.preimage?.manifestSha256 && !steps.done("bins")) {
    const r = restorePackage(id.ownership, a.id, intent.preimage.manifestSha256, steps);
    if (!r.ok) return fail(r.reason, r.manual);
  }
  // The route must exist for the rollback generation to receive its nonce (a crash early in snapshotted may precede it):
  // written now from the unchanged unit — which needs the kit its pre-start step runs.
  if (id.ownership.service && !existsSync(unitPreimagePath(home, a.id))) {
    const kit = verifyRecoveryKit(home, a.id);
    if (!kit.ok) return fail(`the recovery route can't be made: ${kit.reason}`);
    const route = writeRecoveryRoute(home, a, { plistArgs: d.plistArgs }, io);
    if (!route.ok) return fail(route.reason);
  }
  if (id.ownership.service && !steps.done("unit-reloaded")) {
    const r = restoreUnit(home, a, { keepRoute: true, plistArgs: d.plistArgs, reload: d.manager.reload }, steps);
    if (!r.ok) return fail(r.reason, r.manual);
  }

  // 4. the rollback generation: planned, handed off, started, acknowledged
  if (!generationsOf(a).some(g => g.gen === "rollback" && g.consumed && !g.dead)) {
    let gen = generationsOf(a).find(g => g.gen === "rollback" && !g.consumed && !g.dead);
    let handle = fenceHandle;
    if (gen) {
      // Planned before a crash: a start may already have taken over with it.
      const taken = readFleetLockRecord(home);
      if (taken?.role === "fleet" && taken.nonce === gen.nonce) { a = ackGeneration(home, a, gen.nonce, taken.pid, {}, io); gen = undefined; }
      else {
        // Not taken: take the claim back (a gone or never-started claimant), void it, and plan afresh.
        const revoked = revokeHandoff(home, a.id, gen.nonce, d.self, d.liveness, io);
        if (revoked === "claimed-live" || revoked === "claimant-unknown") return fail(`the rollback generation's claim is held (${revoked})`);
        if (!handle) return fail("fleet.lock holds the rollback generation's record, but it isn't planned");
        if (handle.record.handoff) {
          const cleared = setFleetLockHandoff(handle, null, () => true);
          if (!cleared) return fail("fleet.lock changed while the old handoff was cleared");
          handle = cleared;
        }
        a = voidGeneration(home, a, gen.nonce, io);
        gen = undefined;
      }
    }
    if (!generationsOf(a).some(g => g.gen === "rollback" && g.consumed && !g.dead)) {
      const nonce = d.newNonce?.() ?? randomBytes(16).toString("hex");
      a = planGeneration(home, a, "rollback", nonce, io);
      if (!handle) return fail("no fence to hand the rollback generation over from");
      const planned = setFleetLockHandoff(handle, { nonce, gen: "rollback" }, (attemptId, n) => {
        const r = revokeHandoff(home, attemptId, n, d.self, d.liveness, io);
        return r === "revoked" || r === "claimant-gone";
      });
      if (!planned) return fail("fleet.lock isn't this attempt's fence any more");
      if (!d.manager.start()) return fail("the service didn't start for the rollback generation; retry", false);
      const pid = d.waitTakeover(nonce);
      if (pid === null) return fail("the rollback generation didn't take fleet.lock over in time; retry", false);
      a = ackGeneration(home, a, nonce, pid, {}, io);
    }
  }

  // 5. the route off, the manager reloaded, rolled-back
  if (id.ownership.service && !steps.done("route-removed")) {
    const removed = removeRecoveryRoute(home, a, { plistArgs: d.plistArgs }, io);
    if (!removed.ok) return fail(removed.reason);
    if (!d.manager.reload()) return fail("the service manager couldn't reload after the route was taken off; retry", false);
    steps.record("route-removed");
  }
  a = finish(home, a, { kind: "rolled-back", reason: "rolled back to the previous version" }, io);
  return { ok: true, attempt: a };
}

/** For the runner: the journal's open attempt, if it is this one and rolling back (or about to). */
export function rollbackAttempt(home: string, attemptId: string, io: JournalIo = defaultJournalIo): AttemptRecord | null {
  const read = readCurrent(home, io);
  return read.state === "open" && read.attempt.id === attemptId ? read.attempt : null;
}
