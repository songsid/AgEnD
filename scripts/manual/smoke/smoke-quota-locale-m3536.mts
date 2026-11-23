// Scratch web server and synthetic roster only; no agent or provider is started.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootFixture } from '../smoke-fixture/index.mts';
const fx = await bootFixture({ port: Number(process.env.HP || 49081), instances: 2, classic: false });
try {
  const p = await fx.page({ device: 'desk', theme: 'light', lang: 'zh-TW' }, { path: '/settings/notifications' });
  await p.page.locator('[data-quota-effective]').waitFor();
  const summary = await p.page.locator('[data-quota-effective]').textContent();
  if (summary !== '目前生效：開啟 · 10% · 每週') throw new Error(`Unexpected summary: ${summary}`);
  await p.page.locator('#quota-notices').scrollIntoViewIfNeeded();
  const overflow = await p.page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  if (overflow || (await p.csp()).length) throw new Error('Overflow or CSP violation');
  const out = process.env.OUT!; mkdirSync(out, { recursive: true });
  await p.page.screenshot({ path: join(out, 'desk-light-zh-TW.png') });
  writeFileSync(join(out, 'capture.json'), JSON.stringify({ summary, overflow, csp: await p.csp(), source: process.env.CAPTURE_SOURCE }, null, 2) + '\n');
  await p.ctx.close();
} finally { await fx.close(); }
