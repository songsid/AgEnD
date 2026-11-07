/** Actual ldapts BER on verified loopback TLS; only the test connector redirects DC636 to an ephemeral port. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ port: 0, requestedPorts: [] as number[] }));
vi.mock("node:tls", async original => {
  const real = await original<typeof import("node:tls")>();
  return { ...real, connect: (options: any) => { f.requestedPorts.push(options.port); return real.connect({ ...options, ...(options.host === "127.0.0.1" && options.port === 636 ? { port: f.port } : {}) }); } };
});
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { directoryCertificates } from "./support/hub-directory-ca-fixture.js";
import { groupWirePeer, GROUP_A, GROUP_B, GROUP_DN, PERSON_ID } from "./support/hub-group-directory-wire.js";
import { createHubDirectory } from "../src/hub/directory/directory.js";
import { applyHubMigrations } from "../src/hub/db.js";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import { createHubGroupPolicyStore, groupPolicyMigration } from "../src/hub/group-policy/store.js";
import { createHubGroupResources, HUB_GROUP_RESOURCES_MIGRATION } from "../src/hub/group-policy/resources.js";
import { evaluateGroupPolicy, initialGroupPolicy } from "../src/hub/group-policy/model.js";
const who = { realm: "example", objectId: PERSON_ID };
let certs: ReturnType<typeof directoryCertificates> | undefined, peer: Awaited<ReturnType<typeof groupWirePeer>>;
const dirs: ReturnType<typeof createHubDirectory>[] = [];
function directory(caPem = certs!.ca) {
  const d = createHubDirectory({ realm: "example", profile: "ad", url: "ldaps://127.0.0.1:636", caPem, baseDn: "DC=example,DC=test", bindDn: "CN=Reader,DC=example,DC=test", timeoutMs: 500 }, { bindPassword: "Dummy-service-only" }); dirs.push(d); return d;
}
beforeAll(() => { certs = directoryCertificates(); });
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => d.close())); await peer?.close(); f.requestedPorts.length = 0; });
afterAll(() => certs?.cleanup());
async function start() { peer = await groupWirePeer(certs!.leaf); f.port = peer.port; }

describe("group-policy real LDAPS listener smoke", () => {
  it("sends the actual critical control BER and refuses the recreated old DN in the same read", async () => {
    await start(); const d = directory(), found = await d.resolvePolicyGroup!(GROUP_DN);
    expect(found).toEqual({ ok: true, group: { key: { realm: "example", objectId: GROUP_A }, dn: GROUP_DN } });
    const policy = { ...initialGroupPolicy("example", "generation-1"), state: "enabled", groups: [{ group: { realm: "example", objectId: GROUP_A }, dn: GROUP_DN, allow: ["ask_agents"], maxFleets: 1 }] };
    peer.state.beforeMembership = () => {
      peer.state.labels.set(GROUP_A, "CN=Renamed,DC=example,DC=test"); peer.state.labels.set(GROUP_B, GROUP_DN); peer.state.memberships = [GROUP_B];
    };
    const recreated = await d.readPolicyGroups!(who);
    expect(recreated).toMatchObject({ kind: "complete", groups: [GROUP_B] });
    expect(evaluateGroupPolicy(policy, who, "ask_agents", recreated)).toMatchObject({ outcome: "deny", authoritative: true });
    const last = peer.searches.at(-1); expect(last.controls).toEqual([{ oid: "1.2.840.113556.1.4.529", critical: true, hex: "3003020101" }]);
    expect(last).toMatchObject({ sizeLimit: 2, deref: 0, scope: 2 });
    expect(peer.searches).toHaveLength(3); // Resolve/recheck, then one authoritative membership response; no DN→GUID join.
    peer.state.beforeMembership = undefined; peer.state.memberships = [GROUP_A];
    expect(evaluateGroupPolicy(policy, who, "ask_agents", await d.readPolicyGroups!(who))).toMatchObject({ outcome: "allow" });
    expect(f.requestedPorts.every(p => p === 636)).toBe(true);
    expect(peer.binds.every(dn => dn === "CN=Reader,DC=example,DC=test")).toBe(true);
  });
  it.each(["unsupported", "referral", "plain", "missing", "ranged"] as const)("refuses %s wire results as unknown", async mode => {
    await start(); peer.state.mode = mode; expect(await directory().readPolicyGroups!(who)).toEqual({ kind: "unknown" });
    expect(peer.searches).toHaveLength(1);
  });
  it("last-group omission stays held without suspension; a complete other-group result suspends until explicit resume", async () => {
    await start(); const d = directory(), db = new Database(":memory:"); db.pragma("foreign_keys=ON");
    try {
      applyHubMigrations(db, [HUB_AUDIT_MIGRATION, groupPolicyMigration("hub-1", "example", "generation-1"), HUB_GROUP_RESOURCES_MIGRATION]);
      const audit = createHubAudit({ db, contentKey: randomBytes(32) });
      const policy = createHubGroupPolicyStore({ db, hubId: "hub-1", realm: "example", generation: "generation-1", directory: d, audit, current: () => true });
      const resources = createHubGroupResources({ db, policy, audit, current: () => true });
      const ctx = { requestId: "last-group-wire", current: () => true }, r = { kind: "exposure" as const, id: "exposure-1", revision: 1, owner: who };
      policy.replace({ ...policy.read(), state: "enabled", groups: [{ group: { realm: "example", objectId: GROUP_A }, dn: GROUP_DN, allow: ["publish_agents"], maxFleets: 1 }] }, who, ctx);
      await resources.register(r, ctx); const before = resources.read(r);
      for (const mode of ["missing", "ranged", "outage"] as const) {
        peer.state.mode = mode;
        expect(await resources.check(r, ctx)).toMatchObject({ outcome: "held", decision: { authoritative: false } });
        expect(resources.read(r)).toEqual(before);
      }
      peer.state.mode = "ok"; peer.state.memberships = [];
      expect(await resources.check(r, ctx)).toMatchObject({ outcome: "held" }); expect(resources.read(r)).toEqual(before);
      peer.state.memberships = Array.from({ length: 257 }, (_, n) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`);
      expect(await resources.check(r, ctx)).toMatchObject({ outcome: "held" }); expect(resources.read(r)).toEqual(before);
      // Last-group removal was unknown, so no suspension/resume obligation existed on rejoin.
      peer.state.memberships = [GROUP_A];
      expect(await resources.check(r, ctx)).toMatchObject({ outcome: "allow" }); expect(resources.read(r)).toEqual(before);
      peer.state.memberships = [GROUP_B];
      expect(await resources.check(r, ctx)).toMatchObject({ outcome: "deny", decision: { authoritative: true } });
      expect(resources.read(r)).toMatchObject({ state: "suspended" });
      peer.state.memberships = [GROUP_A]; expect(await resources.check(r, ctx)).toMatchObject({ outcome: "resume-required" });
      expect(await resources.resume(r, who, ctx)).toMatchObject({ outcome: "allow" });
      expect(resources.read(r)).toMatchObject({ state: "active", revision: 3 }); expect(audit.verifyChain()).toMatchObject({ ok: true });
    } finally { db.close(); }
  });
  it("rejects an unrelated CA before any service bind", async () => {
    await start(); expect(await directory(certs!.unrelated.cert).readPolicyGroups!(who)).toEqual({ kind: "unknown" }); expect(peer.binds).toEqual([]);
  });
  it("outage recovers without resume and commits the resulting decisions to real SQLite/hash-chain audit", async () => {
    await start(); const d = directory(), db = new Database(":memory:"); db.pragma("foreign_keys=ON");
    try {
      applyHubMigrations(db, [HUB_AUDIT_MIGRATION, groupPolicyMigration("hub-1", "example", "generation-1")]);
      const audit = createHubAudit({ db, contentKey: randomBytes(32) });
      const store = createHubGroupPolicyStore({ db, hubId: "hub-1", realm: "example", generation: "generation-1", directory: d, audit, current: () => true });
      const ctx = { requestId: "wire-request", current: () => true };
      store.replace({ ...store.read(), state: "enabled", groups: [{ group: { realm: "example", objectId: GROUP_A }, dn: GROUP_DN, allow: ["ask_agents"], maxFleets: 1 }] }, who, ctx);
      const initial = store.read(); expect(await store.check(who, "ask_agents", ctx)).toMatchObject({ outcome: "allow" });
      peer.state.mode = "outage"; expect(await store.check(who, "ask_agents", ctx)).toMatchObject({ outcome: "unknown", authoritative: false }); expect(store.read()).toEqual(initial);
      peer.state.mode = "ok"; expect(await store.check(who, "ask_agents", ctx)).toMatchObject({ outcome: "allow" });
      peer.state.memberships = [GROUP_B]; expect(await store.check(who, "ask_agents", ctx)).toMatchObject({ outcome: "deny", authoritative: true });
      expect(store.read()).toEqual(initial); expect(audit.verifyChain()).toMatchObject({ ok: true, checked: 5 });
    } finally { db.close(); }
  });
});
