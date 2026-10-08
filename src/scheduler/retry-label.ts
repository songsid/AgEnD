import type { ScheduleRetry } from "./types.js";

/** A wall-clock instant as the schedule's own `HH:MM`, in its timezone (the one its cron is read in). */
export function scheduleClock(ms: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(11, 16) + " UTC";
  }
}

/**
 * The first line of a deferred occurrence's retry, as the target agent receives it (#1426): that it is a retry, when
 * it was originally due, and why it was late — e.g. `[retry] originally due 21:00 (Asia/Taipei), deferred by the 5h
 * rate limit at 100%`.
 */
export function scheduleRetryLabel(retry: ScheduleRetry, timezone: string): string {
  const dueMs = Date.parse(retry.run_id);
  const due = scheduleClock(Number.isFinite(dueMs) ? dueMs : retry.deferred_at_ms, timezone);
  return `[retry] originally due ${due} (${timezone}), deferred by the 5h rate limit at ${retry.deferred_pct}%`;
}

/** Text for a Telegram `format: "html"` message. */
export function escapeTelegramHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
