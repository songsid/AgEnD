// S-92 (#3326 D1; the user's decision hmsg-77256f66): the restart notice with no Settings job behind it (a hand edit of
// fleet.yaml) offers Restart now — one click and the restart's own dialog — on a web-only fleet, whose restart is traced
// as the dashboard's fleet Notice (the leader's ruling). A real browser on the shared fixture (the product's own web server,
// a scratch home, no fleet start). The process replacement itself is stubbed (the launcher and the idle wait): nothing
// restarts; the server's whole path up to the launch runs.
//   LABEL=base serves app-shell.js / settings-apply.js from OLD_REF (the before picture: "Run agend restart on the host").
//   SKEW=1: a new shell with an old settings-apply.js (a tab that loaded Settings before the upgrade): no page error.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [LABEL=base|branch] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx tsx scripts/manual/smoke/smoke-restart-notice-s92.mts
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-restart-notice-s92";
const LABEL = process.env.LABEL ?? "branch", BASE = LABEL === "base";
const OLD = process.env.OLD_REF ?? "songsid/release/2.3.5-alpha";
const r: Record<string, unknown> = { label: LABEL };
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const old = (f: string) => execFileSync("git", ["-C", process.env.REPO!, "show", `${OLD}:${f}`], { encoding: "utf8", maxBuffer: 16 << 20 });
const fx = await bootFixture({ port: 47590, instances: 4 });
const fm = fx.fm as any;
// Never a real process replacement: the launcher and the idle wait are stubbed; launches are counted.
let launches = 0;
fm.fullRestartLauncher = async () => { launches++; return { completion: new Promise(() => {}) }; };
fm.waitForFullRestartIdleGrace = async () => {};
// The fleet Notices the server records (the web-only trace), as they are recorded.
const recorded: string[] = [];
{ const real = fm.recordWebNotice.bind(fm); fm.recordWebNotice = (kind: string, text: string, inst?: string) => { recorded.push(text); return real(kind, text, inst); }; }
/** What a real start records, then a hand edit of fleet.yaml: a restart is pending, and no Settings job carries it. */
const handEdit = () => {
  // A case's restart never really happens here (the launcher is stubbed): its job is settled, so the next case starts clean.
  for (const job of fm.applyJobs.all()) for (const row of job.targets) if (row.status === "running") fm.applyJobs.setTargetStatus(job.id, row.target, "done");
  launches = 0; recorded.length = 0;
  fm.startupFleetConfig = structuredClone(fm.fleetConfig); fm.appliedFleetLevel = fm.fleetLevelSignature();
  fm.saveFleetConfig([{ path: ["defaults", "locale"], value: fm.fleetConfig?.defaults?.locale === "zh-TW" ? "en" : "zh-TW" }]);
  for (const f of ["self-restart.json", "update-in-progress.json"]) rmSync(join(fx.dir, f), { force: true });   // each case's own attempt
};
const js = (body: string) => ({ status: 200, contentType: "text/javascript; charset=utf-8", body });
try {
  const cases = matrix("desk-light-en,phone-dark-zh-TW");
  for (const c of cases) {
    const cn = caseName(c), zh = c.lang === "zh-TW";
    handEdit();
    const pendingNow = fm.settingsRestartPending();
    const { ctx, page, csp } = await fx.page(c, { path: "/settings/agents" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    if (BASE) await page.route(/\/app-shell\.js(\?.*)?$/, (route: any) => route.fulfill(js(old("src/ui/shared/app-shell.js"))));
    await page.goto(`${fx.base}/settings/agents`);
    await page.waitForSelector(".restart-line", { timeout: 15000 });
    await page.waitForTimeout(500);
    const before = await page.evaluate(() => { const l = document.querySelector(".restart-line") as HTMLElement; return { text: l.innerText.replace(/\s+/g, " "), buttons: [...l.querySelectorAll("button")].map(b => (b as HTMLElement).innerText) }; });
    await page.locator(".restart-line").screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-notice`) });
    if (BASE) { r[cn] = { pendingNow, before, errs }; await ctx.close(); continue; }
    const restartLabel = zh ? "立即重新啟動" : "Restart now";
    await page.locator(".restart-line button", { hasText: restartLabel }).click();
    // The restart's own dialog (the existing one) — then its confirm button.
    await page.waitForSelector("dialog[open]", { timeout: 5000 });
    const dialogText = await page.evaluate(() => (document.querySelector("dialog[open]") as HTMLElement).innerText.replace(/\s+/g, " "));
    await page.screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-dialog`) });
    await page.locator("dialog[open] button", { hasText: restartLabel }).click();
    await page.waitForTimeout(2500);
    const noticeTexts = recorded.filter(x => /AgEnD (is restarting|正在重新啟動)/.test(x));
    await page.screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-after`) });
    const cspNow = await csp();
    const refused = await page.evaluate(() => [...document.querySelectorAll(".toast")].map(x => (x as HTMLElement).innerText).filter(x => /refused|拒絕/.test(x)));
    check(cn, before.buttons.includes(restartLabel) && !/agend restart|在主機上/.test(before.text) && dialogText.includes(zh ? "儀表板的通知" : "dashboard's Notices")
      && !/chat channel|聊天頻道/.test(dialogText) && launches === 1 && noticeTexts.length === 1 && refused.length === 0 && errs.length === 0 && cspNow.length === 0,
      { pendingNow, before, dialogText, launches, noticeTexts, refused, errs, csp: cspNow });
    await ctx.close();
  }
  if (!BASE && process.env.SKEW) {
    // A tab whose settings-apply.js predates this (it loaded Settings before the upgrade), with the new shell: the click is
    // refused in words (a toast), never a page error; the restart can be asked again once the page reloads.
    handEdit(); launches = 0;
    const c = matrix("desk-light-en")[0]!;
    const { ctx, page } = await fx.page(c, { path: "/settings/agents" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    await page.route(/\/settings-apply\.js(\?.*)?$/, (route: any) => route.fulfill(js(old("src/ui/settings-apply.js"))));
    await page.goto(`${fx.base}/settings/agents`);
    await page.waitForSelector(".restart-line button", { timeout: 15000 });
    await page.locator(".restart-line button", { hasText: "Restart now" }).click();
    await page.waitForSelector("dialog[open]", { timeout: 5000 });
    await page.locator("dialog[open] button", { hasText: "Restart now" }).click();
    await page.waitForTimeout(2500);
    const toasts = await page.evaluate(() => [...document.querySelectorAll(".toast")].map(x => (x as HTMLElement).innerText));
    await page.screenshot({ path: shotPath(SMOKE, "skew-old-apply", `${LABEL}-after`) });
    check("skew-old-apply", errs.length === 0 && launches === 0, { toasts, launches, errs });
    await ctx.close();
  }
} catch (e) { fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500); }
finally {
  mkdirSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE), { recursive: true });
  writeFileSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE, `result-${LABEL}.json`), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1).slice(0, 3000)); console.log(fail.length ? `FAIL: ${fail.join(", ")}` : BASE ? "RECORDED" : "ALL PASS");
  await fx.close(); process.exit(fail.length ? 1 : 0);
}
