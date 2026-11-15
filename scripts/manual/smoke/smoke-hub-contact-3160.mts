// Real product shell, inert member client, scratch FleetManager with no fleet/CLI start.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, matrix, caseName } from "../smoke-fixture/index.mts";
const out = process.env.OUT!; mkdirSync(out, { recursive: true });
const fx = await bootFixture({ port: 19581, classic: false, instances: 2, host: true });
const results: unknown[] = [];
try {
  for (const c of matrix("desk-light-en,phone-dark-zh-TW")) {
    const { ctx, page } = await fx.page(c, { path: "/ui" });
    const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.route("**/settings/hub", async (r: any) => { const res = await r.fetch(); await r.fulfill({ response: res, body: (await res.text()).replace(/<body([^>]*)>/, '<body$1 data-hub="member">') }); });
    await page.evaluate(`(async () => {
      const m = await import('/ui/js/hub-client.js');
      const s = m.createStubClient({ agents: () => [{name:'analyst',display_name:'Analysis agent'}] });
      await s.connect({address:'https://hub.example.test',code:'ABCD-EFGH'}); s.control.ownerConfirmed(); s.control.approve({name:'Team Hub'}); s.control.enforceable(['analyst']);
      await s.setExposed('analyst',true,0,{dataViewId:'agent',tools:[]});window.fixturePairing=await s.pairing();
      const list=s.exposures.bind(s); let notice=true;
      s.exposures=async()=> (await list()).map(x=>({...x,contactLimitNotice:notice}));
      s.acknowledgeContactLimitNotice=async()=>{notice=false;return true};
      const set=s.setExposed.bind(s);window.fixtureCalls=[];
      s.setExposed=async(...args)=>{window.fixtureCalls.push(args);return set(...args)};
      m.setHubClient(s); document.body.setAttribute("data-hub", "member");
    })()`);
    const pairing = await page.evaluate("window.fixturePairing");
    await page.route("**/api/settings/hub/membership**", (r: any) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ connectionCardV1: true, enabled: true, pairing }) }));
    await page.evaluate(`history.pushState(null, "", "/settings/hub"); dispatchEvent(new PopStateEvent("popstate"));`);
    await page.waitForSelector(".hub-contact-limit input", { timeout: 15000 });
    const tick = page.locator(".hub-contact-limit input");
    if (!(await tick.isChecked())) throw Error("Contact limit must default on");
    await page.locator(".hub-exposures").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, `${caseName(c)}.png`), fullPage: true });
    await page.locator(".hub-contact-notice button").click();
    await page.waitForFunction(() => !document.querySelector(".hub-contact-notice"));
    await tick.uncheck(); await page.locator(".hub-exposure-main input").check();
    const calls = await page.evaluate("window.fixtureCalls");
    if (calls.length !== 1 || calls[0][3].contactLimit !== false) throw Error("Opt-out was not sent with sharing");
    if (errors.length) throw Error(errors.join("\n"));
    results.push({ case: caseName(c), defaultOn: true, noticeDismissed: true, explicitOptOut: true, errors });
    await ctx.close();
  }
  writeFileSync(join(out, "checks.json"), JSON.stringify(results, null, 2)); console.log(JSON.stringify(results));
} finally { await fx.close(); }
