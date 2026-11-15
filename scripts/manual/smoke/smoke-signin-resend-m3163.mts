// M-3163: the one-box sign-in page offers 「傳一組新的裝置登入碼給我」 ("Send me a new code") to a returning device only
// (GET /auth/device → returning). A chat admin who signed in with their authenticator app never got it: only a code DM'd to its
// owner made a browser a returning device (#1570). A real browser on the shared fixture (the product's own web server, a scratch
// home, no fleet start, fake data only), made a chat fleet (one Telegram connection, its General with a topic), each case its own
// chat admin with their own authenticator (one code per time step per app). Per case:
//   1-first-visit  — a new browser at /signin: no "Send me a new code" (not a returning device);
//   2-returning    — the same browser after signing in with the app's 6-digit code and signing out: the button is there
//                    (before this change it stayed hidden — run with REPO=<base checkout> to see it: the check then FAILs).
// No code is ever asked for (the button is not pressed: nothing is sent).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [MATRIX=full|quick] scripts/manual/smoke/run.sh smoke-signin-resend-m3163.mts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath, VIEWPORTS } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-signin-resend-m3163";
const REPO = process.env.REPO!;
const { base32Encode, base32Decode, hotp, totpStep, adminKey, WEB_REMOTE_ACCESS_FILE } = await import(REPO + "/src/web-remote-access.ts");
const fx = await bootFixture({ port: Number(process.env.HP ?? 47610), instances: 2 });
const fm = fx.fm as any;
const cases = matrix(process.env.MATRIX ?? "full");
const users = cases.map((_, i) => String(101 + i));
const secretOf = (u: string) => base32Encode(Buffer.from(`smoke-3163-${u}`.padEnd(20, "#").slice(0, 20)));
const codeOf = (u: string) => hotp(base32Decode(secretOf(u))!, totpStep(Date.now()));

// A chat fleet: one Telegram connection whose admins are the case users; its General has a topic. Each admin's app is seeded.
fm.fleetConfig.channels = [{ id: "a", type: "telegram", mode: "topic", group_id: "-1001", access: { mode: "locked", allowed_users: users } }];
delete fm.fleetConfig.channel;
fm.fleetConfig.web = { ...(fm.fleetConfig.web ?? {}), verified_authority: { enabled: true } };
const general = Object.keys(fm.fleetConfig.instances).find((n: string) => fm.fleetConfig.instances[n].general_topic)!;
fm.fleetConfig.instances[general].topic_id = 7;
const rec = (u: string) => ({ secret: secretOf(u), enrolledAt: 1, lastStep: 0 });
writeFileSync(join(fx.dir, WEB_REMOTE_ACCESS_FILE), JSON.stringify({ v: 1, admins: Object.fromEntries(users.map(u => [adminKey("a", u), rec(u)])),
  outside: false, wrong: 0, level: 0, pausedUntil: 0, handles: [] }), { mode: 0o600 });
fm.webRemoteAccessState = undefined;

const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
try {
  for (const [i, c] of cases.entries()) {
    const failed: string[] = [];
    const need = (ok: boolean, what: string) => { if (!ok) failed.push(what); };
    const ctx = await fx.browser.newContext({ viewport: VIEWPORTS[c.device], deviceScaleFactor: 1, colorScheme: c.theme, locale: c.lang === "zh-TW" ? "zh-TW" : "en-US", isMobile: c.device === "phone", hasTouch: c.device === "phone" });
    await ctx.addInitScript({ content: `try { localStorage.setItem("agend_lang", ${JSON.stringify(c.lang)}); } catch {}` });
    const page = await ctx.newPage();
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    const resendShown = async () => { await page.waitForTimeout(1200); return page.locator("#resend").isVisible(); };
    // A new browser: not a returning device.
    await page.goto(`${fx.base}/signin`); await page.waitForSelector("#code", { state: "visible", timeout: 15000 });
    need(!(await resendShown()), "first visit: no Send me a new code");
    await page.screenshot({ path: shotPath(SMOKE, caseName(c), "1-first-visit") });
    // Sign in with this admin's app.
    await page.fill("#code", codeOf(users[i]!));   // a complete 6-digit code signs in by itself (S-118 one box)
    const entered = await page.waitForURL(/\/ui/, { timeout: 15000 }).then(() => true, () => false);
    need(entered, "signed in with the authenticator code");
    // Signed out (the session cookie only; the browser keeps its other cookies, as after the session ends).
    const kept = (await ctx.cookies()).filter((k: any) => !/agend_session/.test(k.name));
    need(kept.some((k: any) => /agend_device/.test(k.name)), `a returning-device cookie: ${kept.map((k: any) => k.name).join(",")}`);
    await ctx.clearCookies(); await ctx.addCookies(kept);
    await page.goto(`${fx.base}/signin`); await page.waitForSelector("#code", { state: "visible", timeout: 15000 });
    const shown = await resendShown();
    const label = shown ? (await page.locator("#resend").textContent())?.trim() : null;
    need(shown && label === (c.lang === "zh-TW" ? "傳一組新的裝置登入碼給我" : "Send me a new code"), `returning: the button (${label})`);
    await page.screenshot({ path: shotPath(SMOKE, caseName(c), "2-returning") });
    need(errs.length === 0, `page errors: ${errs.join(" | ")}`);
    results.push({ name: caseName(c), ok: failed.length === 0, failed });
    await ctx.close();
  }
} finally {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(results.length === cases.length && results.every((r) => r.ok) ? 0 : 1);
