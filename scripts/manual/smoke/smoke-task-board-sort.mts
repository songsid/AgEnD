// ui-gate: {"name": "Task board: No project made hard to miss", "hp": 48640}
// "No project", drawn in real Chromium. A card an agent opens without a project lands there; the tile was last on Home and
// only there, while the page reopens the project last looked at. With projects on the board and live cards in none:
//  1. Home lists the newest five above the projects (title with the count, "See all N"), each with a picker; the No project tile
//     is the first and says "N to sort"; nothing overflows sideways (desk and phone);
//  2. choosing a project in a picker files the card for real (the server writes it): it leaves the list, the count drops;
//  3. a project's board says how many are not in a project, and its link opens No project, whose header says what the place is;
//  4. a board with nothing to sort draws none of it;
//  5. on a phone every new control measures at least the --tap size (44px) both ways — the picker, a short row title, the
//     list's footer button and a project's header banner — and the desk keeps the dense link and footer (under 44px); a
//     phone's row is laid out for the width: the title across it, who/when and the picker under it.
// Shots: on a phone also Home scrolled to the No project tile (1b); a project's board is shot once the filing toast is gone.
// The page head's own controls (Instances, New project, search; not this change's) are measured and recorded, before and after.
// The shots are the "before" when run on the base commit with SHOTS_ONLY=1 (same seed; the checks name new things).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> MATRIX=desk-light-en,phone-dark-zh-TW HP=48640 \
//   npx tsx scripts/manual/smoke/smoke-task-board-sort.mts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, labelOf, matrix, shotPath, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-task-board-sort";
const REPO = process.env.REPO!;
const roster = [{ name: "master", backend: "claude-code" as const, status: "running" as const, general: true }, { name: "nightly", backend: "claude-code" as const, status: "running" as const }];
const fx = await bootFixture({ port: 0, oldPort: Number(process.env.HP ?? 48640), roster, classic: false });
const fm = fx.fm;
const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");
const ANN = { kind: "person", name: "operator" } as const;
const agent = (name: string) => ({ kind: "instance", name }) as const;

/** Two projects, some filed cards, and seven live cards agents opened in no project (plus a finished one, which is not to sort). */
function seed(c: MatrixCase, { loose }: { loose: boolean }) {
  fm.scheduler?.db.close();
  fm.scheduler = new Scheduler(join(fm.dataDir, `scheduler-${caseName(c)}-${loose ? "loose" : "clean"}.db`), () => {}, DEFAULT_SCHEDULER_CONFIG, (n: string) => !!fm.fleetConfig.instances[n]);
  (fm as any).attachTaskBoard(fm.scheduler.db);
  const board = fm.scheduler.db.board;
  const L = (en: string, zh: string) => labelOf(c, { en, zh });
  const game = board.createProject(ANN, { name: L("Game", "遊戲"), description: L("The game's work", "遊戲相關工作"), leadInstance: "master" });
  board.createProject(ANN, { name: L("Shop", "商店"), description: L("Storefront and payments", "商店與付款") });
  board.createCards(ANN, { project: game.id, cards: [{ title: L("Serve the weekly leaderboard", "提供每週排行榜"), assignee: "master" }, { title: L("Pick the badges", "挑選徽章") }] });
  if (loose) {
    const titles: Array<[string, string, string]> = [
      ["Daily report for the owner", "給擁有者的每日報告", "nightly"], ["Check the nightly backup", "檢查夜間備份", "nightly"], ["Fix checkout copy", "修正結帳頁文案", "master"],
      ["Rotate the API keys", "輪替 API 金鑰", "nightly"], ["Weekly digest of open cards", "每週未完成卡片摘要", "nightly"], ["Answer the support mail about refunds", "回覆退款客服信", "master"],
      ["A very long title that an automated run wrote because nobody said where the card belongs", "自動化流程寫的很長標題，因為沒有人說這張卡該放哪個專案，所以只好放在這裡", "nightly"],
    ];
    for (const [en, zh, who] of titles) board.createCards(agent(who), { cards: [{ title: L(en, zh), assignee: who, project: null }] });
    const done = board.createCards(agent("nightly"), { cards: [{ title: L("An old finished card", "舊的已完成卡片"), assignee: "nightly" }] }).cards[0]!.code as string;
    board.moveCard(agent("nightly"), done, "claimed"); board.moveCard(agent("nightly"), done, "done", { result: "ok" });
  }
  return { game: game.id };
}

const results: any = { smoke: SMOKE, cases: {} };
let failed = 0;
const shotsOnly = !!process.env.SHOTS_ONLY;
const OVERFLOW = `(() => document.documentElement.scrollWidth <= window.innerWidth + 1)()`;
const TAP = 44;   // --tap, the style guide's touch minimum (§7)
/** A control's drawn box, rounded to a tenth of a pixel (what a finger gets). */
async function box(loc: any): Promise<{ w: number; h: number } | null> {
  const b = await loc.boundingBox();
  return b ? { w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10 } : null;
}
const tappable = (b: { w: number; h: number } | null) => !!b && b.w >= TAP && b.h >= TAP;
/** A project's tile by its name (not its place: the No project tile moves first, so before and after open the same board). */
const tileOf = (page: any, c: MatrixCase, en: string, zh: string) =>
  page.locator(".tb-project").filter({ has: page.locator(".tb-project-name", { hasText: new RegExp(`^${labelOf(c, { en, zh })}$`) }) }).locator(".tb-project-open");

for (const c of matrix(process.env.MATRIX ?? "desk-light-en,phone-dark-zh-TW")) {
  const name = caseName(c);
  const phone = c.device === "phone";
  const ids = seed(c, { loose: true });
  const { ctx, page } = await fx.page(c, { path: "/ui/fleet", storage: { agend_tasks_project: "" } });
  const errors: string[] = [];
  page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 200)));
  const r: any = {};
  const chk: Record<string, boolean> = {};
  try {
    await page.waitForSelector(".tb-home .tb-project", { timeout: 15000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: shotPath(SMOKE, c, "1-home") });
    // the page head's controls, as they are (they come from the base; recorded so before and after can be compared)
    r.head = { buttons: await Promise.all((await page.locator(".tb-home .tb-head-actions .btn").all()).map(async (b: any) => ({ text: (await b.innerText()).trim(), box: await box(b) }))),
      search: await box(page.locator(".tb-home .tb-search input")) };
    if (phone) {   // the No project tile is below the list on a phone: a shot scrolled to it
      await tileOf(page, c, "No project", "未分類").scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      // the tile's badge is in this shot (the after run; the base has no badge)
      if (!shotsOnly) chk.tileBadgeInShot = await page.evaluate(() => { const b = document.querySelector(".tb-sort-flag")?.getBoundingClientRect(); return !!b && b.top >= 0 && b.bottom <= window.innerHeight; });
      await page.screenshot({ path: shotPath(SMOKE, c, "1b-home-tile") });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.locator(".tb-home").evaluate((el: any) => { for (let n = el; n; n = n.parentElement) n.scrollTop = 0; });
    }
    if (!shotsOnly) {
      const rows = await page.locator(".tb-sort-row").count();
      r.rows = rows;
      chk.listIsThere = (await page.locator(".tb-sort").count()) === 1;
      chk.fiveShown = rows === 5;
      r.title = (await page.locator(".tb-sort .tb-section-title").innerText()).trim();
      chk.titleHasCount = /7/.test(r.title);
      chk.newestFirst = (await page.locator(".tb-sort-row .tb-wait-title").first().innerText()).includes(labelOf(c, { en: "A very long title", zh: "自動化流程寫的很長標題" }));
      chk.seeAll = (await page.locator(".tb-sort-foot .btn").innerText()).includes("7");
      chk.tileFirst = (await page.locator(".tb-projects .tb-project").first().getAttribute("class"))?.includes("needs-sort") === true;
      r.badge = (await page.locator(".tb-sort-flag").innerText()).trim();
      chk.badgeHasCount = /7/.test(r.badge);
      chk.listAboveProjects = await page.evaluate(() => { const a = document.querySelector(".tb-sort"), b = document.querySelector(".tb-projects"); return !!a && !!b && a.getBoundingClientRect().bottom <= b.getBoundingClientRect().top + 1; });
      chk.noSidewaysScroll = await page.evaluate(OVERFLOW) as boolean;
      // each new control on Home, measured as drawn: the picker, the row title with the shortest text (one line, the smallest
      // box), the footer button. On a phone a row is one list line: the picker at its end, beside the title, not under it.
      const pick = await box(page.locator(".tb-sort-pick").first());
      r.pick = pick; chk.pickerVisible = !!pick && pick.w >= TAP;
      // a phone's row: the title across the row, under it who/when on the left and the picker on the right
      if (phone) chk.phoneRowLayout = await page.evaluate(() => [...document.querySelectorAll(".tb-sort-row")].every((row) => {
        const r = row.getBoundingClientRect(), t = row.querySelector(".tb-wait-title")!.getBoundingClientRect();
        const m = row.querySelector(".tb-sort-meta")!.getBoundingClientRect(), p = row.querySelector(".tb-sort-pick")!.getBoundingClientRect();
        const inner = r.width - parseFloat(getComputedStyle(row).paddingLeft) - parseFloat(getComputedStyle(row).paddingRight);
        return t.width >= inner - 1 && p.top >= t.bottom - 0.5 && p.left >= m.right && p.top < m.bottom && p.bottom > m.top;
      }));
      // ... and the title's and the picker's 44px boxes do not overlap: their rectangles share no area, and a tap at the title
      // box's bottom edge above the picker reaches the title, at the picker's middle the picker (every row, scrolled into view)
      if (phone) {
        r.rowBoxes = await page.evaluate(() => [...document.querySelectorAll(".tb-sort-row")].map((row) => {
          row.scrollIntoView({ block: "center" });
          const t = row.querySelector(".tb-wait-title")!, p = row.querySelector(".tb-sort-pick")!;
          const tr = t.getBoundingClientRect(), pr = p.getBoundingClientRect(), cs = getComputedStyle(p);
          const ox = Math.max(0, Math.min(tr.right, pr.right) - Math.max(tr.left, pr.left)), oy = Math.max(0, Math.min(tr.bottom, pr.bottom) - Math.max(tr.top, pr.top));
          const atTitleEdge = document.elementFromPoint((pr.left + pr.right) / 2, tr.bottom - 1), atPicker = document.elementFromPoint((pr.left + pr.right) / 2, (pr.top + pr.bottom) / 2);
          return { title: { y0: Math.round(tr.top), y1: Math.round(tr.bottom), h: Math.round(tr.height * 10) / 10 }, picker: { y0: Math.round(pr.top), y1: Math.round(pr.bottom), h: Math.round(pr.height * 10) / 10,
            painted: Math.round((pr.height - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth)) * 10) / 10 },
            overlap: Math.round(ox * oy * 10) / 10, titleEdgeHitsTitle: !!atTitleEdge && t.contains(atTitleEdge), pickerMiddleHitsPicker: atPicker === p };
        }));
        await page.evaluate(() => window.scrollTo(0, 0));
        chk.targetsApart = r.rowBoxes.every((b: any) => b.overlap <= 0.5 && b.titleEdgeHitsTitle && b.pickerMiddleHitsPicker && b.title.h >= 44 && b.picker.h >= 44);
      }
      const titles = await page.locator(".tb-sort-row .tb-wait-title").allInnerTexts();
      const shortest = titles.reduce((best, t, i) => (t.length < titles[best]!.length ? i : best), 0);
      r.shortTitle = { text: titles[shortest]!.trim(), box: await box(page.locator(".tb-sort-row .tb-wait-title").nth(shortest)) };
      r.foot = await box(page.locator(".tb-sort-foot .btn"));
      if (phone) {
        chk.pickerTappable = tappable(pick);
        chk.shortTitleTappable = tappable(r.shortTitle.box);
        chk.footTappable = tappable(r.foot);
      } else chk.deskFootStaysDense = !!r.foot && r.foot.h < TAP;
      // choosing a project files the card for real
      const option = await page.locator(".tb-sort-pick").first().locator("option").nth(2).getAttribute("value");   // the second project
      await page.locator(".tb-sort-pick").first().selectOption(option!);
      await page.waitForFunction(() => document.querySelectorAll(".tb-sort-row").length === 5 && !!document.querySelector(".tb-sort .tb-section-title")?.textContent?.includes("6"), null, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(500);
      r.titleAfter = (await page.locator(".tb-sort .tb-section-title").innerText()).trim();
      chk.filedLeavesTheList = /6/.test(r.titleAfter) && !/7/.test(r.titleAfter);
      chk.filedInTheServer = fm.scheduler.db.board.listCards({ project: Number(option) }).cards.length === 1;
      await page.screenshot({ path: shotPath(SMOKE, c, "2-after-filing") });
      // a project's board: the link, then No project
      await tileOf(page, c, "Game", "遊戲").click();
      await page.waitForSelector(".tb-board-page", { timeout: 10000 });
      await page.waitForTimeout(400);
      r.linkText = (await page.locator(".tb-sort-link").innerText()).trim();
      chk.projectLink = /6/.test(r.linkText);
      r.link = await box(page.locator(".tb-sort-link"));
      if (phone) chk.linkTappable = tappable(r.link); else chk.deskLinkStaysDense = !!r.link && r.link.h < TAP;
      // the filing toast (app-wide, 4 s, a tap closes it) is gone before the shot, so no card is under it
      await page.waitForFunction(() => !document.querySelector(".toasts .toast"), null, { timeout: 8000 }).catch(() => {});
      chk.noToastOverTheBoard = (await page.locator(".toasts .toast").count()) === 0;
      await page.screenshot({ path: shotPath(SMOKE, c, "3-project-board") });
      r.boardHead = await Promise.all((await page.locator(".tb-board-page .menu-text").all()).map(async (b: any) => ({ text: (await b.innerText()).trim(), box: await box(b) })));
      await page.locator(".tb-sort-link").click();
      await page.waitForFunction(() => !document.querySelector(".tb-sort-link"), null, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(500);
      r.noProjectTitle = (await page.locator(".tb-title h2").innerText()).trim();
      chk.opensNoProject = r.noProjectTitle === labelOf(c, { en: "No project", zh: "未分類" });
      chk.placeLead = (await page.locator(".tb-head-lead").count()) === 1;
      await page.screenshot({ path: shotPath(SMOKE, c, "4-no-project") });
      chk.noSidewaysScrollThere = await page.evaluate(OVERFLOW) as boolean;
    } else {
      await tileOf(page, c, "Game", "遊戲").click().catch(() => {});
      await page.waitForTimeout(500);
      await page.screenshot({ path: shotPath(SMOKE, c, "3-project-board") });
      r.boardHead = await Promise.all((await page.locator(".tb-board-page .menu-text").all()).map(async (b: any) => ({ text: (await b.innerText()).trim(), box: await box(b) })));
    }
  } catch (e) { r.error = String(e).slice(0, 500); chk.ranToTheEnd = false; await page.screenshot({ path: shotPath(SMOKE, c, "failure") }).catch(() => {}); }
  await ctx.close();

  // a board with nothing to sort draws none of it
  if (!shotsOnly) {
    seed(c, { loose: false });
    const { ctx: ctx2, page: page2 } = await fx.page(c, { path: "/ui/fleet", storage: { agend_tasks_project: "" } });
    page2.on("pageerror", (e: any) => errors.push(String(e).slice(0, 200)));
    try {
      await page2.waitForSelector(".tb-home .tb-project", { timeout: 15000 });
      await page2.waitForTimeout(500);
      chk.cleanBoardHasNoList = (await page2.locator(".tb-sort").count()) === 0 && (await page2.locator(".needs-sort").count()) === 0 && (await page2.locator(".tb-sort-flag").count()) === 0;
      await page2.screenshot({ path: shotPath(SMOKE, c, "5-nothing-to-sort") });
    } catch (e) { r.cleanError = String(e).slice(0, 300); chk.cleanBoardHasNoList = false; }
    await ctx2.close();
  }
  r.checks = chk; r.errors = errors; r.game = ids.game;
  const bad = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length || errors.length) failed++;
  console.log(`${bad.length || errors.length ? "FAIL" : "ok  "} ${name}${bad.length ? ` [${bad.join(", ")}]` : ""}${errors.length ? " " + JSON.stringify(errors) : ""}${r.error ? " " + r.error : ""}`);
  results.cases[name] = r;
}
writeFileSync(shotPath(SMOKE, "results", "measures").replace(/\.png$/, ".json"), JSON.stringify(results, null, 1));
await fx.close();
process.exit(failed ? 1 : 0);
