import type { DurableSubmissionMode } from "./delivery-outbox.js";

/**
 * Whether a CLI may restore an in-flight native queue item after its process
 * exits and the same session is resumed. This is a versioned, fail-closed
 * contract: a backend/version is eligible for `does_not_resume` only after a
 * whole-CLI-process restart test proves that behavior.
 */
export type QueueResumePolicy =
  | "not_applicable"
  | "unknown"
  | "may_resume"
  | "does_not_resume";

/**
 * No shipped CLI version is allowlisted yet. Codex's PTY queue and Claude's
 * interactive queued-input behavior have not been validated across a process
 * exit/resume, so a missing or newly upgraded version stays `unknown`.
 */
const VERIFIED_QUEUE_RESUME_POLICIES: Readonly<Record<string, Readonly<Record<string, QueueResumePolicy>>>> = {
  "claude-code": {},
  codex: {},
  muse: {},
  "kiro-cli": {},
  antigravity: {},
};

export function queueResumePolicyForAttempt(
  backend: string,
  backendVersion: string | null,
  submissionMode: DurableSubmissionMode,
): QueueResumePolicy {
  if (submissionMode === "idle_submit") return "not_applicable";
  if (!backendVersion) return "unknown";
  return VERIFIED_QUEUE_RESUME_POLICIES[backend]?.[backendVersion] ?? "unknown";
}

/**
 * A stable transcript without the marker is negative proof only when the
 * attempt was not handed to a CLI-owned queue, or an exact CLI version has a
 * validated contract that resume cannot replay that queue item.
 */
export function transcriptAbsenceCanProveNotSubmitted(
  submissionMode: DurableSubmissionMode | null,
  queueResumePolicy: QueueResumePolicy | null,
): boolean {
  if (submissionMode === "idle_submit") return true;
  if (submissionMode === "native_queue_handoff" || submissionMode === "steer") {
    return queueResumePolicy === "does_not_resume";
  }
  // Old rows and unknown submission modes do not have enough evidence to
  // authorize a replay.
  return false;
}
