/** Sealed initializer → actual S5 factory → verified HTTPS and real S3/control/SQLite. Directory people/facts are inert. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "node:https";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import yaml from "js-yaml";
import { createHubInitializer } from "../src/hub/init/initializer.js";
import { hubIdentityProvider } from "../src/hub/init/identity.js";
import { hubTxDatabase } from "../src/hub/db.js";
import { createHubServerFactory, type HubHttpDeps } from "../src/hub/compose/server.js";
import * as entry from "../src/hub/http/compose.js";
import { freeHubPort } from "./helpers/hub-rig.js";
import { ADMIN, makeTestCerts } from "./support/hub-init-fixtures.js";
import type { DirectoryPerson, HubDirectory } from "../src/hub/directory/types.js";
import type { PolicyGroupFacts } from "../src/hub/directory/groups.js";
import type { HubGroupPolicy } from "../src/hub/group-policy/model.js";
import type { HubLinkContext } from "../src/hub/server.js";
import { HubServer } from "../src/hub/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function rig(supported = true) {
  const home = mkdtempSync(join(tmpdir(), "agend-group-composition-")), certs = makeTestCerts(); chmodSync(home, 0o700);
  let service: Awaited<ReturnType<ReturnType<typeof createHubServerFactory>>> | undefined, db: Database.Database | undefined;
  cleanups.push(async () => { db?.close(); await service?.close(); rmSync(home, { recursive: true, force: true }); rmSync(certs.dir, { recursive: true, force: true }); });
  const memberPort = await freeHubPort(); let webPort = await freeHubPort();
  while (webPort === memberPort) webPort = await freeHubPort();
  const origin = `https://hub.example.test:${webPort}`, group = randomUUID(), outsider = randomUUID();
  const colleague: DirectoryPerson = { key: { realm: "corp", objectId: randomUUID() }, login: "morgan", displayName: "Morgan Example", dn: "CN=Morgan,DC=example,DC=test", groups: [] };
  const people = [ADMIN, colleague]; let known = true, adminEligible = true, live = true;
  const read = vi.fn(async (person: DirectoryPerson["key"]): Promise<PolicyGroupFacts> => known
    ? { kind: "complete", person, groups: [person.objectId === ADMIN.key.objectId ? group : outsider], observedAt: Date.now() } : { kind: "unknown" });
  const directory: HubDirectory = { realm: "corp", ...(supported ? { groupPolicy: "ad-direct-guid" as const, readPolicyGroups: read,
    resolvePolicyGroup: async dn => ({ ok: true as const, group: { key: { realm: "corp", objectId: group }, dn } }) } : {}),
    async signIn(login, password) { const person = people.find(p => p.login === login); return person && password === `test-${login}`
      ? { ok: true, person } : { ok: false, reason: "invalid-credentials" }; },
    async checkEligibility(key) { const person = people.find(p => p.key.objectId === key.objectId && p.key.realm === key.realm);
      return person && (person !== ADMIN || adminEligible) ? { eligible: true, person } : { eligible: false, reason: "disabled" }; }, close: async () => {} };
  const plan = { name: "Example groups Hub", webOrigin: origin, memberOrigin: `https://hub.example.test:${memberPort}`,
    webListen: { host: "127.0.0.1", port: webPort }, memberListen: { host: "127.0.0.1", port: memberPort },
    webTls: { certFile: certs.cert, keyFile: certs.key }, directory: { realm: "corp", url: "ldaps://directory.example.test:636",
      profile: "ad" as const, baseDn: "DC=example,DC=test", bindDn: "CN=Reader,DC=example,DC=test" },
    bindPasswordRef: "file:hub/secrets/directory-bind", administrator: ADMIN.key, retention: { contentDays: 7, eventDays: 30 }, coexistence: "dedicated" as const };
  const initializer = createHubInitializer({ home, identity: hubIdentityProvider(), probe: { pidAlive: () => false } });
  const confirmation = await initializer.prepareConfirmation(plan, { bindPassword: "test-bind-not-an-account" }); await initializer.commit(plan, confirmation.reference);
  const cfg = (yaml.load(readFileSync(join(home, "fleet.yaml"), "utf8")) as { hub: Record<string, unknown> }).hub;
  let deps!: HubHttpDeps, http!: ReturnType<typeof entry.createHubHttp>; const marks = vi.fn(() => vi.fn());
  const create = createHubServerFactory({ home, components: { http: async () => ({ migrations: entry.migrations, createHubHttp(value) {
    deps = value; http = entry.createHubHttp(value, hubTxDatabase); return http;
  } }) }, createDirectory: () => directory, report: () => {}, log: () => {}, groupPermissionsReady: marks });
  service = await create(cfg, () => live); await service.start(); db = new Database(join(home, "hub/hub.sqlite"));
  type Browser = { cookie: string; csrf: string };
  const call = (browser: Browser | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; cookie: string }> => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: webPort, path, servername: "hub.example.test", ca: readFileSync(certs.caCert), method, agent: false,
      headers: { Origin: origin, ...(browser ? { Cookie: browser.cookie, "X-AgEnD-Hub-CSRF": browser.csrf } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers } }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", value => { text += value; }); res.on("end", () => {
        let json: unknown; try { json = JSON.parse(text); } catch { json = text; }
        resolve({ status: res.statusCode!, json, cookie: (res.headers["set-cookie"]?.[0] ?? "").split(";")[0]! });
      });
    }); req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const signIn = async (login = ADMIN.login) => { const answer = await call(null, "POST", "/hub/v1/session", { login, password: `test-${login}` });
    expect(answer.status).toBe(200); return { cookie: answer.cookie, csrf: answer.json.csrf as string, view: answer.json }; };
  const admin = await signIn(), path = "/hub/v1/admin/group-policy";
  const readPolicy = async () => (await call(admin, "GET", path)).json.policy as HubGroupPolicy;
  const proposal = async (): Promise<HubGroupPolicy> => ({ ...await readPolicy(), state: "enabled", groups: [{ group: { realm: "corp", objectId: group },
    dn: "CN=Hub Members,DC=example,DC=test", allow: ["ask_agents", "publish_agents", "pair_fleet"], maxFleets: 2 }] });
  const save = async (policy: HubGroupPolicy) => { const preview = await call(admin, "POST", `${path}/preview`, { policy }); expect(preview.status).toBe(200);
    const applied = await call(admin, "PUT", path, { policy, previewDigest: preview.json.previewDigest }); expect(applied.status).toBe(200); return preview.json; };
  const auditCount = () => (db!.prepare("SELECT COUNT(*) n FROM hub_audit").get() as { n: number }).n;
  return { home, cfg, db, directory, read, group, outsider, colleague, deps, http, service, marks, admin, path, call, signIn, readPolicy, proposal, save, auditCount,
    unknown: () => { known = false; }, known: () => { known = true; }, disableAdmin: () => { adminEligible = false; }, fence: () => { live = false; } };
}

async function manualAttempt(r: Awaited<ReturnType<typeof rig>>) {
  const browser = await r.signIn(r.colleague.login);
  const offer = await r.call(r.admin, "POST", "/hub/v1/admin/pairings", { login: r.colleague.login }); expect(offer.status).toBe(200);
  const pending = r.deps.pairing.pair({ code: offer.json.code });
  expect((await r.call(browser, "POST", `/hub/v1/pairings/${pending.pairingId}/confirm`, { fingerprint: pending.fingerprint })).status).toBe(200);
  return { browser, pending, resource: { kind: "fleet" as const, id: pending.fleetId, revision: 1, owner: r.colleague.key },
    approve: () => r.call(r.admin, "POST", `/hub/v1/admin/pairings/${pending.pairingId}/approve`, { fingerprint: pending.fingerprint }),
    claim: () => r.deps.pairing.claim({ pairingId: pending.pairingId, fleetId: pending.fleetId, claimSecret: pending.claimSecret }) };
}

describe("the complete group control on the actual Hub HTTPS factory", () => {
  it("starts off, exposes only the configured admin's editor, and keeps eligible no-action sign-in open", async () => {
    const refreshed = vi.spyOn(HubServer.prototype, "refreshAuthorization");
    const r = await rig(), other = await r.signIn(r.colleague.login);
    expect(r.admin.view.features).toContain("group-policy-v1"); expect(r.marks).toHaveBeenCalledOnce();
    expect((await r.readPolicy()).state).toBe("never-enabled"); expect(r.read).not.toHaveBeenCalled();
    expect((await r.call(other, "GET", r.path)).status).toBe(403); expect((await r.call(null, "GET", r.path)).status).toBe(401);
    expect((await r.call(r.admin, "GET", "/hub/v1/me/welcome")).json.mode).toBe("legacy");
    const resolve = await r.call(r.admin, "POST", `${r.path}/resolve`, { dn: "CN=Hub Members,DC=example,DC=test" });
    expect(resolve.json).toMatchObject({ ok: true, objectId: r.group });
    await r.save(await r.proposal());
    expect(refreshed).toHaveBeenCalledOnce();
    const before = r.auditCount(), welcome = await r.call(other, "GET", "/hub/v1/me/welcome");
    expect(welcome.json).toMatchObject({ mode: "enabled", chat: { state: "deny" }, publish: { state: "deny" }, connect: { state: "deny" } });
    expect(JSON.stringify(welcome.json)).not.toContain(r.group); expect(r.auditCount()).toBe(before);
    expect((await r.call(other, "GET", "/hub/v1/session")).json.signedIn).toBe(true);
  });
  it("refuses missing CSRF, foreign origin and another session's sealed preview", async () => {
    const r = await rig(), policy = await r.proposal();
    expect((await r.call(r.admin, "POST", `${r.path}/preview`, { policy }, { "X-AgEnD-Hub-CSRF": "wrong" })).status).toBe(403);
    expect((await r.call(r.admin, "POST", `${r.path}/preview`, { policy }, { Origin: "https://other.example.test" })).status).toBe(403);
    const preview = await r.call(r.admin, "POST", `${r.path}/preview`, { policy }), second = await r.signIn();
    expect((await r.call(second, "PUT", r.path, { policy, previewDigest: preview.json.previewDigest })).status).toBe(409);
    expect((await r.readPolicy()).state).toBe("never-enabled");
  });
  it("commits stable HELD impact, but refuses changed facts and a signed-out held request", async () => {
    const r = await rig(), policy = await r.proposal(); r.unknown();
    const preview = await r.call(r.admin, "POST", `${r.path}/preview`, { policy }); expect(preview.json.impact.held).toHaveLength(1);
    r.known(); expect((await r.call(r.admin, "PUT", r.path, { policy, previewDigest: preview.json.previewDigest })).status).toBe(409);
    r.unknown(); const held = await r.save(policy); expect(held.impact.held).toHaveLength(1);
    expect(r.db!.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]);
    const next = { ...await r.readPolicy(), groups: [] }, entered = gate<DirectoryPerson["key"]>(), release = gate<PolicyGroupFacts>();
    r.read.mockImplementationOnce(person => { entered.resolve(person); return release.promise; });
    const pending = r.call(r.admin, "POST", `${r.path}/preview`, { policy: next }); await entered.promise;
    expect((await r.call(r.admin, "DELETE", "/hub/v1/session")).status).toBe(200); release.resolve({ kind: "unknown" });
    expect((await pending).status).not.toBe(200); expect(r.deps.store.read().revocationVersion).toBe(1);
  });
  it("uses the actual pairing and publication gates after HTTP enable, and resumes only the exact paused revision", async () => {
    const r = await rig(), ctx = { requestId: randomUUID(), current: vi.fn(), requirePerson: async () => ADMIN.key,
      requireAdmin: async () => ({ kind: "directory" as const, person: ADMIN.key, sessionId: "test-local-authority" }) };
    const offer = await r.deps.pairing.create(ctx, ADMIN.key), pending = r.deps.pairing.pair({ code: offer.code });
    await r.deps.pairing.confirmOwner(ctx, pending.pairingId, pending.fingerprint); await r.deps.pairing.approve(ctx, pending.pairingId, pending.fingerprint);
    await r.deps.pairing.claim({ pairingId: pending.pairingId, fleetId: pending.fleetId, claimSecret: pending.claimSecret });
    const preview = await r.save(await r.proposal()); expect(preview.impact.grandfathered).toHaveLength(1);
    expect(r.db!.prepare("SELECT source,state FROM hub_group_resources").all()).toEqual([{ source: "manual", state: "active" }]);
    const exposure = { id: randomUUID(), fleetId: pending.fleetId, owner: ADMIN.key, displayName: "Example helper", revision: 1,
      state: "published" as const, dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) };
    const link: HubLinkContext = { fleetId: pending.fleetId, owner: ADMIN.key, linkEpoch: 1, features: new Set(), current: () => true };
    await r.http.receive({ v: 1, type: "exposure.snapshot", requestId: randomUUID(), linkEpoch: 1, payload: { revision: 1, exposures: [exposure] } }, link);
    expect(r.deps.groups!.resourceState({ kind: "exposure", id: exposure.id, revision: 1, owner: ADMIN.key })).toMatchObject({ source: "group", state: "active" });
    const denied = { ...await r.readPolicy(), denies: [{ person: ADMIN.key, deny: ["publish_agents" as const] }] }; await r.save(denied);
    let view = (await r.call(r.admin, "GET", r.path)).json; expect(view.paused).toHaveLength(1);
    const row = view.paused[0]; expect(row.resource.id).toBe(exposure.id);
    await r.save({ ...await r.readPolicy(), denies: [] }); view = (await r.call(r.admin, "GET", r.path)).json; expect(view.paused).toHaveLength(1);
    const resume = { resource: row.resource, expectedPolicyRevision: view.policy.revision, expectedLifecycleRevision: row.lifecycleRevision };
    expect((await r.call(r.admin, "POST", `${r.path}/resources/resume`, { ...resume, expectedLifecycleRevision: 1 })).status).toBe(409);
    expect((await r.call(r.admin, "POST", `${r.path}/resources/resume`, resume)).json).toMatchObject({ ok: true, state: "active" });
    expect((await r.call(r.admin, "GET", r.path)).json.paused).toEqual([]);
    await r.save({ ...await r.readPolicy(), denies: [{ person: ADMIN.key, deny: ["pair_fleet"] }] });
    expect((await r.call(r.admin, "GET", "/hub/v1/me/welcome")).json.connect.fleets).toEqual([{ id: pending.fleetId, label: null, status: "suspended" }]);
  });
  it.each(["none", "unknown"])("preserves explicit admin-approved manual pairing with %s self-service membership", async mode => {
    const r = await rig(); await r.save(await r.proposal());
    const browser = await r.signIn(r.colleague.login), owner = r.colleague.key;
    r.read.mockClear(); if (mode === "unknown") r.unknown();
    const offer = await r.call(r.admin, "POST", "/hub/v1/admin/pairings", { login: r.colleague.login });
    expect(offer.status).toBe(200);
    const pending = r.deps.pairing.pair({ code: offer.json.code });
    expect((await r.call(browser, "POST", `/hub/v1/pairings/${pending.pairingId}/confirm`, { fingerprint: pending.fingerprint })).status).toBe(200);
    expect((await r.call(r.admin, "POST", `/hub/v1/admin/pairings/${pending.pairingId}/approve`, { fingerprint: pending.fingerprint })).status).toBe(200);
    const claiming = r.deps.pairing.claim({ pairingId: pending.pairingId, fleetId: pending.fleetId, claimSecret: pending.claimSecret });
    await expect(claiming).resolves.toMatchObject({ status: "approved" }); const result = await claiming;
    expect(result.status).toBe("approved");
    if (result.status !== "approved") throw Error("manual pairing did not issue a credential");
    expect(r.deps.pairing.authenticate(result.credential)).toMatchObject({ fleetId: pending.fleetId, owner });
    expect(r.read).not.toHaveBeenCalled();
    expect(r.deps.groups!.resourceState({ kind: "fleet", id: pending.fleetId, revision: 1, owner })).toMatchObject({ source: "manual", state: "active" });
    expect((await r.call(browser, "GET", "/hub/v1/me/welcome")).json).toMatchObject({
      chat: { state: mode === "unknown" ? "unknown" : "deny" }, publish: { state: mode === "unknown" ? "unknown" : "deny" }, connect: { state: mode === "unknown" ? "unknown" : "deny" } });
  });
  it("allows explicit manual approval above the automatic fleet limit without granting self-service", async () => {
    const r = await rig(); await r.save(await r.proposal());
    const claim = async (owner: DirectoryPerson["key"]) => {
      const ctx = { requestId: randomUUID(), current: async () => ({ kind: "directory" as const, person: owner, sessionId: "test-owner-authority" }), requirePerson: async () => owner,
        requireAdmin: async () => ({ kind: "directory" as const, person: ADMIN.key, sessionId: "test-local-authority" }) };
      const offer = await r.deps.pairing.create(ctx, owner), pending = r.deps.pairing.pair({ code: offer.code });
      await r.deps.pairing.confirmOwner(ctx, pending.pairingId, pending.fingerprint);
      await r.deps.pairing.approve(ctx, pending.pairingId, pending.fingerprint);
      return r.deps.pairing.claim({ pairingId: pending.pairingId, fleetId: pending.fleetId, claimSecret: pending.claimSecret });
    };
    await expect(claim(r.colleague.key)).resolves.toMatchObject({ status: "approved" });
    await expect(claim(ADMIN.key)).resolves.toMatchObject({ status: "approved" });
    await expect(claim(ADMIN.key)).resolves.toMatchObject({ status: "approved" });
    await expect(claim(ADMIN.key)).resolves.toMatchObject({ status: "approved" });
    expect(r.deps.store.read().fleets).toHaveLength(4);
    expect(r.db!.prepare("SELECT source,state FROM hub_group_resources").all()).toEqual([
      { source: "manual", state: "active" }, { source: "manual", state: "active" },
      { source: "manual", state: "active" }, { source: "manual", state: "active" }]);
  });
  it("blocks an explicit person deny on manual approval and suspends an existing exact manual fleet only after that deny", async () => {
    const r = await rig(); await r.save(await r.proposal()); const attempt = await manualAttempt(r);
    await r.save({ ...await r.readPolicy(), denies: [{ person: r.colleague.key, deny: ["pair_fleet"] }] });
    expect((await attempt.approve()).status).toBe(403); expect(r.deps.store.read().fleets).toEqual([]);
    await r.save({ ...await r.readPolicy(), denies: [] }); expect((await attempt.approve()).status).toBe(200); await attempt.claim();
    r.unknown(); await r.deps.groups!.check(attempt.resource, { requestId: randomUUID(), current: () => true });
    expect(r.deps.groups!.resourceState(attempt.resource)).toMatchObject({ source: "manual", state: "active" });
    r.known(); await r.save({ ...await r.readPolicy(), groups: [] });
    expect(r.deps.groups!.resourceState(attempt.resource)).toMatchObject({ state: "active" });
    await r.save({ ...await r.readPolicy(), denies: [{ person: r.colleague.key, deny: ["pair_fleet"] }] });
    expect(r.deps.groups!.resourceState(attempt.resource)).toMatchObject({ state: "suspended" });
  });
  it.each(["disabled", "gone", "unavailable"] as const)("never lets manual approval or claim override %s owner eligibility", async reason => {
    const r = await rig(); await r.save(await r.proposal()); const attempt = await manualAttempt(r);
    const original = r.directory.checkEligibility.bind(r.directory);
    const refuse = async (key: DirectoryPerson["key"]) => key.objectId === r.colleague.key.objectId
      ? { eligible: false as const, reason } : original(key);
    r.directory.checkEligibility = refuse;
    expect((await attempt.approve()).status).toBe(reason === "unavailable" ? 503 : 403);
    expect(r.deps.store.read().pairings[0]!.adminApproved).toBe(false);
    r.directory.checkEligibility = original; expect((await attempt.approve()).status).toBe(200);
    r.directory.checkEligibility = refuse; await expect(attempt.claim()).rejects.toThrow();
    expect(r.deps.store.read().fleets).toEqual([]); expect(r.db!.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]);
  });
  it("holds directory outages without mutation and suspends an existing manual fleet after authoritative ineligibility", async () => {
    const r = await rig(); await r.save(await r.proposal()); const attempt = await manualAttempt(r);
    expect((await attempt.approve()).status).toBe(200); await attempt.claim();
    const original = r.directory.checkEligibility.bind(r.directory);
    r.directory.checkEligibility = key => key.objectId === r.colleague.key.objectId
      ? Promise.resolve({ eligible: true, person: { ...r.colleague, key: ADMIN.key } }) : original(key);
    await expect(r.deps.groups!.check(attempt.resource, { requestId: randomUUID(), current: () => true })).rejects.toThrow();
    expect(r.deps.groups!.resourceState(attempt.resource)).toMatchObject({ state: "active" });
    let reason: "unavailable" | "disabled" = "unavailable";
    r.directory.checkEligibility = key => key.objectId === r.colleague.key.objectId
      ? Promise.resolve({ eligible: false as const, reason }) : original(key);
    await expect(r.deps.groups!.check(attempt.resource, { requestId: randomUUID(), current: () => true })).rejects.toThrow();
    expect(r.deps.groups!.resourceState(attempt.resource)).toMatchObject({ state: "active" });
    reason = "disabled";
    await expect(r.deps.groups!.check(attempt.resource, { requestId: randomUUID(), current: () => true })).rejects.toThrow();
    expect(r.deps.groups!.resourceState(attempt.resource)).toMatchObject({ state: "suspended" });
  });
  it.each(["resolve", "reject"])("shares four physical manual eligibility slots across factory checks until %s settlement", async mode => {
    const r = await rig(); await r.save(await r.proposal()); const attempt = await manualAttempt(r);
    expect((await attempt.approve()).status).toBe(200); await attempt.claim();
    const original = r.directory.checkEligibility.bind(r.directory), release = gate<boolean>(); let entered = 0, live = true;
    r.directory.checkEligibility = async key => { entered++; await release.promise;
      if (mode === "reject") throw Error("inert directory failure"); return original(key); };
    r.read.mockClear();
    const before = r.auditCount(), check = (current = () => true) => r.deps.groups!.check(attempt.resource,
      { requestId: randomUUID(), current }).then(value => value.source, error => error);
    const work = Array.from({ length: 4 }, (_, i) => check(i === 0 ? () => live : () => true));
    live = false; // Logical cancellation must not release a physical directory slot.
    let extraResult: unknown; const extra = check().then(result => { extraResult = result; });
    const welcome = r.deps.groupHttp!.welcome({ requestId: randomUUID(), current: () => true,
      requirePerson: async () => r.colleague.key }).catch(error => error);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(entered).toBe(4); expect(extraResult).toMatchObject({ reason: "held" });
      expect(await welcome).toBeInstanceOf(Error); expect(r.read).not.toHaveBeenCalled();
      expect(r.deps.groups!.resourceState(attempt.resource)).toMatchObject({ source: "manual", state: "active", revision: 1 });
      expect(r.auditCount()).toBe(before);
    } finally { release.resolve(true); await Promise.all([...work, extra, welcome]); }
    const results = await Promise.all(work); expect(results[0]).toBeInstanceOf(Error);
    expect(results.slice(1)).toEqual(mode === "resolve" ? ["manual", "manual", "manual"] :
      Array.from({ length: 3 }, () => expect.objectContaining({ reason: "held" })));
    r.directory.checkEligibility = original;
    await expect(r.deps.groups!.check(attempt.resource, { requestId: randomUUID(), current: () => true })).resolves.toMatchObject({ source: "manual" });
    expect(r.deps.groups!.resourceState(attempt.resource)).toMatchObject({ state: "active", revision: 1 });
  });
  it("cannot finish a held manual approval after the administrator signs out", async () => {
    const r = await rig(); await r.save(await r.proposal()); const attempt = await manualAttempt(r);
    const original = r.directory.checkEligibility.bind(r.directory), entered = gate<boolean>(), release = gate<boolean>();
    r.directory.checkEligibility = async key => { if (key.objectId === r.colleague.key.objectId) { entered.resolve(true); await release.promise; } return original(key); };
    const approving = attempt.approve(); await entered.promise;
    expect((await r.call(r.admin, "DELETE", "/hub/v1/session")).status).toBe(200); release.resolve(true);
    expect((await approving).status).toBe(401); expect(r.deps.store.read().pairings[0]!.adminApproved).toBe(false);
    expect(r.deps.store.read().fleets).toEqual([]);
  });
  it("requires the exact persisted approver, not a boolean or a different directory person", async () => {
    const r = await rig(); await r.save(await r.proposal()); const attempt = await manualAttempt(r); expect((await attempt.approve()).status).toBe(200);
    const change = (approvedBy?: DirectoryPerson["key"]) => r.deps.store.mutate({ at: Date.now(), requestId: randomUUID(), actor: { kind: "local-host" }, action: "fixture.approver", result: "completed" }, state => {
      const row = state.pairings[0]!; if (approvedBy) row.approvedBy = approvedBy; else delete row.approvedBy;
    });
    change(r.colleague.key); await expect(attempt.claim()).rejects.toThrow(); expect(r.deps.store.read().fleets).toEqual([]);
    change(); await expect(attempt.claim()).resolves.toEqual({ status: "pending" }); expect(r.deps.store.read().fleets).toEqual([]);
    expect((await attempt.approve()).status).toBe(200); await expect(attempt.claim()).resolves.toMatchObject({ status: "approved" });
  });
  it("shows legacy only for intact never-enabled repair; enabled repair stays unavailable while sign-in and admin repair remain open", async () => {
    const r = await rig(), original = await r.readPolicy();
    const replace = (policy: HubGroupPolicy) => r.db!.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(policy));
    replace({ ...original, generation: "older-generation" });
    expect((await r.call(r.admin, "GET", "/hub/v1/me/welcome")).json.mode).toBe("legacy");
    expect((await r.call(r.admin, "GET", r.path)).json).toMatchObject({ binding: "repair-required", policy: null });
    const manual = await manualAttempt(r); expect((await manual.approve()).status).toBe(200);
    await expect(manual.claim()).resolves.toMatchObject({ status: "approved" });
    replace(original); await r.save(await r.proposal()); const enabled = await r.readPolicy(); replace({ ...enabled, generation: "older-generation" });
    expect((await r.call(r.admin, "GET", "/hub/v1/me/welcome")).status).toBe(503);
    expect((await r.call(r.admin, "GET", r.path)).json).toMatchObject({ binding: "repair-required", policy: null });
    expect((await r.signIn(r.colleague.login)).view.signedIn).toBe(true);
  });
  it("keeps a non-AD editor read-only and permanently fences captured controls on service close", async () => {
    const r = await rig(false), policy = await r.proposal(); expect((await r.call(r.admin, "GET", r.path)).json.supported).toBe(false);
    expect((await r.call(r.admin, "POST", `${r.path}/preview`, { policy })).status).toBe(422);
    await r.service!.close();
    await expect(r.deps.groupHttp!.control.read({ requestId: randomUUID(), current: () => true,
      requireAdmin: async () => ({ kind: "directory", person: ADMIN.key, sessionId: "admin" }) })).rejects.toThrow("unavailable");
  });
});
