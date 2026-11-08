/** S-90: sealed Hub HTTPS/WSS + production AD driver on recorded loopback LDAPS + real fleet Settings web server.
 * No daemon, CLI, account, model, live fleet or tmux. The fleet fixture attaches the production pairing API and a
 * pinned member client with empty exposure inventory. Browser performs both fingerprint confirmations and local Apply.
 * REPO=$PWD OUT=<PNG dir> PW_DIR=<playwright-core directory> CHROME=<audited Chromium> npx tsx <this file>
 * MODE=before retains the pre-S90 UI modules; SKEW=1 retains old CSS/client on the current server.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import yaml from "js-yaml";
import { bootFixture, matrix, caseName } from "../smoke-fixture/index.mts";
import { directoryCertificates } from "../../../tests/support/hub-directory-ca-fixture.js";
import { groupWirePeer, GROUP_A, GROUP_DN } from "../../../tests/support/hub-group-directory-wire.js";
import { createHubDirectory } from "../../../src/hub/directory/directory.js";
import { createHubInitializer } from "../../../src/hub/init/initializer.js";
import { hubIdentityProvider } from "../../../src/hub/init/identity.js";
import { createBrowserCertificate } from "../../../src/hub/init/browser-certificate.js";
import { createHubServerFactory } from "../../../src/hub/compose/server.js";
import { S3B_HTTP_ENTRY } from "../../../src/hub/runtime.js";
import { freeHubPort } from "../../../tests/helpers/hub-rig.js";
import { createHubMemberPairingApi } from "../../../src/hub/member/pairing-api.js";
import { HubMemberClient } from "../../../src/hub/client.js";
import { HubMemberProfileStore } from "../../../src/hub/profile.js";
import { createHubPairingNoticeInbox, HUB_PAIRING_INBOX_MIGRATION } from "../../../src/hub/member/pairing-notices.js";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../../../src/hub/audit/index.js";

const repo = process.env.REPO!, out = process.env.OUT!, mode = process.env.MODE ?? "current", skew = process.env.SKEW === "1";
if (!repo || !out) throw Error("REPO and OUT required");
mkdirSync(out, { recursive: true }); const art = join(repo, ".artifacts/quick-pairing"); mkdirSync(art, { recursive: true });
const scratch = mkdtempSync(join(art, "browser-")); chmodSync(scratch, 0o700);
const scratchHome = join(scratch, "home"), bin = join(scratch, "bin");
for (const dir of [scratchHome, bin, join(scratchHome, ".codex"), join(scratchHome, ".claude"), join(scratchHome, "tmux")]) mkdirSync(dir, { mode: 0o700 });
Object.assign(process.env, { HOME: scratchHome, CODEX_HOME: join(scratchHome, ".codex"), CLAUDE_CONFIG_DIR: join(scratchHome, ".claude"), TMUX_TMPDIR: join(scratchHome, "tmux") });
for (const key of ["TMUX", "DISCORD_BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GROK_API_KEY"]) delete process.env[key];
for (const name of ["tmux", "agend", "claude", "codex", "kiro-cli"]) { const path = join(bin, name); writeFileSync(path, `#!${process.execPath}\nprocess.exit(97)\n`); chmodSync(path, 0o700); }
process.env.AGEND_TMUX_BIN = join(bin, "tmux"); process.env.PATH = bin + ":" + process.env.PATH;
const home = join(scratch, "hub"); mkdirSync(home, { mode: 0o700 });
const cases = matrix(process.env.MATRIX ?? "full"), users = ["admin", ...Array.from({ length: cases.length }, (_, i) => `owner${i}`)].map(login => ({
  id: randomUUID(), login, dn: `CN=${login},DC=example,DC=test`, password: `Dummy-${login}-only`, groups: [GROUP_A],
}));
const certs = directoryCertificates(), peer = await groupWirePeer(certs.leaf, users);
// Same connector-only seam as hub-group-directory-wire.test.ts: policy still requests DC636, TLS/BER use our owned
// ephemeral peer. Never touch/bind/contact a possibly occupied host636, and never change the TLS verification options.
const originalConnect = tls.connect, requestedPorts: number[] = [];
tls.connect = ((options: any, ...args: any[]) => {
  if (options?.host === "127.0.0.1" && options.port === 636) { requestedPorts.push(options.port); return originalConnect({ ...options, port: peer.port }, ...args); }
  return originalConnect(options, ...args);
}) as typeof tls.connect; syncBuiltinESMExports();
const directoryConfig = { realm: "example", url: "ldaps://127.0.0.1:636", profile: "ad", caPem: certs.ca,
  baseDn: "DC=example,DC=test", bindDn: "CN=Reader,DC=example,DC=test", timeoutMs: 1000 };
const directory = createHubDirectory(directoryConfig, { bindPassword: "Dummy-service-only" });
const webPort = await freeHubPort(); let memberPort = await freeHubPort(); while (memberPort === webPort) memberPort = await freeHubPort();
const origin = `https://127.0.0.1:${webPort}`, memberOrigin = `https://127.0.0.1:${memberPort}`;
const material = await createBrowserCertificate(home, origin);
const plan = { name: "Example Team Hub", webOrigin: origin, memberOrigin, webListen: { host: "127.0.0.1", port: webPort }, memberListen: { host: "127.0.0.1", port: memberPort },
  webTls: { certFile: material.certFile, keyFile: material.keyFile }, directory: directoryConfig, bindPasswordRef: "file:hub/secrets/directory-bind",
  administrator: { realm: "example", objectId: users[0].id }, retention: { contentDays: 7, eventDays: 30 }, coexistence: "dedicated" as const };
const init = createHubInitializer({ home, identity: hubIdentityProvider(), probe: { pidAlive: () => false } });
const confirmation = await init.prepareConfirmation(plan, { bindPassword: "Dummy-service-only" }); await init.commit(plan, confirmation.reference);
const cfg = (yaml.load(readFileSync(join(home, "fleet.yaml"), "utf8")) as any).hub;
const service = await createHubServerFactory({ home, components: { http: S3B_HTTP_ENTRY }, createDirectory: () => directory, report: () => {}, log: () => {} })(cfg, () => true);
await service.start();
const fmPort = await freeHubPort(); const fx = await bootFixture({ port: fmPort, instances: 1, classic: false });
fx.fm.saveFleetConfig([{ path: ["hub_member", "enabled"], value: true }]);
const receipt: any = { mode, skew, source: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  browser: fx.browser.version(), boundary: "Real sealed Hub HTTPS/WSS, production AD driver over recorded fake LDAPS (only connector redirects requested636 to owned ephemeral port, TLS verification unchanged), fleet web server/Settings confirmation/pairing API, empty pinned member inventory. No daemon/native/CLI/model/live account or tmux.", checks: [], shots: [], errors: [], csp: [], foreign: [], api: [] };
const check = (name: string, ok: unknown) => { receipt.checks.push({ name, ok: !!ok }); if (!ok) throw Error(name); };
const oldRef = process.env.OLD_REF ?? "7ab23b6c6", old = (file: string) => execFileSync("git", ["-C", repo, "show", `${oldRef}:src/ui/${file}`], { encoding: "utf8", maxBuffer: 16 << 20 });
let api: ReturnType<typeof createHubMemberPairingApi> | undefined, member: HubMemberClient | undefined, inboxDb: Database.Database | undefined, online = false, memberLive = true;
const contexts: any[] = [];
const shot = async (p: any, name: string) => { await p.screenshot({ path: join(out, name + ".png"), fullPage: true }); receipt.shots.push(name + ".png"); };
async function context(c: any, oldClient = false) {
  const ctx = await fx.browser.newContext({ viewport: c.device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 900 },
    isMobile: c.device === "phone", hasTouch: c.device === "phone", locale: c.lang === "en" ? "en-US" : "zh-TW", colorScheme: c.theme, ignoreHTTPSErrors: true }); contexts.push(ctx);
  await ctx.addInitScript({ content: `window.__name=fn=>fn;try{localStorage.setItem('agend_lang',${JSON.stringify(c.lang)});localStorage.setItem('agend_theme',${JSON.stringify(c.theme)});localStorage.setItem('agend_tour_done','1');localStorage.setItem('agend_firstrun_dismissed','1')}catch{};window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective));` });
  await ctx.route("**/*", (r: any) => {
    const u = new URL(r.request().url()); if (![origin, fx.base].includes(u.origin)) { receipt.foreign.push(u.origin); return r.abort(); }
    let retained: string | null = null;
    if (mode === "before" && ["/ui/js/panel-hub.js", "/ui/js/hub-welcome.js", "/ui/js/hub-client.js"].includes(u.pathname)) retained = u.pathname.slice(7);
    if (oldClient && u.pathname === "/ui/js/hub-client.js") retained = "hub-client.js";
    if (skew && ["/assets/app.css", "/assets/hub.css", "/assets/hub-owner.css", "/assets/hub-groups.css", "/assets/app-shell.js"].includes(u.pathname)) retained = "shared/" + u.pathname.slice(8);
    if (retained) { receipt.skewHits = (receipt.skewHits ?? 0) + 1; return r.fulfill({ contentType: retained.endsWith(".css") ? "text/css" : "text/javascript", body: old(retained) }); }
    return r.continue();
  });
  const p = await ctx.newPage(); p.on("pageerror", (e: Error) => receipt.errors.push(String(e))); p.on("response", (r: any) => {
    if (/quick-pairing|\/revoke$|\/pairing\/(connect|confirm)|\/notices/.test(r.url())) receipt.api.push({ path: new URL(r.url()).pathname, status: r.status(), method: r.request().method() });
  }); return { ctx, p };
}
async function signIn(p: any, login: string, path = "/ui/hub") { await p.goto(origin + path); await p.fill("#hubLogin", login); await p.fill("#hubPassword", `Dummy-${login}-only`); await p.locator(".hub-signin button[type=submit]").click(); }
async function geometry(p: any, name: string) { check(name + " no horizontal overflow", await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); receipt.csp.push(...await p.evaluate("window.__csp")); }
async function apply(p: any, next: string) {
  await p.waitForFunction((selector: string) => document.querySelector(".pending-self .btn-primary") || document.querySelector(selector), next);
  if (await p.locator(".pending-self .btn-primary").count()) { await p.locator(".pending-self .btn-primary").last().click(); receipt.localApplyClicks = (receipt.localApplyClicks ?? 0) + 1; }
  await p.locator(next).first().waitFor();
}
async function attachMember(index: number) {
  memberLive = false; await member?.close(); member = undefined; inboxDb?.close(); inboxDb = undefined; online = false; memberLive = true;
  const mh = join(scratch, `member-${index}`); mkdirSync(mh, { mode: 0o700 });
  api = createHubMemberPairingApi({ home: mh, enabled: () => memberLive, link: () => online ? "online" : "offline", pollMs: 250,
    notices: () => fx.fm.hubPairingNotices?.() ?? [], bindingChanged: () => {
      if (api?.view().state !== "paired" || member) return;
      const hubId = api.boundHub()!.hubId; inboxDb = new Database(join(mh, "notice-test.sqlite"));
      HUB_AUDIT_MIGRATION.up(inboxDb); HUB_PAIRING_INBOX_MIGRATION.up(inboxDb);
      const audit = createHubAudit({ db: inboxDb, contentKey: randomBytes(32) }), inbox = createHubPairingNoticeInbox({ db: inboxDb, audit, current: () => memberLive, now: Date.now });
      fx.fm.hubPairingNotices = () => inbox.list();
      member = new HubMemberClient({ home: mh, hubId, memberOrigin, current: () => memberLive, hold: () => { online = false; },
        reconcile: async l => { await l.send({ v: 1, type: "exposure.snapshot", requestId: randomUUID(), linkEpoch: l.linkEpoch, payload: { revision: 1, exposures: [] } });
          await l.exchange({ v: 1, type: "reconcile", requestId: randomUUID(), linkEpoch: l.linkEpoch, payload: { afterReceiptSequence: 0, messages: [] } }, "reconcile"); online = true; },
        receive: async (f, l) => { if (f.type === "pairing.notice") await inbox.receive(f.payload, l); } });
      void member.start().catch(e => receipt.errors.push(String(e)));
    } }); fx.fm.attachHubMemberPairing(api); return mh;
}
try {
  const admin = await context(cases[0]); await signIn(admin.p, "admin", "/ui/hub/admin?view=groups");
  await admin.p.locator(".hub-step-form input").fill(GROUP_DN); await admin.p.locator(".hub-step-form button").click();
  await admin.p.locator(".hub-group-row").waitFor();
  for (let i = 0; i < 3; i++) await admin.p.locator(".hub-group-row input[type=checkbox]").nth(i).check();
  await admin.p.locator(".hub-group-row input[type=number]").fill("8"); await admin.p.locator(".hub-groups-state button").click();
  await admin.p.locator(".hub-groups-preview .btn-primary").click(); await admin.p.locator(".hub-groups-preview").waitFor({ state: "detached" });
  for (const [i, c] of cases.entries()) {
    const tag = `${mode}${skew ? "-skew" : ""}-${caseName(c)}`, owner = users[i + 1], a = await context(c);
    try {
      await signIn(a.p, owner.login); await a.p.locator(".hub-welcome-card").first().waitFor();
      if (mode === "before") { check(tag + " manual guidance", await a.p.locator("[data-quick-pairing]").count() === 0); await shot(a.p, tag + "-welcome"); await geometry(a.p, tag); continue; }
      await a.p.fill("#quickFleetLabel", c.lang === "en" ? "My research laptop" : "我的研究筆電"); await a.p.locator("[data-quick-pairing] form button[type=submit]").click();
      await a.p.locator("[data-quick-pairing] .hub-fp-groups").waitFor();
      const code = (await a.p.locator("[data-quick-pairing] .hub-fp-groups").first().innerText()).trim(); check(tag + " one-time code", /^[a-f0-9]{12}$/.test(code));
      await shot(a.p, tag + "-code");
      const other = await context(c); await signIn(other.p, owner.login);
      const mh = await attachMember(i), local = await context(c);
      const issued = await (await fetch(fx.base + "/auth/issue-code", { method: "POST", headers: { "X-Agend-Token": fx.fm.webToken } })).json() as any;
      await local.p.goto(fx.base + "/signin"); await local.p.fill("#code", issued.code); await local.p.click("#go"); await local.p.waitForURL(fx.base + "/ui");
      await local.p.goto(fx.base + "/settings/hub"); await local.p.fill("#hubAddress", memberOrigin); await local.p.fill("#hubCode", code);
      await local.p.locator("#hub-connect form button[type=submit]").click(); await apply(local.p, ".hub-local-confirm");
      await a.p.getByRole("button", { name: c.lang === "en" ? "They match" : "指紋相符", exact: true }).waitFor();
      const shown = (await a.p.locator("[data-quick-pairing] .hub-fp-groups").last().innerText()).replace(/\s/g, ""), localShown = (await local.p.locator(".hub-pending .hub-fp-groups").innerText()).replace(/\s/g, "");
      check(tag + " exact same fingerprint", shown === localShown && shown.length === 32); await shot(a.p, tag + "-fingerprint"); await shot(local.p, tag + "-local-confirmation");
      await local.p.locator(".hub-local-confirm").click(); await apply(local.p, ".hub-local-confirmed, .hub-paired");
      await a.p.getByRole("button", { name: c.lang === "en" ? "They match" : "指紋相符", exact: true }).click();
      await a.p.getByText(c.lang === "en" ? "Connected" : "已連接", { exact: true }).waitFor({ timeout: 20000 });
      const profile = new HubMemberProfileStore(mh, api!.boundHub()!.hubId).readProfile(); check(tag + " pinned credential persisted", profile.hub.memberOrigin === memberOrigin);
      await other.p.locator("[data-pairing-notice]").first().waitFor(); await admin.p.locator("[data-pairing-notice]").first().waitFor();
      check(tag + " initiator excluded", await a.p.locator("[data-pairing-notice]").count() === 0);
      await shot(a.p, tag + "-connected"); await shot(other.p, tag + "-notice"); await geometry(a.p, tag + " connected"); await geometry(other.p, tag + " notice");
      await other.p.locator("[data-pairing-notice] .btn-danger").first().click(); await other.p.getByText(c.lang === "en" ? "Revoked" : "已撤銷", { exact: true }).first().waitFor();
      check(tag + " one-click revoke no dialog", await other.p.locator("[role=dialog]").count() === 0); await local.ctx.close(); await other.ctx.close();
    } finally { await a.ctx.close(); }
  }
  if (mode !== "before") {
    const stale = await context(cases[0], true); await signIn(stale.p, users[1].login); await stale.p.locator(".hub-welcome-card").first().waitFor();
    check("old client hides quick actions", await stale.p.locator("[data-quick-pairing]").count() === 0); await shot(stale.p, "skew-old-client-welcome");
  }
  check("actual verified LDAPS membership controls", peer.searches.some(s => s.controls.some((c: any) => c.oid === "1.2.840.113556.1.4.529" && c.critical)));
  check("directory requested DC636", requestedPorts.length > 0 && requestedPorts.every(p => p === 636));
  check("no browser errors", receipt.errors.length === 0); check("no CSP violations", receipt.csp.length === 0); check("no foreign browser requests", receipt.foreign.length === 0); receipt.status = "PASS";
} catch (e: any) { receipt.status = "FAIL"; receipt.error = e.stack; for (const ctx of contexts) for (const p of ctx.pages()) await shot(p, `FAIL-${receipt.shots.length}`).catch(() => {}); throw e; }
finally {
  writeFileSync(join(art, `${mode}${skew ? "-skew" : ""}-browser.json`), JSON.stringify(receipt, null, 2)); memberLive = false; api?.cancel(); await member?.close(); inboxDb?.close();
  await fx.close(); await service.close(); await directory.close(); await peer.close(); certs.cleanup(); rmSync(scratch, { recursive: true, force: true });
  tls.connect = originalConnect; syncBuiltinESMExports();
}
console.log(JSON.stringify({ status: receipt.status, checks: receipt.checks.length, shots: receipt.shots.length }));
