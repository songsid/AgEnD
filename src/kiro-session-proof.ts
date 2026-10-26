/**
 * M-2025 / survey #2681 candidates 5 and 10: after a tui or V3 launch, AgEnD types
 * `/session-id` and `/title` into an idle composer. The session id is kiro's own
 * announcement (tui.js `showSessionId`), compared with the pin from #2617. A
 * mismatch is logged and surfaced; the pin is never replaced by a file-store guess.
 * Legacy has no these commands: it keeps the tmux window name.
 *
 * Live 2.34.0 tui.js:
 *   showSessionId → announceSystem(`Session ID: ${id}\nResume with: kiro-cli --resume-id ${id}`)
 *                   or `Session ID: none`
 *   updateTitle   → showAlert(`Title set: ${title}`)
 */
export const KIRO_SESSION_ID_COMMAND = "/session-id";

/** Same shape kiro-identity uses for conversation ids. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

const TITLE_SET = /Title set:\s*(.+?)\s*$/m;

export type KiroObservedSessionId = string | "none";

export type KiroSessionIdProof =
  | { kind: "match"; id: string }
  | { kind: "fresh"; id: string }
  | { kind: "none" }
  | { kind: "mismatch"; pinned: string; observed: KiroObservedSessionId }
  | { kind: "unread" };

/** The id kiro announced on the pane, or null when the announcement is not in view. */
export function readKiroSessionIdAnnouncement(pane: string): KiroObservedSessionId | null {
  let last: string | null = null;
  for (const m of pane.matchAll(/Session ID:\s*([A-Za-z0-9][A-Za-z0-9_.-]{0,199})\b/g)) last = m[1] ?? null;
  if (last === "none") return "none";
  if (last && SAFE_ID.test(last)) return last;
  return null;
}

/** The title kiro confirmed it set, or null. */
export function readKiroTitleSetAlert(pane: string): string | null {
  const m = TITLE_SET.exec(pane);
  return m ? m[1]!.trim() : null;
}

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
