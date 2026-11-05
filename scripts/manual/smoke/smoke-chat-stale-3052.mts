// #3052 review (second reviewer, item 2): the chat panel in a stale tab. panel-chat.js is loaded on demand, so a tab opened
// before an upgrade gets the new one, while the shell it keeps (app.js, app-shell.js, app-stream.js, app.css and
// instance-nav.js, from SKEW: the release tip this branch is based on) is the old one. The new chat panel must still load
// and render: it used to import `machineName` from the shell's instance-nav.js, which the old copy does not have, so the
// import failed and every chat stayed blank. Fresh and stale tabs, desk and phone; judged: the chat page renders (its
// header and message list are there), no page errors, and the stale tab really ran the old shell (instance-nav has no
// machineName export). Same method as smoke-settings-stale-2978.mts.
//   SKEW=<dir with the old shell files, e.g. `git archive <base> src/ui/shared | tar -x -C <dir>` then <dir>/src/ui/shared>
//   PW_DIR=… REPO=<checkout> OUT=<dir> SKEW=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-chat-stale-3052.mts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-chat-stale-3052";
const SHELL = ["app.js", "app-shell.js", "app-stream.js", "app.css", "instance-nav.js"];
const fx = await bootFixture({ port: Number(process.env.HP ?? 48955), classic: false, instances: 3 });
const fm = fx.fm as any;
const token = fm.getDashboardAccess().token as string;
const hostCode = async () => (await (await fetch(`${fx.base}/auth/issue-code`, { method: "POST", headers: { "x-agend-token": token, origin: fx.base } })).json()).code as string;
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const target = fx.instances[0].name;
for (const c of [{ device: "desk", width: 1366, height: 900 }, { device: "phone", width: 390, height: 844 }] as const) {
  for (const mode of ["fresh", "stale"] as const) {
    const name = `${c.device}-${mode}`, failed: string[] = [];
    const ctx = await fx.browser.newContext({ viewport: { width: c.width, height: c.height }, isMobile: c.device === "phone", hasTouch: c.device === "phone", locale: "en-US" });
    await ctx.addInitScript({ content: `try { localStorage.setItem("agend_tour_done","1"); localStorage.setItem("agend_firstrun_dismissed","1"); localStorage.setItem("agend_lang","en"); } catch {}` });
    const page = await ctx.newPage(), errors: string[] = [];
    page.on("pageerror", (e: any) => errors.push(String(e)));
    if (mode === "stale") for (const f of SHELL) {
      const body = readFileSync(join(process.env.SKEW!, f), "utf8");
      await page.route(`**/assets/${f}*`, (r: any) => r.fulfill({ status: 200, contentType: f.endsWith(".css") ? "text/css" : "text/javascript", body }));
    }
    try {
      await page.goto(`${fx.base}/signin`); await page.waitForSelector("#code");
      await page.fill("#code", await hostCode()); await page.click("#go"); await page.waitForURL(`${fx.base}/ui`);
      if (mode === "stale") {
        const hasExport = await page.evaluate(async () => "machineName" in (await import("/assets/instance-nav.js")));
        if (hasExport) failed.push("the stale shell is not stale: its instance-nav.js already exports machineName (check SKEW)");
      }
      // In-page navigation: a stale tab keeps its old shell and loads the chat panel lazily.
      await page.evaluate((path: string) => { history.pushState(null, "", path); dispatchEvent(new PopStateEvent("popstate")); }, `/ui/chat/${encodeURIComponent(target)}`);
      await page.waitForSelector(".p-chat", { timeout: 15000 }).catch(() => failed.push("no chat panel (blank page?)"));
      await sleep(900);
      if (!(await page.locator(".p-chat").count())) failed.push("chat panel missing");
      else if (!((await page.locator(".p-chat").textContent()) ?? "").trim().length) failed.push("chat panel is empty");
      if (await page.locator(".p-chat .error-state, .p-chat [role=alert].error").count()) failed.push("an error state in chat");
      await page.screenshot({ path: shotPath(SMOKE, name, "chat"), fullPage: true });
      if (errors.length) failed.push(`page errors: ${errors.slice(0, 3).join(" | ")}`);
    } catch (e) { failed.push(String(e).slice(0, 300)); }
    results.push({ name, ok: !failed.length, failed });
    console.log(`${failed.length ? "FAIL" : "PASS"} ${name}${failed.length ? " — " + failed.join("; ") : ""}`);
    await ctx.close();
  }
}
const out = join(process.env.OUT ?? "/tmp/smoke-out", SMOKE); mkdirSync(out, { recursive: true });
writeFileSync(join(out, "result.json"), JSON.stringify(results, null, 2));
await fx.close();
process.exit(results.every(r => r.ok) ? 0 : 1);
