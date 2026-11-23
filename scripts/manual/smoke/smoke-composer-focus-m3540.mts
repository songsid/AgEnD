// Actual app, scratch FleetManager, synthetic roster. Never sends or starts an agent.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootFixture } from '../smoke-fixture/index.mts';
const fx = await bootFixture({ port: Number(process.env.HP || 49121), instances: 2, classic: false });
const results: unknown[] = [];
try {
  const out = process.env.OUT!; mkdirSync(out, { recursive: true });
  for (const device of ['desk', 'phone'] as const) {
    const p = await fx.page({ device, theme: 'dark', lang: 'zh-TW' }, { path: '/ui/chat/general' });
    await p.page.locator('#msgIn').waitFor();
    const errors: string[] = []; p.page.on('pageerror', (e: Error) => errors.push(e.message));
    let sends = 0; p.page.on('request', (r: any) => { if (r.method() === 'POST' && /\/ui\/send\b/.test(r.url())) sends++; });
    const points = await p.page.evaluate(() => {
      const t = document.querySelector('#msgIn')!.getBoundingClientRect(), c = document.querySelector('.composer')!.getBoundingClientRect();
      return [{ name: 'top', x: t.x + 6, y: c.y + 2 }, { name: 'left', x: c.x + 2, y: t.y + 12 }, { name: 'bottom', x: t.x + 6, y: c.bottom - 2 }];
    });
    const probes = [];
    for (const point of points) {
      await p.page.locator('#msgIn').fill(''); await p.page.locator('#msgIn').blur();
      if (device === 'phone') await p.page.touchscreen.tap(point.x, point.y);
      else await p.page.mouse.dblclick(point.x, point.y);
      const focus = await p.page.evaluate(() => ({ real: document.activeElement?.id === 'msgIn', selection: getSelection()?.toString() || '' }));
      await p.page.keyboard.type('Edge focus works');
      const value = await p.page.locator('#msgIn').inputValue();
      if (!focus.real || focus.selection || value !== 'Edge focus works') throw new Error(JSON.stringify({ device, point, focus, value }));
      probes.push({ point: point.name, ...focus, value });
    }
    await p.page.screenshot({ path: join(out, `${device}-dark-zh-TW-typed.png`) });
    await p.page.locator('#msgIn').fill('');
    const first = points[0];
    if (device === 'phone') await p.page.touchscreen.tap(first.x, first.y); else await p.page.mouse.dblclick(first.x, first.y);
    await p.page.screenshot({ path: join(out, `${device}-dark-zh-TW-empty.png`) });
    // Textarea selection remains native, and Attach still owns its action.
    await p.page.locator('#msgIn').fill('Select real text');
    const selection = await p.page.locator('#msgIn').evaluate((e: HTMLTextAreaElement) => { e.focus(); e.setSelectionRange(0, 6); return e.value.slice(e.selectionStart, e.selectionEnd); });
    const chooser = p.page.waitForEvent('filechooser'); await p.page.locator('#attachBtn').click(); await chooser;
    const csp = await p.csp(); const overflow = await p.page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (selection !== 'Select' || csp.length || overflow || errors.length || sends) throw new Error(JSON.stringify({ selection, csp, overflow, errors, sends }));
    results.push({ device, probes, selection, attach: 'filechooser', csp, overflow, errors, sends });
    await p.ctx.close();
  }
  writeFileSync(join(out, 'capture.json'), JSON.stringify({ source: process.env.CAPTURE_SOURCE, cases: results }, null, 2) + '\n');
} finally { await fx.close(); }
