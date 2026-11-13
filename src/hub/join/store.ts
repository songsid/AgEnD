/** Versioned company-join records. This is separate from legacy pairing confirmations and their strict schema. */
import type Database from "better-sqlite3";
import { z } from "zod";
import type { HubMigration } from "../db.js";
import { canonicalArguments, personKeyString, sha256 } from "../identity.js";
import { epoch, hash, person, plain, uuid, identifier, validated, parseStrictJson, HubProtocolError } from "../validation.js";
import { joinBindingSchema, validateJoinBinding, type JoinBinding } from "./protocol.js";
import type { DeliveryBinding, DeliveryReceipt } from "./receipt.js";
import { companyInvitationClaims } from "./invitation.js";

export const companyInvitationRecord = z.strictObject({ claims: companyInvitationClaims, digest: hash,
  requestId: uuid.nullable(), consumed: z.boolean() });

export const HUB_COMPANY_JOIN_MIGRATION: HubMigration = Object.freeze({ component: "company-join", version: 3, up(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS hub_company_join_control(singleton INTEGER PRIMARY KEY CHECK(singleton=1), enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO hub_company_join_control VALUES(1,0,1);
    CREATE TABLE IF NOT EXISTS hub_company_join_requests(id TEXT PRIMARY KEY,person TEXT,stage TEXT NOT NULL,outer_deadline INTEGER NOT NULL,retain_until INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS hub_company_join_owner ON hub_company_join_requests(person,stage,outer_deadline);
    CREATE TABLE IF NOT EXISTS hub_company_join_nonces(nonce TEXT PRIMARY KEY,binding TEXT NOT NULL,purpose TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS hub_company_join_cipher_nonces(key_id TEXT NOT NULL,nonce TEXT NOT NULL,PRIMARY KEY(key_id,nonce));
    CREATE TABLE IF NOT EXISTS hub_company_join_invites(id TEXT PRIMARY KEY,body TEXT NOT NULL);
  `);
} });
export const requestStage = z.enum(["pending", "identity-approved", "issued", "acknowledged", "ended", "undeliverable", "revoked"]);
const schema = z.strictObject({ v: z.literal(1), binding: joinBindingSchema, version: epoch, label: plain(120), stateHash: hash,
  stage: requestStage, createdAt: epoch, outerDeadline: epoch, retainUntil: epoch,
  browserHash: hash.nullable(), browserOrigin: z.string().nullable(), owner: person.nullable(), sessionId: identifier.nullable(),
  approvedAt: epoch.nullable(), redeemDeadline: epoch.nullable(), deliveryDeadline: epoch.nullable(),
  issuedHash: hash.nullable(), reason: z.enum(["cancelled", "expired", "disabled", "authority", "revoked", "offer-pending", "limit-reached", "denied", "backpressure"]).nullable(),
  delivery: z.unknown().nullable(), receipt: z.unknown().nullable(), invitationId: uuid.nullable(), approvedBy: person.nullable(),
  supersedesFleetId: uuid.nullable().default(null), enrolmentCodeId: uuid.nullable().default(null),
});
export type JoinRecord = Omit<z.infer<typeof schema>, "binding" | "delivery" | "receipt"> & {
  binding: JoinBinding; delivery: DeliveryBinding | null; receipt: DeliveryReceipt | null;
};
export class CompanyJoinRecords {
  constructor(readonly db: Database.Database, private readonly now: () => number) {}
  get(id: string): JoinRecord {
    validated(uuid, id);
    const row = this.db.prepare("SELECT body FROM hub_company_join_requests WHERE id=?").get(id) as { body: string } | undefined;
    if (!row) throw new HubProtocolError("not-found");
    const parsed = validated(schema, parseStrictJson(row.body, 16 * 1024));
    validateJoinBinding(parsed.binding);
    if (parsed.invitationId && parsed.enrolmentCodeId || parsed.binding.requestId !== id || parsed.version < 1 || parsed.outerDeadline !== parsed.createdAt + 600_000
      || parsed.retainUntil < parsed.outerDeadline) throw new HubProtocolError("uncertain");
    return parsed as JoinRecord;
  }
  current(record: JoinRecord): boolean {
    try { return canonicalArguments(this.get(record.binding.requestId)) === canonicalArguments(record); } catch { return false; }
  }
  save(record: JoinRecord, expectedVersion: number): void {
    if (!this.db.inTransaction || record.version !== expectedVersion + 1) throw new HubProtocolError("uncertain");
    const previous = this.get(record.binding.requestId);
    if (previous.version !== expectedVersion) throw new HubProtocolError("conflict");
    // Old records omit additive fields. CAS the validated raw image, not its default-null projection.
    const raw = this.db.prepare("SELECT body FROM hub_company_join_requests WHERE id=?").get(record.binding.requestId) as { body: string };
    const result = this.db.prepare("UPDATE hub_company_join_requests SET person=?,stage=?,outer_deadline=?,retain_until=?,body=? WHERE id=? AND body=?")
      .run(record.owner ? personKeyString(record.owner) : null, record.stage, record.outerDeadline, record.retainUntil,
        canonicalArguments(record), record.binding.requestId, raw.body);
    if (result.changes !== 1) throw new HubProtocolError("conflict");
  }
  insert(record: JoinRecord): void {
    if (!this.db.inTransaction) throw new HubProtocolError("uncertain");
    this.db.prepare("DELETE FROM hub_company_join_requests WHERE retain_until<=?").run(this.now());
    const count = (this.db.prepare("SELECT COUNT(*) n FROM hub_company_join_requests").get() as { n: number }).n;
    if (count >= 1024) throw new HubProtocolError("backpressure");
    const pending = (this.db.prepare("SELECT COUNT(*) n FROM hub_company_join_requests WHERE stage='pending' AND outer_deadline>?").get(this.now()) as { n: number }).n;
    if (pending >= 256) throw new HubProtocolError("backpressure");
    this.db.prepare("INSERT INTO hub_company_join_requests VALUES(?,?,?,?,?,?)").run(record.binding.requestId, null, record.stage,
      record.outerDeadline, record.retainUntil, canonicalArguments(record));
  }
  /** Quota reservations only: consumed/ended/anonymous attempts are not extra per-person slots. */
  reservations(owner: { realm: string; objectId: string }, except?: string): number {
    const rows = this.db.prepare("SELECT id FROM hub_company_join_requests WHERE person=? AND stage='identity-approved' AND outer_deadline>?")
      .all(personKeyString(owner), this.now()) as { id: string }[];
    return rows.filter(row => { const r = this.get(row.id); return row.id !== except && !r.invitationId && r.redeemDeadline !== null && r.redeemDeadline > this.now(); }).length;
  }
  /** Retained automatic/manual admissions share the global headroom until their original ten-minute deadline. */
  retained(code = false): number {
    const rows = this.db.prepare("SELECT id FROM hub_company_join_requests WHERE (json_extract(body,'$.enrolmentCodeId') IS NOT NULL)=? AND person IS NOT NULL AND outer_deadline>? AND (stage='identity-approved' OR json_extract(body,'$.issuedHash') IS NOT NULL)")
      .all(Number(code), this.now()) as { id: string }[];
    return rows.length;
  }
  bindingDigest(binding: JoinBinding): string { return sha256(canonicalArguments(validateJoinBinding(binding))); }
}

/** Called by the sealed web-address decision in its owning IMMEDIATE transaction.
 * Never retarget issued receipts. An ACK response can be lost after the Hub's
 * commit, so even acknowledged delivery retains the original outer window.
 */
export function retireCompanyJoinForWebAddress(db: Database.Database, now: number): void {
  if (!db.inTransaction || !Number.isSafeInteger(now) || now < 0) throw new HubProtocolError("uncertain");
  const records = new CompanyJoinRecords(db, () => now);
  const rows = db.prepare("SELECT id FROM hub_company_join_requests").all() as { id: string }[];
  const offers = db.prepare("SELECT id,body FROM hub_company_join_invites").all() as { id: string; body: string }[];
  if (rows.length > 1024 || offers.length > 1024) throw new HubProtocolError("uncertain");
  const current = rows.map(row => records.get(row.id));
  const byId = new Map(current.map(record => [record.binding.requestId, record]));
  if (current.some(r => r.issuedHash !== null && ["issued", "acknowledged"].includes(r.stage) && now < r.outerDeadline))
    throw new HubProtocolError("backpressure");
  for (const row of offers) {
    const offer = validated(companyInvitationRecord, parseStrictJson(row.body));
    if (offer.claims.id !== row.id || offer.claims.expiresAt !== offer.claims.createdAt + 600_000)
      throw new HubProtocolError("uncertain");
    if (offer.requestId !== null) {
      const request = byId.get(offer.requestId);
      // insert() normally prunes requests at retainUntil, while invitation expiry
      // is only purged by createInvitation(). Missing live references still refuse;
      // expired history cannot retarget or revive an issued delivery.
      if (request ? (request.issuedHash !== null) !== offer.consumed : now < offer.claims.expiresAt)
        throw new HubProtocolError("uncertain");
    }
    // Absence is an existing, permanent invitation refusal, including A→B→A.
    if (!offer.consumed && db.prepare("DELETE FROM hub_company_join_invites WHERE id=? AND body=?").run(row.id, row.body).changes !== 1)
      throw new HubProtocolError("conflict");
  }
  db.prepare("DELETE FROM hub_company_join_nonces").run();
  for (const r of current) {
    if (r.issuedHash !== null) continue;
    if (r.version === Number.MAX_SAFE_INTEGER) throw new HubProtocolError("uncertain");
    const ended = r.stage === "pending" || r.stage === "identity-approved";
    records.save({ ...r, version: r.version + 1, browserHash: null, browserOrigin: null,
      ...(ended ? { stage: "ended", reason: "authority", receipt: null } as const : {}) }, r.version);
  }
}
