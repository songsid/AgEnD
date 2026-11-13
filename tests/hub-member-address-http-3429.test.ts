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
import type { HubMemberAddressDecision } from "../src/hub/settings-member-address-decision.js";
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
    const call = (action: string, body?: unknown, extra: Record<string, string> = {}) => http(port, body === undefined ? "GET" : "POST", "/api/settings/hub/member-address" + action, { ...headers, ...extra }, body);
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
describe("#3429 actual host member-address route", () => {
    it("refuses all non-D3 callers before constructing the control or reading affected fleets", async () => {
        const r = await fixture(), create = vi.spyOn(r.fm, "hubMemberAddress"), chat = await r.signin(r.fm.issueDashboardLogin()!.display);
        const refusals: Record<string, string>[] = [{ cookie: chat.cookie, [WEB_CSRF_HEADER]: csrfTokenFor(chat.id) }, { origin: "https://outside.example.test" },
          { [WEB_CSRF_HEADER]: "wrong" }, { "x-agend-token": r.token }, { "x-forwarded-for": "198.51.100.1" }, { host: "outside.example.test" }];
        for (const extra of refusals) {
            expect((await r.call("/prepare", {}, extra)).status).toBe(403);
        }
        expect(create).not.toHaveBeenCalled(); expect(r.peer.bindRecords).toHaveLength(0);
    }, 20000);
    it("moves only member HTTPS, preserves browser login and exact Hub identity, and leaves a durable admin/host notice", async () => {
        const r = await fixture(), old = await initialize(r), before = structuredClone(r.fm.getRawFleetConfig().hub), keys = ["issuer-key.pem", "tls-key.pem"].map(n => readFileSync(join(r.home, "hub/keys", n)));
        const login = await https(old.webPort, old.ca, "POST", "/hub/v1/session", { origin: old.input.webOrigin, "content-type": "application/json" }, { login: "avery", password: "Dummy-person-only" });
        expect(login.status, login.text).toBe(200); const cookie = login.headers["set-cookie"]![0]!.split(";")[0]!;
        let port = await freeHubPort(); while ([old.webPort, old.memberPort].includes(port)) port = await freeHubPort();
        const candidate = { origin: `https://127.0.0.1:${port}`, listen: { host: "127.0.0.1", port } };
        const p = await r.call("/prepare", candidate); expect(p.status, JSON.stringify(p.body)).toBe(200);
        expect(p.body.summary).toMatchObject({ fleetsRejoin: true, fleets: [], from: old.input.memberOrigin, to: candidate.origin });
        const moved = await r.call("/commit", { ref: p.body.ref }); expect(moved.status, JSON.stringify(moved.body)).toBe(200); expect(moved.body.state).toBe("ready");
        const after = r.fm.getRawFleetConfig().hub as any;
        expect(after).toMatchObject({ webOrigin: old.input.webOrigin, webListen: old.input.webListen, webTls: (before as any).webTls, memberOrigin: candidate.origin, memberListen: candidate.listen });
        expect(["issuer-key.pem", "tls-key.pem"].map(n => readFileSync(join(r.home, "hub/keys", n)))).toEqual(keys);
        expect(verifyHubInitialization({ home: r.home, hubId: after.hubId, memberOrigin: after.memberOrigin, planDigest: hubPlanDigest(after) })).toBeTruthy();
        expect(JSON.parse((await https(old.webPort, old.ca, "GET", "/hub/v1/session", { cookie })).text).signedIn).toBe(true);
        const notices = await https(old.webPort, old.ca, "GET", "/hub/v1/security-notices/member-address", { cookie });
        expect(notices.status, notices.text).toBe(200); expect(JSON.parse(notices.text).rows).toMatchObject([{ id: moved.body.receiptId, action: "reconnect", webOrigin: old.input.webOrigin }]);
        expect((await r.call("/notices")).body.rows).toHaveLength(1);
        const material = (await import("../src/hub/tls.js")).readHubMemberTls({ home: r.home });
        expect((await https(port, material.certificatePem, "GET", "/ui/hub")).status).toBe(404);
        await expect(https(old.memberPort, material.certificatePem, "GET", "/ui/hub")).rejects.toMatchObject({ code: "ECONNREFUSED" });
        expect(r.internal.hubRuntime.currentHolds()).toEqual([]);
    }, 30000);
    it("cold restart finishes a committed identity+manifest when saving the fleet config was interrupted", async () => {
        const r = await fixture(), old = await initialize(r);
        let port = await freeHubPort(); while ([old.webPort, old.memberPort].includes(port)) port = await freeHubPort();
        const candidate = { origin: `https://127.0.0.1:${port}`, listen: { host: "127.0.0.1", port } }, p = await r.call("/prepare", candidate);
        expect(p.status, JSON.stringify(p.body)).toBe(200);
        const save = r.internal.saveFleetConfig.bind(r.internal), spy = vi.spyOn(r.internal, "saveFleetConfig").mockImplementation((...args: unknown[]) => {
          const patches = args[0] as Array<{ path: string[] }>;
          if (patches.some(patch => patch.path.join(".") === "hub.memberOrigin")) throw Error("injected fleet save interruption");
          return save(...args);
        });
        try {
          expect((await r.call("/commit", { ref: p.body.ref })).status).toBe(503);
          expect((r.fm.getRawFleetConfig().hub as any).memberOrigin).toBe(old.input.memberOrigin);
          expect(JSON.parse(readFileSync(join(r.home, "hub/keys/identity.json"), "utf8")).memberOrigin).toBe(candidate.origin);
          expect(r.internal.hubSettingsWriter.pendingMemberAddress()).toBe(true);
        } finally { spy.mockRestore(); }
        await r.internal.hubRuntime.close(); r.internal.hubRuntime = null; r.internal.hubRuntimeInit = null;
        await r.internal.applyHubSwitches();
        expect(r.internal.hubRuntime.currentHolds()).toEqual([]);
        expect((r.fm.getRawFleetConfig().hub as any).memberOrigin).toBe(candidate.origin);
        expect(r.internal.hubSettingsWriter.pending()).toBe(false);
        const db = new Database(join(r.home, "hub/hub.sqlite"), { readonly: true });
        try {
          expect(db.prepare("SELECT revision FROM hub_member_address_head").get()).toEqual({ revision: 1 });
          expect(db.prepare("SELECT count(*) n FROM hub_member_address_notices").get()).toEqual({ n: 1 });
        } finally { db.close(); }
        expect((await https(old.webPort, old.ca, "GET", "/ui/hub")).status).toBe(200);
    }, 30000);
    it("a competitor before SQL keeps the old member listener and config; after SQL it stays saved-unavailable", async () => {
        const r = await fixture(), old = await initialize(r);
        for (const afterSql of [false, true]) {
          let port = await freeHubPort(); while ([old.webPort, old.memberPort].includes(port)) port = await freeHubPort();
          const candidate = { origin: `https://127.0.0.1:${port}`, listen: { host: "127.0.0.1", port } }, p = await r.call("/prepare", candidate);
          expect(p.status, JSON.stringify(p.body)).toBe(200);
          const before = structuredClone(r.fm.getRawFleetConfig().hub), server = createServer(); let bound: Promise<void> | undefined;
          const bind = () => bound ??= new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
          const apply = r.internal.applyHubSwitches.bind(r.internal), spy = vi.spyOn(r.internal, "applyHubSwitches").mockImplementation(async () => {
            if (afterSql && (r.fm.getRawFleetConfig().hub as any).memberOrigin === candidate.origin) await bind(); await apply();
          });
          try {
            if (!afterSql) await bind();
            const result = await r.call("/commit", { ref: p.body.ref });
            if (!afterSql) { expect(result.status).toBe(409); expect(result.body.code).toBe("port_in_use"); expect(r.fm.getRawFleetConfig().hub).toEqual(before); }
            else { expect(result.status, JSON.stringify(result.body)).toBe(200); expect(result.body.state).toBe("saved_unavailable"); expect((r.fm.getRawFleetConfig().hub as any).memberOrigin).toBe(candidate.origin); }
          } finally { spy.mockRestore(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); }
        }
    }, 30000);
});
