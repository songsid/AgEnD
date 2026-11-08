/** Durable group-derived resource lifecycle. Internal only; this is not a consent or HTTP authority adapter. */
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { HubMigration } from "../db.js";
import type { HubAuditStore } from "../audit/index.js";
import type { PersonKey } from "../types.js";
import type { Eligibility, HubDirectory } from "../directory/types.js";
import { personKeyString } from "../identity.js";
import { identifier, person, parseStrictJson, validated } from "../validation.js";
import { HubGroupPolicyError, type GroupCheckContext, type HubGroupPolicyStore } from "./store.js";
import type { GroupCapability, HubGroupDecision } from "./model.js";

const resourceSchema = z.strictObject({ kind: z.enum(["fleet", "exposure", "asker"]), id: identifier,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), owner: person });
export type HubGroupResource = z.infer<typeof resourceSchema>;
export function parseHubGroupResource(input: unknown): HubGroupResource { return validated(resourceSchema, input); }
export interface HubGroupResourceView {
  resource: HubGroupResource; source: "manual" | "group"; state: "active" | "suspended"; revision: number;
}
export interface HubGroupResourceDecision {
  outcome: "allow" | "deny" | "held" | "resume-required";
  decision?: HubGroupDecision;
}
/** Enrollment has no row to suspend; preserve authoritative deny versus uncertain read for its caller. */
export class HubGroupEnrollmentRefusal extends HubGroupPolicyError {
  constructor(readonly outcome: "denied" | "held") { super("unavailable"); }
}
export const HUB_GROUP_RESOURCES_MIGRATION: HubMigration = Object.freeze({ component: "s5-group-resources", version: 1, up(db: Database.Database) {
  db.exec(`CREATE TABLE hub_group_resources(resource_key TEXT PRIMARY KEY, body TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('manual','group')), state TEXT NOT NULL CHECK(state IN ('active','suspended')),
    revision INTEGER NOT NULL CHECK(revision>0));
    CREATE TABLE hub_group_resource_events(id TEXT PRIMARY KEY REFERENCES hub_audit(id) ON DELETE CASCADE, body TEXT NOT NULL);`);
} });
const capability = (r: HubGroupResource): GroupCapability => r.kind === "fleet" ? "pair_fleet" : r.kind === "exposure" ? "publish_agents" : "ask_agents";
const keyOf = (r: HubGroupResource) => JSON.stringify([r.kind, r.id, r.revision]);
const snapshotContext = (ctx: GroupCheckContext) => ({ requestId: validated(identifier, ctx.requestId), current: ctx.current.bind(ctx) });

export function createHubGroupResources(options: {
  db: Database.Database; policy: HubGroupPolicyStore; audit: Pick<HubAuditStore, "appendInTransaction">;
  current(): boolean; now?: () => number;
  directory?: Pick<HubDirectory, "checkEligibility">;
  /** Synchronous same-DB authorization-version advance inside the lifecycle transaction, never socket I/O. */
  invalidate?(db: Database.Database, resource: HubGroupResource): void;
}) {
  const { db, policy, audit, current, invalidate } = options, now = options.now ?? Date.now;
  const assert = (ctx: ReturnType<typeof snapshotContext>) => {
    if (current() !== true || ctx.current() !== true) throw new HubGroupPolicyError("unavailable");
  };
  const capture = parseHubGroupResource;
  const row = (r: HubGroupResource): HubGroupResourceView | null => {
    const raw = db.prepare("SELECT body, source, state, revision FROM hub_group_resources WHERE resource_key=?").get(keyOf(r)) as
      { body: string; source: "manual" | "group"; state: "active" | "suspended"; revision: number } | undefined;
    if (!raw) return null;
    const resource = capture(parseStrictJson(raw.body) as HubGroupResource);
    if (JSON.stringify(resource) !== JSON.stringify(r) || !["manual", "group"].includes(raw.source)
      || !["active", "suspended"].includes(raw.state) || !Number.isSafeInteger(raw.revision) || raw.revision < 1) throw new HubGroupPolicyError("unavailable");
    return { resource, source: raw.source, state: raw.state, revision: raw.revision };
  };
  const record = (r: HubGroupResource, actor: PersonKey, action: string, ctx: ReturnType<typeof snapshotContext>, payload: unknown) => {
    const p = policy.read(), id = randomUUID(), body = JSON.stringify({ resource: r, generation: p.generation, policyRevision: p.revision, payload });
    const result: unknown = audit.appendInTransaction({ id, sequence: 0, at: now(), requestId: ctx.requestId, actor: { kind: "person", person: actor },
      action, result: "completed", policyVersion: p.revision, reasonCode: createHash("sha256").update(body).digest("hex") }, db);
    if (result && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") {
      try { (result as PromiseLike<unknown>).then(undefined, () => undefined); } catch { /* refuse */ }
      throw new HubGroupPolicyError("audit");
    }
    assert(ctx);
    if (policy.read().revision !== p.revision) throw new HubGroupPolicyError("conflict");
    db.prepare("INSERT INTO hub_group_resource_events VALUES(?,?)").run(id, body);
  };
  const update = (before: HubGroupResourceView, state: "active" | "suspended", actor: PersonKey, ctx: ReturnType<typeof snapshotContext>) => {
    if (before.state === state) return;
    if (before.revision === Number.MAX_SAFE_INTEGER) throw new HubGroupPolicyError("conflict");
    const policyRevision = policy.read().revision;
    record(before.resource, actor, `group-resource.${state === "active" ? "resumed" : "suspended"}`, ctx, { from: before.state, to: state });
    const changed = db.prepare("UPDATE hub_group_resources SET state=?, revision=revision+1 WHERE resource_key=? AND body=? AND revision=? AND source=? AND state=?")
      .run(state, keyOf(before.resource), JSON.stringify(before.resource), before.revision, before.source, before.state);
    if (changed.changes !== 1) throw new HubGroupPolicyError("conflict");
    const invalidated: unknown = invalidate?.(db, before.resource);
    if (invalidated && typeof (invalidated as { then?: unknown }).then === "function") {
      void Promise.resolve(invalidated).catch(() => undefined); throw new HubGroupPolicyError("audit");
    }
    // Suspending an old-version link deliberately makes its caller fence false. A resumption
    // broadens access, so its independent administrator/session fence must still hold.
    if (current() !== true) throw new HubGroupPolicyError("unavailable");
    if (policy.read().revision !== policyRevision) throw new HubGroupPolicyError("conflict");
    if (state === "active") assert(ctx);
  };
  /** Caller must use this result before every protected action, dispatch and release; it creates no underlying resource. */
  const check = async (input: HubGroupResource, incoming: GroupCheckContext, resumeActor?: PersonKey): Promise<HubGroupResourceDecision> => {
    const r = capture(input), ctx = snapshotContext(incoming), actor = resumeActor === undefined ? undefined : validated(person, resumeActor);
    assert(ctx); const p = policy.read(), before = row(r);
    if (!before || r.owner.realm !== p.realm || (actor && actor.realm !== p.realm)) throw new HubGroupPolicyError("invalid");
    const explicitlyDenied = p.state !== "never-enabled" && p.denies.some(d => d.person.objectId === r.owner.objectId && d.deny.includes(capability(r)));
    let eligibility: Eligibility | undefined;
    if (before.source === "manual" && !explicitlyDenied && r.kind === "fleet" && options.directory) {
      try {
        eligibility = await policy.withDirectoryRead(r.owner, () => options.directory!.checkEligibility(Object.freeze({ ...r.owner })));
      } catch { eligibility = { eligible: false, reason: "unavailable" }; }
    }
    if (before.source === "manual") return db.transaction((): HubGroupResourceDecision => {
      assert(ctx);
      if (policy.read().revision !== p.revision || JSON.stringify(row(r)) !== JSON.stringify(before)) throw new HubGroupPolicyError("conflict");
      // Grandfathering exempts membership, never an explicit person deny or ordinary account/resource revocation.
      if (explicitlyDenied) { update(before, "suspended", r.owner, ctx); return { outcome: "deny" }; }
      if (eligibility) {
        if (!eligibility.eligible) {
          if (eligibility.reason === "unavailable") return { outcome: "held" };
          update(before, "suspended", r.owner, ctx); return { outcome: "deny" };
        }
        if (personKeyString(eligibility.person.key) !== personKeyString(r.owner)) return { outcome: "held" };
      }
      if (before.state === "suspended") {
        if (!actor) return { outcome: "resume-required" };
        update(before, "active", actor, ctx);
      }
      return { outcome: "allow" }; // Exactly the captured revision; never another revision or a new publication.
    }).immediate();
    const decision = await policy.check(r.owner, capability(r), { ...ctx, resource: { ...incoming.resource, revision: r.revision,
      ...(r.kind === "fleet" ? { fleetId: r.id } : r.kind === "exposure" ? { exposureId: r.id } : {}) } });
    return db.transaction(() => {
      assert(ctx);
      const current = row(r);
      if (policy.read().revision !== p.revision || !current || current.revision !== before.revision) throw new HubGroupPolicyError("conflict");
      if (decision.outcome === "unknown") return { outcome: "held" as const, decision };
      if (decision.outcome !== "allow") {
        if (decision.outcome === "deny" && decision.authoritative) update(current, "suspended", r.owner, ctx);
        return { outcome: "deny" as const, decision };
      }
      if (current.state === "suspended") {
        if (!actor) return { outcome: "resume-required" as const, decision };
        update(current, "active", actor, ctx);
      }
      return { outcome: "allow" as const, decision };
    }).immediate();
  };
  /** Directory work outside SQL; publish provenance only inside the actual resource's transaction. */
  const prepareRegistration = async (input: HubGroupResource, incoming: GroupCheckContext) => {
    const r = capture(input), ctx = snapshotContext(incoming); assert(ctx); const p = policy.read();
    if (p.state !== "enabled" || r.owner.realm !== p.realm) throw new HubGroupPolicyError("invalid");
    const decision = await policy.check(r.owner, capability(r), { ...ctx, resource: { ...incoming.resource, revision: r.revision,
      ...(r.kind === "fleet" ? { fleetId: r.id } : r.kind === "exposure" ? { exposureId: r.id } : {}) } });
    assert(ctx);
    if (policy.read().revision !== p.revision) throw new HubGroupPolicyError("conflict");
    if (decision.outcome !== "allow") throw new HubGroupEnrollmentRefusal(decision.outcome === "unknown" ? "held" : "denied");
    let used = false;
    return { decision,
      commit(database: Database.Database): void {
        if (database !== db || !db.inTransaction || used) throw new HubGroupPolicyError("invalid");
        used = true; // A rolled-back attempt needs another fresh preparation, never replay this allowance.
        assert(ctx); if (policy.read().revision !== p.revision || row(r)) throw new HubGroupPolicyError("conflict");
        record(r, r.owner, "group-resource.registered", ctx, { source: "group" });
        db.prepare("INSERT INTO hub_group_resources VALUES(?,?,'group','active',1)").run(keyOf(r), JSON.stringify(r));
        assert(ctx);
      },
    };
  };
  return {
    read(input: HubGroupResource) { assert({ requestId: "read", current: () => true }); policy.read(); return row(capture(input)); },
    /** Only the pre-enable inventory may be grandfathered; no typed person/HTTP path may call this. */
    captureManual(input: HubGroupResource, incoming: GroupCheckContext, confirmedBy?: PersonKey): void {
      const r = capture(input), ctx = snapshotContext(incoming), actor = confirmedBy ? validated(person, confirmedBy) : r.owner;
      db.transaction(() => {
        assert(ctx); const p = policy.read();
        if (p.state !== "never-enabled" || r.kind === "asker" || r.owner.realm !== p.realm || actor.realm !== p.realm) throw new HubGroupPolicyError("invalid");
        const before = row(r); if (before) { if (before.source !== "manual") throw new HubGroupPolicyError("conflict"); return; }
        record(r, actor, "group-resource.manual-captured", ctx, { source: "manual" });
        db.prepare("INSERT INTO hub_group_resources VALUES(?,?,'manual','active',1)").run(keyOf(r), JSON.stringify(r));
      }).immediate();
    },
    /** Registers provenance after a fresh allowance. Caller still owes normal local consent/owner grant and quota checks. */
    async register(input: HubGroupResource, incoming: GroupCheckContext): Promise<void> {
      const prepared = await prepareRegistration(input, incoming);
      db.transaction(() => prepared.commit(db)).immediate();
    },
    prepareRegistration,
    /** A distinct explicit-admin grant, never inferred from group membership or pre-enable inventory. */
    prepareManualRegistration(input: HubGroupResource, confirmedBy: PersonKey, incoming: GroupCheckContext) {
      const r = capture(input), actor = validated(person, confirmedBy), ctx = snapshotContext(incoming);
      assert(ctx); const p = policy.read(), image = JSON.stringify(p);
      if (r.kind !== "fleet" || r.owner.realm !== p.realm || actor.realm !== p.realm) throw new HubGroupPolicyError("invalid");
      if (p.state !== "never-enabled" && p.denies.some(d => d.person.objectId === r.owner.objectId && d.deny.includes("pair_fleet"))) {
        throw new HubGroupEnrollmentRefusal("denied");
      }
      let used = false;
      return { commit(database: Database.Database): void {
        if (database !== db || !db.inTransaction || used) throw new HubGroupPolicyError("invalid");
        used = true; assert(ctx);
        if (JSON.stringify(policy.read()) !== image || row(r)) throw new HubGroupPolicyError("conflict");
        record(r, actor, "group-resource.admin-granted", ctx, { source: "manual", approval: "explicit-admin", selfServicePermission: "not-required" });
        db.prepare("INSERT INTO hub_group_resources VALUES(?,?,'manual','active',1)").run(keyOf(r), JSON.stringify(r));
        assert(ctx);
      } };
    },
    check(input: HubGroupResource, incoming: GroupCheckContext) { return check(input, incoming); },
    /** Caller must freshly authenticate the configured administrator and confirm the exact resource. */
    resume(input: HubGroupResource, actor: PersonKey, incoming: GroupCheckContext) { return check(input, incoming, actor); },
    /** Exact confirmed batch narrowing. Caller owns the outer same-DB policy/version transaction and administrator check. */
    suspend(input: HubGroupResource, actor: PersonKey, incoming: GroupCheckContext): void {
      const r = capture(input), who = validated(person, actor), ctx = snapshotContext(incoming);
      if (!db.inTransaction) throw new HubGroupPolicyError("invalid");
      assert(ctx); const p = policy.read(), before = row(r);
      if (!before || p.state === "never-enabled" || who.realm !== p.realm || r.owner.realm !== p.realm) throw new HubGroupPolicyError("invalid");
      update(before, "suspended", who, ctx);
    },
    /** Same outer transaction as a confirmed switch-off: policy off/on never silently resumes group resources. */
    suspendAll(incoming: GroupCheckContext): number {
      const ctx = snapshotContext(incoming);
      return db.transaction(() => {
        assert(ctx); policy.read(); let changed = 0;
        const rows = db.prepare("SELECT body FROM hub_group_resources WHERE source='group' AND state='active'").all() as { body: string }[];
        for (const raw of rows) {
          const r = capture(parseStrictJson(raw.body) as HubGroupResource), before = row(r)!;
          update(before, "suspended", r.owner, ctx); changed++;
        }
        return changed;
      }).immediate();
    },
  };
}
