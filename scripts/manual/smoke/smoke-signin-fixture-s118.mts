/** Regression for the shared smoke bootstrap: current auto-submit and cached manual-only signin.js each send ONE real login POST.
 * Own scratch listener, no FleetManager.start/CLI/model. This is fixture compatibility, not chat/TOTP core acceptance.
 * REPO=$PWD PW_DIR=$PWD/node_modules/playwright-core CHROME=<chrome> OUT=<dir> npx tsx scripts/manual/smoke/smoke-signin-fixture-s118.mts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix } from "../smoke-fixture/index.mts";
const base = "d8dd79910a643f9546cd07045015208aafb42ed6";
const old = execFileSync("git", ["show", `${base}:src/ui/shared/signin.js`], { cwd: process.env.REPO!, encoding: "utf8" });
const fx = await bootFixture({ port: 47960, instances: 2, classic: false, host: true });
const open = fx.browser.newContext.bind(fx.browser);
let legacy = false, posts: string[] = [];
const result: Record<string, unknown> = {};
fx.browser.newContext = async (options: unknown) => {
  const ctx = await open(options);
  if (legacy) await ctx.route("**/assets/signin.js", (route: any) => route.fulfill({ body: old, contentType: "text/javascript" }));
  ctx.on("request", (req: any) => { if (req.method() === "POST") posts.push(new URL(req.url()).pathname); });
  return ctx;
};
try {
  for (const cached of [false, true]) for (const c of matrix("quick")) {
    legacy = cached; posts = [];
    const { page, ctx, csp } = await fx.page(c);
    const key = `${cached ? "cached-manual" : "current-auto"}:${caseName(c)}`;
    const value = { atDashboard: page.url() === fx.base + "/ui", session: (await page.request.get(fx.base + "/auth/session")).status(), posts: [...posts], csp: await csp() };
    result[key] = value;
    if (!value.atDashboard || value.session !== 200 || value.posts.join() !== "/auth/login" || value.csp.length) throw Error(`${key}: ${JSON.stringify(value)}`);
    await ctx.close();
  }
} finally {
  fx.browser.newContext = open;
  const out = process.env.OUT!; mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "fixture-bootstrap.json"), JSON.stringify({ base, scope: "real synthetic device-code redemption; common helper only", result }, null, 2));
  await fx.close();
}
console.log("PASS: four current/cached EN-desktop/zh-phone bootstrap cases, one login POST each");
