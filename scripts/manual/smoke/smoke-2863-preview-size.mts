// #2863: the web chat's HTML preview sizes on the realistic fixture, with the real preview listener. An agent attaches
// three HTML files (served from FILES=<dir>: report-2.2mb.html, large-12mb.html, huge-60mb.html):
// - 2.2 MB previews at once;
// - 12 MB asks "Preview anyway?" without reading the file; the button reads it and runs it in the same sandboxed frame,
//   while the dashboard page's long tasks are recorded (it must not freeze);
// - 60 MB is a download only, said on the card from the start (nothing read, no Preview, no question).
// Desktop light (en) and phone dark (zh-TW); a screenshot of each step.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FILES=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2863-preview-size.mts
import { copyFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2863-preview-size";
// web.upload_max_file_mb: 100 — the fleet serves an agent file up to max(50 MB, that limit), so a 60 MB one exists to test.
const fx = await bootFixture({ port: Number(process.env.HP ?? 48420), instances: 2, webYaml: "  upload_max_file_mb: 100\n  upload_max_total_mb: 200" });
const fm = fx.fm;
const name = fx.instances.find((i: any) => !i.general)!.name;
const { publicAttachment } = await import(process.env.REPO + "/src/web-upload.ts");
const FILES = ["report-2.2mb.html", "large-12mb.html", "huge-60mb.html"];
const served = FILES.map((f) => {
  const path = join(fx.dir, f); copyFileSync(join(process.env.FILES!, f), path);
  return fm.webFiles.registerServed({ path, instance: name, name: f, mime: "text/html", kind: "document" });
});
const sizes = FILES.map((f) => statSync(join(process.env.FILES!, f)).size);
fm.emitSseEvent("message", { instance: name, sender: name, role: "agent", text: "Three reports.", ts: new Date().toISOString(), attachments: served.map(publicAttachment) });

const results: any = { browser: fx.browser.version(), sizes, cases: {} };
const want = {
  en: { large: "This file is large (12 MB). Preview anyway?", over: "This file is over 50 MB; it is not previewed. Download it to open it.", anyway: "Preview anyway" },
  "zh-TW": { large: "這個檔案比較大（12 MB），仍要預覽嗎？", over: "這個檔案超過 50 MB，不提供預覽，請下載後開啟。", anyway: "仍要預覽" },
} as const;
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
  const { ctx, page, csp } = await fx.page(c as any, { path: `/ui/chat/${encodeURIComponent(name)}`, prefs: { "preview.optIn": true } as any });
  const errors: string[] = [], reads: string[] = [];
  page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
  page.on("request", (r: any) => { const m = /\/ui\/file\/([0-9a-f]{32})/.exec(r.url()); if (m) reads.push(FILES[served.findIndex((s: any) => s.id === m[1])] ?? m[1]); });
  await page.waitForSelector(".html-card[data-att]");
  const cards = async () => page.$$(".html-card[data-att]");
  const state = (i: number) => page.evaluate((i: number) => {
    const c = document.querySelectorAll(".html-card[data-att]")[i] as HTMLElement;
    const f = c.querySelector("iframe") as HTMLIFrameElement | null;
    return { note: c.querySelector(".pv-note")?.textContent ?? "", run: !(c.querySelector(".pv-run") as HTMLElement).hidden, anyway: !(c.querySelector(".pv-anyway") as HTMLElement).hidden,
      anywayText: c.querySelector(".pv-anyway")?.textContent ?? "", frame: !!f, frameHeight: f ? Math.round(f.getBoundingClientRect().height) : 0 };
  }, i);
  const r: any = {};
  // The dashboard page's long tasks from here on (the frame's own work is in its own document).
  await page.evaluate(() => { (window as any).__lt = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) (window as any).__lt.push(Math.round(e.duration)); }).observe({ type: "longtask" }); });
  const longTasks = async () => { const lt: number[] = await page.evaluate(() => (window as any).__lt.splice(0)); return { count: lt.length, max: Math.max(0, ...lt), total: lt.reduce((a, b) => a + b, 0) }; };
  const scrollTo = (i: number) => page.evaluate((i: number) => document.querySelectorAll(".html-card[data-att]")[i].scrollIntoView({ block: "start" }), i);
  const waitFrame = async (i: number) => { const t0 = Date.now(); while (Date.now() - t0 < 30000) { const s = await state(i); if (s.frame && s.frameHeight > 200) return Date.now() - t0; await page.waitForTimeout(200); } return -1; };

  // 2.2 MB: at once.
  await (await cards())[0].$(".pv-run").then((b: any) => b.click());
  r.small = { msToFrame: await waitFrame(0), ...(await state(0)), longTasks: await longTasks() };
  await scrollTo(0); await page.waitForTimeout(600);
  await page.screenshot({ path: shotPath(SMOKE, `${c.device}-${c.theme}-${c.lang}`, "1-2.2mb-previewed") });
  // 12 MB: the question, nothing read; then Preview anyway.
  const readsBefore = reads.length;
  await (await cards())[1].$(".pv-run").then((b: any) => b.click());
  await page.waitForTimeout(400);
  r.large = { asked: await state(1), readBeforeAnyway: reads.slice(readsBefore) };
  await scrollTo(1); await page.waitForTimeout(300);
  await page.screenshot({ path: shotPath(SMOKE, `${c.device}-${c.theme}-${c.lang}`, "2-12mb-asks") });
  await longTasks();
  await (await cards())[1].$(".pv-anyway").then((b: any) => b.click());
  r.large.msToFrame = await waitFrame(1);
  await page.waitForTimeout(3000);
  r.large.after = { ...(await state(1)), readAfterAnyway: reads.slice(readsBefore), longTasks: await longTasks() };
  // Still responsive: a round trip through the page's event loop right after.
  r.large.pagePingMs = await page.evaluate(() => new Promise((ok) => { const t = performance.now(); setTimeout(() => ok(Math.round(performance.now() - t)), 0); }));
  await scrollTo(1); await page.waitForTimeout(600);
  await page.screenshot({ path: shotPath(SMOKE, `${c.device}-${c.theme}-${c.lang}`, "3-12mb-previewed") });
  // 60 MB: a download only — said from the start (its listed size), no Preview to click.
  const readsBefore60 = reads.length;
  r.huge = { ...(await state(2)), read: reads.slice(readsBefore60), downloadLinks: await page.evaluate(() => [...document.querySelectorAll(".msg.agent .att-file")].map((a: any) => a.textContent.trim().slice(0, 40))) };
  await scrollTo(2); await page.waitForTimeout(300);
  await page.screenshot({ path: shotPath(SMOKE, `${c.device}-${c.theme}-${c.lang}`, "4-60mb-download-only") });
  r.overflowX = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  r.csp = await csp(); r.errors = errors;
  const w = want[c.lang];
  r.pass = r.small.frame && r.small.msToFrame >= 0 && !r.small.anyway
    && r.large.asked.note === w.large && r.large.asked.anyway && !r.large.asked.run && r.large.asked.anywayText === w.anyway && r.large.readBeforeAnyway.length === 0
    && r.large.msToFrame >= 0 && r.large.after.frame && r.large.after.readAfterAnyway.includes("large-12mb.html") && r.large.after.longTasks.max < 1000
    && r.huge.note === w.over && !r.huge.run && !r.huge.anyway && !r.huge.frame && r.huge.read.length === 0
    && r.overflowX <= 0 && !r.errors.length && !r.csp.length;
  results.cases[`${c.device}-${c.theme}-${c.lang}`] = r;
  await ctx.close();
}
console.log(JSON.stringify(results, null, 1));
const ok = Object.values(results.cases).every((r: any) => r.pass);
console.log(ok ? "PASS" : "FAIL");
await fx.close();
process.exit(ok ? 0 : 1);
