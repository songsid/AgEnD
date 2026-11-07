/** Verified private TLS/WSS and real S1→S3 receiver/UoW/audit; fake people and directory only. */
import { createPrivateKey, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { hubRig } from "./helpers/hub-rig.js";
import { applyHubMigrations, createHubUnitOfWork, hubTxDatabase } from "../src/hub/db.js";
import { createHubHttp, HUB_HTTP_MIGRATIONS } from "../src/hub/http/compose.js";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import { createHubGroupPolicyStore, groupPolicyMigration, inspectHubGroupPolicyBinding } from "../src/hub/group-policy/store.js";
import { createHubGroupResources, HUB_GROUP_RESOURCES_MIGRATION } from "../src/hub/group-policy/resources.js";
import { createHubGroupAuthorization } from "../src/hub/group-policy/authorization.js";
import { signAsker } from "../src/hub/identity.js";
import type { HubExposure, PersonKey } from "../src/hub/types.js";
import type { PolicyGroupFacts } from "../src/hub/directory/groups.js";
const rigs: Awaited<ReturnType<typeof hubRig>>[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); });
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
it("publishes and enrolls over the paired real WSS link, then holds a new revision during unknown membership", async () => {
  const r = await hubRig(); rigs.push(r); const profile = await r.pair(), group = randomUUID(); let known = true;
  applyHubMigrations(r.db, [HUB_AUDIT_MIGRATION, ...HUB_HTTP_MIGRATIONS,
    groupPolicyMigration(r.identity.hubId, r.owner.realm, "generation-1"), HUB_GROUP_RESOURCES_MIGRATION]);
  const audit = createHubAudit({ db: r.db, contentKey: randomBytes(32) }), current = () => true;
  Object.assign(r.directory, { groupPolicy: "ad-direct-guid", readPolicyGroups: async (person: PersonKey): Promise<PolicyGroupFacts> => known
    ? { kind: "complete", person, groups: [group], observedAt: Date.now() } : { kind: "unknown" } });
  const policy = createHubGroupPolicyStore({ db: r.db, hubId: r.identity.hubId, realm: r.owner.realm, generation: "generation-1", directory: r.directory, audit, current });
  const resources = createHubGroupResources({ db: r.db, policy, audit, current }), ctx = { requestId: randomUUID(), current };
  resources.captureManual({ kind: "fleet", id: profile.fleetId, revision: 1, owner: r.owner }, ctx);
  policy.replace({ ...policy.read(), state: "enabled", groups: [{ group: { realm: r.owner.realm, objectId: group }, dn: "CN=Members,DC=example,DC=test", allow: ["publish_agents"], maxFleets: 1 }] }, r.owner, ctx);
  const actions = createHubGroupAuthorization({ db: r.db, administrator: r.owner, policy: () => policy,
    binding: () => inspectHubGroupPolicyBinding(r.db, r.identity.hubId, r.owner.realm, "generation-1"), audit, current,
    version: () => r.store.read().revocationVersion, advanceAuthorization: () => { throw Error("publication must not change transport version"); }, refreshAuthorization: () => {} });
  const issuerKey = createPrivateKey(readFileSync(join(r.root, "hub/keys/issuer-key.pem")));
  const http = createHubHttp({ uow: createHubUnitOfWork(r.db), audit, content: audit.content, directory: r.directory, pairing: r.pairing, store: r.store, groups: actions,
    config: { hubId: r.identity.hubId, name: "Example Hub", webOrigin: "https://hub.example.test", memberOrigin: r.memberOrigin, administrator: r.owner },
    current: () => ({ serverEnabled: current, memberEnabled: () => false, epoch: () => 0 }),
    issuer: { keyId: r.identity.issuerKeyId, sign: envelope => signAsker(envelope, issuerKey) }, transport: () => r.server }, hubTxDatabase);
  const outcomes = [gate<{ ok: true } | { error: unknown }>(), gate<{ ok: true } | { error: unknown }>()]; let snapshots = 0;
  r.setReceive(async (frame, link) => {
    const settled = frame.type === "exposure.snapshot" ? outcomes[snapshots++] : undefined;
    try { const out = await http.receive(frame, link); settled?.resolve({ ok: true }); return out; }
    catch (error) { settled?.resolve({ error }); throw error; }
  });
  try {
    const client = r.client(); await client.value.start(); const link = client.state.link!;
    const exposure: HubExposure = { id: randomUUID(), fleetId: profile.fleetId, owner: r.owner, displayName: "Example helper", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) };
    await link.send({ v: 1, type: "exposure.snapshot", requestId: randomUUID(), linkEpoch: link.linkEpoch, payload: { revision: 1, exposures: [exposure] } });
    expect(await outcomes[0]!.promise).toEqual({ ok: true });
    expect(r.db.prepare("SELECT revision,state FROM hub_exposures").all()).toEqual([{ revision: 1, state: "published" }]);
    expect(resources.read({ kind: "exposure", id: exposure.id, revision: 1, owner: r.owner })).toMatchObject({ source: "group", state: "active" });
    known = false;
    await link.send({ v: 1, type: "exposure.snapshot", requestId: randomUUID(), linkEpoch: link.linkEpoch, payload: { revision: 2, exposures: [{ ...exposure, revision: 2 }] } });
    expect(await outcomes[1]!.promise).toMatchObject({ error: { code: "unavailable" } });
    expect(r.db.prepare("SELECT revision,state FROM hub_exposures").all()).toEqual([{ revision: 1, state: "published" }]);
    expect(resources.read({ kind: "exposure", id: exposure.id, revision: 2, owner: r.owner })).toBeNull(); expect(audit.verifyChain()).toMatchObject({ ok: true });
  } finally { actions.close(); await http.close(); }
});
