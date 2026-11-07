/** Durable foundation only: not composed or exposed by a route until action fences and the enable preview land. */
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { HubMigration } from "../db.js";
import type { HubAuditStore } from "../audit/index.js";
import type { HubAuditRecord, PersonKey } from "../types.js";
import type { HubDirectory } from "../directory/types.js";
import type { PolicyGroupFacts } from "../directory/groups.js";
import { identifier, parseStrictJson, person, validated } from "../validation.js";
import { evaluateGroupPolicy, initialGroupPolicy, parseGroupCapability, parseGroupPolicy, type GroupCapability, type HubGroupDecision, type HubGroupPolicy } from "./model.js";

export class HubGroupPolicyError extends Error {
  constructor(readonly code: "unavailable" | "conflict" | "unsupported" | "invalid" | "audit") { super(`group_policy_${code}`); }
}
export function groupPolicyMigration(hubId: string, realm: string, generation: string): HubMigration {
  const initial = JSON.stringify(initialGroupPolicy(realm, generation)), hub = validated(identifier, hubId);
  return { component: "s5-group-policy", version: 1, up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS hub_group_policy(singleton INTEGER PRIMARY KEY CHECK(singleton=1), hub_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hub_group_events(id TEXT PRIMARY KEY REFERENCES hub_audit(id) ON DELETE CASCADE, body TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS hub_group_events_at ON hub_group_events(at);`);
    db.prepare("INSERT OR IGNORE INTO hub_group_policy VALUES(1, ?, ?)").run(hub, initial);
  } };
}
export type HubGroupPolicyBinding = { readonly kind: "ready" } | {
  readonly kind: "repair-required";
  /** Only an intact, same-Hub/same-realm never-enabled record may preserve legacy behavior. */
  readonly legacy: boolean;
};
/** Read-only composition probe: a directory-generation change must not take sign-in/admin repair down. */
export function inspectHubGroupPolicyBinding(db: Database.Database, hubId: string, realm: string, generation: string): HubGroupPolicyBinding {
  try {
    const binding = initialGroupPolicy(realm, generation);
    const row = db.prepare("SELECT hub_id, body FROM hub_group_policy WHERE singleton=1").get() as { hub_id: string; body: string } | undefined;
    if (!row || row.hub_id !== validated(identifier, hubId)) return { kind: "repair-required", legacy: false };
    const policy = parseGroupPolicy(parseStrictJson(row.body));
    if (policy.realm !== binding.realm) return { kind: "repair-required", legacy: false };
    if (policy.generation === binding.generation) return { kind: "ready" };
    return { kind: "repair-required", legacy: policy.state === "never-enabled" };
  } catch { return { kind: "repair-required", legacy: false }; }
}

const resources = z.strictObject({ fleetId: identifier.optional(), exposureId: identifier.optional(), messageId: identifier.optional(), roomId: identifier.optional(),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional() });
export interface GroupCheckContext {
  requestId: string;
  resource?: z.infer<typeof resources>;
  /** Fresh caller/session and server-generation fence. Not a role asserted by browser input. */
  current(): boolean;
}
export interface HubGroupPolicyStore {
  read(): HubGroupPolicy;
  /** Caller must freshly require the configured Hub admin and confirm the exact effective-access preview first. */
  replace(input: unknown, actor: PersonKey, context: GroupCheckContext): HubGroupPolicy;
  /** No cache. Result does not perform suspension; only authoritative negative may be used for that later. */
  check(subject: PersonKey, capability: GroupCapability, context: GroupCheckContext): Promise<HubGroupDecision>;
}
export function createHubGroupPolicyStore(options: {
  db: Database.Database; hubId: string; realm: string; generation: string; directory: HubDirectory;
  audit: Pick<HubAuditStore, "appendInTransaction">; current(): boolean; now?: () => number;
}): HubGroupPolicyStore {
  const { db, directory, audit } = options, hubId = validated(identifier, options.hubId);
  const binding = initialGroupPolicy(options.realm, options.generation), current = options.current, now = options.now ?? Date.now;
  if (directory.realm !== binding.realm) throw new HubGroupPolicyError("unavailable");
  const inflight = new Map<string, number>(); let total = 0;
  const assert = (caller: () => boolean = () => true) => { if (current() !== true || caller() !== true) throw new HubGroupPolicyError("unavailable"); };
  const read = (): HubGroupPolicy => {
    assert();
    const row = db.prepare("SELECT hub_id, body FROM hub_group_policy WHERE singleton=1").get() as { hub_id: string; body: string } | undefined;
    if (!row || row.hub_id !== hubId) throw new HubGroupPolicyError("unavailable");
    let policy: HubGroupPolicy;
    try { policy = parseGroupPolicy(parseStrictJson(row.body)); } catch { throw new HubGroupPolicyError("unavailable"); }
    if (policy.realm !== binding.realm || policy.generation !== binding.generation) throw new HubGroupPolicyError("unavailable");
    return policy;
  };
  const context = (input: GroupCheckContext) => ({ requestId: validated(identifier, input.requestId),
    resource: validated(resources, input.resource ?? {}), current: input.current });
  const record = (actor: HubAuditRecord["actor"], action: string, result: HubAuditRecord["result"], p: HubGroupPolicy, ctx: ReturnType<typeof context>, payload: unknown) => {
    const id = randomUUID(), at = now(), body = JSON.stringify({ ...ctx.resource, generation: binding.generation, policyRevision: p.revision, payload });
    const { revision: _resourceRevision, ...resourceIds } = ctx.resource;
    const output: unknown = audit.appendInTransaction({ id, sequence: 0, at, requestId: ctx.requestId, actor, action, result, policyVersion: p.revision,
      ...resourceIds, reasonCode: createHash("sha256").update(body).digest("hex") }, db);
    if (output && (typeof output === "object" || typeof output === "function") && typeof (output as { then?: unknown }).then === "function") {
      try { (output as PromiseLike<unknown>).then(undefined, () => undefined); } catch { /* refused either way */ }
      throw new HubGroupPolicyError("audit");
    }
    assert(ctx.current);
    db.prepare("INSERT INTO hub_group_events VALUES(?, ?, ?)").run(id, body, at);
  };
  read(); // Missing/corrupt state is not an excuse to restore permissive legacy behavior.
  return { read, replace(input, actor, incoming) {
    const next = parseGroupPolicy(input), who = validated(person, actor), ctx = context(incoming);
    if (who.realm !== binding.realm || next.realm !== binding.realm || next.generation !== binding.generation) throw new HubGroupPolicyError("invalid");
    if ((next.state === "enabled" || next.groups.length > 0) && directory.groupPolicy !== "ad-direct-guid") throw new HubGroupPolicyError("unsupported");
    return db.transaction(() => {
      assert(ctx.current);
      const before = read();
      if (before.revision !== next.revision || before.revision === Number.MAX_SAFE_INTEGER) throw new HubGroupPolicyError("conflict");
      if ((before.state !== "never-enabled" && next.state === "never-enabled") || (before.state === "never-enabled" && next.state === "suspended")) throw new HubGroupPolicyError("invalid");
      if (JSON.stringify(before) === JSON.stringify(next)) return before;
      const saved = { ...next, revision: before.revision + 1 };
      record({ kind: "person", person: who }, "group-policy.changed", "completed", saved, ctx, saved);
      const updated = db.prepare("UPDATE hub_group_policy SET body=? WHERE singleton=1 AND hub_id=? AND body=?").run(JSON.stringify(saved), hubId, JSON.stringify(before));
      if (updated.changes !== 1) throw new HubGroupPolicyError("conflict");
      return saved;
    }).immediate();
  }, async check(subject, capability, incoming) {
    // Snapshot validated caller-owned data before awaiting any directory operation.
    const who = validated(person, subject), cap = parseGroupCapability(capability), ctx = context(incoming);
    assert(ctx.current);
    const before = read();
    if (before.state === "never-enabled") return evaluateGroupPolicy(before, who, cap, { kind: "unknown" });
    const key = `${who.realm}/${who.objectId}`, count = inflight.get(key) ?? 0;
    if (count >= 4 || total >= 32) throw new HubGroupPolicyError("unavailable");
    inflight.set(key, count + 1); total++;
    try {
      const started = now(); let facts: PolicyGroupFacts = { kind: "unknown" };
      if (before.state === "enabled" && directory.groupPolicy === "ad-direct-guid" && directory.realm === binding.realm) {
        try { facts = await directory.readPolicyGroups?.(Object.freeze({ ...who })) ?? { kind: "unknown" }; } catch { /* no partial/negative proof */ }
      }
      assert(ctx.current);
      // No typed implementation may turn stale or future directory facts into authorization.
      if (facts.kind !== "unknown" && (facts.observedAt < started || facts.observedAt > now())) facts = { kind: "unknown" };
      return db.transaction(() => {
        assert(ctx.current);
        const p = read();
        if (p.revision !== before.revision) throw new HubGroupPolicyError("conflict");
        const decision = evaluateGroupPolicy(p, who, cap, facts);
        record({ kind: "person", person: who }, `group-policy.${cap.replaceAll("_", "-")}`, decision.outcome === "allow" ? "allowed" : decision.outcome === "unknown" ? "held" : "denied", p, ctx,
          { person: who, capability: cap, ...decision });
        return decision;
      }).immediate();
    } finally {
      const left = (inflight.get(key) ?? 1) - 1;
      if (left) inflight.set(key, left); else inflight.delete(key);
      total--;
    }
  } };
}
