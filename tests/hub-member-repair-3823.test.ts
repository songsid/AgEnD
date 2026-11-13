/** Owned TLS/WSS + SQLite reproduction; directory and input delivery are inert. */
import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hubRig } from "./helpers/hub-rig.js";
import { createHubMemberFactory, memberSet, withdrawMemberExposuresOffline } from "../src/hub/compose/member.js";
import { MEMBER_COMPONENTS } from "../src/hub/runtime.js";
import { HubMemberJournal } from "../src/hub/member-journal.js";
import { HubFileVersionFloor } from "../src/hub/version-floor.js";
import { HubMemberProfileStore } from "../src/hub/profile.js";
import { createHubAudit } from "../src/hub/audit/index.js";
import { HubExposureStore, publishExposure } from "../src/hub/member/exposures.js";
import type { HubStateSet } from "../src/hub/db.js";
import type { HubMemberProfile } from "../src/hub/profile.js";
import { beginHubPairing, claimHubPairing } from "../src/hub/pairing-client.js";
import { HUB_HTTP_MIGRATIONS } from "../src/hub/http/schema.js";
import { HubRoomsService } from "../src/hub/rooms.js";
import type { HubCore } from "../src/hub/http/core.js";
import type { HubPolicyService } from "../src/hub/policy.js";
import type { HubMountedService } from "../src/hub/mount.js";
import { operationDigest, personKeyString, sha256 } from "../src/hub/identity.js";
import type { HubQuestion } from "../src/hub/types.js";

const rigs: Awaited<ReturnType<typeof hubRig>>[] = [], services: HubMountedService[] = [];
afterEach(async () => { for (const s of services.splice(0).reverse()) await s.close(); for (const r of rigs.splice(0)) await r.close(); });
async function rig() { const r = await hubRig(); rigs.push(r); await r.pair(); return r; }
async function member(r: Awaited<ReturnType<typeof rig>>) {
  const links: string[] = [], api: { value: unknown } = { value: null };
  const create = createHubMemberFactory({ home: r.memberHome, components: MEMBER_COMPONENTS, boundHub: () => r.identity.hubId,
    agents: () => [], representative: { deliver: async () => { throw Error("no input in fixture"); }, agentToken: () => null, attachReports: () => {} },
    attachExposures: value => { api.value = value; }, attachAttention: () => {}, pokeAttention: () => {},
    linkState: value => links.push(value), report: () => {}, log: () => {} });
  const service = await create({}, () => true); services.push(service); return { service, links, api };
}
function journal(r: Awaited<ReturnType<typeof rig>>, set = memberSet(r.identity.hubId)) {
  const db = new Database(join(r.memberHome, set.database));
  db.exec("CREATE TABLE IF NOT EXISTS fixture_sources(source TEXT PRIMARY KEY,id TEXT)");
  return { db, value: new HubMemberJournal(db, { hubId: r.identity.hubId,
    encryptionKey: Buffer.from(readFileSync(join(r.memberHome, set.keys[0]!), "utf8").trim(), "base64"),
    floor: new HubFileVersionFloor(r.memberHome, set.floors[0]!), outbox: {
      insert: (tx, _q, source) => { const id = randomUUID(); tx.prepare("INSERT INTO fixture_sources VALUES(?,?)").run(source, id); return id; },
      lookup: (tx, _q, source) => (tx.prepare("SELECT id FROM fixture_sources WHERE source=?").get(source) as { id: string } | undefined)?.id ?? null } }) };
}
function legacy(r: Awaited<ReturnType<typeof rig>>) {
  const j = journal(r); j.db.exec("ALTER TABLE hub_member_meta DROP COLUMN binding");
  j.db.prepare("UPDATE hub_schema SET version=1 WHERE component='s1-member-journal'").run(); j.db.close();
}
function exposure(r: Awaited<ReturnType<typeof rig>>, profile: HubMemberProfile, set: HubStateSet, publish = true) {
  const db = new Database(join(r.memberHome, set.database));
  const store = new HubExposureStore(db, { floor: new HubFileVersionFloor(r.memberHome, set.floors[2]!),
    audit: createHubAudit({ db, contentKey: Buffer.from(readFileSync(join(r.memberHome, set.keys[1]!), "utf8").trim(), "base64") }),
    binding: () => ({ owner: profile.owner, fleetId: profile.fleetId }), views: new Map() });
  const input = { agent: "fixture", providerId: "agent", displayName: "Fixture", dataViewId: "agent", allowedTools: [], expectedRevision: 0 };
  if (publish) publishExposure(store, input, c => ({ ok: true, policyDigest: c.exposure.policyDigest, exposureRevision: c.exposure.revision }));
  else store.stage(input);
  const rows = store.list(); db.close(); return rows;
}
async function seeded() {
  const r = await rig(), initial = await member(r); await initial.service.close();
  const profile = new HubMemberProfileStore(r.memberHome, r.identity.hubId).readProfile(), j = journal(r), now = Date.now();
  const q: HubQuestion = { text: "inert fixture", identity: { v: 1, issuer: r.identity.hubId, issuerKeyId: r.identity.issuerKeyId,
    messageId: randomUUID(), asker: r.owner, owner: r.owner, destinationFleetId: profile.fleetId, exposureId: randomUUID(), roomId: randomUUID(), grantId: randomUUID(),
    grantRevision: 1, exposureRevision: 1, revocationVersion: 0, contentDigest: sha256("inert fixture"), issuedAt: now, expiresAt: now + 60000,
    nonce: randomBytes(32).toString("hex"), signature: randomBytes(64).toString("base64url") } };
  const p = j.value.prepare(q), request = { messageId: q.identity.messageId, operationId: p.operationId, exposureRevision: 1, phase: "admit" as const };
  const receipt = j.value.commitAdmission(q, request, { ...request, decisionId: randomUUID(), operationDigest: operationDigest(request), linkEpoch: 1, revocationVersion: 0, expiresAt: now + 5000 },
    { current: () => true, linkEpoch: 1, revocationVersion: 0 });
  j.db.close();
  return { r, profile, q, p, receipt };
}
async function rePair(r: Awaited<ReturnType<typeof rig>>) {
  const profiles = new HubMemberProfileStore(r.memberHome, r.identity.hubId), digest = profiles.profileDigest();
  await r.pairing.revoke(r.ctx, profiles.readProfile().fleetId);
  const offer = await r.pairing.create(r.ctx, r.owner);
  const pending = await beginHubPairing({ home: r.memberHome, memberOrigin: r.memberOrigin, code: offer.code, current: () => true });
  await r.pairing.confirmOwner(r.ctx, pending.pairingId, pending.fingerprint); await r.pairing.approve(r.ctx, pending.pairingId, pending.fingerprint);
  await claimHubPairing({ home: r.memberHome, hubId: r.identity.hubId, approvedFingerprint: pending.fingerprint, expectedProfileDigest: digest, current: () => true });
  return profiles.readProfile();
}

it.each(["bound", "v1"])("#3823 (%s): a new Fleet binding never replays the revoked Fleet's IDs or receipts on the real member link", async mode => {
  const { r, profile, q } = await seeded();
  if (mode === "v1") legacy(r);
  for (const m of HUB_HTTP_MIGRATIONS) m.up(r.db);
  const owner = personKeyString(r.owner), now = Date.now();
  r.db.prepare("INSERT INTO hub_exposures(id,fleet_id,owner,display_name,revision,state,data_view_id,allowed_tools,policy_digest,frozen_through,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(q.identity.exposureId, profile.fleetId, owner, "fixture", 1, "published", "agent", "[]", "a".repeat(64), -1, now);
  r.db.prepare("INSERT INTO hub_grants(id,revision,owner,exposure_id,exposure_revision,approved_by,approved_at,subject,permissions,starts_at,expires_at,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(q.identity.grantId, 1, owner, q.identity.exposureId, 1, owner, now, owner, '["ask"]', now, now + 60000, "active");
  r.db.prepare("INSERT INTO hub_rooms VALUES(?,?,?,?,?,?,?)").run(q.identity.roomId, owner, q.identity.exposureId, owner, q.identity.grantId, "active", now);
  // Minimal retained Hub row. Reconcile only reads its fleet and digest; the production conflict guard stays intact.
  r.db.prepare(`INSERT INTO hub_messages(id,room_id,idempotency_key,sequence,fleet_id,exposure_id,exposure_revision,grant_id,grant_revision,asker,owner,content_digest,question_ref,stage,stage_at,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'cancelled',?,?,?)`).run(q.identity.messageId, q.identity.roomId, randomUUID(), 1, profile.fleetId, q.identity.exposureId, 1, q.identity.grantId, 1,
      "directory/fixture", "directory/fixture", q.identity.contentDigest, "fixture", Date.now(), Date.now(), Date.now() + 60000);
  const rooms = new HubRoomsService({ atomic: <T>(work: (db: Database.Database) => T) => r.db.transaction(() => work(r.db)).immediate() } as HubCore, {} as HubPolicyService);
  const next = await rePair(r); expect(next.fleetId).not.toBe(profile.fleetId);
  const currentLink = { fleetId: next.fleetId, owner: r.owner, linkEpoch: 1, current: () => true, features: new Set<string>() };
  expect(() => rooms.reconcile({ afterReceiptSequence: 0, messages: [{ messageId: q.identity.messageId, contentDigest: q.identity.contentDigest }] }, currentLink)).toThrow("conflict");
  r.setReceive(async (frame, link) => {
    if (frame.type === "exposure.snapshot") { expect(frame.payload.exposures).toEqual([]); return; }
    expect(frame.type).toBe("reconcile"); if (frame.type !== "reconcile") throw Error("old receipt replayed");
    return { v: 1, type: "reconcile", requestId: frame.requestId, linkEpoch: link.linkEpoch, payload: rooms.reconcile(frame.payload, link) };
  });
  const reopened = await member(r); await expect(reopened.service.start()).resolves.toBeUndefined();
  expect(reopened.links).toContain("online");
  expect(r.received.filter(f => f.type === "reconcile").every(f => f.payload.messages.length === 0)).toBe(true);
  const retained = journal(r); expect(retained.value.knownMessages().messages).toEqual([{ messageId: q.identity.messageId, contentDigest: q.identity.contentDigest }]); retained.db.close();
});

it("same-Fleet restart retains the exact operation, delivery and outstanding receipt", async () => {
  const { r, q, p, receipt } = await seeded();
  let reconciled = false, acknowledged = false;
  r.setReceive(async (frame, link) => {
    const common = { v: 1 as const, requestId: frame.requestId, linkEpoch: link.linkEpoch };
    if (frame.type === "reconcile") {
      expect(frame.payload.messages).toEqual([{ messageId: q.identity.messageId, contentDigest: q.identity.contentDigest }]); reconciled = true;
      return { ...common, type: "reconcile", payload: { receipts: [], nextReceiptSequence: 0, more: false } };
    }
    if (frame.type === "receipt") { expect(frame.payload).toEqual(receipt); acknowledged = true; return { ...common, type: "receipt", payload: frame.payload }; }
  });
  const reopened = await member(r); await reopened.service.start(); await reopened.service.close();
  expect(reconciled).toBe(true); expect(acknowledged).toBe(true);
  const j = journal(r);
  try { expect(j.value.prepare(q)).toEqual({ ...p, receipt }); expect(j.value.unackedReceipts().receipts).toEqual([]); }
  finally { j.db.close(); }
});

it("binding paths distinguish immutable identity, retaining address/credential and authorization refreshes", () => {
  const base = { fleetId: randomUUID(), issuerKeyId: "a".repeat(64), owner: { realm: "directory", objectId: randomUUID() } }, hubId = randomUUID();
  const path = memberSet(hubId, base);
  for (const other of [{ ...base, fleetId: randomUUID() }, { ...base, issuerKeyId: "b".repeat(64) }, { ...base, owner: { ...base.owner, objectId: randomUUID() } }])
    expect(memberSet(hubId, other)).not.toEqual(path);
  expect(memberSet(randomUUID(), base)).not.toEqual(path);
  expect(memberSet(hubId, { ...base, credential: "renewed", memberOrigin: "https://moved.test", revocationVersion: 99 } as typeof base)).toEqual(path);
});

it("v1 same-Fleet migration retains exact records across credential/web-address refresh and restart", async () => {
  const { r, profile, q, p, receipt } = await seeded(); const set = memberSet(r.identity.hubId);
  const rows = exposure(r, profile, set); legacy(r);
  const before = journal(r); const value = before.db.prepare("SELECT value FROM hub_member_messages").get(); before.db.close();
  const profiles = new HubMemberProfileStore(r.memberHome, r.identity.hubId);
  profiles.saveProfile({ ...profile, credential: "b".repeat(64), hub: { ...profile.hub, webOrigin: "https://moved.example.test" } }, profiles.profileDigest(), () => true);
  const reopened = await member(r); await reopened.service.close();
  const j = journal(r);
  try {
    expect(j.db.prepare("SELECT value FROM hub_member_messages").get()).toEqual(value);
    expect(j.value.prepare(q)).toEqual({ ...p, receipt });
    expect(j.db.prepare("SELECT committed,staged FROM hub_exposures").all()).toEqual(rows.map(row => ({ committed: JSON.stringify(row.committed), staged: null })));
    expect(j.db.prepare("SELECT version FROM hub_schema WHERE component='s1-member-journal'").get()).toEqual({ version: 2 });
    expect(existsSync(join(r.memberHome, memberSet(r.identity.hubId, profile).database))).toBe(false);
  } finally { j.db.close(); }
});

it.each([true, false])("v1 exposure-only ownership (published=%s) keeps old consent out of the new Fleet", async published => {
  const r = await rig(), first = await member(r); await first.service.close();
  const profile = new HubMemberProfileStore(r.memberHome, r.identity.hubId).readProfile(), set = memberSet(r.identity.hubId);
  const rows = exposure(r, profile, set, published); legacy(r);
  const next = await rePair(r), reopened = await member(r); await reopened.service.close();
  const current = journal(r, memberSet(r.identity.hubId, next));
  try { expect(current.db.prepare("SELECT * FROM hub_exposures").all()).toEqual([]); expect(current.value.revocationVersion()).toBe(0); }
  finally { current.db.close(); }
  const old = journal(r);
  try { expect(old.db.prepare("SELECT committed,staged FROM hub_exposures").all()).toEqual(rows.map(row => ({ committed: row.committed ? JSON.stringify(row.committed) : null, staged: row.staged ? JSON.stringify(row.staged) : null }))); }
  finally { old.db.close(); }
});

it("a scoped Fleet retains its own receipt/revocation state on restart and offline withdrawal selects only that Fleet", async () => {
  const { r, profile, q, receipt } = await seeded();
  exposure(r, profile, memberSet(r.identity.hubId));
  const old = journal(r); old.value.observeRevocationVersion(4); old.db.close();
  const next = await rePair(r), first = await member(r); await first.service.close();
  const set = memberSet(r.identity.hubId, next); exposure(r, next, set);
  const j = journal(r, set), ownQuestion = { ...q, identity: { ...q.identity, messageId: randomUUID(), destinationFleetId: next.fleetId } };
  const prepared = j.value.prepare(ownQuestion); j.value.observeRevocationVersion(2); j.db.close();
  const again = await member(r); await again.service.close();
  expect(await withdrawMemberExposuresOffline(r.memberHome, r.identity.hubId)).toBe(1);
  expect(await withdrawMemberExposuresOffline(r.memberHome, r.identity.hubId)).toBe(0);
  const current = journal(r, set), retained = journal(r);
  try {
    expect(current.value.prepare(ownQuestion)).toEqual(prepared); expect(current.value.revocationVersion()).toBe(2);
    expect(current.value.knownMessages().messages).toEqual([{ messageId: ownQuestion.identity.messageId, contentDigest: ownQuestion.identity.contentDigest }]);
    expect(current.db.prepare("SELECT json_extract(committed,'$.exposure.state') AS state FROM hub_exposures").get()).toEqual({ state: "withdrawn" });
    expect(retained.value.unackedReceipts().receipts).toEqual([receipt]); expect(retained.value.revocationVersion()).toBe(4);
    expect(retained.db.prepare("SELECT json_extract(committed,'$.exposure.state') AS state FROM hub_exposures").get()).toEqual({ state: "published" });
    for (let i = 0; i < set.keys.length; i++) expect(readFileSync(join(r.memberHome, set.keys[i]!))).not.toEqual(readFileSync(join(r.memberHome, memberSet(r.identity.hubId).keys[i]!)));
    expect(() => current.value.prepare(q)).toThrow("denied");
  } finally { current.db.close(); retained.db.close(); }
});

it("a partial scoped set never falls back to the complete legacy set after a failed startup", async () => {
  const { r } = await seeded(), next = await rePair(r), first = await member(r); await first.service.close();
  const set = memberSet(r.identity.hubId, next); unlinkSync(join(r.memberHome, set.floors[0]!));
  await expect(member(r)).rejects.toThrow("partial");
  await expect(withdrawMemberExposuresOffline(r.memberHome, r.identity.hubId)).rejects.toThrow("partial");
  expect(existsSync(join(r.memberHome, set.floors[0]!))).toBe(false);
});

it("a legacy revision mismatch is held rather than relabelled or reset for the new pairing", async () => {
  const { r } = await seeded(); legacy(r); await rePair(r);
  const set = memberSet(r.identity.hubId); writeFileSync(join(r.memberHome, set.floors[0]!), "999", { mode: 0o600 });
  await expect(member(r)).rejects.toThrow("uncertain");
  const profile = new HubMemberProfileStore(r.memberHome, r.identity.hubId).readProfile();
  expect(existsSync(join(r.memberHome, memberSet(r.identity.hubId, profile).database))).toBe(false);
});

it("legacy adoption checks even the parked S4 execution floor", async () => {
  const { r } = await seeded(); legacy(r);
  writeFileSync(join(r.memberHome, memberSet(r.identity.hubId).floors[1]!), "1", { mode: 0o600 });
  await expect(member(r)).rejects.toThrow("execution database and floor disagree");
});
