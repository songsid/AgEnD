/** Real policy/registration/SQLite and audit; inert membership/eligibility only. */
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import { createHubGroupPolicyStore, groupPolicyMigration, inspectHubGroupPolicyBinding } from "../src/hub/group-policy/store.js";
import { createHubGroupResources, HUB_GROUP_RESOURCES_MIGRATION } from "../src/hub/group-policy/resources.js";
import { createHubGroupAuthorization } from "../src/hub/group-policy/authorization.js";
import type { HubDirectory } from "../src/hub/directory/types.js";
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.restoreAllMocks(); });
function rig() {
  const db = new Database(":memory:"); databases.push(db);
  for (const m of [HUB_AUDIT_MIGRATION, groupPolicyMigration("owned-hub", "corp", "g1"), HUB_GROUP_RESOURCES_MIGRATION]) m.up(db);
  const admin = { realm: "corp", objectId: randomUUID() }, owner = { realm: "corp", objectId: randomUUID() }, group = { realm: "corp", objectId: randomUUID() };
  const audit = createHubAudit({ db, contentKey: randomBytes(32) }), state = { caller: true, epoch: 0, live: true, binding: true };
  const current = () => state.live, ctx = { requestId: randomUUID(), current: () => state.caller }, now = () => 100;
  const read = vi.fn(async (person: typeof owner): Promise<any> => ({ kind: "complete", person, groups: [group.objectId], observedAt: 100 }));
  const directory = { realm: "corp", groupPolicy: "ad-direct-guid", readPolicyGroups: read, checkEligibility: vi.fn(async () => ({ eligible: true, person: { key: owner } })) } as unknown as HubDirectory;
  const policy = createHubGroupPolicyStore({ db, hubId: "owned-hub", realm: "corp", generation: "g1", directory, audit, current, now });
  const advance = vi.fn(() => { state.epoch++; });
  const actions = createHubGroupAuthorization({ db, administrator: admin, directory, policy: () => policy, binding: () => state.binding ? inspectHubGroupPolicyBinding(db, "owned-hub", "corp", "g1") : { kind: "repair-required", legacy: false },
    audit, current, version: () => state.epoch, advanceAuthorization: advance, refreshAuthorization: () => {}, now });
  const resource = { kind: "fleet" as const, id: randomUUID(), revision: 1, owner }, grant = { codeId: randomUUID(), approvedBy: admin, scope: { kind: "directory" as const }, perPersonFleets: 1 };
  const resources = createHubGroupResources({ db, policy, audit, current, directory, now });
  return { db, admin, owner, group, audit, state, ctx, directory, policy, actions, resource, grant, resources, read, advance };
}
async function pausedCode() {
  const r = rig(), permit = await r.actions.prepareCodeEnrollment(r.resource, r.grant, r.ctx);
  r.db.transaction(() => permit.commit(r.db)).immediate();
  r.policy.replace({ ...r.policy.read(), denies: [{ person: r.owner, deny: ["pair_fleet"] }] }, r.admin, r.ctx);
  await expect(r.actions.check(r.resource, r.ctx)).rejects.toMatchObject({ reason: "denied" });
  r.policy.replace({ ...r.policy.read(), denies: [] }, r.admin, r.ctx);
  const requireAdmin = vi.fn(async () => ({ kind: "directory" as const, person: r.admin, sessionId: "owned-admin" }));
  return { ...r, requireAdmin, resumeCtx: { ...r.ctx, requireAdmin } };
}
describe("B1 trusted code permit and retained lifecycle", () => {
  it("directory scope needs no group allowance/read, records exact code/admin and is one-shot in the owning transaction", async () => {
    const r = rig(), permit = await r.actions.prepareCodeEnrollment(r.resource, r.grant, r.ctx);
    expect(permit.source).toBe("code"); expect(permit.maxFleets).toBe(1); expect(r.read).not.toHaveBeenCalled(); expect(r.resources.read(r.resource)).toBeNull();
    expect(() => permit.commit(r.db)).toThrow();
    r.db.transaction(() => { permit.commit(r.db); permit.assertCurrent(); }).immediate();
    expect(r.resources.read(r.resource)).toMatchObject({ source: "code", state: "active", code: { codeId: r.grant.codeId, approvedBy: r.admin } });
    expect(() => r.db.transaction(() => permit.commit(r.db)).immediate()).toThrow();
    expect((await r.actions.check(r.resource, r.ctx)).source).toBe("code");
    expect(r.audit.verifyChain()).toMatchObject({ ok: true });
  });
  it.each(["unknown", "nonmember", "foreign", "future", "oversized"])("exact group scope refuses %s facts", async kind => {
    const r = rig(); r.read.mockImplementation(async person => kind === "unknown" ? { kind: "unknown" } : { kind: "complete", person: kind === "foreign" ? { ...person, objectId: randomUUID() } : person,
      groups: kind === "nonmember" ? [] : kind === "oversized" ? Array.from({ length: 257 }, () => r.group.objectId) : [r.group.objectId], observedAt: kind === "future" ? 101 : 100 });
    await expect(r.actions.prepareCodeEnrollment(r.resource, { ...r.grant, scope: { kind: "group", ...r.group, dn: "CN=Group,DC=test" } }, r.ctx)).rejects.toMatchObject({ reason: "denied" });
    expect(r.resources.read(r.resource)).toBeNull();
  });
  it("group-scope overload stays retryable and shares the existing physical read pool", async () => {
    const r = rig(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const held = Array.from({ length: 4 }, () => r.policy.withDirectoryRead(r.owner, () => gate));
    await expect(r.actions.prepareCodeEnrollment(r.resource, { ...r.grant, scope: { kind: "group", ...r.group, dn: "CN=Group,DC=test" } }, r.ctx)).rejects.toMatchObject({ code: "unavailable" });
    expect(r.read).not.toHaveBeenCalled(); release(); await Promise.all(held);
    expect((await r.actions.prepareCodeEnrollment(r.resource, { ...r.grant, scope: { kind: "group", ...r.group, dn: "CN=Group,DC=test" } }, r.ctx)).source).toBe("code");
  });
  it.each(["caller", "epoch", "binding", "metadata"])("final %s change retires a prepared/committed permit", async kind => {
    const r = rig(), permit = await r.actions.prepareCodeEnrollment(r.resource, r.grant, r.ctx);
    if (kind === "metadata") {
      r.db.transaction(() => permit.commit(r.db)).immediate(); const row = r.db.prepare("SELECT body FROM hub_group_resources").get() as { body: string };
      r.db.prepare("UPDATE hub_group_resources SET body=?").run(JSON.stringify({ ...JSON.parse(row.body), codeId: randomUUID() }));
    } else if (kind === "caller") r.state.caller = false; else if (kind === "epoch") r.state.epoch++; else r.state.binding = false;
    expect(() => permit.assertCurrent()).toThrow();
  });
  it("only the configured approver may grant code Fleet enrollment; no exposure/asker or >8 allowance", async () => {
    const r = rig();
    for (const patch of [{ approvedBy: r.owner }, { perPersonFleets: 9 }]) await expect(r.actions.prepareCodeEnrollment(r.resource, { ...r.grant, ...patch }, r.ctx)).rejects.toThrow();
    for (const kind of ["exposure", "asker"] as const) await expect(r.actions.prepareCodeEnrollment({ ...r.resource, kind }, r.grant, r.ctx)).rejects.toThrow();
    expect(r.db.prepare("SELECT count(*) n FROM hub_group_resources").get()).toEqual({ n: 0 });
  });
  it("explicit person deny suspends code resources, while policy-off and missing membership do not", async () => {
    const r = rig(), permit = await r.actions.prepareCodeEnrollment(r.resource, r.grant, r.ctx); r.db.transaction(() => permit.commit(r.db)).immediate();
    r.policy.replace({ ...r.policy.read(), state: "enabled", groups: [] }, r.admin, r.ctx);
    r.policy.replace({ ...r.policy.read(), state: "suspended" }, r.admin, r.ctx);
    expect((await r.actions.check(r.resource, r.ctx)).source).toBe("code");
    r.policy.replace({ ...r.policy.read(), denies: [{ person: r.owner, deny: ["pair_fleet"] }] }, r.admin, r.ctx);
    await expect(r.actions.check(r.resource, r.ctx)).rejects.toThrow(); expect(r.resources.read(r.resource)).toMatchObject({ state: "suspended", source: "code" });
  });
  it("a never-enabled exclusion refuses new code enrollment without a group read", async () => {
    const r = rig(); r.policy.replace({ ...r.policy.read(), denies: [{ person: r.owner, deny: ["pair_fleet"] }] }, r.admin, r.ctx);
    expect(r.policy.read().state).toBe("never-enabled");
    await expect(r.actions.prepareCodeEnrollment(r.resource, r.grant, r.ctx)).rejects.toMatchObject({ outcome: "denied" });
    expect(r.resources.read(r.resource)).toBeNull(); expect(r.read).not.toHaveBeenCalled();
    await expect(r.actions.prepareCodeEnrollment({ ...r.resource, id: randomUUID(), owner: r.admin }, r.grant, r.ctx)).resolves.toMatchObject({ source: "code" });
  });
  it("a never-enabled exclusion suspends a retained code Fleet instead of returning an allowance", async () => {
    const r = rig(), permit = await r.actions.prepareCodeEnrollment(r.resource, r.grant, r.ctx); r.db.transaction(() => permit.commit(r.db)).immediate();
    r.policy.replace({ ...r.policy.read(), denies: [{ person: r.owner, deny: ["pair_fleet"] }] }, r.admin, r.ctx);
    await expect(r.actions.check(r.resource, r.ctx)).rejects.toThrow();
    expect(r.resources.read(r.resource)).toMatchObject({ source: "code", state: "suspended" });
  });
  it("never-enabled batch suspension still refuses a code Fleet without an explicit exclusion", async () => {
    const r = rig(), permit = await r.actions.prepareCodeEnrollment(r.resource, r.grant, r.ctx); r.db.transaction(() => permit.commit(r.db)).immediate();
    expect(() => r.db.transaction(() => r.resources.suspend(r.resource, r.admin, r.ctx)).immediate()).toThrow("invalid");
    expect(r.resources.read(r.resource)).toMatchObject({ source: "code", state: "active" });
  });
  it("never-enabled code resume needs explicit fresh admin approval after exclusion removal", async () => {
    const r = await pausedCode(), epoch = r.state.epoch;
    await expect(r.actions.check(r.resource, r.ctx)).rejects.toMatchObject({ reason: "resume-required" });
    const permit = await r.actions.resume(r.resource, r.resumeCtx); permit.assertCurrent();
    expect(permit.source).toBe("code"); expect(r.requireAdmin).toHaveBeenCalledOnce(); expect(r.read).not.toHaveBeenCalled();
    expect(r.directory.checkEligibility).toHaveBeenCalledTimes(2);
    expect(r.resources.read(r.resource)).toMatchObject({ source: "code", state: "active", revision: 3 });
    expect(r.state.epoch).toBe(epoch + 1); expect(r.policy.read().state).toBe("never-enabled");
    expect(r.db.prepare("SELECT action FROM hub_audit WHERE action='group-resource.resumed'").all()).toHaveLength(1);
  });
  it("never-enabled resume preserves the manual and unregistered legacy refusals", async () => {
    const r = rig(), ctx = { ...r.ctx, requireAdmin: vi.fn(async () => ({ kind: "directory" as const, person: r.admin, sessionId: "owned-admin" })) };
    await expect(r.actions.resume(r.resource, ctx)).rejects.toThrow();
    r.resources.captureManual(r.resource, r.ctx);
    r.db.prepare("UPDATE hub_group_resources SET state='suspended'").run();
    await expect(r.actions.resume(r.resource, ctx)).rejects.toThrow();
    expect(ctx.requireAdmin).not.toHaveBeenCalled(); expect(r.resources.read(r.resource)).toMatchObject({ source: "manual", state: "suspended" });
    expect(r.db.prepare("SELECT action FROM hub_audit WHERE action='group-resource.resumed'").all()).toEqual([]);
  });
  it("never-enabled code resume refuses a different admin and an exclusion still in force", async () => {
    const r = await pausedCode();
    await expect(r.actions.resume(r.resource, { ...r.ctx, requireAdmin: async () => ({ kind: "directory", person: r.owner, sessionId: "wrong-admin" }) })).rejects.toMatchObject({ reason: "denied" });
    r.policy.replace({ ...r.policy.read(), denies: [{ person: r.owner, deny: ["pair_fleet"] }] }, r.admin, r.ctx);
    await expect(r.actions.resume(r.resource, r.resumeCtx)).rejects.toMatchObject({ reason: "denied" });
    expect(r.resources.read(r.resource)).toMatchObject({ state: "suspended", revision: 2 });
    expect(r.db.prepare("SELECT action FROM hub_audit WHERE action='group-resource.resumed'").all()).toEqual([]);
  });
  it.each(["disabled", "unavailable"] as const)("never-enabled code resume refuses owner eligibility %s", async reason => {
    const r = await pausedCode(); vi.mocked(r.directory.checkEligibility).mockResolvedValue({ eligible: false, reason });
    await expect(r.actions.resume(r.resource, r.resumeCtx)).rejects.toMatchObject({ reason: reason === "unavailable" ? "held" : "denied" });
    expect(r.resources.read(r.resource)).toMatchObject({ state: "suspended", revision: 2 });
    expect(r.db.prepare("SELECT action FROM hub_audit WHERE action='group-resource.resumed'").all()).toEqual([]);
  });
  it("never-enabled code resume refuses a mismatched eligibility owner", async () => {
    const r = await pausedCode(), eligibility = await r.directory.checkEligibility(r.owner);
    if (!eligibility.eligible) throw Error("Owned eligibility control refused");
    vi.mocked(r.directory.checkEligibility).mockResolvedValue({ eligible: true, person: { ...eligibility.person, key: { ...r.owner, objectId: randomUUID() } } });
    await expect(r.actions.resume(r.resource, r.resumeCtx)).rejects.toMatchObject({ reason: "held" });
    expect(r.resources.read(r.resource)).toMatchObject({ state: "suspended", revision: 2 });
  });
  it.each(["caller", "binding", "epoch", "policy"] as const)("held admin authentication fences never-enabled code resume after %s", async changed => {
    const r = await pausedCode(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = r.actions.resume(r.resource, { ...r.ctx, requireAdmin: async () => { await gate; return { kind: "directory", person: r.admin, sessionId: "owned-admin" }; } });
    const refused = expect(pending).rejects.toThrow();
    if (changed === "caller") r.state.caller = false; else if (changed === "binding") r.state.binding = false;
    else if (changed === "epoch") r.state.epoch++; else r.policy.replace({ ...r.policy.read(), denies: [{ person: r.admin, deny: ["pair_fleet"] }] }, r.admin, r.ctx);
    release(); await refused;
    expect(r.resources.read(r.resource)).toMatchObject({ state: "suspended", revision: 2 });
    expect(r.db.prepare("SELECT action FROM hub_audit WHERE action='group-resource.resumed'").all()).toEqual([]);
  });
  it.each(["row", "epoch"] as const)("held eligibility fences never-enabled code resume after %s", async changed => {
    const r = await pausedCode(); let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), reading = new Promise<void>(resolve => { entered = resolve; });
    const eligibility = await r.directory.checkEligibility(r.owner);
    vi.mocked(r.directory.checkEligibility).mockImplementation(async () => { entered(); await gate; return eligibility; });
    const pending = r.actions.resume(r.resource, r.resumeCtx), refused = expect(pending).rejects.toThrow();
    const reached = await Promise.race([reading.then(() => true), pending.then(() => false, () => false)]);
    if (!reached) { release(); await refused; expect(reached).toBe(true); return; }
    if (changed === "row") r.db.prepare("UPDATE hub_group_resources SET revision=revision+1").run(); else r.state.epoch++;
    release(); await refused;
    expect(r.resources.read(r.resource)).toMatchObject({ state: "suspended" });
    expect(r.db.prepare("SELECT action FROM hub_audit WHERE action='group-resource.resumed'").all()).toEqual([]);
  });
  it("late audit cancellation rolls back never-enabled code resume", async () => {
    const r = await pausedCode(), append = r.audit.appendInTransaction.bind(r.audit);
    vi.spyOn(r.audit, "appendInTransaction").mockImplementation((entry, db) => {
      const result = append(entry, db); if (entry.action === "group-resource.resumed") r.state.caller = false; return result;
    });
    await expect(r.actions.resume(r.resource, r.resumeCtx)).rejects.toThrow();
    expect(r.resources.read(r.resource)).toMatchObject({ state: "suspended", revision: 2 });
    expect(r.db.prepare("SELECT action FROM hub_audit WHERE action='group-resource.resumed'").all()).toEqual([]);
  });
  it("late invalidation cancellation rolls back never-enabled code resume after its required audit", async () => {
    const r = await pausedCode(); r.advance.mockImplementation(() => { r.state.epoch++; r.state.caller = false; });
    await expect(r.actions.resume(r.resource, r.resumeCtx)).rejects.toThrow();
    expect(r.resources.read(r.resource)).toMatchObject({ state: "suspended", revision: 2 });
    expect(r.db.prepare("SELECT action FROM hub_audit WHERE action='group-resource.resumed'").all()).toEqual([]);
  });
});
