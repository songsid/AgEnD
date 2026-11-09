/** Sealed local-admin policy confirmation. Composed only after actual pairing/publication enrollment gates are complete. */
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type { HubAuditStore } from "../audit/index.js";
import type { HubDirectory } from "../directory/types.js";
import type { HubTransportStore } from "../store.js";
import type { HubActor, PersonKey } from "../types.js";
import { personKeyString } from "../identity.js";
import { person, validated } from "../validation.js";
import { createHubGroupAdminBoundary } from "./admin-context.js";
import { createHubGroupAdminReads } from "./admin-read.js";
import { createHubGroupImpactInventory } from "./impact-inventory.js";
import { readHubGroupImpactFacts } from "./admin-facts.js";
import { buildHubGroupImpact } from "./admin-impact.js";
import { createHubGroupResources } from "./resources.js";
import { HubGroupPolicyError, type HubGroupPolicyBinding, type HubGroupPolicyStore } from "./store.js";
import { parseGroupPolicy } from "./model.js";
import type { HubGroupAdminInventory } from "./admin-inventory.js";
import type { HubGroupAuthorization } from "./authorization.js";
import { applyRequest, previewRequest, resolveRequest, type GroupAdminContext, type GroupApplyResponse,
  type GroupPreviewResponse, type HubGroupAdminControl } from "./admin-dto.js";

type Failure = Extract<GroupPreviewResponse, { ok: false }>["code"];
class Refusal extends Error { constructor(readonly code: Failure) { super(code); } }
class ExpiredPreview extends Error {}
interface Candidate {
  sessionId: string; raw: string; canonical: string; before: string; epoch: number;
  inventory: string; facts: string; impact: string; created: number; expiresAt: number;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function synchronous(result: unknown): void {
  if (result && typeof (result as { then?: unknown }).then === "function") {
    void Promise.resolve(result).catch(() => undefined); throw new HubGroupPolicyError("audit");
  }
}
function failure(error: unknown): Failure | null {
  if (error instanceof Refusal) return error.code;
  if (error instanceof HubGroupPolicyError) return error.code === "conflict" || error.code === "unsupported" || error.code === "invalid" ? error.code : "unknown";
  return null;
}
export function createHubGroupAdminControl(options: {
  db: Database.Database; audit: Pick<HubAuditStore, "appendInTransaction">; directory: HubDirectory; administrator: PersonKey;
  transport: Pick<HubTransportStore, "read">; inventory: HubGroupAdminInventory; authorization: Pick<HubGroupAuthorization, "resume">;
  policy(): HubGroupPolicyStore; binding(): HubGroupPolicyBinding; current(): boolean; version(): number;
  /** Synchronous required transport writer in this exact DB transaction, with no socket effects. */
  advanceAuthorization(database: Database.Database): void;
  refreshAuthorization(): void; now?: () => number;
}) {
  const { db, audit, directory, inventory, policy: policyOf, binding, version: versionOf, advanceAuthorization, refreshAuthorization } = options;
  const administrator = validated(person, options.administrator), clock = options.now ?? Date.now, current = options.current;
  let closed = false, working = 0;
  const alive = () => { try { return !closed && current() === true; } catch { return false; } };
  const boundary = createHubGroupAdminBoundary({ administrator, current: alive });
  const reads = createHubGroupAdminReads({ ...options, administrator, current: alive });
  const inventoryOf = createHubGroupImpactInventory({ ...options, administrator, current: alive, now: clock });
  const candidates = new Map<string, Candidate>();
  const now = () => {
    const value = clock(); if (!Number.isSafeInteger(value) || value < 0) throw new Refusal("unknown"); return value;
  };
  const version = () => {
    const value = versionOf(); if (!Number.isSafeInteger(value) || value < 0) throw new Refusal("unknown"); return value;
  };
  const prune = () => { const at = now(); for (const [key, c] of candidates) if (at < c.created || at >= c.expiresAt) candidates.delete(key); };
  const record = (ctx: GroupAdminContext, actor: Extract<HubActor, { kind: "directory" }>, action: string,
    result: "held" | "completed", policyRevision: number, payload: unknown) => {
    if (!db.inTransaction) throw new HubGroupPolicyError("invalid");
    const id = randomUUID(), at = now(), body = JSON.stringify({ policyRevision, payload });
    synchronous(audit.appendInTransaction({ id, at, sequence: 0, requestId: ctx.requestId, actor: { kind: "person", person: actor.person },
      action, result, policyVersion: policyRevision, reasonCode: createHash("sha256").update(body).digest("hex") }, db));
    boundary.assertCurrent(ctx); db.prepare("INSERT INTO hub_group_events VALUES(?,?,?)").run(id, body, at);
  };
  const prepare = async (input: unknown, ctx: GroupAdminContext, actor: Extract<HubActor, { kind: "directory" }>) => {
    boundary.assertCurrent(ctx);
    if (db.inTransaction) throw new Refusal("invalid");
    if (directory.realm !== administrator.realm || directory.groupPolicy !== "ad-direct-guid" || !directory.resolvePolicyGroup || !directory.readPolicyGroups) throw new Refusal("unsupported");
    if (binding().kind !== "ready") throw new Refusal("repair-required");
    const next = parseGroupPolicy(input), selected = policyOf(), before = selected.read(), serialized = JSON.stringify(before), epoch = version();
    if (next.revision !== before.revision) throw new Refusal("conflict");
    if (next.realm !== before.realm || next.generation !== before.generation
      || (before.state !== "never-enabled" && next.state === "never-enabled") || (before.state === "never-enabled" && next.state === "suspended")) throw new Refusal("invalid");
    const snapshot = inventoryOf.snapshot(), deadline = now() + 20_000;
    const assertPolicy = () => {
      boundary.assertCurrent(ctx);
      if (binding().kind !== "ready" || policyOf() !== selected || JSON.stringify(selected.read()) !== serialized || version() !== epoch) throw new Refusal("conflict");
    };
    const assertSnapshot = () => {
      assertPolicy(); if (inventoryOf.snapshot().fingerprint !== snapshot.fingerprint) throw new Refusal("conflict");
    };
    const canonical = parseGroupPolicy(next);
    for (const rule of canonical.groups) {
      assertPolicy(); if (now() >= deadline) throw new Refusal("unknown");
      let found;
      try { found = await directory.resolvePolicyGroup(rule.dn); } catch { throw new Refusal("unknown"); }
      assertPolicy();
      if (!found.ok) throw new Refusal(found.reason === "unknown" ? "unknown" : found.reason === "unsupported" ? "unsupported" : "group-mismatch");
      if (personKeyString(validated(person, found.group.key)) !== personKeyString(rule.group)) throw new Refusal("group-mismatch");
      rule.dn = validated(resolveRequest, { dn: found.group.dn }).dn;
    }
    const observed = await readHubGroupImpactFacts({ directory, people: snapshot.people, now, deadline, assertCurrent: assertPolicy });
    const fresh = await boundary.authenticate(ctx);
    if (fresh.sessionId !== actor.sessionId) throw new Refusal("conflict");
    assertSnapshot();
    const plan = buildHubGroupImpact({ before, next: canonical, administrator, ...snapshot, facts: observed.facts });
    return { selected, before, serialized, next, canonical, epoch, snapshot, observed, plan, assertPolicy, assertSnapshot };
  };
  const preview: HubGroupAdminControl["preview"] = async (input, incoming): Promise<GroupPreviewResponse> => {
    const request = validated(previewRequest, input), { ctx, actor } = await boundary.begin(incoming);
    if (working >= 2) return { ok: false, code: "unknown" };
    working++;
    try {
      prune(); const p = await prepare(request.policy, ctx, actor);
      for (const [key, c] of candidates) if (c.sessionId === actor.sessionId) candidates.delete(key);
      if (candidates.size >= 16) return { ok: false, code: "unknown" };
      const created = now(), expiresAt = created + 120_000;
      const candidate: Candidate = { sessionId: actor.sessionId, raw: JSON.stringify(p.next), canonical: JSON.stringify(p.canonical), before: p.serialized,
        epoch: p.epoch, inventory: p.snapshot.fingerprint, facts: p.observed.semantic, impact: JSON.stringify(p.plan.impact), created, expiresAt };
      const previewDigest = digest({ nonce: randomUUID(), ...candidate }); candidates.set(previewDigest, candidate);
      // The outward response shares no mutable policy/impact object with the sealed server candidate.
      return { ok: true, previewDigest, expiresAt, policyRevision: p.before.revision, authorizationVersion: p.epoch, impact: structuredClone(p.plan.impact) };
    } catch (error) { const code = failure(error); if (code) return { ok: false, code }; throw error; }
    finally { working--; }
  };
  const apply: HubGroupAdminControl["apply"] = async (input, incoming): Promise<GroupApplyResponse> => {
    const request = validated(applyRequest, input), { ctx, actor } = await boundary.begin(incoming);
    if (working >= 2) return { ok: false, code: "unknown" };
    working++;
    try {
      const candidate = candidates.get(request.previewDigest); candidates.delete(request.previewDigest); prune();
      if (!candidate || candidate.sessionId !== actor.sessionId || candidate.raw !== JSON.stringify(request.policy)) return { ok: false, code: "stale-preview" };
      if (now() < candidate.created || now() >= candidate.expiresAt) return { ok: false, code: "expired" };
      const assertUnexpired = () => {
        const at = now(); if (at < candidate.created || at >= candidate.expiresAt) throw new ExpiredPreview();
      };
      const p = await prepare(request.policy, ctx, actor);
      assertUnexpired();
      if (candidate.before !== p.serialized || candidate.epoch !== p.epoch || candidate.inventory !== p.snapshot.fingerprint) return { ok: false, code: "conflict" };
      if (candidate.canonical !== JSON.stringify(p.canonical) || candidate.facts !== p.observed.semantic || candidate.impact !== JSON.stringify(p.plan.impact)) {
        db.transaction(() => {
          p.assertSnapshot(); record(ctx, actor, "group-policy.preview-stale", "held", p.before.revision,
            { expectedFacts: candidate.facts, observed: [...p.observed.facts], impact: p.plan.impact }); p.assertSnapshot();
        }).immediate();
        return { ok: false, code: "stale-preview" };
      }
      let changed = false;
      const saved = db.transaction(() => {
        assertUnexpired(); p.assertSnapshot();
        const resources = createHubGroupResources({ db, policy: p.selected, audit, current: alive, now });
        const lifecycleOf = (resource: Parameters<typeof inventory.ledger>[0]) => {
          const row = inventory.ledger(resource); return row ? { source: row.source, state: row.state, revision: row.revision } : null;
        };
        for (const resource of p.plan.capture) {
          if (lifecycleOf(resource) !== null) throw new Refusal("conflict");
          resources.captureManual(resource, ctx, actor.person);
        }
        const result = p.selected.replace(p.canonical, actor.person, ctx);
        for (const resource of p.plan.suspend) {
          const original = p.snapshot.resources.find(row => JSON.stringify(row.resource) === JSON.stringify(resource));
          const expected = original?.lifecycle ?? { source: "manual", state: "active", revision: 1 };
          if (!original || JSON.stringify(lifecycleOf(resource)) !== JSON.stringify(expected)) throw new Refusal("conflict");
          resources.suspend(resource, actor.person, ctx);
        }
        record(ctx, actor, "group-policy.impact-checked", p.plan.impact.held.length ? "held" : "completed", result.revision,
          { observed: [...p.observed.facts], impact: p.plan.impact });
        boundary.assertCurrent(ctx);
        const assertCommitted = () => {
          boundary.assertCurrent(ctx); assertUnexpired();
          if (binding().kind !== "ready" || policyOf() !== p.selected || JSON.stringify(p.selected.read()) !== JSON.stringify(result)
            || inventoryOf.snapshot().ordinaryFingerprint !== p.snapshot.ordinaryFingerprint) throw new Refusal("conflict");
          const captured = new Set(p.plan.capture.map(r => JSON.stringify(r))), suspended = new Set(p.plan.suspend.map(r => JSON.stringify(r)));
          for (const row of p.snapshot.resources) {
            const key = JSON.stringify(row.resource), before = row.lifecycle ?? (captured.has(key) ? { source: "manual" as const, state: "active" as const, revision: 1 } : null);
            const expected = before && suspended.has(key) ? { ...before, state: "suspended", revision: before.revision + 1 } : before;
            const actual = inventory.ledger(row.resource);
            if (JSON.stringify(actual ? { source: actual.source, state: actual.state, revision: actual.revision } : null) !== JSON.stringify(expected)) throw new Refusal("conflict");
          }
        };
        assertCommitted(); if (version() !== p.epoch) throw new Refusal("conflict");
        changed = JSON.stringify(result) !== p.serialized || p.plan.capture.length > 0 || p.plan.suspend.length > 0;
        if (changed) {
          synchronous(advanceAuthorization(db));
          if (version() !== p.epoch + 1) throw new Refusal("conflict");
        }
        assertCommitted(); return result;
      }).immediate();
      if (changed) synchronous(refreshAuthorization());
      boundary.assertCurrent(ctx); return { ok: true, policyRevision: saved.revision, state: saved.state };
    } catch (error) { if (error instanceof ExpiredPreview) return { ok: false, code: "expired" };
      const code = failure(error); if (code) return { ok: false, code: code === "invalid" ? "stale-preview" : code }; throw error; }
    finally { working--; }
  };
  return { read: reads.read, resolve: reads.resolve, resume: reads.resume, preview, apply,
    close(): void { closed = true; candidates.clear(); boundary.close(); reads.close(); } };
}
