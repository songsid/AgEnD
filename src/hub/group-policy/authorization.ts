/** Internal action permits. No routes, startup migrations or enable switch are installed by this module. */
import type Database from "better-sqlite3";
import type { HubAuditStore } from "../audit/index.js";
import type { HubActor, PersonKey } from "../types.js";
import { personKeyString } from "../identity.js";
import { identifier, person, validated } from "../validation.js";
import { createHubGroupResources, HubGroupEnrollmentRefusal, parseHubGroupResource, type HubGroupResource, type HubGroupResourceView } from "./resources.js";
import { HubGroupPolicyError, type GroupCheckContext, type HubGroupPolicyBinding, type HubGroupPolicyStore } from "./store.js";

export class HubGroupAuthorizationError extends HubGroupPolicyError {
  constructor(readonly reason: "denied" | "held" | "resume-required" | "repair-required") { super("unavailable"); }
}
/** An operation must assert again immediately before committing, dispatching or disclosing protected data. */
export interface HubGroupPermit {
  readonly source: "legacy" | "manual" | "group";
  assertCurrent(): void;
}
/** Commit in the same transaction as the actual new fleet/publication, after ordinary consent/quota checks. */
export interface HubGroupEnrollmentPermit extends HubGroupPermit {
  readonly maxFleets: number;
  commit(database: Database.Database): void;
}
export interface HubGroupAuthorizationOptions {
  db: Database.Database;
  administrator: PersonKey;
  /** Lazy: a repair-required never-enabled binding must not construct/read the strict mismatched store. */
  /** Stable per composition generation. Replacing the store invalidates outstanding permits. */
  policy(): HubGroupPolicyStore;
  binding(): HubGroupPolicyBinding;
  audit: Pick<HubAuditStore, "appendInTransaction">;
  /** Server/composition lifetime only; per-request/session/link fences belong in the context. */
  current(): boolean;
  version(): number;
  /** Must synchronously advance the transport version on db in this same transaction; no socket effects. */
  advanceAuthorization(db: Database.Database, resource: HubGroupResource): void;
  /** Synchronous socket refresh only after the resource transaction returns successfully. */
  refreshAuthorization(): void;
  now?: () => number;
}
function synchronous(result: unknown): void {
  if (result && typeof (result as { then?: unknown }).then === "function") {
    void Promise.resolve(result).catch(() => undefined); throw new HubGroupPolicyError("audit");
  }
}
export function createHubGroupAuthorization(options: HubGroupAuthorizationOptions) {
  const { db, policy: policyOf, binding: bindingOf, audit, current, version: versionOf,
    advanceAuthorization, refreshAuthorization, now } = options;
  const administrator = validated(person, options.administrator);
  let closed = false;
  const alive = () => !closed && current() === true;
  const assert = (caller: () => boolean) => {
    if (!alive() || caller() !== true) throw new HubGroupPolicyError("unavailable");
  };
  const version = () => {
    const value = versionOf();
    if (!Number.isSafeInteger(value) || value < 0) throw new HubGroupPolicyError("unavailable");
    return value;
  };
  const capture = (incoming: GroupCheckContext) => {
    const caller = incoming.current.bind(incoming);
    return { requestId: validated(identifier, incoming.requestId), current: () => alive() && caller() === true,
      ...(incoming.resource ? { resource: { ...incoming.resource } } : {}) };
  };
  const sameRow = (a: HubGroupResourceView | null, b: HubGroupResourceView) => a !== null
    && a.state === "active" && a.revision === b.revision && a.source === b.source
    && JSON.stringify(a.resource) === JSON.stringify(b.resource);

  const run = async (input: HubGroupResource, incoming: GroupCheckContext,
    operation: "check" | "enroll" | "resume" | "asker", requireAdmin?: () => Promise<HubActor>): Promise<HubGroupPermit> => {
    // Capture caller-owned inputs and callbacks before any directory or administrator await.
    const resource = parseHubGroupResource(input), ctx = capture(incoming);
    assert(ctx.current);
    if (resource.kind === "asker" && (resource.id !== resource.owner.objectId || resource.revision !== 1)) throw new HubGroupPolicyError("invalid");
    if (resource.owner.realm !== administrator.realm) throw new HubGroupAuthorizationError("denied");
    const epoch = version();
    if (db.inTransaction) throw new HubGroupPolicyError("invalid"); // Never hold an outer SQL transaction across LDAP.
    const binding = bindingOf();
    if (binding.kind !== "ready") {
      if (binding.kind !== "repair-required" || !binding.legacy || operation === "resume") throw new HubGroupAuthorizationError("repair-required");
      const fingerprint = binding.fingerprint;
      if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) throw new HubGroupAuthorizationError("repair-required");
      return Object.freeze({ source: "legacy" as const, assertCurrent() {
        assert(ctx.current); const next = bindingOf();
        if (next.kind !== "repair-required" || !next.legacy || next.fingerprint !== fingerprint || version() !== epoch) throw new HubGroupPolicyError("conflict");
      } });
    }
    const policy = policyOf(), before = policy.read(), serializedPolicy = JSON.stringify(before);
    if (before.realm !== administrator.realm) throw new HubGroupPolicyError("unavailable");
    const policyCurrent = () => {
      assert(ctx.current);
      if (bindingOf().kind !== "ready" || policyOf() !== policy || JSON.stringify(policy.read()) !== serializedPolicy) throw new HubGroupPolicyError("conflict");
    };
    if (before.state === "never-enabled") {
      if (operation === "resume") throw new HubGroupPolicyError("invalid");
      return Object.freeze({ source: "legacy" as const, assertCurrent() {
        policyCurrent(); if (version() !== epoch) throw new HubGroupPolicyError("conflict");
      } });
    }
    let actor: PersonKey | undefined;
    if (operation === "resume") {
      if (!requireAdmin) throw new HubGroupPolicyError("invalid");
      const authenticated = await requireAdmin();
      policyCurrent();
      if (authenticated.kind !== "directory" || personKeyString(validated(person, authenticated.person)) !== personKeyString(administrator)) throw new HubGroupAuthorizationError("denied");
      actor = { ...administrator };
      if (version() !== epoch) throw new HubGroupPolicyError("conflict");
    }
    let invalidated = false;
    const resources = createHubGroupResources({ db, policy, audit, current: alive, now, invalidate(tx, changed) {
      if (tx !== db || !db.inTransaction) throw new HubGroupPolicyError("invalid");
      const previous = version();
      // A resume may advance only its captured epoch. This check is inside the lifecycle
      // transaction: a raced membership read or reentrant audit rolls back the pending broadening.
      if (operation === "resume" && previous !== epoch) throw new HubGroupPolicyError("conflict");
      synchronous(advanceAuthorization(tx, parseHubGroupResource(changed)));
      if (version() <= previous) throw new HubGroupPolicyError("unavailable");
      invalidated = true;
    } });
    let outcome: "allow" | "deny" | "held" | "resume-required";
    if (operation === "asker" && !resources.read(resource)) {
      // Only canonical asker provenance is created on first use. Fleet/exposure enrollment
      // remains the explicit owner-consent path; it can never be inferred from a question.
      try { await resources.register(resource, ctx); }
      catch (error) {
        // Two first actions can race. A newly present row must pass another fresh check;
        // neither a conflict nor a previous positive result stands in for that check.
        if (error instanceof HubGroupEnrollmentRefusal) throw new HubGroupAuthorizationError(error.outcome);
        if (!(error instanceof HubGroupPolicyError) || error.code !== "conflict" || !resources.read(resource)) throw error;
      }
      outcome = (await resources.check(resource, ctx)).outcome;
    } else if (operation === "enroll") {
      await resources.register(resource, ctx); outcome = "allow";
    } else {
      const decision = actor ? await resources.resume(resource, actor, ctx) : await resources.check(resource, ctx);
      outcome = decision.outcome;
    }
    // No finally refresh: a thrown/audit-failed transaction never publishes an authorization refresh.
    if (invalidated) {
      if (db.inTransaction) throw new HubGroupPolicyError("invalid");
      synchronous(refreshAuthorization());
    }
    if (outcome !== "allow") throw new HubGroupAuthorizationError(outcome === "deny" ? "denied" : outcome);
    policyCurrent();
    const permittedVersion = version();
    if (!invalidated && permittedVersion !== epoch) throw new HubGroupPolicyError("conflict");
    const record = resources.read(resource);
    if (!record || record.state !== "active") throw new HubGroupPolicyError("conflict");
    return Object.freeze({ source: record.source, assertCurrent() {
      policyCurrent();
      if (version() !== permittedVersion || !sameRow(resources.read(resource), record)) throw new HubGroupPolicyError("conflict");
    } });
  };
  return {
    /** Display-only exact lifecycle projection: no directory read, allowance, audit or provenance mutation. */
    resourceState(input: HubGroupResource) {
      const resource = parseHubGroupResource(input); assert(() => true);
      if (resource.owner.realm !== administrator.realm || bindingOf().kind !== "ready") throw new HubGroupPolicyError("unavailable");
      const resources = createHubGroupResources({ db, policy: policyOf(), audit, current: alive, now }), row = resources.read(resource);
      return row ? Object.freeze({ source: row.source, state: row.state, revision: row.revision }) : null;
    },
    asker(input: PersonKey, ctx: GroupCheckContext) {
      const owner = validated(person, input);
      return run({ kind: "asker", id: owner.objectId, revision: 1, owner }, ctx, "asker");
    },
    check(resource: HubGroupResource, ctx: GroupCheckContext) { return run(resource, ctx, "check"); },
    /** Only after ordinary owner/local-consent/grant/quota checks; this creates provenance, not the actual resource. */
    enroll(resource: HubGroupResource, ctx: GroupCheckContext) { return run(resource, ctx, "enroll"); },
    /** No provenance before the actual-resource transaction. A commit attempt is consumed even if its transaction rolls back. */
    async prepareEnrollment(input: HubGroupResource, incoming: GroupCheckContext): Promise<HubGroupEnrollmentPermit> {
      const resource = parseHubGroupResource(input), ctx = capture(incoming);
      if (resource.kind === "asker") throw new HubGroupPolicyError("invalid"); // Canonical first-use askers use asker().
      assert(ctx.current);
      if (resource.owner.realm !== administrator.realm) throw new HubGroupAuthorizationError("denied");
      const epoch = version();
      if (db.inTransaction) throw new HubGroupPolicyError("invalid");
      // Legacy/repair behavior is identical to current action permits and creates no provenance.
      const selectedBinding = bindingOf();
      if (selectedBinding.kind !== "ready" || policyOf().read().state === "never-enabled") {
        const legacy = await run(resource, ctx, "enroll");
        let used = false;
        return Object.freeze({ ...legacy, maxFleets: 0, commit(database: Database.Database) {
          if (database !== db || !db.inTransaction || used) throw new HubGroupPolicyError("invalid");
          used = true; legacy.assertCurrent();
        } });
      }
      const policy = policyOf(), before = policy.read(), serialized = JSON.stringify(before);
      if (before.realm !== administrator.realm) throw new HubGroupPolicyError("unavailable");
      const assertPreparation = () => {
        assert(ctx.current);
        if (bindingOf().kind !== "ready" || policyOf() !== policy || JSON.stringify(policy.read()) !== serialized || version() !== epoch) throw new HubGroupPolicyError("conflict");
      };
      assertPreparation();
      const resources = createHubGroupResources({ db, policy, audit, current: alive, now });
      const prepared = await resources.prepareRegistration(resource, { ...ctx, current: () => {
        try { assertPreparation(); return true; } catch { return false; }
      } });
      assertPreparation(); let committed: HubGroupResourceView | null = null;
      return Object.freeze({ source: "group", maxFleets: prepared.decision.maxFleets,
        assertCurrent() {
          assertPreparation(); const row = resources.read(resource);
          if (committed ? !sameRow(row, committed) : row !== null) throw new HubGroupPolicyError("conflict");
        },
        commit(database: Database.Database) {
          assertPreparation(); prepared.commit(database); committed = resources.read(resource);
          if (!committed || committed.state !== "active") throw new HubGroupPolicyError("conflict");
          assertPreparation();
        },
      });
    },
    resume(resource: HubGroupResource, ctx: GroupCheckContext & { requireAdmin(): Promise<HubActor> }) {
      const authenticate = ctx.requireAdmin.bind(ctx);
      return run(resource, ctx, "resume", authenticate);
    },
    close(): void { closed = true; },
  };
}
export type HubGroupAuthorization = ReturnType<typeof createHubGroupAuthorization>;
