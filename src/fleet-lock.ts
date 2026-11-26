import { ensureAgendHome } from "./agend-home.js";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

/**
 * What kind of process holds the lock.
 *
 * A record written before this field existed has no role; it can only have been
 * a fleet, so that is what a missing value means. Never widen that default —
 * "unknown" must not become "safe to take from".
 */
export type FleetLockRole = "fleet" | "setup-host" | "update";

interface FleetLockRecord {
  pid: number;
  nonce: string;
  createdAt: string;
  role?: FleetLockRole;
  /** M-3770 (design update-transaction §4.3), role "update": the attempt that fences the home. */
  attemptId?: string;
  /** Role "update": the planned generation a fleet start may take the lock over for, by its single-use nonce. */
  handoff?: { nonce: string; gen: "old" | "trial" | "rollback" } | null;
}

export interface FleetLockHandle {
  path: string;
  record: FleetLockRecord;
  serialized: string;
}

export interface FleetLockProbe {
  pid?: number;
  nonce?: string;
  /** Defaults to "fleet"; the pre-fleet setup host claims "setup-host"; an updater fencing the home claims "update". */
  role?: FleetLockRole;
  /** Role "update": its attempt id. */
  attemptId?: string;
  /**
   * M-3770 §4.3: this fleet start's handoff nonce (the environment's AGEND_UPDATE_HANDOFF by default). With it, a start
   * may take over an "update" record that plans exactly this nonce — through `claimHandoff`, never by staleness.
   */
  handoffNonce?: string | null;
  /** Creates the single-use claim for a handoff (O_EXCL); false when another contender holds it. The journal's. */
  claimHandoff?: (attemptId: string, nonce: string, pid: number) => boolean;
  isProcessAlive?: (pid: number) => boolean;
  readCommandLine?: (pid: number) => string;
}

/** Whether a process command line identifies the AgEnD setup page. */
export function isSetupHostCommandLine(commandLine: string): boolean {
  const normalized = commandLine.replace(/\0/g, " ").replace(/\s+/g, " ").trim();
  return /\b(?:agend|(?:cli|daemon-entry)\.(?:js|ts))\b.*\bsetup\b/i.test(normalized);
}

/** Whether a process command line identifies an AgEnD fleet process. */
export function isFleetStartCommandLine(commandLine: string): boolean {
  const normalized = commandLine.replace(/\0/g, " ").replace(/\s+/g, " ").trim();
  return /\b(?:agend|(?:cli|daemon-entry)\.(?:js|ts))\b.*\bfleet\s+start\b/i.test(normalized);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A process's command line, or "" when it cannot be read.
 *
 * Exported because the health-port takeover has to answer the same question
 * before it sends a signal: an empty answer means "cannot confirm", and nothing
 * destructive may be done on that.
 */
export function readProcessCommandLine(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      }).trim();
    } catch {
      return "";
    }
  }
}

function parseRecord(raw: string): FleetLockRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<FleetLockRecord>;
    if (!Number.isSafeInteger(value.pid) || (value.pid ?? 0) <= 1 || typeof value.nonce !== "string") {
      return null;
    }
    if (value.role === "update" && (typeof value.attemptId !== "string" || !value.attemptId)) return null;
    if (value.handoff != null && (typeof value.handoff.nonce !== "string" || !/^[0-9a-f]{32}$/.test(value.handoff.nonce)
      || !["old", "trial", "rollback"].includes(value.handoff.gen))) return null;
    return value as FleetLockRecord;
  } catch {
    return null;
  }
}

/**
 * Atomically claim one fleet process per AGEND_HOME. O_EXCL is portable and,
 * unlike fleet.pid, is acquired before FleetManager can mutate tmux or sockets.
 */
export function acquireFleetLock(dataDir: string, probe: FleetLockProbe = {}): FleetLockHandle {
  ensureAgendHome(dataDir);
  const lockPath = join(dataDir, "fleet.lock");
  const pid = probe.pid ?? process.pid;
  const record: FleetLockRecord = {
    pid,
    nonce: probe.nonce ?? randomBytes(16).toString("hex"),
    createdAt: new Date().toISOString(),
    role: probe.role ?? "fleet",
    ...(probe.role === "update" ? { attemptId: probe.attemptId ?? "", handoff: null } : {}),
  };
  if (record.role === "update" && !/^\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(record.attemptId ?? "")) throw new Error("an update fence needs its attempt id");
  const serialized = JSON.stringify(record) + "\n";
  const isAlive = probe.isProcessAlive ?? processAlive;
  const readCommandLine = probe.readCommandLine ?? readProcessCommandLine;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      writeFileSync(lockPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return { path: lockPath, record, serialized };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    let observed = "";
    try { observed = readFileSync(lockPath, "utf8"); }
    catch {
      // The owner may have exited between EEXIST and read; retry O_EXCL.
      continue;
    }
    const owner = parseRecord(observed);
    // M-3770 §4.3: an updater's fence. Never stale by its command line (an updater isn't `fleet start`): it is taken
    // over only by the start its record plans, holding that nonce and winning the single-use claim — atomically, by a
    // rename over the lock (no release and re-acquire). Anything else refuses while the updater lives.
    if (owner && owner.role === "update") {
      const nonce = probe.handoffNonce === undefined ? (process.env.AGEND_UPDATE_HANDOFF ?? null) : probe.handoffNonce;
      if (nonce && owner.handoff && owner.handoff.nonce === nonce && record.role === "fleet") {
        const claim = probe.claimHandoff;
        if (!claim || !claim(owner.attemptId!, nonce, pid)) throw new Error(`Another start has claimed this update's handoff (attempt ${owner.attemptId})`);
        const taken: FleetLockRecord = { ...record, nonce };
        const takenSerialized = JSON.stringify(taken) + "\n";
        const tmp = `${lockPath}.handoff-${pid}-${randomBytes(4).toString("hex")}`;
        const fd = openSync(tmp, "wx", 0o600);
        try { writeSync(fd, takenSerialized); fsyncSync(fd); } finally { closeSync(fd); }
        if (readFileSync(lockPath, "utf8") !== observed) { unlinkSync(tmp); throw new Error(`The update's fence changed during the handoff (attempt ${owner.attemptId})`); }
        renameSync(tmp, lockPath);
        fsyncDir(dataDir);
        return { path: lockPath, record: taken, serialized: takenSerialized };
      }
      if (isAlive(owner.pid)) {
        throw new Error(`AgEnD is updating (attempt ${owner.attemptId}); this fleet start is refused until the update hands over or ends`);
      }
      // The updater is gone. Its fence is never taken by staleness here: recovery (the journal) owns it.
      throw new Error(`An update's fence is left by a stopped updater (attempt ${owner.attemptId}); run the recovery (agend update --resolve)`);
    }
    if (owner && isAlive(owner.pid)) {
      const commandLine = readCommandLine(owner.pid);
      // A live setup host is an owner in its own right. Before the role existed
      // its command line did not match the fleet pattern, so a starting fleet
      // read the lock as stale and took it — and then collided with the host on
      // the health port, where the takeover kills whatever fleet.pid names.
      //
      // Symmetric with the fleet case on purpose: the setup page is short-lived
      // and often killed outright, so its pid is a prime candidate for reuse
      // after a reboot. Positive evidence that the pid now belongs to something
      // else makes the record stale; no evidence still refuses, because an
      // unreadable owner must never be assumed absent.
      if (owner.role === "setup-host") {
        if (!commandLine) {
          throw new Error(`Fleet lock is owned by live PID ${owner.pid}; refusing to replace it`);
        }
        if (isSetupHostCommandLine(commandLine)) {
          throw new Error(`Setup is already running (PID ${owner.pid}, lock: ${lockPath})`);
        }
        // The pid was reused by an unrelated process: the lock is stale.
      } else {
      if (isFleetStartCommandLine(commandLine)) {
        throw new Error(`Fleet is already running (PID ${owner.pid}, lock: ${lockPath})`);
      }
      // An alive PID with an unreadable command line is not safe to steal from.
      if (!commandLine) {
        throw new Error(`Fleet lock is owned by live PID ${owner.pid}; refusing to replace it`);
      }
      // The PID was reused by an unrelated process: the lock is stale.
      }
    }

    // Only unlink the exact stale record we inspected. A competing starter may
    // already have replaced it; in that case leave its lock untouched and retry.
    try {
      if (readFileSync(lockPath, "utf8") === observed) unlinkSync(lockPath);
    } catch {
      // Another contender changed/removed the file; retry the atomic claim.
    }
  }
  throw new Error(`Unable to acquire fleet lock at ${lockPath}`);
}

/**
 * #2490: would `acquireFleetLock` refuse this process now — a live fleet (or setup host) other than it holds the lock?
 * The same reading of the record and its owner as the acquisition; anything it would treat as stale is "no". Never
 * throws.
 */
export function fleetLockHeldByAnother(dataDir: string, probe: Pick<FleetLockProbe, "pid" | "isProcessAlive" | "readCommandLine"> = {}): boolean {
  try {
    const owner = parseRecord(readFileSync(join(dataDir, "fleet.lock"), "utf8"));
    if (!owner || owner.pid === (probe.pid ?? process.pid) || !(probe.isProcessAlive ?? processAlive)(owner.pid)) return false;
    if (owner.role === "update") return true;                        // M-3770: a live updater's fence is held, whatever its command line
    const commandLine = (probe.readCommandLine ?? readProcessCommandLine)(owner.pid);
    if (!commandLine) return true;                                   // an unreadable live owner is never assumed absent
    return owner.role === "setup-host" ? isSetupHostCommandLine(commandLine) : isFleetStartCommandLine(commandLine);
  } catch { return false; }
}

/** Delete only the exact lock record acquired by this process. */
export function releaseFleetLock(handle: FleetLockHandle | undefined): boolean {
  if (!handle || !existsSync(handle.path)) return false;
  // M-3770 §4.3: an update fence with a planned handoff is never unlinked directly — the planned start may rename its
  // record in between this compare and the unlink. Revoke first (setFleetLockHandoff(handle, null, revoke)).
  if (handle.record.role === "update" && handle.record.handoff) return false;
  try {
    if (readFileSync(handle.path, "utf8") !== handle.serialized) return false;
    unlinkSync(handle.path);
    return true;
  } catch {
    return false;
  }
}

let processFleetLock: FleetLockHandle | undefined;

export function setProcessFleetLock(handle: FleetLockHandle): void {
  processFleetLock = handle;
}

/** This process's own fleet.lock record (its nonce names its generation in an update attempt), if it holds one. */
export function processFleetLockRecord(): Readonly<FleetLockRecord> | null {
  return processFleetLock?.record ?? null;
}

export function releaseProcessFleetLock(): boolean {
  const handle = processFleetLock;
  const released = releaseFleetLock(handle);
  if (released) processFleetLock = undefined;
  return released;
}

const fsyncDir = (dir: string): void => { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };

/**
 * M-3770 §4.3: the updater writes the planned handoff into its own fence record (tmp, fsync, rename, directory fsync),
 * only while the lock is still exactly its record. Returns the new handle, or null when the lock is no longer its own.
 *
 * Replacing or clearing a handoff already planned races the start that holds its nonce: that start may win the claim
 * and rename its record over the lock between this function's compare and its rename, which would put the fence back
 * over a live fleet. So the planned nonce is revoked first through `revoke` — the journal's `revokeHandoff`, which
 * takes the SAME single-use claim file. Exactly one of the two wins it: when the start did, nothing is rewritten (null).
 */
export function setFleetLockHandoff(
  handle: FleetLockHandle,
  handoff: { nonce: string; gen: "old" | "trial" | "rollback" } | null,
  revoke?: (attemptId: string, nonce: string) => boolean,
): FleetLockHandle | null {
  if (handle.record.role !== "update") throw new Error("only an update fence plans a handoff");
  if (handoff && !/^[0-9a-f]{32}$/.test(handoff.nonce)) throw new Error("a handoff nonce is 32 hex digits");
  const planned = handle.record.handoff;
  if (planned) {
    if (!revoke) throw new Error("a planned handoff is replaced only after its nonce is revoked");
    if (!revoke(handle.record.attemptId!, planned.nonce)) return null;          // the start won its claim: the lock is its
  }
  let current: string;
  try { current = readFileSync(handle.path, "utf8"); } catch { return null; }
  if (current !== handle.serialized) return null;
  const record: FleetLockRecord = { ...handle.record, handoff };
  const serialized = JSON.stringify(record) + "\n";
  const tmp = `${handle.path}.plan-${record.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeSync(fd, serialized); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, handle.path);
  fsyncDir(dirname(handle.path));
  return { path: handle.path, record, serialized };
}

/**
 * M-3770 §4.3 rev 5: a generation the attempt started took the lock over and then died before its acknowledgement.
 * The updater (or runner) has journaled that generation as started and dead; now it re-takes its fence. Only that exact
 * record — role fleet, the generation's nonce — and only when its holder is proven gone (no such process; a live pid,
 * maybe reused, is never taken). The replacement is owned: an O_EXCL reclaim marker first, the record compared again,
 * then the update record written to a fresh tmp, fsynced and renamed over the lock, the directory fsynced, the marker
 * removed. Returns the new fence's handle, or why not.
 */
export function retakeDeadFleetLock(dataDir: string, fence: { pid?: number; attemptId: string; nonce: string }, probe: Pick<FleetLockProbe, "isProcessAlive"> = {}):
  { ok: true; handle: FleetLockHandle } | { ok: false; reason: string } {
  return replaceDeadHolder(dataDir, fence, owner => (owner.role ?? "fleet") === "fleet" && owner.nonce === fence.nonce ? null : "fleet.lock doesn't hold that generation's record", probe);
}

/**
 * M-3770 §6.2: the recovery runner takes over the fence of the attempt's own updater, once that updater is proven gone —
 * the same owned replacement as above (marker, compare again, tmp + fsync + rename, directory fsync). Only an `update`
 * record of THIS attempt; a live holder is never taken. When the fence is already this process's, it is returned as is.
 */
export function adoptUpdateFence(dataDir: string, fence: { pid?: number; attemptId: string }, probe: Pick<FleetLockProbe, "isProcessAlive"> = {}):
  { ok: true; handle: FleetLockHandle } | { ok: false; reason: string } {
  const pid = fence.pid ?? process.pid;
  let current: string;
  try { current = readFileSync(join(dataDir, "fleet.lock"), "utf8"); } catch (err) { return { ok: false, reason: `fleet.lock can't be read (${(err as Error).message})` }; }
  const owner = parseRecord(current);
  if (owner && owner.role === "update" && owner.attemptId === fence.attemptId && owner.pid === pid) {
    clearCrashedReclaim(dataDir, fence.attemptId, pid, probe);                  // a marker our own crashed run left behind
    return { ok: true, handle: { path: join(dataDir, "fleet.lock"), record: owner, serialized: current } };
  }
  return replaceDeadHolder(dataDir, { pid, attemptId: fence.attemptId }, o => (o.role === "update" && o.attemptId === fence.attemptId ? null : "fleet.lock isn't this attempt's fence"), probe);
}

/** The owned re-take's marker beside fleet.lock (one helper for every reader and writer of it). */
const reclaimMarkerPath = (dataDir: string): string => `${join(dataDir, "fleet.lock")}.reclaim`;

/**
 * A reclaim marker left by a crash (Fable #4531 F1): the marker holds the record its taker meant to write. When that is
 * THIS attempt's update record and its pid is proven gone, it is our own crashed reclaim — removed (the directory
 * fsynced) so the replacement can run again. Any other marker (another attempt, a live pid, unreadable) stays.
 */
function clearCrashedReclaim(dataDir: string, attemptId: string, selfPid: number, probe: Pick<FleetLockProbe, "isProcessAlive">): boolean {
  const marker = reclaimMarkerPath(dataDir);
  let text: string;
  try { text = readFileSync(marker, "utf8"); } catch { return false; }
  const rec = parseRecord(text);
  // Ours: this attempt's record, and its taker gone — or this very process (an exception mid-reclaim, not a crash).
  if (!rec || rec.role !== "update" || rec.attemptId !== attemptId || (rec.pid !== selfPid && (probe.isProcessAlive ?? processAlive)(rec.pid))) return false;
  try { unlinkSync(marker); fsyncDir(dataDir); return true; } catch { return false; }
}

/** The owned replacement of a dead holder's record by a fresh update fence (no handoff). `accept` returns why not, or null. */
function replaceDeadHolder(dataDir: string, fence: { pid?: number; attemptId: string }, accept: (owner: FleetLockRecord) => string | null, probe: Pick<FleetLockProbe, "isProcessAlive">):
  { ok: true; handle: FleetLockHandle } | { ok: false; reason: string } {
  const lockPath = join(dataDir, "fleet.lock"), marker = reclaimMarkerPath(dataDir);
  let observed: string;
  try { observed = readFileSync(lockPath, "utf8"); } catch (err) { return { ok: false, reason: `fleet.lock can't be read (${(err as Error).message})` }; }
  const owner = parseRecord(observed);
  if (!owner) return { ok: false, reason: "fleet.lock can't be read as a record" };
  const why = accept(owner);
  if (why) return { ok: false, reason: why };
  if ((probe.isProcessAlive ?? processAlive)(owner.pid)) return { ok: false, reason: `fleet.lock's holder (pid ${owner.pid}) is still a live process; it is never taken` };
  const pid = fence.pid ?? process.pid;
  const record: FleetLockRecord = { pid, nonce: randomBytes(16).toString("hex"), createdAt: new Date().toISOString(), role: "update", attemptId: fence.attemptId, handoff: null };
  const serialized = JSON.stringify(record) + "\n";
  const takeMarker = () => writeFileSync(marker, serialized, { flag: "wx", mode: 0o600 });
  try { takeMarker(); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") return { ok: false, reason: `the reclaim marker can't be created (${(err as Error).message})` };
    // Our own crashed reclaim's marker (this attempt, its taker gone): cleared, then taken once more.
    if (!clearCrashedReclaim(dataDir, fence.attemptId, fence.pid ?? process.pid, probe)) return { ok: false, reason: `a reclaim marker ${marker} is present (another reclaim, or one left by a crash); nothing is taken` };
    try { takeMarker(); } catch (again) { return { ok: false, reason: `the reclaim marker can't be taken (${(again as Error).message})` }; }
  }
  try {
    if (readFileSync(lockPath, "utf8") !== observed) return { ok: false, reason: "fleet.lock changed during the reclaim" };
    const tmp = `${lockPath}.retake-${pid}-${randomBytes(4).toString("hex")}`;
    const fd = openSync(tmp, "wx", 0o600);
    try { writeSync(fd, serialized); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, lockPath);
    fsyncDir(dataDir);
    return { ok: true, handle: { path: lockPath, record, serialized } };
  } catch (err) {
    return { ok: false, reason: `fleet.lock can't be re-taken (${(err as Error).message})` };
  } finally {
    try { unlinkSync(marker); fsyncDir(dataDir); } catch { /* removed, or the directory went */ }
  }
}

/**
 * M-3770 §4.3 (Fable #4536 F3): this attempt's `update` fence on an ABSENT fleet.lock — the recovery runner's case after
 * the old fleet exited cleanly (its exit unlinks the lock). O_EXCL, fsynced, the directory fsynced; the record exactly
 * `acquireFleetLock`'s update shape. Bundle-safe for recover.cjs: no `ensureAgendHome` (its lazy createRequire has no
 * `import.meta.url` in the cjs bundle) — the runner has proven the home under its locks. A lock already there refuses.
 */
export function createUpdateFence(dataDir: string, fence: { pid: number; attemptId: string }): { ok: true; handle: FleetLockHandle } | { ok: false; reason: string } {
  if (!/^\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(fence.attemptId)) return { ok: false, reason: "an update fence needs its attempt id" };
  const lockPath = join(dataDir, "fleet.lock");
  const record: FleetLockRecord = { pid: fence.pid, nonce: randomBytes(16).toString("hex"), createdAt: new Date().toISOString(), role: "update", attemptId: fence.attemptId, handoff: null };
  const serialized = JSON.stringify(record) + "\n";
  let fd: number;
  try { fd = openSync(lockPath, "wx", 0o600); }
  catch (err) { return { ok: false, reason: (err as NodeJS.ErrnoException).code === "EEXIST" ? "fleet.lock appeared meanwhile" : `fleet.lock can't be created (${(err as Error).message})` }; }
  try {
    try { writeSync(fd, serialized); fsyncSync(fd); } finally { closeSync(fd); }
    fsyncDir(dataDir);
  } catch (err) {
    // A partial lock of our own would refuse every later pass as "appeared meanwhile" (Fable #4536 nit): removed.
    try { unlinkSync(lockPath); fsyncDir(dataDir); } catch { /* gone already, or the directory went */ }
    return { ok: false, reason: `fleet.lock can't be written (${(err as Error).message})` };
  }
  return { ok: true, handle: { path: lockPath, record, serialized } };
}

/** The fleet lock's record as written (null: absent or unparsable). For the updater's acknowledgement of a takeover. */
export function readFleetLockRecord(dataDir: string): FleetLockRecord | null {
  try { return parseRecord(readFileSync(join(dataDir, "fleet.lock"), "utf8")); } catch { return null; }
}
