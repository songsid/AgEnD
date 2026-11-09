// alpha.6 user report: Settings → Access & security → Hub membership switched on and saved, then a reload: the Connect to a
// Hub card must appear — no fleet restart. A real browser on the shared fixture (the product's own web server from an
// in-process FleetManager, a scratch home, no fleet start). The save is the one PUT /api/settings/hub/membership commits
// (FleetManager.saveFleetConfig with the hub_member.enabled patch, on the fixture's real fleet.yaml).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-hub-member-reload.mts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-hub-member-reload";
const r: Record<string, unknown> = {};
const fail: string[] = [];
const fx = await bootFixture({ port: 47350, instances: 6 });
try {
  for (const c of matrix("desk-dark-zh-TW,phone-light-en")) {
    const cn = caseName(c);
    fx.fm.saveFleetConfig([{ path: ["hub_member", "enabled"], value: false }]);
    const { ctx, page } = await fx.page(c, { path: "/settings/access" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    await page.waitForSelector(".s-section-layout", { timeout: 15000 });
    await page.waitForTimeout(800);
    const before = await page.evaluate(`({ mark: document.body.dataset.hub || "", card: !!document.querySelector("#hub-connect") })`);
    fx.fm.saveFleetConfig([{ path: ["hub_member", "enabled"], value: true }]);
    await page.reload();
    await page.waitForSelector(".s-section-layout", { timeout: 15000 });
    const card = await page.waitForSelector("#hub-connect", { timeout: 10000 }).then(() => true, () => false);
    const after = await page.evaluate(`({ mark: document.body.dataset.hub || "" })`);
    if (card) await page.evaluate(`document.querySelector("#hub-connect").scrollIntoView({ block: "center" })`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: shotPath(SMOKE, cn, "after-reload") });
    const ok = before.mark === "" && !before.card && after.mark === "member" && card && errs.length === 0;
    r[cn] = ok ? "PASS" : { FAIL: { before, after, card, errs } };
    if (!ok) fail.push(cn);
    await ctx.close();
  }
} catch (e) { fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500); }
finally {
  writeFileSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE, "result.json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1)); console.log(fail.length ? `FAIL: ${fail.join(", ")}` : "ALL PASS");
  await fx.close(); process.exit(fail.length ? 1 : 0);
}
