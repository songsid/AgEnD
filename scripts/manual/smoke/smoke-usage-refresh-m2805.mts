// Real shell and shared UsageBody, synthetic API snapshots; scratch HOME and owned listeners only.
// BEFORE=1 REPO=<73940db63 checkout> captures the old status. No vendor/model/fleet start.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { bootFixture, matrix, caseName } from "../smoke-fixture/index.mts";
const repo = process.env.REPO!, out = process.env.OUT!, before = process.env.BEFORE === "1";
mkdirSync(out, { recursive: true });
const fx = await bootFixture({ port: Number(process.env.HP ?? 47720), instances: 4, classic: false });
const { setUsageFetcherForTests } = await import(repo + "/src/usage/usage-api.ts");
const snapshot = (refreshing: boolean) => ({ fetchedAt: new Date(Date.now() - 61_000).toISOString(), refreshing,
  providers: [{ id: "claude", name: "Claude", status: "ok", plan: "Max", metrics: [{ type: "percent", label: "Session", labelI18n: { key: "usage.metric.session" }, used: 42 }] }] });
setUsageFetcherForTests(async () => snapshot(false));
fx.fm.getActiveUsageProviderIds = () => null;
const results: unknown[] = [];
try {
  for (const c of matrix("desk-light-en,desk-light-zh-TW,phone-dark-en,phone-dark-zh-TW")) for (const skew of before ? [false] : [false, true]) {
    const p = await fx.page(c, { path: `/ui/chat/${encodeURIComponent(fx.instances[0]!.name)}`, storage: { agend_usage_rail: "0" } });
    try {
      const { page } = p, errors: string[] = [];
      page.on("pageerror", (e: any) => errors.push(String(e)));
      page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
      await page.setViewportSize({ width: c.device === "phone" ? 340 : 1366, height: c.device === "phone" ? 820 : 900 });
      let refreshing = true, oldReads = 0;
      await page.route("**/api/ai-usage*", (r: any) => r.fulfill({ json: snapshot(refreshing) }));
      if (skew) for (const f of ["app.css", "view-strings.js"]) {
        const body = execFileSync("git", ["-C", repo, "show", `v2.3.5-beta.3:src/ui/shared/${f}`], { encoding: "utf8" });
        await page.route(`**/assets/${f}*`, (r: any) => { oldReads++; return r.fulfill({ contentType: f.endsWith("css") ? "text/css" : "text/javascript", body }); });
      }
      await page.reload(); await page.locator("button.hd-usage").first().click();
      const foot = page.locator(c.device === "phone" ? "dialog[open] .u-foot .note" : ".u-rail .u-foot .note");
      await foot.waitFor();
      const updating = (await foot.textContent())!.trim();
      const expected = c.lang === "zh-TW" ? "更新中…" : skew ? "Refreshing…" : "Updating…";
      if (!before && updating !== expected) throw Error(`status ${updating} != ${expected}`);
      if (before && !updating.includes(" · ")) throw Error(`before did not reproduce: ${updating}`);
      await foot.scrollIntoViewIfNeeded();
      const tag = `${before ? "before" : skew ? "skew" : "after"}-${caseName(c)}`;
      await page.screenshot({ path: join(out, tag + "-updating.png") });
      const lines = await foot.evaluate((n: any) => { const r = document.createRange(); r.selectNodeContents(n); return { rects: r.getClientRects().length, textHeight: r.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(n).lineHeight) }; });
      if (!before && lines.textHeight > lines.lineHeight + 1) throw Error("updating status wraps");
      refreshing = false;
      await page.locator(c.device === "phone" ? "dialog[open] .u-foot button" : ".u-rail .u-foot button").click();
      await foot.locator(".u-refreshing").waitFor({ state: "detached" });
      const idle = (await foot.textContent())!.trim();
      if (idle !== (c.lang === "zh-TW" ? "1 分鐘前更新" : "Updated 1 min ago")) throw Error(`idle ${idle}`);
      if (!before && !skew) await page.screenshot({ path: join(out, tag + "-idle.png") });
      if (skew && oldReads < 2) throw Error("cached assets not consumed");
      if (errors.length || (await p.csp()).length || await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error(JSON.stringify({ errors, csp: await p.csp() }));
      results.push({ tag, updating, idle, oldReads, lines, pass: true });
    } finally { await p.ctx.close(); }
  }
  writeFileSync(join(out, "results.json"), JSON.stringify({ base: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), before, browser: fx.browser.version(), scope: "real shell/shared card; synthetic usage response; beta.3 cached CSS+strings; no vendor/fleet start", results }, null, 2) + "\n");
  console.log(JSON.stringify({ pass: true, cases: results.length }));
} finally { await fx.close(); }
