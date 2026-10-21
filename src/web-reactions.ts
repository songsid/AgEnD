/**
 * #2305: which emojis an instance may react with on a web chat message — the minimal reply ("OK", "thanks") the
 * platforms already have.
 * - The set is Telegram's fixed reaction set (status-emojis.ts TELEGRAM_REACTION_EMOJIS), one set on every surface:
 *   each of them is a valid reaction on Discord and on Telegram, so the web message's channel copy can carry it too.
 *   A variation selector in the input is accepted (👍️ = 👍); the stored form is the set's own spelling.
 * - Never AgEnD's own delivery marks: the instance's resolved status emojis (statusAvoidList), which the instance is
 *   told to avoid on the platforms already.
 */
import type { ChannelAdapter } from "./channel/types.js";
import { TELEGRAM_REACTION_EMOJIS, normalizeEmoji } from "./status-emojis.js";

/** A web message's copy in a channel (the echo): where a reaction to the web message is put too. */
export interface WebEchoCopy { adapter: Pick<ChannelAdapter, "react" | "type">; chatId: string; threadId?: string; messageId: string }
/** How many web messages' copies the fleet remembers (the newest; this process only). */
export const WEB_ECHO_COPIES_MAX = 2000;

/** The most distinct reactions one web message keeps. */
export const WEB_REACTIONS_MAX = 8;
/** A few allowed emojis, named in the error for one that is not. */
export const WEB_REACTION_SUGGESTIONS: readonly string[] = ["👍", "👌", "❤", "🙏", "🎉", "🔥", "💯", "🫡", "🤝", "👏"];

const stripVariation = (s: string): string => s.replace(/\uFE0F/g, "");

/** The stored spelling of an emoji the web takes (the set's own), or null when it is not one. */
export function webReactionEmoji(raw: unknown): string | null {
  const e = normalizeEmoji(raw);
  if (!e || e.kind !== "unicode") return null;
  const bare = stripVariation(e.value);
  return TELEGRAM_REACTION_EMOJIS.has(bare) ? bare : null;
}

/**
 * Why `raw` cannot be a web reaction, or null when it can. `avoid`: the status emojis in display form (statusAvoidList),
 * compared without variation selectors.
 */
export function webReactionProblem(raw: unknown, avoid: readonly string[]): string | null {
  const shown = typeof raw === "string" ? raw.trim().slice(0, 32) : String(raw).slice(0, 32);
  const emoji = webReactionEmoji(raw);
  const offer = WEB_REACTION_SUGGESTIONS.filter(e => !avoid.some(a => stripVariation(a) === e)).join(" ");
  if (!emoji) return `react: "${shown}" cannot be a web reaction — use one emoji from the reaction set, e.g. ${offer}`;
  if (avoid.some(a => stripVariation(a) === emoji)) return `react: ${emoji} is one of AgEnD's delivery marks here — use another, e.g. ${offer}`;
  return null;
}

/** Whether a value read back from disk (or a stream) is a list of web reactions: distinct, in the set, at most the max. */
export function webReactionsOf(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const r of raw) {
    const e = typeof r === "string" ? webReactionEmoji(r) : null;
    if (e && !out.includes(e)) out.push(e);
    if (out.length >= WEB_REACTIONS_MAX) break;
  }
  return out.length ? out : undefined;
}
