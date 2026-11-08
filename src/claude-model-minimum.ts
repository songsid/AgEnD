/** Only Claude's own refusal supplies a minimum. No model table or default floor. */
export const CLAUDE_MINIMUM_ERROR = /^[ \t]*(?:●[ \t]+)?API Error:[ \t]*(?:400[ \t]+)?Claude Code[ \t]+(\d+\.\d+\.\d+)[ \t]+does\s+not\s+support\s+this\s+model;[ \t\r\n]*version[ \t]+(\d+\.\d+\.\d+)[ \t]+or\s+newer\s+is\s+required\.?[ \t]*$/im;

export function cliVersionBelow(a: string, b: string): boolean {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i]! < y[i]!;
  }
  return false;
}

export function claudeMinimumError(pane: string): { running: string; required: string } | null {
  const match = [...pane.matchAll(new RegExp(CLAUDE_MINIMUM_ERROR.source, "gim"))].at(-1);
  return match && cliVersionBelow(match[1]!, match[2]!)
    ? { running: match[1]!, required: match[2]! } : null;
}
