import { ensureAgendHome } from "./agend-home.js";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

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
        const tmp = `${lockPath}.handoff-${pid}`;
        const fd = openSync(tmp, "wx", 0o600);
        try { writeSync(fd, takenSerialized); fsyncSync(fd); } finally { closeSync(fd); }
        if (readFileSync(lockPath, "utf8") !== observed) { unlinkSync(tmp); throw new Error(`The update's fence changed during the handoff (attempt ${owner.attemptId})`); }
        renameSync(tmp, lockPath);
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

export function releaseProcessFleetLock(): boolean {
  const handle = processFleetLock;
  const released = releaseFleetLock(handle);
  if (released) processFleetLock = undefined;
  return released;
}

/**
 * M-3770 §4.3: the updater writes the planned handoff into its own fence record (tmp, fsync, rename), only while the lock
 * is still exactly its record. Returns the new handle, or null when the lock is no longer its own.
 */
export function setFleetLockHandoff(handle: FleetLockHandle, handoff: { nonce: string; gen: "old" | "trial" | "rollback" } | null): FleetLockHandle | null {
  if (handle.record.role !== "update") throw new Error("only an update fence plans a handoff");
  if (handoff && !/^[0-9a-f]{32}$/.test(handoff.nonce)) throw new Error("a handoff nonce is 32 hex digits");
  let current: string;
  try { current = readFileSync(handle.path, "utf8"); } catch { return null; }
  if (current !== handle.serialized) return null;
  const record: FleetLockRecord = { ...handle.record, handoff };
  const serialized = JSON.stringify(record) + "\n";
  const tmp = `${handle.path}.plan-${record.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeSync(fd, serialized); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, handle.path);
  return { path: handle.path, record, serialized };
}

/** The fleet lock's record as written (null: absent or unparsable). For the updater's acknowledgement of a takeover. */
export function readFleetLockRecord(dataDir: string): FleetLockRecord | null {
  try { return parseRecord(readFileSync(join(dataDir, "fleet.lock"), "utf8")); } catch { return null; }
}
