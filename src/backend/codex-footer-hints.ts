/** Codex 0.165's passive final hint row, separate from its authoritative status row.
 * Audited: bottom_pane/{footer.rs,chat_composer/warning_notice.rs}, key_hint.rs at rust-v0.165.0.
 * Recognising this row never proves readiness: callers still require the original status/composer proof.
 * Queue/quit/search/overlay hints and arbitrary status labels are deliberately not this grammar.
 */
const base = String.raw`(?:f(?:2[0-4]|1[0-9]|[1-9])|enter|tab|backspace|esc|del|delete|fwd del|home|end|pgup|pgdn|space|[↑↓←→]|[!-~])`;
const binding = String.raw`(?:ctrl\+|\^|⌃)?(?:shift\+|⇧)?(?:alt\+|⌥)?(?:super\+|⌘)?${base}`;
// ShortcutHint is one binding or a two-binding chord, not arbitrary text.
const shortcut = String.raw`${binding}(?: ${binding})?`;
const warningKey = String.raw`(?:${shortcut}|/warnings)`;
const count = String.raw`[1-9][0-9]*`;
const warning = String.raw`⚠[ \t]+(?:1[ \t]+warning[ \t]+·[ \t]+${warningKey}[ \t]+to view|(?:[2-9]|[1-9][0-9]+)[ \t]+warnings[ \t]+·[ \t]+${warningKey}[ \t]+to view|${count}(?:[ \t]+·[ \t]+${warningKey})?)`;
const hint = String.raw`(?:← for agents(?: · ${shortcut} for shortcuts)?|${shortcut} for shortcuts)`;
export const CODEX_PASSIVE_HINT_ROW = String.raw`[ \t]*(?:${hint}(?:[ \t]{2,}${warning})?|${warning})[ \t]*`;
const row = new RegExp(`^${CODEX_PASSIVE_HINT_ROW}$`, "iu");
/** At most one final row; a second footer or anything after it remains unrecognised. */
export function stripCodexPassiveHintRow(rows: string[]): void {
  if (!row.test(rows.at(-1) ?? "")) return;
  rows.pop();
  while (rows.length && !rows.at(-1)!.trim()) rows.pop();
}
export function withCodexPassiveHintTail(pattern: RegExp): RegExp {
  return new RegExp(pattern.source.slice(0, -1) + String.raw`(?:\r?\n${CODEX_PASSIVE_HINT_ROW})?(?:\r?\n[ \t⋆]*)*$`, pattern.flags);
}

// Positive tail shape for the known native contextless layout. Neither pattern authorizes input by itself:
// callers still bind the native launch and check dialogs, work, liveness and the exact operation.
const passiveComposer = (text: "Ask Codex to do anything" | "/status") => new RegExp(
  String.raw`(?:^|\n)[>›][ \t⋆]+${text}[ \t⋆]*\r?\n(?:[ \t⋆]*\r?\n){0,3}${CODEX_PASSIVE_HINT_ROW}(?:\r?\n[ \t⋆]*)*$`, "iu");
export const CODEX_EMPTY_PASSIVE_COMPOSER = passiveComposer("Ask Codex to do anything");
export const CODEX_STATUS_PASSIVE_COMPOSER = passiveComposer("/status");

// Real 0.165 contextless /status completion replaces the passive footer. This is only the exact selected
// built-in command plus its one sibling and the same typed command; it is never empty-composer readiness.
const statusAutocomplete = /(?:^|\n)[>›][ \t]+\/status[ \t]{2,}show current session configuration and token usage[ \t]*\n[ \t]+\/statusline[ \t]{2,}configure which items appear in the status line[ \t]*\n(?:[ \t]*\n){0,3}[>›][ \t]+\/status[ \t]*(?:\n[ \t]*)*$/u;
export function isCodexStatusAutocompleteComposer(pane: string): boolean {
  const text = pane.replace(/\r/g, "");
  return statusAutocomplete.test(text)
    && [...text.matchAll(/^[>›][ \t]+\/[a-z][a-z-]*[ \t]{2,}\S.*$/gmu)].length === 1
    && [...text.matchAll(/^[ \t]+\/statusline[ \t]{2,}configure which items appear in the status line[ \t]*$/gmu)].length === 1;
}
