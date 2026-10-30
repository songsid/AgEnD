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

/** Codex's "less than N% of your <period> limit" warning. */
export function quotaLowLine(period: string, percent: string): string {
  const key = `inst.quota_period.${period.toLowerCase()}`;
  return t("inst.quota_low", t(key), percent);
}
