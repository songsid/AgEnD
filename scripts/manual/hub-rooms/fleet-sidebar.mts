/**
 * M-3127 C (web-claude: "Fleet and Hub sidebar PNGs side by side"): the Fleet dashboard's own sidebar — its filter box at
 * the foot (instance-nav.js .v-filter), the Search row (Ctrl K) above — from the shared smoke fixture: the product's web
 * server from an in-process FleetManager in a scratch AGEND_HOME, 12 fixture instances; no fleet start, no CLI, no tmux.
 *   PW_DIR=<playwright-core root> REPO=$PWD OUT=<dir> npx tsx scripts/manual/hub-rooms/fleet-sidebar.mts
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bootFixture } from "../smoke-fixture/index.mts";

const out = resolve(process.env.OUT ?? ".artifacts/hub-rooms-search");
const fx = await bootFixture({ port: Number(process.env.HP ?? 48971), classic: false, instances: 12 });
const checks: { name: string; ok: boolean }[] = [];
try {
  for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" }] as const) {
    const { ctx, page } = await fx.page(c, { path: "/ui" });
    await page.waitForSelector("#sidebar .v-filter input", { timeout: 15000 });
    const atFoot = await page.evaluate(() => { const f = document.querySelector("#sidebar .v-filter"), s = document.querySelector("#sidebar .side-search, #sidebar [aria-keyshortcuts]");
      return !!f && !!s && f.getBoundingClientRect().top > s.getBoundingClientRect().bottom; });
    checks.push({ name: `${c.device}-${c.theme}-${c.lang}: the Fleet's filter box is at the sidebar's foot, below its Search row`, ok: atFoot });
    await page.locator("#sidebar").first().screenshot({ path: join(out, `fleet-sidebar.${c.device === "desk" ? "desktop" : c.device}-${c.lang}-${c.theme}.png`) });
    await ctx.close();
  }
} finally { await fx.close(); }
for (const x of checks) console.log(`${x.ok ? "PASS" : "FAIL"} ${x.name}`);
writeFileSync(join(out, "fleet-sidebar.json"), JSON.stringify({ checks }, null, 2));
process.exit(checks.every(x => x.ok) ? 0 : 1);
