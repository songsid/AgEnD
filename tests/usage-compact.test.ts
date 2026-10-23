/**
 * The AI usage view's compact mode (user request, Discord 1562814671289983058; then nine logins; then the user's pick
 * of layout A, 2026-10-22): a header switch beside the title (the dialog's and the rail's) turns the full cards
 * (230–290 px each) into the logins grouped by provider — its name once (×N) — each account in three short lines: its
 * name and plan, then its short and long window, each a labelled full-width bar, the percent, coloured as the full card
 * (high / near limit), and that window's own reset (2.3.1, the user: the week's reset was hidden behind the 5 h one's).
 * Last known numbers (stale) show the same, muted, with "cached at 07:47" on the name line (2.3.1); a failed read, no
 * login, or last known numbers whose windows have all reset since: one muted line in place of the bars. Coupons, credits and notes stay in the full card: an account pressed opens it in
 * place, its − folds it back. Groups and accounts keep the person's ↑↓ order. Remembered as a synced preference
 * ("usage.compact"). /api/ai-usage is a scripted fake: no server, no vendor call.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, settle, type AppPage } from "./helpers/app-harness.js";

const H = 3_600_000;
const soon = (h: number) => new Date(Date.now() + h * H).toISOString();
const pct = (label: string, used: number, windowMs: number, resetsAt: string, key?: string) =>
  ({ type: "percent", label, ...(key ? { labelI18n: { key } } : {}), used, windowMs, resetsAt });
const both = (s: number, w: number, sReset = 3, wReset = 90) => [pct("Session", s, 5 * H, soon(sReset), "usage.metric.session"), pct("Weekly", w, 168 * H, soon(wReset), "usage.metric.weekly")];
const claude = (id: string, plan: string, s: number, w: number, sReset?: number) =>
  ({ id: `claude:${id}`, name: `Claude (${id})`, profile: id, status: "ok", plan, metrics: both(s, w, sReset) });
const PROVIDERS = [
  { id: "claude", name: "Claude", status: "ok", plan: "Max (20x)", metrics: [...both(42, 75), { type: "count", label: "Credits", value: "12", unit: "coupons" }] },
  claude("work", "Team Premium (6.25x)", 93, 20, 1),
  { id: "codex", name: "Codex", status: "ok", plan: "Self Serve Business Usage Based", metrics: [pct("Weekly", 10, 168 * H, soon(50), "usage.metric.weekly")] },
  claude("research", "Max (5x)", 5, 30),
  { id: "kiro", name: "Kiro", status: "ok", stale: true, staleCause: "expired", cachedAt: new Date(Date.now() - 2 * H).toISOString(), hint: "Sign in again: kiro-cli login",
    plan: "Pro+", metrics: [pct("Monthly", 55, 720 * H, soon(200), "usage.metric.monthly")] },
  { id: "codex:design", name: "Codex (design)", profile: "design", status: "ok", plan: "Pro", metrics: both(12, 64) },
  { id: "grok", name: "Grok", status: "error", error: "HTTP 500 from the vendor", metrics: [] },
  claude("ops", "Pro", 71, 91),
  { id: "muse", name: "Muse", status: "no-credentials", metrics: [] },
];

let usage: any, i18n: any, htm: any, pg: AppPage | null = null;
let posts: unknown[] = [], hostValues: Record<string, unknown> = {};
beforeAll(async () => {
  const p0 = page({ storage: { agend_tour_done: "1" } });
  // A signed-in page (<html data-prefs>): the prefs module reads it once, on its first import — its writes go to the host.
  p0.document.documentElement.setAttribute("data-prefs", JSON.stringify({ rev: 1, values: {} }));
  usage = await import("/assets/usage-dialog.js");
  i18n = await import("/assets/app-i18n.js");
  htm = await import("/assets/app-html.js");
  p0.restore();
});
afterEach(async () => {
  if (pg) { await pg.unmount(); pg.restore(); pg = null; }
  usage?.usageViewStore.set({ compact: false });
  i18n?.setLang("en");
});
async function mount(lang: "en" | "zh-TW" = "en", providers: unknown[] = PROVIDERS) {
  pg = page({ storage: { agend_tour_done: "1" } });
  i18n.setLang(lang);
  posts = []; hostValues = {};
  (globalThis as any).fetch = async (url: string, o: any = {}) => {
    if (url === "/ui/prefs" && o.method === "POST") {
      const body = JSON.parse(o.body);
      posts.push(body);
      for (const [k, v] of Object.entries(body.set)) { if (v === null) delete hostValues[k]; else hostValues[k] = v; }   // as the host keeps them
      return { ok: true, status: 200, json: async () => ({ rev: 1 + posts.length, values: { ...hostValues } }) };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ fetchedAt: new Date().toISOString(), providers }) };
  };
  await pg.mount(htm.html`<div><${usage.UsageCompactToggle} /><${usage.UsageBody} owner="usage-compact-test" /></div>`);
  await settle(3);
}
const root = () => pg!.root;
const toggle = () => root().querySelector(".u-compact-toggle") as any;
const rows = () => root().querySelectorAll(".u-crow") as any[];
const cards = () => root().querySelectorAll(".u-provider") as any[];
const groups = () => root().querySelectorAll(".u-cgroup") as any[];
const text = (el: any) => String(el?.textContent ?? "").replace(/\s+/g, " ").trim();
const tone = (m: any) => { const c = m.querySelector(".u-cm-pct")?.getAttribute("class") ?? ""; return c.includes("crit") ? "!" : c.includes("warn") ? "~" : ""; };
const cells = (row: any) => row.querySelectorAll(".u-cm").map((m: any) => `${text(m)}${tone(m)}`);

describe("what a login's line shows", () => {
  it("two columns: its shortest window under two days, its longest of two days or more (a dash for none); one reset since is left out", () => {
    const slot = (p: any) => { const s = usage.compactSlots(p); return [s.short?.used ?? null, s.long?.used ?? null]; };
    expect(slot(PROVIDERS[0])).toEqual([42, 75]);
    expect(slot(PROVIDERS[2])).toEqual([null, 10]);                     // a week only: under the week's column
    expect(slot(PROVIDERS[4])).toEqual([null, 55]);                     // a month: the long column
    expect(slot({ metrics: [{ ...PROVIDERS[0]!.metrics[0], resetPassed: true }, PROVIDERS[0]!.metrics[2]] })).toEqual([null, null]);
    expect(slot({ metrics: [pct("W", 1, 168 * H, soon(1)), pct("S", 2, 5 * H, soon(1)), pct("M", 3, 720 * H, soon(1)), pct("?", 4, NaN, soon(1))] })).toEqual([2, 3]);
    expect(slot({ metrics: [pct("?", 4, NaN, soon(1))] })).toEqual([null, 4]);          // of unknown length: a long one
    expect(usage.compactMetrics(PROVIDERS[0]).map((m: any) => m.used)).toEqual([42, 75]);
  });

  it("a window in a few characters (5h, 7d); one of unknown length says its label; the soonest reset still ahead, in any order", () => {
    expect([usage.windowTag({ windowMs: 5 * H }), usage.windowTag({ windowMs: 168 * H }), usage.windowTag({ label: "Extra" })]).toEqual(["5h", "7d", "Extra"]);
    const now = Date.now();
    expect(usage.soonestReset([{ resetsAt: new Date(now - H).toISOString() }, { resetsAt: new Date(now + 3 * H + 60_000).toISOString() }, { resetsAt: new Date(now + 90 * H).toISOString() }], now))
      .toEqual({ short: "↻ 3h", full: expect.stringMatching(/^resets in 3h [01]m$/) });   // one unit in the column, exact in the tooltip
    expect(usage.soonestReset([{ resetsAt: new Date(now + 90 * H).toISOString() }, { resetsAt: new Date(now + 2 * H).toISOString() }], now)?.short).toBe("↻ 2h");
    expect([45 * 60_000, 50 * H, 30_000].map((ms) => usage.soonestReset([{ resetsAt: new Date(now + ms).toISOString() }], now)?.short)).toEqual(["↻ 45m", "↻ 2d", "↻ 1m"]);
    expect(usage.soonestReset([{}], now)).toBeNull();
  });

  it("grouped by provider, in the person's order: a group where its first login is, its logins in their order", () => {
    expect(usage.compactGroups(PROVIDERS).map((g: any) => [g.base, g.items.map((x: any) => x.i)]))
      .toEqual([["Claude", [0, 1, 3, 7]], ["Codex", [2, 5]], ["Kiro", [4]], ["Grok", [6]], ["Muse", [8]]]);
  });
});

describe("the switch, the groups and a line opened", () => {
  it("full cards by default; the switch: nine lines in five groups, remembered on the host, and back (cleared, not false)", async () => {
    await mount();
    expect([cards().length, rows().length, text(toggle()), toggle().getAttribute("aria-pressed")]).toEqual([9, 0, "Compact", "false"]);
    toggle().click(); await settle(2);
    expect([cards().length, rows().length, groups().length, text(toggle()), toggle().getAttribute("aria-pressed")]).toEqual([0, 9, 5, "Full", "true"]);
    expect(pg!.storage.get("agend_usage_compact")).toBe("on");               // the synced preference's cache
    await new Promise((r) => setTimeout(r, 450)); await settle(2);           // the write's debounce
    expect(posts).toEqual([{ set: { "usage.compact": true } }]);              // sent to the host: it follows the person
    toggle().click(); await settle(2);
    expect([cards().length, rows().length, pg!.storage.has("agend_usage_compact")]).toEqual([9, 0, false]);
    await new Promise((r) => setTimeout(r, 450)); await settle(2);
    expect(posts.at(-1)).toEqual({ set: { "usage.compact": null } });        // the full cards are the default: cleared
  });

  it("a group: the provider once (×N); an account: name and short plan, then a labelled bar per window coloured as the full card, each with its own reset", async () => {
    await mount();
    toggle().click(); await settle(2);
    const [cl, cx] = groups();
    expect([text(cl.querySelector(".u-cg-head")), text(cx.querySelector(".u-cg-head"))]).toEqual(["Claude×4", "Codex×2"]);
    const lines = cl.querySelectorAll(".u-crow");
    expect(lines.map((r: any) => text(r.querySelector(".u-crow-name")))).toEqual(["Claude", "work", "research", "ops"]);   // no profile: the provider
    expect(lines.map((r: any) => text(r.querySelector(".u-crow-head [aria-hidden]")))).toEqual(["Max ×20", "Team ×6.25", "Max ×5", "Pro"]);
    const meters = (r: any) => r.querySelectorAll(".u-cm").map((m: any) => `${text(m.querySelector(".u-cm-tag"))} ${text(m.querySelector(".u-cm-pct"))}${tone(m)}`);
    expect(lines.map(meters)).toEqual([["5h 42%", "7d 75%~"], ["5h 93%!", "7d 20%"], ["5h 5%", "7d 30%"], ["5h 71%~", "7d 91%!"]]);
    // Each window its own reset after its %, the week's too (no single "soonest" one on the name line any more).
    expect(root().querySelector(".u-crow-reset")).toBeNull();
    const resets = (r: any) => r.querySelectorAll(".u-cm-reset").map((x: any) => text(x.firstChild));
    expect(resets(lines[0])).toEqual([expect.stringMatching(/^↻ [23]h$/), "↻ 3d"]);                 // 5h in ~3h, the week in 90h
    expect(resets(lines[1])).toEqual([expect.stringMatching(/^↻ (?:59m|1h)$/), "↻ 3d"]);
    expect(text(lines[0].querySelectorAll(".u-cm-reset")[1])).toMatch(/^↻ 3d \(resets in .+\)$/);   // the words for a screen reader
    expect(lines[0].querySelectorAll(".u-cm")[1].getAttribute("title")).toMatch(/^Weekly: 75% \(high\) · ↻ (?:\d{1,2}\/\d{1,2} )?\d\d:\d\d$/);   // the tooltip: when
    expect(text(lines[0])).not.toMatch(/coupons|Credits/);
    expect(meters(cx.querySelectorAll(".u-crow")[0])).toEqual(["7d 10%"]);                         // a week only: one bar
  });

  it("not current, failed, not logged in: one muted line in place of the bars (what is wrong is its tooltip)", async () => {
    await mount();
    toggle().click(); await settle(2);
    const [, , kiro, grok, muse] = groups().map((g: any) => g.querySelector(".u-crow"));
    // 2.3.1 (the user): last known numbers show as the others do — the bar, its % and its reset — muted, with a small
    // "cached at 07:47" on the name line; why (expired, and what to do) is its tooltip.
    expect(kiro.getAttribute("class")).toBe("u-crow is-stale");
    expect([kiro.querySelectorAll(".u-cm").length, kiro.querySelector(".u-crow-note")]).toEqual([1, null]);
    expect(`${text(kiro.querySelector(".u-cm-tag"))} ${text(kiro.querySelector(".u-cm-pct"))} ${text(kiro.querySelector(".u-cm-reset").firstChild)}`).toBe("30d 55% ↻ 8d");
    // Cached two hours ago: the time, and its day too when that was yesterday (usageClock) — a run just after midnight.
    expect(text(kiro.querySelector(".u-crow-stale").firstChild)).toMatch(/^cached at (?:\d{1,2}\/\d{1,2} )?\d\d:\d\d$/);
    expect(kiro.querySelector(".u-crow-stale").getAttribute("title")).toMatch(/^expired · cached at (?:\d{1,2}\/\d{1,2} )?\d\d:\d\d — Sign in again: kiro-cli login$/);
    expect([text(grok.querySelector(".u-crow-note")), grok.querySelector(".u-crow-note").getAttribute("class")]).toEqual(["HTTP 500 from the vendor", "u-crow-note is-alert"]);
    expect([text(muse.querySelector(".u-crow-note")), muse.querySelector(".u-crow-note").getAttribute("class"), text(muse.querySelector(".u-crow-name"))])
      .toEqual(["not logged in", "u-crow-note", "Muse"]);
  });

  it("2.3.1: last known numbers whose windows have all reset since keep the one muted line (no number is shown as current); agy's expired token shows its pool lines", async () => {
    const ago = new Date(Date.now() - 3 * H).toISOString();
    const pool = (label: string) => ({ label, labelI18n: { key: "usage.metric.named", args: [label] } });
    await mount("en", [
      { id: "claude", name: "Claude", status: "ok", plan: "Max (20x)", stale: true, staleCause: "expired", cachedAt: ago, hint: "Sign in again",
        metrics: [{ ...pct("Session", 40, 5 * H, ago, "usage.metric.session"), resetPassed: true }, { ...pct("Weekly", 70, 168 * H, ago, "usage.metric.weekly"), resetPassed: true }] },
      { id: "antigravity", name: "Antigravity", status: "ok", plan: "Google AI Pro", stale: true, staleCause: "expired", cachedAt: ago, hint: "Sign in to agy again",
        metrics: [{ ...pct("Gemini (session)", 20, 5 * H, soon(2)), pool: pool("Gemini") }, { ...pct("Claude & others (session)", 5, 5 * H, soon(4)), pool: pool("Claude & others") }] },
    ]);
    toggle().click(); await settle(2);
    const [claudeRow, agyRow] = rows();
    expect([claudeRow.querySelectorAll(".u-cm").length, text(claudeRow.querySelector(".u-crow-note")).startsWith("expired · cached at"), claudeRow.querySelector(".u-crow-stale")])
      .toEqual([0, true, null]);
    expect([agyRow.getAttribute("class"), agyRow.querySelectorAll(".u-cm").map((m: any) => `${text(m.querySelector(".u-cm-tag"))} ${text(m.querySelector(".u-cm-reset").firstChild)}`)])
      .toEqual(["u-crow is-stale is-pooled", ["Gemini ↻ 2h", expect.stringMatching(/^Claude & others ↻ [34]h$/)]]);
    expect(agyRow.querySelector(".u-crow-stale").getAttribute("title")).toMatch(/^expired · cached at .+ — Sign in to agy again$/);
  });

  it("a line pressed opens its full card in place, in its group (coupons and all); its − folds it back; the switch closes them all", async () => {
    await mount();
    toggle().click(); await settle(2);
    rows()[0].click(); await settle(2);
    expect([cards().length, rows().length, text(cards()[0]).includes("coupons"), groups()[0].querySelectorAll(".u-provider").length]).toEqual([1, 8, true, 1]);
    cards()[0].querySelector(".u-collapse").click(); await settle(2);
    expect([cards().length, rows().length]).toEqual([0, 9]);
    rows()[1].click(); await settle(2);
    toggle().click(); await settle(2); toggle().click(); await settle(2);
    expect([cards().length, rows().length]).toEqual([0, 9]);                                      // a new compact view: all lines
  });

  it("in zh-TW: the switch's words and the windows'", async () => {
    await mount("zh-TW");
    expect(text(toggle())).toBe("精簡");
    toggle().click(); await settle(2);
    expect([text(toggle()), groups()[0].querySelectorAll(".u-crow")[0].querySelectorAll(".u-cm-tag").map(text)]).toEqual(["完整", ["5小時", "7天"]]);
    expect(groups()[0].querySelectorAll(".u-crow")[0].querySelectorAll(".u-cm")[1].getAttribute("title")).toMatch(/^每週: 75% \(偏高\) · ↻ (?:\d{1,2}\/\d{1,2} )?\d\d:\d\d$/);
    expect(groups()[0].querySelectorAll(".u-crow")[0].querySelectorAll(".u-cm-reset").map((x: any) => text(x.firstChild))).toEqual([expect.stringMatching(/^↻ [23]小時$/), "↻ 3天"]);
  });
});
