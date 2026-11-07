import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { applyHubMigrations } from "../src/hub/db.js";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import { createHubGroupPolicyStore, groupPolicyMigration } from "../src/hub/group-policy/store.js";
import { createHubGroupResources, HUB_GROUP_RESOURCES_MIGRATION, type HubGroupResource } from "../src/hub/group-policy/resources.js";
import type { HubDirectory } from "../src/hub/directory/types.js";
import type { PolicyGroupFacts } from "../src/hub/directory/groups.js";
const owner = { realm: "example", objectId: "11111111-1111-4111-8111-111111111111" }, group = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const resource: HubGroupResource = { kind: "exposure", id: "exposure-1", revision: 3, owner };
const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function fixture() {
  const db = new Database(":memory:"); databases.push(db); db.pragma("foreign_keys=ON");
  applyHubMigrations(db, [HUB_AUDIT_MIGRATION, groupPolicyMigration("hub-1", "example", "generation-1"), HUB_GROUP_RESOURCES_MIGRATION]);
  const audit = createHubAudit({ db, contentKey: randomBytes(32), now: () => 100 });
  const read = vi.fn(async (): Promise<PolicyGroupFacts> => ({ kind: "complete", person: owner, groups: [group], observedAt: 100 }));
  const append = vi.fn((...args: Parameters<typeof audit.appendInTransaction>) => audit.appendInTransaction(...args));
  let live = true;
  const current = () => live;
  const policy = createHubGroupPolicyStore({ db, hubId: "hub-1", realm: "example", generation: "generation-1", directory: {
    realm: "example", groupPolicy: "ad-direct-guid", readPolicyGroups: read,
  } as unknown as HubDirectory, audit, current, now: () => 100 });
  const resources = createHubGroupResources({ db, policy, audit: { appendInTransaction: append }, current, now: () => 100 });
  const ctx = { requestId: "request-1", current: () => true };
  const enable = () => policy.replace({ ...policy.read(), state: "enabled", groups: [{ group: { realm: "example", objectId: group }, dn: "CN=Owners,DC=example,DC=test", allow: ["ask_agents", "publish_agents", "pair_fleet"], maxFleets: 1 }] }, owner, ctx);
  const negative = () => read.mockResolvedValueOnce({ kind: "complete", person: owner, groups: [other], observedAt: 100 });
  return { db, policy, resources, audit, append, read, ctx, enable, negative, stop: () => { live = false; } };
}
function held<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const events = (db: Database.Database) => db.prepare("SELECT body FROM hub_group_resource_events ORDER BY rowid").all() as { body: string }[];

describe("group-derived resource suspension, separate from underlying consent and grants", () => {
  it("grandfathers only a pre-enable exact manual revision; other revisions and new manual capture refuse", async () => {
    const f = fixture(); f.resources.captureManual(resource, f.ctx); f.enable(); f.negative();
    expect(await f.resources.check(resource, f.ctx)).toEqual({ outcome: "allow" }); expect(f.read).not.toHaveBeenCalled();
    await expect(f.resources.check({ ...resource, revision: 4 }, f.ctx)).rejects.toThrow("group_policy_invalid");
    expect(() => f.resources.captureManual({ ...resource, revision: 4 }, f.ctx)).toThrow("group_policy_invalid");
    expect(f.resources.read(resource)).toMatchObject({ source: "manual", state: "active", revision: 1 });
  });
  it("grandfathering preserves membership exemption but an explicit deny suspends the exact manual revision", async () => {
    const f = fixture(); f.resources.captureManual(resource, f.ctx); f.enable();
    f.policy.replace({ ...f.policy.read(), groups: [] }, owner, f.ctx);
    expect(await f.resources.check(resource, f.ctx)).toEqual({ outcome: "allow" });
    f.policy.replace({ ...f.policy.read(), denies: [{ person: owner, deny: ["publish_agents"] }] }, owner, f.ctx);
    expect(await f.resources.check(resource, f.ctx)).toEqual({ outcome: "deny" });
    expect(f.resources.read(resource)).toMatchObject({ source: "manual", state: "suspended", revision: 2 });
    expect(await f.resources.resume(resource, owner, f.ctx)).toEqual({ outcome: "deny" });
    f.policy.replace({ ...f.policy.read(), denies: [] }, owner, f.ctx);
    expect(await f.resources.check(resource, f.ctx)).toEqual({ outcome: "resume-required" });
    expect(await f.resources.resume(resource, owner, f.ctx)).toEqual({ outcome: "allow" });
    expect(f.resources.read(resource)).toMatchObject({ source: "manual", state: "active", revision: 3 });
    expect(f.read).not.toHaveBeenCalled();
  });
  it("refuses lifecycle revision overflow before changing the record", async () => {
    const f = fixture(); f.enable(); await f.resources.register(resource, f.ctx);
    f.db.prepare("UPDATE hub_group_resources SET revision=?").run(Number.MAX_SAFE_INTEGER);
    f.negative(); await expect(f.resources.check(resource, f.ctx)).rejects.toThrow("group_policy_conflict");
    expect(f.resources.read(resource)).toMatchObject({ state: "active", revision: Number.MAX_SAFE_INTEGER });
  });
  it("cannot grandfather an asker or change the immutable resource owner", async () => {
    const f = fixture();
    expect(() => f.resources.captureManual({ ...resource, kind: "asker" }, f.ctx)).toThrow("group_policy_invalid");
    f.resources.captureManual(resource, f.ctx);
    expect(() => f.resources.read({ ...resource, owner: { ...owner, objectId: other } })).toThrow("group_policy_unavailable");
    f.enable(); await expect(f.resources.register({ ...resource, kind: "asker", owner: { ...owner, realm: "foreign" } }, f.ctx)).rejects.toThrow("group_policy_invalid");
  });
  it.each(["exposure", "fleet", "asker"] as const)("freshly checks the %s capability and audits each automatic allowance", async kind => {
    const f = fixture(); f.enable(); const r = { ...resource, kind };
    await f.resources.register(r, f.ctx); expect(await f.resources.check(r, f.ctx)).toMatchObject({ outcome: "allow" });
    expect(f.read).toHaveBeenCalledTimes(2);
    const cap = kind === "fleet" ? "pair-fleet" : kind === "exposure" ? "publish-agents" : "ask-agents";
    expect(f.db.prepare("SELECT COUNT(*) n FROM hub_audit WHERE action=?").get(`group-policy.${cap}`)).toEqual({ n: 2 });
    expect(f.audit.verifyChain()).toMatchObject({ ok: true, checked: 4 });
    expect(events(f.db).map(e => JSON.parse(e.body).payload)).toEqual([{ source: "group" }]);
  });
  it("refuses duplicate provenance, corrupt rows and stale resource owners rather than resetting them", async () => {
    const f = fixture(); f.enable(); await f.resources.register(resource, f.ctx);
    await expect(f.resources.register(resource, f.ctx)).rejects.toThrow("group_policy_conflict");
    f.db.prepare("UPDATE hub_group_resources SET body='{}'").run();
    expect(() => f.resources.read(resource)).toThrow();
  });
  it("does not register provenance without fresh group allowance or before enabling", async () => {
    const f = fixture(); await expect(f.resources.register(resource, f.ctx)).rejects.toThrow("group_policy_invalid");
    f.enable(); f.negative(); await expect(f.resources.register(resource, f.ctx)).rejects.toThrow("group_policy_unavailable");
    expect(f.resources.read(resource)).toBeNull(); expect(events(f.db)).toEqual([]);
  });
  it("denies unknown reads without state mutation; a complete negative suspends and restoration requires explicit resume", async () => {
    const f = fixture(); f.enable(); await f.resources.register(resource, f.ctx);
    const before = f.resources.read(resource), auditBefore = events(f.db).length;
    f.read.mockResolvedValueOnce({ kind: "unknown" });
    expect(await f.resources.check(resource, f.ctx)).toMatchObject({ outcome: "held" });
    expect(f.resources.read(resource)).toEqual(before); expect(events(f.db)).toHaveLength(auditBefore);
    expect(await f.resources.check(resource, f.ctx)).toMatchObject({ outcome: "allow" });
    f.negative(); expect(await f.resources.check(resource, f.ctx)).toMatchObject({ outcome: "deny" });
    expect(f.resources.read(resource)).toMatchObject({ state: "suspended", revision: 2 });
    expect(await f.resources.check(resource, f.ctx)).toMatchObject({ outcome: "resume-required" });
    expect(await f.resources.resume(resource, owner, f.ctx)).toMatchObject({ outcome: "allow" });
    expect(f.resources.read(resource)).toMatchObject({ state: "active", revision: 3 });
    expect(events(f.db).map(e => JSON.parse(e.body).payload)).toEqual([{ source: "group" }, { from: "active", to: "suspended" }, { from: "suspended", to: "active" }]);
    expect(f.audit.verifyChain()).toMatchObject({ ok: true });
  });
  it("unknown during resume never clears suspension; repeated negative causes no duplicate suspension event", async () => {
    const f = fixture(); f.enable(); await f.resources.register(resource, f.ctx); f.negative(); await f.resources.check(resource, f.ctx);
    const before = f.resources.read(resource), eventCount = events(f.db).length;
    f.negative(); await f.resources.check(resource, f.ctx);
    f.read.mockResolvedValueOnce({ kind: "unknown" });
    expect(await f.resources.resume(resource, owner, f.ctx)).toMatchObject({ outcome: "held" });
    expect(f.resources.read(resource)).toEqual(before); expect(events(f.db)).toHaveLength(eventCount);
  });
  it("an explicit switch-off suspension survives off/on, touches no manual resource, and never changes a fleet quota into a disconnect", async () => {
    const f = fixture(); f.resources.captureManual(resource, f.ctx); f.enable(); const fleet = { ...resource, id: "fleet-1", kind: "fleet" as const };
    await f.resources.register(fleet, f.ctx);
    f.db.transaction(() => { f.policy.replace({ ...f.policy.read(), state: "suspended" }, owner, f.ctx); expect(f.resources.suspendAll(f.ctx)).toBe(1); })();
    f.policy.replace({ ...f.policy.read(), state: "enabled" }, owner, f.ctx);
    expect(f.resources.read(resource)).toMatchObject({ source: "manual", state: "active" });
    expect(await f.resources.check(fleet, f.ctx)).toMatchObject({ outcome: "resume-required" });
    expect(f.resources.suspendAll(f.ctx)).toBe(0);
    // This library has no transport/fleet/grant mutation adapter; only its own lifecycle records exist.
    expect(f.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('hub_grants','hub_transport_state')").all()).toEqual([]);
  });
  it("reducing a positive fleet limit blocks no existing fleet lifecycle", async () => {
    const f = fixture(); f.enable();
    f.policy.replace({ ...f.policy.read(), groups: f.policy.read().groups.map(g => ({ ...g, maxFleets: 2 })) }, owner, f.ctx);
    const fleets = [1, 2].map(n => ({ ...resource, id: `fleet-${n}`, kind: "fleet" as const }));
    for (const fleet of fleets) await f.resources.register(fleet, f.ctx);
    f.policy.replace({ ...f.policy.read(), groups: f.policy.read().groups.map(g => ({ ...g, maxFleets: 1 })) }, owner, f.ctx);
    for (const fleet of fleets) {
      expect(await f.resources.check(fleet, f.ctx)).toMatchObject({ outcome: "allow", decision: { maxFleets: 1 } });
      expect(f.resources.read(fleet)).toMatchObject({ state: "active", revision: 1 });
    }
  });
  it("a foreign resume actor cannot acquire the configured administrator's authority", async () => {
    const f = fixture(); f.enable(); await f.resources.register(resource, f.ctx);
    await expect(f.resources.resume(resource, { ...owner, realm: "foreign" }, f.ctx)).rejects.toThrow("group_policy_invalid");
  });
  it("a policy change after a settled decision and one reentrantly inside audit both refuse the resource continuation", async () => {
    const f = fixture(); f.enable(); await f.resources.register(resource, f.ctx);
    const later = createHubGroupResources({ db: f.db, audit: f.audit, current: () => true, policy: {
      ...f.policy, async check(...args) {
        const decision = await f.policy.check(...args);
        f.policy.replace({ ...f.policy.read(), groups: [] }, owner, f.ctx);
        return decision;
      },
    } });
    await expect(later.check(resource, f.ctx)).rejects.toThrow("group_policy_conflict");
    f.enable(); f.negative(); const before = f.policy.read();
    f.append.mockImplementation((...args) => {
      f.audit.appendInTransaction(...args);
      f.policy.replace({ ...f.policy.read(), groups: [] }, owner, f.ctx);
    });
    await expect(f.resources.check(resource, f.ctx)).rejects.toThrow("group_policy_conflict");
    expect(f.policy.read()).toEqual(before); expect(f.resources.read(resource)).toMatchObject({ state: "active" });
  });
  it.each(["throw", "thenable", "authority-loss"])("rolls back resource registration when required audit has %s", async mode => {
    const f = fixture(); f.enable(); const before = events(f.db).length;
    f.append.mockImplementation((...args) => {
      f.audit.appendInTransaction(...args);
      if (mode === "throw") throw Error("fake disk failure");
      if (mode === "thenable") return Promise.resolve() as never;
      f.stop();
    });
    await expect(f.resources.register(resource, f.ctx)).rejects.toThrow();
    expect(f.db.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]); expect(events(f.db)).toHaveLength(before);
    expect(f.audit.verifyChain()).toMatchObject({ ok: true, checked: 2 }); // policy and fresh decision only
  });
  it("withholds registration if the caller's session is revoked synchronously by the required audit", async () => {
    const f = fixture(); f.enable(); let caller = true;
    f.append.mockImplementation((...args) => { f.audit.appendInTransaction(...args); caller = false; });
    await expect(f.resources.register(resource, { ...f.ctx, current: () => caller })).rejects.toThrow("group_policy_unavailable");
    expect(f.resources.read(resource)).toBeNull(); expect(events(f.db)).toEqual([]);
  });
  it("refuses a row replaced by required audit and rolls suspension plus audit back", async () => {
    const f = fixture(); f.enable(); await f.resources.register(resource, f.ctx); const before = f.resources.read(resource), n = events(f.db).length;
    f.append.mockImplementation((...args) => { f.audit.appendInTransaction(...args); f.db.prepare("UPDATE hub_group_resources SET revision=revision+1").run(); });
    f.negative(); await expect(f.resources.check(resource, f.ctx)).rejects.toThrow("group_policy_conflict");
    expect(f.resources.read(resource)).toEqual(before); expect(events(f.db)).toHaveLength(n);
  });
  it("snapshots the resource and resume actor before awaited membership and rejects caller loss", async () => {
    const f = fixture(); f.enable(); await f.resources.register(resource, f.ctx); f.negative(); await f.resources.check(resource, f.ctx);
    const h = held<PolicyGroupFacts>(); f.read.mockReturnValueOnce(h.promise);
    const mutable = structuredClone(resource), actor = { ...owner }, pending = f.resources.resume(mutable, actor, f.ctx);
    mutable.owner.objectId = other; mutable.id = "substitute"; actor.objectId = other;
    h.resolve({ kind: "complete", person: owner, groups: [group], observedAt: 100 }); expect(await pending).toMatchObject({ outcome: "allow" });
    const last = f.db.prepare("SELECT actor FROM hub_audit WHERE action='group-resource.resumed'").get() as { actor: string };
    expect(JSON.parse(last.actor)).toEqual({ kind: "person", person: owner });
    const h2 = held<PolicyGroupFacts>(); f.read.mockReturnValueOnce(h2.promise); let current = true;
    const later = f.resources.check(resource, { ...f.ctx, current: () => current }); current = false;
    h2.resolve({ kind: "unknown" }); await expect(later).rejects.toThrow("group_policy_unavailable");
  });
  it("rejects a resource revision or policy changed while a directory check waits", async () => {
    const f = fixture(); f.enable(); await f.resources.register(resource, f.ctx);
    const h = held<PolicyGroupFacts>(); f.read.mockReturnValueOnce(h.promise); const pending = f.resources.check(resource, f.ctx);
    f.resources.suspendAll(f.ctx); h.resolve({ kind: "complete", person: owner, groups: [group], observedAt: 100 });
    await expect(pending).rejects.toThrow("group_policy_conflict");
  });
});
