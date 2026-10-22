// #2453 (design #1939 §0.2) from defaults (fleet decision a78ebdc5), through visible UI: Settings → Web → Web authority
// on a fleet with a fixed named-tunnel hostname, as an admin.
// - The row "Also over my named link (<hostname>)" is there, off by default; an authorized session that came over the
//   named link is marked in the list.
// - Turning it on (check → Review → Apply changes) is held for a confirmation: fleet.yaml keeps named_link unset — a
//   General or the host decides, never this browser (no self-confirmation, #2170).
// - With no hostname (a quick tunnel only) the row is not there.
// Desk light en, phone dark zh-TW. No tunnel, no Cloudflare: the hostname is configuration only.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2453-named-link-authority.mts
import { writeFileSync } from "node:fs";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";
const { tokenEpoch } = await import(process.env.REPO + "/src/web-session.ts");

const SMOKE = "2453";
const HOST = "agend.example.com";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48816), instances: 4,
  webYaml: ["  public_link:", `    hostname: ${HOST}`, "  verified_authority:", "    enabled: true"].join("\n") });
const fm = fx.fm;
const results: any[] = [];
const ok = (r: any, k: string, v: boolean, detail?: unknown) => { r[k] = detail === undefined ? v : { pass: v, detail }; if (!v) r.failed = [...(r.failed ?? []), k]; };
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
  const r: any = { case: `${c.device}-${c.theme}-${c.lang}` }; results.push(r);
  // A demo account's session that came over the named link, authorized (as the Confirm path would record it).
  fm.initializeWebSessions();
  const owner = { adapterId: "demo", userId: "101101101101101101" };
  const phone = fm.webSessions.create({ tier: "admin", surface: "gateway", exposureId: "e".repeat(32), label: "Safari on iPhone", tokenEpoch: tokenEpoch(fm.webToken), owner }).record;
  fm.sessionAuthorizationStore().authorize(phone.handle, owner, Date.now(), fm.webAuthorityState().epoch, Date.now() + 12 * 3_600_000);
  const { ctx, page } = await fx.page(c, { path: "/settings/web" });
  const errors: string[] = [];
  page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
  page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
  try {
    await page.waitForSelector(".s-web-authority #vaNamedLink", { timeout: 10000 });
    await page.setViewportSize({ width: c.device === "phone" ? 390 : 1366, height: 4000 });
    await page.waitForTimeout(300);
    const seen = await page.evaluate(`(() => { const box = document.querySelector("#vaNamedLink");
      return { checked: box.checked, label: box.closest("label").textContent, marked: [...document.querySelectorAll("#vaSessions .s-va-named")].map(e => e.textContent),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`) as any;
    ok(r, "rowOffByDefault", seen.checked === false);
    ok(r, "rowNamesHost", seen.label.includes(HOST) && seen.label.includes(c.lang === "en" ? "Also over my named link" : "也允許透過我的固定網域"), seen.label);
    // Every case adds one named-link session to the same fixture: each one listed is marked, in the page's language.
    ok(r, "sessionMarked", seen.marked.length === results.length && seen.marked.every((m: string) => m === (c.lang === "en" ? "over your named link" : "透過你的固定網域")), seen.marked);
    ok(r, "noOverflow", !seen.overflow);
    const card = await page.$(".s-web-authority");
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: shotPath(SMOKE, r.case, "1-card") });
    // Turn it on: staged, then Apply — held for a confirmation, nothing written.
    await page.check("#vaNamedLink");
    await page.click("#vaReview");
    await page.click('[role=region] button.btn-primary');
    await page.waitForTimeout(1500);
    ok(r, "heldNotWritten", fm.fleetConfig.web?.verified_authority?.named_link !== true, fm.fleetConfig.web?.verified_authority);
    await page.screenshot({ path: shotPath(SMOKE, r.case, "2-after-apply"), fullPage: false });
  } catch (err) {
    r.failed = [...(r.failed ?? []), `threw: ${String(err).slice(0, 200)}`];
  }
  r.errors = errors;
  if (errors.length) r.failed = [...(r.failed ?? []), "pageErrors"];
  await ctx.close();
}
// No hostname (a quick tunnel only): the row is not there.
{
  const r: any = { case: "desk-light-en-no-hostname" }; results.push(r);
  delete fm.fleetConfig.web.public_link.hostname;
  const { ctx, page } = await fx.page({ device: "desk", theme: "light", lang: "en" } as any, { path: "/settings/web" });
  try {
    await page.waitForSelector(".s-web-authority #vaEnabled", { timeout: 10000 });
    ok(r, "noRowWithoutHostname", (await page.$("#vaNamedLink")) === null);
  } catch (err) { r.failed = [...(r.failed ?? []), `threw: ${String(err).slice(0, 200)}`]; }
  await ctx.close();
}
const pass = results.every((x) => !x.failed);
writeFileSync(shotPath(SMOKE, "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify({ pass, results }, null, 1));
console.log(JSON.stringify({ pass, results }, null, 1));
await fx.close();
process.exit(pass ? 0 : 1);
