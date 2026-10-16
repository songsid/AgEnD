/** Scratch fake API + actual owner selector/store/styles; no fleet, real session, effect code or preview. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
if (!process.env.PW_DIR) throw Error("Set PW_DIR to private Playwright tools");
const pw = createRequire(join(resolve(process.env.PW_DIR), "package.json"))("playwright");
const out = resolve(process.env.OUT_DIR || ".artifacts/owner-settings-native"); mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(out, "private-")); mkdirSync(join(scratch, "home")); mkdirSync(join(scratch, "tmp"));
const id = "a".repeat(32), epoch = "e".repeat(16), keys = ["fx.sidebar", "fx.header", "fx.page", "fx.box", "fx.cursor"];
const manifest = { title: "Snow", regions: ["sidebar", "header", "page", "box"], box: { width: 100, height: 100 }, cursor: "cursor.png" };
const calls: any[] = [], rows: any[] = []; let rev = 1, chosen: Record<string, string> = {}, shared = true;
const server = createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost"), path = url.pathname;
  if (/^\/assets\/[a-z0-9._-]+$/.test(path) || /^\/ui\/js\/[a-z0-9_-]+\.js$/.test(path)) {
    try { res.setHeader("Content-Type", path.endsWith(".css") ? "text/css" : "text/javascript"); res.end(readFileSync(join("src/ui", path.startsWith("/assets/") ? "shared" : "", path.split("/").at(-1)!))); }
    catch { res.statusCode = 404; res.end(); } return;
  }
  const scope = req.headers["x-probe-scope"] === "operator" ? "operator" : "person";
  if (path === "/ui/prefs" || path === "/ui/effects/owner") {
    const chunks: Buffer[] = []; req.on("data", c => chunks.push(c)); req.on("end", () => {
      const raw = Buffer.concat(chunks).toString(), body = raw ? JSON.parse(raw) : null;
      calls.push({ path, body, query: url.search, scope }); res.setHeader("Content-Type", "application/json");
      if (path === "/ui/prefs") {
        if (req.method !== "POST" || body?.ownerEpoch !== epoch || Object.keys(body.set || {}).some(k => !keys.includes(k))) { res.statusCode = 409; res.end('{}'); return; }
        for (const [key, value] of Object.entries(body.set)) { if (value === null) delete chosen[key]; else chosen[key] = String(value); }
        rev++; res.end(JSON.stringify({ rev, values: chosen, ownerEpoch: epoch, ownerScope: scope })); return;
      }
      if (url.searchParams.get("ownerEpoch") !== epoch) { res.statusCode = 409; res.end('{}'); return; }
      res.end(JSON.stringify({ rev, slots: Object.fromEntries(keys.map(k => [k, !chosen[k] ? { status: "none", id: null } : shared ? { status: "available", id: chosen[k], manifest } : { status: "unavailable", id: chosen[k] }])) }));
    }); return;
  }
  if (path === "/probe/unshare") { shared = false; res.end("ok"); return; }
  if (path !== "/") { res.statusCode = 404; res.end(); return; }
  const attr = JSON.stringify({ rev, values: {}, ownerScope: scope, ownerEpoch: epoch }).replace(/"/g, "&quot;");
  res.setHeader("Content-Type", "text/html");
  res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self' 'nonce-owner-probe'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'");
  res.end(`<!doctype html><html data-prefs="${attr}"><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><link rel=stylesheet href=/assets/tokens.css><link rel=stylesheet href=/assets/app.css><body><main class=panel-body id=app></main><script type=module nonce=owner-probe>
import{html,render}from'/assets/app-html.js';import{setLang}from'/assets/app-i18n.js';import{OwnerEffects}from'/ui/js/settings-owner-effects.js';
const q=new URL(location.href).searchParams;setLang(q.get('lang')||'en',{store:false});document.documentElement.dataset.theme=q.get('dark')==='1'?'dark':'light';
render(html\`<\${OwnerEffects} catalog=\${${JSON.stringify({ canWrite: true, effects: [{ id, manifest }] })}} />\`,document.querySelector('#app'));
</script>`);
});
let browser: any;
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const port = (server.address() as any).port;
  for (const engine of (process.env.PROBE_ENGINES || "chromium,firefox,webkit").split(",")) {
    browser = await pw[engine].launch({ headless: true, env: { HOME: join(scratch, "home"), TMPDIR: join(scratch, "tmp"), PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
    for (const [lang, width, dark, touch, scope] of [["en", 1366, false, false, "person"], ["zh-TW", 390, true, false, "operator"], ["en", 1366, false, true, "person"], ["en", 1366, false, false, "operator"], ["zh-TW", 390, true, false, "person"]] as const) {
      chosen = {}; shared = true; const start = calls.length;
      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: touch, extraHTTPHeaders: { "X-Probe-Scope": scope } }); const page = await context.newPage(), errors: string[] = [], resources: string[] = [], outside: string[] = [];
      page.on("pageerror", (e: Error) => errors.push(e.message));
      await page.route("**/*", (r: any) => { const u = new URL(r.request().url()); resources.push(u.pathname); if (u.hostname === "127.0.0.1" && u.port === String(port)) return r.continue(); outside.push(u.origin); return r.abort(); });
      try {
        await page.goto(`http://127.0.0.1:${port}/?lang=${lang}&dark=${dark ? 1 : 0}`);
        await page.locator('[data-owner-slot="fx.page"]').waitFor(); assert.equal(await page.locator("[data-owner-slot]").count(), 5);
        assert.ok(await page.locator(".s-fx-owner").innerText().then((s: string) => s.includes(scope === "operator" ? lang === "en" ? "Host-wide choices" : "主機共用選擇" : lang === "en" ? "Discord and Telegram accounts stay separate" : "Discord 與 Telegram 帳號各自獨立")));
        await page.locator('[data-owner-slot="fx.page"]').selectOption(id);
        await page.waitForFunction(() => !!document.querySelector('[data-owner-clear="fx.page"]') && !document.querySelector<HTMLSelectElement>('[data-owner-slot="fx.page"]')?.disabled);
        assert.deepEqual(calls.slice(start).find(c => c.path === "/ui/prefs")?.body, { set: { "fx.page": id }, ownerEpoch: epoch });
        await page.evaluate(() => fetch('/probe/unshare')); await page.locator(".s-fx-owner>button").click();
        await page.waitForFunction(() => document.querySelector('.s-fx-owner-row [role=status]')?.textContent?.includes('No longer') || document.querySelector('.s-fx-owner-row [role=status]')?.textContent?.includes('已無法'));
        assert.equal(await page.locator('[data-owner-slot="fx.page"]').inputValue(), id);
        await page.screenshot({ path: join(out, `${engine}-${lang}-${width}${touch ? "-touch" : ""}.png`), fullPage: true });
        await page.locator('[data-owner-clear="fx.page"]').click(); await page.waitForFunction(() => !document.querySelector('[data-owner-clear="fx.page"]'));
        assert.deepEqual(calls.slice(start).filter(c => c.path === "/ui/prefs").at(-1)?.body, { set: { "fx.page": null }, ownerEpoch: epoch });
        const bounds = await page.evaluate(() => ({ coarse: matchMedia("(pointer:coarse)").matches, bodyFont: parseFloat(getComputedStyle(document.body).fontSize), width: innerWidth, scroll: document.documentElement.scrollWidth, frames: document.querySelectorAll('iframe,canvas').length, inline: document.querySelectorAll('[style]').length, fieldFonts: [...document.querySelectorAll('[data-owner-slot]')].map(el => parseFloat(getComputedStyle(el).fontSize)) }));
        assert.ok(bounds.scroll <= bounds.width, JSON.stringify(bounds)); assert.equal(bounds.frames, 0); assert.equal(bounds.inline, 0);
        if (touch) assert.equal(bounds.coarse, true);
        assert.ok(bounds.fieldFonts.every((n: number) => n === (width < 900 || touch ? 16 : bounds.bodyFont)), JSON.stringify(bounds));
        assert.ok(!resources.some(p => /\/ui\/effects\/(?:resource|image)\//.test(p))); assert.deepEqual(errors, []); assert.deepEqual(outside, []);
        rows.push({ engine, lang, width, dark, touch, scope, passed: true, bounds });
      } finally { await context.close(); }
    }
    await browser.close(); browser = null;
  }
} finally {
  await browser?.close(); await new Promise<void>(r => server.close(() => r())); rmSync(scratch, { recursive: true, force: true });
  writeFileSync(join(out, "receipt.json"), JSON.stringify({ scratchRemoved: true, modelsAuthentication: true, noFleet: true, noEffectExecution: true, rows }, null, 2));
}
console.log(JSON.stringify(rows));
