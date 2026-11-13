/** #3429 option B rehearsal: actual browser/Hub/fake LDAPS/pinned member, inside an owned isolated container (run.sh).
 * Covers the Settings card (Settings → Hub → Fleet connection address) with before/after and SKEW captures, leg 1 (an
 * online member follows) and leg 2 (an offline member is revoked, then re-joins: manual pairing → explicit Disconnect /
 * Start over → company sign-in in the one-box join — NOT the existing-company one-button Reconnect, which is covered
 * by tests/hub-company-join-local.test.ts and tests/hub-company-join-http.test.ts). No full Fleet/CLI/tmux/service or
 * live directory. run.sh binds the receipt to the executed source, base modules, dependencies, image and pictures.
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
const receipt: any = { checks: [], screenshots: [], boundary: "Owned container, --network none, explicit uid1000, no capabilities. Real Fleet health/Settings shell, D3, Hub HTTPS, synthetic verified LDAPS, the Settings → Hub → Fleet connection address card (before/after: base modules served by route; SKEW: base shared modules and app.css under the new card), option B leg 1 (online member follows the issuer-signed relocation) and leg 2 (offline member revoked; re-joined by legacy manual pairing → explicit shipped Disconnect/Start over → real browser company sign-in in the one-box join — not the one-button Reconnect). Explicit per-client fixture CA/hostname mapping and exact :636-to-owned-wire-port mapping only. No full fleet daemon lifecycle, agent/model/CLI/tmux/native/real AD/pilot." };
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
    const relocPath = join(memberHome, "hub-member", pairing.boundHub().hubId, "member-origin.json");
    const reloc = () => { try { return JSON.parse(readFileSync(relocPath, "utf8")); } catch { return null; } };
    const transportFleet = async (id: string) => { const { default: Db } = await import("better-sqlite3"); const d = new Db(join(home, "hub/hub.sqlite"), { readonly: true });
        try { return JSON.parse((d.prepare("SELECT state FROM hub_transport_state").get() as any).state).fleets.find((f: any) => f.id === id); } finally { d.close(); } };
    const fleetBefore = await transportFleet(profile.fleetId);
    // The Settings card (#3429 UI): every state short of Confirm, EN/zh-TW × desktop/phone × light/dark; Back changes nothing.
    const shots = join(out, "png"); mkdirSync(shots, { recursive: true });
    const VIEW = { desktop: { width: 1366, height: 900 }, phone: { width: 390, height: 844 } } as const;
    const shot = async (loc: any, name: string) => { await loc.screenshot({ path: join(shots, name) }); receipt.screenshots.push("png/" + name); };
    const themes = async (pg: any, fn: (theme: string) => Promise<void>) => { for (const theme of ["light", "dark"]) { await pg.emulateMedia({ colorScheme: theme }); await pg.waitForTimeout(120); await fn(theme); } await pg.emulateMedia({ colorScheme: "light" }); };
    const cardPage = async (lang: "en" | "zh-TW", view: keyof typeof VIEW) => {
        const ctx = await browser.newContext({ locale: lang === "en" ? "en-US" : "zh-TW", viewport: VIEW[view], isMobile: view === "phone", hasTouch: view === "phone" });
        await ctx.addCookies([{ name: cookieName, value: cookieValue, url: origin }]);
        // The page's language comes from the browser locale (an explicit choice would sync to every later page of this person).
        await ctx.addInitScript(() => { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); });
        const pg = await ctx.newPage(); await pg.goto(origin + "/settings/hub");
        const card = pg.locator(".hub-member-address"); await card.waitFor();
        await card.locator("summary").first().click(); await card.locator(".hub-addr-now").waitFor();
        return { ctx, pg, card };
    };
    const nextHost = new URL(nextOrigin).host;
    for (const lang of ["en", "zh-TW"] as const) for (const view of ["desktop", "phone"] as const) {
        const { ctx, pg, card } = await cardPage(lang, view);
        check(`${lang} ${view}: the card shows the address and one connected Fleet`, (await card.locator(".hub-addr-now").innerText()).includes(new URL(memberOrigin).host));
        await themes(pg, async theme => { await shot(card, `card-show.${lang}.${view}.${theme}.png`); });
        await card.locator("#hubMemberChange").click(); await card.locator("#hubMemberNew").fill(nextHost);
        await card.locator(".hub-addr-advanced summary").click();
        await themes(pg, async theme => { await shot(card, `card-edit.${lang}.${view}.${theme}.png`); });
        await card.locator('.hub-addr-form button[type="submit"]').click(); await card.locator(".hub-addr-confirm").waitFor();
        check(`${lang} ${view}: Check lists the Fleet that moves`, (await card.locator(".hub-member-moving .hub-member-fleet").count()) === 1);
        await themes(pg, async theme => { await shot(card, `card-confirm.${lang}.${view}.${theme}.png`); });
        await card.locator(".hub-addr-confirm .btn:not(.btn-primary)").click(); await card.locator("#hubMemberNew").waitFor();
        await ctx.close();
    }
    check("Check and Back changed nothing", fm.getRawFleetConfig().hub.memberOrigin === memberOrigin);
    // Before/after of the affected surface (Settings → Hub on the Hub's computer): "before" serves the base's own section,
    // connection and strings modules (run.sh exports them from BASE_REF into /work/.base) — the base never mounts the card.
    // SKEW: a tab holding the base's shared modules and stylesheet lazily loads the new card (it must link and render).
    const baseUi = (path: string) => readFileSync(join("/work/.base", path), "utf8");
    const JS = "text/javascript";
    const BEFORE: Record<string, [string, string]> = {
        "**/ui/js/settings-hub-section.js": [JS, baseUi("src/ui/settings-hub-section.js")],
        "**/ui/js/settings-hub-connection.js": [JS, baseUi("src/ui/settings-hub-connection.js")],
        "**/ui/js/hub-join-one-strings.js": [JS, baseUi("src/ui/hub-join-one-strings.js")] };
    const SKEW: Record<string, [string, string]> = {
        "**/ui/js/settings-confirm.js": [JS, baseUi("src/ui/settings-confirm.js")],
        "**/ui/js/settings-hub-web-address.js": [JS, baseUi("src/ui/settings-hub-web-address.js")],
        "**/assets/ui-states.js": [JS, baseUi("src/ui/shared/ui-states.js")],
        "**/assets/app.css": ["text/css", baseUi("src/ui/shared/app.css")] };
    const sectionPage = async (lang: "en" | "zh-TW", view: keyof typeof VIEW, routes: Record<string, [string, string]>) => {
        const ctx = await browser.newContext({ locale: lang === "en" ? "en-US" : "zh-TW", viewport: VIEW[view], isMobile: view === "phone", hasTouch: view === "phone" });
        await ctx.addCookies([{ name: cookieName, value: cookieValue, url: origin }]);
        await ctx.addInitScript(() => { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); });
        for (const [glob, [type, body]] of Object.entries(routes)) await ctx.route(glob, (r: any) => r.fulfill({ status: 200, contentType: type, body }));
        const pg = await ctx.newPage(), errors: string[] = [];
        pg.on("pageerror", (e: any) => errors.push(String(e).slice(0, 200)));
        pg.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
        await pg.goto(origin + "/settings/hub"); const section = pg.locator(".s-hub-section"); await section.waitFor();
        await pg.waitForLoadState("networkidle"); await pg.waitForTimeout(400);
        return { ctx, pg, section, errors };
    };
    receipt.surface = [];
    for (const lang of ["en", "zh-TW"] as const) for (const view of ["desktop", "phone"] as const) for (const variant of ["before", "after"] as const) {
        const { ctx, pg, section, errors } = await sectionPage(lang, view, variant === "before" ? BEFORE : {});
        const cards = await section.locator(".hub-member-address").count();
        check(`${variant} ${lang} ${view}: the card is ${variant === "before" ? "absent (base)" : "present, folded"}; no page error`, cards === (variant === "before" ? 0 : 1) && errors.length === 0);
        await themes(pg, async theme => { await shot(section, `surface-${variant}.${lang}.${view}.${theme}.png`); });
        receipt.surface.push({ variant, lang, view, cards, errors }); await ctx.close();
    }
    receipt.skew = [];
    for (const [lang, view, theme] of [["en", "desktop", "light"], ["zh-TW", "phone", "dark"]] as const) {
        const { ctx, pg, section, errors } = await sectionPage(lang, view, SKEW);
        await pg.emulateMedia({ colorScheme: theme });
        const card = section.locator(".hub-member-address"); await card.waitFor();
        await card.locator("summary").first().click(); await card.locator(".hub-addr-now").waitFor();
        const text = await card.innerText();
        check(`SKEW ${lang} ${view}: the new card links and renders under the base's shared modules and stylesheet; no raw key, no page error`,
            text.includes(new URL(memberOrigin).host) && !/hubMemberAddress\.|err_/.test(text) && errors.length === 0);
        await shot(card, `skew-card.${lang}.${view}.${theme}.png`);
        receipt.skew.push({ lang, view, theme, errors }); await ctx.close();
    }
    // #3429 option B, leg 1: the member is ONLINE at the change — it follows the issuer-signed relocation, keeps its credential.
    // Through the card's Confirm (EN); the server's answer is read from the commit response.
    const confirmVia = async (lang: "en" | "zh-TW", target: string) => {
        const { ctx, pg, card } = await cardPage(lang, "desktop");
        await card.locator("#hubMemberChange").click(); await card.locator("#hubMemberNew").fill(new URL(target).host);
        await card.locator('.hub-addr-form button[type="submit"]').click(); await card.locator(".hub-addr-confirm").waitFor();
        const prepared = await pg.evaluate(() => document.querySelectorAll(".hub-member-moving .hub-member-fleet").length);
        const committed = pg.waitForResponse((r: any) => r.url().endsWith("/api/settings/hub/member-address/commit"), { timeout: 60000 });
        await card.locator(".hub-addr-confirm .btn-primary").click();
        const response = await committed; const body = await response.json();
        await card.locator('[role="status"]').waitFor({ timeout: 30000 });
        const said = await card.locator('[role="status"]').innerText();
        await themes(pg, async theme => { await shot(card, `card-done.${lang}.desktop.${theme}.png`); });
        await pg.setViewportSize(VIEW.phone);
        await themes(pg, async theme => { await shot(card, `card-done.${lang}.phone.${theme}.png`); });
        await ctx.close();
        return { status: response.status(), body, said, prepared };
    };
    const ui1 = await confirmVia("en", nextOrigin);
    check("browser prepares affected fleet", ui1.prepared === 1);
    const result = { status: ui1.status, body: ui1.body };
    check("the card says the Fleet followed", ui1.said.includes("Done. All 1 Fleets followed to the new address."));
    receipt.leg1 = { status: result.status, state: result.body.state, followed: result.body.followed, reconnect: result.body.reconnect };
    check("saved exact member mount ready; the online Fleet followed", result.status === 200 && result.body.state === "ready" && result.body.followed === 1 && result.body.reconnect.length === 0);
    await wait(() => memberFm.hubMemberLink === "online" && reloc()?.pending === null && reloc()?.confirmed?.length === 1);
    check("the member is online again with the same credential (pairing.json byte-identical)", memberFm.hubMemberLink === "online" && readFileSync(profilePath).equals(profileBefore));
    check("its relocation is confirmed: the anchor is the new address", reloc()?.confirmed?.[0]?.statement?.to === nextOrigin && reloc()?.confirmed?.[0]?.statement?.from === memberOrigin);
    check("the Hub kept the Fleet: same credential binding and generation", JSON.stringify(await transportFleet(profile.fleetId)) === JSON.stringify(fleetBefore));
    const after = fm.getRawFleetConfig().hub;
    check("browser address and Hub id preserved", after.webOrigin === before.webOrigin && after.hubId === before.hubId);
    check("same browser session still signed in", await hp.evaluate(async () => (await (await fetch("/hub/v1/session")).json()).signedIn === true));
    const notice = await hp.evaluate(async () => (await (await fetch("/hub/v1/security-notices/member-address")).json()));
    receipt.leg1Notice = notice.rows.map((r: any) => ({ action: r.action, fleets: r.fleets.length }));
    check("no reconnect notice names the Fleet that followed", notice.rows.every((r: any) => !r.fleets.some((f: any) => f.id === profile.fleetId)));
    const memberIdentity = (await import("../../../src/hub/tls.js")).readHubMemberTls({ home });
    check("member SPKI and issuer retained", memberIdentity.identity.spkiSha256 === profile.hub.spkiSha256 && memberIdentity.identity.issuerPublicKey === profile.hub.issuerPublicKey);
    let refused = false;
    const retiredPage = await hub.newPage();
    try { await retiredPage.goto(memberOrigin + "/ui/hub", { timeout: 5000 }); } catch (e) { refused = String(e).includes("ERR_CONNECTION_REFUSED"); }
    finally { await retiredPage.close(); }
    check("old member endpoint refused", refused);
    // Leg 2: the member is OFFLINE (paused) at the next change — it is revoked, and reconnects with the company account.
    memberFm.saveFleetConfig([{ path: ["hub_member", "enabled"], value: false }]); await memberFm.applyHubSwitches();
    await wait(() => memberFm.hubMemberLink !== "online");
    let thirdPort = await freeHubPort();
    while ([webPort, memberPort, nextPort, port, port + 1].includes(thirdPort)) thirdPort = await freeHubPort();
    const thirdOrigin = `https://127.0.0.1:${thirdPort}`;
    const ui2 = await confirmVia("zh-TW", thirdOrigin);
    const result2 = { status: ui2.status, body: ui2.body };
    check("the card names the Fleet that must reconnect", ui2.said.includes("需要在它自己的「設定 → Hub」重新連接"));
    receipt.leg2 = { status: result2.status, state: result2.body.state, followed: result2.body.followed, reconnect: result2.body.reconnect,
        rejoin: "manual pairing → explicit Disconnect/Start over → company sign-in (one-box join): a new Fleet ID; not the one-button Reconnect" };
    check("the offline Fleet did not follow and must reconnect", result2.status === 200 && result2.body.state === "ready" && result2.body.followed === 0
        && result2.body.reconnect.length === 1 && result2.body.reconnect[0].id === profile.fleetId);
    check("the Hub revoked it", (await transportFleet(profile.fleetId)).status === "revoked");
    const notice2 = await hp.evaluate(async () => (await (await fetch("/hub/v1/security-notices/member-address")).json()));
    check("its owner's reconnect notice names it", notice2.rows.some((r: any) => r.action === "reconnect" && r.fleets.some((f: any) => f.id === profile.fleetId)));
    memberFm.saveFleetConfig([{ path: ["hub_member", "enabled"], value: true }]); await memberFm.applyHubSwitches();
    await hp.goto(oldOrigin + "/ui/hub");
    const { default: WebSocket } = await import("ws");
    const { pinnedHubAgent } = await import("../../../src/hub/tls.js");
    const staleAgent = pinnedHubAgent({ memberOrigin: thirdOrigin, spkiSha256: profile.hub.spkiSha256 });
    let staleOpened = false;
    const rejected = await new Promise<boolean>(resolve => {
      const ws = new WebSocket(thirdOrigin.replace("https:", "wss:") + "/hub/v1/connect", { agent: staleAgent, headers: { Authorization: "Bearer " + profile.credential } });
      const timer = setTimeout(() => { ws.terminate(); resolve(false); }, 5000);
      ws.on("open", () => { staleOpened = true; ws.close(); }); ws.on("error", () => {}); ws.on("close", () => { clearTimeout(timer); resolve(!staleOpened); });
    }); staleAgent.destroy(); check("the new endpoint refuses the revoked credential", rejected && !staleOpened);
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
    const mp = await mc.newPage(); receipt.memberConsole = [];
    mp.on("console", (m: any) => { if (["error", "warning"].includes(m.type())) receipt.memberConsole.push(`${m.type()}: ${m.text()}`.slice(0, 300)); });
    mp.on("pageerror", (e: any) => receipt.memberConsole.push(`pageerror: ${String(e)}`.slice(0, 300)));
    receipt.memberRequests = []; mp.on("request", (q: any) => { const u = new URL(q.url()); if (u.pathname.includes("company-join") || u.pathname.includes("joinWait")) receipt.memberRequests.push(`${q.method()} ${u.pathname}`); });
    mc.on("page", (pg: any) => receipt.memberConsole.push(`new page: ${pg.url()}`));
    await mp.goto(mpOrigin + "/settings/hub");
    // Phase A: people type the Hub address in the one box (the page looks the Hub up and asks for company sign-in).
    await mp.locator("#hubCompanyAddress").fill(new URL(oldOrigin).host);
    // Phase A one-box join: the Fleet keeps the suggested name (the name is optional; Rename is not needed here).
    // The address input re-checks the Hub on blur; let that finish before pressing the button (a click that blurs it lands on a
    // briefly disabled button — reported separately as a join-box finding, not part of #3429).
    await mp.locator("#hubCompanyAddress").blur();
    await mp.locator('#hubCompanyLine').filter({ hasText: /找到|Found/ }).waitFor({ timeout: 15000 });
    await mp.waitForFunction(() => !(document.querySelector('.hub-join-one button[type="submit"]') as HTMLButtonElement | null)?.disabled);
    await mp.screenshot({ path: join(out, "debug-before-signin.png") });
    receipt.debugBeforeSignin = (await mp.locator("#hub-connection").innerText().catch(() => "")).slice(0, 800);
    const popup = mc.waitForEvent("page");
    await mp.getByRole("button", { name: /以公司帳號登入|Sign in with company account/, exact: true }).click();
    const signin = await popup.catch(async (e: unknown) => {
        await mp.screenshot({ path: join(out, "debug-after-click.png") });
        receipt.debugAfterClick = (await mp.locator("#hub-connection").innerText().catch(() => "")).slice(0, 800);
        receipt.debugPages = mc.pages().map((x: any) => x.url());
        throw e; });
    await signin.locator("#hubLogin").fill("avery"); await signin.locator("#hubPassword").fill("Dummy-person-only");
    await signin.getByRole("button", { name: /登入並連接 Fleet|Sign in and connect Fleet/, exact: true }).click();
    await mp.locator('#hub-connection[data-state="connected"]').waitFor({ timeout: 30000 }).catch(async (e: unknown) => {
        receipt.debugMember = (await mp.locator("#hub-connection").innerText().catch(() => "")).slice(0, 900);
        receipt.debugPages = mc.pages().map((x: any) => x.url());
        receipt.debugSignin = (await signin.locator("body").innerText().catch(() => "")).slice(0, 900);
        await mp.screenshot({ path: join(out, "debug-member.png") }); await signin.screenshot({ path: join(out, "debug-signin.png") }).catch(() => {});
        throw e; }); await wait(() => memberFm.hubMemberLink === "online");
    check("real browser company sign-in reconnects", memberFm.hubMemberLink === "online");
    const replacement = JSON.parse(readFileSync(profilePath, "utf8"));
    check("fresh exact credential and new member origin", replacement.fleetId !== profile.fleetId && replacement.credential !== profile.credential && replacement.hub.memberOrigin === thirdOrigin);
    check("reconnected Hub ID and issuer unchanged", replacement.hub.hubId === profile.hub.hubId && replacement.hub.issuerPublicKey === profile.hub.issuerPublicKey);
    await mp.screenshot({ path: join(out, "backend-after-reconnect.zh-TW.png") }); receipt.screenshots.push("backend-after-reconnect.zh-TW.png");
    const db = new (await import("better-sqlite3")).default(join(home, "hub/hub.sqlite"), { readonly: true });
    try {
      const state = JSON.parse((db.prepare("SELECT state FROM hub_transport_state").get() as any).state);
      check("old row remains revoked; only fresh row is active", state.fleets.find((f: any) => f.id === profile.fleetId).status === "revoked" && state.fleets.filter((f: any) => f.credentialHash !== null).length === 1);
      check("one notice per change, none duplicated", (db.prepare("SELECT count(*) n FROM hub_member_address_notices").get() as any).n === 2);
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
