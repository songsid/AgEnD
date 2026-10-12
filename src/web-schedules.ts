/**
 * #1724: a schedule as the web lists it — the row's own fields, plus what a person reads that the page should not work
 * out itself: the next run (a cron's next occurrence in its own timezone, or a one-shot's time) and the one-shot's time,
 * each in the fleet's zone (formatFleetTime, #1586); whether a one-shot past its time is waiting on a retry (#1426).
 * A disabled schedule has no next run. Nothing here parses cron on the page.
 */
import { Cron } from "croner";
import type { Schedule, ScheduleRetry } from "./scheduler/types.js";
import { formatFleetTime } from "./tz-utils.js";

export interface ScheduleView extends Schedule {
  /** The next run (epoch ms), or null: disabled, a cron with no further occurrence, or a one-shot already past. */
  next_run_ms: number | null;
  /** next_run_ms in the fleet's zone, e.g. "2026-10-13 14:00 (UTC+8)"; null when there is none. */
  next_run_text: string | null;
  /** A one-shot's time in the fleet's zone; null for a cron. */
  at_text: string | null;
  /** A one-shot past its time with a retry pending (#1426): it has not run yet, it will retry. */
  retrying: boolean;
}

export function scheduleView(s: Schedule, retry: ScheduleRetry | null, nowMs: number = Date.now(), tz?: string): ScheduleView {
  const atMs = s.at ? Date.parse(s.at) : NaN;
  const retrying = !!s.at && Number.isFinite(atMs) && atMs < nowMs && !!retry;
  let next: number | null = null;
  if (s.enabled) {
    if (s.cron) {
      try { next = new Cron(s.cron, { timezone: s.timezone }).nextRun(new Date(nowMs))?.getTime() ?? null; } catch { next = null; }
    } else if (Number.isFinite(atMs)) {
      next = atMs >= nowMs ? atMs : retrying ? retry!.due_at_ms : null;
    }
  }
  return {
    ...s,
    next_run_ms: next,
    next_run_text: next !== null ? formatFleetTime(next, tz) : null,
    at_text: Number.isFinite(atMs) ? formatFleetTime(atMs, tz) : null,
    retrying,
  };
}
