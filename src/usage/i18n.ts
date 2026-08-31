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

  const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  const duration = totalMinutes >= 2_880
    ? t("usage.duration.days_hours", days, hours)
    : totalMinutes >= 60
      ? t("usage.duration.hours_minutes", Math.floor(totalMinutes / 60), minutes)
      : t("usage.duration.minutes", totalMinutes);
  return t("usage.reset.in", duration);
}
