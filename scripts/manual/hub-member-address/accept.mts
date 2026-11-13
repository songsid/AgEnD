/** Backend rehearsal only. Actual browser/Hub/fake LDAPS/pinned member, inside an owned isolated container.
 * No proposed Settings controls, no UI approval claim, no full Fleet/CLI/tmux/service or live directory.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { request } from "node:http";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { directoryCertificates } from "../../../tests/support/hub-directory-ca-fixture.js";
import { groupWirePeer, PERSON_ID } from "../../../tests/support/hub-group-directory-wire.js";
import { freeHubPort } from "../../../tests/helpers/hub-rig.js";
if (process.env.AGEND_OWNED_CONTAINER !== "hub-member-address-3429" || !existsSync("/.dockerenv"))
    throw Error("Owned isolated container required");
const out = process.env.OUT!;
if (!out)
    throw Error("OUT required");
mkdirSync(out, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "ridge-member-address-")), home = join(root, "host"), memberHome = join(root, "member");
mkdirSync(home, { mode: 0o700 });
mkdirSync(memberHome, { mode: 0o700 });
process.env.AGEND_HOME = join(root, "environment");
mkdirSync(process.env.AGEND_HOME, { mode: 0o700 });
const { FleetManager } = await import("../../../src/fleet-manager.js"), { csrfTokenFor } = await import("../../../src/web-session.js"), { WEB_CSRF_HEADER } = await import("../../../src/web-auth.js");
const { chromium } = await import("playwright-core");
const receipt: any = { checks: [], screenshots: [], boundary: "Owned container, --network none, explicit uid1000, no capabilities. Real Fleet health/Settings shell, D3, Hub HTTPS, synthetic verified LDAPS, legacy manual pairing followed by explicit shipped Disconnect/Start over and real browser company sign-in through the second FleetManager/member runtime with empty Agent inventory. Explicit per-client fixture CA/hostname mapping and exact :636-to-owned-wire-port mapping only; no new reconnect widget or automatic trust reset. No new address UI, full fleet daemon lifecycle, agent/model/CLI/tmux/native/real AD/pilot." };
const check = (name: string, value: boolean) => { receipt.checks.push({ name, pass: value }); if (!value)
    throw Error(name); };
const wait = async (fn: () => boolean) => { const end = Date.now() + 15000; while (!fn() && Date.now() < end)
    await new Promise(r => setTimeout(r, 40)); if (!fn())
    throw Error("Owned fixture timed out"); };
const http = (port: number, path: string, headers: any, body?: unknown) => new Promise<any>((resolve, reject) => { const q = request({ host: "127.0.0.1", port, path, method: "POST", headers }, r => { let text = ""; r.on("data", b => text += b); r.on("end", () => resolve({ status: r.statusCode, headers: r.headers, body: JSON.parse(text) })); }); q.on("error", reject); q.end(body === undefined ? undefined : JSON.stringify(body)); });
const certs = directoryCertificates();
let fm: any, memberFm: any, peer: any, browser: any, reconciliations = 0;
const ownedTls = createRequire(import.meta.url)("node:tls"), originalConnect = ownedTls.connect;
try {
    peer = await groupWirePeer(certs.leaf, [{ id: PERSON_ID, login: "avery", dn: "CN=Avery,DC=example,DC=test", password: "Dummy-person-only", eligible: true }]);
    // Group-policy AD contract uses :636. Redirect only that exact owned loopback fixture to its ephemeral wire port.
    ownedTls.connect = (options: any, ...args: any[]) => originalConnect({ ...options,
      ...(options.host === "127.0.0.1" && options.port === 636 ? { port: peer.port } : {}) }, ...args);
    syncBuiltinESMExports();
    writeFileSync(join(home, "fleet.yaml"), "instances: {}\nweb:\n  verified_authority:\n    enabled: true\n", { mode: 0o600 });
    fm = new FleetManager(home);
    const sink = () => { };
    fm.logger = { info: sink, warn: sink, error: sink, debug: sink, trace: sink, fatal: sink, child: () => fm.logger };
    fm.loadConfig(join(home, "fleet.yaml"));
    fm.initializeWebAuthTokens();
    fm.startHealthServer(0);
    await wait(() => fm.getDashboardAccess().ready);
    const port = fm.healthServer.address().port, origin = `http://127.0.0.1:${port}`;
    const issue = await http(port, "/auth/issue-code", { origin, "x-agend-token": fm.getDashboardAccess().token });
    const login = await http(port, "/auth/login", { origin, "content-type": "application/json" }, { code: issue.body.code });
    check("real host launch sign-in", login.status === 200);
    const [cookieName, cookieValue] = login.headers["set-cookie"][0].split(";")[0].split("=");
    const csrf = csrfTokenFor(cookieValue);
    browser = await chromium.launch({ args: ["--no-sandbox", "--no-proxy-server", "--host-resolver-rules=MAP hub.example.test 127.0.0.1"] });
    const host = await browser.newContext({ ignoreHTTPSErrors: true, locale: "zh-TW", viewport: { width: 1366, height: 900 } });
    await host.addCookies([{ name: cookieName, value: cookieValue, url: origin }]);
    await host.addInitScript(() => { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); });
    const page = await host.newPage();
    await page.goto(origin + "/settings/hub");
    await page.locator(".s-nav").waitFor();
    await page.locator("#sidebar").waitFor();
    check("actual Settings two-level shell", await page.locator(".s-nav").count() === 1);
    const api = async (path: string, body: unknown) => page.evaluate(async ({ path, body, h, csrf }) => { const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", [h]: csrf }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; }, { path, body, h: WEB_CSRF_HEADER, csrf });
    const webPort = await freeHubPort();
    let memberPort = await freeHubPort();
    while (memberPort === webPort)
        memberPort = await freeHubPort();
    let nextPort = await freeHubPort();
    while ([webPort, memberPort, port, port + 1].includes(nextPort))
        nextPort = await freeHubPort();
    const oldOrigin = `https://hub.example.test:${webPort}`, memberOrigin = `https://127.0.0.1:${memberPort}`, nextOrigin = `https://127.0.0.1:${nextPort}`;
    const input = { name: "Synthetic address rehearsal", webOrigin: oldOrigin, memberOrigin, webListen: { host: "127.0.0.1", port: webPort }, memberListen: { host: "127.0.0.1", port: memberPort }, directory: { realm: "fictional", url: "ldaps://127.0.0.1:636", caPem: certs.ca, baseDn: "DC=example,DC=test", bindDn: "CN=Reader,DC=example,DC=test", profile: "ad" }, confirmedCa: [new X509Certificate(certs.ca).fingerprint256], bindPassword: "Dummy-service-only", administratorLogin: "avery", retention: { contentDays: 30, eventDays: 90 }, coexistence: "dedicated" };
    const p = await api("/api/settings/hub/setup/prepare", input);
    check("initializer prepare", p.status === 200);
    check("verified synthetic LDAPS", (await api("/api/settings/hub/setup/test", { ref: p.body.ref })).status === 200);
    check("initializer commit", (await api("/api/settings/hub/setup/commit", { ref: p.body.ref })).status === 200);
    fm.hubEffectsReady = true;
    await fm.applyHubSwitches();
    check("initial Hub ready", fm.hubRuntime.currentHolds().length === 0);
    const hub = await browser.newContext({ ignoreHTTPSErrors: true, locale: "zh-TW", viewport: { width: 1366, height: 900 } });
    const hp = await hub.newPage();
    receipt.hubResponses = [];
    hp.on("response", async (r: any) => { if (new URL(r.url()).pathname === "/hub/v1/session") {
        try {
            const b = await r.json();
            receipt.hubResponses.push({ method: r.request().method(), status: r.status(), signedIn: b.signedIn, admin: b.admin, code: b.code });
        }
        catch { }
    } });
    const signIn = async () => { const signed = await hp.evaluate(async () => { const r = await fetch("/hub/v1/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "avery", password: "Dummy-person-only" }) }); const b = await r.json(); return { status: r.status, signedIn: b.signedIn }; }); check("actual browser directory sign-in", signed.status === 200 && signed.signedIn === true); await hp.reload(); };
    await hp.goto(oldOrigin + "/ui/hub");
    await signIn();
    const hubCall = async (path: string, body: unknown) => hp.evaluate(async ({ path, body }) => { const s = await (await fetch("/hub/v1/session")).json(); const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "X-AgEnD-Hub-CSRF": s.csrf }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; }, { path, body });
    const offer = await hubCall("/hub/v1/admin/pairings", { login: "avery" });
    if (offer.status !== 200) {
        receipt.offerFailure = offer;
        const { default: Db } = await import("better-sqlite3");
        const db = new Db(join(home, "hub/hub.sqlite"), { readonly: true });
        try {
            receipt.people = db.prepare("SELECT person,status,login_label FROM hub_people").all();
            receipt.sessionStates = db.prepare("SELECT state FROM hub_sessions").all();
            receipt.admin = fm.getRawFleetConfig().hub.administrator;
            receipt.filters = peer.searches.map((s: any) => s.filter);
        }
        finally {
            db.close();
        }
    }
    check("public manual pairing offer", offer.status === 200);
    writeFileSync(join(memberHome, "fleet.yaml"), "instances: {}\nhub_member:\n  enabled: true\n", { mode: 0o600 });
    memberFm = new FleetManager(memberHome);
    memberFm.logger = fm.logger;
    memberFm.loadConfig(join(memberHome, "fleet.yaml"));
    let projected = memberFm.hubMemberLink;
    Object.defineProperty(memberFm, "hubMemberLink", { get: () => projected, set: (state: string) => { projected = state; if (state === "online")
            reconciliations++; }, configurable: true });
    memberFm.hubEffectsReady = true;
    await memberFm.applyHubSwitches();
    const pairing = memberFm.hubMemberPairing();
    check("production member pairing API", !!pairing);
    check("public pinned connect", (await pairing.connect({ address: memberOrigin, code: offer.body.code }, () => true)).ok === true);
    const pending = pairing.view();
    check("pending fingerprint", pending.state === "pending");
    const fingerprint = pending.fingerprint.digest;
    check("exact owner confirmation", (await hubCall(`/hub/v1/pairings/${offer.body.pairingId}/confirm`, { fingerprint })).status === 200);
    check("exact admin confirmation", (await hubCall(`/hub/v1/admin/pairings/${offer.body.pairingId}/approve`, { fingerprint })).status === 200);
    check("local exact fingerprint confirmation", (await pairing.confirmFingerprint(fingerprint, () => true)).ok === true);
    await wait(() => pairing.view().state === "paired" && pairing.view().link === "online");
    const profilePath = join(memberHome, "hub-member", pairing.boundHub().hubId, "pairing.json"), profileBefore = readFileSync(profilePath);
    check("production member reconciled before", reconciliations === 1);
    await hp.screenshot({ path: join(out, "backend-before-hub.zh-TW.png") });
    receipt.screenshots.push("backend-before-hub.zh-TW.png");
    const profile = JSON.parse(profileBefore.toString()), before = fm.getRawFleetConfig().hub;
    const move = await api("/api/settings/hub/member-address/prepare", { origin: nextOrigin, listen: { host: "127.0.0.1", port: nextPort } });
    check("browser prepares affected fleet", move.status === 200 && move.body.summary.fleets.length === 1 && move.body.summary.fleets[0].id === profile.fleetId);
    const result = await api("/api/settings/hub/member-address/commit", { ref: move.body.ref });
    check("saved exact member mount ready", result.status === 200 && result.body.state === "ready");
    await wait(() => memberFm.hubMemberLink !== "online");
    check("old member credential disconnected", memberFm.hubMemberLink !== "online");
    check("old local credential is not silently rewritten", readFileSync(profilePath).equals(profileBefore));
    const after = fm.getRawFleetConfig().hub;
    check("browser address and Hub id preserved", after.webOrigin === before.webOrigin && after.hubId === before.hubId);
    check("same browser session still signed in", await hp.evaluate(async () => (await (await fetch("/hub/v1/session")).json()).signedIn === true));
    const notice = await hp.evaluate(async () => (await (await fetch("/hub/v1/security-notices/member-address")).json()));
    check("durable original owner notice", notice.rows.length === 1 && notice.rows[0].fleets[0].id === profile.fleetId && notice.rows[0].action === "reconnect");
    const memberIdentity = (await import("../../../src/hub/tls.js")).readHubMemberTls({ home });
    check("member SPKI and issuer retained", memberIdentity.identity.spkiSha256 === profile.hub.spkiSha256 && memberIdentity.identity.issuerPublicKey === profile.hub.issuerPublicKey);
    let refused = false;
    const retiredPage = await hub.newPage();
    try { await retiredPage.goto(memberOrigin + "/ui/hub", { timeout: 5000 }); } catch (e) { refused = String(e).includes("ERR_CONNECTION_REFUSED"); }
    finally { await retiredPage.close(); }
    check("old member endpoint refused", refused);
    await hp.goto(oldOrigin + "/ui/hub");
    const { default: WebSocket } = await import("ws");
    const { pinnedHubAgent } = await import("../../../src/hub/tls.js");
    const staleAgent = pinnedHubAgent({ memberOrigin: nextOrigin, spkiSha256: profile.hub.spkiSha256 });
    let staleOpened = false;
    const rejected = await new Promise<boolean>(resolve => {
      const ws = new WebSocket(nextOrigin.replace("https:", "wss:") + "/hub/v1/connect", { agent: staleAgent, headers: { Authorization: "Bearer " + profile.credential } });
      const timer = setTimeout(() => { ws.terminate(); resolve(false); }, 5000);
      ws.on("open", () => { staleOpened = true; ws.close(); }); ws.on("error", () => {}); ws.on("close", () => { clearTimeout(timer); resolve(!staleOpened); });
    }); staleAgent.destroy(); check("new endpoint refuses the old credential", rejected && !staleOpened);
    // Reuse the shipped #3615 exact-binding Disconnect and Start over. No new composite reconnect API or trust reset.
    check("exact local disconnect", (await pairing.disconnect(pairing.boundHub())).ok === true);
    check("explicit start over retires the old profile", pairing.cancel().state === "unpaired");
    // Configure the real synthetic group policy and company join once, with the administrator's real browser CSRF.
    const requestHub = async (method: string, path: string, body?: unknown) => hp.evaluate(async ({ method, path, body }) => {
      const session = await (await fetch("/hub/v1/session")).json();
      const r = await fetch(path, { method, headers: { "content-type": "application/json", "X-AgEnD-Hub-CSRF": session.csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: r.status, body: await r.json() };
    }, { method, path, body });
    const policy = (await requestHub("GET", "/hub/v1/admin/group-policy")).body.policy;
    policy.state = "enabled"; policy.groups = [{ group: { realm: "fictional", objectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, dn: "CN=Owners,DC=example,DC=test", allow: ["pair_fleet"], maxFleets: 8 }];
    const preview = await requestHub("POST", "/hub/v1/admin/group-policy/preview", { policy });
    receipt.policyPreview = { status: preview.status, code: preview.body.code, error: preview.body.error, reason: preview.body.reason };
    check("group policy preview", preview.status === 200);
    check("group policy configured once", (await requestHub("PUT", "/hub/v1/admin/group-policy", { policy, previewDigest: preview.body.previewDigest })).status === 200);
    const enabled = await requestHub("PUT", "/hub/v1/admin/company-join", { enabled: true, expectedRevision: 1 });
    check("company join enabled once", enabled.status === 200);
    memberFm.initializeWebAuthTokens(); memberFm.startHealthServer(0); await wait(() => memberFm.getDashboardAccess().ready);
    const mpPort = memberFm.healthServer.address().port, mpOrigin = `http://127.0.0.1:${mpPort}`;
    const issueMember = await http(mpPort, "/auth/issue-code", { origin: mpOrigin, "x-agend-token": memberFm.getDashboardAccess().token });
    const signMember = await http(mpPort, "/auth/login", { origin: mpOrigin, "content-type": "application/json" }, { code: issueMember.body.code });
    check("actual member host login", signMember.status === 200);
    const [mn, mv] = signMember.headers["set-cookie"][0].split(";")[0].split("=");
    const mc = await browser.newContext({ ignoreHTTPSErrors: true, locale: "zh-TW", viewport: { width: 1366, height: 900 } });
    await mc.addCookies([{ name: mn, value: mv, url: mpOrigin }]);
    await mc.addInitScript(() => { localStorage.setItem("agend_lang", "zh-TW"); localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); });
    const { CompanyJoinClient } = await import("../../../src/hub/join/client.js");
    const controller = await memberFm.hubCompanyJoin();
    // Owned fixture network/CA seam only; all protocol, Origin, key proof, policy, receipt and enrollment remain production.
    controller.client = new CompanyJoinClient({ ca: readFileSync(join(home, "hub/web-tls/cert.pem")), lookup: (hostname: string, options: any, done: any) => {
      if (hostname !== "hub.example.test") return done(Error("Unexpected owned fixture hostname"));
      return options.all ? done(null, [{ address: "127.0.0.1", family: 4 }]) : done(null, "127.0.0.1", 4);
    } });
    const mp = await mc.newPage(); await mp.goto(mpOrigin + "/settings/hub");
    await mp.locator("#hubCompanyAddress").fill(enabled.body.companyLink);
    await mp.locator("#hubCompanyFleetName").fill("Reconnected synthetic Fleet");
    const popup = mc.waitForEvent("page");
    await mp.getByRole("button", { name: /以公司帳號登入|Sign in with company account/, exact: true }).click();
    const signin = await popup;
    await signin.locator("#hubLogin").fill("avery"); await signin.locator("#hubPassword").fill("Dummy-person-only");
    await signin.getByRole("button", { name: /登入並連接 Fleet|Sign in and connect Fleet/, exact: true }).click();
    await mp.locator('#hub-connection[data-state="connected"]').waitFor({ timeout: 30000 }); await wait(() => memberFm.hubMemberLink === "online");
    check("real browser company sign-in reconnects", memberFm.hubMemberLink === "online");
    const replacement = JSON.parse(readFileSync(profilePath, "utf8"));
    check("fresh exact credential and new member origin", replacement.fleetId !== profile.fleetId && replacement.credential !== profile.credential && replacement.hub.memberOrigin === nextOrigin);
    check("reconnected Hub ID and issuer unchanged", replacement.hub.hubId === profile.hub.hubId && replacement.hub.issuerPublicKey === profile.hub.issuerPublicKey);
    await mp.screenshot({ path: join(out, "backend-after-reconnect.zh-TW.png") }); receipt.screenshots.push("backend-after-reconnect.zh-TW.png");
    const { default: Db } = await import("better-sqlite3"); const db = new Db(join(home, "hub/hub.sqlite"), { readonly: true });
    try {
      const state = JSON.parse((db.prepare("SELECT state FROM hub_transport_state").get() as any).state);
      check("old row remains revoked; only fresh row is active", state.fleets.find((f: any) => f.id === profile.fleetId).status === "revoked" && state.fleets.filter((f: any) => f.credentialHash !== null).length === 1);
      check("address notice not duplicated", (db.prepare("SELECT count(*) n FROM hub_member_address_notices").get() as any).n === 1);
    } finally { db.close(); }
    receipt.reconciliations = reconciliations;
    receipt.initialProfileSha256 = createHash("sha256").update(profileBefore).digest("hex");
    receipt.ready = true;
}
catch (error) {
    receipt.error = String(error);
    try { receipt.failureState = { memberLink: memberFm?.hubMemberLink, pairingState: memberFm?.hubMemberPairing()?.view()?.state }; } catch {}
    console.error(receipt.error);
    process.exitCode = 1;
}
finally {
    if (memberFm) {
        memberFm.hubEffectsReady = false;
        await memberFm.hubRuntime?.close(); memberFm.companyJoinController?.close();
        if (memberFm.healthServer) { memberFm.healthServer.closeAllConnections(); await new Promise<void>(resolve => memberFm.healthServer.close(() => resolve())); memberFm.healthServer = null; }
        memberFm.webSessions?.flush?.();
    }
    await browser?.close();
    if (fm) {
        fm.hubEffectsReady = false;
        await fm.hubRuntime?.close();
        await (await fm.hubSetupInit)?.close();
        const s = fm.healthServer;
        if (s) {
            s.closeAllConnections();
            await new Promise<void>(r => s.close(() => r()));
            fm.healthServer = null;
        }
        fm.webSessions?.flush?.();
    }
    await peer?.close();
    ownedTls.connect = originalConnect; syncBuiltinESMExports();
    certs.cleanup();
    rmSync(root, { recursive: true, force: true });
    receipt.cleaned = true;
    writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
}
console.log(JSON.stringify({ pass: receipt.ready === true, checks: receipt.checks.length, error: receipt.error, out }));
process.exit(receipt.ready ? 0 : 1);
