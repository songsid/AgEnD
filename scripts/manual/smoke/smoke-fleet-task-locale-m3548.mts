// Real scratch app/task board; no Fleet start or provider/CLI calls.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootFixture } from '../smoke-fixture/index.mts';
const out = process.env.OUT!; mkdirSync(out, { recursive: true });
const fx = await bootFixture({ port: Number(process.env.HP || 49161), instances: 3, classic: false });
try {
  const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(process.env.REPO! + '/src/scheduler/index.ts');
  const fm = fx.fm;
  fm.scheduler?.db.close();
  fm.scheduler = new Scheduler(join(fm.dataDir, 'example-locale.db'), () => {}, DEFAULT_SCHEDULER_CONFIG, (n: string) => !!fm.fleetConfig.instances[n]);
  fm.attachTaskBoard(fm.scheduler.db);
  const card = fm.scheduler.db.board.createCards({ kind: 'person', name: 'Example owner' }, { cards: [{
    title: '示範任務 Example task', assignee: fx.instances[1]!.name, goal: '示範目標 Example goal', acceptance: ['確認示範文字 Example acceptance'],
  }] }).cards[0];
  const records = [];
  for (const c of [{ device: 'desk', theme: 'dark', lang: 'zh-TW' }, { device: 'phone', theme: 'dark', lang: 'zh-TW' }, { device: 'desk', theme: 'light', lang: 'en' }] as const) {
    const p = await fx.page(c);
    await p.page.emulateMedia({ reducedMotion: 'reduce' });
    const errors: string[] = []; p.page.on('pageerror', (e: Error) => { errors.push(e.message); console.error('pageerror', e.message); });
    await p.page.goto(fx.base + '/ui/fleet/tasks');
    const nav = p.page.locator('.p-fleet nav[data-trust="panel-navigation"]');
    const tasks = nav.locator('a[href="/ui/fleet"]'), teams = nav.locator('a[href="/ui/fleet/teams"]');
    await tasks.waitFor(); await teams.waitFor();
    const labels = [await tasks.innerText(), await teams.innerText()];
    const expected = c.lang === 'zh-TW' ? ['任務', '團隊'] : ['Tasks', 'Teams'];
    if (JSON.stringify(labels) !== JSON.stringify(expected)) throw new Error('Wrong nav labels: ' + JSON.stringify(labels));
    const board = await p.page.evaluate(async () => { const r = await fetch('/ui/tasks/board'); return { status: r.status, data: await r.json() }; });
    if (board.status !== 200 || !board.data.cards?.some((item: any) => item.title === '示範任務 Example task')) throw new Error('Scratch task missing from actual board read');
    await p.page.locator('.tb').waitFor();
    const key = `${c.device}-${c.theme}-${c.lang}`;
    await p.page.screenshot({ path: join(out, `${key}-nav.png`) });
    await p.page.goto(fx.base + '/ui/fleet/tasks?card=' + card.code);
    const footer = p.page.locator('.dlg dd.muted');
    await footer.waitFor(); await footer.scrollIntoViewIfNeeded();
    const text = await footer.innerText();
    if (c.lang === 'zh-TW' && (text.includes('・') || text.split(' · ').length !== 3 || !text.includes('Example owner'))) throw new Error('Wrong footer: ' + text);
    if (c.lang === 'en' && !text.includes('Opened by Example owner')) throw new Error('English footer changed: ' + text);
    await p.page.screenshot({ path: join(out, `${key}-footer.png`) });
    const overflow = await p.page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow || errors.length || (await p.csp()).length) throw new Error(JSON.stringify({ overflow, errors, csp: await p.csp() }));
    records.push({ ...c, labels, footer: text, horizontalOverflow: overflow, pageErrors: errors, csp: await p.csp() });
    await p.ctx.close();
  }
  writeFileSync(join(out, 'capture.json'), JSON.stringify({ source: process.env.CAPTURE_SOURCE, records }, null, 2) + '\n');
  console.log(JSON.stringify(records));
} finally { await fx.close(); }
