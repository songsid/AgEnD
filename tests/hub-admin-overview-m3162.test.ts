/**
 * M-3162 (Lumen's mockup; API M-3161): Administration's tabs and its Overview.
 *   - Tabs: Overview (default where this Hub advertises admin-dashboard-v1) · Manage (today's long page) · Teams · Groups ·
 *     This Hub; a tab whose feature is off is not drawn; the tab is the address's ?view=. An older Hub: no Overview,
 *     Manage first. A 404 from the route after all: Manage, quietly.
 *   - Overview: counts only (People, Questions, Fleets, Rooms) for Today or 7 days in this browser's zone; "Not enough
 *     answers yet" where the server has too few answers; the privacy line; a Hub nobody joined: one line and "Let
 *     colleagues join" (Manage at that card) with the Fleets still shown.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let panel: any, ov: any, clients: any, words: any; const pages: AppPage[] = [];
const until = async (fn: () => unknown) => { for (let i = 0; i < 100 && !fn(); i++) await settle(5); expect(fn()).toBeTruthy(); };
beforeAll(async () => { const p = page(); panel = await import("/ui/js/panel-hub.js"); ov = await import("/ui/js/hub-admin-overview.js"); clients = await import("/ui/js/hub-client.js"); words = await import("/assets/app-i18n.js"); p.restore(); });
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } panel.resetHubSession(); clients.setHubClient(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const DAYS = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"];
const sample = (over: Record<string, any> = {}) => ({
  generatedAt: 1, range: "7d", timeZone: "Asia/Taipei", start: 0, end: 1,
  people: { total: 41, activeToday: 23, active7d: 34, joined7d: 4, signedInNow: 9 },
  questions: { asked: 412, perDay: DAYS.map((date, i) => ({ date, count: [71, 64, 83, 77, 52, 7, 58][i] })), answerTime: { medianMs: 42_000, p90Ms: null, samples: 4 },
    waiting: 3, longestWaitMs: 96_000, notAnswered: { total: 9, reasons: { offline: 4, timedOut: 3, permissionEnded: 1, stoppedOrRefused: 1, unknown: 0 } } },
  topAgents: [{ id: "x1", name: "build-agent", ownerName: "Lin", questions: 96, medianMs: 31_000, notAnswered: 1 }, { id: "x2", name: "docs-bot", ownerName: null, questions: 62, medianMs: null, notAnswered: 0 }],
  sharedAgents: 23,
  fleets: { total: 18, connected: 12, needsUpdate: 3, tooOldRooms: 1, unknownVersion: 1, recommendedVersion: "2.4.0-beta.2" },
  rooms: { total: 14, active: 9, created7d: 2, messages: 1204, byAuthor: { people: 610, agents: 540, assistant: 54 }, agentQuestions: 287, chainsStopped: 2 },
  ...over });

async function overview(o: { data?: any; lang?: string } = {}) {
  const p = page({ storage: { agend_lang: o.lang ?? "en" } }); pages.push(p); words.setLang(o.lang ?? "en");
  const client = { adminDashboard: vi.fn(async (q: any) => (o.data ?? sample({ range: q.range }))) }, onOpen = vi.fn(), onGone = vi.fn();
  await p.mount(h(ov.HubAdminOverview, { client, onOpen, onGone })); await settle(10);
  return { p, client, onOpen, onGone, text: () => (p.root.textContent || "").replace(/\s+/g, " ") };
}

describe("the Overview", () => {
  it("counts only: people, questions (the hint; not enough answers; reasons), the most-asked agents, Fleets, rooms, and the privacy line", async () => {
    const { p, client, text } = await overview();
    expect(client.adminDashboard.mock.calls[0][0]).toEqual({ range: "7d", timeZone: expect.any(String) });
    const t = text();
    for (const s of ["Counts only. This page never shows what anyone asked or what an agent answered, and never counts by person.",
      "Active today", "23", "of 41 people who have joined", "7 have not signed in this week", "Questions per day", "412", "Each agent asked counts once.",
      "Typical (median)", "42 s", "Slowest 1 in 10", "Not enough answers yet", "Longest wait now", "1.6 min", "2.2% of questions", "The agent's Fleet was offline",
      "build-agent", "Lin", "docs-bot", "23 shared agents in all.", "of 18 Fleets", "below the recommended v2.4.0-beta.2", "See Connected Fleets",
      "1,204", "of 14 rooms · 2 created this week", "hit the depth or rate limit"]) expect(t).toContain(s);
    expect(t).not.toMatch(/token|cost|Other or unknown/i);   // no token or cost; an empty unknown reason is not drawn
    // The answer-time card itself (the table has its own "Not enough answers yet" for docs-bot): the p90 has too few answers.
    const kv = [...p.root.querySelectorAll(".hub-ov-stack .hub-ov-card")][0]!.querySelectorAll(".hub-ov-kv > div");
    expect([...kv].map((d: any) => [d.querySelector("dt").textContent, d.querySelector("dd").textContent])).toEqual([
      ["Typical (median)", "42 s"], ["Slowest 1 in 10", "Not enough answers yet"], ["Waiting now", "3"], ["Longest wait now", "1.6 min"]]);
    const bars = [...p.root.querySelectorAll(".hub-ov-bars > div span")].map((s: any) => s.textContent);
    expect([bars.length, bars[6]]).toEqual([7, "Today"]);
  });

  it("zh-TW: the words, and Not enough answers in Chinese", async () => {
    const { text } = await overview({ lang: "zh-TW" });
    for (const s of ["這裡只有數字。", "每問一個 Agent 算一次。", "回答數還不夠", "今天使用", "已加入的 41 人當中", "查看已連接的 Fleet"]) expect(text()).toContain(s);
    expect(text()).not.toMatch(/連線|配對|公開/);   // the Hub vocabulary (U3)
  });

  it("Today: asked for with range today, and remembered for this session", async () => {
    const { p, client } = await overview();
    fire([...p.root.querySelectorAll(".hub-ov-range button")].find((b: any) => b.textContent === "Today"), "click"); await settle(8);
    expect([(client.adminDashboard.mock.calls.at(-1) as any)[0].range, sessionStorage.getItem("agend_hub_overview_range")]).toEqual(["today", "today"]);
  });

  it("a Hub nobody has joined: one line and Let colleagues join (Manage at that card); the Fleets still shown", async () => {
    const { p, onOpen, text } = await overview({ data: sample({ people: { total: 0, activeToday: 0, active7d: 0, joined7d: 0, signedInNow: 0 } }) });
    expect(text()).toContain("Nobody has joined yet. Let colleagues join to see activity here.");
    expect([text().includes("Questions per day"), text().includes("Connected now")]).toEqual([false, true]);
    fire(p.root.querySelector(".hub-ov-empty button"), "click");
    expect(onOpen).toHaveBeenCalledWith("manage", "join");
  });

  it("the route not there (404): onGone, nothing drawn but the range", async () => {
    const { onGone } = await overview({ data: { ok: false, status: 404 } });
    expect(onGone).toHaveBeenCalled();
  });

  it("durations and day names", () => {
    words.setLang("en");
    expect([ov.durationText(400), ov.durationText(42_000), ov.durationText(96_000), ov.durationText(15 * 60_000), ov.durationText(2 * 3_600_000), ov.durationText(null)])
      .toEqual(["1 s", "42 s", "1.6 min", "15 min", "2 h", null]);
    expect([ov.dayLabel("2026-11-09", false), ov.dayLabel("2026-11-15", true)]).toEqual(["Mon", "Today"]);
  });
});

describe("Administration's tabs", () => {
  async function admin(features: string[], url = "https://hub.example.test/ui/hub/admin", lang = "en") {
    const p = page({ url, storage: { agend_lang: lang } }); pages.push(p); words.setLang(lang);
    const session = { ok: true, signedIn: true, displayName: "Ada", login: "ada", admin: true, csrf: "c", features };
    const c = { stub: false, web: true, onSignedOut: () => () => {}, session: vi.fn(async () => session), rooms: async () => ({ ok: true, rooms: [] }), catalog: async () => ({ ok: true, askable: [] }),
      adminOverview: vi.fn(async () => ({ ok: true, fleets: [], pairings: [] })), adminDashboard: vi.fn(async () => sample()) };
    clients.setHubClient(c);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })));
    await p.mount(h(panel.HubPanel, { route: { panel: "hub", tab: "admin" } })); await settle(30);
    return { p, c, tabs: () => [...p.root.querySelectorAll(".hub-admin-tab")].map((a: any) => [a.textContent, a.getAttribute("aria-current") === "page"]) };
  }
  it("a Hub with the dashboard: Overview first and current; Manage, This Hub; the Overview drawn", async () => {
    const a = await admin(["admin-dashboard-v1"]);
    await until(() => a.p.root.querySelector(".hub-ov"));
    expect(a.tabs()).toEqual([["Overview", true], ["Manage", false], ["This Hub", false]]);
    expect(a.p.root.querySelector(".hub-admin .s-section-layout")).toBeNull();
  });
  it("an older Hub (no admin-dashboard-v1): no Overview; Manage first, today's long page", async () => {
    const a = await admin([]);
    expect(a.tabs()).toEqual([["Manage", true], ["This Hub", false]]);
    await until(() => a.p.root.querySelector(".hub-admin"));
    expect(a.c.adminDashboard).not.toHaveBeenCalled();
  });
  it("?view=manage lands on Manage; zh-TW names", async () => {
    const a = await admin(["admin-dashboard-v1"], "https://hub.example.test/ui/hub/admin?view=manage", "zh-TW");
    expect(a.tabs()).toEqual([["總覽", false], ["管理項目", true], ["這個 Hub", false]]);
  });
});
