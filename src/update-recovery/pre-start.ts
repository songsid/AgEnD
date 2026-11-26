/**
 * M-3770 slice 2.1c (design update-transaction §6.2): the pre-start step's decision. It runs inside the service's start
 * (systemd `ExecStartPre=`, launchd's wrapper), so it never stops, starts, reloads or restores anything — it only reads
 * the journal and decides:
 *
 * | Journal                                               | Decision                                                  |
 * |-------------------------------------------------------|-----------------------------------------------------------|
 * | none, or closing                                      | start (a normal start)                                    |
 * | open; owner live; a planned, unconsumed generation    | handoff: its nonce reaches the start (`handoff.env`)      |
 * | open; owner live; no planned generation               | refuse: the update owns the service until it ends         |
 * | open; updater and runner gone                         | start-runner, then refuse this start                      |
 * | open; owner unknown, or journal unknown, or manual    | refuse, naming the paths and the operator command         |
 *
 * The owner is the attempt's updater or its recovery runner (`ownerState`). Built into the kit's `recover.cjs`: this
 * module imports only the journal and node built-ins, never the package being replaced.
 */
import { join } from "node:path";
import { attemptDir, defaultJournalIo, journalDir, type AttemptRecord, type FleetGeneration, type JournalIo, type JournalRead, type UpdaterState } from "../update-journal.js";

export type PreStart =
  | { kind: "start" }
  | { kind: "handoff"; attemptId: string; nonce: string }
  | { kind: "refuse"; reason: string }
  | { kind: "start-runner"; attemptId: string; stage: string };

export const HANDOFF_ENV = "handoff.env";
export const handoffEnvPath = (home: string, attemptId: string) => join(attemptDir(home, attemptId), HANDOFF_ENV);
export const kitDir = (home: string, attemptId: string) => join(journalDir(home), "recovery", attemptId);

/** The operator's command for an attempt: the kit's own runner, from a shell, outside the service. */
export function operatorCommand(home: string, attemptId: string): string {
  const kit = kitDir(home, attemptId);
  return `${join(kit, "node")} ${join(kit, "recover.cjs")} --home ${home} --run`;
}

/** The newest generation planned and not yet consumed or voided: the one a start may hand off to. */
function plannedForStart(attempt: AttemptRecord): FleetGeneration | null {
  const fleets = (Array.isArray(attempt.fleets) ? attempt.fleets : []) as FleetGeneration[];
  for (let i = fleets.length - 1; i >= 0; i--) {
    const g = fleets[i]!;
    if (!g.consumed && !g.dead && g.pid === undefined) return g;
  }
  return null;
}

/** §6.2's table, a pure function of the journal and its owner's liveness. */
export function preStartDecision(home: string, read: JournalRead, owner: UpdaterState): PreStart {
  switch (read.state) {
    case "none": case "closing": return { kind: "start" };
    case "unknown": return { kind: "refuse", reason: `AgEnD's update journal can't be read (${read.reason}: ${read.path}). This start is refused; run \`agend update --resolve\`.` };
    case "manual": return { kind: "refuse", reason: `Update attempt ${read.attempt.id} needs manual recovery. This start is refused; run ${operatorCommand(home, read.attempt.id)}` };
  }
  const a = read.attempt;
  if (owner === "unknown") return { kind: "refuse", reason: `Update attempt ${a.id} (${a.stage}): whether its updater still runs can't be told. This start is refused; if no update is running, run ${operatorCommand(home, a.id)}` };
  if (owner === "gone") return { kind: "start-runner", attemptId: a.id, stage: a.stage };
  const planned = plannedForStart(a);
  if (planned) return { kind: "handoff", attemptId: a.id, nonce: planned.nonce };
  return { kind: "refuse", reason: `AgEnD is updating (attempt ${a.id}, ${a.stage}); this start is refused. The update owns the service until it ends.` };
}

/**
 * The nonce reaches the service's main start through `EnvironmentFile=-<attempt>/handoff.env` (systemd reads it again
 * for each command). Written for a handoff; removed for every other decision, so a stale nonce never rides along.
 */
export function applyHandoffEnv(home: string, decision: PreStart, attemptId: string | null, io: JournalIo = defaultJournalIo): void {
  if (decision.kind === "handoff") {
    const path = handoffEnvPath(home, decision.attemptId);
    const tmp = `${path}.tmp-${process.pid}`;
    try { io.unlink(tmp); } catch { /* none */ }
    io.writeSynced(tmp, `AGEND_UPDATE_HANDOFF=${decision.nonce}\n`);
    io.rename(tmp, path);
    io.fsyncDir(attemptDir(home, decision.attemptId));
    return;
  }
  if (!attemptId) return;
  try { io.unlink(handoffEnvPath(home, attemptId)); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
}
