// M-2815 on the realistic fixture, in Chromium: the usage rail (desk 1366) and the phone sheet (390), light and dark,
// English and zh-TW. Each Claude login's card lists "Fable (weekly)" even at 0% (as the vendor reports it on every
// login today), a Codex login's unused per-model quota stays hidden, and no card shows the capacity footnote although
// the server still serves `capacity` on the weekly bar (get_usage keeps it). No account and no vendor call: the usage
// read and the estimate are the product's own seams (setUsageFetcherForTests, setCapacityLookup).
// Then a stale tab (quality rule 3), both ways: the previous usage-dialog.js with this server and CSS (it still draws the
// capacity it is served, unstyled — nothing broken, Fable listed), and this dialog with the previous app.css.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   SKEW_OLD_DIALOG=<file> SKEW_OLD_CSS=<file> npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2815-usage-card.mts
import { readFileSync, writeFileSync } from "node:fs";
import { bootFixture, matrix, caseName, shotPath } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48567) });
const { setUsageFetcherForTests, setCapacityLookup } = await import(process.env.REPO + "/src/usage/usage-api.ts");
const at = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const WEEK = 6048e5;
const session = (used: number) => ({ type: "percent", label: "Session", labelI18n: { key: "usage.metric.session" }, used, resetsAt: at(3), windowMs: 18e6 });
const weekly = (used: number, h: number) => ({ type: "percent", label: "Weekly", labelI18n: { key: "usage.metric.weekly" }, used, resetsAt: at(h), windowMs: WEEK });
const fable = (h: number) => ({ type: "percent", label: "Fable (weekly)", labelI18n: { key: "usage.metric.named_weekly", args: ["Fable"] }, scope: "model", used: 0, resetsAt: at(h), windowMs: WEEK });
setUsageFetcherForTests(async () => ({ fetchedAt: new Date().toISOString(), providers: [
  { id: "claude", name: "Claude (default)", defaultLogin: true, status: "ok", plan: "Team Premium (6.25x)", metrics: [session(12), { ...weekly(54, 80), note: "binding", noteI18n: { key: "usage.note.binding" } }, fable(80)] },
  { id: "claude:Han2", name: "Claude (Han2)", profile: "Han2", status: "ok", plan: "Max (20x)", metrics: [session(3), weekly(11, 150), fable(150)] },
  { id: "codex", name: "Codex", status: "ok", plan: "Pro", metrics: [weekly(68, 24), { type: "percent", label: "GPT-5.3-Codex-Spark", scope: "model", used: 0, windowMs: WEEK }] },
] }));
// The server still measures the weekly 100% (served to get_usage); the card must not draw it.
setCapacityLookup((provider: string, metric: string) => metric === "Weekly" && provider.startsWith("claude")
  ? { status: "ok", windows: 2, deltaPct: 40, bestFit: null, mixed: false, bases: { all: { median: 4.2e9, low: 3.6e9, high: 4.9e9, cv: 0.1, windows: 2 } } } : null);
fx.fm.getActiveUsageProviderIds = () => null;

const chat = `/ui/chat/${encodeURIComponent(fx.instances[4].name)}`;
const failed: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed.push(what); };
const r: Record<string, unknown> = {};
/** Each card's metric labels, the capacity blocks and the "100% ≈" text under `scope`: a fixed page function, the selector its argument. */
const read = (page: any, scope: string) => page.evaluate((sel: string) => {
  const s = document.querySelector(sel); if (!s) return null;
  return { labels: [...s.querySelectorAll(".u-metric .u-label")].map((l) => l.textContent), caps: s.querySelectorAll(".u-cap").length,
    capText: /100% ≈|this fleet's agents|只計算這個 fleet/.test(s.textContent || ""),
    clipped: [...s.querySelectorAll(".u-metric")].some((d) => d.scrollWidth > d.clientWidth + 1) };
}, scope);
async function open(c: any, skew?: { pattern: string; body: string; type: string }) {
  const kind = c.device === "desk" ? "rail" : "phone";
  const { ctx, page, csp } = await fx.page(c, { path: chat, storage: { agend_usage_rail: "1" } });
  const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 160)));
  if (skew) { await ctx.route(skew.pattern, (rt: any) => rt.fulfill({ status: 200, contentType: skew.type, body: skew.body })); await page.reload(); }
  await page.waitForTimeout(1500);
  if (kind === "phone") { await page.click("button.hd-usage").catch(() => errs.push("no button.hd-usage")); await page.waitForTimeout(1200); }
  const scope = kind === "rail" ? ".u-rail" : "dialog[open]";
  return { ctx, page, csp, errs, scope, kind };
}
const fableLabel = (zh: boolean) => zh ? "Fable（週）" : "Fable (weekly)";

for (const c of matrix()) {
  const tag = caseName(c), zh = c.lang === "zh-TW";
  const o = await open(c);
  const got = await read(o.page, o.scope) as { labels: string[]; caps: number; capText: boolean; clipped: boolean } | null;
  r[tag] = { got, errs: o.errs, csp: await o.csp() };
  check(!!got && got.labels.filter((l) => l === fableLabel(zh)).length === 2, `${tag}: "${fableLabel(zh)}" on both Claude cards (${got?.labels.join(" / ")})`);
  check(!!got && !got.labels.includes("GPT-5.3-Codex-Spark"), `${tag}: Codex's unused per-model quota stays hidden`);
  check(!!got && got.caps === 0 && !got.capText, `${tag}: no capacity footnote (${got?.caps} blocks)`);
  check(!!got && !got.clipped, `${tag}: nothing clipped`);
  check(o.errs.length === 0 && (r[tag] as any).csp.length === 0, `${tag}: no page error, no CSP violation (${o.errs.join(" | ")})`);
  const box = await o.page.locator(o.scope).first().boundingBox().catch(() => null);
  if (box) await o.page.screenshot({ path: shotPath("2815-card", c, o.kind), clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 900) } });
  await o.ctx.close();
}

// ── a stale tab, both ways (desk, light, zh-TW) ──
if (process.env.SKEW_OLD_DIALOG && process.env.SKEW_OLD_CSS) {
  const c = { device: "desk", theme: "light", lang: "zh-TW" } as const;
  {
    const o = await open(c, { pattern: "**/assets/usage-dialog.js", body: readFileSync(process.env.SKEW_OLD_DIALOG, "utf8"), type: "text/javascript; charset=utf-8" });
    const got = await read(o.page, o.scope) as any;
    check(!!got && got.labels.filter((l: string) => l === fableLabel(true)).length === 2, `skew old dialog + new server/css: Fable listed (${got?.labels.join(" / ")})`);
    check(o.errs.length === 0, `skew old dialog + new server/css: no page error (${o.errs.join(" | ")}); it may still draw the capacity it is served (${got?.caps} blocks)`);
    await o.page.screenshot({ path: shotPath("2815-card", "skew", "old-dialog-new-css") });
    await o.ctx.close();
  }
  {
    const o = await open(c, { pattern: "**/assets/app.css", body: readFileSync(process.env.SKEW_OLD_CSS, "utf8"), type: "text/css; charset=utf-8" });
    const got = await read(o.page, o.scope) as any;
    check(!!got && got.caps === 0 && got.labels.filter((l: string) => l === fableLabel(true)).length === 2, `skew new dialog + old css: Fable listed, no capacity`);
    check(o.errs.length === 0, `skew new dialog + old css: no page error (${o.errs.join(" | ")})`);
    await o.page.screenshot({ path: shotPath("2815-card", "skew", "new-dialog-old-css") });
    await o.ctx.close();
  }
} else console.log("skew: skipped (set SKEW_OLD_DIALOG and SKEW_OLD_CSS)");

writeFileSync(shotPath("2815-card", "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(failed.length ? `smoke-2815-usage-card: ${failed.length} FAILED` : "smoke-2815-usage-card: PASS");
await fx.close(); process.exit(failed.length ? 1 : 0);
