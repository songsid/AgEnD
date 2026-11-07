/**
 * #3298 S-89, the server half: store.describe (the welcome's one display read), the welcome projection, and the group routes
 * on the REAL composed Hub HTTP (s3b rig: real sessions, CSRF, administrator checks), with a fake S-88 control that does what
 * the contract says — it calls the session's own requireAdmin itself. Absent the control nothing is mounted or marked.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { applyHubMigrations } from "../src/hub/db.js";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import { createHubGroupPolicyStore, groupPolicyMigration } from "../src/hub/group-policy/store.js";
import { createHubGroupWelcome } from "../src/hub/group-policy/welcome.js";
import type { PolicyGroupFacts } from "../src/hub/directory/groups.js";
import type { HubDirectory } from "../src/hub/directory/types.js";
import type { GroupAdminContext, HubGroupAdminControl } from "../src/hub/group-policy/admin-dto.js";
import { s3bRig } from "./helpers/hub-s3b-rig.js";

const user = { realm: "example", objectId: "11111111-1111-4111-8111-111111111111" }, other = { realm: "example", objectId: "22222222-2222-4222-8222-222222222222" };
const group = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const dbs: Database.Database[] = [];
afterEach(() => { dbs.splice(0).forEach(db => db.close()); });
function storeFixture(facts: () => Promise<PolicyGroupFacts> = async () => ({ kind: "complete", person: { ...user }, groups: [group], observedAt: 100 })) {
  const db = new Database(":memory:"); dbs.push(db); db.pragma("foreign_keys=ON");
  applyHubMigrations(db, [HUB_AUDIT_MIGRATION, groupPolicyMigration("hub-1", "example", "generation-1")]);
  const audit = createHubAudit({ db, contentKey: randomBytes(32), now: () => 100 });
  const read = vi.fn(facts);
  const directory = { realm: "example", groupPolicy: "ad-direct-guid", readPolicyGroups: read } as unknown as HubDirectory;
  const store = createHubGroupPolicyStore({ db, hubId: "hub-1", realm: "example", generation: "generation-1", directory, audit, current: () => true, now: () => 100 });
  const ctx = { requestId: "request-1", current: () => true };
  const enable = (allow = ["ask_agents", "pair_fleet"], maxFleets = 2) => store.replace({ ...store.read(), state: "enabled",
    groups: [{ group: { realm: "example", objectId: group }, dn: "CN=Owners,DC=example,DC=test", allow, maxFleets }] }, user, ctx);
  const audits = () => (db.prepare("SELECT COUNT(*) n FROM hub_audit").get() as { n: number }).n;
  return { db, store, read, ctx, enable, audits };
}

describe("store.describe: the welcome's one display read", () => {
  it("never enabled: legacy for all three, no directory read, nothing audited", async () => {
    const f = storeFixture();
    const d = await f.store.describe(user, f.ctx);
    expect(Object.values(d.decisions).map(x => x.outcome)).toEqual(["legacy", "legacy", "legacy"]);
    expect(f.read).not.toHaveBeenCalled(); expect(f.audits()).toBe(0);
  });
  it("enabled: ONE membership read for all three decisions, and no audit row (check() writes one per call)", async () => {
    const f = storeFixture(); f.enable(); const before = f.audits();
    const d = await f.store.describe(user, f.ctx);
    expect([d.decisions.ask_agents.outcome, d.decisions.publish_agents.outcome, d.decisions.pair_fleet.outcome]).toEqual(["allow", "deny", "allow"]);
    expect(d.decisions.pair_fleet.maxFleets).toBe(2);
    expect(f.read).toHaveBeenCalledTimes(1); expect(f.audits()).toBe(before);
    await f.store.check(user, "ask_agents", f.ctx); expect(f.audits()).toBe(before + 1);          // the control: check() audits
  });
  it("unknown stays unknown: a failed, partial or stale read is never a yes or a no", async () => {
    for (const facts of [async () => { throw new Error("ldap down"); }, async () => ({ kind: "unknown" } as PolicyGroupFacts),
      async () => ({ kind: "complete", person: { ...user }, groups: [group], observedAt: 5 } as PolicyGroupFacts)]) {
      const f = storeFixture(facts); f.enable();
      const d = await f.store.describe(user, f.ctx);
      expect(Object.values(d.decisions).map(x => x.outcome)).toEqual(["unknown", "unknown", "unknown"]);
    }
  });
});

describe("store.describe: bounded and never stale (Fable #3372 F2)", () => {
  // The welcome is open to every signed-in person and does one directory read per call: the same in-flight bounds as check().
  it("a 5th concurrent describe for one person, and a 33rd overall, are refused while reads are held", async () => {
    const pending: Array<(v: PolicyGroupFacts) => void> = [];
    const f = storeFixture(() => new Promise(r => { pending.push(r); })); f.enable();
    const mine = Array.from({ length: 4 }, () => f.store.describe(user, f.ctx));
    await expect(f.store.describe(user, f.ctx)).rejects.toThrow("group_policy_unavailable");
    const others = Array.from({ length: 28 }, (_, i) => f.store.describe({ realm: "example", objectId: `33333333-3333-4333-8333-${String(i).padStart(12, "0")}` }, f.ctx));
    await expect(f.store.describe(other, f.ctx)).rejects.toThrow("group_policy_unavailable");
    expect(f.read).toHaveBeenCalledTimes(32);
    for (const r of pending.splice(0)) r({ kind: "unknown" });
    await Promise.all([...mine, ...others]);
    expect((await (async () => { const p = f.store.describe(user, f.ctx); pending.splice(0).forEach(r => r({ kind: "unknown" })); return p; })())).toBeTruthy();   // freed again
  });
  it("a policy change during the held read: the decisions come back unknown, never the old read applied to the new policy", async () => {
    let release!: (v: PolicyGroupFacts) => void;
    const f = storeFixture(() => new Promise(r => { release = r; })); f.enable();
    const d = f.store.describe(user, f.ctx);
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(1));
    f.enable(["ask_agents", "publish_agents", "pair_fleet"], 3);                    // revision moves while LDAP answers
    release({ kind: "complete", person: { ...user }, groups: [group], observedAt: 100 });
    expect(Object.values((await d).decisions).map(x => x.outcome)).toEqual(["unknown", "unknown", "unknown"]);
  });
});

describe("the welcome projection", () => {
  const fleets = [{ id: "f1", owner: user, status: "active", label: "Desk" }, { id: "f2", owner: other, status: "active", label: "Someone else's" }, { id: "f3", owner: user, status: "revoked" }];
  it("is about the session's own person only, with only outcome, reason, limit and own fleets — no GUID or DN", async () => {
    const f = storeFixture(); f.enable();
    const welcome = createHubGroupWelcome({ policy: () => f.store, readiness: () => "ready", fleets: () => fleets });
    const w = await welcome({ requestId: "r", current: () => true, requirePerson: async () => user });
    expect(w).toEqual({ ok: true, v: 1, mode: "enabled", chat: { state: "allow", reason: "group" }, publish: { state: "deny", reason: "no-group" },
      connect: { state: "allow", reason: "group", maxFleets: 2, fleets: [{ id: "f1", label: "Desk", status: "active" }, { id: "f3", label: null, status: "revoked" }] } });
    expect(JSON.stringify(w)).not.toMatch(new RegExp(`${group}|CN=`));
  });
  it("never enabled (an intact binding, or a ready store that says so): legacy (today's behaviour), no directory read", async () => {
    for (const readiness of ["ready", "never-enabled"] as const) {
      const f = storeFixture();
      const w = await createHubGroupWelcome({ policy: () => f.store, readiness: () => readiness, fleets: () => [] })({ requestId: "r", current: () => true, requirePerson: async () => user });
      expect(w.mode).toBe("legacy"); expect(f.read).not.toHaveBeenCalled();
    }
  });
  it("a binding that needs repair or can't be read: unavailable (503), never a legacy allow, and the strict store is never constructed (Cairn #3372; Fable F2 E2)", async () => {
    const policy = vi.fn(() => { throw new Error("constructed a mismatched strict store"); });
    const p = createHubGroupWelcome({ policy, readiness: () => "unavailable", fleets: () => [] })({ requestId: "r", current: () => true, requirePerson: async () => user });
    await expect(p).rejects.toMatchObject({ code: "unavailable" }); expect(policy).not.toHaveBeenCalled();
  });
  describe("each own active fleet's paused state (S-88 resourceState)", () => {
    const mine = [{ id: "f1", owner: user, status: "active", label: "Desk", generation: 4 }, { id: "f2", owner: user, status: "active", label: "Lab", generation: 7 },
      { id: "f3", owner: user, status: "active", label: "Old", generation: 2 }, { id: "f4", owner: user, status: "revoked", generation: 1 },
      { id: "f5", owner: user, status: "active", label: "No generation" }, { id: "f6", owner: other, status: "active", generation: 9 }];
    const states: Record<string, () => Promise<{ state: string } | null>> = {
      f1: async () => ({ state: "suspended" }), f2: async () => null, f3: async () => { throw new Error("unavailable"); }, f5: async () => ({ state: "active" }), f6: async () => ({ state: "suspended" }) };
    it("suspended → paused, null (not enrolled) → active, unreadable → unknown; asks the exact resource; never a revoked or someone else's fleet", async () => {
      const f = storeFixture(); f.enable();
      const fleetState = vi.fn((r: any) => states[r.id]!());
      const w = await createHubGroupWelcome({ policy: () => f.store, readiness: () => "ready", fleets: () => mine, fleetState })({ requestId: "r", current: () => true, requirePerson: async () => user });
      expect(w.connect.fleets.map((x) => [x.id, x.status])).toEqual([["f1", "suspended"], ["f2", "active"], ["f3", "unknown"], ["f4", "revoked"], ["f5", "unknown"]]);
      expect(fleetState.mock.calls.map((c) => c[0])).toEqual([{ kind: "fleet", id: "f1", revision: 4, owner: user }, { kind: "fleet", id: "f2", revision: 7, owner: user }, { kind: "fleet", id: "f3", revision: 2, owner: user }]);
    });
    it("a state it doesn't know is unknown, never active", async () => {
      const f = storeFixture(); f.enable();
      const w = await createHubGroupWelcome({ policy: () => f.store, readiness: () => "ready", fleets: () => [mine[0]!], fleetState: async () => ({ state: "repairing" }) })({ requestId: "r", current: () => true, requirePerson: async () => user });
      expect(w.connect.fleets[0]!.status).toBe("unknown");
    });
    it("legacy asks nothing (nothing is paused by a policy that was never on)", async () => {
      const f = storeFixture(); const fleetState = vi.fn(async () => ({ state: "suspended" }));
      const w = await createHubGroupWelcome({ policy: () => f.store, readiness: () => "ready", fleets: () => mine, fleetState })({ requestId: "r", current: () => true, requirePerson: async () => user });
      expect(w.mode).toBe("legacy"); expect(fleetState).not.toHaveBeenCalled(); expect(w.connect.fleets.find((x) => x.id === "f1")!.status).toBe("active");
    });
    it("a session that ended during a fleet's read answers nothing", async () => {
      const f = storeFixture(); f.enable(); let live = true;
      const p = createHubGroupWelcome({ policy: () => f.store, readiness: () => "ready", fleets: () => [mine[0]!], fleetState: async () => { live = false; return null; } })({ requestId: "r", current: () => live, requirePerson: async () => user });
      await expect(p).rejects.toMatchObject({ code: "unavailable" });
    });
  });
  it("a session that ended during the read answers nothing", async () => {
    const f = storeFixture(); f.enable(); let live = true;
    const welcome = createHubGroupWelcome({ policy: () => f.store, readiness: () => "ready", fleets: () => [] });
    await expect(welcome({ requestId: "r", current: () => live, requirePerson: async () => { live = false; return user; } })).rejects.toThrow();
  });
});

describe("the group routes on the real Hub HTTP", () => {
  let rig: any, rigOff: any, admin: any, bo: any, seen: Array<[string, unknown]>, answers: Record<string, any>;
  const control: HubGroupAdminControl = {
    async read(ctx: GroupAdminContext) { await ctx.requireAdmin(); seen.push(["read", null]); return answers.read; },
    async resolve(input, ctx) { await ctx.requireAdmin(); seen.push(["resolve", input]); return answers.resolve; },
    async preview(input, ctx) { await ctx.requireAdmin(); seen.push(["preview", input]); return answers.preview; },
    async apply(input, ctx) { await ctx.requireAdmin(); seen.push(["apply", input]); return answers.apply; },
    async resume(input, ctx) { await ctx.requireAdmin(); seen.push(["resume", input]); return answers.resume; },
  };
  const welcomeSubjects: unknown[] = [];
  const welcome = async (ctx: any) => { const p = await ctx.requirePerson(); welcomeSubjects.push(p); return { ok: true, v: 1, mode: "legacy", chat: { state: "allow" }, publish: { state: "allow" }, connect: { state: "deny", maxFleets: 0, fleets: [] } } as const; };
  beforeAll(async () => {
    rig = await s3bRig({ groupHttp: { control, welcome } });
    rig.addPerson("bo", "Bo Wu");
    admin = await rig.signIn("admin"); bo = await rig.signIn("bo");
    rigOff = await s3bRig();
  });
  afterAll(async () => { await rig?.close(); await rigOff?.close(); });
  const reset = () => { seen = []; answers = { read: { ok: true, groupPolicyV1: true, supported: true, binding: "ready", policy: null, paused: [] },
    resolve: { ok: false, reason: "not-found" }, preview: { ok: true, previewDigest: "d".repeat(64), expiresAt: 1, policyRevision: 1, authorizationVersion: 1, impact: {} },
    apply: { ok: false, code: "stale-preview" }, resume: { ok: true, state: "active" } }; };
  const POLICY = { realm: "example", generation: "g", revision: 1, state: "enabled", groups: [], denies: [] };

  it("without the control: no session mark, and every group route is 404", async () => {
    const a = await rigOff.signIn("admin");
    expect(a.body.features).toBeUndefined();
    expect((await rigOff.call(a, "GET", "/hub/v1/session")).json.features).toBeUndefined();
    for (const [m, p] of [["GET", "/hub/v1/admin/group-policy"], ["GET", "/hub/v1/me/welcome"], ["POST", "/hub/v1/admin/group-policy/preview"]] as const)
      expect((await rigOff.call(a, m, p, m === "POST" ? { policy: POLICY } : undefined)).status, p).toBe(404);
  });
  it("the Hub HTTP reports group permissions only when composed with them (what marks the host fleet's Settings row)", () => {
    expect(rigOff.http.features).toEqual([]);
    expect(rig.http.features).toEqual(["group-policy-v1"]);
  });
  it("with it: the mark on both the sign-in answer and the session read", async () => {
    expect(admin.body.features).toEqual(["group-policy-v1"]);
    expect((await rig.call(bo, "GET", "/hub/v1/session")).json.features).toEqual(["group-policy-v1"]);
  });
  it("admin authority is the session's own (the control calls requireAdmin): the admin reads, a member is refused, signed out is 401", async () => {
    reset();
    expect((await rig.call(admin, "GET", "/hub/v1/admin/group-policy")).status).toBe(200);
    expect((await rig.call(bo, "GET", "/hub/v1/admin/group-policy")).status).toBe(403);
    expect((await rig.call(null, "GET", "/hub/v1/admin/group-policy")).status).toBe(401);
    expect(seen).toEqual([["read", null]]);
  });
  it("writes need the session's CSRF token; bad shapes are 400 and never reach the control", async () => {
    reset();
    const noCsrf = { cookie: admin.cookie, csrf: "wrong" };
    for (const [m, p, b] of [["POST", "/hub/v1/admin/group-policy/preview", { policy: POLICY }], ["PUT", "/hub/v1/admin/group-policy", { policy: POLICY, previewDigest: "d".repeat(64) }],
      ["POST", "/hub/v1/admin/group-policy/resolve", { dn: "CN=A,DC=example,DC=test" }], ["POST", "/hub/v1/admin/group-policy/resources/resume", { resource: { kind: "fleet", id: "f1", revision: 1 }, expectedPolicyRevision: 1, expectedLifecycleRevision: 1 }]] as const)
      expect((await rig.call(noCsrf, m, p, b)).status, `${m} ${p}`).toBe(403);
    for (const [m, p, b] of [["POST", "/hub/v1/admin/group-policy/preview", { policy: { ...POLICY, state: "on" } }], ["PUT", "/hub/v1/admin/group-policy", { policy: POLICY, previewDigest: "x" }],
      ["POST", "/hub/v1/admin/group-policy/resources/resume", { resource: { kind: "fleet", id: "f1", revision: 1 }, expectedPolicyRevision: 1 }], ["POST", "/hub/v1/admin/group-policy/resolve", { dn: "" }]] as const)
      expect((await rig.call(admin, m, p, b)).status, p).toBe(400);
    expect(seen).toEqual([]);
  });
  it("answers keep their meaning: a resolve refusal is feedback (200 + reason); a stale preview is 409 with its code", async () => {
    reset();
    const r = await rig.call(admin, "POST", "/hub/v1/admin/group-policy/resolve", { dn: "CN=Nope,DC=example,DC=test" });
    expect([r.status, r.json]).toEqual([200, { reason: "not-found" }]);
    const a = await rig.call(admin, "PUT", "/hub/v1/admin/group-policy", { policy: POLICY, previewDigest: "d".repeat(64) });
    expect([a.status, a.json.code]).toEqual([409, "stale-preview"]);
    expect(seen.map(s => s[0])).toEqual(["resolve", "apply"]);
  });
  it("the welcome describes the signed-in person only — nothing in the request can name someone else", async () => {
    welcomeSubjects.length = 0;
    expect((await rig.call(bo, "GET", "/hub/v1/me/welcome?person=admin")).status).toBe(200);
    expect((await rig.call(null, "GET", "/hub/v1/me/welcome")).status).toBe(401);
    expect(welcomeSubjects).toHaveLength(1);
    expect((welcomeSubjects[0] as any).objectId).toBe(rig.people.get("bo").key.objectId);
  });
});
