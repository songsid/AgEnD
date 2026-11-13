/** Actual SQL/audit, session contexts and shared directory admission; synthetic directory and resource effects only. */
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import { createHubUnitOfWork, hubTxDatabase } from "../src/hub/db.js";
import { HUB_HTTP_MIGRATIONS } from "../src/hub/http/compose.js";
import { HubPairingService } from "../src/hub/pairing.js";
import { HubCore } from "../src/hub/http/core.js";
import { HubSessions, hubCookieName } from "../src/hub/sessions.js";
import { HubTransportStore, HUB_TRANSPORT_MIGRATION } from "../src/hub/store.js";
import { createHubGroupPolicyStore, groupPolicyMigration } from "../src/hub/group-policy/store.js";
import { builtinRoles, BUILTIN_ROLE_IDS, type HubRolePolicy, type HubRoleAssignment } from "../src/hub/roles/model.js";
import { createHubRoleWriter, HUB_ROLE_WRITER_MIGRATION, type RoleWriteEffects } from "../src/hub/roles/writer.js";
import type { HubDirectory } from "../src/hub/directory/types.js";
import type { PolicyGroupFacts } from "../src/hub/directory/groups.js";
import type { HubRequestContext, PersonKey } from "../src/hub/types.js";
const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); vi.restoreAllMocks(); });
function gate<T>() { let resolve!: (x: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const copy = <T>(p: T): T => structuredClone(p);
const key = (): PersonKey => ({ realm: "corp", objectId: randomUUID() });
const a = (id: string, subject: PersonKey, roleId: string = BUILTIN_ROLE_IDS.member): HubRoleAssignment => ({ id, roleId, subject: { kind: "person", person: subject }, scope: { kind: "hub" }, maxFleets: null, startsAt: 0, expiresAt: null, assignedBy: subject, assignedAt: 0 });
async function fixture() {
  const db = new Database(":memory:"); dbs.push(db); db.pragma("foreign_keys=ON");
  for (const m of [HUB_AUDIT_MIGRATION, HUB_TRANSPORT_MIGRATION, ...HUB_HTTP_MIGRATIONS, groupPolicyMigration("hub1", "corp", "g1"), HUB_ROLE_WRITER_MIGRATION]) m.up(db);
  db.exec("CREATE TABLE synthetic_resources(id TEXT PRIMARY KEY,state TEXT); INSERT INTO synthetic_resources VALUES('resource1','active')");
  const root = key(), actor = key(), target = key(), other = key(), group = key(); let time = 100, monotonic = 0, current = true, floor = 0, bodyVersion = 0;
  const audit = createHubAudit({ db, contentKey: randomBytes(32), now: () => time });
  const append = vi.fn((...args: Parameters<typeof audit.appendInTransaction>) => audit.appendInTransaction(...args));
  const store = new HubTransportStore(db, { floor: { read: () => floor, raise: n => { floor = n; } }, appendAudit: (event, tx) => { audit.appendInTransaction(event, tx); } }); store.initialize();
  const people = [root, actor, target, other], memberships = new Map<string, string[]>(), disabled = new Set<string>();
  const found = (p: PersonKey) => ({ key: copy(p), login: p.objectId, dn: `CN=${p.objectId}`, groups: [] });
  const read = vi.fn(async (p: PersonKey): Promise<PolicyGroupFacts> => ({ kind: "complete", person: copy(p), groups: [...(memberships.get(p.objectId) ?? [])], observedAt: time }));
  const eligible = vi.fn(async (p: PersonKey) => disabled.has(p.objectId) ? { eligible: false as const, reason: "disabled" as const } : { eligible: true as const, person: found(p) });
  const resolve = vi.fn(async (dn: string) => ({ ok: true as const, group: { key: copy(group), dn } }));
  const directory: HubDirectory = { realm: "corp", groupPolicy: "ad-direct-guid", readPolicyGroups: read, resolvePolicyGroup: resolve,
    checkEligibility: eligible, async signIn(login, password) { const p = people.find(p => p.objectId === login); return p && password === "synthetic" ? { ok: true, person: found(p) } : { ok: false, reason: "invalid-credentials" }; }, async close() {} };
  const pool = createHubGroupPolicyStore({ db, hubId: "hub1", realm: "corp", generation: "g1", directory, audit, current: () => current, now: () => time });
  const admission = vi.spyOn(pool, "withDirectoryRead");
  const policy: HubRolePolicy = { realm: "corp", generation: "g1", revision: 1, rolesActive: true, state: "enabled", everEnabled: true, roles: builtinRoles(), assignments: [a("admin1", actor, BUILTIN_ROLE_IDS.admin)], denies: [] };
  db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(policy));
  const deps = { store, directory, config: { hubId: "hub1", name: "Synthetic Hub", memberOrigin: "https://member.example.test", webOrigin: "https://hub.example.test", administrator: root },
    uow: createHubUnitOfWork(db), audit, current: () => ({ serverEnabled: () => current, memberEnabled: () => false, epoch: () => 0 }), now: () => time,
  pairing: new HubPairingService({ store, directory, enabled: () => true, fenceFleet() {}, identity: { hubId: "hub1", webOrigin: "https://hub.example.test", memberOrigin: "https://member.example.test", spkiSha256: "a".repeat(64), issuerPublicKey: "unused-synthetic-key" } }),
    issuer: { keyId: "unused-synthetic", sign(): never { throw Error("unused"); } }, transport: () => null,
    content: { put(): never { throw Error("unused"); }, get() { return undefined; } },
  } satisfies ConstructorParameters<typeof HubCore>[0];
  const sessions = new HubSessions(new HubCore(deps, hubTxDatabase));
  const context = async (who = actor) => { const signed = await sessions.signIn(who.objectId, "synthetic");
    return { ctx: sessions.context({ headers: { cookie: `${hubCookieName("hub1")}=${signed.token}` } } as IncomingMessage), token: signed.token }; };
  const browser = await context();
  const snapshot = () => ({ fingerprint: JSON.stringify([bodyVersion, db.prepare("SELECT * FROM synthetic_resources ORDER BY id").all()]), ordinaryFingerprint: JSON.stringify([bodyVersion, db.prepare("SELECT id FROM synthetic_resources ORDER BY id").all()]), people: copy(people) });
  const commit = vi.fn((tx: Database.Database) => { expect(tx).toBe(db); expect(tx.inTransaction).toBe(true); });
  const effects: RoleWriteEffects = { snapshot, async prepare() { const before = snapshot().fingerprint; return { fingerprint: before, changed: false, impact: { retained: ["resource1"] },
    assertCurrent() { if (snapshot().fingerprint !== before) throw Error("changed resources"); }, commit, assertCommitted() {} }; } };
  const advance = vi.fn((tx: Database.Database) => { expect(tx).toBe(db); store.mutate({ at: time, requestId: randomUUID(), actor: { kind: "local-host" }, action: "synthetic.epoch", result: "completed" }, s => { s.revocationVersion++; }); });
  const refresh = vi.fn(() => { expect(db.inTransaction).toBe(false); });
  const options = { db, hubId: "hub1", realm: "corp", generation: "g1", root, audit: { appendInTransaction: append }, directory, reads: pool, effects,
    current: () => current, now: () => time, elapsedNow: () => monotonic, version: () => store.read().revocationVersion, advanceAuthorization: advance, refreshAuthorization: refresh };
  const writer = createHubRoleWriter(options), saved = () => JSON.parse((db.prepare("SELECT body FROM hub_group_policy").get() as { body: string }).body) as HubRolePolicy;
  const proposal = () => { const p = saved(); p.assignments.push(a("member1", target)); return p; };
  const apply = async (p = proposal(), ctx: HubRequestContext = browser.ctx) => { const preview = await writer.preview(p, ctx); expect(preview.ok).toBe(true); if (!preview.ok) throw Error("preview refused"); return writer.apply(p, preview.previewDigest, ctx); };
  return { db, root, actor, target, other, group, directory, read, eligible, resolve, memberships, disabled, admission, pool, audit, append, store, sessions, context, browser, writer, options, saved, proposal, apply, commit, effects, advance, refresh,
    time: (ms: number) => { time += ms; }, elapsed: (ms: number) => { monotonic += ms; }, stop: () => { current = false; }, changed: () => { bodyVersion++; } };
}
describe("inactive SQL role writer", () => {
  it("uses real auxiliary-admin sessions rather than the root-only display flag, then commits one audited CAS/epoch", async () => {
    const w = await fixture(); await expect(w.browser.ctx.requireAdmin()).rejects.toMatchObject({ code: "denied" });
    const p = w.proposal(), before = w.saved(), preview = await w.writer.preview(p, w.browser.ctx); expect(preview.ok).toBe(true);
    expect(w.saved()).toEqual(before); expect(w.advance).not.toHaveBeenCalled(); expect(w.commit).not.toHaveBeenCalled();
    if (!preview.ok) throw Error("preview refused"); w.time(10);
    expect(await w.writer.apply(p, preview.previewDigest, w.browser.ctx)).toMatchObject({ ok: true, revision: 2 });
    expect(w.saved().assignments.find(a => a.id === "member1")).toMatchObject({ assignedBy: w.actor, assignedAt: 110 });
    expect(w.advance).toHaveBeenCalledOnce(); expect(w.refresh).toHaveBeenCalledOnce(); expect(w.commit).toHaveBeenCalledOnce();
    expect((w.db.prepare("SELECT actor FROM hub_audit WHERE action='role.policy-changed'").all() as { actor: string }[]).map(r => JSON.parse(r.actor))).toEqual([{ kind: "person", person: w.actor }]);
    expect(w.audit.verifyChain()).toMatchObject({ ok: true }); expect(w.admission).toHaveBeenCalled();
    expect(await w.writer.apply(p, preview.previewDigest, w.browser.ctx)).toMatchObject({ ok: false, code: "stale-preview" });
  });
  it.each(["body", "session", "ended", "policy", "epoch", "resources", "expired", "backwards", "membership"] as const)("consumes the preview and refuses changed %s", async change => {
    const w = await fixture(), p = w.proposal(), before = w.saved(), preview = await w.writer.preview(p, w.browser.ctx); if (!preview.ok) throw Error("preview refused");
    let ctx: HubRequestContext = w.browser.ctx;
    if (change === "body") p.assignments.at(-1)!.maxFleets = 0;
    if (change === "session") ctx = (await w.context()).ctx;
    if (change === "ended") w.sessions.signOut(w.browser.token);
    if (change === "policy") w.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify({ ...before, revision: 2 }));
    if (change === "epoch") w.advance(w.db);
    if (change === "resources") w.changed();
    if (change === "expired") w.time(120_000);
    if (change === "backwards") w.time(-1);
    if (change === "membership") w.memberships.set(w.actor.objectId, [w.group.objectId]);
    expect(await w.writer.apply(p, preview.previewDigest, ctx)).toMatchObject({ ok: false });
    expect(w.saved()).toEqual(change === "policy" ? { ...before, revision: 2 } : before); expect(w.commit).not.toHaveBeenCalled(); expect(w.refresh).not.toHaveBeenCalled();
    expect(await w.writer.apply(p, preview.previewDigest, w.browser.ctx)).toMatchObject({ ok: false });
  });
  it("audits denied self-grants and ineligible targets without touching policy", async () => {
    const w = await fixture(), before = w.saved(), self = w.proposal(); self.assignments.at(-1)!.subject = { kind: "person", person: w.actor };
    expect(await w.writer.preview(self, w.browser.ctx)).toMatchObject({ ok: false, code: "self-target" });
    w.disabled.add(w.target.objectId); expect(await w.writer.preview(w.proposal(), w.browser.ctx)).toMatchObject({ ok: false, code: "denied" });
    expect(w.saved()).toEqual(before); expect(w.db.prepare("SELECT id FROM hub_audit WHERE action='role.write-refused'").all()).toHaveLength(2);
  });
  it("fences an actual sign-out while a physical directory read is held, and retains its shared-pool slot", async () => {
    const w = await fixture(), entered = gate<void>(), release = gate<PolicyGroupFacts>(), before = w.saved();
    w.read.mockImplementationOnce(() => { entered.resolve(); return release.promise; }); const pending = w.writer.preview(w.proposal(), w.browser.ctx); await entered.promise;
    const blockers = [gate<void>(), gate<void>(), gate<void>()], otherReads = blockers.map(b => w.pool.withDirectoryRead(w.actor, () => b.promise));
    await expect(w.pool.withDirectoryRead(w.actor, async () => undefined)).rejects.toBeTruthy();
    w.sessions.signOut(w.browser.token); release.resolve({ kind: "complete", person: w.actor, groups: [], observedAt: 100 });
    expect(await pending).toMatchObject({ ok: false }); for (const b of blockers) b.resolve(); await Promise.all(otherReads);
    expect(w.saved()).toEqual(before); expect(w.commit).not.toHaveBeenCalled();
  });
  it.each(["audit", "async-audit", "final-session", "final-policy", "final-epoch", "effects"] as const)("rolls back policy, notices and effects on %s failure", async mode => {
    const w = await fixture(), before = w.saved(), p = w.proposal(), preview = await w.writer.preview(p, w.browser.ctx); if (!preview.ok) throw Error("preview refused");
    w.append.mockImplementation((event, tx) => {
      if (event.action !== "role.policy-changed") return w.audit.appendInTransaction(event, tx);
      if (mode === "audit") throw Error("audit offline");
      if (mode === "async-audit") { w.audit.appendInTransaction(event,tx); return Promise.resolve() as never; }
      w.audit.appendInTransaction(event, tx);
      if (mode === "final-session") w.sessions.signOut(w.browser.token);
      if (mode === "final-policy") tx.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify({ ...before, revision: 90 }));
      if (mode === "final-epoch") w.advance(tx);
    });
    if (mode === "effects") w.commit.mockImplementation(tx => { tx.prepare("UPDATE synthetic_resources SET state='suspended'").run(); throw Error("effect failure"); });
    expect(await w.writer.apply(p, preview.previewDigest, w.browser.ctx)).toMatchObject({ ok: false });
    expect(w.saved()).toEqual(before); expect(w.db.prepare("SELECT * FROM hub_role_notices").all()).toEqual([]);
    expect(w.db.prepare("SELECT state FROM synthetic_resources").get()).toEqual({ state: "active" }); expect(w.refresh).not.toHaveBeenCalled();
  });
  it("records management notices for every effective admin and ends access after role loss", async () => {
    const w = await fixture(), p = w.proposal(); p.assignments.at(-1)!.roleId = BUILTIN_ROLE_IDS.admin;
    expect(await w.apply(p)).toMatchObject({ ok: true });
    const recipients = (w.db.prepare("SELECT person FROM hub_role_notices ORDER BY person").all() as { person: string }[]).map(r => r.person);
    expect(recipients.sort()).toEqual([w.root, w.actor, w.target].map(p => `${p.realm}/${p.objectId}`).sort());
    const next = w.saved(); next.assignments = next.assignments.filter(a => a.subject.kind !== "person" || a.subject.person.objectId !== w.target.objectId);
    expect(await w.apply(next)).toMatchObject({ ok: true });
    const removed = await w.context(w.target);
    expect(await w.writer.notices(removed.ctx)).toMatchObject({ ok: false, code: "denied" });
    const visible = await w.writer.notices(w.browser.ctx); expect(visible.ok).toBe(true);
    if (!visible.ok) throw Error("notice read refused"); expect(visible.notices).toHaveLength(2);
    expect(await w.writer.acknowledge(visible.notices[0]!.id, w.browser.ctx)).toEqual({ ok: true });
    expect(await w.writer.acknowledge(visible.notices[0]!.id, w.browser.ctx)).toEqual({ ok: true });
    expect(w.db.prepare("SELECT id FROM hub_audit WHERE action='role.notice-acknowledged'").all()).toHaveLength(1);
    const outsider = await w.context(w.other); expect(await w.writer.acknowledge(visible.notices[0]!.id, outsider.ctx)).toMatchObject({ ok: false, code: "denied" });
    const r = await w.writer.notices(w.browser.ctx); if (!r.ok) throw Error("notice read refused"); expect(r.notices).toHaveLength(1);
    const rootBrowser = await w.context(w.root), rootNotices = await w.writer.notices(rootBrowser.ctx);
    if(!rootNotices.ok) throw Error("root notice read refused"); expect(rootNotices.notices).toHaveLength(2);
  });
  it("refuses group-administrator documents at both proposal and notice boundaries", async () => {
    const w = await fixture(), p = w.proposal();
    p.assignments.at(-1)!.roleId = BUILTIN_ROLE_IDS.admin;
    p.assignments.at(-1)!.subject = { kind: "group", group: w.group, dn: "CN=Admins,DC=test" };
    w.memberships.set(w.target.objectId, [w.group.objectId]);
    expect(await w.writer.preview(p, w.browser.ctx)).toMatchObject({ ok: false, code: "invalid" });
    expect(w.saved().revision).toBe(1); expect(w.commit).not.toHaveBeenCalled();
    // A corrupt/externally written row must not manufacture the unsupported administrator shape.
    w.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(p));
    const member = await w.context(w.target);
    expect(await w.writer.notices(member.ctx)).toMatchObject({ ok: false, code: "invalid" });
    expect(await w.writer.acknowledge("synthetic-notice", member.ctx)).toMatchObject({ ok: false });
    expect(w.db.prepare("SELECT * FROM hub_role_notices").all()).toEqual([]);
  });
  it("includes a personal administrator outside inventory and proves current authority for read and acknowledgement", async () => {
    const w = await fixture(), p = w.proposal(); p.assignments.at(-1)!.roleId = BUILTIN_ROLE_IDS.admin;
    const original = w.effects.snapshot;
    vi.spyOn(w.effects, "snapshot").mockImplementation(() => ({ ...original(), people: [w.actor] }));
    expect(await w.apply(p)).toMatchObject({ ok: true });
    const target = await w.context(w.target), result = await w.writer.notices(target.ctx);
    if (!result.ok) throw Error("current administrator notice refused"); expect(result.notices).toHaveLength(1);
    expect(await w.writer.acknowledge(result.notices[0]!.id, target.ctx)).toEqual({ ok: true });
    const next = w.saved(); next.assignments = next.assignments.filter(a => a.id !== "member1");
    expect(await w.apply(next)).toMatchObject({ ok: true });
    expect(await w.writer.notices(target.ctx)).toMatchObject({ ok: false, code: "denied" });
    expect(await w.writer.acknowledge(result.notices[0]!.id, target.ctx)).toMatchObject({ ok: false, code: "denied" });
  });
  it("reserves root-self assignment ids without obstructing the genuine root operation", async () => {
    const w = await fixture(), p = w.proposal(); p.assignments.at(-1)!.id = `root-self:${w.root.objectId}`;
    expect(await w.writer.preview(p, w.browser.ctx)).toMatchObject({ ok: false, code: "invalid" });
    expect(w.saved().revision).toBe(1); expect(w.commit).not.toHaveBeenCalled();
    const root = await w.context(w.root);
    expect(await w.writer.previewRootSelf(root.ctx)).toMatchObject({ ok: true });
  });
  it("keeps root self-use out of migration and permits only its once-only separate previewed operation", async () => {
    const w = await fixture(), rootBrowser = await w.context(w.root), before = w.saved();
    expect(before.assignments.some(a => a.subject.kind === "person" && a.subject.person.objectId === w.root.objectId)).toBe(false);
    expect(await w.writer.previewRootSelf(w.browser.ctx)).toMatchObject({ ok: false, code: "denied" });
    const preview = await w.writer.previewRootSelf(rootBrowser.ctx); expect(preview.ok).toBe(true); if (!preview.ok) throw Error("root preview refused");
    expect(w.saved()).toEqual(before);
    expect(await w.writer.applyRootSelf(preview.previewDigest, rootBrowser.ctx)).toMatchObject({ ok: true, revision: 2 });
    const saved = w.saved(), own = saved.assignments.find(a => a.subject.kind === "person" && a.subject.person.objectId === w.root.objectId)!;
    expect(own).toMatchObject({ scope: { kind: "hub" }, maxFleets: 8, assignedBy: w.root });
    expect(saved.roles.find(r => r.id === own.roleId)!.permissions.sort()).toEqual(["ask_agents", "pair_fleet", "publish_agents"]);
    expect(saved.state).toBe(before.state); expect(saved.rolesActive).toBe(before.rolesActive); expect(saved.denies).toEqual(before.denies);
    expect(w.db.prepare("SELECT person FROM hub_role_root_self").all()).toEqual([{ person: `${w.root.realm}/${w.root.objectId}` }]);
    expect(w.db.prepare("SELECT id FROM hub_audit WHERE action='role.root-self-use-activated'").all()).toHaveLength(1);
    expect(w.db.prepare("SELECT id FROM hub_role_notices").all()).toHaveLength(2);
    expect(await w.writer.previewRootSelf(rootBrowser.ctx)).toMatchObject({ ok: false, code: "conflict" });
    const forged = w.saved(); forged.assignments.push(a("root-generic", w.root));
    expect(await w.writer.preview(forged, rootBrowser.ctx)).toMatchObject({ ok: false, code: "self-target" });
    const revoked = w.saved(); revoked.assignments = revoked.assignments.filter(a => a.id !== own.id); revoked.roles = revoked.roles.filter(r => r.id !== own.roleId);
    expect(await w.apply(revoked)).toMatchObject({ok:true});
    expect(await w.writer.previewRootSelf(rootBrowser.ctx)).toMatchObject({ok:false,code:"conflict"});
  });
  it("cannot smuggle another permission, subject or scope through the named root operation", async () => {
    const w = await fixture(), rootBrowser = await w.context(w.root), p = w.saved();
    p.roles.push({ id: `root-self:${w.root.objectId}`, name: "Forged", kind: "custom", permissions: ["join.manage"], defaultMaxFleets: 8 });
    expect(await w.writer.preview(p, rootBrowser.ctx)).toMatchObject({ ok: false, code: "invalid" });
    const preview = await w.writer.previewRootSelf(rootBrowser.ctx); if (!preview.ok) throw Error("root preview refused");
    expect(await w.writer.apply(w.proposal(), preview.previewDigest, rootBrowser.ctx)).toMatchObject({ ok: false, code: "stale-preview" });
    expect(w.saved().revision).toBe(1); expect(w.db.prepare("SELECT * FROM hub_role_root_self").all()).toEqual([]);
    expect(await w.writer.applyRootSelf(preview.previewDigest, rootBrowser.ctx)).toMatchObject({ ok: false });
  });

  it.each(["during-effects", "during-audit"] as const)("refuses authority expiry %s with the original deadline and full rollback", async when => {
    const w = await fixture(), before = w.saved(); before.assignments[0]!.expiresAt = 200;
    w.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(before));
    const p = w.proposal(), preview = await w.writer.preview(p,w.browser.ctx); if(!preview.ok) throw Error("preview refused");
    if(when === "during-effects") {
      const original = w.effects.prepare; vi.spyOn(w.effects,"prepare").mockImplementation(async (...args) => { const result = await original(...args); w.time(100); return result; });
    } else w.append.mockImplementation((event,tx) => { w.audit.appendInTransaction(event,tx); if(event.action === "role.policy-changed") w.time(100); });
    expect(await w.writer.apply(p,preview.previewDigest,w.browser.ctx)).toMatchObject({ok:false});
    expect(w.saved()).toEqual(before); expect(w.refresh).not.toHaveBeenCalled();
  });
  it.each(["fingerprint","impact","changed"] as const)("binds unseen effect-plan %s and consumes malformed apply attempts", async field => {
    const w = await fixture(), p = w.proposal(), preview = await w.writer.preview(p,w.browser.ctx); if(!preview.ok) throw Error("preview refused");
    const original = w.effects.prepare; vi.spyOn(w.effects,"prepare").mockImplementation(async (...args) => ({...await original(...args),[field]:field === "fingerprint" ? "a different effect with the same public impact" : field === "impact" ? {unseen:"a different impact"} : true}));
    expect(await w.writer.apply(p,preview.previewDigest,w.browser.ctx)).toMatchObject({ok:false,code:"stale-preview"});
    const next = await w.writer.preview(p,w.browser.ctx); if(!next.ok) throw Error("preview refused");
    expect(await w.writer.apply({unexpected:true},next.previewDigest,w.browser.ctx)).toMatchObject({ok:false});
    expect(await w.writer.apply(p,next.previewDigest,w.browser.ctx)).toMatchObject({ok:false,code:"stale-preview"});
  });
  it("advances the epoch for retained-resource changes even when the policy itself is unchanged", async () => {
    const w = await fixture(), p = w.saved();
    vi.spyOn(w.effects,"prepare").mockImplementation(async () => ({fingerprint:"suspend one retained resource",changed:true,impact:{suspended:["resource1"]},assertCurrent(){},
      commit(tx) { tx.prepare("UPDATE synthetic_resources SET state='suspended'").run(); },
      assertCommitted() { expect(w.db.prepare("SELECT state FROM synthetic_resources").get()).toEqual({state:"suspended"}); } }));
    expect(await w.apply(p)).toMatchObject({ok:true,revision:1}); expect(w.advance).toHaveBeenCalledOnce(); expect(w.refresh).toHaveBeenCalledOnce();
    expect(w.saved()).toEqual(p);
  });
  it.each(["marker", "audit"] as const)("rolls back the isolated root activation on %s failure", async mode => {
    const w = await fixture(), browser = await w.context(w.root), before = w.saved(), preview = await w.writer.previewRootSelf(browser.ctx);
    if(!preview.ok) throw Error("root preview refused");
    w.append.mockImplementation((event,tx) => { w.audit.appendInTransaction(event,tx); if(event.action === "role.root-self-use-activated") {
      if(mode === "audit") throw Error("required audit unavailable");
      tx.prepare("INSERT INTO hub_role_root_self VALUES(?,?,?,?)").run(`${w.root.realm}/${w.root.objectId}`,"foreign-role","foreign-assignment",event.id);
    } });
    expect(await w.writer.applyRootSelf(preview.previewDigest,browser.ctx)).toMatchObject({ok:false});
    expect(w.saved()).toEqual(before); expect(w.db.prepare("SELECT * FROM hub_role_root_self").all()).toEqual([]); expect(w.db.prepare("SELECT * FROM hub_role_notices").all()).toEqual([]);
  });

  it.each([-1,19_999,20_000])("checks the monotonic preparation budget even with unchanged wall time (%s)",async elapsed => {
    const w=await fixture(),p=w.proposal(),preview=await w.writer.preview(p,w.browser.ctx);if(!preview.ok)throw Error("preview refused");
    const original=w.effects.prepare;vi.spyOn(w.effects,"prepare").mockImplementation(async(...args)=>{const result=await original(...args);w.elapsed(elapsed);return result;});
    expect(await w.writer.apply(p,preview.previewDigest,w.browser.ctx)).toMatchObject({ok:elapsed===19_999});
    expect(w.saved().revision).toBe(elapsed===19_999 ? 2 : 1);
  });

  it.each(["commit","proof"] as const)("refuses a thenable resource %s and rolls back its synchronous prelude",async mode => {
    const w=await fixture(),p=w.proposal(),preview=await w.writer.preview(p,w.browser.ctx);if(!preview.ok)throw Error("preview refused");
    if(mode === "commit") w.commit.mockImplementation(tx => {tx.prepare("UPDATE synthetic_resources SET state='suspended'").run();return Promise.resolve() as never;});
    else { const original=w.effects.prepare;vi.spyOn(w.effects,"prepare").mockImplementation(async(...args)=>({...await original(...args),assertCommitted(){return Promise.resolve() as never;}})); }
    expect(await w.writer.apply(p,preview.previewDigest,w.browser.ctx)).toMatchObject({ok:false});
    expect(w.saved().revision).toBe(1);expect(w.db.prepare("SELECT state FROM synthetic_resources").get()).toEqual({state:"active"});expect(w.refresh).not.toHaveBeenCalled();
  });

  it("refuses a person without delegation authority before full inventory or other-person reads",async()=>{
    const w=await fixture(),outsider=await w.context(w.other),snapshot=vi.spyOn(w.effects,"snapshot");w.read.mockClear();
    expect(await w.writer.preview(w.proposal(),outsider.ctx)).toMatchObject({ok:false,code:"denied"});
    expect(snapshot).not.toHaveBeenCalled();expect(w.read.mock.calls.map(([p])=>p)).toEqual([w.other]);
  });

  it("reports a post-commit refresh failure as uncertain without recording the committed write as refused",async()=>{
    const w=await fixture(),p=w.proposal(),preview=await w.writer.preview(p,w.browser.ctx);if(!preview.ok)throw Error("preview refused");
    w.refresh.mockImplementation(()=>{throw Error("postcommit refresh unavailable");});
    expect(await w.writer.apply(p,preview.previewDigest,w.browser.ctx)).toEqual({ok:false,code:"unavailable"});
    expect(w.saved().revision).toBe(2);expect(w.db.prepare("SELECT id FROM hub_audit WHERE action='role.policy-changed'").all()).toHaveLength(1);
    expect(w.db.prepare("SELECT id FROM hub_audit WHERE action='role.write-refused'").all()).toHaveLength(0);
  });

  it("refuses an oversized private impact before retaining a candidate or writing policy",async()=>{
    const w=await fixture(),original=w.effects.prepare;vi.spyOn(w.effects,"prepare").mockImplementation(async(...args)=>({...await original(...args),impact:{data:"x".repeat(256*1024)}}));
    expect(await w.writer.preview(w.proposal(),w.browser.ctx)).toMatchObject({ok:false,code:"unknown"});expect(w.saved().revision).toBe(1);
  });

});
