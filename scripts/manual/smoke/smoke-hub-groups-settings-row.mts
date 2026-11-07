// #3298 S-89: fleet Settings → Hub on a Hub host shows "Group permissions" with a link to the Hub's own editor — on the shared
// Settings fixture (the product's web server from an in-process FleetManager, scratch home, loopback only). The fixture has no
// Hub, so this page's read of fleet.yaml is given a `hub:` block (hubId + webOrigin) in the browser; nothing else is changed.
// Checks: the row is there with the Hub's HTTPS link (new tab, noopener), no page error, no CSP report; a picture per case.
//   PW_DIR=<dir> REPO=<checkout> OUT=<dir> [MATRIX=desk-light-zh-TW,…] FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/smoke-hub-groups-settings-row.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix } from "../smoke-fixture/index.mts";

const OUT = join(process.env.OUT ?? "/tmp/smoke-out", "hub-groups-settings-row");
mkdirSync(OUT, { recursive: true });
const CASES = matrix(process.env.MATRIX ?? "desk-light-zh-TW,desk-light-en,phone-dark-zh-TW");
const HUB = { hubId: "4c3b2a19-0e8f-4d7c-9b6a-5f4e3d2c1b0a", webOrigin: "https://hub.example.test", enabled: true };
const r: Record<string, unknown> = {}, fail: string[] = [];
const fx = await bootFixture({ port: 19460, instances: 4, classic: false });
try {
  for (const c of CASES) {
    const name = caseName(c);
    const { ctx, page, csp } = await fx.page(c, { path: "/settings" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    await page.route((u: URL) => u.pathname === "/api/settings/fleet/raw", async (route: any) => {
      const real = await route.fetch(); const body = await real.json();
      return route.fulfill({ status: real.status(), contentType: "application/json; charset=utf-8", body: JSON.stringify({ ...body, hub: HUB }) });
    });
    await page.goto(fx.base + "/settings/hub"); await page.waitForTimeout(1500);
    await page.waitForSelector("#hub-group-permissions", { timeout: 15000 }).catch(() => {});
    const row = await page.evaluate(`(() => { const a = document.querySelector("#hub-group-permissions a"); return a ? { href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel"), text: document.querySelector("#hub-group-permissions").textContent } : null; })()`);
    await page.evaluate(`document.querySelector("#hub-group-permissions")?.scrollIntoView({ block: "center" })`); await page.waitForTimeout(200);
    await page.screenshot({ path: join(OUT, `${name}-settings-hub-row.png`) });
    const ok = !!row && row.href === "https://hub.example.test/ui/hub/admin?view=groups" && row.target === "_blank" && row.rel === "noopener noreferrer" && errs.length === 0 && (await csp()).length === 0;
    r[name] = ok ? "PASS" : { FAIL: { row, errs, csp: await csp() } }; if (!ok) fail.push(name);
    await ctx.close();
  }
} catch (e) { fail.push(`exception: ${(e as Error).message}`); r.exception = String((e as Error).stack || e).slice(0, 1000); }
finally {
  await fx.close?.();
  writeFileSync(join(OUT, "result.json"), JSON.stringify(r, null, 2));
  console.log(JSON.stringify(r, null, 2)); console.log(fail.length ? `FAIL ${fail.length}: ${fail.join(", ")}` : "ALL PASS");
  process.exit(fail.length ? 1 : 0);
}
