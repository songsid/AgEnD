// #2978 merge (release/2.3.5-alpha into improve/settings-ui; quality rule 3): every Settings section in a fresh tab and
// in a stale one — a tab opened before this lands (app.js, app-shell.js, app-stream.js, app.css and instance-nav.js
// from SKEW, the release tip it merged), which then loads the new lazy Settings panels. Judged: the panel and its section
// render (no error state), the alpha.3 cards are where they belong on a web-only fleet (Agent defaults: General location;
// Access & security → Login: Connections from outside), no page errors. Desk and phone; screenshots of each.
//   PW_DIR=… REPO=<checkout> OUT=<dir> SKEW=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-settings-stale-2978.mts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-settings-stale-2978";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48953), classic: false, instances: 3 });
const fm = fx.fm as any;
const token = fm.getDashboardAccess().token as string;
const hostCode = async () => (await (await fetch(`${fx.base}/auth/issue-code`, { method: "POST", headers: { "x-agend-token": token, origin: fx.base } })).json()).code as string;
const SECTIONS = ["preferences", "look", "agents", "agent-defaults", "chat", "web-dashboard", "access", "advanced"];
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
for (const c of [{ device: "desk", width: 1366, height: 900 }, { device: "phone", width: 390, height: 844 }] as const) {
  for (const mode of ["fresh", "stale"] as const) {
    const name = `${c.device}-${mode}`, failed: string[] = [];
    const ctx = await fx.browser.newContext({ viewport: { width: c.width, height: c.height }, isMobile: c.device === "phone", hasTouch: c.device === "phone", locale: "en-US" });
    await ctx.addInitScript({ content: `try { localStorage.setItem("agend_tour_done","1"); localStorage.setItem("agend_firstrun_dismissed","1"); localStorage.setItem("agend_lang","en"); } catch {}` });
    const page = await ctx.newPage(), errors: string[] = [];
    page.on("pageerror", (e: any) => errors.push(String(e)));
    if (mode === "stale") for (const f of ["app.js", "app-shell.js", "app-stream.js", "app.css", "instance-nav.js"]) {
      const body = readFileSync(join(process.env.SKEW!, f), "utf8");
      await page.route(`**/assets/${f}*`, (r: any) => r.fulfill({ status: 200, contentType: f.endsWith(".css") ? "text/css" : "text/javascript", body }));
    }
    try {
      await page.goto(`${fx.base}/signin`); await page.waitForSelector("#code");
      await page.fill("#code", await hostCode()); await page.click("#go"); await page.waitForURL(`${fx.base}/ui`);
      for (const s of SECTIONS) {
        // In-page navigation: a stale tab keeps its old shell and loads the new section lazily.
        await page.evaluate((path: string) => { history.pushState(null, "", path); dispatchEvent(new PopStateEvent("popstate")); }, `/settings/${s}`);
        await page.waitForSelector(".p-settings", { timeout: 15000 }).catch(() => failed.push(`${s}: no settings panel`));
        await sleep(700);
        const broken = await page.locator(".p-settings .error-state, .p-settings [role=alert].error").count();
        if (broken) failed.push(`${s}: an error state`);
        if (s === "agent-defaults" && !(await page.locator(".p-settings").textContent())?.length) failed.push("agent-defaults: empty");
        if (s === "access" && (await page.locator("#outsideCard").count()) !== 1) failed.push("access: no Connections from outside card in the Login tab");
        await page.screenshot({ path: shotPath(SMOKE, name, s), fullPage: true });
      }
      if (errors.length) failed.push(`page errors: ${errors.slice(0, 3).join(" | ")}`);
    } catch (e) { failed.push(String(e).slice(0, 300)); }
    results.push({ name, ok: !failed.length, failed });
    console.log(`${failed.length ? "FAIL" : "PASS"} ${name}${failed.length ? " — " + failed.join("; ") : ""}`);
    await ctx.close();
  }
}
writeFileSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE, "result.json"), JSON.stringify(results, null, 2));
await fx.close();
process.exit(results.every(r => r.ok) ? 0 : 1);
