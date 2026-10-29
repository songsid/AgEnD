// #2855 part 1: a guest's own sidebar — star, sort and filter on a guest's page, saved under its account and there again
// after a reload. On the realistic fixture: a guest scoped to three agents; a desktop in light (en) and dark (zh-TW).
// Checks the controls are there, a star / a sort / a filter are written to the guest's own bucket (never the host's),
// a reload shows them, and the page logs no error; saves a screenshot of each step.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2855-guest-prefs.mts
import { bootFixture, shotPath, VIEWPORTS } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2855-guest-prefs";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48395), webYaml: "  guests:\n    enabled: true" });
const fm = fx.fm;
const { tokenEpoch } = await import(process.env.REPO + "/src/web-session.ts");
const scope = ["observability-dashboards", "billing-reconciliation", "資料清洗與報表自動化助理"];
if (!scope.every(n => fx.instances.some(i => i.name === n))) throw new Error("the fixture no longer has the demo agents this smoke scopes");
fm.guestScope = () => new Set(scope);
const owner = { adapterId: "discord", userId: "424242424242424242" }, person = `person:${owner.adapterId}:${owner.userId}`;
fm.webPrefs.setProfileName(person, "Alice");
fm.initializeWebSessions();
const hostBefore = JSON.stringify(fm.webPrefs.read("operator").values);

const results: any[] = [];
for (const c of [{ theme: "light", lang: "en" }, { theme: "dark", lang: "zh-TW" }] as const) {
  fm.webPrefs.forgetGuest(person);
  fm.webPrefs.writeForGuest(person, new Map<string, unknown>([["theme", c.theme], ["lang", c.lang]]));
  const sid = fm.webSessions.create({ tier: "guest", surface: "local", label: "smoke", tokenEpoch: tokenEpoch(fm.webToken), owner }).sessionId;
  const ctx = await fx.browser.newContext({ viewport: VIEWPORTS.desk, deviceScaleFactor: 1, colorScheme: c.theme });
  await ctx.addCookies([{ name: "agend_session", value: sid, url: fx.base }]);
  await ctx.addInitScript({ content: `try { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); } catch {}` });
  const page = await ctx.newPage();
  const errors: string[] = [], refused: string[] = [];
  page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
  page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
  page.on("response", (r: any) => { if (r.status() >= 400) refused.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  const open = async () => { await page.goto(`${fx.base}/ui/chat/${encodeURIComponent(scope[0]!)}`); await page.waitForSelector("#msgIn"); await page.waitForTimeout(1000); };
  const sidebar = () => page.evaluate(`(() => ({ stars: document.querySelectorAll("#sidebar .inst-star").length, sort: document.querySelector("#sidebar .nav-sort-btn")?.textContent.trim() ?? null,
    filter: !!document.querySelector("#sidebar .v-filter input"), favs: [...document.querySelectorAll("#sidebar .v-fav .inst-name")].map(e => e.textContent.trim()),
    rows: [...document.querySelectorAll("#sidebar .inst-name")].map(e => e.textContent.trim()), dragged: !!document.querySelector("#sidebar [draggable=true]") }))()`);
  await open();
  const start = await sidebar();
  await page.screenshot({ path: shotPath(SMOKE, `desk-${c.theme}-${c.lang}`, "1-controls") });
  // A star on the second agent; the sort menu → Recent replies.
  // The star shows on a row's hover (as an admin's).
  await page.locator("#sidebar li:has(.inst-star)").nth(1).hover();
  await page.locator("#sidebar .inst-star").nth(1).click();
  await page.locator("#sidebar .nav-sort-btn").click();
  await page.locator(".nav-sort-menu input[name=nav-sort-mode][value=recent]").check();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  const stored = fm.webPrefs.readGuestOwn(person);
  await open();
  const reloaded = await sidebar();
  await page.screenshot({ path: shotPath(SMOKE, `desk-${c.theme}-${c.lang}`, "2-after-reload") });
  // A filter, kept too.
  await page.fill("#sidebar .v-filter input", "billing");
  await page.waitForTimeout(800);
  await open();
  const filtered = { ...(await sidebar()), q: await page.inputValue("#sidebar .v-filter input") };
  await page.screenshot({ path: shotPath(SMOKE, `desk-${c.theme}-${c.lang}`, "3-filter-kept") });
  results.push({ case: `${c.theme}-${c.lang}`, start, stored, reloaded, filtered, refused, errors });
  await ctx.close();
}
const hostAfter = JSON.stringify(fm.webPrefs.read("operator").values);
console.log(JSON.stringify({ results, hostUnchanged: hostBefore === hostAfter }, null, 1));
const bad = results.filter(r => r.start.stars !== 3 || !r.start.filter || r.start.sort === null || r.start.dragged
  || (r.stored["nav.favorites"] ?? []).length !== 1 || r.stored["nav.sort"]?.mode !== "recent"
  || r.reloaded.favs.length !== 1 || r.filtered.q !== "billing" || r.errors.length || r.refused.length);
const ok = !bad.length && hostBefore === hostAfter;
console.log(ok ? "PASS" : `FAIL ${bad.map(b => b.case).join(", ")}${hostBefore === hostAfter ? "" : " (the host's preferences changed)"}`);
await fx.close();
process.exit(ok ? 0 : 1);
