/**
 * S3c (S-55): the member's exposure store and the owner's publish flow (docs/design/hub-s3c-exposures.md).
 * - publish / revise / withdraw: revisions and the snapshot revision only go up, each change audited in its own
 *   transaction (S5's chain), the floor raised with it; a newer DB than the floor is uncertain.
 * - the seam: stage (invisible: state "withdrawn") → S4 readinessCandidate → recheck → atomic publish; a refusal at any
 *   step drops the candidate and leaves the committed mapping as it was.
 * - with the real S1 admission and S4 service reading this store: an unpublished question is refused, a withdrawn
 *   exposure is fenced (S4 sees null, admission refuses), a revised one makes the old revision's question stale.
 * - snapshot(): complete, published only, never staged.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { HubMemberJournal, migrateHubMemberJournal } from "../src/hub/member-journal.js";
import { HubMemberAdmissionAdapter } from "../src/hub/admission.js";
import { issuerKeyId, operationDigest, sha256, signAsker } from "../src/hub/identity.js";
import { HubExecutionStore, migrateHubExecution } from "../src/hub/execution/store.js";
import { HubRestrictedExecutionService, type HubExecutionReadiness, type HubIsolatedProvider, type HubLocalExposure } from "../src/hub/execution/service.js";
import { HubDocumentView, executionPolicyDigest } from "../src/hub/execution/views.js";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import { applyHubMigrations } from "../src/hub/db.js";
import { HUB_EXPOSURE_MAX, HUB_EXPOSURE_MIGRATION, HubExposureRefusal, HubExposureStore, publishExposure } from "../src/hub/member/exposures.js";
import type { HubAuthorizationLease, HubAuthorizationRequest, HubQuestion } from "../src/hub/types.js";
import type { HubMemberProfile } from "../src/hub/profile.js";

const databases: Database.Database[] = [];
afterEach(() => { databases.splice(0).forEach((db) => db.close()); vi.restoreAllMocks(); });
const TOOLS = ["documents.list", "documents.read"];

function rig() {
  const db = new Database(":memory:"); databases.push(db);
  applyHubMigrations(db, [HUB_AUDIT_MIGRATION, HUB_EXPOSURE_MIGRATION]);
  migrateHubExecution(db); migrateHubMemberJournal(db);
  const audit = createHubAudit({ db, contentKey: randomBytes(32) });
  let floor = 0, now = 1_800_000_000_000, revocationVersion = 1, linkEpoch = 1, paired = true, ready = true;
  const keys = generateKeyPairSync("ed25519"), owner = { realm: "directory", objectId: randomUUID() };
  const profile: HubMemberProfile = { v: 1, hub: { hubId: randomUUID(), memberOrigin: "https://hub.test", webOrigin: "https://web.test", spkiSha256: "a".repeat(64), issuerPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }, owner, fleetId: randomUUID(), credential: "a".repeat(64), certificatePem: "unused", issuerKeyId: issuerKeyId(keys.publicKey) };
  const view = new HubDocumentView("approved", [{ id: "note", title: "Approved note", text: "APPROVED" }]);
  const other = new HubDocumentView("other", [{ id: "n2", title: "Other", text: "OTHER" }]);
  const views = new Map([[view.id, view], [other.id, other]]);
  const floorOf = { read: () => floor, raise: (n: number) => { if (n < floor) throw Error("floor down"); floor = n; } };
  const store = new HubExposureStore(db, { floor: floorOf, audit, views, binding: () => (paired ? { owner: { ...owner }, fleetId: profile.fleetId } : null), now: () => now });
  store.initialize();
  // S4 with the real service: its readiness of a candidate stands in for Cairn's readinessCandidate (same checks: the
  // exact owner/fleet, the installed view's policy digest, a hub-restricted provider), plus a switch to refuse.
  const providers = new Map<string, HubIsolatedProvider>([["inert", { isolation: "hub-restricted-v1", open: vi.fn() as any }]]);
  const readiness = vi.fn((c: HubLocalExposure): HubExecutionReadiness => {
    if (!ready || !providers.has(c.providerId) || c.exposure.state !== "withdrawn") return { ok: false, reasonCode: "provider-unavailable" } as HubExecutionReadiness;
    const v = views.get(c.exposure.dataViewId);
    return v && executionPolicyDigest(v, c.exposure.allowedTools) === c.exposure.policyDigest
      ? { ok: true, policyDigest: c.exposure.policyDigest, exposureRevision: c.exposure.revision } : { ok: false, reasonCode: "policy-unavailable" } as HubExecutionReadiness;
  });
  const execStore = new HubExecutionStore(db, { floor: { read: () => execFloor, raise: (n: number) => { execFloor = n; } }, audit: () => {} });
  let execFloor = 0; execStore.initialize();
  const authorize = vi.fn(async (r: HubAuthorizationRequest): Promise<HubAuthorizationLease> => ({ decisionId: randomUUID(), messageId: r.messageId, operationId: r.operationId, phase: r.phase, operationDigest: operationDigest(r), exposureRevision: r.exposureRevision, linkEpoch, revocationVersion, expiresAt: now + 5_000 }));
  let service!: HubRestrictedExecutionService;
  let journalFloor = 0;
  const journal = new HubMemberJournal(db, { hubId: profile.hub.hubId, encryptionKey: randomBytes(32), floor: { read: () => journalFloor, raise: (n: number) => { journalFloor = n; } },
    outbox: { insert: (tx: Database.Database, v: HubQuestion, s: string) => service.restrictedOutbox().insert(tx, v, s), lookup: (tx: Database.Database, v: HubQuestion, s: string) => service.restrictedOutbox().lookup(tx, v, s) }, now: () => now });
  journal.initialize();
  const binding = () => ({ hubId: profile.hub.hubId, issuerKeyId: profile.issuerKeyId, issuerPublicKey: createPublicKey(profile.hub.issuerPublicKey), fleetId: profile.fleetId, owner: { ...owner }, revocationVersion, generation: 1, linkEpoch, current: () => true });
  service = new HubRestrictedExecutionService({ store: execStore, journal, transport: { authorize }, views, providers, now: () => now, attentionChanged: vi.fn(), binding, localExposure: (id) => store.localExposure(id) });
  service.recover();
  const admission = new HubMemberAdmissionAdapter({ journal, transport: { authorize, start: async () => {}, close: async () => {}, send: async () => {} },
    binding: () => ({ profile, linkEpoch, revocationVersion, current: () => true }), exposure: (id) => store.exposure(id), fenceLocal: (id) => service.fence(id), hold: vi.fn(), now: () => now });
  const question = (exposureId: string, exposureRevision: number, text = "What does the note say?"): HubQuestion => ({ text, identity: signAsker({ v: 1, issuer: profile.hub.hubId, issuerKeyId: profile.issuerKeyId, messageId: randomUUID(), asker: { realm: "directory", objectId: randomUUID() }, owner, destinationFleetId: profile.fleetId, exposureId, roomId: randomUUID(), grantId: randomUUID(), grantRevision: 1, exposureRevision, revocationVersion, contentDigest: sha256(text), issuedAt: now, expiresAt: now + 120_000, nonce: randomBytes(32).toString("hex") }, keys.privateKey) });
  const input = (over: Record<string, unknown> = {}) => ({ agent: "atlas", providerId: "inert", displayName: "Atlas notes", dataViewId: view.id, allowedTools: TOOLS, expectedRevision: 0, ...over });
  const auditRows = () => (db.prepare("SELECT action FROM hub_audit ORDER BY sequence").all() as Array<{ action: string }>).map((r) => r.action);
  return { db, store, readiness, admission, service, question, input, view, other, views, audit, auditRows, owner, profile,
    floor: () => floor, setFloor: (n: number) => { floor = n; }, unpair: () => { paired = false; }, refuse: () => { ready = false; }, allow: () => { ready = true; } };
}

describe("S3c: the member's exposure store", () => {
  it("publish: staged then promoted in one go; the committed mapping is S1's and S4's; revisions, floor and audit move together", () => {
    const f = rig();
    const pub = publishExposure(f.store, f.input(), f.readiness);
    expect(pub.exposure).toMatchObject({ revision: 1, state: "published", dataViewId: "approved", allowedTools: TOOLS, fleetId: f.profile.fleetId, owner: f.owner,
      policyDigest: executionPolicyDigest(f.view, TOOLS) });
    expect(f.store.exposure(pub.exposure.id)).toEqual(pub.exposure);
    expect(f.store.localExposure(pub.exposure.id)).toEqual(pub);
    expect(f.store.snapshot()).toEqual({ revision: 2, exposures: [pub.exposure] });     // stage + publish
    expect(f.floor()).toBe(2);
    expect(f.auditRows()).toEqual(["exposure.staged", "exposure.published"]);
    expect(f.audit.verifyChain().ok).toBe(true);
    expect(f.readiness).toHaveBeenCalledTimes(2);                                      // before, and again inside the publish
    expect(f.store.list()).toEqual([{ agent: "atlas", committed: pub, staged: null }]);
  });
  it("revise: the next revision, a new consent and generation; the old revision's question turns stale", async () => {
    const f = rig();
    const v1 = publishExposure(f.store, f.input(), f.readiness);
    const v2 = publishExposure(f.store, f.input({ dataViewId: "other", allowedTools: ["documents.list"], expectedRevision: 1 }), f.readiness);
    expect(v2.exposure).toMatchObject({ id: v1.exposure.id, revision: 2, dataViewId: "other", allowedTools: ["documents.list"], state: "published" });
    expect([v2.generation, v2.consentId === v1.consentId]).toEqual([2, false]);
    await expect(f.admission.admit(f.question(v1.exposure.id, 1))).rejects.toThrow();  // the old revision
    await expect(f.admission.admit(f.question(v1.exposure.id, 2))).resolves.toMatchObject({ stage: "queued" });
    // A revise against a revision the owner did not see: conflict, nothing changed.
    expect(() => f.store.stage(f.input({ expectedRevision: 1 }))).toThrow(HubExposureRefusal);
    expect(f.store.exposure(v1.exposure.id)!.revision).toBe(2);
  });
  it("an unpublished question is refused: a staged candidate is invisible to admission, S4 and the snapshot", async () => {
    const f = rig();
    const candidate = f.store.stage(f.input());
    expect(candidate.exposure.state).toBe("withdrawn");
    expect([f.store.exposure(candidate.exposure.id), f.store.localExposure(candidate.exposure.id)]).toEqual([null, null]);
    expect(f.store.snapshot().exposures).toEqual([]);
    await expect(f.admission.admit(f.question(candidate.exposure.id, 1))).rejects.toThrow();
    expect(f.service.readiness(candidate.exposure.id, 1).ok).toBe(false);
    // A published v1 with a staged v2: admission and S4 still see v1 only.
    f.store.discard(candidate.exposure.id);
    const v1 = publishExposure(f.store, f.input(), f.readiness);
    f.store.stage(f.input({ dataViewId: "other", expectedRevision: 1 }));
    expect(f.store.exposure(v1.exposure.id)).toEqual(v1.exposure);
    await expect(f.admission.admit(f.question(v1.exposure.id, 2))).rejects.toThrow();
  });
  it("a withdrawn exposure is fenced: admission refuses, S4 sees null, the snapshot leaves it out; withdrawing twice is a conflict", async () => {
    const f = rig();
    const v1 = publishExposure(f.store, f.input(), f.readiness);
    const out = f.store.withdraw(v1.exposure.id, 1);
    expect(out.exposure).toMatchObject({ revision: 2, state: "withdrawn" });
    expect(f.store.exposure(v1.exposure.id)!.state).toBe("withdrawn");
    expect(f.store.localExposure(v1.exposure.id)).toBeNull();
    expect(f.store.snapshot().exposures).toEqual([]);
    await expect(f.admission.admit(f.question(v1.exposure.id, 1))).rejects.toThrow();
    await expect(f.admission.admit(f.question(v1.exposure.id, 2))).rejects.toThrow();
    expect(() => f.store.withdraw(v1.exposure.id, 2)).toThrow(HubExposureRefusal);
    expect(() => f.store.withdraw(v1.exposure.id, 1)).toThrow(HubExposureRefusal);
    expect(f.auditRows().at(-1)).toBe("exposure.withdrawn");
    // Published again later: the next revision, from what the owner sees.
    expect(publishExposure(f.store, f.input({ expectedRevision: 2 }), f.readiness).exposure).toMatchObject({ revision: 3, state: "published" });
  });
  it("the seam refuses at each step and leaves the committed mapping as it was", () => {
    const f = rig();
    const v1 = publishExposure(f.store, f.input(), f.readiness);
    // Readiness refuses first.
    f.refuse();
    expect(() => publishExposure(f.store, f.input({ dataViewId: "other", expectedRevision: 1 }), f.readiness)).toThrow(expect.objectContaining({ code: "not_enforceable" }));
    expect(f.store.exposure(v1.exposure.id)).toEqual(v1.exposure);
    expect(f.store.list()[0]!.staged).toBeNull();
    f.allow();
    // Readiness changes between the first check and the publish (asked again inside it).
    let calls = 0;
    const flip = (c: HubLocalExposure) => (++calls === 1 ? f.readiness(c) : ({ ok: false, reasonCode: "provider-unavailable" } as HubExecutionReadiness));
    expect(() => publishExposure(f.store, f.input({ dataViewId: "other", expectedRevision: 1 }), flip)).toThrow(expect.objectContaining({ code: "not_enforceable" }));
    expect(f.store.exposure(v1.exposure.id)).toEqual(v1.exposure);
    // The candidate changed under it (staged again): conflict.
    const a = f.store.stage(f.input({ dataViewId: "other", expectedRevision: 1 }));
    f.store.stage(f.input({ allowedTools: ["documents.list"], expectedRevision: 1 }));
    expect(() => f.store.publish(a, f.readiness)).toThrow(expect.objectContaining({ code: "conflict" }));
    // Unpaired between stage and publish: conflict; never paired: not_paired.
    const b = f.store.stage(f.input({ expectedRevision: 1 }));
    f.unpair();
    expect(() => f.store.publish(b, f.readiness)).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(() => f.store.stage(f.input({ expectedRevision: 1 }))).toThrow(expect.objectContaining({ code: "not_paired" }));
    expect(f.store.exposure(v1.exposure.id)).toEqual(v1.exposure);
  });
  it("refused up front: an unknown view, tools S4 would deny; more than HUB_EXPOSURE_MAX published", () => {
    const f = rig();
    expect(() => f.store.stage(f.input({ dataViewId: "nope" }))).toThrow(expect.objectContaining({ code: "unknown_view" }));
    expect(() => f.store.stage(f.input({ allowedTools: ["shell.exec"] }))).toThrow(expect.objectContaining({ code: "not_enforceable" }));
    for (let i = 0; i < HUB_EXPOSURE_MAX; i++) publishExposure(f.store, f.input({ agent: `a${i}` }), f.readiness);
    expect(() => publishExposure(f.store, f.input({ agent: "one-more" }), f.readiness)).toThrow(expect.objectContaining({ code: "limit" }));
    expect(f.store.snapshot().exposures).toHaveLength(HUB_EXPOSURE_MAX);
  });
  it("storage: a floor that disagrees with the DB is uncertain (no read, no write); initialize only on a new set", () => {
    const f = rig();
    publishExposure(f.store, f.input(), f.readiness);
    expect(() => f.store.initialize()).toThrow();
    f.setFloor(1);                                                       // rolled back under it
    expect(() => f.store.snapshot()).toThrow(/uncertain/);
    expect(() => f.store.exposure(randomUUID())).toThrow(/uncertain/);
    f.setFloor(2);
    expect(() => f.store.snapshot()).toThrow(/uncertain/);               // stays failed until a restart
  });
});

describe("S3c: the snapshot to the Hub", () => {
  const link = (epoch: number) => {
    let live = true;
    const sent: any[] = [];
    return { sent, kill: () => { live = false; }, link: { linkEpoch: epoch, revocationVersion: 1, profile: {} as any, current: () => live,
      send: vi.fn(async (f: any) => { sent.push(f); }), exchange: vi.fn() } };
  };
  it("the handshake sends the complete current snapshot on the link's epoch with a fresh requestId; a commit sends again; a new link resends the same revision", async () => {
    const f = rig();
    const { exposureSnapshotSender } = await import("../src/hub/member/exposures.js");
    const s = exposureSnapshotSender(f.store), a = link(7);
    const v1 = publishExposure(f.store, f.input(), f.readiness);
    await s.publishSnapshot(a.link as any);
    expect(a.sent).toEqual([{ v: 1, type: "exposure.snapshot", requestId: expect.any(String), linkEpoch: 7, payload: { revision: 2, exposures: [v1.exposure] } }]);
    const { parseMemberFrame } = await import("../src/hub/protocol.js");
    expect(() => parseMemberFrame(JSON.stringify(a.sent[0]))).not.toThrow();        // the wire's own check
    f.store.withdraw(v1.exposure.id, 1);
    expect(await s.afterCommit()).toBe("pending");                                   // no ack frame: never "confirmed"
    expect(a.sent.at(-1).payload).toEqual({ revision: 3, exposures: [] });
    // A new link: the same revision again (metadata retry), a new requestId and epoch.
    const b = link(8);
    await s.publishSnapshot(b.link as any);
    expect(b.sent[0]).toMatchObject({ linkEpoch: 8, payload: { revision: 3 } });
    expect(b.sent[0].requestId).not.toBe(a.sent.at(-1).requestId);
    expect(s.sentRevision()).toBe(3);
  });
  it("an old link: nothing sent, nothing promoted; the handshake on a dead link fails; never an older revision", async () => {
    const f = rig();
    const { exposureSnapshotSender } = await import("../src/hub/member/exposures.js");
    const s = exposureSnapshotSender(f.store), a = link(1);
    await s.publishSnapshot(a.link as any);
    a.kill();
    publishExposure(f.store, f.input(), f.readiness);
    expect(await s.afterCommit()).toBe("pending");
    expect(a.sent).toHaveLength(1);
    await expect(s.publishSnapshot(a.link as any)).rejects.toThrow(/stale/);
    // The link dies while the frame is in flight: nothing is promoted, and the handshake fails.
    const d = link(3);
    d.link.send = vi.fn(async (fr: any) => { d.sent.push(fr); d.kill(); });
    const s2 = exposureSnapshotSender(f.store);
    await expect(s2.publishSnapshot(d.link as any)).rejects.toThrow(/stale/);
    expect([d.sent.length, s2.sentRevision()]).toEqual([1, 0]);
    // A store whose snapshot went back: refused.
    const back = exposureSnapshotSender({ snapshot: () => ({ revision: 1, exposures: [] }) }), c = link(2);
    const fwd = exposureSnapshotSender({ snapshot: (() => { let r = 5; return () => ({ revision: r--, exposures: [] }); })() });
    await fwd.publishSnapshot(c.link as any);
    await expect(fwd.publishSnapshot(c.link as any)).rejects.toThrow(/stale/);
    await back.publishSnapshot(c.link as any);
    expect(c.sent.map((x: any) => x.payload.revision)).toEqual([5, 1]);
  });
});
