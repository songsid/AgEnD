/**
 * The record that says "a tunnel process may exist right now".
 *
 * It is written before anything is spawned and removed only after a death has
 * been proven, so the file's presence is the pessimistic answer: a lease we
 * cannot resolve blocks the next managed tunnel rather than being assumed
 * stale. That is the whole point — a tunnel nobody is tracking is a public
 * entrance nobody is watching.
 *
 * Deliberately free of any dependency on the fleet: the pre-fleet setup host
 * has to run the reaper too, and it runs in a process where no FleetManager
 * exists. Everything here takes a data directory and nothing else.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { probeProcess } from "../web-terminal.js";
import { TUNNEL_STOP_GRACE_MS } from "./types.js";

export interface TunnelLease {
  readonly sid: string;
  readonly provider: string;
  readonly originPort: number;
  /** Null only in the instant between reserving the lease and the spawn returning. */
  readonly providerPid: number | null;
  /** `probeProcess` identity at spawn. Null on platforms that cannot produce one. */
  readonly strongIdentity: string | null;
  readonly expiresAt: number;
  /** The process that owns this lease; a live owner means it is not ours to reap. */
  readonly ownerPid: number;
  /**
   * The owner's own fingerprint at the time it wrote the lease.
   *
   * Without it, "the owner pid is alive" is a guess: after a crash the number
   * can belong to something entirely unrelated, and the lease would then be
   * held forever by a process that has never heard of it. Ticket 5 had the same
   * trap in `fleet.lock`.
   */
  readonly ownerIdentity: string | null;
}

export function leasePath(dataDir: string): string {
  return join(dataDir, "tunnel.lease");
}

/**
 * Atomic, owner-only, and on disk before the call returns.
 *
 * The fsync is not ceremony: the lease has to survive the crash that makes it
 * matter, and a rename that is only in page cache does not.
 */
export function writeLease(dataDir: string, lease: TunnelLease): void {
  mkdirSync(dataDir, { recursive: true });
  const path = leasePath(dataDir);
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(lease));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* already gone */ }
    throw err;
  }
}

export function readLease(dataDir: string): TunnelLease | null {
  let raw: string;
  try {
    raw = readFileSync(leasePath(dataDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Unreadable is not absent. Saying "no lease" here would let a second
    // tunnel start beside one we simply could not see.
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<TunnelLease>;
    if (typeof parsed.provider !== "string" || typeof parsed.ownerPid !== "number") return CORRUPT;
    return {
      sid: String(parsed.sid ?? ""),
      provider: parsed.provider,
      originPort: Number(parsed.originPort ?? 0),
      providerPid: typeof parsed.providerPid === "number" ? parsed.providerPid : null,
      strongIdentity: typeof parsed.strongIdentity === "string" ? parsed.strongIdentity : null,
      expiresAt: Number(parsed.expiresAt ?? 0),
      ownerPid: parsed.ownerPid,
      ownerIdentity: typeof parsed.ownerIdentity === "string" ? parsed.ownerIdentity : null,
    };
  } catch {
    return CORRUPT;
  }
}

/**
 * A lease we cannot parse still means a tunnel may exist.
 *
 * Returning null would be "no tunnel", which is the one answer a damaged file
 * cannot justify. This stands in as an unresolvable lease, so the reaper asks
 * for a human instead of clearing the way.
 */
const CORRUPT: TunnelLease = {
  sid: "", provider: "unknown", originPort: 0,
  providerPid: null, strongIdentity: null, expiresAt: 0, ownerPid: 0, ownerIdentity: null,
};

export function clearLease(dataDir: string): void {
  try { unlinkSync(leasePath(dataDir)); } catch { /* already gone */ }
}

export type ReapOutcome =
  /** No lease; a new managed tunnel may start. */
  | { readonly kind: "clear" }
  /** A live owner holds it. Not ours to reap, and not ours to replace. */
  | { readonly kind: "held"; readonly ownerPid: number }
  /** The process was already gone, or was killed and proven gone. Lease removed. */
  | { readonly kind: "reaped"; readonly how: "already-gone" | "pid-reused" | "killed"; readonly pid: number | null }
  /** Could not prove death. Lease kept, and it keeps blocking. */
  | { readonly kind: "manual"; readonly reason: string; readonly pid: number | null; readonly leasePath: string };

export interface ReapOptions {
  now?: () => number;
  /** Injected so a test never signals a real process. */
  probe?: typeof probeProcess;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Injected so the grace periods do not make tests slow. */
  wait?: (ms: number) => Promise<void>;
  graceMs?: number;
}

/**
 * Resolve whatever the last run left behind, before anything new is started.
 *
 * Runs from any process — the fleet at startup and the pre-fleet setup host
 * both call it, which is why it takes a directory rather than a manager.
 */
export async function reapStaleTunnel(dataDir: string, opts: ReapOptions = {}): Promise<ReapOutcome> {
  const now = opts.now ?? Date.now;
  const probe = opts.probe ?? probeProcess;
  const kill = opts.kill ?? ((pid, signal) => { process.kill(pid, signal); });
  const wait = opts.wait ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const graceMs = opts.graceMs ?? TUNNEL_STOP_GRACE_MS;

  const lease = readLease(dataDir);
  if (!lease) return { kind: "clear" };

  // Someone else is using it right now. An expired lease held by a live owner
  // is still theirs: the owner is the one that will prove its child's death,
  // and reaping underneath it would race that proof.
  //
  // "Alive" means the same process, not the same number. A pid that outlived
  // its owner and was handed to something unrelated would otherwise hold this
  // lease forever — which is exactly how ticket 5's setup-host lock became
  // unreclaimable.
  if (lease.ownerPid > 0 && lease.ownerPid !== process.pid) {
    const owner = probe(lease.ownerPid);
    const sameOwner = owner.kind === "identified" && lease.ownerIdentity
      ? owner.identity === lease.ownerIdentity
      : owner.kind !== "gone";
    if (sameOwner) return { kind: "held", ownerPid: lease.ownerPid };
  }
  void now;

  if (lease.providerPid === null) {
    // Reserved but never recorded: either nothing was ever spawned, or the
    // owner died in the instant between the spawn returning and the pid being
    // written. The second case leaves a child we cannot name, and guessing is
    // exactly what this whole file exists to avoid.
    return {
      kind: "manual",
      reason: "the lease names no process, so a tunnel may exist that cannot be identified",
      pid: null,
      leasePath: leasePath(dataDir),
    };
  }

  const before = probe(lease.providerPid);
  if (before.kind === "gone") {
    clearLease(dataDir);
    return { kind: "reaped", how: "already-gone", pid: lease.providerPid };
  }
  if (before.kind === "identified" && lease.strongIdentity && before.identity !== lease.strongIdentity) {
    // The pid belongs to something else now, which proves the original died.
    // Signalling it would kill an innocent process — the single most damaging
    // thing a reaper can do, and the reason the fingerprint is recorded at all.
    clearLease(dataDir);
    return { kind: "reaped", how: "pid-reused", pid: lease.providerPid };
  }
  if (before.kind === "unknown" || !lease.strongIdentity) {
    return {
      kind: "manual",
      reason: before.kind === "unknown"
        ? "this platform cannot prove which process holds that pid"
        : "the lease carries no fingerprint, so the pid cannot be matched to the original process",
      pid: lease.providerPid,
      leasePath: leasePath(dataDir),
    };
  }

  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try { kill(lease.providerPid, signal); } catch { /* it may have just exited */ }
    await wait(graceMs);
    const after = probe(lease.providerPid);
    if (after.kind === "gone") {
      clearLease(dataDir);
      return { kind: "reaped", how: "killed", pid: lease.providerPid };
    }
    if (after.kind === "identified" && after.identity !== lease.strongIdentity) {
      clearLease(dataDir);
      return { kind: "reaped", how: "pid-reused", pid: lease.providerPid };
    }
  }

  return {
    kind: "manual",
    reason: "the process did not exit after SIGTERM and SIGKILL",
    pid: lease.providerPid,
    leasePath: leasePath(dataDir),
  };
}

/** What to tell a human when a lease could not be resolved. Never "closed safely". */
export function manualCleanupMessage(outcome: Extract<ReapOutcome, { kind: "manual" }>): string {
  const target = outcome.pid === null ? "the tunnel process" : `pid ${outcome.pid}`;
  return `A tunnel could not be confirmed closed: ${outcome.reason}. `
    + `No new tunnel will be opened until this is resolved. Check ${target}, kill it if it is still running, `
    + `then delete ${outcome.leasePath}.`;
}
