import { t } from "./locale.js";

/**
 * A backend's quota, usage-limit or credit notice as the person reads it (user, 2026-10-30): one short line, the
 * backend and what ran out — "⚠️ Codex 用量用完，已暫停" / "⚠️ Codex usage limit used up — paused". "Paused" only when
 * the instance really is; a reset time only where AgEnD already reads one from the CLI. The instance's name is added
 * by the lifecycle (plainNoticeLine) only where the line is posted outside its own topic. The incident's `message`
 * stays the unlocalised English one, for logs and webhooks.
 */
export type QuotaWhat = "usage" | "api_credits" | "api_quota" | "workspace_credits" | "workspace_usage" | "quota"
  | "quota_credits" | "requests" | "weekly";
export type QuotaReset = { at: string } | { in: string };

export function quotaLine(backend: string, what: QuotaWhat, opts: { paused?: boolean; reset?: QuotaReset } = {}): string {
  const line = t(opts.paused ? "inst.quota_line_paused" : "inst.quota_line", backend, t(`inst.quota_what.${what}`));
  if (!opts.reset) return line;
  return "at" in opts.reset ? t("inst.quota_reset_at", line, opts.reset.at) : t("inst.quota_reset_in", line, opts.reset.in);
}

/** The same line for a backend that pauses the instance. */
export function quotaPausedLine(backend: string, what: QuotaWhat, reset?: QuotaReset): string {
  return quotaLine(backend, what, { paused: true, reset });
}

/** Claude's own words for when it continues ("at 1:50pm", "in 3h") as a reset time; anything else as said. */
export function claudeResetTime(when: string): QuotaReset {
  const m = /^(at|in)\s+(.+)$/i.exec(when.trim());
  return m ? (m[1]!.toLowerCase() === "in" ? { in: m[2]! } : { at: m[2]! }) : { at: when.trim() };
}

/**
 * When Claude's words for its reset ("at 7:10pm", "at 2pm", "in 3h", "in 2h 30m") come true, judged from `from` — the
 * moment Claude wrote them (its record's timestamp): "at" is the first such local clock time after it, "in" is added to
 * it. null when the words are anything else (a date, a form not known): such a reset is never judged stale.
 */
export function claudeResetInstant(when: string, from: number): number | null {
  const text = when.trim().replace(/\s*\([^)]*\)\s*$/, "");                     // a trailing "(Asia/Taipei)" note
  const at = /^at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(text);
  if (at) {
    let hour = Number(at[1]); const minute = at[2] ? Number(at[2]) : 0; const half = at[3]?.toLowerCase();
    if (minute > 59 || (half ? hour < 1 || hour > 12 : hour > 23)) return null;
    if (half === "pm" && hour !== 12) hour += 12;
    if (half === "am" && hour === 12) hour = 0;
    const d = new Date(from);
    d.setHours(hour, minute, 0, 0);
    if (d.getTime() < from) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const rel = /^in\s+(.+)$/i.exec(text);
  if (rel) {
    const units: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };
    let total = 0, rest = rel[1]!.trim();
    while (rest) {
      const part = /^(\d+)\s*(d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)\b\s*/i.exec(rest);
      if (!part) return null;
      total += Number(part[1]) * units[part[2]![0]!.toLowerCase()]!;
      rest = rest.slice(part[0].length);
    }
    return total > 0 ? from + total : null;
  }
  return null;
}

/** Codex's "less than N% of your <period> limit" warning. */
export function quotaLowLine(period: string, percent: string): string {
  const key = `inst.quota_period.${period.toLowerCase()}`;
  return t("inst.quota_low", t(key), percent);
}
