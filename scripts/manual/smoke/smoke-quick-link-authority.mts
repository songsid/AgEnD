// Design #1939 §0.3 from defaults (fleet decision a78ebdc5), through visible UI: web authority over the temporary
// public link, off by default (the user's decision, 2026-10-23).
// - Settings → Web → Web authority, as an admin on this computer: the row "Also over the temporary public link" is there
//   (no hostname needed), off by default, its risk said; an authorized session that came over the link is marked.
//   Turning it on (check → Review → Apply changes) is held for a confirmation: fleet.yaml keeps quick_link unset — a
//   General or the host decides, never this browser (#2170).
// - Over the temporary public link (the fixture's stubbed gateway: no tunnel, no Cloudflare), signed in through its own
//   sign-in: with the option off, the row under the composer says how to turn it on (no Settings link: it can't be
//   changed there); with it on, it offers Authorize.
// Desk light en, phone dark zh-TW.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [PW_ENGINE=webkit] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-quick-link-authority.mts
import { writeFileSync } from "node:fs";
import { bootFixture, mounted, openPublicLink, shotPath } from "../smoke-fixture/index.mts";
const { tokenEpoch } = await import(process.env.REPO + "/src/web-session.ts");

const SMOKE = "quick-link";
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const WEBKIT_OWN = /^(Viewport argument key "interactive-widget" not recognized and ignored\.|Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy\.|(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/(ui\/[a-z-]+|auth\/sessions?|api\/[a-z/-]+)(\?\S*)? due to access control checks\.)/;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48866), instances: 4, webYaml: ["  verified_authority:", "    enabled: true"].join("\n") });
const fm = fx.fm;
const agents = fx.instances.filter((i: any) => !i.general).map((i: any) => i.name);
const results: any[] = [];
const ok = (r: any, k: string, v: boolean, detail?: unknown) => { r[k] = detail === undefined ? v : { pass: v, detail }; if (!v) r.failed = [...(r.failed ?? []), k]; };
const words = (lang: string) => lang === "en"
  ? { row: "Also over the temporary public link", risk: "Cloudflare's quick-tunnel service", marked: "over the temporary public link", off: "Also over the temporary public link", authorize: "Authorize" }
  : { row: "也允許透過臨時公開連結", risk: "Cloudflare 的 quick tunnel 服務", marked: "透過臨時公開連結", off: "也允許透過臨時公開連結", authorize: "授權" };
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
  const r: any = { case: `${c.device}-${c.theme}-${c.lang}` }; results.push(r);
  const w = words(c.lang);
  // A demo account's session that came over the temporary link, authorized (as the Confirm path records it, peer kept).
  fm.initializeWebSessions();
  const owner = { adapterId: "demo", userId: "101101101101101101" };
  const phone = fm.webSessions.create({ tier: "admin", surface: "gateway", exposureId: "e".repeat(32), label: "Safari on iPhone", tokenEpoch: tokenEpoch(fm.webToken), owner }).record;
  fm.sessionAuthorizationStore().authorize(phone.handle, owner, Date.now(), fm.webAuthorityState().epoch, Date.now() + 4 * 3_600_000, "quick_link");
  const { ctx, page, personKey, errors } = await fx.page(c, { path: "/settings/web" }).then((p: any) => ({ ...p, errors: [] as string[] }));
  page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
  page.on("console", (m: any) => { if (m.type() === "error" && !(ENGINE === "webkit" && WEBKIT_OWN.test(m.text()))) errors.push(m.text().slice(0, 160)); });
  try {
    await page.waitForSelector(".s-web-authority #vaQuickLink", { timeout: 10000 });
    await page.setViewportSize({ width: c.device === "phone" ? 390 : 1366, height: 4000 });
    await page.waitForTimeout(300);
    const seen = await page.evaluate(`(() => { const box = document.querySelector("#vaQuickLink"), card = document.querySelector(".s-web-authority");
      return { checked: box.checked, label: box.closest("label").textContent, text: card.textContent, named: !!document.querySelector("#vaNamedLink"),
        marked: [...document.querySelectorAll("#vaSessions .s-va-quick")].map(e => e.textContent), overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`) as any;
    ok(r, "rowOffByDefault", seen.checked === false);
    ok(r, "rowNamed", seen.label.includes(w.row), seen.label);
    ok(r, "riskSaid", seen.text.includes(w.risk));
    ok(r, "noNamedRowWithoutHostname", seen.named === false);
    ok(r, "sessionMarked", seen.marked.length === results.length && seen.marked.every((m: string) => m === w.marked), seen.marked);
    ok(r, "noOverflow", !seen.overflow);
    const card = await page.$(".s-web-authority");
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: shotPath(SMOKE, r.case, "1-card") });
    await page.check("#vaQuickLink");
    await page.click("#vaReview");
    await page.click('[role=region] button.btn-primary');
    await page.waitForTimeout(1500);
    ok(r, "heldNotWritten", fm.fleetConfig.web?.verified_authority?.quick_link !== true, fm.fleetConfig.web?.verified_authority);
    await page.screenshot({ path: shotPath(SMOKE, r.case, "2-after-apply") });
  } catch (err) { r.failed = [...(r.failed ?? []), `threw: ${String(err).slice(0, 200)}`]; }
  if (errors.length) { r.errors = errors; r.failed = [...(r.failed ?? []), "pageErrors"]; }
  await ctx.close();
  // The case's own theme and language go, so the next viewer (the public link's) starts from defaults too.
  for (const who of [personKey, "operator"].filter(Boolean)) fm.webPrefs.write(who, new Map([["theme", null], ["lang", null]]));
}
// Over the temporary public link: the composer's row, the option off, then on.
const link = await openPublicLink(fx);
// The fixture's demo account stands in for a fleet admin (its channels carry no admin list): admission is then decided by
// the link's option, as for a real admin.
const adminGate = fm.adminGate.bind(fm);
fm.adminGate = () => "ok";
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
  for (const on of [false, true]) {
    const r: any = { case: `${c.device}-${c.theme}-${c.lang}-public-${on ? "on" : "off"}` }; results.push(r);
    const w = words(c.lang);
    fm.fleetConfig.web.verified_authority = { enabled: true, ...(on ? { quick_link: true } : {}) };
    let p: any = null;
    try {
      p = await link.publicPage(c as any, { path: `/ui/chat/${agents[0]}` });
      ok(r, "mounted", await mounted(p.page));
      await p.page.locator("#msgIn").waitFor({ timeout: 10000 });
      await p.page.locator(".webauth-row").first().waitFor({ timeout: 10000 });
      await p.page.waitForTimeout(500);
      const row = await p.page.evaluate(`(() => { const r = document.querySelector(".webauth-row"); return { state: r.dataset.state, text: r.textContent,
        title: r.querySelector(".note")?.getAttribute("title") ?? "", ask: r.querySelector("button.webauth-ask")?.textContent ?? null, settings: !!r.querySelector('a[href="/settings/web"]') }; })()`) as any;
      r.row = row;
      if (on) ok(r, "authorizeOffered", row.ask === w.authorize, row);
      else ok(r, "offSaysHow", row.state === "none" && row.title.includes(w.off) && row.ask === null && !row.settings, row);
      await p.page.screenshot({ path: shotPath(SMOKE, r.case, "3-composer") });
      const errs = (p.errors as string[]).filter((e) => !(ENGINE === "webkit" && WEBKIT_OWN.test(e)));
      if (errs.length) { r.errors = errs; r.failed = [...(r.failed ?? []), "pageErrors"]; }
    } catch (err) {
      r.failed = [...(r.failed ?? []), `threw: ${String(err).slice(0, 200)}`];
      await p?.page.screenshot({ path: shotPath(SMOKE, r.case, "error") }).catch(() => {});
    }
    await p?.ctx.close();
  }
}
await link.close();
fm.adminGate = adminGate;
const pass = results.every((x) => !x.failed);
writeFileSync(shotPath(SMOKE, `result-${ENGINE}`, "x").replace(/-x\.png$/, ".json"), JSON.stringify({ pass, results }, null, 1));
console.log(JSON.stringify({ pass, results: results.map((x) => ({ case: x.case, failed: x.failed ?? [], row: x.row })) }, null, 1));
await fx.close();
process.exit(pass ? 0 : 1);
