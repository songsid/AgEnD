/**
 * S-51 (S5b): the runtime and the server factory over a REALLY initialized Hub (S5a init + S1 keys + sealed manifest in
 * a scratch home), with a fake S3 entry. Local listeners on 127.0.0.1 only; no directory is contacted (S2's client is
 * built but never signs in), nothing outside the scratch home is touched.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { request, Server as HttpsServer } from "node:https";
import { connect, createServer as createNetServer, type Socket } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verify, createPublicKey, randomUUID, createHash } from "node:crypto";
import yaml from "js-yaml";
import Database from "better-sqlite3";
import { createHubInitializer } from "../src/hub/init/initializer.js";
import { hubIdentityProvider } from "../src/hub/init/identity.js";
import { HubRuntime, effectiveHubView, hubSwitchesOn, type HubHold } from "../src/hub/runtime.js";
import { createHubServerFactory, hubServerDatabasePlan, type HubHttp, type HubHttpDeps, type HubHttpEntry } from "../src/hub/compose/server.js";
import { HubDirectoryResponseOwner, type HubDirectoryResponse } from "../src/hub/directory-response-owner.js";
import { HubServer } from "../src/hub/server.js";
import type { HubMountedService } from "../src/hub/mount.js";
import { ADMIN, makeTestCerts, type TestCerts } from "./support/hub-init-fixtures.js";
import { freeHubPort } from "./helpers/hub-rig.js";
import { readHubSecretFile } from "../src/hub/init/secret-file.js";
import { readPrivateFile } from "../src/hub/private-files.js";
import { HUB_SESSION_EPOCH_MIGRATION } from "../src/hub/session-epoch.js";
import { sealHubInitialization } from "../src/hub/initialization.js";
import { hubPlanDigest } from "../src/hub/init/plan-digest.js";
import { createHubSettingsWriter, HubSettingsError, type HubSettingsWriterDeps } from "../src/hub/settings-commit.js";
import { atomicWriteFileSync } from "../src/atomic-write.js";
import { hubSetCookie } from "../src/hub/sessions.js";
import { SERVER_SET } from "../src/hub/compose/storage.js";
import { createHubDirectorySettingsProof } from "../src/hub/settings-directory-proof.js";
import { createHubDirectorySaveCoordinator } from "../src/hub/settings-directory-save.js";
import { withHubDirectoryRecovery } from "../src/hub/settings-directory-recovery.js";
import type { HubDirectorySettingsDecision } from "../src/hub/settings-directory-decision.js";
import { createHubDirectorySettingsControl, type HubDirectorySettingsControl } from "../src/hub/settings-directory-control.js";
import type { HubDirectoryProofContext } from "../src/hub/settings-directory-proof.js";

const roots: string[] = [];
let sourceCerts: TestCerts;
beforeAll(() => {
  mkdirSync(".artifacts", { recursive: true });
  sourceCerts = makeTestCerts();
}, 120_000);
afterAll(() => { if (sourceCerts) rmSync(sourceCerts.dir, { recursive: true, force: true }); });
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});

const BIND = "Bind-" + "z".repeat(20);

async function initializedHub(bindPassword = BIND) {
  mkdirSync(".artifacts", { recursive: true });
  const home = mkdtempSync(join(process.cwd(), ".artifacts/hub-compose-"));
  chmodSync(home, 0o700);
  roots.push(home);
  const certs = sourceCerts;
  // Two probes in a row may get the same just-freed port from the OS (a flake: "must use different addresses"): ask again.
  const memberPort = await freeHubPort();
  let webPort = await freeHubPort();
  for (let i = 0; i < 20 && webPort === memberPort; i++) webPort = await freeHubPort();
  const plan = {
    name: "Compose Hub",
    webOrigin: `https://hub.example.test:${webPort}`,
    memberOrigin: `https://hub.example.test:${memberPort}`,
    memberListen: { host: "127.0.0.1", port: memberPort },
    webListen: { host: "127.0.0.1", port: webPort },
    webTls: { certFile: certs.cert, keyFile: certs.key },
    directory: { realm: "corp", url: "ldaps://directory.example.test", baseDn: "dc=example,dc=test", bindDn: "cn=reader,dc=example,dc=test", profile: "openldap" as const },
    bindPasswordRef: "file:hub/secrets/directory-bind",
    administrator: ADMIN.key,
    retention: { contentDays: 30, eventDays: 180 },
    coexistence: "dedicated" as const,
  };
  const init = createHubInitializer({ home, identity: hubIdentityProvider(), probe: { pidAlive: () => false } });
  const c = await init.prepareConfirmation(plan, { bindPassword });
  await init.commit(plan, c.reference);
  const config = yaml.load(readFileSync(join(home, "fleet.yaml"), "utf8")) as { hub: Record<string, unknown> };
  return { home, config, plan, webPort, memberPort, caPem: readFileSync(certs.caCert, "utf8") };
}

/** Owned fixture images only: these older factory tests intentionally bypass HubMount and need a valid full seal now. */
function sealFixtureHub(hub: Awaited<ReturnType<typeof initializedHub>>, cfg = hub.config.hub) {
  const path = join(hub.home, "hub/init-manifest.json"), manifest = JSON.parse(readFileSync(path, "utf8"));
  const planDigest = hubPlanDigest(cfg);
  writeFileSync(path, JSON.stringify({ ...manifest, planDigest, signature: sealHubInitialization({ home: hub.home,
    planDigest, confirmationId: manifest.confirmationId, committedAt: manifest.committedAt }) }), { mode: 0o600 });
  hub.config.hub = cfg;
  writeFileSync(join(hub.home, "fleet.yaml"), yaml.dump(hub.config), { mode: 0o600 });
}

function fakeHttp() {
  const state: { deps: HubHttpDeps | null; closed: number } = { deps: null, closed: 0 };
  const entry: HubHttpEntry = {
    migrations: [{ component: "s3-http", version: 1, up: (db) => db.exec("CREATE TABLE IF NOT EXISTS s3_rooms(id TEXT PRIMARY KEY); CREATE TABLE hub_sessions(id TEXT PRIMARY KEY)") }, HUB_SESSION_EPOCH_MIGRATION],
    createHubHttp(deps) {
      state.deps = deps;
      return {
        handle(req, res) {
          if (req.url !== "/hub/v1/ping") return false;
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ name: deps.config.name, transport: deps.transport() !== null }));
          return true;
        },
        receive: async () => undefined,
        close: async () => {
          state.closed += 1;
        },
      };
    },
  };
  return { entry, state };
}

function get(port: number, path: string, ca: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, servername: "hub.example.test", ca, method: "GET", agent: false }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function refused(port: number, dial: (port: number, host: string) => Socket = connect): Promise<boolean> {
  return new Promise((resolve) => {
    const s = dial(port, "127.0.0.1");
    let answer = true;
    s.once("connect", () => {
      // Linux can assign the target ephemeral port to this client: that socket talks to itself, not a Hub.
      answer = s.localAddress === s.remoteAddress && s.localPort === s.remotePort;
      s.destroy();
    });
    s.once("error", () => { answer = true; s.destroy(); });
    s.once("close", () => resolve(answer));
  });
}

describe.skipIf(process.platform !== "linux")("owned TCP refusal probe", () => {
  it("does not mistake a TCP self-connection for a listening Hub", async () => {
    const port = await freeHubPort();
    let tuple: { localAddress?: string; localPort?: number; remoteAddress?: string; remotePort?: number } | undefined;
    const answer = await refused(port, (target, host) => {
      const socket = connect({ host, port: target, localAddress: host, localPort: target });
      socket.once("connect", () => { tuple = { localAddress: socket.localAddress, localPort: socket.localPort,
        remoteAddress: socket.remoteAddress, remotePort: socket.remotePort }; });
      return socket;
    });
    expect(tuple).toEqual({ localAddress: "127.0.0.1", localPort: port, remoteAddress: "127.0.0.1", remotePort: port });
    expect(answer).toBe(true);
  });

  it("still reports a genuine owned listener as connected", async () => {
    const listener = createNetServer(socket => socket.destroy());
    await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
    try { expect(await refused((listener.address() as { port: number }).port)).toBe(false); }
    finally { await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); }
  });
});

function factory(home: string, http?: HubHttpEntry, extra: Partial<Pick<import("../src/hub/compose/server.js").HubServerFactoryOptions, "retentionReady" | "retentionEveryMs" | "browserCertificateReady" | "createDirectory" | "directoryReady">> = {}) {
  const reports: { code: string; detail: string }[] = [];
  const directories: { bindPassword: string }[] = [];
  const create = createHubServerFactory({
    home,
    components: http ? { http: async () => http } : {},
    createDirectory: (_config, secrets) => {
      directories.push(secrets);
      return { realm: "corp", signIn: async () => ({ ok: false, reason: "unavailable" }), checkEligibility: async () => ({ eligible: false, reason: "unavailable" }), close: async () => {} };
    },
    report: (code, detail) => reports.push({ code, detail }),
    log: () => {},
    ...extra,
  });
  return { create, reports, directories };
}

describe.skipIf(process.platform === "win32")("Hub server factory (S5b) over a really initialized Hub", () => {
  it("wires explicit manual enrollment into real pairing and its owning DB without a membership allowance", async () => {
    const hub = await initializedHub(), http = fakeHttp(), groupId = randomUUID();
    (hub.config.hub.directory as Record<string, unknown>).profile = "ad";
    sealFixtureHub(hub);
    const f = factory(hub.home, http.entry, { createDirectory: () => ({ realm: "corp", groupPolicy: "ad-direct-guid", signIn: vi.fn(), close: async () => {},
      checkEligibility: async () => ({ eligible: true, person: ADMIN }), readPolicyGroups: async () => ({ kind: "unknown" }) }) });
    const service = await f.create(hub.config.hub, () => true);
    const db = new Database(join(hub.home, "hub/hub.sqlite"));
    try {
      await service.start();
      // Private test pre-provisioning only: no activation route is exposed by the factory.
      const policy = JSON.parse((db.prepare("SELECT body FROM hub_group_policy").get() as { body: string }).body);
      Object.assign(policy, { state: "enabled", revision: policy.revision + 1,
        groups: [{ group: { realm: "corp", objectId: groupId }, dn: "CN=Members,DC=example,DC=test", allow: ["pair_fleet"], maxFleets: 1 }] });
      db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(policy));
      const { pairing, store } = http.state.deps!, ctx = { requestId: randomUUID(), current: vi.fn(), requirePerson: async () => ADMIN.key,
        requireAdmin: async () => ({ kind: "directory" as const, person: ADMIN.key, sessionId: "admin" }) };
      const offer = await pairing.create(ctx, ADMIN.key), pending = pairing.pair({ code: offer.code });
      await pairing.confirmOwner(ctx, pending.pairingId, pending.fingerprint); await pairing.approve(ctx, pending.pairingId, pending.fingerprint);
      const input = { pairingId: pending.pairingId, fleetId: pending.fleetId, claimSecret: pending.claimSecret };
      expect(store.read().fleets).toEqual([]);
      const claimed = await pairing.claim(input); expect(claimed.status).toBe("approved");
      if (claimed.status !== "approved") throw Error("positive claim refused");
      expect(pairing.authenticate(claimed.credential)).toMatchObject({ fleetId: pending.fleetId, owner: ADMIN.key });
      expect(db.prepare("SELECT source,state FROM hub_group_resources").all()).toEqual([{ source: "manual", state: "active" }]);
      expect((await get(hub.webPort, "/hub/v1/ping", hub.caPem)).status).toBe(200);
    } finally { db.close(); await service.close(); }
  });
  it.each(["\uFEFF Dummy-import-秘密\r\n", "Dummy-import-秘密\r\n"])("passes exact imported secret bytes through commit and runtime directory composition (%j)", async password => {
    const sourceHome = mkdtempSync(join(process.cwd(), ".artifacts/hub-secret-source-")); roots.push(sourceHome);
    const source = join(sourceHome, "bind"); writeFileSync(source, password, { mode: 0o600 });
    const hub = await initializedHub(readHubSecretFile(source));
    expect(readFileSync(join(hub.home, "hub/secrets/directory-bind"))).toEqual(Buffer.from(password));
    const f = factory(hub.home, fakeHttp().entry);
    const service = await f.create(hub.config.hub, () => true);
    try { expect(f.directories.map(s => Buffer.from(s.bindPassword))).toEqual([Buffer.from(password)]); }
    finally { await service.close(); }
    expect(readFileSync(source)).toEqual(Buffer.from(password));
    // The opt-in is specific to opaque secrets. Default JSON/config reads retain their BOM-as-encoding behavior.
    writeFileSync(join(hub.home, "hub/json-control"), '\uFEFF{"enabled":false}', { mode: 0o600 });
    const json = readPrivateFile(hub.home, "hub/json-control");
    expect(json).toBe('{"enabled":false}');
    expect(JSON.parse(json)).toEqual({ enabled: false });
  });

  it("composes group permits off by default, preserves intact never-enabled repair, and fences them on close", async () => {
    const hub = await initializedHub(), http = fakeHttp(), f = factory(hub.home, http.entry);
    // A valid public CA bundle may exceed canonicalArguments' request-body bound.
    // Hash trust material before including it in the small authority-generation record.
    (hub.config.hub.directory as Record<string, unknown>).caPem = hub.caPem.repeat(200);
    sealFixtureHub(hub);
    expect(hub.caPem.repeat(200).length).toBeGreaterThan(64 * 1024);
    const created = f.create(hub.config.hub, () => true);
    await expect(created).resolves.toBeDefined();
    const service = await created;
    const context = { requestId: randomUUID(), current: () => true };
    expect(http.state.deps!.groups).toBeDefined();
    const permit = await http.state.deps!.groups!.asker(ADMIN.key, context);
    expect(permit.source).toBe("legacy"); permit.assertCurrent();
    await service.close(); expect(() => permit.assertCurrent()).toThrow();
    const changed = { ...hub.config.hub, directory: { ...(hub.config.hub.directory as object), baseDn: "ou=staff,dc=example,dc=test" } };
    sealFixtureHub(hub, changed);
    const next = await f.create(changed, () => true);
    try { expect((await http.state.deps!.groups!.asker(ADMIN.key, context)).source).toBe("legacy"); }
    finally { await next.close(); }
    // Once enabled, a different authority generation must fail protected actions, while
    // construction/sign-in/admin repair remain available instead of opening the strict old store.
    const db = new Database(join(hub.home, "hub/hub.sqlite"));
    const row = db.prepare("SELECT body FROM hub_group_policy").get() as { body: string };
    const policy = JSON.parse(row.body); policy.state = "enabled";
    db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(policy)); db.close();
    const repaired = await f.create(changed, () => true);
    try { await expect(http.state.deps!.groups!.asker(ADMIN.key, context)).rejects.toMatchObject({ reason: "repair-required" }); }
    finally { await repaired.close(); }
  });

  it("wires an existing administrator revoke to the live member server's post-commit authorization refresh", async () => {
    const hub = await initializedHub(), http = fakeHttp(), f = factory(hub.home, http.entry);
    const service = await f.create(hub.config.hub, () => true), refresh = vi.spyOn(HubServer.prototype, "refreshAuthorization");
    try {
      await service.start();
      const { pairing, store } = http.state.deps!, fleetId = randomUUID();
      store.mutate({ at: Date.now(), requestId: randomUUID(), actor: { kind: "person", person: ADMIN.key }, action: "test.fleet", result: "completed" }, state => {
        state.fleets.push({ id: fleetId, owner: ADMIN.key, credentialHash: "a".repeat(64), generation: 1, status: "active" });
      });
      await pairing.revoke({ requestId: randomUUID(), current: async () => ({ kind: "directory", person: ADMIN.key, sessionId: randomUUID() }), requirePerson: async () => ADMIN.key,
        requireAdmin: async () => ({ kind: "local-host", sessionId: randomUUID(), directoryBinding: ADMIN.key }) }, fleetId);
      expect(refresh).toHaveBeenCalledExactlyOnceWith();
      expect(store.read()).toMatchObject({ revocationVersion: 1, fleets: [{ id: fleetId, status: "revoked" }] });
    } finally { refresh.mockRestore(); await service.close(); }
  });

  it("without S3 in the build: hub-incomplete, before opening anything", async () => {
    const hub = await initializedHub();
    const f = factory(hub.home);
    await expect(f.create(hub.config.hub, () => true)).rejects.toThrow(/S3/);
    expect(f.reports.map((r) => r.code)).toEqual(["hub-incomplete"]);
    expect(existsSync(join(hub.home, "hub/hub.sqlite"))).toBe(false);
    expect(existsSync(join(hub.home, "hub/floors"))).toBe(false);
  });

  it("composes S1 + S2 + S3 + DB + audit; serves /hub/v1 on the Hub web listener; fence → unavailable; close leaves nothing listening", async () => {
    const hub = await initializedHub();
    const http = fakeHttp();
    const f = factory(hub.home, http.entry);
    let on = true;
    const service = (await f.create(hub.config.hub, () => on)) as HubMountedService & { audit: { verifyChain(): { ok: boolean } } };
    await service.start();

    // Private state set, created together.
    for (const p of ["hub/hub.sqlite", "hub/floors/transport", "hub/keys/content.key"]) expect(statSync(join(hub.home, p)).mode & 0o777, p).toBe(0o600);
    const db = new Database(join(hub.home, "hub/hub.sqlite"), { readonly: true });
    expect((db.prepare("SELECT component, version FROM hub_schema ORDER BY component").all() as { component: string }[]).map((r) => r.component)).toEqual(["company-join", "enrolment-code", "s1-transport", "s3-http", "s3-session-epoch", "s5-audit", "s5-browser-tls", "s5-directory-mount-intent", "s5-directory-settings", "s5-group-policy", "s5-group-resources", "s5-instance", "s5-retention", "s5-web-address", "s5-web-initialization-audit", "s7-attachments", "s90-pairing-notices"]);
    expect((db.prepare("SELECT hub_id FROM hub_instance").get() as { hub_id: string }).hub_id).toBe(hub.config.hub.hubId);
    db.close();

    // S3's deps: the sealed config (frozen), exact bind secret, live transport, issuer that really signs.
    const deps = http.state.deps!;
    expect(deps.config).toEqual({ hubId: hub.config.hub.hubId, name: "Compose Hub", memberOrigin: hub.plan.memberOrigin, webOrigin: hub.plan.webOrigin, administrator: ADMIN.key });
    expect(Object.isFrozen(deps.config)).toBe(true);
    expect(f.directories).toEqual([{ bindPassword: BIND }]);
    expect(deps.transport()).not.toBeNull();
    expect(deps.issuer.keyId).toMatch(/\S/);

    expect(await get(hub.webPort, "/hub/v1/ping", hub.caPem)).toEqual({ status: 200, body: JSON.stringify({ name: "Compose Hub", transport: true }) });
    expect((await get(hub.webPort, "/web", hub.caPem)).status).toBe(404);
    expect(await refused(hub.memberPort)).toBe(false); // S1's member listener is up

    service.fence();
    expect(deps.transport()).toBeNull();
    expect((await get(hub.webPort, "/hub/v1/ping", hub.caPem)).status).toBe(503);
    await service.close();
    expect(http.state.closed).toBe(1);
    expect(await refused(hub.webPort)).toBe(true);
    expect(await refused(hub.memberPort)).toBe(true);
    on = false;

    // Reopened: the complete set is opened, not recreated; the store keeps its state.
    const again = await factory(hub.home, fakeHttp().entry).create(hub.config.hub, () => true);
    await again.start();
    await again.close();
  });

  it("refuses partial or foreign state and a missing bind secret — nothing recreated, nothing left open", async () => {
    const hub = await initializedHub();
    const first = await factory(hub.home, fakeHttp().entry).create(hub.config.hub, () => true);
    await first.close();

    const floor = join(hub.home, "hub/floors/transport");
    const floorText = readFileSync(floor);
    unlinkSync(floor);
    const partial = factory(hub.home, fakeHttp().entry);
    await expect(partial.create(hub.config.hub, () => true)).rejects.toThrow(/partial/);
    expect(partial.reports[0]!.code).toBe("hub-state-mismatch");
    expect(existsSync(floor)).toBe(false);
    writeFileSync(floor, floorText, { mode: 0o600 });

    const db = new Database(join(hub.home, "hub/hub.sqlite"));
    db.prepare("UPDATE hub_instance SET hub_id = 'someone-else'").run();
    db.close();
    const foreign = factory(hub.home, fakeHttp().entry);
    await expect(foreign.create(hub.config.hub, () => true)).rejects.toThrow(/another Hub/);
    expect(foreign.reports[0]!.code).toBe("hub-state-mismatch");
    const db2 = new Database(join(hub.home, "hub/hub.sqlite"));
    db2.prepare("UPDATE hub_instance SET hub_id = ?").run(hub.config.hub.hubId as string);
    db2.close();

    unlinkSync(join(hub.home, "hub/secrets/directory-bind"));
    const secret = factory(hub.home, fakeHttp().entry);
    await expect(secret.create(hub.config.hub, () => true)).rejects.toThrow(/bind secret/);
    expect(secret.reports[0]!.code).toBe("hub-directory-secret");
    expect(await refused(hub.memberPort)).toBe(true);
    expect(await refused(hub.webPort)).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("Hub runtime (S5b lifecycle)", () => {
  it("off means off: the switch check and the view need no Hub state", () => {
    expect(hubSwitchesOn({})).toBe(false);
    expect(hubSwitchesOn({ hub: { enabled: "true" }, hub_member: { enabled: 1 } })).toBe(false);
    expect(hubSwitchesOn({ hub_member: { enabled: true } })).toBe(true);
    expect(effectiveHubView({ hub: { enabled: false, name: "x" } })).toBe(effectiveHubView({}));
  });

  it("mounts a sealed Hub; without S3 it holds hub-incomplete; an edit after sealing holds hub-unsealed; off clears", async () => {
    const hub = await initializedHub();
    const holds: (readonly HubHold[])[] = [];
    const runtime = new HubRuntime({ home: hub.home, log: () => {}, components: {}, onHoldsChanged: (h) => holds.push(h) });
    await runtime.apply(hub.config);
    expect(runtime.currentHolds()).toMatchObject([{ side: "server", code: "hub-incomplete" }]);
    await runtime.apply({ hub: { ...hub.config.hub, name: "Edited by hand" } });
    expect(runtime.currentHolds()).toMatchObject([{ side: "server", code: "hub-unsealed" }]);
    await runtime.apply({});
    expect(runtime.currentHolds()).toEqual([]);
    await runtime.close();
  });

  it("with S3 present: serves, a same-config reload is a no-op, a change fences before it closes, stop closes everything", async () => {
    const hub = await initializedHub();
    const http = fakeHttp();
    const runtime = new HubRuntime({ home: hub.home, log: () => {}, components: { http: async () => http.entry } });
    expect(runtime.serverHealth(hub.config.hub)).toBe("starting");
    await runtime.apply(hub.config);
    expect(runtime.serverHealth(hub.config.hub)).toBe("ready");
    expect(runtime.currentHolds()).toEqual([]);
    expect((await get(hub.webPort, "/hub/v1/ping", hub.caPem)).status).toBe(200);
    const deps = http.state.deps;
    await runtime.apply(structuredClone(hub.config));
    expect(http.state.deps).toBe(deps); // unchanged view: nothing rebuilt
    runtime.fence();
    expect(deps!.transport()).toBeNull(); // synchronous
    await runtime.close();
    expect(http.state.closed).toBe(1);
    expect(await refused(hub.webPort)).toBe(true);
    expect(await refused(hub.memberPort)).toBe(true);
    await runtime.apply(hub.config); // after stop: ignored
    expect(await refused(hub.webPort)).toBe(true);
  });

  it("serializes applies: overlapping calls collapse to the newest configuration; the member side holds until S4", async () => {
    const created: string[] = [];
    const events: string[] = [];
    const service = (name: string): HubMountedService => ({
      start: async () => { events.push(`start ${name}`); },
      fence: () => { events.push(`fence ${name}`); },
      close: async () => { events.push(`close ${name}`); },
    });
    const runtime = new HubRuntime({
      home: "/nonexistent",
      log: () => {},
      createMember: async (cfg) => {
        created.push(String(cfg.label));
        return service(String(cfg.label));
      },
    });
    const a = runtime.apply({ hub_member: { enabled: true, label: "a" } });
    void runtime.apply({ hub_member: { enabled: true, label: "b" } });
    await runtime.apply({ hub_member: { enabled: true, label: "c" } });
    await a;
    // "a" was revoked when "b" arrived (before its factory ran) and "b" when "c" arrived: only the newest is built.
    expect(created).toEqual(["c"]);
    expect(events).toEqual(["start c"]);
    await runtime.close();
    expect(events.at(-1)).toBe("close c");

    const s4less = new HubRuntime({ home: "/nonexistent", log: () => {} });
    await s4less.apply({ hub_member: { enabled: true } });
    expect(s4less.currentHolds()).toMatchObject([{ side: "member", code: "hub-incomplete" }]);
    await s4less.close();
  });
});

describe.skipIf(process.platform === "win32")("review #3113 regressions (lifecycle and cleanup)", () => {
  function gate() {
    let open!: () => void;
    const promise = new Promise<void>((r) => (open = r));
    return { promise, open };
  }

  for (const held of ["factory", "start"] as const) {
    it(`P2: a changed configuration fences at once while the ${held} is held; the held service never starts`, async () => {
      const hub = await initializedHub();
      const g = gate();
      const entered = gate();
      let current: (() => boolean) | undefined;
      const events: string[] = [];
      const runtime = new HubRuntime({
        home: hub.home,
        log: () => {},
        createServer: async (_cfg, cur) => {
          current = cur;
          entered.open();
          if (held === "factory") await g.promise;
          return {
            start: async () => { events.push("start"); if (held === "start") await g.promise; },
            fence: () => events.push("fence"),
            close: async () => { events.push("close"); },
          };
        },
      });
      const first = runtime.apply(hub.config);
      await entered.promise;
      if (held === "start") await new Promise((r) => setTimeout(r, 10));
      void runtime.apply({}); // switched off while held
      expect(current!()).toBe(false); // synchronously revoked
      g.open();
      await first;
      await runtime.apply({});
      if (held === "factory") expect(events).not.toContain("start");
      expect(events).toContain("close");
      await runtime.close();
    });
  }

  it("P2: an unconfirmed cleanup is reported, keeps its owner, blocks a replacement, and is retried", async () => {
    const hub = await initializedHub();
    let failClose = true;
    const http = fakeHttp();
    const entry: HubHttpEntry = {
      ...http.entry,
      createHubHttp(deps) {
        const inner = http.entry.createHubHttp(deps);
        return { ...inner, close: async () => { if (failClose) throw new Error("S3 still draining"); await inner.close(); } };
      },
    };
    const f = factory(hub.home, entry);
    const service = await f.create(hub.config.hub, () => true);
    await service.start();
    await expect(service.close()).rejects.toThrow(/unconfirmed/);
    expect(await refused(hub.webPort)).toBe(true); // closed before the failing step
    expect(await refused(hub.memberPort)).toBe(true);
    failClose = false;
    await service.close(); // retried from the failed step
    expect(http.state.closed).toBe(1);

    // A factory that fails and cannot clean up blocks the next creation until its cleanup succeeds.
    let s3Fails = true, directoryCloseFails = true;
    const reports: string[] = [];
    const ok = fakeHttp();
    const flaky = createHubServerFactory({
      home: hub.home,
      components: { http: async () => ({ ...ok.entry, createHubHttp: (deps) => { if (s3Fails) throw new Error("S3 failed to build"); return ok.entry.createHubHttp(deps); } }) },
      createDirectory: () => ({ realm: "corp", signIn: async () => ({ ok: false, reason: "unavailable" }), checkEligibility: async () => ({ eligible: false, reason: "unavailable" }),
        close: async () => { if (directoryCloseFails) throw new Error("directory client stuck"); } }),
      report: (code) => reports.push(code),
      log: () => {},
    });
    await expect(flaky(hub.config.hub, () => true)).rejects.toThrow(/unconfirmed.*directory client stuck/);
    expect(reports.at(-1)).toBe("service-unavailable");
    s3Fails = false;
    await expect(flaky(hub.config.hub, () => true)).rejects.toThrow(/directory client stuck/); // still blocked
    directoryCloseFails = false;
    const recovered = await flaky(hub.config.hub, () => true); // cleanup confirmed first, then a fresh service
    await recovered.start();
    expect((await get(hub.webPort, "/hub/v1/ping", hub.caPem)).status).toBe(200);
    await recovered.close();
  });
});

describe.skipIf(process.platform === "win32")("review #3113 round 2: a failed creation's leftover is drained on Off and Stop", () => {
  function brokenRuntime(home: string, state: { closeFails: boolean; closes: number }) {
    return new HubRuntime({
      home,
      log: () => {},
      components: { http: async () => ({ ...fakeHttp().entry, createHubHttp: () => { throw new Error("S3 failed to build"); } }) },
      createDirectory: () => ({
        realm: "corp",
        signIn: async () => ({ ok: false, reason: "unavailable" }),
        checkEligibility: async () => ({ eligible: false, reason: "unavailable" }),
        close: async () => {
          state.closes += 1;
          if (state.closeFails) throw new Error("directory client stuck");
        },
      }),
    });
  }

  for (const how of ["off", "stop"] as const) {
    it(`${how}: a recoverable leftover is cleaned up; a still-failing one stays owned and held`, async () => {
      const hub = await initializedHub();
      const state = { closeFails: true, closes: 0 };
      const runtime = brokenRuntime(hub.home, state);
      await runtime.apply(hub.config);
      expect(runtime.currentHolds()).toMatchObject([{ side: "server", code: "service-unavailable" }]);
      expect(state.closes).toBe(1);

      // Still failing: Off keeps it held; Stop rejects and keeps it held.
      if (how === "off") {
        await runtime.apply({});
        expect(runtime.currentHolds()).toMatchObject([{ side: "server", code: "service-unavailable" }]);
      } else {
        await expect(runtime.close()).rejects.toThrow(/directory client stuck/);
        expect(runtime.currentHolds()).toMatchObject([{ side: "server", code: "service-unavailable" }]);
      }
      expect(state.closes).toBe(2);

      // Healthy again: the same leftover is drained (the directory closes, then the DB under it).
      state.closeFails = false;
      if (how === "off") {
        await runtime.apply({ hub: { enabled: false } }); // a changed view: applied again, drained
        expect(runtime.currentHolds()).toEqual([]);
        await runtime.close();
      } else {
        await runtime.close();
      }
      expect(state.closes).toBe(3);
      // The DB handle is released: a fresh complete open works and the file is not locked by a leftover writer.
      const db = new Database(join(hub.home, "hub/hub.sqlite"));
      db.exec("BEGIN IMMEDIATE; ROLLBACK;");
      db.close();
    });
  }
});

describe.skipIf(process.platform === "win32")("S5b PR 2: the real Hub web service (S3b) is the default", () => {
  it("a sealed, enabled Hub serves S3b's session API, the Hub-only shell and its assets over TLS; nothing else", async () => {
    const hub = await initializedHub();
    const runtime = new HubRuntime({ home: hub.home, log: () => {} });
    await runtime.apply(hub.config);
    expect(runtime.currentHolds()).toEqual([]);
    const session = await get(hub.webPort, "/hub/v1/session", hub.caPem);
    const shell = await get(hub.webPort, "/web", hub.caPem);
    const panel = await get(hub.webPort, "/ui/js/panel-hub.js", hub.caPem);
    const fleetModule = await get(hub.webPort, "/ui/js/app.js", hub.caPem);
    const unknown = await get(hub.webPort, "/api/status", hub.caPem);
    expect(session).toEqual({ status: 200, body: JSON.stringify({ signedIn: false, hub: { name: "Compose Hub" } }) });
    expect(shell.status).toBe(200);
    expect(shell.body).toContain('data-hub="hub"');
    expect(panel.status).toBe(200);
    expect(fleetModule.status).toBe(404); // the fleet's own modules are not on the Hub listener
    expect(unknown.status).toBe(404);
    await runtime.close();
    expect(await refused(hub.webPort)).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("Hub retention composition", () => {
  it("uses the saved policy at the next purge without changing the sealed initialization, then preserves it on reopen", async () => {
    const hub = await initializedHub(), http = fakeHttp();
    const originalSeal = readFileSync(join(hub.home, "hub/init-manifest.json"), "utf8");
    const registered: { control?: import("../src/hub/retention.js").HubRetentionControl } = {};
    const f = factory(hub.home, http.entry, { retentionEveryMs: 20, retentionReady(control) {
      registered.control = control; return () => { delete registered.control; };
    } });
    const service = await f.create(hub.config.hub, () => true);
    let db: Database.Database | undefined;
    try {
      await service.start();
      const control = registered.control!;
      expect(control.read()).toEqual({ contentDays: 30, eventDays: 180, revision: 1 });
      const ref = await http.state.deps!.uow.atomic(tx => http.state.deps!.content.put(tx, { question: "old fixture content" }));
      db = new Database(join(hub.home, "hub/hub.sqlite"));
      db.prepare("UPDATE hub_audit_content SET created_at=? WHERE ref=?").run(Date.now() - 20 * 86_400_000, ref);
      await new Promise(resolve => setTimeout(resolve, 55));
      expect(db.prepare("SELECT count(*) n FROM hub_audit_content WHERE ref=?").get(ref)).toEqual({ n: 1 });
      control.update({ contentDays: 7, eventDays: 30, revision: 1 }, () => true);
      for (let i = 0; i < 50 && (db.prepare("SELECT count(*) n FROM hub_audit_content WHERE ref=?").get(ref) as any).n; i++)
        await new Promise(resolve => setTimeout(resolve, 10));
      expect(db.prepare("SELECT count(*) n FROM hub_audit_content WHERE ref=?").get(ref)).toEqual({ n: 0 });
      expect(readFileSync(join(hub.home, "hub/init-manifest.json"), "utf8")).toBe(originalSeal);
      service.fence(); expect(() => control.read()).toThrow("unavailable");
    } finally { db?.close(); await service.close(); }
    expect(registered.control).toBeUndefined();
    const again = await f.create(hub.config.hub, () => true);
    try { await again.start(); expect(registered.control!.read()).toEqual({ contentDays: 7, eventDays: 30, revision: 2 }); }
    finally { await again.close(); }
  });
  it("exposes the composed policy only through the running host runtime and removes it on close", async () => {
    const hub = await initializedHub(), http = fakeHttp();
    const runtime = new HubRuntime({ home: hub.home, log: () => {}, components: { http: async () => http.entry },
      createDirectory: () => ({ realm: "corp", signIn: async () => ({ ok: false, reason: "unavailable" }),
        checkEligibility: async () => ({ eligible: false, reason: "unavailable" }), close: async () => {} }) });
    expect(runtime.retentionSettings()).toBeNull();
    expect(runtime.browserCertificateSettings()).toBeNull();
    try {
      await runtime.apply(hub.config);
      const control = runtime.retentionSettings()!; expect(control.read().revision).toBe(1);
      expect(runtime.browserCertificateSettings()!.read().selected.fingerprint256).toMatch(/:/);
      runtime.fence(); expect(() => control.read()).toThrow("unavailable");
    } finally { await runtime.close(); }
    expect(runtime.retentionSettings()).toBeNull();
    expect(runtime.browserCertificateSettings()).toBeNull();
  });
  // #3298 S-89 (#3372 N2, Fable G2): the factory → runtime step of "the Settings row only when this Hub has group permissions".
  it.each([[[] as string[], false], [["group-policy-v1"], true]])("an http entry reporting %j: groupPermissionsAvailable() is %s while running, false after close", async (features, on) => {
    const hub = await initializedHub(), http = fakeHttp();
    const entry: HubHttpEntry = { ...http.entry, createHubHttp: (deps) => ({ ...http.entry.createHubHttp(deps), features }) };
    const runtime = new HubRuntime({ home: hub.home, log: () => {}, components: { http: async () => entry },
      createDirectory: () => ({ realm: "corp", signIn: async () => ({ ok: false, reason: "unavailable" }),
        checkEligibility: async () => ({ eligible: false, reason: "unavailable" }), close: async () => {} }) });
    expect(runtime.groupPermissionsAvailable()).toBe(false);
    try {
      await runtime.apply(hub.config);
      expect(runtime.groupPermissionsAvailable()).toBe(on);
    } finally { await runtime.close(); }
    expect(runtime.groupPermissionsAvailable()).toBe(false);                     // the withdraw ran on teardown
  });
});


describe.skipIf(process.platform === "win32")("browser certificate composition", () => {
  it("changes the real HTTPS certificate, preserves the member identity and init seal, and reopens the selected pair", async () => {
    const hub = await initializedHub(), http = fakeHttp();
    const seal = readFileSync(join(hub.home, "hub/init-manifest.json"), "utf8");
    const memberKey = readFileSync(join(hub.home, "hub/keys/issuer-key.pem"), "utf8");
    const memberTls = readFileSync(join(hub.home, "hub/keys/tls-cert.pem"), "utf8"), memberIdentity = readFileSync(join(hub.home, "hub/keys/identity.json"), "utf8");
    let control: import("../src/hub/browser-certificate.js").HubBrowserCertificateControl | null = null;
    const f = factory(hub.home, http.entry, { browserCertificateReady(c) { control = c; return () => { control = null; }; } });
    const first = await f.create(hub.config.hub, () => true);
    let fingerprint = "", selectedPem = "";
    try {
      await first.start();
      const c = control!, before = c.read(); expect(before.restartRequired).toBe(false);
      const p = await c.prepare({ mode: "generate", revision: before.revision }, "owner", () => true);
      fingerprint = p.certificate.fingerprint256;
      const after = c.apply({ reference: p.reference, revision: p.revision }, "owner", () => true);
      expect(after).toMatchObject({ activeFingerprint256: fingerprint, restartRequired: false });
      selectedPem = JSON.parse(readFileSync(join(hub.home, "hub/web-tls/versions", p.reference, "material.json"), "utf8")).cert;
      // Verification stays enabled; the new certificate itself is this scratch client's explicit trust anchor.
      expect((await get(hub.webPort, "/hub/v1/ping", selectedPem)).status).toBe(200);
      await expect(get(hub.webPort, "/hub/v1/ping", hub.caPem)).rejects.toThrow();
      expect(readFileSync(join(hub.home, "hub/init-manifest.json"), "utf8")).toBe(seal);
      expect(readFileSync(join(hub.home, "hub/keys/issuer-key.pem"), "utf8")).toBe(memberKey);
      expect(readFileSync(join(hub.home, "hub/keys/tls-cert.pem"), "utf8")).toBe(memberTls);
      expect(readFileSync(join(hub.home, "hub/keys/identity.json"), "utf8")).toBe(memberIdentity);
    } finally { await first.close(); }
    expect(control).toBeNull();
    const second = await f.create(hub.config.hub, () => true);
    try {
      await second.start(); expect(control!.read()).toMatchObject({ activeFingerprint256: fingerprint, restartRequired: false });
      expect((await get(hub.webPort, "/hub/v1/ping", selectedPem)).status).toBe(200);
    } finally { await second.close(); }
  });
});

/** Actual S3 HTTPS + the existing writer; driver is inert and never contacts a real directory. */
async function directoryRuntimeRig(wrap: (http: HubHttp, deps: HubHttpDeps) => HubHttp = http => http,
  options: { people?: Array<typeof ADMIN>; noGroupHttp?: boolean; noDirectoryNotices?: boolean; now?: () => number;
    directorySettings?: () => Promise<HubDirectorySettingsControl> } = {}) {
  const hub = await initializedHub(), real = await import("../src/hub/runtime.js").then(m => m.S3B_HTTP_ENTRY());
  let runtime: HubRuntime, writer: ReturnType<typeof createHubSettingsWriter>, crash: string | undefined, lastDeps: HubHttpDeps | undefined, lastHttp: HubHttp;
  let atStage: (() => void) | undefined;
  let creates = 0, eligibility = 0, signInGate: (() => Promise<void>) | undefined;
  let borrowed: HubDirectorySettingsDecision | null = null, refuseNextDirectory = false, refuseAllDirectories = false, coldBorrows = 0;
  const people = [ADMIN, ...options.people ?? []];
  const entry: HubHttpEntry = { ...real, createHubHttp(deps) {
    lastDeps = { ...deps, ...(options.noGroupHttp ? { groupHttp: undefined } : {}), ...(options.noDirectoryNotices ? { directoryNotices: undefined } : {}) };
    lastHttp = wrap(real.createHubHttp(lastDeps), lastDeps); return lastHttp;
  } };
  const build = (http: () => Promise<HubHttpEntry> = async () => entry, readConfig = () => hub.config) => {
    hub.config = yaml.load(readFileSync(join(hub.home, "fleet.yaml"), "utf8")) as typeof hub.config;
    writer = createHubSettingsWriter({ home: hub.home, now: options.now, readHub: () => hub.config.hub,
      directoryDecision: () => borrowed ?? runtime?.directoryDecision() ?? null,
      saveHub(patches) {
        const next = structuredClone(hub.config.hub);
        for (const patch of patches) { if (patch.remove) delete next[patch.path[1]!]; else next[patch.path[1]!] = patch.value; }
        hub.config.hub = next;
        atomicWriteFileSync(join(hub.home, "fleet.yaml"), yaml.dump(hub.config), { mode: 0o600 });
      },
      step(point) { if (point === "staged") { const action = atStage; atStage = undefined; action?.(); } if (point === crash) { crash = undefined; throw Error(`stop:${point}`); } },
    });
    runtime = new HubRuntime({ home: hub.home, log: () => {}, components: { http }, settingsWriter: writer, now: options.now, readConfig,
      ...(options.directorySettings ? { directorySettings: options.directorySettings } : {}),
      createDirectory: config => { creates++; if (refuseAllDirectories || refuseNextDirectory && config.url === "ldaps://next.example.test") throw Error("owned replacement mount refusal");
        return { realm: "corp", signIn: async (login, password) => {
          await signInGate?.();
          const person = people.find(p => p.login === login);
          return person && password === "Dummy-browser-only" ? { ok: true, person } : { ok: false, reason: "invalid-credentials" };
        },
        checkEligibility: async key => { eligibility++; const person = people.find(p => p.key.realm === key.realm && p.key.objectId === key.objectId);
          return person ? { eligible: true, person } : { eligible: false, reason: "disabled" }; }, close: async () => {} }; } });
    return runtime;
  };
  build();
  try { await runtime!.apply(hub.config); expect(runtime!.serverHealth(hub.config.hub)).toBe("ready"); }
  catch (err) { await runtime!.close(); throw err; }
  const candidate = () => ({ directory: { ...(hub.config.hub.directory as import("../src/hub/directory/config.js").HubDirectoryConfig), url: "ldaps://next.example.test" },
    bindPassword: "Dummy-next-bind-only", changes: ["server", "secret"] as const,
    recipients: [{ kind: "host" as const, sink: "owner-needs-you" }, { kind: "person" as const, person: ADMIN.key }] });
  const actor = { kind: "host-owner" as const, sessionId: "owned-host-session", requestId: randomUUID() };
  const commit = (point?: string, recoveryDeadline?: number) => {
    const mounted = runtime!.directorySettings()!, draft = writer!.directory!.prepare({ ...candidate(), changes: [...candidate().changes] }, actor, mounted.current);
    crash = point; return writer!.directory!.commit(draft.ref, actor, mounted.current, undefined, recoveryDeadline);
  };
  return { hub, get runtime() { return runtime!; }, get writer() { return writer!; }, get deps() { return lastDeps!; }, get http() { return lastHttp!; },
    get creates() { return creates; }, get eligibility() { return eligibility; }, get coldBorrows() { return coldBorrows; },
    atStage(action: () => void) { atStage = action; },
    crashAt(point: string) { crash = point; },
    refuseNextDirectory() { refuseNextDirectory = true; }, refuseAllDirectories() { refuseAllDirectories = true; },
    withDecision<T>(work: (decision: HubDirectorySettingsDecision) => T): T {
      const mounted = runtime!.directoryDecision(); if (mounted) return work(mounted);
      const { settings, migrations } = hubServerDatabasePlan(hub.config.hub, entry.migrations); coldBorrows++;
      return withHubDirectoryRecovery({ home: hub.home, hubId: settings.hubId, memberOrigin: settings.memberOrigin, migrations }, decision => {
        borrowed = decision; try { return work(decision); } finally { borrowed = null; }
      });
    }, holdSignIn(gate?: () => Promise<void>) { signInGate = gate; }, entry, build, commit, candidate, actor };
}

describe.skipIf(process.platform === "win32")("directory decision joins the mounted runtime", () => {
  it("revokes old HTTPS effects immediately but retains the same SQL participant through physical installation", async () => {
    const r = await directoryRuntimeRig(), oldConfig = structuredClone(r.hub.config.hub), old = r.runtime.directorySettings()!, source = old.source();
    try {
      const participant = r.runtime.directoryDecision();
      expect((await get(r.hub.webPort, "/hub/v1/session", r.hub.caPem)).status).toBe(200);
      const proof = createHubDirectorySettingsProof({ source: () => r.runtime.directorySettings()!.source(),
        withDirectoryRead: (person, work) => old.withDirectoryRead(person, work), writer: () => r.writer.directory!,
        createDirectory: () => ({ realm: "corp", signIn: async () => ({ ok: false, reason: "unavailable" }),
          checkEligibility: async () => ({ eligible: true, person: ADMIN }), close: async () => {} }),
        probeTls: async () => "a".repeat(64) });
      const candidate = r.candidate(), ctx = { actor: r.actor, current: () => true };
      let saved: { directoryEpoch: number };
      try {
        const draft = await proof.prepare({ ...candidate, changes: [...candidate.changes] }, ctx);
        const applying = proof.apply(draft.ref, { confirmation: draft.trust!.challenge }, ctx);
        await expect(applying).resolves.toMatchObject({ directoryEpoch: 1 });
        saved = await applying;
      } finally { proof.close(); }
      expect(saved.directoryEpoch).toBe(1); expect(r.writer.pending()).toBe(false);
      expect(source.current()).toBe(false); expect(r.runtime.directorySettings()).toBeNull();
      expect(r.runtime.directoryDecision()).toBe(participant); // Still owns the physical DB, despite logical revocation.
      expect(r.runtime.serverHealth(oldConfig)).toBe("unavailable");
      expect((await get(r.hub.webPort, "/hub/v1/session", r.hub.caPem)).status).toBe(503);
      const machine = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: r.hub.memberPort, servername: "hub.example.test",
          ca: readFileSync(join(r.hub.home, "hub/keys/tls-cert.pem")), path: "/hub/v1/join/challenge", method: "POST", agent: false,
          headers: { "Content-Type": "application/json", "Content-Length": 2 } }, res => {
          let body = ""; res.setEncoding("utf8"); res.on("data", value => { body += value; });
          res.on("end", () => resolve({ status: res.statusCode!, body }));
        });
        req.on("error", reject); req.end("{}");
      });
      // This epoch/head advance is the real writer decision, not the corruption-only direct epoch control.
      expect(machine).toEqual({ status: 503, body: JSON.stringify({ code: "unavailable" }) });
      await r.runtime.apply(r.hub.config);
      expect(r.runtime.serverHealth(r.hub.config.hub)).toBe("ready");
      expect(r.runtime.directorySettings()!.source()).toMatchObject({ epoch: 1, bindPassword: "Dummy-next-bind-only", config: { url: "ldaps://next.example.test" } });
      expect(r.runtime.directoryDecision()).not.toBe(participant);
      expect((await get(r.hub.webPort, "/hub/v1/session", r.hub.caPem)).status).toBe(200);
    } finally { await r.runtime.close(); }
    expect(r.runtime.directoryDecision()).toBeNull();
  });
  it.each(["staged", "directory-decision", "directory-secret", "manifest", "config"])("cold-recovers %s before any new listener or directory client", async point => {
    const r = await directoryRuntimeRig();
    try {
      expect(() => r.commit(point)).toThrow(`stop:${point}`); await r.runtime.close();
      const creates = r.creates; r.build();
      expect(r.writer.pendingDirectory()).toBe(true); expect(r.runtime.directoryDecision()).toBeNull();
      await r.runtime.apply(r.hub.config);
      expect(r.creates).toBe(creates); expect(await refused(r.hub.webPort)).toBe(true);
      expect(await r.runtime.recoverSettings(r.hub.config)).toBe(true);
      expect(r.creates).toBe(creates); expect(r.runtime.directoryDecision()).toBeNull();
      expect(r.writer.pending()).toBe(false);
      await r.runtime.apply(r.hub.config);
      expect(r.runtime.serverHealth(r.hub.config.hub)).toBe("ready");
      expect(r.runtime.directorySettings()!.source().epoch).toBe(point === "staged" ? 0 : 1);
      expect((await get(r.hub.webPort, "/hub/v1/session", r.hub.caPem)).status).toBe(200);
    } finally { await r.runtime.close(); }
  });
  it("a lost authority row holds before creation, and direct apply cannot bypass recovery or recreate it", async () => {
    const r = await directoryRuntimeRig();
    try {
      expect(() => r.commit("directory-decision")).toThrow(); await r.runtime.close();
      const db = new Database(join(r.hub.home, SERVER_SET.database)); db.exec("DELETE FROM hub_settings_head"); db.close();
      const creates = r.creates; r.build();
      await expect(r.runtime.recoverSettings(r.hub.config)).rejects.toThrow();
      expect(r.runtime.serverHealth(r.hub.config.hub)).toBe("unavailable");
      await r.runtime.apply(r.hub.config);
      expect(r.runtime.currentHolds()).toMatchObject([{ code: "hub-storage", reason: "settings-recovery" }]);
      expect(r.creates).toBe(creates); expect(await refused(r.hub.webPort)).toBe(true); expect(r.writer.pending()).toBe(true);
      const inspect = new Database(join(r.hub.home, SERVER_SET.database));
      try { expect(inspect.prepare("SELECT count(*) n FROM hub_settings_head").get()).toEqual({ n: 0 }); }
      finally { inspect.close(); }
    } finally { await r.runtime.close(); }
  });
  it.each(["stop", "replacement", "apply"])("held cold import honors %s before any writer effect", async mode => {
    const r = await directoryRuntimeRig();
    try {
      expect(() => r.commit("directory-decision")).toThrow(); await r.runtime.close();
      let release!: () => void, entered!: () => void, calls = 0;
      const held = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { entered = r; });
      r.build(async () => { if (++calls === 1) { entered(); await held; } return r.entry; });
      const first = r.runtime.recoverSettings(r.hub.config); await ready;
      if (mode === "stop") r.runtime.fence();
      else if (mode === "apply") await r.runtime.apply(r.hub.config);
      else expect(await r.runtime.recoverSettings(r.hub.config)).toBe(true);
      const manifest = readFileSync(join(r.hub.home, "hub/init-manifest.json"), "utf8");
      release(); expect(await first).toBe(false);
      expect(readFileSync(join(r.hub.home, "hub/init-manifest.json"), "utf8")).toBe(manifest);
      expect(r.writer.pending()).toBe(mode !== "replacement");
    } finally { await r.runtime.close(); }
  });
  it("mounted proof-source reads share the existing physical eligibility pool", async () => {
    const r = await directoryRuntimeRig(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    try {
      const mounted = r.runtime.directorySettings()!, requests = Array.from({ length: 4 }, () => mounted.withDirectoryRead(ADMIN.key, () => held));
      await expect(r.deps.groups!.prepareOwnerEligibility(ADMIN.key, { requestId: randomUUID(), current: () => true })).rejects.toThrow();
      expect(r.eligibility).toBe(0); release(); await Promise.all(requests);
      await expect(r.deps.groups!.prepareOwnerEligibility(ADMIN.key, { requestId: randomUUID(), current: () => true })).resolves.toBeDefined();
      expect(r.eligibility).toBe(1);
    } finally { release(); await r.runtime.close(); }
  });
  it("rechecks material after a held HTTP import before constructing a directory client", async () => {
    const r = await directoryRuntimeRig();
    try {
      await r.runtime.close(); let release!: () => void, entered!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
      const creates = r.creates;
      r.build(async () => { entered(); await held; return r.entry; });
      const mounting = r.runtime.apply(r.hub.config); await ready;
      writeFileSync(join(r.hub.home, "hub/init-manifest.json"), "{}", { mode: 0o600 });
      release(); await mounting;
      expect(r.creates).toBe(creates); expect(r.runtime.directorySettings()).toBeNull();
      expect(r.runtime.serverHealth(r.hub.config.hub)).toBe("unavailable"); expect(await refused(r.hub.webPort)).toBe(true);
    } finally { await r.runtime.close(); }
  });
  it("binds the driver's secret bytes to the exact captured material before construction", async () => {
    const r = await directoryRuntimeRig();
    const files = await import("../src/hub/private-files.js"), actual = files.readPrivateFile;
    let changed = false;
    try {
      await r.runtime.close(); const creates = r.creates; r.build();
      const reading = vi.spyOn(files, "readPrivateFile").mockImplementation((...args) => {
        const result = actual(...args);
        if (!changed && args[0] === r.hub.home && args[1] === "hub/secrets/directory-bind") {
          changed = true; writeFileSync(join(r.hub.home, args[1]), "Dummy-secret-raced", { mode: 0o600 });
        }
        return result;
      });
      try { await r.runtime.apply(r.hub.config); } finally { reading.mockRestore(); }
      expect(changed).toBe(true); expect(r.creates).toBe(creates);
      expect(r.runtime.currentHolds()).toMatchObject([{ code: "hub-directory-secret" }]);
      expect(await refused(r.hub.webPort)).toBe(true);
    } finally { await r.runtime.close(); }
  });
  it("a rename journal recovers without importing the HTTP registry or requiring a directory DB", async () => {
    const hub = await initializedHub(); let runtime: HubRuntime, stop = true, imports = 0;
    const writer = createHubSettingsWriter({ home: hub.home, readHub: () => hub.config.hub,
      directoryDecision: () => runtime?.directoryDecision() ?? null,
      saveHub(patches) { for (const patch of patches) hub.config.hub[patch.path[1]!] = patch.value;
        atomicWriteFileSync(join(hub.home, "fleet.yaml"), yaml.dump(hub.config), { mode: 0o600 }); },
      step(point) { if (point === "committed" && stop) { stop = false; throw Error("stop rename"); } } });
    runtime = new HubRuntime({ home: hub.home, settingsWriter: writer, log: () => {},
      components: { http: async () => { imports++; throw Error("must not import"); } } });
    const actor = { person: ADMIN.key, sessionId: "own-admin", requestId: randomUUID() }, draft = writer.prepare({ kind: "rename", name: "Renamed" }, actor);
    try {
      expect(() => writer.commit(draft.ref, actor, () => true)).toThrow("stop rename");
      expect(writer.pendingDirectory()).toBe(false);
      expect(await runtime.recoverSettings(hub.config)).toBe(true);
      expect(hub.config.hub.name).toBe("Renamed"); expect(imports).toBe(0);
      expect(existsSync(join(hub.home, SERVER_SET.database))).toBe(false); expect(writer.pending()).toBe(false);
    } finally { await runtime.close(); }
  });
});


/** Ordinary verified HTTPS only; no intercepted API responses or personal credentials. */
function directoryBrowser(hub: Awaited<ReturnType<typeof initializedHub>>, cookie?: string, body?: unknown, path = "/hub/v1/session",
  options: { method?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) {
  return new Promise<{ status: number; json: any; cookie: string; cache: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: hub.webPort, path, servername: "hub.example.test", ca: hub.caPem,
      agent: false, signal: options.signal, method: options.method ?? (body === undefined ? "GET" : "POST"), headers: { Origin: String(hub.config.hub.webOrigin),
        ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...options.headers } }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", data => { text += data; });
      res.on("end", () => { try { resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : null,
        cookie: res.headers["set-cookie"]?.[0]?.split(";")[0] ?? "", cache: res.headers["cache-control"] ?? "" }); } catch (error) { reject(error); } });
    });
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const NOTICE_READER: typeof ADMIN = { ...ADMIN, key: { realm: "corp", objectId: "11111111-1111-4111-8111-111111111111" },
  login: "notice-reader", displayName: "Fictional Reader", dn: "uid=notice-reader,dc=example,dc=test" };
const NOTICE_OTHER: typeof ADMIN = { ...NOTICE_READER, key: { realm: "corp", objectId: "22222222-2222-4222-8222-222222222222" },
  login: "notice-other", displayName: "Fictional Other", dn: "uid=notice-other,dc=example,dc=test" };
const NOTICE_PATH = "/hub/v1/security-notices/directory";
async function directoryNoticeCommit(r: Awaited<ReturnType<typeof directoryRuntimeRig>>, n: number, remount = true) {
  const source = r.runtime.directorySettings()!, candidate = r.candidate();
  const draft = r.writer.directory!.prepare({ ...candidate, directory: { ...candidate.directory, url: `ldaps://notice-${n}.example.test` },
    bindPassword: `Dummy-notice-bind-${n}`, changes: [...candidate.changes],
    recipients: [{ kind: "host", sink: "owner-needs-you" }, { kind: "person", person: NOTICE_READER.key }] }, r.actor, source.current);
  r.writer.directory!.commit(draft.ref, r.actor, source.current);
  const id = r.runtime.directoryDecision()!.notices().at(-1)!.id;
  if (remount) { await r.runtime.apply(r.hub.config); expect(r.runtime.serverHealth(r.hub.config.hub)).toBe("ready"); }
  return id;
}
const noticeSignIn = (r: Awaited<ReturnType<typeof directoryRuntimeRig>>, who = NOTICE_READER) =>
  directoryBrowser(r.hub, undefined, { login: who.login, password: "Dummy-browser-only" });

describe.skipIf(process.platform === "win32")("directory security notices on real HTTPS", () => {
  it("allows only original eligible recipients with groups absent; ACK is CSRF protected, independent and durable", async () => {
    const r = await directoryRuntimeRig(undefined, { people: [NOTICE_READER, NOTICE_OTHER], noGroupHttp: true });
    try {
      const old = await noticeSignIn(r), id = await directoryNoticeCommit(r, 1), reader = await noticeSignIn(r);
      expect(reader.status).toBe(200); expect(reader.json.admin).toBe(false);
      expect(reader.json.features).toContain("directory-security-notices-v1"); expect(reader.json.features).not.toContain("group-policy-v1");
      expect(r.http.features).toContain("directory-security-notices-v1");
      expect((await directoryBrowser(r.hub, undefined, undefined, NOTICE_PATH)).status).toBe(401);
      expect((await directoryBrowser(r.hub, old.cookie, undefined, NOTICE_PATH)).status).toBe(401);
      const admin = await noticeSignIn(r, ADMIN), other = await noticeSignIn(r, NOTICE_OTHER);
      for (const browser of [admin, other]) {
        expect((await directoryBrowser(r.hub, browser.cookie, undefined, NOTICE_PATH)).json.items).toEqual([]);
        expect((await directoryBrowser(r.hub, browser.cookie, {}, `${NOTICE_PATH}/${id}/ack`, { headers: { "X-AgEnD-Hub-CSRF": browser.json.csrf } })).status).toBe(404);
      }
      const page = await directoryBrowser(r.hub, reader.cookie, undefined, NOTICE_PATH);
      expect(page.status).toBe(200); expect(page.cache).toContain("no-store");
      expect(page.json.items).toEqual([{ id, operationId: r.runtime.directoryDecision()!.inspect().operationId,
        kind: "directory", phase: "applying", at: expect.any(Number), actor: { kind: "host-owner" }, changes: ["server", "secret"], acknowledged: false }]);
      expect((await directoryBrowser(r.hub, reader.cookie, {}, `${NOTICE_PATH}/${id}/ack`)).status).toBe(403);
      expect((await directoryBrowser(r.hub, reader.cookie, {}, `${NOTICE_PATH}/${id}/ack`, { headers: {
        "X-AgEnD-Hub-CSRF": reader.json.csrf, Origin: "https://other.example.test" } })).status).toBe(403);
      expect((await directoryBrowser(r.hub, reader.cookie, {}, `${NOTICE_PATH}/${id}/ack`, { headers: { "X-AgEnD-Hub-CSRF": reader.json.csrf } })).status).toBe(200);
      expect((await directoryBrowser(r.hub, reader.cookie, undefined, `${NOTICE_PATH}?unread=1`)).json.items).toEqual([]);
      await r.runtime.close(); r.build(); await r.runtime.apply(r.hub.config);
      expect((await directoryBrowser(r.hub, reader.cookie, undefined, NOTICE_PATH)).json.items[0]).toMatchObject({ id, acknowledged: true });
      const db = new Database(join(r.hub.home, SERVER_SET.database), { readonly: true });
      try { expect(db.prepare("SELECT state FROM hub_settings_security_targets WHERE notice_id=? AND kind='host'").get(id)).toEqual({ state: "queued" }); }
      finally { db.close(); }
    } finally { await r.runtime.close(); }
  });
  it("serves older pages and exact older ACK, while refusing malformed query, method and disabled eligibility", async () => {
    const r = await directoryRuntimeRig(undefined, { people: [NOTICE_READER] });
    try {
      const first = await directoryNoticeCommit(r, 1), second = await directoryNoticeCommit(r, 2), reader = await noticeSignIn(r);
      const page = (await directoryBrowser(r.hub, reader.cookie, undefined, `${NOTICE_PATH}?limit=1`)).json;
      expect(page.items.map((n: { id: string }) => n.id)).toEqual([second]); expect(page.nextBefore).toBe(second);
      expect((await directoryBrowser(r.hub, reader.cookie, undefined, `${NOTICE_PATH}?before=${second}&limit=1`)).json.items[0].id).toBe(first);
      expect((await directoryBrowser(r.hub, reader.cookie, {}, `${NOTICE_PATH}/${first}/ack`, { headers: { "X-AgEnD-Hub-CSRF": reader.json.csrf } })).status).toBe(200);
      for (const query of ["limit=101", "limit=0", "limit=one", "limit=1&limit=2", "unread=yes", "before=invalid", "target=other"]) {
        expect((await directoryBrowser(r.hub, reader.cookie, undefined, `${NOTICE_PATH}?${query}`)).status).toBe(400);
      }
      expect((await directoryBrowser(r.hub, reader.cookie, {}, NOTICE_PATH)).status).toBe(405);
      expect((await directoryBrowser(r.hub, reader.cookie, undefined, `${NOTICE_PATH}/${first}/ack`)).status).toBe(405);
      const eligibility = vi.spyOn(r.deps.directory, "checkEligibility").mockResolvedValue({ eligible: false, reason: "disabled" });
      try { expect((await directoryBrowser(r.hub, reader.cookie, undefined, NOTICE_PATH)).status).toBe(401); }
      finally { eligibility.mockRestore(); }
    } finally { await r.runtime.close(); }
  });
  it("omits its mark and returns 404 with an older entry missing the notice adapter", async () => {
    const r = await directoryRuntimeRig(undefined, { noDirectoryNotices: true });
    try {
      const browser = await noticeSignIn(r, ADMIN);
      expect(browser.json.features).not.toContain("directory-security-notices-v1");
      expect(r.http.features).not.toContain("directory-security-notices-v1");
      expect((await directoryBrowser(r.hub, browser.cookie, undefined, NOTICE_PATH)).status).toBe(404);
      expect((await directoryBrowser(r.hub, browser.cookie, {}, `${NOTICE_PATH}/${randomUUID()}/ack`, { headers: { "X-AgEnD-Hub-CSRF": browser.json.csrf } })).status).toBe(404);
    } finally { await r.runtime.close(); }
  });
  it.each(["read", "ack"] as const)("rechecks the actual browser session after a held %s settles", async kind => {
    const r = await directoryRuntimeRig(undefined, { people: [NOTICE_READER] }); let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    let pending: ReturnType<typeof directoryBrowser> | undefined;
    try {
      const id = await directoryNoticeCommit(r, 1), reader = await noticeSignIn(r), notices = r.deps.directoryNotices!;
      const originalRead = notices.forSession.bind(notices), originalAck = notices.acknowledgeSession.bind(notices);
      const spy = kind === "read" ? vi.spyOn(notices, "forSession").mockImplementation(async (...args) => {
        const page = await originalRead(...args); entered(); await held; return page;
      }) : vi.spyOn(notices, "acknowledgeSession").mockImplementation(async (...args) => { await originalAck(...args); entered(); await held; });
      try {
        pending = directoryBrowser(r.hub, reader.cookie, kind === "ack" ? {} : undefined,
          kind === "ack" ? `${NOTICE_PATH}/${id}/ack` : NOTICE_PATH, { headers: { "X-AgEnD-Hub-CSRF": reader.json.csrf } });
        await ready;
        expect((await directoryBrowser(r.hub, reader.cookie, undefined, "/hub/v1/session", { method: "DELETE", headers: { "X-AgEnD-Hub-CSRF": reader.json.csrf } })).status).toBe(200);
        release(); expect((await pending).status).toBe(401); pending = undefined;
        const db = new Database(join(r.hub.home, SERVER_SET.database), { readonly: true });
        try { expect(db.prepare("SELECT state FROM hub_settings_security_targets WHERE notice_id=? AND kind='person'").get(id))
          .toEqual({ state: kind === "ack" ? "delivered" : "queued" }); }
        finally { db.close(); }
      } finally { release(); await pending?.catch(() => {}); spy.mockRestore(); }
    } finally { release(); await r.runtime.close(); }
  });
  it("answers unavailable when a real directory decision fences a held disclosure before its response", async () => {
    const r = await directoryRuntimeRig(undefined, { people: [NOTICE_READER] }); let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    let pending: ReturnType<typeof directoryBrowser> | undefined;
    try {
      await directoryNoticeCommit(r, 1); const reader = await noticeSignIn(r), notices = r.deps.directoryNotices!, original = notices.forSession.bind(notices);
      const spy = vi.spyOn(notices, "forSession").mockImplementation(async (...args) => { const page = await original(...args); entered(); await held; return page; });
      try {
        pending = directoryBrowser(r.hub, reader.cookie, undefined, NOTICE_PATH); await ready;
        await directoryNoticeCommit(r, 2, false); release();
        expect(await pending).toMatchObject({ status: 503, json: { code: "unavailable" } }); pending = undefined;
      } finally { release(); await pending?.catch(() => {}); spy.mockRestore(); }
    } finally { release(); await r.runtime.close(); }
  });
});

describe.skipIf(process.platform === "win32")("directory browser facade belongs to its mounted generation", () => {
  it("releases only the committed successor once after remount; old cookies and held old sign-in remain revoked", async () => {
    const r = await directoryRuntimeRig(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }); let entered!: () => void;
    const inDriver = new Promise<void>(resolve => { entered = resolve; });
    let pending: ReturnType<typeof directoryBrowser> | undefined;
    const inspect = () => new Database(join(r.hub.home, SERVER_SET.database), { readonly: true });
    try {
      const credentials = { login: ADMIN.login, password: "Dummy-browser-only" };
      const signed = await directoryBrowser(r.hub, undefined, credentials), other = await directoryBrowser(r.hub, undefined, credentials);
      expect(signed.status).toBe(200); expect(other.status).toBe(200); expect(signed.json.admin).toBe(true);
      const token = signed.cookie.slice(signed.cookie.indexOf("=") + 1), db = inspect();
      let original: { id: string; expires_at: number };
      try { original = db.prepare("SELECT id,expires_at FROM hub_sessions WHERE token_hash=?").get(createHash("sha256").update(token).digest("hex")) as typeof original; }
      finally { db.close(); }
      const actor = { kind: "hub-administrator" as const, person: ADMIN.key, sessionId: original.id, requestId: randomUUID() };
      const old = r.runtime.directorySettings()!, oldSessions = old.sessions();
      expect(oldSessions.recentAuthentication(actor)).toEqual(expect.any(Number));
      const rotation = oldSessions.prepareDirectoryRotation(token, actor);
      const proof = createHubDirectorySettingsProof({ source: old.source, withDirectoryRead: old.withDirectoryRead,
        recentAuthentication: a => oldSessions.recentAuthentication(a), writer: () => r.writer.directory!,
        createDirectory: () => ({ realm: "corp", signIn: async () => { throw Error("personal credentials reached candidate"); },
          checkEligibility: async () => ({ eligible: true, person: ADMIN }), close: async () => {} }), probeTls: async () => "a".repeat(64) });
      let saved: { receiptId: string; directoryEpoch: number };
      try {
        const candidate = r.candidate(), ctx = { actor, current: () => true };
        const draft = await proof.prepare({ ...candidate, changes: [...candidate.changes] }, ctx);
        r.holdSignIn(async () => { entered(); await held; });
        pending = directoryBrowser(r.hub, undefined, credentials); await inDriver;
        saved = await proof.apply(draft.ref, { confirmation: draft.trust!.challenge }, ctx, rotation);
      } finally { proof.close(); }
      expect(saved.directoryEpoch).toBe(1);
      expect(() => old.sessions()).toThrow();
      expect(() => oldSessions.completeDirectoryRotation(rotation, saved.receiptId)).toThrow();
      release(); expect((await pending).status).toBe(503); pending = undefined; r.holdSignIn();
      await r.runtime.apply(r.hub.config);
      const fresh = r.runtime.directorySettings()!.sessions();
      expect((await directoryBrowser(r.hub, signed.cookie)).json.signedIn).toBe(false);
      expect((await directoryBrowser(r.hub, other.cookie)).json.signedIn).toBe(false);
      expect(() => fresh.completeDirectoryRotation(rotation, randomUUID())).toThrow();
      const beforeRelease = Date.now(), successor = fresh.completeDirectoryRotation(rotation, saved.receiptId), afterRelease = Date.now();
      expect(successor.maxAgeMs).toBeGreaterThan(0);
      expect(successor.maxAgeMs).toBeLessThanOrEqual(original.expires_at - beforeRelease);
      expect(successor.maxAgeMs).toBeGreaterThanOrEqual(original.expires_at - afterRelease);
      expect(() => fresh.completeDirectoryRotation(rotation, saved.receiptId)).toThrow();
      const cookie = hubSetCookie(String(r.hub.config.hub.hubId), successor.token, successor.maxAgeMs).split(";")[0]!;
      expect((await directoryBrowser(r.hub, cookie)).json).toMatchObject({ signedIn: true, admin: true, login: ADMIN.login });
      const after = inspect();
      try {
        const rows = after.prepare("SELECT id,expires_at,state FROM hub_sessions").all() as Array<{ id: string; expires_at: number; state: string }>;
        expect(rows).toHaveLength(3); expect(rows.filter(row => row.state === "active")).toHaveLength(1);
        const active = rows.find(row => row.state === "active")!; expect(active.expires_at).toBe(original.expires_at);
        expect(fresh.recentAuthentication({ ...actor, sessionId: active.id })).toBeNull();
      } finally { after.close(); }
      r.runtime.fence(); expect(() => fresh.prepareDirectoryRotation(successor.token, actor)).toThrow();
    } finally { release(); await pending?.catch(() => {}); await r.runtime.close(); }
  });
  it("an older HTTP entry without the private session adapter refuses handoff", async () => {
    const hub = await initializedHub(), http = fakeHttp();
    const runtime = new HubRuntime({ home: hub.home, log: () => {}, components: { http: async () => http.entry } });
    try { await runtime.apply(hub.config); expect(runtime.directorySettings()).not.toBeNull(); expect(() => runtime.directorySettings()!.sessions()).toThrow(); }
    finally { await runtime.close(); }
  });
});

/** This owned test route exercises only the physical adapter; no public AD route or authority bypass is installed. */
async function directoryResponseRig(manual = false) {
  let enter!: (response: HubDirectoryResponse) => void;
  const entered = new Promise<HubDirectoryResponse>(resolve => { enter = resolve; });
  let attempt!: (capture: (proof: () => boolean) => HubDirectoryResponse) => void;
  const attempting = new Promise<(proof: () => boolean) => HubDirectoryResponse>(resolve => { attempt = resolve; });
  const r = await directoryRuntimeRig((http, deps) => ({ ...http, handle(req, res) {
    if (req.url !== "/test-only/owned-response") return http.handle(req, res);
    req.resume(); req.once("end", () => {
      const capture = (proof: () => boolean) => deps.directoryResponse!.capture(req, res, proof);
      if (manual) attempt(capture); else enter(capture(() => deps.current().serverEnabled()));
    });
    return true;
  } }));
  return { ...r, get coldBorrows() { return r.coldBorrows; }, begin: (cookie?: string) => directoryBrowser(r.hub, cookie, {}, "/test-only/owned-response"), entered, attempting };
}

describe.skipIf(process.platform === "win32")("directory response survives its owning listener remount", () => {
  it("refuses revoked-generation capture before calling its caller proof", async () => {
    const r = await directoryResponseRig(true), pending = r.begin().catch(() => null);
    try {
      const capture = await r.attempting; r.commit(); const proof = vi.fn(() => true);
      expect(() => capture(proof)).toThrow(); expect(proof).not.toHaveBeenCalled();
    } finally { await r.runtime.close(); await pending; }
  });
  it("refuses capture if the caller proof revokes its generation", async () => {
    const r = await directoryResponseRig(true), pending = r.begin().catch(() => null);
    try {
      const capture = await r.attempting;
      expect(() => capture(() => { r.commit(); return true; })).toThrow();
    } finally { await r.runtime.close(); await pending; }
  });
  it("refuses reply under its old generation's authority after revocation", async () => {
    const r = await directoryResponseRig(true), pending = r.begin().catch(() => null);
    try {
      const capture = await r.attempting, old = r.runtime.directorySettings()!, response = capture(() => true); r.commit();
      const build = vi.fn(() => ({ status: 200, json: "{}" }));
      await expect(response.reply(build, old.current)).rejects.toThrow(); expect(build).not.toHaveBeenCalled();
      expect(await pending).toBeNull();
    } finally { await r.runtime.close(); await pending; }
  });
  it("delivers the committed successor on the original HTTPS response after same-port remount", async () => {
    const r = await directoryResponseRig(); let pending: ReturnType<typeof r.begin> | undefined;
    try {
      const signed = await directoryBrowser(r.hub, undefined, { login: ADMIN.login, password: "Dummy-browser-only" });
      expect(signed.status).toBe(200);
      const token = signed.cookie.slice(signed.cookie.indexOf("=") + 1), db = new Database(join(r.hub.home, SERVER_SET.database), { readonly: true });
      let sessionId: string;
      try { sessionId = (db.prepare("SELECT id FROM hub_sessions WHERE token_hash=?").get(createHash("sha256").update(token).digest("hex")) as { id: string }).id; }
      finally { db.close(); }
      const actor = { kind: "hub-administrator" as const, person: ADMIN.key, sessionId, requestId: randomUUID() };
      const old = r.runtime.directorySettings()!, sessions = old.sessions(), rotation = sessions.prepareDirectoryRotation(token, actor);
      const proof = createHubDirectorySettingsProof({ source: old.source, withDirectoryRead: old.withDirectoryRead,
        recentAuthentication: a => sessions.recentAuthentication(a), writer: () => r.writer.directory!,
        createDirectory: () => ({ realm: "corp", signIn: async () => { throw Error("personal credentials reached candidate"); },
          checkEligibility: async () => ({ eligible: true, person: ADMIN }), close: async () => {} }), probeTls: async () => "a".repeat(64) });
      try {
        const candidate = r.candidate(), ctx = { actor, current: () => true };
        const draft = await proof.prepare({ ...candidate, changes: [...candidate.changes] }, ctx);
        pending = r.begin(signed.cookie); const response = await r.entered;
        const saved = await proof.apply(draft.ref, { confirmation: draft.trust!.challenge }, ctx, rotation);
        expect(old.current()).toBe(false); expect(response.current()).toBe(true);
        await r.runtime.apply(r.hub.config);
        expect(r.runtime.serverHealth(r.hub.config.hub)).toBe("ready");
        const fresh = r.runtime.directorySettings()!;
        const sending = response.reply(() => {
          const successor = fresh.sessions().completeDirectoryRotation(rotation, saved.receiptId);
          return { status: 200, json: JSON.stringify({ ok: true }), cookie: hubSetCookie(String(r.hub.config.hub.hubId), successor.token, successor.maxAgeMs) };
        }, fresh.current);
        const result = await pending; pending = undefined; await sending;
        expect(result.status).toBe(200); expect(result.json).toEqual({ ok: true }); expect(result.cookie).not.toBe(signed.cookie);
        expect((await directoryBrowser(r.hub, result.cookie)).json).toMatchObject({ signedIn: true, admin: true });
        expect((await directoryBrowser(r.hub, signed.cookie)).json.signedIn).toBe(false);
        await expect(response.reply(() => ({ status: 200, json: "{}" }), fresh.current)).rejects.toThrow();
      } finally { proof.close(); }
    } finally { await r.runtime.close(); await pending?.catch(() => {}); }
  });
  it("Stop aborts a transferred response synchronously and drains it before finishing", async () => {
    const r = await directoryResponseRig(); const pending = r.begin().catch(() => null);
    try {
      const response = await r.entered; r.commit(); await r.runtime.apply(r.hub.config);
      expect(response.current()).toBe(true); r.runtime.fence(); expect(response.current()).toBe(false);
      const build = vi.fn(() => ({ status: 200, json: "{}" }));
      await expect(response.reply(build, () => true)).rejects.toThrow(); expect(build).not.toHaveBeenCalled();
      await r.runtime.close(); expect(await pending).toBeNull(); expect(await refused(r.hub.webPort)).toBe(true);
    } finally { await r.runtime.close(); await pending; }
  });
  it("Stop retains the transferred server until its physical close acknowledges", async () => {
    const r = await directoryResponseRig(), pending = r.begin().catch(() => null); await r.entered;
    const original = HttpsServer.prototype.close; let held = false, release: (() => void) | undefined, acknowledge!: () => void;
    const acknowledged = new Promise<void>(resolve => { acknowledge = resolve; });
    let drain!: () => void;
    const draining = new Promise<void>(resolve => { drain = resolve; });
    const originalDrain = HubDirectoryResponseOwner.prototype.close;
    // Entry is after mount.close and drainLeftovers have settled; only the transferred server remains held.
    const ownerClose = vi.spyOn(HubDirectoryResponseOwner.prototype, "close").mockImplementation(function(this: HubDirectoryResponseOwner) {
      drain(); return originalDrain.call(this);
    });
    const close = vi.spyOn(HttpsServer.prototype, "close").mockImplementation(function(this: HttpsServer, callback?: (error?: Error) => void) {
      const address = this.address(), hold = !held && typeof address === "object" && address?.port === r.hub.webPort;
      if (hold) held = true;
      return original.call(this, error => { if (hold) { release = () => callback?.(error); acknowledge(); } else callback?.(error); });
    });
    let stopping: Promise<void> | undefined;
    try {
      r.commit(); await r.runtime.apply(r.hub.config); let stopped = false;
      stopping = r.runtime.close().then(() => { stopped = true; }); await acknowledged;
      expect(await Promise.race([draining.then(() => "draining"), stopping.then(() => "stopped")])).toBe("draining");
      expect(await Promise.race([stopping.then(() => "stopped"), new Promise<string>(resolve => setImmediate(() => resolve("held")))])).toBe("held");
      expect(stopped).toBe(false);
      release!(); await stopping; expect(stopped).toBe(true); expect(await pending).toBeNull();
    } finally { release?.(); close.mockRestore(); ownerClose.mockRestore(); await stopping; await r.runtime.close(); await pending; }
  });
});

describe.skipIf(process.platform === "win32")("private Save orchestration with real SQL and HTTPS", () => {
  it.each(["refused", "decided", "rollback"] as const)("reports only a proven pre-decision refusal, not a %s uncertain outcome", async phase => {
    const r = await directoryResponseRig(true), oldDirectory = structuredClone(r.hub.config.hub.directory);
    let pending: Promise<Awaited<ReturnType<typeof r.begin>> | null> | undefined, coordinator: ReturnType<typeof createHubDirectorySaveCoordinator> | undefined;
    let commit: ReturnType<typeof vi.spyOn> | undefined;
    let audit: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const signed = await directoryBrowser(r.hub, undefined, { login: ADMIN.login, password: "Dummy-browser-only" });
      const token = signed.cookie.slice(signed.cookie.indexOf("=") + 1), db = new Database(join(r.hub.home, SERVER_SET.database), { readonly: true });
      let sessionId: string;
      try { sessionId = (db.prepare("SELECT id FROM hub_sessions WHERE token_hash=?").get(createHash("sha256").update(token).digest("hex")) as { id: string }).id; }
      finally { db.close(); }
      const actor = { kind: "hub-administrator" as const, person: ADMIN.key, sessionId, requestId: randomUUID() };
      const old = r.runtime.directorySettings()!, sessions = old.sessions(), before = old.decision.inspect();
      const rotation = sessions.prepareDirectoryRotation(token, actor);
      const proof = createHubDirectorySettingsProof({ source: old.source, withDirectoryRead: old.withDirectoryRead,
        recentAuthentication: a => sessions.recentAuthentication(a), writer: () => r.writer.directory!,
        createDirectory: () => ({ realm: "corp", signIn: async () => { throw Error("personal credentials reached candidate"); },
          checkEligibility: async () => ({ eligible: true, person: ADMIN }), close: async () => {} }), probeTls: async () => "a".repeat(64) });
      const remount = vi.fn(() => r.runtime.apply(r.hub.config));
      coordinator = createHubDirectorySaveCoordinator({ hubId: String(r.hub.config.hub.hubId), proof,
        mounted: () => r.runtime.directorySettings(), writer: () => r.writer.directory!, withDecision: async work => r.withDecision(work),
        remount, current: () => true });
      const candidate = r.candidate(), context = { actor, current: () => true };
      const draft = await proof.prepare({ ...candidate, changes: [...candidate.changes] }, context);
      if (phase === "refused") commit = vi.spyOn(r.writer.directory!, "commit").mockImplementation(() => { throw new HubSettingsError("stale"); });
      else if (phase === "decided") r.crashAt("directory-decision");
      else audit = vi.spyOn(r.deps.audit, "appendInTransaction").mockImplementationOnce(() => { throw Error("owned audit failure after floor advance"); });
      pending = r.begin(signed.cookie).catch(() => null); const capture = await r.attempting;
      await expect(coordinator.apply(draft.ref, { confirmation: draft.trust!.challenge }, context,
        { capture: () => capture(old.current), rotation })).rejects.toThrow();
      const result = await pending; pending = undefined;
      expect(remount).not.toHaveBeenCalled(); expect(r.hub.config.hub.directory).toEqual(oldDirectory);
      if (phase === "refused") {
        expect(result).toMatchObject({ status: 409, json: { ok: false, code: "stale", committed: false }, cookie: "" });
        expect(old.decision.inspect()).toEqual(before);
        expect((await directoryBrowser(r.hub, signed.cookie)).json).toMatchObject({ signedIn: true, admin: true });
        expect(r.writer.pending()).toBe(false);
      } else {
        expect(result).toBeNull(); expect(old.current()).toBe(false); expect(r.writer.pending()).toBe(true);
        if (phase === "decided") expect(r.withDecision(d => d.inspect().directoryEpoch)).toBe(1);
        else {
          expect(() => r.withDecision(d => d.inspect())).toThrow("uncertain");
          const rolledBack = new Database(join(r.hub.home, SERVER_SET.database), { readonly: true });
          try {
            expect(rolledBack.prepare("SELECT directory_epoch FROM hub_settings_head").get()).toEqual({ directory_epoch: 0 });
            expect(rolledBack.prepare("SELECT count(*) n FROM hub_settings_operations").get()).toEqual({ n: 0 });
          } finally { rolledBack.close(); }
        }
      }
    } finally { commit?.mockRestore(); audit?.mockRestore(); await coordinator?.close(); await r.runtime.close(); await pending?.catch(() => {}); }
  });

  it.each(["ready", "restored"] as const)("returns %s on the original response without reviving an old session", async outcome => {
    const r = await directoryResponseRig(true), originalDirectory = structuredClone(r.hub.config.hub.directory);
    let pending: ReturnType<typeof r.begin> | undefined;
    let coordinator: ReturnType<typeof createHubDirectorySaveCoordinator> | undefined, running = true;
    try {
      const signed = await directoryBrowser(r.hub, undefined, { login: ADMIN.login, password: "Dummy-browser-only" }); expect(signed.status).toBe(200);
      const token = signed.cookie.slice(signed.cookie.indexOf("=") + 1), db = new Database(join(r.hub.home, SERVER_SET.database), { readonly: true });
      let sessionId: string;
      try { sessionId = (db.prepare("SELECT id FROM hub_sessions WHERE token_hash=?").get(createHash("sha256").update(token).digest("hex")) as { id: string }).id; }
      finally { db.close(); }
      const actor = { kind: "hub-administrator" as const, person: ADMIN.key, sessionId, requestId: randomUUID() };
      const old = r.runtime.directorySettings()!, sessions = old.sessions(), rotation = sessions.prepareDirectoryRotation(token, actor);
      const proof = createHubDirectorySettingsProof({ source: old.source, withDirectoryRead: old.withDirectoryRead,
        recentAuthentication: a => sessions.recentAuthentication(a), writer: () => r.writer.directory!,
        createDirectory: () => ({ realm: "corp", signIn: async () => { throw Error("personal credentials reached candidate"); },
          checkEligibility: async () => ({ eligible: true, person: ADMIN }), close: async () => {} }), probeTls: async () => "a".repeat(64) });
      coordinator = createHubDirectorySaveCoordinator({ hubId: String(r.hub.config.hub.hubId), proof,
        mounted: () => r.runtime.directorySettings(), writer: () => r.writer.directory!, withDecision: async work => r.withDecision(work),
        remount: () => r.runtime.apply(r.hub.config), current: () => running });
      const candidate = r.candidate(), context = { actor, current: () => true };
      const draft = await proof.prepare({ ...candidate, changes: [...candidate.changes] }, context);
      if (outcome === "restored") r.refuseNextDirectory();
      pending = r.begin(signed.cookie); const capture = await r.attempting;
      const saved = await coordinator.apply(draft.ref, { confirmation: draft.trust!.challenge }, context, { capture: () => capture(old.current), rotation });
      const result = await pending; pending = undefined;
      expect(saved.state).toBe(outcome); expect(result.json.state).toBe(outcome); expect(result.status).toBe(outcome === "ready" ? 200 : 503);
      expect(r.runtime.serverHealth(r.hub.config.hub)).toBe("ready"); expect((await directoryBrowser(r.hub, signed.cookie)).json.signedIn).toBe(false);
      const after = new Database(join(r.hub.home, SERVER_SET.database), { readonly: true });
      try {
        const epoch = outcome === "ready" ? 1 : 2;
        expect(after.prepare("SELECT directory_epoch FROM hub_settings_head").get()).toEqual({ directory_epoch: epoch });
        expect(after.prepare("SELECT count(*) n FROM hub_settings_operations").get()).toEqual({ n: epoch });
        expect(after.prepare("SELECT count(*) n FROM hub_settings_security_notices").get()).toEqual({ n: epoch });
        const intent = after.prepare("SELECT expires_at,state,completed_at FROM hub_settings_mount_recovery").get() as { expires_at: number; state: string; completed_at: number };
        expect(intent).toMatchObject({ state: outcome === "ready" ? "ready" : "compensated", completed_at: expect.any(Number) });
        const original = JSON.parse((after.prepare("SELECT body FROM hub_settings_operations ORDER BY rowid LIMIT 1").get() as { body: string }).body);
        expect(original.recovery).toEqual({ v: 1, expiresAt: intent.expires_at });
        expect(intent.expires_at - original.at).toBeGreaterThan(0); expect(intent.expires_at - original.at).toBeLessThanOrEqual(300_000);
        expect(after.prepare("SELECT count(*) n FROM hub_sessions WHERE state='active'").get()).toEqual({ n: outcome === "ready" ? 1 : 0 });
      } finally { after.close(); }
      if (outcome === "ready") {
        expect((await directoryBrowser(r.hub, result.cookie)).json).toMatchObject({ signedIn: true, admin: true });
      } else {
        expect(r.hub.config.hub.directory).toEqual(originalDirectory); expect(result.cookie).toBe("");
        const counters = r.withDecision(d => ({ compensation: d.operation(saved.receiptId).compensates, head: d.inspect() }));
        expect(counters.compensation).toEqual(expect.any(String)); expect(r.coldBorrows).toBeGreaterThan(0);
      }
    } finally { running = false; await coordinator?.close(); await r.runtime.close(); await pending?.catch(() => {}); }
  });
});

describe.skipIf(process.platform === "win32")("directory runtime review regressions", () => {
  it.each(["member-await", "before-publication"])("refuses changed material at %s without publishing the directory control", async stage => {
    const hub = await initializedHub(), http = fakeHttp(), published = vi.fn(() => vi.fn());
    let release!: () => void, entered!: () => void;
    const wait = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { entered = r; });
    const originalStart = HubServer.prototype.start;
    const start = vi.spyOn(HubServer.prototype, "start").mockImplementation(async function(this: HubServer) {
      if (stage === "member-await") { entered(); await wait; }
      return originalStart.call(this);
    });
    const change = () => atomicWriteFileSync(join(hub.home, "hub/secrets/directory-bind"), "Changed-during-start", { mode: 0o600 });
    const f = factory(hub.home, http.entry, { directoryReady: published,
      retentionReady: () => { if (stage === "before-publication") change(); return () => {}; } });
    const runtime = new HubRuntime({ home: hub.home, log: () => {}, createServer: f.create });
    try {
      const applying = runtime.apply(hub.config);
      if (stage === "member-await") { await ready; change(); release(); }
      await applying;
      expect(start).toHaveBeenCalledOnce(); expect(published).not.toHaveBeenCalled();
      expect(runtime.directorySettings()).toBeNull(); expect(runtime.serverHealth(hub.config.hub)).toBe("unavailable");
      expect(await refused(hub.webPort)).toBe(true); expect(await refused(hub.memberPort)).toBe(true);
    } finally { release(); await runtime.close(); start.mockRestore(); }
  });

  it.each(["recovery", "pending-apply"])("%s holds only this server, retaining the unrelated member link and honoring member disconnect", async mode => {
    const hub = await initializedHub(), config = { ...hub.config, hub_member: { enabled: true, hub: "other.example.test" } };
    const writer = createHubSettingsWriter({ home: hub.home, readHub: () => hub.config.hub, saveHub: () => {} });
    const server = { start: vi.fn(async () => {}), close: vi.fn(async () => {}), fence: vi.fn() };
    const member = { start: vi.fn(async () => {}), close: vi.fn(async () => {}), fence: vi.fn() };
    let memberCurrent!: () => boolean;
    const createMember = vi.fn(async (_cfg, current: () => boolean) => { memberCurrent = current; return member; });
    const runtime = new HubRuntime({ home: hub.home, log: () => {}, settingsWriter: writer,
      createServer: async () => server, createMember });
    const pending = vi.spyOn(writer, "pending"), recover = vi.spyOn(writer, "recover");
    try {
      await runtime.apply(config); expect(memberCurrent()).toBe(true); member.fence.mockClear();
      pending.mockReturnValue(true); recover.mockImplementation(() => { throw Error("owned refusal"); });
      if (mode === "recovery") await expect(runtime.recoverSettings(config)).rejects.toThrow("owned refusal");
      else await runtime.apply(config);
      expect(memberCurrent()).toBe(true); expect(member.fence).not.toHaveBeenCalled(); expect(member.close).not.toHaveBeenCalled();
      expect(createMember).toHaveBeenCalledOnce(); expect(server.close).toHaveBeenCalledOnce();
      expect(runtime.currentHolds()).toContainEqual(expect.objectContaining({ side: "server", reason: "settings-recovery" }));
      await runtime.apply({ ...config, hub_member: { enabled: false } });
      expect(memberCurrent()).toBe(false); expect(member.close).toHaveBeenCalledOnce(); expect(createMember).toHaveBeenCalledOnce();
    } finally { pending.mockRestore(); recover.mockRestore(); await runtime.close(); }
  });

  it("an initially held server still admits the independently configured member", async () => {
    const hub = await initializedHub(), member = { start: vi.fn(async () => {}), close: vi.fn(async () => {}), fence: vi.fn() };
    const writer = createHubSettingsWriter({ home: hub.home, readHub: () => hub.config.hub, saveHub: () => {} });
    const pending = vi.spyOn(writer, "pending").mockReturnValue(true), server = vi.fn(async () => member);
    let current!: () => boolean;
    const runtime = new HubRuntime({ home: hub.home, log: () => {}, settingsWriter: writer, createServer: server,
      createMember: async (_cfg, live) => { current = live; return member; } });
    try {
      await runtime.apply({ ...hub.config, hub_member: { enabled: true } });
      expect(member.start).toHaveBeenCalledOnce(); expect(current()).toBe(true); expect(server).not.toHaveBeenCalled();
      expect(runtime.serverHealth(hub.config.hub)).toBe("unavailable");
    } finally { pending.mockRestore(); await runtime.close(); }
  });

  it.each(["factory", "start"])("a server-only hold during a held %s cannot cancel the member startup or a newer pending apply", async phase => {
    const hub = await initializedHub(), config = { ...hub.config, hub_member: { enabled: true } };
    let entered!: () => void, release!: () => void, memberCurrent!: () => boolean;
    const ready = new Promise<void>(r => { entered = r; }), held = new Promise<void>(r => { release = r; });
    const pause = async () => { entered(); await held; };
    const server = { start: vi.fn(async () => { if (phase === "start") await pause(); }), close: vi.fn(async () => {}), fence: vi.fn() };
    const member = { start: vi.fn(async () => {}), close: vi.fn(async () => {}), fence: vi.fn() };
    const writer = createHubSettingsWriter({ home: hub.home, readHub: () => hub.config.hub, saveHub: () => {} });
    const pending = vi.spyOn(writer, "pending"), recover = vi.spyOn(writer, "recover");
    const runtime = new HubRuntime({ home: hub.home, log: () => {}, settingsWriter: writer,
      createServer: async () => { if (phase === "factory") await pause(); return server; },
      createMember: async (_cfg, current) => { memberCurrent = current; return member; } });
    try {
      const first = runtime.apply(config); await ready;
      pending.mockReturnValue(true); recover.mockImplementation(() => { throw Error("owned refusal"); });
      const refusing = expect(runtime.recoverSettings(config)).rejects.toThrow("owned refusal");
      const latest = runtime.apply({ ...config, hub: { ...hub.config.hub, name: "Held new server config" } });
      release(); await first; await latest; await refusing;
      expect(member.start).toHaveBeenCalledOnce(); expect(memberCurrent()).toBe(true); expect(member.close).not.toHaveBeenCalled();
      expect(server.start).toHaveBeenCalledTimes(phase === "factory" ? 0 : 1); expect(server.close).toHaveBeenCalledOnce();
      expect(runtime.serverHealth(hub.config.hub)).toBe("unavailable");
    } finally { release(); pending.mockRestore(); recover.mockRestore(); await runtime.close(); }
  });

  it("an old captured disposer cannot withdraw a later directory publication", async () => {
    const module = await import("../src/hub/compose/server.js"), original = module.createHubServerFactory;
    let publish!: NonNullable<import("../src/hub/compose/server.js").HubServerFactoryOptions["directoryReady"]>;
    const spy = vi.spyOn(module, "createHubServerFactory").mockImplementation(options => { publish = options.directoryReady!; return original(options); });
    const hub = await initializedHub(), runtime = new HubRuntime({ home: hub.home, log: () => {} });
    const first = { current: () => true } as import("../src/hub/settings-directory-runtime.js").HubMountedDirectory;
    const second = { current: () => true } as import("../src/hub/settings-directory-runtime.js").HubMountedDirectory;
    try {
      const oldDispose = publish(first), newDispose = publish(second); oldDispose();
      expect(runtime.directorySettings()).toBe(second); newDispose(); expect(runtime.directorySettings()).toBeNull();
    } finally { spy.mockRestore(); await runtime.close(); }
  });
});


describe.skipIf(process.platform === "win32")("durable directory startup reconciliation", () => {
  it("closes an exact pending intent after restart and the actual ready HTTPS mount", async () => {
    const r = await directoryRuntimeRig();
    try {
      const saved = r.commit(undefined, Date.now() + 300_000); await r.runtime.close(); r.build();
      await r.runtime.apply(r.hub.config);
      expect(r.runtime.serverHealth(r.hub.config.hub)).toBe("ready");
      expect(r.runtime.directorySettings()!.decision.mountRecovery()).toMatchObject({state:"ready",operation:{id:saved.receiptId}});
      expect((await get(r.hub.webPort, "/hub/v1/session", r.hub.caPem)).status).toBe(200);
    } finally { await r.runtime.close(); }
  });
  it("reconstructs a post-decision crash after cold file recovery without inventing a later deadline", async () => {
    const r = await directoryRuntimeRig(), deadline = Date.now() + 300_000;
    try {
      expect(() => r.commit("directory-decision", deadline)).toThrow("stop:directory-decision"); await r.runtime.close(); r.build();
      expect(await r.runtime.recoverSettings(r.hub.config)).toBe(true); await r.runtime.apply(r.hub.config);
      expect(r.runtime.directorySettings()!.decision.mountRecovery()).toMatchObject({state:"ready",expiresAt:deadline});
    } finally { await r.runtime.close(); }
  });
  it("a refused replacement mount consumes the exact allowance in one forward restoration and serves the old content", async () => {
    const r = await directoryRuntimeRig(), old = structuredClone(r.hub.config.hub);
    try {
      const saved = r.commit(undefined, Date.now() + 300_000); await r.runtime.close(); r.build(); r.refuseNextDirectory();
      await r.runtime.apply(r.hub.config);
      expect(r.runtime.serverHealth(r.hub.config.hub)).toBe("ready");
      const d = r.runtime.directorySettings()!.decision, head = d.inspect(), restored = d.operation(head.operationId!);
      expect(restored).toMatchObject({kind:"directory-compensation",compensates:saved.receiptId,directoryEpoch:2});
      expect(r.hub.config.hub.directory).toEqual(old.directory);
      const db = new Database(join(r.hub.home, SERVER_SET.database));
      try {
        expect(db.prepare("SELECT state FROM hub_settings_mount_recovery WHERE operation_id=?").get(saved.receiptId)).toEqual({state:"compensated"});
        expect(db.prepare("SELECT count(*) n FROM hub_settings_security_notices").get()).toEqual({n:2});
        expect(db.prepare("SELECT count(*) n FROM hub_sessions WHERE state='active'").get()).toEqual({n:0});
      } finally { db.close(); }
      expect((await get(r.hub.webPort, "/hub/v1/session", r.hub.caPem)).status).toBe(200);
    } finally { await r.runtime.close(); }
  });
  it.each([999, 1200])("a failed mount at clock %s keeps the expired/backward intent held without restoration", async time => {
    let now = 1000; const r = await directoryRuntimeRig(undefined, { now: () => now });
    try {
      const saved = r.commit(undefined, 1200); await r.runtime.close(); now = time; r.build(); r.refuseNextDirectory();
      await r.runtime.apply(r.hub.config);
      expect(r.runtime.serverHealth(r.hub.config.hub)).toBe("unavailable");
      expect(r.runtime.currentHolds()).toMatchObject([{side:"server",reason:"settings-recovery"}]);
      r.withDecision(d => {
        expect(d.inspect()).toMatchObject({operationId:saved.receiptId,directoryEpoch:1});
        expect(d.mountRecovery()).toMatchObject({state:"pending",expiresAt:1200});
      });
      expect(await refused(r.hub.webPort)).toBe(true);
    } finally { await r.runtime.close(); }
  });
  it("a failed restored mount stays held at its new epoch and never recursively restores", async () => {
    const r = await directoryRuntimeRig();
    try {
      const saved = r.commit(undefined, Date.now() + 300_000); await r.runtime.close(); r.build(); r.refuseAllDirectories();
      await r.runtime.apply(r.hub.config);
      expect(r.runtime.serverHealth(r.hub.config.hub)).toBe("unavailable");
      r.withDecision(d => {
        const op = d.operation(d.inspect().operationId!);
        expect(op).toMatchObject({kind:"directory-compensation",compensates:saved.receiptId,directoryEpoch:2});
        expect(d.mountRecovery()).toBeNull();
      });
      expect(await refused(r.hub.webPort)).toBe(true);
    } finally { await r.runtime.close(); }
  });
  it.each(["stop", "replacement"])("a held cold selection honors %s before any compensation", async mode => {
    const r = await directoryRuntimeRig(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    try {
      const saved = r.commit(undefined, Date.now() + 300_000); await r.runtime.close(); r.refuseNextDirectory();
      let calls = 0, enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
      r.build(async () => { if (++calls === 2) { enter(); await held; } return r.entry; });
      const startup = r.runtime.apply(r.hub.config); await entered;
      if (mode === "stop") r.runtime.fence();
      else void r.runtime.apply({...r.hub.config,hub:{...r.hub.config.hub,enabled:false}});
      release(); await startup;
      r.withDecision(d => {
        expect(d.inspect()).toMatchObject({operationId:saved.receiptId,directoryEpoch:1});
        expect(d.mountRecovery()).toMatchObject({state:"pending"});
      });
      expect(await refused(r.hub.webPort)).toBe(true);
    } finally { release(); await r.runtime.close(); }
  });

  it("Stop inside the final writer staging proof cannot commit a late compensation", async () => {
    const r = await directoryRuntimeRig();
    try {
      const saved = r.commit(undefined, Date.now() + 300_000); await r.runtime.close(); r.build(); r.refuseNextDirectory();
      r.atStage(() => r.runtime.fence()); await r.runtime.apply(r.hub.config);
      r.withDecision(d => {
        expect(d.inspect()).toMatchObject({operationId:saved.receiptId,directoryEpoch:1});
        expect(d.mountRecovery()).toMatchObject({state:"pending"});
      });
      expect(r.writer.pending()).toBe(false); expect(await refused(r.hub.webPort)).toBe(true);
    } finally { await r.runtime.close(); }
  });
  it("a changed intent between cold selection and final writer proof is not the captured operation", async () => {
    const r = await directoryRuntimeRig(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    try {
      const saved = r.commit(undefined, Date.now() + 300_000); await r.runtime.close(); r.refuseNextDirectory();
      let calls = 0, enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
      r.build(async () => { if (++calls === 3) { enter(); await held; } return r.entry; });
      const startup = r.runtime.apply(r.hub.config); await entered;
      const db = new Database(join(r.hub.home, SERVER_SET.database));
      try {
        const row = db.prepare("SELECT body FROM hub_settings_operations WHERE id=?").get(saved.receiptId) as {body:string};
        const op = JSON.parse(row.body); op.actor.requestId = randomUUID();
        db.prepare("UPDATE hub_settings_operations SET body=? WHERE id=?").run(JSON.stringify(op), saved.receiptId);
      } finally { db.close(); }
      release(); await startup;
      r.withDecision(d => expect(d.inspect()).toMatchObject({operationId:saved.receiptId,directoryEpoch:1}));
      expect(r.runtime.currentHolds()).toMatchObject([{reason:"settings-recovery"}]);
      expect(r.writer.pending()).toBe(false); expect(await refused(r.hub.webPort)).toBe(true);
    } finally { release(); await r.runtime.close(); }
  });

  it("a stale accepted-config reader never queues the wrong image after forward restoration", async () => {
    const r = await directoryRuntimeRig();
    try {
      r.commit(undefined, Date.now() + 300_000); await r.runtime.close();
      const stale = structuredClone(r.hub.config); r.build(undefined, () => stale); r.refuseNextDirectory();
      await r.runtime.apply(r.hub.config);
      expect(r.hub.config.hub.directory).not.toMatchObject({url:"ldaps://next.example.test"});
      expect(r.runtime.serverHealth(r.hub.config.hub)).toBe("unavailable");
      expect(r.runtime.currentHolds()).toMatchObject([{reason:"settings-recovery"}]);
      r.withDecision(d => expect(d.inspect().directoryEpoch).toBe(2));
      expect(await refused(r.hub.webPort)).toBe(true);
    } finally { await r.runtime.close(); }
  });

  it("a live Save remount leaves its pending intent to the request instead of running startup recovery again", async () => {
    const r = await directoryRuntimeRig();
    try {
      // This runtime already completed startup. The existing private request now owns its new pending operation.
      const saved = r.commit(undefined, Date.now() + 300_000); r.refuseNextDirectory(); await r.runtime.apply(r.hub.config);
      expect(r.runtime.serverHealth(r.hub.config.hub)).toBe("unavailable");
      r.withDecision(d => {
        expect(d.inspect()).toMatchObject({operationId:saved.receiptId,directoryEpoch:1});
        expect(d.mountRecovery()).toMatchObject({state:"pending"});
      });
    } finally { await r.runtime.close(); }
  });

  it.each([1, 2])("A-Off-A during startup import %s never revives the superseded attempt", async heldCall => {
    const r = await directoryRuntimeRig(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    try {
      const saved = r.commit(undefined, Date.now() + 300_000); await r.runtime.close(); r.refuseNextDirectory();
      let calls = 0, enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
      r.build(async () => { if (++calls === heldCall) { enter(); await held; } return r.entry; });
      const startup = r.runtime.apply(r.hub.config); await entered;
      void r.runtime.apply({...r.hub.config,hub:{...r.hub.config.hub,enabled:false}}); void r.runtime.apply(r.hub.config);
      release(); await startup;
      r.withDecision(d => {
        expect(d.inspect()).toMatchObject({operationId:saved.receiptId,directoryEpoch:1});
        expect(d.mountRecovery()).toMatchObject({state:"pending"});
      });
      expect(r.runtime.serverHealth(r.hub.config.hub)).toBe("unavailable");
    } finally { release(); await r.runtime.close(); }
  });
  it("an unchanged admitted view during cold selection retains the original restoration attempt", async () => {
    const r = await directoryRuntimeRig(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    try {
      const saved = r.commit(undefined, Date.now() + 300_000); await r.runtime.close(); r.refuseNextDirectory();
      let calls = 0, enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
      r.build(async () => { if (++calls === 2) { enter(); await held; } return r.entry; });
      const startup = r.runtime.apply(r.hub.config); await entered; void r.runtime.apply(r.hub.config); release(); await startup;
      expect(r.runtime.serverHealth(r.hub.config.hub)).toBe("ready");
      const d = r.runtime.directorySettings()!.decision;
      expect(d.operation(d.inspect().operationId!)).toMatchObject({kind:"directory-compensation",compensates:saved.receiptId,directoryEpoch:2});
    } finally { release(); await r.runtime.close(); }
  });
  it("A-Off-A inside final staging cannot revive the writer compensation proof", async () => {
    const r = await directoryRuntimeRig();
    try {
      const saved = r.commit(undefined, Date.now() + 300_000); await r.runtime.close(); r.build(); r.refuseNextDirectory();
      r.atStage(() => { void r.runtime.apply({...r.hub.config,hub:{...r.hub.config.hub,enabled:false}}); void r.runtime.apply(r.hub.config); });
      await r.runtime.apply(r.hub.config);
      r.withDecision(d => {
        expect(d.inspect()).toMatchObject({operationId:saved.receiptId,directoryEpoch:1});
        expect(d.mountRecovery()).toMatchObject({state:"pending"});
      });
      expect(r.writer.pending()).toBe(false);
    } finally { await r.runtime.close(); }
  });

});

const DIRECTORY_SETTINGS_PATH = "/hub/v1/admin/hub/directory";
describe.skipIf(process.platform === "win32")("configured administrator AD settings HTTP", () => {
  it.each(["inspect","fetch"] as const)("authorizes CA %s and advertises its distinct capability",async action=>{
    const operation=vi.fn(async(_input:unknown,_context:unknown)=>({ref:"fixture",certificates:[]}));
    const create=vi.fn(async()=>({[action==="inspect"?"inspectCa":"fetchCa"]:operation}) as unknown as HubDirectorySettingsControl);
    const r=await directoryRuntimeRig(undefined,{people:[NOTICE_READER],directorySettings:create});
    try{
      const path=DIRECTORY_SETTINGS_PATH+"/ca/"+action;
      expect((await directoryBrowser(r.hub,undefined,{url:"ldaps://next.example.test"},path)).status).toBe(401);
      const other=await noticeSignInForDirectory(r,NOTICE_READER);
      expect((await directoryBrowser(r.hub,other.cookie,{url:"ldaps://next.example.test"},path,{headers:{"X-AgEnD-Hub-CSRF":other.json.csrf}})).status).toBe(403);
      expect(create).not.toHaveBeenCalled();const signed=await noticeSignInForDirectory(r,ADMIN);
      expect(signed.json.features).toContain("directory-ca-v1");expect(r.http.features).toContain("directory-ca-v1");
      const body={url:"ldaps://next.example.test"};
      const result=await directoryBrowser(r.hub,signed.cookie,body,path,{headers:{"X-AgEnD-Hub-CSRF":signed.json.csrf}});
      expect(result.status).toBe(200);expect(operation).toHaveBeenCalledExactlyOnceWith(body,expect.objectContaining({actor:expect.objectContaining({kind:"hub-administrator",person:ADMIN.key})}));
    }finally{await r.runtime.close();}
  });

  it("authorizes the configured administrator before lazily acquiring the AD control", async () => {
    const read = vi.fn((_ctx: HubDirectoryProofContext) => ({ directory: { realm: "corp", profile: "openldap" }, bindPasswordSet: true }));
    const create = vi.fn(async () => ({ read }) as unknown as HubDirectorySettingsControl);
    const r = await directoryRuntimeRig(undefined, { directorySettings: create });
    try {
      const signed = await directoryBrowser(r.hub, undefined, { login: ADMIN.login, password: "Dummy-browser-only" });
      const result = await directoryBrowser(r.hub, signed.cookie, undefined, DIRECTORY_SETTINGS_PATH);
      expect(result.status).toBe(200); expect(result.json.bindPasswordSet).toBe(true);
      expect(signed.json.features).toContain("directory-settings-v1");
      expect(signed.json.features).toContain("directory-editor-v1");
      expect(r.http.features).toContain("directory-settings-v1");
      expect(r.http.features).toContain("directory-editor-v1");
      expect(create).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledOnce();
      expect(read.mock.calls[0]?.[0]).toMatchObject({ actor: { kind: "hub-administrator", person: ADMIN.key } });
    } finally { await r.runtime.close(); }
  });
  it("refuses unsigned, other-person, cross-site, CSRF, query and method requests before acquiring the control", async () => {
    const create = vi.fn(async () => ({ read: vi.fn() }) as unknown as HubDirectorySettingsControl);
    const r = await directoryRuntimeRig(undefined, { people: [NOTICE_READER], directorySettings: create });
    try {
      expect((await directoryBrowser(r.hub, undefined, undefined, DIRECTORY_SETTINGS_PATH)).status).toBe(401);
      const other = await noticeSignInForDirectory(r, NOTICE_READER), signed = await noticeSignInForDirectory(r, ADMIN);
      expect((await directoryBrowser(r.hub, other.cookie, undefined, DIRECTORY_SETTINGS_PATH)).status).toBe(403);
      expect((await directoryBrowser(r.hub, signed.cookie, {}, DIRECTORY_SETTINGS_PATH + "/prepare")).status).toBe(403);
      expect((await directoryBrowser(r.hub, signed.cookie, {}, DIRECTORY_SETTINGS_PATH + "/prepare", { headers: {
        Origin: "https://foreign.example.test", "X-AgEnD-Hub-CSRF": signed.json.csrf } })).status).toBe(403);
      expect((await directoryBrowser(r.hub, signed.cookie, undefined, DIRECTORY_SETTINGS_PATH + "?authority=host")).status).toBe(400);
      expect((await directoryBrowser(r.hub, signed.cookie, undefined, DIRECTORY_SETTINGS_PATH + "/save")).status).toBe(405);
      expect(create).not.toHaveBeenCalled();
    } finally { await r.runtime.close(); }
  });
  it.each(["sign-out", "disconnect"])("%s during lazy acquisition never reaches the control", async mode => {
    let release!: () => void, enter!: () => void, close!: () => void, settle!: () => void, released = false;
    const wait = new Promise<void>(r => { release = r; }), entered = new Promise<void>(r => { enter = r; }), closed = new Promise<void>(r => { close = r; });
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const read = vi.fn(), create = vi.fn(async () => { enter(); await wait; return { read } as unknown as HubDirectorySettingsControl; });
    const r = await directoryRuntimeRig((http) => ({ ...http, handle(req, res) {
      if (req.url === DIRECTORY_SETTINGS_PATH) {
        res.once("close", close);
        const remove = res.removeListener.bind(res);
        vi.spyOn(res, "removeListener").mockImplementation((event, listener) => {
          const result = remove(event, listener); if (event === "close" && released) settle(); return result;
        });
      }
      return http.handle(req, res);
    } }), { directorySettings: create });
    const abort = new AbortController(); let pending: Promise<Awaited<ReturnType<typeof directoryBrowser>> | null> | undefined;
    try {
      const signed = await noticeSignInForDirectory(r, ADMIN);
      pending = directoryBrowser(r.hub, signed.cookie, undefined, DIRECTORY_SETTINGS_PATH, { signal: abort.signal }).catch(() => null);
      await entered;
      if (mode === "sign-out") expect((await directoryBrowser(r.hub, signed.cookie, undefined, "/hub/v1/session", { method: "DELETE",
        headers: { "X-AgEnD-Hub-CSRF": signed.json.csrf } })).status).toBe(200);
      else { abort.abort(); await closed; }
      released = true; release(); const result = await pending; pending = undefined; await settled;
      expect(result?.status ?? null).toBe(mode === "sign-out" ? 401 : null); expect(read).not.toHaveBeenCalled();
    } finally { release(); await pending?.catch(() => {}); await r.runtime.close(); }
  });
  it("omits the mark and keeps routes unavailable without a controller", async () => {
    const r = await directoryRuntimeRig();
    try {
      const signed = await noticeSignInForDirectory(r, ADMIN);
      expect(signed.json.features).not.toContain("directory-settings-v1");
      expect(signed.json.features).not.toContain("directory-editor-v1");
      expect(signed.json.features).not.toContain("directory-ca-v1");
      expect((await directoryBrowser(r.hub, signed.cookie, undefined, DIRECTORY_SETTINGS_PATH)).status).toBe(404);
    } finally { await r.runtime.close(); }
  });
  it("returns a bounded unavailable response when the private factory refuses", async () => {
    const create = vi.fn(async (): Promise<HubDirectorySettingsControl> => { throw Error("Dummy-private-bind-material"); });
    const r = await directoryRuntimeRig(undefined, { directorySettings: create });
    try {
      const signed = await noticeSignInForDirectory(r, ADMIN), result = await directoryBrowser(r.hub, signed.cookie, undefined, DIRECTORY_SETTINGS_PATH);
      expect(result.status).toBe(503); expect(result.json).toEqual({ ok: false, code: "unavailable" });
      expect(JSON.stringify(result)).not.toContain("Dummy-private-bind-material");
    } finally { await r.runtime.close(); }
  });
});

const noticeSignInForDirectory = (r: Awaited<ReturnType<typeof directoryRuntimeRig>>, who: typeof ADMIN) =>
  directoryBrowser(r.hub, undefined, { login: who.login, password: "Dummy-browser-only" });

describe.skipIf(process.platform === "win32")("AD settings public HTTP with the real shared controller", () => {
  it.each(["ready", "restored", "unknown", "stale"] as const)("runs prepare/test/Save as %s through sealed SQL, sessions and original HTTPS", async outcome => {
    let control: HubDirectorySettingsControl | undefined, r!: Awaited<ReturnType<typeof directoryRuntimeRig>>;
    let commit: ReturnType<typeof vi.spyOn> | undefined;
    const personal = vi.fn(async () => { throw Error("personal credentials reached candidate"); });
    const candidate = vi.fn(() => ({ realm: "corp", signIn: personal,
      checkEligibility: async () => outcome === "unknown" ? { eligible: false as const, reason: "unavailable" as const }
        : { eligible: true as const, person: ADMIN }, close: async () => {} }));
    const create = async () => control ??= createHubDirectorySettingsControl({ hubId: String(r.hub.config.hub.hubId),
      mounted: () => r.runtime.directorySettings(), writer: () => r.writer.directory!, createDirectory: candidate, probeTls: async () => "a".repeat(64),
      withDecision: work => r.runtime.withDirectoryDecision(String(r.hub.config.hub.hubId), work, () => true),
      remount: () => r.runtime.apply(r.hub.config), current: () => true });
    r = await directoryRuntimeRig(undefined, { directorySettings: create });
    const beforeDirectory = structuredClone(r.hub.config.hub.directory);
    try {
      const signed = await noticeSignInForDirectory(r, ADMIN), headers = { "X-AgEnD-Hub-CSRF": signed.json.csrf };
      const readsBefore = r.eligibility, view = await directoryBrowser(r.hub, signed.cookie, undefined, DIRECTORY_SETTINGS_PATH);
      expect(r.eligibility - readsBefore).toBe(1);
      expect(view.status).toBe(200); expect(view.json.reauthentication).toBe("recent"); expect(view.json.bindPasswordSet).toBe(true);
      expect(view.json.directory.bindPasswordRef).toBeUndefined(); expect(JSON.stringify(view.json)).not.toContain(BIND);
      const { realm: _realm, profile: _profile, ...directory } = view.json.directory;
      const prepared = await directoryBrowser(r.hub, signed.cookie, { directory: { ...directory, url: "ldaps://next.example.test" },
        bindPassword: "Dummy-next-bind-only" }, DIRECTORY_SETTINGS_PATH + "/prepare", { headers });
      expect(prepared.status).toBe(200); expect(prepared.json.trust).toMatchObject({ server: "ldaps://next.example.test:636", leafFingerprint: "A".repeat(64) });
      const ref = prepared.json.ref, confirmation = prepared.json.trust.challenge;
      expect((await directoryBrowser(r.hub, signed.cookie, { ref }, DIRECTORY_SETTINGS_PATH + "/test", { headers })).status).toBe(409);
      const tested = await directoryBrowser(r.hub, signed.cookie, { ref, confirmation }, DIRECTORY_SETTINGS_PATH + "/test", { headers });
      expect(tested.status).toBe(outcome === "unknown" ? 503 : 200);
      if (outcome === "restored") r.refuseNextDirectory();
      if (outcome === "stale") commit = vi.spyOn(r.writer.directory!, "commit").mockImplementation(() => { throw new HubSettingsError("stale"); });
      const saved = await directoryBrowser(r.hub, signed.cookie, { ref, confirmation }, DIRECTORY_SETTINGS_PATH + "/save", { headers });
      expect(saved.status).toBe(outcome === "ready" ? 200 : outcome === "stale" ? 409 : 503); expect(personal).not.toHaveBeenCalled();
      expect(candidate).toHaveBeenCalledWith(expect.anything(), { bindPassword: "Dummy-next-bind-only" }, { expectedServerFingerprint: "A".repeat(64) });
      if (outcome === "unknown" || outcome === "stale") {
        expect(r.runtime.directoryDecision()!.inspect().directoryEpoch).toBe(0); expect(saved.cookie).toBe("");
        expect((await directoryBrowser(r.hub, signed.cookie)).json.signedIn).toBe(true);
        if (outcome === "stale") expect(saved.json).toEqual({ ok: false, code: "stale", committed: false });
      } else {
        expect(saved.json.state).toBe(outcome);
        expect((await directoryBrowser(r.hub, signed.cookie)).json.signedIn).toBe(false);
        const operation = r.withDecision(d => d.operation(saved.json.receiptId));
        expect(operation.recipients).toEqual([{ kind: "host", sink: "owner-needs-you" }, { kind: "person", person: ADMIN.key }]);
        expect(operation.changes).toEqual(["server", "secret"]);
        expect(operation.actor).toMatchObject({ kind: "hub-administrator", person: ADMIN.key });
        if (outcome === "ready") {
          expect((await directoryBrowser(r.hub, saved.cookie)).json.admin).toBe(true);
          const after = await directoryBrowser(r.hub, saved.cookie, undefined, DIRECTORY_SETTINGS_PATH);
          expect(after.json.reauthentication).toBe("required"); // Successor never inherits the old authentication proof.
        } else expect(saved.cookie).toBe("");
      }
      if (outcome !== "ready") expect(r.hub.config.hub.directory).toEqual(beforeDirectory);
      expect(r.runtime.serverHealth(r.hub.config.hub)).toBe("ready");
    } finally { commit?.mockRestore(); await control?.close(); await r.runtime.close(); }
  });
  it("requires renewed OLD-directory authentication after five minutes and no trust click for a same-host search change", async () => {
    let now = 1000, control: HubDirectorySettingsControl | undefined, r!: Awaited<ReturnType<typeof directoryRuntimeRig>>;
    const personal = vi.fn(async () => { throw Error("personal credentials reached candidate"); });
    const create = async () => control ??= createHubDirectorySettingsControl({ hubId: String(r.hub.config.hub.hubId),
      mounted: () => r.runtime.directorySettings(), writer: () => r.writer.directory!, current: () => true, now: () => now,
      createDirectory: () => ({ realm: "corp", signIn: personal, checkEligibility: async () => ({ eligible: true, person: ADMIN }), close: async () => {} }),
      probeTls: async () => "A".repeat(64), withDecision: work => r.runtime.withDirectoryDecision(String(r.hub.config.hub.hubId), work, () => true),
      remount: () => r.runtime.apply(r.hub.config) });
    r = await directoryRuntimeRig(undefined, { now: () => now, directorySettings: create });
    try {
      const signed = await noticeSignInForDirectory(r, ADMIN), headers = { "X-AgEnD-Hub-CSRF": signed.json.csrf };
      const old = r.runtime.directorySettings()!.source().directory, reauth = vi.spyOn(old, "signIn");
      now += 300_000;
      const view = await directoryBrowser(r.hub, signed.cookie, undefined, DIRECTORY_SETTINGS_PATH);
      expect(view.json.reauthentication).toBe("required");
      const { realm: _realm, profile: _profile, ...directory } = view.json.directory;
      const prepare = () => directoryBrowser(r.hub, signed.cookie, { directory: { ...directory, baseDn: "ou=people,dc=example,dc=test" } }, DIRECTORY_SETTINGS_PATH + "/prepare", { headers });
      const first = await prepare(); expect(first.json.trust).toBeNull();
      expect((await directoryBrowser(r.hub, signed.cookie, { ref: first.json.ref }, DIRECTORY_SETTINGS_PATH + "/save", { headers })).json.code).toBe("reauthentication");
      expect(r.runtime.directoryDecision()!.inspect().directoryEpoch).toBe(0);
      const second = await prepare();
      const saved = await directoryBrowser(r.hub, signed.cookie, { ref: second.json.ref, credentials: { login: ADMIN.login, password: "Dummy-browser-only" } }, DIRECTORY_SETTINGS_PATH + "/save", { headers });
      expect(saved.status).toBe(200); expect(saved.json.state).toBe("ready");
      expect(reauth).toHaveBeenCalledExactlyOnceWith(ADMIN.login, "Dummy-browser-only"); expect(personal).not.toHaveBeenCalled();
      expect(r.withDecision(d => d.operation(saved.json.receiptId).changes)).toEqual(["search"]);
    } finally { await control?.close(); await r.runtime.close(); }
  });
});

describe.skipIf(process.platform === "win32")("local directory settings while off or held", () => {
  const off = async (r: Awaited<ReturnType<typeof directoryRuntimeRig>>) => {
    r.hub.config.hub = { ...r.hub.config.hub, enabled: false };
    atomicWriteFileSync(join(r.hub.home, "fleet.yaml"), yaml.dump(r.hub.config), { mode: 0o600 });
    await r.runtime.apply(r.hub.config);
  };
  it("reuses one cold source without an AD sign-in or any listener", async () => {
    const r = await directoryRuntimeRig(), retired = r.runtime.directorySettings()!; await off(r);
    const before = { creates: r.creates, eligibility: r.eligibility };
    try {
      const [a, b] = await Promise.all([r.runtime.acquireDirectorySettings(), r.runtime.acquireDirectorySettings()]);
      expect(a).toBe(b); expect(r.creates).toBe(before.creates + 1); expect(r.eligibility).toBe(before.eligibility);
      expect(a.source().config.url).toBe((r.hub.config.hub.directory as { url: string }).url);
      expect(r.runtime.serverHealth(r.hub.config.hub)).toBe("off");
      expect(() => a.sessions()).toThrow(); expect(await r.runtime.acquireDirectorySettings()).toBe(a);
      // Model a stale generation reference; the cold lease owns the new source's SQL proof basis.
      const internal = r.runtime as unknown as { mountedDirectory: typeof retired | null };
      internal.mountedDirectory = retired;
      try { expect(r.runtime.directoryDecision() === a.decision).toBe(true); }
      finally { internal.mountedDirectory = null; }

    } finally { await r.runtime.close(); }
  });
  it("Save while off changes the sealed source and epoch through the existing writer without starting", async () => {
    const r = await directoryRuntimeRig(); await off(r); await r.runtime.acquireDirectorySettings();
    const control = createHubDirectorySettingsControl({ hubId: String(r.hub.config.hub.hubId), mounted: () => r.runtime.directorySettings(),
      writer: () => r.writer.directory!, current: () => true, probeTls: async () => "A".repeat(64),
      createDirectory: () => ({ realm: ADMIN.key.realm, checkEligibility: async () => ({ eligible: true, person: ADMIN }), close: async () => {} }) as any,
      withDecision: work => r.runtime.withDirectoryDecision(String(r.hub.config.hub.hubId), work, () => true),
      remount: async () => { await r.runtime.apply(r.hub.config); await r.runtime.acquireDirectorySettings(); } });
    try {
      const { realm: _realm, profile: _profile, bindPasswordRef: _ref, ...directory } = r.runtime.directorySettings()!.source().config;
      const draft = await control.prepare({ directory: { ...directory, baseDn: "ou=people,dc=example,dc=test" } }, { actor: r.actor, current: () => true });
      expect(draft.trust).toBeNull();
      const saved = await control.apply({ ref: draft.ref }, { actor: r.actor, current: () => true });
      expect(saved.state).toBe("ready"); expect(saved.directoryEpoch).toBe(1);
      expect(r.hub.config.hub.enabled).toBe(false); expect(r.runtime.serverHealth(r.hub.config.hub)).toBe("off");
      expect(r.runtime.directorySettings()!.source().config.baseDn).toBe("ou=people,dc=example,dc=test");
      expect(r.eligibility).toBe(0);
      r.hub.config.hub.enabled = true; await r.runtime.apply(r.hub.config);
      expect(r.runtime.serverHealth(r.hub.config.hub)).toBe("ready"); expect(r.runtime.directorySettings()!.source().epoch).toBe(1);
    } finally { await control.close(); await r.runtime.close(); }
  });
  it("drains the cold physical pool before creating a live replacement", async () => {
    const r = await directoryRuntimeRig(); await off(r); const source = await r.runtime.acquireDirectorySettings();
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const read = source.withDirectoryRead(ADMIN.key, async () => { await held; });
    let replaced = false; const creates = r.creates;
    r.hub.config.hub.enabled = true;
    const replacement = r.runtime.apply(r.hub.config).then(() => { replaced = true; });
    try {
      expect(source.current()).toBe(false);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(replaced).toBe(false); expect(r.creates).toBe(creates);
      release(); await read; await replacement;
      expect(r.creates).toBe(creates + 1); expect(r.runtime.serverHealth(r.hub.config.hub)).toBe("ready");
    } finally { release(); await read; await replacement; await r.runtime.close(); }
  });
  it("Stop retains a cold source until its last physical read settles", async () => {
    const r = await directoryRuntimeRig(); await off(r); const source = await r.runtime.acquireDirectorySettings();
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const read = source.withDirectoryRead(ADMIN.key, async () => { await held; });
    let stopped = false; const closing = r.runtime.close().then(() => { stopped = true; });
    try {
      // Drain the other close participant explicitly; only the cold source still owns physical work.
      await (r.runtime as unknown as { mount: { close(): Promise<void> } }).mount.close();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(stopped).toBe(false); expect(source.current()).toBe(false);
      release(); await read; await closing; expect(stopped).toBe(true);
    } finally { release(); await read; await closing; }
  });
  it("does not admit a configured member connection while reading local stopped settings", async () => {
    const r = await directoryRuntimeRig(); await r.runtime.close();
    const config = { ...r.hub.config, hub: { ...r.hub.config.hub, enabled: false }, hub_member: { enabled: true, fixture: "not yet applied" } };
    const createMember = vi.fn(async () => ({ start: async () => {}, fence: () => {}, close: async () => {} }));
    const runtime = new HubRuntime({ home: r.hub.home, log: () => {}, readConfig: () => config, createMember,
      components: { http: async () => r.entry }, createDirectory: () => ({ realm: ADMIN.key.realm, close: async () => {} }) as any });
    try { await runtime.acquireDirectorySettings(); expect(createMember).not.toHaveBeenCalled(); }
    finally { await runtime.close(); }
  });
  it("can inspect a sealed source when a listener port is held, without claiming the server is ready", async () => {
    const r = await directoryRuntimeRig(); await off(r);
    const blocker = createNetServer();
    const port = (r.hub.config.hub.webListen as { port: number }).port;
    await new Promise<void>((resolve, reject) => { blocker.once("error", reject); blocker.listen(port, "127.0.0.1", resolve); });
    let control: HubDirectorySettingsControl | undefined;
    try {
      r.hub.config.hub.enabled = true;
      await r.runtime.apply(r.hub.config);
      expect(r.runtime.serverHealth(r.hub.config.hub)).toBe("unavailable");
      const source = await r.runtime.acquireDirectorySettings();
      expect(source.current()).toBe(true); expect(source.source().epoch).toBe(0);
      expect(blocker.listening).toBe(true); expect(r.runtime.serverHealth(r.hub.config.hub)).toBe("unavailable");
      const before = structuredClone(r.hub.config.hub.directory);
      control = createHubDirectorySettingsControl({ hubId: String(r.hub.config.hub.hubId), mounted: () => r.runtime.directorySettings(),
        writer: () => r.writer.directory!, current: () => true, probeTls: async () => "A".repeat(64),
        createDirectory: () => ({ realm: ADMIN.key.realm, checkEligibility: async () => ({ eligible: true, person: ADMIN }), close: async () => {} }) as any,
        withDecision: work => r.runtime.withDirectoryDecision(String(r.hub.config.hub.hubId), work, () => true),
        // Simulate another authorized read publishing a headless source after the failed listener mount.
        remount: async () => { await r.runtime.apply(r.hub.config); await r.runtime.acquireDirectorySettings(); } });
      const { realm: _realm, profile: _profile, bindPasswordRef: _ref, ...directory } = source.source().config;
      const draft = await control.prepare({ directory: { ...directory, baseDn: "ou=people,dc=example,dc=test" } }, { actor: r.actor, current: () => true });
      const saved = await control.apply({ ref: draft.ref }, { actor: r.actor, current: () => true }).then(result => result, error => ({ code: error.code }));
      expect(saved).toEqual({ code: "unavailable" });
      expect(r.hub.config.hub.directory).toEqual(before); expect(r.runtime.directorySettings()!.source().epoch).toBe(2);
      expect(r.runtime.serverHealth(r.hub.config.hub)).toBe("unavailable");

    } finally { await control?.close(); await r.runtime.close(); await new Promise<void>(resolve => blocker.close(() => resolve())); }
  });
  it.each(["constructor", "microtask"])("Refresh in a %s waits for stale driver cleanup before any replacement", async when => {
    const r = await directoryRuntimeRig(); await r.runtime.close();
    const config = { ...r.hub.config, hub: { ...r.hub.config.hub, enabled: false } };
    let runtime!: HubRuntime, release!: () => void, reached!: () => void, refreshed: Promise<void> | undefined;
    const held = new Promise<void>(resolve => { release = resolve; }), closing = new Promise<void>(resolve => { reached = resolve; });
    let first = true;
    const createDirectory = vi.fn(() => {
      if (first) { first = false;
        if (when === "constructor") refreshed = runtime.refresh(); else queueMicrotask(() => { refreshed = runtime.refresh(); });
        return { realm: ADMIN.key.realm, close: async () => { reached(); await held; } } as any; }
      return { realm: ADMIN.key.realm, close: async () => {} } as any;
    });
    runtime = new HubRuntime({ home: r.hub.home, log: () => {}, readConfig: () => config, createDirectory, components: { http: async () => r.entry } });
    await runtime.apply(config);
    const pending = runtime.acquireDirectorySettings().catch(error => error);
    try {
      await Promise.race([closing, pending.then(() => undefined)]); let finished = false; const refresh = refreshed!.then(() => { finished = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(finished).toBe(false); expect(createDirectory).toHaveBeenCalledOnce(); expect(runtime.directorySettings()).toBeNull();
      release(); expect(await pending).toBeInstanceOf(Error); await refresh;
      expect((await runtime.acquireDirectorySettings()).current()).toBe(true); expect(createDirectory).toHaveBeenCalledTimes(2);
    } finally { release(); await pending; await refreshed; await runtime.close(); }
  });
  it.each(["replacement", "Run", "Stop"])("retains a failed constructor cleanup until its driver acknowledges %s", async mode => {
    const r = await directoryRuntimeRig(); await r.runtime.close();
    const config = { ...r.hub.config, hub: { ...r.hub.config.hub, enabled: false } };
    const secretPath = join(r.hub.home, "hub/secrets/directory-bind"), secret = readFileSync(secretPath);
    let release!: () => void, enter!: () => void, attempts = 0;
    const held = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { enter = resolve; });
    const close = vi.fn(async () => { if (++attempts === 1) throw Error("injected cleanup failure"); enter(); await held; });
    const createDirectory = vi.fn(() => {
      if (createDirectory.mock.calls.length === 1) { writeFileSync(secretPath, "changed during construction"); return { realm: ADMIN.key.realm, close } as any; }
      return { realm: ADMIN.key.realm, close: async () => {} } as any;
    });
    const runtime = new HubRuntime({ home: r.hub.home, log: () => {}, readConfig: () => config, createDirectory, components: { http: async () => r.entry } });
    await runtime.apply(config);
    // Observe only the cold connection, after the original live generation has physically closed.
    const probe = new Database(":memory:"), closeDb = vi.spyOn(Object.getPrototypeOf(probe), "close");
    let continuation: Promise<unknown> | undefined;
    try {
      await expect(runtime.acquireDirectorySettings()).rejects.toThrow();
      expect(createDirectory).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
      expect(closeDb).not.toHaveBeenCalled(); expect(runtime.directorySettings()).toBeNull();
      writeFileSync(secretPath, secret);
      if (mode === "Run") config.hub.enabled = true;
      continuation = mode === "Stop" ? runtime.close() : mode === "Run" ? runtime.apply(config) : runtime.acquireDirectorySettings();
      let completed = false; const result = continuation.then(value => { completed = true; return value; });
      await Promise.race([entered, result.then(() => undefined)]); await new Promise<void>(resolve => setImmediate(resolve));
      expect(completed).toBe(false); expect(createDirectory).toHaveBeenCalledOnce(); expect(closeDb).not.toHaveBeenCalled();
      release(); await result;
      expect(closeDb).toHaveBeenCalledOnce(); expect(createDirectory).toHaveBeenCalledTimes(mode === "Stop" ? 1 : 2);
    } finally { release(); writeFileSync(secretPath, secret); await continuation?.catch(() => {}); await runtime.close(); closeDb.mockRestore(); probe.close(); }
  });
  it.each(["unchanged", "ABA", "Refresh", "Stop"])("a held cold selection has the expected lifetime after %s", async mode => {
    const r = await directoryRuntimeRig(); await r.runtime.close();
    r.hub.config.hub.enabled = false;
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const createDirectory = vi.fn(() => ({ realm: ADMIN.key.realm }) as any);
    const runtime = new HubRuntime({ home: r.hub.home, log: () => {}, readConfig: () => r.hub.config, createDirectory,
      components: { http: async () => { entered(); await held; return r.entry; } } });
    await runtime.apply(r.hub.config);
    const pending = runtime.acquireDirectorySettings().catch(error => error);
    try {
      await started;
      if (mode === "ABA") {
        const original = structuredClone(r.hub.config.hub);
        r.hub.config.hub = { ...original, name: "Different off-state image" }; await runtime.apply(r.hub.config);
        r.hub.config.hub = original; await runtime.apply(r.hub.config);
      } else if (mode === "Refresh") await runtime.refresh();
      else if (mode === "Stop") runtime.fence();
      release(); const outcome = await pending;
      if (mode === "unchanged") { expect(outcome.current()).toBe(true); expect(createDirectory).toHaveBeenCalledOnce(); }
      else { expect(outcome).toBeInstanceOf(Error); expect(createDirectory).not.toHaveBeenCalled(); expect(runtime.directorySettings()).toBeNull(); }
    } finally { release(); await pending; await runtime.close(); }
  });
});

describe.skipIf(process.platform === "win32")("directory Save decision borrowing", () => {
  it.each(["unchanged", "ABA"])("%s cold import retains its original admission ticket", async mode => {
    const r = await directoryRuntimeRig(); await r.runtime.close();
    let release!: () => void, enter!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { enter = resolve; });
    const service = { start: async () => {}, fence: () => {}, close: async () => {} };
    const runtime = new HubRuntime({ home: r.hub.home, log: () => {}, readConfig: () => r.hub.config,
      components: { http: async () => { enter(); await wait; return r.entry; } }, createServer: async () => service });
    const work = vi.fn((d: HubDirectorySettingsDecision) => d.inspect().directoryEpoch);
    const borrowing = runtime.withDirectoryDecision(String(r.hub.config.hub.hubId), work, () => true).catch(error => error);
    try {
      await entered;
      if (mode === "ABA") {
        await runtime.apply(r.hub.config);
        await runtime.apply({ ...r.hub.config, hub: { ...r.hub.config.hub, enabled: false } });
        await runtime.apply(r.hub.config);
      }
      release(); const result = await borrowing;
      if (mode === "ABA") { expect(result).toBeInstanceOf(Error); expect(work).not.toHaveBeenCalled(); }
      else { expect(result).toBe(0); expect(work).toHaveBeenCalledOnce(); }
    } finally { release(); await borrowing; await runtime.close(); }
  });
  it("refuses another Hub and asynchronous callback escape on the mounted participant", async () => {
    const r = await directoryRuntimeRig(), work = vi.fn(() => 0);
    try {
      await expect(r.runtime.withDirectoryDecision(randomUUID(), work, () => true)).rejects.toThrow("owner changed");
      expect(work).not.toHaveBeenCalled();
      await expect(r.runtime.withDirectoryDecision(String(r.hub.config.hub.hubId), async d => d.inspect(), () => true)).rejects.toThrow("synchronous");
      expect(await r.runtime.withDirectoryDecision(String(r.hub.config.hub.hubId), d => d.inspect().directoryEpoch, () => true)).toBe(0);
      let retained: HubDirectorySettingsDecision | undefined;
      await r.runtime.withDirectoryDecision(String(r.hub.config.hub.hubId), d => { retained = d; return 0; }, () => true);
      expect(() => retained!.inspect()).toThrow("owner changed");
    } finally { await r.runtime.close(); }
  });
});
