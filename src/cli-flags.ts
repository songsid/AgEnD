/**
 * Split CLI words into flags and positionals (#1226). A flag in `withValue` takes the next word (repeatable: every
 * value is kept, in order); one in `bare` takes none. Anything else is a positional, in order.
 */
export function splitFlags(words: string[], withValue: string[], bare: string[] = []): { flags: Record<string, string[]>; positional: string[] } {
  const flags: Record<string, string[]> = {};
  const positional: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (withValue.includes(w) && i + 1 < words.length) { (flags[w] ??= []).push(words[++i]!); continue; }
    if (bare.includes(w)) { flags[w] = []; continue; }
    positional.push(w);
  }
  return { flags, positional };
}
