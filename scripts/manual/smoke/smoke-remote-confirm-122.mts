// AGEND-122 (upstream design issue #3486, R1): a web-only fleet's admin saves a Settings change that needs confirming from ANOTHER
// device — a LAN or tailnet name, not a public link. A real browser on the shared fixture (the product's own web server, a scratch
// home, no fleet start). The page is on http://dashboard.lan.example:<port> with an X-Forwarded-For header on every request, as
// `tailscale serve` sends it: AgEnD reads it as a LAN request. The session is the host's own sign-in code typed on that device.
//   1 remote, no authenticator, option off: before, the card waited for the AgEnD computer; after, the change is confirmed and applies;
//   2 remote, authenticator set up, option off: before, a code field; after, the change applies at once;
//   3 remote, THIS admin's own "ask for my code" switch on (per admin, kept in the authenticator's record): the code field for THAT change;
//     the current code applies it;
//   plus the Owner verification card in Settings → Access & security on a LAN page, as an admin sees it: not set up, the set-up dialog,
//   set up with the switch off and on, the current-code dialog for turning it off, and the whole Settings shell (desktop and phone).
// Run it against the base (REPO=<review-base checkout>) for the "before" shots and against the branch for the "after" shots
// (SMOKE_NAME picks the output folder). A known authenticator secret is seeded into the scratch home only. Fake data only.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> MATRIX=full FONTCONFIG_FILE=<fonts.conf> \
//   npx tsx scripts/manual/smoke/smoke-remote-confirm-122.mts
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-remote-confirm-122";
const REPO = process.env.REPO!;
const { base32Encode, base32Decode, hotp, totpStep, WEB_REMOTE_ACCESS_FILE } = await import(REPO + "/src/web-remote-access.ts");
const SECRET = base32Encode(Buffer.from("smoke-secret-0123456"));
const code = () => hotp(base32Decode(SECRET)!, totpStep(Date.now()));
const r: Record<string, unknown> = {};
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const HOST_CMD = /agend settings confirm/;
const fx = await bootFixture({ port: 47560, instances: 4, host: true });
const fm = fx.fm as any;
const enroll = (on: boolean, strict = false) => {
  const file = join(fx.dir, WEB_REMOTE_ACCESS_FILE);
  if (on) writeFileSync(file, JSON.stringify({ v: 1, totp: { secret: SECRET, enrolledAt: 1, lastStep: 0, ...(strict ? { strict: true } : {}) }, outside: false, wrong: 0, level: 0, pausedUntil: 0, handles: [] }), { mode: 0o600 });
  else rmSync(file, { force: true });
  fm.webRemoteAccessState = undefined;          // read again from the file
};
const membership = () => !!fm.getRawFleetConfig()?.hub_member?.enabled;
/** What the card on the page reads: its text, the folded host command, a code field, Apply now, and whether it says applied. */
const readCard = (page: any) => page.evaluate(() => {
  const c = document.querySelector(".pending-card");
  return { present: !!c, text: (c?.textContent ?? "").replace(/\s+/g, " ").trim(), hostCommand: !!c?.querySelector(".pending-host"), accessLink: !!c?.querySelector('a[href="/settings/access"]'),
    codeField: !!c?.querySelector(".pending-code-input"), applied: !!document.querySelector(".pending-card.applied") };
});
const REMOTE = { origin: "lan" as const, headers: { "X-Forwarded-For": "100.64.0.7" }, host: true };
const SCENARIOS = [["1-no-app", false, false], ["2-app-set-up", true, false], ["3-code-asked", true, true]] as const;
try {
  for (const c of matrix(process.env.MATRIX ?? "quick")) {
    const cn = caseName(c), zh = c.lang === "zh-TW";
    for (const [name, enrolled, strict] of SCENARIOS) {
      fm.saveFleetConfig([{ path: ["hub_member", "enabled"], value: false }]);
      enroll(enrolled, strict);
      const { ctx, page, csp } = await fx.page(c, { path: "/settings/hub", ...REMOTE });
      const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
      await page.waitForSelector("#hubMemberEnabled", { timeout: 15000 });
      await page.click("#hubMemberEnabled");
      await page.waitForSelector(".pending-card", { timeout: 15000 });
      await page.waitForFunction(() => !/Sending the confirm card|正在把確認卡送到/.test(document.querySelector(".pending-card")?.textContent || "x"), null, { timeout: 20000 });
      await page.waitForTimeout(900);
      const card = await readCard(page), tag = `${cn}:${name}`;
      r[`${tag}:observed`] = { ...card, applied: membership() };
      await page.locator(".pending-card").first().screenshot({ path: shotPath(SMOKE, cn, name) });
      check(`${tag}:no-host-command`, !card.hostCommand && !HOST_CMD.test(card.text) && errs.length === 0, { card, errs });
      if (strict) {
        check(`${tag}:asks-for-code`, card.codeField && !membership(), { card, on: membership() });
        await page.fill(".pending-code-input", code());
        await page.click("form.pending-code button[type=submit]");
        const applied = await page.waitForSelector(".pending-card.applied", { timeout: 15000 }).then(() => true, () => false);
        check(`${tag}:code-applies`, applied && membership() && (await csp()).length === 0, { applied, on: membership() });
      } else {
        // The lenient default: nothing waits for the AgEnD computer.
        check(`${tag}:applies-at-once`, membership(), { card });
      }
      await ctx.close();
    }
  }
  // The Owner verification card, as the admin sees it from another device (a LAN name), in each state it has.
  const UI = [["4-card-not-set-up", false, false], ["6-card-set-up", true, false], ["7-code-dialog", true, true]] as const;
  for (const c of matrix(process.env.MATRIX ?? "quick")) {
    const cn = caseName(c);
    for (const [name, enrolled, strict] of UI) {
      enroll(enrolled, strict);
      const { ctx, page } = await fx.page(c, { path: "/settings/access", ...REMOTE });
      const tag = `${cn}:${name}`;
      await page.waitForSelector("#outsideCard", { timeout: 15000 }).catch(() => null);
      await page.waitForTimeout(600);
      const card = page.locator("#outsideCard").first();
      const present = (await card.count()) > 0;
      r[`${tag}:observed`] = present ? await page.evaluate(() => ({ text: (document.querySelector("#outsideCard")?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
        setUp: !!document.querySelector("#outSetUp"), strictSwitch: !!document.querySelector("#outStrict") })) : { present: false };
      try {
        if (name === "7-code-dialog") {
          // Turning YOUR switch off from another device asks your current code first.
          await page.click("#outStrict"); await page.waitForSelector(".dlg #outAskCode", { timeout: 8000 });
          await page.locator(".dlg").first().screenshot({ path: shotPath(SMOKE, cn, name) });
        } else await (present ? card : page.locator("body")).screenshot({ path: shotPath(SMOKE, cn, name) });
        if (name === "4-card-not-set-up" && present && await page.locator("#outSetUp").count()) {
          await page.click("#outSetUp"); await page.waitForSelector(".dlg #outKey", { timeout: 8000 });
          await page.waitForTimeout(400);
          await page.locator(".dlg").first().screenshot({ path: shotPath(SMOKE, cn, "5-set-up-dialog") });
          await page.keyboard.press("Escape"); await page.waitForTimeout(300);
        }
        await page.screenshot({ path: shotPath(SMOKE, cn, `${name.slice(0, 1)}-shell`) });
      } catch (e) { r[`${tag}:capture`] = String(e).slice(0, 160); await page.screenshot({ path: shotPath(SMOKE, cn, name) }).catch(() => {}); }
      await ctx.close();
    }
  }
} catch (e) { fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500); }
finally {
  mkdirSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE), { recursive: true });
  writeFileSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE, "result.json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1).slice(0, 8000)); console.log(fail.length ? `FAIL: ${fail.join(", ")}` : "ALL PASS");
  await fx.close(); process.exit(fail.length ? 1 : 0);
}
