// M-3730 (the user, 2026-11-25): a time in the zh-TW interface is a 24-hour clock, 00:19 and 19:45, never 上午12:19 or
// 下午07:45. Every time and date-with-time the web UI shows goes through here; English keeps what each screen showed.
// No imports: the language is the page's own <html lang> (app-i18n.js sets "zh-Hant" or "en"), so the fleet, the Hub,
// a share page and the tests can all read it as it is.

/** True when the page shows zh-TW. */
export function zhClock() { return /^zh/i.test(globalThis.document?.documentElement?.lang || ""); }

/** The locale to format with: zh-TW on a zh-TW page, else the screen's own (English: what it always used). */
export function clockLocale(enLocale) { return zhClock() ? "zh-TW" : enLocale; }

const hasTime = (o) => Boolean(o && (o.hour || o.timeStyle));
/** Intl options for that locale: a zh-TW time is on the 24-hour cycle. A date-only format is left as it is. */
export function clockOptions(o) {
  if (!zhClock()) return o;
  if (!o || !Object.keys(o).some((k) => k !== "timeZone")) {   // the default date-and-time (toLocaleString() with no options)
    return { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", ...(o?.timeZone ? { timeZone: o.timeZone } : {}) };
  }
  if (!hasTime(o)) return o;
  const { hour12: _ignored, ...rest } = o;
  return { ...rest, hourCycle: "h23" };
}

/** An Intl.DateTimeFormat that follows the rule above. */
export function clockFormat(o, enLocale) { return new Intl.DateTimeFormat(clockLocale(enLocale), clockOptions(o)); }

const date = (v) => (v instanceof Date ? v : new Date(v));
/** A time of day ("19:45" in zh-TW; the screen's English format otherwise). No `o`: toLocaleTimeString's own default
 *  (hours, minutes and seconds). */
export function timeText(v, o, enLocale) {
  const d = date(v);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleTimeString(clockLocale(enLocale), o || !zhClock() ? clockOptions(o) : { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}

/** A date with its time (toLocaleString), with the screen's options. */
export function dateTimeText(v, o, enLocale) {
  const d = date(v);
  return Number.isFinite(d.getTime()) ? d.toLocaleString(clockLocale(enLocale), clockOptions(o)) : "";
}

const ZH_UNIT = { ms: "毫秒", s: "秒", m: "分鐘", min: "分鐘", h: "小時" };
/** A number with its time unit: "2 h" / "5 min" / "3 s" in English, "2 小時" / "5 分鐘" / "3 秒" on a zh-TW page. */
export function unitText(n, unit) { return `${n} ${zhClock() ? ZH_UNIT[unit] ?? unit : unit}`; }
