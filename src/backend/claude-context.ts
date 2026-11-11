/**
 * Claude Code's 1M-token context window: which models the probe gives a `[1m]` variant (listApiModels → Telegram's
 * "/model → more models"; Web Settings lists none). No I/O.
 *
 * The native-1M table below is the documentation's, written by hand: a NEW model series it does not know is treated as
 * not native, so while its entry reports 1M+ it gets a redundant `[1m]` variant — add the series here when one ships.
 */

export const ONE_MILLION_TOKENS = 1_000_000;
export const ONE_MILLION_SUFFIX = "[1m]";

/**
 * Whether a claude model has the 1M window by default (https://code.claude.com/docs/en/model-config): Fable, Sonnet 5
 * and later, Haiku 5.5 and later, Opus 4.7 and later. An id this cannot read is not treated as native: it then gets
 * its `[1m]` variant only if its own entry reports 1M+.
 */
export function claudeNativeOneMillion(id: string): boolean {
  const name = id.toLowerCase().replace(/\[1m\]$/, "");
  if (/(?:^|[-_/])fable(?:[-_]|$)/.test(name)) return true;
  const m = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(name);
  if (!m) return false;
  const major = Number(m[2]), minor = m[3] ? Number(m[3]) : 0;
  const [needMajor, needMinor] = m[1] === "opus" ? [4, 7] : m[1] === "sonnet" ? [5, 0] : [5, 5];
  return major > needMajor || (major === needMajor && minor >= needMinor);
}

/** Whether claude's `<id>[1m]` should be offered: the model reports 1M+ input and does not have it by default. */
export function claudeOneMillionOffered(id: string, maxInputTokens: unknown): boolean {
  return typeof maxInputTokens === "number" && Number.isFinite(maxInputTokens) && maxInputTokens >= ONE_MILLION_TOKENS && !claudeNativeOneMillion(id);
}
