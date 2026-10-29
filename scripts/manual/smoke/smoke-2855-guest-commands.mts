// #2855 part 2: a guest's commands and usage panel on the realistic fixture — a guest scoped to three agents (guests on,
// so the status lists the commands it may run). Desktop, light (en) and dark (zh-TW): its palette offers exactly the
// commands the table lets anyone run there; a command it may not run is refused with why (nothing sent); the usage
// button is on its header and opens the usage view; the page logs no error. A screenshot of each step.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2855-guest-commands.mts
import { bootFixture, shotPath, VIEWPORTS } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2855-guest-commands";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48399), webYaml: "  guests:\n    enabled: true" });
const fm = fx.fm;
const { tokenEpoch } = await import(process.env.REPO + "/src/web-session.ts");
const scope = ["observability-dashboards", "billing-reconciliation", "資料清洗與報表自動化助理"];
if (!scope.every(n => fx.instances.some(i => i.name === n))) throw new Error("the fixture no longer has the demo agents this smoke scopes");
fm.guestScope = () => new Set(scope);
const owner = { adapterId: "discord", userId: "424242424242424242" }, person = `person:${owner.adapterId}:${owner.userId}`;
fm.webPrefs.setProfileName(person, "Alice");
fm.initializeWebSessions();

const results: any[] = [];
for (const c of [{ theme: "light", lang: "en" }, { theme: "dark", lang: "zh-TW" }] as const) {
  fm.webPrefs.forgetGuest(person);
  fm.webPrefs.writeForGuest(person, new Map<string, unknown>([["theme", c.theme], ["lang", c.lang]]));
  const sid = fm.webSessions.create({ tier: "guest", surface: "local", label: "smoke", tokenEpoch: tokenEpoch(fm.webToken), owner }).sessionId;
  const ctx = await fx.browser.newContext({ viewport: VIEWPORTS.desk, deviceScaleFactor: 1, colorScheme: c.theme });
  await ctx.addCookies([{ name: "agend_session", value: sid, url: fx.base }]);
  await ctx.addInitScript({ content: `try { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); localStorage.setItem("agend_usage_rail", "0"); } catch {}` });
  const page = await ctx.newPage();
  const errors: string[] = [], commands: string[] = [];
  page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
  page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
  page.on("request", (r: any) => { if (new URL(r.url()).pathname === "/ui/command") commands.push(JSON.parse(r.postData() ?? "{}").command); });
  await page.goto(`${fx.base}/ui/chat/${encodeURIComponent(scope[0]!)}`);
  await page.waitForSelector("#msgIn"); await page.waitForTimeout(1200);
  await page.fill("#msgIn", "/");
  await page.waitForTimeout(300);
  const palette = await page.evaluate(`[...document.querySelectorAll(".cmd-palette [role=option], .cmd-palette li")].map(e => (e.textContent.match(/\\/(ctx|compact|clear|model|backend|effort|cancel|btw|steer|pause|wake|save)/) || [""])[0])`);
  await page.screenshot({ path: shotPath(SMOKE, `desk-${c.theme}-${c.lang}`, "1-palette") });
  await page.fill("#msgIn", "/clear");
  await page.keyboard.press("Enter"); await page.waitForTimeout(500);
  const toast = await page.evaluate(`[...document.querySelectorAll(".toast")].map(e => e.textContent.trim()).join(" | ")`);
  const kept = await page.inputValue("#msgIn");
  await page.screenshot({ path: shotPath(SMOKE, `desk-${c.theme}-${c.lang}`, "2-refused") });
  const usageButton = await page.locator(".hd-usage").count();
  if (usageButton) { await page.locator(".hd-usage").first().click(); await page.waitForTimeout(1500); }
  const usageShown = await page.evaluate(`!!document.querySelector(".u-rail, .usage-dialog, [data-trust=usage]")`);
  await page.screenshot({ path: shotPath(SMOKE, `desk-${c.theme}-${c.lang}`, "3-usage") });
  results.push({ case: `${c.theme}-${c.lang}`, palette, toast, kept, usageButton, usageShown, commands, errors });
  await ctx.close();
}
console.log(JSON.stringify(results, null, 1));
const want = { en: "/clear isn't available to guests", "zh-TW": "訪客不能使用 /clear" } as const;
const bad = results.filter(r => JSON.stringify(r.palette) !== JSON.stringify(["/ctx", "/cancel", "/btw", "/steer"])
  || !r.toast.includes(want[r.case.endsWith("en") ? "en" : "zh-TW"]) || r.kept !== "/clear" || r.commands.length
  || !r.usageButton || !r.usageShown || r.errors.length);
console.log(bad.length ? `FAIL ${bad.map(b => b.case).join(", ")}` : "PASS");
await fx.close();
process.exit(bad.length ? 1 : 0);
