import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** Shared outer grace for service-managed and detached fleets (#1071).
 * This covers multiple 15/5/2-second Kiro batches; it is not an unlimited
 * guarantee for arbitrarily large fleets or stuck transport operations. */
export const FLEET_STOP_TIMEOUT_MS = 5 * 60_000;
const EXIT_CONFIRM_MS = 5_000;
const POLL_MS = 500;

export type DetachedOwnerState = "fleet" | "gone" | "other" | "unknown";
export interface DetachedStopDeps {
  /** No signal is authorized by an unreadable identity. */
  inspect(): DetachedOwnerState;
  signal(signal: "SIGTERM" | "SIGKILL"): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Stop the proven owner, and do not admit a replacement until it is gone.
 * No sleep subprocesses, no wall-clock budgets, and no kill(0) error treated
 * as exit proof except ESRCH (the caller's inspect contract). */
export async function stopDetachedOwner(deps: DetachedStopDeps): Promise<void> {
  const check = (): boolean => {
    const state = deps.inspect();
    if (state === "unknown") throw new Error("Cannot confirm the detached fleet owner; nothing else was signalled or started");
    return state === "fleet";
  };
  if (!check()) return;
  const deadline = deps.now() + FLEET_STOP_TIMEOUT_MS;
  deps.signal("SIGTERM");
  while (check()) {
    const remaining = deadline - deps.now();
    if (remaining <= 0) break;
    await deps.sleep(Math.min(POLL_MS, remaining));
  }
  // Re-read identity at the effect boundary, including after the last wait.
  if (!check()) return;
  deps.signal("SIGKILL");
  const exitDeadline = deps.now() + EXIT_CONFIRM_MS;
  while (check()) {
    const remaining = exitDeadline - deps.now();
    if (remaining <= 0) throw new Error("Detached fleet has not exited after SIGKILL; refusing to start a duplicate");
    await deps.sleep(Math.min(POLL_MS, remaining));
  }
}

/** systemctl show's human-readable TimeoutStopUSec, not a permissive parseInt. */
export function systemdStopTimeoutMs(raw: string): number | null {
  const text = raw.trim();
  if (text === "infinity") return Infinity;
  const units: Record<string, number> = { us: 0.001, ms: 1, s: 1_000, min: 60_000, h: 3_600_000, d: 86_400_000 };
  if (!/^(?:\d+(?:\.\d+)?(?:us|ms|s|min|h|d))(?:\s+\d+(?:\.\d+)?(?:us|ms|s|min|h|d))*$/.test(text)) return null;
  let total = 0;
  for (const part of text.split(/\s+/)) {
    const match = /^(\d+(?:\.\d+)?)(us|ms|s|min|h|d)$/.exec(part)!;
    total += Number(match[1]) * units[match[2]!]!;
  }
  return Number.isFinite(total) ? total : null;
}

/** Cached at claim and re-read before signals: a recycled PID is not our owner. */
export function detachedProcessStart(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm can contain spaces and ')': fields after its LAST ')' start at #3.
      const tail = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      return stat.lastIndexOf(")") > 0 && /^\d+$/.test(tail[19] ?? "") ? tail[19]! : null;
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 1_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch { return null; }
}
