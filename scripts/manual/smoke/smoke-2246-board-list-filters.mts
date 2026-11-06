// The task board's list and filters (fleet-task-view.js): the Filter and Display menus, the chips, the list grouped by
// status and by assignee with sub tasks as rows, a link that opens a filtered board — desk dark / light, en / zh-TW, and
// a phone's list. Shots + numbers (no CSP violation, no console error, no sideways scroll).
//   REPO=<tree> OUT=<dir> PW_DIR=<dir with playwright-core> [CHROME=<chrome>] npx tsx scripts/manual/smoke/smoke-2246-board-list-filters.mts
import { join } from "node:path";
import { bootFixture, freshPage, mounted, type MatrixCase } from "../smoke-fixture/index.mts";
const REPO = process.env.REPO!, OUT = process.env.OUT!;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48640) });
const fm = fx.fm;
const NAMES = Object.keys(fm.fleetConfig.instances).filter((n) => n !== "general");
const [A, B, C] = [NAMES[0]!, NAMES[1]!, NAMES[NAMES.length - 1]!];   // a Latin name, another, a CJK one
const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");
let n = 0;
const ANN = { kind: "person", name: "Ann" };
function seed(lang: string) {
  fm.scheduler?.db.close();
  fm.scheduler = new Scheduler(join(fm.dataDir, `list-${++n}.db`), () => {}, DEFAULT_SCHEDULER_CONFIG, (x: string) => !!fm.fleetConfig.instances[x]);
  (fm as any).attachTaskBoard(fm.scheduler.db);
  const b = fm.scheduler.db.board;
  const zh = lang === "zh-TW";
  // The person moves them (an instance has one card in progress at a time).
  const p = b.createProject(ANN, { name: zh ? "排行榜" : "Leaderboard" });
  const T = (en: string, tw: string) => (zh ? tw : en);
  const mains = b.createCards(ANN, { project: p.id, cards: [
    { title: T("Serve the weekly leaderboard", "提供每週排行榜"), assignee: A, priority: "high", size: "M", acceptance: [T("Top 100 by score", "依分數前 100 名"), T("Ties by time", "同分比時間")] },
    { title: T("Add the shop", "加入商店"), assignee: B, priority: "low", size: "L" },
    { title: T("Choose the season badge", "選賽季徽章"), assignee: null, priority: "urgent" },
    { title: T("Anti-cheat review", "防作弊檢查"), assignee: C, size: "S" },
    { title: T("Bootstrap the service", "建立服務骨架"), assignee: A, needsReview: false },
  ] }).cards;
  b.moveCard(ANN, mains[0].code, "claimed");
  const subs = b.createCards({ kind: "instance", name: B }, { parent: mains[1].code, cards: [
    { title: T("Price list", "價目表"), assignee: A }, { title: T("Checkout page", "結帳頁"), assignee: B }, { title: T("Receipts", "收據"), assignee: C },
  ] }).cards;
  b.moveCard(ANN, subs[0].code, "claimed");
  b.moveCard(ANN, subs[0].code, "blocked", { reason: T("Which currency: coins or gems?", "用哪種貨幣：金幣還是寶石？") });
  b.moveCard(ANN, subs[1].code, "claimed");
  b.moveCard(ANN, mains[3].code, "claimed");
  b.moveCard(ANN, mains[3].code, "review", { result: T("rules in anticheat.ts", "規則在 anticheat.ts") });
  b.moveCard(ANN, mains[4].code, "claimed");
  b.moveCard(ANN, mains[4].code, "done", { result: "src/server.ts" });
  return p.id;
}
const shot = (name: string) => join(OUT, `${name}.png`);
const NUMBERS = `(() => ({ csp: (window.__csp || []).length, sideScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
  chips: Array.prototype.map.call(document.querySelectorAll(".tb-chip"), function (c) { return c.textContent; }).join(" | "),
  rows: document.querySelectorAll(".tb-row").length, tiles: document.querySelectorAll(".tb-tile").length,
  groups: Array.prototype.map.call(document.querySelectorAll(".tb-group-head"), function (g) { return g.textContent; }).join(" | "), address: location.search }))()`;
async function report(p: any, label: string) { console.log(label, JSON.stringify(await p.page.evaluate(NUMBERS)), "errors:", p.errors.length ? p.errors : "none"); }
async function openMenu(page: any, menu: string) { await page.locator(`${menu} > button`).click(); await page.waitForSelector(`${menu} .menu-list`); }
async function choose(page: any, menu: string, label: string) {
  if (!(await page.locator(`${menu} .menu-list`).count())) await openMenu(page, menu);
  await page.locator(`${menu} .menu-list button`, { hasText: label }).first().click();
  await page.waitForTimeout(250);
}
async function openBoard(c: MatrixCase, projectId: number, storage: Record<string, string> = {}) {
  const kept = { agend_tasks_project: String(projectId), ...storage };
  const p = await freshPage(fx, c, { beforeNavigate: (ctx: any) => ctx.addInitScript({ content: Object.entries(kept).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join(" ") }) });
  await mounted(p.page);
  await p.page.goto(`${fx.base}/ui/fleet`);
  await p.page.waitForSelector(".tb-board-page");
  return p;
}

for (const [theme, lang] of [["dark", "en"], ["light", "zh-TW"]] as const) {
  const id = seed(lang);
  const zh = lang === "zh-TW";
  const c = { device: "desk", theme, lang } as unknown as MatrixCase;
  // 1. The Filter menu, then two chips on the board.
  let p = await openBoard(c, id);
  await openMenu(p.page, ".tb-filter-menu");
  await p.page.screenshot({ path: shot(`desk-${theme}-${lang}-1-filter-menu`) });
  await choose(p.page, ".tb-filter-menu", A);
  await choose(p.page, ".tb-filter-menu", zh ? "低" : "Low");
  await p.page.keyboard.press("Escape");
  await p.page.locator(".tb-chip").nth(1).locator(".tb-chip-op").click();   // priority is not Low
  await p.page.waitForTimeout(300);
  await p.page.screenshot({ path: shot(`desk-${theme}-${lang}-2-board-filtered`) });
  await report(p, `desk ${theme} ${lang} board filtered:`);
  const link = p.page.url();
  await p.ctx.close();
  // 2. The link opens the same filtered board on a fresh page (nothing remembered there).
  p = await freshPage(fx, c);
  await mounted(p.page);
  await p.page.goto(link);
  await p.page.waitForSelector(".tb-chip");
  await report(p, `desk ${theme} ${lang} the link ${new URL(link).search}:`);
  await p.ctx.close();
  // 3. Display: the list, grouped by status; then by assignee with sub tasks as rows.
  p = await openBoard(c, id);
  await choose(p.page, ".tb-view-menu", zh ? "清單" : "List");
  await openMenu(p.page, ".tb-view-menu");
  await p.page.screenshot({ path: shot(`desk-${theme}-${lang}-3-display-menu`) });
  await p.page.keyboard.press("Escape");
  await p.page.locator(".tb-row-progress").first().click();   // a main task's sub tasks, opened up
  await p.page.waitForTimeout(300);
  await p.page.screenshot({ path: shot(`desk-${theme}-${lang}-4-list-by-status`) });
  await report(p, `desk ${theme} ${lang} list by status:`);
  await choose(p.page, ".tb-view-menu", zh ? "負責人" : "Assignee");
  await choose(p.page, ".tb-view-menu", zh ? "子任務也各列一行" : "Sub tasks as rows of their own");
  await p.page.keyboard.press("Escape");
  await p.page.waitForTimeout(300);
  await p.page.screenshot({ path: shot(`desk-${theme}-${lang}-5-list-by-assignee`), fullPage: true });
  await report(p, `desk ${theme} ${lang} list by assignee, sub tasks as rows:`);
  await p.ctx.close();
}
// A phone's list and its filter chips: light zh-TW, dark en.
for (const [theme, lang] of [["light", "zh-TW"], ["dark", "en"]] as const) {
  const id = seed(lang);
  const p = await openBoard({ device: "phone", theme, lang } as unknown as MatrixCase, id,
    { agend_tasks_display: JSON.stringify({ view: "list", group: "assignee", subs: true }), agend_tasks_filters: "priority!:low" });
  await p.page.waitForSelector(".tb-row");
  await p.page.screenshot({ path: shot(`phone-${theme}-${lang}-list`), fullPage: true });
  await report(p, `phone ${theme} ${lang} list:`);
  await p.ctx.close();
}
await fx.close(); process.exit(0);
