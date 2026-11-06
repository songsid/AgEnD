// #3066 §1 on the realistic fixture: a weekly quota's measured 100% under its bar, in Chromium — in the usage rail (desk
// 1366) and the phone sheet (390), light and dark, English and zh-TW. Two accounts: one measured (an API-equivalent line,
// a best-fit note, the fleet-only limit), one not yet (Δ 6% of 10%). No account and no vendor call: the usage read and
// the estimate are the product's own seams (setUsageFetcherForTests, setCapacityLookup), the rest is the real page.
// Then a stale tab (quality rule 3), both ways: the new dialog with the previous view-strings.js (the line must be the
// server's English, never a bare key), and the previous dialog with the new strings (no capacity, nothing broken).
// SKEW_OLD_STRINGS / SKEW_OLD_DIALOG: the previous release's src/ui/shared/view-strings.js and usage-dialog.js as files.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   SKEW_OLD_STRINGS=<file> SKEW_OLD_DIALOG=<file> npx --prefix <checkout> tsx scripts/manual/smoke/smoke-3066-capacity.mts
import { readFileSync, writeFileSync } from "node:fs";
import { bootFixture, matrix, caseName, shotPath } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48566) });
const { setUsageFetcherForTests, setCapacityLookup } = await import(process.env.REPO + "/src/usage/usage-api.ts");
const at = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const WEEK = 6048e5;
setUsageFetcherForTests(async () => ({ fetchedAt: new Date().toISOString(), providers: [
  { id: "claude:hsinlin", name: "Claude", status: "ok", plan: "Max 20x", profile: "hsinlin",
    metrics: [{ type: "percent", label: "Session", labelI18n: { key: "usage.metric.session" }, used: 4, resetsAt: at(3), windowMs: 18e6 },
      { type: "percent", label: "Weekly", labelI18n: { key: "usage.metric.weekly" }, used: 62, resetsAt: at(60), windowMs: WEEK }] },
  { id: "codex:yanxianchen", name: "Codex", status: "ok", plan: "Pro", profile: "yanxianchen",
    metrics: [{ type: "percent", label: "Weekly", labelI18n: { key: "usage.metric.weekly" }, used: 8, resetsAt: at(100), windowMs: WEEK }] },
  // Prism #3073 P1: an estimate with no basis (the lookup below) — the read must not fail; the bar stays, no capacity.
  { id: "claude", name: "Claude", status: "ok", plan: "Pro",
    metrics: [{ type: "percent", label: "Weekly", labelI18n: { key: "usage.metric.weekly" }, used: 33, resetsAt: at(80), windowMs: WEEK }] },
] }));
setCapacityLookup((provider: string, metric: string) => {
  if (metric !== "Weekly") return null;
  if (provider === "claude:hsinlin") return { status: "ok", windows: 3, deltaPct: 40, bestFit: "api", mixed: false,
    bases: { api: { median: 412, low: 378, high: 455, cv: 0.07, windows: 3 }, all: { median: 31e6, low: 29e6, high: 34e6, cv: 0.21, windows: 3 }, output: { median: 2e6, low: 1.7e6, high: 2.4e6, cv: 0.3, windows: 3 } } };
  if (provider === "codex:yanxianchen") return { status: "not_enough", deltaPct: 6 };
  if (provider === "claude") return { status: "ok", windows: 1, deltaPct: 30, bestFit: null, mixed: false, bases: {} };
  return null;
});
fx.fm.getActiveUsageProviderIds = () => null;

const chat = `/ui/chat/${encodeURIComponent(fx.instances[4].name)}`;
const failed: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed.push(what); };
const r: Record<string, unknown> = {};
/**
 * The capacity blocks under `scope`, read in the page. A fixed page function with the selector passed as its argument
 * (never spliced into code). Only anonymous inline callbacks, so tsx adds no named-function helpers the page lacks.
 */
const readCaps = (page: any, scope: string) => page.evaluate((sel: string) => {
  const s = document.querySelector(sel); if (!s) return null;
  return [...s.querySelectorAll(".u-cap")].map((c) => ({ line: c.querySelector(".u-cap-line")!.textContent, notes: [...c.querySelectorAll(".u-cap-note")].map((n) => n.textContent),
    clipped: [...c.querySelectorAll("div")].some((d) => d.scrollWidth > d.clientWidth + 1) }));
}, scope);
async function open(c: any, skew?: { pattern: string; body: string }) {
  const kind = c.device === "desk" ? "rail" : "phone";
  const { ctx, page, csp } = await fx.page(c, { path: chat, storage: { agend_usage_rail: "1" } });
  const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 160)));
  if (skew) { await ctx.route(skew.pattern, (rt: any) => rt.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: skew.body })); await page.reload(); }
  await page.waitForTimeout(1500);
  if (kind === "phone") { await page.click("button.hd-usage").catch(() => errs.push("no button.hd-usage")); await page.waitForTimeout(1200); }
  const scope = kind === "rail" ? ".u-rail" : "dialog[open]";
  return { ctx, page, csp, errs, scope, kind };
}

for (const c of matrix()) {
  const tag = caseName(c);
  const o = await open(c);
  const caps = await readCaps(o.page, o.scope) as Array<{ line: string; notes: string[]; clipped: boolean }> | null;
  r[tag] = { caps, errs: o.errs, csp: await o.csp() };
  const zh = c.lang === "zh-TW";
  check(!!caps && caps.length === 2, `${tag}: a capacity block under each weekly bar (${caps?.length})`);
  const want = zh ? "100% ≈ $412（$378–$455）· 約 31.0M token · 依 3 週" : "100% ≈ $412 ($378–$455) · ≈ 31.0M tokens · from 3 weeks";
  check(caps?.[0]?.line === want, `${tag}: the measured line "${caps?.[0]?.line}"`);
  check(caps?.[0]?.notes[0] === (zh ? "只計算這個 fleet 的 agent；同一帳號在別處的使用會讓這個值偏低。" : "Counts only this fleet's agents; use of the same account elsewhere makes this low."), `${tag}: the fleet-only limit, always`);
  check(caps?.[0]?.notes[1] === (zh ? "「API 等值」最吻合：3 週內 ±7%" : "API-equivalent fits best: ±7% across 3 weeks"), `${tag}: the best fit "${caps?.[0]?.notes[1]}"`);
  check(caps?.[1]?.line === (zh ? "用量還不夠估算 100%（已用 Δ 6%，需 10%）" : "Not enough usage yet to measure 100% (Δ 6% of 10%)"), `${tag}: not enough yet "${caps?.[1]?.line}"`);
  check(!!caps && caps.every((x) => !x.clipped), `${tag}: nothing clipped`);
  const bars = await o.page.evaluate(`document.querySelectorAll(${JSON.stringify(o.scope)} + " .u-meter").length`) as number;
  check(bars >= 4, `${tag}: every bar served, the no-basis account's too (${bars} bars; Prism #3073 P1)`);
  check(o.errs.length === 0 && (r[tag] as any).csp.length === 0, `${tag}: no page error, no CSP violation (${o.errs.join(" | ")})`);
  const box = await o.page.locator(o.scope).first().boundingBox().catch(() => null);
  if (box) await o.page.screenshot({ path: shotPath("3066-cap", c, o.kind), clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 720) } });
  await o.ctx.close();
}

// ── a stale tab, both ways (desk, light, en) ──
if (process.env.SKEW_OLD_STRINGS && process.env.SKEW_OLD_DIALOG) {
  const c = { device: "desk", theme: "light", lang: "zh-TW" } as const;
  {
    const o = await open(c, { pattern: "**/assets/view-strings.js", body: readFileSync(process.env.SKEW_OLD_STRINGS, "utf8") });
    const caps = await readCaps(o.page, o.scope) as Array<{ line: string; notes: string[] }> | null;
    check(caps?.[0]?.line === "100% ≈ $412 ($378–$455) · ≈ 31.0M tokens · from 3 weeks", `skew new dialog + old strings: the server's English, never a key ("${caps?.[0]?.line}")`);
    check(!!caps && caps.every((x) => !/usage\.capacity/.test(x.line + x.notes.join(""))), "skew new dialog + old strings: no bare key anywhere");
    check(o.errs.length === 0, `skew new dialog + old strings: no page error (${o.errs.join(" | ")})`);
    await o.page.screenshot({ path: shotPath("3066-cap", "skew", "new-dialog-old-strings") });
    await o.ctx.close();
  }
  {
    const o = await open(c, { pattern: "**/assets/usage-dialog.js", body: readFileSync(process.env.SKEW_OLD_DIALOG, "utf8") });
    const caps = await readCaps(o.page, o.scope) as unknown[] | null;
    const bars = await o.page.evaluate(`document.querySelectorAll(${JSON.stringify(o.scope)} + " .u-meter").length`) as number;
    check(Array.isArray(caps) && caps.length === 0 && bars >= 2, `skew old dialog + new strings: the bars as before, no capacity (${bars} bars)`);
    check(o.errs.length === 0, `skew old dialog + new strings: no page error (${o.errs.join(" | ")})`);
    await o.page.screenshot({ path: shotPath("3066-cap", "skew", "old-dialog-new-strings") });
    await o.ctx.close();
  }
} else console.log("skew: skipped (set SKEW_OLD_STRINGS and SKEW_OLD_DIALOG)");

writeFileSync(shotPath("3066-cap", "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(failed.length ? `smoke-3066-capacity: ${failed.length} FAILED` : "smoke-3066-capacity: PASS");
await fx.close(); process.exit(failed.length ? 1 : 0);
