// AGEND-118: the "waiting for confirmation" card says the one next step this device can take, by state. A real browser on the
// shared fixture (the product's own web server, a scratch home, no fleet start; every name and address is the fixture's own).
// Each state is the real card for a real held change (turning Hub membership on), except two the fixture cannot reach on
// its own — a request the browser may confirm itself (Apply now), one opened over a link, and one that ran out its five
// minutes — which are the real page given the server's answer for them (the read of the held change is rewritten; nothing
// else is).
//   unbound   web-only fleet, a code-signed-in admin, no authenticator set up   → set it up (or confirm on the AgEnD computer)
//   bound     the same with the authenticator set up                           → the 6-digit field, at once
//   host      the AgEnD computer's own browser, which may press Apply now      → Apply now
//   link      opened over a link                                                → confirm on the AgEnD computer
//   withdrawn withdrawn from the card                                           → says so, and Send again
//   expired   the five minutes ran out                                          → says so, and Send again
//   unbound-open  the unbound card with its other ways to confirm opened
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx tsx scripts/manual/smoke/smoke-pending-next-step.mts
// Run it on two checkouts (OUT per run) to compare before and after.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-pending-next-step";
const REPO = process.env.REPO!;
const { base32Encode, WEB_REMOTE_ACCESS_FILE } = await import(REPO + "/src/web-remote-access.ts");
const SECRET = base32Encode(Buffer.from("smoke-secret-0123456"));
const r: Record<string, unknown> = {};
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const EXPIRED = { en: "Confirmation expired. Review and apply again.", "zh-TW": "確認已過期。請重新檢查後再套用。" };

type Fx = Awaited<ReturnType<typeof bootFixture>>;
const enroll = (fx: Fx, on: boolean) => {
  const file = join(fx.dir, WEB_REMOTE_ACCESS_FILE);
  if (on) writeFileSync(file, JSON.stringify({ v: 1, totp: { secret: SECRET, enrolledAt: 1, lastStep: 0 }, outside: false, wrong: 0, level: 0, pausedUntil: 0, handles: [] }), { mode: 0o600 });
  else rmSync(file, { force: true });
  (fx.fm as any).webRemoteAccessState = undefined;          // read again from the file
};

/** Hold a change (Hub membership on) and wait until its card has stopped saying it is being sent. */
async function hold(fx: Fx, c: ReturnType<typeof matrix>[number]) {
  (fx.fm as any).saveFleetConfig([{ path: ["hub_member", "enabled"], value: false }]);
  const { ctx, page, csp } = await fx.page(c, { path: "/settings/hub" });
  const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
  await page.waitForSelector("#hubMemberEnabled", { timeout: 15000 });
  await page.click("#hubMemberEnabled");
  await page.waitForSelector(".pending-card", { timeout: 15000 });
  await page.waitForFunction(() => !/Sending the confirm card|正在把確認卡送到/.test(document.querySelector(".pending-card")?.textContent || "x"), null, { timeout: 20000 });
  await page.waitForTimeout(400);
  return { ctx, page, csp, errs };
}
const card = (page: any) => page.locator(".pending-card").first();
const text = (page: any) => page.evaluate(() => (document.querySelector(".pending-card")?.textContent ?? "").replace(/\s+/g, " "));
/** The server's answer for a read of the held change, rewritten: only what the fixture cannot reach on its own. */
async function rewriteReads(page: any, change: (view: any) => any) {
  await page.route(/\/api\/settings\/pending\/[0-9a-f]{32}$/, async (route: any) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch(); const view = await res.json();
    await route.fulfill({ response: res, json: change(view) });
  });
}

const fx = await bootFixture({ port: 47560, instances: 4 });
try {
  for (const c of matrix("full")) {
    const cn = caseName(c);
    // unbound
    enroll(fx, false);
    let h = await hold(fx, c);
    await card(h.page).screenshot({ path: shotPath(SMOKE, cn, "1-unbound") });
    check(`${cn}:unbound`, h.errs.length === 0, { errs: h.errs, text: await text(h.page) });
    // host: the same held change, read by a browser that may confirm it itself
    await rewriteReads(h.page, (v: any) => v.state === "pending" ? { ...v, can_self_confirm: true, totp: undefined, confirm_digest: undefined } : v);
    await h.page.waitForTimeout(2600);
    await card(h.page).screenshot({ path: shotPath(SMOKE, cn, "3-host") });
    // link: the same held change, read as one opened over a link
    await h.page.unrouteAll({ behavior: "ignoreErrors" });
    await rewriteReads(h.page, (v: any) => v.state === "pending" ? { ...v, totp: "on_host", confirm_digest: undefined } : v);
    await h.page.waitForTimeout(2600);
    await card(h.page).screenshot({ path: shotPath(SMOKE, cn, "4-link") });
    // unbound again, with the folded ways opened
    await h.page.unrouteAll({ behavior: "ignoreErrors" });
    await h.page.waitForFunction(() => !!document.querySelector(".pending-code-setup, .pending-on-host"), null, { timeout: 8000 });
    await h.page.waitForTimeout(2600);
    await h.page.click(".pending-card details.pending-host > summary");
    await h.page.waitForTimeout(300);
    await card(h.page).screenshot({ path: shotPath(SMOKE, cn, "7-unbound-open") });
    await h.ctx.close();
    // bound
    enroll(fx, true);
    h = await hold(fx, c);
    await h.page.waitForSelector(".pending-code-input", { timeout: 10000 });
    await card(h.page).screenshot({ path: shotPath(SMOKE, cn, "2-bound") });
    check(`${cn}:bound`, h.errs.length === 0 && (await h.csp()).length === 0, { errs: h.errs });
    // expired: the same card, after its five minutes
    await rewriteReads(h.page, (v: any) => ({ ...v, state: "expired", remaining_ms: 0, can_withdraw: false, totp: undefined,
      outcome: { state: "expired", reason_code: "expired", message: EXPIRED[c.lang], decided_at: Date.now() } }));
    await h.page.waitForSelector(".pending-card.expired", { timeout: 8000 });
    await h.page.waitForTimeout(300);
    await card(h.page).screenshot({ path: shotPath(SMOKE, cn, "6-expired") });
    await h.ctx.close();
    // withdrawn: really withdrawn from the card
    enroll(fx, false);
    h = await hold(fx, c);
    await h.page.click(".pending-actions .btn");
    await h.page.waitForSelector(".pending-card.rejected", { timeout: 8000 });
    await h.page.waitForTimeout(300);
    await card(h.page).screenshot({ path: shotPath(SMOKE, cn, "5-withdrawn") });
    check(`${cn}:withdrawn`, h.errs.length === 0, { errs: h.errs, text: await text(h.page) });
    await h.ctx.close();
  }
} catch (e) { fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500); }

finally {
  await fx.close();
  const out = join(process.env.OUT ?? "/tmp/smoke-out", SMOKE);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "result.json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1)); console.log(fail.length ? "FAIL: " + fail.join(", ") : "ALL PASS");
  process.exit(fail.length ? 1 : 0);
}
