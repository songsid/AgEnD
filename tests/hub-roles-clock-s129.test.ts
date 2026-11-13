/** Real cutover/SQL/audit/transport; synthetic expiry rows, no settlement effects or runtime activation. */
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { applyHubMigrations, bindHubInstance } from "../src/hub/db.js";
import { createHubAudit } from "../src/hub/audit/index.js";
import { HubTransportStore } from "../src/hub/store.js";
import { createHubRoleCutover } from "../src/hub/roles/cutover.js";
import { createHubRoleAuthorizationClock } from "../src/hub/roles/clock.js";
import { createHubManagementAuthority } from "../src/hub/roles/authority.js";
import { createHubCanonicalPolicyReader } from "../src/hub/roles/read.js";
import { createHubDirectoryAdmission } from "../src/hub/directory/admission.js";
import { roleCutoverLegacyPlan } from "./support/hub-role-cutover-plan.js";
const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function fixture() {
  const db = new Database(":memory:"); dbs.push(db); db.pragma("foreign_keys=ON");
  const hubId = randomUUID(), root = { realm: "corp", objectId: randomUUID() }, migrations = roleCutoverLegacyPlan(hubId);
  let at = 100, live = true, floor = 0;
  applyHubMigrations(db, migrations); bindHubInstance(db, hubId, "new", at);
  db.prepare("UPDATE hub_group_policy SET body=json_set(body,'$.revision',7)").run();
  const audit = createHubAudit({ db, contentKey: randomBytes(32), now: () => at });
  const transport = new HubTransportStore(db, { floor: { read: () => floor, raise: value => { floor = value; } },
    appendAudit(event, tx) { audit.appendInTransaction(event, tx); } }); transport.initialize();
  expect(createHubRoleCutover({ db, hubId, root, realm: "corp", generation: "g1", migrations, transport,
    current: () => live, now: () => at, refreshAuthorization() {} }).migrate()).toMatchObject({ ok: true, changed: true });
  const options = { db, hubId, root, realm: "corp", generation: "g1", transport, current: () => live, now: () => at };
  const clock = createHubRoleAuthorizationClock(options);
  const term = (settledAt: number) => db.prepare("INSERT INTO hub_role_expiry_terms VALUES(?,?,?,?,?)")
    .run(randomUUID(), randomUUID(), settledAt, randomUUID(), settledAt);
  return { db, hubId, root, options, clock, audit, transport, term, time: (value: number) => { at = value; }, stop: () => { live = false; },
    raiseFloor: () => { floor++; } };
}
describe("S129 real authorization clock floors", () => {
  it("accepts the actual cutover at its exact time without reading resource effects or rewriting SQL", () => {
    const w = fixture(), before = w.db.serialize();
    expect(() => w.clock.assertAuthorizationTime()).not.toThrow(); expect(w.db.serialize()).toEqual(before);
  });
  it("refuses a cutover-time rollback even when no expiry has ever settled, including after reopen", () => {
    const w = fixture(); w.time(99);
    expect(() => w.clock.assertAuthorizationTime()).toThrow();
    expect(() => createHubRoleAuthorizationClock(w.options).assertAuthorizationTime()).toThrow();
    w.time(100); expect(() => createHubRoleAuthorizationClock(w.options).assertAuthorizationTime()).not.toThrow();
  });
  it("retains the later expiry clock floor across audit retention and reopen", () => {
    const w = fixture(); w.term(200); w.time(200); expect(() => w.clock.assertAuthorizationTime()).not.toThrow();
    w.time(2 * 86_400_000); expect(w.audit.purge({ contentDays: 1, eventDays: 1 }).events).toBeGreaterThan(0); w.time(199);
    expect(() => createHubRoleAuthorizationClock(w.options).assertAuthorizationTime()).toThrow();
    w.time(200); expect(() => createHubRoleAuthorizationClock(w.options).assertAuthorizationTime()).not.toThrow();
  });
  it.each(["missing", "corrupt", "old-digest", "converted-digest", "foreign-hub", "foreign-root", "inventory", "transport-marker", "authorization-marker", "writer-schema", "expiry-schema"] as const)(
    "refuses %s marker/registry state without writes", mode => {
      const w = fixture();
      if (mode === "missing") w.db.exec("DELETE FROM hub_role_cutover");
      else if (mode === "corrupt") w.db.prepare("UPDATE hub_role_cutover SET body='bad'").run();
      else if (mode === "writer-schema" || mode === "expiry-schema") w.db.prepare("DELETE FROM hub_schema WHERE component=?").run(mode === "writer-schema" ? "roles-writer" : "roles-expiry");
      else {
        const m = JSON.parse((w.db.prepare("SELECT body FROM hub_role_cutover").get() as { body: string }).body);
        if (mode === "old-digest") m.oldDigest = "0".repeat(64);
        if (mode === "converted-digest") m.roleDigest = "0".repeat(64);
        if (mode === "foreign-hub") m.hubId = randomUUID();
        if (mode === "foreign-root") m.root.objectId = randomUUID();
        if (mode === "inventory") m.inventory.digest = "0".repeat(64);
        if (mode === "transport-marker") m.transportRevision++;
        if (mode === "authorization-marker") m.authorizationVersion++;
        w.db.prepare("UPDATE hub_role_cutover SET body=?").run(JSON.stringify(m));
      }
      const before = w.db.serialize(); expect(() => w.clock.assertAuthorizationTime()).toThrow(); expect(w.db.serialize()).toEqual(before);
    });
  it("keeps the historical marker after legitimate policy edits and a directory-generation rebind", () => {
    const w = fixture(), p = JSON.parse((w.db.prepare("SELECT body FROM hub_group_policy").get() as { body: string }).body);
    p.revision++; p.rolesActive = false; p.generation = "g2";
    w.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(p));
    expect(() => w.clock.assertAuthorizationTime()).toThrow();
    expect(() => createHubRoleAuthorizationClock({ ...w.options, generation: "g2" }).assertAuthorizationTime()).not.toThrow();
  });
  it.each(["floor", "version", "policy-revision", "owner", "lifetime", "close", "invalid-time"] as const)("refuses %s loss", mode => {
    const w = fixture();
    if (mode === "floor") w.raiseFloor();
    if (mode === "version") w.db.prepare("UPDATE hub_transport_state SET state=json_set(state,'$.revocationVersion',0)").run();
    if (mode === "policy-revision") w.db.prepare("UPDATE hub_group_policy SET body=json_set(body,'$.revision',1)").run();
    if (mode === "owner") w.db.prepare("UPDATE hub_instance SET hub_id=?").run(randomUUID());
    if (mode === "lifetime") w.stop();
    if (mode === "close") w.clock.close();
    if (mode === "invalid-time") w.time(NaN);
    expect(() => w.clock.assertAuthorizationTime()).toThrow();
  });
  it("refuses a substituted transport reader even if it returns the same valid state", () => {
    const w = fixture(), original = w.transport.read; w.transport.read = original.bind(w.transport);
    try { expect(() => w.clock.assertAuthorizationTime()).toThrow(); } finally { w.transport.read = original; }
  });
  it.each(["policy", "owner", "marker", "settled", "transport"] as const)("refuses %s replacement inside the clock callback", mode => {
    const w = fixture(); let changed = false;
    const clock = createHubRoleAuthorizationClock({ ...w.options, now() {
      if (!changed) {
        changed = true;
        if (mode === "policy") w.db.prepare("UPDATE hub_group_policy SET body=json_set(body,'$.rolesActive',json('false'))").run();
        if (mode === "owner") w.db.prepare("UPDATE hub_instance SET hub_id=?").run(randomUUID());
        if (mode === "marker") w.db.exec("DELETE FROM hub_role_cutover");
        if (mode === "settled") w.term(200);
        if (mode === "transport") w.db.prepare("UPDATE hub_transport_state SET state=json_set(state,'$.revocationVersion',0)").run();
      }
      return 100;
    } });
    expect(() => clock.assertAuthorizationTime()).toThrow(); expect(changed).toBe(true);
  });
  it("retires an actual issuer proof on a new persisted floor without reviving that proof when time recovers", async () => {
    const w = fixture(), reads = createHubDirectoryAdmission(() => true);
    const authority = createHubManagementAuthority({ root: w.root, policy: createHubCanonicalPolicyReader(w.options),
      directory: { realm: "corp", async checkEligibility(who) { return { eligible: true, person: { key: who, login: "root", dn: "synthetic", groups: [] } }; } },
      reads, current: w.options.current, version: () => w.transport.read().revocationVersion,
      assertAuthorizationTime: w.clock.assertAuthorizationTime, now: w.options.now, elapsedNow: () => 0 });
    const proof = await authority.requireJoinIssuer(w.root, { requestId: "real-clock", current: () => true });
    w.term(200); w.time(199); expect(() => proof.assertCurrent()).toThrow();
    w.time(200); expect(() => proof.assertCurrent()).toThrow();
    expect((await authority.requireJoinIssuer(w.root, { requestId: "fresh-clock", current: () => true })).source).toBe("roles");
    authority.close(); await reads.drain();
  });
});
