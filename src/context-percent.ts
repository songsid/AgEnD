import { PIE_PERCENT_RE } from "./tui-glyphs.js";

export interface TokenContextRatio {
  usedLabel: string;
  totalLabel: string;
  percentage: number;
}

function tokenCount(value: string): number {
  const suffix = value.at(-1)?.toLowerCase();
  const multiplier = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : 1;
  return parseFloat(value) * multiplier;
}

/** Clamp a trusted numeric context reading to the user-visible 0-100 range. */
export function clampContextPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

/** Parse Grok's used/total token title-bar indicator, newest line first. */
export function parseTokenContextRatio(pane: string): TokenContextRatio | null {
  const lines = pane.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/(\d+\.?\d*[KkMm]?)\s*\/\s*(\d+\.?\d*[KkMm]?)/);
    if (!match) continue;
    const used = tokenCount(match[1]);
    const total = tokenCount(match[2]);
    // A captured pane can contain arbitrary user/agent prose such as
    // "200K / 11.1K" below Grok's real title bar. Context usage cannot exceed
    // its window, so reject that candidate and keep scanning for the title bar.
    if (Number.isFinite(used) && Number.isFinite(total) && total > 0 && used >= 0 && used <= total) {
      return { usedLabel: match[1], totalLabel: match[2], percentage: used / total * 100 };
    }
  }
  return null;
}

/**
 * Extract context USED percentage from a captured CLI pane. Invalid candidates
 * are ignored rather than clamped so an unrelated line cannot hide a valid
 * status line earlier in the capture.
 */
export function parseContextPercent(pane: string): number | null {
  const lines = pane.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const left = line.match(/Context\s+(\d+)%\s+left/i);
    if (left) {
      const remaining = parseInt(left[1], 10);
      if (remaining >= 0 && remaining <= 100) return 100 - remaining;
    }

    const ratio = parseTokenContextRatio(line);
    if (ratio) return ratio.percentage;

    const match = line.match(/(\d+)%.*[!❯>]/)
      || line.match(PIE_PERCENT_RE)
      || line.match(/\[(\d+)%\]/)
      || line.match(/Context\s+(\d+)%\s+used/i)
      || line.match(/\d+(?:\.\d+)?[KM]?\s*\((\d+)%\)/);
    if (!match) continue;
    const percentage = parseInt(match[1], 10);
    if (percentage >= 0 && percentage <= 100) return percentage;
  }
  return null;
}
