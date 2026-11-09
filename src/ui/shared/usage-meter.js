// The usage meter, in a module of its own: one window as a few characters ("5h"), a bar, the percent and its reset ("↻ 8m"). The Usage panel's
// compact rows (usage-dialog.js) and Settings → Accounts (accounts-view.js) draw it, so both show the same thing.
// A module of its own (#3321): a tab opened before an upgrade keeps the usage-dialog.js it had (header-tools.js loads it with the shell), and a
// named import of something that file never exported breaks the link of whatever imports it — here the whole Settings page. This file has a new
// address, so a tab that has never loaded it fetches it, and usage-dialog.js (old or new) never needs it to be there. Everything it uses from the
// shared modules is what those modules have always exported.
import { html, useLayoutEffect, useRef } from "./app-html.js";
import { t } from "./app-i18n.js";
import "./view-strings.js";

export function tn(key, values = {}) {
  let s = t(`view.${key}`);
  for (const [k, v] of Object.entries(values)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
export function usageText(fallback, ref) {
  if (!ref || typeof ref.key !== "string") return fallback == null ? "" : String(fallback);
  return (Array.isArray(ref.args) ? ref.args : []).reduce((text, value, i) => text.split(`{${i}}`).join(String(value)), t(`view.${ref.key}`));
}
export function usageDuration(ms) {
  const total = Math.max(1, Math.ceil(ms / 60000));
  const d = Math.floor(total / 1440), h = Math.floor((total % 1440) / 60), m = total % 60;
  if (total >= 2880) return usageText("", { key: "usage.duration.days_hours", args: [d, h] });
  if (total >= 60) return usageText("", { key: "usage.duration.hours_minutes", args: [Math.floor(total / 60), m] });
  return usageText("", { key: "usage.duration.minutes", args: [total] });
}
export function resetText(iso) {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return tn("usage.reset.soon");
  return usageText("", { key: "usage.reset.in", args: [usageDuration(ms)] });
}
/** "14:05" today, "10/19 14:05" another day, in this browser's time: when last known numbers were read, a window reset. */
export function usageClock(iso, now = Date.now()) {
  const at = new Date(iso || "");
  if (Number.isNaN(at.getTime())) return "";
  const hm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return new Date(now).toDateString() === at.toDateString() ? hm : `${at.getMonth() + 1}/${at.getDate()} ${hm}`;
}
/** A window as a few characters ("5h", "7d"); one whose length is not known says its label. */
export function windowTag(m) {
  const ms = Number(m && m.windowMs);
  if (!(ms > 0)) return usageText(m.label, m.labelI18n);
  const h = ms / 3_600_000;
  return h < 48 ? tn("usageWindowHours", { n: Math.round(h) }) : tn("usageWindowDays", { n: Math.round(h / 24) });
}
/** A time ahead in one unit, for the narrow column: "45m", "3h", "4d" (rounded down past an hour; the tooltip is exact). */
function coarseDuration(ms) {
  const min = Math.max(1, Math.ceil(ms / 60_000));
  if (min < 60) return tn("usageWindowMinutes", { n: min });
  const h = Math.floor(min / 60);
  return h < 48 ? tn("usageWindowHours", { n: h }) : tn("usageWindowDays", { n: Math.floor(h / 24) });
}
/** The soonest reset still ahead among `metrics`: { short: "↻ 2h", full: "resets in 2h 5m" }, or null when none is known. */
export function soonestReset(metrics, now = Date.now()) {
  const at = metrics.map((m) => new Date(m.resetsAt || "").getTime()).filter((t) => Number.isFinite(t) && t > now).sort((a, b) => a - b)[0];
  return at === undefined ? null : { short: `↻ ${coarseDuration(at - now)}`, full: resetText(new Date(at).toISOString()) };
}
export const level = (pct) => (pct >= 90 ? "crit" : pct >= 70 ? "warn" : "");
/** When a window resets, at the clock ("14:05", "10/19 14:05"), for a tooltip; "" when unknown or already past. */
export function resetClock(m, now = Date.now()) {
  const at = new Date((m && m.resetsAt) || "").getTime();
  return Number.isFinite(at) && at > now ? `↻ ${usageClock(m.resetsAt, now)}` : "";
}
/**
 * One window on its own line: its few characters ("5h"), a full-width bar, the percent coloured as the full card, and
 * when this window resets ("↻ 8m"; the user's ask, 2026-10-23: a week's reset was hidden behind the 5 h one's). A pool's
 * line (#2240): the pool's name in place of the window, the reset of the window its percent is, every window (with its
 * reset time) in the tooltip.
 * Exported (#3321) so Settings → Accounts draws its 5h / week windows with this same meter and thresholds (70% / 90%): `m` needs
 * `used` (0–100), `resetsAt` and either `windowMs` or `label`; `tag` overrides the window's few characters.
 */
export function CompactMeter({ m, tag, title }) {
  const bar = useRef(null);
  const pct = Math.min(100, Math.max(0, m.used ?? 0)), cls = level(pct);
  useLayoutEffect(() => { if (bar.current) bar.current.style.width = `${pct}%`; }, [pct]);   // CSSOM (#1300)
  const word = cls === "crit" ? tn("usageNear") : cls === "warn" ? tn("usageHigh") : "";
  const reset = soonestReset([m]), clock = resetClock(m);
  return html`<span class="u-cm" title=${title || `${usageText(m.label, m.labelI18n)}: ${pct.toFixed(0)}%${word ? ` (${word})` : ""}${clock ? ` · ${clock}` : ""}`}>
    <span class="u-cm-tag">${tag || windowTag(m)}</span><span class="u-cm-bar"><span ref=${bar} class=${`u-cm-fill ${cls}`}></span></span>
    <span class=${`u-cm-pct ${cls}`}>${pct.toFixed(0)}%</span>
    <span class="u-cm-reset">${reset ? html`${reset.short}<span class="sr-only"> (${reset.full})</span>` : null}</span></span>`;
}
