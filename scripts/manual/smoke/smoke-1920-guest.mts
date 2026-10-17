// #1920 phase 3 (P3a) a guest's web app on the realistic fixture: a guest session scoped to three agents, on a desktop
// (light, dark) and a phone (the drawer open, then the chat). Checks what a guest's page shows (its agents only, the
// "Guest · <name> (<platform>)" chip, no admin navigation, no bottom tabs, the composer's guest note) and that it asks
// for nothing it would be refused (no 403 at all) and logs no error; saves a screenshot of each.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-1920-guest.mts
import { bootFixture, shotPath, VIEWPORTS } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-1920-guest";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48370), webYaml: "  guests:\n    enabled: true" });
const fm = fx.fm;
const { tokenEpoch } = await import(process.env.REPO + "/src/web-session.ts");
// Its scope: three demo agents (pinned here — the fixture has no chat connections to derive it from).
const scope = ["observability-dashboards", "billing-reconciliation", "資料清洗與報表自動化助理"];
if (!scope.every(n => fx.instances.some(i => i.name === n))) throw new Error("the fixture no longer has the demo agents this smoke scopes");
fm.guestScope = () => new Set(scope);
const owner = { adapterId: "discord", userId: "424242424242424242" };
fm.webPrefs.setProfileName(`person:${owner.adapterId}:${owner.userId}`, "Alice");
fm.initializeWebSessions();

const results: any[] = [];
for (const c of [{ device: "desk", theme: "light" }, { device: "desk", theme: "dark" }, { device: "phone", theme: "dark" }] as const) {
  const sid = fm.webSessions.create({ tier: "guest", surface: "local", label: "smoke", tokenEpoch: tokenEpoch(fm.webToken), owner }).sessionId;
  fm.webPrefs.write("operator", new Map<string, unknown>([["theme", c.theme], ["lang", "en"]]));
  const ctx = await fx.browser.newContext({ viewport: VIEWPORTS[c.device], deviceScaleFactor: 1, colorScheme: c.theme, isMobile: c.device === "phone", hasTouch: c.device === "phone" });
  await ctx.addCookies([{ name: "agend_session", value: sid, url: fx.base }]);
  await ctx.addInitScript({ content: `try { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); } catch {}` });
  const page = await ctx.newPage();
  const refused: string[] = [], errors: string[] = [];
  page.on("response", (r: any) => { if (r.status() === 403 || r.status() === 401) refused.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
  page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
  await page.goto(`${fx.base}/ui/chat/${encodeURIComponent(scope[0]!)}`);
  await page.waitForSelector("#msgIn"); await page.waitForTimeout(1200);
  const check = await page.evaluate(`(() => ({
    tier: document.body.dataset.tier, chip: document.querySelector(".guest-chip")?.textContent.trim() ?? null,
    agents: [...document.querySelectorAll("#sidebar a.inst")].map(e => decodeURIComponent(e.getAttribute("href").split("/").pop())),
    adminNav: !!document.querySelector("#sidebar .side-nav"), settings: [...document.querySelectorAll("#sidebar .side-foot a")].map(a => a.textContent.trim()),
    filters: !!document.querySelector("#sidebar .v-filter"), tabs: !!document.querySelector("nav.tabs"),
    instSwitch: !!document.querySelector("nav.inst-switch"), menu: !!document.querySelector(".panel-head [aria-haspopup=menu]"),
    usage: !!document.querySelector(".hd-usage"), note: document.querySelector(".guest-note")?.textContent ?? null,
    noteShown: (() => { const n = document.querySelector(".guest-note"); return !!n && getComputedStyle(n).display !== "none" && n.getBoundingClientRect().height > 0; })(),
    chipClipped: (() => { const s = document.querySelector(".guest-chip .grow"); return !!s && s.scrollWidth > s.clientWidth; })(),
  }))()`);
  const name = `${c.device}-${c.theme}`;
  if (c.device === "phone") {
    await page.screenshot({ path: shotPath(SMOKE, name, "chat") });
    await page.click(".panel-head .sb-toggle, .panel-head [aria-controls=sidebar]").catch(() => {});
    await page.waitForTimeout(400);
    await page.screenshot({ path: shotPath(SMOKE, name, "drawer") });
  } else await page.screenshot({ path: shotPath(SMOKE, name, "page") });
  results.push({ case: name, ...check, refused, errors });
  await ctx.close();
}
// Control: an admin's page of the same chat (the header, the sidebar and the tabs a guest does not get).
{
  const { ctx, page } = await fx.page({ device: "desk", theme: "light", lang: "en" }, { path: `/ui/chat/${encodeURIComponent(scope[0]!)}` });
  await page.waitForSelector("#msgIn"); await page.waitForTimeout(800);
  await page.screenshot({ path: shotPath(SMOKE, "desk-light", "admin-control") });
  await ctx.close();
}
console.log(JSON.stringify({ scope, results }, null, 1));
const bad = results.filter(r => r.tier !== "guest" || !r.chip?.startsWith("Guest · Alice") || r.adminNav || r.settings.length || r.filters || r.tabs
  || r.instSwitch || r.menu || r.usage || !r.note || !r.noteShown || r.chipClipped || r.refused.length || r.errors.length || [...r.agents].sort().join() !== [...scope].sort().join());
console.log(bad.length ? `FAIL ${bad.map(b => b.case).join(", ")}` : "PASS");
await fx.close();
process.exit(bad.length ? 1 : 0);
