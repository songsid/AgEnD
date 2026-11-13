/** Actual SQL, sessions, transport floor and expiry clock; inert directory, no mounted role routes. */
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import { createHubUnitOfWork, hubTxDatabase } from "../src/hub/db.js";
import { createHubGroupPolicyStore, groupPolicyMigration } from "../src/hub/group-policy/store.js";
import { HubCore } from "../src/hub/http/core.js";
import { HUB_HTTP_MIGRATIONS } from "../src/hub/http/compose.js";
import { HubPairingService } from "../src/hub/pairing.js";
import { createHubManagementAuthority, HUB_MANAGEMENT_PROOF_TTL } from "../src/hub/roles/authority.js";
import { createHubRoleExpirySettlement, HUB_ROLE_EXPIRY_MIGRATION } from "../src/hub/roles/expiry.js";
import { builtinRoles, BUILTIN_ROLE_IDS, MANAGEMENT_PERMISSIONS, type HubRolePolicy } from "../src/hub/roles/model.js";
import { HUB_ROLE_WRITER_MIGRATION } from "../src/hub/roles/writer.js";
import { HubSessions, hubCookieName } from "../src/hub/sessions.js";
import { HubTransportStore, HUB_TRANSPORT_MIGRATION } from "../src/hub/store.js";
import type { Eligibility, HubDirectory } from "../src/hub/directory/types.js";
import type { HubRequestContext, PersonKey } from "../src/hub/types.js";

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); vi.restoreAllMocks(); });
const key = (): PersonKey => ({ realm: "corp", objectId: randomUUID() });
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture() {
  const db = new Database(":memory:"); dbs.push(db); db.pragma("foreign_keys=ON");
  for (const m of [HUB_AUDIT_MIGRATION, HUB_TRANSPORT_MIGRATION, ...HUB_HTTP_MIGRATIONS,
    groupPolicyMigration("hub1", "corp", "g1"), HUB_ROLE_WRITER_MIGRATION, HUB_ROLE_EXPIRY_MIGRATION]) m.up(db);
  const root = key(), admin = key(), other = key(); let time = 100, elapsed = 0, live = true, floor = 0;
  const audit = createHubAudit({ db, contentKey: randomBytes(32), now: () => time });
  const store = new HubTransportStore(db, { floor: { read: () => floor, raise: n => { floor = n; } },
    appendAudit(event, tx) { audit.appendInTransaction(event, tx); } }); store.initialize();
  const person = (who: PersonKey) => ({ key: structuredClone(who), login: who.objectId, dn: "CN=Synthetic", groups: [] });
  const eligible = vi.fn(async (who: PersonKey): Promise<Eligibility> => ({ eligible: true, person: person(who) }));
  const directory: HubDirectory = { realm: "corp", checkEligibility: eligible,
    async signIn(login, password) { const who = [root, admin, other].find(who => who.objectId === login);
      return who && password === "synthetic" ? { ok: true, person: person(who) } : { ok: false, reason: "invalid-credentials" }; }, async close() {} };
  const pool = createHubGroupPolicyStore({ db, hubId: "hub1", realm: "corp", generation: "g1", directory, audit, current: () => live });
  const legacyRaw = (db.prepare("SELECT body FROM hub_group_policy").get() as { body: string }).body;
  const policy: HubRolePolicy = { realm: "corp", generation: "g1", revision: 1, rolesActive: true, state: "enabled", everEnabled: true,
    roles: builtinRoles(), assignments: [{ id: "auxiliary", roleId: BUILTIN_ROLE_IDS.admin, subject: { kind: "person", person: admin }, scope: { kind: "hub" },
      maxFleets: null, startsAt: 0, expiresAt: null, assignedBy: root, assignedAt: 0 }], denies: [] };
  const save = (next: HubRolePolicy) => db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(next)); save(policy);
  const deps = { store, directory, config: { hubId: "hub1", name: "Synthetic", memberOrigin: "https://member.example.test", webOrigin: "https://hub.example.test", administrator: root },
    uow: createHubUnitOfWork(db), audit, current: () => ({ serverEnabled: () => live, memberEnabled: () => false, epoch: () => 0 }), now: () => time,
    pairing: new HubPairingService({ store, directory, enabled: () => live, fenceFleet() {}, identity: { hubId: "hub1", webOrigin: "https://hub.example.test",
      memberOrigin: "https://member.example.test", spkiSha256: "a".repeat(64), issuerPublicKey: "unused-synthetic" } }),
    issuer: { keyId: "unused", sign(): never { throw Error("unused"); } }, transport: () => null,
    content: { put(): never { throw Error("unused"); }, get() { return undefined; } },
  } satisfies ConstructorParameters<typeof HubCore>[0];
  const core = new HubCore(deps, hubTxDatabase), sessions = new HubSessions(core);
  const browser = async (who = admin) => { const signed = await sessions.signIn(who.objectId, "synthetic");
    return { ctx: sessions.context({ headers: { cookie: `${hubCookieName("hub1")}=${signed.token}` } } as IncomingMessage), token: signed.token }; };
  const ctx = await browser();
  const advance = () => store.mutate({ at: time, requestId: randomUUID(), actor: { kind: "local-host" }, action: "synthetic.epoch", result: "completed" }, state => { state.revocationVersion++; });
  const expiry = createHubRoleExpirySettlement({ db, hubId: "hub1", realm: "corp", generation: "g1", root, audit, directory, reads: pool,
    current: () => live, version: () => store.read().revocationVersion, now: () => time,
    advanceAuthorization: advance, refreshAuthorization() {},
    effects: { snapshot: () => ({ fingerprint: "unused", ordinaryFingerprint: "unused", people: [] }), async prepare(): Promise<never> { throw Error("unmounted"); } } });
  const options = { root, directory, reads: pool, policy: () => pool.canonical!(), current: () => live,
    version: () => store.read().revocationVersion, assertAuthorizationTime: expiry.assertAuthorizationTime, now: () => time, elapsedNow: () => elapsed };
  const authority = createHubManagementAuthority(options);
  return { db, root, admin, other, policy, save, legacyRaw, directory, eligible, person, pool, core, sessions, browser, ctx, advance, options, authority,
    time: (ms: number) => { time += ms; }, elapsed: (ms: number) => { elapsed += ms; }, stop: () => { live = false; }, floor: () => { floor += 10; } };
}

describe("S129 operation-owned management authority", () => {
  it("proves an actual auxiliary-admin session independently from the old root-only presentation gate", async () => {
    const w = await fixture(), admission = vi.spyOn(w.pool, "withDirectoryRead");
    await expect(w.ctx.ctx.requireAdmin()).rejects.toMatchObject({ code: "denied" });
    for (const permission of MANAGEMENT_PERMISSIONS) {
      const permit = await w.authority.require(w.ctx.ctx, permission);
      expect(permit.actor.person).toEqual(w.admin); expect(permit.permission).toBe(permission); expect(permit.source).toBe("roles");
      expect(permit.actor.sessionId).toBe((await w.ctx.ctx.current()).sessionId); expect(() => permit.assertCurrent()).not.toThrow();
    }
    expect(admission).toHaveBeenCalledWith(w.admin, expect.any(Function));
    expect(w.db.prepare("SELECT * FROM hub_auditors").all()).toEqual([]); // audit.view never grants content-auditor access.
  });
  it("keeps split permissions separate and roles-off returns management only to the configured root", async () => {
    const w = await fixture(); w.policy.roles.push({ id: "join-only", kind: "custom", name: "Join", permissions: ["join.manage"], defaultMaxFleets: 0 });
    w.policy.assignments[0]!.roleId = "join-only"; w.save(w.policy);
    expect((await w.authority.require(w.ctx.ctx, "join.manage")).actor.person).toEqual(w.admin);
    for (const permission of ["fleets.manage", "hub.admin", "roles.assign", "audit.view"] as const) await expect(w.authority.require(w.ctx.ctx, permission)).rejects.toMatchObject({ code: "denied" });
    w.policy.rolesActive = false; w.save(w.policy);
    await expect(w.authority.require(w.ctx.ctx, "join.manage")).rejects.toMatchObject({ code: "denied" });
    expect((await w.authority.require((await w.browser(w.root)).ctx, "hub.admin")).actor.person).toEqual(w.root);
  });
  it.each(["never-enabled", "suspended"] as const)("does not use self-use state %s to block a held management assignment", async state => {
    const w = await fixture(); w.policy.state = state; w.policy.everEnabled = state !== "never-enabled"; w.save(w.policy);
    expect((await w.authority.require(w.ctx.ctx, "join.manage")).actor.person).toEqual(w.admin);
  });
  it("preserves the legacy root-only gate and refuses auxiliary authority without converting the stored document", async () => {
    const w = await fixture(); w.db.prepare("UPDATE hub_group_policy SET body=?").run(w.legacyRaw);
    await expect(w.authority.require(w.ctx.ctx, "join.manage")).rejects.toMatchObject({ code: "denied" });
    expect((await w.authority.require((await w.browser(w.root)).ctx, "join.manage")).source).toBe("legacy");
    expect((w.db.prepare("SELECT body FROM hub_group_policy").get() as { body: string }).body).toBe(w.legacyRaw);
  });
  it.each(["policy", "epoch", "floor", "session", "lifetime", "directory", "closed", "expiry", "wall-ttl", "elapsed-ttl", "rewind"] as const)("permanently retires an admitted proof at %s", async change => {
    const w = await fixture(); if (change === "expiry") { w.policy.assignments[0]!.expiresAt = 200; w.save(w.policy); }
    const permit = await w.authority.require(w.ctx.ctx, "join.manage");
    if (change === "policy") { w.policy.revision++; w.save(w.policy); }
    if (change === "epoch") w.advance(); if (change === "floor") w.floor();
    if (change === "session") w.sessions.signOut(w.ctx.token); if (change === "lifetime") w.stop();
    if (change === "directory") w.directory.checkEligibility = async who => ({ eligible: true, person: w.person(who) });
    if (change === "closed") w.authority.close(); if (change === "expiry") w.time(100);
    if (change === "wall-ttl") w.time(HUB_MANAGEMENT_PROOF_TTL); if (change === "elapsed-ttl") w.elapsed(HUB_MANAGEMENT_PROOF_TTL);
    if (change === "rewind") w.time(-1);
    expect(() => permit.assertCurrent()).toThrow();
    if (change === "rewind") w.time(1);
    expect(() => permit.assertCurrent()).toThrow();
  });
  it("uses the actual persisted expiry clock floor even when a new reader starts with a rewound clock", async () => {
    const w = await fixture(); w.db.prepare("INSERT INTO hub_role_expiry_terms VALUES(?,?,?,?,?)").run("synthetic", "old", 200, "synthetic", 200);
    await expect(w.authority.require(w.ctx.ctx, "hub.admin")).rejects.toBeTruthy();
    w.time(100); expect((await createHubManagementAuthority(w.options).require(w.ctx.ctx, "hub.admin")).source).toBe("roles");
  });
  it.each(["ended", "role-loss", "method", "deadline"] as const)("refuses %s while the physical directory read is held", async change => {
    const w = await fixture(), started = gate<void>(), answer = gate<Eligibility>();
    w.eligible.mockImplementationOnce(async () => { started.resolve(); return answer.promise; });
    const running = w.authority.require(w.ctx.ctx, "join.manage"), settled = running.catch(error => error); await started.promise;
    if (change === "ended") w.sessions.signOut(w.ctx.token);
    if (change === "role-loss") { w.policy.assignments = []; w.save(w.policy); }
    if (change === "method") w.directory.checkEligibility = async who => ({ eligible: true, person: w.person(who) });
    if (change === "deadline") w.elapsed(20_000);
    answer.resolve({ eligible: true, person: w.person(w.admin) });
    expect(await settled).toHaveProperty("code", "unavailable");
  });
  it.each(["disabled", "unknown", "foreign"] as const)("does not elevate %s directory results", async state => {
    const w = await fixture(); w.eligible.mockResolvedValueOnce(state === "foreign" ? { eligible: true, person: w.person(w.other) }
      : { eligible: false, reason: state === "unknown" ? "unavailable" : "disabled" });
    await expect(w.authority.require(w.ctx.ctx, "hub.admin")).rejects.toMatchObject({ code: state === "disabled" ? "denied" : "unavailable" });
  });
  it("binds exact actor/session and requires the synchronous identity fence rather than a root display flag", async () => {
    const w = await fixture(), other = await w.browser(w.other);
    const wrong: HubRequestContext = { ...w.ctx.ctx, current: other.ctx.current };
    await expect(w.authority.require(wrong, "hub.admin")).rejects.toMatchObject({ code: "unavailable" });
    await expect(w.authority.require({ ...w.ctx.ctx, isIdentityCurrent: undefined }, "hub.admin")).rejects.toMatchObject({ code: "unavailable" });
    expect(w.ctx.ctx.isIdentityCurrent!(w.other, (await w.ctx.ctx.current()).sessionId)).toBe(false);
    expect(w.ctx.ctx.isIdentityCurrent!(w.admin, (await (await w.browser()).ctx.current()).sessionId)).toBe(false);
  });
  it("snapshots the directory's selected identity before the final authentication await", async () => {
    const w = await fixture(), mutable = { eligible: true as const, person: w.person(w.other) };
    w.eligible.mockResolvedValueOnce(mutable);
    let calls = 0;
    const ctx = { ...w.ctx.ctx, async current() {
      if (++calls === 2) (mutable.person.key as { objectId: string }).objectId = w.admin.objectId;
      return w.ctx.ctx.current();
    } };
    await expect(w.authority.require(ctx, "hub.admin")).rejects.toMatchObject({ code: "unavailable" });
  });
  it("does not revive a proof when a changed policy returns to identical stored bytes", async () => {
    const w = await fixture(), permit = await w.authority.require(w.ctx.ctx, "join.manage");
    const before = JSON.stringify(w.policy); w.policy.assignments = []; w.save(w.policy);
    expect(() => permit.assertCurrent()).toThrow();
    w.db.prepare("UPDATE hub_group_policy SET body=?").run(before);
    expect(() => permit.assertCurrent()).toThrow();
    expect((await w.authority.require(w.ctx.ctx, "join.manage")).actor.person).toEqual(w.admin);
  });
  it("fences an exact session row whose actor changes while its cookie and lifetime remain valid", async () => {
    const w = await fixture(); await w.browser(w.other);
    const permit = await w.authority.require(w.ctx.ctx, "join.manage");
    w.db.prepare("UPDATE hub_sessions SET person=? WHERE id=?").run(`${w.other.realm}/${w.other.objectId}`, permit.actor.sessionId);
    expect(w.ctx.ctx.isCurrent!()).toBe(true); expect(() => permit.assertCurrent()).toThrow();
  });
  it("keeps the proof deadline anchored to the directory observation before a slow final authentication", async () => {
    const w = await fixture(); let calls = 0;
    const ctx = { ...w.ctx.ctx, async current() { if (++calls === 2) w.elapsed(HUB_MANAGEMENT_PROOF_TTL); return w.ctx.ctx.current(); } };
    await expect(w.authority.require(ctx, "hub.admin")).rejects.toMatchObject({ code: "unavailable" });
  });
  it("holds the existing admission slot until the physical read settles", async () => {
    const w = await fixture(), started = gate<void>(), answer = gate<Eligibility>();
    w.eligible.mockImplementationOnce(async () => { started.resolve(); return answer.promise; });
    const running = w.authority.require(w.ctx.ctx, "join.manage"); await started.promise;
    const release: (() => void)[] = [], readers = Array.from({ length: 3 }, () => w.pool.withDirectoryRead(w.admin, () => new Promise<void>(r => release.push(r))));
    try { await expect(w.authority.require(w.ctx.ctx, "join.manage")).rejects.toMatchObject({ code: "backpressure" }); }
    finally { answer.resolve({ eligible: true, person: w.person(w.admin) }); release.forEach(r => r()); await Promise.all(readers); await running; }
    expect((await w.authority.require(w.ctx.ctx, "join.manage")).source).toBe("roles");
  });
});
