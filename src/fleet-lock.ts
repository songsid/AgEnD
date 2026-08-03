import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

interface FleetLockRecord {
  pid: number;
  nonce: string;
  createdAt: string;
}

export interface FleetLockHandle {
  path: string;
  record: FleetLockRecord;
  serialized: string;
}

export interface FleetLockProbe {
  pid?: number;
  nonce?: string;
  isProcessAlive?: (pid: number) => boolean;
  readCommandLine?: (pid: number) => string;
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

function processCommandLine(pid: number): string {
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
  mkdirSync(dataDir, { recursive: true });
  const lockPath = join(dataDir, "fleet.lock");
  const pid = probe.pid ?? process.pid;
  const record: FleetLockRecord = {
    pid,
    nonce: probe.nonce ?? randomBytes(16).toString("hex"),
    createdAt: new Date().toISOString(),
  };
  const serialized = JSON.stringify(record) + "\n";
  const isAlive = probe.isProcessAlive ?? processAlive;
  const readCommandLine = probe.readCommandLine ?? processCommandLine;

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
    if (owner && isAlive(owner.pid)) {
      const commandLine = readCommandLine(owner.pid);
      if (isFleetStartCommandLine(commandLine)) {
        throw new Error(`Fleet is already running (PID ${owner.pid}, lock: ${lockPath})`);
      }
      // An alive PID with an unreadable command line is not safe to steal from.
      if (!commandLine) {
        throw new Error(`Fleet lock is owned by live PID ${owner.pid}; refusing to replace it`);
      }
      // The PID was reused by an unrelated process: the lock is stale.
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
