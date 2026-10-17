// #1629 preview smoke on the realistic fixture: an agent's theme exported as preview files (light and dark SVG with their
// pictures), written to OUT the way the daemon writes them, and each SVG opened from disk at the matrix's device viewport.
// The export is a file, so theme and language do not change it; the matrix varies only the viewport it is opened at.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-preview.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bootFixture, matrix, caseName, shotPath, PICTURES, VIEWPORTS, TEXT } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-preview";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48330) });
const fm = fx.fm;
const W = "rd1-platform-backend-sr4-server-t1547091841202130997";
const AV = fm.themeStore.addAsset(W, "avatar", await fx.picture(PICTURES.avatarTransparent));
const BG = fm.themeStore.addAsset(W, "background", await fx.picture({ w: 800, h: 500, hue: 200, label: "", mime: "image/jpeg", seed: 9 }));
const P = fm.themeStore.addAsset(W, "portrait", await fx.picture(PICTURES.portrait));
const B = fm.themeStore.addAsset(W, "banner", await fx.picture(PICTURES.bannerWide));
const set = fx.seedTheme(W, { v: 1, accent: "#8b5cf6", avatar: AV.id, background: { image: BG.id, fit: "cover", opacity: 0.3 }, bubble: { radius: 6, border: "accent" },
  workingLabel: "Brewing", card: { portrait: P.id, banner: B.id, tagline: TEXT.taglineCjk, bio: TEXT.bioLatin } });
const results: any = { browser: fx.browser.version(), set: { av: AV.id ?? AV, bg: BG.id ?? BG, set } };

const prev = await fm.handleWebThemeHttp(W, "preview_web_appearance", {});
results.files = prev.files ? prev.files.map((f: any) => f.mode) : prev;
// Written as the daemon writes them: every file into one folder, then each SVG opened from disk (its pictures beside it).
const dir = join(process.env.OUT!, SMOKE, "files"); mkdirSync(dir, { recursive: true });
for (const f of prev.files ?? []) writeFileSync(join(dir, f.name), Buffer.from(f.data_b64, "base64"));
results.sizes = Object.fromEntries((prev.files ?? []).map((f: any) => [f.name, Buffer.from(f.data_b64, "base64").length]));

results.cases = {};
for (const c of matrix()) {
  const ctx = await fx.browser.newContext({ viewport: VIEWPORTS[c.device], deviceScaleFactor: 1, locale: c.lang === "zh-TW" ? "zh-TW" : "en-US", isMobile: c.device === "phone", hasTouch: c.device === "phone" });
  const page = await ctx.newPage();
  const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e)));
  const r: any = { errs: errs };
  for (const mode of ["light", "dark"]) {
    await page.goto(pathToFileURL(join(dir, `${mode}.svg`)).href);
    await page.waitForTimeout(500);
    r[mode] = await page.evaluate(`(() => [...document.querySelectorAll("image")].map((i) => { const b = i.getBBox(); return i.getAttribute("href") + " " + Math.round(b.width) + "x" + Math.round(b.height); }))()`);
    await page.screenshot({ path: shotPath(SMOKE, c, `preview-${mode}`), timeout: 15000 });
  }
  r.errs = errs;
  results.cases[caseName(c)] = r;
  await ctx.close();
}
writeFileSync(shotPath(SMOKE, "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(results, null, 1));
console.log(JSON.stringify({ smoke: SMOKE, files: results.files, cases: Object.keys(results.cases).length }));
await fx.close(); process.exit(0);
