/**
 * #1218 PR4: whether the Log may read a kiro instance's own history, and if not, why (the leader's ruling, 2026-10-13;
 * sol's design check on #849). Two proofs are needed, and both must be positive — an unknown is a no:
 *
 * 1. **The root.** The launch's store root is the one the reader would open. Per engine: a credential profile's launch
 *    sets `XDG_DATA_HOME` itself, which proves the classic (v1) store; the TUI (v2) store's `KIRO_HOME` is inherited from
 *    the tmux server's environment and set by no launch, so it is never proven here. Launches are not changed to prove
 *    it (a prefix would move an existing instance's store, account and conversation): that is a report-only
 *    root-consistency change of its own (#849).
 * 2. **The current session.** `--resume-id` proves where a launch started, not where the instance is now: a `/clear` or
 *    `/chat load` typed in its terminal can move it unseen, and a sibling in the same directory writes rows that look the
 *    same. No seam observes that yet (#1789), so this proof is never positive today.
 *
 * Until both hold, a kiro Log shows fleet events only, with the reason. There is no "may not be current" fallback,
 * and no newest-row-for-this-directory or cross-engine guess. Fresh and legacy launches own no conversation id; V3 is
 * not read at all.
 */

/** What an instance's last built kiro launch was: its engine, how it chose its conversation, its credential profile. */
export interface KiroLogLaunch {
  engine: "v1" | "v2" | "v3" | null;
  mode: "legacy" | "resume" | "fresh";
  credentialProfile: string | null;
}

/** Why a kiro Log shows fleet events only (each one worded on the tab). */
export type KiroLogReason =
  | "kiro_not_running" | "kiro_v3" | "kiro_engine_unknown" | "kiro_legacy" | "kiro_fresh"
  | "kiro_v2_root" | "kiro_no_profile" | "kiro_session_unobservable";

/** The proofs beyond the launch itself. Neither exists yet: see #849 (root) and #1789 (current session). */
export interface KiroLogProofs {
  /** The TUI store's root, proven equal for this launch. */
  v2Root?(): boolean;
  /** The conversation the instance is in now is the one its launch resumed. */
  currentSession?(): boolean;
}

/** Today's proofs: none. */
export const KIRO_LOG_PROOFS_TODAY: KiroLogProofs = {};

export type KiroLogGate = { open: false; reason: KiroLogReason } | { open: true; engine: "v1" | "v2" };

export function kiroLogGate(launch: KiroLogLaunch | null, proofs: KiroLogProofs = KIRO_LOG_PROOFS_TODAY): KiroLogGate {
  if (!launch) return { open: false, reason: "kiro_not_running" };
  if (launch.engine === "v3") return { open: false, reason: "kiro_v3" };
  if (!launch.engine) return { open: false, reason: "kiro_engine_unknown" };
  if (launch.mode === "legacy") return { open: false, reason: "kiro_legacy" };
  if (launch.mode !== "resume") return { open: false, reason: "kiro_fresh" };
  if (launch.engine === "v2" && proofs.v2Root?.() !== true) return { open: false, reason: "kiro_v2_root" };
  if (launch.engine === "v1" && !launch.credentialProfile) return { open: false, reason: "kiro_no_profile" };
  if (proofs.currentSession?.() !== true) return { open: false, reason: "kiro_session_unobservable" };
  return { open: true, engine: launch.engine };
}
