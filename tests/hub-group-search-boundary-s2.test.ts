import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { applyHubMigrations } from "../src/hub/db.js";
import { HUB_AUDIT_MIGRATION, createHubAudit } from "../src/hub/audit/index.js";
import { createHubGroupPolicyStore, groupPolicyMigration } from "../src/hub/group-policy/store.js";
import { createHubGroupAdminSearch } from "../src/hub/group-policy/admin-search.js";
import type { HubActor, HubDirectory } from "../src/hub/types.js";
import type { PolicyGroupSearch } from "../src/hub/directory/groups.js";
import { escapeFilterValue } from "../src/hub/directory/profiles.js";
const dbs: Database.Database[] = [];
afterEach(() => dbs.splice(0).forEach(db => db.close()));
const admin = { realm: "example", objectId: "11111111-1111-4111-8111-111111111111" };
const group = { objectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", cn: "Owners", dn: "CN=Owners,DC=example,DC=test" };
const answer = (): PolicyGroupSearch => ({ ok: true, groups: [{ ...group }], truncated: false });
function fixture() {
  const db = new Database(":memory:"); dbs.push(db);
  applyHubMigrations(db, [HUB_AUDIT_MIGRATION, groupPolicyMigration("hub-1", "example", "g1")]);
  const audit = createHubAudit({ db, contentKey: randomBytes(32), now: () => 100 });
  const lookup = vi.fn(async (): Promise<PolicyGroupSearch> => answer());
  const directory = { realm: "example", groupPolicy: "ad-direct-guid", searchPolicyGroups: lookup } as unknown as HubDirectory;
  const policy = createHubGroupPolicyStore({ db, hubId: "hub-1", realm: "example", generation: "g1", directory, audit, current: () => true, now: () => 100 });
  let session = true, generation = "g1", at = 100;
  const binding = () => ({ kind: "ready" as const, hubId: "hub-1", realm: "example", generation });
  const control = createHubGroupAdminSearch({ administrator: admin, directory, current: () => true, binding, policy: () => policy, now: () => at });
  const authenticate = vi.fn(async (): Promise<HubActor> => ({ kind: "directory", person: { ...admin }, sessionId: "session-one" }));
  const ctx = { requestId: "search-request", current: () => session, requireAdmin: authenticate };
  return { db, directory, policy, control, lookup, authenticate, ctx, signOut: () => { session = false; },
    changeGeneration: () => { generation = "g2"; }, tick: () => { at += 60_000; } };
}
describe("group search authority and shared physical admission", () => {
  it("uses the existing pool until the driver read AND physical-close promise settle", async () => {
    const r = fixture(), reads: Array<() => void> = [], closes: Array<() => void> = [];
    r.lookup.mockImplementation(async () => {
      await new Promise<void>(resolve => reads.push(resolve));
      await new Promise<void>(resolve => closes.push(resolve));
      return answer();
    });
    const running = Array.from({ length: 4 }, () => r.control.search({ q: "own" }, r.ctx));
    await vi.waitFor(() => expect(reads).toHaveLength(4));
    try {
      const fifth = r.control.search({ q: "own" }, r.ctx); running.push(fifth);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(r.lookup).toHaveBeenCalledTimes(4);
      expect(await fifth).toEqual({ ok: false, reason: "unknown" });
      reads.forEach(resolve => resolve()); await vi.waitFor(() => expect(closes).toHaveLength(4));
      const sixth = r.control.search({ q: "own" }, r.ctx); running.push(sixth);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(r.lookup).toHaveBeenCalledTimes(4);
      expect(await sixth).toEqual({ ok: false, reason: "unknown" });
    } finally {
      reads.forEach(resolve => resolve());
      await new Promise<void>(resolve => setImmediate(resolve));
      closes.forEach(resolve => resolve()); await Promise.allSettled(running);
    }
    r.lookup.mockImplementation(async () => answer());
    expect(await r.control.search({ q: "own" }, r.ctx)).toEqual(answer());
  });
  it.each(["session", "generation", "close"])("fences %s changes during directory I/O before disclosing suggestions", async kind => {
    const r = fixture(); let release!: () => void;
    r.lookup.mockImplementationOnce(() => new Promise<PolicyGroupSearch>(resolve => { release = () => resolve(answer()); }));
    const pending = r.control.search({ q: "own" }, r.ctx), rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    if (kind === "session") r.signOut(); else if (kind === "generation") r.changeGeneration(); else r.control.close();
    release(); await rejected;
  });
  it("requires the SAME fresh administrator session after I/O, not just the same person", async () => {
    const r = fixture();
    r.authenticate.mockResolvedValueOnce({ kind: "directory", person: admin, sessionId: "first" })
      .mockResolvedValueOnce({ kind: "directory", person: admin, sessionId: "second" });
    await expect(r.control.search({ q: "own" }, r.ctx)).rejects.toThrow("denied");
  });
  it("snapshots mutable driver results before the final authentication await", async () => {
    const r = fixture(), found = answer(); r.lookup.mockResolvedValueOnce(found);
    r.authenticate.mockImplementation(async () => {
      if (r.authenticate.mock.calls.length === 2 && found.ok) (found.groups[0] as { cn: string }).cn = "late replacement";
      return { kind: "directory", person: admin, sessionId: "session-one" };
    });
    expect(await r.control.search({ q: "own" }, r.ctx)).toEqual(answer()); expect(r.authenticate).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, "wrong-profile"])("unsupported directory (%s) starts no search", async mode => {
    const r = fixture(); Object.assign(r.directory, mode ? { groupPolicy: mode } : { searchPolicyGroups: undefined });
    expect(await r.control.search({ q: "own" }, r.ctx)).toEqual({ ok: false, reason: "unsupported" }); expect(r.lookup).not.toHaveBeenCalled();
  });
  it("keeps malformed results and raw diagnostic details out of the response", async () => {
    const r = fixture(); r.lookup.mockResolvedValueOnce({ ok: true, groups: [{ ...group, objectId: "bad" }], truncated: false });
    expect(await r.control.search({ q: "own" }, r.ctx)).toEqual({ ok: false, reason: "unknown" });
    r.lookup.mockResolvedValueOnce({ ok: false, reason: "unknown", failure: "LDAP private text" } as unknown as PolicyGroupSearch);
    expect(await r.control.search({ q: "own" }, r.ctx)).toEqual({ ok: false, reason: "unknown" });
  });
  it("30/session/minute resets by time, never by a different search prefix", async () => {
    const r = fixture(); for (let i = 0; i < 30; i++) expect((await r.control.search({ q: `own${i}` }, r.ctx)).ok).toBe(true);
    expect(await r.control.search({ q: "different" }, r.ctx)).toEqual({ ok: false, reason: "limited" });
    r.tick(); expect((await r.control.search({ q: "own" }, r.ctx)).ok).toBe(true);
  });
  it.each([["\\", "\\5c"], ["*", "\\2a"], ["(", "\\28"], [")", "\\29"], ["\u0000", "\\00"]])("RFC4515 escapes the literal %j", (value, escaped) => {
    expect(escapeFilterValue(value!)).toBe(escaped);
  });
});
