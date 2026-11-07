/** Real Hub HTTP service/loopback rig, SQL, provenance and hash audit; inert directory facts, no native/LDAP claim. */
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import { createHubGroupPolicyStore, groupPolicyMigration, inspectHubGroupPolicyBinding } from "../src/hub/group-policy/store.js";
import { createHubGroupResources, HUB_GROUP_RESOURCES_MIGRATION } from "../src/hub/group-policy/resources.js";
import { createHubGroupAuthorization } from "../src/hub/group-policy/authorization.js";
import type { HubExposure, PersonKey } from "../src/hub/types.js";
import type { PolicyGroupFacts } from "../src/hub/directory/groups.js";
type Rig = Awaited<ReturnType<typeof s3bRig>>;
let rig: Rig | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; vi.restoreAllMocks(); });
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function world(options: { enable?: boolean; manualFleet?: boolean } = {}) {
  const now = () => 100_000, r = rig = await s3bRig({ now }), owner = r.addPerson("morgan"), fleetId = randomUUID(), group = randomUUID(), other = randomUUID();
  const mutate = (work: Parameters<typeof r.store.mutate>[1]) => r.store.mutate({ at: now(), requestId: randomUUID(), actor: { kind: "local-host" }, action: "fixture.fleet", result: "completed" }, work);
  mutate(state => { state.fleets.push({ id: fleetId, owner, credentialHash: "a".repeat(64), generation: 1, status: "active" }); });
  for (const m of [HUB_AUDIT_MIGRATION, groupPolicyMigration(r.hubId, "corp", "generation-1"), HUB_GROUP_RESOURCES_MIGRATION]) m.up(r.db);
  const audit = createHubAudit({ db: r.db, contentKey: randomBytes(32), now });
  const append = vi.fn((...args: Parameters<typeof audit.appendInTransaction>) => audit.appendInTransaction(...args));
  const ordinaryAppend = r.httpDeps.audit.append.bind(r.httpDeps.audit);
  vi.spyOn(r.httpDeps.audit, "append").mockImplementation((tx, event) => { ordinaryAppend(tx, event); append(event, r.db); });
  const read = vi.fn(async (person: PersonKey): Promise<PolicyGroupFacts> => ({ kind: "complete", person, groups: [group], observedAt: now() }));
  Object.assign(r.directory, { groupPolicy: "ad-direct-guid", readPolicyGroups: read });
  const current = () => r.httpDeps.current().serverEnabled(), ctx = { requestId: randomUUID(), current };
  const policy = createHubGroupPolicyStore({ db: r.db, hubId: r.hubId, realm: "corp", generation: "generation-1", directory: r.directory,
    audit: { appendInTransaction: append }, current, now });
  const resources = createHubGroupResources({ db: r.db, policy, audit: { appendInTransaction: append }, current, now });
  const fleetResource = { kind: "fleet" as const, id: fleetId, revision: 1, owner };
  if (options.manualFleet !== false) resources.captureManual(fleetResource, ctx);
  const enable = () => policy.replace({ ...policy.read(), state: "enabled", groups: [{ group: { realm: "corp", objectId: group }, dn: "CN=Members,DC=example,DC=test", allow: ["pair_fleet", "publish_agents"], maxFleets: 2 }] }, r.admin, ctx);
  if (options.enable !== false) enable();
  const actions = createHubGroupAuthorization({ db: r.db, administrator: r.admin, policy: () => policy,
    binding: () => inspectHubGroupPolicyBinding(r.db, r.hubId, "corp", "generation-1"), audit: { appendInTransaction: append }, current, now,
    version: () => r.store.read().revocationVersion, advanceAuthorization: () => mutate(s => { s.revocationVersion++; }), refreshAuthorization: vi.fn() });
  if (options.manualFleet === false && options.enable !== false) await actions.enroll(fleetResource, ctx);
  const prepare = vi.spyOn(actions, "prepareEnrollment"); r.httpDeps.groups = actions; await r.restartHttp(); read.mockClear();
  const link = r.link(fleetId, owner), exposure = (): HubExposure => ({ id: randomUUID(), fleetId, owner: { ...owner }, revision: 1, displayName: "Helper", state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) });
  const resource = (e: HubExposure) => ({ kind: "exposure" as const, id: e.id, revision: e.revision, owner: e.owner });
  const send = (revision: number, exposures: HubExposure[]) => r.http.receive(r.frame("exposure.snapshot", { revision, exposures }, link) as never, link);
  const rows = () => r.db.prepare("SELECT * FROM hub_exposures").all();
  return { r, owner, fleetId, group, other, audit, append, read, policy, resources, fleetResource, actions, prepare, ctx, mutate, link, exposure, resource, send, rows, enable };
}
describe("group enrollment with actual publication snapshots", () => {
  it("preserves never-enabled publication without group reads or exposure provenance", async () => {
    const w = await world({ enable: false }), e = w.exposure(); await w.send(1, [e]);
    expect(w.rows()).toHaveLength(1); expect(w.read).not.toHaveBeenCalled(); expect(w.prepare).not.toHaveBeenCalled(); expect(w.resources.read(w.resource(e))).toBeNull();
  });
  it("commits a batch's actual publications and provenance together with source-correlated audit", async () => {
    const w = await world(), a = w.exposure(), b = w.exposure(), frame = w.r.frame("exposure.snapshot", { revision: 1, exposures: [a, b] }, w.link);
    await w.r.http.receive(frame as never, w.link);
    expect(w.rows()).toHaveLength(2); for (const e of [a, b]) expect(w.resources.read(w.resource(e))).toMatchObject({ source: "group", state: "active" });
    const events = w.append.mock.calls.map(([event]) => event).filter(e => ["group-resource.registered", "exposure.snapshot"].includes(e.action));
    expect(events).toHaveLength(3); expect(events.every(e => e.requestId === frame.requestId)).toBe(true); expect(w.audit.verifyChain()).toMatchObject({ ok: true });
  });
  it.each(["unknown", "denied"] as const)("refuses new publication on %s membership without publishing or enrolling it", async kind => {
    const w = await world(), e = w.exposure(); w.read.mockImplementation(async person => kind === "unknown" ? { kind: "unknown" } : { kind: "complete", person, groups: [w.other], observedAt: 100_000 });
    await expect(w.send(1, [e])).rejects.toThrow(kind === "unknown" ? "unavailable" : "denied");
    expect(w.rows()).toEqual([]); expect(w.resources.read(w.resource(e))).toBeNull(); expect(w.r.db.prepare("SELECT * FROM hub_catalog_cursor").all()).toEqual([]);
  });
  it("withholds the whole batch when its second publication's fresh membership is unknown", async () => {
    const w = await world(), a = w.exposure(), b = w.exposure();
    w.read.mockImplementationOnce(async person => ({ kind: "complete", person, groups: [w.group], observedAt: 100_000 })).mockResolvedValueOnce({ kind: "unknown" });
    await expect(w.send(1, [a, b])).rejects.toThrow("unavailable"); expect(w.rows()).toEqual([]);
    for (const e of [a, b]) expect(w.resources.read(w.resource(e))).toBeNull();
    expect(w.append.mock.calls.filter(([event]) => event.action === "group-resource.registered")).toHaveLength(0);
  });
  it("does not infer missing fleet enrollment from a publication", async () => {
    const w = await world(), e = w.exposure(); w.r.db.prepare("DELETE FROM hub_group_resources").run();
    await expect(w.send(1, [e])).rejects.toThrow(); expect(w.rows()).toEqual([]); expect(w.r.db.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]);
  });
  it("a byte-identical retry needs no new membership read, allowance or provenance", async () => {
    const w = await world(), e = w.exposure(); await w.send(1, [e]); w.read.mockClear(); w.prepare.mockClear(); w.read.mockResolvedValue({ kind: "unknown" });
    await w.send(1, [e]); expect(w.read).not.toHaveBeenCalled(); expect(w.prepare).not.toHaveBeenCalled(); expect(w.rows()).toHaveLength(1);
  });
  it("withdrawal and unchanged exact bindings remain available during an outage", async () => {
    const w = await world(), e = w.exposure(); await w.send(1, [e]); w.read.mockClear(); w.read.mockResolvedValue({ kind: "unknown" });
    await w.send(2, [{ ...e, displayName: "Renamed helper" }]); expect(w.read).not.toHaveBeenCalled();
    await w.send(3, []); expect(w.rows()).toMatchObject([{ state: "withdrawn" }]); expect(w.read).not.toHaveBeenCalled();
  });
  it("preserves exact manual publication but requires a fresh group allowance for its next revision", async () => {
    const w = await world({ enable: false }), e = w.exposure(); await w.send(1, [e]); w.resources.captureManual(w.resource(e), w.ctx); w.enable();
    w.read.mockResolvedValue({ kind: "unknown" }); await w.send(2, [e]);
    await expect(w.send(3, [{ ...e, revision: 2 }])).rejects.toThrow("unavailable"); expect(w.rows()).toMatchObject([{ revision: 1 }]);
    expect(w.resources.read(w.resource(e))).toMatchObject({ source: "manual", state: "active" });
  });
  it("cannot revive an old manual revision after withdrawal; a newly consented revision enrolls freshly", async () => {
    const w = await world({ enable: false }), e = w.exposure(); await w.send(1, [e]); w.resources.captureManual(w.resource(e), w.ctx); w.enable(); await w.send(2, []);
    await expect(w.send(3, [e])).rejects.toThrow(); expect(w.rows()).toMatchObject([{ state: "withdrawn", revision: 1 }]);
    const revised = { ...e, revision: 2 }; await w.send(3, [revised]); expect(w.resources.read(w.resource(revised))).toMatchObject({ source: "group", state: "active" });
  });
  it("a same-revision frozen publication stays frozen without new allowance; unfreezing needs a new allowed revision", async () => {
    const w = await world(), e = w.exposure(); await w.send(1, [e]); w.r.db.prepare("UPDATE hub_exposures SET frozen_through=revision").run();
    w.read.mockClear(); w.read.mockResolvedValue({ kind: "unknown" }); await w.send(2, [e]); expect(w.read).not.toHaveBeenCalled();
    await expect(w.send(3, [{ ...e, revision: 2 }])).rejects.toThrow("unavailable"); expect(w.rows()).toMatchObject([{ revision: 1, frozen_through: 1 }]);
  });
  it.each(["group-resource.registered", "exposure.snapshot"])("rolls back the complete batch when required %s audit fails", async action => {
    const w = await world(), a = w.exposure(), b = w.exposure();
    w.append.mockImplementation((event, db) => { if (event.action === action) throw Error("audit unavailable"); return w.audit.appendInTransaction(event, db); });
    await expect(w.send(1, [a, b])).rejects.toThrow("audit unavailable"); expect(w.rows()).toEqual([]);
    for (const e of [a, b]) expect(w.resources.read(w.resource(e))).toBeNull(); expect(w.r.db.prepare("SELECT * FROM hub_catalog_cursor").all()).toEqual([]);
    expect(w.r.store.read().revocationVersion).toBe(0); expect(w.audit.verifyChain()).toMatchObject({ ok: true });
  });
  it.each(["group-resource.registered", "exposure.snapshot"])("rejects catalog material changed reentrantly during %s audit", async action => {
    const w = await world(), e = w.exposure();
    w.append.mockImplementation((event, db) => { const id = w.audit.appendInTransaction(event, db);
      if (event.action === action) w.r.db.prepare("UPDATE hub_exposures SET policy_digest=?").run("c".repeat(64)); return id; });
    await expect(w.send(1, [e])).rejects.toThrow("conflict"); expect(w.rows()).toEqual([]); expect(w.resources.read(w.resource(e))).toBeNull();
  });
  it("withholds publication if the exact fleet lifecycle is narrowed during the final snapshot audit", async () => {
    const w = await world(), e = w.exposure();
    w.append.mockImplementation((event, db) => { const id = w.audit.appendInTransaction(event, db);
      if (event.action === "exposure.snapshot") w.r.db.prepare("UPDATE hub_group_resources SET state='suspended',revision=revision+1 WHERE resource_key=?")
        .run(JSON.stringify(["fleet", w.fleetId, 1])); return id; });
    await expect(w.send(1, [e])).rejects.toThrow("unavailable"); expect(w.rows()).toEqual([]); expect(w.resources.read(w.resource(e))).toBeNull();
    expect(w.resources.read(w.fleetResource)).toMatchObject({ state: "active", revision: 1 });
  });
  it.each(["link", "server", "policy", "epoch", "fleet-owner", "fleet-generation", "catalog"] as const)("fences a held publication after %s changes", async changed => {
    const w = await world(), e = w.exposure(), entered = gate<PersonKey>(), held = gate<PolicyGroupFacts>();
    w.read.mockImplementationOnce(person => { entered.resolve(person); return held.promise; }); const pending = w.send(1, [e]), person = await entered.promise;
    if (changed === "link") { w.link.alive = false; w.link.current = () => true; }
    else if (changed === "server") w.r.disable();
    else if (changed === "policy") w.policy.replace({ ...w.policy.read(), state: "suspended" }, w.r.admin, w.ctx);
    else if (changed === "catalog") w.r.db.prepare("INSERT INTO hub_catalog_cursor VALUES(?,2,?,100000)").run(w.fleetId, "f".repeat(64));
    else w.mutate(s => { if (changed === "epoch") s.revocationVersion++; else if (changed === "fleet-owner") s.fleets[0]!.owner = w.r.admin; else s.fleets[0]!.generation++; });
    held.resolve({ kind: "complete", person, groups: [w.group], observedAt: 100_000 }); await expect(pending).rejects.toThrow();
    expect(w.rows()).toEqual([]); expect(w.r.db.prepare("SELECT * FROM hub_group_resources WHERE source='group'").all()).toEqual([]);
  });
  it("snapshots the caller's nested payload and owner before the directory await", async () => {
    const w = await world(), e = w.exposure(), originalId = e.id, originalOwner = { ...e.owner }, entered = gate<PersonKey>(), held = gate<PolicyGroupFacts>();
    w.read.mockImplementationOnce(person => { entered.resolve(person); return held.promise; }); const pending = w.send(1, [e]), person = await entered.promise;
    e.id = randomUUID(); Object.assign(e.owner, { objectId: randomUUID() }); e.policyDigest = "c".repeat(64);
    held.resolve({ kind: "complete", person, groups: [w.group], observedAt: 100_000 }); await pending;
    expect(w.rows()).toMatchObject([{ id: originalId, policy_digest: "b".repeat(64) }]);
    expect(w.resources.read({ kind: "exposure", id: originalId, revision: 1, owner: originalOwner })).toMatchObject({ state: "active" });
  });
});
