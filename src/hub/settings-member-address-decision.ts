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
/**
 * #3429 B: the Fleets that followed the relocation (an ack the Hub received, matched to that exact link, epoch, digest and
 * revision, rechecked after the shared wait) — each with the generation and credential it had when it was signed for.
 * Immutable: recovery uses this, never a live link map.
 */
const keptFleet = z.strictObject({ id: uuid, generation: epoch, credentialSha: hash, digest: hash });
const relocationSchema = z.strictObject({ sequence: epoch.min(1), to: z.string().url(), kept: z.array(keptFleet).max(256) });
const operationSchema = z.strictObject({ v: z.literal(1), kind: z.literal("member-address"), id: uuid, revision: epoch,
  expected: expectedSchema, before: image, after: image.extend({ certificateSha: hash, memberSha: hash }), receiptSha: hash,
  actor, at: epoch, webOrigin: z.string().url(), affected: z.array(affected).max(256), administrator: person,
  relocation: relocationSchema.optional(),
  /** #3429 B: a listener-only edit — the advertised member origin is unchanged, so every affected Fleet keeps its binding. */
  sameOrigin: z.literal(true).optional() });
export type HubMemberAddressRelocation = z.infer<typeof relocationSchema>;
/**
 * #3429 B: what a MOUNTED decision can do on the live member listener (compose/server.ts): sign a relocation for one Fleet
 * with the issuer key, send it on that Fleet's current link and wait for its matched ack, and recheck that link. A
 * recovery decision has none: every affected Fleet is then revoked (option A).
 */
export interface HubMemberRelocator {
  sign(fleetId: string, s: { from: string; to: string; revision: number }): import("./types.js").HubRelocation;
  send(fleetId: string, statement: import("./types.js").HubRelocation, digest: string, deadline: number): Promise<import("./server.js").HubRelocationAck | null>;
  /** `advanced`: authorization versions the caller's own uncommitted decision already published (see HubServer). */
  linkCurrent(proof: import("./server.js").HubRelocationAck, advanced?: number): boolean;
}
/**
 * #3429 B: the kept Fleets' exact ack links, retained through the decision (ephemeral: never persisted). true only while
 * every kept Fleet's link is still the one that acked; `advanced` as in linkCurrent.
 */
export type HubRelocationHeld = (advanced: number) => boolean;
export type HubMemberAddressOperation = z.infer<typeof operationSchema>;
export type HubMemberAddressExpectation = z.infer<typeof expectedSchema>;
export type HubMemberAddressFleet = z.infer<typeof affected>;
/**
 * #3429 B: the relocation reservations (one per commit attempt; an abort burns its sequence) and the exact statement
 * signed for each Fleet in it (the signature binds the Fleet, so each row is its own). A component of its own, so an
 * older build that does not know it refuses the database (the required-component rule).
 */
export const HUB_MEMBER_RELOCATION_MIGRATION: HubMigration = Object.freeze({ component: "s5-member-relocation", version: 1, up(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS hub_member_relocations(sequence INTEGER PRIMARY KEY CHECK(sequence>=1),attempt TEXT UNIQUE NOT NULL,
      base_revision INTEGER NOT NULL,from_origin TEXT NOT NULL,to_origin TEXT NOT NULL,spki TEXT NOT NULL,at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS hub_member_relocation_statements(sequence INTEGER NOT NULL REFERENCES hub_member_relocations(sequence),
      fleet_id TEXT NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(sequence,fleet_id));`);
} });
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
    /** #3429 B: set by the mounted Hub once its member listener exists; null for a recovery decision. */
    relocator: null as HubMemberRelocator | null,
    /** #3429 B: the generation and credential binding a Fleet has now (what a kept proof is bound to), or null. */
    fleetBinding(id: string): { generation: number; credentialSha: string } | null {
      const f = transport.read().fleets.find(x => x.id === id && x.status === "active" && x.credentialHash !== null);
      return f ? { generation: f.generation, credentialSha: sha256(f.credentialHash!) } : null;
    },
    /**
     * #3429 B: reserve the next relocation sequence for one commit attempt, in its own IMMEDIATE transaction. It does not
     * move the member-address head (the running listener is not fenced before the acks are in); an abort burns it.
     */
    reserveRelocation(input: { attempt: string; from: string; to: string; spki: string; at: number }): number {
      if (db.inTransaction || hubOrigin(input.from) !== input.from || hubOrigin(input.to) !== input.to || input.from === input.to) throw new HubMemberAddressError("invalid");
      return db.transaction(() => {
        const base = readHubMemberAddressHead(db).revision;
        const top = (db.prepare("SELECT max(sequence) s FROM hub_member_relocations").get() as { s: number | null }).s ?? 0;
        if (top >= Number.MAX_SAFE_INTEGER - 1) throw new HubMemberAddressError("busy");
        db.prepare("INSERT INTO hub_member_relocations VALUES(?,?,?,?,?,?,?)").run(top + 1, input.attempt, base, input.from, input.to, input.spki, input.at);
        return top + 1;
      }).immediate();
    },
    /** #3429 B: the exact statement signed for each Fleet of a reservation, before any is sent (never re-signed later). */
    recordRelocationStatements(sequence: number, rows: readonly { fleetId: string; digest: string; body: string }[]): void {
      if (db.inTransaction) throw new HubMemberAddressError("invalid");
      db.transaction(() => {
        if (!db.prepare("SELECT 1 FROM hub_member_relocations WHERE sequence=?").get(sequence)) throw new HubMemberAddressError("stale");
        const insert = db.prepare("INSERT INTO hub_member_relocation_statements VALUES(?,?,?,?)");
        for (const r of rows) insert.run(sequence, uuid.parse(r.fleetId), hash.parse(r.digest), r.body);
      }).immediate();
    },
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
    commit(raw: HubMemberAddressOperation, current: () => boolean, held?: HubRelocationHeld): HubMemberAddressOperation {
      const op = operationSchema.parse(raw);
      if (db.inTransaction || op.expected.hubId !== hubId || op.revision !== op.expected.revision + 1 || op.revision >= Number.MAX_SAFE_INTEGER) throw new HubMemberAddressError("invalid");
      // #3429 B: a kept Fleet is kept only while its exact ack link is (design r4's last-boundary rule): no proof, no keep.
      const keeping = (op.relocation?.kept.length ?? 0) > 0;
      if (keeping && !held) throw new HubMemberAddressError("invalid");
      const linksHeld = (advanced: number) => !keeping || held!(advanced) === true;
      const check = () => { proof(current); if (!same(snapshot(), op.expected) || !same(stateFleets(), op.affected) || !linksHeld(0)) throw new HubMemberAddressError("stale"); };
      return db.transaction(() => {
        check();
        if ((db.prepare("SELECT count(*) n FROM hub_member_address_notices").get() as { n: number }).n >= 1024) throw new HubMemberAddressError("busy");
        try { retireCompanyJoinForWebAddress(db, options.now?.() ?? Date.now()); }
        catch (e) { if (e instanceof HubProtocolError && e.code === "backpressure") throw new HubMemberAddressError("busy"); throw e; }
        // #3429 B: the kept Fleets must be from this exact reservation (its base head and target), signed rows included.
        const kept = new Map((op.relocation?.kept ?? []).map(k => [k.id, k]));
        if (op.sameOrigin && op.relocation) return refuse();
        if (op.relocation) {
          const row = db.prepare("SELECT base_revision b,to_origin t FROM hub_member_relocations WHERE sequence=?").get(op.relocation.sequence) as { b: number; t: string } | undefined;
          if (!row || row.b !== op.expected.revision || row.t !== op.relocation.to) return refuse();
          for (const k of kept.values()) if (!db.prepare("SELECT 1 FROM hub_member_relocation_statements WHERE sequence=? AND fleet_id=? AND digest=?").get(op.relocation.sequence, k.id, k.digest)) return refuse();
        }
        // A listener-only edit keeps every affected Fleet at the generation it was prepared with (the start check above
        // already matched the live rows to op.affected; nothing runs between it and the mutate).
        const same0 = new Map(op.sameOrigin ? op.affected.map(f => [f.id, f.generation]) : []);
        const keeps = (f: { id: string; generation: number; credentialHash: string | null }) => {
          if (op.sameOrigin) return f.credentialHash !== null && same0.get(f.id) === f.generation;
          const k = kept.get(f.id);
          return !!k && f.credentialHash !== null && k.generation === f.generation && k.credentialSha === sha256(f.credentialHash);
        };
        // Every kept Fleet must still have the generation and credential it was signed for; otherwise the whole change is
        // stale (prepare again) — never a silently different kept set, so "revoked = affected − kept" holds exactly.
        const live = transport.read().fleets;
        for (const k of kept.values()) if (!live.some(f => f.id === k.id && f.status === "active" && keeps(f))) throw new HubMemberAddressError("stale");
        const keptNow = new Set(op.sameOrigin ? same0.keys() : kept.keys());
        const revokedOwners = op.affected.filter(f => !keptNow.has(f.id)).map(f => personKeyString(f.owner));
        const targets = new Set([personKeyString(op.administrator), ...revokedOwners]);
        let expectedState = "";
        transport.mutate({ at: op.at, requestId: op.actor.requestId, actor: { kind: "local-host" }, action: "hub.member-address.changed", result: "completed" }, (s, owning) => {
          if (owning !== db || s.revision !== op.expected.transportRevision || s.revocationVersion === Number.MAX_SAFE_INTEGER) return refuse();
          // The last point before the version floor moves: a link lost by now aborts cleanly (stale; prepare again).
          if (!linksHeld(0)) throw new HubMemberAddressError("stale");
          for (const f of s.fleets) if (f.status === "active" && f.credentialHash !== null) {
            if (keptNow.has(f.id) && keeps(f)) continue;          // #3429 B: it followed the relocation with this credential
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
        // Required audit runs inside mutate. Its callbacks cannot revoke authority or alter the stage/material unnoticed —
        // nor drop a kept link: rechecked with this operation's own one version advance (the floor has moved: fail closed).
        proof(current);
        if (!linksHeld(1)) return refuse();
        const m = readHubMemberTls({ home }), h = readHubMemberAddressHead(db), settled = transport.read();
        if (sha256(m.metadataText) !== op.expected.identitySha || sha256(m.certificatePem) !== op.expected.certificateSha || sha256(m.keyPem) !== op.expected.keySha
          || h.operationId !== op.id || h.revision !== op.revision || !same(readOperation(db, op.id), op)
          || canonicalArguments(settled) !== expectedState || settled.revision !== op.expected.transportRevision + 1
          // #3429 B: exactly the kept rows stay active with their credential (the image, not merely a count).
          || !same(stateFleets().map(f => [f.id, f.generation]).sort(), [...keptNow].map(id => [id, op.sameOrigin ? same0.get(id)! : kept.get(id)!.generation]).sort())
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
          fleets: op.affected.filter(f => !op.sameOrigin && !(op.relocation?.kept ?? []).some(k => k.id === f.id) && (all || personKeyString(f.owner) === target)).map(f => ({ id: f.id, ...(f.label === undefined ? {} : { label: f.label }) })) };
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
