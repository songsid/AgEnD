import { existsSync, readFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { getTmuxSession } from "./config.js";
import type { Logger } from "./logger.js";
import {
  DeliveryOutbox,
  type DeliveryReconciliationCandidate,
} from "./delivery-outbox.js";
import { transcriptAbsenceCanProveNotSubmitted } from "./delivery-queue-evidence.js";
import { TmuxManager } from "./tmux-manager.js";

export const RECONCILIATION_PANE_CAPTURE_TIMEOUT_MS = 2_000;
export const RECONCILIATION_WRITE_DRAIN_TIMEOUT_MS = 15_000;
export const RECONCILIATION_WINDOW_EXIT_TIMEOUT_MS = 15_000;
export const RECONCILIATION_TRANSCRIPT_STABLE_TIMEOUT_MS = 10_000;
const TRANSCRIPT_MAX_DELTA_BYTES = 64 * 1024 * 1024;
const ENTER_MARKER = (deliveryId: string) => `[agend-delivery-id:${deliveryId}]`;

export interface CapturedAttempt {
  candidate: DeliveryReconciliationCandidate;
  paneWindowId: string | null;
  panePid: number | null;
  pane: string | null;
  paneCaptureError: string | null;
}

/** Split capture from retirement so an in-process Daemon.stop can own the kill. */
export interface CapturedTargetReconciliation {
  targetInstance: string;
  sessionName: string;
  savedWindowId: string | null;
  attempts: CapturedAttempt[];
}

function readSavedWindowId(instanceDir: string): string | null {
  try { return readFileSync(join(instanceDir, "window-id"), "utf-8").trim() || null; }
  catch { return null; }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Capture the old pane before a stop/replacement startup can destroy it. This
 * is per-target; callers do not gate unrelated daemon starts or dispatch lanes.
 */
export async function capturePendingTargetReconciliation(
  outbox: DeliveryOutbox,
  targetInstance: string,
  instanceDir: string,
  sessionName = getTmuxSession(),
  logger?: Pick<Logger, "debug" | "warn">,
): Promise<CapturedTargetReconciliation> {
  const candidates = outbox.getReconciliationCandidates(targetInstance);
  const savedWindowId = readSavedWindowId(instanceDir);
  const uniqueWindowIds = [...new Set(candidates.map(item => item.attempt.windowId ?? savedWindowId).filter((id): id is string => !!id))];
  const paneByWindow = new Map<string, { pane: string | null; panePid: number | null; error: string | null }>();
  await Promise.all(uniqueWindowIds.map(async windowId => {
    const tmux = new TmuxManager(sessionName, windowId);
    let panePid: number | null = null;
    let pane: string | null = null;
    let error: string | null = null;
    try {
      panePid = await TmuxManager.getPanePid(sessionName, windowId, RECONCILIATION_PANE_CAPTURE_TIMEOUT_MS);
      pane = await tmux.capturePane(RECONCILIATION_PANE_CAPTURE_TIMEOUT_MS);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logger?.debug({ targetInstance, windowId, err: error }, "Could not capture old pane before durable reconciliation");
    }
    paneByWindow.set(windowId, { pane, panePid, error });
  }));

  return {
    targetInstance,
    sessionName,
    savedWindowId,
    attempts: candidates.map(candidate => {
      const paneWindowId = candidate.attempt.windowId ?? savedWindowId;
      const captured = paneWindowId ? paneByWindow.get(paneWindowId) : undefined;
      return {
        candidate,
        paneWindowId,
        panePid: captured?.panePid ?? null,
        pane: captured?.pane ?? null,
        paneCaptureError: captured?.error ?? (paneWindowId ? "pane capture unavailable" : "old window id unavailable"),
      };
    }),
  };
}

async function processHasExited(pid: number | null): Promise<boolean> {
  if (!pid) return true; // tmux's confirmed window removal is the remaining fence.
  const deadline = Date.now() + RECONCILIATION_WINDOW_EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return true;
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

async function readTranscriptDelta(candidate: DeliveryReconciliationCandidate): Promise<"matched" | "no-match" | "unavailable"> {
  const path = candidate.attempt.transcriptPath;
  const offset = candidate.attempt.transcriptOffset;
  if (!path || offset === null || !candidate.attempt.backend
    || !["claude-code", "codex"].includes(candidate.attempt.backend)) return "unavailable";

  const deadline = Date.now() + RECONCILIATION_TRANSCRIPT_STABLE_TIMEOUT_MS;
  let previousSize = -1;
  let stableChecks = 0;
  let size = 0;
  while (Date.now() < deadline) {
    try { size = (await stat(path)).size; }
    catch { return "unavailable"; }
    if (size === previousSize) stableChecks++;
    else stableChecks = 0;
    if (stableChecks >= 2) break;
    previousSize = size;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (stableChecks < 2 || size < offset || size - offset > TRANSCRIPT_MAX_DELTA_BYTES) return "unavailable";
  try {
    const fh = await open(path, "r");
    try {
      const length = size - offset;
      if (!length) return "no-match";
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buffer, 0, length, offset);
      const found = transcriptDeltaHasDeliveryMarker(
        buffer.toString("utf8", 0, bytesRead),
        candidate.attempt.backend,
        candidate.deliveryId,
      );
      return found ? "matched" : "no-match";
    } finally {
      await fh.close();
    }
  } catch {
    return "unavailable";
  }
}

function userTextsFromEntry(entry: unknown, backend: string): string[] {
  if (!entry || typeof entry !== "object") return [];
  const value = entry as Record<string, any>;
  if (backend === "claude-code") {
    const message = value.message;
    if (value.type !== "user" || message?.role !== "user") return [];
    const content = message.content;
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    return content.filter((item: any) => item?.type === "text" && typeof item.text === "string")
      .map((item: any) => item.text as string);
  }
  if (backend === "codex") {
    const payload = value.payload;
    if (value.type !== "response_item" || payload?.type !== "message" || payload?.role !== "user") return [];
    if (!Array.isArray(payload.content)) return [];
    return payload.content.filter((item: any) => item?.type === "input_text" && typeof item.text === "string")
      .map((item: any) => item.text as string);
  }
  return [];
}

/** A unique marker counts only at the start of a persisted user-message body. */
export function transcriptDeltaHasDeliveryMarker(rawDelta: string, backend: string, deliveryId: string): boolean {
  const marker = ENTER_MARKER(deliveryId);
  for (const line of rawDelta.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as unknown;
      const firstUserText = userTextsFromEntry(entry, backend)[0];
      if (firstUserText?.startsWith(marker)) return true;
    } catch { /* incomplete/malformed JSONL is not proof */ }
  }
  return false;
}

/**
 * After the old CLI is positively gone, classify the attempt. A committed
 * Enter-start marker prevents composer-only negative proof from authorizing a
 * replay. A stable transcript absence may retry an idle submit, but a native
 * queue/steer handoff stays uncertain unless its exact CLI-version policy was
 * validated not to replay that queue item after resume.
 */
export async function finishTargetReconciliation(
  outbox: DeliveryOutbox,
  captured: CapturedTargetReconciliation,
  oldWindowGone: boolean,
  logger?: Pick<Logger, "debug" | "warn">,
): Promise<{ delivered: number; retry: number; uncertain: number; safeToStart: boolean }> {
  const result = {
    delivered: 0,
    retry: 0,
    uncertain: 0,
    safeToStart: captured.attempts.length === 0 || oldWindowGone,
  };
  for (const item of captured.attempts) {
    const { candidate } = item;
    // A missing window id is not evidence that the old CLI exited: there was
    // no object to retire or verify. Keep this target fenced rather than
    // letting Strategy A start a replacement beside an unverified process.
    const processExited = oldWindowGone && !!item.paneWindowId
      && await processHasExited(item.panePid);
    if (!processExited) result.safeToStart = false;
    const transcript = processExited ? await readTranscriptDelta(candidate) : "unavailable";
    let outcome: "delivered" | "retry_wait" | "uncertain";
    let proof: string;
    if (transcript === "matched") {
      outcome = "delivered";
      proof = "cli-transcript-user-entry-marker";
    } else if (!candidate.attempt.enterStartedAt && processExited) {
      // W1 is authoritative negative evidence: this process cannot have sent
      // Enter before the timestamp was durably committed.
      outcome = "retry_wait";
      proof = item.paneCaptureError ? "enter-not-started; pane-capture-unavailable" : "enter-not-started; pre-kill-pane-captured";
    } else if (item.panePid !== null && processExited && transcript === "no-match"
      && transcriptAbsenceCanProveNotSubmitted(
        candidate.attempt.submissionMode,
        candidate.attempt.queueResumePolicy,
      )) {
      // A complete, stable transcript is negative evidence for an ordinary
      // idle submit. A native queue/steer entry can be absent because it is
      // still owned by the CLI queue, so only an exact, persisted version
      // policy that rules out resume replay can use absence for that mode.
      outcome = "retry_wait";
      proof = candidate.attempt.submissionMode === "idle_submit"
        ? "complete-transcript-no-marker; non-queued-submit"
        : "complete-transcript-no-marker; queue-version-proven-no-resume";
    } else {
      outcome = "uncertain";
      proof = !processExited
        ? "old-cli-exit-unconfirmed"
        : transcript === "unavailable" ? "transcript-unavailable-or-unstable"
          : candidate.attempt.submissionMode === "native_queue_handoff" || candidate.attempt.submissionMode === "steer"
            ? `queue-resume-policy-${candidate.attempt.queueResumePolicy ?? "unknown"}; transcript-marker-absent`
            : "enter-may-have-started-without-transcript-marker";
    }
    if (outbox.reconcileAttempt(candidate.deliveryId, candidate.attempt.targetDaemonBootId, candidate.attempt.attemptNo, outcome, proof)) {
      if (outcome === "retry_wait") result.retry++;
      else if (outcome === "delivered") result.delivered++;
      else result.uncertain++;
    }
    logger?.[outcome === "uncertain" ? "warn" : "debug"](
      { deliveryId: candidate.deliveryId, target: candidate.targetInstance, outcome, proof, submissionMode: candidate.attempt.submissionMode },
      "Reconciled durable delivery after target generation ended",
    );
  }
  return result;
}

/** Retire and positively verify every captured old window after a Daemon.stop. */
export async function retireCapturedTargetWindows(captured: CapturedTargetReconciliation): Promise<boolean> {
  const windowIds = [...new Set([
    captured.savedWindowId,
    ...captured.attempts.map(item => item.paneWindowId),
  ].filter((id): id is string => !!id))];
  let gone = true;
  for (const windowId of windowIds) {
    const oldWindow = new TmuxManager(captured.sessionName, windowId);
    const thisGone = await withTimeout(
      oldWindow.killWindowConfirmed(),
      RECONCILIATION_WINDOW_EXIT_TIMEOUT_MS,
      "old pane retirement",
    ).catch(() => false);
    gone &&= thisGone;
  }
  return gone;
}

/** Startup path: capture first, retire the old Strategy-A window, verify exit, then read transcript. */
export async function reconcileTargetBeforeStart(
  outbox: DeliveryOutbox,
  targetInstance: string,
  instanceDir: string,
  logger?: Pick<Logger, "debug" | "warn">,
): Promise<{ delivered: number; retry: number; uncertain: number; safeToStart: boolean }> {
  const captured = await capturePendingTargetReconciliation(outbox, targetInstance, instanceDir, getTmuxSession(), logger);
  // Keep the historical Strategy-A best-effort cleanup for ordinary starts.
  // A verified retirement barrier is required only when an in-flight durable
  // submission needs pane/transcript reconciliation evidence.
  if (captured.attempts.length === 0) {
    return { delivered: 0, retry: 0, uncertain: 0, safeToStart: true };
  }
  const oldWindowGone = await retireCapturedTargetWindows(captured);
  return finishTargetReconciliation(outbox, captured, oldWindowGone, logger);
}
