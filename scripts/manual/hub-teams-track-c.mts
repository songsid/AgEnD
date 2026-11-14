/** Initial Teams UI matrix: real Hub shell/assets on owned HTTPS, worked Team API fixture. No production Team route claim. */
import { createRequire } from "node:module";
import { createServer } from "node:https";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { s3bRig } from "../../tests/helpers/hub-s3b-rig.js";
import { createHubRoomsFixture } from "../../tests/support/hub-rooms-fixture.js";
import { provisionHubIdentity } from "../../src/hub/tls.js";
import { listenLoopback } from "./smoke-fixture/listen-loopback.mjs";

const out = resolve(process.env.OUT || ".artifacts/teams-track-c/browser"); mkdirSync(out, { recursive: true });
const server = createServer(), port = await listenLoopback(server), origin = `https://127.0.0.1:${port}`, keys = mkdtempSync(join(out, "keys-"));
const rig = await s3bRig({ webOrigin: origin }); let browser: any;
const digest = (v: Buffer | string) => createHash("sha256").update(v).digest("hex"), assets = new Map<string, string>();
const receipt: any = { sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), origin,
  scope: "Production shared Hub shell and Team components; owned HTTPS/SQLite shell rig with inert directory, worked Team API fixture. No production Team routes/factory, real AD, account or Fleet execution claim.",
  checks: [], pictures: [], geometry: [], api: [], servedAssets: [] };
const check = (name: string, value: unknown) => { receipt.checks.push({ name, ok: !!value }); if (!value) throw Error(name); };
try {
  await provisionHubIdentity({ home: keys, memberOrigin: origin });
  server.setSecureContext({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) });
  server.on("request", (req, res) => { if (!rig.http.handle(req, res)) { res.writeHead(404); res.end(); } });
  const auth = await rig.signIn("admin"), pw = createRequire(resolve(process.env.PW_DIR!, "package.json"))("playwright-core");
  browser = await pw.chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ["--no-sandbox"] });
  for (const device of ["desktop", "phone"]) for (const lang of ["en", "zh-TW"]) for (const theme of ["light", "dark"]) {
    if (process.env.DEVICE && device !== process.env.DEVICE) continue;
    const tag = `${device}-${lang}-${theme}`, english = lang === "en", errors: string[] = [], fx = createHubRoomsFixture({ csrf: auth.csrf, features: ["rooms-v1", "teams-v1"], teamLead: true });
    const context = await browser.newContext({ viewport: device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 1000 }, locale: english ? "en-US" : "zh-TW", colorScheme: theme,
      ignoreHTTPSErrors: true, isMobile: device === "phone", hasTouch: device === "phone" });
    const eq = auth.cookie.indexOf("="); await context.addCookies([{ name: auth.cookie.slice(0, eq), value: auth.cookie.slice(eq + 1), url: origin, secure: true, httpOnly: true }]);
    await context.addInitScript(({ lang, theme }) => { localStorage.setItem("agend_lang", lang); localStorage.setItem("agend_theme", theme); localStorage.setItem("agend_tour_done", "1"); }, { lang, theme });
    let leadMode = false;
    await context.route(/\/hub\/v1\/session$/, async (route: any) => { const res = await route.fetch(), json = await res.json();
      if (json.signedIn) { json.features = [...new Set([...(json.features || []), "teams-v1"])]; json.person = { id: fx.me.id, name: fx.me.name }; json.admin = !leadMode; }
      await route.fulfill({ response: res, json }); });
    await context.route(/\/hub\/v1\/teams(?:\/[^?]*)?(?:\?.*)?$/, async (route: any) => {
      const request = route.request(), url = new URL(request.url()), body = request.postDataJSON();
      const answer = fx.handle({ method: request.method(), path: url.pathname + url.search, headers: request.headers(), body });
      receipt.api.push({ tag, method: request.method(), path: url.pathname + url.search, status: answer?.status });
      await route.fulfill({ status: answer?.status || 404, json: answer?.body || {} });
    });
    const page = await context.newPage(), responseWork: Promise<void>[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    page.on("response", (response: any) => { const url = new URL(response.url()); if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/ui/js/"))
      responseWork.push(response.body().then((body: Buffer) => { assets.set(url.pathname, digest(body)); }).catch(() => {})); });
    const shot = async (name: string) => { const path = `${tag}-${name}.png`; await page.screenshot({ path: join(out, path), fullPage: true }); receipt.pictures.push({ path, sha256: digest(readFileSync(join(out, path))) }); };
    await page.goto(origin + "/ui/hub/admin?view=teams"); await page.locator(".hub-team-list button").waitFor();
    await page.locator(".hub-team-list button").click(); await page.locator(".hub-team-editor tbody tr").first().waitFor();
    check(tag + " fresh feature stylesheet", await page.locator('link[data-hub-teams-css="1"]').evaluate((link: HTMLLinkElement) => !!link.sheet));
    check(tag + " admin metadata", await page.locator("[data-team-name]").count() === 1);
    check(tag + " lead cannot be removed", await page.locator("tbody tr").first().locator("button").isDisabled());
    check(tag + " four roster columns", (await page.locator("thead th").allTextContents()).slice(0, 4).join("|") === (english ? "Members|Role|Joined Hub|Shared agents" : "成員|身分|已加入 Hub|分享的 Agent"));
    await page.getByRole("button", { name: english ? "Add member" : "加入成員", exact: true }).click();
    const query = page.locator(".hub-team-search input"); await query.fill("new");
    check(tag + " company-wide wording", await query.getAttribute("placeholder") === (english ? "Search by name (whole company)" : "輸入姓名搜尋（全公司）"));
    await page.locator(".hub-team-search").getByRole("button", { name: english ? "Search" : "搜尋", exact: true }).click(); await page.locator(".hub-team-hits li").waitFor();
    check(tag + " result sign-in name", (await page.locator(".hub-team-hits").innerText()).includes("new"));
    await page.locator(".hub-team-hits button").click(); await page.getByRole("button", { name: english ? "Save" : "儲存", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 3);
    check(tag + " fixture save", fx.teams[0]!.members.includes("person-new"));
    await shot("admin-roster");
    leadMode = true; await page.goto(origin + "/ui/hub?view=teams"); await page.locator(".hub-team-list button").waitFor(); await page.locator(".hub-team-list button").click(); await page.locator("tbody tr").first().waitFor();
    check(tag + " lead roster only", await page.locator("[data-team-name]").count() === 0 && await page.getByRole("button", { name: english ? "Delete team" : "刪除團隊", exact: true }).count() === 0);
    const sizes = await page.locator(".hub-teams button, .hub-teams input, .hub-teams select").evaluateAll((els: HTMLElement[]) => els.filter(el => !el.hidden && el.getBoundingClientRect().width > 0).map(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })));
    receipt.geometry.push({ tag, fields: sizes }); check(tag + " touch fields", device !== "phone" || sizes.every((s: any) => s.width >= 44 && s.height >= 44));
    check(tag + " page fits", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await shot("lead-roster");
    if (device === "phone") { await page.locator("#sbOpen").click(); await page.waitForFunction(() => { const box = document.querySelector("#sidebar")?.getBoundingClientRect(); return !!box && box.left >= -1 && box.width >= 200; }); await page.waitForTimeout(250); await page.locator('.side-nav a[href="/ui/hub?view=teams"]').waitFor({ state: "visible" }); await shot("lead-drawer"); }
    else await page.locator('.side-nav a[href="/ui/hub?view=teams"]').waitFor({ state: "visible" });
    check(tag + " no page errors", errors.length === 0); await Promise.all(responseWork); await context.close();
  }
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rig.close(); rmSync(keys, { recursive: true, force: true });
  receipt.servedAssets = [...assets].map(([path, sha256]) => ({ path, sha256 })); receipt.cleaned = { browser: true, listener: true, sqlite: true, keys: true };
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
}
console.log(JSON.stringify({ cases: receipt.pictures.filter((row: any) => row.path.endsWith("admin-roster.png")).length, checks: receipt.checks.length, png: receipt.pictures.length }));
