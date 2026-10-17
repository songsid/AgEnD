// #1629 owner CSS smoke on the realistic fixture: an uploaded font and picture, a long owner stylesheet near its cap, the
// keep bar on Settings and Fleet, and the trial revert — per matrix case (desk 1366 / phone 390, light / dark, en / zh-TW).
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-owner-css.mts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, matrix, caseName, shotPath, PICTURES, ownerCss } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-owner-css";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48310) });
const REPO = process.env.REPO!;
const font = readFileSync(join(REPO, "src/ui/shared/fonts/inter.woff2")).toString("base64");
const pictureB64 = (await fx.picture({ ...PICTURES.bannerShort, mime: "image/jpeg" })).toString("base64");
const results: any = { browser: fx.browser.version(), cases: {} };
let setupDone = false;

for (const c of matrix()) {
  const { ctx, page, csp } = await fx.page(c);
  const errs: string[] = [];
  page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 160)));
  page.on("console", (m: any) => { if (/Content Security Policy|Refused/.test(m.text())) errs.push("console: " + m.text().slice(0, 200)); });
  // Upload a font and a picture, save CSS naming both, keep it — the page's own fetch (CSRF via agend-auth.js). Once per run:
  // the kept stylesheet is host state, so every later case sees it. The CSS carries a long owner stylesheet near its 64 KiB cap.
  if (!setupDone) {
    results.setup = await page.evaluate(`(async () => {
      const font = ${JSON.stringify(font)}, pic = ${JSON.stringify(pictureB64)};
      const bytes = (b) => Uint8Array.from(atob(b), c => c.charCodeAt(0));
      const up = async (b) => (await fetch("/ui/owner-css/asset", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: b })).json();
      const f = await up(bytes(font)), p = await up(bytes(pic));
      const css = ${JSON.stringify(ownerCss(40 * 1024))} + '\\n@font-face { font-family: OcSmoke; src: url("asset:' + f.id + '") format("woff2") } body { outline: 3px solid rgb(255, 0, 0); outline-offset: -3px } .main { background-image: url("asset:' + p.id + '") } h1, .panel-head h1 { font-family: OcSmoke, sans-serif }';
      const s = await (await fetch("/ui/owner-css", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: css }) })).json();
      const k = await (await fetch("/ui/owner-css/keep", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trial: s.trial }) })).json();
      return { f, p, cssBytes: css.length, s: { ok: s.ok, error: s.error ?? null }, k };
    })()`);
    setupDone = true;
  }
  const probe = () => page.evaluate(`(() => ({ link: document.getElementById("owner-css")?.getAttribute("href") ?? null, outline: getComputedStyle(document.body).outlineColor,
    bg: getComputedStyle(document.querySelector(".main")).backgroundImage, styleAttrs: document.querySelectorAll("[style]").length, styled: [...document.querySelectorAll("[style]")].map((e) => e.tagName + "." + e.className + " " + e.getAttribute("style")).slice(0, 3), csp: window.__csp,
    fontOk: document.fonts ? [...document.fonts].some((f) => f.family.includes("OcSmoke") && f.status === "loaded") : null }))()`);
  const r: any = { errs, lang: await page.evaluate("document.documentElement.lang"), theme: await page.evaluate("document.documentElement.getAttribute('data-theme')") };

  await page.goto(`${fx.base}/ui/fleet`); await page.waitForTimeout(1500); r.fleet = await probe();
  await page.screenshot({ path: shotPath(SMOKE, c, "fleet") });
  await page.goto(`${fx.base}/settings/appearance`); await page.waitForTimeout(1500); r.settings = await probe();
  await page.screenshot({ path: shotPath(SMOKE, c, "settings"), fullPage: true });
  await page.goto(`${fx.base}/ui/fleet?safe=1`); await page.waitForTimeout(1200); r.safe = await probe();
  // The keep bar: save a change from the Appearance editor (UI), then look at Fleet while it asks.
  await page.goto(`${fx.base}/settings/appearance`); await page.waitForSelector(".s-css-text");
  await page.fill(".s-css-text", "body { outline: 3px solid rgb(0, 0, 255); outline-offset: -3px }");
  await page.click(".s-css-actions .btn-primary"); await page.waitForTimeout(600);
  r.barOnSettings = await page.evaluate(`!!document.querySelector(".oc-keep")`);
  // A real load in the middle of the trial: the page asks the host, and shows the bar with the time left.
  await page.goto(`${fx.base}/ui/fleet`);
  await page.waitForTimeout(800); r.trial = await probe(); r.barOnFleet = await page.evaluate(`document.querySelector(".oc-keep")?.textContent ?? null`);
  await page.screenshot({ path: shotPath(SMOKE, c, "trial") });
  await page.waitForTimeout(23_000); r.afterRevert = await probe(); r.barGone = await page.evaluate(`!document.querySelector(".oc-keep")`);
  results.cases[caseName(c)] = r;
  await ctx.close();
}
writeFileSync(shotPath(SMOKE, "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(results, null, 1));
console.log(JSON.stringify({ smoke: SMOKE, setup: results.setup, cases: Object.keys(results.cases).length }));
await fx.close(); process.exit(0);
