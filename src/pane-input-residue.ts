/**
 * Pane-text helpers for TUIs that DROP an Enter arriving while they are busy
 * but keep the typed text as typeahead (Kiro's legacy UI, verified live on
 * kiro-cli 2.21.0). For such a TUI, output silence is not readiness: a shell or
 * MCP tool can run for many seconds without painting anything, and the daemon's
 * 2s-silence idle gate would paste into that window. The text then surfaces in
 * the prompt row after the turn, unsubmitted, and the next delivery's Enter
 * submits both messages as one.
 *
 * Everything here is a pure function over a `capture-pane -p` snapshot so the
 * exact frames captured during the reproduction can be replayed in tests.
 */

/** Marker every AgEnD-pasted message starts with (see formatInboundMessage). */
const AGEND_MESSAGE_MARKER = /\[(?:user|from|system):/;

function rows(pane: string): string[] {
  return pane.replace(/\r/g, "").split("\n");
}

/** The last row with any non-whitespace content, or null for a blank pane. */
export function lastNonBlankRow(pane: string): string | null {
  const all = rows(pane);
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].trim()) return all[i];
  }
  return null;
}

/**
 * Bottom-anchored readiness: the prompt marker must be on the LAST non-blank
 * row. A prompt higher up is history; during a tool call Kiro's bottom row is
 * the tool banner ("Purpose: …"), and while generating it is the spinner.
 */
export function bottomRowIsReady(pane: string, promptPattern: RegExp): boolean {
  const row = lastNonBlankRow(pane);
  return row != null && rowMatches(row, promptPattern);
}

/**
 * Text sitting in the input area: everything from the LAST prompt row to the end
 * of the pane, with the prompt prefix removed and continuation rows (a long
 * paste wraps) joined. Returns null when no prompt row is on screen.
 *
 * Callers must first rule out "busy": while generating, the bottom rows are the
 * assistant's output and the last prompt row is history, so this text would be
 * the previous turn's echo, not pending input.
 */
export function inputAreaText(pane: string, promptPattern: RegExp): string | null {
  const all = rows(pane);
  let promptIndex = -1;
  for (let i = all.length - 1; i >= 0; i--) {
    if (rowMatches(all[i], promptPattern)) { promptIndex = i; break; }
  }
  if (promptIndex < 0) return null;
  const promptRow = all[promptIndex];
  const match = promptRow.match(withoutMultiline(promptPattern));
  const afterPrompt = match ? promptRow.slice((match.index ?? 0) + match[0].length) : promptRow;
  const tail = all.slice(promptIndex + 1).map(r => r.trimEnd()).filter(r => r.trim());
  return [afterPrompt.trim(), ...tail].join("\n").trim();
}

/**
 * A distinctive head of what we pasted: the first 24 non-space characters of
 * the message BODY — i.e. after the routing header every AgEnD message starts
 * with (`[user:… id:…]` / `[from:…]`). Two messages from the same sender share
 * that header verbatim, so a header-based signature could not tell "our text is
 * still there" from "a different message is there". Long enough to be specific,
 * short enough to survive the TUI re-wrapping the row at the terminal width.
 */
export function pastedTextSignature(formatted: string): string {
  const firstLine = formatted.split(/\r?\n/).find(l => l.trim()) ?? "";
  const body = firstLine.replace(/^\s*(?:\[[^\]]*\]\s*)+/, "");
  const source = body.trim() ? body : firstLine;
  return source.replace(/\s+/g, "").slice(0, 24);
}

/**
 * True when the text we just pasted is still sitting in the input area — i.e.
 * the Enter did not submit it. Compares whitespace-insensitively because the
 * TUI re-wraps pasted text to the pane width.
 */
export function pasteLeftInInput(pane: string, promptPattern: RegExp, formatted: string): boolean {
  const input = inputAreaText(pane, promptPattern);
  if (!input) return false;
  const signature = pastedTextSignature(formatted);
  if (!signature) return false;
  return input.replace(/\s+/g, "").includes(signature);
}

/**
 * True when the input area holds an AgEnD message left behind by an earlier
 * delivery whose Enter was dropped (e.g. before a daemon restart, when the exact
 * text is no longer known). Placeholder hints Kiro prints in the prompt row
 * ("Not sure where to start? …") never carry the marker.
 */
export function strandedAgendMessageInInput(pane: string, promptPattern: RegExp): boolean {
  const input = inputAreaText(pane, promptPattern);
  return input != null && AGEND_MESSAGE_MARKER.test(input);
}

function rowMatches(row: string, pattern: RegExp): boolean {
  return withoutMultiline(pattern).test(row);
}

/** Row-local test: strip flags that would let `^`/`$` span rows or keep state. */
function withoutMultiline(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.replace(/[gmy]/g, ""));
}
