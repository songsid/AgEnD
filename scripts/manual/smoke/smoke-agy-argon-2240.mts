// #2240 from defaults (fleet decision a78ebdc5): agy's Gemini 4 Argon quota, its own line in the full view and in the
// compact one. The agy row is the REAL recorded daily-base summary (tests/fixtures/agy-quota-2026-10-20/
// summary-daily-cli-ua.json, agy 1.4.3's own /quota, redacted) run through the provider's own pooling (agyPoolMetrics);
// a Claude and a Codex account beside it. No vendor call.
// Per case (desk light en, desk dark zh-TW, phone light zh-TW, phone dark en; reduced motion on the phone), a fresh
// profile with nothing seeded, reaching the usage view through the header's ◔:
// - full: the Antigravity card lists Gemini (session/weekly), Claude & others (session/weekly) and Gemini 4 Argon (weekly);
// - compact: the Antigravity account shows a line per pool — Gemini, Claude & others, Gemini 4 Argon — each its tighter
//   window; Claude keeps its 5h / 7d lines; no pool label clipped to nothing;
// - no console error, no CSP violation, no page overflow.
// Pictures: <case>-1-full, -2-compact.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-agy-argon-2240.mts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, freshPage, mounted, shotPath, type FreshPage, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-agy-argon-2240";
const REPO = process.env.REPO!;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48620), classic: false });
const fm = fx.fm;
const dir = fm.dataDir ?? fx.dir;
const { setUsageFetcherForTests } = await import(REPO + "/src/usage/usage-api.ts");
const { agyPoolMetrics, agyUsageBuckets } = await import(REPO + "/src/usage/providers.ts");

fm.fleetConfig.instances = Object.fromEntries(["general", "studio-layout"].map((name) => [name, { working_directory: dir, backend: "claude-code", ...(name === "general" ? { general_topic: true } : {}) }]));
fm.fleetConfig.teams = {};
fm.getInstanceStatus = () => "running";

const H = 3_600_000;
// #2519 review: the recording's reset times are fixed dates; every time in it is moved as if "now" were 2026-10-21 00:00Z
// (Gemini's session reset past, every other ahead), so the scenario never ages.
const SCENARIO_NOW = Date.parse("2026-10-21T00:00:00Z");
const summary = JSON.parse(readFileSync(join(REPO, "tests/fixtures/agy-quota-2026-10-20/summary-daily-cli-ua.json"), "utf8")
  .replace(/"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)"/g, (_m, iso: string) => JSON.stringify(new Date(Date.parse(iso) + Date.now() - SCENARIO_NOW).toISOString())));
const soon = (h: number) => new Date(Date.now() + h * H).toISOString();
const pct = (key: string, label: string, used: number, windowMs: number, resetH: number) => ({ type: "percent", label, labelI18n: { key }, used, windowMs, resetsAt: soon(resetH) });
setUsageFetcherForTests(async () => ({ fetchedAt: new Date().toISOString(), providers: [
  { id: "antigravity", name: "Antigravity", status: "ok", plan: "Google AI Pro", metrics: agyPoolMetrics(agyUsageBuckets(summary, null)) },
  { id: "claude", name: "Claude", status: "ok", plan: "Max (20x)", metrics: [pct("usage.metric.session", "Session", 42, 5 * H, 3), pct("usage.metric.weekly", "Weekly", 75, 168 * H, 90)] },
  { id: "codex", name: "Codex", status: "ok", plan: "Pro", metrics: [pct("usage.metric.weekly", "Weekly", 12, 168 * H, 50)] },
] }));
fm.getActiveUsageProviderIds = () => null;

const results: Array<Record<string, unknown>> = [];
let failed = 0;
function record(name: string, c: Record<string, boolean>, extra: Record<string, unknown> = {}) {
  const bad = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length) failed++;
  results.push({ name, ok: !bad.length, checks: c, ...extra });
  console.log(`${bad.length ? "FAIL" : "ok  "} ${name}${bad.length ? ` [${bad.join(", ")}]` : ""} ${JSON.stringify(extra).slice(0, 1200)}`);
}
const watchCsp = (ctx: any) => ctx.addInitScript({ content: `window.__smokeCsp = []; document.addEventListener("securitypolicyviolation", e => window.__smokeCsp.push(e.violatedDirective + " " + (e.blockedURI || "")));` });
const SCOPE = { desk: ".u-rail", phone: "dialog[open]" } as const;
async function openUsage(p: FreshPage, c: MatrixCase) {
  if (!(await mounted(p.page, 30000))) throw new Error("the app did not mount");
  await p.page.locator("button.hd-usage").first().click();
  await p.page.waitForSelector(`${SCOPE[c.device]} .u-provider, ${SCOPE[c.device]} .u-crow`, { timeout: 15000 });
  await p.page.waitForTimeout(600);
}
// A string, not a function: tsx would wrap a named function in a helper the page does not have.
const read = (p: FreshPage, c: MatrixCase) => p.page.evaluate(`(() => {
  const root = document.querySelector(${JSON.stringify(SCOPE[c.device])});
  const card = [...root.querySelectorAll(".u-provider")].find((s) => s.querySelector(".u-head strong")?.textContent === "Antigravity");
  const rows = [...root.querySelectorAll(".u-crow")];
  const agy = rows.find((r) => r.closest(".u-cgroup")?.querySelector(".u-cg-name")?.textContent === "Antigravity");
  const clipped = (el) => { if (!el) return null; const range = document.createRange(); range.selectNodeContents(el); return range.getBoundingClientRect().width > el.getBoundingClientRect().width + 0.01; };
  return {
    full: card ? [...card.querySelectorAll(".u-label")].map((l) => l.textContent) : null,
    compact: agy ? [...agy.querySelectorAll(".u-cm")].map((m) => ({ tag: m.querySelector(".u-cm-tag").textContent, pct: m.querySelector(".u-cm-pct").textContent,
      barW: Math.round(m.querySelector(".u-cm-bar").getBoundingClientRect().width),
      reset: (() => { const x = m.querySelector(".u-cm-reset"); return x ? ((x.firstChild && x.firstChild.nodeType === 3) ? x.firstChild.textContent : "").trim() : null; })(),
      tagW: Math.round(m.querySelector(".u-cm-tag").getBoundingClientRect().width), clipped: clipped(m.querySelector(".u-cm-tag")) })) : null,
    claude: rows.filter((r) => r.closest(".u-cgroup")?.querySelector(".u-cg-name")?.textContent === "Claude").map((r) => [...r.querySelectorAll(".u-cm-tag")].map((t) => t.textContent)),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, csp: window.__smokeCsp || [],
  };
})()`) as Promise<any>;
const ARGON = { en: "Gemini 4 Argon", "zh-TW": "Gemini 4 Argon" } as const;

const CASES: MatrixCase[] = [
  { device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" },
  { device: "phone", theme: "light", lang: "zh-TW" }, { device: "phone", theme: "dark", lang: "en" },
];
for (const c of CASES) {
  const name = `${c.device}-${c.theme}-${c.lang}`;
  const p = await freshPage(fx, c, { reducedMotion: c.device === "phone", path: "/ui/chat/studio-layout", beforeNavigate: watchCsp });
  const ck: Record<string, boolean> = {};
  await openUsage(p, c);
  const navEnd = p.errors.length;
  const full = await read(p, c);
  ck.fullArgonLine = !!full.full && full.full.length === 5 && full.full.some((l: string) => l.includes(ARGON[c.lang]));
  await p.page.screenshot({ path: shotPath(SMOKE, name, "1-full") });
  await p.page.locator(`${SCOPE[c.device]} .u-compact-toggle`).click();
  await p.page.waitForSelector(`${SCOPE[c.device]} .u-crow`, { timeout: 5000 });
  await p.page.waitForTimeout(400);
  const compact = await read(p, c);
  ck.compactPoolLines = !!compact.compact && compact.compact.length === 3 && compact.compact[2].tag === ARGON[c.lang];
  ck.poolLabelsReadable = !!compact.compact && compact.compact.every((m: any) => m.tagW >= 50);
  // 2.3.1: each pool's line its own reset (the window its % is); none on the name line.
  ck.poolLabelsWhole = !!compact.compact && compact.compact.every((m: any) => m.clipped === false);
  ck.eachPoolItsReset = !!compact.compact && compact.compact.every((m: any) => typeof m.reset === "string" && /^↻ \S+$/.test(m.reset));
  ck.claudeWindows = JSON.stringify(compact.claude) === JSON.stringify([c.lang === "zh-TW" ? ["5小時", "7天"] : ["5h", "7d"]]);
  ck.noOverflow = !compact.overflow;
  ck.noErrors = p.errors.slice(navEnd).length === 0 && compact.csp.length === 0;
  await p.page.screenshot({ path: shotPath(SMOKE, name, "2-compact") });
  record(name, ck, { full: full.full, compact: compact.compact, errors: p.errors.slice(navEnd) });
  // The next case starts from defaults: back to the full cards (that clears the switch's value on the host).
  await p.page.locator(`${SCOPE[c.device]} .u-compact-toggle`).click();
  await p.page.waitForTimeout(1200);
  await p.ctx.close();
}
writeFileSync(shotPath(SMOKE, "results", "x").replace(/[^/]+$/, "results.json"), JSON.stringify(results, null, 1));
console.log(`${failed ? "FAIL" : "PASS"} ${results.length} cases`);
await fx.close();
process.exit(failed ? 1 : 0);
