// alpha.6 feedback #2c — the user's decision hmsg-468cc290 and the leader's ruling (b): a web-only fleet's held change is
// confirmed on this computer's own page with the owner's authenticator code. A real browser on the shared fixture (the
// product's own web server, a scratch home, no fleet start); the fixture's session is an admin signed in with a code (not
// the host operator), so the card offers the code. A known authenticator secret is seeded into the scratch home only.
//   1. no app set up: the card says so and links to Access & security (no host command);
//   2. app set up: a code field; a wrong code is refused in plain words and the change still waits;
//   3. the current code: the change is applied (Hub membership on in fleet.yaml);
//   desk light en and phone dark zh-TW; no page error, no CSP report.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx tsx scripts/manual/smoke/smoke-pending-totp-b2b.mts
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-pending-totp-b2b";
const REPO = process.env.REPO!;
const { base32Encode, base32Decode, hotp, totpStep, WEB_REMOTE_ACCESS_FILE } = await import(REPO + "/src/web-remote-access.ts");
const SECRET = base32Encode(Buffer.from("smoke-secret-0123456"));
const code = () => hotp(base32Decode(SECRET)!, totpStep(Date.now()));
const r: Record<string, unknown> = {};
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const fx = await bootFixture({ port: 47550, instances: 4 });
const fm = fx.fm as any;
const enroll = (on: boolean) => {
  const file = join(fx.dir, WEB_REMOTE_ACCESS_FILE);
  if (on) writeFileSync(file, JSON.stringify({ v: 1, totp: { secret: SECRET, enrolledAt: 1, lastStep: 0 }, outside: false, wrong: 0, level: 0, pausedUntil: 0, handles: [] }), { mode: 0o600 });
  else rmSync(file, { force: true });
  fm.webRemoteAccessState = undefined;          // read again from the file
};
const membership = () => !!fm.getRawFleetConfig()?.hub_member?.enabled;
try {
  for (const c of matrix("desk-light-en,phone-dark-zh-TW")) {
    const cn = caseName(c), zh = c.lang === "zh-TW";
    for (const setUp of [false, true]) {
      fm.saveFleetConfig([{ path: ["hub_member", "enabled"], value: false }]);
      enroll(setUp);
      const { ctx, page, csp } = await fx.page(c, { path: "/settings/hub" });
      const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
      await page.waitForSelector("#hubMemberEnabled", { timeout: 15000 });
      await page.click("#hubMemberEnabled");
      await page.waitForFunction(() => !/Sending the confirm card|正在把確認卡送到/.test(document.querySelector(".pending-card")?.textContent || "x"), null, { timeout: 20000 });
      await page.waitForTimeout(400);
      if (!setUp) {
        const setup = await page.evaluate(() => ({ text: document.querySelector(".pending-code-setup")?.textContent?.replace(/\s+/g, " ") ?? "", href: document.querySelector(".pending-code-setup a")?.getAttribute("href") ?? null, field: !!document.querySelector(".pending-code-input") }));
        await page.locator(".pending-card").screenshot({ path: shotPath(SMOKE, cn, "1-not-set-up") });
        check(`${cn}:not-set-up`, setup.href === "/settings/access" && !setup.field && setup.text.includes(zh ? "驗證器 App" : "authenticator app") && errs.length === 0, { setup, errs });
        await ctx.close(); continue;
      }
      await page.waitForSelector(".pending-code-input", { timeout: 10000 });
      await page.fill(".pending-code-input", code() === "000000" ? "111111" : "000000");
      await page.click("form.pending-code button[type=submit]"); await page.waitForTimeout(800);
      const wrong = await page.evaluate(() => document.querySelector(".pending-card [role=alert]")?.textContent ?? "");
      await page.screenshot({ path: shotPath(SMOKE, cn, "2-wrong") });
      const stillWaiting = !membership();
      await page.fill(".pending-code-input", code());
      await page.click("form.pending-code button[type=submit]");
      const applied = await page.waitForSelector(".pending-card.applied", { timeout: 15000 }).then(() => true, () => false);
      await page.waitForTimeout(500);
      await page.screenshot({ path: shotPath(SMOKE, cn, "3-applied") });
      const cspNow = await csp();
      check(`${cn}:code`, wrong.includes(zh ? "代碼不正確" : "That code is not right") && stillWaiting && applied && membership() && errs.length === 0 && cspNow.length === 0,
        { wrong, stillWaiting, applied, on: membership(), errs, csp: cspNow });
      await ctx.close();
    }
  }
} catch (e) { fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500); }
finally {
  mkdirSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE), { recursive: true });
  writeFileSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE, "result.json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1).slice(0, 2500)); console.log(fail.length ? `FAIL: ${fail.join(", ")}` : "ALL PASS");
  await fx.close(); process.exit(fail.length ? 1 : 0);
}
