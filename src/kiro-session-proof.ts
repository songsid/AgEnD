/**
 * M-2025 / survey #2681 candidates 5 and 10: after a tui or V3 launch, AgEnD types
 * `/session-id` and `/title` into an idle composer. The session id is kiro's own
 * announcement (tui.js `showSessionId`), compared with the pin from #2617. A
 * mismatch is logged and surfaced; the pin is never replaced by a file-store guess.
 * A match (or a fresh launch that named an id) is recorded as proven in the
 * instance dir — that file is not an identity claim.
 * Legacy has no these commands: it keeps the tmux window name.
 *
 * Live 2.34.0 tui.js:
 *   showSessionId → announceSystem(`Session ID: ${id}\nResume with: kiro-cli --resume-id ${id}`)
 *                   or `Session ID: none`
 *   updateTitle   → showAlert(`Title set: ${title}`), or `Terminal title is disabled …` (the default)
 * The pane readers live with kiro's other layout readers (backend/kiro.ts: readKiroCommandComposer,
 * readKiroSessionIdAlert); the daemon types each command only into a positively empty composer and
 * takes the id only from an alert that was not on the pane before it typed (#2683).
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./backend/kiro-engine-ledger.js";
import { ensureInstanceDir } from "./private-dir.js";

export const KIRO_SESSION_ID_COMMAND = "/session-id";
export const KIRO_SESSION_PROOF_FILE = "kiro-session-proof.json";

/** Same shape kiro-identity uses for conversation ids. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

export type KiroObservedSessionId = string | "none";

export type KiroSessionIdProof =
  | { kind: "match"; id: string }
  | { kind: "fresh"; id: string }
  | { kind: "none" }
  | { kind: "mismatch"; pinned: string; observed: KiroObservedSessionId }
  | { kind: "unread" };

/**
 * Compare the pane's `/session-id` with the launch pin. `unread` and `mismatch`
 * must not be repaired by listing session files.
 */
export function proveKiroSessionId(pinned: string | null, observed: KiroObservedSessionId | null): KiroSessionIdProof {
  if (observed === null) return { kind: "unread" };
  if (pinned && observed !== pinned) return { kind: "mismatch", pinned, observed };
  if (observed === "none") return { kind: "none" };
  if (!pinned) return { kind: "fresh", id: observed };
  return { kind: "match", id: observed };
}

/** `/title <name>` for tui/V3. Empty or newline-bearing names are refused. */
export function kiroTitleCommand(instanceName: string): string | null {
  const name = instanceName.trim();
  if (!name || /[\n\r]/.test(name)) return null;
  return `/title ${name}`;
}

export interface KiroSessionProofRecord {
  version: 1;
  sessionId: string;
  kind: "match" | "fresh";
  source: "/session-id";
  provenAt: number;
}

function proofPath(instanceDir: string): string {
  return join(instanceDir, KIRO_SESSION_PROOF_FILE);
}

/** Persist kiro's own `/session-id` as proven. Does not write identity claims. */
export function recordKiroSessionProof(
  instanceDir: string,
  rec: { sessionId: string; kind: "match" | "fresh"; provenAt?: number },
): KiroSessionProofRecord {
  if (!SAFE_ID.test(rec.sessionId) || rec.sessionId === "none") {
    throw new Error("kiro session proof refuses this id");
  }
  const written: KiroSessionProofRecord = {
    version: 1,
    sessionId: rec.sessionId,
    kind: rec.kind,
    source: "/session-id",
    provenAt: rec.provenAt ?? Date.now(),
  };
  ensureInstanceDir(instanceDir);
  writeFileAtomic(proofPath(instanceDir), JSON.stringify(written) + "\n");
  return written;
}

/** This launch did not prove an id — drop a stale proof from an earlier launch. */
export function clearKiroSessionProof(instanceDir: string): void {
  rmSync(proofPath(instanceDir), { force: true });
}

export function readKiroSessionProof(instanceDir: string): KiroSessionProofRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(proofPath(instanceDir), "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const rec = parsed as Partial<KiroSessionProofRecord>;
    if (rec.version !== 1 || (rec.kind !== "match" && rec.kind !== "fresh")) return null;
    if (rec.source !== "/session-id" || typeof rec.sessionId !== "string" || typeof rec.provenAt !== "number") return null;
    if (!SAFE_ID.test(rec.sessionId) || rec.sessionId === "none") return null;
    return { version: 1, sessionId: rec.sessionId, kind: rec.kind, source: "/session-id", provenAt: rec.provenAt };
  } catch {
    return null;
  }
}
