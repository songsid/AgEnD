import { t } from "../locale.js";
import type { ProviderUsage, UsageI18nRef } from "./providers.js";

/** Resolve AgEnD-owned usage copy while preserving raw vendor text as fallback. */
export function usageText(fallback: string, ref?: UsageI18nRef): string {
  return ref ? t(ref.key, ...(ref.args ?? [])) : fallback;
}

/** "14:05" today, "10/19 14:05" another day: when last known numbers were read, or a window reset (host time). */
export function usageClock(iso: string | null | undefined, now = Date.now()): string {
  const at = new Date(iso ?? "");
  if (Number.isNaN(at.getTime())) return "";
  const hm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return new Date(now).toDateString() === at.toDateString() ? hm : `${at.getMonth() + 1}/${at.getDate()} ${hm}`;
}

/**
 * A row showing its last known numbers: "expired · cached at 14:05" and, for an expiry or another failed read, what
 * to do ("Access token expired — …"). A transient failure says only the first part. null: not such a row (or one
 * from before #2236's follow-up, whose own hint says it).
 */
export function usageStaleText(p: Pick<ProviderUsage, "stale" | "cachedAt" | "staleCause" | "hint" | "hintI18n">): string | null {
  if (!p.stale || !p.cachedAt || !p.staleCause) return null;
  const mark = t(`usage.stale.${p.staleCause}`, usageClock(p.cachedAt));
  const detail = p.staleCause !== "transient" && (p.hint || p.hintI18n) ? usageText(p.hint ?? "", p.hintI18n) : "";
  return detail ? `${mark} — ${detail}` : mark;
}

/** A metric whose window has reset since its last known numbers were read: "reset since 14:05". */
export function usageResetSinceText(resetsAt?: string | null): string {
  return t("usage.metric.reset_since", usageClock(resetsAt));
}

/** A row's name in the chat and MCP text: the default login's "Claude (default)" says "default" in the fleet's language. */
export function usageRowName(p: Pick<ProviderUsage, "name" | "defaultLogin">): string {
  const suffix = " (default)";
  return p.defaultLogin && p.name.endsWith(suffix) ? `${p.name.slice(0, -suffix.length)} (${t("usage.default_login")})` : p.name;
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
