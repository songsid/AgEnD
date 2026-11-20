// M-3438: normal authenticated child window, real isolated preview listener; synthetic history only.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, matrix, caseName } from "../smoke-fixture/index.mts";
const out = process.env.OUT ?? ".artifacts/m3438/captures";
mkdirSync(out, { recursive: true });
const fx = await bootFixture({ port: Number(process.env.HP ?? 49040), instances: 2, classic: false });
const name = fx.instances.find(i => !i.general)!.name;
const fence = String.fromCharCode(96).repeat(3);
const html = (title: string, v: number) => "<title>" + title + "</title><h1>" + title + " v" + v + "</h1><p id=demo>Example preview</p>";
const say = (title: string, v: number) => fx.fm.emitSseEvent("message", { instance: name, sender: name, role: "agent", ts: new Date().toISOString(),
  text: fence + "html\n" + html(title, v) + "\n" + fence });
say("Example counter", 1); say("Example report", 1); say("Example counter", 2);
const results: any[] = [];
try {
  for (const c of matrix("desk-light-en,phone-dark-zh-TW")) {
    const { ctx, page, csp } = await fx.page(c, { path: "/ui/chat/" + encodeURIComponent(name), prefs: { "preview.optIn": true } });
    const errors: string[] = [], sends: string[] = [];
    const trace = "window.__previewTrace=[];addEventListener('message',e=>{if(e.data?.channel?.includes('popout'))window.__previewTrace.push({type:e.data.type,channel:e.data.channel,originMatches:e.origin===location.origin,opener:e.source===window.opener,payloadKeys:Object.keys(e.data.payload||{})})})";
    await ctx.addInitScript(trace); await page.evaluate(trace);

    page.on("pageerror", (e: Error) => errors.push(e.message));
    ctx.on("request", (r: any) => { if (r.url().includes("/ui/send")) sends.push(r.method()); });
    await page.locator("#msgIn").fill("Example draft remains here");
    await page.locator(".html-card .pv-open").last().click();
    await page.locator(".pv-panel-popout").waitFor();
    const launcher = await page.locator(".pv-panel-popout").boundingBox();
    if (c.device === "phone" && (!launcher || launcher.width < 44 || launcher.height < 44)) throw new Error("popout touch target");
    await page.screenshot({ path: join(out, caseName(c) + "-source.png") });
    const child = page.waitForEvent("popup");
    await page.locator(".pv-panel-popout").click();
    const popup = await child;
    popup.on("pageerror", (e: Error) => errors.push(e.message));
    await popup.setViewportSize(c.device === "phone" ? { width: 390, height: 844 } : { width: 760, height: 800 });
    try { await popup.waitForSelector('html[data-preview-window="1"]'); }
    catch (err) {
      writeFileSync(join(out, "debug.json"), JSON.stringify({
        parent: await page.evaluate("({trace:window.__previewTrace,toasts:[...document.querySelectorAll('.toast')].map(x=>x.textContent)})"),
        child: await popup.evaluate("({trace:window.__previewTrace,opener:!!window.opener,body:document.body.dataset.mode,ended:window.AgendAuth?.sessionEnded(),hasSession:!!window.AgendAuth,hasPanel:!!document.querySelector('.pv-panel'),toasts:[...document.querySelectorAll('.toast')].map(x=>x.textContent)})"), errors,
      }, null, 2)); throw err;
    }
    await popup.locator(".pv-panel iframe").waitFor();
    await popup.frameLocator(".pv-panel iframe").locator("#demo").waitFor();
    await page.locator(".pv-panel").waitFor({ state: "detached" });
    if (await page.locator("#msgIn").inputValue() !== "Example draft remains here") throw new Error("source draft changed");
    if (await popup.locator("#msgIn").inputValue() !== "") throw new Error("draft transferred");
    const sandbox = await popup.locator(".pv-panel iframe").getAttribute("sandbox");
    const frameSrc = await popup.locator(".pv-panel iframe").getAttribute("src");
    if (sandbox !== "allow-scripts" || new URL(frameSrc!, popup.url()).origin === new URL(popup.url()).origin) throw new Error("preview isolation changed");
    await popup.screenshot({ path: join(out, caseName(c) + "-popout.png") });
    await popup.locator(".pv-changes").click();
    await popup.locator(".pv-diff-wrap").waitFor();
    const diffScroll = await popup.locator(".pv-diff").evaluate((el: any) => {
      el.scrollLeft = el.scrollWidth;
      return { max: el.scrollWidth - el.clientWidth, reached: el.scrollLeft };
    });
    if (diffScroll.max > 1 && diffScroll.reached < diffScroll.max - 1) throw new Error("diff cannot scroll");
    await popup.screenshot({ path: join(out, caseName(c) + "-changes.png") });
    await popup.locator(".pv-ver-prev").click();
    await popup.locator(".pv-ver-at").filter({ hasText: "1" }).waitFor();
    await popup.locator(".pv-pages-toggle").click();
    await popup.locator(".pv-page").first().waitFor();
    if (await popup.locator(".pv-page").count() !== 2) throw new Error("page count");
    await popup.screenshot({ path: join(out, caseName(c) + "-pages.png") });
    await popup.locator(".pv-page").filter({ hasText: "Example report" }).click();
    await popup.locator(".pv-panel-run").click();
    await popup.locator(".pv-panel iframe").waitFor();
    await popup.locator(".pv-panel-fs").click();
    await popup.locator(".pv-panel.pv-fs").waitFor();
    await popup.screenshot({ path: join(out, caseName(c) + "-fullscreen.png") });
    const geometry = await popup.evaluate('({mode:document.querySelector(".pv-panel").className,overflow:document.documentElement.scrollWidth>innerWidth,fs:document.fullscreenElement?.classList.contains("pv-panel")??false,frameFull:document.fullscreenElement?.tagName==="IFRAME"})');
    if (geometry.overflow || geometry.frameFull) throw new Error("popout geometry");
    await popup.locator(".pv-panel-fs").click();
    await popup.locator(".pv-fb-reply").click();
    await popup.locator('html[data-preview-window="1"]').waitFor({ state: "detached" });
    await popup.locator("#msgIn").waitFor({ state: "visible" });
    if (!(await popup.locator("#msgIn").inputValue())) throw new Error("reply did not reveal own draft");
    if (sends.length || errors.length || (await csp()).length) throw new Error("unexpected send or page error");
    results.push({ case: caseName(c), sandbox, isolatedOrigin: true, versions: true, changes: true, pages: true,
      sourceDraftRetained: true, sourceClosedAfterHandoff: true, launcher, diffScroll, ...geometry, errors, sends });
    await popup.close(); await ctx.close();
  }
  writeFileSync(join(out, "checks.json"), JSON.stringify(results, null, 2) + "\n");
} finally { await fx.close(); }
