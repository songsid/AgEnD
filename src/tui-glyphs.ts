/**
 * Glyphs used by TUI status lines, shared so a single list can't drift.
 *
 * Kiro CLI (and Antigravity) render context usage as a filling pie, stepping
 * through these as the window fills:
 *
 *   ◔ U+25D4  low        ◒ U+25D2  mid-high
 *   ◐ U+25D0  low-mid    ◓ U+25D3  high
 *   ◑ U+25D1  mid        ◕ U+25D5  very high
 *                        ● U+25CF  nearly full
 *
 * Matching only `◔` meant every reading above the lowest bracket was invisible
 * to `/ctx` and to the ready pattern — and the same character class had been
 * copied to four places, so two of them were missed when the bug was first
 * reported. Import this instead of writing the class out again.
 */
export const PIE_GLYPHS = "◔◐◑◒◓◕●";

/** Character class for the pie glyphs, e.g. `new RegExp(`${PIE_CLASS}\\s*(\\d+)%`)`. */
export const PIE_CLASS = `[${PIE_GLYPHS}]`;

/**
 * Matches a TUI context reading such as `◑ 27%` or `kiro · ◑ 27% · λ`; group 1
 * is the percentage. Requires the pie at line-start or after a status separator
 * (`·` / box glyph), and not free prose like "● 45% 完成" mid-sentence.
 */
export const PIE_PERCENT_RE = new RegExp(
  `(?:^|[·│┃])\\s*${PIE_CLASS}\\s*(\\d+)%(?=\\s*(?:[·│┃λ!❯>]|$))`,
  "m",
);
