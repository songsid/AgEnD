/** Inactive automatic expiry settlement. No timer, HTTP route or migration registration. */
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { HubAuditStore } from "../audit/index.js";
import type { HubMigration } from "../db.js";
import type { HubDirectory } from "../directory/types.js";
import type { HubGroupPolicyStore } from "../group-policy/store.js";
import { personKeyString } from "../identity.js";
import type { PersonKey } from "../types.js";
import { epoch, identifier, parseStrictJson, person, validated } from "../validation.js";
import { MANAGEMENT_PERMISSIONS, parseRolePolicy, type HubRoleAssignment, type HubRolePolicy } from "./model.js";
import type { RoleWriteEffects } from "./writer.js";
export const HUB_ROLE_EXPIRY_MIGRATION: HubMigration = { component: "roles-expiry", version: 1, up(db) {
  // No audit FK: retention must not erase idempotence or the committed clock floor.
  db.exec("CREATE TABLE IF NOT EXISTS hub_role_expiry_terms(term TEXT PRIMARY KEY,assignment_id TEXT NOT NULL,expires_at INTEGER NOT NULL,audit_id TEXT NOT NULL,settled_at INTEGER NOT NULL)");
} };
export interface RoleExpiryOptions {
  db: Database.Database; hubId: string; realm: string; generation: string; root: PersonKey;
  audit: Pick<HubAuditStore, "appendInTransaction">; directory: Pick<HubDirectory, "realm" | "checkEligibility">;
  reads: Pick<HubGroupPolicyStore, "withDirectoryRead">;
  effects: { snapshot: RoleWriteEffects["snapshot"]; prepare(input: { policy: HubRolePolicy; expired: readonly HubRoleAssignment[]; at: number }, assertCurrent: () => void): ReturnType<RoleWriteEffects["prepare"]> };
  current(): boolean; version(): number; advanceAuthorization(database: Database.Database): void; refreshAuthorization(): void;
  now?: () => number; elapsedNow?: () => number;
}
export type RoleExpiryResult = { ok: true; settled: number } | { ok: false; code: "unavailable" | "conflict" | "expired" };
class Refusal extends Error { constructor(readonly code: "unavailable" | "conflict" | "expired") { super(code); } }
const json = (v: unknown) => JSON.stringify(v);
const hash = (v: unknown) => createHash("sha256").update(json(v)).digest("hex");
function sync(value: unknown) {
  if (value && typeof (value as { then?: unknown }).then === "function") {
    void Promise.resolve(value).catch(() => undefined); throw new Refusal("unavailable");
  }
}
export function createHubRoleExpirySettlement(options: RoleExpiryOptions) {
  const { db, audit, reads, directory, effects, current, version: readVersion, advanceAuthorization, refreshAuthorization } = options;
  const hubId = validated(identifier, options.hubId), root = validated(person, options.root), { realm, generation } = options;
  const clock = options.now ?? Date.now, elapsedClock = options.elapsedNow ?? (() => performance.now());
  const eligibilityMethod = directory.checkEligibility, eligibility = eligibilityMethod.bind(directory);
  const now = () => validated(epoch, clock()), version = () => validated(epoch, readVersion());
  let closed = false, flight: Promise<RoleExpiryResult> | null = null;
  const live = () => { if (closed || current() !== true || directory.realm !== realm || root.realm !== realm || directory.checkEligibility !== eligibilityMethod) throw new Refusal("unavailable"); };
  const elapsed = () => { const n = elapsedClock(); if (!Number.isFinite(n) || n < 0) throw new Refusal("expired"); return n; };
  const read = () => {
    live(); const r = db.prepare("SELECT hub_id,body FROM hub_group_policy WHERE singleton=1").get() as { hub_id: string; body: string } | undefined;
    if (!r || r.hub_id !== hubId) throw new Refusal("unavailable");
    const policy = parseRolePolicy(parseStrictJson(r.body));
    if (policy.realm !== realm || policy.generation !== generation) throw new Refusal("unavailable");
    return { raw: r.body, policy };
  };
  /** A clock fence only, never an operation permit. All future live role readers must consume it. */
  const assertAuthorizationTime = () => {
    read(); version(); // Includes the independently persisted transport-floor check.
    const row = db.prepare("SELECT MAX(settled_at) AS at FROM hub_role_expiry_terms").get() as { at: number | null };
    if (row.at !== null && now() < validated(epoch, row.at)) throw new Refusal("expired");
  };
  read(); version(); // A rewound clock holds operations, without preventing construction of the held helper.
  const snapshot = () => {
    const s = effects.snapshot();
    if (!s || typeof s.fingerprint !== "string" || s.fingerprint.length > 1024 || typeof s.ordinaryFingerprint !== "string" || s.ordinaryFingerprint.length > 1024) throw new Refusal("unavailable");
    return { fingerprint: s.fingerprint, ordinaryFingerprint: s.ordinaryFingerprint };
  };
  const term = (a: HubRoleAssignment) => hash([hubId, realm, a.id, a.expiresAt]);
  const settled = (a: HubRoleAssignment) => Boolean(db.prepare("SELECT term FROM hub_role_expiry_terms WHERE term=?").get(term(a)));
  const administrators = (p: HubRolePolicy, at: number) => {
    const result = new Map([[personKeyString(root), root]]);
    if (p.rolesActive) for (const a of p.assignments) if (a.subject.kind === "person" && a.startsAt <= at && (a.expiresAt === null || a.expiresAt > at)
      && p.roles.find(r => r.id === a.roleId)!.permissions.includes("hub.admin")) result.set(personKeyString(a.subject.person), a.subject.person);
    return [...result].sort(([a], [b]) => a.localeCompare(b));
  };
  const run = async (): Promise<RoleExpiryResult> => {
    let committed = false;
    try {
      if (db.inTransaction) throw new Refusal("unavailable");
      assertAuthorizationTime(); const before = read(), authEpoch = version(), started = now(), elapsedStart = elapsed();
      const expired = before.policy.assignments.filter(a => a.expiresAt !== null && a.expiresAt <= started && !settled(a));
      if (!expired.length) return { ok: true, settled: 0 };
      const inventory = snapshot(), candidates = administrators(before.policy, started), recipients: string[] = [];
      const budget = () => { const t = elapsed(); if (now() < started || t < elapsedStart || t >= elapsedStart + 20_000) throw new Refusal("expired"); };
      const common = () => {
        live(); budget(); assertAuthorizationTime();
        if (read().raw !== before.raw || version() !== authEpoch || json(administrators(before.policy, now())) !== json(candidates)) throw new Refusal("conflict");
      };
      const assertBefore = () => {
        common(); if (snapshot().fingerprint !== inventory.fingerprint || expired.some(settled)) throw new Refusal("conflict");
      };
      // Management assignments are person-only by the strict graph; no group enumeration is needed.
      for (const [id, who] of candidates) {
        assertBefore(); const e = await reads.withDirectoryRead(root, () => eligibility(Object.freeze({ ...who })));
        assertBefore();
        if (e.eligible === true) {
          const selected = validated(person, e.person.key); if (personKeyString(selected) !== id) throw new Refusal("unavailable"); recipients.push(id);
        } else if (e.eligible !== false || !["gone", "disabled"].includes(e.reason)) throw new Refusal("unavailable");
      }
      const raw = await effects.prepare({ policy: parseRolePolicy(before.policy), expired: structuredClone(expired), at: started }, assertBefore);
      assertBefore();
      const serializedImpact = json(raw.impact);
      if (typeof raw.fingerprint !== "string" || raw.fingerprint.length > 1024 || typeof raw.changed !== "boolean" || typeof serializedImpact !== "string" || Buffer.byteLength(serializedImpact, "utf8") > 256 * 1024) throw new Refusal("unavailable");
      const prepared = { impact: parseStrictJson(serializedImpact, 256 * 1024), assertCurrent: raw.assertCurrent.bind(raw), commit: raw.commit.bind(raw), assertCommitted: raw.assertCommitted.bind(raw) };
      sync(prepared.assertCurrent()); assertBefore();
      db.transaction(() => {
        assertBefore(); sync(prepared.assertCurrent()); assertBefore(); sync(prepared.commit(db));
        const records: { term: string; assignment_id: string; expires_at: number; audit_id: string; settled_at: number }[] = [];
        const requestId = randomUUID(), at = now();
        for (const a of expired) {
          const id = randomUUID(), body = { assignmentId: a.id, roleId: a.roleId, expiresAt: a.expiresAt, impactDigest: hash(prepared.impact) };
          sync(audit.appendInTransaction({ id, at, sequence: 0, requestId, actor: { kind: "local-host" }, action: "role.assignment-expired", result: "completed", policyVersion: before.policy.revision, reasonCode: hash(body) }, db));
          db.prepare("INSERT INTO hub_role_events VALUES(?,?,?)").run(id, json(body), at);
          const record = { term: term(a), assignment_id: a.id, expires_at: a.expiresAt!, audit_id: id, settled_at: at }; records.push(record);
          db.prepare("INSERT INTO hub_role_expiry_terms VALUES(@term,@assignment_id,@expires_at,@audit_id,@settled_at)").run(record);
          if (before.policy.roles.find(r => r.id === a.roleId)!.permissions.some(p => (MANAGEMENT_PERMISSIONS as readonly string[]).includes(p))) {
            for (const recipient of recipients) db.prepare("INSERT INTO hub_role_notices(id,person) VALUES(?,?)").run(id, recipient);
          }
        }
        const final = () => {
          sync(prepared.assertCommitted()); live(); budget();
          if (read().raw !== before.raw || snapshot().ordinaryFingerprint !== inventory.ordinaryFingerprint || json(administrators(before.policy, now())) !== json(candidates)) throw new Refusal("conflict");
          for (const record of records) {
            const row = db.prepare("SELECT term,assignment_id,expires_at,audit_id,settled_at FROM hub_role_expiry_terms WHERE term=?").get(record.term);
            if (json(row) !== json(record)) throw new Refusal("conflict");
          }
        };
        final(); if (version() !== authEpoch) throw new Refusal("conflict"); sync(advanceAuthorization(db));
        if (version() !== authEpoch + 1) throw new Refusal("conflict"); final(); assertAuthorizationTime();
      }).immediate();
      committed = true; sync(refreshAuthorization()); live(); return { ok: true, settled: expired.length };
    } catch (error) {
      return { ok: false, code: !committed && error instanceof Refusal ? error.code : "unavailable" };
    }
  };
  return {
    /** Scheduling hint only. Live permissions still enforce assignment deadlines themselves. */
    nextDeadline(): number | null {
      assertAuthorizationTime();
      const pending = read().policy.assignments.filter(a => a.expiresAt !== null && !settled(a));
      return pending.length ? Math.min(...pending.map(a => a.expiresAt!)) : null;
    },
    settle(): Promise<RoleExpiryResult> {
      if (flight) return flight;
      flight = Promise.resolve().then(run).finally(() => { flight = null; }); return flight;
    },
    assertAuthorizationTime,
    close() { closed = true; },
  };
}
