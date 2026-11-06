// A card's menu (fleet-task-menu.js) and the card dialog's Previous / Next: a right click on a tile and on a waiting
// row, the menu key on a tile, a choice going through (a priority), stepping with J — desk dark / light, en / zh-TW, a
// phone. Shots + numbers (no CSP violation, no console error, the menu inside the window).
//   REPO=<tree> OUT=<dir> PW_DIR=<dir with playwright-core> [CHROME=<chrome>] npx tsx scripts/manual/smoke/smoke-2246-card-menu.mts
import { join } from "node:path";
import { bootFixture, freshPage, mounted, type MatrixCase } from "../smoke-fixture/index.mts";
const REPO = process.env.REPO!, OUT = process.env.OUT!;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48660) });
const fm = fx.fm;
const NAMES = Object.keys(fm.fleetConfig.instances).filter((n) => n !== "general");
const [A, B] = [NAMES[0]!, NAMES[1]!];
const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");
let n = 0;
const ANN = { kind: "person", name: "Ann" };
function seed(lang: string) {
  fm.scheduler?.db.close();
  fm.scheduler = new Scheduler(join(fm.dataDir, `menu-${++n}.db`), () => {}, DEFAULT_SCHEDULER_CONFIG, (x: string) => !!fm.fleetConfig.instances[x]);
  (fm as any).attachTaskBoard(fm.scheduler.db);
  const b = fm.scheduler.db.board;
  const T = (en: string, tw: string) => (lang === "zh-TW" ? tw : en);
  const p = b.createProject(ANN, { name: T("Leaderboard", "排行榜") });
  const m = b.createCards(ANN, { project: p.id, cards: [
    { title: T("Serve the weekly leaderboard", "提供每週排行榜"), assignee: A, priority: "high" },
    { title: T("Add the shop", "加入商店"), assignee: B },
    { title: T("Choose the season badge", "選賽季徽章"), assignee: A },
    { title: T("Anti-cheat review", "防作弊檢查"), assignee: B },
  ] }).cards;
  // The person moves them (an instance has one card in progress at a time).
  b.moveCard(ANN, m[0].code, "claimed");
  for (const c of [m[2], m[3]]) { b.moveCard(ANN, c.code, "claimed"); b.moveCard(ANN, c.code, "review", { result: "src/x.ts" }); }
  return p.id;
}
const shot = (name: string) => join(OUT, `${name}.png`);
const NUMBERS = `(() => { var m = document.querySelector(".tb-card-menu"), b = m && m.getBoundingClientRect();
  return { csp: (window.__csp || []).length, menu: m ? { label: m.getAttribute("aria-label"), inside: b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight, items: m.querySelectorAll("[role^=menuitem]").length } : null,
    steps: (document.querySelector("dialog[open] .tc-step-at") || {}).textContent || null, card: new URLSearchParams(location.search).get("card") }; })()`;
async function report(p: any, label: string) { console.log(label, JSON.stringify(await p.page.evaluate(NUMBERS)), "errors:", p.errors.length ? p.errors : "none"); }
async function open(c: MatrixCase, projectId: number | null) {
  const p = await freshPage(fx, c, projectId === null ? {} : { beforeNavigate: (ctx: any) => ctx.addInitScript({ content: `localStorage.setItem("agend_tasks_project", "${projectId}");` }) });
  await mounted(p.page);
  await p.page.goto(`${fx.base}/ui/fleet`);
  await p.page.waitForSelector(projectId === null ? ".tb-home" : ".tb-board-page");
  return p;
}

for (const [theme, lang] of [["dark", "en"], ["light", "zh-TW"]] as const) {
  const id = seed(lang);
  const c = { device: "desk", theme, lang } as unknown as MatrixCase;
  // 1. A right click on a tile; a priority through it.
  let p = await open(c, id);
  const tile = p.page.locator(".tb-tile").first();
  const box = await tile.boundingBox();
  await p.page.mouse.click(box.x + box.width / 2, box.y + 20, { button: "right" });
  await p.page.waitForSelector(".tb-card-menu");
  await p.page.screenshot({ path: shot(`desk-${theme}-${lang}-1-tile-menu`) });
  await report(p, `desk ${theme} ${lang} tile menu:`);
  await p.page.locator(".tb-card-menu [role=menuitemradio]", { hasText: lang === "zh-TW" ? "緊急" : "Urgent" }).click();
  await p.page.waitForTimeout(600);
  console.log(`desk ${theme} ${lang} after Urgent:`, await p.page.evaluate(`Array.prototype.map.call(document.querySelectorAll(".tb-tile .tb-tag.p-urgent"), function (t) { return t.textContent; }).join(",")`));
  // 2. The menu key on the last tile's title: under the card, inside the window.
  await p.page.locator(".tb-tile-title").last().focus();
  await p.page.keyboard.press("Shift+F10");
  await p.page.waitForSelector(".tb-card-menu");
  await report(p, `desk ${theme} ${lang} Shift+F10:`);
  await p.page.keyboard.press("Escape");
  // 3. A card's dialog with its Previous / Next; J steps.
  await p.page.locator(".tb-tile-title").first().click();
  await p.page.waitForSelector("dialog[open] .tc-steps");
  await p.page.waitForTimeout(400);
  await p.page.screenshot({ path: shot(`desk-${theme}-${lang}-2-dialog-steps`) });
  await report(p, `desk ${theme} ${lang} dialog:`);
  await p.page.locator("dialog[open] .dlg-box").focus();
  await p.page.keyboard.press("j");
  await p.page.waitForTimeout(600);
  await report(p, `desk ${theme} ${lang} after J:`);
  await p.ctx.close();
  // 4. Home: a right click on a row waiting for you.
  p = await open(c, null);
  const row = p.page.locator(".tb-wait-row").first();
  const rb = await row.boundingBox();
  await p.page.mouse.click(rb.x + 60, rb.y + rb.height / 2, { button: "right" });
  await p.page.waitForSelector(".tb-card-menu");
  await p.page.screenshot({ path: shot(`desk-${theme}-${lang}-3-waiting-menu`) });
  await report(p, `desk ${theme} ${lang} waiting row menu:`);
  await p.ctx.close();
}
// A phone: the dialog's steps in the sheet's header.
{
  const id = seed("zh-TW");
  const p = await open({ device: "phone", theme: "light", lang: "zh-TW" } as unknown as MatrixCase, id);
  await p.page.locator(".tb-tile-title").first().click();
  await p.page.waitForSelector("dialog[open] .tc-steps");
  await p.page.waitForTimeout(400);
  await p.page.screenshot({ path: shot("phone-light-zh-TW-dialog-steps") });
  await report(p, "phone light zh-TW dialog:");
  await p.ctx.close();
}
await fx.close(); process.exit(0);
