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
