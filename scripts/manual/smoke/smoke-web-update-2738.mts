// M-2738 (#3332): the web Update on the REAL shell and server routes (the shared Settings fixture: in-process FleetManager,
// scratch home, loopback only). The update check's answer is set on the fleet (no npm), and the launch is stubbed (no
// updater ever runs); the progress marker is written the way the updater writes it. Checks, desktop and phone:
//  banner → Update now asks once (Cancel: nothing) → yes: POST /ui/update/start 202, a web marker, one launch;
//  progress (spinner, step, elapsed) → failure (error tone, person-level words, no npm text; full log dialog) → reload after
//  the version changes; Settings → 進階 card (offer / current / alpha-stable) + the pill; /update in chat opens the dialog;
//  SKEW: the page with the PREVIOUS app.css (OLD_CSS) still works. No page error, no CSP report.
//   PW_DIR=<dir> REPO=<checkout> OUT=<dir> [OLD_CSS=<main's app.css>] [MATRIX=…] npx tsx scripts/manual/smoke/smoke-web-update-2738.mts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix } from "../smoke-fixture/index.mts";

const OUT = join(process.env.OUT ?? "/tmp/smoke-out", "web-update-2738");
mkdirSync(OUT, { recursive: true });
const CASES = matrix(process.env.MATRIX ?? "desk-light-zh-TW,phone-light-zh-TW,phone-dark-zh-TW,desk-dark-en");
const r: Record<string, unknown> = {}, fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };
const marker = await import(process.env.REPO + "/src/update-marker.ts");
const web = await import(process.env.REPO + "/src/web-update.ts");
const fx = await bootFixture({ port: 19560, instances: 4, classic: false, host: true } as any);
const fm = fx.fm as any;
let version = "2.3.5-beta.2";
fm.runningAgendVersion = () => version;
const launches: string[] = [];
fm.launchInstalledUpdate = async (origin: string) => { launches.push(origin); };          // never the real updater
fm.lookUpUpdateTarget = async () => ({ target: version, fromChannel: true });               // never the registry: "Check" finds nothing newer
const offer = (o: unknown) => { fm.updateCheckState = { offer: o, checkedAt: Date.now() - 3 * 60_000, failed: false }; };
const BETA = { version: "2.3.5-beta.3", channel: "beta", installable: true };
const dir = fm.dataDir as string;
const reset = () => { marker.clearUpdateMarker(dir); fm.webUpdateStarts.clear(); version = "2.3.5-beta.2"; offer(BETA); };
const poke = (page: any) => page.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`);
const lineText = (page: any) => page.evaluate(`document.querySelector(".update-line")?.innerText ?? ""`);
try {
  for (const c of CASES) {
    const name = caseName(c), zh = c.lang === "zh-TW";
    reset(); launches.length = 0;
    const { ctx, page, csp } = await fx.page(c, { path: "/" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    const starts: number[] = [];
    page.on("response", (res: any) => { if (new URL(res.url()).pathname === "/ui/update/start") starts.push(res.status()); });
    // 1. banner
    await page.waitForSelector(".update-line", { timeout: 15000 });
    await page.screenshot({ path: join(OUT, `${name}-1-banner.png`) });
    check(`${name}:banner`, (await lineText(page)).includes(zh ? "AgEnD v2.3.5-beta.3 已推出（目前 v2.3.5-beta.2）" : "AgEnD v2.3.5-beta.3 is available (current v2.3.5-beta.2)"), await lineText(page));
    // 2. confirm: Cancel starts nothing; yes starts once
    const now = zh ? "立即更新" : "Update now";
    await page.click(`.update-line button:text-is("${now}")`); await page.waitForSelector("[data-confirm=yes]", { timeout: 8000 });
    await page.screenshot({ path: join(OUT, `${name}-2-confirm.png`) });
    const dlg = await page.evaluate(`document.querySelector("dialog[open]")?.innerText ?? ""`);
    const primary = await page.evaluate(`document.querySelector("[data-confirm=yes]").className`);
    await page.click("dialog[open] .btn:not([data-confirm])"); await page.waitForTimeout(400);
    const cancelled = starts.length === 0 && marker.readUpdateProgress(dir) === null;
    await page.click(`.update-line button:text-is("${now}")`); await page.waitForSelector("[data-confirm=yes]", { timeout: 8000 });
    await page.click("[data-confirm=yes]");
    await page.waitForSelector(".update-spinner", { timeout: 10000 });
    const m = marker.readUpdateProgress(dir);
    check(`${name}:confirm-start`, cancelled && starts.join() === "202" && launches.length === 1 && m?.progress.target.adapterId === web.WEB_UPDATE_ADAPTER
      && dlg.includes(zh ? "同為預覽版" : "the same preview line") && primary.includes("btn-primary") && !primary.includes("danger"),
      { cancelled, starts, launches, target: m?.progress.target, dlg, primary });
    // 3. progress
    marker.setUpdateProgressStage(dir, "downloading", { version: "2.3.5-beta.3" });
    await page.waitForTimeout(2600);
    const prog = await lineText(page);
    await page.screenshot({ path: join(OUT, `${name}-3-progress.png`) });
    check(`${name}:progress`, prog.includes(zh ? "正在下載及安裝 v2.3.5-beta.3…" : "Downloading and installing v2.3.5-beta.3…") && /(第 2／4 步|Step 2 of 4)/.test(prog), prog);
    // 4. failure
    marker.setUpdateProgressStage(dir, "failed", { error: "npm error code ENOTFOUND request to https://registry.npmjs.org failed, reason: getaddrinfo ENOTFOUND" });
    writeFileSync(join(dir, "update.log"), "--- /update ---\nnpm error code ENOTFOUND\nnpm error network request failed\n");
    await page.waitForSelector(".update-line.bad", { timeout: 8000 });
    const failed = await lineText(page);
    await page.screenshot({ path: join(OUT, `${name}-4-failed.png`) });
    check(`${name}:failed`, failed.includes(zh ? "更新失敗：連不上更新來源。" : "Update failed: the update source could not be reached.") && !/npm|ENOTFOUND|registry/.test(failed)
      && await page.evaluate(`document.querySelector(".update-line.bad").getAttribute("role")`) === "alert", failed);
    await page.click(`.update-line button:text-is("${zh ? "看完整紀錄" : "See the full log"}")`);
    await page.waitForSelector(".update-log", { timeout: 8000 });
    await page.screenshot({ path: join(OUT, `${name}-4b-log.png`) });
    check(`${name}:log`, (await page.evaluate(`document.querySelector(".update-log").innerText`)).includes("npm error code ENOTFOUND"));
    await page.keyboard.press("Escape"); await page.waitForTimeout(300);
    // 5. reload after the version changed (the new fleet cleared the marker)
    marker.clearUpdateMarker(dir); version = "2.3.5-beta.3"; offer(null);
    await poke(page);
    await page.waitForSelector(".update-line.ok", { timeout: 8000 });
    const rl = await lineText(page);
    await page.screenshot({ path: join(OUT, `${name}-5-reload.png`) });
    const reloadBox = await page.evaluate((label: string) => {
      const b = [...document.querySelectorAll<HTMLButtonElement>(".update-line button")].find(x => x.innerText === label)!;
      return b.getBoundingClientRect().height;
    }, zh ? "重新載入" : "Reload");
    check(`${name}:reload`, rl.includes(zh ? "AgEnD 已更新到 v2.3.5-beta.3" : "AgEnD is updated to v2.3.5-beta.3") && reloadBox < 40, { rl, reloadBox });
    // 6. Settings → 進階: the card (offer, current, alpha-stable) and the pill
    reset();
    await page.goto(fx.base + "/settings/advanced"); await page.waitForSelector(".s-update", { timeout: 15000 });
    await page.evaluate(`document.querySelector(".s-update").scrollIntoView({ block: "start" })`); await page.waitForTimeout(300);
    await page.screenshot({ path: join(OUT, `${name}-6-settings-available.png`) });
    const card = await page.evaluate(`document.querySelector(".s-update").innerText`);
    const pill = await page.evaluate(`document.querySelector(".pill.ver-new")?.innerText ?? ""`);
    check(`${name}:card`, card.toLowerCase().includes(zh ? "版本與更新" : "version and update") && card.includes("v2.3.5-beta.3") && pill === (zh ? "有新版" : "New version"), { card, pill });
    offer(null);
    fm.updateCheckNow.lastAt = 0;
    await page.click(`.s-update button:text-is("${zh ? "檢查更新" : "Check for updates"}")`);
    await page.waitForTimeout(600);
    check(`${name}:check-now`, fm.updateCheckState.offer === null && !(await page.evaluate(`document.querySelector(".pill.ver-new")`)));
    await page.reload(); await page.waitForSelector(".s-update", { timeout: 15000 });
    await page.evaluate(`document.querySelector(".s-update").scrollIntoView({ block: "start" })`); await page.waitForTimeout(300);
    await page.screenshot({ path: join(OUT, `${name}-7-settings-current.png`) });
    version = "2.4.0-alpha.9"; offer({ version: "2.5.0", channel: "latest", installable: false });
    await page.reload(); await page.waitForSelector(".s-update", { timeout: 15000 });
    await page.evaluate(`document.querySelector(".s-update").scrollIntoView({ block: "start" })`); await page.waitForTimeout(300);
    await page.screenshot({ path: join(OUT, `${name}-8-settings-alpha-stable.png`) });
    const alpha = await page.evaluate(`document.querySelector(".s-update").innerText`);
    check(`${name}:card-alpha`, alpha.includes(zh ? "不提供切換到穩定版" : "switching to stable is not offered") && !alpha.includes(zh ? "立即更新" : "Update now"), alpha);
    // 7. Settings search finds it
    reset();
    await page.goto(fx.base + "/settings"); await page.waitForTimeout(800);
    const search = await page.$("input[type=search], .s-find input");
    if (search) await search.fill(zh ? "更新" : "update");
    let found = "";
    for (let i = 0; i < 15 && !found.includes(zh ? "版本與更新" : "Version and update"); i++) { await page.waitForTimeout(200); found = await page.evaluate(`document.body.innerText`); }
    check(`${name}:search`, !!search && found.includes(zh ? "版本與更新" : "Version and update"));
    // 8. /update in a chat: the dialog, nothing sent
    const sent: string[] = [];
    page.on("request", (q: any) => { const p = new URL(q.url()).pathname; if (q.method() === "POST" && (p === "/ui/send" || p === "/ui/command")) sent.push(p); });
    await page.goto(fx.base + `/ui/chat/${encodeURIComponent(fx.instances[0]!.name)}`); await page.waitForSelector("#msgIn", { timeout: 15000 });
    // A desk sends with Enter; a phone's Enter is a new line, so Send is tapped (as a person on a phone does).
    await page.fill("#msgIn", "/update");
    if (c.device === "phone") { await page.keyboard.press("Escape"); await page.click("#sendBtn"); } else await page.keyboard.press("Enter");
    await page.waitForSelector("[data-confirm=yes]", { timeout: 8000 });
    await page.screenshot({ path: join(OUT, `${name}-9-chat-update.png`) });
    await page.click("dialog[open] .btn:not([data-confirm])"); await page.waitForTimeout(300);
    check(`${name}:chat-update`, sent.length === 0 && (await page.inputValue("#msgIn")) === "", sent);
    check(`${name}:no-errors`, errs.length === 0, errs);
    check(`${name}:csp`, (await csp()).length === 0, await csp());
    await ctx.close();
  }
  // SKEW: a tab whose app.css is the previous release's (new modules, old stylesheet) still shows and runs it.
  if (process.env.OLD_CSS) {
    const oldCss = readFileSync(process.env.OLD_CSS, "utf8");
    const c = { device: "desk", theme: "light", lang: "zh-TW" } as const;
    reset();
    const { ctx, page, csp } = await fx.page(c as any, { path: "/" });
    await page.route("**/assets/app.css*", (route: any) => route.fulfill({ status: 200, contentType: "text/css; charset=utf-8", body: oldCss }));
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    await page.reload(); await page.waitForSelector(".update-line", { timeout: 15000 });
    await page.screenshot({ path: join(OUT, "skew-old-css-banner.png") });
    await page.click(`.update-line button:text-is("立即更新")`); await page.waitForSelector("[data-confirm=yes]", { timeout: 8000 });
    await page.click("dialog[open] .btn:not([data-confirm])");
    await page.goto(fx.base + "/settings/advanced"); await page.waitForSelector(".s-update", { timeout: 15000 });
    await page.screenshot({ path: join(OUT, "skew-old-css-settings.png") });
    check("skew:old-css", errs.length === 0 && (await csp()).length === 0, errs);
    await ctx.close();
  }
} finally { await fx.close?.(); }
writeFileSync(join(OUT, "result.json"), JSON.stringify(r, null, 2));
console.log(JSON.stringify(r, null, 2));
console.log(fail.length ? `FAIL ${fail.length}: ${fail.join(", ")}` : `ALL ${Object.keys(r).length} PASS`);
process.exit(fail.length ? 1 : 0);
