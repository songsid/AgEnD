// A card's comment box and the fleet's wake switches — the evidence for the pull request. Each matrix case (desk 1366 /
// phone 390 × light / dark × English / zh-TW) opens a fresh browser profile on a board seeded as in smoke-task-page, with
// one instance whose task board is switched off. It signs in through the real /signin and drives only visible UI.
//   LAYOUT=after (default): `@` in a card's comment box lists the fleet's instances (the one with the board off is listed,
//   greyed, and cannot be chosen); Enter types the name as text; a card whose assignee has the board off says under the
//   box that a comment will not wake it, and the Tasks page names that instance and where to turn it on; Settings → Shared
//   agent settings has the card "When the task board wakes an agent" with its two switches and the leader menu.
//   LAYOUT=before: the same screens on a checkout before this change, for the before / after shots.
// Every page logs no error (CSP violations included); nothing scrolls sideways.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf LAYOUT=after \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-task-comment-box.mts
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bootFixture, caseName, freshPage, labelOf, matrix, mounted, shotPath, type FreshPage, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = `smoke-task-comment-box-${process.env.LAYOUT === "before" ? "before" : "after"}`;
const AFTER = process.env.LAYOUT !== "before";
const REPO = process.env.REPO!;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48520) });
const fm = fx.fm;
const AGENT = "search-indexer", AGENT2 = "billing-reconciliation", AGENT3 = "observability-dashboards", QUIET = "legacy-importer";
const DEMO = new Set([AGENT, AGENT2, AGENT3, QUIET]);
for (const name of Object.keys(fm.fleetConfig.instances)) if (!DEMO.has(name)) delete fm.fleetConfig.instances[name];
for (const name of DEMO) if (!fm.fleetConfig.instances[name]) fm.fleetConfig.instances[name] = { ...Object.values(fm.fleetConfig.instances)[0] as object, working_directory: fx.dir };

const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");
const known = (n: string) => !!fm.fleetConfig.instances[n];
const PERSON = { kind: "person" as const, name: "Demo Person" };

/** A board of its own for each case. */
function seedBoard(c: MatrixCase) {
  delete fm.fleetConfig.instances[QUIET].dashboard;   // on while the cards are made (a case before this one switched it off)
  fm.scheduler?.db.close();
  const file = join(fm.dataDir, `scheduler-${caseName(c)}.db`);
  const sched = new Scheduler(file, () => {}, DEFAULT_SCHEDULER_CONFIG, known);
  fm.scheduler = sched;
  (fm as any).attachTaskBoard(sched.db);
  const b = sched.db.board;
  const L = (en: string, zh: string) => labelOf(c, { en, zh });
  const lb = b.createProject(PERSON, { name: L("Leaderboard", "排行榜"), description: L("Weekly and seasonal rankings", "每週與每季排行榜") });
  const main = b.createCards(PERSON, { project: lb.name, cards: [
    { title: L("Serve the weekly leaderboard", "提供每週排行榜"), assignee: AGENT, priority: "high", size: "M",
      goal: L("Players see their weekly rank within a second of finishing a game.", "玩家打完一場後一秒內就能看到本週名次。"),
      acceptance: [L("Ties share a rank", "同分同名次"), L("The page answers in under 300 ms", "頁面 300 ms 內回應")] },
    { title: L("Import the legacy scores", "匯入舊的分數"), assignee: QUIET, priority: "normal", goal: L("Last season's scores are on the board.", "上一季的分數都在榜上。") },
  ] }).cards.map((x: any) => x.code);
  fm.fleetConfig.instances[QUIET].dashboard = { task_board: false };   // switched off once it holds a card (the board refuses to hand one to it)
  return { lb, main };
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
  const { lb, main } = seedBoard(c);
  const phone = c.device === "phone";
  const p = await freshPage(fx, c, phone ? { origin: "lan", reducedMotion: true } : {});
  const page = p.page;
  const shot = (n: string) => page.screenshot({ path: shotPath(SMOKE, c, n) });
  const show = async (sel: string) => { await page.locator(sel).first().scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(250); };
  const chk: Record<string, boolean> = {};
  const box = () => page.locator(".tc-composer textarea").first();
  const listed = () => page.locator(".tc-mentions li").evaluateAll((els: any[]) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  try {
    await mounted(page);
    // 1. `@` in the comment box: the fleet's instances, the card's assignee first; the one with the board off is greyed.
    await openCard(p, lb.id, main[0]);
    await box().click();
    await box().type("Ask @");
    await page.waitForTimeout(300);
    await show(".tc-composer");
    await shot("1-at-list");
    if (phone) chk.phoneCardNoSideScroll = await noSideScroll(page);
    if (AFTER) {
      const items = await listed();
      chk.assigneeFirst = items[0] === `@${AGENT}`;
      chk.listsTheFleet = [AGENT2, AGENT3, QUIET].every((n) => items.some((i: string) => i.includes(`@${n}`)));
      chk.boardOffIsGreyed = await page.locator(".tc-mentions button", { hasText: QUIET }).first().isDisabled();
      // 2. A name is chosen with Enter: it is typed as text, and nothing is sent.
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(200);
      const second = items[1].replace(/^@/, "").split(" ")[0];
      chk.typedAsText = (await box().inputValue()) === `Ask @${second} `;
      chk.nothingSent = fm.scheduler.db.board.detail(main[0]).comments.length === 0;
      await show(".tc-composer");
      await shot("2-at-chosen");
      // 3. A comment on a card whose assignee has the board off says it will not wake it, and where to turn it on.
      await openCard(p, lb.id, main[1]);
      await box().click();
      await box().type(L10(c, "Please look at this", "請看一下"));
      await show(".tc-composer");
      chk.noteUnderTheBox = (await page.locator(".tc-composer").locator("xpath=preceding-sibling::*[1][contains(@class,'tb-boardoff')]").count()) === 1;
      chk.noteNamesTheInstance = ((await page.locator(".tb-boardoff").first().textContent()) ?? "").includes(QUIET);
      chk.noteLinksToSettings = (await page.locator(".tb-boardoff a").first().getAttribute("href"))?.includes("agent-defaults") === true;
      await shot("3-comment-board-off");
    }
    // 4. The Tasks page names the instance with the board off, and where to turn it on.
    await page.goto(`${p.base}/ui/fleet?tp=${lb.id}`);
    await page.waitForSelector(".tb-board-page", { timeout: 15000 });
    await page.waitForTimeout(400);
    await shot("4-board-off-note");
    if (AFTER) chk.pageNote = (await page.locator(".tb-boardoff").count()) === 1 && ((await page.locator(".tb-boardoff").first().textContent()) ?? "").includes(QUIET);
    // 5. Settings → Shared agent settings: the wake switches.
    await page.goto(`${p.base}/settings/agent-defaults`);
    await page.waitForSelector(".p-settings", { timeout: 15000 });
    await page.waitForTimeout(600);
    const drawer = page.locator("details.drawer > summary", { hasText: labelOf(c, { en: "Advanced", zh: "進階" }) }).first();
    if (await drawer.count()) await drawer.click();
    await page.waitForTimeout(300);
    if (AFTER) {
      await page.waitForSelector("#g-wakes", { state: "visible", timeout: 10000 });
      await show("#g-wakes");
      chk.switchesOnByDefault = (await page.locator("#g-wake-comment").isChecked()) && (await page.locator("#g-wake-progress").isChecked());
      chk.leaderMenuListsTheFleet = (await page.locator("#g-wake-leader option").count()) >= 4;
      if (phone) chk.phoneSettingsNoSideScroll = await noSideScroll(page);
    } else {
      await page.locator("#g-gen-advanced, details.drawer").first().scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    }
    await shot("5-settings-wakes");
  } catch (e) {
    chk.ranToTheEnd = false;
    console.log(String(e).slice(0, 700));
    await page.screenshot({ path: shotPath(SMOKE, c, "failure") }).catch(() => {});
  }
  chk.noErrors = p.errors.length === 0;
  record(name, chk, p.errors);
  await p.ctx.close();
}

function L10(c: MatrixCase, en: string, zh: string) { return labelOf(c, { en, zh }); }
const out = join(dirname(shotPath(SMOKE, "x", "x")), "result.json");
writeFileSync(out, JSON.stringify(results, null, 2));
await fx.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
