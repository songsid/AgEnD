/** Configured-admin control over real SQLite/authorization; no real directory, accounts, native manager or listener. */
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HUB_AUDIT_MIGRATION, createHubAudit } from "../src/hub/audit/index.js";
import { HUB_HTTP_MIGRATIONS } from "../src/hub/http/schema.js";
import { HubTransportStore, HUB_TRANSPORT_MIGRATION } from "../src/hub/store.js";
import { createHubGroupPolicyStore, groupPolicyMigration, inspectHubGroupPolicyBinding } from "../src/hub/group-policy/store.js";
import { HUB_GROUP_RESOURCES_MIGRATION, createHubGroupResources, type HubGroupResource } from "../src/hub/group-policy/resources.js";
import { createHubGroupAuthorization } from "../src/hub/group-policy/authorization.js";
import { createHubGroupAdminInventory } from "../src/hub/group-policy/admin-inventory.js";
import { createHubGroupAdminReads } from "../src/hub/group-policy/admin-read.js";
import { personKeyString } from "../src/hub/identity.js";
import type { HubActor, HubDirectory } from "../src/hub/types.js";
import type { PolicyGroupFacts, PolicyGroupLookup } from "../src/hub/directory/groups.js";
import type { GroupAdminContext, GroupResumeRequest } from "../src/hub/group-policy/admin-dto.js";

const databases: Database.Database[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.restoreAllMocks(); });
const key = () => ({ realm: "example", objectId: randomUUID() });
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const db = new Database(":memory:"); databases.push(db); db.pragma("foreign_keys=ON");
  for (const m of [HUB_AUDIT_MIGRATION, HUB_TRANSPORT_MIGRATION, ...HUB_HTTP_MIGRATIONS,
    groupPolicyMigration("hub-1", "example", "gen-1"), HUB_GROUP_RESOURCES_MIGRATION]) m.up(db);
  const administrator = key(), owner = key(), group = key(), other = key();
  let server = true, session = true, generation = "gen-1", floor = 0;
  const current = () => server, now = () => 100;
  const audit = createHubAudit({ db, contentKey: randomBytes(32), now });
  const transport = new HubTransportStore(db, { floor: { read: () => floor, raise: n => { floor = n; } },
    appendAudit: (event, tx) => { audit.appendInTransaction(event, tx); } }); transport.initialize();
  const groups = vi.fn(async (person: typeof owner): Promise<PolicyGroupFacts> => ({ kind: "complete", person, groups: [group.objectId], observedAt: now() }));
  const lookup = vi.fn(async (_dn: string): Promise<PolicyGroupLookup> => ({ ok: true, group: { key: { ...group }, dn: "CN=Members,DC=example,DC=test" } }));
  const directory = { realm: "example", groupPolicy: "ad-direct-guid", readPolicyGroups: groups, resolvePolicyGroup: lookup } as unknown as HubDirectory;
  const policy = createHubGroupPolicyStore({ db, hubId: "hub-1", realm: "example", generation: "gen-1", directory, audit, current, now });
  const policyOf = vi.fn(() => policy), binding = () => inspectHubGroupPolicyBinding(db, "hub-1", "example", generation);
  const resources = createHubGroupResources({ db, policy, audit, current, now });
  const refresh = vi.fn(() => { expect(db.inTransaction).toBe(false); });
  const mutate = (work: (state: ReturnType<typeof transport.read>) => void) => transport.mutate({ at: now(), requestId: randomUUID(),
    actor: { kind: "local-host" }, action: "fixture.transport", result: "completed" }, work);
  const authorization = createHubGroupAuthorization({ db, administrator, policy: policyOf, binding, audit, current, now,
    version: () => transport.read().revocationVersion, advanceAuthorization: () => mutate(s => { s.revocationVersion++; }), refreshAuthorization: refresh });
  const inventory = createHubGroupAdminInventory({ db, transport, realm: "example" });
  const reads = createHubGroupAdminReads({ administrator, directory, current, binding, policy: policyOf, inventory, authorization });
  const authenticate = vi.fn(async (): Promise<HubActor> => ({ kind: "directory", person: { ...administrator }, sessionId: "admin-session" }));
  const ctx: GroupAdminContext = { requestId: randomUUID(), current: () => session, requireAdmin: authenticate };
  const action = { requestId: randomUUID(), current: () => true };
  const enable = () => policy.replace({ ...policy.read(), state: "enabled", groups: [{ group, dn: "CN=Members,DC=example,DC=test",
    allow: ["pair_fleet", "publish_agents", "ask_agents"], maxFleets: 2 }] }, administrator, action);
  const fleetId = randomUUID();
  const fleet = () => transport.read().fleets.find(f => f.id === fleetId)!;
  const addFleet = () => mutate(s => { s.fleets.push({ id: fleetId, owner, credentialHash: "a".repeat(64), generation: 1, status: "active" }); });
  const addExposure = (id: string) => db.prepare(`INSERT INTO hub_exposures(id,fleet_id,owner,display_name,revision,state,data_view_id,allowed_tools,policy_digest,updated_at)
    VALUES(?,?,?,'Representative',1,'published','agent','[]',?,100)`).run(id, fleetId, personKeyString(owner), "b".repeat(64));
  const seed = async (kind: HubGroupResource["kind"] = "exposure") => {
    addFleet(); const id = kind === "fleet" ? fleetId : kind === "asker" ? owner.objectId : randomUUID();
    if (kind === "exposure") addExposure(id);
    enable(); const resource: HubGroupResource = { kind, id, revision: 1, owner };
    await authorization.enroll(resource, action);
    groups.mockResolvedValueOnce({ kind: "complete", person: owner, groups: [other.objectId], observedAt: now() });
    await expect(authorization.check(resource, action)).rejects.toMatchObject({ reason: "denied" }); refresh.mockClear();
    const request: GroupResumeRequest = { resource: { kind, id, revision: 1 }, expectedPolicyRevision: policy.read().revision, expectedLifecycleRevision: 2 };
    return { resource, request };
  };
  return { db, administrator, owner, group, other, directory, groups, lookup, policy, policyOf, resources, transport, authorization, inventory, reads,
    authenticate, ctx, action, refresh, mutate, enable, fleetId, fleet, seed, addFleet, addExposure,
    stop: () => { server = false; }, signOut: () => { session = false; }, generation: (value: string) => { generation = value; } };
}

describe("Hub group admin read and exact resume", () => {
  it("reads never-enabled policy without group lookup or provenance and makes unsupported realms read-only", async () => {
    const w = fixture(); expect(await w.reads.read(w.ctx)).toMatchObject({ ok: true, groupPolicyV1: true, supported: true, binding: "ready", paused: [], policy: { state: "never-enabled" } });
    expect(w.groups).not.toHaveBeenCalled(); expect(w.lookup).not.toHaveBeenCalled();
    expect(w.db.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]);
    Object.assign(w.directory, { groupPolicy: undefined });
    expect(await w.reads.read(w.ctx)).toMatchObject({ supported: false });
    expect(await w.reads.resolve({ dn: "CN=Members,DC=example,DC=test" }, w.ctx)).toEqual({ ok: false, reason: "unsupported" });
    expect(w.lookup).not.toHaveBeenCalled();
  });
  it("reads a repair-required binding without constructing the strict mismatched store", async () => {
    const w = fixture(); w.generation("gen-2"); w.policyOf.mockImplementation(() => { throw Error("strict mismatched store"); });
    expect(await w.reads.read(w.ctx)).toMatchObject({ binding: "repair-required", policy: null, paused: [] }); expect(w.policyOf).not.toHaveBeenCalled();
  });
  it.each(["read", "resolve", "resume"] as const)("requires the configured directory administrator for %s", async method => {
    const w = fixture(); w.authenticate.mockResolvedValue({ kind: "directory", person: w.owner, sessionId: "other-session" });
    const pending = method === "read" ? w.reads.read(w.ctx) : method === "resolve" ? w.reads.resolve({ dn: "CN=G,DC=example,DC=test" }, w.ctx)
      : w.reads.resume({ resource: { kind: "fleet", id: w.fleetId, revision: 1 }, expectedPolicyRevision: 1, expectedLifecycleRevision: 1 }, w.ctx);
    await expect(pending).rejects.toMatchObject({ code: "denied" }); expect(w.lookup).not.toHaveBeenCalled(); expect(w.groups).not.toHaveBeenCalled();
  });
  it("resolves through the bounded driver, returning its immutable key and canonical DN", async () => {
    const w = fixture(); expect(await w.reads.resolve({ dn: "CN=members, DC=example,DC=test" }, w.ctx))
      .toEqual({ ok: true, realm: "example", objectId: w.group.objectId, dn: "CN=Members,DC=example,DC=test" });
    expect(w.authenticate).toHaveBeenCalledTimes(2); expect(w.lookup).toHaveBeenCalledWith("CN=members, DC=example,DC=test");
  });
  it.each(["invalid", "not-found", "not-security-group", "unknown"] as const)("keeps bounded group lookup refusal %s", async reason => {
    const w = fixture(); w.lookup.mockResolvedValue({ ok: false, reason });
    expect(await w.reads.resolve({ dn: "CN=G,DC=example,DC=test" }, w.ctx)).toEqual({ ok: false, reason });
  });
  it("maps an unreadable group to unknown and refuses a driver key from another realm", async () => {
    const w = fixture(); w.lookup.mockRejectedValueOnce(Error("private directory diagnostic"));
    expect(await w.reads.resolve({ dn: "CN=G,DC=example,DC=test" }, w.ctx)).toEqual({ ok: false, reason: "unknown" });
    w.lookup.mockResolvedValue({ ok: true, group: { key: { ...w.group, realm: "other" }, dn: "CN=G,DC=example,DC=test" } });
    expect(await w.reads.resolve({ dn: "CN=G,DC=example,DC=test" }, w.ctx)).toEqual({ ok: false, reason: "unknown" });
    w.lookup.mockResolvedValue({ ok: false, reason: "private diagnostic" } as unknown as PolicyGroupLookup);
    expect(await w.reads.resolve({ dn: "CN=G,DC=example,DC=test" }, w.ctx)).toEqual({ ok: false, reason: "unknown" });
  });
  it("snapshots a selected group before the final administrator await", async () => {
    const w = fixture(), selected = { key: { ...w.group }, dn: "CN=Selected,DC=example,DC=test" }, held = gate<HubActor>(), entered = gate<void>();
    w.lookup.mockResolvedValue({ ok: true, group: selected });
    w.authenticate.mockImplementationOnce(async () => ({ kind: "directory", person: w.administrator, sessionId: "admin-session" }));
    w.authenticate.mockImplementationOnce(() => { entered.resolve(); return held.promise; });
    const pending = w.reads.resolve({ dn: selected.dn }, w.ctx); await entered.promise;
    selected.key.objectId = randomUUID(); selected.dn = "CN=Replacement,DC=example,DC=test";
    held.resolve({ kind: "directory", person: w.administrator, sessionId: "admin-session" });
    expect(await pending).toEqual({ ok: true, realm: "example", objectId: w.group.objectId, dn: "CN=Selected,DC=example,DC=test" });
  });
  it.each(["session", "close", "eligibility"] as const)("withholds a held lookup after %s changes", async change => {
    const w = fixture(), held = gate<PolicyGroupLookup>(), entered = gate<void>();
    w.lookup.mockImplementationOnce(() => { entered.resolve(); return held.promise; });
    const pending = w.reads.resolve({ dn: "CN=G,DC=example,DC=test" }, w.ctx), checked = expect(pending).rejects.toThrow();
    await entered.promise;
    if (change === "session") w.signOut(); else if (change === "close") w.reads.close();
    else w.authenticate.mockRejectedValueOnce(Error("admin no longer eligible"));
    held.resolve({ ok: true, group: { key: w.group, dn: "CN=G,DC=example,DC=test" } }); await checked;
  });
  it.each(["fleet", "exposure", "asker"] as const)("lists and resumes one exact %s, audited and versioned by the real action adapter", async kind => {
    const w = fixture(), { resource, request } = await w.seed(kind), before = w.transport.read().revocationVersion;
    expect((await w.reads.read(w.ctx)).paused).toEqual([{ resource: request.resource, lifecycleRevision: 2,
      label: kind === "exposure" ? "Representative" : null, owner: { name: null } }]);
    expect(await w.reads.resume(request, w.ctx)).toEqual({ ok: true, resource: request.resource, state: "active", policyRevision: 2, lifecycleRevision: 3 });
    expect(w.resources.read(resource)).toMatchObject({ state: "active", revision: 3 });
    expect(w.transport.read().revocationVersion).toBe(before + 1); expect(w.refresh).toHaveBeenCalledOnce();
    expect(w.db.prepare("SELECT action FROM hub_audit WHERE action='group-resource.resumed'").all()).toHaveLength(1);
    expect((await w.reads.read(w.ctx)).paused).toEqual([]);
  });
  it.each(["policy", "lifecycle", "resource"] as const)("rejects the stale %s revision before any membership read", async changed => {
    const w = fixture(), { request } = await w.seed(); w.groups.mockClear();
    if (changed === "policy") request.expectedPolicyRevision++; else if (changed === "lifecycle") request.expectedLifecycleRevision++; else request.resource.revision++;
    expect(await w.reads.resume(request, w.ctx)).toEqual({ ok: false, code: "conflict" });
    expect(w.groups).not.toHaveBeenCalled(); expect(w.refresh).not.toHaveBeenCalled();
  });
  it.each(["unknown", "deny"] as const)("never resumes on %s membership", async kind => {
    const w = fixture(), { resource, request } = await w.seed();
    w.groups.mockResolvedValueOnce(kind === "unknown" ? { kind: "unknown" } : { kind: "complete", person: w.owner, groups: [w.other.objectId], observedAt: 100 });
    expect(await w.reads.resume(request, w.ctx)).toEqual({ ok: false, code: kind === "unknown" ? "unknown" : "denied" });
    expect(w.resources.read(resource)).toMatchObject({ state: "suspended", revision: 2 }); expect(w.refresh).not.toHaveBeenCalled();
  });
  it.each(["withdraw", "freeze", "revision", "owner", "fleet-revoked", "fleet-generation", "fleet-credential", "policy", "version", "session", "close"] as const)
    ("refuses a held resume after %s changes, without broadening its ledger", async changed => {
      const w = fixture(), { resource, request } = await w.seed(), held = gate<PolicyGroupFacts>(), entered = gate<void>();
      w.groups.mockImplementationOnce(() => { entered.resolve(); return held.promise; });
      const pending = w.reads.resume(request, w.ctx); await entered.promise;
      if (changed === "withdraw") w.db.prepare("UPDATE hub_exposures SET state='withdrawn'").run();
      else if (changed === "freeze") w.db.prepare("UPDATE hub_exposures SET frozen_through=1").run();
      else if (changed === "revision") w.db.prepare("UPDATE hub_exposures SET revision=2").run();
      else if (changed === "owner") w.db.prepare("UPDATE hub_exposures SET owner=?").run(personKeyString(w.other));
      else if (changed === "fleet-revoked") w.mutate(s => { s.fleets[0]!.status = "revoked"; });
      else if (changed === "fleet-generation") w.mutate(s => { s.fleets[0]!.generation++; });
      else if (changed === "fleet-credential") w.mutate(s => { s.fleets[0]!.credentialHash = "c".repeat(64); });
      else if (changed === "policy") w.policy.replace({ ...w.policy.read(), groups: [] }, w.administrator, w.action);
      else if (changed === "version") w.mutate(s => { s.revocationVersion++; });
      else if (changed === "session") w.signOut(); else w.reads.close();
      held.resolve({ kind: "complete", person: w.owner, groups: [w.group.objectId], observedAt: 100 });
      expect(await pending).toMatchObject({ ok: false }); expect(w.resources.read(resource)).toMatchObject({ state: "suspended", revision: 2 });
      expect(w.refresh).not.toHaveBeenCalled();
    });
  it("does not list or resume ordinarily withdrawn or revoked resources", async () => {
    const w = fixture(), { request } = await w.seed();
    w.db.prepare("UPDATE hub_exposures SET state='withdrawn'").run();
    expect((await w.reads.read(w.ctx)).paused).toEqual([]); w.groups.mockClear();
    expect(await w.reads.resume(request, w.ctx)).toEqual({ ok: false, code: "conflict" }); expect(w.groups).not.toHaveBeenCalled();
  });
  it.each(["fleet-generation", "no-credential", "fleet-revoked", "exposure-owner", "exposure-revision", "frozen", "asker-binding"] as const)
    ("inventory refuses the invalid ordinary %s binding", async changed => {
      const w = fixture(), { request } = await w.seed(changed === "asker-binding" ? "asker" : changed.startsWith("fleet") || changed === "no-credential" ? "fleet" : "exposure");
      expect(w.inventory.current(request.resource)).not.toBeNull();
      if (changed === "fleet-generation") w.mutate(s => { s.fleets[0]!.generation++; });
      else if (changed === "no-credential") w.mutate(s => { s.fleets[0]!.credentialHash = null; });
      else if (changed === "fleet-revoked") w.mutate(s => { s.fleets[0]!.status = "revoked"; });
      else if (changed === "exposure-owner") w.db.prepare("UPDATE hub_exposures SET owner=?").run(personKeyString(w.other));
      else if (changed === "exposure-revision") w.db.prepare("UPDATE hub_exposures SET revision=revision+1").run();
      else if (changed === "frozen") w.db.prepare("UPDATE hub_exposures SET frozen_through=1").run();
      else {
        const r = w.inventory.ledger(request.resource)!.resource;
        w.db.prepare("UPDATE hub_group_resources SET body=?").run(JSON.stringify({ ...r, owner: w.other }));
      }
      expect(w.inventory.current(request.resource)).toBeNull();
    });
  it("refuses a corrupted ledger owner rather than displaying it as the ordinary resource owner", async () => {
    const w = fixture(), { resource } = await w.seed();
    w.db.prepare("UPDATE hub_group_resources SET body=?").run(JSON.stringify({ ...resource, owner: w.other }));
    await expect(w.reads.read(w.ctx)).rejects.toThrow("group_policy_unavailable");
  });
  it("snapshots resume inputs before awaiting administrator authentication", async () => {
    const w = fixture(), { request, resource } = await w.seed(), held = gate<HubActor>();
    w.authenticate.mockReturnValueOnce(held.promise);
    const pending = w.reads.resume(request, w.ctx); request.resource.id = randomUUID(); request.expectedLifecycleRevision = 99;
    held.resolve({ kind: "directory", person: w.administrator, sessionId: "admin-session" });
    expect(await pending).toMatchObject({ ok: true, resource: { id: resource.id }, lifecycleRevision: 3 });
  });
});
