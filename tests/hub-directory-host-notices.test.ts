/** Real fleet HTTP/D3 and existing WAL state after an owned mount refusal; no real LDAP, account or native manager. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import Database from "better-sqlite3";
import { FleetManager } from "../src/fleet-manager.js";
import { HubRuntime } from "../src/hub/runtime.js";
import { createHubInitializer } from "../src/hub/init/initializer.js";
import { hubIdentityProvider } from "../src/hub/init/identity.js";
import { createHubSettingsWriter } from "../src/hub/settings-commit.js";
import { atomicWriteFileSync } from "../src/atomic-write.js";
import { ADMIN, makeTestCerts, tempDir } from "./support/hub-init-fixtures.js";
import { freeHubPort } from "./helpers/hub-rig.js";
import { csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { WebSessionStore } from "../src/web-session.js";
import { WEB_CSRF_HEADER } from "../src/web-auth.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import * as directory from "../src/hub/directory/directory.js";
import * as auditModule from "../src/hub/audit/index.js";
import { hubServerDatabasePlan } from "../src/hub/compose/server.js";
import { HUB_HTTP_MIGRATIONS } from "../src/hub/http/schema.js";
import { withHubDirectoryNoticeRecovery } from "../src/hub/settings-directory-recovery.js";
import type { HubDirectoryNotices } from "../src/hub/settings-directory-notices.js";
import { SERVER_SET } from "../src/hub/compose/storage.js";

const prefix = "/api/settings/hub/security-notices/directory";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; body: any; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let text = ""; res.on("data", data => { text += data; });
      res.on("end", () => { try { resolve({ status: res.statusCode!, body: JSON.parse(text || "{}"), headers: res.headers }); } catch (error) { reject(error); } });
    }); req.on("error", reject); req.end(body);
  });
}
async function fixture() {
  const home = tempDir("hub-host-notices-"), certs = makeTestCerts(), configPath = join(home, "fleet.yaml");
  const memberPort = await freeHubPort(); let webPort = await freeHubPort(); while (memberPort === webPort) webPort = await freeHubPort();
  const plan = { name: "Fictional Host Hub", webOrigin: `https://hub.example.test:${webPort}`, memberOrigin: `https://hub.example.test:${memberPort}`,
    webListen: { host: "127.0.0.1", port: webPort }, memberListen: { host: "127.0.0.1", port: memberPort },
    webTls: { certFile: certs.cert, keyFile: certs.key }, directory: { realm: "corp", url: "ldaps://directory.example.test:636",
      baseDn: "DC=example,DC=test", bindDn: "CN=Reader,DC=example,DC=test", profile: "ad" as const },
    bindPasswordRef: "file:hub/secrets/directory-bind", administrator: ADMIN.key, retention: { contentDays: 30, eventDays: 90 }, coexistence: "dedicated" as const };
  const init = createHubInitializer({ home, identity: hubIdentityProvider(), probe: { pidAlive: () => false } });
  const confirmation = await init.prepareConfirmation(plan, { bindPassword: "Dummy-old-service-only" }); await init.commit(plan, confirmation.reference);
  const config = yaml.load(readFileSync(configPath, "utf8")) as { hub: Record<string, unknown>; web?: unknown };
  let runtime!: HubRuntime;
  const writer = createHubSettingsWriter({ home, readHub: () => config.hub, directoryDecision: () => runtime.directoryDecision(), saveHub: patches => {
    for (const patch of patches) { if (patch.remove) delete config.hub[patch.path[1]!]; else config.hub[patch.path[1]!] = patch.value; }
    atomicWriteFileSync(configPath, yaml.dump(config), { mode: 0o600 });
  } });
  runtime = new HubRuntime({ home, settingsWriter: writer, log: () => {}, createDirectory: cfg => {
    if (cfg.url === "ldaps://refused.example.test") throw Error("owned replacement mount refusal");
    return { realm: "corp", signIn: async () => ({ ok: false, reason: "unavailable" }),
      checkEligibility: async () => ({ eligible: true, person: ADMIN }), close: async () => {} };
  } });
  try {
    await runtime.apply(config); expect(runtime.serverHealth(config.hub)).toBe("ready"); const mounted = runtime.directorySettings()!;
    const actor = { kind: "host-owner" as const, sessionId: "owned-host-fixture", requestId: randomUUID() };
    const draft = writer.directory!.prepare({ directory: { ...plan.directory, url: "ldaps://refused.example.test" }, bindPassword: "Dummy-new-service-only",
      changes: ["server", "secret"], recipients: [{ kind: "host", sink: "owner-needs-you" }, { kind: "person", person: ADMIN.key }] }, actor, mounted.current);
    writer.directory!.commit(draft.ref, actor, mounted.current); await runtime.apply(config);
    expect(runtime.serverHealth(config.hub)).toBe("unavailable"); expect(runtime.directorySettings()).toBeNull();
  } finally { await runtime.close(); }
  config.web = { verified_authority: { enabled: true } }; writeFileSync(configPath, yaml.dump(config), { mode: 0o600 });
  const fm = new FleetManager(home), internal = fm as any, sink = () => {};
  fm.logger = { info: sink, warn: sink, error: sink, debug: sink, trace: sink, fatal: sink, child: () => fm.logger } as any;
  vi.stubEnv("AGEND_FLEET_DATA_DIR", process.env.AGEND_FLEET_DATA_DIR); vi.stubEnv("AGEND_FLEET_CONFIG_PATH", process.env.AGEND_FLEET_CONFIG_PATH);
  fm.loadConfig(configPath); internal.initializeWebAuthTokens(); internal.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const port = internal.healthServer.address().port, origin = `http://127.0.0.1:${port}`, token = fm.getDashboardAccess().token!;
  async function signIn(code?: string) {
    code ??= (await call(port, "POST", "/auth/issue-code", { "x-agend-token": token, origin })).body.code;
    const reply = await call(port, "POST", "/auth/login", { origin, "content-type": "application/json" }, JSON.stringify({ code }));
    expect(reply.status).toBe(200); const cookie = reply.headers["set-cookie"]![0]!.split(";")[0]!, id = cookie.slice(cookie.indexOf("=") + 1);
    return { cookie, id };
  }
  const host = await signIn(), dbPath = join(home, "hub/hub.sqlite");
  const headers = (id = host.id) => ({ origin, cookie: `agend_session=${id}`, [WEB_CSRF_HEADER]: csrfTokenFor(id) });
  const inspect = <T>(read: (db: Database.Database) => T) => { const db = new Database(dbPath); try { return read(db); } finally { db.close(); } };
  const states = () => inspect(db => db.prepare("SELECT kind,state FROM hub_settings_security_targets ORDER BY kind").all());
  const auditCount = () => inspect(db => (db.prepare("SELECT count(*) n FROM hub_audit").get() as { n: number }).n);
  const cold = vi.spyOn(directory, "createHubDirectory");
  cleanups.push(async () => { const server = internal.healthServer as Server; internal.healthServer = null; server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); internal.webSessions?.flush?.();
    rmSync(home, { recursive: true, force: true }); rmSync(certs.dir, { recursive: true, force: true }); expect(existsSync(home)).toBe(false); });
  return { home, fm, internal, port, origin, token, host, headers, signIn, dbPath, inspect, states, auditCount, cold,
    request: (method = "GET", suffix = "", extra: Record<string, string> = {}, id = host.id) => call(port, method, prefix + suffix, { ...headers(id), ...extra }) };
}

describe.skipIf(process.platform === "win32")("host directory notices from existing held state", () => {
  it("reads and ACKs the host target after a real mount refusal without starting Hub, directory or setup", async () => {
    const r = await fixture(), page = await r.request(); expect(page.status).toBe(200); expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body.items).toHaveLength(1); expect(page.body.items[0]).toMatchObject({ kind: "directory", phase: "applying", acknowledged: false });
    const id = page.body.items[0].id;
    expect((await r.request("POST", `/${id}/ack`)).status).toBe(200);
    expect(r.states()).toEqual([{ kind: "host", state: "delivered" }, { kind: "person", state: "queued" }]);
    expect((await r.request()).body.items[0]).toMatchObject({ id, acknowledged: true });
    expect((await r.request("GET", "?unread=1")).body.items).toEqual([]);
    expect(r.cold).not.toHaveBeenCalled(); expect(r.internal.hubRuntime).toBeNull(); expect(r.internal.hubRuntimeInit).toBeNull();
    expect(r.internal.hubSetupController).toBeNull(); expect(r.internal.hubSetupInit).toBeNull();
  });
  it("refuses non-host, guest, header, public, forwarded and missing-CSRF authority before the cold factory", async () => {
    const r = await fixture(), create = vi.spyOn(r.fm, "hubDirectoryNotices"), other = await r.signIn(r.fm.issueDashboardLogin()!.display);
    const id = r.inspect(db => (db.prepare("SELECT id FROM hub_settings_security_notices").get() as { id: string }).id), before = r.auditCount();
    const attempts = [await r.request("GET", "", {}, other.id), await r.request("GET", "", { "x-agend-token": r.token }),
      await r.request("GET", "", { authorization: `Bearer ${r.token}` }), await r.request("GET", "", { "x-forwarded-for": "198.51.100.1" }),
      await r.request("GET", "", { host: "public.example.test" }), await r.request("POST", `/${id}/ack`, { [WEB_CSRF_HEADER]: "wrong" }),
      await r.request("POST", `/${id}/ack`, { origin: "https://outside.example.test" })];
    expect(attempts).toHaveLength(7); expect(attempts.every(a => a.status === 403)).toBe(true);
    const guest = r.internal.webSessions.create({ tier: "guest", surface: "local", label: "guest", owner: { adapterId: "test", userId: "guest" }, tokenEpoch: tokenEpoch(r.token) });
    expect([401, 403]).toContain((await r.request("GET", "", {}, guest.sessionId)).status);
    const req = { method: "GET", headers: { host: `127.0.0.1:${r.port}`, ...r.headers() }, socket: { remoteAddress: "127.0.0.1" } } as any;
    bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: r.origin, isCurrent: () => true });
    expect(r.fm.hubSetupSession(req)).toBeNull(); expect(create).not.toHaveBeenCalled(); expect(r.auditCount()).toBe(before);
  });
  it.each(["epoch", "session-store", "unchanged"] as const)("checks a held factory continuation against the original D3 proof: %s", async change => {
    const r = await fixture(), original = r.fm.hubDirectoryNotices.bind(r.fm); let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    const old = r.internal.webSessions, before = r.auditCount();
    const create = vi.spyOn(r.fm, "hubDirectoryNotices").mockImplementation(async () => { entered(); await held; return original(); });
    const pending = r.request();
    try {
      await ready; if (change === "epoch") r.fm.revokeWebAuthority(); if (change === "session-store") r.internal.webSessions = new WebSessionStore();
      release(); const reply = await pending;
      expect(reply.status).toBe(change === "unchanged" ? 200 : 403); expect(r.auditCount()).toBe(before + Number(change === "unchanged"));
    } finally { release(); await pending; r.internal.webSessions = old; create.mockRestore(); }
  });
  it("a disconnected held read cannot reach its later cold-state continuation", async () => {
    const r = await fixture(), original = r.fm.hubDirectoryNotices.bind(r.fm); let release!: () => void, entered!: () => void, closed!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; }), gone = new Promise<void>(resolve => { closed = resolve; });
    const before = r.auditCount(); let pendingFactory!: ReturnType<typeof original>, reads = 0;
    const create = vi.spyOn(r.fm, "hubDirectoryNotices").mockImplementation(() => pendingFactory = (async () => {
      entered(); await held; const control = await original(); return { ...control, read: (...args: Parameters<typeof control.read>) => { reads++; return control.read(...args); } };
    })());
    const observe = (_req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => res.once("close", closed);
    const server = r.internal.healthServer as Server; server.prependListener("request", observe);
    const req = request({ host: "127.0.0.1", port: r.port, method: "GET", path: prefix, headers: r.headers() });
    req.on("error", () => {}); req.end();
    try {
      await ready; req.destroy(); await gone; release(); await pendingFactory; await new Promise<void>(resolve => setImmediate(resolve));
      expect(reads).toBe(0); expect(r.auditCount()).toBe(before);
    } finally { release(); req.destroy(); await pendingFactory; create.mockRestore(); server.removeListener("request", observe); }
  });
  it("a failed required ACK audit rolls back the target and returns a bounded error", async () => {
    const r = await fixture(), id = r.inspect(db => (db.prepare("SELECT id FROM hub_settings_security_notices").get() as { id: string }).id), before = r.auditCount();
    r.inspect(db => db.exec("CREATE TRIGGER refuse_host_ack BEFORE UPDATE ON hub_settings_security_targets BEGIN SELECT RAISE(ABORT,'private fixture failure'); END"));
    expect(await r.request("POST", `/${id}/ack`)).toMatchObject({ status: 503, body: { error: "unavailable" } });
    expect(r.auditCount()).toBe(before); expect(r.states().every(row => (row as { state: string }).state === "queued")).toBe(true);
    r.inspect(db => db.exec("DROP TRIGGER refuse_host_ack")); expect((await r.request("POST", `/${id}/ack`)).status).toBe(200);
  });
  it.each(["epoch", "hub-id", "member-origin"] as const)("an audit-time %s change refuses the ACK and rolls its audit and target back", async change => {
    const r = await fixture(), id = r.inspect(db => (db.prepare("SELECT id FROM hub_settings_security_notices").get() as { id: string }).id), before = r.auditCount();
    const real = auditModule.createHubAudit;
    const audit = vi.spyOn(auditModule, "createHubAudit").mockImplementation(options => {
      const store = real(options), append = store.appendInTransaction.bind(store);
      return { ...store, appendInTransaction(record, db) { append(record, db); if (record.action === "directory.notice-acknowledged") {
        if (change === "epoch") r.fm.revokeWebAuthority();
        if (change === "hub-id") r.internal.rawFleetConfig.hub.hubId = randomUUID();
        if (change === "member-origin") r.internal.rawFleetConfig.hub.memberOrigin = "https://other.example.test:19444";
      } } };
    });
    try { expect((await r.request("POST", `/${id}/ack`)).status).toBe(503); }
    finally { audit.mockRestore(); }
    expect(r.auditCount()).toBe(before); expect(r.states().every(row => (row as { state: string }).state === "queued")).toBe(true);
  });
  it("never creates missing state or migrates a newer schema", async () => {
    const r = await fixture(), parked = r.dbPath + ".owned-test-copy"; renameSync(r.dbPath, parked);
    try { expect((await r.request()).status).toBe(503); expect(existsSync(r.dbPath)).toBe(false); }
    finally { renameSync(parked, r.dbPath); }
    const version = r.inspect(db => (db.prepare("SELECT version FROM hub_schema WHERE component='s5-directory-settings'").get() as { version: number }).version);
    r.inspect(db => db.prepare("UPDATE hub_schema SET version=? WHERE component='s5-directory-settings'").run(version + 1));
    expect((await r.request()).status).toBe(503);
    expect(r.inspect(db => (db.prepare("SELECT version FROM hub_schema WHERE component='s5-directory-settings'").get() as { version: number }).version)).toBe(version + 1);
    r.inspect(db => db.prepare("UPDATE hub_schema SET version=? WHERE component='s5-directory-settings'").run(version));
    for (const suffix of ["?target=other", "?limit=101", "?limit=1&limit=2", "?unread=yes", "?before=bad"]) expect((await r.request("GET", suffix)).status).toBe(400);
    expect((await r.request("PUT")).status).toBe(405); expect(r.cold).not.toHaveBeenCalled();
  });
  it("keeps a cold callback synchronous and expires its narrow facade before it can escape", async () => {
    const r = await fixture(), hub = r.fm.getRawFleetConfig().hub as Record<string, unknown>;
    const { settings, migrations } = hubServerDatabasePlan(hub, HUB_HTTP_MIGRATIONS);
    const options = { home: r.home, hubId: settings.hubId, memberOrigin: settings.memberOrigin, migrations,
      stateSet: { ...structuredClone(SERVER_SET) }, hostSink: "owner-needs-you", current: () => true };
    let escaped!: Readonly<Pick<HubDirectoryNotices, "forHost" | "acknowledgeHost">>, calls = 0;
    const ctx = { requestId: randomUUID(), current: () => true };
    withHubDirectoryNoticeRecovery(options, facade => { escaped = facade; expect(facade.forHost(ctx).items).toHaveLength(1); });
    expect(() => escaped.forHost(ctx)).toThrow(/unavailable/);
    expect(() => withHubDirectoryNoticeRecovery({ ...options, current: () => false }, () => { calls++; })).toThrow(/authority/);
    expect(calls).toBe(0);
    expect(() => withHubDirectoryNoticeRecovery(options, async () => 1)).toThrow(/synchronous/);
    const replaced = { ...options, migrations: options.migrations.map(row => ({ ...row })), stateSet: structuredClone(options.stateSet) }; let checked = 0;
    replaced.current = () => { if (checked++ === 0) {
      replaced.home = join(r.home, "must-not-open"); replaced.hubId = randomUUID(); replaced.hostSink = "other";
      replaced.migrations[0]!.version += 100;
      replaced.stateSet.database = "hub/must-not-open.sqlite";
    } return true; };
    let retained = 0;
    expect(() => { retained = withHubDirectoryNoticeRecovery(replaced, facade => facade.forHost(ctx).items.length); }).not.toThrow();
    expect(retained).toBe(1);
    expect(checked).toBeGreaterThan(0); expect(existsSync(join(r.home, "must-not-open"))).toBe(false);
  });
});
