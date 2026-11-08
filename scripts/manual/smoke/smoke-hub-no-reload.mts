// The leader's cid-hub-no-reload (#3319: the user stuck on "Reload page"; decision 721ca0c3 add. 2, minimal clicks): turning
// Hub membership on, once confirmed, shows "Connect to a Hub"'s address and code fields in the same page — no reload. A real
// browser on the shared fixture (the product's own web server, a scratch home, no fleet start). Its session is an admin signed
// in with a code on a web-only fleet (not the host operator), so the change is held and confirmed on this page with the
// authenticator code (a known secret seeded into the scratch home only) — the in-page way; General's card and the host's
// Apply now end in the same followed "applied" (tests/hub-membership-ui.test.ts covers those). Per case:
//   - the switch on → the held card → the code → applied → #hubAddress shows, no navigation happened (a window marker
//     survives), the page is marked a member, and no "Reload page" anywhere;
//   desk light en and phone dark zh-TW; no page error, no CSP report.
//   LABEL=base serves settings-hub-membership.js from OLD_REF (the before picture: "Reload page", no fields).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [LABEL=base|branch] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx tsx scripts/manual/smoke/smoke-hub-no-reload.mts
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-hub-no-reload";
const REPO = process.env.REPO!;
const LABEL = process.env.LABEL ?? "branch", BASE = LABEL === "base";
const OLD = process.env.OLD_REF ?? "songsid/release/2.3.5-alpha";
const { base32Encode, base32Decode, hotp, totpStep, WEB_REMOTE_ACCESS_FILE } = await import(REPO + "/src/web-remote-access.ts");
const SECRET = base32Encode(Buffer.from("smoke-secret-no-reload"));
// Each time step is accepted once (#3008): a later case waits for a fresh step rather than reuse the last one's code.
let usedStep = -1;
const code = async () => { while (totpStep(Date.now()) <= usedStep) await new Promise((r) => setTimeout(r, 1000)); usedStep = totpStep(Date.now()); return hotp(base32Decode(SECRET)!, usedStep); };
const r: Record<string, unknown> = { label: LABEL };
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const fx = await bootFixture({ port: 47630, instances: 4 });
const fm = fx.fm as any;
fm.hubEffectsReady = true;                // as at a fleet's start (smoke-settings-hub-a7b too): the Hub switches apply from here on
writeFileSync(join(fx.dir, WEB_REMOTE_ACCESS_FILE), JSON.stringify({ v: 1, totp: { secret: SECRET, enrolledAt: 1, lastStep: 0 }, outside: false, wrong: 0, level: 0, pausedUntil: 0, handles: [] }), { mode: 0o600 });
fm.webRemoteAccessState = undefined;
const oldModule = BASE ? execFileSync("git", ["-C", REPO, "show", `${OLD}:src/ui/settings-hub-membership.js`], { encoding: "utf8", maxBuffer: 16 << 20 }) : "";
try {
  for (const c of matrix("desk-light-en,phone-dark-zh-TW")) {
    const cn = caseName(c), zh = c.lang === "zh-TW";
    fm.saveFleetConfig([{ path: ["hub_member", "enabled"], value: false }]);
    const { ctx, page, csp } = await fx.page(c, { path: "/settings/agents" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    if (BASE) await page.route(/\/settings-hub-membership\.js(\?.*)?$/, (route: any) => route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: oldModule }));
    await page.goto(`${fx.base}/settings/hub`);
    await page.waitForSelector("#hubMemberEnabled", { timeout: 15000 });
    await page.evaluate(() => { (window as any).__noReloadMarker = 1; });              // gone if the page reloads
    await page.click("#hubMemberEnabled");
    await page.waitForSelector(".pending-code-input", { timeout: 20000 });
    await page.fill(".pending-code-input", await code());
    await page.click("form.pending-code button[type=submit]");
    const fields = await page.waitForSelector("#hubAddress", { timeout: 15000 }).then(() => true, () => false);
    if (!fields) r[cn + ":debug"] = await page.evaluate(() => ({ card: (document.querySelector(".pending-card") as HTMLElement | null)?.innerText.replace(/\s+/g, " ").slice(0, 400) ?? null,
      section: (document.querySelector("#hub-membership") as HTMLElement | null)?.innerText.replace(/\s+/g, " ").slice(0, 300) ?? null,
      after: (document.querySelector(".hub-membership-settings") as HTMLElement | null)?.innerText.replace(/\s+/g, " ").slice(-500) ?? null,
      html: (document.querySelector(".hub-membership-settings") as HTMLElement | null)?.innerHTML.slice(-800) ?? null }));
    await page.waitForTimeout(600);
    const state = await page.evaluate(() => ({ marker: (window as any).__noReloadMarker === 1, mark: document.body.dataset.hub ?? null,
      reloadAsked: /Reload page|重新整理頁面/.test(document.body.innerText), code: !!document.querySelector("#hubCode, [id*=hubCode], input[name=code]") }));
    const on = !!fm.getRawFleetConfig()?.hub_member?.enabled;
    // The fields when they are there (on a phone they sit below the fixed tab bar), else the membership card.
    await page.evaluate(() => { const el = document.querySelector("#hub-connect") ?? document.querySelector("#hub-membership"); el?.scrollIntoView({ block: "center" }); });
    await page.waitForTimeout(300);
    await page.screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-after-confirm`) });
    const cspNow = await csp();
    if (BASE) { r[cn] = { fields, ...state, on, errs }; await ctx.close(); continue; }
    check(cn, fields && on && state.marker && state.mark === "member" && !state.reloadAsked && errs.length === 0 && cspNow.length === 0, { fields, on, ...state, errs, csp: cspNow });
    await ctx.close();
  }
} catch (e) { fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500); }
finally {
  rmSync(join(fx.dir, WEB_REMOTE_ACCESS_FILE), { force: true });
  mkdirSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE), { recursive: true });
  writeFileSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE, `result-${LABEL}.json`), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1).slice(0, 2500)); console.log(fail.length ? `FAIL: ${fail.join(", ")}` : BASE ? "RECORDED" : "ALL PASS");
  await fx.close(); process.exit(fail.length ? 1 : 0);
}
