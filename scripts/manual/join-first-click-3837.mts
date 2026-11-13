/**
 * #3837: real Chromium on the real fleet web server (smoke fixture), Settings → Hub's one-box company join. A person types
 * the Hub address, waits for "Found …", and clicks **Sign in with company account** — Playwright's click is a real
 * mousedown (the input blurs) → mouseup → click. The join API is answered by routes (no Hub is needed for the click):
 * - after (this tree): exactly one /probe and exactly one /start; the waiting tab opens;
 * - before (BASE_REF's settings-hub-company-join.js served): the blur re-checks, the button is disabled under the click —
 *   two /probe, no /start.
 * EN/zh-TW × desktop/phone. Env: REPO, OUT, PW_DIR, BASE_REF, HP (optional).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { bootFixture, matrix, caseName, labelOf } from "./smoke-fixture/index.mts";

const repo = resolve(process.env.REPO!), out = resolve(process.env.OUT!), base = process.env.BASE_REF!;
if (!base) throw Error("BASE_REF is required");
mkdirSync(out, { recursive: true });
const BEFORE = execFileSync("git", ["show", `${base}:src/ui/settings-hub-company-join.js`], { cwd: repo, encoding: "utf8" });
const FOUND = { ok: true, hubName: "Acme Hub", webOrigin: "https://hub.example.test", companyJoin: true, identity: "new", separateHosts: true, suggestedLabel: "build-box", features: [] };
const PENDING = { operationId: "0f1e2d3c-4b5a-4968-8776-655443322110", state: "awaiting-sign-in", issued: false, outcomeKnown: true, hubOrigin: "https://hub.example.test", expiresAt: Date.now() + 600_000, handoffId: null };
const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const fx = await bootFixture({ port: Number(process.env.HP ?? 54980), instances: 1, classic: false });
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail?: string) => { results.push({ name, ok, ...(detail ? { detail } : {}) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
try {
  for (const c of matrix(process.env.MATRIX ?? "desk-light-en,desk-light-zh-TW,phone-light-en,phone-dark-zh-TW")) for (const variant of ["after", "before"] as const) {
    const { ctx, page } = await fx.page(c, { path: "/settings/hub" });
    const seen = { probe: 0, start: 0 };
    await page.route("**/api/hub/member/company-join", (r: any) => r.fulfill(json({ ok: true, operation: null })));
    await page.route("**/api/hub/member/company-join/probe", (r: any) => { seen.probe++; return r.fulfill(json(FOUND)); });
    await page.route("**/api/hub/member/company-join/start", (r: any) => { seen.start++; return r.fulfill(json({ ok: true, operation: PENDING })); });
    if (variant === "before") await page.route("**/ui/js/settings-hub-company-join.js", (r: any) => r.fulfill({ status: 200, contentType: "text/javascript", body: BEFORE }));
    await page.goto(`${fx.base}/settings/hub`);
    const input = page.locator("#hubCompanyAddress"); await input.waitFor();
    await input.fill("hub.example.test");
    await page.locator("#hubCompanyLine").filter({ hasText: labelOf(c, { en: "Found", zh: "找到" }) }).waitFor({ timeout: 15000 });
    const go = page.getByRole("button", { name: labelOf(c, { en: "Sign in with company account", zh: "以公司帳號登入" }), exact: true });
    const opened = ctx.waitForEvent("page", { timeout: 4000 }).then(() => true, () => false);
    await go.click();                                                                     // mousedown blurs the input, then the click
    const tab = await opened; await page.waitForTimeout(800);
    const name = `${caseName(c)} ${variant}`;
    if (variant === "after") {
      check(`${name}: one click → exactly one /start, no second look; the waiting tab opens`, seen.start === 1 && seen.probe === 1 && tab, `probe=${seen.probe} start=${seen.start} tab=${tab}`);
    } else {
      check(`${name}: (base) the click is lost — the blur looks again and no /start is sent`, seen.start === 0 && seen.probe === 2, `probe=${seen.probe} start=${seen.start}`);
    }
    await page.screenshot({ path: join(out, `click.${variant}.${caseName(c)}.png`) });
    await ctx.close();
  }
} finally {
  writeFileSync(join(out, "receipt.json"), JSON.stringify({ base, results }, null, 2));
  await fx.close();
}
const failed = results.filter(r => !r.ok).length;
console.log(JSON.stringify({ pass: failed === 0, checks: results.length, failed }));
process.exit(failed ? 1 : 0);
