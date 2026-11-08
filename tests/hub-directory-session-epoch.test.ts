/** Owned loopback HTTPS, private SQLite and fake people only. No fleet/service or real directory. */
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer, request } from "node:https";
import { applyHubMigrations, createHubUnitOfWork, hubTxDatabase, openHubDatabase } from "../src/hub/db.js";
import { createHubHttp, HUB_HTTP_MIGRATIONS, type HubHttp } from "../src/hub/http/compose.js";
import { HubPairingService } from "../src/hub/pairing.js";
import { HUB_TRANSPORT_MIGRATION, HubTransportStore } from "../src/hub/store.js";
import { issuerKeyId, signAsker } from "../src/hub/identity.js";
import { createBrowserCertificate } from "../src/hub/init/browser-certificate.js";
import type { HubDirectory } from "../src/hub/directory/types.js";
import { tempDir } from "./support/hub-init-fixtures.js";
import { advanceHubSessionEpoch, readHubSessionEpoch, HUB_SESSION_EPOCH_MIGRATION } from "../src/hub/session-epoch.js";
import { HubSessions } from "../src/hub/sessions.js";
import { HubCore } from "../src/hub/http/core.js";

function held() {
  let enter!: () => void, release!: () => void;
  return { entered: new Promise<void>(r => { enter = r; }), wait: new Promise<void>(r => { release = r; }), enter: () => enter(), release: () => release() };
}

async function httpsRig() {
  const home = tempDir("hub-epoch-"), path = join(home, "hub", "test.sqlite");
  const material = await createBrowserCertificate(home, "https://127.0.0.1");
  const cert = readFileSync(material.certFile), key = readFileSync(material.keyFile);
  const person = { realm: "fictional", objectId: randomUUID() }, hubId = randomUUID(), keys = generateKeyPairSync("ed25519");
  const found = { key: person, login: "avery", dn: "fictional", groups: [], displayName: "Avery (fictional)" };
  let signInHold: ReturnType<typeof held> | undefined, eligibilityHold: ReturnType<typeof held> | undefined;
  let signInCalls = 0, now = 1_000_000, auditHook: (() => void) | undefined;
  const directory: HubDirectory = {
    realm: person.realm,
    async signIn(login, password) {
      signInCalls++;
      const h = signInHold; if (h) { h.enter(); await h.wait; }
      return login === "avery" && password === "dummy-password" ? { ok: true, person: found } : { ok: false, reason: "invalid-credentials" };
    },
    async checkEligibility() {
      const h = eligibilityHold; if (h) { h.enter(); await h.wait; }
      return { eligible: true, person: found };
    },
    async close() {},
  };
  let db = openHubDatabase(home, "hub/test.sqlite", { create: true });
  let http: HubHttp, port = 0, origin = "", floor = 0;
  let server: ReturnType<typeof createServer>;
  const open = async () => {
    applyHubMigrations(db, [HUB_TRANSPORT_MIGRATION, ...HUB_HTTP_MIGRATIONS]);
    db.exec("CREATE TABLE IF NOT EXISTS test_audit(value TEXT NOT NULL)");
    const store = new HubTransportStore(db, { floor: { read: () => floor, raise: n => { floor = n; } },
      appendAudit: (record, owningDb) => { owningDb.prepare("INSERT INTO test_audit VALUES(?)").run(JSON.stringify(record)); } });
    if (!db.prepare("SELECT 1 FROM hub_transport_state").get()) store.initialize();
    server = createServer({ cert, key }, (req, res) => { if (!http.handle(req, res)) { res.writeHead(404); res.end(); } });
    await new Promise<void>(r => server.listen(port, "127.0.0.1", r));
    port = (server.address() as { port: number }).port; origin = `https://127.0.0.1:${port}`;
    const pairing = new HubPairingService({ store, directory, enabled: () => true, fenceFleet() {},
      identity: { hubId, memberOrigin: "https://member.example.test", webOrigin: origin, spkiSha256: "a".repeat(64),
        issuerPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString() } });
    http = createHubHttp({ store, directory, pairing, config: { hubId, name: "Fictional", memberOrigin: "https://member.example.test", webOrigin: origin, administrator: person },
      uow: createHubUnitOfWork(db), audit: { append(tx, record) {
        hubTxDatabase(tx).prepare("INSERT INTO test_audit VALUES(?)").run(JSON.stringify(record)); const hook = auditHook; auditHook = undefined; hook?.();
      }, async read() { return []; }, async readContent(): Promise<never> { throw Error("not used"); } },
      issuer: { keyId: issuerKeyId(keys.publicKey), sign: e => signAsker(e, keys.privateKey) }, content: { put(): never { throw Error("not used"); }, get() { return undefined; } },
      transport: () => null, current: () => ({ serverEnabled: () => true, memberEnabled: () => false, epoch: () => 0 }),
      now: () => now,
    }, hubTxDatabase);
  };
  const stop = async () => { await http.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); db.close(); };
  await open();
  type Browser = { cookie: string; csrf: string };
  const call = (browser: Browser | null, method: string, path: string, value?: unknown) => new Promise<{ status: number; json: any; cookie: string }>((resolve, reject) => {
    const body = value === undefined ? undefined : JSON.stringify(value);
    const req = request(origin + path, { method, ca: cert, agent: false, headers: { Origin: origin, ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
      ...(browser ? { Cookie: browser.cookie, "X-AgEnD-Hub-CSRF": browser.csrf } : {}) } }, res => {
      let text = ""; res.on("data", b => { text += b; }); res.on("end", () => {
        try { resolve({ status: res.statusCode!, json: JSON.parse(text), cookie: (res.headers["set-cookie"]?.[0] ?? "").split(";")[0]! }); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject); req.end(body);
  });
  return { get db() { return db; }, get signInCalls() { return signInCalls; }, call, person,
    signIn: async () => { const r = await call(null, "POST", "/hub/v1/session", { login: "avery", password: "dummy-password" }); return { ...r, csrf: r.json.csrf as string }; },
    holdSignIn: () => (signInHold = held()), holdEligibility: () => (eligibilityHold = held()),
    advance: () => db.transaction(() => advanceHubSessionEpoch(db, readHubSessionEpoch(db))).immediate(),
    tick: () => { now += 1000; }, auditOnce: (hook: () => void) => { auditHook = hook; },
    restart: async () => { await stop(); db = openHubDatabase(home, "hub/test.sqlite", { create: false }); await open(); },
    close: async () => { signInHold?.release(); eligibilityHold?.release(); await stop(); material.cleanup(); rmSync(home, { recursive: true, force: true }); expect(existsSync(home)).toBe(false); },
  };
}

let rig: Awaited<ReturnType<typeof httpsRig>> | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; vi.restoreAllMocks(); });

describe("directory generation fences on real Hub HTTPS sessions", () => {
  it("refuses a held old-directory sign-in after the durable epoch changes, without creating a person or session", async () => {
    const r = rig = await httpsRig(), h = r.holdSignIn();
    const pending = r.signIn(); await h.entered; r.advance(); h.release();
    const result = await pending;
    expect(result.status).toBe(503); expect(result.cookie).toBe("");
    expect(r.db.prepare("SELECT COUNT(*) AS n FROM hub_people").get()).toEqual({ n: 0 });
    expect(r.db.prepare("SELECT COUNT(*) AS n FROM hub_sessions").get()).toEqual({ n: 0 });
  });
  it("keeps the same held-sign-in control working when the epoch stays current", async () => {
    const r = rig = await httpsRig(), h = r.holdSignIn(), pending = r.signIn(); await h.entered; h.release();
    expect((await pending).status).toBe(200);
  });
  it("rejects an old cookie after physically reopening SQLite and HTTPS, even for the same immutable person", async () => {
    const r = rig = await httpsRig(), old = await r.signIn(); expect(old.status).toBe(200);
    r.advance(); await r.restart();
    expect((await r.call(old, "GET", "/hub/v1/session")).json.signedIn).toBe(false);
    expect((await r.call(old, "GET", "/hub/v1/exposures")).status).toBe(401);
    const fresh = await r.signIn(); expect(fresh.status).toBe(200);
    expect((await r.call(fresh, "GET", "/hub/v1/exposures")).status).toBe(200);
    expect(r.db.prepare("SELECT directory_epoch FROM hub_sessions WHERE state='active'").all()).toEqual([{ directory_epoch: 1 }]);
  });
  it("refuses a stale active token row by epoch, not only its ended state", async () => {
    const r = rig = await httpsRig(), old = await r.signIn();
    r.advance(); r.db.prepare("UPDATE hub_sessions SET state='active'").run(); await r.restart();
    expect((await r.call(old, "GET", "/hub/v1/session")).json.signedIn).toBe(false);
  });
  it("does not send another password to the old mounted directory after advancement", async () => {
    const r = rig = await httpsRig(); r.advance();
    expect((await r.signIn()).status).toBe(503); expect(r.signInCalls).toBe(0);
  });
  it("keeps a captured real HTTP context invalid even when the immutable person is unchanged", async () => {
    const r = rig = await httpsRig(), old = await r.signIn();
    const spy = vi.spyOn(HubSessions.prototype, "context");
    await r.call(old, "GET", "/hub/v1/session");
    const ctx = spy.mock.results.at(-1)!.value as ReturnType<HubSessions["context"]>;
    expect(ctx.isCurrent?.()).toBe(true); r.advance();
    expect(ctx.isCurrent?.()).toBe(false); await expect(ctx.requireAdmin()).rejects.toMatchObject({ code: "revoked" });
  });
  it("rejects held eligibility before its old directory result can update people", async () => {
    const r = rig = await httpsRig(), old = await r.signIn();
    const before = r.db.prepare("SELECT last_checked_at FROM hub_people").get(); r.tick();
    const h = r.holdEligibility(), pending = r.call(old, "GET", "/hub/v1/exposures");
    await h.entered; r.advance(); h.release();
    expect((await pending).status).toBe(503);
    expect(r.db.prepare("SELECT last_checked_at FROM hub_people").get()).toEqual(before);
  });
  it("rolls back person/session/audit insertion if an audit callback advances the epoch", async () => {
    const r = rig = await httpsRig(); r.auditOnce(() => { r.advance(); });
    expect((await r.signIn()).status).toBe(503);
    expect(readHubSessionEpoch(r.db)).toBe(0);
    for (const table of ["hub_people", "hub_sessions", "test_audit"]) expect(r.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  });
  it("does not enter an old HTTP core's transaction callback after advancement", async () => {
    const r = rig = await httpsRig(), spy = vi.spyOn(HubCore.prototype, "atomic"); await r.signIn();
    const core = spy.mock.instances[0] as HubCore;
    let entered = 0; core.atomic(() => { entered++; }); expect(entered).toBe(1);
    r.advance(); expect(() => core.atomic(() => { entered++; })).toThrow(); expect(entered).toBe(1);
  });
  it("a member-only revocation version bump does not stand in for a browser epoch change", async () => {
    const r = rig = await httpsRig(), old = await r.signIn();
    const row = r.db.prepare("SELECT state FROM hub_transport_state").get() as { state: string }, state = JSON.parse(row.state);
    state.revocationVersion++; r.db.prepare("UPDATE hub_transport_state SET state=?").run(JSON.stringify(state));
    expect(readHubSessionEpoch(r.db)).toBe(0);
    expect((await r.call(old, "GET", "/hub/v1/session")).json.signedIn).toBe(true);
  });
});

describe("directory epoch's owning-transaction seam", () => {
  function schema() {
    const db = new Database(":memory:");
    applyHubMigrations(db, HUB_HTTP_MIGRATIONS);
    return db;
  }
  it("requires an existing transaction and an exact safe expected epoch", () => {
    const db = schema();
    try {
      expect(() => advanceHubSessionEpoch(db, 0)).toThrow();
      expect(() => db.transaction(() => advanceHubSessionEpoch(db, -1)).immediate()).toThrow();
      expect(() => db.transaction(() => advanceHubSessionEpoch(db, 1)).immediate()).toThrow();
      expect(readHubSessionEpoch(db)).toBe(0);
      expect(db.transaction(() => advanceHubSessionEpoch(db, 0)).immediate()).toBe(1);
      expect(() => db.transaction(() => advanceHubSessionEpoch(db, 0)).immediate()).toThrow();
      db.prepare("UPDATE hub_directory_epoch SET epoch=?").run(Number.MAX_SAFE_INTEGER);
      expect(() => db.transaction(() => advanceHubSessionEpoch(db, Number.MAX_SAFE_INTEGER)).immediate()).toThrow();
    } finally { db.close(); }
  });
  it("rolls back its advancement with a failed owning decision instead of committing separately", () => {
    const db = schema();
    try {
      expect(() => db.transaction(() => { advanceHubSessionEpoch(db, 0); throw Error("required decision audit refused"); }).immediate()).toThrow("audit refused");
      expect(readHubSessionEpoch(db)).toBe(0);
    } finally { db.close(); }
  });
  it("never recreates a lost epoch row or half-missing schema at zero", () => {
    const db = schema();
    try {
      db.prepare("DELETE FROM hub_directory_epoch").run();
      expect(() => readHubSessionEpoch(db)).toThrow(); expect(() => HUB_SESSION_EPOCH_MIGRATION.up(db)).toThrow();
      expect(db.prepare("SELECT * FROM hub_directory_epoch").all()).toEqual([]);
      db.exec("DROP TABLE hub_directory_epoch"); expect(() => HUB_SESSION_EPOCH_MIGRATION.up(db)).toThrow();
    } finally { db.close(); }
  });
  it("migrates the previous schema once and makes older binaries refuse the new component", () => {
    const db = new Database(":memory:"), old = HUB_HTTP_MIGRATIONS.filter(m => m !== HUB_SESSION_EPOCH_MIGRATION);
    try {
      applyHubMigrations(db, old); applyHubMigrations(db, HUB_HTTP_MIGRATIONS); applyHubMigrations(db, HUB_HTTP_MIGRATIONS);
      expect(readHubSessionEpoch(db)).toBe(0);
      expect(() => applyHubMigrations(db, old)).toThrow("s3-session-epoch");
    } finally { db.close(); }
  });
  it("refuses a partial schema whose epoch table exists without session epoch columns", () => {
    const db = new Database(":memory:");
    try {
      applyHubMigrations(db, HUB_HTTP_MIGRATIONS.filter(m => m !== HUB_SESSION_EPOCH_MIGRATION));
      db.exec("CREATE TABLE hub_directory_epoch(singleton INTEGER PRIMARY KEY, epoch INTEGER NOT NULL); INSERT INTO hub_directory_epoch VALUES(1,7)");
      expect(() => HUB_SESSION_EPOCH_MIGRATION.up(db)).toThrow();
      expect(readHubSessionEpoch(db)).toBe(7);
    } finally { db.close(); }
  });
  it("refuses an unsafe persisted epoch instead of rounding it into valid authority", () => {
    const db = schema();
    try {
      db.prepare("UPDATE hub_directory_epoch SET epoch=?").run(Number.MAX_SAFE_INTEGER + 1);
      expect(() => readHubSessionEpoch(db)).toThrow();
    } finally { db.close(); }
  });
});
