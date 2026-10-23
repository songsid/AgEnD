// The 2.3.0 docs pictures (#1633) that need data of their own, from defaults (fleet decision a78ebdc5): a fresh
// profile with nothing seeded, signed in through the visible /signin, desk light en. Demo names only; nothing failing.
// - usage-compact: the usage view's compact mode with five healthy logins (Claude ×2, Codex ×2, Kiro), mixed normal and
//   warning levels and one high bar; the rail itself is the picture.
// - task-board: a project board with a card in each of To do, In progress and Blocked (with its question), after every
//   toast has gone and with nothing focused; the board page is the picture.
// Each checks no console error and no real fleet name in visible text. The chat, Office pictures come from
// smoke-web-sending-state and smoke-2399-office.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-docs-pictures-2-3.mts
import { join } from "node:path";
import { bootFixture, freshPage, mounted, shotPath, type FreshPage, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-docs-pictures-2-3";
const REPO = process.env.REPO!;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48640), classic: false });
const fm = fx.fm;
const dir = fm.dataDir ?? fx.dir;
const { setUsageFetcherForTests } = await import(REPO + "/src/usage/usage-api.ts");
const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");

const AGENT = "search-indexer";
const names = ["general", "studio-layout", AGENT, "billing-reconciliation"];
fm.fleetConfig.instances = Object.fromEntries(names.map((name) => [name, { working_directory: dir, backend: "claude-code", ...(name === "general" ? { general_topic: true } : {}) }]));
fm.fleetConfig.teams = {};
fm.getInstanceStatus = () => "running";
const REAL = /agend-|t15\d{6}|web-claude|\bsol\b|\bfable\b|qa-1|rd1-|awp-|doupo-|研一|鬥破|己把鳩/;

const H = 3_600_000;
const soon = (h: number) => new Date(Date.now() + h * H).toISOString();
const pct = (key: string, label: string, used: number, windowMs: number, resetH: number) => ({ type: "percent", label, labelI18n: { key }, used, windowMs, resetsAt: soon(resetH) });
const both = (s: number, w: number, sReset = 3, wReset = 90) => [pct("usage.metric.session", "Session", s, 5 * H, sReset), pct("usage.metric.weekly", "Weekly", w, 168 * H, wReset)];
const profiled = (provider: string, profile: string, plan: string, metrics: unknown[]) => ({ id: `${provider.toLowerCase()}:${profile}`, name: `${provider} (${profile})`, profile, status: "ok", plan, metrics });
setUsageFetcherForTests(async () => ({ fetchedAt: new Date().toISOString(), providers: [
  { id: "claude", name: "Claude", status: "ok", plan: "Max (20x)", metrics: both(42, 68) },
  profiled("Claude", "team-shared", "Team", both(18, 91, 2, 30)),
  { id: "codex", name: "Codex", status: "ok", plan: "Pro", metrics: both(12, 35, 4, 120) },
  profiled("Codex", "design-studio", "Plus", both(27, 74, 1, 60)),
  { id: "kiro", name: "Kiro", status: "ok", plan: "Kiro Pro", metrics: [pct("usage.metric.monthly", "Monthly", 30, 720 * H, 300)] },
] }));
fm.getActiveUsageProviderIds = () => null;

const C: MatrixCase = { device: "desk", theme: "light", lang: "en" };
let failed = 0;
function record(name: string, c: Record<string, boolean>, extra: unknown = "") {
  const bad = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length) failed++;
  console.log(`${bad.length ? "FAIL" : "ok  "} ${name}${bad.length ? ` [${bad.join(", ")}]` : ""} ${JSON.stringify(extra).slice(0, 600)}`);
}
const visibleText = (p: FreshPage) => p.page.evaluate("document.body.innerText") as Promise<string>;
// Polled through locators: the page's CSP refuses waitForFunction's string form (no unsafe-eval).
async function toastsGone(p: FreshPage): Promise<void> {
  for (let t = 0; t < 150; t++) { if ((await p.page.locator(".toasts .toast").count()) === 0) return; await p.page.waitForTimeout(100); }
  throw new Error("a toast stayed for 15 s");
}
const blur = (p: FreshPage) => p.page.evaluate("document.activeElement && document.activeElement.blur && document.activeElement.blur()");

// ── usage-compact ──
{
  const p = await freshPage(fx, C, { path: "/ui/chat/studio-layout" });
  const ck: Record<string, boolean> = {};
  if (!(await mounted(p.page, 30000))) throw new Error("the app did not mount");
  await p.page.locator("button.hd-usage").first().click();
  await p.page.waitForSelector(".u-rail .u-provider", { timeout: 15000 });
  await p.page.locator(".u-rail .u-compact-toggle").click();
  await p.page.waitForSelector(".u-rail .u-crow", { timeout: 5000 });
  await p.page.waitForTimeout(600);
  await blur(p);
  ck.fiveLogins = (await p.page.locator(".u-rail .u-crow").count()) === 5;
  ck.noRealNames = !REAL.test(await visibleText(p));
  ck.noErrors = p.errors.length === 0;
  await p.page.locator(".u-rail").screenshot({ path: shotPath(SMOKE, "docs", "usage-compact") });
  record("usage-compact", ck, p.errors);
  await p.page.locator(".u-rail .u-compact-toggle").click();   // back to defaults on the host
  await p.page.waitForTimeout(1200);
  await p.ctx.close();
}

// ── task-board ──
{
  fm.scheduler?.db.close();
  fm.scheduler = new Scheduler(join(fm.dataDir, "scheduler-docs.db"), () => {}, DEFAULT_SCHEDULER_CONFIG, (n: string) => !!fm.fleetConfig.instances[n]);
  (fm as any).attachTaskBoard(fm.scheduler.db);
  const db = fm.scheduler.db;
  const p = await freshPage(fx, C);
  const ck: Record<string, boolean> = {};
  const top = () => p.page.locator("dialog[open]").last();
  const clickVisible = async (selector: string) => {
    const all = p.page.locator(selector);
    for (let t = 0; t < 100; t++) {
      for (let i = 0; i < await all.count(); i++) if (await all.nth(i).isVisible()) { await all.nth(i).click(); return; }
      await p.page.waitForTimeout(100);
    }
    throw new Error(`nothing visible matches ${selector}`);
  };
  const until = async (fn: () => boolean) => { for (let t = 0; t < 100 && !fn(); t++) await p.page.waitForTimeout(100); return fn(); };
  const status = (code: string) => db.board.getCard(code).status as string;
  await mounted(p.page);
  await clickVisible('a[href="/ui/fleet/org"]');
  await p.page.waitForURL("**/ui/fleet/org", { timeout: 10000 });
  await clickVisible('.seg a[href="/ui/fleet"]');
  await p.page.waitForSelector(".tb-home", { timeout: 10000 });
  await clickVisible(".tb-home .list-head .btn-primary");
  await top().locator("input").first().fill("Leaderboard");
  await top().locator(".btn-primary").click();
  await p.page.waitForSelector('.tb-board-page .tb-title h2:text-is("Leaderboard")', { timeout: 10000 });
  const card = async (title: string, assignee: string) => {
    await clickVisible(".tb-bar-head .btn-primary");
    await top().locator("input").first().fill(title);
    await top().locator(".tb-form-row select").first().selectOption(assignee);
    await top().locator(".btn-primary").click();
    await p.page.waitForSelector(".tc-actions", { timeout: 10000 });
    return db.board.boardCards().find((x: any) => x.title === title)?.code as string;
  };
  const move = async (code: string, to: string) => {
    await p.page.locator(`dialog[open] .tc-actions select.tb-select option[value="${to}"]`).last().waitFor({ state: "attached", timeout: 10000 });
    await top().locator(".tc-actions select.tb-select").selectOption(to);
  };
  const blocked = await card("Serve the weekly leaderboard", AGENT);
  await move(blocked, "claimed");
  ck.claimed = await until(() => status(blocked) === "claimed");
  await move(blocked, "blocked");
  await p.page.waitForSelector("dialog[open] textarea", { timeout: 10000 });
  await top().locator("textarea").fill("Which scores count: ranked games only?");
  await top().locator(".btn-primary").click();
  ck.blocked = await until(() => status(blocked) === "blocked");
  await p.page.keyboard.press("Escape");
  const working = await card("Import last season's scores", "billing-reconciliation");
  await move(working, "claimed");
  ck.inProgress = await until(() => status(working) === "claimed");
  await p.page.keyboard.press("Escape");
  const todo = await card("Draft the tie-break rules", AGENT);
  await p.page.keyboard.press("Escape");
  ck.todo = status(todo) === "open";
  await p.page.waitForSelector("dialog[open]", { state: "detached", timeout: 10000 });
  await toastsGone(p);
  await blur(p);
  await p.page.mouse.move(0, 0);
  await p.page.waitForTimeout(400);
  ck.noToast = (await p.page.locator(".toasts .toast").count()) === 0;
  ck.nothingFocused = await p.page.evaluate("document.activeElement === document.body || document.activeElement === null") as boolean;
  ck.noRealNames = !REAL.test(await visibleText(p));
  ck.noErrors = p.errors.length === 0;
  await p.page.locator(".tb-board-page").screenshot({ path: shotPath(SMOKE, "docs", "task-board") });
  record("task-board", ck, p.errors);
  await p.ctx.close();
}

console.log(`${failed ? "FAIL" : "PASS"} 2 pictures`);
await fx.close();
process.exit(failed ? 1 : 0);
