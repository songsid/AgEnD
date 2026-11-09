import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import { applyHubMigrations } from "../src/hub/db.js";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import { createHubGroupPolicyStore, groupPolicyMigration, inspectHubGroupPolicyBinding } from "../src/hub/group-policy/store.js";
import type { PolicyGroupFacts } from "../src/hub/directory/groups.js";
import type { HubDirectory } from "../src/hub/directory/types.js";
const user = { realm: "example", objectId: "11111111-1111-4111-8111-111111111111" }, group = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const dbs: Database.Database[] = [];
afterEach(() => { dbs.splice(0).forEach(db => db.close()); });
function fixture(support = true) {
  const db = new Database(":memory:"); dbs.push(db); db.pragma("foreign_keys=ON");
  applyHubMigrations(db, [HUB_AUDIT_MIGRATION, groupPolicyMigration("hub-1", "example", "generation-1")]);
  const audit = createHubAudit({ db, contentKey: randomBytes(32), now: () => 100 });
  const read = vi.fn(async (): Promise<PolicyGroupFacts> => ({ kind: "complete", person: { ...user }, groups: [group], observedAt: 100 }));
  let live = true;
  const directory = { realm: "example", groupPolicy: support ? "ad-direct-guid" : undefined, readPolicyGroups: read } as unknown as HubDirectory;
  const append = vi.fn((...args: Parameters<typeof audit.appendInTransaction>) => audit.appendInTransaction(...args));
  const options = { db, hubId: "hub-1", realm: "example", generation: "generation-1", directory, audit: { appendInTransaction: append }, current: () => live, now: () => 100 };
  const store = createHubGroupPolicyStore(options);
  const ctx = { requestId: "request-1", current: () => true, resource: { fleetId: "fleet-1" } };
  const enable = () => store.replace({ ...store.read(), state: "enabled", groups: [{ group: { realm: "example", objectId: group }, dn: "CN=Owners,DC=example,DC=test", allow: ["ask_agents", "pair_fleet"], maxFleets: 1 }] }, user, ctx);
  return { db, store, audit, read, append, options, ctx, enable, stop: () => { live = false; } };
}
function held<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const count = (db: Database.Database) => (db.prepare("SELECT COUNT(*) n FROM hub_audit").get() as { n: number }).n;

describe("durable Hub group-policy foundation", () => {
  it("defaults off, never looks up groups or grants new authority on the legacy path", async () => {
    const f = fixture(); expect(await f.store.check(user, "ask_agents", f.ctx)).toMatchObject({ outcome: "legacy" });
    expect(f.read).not.toHaveBeenCalled(); expect(count(f.db)).toBe(0);
  });
  it("commits policy and decision evidence in the real audit transaction", async () => {
    const f = fixture(); expect(f.enable().revision).toBe(2);
    expect(await f.store.check(user, "ask_agents", f.ctx)).toMatchObject({ outcome: "allow", groups: [group] });
    const rows = f.db.prepare("SELECT id, body FROM hub_group_events ORDER BY rowid").all() as { id: string; body: string }[];
    expect(rows).toHaveLength(2); expect(JSON.parse(rows[1]!.body)).toMatchObject({ generation: "generation-1", policyRevision: 2, fleetId: "fleet-1", payload: { person: user, capability: "ask_agents", observedAt: 100, groups: [group] } });
    expect(f.audit.verifyChain()).toMatchObject({ ok: true, checked: 2 });
    expect(f.db.prepare("SELECT reason_code FROM hub_audit WHERE id=?").get(rows[1]!.id)).toMatchObject({ reason_code: createHash("sha256").update(rows[1]!.body).digest("hex") });
  });
  it("requires AD support both to enable and to save groups; never breaks legacy sign-in", () => {
    const f = fixture(false); expect(() => f.enable()).toThrow("group_policy_unsupported");
    expect(() => f.store.replace({ ...f.store.read(), groups: [{ group: user, dn: "CN=Group,DC=example,DC=test", allow: [], maxFleets: 1 }] }, user, f.ctx)).toThrow("group_policy_unsupported");
    expect(f.store.read().state).toBe("never-enabled"); expect(count(f.db)).toBe(0);
  });
  it("cannot turn an enabled/suspended policy back into never-enabled legacy behavior", () => {
    const f = fixture(); f.enable();
    expect(() => f.store.replace({ ...f.store.read(), state: "never-enabled" }, user, f.ctx)).toThrow("group_policy_invalid");
    f.store.replace({ ...f.store.read(), state: "suspended" }, user, f.ctx);
    expect(() => f.store.replace({ ...f.store.read(), state: "never-enabled" }, user, f.ctx)).toThrow("group_policy_invalid");
  });
  it("rolls back both policy and audit on reentrant authority loss", () => {
    const f = fixture();
    f.append.mockImplementation((...args) => { f.audit.appendInTransaction(...args); f.stop(); });
    expect(() => f.enable()).toThrow("group_policy_unavailable");
    expect(count(f.db)).toBe(0); expect(f.db.prepare("SELECT COUNT(*) n FROM hub_group_events").get()).toEqual({ n: 0 });
  });
  it("refuses a policy row changed reentrantly during required audit and rolls everything back", () => {
    const f = fixture(), before = f.store.read();
    f.append.mockImplementation((...args) => {
      f.audit.appendInTransaction(...args);
      f.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify({ ...before, revision: 99 }));
    });
    expect(() => f.enable()).toThrow("group_policy_conflict");
    expect(f.store.read()).toEqual(before); expect(count(f.db)).toBe(0);
  });
  it.each(["throw", "thenable"])("never publishes an allowance when required audit is %s", async mode => {
    const f = fixture(); f.enable(); const before = count(f.db);
    f.append.mockImplementation((...args) => { f.audit.appendInTransaction(...args); if (mode === "throw") throw Error("fake disk failure"); return Promise.resolve() as never; });
    await expect(f.store.check(user, "ask_agents", f.ctx)).rejects.toThrow(); expect(count(f.db)).toBe(before);
    expect(f.store.read().revision).toBe(2);
  });
  it("outage refuses only the action and recovers with no resume, unlike complete negative", async () => {
    const f = fixture(); f.enable(); const before = f.store.read();
    f.read.mockResolvedValueOnce({ kind: "unknown" });
    expect(await f.store.check(user, "ask_agents", f.ctx)).toMatchObject({ outcome: "unknown", authoritative: false });
    expect(f.store.read()).toEqual(before);
    expect(await f.store.check(user, "ask_agents", f.ctx)).toMatchObject({ outcome: "allow" });
    f.read.mockResolvedValueOnce({ kind: "complete", person: user, groups: [], observedAt: 100 });
    expect(await f.store.check(user, "ask_agents", f.ctx)).toMatchObject({ outcome: "deny", authoritative: true });
    expect(f.store.read()).toEqual(before); // Resource suspension belongs to the later composed action slice.
  });
  it("rejects a result after policy changes while the directory is held", async () => {
    const f = fixture(); f.enable(); const h = held<PolicyGroupFacts>(); f.read.mockReturnValueOnce(h.promise);
    const pending = f.store.check(user, "ask_agents", f.ctx);
    f.store.replace({ ...f.store.read(), denies: [{ person: user, deny: ["ask_agents"] }] }, user, f.ctx);
    h.resolve({ kind: "complete", person: user, groups: [group], observedAt: 100 });
    await expect(pending).rejects.toThrow("group_policy_conflict"); expect(count(f.db)).toBe(2);
  });
  it("snapshots person/resource identity before the await and rechecks caller after it", async () => {
    const f = fixture(); f.enable(); const h = held<PolicyGroupFacts>(); f.read.mockReturnValueOnce(h.promise);
    const subject = { ...user }, ctx = { ...f.ctx, resource: { fleetId: "original-fleet" } };
    const pending = f.store.check(subject, "ask_agents", ctx);
    subject.objectId = group; ctx.resource.fleetId = "replacement-fleet";
    h.resolve({ kind: "complete", person: user, groups: [group], observedAt: 100 });
    expect(await pending).toMatchObject({ outcome: "allow" });
    const row = f.db.prepare("SELECT body FROM hub_group_events ORDER BY rowid DESC LIMIT 1").get() as { body: string };
    expect(JSON.parse(row.body)).toMatchObject({ fleetId: "original-fleet", payload: { person: user } });
    let current = true; const h2 = held<PolicyGroupFacts>(); f.read.mockReturnValueOnce(h2.promise);
    const later = f.store.check(user, "ask_agents", { ...f.ctx, current: () => current }); current = false;
    h2.resolve({ kind: "complete", person: user, groups: [group], observedAt: 100 });
    await expect(later).rejects.toThrow("group_policy_unavailable");
  });
  it("bounds physical directory checks per person and frees the slot only on settlement", async () => {
    const f = fixture(); f.enable(); const h = held<PolicyGroupFacts>(); f.read.mockReturnValue(h.promise);
    const work = Array.from({ length: 4 }, () => f.store.check(user, "ask_agents", f.ctx));
    const fifth = f.store.check(user, "ask_agents", f.ctx).catch(error => error);
    try { expect(f.read).toHaveBeenCalledTimes(4); }
    finally { h.resolve({ kind: "unknown" }); await Promise.all(work); }
    expect(await fifth).toBeInstanceOf(Error);
    expect(await f.store.check(user, "ask_agents", f.ctx)).toMatchObject({ outcome: "unknown" });
  });
  it("bounds physical group lookups globally across distinct people", async () => {
    const f = fixture(); f.enable(); const h = held<PolicyGroupFacts>(); f.read.mockReturnValue(h.promise);
    const work = Array.from({ length: 32 }, (_, n) => f.store.check({ ...user, objectId: `${String(n).padStart(8,"0")}-1111-4111-8111-111111111111` }, "ask_agents", f.ctx));
    const extra = f.store.check(user, "ask_agents", f.ctx).catch(error => error);
    try { expect(f.read).toHaveBeenCalledTimes(32); }
    finally { h.resolve({ kind: "unknown" }); await Promise.all(work); }
    expect(await extra).toBeInstanceOf(Error);
  });
  it("rejects stale/future observations and never caches an allow", async () => {
    const f = fixture(); f.enable();
    for (const at of [99, 101]) { f.read.mockResolvedValueOnce({ kind: "complete", person: user, groups: [group], observedAt: at }); expect(await f.store.check(user, "ask_agents", f.ctx)).toMatchObject({ outcome: "unknown", authoritative: false }); }
    expect(f.read).toHaveBeenCalledTimes(2);
  });
  it("refuses revision collisions, foreign actor/binding and corrupt or missing state", () => {
    const f = fixture(), stale = f.store.read(); f.enable();
    expect(() => createHubGroupPolicyStore({ ...f.options, directory: { ...f.options.directory, realm: "other" } })).toThrow("group_policy_unavailable");
    expect(() => f.store.replace(stale, user, f.ctx)).toThrow("group_policy_conflict");
    expect(() => f.store.replace(f.store.read(), { ...user, realm: "other" }, f.ctx)).toThrow("group_policy_invalid");
    const good = f.store.read();
    f.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify({ ...good, generation: "other-generation" }));
    expect(() => f.store.read()).toThrow("group_policy_unavailable");
    f.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(good));
    f.db.prepare("UPDATE hub_group_policy SET hub_id='another-hub'").run(); expect(() => f.store.read()).toThrow("group_policy_unavailable");
    f.db.prepare("UPDATE hub_group_policy SET hub_id='hub-1', body='{}'").run(); expect(() => f.store.read()).toThrow("group_policy_unavailable");
    f.db.prepare("DELETE FROM hub_group_policy").run(); expect(() => createHubGroupPolicyStore(f.options)).toThrow("group_policy_unavailable");
  });
  it("gives composition a repair state without a never-enabled generation change silently denying legacy operations", () => {
    const f = fixture();
    const inspect = () => inspectHubGroupPolicyBinding(f.db, "hub-1", "example", "generation-2");
    expect(inspect()).toEqual({ kind: "repair-required", legacy: true, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(inspectHubGroupPolicyBinding(f.db, "hub-1", "example", "generation-1")).toEqual({ kind: "ready" });
    f.enable(); expect(inspect()).toEqual({ kind: "repair-required", legacy: false });
    expect(() => createHubGroupPolicyStore({ ...f.options, generation: "generation-2" })).toThrow("group_policy_unavailable");
    f.store.replace({ ...f.store.read(), state: "suspended" }, user, f.ctx);
    expect(inspect()).toEqual({ kind: "repair-required", legacy: false });
    for (const [hub, realm] of [["another-hub", "example"], ["hub-1", "other"]]) {
      expect(inspectHubGroupPolicyBinding(f.db, hub!, realm!, "generation-1")).toEqual({ kind: "repair-required", legacy: false });
    }
    f.db.prepare("UPDATE hub_group_policy SET body='{}'").run();
    expect(inspect()).toEqual({ kind: "repair-required", legacy: false });
    f.db.prepare("DELETE FROM hub_group_policy").run();
    expect(inspect()).toEqual({ kind: "repair-required", legacy: false });
  });
  it("no-op saves do not audit or bump revision", () => {
    const f = fixture(); f.enable(); const current = f.store.read();
    expect(f.store.replace(current, user, f.ctx)).toEqual(current); expect(count(f.db)).toBe(1);
  });
});
