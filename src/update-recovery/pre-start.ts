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

/** One shell word: as-is when it is plainly safe, else single-quoted (Prism #4511: homes with spaces or quotes). */
export const shellWord = (word: string): string => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

/** The operator's command for an attempt: the kit's own runner, from a shell, outside the service — pasteable. */
export function operatorCommand(home: string, attemptId: string): string {
  const kit = kitDir(home, attemptId);
  return [join(kit, "node"), join(kit, "recover.cjs"), "--home", home, "--attempt", attemptId, "--run"].map(shellWord).join(" ");
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

/**
 * §6.2's table, a pure function of the journal, its owner's liveness, and the attempt the service's route names (the
 * drop-in or wrapper passes `--attempt`): an open attempt that isn't the route's can't receive a handoff through it.
 */
export function preStartDecision(home: string, read: JournalRead, owner: UpdaterState, routeAttempt: string): PreStart {
  switch (read.state) {
    case "none": case "closing": return { kind: "start" };
    case "unknown": return { kind: "refuse", reason: `AgEnD's update journal can't be read (${read.reason}: ${read.path}). This start is refused; run \`agend update --resolve\`.` };
    case "manual": return { kind: "refuse", reason: `Update attempt ${read.attempt.id} needs manual recovery. This start is refused; run ${operatorCommand(home, read.attempt.id)}` };
  }
  const a = read.attempt;
  if (a.id !== routeAttempt) return { kind: "refuse", reason: `AgEnD's update route on this service names attempt ${routeAttempt}, but attempt ${a.id} is open (${a.stage}). This start is refused; run ${operatorCommand(home, a.id)}` };
  if (owner === "unknown") return { kind: "refuse", reason: `Update attempt ${a.id} (${a.stage}): whether its updater still runs can't be told. This start is refused; if no update is running, run ${operatorCommand(home, a.id)}` };
  // An interrupted commit is the new version's to finish (§7, rev 13; Fable #4533 F1): its own fleet start resumes it,
  // so this start goes through — the old kit's runner never commits.
  if (owner === "gone") return a.stage === "committing" ? { kind: "start" } : { kind: "start-runner", attemptId: a.id, stage: a.stage };
  const planned = plannedForStart(a);
  if (planned) return { kind: "handoff", attemptId: a.id, nonce: planned.nonce };
  return { kind: "refuse", reason: `AgEnD is updating (attempt ${a.id}, ${a.stage}); this start is refused. The update owns the service until it ends.` };
}

/**
 * The nonce reaches the service's main start through `EnvironmentFile=-<attempt>/handoff.env` (systemd reads it again
 * for each command). The file is the ROUTE's attempt's (Prism #4511): written for a handoff on that attempt, removed —
 * durably — for every other decision, whatever the journal reads (none, unknown, closing, another attempt), so a stale
 * nonce never rides along.
 */
export function applyHandoffEnv(home: string, decision: PreStart, routeAttempt: string, io: JournalIo = defaultJournalIo): void {
  if (decision.kind === "handoff") {
    if (decision.attemptId !== routeAttempt) throw new Error(`a handoff for attempt ${decision.attemptId} can't go through attempt ${routeAttempt}'s route`);
    const path = handoffEnvPath(home, decision.attemptId);
    const tmp = `${path}.tmp-${process.pid}`;
    try { io.unlink(tmp); } catch { /* none */ }
    io.writeSynced(tmp, `AGEND_UPDATE_HANDOFF=${decision.nonce}\n`);
    io.rename(tmp, path);
    io.fsyncDir(attemptDir(home, decision.attemptId));
    return;
  }
  const absent = (err: unknown) => ["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "");
  try { io.unlink(handoffEnvPath(home, routeAttempt)); }
  catch (err) { if (!absent(err)) throw err; }                    // already gone: still make that durable (Prism #4511 R2)
  // The directory is fsynced even when the file was already absent: a retry after a crash between an unlink and its
  // fsync must not leave the removal undurable. No attempt directory at all: nothing to make durable.
  try { io.fsyncDir(attemptDir(home, routeAttempt)); }
  catch (err) { if (!absent(err)) throw err; }
}
