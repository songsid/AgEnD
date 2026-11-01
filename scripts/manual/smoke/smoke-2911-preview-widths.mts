// #2911 (2), M-2216: the preview panel's page widths and full screen, and the narrow panel's two-row bar, on the realistic
// fixture with the real preview listener.
// - Seeded opt-in, desk light en: Phone → the frame is 390 px wide (plus its border), centred; Tablet → 768 px, the panel
//   scrolls sideways; Full → the panel's width; the choice survives a reload. Full screen: the Fullscreen API on the
//   panel (document.fullscreenElement is the panel, never the frame); Esc leaves it and the panel stays open; a second
//   Esc closes the panel.
// - Phone dark zh-TW: the bar is two rows (versions/views/width above, run controls and Download below), nothing clipped;
//   no full screen button (the panel is already the whole screen there).
// - From defaults (nothing seeded) on a phone: the width control shows Full.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2911-preview-widths.mts
import { writeFileSync } from "node:fs";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";
import { freshPage } from "../smoke-fixture/from-defaults.mts";

const SMOKE = "smoke-2911-preview-widths";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48470), instances: 2 });
const fm = fx.fm;
const name = fx.instances.find((i: any) => !i.general)!.name;
const PAGE = (v: number) => `<title>Counter</title>\n<style>body{font:20px sans-serif;background:#def;margin:0;padding:16px}</style>\n<h1>Counter v${v}</h1>\n<p id=ok>rendered v${v}</p><p id=w></p>\n<script>document.getElementById("w").textContent = "innerWidth " + innerWidth;</script>`;
const say = (text: string) => fm.emitSseEvent("message", { instance: name, sender: name, role: "agent", text, ts: new Date().toISOString() });
say("v1:\n```html\n" + PAGE(1) + "\n```");
say("v2:\n```html\n" + PAGE(2) + "\n```");

// A string: tsx would wrap a function's inner names in __name(), which the page does not have.
const PROBE = `(() => {
  const q = (s) => document.querySelector(s), box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const body = q(".pv-panel-body");
  return { width: q(".pv-width")?.value ?? null, bodyClass: body?.className ?? null, frame: box(q(".pv-panel iframe")), panel: box(q(".pv-panel")), body: box(body),
    bodyScrolls: body ? body.scrollWidth > body.clientWidth : null, fs: q(".pv-panel")?.className ?? null,
    fsEl: document.fullscreenElement ? (document.fullscreenElement.className || document.fullscreenElement.tagName) : null,
    fsButton: (() => { const b = q(".pv-panel-fs"); return !!b && b.offsetParent !== null; })(),
    rows: (() => { const cs = [...document.querySelectorAll(".pv-panel-bar > *")].filter(e => e.offsetParent !== null && !e.classList.contains("grow")).map(e => { const r = e.getBoundingClientRect(); return r.y + r.height / 2; }).sort((a, b) => a - b);
      let n = cs.length ? 1 : 0; for (let i = 1; i < cs.length; i++) if (cs[i] - cs[i - 1] > 12) n++; return n; })(),
    clipped: [...document.querySelectorAll(".pv-panel-bar > *")].some(e => { const r = e.getBoundingClientRect(), p = q(".pv-panel").getBoundingClientRect(); return e.offsetParent !== null && (r.right > p.right + 1 || r.left < p.left - 1); }),
    overflowX: document.documentElement.scrollWidth - innerWidth, open: !!q(".pv-panel") };
})()`;
const probe = (page: any) => page.evaluate(PROBE);
/** The page's own innerWidth, read live inside the preview frame (the width it lays out at). */
async function frameText(page: any) {
  for (const f of page.frames()) { if (f === page.mainFrame()) continue; try { const v = await f.evaluate("document.getElementById('ok') ? 'innerWidth ' + innerWidth + (matchMedia('(min-width: 768px)').matches ? ' >=768' : '') + (matchMedia('(max-width: 390px)').matches ? ' <=390' : '') : ''"); if (v) return v; } catch { /* navigating */ } }
  return "";
}
const waitFrame = async (page: any) => { for (let i = 0; i < 50; i++) { if (await frameText(page)) return; await page.waitForTimeout(100); } };
const openIn = async (page: any, nth: number) => { await page.waitForSelector(".html-card .pv-open"); await page.evaluate(`document.querySelectorAll(".html-card .pv-open")[${nth}].click()`); await page.waitForTimeout(800); };
const pick = async (page: any, v: string) => { await page.selectOption(".pv-width", v); await page.waitForTimeout(500); };
const results: any = { browser: fx.browser.version(), cases: {} };

// From defaults first (the seeded cases set host-wide prefs).
{
  const fp = await freshPage(fx, { device: "phone", theme: "dark", lang: "zh-TW" } as any, { account: "operator", path: `/ui/chat/${encodeURIComponent(name)}` });
  await openIn(fp.page, 1);
  const r: any = { opened: await probe(fp.page) };
  await fp.page.screenshot({ path: shotPath(SMOKE, "fresh-phone-dark-zh-TW", "1-panel") });
  r.errors = fp.errors;
  r.pass = r.opened.width === "full" && r.opened.bodyClass === "pv-panel-body w-full" && !r.opened.fsButton && !r.opened.clipped && r.opened.overflowX <= 0 && !r.errors.length;
  results.cases["fresh-phone-dark-zh-TW"] = r;
  await fp.ctx.close();
}
{
  const c = { device: "desk", theme: "light", lang: "en" } as const;
  const { ctx, page, csp } = await fx.page(c as any, { path: `/ui/chat/${encodeURIComponent(name)}`, prefs: { "preview.optIn": true } as any });
  const errors: string[] = []; page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
  const r: any = {};
  await openIn(page, 1); await waitFrame(page);
  r.full = { ...(await probe(page)), page: await frameText(page) };
  await pick(page, "phone"); await waitFrame(page);
  r.phone = { ...(await probe(page)), page: await frameText(page) };
  await page.screenshot({ path: shotPath(SMOKE, c, "1-phone-width") });
  await pick(page, "tablet"); await waitFrame(page);
  r.tablet = { ...(await probe(page)), page: await frameText(page) };
  await page.screenshot({ path: shotPath(SMOKE, c, "2-tablet-width") });
  await page.reload(); await page.waitForTimeout(1200); await openIn(page, 1);
  r.afterReload = await probe(page);
  await pick(page, "full");
  await page.click(".pv-panel-fs"); await page.waitForTimeout(800);
  r.fs = await probe(page);
  await page.screenshot({ path: shotPath(SMOKE, c, "3-full-screen") });
  await page.keyboard.press("Escape"); await page.waitForTimeout(800);
  r.fsEsc = await probe(page);
  await page.click(".pv-panel-fs"); await page.waitForTimeout(500);
  r.fsAgain = await probe(page);
  await page.click(".pv-panel-fs"); await page.waitForTimeout(500);
  r.fsButtonOff = await probe(page);
  await page.focus(".pv-panel-fs"); await page.keyboard.press("Escape"); await page.waitForTimeout(500);
  r.escCloses = await probe(page);
  r.csp = await csp(); r.errors = errors;
  const fw = (x: any) => x.frame ? x.frame.w : -1;
  r.pass = r.full.width === "full" && fw(r.full) >= r.full.body.w - 40
    && fw(r.phone) === 394 && r.phone.page === "innerWidth 390 <=390" && !r.phone.bodyScrolls
    && fw(r.tablet) === 772 && r.tablet.page === "innerWidth 768 >=768" && r.tablet.bodyScrolls
    && r.afterReload.width === "tablet"
    && r.fs.fsEl === r.fs.fs && /pv-fs-native/.test(r.fs.fs) && r.fsEsc.open && r.fsEsc.fsEl === null && !/pv-fs/.test(r.fsEsc.fs)
    && /pv-fs/.test(r.fsAgain.fs) && !/pv-fs/.test(r.fsButtonOff.fs) && !r.escCloses.open
    && !r.errors.length && !r.csp.length;
  results.cases["desk-light-en"] = r;
  await ctx.close();
}
{
  const c = { device: "phone", theme: "dark", lang: "zh-TW" } as const;
  const { ctx, page, csp } = await fx.page(c as any, { path: `/ui/chat/${encodeURIComponent(name)}`, prefs: { "preview.optIn": true } as any, storage: { agend_preview_panel_device: "full" } });
  const errors: string[] = []; page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
  await openIn(page, 1); await waitFrame(page);
  const r: any = { bar: await probe(page) };
  await page.screenshot({ path: shotPath(SMOKE, c, "1-two-row-bar") });
  await pick(page, "phone"); await waitFrame(page);
  r.phone = { ...(await probe(page)), page: await frameText(page) };
  r.csp = await csp(); r.errors = errors;
  r.pass = r.bar.rows === 2 && !r.bar.clipped && !r.bar.fsButton && r.bar.overflowX <= 0 && r.phone.page === "innerWidth 390 <=390" && !r.errors.length && !r.csp.length;
  results.cases["phone-dark-zh-TW"] = r;
  await ctx.close();
}
// #2918 review: where the page may not use the Fullscreen API (absent, or it refuses), the panel goes over the window.
for (const mode of ["unavailable", "refused"] as const) {
  const c = { device: "desk", theme: "dark", lang: "en" } as const;
  const { ctx, page, csp } = await fx.page(c as any, { path: `/ui/chat/${encodeURIComponent(name)}`, prefs: { "preview.optIn": true } as any });
  if (mode === "unavailable") await page.evaluate("Element.prototype.requestFullscreen = undefined; Element.prototype.webkitRequestFullscreen = undefined;");
  else await page.evaluate("Element.prototype.requestFullscreen = function () { return Promise.reject(new TypeError('refused')); };");
  const errors: string[] = []; page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
  await openIn(page, 1); await waitFrame(page);
  await page.click(".pv-panel-fs"); await page.waitForTimeout(600);
  const r: any = { fs: await probe(page) };
  r.style = await page.evaluate("(() => { const s = getComputedStyle(document.querySelector('.pv-panel')); return s.position + ' ' + s.zIndex; })()");
  await page.screenshot({ path: shotPath(SMOKE, `desk-dark-en-${mode}`, "1-immersive") });
  await page.keyboard.press("Escape"); await page.waitForTimeout(400);
  r.esc = await probe(page);
  r.csp = await csp(); r.errors = errors;
  const p = r.fs.panel;
  r.pass = /pv-fs-immersive/.test(r.fs.fs) && r.fs.fsEl === null && r.style === "fixed 60" && p.x === 0 && p.y === 0 && p.w === 1366 && p.h === 900
    && r.esc.open && !/pv-fs/.test(r.esc.fs) && !r.errors.length && !r.csp.length;
  results.cases[`desk-dark-en-${mode}`] = r;
  await ctx.close();
}
writeFileSync(shotPath(SMOKE, "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(results, null, 1));
console.log(JSON.stringify(results, null, 1));
const ok = Object.values(results.cases).every((r: any) => r.pass);
console.log(ok ? "PASS" : "FAIL");
await fx.close();
process.exit(ok ? 0 : 1);
