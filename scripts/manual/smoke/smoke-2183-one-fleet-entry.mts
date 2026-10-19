// #2183 from defaults (fleet decision a78ebdc5): one Fleet entry. A fresh profile with nothing seeded signs in through the
// visible /signin (a phone opens the drawer with ☰). Per case:
//   - the sidebar's rows are Fleet ("Fleet 概覽" in zh-TW), Needs you and New agent — no Fleet (Details) or View row — and
//     Fleet is on screen, at the top;
//   - a phone's tabs are Chat · Needs you · Fleet · Settings, all on screen; Chat is current on an agent's chat and View
//     and goes to its chat; the agent's View, Log and Details are the switch under its header;
//   - Fleet opens the Org chart the first time; after a visit to Cache it opens Cache — from the sidebar (desk) or the tab
//     (phone), also after a reload;
//   - the temporary public link: the same (its own origin, so its own remembered tab);
//   - no page error (WebKit's own lines only; the opening navigation's stream/poll/session cancels by position).
// And the anonymous /view reader, unchanged: under web.view_access: open (the default) its sidebar is View, its tabs View
// and Sign in, no Fleet; refused (401) under web.view_access: session.
// Cases: desk light (English), phone dark (zh-TW, reduced motion, a LAN origin in Chromium), the public link (desk light,
// reduced motion), signed-out /view (phone light, English). PW_DIR=… REPO=… OUT=… [PW_ENGINE=webkit] npx --prefix <checkout>
// tsx scripts/manual/smoke/smoke-2183-one-fleet-entry.mts
import { bootFixture, freshPage, mounted, openPublicLink, shotPath, VIEWPORTS, type FreshPage } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2183-one-fleet-entry";
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const WEBKIT_OWN = new Set(["Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
  'Viewport argument key "interactive-widget" not recognized and ignored.']);
const CANCEL = /^(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/(ui\/(events|poll)|auth\/session)(\?\S*)? due to access control checks\.$/;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48610), classic: false });
const fm = fx.fm;
const AGENT = Object.keys(fm.fleetConfig.instances)[0];

async function openDrawer(p: FreshPage) {
  if (p.page.viewportSize().width < 760 && !(await p.page.locator(".shell.sb-open").count())) {
    const all = p.page.locator('button[aria-controls="sidebar"]'), end = Date.now() + 10000;
    let clicked = false;
    while (!clicked && Date.now() < end) {
      for (let i = 0; i < await all.count() && !clicked; i++) if (await all.nth(i).isVisible()) { await all.nth(i).click(); clicked = true; }
      if (!clicked) await p.page.waitForTimeout(150);
    }
    await p.page.waitForSelector(".shell.sb-open", { timeout: 5000 });
  }
}
/** What a person sees: the sidebar's rows (text, href, on screen) and the phone's tabs (text, href, current, on screen). */
const READ = `(() => {
  const on = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; };
  const rows = [...document.querySelectorAll("#sidebar .side-nav .side-row")].map((a) => [a.textContent.trim(), a.getAttribute("href"), on(a)]);
  const tabs = [...document.querySelectorAll("nav.tabs a.tab")].filter((a) => getComputedStyle(a.parentElement).display !== "none")
    .map((a) => [a.textContent.trim(), a.getAttribute("href"), a.getAttribute("aria-current") === "page", on(a)]);
  const sw = [...document.querySelectorAll(".inst-switch a.seg-item")].map((a) => a.getAttribute("href"));
  const fleetTab = document.querySelector(".p-fleet .seg-item.active");
  return { rows, tabs, sw, path: location.pathname, fleetTab: fleetTab ? fleetTab.getAttribute("href") : null };
})()`;
const results: any[] = [];
function done(name: string, chk: Record<string, boolean>, info: unknown, errors: string[]) {
  chk.noErrors = errors.length === 0;
  const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
  results.push({ name, ok: !failed.length, failed });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${ENGINE}-${name}${failed.length ? ` [${failed.join(", ")}] ${JSON.stringify({ info, errors }).slice(0, 1200)}` : ""}`);
}
const ownErrors = (p: FreshPage, navEnd: number) => p.errors.filter((e, i) => { const t = e.replace(/ @ \S+$/, ""); return !(ENGINE === "webkit" && (WEBKIT_OWN.has(t) || (i < navEnd && CANCEL.test(t)))); });

async function runCase(name: string, open: () => Promise<FreshPage>, lang: "en" | "zh-TW") {
  const p = await open();
  const phone = p.page.viewportSize().width < 760;
  const L = lang === "en" ? { fleet: "Fleet", needs: "Needs you", newAgent: "New agent", tabs: ["Chat", "Needs you", "Fleet", "Settings"] } : { fleet: "Fleet 概覽", needs: "等你處理", newAgent: "新增 Agent", tabs: ["聊天", "待處理", "Fleet", "設定"] };
  await p.page.goto(`${p.base}/ui/chat/${encodeURIComponent(AGENT)}`);
  await mounted(p.page, 30000);
  await p.page.waitForTimeout(800);
  const navEnd = p.errors.length;
  const read = async () => p.page.evaluate(READ) as Promise<any>;
  const chk: Record<string, boolean> = {};
  const a = await read();
  if (phone) {
    chk.fourTabs = JSON.stringify(a.tabs.map((t: any) => t[0])) === JSON.stringify(L.tabs) && a.tabs.every((t: any) => t[3]);
    chk.chatCurrentOnChat = a.tabs[0][2] && a.tabs[0][1] === `/ui/chat/${AGENT}`;
    await openDrawer(p);
  }
  const b = await read();
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}`, "1-sidebar") });
  // The two links, then the owner's New agent button (no href).
  chk.twoRows = JSON.stringify(b.rows.map((r: any) => r.slice(0, 2))) === JSON.stringify([[L.fleet, "/ui/fleet/org"], [L.needs, "/ui/needs"], [L.newAgent, null]]) && b.rows[0][2];
  chk.noDetailsOrViewRow = !b.rows.some((r: any) => /^\/view|^\/ui\/fleet\/agent\//.test(r[1] ?? ""));
  // Fleet → the Org chart (the first time), then Cache.
  await p.page.locator("#sidebar a.side-overview").click();
  await p.page.waitForURL(/\/ui\/fleet\/org$/, { timeout: 10000 }).catch(() => null);
  await p.page.waitForSelector(".p-fleet .seg-item.active", { timeout: 10000 }).catch(() => null);
  const c = await read();
  chk.firstTimeOrg = c.path === "/ui/fleet/org" && c.fleetTab === "/ui/fleet/org";
  await p.page.locator('.p-fleet a.seg-item[href="/ui/fleet/cache"]').click();
  await p.page.waitForURL(/\/ui\/fleet\/cache$/, { timeout: 10000 }).catch(() => null);
  await p.page.waitForTimeout(400);
  // Back to the agent: its View (the header's switch), where a phone's Chat tab stays current.
  await p.page.goto(`${p.base}/view/${encodeURIComponent(AGENT)}`);
  await mounted(p.page, 30000);
  await p.page.waitForSelector(".inst-switch a.seg-item", { timeout: 15000 }).catch(() => null);
  const d = await read();
  chk.switchUnderHeader = ["/ui/chat/", "/view/", "/ui/log/", "/ui/fleet/agent/"].every((pre) => d.sw.includes(pre + AGENT));
  if (phone) chk.chatCurrentOnView = d.tabs[0][2] && d.tabs[0][1] === `/ui/chat/${AGENT}` && !d.tabs[2][2];
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}`, "2-agent-view") });
  // After a reload, Fleet opens Cache: the tab (phone) or the sidebar (desk).
  await p.page.reload();
  await mounted(p.page, 30000);
  await p.page.waitForTimeout(500);
  const e = await read();
  chk.rememberedHref = (phone ? e.tabs[2][1] : e.rows[0][1]) === "/ui/fleet/cache";
  if (phone) await p.page.locator('nav.tabs a.tab[href="/ui/fleet/cache"]').click();
  else await p.page.locator("#sidebar a.side-overview").click();
  await p.page.waitForURL(/\/ui\/fleet\/cache$/, { timeout: 10000 }).catch(() => null);
  await p.page.waitForSelector(".p-fleet .seg-item.active", { timeout: 10000 }).catch(() => null);
  const f = await read();
  chk.reopensCache = f.path === "/ui/fleet/cache" && f.fleetTab === "/ui/fleet/cache" && (!phone || f.tabs[2][2]);
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}`, "3-fleet-cache") });
  done(name, chk, { a: a.tabs, b: b.rows, c, d, e: phone ? e.tabs : e.rows, f: f.path }, ownErrors(p, navEnd));
  await p.ctx.close();
}

await runCase("desk-light-en", () => freshPage(fx, { device: "desk", theme: "light", lang: "en" }), "en");
await runCase(ENGINE === "webkit" ? "phone-dark-zh-TW-reduced" : "phone-dark-zh-TW-lan-reduced",
  () => freshPage(fx, { device: "phone", theme: "dark", lang: "zh-TW" }, ENGINE === "webkit" ? { reducedMotion: true } : { origin: "lan", reducedMotion: true }), "zh-TW");
const link = await openPublicLink(fx);
await runCase("public-link-desk-light-en-reduced", () => link.publicPage({ device: "desk", theme: "light", lang: "en" }, { reducedMotion: true }), "en");
await link.close();

// The anonymous /view reader: unchanged under web.view_access: open (the default); blocked under session.
{
  const ctx = await fx.browser.newContext({ viewport: VIEWPORTS.phone, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "light" });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(String(e.message)));
  // A signed-out reader's own /auth/session 401 (it asks whether it is signed in) is kept apart, as the fixture does.
  page.on("console", (m: any) => { if (m.type() === "error") errors.push(/ 401 /.test(m.text()) && new URL(m.location().url || "http://x/").pathname === "/auth/session" ? "expected-401" : m.text()); });
  const chk: Record<string, boolean> = {};
  const before = fm.fleetConfig.web.view_access;
  chk.openByDefault = before === undefined || before === "open";
  await page.goto(`${fx.base}/view/${encodeURIComponent(AGENT)}`);
  await mounted(page, 30000);
  await page.waitForTimeout(800);
  const v = await page.evaluate(READ) as any;
  await page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-signed-out-view-phone-light-en`, "1-tabs") });
  chk.viewTabs = JSON.stringify(v.tabs.map((t: any) => t[0])) === JSON.stringify(["View", "Sign in"]) && v.tabs[0][1] === `/view/${AGENT}` && /^\/signin\?/.test(v.tabs[1][1]) && v.tabs.every((t: any) => t[3]);
  await openDrawer({ page } as FreshPage);
  await page.waitForTimeout(400);
  const w = await page.evaluate(READ) as any;
  await page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-signed-out-view-phone-light-en`, "2-drawer") });
  chk.viewSidebar = JSON.stringify(w.rows.map((r: any) => r.slice(0, 2))) === JSON.stringify([["View", "/view"]]) && w.rows[0][2] && !(await page.locator("#sidebar a.side-overview").count());
  const atSession = errors.length;
  fm.fleetConfig.web.view_access = "session";
  const refused = await page.goto(`${fx.base}/view/${encodeURIComponent(AGENT)}`);
  await page.waitForTimeout(800);
  chk.blockedUnderSession = refused.status() === 401 || new URL(page.url()).pathname === "/signin";   // the page's own refusal
  if (before === undefined) delete fm.fleetConfig.web.view_access; else fm.fleetConfig.web.view_access = before;
  const own = errors.slice(0, atSession).filter((e) => e !== "expected-401" && !(ENGINE === "webkit" && WEBKIT_OWN.has(e.replace(/ @ \S+$/, ""))));
  done("signed-out-view-phone-light-en", chk, { v: v.tabs, w: w.rows, url: page.url(), errors }, own);
  await ctx.close();
}

const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `FAIL ${bad.map((x) => x.name).join(", ")}` : `PASS (${ENGINE})`);
await fx.close();
process.exit(bad.length ? 1 : 0);
