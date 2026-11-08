/**
 * S-51 (S5b): the runtime and the server factory over a REALLY initialized Hub (S5a init + S1 keys + sealed manifest in
 * a scratch home), with a fake S3 entry. Local listeners on 127.0.0.1 only; no directory is contacted (S2's client is
 * built but never signs in), nothing outside the scratch home is touched.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { request } from "node:https";
import { connect } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verify, createPublicKey, randomUUID, createHash } from "node:crypto";
import yaml from "js-yaml";
import Database from "better-sqlite3";
import { createHubInitializer } from "../src/hub/init/initializer.js";
import { hubIdentityProvider } from "../src/hub/init/identity.js";
import { HubRuntime, effectiveHubView, hubSwitchesOn, type HubHold } from "../src/hub/runtime.js";
import { createHubServerFactory, type HubHttpDeps, type HubHttpEntry } from "../src/hub/compose/server.js";
import { HubServer } from "../src/hub/server.js";
import type { HubMountedService } from "../src/hub/mount.js";
import { ADMIN, makeTestCerts } from "./support/hub-init-fixtures.js";
import { freeHubPort } from "./helpers/hub-rig.js";
import { readHubSecretFile } from "../src/hub/init/secret-file.js";
import { readPrivateFile } from "../src/hub/private-files.js";
import { HUB_SESSION_EPOCH_MIGRATION } from "../src/hub/session-epoch.js";
import { sealHubInitialization } from "../src/hub/initialization.js";
import { hubPlanDigest } from "../src/hub/init/plan-digest.js";
import { createHubSettingsWriter, type HubSettingsWriterDeps } from "../src/hub/settings-commit.js";
import { atomicWriteFileSync } from "../src/atomic-write.js";
import { hubSetCookie } from "../src/hub/sessions.js";
import { SERVER_SET } from "../src/hub/compose/storage.js";
import { createHubDirectorySettingsProof } from "../src/hub/settings-directory-proof.js";

const roots: string[] = [];
beforeAll(() => mkdirSync(".artifacts", { recursive: true }));
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});

const BIND = "Bind-" + "z".repeat(20);

async function initializedHub(bindPassword = BIND) {
  mkdirSync(".artifacts", { recursive: true });
  const home = mkdtempSync(join(process.cwd(), ".artifacts/hub-compose-"));
  chmodSync(home, 0o700);
  roots.push(home);
  const certs = makeTestCerts();
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

function refused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1");
    s.once("connect", () => { s.destroy(); resolve(false); });
    s.once("error", () => resolve(true));
  });
}

function factory(home: string, http?: HubHttpEntry, extra: Partial<Pick<import("../src/hub/compose/server.js").HubServerFactoryOptions, "retentionReady" | "retentionEveryMs" | "browserCertificateReady" | "createDirectory">> = {}) {
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
    expect((db.prepare("SELECT component, version FROM hub_schema ORDER BY component").all() as { component: string }[]).map((r) => r.component)).toEqual(["company-join", "s1-transport", "s3-http", "s3-session-epoch", "s5-audit", "s5-browser-tls", "s5-directory-settings", "s5-group-policy", "s5-group-resources", "s5-instance", "s5-retention", "s5-web-initialization-audit", "s7-attachments", "s90-pairing-notices"]);
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
async function directoryRuntimeRig() {
  const hub = await initializedHub(), real = await import("../src/hub/runtime.js").then(m => m.S3B_HTTP_ENTRY());
  let runtime: HubRuntime, writer: ReturnType<typeof createHubSettingsWriter>, crash: string | undefined, lastDeps: HubHttpDeps | undefined;
  let creates = 0, eligibility = 0, signInGate: (() => Promise<void>) | undefined;
  const entry: HubHttpEntry = { ...real, createHubHttp(deps) { lastDeps = deps; return real.createHubHttp(deps); } };
  const build = (http: () => Promise<HubHttpEntry> = async () => entry) => {
    hub.config = yaml.load(readFileSync(join(hub.home, "fleet.yaml"), "utf8")) as typeof hub.config;
    writer = createHubSettingsWriter({ home: hub.home, readHub: () => hub.config.hub,
      directoryDecision: () => runtime?.directoryDecision() ?? null,
      saveHub(patches) {
        const next = structuredClone(hub.config.hub);
        for (const patch of patches) { if (patch.remove) delete next[patch.path[1]!]; else next[patch.path[1]!] = patch.value; }
        hub.config.hub = next;
        atomicWriteFileSync(join(hub.home, "fleet.yaml"), yaml.dump(hub.config), { mode: 0o600 });
      },
      step(point) { if (point === crash) { crash = undefined; throw Error(`stop:${point}`); } },
    });
    runtime = new HubRuntime({ home: hub.home, log: () => {}, components: { http }, settingsWriter: writer,
      createDirectory: () => { creates++; return { realm: "corp", signIn: async (login, password) => {
          await signInGate?.();
          return login === ADMIN.login && password === "Dummy-browser-only" ? { ok: true, person: ADMIN } : { ok: false, reason: "invalid-credentials" };
        },
        checkEligibility: async () => { eligibility++; return { eligible: true, person: ADMIN }; }, close: async () => {} }; } });
    return runtime;
  };
  build();
  try { await runtime!.apply(hub.config); expect(runtime!.serverHealth(hub.config.hub)).toBe("ready"); }
  catch (err) { await runtime!.close(); throw err; }
  const candidate = () => ({ directory: { ...(hub.config.hub.directory as import("../src/hub/directory/config.js").HubDirectoryConfig), url: "ldaps://next.example.test" },
    bindPassword: "Dummy-next-bind-only", changes: ["server", "secret"] as const,
    recipients: [{ kind: "host" as const, sink: "owner-needs-you" }, { kind: "person" as const, person: ADMIN.key }] });
  const actor = { kind: "host-owner" as const, sessionId: "owned-host-session", requestId: randomUUID() };
  const commit = (point?: string) => {
    const mounted = runtime!.directorySettings()!, draft = writer!.directory!.prepare({ ...candidate(), changes: [...candidate().changes] }, actor, mounted.current);
    crash = point; return writer!.directory!.commit(draft.ref, actor, mounted.current);
  };
  return { hub, get runtime() { return runtime!; }, get writer() { return writer!; }, get deps() { return lastDeps!; },
    get creates() { return creates; }, get eligibility() { return eligibility; }, holdSignIn(gate?: () => Promise<void>) { signInGate = gate; }, entry, build, commit, candidate, actor };
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
function directoryBrowser(hub: Awaited<ReturnType<typeof initializedHub>>, cookie?: string, body?: unknown) {
  return new Promise<{ status: number; json: any; cookie: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: hub.webPort, path: "/hub/v1/session", servername: "hub.example.test", ca: hub.caPem,
      agent: false, method: body === undefined ? "GET" : "POST", headers: { Origin: String(hub.config.hub.webOrigin),
        ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) } }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", data => { text += data; });
      res.on("end", () => { try { resolve({ status: res.statusCode!, json: JSON.parse(text), cookie: res.headers["set-cookie"]?.[0]?.split(";")[0] ?? "" }); } catch (error) { reject(error); } });
    });
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

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
