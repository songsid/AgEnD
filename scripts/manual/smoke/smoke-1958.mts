// #1958 PR B2 smoke, on the realistic fixture: identity colours in Chromium. The sidebar (a person's pick on the name and
// bar, an agent's own colour on its ring, one instance with the colour shown nowhere, the rest automatic, presets and a
// custom hex), the Color dialog from the chat's ⋯, and Settings → Appearance (the colour card, Turn off colours, Restore
// defaults). Over the full matrix: desktop 1366 / phone 390, light / dark, English / zh-TW. No fleet start; scratch home.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> MATRIX=full npx --prefix <checkout> tsx scripts/manual/smoke/smoke-1958.mts
import { join, dirname } from "node:path";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { bootFixture, matrix, caseName, shotPath, seedAvatars, seedIdentityColors } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-1958";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48400) });
const enc = encodeURIComponent;

// The instances the checks read, at their real long names (fixture data, not the short demo names of the first port).
const PERSON_PICK = "研一官網-t1544335726169165914";             // a person's pick on the name and bar (pink)
const AGENT_RING = "rd1-platform-backend-sr4-server-t1547091841202130997"; // the agent's own colour on its ring (teal preset)
const QUIET = "資料清洗與報表自動化助理";                          // colour shown nowhere
const CHAT = "agend-dev-claude-t1519896892392083558";             // the chat the checks open
const AUTO = "awp-ota-frontend-release-candidate-t1505801094666915890"; // automatic colour

// Avatars on the first 30 rows (the rings need a photo to sit on), then the colours the checks read.
const avatars = await seedAvatars(fx, 30);
const { IdentityColorStore } = await import(process.env.REPO + "/src/web-identity-color.ts");
const require = createRequire(process.env.REPO + "/");
const Database = require("better-sqlite3");
const db = new Database(join(fx.dir, "profiles.db"));
const store = new IdentityColorStore(() => db);
store.set(PERSON_PICK, { color: "pink", show: ["name", "bar"] });
store.set(QUIET, { show: [] });
const t = fx.fm.themeStore.get(AGENT_RING).theme ?? { v: 1 };
const ring = fx.fm.themeStore.setTheme(AGENT_RING, { ...t, v: 1, identity: { color: "preset:teal", show: ["ring"] } }, "agent")?.ok;
const palette = seedIdentityColors(fx, fx.instances.slice(20, 26).map(i => i.name));
const seeded = { avatars: Object.keys(avatars).length, ring, palette };

const results: Record<string, any> = { seeded, browser: fx.browser.version(), cases: {} };
for (const c of matrix()) {
  const { ctx, page, csp } = await fx.page(c, { path: `/ui/chat/${enc(CHAT)}` });
  const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 160)));
  await page.waitForTimeout(1000);
  if (c.device === "phone") { const m = page.locator("#sbOpen").first(); if (await m.isVisible()) { await m.click(); await page.waitForTimeout(600); } }
  const r: any = {};
  r.rows = await page.evaluate(`[...document.querySelectorAll("#instanceList a.inst")].map((a) => ({ name: a.querySelector(".inst-name")?.textContent, cls: a.className, light: a.style.getPropertyValue("--id-light"), dark: a.style.getPropertyValue("--id-dark"), bar: getComputedStyle(a).boxShadow, ring: getComputedStyle(a.querySelector(".av")).boxShadow, nameColor: getComputedStyle(a.querySelector(".inst-name")).color }))`);
  await page.screenshot({ path: shotPath(SMOKE, c, "sidebar") });
  // The Color dialog from the chat's ⋯. The phone drawer covers the header, so the chat is reloaded with it closed.
  await page.goto(`${fx.base}/ui/chat/${enc(CHAT)}`); await page.waitForTimeout(1000);
  await page.click(".p-chat .panel-head .menu-btn, .p-chat button[aria-haspopup='menu']").catch(() => {});
  await page.waitForTimeout(300);
  const item = page.locator(".menu-list [role='menuitem'], .menu-list button").filter({ hasText: /^(Colour…|顏色…)$/ }).first();
  if (await item.count()) { await item.click(); await page.waitForTimeout(800); }
  r.dialog = await page.evaluate(`!!document.querySelector("dialog[open] .idc-swatches")`);
  await page.screenshot({ path: shotPath(SMOKE, c, "dialog") });
  await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  // Settings → Look (#2347; was Appearance): the colour card and its two actions.
  await page.goto(`${fx.base}/settings/look`); await page.waitForTimeout(1500);
  r.tab = await page.evaluate(`[...document.querySelectorAll(".s-nav a, nav a")].map((a) => a.textContent.trim()).find((t) => /^(Look|外觀)$/.test(t)) || null`);
  r.colorCard = await page.evaluate(`!!document.querySelector(".s-colors") && !!document.querySelector(".s-restore")`);
  await page.evaluate(`document.querySelector(".s-colors")?.scrollIntoView()`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: shotPath(SMOKE, c, "settings") });
  r.csp = await csp(); r.errs = errs;
  results.cases[caseName(c)] = r;
  await ctx.close();
}
writeFileSync(join(dirname(shotPath(SMOKE, "result", "x")), "results.json"), JSON.stringify(results, null, 1));
console.log(JSON.stringify(Object.fromEntries(Object.entries(results.cases).map(([k, v]: [string, any]) => [k, { dialog: v.dialog, tab: v.tab, colorCard: v.colorCard, csp: v.csp.length, errs: v.errs.length }]))));
await fx.close(); process.exit(0);
