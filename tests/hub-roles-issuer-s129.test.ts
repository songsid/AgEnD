/** Actual session/SQL/enrollment services; inert directory and transport, not a mounted-route claim. */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { roleAuthorityWorld } from "./support/hub-role-authority-rig.js";
import { createHubGroupAuthorization } from "../src/hub/group-policy/authorization.js";
import { inspectHubGroupPolicyBinding } from "../src/hub/group-policy/store.js";
import { HubPairingService } from "../src/hub/pairing.js";
import { pairingOwnerByLogin } from "../src/hub/http/core.js";

function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

async function world() {
  const w = await roleAuthorityWorld();
  w.policy.roles.push({ id: "join-only", kind: "custom", name: "Join", permissions: ["join.manage"], defaultMaxFleets: 0 });
  w.policy.assignments[0]!.roleId = "join-only"; w.save(w.policy);
  const options = { db: w.db, administrator: w.root, directory: w.directory, policy: () => w.pool,
    binding: () => inspectHubGroupPolicyBinding(w.db, w.hubId, "corp", "g1"), audit: w.audit, current: w.options.current, now: w.options.now,
    version: w.options.version, advanceAuthorization: w.advance, refreshAuthorization() {}, management: w.authority };
  const groups = createHubGroupAuthorization(options), context = { requestId: "attempt1", current: () => true };
  const pairing = () => new HubPairingService({ store: w.store, directory: w.directory, enabled: w.options.current, now: w.options.now, management: w.authority,
    fenceFleet() {}, enrollment: { prepare: groups.prepareEnrollment, prepareManual: groups.prepareManualEnrollment,
      atomic: work => w.db.transaction(() => work(w.db)).immediate() },
    identity: { hubId: w.hubId, webOrigin: "https://hub.example.test", memberOrigin: "https://member.example.test", spkiSha256: "a".repeat(64), issuerPublicKey: "unused-synthetic" } });
  const raw = () => JSON.parse((w.db.prepare("SELECT state FROM hub_transport_state").get() as { state: string }).state);
  return { ...w, groups, context, pairing, raw, resource: { kind: "fleet" as const, id: randomUUID(), revision: 1, owner: w.other } };
}
describe("S129 first-issuance approver permission", () => {
  it("prepares the real manual enrollment under an auxiliary join manager and preserves their audit identity", async () => {
    const w = await world();
    const prepared = await w.groups.prepareManualEnrollment(w.resource, w.admin, w.context);
    expect(prepared.source).toBe("manual");
    w.db.transaction(() => { prepared.commit(w.db); prepared.assertCurrent(); }).immediate();
    expect(JSON.parse((w.db.prepare("SELECT actor FROM hub_audit WHERE action='group-resource.admin-granted'").get() as { actor: string }).actor))
      .toEqual({ kind: "person", person: w.admin });
  });
  it("prepares the real code enrollment with the recorded auxiliary issuer rather than substituting root", async () => {
    const w = await world(), codeId = randomUUID();
    const prepared = await w.groups.prepareCodeEnrollment(w.resource, { codeId, approvedBy: w.admin, scope: { kind: "directory" }, perPersonFleets: 1 }, w.context);
    expect(prepared.source).toBe("code");
    w.db.transaction(() => { prepared.commit(w.db); prepared.assertCurrent(); }).immediate();
    const row = w.db.prepare("SELECT body FROM hub_group_resources").get() as { body: string };
    expect(JSON.parse(row.body)).toMatchObject({ codeId, approvedBy: w.admin });
  });
  it("lets the actual pairing service create an offer using join.manage while its old root-only gate refuses the same session", async () => {
    const w = await world(); await expect(w.ctx.ctx.requireAdmin()).rejects.toMatchObject({ code: "denied" });
    const options = { store: w.store, directory: w.directory, enabled: w.options.current, now: w.options.now, management: w.authority,
      fenceFleet() {}, identity: { hubId: w.hubId, webOrigin: "https://hub.example.test", memberOrigin: "https://member.example.test", spkiSha256: "a".repeat(64), issuerPublicKey: "unused-synthetic" } };
    const pairing = new HubPairingService(options), offer = await pairing.create(w.ctx.ctx, w.other);
    expect(offer.pairingId).toEqual(expect.any(String));
    expect(JSON.parse((w.db.prepare("SELECT actor FROM hub_audit WHERE action='pairing.created'").get() as { actor: string }).actor))
      .toEqual({ kind: "person", person: w.admin });
  });
  it.each(["signed-out", "stale-double"] as const)("retains the held approval's %s session refusal without publishing approval", async mode => {
    const w = await world(), pairing = w.pairing(), offer = await pairing.create(w.ctx.ctx, w.other);
    const pending = pairing.pair({ code: offer.code }), owner = await w.browser(w.other);
    await pairing.confirmOwner(owner.ctx, pending.pairingId, pending.fingerprint);
    const actor = await w.ctx.ctx.current(), current = vi.fn(() => w.ctx.ctx.current()), ctx = { ...w.ctx.ctx, current };
    const entered = gate<void>(), answer = gate<Awaited<ReturnType<typeof w.eligible>>>();
    w.eligible.mockImplementation(async who => {
      if (who.objectId === w.other.objectId) { entered.resolve(); return answer.promise; }
      return { eligible: true, person: w.person(who) };
    });
    const approving = pairing.approve(ctx, pending.pairingId, pending.fingerprint).catch(error => error);
    await entered.promise;
    w.sessions.signOut(w.ctx.token);
    if (mode === "stale-double") current.mockResolvedValue(actor);
    answer.resolve({ eligible: true, person: w.person(w.other) });
    expect(await approving).toMatchObject({ code: mode === "signed-out" ? "revoked" : "unavailable" });
    expect(w.store.read().pairings[0]!.adminApproved).toBe(false);
    expect(w.store.read().fleets).toEqual([]);
    const fresh = await w.browser();
    await expect(pairing.approve(fresh.ctx, pending.pairingId, pending.fingerprint)).resolves.toBeUndefined();
    expect(w.store.read().pairings[0]!.adminApproved).toBe(true);
  });
  it.each(["manual", "code"] as const)("rolls back %s registration when its retained issuer loses permission during required audit", async source => {
    const w = await world(), prepared = source === "manual" ? await w.groups.prepareManualEnrollment(w.resource, w.admin, w.context)
      : await w.groups.prepareCodeEnrollment(w.resource, { codeId: randomUUID(), approvedBy: w.admin, scope: { kind: "directory" }, perPersonFleets: 1 }, w.context);
    const append = w.audit.appendInTransaction.bind(w.audit), action = source === "manual" ? "group-resource.admin-granted" : "group-resource.code-granted";
    vi.spyOn(w.audit, "appendInTransaction").mockImplementation((...args) => { const out = append(...args);
      if (args[0].action === action) w.save({ ...w.policy, assignments: [] }); return out; });
    expect(() => w.db.transaction(() => prepared.commit(w.db)).immediate()).toThrow();
    expect(w.db.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]);
    expect(w.db.prepare("SELECT * FROM hub_group_resource_events").all()).toEqual([]);
    expect(w.db.prepare("SELECT id FROM hub_audit WHERE action=?").all(action)).toEqual([]);
    expect(() => prepared.assertCurrent()).toThrow(); // SQL rollback restores bytes, never this already-retired proof.
    expect(w.audit.verifyChain()).toMatchObject({ ok: true });
  });
  it.each(["assignment", "disabled", "foreign", "off"] as const)("refuses first issuance when the recorded issuer is %s", async change => {
    const w = await world();
    if (change === "assignment") { w.policy.assignments = []; w.save(w.policy); }
    if (change === "off") { w.policy.rolesActive = false; w.save(w.policy); }
    if (change === "disabled") w.eligible.mockResolvedValueOnce({ eligible: false, reason: "disabled" });
    if (change === "foreign") w.eligible.mockResolvedValueOnce({ eligible: true, person: w.person(w.other) });
    await expect(w.groups.prepareManualEnrollment(w.resource, w.admin, w.context)).rejects.toBeTruthy();
    expect(w.db.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]);
  });
  it.each(["policy", "epoch", "directory", "deadline", "elapsed", "expiry", "caller"] as const)("permanently retires the session-independent issuer proof at %s", async change => {
    const w = await world(); let live = true;
    if (change === "expiry") { w.policy.assignments[0]!.expiresAt = 200; w.save(w.policy); }
    const permit = await w.authority.requireJoinIssuer(w.admin, { ...w.context, current: () => live });
    if (change === "policy") { w.policy.assignments = []; w.save(w.policy); }
    if (change === "epoch") w.advance();
    if (change === "directory") w.directory.checkEligibility = async who => ({ eligible: true, person: w.person(who) });
    if (change === "deadline") w.time(5000);
    if (change === "elapsed") w.elapsed(5000);
    if (change === "expiry") w.time(100);
    if (change === "caller") live = false;
    expect(() => permit.assertCurrent()).toThrow();
    live = true; w.save({ ...w.policy, assignments: [{ id: "auxiliary", roleId: "join-only", subject: { kind: "person", person: w.admin }, scope: { kind: "hub" },
      maxFleets: null, startsAt: 0, expiresAt: null, assignedBy: w.root, assignedAt: 0 }] });
    expect(() => permit.assertCurrent()).toThrow();
  });
  it.each(["owner-read", "audit"] as const)("does not publish a pairing after join.manage is lost at %s", async stage => {
    const w = await world(), pairing = w.pairing();
    if (stage === "owner-read") w.eligible.mockImplementation(async who => {
      if (who.objectId === w.other.objectId) w.save({ ...w.policy, assignments: [] });
      return { eligible: true, person: w.person(who) };
    });
    if (stage === "audit") {
      const append = w.audit.appendInTransaction.bind(w.audit);
      vi.spyOn(w.audit, "appendInTransaction").mockImplementation((...args) => { const out = append(...args);
        if (args[0].action === "pairing.created") w.save({ ...w.policy, assignments: [] }); return out; });
    }
    await expect(pairing.create(w.ctx.ctx, w.other)).rejects.toBeTruthy();
    expect(w.raw().pairings).toEqual([]);
    expect(w.db.prepare("SELECT id FROM hub_audit WHERE action='pairing.created'").all()).toEqual([]);
  });
  it("keeps split fleet-management authority separate from joining and records the actual auxiliary revoker", async () => {
    const w = await world(), fleetId = randomUUID(), pairing = w.pairing();
    w.store.mutate({ at: 100, requestId: randomUUID(), actor: { kind: "local-host" }, action: "fixture.fleet", result: "completed" }, state => {
      state.fleets.push({ id: fleetId, owner: w.other, credentialHash: "a".repeat(64), generation: 1, status: "active" });
    });
    await expect(pairing.revoke(w.ctx.ctx, fleetId)).rejects.toMatchObject({ code: "denied" });
    w.policy.roles.find(role => role.id === "join-only")!.permissions = ["fleets.manage"]; w.save(w.policy);
    await expect(pairing.create(w.ctx.ctx, w.other)).rejects.toMatchObject({ code: "denied" });
    await pairing.revoke(w.ctx.ctx, fleetId);
    expect(w.store.read().fleets[0]).toMatchObject({ status: "revoked", credentialHash: null, generation: 2 });
    expect(JSON.parse((w.db.prepare("SELECT actor FROM hub_audit WHERE action='member.revoked'").get() as { actor: string }).actor))
      .toEqual({ kind: "person", person: w.admin });
  });
  it("holds the same physical directory admission until the issuer read settles", async () => {
    const w = await world(), started = gate<void>(), answer = gate<Awaited<ReturnType<typeof w.eligible>>>();
    w.eligible.mockImplementationOnce(async () => { started.resolve(); return answer.promise; });
    const pending = w.authority.requireJoinIssuer(w.admin, w.context); await started.promise;
    const release: (() => void)[] = [], other = Array.from({ length: 3 }, () => w.pool.withDirectoryRead(w.admin, () => new Promise<void>(r => release.push(r))));
    try { await expect(w.authority.requireJoinIssuer(w.admin, w.context)).rejects.toMatchObject({ code: "backpressure" }); }
    finally { answer.resolve({ eligible: true, person: w.person(w.admin) }); release.forEach(r => r()); await Promise.all(other); await pending; }
    expect((await w.authority.requireJoinIssuer(w.admin, w.context)).approvedBy).toEqual(w.admin);
  });
  it("refuses a late issuer observation after the preparation budget without releasing a held physical read early", async () => {
    const w = await world(), started = gate<void>(), answer = gate<Awaited<ReturnType<typeof w.eligible>>>();
    w.eligible.mockImplementationOnce(async () => { started.resolve(); return answer.promise; });
    const pending = w.authority.requireJoinIssuer(w.admin, w.context), result = pending.catch(error => error);
    await started.promise; w.elapsed(20_000);
    answer.resolve({ eligible: true, person: w.person(w.admin) });
    expect(await result).toMatchObject({ code: "unavailable" });
  });
  it("requires named join authority before selecting an unsigned-in owner", async () => {
    const w = await world(); w.core.deps.management = w.authority;
    const lookup = vi.fn(async () => ({ ok: true as const, person: w.person(w.other) })); w.directory.lookupForPairing = lookup;
    expect(await pairingOwnerByLogin(w.core, w.ctx.ctx, w.other.objectId)).toEqual(w.other);
    lookup.mockClear(); w.policy.assignments = []; w.save(w.policy);
    await expect(pairingOwnerByLogin(w.core, w.ctx.ctx, w.other.objectId)).rejects.toMatchObject({ code: "denied" });
    expect(lookup).not.toHaveBeenCalled();
  });
  it("withholds the selected owner when join authority disappears during its directory lookup", async () => {
    const w = await world(); w.core.deps.management = w.authority;
    w.directory.lookupForPairing = async () => { w.save({ ...w.policy, assignments: [] }); return { ok: true, person: w.person(w.other) }; };
    await expect(pairingOwnerByLogin(w.core, w.ctx.ctx, w.other.objectId)).rejects.toMatchObject({ code: "unavailable" });
  });
});
