/** Real TLS/WSS + production S3 receipt/reconcile + private SQLite/floors; inert execution only. */
import Database from "better-sqlite3";
import { createPrivateKey, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { hubRig } from "./helpers/hub-rig.js";
import { HubMemberClient, type HubMemberLink } from "../src/hub/client.js";
import { HubMemberJournal, migrateHubMemberJournal } from "../src/hub/member-journal.js";
import { createHubMemberHandshake } from "../src/hub/member-reconciliation.js";
import { HubMemberAdmissionAdapter } from "../src/hub/admission.js";
import { HubFileVersionFloor } from "../src/hub/version-floor.js";
import { operationDigest, personKeyString, sha256, signAsker } from "../src/hub/identity.js";
import { HUB_HTTP_MIGRATIONS } from "../src/hub/http/schema.js";
import { HubCore } from "../src/hub/http/core.js";
import { HubRoomsService } from "../src/hub/rooms.js";
import { HubPolicyService } from "../src/hub/policy.js";
import type { HubHttpDeps } from "../src/hub/http/deps.js";
import type { HubAuthorizationRequest, HubQuestion, HubReceipt, HubTx } from "../src/hub/types.js";

it("reconnects nonempty history after a committed receipt loses its ACK, converges and admits a duplicate without input replay", async () => {
  const r = await hubRig(); let memberDb: Database.Database | undefined, client: HubMemberClient | undefined;
  try {
    const profile = await r.pair(); for (const m of HUB_HTTP_MIGRATIONS) m.up(r.db);
    const live = new WeakMap<HubTx, Database.Database>(), audits: string[] = [];
    const deps: HubHttpDeps = { store: r.store, pairing: r.pairing, directory: r.directory,
      config: { hubId: r.identity.hubId, name: "test", memberOrigin: r.memberOrigin, webOrigin: profile.hub.webOrigin, administrator: r.owner },
      issuer: { keyId: r.identity.issuerKeyId, sign: e => signAsker(e, createPrivateKey(readFileSync(join(r.root, "hub/keys/issuer-key.pem")))) },
      content: { put: () => { throw Error("no plaintext replay"); }, get: () => undefined }, transport: () => r.server,
      current: () => ({ serverEnabled: () => true, memberEnabled: () => false, epoch: () => 0 }),
      uow: { atomic: work => r.db.transaction(() => { const tx = { id: randomUUID() }; live.set(tx, r.db); try { return work(tx); } finally { live.delete(tx); } }).immediate() },
      audit: { append: (tx, record) => { if (!live.has(tx)) throw Error("outside transaction"); r.db.prepare("INSERT INTO audit VALUES(?)").run(JSON.stringify(record)); audits.push(record.action); }, read: async () => [], readContent: async () => { throw Error("not used"); } } };
    const core = new HubCore(deps, tx => { const db = live.get(tx); if (!db) throw Error("outside transaction"); return db; });
    const rooms = new HubRoomsService(core, new HubPolicyService(core));
    memberDb = new Database(join(r.memberHome, "journal.sqlite")); chmodSync(join(r.memberHome, "journal.sqlite"), 0o600); migrateHubMemberJournal(memberDb);
    memberDb.exec("CREATE TABLE restricted_sources(source TEXT PRIMARY KEY,id TEXT)");
    const key = randomBytes(32); writeFileSync(join(r.memberHome, "journal.key"), key, { mode: 0o600 });
    const floor = new HubFileVersionFloor(r.memberHome, "floors/journal"); floor.initialize();
    const options = { hubId: r.identity.hubId, encryptionKey: key, floor, outbox: {
      insert: (db: Database.Database, _q: HubQuestion, source: string) => { const id = randomUUID(); db.prepare("INSERT INTO restricted_sources VALUES(?,?)").run(source, id); return id; },
      lookup: (db: Database.Database, _q: HubQuestion, source: string) => (db.prepare("SELECT id FROM restricted_sources WHERE source=?").get(source) as { id: string } | undefined)?.id ?? null } };
    let journal = new HubMemberJournal(memberDb, options); journal.initialize();
    const exposureId = randomUUID(), grantId = randomUUID(), roomId = randomUUID(), owner = personKeyString(r.owner), now = Date.now();
    r.db.prepare("INSERT INTO hub_exposures VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(exposureId, profile.fleetId, owner, "test", 1, "published", "test-view", "[]", "a".repeat(64), -1, now);
    r.db.prepare("INSERT INTO hub_grants VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(grantId, 1, owner, exposureId, 1, owner, now, owner, '["ask"]', now, now + 60000, "active");
    r.db.prepare("INSERT INTO hub_rooms VALUES(?,?,?,?,?,?,?)").run(roomId, owner, exposureId, owner, grantId, "active", now);
    const fence = { current: () => true, linkEpoch: 1, revocationVersion: 0 };
    const lease = (req: HubAuthorizationRequest) => ({ decisionId: randomUUID(), ...req, operationDigest: operationDigest(req), revocationVersion: 0, linkEpoch: 1, expiresAt: Date.now() + 5000 });
    const queued = () => {
      const text = "inert reconnect question", q: HubQuestion = { text, identity: deps.issuer.sign({ v: 1, issuer: r.identity.hubId, issuerKeyId: r.identity.issuerKeyId, messageId: randomUUID(), asker: r.owner, owner: r.owner,
        destinationFleetId: profile.fleetId, exposureId, roomId, grantId, grantRevision: 1, exposureRevision: 1, revocationVersion: 0, contentDigest: sha256(text), issuedAt: now, expiresAt: now + 60000, nonce: randomBytes(32).toString("hex") }) };
      r.db.prepare(`INSERT INTO hub_messages(id,room_id,idempotency_key,sequence,fleet_id,exposure_id,exposure_revision,grant_id,grant_revision,asker,owner,content_digest,question_ref,stage,stage_at,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)`).run(q.identity.messageId, roomId, randomUUID(), (r.db.prepare("SELECT COUNT(*) AS n FROM hub_messages").get() as { n: number }).n + 1, profile.fleetId, exposureId, 1, grantId, 1, owner, owner, q.identity.contentDigest, "fixture-ref", now, now, now + 60000);
      const p = journal.prepare(q), req = { messageId: q.identity.messageId, operationId: p.operationId, exposureRevision: 1, phase: "admit" as const };
      return { q, receipt: journal.commitAdmission(q, req, lease(req), fence) };
    };
    const a = queued(), begin = { messageId: a.q.identity.messageId, operationId: randomUUID(), exposureRevision: 1, phase: "begin" as const };
    journal.markInputIntent(a.q.identity.messageId, begin, lease(begin), fence); journal.recordEvidence(a.q.identity.messageId, "delivered");
    const consumed = journal.recordEvidence(a.q.identity.messageId, "consumed"), b = queued();
    const initial = { fleetId: profile.fleetId, owner: r.owner, linkEpoch: 1, current: () => true, features: new Set<string>() };
    rooms.receipt(a.receipt, initial); rooms.receipt(b.receipt, initial);
    let lost = false, syncs = 0, ready = 0, duplicate = 0, currentLink!: HubMemberLink;
    const receiptAttempts: HubReceipt[] = [];
    r.setReceive(async (frame, link) => {
      const common = { v: 1 as const, requestId: frame.requestId, linkEpoch: link.linkEpoch };
      if (frame.type === "exposure.snapshot") return;
      if (frame.type === "reconcile") return { ...common, type: "reconcile", payload: rooms.reconcile(frame.payload, link) };
      if (frame.type !== "receipt") throw Error("unexpected operation");
      receiptAttempts.push(frame.payload); const receipt = rooms.receipt(frame.payload, link);
      if (!lost) {
        lost = true;
        // Deliberately end this test-owned real socket AFTER the S3 SQLite/audit transaction committed.
        (r.server as any).connections.get(link.fleetId).link.end(); return;
      }
      return { ...common, type: "receipt", payload: receipt };
    });
    const handshake = createHubMemberHandshake({ journal, publishSnapshot: async link => { await link.send({ v: 1, type: "exposure.snapshot", requestId: randomUUID(), linkEpoch: link.linkEpoch, payload: { revision: 1, exposures: [] } }); } });
    let admission!: HubMemberAdmissionAdapter;
    client = new HubMemberClient({ home: r.memberHome, hubId: r.identity.hubId, memberOrigin: r.memberOrigin, current: () => true, hold: () => {}, random: () => 0,
      reconcile: async link => { syncs++; currentLink = link; await handshake(link); ready++; },
      receive: async (frame, link) => {
        if (frame.type === "receipt") { journal.acknowledge(frame.payload); return; }
        if (frame.type !== "question") throw Error("unexpected frame");
        const receipt = await admission.admit(frame.payload); duplicate++; if (link.current()) await link.send({ v: 1, type: "receipt", requestId: frame.requestId, linkEpoch: link.linkEpoch, payload: receipt });
      } });
    admission = new HubMemberAdmissionAdapter({ journal, transport: client, binding: () => ({ profile, linkEpoch: currentLink.linkEpoch, revocationVersion: currentLink.revocationVersion, current: currentLink.current }),
      exposure: () => ({ id: exposureId, fleetId: profile.fleetId, owner: r.owner, displayName: "test", revision: 1, state: "published", dataViewId: "test-view", allowedTools: [], policyDigest: "a".repeat(64) }), fenceLocal: () => {}, hold: () => {} });
    await expect(client.start()).rejects.toThrow();
    await vi.waitFor(() => expect(ready).toBe(1), { timeout: 5000 });
    expect(syncs).toBe(2); expect(lost).toBe(true); expect(journal.unackedReceipts({}).receipts).toEqual([]);
    expect(receiptAttempts).toEqual([consumed]); // reconnect recovered the ACK; no second receipt transmission required
    expect(audits.filter(x => x === "receipt.consumed")).toHaveLength(1);
    expect(r.received.filter(x => x.type === "reconcile").every(x => x.payload.messages.length === 2)).toBe(true);
    expect(r.db.prepare("SELECT stage FROM hub_messages WHERE id=?").get(a.q.identity.messageId)).toEqual({ stage: "consumed" });
    await r.server.send(profile.fleetId, { v: 1, type: "question", requestId: randomUUID(), linkEpoch: currentLink.linkEpoch, payload: a.q });
    await vi.waitFor(() => expect(duplicate).toBe(1));
    expect(memberDb.prepare("SELECT COUNT(*) AS n FROM restricted_sources").get()).toEqual({ n: 2 });
    expect(journal.reconcile(0, [{ messageId: a.q.identity.messageId, contentDigest: a.q.identity.contentDigest }])).toEqual([consumed]);
    await client.close();
    // Reopen the actual DB/floor/key: the ACK and revocation floor survive a member-process restart.
    memberDb.close(); memberDb = new Database(join(r.memberHome, "journal.sqlite"));
    journal = new HubMemberJournal(memberDb, { ...options, encryptionKey: readFileSync(join(r.memberHome, "journal.key")) });
    expect(journal.unackedReceipts({}).receipts).toEqual([]); expect(journal.revocationVersion()).toBe(0);
    expect(r.received.every(x => !["answer", "authorize.request"].includes(x.type))).toBe(true);
  } finally { await client?.close(); memberDb?.close(); await r.close(); }
});
