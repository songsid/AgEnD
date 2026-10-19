// #2196 from defaults (fleet decision a78ebdc5): an agent's theme colours the whole page while it is open. A fresh
// profile with nothing seeded signs in through the visible /signin; agents are opened through the visible sidebar (a
// phone: the drawer). Demo names and the mockup's two themes (Harbor, Amber), checked by web-theme.ts as set_web_theme
// checks them, stored as the agent's.
// Per case, read as painted (getComputedStyle):
//   - ota-builder (Harbor, page on): the sidebar, the header and the usage rail (a phone: the header and the tabs) take
//     its colours; text reads 4.5:1 on its sidebar; the Needs you count keeps AgEnD's colour;
//   - switching to release-notes-drafter (Amber): sampled every frame from before the click — every frame shows the
//     look of the URL it is on (never the old agent's, never a flash of the page's own), and nothing moves (the sidebar's
//     width, the main column's box);
//   - docs-site-builder (a chat theme, no page): the sidebar and the header in the page's own look while its chat is in
//     its colours (the header follows the page); Settings: the page's own look;
//   - ⋯ → Page colours → Only its chat (a person's choice wins): ota-builder's page in the page's own look; back to
//     the agent's choice: its colours again (desk);
//   - #2199: body[data-agent] is the agent open (every sampled frame of the switch too; none on Settings; kept with
//     agents' themes off — it is for a person's own custom CSS);
//   - no page error (WebKit's own lines only; the opening navigation's stream/poll/session cancels by position).
// Viewer cases: Settings → Web appearance → "Show agents' themes…" off (clicked); ?safe=1 — the page's own look.
// Cases: desk light (English), phone dark (zh-TW, reduced motion, a LAN origin in Chromium), the public link (desk
// light, reduced motion), themes off (desk dark), safe mode (desk light).
//   PW_DIR=… REPO=… OUT=… [PW_ENGINE=webkit] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2196-page-themes.mts
import { bootFixture, freshPage, mounted, openPublicLink, shotPath, type FreshPage } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2196-page-themes";
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const WEBKIT_OWN = new Set(["Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
  'Viewport argument key "interactive-widget" not recognized and ignored.']);
const CANCEL = /^(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/(ui\/(events|poll|traffic)|auth\/session)(\?\S*)? due to access control checks\.$/;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48630), classic: false });
const fm = fx.fm;
const dir = fm.dataDir ?? fx.dir;

const H = "ota-builder", A = "release-notes-drafter", P = "docs-site-builder", B = "grok-scout";
fm.fleetConfig.instances = Object.fromEntries(["general", H, A, P, B].map((name, i) => [name, { working_directory: dir, backend: ["claude-code", "codex", "kiro-cli"][i % 3], ...(name === "general" ? { general_topic: true } : {}) }]));
fm.fleetConfig.teams = { "awp-ota": { members: [H] } };
fm.getInstanceStatus = () => "running";
const HARBOR = {
  v: 1, colors: { light: { bg: "#f3f9f8", surface: "#ffffff", text: "#0c1f1d", text2: "#3a5a56", accent: "#0f766e" },
    dark: { bg: "#0f1f1e", surface: "#16302d", text: "#e2f3f0", text2: "#9cc7c1", accent: "#2dd4bf" } },
  page: { on: true, sidebar: { light: "#e2f0ed", dark: "#0a1716" } },
};
const AMBER = {
  v: 1, colors: { light: { bg: "#fdf8f0", surface: "#fffdf8", text: "#24180a", text2: "#6a5233", accent: "#b45309" },
    dark: { bg: "#1d150b", surface: "#2b1f10", text: "#f6ead8", text2: "#d2b78f", accent: "#f59e0b" } },
  page: { on: true, sidebar: { light: "#f5e8d4", dark: "#140e06" } },
};
const PLAIN = { v: 1, colors: { light: { bg: "#f4f1fb", text: "#1d1430", text2: "#4b3f63", accent: "#6d28d9" }, dark: { bg: "#17121f", text: "#ece6f7", text2: "#b7a9cf", accent: "#a78bfa" } } };
const { checkTheme } = await import(process.env.REPO + "/src/web-theme.ts");
for (const [name, theme] of [[H, HARBOR], [A, AMBER], [P, PLAIN]] as const) {
  const r = checkTheme(theme, { assets: new Set() });
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.errors)}`);
  if (!fm.themeStore.setTheme(name, r.theme, "agent")?.ok) throw new Error(`${name}: not stored`);
}
const hex = (h: string) => `rgb(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)})`;
const HOST = { light: { sidebar: "#f9f9f9", bg: "#ffffff", dangerFill: "#c4222b" }, dark: { sidebar: "#171717", bg: "#212121", dangerFill: "#c9372c" } };

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
/** Open an agent's chat through the visible sidebar (a phone: the drawer). */
async function openAgent(p: FreshPage, name: string) {
  await openDrawer(p);
  await p.page.locator("#instanceList a.inst").filter({ has: p.page.locator(".inst-name", { hasText: new RegExp(`^${name}$`) }) }).first().click();
  await p.page.waitForURL(new RegExp(`/ui/chat/${name}$`), { timeout: 10000 });
  await p.page.waitForTimeout(300);
}
/** What is painted: the sidebar, the header, the rail, a phone's tabs, the chat's background, the Needs you count. */
const READ = `(() => {
  const bg = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).backgroundColor : null; };
  const fg = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).color : null; };
  const tabs = document.querySelector("nav.tabs");
  return { sidebar: bg("#sidebar"), header: bg(".p-chat > .panel-head"), headerText: fg(".p-chat > .panel-head"), rail: bg(".u-rail"), tabs: tabs && getComputedStyle(tabs).display !== "none" ? getComputedStyle(tabs).backgroundColor : null,
    chat: bg(".p-chat"), sideText: fg("#sidebar .side-row"), count: bg(".nav-count") || bg(".tab-badge"), themed: document.querySelector(".shell").classList.contains("th-page"),
    agent: document.body.dataset.agent ?? null,
    sideW: Math.round(document.querySelector("#sidebar").getBoundingClientRect().width), main: JSON.stringify(["x", "y", "width", "height"].map((k) => Math.round(document.querySelector("#main").getBoundingClientRect()[k]))),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
})()`;
const read = async (p: FreshPage) => p.page.evaluate(READ) as Promise<any>;
function lum(rgb: string) { const m = /rgb\((\d+), (\d+), (\d+)/.exec(rgb); if (!m) return 0; return [m[1], m[2], m[3]].map((x) => +x / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)).reduce((a, x, i) => a + x * [0.2126, 0.7152, 0.0722][i]!, 0); }
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

const results: Array<{ name: string; ok: boolean }> = [];
function record(name: string, c: Record<string, boolean>, extra: unknown) {
  const failed = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  results.push({ name, ok: !failed.length });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${ENGINE}-${name}${failed.length ? ` [${failed.join(", ")}] ${JSON.stringify(extra).slice(0, 1500)}` : ""}`);
}
/**
 * Page errors but WebKit's own lines: its stylesheet note, and the stream/poll/session requests a full navigation cancels
 * (`navEnd`: before it; Infinity: a case that navigates itself — page.goto — has them at each of its own loads).
 */
const ownErrors = (p: FreshPage, navEnd: number) => p.errors.filter((e, i) => { const t = e.replace(/ @ \S+$/, ""); return !(ENGINE === "webkit" && (WEBKIT_OWN.has(t) || (i < navEnd && CANCEL.test(t)))); });

async function main(name: string, open: () => Promise<FreshPage>, mode: "light" | "dark", writes: boolean) {
  const p = await open();
  await mounted(p.page, 30000);
  await p.page.waitForTimeout(800);
  const phone = p.page.viewportSize().width < 760;
  const c: Record<string, boolean> = {};
  const T = { H: { side: HARBOR.page.sidebar[mode], bg: HARBOR.colors[mode].bg }, A: { side: AMBER.page.sidebar[mode], bg: AMBER.colors[mode].bg } };
  await openAgent(p, H);
  if (!phone) {   // the usage rail is closed until a person opens it (remembered per device): open it, as a person would
    await p.page.locator(".p-chat .panel-head .hd-usage").first().click();
    await p.page.waitForSelector(".u-rail", { timeout: 5000 }).catch(() => null);
    await p.page.waitForTimeout(200);
  }
  const h = await read(p);
  c.harborSidebar = h.sidebar === hex(T.H.side) && h.themed;
  c.dataAgent = h.agent === H;
  c.harborHeader = h.header === hex(T.H.bg);
  if (!phone) c.harborRail = h.rail === hex(T.H.bg);
  if (phone) c.harborTabs = h.tabs === hex(T.H.side);
  c.textReadsOnSidebar = ratio(h.sideText, h.sidebar) >= 4.5;
  c.needsCountAgEnDs = !h.count || h.count === hex(HOST[mode].dangerFill);
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}`, "1-harbor") });
  // The switch, sampled every frame from before the click.
  await p.page.evaluate(`(() => { window.__frames = []; const f = () => { const s = document.querySelector("#sidebar"); window.__frames.push([location.pathname, getComputedStyle(s).backgroundColor, document.body.dataset.agent ?? null]); if (window.__frames.length < 90) requestAnimationFrame(f); }; requestAnimationFrame(f); })()`);
  await openAgent(p, A);
  await p.page.waitForTimeout(600);
  const frames = await p.page.evaluate("window.__frames") as Array<[string, string, string | null]>;
  const want = (path: string) => (path.endsWith(`/${A}`) ? hex(T.A.side) : path.endsWith(`/${H}`) ? hex(T.H.side) : null);
  const agentOf = (path: string) => (path.endsWith(`/${A}`) ? A : path.endsWith(`/${H}`) ? H : null);
  // #2199: body[data-agent] follows in the same frames as the colours.
  const wrong = frames.filter(([path, col, ag]) => want(path) !== null && (col !== want(path) || ag !== agentOf(path)));
  c.switchEveryFrameRight = frames.some(([path]) => path.endsWith(`/${A}`)) && wrong.length === 0;
  const a = await read(p);
  c.amberSidebar = a.sidebar === hex(T.A.side) && a.header === hex(T.A.bg);
  c.nothingMoved = a.sideW === h.sideW && a.main === h.main;
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}`, "2-amber") });
  // A chat theme without page colours: the page (and the header) in the page's own look; the chat in its colours.
  await openAgent(p, P);
  const pl = await read(p);
  c.plainPageOwn = pl.sidebar === hex(HOST[mode].sidebar) && !pl.themed && pl.header === hex(HOST[mode].bg) && pl.chat === hex(PLAIN.colors[mode].bg);
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}`, "3-plain-chat-only") });
  if (writes && !phone) {
    // ⋯ → Page colours → Only its chat, on ota-builder: the person's choice wins; then the agent's choice again.
    await openAgent(p, H);
    await p.page.locator(".p-chat .panel-head .menu > button").first().click();
    await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}`, "4-menu") });
    await p.page.locator('.menu-list [role="menuitemradio"]').filter({ hasText: mode === "light" && name.includes("zh") ? "只在它的聊天" : /Only its chat|只在它的聊天/ }).click();
    await p.page.waitForTimeout(400);
    const only = await read(p);
    c.personChatOnly = only.sidebar === hex(HOST[mode].sidebar) && !only.themed;
    await p.page.locator(".p-chat .panel-head .menu > button").first().click();
    await p.page.locator('.menu-list [role="menuitemradio"]').filter({ hasText: /The agent's choice|依 agent 的設定/ }).click();
    await p.page.waitForTimeout(400);
    c.backToAgents = (await read(p)).sidebar === hex(T.H.side);
  }
  // Settings: the page's own look.
  await p.page.goto(`${p.base}/settings`);
  await mounted(p.page, 30000);
  await p.page.waitForTimeout(400);
  const st = await read(p);
  c.settingsOwn = st.sidebar === hex(HOST[mode].sidebar) && st.agent === null;
  c.noOverflow = !(await read(p)).overflow;
  const errs = ownErrors(p, Infinity);   // the case ends with its own navigation (Settings)
  c.noErrors = errs.length === 0;
  record(name, c, { h, a, pl, wrong: wrong.slice(0, 4), errs });
  await p.ctx.close();
}

const ONLY = process.env.ONLY?.split(",");
const only = (n: string) => !ONLY || ONLY.includes(n);
if (only("desk")) await main("desk-light-en", () => freshPage(fx, { device: "desk", theme: "light", lang: "en" }), "light", true);
if (only("phone")) await main(ENGINE === "webkit" ? "phone-dark-zh-TW-reduced" : "phone-dark-zh-TW-lan-reduced",
  () => freshPage(fx, { device: "phone", theme: "dark", lang: "zh-TW" }, ENGINE === "webkit" ? { reducedMotion: true } : { origin: "lan", reducedMotion: true }), "dark", true);
if (only("public")) {
  const link = await openPublicLink(fx);
  await main("public-link-desk-light-en-reduced", () => link.publicPage({ device: "desk", theme: "light", lang: "en" }, { reducedMotion: true }), "light", false);
  await link.close();
}

// The viewer's switch, turned off through Settings → Web appearance (visible), then ota-builder: the page's own look.
if (only("off")) {
  const p = await freshPage(fx, { device: "desk", theme: "dark", lang: "en" });
  await mounted(p.page, 30000);
  await p.page.goto(`${p.base}/settings/appearance`);
  await mounted(p.page, 30000);
  const box = p.page.getByRole("checkbox", { name: /Show agents' themes/ }).first();
  await box.waitFor({ timeout: 10000 });
  if (await box.isChecked()) await box.click();
  await p.page.waitForTimeout(500);
  await openAgent(p, H);
  const o = await read(p);
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-themes-off-desk-dark-en`, "1-harbor") });
  record("themes-off-desk-dark-en", { pageOwn: o.sidebar === hex(HOST.dark.sidebar) && !o.themed, dataAgentStill: o.agent === H, chatOwn: o.header === hex(HOST.dark.bg), noErrors: ownErrors(p, Infinity).length === 0 }, { o, errs: ownErrors(p, Infinity) });
  await p.ctx.close();
  // The switch is the host's (every signed-in screen): back to its default for the next fresh profile.
  const { OPERATOR } = await import(process.env.REPO + "/src/web-prefs.ts");
  for (const who of [p.personKey, OPERATOR]) fm.webPrefs.write(who, new Map([["fx.show", null]]));
}
// ?safe=1.
if (only("safe")) {
  const p = await freshPage(fx, { device: "desk", theme: "light", lang: "en" }, { path: `/ui/chat/${H}?safe=1` });
  await mounted(p.page, 30000);
  await p.page.waitForTimeout(800);
  const s = await read(p);
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-safe-desk-light-en`, "1-harbor") });
  record("safe-desk-light-en", { pageOwn: s.sidebar === hex(HOST.light.sidebar) && !s.themed }, { s });
  await p.ctx.close();
}

const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `FAIL ${bad.map((b) => b.name).join(", ")}` : `PASS (${ENGINE})`);
await fx.close();
process.exit(bad.length ? 1 : 0);
