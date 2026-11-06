// A project's Insights (fleet-task-stats.js): per assignee by status (the default), then per priority by size — desk
// dark / light, en / zh-TW, and a phone. Shots + numbers (no CSP violation, no console error, no sideways scroll).
//   REPO=<tree> OUT=<dir> PW_DIR=<dir with playwright-core> [CHROME=<chrome>] npx tsx scripts/manual/smoke/smoke-2246-board-insights.mts
import { join } from "node:path";
import { bootFixture, freshPage, mounted, type MatrixCase } from "../smoke-fixture/index.mts";
const REPO = process.env.REPO!, OUT = process.env.OUT!;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48680) });
const fm = fx.fm;
const NAMES = Object.keys(fm.fleetConfig.instances).filter((n) => n !== "general");
const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");
let n = 0;
const ANN = { kind: "person", name: "Ann" };
function seed(lang: string) {
  fm.scheduler?.db.close();
  fm.scheduler = new Scheduler(join(fm.dataDir, `stats-${++n}.db`), () => {}, DEFAULT_SCHEDULER_CONFIG, (x: string) => !!fm.fleetConfig.instances[x]);
  (fm as any).attachTaskBoard(fm.scheduler.db);
  const b = fm.scheduler.db.board;
  const p = b.createProject(ANN, { name: lang === "zh-TW" ? "排行榜" : "Leaderboard" });
  const pri = ["urgent", "high", "normal", "normal", "low"], size = ["S", "M", "L", null];
  const mains = b.createCards(ANN, { project: p.id, cards: Array.from({ length: 5 }, (_, i) => ({ title: `${lang === "zh-TW" ? "主任務" : "Main task"} ${i + 1}`, assignee: NAMES[i % 3], priority: pri[i], size: size[i % 4] })) }).cards;
  // Sub tasks spread over four instances and every status (the person moves them: one card at a time per instance).
  const st = ["claimed", "blocked", "review", "done", "open"];
  let k = 0;
  for (const m of mains.slice(0, 3)) {
    const subs = b.createCards(ANN, { parent: m.code, cards: Array.from({ length: 4 }, (_, i) => ({ title: `${m.code}.${i + 1}`, assignee: NAMES[(k + i) % 4] ?? null, size: size[(k + i) % 4] })) }).cards;
    for (const s of subs) {
      const to = st[k++ % st.length];
      if (to === "open") continue;
      b.moveCard(ANN, s.code, "claimed");
      if (to === "blocked") b.moveCard(ANN, s.code, "blocked", { reason: "?" });
      if (to === "review" || to === "done") b.moveCard(ANN, s.code, to, { result: "x" });
    }
  }
  return p.id;
}
const shot = (name: string) => join(OUT, `${name}.png`);
const NUMBERS = `(() => ({ csp: (window.__csp || []).length, sideScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
  sum: (document.querySelector("dialog[open] .ts-sum") || {}).textContent || null, rows: document.querySelectorAll("dialog[open] .ts-table tbody tr").length,
  wide: (function () { var t = document.querySelector("dialog[open] .ts-table"), b = document.querySelector("dialog[open] .dlg-body"); return t && b ? t.scrollWidth > b.clientWidth + 1 : null; })() }))()`;
async function report(p: any, label: string) { console.log(label, JSON.stringify(await p.page.evaluate(NUMBERS)), "errors:", p.errors.length ? p.errors : "none"); }
for (const [device, theme, lang] of [["desk", "dark", "en"], ["desk", "light", "zh-TW"], ["phone", "light", "zh-TW"], ["phone", "dark", "en"]] as const) {
  const id = seed(lang);
  const p = await freshPage(fx, { device, theme, lang } as unknown as MatrixCase, { beforeNavigate: (ctx: any) => ctx.addInitScript({ content: `localStorage.setItem("agend_tasks_project", "${id}");` }) });
  await mounted(p.page);
  await p.page.goto(`${fx.base}/ui/fleet`);
  await p.page.waitForSelector(".tb-board-page");
  await p.page.locator(".tb-insights").click();
  await p.page.waitForSelector("dialog[open] .ts-table");
  await p.page.waitForTimeout(400);
  await p.page.screenshot({ path: shot(`${device}-${theme}-${lang}-1-by-assignee`) });
  await report(p, `${device} ${theme} ${lang} by assignee:`);
  const selects = p.page.locator("dialog[open] .ts-choices select");
  await selects.nth(1).selectOption("priority");
  await selects.nth(2).selectOption("size");
  await p.page.waitForTimeout(300);
  await p.page.screenshot({ path: shot(`${device}-${theme}-${lang}-2-priority-by-size`) });
  await report(p, `${device} ${theme} ${lang} priority by size:`);
  await p.ctx.close();
}
await fx.close(); process.exit(0);
