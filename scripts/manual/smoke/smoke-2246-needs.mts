// #2246 step 3 from defaults (fleet decision a78ebdc5): task board cards in the web's Needs you. Each case a fresh
// profile with nothing seeded and a board of its own: an agent's card waiting for the person's confirmation (not
// wrapped up) and one blocked on a question. Driven through visible UI: Needs you from the navigation (the sidebar, or
// the phone's tab) lists both, in the page's language, each with Open the card; opening one shows that card's dialog
// with Confirm. A card an instance handed out is listed too (the chat leaves it to that instance). The chat's live
// message and its buttons are the unit and fleet tests' (no chat platform here). No sideways scroll on a phone; no
// page error.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2246-needs.mts
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bootFixture, caseName, freshPage, labelOf, matrix, mounted, shotPath, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2246-needs";
const REPO = process.env.REPO!;
const DEV = "search-indexer", LEAD = "observability-dashboards";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48490) });
const fm = fx.fm;
for (const name of Object.keys(fm.fleetConfig.instances)) if (![DEV, LEAD, "billing-reconciliation"].includes(name)) delete fm.fleetConfig.instances[name];
const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");
const { deriveNeedsYou } = await import(REPO + "/src/needs-you.ts");
// The fixture runs no Needs you hub (no chat world): the web's list is the same derivation, from the board's cards.
fm.needsYouItems = () => deriveNeedsYou({ prompts: [], instances: [], deliveries: [], tasks: (fm as any).needsYouTasks(), ownerOf: () => undefined });

function freshBoard(c: MatrixCase) {
  fm.scheduler?.db.close();
  fm.scheduler = new Scheduler(join(fm.dataDir, `scheduler-needs-${caseName(c)}.db`), () => {}, DEFAULT_SCHEDULER_CONFIG, (n: string) => !!fm.fleetConfig.instances[n]);
  (fm as any).attachTaskBoard(fm.scheduler.db);
  const board = fm.scheduler.db.board;
  const person = { kind: "person", name: "Demo Person" }, dev = { kind: "instance", name: DEV };
  const zh = c.lang === "zh-TW";
  const [review, blocked] = board.createCards(person, { cards: [
    { title: zh ? "提供每週排行榜" : "Serve the weekly leaderboard", assignee: DEV, acceptance: [zh ? "每週一重置" : "Resets every Monday"] },
    { title: zh ? "封存上一季" : "Archive last season", assignee: DEV },
  ] }).cards;
  board.moveCard(dev, review!.code, "claimed");
  board.moveCard(person, review!.code, "review");                       // reached the person before it was wrapped up
  return { board, review: review!.code, blocked: blocked!.code, zh };
}

async function clickVisible(page: any, selector: string, timeout = 10000): Promise<void> {
  const all = page.locator(selector), end = Date.now() + timeout;
  do {
    for (let i = 0; i < await all.count(); i++) if (await all.nth(i).isVisible()) { await all.nth(i).click(); return; }
    await page.waitForTimeout(100);
  } while (Date.now() < end);
  await page.screenshot({ path: shotPath(SMOKE, "failure", "nothing-visible") }).catch(() => {});
  throw new Error(`nothing visible matches ${selector} on ${page.url()}`);
}

const results: Array<{ name: string; ok: boolean; failed: string[]; errors: string[] }> = [];
for (const c of matrix()) {
  const name = caseName(c);
  const chk: Record<string, boolean> = {};
  const p = await freshPage(fx, c, c.device === "phone" ? { origin: "lan", reducedMotion: true } : {});
  try {
    const b = freshBoard(c);
    // Blocked on a question, by the agent.
    b.board.moveCard({ kind: "instance", name: DEV }, b.blocked, "claimed");
    b.board.moveCard({ kind: "instance", name: DEV }, b.blocked, "blocked", { reason: b.zh ? "要歸檔哪一季？" : "Which season goes?" });
    await mounted(p.page);
    await clickVisible(p.page, 'a[href="/ui/needs"]');
    await p.page.waitForURL("**/ui/needs", { timeout: 10000 });
    await p.page.waitForSelector(".n-item", { timeout: 15000 });
    const titles = await p.page.locator(".n-title strong").allTextContents();
    chk.reviewListed = titles.includes(labelOf(c, { en: "Waiting for your confirmation", zh: "等你確認" }));
    chk.blockedListed = titles.includes(labelOf(c, { en: "Blocked: asks you", zh: "卡住，在問你" }));
    const details = (await p.page.locator(".n-detail").allTextContents()).join("\n");
    chk.saysWhatIsMissing = details.includes(b.review) && (details.includes("not wrapped up") || details.includes("還沒補齊"));
    chk.saysTheQuestion = details.includes(b.blocked) && (details.includes("Which season goes?") || details.includes("要歸檔哪一季？"));
    if (c.device === "phone") chk.noSideScroll = await p.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    await p.page.screenshot({ path: shotPath(SMOKE, c, "1-needs") });
    await clickVisible(p.page, `a[href="/ui/fleet?card=${b.review}"]`);
    await p.page.waitForSelector("dialog[open] .tc-actions", { timeout: 10000 });
    chk.cardOpens = ((await p.page.locator("dialog[open]").first().textContent()) ?? "").includes(b.review);
    chk.confirmThere = (await p.page.locator("dialog[open] .tc-actions .btn-primary").count()) > 0;
    await p.page.screenshot({ path: shotPath(SMOKE, c, "2-card") });
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
