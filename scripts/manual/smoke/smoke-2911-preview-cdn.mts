// #2911 (7), M-2216: CDN libraries in HTML previews (web.preview_cdn), on the realistic fixture with the real preview
// listener and real Chromium CSP enforcement. No network: the browser context answers the CDN URLs itself (ctx.route),
// and counts what was asked for — a URL the CSP blocks is never requested.
// - Off (the default): a page loading a library from jsDelivr gets nothing; the panel says where to allow it.
// - Turned on through the visible Settings → Web dashboard switch (it applies at once, no confirmation).
// - On, after Reload: jsDelivr /npm/ and cdnjs /ajax/libs/ load; jsDelivr /gh/ (off-prefix, allowed host) and unpkg are
//   still refused and never requested; connect-src stays 'none' (a fetch to the CDN fails).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2911-preview-cdn.mts
import { writeFileSync } from "node:fs";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2911-preview-cdn";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48490), instances: 2 });
const fm = fx.fm;
const name = fx.instances.find((i: any) => !i.general)!.name;
const LIBS = {
  npm: "https://cdn.jsdelivr.net/npm/fakelib@1.0.0/dist/fakelib.js",
  cdnjs: "https://cdnjs.cloudflare.com/ajax/libs/fakecss/1.0.0/fake.min.js",
  gh: "https://cdn.jsdelivr.net/gh/someone/repo/evil.js",
  unpkg: "https://unpkg.com/fakelib@1.0.0/dist/fakelib.js",
};
const PAGE = `<title>Chart</title><h1>CDN libraries</h1><p id=ok>loading</p>
${Object.entries(LIBS).map(([k, u]) => `<script src="${u}"></script>`).join("\n")}
<script>
var got = Object.keys(window.__libs || {}).sort().join(",") || "none";
var f = "not tried";
try { fetch("https://cdn.jsdelivr.net/npm/fakelib@1.0.0/package.json").then(function () { f = "fetched"; done(); }, function () { f = "fetch refused"; done(); }); } catch (e) { f = "fetch threw"; }
function done() { document.getElementById("ok").textContent = "libs=" + got + " " + f; }
setTimeout(done, 300);
</script>`;
fm.emitSseEvent("message", { instance: name, sender: name, role: "agent", text: "```html\n" + PAGE + "\n```", ts: new Date().toISOString() });

const c = { device: "desk", theme: "light", lang: "en" } as const;
const { ctx, page, csp } = await fx.page(c as any, { path: `/ui/chat/${encodeURIComponent(name)}`, prefs: { "preview.optIn": true } as any });
const asked: string[] = [];
for (const [k, u] of Object.entries(LIBS)) {
  await ctx.route(u, (route: any) => { asked.push(k); route.fulfill({ status: 200, contentType: "text/javascript", headers: { "Access-Control-Allow-Origin": "*" }, body: `(window.__libs = window.__libs || {})[${JSON.stringify(k)}] = 1;` }); });
}
await ctx.route("https://cdn.jsdelivr.net/npm/fakelib@1.0.0/package.json", (route: any) => { asked.push("fetch"); route.fulfill({ status: 200, body: "{}" }); });
const errors: string[] = []; page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
const frameText = async () => { for (const f of page.frames()) { if (f === page.mainFrame()) continue; try { const v = await f.evaluate("(document.getElementById('ok')||{}).textContent||''"); if (v && v !== "loading") return v; } catch { /* navigating */ } } return ""; };
const waitText = async () => { for (let i = 0; i < 60; i++) { const v = await frameText(); if (v) return v; await page.waitForTimeout(100); } return ""; };
const r: any = {};

await page.waitForSelector(".html-card .pv-open");
await page.evaluate(`document.querySelector(".html-card .pv-open").click()`);
r.off = { page: await waitText(), asked: [...asked] };
await page.waitForTimeout(500);
r.off.note = await page.evaluate("(document.querySelector('.pv-cdn-note')||{}).textContent||null");
r.off.chip = await page.evaluate("(document.querySelector('.pv-fb-errors .pv-fb-n')||{}).textContent||null");
await page.screenshot({ path: shotPath(SMOKE, c, "1-off-blocked") });

// Turn it on through Settings → Web dashboard (visible UI).
await page.goto(`${fx.base}/settings/web-dashboard`);

await page.waitForSelector("#webPreviewCdn");
r.settingText = await page.evaluate("(() => { const l = document.querySelector('#webPreviewCdn').closest('label'); const n = l.nextElementSibling; return [l.textContent.trim(), n ? n.textContent.trim() : ''] })()");
await page.check("#webPreviewCdn");
await page.locator(".s-pending button.btn-primary").click();
for (let i = 0; i < 50 && fm.fleetConfig?.web?.preview_cdn !== true; i++) await page.waitForTimeout(100);
r.saved = fm.fleetConfig?.web?.preview_cdn === true;
await page.screenshot({ path: shotPath(SMOKE, c, "2-setting-on") });

await page.goto(`${fx.base}/ui/chat/${encodeURIComponent(name)}`);
await page.waitForSelector(".html-card .pv-open");
asked.length = 0;
await page.evaluate(`document.querySelector(".html-card .pv-open").click()`);
r.on = { page: await waitText(), asked: [...asked].sort() };
await page.waitForTimeout(400);
r.on.note = await page.evaluate("(document.querySelector('.pv-cdn-note')||{}).textContent||null");
await page.screenshot({ path: shotPath(SMOKE, c, "3-on-loaded") });
r.csp = await csp(); r.errors = errors;
r.pass = r.off.page === "libs=none fetch refused" && r.off.asked.length === 0 && /cdn\.jsdelivr\.net/.test(r.off.note ?? "") && Number(r.off.chip) >= 1
  && /cdnjs \/ jsDelivr/.test(r.settingText[0]) && /those requests leave this machine/.test(r.settingText[1]) && r.saved
  && r.on.page === "libs=cdnjs,npm fetch refused" && JSON.stringify(r.on.asked) === JSON.stringify(["cdnjs", "npm"]) && r.on.note === null
  && !r.errors.length && !r.csp.length;
const results = { browser: fx.browser.version(), cases: { "desk-light-en": r } };
writeFileSync(shotPath(SMOKE, "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(results, null, 1));
console.log(JSON.stringify(results, null, 1));
console.log(r.pass ? "PASS" : "FAIL");
await ctx.close();
await fx.close();
process.exit(r.pass ? 0 : 1);
