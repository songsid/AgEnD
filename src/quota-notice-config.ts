/** Optional reminders only. Exhaustion, pause and recovery messages are operational state. */
export const QUOTA_PERIODS = ["session", "hourly", "daily", "weekly", "monthly"] as const;
export type QuotaPeriod = typeof QUOTA_PERIODS[number];
export const QUOTA_BACKENDS = ["claude-code", "codex", "kiro-cli", "grok", "antigravity", "muse"] as const;
export interface QuotaNoticeRule { enabled?: boolean; thresholds?: number[]; periods?: QuotaPeriod[] }
export interface QuotaNoticeSettings extends QuotaNoticeRule {
  target?: string;
  backends?: Partial<Record<typeof QUOTA_BACKENDS[number], QuotaNoticeRule>>;
}
export const DEFAULT_QUOTA_NOTICE = { enabled: true, thresholds: [10], periods: ["weekly"] as QuotaPeriod[], target: "general" };

export function quotaNoticeProblem(value: unknown, fleet = false): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "must be a mapping";
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["enabled", "thresholds", "periods", ...(fleet ? ["target", "backends"] : [])].includes(k))) return "contains an unknown quota notice field";
  if (v.enabled !== undefined && typeof v.enabled !== "boolean") return "enabled must be a boolean";
  if (v.thresholds !== undefined && (!Array.isArray(v.thresholds) || v.thresholds.length > 8 || new Set(v.thresholds).size !== v.thresholds.length || v.thresholds.some(n => typeof n !== "number" || !Number.isFinite(n) || n < 1 || n > 99))) return "thresholds must be up to eight distinct remaining percentages from 1 to 99";
  if (v.periods !== undefined && (!Array.isArray(v.periods) || new Set(v.periods).size !== v.periods.length || v.periods.some(p => !QUOTA_PERIODS.includes(p as QuotaPeriod)))) return "periods must be distinct session, hourly, daily, weekly or monthly values";
  if (v.target !== undefined && (typeof v.target !== "string" || (v.target.length < 1 || v.target.length > 128 || /[\/\\\p{Cc}\p{Cf}]/u.test(v.target) || v.target.includes("..")))) return "target must be general or an instance name";
  if (v.backends !== undefined) {
    if (!v.backends || typeof v.backends !== "object" || Array.isArray(v.backends)) return "backends must be a mapping";
    for (const [backend, rule] of Object.entries(v.backends)) {
      if (!QUOTA_BACKENDS.includes(backend as typeof QUOTA_BACKENDS[number])) return "unknown quota notice backend";
      const problem = quotaNoticeProblem(rule); if (problem) return `${backend}: ${problem}`;
    }
  }
  return null;
}

/** Arrays replace, and each agent contributes its own period/threshold pairs (no cross-product between agents). */
export function quotaNoticeRule(defaults: QuotaNoticeSettings | undefined, backend: string, own?: QuotaNoticeRule): Required<QuotaNoticeRule> {
  if (defaults !== undefined && quotaNoticeProblem(defaults, true) || own !== undefined && quotaNoticeProblem(own)) {
    return { enabled: false, thresholds: [], periods: [] };
  }
  const b = defaults?.backends?.[backend as keyof NonNullable<QuotaNoticeSettings["backends"]>];
  const merged = { ...DEFAULT_QUOTA_NOTICE, ...defaults, ...b, ...own };
  return { enabled: merged.enabled, thresholds: [...merged.thresholds].sort((a, b) => b - a), periods: [...merged.periods] };
}
