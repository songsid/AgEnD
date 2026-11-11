/** Backend rehearsal only. Actual browser/Hub/fake LDAPS/pinned member, inside an owned isolated container.
 * No proposed Settings controls, no UI approval claim, no full Fleet/CLI/tmux/service or live directory.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { request } from "node:http";
import { directoryCertificates } from "../../../tests/support/hub-directory-ca-fixture.js";
import { groupWirePeer, PERSON_ID } from "../../../tests/support/hub-group-directory-wire.js";
import { freeHubPort } from "../../../tests/helpers/hub-rig.js";
if (process.env.AGEND_OWNED_CONTAINER !== "hub-address-3428" || !existsSync("/.dockerenv"))
    throw Error("Owned isolated container required");
const out = process.env.OUT!;
if (!out)
    throw Error("OUT required");
mkdirSync(out, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "ridge-address-")), home = join(root, "host"), memberHome = join(root, "member");
mkdirSync(home, { mode: 0o700 });
mkdirSync(memberHome, { mode: 0o700 });
process.env.AGEND_HOME = join(root, "environment");
mkdirSync(process.env.AGEND_HOME, { mode: 0o700 });
const { FleetManager } = await import("../../../src/fleet-manager.js"), { csrfTokenFor } = await import("../../../src/web-session.js"), { WEB_CSRF_HEADER } = await import("../../../src/web-auth.js");
const { chromium } = await import("playwright-core");
const receipt: any = { checks: [], screenshots: [], boundary: "Owned container, --network none, explicit uid1000, no capabilities. Real Fleet health/Settings shell, D3, Hub HTTPS, synthetic verified LDAPS, public manual pairing through the second FleetManager and its production member runtime with empty Agent inventory. No new address UI, full fleet daemon lifecycle, agent/model/CLI/tmux/native/real AD/pilot." };
const check = (name: string, value: boolean) => { receipt.checks.push({ name, pass: value }); if (!value)
    throw Error(name); };
const wait = async (fn: () => boolean) => { const end = Date.now() + 15000; while (!fn() && Date.now() < end)
    await new Promise(r => setTimeout(r, 40)); if (!fn())
    throw Error("Owned fixture timed out"); };
const http = (port: number, path: string, headers: any, body?: unknown) => new Promise<any>((resolve, reject) => { const q = request({ host: "127.0.0.1", port, path, method: "POST", headers }, r => { let text = ""; r.on("data", b => text += b); r.on("end", () => resolve({ status: r.statusCode, headers: r.headers, body: JSON.parse(text) })); }); q.on("error", reject); q.end(body === undefined ? undefined : JSON.stringify(body)); });
const certs = directoryCertificates();
let fm: any, memberFm: any, peer: any, browser: any, reconciliations = 0;
try {
    peer = await groupWirePeer(certs.leaf, [{ id: PERSON_ID, login: "avery", dn: "CN=Avery,DC=example,DC=test", password: "Dummy-person-only", eligible: true }]);
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
    browser = await chromium.launch({ args: ["--no-sandbox"] });
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
    const oldOrigin = `https://127.0.0.1:${webPort}`, memberOrigin = `https://127.0.0.1:${memberPort}`, nextOrigin = `https://127.0.0.1:${nextPort}`;
    const input = { name: "Synthetic address rehearsal", webOrigin: oldOrigin, memberOrigin, webListen: { host: "127.0.0.1", port: webPort }, memberListen: { host: "127.0.0.1", port: memberPort }, directory: { realm: "fictional", url: `ldaps://127.0.0.1:${peer.port}`, caPem: certs.ca, baseDn: "DC=example,DC=test", bindDn: "CN=Reader,DC=example,DC=test", profile: "ad" }, confirmedCa: [new X509Certificate(certs.ca).fingerprint256], bindPassword: "Dummy-service-only", administratorLogin: "avery", retention: { contentDays: 30, eventDays: 90 }, coexistence: "dedicated" };
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
    const before = fm.getRawFleetConfig().hub, move = await api("/api/settings/hub/web-address/prepare", { origin: nextOrigin, listen: { host: "127.0.0.1", port: nextPort }, certificate: { mode: "generate" } });
    check("browser prepares address", move.status === 200);
    const result = await api("/api/settings/hub/web-address/commit", { ref: move.body.ref });
    check("saved exact mount ready", result.status === 200 && result.body.state === "ready");
    await wait(() => reconciliations >= 2);
    check("paired member reconnects with identical credential and pins", readFileSync(profilePath).equals(profileBefore));
    const after = fm.getRawFleetConfig().hub;
    check("member and issuer preserved", after.hubId === before.hubId && after.memberOrigin === before.memberOrigin && JSON.stringify(after.memberListen) === JSON.stringify(before.memberListen));
    await hp.goto(nextOrigin + "/ui/hub");
    await hp.locator("#hubLogin").waitFor();
    check("old browser session ended", await hp.evaluate(async () => (await (await fetch("/hub/v1/session")).json()).signedIn === false));
    await hp.screenshot({ path: join(out, "backend-after-relogin.zh-TW.png") });
    receipt.screenshots.push("backend-after-relogin.zh-TW.png");
    await signIn();
    check("new address accepts fresh real directory sign-in", true);
    let refused = false;
    try {
        await hp.goto(oldOrigin + "/ui/hub", { timeout: 5000 });
    }
    catch (e) {
        refused = String(e).includes("ERR_CONNECTION_REFUSED");
    }
    check("old address refused", refused);
    receipt.reconciliations = reconciliations;
    receipt.profileSha256 = createHash("sha256").update(profileBefore).digest("hex");
    receipt.ready = true;
}
catch (error) {
    receipt.error = String(error);
    console.error(receipt.error);
    process.exitCode = 1;
}
finally {
    if (memberFm) {
        memberFm.hubEffectsReady = false;
        await memberFm.hubRuntime?.close();
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
    certs.cleanup();
    rmSync(root, { recursive: true, force: true });
    receipt.cleaned = true;
    writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
}
console.log(JSON.stringify({ pass: receipt.ready === true, checks: receipt.checks.length, error: receipt.error, out }));
process.exit(receipt.ready ? 0 : 1);
