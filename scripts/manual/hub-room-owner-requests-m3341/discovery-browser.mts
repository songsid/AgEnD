/** Room discovery: owned HTTPS/SQLite/audit and shipped UI; synthetic directory/publication facts only. */
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { s3bRig } from "../../../tests/helpers/hub-s3b-rig.js";
import { createHubRoomInvitations, HUB_ROOM_INVITATIONS_MIGRATION } from "../../../src/hub/invitations.js";
import { createHubRoomAgentRequests } from "../../../src/hub/room-agent-requests.js";
import { createOwnedPki } from "../hub-connector-4c/rig.mjs";
if (process.platform !== "linux" || !process.env.CHROME?.startsWith("/home/") || process.env.CHROME.includes("/mnt/")) throw Error("Pin Linux headless Chromium only");
if (!process.env.CJK_FONT || !process.env.PW_DIR) throw Error("Pin the browser package and Traditional Chinese font");
const pickerOnly = process.env.VIEW === "picker";
const out = resolve(process.env.OUT || ".artifacts/m3341/discovery-browser"); mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(out, "owned-")), home = join(scratch, "home");
mkdirSync(join(home, ".local/share/fonts"), { recursive: true, mode: 0o700 }); copyFileSync(process.env.CJK_FONT, join(home, ".local/share/fonts/NotoSansCJKtc-Regular.otf"));
const pki = createOwnedPki(join(scratch, "pki")), pw = createRequire(join(resolve(process.env.PW_DIR), "package.json"))("playwright-core");
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share") };
for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "WSL_INTEROP"]) delete env[key];
let r: Awaited<ReturnType<typeof s3bRig>> | undefined, browser: any;
const checks: { key: string; ok: boolean }[] = [], errors: string[] = [], foreign: string[] = [], assets = new Map<string, string>();
const check = (key: string, ok: unknown) => { checks.push({ key, ok: !!ok }); if (!ok) throw Error(key); };
const server = createServer({ key: readFileSync(pki.key), cert: readFileSync(pki.cert) }, (req, res) => { if (!r?.http.handle(req, res)) { res.writeHead(404); res.end(); } });
try {
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  r = await s3bRig({ webOrigin: origin, realAudit: true });
  const owner = r.addPerson("example-owner", "Example owner");
  HUB_ROOM_INVITATIONS_MIGRATION.up(r.db); r.httpDeps.roomInvitations = createHubRoomInvitations;
  r.httpDeps.roomAgentRequests = createHubRoomAgentRequests; await r.restartHttp();
  const manager = await r.signIn("admin"), signedOwner = await r.signIn("example-owner");
  const publish = async (name: string, intro: string) => {
    const id = randomUUID(); r!.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "fixture.fleet", result: "completed" }, state => {
      state.fleets.push({ id, owner, generation: 1, credentialHash: null, status: "active", label: "Example fleet" });
    });
    const link = r!.link(id, owner), exposure = { id: randomUUID(), fleetId: id, owner, displayName: name, revision: 1, state: "published" as const,
      dataViewId: "agent", allowedTools: [], policyDigest: "c".repeat(64) };
    await r!.http.receive(r!.frame("exposure.snapshot", { revision: 1, exposures: [exposure] }, link) as never, link);
    check("real published introduction", (await r!.call(signedOwner, "PUT", `/hub/v1/exposures/${exposure.id}/intro`, { revision: 1, text: intro })).status === 200);
    return exposure;
  };
  const findable = await publish("Example release helper", "Tracks release decisions"), askable = await publish("Example docs helper", "Explains product documents");
  check("ordinary ask grant", (await r.call(signedOwner, "POST", "/hub/v1/grants", { exposureId: askable.id, exposureRevision: 1, login: "admin", days: 7 })).status === 200);
  browser = await pw.chromium.launch({ executablePath: process.env.CHROME, headless: true, env, args: ["--no-sandbox"] });
  const discoveryPath = `/hub/v1/exposures/${findable.id}/room-discovery`;
  for (const device of ["desk", "phone"]) for (const lang of ["en", "zh-TW"]) {
    const tag = device + "-" + lang, phone = device === "phone";
    r.db.prepare("UPDATE hub_exposures SET state='published',sharing_paused=0,sharing_epoch=sharing_epoch+1 WHERE id=?").run(findable.id);
    await r.call(signedOwner, "PUT", "/hub/v1/me/agent-request-settings", { accepting: true });
    const previous = await r.call(signedOwner, "GET", discoveryPath);
    check(tag + ": reset explicit owner choice", (await r.call(signedOwner, "PUT", discoveryPath, { findable: false, ifRevision: previous.json.revision, exposureRevision: 1 })).status === 200);
    const made = await r.call(manager, "POST", "/hub/v1/rooms", { name: lang === "en" ? "Example project" : "範例專案" });
    check(tag + ": real room", made.status === 200); const roomId = made.json.room.id;
    const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 900 }, isMobile: phone, hasTouch: phone,
      locale: lang === "en" ? "en-US" : "zh-TW", colorScheme: phone ? "dark" : "light", ignoreHTTPSErrors: true });
    await context.addInitScript({ content: `window.__name=fn=>fn;localStorage.setItem('agend_lang',${JSON.stringify(lang)});localStorage.setItem('agend_theme',${JSON.stringify(phone ? "dark" : "light")});localStorage.setItem('agend_tour_done','1');` });
    await context.route("**/*", (route: any) => { if (new URL(route.request().url()).origin !== origin) { foreign.push("blocked"); return route.abort(); } return route.continue(); });
    const page = await context.newPage(); page.setDefaultTimeout(15_000); page.on("pageerror", (e: Error) => errors.push(e.message));
    page.on("response", async (response: any) => { const path = new URL(response.url()).pathname;
      if (response.status() === 200 && /\.(js|css)$/.test(path)) try { assets.set(path, createHash("sha256").update(await response.body()).digest("hex")); } catch {} });
    const shot = async (name: string, target: any) => {
      if (pickerOnly && name !== "picker") return;
      await target.scrollIntoViewIfNeeded(); await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: join(out, tag + "-" + name + ".png") });
      check(tag + ": " + name + " no overflow", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    };
    const signIn = async (who: string, path: string) => {
      await context.clearCookies(); await page.goto(origin + path); await page.fill("#hubLogin", who); await page.fill("#hubPassword", "pw-" + who);
      await page.locator(".hub-signin button[type=submit]").click();
    };
    const control = page.locator(".hub-room-discovery-setting"), checkbox = control.locator('input[type="checkbox"]');
    try {
      if (!pickerOnly) {
      await signIn("example-owner", `/ui/hub/exposures?agent=${findable.id}`);
      await control.locator('input:enabled').waitFor(); check(tag + ": off by default", !await checkbox.isChecked()); await shot("shared-off", control);
      await checkbox.click(); await page.waitForFunction(() => { const input = document.querySelector('.hub-room-discovery-setting input') as HTMLInputElement | null; return input?.checked && !input.disabled; });
      check(tag + ": owner enabled through real API", (await r.call(signedOwner, "GET", discoveryPath)).json.findable === true); await shot("shared-on", control);
      r.db.prepare("UPDATE hub_exposures SET sharing_paused=1,sharing_epoch=sharing_epoch+1 WHERE id=?").run(findable.id);
      await page.reload(); await control.getByText(lang === "en" ? "Hidden while sharing is paused." : "暫停分享期間不會顯示。", { exact: true }).waitFor();
      check(tag + ": paused keeps saved choice", await checkbox.isChecked() && await checkbox.isDisabled()); await shot("paused", control);
      // A retained frozen publication is unshared but still has an owner access page. No freeze operation is claimed.
      r.db.prepare("UPDATE hub_exposures SET state='frozen',sharing_paused=0 WHERE id=?").run(findable.id);
      await page.reload(); await control.getByText(lang === "en" ? "Share this agent first." : "請先分享這個 Agent。", { exact: true }).waitFor();
      check(tag + ": unshared cannot change discovery", await checkbox.isDisabled()); await shot("not-shared", control);
      r.db.prepare("UPDATE hub_exposures SET state='published',sharing_epoch=sharing_epoch+1 WHERE id=?").run(findable.id);
      await r.call(signedOwner, "PUT", "/hub/v1/me/agent-request-settings", { accepting: false });
      await page.reload(); await control.getByText(lang === "en" ? 'Off while "Don\'t let room managers ask me for agents" is on.' : "已開啟「不要讓房間管理員請我加入 Agent」，所以目前無法使用。", { exact: true }).waitFor();
      check(tag + ": owner opt-out wins", await checkbox.isChecked() && await checkbox.isDisabled()); await shot("owner-disabled", control);
      await r.call(signedOwner, "PUT", "/hub/v1/me/agent-request-settings", { accepting: true });
      } else {
        const current = await r.call(signedOwner, "GET", discoveryPath);
        check(tag + ": prepare owner opt-in", (await r.call(signedOwner, "PUT", discoveryPath, { findable: true, ifRevision: current.json.revision, exposureRevision: 1 })).status === 200);
      }
      await signIn("admin", `/ui/hub?room=${roomId}`); await page.locator(".hub-room-rail-toggle").waitFor();
      if (!await page.locator(".hub-room-settings-link").isVisible()) await page.locator(".hub-room-rail-toggle").click();
      await page.locator(".hub-room-settings-link").click(); await page.locator("#hubRoomAddAgents").fill("Example");
      const action = page.getByRole("option", { name: lang === "en" ? "Ask Example owner to add Example release helper to this room" : "請 Example owner 把 Example release helper 加入這個房間", exact: true });
      await action.waitFor(); check(tag + ": askable and findable side by side", await page.locator('.hub-room-results [role="option"]').count() === 2);
      await shot("picker", page.locator(".hub-room-results")); await action.click();
      const waiting = page.locator("[data-invitation]"); await waiting.waitFor(); check(tag + ": existing waiting row names owner", (await waiting.textContent()).includes("Example owner")); await shot("invited", waiting);
      check(tag + ": no discovery grant", (r.db.prepare("SELECT COUNT(*) n FROM hub_grants WHERE exposure_id=?").get(findable.id) as any).n === 0);
      check(tag + ": waiting until owner consent", (r.db.prepare("SELECT COUNT(*) n FROM hub_room_members WHERE kind='agent' AND subject=?").get(findable.id) as any).n === 0);
      check(tag + ": no load alerts", await page.locator('[role="alert"]').count() === 0);
    } finally { await context.close(); }
  }
  check("no page errors", errors.length === 0); check("no foreign requests", foreign.length === 0);
  writeFileSync(join(out, "receipt.json"), JSON.stringify({ source: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), diffSha256: createHash("sha256").update(execFileSync("git", ["diff", "HEAD"])).digest("hex"), checks,
    servedAssets: [...assets].map(([path, sha256]) => ({ path, sha256 })), scope: "Owned HTTPS/SQLite/audit and shipped UI; inert directory and synthetic publication/Fleet metadata. Unshared disabled view uses a retained frozen exposure. No live account, CLI, model, Fleet process, Windows, operator trust change or external network." }, null, 2) + "\n");
  console.log(JSON.stringify({ passed: checks.length }));
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); await r?.close(); rmSync(scratch, { recursive: true, force: true });
}
