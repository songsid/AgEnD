/**
 * #1770 part 1: a chat line's time says its day when it is not today — "Yesterday 17:38" / 「昨天 17:38」, "10/11 17:38"
 * earlier this year, "2025/10/11 17:38" before — read in the fleet's zone (<body data-fleet-tz>, the zone chat-logs and
 * fleet.log use, #1586), not the browser's. The same label on messages, status lines and the preview panel. Crossing the
 * fleet's midnight relabels the kept nodes in place: no node is replaced, so no live preview reloads.
 *
 * The host zone is stubbed (TZ) to one far from the fleet's, so a label read in the browser's zone would differ.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installDom } from "./helpers/mini-dom.js";

type Served = any;
let chatTime: any, chatTimeFull: any, msToNextDay: any, onDayChange: any, createThread: any, t: any, setLang: any;
beforeAll(async () => {
  ({ chatTime, chatTimeFull, msToNextDay, onDayChange } = await (import("/ui/js/chat-time.js") as Promise<Served>));
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  ({ createThread } = await (import("/ui/js/chat-thread.js") as Promise<Served>));
  await (import("/ui/js/chat-strings.js") as Promise<Served>);
  ({ t, setLang } = await (import("/assets/app-i18n.js") as Promise<Served>));
});
beforeEach(() => { vi.stubEnv("TZ", "America/Los_Angeles"); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); setLang("en"); });

const TZ = "Asia/Taipei";
// 2026-10-13 11:24 in Taipei.
const NOW = Date.parse("2026-10-13T03:24:00Z");
const en = { tz: TZ, now: NOW, locale: "en-GB", yesterday: (hm: string) => `Yesterday ${hm}` };

describe("#1770: chatTime — the day, when it is not today, in the fleet's zone", () => {
  it("today: the time alone; yesterday: the word; earlier this year: M/D; another year: Y/M/D", () => {
    expect(chatTime("2026-10-13T01:05:00Z", en)).toBe("09:05");
    expect(chatTime("2026-10-12T09:38:00Z", en)).toBe("Yesterday 17:38");
    expect(chatTime("2026-10-11T09:38:00Z", en)).toBe("10/11 17:38");
    expect(chatTime("2026-01-02T01:00:00Z", en)).toBe("1/2 09:00");
    expect(chatTime("2025-10-12T09:38:00Z", en), "the same day a year ago is not yesterday").toBe("2025/10/12 17:38");
    expect(chatTime(Date.parse("2026-10-12T09:38:00Z"), en), "epoch ms reads the same").toBe("Yesterday 17:38");
  });

  it("the day is the fleet's: across its midnight, not the host's or UTC's", () => {
    // 00:30 on the 13th in Taipei is 16:30 on the 12th in UTC and 09:30 on the 12th in Los Angeles (the stubbed host).
    expect(chatTime("2026-10-12T16:30:00Z", en)).toBe("00:30");
    expect(chatTime("2026-10-12T15:59:00Z", en), "a minute before the fleet's midnight is yesterday").toBe("Yesterday 23:59");
    expect(chatTime("2026-10-12T16:30:00Z", { ...en, tz: "UTC" }), "the same instant in UTC").toBe("Yesterday 16:30");
    // New Year in the fleet's zone: 2026-01-01 00:10 Taipei is still 2025 in UTC.
    const ny = { ...en, now: Date.parse("2026-01-01T02:00:00Z") };
    expect(chatTime("2025-12-31T16:10:00Z", ny)).toBe("00:10");
    expect(chatTime("2025-12-31T15:50:00Z", ny), "yesterday across the year").toBe("Yesterday 23:50");
    expect(chatTime("2025-12-30T15:50:00Z", ny), "older and last year: the year shows").toBe("2025/12/30 23:50");
    // The first of a month: yesterday is the last of the previous one.
    expect(chatTime("2026-02-28T12:00:00Z", { ...en, now: Date.parse("2026-03-01T01:00:00Z") })).toBe("Yesterday 20:00");
  });

  it("the page's zone (<body data-fleet-tz>) is the default; an absent or unknown one falls back to the browser's without throwing", () => {
    const dom = installDom({});
    try {
      const b = (globalThis as any).document.body;
      b.dataset.fleetTz = TZ;
      expect(chatTime("2026-10-12T16:30:00Z", { now: NOW, locale: "en-GB" })).toBe("00:30");
      expect(chatTimeFull("2026-10-12T16:30:00Z", { locale: "en-GB" })).toMatch(/13\/10\/2026, 00:30 (GMT\+8|CST)/);
      b.dataset.fleetTz = "Mars/Olympus";
      expect(chatTime("2026-10-12T16:30:00Z", { now: NOW, locale: "en-GB" }), "the host's zone (Los Angeles, where it is 20:24 on the 12th): 09:30 the same day").toBe("09:30");
      delete b.dataset.fleetTz;
      expect(chatTime("2026-10-12T16:30:00Z", { now: NOW, locale: "en-GB" })).toBe("09:30");
      expect(chatTime("not a time", en)).toBe("");
      expect(chatTime("", en)).toBe("");
    } finally { dom.restore(); }
  });

  it("the next relabel: the fleet's next midnight (plus a second), never more than an hour away", () => {
    expect(msToNextDay(Date.parse("2026-10-12T15:30:00Z"), TZ), "23:30 in Taipei").toBe(30 * 60_000 + 1000);
    expect(msToNextDay(NOW, TZ), "11:24: capped at an hour").toBe(3_600_000);
  });

  it("onDayChange: called at each midnight of the fleet's zone; its unsubscribe leaves no timer, even from inside the call", () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-13T15:30:00Z") });         // 23:30 in Taipei
    const dom = installDom({});
    try {
      (globalThis as any).document.body.dataset.fleetTz = TZ;
      const calls: number[] = [];
      const off = onDayChange(() => calls.push(Date.now()));
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(30 * 60_000);
      expect(calls, "not before midnight").toEqual([]);
      vi.advanceTimersByTime(1000);
      expect(calls).toEqual([Date.parse("2026-10-13T16:00:01Z")]);
      expect(vi.getTimerCount(), "armed again").toBe(1);
      off();
      expect(vi.getTimerCount()).toBe(0);
      let offSelf: () => void = () => {};
      offSelf = onDayChange(() => offSelf());
      vi.advanceTimersByTime(3_600_000);
      expect(vi.getTimerCount(), "unsubscribed while called: not armed again").toBe(0);
    } finally { dom.restore(); }
  });

  it("the words: Yesterday {0} / 昨天 {0}", () => {
    expect(t("chat.yesterdayAt", "17:38")).toBe("Yesterday 17:38");
    setLang("zh-TW");
    expect(t("chat.yesterdayAt", "17:38")).toBe("昨天 17:38");
  });
});

function thread() {
  const dom = installDom({});
  const doc = (globalThis as any).document;
  doc.body.dataset.fleetTz = TZ;
  const scroller = doc.createElement("div"); const list = doc.createElement("div");
  scroller.append(list); doc.body.append(scroller);
  const th = createThread(list, scroller, {
    t: (k: string) => t(k), tf: (k: string, ...a: unknown[]) => t(k, ...a), isUser: (x: any) => x.sender === "han", onJump() {}, onEmpty() {},
    setPreviewOptIn() {}, copyText: async () => true, download() {}, toggleWrap() {},
  });
  return { dom, list, th };
}
const hm = (iso: string) => new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", timeZone: TZ }).format(Date.parse(iso));
const msg = (id: number, ts: string, role = "agent", sender = "agend-x") => ({ boot: "b", id, instance: "w", sender, role, text: `m${id}`, ts });

describe("#1770: the thread labels every line — message, person and status line — and relabels at the fleet's midnight", () => {
  it("labels in the fleet's zone, with the full time on hover; past midnight the same nodes are relabelled in place", () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-13T15:30:00Z") }); // 23:30 in Taipei
    const { dom, list, th } = thread();
    try {
      const a = msg(1, "2026-10-12T09:38:00Z"), b = msg(2, "2026-10-13T15:10:00Z", "user", "han"), c = msg(3, "2026-10-13T15:20:00Z", "status", "alice");
      th.render([a, b, c]);
      const times = () => [...list.querySelectorAll(".meta .time")].map((e: any) => e.textContent);
      expect(times()).toEqual([`Yesterday ${hm(a.ts)}`, hm(b.ts), hm(c.ts)]);
      expect(list.querySelector(".meta .time").title, "the full date and zone on hover").toMatch(/2026/);
      const before = [...th.nodes.values()].map((v: any) => v.node);
      vi.advanceTimersByTime(31 * 60_000); // 00:01 on the 14th in Taipei
      expect(times()).toEqual([`10/12 ${hm(a.ts)}`, `Yesterday ${hm(b.ts)}`, `Yesterday ${hm(c.ts)}`]);
      expect([...th.nodes.values()].map((v: any) => v.node), "kept nodes, relabelled — no preview reloads").toEqual(before);
      th.render([a, b, c]);
      expect([...th.nodes.values()].map((v: any) => v.node), "a render with nothing changed replaces nothing").toEqual(before);
      // A background tab's timer may run late: the clock passes another midnight with no timer, and the next render relabels.
      vi.setSystemTime(Date.parse("2026-10-14T16:05:00Z")); // 00:05 on the 15th
      th.render([a, b, c]);
      expect(times()).toEqual([`10/12 ${hm(a.ts)}`, `10/13 ${hm(b.ts)}`, `10/13 ${hm(c.ts)}`]);
      expect([...th.nodes.values()].map((v: any) => v.node), "still the same nodes").toEqual(before);
      th.render([]);
      expect(vi.getTimerCount(), "no messages, no midnight timer").toBe(0);
      th.render([a]); th.dispose();
      expect(vi.getTimerCount(), "a thread that left leaves no timer").toBe(0);
    } finally { dom.restore(); }
  });

  it("zh-TW: 昨天", () => {
    vi.useFakeTimers({ now: NOW });
    setLang("zh-TW");
    const { dom, list, th } = thread();
    try {
      th.render([msg(1, "2026-10-12T09:38:00Z")]);
      expect(list.querySelector(".meta .time").textContent).toBe(`昨天 ${hm("2026-10-12T09:38:00Z")}`);
      th.dispose();
    } finally { dom.restore(); }
  });

  it("the preview panel labels its source and newer-version lines the same way, and nothing formats a chat time on its own", () => {
    const panel = readFileSync(join(process.cwd(), "src", "ui", "preview-panel.js"), "utf8");
    const thread = readFileSync(join(process.cwd(), "src", "ui", "chat-thread.js"), "utf8");
    expect(panel).toMatch(/const timeOf = \(ts\) => \(ts \? chatTime\(ts, \{ yesterday: \(hm\) => t\("chat\.yesterdayAt", hm\) \}\) : ""\);/);
    for (const src of [panel, thread]) expect(src).not.toMatch(/toLocaleTimeString/);
  });
});
