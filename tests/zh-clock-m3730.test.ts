/**
 * M-3730 (the user, 2026-11-25): the zh-TW interface shows times on a 24-hour clock (00:19, 19:45), never 上午12:19 or
 * 下午07:45, through one helper (src/ui/shared/clock-text.js); English keeps each screen's own format. zh durations say
 * 小時/分鐘/秒, and the DM after a /web code says 有效至.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const UI = join(ROOT, "src", "ui");
const page = (lang: string | null) => { (globalThis as { document?: unknown }).document = lang === null ? undefined : { documentElement: { lang }, body: { dataset: {} } }; };
afterEach(() => { page(null); });
/** ICU puts a thin or narrow no-break space between parts; the words are what is asserted. */
const sp = (s: string) => s.replace(/\s/g, " ");

// 00:19 and 19:45 local time on 2026-11-25: a midnight hour and an evening hour.
const MIDNIGHT = new Date(2026, 10, 25, 0, 19, 5).getTime();
const EVENING = new Date(2026, 10, 25, 19, 45, 0).getTime();

describe("clock-text.js", () => {
  it("zh-TW: times and dates-with-time are 24-hour, whatever the screen's own locale was", async () => {
    // @ts-expect-error — a JS module of the app, with no types
    const c = await import("../src/ui/shared/clock-text.js");
    page("zh-Hant");
    expect(c.timeText(MIDNIGHT, { hour: "2-digit", minute: "2-digit" }, [])).toBe("00:19");
    expect(c.timeText(EVENING, { hour: "2-digit", minute: "2-digit" }, "en")).toBe("19:45");
    expect(c.timeText(MIDNIGHT)).toBe("00:19:05");
    expect(sp(c.dateTimeText(MIDNIGHT))).toBe("2026/11/25 00:19:05");
    expect(sp(c.dateTimeText(EVENING, { dateStyle: "medium", timeStyle: "short" }, []))).toBe("2026年11月25日 19:45");
    expect(sp(c.dateTimeText(EVENING, { dateStyle: "short", timeStyle: "short" }, []))).toBe("2026/11/25 19:45");
    expect(sp(c.dateTimeText(EVENING, { dateStyle: "long", timeStyle: "short" }, "en"))).toBe("2026年11月25日 19:45");
    expect(sp(c.dateTimeText(EVENING, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }))).toBe("11月25日 19:45");
    expect(c.clockFormat({ hour: "2-digit", minute: "2-digit" }, undefined).format(MIDNIGHT)).toBe("00:19");
    for (const s of [c.timeText(MIDNIGHT, {}), c.dateTimeText(EVENING), c.dateTimeText(MIDNIGHT, { dateStyle: "short", timeStyle: "short" })]) expect(s).not.toMatch(/上午|下午|凌晨|晚上/);
  });

  it("English: each screen keeps its own format (12-hour where it was)", async () => {
    // @ts-expect-error — a JS module of the app, with no types
    const c = await import("../src/ui/shared/clock-text.js");
    page("en");
    expect(sp(c.timeText(EVENING, { hour: "2-digit", minute: "2-digit" }, "en"))).toBe("07:45 PM");
    expect(c.timeText(MIDNIGHT, { hour: "2-digit", minute: "2-digit" }, "en-GB")).toBe("00:19");
    expect(c.dateTimeText(EVENING, undefined, "en-US")).toBe(new Date(EVENING).toLocaleString("en-US"));
    expect(c.dateTimeText(EVENING, { month: "short", day: "numeric" }, "en")).toBe("Nov 25");
  });

  it("no fields (none, {} or only a timeZone): each wrapper keeps its native default, on the 24-hour clock (#4455 review)", async () => {
    // @ts-expect-error — a JS module of the app, with no types
    const c = await import("../src/ui/shared/clock-text.js");
    page("zh-Hant");
    const tz = { timeZone: "UTC" }, utcMidnight = Date.UTC(2026, 10, 25, 0, 19, 5);
    expect([c.timeText(MIDNIGHT), c.timeText(MIDNIGHT, {})].map(sp)).toEqual(["00:19:05", "00:19:05"]);
    expect(sp(c.timeText(utcMidnight, tz))).toBe("00:19:05");                    // a time alone, never a date
    expect([c.dateTimeText(MIDNIGHT), c.dateTimeText(MIDNIGHT, {})].map(sp)).toEqual(["2026/11/25 00:19:05", "2026/11/25 00:19:05"]);
    expect(sp(c.dateTimeText(utcMidnight, tz))).toBe("2026/11/25 00:19:05");      // a date and a time
    expect(c.clockFormat(undefined, undefined).format(MIDNIGHT)).toBe(new Intl.DateTimeFormat("zh-TW").format(MIDNIGHT));   // a date alone
    expect(c.clockFormat({}, undefined).format(MIDNIGHT)).toBe("2026/11/25");
    expect(c.clockFormat(tz, undefined).format(utcMidnight)).toBe("2026/11/25");
  });

  it("a date-only format is left as it is in zh-TW; an unreadable value is empty", async () => {
    // @ts-expect-error — a JS module of the app, with no types
    const c = await import("../src/ui/shared/clock-text.js");
    page("zh-Hant");
    expect(c.dateTimeText(EVENING, { month: "short", day: "numeric" }, "en")).toBe("11月25日");
    expect(c.timeText("not a date")).toBe("");
    expect(c.dateTimeText(Number.NaN)).toBe("");
  });

  it("durations: 小時/分鐘/秒 in zh-TW, h/min/s in English", async () => {
    // @ts-expect-error — a JS module of the app, with no types
    const c = await import("../src/ui/shared/clock-text.js");
    page("zh-Hant");
    expect([c.unitText(2, "h"), c.unitText(5, "min"), c.unitText(3, "s"), c.unitText(120, "ms")]).toEqual(["2 小時", "5 分鐘", "3 秒", "120 毫秒"]);
    page("en");
    expect([c.unitText(2, "h"), c.unitText(5, "min"), c.unitText(3, "s")]).toEqual(["2 h", "5 min", "3 s"]);
    // @ts-expect-error — a JS module of the app, with no types
    const { ttlText } = await import("../src/ui/fleet-cache.js");
    expect(ttlText(7200)).toBe("2 h");
    page("zh-Hant");
    expect([ttlText(7200), ttlText(300)]).toEqual(["2 小時", "5 分鐘"]);
  });
});

describe("chat-time.js on a zh-TW page", () => {
  it("a chat line's time and its tooltip are 24-hour; English keeps the browser's format", async () => {
    // @ts-expect-error — a JS module of the app, with no types
    const { chatTime, chatTimeFull } = await import("../src/ui/shared/chat-time.js");
    page("zh-Hant");
    expect(chatTime(MIDNIGHT, { tz: undefined, now: MIDNIGHT })).toBe("00:19");
    expect(chatTimeFull(EVENING, { tz: undefined })).not.toMatch(/上午|下午/);
    expect(chatTimeFull(EVENING, { tz: undefined })).toContain("19:45");
    page("en");
    expect(sp(chatTime(EVENING, { tz: undefined, now: EVENING, locale: "en-US" }))).toBe("07:45 PM");
  });
});

describe("one helper: no screen formats a time on its own", () => {
  const walk = (d: string, out: string[] = []): string[] => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { if (n !== "vendor") walk(p, out); } else if (p.endsWith(".js")) out.push(p);
    }
    return out;
  };
  // The only places that may call the Intl time formatting with an hour themselves: the helper, the chat time (no
  // imports, the same rule inline), host-time (already 24-hour), and machine-readable stamps (sv-SE / en-CA).
  const ALLOWED = new Set(["shared/clock-text.js", "shared/chat-time.js", "host-time.js"]);
  it("every toLocaleTimeString, date toLocaleString with a time, and Intl.DateTimeFormat with an hour goes through clock-text.js", () => {
    const offenders: string[] = [];
    for (const f of walk(UI)) {
      const rel = f.slice(UI.length + 1).split("\\").join("/");
      if (ALLOWED.has(rel)) continue;
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (/\.toLocaleTimeString\(/.test(line)) offenders.push(`${rel}:${i + 1}`);
        if (/new Date\([^)]*\)\)?\.toLocaleString\(\)/.test(line)) offenders.push(`${rel}:${i + 1}`);
        if (/new Intl\.DateTimeFormat\((?!"sv-SE"|"en-CA")[^;]*\b(hour|timeStyle)\b/.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("control: the scan catches each shape", () => {
    const shapes = ["x.toLocaleTimeString([], { hour: \"2-digit\" })", "new Date(at).toLocaleString()", "new Intl.DateTimeFormat(undefined, { hour: \"2-digit\" })"];
    const hit = (line: string) => /\.toLocaleTimeString\(/.test(line) || /new Date\([^)]*\)\)?\.toLocaleString\(\)/.test(line) || /new Intl\.DateTimeFormat\((?!"sv-SE"|"en-CA")[^;]*\b(hour|timeStyle)\b/.test(line);
    expect(shapes.map(hit)).toEqual([true, true, true]);
    expect(hit("new Intl.DateTimeFormat(\"sv-SE\", { hour: \"2-digit\" })")).toBe(false);
  });

  it("the helper is served wherever its importers run: the app's /assets/ closure and the Office share page", () => {
    expect(readFileSync(join(ROOT, "src", "auth-api.ts"), "utf8")).toMatch(/"app-i18n\.js", "clock-text\.js"/);
    expect(readFileSync(join(ROOT, "src", "office-share-page.ts"), "utf8")).toMatch(/"app-i18n\.js", "clock-text\.js"/);
  });
});

describe("the words", () => {
  it("web_auth.signed_in says 有效至 in zh-TW, and the zh docs quote it", async () => {
    const { setLocale, t } = await import("../src/locale.js");
    setLocale("zh-TW");
    try { expect(t("web_auth.signed_in", "Chrome", "Windows", "2026/11/25 19:45:00")).toContain("，驗證有效至 2026/11/25 19:45:00："); } finally { setLocale("en"); }
    expect(readFileSync(join(ROOT, "docs", "web-dashboard.zh-TW.md"), "utf8")).toContain("登入，驗證有效至 …");
    expect(readFileSync(join(ROOT, "src", "locale.ts"), "utf8")).not.toContain("已驗證到");
  });
});
