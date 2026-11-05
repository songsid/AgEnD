// S3c (S-55): Settings → Access & security → Connect to a Hub on a member fleet — the shared agents' picker (a data
// view and tools under the agent; one choice preselected) and Share, on the stub client (no Hub here). The page is
// marked a member (data-hub="member", as hub_member.enabled marks it). Desk and phone, light and dark, en and zh-TW.
// SKEW, both ways: an old shell (app.js, app-shell.js, app-stream.js, app.css, instance-nav.js, app-i18n.js from SKEW)
// loading the new card lazily; and the new host with the old card modules (settings-hub.js, hub-client.js,
// hub-strings.js from SKEW). Judged: the card renders, the picker opens and Share publishes (new card), the old card
// still shares (old), no page errors.
//   PW_DIR=… REPO=<checkout> OUT=<dir> SKEW=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-s3c-hub-card.mts
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, mounted, shotPath, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-s3c-hub-card";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48971), classic: false, instances: 3 });
const agent = fx.instances[0]!.name as string;
const results: any[] = [];
let failed = 0;
const record = (name: string, c: Record<string, boolean>, extra: Record<string, unknown> = {}) => {
  const bad = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length) failed++;
  results.push({ name, ok: !bad.length, checks: c, ...extra });
  console.log(`${bad.length ? "FAIL" : "ok  "} ${name}${bad.length ? ` [${bad.join(", ")}]` : ""} ${JSON.stringify(extra).slice(0, 300)}`);
};
async function open(c: MatrixCase, routes: Array<[string, string, string]> = []) {
  const { ctx, page } = await fx.page(c, { path: "/ui" });
  const errors: string[] = [];
  page.on("pageerror", (e: any) => errors.push(String(e)));
  page.on("console", (m: any) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  // The member mark, as the server sets it when hub_member.enabled (web-api: data-hub="member").
  await page.route("**/settings/access", async (r: any) => { const res = await r.fetch(); const body = (await res.text()).replace(/<body([^>]*)>/, '<body$1 data-hub="member">'); await r.fulfill({ response: res, body }); });
  for (const [glob, body, type] of routes) await page.route(glob, (r: any) => r.fulfill({ status: 200, contentType: type, body }));
  await page.goto(`${fx.base}/settings/access`);
  if (!(await mounted(page, 30000))) throw new Error("the app did not mount");
  await page.waitForSelector("#hub-connect", { timeout: 20000 });
  // The stub's own controls: the owner and the Hub's administrator approve; this agent can run restricted.
  await page.evaluate(async (a: string) => {
    const m: any = await import("/ui/js/hub-client.js"), c = m.hubClient();
    await c.connect({ address: "https://hub.example.test", code: "ABCD-EFGH" }); c.control.ownerConfirmed(); c.control.approve({ name: "Team Hub" }); c.control.enforceable([a]);
  }, agent);
  await page.waitForSelector(".hub-exposure input", { timeout: 15000 });
  return { ctx, page, errors };
}
for (const c of matrix(process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,phone-dark-zh-TW,phone-light-en")) {
  const { ctx, page, errors } = await open(c);
  const box = page.locator(".hub-exposure input").first();
  await box.check({ force: true }).catch(() => box.click());
  await page.waitForSelector(".hub-exposure-pick", { timeout: 5000 }).catch(() => {});
  const opened = await page.locator(".hub-exposure-pick").count();
  const pre = await page.locator(".hub-exposure-pick select").inputValue().catch(() => "");
  await page.locator(".hub-exposure-tools input").first().check();
  await page.locator(".hub-exposure-pick").scrollIntoViewIfNeeded();
  await page.screenshot({ path: shotPath(SMOKE, c, "picker") });
  await page.locator(".hub-exposure-pick .btn-primary").click();
  await page.waitForSelector(".hub-exposure.is-shared", { timeout: 5000 }).catch(() => {});
  await page.screenshot({ path: shotPath(SMOKE, c, "shared") });
  record(`${caseName(c)} picker and Share`, {
    "the picker opened": opened === 1,
    "one view preselected": pre === "summary",
    "shared after Share": (await page.locator(".hub-exposure.is-shared").count()) === 1,
    "no horizontal overflow": await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "no page errors": errors.length === 0,
  }, { pre, errors: errors.slice(0, 3) });
  await ctx.close();
}
const S = process.env.SKEW;
if (S && existsSync(S)) {
  const c = matrix("desk-light-en")[0]!, file = (f: string) => readFileSync(join(S, f), "utf8");
  {
    const shell = ["app.js", "app-shell.js", "app-stream.js", "app.css", "instance-nav.js", "app-i18n.js"];
    const { ctx, page, errors } = await open(c, shell.map((f) => [`**/assets/${f}*`, file(f), f.endsWith(".css") ? "text/css" : "text/javascript"] as [string, string, string]));
    await page.locator(".hub-exposure input").first().check({ force: true }).catch(() => {});
    await page.waitForSelector(".hub-exposure-pick", { timeout: 5000 }).catch(() => {});
    await page.locator(".hub-exposure-tools input").first().check().catch(() => {});
    await page.locator(".hub-exposure-pick .btn-primary").click().catch(() => {});
    await page.waitForSelector(".hub-exposure.is-shared", { timeout: 5000 }).catch(() => {});
    await page.screenshot({ path: shotPath(SMOKE, c, "skew-old-shell") });
    record("SKEW old shell + new card", { "the picker and Share work": (await page.locator(".hub-exposure.is-shared").count()) === 1, "no page errors": errors.length === 0 }, { errors: errors.slice(0, 3) });
    await ctx.close();
  }
  {
    const mods = ["settings-hub.js", "hub-client.js", "hub-strings.js"];
    const { ctx, page, errors } = await open(c, mods.map((f) => [`**/ui/js/${f}*`, file(f), "text/javascript"] as [string, string, string]));
    await page.locator(".hub-exposure input").first().check({ force: true }).catch(() => {});
    await page.waitForSelector(".hub-exposure.is-shared", { timeout: 5000 }).catch(() => {});
    await page.screenshot({ path: shotPath(SMOKE, c, "skew-old-card") });
    record("SKEW new host + old card", { "the old card shares (its own switch)": (await page.locator(".hub-exposure.is-shared").count()) === 1, "no picker (old)": (await page.locator(".hub-exposure-pick").count()) === 0, "no page errors": errors.length === 0 }, { errors: errors.slice(0, 3) });
    await ctx.close();
  }
}
writeFileSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE, "result.json"), JSON.stringify({ failed, results }, null, 2));
await fx.close();
process.exit(failed ? 1 : 0);
