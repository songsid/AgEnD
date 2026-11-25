// M-3730 (the user, 2026-11-25): a time in the zh-TW interface is a 24-hour clock, 00:19 and 19:45, never 上午12:19 or
// 下午07:45. Every time and date-with-time the web UI shows goes through here; English keeps what each screen showed.
// No imports: the language is the page's own <html lang> (app-i18n.js sets "zh-Hant" or "en"), so the fleet, the Hub,
// a share page and the tests can all read it as it is.

/** True when the page shows zh-TW. */
export function zhClock() { return /^zh/i.test(globalThis.document?.documentElement?.lang || ""); }

/** The locale to format with: zh-TW on a zh-TW page, else the screen's own (English: what it always used). */
export function clockLocale(enLocale) { return zhClock() ? "zh-TW" : enLocale; }

const hasTime = (o) => Boolean(o && (o.hour || o.timeStyle));
const DATE = { year: "numeric", month: "numeric", day: "numeric" }, HMS = { hour: "2-digit", minute: "2-digit", second: "2-digit" };
/**
 * Intl options for that locale: a zh-TW time is on the 24-hour cycle. A date-only format is left as it is. With no
 * fields (none, {} or only a timeZone) each wrapper keeps its native default: `datetime` (toLocaleString) is a date and
 * a time, `time` (toLocaleTimeString) a time alone, `format` (Intl.DateTimeFormat) a date alone (#4455 review).
 */
export function clockOptions(o, kind = "datetime") {
  if (!zhClock()) return o;
  if (!o || !Object.keys(o).some((k) => k !== "timeZone")) {
    if (kind === "format") return o;
    return { ...(kind === "datetime" ? DATE : {}), ...HMS, hourCycle: "h23", ...(o?.timeZone ? { timeZone: o.timeZone } : {}) };
  }
  if (!hasTime(o)) return o;
  const { hour12: _ignored, dateStyle, timeStyle, ...rest } = o;
  // ICU drops a dateStyle's words when an hourCycle comes with it (2026年12月2日 turns into 2026/12/2), so the styles
  // become the parts they stand for.
  const day = dateStyle === "full" ? { year: "numeric", month: "long", day: "numeric", weekday: "long" }
    : dateStyle === "long" || dateStyle === "medium" ? { year: "numeric", month: "long", day: "numeric" }
    : dateStyle === "short" ? { year: "numeric", month: "numeric", day: "numeric" } : {};
  const time = !timeStyle ? {} : { hour: "2-digit", minute: "2-digit", ...(timeStyle === "short" ? {} : { second: "2-digit" }),
    ...(timeStyle === "long" || timeStyle === "full" ? { timeZoneName: "short" } : {}) };
  return { ...day, ...time, ...rest, hourCycle: "h23" };
}

/** An Intl.DateTimeFormat that follows the rule above. */
export function clockFormat(o, enLocale) { return new Intl.DateTimeFormat(clockLocale(enLocale), clockOptions(o, "format")); }

const date = (v) => (v instanceof Date ? v : new Date(v));
/** A time of day ("19:45" in zh-TW; the screen's English format otherwise). No `o`: toLocaleTimeString's own default
 *  (hours, minutes and seconds). */
export function timeText(v, o, enLocale) {
  const d = date(v);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleTimeString(clockLocale(enLocale), clockOptions(o, "time"));
}

/** A date with its time (toLocaleString), with the screen's options. */
export function dateTimeText(v, o, enLocale) {
  const d = date(v);
  return Number.isFinite(d.getTime()) ? d.toLocaleString(clockLocale(enLocale), clockOptions(o)) : "";
}

const ZH_UNIT = { ms: "毫秒", s: "秒", m: "分鐘", min: "分鐘", h: "小時" };
/** A number with its time unit: "2 h" / "5 min" / "3 s" in English, "2 小時" / "5 分鐘" / "3 秒" on a zh-TW page. */
export function unitText(n, unit) { return `${n} ${zhClock() ? ZH_UNIT[unit] ?? unit : unit}`; }
