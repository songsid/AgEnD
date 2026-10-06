/**
 * #1209 ACP-resume-like cross-restart turn resume, stacked on the
 * TurnFingerprint seam (`session-signals.ts`, #1227).
 *
 * This is tmux-outer resume-*like* state machinery, not the ACP protocol:
 * when a channel turn is armed, a one-shot `in-flight-turn.json` marker is
 * written (with a seam fingerprint checkpoint); whatever survives a restart
 * is, by construction, an interrupted turn. After boot + CLI spawn, the gate
 * below decides exactly once whether to re-inject one bounded continuation
 * tied to the original correlation.
 *
 * Decision order (all in `decideTurnResume`, pure and matrix-tested):
 *   marker absent → none (covers cancel: cancel deletes the marker, #1199);
 *   crash-loop boot → skip (clean start, #835);
 *   marker delivery still pending in the outbox → skip (durable path owns it);
 *   store session id changed → skip (conversation is gone);
 *   seam reengaged → skip (CLI-native resume already drives; never double-drive);
 *   seam unknown → wait out the flush grace, then skip (default-deny);
 *   seam quiet → inject (compare only reports quiet outside the grace).
 *
 * The marker is consumed BEFORE gating (episode-once per interrupted turn —
 * a second boot never repeats), and completion/cancel paths delete it so a
 * finished turn never resumes. Backends without a seam reader resolve to
 * unknown and therefore never continue.
 *
 * Hit-rate note (P3c): post-boot writes that look like turns — the warmup
 * steering reload, durable outbox redelivery — advance the turn tail and
 * read as reengaged, so this gate skips. Safe (never double-drives) at the
 * cost of a missed resume; the seam cannot tell "the CLI resumed the work"
 * from "the daemon just drove the CLI".
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexBackend } from "./backend/codex.js";
import {
  compareFingerprints,
  claudeFingerprint,
  codexFingerprint,
  DEFAULT_FLUSH_GRACE_MS,
  museFingerprint,
  type TurnFingerprint,
} from "./backend/session-signals.js";

/** One-shot marker for the turn currently being worked. */
export interface InFlightTurnMarker {
  version: 1;
  deliveryId?: string;
  correlationId?: string;
  messageId?: string;
  chatId: string;
  threadId?: string;
  adapterId?: string;
  backend: string;
  cwd: string;
  armedAt: number;
  /** Seam checkpoint at arm time; null when the store was unreadable. */
  before: TurnFingerprint | null;
}

export const IN_FLIGHT_TURN_FILE = "in-flight-turn.json";

/** Extra settle past the flush grace before a held decision is retaken. */
export const RESUME_GRACE_SETTLE_MS = 1_000;

/** Outbox states in which the durable path may still drive the delivery. */
export const RESUME_BLOCKING_DELIVERY_STATES = [
  "queued",
  "delivering",
  "submission_started",
  "reconciliation_pending",
  "retry_wait",
] as const;

export type ResumeBackend = "claude" | "codex" | "muse";

/** Accept both factory ids and binary names; anything else has no seam reader. */
export function normalizeResumeBackend(backend: string | undefined | null): ResumeBackend | null {
  const key = (backend ?? "").trim().toLowerCase();
  if (key === "claude" || key === "claude-code") return "claude";
  if (key === "codex") return "codex";
  if (key === "muse") return "muse";
  return null;
}

export interface ResumeRoots {
  instanceDir: string;
  workingDirectory: string;
}

/**
 * Best-effort current fingerprint for a backend; null when unsupported or
 * unreadable (which the gate treats as unknown → default-deny). Synchronous
 * blocking I/O — arm-time only, never on a hot loop.
 */
export function readResumeFingerprint(
  backend: ResumeBackend | null,
  roots: ResumeRoots,
): TurnFingerprint | null {
  if (!backend || !roots.workingDirectory) return null;
  try {
    if (backend === "claude") {
      const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
      return claudeFingerprint({ configDir, cwd: roots.workingDirectory });
    }
    if (backend === "codex") {
      return codexFingerprint({
        stateDbPath: join(CodexBackend.shortHomeFor(roots.instanceDir), "state_5.sqlite"),
        cwd: roots.workingDirectory,
      });
    }
    return museFingerprint({
      sessionsRoot: join(homedir(), ".local", "share", "muse", "sessions"),
      cwd: roots.workingDirectory,
    });
  } catch {
    return null;
  }
}

/** Persist the in-flight marker (best effort; sync so a crash cannot interleave). */
export function writeInFlightTurnMarker(instanceDir: string, marker: InFlightTurnMarker): void {
  try {
    writeFileSync(join(instanceDir, IN_FLIGHT_TURN_FILE), JSON.stringify(marker));
  } catch { /* best effort — no marker just means no resume candidate */ }
}

/** A finished or cancelled turn must never resume after a later restart. */
export function clearInFlightTurnMarker(instanceDir: string): void {
  try { unlinkSync(join(instanceDir, IN_FLIGHT_TURN_FILE)); } catch { /* already gone */ }
}

function parseInFlightTurnMarker(raw: unknown): InFlightTurnMarker | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (m.version !== 1 || typeof m.chatId !== "string" || m.chatId === "") return null;
  if (typeof m.cwd !== "string" || typeof m.backend !== "string") return null;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
  const before = m.before;
  return {
    version: 1,
    deliveryId: str(m.deliveryId),
    correlationId: str(m.correlationId),
    messageId: str(m.messageId),
    chatId: m.chatId,
    threadId: str(m.threadId),
    adapterId: str(m.adapterId),
    backend: m.backend,
    cwd: m.cwd,
    armedAt: typeof m.armedAt === "number" ? m.armedAt : 0,
    before: before && typeof before === "object" ? (before as TurnFingerprint) : null,
  };
}

/**
 * Read and consume the marker in one step: episode-once whatever happens
 * after. A corrupt file is still unlinked (crash-state.json semantics) so it
 * cannot suppress or repeat forever.
 */
export function consumeInFlightTurnMarker(instanceDir: string): InFlightTurnMarker | null {
  const path = join(instanceDir, IN_FLIGHT_TURN_FILE);
  try {
    if (!existsSync(path)) return null;
    let marker: InFlightTurnMarker | null = null;
    try {
      marker = parseInFlightTurnMarker(JSON.parse(readFileSync(path, "utf-8")));
    } catch { /* corrupt — still consumed below */ }
    try { unlinkSync(path); } catch { /* best effort */ }
    return marker;
  } catch {
    return null;
  }
}

export interface ResumeGateInput {
  marker: InFlightTurnMarker | null;
  before: TurnFingerprint | null;
  after: TurnFingerprint | null;
  /** This boot's CLI spawn time; -1 when unknown (grace holding disabled). */
  daemonCausedMtimeMs: number;
  nowMs: number;
  flushGraceMs?: number;
  /** Crash-loop boot (crash-state.json asked to skip resume). */
  crashLoopBoot: boolean;
  /** The marker's delivery is still owned by the durable outbox path. */
  deliveryPending: boolean;
}

export type ResumeDecision =
  | { action: "inject"; detail: string }
  | { action: "wait"; waitMs: number; detail: string }
  | {
    action: "skip";
    reason: "none" | "crash-loop" | "delivery-pending" | "session-changed" | "cli-reengaged" | "unobservable";
    detail: string;
  };

/**
 * Pure #1209 gate. Only a quiet seam OUTSIDE the flush grace injects; a
 * changed session id and a reengaged CLI both skip (never double-drive);
 * unknown holds through the grace window (wait) and denies after it.
 */
export function decideTurnResume(input: ResumeGateInput): ResumeDecision {
  const flushGraceMs = input.flushGraceMs ?? DEFAULT_FLUSH_GRACE_MS;
  if (!input.marker) return { action: "skip", reason: "none", detail: "no interrupted turn" };
  if (input.crashLoopBoot) {
    return { action: "skip", reason: "crash-loop", detail: "crash-loop boot stays a clean start" };
  }
  if (input.deliveryPending) {
    return { action: "skip", reason: "delivery-pending", detail: "durable delivery path still owns the turn" };
  }
  const beforeId = input.before?.sessionId ?? null;
  const afterId = input.after?.sessionId ?? null;
  if (beforeId && afterId && beforeId !== afterId) {
    return { action: "skip", reason: "session-changed", detail: "store now belongs to a different conversation" };
  }
  const verdict = compareFingerprints(input.before, input.after, {
    daemonCausedMtimeMs: input.daemonCausedMtimeMs,
    nowMs: input.nowMs,
    flushGraceMs,
  });
  if (verdict === "reengaged") {
    return { action: "skip", reason: "cli-reengaged", detail: "CLI-native resume already drives the turn" };
  }
  const inGrace = input.daemonCausedMtimeMs >= 0 && input.nowMs - input.daemonCausedMtimeMs <= flushGraceMs;
  if (verdict === "unknown") {
    if (inGrace) {
      return {
        action: "wait",
        waitMs: flushGraceMs - (input.nowMs - input.daemonCausedMtimeMs) + RESUME_GRACE_SETTLE_MS,
        detail: "holding the flush-grace window before deciding",
      };
    }
    return { action: "skip", reason: "unobservable", detail: "store unreadable or unsupported; default-deny" };
  }
  // A quiet verdict is only reachable outside the grace (compare holds
  // inside-grace reads as unknown), so it is safe to inject here.
  return { action: "inject", detail: "interrupted turn, CLI idle, nothing else drives it" };
}

/** One bounded continuation tied to the original request — never a re-paste. */
export function buildResumeContinuation(marker: InFlightTurnMarker): { text: string; meta: Record<string, string> } {
  const ref = marker.correlationId ?? marker.messageId ?? marker.deliveryId ?? "unknown";
  const text = "[RESUME — the previous process died mid-turn. "
    + "Continue exactly this interrupted work, nothing else. "
    + `Original request: ${ref}.]`;
  const meta: Record<string, string> = {
    user: "instance:resume",
    user_id: "instance:resume",
    from_instance: "",
    chat_id: marker.chatId,
    message_id: `resume-${marker.armedAt}`,
  };
  if (marker.threadId) meta.thread_id = marker.threadId;
  if (marker.adapterId) meta.adapter_id = marker.adapterId;
  if (marker.correlationId) meta.correlation_id = marker.correlationId;
  if (marker.deliveryId ?? marker.messageId) {
    meta.resumedContinuationOf = String(marker.deliveryId ?? marker.messageId);
  }
  return { text, meta };
}
