// S-91 (the user's decision hmsg-77256f66: never guide users to type a host command): a token saved for a connection that
// AgEnD added or changed since it started still waits for a restart, and its note points to the page's own restart notice.
// A real browser on the shared fixture (the product's own web server, a scratch home, no fleet start). The connection list and
// the provider's verify/apply answers are stubbed in the page (no bot, no provider call): this shows the note only.
// The live start itself (a connection AgEnD started with) is tests/hot-add-connection-1519.test.ts.
//   LABEL=base serves the strings from OLD_REF (the before picture: "on the host: agend restart").
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [LABEL=base|branch] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx tsx scripts/manual/smoke/smoke-token-restart-s91.mts
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-token-restart-s91";
const LABEL = process.env.LABEL ?? "branch", BASE = LABEL === "base";
const r: Record<string, unknown> = { label: LABEL };
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const oldStrings = BASE ? execFileSync("git", ["-C", process.env.REPO!, "show", `${process.env.OLD_REF ?? "songsid/release/2.3.5-alpha~1"}:src/ui/settings-strings.js`], { encoding: "utf8", maxBuffer: 16 << 20 }) : "";
const fx = await bootFixture({ port: 47570, instances: 4 });
// A connection in fleet.yaml for the Bots tab to list (its token env is unset: nothing can start, nothing calls a provider).
(fx.fm as any).saveFleetConfig([{ path: ["channels"], value: [{ id: "main", type: "telegram", mode: "topic", group_id: "-1001", bot_token_env: "AGEND_SMOKE_S91_UNSET" }] }]);
const json = (route: any, body: unknown) => route.fulfill({ status: 200, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
try {
  for (const c of matrix("desk-light-en,phone-dark-zh-TW")) {
    const cn = caseName(c), zh = c.lang === "zh-TW";
    const { ctx, page, csp } = await fx.page(c, { path: "/settings/agents" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    let served = 0;
    if (BASE) await page.route(/\/settings-strings\.js(\?.*)?$/, (route: any) => { served++; return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: oldStrings }); });
    await page.route(/\/api\/settings\/connections(\?.*)?$/, (route: any) => json(route, [{ id: "main", type: "telegram", token_present: true, identity: { username: "main_bot" } }]));
    // The dialog's own check of the typed token (no provider call): a valid bot.
    await page.route(/\/api\/settings\/quickstart\/probe$/, (route: any) => json(route, { identity: { valid: true, username: "main_bot" } }));
    await page.route(/\/api\/settings\/connections\/main\/secret\/verify$/, (route: any) => json(route, { ok: true, result: "verified", verification_id: "v1", identity: { username: "main_bot" } }));
    await page.route(/\/api\/settings\/connections\/main\/secret\/apply$/, (route: any) => json(route, { ok: true, result: "restart_required" }));
    // The Save's own apply job: answered here, so no reconcile runs in the fixture.
    await page.route(/\/api\/settings\/apply(\/j-s91)?$/, (route: any) => json(route, { id: "j-s91", status: "done", targets: [] }));
    await page.goto(`${fx.base}/settings/bots`);
    // The fixture also has Classic bots; the connection is the row naming its token env.
    const row = page.locator(".s-row", { hasText: "AGEND_SMOKE_S91_UNSET" }).first();
    await row.waitFor({ timeout: 15000 });
    await row.locator("button", { hasText: zh ? "設定" : "Settings" }).first().click();
    await page.waitForTimeout(1500);
    // The token is in the dialog's Advanced drawer.
    await page.locator("dialog[open] details.drawer summary", { hasText: zh ? "進階" : "Advanced" }).first().click();
    await page.locator("dialog[open] button", { hasText: zh ? "更換" : "Replace" }).first().click();
    await page.fill("dialog[open] #bot-token", "fake-new-token");
    await page.locator("dialog[open] .token-field button", { hasText: zh ? "驗證" : "Verify" }).first().click();
    await page.waitForTimeout(800);
    await page.locator("dialog[open] button", { hasText: zh ? "暫存新的 token" : "Stage the new token" }).first().click();
    await page.click("dialog[open] .dlg-x");
    await page.locator(".s-pending button", { hasText: zh ? "儲存" : "Save" }).first().click();
    const want = zh ? "AgEnD 重新啟動時會用新的 token 啟動" : "starts with the new token when AgEnD restarts";
    const shown = await page.waitForFunction((w: string) => document.body.innerText.includes(w), want, { timeout: 15000 }).then(() => true, () => false);
    await page.waitForTimeout(500);
    await page.screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-token-saved`) });
    const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
    const note = text.slice(Math.max(0, text.indexOf(zh ? "已儲存 token" : "Token saved")), text.indexOf(zh ? "已儲存 token" : "Token saved") + 220);
    const cspNow = await csp();
    if (BASE) { r[cn] = { served, shown, note, errs, csp: cspNow }; if (!served) fail.push(`${cn}:old strings not served`); await ctx.close(); continue; }
    check(cn, shown && !/agend restart/.test(text) && note.includes(zh ? "重新啟動提示" : "restart notice") && errs.length === 0 && cspNow.length === 0, { shown, note, errs, csp: cspNow });
    await ctx.close();
  }
} catch (e) { fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500); }
finally {
  mkdirSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE), { recursive: true });
  writeFileSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE, `result-${LABEL}.json`), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1).slice(0, 2500)); console.log(fail.length ? `FAIL: ${fail.join(", ")}` : BASE ? "RECORDED" : "ALL PASS");
  await fx.close(); process.exit(fail.length ? 1 : 0);
}
