/** Actual D3 HTTP, verified synthetic LDAPS, real initializer, SQL writer and HTTPS remount. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import Database from "better-sqlite3";
import { FleetManager } from "../src/fleet-manager.js";
import { csrfTokenFor } from "../src/web-session.js";
import { WEB_CSRF_HEADER } from "../src/web-auth.js";
import { directoryCertificates } from "./support/hub-directory-ca-fixture.js";
import { groupWirePeer, PERSON_ID } from "./support/hub-group-directory-wire.js";
import { tempDir } from "./support/hub-init-fixtures.js";
import { freeHubPort } from "./helpers/hub-rig.js";
import { verifyHubInitialization } from "../src/hub/initialization.js";
import { hubPlanDigest } from "../src/hub/init/plan-digest.js";
import * as directoryDriver from "../src/hub/directory/directory.js";
import type { HubWebAddressDecision } from "../src/hub/settings-web-address-decision.js";
let certs: ReturnType<typeof directoryCertificates>;
const cleanup: Array<() => Promise<void>> = [];
beforeAll(() => { certs = directoryCertificates(); });
afterAll(() => certs.cleanup());
afterEach(async () => {
    for (const close of cleanup.splice(0))
        await close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});
function http(port: number, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{
    status: number;
    headers: import("node:http").IncomingHttpHeaders;
    body: any;
}> {
    return new Promise((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, method, path, headers, agent: false }, res => { let text = ""; res.on("data", c => text += c); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: JSON.parse(text || "{}") })); });
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
    });
}
function https(port: number, ca: string, method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<{
    status: number;
    headers: import("node:http").IncomingHttpHeaders;
    text: string;
}> {
    return new Promise((resolve, reject) => {
        const req = httpsRequest({ host: "127.0.0.1", port, ca, method, path, headers, agent: false }, res => { let text = ""; res.on("data", c => text += c); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text })); });
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
    });
}
async function fixture() {
    const home = tempDir("hub-address-http-"), path = join(home, "fleet.yaml");
    writeFileSync(path, "instances: {}\nweb:\n  verified_authority:\n    enabled: true\n", { mode: 0o600 });
    const peer = await groupWirePeer(certs.leaf, [{ id: PERSON_ID, login: "avery", dn: "CN=Avery,DC=example,DC=test", password: "Dummy-person-only", eligible: true }]);
    const fm = new FleetManager(home), internal = fm as any, sink = () => { };
    fm.logger = { info: sink, warn: sink, error: sink, debug: sink, trace: sink, fatal: sink, child: () => fm.logger } as any;
    vi.stubEnv("AGEND_FLEET_DATA_DIR", process.env.AGEND_FLEET_DATA_DIR);
    vi.stubEnv("AGEND_FLEET_CONFIG_PATH", process.env.AGEND_FLEET_CONFIG_PATH);
    fm.loadConfig(path);
    internal.initializeWebAuthTokens();
    internal.startHealthServer(0);
    await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
    const port = (internal.healthServer.address() as {
        port: number;
    }).port, origin = `http://127.0.0.1:${port}`, token = fm.getDashboardAccess().token!;
    const signin = async (code?: string) => {
        code ??= (await http(port, "POST", "/auth/issue-code", { "x-agend-token": token, origin })).body.code;
        const r = await http(port, "POST", "/auth/login", { origin, "content-type": "application/json" }, { code });
        expect(r.status).toBe(200);
        const cookie = r.headers["set-cookie"]![0]!.split(";")[0]!;
        return { id: cookie.slice(cookie.indexOf("=") + 1), cookie };
    };
    const host = await signin(), headers = { origin, cookie: host.cookie, "content-type": "application/json", [WEB_CSRF_HEADER]: csrfTokenFor(host.id) };
    const call = (action: string, body?: unknown, extra: Record<string, string> = {}) => http(port, body === undefined ? "GET" : "POST", "/api/settings/hub/web-address" + action, { ...headers, ...extra }, body);
    const r = { home, fm, internal, peer, headers, port, origin, token, host, signin, call,
        async close() { internal.hubEffectsReady = false; await internal.hubRuntime?.close(); await (await internal.hubSetupInit)?.close(); const server = internal.healthServer as Server; internal.healthServer = null; server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); internal.webSessions?.flush?.(); await peer.close(); rmSync(home, { recursive: true, force: true }); } };
    cleanup.push(r.close);
    return r;
}
async function initialize(r: Awaited<ReturnType<typeof fixture>>) {
    const webPort = await freeHubPort();
    let memberPort = await freeHubPort();
    while (memberPort === webPort)
        memberPort = await freeHubPort();
    const input = { name: "Synthetic Hub", webOrigin: `https://127.0.0.1:${webPort}`, memberOrigin: `https://127.0.0.1:${memberPort}`, webListen: { host: "127.0.0.1", port: webPort }, memberListen: { host: "127.0.0.1", port: memberPort },
        directory: { realm: "fictional", url: `ldaps://127.0.0.1:${r.peer.port}`, caPem: certs.ca, baseDn: "DC=example,DC=test", bindDn: "CN=Reader,DC=example,DC=test", profile: "ad" },
        confirmedCa: [new X509Certificate(certs.ca).fingerprint256], bindPassword: "Dummy-service-only", administratorLogin: "avery", retention: { contentDays: 30, eventDays: 90 }, coexistence: "dedicated" };
    const route = (action: string, body: unknown) => http(r.port, "POST", "/api/settings/hub/setup" + action, r.headers, body);
    const p = await route("/prepare", input);
    expect(p.status, p.body).toBe(200);
    expect((await route("/test", { ref: p.body.ref })).status).toBe(200);
    expect((await route("/commit", { ref: p.body.ref })).status).toBe(200);
    r.internal.hubEffectsReady = true;
    await r.internal.applyHubSwitches();
    expect(r.internal.hubRuntime.currentHolds()).toEqual([]);
    return { input, webPort, memberPort, ca: readFileSync(join(r.home, "hub/web-tls/cert.pem"), "utf8") };
}
describe("#3428 actual host address route", () => {
    it("a held old sign-in cannot mint after SQL even when completion throws before config publication", async () => {
        let entered!: () => void, release!: () => void, armed = false;
        const enteredPromise = new Promise<void>(r => { entered = r; }), resume = new Promise<void>(r => { release = r; });
        const real = directoryDriver.createHubDirectory;
        vi.spyOn(directoryDriver, "createHubDirectory").mockImplementation((...args) => {
            const driver = real(...args), signIn = driver.signIn.bind(driver);
            driver.signIn = async (...input) => { const result = await signIn(...input); if (armed) {
                entered();
                await resume;
            } return result; };
            return driver;
        });
        const r = await fixture(), old = await initialize(r);
        armed = true;
        const login = https(old.webPort, old.ca, "POST", "/hub/v1/session", { origin: old.input.webOrigin, "content-type": "application/json" }, { login: "avery", password: "Dummy-person-only" })
            .catch(error => ({ status: 0, headers: {} as import("node:http").IncomingHttpHeaders, text: (error as Error).message }));
        try {
            await enteredPromise;
            let port = await freeHubPort();
            while ([old.webPort, old.memberPort].includes(port))
                port = await freeHubPort();
            const p = await r.call("/prepare", { origin: `https://127.0.0.1:${port}`, listen: { host: "127.0.0.1", port }, certificate: { mode: "generate" } });
            expect(p.status, JSON.stringify(p.body)).toBe(200);
            const decision = r.internal.hubRuntime.webAddressDecision() as HubWebAddressDecision, commit = decision.commit.bind(decision);
            vi.spyOn(decision, "commit").mockImplementation((op, current) => { commit(op, current); release(); throw Error("injected post-SQL failure"); });
            const moved = await r.call("/commit", { ref: p.body.ref });
            expect(moved.status).toBe(503);
            const ended = await login;
            expect([0, 401, 503]).toContain(ended.status);
            expect(ended.headers["set-cookie"]).toBeUndefined();
            const db = new Database(join(r.home, "hub/hub.sqlite"), { readonly: true });
            try {
                expect(db.prepare("SELECT COUNT(*) AS n FROM hub_sessions WHERE state='active'").get()).toEqual({ n: 0 });
                expect(db.prepare("SELECT revision FROM hub_web_address_head").get()).toEqual({ revision: 1 });
            }
            finally {
                db.close();
            }
        }
        finally {
            armed = false;
            release();
            await login;
        }
    }, 30000);
    it("refuses all non-D3 callers before lazily constructing the control", async () => {
        const r = await fixture(), create = vi.spyOn(r.fm, "hubWebAddress"), chat = await r.signin(r.fm.issueDashboardLogin()!.display);
        const refusals: Record<string, string>[] = [{ cookie: chat.cookie, [WEB_CSRF_HEADER]: csrfTokenFor(chat.id) }, { origin: "https://outside.example.test" }, { [WEB_CSRF_HEADER]: "wrong" }, { "x-agend-token": r.token }, { authorization: "Bearer " + r.token }, { "x-forwarded-for": "198.51.100.1" }, { host: "outside.example.test" }];
        for (const extra of refusals) {
            expect((await r.call("/prepare", {}, extra)).status).toBe(403);
        }
        expect(create).not.toHaveBeenCalled();
        expect(r.peer.bindRecords).toHaveLength(0);
    }, 20000);
    it("moves real HTTPS, invalidates same-host old cookies, refuses the old port and preserves member identity", async () => {
        const r = await fixture(), old = await initialize(r), before = structuredClone(r.fm.getRawFleetConfig().hub), identity = readFileSync(join(r.home, "hub/keys/identity.json"));
        const login = await https(old.webPort, old.ca, "POST", "/hub/v1/session", { origin: old.input.webOrigin, "content-type": "application/json" }, { login: "avery", password: "Dummy-person-only" });
        expect(login.status, login.text).toBe(200);
        const cookie = login.headers["set-cookie"]![0]!.split(";")[0]!;
        let next = await freeHubPort();
        while ([old.webPort, old.memberPort].includes(next))
            next = await freeHubPort();
        const candidate = { origin: `https://127.0.0.1:${next}`, listen: { host: "127.0.0.1", port: next }, certificate: { mode: "generate" } };
        const prepared = await r.call("/prepare", candidate);
        expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
        expect(prepared.body.summary).toMatchObject({ sessionsEnd: true, from: old.input.webOrigin, to: candidate.origin });
        const result = await r.call("/commit", { ref: prepared.body.ref });
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        expect(result.body.state).toBe("ready");
        const after = r.fm.getRawFleetConfig().hub as any, ca = readFileSync(join(r.home, after.webTls.certificateFile), "utf8");
        expect((await https(next, ca, "GET", "/ui/hub")).status).toBe(200);
        const oldSession = await https(next, ca, "GET", "/hub/v1/session", { cookie });
        expect(oldSession.status).toBe(200);
        expect(JSON.parse(oldSession.text).signedIn).toBe(false);
        expect((await https(next, ca, "GET", "/hub/v1/rooms", { cookie })).status).toBe(401);
        await expect(https(old.webPort, old.ca, "GET", "/ui/hub")).rejects.toMatchObject({ code: "ECONNREFUSED" });
        expect(after.memberOrigin).toBe((before as any).memberOrigin);
        expect(after.memberListen).toEqual((before as any).memberListen);
        expect(readFileSync(join(r.home, "hub/keys/identity.json"))).toEqual(identity);
        expect(r.internal.hubRuntime.currentHolds()).toEqual([]);
        expect(verifyHubInitialization({ home: r.home, hubId: after.hubId, memberOrigin: after.memberOrigin, planDigest: hubPlanDigest(after) })).toBeTruthy();
        const db = new Database(join(r.home, "hub/hub.sqlite"), { readonly: true });
        try {
            expect(db.prepare("SELECT revision FROM hub_web_address_head").get()).toEqual({ revision: 1 });
        }
        finally {
            db.close();
        }
    }, 30000);
    it("a bind competitor after SQL returns saved-unavailable without reopening the old address", async () => {
        const r = await fixture(), old = await initialize(r);
        let port = await freeHubPort();
        while ([old.webPort, old.memberPort].includes(port))
            port = await freeHubPort();
        const candidate = { origin: `https://127.0.0.1:${port}`, listen: { host: "127.0.0.1", port }, certificate: { mode: "generate" } }, p = await r.call("/prepare", candidate);
        expect(p.status).toBe(200);
        const server = createServer(), realApply = r.internal.applyHubSwitches.bind(r.internal);
        let bound: Promise<void> | undefined;
        const spy = vi.spyOn(r.internal, "applyHubSwitches").mockImplementation(async () => {
            if ((r.fm.getRawFleetConfig().hub as Record<string, unknown> | undefined)?.webOrigin === candidate.origin)
                await (bound ??= new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); }));
            await realApply();
        });
        try {
            const result = await r.call("/commit", { ref: p.body.ref });
            expect(result.status, JSON.stringify(result.body)).toBe(200);
            expect(result.body.state).toBe("saved_unavailable");
            const after = r.fm.getRawFleetConfig().hub as any;
            expect(after.webOrigin).toBe(candidate.origin);
            expect(verifyHubInitialization({ home: r.home, hubId: after.hubId, memberOrigin: after.memberOrigin, planDigest: hubPlanDigest(after) })).toBeTruthy();
            await expect(https(old.webPort, old.ca, "GET", "/ui/hub")).rejects.toMatchObject({ code: "ECONNREFUSED" });
            expect(r.internal.hubRuntime.currentHolds()).not.toContain("hub-unsealed");
        }
        finally {
            spy.mockRestore();
            if (server.listening)
                await new Promise<void>(resolve => server.close(() => resolve()));
        }
    }, 30000);
    it("rechecks a newly occupied candidate bind before the decision and keeps the old Hub running", async () => {
        const r = await fixture(), old = await initialize(r);
        let port = await freeHubPort();
        while ([old.webPort, old.memberPort].includes(port))
            port = await freeHubPort();
        const before = structuredClone(r.fm.getRawFleetConfig().hub), candidate = { origin: `https://127.0.0.1:${port}`, listen: { host: "127.0.0.1", port }, certificate: { mode: "generate" } };
        const p = await r.call("/prepare", candidate);
        expect(p.status, JSON.stringify(p.body)).toBe(200);
        const server = createServer();
        await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
        try {
            const result = await r.call("/commit", { ref: p.body.ref });
            expect(result.status).toBe(409);
            expect(result.body.code).toBe("port_in_use");
            expect(r.fm.getRawFleetConfig().hub).toEqual(before);
            expect((await https(old.webPort, old.ca, "GET", "/ui/hub")).status).toBe(200);
        }
        finally {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    }, 30000);
});
