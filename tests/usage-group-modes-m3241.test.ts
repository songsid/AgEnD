/**
 * M-3241 (the user): in the AI usage panel's grouped view, a provider of two or more logins (e.g. CLAUDE ×5) has −/+ on
 * its header's right, cycling: every window of each login (as before) → one line per login (its binding window — the most
 * used — beside its name: bar, percent, reset) → the header alone, with the group's highest percent. Warning colours stay
 * in both. Remembered in this browser (localStorage), per provider. The rail and the dialog are the same UsageBody.
 * /api/ai-usage is a scripted fake: no server, no vendor call.
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
  for (const g of ["Claude", "Codex"]) usage?.setGroupMode(g, "expanded");
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


const group = (name: string) => groups().find((g: any) => g.getAttribute("data-group") === name);
const btn = (g: any) => g.querySelector(".u-cg-toggle") as any;
const press = async (g: any) => { btn(g).click(); await settle(2); };

describe("M-3241: a group of two or more logins folds", () => {
  it("−/+ on the header cycles every window → one line each (the binding window, its colour kept) → the header with the highest %, and back", async () => {
    usage.usageViewStore.set({ compact: true });
    await mount();
    let claude = group("Claude");
    expect([btn(claude).getAttribute("aria-label"), btn(claude).getAttribute("aria-expanded")]).toEqual(["Claude: One line per account", "true"]);
    expect(claude.querySelectorAll(".u-crow").map((r: any) => r.querySelectorAll(".u-cm").length)).toEqual([2, 2, 2, 2]);   // every window, as before
    await press(claude); claude = group("Claude");
    // One line per login: its binding window only (the most used), its colour kept (~ high, ! near the limit) and its reset.
    const one = claude.querySelectorAll(".u-crow").map((r: any) => [r.className.includes("is-one"), cells(r).map((c: string) => c.replace(/↻.*?(?=[~!]?$)/, "").replace(/\s+/g, ""))]);
    expect(one).toEqual([[true, ["7d75%~"]], [true, ["5h93%!"]], [true, ["7d30%"]], [true, ["7d91%!"]]]);
    expect(claude.querySelectorAll(".u-cm-reset").every((r: any) => /↻/.test(text(r))), "each with its reset").toBe(true);
    expect([btn(claude).getAttribute("aria-label"), JSON.parse((globalThis as any).localStorage.getItem("agend_usage_group_modes"))]).toEqual(["Claude: Show only the header", { Claude: "compact" }]);
    await press(claude); claude = group("Claude");
    const top = claude.querySelector(".u-cg-top");
    expect([claude.querySelectorAll(".u-crow").length, text(top).startsWith("93%"), top.getAttribute("class").includes("crit"), top.getAttribute("title")]).toEqual([0, true, true, "Highest: 93% (work · 5h)"]);
    expect([btn(claude).getAttribute("aria-label"), btn(claude).getAttribute("aria-expanded")]).toEqual(["Claude: Show every window", "false"]);
    await press(claude); claude = group("Claude");
    expect([claude.querySelectorAll(".u-crow").length, JSON.parse((globalThis as any).localStorage.getItem("agend_usage_group_modes"))]).toEqual([4, {}]);
  });

  it("a provider of one login has no −/+; another group keeps its own state", async () => {
    usage.usageViewStore.set({ compact: true });
    usage.setGroupMode("Codex", "collapsed");
    await mount();
    expect(group("Kiro").querySelector(".u-cg-toggle")).toBeNull();
    expect([group("Codex").querySelectorAll(".u-crow").length, group("Claude").querySelectorAll(".u-crow").length]).toEqual([0, 4]);
    expect(text(group("Codex").querySelector(".u-cg-top"))).toMatch(/^64%/);   // design's week: the group's highest
  });

  // #4054 review: a group with failed and stale logins. The one-line rows keep their stale mark and their notes; the collapsed
  // header never takes a failed login's last numbers, and takes a stale login's cached one only when no current login has a
  // number — muted and marked cached then, as its row is.
  it("failed and stale logins: one-line rows keep their marks; the header skips a failed login and ranks current ones first", async () => {
    const ago = new Date(Date.now() - 2 * H).toISOString();
    const old = { id: "claude:old", name: "Claude (old)", profile: "old", status: "ok", stale: true, staleCause: "expired", cachedAt: ago, hint: "Sign in again", plan: "Pro", metrics: both(99, 10) };
    const bad = { id: "claude:bad", name: "Claude (bad)", profile: "bad", status: "error", error: "HTTP 500 from the vendor", metrics: both(98, 98) };
    const nc = { id: "claude:nc", name: "Claude (nc)", profile: "nc", status: "no-credentials", metrics: [] };
    usage.usageViewStore.set({ compact: true });
    usage.setGroupMode("Claude", "compact");
    await mount("en", [PROVIDERS[0], old, bad, nc, PROVIDERS[1]]);
    const line = (id: string) => group("Claude").querySelectorAll(".u-crow").find((r: any) => text(r).includes(`(${id})`) || text(r).includes(id));
    expect(group("Claude").querySelectorAll(".u-crow").length).toBe(5);
    const o = line("old");
    expect([o.className.includes("is-stale"), o.className.includes("is-one"), /cached at/.test(text(o))]).toEqual([true, true, true]);
    const b = line("bad").querySelector(".u-crow-note"), n = line("nc").querySelector(".u-crow-note");
    expect([b?.getAttribute("class").includes("is-alert"), /HTTP 500/.test(text(b))]).toEqual([true, true]);
    expect([!!n, n?.getAttribute("class").includes("is-alert")]).toEqual([true, false]);
    usage.setGroupMode("Claude", "collapsed"); await settle(2);
    let top = group("Claude").querySelector(".u-cg-top");
    // work's 93% (current): not bad's 98% (failed), not old's cached 99% (stale)
    expect([text(top).startsWith("93%"), top.getAttribute("class").includes("is-stale"), top.getAttribute("title")]).toEqual([true, false, "Highest: 93% (work · 5h)"]);
    await pg!.unmount(); pg!.restore(); pg = null;
    // Only the stale login has a number: its cached one, muted, marked cached.
    await mount("en", [old, bad, nc]);
    top = group("Claude").querySelector(".u-cg-top");
    expect([text(top).startsWith("99%"), top.getAttribute("class").includes("is-stale"), /^Highest: 99% \(old · 5h\) · cached at \d/.test(top.getAttribute("title"))]).toEqual([true, true, true]);
  });

  it("in zh-TW: 每個帳號一行 / 只顯示標題 / 顯示所有用量", async () => {
    usage.usageViewStore.set({ compact: true });
    await mount("zh-TW");
    const labels: string[] = [];
    for (let k = 0; k < 3; k++) { const g = group("Claude"); labels.push(btn(g).getAttribute("title")); await press(g); }
    expect(labels).toEqual(["每個帳號一行", "只顯示標題", "顯示所有用量"]);
  });
});
