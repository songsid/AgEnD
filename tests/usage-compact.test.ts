/**
 * The AI usage view's compact mode (user request, Discord 1562814671289983058): a header switch beside the title (the
 * dialog's and the rail's) turns the full cards (230–290 px each) into one dense line per login — the provider, profile
 * and plan; its shortest and longest windows' percent with a small bar, coloured as the full card (high / near limit);
 * the soonest reset; a mark when the numbers are not current or it failed. Coupons, credits and notes stay in the full
 * card: a line pressed opens it, its − folds it back. Remembered as a synced preference ("usage.compact").
 * /api/ai-usage is a scripted fake: no server, no vendor call.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";

const H = 3_600_000;
const soon = (h: number) => new Date(Date.now() + h * H).toISOString();
const pct = (label: string, used: number, windowMs: number, resetsAt: string, key?: string) =>
  ({ type: "percent", label, ...(key ? { labelI18n: { key } } : {}), used, windowMs, resetsAt });
const PROVIDERS = [
  { id: "claude", name: "Claude", status: "ok", plan: "Max (20x)", metrics: [pct("Session", 42, 5 * H, soon(3), "usage.metric.session"), pct("Weekly", 75, 168 * H, soon(90), "usage.metric.weekly"),
    { type: "count", label: "Credits", value: "12", unit: "coupons" }] },
  { id: "claude:work", name: "Claude (work)", profile: "work", status: "ok", plan: "Team Premium (6.25x)", metrics: [pct("Session", 93, 5 * H, soon(1)), pct("Weekly", 20, 168 * H, soon(20))] },
  { id: "codex", name: "Codex", status: "ok", plan: "Self Serve Business Usage Based", metrics: [pct("Weekly", 10, 168 * H, soon(50))] },
  { id: "kiro", name: "Kiro", status: "ok", stale: true, staleCause: "expired", cachedAt: new Date(Date.now() - 2 * H).toISOString(), hint: "Sign in again: kiro-cli login",
    metrics: [pct("Monthly", 55, 720 * H, soon(200))] },
  { id: "grok", name: "Grok", status: "error", error: "HTTP 500 from the vendor", metrics: [] },
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
async function mount(lang: "en" | "zh-TW" = "en") {
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
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ fetchedAt: new Date().toISOString(), providers: PROVIDERS }) };
  };
  await pg.mount(htm.html`<div><${usage.UsageCompactToggle} /><${usage.UsageBody} owner="usage-compact-test" /></div>`);
  await settle(3);
}
const root = () => pg!.root;
const toggle = () => root().querySelector(".u-compact-toggle") as any;
const rows = () => root().querySelectorAll(".u-crow") as any[];
const cards = () => root().querySelectorAll(".u-provider") as any[];
const text = (el: any) => String(el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("what a login's line shows", () => {
  it("its shortest and longest percent windows (one when it has one); a window reset since, or not a percent, is left out", () => {
    const [claude, work, codex] = PROVIDERS;
    expect(usage.compactMetrics(claude).map((m: any) => m.label)).toEqual(["Session", "Weekly"]);
    expect(usage.compactMetrics(work).map((m: any) => m.used)).toEqual([93, 20]);
    expect(usage.compactMetrics(codex).map((m: any) => m.label)).toEqual(["Weekly"]);
    expect(usage.compactMetrics({ metrics: [{ ...claude!.metrics[0], resetPassed: true }, claude!.metrics[2]] })).toEqual([]);
    // Three windows: the shortest and the longest.
    const three = { metrics: [pct("Weekly", 1, 168 * H, soon(1)), pct("Session", 2, 5 * H, soon(1)), pct("Monthly", 3, 720 * H, soon(1))] };
    expect(usage.compactMetrics(three).map((m: any) => m.label)).toEqual(["Session", "Monthly"]);
  });

  it("a window in a few characters (5h, 7d); one of unknown length says its label; the soonest reset still ahead", () => {
    expect([usage.windowTag({ windowMs: 5 * H }), usage.windowTag({ windowMs: 168 * H }), usage.windowTag({ label: "Extra" })]).toEqual(["5h", "7d", "Extra"]);
    const now = Date.now();
    expect(usage.soonestReset([{ resetsAt: new Date(now - H).toISOString() }, { resetsAt: new Date(now + 3 * H + 60_000).toISOString() }, { resetsAt: new Date(now + 90 * H).toISOString() }], now))
      .toEqual({ short: "↻ 3h 1m", full: expect.stringMatching(/^resets in 3h [01]m$/) });
    expect(usage.soonestReset([{}], now)).toBeNull();
    // Whatever order the windows come in.
    expect(usage.soonestReset([{ resetsAt: new Date(now + 90 * H).toISOString() }, { resetsAt: new Date(now + 2 * H).toISOString() }], now)?.short).toBe("↻ 2h 0m");
  });
});

describe("the switch, the lines and a line opened", () => {
  it("full cards by default; the switch makes one line per login (all six), remembered, and back", async () => {
    await mount();
    expect([cards().length, rows().length, text(toggle()), toggle().getAttribute("aria-pressed")]).toEqual([6, 0, "Compact", "false"]);
    toggle().click(); await settle(2);
    expect([cards().length, rows().length, text(toggle()), toggle().getAttribute("aria-pressed")]).toEqual([0, 6, "Full", "true"]);
    expect(pg!.storage.get("agend_usage_compact")).toBe("on");               // the synced preference's cache
    await new Promise((r) => setTimeout(r, 450)); await settle(2);           // the write's debounce
    expect(posts).toEqual([{ set: { "usage.compact": true } }]);              // sent to the host: it follows the person
    toggle().click(); await settle(2);
    expect([cards().length, rows().length, pg!.storage.has("agend_usage_compact")]).toEqual([6, 0, false]);
    await new Promise((r) => setTimeout(r, 450)); await settle(2);
    expect(posts.at(-1)).toEqual({ set: { "usage.compact": null } });        // the full cards are the default: cleared, not false
  });

  it("each line: name, profile and a short plan; both windows' percent with the full card's colours; the soonest reset; no coupons", async () => {
    await mount();
    toggle().click(); await settle(2);
    const [claude, work, codex] = rows();
    expect(text(claude.querySelector(".u-crow-name"))).toBe("Claude");
    expect(text(claude.querySelector(".u-plan [aria-hidden]"))).toBe("Max ×20");                 // the badge (the full name: the screen reader's)
    expect(claude.querySelectorAll(".u-cm").map((m: any) => [text(m.querySelector(".u-cm-tag")), text(m.querySelector(".u-cm-pct")), m.querySelector(".u-cm-pct").getAttribute("class")]))
      .toEqual([["5h", "42%", "u-cm-pct "], ["7d", "75%", "u-cm-pct warn"]]);
    expect(claude.querySelector(".u-crow-reset").getAttribute("title")).toMatch(/^resets in (?:2h 5\d|3h 0)m$/);
    expect(text(claude.querySelector(".u-crow-reset"))).toMatch(/^↻ (?:2h 5\d|3h 0)m \(resets in (?:2h 5\d|3h 0)m\)$/);   // and the words for a screen reader
    expect(text(claude)).not.toMatch(/coupons|Credits/);
    expect([text(work.querySelector(".u-crow-profile")), work.querySelectorAll(".u-cm-pct").map((m: any) => m.getAttribute("class"))]).toEqual(["work", ["u-cm-pct crit", "u-cm-pct "]]);
    expect(text(work.querySelector(".u-plan"))).toContain("Team ×6.25");
    expect(text(codex.querySelector(".u-plan"))).toContain("Business");                              // #2412's short kind
    expect(codex.querySelectorAll(".u-cm").length).toBe(1);
  });

  it("not current, failed, not logged in: a mark (what is wrong is its tooltip), and a word where numbers would be", async () => {
    await mount();
    toggle().click(); await settle(2);
    const [, , , kiro, grok, muse] = rows();
    expect(kiro.getAttribute("class")).toBe("u-crow is-stale");
    expect(kiro.querySelector(".u-crow-mark").getAttribute("title")).toMatch(/^expired · cached at \d\d:\d\d — Sign in again: kiro-cli login$/);
    expect(text(kiro.querySelector(".u-cm-pct"))).toBe("55%");
    expect([grok.querySelector(".u-crow-mark").getAttribute("class"), grok.querySelector(".u-crow-mark").getAttribute("title"), text(grok.querySelector(".u-crow-note"))])
      .toEqual(["u-crow-mark is-error", "HTTP 500 from the vendor", "HTTP 500 from the vendor"]);
    expect([muse.querySelector(".u-crow-mark"), text(muse.querySelector(".u-crow-note"))]).toEqual([null, "not logged in"]);
  });

  it("a line pressed opens its full card in place (coupons and all); its − folds it back; the switch closes them all", async () => {
    await mount();
    toggle().click(); await settle(2);
    rows()[0].click(); await settle(2);
    expect([cards().length, rows().length, text(cards()[0]).includes("coupons")]).toEqual([1, 5, true]);
    expect(root().querySelector(".u-provider").nextSibling.getAttribute("class")).toBe("u-crow");   // in its place, first
    cards()[0].querySelector(".u-collapse").click(); await settle(2);
    expect([cards().length, rows().length]).toEqual([0, 6]);
    rows()[1].click(); await settle(2);
    toggle().click(); await settle(2); toggle().click(); await settle(2);
    expect([cards().length, rows().length]).toEqual([0, 6]);                                      // a new compact view: all lines
  });

  it("in zh-TW: the switch's words and the windows'", async () => {
    await mount("zh-TW");
    expect(text(toggle())).toBe("精簡");
    toggle().click(); await settle(2);
    expect([text(toggle()), rows()[0].querySelectorAll(".u-cm-tag").map(text)]).toEqual(["完整", ["5小時", "7天"]]);
    expect(rows()[0].querySelectorAll(".u-cm")[1].getAttribute("title")).toBe("每週: 75% (偏高)");
  });
});
