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
  });
  it("keeps a non-AD editor read-only and permanently fences captured controls on service close", async () => {
    const r = await rig(false), policy = await r.proposal(); expect((await r.call(r.admin, "GET", r.path)).json.supported).toBe(false);
    expect((await r.call(r.admin, "POST", `${r.path}/preview`, { policy })).status).toBe(422);
    await r.service!.close();
    await expect(r.deps.groupHttp!.control.read({ requestId: randomUUID(), current: () => true,
      requireAdmin: async () => ({ kind: "directory", person: ADMIN.key, sessionId: "admin" }) })).rejects.toThrow("unavailable");
  });
});
