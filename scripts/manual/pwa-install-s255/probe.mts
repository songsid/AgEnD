/** S-255 probe: does Chromium consider the Fleet dashboard installable? Owned fixture only (no Fleet/CLI start).
 *  A persistent profile, because Chromium never offers Install in an incognito-like context. */
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootFixture } from "../smoke-fixture/index.mts";
const pw = createRequire(process.env.PW_DIR + "/")("playwright-core");
const fx = await bootFixture({ port: Number(process.env.PORT ?? 24951), host: true, classic: false, roster: [
  { name: "general", backend: "claude-code", general: true, displayName: "General" } ] });
const profile = mkdtempSync(join(tmpdir(), "s255-profile-"));
try {
  const { tokenEpoch } = await import(process.env.REPO + "/src/web-session.ts");
  const ctx = await pw.chromium.launchPersistentContext(profile, { executablePath: process.env.CHROME, headless: true, args: ["--no-sandbox"] });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto(`${fx.base}/signin`); await page.waitForSelector("#code");
  fx.fm.initializeWebSessions();
  const code = fx.fm.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(fx.fm.webToken), host: true }).display;
  await page.locator("#code").evaluate((input: HTMLInputElement, value: string) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); input.form!.requestSubmit(); }, code);
  await page.waitForURL(`${fx.base}/ui`);
  await page.waitForTimeout(4000);
  const cdp = await ctx.newCDPSession(page);
  const errs = await cdp.send("Page.getInstallabilityErrors");
  const sw = await page.evaluate(async () => ({ secure: isSecureContext, regs: (await navigator.serviceWorker.getRegistrations()).map(r => r.scope) }));
  console.log(JSON.stringify({ url: page.url(), installabilityErrors: errs.installabilityErrors, ...sw }));
  await ctx.close();
} finally { rmSync(profile, { recursive: true, force: true }); clearInterval(fx.fm.replyObligationTimer); await fx.close(); }
