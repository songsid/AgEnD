// A task card shows what its agent is doing — the evidence for the pull request. Each matrix case (desk 1366 /
// phone 390 × light / dark × English / zh-TW) opens a fresh browser profile on a board seeded as in smoke-task-page
// (two projects, main tasks in every status, sub tasks, comments, a log), plus the work the fixture's four instances are in the
// middle of: one with a card in progress and working, one working on the card of another project, one with TWO cards in
// progress (board_cards_at_once: 2) and working, one idle with its card in review. It signs in through the real /signin and
// drives only visible UI. The fixture has no running agent: instance states are set through the fleet manager's own cache
// (cacheInstanceExecutionState — the call a daemon's report makes, which emits the stream's `activity` event), and the steps
// feed answers with steps a Claude transcript parses to (the product's own ClaudeStepParser), as GET /ui/steps would.
//   LAYOUT=after (default): the board and the list with their "Running" / "Busy · 2 cards" marks, a card in progress (state,
//   live steps, Open conversation), a card whose assignee has two in progress (the note), the timeline's Agent tags, the mark
//   following the instance's state live (idle → gone → working → back), and Open conversation landing on the instance's chat.
//   SEED_REPO=<checkout of main>: the board is written by that checkout's code and read by REPO's (the compatibility run).
// Every page logs no error (CSP violations included); nothing scrolls sideways.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-task-agent-run.mts
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bootFixture, caseName, freshPage, labelOf, matrix, mounted, shotPath, type FreshPage, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = `smoke-task-agent-run-${process.env.SEED_REPO ? "compat" : "after"}`;
const REPO = process.env.REPO!;
console.log("board written by", process.env.SEED_REPO ?? REPO, "- read by", REPO);
const fx = await bootFixture({ port: Number(process.env.HP ?? 48490) });
const fm = fx.fm;
const AGENT = "search-indexer", AGENT2 = "billing-reconciliation", AGENT3 = "observability-dashboards", AGENT4 = "docs-writer";
const DEMO = new Set([AGENT, AGENT2, AGENT3, AGENT4]);
for (const name of Object.keys(fm.fleetConfig.instances)) if (!DEMO.has(name)) delete fm.fleetConfig.instances[name];
for (const name of DEMO) if (!fm.fleetConfig.instances[name]) fm.fleetConfig.instances[name] = { ...Object.values(fm.fleetConfig.instances)[0] as object, working_directory: fx.dir };
// docs-writer may have two cards in progress at once (the default is one): which one it is on is then not known.
fm.fleetConfig.instances[AGENT4].board_cards_at_once = 2;

const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");
const { ClaudeStepParser } = await import(REPO + "/src/log-steps.ts");
const Writer = process.env.SEED_REPO ? (await import(process.env.SEED_REPO + "/src/scheduler/index.ts")).Scheduler : Scheduler;
const writerConfig = process.env.SEED_REPO ? (await import(process.env.SEED_REPO + "/src/scheduler/index.ts")).DEFAULT_SCHEDULER_CONFIG : DEFAULT_SCHEDULER_CONFIG;
const known = (n: string) => !!fm.fleetConfig.instances[n];
const PERSON = { kind: "person" as const, name: "Demo Person" };
const inst = (name: string) => ({ kind: "instance" as const, name });

/** The steps a Claude Code transcript parses to, ending in a command still running — as the steps feed answers while an agent works. */
function demoSteps(c: MatrixCase) {
  const now = Date.now();
  const L = (en: string, zh: string) => labelOf(c, { en, zh });
  const line = (agoMs: number, content: unknown[]) => JSON.stringify({ type: "assistant", uuid: `u${agoMs}`, timestamp: new Date(now - agoMs).toISOString(), message: { role: "assistant", content } });
  const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
  const result = (agoMs: number, id: string, text: string) => JSON.stringify({ type: "user", uuid: `r${agoMs}`, timestamp: new Date(now - agoMs).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
  const lines = [
    line(240_000, [use("t1", "Read", { file_path: "/home/demo/search-indexer/src/scores/weekly.ts" })]), result(239_000, "t1", "…"),
    line(200_000, [use("t2", "Grep", { pattern: "rankOf(", path: "/home/demo/search-indexer/src" })]), result(199_000, "t2", "…"),
    line(150_000, [{ type: "text", text: L("The paging is the missing piece; I will add it to the scores endpoint next.", "缺的是分頁，接著把它加進分數端點。") }]),
    line(120_000, [use("t3", "Edit", { file_path: "/home/demo/search-indexer/src/scores/weekly.ts", old_string: "return all", new_string: "return page" })]), result(119_000, "t3", "ok"),
    line(60_000, [use("t4", "Bash", { command: "npm test -- weekly" })]), result(55_000, "t4", "ok"),
    line(8_000, [use("t5", "Bash", { command: "npm run build" })]),
  ];
  const p = new ClaudeStepParser({ thinking: false });
  lines.forEach((l, i) => p.push(l, i * 1000));
  return p.steps;
}

/** A board of its own for each case, seeded with some weeks of work (by SEED_REPO's code when given, then opened by REPO's). */
function seedBoard(c: MatrixCase) {
  fm.scheduler?.db.close();
  const file = join(fm.dataDir, `scheduler-${caseName(c)}.db`);
  const writer = new Writer(file, () => {}, writerConfig, known);
  // The fleet attaches the board after the seed below: its limit of cards in progress at once is read from fleet.yaml here too.
  writer.db.board.setCardLimit?.((n: string) => fm.fleetConfig.instances[n]?.board_cards_at_once ?? 1);
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
      acceptance: [L("Ties share a rank", "同分同名次"), L("The page answers in under 300 ms", "頁面 300 ms 內回應"), L("Ranked games only", "只算排位賽")] },
    { title: L("Add the shop", "新增商店"), assignee: AGENT2, priority: "normal", size: "L", goal: L("Players spend coins on badges.", "玩家可以用金幣買徽章。") },
    { title: L("Choose the badge", "挑選徽章"), assignee: AGENT3, priority: "urgent", goal: L("Pick the badge art for the season.", "選定本季徽章圖樣。"), acceptance: [L("Three options compared", "比較三個方案")] },
    { title: L("Bootstrap the score store", "建立分數儲存"), assignee: AGENT2, priority: "low", size: "S" },
    { title: L("Write the season rules", "撰寫賽季規則"), assignee: AGENT4, priority: "urgent", size: "S", goal: L("Players know how a season is scored.", "玩家知道賽季怎麼計分。") },
  ] }).cards;
  const [m1, m2, m3, m4, m5] = cards.map((x: any) => x.code);
  b.createCards(PERSON, { parent: m1, cards: [
    { title: L("Define the ranking rules", "訂定排名規則"), assignee: AGENT },
    { title: L("Build the scores API", "建立分數 API"), assignee: AGENT, acceptance: [L("GET /scores/weekly", "GET /scores/weekly"), L("Paged", "分頁")] },
    { title: L("Leaderboard page", "排行榜頁面"), assignee: AGENT4 },
  ] });
  b.createCards(PERSON, { parent: m2, cards: [{ title: L("Price list", "價目表"), assignee: AGENT2 }, { title: L("Checkout flow", "結帳流程"), assignee: AGENT2 }] });
  const billing = b.createCards(PERSON, { project: bill.name, cards: [
    { title: L("Reconcile October invoices", "對 10 月發票"), assignee: AGENT2, priority: "high", goal: L("Every invoice matches a payment.", "每張發票都對得到一筆付款。") },
    { title: L("Draft the dunning emails", "撰寫催款信"), assignee: AGENT4, priority: "normal" },
  ] }).cards.map((x: any) => x.code);
  const run = (what: string, fn: () => unknown) => { try { fn(); } catch (e) { console.log(`seed ${what}: ${String(e).slice(0, 160)}`); } };
  run("m4 done", () => { b.moveCard(inst(AGENT2), m4, "claimed"); b.moveCard(inst(AGENT2), m4, "review", { result: "ok" }); b.moveCard(PERSON, m4, "done"); });
  run("s1 claim", () => b.moveCard(inst(AGENT), "S-1", "claimed"));
  run("s1 done", () => b.moveCard(inst(AGENT), "S-1", "done", { result: L("Rules agreed: ties share a rank.", "規則已確認：同分同名次。") }));
  run("s2 claim", () => b.moveCard(inst(AGENT), "S-2", "claimed"));
  run("log s2", () => b.updateCard(inst(AGENT), "S-2", { log: L("Endpoint skeleton done, paging next", "端點骨架完成，接著做分頁"), check: [1] }));
  run("comment person", () => b.updateCard(PERSON, "S-2", { comment: L("Please keep it under 300 ms even on a cold cache.", "冷快取時也請維持在 300 ms 內。") }));
  run("comment agent", () => b.updateCard(inst(AGENT), "S-2", { comment: L("Understood — I will measure the cold path first.", "了解，我會先量冷路徑。") }));
  run("m3 review", () => { b.moveCard(inst(AGENT3), m3, "claimed"); b.updateCard(inst(AGENT3), m3, { check: [1] }); b.moveCard(inst(AGENT3), m3, "review", { result: L("Three badge options in the shared folder; B recommended.", "共用資料夾有三個徽章方案，建議 B。") }); });
  run("reconcile claim", () => b.moveCard(inst(AGENT2), billing[0], "claimed"));
  run("log reconcile", () => b.updateCard(inst(AGENT2), billing[0], { log: L("Matched 212 of 240 invoices", "已對上 240 張中的 212 張") }));
  // docs-writer has two cards in progress.
  run("m5 claim", () => b.moveCard(inst(AGENT4), m5, "claimed"));
  run("dunning claim", () => b.moveCard(inst(AGENT4), billing[1], "claimed"));
  return { lb, ids: { m1, m2, m3, m5, reconcile: billing[0], dunning: billing[1] } };
}

/** The claim happened a while ago, not a moment before the page opened (the steps the card shows are the ones since it). */
function backdateClaims(db: any, minutes: number) {
  const at = new Date(Date.now() - minutes * 60_000).toISOString();
  (db as any).db.prepare("UPDATE task_events SET at = ? WHERE type = 'moved' AND json_extract(data, '$.to') = 'claimed'").run(at);
}

const cacheState = (name: string, state: "working" | "idle") => fm.cacheInstanceExecutionState(name, { state, observedAt: Date.now(), stateChangedAt: Date.now() - 300_000 });

async function clickVisible(page: any, selector: string, timeout = 10000): Promise<void> {
  const all = page.locator(selector), end = Date.now() + timeout;
  do {
    for (let i = 0; i < await all.count(); i++) if (await all.nth(i).isVisible()) { await all.nth(i).click(); return; }
    await page.waitForTimeout(100);
  } while (Date.now() < end);
  throw new Error(`nothing visible matches ${selector}`);
}
async function until(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return false;
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
  backdateClaims(db, 14);
  const phone = c.device === "phone";
  // The fixture has no running agent: what each instance is doing, and the steps its transcript would parse to.
  for (const n of DEMO) cacheState(n, "idle");
  cacheState(AGENT, "working"); cacheState(AGENT2, "working"); cacheState(AGENT4, "working");
  const stepsAt = new Map<string, number>();
  fm.logSteps = async (instance: string, q: any) => {
    stepsAt.set(instance, (stepsAt.get(instance) ?? 0) + 1);
    return { enabled: true, instance, backend: "claude-code", supported: true, thinking: false, level: "standard", cwd: `/home/demo/${instance}`, home: "/home/demo",
      steps: demoSteps(c), after: 1000, key: "1-1", before: null, ev: 0, ...(q.watch ? {} : {}) };
  };
  const p = await freshPage(fx, c, phone ? { origin: "lan", reducedMotion: true } : {});
  const page = p.page;
  const shot = (n: string) => page.screenshot({ path: shotPath(SMOKE, c, n) });
  const running = labelOf(c, { en: "Running", zh: "執行中" });
  const busy = labelOf(c, { en: "Busy · 2 cards", zh: "忙碌中 · 2 張卡" });
  const chk: Record<string, boolean> = {};
  try {
    await openTasks(p);
    await clickVisible(page, `.tb-project-open:has-text("${lb.name}")`);
    await page.waitForSelector(".tb-board-page", { timeout: 10000 });
    await page.waitForTimeout(600);
    // The board: the main task whose sub task is running says so; docs-writer's two cards say they are busy; the idle one's says nothing.
    if (phone) { await clickVisible(page, ".tb-status-seg button:has(.st-claimed)"); await page.waitForTimeout(200); }
    const markText = async (sel: string) => ((await page.locator(`${sel} .tr-mark`).first().textContent().catch(() => null)) ?? "").trim();
    chk.boardMainSaysRunning = (await markText(`[data-tile="${ids.m1}"]`)) === running;
    chk.boardNoMarkWhenIdle = (await page.locator(`[data-tile="${ids.m3}"] .tr-mark`).count()) === 0;
    chk.boardRunningTileMarked = await page.locator(`[data-tile="${ids.m1}"].running`).count() === 1;
    await shot("1-board");
    if (phone) chk.phoneBoardNoSideScroll = await noSideScroll(page);
    if (phone) { await page.locator(".tb-status-seg button:has(.st-claimed)").first().click(); await page.waitForTimeout(100); }
    chk.boardSharedSaysBusy = (await markText(`[data-tile="${ids.m5}"]`)) === busy && (await page.locator(`[data-tile="${ids.m5}"].running`).count()) === 0;

    // The list.
    await clickVisible(page, ".tb-view-toggle button:nth-child(2)");
    await page.waitForSelector(".tb-list", { timeout: 10000 });
    await page.waitForTimeout(300);
    chk.listRowSaysRunning = (await markText(`[data-row="${ids.m1}"]`)) === running;
    chk.listSharedRowSaysBusy = (await markText(`[data-row="${ids.m5}"]`)) === busy;
    await shot("2-list");
    if (phone) chk.phoneListNoSideScroll = await noSideScroll(page);

    // The mark follows the instance's state live (the stream's `activity` event): idle → gone, working → back.
    cacheState(AGENT, "idle");
    chk.markGoesWhenIdle = await until(async () => (await page.locator(`[data-row="${ids.m1}"] .tr-mark`).count()) === 0);
    cacheState(AGENT, "working");
    chk.markComesBack = await until(async () => (await page.locator(`[data-row="${ids.m1}"] .tr-mark`).count()) === 1);

    // A card in progress: who, the state, the live steps, the way to the conversation. S-2 is the sub task search-indexer is on.
    await page.goto(`${p.base}/ui/fleet?tp=${lb.id}&card=S-2`);
    await page.waitForSelector(".tp-grid .tr-run", { timeout: 15000 });
    await page.waitForSelector(".tr-run .act-block.live", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);
    chk.cardHasAgentActivity = (await page.locator(".tr-run .tr-state").textContent().then((s: string) => s.trim()).catch(() => "")) === running;
    chk.cardSaysWhoHasIt = ((await page.locator(".tr-run .tb-who").first().textContent()) ?? "").trim() === AGENT;
    chk.cardShowsLiveSteps = (await page.locator(".tr-run .act-block.live").count()) === 1 && (stepsAt.get(AGENT) ?? 0) > 0;
    chk.cardBlockFollowsTheSpec = await page.evaluate(() => { const run = document.querySelector(".tp-body > .tr-run"), before = run?.previousElementSibling; return !!before && (before.classList.contains("tp-spec") || before.classList.contains("tp-adders")); });   // the agent's block comes after the spec the people wrote
    // Open the live block: the steps since the card was put in progress.
    await page.locator(".tr-run .act-sum").first().click().catch(() => {});
    await page.waitForTimeout(300);
    chk.liveStepsListed = (await page.locator(".tr-run .act-body .log-list li, .tr-run .act-body .log-list > *").count()) >= 3;
    await shot("3-card-running");
    if (phone) chk.phoneCardNoSideScroll = await noSideScroll(page);
    // The timeline marks what the agent did.
    chk.timelineTagsAgent = (await page.locator(".tl .tr-by").count()) >= 2 && (await page.locator(".tl-item.by-agent").count()) >= 2
      && (await page.locator(".tl-item:not(.by-agent)").count()) >= 1;
    await page.locator(".tl").scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await shot("4-timeline");
    // Open conversation lands on the instance's chat.
    const href = (await page.locator("a.tr-open").getAttribute("href")) ?? "";
    chk.openConversationLinksToChat = href === `/ui/chat/${AGENT}`;
    await page.locator("a.tr-open").click();
    chk.openConversationLands = await until(() => new URL(page.url()).pathname === `/ui/chat/${AGENT}`);
    await page.goBack().catch(() => {});
    await page.waitForSelector(".tp-grid", { timeout: 10000 }).catch(() => {});

    // A card whose assignee has two in progress: it cannot say which, and says so.
    await page.goto(`${p.base}/ui/fleet?tp=${lb.id}&card=${ids.m5}`);
    await page.waitForSelector(".tp-grid .tr-run", { timeout: 15000 });
    await page.waitForTimeout(500);
    chk.sharedCardSaysSo = ((await page.locator(".tr-run .tr-note").first().textContent()) ?? "").includes(labelOf(c, { en: "2 cards in progress", zh: "2 張卡在進行中" }));
    await shot("5-card-shared");

    // A card nobody's working on: a main task's page has no block of its own (its sub tasks' pages do); a card not in progress keeps the link only.
    await page.goto(`${p.base}/ui/fleet?tp=${lb.id}&card=${ids.m3}`);
    await page.waitForSelector(".tp-grid", { timeout: 15000 });
    await page.waitForTimeout(400);
    chk.reviewCardHasNoState = (await page.locator(".tr-run .tr-state").count()) === 0 && (await page.locator(".tr-run a.tr-open").count()) === 1;
    chk.noStepsReadForIdle = (stepsAt.get(AGENT3) ?? 0) === 0;
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
