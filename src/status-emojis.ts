/**
 * Configurable delivery-status emojis (#1005).
 *
 * One module owns how a configured status emoji is read, checked, resolved
 * and compared, so the reaction a bot stamps, the reaction it later removes,
 * the reactions the fleet filters out as its own, and the list the
 * instructions tell agents to avoid all come from the same value.
 *
 * Resolution, per status key: instance `status_emojis` → the bound channel's
 * `options.status_emojis` → the built-in value for that platform. The
 * built-ins are exactly what AgEnD stamped before this was configurable.
 */

export const STATUS_EMOJI_KEYS = ["received", "queued", "processing", "delivered", "failed"] as const;
export type DeliveryStatus = typeof STATUS_EMOJI_KEYS[number];
export type StatusEmojiKey = DeliveryStatus | "progress_prefix";
export const STATUS_EMOJI_CONFIG_KEYS: readonly StatusEmojiKey[] = [...STATUS_EMOJI_KEYS, "progress_prefix"];

export type StatusEmojiConfig = Partial<Record<StatusEmojiKey, string>>;
export type ResolvedStatusEmojis = Record<StatusEmojiKey, string>;

/**
 * Telegram accepts only this fixed reaction set (Bot API ReactionTypeEmoji).
 * Spelled as the Bot API spells them: without the U+FE0F variation selector.
 */
export const TELEGRAM_REACTION_EMOJIS: ReadonlySet<string> = new Set([
  "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡",
  "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈",
  "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿",
  "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡",
]);

const BUILTIN_DEFAULT: ResolvedStatusEmojis = {
  received: "👀", queued: "⏳", processing: "👀", delivered: "✅", failed: "❌", progress_prefix: "👀",
};
/** Telegram's smaller vocabulary: ⏳/✅/❌ are not valid Telegram reactions. */
const BUILTIN_TELEGRAM: ResolvedStatusEmojis = {
  received: "👀", queued: "👀", processing: "👀", delivered: "👀", failed: "👎", progress_prefix: "👀",
};

export function builtinStatusEmojis(platform: string | undefined): ResolvedStatusEmojis {
  return { ...(platform === "telegram" ? BUILTIN_TELEGRAM : BUILTIN_DEFAULT) };
}

export type NormalizedEmoji =
  | { kind: "unicode"; value: string }
  | { kind: "custom"; name: string; id: string; animated: boolean };

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function graphemeCount(s: string): number {
  let n = 0;
  for (const _ of GRAPHEMES.segment(s)) if (++n > 1) break;
  return n;
}

const CUSTOM_TAG_RE = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{15,25})>$/;
const CUSTOM_BARE_RE = /^(?:(a):)?([A-Za-z0-9_]{2,32}):(\d{15,25})$/;
const PICTOGRAPH_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;

/**
 * Parse one configured value. Discord custom emoji may be written `<:name:id>`,
 * `<a:name:id>` or bare `name:id`; anything else must be exactly one emoji
 * grapheme (no spaces, no words, not two emojis). Returns null otherwise.
 */
export function normalizeEmoji(raw: unknown): NormalizedEmoji | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const custom = CUSTOM_TAG_RE.exec(s) ?? CUSTOM_BARE_RE.exec(s);
  if (custom) return { kind: "custom", animated: custom[1] === "a", name: custom[2]!, id: custom[3]! };
  // Exactly one grapheme: 👀✅ is two emojis that no platform can stamp as
  // one reaction — accepting it lost that status silently. Segmenting by
  // grapheme (not code points) keeps ZWJ sequences (👨‍👩‍👧), flags (🇹🇼) and
  // skin tones (👍🏽) as the single emoji they are.
  if (/[\sA-Za-z0-9<>:]/.test(s) || !PICTOGRAPH_RE.test(s) || graphemeCount(s) !== 1) return null;
  return { kind: "unicode", value: s };
}

const stripVariation = (s: string): string => s.replace(/\uFE0F/g, "");

/**
 * Why a value cannot be used on `platform`, or null when it can. Telegram has
 * no custom emoji and only the fixed reaction set; Discord takes any emoji.
 * `progress_prefix` is message text, not a reaction, so any emoji works there.
 */
export function statusEmojiProblem(platform: string | undefined, key: StatusEmojiKey, raw: unknown): string | null {
  const e = normalizeEmoji(raw);
  if (!e) return `"${String(raw)}" is not an emoji (use a single emoji, or <:name:id> for a Discord server emoji)`;
  if (platform !== "telegram") return null;
  if (e.kind === "custom") return "Telegram has no server custom emoji";
  if (key === "progress_prefix") return null;
  if (!TELEGRAM_REACTION_EMOJIS.has(stripVariation(e.value))) return `"${e.value}" is not in Telegram's allowed reaction set`;
  return null;
}

/**
 * The string handed to adapter.react()/unreact(). The same form must go to
 * both, or the old status reaction is never removed when the status advances.
 * Discord's REST route and discord.js both take `name:id` for a custom emoji;
 * Telegram wants its own spelling of the emoji (no variation selector).
 */
export function reactionForm(platform: string | undefined, raw: string): string {
  const e = normalizeEmoji(raw);
  if (!e) return raw;
  if (e.kind === "custom") return `${e.name}:${e.id}`;
  return platform === "telegram" ? stripVariation(e.value) : e.value;
}

/** How a status emoji reads in text: custom emoji as `:name:`, not `<:name:id>`. */
export function displayForm(raw: string): string {
  const e = normalizeEmoji(raw);
  if (!e) return raw;
  return e.kind === "custom" ? `:${e.name}:` : e.value;
}

/** Message-text form (progress bubble): Discord renders `<:name:id>` inline. */
export function textForm(platform: string | undefined, raw: string): string {
  const e = normalizeEmoji(raw);
  if (!e) return raw;
  if (e.kind === "custom") return platform === "discord" ? `<${e.animated ? "a" : ""}:${e.name}:${e.id}>` : `:${e.name}:`;
  return e.value;
}

/**
 * Comparison key for "is this reaction one of the status emojis": a custom
 * emoji by id (its name can be renamed and is not unique), a unicode emoji
 * without variation selectors (👁️ and 👁 are the same reaction).
 */
export function statusMatchKey(raw: string): string {
  const e = normalizeEmoji(raw);
  if (e?.kind === "custom") return `id:${e.id}`;
  return stripVariation((e?.value ?? raw).trim());
}

/** The same key computed from an inbound reaction. */
export function reactionMatchKey(emoji: string, emojiId?: string | null): string {
  return emojiId ? `id:${emojiId}` : stripVariation(emoji.trim());
}

export interface ResolveStatusEmojisInput {
  platform: string | undefined;
  /** `channels[].options.status_emojis` of the channel the instance is bound to. */
  platformConfig?: unknown;
  /** `instances.<name>.status_emojis`. */
  instanceConfig?: unknown;
  /** Called once per unusable value; the built-in is used instead. */
  onInvalid?: (source: "instance" | "platform", key: StatusEmojiKey, value: unknown, problem: string) => void;
}

/**
 * Resolve every status key. An unusable value never fails a reaction: it is
 * reported through onInvalid and that key falls through to the next layer.
 */
export function resolveStatusEmojis(input: ResolveStatusEmojisInput): ResolvedStatusEmojis {
  const out = builtinStatusEmojis(input.platform);
  const layers: Array<["platform" | "instance", unknown]> = [["platform", input.platformConfig], ["instance", input.instanceConfig]];
  for (const [source, cfg] of layers) {
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) continue;
    for (const key of STATUS_EMOJI_CONFIG_KEYS) {
      const value = (cfg as Record<string, unknown>)[key];
      if (value === undefined || value === null || value === "") continue;
      const problem = statusEmojiProblem(input.platform, key, value);
      if (problem) { input.onInvalid?.(source, key, value, problem); continue; }
      out[key] = (value as string).trim();
    }
  }
  return out;
}

/** The status reactions (not progress_prefix), deduplicated, in display form. */
export function statusAvoidList(resolved: ResolvedStatusEmojis): string[] {
  return [...new Set(STATUS_EMOJI_KEYS.map(k => displayForm(resolved[k])))];
}

/** Match keys for every status reaction in `resolved`. */
export function statusMatchKeys(resolved: ResolvedStatusEmojis): string[] {
  return STATUS_EMOJI_KEYS.map(k => statusMatchKey(resolved[k]));
}
