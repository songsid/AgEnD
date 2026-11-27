/** Owned HTTPS/SQLite production Hub HTTP/UI with synthetic people and inert Fleet publication only. */
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { s3bRig } from "../../../tests/helpers/hub-s3b-rig.js";
import { personKeyString } from "../../../src/hub/identity.js";
import { createOwnedPki } from "../hub-connector-4c/rig.mjs";
if (process.platform !== "linux" || !process.env.CHROME?.startsWith("/home/") || !process.env.PW_DIR || !process.env.CJK_FONT) throw Error("Pin Linux headless browser/package/font");
const out = resolve(process.env.OUT || ".artifacts/s258/browser"); mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(out, "owned-")), home = join(scratch, "home");
mkdirSync(join(home, ".local/share/fonts"), { recursive: true }); copyFileSync(process.env.CJK_FONT, join(home, ".local/share/fonts/Traditional.ttf"));
const pki = createOwnedPki(join(scratch, "pki")), pw = createRequire(join(resolve(process.env.PW_DIR), "package.json"))("playwright-core");
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share") };
for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "WSL_INTEROP"]) delete env[key];
let r: Awaited<ReturnType<typeof s3bRig>> | undefined, browser: any;
const checks: { key: string; ok: boolean }[] = [], errors: string[] = [], foreign: string[] = [];
const check = (key: string, ok: unknown) => { checks.push({ key, ok: !!ok }); if (!ok) throw Error(key); };
const server = createServer({ key: readFileSync(pki.key), cert: readFileSync(pki.cert) }, (req, res) => { if (!r?.http.handle(req, res)) { res.writeHead(404); res.end(); } });
try {
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  r = await s3bRig({ webOrigin: origin, realAudit: true });
  const owner = r.addPerson("example-member", "Example Member"), manager = await r.signIn("admin");
  const fleetId = randomUUID(), link = r.link(fleetId, owner, 1, ["welcome-caps-v1", "room-ask-v1"]);
  const exposure = { id: randomUUID(), fleetId, owner, displayName: "Example Helper", revision: 1, state: "published" as const, dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) };
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [exposure] }, link) as never, link);
  browser = await pw.chromium.launch({ executablePath: process.env.CHROME, headless: true, env, args: ["--no-sandbox"] });
  for (const device of ["desk", "phone"]) for (const lang of ["en", "zh-TW"]) {
    const tag = device + "-" + lang, phone = device === "phone";
    const made = await r.call(manager, "POST", "/hub/v1/rooms", { name: lang === "en" ? "Example project" : "範例專案", people: [personKeyString(owner)] });
    check(tag + ": real room", made.status === 200); const roomId = made.json.room.id;
    const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 900 }, isMobile: phone, hasTouch: phone, locale: lang === "en" ? "en-US" : "zh-TW", colorScheme: "dark", ignoreHTTPSErrors: true });
    await context.addInitScript({ content: `window.__name=fn=>fn;localStorage.setItem('agend_lang',${JSON.stringify(lang)});localStorage.setItem('agend_theme','dark');localStorage.setItem('agend_tour_done','1');` });
    await context.route("**/*", (route: any) => { if (new URL(route.request().url()).origin !== origin) { foreign.push("blocked"); return route.abort(); } return route.continue(); });
    const page = await context.newPage(); page.on("pageerror", (e: Error) => errors.push(e.message));
    const signIn = async (who: string) => {
      await context.clearCookies(); await page.goto(`${origin}/ui/hub?room=${roomId}`); await page.fill("#hubLogin", who); await page.fill("#hubPassword", "pw-" + who);
      await page.locator(".hub-signin button[type=submit]").click(); await page.locator(".hub-room-rail-toggle").waitFor();
    };
    const settle = async () => { await page.evaluate(async () => { await document.fonts.ready; await Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))); }); };
    const shot = async (name: string, target: any) => { await target.scrollIntoViewIfNeeded(); await settle(); await page.screenshot({ path: join(out, `${tag}-${name}.png`) }); check(tag + ": " + name + " no page overflow", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); };
    try {
      await signIn("admin"); if (!await page.locator(".hub-room-settings-link").isVisible()) await page.locator(".hub-room-rail-toggle").click();
      await page.locator(".hub-room-settings-link").click(); const toggle = page.locator("#hubRoomMemberAgents"); await toggle.waitFor();
      check(tag + ": opt-in defaults off", !await toggle.isChecked()); await shot("manager-off", toggle);
      await toggle.check(); await page.waitForFunction(() => { const e = document.querySelector('#hubRoomMemberAgents') as HTMLInputElement; return e?.checked && !e.disabled; });
      check(tag + ": real saved opt-in", (await r.call(manager, "GET", `/hub/v1/rooms/${roomId}`)).json.settings.membersCanAddOwnAgents === true); await shot("manager-on", toggle);
      await signIn("example-member"); if (!await page.locator(".hub-room-own-agents-link").isVisible()) await page.locator(".hub-room-rail-toggle").click();
      await page.locator(".hub-room-own-agents-link").click(); await page.locator("#hubRoomOwnAgents").fill("Example");
      const candidate = page.locator('[role="option"]'); await candidate.waitFor();
      check(tag + ": own shared candidate only", await candidate.count() === 1 && (await candidate.textContent()).includes("Example Helper")); await shot("member-picker", candidate);
      await candidate.click(); await page.locator("#hubRoomOwnAgents").waitFor({ state: "detached" });
      const detail = await r.call(manager, "GET", `/hub/v1/rooms/${roomId}`);
      check(tag + ": real membership persisted", detail.json.members.some((m: any) => m.id === exposure.id));
      const row = page.locator('.hub-member-agent .hub-member-open').filter({ hasText: "Example Helper" }); await row.waitFor(); await shot("member-added", row);
      check(tag + ": manager removes member-added agent", (await r.call(manager, "DELETE", `/hub/v1/rooms/${roomId}/members/${exposure.id}`)).status === 200);
      check(tag + ": audit retained", (r.db.prepare("SELECT COUNT(*) n FROM hub_audit WHERE action='room.agent-added' AND room_id=?").get(roomId) as { n: number }).n === 1);
    } finally { await context.close(); }
  }
  check("no page errors", errors.length === 0); check("no foreign requests", foreign.length === 0);
  writeFileSync(join(out, "receipt.json"), JSON.stringify({ source: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), diffSha256: createHash("sha256").update(execFileSync("git", ["diff", "HEAD"])).digest("hex"), browser: browser.version(), checks, scope: "Real shipped HTTP/UI/SQLite/audit with inert synthetic people and Fleet publication. Dark Chromium desktop and phone emulation; no real AD, live Fleet, provider, native phone or OS-keyboard claim." }, null, 2) + "\n");
  console.log(JSON.stringify({ passed: checks.length }));
} finally { await browser?.close(); server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); await r?.close(); rmSync(scratch, { recursive: true, force: true }); }
