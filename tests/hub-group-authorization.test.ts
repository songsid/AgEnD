/** Action permit/lifecycle/transport transactions on one real scratch SQLite DB; all identities and facts inert. */
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { applyHubMigrations } from "../src/hub/db.js";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import { HUB_TRANSPORT_MIGRATION, HubTransportStore } from "../src/hub/store.js";
import { createHubGroupPolicyStore, groupPolicyMigration, inspectHubGroupPolicyBinding } from "../src/hub/group-policy/store.js";
import { createHubGroupResources, HUB_GROUP_RESOURCES_MIGRATION, type HubGroupResource } from "../src/hub/group-policy/resources.js";
import { createHubGroupAuthorization } from "../src/hub/group-policy/authorization.js";
import type { HubActor, HubDirectory } from "../src/hub/types.js";
import type { PolicyGroupFacts } from "../src/hub/directory/groups.js";
const owner = { realm: "example", objectId: "11111111-1111-4111-8111-111111111111" };
const group = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const resource: HubGroupResource = { kind: "exposure", id: "representative-1", revision: 3, owner };
const databases: Database.Database[] = [];
afterEach(() => { vi.restoreAllMocks(); databases.splice(0).forEach(db => db.close()); });
function fixture() {
  const db = new Database(":memory:"); databases.push(db); db.pragma("foreign_keys=ON");
  applyHubMigrations(db, [HUB_AUDIT_MIGRATION, HUB_TRANSPORT_MIGRATION, groupPolicyMigration("hub-1", "example", "generation-1"), HUB_GROUP_RESOURCES_MIGRATION]);
  const audit = createHubAudit({ db, contentKey: randomBytes(32), now: () => 100 });
  const append = vi.fn((...args: Parameters<typeof audit.appendInTransaction>) => audit.appendInTransaction(...args));
  let live = true, selectedGeneration = "generation-1", floor = 0;
  const current = () => live, ctx = { requestId: "request-1", current: () => true };
  const read = vi.fn(async (): Promise<PolicyGroupFacts> => ({ kind: "complete", person: { ...owner }, groups: [group], observedAt: 100 }));
  const directory = { realm: "example", groupPolicy: "ad-direct-guid", readPolicyGroups: read } as unknown as HubDirectory;
  const policy = createHubGroupPolicyStore({ db, hubId: "hub-1", realm: "example", generation: "generation-1", directory,
    audit: { appendInTransaction: append }, current, now: () => 100 });
  const transport = new HubTransportStore(db, { floor: { read: () => floor, raise: n => { floor = n; } },
    appendAudit: (event, tx) => { audit.appendInTransaction(event, tx); } }); transport.initialize();
  const resources = createHubGroupResources({ db, policy, audit: { appendInTransaction: append }, current, now: () => 100 });
  const policyOf = vi.fn(() => policy), version = vi.fn(() => transport.read().revocationVersion);
  const advance = vi.fn((tx: Database.Database, _r: HubGroupResource) => {
    expect(tx).toBe(db); expect(tx.inTransaction).toBe(true);
    transport.mutate({ at: 100, requestId: randomUUID(), actor: { kind: "person", person: owner }, action: "group-resource.version", result: "completed" }, state => { state.revocationVersion++; });
  });
  const refresh = vi.fn(() => { expect(db.inTransaction).toBe(false); expect(transport.read().revocationVersion).toBeGreaterThan(0); });
  const options = { db, administrator: { ...owner }, policy: policyOf,
    binding: () => inspectHubGroupPolicyBinding(db, "hub-1", "example", selectedGeneration), audit: { appendInTransaction: append },
    current, version, advanceAuthorization: advance, refreshAuthorization: refresh, now: () => 100 };
  const actions = createHubGroupAuthorization(options);
  const enable = () => policy.replace({ ...policy.read(), state: "enabled", groups: [{ group: { realm: "example", objectId: group },
    dn: "CN=Members,DC=example,DC=test", allow: ["ask_agents", "publish_agents", "pair_fleet"], maxFleets: 1 }] }, owner, ctx);
  const negative = () => read.mockResolvedValueOnce({ kind: "complete", person: owner, groups: [other], observedAt: 100 });
  const admin = vi.fn(async (): Promise<HubActor> => ({ kind: "directory", person: { ...owner }, sessionId: "session-1" }));
  const resumeCtx = { ...ctx, requireAdmin: admin };
  return { db, policy, resources, transport, audit, append, read, ctx, enable, negative, actions, options, advance, refresh, version, policyOf, admin, resumeCtx,
    stop: () => { live = false; }, generation: (value: string) => { selectedGeneration = value; } };
}
function held<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const auditCount = (db: Database.Database) => (db.prepare("SELECT COUNT(*) n FROM hub_audit").get() as { n: number }).n;

describe("recheckable Hub group action permits (not yet composed into HTTP)", () => {
  it("never-enabled stays legacy without a lookup/ledger write, and enabling invalidates its old permit", async () => {
    const f = fixture(), permit = await f.actions.enroll(resource, f.ctx);
    expect(permit.source).toBe("legacy"); expect(() => permit.assertCurrent()).not.toThrow();
    expect(f.read).not.toHaveBeenCalled(); expect(auditCount(f.db)).toBe(0); expect(f.resources.read(resource)).toBeNull();
    f.enable(); expect(() => permit.assertCurrent()).toThrow("group_policy_conflict");
  });
  it("preserves only intact same-realm never-enabled repair legacy, without constructing its strict store", async () => {
    const f = fixture(); f.generation("generation-2"); f.policyOf.mockImplementation(() => { throw Error("strict store must not be touched"); });
    const permit = await f.actions.check(resource, f.ctx); expect(permit.source).toBe("legacy"); permit.assertCurrent();
    expect(f.policyOf).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
    f.db.prepare("UPDATE hub_group_policy SET hub_id='other'").run();
    expect(() => permit.assertCurrent()).toThrow("group_policy_conflict");
    await expect(f.actions.check(resource, f.ctx)).rejects.toMatchObject({ reason: "repair-required" });
  });
  it.each(["selected-generation", "stored-generation", "stored-revision"])("fences a repair permit when its %s changes, without reading the strict store", async changed => {
    const f = fixture(); f.generation("generation-2");
    f.policyOf.mockImplementation(() => { throw Error("strict store must not be touched"); });
    const permit = await f.actions.check(resource, f.ctx); permit.assertCurrent(); permit.assertCurrent();
    if (changed === "selected-generation") f.generation("generation-3");
    else {
      const before = f.policy.read();
      f.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify({ ...before,
        ...(changed === "stored-generation" ? { generation: "generation-3" } : { revision: before.revision + 1 }) }));
    }
    expect(() => permit.assertCurrent()).toThrow("group_policy_conflict");
    (await f.actions.check(resource, f.ctx)).assertCurrent();
    expect(f.policyOf).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(auditCount(f.db)).toBe(0);
  });
  it.each([undefined, 123, "not-a-digest", "A".repeat(64)])("refuses an unvalidated repair fingerprint (%s)", async fingerprint => {
    const f = fixture();
    const actions = createHubGroupAuthorization({ ...f.options,
      binding: () => ({ kind: "repair-required", legacy: true, fingerprint }) as unknown as ReturnType<typeof inspectHubGroupPolicyBinding> });
    await expect(actions.check(resource, f.ctx)).rejects.toMatchObject({ reason: "repair-required" });
    expect(f.policyOf).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });
  it("captures the repair fingerprint value instead of retaining a mutable probe result", async () => {
    const f = fixture(); f.generation("generation-2"); const original = f.options.binding();
    if (original.kind !== "repair-required" || !original.legacy) throw Error("expected intact repair fixture");
    const binding = { ...original }, actions = createHubGroupAuthorization({ ...f.options, binding: () => binding });
    const permit = await actions.check(resource, f.ctx); permit.assertCurrent();
    binding.fingerprint = "f".repeat(64); expect(() => permit.assertCurrent()).toThrow("group_policy_conflict");
    expect(f.policyOf).not.toHaveBeenCalled();
  });
  it.each(["enabled", "suspended"])("refuses a generation mismatch for a previously %s policy", async state => {
    const f = fixture(); f.enable();
    if (state === "suspended") f.policy.replace({ ...f.policy.read(), state }, owner, f.ctx);
    f.generation("generation-2"); await expect(f.actions.check(resource, f.ctx)).rejects.toMatchObject({ reason: "repair-required" });
    expect(f.read).not.toHaveBeenCalled();
  });
  it.each(["fleet", "exposure", "asker"] as const)("requires enrollment and fresh audit for every %s check without creating the underlying resource", async kind => {
    const f = fixture(), r = { ...resource, kind, ...(kind === "asker" ? { id: owner.objectId, revision: 1 } : {}) }; f.enable();
    await expect(f.actions.check(r, f.ctx)).rejects.toThrow("group_policy_invalid");
    expect((await f.actions.enroll(r, f.ctx)).source).toBe("group");
    const p = await f.actions.check(r, f.ctx); p.assertCurrent(); expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('hub_exposures','hub_grants','hub_rooms')").all()).toEqual([]);
    expect(f.audit.verifyChain()).toMatchObject({ ok: true }); expect(f.advance).not.toHaveBeenCalled(); expect(f.refresh).not.toHaveBeenCalled();
  });
  it("fences permits on policy, transport version, exact row, replacement store and caller changes", async () => {
    for (const changed of ["policy", "version", "row", "state", "source", "provider", "caller"] as const) {
      const f = fixture(); f.enable(); let caller = true;
      const p = await f.actions.enroll(resource, { ...f.ctx, current: () => caller });
      if (changed === "policy") f.policy.replace({ ...f.policy.read(), groups: [] }, owner, f.ctx);
      if (changed === "version") f.db.transaction(() => f.advance(f.db, resource))();
      if (changed === "row") f.db.prepare("UPDATE hub_group_resources SET revision=revision+1").run();
      if (changed === "state") f.db.prepare("UPDATE hub_group_resources SET state='suspended'").run();
      if (changed === "source") f.db.prepare("UPDATE hub_group_resources SET source='manual'").run();
      if (changed === "provider") f.policyOf.mockReturnValue({ ...f.policy });
      if (changed === "caller") caller = false;
      expect(() => p.assertCurrent(), changed).toThrow();
    }
  });
  it("unknown denies this operation without lifecycle/version changes or refresh, then recovers automatically", async () => {
    const f = fixture(); f.enable(); await f.actions.enroll(resource, f.ctx); const before = f.resources.read(resource);
    f.read.mockResolvedValueOnce({ kind: "unknown" }); await expect(f.actions.check(resource, f.ctx)).rejects.toMatchObject({ reason: "held" });
    expect(f.resources.read(resource)).toEqual(before); expect(f.transport.read().revocationVersion).toBe(0);
    expect(f.advance).not.toHaveBeenCalled(); expect(f.refresh).not.toHaveBeenCalled(); (await f.actions.check(resource, f.ctx)).assertCurrent();
  });
  it("commits complete-negative suspension and version together, then refreshes outside SQL; only authenticated admin resume revives it", async () => {
    const f = fixture(); f.enable(); const old = await f.actions.enroll(resource, f.ctx);
    f.negative(); await expect(f.actions.check(resource, f.ctx)).rejects.toMatchObject({ reason: "denied" });
    expect(f.resources.read(resource)).toMatchObject({ state: "suspended", revision: 2 }); expect(f.transport.read().revocationVersion).toBe(1);
    expect(f.advance).toHaveBeenCalledTimes(1); expect(f.refresh).toHaveBeenCalledTimes(1); expect(() => old.assertCurrent()).toThrow();
    await expect(f.actions.check(resource, f.ctx)).rejects.toMatchObject({ reason: "resume-required" });
    f.admin.mockResolvedValueOnce({ kind: "directory", person: { ...owner, objectId: other }, sessionId: "wrong" });
    await expect(f.actions.resume(resource, f.resumeCtx)).rejects.toMatchObject({ reason: "denied" });
    const resumed = await f.actions.resume(resource, f.resumeCtx); resumed.assertCurrent();
    expect(f.resources.read(resource)).toMatchObject({ state: "active", revision: 3 }); expect(f.transport.read().revocationVersion).toBe(2);
    expect(f.advance).toHaveBeenCalledTimes(2); expect(f.refresh).toHaveBeenCalledTimes(2); expect(f.audit.verifyChain()).toMatchObject({ ok: true });
  });
  it("commits a negative when its own version advance fences the old member link", async () => {
    const f = fixture(); f.enable(); await f.actions.enroll(resource, f.ctx);
    f.negative(); await expect(f.actions.check(resource, { ...f.ctx, current: () => f.transport.read().revocationVersion === 0 })).rejects.toMatchObject({ reason: "denied" });
    expect(f.resources.read(resource)).toMatchObject({ state: "suspended" }); expect(f.refresh).toHaveBeenCalledOnce();
  });
  it.each([false, true])("held resume membership cannot absorb an unrelated epoch advance (advance=%s)", async changed => {
    const f = fixture(); f.enable(); await f.actions.enroll(resource, f.ctx);
    f.negative(); await expect(f.actions.check(resource, f.ctx)).rejects.toThrow();
    const gate = held<PolicyGroupFacts>(), entered = held<void>();
    f.read.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
    const pending = f.actions.resume(resource, f.resumeCtx);
    const settled = pending.then(permit => ({ permit }), error => ({ error }));
    await entered.promise;
    if (changed) f.db.transaction(() => f.advance(f.db, { ...resource, id: "unrelated-resource" })).immediate();
    const advances = f.advance.mock.calls.length, refreshes = f.refresh.mock.calls.length;
    gate.resolve({ kind: "complete", person: owner, groups: [group], observedAt: 100 });
    const result = await settled;
    if (changed) {
      expect(result).toMatchObject({ error: { message: "group_policy_conflict" } });
      expect(f.resources.read(resource)).toMatchObject({ state: "suspended", revision: 2 });
      expect(f.advance).toHaveBeenCalledTimes(advances); expect(f.refresh).toHaveBeenCalledTimes(refreshes);
      expect(f.db.prepare("SELECT id FROM hub_audit WHERE action='group-resource.resumed'").all()).toEqual([]);
    } else {
      expect(result).toHaveProperty("permit"); if ("permit" in result) result.permit.assertCurrent();
      expect(f.resources.read(resource)).toMatchObject({ state: "active", revision: 3 });
      expect(f.advance).toHaveBeenCalledTimes(advances + 1); expect(f.refresh).toHaveBeenCalledTimes(refreshes + 1);
    }
    expect(f.transport.read().revocationVersion).toBe(2); expect(f.audit.verifyChain()).toMatchObject({ ok: true });
  });
  it("rolls back resume if its audit reentrantly advances the captured epoch, without refreshing", async () => {
    const f = fixture(); f.enable(); await f.actions.enroll(resource, f.ctx);
    f.negative(); await expect(f.actions.check(resource, f.ctx)).rejects.toThrow();
    f.append.mockImplementation((...args) => {
      f.audit.appendInTransaction(...args);
      if (args[0].action === "group-resource.resumed") f.advance(f.db, { ...resource, id: "unrelated-resource" });
    });
    await expect(f.actions.resume(resource, f.resumeCtx)).rejects.toThrow("group_policy_conflict");
    expect(f.resources.read(resource)).toMatchObject({ state: "suspended", revision: 2 }); expect(f.refresh).toHaveBeenCalledTimes(1);
    const body = (f.db.prepare("SELECT state FROM hub_transport_state").get() as { state: string }).state;
    expect(JSON.parse(body).revocationVersion).toBe(1);
    expect(() => f.transport.read()).toThrow("uncertain"); // A rolled-back floor advance never restores an old permit.
  });
  it("grandfathering is exact and membership-exempt, but person denial still suspends and removing it requires explicit resume", async () => {
    const f = fixture(); f.resources.captureManual(resource, f.ctx); f.enable(); f.policy.replace({ ...f.policy.read(), groups: [] }, owner, f.ctx);
    const p = await f.actions.check(resource, f.ctx); p.assertCurrent(); expect(p.source).toBe("manual"); expect(f.read).not.toHaveBeenCalled();
    await expect(f.actions.check({ ...resource, revision: 4 }, f.ctx)).rejects.toThrow("group_policy_invalid");
    f.policy.replace({ ...f.policy.read(), denies: [{ person: owner, deny: ["publish_agents"] }] }, owner, f.ctx);
    await expect(f.actions.check(resource, f.ctx)).rejects.toMatchObject({ reason: "denied" });
    f.policy.replace({ ...f.policy.read(), denies: [] }, owner, f.ctx);
    await expect(f.actions.check(resource, f.ctx)).rejects.toMatchObject({ reason: "resume-required" });
    expect((await f.actions.resume(resource, f.resumeCtx)).source).toBe("manual"); expect(f.read).not.toHaveBeenCalled();
  });
  it.each(["close", "caller", "server", "policy", "version"] as const)("withholds a held check after %s and does not hand out a late permit", async changed => {
    const f = fixture(); f.enable(); await f.actions.enroll(resource, f.ctx);
    const gate = held<PolicyGroupFacts>(); f.read.mockImplementationOnce(() => gate.promise); let caller = true;
    const pending = f.actions.check(resource, { ...f.ctx, current: () => caller }), refused = expect(pending).rejects.toThrow();
    if (changed === "close") f.actions.close();
    if (changed === "caller") caller = false;
    if (changed === "server") f.stop();
    if (changed === "policy") f.policy.replace({ ...f.policy.read(), groups: [] }, owner, f.ctx);
    if (changed === "version") f.db.transaction(() => f.advance(f.db, resource))();
    const before = auditCount(f.db); gate.resolve({ kind: "complete", person: owner, groups: [group], observedAt: 100 });
    await refused;
    if (["close", "caller", "server"].includes(changed)) expect(auditCount(f.db)).toBe(before);
    expect(f.refresh).not.toHaveBeenCalled();
  });
  it("snapshots resource inputs and the administrator callback before awaits", async () => {
    const f = fixture(); f.enable(); await f.actions.enroll(resource, f.ctx);
    const gate = held<PolicyGroupFacts>(); f.read.mockImplementationOnce(() => gate.promise);
    const input = structuredClone(resource), pending = f.actions.check(input, f.ctx); input.owner.objectId = other; input.id = "changed"; input.revision = 99;
    gate.resolve({ kind: "complete", person: owner, groups: [group], observedAt: 100 }); (await pending).assertCurrent();
    expect(f.resources.read(resource)).toMatchObject({ resource, state: "active" });
    f.negative(); await expect(f.actions.check(resource, f.ctx)).rejects.toThrow();
    const authGate = held<HubActor>(), ctx = { ...f.ctx, requireAdmin: () => authGate.promise };
    const resume = f.actions.resume(resource, ctx); ctx.requireAdmin = async () => ({ kind: "directory", person: { ...owner, objectId: other }, sessionId: "wrong" });
    authGate.resolve({ kind: "directory", person: owner, sessionId: "original" }); (await resume).assertCurrent();
  });
  it.each(["throw", "thenable"])("failed %s lifecycle audit rolls back and never advances/refreshes", async mode => {
    const f = fixture(); f.enable(); await f.actions.enroll(resource, f.ctx);
    f.append.mockImplementation((...args) => {
      f.audit.appendInTransaction(...args);
      if (args[0].action === "group-resource.suspended") { if (mode === "throw") throw Error("fake audit failure"); return Promise.resolve() as never; }
    });
    f.negative(); await expect(f.actions.check(resource, f.ctx)).rejects.toThrow();
    expect(f.resources.read(resource)).toMatchObject({ state: "active", revision: 1 }); expect(f.advance).not.toHaveBeenCalled(); expect(f.refresh).not.toHaveBeenCalled();
    expect(f.transport.read().revocationVersion).toBe(0);
  });
  it.each(["missing", "thenable", "throw"])("refuses a %s transport advance; no lifecycle change or refresh is published", async mode => {
    const f = fixture(); f.enable(); await f.actions.enroll(resource, f.ctx);
    if (mode === "missing") f.advance.mockImplementation(() => {});
    if (mode === "thenable") f.advance.mockImplementation(() => Promise.resolve() as never);
    if (mode === "throw") f.advance.mockImplementation(() => { throw Error("fake transport failure"); });
    f.negative(); await expect(f.actions.check(resource, f.ctx)).rejects.toThrow();
    expect(f.resources.read(resource)).toMatchObject({ state: "active", revision: 1 }); expect(f.transport.read().revocationVersion).toBe(0);
    expect(f.refresh).not.toHaveBeenCalled();
  });
  it("never treats a local-host actor as the configured authenticated directory administrator", async () => {
    const f = fixture(); f.enable(); await f.actions.enroll(resource, f.ctx); f.negative(); await expect(f.actions.check(resource, f.ctx)).rejects.toThrow();
    f.admin.mockResolvedValueOnce({ kind: "local-host", sessionId: "host", directoryBinding: owner });
    await expect(f.actions.resume(resource, f.resumeCtx)).rejects.toMatchObject({ reason: "denied" });
    expect(f.resources.read(resource)).toMatchObject({ state: "suspended" }); expect(f.transport.read().revocationVersion).toBe(1);
  });
  it("rejects an outer transaction, non-integral version, closed service and an invalidated old permit", async () => {
    const f = fixture(); f.enable(); const permit = await f.actions.enroll(resource, f.ctx);
    let pending!: ReturnType<typeof f.actions.check>; f.db.transaction(() => { pending = f.actions.check(resource, f.ctx); })(); await expect(pending).rejects.toThrow("group_policy_invalid");
    f.version.mockReturnValueOnce(NaN); await expect(f.actions.check(resource, f.ctx)).rejects.toThrow("group_policy_unavailable");
    f.actions.close(); expect(() => permit.assertCurrent()).toThrow("group_policy_unavailable");
    await expect(f.actions.check(resource, f.ctx)).rejects.toThrow("group_policy_unavailable");
  });
  it.each(["close", "caller", "policy", "version"] as const)("rechecks a held administrator resume after %s", async changed => {
    const f = fixture(); f.enable(); await f.actions.enroll(resource, f.ctx); f.negative(); await expect(f.actions.check(resource, f.ctx)).rejects.toThrow();
    const gate = held<HubActor>(); let caller = true;
    const pending = f.actions.resume(resource, { ...f.ctx, current: () => caller, requireAdmin: () => gate.promise }), refused = expect(pending).rejects.toThrow();
    if (changed === "close") f.actions.close();
    if (changed === "caller") caller = false;
    if (changed === "policy") f.policy.replace({ ...f.policy.read(), groups: [] }, owner, f.ctx);
    if (changed === "version") f.db.transaction(() => f.advance(f.db, resource))();
    const refreshCount = f.refresh.mock.calls.length;
    gate.resolve({ kind: "directory", person: owner, sessionId: "old-auth" }); await refused;
    expect(f.resources.read(resource)).toMatchObject({ state: "suspended", revision: 2 }); expect(f.refresh).toHaveBeenCalledTimes(refreshCount);
  });
  it("an async advance that already wrote still rolls SQL back and withholds refresh; the monotonic floor remains fail-closed", async () => {
    const f = fixture(); f.enable(); await f.actions.enroll(resource, f.ctx);
    const advance = f.advance.getMockImplementation()!;
    f.advance.mockImplementation((...args) => { advance(...args); return Promise.resolve() as never; });
    f.negative(); await expect(f.actions.check(resource, f.ctx)).rejects.toThrow("group_policy_audit");
    expect(f.resources.read(resource)).toMatchObject({ state: "active", revision: 1 }); expect(f.refresh).not.toHaveBeenCalled();
    expect(() => f.transport.read()).toThrow("uncertain");
    const body = (f.db.prepare("SELECT state FROM hub_transport_state").get() as { state: string }).state;
    expect(JSON.parse(body).revocationVersion).toBe(0);
  });
  it("rejects a thenable refresh after commit without handing out a permit or undoing the suspension", async () => {
    const f = fixture(); f.enable(); await f.actions.enroll(resource, f.ctx); f.refresh.mockImplementation(() => Promise.resolve() as never);
    f.negative(); await expect(f.actions.check(resource, f.ctx)).rejects.toThrow("group_policy_audit");
    expect(f.resources.read(resource)).toMatchObject({ state: "suspended", revision: 2 }); expect(f.transport.read().revocationVersion).toBe(1);
  });
  it("keeps a suspension when a resuming administrator's session is revoked during the version audit", async () => {
    const f = fixture(); f.enable(); await f.actions.enroll(resource, f.ctx); f.negative(); await expect(f.actions.check(resource, f.ctx)).rejects.toThrow();
    let caller = true; const advance = f.advance.getMockImplementation()!;
    f.advance.mockImplementation((...args) => { advance(...args); caller = false; });
    await expect(f.actions.resume(resource, { ...f.resumeCtx, current: () => caller })).rejects.toThrow();
    expect(f.resources.read(resource)).toMatchObject({ state: "suspended", revision: 2 }); expect(f.refresh).toHaveBeenCalledTimes(1);
  });
  it("rolls back a lifecycle result if its required version writer changes policy reentrantly", async () => {
    const f = fixture(); f.enable(); await f.actions.enroll(resource, f.ctx); const before = f.policy.read();
    const advance = f.advance.getMockImplementation()!;
    f.advance.mockImplementation((...args) => { advance(...args); f.policy.replace({ ...f.policy.read(), groups: [] }, owner, f.ctx); });
    f.negative(); await expect(f.actions.check(resource, f.ctx)).rejects.toThrow("group_policy_conflict");
    expect(f.resources.read(resource)).toMatchObject({ state: "active", revision: 1 }); expect(f.policy.read()).toEqual(before); expect(f.refresh).not.toHaveBeenCalled();
  });
  it("refuses an async direct lifecycle invalidator in the same transaction", async () => {
    const f = fixture(); f.enable(); await f.actions.enroll(resource, f.ctx);
    const resources = createHubGroupResources({ db: f.db, policy: f.policy, audit: f.audit, current: () => true, now: () => 100, invalidate: async () => {} });
    f.negative(); await expect(resources.check(resource, f.ctx)).rejects.toThrow("group_policy_audit");
    expect(f.resources.read(resource)).toMatchObject({ state: "active", revision: 1 });
  });

  it.each(["never-enabled", "repair", "enabled"])("refuses a foreign-realm resource even on the %s path", async mode => {
    const f = fixture();
    if (mode === "enabled") f.enable();
    if (mode === "repair") f.generation("generation-2");
    const foreign = { ...resource, owner: { ...owner, realm: "other" } };
    await expect(f.actions.check(foreign, f.ctx)).rejects.toMatchObject({ reason: "denied" });
    await expect(f.actions.enroll(foreign, f.ctx)).rejects.toMatchObject({ reason: "denied" });
    expect(f.read).not.toHaveBeenCalled();
  });
  it("does not preserve legacy for corrupt state or a repair that becomes ready after the permit", async () => {
    const f = fixture(); f.generation("generation-2"); const old = await f.actions.check(resource, f.ctx);
    f.generation("generation-1"); expect(() => old.assertCurrent()).toThrow("group_policy_conflict");
    f.db.prepare("UPDATE hub_group_policy SET body='{}'").run();
    await expect(f.actions.check(resource, f.ctx)).rejects.toMatchObject({ reason: "repair-required" });
  });

  it("binds allowance audit to the validated exact resource revision rather than caller-supplied identifiers", async () => {
    const f = fixture(); f.enable();
    await f.actions.enroll(resource, { ...f.ctx, resource: { exposureId: "spoofed", revision: 99, messageId: "message-1" } });
    const records = f.db.prepare("SELECT e.body, a.exposure_id FROM hub_group_events e JOIN hub_audit a ON a.id=e.id WHERE a.action='group-policy.publish-agents'").all() as { body: string; exposure_id: string }[];
    expect(records).toHaveLength(1); expect(records[0]!.exposure_id).toBe(resource.id);
    expect(JSON.parse(records[0]!.body)).toMatchObject({ exposureId: resource.id, revision: resource.revision, messageId: "message-1",
      payload: { person: owner, capability: "publish_agents", groups: [group] } });
  });
  it("uses one immutable asker resource, so a new id/revision cannot evade explicit resume", async () => {
    const f = fixture(); f.enable(); const asker = { kind: "asker" as const, id: owner.objectId, revision: 1, owner };
    await f.actions.enroll(asker, f.ctx); f.negative(); await expect(f.actions.check(asker, f.ctx)).rejects.toMatchObject({ reason: "denied" });
    await expect(f.actions.enroll({ ...asker, id: "new-session" }, f.ctx)).rejects.toThrow("group_policy_invalid");
    await expect(f.actions.enroll({ ...asker, revision: 2 }, f.ctx)).rejects.toThrow("group_policy_invalid");
    await expect(f.actions.check(asker, f.ctx)).rejects.toMatchObject({ reason: "resume-required" });
  });

  it("snapshots configured administrator identity instead of accepting a later replacement in the options object", async () => {
    const f = fixture(); f.options.administrator.objectId = other;
    f.enable(); await f.actions.enroll(resource, f.ctx); f.negative(); await expect(f.actions.check(resource, f.ctx)).rejects.toThrow();
    f.admin.mockResolvedValueOnce({ kind: "directory", person: { ...owner, objectId: other }, sessionId: "replacement" });
    await expect(f.actions.resume(resource, f.resumeCtx)).rejects.toMatchObject({ reason: "denied" });
    (await f.actions.resume(resource, f.resumeCtx)).assertCurrent();
  });
  it("does not accept a caller swapping its guard to true while the original caller is revoked", async () => {
    const f = fixture(); f.enable(); await f.actions.enroll(resource, f.ctx); let caller = true;
    const ctx = { ...f.ctx, current: () => caller }, gate = held<PolicyGroupFacts>(); f.read.mockImplementationOnce(() => gate.promise);
    const pending = f.actions.check(resource, ctx), refused = expect(pending).rejects.toThrow();
    caller = false; ctx.current = () => true;
    gate.resolve({ kind: "complete", person: owner, groups: [group], observedAt: 100 }); await refused;
  });
  it("keeps audit context captured before a held administrator authentication", async () => {
    const f = fixture(); f.enable(); await f.actions.enroll(resource, f.ctx); f.negative(); await expect(f.actions.check(resource, f.ctx)).rejects.toThrow();
    const gate = held<HubActor>(), ctx = { ...f.ctx, resource: { messageId: "original-message" }, requireAdmin: () => gate.promise };
    const pending = f.actions.resume(resource, ctx); ctx.resource.messageId = "replacement-message"; ctx.requestId = "replacement-request";
    gate.resolve({ kind: "directory", person: owner, sessionId: "original-session" }); (await pending).assertCurrent();
    const last = f.db.prepare("SELECT a.request_id, e.body FROM hub_group_events e JOIN hub_audit a ON a.id=e.id WHERE a.action='group-policy.publish-agents' ORDER BY e.rowid DESC LIMIT 1").get() as { request_id: string; body: string };
    expect(last.request_id).toBe("request-1"); expect(JSON.parse(last.body)).toMatchObject({ messageId: "original-message", exposureId: resource.id, revision: resource.revision });
  });

});
