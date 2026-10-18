// The from-defaults harness itself (fleet decision a78ebdc5): a fresh profile signed in through the visible /signin on
// loopback, on a non-localhost origin (127.0.0.2) and on a real public link (only the tunnel stubbed). Checks each lands
// on the app with nothing seeded (the first-run / tour overlays are whatever a new person sees), that the public-link
// page knows it is one, and that the page logs no error; saves a screenshot of each.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-from-defaults-probe.mts
import { bootFixture, freshPage, openPublicLink, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-from-defaults-probe";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48410) });
// Demo names only in what is shot (the fixture's first instances are a real fleet's).
const DEMO = new Set(["observability-dashboards", "billing-reconciliation", "search-indexer", "資料清洗與報表自動化助理"]);
for (const name of Object.keys(fx.fm.fleetConfig.instances)) if (!DEMO.has(name)) delete fx.fm.fleetConfig.instances[name];
const results: any[] = [];
const watch = (page: any) => { const errors: string[] = []; page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160))); page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); }); return errors; };
const look = (page: any) => page.evaluate(`(() => ({ url: location.href, publicLink: document.body.dataset.publicLink === "1",
  seeded: Object.keys(localStorage).filter((k) => /^agend_(tour_done|firstrun_dismissed)$/.test(k)), app: !!document.querySelector(".app, #app, main") }))()`);
for (const [name, open] of [
  ["loopback-desk-light", () => freshPage(fx, { device: "desk", theme: "light", lang: "en" })],
  ["lan-phone-dark-reduced", () => freshPage(fx, { device: "phone", theme: "dark", lang: "zh-TW" }, { origin: "lan", reducedMotion: true })],
] as const) {
  const { ctx, page } = await open();
  const errors = watch(page);
  await page.waitForTimeout(800);
  await page.screenshot({ path: shotPath(SMOKE, name, "landing") });
  results.push({ name, ...(await look(page)), errors });
  await ctx.close();
}
const link = await openPublicLink(fx);
const { ctx, page } = await link.publicPage({ device: "phone", theme: "light", lang: "en" }, { reducedMotion: true });
const errors = watch(page);
await page.waitForTimeout(800);
await page.screenshot({ path: shotPath(SMOKE, "public-phone-light", "landing") });
results.push({ name: "public-phone-light", ...(await look(page)), errors });
await ctx.close(); await link.close();
console.log(JSON.stringify(results, null, 1));
const bad = results.filter((r) => !r.app || r.seeded.length || r.errors.length || (r.name.startsWith("public") !== r.publicLink));
console.log(bad.length ? `FAIL ${bad.map((b) => b.name).join(", ")}` : "PASS");
await fx.close();
process.exit(bad.length ? 1 : 0);
