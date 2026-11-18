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
const out = resolve(process.env.OUT || ".artifacts/m3341/browser"), stage = process.env.STAGE || "after";
if (!["before", "after"].includes(stage)) throw Error("Unknown stage");
mkdirSync(out, { recursive: true });
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
  r.addPerson("example-owner", "Example owner");
  await r.signIn("example-owner"); // A real signed-in person candidate; no agent or Fleet exists.
  HUB_ROOM_INVITATIONS_MIGRATION.up(r.db);
  r.httpDeps.roomInvitations = (core, host) => createHubRoomInvitations(core, host);
  if (stage === "after") {
    HUB_ROOM_AGENT_REQUESTS_MIGRATION.up(r.db);
    r.httpDeps.roomAgentRequests = (core, host) => createHubRoomAgentRequests(core, host);
  }
  await r.restartHttp();
  const manager = await r.signIn("admin");
  browser = await pw.chromium.launch({ executablePath: process.env.CHROME, headless: true, env, args: ["--no-sandbox"] });
  for (const device of ["desk", "phone"]) for (const lang of ["en", "zh-TW"]) {
    const phone = device === "phone", tag = device + "-" + lang;
    const made = await r.call(manager, "POST", "/hub/v1/rooms", { name: lang === "en" ? "Example project" : "範例專案" });
    check(tag + ": real room created", made.status === 200);
    const room = made.json.room;
    const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 900 },
      isMobile: phone, hasTouch: phone, locale: lang === "en" ? "en-US" : "zh-TW", colorScheme: phone ? "dark" : "light",
      ignoreHTTPSErrors: true }); // Only the disposable loopback certificate; no operator browser or trust store.
    await context.addInitScript({ content: `window.__name=fn=>fn;localStorage.setItem('agend_lang',${JSON.stringify(lang)});localStorage.setItem('agend_theme',${JSON.stringify(phone ? "dark" : "light")});localStorage.setItem('agend_tour_done','1');` });
    await context.route("**/*", (route: any) => {
      if (new URL(route.request().url()).origin !== origin) { foreign.push("blocked"); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(15_000);
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("response", async (response: any) => {
      const path = new URL(response.url()).pathname;
      if (response.status() === 200 && (path.endsWith(".js") || path.endsWith(".css"))) {
        try { assets.set(path, createHash("sha256").update(await response.body()).digest("hex")); } catch { /* Closed context. */ }
      }
    });
    const shot = async (name: string) => {
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(out, tag + "-" + name + ".png") });
      check(tag + ": " + name + " no horizontal overflow", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    };
    try {
      await page.goto(origin + "/ui/hub?room=" + room.id);
      await page.fill("#hubLogin", "admin"); await page.fill("#hubPassword", "pw-admin");
      await page.locator(".hub-signin button[type=submit]").click();
      await page.locator(".hub-room-rail-toggle").waitFor();
      if (!await page.locator(".hub-room-settings-link").isVisible()) await page.locator(".hub-room-rail-toggle").click();
      await page.locator(".hub-room-settings-link").click();
      await page.locator("#hubRoomAddAgents").fill("Missing");
      await page.locator("#hubRoomAddAgents").locator("..").locator("p.note").filter({ hasText: lang === "en" ? "Nothing matches." : "符合" }).first().waitFor();
      await (stage === "after" ? page.locator(".hub-owner-request-entry") :
        page.locator("#hubRoomAddAgents").locator("..").locator("p.note").last()).scrollIntoViewIfNeeded();
      await shot("empty-search");
      if (stage === "before") {
        check(tag + ": no entry without composition", await page.locator(".hub-owner-request-entry").count() === 0);
        continue;
      }
      await page.locator(".hub-owner-request-entry button").click();
      await page.locator("#hubRequestOwner").fill("Example");
      await page.locator(".hub-owner-request .hub-room-result").waitFor();
      await shot("choose-person");
      await page.locator(".hub-owner-request .hub-room-result").click();
      await page.locator("#hubOwnerAgentNote").fill(lang === "en" ? "The agent that explains release notes" : "協助說明版本更新的 Agent");
      await shot("request");
      await page.locator('button[form="hubOwnerAgentRequestForm"]').click();
      await page.locator(".hub-owner-request").waitFor({ state: "detached" });
      await page.locator("[data-owner-request]").waitFor();
      await page.keyboard.press("Escape");
      if (!await page.locator(".hub-room-settings-link").isVisible()) await page.locator(".hub-room-rail-toggle").click();
      await page.locator(".hub-room-settings-link").click();
      check(tag + ": pending survives reopen without a search", await page.locator("#hubRoomAddAgents").inputValue() === "");
      await page.locator("[data-owner-request]").scrollIntoViewIfNeeded();
      await shot("waiting");
      check(tag + ": one persisted request", (r.db.prepare("SELECT COUNT(*) n FROM hub_room_agent_requests WHERE room_id=?").get(room.id) as { n: number }).n === 1);
      check(tag + ": private hint absent from manager detail", !JSON.stringify((await r.call(manager, "GET", "/hub/v1/rooms/" + room.id)).json).includes("explains release"));
      await page.locator("[data-owner-request] button").click(); await page.locator("[data-owner-request]").waitFor({ state: "detached" });
      check(tag + ": real cancel persisted", (r.db.prepare("SELECT state FROM hub_room_agent_requests WHERE room_id=?").get(room.id) as { state: string }).state === "cancelled");
      check(tag + ": no content-load error", !await page.locator('[role="alert"]').count());
      if (device === "phone" && lang === "zh-TW") {
        const link = r.link(randomUUID(), r.admin);
        const exposure = { id: randomUUID(), fleetId: link.fleetId, owner: r.admin, displayName: "Release helper", revision: 1,
          state: "published" as const, dataViewId: "example", allowedTools: [], policyDigest: "c".repeat(64) };
        await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [exposure] }, link) as never, link);
        await page.locator("#hubRoomAddAgents").fill("Release");
        await page.locator("#hubRoomAddAgents").locator("..").locator(".hub-room-result").waitFor();
        check(tag + ": entry remains below other matches", await page.locator(".hub-owner-request-entry").isVisible());
        await page.locator(".hub-owner-request-entry").scrollIntoViewIfNeeded(); await shot("other-matches");
      }
    } finally { await context.close(); }
  }
  check("no browser errors", errors.length === 0); check("no external requests", foreign.length === 0);
  check("no agent membership or member delivery", r.sent.length === 0 && (r.db.prepare("SELECT COUNT(*) n FROM hub_room_members WHERE kind='agent'").get() as { n: number }).n === 0);
  writeFileSync(join(out, "receipt.json"), JSON.stringify({ stage, source: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    diffSha256: createHash("sha256").update(execFileSync("git", ["diff", "HEAD"])).digest("hex"), checks,
    servedAssets: [...assets].map(([path, sha256]) => ({ path, sha256 })),
    scope: "Actual Hub HTTPS/SQLite/encrypted audit and shipped UI, optional A1 composition; inert directory, headless Linux. Disposable TLS certificate accepted only by the owned context. No live account, Fleet, model, Windows window or operator trust-store change." }, null, 2) + "\n");
  console.log(JSON.stringify({ stage, passed: checks.length }));
} finally {
  await browser?.close(); server.closeAllConnections();
  await new Promise<void>(yes => server.close(() => yes())); await r?.close();
  rmSync(scratch, { recursive: true, force: true });
}
