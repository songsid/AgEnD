// A task card's page lists its watchers and its leader — the evidence for the pull request. Each matrix case (desk
// 1366 / phone 390 × light / dark × English / zh-TW) opens a fresh browser profile on a board seeded as in smoke-task-page
// (two projects, main tasks, sub tasks), with a lead on one project, the board's default leader (defaults.task_board.leader),
// and watchers on some cards. It signs in through the real /signin and drives only visible UI.
//   LAYOUT=after (default): a card with watchers and a project lead; the Add menu; a watcher added and removed through it
//   (the board's own write, read back); a sub task with its own watcher and the main task's; a card in the project with no
//   lead (the board's default leader, and nobody); an instance with the task board off greyed in Add; ten watchers (Add gives
//   way to the reason); a card whose leader is its own assignee (it says why it hears nothing).
//   LAYOUT=before: the same cards on a checkout without the rows, for the before / after shots.
// Every page logs no error (CSP violations included); nothing scrolls sideways.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf LAYOUT=after \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-task-watchers.mts
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bootFixture, caseName, freshPage, labelOf, matrix, mounted, shotPath, type FreshPage, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = `smoke-task-watchers-${process.env.LAYOUT === "before" ? "before" : "after"}`;
const AFTER = process.env.LAYOUT !== "before";
const REPO = process.env.REPO!;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48510) });
const fm = fx.fm;
const AGENT = "search-indexer", AGENT2 = "billing-reconciliation", AGENT3 = "observability-dashboards", AGENT4 = "docs-writer", QUIET = "legacy-importer";
const EXTRA = ["metrics-rollup", "release-notes", "ops-pager", "triage-bot", "design-review", "load-tester"];      // with the four above and QUIET: ten, for the limit
const DEMO = new Set([AGENT, AGENT2, AGENT3, AGENT4, QUIET, ...EXTRA]);
for (const name of Object.keys(fm.fleetConfig.instances)) if (!DEMO.has(name)) delete fm.fleetConfig.instances[name];
for (const name of DEMO) if (!fm.fleetConfig.instances[name]) fm.fleetConfig.instances[name] = { ...Object.values(fm.fleetConfig.instances)[0] as object, working_directory: fx.dir };
fm.fleetConfig.instances[QUIET].dashboard = { task_board: false };                       // an instance with the task board switched off
fm.fleetConfig.defaults = { ...(fm.fleetConfig.defaults ?? {}), task_board: { ...((fm.fleetConfig.defaults ?? {}).task_board ?? {}), leader: AGENT3 } };

const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");
const known = (n: string) => !!fm.fleetConfig.instances[n];
const PERSON = { kind: "person" as const, name: "Demo Person" };

/** A board of its own for each case. */
function seedBoard(c: MatrixCase) {
  fm.scheduler?.db.close();
  const file = join(fm.dataDir, `scheduler-${caseName(c)}.db`);
  const sched = new Scheduler(file, () => {}, DEFAULT_SCHEDULER_CONFIG, known);
  fm.scheduler = sched;
  (fm as any).attachTaskBoard(sched.db);
  const b = sched.db.board;
  const L = (en: string, zh: string) => labelOf(c, { en, zh });
  const lb = b.createProject(PERSON, { name: L("Leaderboard", "排行榜"), description: L("Weekly and seasonal rankings", "每週與每季排行榜") });
  const bill = b.createProject(PERSON, { name: L("Billing", "帳務"), description: L("Invoices and reconciliation", "發票與對帳") });
  if (AFTER || b.updateProject) b.updateProject(PERSON, lb.id, { leadInstance: AGENT4 });         // the Leaderboard's lead; Billing has none
  const main = b.createCards(PERSON, { project: lb.name, cards: [
    { title: L("Serve the weekly leaderboard", "提供每週排行榜"), assignee: AGENT, priority: "high", size: "M",
      goal: L("Players see their weekly rank within a second of finishing a game.", "玩家打完一場後一秒內就能看到本週名次。"),
      acceptance: [L("Ties share a rank", "同分同名次"), L("The page answers in under 300 ms", "頁面 300 ms 內回應")] },
    { title: L("Write the season rules", "撰寫賽季規則"), assignee: AGENT4, priority: "normal", goal: L("Players know how a season is scored.", "玩家知道賽季怎麼計分。") },
  ] }).cards.map((x: any) => x.code);
  const subs = b.createCards(PERSON, { parent: main[0], cards: [
    { title: L("Define the ranking rules", "訂定排名規則"), assignee: AGENT },
    { title: L("Build the scores API", "建立分數 API"), assignee: AGENT },
  ] }).cards.map((x: any) => x.code);
  const billing = b.createCards(PERSON, { project: bill.name, cards: [
    { title: L("Reconcile October invoices", "對 10 月發票"), assignee: AGENT2, priority: "high", goal: L("Every invoice matches a payment.", "每張發票都對得到一筆付款。") },
    { title: L("Draft the dunning emails", "撰寫催款信"), assignee: AGENT2, priority: "normal" },
  ] }).cards.map((x: any) => x.code);
  const watch = (code: string, names: string[]) => { try { b.setWatchers(PERSON, code, { add: names }); } catch (e) { console.log(`seed watchers ${code}: ${String(e).slice(0, 160)}`); } };
  watch(main[0], [AGENT2, AGENT3]);                    // the main task's: the sub tasks hear them too
  watch(subs[1], [AGENT4]);
  watch(billing[1], [AGENT, AGENT3, AGENT4, "metrics-rollup", "release-notes", "ops-pager", "triage-bot", "design-review", "load-tester", AGENT2]);   // ten
  return { lb, bill, main, subs, billing };
}

async function until(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return false;
}
const noSideScroll = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const results: Array<{ name: string; ok: boolean; failed: string[]; errors: string[] }> = [];
function record(name: string, chk: Record<string, boolean>, errors: string[]) {
  const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
  results.push({ name, ok: !failed.length, failed, errors });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${name}${failed.length ? ` [${failed.join(", ")}] ${JSON.stringify(errors).slice(0, 600)}` : ""}`);
}
async function openCard(p: FreshPage, projectId: number, code: string) {
  await p.page.goto(`${p.base}/ui/fleet?tp=${projectId}&card=${code}`);
  await p.page.waitForSelector(".tp-grid", { timeout: 15000 });
  await p.page.waitForTimeout(500);
}

for (const c of matrix()) {
  const name = caseName(c);
  const { lb, bill, main, subs, billing } = seedBoard(c);
  const phone = c.device === "phone";
  const p = await freshPage(fx, c, phone ? { origin: "lan", reducedMotion: true } : {});
  const page = p.page;
  const shot = (n: string) => page.screenshot({ path: shotPath(SMOKE, c, n) });
  /** The phone's single column: the properties are under the title, so bring the rows into view. */
  const show = async (sel: string) => { await page.locator(sel).first().scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(250); };
  const chk: Record<string, boolean> = {};
  const rowText = async (which: "watchers" | "leader") => ((await page.locator(`[data-follow="${which}"]`).first().textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
  const watchers = () => page.locator("[data-watcher]").evaluateAll((els: any[]) => els.map((e) => e.getAttribute("data-watcher")));
  try {
    await mounted(page);
    // 1. A card with watchers, in a project with a lead.
    await openCard(p, lb.id, main[0]);
    await show(AFTER ? '[data-follow="watchers"]' : ".tp-props");
    await shot("1-card");
    if (phone) chk.phoneCardNoSideScroll = await noSideScroll(page);
    if (AFTER) {
      chk.watchersListed = JSON.stringify(await watchers()) === JSON.stringify([AGENT2, AGENT3]);
      chk.leaderIsTheProjectsLead = (await rowText("leader")).includes(AGENT4) && (await rowText("leader")).includes(labelOf(c, { en: "project lead", zh: "專案負責人" }));
      // 2. Add: the menu lists those not watching, the one with the board off is greyed; choosing one writes and shows it.
      await page.locator(".tp-watch-add > button").first().click();
      await page.waitForSelector(".tp-watch-add .menu-list", { timeout: 5000 });
      const items = await page.locator(".tp-watch-add .menu-list button").evaluateAll((els: any[]) => els.map((e) => ({ text: e.textContent.trim(), disabled: e.disabled })));
      chk.addListsOthersOnly = !items.some((i: any) => i.text.includes(AGENT2) || i.text.includes(AGENT3)) && items.some((i: any) => i.text === AGENT4);
      chk.boardOffIsGreyed = items.some((i: any) => i.text.includes(QUIET) && i.disabled);
      await show(".tp-watch-add .menu-list");
      await shot("2-add-menu");
      await page.locator(".tp-watch-add .menu-list button", { hasText: AGENT4 }).first().click();
      chk.addedShows = await until(async () => (await watchers()).includes(AGENT4));
      chk.addedIsStored = JSON.stringify(fm.scheduler.db.board.detail(main[0]).watchers) === JSON.stringify([AGENT2, AGENT3, AGENT4]);
      await show('[data-follow="watchers"]');
      await shot("3-added");
      // …and removed by its ✕.
      await page.locator(`[data-watcher="${AGENT4}"] .tp-watch-x`).click();
      chk.removedGoes = await until(async () => !(await watchers()).includes(AGENT4));
      chk.removedIsStored = JSON.stringify(fm.scheduler.db.board.detail(main[0]).watchers) === JSON.stringify([AGENT2, AGENT3]);
    }
    // 4. A sub task: its own watcher, and its main task's.
    await openCard(p, lb.id, subs[1]);
    await show(AFTER ? '[data-follow="watchers"]' : ".tp-props");
    await shot("4-subtask");
    if (AFTER) {
      const watchersRow = await rowText("watchers");
      chk.subShowsOwn = JSON.stringify(await watchers()) === JSON.stringify([AGENT4]);
      chk.subShowsMainsWatchers = watchersRow.includes(labelOf(c, { en: "Also from", zh: "另外從" })) && watchersRow.includes(main[0]) && watchersRow.includes(AGENT2);
    }
    // 5. A card in the project that has no lead: the board's default leader; no watchers.
    await openCard(p, bill.id, billing[0]);
    await show(AFTER ? '[data-follow="watchers"]' : ".tp-props");
    await shot("5-board-leader");
    if (AFTER) {
      chk.boardDefaultLeader = (await rowText("leader")).includes(AGENT3) && (await rowText("leader")).includes(labelOf(c, { en: "board default", zh: "任務板預設" }));
      chk.noWatchersSaysSo = (await watchers()).length === 0 && (await rowText("watchers")).includes(labelOf(c, { en: "Nobody", zh: "沒有" }));
      // 6. Ten watchers: Add gives way to the reason; each can still be removed.
      await openCard(p, bill.id, billing[1]);
      await show('[data-follow="watchers"]');
      chk.tenIsTheMost = (await watchers()).length === 10 && (await page.locator(".tp-watch-add").count()) === 0 && (await rowText("watchers")).includes("10");
      await shot("6-ten-watchers");
      if (phone) chk.phoneTenNoSideScroll = await noSideScroll(page);
      // 7. The leader is the card's own assignee: it says why it hears nothing of it.
      fm.scheduler.db.board.updateCard(PERSON, billing[0], { assignee: AGENT3 });
      await openCard(p, bill.id, billing[0]);
      await show('[data-follow="leader"]');
      chk.leaderWhoHasTheCardSaysWhy = (await page.locator(".tp-leader-note").count()) === 1;
      await shot("7-leader-has-the-card");
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

const out = join(dirname(shotPath(SMOKE, "x", "x")), "result.json");
writeFileSync(out, JSON.stringify(results, null, 2));
await fx.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
