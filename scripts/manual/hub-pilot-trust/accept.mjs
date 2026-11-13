/** One serial Chromium: production Fleet connection card/modules/CSS; API responses are local UI fixtures. */
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const repo = process.cwd(), out = resolve(process.env.OUT ?? '.artifacts/pilot-trust/browser');
const pw = createRequire(resolve(process.env.PW_DIR) + '/')('playwright-core');
mkdirSync(out, { recursive: true });
const fingerprint = '1234567890abcdef'.repeat(4), previous = 'abcdef1234567890'.repeat(4);
let mode = 'first', setting = true, browser;
const checks = [], images = [], errors = [];
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const json = body => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
  if (path === '/api/settings/hub/pilot-trust') return json({ ok: true, enabled: setting });
  if (path === '/api/settings/hub/membership') return json({ ok: true, enabled: false, connectionCardV1: true, pairing: { state: 'unpaired' } });
  if (path.endsWith('/probe')) return json(mode === 'trusted' ? { ok: true, companyJoin: true, hubName: 'Team Hub', identity: 'known', separateHosts: true, suggestedLabel: 'Design Fleet', features: [], pilotTrusted: true }
    : mode === 'chain' ? { ok: false, reason: 'certificate' } : { ok: false, reason: 'certificate', selfSigned: true,
      ...(setting ? { trust: { fingerprint, previous: mode === 'changed' ? previous : null, expiresAt: Date.now() + 86400_000 } } : {}) });
  if (path.startsWith('/api/')) return json({ ok: true, operation: null, bound: false });
  if (path === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(`import { h, render } from '/assets/app-html.js';import {setLang} from '/assets/app-i18n.js';import {HubConnectionSettings} from '/ui/js/settings-hub-connection.js';setLang(new URL(location.href).searchParams.get('lang'),{store:false});render(h(HubConnectionSettings),document.getElementById('root'));`); }
  if (path === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); return res.end('main{max-width:720px;margin:32px auto;padding:16px}.hub-pilot-trust-setting{margin-top:16px}@media(max-width:600px){main{margin:0;padding:16px}}'); }
  if (path.startsWith('/assets/') || path.startsWith('/ui/js/')) {
    const name = path.split('/').pop(); if (!/^[a-z0-9_.-]+$/.test(name)) { res.writeHead(400); return res.end(); }
    const base = path.startsWith('/assets/') ? 'src/ui/shared' : 'src/ui';
    try { const bytes = readFileSync(join(repo, base, name)); res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'font/woff2'); return res.end(bytes); }
    catch { res.writeHead(404); return res.end(); }
  }
  res.setHeader('Content-Security-Policy', "default-src 'self';script-src 'self';style-src 'self';img-src 'self' data:;font-src 'self';connect-src 'self'");
  res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/tokens.css"><link rel="stylesheet" href="/assets/app.css"><link rel="stylesheet" href="/fixture.css"></head><body><main class="p-settings s-hub-section" id="root"></main><script type="module" src="/fixture.js"></script></body></html>');
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch({ executablePath: process.env.CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  for (const lang of ['en', 'zh-TW']) for (const phone of [false, true]) {
    const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 900 }, colorScheme: phone ? 'dark' : 'light' });
    const page = await ctx.newPage(); page.on('pageerror', error => errors.push(error.message));
    for (const state of ['first', 'changed', 'off', 'trusted']) {
      mode = state; setting = state !== 'off';
      await page.goto(origin + '/settings/hub?lang=' + lang);
      await page.locator('#hubCompanyAddress').fill('hub.example.test ABCD-EFGH');
      await page.locator('#hubCompanyAddress').blur();
      if (state === 'first' || state === 'changed') await page.locator('.hub-pilot-trust').waitFor();
      else await page.getByText(state === 'off' ? lang === 'en' ? "hub.example.test uses a self-signed certificate, and this AgEnD doesn't allow trusting one. Ask the Hub administrator for a trusted certificate." : 'hub.example.test 用的是自簽憑證，這台 AgEnD 不允許信任它。請 Hub 管理員換上受信任的憑證。' : lang === 'en' ? "You trusted this Hub's self-signed certificate (for testing)." : '已信任這個 Hub 的自簽憑證（測試用）。').waitFor();
      if (state === 'first') await page.getByRole('button', { name: lang === 'en' ? 'Show the full fingerprint' : '顯示完整指紋' }).click();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      if (overflow) throw Error('Horizontal overflow: ' + [lang, phone, state].join('/'));
      const file = `${lang}-${phone ? 'phone' : 'desktop'}-${state}.png`;
      await page.screenshot({ path: join(out, file), fullPage: true }); images.push(file); checks.push({ lang, phone, state, overflow });
    }
    await ctx.close();
  }
  if (errors.length) throw Error(errors.join('\n'));
  writeFileSync(join(out, 'receipt.json'), JSON.stringify({ source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), browser: browser.version(), boundary: 'Production Fleet connection card, modules and CSS on a loopback fixture shell. API DTO fixtures; no real Fleet/browser sign-in, directory or packaged-runtime claim.', checks, images, errors }, null, 2) + '\n');
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
