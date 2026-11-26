/** S-257 step 1 captures: the real Hub (tests/helpers/hub-s3b-rig.ts) over owned HTTPS, headless Chromium, synthetic people.
 *  Notifications are granted to the page; pressing the bell shows the one-time "Keep notifications coming" notice. */
import assert from "node:assert/strict";
import { createServer as createHttps } from "node:https";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const REPO = process.env.REPO!, PW = process.env.PW_DIR!, CHROME = process.env.CHROME!;
const out = process.env.OUT ?? join(process.cwd(), ".artifacts", "s257"); mkdirSync(out, { recursive: true });
const pw = createRequire(join(resolve(PW), "package.json"))("playwright-core");
const { s3bRig } = await import(join(REPO, "tests/helpers/hub-s3b-rig.ts"));
const { createOwnedPki } = await import(join(REPO, "scripts/manual/hub-connector-4c/rig.mts"));
const scratch = mkdtempSync(join(tmpdir(), "s257-hub-")), pki = createOwnedPki(join(scratch, "pki"));
let r: any;
const server = createHttps({ key: readFileSync(pki.key), cert: readFileSync(pki.cert) }, (req, res) => { if (!r?.http.handle(req, res)) { res.writeHead(404); res.end(); } });
const browser = await pw.chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const result: Record<string, unknown> = {};
try {
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  r = await s3bRig({ webOrigin: origin, realAudit: true });
  for (const [device, lang, theme] of [["desk", "en", "light"], ["phone", "zh-TW", "dark"]] as const) {
    const phone = device === "phone", tag = `${device}-${theme}-${lang}`;
    const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 900 }, isMobile: phone, hasTouch: phone,
      deviceScaleFactor: 2, locale: lang === "en" ? "en-US" : "zh-TW", colorScheme: theme, ignoreHTTPSErrors: true,
      // A phone has no desktop notifications (the bell is off there); the phone frame uses a desktop user agent so the
      // notice can be shown at phone width.
      ...(phone ? { userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36" } : {}) });
    await ctx.grantPermissions(["notifications"], { origin });
    await ctx.addInitScript({ content: `localStorage.setItem('agend_lang',${JSON.stringify(lang)});localStorage.setItem('agend_theme',${JSON.stringify(theme)});localStorage.setItem('agend_tour_done','1');` });
    const page = await ctx.newPage(); page.setDefaultTimeout(20000);
    const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    try {
      await page.goto(origin + "/ui/hub?view=notices");
      await page.fill("#hubLogin", "admin"); await page.fill("#hubPassword", "pw-admin"); await page.locator(".hub-signin button[type=submit]").click();
      const bell = page.locator(".hub-head-tools .hub-notify").first(); await bell.waitFor(); await page.waitForTimeout(1500);
      await bell.click();
      const dialog = page.locator("dialog[open]"); await dialog.waitFor();
      const words = (await dialog.innerText()).replace(/\s+/g, " ").trim();
      assert.match(words, lang === "en" ? /Keep notifications coming/ : /持續收到通知/);
      await page.screenshot({ path: join(out, `hub-${tag}-keep.png`) });
      await dialog.locator('[data-confirm="yes"]').click(); await page.waitForTimeout(400);
      // Off and on again: no second notice.
      await bell.click(); await page.waitForTimeout(400); await bell.click(); await page.waitForTimeout(800);
      const again = await page.locator("dialog[open]").count();
      assert.equal(again, 0); assert.deepEqual(errors, []);
      result[tag] = { notice: words, secondTime: again };
    } finally { await ctx.close(); }
  }
} finally { await browser.close(); server.close(); await r?.close?.(); rmSync(scratch, { recursive: true, force: true }); }
writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 1));
