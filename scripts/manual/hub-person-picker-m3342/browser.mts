/** Actual owned Hub HTTPS/SQLite/audit and browser modules. Inert directory; no Fleet, CLI or model. */
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { s3bRig } from "../../../tests/helpers/hub-s3b-rig.js";
import { createHubRoomInvitations, HUB_ROOM_INVITATIONS_MIGRATION } from "../../../src/hub/invitations.js";
import { createHubRoomAgentRequests, HUB_ROOM_AGENT_REQUESTS_MIGRATION } from "../../../src/hub/room-agent-requests.js";
import { createOwnedPki } from "../hub-connector-4c/rig.mjs";

if (process.platform !== "linux" || !process.env.CHROME?.startsWith("/home/") || process.env.CHROME.includes("/mnt/"))
  throw Error("Pin a Linux headless browser; Windows browsers are forbidden");
if (!process.env.CJK_FONT) throw Error("Supply a Traditional Chinese font for readable zh-TW captures");
const out = resolve(process.env.OUT || ".artifacts/person-picker-m3342/browser"), stage = process.env.STAGE || "after";
if (!["before", "after"].includes(stage)) throw Error("Unknown stage");
mkdirSync(out, { recursive: true });
const baseline = process.env.BASELINE_REF;
if (stage === "before" && !baseline) throw Error("Before captures need the reviewed baseline renderer ref");
const beforeRenderer = stage === "before" ? execFileSync("git", ["show", `${baseline}:src/ui/hub-room-new.js`], { encoding: "utf8" }) : null;
const beforeCss = stage === "before" ? execFileSync("git", ["show", `${baseline}:src/ui/shared/hub-rooms-u2.css`], { encoding: "utf8" }) : null;
const scratch = mkdtempSync(join(out, "owned-")), home = join(scratch, "home");
mkdirSync(home, { recursive: true, mode: 0o700 });
const fonts = join(home, ".local/share/fonts"); mkdirSync(fonts, { recursive: true });
copyFileSync(process.env.CJK_FONT, join(fonts, "NotoSansCJKtc-Regular.otf"));
const pki = createOwnedPki(join(scratch, "pki"));
const pw = createRequire(join(resolve(process.env.PW_DIR!), "package.json"))("playwright-core");
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share") };
for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "WSL_INTEROP"]) delete env[key];
let r: Awaited<ReturnType<typeof s3bRig>> | undefined, browser: any;
const checks: { key: string; ok: boolean }[] = [], assets = new Map<string, string>();
const errors: string[] = [], foreign: string[] = [];
const check = (key: string, ok: unknown) => { checks.push({ key, ok: !!ok }); if (!ok) throw Error(key); };
const server = createServer({ key: readFileSync(pki.key), cert: readFileSync(pki.cert) }, (req, res) => {
  if (!r?.http.handle(req, res)) { res.writeHead(404); res.end(); }
});
try {
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  r = await s3bRig({ webOrigin: origin, realAudit: true });
  const samples = [
    { login: "sample-one", name: "Alex Sample", department: "Project support" },
    { login: "sample-two", name: "Alex Sample", department: "Project support" },
    { login: "sample-three", name: "Casey Sample" },
    { login: "sample-four", name: "Morgan Sample", empty: true },
    { login: "sample-five", name: "Taylor Sample", department: "A very long synthetic department for project coordination across several regions" },
  ];
  const selected = samples.map(row => ({ ...row, person: r!.addPerson(row.login, row.name) }));
  for (const row of selected) await r.signIn(row.login);
  r.directory.searchGrantPeople = async (_q, options) => ({ ok: true, truncated: false,
    people: selected.map(row => ({ person: row.person, login: row.empty ? " " : row.login, displayName: row.name,
      ...(options?.includeDepartment && row.department ? { department: row.department } : {}) })) });
  HUB_ROOM_INVITATIONS_MIGRATION.up(r.db);
  r.httpDeps.roomInvitations = (core, host) => createHubRoomInvitations(core, host);
  HUB_ROOM_AGENT_REQUESTS_MIGRATION.up(r.db);
  r.httpDeps.roomAgentRequests = (core, host) => createHubRoomAgentRequests(core, host);
  await r.restartHttp();
  const manager = await r.signIn("admin");
  browser = await pw.chromium.launch({ executablePath: process.env.CHROME, headless: true, env, args: ["--no-sandbox"] });
  for (const device of ["desk", "phone"]) for (const lang of ["en", "zh-TW"]) {
    const phone = device === "phone", tag = device + "-" + lang;
    const made = await r.call(manager, "POST", "/hub/v1/rooms", { name: lang === "en" ? "Example project" : "範例專案" });
    check(tag + ": real room created", made.status === 200);
    const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 900 },
      isMobile: phone, hasTouch: phone, locale: lang === "en" ? "en-US" : "zh-TW", colorScheme: phone ? "dark" : "light", ignoreHTTPSErrors: true });
    await context.addInitScript({ content: `window.__name=fn=>fn;localStorage.setItem('agend_lang',${JSON.stringify(lang)});localStorage.setItem('agend_theme',${JSON.stringify(phone ? "dark" : "light")});localStorage.setItem('agend_tour_done','1');` });
    await context.route("**/*", (route: any) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { foreign.push("blocked"); return route.abort(); }
      if (beforeRenderer && url.pathname === "/ui/js/hub-room-new.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: beforeRenderer });
      if (beforeCss && url.pathname === "/assets/hub-rooms-u2.css") return route.fulfill({ status: 200, contentType: "text/css", body: beforeCss });
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(15_000);
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("response", async (response: any) => { const path = new URL(response.url()).pathname;
      if (response.status() === 200 && /\.(js|css)$/.test(path)) try { assets.set(path, createHash("sha256").update(await response.body()).digest("hex")); } catch {} });
    const shot = async (name: string) => {
      await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: join(out, tag + "-" + name + ".png") });
      check(tag + ": " + name + " no horizontal overflow", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    };
    const verify = async (box: any) => {
      await box.locator(".hub-room-result").first().waitFor();
      check(tag + ": five person matches", await box.locator(".hub-room-result").count() === 5);
      if (stage === "before") { check(tag + ": old renderer has no second line", await box.locator(".hub-room-person-detail").count() === 0); return; }
      const detail = await box.locator(".hub-room-person-detail").allTextContents();
      check(tag + ": server detail rules", JSON.stringify(detail) === JSON.stringify(["Project support · sample-one", "Project support · sample-two", "sample-three", samples[4].department]));
      check(tag + ": each visible line fits", await box.locator(".hub-room-person-label").evaluateAll((nodes: Element[]) => nodes.every(n => Array.from(n.children).every(child => {
        const style = getComputedStyle(child); return style.whiteSpace === "nowrap" && style.textOverflow === "ellipsis" && child.getBoundingClientRect().width <= n.getBoundingClientRect().width + 1;
      }))));
      check(tag + ": titles keep full labels", await box.locator(".hub-room-person-detail").last().getAttribute("title") === samples[4].department);
    };
    try {
      await page.goto(origin + "/ui/hub?room=" + made.json.room.id);
      await page.fill("#hubLogin", "admin"); await page.fill("#hubPassword", "pw-admin"); await page.locator(".hub-signin button[type=submit]").click();
      await page.locator(".hub-room-rail-toggle").waitFor();
      if (!await page.locator(".hub-room-settings-link").isVisible()) await page.locator(".hub-room-rail-toggle").click();
      await page.locator(".hub-room-settings-link").click();
      await page.locator("#hubRoomAddPeople").fill("Sample");
      const members = page.locator("#hubRoomAddPeople").locator(".."); await verify(members);
      await members.scrollIntoViewIfNeeded(); await shot("add-members");
      await page.locator("#hubRoomAddAgents").fill("Missing");
      await page.locator(".hub-owner-request-entry button").click();
      await page.locator("#hubRequestOwner").fill("Sample");
      const owner = page.locator(".hub-owner-request"); await verify(owner); await shot("ask-owner");
      if (phone && stage === "after") {
        await owner.locator(".hub-room-result").last().scrollIntoViewIfNeeded(); await shot("long-department");
        check(tag + ": long department ellipsized", await owner.locator(".hub-room-person-detail").last().evaluate((node: HTMLElement) => node.scrollWidth > node.clientWidth));
      }
      await owner.locator(".hub-room-result").nth(1).click();
      check(tag + ": selected chip name-only", (await owner.locator(".hub-room-tags").textContent()).replace("×", "").replace(/\s+/g, " ").trim() === "Alex Sample");
      check(tag + ": no load error", await page.locator('[role="alert"]').count() === 0);
    } finally { await context.close(); }
  }
  check("no browser errors", errors.length === 0); check("no external requests", foreign.length === 0); check("no Fleet delivery", r.sent.length === 0);
  writeFileSync(join(out, "receipt.json"), JSON.stringify({ stage, source: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    diffSha256: createHash("sha256").update(execFileSync("git", ["diff", "HEAD"])).digest("hex"), beforeRendererRef: baseline ?? null, checks,
    servedAssets: [...assets].map(([path, sha256]) => ({ path, sha256 })),
    scope: "Actual owned Hub HTTPS/SQLite/audit and shipped UI; synthetic directory; headless Linux. Before uses baseline renderer/CSS with the same candidate backend. No live Hub/Fleet, model or account, desktop window or host trust-store change." }, null, 2) + "\n");
  console.log(JSON.stringify({ stage, passed: checks.length }));
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); await r?.close();
  rmSync(scratch, { recursive: true, force: true });
}
