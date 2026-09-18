/**
 * How often the Settings panel may restart AgEnD itself.
 *
 * This is one of the three things that actually hold the DoS line (with the
 * cookie/Origin gate and the out-of-band notice in the channel). The
 * "there must be a pending fleet-level change" precondition is *not* one of
 * them: whoever holds the token can create a pending change at will, so that
 * check only stops misclicks.
 *
 * Three properties the file has to have, all learned from how this fails:
 *
 * - **Written and fsynced before the restart is launched.** The process is
 *   about to be replaced. An attempt recorded after the spawn, or left in the
 *   OS page cache, is an attempt that never happened — and a rate limit whose
 *   counter resets on every restart does not limit restarts.
 * - **Attempts, not successes.** A restart that reliably fails would otherwise
 *   be retryable without limit, which is the cheapest possible attack.
 * - **No route may clear it.** A rate limit the attacker can reset is not a
 *   rate limit. Nothing in the web layer writes this file except `record()`.
 * - **Unreadable means spent, not fresh.** Treating a corrupt file as an empty
 *   one would let the control disarm itself exactly when its state is in doubt.
 *   Recovery is deleting the file on the host — which needs the same access as
 *   running `agend restart` directly.
 */
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const FILE = "self-restart.json";

/** At most one panel-triggered self-restart per 10 minutes… */
export const SELF_RESTART_MIN_INTERVAL_MS = 10 * 60_000;
/** …and at most three in an hour, so a slow drip cannot add up to a outage. */
export const SELF_RESTART_WINDOW_MS = 60 * 60_000;
export const SELF_RESTART_MAX_PER_WINDOW = 3;

export interface SelfRestartAllowance {
  allowed: boolean;
  /** Seconds until the next attempt would be accepted; 0 when allowed. */
  retryAfterSeconds: number;
  reason?: "too-soon" | "hourly-cap" | "unreadable";
}

interface LimitFile {
  attempts: number[];
}

function path(dataDir: string): string {
  return join(dataDir, FILE);
}

type LimitState =
  | { state: "empty" }
  | { state: "ok"; attempts: number[] }
  | { state: "unreadable" };

function read(dataDir: string): LimitState {
  let raw: string;
  try {
    raw = readFileSync(path(dataDir), "utf-8");
  } catch (err) {
    // Never written yet — the normal first run.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "empty" };
    return { state: "unreadable" };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LimitFile>;
    if (!Array.isArray(parsed.attempts)) return { state: "unreadable" };
    const attempts = parsed.attempts.filter(item => typeof item === "number" && Number.isFinite(item));
    if (attempts.length !== parsed.attempts.length) return { state: "unreadable" };
    return { state: "ok", attempts };
  } catch {
    // Half-written or corrupt. The one thing this must not do is read as "no
    // attempts yet" — a rate limit that resets itself when its own state is
    // damaged is not a rate limit.
    return { state: "unreadable" };
  }
}

function recordedAttempts(dataDir: string): number[] {
  const state = read(dataDir);
  return state.state === "ok" ? state.attempts : [];
}

export function checkSelfRestartAllowance(dataDir: string, now = Date.now()): SelfRestartAllowance {
  const state = read(dataDir);
  if (state.state === "unreadable") {
    return { allowed: false, reason: "unreadable", retryAfterSeconds: 0 };
  }
  const attempts = (state.state === "ok" ? state.attempts : [])
    .filter(at => now - at < SELF_RESTART_WINDOW_MS)
    .sort((a, b) => a - b);
  const last = attempts[attempts.length - 1];

  if (last !== undefined && now - last < SELF_RESTART_MIN_INTERVAL_MS) {
    return {
      allowed: false,
      reason: "too-soon",
      retryAfterSeconds: Math.max(1, Math.ceil((SELF_RESTART_MIN_INTERVAL_MS - (now - last)) / 1000)),
    };
  }
  if (attempts.length >= SELF_RESTART_MAX_PER_WINDOW) {
    const oldest = attempts[attempts.length - SELF_RESTART_MAX_PER_WINDOW]!;
    return {
      allowed: false,
      reason: "hourly-cap",
      retryAfterSeconds: Math.max(1, Math.ceil((SELF_RESTART_WINDOW_MS - (now - oldest)) / 1000)),
    };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Record an attempt durably, and say whether it reached the disk.
 *
 * The caller must refuse to restart when this returns false: an unrecorded
 * attempt is an unlimited one.
 */
export function recordSelfRestartAttempt(dataDir: string, now = Date.now()): boolean {
  const attempts = [...recordedAttempts(dataDir).filter(at => now - at < SELF_RESTART_WINDOW_MS), now];
  const target = path(dataDir);
  let fd: number | null = null;
  try {
    // Written in place with an fsync rather than the usual write-temp-and-rename:
    // what matters here is that the bytes are on the device before the process
    // is replaced, and a rename would need its own directory fsync to promise
    // the same thing.
    fd = openSync(target, "w", 0o600);
    writeSync(fd, JSON.stringify({ attempts } satisfies LimitFile));
    fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

/** Test seam: the attempts currently on disk, empty when unreadable. */
export function readSelfRestartAttempts(dataDir: string): number[] {
  return recordedAttempts(dataDir);
}
