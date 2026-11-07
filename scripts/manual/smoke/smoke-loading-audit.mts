// Isolated real-Chrome loading audit. Every pause is a held request on a listener bootFixture owns.
// REPO=<checkout> PW_DIR=<playwright-core dir> OUT=<screenshots dir> npx tsx scripts/manual/smoke/smoke-loading-audit.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture } from "../smoke-fixture/index.mts";

const OUT = process.env.OUT!, REPO = process.env.REPO!;
mkdirSync(OUT, { recursive: true });
const fx = await bootFixture({ port: Number(process.env.HP ?? 48960), instances: 4, classic: false });
const agent = fx.instances.find(i => !i.general)!.name;
const { publicAttachment } = await import(REPO + "/src/web-upload.ts");
const mdPath = join(fx.dir, "notes.md"); writeFileSync(mdPath, "# Release notes\n\nA short preview.\n");
const md = fx.fm.webFiles.registerServed({ path: mdPath, instance: agent, name: "notes.md", mime: "text/markdown", kind: "document" });
fx.fm.emitSseEvent("message", { instance: agent, sender: agent, role: "agent", text: "The notes.", ts: new Date().toISOString(), attachments: [publicAttachment(md)] });
const results: any = { browser: fx.browser.version(), network: { latency: 150, download: 250_000, upload: 100_000 }, cases: [] };
const cases = [
  { device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" },
  { device: "phone", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" },
] as const;
const langText = (c: any, en: string, zh: string) => c.lang === "en" ? en : zh;
async function throttle(page: any) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 250_000, uploadThroughput: 100_000 });
}
async function shot(page: any, tag: string, name: string) {
  await page.waitForSelector("body", { state: "attached", timeout: 30_000 });
  await page.waitForTimeout(700);
  const state = await page.evaluate(() => ({ text: document.body.innerText.slice(-3500), skeletons: document.querySelectorAll(".skeleton").length,
    busy: document.querySelectorAll('[aria-busy="true"]').length, overflow: document.documentElement.scrollWidth > innerWidth }));
  await page.screenshot({ path: join(OUT, `${tag}-${name}.png`) });
  results.cases.push({ tag, name, ...state });
  console.log(`${tag} ${name}: skeletons=${state.skeletons} busy=${state.busy}`);
}
async function hold(page: any, matches: (u: URL) => boolean) {
  let release!: () => void, seen!: () => void;
  const waiting = new Promise<void>(r => { release = r; });
  const requested = new Promise<void>(r => { seen = r; });
  const handler = async (route: any) => { if (matches(new URL(route.request().url()))) { seen(); await waiting; }
    try { await route.fallback(); } catch (e) { if (!/already handled|closed|cancel/i.test(String(e))) throw e; } };
  await page.route("**/*", handler);
  return { requested: () => Promise.race([requested, page.waitForTimeout(20_000).then(() => { throw new Error("held request never arrived"); })]),
    async release() { release(); await page.unroute("**/*", handler); } };
}
async function navigateHold(page: any, tag: string, name: string, path: string, matches: (u: URL) => boolean, during?: () => Promise<void>) {
  const h = await hold(page, matches);
  try {
    await page.goto(fx.base + path, { waitUntil: "commit" }); await h.requested(); if (during) await during(); await shot(page, tag, name);
  } finally { await h.release(); }
  await page.waitForTimeout(800);
}
try {
  for (const c of cases) {
    const tag = `${c.device}-${c.lang}`;
    const { ctx, page } = await fx.page(c, { path: `/ui/chat/${agent}` });
    await throttle(page);
    if (process.env.MODE === "readiness") {
      await navigateHold(page, tag, "needs", "/ui/needs", u => u.pathname === "/ui/events" || u.pathname === "/ui/poll", async () => { await page.waitForSelector(".p-needs", { timeout: 30_000 }); });
      await navigateHold(page, tag, "notices", "/ui/notices", u => u.pathname === "/ui/notices/list", async () => { await page.waitForSelector(".p-notices", { timeout: 30_000 }); });
      await ctx.close(); continue;
    }
    if (process.env.MODE === "extras") {
      const lazy = await hold(page, u => u.pathname === "/ui/js/search-dialog.js");
      try { await page.keyboard.press("Control+k"); await lazy.requested(); await shot(page, tag, "search-open"); } finally { await lazy.release(); }
      await page.waitForSelector(".search-input", { timeout: 20_000 });
      await page.route("**/ui/search?*", (route: any) => route.fulfill({ json: { hits: [{ key: "xmsg:fixture", source: "xmsg", instance: agent, peer: agent,
        sender: agent, role: "task", ts: Date.now(), ref: { messageId: "fixture" }, snippet: "Release notes", marks: [[0, 7]] }], limited: false, building: false } }));
      await page.locator(".search-input").fill("release"); await page.waitForSelector(".search-results [role=option]");
      const detail = await hold(page, u => u.pathname === "/ui/search/context");
      try { await page.locator(".search-results [role=option]").first().click(); await detail.requested(); await shot(page, tag, "search-context"); } finally { await detail.release(); }
      await page.keyboard.press("Escape");
      await page.goto(`${fx.base}/ui/chat/${agent}`); await page.waitForSelector(".text-card .tc-panel", { timeout: 25_000 });
      const preview = await hold(page, u => u.pathname === `/ui/file/${md.id}`);
      try { await page.locator(".text-card .tc-panel").click(); await preview.requested(); await shot(page, tag, "preview"); } finally { await preview.release(); }
      await navigateHold(page, tag, "needs", "/ui/needs", u => u.pathname === "/ui/events" || u.pathname === "/ui/poll", async () => { await page.waitForSelector(".p-needs", { timeout: 30_000 }); });
      await navigateHold(page, tag, "notices", "/ui/notices", u => u.pathname === "/ui/notices/list", async () => { await page.waitForSelector(".p-notices", { timeout: 30_000 }); });
      await navigateHold(page, tag, "profile", "/settings/preferences", u => u.pathname === "/ui/profile");
      await navigateHold(page, tag, "access", "/settings/access", u => u.pathname === "/api/settings/web-authority" || u.pathname === "/api/settings/guests");
      await ctx.close(); continue;
    }
    await navigateHold(page, tag, "boot", `/ui/chat/${agent}`, u => u.pathname === "/assets/app.js");
    await page.waitForSelector(".shell", { timeout: 30_000 });
    await navigateHold(page, tag, "agent-details", `/ui/fleet/agent/${agent}`, u => u.pathname === `/ui/instance/${agent}`);
    await page.goto(`${fx.base}/ui/chat/${agent}`); await page.waitForSelector("#msgIn", { timeout: 30_000 });
    // Search is a real dialog and real request; the existing index may be empty in this scratch fleet.
    await page.keyboard.press("Control+k"); await page.waitForSelector(".search-input", { timeout: 15_000 });
    const search = await hold(page, u => u.pathname === "/ui/search");
    try { await page.locator(".search-input").fill("release"); await search.requested(); await shot(page, tag, "search"); }
    finally { await search.release(); }
    await page.keyboard.press("Escape");
    // Alpha-only surfaces are requested by path; main's common audit omits them.
    if (process.env.ALPHA === "1") {
      await navigateHold(page, tag, "runtime", "/settings/runtimes", u => u.pathname === "/ui/runtimes");
      await navigateHold(page, tag, "accounts", "/settings/agents", u => u.pathname === "/ui/accounts", async () => { await page.locator(".s-ai-accounts > summary").click(); });
      await page.goto(`${fx.base}/ui/chat/${agent}`); await page.waitForSelector("#msgIn", { timeout: 30_000 });
      const workspace = await hold(page, u => u.pathname === "/ui/workspace" && u.searchParams.get("op") === "changes");
      try {
        await page.evaluate(() => { const b = [...document.querySelectorAll<HTMLButtonElement>(".p-chat .panel-head button")].find(x => /^(More actions|更多動作)$/.test(x.getAttribute("aria-label") || "")); b?.click(); });
        await page.getByRole("menuitem", { name: langText(c, "Files & changes", "檔案與變更"), exact: true }).click();
        await workspace.requested(); await shot(page, tag, "files-changes");
      } finally { await workspace.release(); }
    }
    await ctx.close();
    const signedOut = await fx.browser.newContext({ viewport: c.device === "desk" ? { width: 1366, height: 900 } : { width: 390, height: 844 }, colorScheme: c.theme, locale: c.lang });
    await signedOut.addInitScript((lang: string) => localStorage.setItem("agend_lang", lang), c.lang);
    const signin = await signedOut.newPage(); await throttle(signin);
    await navigateHold(signin, tag, "signin", "/signin", u => u.pathname === "/auth/session");
    await signedOut.close();
  }
} finally {
  mkdirSync(join(REPO, ".artifacts/loading-audit"), { recursive: true });
  writeFileSync(join(REPO, ".artifacts/loading-audit/fleet-results.json"), JSON.stringify(results, null, 2));
  await fx.close();
}
