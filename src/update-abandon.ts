/**
 * M-3770 slice 2.5 (design update-transaction §2.3, §4.3; rev 13): the recorded abandon procedure — for the live updater
 * (`runUpdate`, before the snapshot is published) and for the recovery runner acting for a dead one. Bundled into
 * recover.cjs: no snapshot, install or SQLite code, node built-ins only.
 */
import { existsSync } from "node:fs";
import { readFleetLockRecord, releaseFleetLock, setFleetLockHandoff, type FleetLockHandle } from "./fleet-lock.js";
import { identityOf } from "./install-ownership.js";
import { advance, defaultJournalIo, finish, substep, type AttemptRecord, type FleetGeneration, type JournalIo } from "./update-journal.js";
import { removeRecoveryRoute, unitPreimagePath } from "./update-recovery/route.js";
import { ensureFence, startGeneration, type RollbackDeps } from "./update-rollback.js";

export type UpdateResult =
  | { ok: true; attempt: AttemptRecord }
  /** Not committed. `abandoned` / `rolled-back`: the way back completed. `manual`: manual-recovery is journaled.
   *  `retry`: the attempt stays open (a later run — the recovery runner, through the route — resumes it). */
  | { ok: false; outcome: "abandoned" | "rolled-back" | "manual" | "retry"; reason: string; attempt: AttemptRecord };

export interface AbandonDeps extends Pick<RollbackDeps, "self" | "liveness" | "isProcessAlive" | "manager" | "waitTakeover" | "newNonce" | "io" | "plistArgs"> {
  /** `hand-back`: the old fleet has taken the inbox and the deferred jobs back and acknowledged them (2.2). */
  handBack(attempt: AttemptRecord): boolean;
}

const generationsOf = (a: AttemptRecord): FleetGeneration[] => (Array.isArray(a.fleets) ? (a.fleets as FleetGeneration[]) : []);
const didSubstep = (a: AttemptRecord, stage: string, name: string) => a.history.some(h => h.stage === stage && h.substep === name);

/**
 * §2.3 abandon: a procedure, not a label — `restart-old`, `hand-back`, `route-removed`, then `abandoned`. Allowed from
 * opened, barrier and stopping (no snapshot published). `fence` is the fence's handle when the caller holds it.
 */
export function abandonAttempt(home: string, attempt: AttemptRecord, d: AbandonDeps, reason: string, fence: FleetLockHandle | null = null): UpdateResult {
  const io = d.io ?? defaultJournalIo;
  let a = attempt;
  const fail = (why: string, isManual = true): UpdateResult => (isManual ? journalManual(home, a, why, io) : { ok: false, outcome: "retry", reason: why, attempt: a });
  const id = identityOf(a);
  if (!id) return journalManual(home, a, "the attempt's recorded ownership is missing or malformed", io);
  if (a.stage !== "abandoning") a = advance(home, a, "abandoning", { note: reason }, io);
  const done = (n: string) => didSubstep(a, "abandoning", n);

  // The old fleet must RUN until the hand-back is acknowledged (Fable #4536 F1): checked on every pass, not only once.
  // A recorded `restart-old` whose fleet has since died (a crash, a reboot before the acks) is journaled dead and a new
  // `old` generation started from the re-taken fence.
  if (!done("hand-back")) {
    const holder = readFleetLockRecord(home);
    const old = generationsOf(a).find(g => g.gen === "old");
    if (holder?.role === "fleet" && d.isProcessAlive(holder.pid)) {
      // A live fleet holds the lock: the old fleet never stopped (barrier, an early failure), or abandon's own restart.
      const gen = generationsOf(a).find(g => g.nonce === holder.nonce && !g.dead);
      if (!gen || gen.gen !== "old") return fail(`fleet.lock's holder (pid ${holder.pid}) isn't the running old fleet`);
      if (!gen.consumed) a = startGeneration(home, a, "old", null, d).attempt;                     // its takeover landed before a crash
    } else if (holder) {
      // This attempt's fence (the updater's, adopted when it is gone), or a recorded generation's record whose fleet died
      // (the old fleet crashed before the updater stopped it, or after abandon restarted it): journaled dead and its
      // record re-taken (`ensureFence`).
      if (holder.role === "update" && holder.attemptId !== a.id) return fail(`fleet.lock fences another attempt (${holder.attemptId})`);
      let own = fence;
      if (!own) {
        const f = ensureFence(home, a, d);
        a = f.attempt;
        if (!f.ok) return fail(`this attempt's fence can't be held to restart the old fleet: ${f.reason}`);
        own = f.handle;
      }
      if (old) {
        const started = startGeneration(home, a, "old", own, d);
        a = started.attempt;
        if (!started.ok) return fail(`the old fleet didn't restart: ${started.reason}`, started.manual);
      } else {
        // No fleet ran when the attempt opened: the fence is simply let go.
        const clear = own.record.handoff ? setFleetLockHandoff(own, null, () => true) : own;
        if (!clear || !releaseFleetLock(clear)) return fail("this attempt's fence couldn't be released");
      }
    } else if (old) {
      return fail("fleet.lock is gone, but the old fleet was recorded running");
    }
    if (!done("restart-old")) a = substep(home, a, "restart-old", io);
    if (!d.handBack(a)) return fail("the old fleet didn't take the held messages and jobs back; it resumes on the next start", false);
    a = substep(home, a, "hand-back", io);
  }
  // Only a route that was written (its unit preimage kept first): an abandon at the barrier has none to take off.
  if (id.ownership.service && !done("route-removed") && existsSync(unitPreimagePath(home, a.id))) {
    const r = removeRecoveryRoute(home, a, { plistArgs: d.plistArgs }, io);
    if (!r.ok) return fail(r.reason);
    if (!d.manager.reload()) return fail("the service manager couldn't reload after the route was taken off", false);
    a = substep(home, a, "route-removed", io);
  }
  a = finish(home, a, { kind: "abandoned", reason }, io);
  return { ok: false, outcome: "abandoned", reason, attempt: a };
}

/** manual-recovery journaled (it keeps `current` until a person resolves it). */
export function journalManual(home: string, attempt: AttemptRecord, reason: string, io: JournalIo): UpdateResult {
  const a = finish(home, attempt, { kind: "manual-recovery", reason }, io);
  return { ok: false, outcome: "manual", reason, attempt: a };
}
