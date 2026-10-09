/**
 * #1468: list prices for the prompt-cache analysis — the one table, with the day it was checked against the vendors'
 * own pricing pages. USD per million tokens, standard tier, global routing (no batch, fast, data-residency or
 * regional uplift: AgEnD's CLIs run on subscriptions, so these are list-price equivalents, not a bill).
 *
 * Claude (platform.claude.com/docs/en/about-claude/pricing): a 5-minute cache write is 1.25x base input, a 1-hour
 * write 2x; a cache hit is 0.1x, except 0.05x on Opus/Sonnet 5.5 and 0.025x on Fable/Mythos 5.1. Haiku 5.5 is priced
 * by prompt length (over 100,000 tokens: the higher row), counting cache reads and writes.
 * OpenAI (developers.openai.com/api/docs/pricing, …/guides/prompt-caching): on GPT-5.6 and later a cache write is
 * 1.25x uncached input and the cache lives 30 minutes after its last write or reuse; prompts over 272K input tokens
 * pay the long-context row.
 */

export const PRICES_CHECKED = "2026-10-09";
export const PRICE_SOURCES = [
  "https://platform.claude.com/docs/en/about-claude/pricing",
  "https://developers.openai.com/api/docs/pricing",
  "https://developers.openai.com/api/docs/guides/prompt-caching",
] as const;

/** USD per million tokens. `write` is the one cache-write rate an OpenAI model has; Claude has `write5m`/`write1h`. */
export interface Rates {
  input: number;
  read: number;
  write5m: number;
  write1h: number;
  write: number;
  output: number;
}

interface Row {
  /** [short, long] — long applies when the prompt exceeds `longOver` tokens. */
  rates: [Rates, Rates?];
  longOver?: number;
}

const claude = (input: number, read: number, output: number): Rates =>
  ({ input, read, write5m: input * 1.25, write1h: input * 2, write: input * 1.25, output });
const openai = (input: number, read: number, write: number, output: number): Rates =>
  ({ input, read, write5m: write, write1h: write, write, output });

const TABLE: Record<string, Row> = {
  "claude-fable-5-1": { rates: [claude(10, 0.25, 50)] },
  "claude-mythos-5-1": { rates: [claude(10, 0.25, 50)] },
  "claude-fable-5": { rates: [claude(10, 1, 50)] },
  "claude-mythos-5": { rates: [claude(10, 1, 50)] },
  "claude-opus-5-5": { rates: [claude(4, 0.20, 20)] },
  "claude-opus-5": { rates: [claude(5, 0.50, 25)] },
  "claude-opus-4-8": { rates: [claude(5, 0.50, 25)] },
  "claude-opus-4-7": { rates: [claude(5, 0.50, 25)] },
  "claude-opus-4-6": { rates: [claude(5, 0.50, 25)] },
  "claude-opus-4-5": { rates: [claude(5, 0.50, 25)] },
  "claude-opus-4-1": { rates: [claude(15, 1.50, 75)] },
  "claude-opus-4": { rates: [claude(15, 1.50, 75)] },
  "claude-sonnet-5-5": { rates: [claude(2, 0.10, 10)] },
  "claude-sonnet-5": { rates: [claude(2, 0.20, 10)] },
  "claude-sonnet-4-6": { rates: [claude(3, 0.30, 15)] },
  "claude-sonnet-4-5": { rates: [claude(3, 0.30, 15)] },
  "claude-sonnet-4": { rates: [claude(3, 0.30, 15)] },
  "claude-haiku-5-5": { rates: [claude(0.10, 0.01, 0.50), claude(0.50, 0.05, 2.50)], longOver: 100_000 },
  "claude-haiku-4-5": { rates: [claude(1, 0.10, 5)] },
  "gpt-6.1-sol": { rates: [openai(2, 0.10, 2.50, 10), openai(4, 0.20, 5, 15)], longOver: 272_000 },
  "gpt-6-sol": { rates: [openai(2, 0.20, 2.50, 10), openai(4, 0.40, 5, 15)], longOver: 272_000 },
  "gpt-6-astra": { rates: [openai(10, 1, 12.50, 50), openai(20, 2, 25, 75)], longOver: 272_000 },
  "gpt-6-luna": { rates: [openai(0.10, 0.01, 0.125, 0.50), openai(0.20, 0.02, 0.25, 0.75)], longOver: 272_000 },
  "gpt-5.6-sol": { rates: [openai(4, 0.40, 5, 20), openai(8, 0.80, 10, 30)], longOver: 272_000 },
  "gpt-5.6-terra": { rates: [openai(2, 0.20, 2.50, 12), openai(4, 0.40, 5, 18)], longOver: 272_000 },
  "gpt-5.6-luna": { rates: [openai(0.20, 0.02, 0.25, 1.20), openai(0.40, 0.04, 0.50, 1.80)], longOver: 272_000 },
};

/**
 * The table's key for a model id as a transcript records it: "claude-opus-4-5-20251101" → "claude-opus-4-5",
 * "claude-opus-5-5[1m]" → "claude-opus-5-5". Exact keys only — "claude-opus-5" never prices "claude-opus-5-5".
 */
export function priceKey(model: string | null | undefined): string | null {
  if (typeof model !== "string") return null;
  const id = model.trim().toLowerCase().replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
  return Object.prototype.hasOwnProperty.call(TABLE, id) ? id : null;
}

/** The rates for one request of `model` with a prompt of `promptTokens`; null when the model is not in the table. */
export function ratesFor(model: string | null | undefined, promptTokens = 0): Rates | null {
  const key = priceKey(model);
  if (!key) return null;
  const row = TABLE[key]!;
  return row.longOver !== undefined && promptTokens > row.longOver && row.rates[1] ? row.rates[1] : row.rates[0];
}

/** Whether a prompt of this size pays the model's long-context (or over-100K) row. */
export function isLongPrompt(model: string | null | undefined, promptTokens: number): boolean {
  const key = priceKey(model);
  const row = key ? TABLE[key] : undefined;
  return !!row && row.longOver !== undefined && promptTokens > row.longOver;
}
