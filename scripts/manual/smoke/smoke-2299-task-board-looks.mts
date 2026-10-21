// #2299: the task board's looks on a phone (390/360 px, light/dark) and the desk/public/dialog cases — shots + numbers.
//   REPO=<tree> TAG=before|after OUT=<dir> … npx tsx scripts/manual/smoke/smoke-2299-task-board-looks.mts
import { join } from "node:path";
import { bootFixture, freshPage, mounted, openPublicLink, type MatrixCase } from "../smoke-fixture/index.mts";
const REPO = process.env.REPO!, TAG = process.env.TAG ?? "x", OUT = process.env.OUT!;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48620) });
const fm = fx.fm;
const AGENT = Object.keys(fm.fleetConfig.instances)[0];
const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");
let n = 0;
function freshBoard() {
  fm.scheduler?.db.close();
  fm.scheduler = new Scheduler(join(fm.dataDir, `looks-${++n}.db`), () => {}, DEFAULT_SCHEDULER_CONFIG, (x: string) => !!fm.fleetConfig.instances[x]);
  (fm as any).attachTaskBoard(fm.scheduler.db);
  return fm.scheduler.db;
}
const shot = (name: string) => join(OUT, `${TAG}-${name}.png`);
const top = (page: any) => page.locator("dialog[open]").last();
async function click(page: any, sel: string) { const all = page.locator(sel); for (let i = 0; i < 60; i++) { for (let k = 0; k < await all.count(); k++) if (await all.nth(k).isVisible()) { await all.nth(k).click(); return; } await page.waitForTimeout(100); } throw new Error("no " + sel); }
async function homeWithBlocked(p: any, lang: string) {
  await mounted(p.page);
  await p.page.goto(`${fx.base}/ui/fleet`); await p.page.waitForSelector(".tb-home");
  await click(p.page, ".tb-home .list-head .btn-primary");
  await top(p.page).locator("input").first().fill(lang === "zh-TW" ? "排行榜" : "Leaderboard");
  await top(p.page).locator(".btn-primary").click();
  await p.page.waitForSelector(".tb-board-page");
  await click(p.page, ".tb-bar-head .btn-primary");
  await top(p.page).locator("input").first().fill(lang === "zh-TW" ? "提供每週排行榜" : "Serve the weekly leaderboard");
  await top(p.page).locator(".tb-form-row select").first().selectOption(AGENT);
  await top(p.page).locator(".btn-primary").click();
  await p.page.waitForSelector(".tc-actions");
  await top(p.page).locator(".tc-actions select.tb-select").selectOption("blocked");
  await p.page.waitForSelector("dialog[open] textarea");
  await top(p.page).locator("textarea").fill(lang === "zh-TW" ? "哪些分數算數：只算排位賽嗎？" : "Which scores count: ranked games only?");
  await top(p.page).locator(".btn-primary").click();
  await p.page.waitForTimeout(400);
  await p.page.keyboard.press("Escape");
  await click(p.page, ".tb-bar-head .btn-ghost");
  await p.page.waitForSelector(".tb-wait-row");
}
const MEASURE = `(() => {
  var r = function (el) { if (!el) return null; var b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(window.innerWidth - b.right) }; };
  var home = document.querySelector(".tb-home");
  var toasts = Array.prototype.map.call(document.querySelectorAll(".toast"), r);
  var search = r(document.querySelector(".tb-search"));
  var overlap = toasts.some(function (t) { return t && search && t.y < search.y + search.h && t.y + t.h > search.y; });
  var pr = r(document.querySelector(".tb-wait-row .tb-pill")), cr = r(document.querySelector(".tb-wait-row .tb-code"));
  var icons = Array.prototype.filter.call(document.querySelectorAll(".panel-head button, .panel-head a"), function (e) { return e.offsetParent; }).map(function (e) { var b = e.getBoundingClientRect(); return Math.round(b.width) + "x" + Math.round(b.height); });
  var segs = Array.prototype.map.call(document.querySelectorAll(".tb-project .tb-bar rect"), function (e) { return e.getAttribute("class") + ":" + e.getAttribute("width") + "x" + e.getAttribute("height") + "@y" + (e.getAttribute("y") || 0); });
  return { gutterLeft: home && r(home).x, gutterRight: home && r(home).r, toasts: toasts.length, toastsOverSearch: overlap, pillCenterVsCode: pr && cr ? Math.round((pr.y + pr.h / 2) - (cr.y + cr.h / 2)) : null,
    answer: r(document.querySelector(".tb-wait-row .btn-primary")), headerTargets: icons.join(" "), bar: segs.join(" "), sideScroll: document.documentElement.scrollWidth > window.innerWidth + 1, meta: r(document.querySelector(".tb-project-meta")) };
})()`;
const measure = (p: any) => p.page.evaluate(MEASURE);
for (const width of [390, 360]) for (const theme of ["light", "dark"]) {
  freshBoard();
  const lang = "zh-TW";
  const p = await freshPage(fx, { device: "phone", theme, lang } as unknown as MatrixCase, {});
  await p.page.setViewportSize({ width, height: 844 });
  await homeWithBlocked(p, lang);
  await p.page.screenshot({ path: shot(`phone-${width}-${theme}-home`) });
  console.log(`${TAG} phone ${width} ${theme}:`, JSON.stringify(await measure(p)));
  await p.page.waitForTimeout(4500);   // the toasts gone: the page itself
  await p.page.screenshot({ path: shot(`phone-${width}-${theme}-home-settled`) });
  await p.ctx.close();
}
// desk: the board's columns; a toast while a card's dialog is open (dark); the public link's card
{
  freshBoard();
  const p = await freshPage(fx, { device: "desk", theme: "dark", lang: "en" } as unknown as MatrixCase, {});
  await homeWithBlocked(p, "en");
  await click(p.page, ".tb-project-open");
  await p.page.waitForSelector(".tb-columns");
  await p.page.waitForTimeout(4500);
  await p.page.screenshot({ path: shot("desk-1366-dark-board") });
  const cols = await p.page.evaluate(`(() => { var s = document.querySelector(".tb-scroll"); return { client: s.clientWidth, scroll: s.scrollWidth }; })()`);
  console.log(`${TAG} desk board 1366: scroller ${cols.client} content ${cols.scroll} ${cols.scroll > cols.client ? "OVERFLOWS" : "fits"}`);
  await p.page.locator(".tb-tile-title").first().click();
  await p.page.waitForSelector("dialog[open] .tc-actions");
  // A toast while the card's dialog is open (as a refused move or a copied link raises), through the app's own module.
  await p.page.evaluate(`import("/assets/ui-toast.js").then(function (m) { m.toast("M-1 confirmed"); })`);
  await p.page.waitForTimeout(700);
  await p.page.screenshot({ path: shot("desk-dark-toast-over-dialog") });
  const toastInTop = await p.page.evaluate(`(() => { var t = document.querySelector(".toasts"); var open = false; try { open = !!t && t.matches(":popover-open"); } catch (e) {} return { open: open, popoverAttr: !!t && t.getAttribute("popover"), toasts: document.querySelectorAll(".toast").length, texts: Array.prototype.map.call(document.querySelectorAll(".toast"), function (x) { return x.textContent; }).join(" | ") }; })()`);
  console.log(`${TAG} desk dark: toast list in the top layer while a dialog is open: ${JSON.stringify(toastInTop)}`);
  await p.ctx.close();
}
{
  const link = await openPublicLink(fx);
  for (const device of ["desk", "phone"]) {
    const pp = await link.publicPage({ device, theme: "light", lang: "en" } as unknown as MatrixCase, { path: "/ui/fleet" });
    await pp.page.waitForSelector(".tb-project-open");
    await pp.page.locator(".tb-project-open").first().click();
    await pp.page.waitForSelector(".tb-tile-title");
    await pp.page.locator(".tb-tile-title").first().click();
    await pp.page.waitForSelector("dialog[open] .tc-meta");
    await pp.page.screenshot({ path: shot(`public-${device}-card`) });
    const controls = await pp.page.evaluate(`document.querySelectorAll("dialog[open] .tc-meta select, dialog[open] .tc-meta input").length`);
    console.log(`${TAG} public ${device} card: form controls in the card's details: ${controls}`);
    await pp.ctx.close();
  }
  await link.close();
}
await fx.close(); process.exit(0);
