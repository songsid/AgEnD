/**
 * #2482: what the delivery idle gate says when it stops waiting and hands the message over.
 *
 * Measured on the host (2026-10-19 → 23, 924 timeouts): every one was a target that was really mid-turn — inside a
 * claude-code turn (user message → end_turn) or a codex turn (task_started → task_complete) by the CLI's own transcript,
 * or finishing during the 60 s wait. The CLI queues the message and reads it after its turn: the normal case, not a
 * warning. A WARN is kept for what may be an anomaly: a target that has reported `working` for a long time while its
 * pane has not changed for a long time (stuck detection), and a timeout on a target that is not `working` at all.
 */
import type { InstanceStateSnapshot } from "./backend/types.js";

/** `working` this long, with a pane still this long, may be a stuck detection rather than a long task. */
export const STUCK_WORKING_MS = 60 * 60 * 1000;
export const STUCK_QUIET_MS = 10 * 60 * 1000;

export interface IdleGateTimeoutLog {
  level: "info" | "warn";
  message: string;
  fields: Record<string, unknown>;
}

export function idleGateTimeoutLog(instanceName: string, timeoutMs: number, snapshot: InstanceStateSnapshot | undefined, now: number): IdleGateTimeoutLog {
  if (snapshot?.state === "working") {
    const busyForMs = Math.max(0, now - snapshot.stateChangedAt);
    const fields = { instanceName, timeoutMs, busyForMs, paneStillForMs: snapshot.unchangedForMs };
    if (busyForMs >= STUCK_WORKING_MS && snapshot.unchangedForMs >= STUCK_QUIET_MS) {
      return { level: "warn", message: "Idle gate timed out on a target working for an hour with a still pane; forcing delivery", fields };
    }
    return { level: "info", message: "Delivered while the target is busy; its CLI reads it after the current turn", fields };
  }
  return { level: "warn", message: "Idle gate timed out; forcing delivery", fields: { instanceName, timeoutMs, state: snapshot?.state ?? "unknown" } };
}
