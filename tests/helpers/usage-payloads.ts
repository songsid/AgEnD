/**
 * Usage payloads in the shape each CLI's own reader gives them (src/usage/providers.ts), for the tests that hold the Accounts row to the usage panel's full card
 * (cli-registry-usage-shape.test.ts, accounts-usage-card-parity-113.test.ts).
 *  - Antigravity: built by the real `agyPoolMetrics` from agy's REAL response shapes (tests/fixtures/agy-quota-2026-10-20/, a user's login, redacted to quota metadata), plus an Argon
 *    pool known only from per-model data (SYNTHETIC models in the real shape, as tests/agy-argon-quota-2240.test.ts has them): two pools with a 5h and a weekly window each, and one with no window.
 *  - Claude, Codex, Kiro, Grok, Muse: the metrics their readers build (labels, keys, `windowMs`, `quotaPeriod`, a model quota and non-percent lines alongside), written out.
 * Fixtures only.
 */
import { readFileSync } from "node:fs";
import { agyPoolMetrics, agyUsageBuckets } from "../../src/usage/providers.js";

const real = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/agy-quota-2026-10-20/${name}`, import.meta.url), "utf8"));
const H = 3_600_000, DAY = 24 * H, WEEK = 7 * DAY;
const i18n = (key: string, ...args: Array<string | number>) => ({ key, ...(args.length ? { args } : {}) });
const reset = (ms: number) => new Date(Date.now() + ms).toISOString();

const ARGON_MODELS = {
  "gemini-4-argon-low": { displayName: "Gemini 4 Argon (Low)", modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 0.7, resetTime: "2026-10-24T10:00:00Z" } },
  "gemini-4-argon-high": { displayName: "Gemini 4 Argon (High)", modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 0.25, resetTime: "2026-10-24T10:00:00Z" } },
};
/** The fixtures' own reset times are from 2026-10, long past: they are moved ahead, so the windows are current ones (a reset window has its own tests). */
export const ANTIGRAVITY = (): unknown[] => agyPoolMetrics(agyUsageBuckets(real("summary-prod.json"), { models: { ...real("models-daily.json").models, ...ARGON_MODELS } }))
  .map(m => ({ ...m, resetsAt: reset(m.windowMs ? m.windowMs / 2 : 3 * DAY) }));
export const CLAUDE = (): unknown[] => [
  { label: "Session", labelI18n: i18n("usage.metric.session"), type: "percent", used: 76.4, resetsAt: reset(3 * H), windowMs: 5 * H },
  { label: "Weekly", labelI18n: i18n("usage.metric.weekly"), type: "percent", used: 28.2, resetsAt: reset(2 * DAY), windowMs: WEEK },
  { label: "Sonnet (weekly)", labelI18n: i18n("usage.metric.named_weekly", "Sonnet"), scope: "model", type: "percent", used: 12, resetsAt: reset(2 * DAY), windowMs: WEEK },
  { label: "Extra usage", labelI18n: i18n("usage.metric.extra_usage"), type: "dollars", used: 3.5, limit: 20 },
];
export const CODEX = (): unknown[] => [
  { label: "Session", labelI18n: i18n("usage.metric.session"), type: "percent", used: 14, resetsAt: reset(4 * H), windowMs: 5 * H },
  { label: "Weekly", labelI18n: i18n("usage.metric.weekly"), type: "percent", used: 61, resetsAt: reset(3 * DAY), windowMs: WEEK },
  { label: "Monthly", labelI18n: i18n("usage.metric.monthly"), type: "percent", used: 9, resetsAt: reset(20 * DAY), windowMs: 30 * DAY },
  { label: "Credits", labelI18n: i18n("usage.metric.credits"), type: "count", value: 12, unit: "credits" },
];
export const KIRO = (): unknown[] => [
  { label: "Credits (monthly)", quotaPeriod: "monthly", labelI18n: i18n("usage.metric.named_monthly", "Credits"), type: "percent", used: 41.2, resetsAt: reset(12 * DAY), note: "41.2 / 100 credits" },
];
export const GROK = (): unknown[] => [
  { label: "Weekly limit", labelI18n: i18n("usage.metric.weekly_limit"), type: "percent", used: 33, resetsAt: reset(4 * DAY), windowMs: WEEK },
  { label: "Pay as you go", labelI18n: i18n("usage.metric.pay_as_you_go"), type: "text", value: "Disabled" },
];
export const MUSE = (): unknown[] => [
  { label: "Session", labelI18n: i18n("usage.metric.session"), type: "percent", used: 20, resetsAt: reset(2 * H), windowMs: 5 * H },
  { label: "Weekly", labelI18n: i18n("usage.metric.weekly"), type: "percent", used: 45, resetsAt: reset(5 * DAY), windowMs: WEEK },
];
/** Each CLI's backend id and the payload its reader gives. */
export const PAYLOADS: Record<string, () => unknown[]> = { antigravity: ANTIGRAVITY, "claude-code": CLAUDE, codex: CODEX, "kiro-cli": KIRO, grok: GROK, muse: MUSE };
