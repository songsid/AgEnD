// M-3897: Settings → Access & security before the first On, with earlier tickets an owner can retire and an earlier
// delivery that can be withdrawn. The real dashboard (this checkout) on the shared fixture; only GET of
// /api/settings/request-context answers with a before-first-On view (attempted false, phase blocked), as the controller
// now gives on a fleet holding such tickets. Shoots the section and the Retire confirmation.
//   PW_DIR=<dir with playwright-core> CHROME=<chromium> REPO=<checkout> OUT=<dir> [MATRIX=quick] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-m3897-retire.mts
import { bootFixture, matrix, caseName, shotPath, labelOf } from "../smoke-fixture/index.mts";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48170) });
const VIEW = { revision: 3, enabled: false, everActivated: false, attempted: false, phase: "blocked", canChange: true, restartCount: 4,
  goBack: { attemptIds: ["20261127T010203Z-abcdef12"], availableUntil: "2026-12-04T06:00:00.000Z", timeZone: "Asia/Taipei" },
  blockers: [
    { id: "legacy-retire:R39dd137e", kind: "legacy", labels: ["R39dd137e"], action: "retire" },
    { id: "legacy-withdraw:d-7a01", kind: "legacy", labels: ["Example lead → Example helper"], action: "withdraw" },
    { id: "legacy-uncertain", kind: "legacy", labels: ["Example lead → Example helper"] },
  ] };
const out: Record<string, unknown> = {};
for (const c of matrix(process.env.MATRIX ?? "quick")) {
  const { ctx, page } = await fx.page(c);
  await ctx.route("**/api/settings/request-context", r => r.request().method() === "GET" ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(VIEW) }) : r.continue());
  await page.goto(fx.base + "/settings/access"); await page.waitForTimeout(2500);
  const sec = page.locator("#request-context"); await sec.scrollIntoViewIfNeeded();
  await page.screenshot({ path: shotPath("m3897", c, "section") });
  const text = (await sec.innerText()).replace(/\s+/g, " ");
  await sec.getByRole("button", { name: labelOf(c, { en: "Retire", zh: "撤銷" }), exact: true }).click(); await page.waitForTimeout(800);
  await page.screenshot({ path: shotPath("m3897", c, "retire-confirm") });
  const dialog = (await page.getByRole("dialog").innerText().catch(() => "")).replace(/\s+/g, " ");
  out[caseName(c)] = { text, dialog };
  await ctx.close();
}
console.log(JSON.stringify(out, null, 2));
await fx.close(); process.exit(0);
