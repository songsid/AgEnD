/** Member-address SQL participant. Transport revocation, audit, durable notices and the operation share one root COMMIT. */
import type Database from "better-sqlite3";
import { z } from "zod";
import type { HubMigration } from "./db.js";
import type { HubTransportStore } from "./store.js";
import { canonicalArguments, personKeyString, sha256 } from "./identity.js";
import { hubOrigin, readHubMemberTls } from "./tls.js";
import { hash, uuid, epoch, person, plain, parseStrictJson, HubProtocolError } from "./validation.js";
import { retireCompanyJoinForWebAddress } from "./join/store.js";
import { HubMemberAddressError, hubMemberAddressBoundary } from "./settings-member-address-policy.js";
import type { PersonKey } from "./types.js";

const actor = z.strictObject({ kind: z.literal("host-owner"), sessionId: z.string().min(1).max(256), requestId: z.string().min(1).max(256) });
export type HubMemberAddressActor = z.infer<typeof actor>;
const affected = z.strictObject({ id: uuid, owner: person, generation: epoch, label: plain(120).optional() });
const headSchema = z.strictObject({ revision: epoch, operationId: uuid.nullable() });
const expectedSchema = headSchema.extend({ transportRevision: epoch, identitySha: hash, certificateSha: hash, keySha: hash, hubId: uuid, spkiSha256: hash, issuerKeyId: hash });
const image = z.strictObject({ configSha: hash, manifestSha: hash, identitySha: hash });
const operationSchema = z.strictObject({ v: z.literal(1), kind: z.literal("member-address"), id: uuid, revision: epoch,
  expected: expectedSchema, before: image, after: image.extend({ certificateSha: hash, memberSha: hash }), receiptSha: hash,
  actor, at: epoch, webOrigin: z.string().url(), affected: z.array(affected).max(256), administrator: person });
export type HubMemberAddressOperation = z.infer<typeof operationSchema>;
export type HubMemberAddressExpectation = z.infer<typeof expectedSchema>;
export type HubMemberAddressFleet = z.infer<typeof affected>;
const same = (a: unknown, b: unknown) => canonicalArguments(a) === canonicalArguments(b);
const refuse = (): never => { throw new HubMemberAddressError("recovery"); };
const TABLES = ["hub_member_address_head", "hub_member_address_operations", "hub_member_address_notices", "hub_member_address_targets"];
export const HUB_MEMBER_ADDRESS_MIGRATION: HubMigration = Object.freeze({ component: "s5-member-address", version: 1, up(db: Database.Database) {
  const present = TABLES.map(name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  if (present.some(Boolean) && !present.every(Boolean)) refuse();
  if (!present[0]) db.exec(`CREATE TABLE hub_member_address_head(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL CHECK(revision>=0),operation_id TEXT);
    INSERT INTO hub_member_address_head VALUES(1,0,NULL);
    CREATE TABLE hub_member_address_operations(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE hub_member_address_notices(id TEXT PRIMARY KEY,revision INTEGER UNIQUE NOT NULL,body TEXT NOT NULL);
    CREATE TABLE hub_member_address_targets(notice_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('host','person')),target TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('unread','read')),PRIMARY KEY(notice_id,kind,target));
    CREATE INDEX hub_member_address_recipient ON hub_member_address_targets(kind,target,state);`);
  readHubMemberAddressHead(db);
} });
function readOperation(db: Database.Database, id: string): HubMemberAddressOperation {
  try {
    const row = db.prepare("SELECT body FROM hub_member_address_operations WHERE id=?").get(id) as { body: string } | undefined;
    if (!row) return refuse();
    const op = operationSchema.parse(parseStrictJson(row.body, 256 * 1024));
    if (op.id !== id || op.revision !== op.expected.revision + 1 || op.before.identitySha !== op.expected.identitySha || hubOrigin(op.webOrigin) !== op.webOrigin
      || new Set(op.affected.map(f => f.id)).size !== op.affected.length) return refuse();
    return op;
  } catch { return refuse(); }
}
export function readHubMemberAddressHead(db: Database.Database): z.infer<typeof headSchema> {
  try {
    const r = db.prepare("SELECT revision,operation_id FROM hub_member_address_head WHERE singleton=1").get() as { revision: number; operation_id: string | null } | undefined;
    if (!r) return refuse();
    const h = headSchema.parse({ revision: r.revision, operationId: r.operation_id });
    if (h.revision === 0 ? h.operationId !== null : h.operationId === null || readOperation(db, h.operationId).revision !== h.revision) return refuse();
    return h;
  } catch { return refuse(); }
}
function proof(current: () => boolean): void {
  const v: unknown = current();
  if (v !== true) { if (v && typeof (v as PromiseLike<unknown>).then === "function") void Promise.resolve(v).catch(() => {}); throw new HubMemberAddressError("denied"); }
}
export function createHubMemberAddressDecision(options: { db: Database.Database; home: string; hubId: string; transport: HubTransportStore; now?(): number }) {
  const { db, home, hubId, transport } = options;
  const stateFleets = () => transport.read().fleets.filter(f => f.status === "active" && f.credentialHash !== null)
    .map(({ id, owner, generation, label }) => ({ id, owner, generation, ...(label === undefined ? {} : { label }) }));
  const inspect = (): HubMemberAddressExpectation => {
    const m = readHubMemberTls({ home });
    if (m.identity.hubId !== hubId) return refuse();
    return { ...readHubMemberAddressHead(db), transportRevision: transport.read().revision, identitySha: sha256(m.metadataText), certificateSha: sha256(m.certificatePem), keySha: sha256(m.keyPem), hubId: m.identity.hubId, spkiSha256: m.identity.spkiSha256, issuerKeyId: m.identity.issuerKeyId };
  };
  // Only the closed expected schema is persisted. issuerPublicKey is checked by readHubMemberTls, not duplicated.
  const snapshot = () => expectedSchema.parse(inspect());
  const api = {
    hubId, inspect: snapshot, affected: () => structuredClone(stateFleets()), head: () => { transport.read(); return readHubMemberAddressHead(db); },
    assertMounted(raw: unknown): void {
      const hub = raw as Record<string, unknown>, head = api.head(), m = readHubMemberTls({ home, memberOrigin: hub.memberOrigin as string });
      if (m.identity.hubId !== hubId) refuse();
      if (head.operationId === null) { if (hub.memberAddress !== undefined || m.metadata.v !== 1) refuse(); return; }
      const op = readOperation(db, head.operationId);
      if (!same(hub.memberAddress, { operationId: op.id, revision: op.revision })
        || sha256(canonicalArguments(hubMemberAddressBoundary(hub))) !== op.after.memberSha || sha256(m.metadataText) !== op.after.identitySha
        || sha256(m.certificatePem) !== op.after.certificateSha || sha256(m.keyPem) !== op.expected.keySha) refuse();
    },
    assertOperation(id: string): void {
      const h = api.head(), op = readOperation(db, id);
      if (h.operationId !== id || h.revision !== op.revision) refuse();
      // The transport may advance after physical completion; it must never go backwards through restore.
      if (transport.read().revision < op.expected.transportRevision + 1) refuse();
    },
    lookup(id: string): HubMemberAddressOperation | null {
      uuid.parse(id); api.head(); // Floor failure is uncertain, never mistaken for an uncommitted file stage.
      return db.prepare("SELECT 1 FROM hub_member_address_operations WHERE id=?").get(id) ? readOperation(db, id) : null;
    },
    commit(raw: HubMemberAddressOperation, current: () => boolean): HubMemberAddressOperation {
      const op = operationSchema.parse(raw);
      if (db.inTransaction || op.expected.hubId !== hubId || op.revision !== op.expected.revision + 1 || op.revision >= Number.MAX_SAFE_INTEGER) throw new HubMemberAddressError("invalid");
      const check = () => { proof(current); if (!same(snapshot(), op.expected) || !same(stateFleets(), op.affected)) throw new HubMemberAddressError("stale"); };
      return db.transaction(() => {
        check();
        if ((db.prepare("SELECT count(*) n FROM hub_member_address_notices").get() as { n: number }).n >= 1024) throw new HubMemberAddressError("busy");
        try { retireCompanyJoinForWebAddress(db, options.now?.() ?? Date.now()); }
        catch (e) { if (e instanceof HubProtocolError && e.code === "backpressure") throw new HubMemberAddressError("busy"); throw e; }
        const targets = new Set([personKeyString(op.administrator), ...op.affected.map(f => personKeyString(f.owner))]);
        let expectedState = "";
        transport.mutate({ at: op.at, requestId: op.actor.requestId, actor: { kind: "local-host" }, action: "hub.member-address.changed", result: "completed" }, (s, owning) => {
          if (owning !== db || s.revision !== op.expected.transportRevision || s.revocationVersion === Number.MAX_SAFE_INTEGER) return refuse();
          for (const f of s.fleets) if (f.status === "active" && f.credentialHash !== null) {
            if (f.generation === Number.MAX_SAFE_INTEGER) return refuse();
            f.credentialHash = null; f.status = "revoked"; f.generation++;
          }
          for (const p of s.pairings) if (p.state === "offered" || p.state === "pending") { p.state = "revoked"; p.codeHash = null; p.claimHash = null; }
          s.revocationVersion++;
          db.prepare("INSERT INTO hub_member_address_operations VALUES(?,?)").run(op.id, canonicalArguments(op));
          if (db.prepare("UPDATE hub_member_address_head SET revision=?,operation_id=? WHERE singleton=1 AND revision=?").run(op.revision, op.id, op.expected.revision).changes !== 1) return refuse();
          db.prepare("INSERT INTO hub_member_address_notices VALUES(?,?,?)").run(op.id, op.revision, canonicalArguments(op));
          const insert = db.prepare("INSERT INTO hub_member_address_targets VALUES(?,?,?,'unread')");
          insert.run(op.id, "host", hubId);
          for (const target of targets) insert.run(op.id, "person", target);
          expectedState = canonicalArguments({ ...s, revision: s.revision + 1 });
        });
        // Required audit runs inside mutate. Its callbacks cannot revoke authority or alter the stage/material unnoticed.
        proof(current);
        const m = readHubMemberTls({ home }), h = readHubMemberAddressHead(db), settled = transport.read();
        if (sha256(m.metadataText) !== op.expected.identitySha || sha256(m.certificatePem) !== op.expected.certificateSha || sha256(m.keyPem) !== op.expected.keySha
          || h.operationId !== op.id || h.revision !== op.revision || !same(readOperation(db, op.id), op)
          || canonicalArguments(settled) !== expectedState || settled.revision !== op.expected.transportRevision + 1 || stateFleets().length !== 0
          || settled.pairings.some(p => p.state === "offered" || p.state === "pending")
          || (db.prepare("SELECT count(*) n FROM hub_member_address_targets WHERE notice_id=?").get(op.id) as { n: number }).n !== targets.size + 1
          || !db.prepare("SELECT 1 FROM hub_member_address_notices WHERE id=? AND revision=? AND body=?").get(op.id, op.revision, canonicalArguments(op))) return refuse();
        for (const target of targets) if (!db.prepare("SELECT 1 FROM hub_member_address_targets WHERE notice_id=? AND kind='person' AND target=? AND state='unread'").get(op.id, target)) return refuse();
        if (!db.prepare("SELECT 1 FROM hub_member_address_targets WHERE notice_id=? AND kind='host' AND target=? AND state='unread'").get(op.id, hubId)) return refuse();
        return structuredClone(op);
      }).immediate();
    },
    /** Internal session adapters supply an exact current recipient, never a browser-selected PersonKey. */
    notices(recipient: { kind: "host" } | { kind: "person"; person: PersonKey }, current: () => boolean, before?: number) {
      proof(current); api.head();
      if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new HubMemberAddressError("invalid");
      const target = recipient.kind === "host" ? hubId : personKeyString(person.parse(recipient.person));
      const rows = db.prepare(`SELECT n.id,t.state FROM hub_member_address_notices n JOIN hub_member_address_targets t ON n.id=t.notice_id
        WHERE t.kind=? AND t.target=? AND n.revision<? ORDER BY n.revision DESC LIMIT 101`).all(recipient.kind, target, before ?? Number.MAX_SAFE_INTEGER) as { id: string; state: string }[];
      const visible = rows.slice(0, 100).map(row => {
        const op = readOperation(db, row.id), all = recipient.kind === "host" || recipient.kind === "person" && personKeyString(op.administrator) === target;
        return { id: op.id, revision: op.revision, at: op.at, state: row.state, action: "reconnect" as const, webOrigin: op.webOrigin,
          fleets: op.affected.filter(f => all || personKeyString(f.owner) === target).map(f => ({ id: f.id, ...(f.label === undefined ? {} : { label: f.label }) })) };
      });
      proof(current); return { rows: visible, before: rows.length > 100 ? visible.at(-1)!.revision : null };
    },
    acknowledge(id: string, recipient: { kind: "host" } | { kind: "person"; person: PersonKey }, current: () => boolean): void {
      uuid.parse(id); proof(current);
      const target = recipient.kind === "host" ? hubId : personKeyString(person.parse(recipient.person));
      db.transaction(() => {
        proof(current); transport.read(); readOperation(db, id);
        const row = db.prepare("SELECT state FROM hub_member_address_targets WHERE notice_id=? AND kind=? AND target=?").get(id, recipient.kind, target) as { state: string } | undefined;
        if (!row) throw new HubMemberAddressError("denied");
        if (row.state === "read") return;
        if (row.state !== "unread") return refuse();
        transport.mutate({ at: options.now?.() ?? Date.now(), requestId: id, actor: recipient.kind === "host" ? { kind: "local-host" } : { kind: "person", person: recipient.person }, action: "hub.member-address.notice-read", result: "completed" }, () => {
          if (db.prepare("UPDATE hub_member_address_targets SET state='read' WHERE notice_id=? AND kind=? AND target=? AND state='unread'").run(id, recipient.kind, target).changes !== 1) return refuse();
        });
        proof(current);
      }).immediate();
    },
  };
  return api;
}
export type HubMemberAddressDecision = ReturnType<typeof createHubMemberAddressDecision>;
