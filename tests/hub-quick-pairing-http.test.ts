/** Quick routes over the sealed S5 factory, verified HTTPS and SQLite. Inert directory; no native/account operations. */
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
import { personKeyString } from "../src/hub/identity.js";

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

describe("quick pairing on the composed HTTPS surface", () => {
  it("is off until explicit group activation, and keeps browser CSRF/session/person boundaries", async () => {
    const r = await rig(), other = await r.signIn(r.colleague.login);
    expect(r.admin.view.features).toContain("quick-pairing-v1");
    expect((await r.call(r.admin, "POST", "/hub/v1/quick-pairing", { label: "Laptop" })).status).toBe(403);
    expect(r.read).not.toHaveBeenCalled(); expect(r.deps.store.read().pairings).toEqual([]);
    await r.save(await r.proposal()); const before = r.read.mock.calls.length;
    expect((await r.call(null, "POST", "/hub/v1/quick-pairing", { label: "Laptop" })).status).toBe(401);
    expect((await r.call(r.admin, "POST", "/hub/v1/quick-pairing", { label: "Laptop" }, { Origin: "https://unrelated.test" })).status).toBe(403);
    expect((await r.call({ ...r.admin, csrf: "wrong" }, "POST", "/hub/v1/quick-pairing", { label: "Laptop" })).status).toBe(403);
    expect(r.read.mock.calls.length).toBe(before);
    expect((await r.call(other, "POST", "/hub/v1/quick-pairing", { label: "Colleague" })).status).toBe(403);
    const offer = await r.call(r.admin, "POST", "/hub/v1/quick-pairing", { label: "Laptop" }); expect(offer.status).toBe(200);
    expect(offer.json).toMatchObject({ memberOrigin: r.cfg.memberOrigin, code: expect.stringMatching(/^[a-f0-9]{12}$/) });
    const foreign = await r.call(other, "GET", "/hub/v1/quick-pairing"); expect(foreign.json.attempt).toBe(null);
    expect((await r.call(other, "GET", `/hub/v1/quick-pairing?id=${offer.json.pairingId}`)).status).toBe(410);
    expect((await r.call(other, "POST", `/hub/v1/quick-pairing/${offer.json.pairingId}/stop`)).status).toBe(404);
    expect(r.deps.store.read().pairings).toHaveLength(1);
    expect((await r.call(r.admin, "POST", `/hub/v1/quick-pairing/${offer.json.pairingId}/stop`)).status).toBe(200);
    expect(r.deps.store.read().pairings).toEqual([]);
  });

  it("enqueues notice authority with credentials, separates initiating/other sessions and narrows exact owner revoke", async () => {
    const r = await rig(); await r.save(await r.proposal());
    const second = await r.signIn(), outsider = await r.signIn(r.colleague.login);
    const offer = await r.call(r.admin, "POST", "/hub/v1/quick-pairing", { label: "Laptop <b>literal</b>" });
    const p = r.deps.pairing.pair({ code: offer.json.code }), input = { pairingId: p.pairingId, fleetId: p.fleetId, claimSecret: p.claimSecret };
    const own = await r.call(r.admin, "GET", `/hub/v1/quick-pairing?id=${p.pairingId}`);
    expect(own.json.attempt).toMatchObject({ fingerprint: p.fingerprint, connected: false });
    for (const secret of [offer.json.code, p.claimSecret]) expect(JSON.stringify(own.json)).not.toContain(secret);
    expect(await r.deps.pairing.claim(input)).toEqual({ status: "pending" });
    expect((await r.call(r.admin, "POST", `/hub/v1/pairings/${p.pairingId}/confirm`, { fingerprint: p.fingerprint })).status).toBe(200);
    const claimed = await r.deps.pairing.claim(input); expect(claimed.status).toBe("approved");
    expect(r.deps.store.read().pairings[0]!.adminApproved).toBe(false);
    const newer = await r.call(r.admin, "POST", "/hub/v1/quick-pairing", { label: "Newer attempt" }); expect(newer.status).toBe(200);
    expect((await r.call(r.admin, "GET", "/hub/v1/quick-pairing")).json.attempt.id).toBe(newer.json.pairingId);
    expect((await r.call(r.admin, "POST", `/hub/v1/quick-pairing/${newer.json.pairingId}/stop`)).status).toBe(200);
    expect((await r.call(r.admin, "GET", "/hub/v1/notices")).json.notices).toEqual([]);
    const notice = (await r.call(second, "GET", "/hub/v1/notices")).json.notices[0];
    expect(notice).toMatchObject({ fleetId: p.fleetId, generation: 1, label: "Laptop <b>literal</b>", source: "group" });
    expect((await r.call(outsider, "GET", "/hub/v1/notices")).json.notices).toEqual([]);
    expect((await r.call(outsider, "POST", `/hub/v1/notices/${notice.id}/ack`)).status).toBe(404);
    expect((await r.call(second, "POST", `/hub/v1/notices/${notice.id}/ack`)).status).toBe(200);
    const version = r.deps.store.read().revocationVersion;
    expect((await r.call(outsider, "POST", `/hub/v1/fleets/${p.fleetId}/revoke`, { generation: 1 })).status).toBe(404);
    expect((await r.call(second, "POST", `/hub/v1/fleets/${p.fleetId}/revoke`, { generation: 2 })).status).toBe(404);
    expect(r.deps.store.read().revocationVersion).toBe(version);
    expect((await r.call(second, "POST", `/hub/v1/fleets/${p.fleetId}/revoke`, { generation: 1 })).status).toBe(200);
    expect((await r.call(r.admin, "GET", "/hub/v1/quick-pairing")).json.attempt).toBe(null);
    expect((await r.call(second, "GET", "/hub/v1/notices")).json.notices[0].revoked).toBe(true);
    expect((await r.call(r.admin, "GET", "/hub/v1/me/welcome")).json.connect.fleets).toMatchObject([{ id: p.fleetId, generation: 2, status: "revoked" }]);
  });

  it("refuses a held admission after sign-out and cancels automatic reservations in the policy-off transaction", async () => {
    const r = await rig(); await r.save(await r.proposal());
    const held = gate<PolicyGroupFacts>(), entered = gate<void>();
    r.read.mockImplementationOnce(() => { entered.resolve(); return held.promise; });
    const pending = r.call(r.admin, "POST", "/hub/v1/quick-pairing", { label: "Late" }); await entered.promise;
    expect((await r.call(r.admin, "DELETE", "/hub/v1/session")).status).toBe(200);
    held.resolve({ kind: "complete", person: ADMIN.key, groups: [r.group], observedAt: Date.now() });
    expect((await pending).status).toBe(401); expect(r.deps.store.read().pairings).toEqual([]);
    const fresh = await r.signIn();
    expect((await r.call(fresh, "POST", "/hub/v1/quick-pairing", { label: "Waiting" })).status).toBe(200);
    const policy = (await r.call(fresh, "GET", r.path)).json.policy, off = { ...policy, state: "suspended" };
    const preview = await r.call(fresh, "POST", `${r.path}/preview`, { policy: off }); expect(preview.status).toBe(200);
    expect((await r.call(fresh, "PUT", r.path, { policy: off, previewDigest: preview.json.previewDigest })).status).toBe(200);
    expect(r.deps.store.read().pairings).toEqual([]);
    expect(r.db!.prepare("SELECT * FROM hub_pairing_notices").all()).toEqual([]);
    expect(r.deps.store.read().fleets.filter(f => personKeyString(f.owner) === personKeyString(ADMIN.key))).toEqual([]);
  });
});
