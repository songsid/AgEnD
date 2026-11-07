/** Real local policy/lifecycle/transport/audit, fake directory people and session authority. No HTTP/UI/pilot claim. */
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HUB_HTTP_MIGRATIONS } from "../src/hub/http/schema.js";
import { HUB_AUDIT_MIGRATION, createHubAudit } from "../src/hub/audit/index.js";
import { HubTransportStore, HUB_TRANSPORT_MIGRATION } from "../src/hub/store.js";
import { groupPolicyMigration, createHubGroupPolicyStore, inspectHubGroupPolicyBinding } from "../src/hub/group-policy/store.js";
import { HUB_GROUP_RESOURCES_MIGRATION, createHubGroupResources } from "../src/hub/group-policy/resources.js";
import { createHubGroupAuthorization } from "../src/hub/group-policy/authorization.js";
import { createHubGroupAdminInventory } from "../src/hub/group-policy/admin-inventory.js";
import { createHubGroupImpactInventory } from "../src/hub/group-policy/impact-inventory.js";
import { createHubGroupAdminControl } from "../src/hub/group-policy/admin-control.js";
import { personKeyString } from "../src/hub/identity.js";
import type { HubActor, HubDirectory, PersonKey } from "../src/hub/types.js";
import type { PolicyGroupFacts, PolicyGroupLookup } from "../src/hub/directory/groups.js";
import type { HubGroupPolicy } from "../src/hub/group-policy/model.js";
import type { GroupAdminContext, GroupImpact } from "../src/hub/group-policy/admin-dto.js";
const databases: Database.Database[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.restoreAllMocks(); });
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const key = (): PersonKey => ({ realm: "example", objectId: randomUUID() });
function fixture() {
  const db = new Database(":memory:"); databases.push(db); db.pragma("foreign_keys=ON");
  for (const m of [HUB_AUDIT_MIGRATION, HUB_TRANSPORT_MIGRATION, ...HUB_HTTP_MIGRATIONS,
    groupPolicyMigration("hub-1", "example", "gen-1"), HUB_GROUP_RESOURCES_MIGRATION]) m.up(db);
  const administrator = key(), owner = key(), asker = key(), group = key(), other = key();
  for (const [person, name, login] of [[administrator, "Avery Admin", "avery"], [owner, "Morgan Owner", "morgan"], [asker, "Riley Asker", "riley"]] as const)
    db.prepare("INSERT INTO hub_people(person,realm,object_id,display_name,login_label,status,last_checked_at) VALUES(?,?,?,?,?,'active',100)")
      .run(personKeyString(person), person.realm, person.objectId, name, login);
  let live = true, session = true, t = 100, floor = 0, generation = "gen-1";
  const now = () => t, current = () => live;
  const audit = createHubAudit({ db, contentKey: randomBytes(32), now });
  const append = vi.fn((...args: Parameters<typeof audit.appendInTransaction>) => audit.appendInTransaction(...args));
  const audited = { appendInTransaction: append };
  const store = new HubTransportStore(db, { floor: { read: () => floor, raise: n => { floor = n; } }, appendAudit: (event, tx) => { audit.appendInTransaction(event, tx); } }); store.initialize();
  const mutate = (work: (s: ReturnType<typeof store.read>) => void) => store.mutate({ at: now(), requestId: randomUUID(), actor: { kind: "local-host" }, action: "fixture.transport", result: "completed" }, work);
  const fleetId = randomUUID(), exposureId = randomUUID();
  mutate(s => { s.fleets.push({ id: fleetId, owner, credentialHash: "a".repeat(64), generation: 1, status: "active" }); });
  db.prepare(`INSERT INTO hub_exposures(id,fleet_id,owner,display_name,revision,state,data_view_id,allowed_tools,policy_digest,updated_at)
    VALUES(?,?,?,'Helper',1,'published','agent','[]',?,100)`).run(exposureId, fleetId, personKeyString(owner), "b".repeat(64));
  const facts = new Map<string, "unknown" | string[]>();
  const read = vi.fn(async (person: PersonKey): Promise<PolicyGroupFacts> => {
    const state = facts.get(person.objectId); return state === "unknown" ? { kind: "unknown" }
      : { kind: "complete", person: { ...person }, groups: [...(state ?? [group.objectId])], observedAt: now() };
  });
  const resolve = vi.fn(async (dn: string): Promise<PolicyGroupLookup> => ({ ok: true, group: { key: { ...group }, dn } }));
  const directory = { realm: "example", groupPolicy: "ad-direct-guid", readPolicyGroups: read, resolvePolicyGroup: resolve } as unknown as HubDirectory;
  const policy = createHubGroupPolicyStore({ db, hubId: "hub-1", realm: "example", generation, directory, audit: audited, current, now });
  const policyOf = vi.fn(() => policy), binding = () => inspectHubGroupPolicyBinding(db, "hub-1", "example", generation);
  const advance = vi.fn((tx: Database.Database) => { expect(tx).toBe(db); expect(db.inTransaction).toBe(true); mutate(s => { s.revocationVersion++; }); });
  const refresh = vi.fn(() => { expect(db.inTransaction).toBe(false); });
  const authorization = createHubGroupAuthorization({ db, administrator, policy: policyOf, binding, audit: audited, current, now,
    version: () => store.read().revocationVersion, advanceAuthorization: advance, refreshAuthorization: refresh });
  const resources = createHubGroupResources({ db, policy, audit: audited, current, now });
  const inventory = createHubGroupAdminInventory({ db, transport: store, realm: "example" });
  const impactInventory = createHubGroupImpactInventory({ db, transport: store, administrator, inventory, current, now });
  const control = createHubGroupAdminControl({ db, audit: audited, directory, administrator, transport: store, inventory, authorization,
    policy: policyOf, binding, current, version: () => store.read().revocationVersion, advanceAuthorization: advance, refreshAuthorization: refresh, now });
  const authenticate = vi.fn(async (): Promise<HubActor> => ({ kind: "directory", person: { ...administrator }, sessionId: "admin-session" }));
  const ctx: GroupAdminContext = { requestId: randomUUID(), current: () => session, requireAdmin: authenticate }, action = { requestId: randomUUID(), current };
  const proposal = (): HubGroupPolicy => ({ ...policy.read(), state: "enabled", groups: [{ group: { ...group }, dn: "CN=Members,DC=example,DC=test",
    allow: ["ask_agents", "publish_agents", "pair_fleet"], maxFleets: 2 }] });
  const fleetResource = { kind: "fleet" as const, id: fleetId, revision: 1, owner }, exposureResource = { kind: "exposure" as const, id: exposureId, revision: 1, owner };
  const apply = async (next = proposal()) => {
    const preview = await control.preview({ policy: next }, ctx); expect(preview.ok).toBe(true);
    if (!preview.ok) throw Error("positive preview refused");
    return { preview, result: await control.apply({ policy: next, previewDigest: preview.previewDigest }, ctx) };
  };
  const enableGroup = async () => {
    policy.replace(proposal(), administrator, action); await authorization.enroll(fleetResource, action); await authorization.enroll(exposureResource, action); await authorization.asker(asker, action);
    refresh.mockClear(); advance.mockClear();
  };
  return { db, administrator, owner, asker, group, other, store, mutate, directory, facts, read, resolve, policy, policyOf, resources, authorization, inventory, impactInventory, control, ctx, action, authenticate,
    advance, refresh, append, audit, proposal, apply, enableGroup, fleetId, exposureId, fleetResource, exposureResource,
    time: (ms: number) => { t += ms; }, signOut: () => { session = false; }, stop: () => { live = false; }, generation: () => { generation = "gen-2"; } };
}
describe("sealed group policy confirmation control", () => {
  it("previews without writes, then atomically captures exact manual revisions, policy, evidence and one transport epoch", async () => {
    const w = fixture(), next = w.proposal(), preview = await w.control.preview({ policy: next }, w.ctx);
    expect(preview).toMatchObject({ ok: true, policyRevision: 1, authorizationVersion: 0, expiresAt: 120_100 });
    if (!preview.ok) throw Error("positive preview refused");
    expect(preview.impact.grandfathered).toHaveLength(2); expect(w.policy.read().state).toBe("never-enabled");
    expect(w.db.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]); expect(w.advance).not.toHaveBeenCalled();
    w.time(10); // Fresh observation timestamps do not by themselves change semantic membership.
    expect(await w.control.apply({ policy: next, previewDigest: preview.previewDigest }, w.ctx)).toEqual({ ok: true, policyRevision: 2, state: "enabled" });
    expect(w.resources.read(w.fleetResource)).toMatchObject({ source: "manual", state: "active", revision: 1 });
    expect(w.resources.read(w.exposureResource)).toMatchObject({ source: "manual", state: "active", revision: 1 });
    expect(w.store.read().revocationVersion).toBe(1); expect(w.advance).toHaveBeenCalledOnce(); expect(w.refresh).toHaveBeenCalledOnce();
    const actor = w.db.prepare("SELECT actor FROM hub_audit WHERE action='group-resource.manual-captured' LIMIT 1").get() as { actor: string };
    expect(actor.actor).toContain(w.administrator.objectId); expect(w.audit.verifyChain()).toMatchObject({ ok: true });
  });
  it("unknown impact is separately HELD but does not block saving or grant a new group resource", async () => {
    const w = fixture(); for (const p of [w.administrator, w.owner, w.asker]) w.facts.set(p.objectId, "unknown");
    const { preview, result } = await w.apply(); expect(result).toMatchObject({ ok: true }); expect((preview.impact as GroupImpact & { held: readonly unknown[] }).held).toHaveLength(3);
    expect(w.resources.read(w.fleetResource)).toMatchObject({ state: "active" }); expect(w.resources.read(w.exposureResource)).toMatchObject({ state: "active" });
    await expect(w.authorization.prepareEnrollment({ ...w.exposureResource, id: randomUUID() }, w.action)).rejects.toMatchObject({ outcome: "held" });
    await expect(w.authorization.asker(w.asker, w.action)).rejects.toMatchObject({ reason: "held" });
    expect(w.db.prepare("SELECT * FROM hub_group_resources WHERE source='group'").all()).toEqual([]);
  });
  it("unknown becoming known at apply requires another preview and audits the observed change without policy/resource writes", async () => {
    const w = fixture(); w.facts.set(w.asker.objectId, "unknown"); const next = w.proposal(), preview = await w.control.preview({ policy: next }, w.ctx);
    if (!preview.ok) throw Error("positive preview refused"); w.facts.set(w.asker.objectId, [w.group.objectId]);
    expect(await w.control.apply({ policy: next, previewDigest: preview.previewDigest }, w.ctx)).toEqual({ ok: false, code: "stale-preview" });
    expect(w.policy.read().state).toBe("never-enabled"); expect(w.db.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]);
    expect(w.db.prepare("SELECT id FROM hub_audit WHERE action='group-policy.preview-stale' AND result='held'").all()).toHaveLength(1);
    expect(w.advance).not.toHaveBeenCalled(); expect(w.refresh).not.toHaveBeenCalled();
  });
  it("re-previews changed membership evidence even when its displayed impact is identical", async () => {
    const w = fixture(), next = w.proposal(), preview = await w.control.preview({ policy: next }, w.ctx);
    if (!preview.ok) throw Error("positive preview refused"); w.facts.set(w.owner.objectId, [w.group.objectId, w.other.objectId]);
    expect(await w.control.apply({ policy: next, previewDigest: preview.previewDigest }, w.ctx)).toEqual({ ok: false, code: "stale-preview" });
    expect(w.policy.read().state).toBe("never-enabled"); expect(w.db.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]);
    expect(w.db.prepare("SELECT id FROM hub_audit WHERE action='group-policy.preview-stale'").all()).toHaveLength(1);
  });
  it("fences changed ordinary material even when labels and the displayed impact are identical", async () => {
    const w = fixture(), next = w.proposal(), preview = await w.control.preview({ policy: next }, w.ctx);
    if (!preview.ok) throw Error("positive preview refused"); w.db.prepare("UPDATE hub_exposures SET policy_digest=?").run("c".repeat(64));
    expect(await w.control.apply({ policy: next, previewDigest: preview.previewDigest }, w.ctx)).toEqual({ ok: false, code: "conflict" });
    expect(w.policy.read().state).toBe("never-enabled"); expect(w.db.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]);
    expect(w.advance).not.toHaveBeenCalled(); expect(w.refresh).not.toHaveBeenCalled();
  });
  it("complete negatives suspend group-derived rows with one epoch, and a later positive save never resumes them", async () => {
    const w = fixture(); await w.enableGroup(); w.facts.set(w.owner.objectId, [w.other.objectId]); w.facts.set(w.asker.objectId, [w.other.objectId]);
    const { preview, result } = await w.apply(); expect(result).toMatchObject({ ok: true }); expect(preview.impact.suspendedOnSave).toHaveLength(3);
    expect(w.resources.read(w.fleetResource)).toMatchObject({ source: "group", state: "suspended", revision: 2 });
    expect(w.resources.read(w.exposureResource)).toMatchObject({ source: "group", state: "suspended", revision: 2 }); expect(w.advance).toHaveBeenCalledOnce();
    w.facts.clear(); expect((await w.apply()).result).toMatchObject({ ok: true });
    expect(w.resources.read(w.exposureResource)).toMatchObject({ state: "suspended", revision: 2 });
    expect(w.db.prepare("SELECT id FROM hub_audit WHERE action='group-resource.resumed'").all()).toEqual([]);
  });
  it("an explicit deny narrows exact manual publication even with unknown membership, leaving its fleet alone", async () => {
    const w = fixture(); expect((await w.apply()).result).toMatchObject({ ok: true }); w.facts.set(w.owner.objectId, "unknown");
    const next = { ...w.proposal(), denies: [{ person: w.owner, deny: ["publish_agents" as const] }] };
    const { preview, result } = await w.apply(next); expect(result).toMatchObject({ ok: true }); expect(preview.impact.suspendedOnSave).toHaveLength(1);
    expect(w.resources.read(w.exposureResource)).toMatchObject({ source: "manual", state: "suspended", revision: 2 });
    expect(w.resources.read(w.fleetResource)).toMatchObject({ source: "manual", state: "active", revision: 1 });
  });
  it.each(["body", "session", "expired", "policy", "epoch", "ordinary", "group-recreated"] as const)("refuses a %s mismatch without applying the candidate", async changed => {
    const w = fixture(), next = w.proposal(), preview = await w.control.preview({ policy: next }, w.ctx);
    if (!preview.ok) throw Error("positive preview refused");
    if (changed === "body") next.groups[0]!.maxFleets = 1;
    else if (changed === "session") w.authenticate.mockResolvedValue({ kind: "directory", person: w.administrator, sessionId: "another-session" });
    else if (changed === "expired") w.time(120_001);
    else if (changed === "policy") w.policy.replace({ ...w.policy.read(), groups: next.groups }, w.administrator, w.action);
    else if (changed === "epoch") w.mutate(s => { s.revocationVersion++; });
    else if (changed === "ordinary") w.db.prepare("UPDATE hub_exposures SET display_name='Renamed'").run();
    else w.resolve.mockResolvedValue({ ok: true, group: { key: w.other, dn: next.groups[0]!.dn } });
    expect(await w.control.apply({ policy: next, previewDigest: preview.previewDigest }, w.ctx)).toMatchObject({ ok: false });
    expect(w.policy.read().state).toBe("never-enabled"); expect(w.db.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]); expect(w.refresh).not.toHaveBeenCalled();
  });
  it("a candidate is single-use and the outward impact cannot mutate its sealed server copy", async () => {
    const w = fixture(), next = w.proposal(), preview = await w.control.preview({ policy: next }, w.ctx);
    if (!preview.ok) throw Error("positive preview refused"); (preview.impact.grandfathered as unknown[]).length = 0;
    const request = { policy: next, previewDigest: preview.previewDigest };
    expect(await w.control.apply(request, w.ctx)).toMatchObject({ ok: true });
    expect(await w.control.apply(request, w.ctx)).toEqual({ ok: false, code: "stale-preview" }); expect(w.advance).toHaveBeenCalledOnce();
  });
  it.each(["epoch", "policy", "ordinary", "session", "close"] as const)("withholds a held apply after %s changes", async changed => {
    const w = fixture(), next = w.proposal(), preview = await w.control.preview({ policy: next }, w.ctx);
    if (!preview.ok) throw Error("positive preview refused"); const held = gate<PolicyGroupFacts>(), entered = gate<PersonKey>();
    w.read.mockImplementationOnce(person => { entered.resolve(person); return held.promise; });
    const pending = w.control.apply({ policy: next, previewDigest: preview.previewDigest }, w.ctx).then(value => ({ value }), error => ({ error }));
    const person = await entered.promise;
    if (changed === "epoch") w.mutate(s => { s.revocationVersion++; });
    else if (changed === "policy") w.policy.replace({ ...w.policy.read(), groups: next.groups }, w.administrator, w.action);
    else if (changed === "ordinary") w.db.prepare("UPDATE hub_exposures SET state='withdrawn'").run();
    else if (changed === "session") w.signOut(); else w.control.close();
    held.resolve({ kind: "complete", person, groups: [w.group.objectId], observedAt: 100 }); const result = await pending;
    expect(result).not.toMatchObject({ value: { ok: true } }); expect(w.policy.read().state).toBe("never-enabled");
    expect(w.db.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]); expect(w.refresh).not.toHaveBeenCalled();
  });
  it("refuses repair without constructing the strict mismatched store and refuses unsupported directories", async () => {
    const w = fixture(), next = w.proposal(); w.generation(); w.policyOf.mockClear(); w.policyOf.mockImplementation(() => { throw Error("strict repair store"); });
    expect(await w.control.preview({ policy: next }, w.ctx)).toEqual({ ok: false, code: "repair-required" }); expect(w.policyOf).not.toHaveBeenCalled();
    const v = fixture(); Object.assign(v.directory, { groupPolicy: undefined });
    expect(await v.control.preview({ policy: v.proposal() }, v.ctx)).toEqual({ ok: false, code: "unsupported" }); expect(v.resolve).not.toHaveBeenCalled();
  });
  it.each(["group-resource.manual-captured", "group-policy.changed", "group-policy.impact-checked"])("rolls back policy, provenance and evidence when required %s audit fails", async rejected => {
    const w = fixture(), next = w.proposal(), preview = await w.control.preview({ policy: next }, w.ctx);
    if (!preview.ok) throw Error("positive preview refused");
    w.append.mockImplementation((event, tx) => { if (event.action === rejected) throw Error("audit unavailable"); return w.audit.appendInTransaction(event, tx); });
    await expect(w.control.apply({ policy: next, previewDigest: preview.previewDigest }, w.ctx)).rejects.toThrow("audit unavailable");
    expect(w.policy.read().state).toBe("never-enabled"); expect(w.db.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]);
    expect(w.db.prepare("SELECT * FROM hub_group_events").all()).toEqual([]); expect(w.db.prepare("SELECT * FROM hub_group_resource_events").all()).toEqual([]);
    expect(w.advance).not.toHaveBeenCalled(); expect(w.refresh).not.toHaveBeenCalled(); expect(w.audit.verifyChain()).toMatchObject({ ok: true });
  });
  it("refuses a thenable required impact audit before publishing policy or refreshing sockets", async () => {
    const w = fixture(), next = w.proposal(), preview = await w.control.preview({ policy: next }, w.ctx);
    if (!preview.ok) throw Error("positive preview refused");
    w.append.mockImplementation((event, tx) => event.action === "group-policy.impact-checked" ? Promise.resolve() as never : w.audit.appendInTransaction(event, tx));
    expect(await w.control.apply({ policy: next, previewDigest: preview.previewDigest }, w.ctx)).toMatchObject({ ok: false });
    expect(w.policy.read().state).toBe("never-enabled"); expect(w.db.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]);
    expect(w.advance).not.toHaveBeenCalled(); expect(w.refresh).not.toHaveBeenCalled();
  });
  it.each(["ordinary", "lifecycle", "session", "closed"] as const)("rejects a reentrant %s change during the final required audit", async changed => {
    const w = fixture(), next = w.proposal(), preview = await w.control.preview({ policy: next }, w.ctx);
    if (!preview.ok) throw Error("positive preview refused");
    w.append.mockImplementation((event, tx) => {
      const recorded = w.audit.appendInTransaction(event, tx);
      if (event.action === "group-policy.impact-checked") {
        if (changed === "ordinary") w.db.prepare("UPDATE hub_exposures SET display_name='Replaced'").run();
        else if (changed === "lifecycle") w.db.prepare("UPDATE hub_group_resources SET state='suspended',revision=revision+1").run();
        else if (changed === "session") w.signOut(); else w.control.close();
      }
      return recorded;
    });
    const result = await w.control.apply({ policy: next, previewDigest: preview.previewDigest }, w.ctx).then(value => ({ value }), error => ({ error }));
    expect(result).not.toMatchObject({ value: { ok: true } }); expect(w.policy.read().state).toBe("never-enabled");
    expect(w.db.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]); expect(w.refresh).not.toHaveBeenCalled();
  });
  it.each(["no-advance", "double-advance", "throw"] as const)("publishes nothing if the required transport version writer has %s", async changed => {
    const w = fixture(), next = w.proposal(), preview = await w.control.preview({ policy: next }, w.ctx);
    if (!preview.ok) throw Error("positive preview refused");
    w.advance.mockImplementation(() => {
      if (changed === "double-advance") w.mutate(s => { s.revocationVersion += 2; });
      else if (changed === "throw") throw Error("version unavailable");
    });
    const result = await w.control.apply({ policy: next, previewDigest: preview.previewDigest }, w.ctx).then(value => ({ value }), error => ({ error }));
    expect(result).not.toMatchObject({ value: { ok: true } }); expect(w.policy.read().state).toBe("never-enabled");
    expect(w.db.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]); expect(w.refresh).not.toHaveBeenCalled();
  });
  it("switching off suspends only group rows, and switching back on cannot resume them", async () => {
    const w = fixture(); await w.enableGroup(); const next = { ...w.policy.read(), state: "suspended" as const };
    expect((await w.apply(next)).result).toMatchObject({ ok: true, state: "suspended" });
    expect(w.resources.read(w.fleetResource)).toMatchObject({ state: "suspended", revision: 2 });
    expect(w.resources.read(w.exposureResource)).toMatchObject({ state: "suspended", revision: 2 });
    expect((await w.apply(w.proposal())).result).toMatchObject({ ok: true, state: "enabled" });
    expect(w.resources.read(w.fleetResource)).toMatchObject({ state: "suspended", revision: 2 });
    expect(w.resources.read(w.exposureResource)).toMatchObject({ state: "suspended", revision: 2 });
  });
  it("a confirmed unchanged policy records fresh impact evidence without a revision bump or reconnect", async () => {
    const w = fixture(); expect((await w.apply()).result).toMatchObject({ ok: true, policyRevision: 2 });
    w.advance.mockClear(); w.refresh.mockClear();
    expect((await w.apply()).result).toMatchObject({ ok: true, policyRevision: 2 });
    expect(w.advance).not.toHaveBeenCalled(); expect(w.refresh).not.toHaveBeenCalled();
    expect(w.db.prepare("SELECT id FROM hub_audit WHERE action='group-policy.changed'").all()).toHaveLength(1);
    expect(w.db.prepare("SELECT id FROM hub_audit WHERE action='group-policy.impact-checked'").all()).toHaveLength(2);
  });
  it("refuses standalone batch suspension and a foreign confirmation actor before provenance writes", async () => {
    const w = fixture();
    expect(() => w.resources.captureManual(w.fleetResource, w.action, { ...w.administrator, realm: "other" })).toThrow("group_policy_invalid");
    expect(w.resources.read(w.fleetResource)).toBeNull(); await w.enableGroup();
    expect(() => w.resources.suspend(w.fleetResource, w.administrator, w.action)).toThrow("group_policy_invalid");
    expect(w.resources.read(w.fleetResource)).toMatchObject({ state: "active", revision: 1 });
  });
});

describe("ordinary impact inventory", () => {
  it.each(["revoked-fleet", "withdrawn", "frozen", "replaced-revision"] as const)("does not grandfather %s resources", async changed => {
    const w = fixture();
    if (changed === "revoked-fleet") w.mutate(s => { s.fleets[0]!.status = "revoked"; s.fleets[0]!.credentialHash = null; });
    else if (changed === "withdrawn") w.db.prepare("UPDATE hub_exposures SET state='withdrawn'").run();
    else if (changed === "frozen") w.db.prepare("UPDATE hub_exposures SET frozen_through=revision").run();
    else {
      await w.enableGroup(); w.db.prepare("UPDATE hub_exposures SET revision=2").run();
    }
    const snapshot = w.impactInventory.snapshot();
    expect(snapshot.resources.some(r => r.resource.kind === "exposure" && r.resource.revision === 1)).toBe(false);
    if (changed === "revoked-fleet") expect(snapshot.resources).toEqual([]);
    if (changed === "replaced-revision") expect(snapshot.resources.find(r => r.resource.kind === "exposure")).toMatchObject({ resource: { revision: 2 }, lifecycle: null });
  });
  it("ignores eligibility-cache timestamps but fingerprints labels, ordinary material and lifecycle independently", async () => {
    const w = fixture(); await w.enableGroup(); const before = w.impactInventory.snapshot();
    w.db.prepare("UPDATE hub_people SET last_checked_at=999,status='unknown'").run();
    expect(w.impactInventory.snapshot().fingerprint).toBe(before.fingerprint);
    w.db.prepare("UPDATE hub_group_resources SET state='suspended',revision=revision+1").run();
    const paused = w.impactInventory.snapshot(); expect(paused.ordinaryFingerprint).toBe(before.ordinaryFingerprint); expect(paused.fingerprint).not.toBe(before.fingerprint);
    w.db.prepare("UPDATE hub_people SET display_name='New display' WHERE person=?").run(personKeyString(w.owner));
    expect(w.impactInventory.snapshot().ordinaryFingerprint).not.toBe(before.ordinaryFingerprint);
  });
  it("refuses mismatched ordinary and lifecycle owners instead of retargeting a saved manual revision", async () => {
    const w = fixture(); await w.enableGroup();
    const raw = w.db.prepare("SELECT resource_key,body FROM hub_group_resources WHERE body LIKE '%exposure%'").get() as { resource_key: string; body: string };
    w.db.prepare("UPDATE hub_group_resources SET body=? WHERE resource_key=?").run(JSON.stringify({ ...JSON.parse(raw.body), owner: w.asker }), raw.resource_key);
    expect(() => w.impactInventory.snapshot()).toThrow("group_policy_unavailable");
  });
  it.each(["current", "expired", "revoked", "stale-revision", "wrong-owner", "without-ask"] as const)("reports only %s grants as Chat impact, without creating a person", async changed => {
    const w = fixture(), subject = key(), owner = personKeyString(w.owner), id = randomUUID();
    w.db.prepare("INSERT INTO hub_grants VALUES(?,1,?,?,?, ?,100,?,?,0,?,?)")
      .run(id, changed === "wrong-owner" ? personKeyString(w.administrator) : owner, w.exposureId, changed === "stale-revision" ? 2 : 1,
        owner, personKeyString(subject), JSON.stringify(changed === "without-ask" ? ["read-own-room"] : ["ask", "read-own-room"]), changed === "expired" ? 100 : 200, changed === "revoked" ? "revoked" : "active");
    const snapshot = w.impactInventory.snapshot(), row = snapshot.people.find(p => personKeyString(p.key) === personKeyString(subject));
    if (changed === "current") expect(row).toMatchObject({ name: null, login: null, hasAskGrant: true });
    else expect(row).toBeUndefined();
    expect(w.db.prepare("SELECT * FROM hub_people WHERE person=?").get(personKeyString(subject))).toBeUndefined();
  });
});
