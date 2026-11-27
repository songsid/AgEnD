/**
 * M-3770 slice 2.1b (design update-transaction §4.2 step 3): the CLI's state lease, `<home>/.state-lease.sqlite`.
 *
 * A state-writing `agend` command (outside the fleet, which fleet.lock fences) holds a SHARED lock on this file for the
 * whole time it has any state file of the scope open: a read transaction (`BEGIN DEFERRED` + a SELECT) in rollback
 * journal mode. Only AFTER that does it check the update journal, and it refuses while an attempt is open, unknown or
 * awaiting manual recovery. The updater publishes `current` first, then takes an EXCLUSIVE lock on the same file:
 * SQLite grants it only once every SHARED holder has finished — the drain. A writer admitted before `current` finishes
 * first; one arriving after it sees `current` (or, while the EXCLUSIVE lock is held, the lock itself) and refuses.
 * The locks are the kernel's (fcntl, through SQLite): a process that dies drops them.
 *
 * The file is never snapshotted, restored or pruned (§5.1): its locks live on this inode.
 */
import Database from "better-sqlite3";
import { ensureAgendHome } from "./agend-home.js";
import { join } from "node:path";
import { readCurrent } from "./update-journal.js";

export const STATE_LEASE_FILE = ".state-lease.sqlite";
export const stateLeasePath = (home: string) => join(home, STATE_LEASE_FILE);

export interface Lease { release(): void }
export type LeaseResult = { ok: true; lease: Lease } | { ok: false; reason: string };

function open(home: string, busyMs: number): Database.Database {
  const db = new Database(stateLeasePath(home));
  db.pragma("journal_mode = DELETE");                // rollback journal: SHARED and EXCLUSIVE are file locks every reader honours
  db.pragma(`busy_timeout = ${Math.max(0, Math.floor(busyMs))}`);
  return db;
}

const busy = (err: unknown) => /SQLITE_BUSY|database is locked/i.test(String((err as { code?: string }).code ?? "") + String((err as Error).message ?? ""));

/**
 * A state-writing command's lease: SHARED for its whole run, then the journal check. Busy (the updater holds EXCLUSIVE)
 * for `busyMs` (2 s), or an open, unknown or manual attempt: refused, in words.
 */
export function takeSharedLease(home: string, command: string, opts: { busyMs?: number } = {}): LeaseResult {
  // A missing home is created first (private, by the same checks as every start), then leased the normal way (Prism
  // #4499): "no home" observed once is no proof an update won't create and fence it while this command still runs.
  try { ensureAgendHome(home); }
  catch (err) { return { ok: false, reason: `\`agend ${command}\` is refused: the AgEnD home ${home} can't be used (${(err as Error).message}).` }; }
  let db: Database.Database | null = null;
  try {
    db = open(home, opts.busyMs ?? 2000);
    db.exec("BEGIN DEFERRED");
    db.prepare("SELECT count(*) FROM sqlite_master").get();          // the SHARED lock, held until release
  } catch (err) {
    try { db?.close(); } catch { /* closed */ }
    return { ok: false, reason: busy(err) ? `\`agend ${command}\` is refused: AgEnD is updating; try again when the update ends.`
      : `\`agend ${command}\` is refused: the state lease ${stateLeasePath(home)} can't be taken (${(err as Error).message}).` };
  }
  const read = readCurrent(home);                                     // after the lease: no update can start under it
  if (read.state === "open" || read.state === "unknown" || read.state === "manual") {
    try { db.exec("ROLLBACK"); db.close(); } catch { /* closed */ }
    const what = read.state === "unknown" ? "the update journal can't be read" : `attempt ${read.attempt.id} is ${read.attempt.stage}`;
    return { ok: false, reason: `\`agend ${command}\` is refused: AgEnD is updating (${what}).` };
  }
  const held = db;
  let released = false;
  return { ok: true, lease: { release: () => { if (released) return; released = true; try { held.exec("COMMIT"); } catch { /* ended */ } try { held.close(); } catch { /* closed */ } } } };
}

/**
 * The updater's drain (after it published `current`): EXCLUSIVE once every SHARED holder has finished, waiting at most
 * `timeoutMs` (60 s). Held until the attempt's terminal write; refused (the caller abandons) when the wait expires.
 */
export function takeExclusiveLease(home: string, timeoutMs = 60_000): LeaseResult {
  let db: Database.Database | null = null;
  try {
    db = open(home, timeoutMs);
    db.exec("BEGIN EXCLUSIVE");
  } catch (err) {
    try { db?.close(); } catch { /* closed */ }
    return { ok: false, reason: busy(err) ? `a state-writing \`agend\` command still runs after ${Math.round(timeoutMs / 1000)} s` : `the state lease can't be taken (${(err as Error).message})` };
  }
  const held = db;
  let released = false;
  return { ok: true, lease: { release: () => { if (released) return; released = true; try { held.exec("COMMIT"); } catch { /* ended */ } try { held.close(); } catch { /* closed */ } } } };
}
