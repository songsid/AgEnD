// M-3164: the sidebar's sort popover (自訂) has a third section, Display / 顯示, with Detailed / Compact (詳細 / 精簡) radios in
// the same style, below Sort and Favorites. It is the same synced setting as Settings → Preferences (nav.density, M-3129):
// either place changes it at once and the other follows. A fresh profile signs in through the visible /signin (a phone opens
// the drawer with ☰). Per case:
//   - the popover has three sections, the last one Display with Detailed checked (the default);
//   - Compact in the popover: the list turns compact at once and the choice is saved (POST /ui/prefs 200);
//   - a reload keeps it compact, and Settings → Preferences says Compact;
//   - Detailed in Settings: the popover there shows Detailed checked and the list is detailed again;
//   - no page error.
// Cases: desk light (en), desk dark (zh-TW), phone light (zh-TW), phone dark (en). Demo names only.
// PW_DIR=… REPO=… OUT=… npx --prefix <checkout> tsx scripts/manual/smoke/smoke-3164-sort-display.mts
import { bootFixture, freshPage, mounted, shotPath, type FreshPage } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-3164-sort-display";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48640), classic: false });
const fm = fx.fm;
const AGENTS = ["observability-dashboards", "billing-reconciliation", "search-indexer", "docs-site-builder"];
for (const name of Object.keys(fm.fleetConfig.instances)) if (!AGENTS.includes(name)) delete fm.fleetConfig.instances[name];
for (const n of AGENTS) { const i = fm.fleetConfig.instances[n]; delete i.display_name; i.tags = ["demo"]; }
fm.fleetConfig.teams = {};
fm.saveFleetConfig();
const { OPERATOR } = await import(process.env.REPO + "/src/web-prefs.ts");

const phone = (p: FreshPage) => p.page.viewportSize().width < 760;
async function openDrawer(p: FreshPage) {
  if (!phone(p) || await p.page.locator(".shell.sb-open").count()) return;
  const all = p.page.locator('button[aria-controls="sidebar"]'), end = Date.now() + 10000;
  let clicked = false;
  while (!clicked && Date.now() < end) {
    for (let i = 0; i < await all.count() && !clicked; i++) if (await all.nth(i).isVisible()) { await all.nth(i).click(); clicked = true; }
    if (!clicked) await p.page.waitForTimeout(150);
  }
  await p.page.waitForSelector(".shell.sb-open", { timeout: 5000 });
}
async function openMenu(p: FreshPage) {
  await openDrawer(p);
  if (!(await p.page.locator(".nav-sort-menu").count())) await p.page.locator("#instanceList .nav-sort-btn").click();
  await p.page.waitForSelector(".nav-sort-menu", { timeout: 5000 });
  await p.page.waitForTimeout(200);
}
const READ = `(() => {
  const menu = document.querySelector(".nav-sort-menu"), sets = menu ? [...menu.querySelectorAll("fieldset")] : [], last = sets.at(-1);
  const checked = last ? last.querySelector('input[name="nav-sort-density"]:checked') : null;
  const r = menu ? menu.getBoundingClientRect() : null;
  return { legends: sets.map((f) => f.querySelector("legend").textContent), labels: last ? [...last.querySelectorAll("label")].map((l) => l.textContent) : [],
    checked: checked ? checked.value : null, compact: !!document.querySelector("#instanceList .inst-nav.compact, .inst-nav.compact"),
    menuOnScreen: !!r && r.top >= 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
})()`;
const results: any[] = [];
async function runCase(name: string, c: any) {
  const zh = c.lang === "zh-TW", L = zh ? { display: "顯示", labels: ["詳細", "精簡"] } : { display: "Display", labels: ["Detailed", "Compact"] };
  const p = await freshPage(fx, c);
  await mounted(p.page, 30000); await p.page.waitForTimeout(800);
  await openMenu(p);
  const a = await p.page.evaluate(READ) as any;
  await p.page.screenshot({ path: shotPath(SMOKE, name, "1-menu-detailed") });
  const chk: Record<string, boolean> = {
    threeSections: a.legends.length === 3 && a.legends[2] === L.display && JSON.stringify(a.labels) === JSON.stringify(L.labels),
    detailedByDefault: a.checked === "detailed" && !a.compact, menuOnScreen: a.menuOnScreen,
  };
  const saved = p.page.waitForResponse((r: any) => new URL(r.url()).pathname === "/ui/prefs" && r.request().method() === "POST", { timeout: 10000 }).then((r: any) => r.status()).catch(() => 0);
  await p.page.locator('.nav-sort-menu input[name="nav-sort-density"][value="compact"]').check();
  chk.saved = (await saved) === 200;
  await p.page.waitForTimeout(300);
  const b = await p.page.evaluate(READ) as any;
  chk.compactAtOnce = b.compact && b.checked === "compact";
  await p.page.screenshot({ path: shotPath(SMOKE, name, "2-menu-compact") });
  await p.page.locator("#instanceList .nav-sort-btn").click(); await p.page.waitForTimeout(250);   // the button closes it (Escape would close a phone's drawer too)
  chk.menuClosesListCompact = !(await p.page.locator(".nav-sort-menu").count()) && (await p.page.evaluate(READ) as any).compact;
  await p.page.screenshot({ path: shotPath(SMOKE, name, "2b-list-compact") });
  await p.page.reload(); await mounted(p.page, 30000); await p.page.waitForTimeout(600);
  await openDrawer(p);
  chk.keptAfterReload = (await p.page.evaluate(READ) as any).compact;
  // Settings → Preferences says the same, and a change there shows in the popover.
  await p.page.goto(new URL("/settings/preferences", p.page.url()).href); await mounted(p.page, 30000);
  await p.page.waitForSelector("#pref-density", { timeout: 15000 });
  chk.settingsSaysCompact = (await p.page.locator("#pref-density").inputValue()) === "compact";
  await p.page.locator("#pref-density").selectOption("detailed"); await p.page.waitForTimeout(400);
  // A choice in Settings is shown at once (held until the page's Save, M-3129); the popover reads the choice in force.
  await openMenu(p);
  const d = await p.page.evaluate(READ) as any;
  chk.settingsToPopover = d.checked === "detailed" && !d.compact;
  await p.page.screenshot({ path: shotPath(SMOKE, name, "3-settings-detailed-menu") });
  chk.noErrors = p.errors.length === 0;
  for (const who of [p.personKey, OPERATOR]) fm.webPrefs.write(who, new Map([["nav.density", null], ["nav.densityPhone", null]]));   // M-3252: a phone's own too
  const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
  results.push({ name, ok: !failed.length });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${name}${failed.length ? ` [${failed.join(", ")}] ${JSON.stringify({ a, b, d, errors: p.errors }).slice(0, 900)}` : ""}`);
  await p.ctx.close();
}
await runCase("desktop-light-en", { device: "desk", theme: "light", lang: "en" });
await runCase("desktop-dark-zh-TW", { device: "desk", theme: "dark", lang: "zh-TW" });
await runCase("phone-light-zh-TW", { device: "phone", theme: "light", lang: "zh-TW" });
await runCase("phone-dark-en", { device: "phone", theme: "dark", lang: "en" });
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `FAIL ${bad.map((x) => x.name).join(", ")}` : "PASS");
await fx.close();
process.exit(bad.length ? 1 : 0);
