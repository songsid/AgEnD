/**
 * S-255 captures. Owned rigs only, headless Chromium, synthetic people; no Fleet, CLI, model or real Hub.
 * - Fleet: the smoke fixture's real dashboard on loopback. /sw.js really registers; Chromium's installability check
 *   (CDP Page.getInstallabilityErrors, persistent profile) is recorded. Headless Chromium never shows its own install
 *   UI, so the offer is the page's real beforeinstallprompt listener fed one synthetic event.
 * - Hub: the real Hub (tests/helpers/hub-s3b-rig.ts) over HTTPS with an owned self-signed certificate, opened as a person
 *   who clicked through the browser's warning. What the page decides there is recorded as observed; if Chromium still
 *   lets the worker register under its ignore-certificate mode, the untrusted case is shown by rejecting the
 *   registration the way Chrome does for a certificate error (SecurityError), and result.json says so.
 */
import assert from "node:assert/strict";
import { createServer as createHttps } from "node:https";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootFixture, matrix, caseName } from "../smoke-fixture/index.mts";

const REPO = process.env.REPO!, PW = process.env.PW_DIR!, CHROME = process.env.CHROME!;
const out = process.env.OUT ?? join(process.cwd(), ".artifacts", "s255"); mkdirSync(out, { recursive: true });
const pw = createRequire(join(resolve(PW), "package.json"))("playwright-core");
const launch = pw.chromium.launch.bind(pw.chromium);
pw.chromium.launch = (o: object) => launch({ ...o, headless: true });
const result: Record<string, unknown> = {};
const OFFER = `window.__fakeOffer = () => { const e = new Event("beforeinstallprompt", { cancelable: true }); e.prompt = async () => {}; e.userChoice = Promise.resolve({ outcome: "dismissed" }); window.dispatchEvent(e); };`;

// ---- Fleet dashboard
const fx = await bootFixture({ port: Number(process.env.PORT ?? 24961), host: true, classic: false, roster: [
  { name: "general", backend: "claude-code", general: true, displayName: "General" }, { name: "worker", backend: "codex", displayName: "Build helper" }] });
try {
  for (const c of matrix("desk-light-en,phone-dark-zh-TW")) {
    const { page, ctx } = await fx.page(c, { host: true, path: "/ui/needs", storage: {} });
    const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    try {
      await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistrations()).length > 0, null, { timeout: 15000 });
      const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(r => r.scope));
      await page.evaluate(OFFER + "window.__fakeOffer();");
      const row = page.locator(".n-install"); await row.waitFor(); await row.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(out, `fleet-${caseName(c)}.png`) });
      const text = await row.innerText();
      assert.match(text, c.lang === "en" ? /Install as an app/ : /安裝成應用程式/);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false); assert.deepEqual(errors, []);
      result[`fleet-${caseName(c)}`] = { serviceWorker: scope, installRow: text.replace(/\s+/g, " ").trim(), overflow };
    } finally { await ctx.close(); }
  }
  // Installability as Chromium judges it (a persistent profile: Chromium never offers Install in an incognito context).
  const profile = mkdtempSync(join(tmpdir(), "s255-profile-"));
  try {
    const { tokenEpoch } = await import(REPO + "/src/web-session.ts");
    const ctx = await pw.chromium.launchPersistentContext(profile, { executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
    const page = ctx.pages()[0] ?? await ctx.newPage();
    await page.goto(`${fx.base}/signin`); await page.waitForSelector("#code");
    fx.fm.initializeWebSessions();
    const code = fx.fm.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(fx.fm.webToken), host: true }).display;
    await page.locator("#code").evaluate((i: HTMLInputElement, v: string) => { i.value = v; i.dispatchEvent(new Event("input", { bubbles: true })); i.form!.requestSubmit(); }, code);
    await page.waitForURL(`${fx.base}/ui`); await page.waitForTimeout(3000);
    const cdp = await ctx.newCDPSession(page);
    result["fleet-installability"] = { installabilityErrors: (await cdp.send("Page.getInstallabilityErrors")).installabilityErrors,
      manifest: (await cdp.send("Page.getAppManifest")).url?.replace(fx.base, "<fixture>") };
    // Sign-out still works with the worker installed: the session ends and /ui sends the browser to sign in.
    const signedOut = await page.evaluate(async () => { const s = await (await fetch("/auth/session")).json(); const r = await fetch("/auth/logout", { method: "POST", headers: { "Content-Type": "application/json", "x-agend-csrf": s.csrf ?? "" }, body: "{}" }); return r.status; });
    const after = await page.evaluate(async () => (await fetch("/auth/sessions")).status);
    assert.equal(signedOut, 200); assert.equal(after, 401);
    result["fleet-signout-with-worker"] = { logout: signedOut, sessionsAfter: after };
    await ctx.close();
  } finally { rmSync(profile, { recursive: true, force: true }); }
} finally { clearInterval(fx.fm.replyObligationTimer); await fx.close(); }

// ---- Hub over HTTPS with an owned self-signed certificate
const { s3bRig } = await import(join(REPO, "tests/helpers/hub-s3b-rig.ts"));
const { createOwnedPki } = await import(join(REPO, "scripts/manual/hub-connector-4c/rig.mts"));
const scratch = mkdtempSync(join(tmpdir(), "s255-hub-")), pki = createOwnedPki(join(scratch, "pki"));
let r: any;
const server = createHttps({ key: readFileSync(pki.key), cert: readFileSync(pki.cert) }, (req, res) => { if (!r?.http.handle(req, res)) { res.writeHead(404); res.end(); } });
const browser = await launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
try {
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  r = await s3bRig({ webOrigin: origin, realAudit: true });
  for (const [device, lang, theme] of [["desk", "en", "light"], ["phone", "zh-TW", "dark"]] as const) {
    const phone = device === "phone", tag = `hub-${device}-${theme}-${lang}`;
    for (const simulate of [false, true]) {
      if (simulate && result[`${tag}-observed`] === "untrusted") break;     // Chromium itself refused the worker: nothing to simulate
      const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 900 }, isMobile: phone, hasTouch: phone,
        deviceScaleFactor: 2, locale: lang === "en" ? "en-US" : "zh-TW", colorScheme: theme, ignoreHTTPSErrors: true });
      await ctx.addInitScript({ content: `localStorage.setItem('agend_lang',${JSON.stringify(lang)});localStorage.setItem('agend_theme',${JSON.stringify(theme)});localStorage.setItem('agend_tour_done','1');`
        + (simulate ? `if (navigator.serviceWorker) navigator.serviceWorker.register = () => Promise.reject(Object.assign(new Error("An SSL certificate error occurred when fetching the script."), { name: "SecurityError" }));` : "") });
      const page = await ctx.newPage(); page.setDefaultTimeout(20000);
      const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
      try {
        await page.goto(origin + "/ui/hub?view=notices");
        await page.fill("#hubLogin", "admin"); await page.fill("#hubPassword", "pw-admin"); await page.locator(".hub-signin button[type=submit]").click();
        await page.locator(".hub-head-tools").first().waitFor(); await page.waitForTimeout(2500);
        const state = await page.evaluate(async () => (await import("/assets/app-install.js")).installStore.get().state);
        const regs = await page.evaluate(async () => navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : -1);
        if (!simulate) { result[`${tag}-observed`] = state; result[`${tag}-observed-registrations`] = regs; if (state !== "untrusted") continue; }
        assert.equal(state, "untrusted");
        await page.screenshot({ path: join(out, `${tag}-button.png`) });
        await page.locator(".hub-install").first().click();
        const dialog = page.locator("dialog[open]"); await dialog.waitFor();
        const words = await dialog.innerText();
        assert.match(words, lang === "en" ? /doesn't trust this address's certificate/ : /不信任這個網址的憑證/);
        await page.screenshot({ path: join(out, `${tag}-why.png`) });
        assert.deepEqual(errors, []);
        result[`${tag}-shown`] = { simulated: simulate, dialog: words.replace(/\s+/g, " ").trim() };
      } finally { await ctx.close(); }
    }
  }
} finally { await browser.close(); server.close(); await r?.close?.(); rmSync(scratch, { recursive: true, force: true }); }
writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 1));
