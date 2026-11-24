// A task card in an instance's web chat — the evidence for the pull request. Each matrix case (desk 1366 / phone 390
// × light / dark × English / zh-TW) opens a fresh browser profile on a board seeded the way a fleet's board looks after some weeks
// (a project, main tasks in every status, sub tasks), signs in through the real /signin and drives only visible UI:
//   LAYOUT=after (default): in an agent's chat, `#` opens the list of cards (shot), typing narrows it, Enter puts `#M-1 ` in;
//   a second `#` and a choice; Send. The agent is handed the cards (the delivery is captured and read back); the conversation
//   shows both numbers as chips, an agent's reply that names a card stays text; a chip opens the card (Fleet › Tasks, ?card=).
//   LAYOUT=before: the same steps on a checkout before the feature — `#` opens nothing, the numbers stay text.
// Every page logs no error (CSP violations included); nothing scrolls sideways. The delivery is stubbed (no agent runs).
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf LAYOUT=after \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-task-chat-ref.mts
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bootFixture, caseName, freshPage, labelOf, matrix, mounted, shotPath, type FreshPage, type MatrixCase } from "../smoke-fixture/index.mts";

const AFTER = process.env.LAYOUT !== "before";
const SMOKE = `smoke-task-chat-ref-${AFTER ? "after" : "before"}`;
const REPO = process.env.REPO!;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48480), instances: 8, classic: false });
const fm = fx.fm;
const AGENT = fx.instances.find((i) => !i.general && (i.status ?? "running") === "running")!.name;
const AGENT2 = "billing-reconciliation", AGENT3 = "search-indexer";
for (const name of [AGENT2, AGENT3]) if (!fm.fleetConfig.instances[name]) fm.fleetConfig.instances[name] = { ...(fm.fleetConfig.instances[AGENT] as object) };

const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");
const known = (n: string) => !!fm.fleetConfig.instances[n];
const PERSON = { kind: "person" as const, name: "Demo Person" };
const inst = (name: string) => ({ kind: "instance" as const, name });

// The delivery to the agent, stubbed: what it would have been handed is kept and read back.
const delivered: Array<{ content: string }> = [];
fm.instanceIpcClients.set(AGENT, { connected: true, send: () => true });
fm.deliverHumanToInstance = async (_name: string, payload: { content: string }) => { delivered.push(payload); return true; };

/** A board of its own for each case. */
function seedBoard(c: MatrixCase) {
  fm.scheduler?.db.close();
  const file = join(fm.dataDir, `scheduler-${caseName(c)}.db`);
  fm.scheduler = new Scheduler(file, () => {}, DEFAULT_SCHEDULER_CONFIG, known);
  (fm as any).attachTaskBoard(fm.scheduler.db);
  const b = fm.scheduler.db.board;
  const L = (en: string, zh: string) => labelOf(c, { en, zh });
  const project = b.createProject(PERSON, { name: L("Leaderboard", "排行榜") });
  const mains = b.createCards(PERSON, { project: project.name, cards: [
    { title: L("Serve the weekly leaderboard", "提供每週排行榜"), assignee: AGENT, priority: "high" },
    { title: L("Add the shop", "新增商店"), assignee: AGENT2 },
    { title: L("Choose the badge art", "挑選徽章圖樣"), assignee: AGENT3 },
  ] }).cards;
  b.createCards(PERSON, { parent: mains[0].code, cards: [{ title: L("Build the scores API", "建立分數 API"), assignee: AGENT }, { title: L("Leaderboard page", "排行榜頁面"), assignee: AGENT }] });
  b.moveCard(inst(AGENT), "S-2", "claimed");   // a main task with sub tasks follows them: M-1 is in progress too
  b.moveCard(inst(AGENT3), mains[2].code, "claimed");
  b.moveCard(inst(AGENT3), mains[2].code, "review", { result: "ok" });
  return { m1: mains[0].code as string, s1: "S-1" };
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
  const { m1, s1 } = seedBoard(c);
  const phone = c.device === "phone";
  const p: FreshPage = await freshPage(fx, c, phone ? { origin: "lan", reducedMotion: true } : {});
  const page = p.page;
  const shot = (n: string) => page.screenshot({ path: shotPath(SMOKE, c, n) });
  const chk: Record<string, boolean> = {};
  const L = (en: string, zh: string) => labelOf(c, { en, zh });
  delivered.length = 0;
  fm.webChatHistory.forget(AGENT);   // a chat of its own for each case
  try {
    await mounted(page);
    await page.goto(`${p.base}/ui/chat/${encodeURIComponent(AGENT)}`);
    await page.waitForSelector("#msgIn", { timeout: 15000 });
    await page.waitForTimeout(600);
    const box = page.locator("#msgIn");
    await box.click();
    await page.keyboard.type(L("Please look at ", "請看 ") + "#");
    await page.waitForTimeout(AFTER ? 600 : 300);
    const listed = await page.locator(".task-ref-list li[role=option]").count();
    chk.listOpensOnHash = AFTER ? listed >= 3 : listed === 0;
    await shot("1-picker");
    if (AFTER) {
      chk.listHasStatusPills = (await page.locator(".task-ref-list .tb-pill").count()) === listed;
      await page.keyboard.type(L("weekly", "每週"));          // narrows to the weekly leaderboard
      await page.waitForTimeout(500);
      const shown = await page.locator(".task-ref-list li[role=option]").allInnerTexts();
      if (process.env.DEBUG298) console.log("narrowed to", JSON.stringify(shown), JSON.stringify(await box.inputValue()));
      chk.narrowed = shown.length === 1;
      // A phone has no Enter for this (it is a new line there): the row is tapped. Elsewhere Enter puts it in.
      if (phone) await page.locator(".task-ref-list li[role=option]").first().click(); else await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
      chk.enterPutsNumberIn = (await box.inputValue()).endsWith(`#${m1} `);
      chk.enterDidNotSend = delivered.length === 0;
      await page.keyboard.type(L(" and also #", " 還有 #"));
      await page.waitForSelector(".task-ref-list li[role=option]", { timeout: 5000 });
      await page.keyboard.type("S-1");
      await page.waitForTimeout(500);
      if (phone) await page.locator(".task-ref-list li[role=option]").first().click(); else await page.keyboard.press("Tab");
      await page.waitForTimeout(300);
      chk.tabPutsSecondIn = (await box.inputValue()).includes(`#${s1} `);
      chk.listClosesAfterChoice = (await page.locator(".task-ref-list").count()) === 0;
    } else {
      await page.keyboard.type(`${L("weekly", "每週")}`);
      await page.keyboard.press("Space");
      await page.keyboard.type(`#${m1} ${L("and also", "還有")} #${s1} `);
    }
    await page.keyboard.type(L("— where are we?", "— 做到哪了？"));
    await page.locator("#sendBtn").click();
    await page.waitForSelector(".msg.user", { timeout: 10000 });
    await page.waitForTimeout(AFTER ? 900 : 400);
    // An agent's reply that names a card stays text (only a person's numbers are chips).
    fm.emitSseEvent("message", { instance: AGENT, sender: AGENT, role: "agent", ts: new Date().toISOString(),
      text: L(`On it: ${m1} is in progress, ${s1} comes next.`, `收到：${m1} 進行中，接著做 ${s1}。`) });
    await page.waitForTimeout(500);
    await shot("2-sent");
    const chips = await page.locator(".msg.user a.task-ref").count();
    chk.chipsForBothNumbers = AFTER ? chips === 2 : chips === 0;
    chk.agentReplyStaysText = (await page.locator(".msg:not(.user) a.task-ref").count()) === 0;
    chk.messageSentOnce = delivered.length === 1;
    const content = delivered[0]?.content ?? "";
    chk.agentHandedTheCards = AFTER
      ? content.includes("[Task cards this message refers to]") && content.includes(`${m1} [in progress]`) && content.includes(`${s1} [to do]`) && content.includes("task get")
      : !content.includes("Task cards");
    if (phone) chk.phoneNoSideScroll = await noSideScroll(page);
    if (AFTER) {
      const first = page.locator(".msg.user a.task-ref").first();
      chk.chipShowsTitleAndStatus = (await first.locator(".task-ref-title").textContent())?.length! > 3 && (await first.locator(".tb-pill").count()) === 1;
      await first.click();
      await page.waitForURL((u: URL) => u.searchParams.get("card") === m1, { timeout: 10000 });
      await page.waitForTimeout(1200);
      chk.chipOpensTheCard = new URL(page.url()).pathname === "/ui/fleet" && (await page.locator("body").innerText()).includes(L("Serve the weekly leaderboard", "提供每週排行榜"));
      await shot("3-card-opened");
      if (phone) chk.phoneCardNoSideScroll = await noSideScroll(page);
    }
    chk.noPageErrors = p.errors.length === 0;
    chk.noCspViolations = ((await page.evaluate("window.__csp || []")) as string[]).length === 0;
  } catch (e) { chk.threw = false; p.errors.push(String(e).slice(0, 300)); }
  record(name, chk, p.errors);
  await p.ctx.close();
}
writeFileSync(join(dirname(shotPath(SMOKE, "x", "y")), "results.json"), JSON.stringify(results, null, 2));
const bad = results.filter((r) => !r.ok);
console.log(`${results.length - bad.length}/${results.length} cases ok`);
await fx.close();
process.exit(bad.length ? 1 : 0);
