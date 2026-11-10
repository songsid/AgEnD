// AGEND-154 captures. usage: LD_LIBRARY_PATH=… node capture.mjs <outdir> <matrix|flow|skew|measure>
// before = 7198c63dd's build (:19864), after = the head under review (:19863): two real throwaway AgEnDs (isolated HOME, fake CLIs: agy 1.5.3, grok 1.0.70, opencode 1.18.34, claude 2.1.319).
// The Settings → Runtime pages are SYNTHETIC data (the page's two reads are answered by this script: one paired Windows computer); the page code is the build's own.
import { chromium } from "/home/junsionloh/multica_workspaces/agend-bcac6942356a/agend-154-bc52963c7a3a/workdir/AgEnD/node_modules/playwright-core/index.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const out = process.argv[2], mode = process.argv[3] || "matrix";
mkdirSync(out, { recursive: true });
const VARIANTS = { before: { port: 19864, home: "/tmp/ag154/before", src: "/tmp/ag154/before-src" }, after: { port: 19863, home: "/tmp/ag154/after", src: "/home/junsionloh/multica_workspaces/agend-bcac6942356a/agend-154-bc52963c7a3a/workdir/AgEnD" } };
const MACHINE = "12345678-1234-4321-abcd-123456789012";
const cli = (id, version) => ({ id, path: `C:\\Users\\dev\\${id}.exe`, runnable: true, authenticated: true, version, readOnlySupport: true, supports: { execution: true, resume: true, mcp: true }, models: [] });
const machine = { id: MACHINE, name: "Dev laptop (Windows)", status: "online", platform: "win32", lastSeenAt: Date.now(), inventoryUpdatedAt: Date.now(),
  runtimeInfo: { version: "2.3.5-alpha", buildId: "a".repeat(64), protocolVersions: [1], capabilities: ["exec", "mcp", "panes", "credential-profiles", "remote-signin", "cli-install", "cli-update"] },
  inventory: { home: "C:\\Users\\dev", clis: [cli("claude-code", "2.1.319 (Claude Code)"), cli("codex", "codex-cli 0.167.0"), cli("antigravity", "1.3.5"), cli("opencode", "1.18.34")] } };
const catalog = [{ id: "claude-code", version: "2.1.319", kind: "npm", pin: "audited" }, { id: "codex", version: "0.167.0", kind: "npm", pin: "audited" }, { id: "antigravity", version: "1.5.3", kind: "download", pin: "audited" }, { id: "opencode", version: "1.19.5", kind: "npm", pin: "audited" }];
const setup = { capable: true, online: true, switches: { accounts: { on: false }, install: { on: true } }, job: null, catalog };
const SHAPES = { desk: { width: 1180, height: 900 }, phone: { width: 390, height: 844 } };
const sha = b => createHash("sha256").update(b).digest("hex");
const sign = async (base, home) => {
  const token = readFileSync(`${home}/d/web.token`, "utf8").trim();
  return (await (await fetch(`${base}/auth/issue-code`, { method: "POST", headers: { "X-Agend-Token": token, "X-Agend-Code-Delivery": "tty" } })).json()).code;
};
async function session(browser, variant, { shape, theme, lang }) {
  const { port, home } = VARIANTS[variant], base = `http://127.0.0.1:${port}`;
  const ctx = await browser.newContext({ viewport: SHAPES[shape], locale: lang === "zh-TW" ? "zh-TW" : "en-US", colorScheme: theme });
  await ctx.addInitScript(([t, l]) => { try { localStorage.setItem("agend_theme", t); localStorage.setItem("agend_lang", l); localStorage.setItem("agend_tour_done", "1"); } catch {} }, [theme, lang]);
  const page = await ctx.newPage(); page._theme = theme;
  page.on("pageerror", e => console.log("PAGEERROR", variant, e.message));
  await page.goto(`${base}/signin#code=${await sign(base, home)}`); await page.waitForTimeout(3000);
  return { ctx, page, base };
}
// The page's theme is the HOST's saved preference (theme.js: data-prefs wins over this browser's storage), so the capture chooses it the way a person does: through the page's own AgendTheme.
const setLang = async (page, lang) => { await page.evaluate(async (l) => { const m = await import("/assets/app-i18n.js"); m.setLang(l); }, lang); await page.waitForTimeout(1800);
  await page.evaluate(t => window.AgendTheme && window.AgendTheme.set(t), page._theme); await page.waitForTimeout(700); };
/** What theme the page really has: the attribute and the painted background (so a "dark" capture that is really light is caught here, not by eye). */
const themeOf = page => page.evaluate(() => ({ attr: document.documentElement.getAttribute("data-theme"), bg: getComputedStyle(document.body).backgroundColor }));
async function host(page, base, lang) {
  await page.goto(`${base}/settings/agents`); await page.waitForTimeout(2200); await setLang(page, lang);
  await page.locator("details.s-ai-accounts > summary").click(); await page.waitForTimeout(2800);
}
async function runtime(page, base, lang, stubPost) {
  await page.route("**/ui/runtimes", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: true, machines: [machine] }) }));
  await page.route(`**/ui/runtimes/machines/${MACHINE}/remote-setup`, route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(setup) }));
  if (stubPost) await page.route(`**/ui/runtimes/machines/${MACHINE}/cli-install`, stubPost);
  await page.goto(`${base}/settings/runtimes`); await page.waitForTimeout(3000); await setLang(page, lang); await page.waitForTimeout(1000);
}
const text = async (loc) => (await loc.innerText()).replace(/\s+/g, " ").trim();
const receipts = { generatedAt: new Date().toISOString(), variants: {}, shots: [], notes: [] };
async function servedHashes(page, base) {
  const files = ["/ui/js/host-install.js", "/ui/js/runtime-cli-install.js", "/ui/js/accounts-view.js", "/ui/js/panel-runtimes.js", "/ui/js/cli-caps.js", "/assets/app.css", "/assets/runtime-install.css", "/assets/host-install.css"];
  return page.evaluate(async (fs) => { const o = {}; for (const f of fs) { const r = await fetch(f, { cache: "no-store", credentials: "same-origin" }); const b = new Uint8Array(await r.arrayBuffer()); const d = await crypto.subtle.digest("SHA-256", b); o[f] = r.status + " " + [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, "0")).join(""); } return o; }, files);
}
async function receiptFor(browser, variant) {
  const { ctx, page, base } = await session(browser, variant, { shape: "desk", theme: "light", lang: "en" });
  const { src } = VARIANTS[variant];
  receipts.variants[variant] = { port: VARIANTS[variant].port, head: execFileSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: execFileSync("git", ["-C", src, "status", "--porcelain", "--", "src"], { encoding: "utf8" }).trim() || false, served: await servedHashes(page, base) };
  await ctx.close();
}
async function shot(loc, name, page, meta) {
  await loc.scrollIntoViewIfNeeded(); await loc.screenshot({ path: `${out}/${name}.png` });
  const painted = await themeOf(page); if (page._theme === "dark" && painted.bg === "rgb(255, 255, 255)") throw new Error(`${name}: asked for dark, painted ${painted.bg}`);
  const png = readFileSync(`${out}/${name}.png`); receipts.shots.push({ name, sha256: sha(png), painted: await themeOf(page), ...meta });
}
const browser = await chromium.launch();
if (mode === "matrix") {
  const ONLY = (process.env.ONLY || "before,after").split(","); for (const variant of ONLY) await receiptFor(browser, variant);
  for (const variant of ONLY) for (const shape of ["desk", "phone"]) for (const theme of ["light", "dark"]) for (const lang of ["en", "zh-TW"]) {
    const { ctx, page, base } = await session(browser, variant, { shape, theme, lang });
    const name = suffix => `${variant}-${suffix}-${shape}-${theme}-${lang}`, meta = { variant, shape, theme, lang };
    await host(page, base, lang);
    await shot(page.locator('.s-account-card[data-backend="antigravity"]'), name("host-antigravity"), page, { ...meta, page: "host", text: (await text(page.locator('.s-account-card[data-backend="antigravity"]'))).slice(0, 300) });
    await runtime(page, base, lang);
    await shot(page.locator(".runtime-cli-install").first(), name("runtime"), page, { ...meta, page: "runtime" });
    await ctx.close();
  }
} else if (mode === "flow") {
  await receiptFor(browser, "after");
  for (const lang of ["en", "zh-TW"]) for (const theme of ["light", "dark"]) {
    writeFileSync("/tmp/ag154/after/home/.agy-version", "1.5.3\n");
    const { ctx, page, base } = await session(browser, "after", { shape: "desk", theme, lang });
    const posts = []; page.on("request", r => { if (r.method() === "POST" && /host-(install|update)/.test(r.url())) posts.push(`${r.url().replace(base, "")} ${r.postData()}`); });
    await host(page, base, lang);
    const card = page.locator('.s-account-card[data-backend="antigravity"]');
    const meta = { variant: "after", shape: "desk", theme, lang, page: "host-flow" };
    await shot(card, `after-flow-1-idle-${theme}-${lang}`, page, meta);
    await card.locator("button.s-account-update").click(); await page.waitForTimeout(2500);
    await shot(card, `after-flow-2-running-${theme}-${lang}`, page, { ...meta, text: (await text(card)).slice(0, 400) });
    await page.waitForTimeout(11000);
    await shot(card, `after-flow-3-done-${theme}-${lang}`, page, { ...meta, text: (await text(card)).slice(0, 400) });
    receipts.notes.push({ flow: `${theme}/${lang}`, posts });
    await ctx.close();
    const r = await session(browser, "after", { shape: "desk", theme, lang });
    await runtime(r.page, r.base, lang);
    await r.page.locator('.runtime-cli-install-list [data-cli="antigravity"] button').click(); await r.page.waitForTimeout(800);
    await r.page.screenshot({ path: `${out}/after-flow-4-runtime-confirm-${theme}-${lang}.png` });
    receipts.shots.push({ name: `after-flow-4-runtime-confirm-${theme}-${lang}`, sha256: sha(readFileSync(`${out}/after-flow-4-runtime-confirm-${theme}-${lang}.png`)), painted: await themeOf(r.page), variant: "after", page: "runtime-confirm", text: (await text(r.page.locator("[role=dialog], .ui-confirm, dialog").first())).slice(0, 600) });
    await r.ctx.close();
  }
} else if (mode === "skew") {
  // The final head's server and DTO with the PAGE MODULES of 7198c63dd served in place of the current ones (the retained-module combinations of the review).
  const oldHost = readFileSync("/tmp/ag154/before-src/src/ui/host-install.js"), oldRuntime = readFileSync("/tmp/ag154/before-src/src/ui/runtime-cli-install.js");
  receipts.notes.push({ servedInPlaceOf: { "host-install.js": sha(oldHost), "runtime-cli-install.js": sha(oldRuntime) } });
  for (const lang of ["en", "zh-TW"]) {
    writeFileSync("/tmp/ag154/after/home/.agy-version", "1.5.3\n");
    // host
    let { ctx, page, base } = await session(browser, "after", { shape: "desk", theme: "light", lang });
    const seen = [], posts = [];
    await page.route("**/ui/js/host-install.js", route => route.fulfill({ status: 200, contentType: "text/javascript", body: oldHost }));
    page.on("response", async r => { if (/host-(install|update)/.test(r.url()) && r.request().method() === "POST") { seen.push(`${r.status()} ${r.url().replace(base, "")} ${(await r.text().catch(() => "")).slice(0, 200)}`); } });
    page.on("request", r => { if (r.method() === "POST" && /host-(install|update)/.test(r.url())) posts.push(`${r.url().replace(base, "")} ${r.postData()}`); });
    await host(page, base, lang);
    const card = page.locator('.s-account-card[data-backend="antigravity"]');
    const meta = { variant: "after+retained-host-install.js(7198c63dd)", shape: "desk", theme: "light", lang, page: "skew-host" };
    await shot(card, `skew-host-1-retained-label-${lang}`, page, { ...meta, text: (await text(card)).slice(0, 400) });
    const served = await page.evaluate(async () => { const b = new Uint8Array(await (await fetch("/ui/js/host-install.js", { cache: "no-store" })).arrayBuffer()); const d = await crypto.subtle.digest("SHA-256", b); return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, "0")).join(""); });
    await card.locator("button.s-account-update").click(); await page.waitForTimeout(3000);
    await page.screenshot({ path: `${out}/skew-host-2-after-click-${lang}.png` });
    receipts.shots.push({ name: `skew-host-2-after-click-${lang}`, sha256: sha(readFileSync(`${out}/skew-host-2-after-click-${lang}.png`)), painted: await themeOf(page), ...meta, page: "skew-host-click", text: (await text(page.locator("body"))).slice(0, 0) });
    const agyVersion = readFileSync("/tmp/ag154/after/home/.agy-version", "utf8").trim();
    const run = await page.evaluate(async () => (await (await fetch("/ui/host-install", { cache: "no-store" })).json()));
    receipts.notes.push({ skewHost: lang, servedHostInstallSha256: served, posts, responses: seen, agyVersionAfter: agyVersion, hostInstallRun: run.install });
    await ctx.close();
    // runtime (the page's own request; the Runtime route's answer is simulated — the machine is synthetic — with the same predicate runtime-api.ts applies)
    const rposts = [];
    ({ ctx, page, base } = await session(browser, "after", { shape: "desk", theme: "light", lang }));
    await page.route("**/ui/js/runtime-cli-install.js", route => route.fulfill({ status: 200, contentType: "text/javascript", body: oldRuntime }));
    await runtime(page, base, lang, async route => { const b = JSON.parse(route.request().postData() || "{}"); rposts.push(b); await route.fulfill({ status: b.acceptLatestUnaudited === true ? 202 : 409, contentType: "application/json", body: JSON.stringify(b.acceptLatestUnaudited === true ? { job: { cli: b.cli, state: "installing", startedAt: 1 } } : { error: "This page is out of date for this action. Refresh the page and try again.", code: "latest_ack_required" }) }); });
    const row = page.locator('.runtime-cli-install-list [data-cli="antigravity"]');
    await shot(page.locator(".runtime-cli-install").first(), `skew-runtime-1-retained-label-${lang}`, page, { variant: "after+retained-runtime-cli-install.js(7198c63dd)", shape: "desk", theme: "light", lang, page: "skew-runtime", text: (await text(row)).slice(0, 300) });
    await row.locator("button").click(); await page.waitForTimeout(900);
    await page.screenshot({ path: `${out}/skew-runtime-2-dialog-${lang}.png` });
    receipts.shots.push({ name: `skew-runtime-2-dialog-${lang}`, sha256: sha(readFileSync(`${out}/skew-runtime-2-dialog-${lang}.png`)), painted: await themeOf(page), page: "skew-runtime-dialog", text: (await text(page.locator("[role=dialog], .ui-confirm, dialog").first())).slice(0, 600) });
    const confirmBtn = page.locator("[role=dialog] button, dialog button").last(); await confirmBtn.click(); await page.waitForTimeout(1800);
    await shot(page.locator(".runtime-cli-install").first(), `skew-runtime-3-after-click-${lang}`, page, { variant: "after+retained-runtime-cli-install.js(7198c63dd)", shape: "desk", theme: "light", lang, page: "skew-runtime-click", text: (await text(page.locator(".runtime-cli-install").first())).slice(0, 500) });
    receipts.notes.push({ skewRuntime: lang, posts: rposts });
    await ctx.close();
  }
} else if (mode === "measure") {
  // 44px at the phone breakpoint, in a real Chromium. Control = runtime-install.css as it was before this change (d51a038b0); current = this head's; retained app.css = 7198c63dd's app.css served in place of the current one.
  const prevCss = execFileSync("git", ["-C", VARIANTS.after.src, "show", "d51a038b0:src/ui/shared/runtime-install.css"]);
  const oldApp = readFileSync("/tmp/ag154/before-src/src/ui/shared/app.css");
  receipts.notes.push({ cssServed: { "runtime-install.css@d51a038b0": sha(prevCss), "app.css@7198c63dd": sha(oldApp) } });
  const rows = [];
  for (const [label, opts] of [["pre-fix CSS (runtime-install.css @ d51a038b0)", { runtimeCss: prevCss }], ["current CSS (this head)", {}], ["retained CSS (this head's runtime-install.css, app.css of 7198c63dd)", { appCss: oldApp }]]) for (const width of [390, 500, 600]) {
    const { ctx, page, base } = await session(browser, "after", { shape: "phone", theme: "light", lang: "en" });
    await page.setViewportSize({ width, height: 844 });
    if (opts.runtimeCss) await page.route("**/assets/runtime-install.css", route => route.fulfill({ status: 200, contentType: "text/css", body: opts.runtimeCss }));
    if (opts.appCss) await page.route("**/assets/app.css", route => route.fulfill({ status: 200, contentType: "text/css", body: opts.appCss }));
    await runtime(page, base, "en");
    const m = {}; for (const id of ["antigravity", "opencode", "codex"]) { const b = await page.locator(`.runtime-cli-install-list [data-cli="${id}"] button`).first(); m[id] = (await b.count()) ? await b.evaluate(el => { const r = el.getBoundingClientRect(); return { text: el.textContent.trim(), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; }) : null; }
    rows.push({ label, viewport: width, buttons: m });
    if (width === 390) { await page.locator(".runtime-cli-install").first().scrollIntoViewIfNeeded(); await page.locator(".runtime-cli-install").first().screenshot({ path: `${out}/measure-runtime-${label.startsWith("pre") ? "prefix" : label.startsWith("current") ? "current" : "retained"}-phone.png` }); }
    await ctx.close();
  }
  // the host row's Update on a phone, for completeness
  for (const [label, opts] of [["current CSS (this head)", {}], ["retained CSS (app.css of 7198c63dd)", { appCss: oldApp }]]) {
    const { ctx, page, base } = await session(browser, "after", { shape: "phone", theme: "light", lang: "en" });
    if (opts.appCss) await page.route("**/assets/app.css", route => route.fulfill({ status: 200, contentType: "text/css", body: opts.appCss }));
    await host(page, base, "en");
    const b = page.locator("button.s-account-update").first();
    rows.push({ label: `host Update button, ${label}`, viewport: 390, buttons: { antigravity: await b.evaluate(el => { const r = el.getBoundingClientRect(); return { text: el.textContent.trim(), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; }) } });
    await ctx.close();
  }
  receipts.measurements = rows;
  for (const r of rows) console.log(JSON.stringify(r));
}
await browser.close();
writeFileSync(`${out}/receipt-${mode}${process.env.ONLY ? "-" + process.env.ONLY : ""}.json`, JSON.stringify(receipts, null, 2));
console.log("done", mode, receipts.shots.length, "shots");
