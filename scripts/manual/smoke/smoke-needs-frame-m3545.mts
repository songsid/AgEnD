// Real web app on a scratch FleetManager/task board; no agent or provider starts.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootFixture } from '../smoke-fixture/index.mts';
const phase = process.env.PHASE;
if (phase !== 'before' && phase !== 'after') throw new Error('PHASE must be before or after');
const out = process.env.OUT!; mkdirSync(out, { recursive: true });
const fx = await bootFixture({ port: Number(process.env.HP || 49141), instances: 3, classic: false });
try {
  const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(process.env.REPO! + '/src/scheduler/index.ts');
  const { deriveNeedsYou } = await import(process.env.REPO! + '/src/needs-you.ts');
  const fm = fx.fm, agent = fx.instances[1]!.name;
  fm.scheduler?.db.close();
  fm.scheduler = new Scheduler(join(fm.dataDir, 'example-frame.db'), () => {}, DEFAULT_SCHEDULER_CONFIG, (n: string) => !!fm.fleetConfig.instances[n]);
  fm.attachTaskBoard(fm.scheduler.db);
  const board = fm.scheduler.db.board, person = { kind: 'person', name: 'Example owner' }, caller = { kind: 'instance', name: agent };
  const [review, blocked] = board.createCards(person, { cards: [
    { title: '示範待確認項目 Example review', assignee: agent, acceptance: ['示範驗收項目'] },
    { title: '示範問題 Example question', assignee: agent },
  ] }).cards;
  board.moveCard(caller, review.code, 'claimed'); board.moveCard(person, review.code, 'review');
  board.moveCard(caller, blocked.code, 'claimed'); board.moveCard(caller, blocked.code, 'blocked', { reason: '示範問題：要採用哪個範例？' });
  fm.needsYouItems = () => deriveNeedsYou({ prompts: [], instances: [], deliveries: [], tasks: fm.needsYouTasks(), ownerOf: () => undefined });
  const records: any[] = [];
  for (const width of [1366, 1920, 390]) {
    const device = width === 390 ? 'phone' : 'desk';
    const p = await fx.page({ device, theme: 'dark', lang: 'zh-TW' });
    await p.page.setViewportSize({ width, height: device === 'phone' ? 844 : 900 });
    await p.page.emulateMedia({ reducedMotion: 'reduce' });
    const errors: string[] = []; p.page.on('pageerror', (e: Error) => errors.push(e.message));
    const routes = phase === 'before' && device === 'desk' ? [
      ['needs', '/ui/needs'], ['settings', '/ui/settings/agents'], ['fleet', '/ui/fleet/tasks'],
    ] : [['needs', '/ui/needs']];
    for (const [name, path] of routes) {
      await p.page.goto(fx.base + path);
      await p.page.locator(`.p-${name === 'settings' ? 'settings' : name === 'fleet' ? 'fleet' : 'needs'} > .panel-body > .col`).waitFor();
      if (name === 'needs') await p.page.locator('.n-item').first().waitFor();
      if (name === 'settings') await p.page.locator('[data-settings-section="agents"] .s-group').first().waitFor();
      const frame = await p.page.evaluate(() => {
        const body = document.querySelector('.panel:not([hidden]) > .panel-body') || document.querySelector('.panel-body');
        const col = body!.querySelector(':scope > .col')!;
        const b = body!.getBoundingClientRect(), c = col.getBoundingClientRect(), style = getComputedStyle(col);
        return { pane: { x: b.x, y: b.y, width: b.width, height: b.height }, col: { x: c.x, y: c.y, width: c.width, height: c.height }, left: c.left - b.left, right: b.right - c.right,
          padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft], margin: [style.marginLeft, style.marginRight], maxWidth: style.maxWidth,
          overflow: document.documentElement.scrollWidth > innerWidth, items: document.querySelectorAll('.p-needs .n-item').length };
      });
      if (frame.overflow) throw new Error('Horizontal overflow: ' + JSON.stringify({ width, name, frame }));
      if (device === 'desk' && (name !== 'needs' || phase === 'after') && Math.abs(frame.left - frame.right) > 2) throw new Error('Not centered: ' + JSON.stringify({ width, name, frame }));
      if (phase === 'before' && device === 'desk' && name === 'needs' && frame.right - frame.left < 200) throw new Error('Baseline did not reproduce left alignment');
      records.push({ width, device, page: name, ...frame });
      await p.page.screenshot({ path: join(out, `${phase}-${width}-${name}-dark-zh-TW.png`) });
    }
    if (errors.length || (await p.csp()).length) throw new Error(JSON.stringify({ errors, csp: await p.csp() }));
    await p.ctx.close();
  }
  if (phase === 'after') {
    const before = JSON.parse(readFileSync(join(out, 'before.json'), 'utf8')).frames.find((f: any) => f.width === 390);
    const after = records.find(f => f.width === 390);
    for (const key of ['col', 'padding', 'margin', 'maxWidth']) if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) throw new Error('Phone changed: ' + key + JSON.stringify({ before: before[key], after: after[key] }));
  }
  writeFileSync(join(out, `${phase}.json`), JSON.stringify({ phase, source: process.env.CAPTURE_SOURCE, frames: records }, null, 2) + '\n');
  console.log(JSON.stringify(records.map(({ width, page, left, right, col }) => ({ width, page, left, right, col })), null, 2));
} finally { await fx.close(); }
