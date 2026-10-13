// #1770: the time a chat line shows, read in the fleet's zone (the one chat-logs, fleet.log and the #1586 DMs use) —
// "17:38" today, "Yesterday 17:38", "10/11 17:38" earlier this year, "2025/10/11 17:38" before. The hour and minute keep
// the browser's own format (12- or 24-hour), as they always had. No imports: the thread, the preview panel and the
// tests read it as it is.

const cache = new Map();
/** One formatter per (kind, zone, locale): a thread may label 500 lines on every render. */
function fmt(kind, tz, locale) {
  const key = `${kind}|${tz || ""}|${locale || ""}`;
  let f = cache.get(key);
  if (!f) {
    const o = kind === "hm" ? { hour: "2-digit", minute: "2-digit" }
      : kind === "ymd" ? { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" }
      : { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short" };
    f = new Intl.DateTimeFormat(kind === "ymd" ? "en-US" : (locale || []), { ...o, timeZone: tz || undefined });
    cache.set(key, f);
  }
  return f;
}
/** `tz` when this browser knows it, else undefined (the browser's own zone): a label must still be drawn. */
function known(tz) {
  if (!tz) return undefined;
  try { fmt("ymd", tz); return tz; } catch { return undefined; }
}
/** The fleet's zone, as the page was served it (<body data-fleet-tz>); undefined when absent or unknown here. */
export function fleetTz() { return known(globalThis.document?.body?.dataset?.fleetTz); }

const toMs = (ts) => (typeof ts === "number" ? ts : Date.parse(String(ts || "")));
function wall(ms, tz) {
  const p = {};
  for (const x of fmt("ymd", tz).formatToParts(ms)) p[x.type] = Number(x.value);
  return p;
}

/**
 * The label for `ts` (ISO string or epoch ms), "" when it cannot be read. opts: tz (default the fleet's), now (epoch ms),
 * yesterday(hm) → the word for "yesterday" around hm (default: hm alone), locale (tests).
 */
export function chatTime(ts, opts = {}) {
  const ms = toMs(ts);
  if (!Number.isFinite(ms)) return "";
  const tz = "tz" in opts ? known(opts.tz) : fleetTz();
  const hm = fmt("hm", tz, opts.locale).format(ms);
  const d = wall(ms, tz), today = wall(opts.now ?? Date.now(), tz);
  if (d.year === today.year && d.month === today.month && d.day === today.day) return hm;
  const y = new Date(Date.UTC(today.year, today.month - 1, today.day - 1));
  if (d.year === y.getUTCFullYear() && d.month === y.getUTCMonth() + 1 && d.day === y.getUTCDate()) return opts.yesterday ? opts.yesterday(hm) : hm;
  return d.year === today.year ? `${d.month}/${d.day} ${hm}` : `${d.year}/${d.month}/${d.day} ${hm}`;
}

/** The full date, time and zone of `ts`, for a tooltip; "" when it cannot be read. */
export function chatTimeFull(ts, opts = {}) {
  const ms = toMs(ts);
  if (!Number.isFinite(ms)) return "";
  return fmt("full", "tz" in opts ? known(opts.tz) : fleetTz(), opts.locale).format(ms);
}

/** Milliseconds until the fleet's next midnight (when "today" labels change), at most an hour (a DST day self-corrects). */
export function msToNextDay(now = Date.now(), tz = fleetTz()) {
  const w = wall(now, known(tz));
  const into = ((w.hour * 60 + w.minute) * 60 + w.second) * 1000 + (now % 1000);
  return Math.max(1000, Math.min(3_600_000, 86_400_000 - into + 1000));
}

/**
 * Call `fn` when the fleet's day may have changed — at its next midnight, then again for each one after (an hour at
 * most between looks, so a DST day or a late timer corrects itself). Each subscriber holds its own timer, and no
 * module-wide state: the unsubscribe it returns leaves nothing armed.
 */
export function onDayChange(fn) {
  let timer = null, live = true;
  const arm = () => {
    timer = setTimeout(() => {
      timer = null;
      try { fn(); } finally { if (live) arm(); }
    }, msToNextDay());
  };
  arm();
  return () => { live = false; if (timer !== null) { clearTimeout(timer); timer = null; } };
}
