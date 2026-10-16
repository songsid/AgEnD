/** Scratch HTTP + actual Settings module/styles. No fleet, account, preview listener, or effect execution.
 * PW_DIR points to private Playwright tools. PROBE_ENGINES defaults to Chromium/Firefox/Linux WebKit (not Safari).
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
if (!process.env.PW_DIR) throw Error("Set PW_DIR to private Playwright tools");
const pw = createRequire(join(resolve(process.env.PW_DIR), "package.json"))("playwright");
const out = resolve(process.env.OUT_DIR || ".artifacts/settings-native"); mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(out, "private-")); mkdirSync(join(scratch, "home")); mkdirSync(join(scratch, "tmp"));
const id = "a".repeat(32), calls: Array<{ path: string; body: any }> = [], rows: any[] = [];
const manifest = { v: 1, runtime: "canvas-worker-v1", worker: "worker.js", name: "snow", title: "Snow", regions: ["chat"], layer: "behind", wants: [], params: { count: { type: "int", min: 0, max: 10, default: 2 } } };
const files = join(scratch, "snow"); mkdirSync(files); writeFileSync(join(files, "effect.json"), JSON.stringify(manifest)); writeFileSync(join(files, "worker.js"), "throw Error('must never execute in Settings')");
const server = createServer((req, res) => {
  const path = (req.url || "").split("?")[0];
  if (/^\/assets\/[a-z0-9._-]+$/.test(path) || /^\/ui\/js\/[a-z0-9_-]+\.js$/.test(path)) {
    const name = path.split("/").at(-1)!;
    try { res.setHeader("Content-Type", name.endsWith(".css") ? "text/css" : "text/javascript"); res.end(readFileSync(join("src/ui", path.startsWith("/assets/") ? "shared" : "", name))); }
    catch { res.statusCode = 404; res.end(); } return;
  }
  if (path.startsWith("/ui/effects")) {
    const chunks: Buffer[] = []; req.on("data", c => chunks.push(c)); req.on("end", () => {
      const text = Buffer.concat(chunks).toString(), body = text ? JSON.parse(text) : null;
      if (req.method !== "GET") calls.push({ path, body });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(path === "/ui/effects" ? { canWrite: true, effects: [{ id, manifest, bytes: 400, ownClaim: true, sharedByYou: false, profiles: { status: "unmeasured", records: [] } }] } : { ok: true, status: "unmeasured", records: [] }));
    }); return;
  }
  res.setHeader("Content-Type", "text/html");
  res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self' 'nonce-settings-probe'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'");
  res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><link rel=stylesheet href=/assets/tokens.css><link rel=stylesheet href=/assets/app.css><body><main class=panel-body id=app></main><script type=module nonce=settings-probe>
import {html,render} from '/assets/app-html.js';import{setLang}from'/assets/app-i18n.js';import{appStore}from'/assets/app-store.js';import{EffectsCard}from'/ui/js/settings-effects.js';
const q=new URL(location.href).searchParams;setLang(q.get('lang')||'en',{store:false});document.documentElement.dataset.theme=q.get('dark')==='1'?'dark':'light';appStore.set({ready:true,instances:[{name:'worker'}]});render(html\`<\${EffectsCard} />\`,document.querySelector('#app'));
</script>`);
});
let browser: any;
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const port = (server.address() as any).port;
  for (const engine of (process.env.PROBE_ENGINES || "chromium,firefox,webkit").split(",")) {
    browser = await pw[engine].launch({ headless: true, env: { HOME: join(scratch, "home"), TMPDIR: join(scratch, "tmp"), PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
    for (const [lang, width, dark, touch] of [["en", 1366, false, false], ["zh-TW", 390, true, false], ["en", 1366, false, true]] as const) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: touch }), page = await context.newPage(), errors: string[] = [], outside: string[] = [], resources: string[] = [];
      page.on("pageerror", (e: Error) => errors.push(e.message));
      await page.route("**/*", (r: any) => { const u = new URL(r.request().url()); resources.push(u.pathname); if (u.hostname === "127.0.0.1" && u.port === String(port)) return r.continue(); outside.push(u.origin); return r.abort(); });
      const start = calls.length;
      try {
        await page.goto(`http://127.0.0.1:${port}/?lang=${lang}&dark=${dark ? 1 : 0}`);
        await page.locator(".s-fx-item").waitFor();
        assert.equal(await page.locator(".s-fx-choose").innerText(), lang === "en" ? "Upload an effect folder" : "上傳效果資料夾");
        await page.locator(".s-fx-upload").setInputFiles(files);
        await page.waitForFunction(() => document.querySelector('.s-effects [role=status]')?.textContent?.includes('Saved') || document.querySelector('.s-effects [role=status]')?.textContent?.includes('已儲存'));
        const upload = calls.slice(start).find(c => c.path === "/ui/effects/upload"); assert.ok(upload); assert.equal(upload.body.length, 2);
        assert.equal(Buffer.from(upload.body.find((f: any) => f.path === "worker.js").data_b64, "base64").toString(), "throw Error('must never execute in Settings')");
        await page.locator(".s-fx-target").selectOption("worker"); await page.locator('[data-param="count"]').fill("3");
        await page.locator(".s-fx-apply").click(); await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.s-fx-apply')?.disabled);
        assert.deepEqual(calls.slice(start).find(c => c.path === "/ui/effects/apply")?.body, { instance: "worker", id, params: { count: 3 } });
        const bounds = await page.evaluate(() => ({ coarse: matchMedia("(pointer:coarse)").matches, bodyFont: parseFloat(getComputedStyle(document.body).fontSize), width: innerWidth, scroll: document.documentElement.scrollWidth, frames: document.querySelectorAll('iframe').length, inline: document.querySelectorAll('[style]').length, fieldFonts: [...document.querySelectorAll('.s-fx-target,.s-fx-params input:not([type=checkbox]),.s-fx-params select')].map(el => parseFloat(getComputedStyle(el).fontSize)) }));
        assert.ok(bounds.scroll <= bounds.width, JSON.stringify(bounds)); assert.equal(bounds.frames, 0); assert.equal(bounds.inline, 0);
        if (touch) assert.equal(bounds.coarse, true);
        if (width < 900 || bounds.coarse) assert.ok(bounds.fieldFonts.every((size: number) => size >= 16), JSON.stringify(bounds.fieldFonts));
        else assert.ok(bounds.fieldFonts.every((size: number) => size === bounds.bodyFont), JSON.stringify(bounds));
        assert.ok(!resources.some(p => p.startsWith("/ui/effects/resource/"))); assert.deepEqual(errors, []); assert.deepEqual(outside, []);
        await page.screenshot({ path: join(out, `${engine}-${lang}-${width}${touch ? "-touch" : ""}.png`), fullPage: true });
        rows.push({ engine, lang, width, dark, touch, passed: true, uploadFiles: upload.body.map((f: any) => f.path), bounds });
      } finally { await context.close(); }
    }
    await browser.close(); browser = null;
  }
} finally {
  await browser?.close(); await new Promise<void>(r => server.close(() => r())); rmSync(scratch, { recursive: true, force: true });
  writeFileSync(join(out, "receipt.json"), JSON.stringify({ scratchRemoved: true, modelsAuthentication: true, noFleet: true, noEffectExecution: true, rows }, null, 2));
}
console.log(JSON.stringify(rows));
