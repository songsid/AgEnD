/** Private real TLS/WSS plus group ledger and global version in the same DB. Directory facts/people are inert. */
import { afterEach, expect, it, vi } from "vitest";
import { createPrivateKey, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hubRig } from "./helpers/hub-rig.js";
import { applyHubMigrations } from "../src/hub/db.js";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import { createHubGroupPolicyStore, groupPolicyMigration, inspectHubGroupPolicyBinding } from "../src/hub/group-policy/store.js";
import { createHubGroupResources, HUB_GROUP_RESOURCES_MIGRATION } from "../src/hub/group-policy/resources.js";
import { createHubGroupAuthorization } from "../src/hub/group-policy/authorization.js";
import { sha256, signAsker } from "../src/hub/identity.js";
import type { PolicyGroupFacts } from "../src/hub/directory/groups.js";
const rigs: Awaited<ReturnType<typeof hubRig>>[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); });
function held() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
it("atomically fences old links and permits, then reconnects both fleets while only the denied resource stays suspended", async () => {
  const r = await hubRig(); rigs.push(r); await r.pair();
  const homeB = join(r.root, "member-b"); mkdirSync(homeB, { mode: 0o700 }); const profileB = await r.pair(homeB);
  const group = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  applyHubMigrations(r.db, [HUB_AUDIT_MIGRATION, groupPolicyMigration(r.identity.hubId, r.owner.realm, "generation-1"), HUB_GROUP_RESOURCES_MIGRATION]);
  const audit = createHubAudit({ db: r.db, contentKey: randomBytes(32) }), current = () => true;
  const read = vi.fn(async (): Promise<PolicyGroupFacts> => ({ kind: "complete", person: r.owner, groups: [group], observedAt: Date.now() }));
  const policy = createHubGroupPolicyStore({ db: r.db, hubId: r.identity.hubId, realm: r.owner.realm, generation: "generation-1", audit, current,
    directory: { ...r.directory, groupPolicy: "ad-direct-guid", readPolicyGroups: read } });
  const resources = createHubGroupResources({ db: r.db, policy, audit, current });
  const ctx = { requestId: randomUUID(), current }, aResource = { kind: "exposure" as const, id: randomUUID(), revision: 1, owner: r.owner };
  const bResource = { ...aResource, id: randomUUID() }; resources.captureManual(bResource, ctx);
  policy.replace({ ...policy.read(), state: "enabled", groups: [{ group: { realm: r.owner.realm, objectId: group },
    dn: "CN=Owners,DC=example,DC=test", allow: ["publish_agents"], maxFleets: 1 }] }, r.owner, ctx);
  let checkCommitted = () => {};
  const refresh = vi.fn(() => { expect(r.db.inTransaction).toBe(false); checkCommitted(); r.server.refreshAuthorization(); });
  const actions = createHubGroupAuthorization({ db: r.db, administrator: r.owner, policy: () => policy,
    binding: () => inspectHubGroupPolicyBinding(r.db, r.identity.hubId, r.owner.realm, "generation-1"), audit, current,
    version: () => r.store.read().revocationVersion, refreshAuthorization: refresh,
    advanceAuthorization(tx) {
      expect(tx).toBe(r.db); expect(tx.inTransaction).toBe(true);
      r.store.mutate({ at: Date.now(), requestId: randomUUID(), actor: { kind: "person", person: r.owner }, action: "group-resource.version", result: "completed" }, state => { state.revocationVersion++; });
    } });
  try {
    const oldPermit = await actions.enroll(aResource, ctx), aReady = held(), bReady = held(), delivered = held();
    const received: string[] = [];
    const a = r.client(async () => {}, async () => { if (a.state.syncs === 2) aReady.resolve(); });
    const b = r.client(async frame => { if (frame.type === "question") { received.push(frame.payload.text); delivered.resolve(); } },
      async () => { if (b.state.syncs === 2) bReady.resolve(); }, undefined, homeB);
    await a.value.start(); await b.value.start();
    const oldA = a.state.link!, oldB = b.state.link!;
    const serverA = (r.server as any).connections.get(oldA.profile.fleetId), serverB = (r.server as any).connections.get(oldB.profile.fleetId);
    checkCommitted = () => {
      expect(resources.read(aResource)).toMatchObject({ state: "suspended" }); expect(r.store.read().revocationVersion).toBe(1);
      expect(serverA.context.current()).toBe(false); expect(serverB.context.current()).toBe(false);
    };
    read.mockImplementationOnce(async () => ({ kind: "complete", person: r.owner, groups: [other], observedAt: Date.now() }));
    await expect(actions.check(aResource, ctx)).rejects.toMatchObject({ reason: "denied" });
    expect(refresh).toHaveBeenCalledTimes(1); expect(resources.read(aResource)).toMatchObject({ state: "suspended" });
    expect(() => oldPermit.assertCurrent()).toThrow(); expect(r.store.read().revocationVersion).toBe(1);
    await Promise.all([aReady.promise, bReady.promise]); await new Promise<void>(resolve => setImmediate(resolve));
    expect(oldA.current()).toBe(false); expect(oldB.current()).toBe(false);
    for (const c of [a, b]) {
      expect(c.state.holds).toContain("unavailable"); expect(c.state.holds).not.toContain("revoked"); expect(c.state.holds).not.toContain("replaced");
      expect(c.state.link!.revocationVersion).toBe(1); expect(c.state.link!.current()).toBe(true);
    }
    await expect(actions.check(aResource, ctx)).rejects.toMatchObject({ reason: "resume-required" });
    const bPermit = await actions.check(bResource, ctx); expect(bPermit.source).toBe("manual"); bPermit.assertCurrent();
    expect(await b.value.authorize({ messageId: randomUUID(), operationId: randomUUID(), exposureRevision: 1, phase: "begin" })).toMatchObject({ revocationVersion: 1 });
    const text = "Unrelated manual publication is still available", now = Date.now();
    const identity = signAsker({ v: 1, issuer: r.identity.hubId, issuerKeyId: r.identity.issuerKeyId, messageId: randomUUID(), asker: r.owner, owner: r.owner,
      destinationFleetId: profileB.fleetId, exposureId: bResource.id, roomId: randomUUID(), grantId: randomUUID(), grantRevision: 1,
      exposureRevision: 1, revocationVersion: 1, contentDigest: sha256(text), issuedAt: now, expiresAt: now + 60_000, nonce: "d".repeat(64)
    }, createPrivateKey(readFileSync(join(r.root, "hub/keys/issuer-key.pem"))));
    bPermit.assertCurrent();
    await r.server.send(profileB.fleetId, { v: 1, type: "question", requestId: randomUUID(), linkEpoch: b.state.link!.linkEpoch, payload: { text, identity } });
    await delivered.promise; expect(received).toEqual([text]); expect(audit.verifyChain()).toMatchObject({ ok: true });
  } finally { actions.close(); }
});
