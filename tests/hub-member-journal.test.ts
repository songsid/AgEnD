import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { HubMemberJournal, migrateHubMemberJournal } from "../src/hub/member-journal.js";
import { HubMemberAdmissionAdapter } from "../src/hub/admission.js";
import { signAsker, sha256, issuerKeyId, operationDigest } from "../src/hub/identity.js";
import type { HubAuthorizationRequest, HubExposure, HubMemberTransport, HubQuestion } from "../src/hub/types.js";
import type { HubMemberProfile } from "../src/hub/profile.js";
const dbs: Database.Database[] = []; afterEach(() => dbs.splice(0).forEach(db => db.close()));
function fixture() {
  const db = new Database(":memory:"); dbs.push(db); migrateHubMemberJournal(db); db.exec("CREATE TABLE restricted_outbox(id TEXT PRIMARY KEY, source TEXT UNIQUE, digest TEXT)");
  const keys = generateKeyPairSync("ed25519"), now = 1_800_000_000_000, owner = { realm: "directory", objectId: randomUUID() };
  let live = true, floor = 0, revision = 1, revocation = 1;
  const profile: HubMemberProfile = { v: 1, hub: { hubId: randomUUID(), memberOrigin: "https://hub.test", webOrigin: "https://web.test", spkiSha256: "a".repeat(64), issuerPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }, owner, fleetId: randomUUID(), credential: "a".repeat(64), certificatePem: "not used by journal", issuerKeyId: issuerKeyId(keys.publicKey) };
  const exposure: HubExposure = { id: randomUUID(), fleetId: profile.fleetId, owner, displayName: "Exposed", revision: 1, state: "published", dataViewId: "view", allowedTools: ["read"], policyDigest: sha256("policy") };
  const q: HubQuestion = { text: "PRIVATE-QUESTION", identity: signAsker({ v: 1, issuer: profile.hub.hubId, issuerKeyId: profile.issuerKeyId, messageId: randomUUID(), asker: { realm: "directory", objectId: randomUUID() }, owner, destinationFleetId: profile.fleetId, exposureId: exposure.id, roomId: randomUUID(), grantId: randomUUID(), grantRevision: 1, exposureRevision: 1, revocationVersion: 1, contentDigest: sha256("PRIVATE-QUESTION"), issuedAt: now, expiresAt: now + 120_000, nonce: randomBytes(32).toString("hex") }, keys.privateKey) };
  const insert = vi.fn((tx: Database.Database, question: HubQuestion, source: string) => { const id = randomUUID(); tx.prepare("INSERT INTO restricted_outbox VALUES(?,?,?)").run(id, source, question.identity.contentDigest); return id; });
  const lookup = (tx: Database.Database, question: HubQuestion, source: string) => { const row = tx.prepare("SELECT id,digest FROM restricted_outbox WHERE source=?").get(source) as { id: string; digest: string } | undefined; if (row && row.digest !== question.identity.contentDigest) throw Error(); return row?.id ?? null; };
  const options = { hubId: profile.hub.hubId, encryptionKey: randomBytes(32), floor: { read: () => floor, raise: (n: number) => { floor = n; } }, outbox: { insert, lookup }, now: () => now };
  const journal = new HubMemberJournal(db, options); journal.initialize();
  const lease = (request: HubAuthorizationRequest) => ({ decisionId: randomUUID(), messageId: request.messageId, operationId: request.operationId, phase: request.phase, operationDigest: operationDigest(request), exposureRevision: request.exposureRevision, revocationVersion: revocation, linkEpoch: 1, expiresAt: now + 5_000 });
  const authorize = vi.fn(async (r: HubAuthorizationRequest) => lease(r));
  const transport: HubMemberTransport = { start: async () => {}, send: async () => {}, authorize, close: async () => {} };
  const hold = vi.fn(), fenceLocal = vi.fn();
  const admission = new HubMemberAdmissionAdapter({ journal, transport, binding: () => ({ profile, linkEpoch: 1, revocationVersion: revocation, current: () => live }), exposure: () => ({ ...exposure, revision }), fenceLocal, hold, now: () => now });
  const begin = () => ({ messageId: q.identity.messageId, operationId: randomUUID(), exposureRevision: 1, phase: "begin" as const });
  const fence = { current: () => live, linkEpoch: 1, revocationVersion: 1 };
  return { db, options, journal, admission, q, keys, profile, exposure, insert, authorize, lease, begin, fence, hold, fenceLocal, stop: () => { live = false; }, changeExposure: () => { revision++; }, revoke: () => { revocation++; } };
}
describe("Hub restricted member journal", () => {
  it("admits one exact source into the restricted outbox, with encrypted payload and monotonic receipts", async () => {
    const f = fixture(), first = await f.admission.admit(f.q), duplicate = await f.admission.admit(f.q);
    expect(first).toEqual(duplicate); expect(first.stage).toBe("queued"); expect(f.insert).toHaveBeenCalledTimes(1); expect(f.authorize).toHaveBeenCalledTimes(1);
    const row = f.db.prepare("SELECT value FROM hub_member_messages").get() as { value: string }; expect(row.value).not.toContain("PRIVATE-QUESTION");
    const source = f.db.prepare("SELECT source FROM restricted_outbox").get() as { source: string }; expect(source.source).toBe(`hub:${f.profile.hub.hubId}:${f.q.identity.messageId}`);
    expect(await f.admission.reconcile({ afterReceiptSequence: 0, messages: [{ messageId: f.q.identity.messageId, contentDigest: f.q.identity.contentDigest }] })).toEqual([first]);
  });
  it("a changed destination or body cannot reuse a message ID", async () => {
    const f = fixture(); await f.admission.admit(f.q);
    const modified = { ...f.q, identity: signAsker({ ...f.q.identity, roomId: randomUUID() }, f.keys.privateKey) };
    await expect(f.admission.admit(modified)).rejects.toThrow(); expect(f.insert).toHaveBeenCalledTimes(1);
    await expect(f.admission.admit({ ...f.q, text: "different" })).rejects.toThrow();
  });
  it.each(["owner stop", "exposure change", "revocation"])("rechecks %s after online authorization before inserting", async which => {
    const f = fixture(); f.authorize.mockImplementation(async request => { const l = f.lease(request); if (which === "owner stop") f.stop(); else if (which === "exposure change") f.changeExposure(); else f.revoke(); return l; });
    await expect(f.admission.admit(f.q)).rejects.toThrow(); expect(f.insert).not.toHaveBeenCalled(); expect(f.hold).toHaveBeenCalled();
  });
  it("never sends a second input after a crash at the durable intent boundary", async () => {
    const f = fixture(); await f.admission.admit(f.q); const request = f.begin(); f.journal.markInputIntent(f.q.identity.messageId, request, f.lease(request), f.fence);
    const second = f.begin(); expect(() => f.journal.markInputIntent(f.q.identity.messageId, second, f.lease(second), f.fence)).toThrow();
    const reopened = new HubMemberJournal(f.db, f.options), recovered = reopened.recoverInterruptedInputs(); expect(recovered).toMatchObject([{ stage: "uncertain" }]);
    expect(() => reopened.markInputIntent(f.q.identity.messageId, second, f.lease(second), f.fence)).toThrow();
    expect((await f.admission.admit(f.q)).stage).toBe("uncertain"); expect(f.insert).toHaveBeenCalledTimes(1);
  });
  it("does not downgrade positively delivered or consumed evidence on restart", async () => {
    const f = fixture(); await f.admission.admit(f.q); const request = f.begin(); f.journal.markInputIntent(f.q.identity.messageId, request, f.lease(request), f.fence);
    const delivered = f.journal.recordEvidence(f.q.identity.messageId, "delivered"), consumed = f.journal.recordEvidence(f.q.identity.messageId, "consumed");
    expect(consumed.sequence).toBeGreaterThan(delivered.sequence); expect(new HubMemberJournal(f.db, f.options).recoverInterruptedInputs()).toEqual([]);
    expect((await f.admission.admit(f.q)).stage).toBe("consumed");
  });
  it("cancels untouched work, holds unknown input, and retains exact old receipts on revocation", async () => {
    const f = fixture(); await f.admission.admit(f.q);
    await f.admission.fence({ revocationVersion: 2, scope: { kind: "grant", grantId: f.q.identity.grantId }, reasonCode: "revoked" });
    expect(f.fenceLocal).toHaveBeenCalledWith(f.q.identity.messageId); expect((await f.admission.admit(f.q)).stage).toBe("cancelled");
    expect(() => f.journal.markInputIntent(f.q.identity.messageId, f.begin(), f.lease(f.begin()), f.fence)).toThrow();
  });
  it("refuses forged acknowledgments, swapped ciphertext and an inconsistent source row", async () => {
    const f = fixture(), receipt = await f.admission.admit(f.q);
    expect(() => f.journal.acknowledge({ ...receipt, sequence: receipt.sequence + 1 })).toThrow();
    const row = JSON.parse((f.db.prepare("SELECT value FROM hub_member_messages").get() as { value: string }).value); row.contextDigest = "b".repeat(64);
    f.db.prepare("UPDATE hub_member_messages SET value=?").run(JSON.stringify(row));
    await expect(f.admission.admit(f.q)).rejects.toThrow(); expect(f.insert).toHaveBeenCalledTimes(1);
    const g = fixture(), prepared = g.journal.prepare(g.q); g.db.prepare("INSERT INTO restricted_outbox VALUES(?,?,?)").run(randomUUID(), `hub:${g.profile.hub.hubId}:${g.q.identity.messageId}`, g.q.identity.contentDigest);
    const r = { messageId: g.q.identity.messageId, operationId: prepared.operationId, exposureRevision: 1, phase: "admit" as const };
    expect(() => g.journal.commitAdmission(g.q, r, g.lease(r), g.fence)).toThrow();
  });
});

it.each(["admit", "begin", "release-answer"] as const)("binds the %s lease to this exact journal message and exposure revision", async phase => {
  for (const changed of ["messageId", "exposureRevision"] as const) {
    const f = fixture(), prepared = f.journal.prepare(f.q);
    let request: HubAuthorizationRequest = { messageId: f.q.identity.messageId, operationId: prepared.operationId, exposureRevision: 1, phase: "admit" };
    if (phase !== "admit") {
      f.journal.commitAdmission(f.q, request, f.lease(request), f.fence); request = f.begin();
      if (phase === "release-answer") {
        f.journal.markInputIntent(f.q.identity.messageId, request, f.lease(request), f.fence);
        f.journal.recordEvidence(f.q.identity.messageId, "delivered"); f.journal.recordEvidence(f.q.identity.messageId, "consumed");
        request = { ...f.begin(), phase, answer: { answerId: randomUUID(), contentDigest: sha256("inert answer") } };
      }
    }
    request = { ...request, [changed]: changed === "messageId" ? randomUUID() : 2 };
    const proof = f.lease(request);
    expect(() => {
      if (phase === "admit") f.journal.commitAdmission(f.q, request, proof, f.fence);
      else if (phase === "begin") f.journal.markInputIntent(f.q.identity.messageId, request, proof, f.fence);
      else if (request.phase === "release-answer") f.journal.saveAnswer({ messageId: f.q.identity.messageId, answerId: request.answer.answerId, text: "inert answer", contentDigest: request.answer.contentDigest, releaseLease: proof }, request, f.fence);
    }).toThrow();
  }
});
it("never releases an answer with a pre-revocation proof and never increments a duplicate answer receipt", async () => {
  const f = fixture(); await f.admission.admit(f.q); const begin = f.begin();
  f.journal.markInputIntent(f.q.identity.messageId, begin, f.lease(begin), f.fence);
  f.journal.recordEvidence(f.q.identity.messageId, "delivered"); f.journal.recordEvidence(f.q.identity.messageId, "consumed");
  const request: HubAuthorizationRequest = { ...begin, operationId: randomUUID(), phase: "release-answer", answer: { answerId: randomUUID(), contentDigest: sha256("inert answer") } };
  const answer = { messageId: f.q.identity.messageId, answerId: request.answer.answerId, text: "inert answer", contentDigest: request.answer.contentDigest, releaseLease: f.lease(request) };
  const first = f.journal.saveAnswer(answer, request, f.fence);
  expect(f.journal.saveAnswer(answer, request, f.fence)).toEqual(first);
  await f.admission.fence({ revocationVersion: 2, scope: { kind: "grant", grantId: f.q.identity.grantId }, reasonCode: "revoked" });
  expect(() => f.journal.saveAnswer(answer, request, f.fence)).toThrow();
});

it("retains a question and escaped answer that each fit a real protocol frame, including after reopening", async () => {
  const f = fixture(), text = "q".repeat(64 * 1024), q = { text, identity: signAsker({ ...f.q.identity, contentDigest: sha256(text) }, f.keys.privateKey) };
  await f.admission.admit(q); const begin = f.begin(); f.journal.markInputIntent(q.identity.messageId, begin, f.lease(begin), f.fence);
  f.journal.recordEvidence(q.identity.messageId, "delivered"); f.journal.recordEvidence(q.identity.messageId, "consumed");
  const answerText = '"'.repeat(126 * 1024), request: HubAuthorizationRequest = { ...begin, operationId: randomUUID(), phase: "release-answer", answer: { answerId: randomUUID(), contentDigest: sha256(answerText) } };
  const answer = { messageId: q.identity.messageId, answerId: request.answer.answerId, text: answerText, contentDigest: request.answer.contentDigest, releaseLease: f.lease(request) };
  expect(Buffer.byteLength(JSON.stringify({ v: 1, type: "question", requestId: randomUUID(), linkEpoch: 1, payload: q }))).toBeLessThan(256 * 1024);
  expect(Buffer.byteLength(JSON.stringify({ v: 1, type: "answer", requestId: randomUUID(), linkEpoch: 1, payload: answer }))).toBeLessThan(256 * 1024);
  const receipt = f.journal.saveAnswer(answer, request, f.fence);
  const reopened = new HubMemberJournal(f.db, f.options);
  expect(reopened.reconcile(0, [{ messageId: q.identity.messageId, contentDigest: q.identity.contentDigest }])).toEqual([receipt]);
});
