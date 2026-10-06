import { t } from "../locale.js";
import type { UsageI18nRef } from "./providers.js";

/** Resolve AgEnD-owned usage copy while preserving raw vendor text as fallback. */
export function usageText(fallback: string, ref?: UsageI18nRef): string {
  return ref ? t(ref.key, ...(ref.args ?? [])) : fallback;
}

/** Minute-precision duration shared by the chat and MCP usage renderers. */
export function usageResetText(resetsAt?: string | null): string {
  if (!resetsAt) return "";
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return "";
  const remainingMs = at.getTime() - Date.now();
  if (remainingMs <= 0) return t("usage.reset.soon");
  return t("usage.reset.in", usageDuration(remainingMs));
}

/**
 * "🎫 Nearest expiry: 10/22 (in 15d 4h)" — when the soonest of a metric's tickets expires (#1244); "" when none is
 * still ahead. An expiry, never a reset: the ticket is gone, nothing refills.
 */
export function usageExpiryText(expiresAt?: string | null): string {
  if (!expiresAt) return "";
  const at = new Date(expiresAt);
  const remainingMs = at.getTime() - Date.now();
  if (!(remainingMs > 0)) return "";
  return t("usage.ticket_expiry", `${at.getMonth() + 1}/${at.getDate()}`, usageDuration(remainingMs));
}

/** "2d 3h" from two days, "5h 12m" from an hour, "7m" below that — minute precision, rounded up. */
function usageDuration(remainingMs: number): string {
  const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  const duration = totalMinutes >= 2_880
    ? t("usage.duration.days_hours", days, hours)
    : totalMinutes >= 60
      ? t("usage.duration.hours_minutes", Math.floor(totalMinutes / 60), minutes)
      : t("usage.duration.minutes", totalMinutes);
  return duration;
}
