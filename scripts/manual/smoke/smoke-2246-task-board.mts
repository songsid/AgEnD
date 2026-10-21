// #2246 from defaults (fleet decision a78ebdc5): the task board, each case a fresh profile with nothing seeded and an
// empty board of its own, signed in through the visible /signin, driven only through visible UI. The one step outside
// the page is the agent's: it works its card through the `task` tool (boardToolAction, as both of the tool's doors do).
// - the person (desk light en, loopback; phone dark zh-TW, LAN origin, reduced motion): Fleet → Tasks from the
//   navigation — the empty state; New project; New main task, assigned to an agent; the card's Move to… In progress,
//   then Blocked with a reason (the tile and Home's waiting list say why); Answer puts it back in progress. The agent
//   finishes it: it waits for the person (live, no reload); Send back with a reason — the agent's `task mine` reads that
//   reason; the agent finishes again; Confirm: Done, the project at 100 %. On a desk also Alt+→ on a second card's
//   title moves it a column. A phone never scrolls sideways.
// - the public link (each case's board, same look): the read-only note, no write control anywhere (Home, the project,
//   the card), tiles not draggable, Alt+→ does nothing, and a write sent anyway is refused — the old task list's
//   create too.
// Every page logs no error (CSP violations included).
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2246-task-board.mts
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bootFixture, caseName, freshPage, labelOf, matrix, mounted, openPublicLink, shotPath, type FreshPage, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2246-task-board";
const REPO = process.env.REPO!;
const AGENT = "search-indexer";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48460) });
const fm = fx.fm;
// Demo names only in what is shot (the fixture's first instances are a real fleet's).
const DEMO = new Set([AGENT, "billing-reconciliation", "observability-dashboards"]);
for (const name of Object.keys(fm.fleetConfig.instances)) if (!DEMO.has(name)) delete fm.fleetConfig.instances[name];

const { Scheduler } = await import(REPO + "/src/scheduler/index.ts");
const { DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");
const { boardToolAction } = await import(REPO + "/src/task-board-tool.ts");
/** An empty board for each case: the fleet's scheduler on a database of its own (no timers started). */
function freshBoard(c: MatrixCase) {
  fm.scheduler?.db.close();
  fm.scheduler = new Scheduler(join(fm.dataDir, `scheduler-${caseName(c)}.db`), () => {}, DEFAULT_SCHEDULER_CONFIG, (n: string) => !!fm.fleetConfig.instances[n]);
  (fm as any).attachTaskBoard(fm.scheduler.db);
  return fm.scheduler.db;
}
const agent = (db: any, args: Record<string, unknown>) => boardToolAction(db, AGENT, args) as string;

async function clickVisible(page: any, selector: string, timeout = 10000): Promise<void> {
  const all = page.locator(selector), end = Date.now() + timeout;
  do {
    for (let i = 0; i < await all.count(); i++) if (await all.nth(i).isVisible()) { await all.nth(i).click(); return; }
    await page.waitForTimeout(100);
  } while (Date.now() < end);
  await page.screenshot({ path: shotPath(SMOKE, "failure", "nothing-visible") }).catch(() => {});
  throw new Error(`nothing visible matches ${selector} on ${page.url()}`);
}
/** Fleet from the navigation (the sidebar, or the phone's tab bar) — from defaults it opens on the Org chart — then its Tasks tab. */
async function openTasks(p: FreshPage): Promise<void> {
  await mounted(p.page);
  await clickVisible(p.page, 'a[href="/ui/fleet/org"]');
  await p.page.waitForURL("**/ui/fleet/org", { timeout: 10000 });
  await clickVisible(p.page, '.seg a[href="/ui/fleet"]');
  await p.page.waitForURL("**/ui/fleet", { timeout: 10000 });
  await p.page.waitForSelector(".tb-home", { timeout: 10000 });
}
/** The topmost open dialog (the app's ask sits above a card). */
const top = (page: any) => page.locator("dialog[open]").last();
async function answerAsk(page: any, text: string): Promise<void> {
  await page.waitForSelector("dialog[open] textarea", { timeout: 10000 });
  await top(page).locator("textarea").fill(text);
  await top(page).locator(".btn-primary").click();
}
const statusOf = (db: any, code: string) => db.board.getCard(code).status as string;
async function until(fn: () => boolean | Promise<boolean>, ms = 10000): Promise<boolean> {
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

const link = await openPublicLink(fx);
for (const c of matrix()) {
  const name = caseName(c);
  const db = freshBoard(c);
  const project = labelOf(c, { en: "Leaderboard", zh: "排行榜" });
  const title = labelOf(c, { en: "Serve the weekly leaderboard", zh: "提供每週排行榜" });
  const blockReason = labelOf(c, { en: "Which scores count: ranked games only?", zh: "哪些分數算數：只算排位賽嗎？" });
  const answer = labelOf(c, { en: "Ranked games only.", zh: "只算排位賽。" });
  const sendBack = labelOf(c, { en: "Ties must share a rank.", zh: "同分要同名次。" });
  const phone = c.device === "phone";
  const p = await freshPage(fx, c, phone ? { origin: "lan", reducedMotion: true } : {});
  const chk: Record<string, boolean> = {};
  try {
    await openTasks(p);
    chk.emptyFromDefaults = await p.page.locator(".tb-home .empty").isVisible() && (await p.page.locator(".tb-project").count()) === 0;
    await p.page.screenshot({ path: shotPath(SMOKE, c, "1-empty") });

    // New project.
    await clickVisible(p.page, ".tb-home .list-head .btn-primary");
    await top(p.page).locator("input").first().fill(project);
    await top(p.page).locator(".btn-primary").click();
    // A new project opens on its (empty) board.
    await p.page.waitForSelector(`.tb-board-page .tb-title h2:text-is("${project}")`, { timeout: 10000 });
    chk.projectCreated = db.board.listProjects().some((x: any) => x.name === project);
    await p.page.screenshot({ path: shotPath(SMOKE, c, "1b-new-project") });

    // A main task for the agent. Creating opens the card.
    await clickVisible(p.page, ".tb-bar-head .btn-primary");
    await top(p.page).locator("input").first().fill(title);
    await top(p.page).locator(".tb-form-row select").first().selectOption(AGENT);
    await top(p.page).locator(".btn-primary").click();
    await p.page.waitForSelector(".tc-actions", { timeout: 10000 });
    const code = db.board.boardCards().find((x: any) => x.title === title)?.code as string;
    chk.cardCreated = !!code && db.board.getCard(code).assignee === AGENT && db.board.getCard(code).needsReview === true;

    // Move to… In progress, then Blocked with a reason.
    await top(p.page).locator(".tc-actions select.tb-select").selectOption("claimed");
    chk.movedInProgress = await until(() => statusOf(db, code) === "claimed");
    await p.page.waitForFunction(() => !!document.querySelector('dialog[open] .tc-actions select.tb-select option[value="blocked"]'), null, { timeout: 10000 });
    await top(p.page).locator(".tc-actions select.tb-select").selectOption("blocked");
    await answerAsk(p.page, blockReason);
    chk.blocked = await until(() => statusOf(db, code) === "blocked" && db.board.getCard(code).blockedReason === blockReason);
    await p.page.keyboard.press("Escape");
    await p.page.waitForSelector(`[data-tile="${code}"] .tb-tile-note.st-blocked`, { timeout: 10000 });
    chk.tileSaysWhy = ((await p.page.locator(`[data-tile="${code}"] .tb-tile-note`).textContent()) ?? "").includes(blockReason);
    await p.page.screenshot({ path: shotPath(SMOKE, c, "2-blocked-tile") });
    if (phone) chk.phoneBoardNoSideScroll = await noSideScroll(p.page);

    // Home: the blocked card waits for an answer; answering puts it back in progress.
    await clickVisible(p.page, ".tb-bar-head .btn-ghost");
    await p.page.waitForSelector(".tb-wait-row", { timeout: 10000 });
    chk.homeSaysWhy = ((await p.page.locator(".tb-wait-row .tb-wait-reason").textContent()) ?? "").includes(blockReason);
    await p.page.screenshot({ path: shotPath(SMOKE, c, "3-home-blocked") });
    await clickVisible(p.page, ".tb-wait-row .btn-primary");
    await answerAsk(p.page, answer);
    chk.answered = await until(() => statusOf(db, code) === "claimed" && db.board.detail(code).comments.some((e: any) => e.text.includes(answer)));

    // The agent finishes it: it waits for the person, on the page without a reload.
    const done1 = agent(db, { action: "move", id: code, to: "done", result: labelOf(c, { en: "GET /leaderboard/weekly, 40 ms", zh: "GET /leaderboard/weekly，40 ms" }) });
    chk.agentToldItWaits = statusOf(db, code) === "review" && /waiting for the person/.test(done1);
    await p.page.waitForSelector(".tb-wait-row .btn-primary:not([disabled])", { timeout: 10000 });
    chk.liveReview = (await p.page.locator(".tb-wait-row .tb-pill, .tb-wait-row .pill").first().textContent() ?? "").length > 0;
    await p.page.screenshot({ path: shotPath(SMOKE, c, "4-home-review") });

    // Send back with a reason: the agent reads it through the tool.
    await clickVisible(p.page, ".tb-wait-row .btn:not(.btn-primary)");
    await answerAsk(p.page, sendBack);
    chk.sentBack = await until(() => statusOf(db, code) === "claimed");
    const mine = agent(db, { action: "mine" });
    chk.agentReadsReason = mine.includes("sent back to you") && mine.includes(sendBack);
    const get = agent(db, { action: "get", id: code });
    chk.agentGetShowsReason = get.includes("(sent back)") && get.includes(sendBack);

    // Finished again; the person confirms: Done, and the project is complete.
    agent(db, { action: "move", id: code, to: "done", result: labelOf(c, { en: "Ties share a rank now", zh: "同分已同名次" }) });
    await p.page.waitForSelector(".tb-wait-row .btn-primary:not([disabled])", { timeout: 10000 });
    await clickVisible(p.page, ".tb-wait-row .btn-primary");
    chk.confirmed = await until(() => statusOf(db, code) === "done");
    await p.page.waitForSelector(".tb-wait-row", { state: "detached", timeout: 10000 });
    chk.projectComplete = await until(async () => ((await p.page.locator(".tb-project .tb-pct").first().textContent()) ?? "") === "100%");
    await p.page.screenshot({ path: shotPath(SMOKE, c, "5-home-done") });

    // Desk: a second card moved from the keyboard.
    if (!phone) {
      await clickVisible(p.page, ".tb-project-open");
      await clickVisible(p.page, ".tb-bar-head .btn-primary");
      await top(p.page).locator("input").first().fill("Archive last season");
      await top(p.page).locator(".btn-primary").click();
      await p.page.waitForSelector(".tc-actions", { timeout: 10000 });
      await p.page.keyboard.press("Escape");
      const second = db.board.boardCards().find((x: any) => x.title === "Archive last season")?.code as string;
      await p.page.locator(`[data-tile="${second}"] .tb-tile-title`).focus();
      await p.page.keyboard.press("Alt+ArrowRight");
      chk.altArrowMoves = await until(() => statusOf(db, second) === "claimed");
      await p.page.waitForSelector(`.tb-col.st-claimed [data-tile="${second}"]`, { timeout: 10000 });
      // The focus goes back to the moved card's title once it is drawn in its new place (an effect after that render).
      chk.focusVisibleOnTitle = await p.page.waitForFunction(() => document.activeElement?.classList.contains("tb-tile-title") ?? false, null, { timeout: 3000 }).then(() => true, () => false);
      await p.page.screenshot({ path: shotPath(SMOKE, c, "6-keyboard-moved") });
      await clickVisible(p.page, ".tb-bar-head .btn-ghost");
    }
  } catch (e) {
    chk.ranToTheEnd = false;
    console.log(String(e).slice(0, 500));
    await p.page.screenshot({ path: shotPath(SMOKE, c, "failure") }).catch(() => {});
  }
  chk.noErrors = p.errors.length === 0;
  record(name, chk, p.errors);
  await p.ctx.close();

  // The same board over the temporary public link: shown, never changed.
  const pp = await link.publicPage(c, { reducedMotion: phone, path: "/ui/fleet" });
  const pchk: Record<string, boolean> = {};
  try {
    await pp.page.waitForSelector(".tb-readonly", { timeout: 15000 });
    await pp.page.waitForSelector(".tb-project", { timeout: 10000 });
    pchk.readOnlyNote = ((await pp.page.locator(".tb-readonly").textContent()) ?? "").length > 10;
    pchk.noNewProject = (await pp.page.locator(".tb-home .list-head .btn-primary").count()) === 0;
    await pp.page.screenshot({ path: shotPath(SMOKE, c, "7-public-home") });
    await clickVisible(pp.page, ".tb-project-open");
    await pp.page.waitForSelector(".tb-tile", { timeout: 10000 });
    pchk.noNewMainTask = (await pp.page.locator(".tb-bar-head .btn-primary").count()) === 0;
    pchk.notDraggable = (await pp.page.locator('.tb-tile[draggable="true"]').count()) === 0;
    const before = JSON.stringify(db.board.boardCards().map((x: any) => [x.code, x.status, x.sort]));
    const tile = pp.page.locator(".tb-tile-title").first();
    await tile.focus();
    await pp.page.keyboard.press("Alt+ArrowRight");
    await pp.page.waitForTimeout(500);
    pchk.keyboardChangesNothing = JSON.stringify(db.board.boardCards().map((x: any) => [x.code, x.status, x.sort])) === before;
    await tile.click();
    await pp.page.waitForSelector("dialog[open] .tc-actions", { timeout: 10000 });
    pchk.cardHasNoControls = (await pp.page.locator("dialog[open] .tc-actions select, dialog[open] .tc-actions .btn, dialog[open] .tc-composer").count()) === 0
      && (await pp.page.locator("dialog[open] .tc-meta select:not([disabled]), dialog[open] .tc-meta input:not([disabled])").count()) === 0;
    await pp.page.screenshot({ path: shotPath(SMOKE, c, "8-public-card") });
    const status = await pp.page.evaluate(async () => (await fetch("/ui/tasks/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "over the link" }) })).status);
    pchk.writeRefused = status >= 400 && !db.board.listProjects(true).some((x: any) => x.name === "over the link");
    // The old task list's create too (review round 2): it would open a card on the board.
    const cards = db.board.boardCards().length;
    const legacy = await pp.page.evaluate(async () => (await fetch("/ui/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "over the link" }) })).status);
    pchk.legacyCreateRefused = legacy >= 400 && db.board.boardCards().length === cards;
    if (phone) pchk.phoneNoSideScroll = await noSideScroll(pp.page);
  } catch (e) {
    pchk.ranToTheEnd = false;
    console.log(String(e).slice(0, 500));
    await pp.page.screenshot({ path: shotPath(SMOKE, c, "public-failure") }).catch(() => {});
  }
  // The refused write above is the smoke's own: its refusal (the gateway's 404, or the handler's 403) is expected,
  // nothing else is.
  const own = (e: string) => /status of 40[34]/.test(e) && /\/ui\/tasks(\/projects)?$/.test(e);
  pchk.writeRefusalLogged = pp.errors.filter(own).length === 2;
  pchk.noErrors = pp.errors.filter((e) => !own(e)).length === 0;
  record(`public-link-${name}`, pchk, pp.errors.filter((e) => !own(e)));
  await pp.ctx.close();
}
await link.close();
const bad = results.filter((r) => !r.ok);
writeFileSync(join(dirname(shotPath(SMOKE, "result", "x")), "result.json"), JSON.stringify(results, null, 2));
console.log(bad.length ? `FAIL ${bad.map((b) => b.name).join(", ")}` : "PASS");
await fx.close();
process.exit(bad.length ? 1 : 0);
