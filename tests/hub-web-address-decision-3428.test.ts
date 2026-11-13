/** Real SQLite root decisions; inert audit boundary and synthetic private certificate bytes. */
import Database from "better-sqlite3";
import { CompanyJoinRecords, type JoinRecord, HUB_COMPANY_JOIN_MIGRATION } from "../src/hub/join/store.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensurePrivateDirectory } from "../src/hub/private-files.js";
import { createHubWebAddressDecision, HUB_WEB_ADDRESS_MIGRATION, type HubWebAddressOperation } from "../src/hub/settings-web-address-decision.js";
const homes: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
    for (const db of dbs.splice(0))
        db.close();
    for (const h of homes.splice(0))
        rmSync(h, { recursive: true, force: true });
});
function rig() {
    const home = mkdtempSync(join(tmpdir(), "hub-address-sql-"));
    homes.push(home);
    ensurePrivateDirectory(home, "hub/tls");
    writeFileSync(join(home, "hub/tls/cert.pem"), "synthetic cert", { mode: 0o600 });
    writeFileSync(join(home, "hub/tls/key.pem"), "synthetic key", { mode: 0o600 });
    const db = new Database(":memory:");
    dbs.push(db);
    db.exec(`CREATE TABLE hub_browser_tls(singleton INTEGER PRIMARY KEY,hub_id TEXT,revision INTEGER,material_id TEXT,material_digest TEXT);
 INSERT INTO hub_browser_tls VALUES(1,'owned-hub',1,NULL,NULL);
 CREATE TABLE hub_sessions(id TEXT PRIMARY KEY,state TEXT);INSERT INTO hub_sessions VALUES('old','active');
 CREATE TABLE hub_directory_epoch(epoch INTEGER);INSERT INTO hub_directory_epoch VALUES(7);
 CREATE TABLE member_pin(value TEXT);INSERT INTO member_pin VALUES('unchanged');CREATE TABLE audit(id TEXT);`);
    HUB_WEB_ADDRESS_MIGRATION.up(db);
    HUB_COMPANY_JOIN_MIGRATION.up(db);
    const audit = { appendInTransaction: vi.fn((record: {
            id: string;
        }, own: Database.Database) => { own.prepare('INSERT INTO audit VALUES(?)').run(record.id); }) };
    const clock = { now: 1000 };
    const decision = createHubWebAddressDecision({ db, home, now: () => clock.now, hubId: "owned-hub", initial: { certificateFile: "hub/tls/cert.pem", keyFile: "hub/tls/key.pem" }, audit });
    const request = (): HubWebAddressOperation => ({ v: 1, kind: "web-address", id: randomUUID(), expected: decision.inspect(), revision: decision.head().revision + 1,
        before: { configSha: "a".repeat(64), manifestSha: "b".repeat(64) }, after: { configSha: "c".repeat(64), manifestSha: "d".repeat(64), certificateSha: "e".repeat(64), keySha: "f".repeat(64), webSha: "2".repeat(64) }, receiptSha: "1".repeat(64), actor: { kind: "host-owner", sessionId: "owner", requestId: "request" }, at: 1000 });
    const records = new CompanyJoinRecords(db, () => clock.now);
    const pem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    const addJoin = (stage: JoinRecord["stage"], issued = stage === "issued" || stage === "acknowledged") => {
        const record: JoinRecord = { v: 1, binding: { hub: { hubId: randomUUID(), webOrigin: "https://hub.example.test", memberOrigin: "https://member.example.test", spkiSha256: "a".repeat(64), issuerPublicKey: pem },
                publicKey: pem, fleetOrigin: "http://127.0.0.1:8080", requestId: randomUUID(), operationId: randomUUID(), fleetId: randomUUID(), verifierS256: randomBytes(32).toString("base64url") },
            version: 1, label: "Owned fixture", stateHash: "b".repeat(64), stage, createdAt: clock.now, outerDeadline: clock.now + 600000, retainUntil: clock.now + 1200000,
            browserHash: "c".repeat(64), browserOrigin: "http://127.0.0.1:8080", owner: null, sessionId: null, approvedAt: null, redeemDeadline: null, deliveryDeadline: 121000,
            issuedHash: issued ? "d".repeat(64) : null, reason: null, delivery: null, receipt: null, invitationId: null, approvedBy: null, supersedesFleetId: null, enrolmentCodeId: null };
        db.transaction(() => records.insert(record)).immediate();
        return record;
    };
    const addOffer = (requestId: string | null, consumed = false) => {
        const key = { realm: "corp", objectId: randomUUID() }, id = randomUUID(), hub = { hubId: randomUUID(), webOrigin: "https://hub.example.test", memberOrigin: "https://member.example.test", spkiSha256: "a".repeat(64), issuerPublicKey: pem };
        db.prepare("INSERT INTO hub_company_join_invites VALUES(?,?)").run(id, JSON.stringify({ claims: { v: 2, id, hub, owner: key, approvedBy: key, nonce: "b".repeat(64), createdAt: 1000, expiresAt: 601000 }, digest: "c".repeat(64), requestId, consumed }));
        return id;
    };
    return { db, home, decision, audit, request, clock, records, addJoin, addOffer };
}
describe("#3428 authoritative web-address SQL", () => {
    it.each(["legacy", "s1"] as const)("retires %s pending records without replaying a reconnect", format => {
        const r = rig(), pending = r.addJoin("pending"), supersedesFleetId = format === "s1" ? randomUUID() : null;
        const raw: Partial<JoinRecord> = { ...pending, reason: format === "s1" ? "offer-pending" : null, supersedesFleetId };
        if (format === "legacy") delete raw.supersedesFleetId;
        r.db.prepare("UPDATE hub_company_join_requests SET body=? WHERE id=?").run(JSON.stringify(raw), pending.binding.requestId);
        r.decision.commit(r.request(), () => true);
        expect(r.records.get(pending.binding.requestId)).toMatchObject({ version: 2, stage: "ended", reason: "authority",
            browserHash: null, browserOrigin: null, supersedesFleetId, outerDeadline: pending.outerDeadline, retainUntil: pending.retainUntil });
        expect(r.db.prepare("SELECT value FROM member_pin").get()).toEqual({ value: "unchanged" });
        expect(r.decision.head().revision).toBe(1);
        expect(r.audit.appendInTransaction).toHaveBeenCalledOnce();
    });
    it.each([false, true])("expired invitation survives ordinary request pruning (consumed=%s) without blocking address changes", consumed => {
        const r = rig(), old = r.addJoin(consumed ? "acknowledged" : "pending");
        const offer = r.addOffer(old.binding.requestId, consumed);
        r.clock.now = old.retainUntil;
        const fresh = r.addJoin("pending"); // Production insert prunes the old request, not the invitation.
        expect(() => r.records.get(old.binding.requestId)).toThrow("not-found");
        r.decision.commit(r.request(), () => true);
        expect(r.decision.head().revision).toBe(1);
        expect(r.records.get(fresh.binding.requestId)).toMatchObject({ stage: "ended", browserHash: null });
        expect(r.db.prepare("SELECT id FROM hub_company_join_invites WHERE id=?").all(offer)).toEqual(consumed ? [{ id: offer }] : []);
        r.decision.commit(r.request(), () => true); // Expired consumed history must not poison later moves either.
        expect(r.decision.head().revision).toBe(2);
    });
    it("a missing live invitation request refuses without ending sessions or deciding", () => {
        const r = rig(), old = r.addJoin("pending");
        r.addOffer(old.binding.requestId);
        r.db.prepare("DELETE FROM hub_company_join_requests WHERE id=?").run(old.binding.requestId);
        expect(() => r.decision.commit(r.request(), () => true)).toThrow();
        expect(r.decision.head().revision).toBe(0);
        expect(r.db.prepare("SELECT state FROM hub_sessions").get()).toEqual({ state: "active" });
    });
    it.each(["issued", "acknowledged"] as const)("%s receipt blocks an address decision until its original outer deadline", stage => {
        const r = rig(), join = r.addJoin(stage), op = r.request();
        expect(() => r.decision.commit(op, () => true)).toThrow("busy");
        expect(r.decision.head().revision).toBe(0);
        expect(r.records.get(join.binding.requestId)).toEqual(join);
        expect(r.db.prepare("SELECT state FROM hub_sessions").get()).toEqual({ state: "active" });
        expect(r.db.prepare("SELECT count(*) n FROM audit").get()).toEqual({ n: 0 });
        r.clock.now = join.outerDeadline;
        r.decision.commit(op, () => true);
        expect(r.records.get(join.binding.requestId)).toEqual(join);
        expect(r.decision.head().revision).toBe(1);
    });
    it("retires old browser bindings and deletes only unconsumed invitations permanently", () => {
        const r = rig(), pending = r.addJoin("pending"), approved = r.addJoin("identity-approved"), issued = r.addJoin("acknowledged"), offer = r.addOffer(pending.binding.requestId), unused = r.addOffer(null), consumed = r.addOffer(issued.binding.requestId, true);
        r.clock.now = issued.outerDeadline;
        r.decision.commit(r.request(), () => true);
        for (const old of [pending, approved])
            expect(r.records.get(old.binding.requestId)).toMatchObject({ version: 2, stage: "ended", reason: "authority", browserHash: null, browserOrigin: null, outerDeadline: old.outerDeadline, retainUntil: old.retainUntil });
        expect(r.records.get(issued.binding.requestId)).toEqual(issued);
        expect(r.db.prepare("SELECT id FROM hub_company_join_invites ORDER BY id").all()).toEqual([{ id: consumed }]);
        expect(r.db.prepare("SELECT body FROM hub_company_join_invites WHERE id IN(?,?)").all(offer, unused)).toEqual([]);
    });
    it("an inconsistent invitation refuses the whole decision without partial invalidation", () => {
        const r = rig(), old = r.addJoin("pending");
        r.addOffer(old.binding.requestId, true);
        expect(() => r.decision.commit(r.request(), () => true)).toThrow();
        expect(r.records.get(old.binding.requestId)).toEqual(old);
        expect(r.decision.head().revision).toBe(0);
        expect(r.db.prepare("SELECT state FROM hub_sessions").get()).toEqual({ state: "active" });
    });
    it("atomically selects the resealed TLS files, ends sessions and fences the old address, preserving directory/member state", () => {
        const r = rig(), request = r.request(), old = r.decision.head();
        r.decision.commit(request, () => true);
        expect(r.decision.head()).toEqual({ revision: old.revision + 1, operationId: request.id });
        expect(r.db.prepare("SELECT revision,material_id,material_digest FROM hub_browser_tls").get()).toEqual({ revision: 2, material_id: null, material_digest: null });
        expect(r.db.prepare("SELECT state FROM hub_sessions").get()).toEqual({ state: "ended" });
        expect(r.db.prepare("SELECT epoch FROM hub_directory_epoch").get()).toEqual({ epoch: 7 });
        expect(r.db.prepare("SELECT value FROM member_pin").get()).toEqual({ value: "unchanged" });
        expect(r.decision.lookup(request.id)).toEqual(request);
        expect(r.audit.appendInTransaction).toHaveBeenCalledOnce();
    });
    it("an audit refusal rolls every effect back", () => {
        const r = rig(), request = r.request();
        r.audit.appendInTransaction.mockImplementation(() => { throw Error("storage refused"); });
        expect(() => r.decision.commit(request, () => true)).toThrow("storage refused");
        expect(r.decision.head().revision).toBe(0);
        expect(r.decision.lookup(request.id)).toBeNull();
        expect(r.db.prepare("SELECT state FROM hub_sessions").get()).toEqual({ state: "active" });
        expect(r.db.prepare("SELECT revision FROM hub_browser_tls").get()).toEqual({ revision: 1 });
    });
    it("refuses revoked owner, TLS change during audit, and stale selection without ending sessions", () => {
        for (const mode of ["revoked", "audit-change", "stale"]) {
            const r = rig(), request = r.request();
            if (mode === "stale")
                r.db.prepare("UPDATE hub_browser_tls SET revision=2").run();
            if (mode === "audit-change")
                r.audit.appendInTransaction.mockImplementation(() => { r.db.prepare("UPDATE hub_browser_tls SET revision=2").run(); });
            expect(() => r.decision.commit(request, () => mode !== "revoked")).toThrow();
            expect(r.decision.head().revision).toBe(0);
            expect(r.decision.lookup(request.id)).toBeNull();
            expect(r.db.prepare("SELECT state FROM hub_sessions").get()).toEqual({ state: "active" });
        }
    });
    it("recovery lookup never repeats session invalidation; sessions created on the new mount remain active", () => {
        const r = rig(), request = r.request();
        r.decision.commit(request, () => true);
        r.db.prepare("INSERT INTO hub_sessions VALUES('new','active')").run();
        expect(r.decision.lookup(request.id)).toEqual(request);
        expect(r.decision.lookup(request.id)).toEqual(request);
        expect(r.db.prepare("SELECT state FROM hub_sessions WHERE id='new'").get()).toEqual({ state: "active" });
        expect(() => r.decision.commit(request, () => true)).toThrow();
        expect(r.audit.appendInTransaction).toHaveBeenCalledOnce();
    });
    it("does not reconstruct a lost head or trust a partial operation log", () => {
        const r = rig();
        r.db.exec("DELETE FROM hub_web_address_head");
        expect(() => r.decision.head()).toThrow();
        expect(() => HUB_WEB_ADDRESS_MIGRATION.up(r.db)).toThrow();
    });
    it("binds the effective selected material, not just initial certificate file paths", () => {
        const r = rig(), first = r.decision.inspect(), version = randomUUID();
        ensurePrivateDirectory(r.home, `hub/web-tls/versions/${version}`);
        writeFileSync(join(r.home, `hub/web-tls/versions/${version}/material.json`), JSON.stringify({ cert: "another certificate", key: "another key" }), { mode: 0o600 });
        r.db.prepare("UPDATE hub_browser_tls SET material_id=?,material_digest=?").run(version, "0".repeat(64));
        expect(() => r.decision.inspect()).toThrow();
        expect(first.selector.materialId).toBeNull();
    });
});
