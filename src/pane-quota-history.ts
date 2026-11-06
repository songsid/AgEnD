/** Exact observed error messages, allowing only terminal whitespace/wrapping differences. */
export function quotaHistoryCount(pane: string, pattern: RegExp, messages: readonly string[]): number {
  const compact = (text: string) => text.replace(/\s+/gu, "");
  const visible = compact(pane);
  const known = new Map<string, { count: number; occurrences: number }>();
  const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
  for (const message of messages) {
    const occurrences = [...message.matchAll(new RegExp(pattern.source, flags))].length;
    if (!occurrences) continue;
    const text = compact(message);
    const old = known.get(text);
    known.set(text, { count: (old?.count ?? 0) + 1, occurrences });
  }
  let count = 0;
  for (const [text, old] of known) {
    let at = 0, found = 0;
    while ((at = visible.indexOf(text, at)) !== -1) { found++; at += text.length; }
    count += Math.min(found, old.count) * old.occurrences;
  }
  return count;
}

/** Only complete CLI quota error records written before the frozen pre-launch observation. */
export function codexQuotaErrorMessages(lines: readonly string[], at: number): string[] | null {
  const messages: string[] = [];
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { return null; }
    const payload = entry?.payload, written = Date.parse(entry?.timestamp);
    if (entry?.type === "event_msg" && payload?.type === "task_complete"
      && typeof payload.turn_id === "string" && payload.turn_id.length > 0 && Number.isFinite(written) && written < at
      && payload.error?.codex_error_info === "usage_limit_exceeded" && typeof payload.error.message === "string"
      && /you['’]ve hit your usage limit/i.test(payload.error.message)) messages.push(payload.error.message);
  }
  return messages;
}

/** A newly echoed acknowledged-input marker separates older rows from errors produced for that input.
 * Ambiguous/repeated markers prove nothing. Strip whitespace only to follow terminal line wrapping, retaining
 * the raw offset so error patterns are evaluated on their ordinary text rather than a normalized approximation.
 */
export function quotaAfterInput(pane: string, marker: string): string | null {
  const value = marker.replace(/\s/gu, ""), compact = pane.replace(/\s/gu, "");
  if (!value) return null;
  const start = compact.indexOf(value);
  if (start < 0 || compact.indexOf(value, start + 1) >= 0) return null;
  const end = start + value.length;
  let seen = 0;
  for (let index = 0; index < pane.length; index++) {
    if (!/\s/u.test(pane[index])) seen++;
    if (seen === end) return pane.slice(index + 1);
  }
  return null;
}
