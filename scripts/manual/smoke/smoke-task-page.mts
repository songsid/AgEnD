// Fleet › Tasks laid out as an issue page — the evidence for the pull request. Each matrix case (desk 1366 /
// phone 390 × light / dark × English / zh-TW) opens a fresh browser profile on a board seeded the way a fleet's board looks
// after some weeks: two projects and cards outside any project; main tasks in every status (a blocked one, one waiting for
// the person, finished, cancelled), sub tasks, dependencies, a checklist, comments from the person and from an agent, a
// progress log. It signs in through the real /signin and drives only visible UI.
//   LAYOUT=after (default): the board, the list (its sort header, a folded group), a card's page (a chip's menu,
//   an edit saved by leaving the box), the quick create, Back (one history entry); on a phone one status at a
//   time and a card's ⋯ menu. A card made through the quick create with only a title.
//   LAYOUT=before: the same screens on a checkout before this change (the card in its drawer), for the before / after shots.
//   SEED_REPO=<checkout of main>: the board is written by that checkout's code and read by REPO's — the compatibility run (an
//   existing user's database, made by the version before this one, opens and edits in the new UI).
// Every page logs no error (CSP violations included); nothing scrolls sideways.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf LAYOUT=after \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-task-page.mts
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VIEWPORTS, bootFixture, caseName, freshPage, labelOf, matrix, mounted, shotPath, type FreshPage, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = `smoke-task-page-${process.env.LAYOUT === "before" ? "before" : process.env.SEED_REPO ? "compat" : "after"}`;
const AFTER = process.env.LAYOUT !== "before";
const REPO = process.env.REPO!;
console.log("board written by", process.env.SEED_REPO ?? REPO, "- read by", REPO);
const fx = await bootFixture({ port: Number(process.env.HP ?? 48470) });
const fm = fx.fm;
const AGENT = "search-indexer", AGENT2 = "billing-reconciliation", AGENT3 = "observability-dashboards", AGENT4 = "docs-writer";
const DEMO = new Set([AGENT, AGENT2, AGENT3, AGENT4]);
for (const name of Object.keys(fm.fleetConfig.instances)) if (!DEMO.has(name)) delete fm.fleetConfig.instances[name];
for (const name of DEMO) if (!fm.fleetConfig.instances[name]) fm.fleetConfig.instances[name] = { ...Object.values(fm.fleetConfig.instances)[0] as object, working_directory: fx.dir };

const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");
const Writer = process.env.SEED_REPO ? (await import(process.env.SEED_REPO + "/src/scheduler/index.ts")).Scheduler : Scheduler;
const writerConfig = process.env.SEED_REPO ? (await import(process.env.SEED_REPO + "/src/scheduler/index.ts")).DEFAULT_SCHEDULER_CONFIG : DEFAULT_SCHEDULER_CONFIG;
const known = (n: string) => !!fm.fleetConfig.instances[n];
const PERSON = { kind: "person" as const, name: "Demo Person" };
const inst = (name: string) => ({ kind: "instance" as const, name });

/** A board of its own for each case, seeded with some weeks of work (by SEED_REPO's code when given, then opened by REPO's). */
function seedBoard(c: MatrixCase) {
  fm.scheduler?.db.close();
  const file = join(fm.dataDir, `scheduler-${caseName(c)}.db`);
  const writer = new Writer(file, () => {}, writerConfig, known);
  const out = seed(c, writer.db.board);
  if (process.env.SEED_REPO) { writer.db.close(); fm.scheduler = new Scheduler(file, () => {}, DEFAULT_SCHEDULER_CONFIG, known); }
  else fm.scheduler = writer;
  (fm as any).attachTaskBoard(fm.scheduler.db);
  return { db: fm.scheduler.db, ...out };
}
function seed(c: MatrixCase, b: any) {
  const L = (en: string, zh: string) => labelOf(c, { en, zh });
  const lb = b.createProject(PERSON, { name: L("Leaderboard", "排行榜"), description: L("Weekly and seasonal rankings", "每週與每季排行榜") });
  const bill = b.createProject(PERSON, { name: L("Billing", "帳務"), description: L("Invoices and reconciliation", "發票與對帳") });
  const cards = b.createCards(PERSON, { project: lb.name, cards: [
    { title: L("Serve the weekly leaderboard", "提供每週排行榜"), assignee: AGENT, priority: "high", size: "M",
      goal: L("Players see their weekly rank within a second of finishing a game.", "玩家打完一場後一秒內就能看到本週名次。"),
      scope: L("In: ranking rules, scores API, the page. Out: seasonal ranking.", "做：排名規則、分數 API、頁面。不做：賽季排名。"),
      acceptance: [L("Ties share a rank", "同分同名次"), L("The page answers in under 300 ms", "頁面 300 ms 內回應"), L("Ranked games only", "只算排位賽"), L("Old scores are kept", "舊分數保留")],
      context: L("See M-4 for the score format.", "分數格式見 M-4。") },
    { title: L("Add the shop", "新增商店"), assignee: AGENT2, priority: "normal", size: "L", goal: L("Players spend coins on badges.", "玩家可以用金幣買徽章。") },
    { title: L("Choose the badge", "挑選徽章"), assignee: AGENT3, priority: "urgent", goal: L("Pick the badge art for the season.", "選定本季徽章圖樣。"),
      acceptance: [L("Three options compared", "比較三個方案")] },
    { title: L("Bootstrap the score store", "建立分數儲存"), assignee: AGENT2, priority: "low", size: "S" },
    { title: L("Tune the anti-cheat rules", "調整防作弊規則"), assignee: AGENT4, priority: "high" },
    { title: L("Archive last season", "封存上一季"), assignee: AGENT2, priority: "low" },
    { title: L("Write the season rules", "撰寫賽季規則"), assignee: AGENT4, priority: "urgent", size: "S" },
  ] }).cards;
  const [m1, m2, m3, m4, m5, m6, m7] = cards.map((x: any) => x.code);
  b.createCards(PERSON, { parent: m1, cards: [
    { title: L("Define the ranking rules", "訂定排名規則"), assignee: AGENT },
    { title: L("Build the scores API", "建立分數 API"), assignee: AGENT, dependsOn: ["#1"], acceptance: [L("GET /scores/weekly", "GET /scores/weekly"), L("Paged", "分頁")] },
    { title: L("Leaderboard page", "排行榜頁面"), assignee: AGENT4, dependsOn: ["#2"] },
  ] });
  b.createCards(PERSON, { parent: m2, cards: [{ title: L("Price list", "價目表"), assignee: AGENT2 }, { title: L("Checkout flow", "結帳流程"), assignee: AGENT2 }] });
  b.createCards(PERSON, { project: bill.name, cards: [{ title: L("Reconcile October invoices", "對 10 月發票"), assignee: AGENT2, priority: "high" }, { title: L("Late-payment reminders", "逾期提醒信"), priority: "normal" }] });
  b.createCards(inst(AGENT), { cards: [{ title: L("Check the nightly index job", "檢查夜間索引工作"), assignee: AGENT }] });
  const run = (what: string, fn: () => unknown) => { try { fn(); } catch (e) { console.log(`seed ${what}: ${String(e).slice(0, 160)}`); } };
  // The board's life: the agent claims, works and logs; the person comments; one card waits, one is blocked, one is finished.
  run("m4 done", () => { b.moveCard(inst(AGENT2), m4, "claimed"); b.moveCard(inst(AGENT2), m4, "review", { result: "ok" }); b.moveCard(PERSON, m4, "done"); });
  run("s1 claim", () => b.moveCard(inst(AGENT), "S-1", "claimed"));
  run("s1 done", () => b.moveCard(inst(AGENT), "S-1", "done", { result: L("Rules agreed: ties share a rank.", "規則已確認：同分同名次。") }));
  run("s2 claim", () => b.moveCard(inst(AGENT), "S-2", "claimed"));
  run("log s2", () => b.updateCard(inst(AGENT), "S-2", { log: L("Endpoint skeleton done, paging next", "端點骨架完成，接著做分頁"), check: [1] }));
  run("log m1", () => b.updateCard(inst(AGENT), m1, { log: L("Started on the scores API", "開始做分數 API"), state: L("Done: rules. Next: API. Watch out: season boundary.", "已完成：規則。下一步：API。注意：賽季邊界。"), check: [1] }));
  run("comment person", () => b.updateCard(PERSON, m1, { comment: L("Please keep the page under 300 ms even on a cold cache.", "冷快取時頁面也請維持在 300 ms 內。") }));
  run("comment agent", () => b.updateCard(inst(AGENT), m1, { comment: L("Understood — I will measure it on the cold path first.", "了解，我會先量冷路徑。") }));
  run("m3 claim", () => { b.moveCard(inst(AGENT3), m3, "claimed"); b.updateCard(inst(AGENT3), m3, { check: [1] }); });
  run("m3 review", () => b.moveCard(inst(AGENT3), m3, "review", { result: L("Three badge options in the shared folder; B recommended.", "共用資料夾有三個徽章方案，建議 B。") }));
  run("m5 claim", () => b.moveCard(inst(AGENT4), m5, "claimed"));
  run("m5 block", () => b.moveCard(inst(AGENT4), m5, "blocked", { reason: L("Which scores count: ranked games only?", "哪些分數算數：只算排位賽嗎？") }));
  run("m6 cancel", () => b.moveCard(PERSON, m6, "cancelled", { reason: "dropped" }));
  return { lb, ids: { m1, m2, m3, m4, m5, m6, m7 } };
}

async function clickVisible(page: any, selector: string, timeout = 10000): Promise<void> {
  const all = page.locator(selector), end = Date.now() + timeout;
  do {
    for (let i = 0; i < await all.count(); i++) if (await all.nth(i).isVisible()) { await all.nth(i).click(); return; }
    await page.waitForTimeout(100);
  } while (Date.now() < end);
  throw new Error(`nothing visible matches ${selector}`);
}
async function openTasks(p: FreshPage): Promise<void> {
  await mounted(p.page);
  await p.page.goto(`${p.base}/ui/fleet`);
  await p.page.waitForSelector(".tb-home", { timeout: 15000 });
}
const noSideScroll = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const results: Array<{ name: string; ok: boolean; failed: string[]; errors: string[] }> = [];
function record(name: string, chk: Record<string, boolean>, errors: string[]) {
  const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
  results.push({ name, ok: !failed.length, failed, errors });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${name}${failed.length ? ` [${failed.join(", ")}] ${JSON.stringify(errors).slice(0, 600)}` : ""}`);
}

for (const c of matrix()) {
  const name = caseName(c);
  const { db, lb, ids } = seedBoard(c);
  const phone = c.device === "phone";
  const p = await freshPage(fx, c, phone ? { origin: "lan", reducedMotion: true } : {});
  const page = p.page;
  // `calm`: the pointer and the focus are moved off the board first, so no hover card (an assignee's info card opens on hover or focus)
  // stands over what the picture is of.
  const shot = async (n: string, calm = false) => {
    if (calm) { await page.mouse.move(0, 0); await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.()); await page.waitForTimeout(250); }
    return page.screenshot({ path: shotPath(SMOKE, c, n) });
  };
  // A toast stays a few seconds: wait for it to go, so it does not stand over a picture of something else.
  const toastsGone = () => page.waitForFunction(() => !document.querySelector(".toasts .toast"), null, { timeout: 10000 }).catch(() => {});
  const chk: Record<string, boolean> = {};
  try {
    await openTasks(p);
    await shot("1-home", true);
    await clickVisible(page, `.tb-project-open:has-text("${lb.name}")`);
    await page.waitForSelector(".tb-board-page", { timeout: 10000 });
    await page.waitForTimeout(400);
    await shot("2-board", true);
    if (phone) chk.phoneBoardNoSideScroll = await noSideScroll(page);

    // The list.
    if (AFTER) await clickVisible(page, ".tb-view-toggle button:nth-child(2)");
    else { await clickVisible(page, ".tb-view-menu > button"); await clickVisible(page, `.tb-view-menu .menu-list button:has-text("${labelOf(c, { en: "List", zh: "清單" })}")`); }
    await page.waitForSelector(".tb-list", { timeout: 10000 });
    await page.waitForTimeout(300);
    await shot("3-list", true);
    if (phone) chk.phoneListNoSideScroll = await noSideScroll(page);
    if (AFTER) {
      chk.listHasSortHeader = phone || (await page.locator(".tb-list-head .tb-lh").count()) >= 4;
      chk.everyRowHasPriority = (await page.locator(".tb-row").count()) > 0 && (await page.locator(".tb-row .tb-row-prio").count()) === (await page.locator(".tb-row").count());
      if (!phone) {   // sort by priority within To do: urgent (M-7) before normal (M-2), then turned round
        const inGroup = `.tb-group:has([data-row="${ids.m2}"]) .tb-row`;
        const order = () => page.locator(inGroup).evaluateAll((els: any[]) => els.map((e) => e.getAttribute("data-row")));
        await clickVisible(page, ".tb-lh-prio");
        await page.waitForTimeout(200);
        const asc = await order();
        chk.sortByPriority = asc.indexOf(ids.m7) >= 0 && asc.indexOf(ids.m7) < asc.indexOf(ids.m2);
        await clickVisible(page, ".tb-lh-prio");
        await page.waitForTimeout(200);
        const desc = await order();
        chk.sortTurnsRound = desc.indexOf(ids.m2) < desc.indexOf(ids.m7);
        await clickVisible(page, ".tb-lh-code");
      }
      // Fold a group away and open it again.
      const before = await page.locator(".tb-row").count();
      await page.locator(".tb-group-toggle").first().click();
      chk.groupFolds = (await page.locator(".tb-row").count()) < before;
      await page.locator(".tb-group-toggle").first().click();
      chk.groupOpens = (await page.locator(".tb-row").count()) === before;
    }

    // A card.
    await page.locator(`[data-row="${ids.m1}"] .tb-row-title`).click();
    if (AFTER) {
      await page.waitForSelector(".tp-grid", { timeout: 10000 });
      await page.waitForTimeout(500);
      chk.cardIsAPage = (await page.locator("dialog[open]").count()) === 0 && (await page.locator(".tp-side .tp-chip").count()) >= 4;
      chk.addressHasCard = new URL(page.url()).searchParams.get("card") === ids.m1;
      await shot("4-card", true);
      if (!phone) {   // a wide window: the card's page uses the whole content area (no max width), and nothing scrolls sideways
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.waitForTimeout(400);
        chk.cardWideNoSideScroll = await noSideScroll(page);
        await shot("10-card-1920", true);
        await page.setViewportSize(VIEWPORTS[c.device]);
        await page.waitForTimeout(300);
      }
      chk.cardKeepsTheView = (await page.locator(".tp-grid").count()) === 1;
      if (phone) chk.phoneCardNoSideScroll = await noSideScroll(page);
      // The timeline is one list: comments, the progress log and history together.
      chk.timelineMerged = (await page.locator(".tl-comment").count()) >= 2 && (await page.locator(".tl-log").count()) >= 1 && (await page.locator(".tl-run, .tl-event").count()) >= 1;   // the system's lines are folded into a "› N activities" run at first
      // A chip's menu: priority → Low saves at once.
      await toastsGone();
      await page.locator(".tp-props .tp-row:has(.tp-prio) .tp-chip").click();
      await page.waitForSelector(".tp-chip-menu .menu-list", { timeout: 5000 });
      await shot("5-chip-menu");
      await page.locator('.tp-chip-menu .menu-list [role="menuitemradio"]').nth(3).click();
      chk.chipSaves = await until(() => db.board.getCard(ids.m1).priority === "low");
      // Text edited in place: leaving the box saves, no Save button.
      const goal = labelOf(c, { en: "Players see their weekly rank within half a second.", zh: "玩家半秒內就能看到本週名次。" });
      await page.locator(".tp-body .tc-field:has(h3:text-is(\"" + labelOf(c, { en: "Goal", zh: "目標" }) + "\")) .tc-text").first().click();
      await page.locator(".tp-body .tc-edit textarea").fill(goal);
      chk.noSaveButtonWhileEditing = (await page.locator(".tp-body .tc-edit .btn-primary").count()) === 0;
      await page.locator(".tp-body h3").first().click();   // click away
      chk.blurSaves = await until(() => db.board.getCard(ids.m1).goal === goal);
      // Back returns to the list with one history entry.
      await page.goBack();
      await page.waitForSelector(".tb-list", { timeout: 5000 });
      chk.backReturnsToList = new URL(page.url()).searchParams.get("card") === null;
    } else {
      await page.waitForSelector("dialog[open] .tc-actions", { timeout: 10000 });
      await page.waitForTimeout(500);
      await shot("4-card");
      await page.keyboard.press("Escape");
    }

    // Quick create.
    await clickVisible(page, ".tb-bar-head .btn-primary");
    await page.waitForSelector("dialog[open]", { timeout: 5000 });
    await page.waitForTimeout(300);
    await shot("7-create");
    if (AFTER) {
      const fresh = labelOf(c, { en: "Rank ties by earliest score", zh: "同分以先到者為先" });
      await page.locator("dialog[open] .tb-qc-title").fill(fresh);
      await page.locator("dialog[open] .tb-qc-title").press("Enter");
      await page.waitForSelector(".tp-grid", { timeout: 10000 });
      const made = db.board.boardCards().find((x: any) => x.title === fresh);
      chk.quickCreateWithOnlyATitle = !!made && made.assignee === null && made.priority === "normal";
      await page.goBack().catch(() => {});
    } else await page.keyboard.press("Escape");

    // Phone: the board one status at a time; a card's ⋯ menu.
    if (AFTER && phone) {
      await toastsGone();
      await clickVisible(page, ".tb-view-toggle button:nth-child(1)");
      await page.waitForSelector(".tb-status-seg", { timeout: 5000 });
      chk.phoneOneStatus = (await page.locator(".tb-col:visible").count()) === 1;
      await clickVisible(page, ".tb-status-seg button:nth-child(1)");
      await page.waitForTimeout(200);
      await shot("8-phone-status", true);
      await clickVisible(page, ".tb-tile-more");
      await page.waitForSelector(".tb-card-menu", { timeout: 5000 });
      chk.moveToWithoutDrag = ((await page.locator(".tb-card-menu").textContent()) ?? "").length > 0;
      await shot("9-phone-menu");
      await page.keyboard.press("Escape");
    }
  } catch (e) {
    chk.ranToTheEnd = false;
    console.log(String(e).slice(0, 700));
    await page.screenshot({ path: shotPath(SMOKE, c, "failure") }).catch(() => {});
  }
  chk.noErrors = p.errors.length === 0;
  record(name, chk, p.errors);
  await p.ctx.close();
}

async function until(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return false;
}
const out = join(dirname(shotPath(SMOKE, "x", "x")), "result.json");
writeFileSync(out, JSON.stringify(results, null, 2));
await fx.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
