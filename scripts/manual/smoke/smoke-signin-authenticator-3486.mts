// #3486 follow-up: a browser that is not signed in yet signs in as an admin with that admin's own authenticator. A real browser on the shared
// fixture (the product's own web server, a scratch home, no fleet start); the browser is signed OUT, on this computer's own listener. Fake data only.
//   MODE=before  the page a new browser has today at its sign-in address: /signin (the 8-character sign-in code);
//   MODE=after   the new page, /signin/authenticator, and its wrong-code state; the same run also signs in with the right code (checked, not shot).
// Run it against the base checkout for MODE=before and against the branch for MODE=after (SMOKE_NAME picks the output folder):
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> MODE=after MATRIX=full npx tsx scripts/manual/smoke/smoke-signin-authenticator-3486.mts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath, VIEWPORTS } from "../smoke-fixture/index.mts";

const MODE = process.env.MODE === "before" ? "before" : "after";
const SMOKE = process.env.SMOKE_NAME ?? `smoke-signin-authenticator-3486-${MODE}`;
const REPO = process.env.REPO!;
const { base32Encode, base32Decode, hotp, totpStep, WEB_REMOTE_ACCESS_FILE } = await import(REPO + "/src/web-remote-access.ts");
const SECRET = base32Encode(Buffer.from("smoke-secret-0123456"));
const code = (offset = 0) => hotp(base32Decode(SECRET)!, totpStep(Date.now()) + offset);
const r: Record<string, unknown> = {};
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const fx = await bootFixture({ port: 47590, instances: 2, host: true });
const fm = fx.fm as any;
if (MODE === "after") {
  // The fleet's one admin has an authenticator set up (its secret is seeded into the scratch home only).
  writeFileSync(join(fx.dir, WEB_REMOTE_ACCESS_FILE), JSON.stringify({ v: 1, totp: { secret: SECRET, enrolledAt: 1, lastStep: 0 }, outside: false, wrong: 0, level: 0, pausedUntil: 0, handles: [] }), { mode: 0o600 });
  fm.webRemoteAccessState = undefined;
}
try {
  for (const c of matrix(process.env.MATRIX ?? "quick")) {
    const cn = caseName(c);
    const ctx = await fx.browser.newContext({ viewport: VIEWPORTS[c.device], deviceScaleFactor: 1, colorScheme: c.theme, locale: c.lang === "zh-TW" ? "zh-TW" : "en-US", isMobile: c.device === "phone", hasTouch: c.device === "phone" });
    await ctx.addInitScript({ content: `try { localStorage.setItem("agend_lang", ${JSON.stringify(c.lang)}); } catch {}` });
    const page = await ctx.newPage();
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    if (MODE === "before") {
      await page.goto(`${fx.base}/signin`); await page.waitForSelector("#code", { state: "visible", timeout: 15000 }); await page.waitForTimeout(400);
      await page.screenshot({ path: shotPath(SMOKE, cn, "1-signin") });
      check(`${cn}:before-page`, errs.length === 0, errs);
    } else {
      await page.goto(`${fx.base}/signin/authenticator`); await page.waitForSelector("#code", { timeout: 15000 }); await page.waitForTimeout(300);
      const attrs = await page.evaluate(() => [document.getElementById("account")?.getAttribute("autocomplete"), document.getElementById("code")?.getAttribute("autocomplete"), (document.getElementById("accountRow") as HTMLElement).hidden].join(","));
      check(`${cn}:autocomplete-and-web-only-has-no-name-field`, attrs === "username,one-time-code,true", attrs);
      await page.screenshot({ path: shotPath(SMOKE, cn, "1-authenticator") });
      await page.fill("#code", "000000"); await page.click("#go");
      await page.waitForFunction(() => (document.getElementById("msg")?.textContent ?? "").length > 0, null, { timeout: 15000 });
      await page.screenshot({ path: shotPath(SMOKE, cn, "2-wrong-code") });
      const csp = await page.evaluate("window.__csp || []").catch(() => []) as string[];
      check(`${cn}:no-page-error`, errs.length === 0 && csp.length === 0, { errs, csp });
    }
    await ctx.close();
  }
  if (MODE === "after") {
    // …and a real sign-in with the right code, once (one use per time step): a fresh signed-out browser lands in the dashboard.
    const ctx = await fx.browser.newContext({ viewport: VIEWPORTS.desk });
    const page = await ctx.newPage();
    await page.goto(`${fx.base}/signin/authenticator`); await page.waitForSelector("#code");
    await page.fill("#code", code()); await page.click("#go");
    const entered = await page.waitForURL(/\/ui/, { timeout: 15000 }).then(() => true, () => false);
    const session = entered ? await page.evaluate(async () => (await fetch("/auth/session")).status) : 0;
    check("signs-in-with-the-code", entered && session === 200, { entered, session });
    await ctx.close();
  }
} finally {
  console.log(JSON.stringify(r, null, 2));
  await fx.close();
}
if (fail.length) { console.error("FAILED:", fail.join(", ")); process.exit(1); }
