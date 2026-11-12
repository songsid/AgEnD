/** Reusable configured-admin approval, never identity or a chat/share grant. All writes join the caller's root transaction. */
import type Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, createHmac, createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { HubMigration } from "./db.js";
import type { PersonKey } from "./types.js";
import { canonicalArguments, personKeyString } from "./identity.js";
import { HubProtocolError, hash, person, uuid, validated, parseStrictJson } from "./validation.js";
import { readPrivateFile } from "./private-files.js";
import { createJoinPrivate, syncJoinPrivate } from "./join/private.js";
export const ENROLMENT_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function normalEnrolmentCode(input: unknown): string {
  if (typeof input !== "string" || input.length > 16 || !/^[A-Za-z0-9 -]+$/.test(input)) throw new HubProtocolError("denied");
  const code = input.replace(/[ -]/g, "").toUpperCase();
  if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(code)) throw new HubProtocolError("denied");
  return code;
}
export const enrolmentScope = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("directory") }),
  z.strictObject({ kind: z.literal("group"), realm: z.string().min(1).max(128), objectId: uuid, dn: z.string().min(1).max(4096) })]);
export type EnrolmentScope = z.infer<typeof enrolmentScope>;
export const enrolmentCreate = z.strictObject({ expires: z.enum(["1h", "today", "7d"]).default("today"),
  maxUses: z.number().int().min(1).max(200).default(30), perPersonFleets: z.number().int().min(1).max(8).default(1),
  scope: enrolmentScope.default({ kind: "directory" }) });
export type EnrolmentInput = z.input<typeof enrolmentCreate>;
export interface EnrolmentCode { id: string; mac: string; sealed: Buffer | null; createdBy: PersonKey; createdAt: number;
  expiresAt: number; maxUses: number; uses: number; perPersonFleets: number; scope: EnrolmentScope; revokedAt: number | null; revokedBy: PersonKey | null; endedAt: number | null }
interface EnrolmentUse { requestId: string; fleetId: string; owner: PersonKey }
export const HUB_ENROLMENT_CODE_MIGRATION: HubMigration = Object.freeze({ component: "enrolment-code", version: 1, up(db: Database.Database) {
  db.exec(`CREATE TABLE hub_enrolment_codes(id TEXT PRIMARY KEY,mac TEXT UNIQUE NOT NULL,sealed BLOB,created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,max_uses INTEGER NOT NULL,uses INTEGER NOT NULL DEFAULT 0,
    per_person INTEGER NOT NULL,scope TEXT NOT NULL,revoked_at INTEGER,revoked_by TEXT,ended_at INTEGER);
    CREATE TABLE hub_enrolment_code_key(singleton INTEGER PRIMARY KEY CHECK(singleton=1),sha256 TEXT NOT NULL);
    CREATE TABLE hub_enrolment_code_uses(request_id TEXT PRIMARY KEY,code_id TEXT NOT NULL,fleet_id TEXT NOT NULL,owner TEXT NOT NULL,at INTEGER NOT NULL);
    CREATE INDEX hub_enrolment_code_recent ON hub_enrolment_code_uses(code_id,at);`);
} });
const keySchema = z.strictObject({ v: z.literal(1), material: hash });
const rowSchema = z.strictObject({ id: uuid, mac: hash, sealed: z.instanceof(Buffer).nullable(), created_by: z.string(),
  created_at: z.number().int().nonnegative(), expires_at: z.number().int().nonnegative(), max_uses: z.number().int().min(1).max(200),
  uses: z.number().int().min(0).max(200), per_person: z.number().int().min(1).max(8), scope: z.string(),
  revoked_at: z.number().int().nonnegative().nullable(), revoked_by: z.string().nullable(), ended_at: z.number().int().nonnegative().nullable() });
function parsePerson(raw: string): PersonKey { const split = raw.lastIndexOf("/"); if (split < 1) throw new HubProtocolError("uncertain"); return validated(person, { realm: raw.slice(0, split), objectId: raw.slice(split + 1) }); }
function row(raw: unknown): EnrolmentCode {
  const r = validated(rowSchema, raw), scope = validated(enrolmentScope, parseStrictJson(r.scope));
  if (r.expires_at <= r.created_at || r.expires_at > r.created_at + 7 * 86400000 || r.uses > r.max_uses
    || (r.revoked_at === null) !== (r.revoked_by === null)) throw new HubProtocolError("uncertain");
  return { id: r.id, mac: r.mac, sealed: r.sealed, createdBy: parsePerson(r.created_by), createdAt: r.created_at, expiresAt: r.expires_at,
    maxUses: r.max_uses, uses: r.uses, perPersonFleets: r.per_person, scope, revokedAt: r.revoked_at, revokedBy: r.revoked_by ? parsePerson(r.revoked_by) : null, endedAt: r.ended_at };
}
export class HubEnrolmentCodes {
  readonly hubId: string;
  private keyIdentity?: string;
  constructor(private readonly deps: { db: Database.Database; home: string; hubId: string; now(): number;
    audit(action: string, codeId: string, use?: EnrolmentUse): unknown }) { this.hubId = validated(uuid, deps.hubId); }
  private transaction(): void { if (!this.deps.db.inTransaction) throw new HubProtocolError("uncertain"); }
  private audit(action: string, id: string, use?: EnrolmentUse): void {
    const result = this.deps.audit(action, id, use);
    if (result && typeof (result as PromiseLike<unknown>).then === "function") { void Promise.resolve(result).catch(() => {}); throw new HubProtocolError("uncertain"); }
  }
  private material(create = false) {
    const suffix = "hub/secrets/enrolment-code.key";
    try {
      if (!existsSync(join(this.deps.home, suffix))) {
        if (!create || this.deps.db.prepare("SELECT 1 FROM hub_enrolment_codes LIMIT 1").get() || this.deps.db.prepare("SELECT 1 FROM hub_enrolment_code_key").get()) throw new HubProtocolError("unavailable");
        createJoinPrivate(this.deps.home, suffix, JSON.stringify({ v: 1, material: randomBytes(32).toString("hex") }));
      }
      const key = validated(keySchema, parseStrictJson(readPrivateFile(this.deps.home, suffix, 1024)));
      syncJoinPrivate(this.deps.home, suffix); // Required again after every failed flush; no cached-material retry bypass.
      const digest = createHash("sha256").update(key.material).digest("hex");
      const binding = this.deps.db.prepare("SELECT sha256 FROM hub_enrolment_code_key WHERE singleton=1").get() as { sha256: string } | undefined;
      if (binding ? binding.sha256 !== digest : !create || !this.deps.db.inTransaction || !!this.deps.db.prepare("SELECT 1 FROM hub_enrolment_codes LIMIT 1").get()) throw new HubProtocolError("unavailable");
      if (this.keyIdentity && this.keyIdentity !== digest) throw new HubProtocolError("unavailable");
      if (!binding) this.deps.db.prepare("INSERT INTO hub_enrolment_code_key VALUES(1,?)").run(digest);
      this.keyIdentity = digest;
      const root = Buffer.from(key.material, "hex"), salt = Buffer.from(this.hubId);
      return { lookup: Buffer.from(hkdfSync("sha256", root, salt, "agend-enrolment-lookup-v1", 32)),
        seal: Buffer.from(hkdfSync("sha256", root, salt, "agend-enrolment-seal-v1", 32)) };
    } catch { throw new HubProtocolError("unavailable"); }
  }
  private mac(code: string, create = false) { return createHmac("sha256", this.material(create).lookup).update(code).digest("hex"); }
  private aad(c: EnrolmentCode) { return Buffer.from(canonicalArguments(["agend-enrolment-v1", this.hubId, c.id, c.mac, c.createdBy,
    c.createdAt, c.expiresAt, c.maxUses, c.perPersonFleets, c.scope])); }
  private seal(c: EnrolmentCode, code: string): Buffer {
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.material().seal, nonce); cipher.setAAD(this.aad(c));
    return Buffer.concat([nonce, cipher.update(code, "ascii"), cipher.final(), cipher.getAuthTag()]);
  }
  private open(c: EnrolmentCode): string {
    if (!c.sealed || c.sealed.length !== 36) throw new HubProtocolError("uncertain");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.material().seal, c.sealed.subarray(0, 12));
      decipher.setAAD(this.aad(c)); decipher.setAuthTag(c.sealed.subarray(-16));
      const code = normalEnrolmentCode(Buffer.concat([decipher.update(c.sealed.subarray(12, -16)), decipher.final()]).toString("ascii"));
      if (this.mac(code) !== c.mac) throw Error("mismatch");
      return code.slice(0, 4) + "-" + code.slice(4);
    } catch { throw new HubProtocolError("unavailable"); }
  }
  state(c: EnrolmentCode): "live" | "revoked" | "expired" | "exhausted" {
    return c.revokedAt !== null ? "revoked" : c.expiresAt <= this.deps.now() ? "expired" : c.uses >= c.maxUses ? "exhausted" : "live";
  }
  get(id: string): EnrolmentCode {
    const found = this.deps.db.prepare("SELECT * FROM hub_enrolment_codes WHERE id=?").get(validated(uuid, id));
    if (!found) throw new HubProtocolError("denied"); return row(found);
  }
  live(id: string): EnrolmentCode { const c = this.get(id); if (this.state(c) !== "live" || !c.sealed) throw new HubProtocolError("denied"); this.open(c); return c; }
  lookup(value: unknown): EnrolmentCode {
    const code = normalEnrolmentCode(value);
    if (!this.deps.db.prepare("SELECT 1 FROM hub_enrolment_codes LIMIT 1").get()) throw new HubProtocolError("denied");
    const found = this.deps.db.prepare("SELECT * FROM hub_enrolment_codes WHERE mac=?").get(this.mac(code));
    if (!found) throw new HubProtocolError("denied"); const c = row(found);
    if (this.state(c) !== "live" || !c.sealed) throw new HubProtocolError("denied"); this.open(c); return c;
  }
  private end(c: EnrolmentCode): void {
    if (this.state(c) === "live" || !c.sealed) return;
    this.transaction();
    if (this.deps.db.prepare("UPDATE hub_enrolment_codes SET sealed=NULL,ended_at=COALESCE(ended_at,?) WHERE id=? AND sealed=?").run(c.revokedAt ?? (this.state(c) === "expired" ? c.expiresAt : this.deps.now()), c.id, c.sealed).changes !== 1) throw new HubProtocolError("conflict");
    if (c.revokedAt === null) this.audit("enrolment-code.ended", c.id);
  }
  maintain(): void {
    this.transaction(); const rows = this.deps.db.prepare("SELECT * FROM hub_enrolment_codes").all();
    if (rows.length > 4096) throw new HubProtocolError("uncertain");
    for (const raw of rows) {
      const c = row(raw); this.end(c);
      if (this.state(c) !== "live" && (c.endedAt ?? (c.revokedAt ?? (this.state(c) === "expired" ? c.expiresAt : this.deps.now()))) <= this.deps.now() - 7 * 86400000) {
        this.deps.db.prepare("DELETE FROM hub_enrolment_code_uses WHERE code_id=?").run(c.id);
        this.deps.db.prepare("DELETE FROM hub_enrolment_codes WHERE id=?").run(c.id);
      }
    }
  }
  create(creator: PersonKey, input: EnrolmentInput) {
    this.transaction(); this.maintain(); const p = validated(enrolmentCreate, input), actor = validated(person, creator), now = this.deps.now();
    const rows = (this.deps.db.prepare("SELECT * FROM hub_enrolment_codes").all()).map(row);
    if (rows.length >= 4096 || rows.filter(c => this.state(c) === "live").length >= 8 || rows.filter(c => c.createdAt > now - 3600000).length >= 10) throw new HubProtocolError("backpressure");
    for (const c of rows) this.end(c);
    const expiresAt = p.expires === "today" ? (() => { const d = new Date(now); d.setHours(24, 0, 0, 0); return d.getTime(); })() : now + (p.expires === "1h" ? 3600000 : 7 * 86400000);
    const bytes = randomBytes(5); let n = BigInt("0x" + bytes.toString("hex")), code = "";
    for (let i = 0; i < 8; i++) { code = ENROLMENT_ALPHABET[Number(n & 31n)]! + code; n >>= 5n; }
    const c: EnrolmentCode = { id: randomUUID(), mac: this.mac(code, true), sealed: null, createdBy: actor, createdAt: now, expiresAt,
      maxUses: p.maxUses, uses: 0, perPersonFleets: p.perPersonFleets, scope: p.scope, revokedAt: null, revokedBy: null, endedAt: null };
    c.sealed = this.seal(c, code);
    this.deps.db.prepare("INSERT INTO hub_enrolment_codes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(c.id, c.mac, c.sealed, personKeyString(actor), now, expiresAt, c.maxUses, 0, c.perPersonFleets, canonicalArguments(c.scope), null, null, null);
    this.audit("enrolment-code.created", c.id);
    const retained = this.assertDefinition(c); if (retained.uses !== 0) throw new HubProtocolError("revoked");
    return { id: c.id, code: code.slice(0, 4) + "-" + code.slice(4), expiresAt, maxUses: c.maxUses, perPersonFleets: c.perPersonFleets, scope: structuredClone(c.scope) };
  }
  list() {
    this.transaction(); this.maintain();
    const rows = this.deps.db.prepare("SELECT * FROM hub_enrolment_codes ORDER BY created_at DESC,id").all();
    if (rows.length > 4096) throw new HubProtocolError("uncertain");
    return rows.map(row).flatMap(c => {
      this.end(c); const state = this.state(c);
      if (state !== "live" && (c.endedAt ?? (c.revokedAt ?? (this.state(c) === "expired" ? c.expiresAt : this.deps.now()))) <= this.deps.now() - 7 * 86400000) return [];
      return [{ id: c.id, code: state === "live" ? this.open(c) : null, state, createdAt: c.createdAt, expiresAt: c.expiresAt,
        maxUses: c.maxUses, uses: c.uses, perPersonFleets: c.perPersonFleets, scope: structuredClone(c.scope) }];
    });
  }
  revoke(id: string, actor: PersonKey) {
    this.transaction(); const c = this.get(id);
    if (c.revokedAt === null) {
      if (this.deps.db.prepare("UPDATE hub_enrolment_codes SET revoked_at=?,revoked_by=?,sealed=NULL,ended_at=COALESCE(ended_at,?) WHERE id=? AND revoked_at IS NULL").run(this.deps.now(), personKeyString(validated(person, actor)), Math.min(c.expiresAt, this.deps.now()), c.id).changes !== 1) throw new HubProtocolError("conflict");
      this.audit("enrolment-code.revoked", c.id);
    }
    return this.get(id);
  }
  /** Compare the immutable image prepared before an await; counters may advance independently. */
  assertDefinition(expected: EnrolmentCode): EnrolmentCode {
    const current = this.live(expected.id); if (!this.aad(current).equals(this.aad(expected))) throw new HubProtocolError("revoked"); return current;
  }
  assertConsumed(expected: EnrolmentCode, use: EnrolmentUse): void {
    this.transaction(); const c = this.get(expected.id);
    const found = this.deps.db.prepare("SELECT code_id,fleet_id,owner FROM hub_enrolment_code_uses WHERE request_id=?").get(use.requestId) as { code_id: string; fleet_id: string; owner: string } | undefined;
    if (!this.aad(c).equals(this.aad(expected)) || c.revokedAt !== null || c.expiresAt <= this.deps.now() || c.uses !== expected.uses + 1
      || !found || found.code_id !== c.id || found.fleet_id !== use.fleetId || found.owner !== personKeyString(use.owner)) throw new HubProtocolError("revoked");
  }
  /** Exact durable receipt is idempotent even after expiry/revoke; a new use needs the current CAS image. */
  consume(expected: EnrolmentCode, use: EnrolmentUse): void {
    this.transaction(); validated(uuid, use.requestId); validated(uuid, use.fleetId); validated(person, use.owner);
    const old = this.deps.db.prepare("SELECT code_id,fleet_id,owner FROM hub_enrolment_code_uses WHERE request_id=?").get(use.requestId) as { code_id: string; fleet_id: string; owner: string } | undefined;
    if (old) { if (old.code_id !== expected.id || old.fleet_id !== use.fleetId || old.owner !== personKeyString(use.owner)) throw new HubProtocolError("denied"); return; }
    const c = this.live(expected.id);
    if (!this.aad(c).equals(this.aad(expected))) throw new HubProtocolError("revoked");
    const result = this.deps.db.prepare("UPDATE hub_enrolment_codes SET uses=uses+1 WHERE id=? AND uses=? AND uses<max_uses AND revoked_at IS NULL AND expires_at>?")
      .run(c.id, expected.uses, this.deps.now());
    if (result.changes !== 1) throw new HubProtocolError("revoked");
    this.deps.db.prepare("INSERT INTO hub_enrolment_code_uses VALUES(?,?,?,?,?)").run(use.requestId, c.id, use.fleetId, personKeyString(use.owner), this.deps.now());
    this.audit("enrolment-code.used", c.id, use); this.end(this.get(c.id));
  }
}
