// #2246 step 2 from defaults (fleet decision a78ebdc5): agents working together on the task board, each case a fresh
// profile with nothing seeded and an empty board of its own, the person driven only through visible UI. The agents'
// steps are outside the page and go through the `task` tool (boardToolAction, as both of its doors do): a lead splits
// the person's main task into a step for a developer and a review step for a reviewer.
// - The developer blocks on a question: Home lists it, marked as asked of the lead first; the lead answers on the card.
// - The developer finishes; the reviewer takes the review step: the main task's tile shows who works on it now (the
//   reviewer, not the lead who owns it) and the card's Now and Dispatched by rows.
// - The reviewer finishes: the main task reaches the person not wrapped up — To fill in on its tile, what is missing on
//   Home; Confirm asks first, Confirm anyway with a note confirms it.
// - The wakes (first case): the lead's question and confirmation, the developer's answer, the reviewer's ready —
//   each a "[Task board]" notice from AgEnD in the delivery outbox. The gathering window is shortened for the smoke.
// A phone never scrolls sideways. Every page logs no error (CSP violations included).
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2246-agents.mts
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bootFixture, caseName, freshPage, labelOf, matrix, mounted, shotPath, type FreshPage, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2246-agents";
const REPO = process.env.REPO!;
const LEAD = "observability-dashboards", DEV = "search-indexer", REVIEWER = "billing-reconciliation";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48470) });
const fm = fx.fm;
// Demo names only in what is shot (the fixture's first instances are a real fleet's).
for (const name of Object.keys(fm.fleetConfig.instances)) if (![LEAD, DEV, REVIEWER].includes(name)) delete fm.fleetConfig.instances[name];

const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");
const { boardToolAction } = await import(REPO + "/src/task-board-tool.ts");
const Database = createRequire(join(REPO, "package.json"))("better-sqlite3");
function freshBoard(c: MatrixCase) {
  fm.scheduler?.db.close();
  fm.scheduler = new Scheduler(join(fm.dataDir, `scheduler-agents-${caseName(c)}.db`), () => {}, DEFAULT_SCHEDULER_CONFIG, (n: string) => !!fm.fleetConfig.instances[n]);
  (fm as any).attachTaskBoard(fm.scheduler.db);
  (fm as any).taskBoardWaker.deps.gatherMs = 300;            // the smoke's only change: 10 s of gathering is the unit tests'
  return fm.scheduler.db;
}
const tool = (db: any, who: string, args: Record<string, unknown>) => {
  const r = boardToolAction(db, who, args);
  if (typeof r !== "string") throw new Error(`${who} ${JSON.stringify(args)}: ${JSON.stringify(r)}`);
  return r;
};
const notices = () => {
  const path = join(fm.dataDir, "delivery-outbox.db");
  let db: any;
  try { db = new Database(path, { readonly: true }); } catch { return []; }
  try {
    return (db.prepare("SELECT target_instance AS to_, payload_json FROM deliveries ORDER BY created_seq").all() as Array<{ to_: string; payload_json: string }>)
      .map((r) => ({ to: r.to_, ...JSON.parse(r.payload_json) as { content: string; meta: Record<string, string> } }))
      .filter((n) => n.content.startsWith("[Task board]"));
  } finally { db.close(); }
};

async function clickVisible(page: any, selector: string, timeout = 10000): Promise<void> {
  const all = page.locator(selector), end = Date.now() + timeout;
  do {
    for (let i = 0; i < await all.count(); i++) if (await all.nth(i).isVisible()) { await all.nth(i).click(); return; }
    await page.waitForTimeout(100);
  } while (Date.now() < end);
  await page.screenshot({ path: shotPath(SMOKE, "failure", "nothing-visible") }).catch(() => {});
  throw new Error(`nothing visible matches ${selector} on ${page.url()}`);
}
async function openTasks(p: FreshPage): Promise<void> {
  await mounted(p.page);
  await clickVisible(p.page, 'a[href="/ui/fleet/org"]');
  await p.page.waitForURL("**/ui/fleet/org", { timeout: 10000 });
  await clickVisible(p.page, '.seg a[href="/ui/fleet"]');
  await p.page.waitForURL("**/ui/fleet", { timeout: 10000 });
  await p.page.waitForSelector(".tb-home", { timeout: 10000 });
}
const top = (page: any) => page.locator("dialog[open]").last();
const text = async (page: any, sel: string) => ((await page.locator(sel).first().textContent()) ?? "").replace(/\s+/g, " ").trim();
async function until(fn: () => boolean | Promise<boolean>, ms = 10000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return false;
}

const results: Array<{ name: string; ok: boolean; failed: string[]; errors: string[] }> = [];
let first = true;
for (const c of matrix()) {
  const name = caseName(c);
  const db = freshBoard(c);
  const phone = c.device === "phone";
  const p = await freshPage(fx, c, phone ? { origin: "lan", reducedMotion: true } : {});
  const chk: Record<string, boolean> = {};
  const project = labelOf(c, { en: "Leaderboard", zh: "排行榜" });
  const title = labelOf(c, { en: "Weekly leaderboard", zh: "每週排行榜" });
  try {
    await openTasks(p);
    // The person: a project. Asked in the chat, the lead opens the main task in it and splits it: a step for the
    // developer, then a review step for the reviewer — it hands them out (their dispatcher).
    await clickVisible(p.page, ".tb-home .list-head .btn-primary");
    await top(p.page).locator("input").first().fill(project);
    await top(p.page).locator(".btn-primary").click();
    await p.page.waitForSelector(".tb-board-page", { timeout: 10000 });
    tool(db, LEAD, { action: "create", project, title, acceptance: labelOf(c, { en: "Resets every Monday|Top 100", zh: "每週一重置|前 100 名" }).split("|") });
    const main = db.board.boardCards().find((x: any) => x.title === title)!;
    tool(db, LEAD, { action: "create", parent: main.code, title: labelOf(c, { en: "Build the API", zh: "做 API" }), assignee: DEV });
    tool(db, LEAD, { action: "create", parent: main.code, title: labelOf(c, { en: "Review the API", zh: "審核 API" }), assignee: REVIEWER, depends_on: ["S-1"] });
    chk.leadDispatches = db.board.getCard("S-1").dispatcher?.name === LEAD && db.board.getCard("S-2").dispatcher?.name === LEAD;
    await p.page.waitForSelector(`[data-tile="${main.code}"]`, { timeout: 10000 });     // live, no reload

    // The developer starts, then blocks on a question: Home lists it as asked of the lead first.
    tool(db, DEV, { action: "move", id: "S-1", to: "claimed" });
    tool(db, DEV, { action: "move", id: "S-1", to: "blocked", reason: labelOf(c, { en: "Ties: same rank or by time?", zh: "同分：同名次還是比時間？" }) });
    await clickVisible(p.page, ".tb-bar-head .btn-ghost");
    await p.page.waitForSelector(".tb-wait-asked", { timeout: 10000 });
    chk.askedFirstShown = (await text(p.page, ".tb-wait-asked")).includes(LEAD);
    await p.page.screenshot({ path: shotPath(SMOKE, c, "1-home-asked-first") });
    tool(db, LEAD, { action: "move", id: "S-1", to: "claimed", reason: labelOf(c, { en: "Same rank, the person says", zh: "主人說同分同名次" }) });
    await p.page.waitForSelector(".tb-wait-asked", { state: "detached", timeout: 10000 });
    chk.answeredLive = db.board.getCard("S-1").status === "claimed";
    // The developer reads the answer (its notice goes out) before it goes on: news finished meanwhile is left out.
    if (first) await until(() => notices().some((n) => n.to === DEV && /answered/.test(n.content)), 5000);

    // The developer finishes; the reviewer takes the review: the tile shows who works on it now.
    tool(db, DEV, { action: "move", id: "S-1", to: "done", result: "GET /leaderboard/weekly" });
    // The reviewer starts once told it can (#2303 review: a "ready" that is no longer open by the time it goes out is
    // left out — started already, it is not news).
    if (first) await until(() => notices().some((n) => n.to === REVIEWER && /everything it waited for is done/.test(n.content)), 5000);
    tool(db, REVIEWER, { action: "move", id: "S-2", to: "claimed" });
    await clickVisible(p.page, ".tb-project-open");
    const tile = `[data-tile="${main.code}"]`;
    chk.nowShowsReviewStep = await until(async () => (await p.page.locator(`${tile} .tb-tile-now`).count()) > 0 && (await text(p.page, `${tile} .tb-tile-now`)).includes("S-2"));
    chk.footShowsReviewer = (await text(p.page, `${tile} .tb-tile-foot .tb-who`)) === REVIEWER;
    await p.page.screenshot({ path: shotPath(SMOKE, c, "2-tile-who-works-now") });
    await p.page.locator(`${tile} .tb-tile-title`).click();
    await p.page.waitForSelector("dialog[open] .tc-now", { timeout: 10000 });
    chk.cardNowRow = (await text(p.page, "dialog[open] .tc-now")).includes(REVIEWER);
    chk.cardDispatcherRow = (await p.page.locator("dialog[open] .tc-meta").textContent() ?? "").includes(labelOf(c, { en: "Dispatched by", zh: "派工" }));
    await p.page.screenshot({ path: shotPath(SMOKE, c, "3-card-now-dispatcher") });
    await p.page.keyboard.press("Escape");

    // The reviewer finishes: the main task reaches the person not wrapped up.
    tool(db, REVIEWER, { action: "move", id: "S-2", to: "done", result: labelOf(c, { en: "Looks good", zh: "沒問題" }) });
    await p.page.waitForSelector(`${tile} .tb-tag.wrapup`, { timeout: 10000 });
    chk.toFillInTag = (await text(p.page, `${tile} .tb-tag.wrapup`)) === labelOf(c, { en: "To fill in", zh: "待補齊" });
    await clickVisible(p.page, ".tb-bar-head .btn-ghost");
    await p.page.waitForSelector(".tb-wait-reason.wrapup", { timeout: 10000 });
    chk.homeSaysWhatIsMissing = (await text(p.page, ".tb-wait-reason.wrapup")).length > 5;
    await clickVisible(p.page, ".tb-wait-row .btn-primary");
    await p.page.waitForSelector("dialog[open] textarea", { timeout: 10000 });
    await p.page.screenshot({ path: shotPath(SMOKE, c, "4-confirm-asks-first") });
    await top(p.page).locator("textarea").fill(labelOf(c, { en: "Fine for now", zh: "先這樣" }));
    chk.confirmAnywayLabel = (await top(p.page).locator(".btn-primary").textContent()) === labelOf(c, { en: "Confirm anyway", zh: "還是確認" });
    await top(p.page).locator(".btn-primary").click();
    chk.confirmed = await until(() => db.board.getCard(main.code).status === "done");
    if (phone) chk.noSideScroll = await p.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

    // The wakes, once: AgEnD's notices in the outbox.
    if (first) {
      first = false;
      await until(() => notices().some((n) => n.to === LEAD && /confirmed/.test(n.content)), 5000);
      const all = notices();
      const to = (who: string) => all.filter((n) => n.to === who).map((n) => n.content).join("\n");
      chk.leadAskedTheQuestion = /you handed it out and it is blocked/.test(to(LEAD));
      chk.devHeardTheAnswer = /answered your blocked question: "Same rank, the person says"/.test(to(DEV));
      chk.reviewerReady = /everything it waited for is done/.test(to(REVIEWER));
      chk.leadToldToWrapUp = /went to the person for confirmation by itself, but 2 definition-of-done items unchecked, no result/.test(to(LEAD));
      chk.leadHeardConfirmation = /the person confirmed it: "Fine for now"/.test(to(LEAD));
      chk.fromAgendNotAPerson = all.length > 0 && all.every((n) => n.meta.user === "AgEnD" && n.meta.source === "agend-system");
      writeFileSync(join(dirname(shotPath(SMOKE, "notices", "x")), "notices.txt"), all.map((n) => `→ ${n.to}\n${n.content}\n`).join("\n"));
    }
  } catch (e) {
    chk.ranToTheEnd = false;
    console.log(String(e).slice(0, 500));
    await p.page.screenshot({ path: shotPath(SMOKE, c, "failure") }).catch(() => {});
  }
  chk.noErrors = p.errors.length === 0;
  const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
  results.push({ name, ok: !failed.length, failed, errors: p.errors });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${name}${failed.length ? ` [${failed.join(", ")}] ${JSON.stringify(p.errors).slice(0, 600)}` : ""}`);
  await p.ctx.close();
}
const bad = results.filter((r) => !r.ok);
writeFileSync(join(dirname(shotPath(SMOKE, "result", "x")), "result.json"), JSON.stringify(results, null, 2));
console.log(bad.length ? `FAIL ${bad.map((b) => b.name).join(", ")}` : "PASS");
await fx.close();
process.exit(bad.length ? 1 : 0);
