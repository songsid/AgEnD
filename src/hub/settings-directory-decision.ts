/**
 * #3425 directory-v2 SQL decision for settings-commit.ts, not another file writer or an HTTP authority.
 * The shared writer stages/fsyncs the exact images first. One root IMMEDIATE transaction then authorizes
 * those images together with binding, floor/version, browser epoch, audit and FULL old-recipient notices.
 * File journals/signatures cannot substitute for this row. The runtime owns the participant; AD authority routes remain uncomposed.
 */
import { takeHubDirectorySessionRotation, type HubDirectorySessionRotation } from "./session-directory-transition.js";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { HubMigration } from "./db.js";
import type { HubTransportStore } from "./store.js";
import { advanceHubSessionEpoch, readHubSessionEpoch } from "./session-epoch.js";
import { canonicalArguments, sha256 } from "./identity.js";
import { parseGroupPolicy, type HubGroupPolicy } from "./group-policy/model.js";
import { epoch, hash, identifier, person, uuid, validated, parseStrictJson, HubProtocolError } from "./validation.js";

const imageSchema = z.strictObject({ configDigest: hash, configSha: hash, directorySha: hash, manifestSha: hash, bindSecretSha: hash });
export type HubDirectorySettingsImage = z.infer<typeof imageSchema>;
const actorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("hub-administrator"), person, sessionId: identifier, requestId: identifier }),
  z.strictObject({ kind: z.literal("host-owner"), sessionId: identifier, requestId: identifier }),
]);
const recipientSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("host"), sink: identifier }),
  z.strictObject({ kind: z.literal("person"), person }),
]);
const recipientsSchema = z.array(recipientSchema).min(1).max(32).refine(rows => rows.some(r => r.kind === "host")
  && new Set(rows.map(r => canonicalArguments(r))).size === rows.length);
const changesSchema = z.array(z.enum(["server", "ca", "search", "service-account", "secret", "query"])).min(1).max(6)
  .refine(xs => new Set(xs).size === xs.length);
const expectationSchema = z.strictObject({ operationId: uuid.nullable(), directoryEpoch: epoch,
  transportRevision: epoch, authorizationVersion: epoch, policySha: hash });
const requestSchema = z.strictObject({ id: uuid, expected: expectationSchema, before: imageSchema, after: imageSchema,
  generation: identifier, receiptSha: hash, actor: actorSchema, at: epoch,
  changes: changesSchema, recipients: recipientsSchema });
export type HubDirectoryDecisionRequest = z.infer<typeof requestSchema>;
export function parseHubDirectoryDecisionMetadata(raw: unknown) {
  return validated(z.strictObject({ actor: actorSchema, changes: changesSchema, recipients: recipientsSchema }), raw);
}
const operationSchema = requestSchema.extend({ kind: z.enum(["directory", "directory-compensation"]),
  compensates: uuid.nullable(), browserSession: z.strictObject({v:z.literal(1),previousSessionId:identifier,sessionId:identifier}).optional(), previousGeneration: identifier, directoryEpoch: epoch, authorizationVersion: epoch });
export type HubDirectorySettingsOperation = z.infer<typeof operationSchema>;
const noticeSchema = z.strictObject({ v: z.literal(1), id: uuid, operationId: uuid,
  kind: z.enum(["directory", "directory-compensation"]), phase: z.literal("applying"),
  actor: actorSchema, at: epoch, changes: changesSchema, recipients: recipientsSchema });
export type HubDirectorySecurityNotice = z.infer<typeof noticeSchema>;

export const HUB_DIRECTORY_SETTINGS_MIGRATION: HubMigration = Object.freeze({ component: "s5-directory-settings", version: 1, up(db: Database.Database) {
  const tables = ["hub_settings_head", "hub_settings_operations", "hub_settings_security_notices", "hub_settings_security_targets"];
  const present = tables.map(name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  if (present.some(Boolean) && !present.every(Boolean)) throw new HubProtocolError("uncertain");
  if (!present[0]) {
    // An existing authority must never be reconstructed from a missing operation log.
    if (readHubSessionEpoch(db) !== 0) throw new HubProtocolError("uncertain");
    db.exec(`CREATE TABLE hub_settings_head(singleton INTEGER PRIMARY KEY CHECK(singleton=1), operation_id TEXT, directory_epoch INTEGER NOT NULL);
      INSERT INTO hub_settings_head VALUES(1,NULL,0);
      CREATE TABLE hub_settings_operations(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE hub_settings_security_notices(id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES hub_settings_operations(id), body TEXT NOT NULL);
      CREATE TABLE hub_settings_security_targets(notice_id TEXT NOT NULL REFERENCES hub_settings_security_notices(id),
        kind TEXT NOT NULL CHECK(kind IN ('host','person')), target TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','delivered')),
        PRIMARY KEY(notice_id,kind,target));`);
  }
  readHubDirectorySettingsHead(db);
} });

function operation(db: Database.Database, id: string): HubDirectorySettingsOperation {
  const row = db.prepare("SELECT body FROM hub_settings_operations WHERE id=?").get(id) as { body: string } | undefined;
  if (!row) throw new HubProtocolError("uncertain");
  const result = validated(operationSchema, parseStrictJson(row.body));
  if (result.id !== id) throw new HubProtocolError("uncertain");
  return result;
}
/** Durable head only. A mounted server must separately prove its exact installed image matches head.after. */
export function readHubDirectorySettingsHead(db: Database.Database): { operationId: string | null; directoryEpoch: number } {
  try {
    const row = db.prepare("SELECT operation_id, directory_epoch FROM hub_settings_head WHERE singleton=1").get() as { operation_id: string | null; directory_epoch: number } | undefined;
    if (!row || !Number.isSafeInteger(row.directory_epoch) || row.directory_epoch !== readHubSessionEpoch(db)
      || (row.operation_id === null ? row.directory_epoch !== 0 : !uuid.safeParse(row.operation_id).success)) throw new HubProtocolError("uncertain");
    if (row.operation_id !== null && operation(db, row.operation_id).directoryEpoch !== row.directory_epoch) throw new HubProtocolError("uncertain");
    return { operationId: row.operation_id, directoryEpoch: row.directory_epoch };
  } catch { throw new HubProtocolError("uncertain"); }
}

function policyRow(db: Database.Database) {
  const row = db.prepare("SELECT hub_id,body FROM hub_group_policy WHERE singleton=1").get() as { hub_id: string; body: string } | undefined;
  if (!row) throw new HubProtocolError("uncertain");
  return { ...row, policy: parseGroupPolicy(parseStrictJson(row.body)), sha: sha256(row.body) };
}
const same = (a: unknown, b: unknown) => canonicalArguments(a) === canonicalArguments(b);
const content = ({ manifestSha: _manifest, ...rest }: HubDirectorySettingsImage) => rest;
const directoryBoundary = ({ directorySha, bindSecretSha }: HubDirectorySettingsImage) => ({ directorySha, bindSecretSha });
const targetRows = (recipients: HubDirectorySecurityNotice["recipients"]) => recipients.map(r => ({ kind: r.kind,
  target: r.kind === "host" ? r.sink : `${r.person.realm}/${r.person.objectId}`, state: "queued" })).sort((a, b) => canonicalArguments(a).localeCompare(canonicalArguments(b)));
function synchronous(value: unknown): void {
  if (value && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function") {
    try { (value as PromiseLike<unknown>).then(undefined, () => undefined); } catch { /* refused below */ }
    throw new HubProtocolError("invalid");
  }
}

export interface HubDirectoryDecisionDeps {
  db: Database.Database;
  transport: HubTransportStore;
  /** Exact Hub binding, never accepted from a browser body. */
  hubId: string;
}
export type HubDirectorySettingsDecision = ReturnType<typeof createHubDirectorySettingsDecision>;
/** Internal library, no I/O on construction. The shared writer owns all file installation and proof acquisition. */
export function createHubDirectorySettingsDecision(deps: HubDirectoryDecisionDeps) {
  const { db, transport } = deps, hubId = validated(identifier, deps.hubId);
  // Only while THIS root decision calls its synchronous proof. The final SQL checks still validate every own change.
  let proofBasis: { expected: HubDirectoryDecisionRequest["expected"]; policy: HubGroupPolicy } | null = null;
  function prove<T>(expected: HubDirectoryDecisionRequest["expected"], policy: HubGroupPolicy, work: () => T): T {
    if (proofBasis) throw new HubProtocolError("invalid");
    proofBasis = { expected: structuredClone(expected), policy: structuredClone(policy) };
    try { return work(); } finally { proofBasis = null; }
  }
  function inspect() {
    const head = readHubDirectorySettingsHead(db), state = transport.read(), p = policyRow(db);
    if (p.hub_id !== hubId) throw new HubProtocolError("uncertain");
    return { ...head, transportRevision: state.revision, authorizationVersion: state.revocationVersion, policySha: p.sha };
  }
  function assertExpected(expected: z.infer<typeof expectationSchema>) {
    if (!same(inspect(), expected)) throw new HubProtocolError("conflict");
  }
  function decide(raw: HubDirectoryDecisionRequest, assertProof: () => void | number, compensation?: HubDirectorySettingsOperation, rotation?: HubDirectorySessionRotation): HubDirectorySettingsOperation {
    // Parse clones nested inputs before invoking any caller/audit callback. No mutable request may be published later.
    const input = validated(requestSchema, raw);
    if (db.inTransaction) throw new HubProtocolError("invalid"); // this must be the durable root decision, never a savepoint
    const transition = rotation ? takeHubDirectorySessionRotation(rotation, db, hubId, input.actor, input.expected.directoryEpoch) : undefined;
    if (compensation && transition) throw new HubProtocolError("invalid");
    const result = db.transaction(() => {
      assertExpected(input.expected);
      const basisPolicy = policyRow(db).policy;
      synchronous(prove(input.expected, basisPolicy, assertProof)); assertExpected(input.expected);
      transition?.validate(transition.clock());
      const previous = policyRow(db), policy = previous.policy;
      if (previous.hub_id !== hubId || (input.actor.kind === "hub-administrator" && input.actor.person.realm !== policy.realm)) throw new HubProtocolError("denied");
      // Cosmetic rename v1 may have resealed the full Hub since the last directory decision. Its directory/secret
      // authority is unchanged; the shared writer separately verifies and CASes the exact current complete pair.
      if (input.expected.operationId !== null && !same(directoryBoundary(operation(db, input.expected.operationId).after), directoryBoundary(input.before))) throw new HubProtocolError("conflict");
      if (same(input.before, input.after) || policy.revision === Number.MAX_SAFE_INTEGER) throw new HubProtocolError("invalid");
      if (compensation && (compensation.kind !== "directory" || input.expected.operationId !== compensation.id
        || !same(input.before, compensation.after)
        || !same(content(input.after), content(compensation.before)) || input.generation !== compensation.previousGeneration
        || !same(input.recipients, compensation.recipients) || !same(input.actor, compensation.actor)
        || !same(input.changes, compensation.changes))) throw new HubProtocolError("conflict");
      const nextPolicy: HubGroupPolicy = { ...policy, generation: input.generation, revision: policy.revision + 1 };
      const nextEpoch = input.expected.directoryEpoch + 1, nextVersion = input.expected.authorizationVersion + 1;
      if (!Number.isSafeInteger(nextEpoch) || !Number.isSafeInteger(nextVersion)) throw new HubProtocolError("unavailable");
      const saved = validated(operationSchema, { ...input, kind: compensation ? "directory-compensation" : "directory",
        compensates: compensation?.id ?? null, ...(transition ? {browserSession:transition.declaration} : {}), previousGeneration: policy.generation, directoryEpoch: nextEpoch, authorizationVersion: nextVersion });
      const notice = validated(noticeSchema, { v: 1, id: randomUUID(), operationId: input.id, kind: saved.kind, phase: "applying",
        actor: input.actor, at: input.at, changes: input.changes, recipients: input.recipients });
      transport.mutate({ at: input.at, requestId: input.actor.requestId,
        actor: input.actor.kind === "host-owner" ? { kind: "local-host" } : { kind: "person", person: input.actor.person },
        action: `settings.${saved.kind}-committed`, result: "completed", reasonCode: input.receiptSha }, (state, owningDb) => {
        if (owningDb !== db || !db.inTransaction) throw new HubProtocolError("invalid");
        assertExpected(input.expected);
        state.revocationVersion = nextVersion;
        // Cancel unfinished self-service reservations; never restore work or alter retained credential/provenance rows.
        for (const pairing of state.pairings) if (pairing.automatic && ["offered", "pending"].includes(pairing.state)) {
          pairing.state = "revoked"; pairing.codeHash = null; pairing.claimHash = null;
        }
        db.prepare("UPDATE hub_group_policy SET body=? WHERE singleton=1 AND hub_id=? AND body=?")
          .run(JSON.stringify(parseGroupPolicy(nextPolicy)), hubId, previous.body);
        db.prepare("INSERT INTO hub_settings_operations VALUES(?,?)").run(input.id, JSON.stringify(saved));
        db.prepare("INSERT INTO hub_settings_security_notices VALUES(?,?,?)").run(notice.id, input.id, JSON.stringify(notice));
        for (const target of targetRows(notice.recipients)) db.prepare("INSERT INTO hub_settings_security_targets VALUES(?,?,?,'queued')").run(notice.id, target.kind, target.target);
      }); // existing floor-before-audit and same-DB write; any later rollback leaves a raised floor uncertain
      const finalProof = prove(input.expected, policy, assertProof); synchronous(finalProof);
      // The shared writer returns its last clock sample, avoiding another callback after its final material/time check.
      const transitionTime = typeof finalProof === "number" ? finalProof : transition?.clock();
      // Audit/proof callbacks may reenter. Recheck every authority image before the final callback-free transition.
      const state = transport.read(), latestPolicy = policyRow(db);
      const storedNotice = db.prepare("SELECT body FROM hub_settings_security_notices WHERE id=? AND operation_id=?")
        .get(notice.id, input.id) as { body: string } | undefined;
      if (state.revision !== input.expected.transportRevision + 1 || state.revocationVersion !== nextVersion
        || !same(latestPolicy.policy, nextPolicy) || latestPolicy.hub_id !== hubId
        || !same(readHubDirectorySettingsHead(db), { operationId: input.expected.operationId, directoryEpoch: input.expected.directoryEpoch })
        || !same(operation(db, input.id), saved) || !storedNotice
        || !same(validated(noticeSchema, parseStrictJson(storedNotice.body)), notice)
        || !same((db.prepare("SELECT kind,target,state FROM hub_settings_security_targets WHERE notice_id=?").all(notice.id) as { kind: string; target: string; state: string }[])
          .sort((a, b) => canonicalArguments(a).localeCompare(canonicalArguments(b))), targetRows(notice.recipients))) throw new HubProtocolError("conflict");
      const successor = transition?.validate(transitionTime!);
      if (advanceHubSessionEpoch(db, input.expected.directoryEpoch) !== nextEpoch) throw new HubProtocolError("uncertain");
      if (successor) db.prepare("INSERT INTO hub_sessions(token_hash,id,person,created_at,seen_at,expires_at,state,directory_epoch) VALUES(?,?,?,?,?,?,'active',?)")
        .run(successor.tokenHash, successor.id, successor.person, successor.at, successor.at, successor.expiresAt, nextEpoch);
      const changed = db.prepare("UPDATE hub_settings_head SET operation_id=?,directory_epoch=? WHERE singleton=1 AND directory_epoch=? AND operation_id IS ?")
        .run(input.id, nextEpoch, input.expected.directoryEpoch, input.expected.operationId);
      if (changed.changes !== 1) throw new HubProtocolError("conflict");
      return saved;
    }).immediate();
    transition?.committed(result);
    return result;
  }
  return {
    hubId,
    inspect,
    /** Internal source projection for the exact synchronous proof; absent outside that callback (including after an await). */
    proofBasis() { return proofBasis ? structuredClone(proofBasis) : null; },
    decide(raw: HubDirectoryDecisionRequest, assertProof: () => void | number, rotation?: HubDirectorySessionRotation) { return decide(raw, assertProof, undefined, rotation); },
    /** A new operation restoring ONLY original content; current policy/denies/revokes/provenance are never rewound. */
    compensate(originalId: string, raw: HubDirectoryDecisionRequest, assertPreauthorizedIntent: () => void) {
      const original = operation(db, validated(uuid, originalId));
      return decide(raw, assertPreauthorizedIntent, original);
    },
    operation(id: string) { return operation(db, validated(uuid, id)); },
    /** Absence is meaningful only while floor/head authority is readable; uncertainty is never treated as no decision. */
    lookup(id: string): HubDirectorySettingsOperation | null {
      validated(uuid, id); inspect();
      return db.prepare("SELECT 1 FROM hub_settings_operations WHERE id=?").get(id) ? operation(db, id) : null;
    },
    /** Own startup/remount verifies files/seal first, then checks this barrier before admitting any effect. */
    imageCurrent(raw: HubDirectorySettingsImage): boolean {
      const image = validated(imageSchema, raw), head = inspect();
      return head.operationId === null || same(directoryBoundary(operation(db, head.operationId).after), directoryBoundary(image));
    },
    notices(): HubDirectorySecurityNotice[] {
      inspect();
      return (db.prepare("SELECT id,operation_id,body FROM hub_settings_security_notices ORDER BY rowid").all() as { id: string; operation_id: string; body: string }[])
        .map(row => {
          const notice = validated(noticeSchema, parseStrictJson(row.body));
          if (notice.id !== row.id || notice.operationId !== row.operation_id) throw new HubProtocolError("uncertain");
          return notice;
        });
    },
  };
}
