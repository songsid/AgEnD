/** Own scratch listeners and browsers only. Build first; PW_DIR and PLAYWRIGHT_BROWSERS_PATH point to private tools.
 * PROBE_ENGINES=chromium,firefox,webkit OUT_DIR=<own scratch> node scripts/manual/effect-frame-1629.mts
 * WebKit may run in the pinned Playwright container; Linux WebKit is not a real-Safari claim.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
// @ts-ignore built production helper; recipe runs after npm run build.
import { createPreviewListener } from '../../dist/web-preview.js';
if (!process.env.PW_DIR) throw Error('Set PW_DIR to an isolated Playwright prefix');
const pw = createRequire(join(resolve(process.env.PW_DIR), 'package.json'))('playwright');
const out = resolve(process.env.OUT_DIR || '.artifacts/frame-native'); mkdirSync(out, { recursive: true });
const privateDir = mkdtempSync(join(out, 'private-')); mkdirSync(join(privateDir, 'home')); mkdirSync(join(privateDir, 'tmp'));
const boot = 'b'.repeat(32), receipts = []; let preview, browser, outside = [];
const normal = `globalThis.TEST={keys:[]};for(const k of ['keydown','input','paste','compositionstart'])addEventListener(k,()=>TEST.keys.push(k));const x=agend.canvas.getContext('2d');x.fillStyle='#ff0000';x.fillRect(0,0,64,64);agend.on('state',()=>{x.fillStyle='#00ff00';x.fillRect(0,0,64,64)});postMessage({type:'focus'});postMessage({type:'frame-time',ms:0});agend.ready();agend.ready();`;
const literal = v => JSON.stringify(v).replace(/</g, '\\u003c');
const server = createServer((req, res) => {
  if (['/effect-frame.js', '/effect-policy.js'].includes(req.url)) {
    res.setHeader('Content-Type', 'text/javascript'); res.end(readFileSync(resolve('src/ui/shared', req.url.slice(1)))); return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><style>.agend-effect-frame{width:64px;height:64px;border:0;pointer-events:none}</style><input id=trusted><div id=root></div><script type=module>
import {createEffectFrame} from '/effect-frame.js';
window.R={ready:0,removed:[]};window.start=kind=>{const code=kind==='startup-hang'?'while(true){}':kind==='after-ready-hang'?'agend.ready();while(true){}':${literal(normal)};
window.FX=createEffectFrame({window,root:document.querySelector('#root'),origin:${literal('http://127.0.0.1:' + preview?.settings.port)},boot:${literal(boot)},render:{code,params:{},instance:'own',width:64,height:64,dpr:1,assets:[],wants:['state']},onReady:()=>R.ready++,onRemove:reason=>R.removed.push(reason)});};window.BOOT=${literal(boot)};
</script>`);
});
const listen = async s => { s.listen(0, '127.0.0.1'); await once(s, 'listening'); return s.address().port; };
try {
  const port = await listen(server);
  preview = createPreviewListener({ settings: { enabled: true, port: 0, origin: null }, healthPort: port, config: {}, bootId: boot }); await listen(preview.server);
  for (const engine of (process.env.PROBE_ENGINES || 'chromium,firefox,webkit').split(',')) {
    browser = await pw[engine].launch({ headless: true, env: { HOME: join(privateDir, 'home'), TMPDIR: join(privateDir, 'tmp'), PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
    for (const kind of (process.env.PROBE_KINDS || 'normal,location,form,meta,startup-hang,after-ready-hang').split(',')) {
      const context = await browser.newContext(), page = await context.newPage(), errors = []; outside = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => { const u = new URL(route.request().url()); if (['blob:', 'data:'].includes(u.protocol) || u.hostname === '127.0.0.1' && [String(port), String(preview.settings.port)].includes(u.port)) return route.continue(); outside.push(u.origin); return route.abort(); });
      const started = Date.now(); console.log('START', engine, kind);
      try {
        await page.goto(`http://127.0.0.1:${port}/`); await page.waitForFunction(() => typeof window.start === 'function');
        const born = page.waitForEvent('worker', { timeout: 10000 }); await page.evaluate(kind => start(kind), kind); const worker = await born;
        if (kind === 'startup-hang') {
          await worker.waitForEvent('close', { timeout: 15000 });
          assert.deepEqual(await page.evaluate(() => R), { ready: 0, removed: ['startup_timeout'] });
          assert.equal(await page.locator('iframe').count(), 0); assert.ok(Date.now() - started >= 9900);
        } else {
          await page.waitForFunction(() => R.ready === 1, undefined, { timeout: 10000 });
          assert.deepEqual(await page.evaluate(() => FX.state()), { ready: true, removed: false, loads: 1 });
          const frame = page.frames().find(f => f.url().endsWith('/effect')); assert.ok(frame);
          assert.equal(await frame.evaluate(() => self.origin), 'null');
          const closed = worker.waitForEvent('close', { timeout: 5000 }).then(() => true, error => error.message);
          if (kind === 'normal') {
            await frame.evaluate(() => { for (const data of [{ type: 'focus' }, { type: 'ready' }, { v: 1, type: 'ready', ch: null, boot: 'b'.repeat(32) }]) parent.postMessage(data, '*'); });
            assert.equal(await page.evaluate(() => FX.send({ v: 1, type: 'state', ts: performance.now(), state: 'working', instance: 'other' })), false);
            assert.equal(await page.evaluate(() => FX.send({ v: 1, type: 'state', ts: performance.now(), state: 'working', instance: 'own' })), true);
            for (let i = 0; i < 50; i++) { if (await worker.evaluate(() => agend.canvas.getContext('2d').getImageData(0, 0, 1, 1).data[1] === 255)) break; await page.waitForTimeout(20); }
            assert.equal(await worker.evaluate(() => agend.canvas.getContext('2d').getImageData(0, 0, 1, 1).data[1]), 255);
            assert.deepEqual(await worker.evaluate(() => ({ document: typeof document, keys: TEST.keys })), { document: 'undefined', keys: [] });
            assert.deepEqual(await page.evaluate(() => R), { ready: 1, removed: [] }); await page.evaluate(() => FX.remove('host_pause'));
          } else if (kind === 'after-ready-hang') await page.evaluate(() => FX.remove('host_pause'));
          else { await frame.evaluate(kind => {
            if (kind === 'location') location.href = '/effect';
            if (kind === 'form') { const f = document.createElement('form'); f.action = '/effect'; f.method = 'get'; document.body.append(f); f.submit(); }
            if (kind === 'meta') { const m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=/effect'; document.head.append(m); }
          }, kind).catch(error => { if (!/destroyed|detached|closed/.test(error.message)) throw error; });
            if (kind === 'form') { await page.waitForTimeout(150); assert.deepEqual(await page.evaluate(() => FX.state()), { ready: true, removed: false, loads: 1 }); await page.evaluate(() => FX.remove('host_pause')); }
          }
          assert.equal(await closed, true); await page.waitForFunction(() => R.removed.length === 1);
          assert.deepEqual(await page.evaluate(() => R.removed), [['normal', 'after-ready-hang', 'form'].includes(kind) ? 'host_pause' : 'navigation']);
          assert.equal(await page.locator('iframe').count(), 0);
        }
        assert.deepEqual(outside, []); assert.deepEqual(errors, []);
        console.log('PASS', engine, kind); receipts.push({ engine, version: browser.version(), kind, status: 'pass', elapsedMs: Date.now() - started, workerClosed: true });
      } catch (error) { console.log('FAIL', engine, kind, error.message); let observation; try { observation = await page.evaluate(() => ({ state: window.FX?.state(), result: window.R })); } catch {} receipts.push({ engine, version: browser.version(), kind, status: 'failed', error: error.message, observation, frames: page.frames().map(f => f.url()), errors, outside }); }
      finally { await context.close(); }
    }
    await browser.close(); browser = null;
  }
} finally {
  if (browser) await browser.close(); for (const s of [preview?.server, server]) if (s?.listening) { s.closeAllConnections(); s.close(); await once(s, 'close'); }
  writeFileSync(join(out, 'receipt.json'), JSON.stringify({ receipts, passed: receipts.filter(r => r.status === 'pass').length, failed: receipts.filter(r => r.status !== 'pass').length }, null, 2));
  rmSync(privateDir, { recursive: true, force: true });
}
if (receipts.some(r => r.status !== 'pass')) process.exitCode = 1;
