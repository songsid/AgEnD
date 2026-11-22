import { publicRoster } from "../smoke-fixture/public-roster.mts";
// M-3140 (hub-fleet-versions.md §3.3, web): the Hub's recommended version on the REAL shell and server routes (the shared
// Settings fixture: in-process FleetManager, scratch home, loopback only). The advice is set on the fleet the way #3951's
// receiver exposes it (hubRecommendedUpdate); the launch is stubbed (no updater ever runs) and records the pinned version.
// Checks, desktop and phone, en and zh-TW: the line names the Hub and both versions → Update now asks once → yes: POST 202
// and one launch pinned to the advised version; one banner (the install's own update when it reaches the advice); Later
// hides it; Settings → Advanced's "Recommended by {Hub}" row. No page error, no CSP report.
//   PW_DIR=<dir> REPO=<checkout> OUT=<dir> [MATRIX=…] npx tsx scripts/manual/smoke/smoke-hub-recommended-update-m3140.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix } from "../smoke-fixture/index.mts";

const OUT = join(process.env.OUT ?? "/tmp/smoke-out", "hub-recommended-update-m3140");
mkdirSync(OUT, { recursive: true });
const CASES = matrix(process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,phone-light-zh-TW,phone-dark-en");
const r: Record<string, unknown> = {}, fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };
const marker = await import(process.env.REPO + "/src/update-marker.ts");
const fx = await bootFixture({ roster: publicRoster(4), port: 19570, instances: 4, classic: false, host: true } as any);
const fm = fx.fm as any;
fm.runningAgendVersion = () => "2.3.5-beta.2";
const launches: Array<{ origin: string; pin?: string }> = [];
fm.launchInstalledUpdate = async (origin: string, _allowed: unknown, pin?: string) => { launches.push({ origin, pin }); };   // never the real updater
const ADVICE = { hubId: "hub-1", hubName: "hub.example", version: "2.4.0-beta.4", revision: 3, setAt: Date.now() - 3600_000, receivedAt: Date.now() - 3000_000 };
fm.hubRecommendationRead = () => ADVICE;
const offer = (o: unknown) => { fm.updateCheckState = { offer: o, checkedAt: Date.now() - 3 * 60_000, failed: false }; };
const dir = fm.dataDir as string;
const reset = () => { marker.clearUpdateMarker(dir); fm.webUpdateStarts.clear(); fm.webUpdateOwned = null; offer(null); };
const lineText = (page: any) => page.evaluate(`[...document.querySelectorAll(".update-line")].map(x => x.innerText).join(" || ")`);
try {
  for (const c of CASES) {
    const name = caseName(c), zh = c.lang === "zh-TW";
    reset(); launches.length = 0;
    const { ctx, page, csp } = await fx.page(c, { path: "/" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    await page.evaluate(`localStorage.removeItem("agend_update_later_hub")`);
    // 1. the Hub's line
    await page.waitForSelector(".update-line", { timeout: 15000 });
    await page.screenshot({ path: join(OUT, `${name}-1-hub-line.png`) });
    const l1 = await lineText(page);
    check(`${name}:line`, l1.includes(zh ? "hub.example 建議更新到 AgEnD v2.4.0-beta.4（目前 v2.3.5-beta.2）" : "hub.example recommends AgEnD v2.4.0-beta.4 (current v2.3.5-beta.2)")
      && l1.includes(zh ? "部分 Hub 功能需要這個版本。只有管理員看得到。" : "Some Hub features need it. Only admins see this."), l1);
    // 2. Update now → the one confirmation, naming the Hub → yes: one pinned launch
    const now = zh ? "立即更新" : "Update now";
    await page.click(`.update-line button:text-is("${now}")`); await page.waitForSelector("[data-confirm=yes]", { timeout: 8000 });
    await page.screenshot({ path: join(OUT, `${name}-2-confirm.png`) });
    const dlg = await page.evaluate(`document.querySelector("dialog[open]")?.innerText ?? ""`);
    check(`${name}:confirm`, dlg.includes("2.4.0-beta.4") && dlg.includes(zh ? "hub.example 建議的版本" : "the version hub.example recommends"), dlg);
    const started = page.waitForResponse((res: any) => new URL(res.url()).pathname === "/ui/update/start");
    await page.click("[data-confirm=yes]");
    const res = await started; await page.waitForTimeout(400);
    check(`${name}:start`, res.status() === 202 && launches.length === 1 && launches[0]!.pin === "2.4.0-beta.4", { status: res.status(), launches });
    await page.screenshot({ path: join(OUT, `${name}-3-started.png`) });
    // 3. one banner: the install's own update reaching the advised version wins; Later hides the Hub's line
    reset(); offer({ version: "2.4.0-beta.5", channel: "beta", installable: true });
    await page.reload(); await page.waitForSelector(".update-line", { timeout: 15000 });
    const l3 = await lineText(page);
    check(`${name}:one-banner`, !l3.includes("hub.example") && l3.includes("2.4.0-beta.5") && !l3.includes("||"), l3);
    reset();
    await page.reload(); await page.waitForSelector(".update-line", { timeout: 15000 });
    await page.click(`.update-line button:text-is("${zh ? "稍後" : "Later"}")`); await page.waitForTimeout(300);
    check(`${name}:later`, (await page.$(".update-line")) === null);
    await page.evaluate(`localStorage.removeItem("agend_update_later_hub")`);
    // 4. Settings → Advanced: "Recommended by hub.example"
    await page.goto(fx.base + "/settings/advanced"); await page.waitForSelector(".s-update", { timeout: 15000 });
    await page.evaluate(`document.querySelector(".s-update").scrollIntoView({ block: "start" })`); await page.waitForTimeout(300);
    await page.screenshot({ path: join(OUT, `${name}-4-settings.png`) });
    const card = await page.evaluate(`document.querySelector(".s-update").innerText`);
    check(`${name}:settings`, card.includes(zh ? "hub.example 建議的版本" : "Recommended by hub.example") && card.includes("v2.4.0-beta.4"), card);
    check(`${name}:clean`, errs.length === 0 && (await csp()).length === 0, errs);
    await ctx.close();
  }
} finally { await fx.close?.(); }
writeFileSync(join(OUT, "result.json"), JSON.stringify(r, null, 2));
console.log(fail.length ? `FAIL ${fail.length}: ${fail.join(", ")}\n${JSON.stringify(r, null, 2)}` : `ALL ${Object.keys(r).length} PASS`);
process.exit(fail.length ? 1 : 0);
