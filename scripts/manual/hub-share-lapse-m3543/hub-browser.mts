/**
 * M-3543: the Hub's My shared agents with a LAPSED shared agent — "Needs re-share" and Share again — on the actual owned
 * Hub HTTPS/SQLite with the shipped UI; the member side is synthetic frames (catalog with the lapse, the republish result).
 * No Fleet process, CLI, model, account or external network. Before = the same flow on a checkout without the change.
 *
 *   CHROME=<linux chromium> CJK_FONT=<zh-TW font> PW_DIR=<dir with playwright-core> OUT=<dir> STAGE=before|after \
 *     npx tsx scripts/manual/hub-share-lapse-m3543/hub-browser.mts
 */
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { s3bRig } from "../../../tests/helpers/hub-s3b-rig.js";
import { personKeyString } from "../../../src/hub/identity.js";
import { createOwnedPki } from "../hub-connector-4c/rig.mjs";
import { createHubRoomInvitations, HUB_ROOM_INVITATIONS_MIGRATION } from "../../../src/hub/invitations.js";

if (process.platform !== "linux" || !process.env.CHROME?.startsWith("/home/") || process.env.CHROME.includes("/mnt/")) throw Error("Pin a Linux headless browser");
if (!process.env.CJK_FONT) throw Error("Supply a Traditional Chinese font");
const out = resolve(process.env.OUT || ".artifacts/m3543"), stage = process.env.STAGE === "before" ? "before" : "after";
mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(out, "owned-")), home = join(scratch, "home");
mkdirSync(join(home, ".local/share/fonts"), { recursive: true }); copyFileSync(process.env.CJK_FONT, join(home, ".local/share/fonts/NotoSansCJKtc-Regular.otf"));
const pki = createOwnedPki(join(scratch, "pki"));
const pw = createRequire(join(resolve(process.env.PW_DIR!), "package.json"))("playwright-core");
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share") };
for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "WSL_INTEROP"]) delete env[key];
let r: Awaited<ReturnType<typeof s3bRig>> | undefined, browser: any;
const checks: { key: string; ok: boolean }[] = [], errors: string[] = [], foreign: string[] = [];
const check = (key: string, ok: unknown) => { checks.push({ key, ok: !!ok }); if (!ok) throw Error(key); };
const server = createServer({ key: readFileSync(pki.key), cert: readFileSync(pki.cert) }, (req, res) => { if (!r?.http.handle(req, res)) { res.writeHead(404); res.end(); } });
let now = 1_800_000_000_000;
try {
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  r = await s3bRig({ webOrigin: origin, realAudit: true, now: () => now });
  const owner = r.addPerson("example-owner", "Example owner"), reader = r.addPerson("example-reader", "Example colleague");
  // The page also reads room invitations; mount the real service as the owner-request captures do (else a load banner).
  HUB_ROOM_INVITATIONS_MIGRATION.up(r.db); r.httpDeps.roomInvitations = (core, host) => createHubRoomInvitations(core, host); await r.restartHttp();
  const fleetId = randomUUID();
  r.store.mutate({ requestId: randomUUID(), at: now, actor: { kind: "local-host" }, action: "fixture", result: "completed" }, state => {
    state.fleets.push({ id: fleetId, owner, generation: 1, credentialHash: "a".repeat(64), status: "active", label: "Work laptop" });
  });
  const link = r.link(fleetId, owner, 1, ["welcome-caps-v1", "room-ask-v1", "agent-catalog-v1", "exposure-request-v1", ...(stage === "after" ? ["agent-catalog-lapse-v1"] : [])]);
  r.http.memberConnected!(link);
  const exposureId = randomUUID();
  const exposure = (revision: number) => ({ id: exposureId, fleetId, owner, displayName: "Mira", revision, state: "published" as const, dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) });
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [exposure(1)] }, link) as never, link);
  let n = 0;
  const catalog = async (revision: number, lapsed: boolean) => {
    const body = { enabled: true, requests: true, revision: String(++n).padStart(64, "0"), agents: [
      { instance: "mira", displayName: "Mira", description: "Answers questions about the team's documents", avatar: null, kind: "agent", general: false, shareable: true,
        exposure: { id: exposureId, revision, state: "published", ...(lapsed ? { lapsed: true } : {}) } },
      { instance: "notes", displayName: "Notes", description: "Keeps meeting notes", avatar: null, kind: "agent", general: false, shareable: true, exposure: null }] };
    await r!.http.receive(r!.frame("agent.catalog", body, link) as never, link); return body;
  };
  // One colleague may ask Mira (a direct grant), so the page says who may ask it — and it must still say so after Share again.
  r.db.prepare(`INSERT INTO hub_grants(id,revision,owner,exposure_id,exposure_revision,approved_by,approved_at,subject,permissions,starts_at,expires_at,state,subject_kind,subject_label)
    VALUES(?,1,?,?,1,?,?,?,'["ask"]',?,?,'active','person','Example colleague')`).run(randomUUID(), personKeyString(owner), exposureId, personKeyString(owner), now, personKeyString(reader), now - 1, now + 30 * 86_400_000);
  await catalog(1, stage === "after");
  browser = await pw.chromium.launch({ executablePath: process.env.CHROME, headless: true, env, args: ["--no-sandbox"] });
  for (const [device, lang] of [["phone", "zh-TW"], ["desk", "en"]] as const) {   // the en case clicks Share again: last
    const phone = device === "phone", tag = `${stage}-${device}-${lang}`;
    const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 900 }, isMobile: phone, hasTouch: phone,
      locale: lang === "en" ? "en-US" : "zh-TW", colorScheme: phone ? "dark" : "light", ignoreHTTPSErrors: true });
    await context.addInitScript({ content: `window.__name=fn=>fn;localStorage.setItem('agend_lang',${JSON.stringify(lang)});localStorage.setItem('agend_theme',${JSON.stringify(phone ? "dark" : "light")});localStorage.setItem('agend_tour_done','1');` });
    await context.route("**/*", (route: any) => { if (new URL(route.request().url()).origin !== origin) { foreign.push("blocked"); return route.abort(); } return route.continue(); });
    const page = await context.newPage(); page.setDefaultTimeout(15_000); page.on("pageerror", (e: Error) => errors.push(e.message));
    try {
      await page.goto(origin + "/ui/hub/exposures");
      await page.fill("#hubLogin", "example-owner"); await page.fill("#hubPassword", "pw-example-owner");
      await page.locator(".hub-signin button[type=submit]").click();
      await page.locator("[data-my-agents]").waitFor(); await page.waitForTimeout(800); await page.evaluate(() => document.fonts.ready);
      const again = page.locator('[data-share-again="mira"]');
      if (stage === "after") check(tag + ": Share again shown", await again.count() === 1); else check(tag + ": no Share again before", await again.count() === 0);
      await page.locator('[data-share-agent="mira"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(out, tag + "-lapsed.png") });
      check(tag + ": no overflow", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (stage === "after" && lang === "en") {
        await again.click(); await page.waitForTimeout(600);
        const row = r.db.prepare("SELECT id, body FROM hub_sharing_requests ORDER BY created_at DESC LIMIT 1").get() as { id: string; body: string } | undefined;
        check(tag + ": one share request for mira", !!row && JSON.parse(row.body).share.join() === "mira");
        // The Fleet answers with the republish (same id, next revision); its next snapshot and catalog follow.
        await r.http.receive({ ...r.frame("exposure.request-result", { noticeAt: now, undoUntil: now + 86_400_000,
          results: [{ instance: "mira", ok: true, before: { id: exposureId, revision: 1, state: "published" }, after: { id: exposureId, revision: 2, state: "published" } }] }, link), requestId: row!.id } as never, link);
        await r.http.receive(r.frame("exposure.snapshot", { revision: 2, exposures: [exposure(2)] }, link) as never, link);
        await catalog(2, false);
        const carried = r.db.prepare("SELECT exposure_revision FROM hub_grants WHERE exposure_id=? AND state='active'").get(exposureId) as { exposure_revision: number };
        check(tag + ": grant carried to revision 2", carried.exposure_revision === 2);
        await page.reload(); await page.locator("[data-my-agents]").waitFor(); await page.waitForTimeout(800);
        // The page offers "who may ask it" right after a share; the people kept are the point here, so close it.
        for (let i = 0; i < 4 && await page.locator("dialog[open] .dlg-x").count(); i++) { await page.locator("dialog[open] .dlg-x").last().click(); await page.waitForTimeout(300); }
        check(tag + ": no dialog over the page", await page.locator("dialog[open]").count() === 0);
        check(tag + ": still 1 person may ask", (await page.locator("[data-my-agents]").innerText()).includes("1 person may ask"));
        check(tag + ": no Share again after", await page.locator('[data-share-again="mira"]').count() === 0);
        await page.screenshot({ path: join(out, tag + "-shared-again.png") });
      }
    } finally { await context.close(); }
  }
  check("no page errors", errors.length === 0); check("no foreign requests", foreign.length === 0);
  writeFileSync(join(out, `receipt-${stage}.json`), JSON.stringify({ checks, errors }, null, 1));
  console.log(JSON.stringify({ stage, passed: checks.length }));
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); await r?.close();
  rmSync(scratch, { recursive: true, force: true });
}
