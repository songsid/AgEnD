/** Owner response: real owned HTTPS/SQLite/encrypted audit plus shipped UI. No account, Fleet process or model. */
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { s3bRig } from "../../../tests/helpers/hub-s3b-rig.js";
import { createHubRoomInvitations, HUB_ROOM_INVITATIONS_MIGRATION } from "../../../src/hub/invitations.js";
import { createHubRoomAgentRequests } from "../../../src/hub/room-agent-requests.js";
import { personKeyString } from "../../../src/hub/identity.js";
import { createOwnedPki } from "../hub-connector-4c/rig.mjs";
if (process.platform !== "linux" || !process.env.CHROME?.startsWith("/home/") || process.env.CHROME.includes("/mnt/")) throw Error("Use Linux headless Chromium only");
if (!process.env.CJK_FONT || !process.env.PW_DIR) throw Error("Pin the browser package and a Traditional Chinese font");
const out = resolve(process.env.OUT || ".artifacts/m3341/owner-browser"); mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(out, "owned-")), home = join(scratch, "home");
mkdirSync(join(home, ".local/share/fonts"), { recursive: true, mode: 0o700 });
copyFileSync(process.env.CJK_FONT, join(home, ".local/share/fonts/NotoSansCJKtc-Regular.otf"));
const pki = createOwnedPki(join(scratch, "pki"));
const pw = createRequire(join(resolve(process.env.PW_DIR), "package.json"))("playwright-core");
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share") };
for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "WSL_INTEROP"]) delete env[key];
let now = Date.now(), r: Awaited<ReturnType<typeof s3bRig>> | undefined, browser: any;
const checks: { key: string; ok: boolean }[] = [], errors: string[] = [], foreign: string[] = [];
const assets = new Map<string, string>();
const check = (key: string, ok: unknown) => { checks.push({ key, ok: !!ok }); if (!ok) throw Error(key); };
const server = createServer({ key: readFileSync(pki.key), cert: readFileSync(pki.cert) }, (req, res) => {
  if (!r?.http.handle(req, res)) { res.writeHead(404); res.end(); }
});
try {
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  r = await s3bRig({ webOrigin: origin, realAudit: true, now: () => now });
  const owner = r.addPerson("example-owner", "Example owner");
  r.addPerson("example-empty", "Example colleague");
  HUB_ROOM_INVITATIONS_MIGRATION.up(r.db);
  r.httpDeps.roomInvitations = (core, host) => createHubRoomInvitations(core, host);
  r.httpDeps.roomAgentRequests = (core, host) => createHubRoomAgentRequests(core, host);
  await r.restartHttp();
  const publish = async (name: string) => {
    const id = randomUUID();
    r!.store.mutate({ requestId: randomUUID(), at: now, actor: { kind: "local-host" }, action: "fixture", result: "completed" }, state => {
      state.fleets.push({ id, owner, generation: 1, credentialHash: "a".repeat(64), status: "active", label: name });
    });
    const link = r!.link(id, owner), exposure = { id: randomUUID(), fleetId: link.fleetId, owner,
      displayName: name, revision: 1, state: "published" as const, dataViewId: "example", allowedTools: [], policyDigest: "c".repeat(64) };
    await r!.http.receive(r!.frame("exposure.snapshot", { revision: 1, exposures: [exposure] }, link) as never, link);
    return exposure;
  };
  const first = await publish("Release helper"), second = await publish("Docs helper"), draft = await publish("Scratch helper");
  const ownerSession = await r.signIn("example-owner");
  for (const [agent, text] of [[first, "Explains release notes"], [second, "Knows the product documents"]] as const) {
    const intro = await r.call(ownerSession, "PUT", `/hub/v1/exposures/${agent.id}/intro`, { revision: 1, text });
    check("real owner introduction saved", intro.status === 200);
  }
  browser = await pw.chromium.launch({ executablePath: process.env.CHROME, headless: true, env, args: ["--no-sandbox"] });
  for (const device of ["desk", "phone"]) for (const lang of ["en", "zh-TW"]) {
    now += 86_400_000;
    r.db.prepare("UPDATE hub_exposures SET state='withdrawn'").run();
    r.db.prepare("UPDATE hub_exposures SET state='published' WHERE id=?").run(first.id);
    const manager = await r.signIn("admin"), tag = device + "-" + lang, phone = device === "phone";
    const made = await r.call(manager, "POST", "/hub/v1/rooms", { name: lang === "en" ? "Example project" : "範例專案" });
    check(tag + ": real room", made.status === 200); const roomId = made.json.room.id;
    const sent = await r.call(manager, "POST", `/hub/v1/rooms/${roomId}/agent-requests`, {
      owner: personKeyString(owner), note: lang === "en" ? "The agent that explains release notes" : "協助說明版本更新的 Agent", idempotencyKey: randomUUID(),
    });
    check(tag + ": real request", sent.status === 200); const requestId = sent.json.request.id;
    const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 900 },
      isMobile: phone, hasTouch: phone, locale: lang === "en" ? "en-US" : "zh-TW", colorScheme: phone ? "dark" : "light", ignoreHTTPSErrors: true });
    await context.addInitScript({ content: `window.__name=fn=>fn;localStorage.setItem('agend_lang',${JSON.stringify(lang)});localStorage.setItem('agend_theme',${JSON.stringify(phone ? "dark" : "light")});localStorage.setItem('agend_tour_done','1');` });
    await context.route("**/*", (route: any) => { if (new URL(route.request().url()).origin !== origin) { foreign.push("blocked"); return route.abort(); } return route.continue(); });
    const page = await context.newPage(); page.setDefaultTimeout(15_000);
    page.on("pageerror", (e: Error) => errors.push(e.message));
    page.on("response", async (response: any) => { const path = new URL(response.url()).pathname;
      if (response.status() === 200 && /\.(js|css)$/.test(path)) try { assets.set(path, createHash("sha256").update(await response.body()).digest("hex")); } catch {} });
    const card = page.locator("[data-owner-request-card]");
    const shot = async (name: string, target = card) => {
      await target.scrollIntoViewIfNeeded(); await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(out, tag + "-" + name + ".png") });
      check(tag + ": " + name + " no overflow", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    };
    try {
      await page.goto(origin + "/ui/hub?view=invitations");
      await page.fill("#hubLogin", "example-owner"); await page.fill("#hubPassword", "pw-example-owner");
      await page.locator(".hub-signin button[type=submit]").click();
      await card.locator('input[type="radio"]').first().waitFor();
      check(tag + ": single preselected", await card.locator('input[type="radio"]:checked').count() === 1);
      check(tag + ": draft disabled", await card.locator('input[type="radio"]:disabled').count() === 2);
      await shot("single");
      r.db.prepare("UPDATE hub_exposures SET state='published' WHERE id=?").run(second.id);
      await page.reload(); await card.locator('input[type="radio"]').first().waitFor();
      const add = card.getByRole("button", { name: lang === "en" ? "Add to this room" : "加入這個房間", exact: true });
      check(tag + ": multiple require choice", await card.locator('input[type="radio"]:checked').count() === 0 && await add.isDisabled());
      await shot("multiple");
      r.db.prepare("UPDATE hub_exposures SET state='withdrawn'").run();
      await page.reload(); await card.locator('input[type="radio"]').first().waitFor();
      check(tag + ": no shared cannot add", await card.locator('input[type="radio"]:enabled').count() === 0 && await add.count() === 0);
      await shot("not-shared");
      r.db.prepare("UPDATE hub_exposures SET state='published' WHERE id=?").run(first.id);
      await page.reload(); await card.locator('input[type="radio"]:checked').waitFor();
      if (lang === "en") {
        await card.getByRole("button", { name: "Add to this room", exact: true }).click();
        await card.waitFor({ state: "detached" });
        check(tag + ": accepted once", (r.db.prepare("SELECT state FROM hub_room_agent_requests WHERE id=?").get(requestId) as any).state === "accepted");
        check(tag + ": room member only", (r.db.prepare("SELECT COUNT(*) n FROM hub_room_members WHERE room_id=? AND kind='agent'").get(roomId) as any).n === 1);
      } else {
        await card.getByRole("button", { name: "不加入", exact: true }).click();
        await card.waitFor({ state: "detached" });
        check(tag + ": private decline", (r.db.prepare("SELECT state FROM hub_room_agent_requests WHERE id=?").get(requestId) as any).state === "declined");
      }
      await page.goto(origin + "/ui/hub/exposures");
      const setting = page.locator(".hub-owner-request-setting");
      await setting.locator('input[type="checkbox"]:enabled').waitFor();
      await shot("setting", setting);
      await setting.locator('input[type="checkbox"]').click();
      await page.waitForFunction(() => { const input = document.querySelector('.hub-owner-request-setting input') as HTMLInputElement | null; return input?.checked && !input.disabled; });
      check(tag + ": opt-out saved", (r.db.prepare("SELECT accepting FROM hub_room_agent_request_settings WHERE owner=?").get(personKeyString(owner)) as any)?.accepting === 0);
      await r.call(await r.signIn("example-owner"), "PUT", "/hub/v1/me/agent-request-settings", { accepting: true });
      check(tag + ": no direct grants", (r.db.prepare("SELECT COUNT(*) n FROM hub_grants").get() as any).n === 0);
      check(tag + ": no load alerts", await page.locator('[role="alert"]').count() === 0);
      await context.clearCookies(); await page.goto(origin + "/ui/hub/exposures");
      await page.fill("#hubLogin", "example-empty"); await page.fill("#hubPassword", "pw-example-empty");
      await page.locator(".hub-signin button[type=submit]").click();
      const empty = page.getByText(lang === "en" ? "You don't have an agent on this Hub yet." : "你在這個 Hub 還沒有自己的 Agent。", { exact: true });
      await empty.waitFor();
      check(tag + ": no opt-out without a Hub agent", await setting.count() === 0);
      await shot("no-agent", empty);
    } finally { await context.close(); }
  }
  check("no page errors", errors.length === 0); check("no foreign requests", foreign.length === 0);
  writeFileSync(join(out, "receipt.json"), JSON.stringify({ source: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    diffSha256: createHash("sha256").update(execFileSync("git", ["diff", "HEAD"])).digest("hex"), checks,
    servedAssets: [...assets].map(([path, sha256]) => ({ path, sha256 })),
    scope: "Real owned HTTPS/SQLite/encrypted audit with shipped UI; inert directory and synthetic publication frames. No Fleet process, live account, CLI, model, Windows or external network. TLS trust limited to disposable browser context." }, null, 2) + "\n");
  console.log(JSON.stringify({ passed: checks.length }));
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); await r?.close();
  rmSync(scratch, { recursive: true, force: true });
}
