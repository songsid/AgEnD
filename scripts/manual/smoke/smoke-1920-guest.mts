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

// #2101 review: a static effect poster placed on an in-scope agent shows to a guest as to an admin (stock trust passes
// on a guest's page). A real poster image, drawn here; the effect is uploaded and placed as the product does.
const { encodeEffectFiles } = await import(process.env.REPO + "/src/web-effect-upload.ts");
const painter = await fx.browser.newPage();
const posterB64 = await painter.evaluate(`(() => { const c = document.createElement("canvas"); c.width = 320; c.height = 120; const g = c.getContext("2d");
  g.fillStyle = "#3b6fd8"; g.fillRect(0, 0, 320, 120); g.fillStyle = "#fff"; g.font = "bold 28px sans-serif"; g.fillText("POSTER", 100, 70);
  return c.toDataURL("image/png").split(",")[1]; })()`);
await painter.close();
const effect = new Map<string, Uint8Array>([
  ["effect.json", Buffer.from(JSON.stringify({ v: 1, runtime: "canvas-worker-v1", worker: "worker.js", name: "poster", title: "Poster", regions: ["chat"], layer: "front", wants: ["state"], poster: "poster.png" }))],
  ["worker.js", Buffer.from("agend.ready()")], ["poster.png", Buffer.from(posterB64, "base64")],
]);
const uploaded = fm.effectService.upload("operator", encodeEffectFiles(effect));
if (typeof uploaded.id !== "string") throw new Error(`poster upload refused: ${JSON.stringify(uploaded)}`);
const placed = fm.effectService.apply("operator", { instance: scope[0], id: uploaded.id });
if (!placed || typeof placed.id !== "string") throw new Error(`poster placement refused: ${JSON.stringify(placed)}`);
const POSTER_CHECK = `(async () => {
  const trust = await import("/assets/effect-stock-trust.js").then((m) => { const r = m.stockEffectTrust(window, { ownerCss: "off" }); return { ok: r.ok, reason: r.reason }; });
  for (let i = 0; i < 40 && !document.querySelector("img.agend-effect-poster"); i++) await new Promise((r) => setTimeout(r, 100));
  const img = document.querySelector("img.agend-effect-poster");
  const box = img ? img.getBoundingClientRect() : null;
  return { trust, poster: !!img && img.complete && img.naturalWidth > 0 && !!box && box.width > 0 && box.height > 0 && getComputedStyle(img).visibility !== "hidden" };
})()`;

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
  const effectProof = await page.evaluate(POSTER_CHECK);
  const name = `${c.device}-${c.theme}`;
  if (c.device === "phone") {
    await page.screenshot({ path: shotPath(SMOKE, name, "chat") });
    await page.click(".panel-head .sb-toggle, .panel-head [aria-controls=sidebar]").catch(() => {});
    await page.waitForTimeout(400);
    await page.screenshot({ path: shotPath(SMOKE, name, "drawer") });
  } else await page.screenshot({ path: shotPath(SMOKE, name, "page") });
  results.push({ case: name, ...check, ...effectProof, refused, errors });
  await ctx.close();
}
// Control: an admin's page of the same chat (the header, the sidebar and the tabs a guest does not get).
let adminProof: any = null;
{
  const { ctx, page } = await fx.page({ device: "desk", theme: "light", lang: "en" }, { path: `/ui/chat/${encodeURIComponent(scope[0]!)}` });
  await page.waitForSelector("#msgIn"); await page.waitForTimeout(800);
  adminProof = await page.evaluate(POSTER_CHECK);
  await page.screenshot({ path: shotPath(SMOKE, "desk-light", "admin-control") });
  await ctx.close();
}
console.log(JSON.stringify({ scope, adminProof, results }, null, 1));
const bad = results.filter(r => r.tier !== "guest" || !r.chip?.startsWith("Guest · Alice") || r.adminNav || r.settings.length || r.filters || r.tabs
  || r.instSwitch || r.menu || r.usage || !r.note || !r.noteShown || r.chipClipped || !r.trust?.ok || !r.poster || r.refused.length || r.errors.length || [...r.agents].sort().join() !== [...scope].sort().join());
const adminBad = !adminProof?.trust?.ok || !adminProof?.poster;
console.log(bad.length || adminBad ? `FAIL ${[...bad.map(b => b.case), ...(adminBad ? ["admin-control"] : [])].join(", ")}` : "PASS");
await fx.close();
process.exit(bad.length || adminBad ? 1 : 0);
