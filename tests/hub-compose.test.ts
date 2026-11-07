/**
 * S-51 (S5b): the runtime and the server factory over a REALLY initialized Hub (S5a init + S1 keys + sealed manifest in
 * a scratch home), with a fake S3 entry. Local listeners on 127.0.0.1 only; no directory is contacted (S2's client is
 * built but never signs in), nothing outside the scratch home is touched.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "node:https";
import { connect } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verify, createPublicKey, randomUUID } from "node:crypto";
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

const roots: string[] = [];
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

function fakeHttp() {
  const state: { deps: HubHttpDeps | null; closed: number } = { deps: null, closed: 0 };
  const entry: HubHttpEntry = {
    migrations: [{ component: "s3-http", version: 1, up: (db) => db.exec("CREATE TABLE IF NOT EXISTS s3_rooms(id TEXT PRIMARY KEY)") }],
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

function factory(home: string, http?: HubHttpEntry, extra: Pick<import("../src/hub/compose/server.js").HubServerFactoryOptions, "retentionReady" | "retentionEveryMs" | "browserCertificateReady"> = {}) {
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
    expect((db.prepare("SELECT component, version FROM hub_schema ORDER BY component").all() as { component: string }[]).map((r) => r.component)).toEqual(["s1-transport", "s3-http", "s5-audit", "s5-browser-tls", "s5-instance", "s5-retention", "s7-attachments"]);
    expect((db.prepare("SELECT hub_id FROM hub_instance").get() as { hub_id: string }).hub_id).toBe(hub.config.hub.hubId);
    db.close();

    // S3's deps: the sealed config (frozen), exact bind secret, live transport, issuer that really signs.
    const deps = http.state.deps!;
    expect(deps.config).toEqual({ hubId: hub.config.hub.hubId, name: "Compose Hub", webOrigin: hub.plan.webOrigin, administrator: ADMIN.key });
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
