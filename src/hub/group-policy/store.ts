/** Durable policy state; composed never-enabled. Activation still requires the confirmed impact/enrollment flow. */
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { HubMigration } from "../db.js";
import type { HubAuditStore } from "../audit/index.js";
import type { HubAuditRecord, PersonKey } from "../types.js";
import type { HubDirectory } from "../directory/types.js";
import type { PolicyGroupFacts } from "../directory/groups.js";
import { identifier, person, uuid, validated } from "../validation.js";
import { GROUP_CAPABILITIES, evaluateGroupPolicy, initialGroupPolicy, parseGroupCapability, parseGroupPolicy, type GroupCapability, type HubGroupDecision, type HubGroupPolicy } from "./model.js";
import { createHubCanonicalPolicyReader, parseCanonicalPolicy, type HubCanonicalPolicy } from "../roles/read.js";
import { evaluateRolePolicy, snapshotRolePersonFacts, type RoleDecision, type RolePersonFacts } from "../roles/evaluate.js";

export class HubGroupPolicyError extends Error {
  constructor(readonly code: "unavailable" | "conflict" | "unsupported" | "invalid" | "audit") { super(`group_policy_${code}`); }
}
/** Capacity pressure is retryable; malformed/unknown directory authority remains a separate refusal. */
export class HubGroupReadOverload extends HubGroupPolicyError { constructor() { super("unavailable"); } }
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
  readonly legacy: true;
  /** Validated selected binding plus the complete stored policy; never a strict-store read. */
  readonly fingerprint: string;
} | { readonly kind: "repair-required"; readonly legacy: false };
/** Read-only composition probe: a directory-generation change must not take sign-in/admin repair down. */
export function inspectHubGroupPolicyBinding(db: Database.Database, hubId: string, realm: string, generation: string): HubGroupPolicyBinding {
  try {
    const binding = initialGroupPolicy(realm, generation);
    const row = db.prepare("SELECT hub_id, body FROM hub_group_policy WHERE singleton=1").get() as { hub_id: string; body: string } | undefined;
    if (!row || row.hub_id !== validated(identifier, hubId)) return { kind: "repair-required", legacy: false };
    const document = parseCanonicalPolicy(row.body), policy = document.policy;
    if (policy.realm !== binding.realm) return { kind: "repair-required", legacy: false };
    if (policy.generation === binding.generation) return { kind: "ready" };
    if (document.kind !== "group" || policy.state !== "never-enabled") return { kind: "repair-required", legacy: false };
    const fingerprint = createHash("sha256").update(JSON.stringify({ hubId: row.hub_id,
      realm: binding.realm, generation: binding.generation, policy })).digest("hex");
    return { kind: "repair-required", legacy: true, fingerprint };
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
export type HubOperationalPolicy = HubCanonicalPolicy["policy"];
export type HubSelfUseDecision = HubGroupDecision | RoleDecision;
/** Full canonical metadata, with the mandatory role clock fence; old injected stores remain legacy-only. */
export const readHubOperationalPolicy = (store: HubGroupPolicyStore): HubOperationalPolicy => store.authorizationPolicy?.().policy ?? store.read();
export function assertHubSelfUseDecisionCurrent(decision: HubSelfUseDecision | undefined, at: number): void {
  if (decision && "nextExpiry" in decision && decision.nextExpiry !== null && at >= decision.nextExpiry) throw new HubGroupPolicyError("conflict");
}
export interface HubGroupPolicyStore {
  read(): HubGroupPolicy;
  /** Complete canonical image for converted consumers; legacy injected drivers may omit it. */
  canonical?(): HubCanonicalPolicy;
  /** Unlike canonical(), this refuses role authority unless the real persistent clock fence is supplied. */
  authorizationPolicy?(): HubCanonicalPolicy;
  resolveEnrolmentGroup?(subject: PersonKey, group: PersonKey, dn: string, context: GroupCheckContext): Promise<boolean>;
  checkEnrolmentGroup?(subject: PersonKey, group: PersonKey, context: GroupCheckContext): Promise<boolean>;
  /** Admission only, never an allowance. Shares membership/welcome limits until the physical read settles. */
  withDirectoryRead<T>(subject: PersonKey, read: () => Promise<T>): Promise<T>;
  /** Caller must freshly require the configured Hub admin and confirm the exact effective-access preview first. */
  replace(input: unknown, actor: PersonKey, context: GroupCheckContext): HubGroupPolicy;
  /** No cache. Result does not perform suspension; only authoritative negative may be used for that later. */
  check(subject: PersonKey, capability: GroupCapability, context: GroupCheckContext): Promise<HubSelfUseDecision>;
  /**
   * S-89 welcome DISPLAY only: the current policy and the three pure decisions from ONE fresh membership read (no read when never
   * enabled). No audit, registration, suspension or permit; never reusable as authority — every action still calls `check` or a
   * permit. Shares `check`'s in-flight bounds and freshness rule; unknown stays unknown.
   */
  describe(subject: PersonKey, context: GroupCheckContext): Promise<{ readonly policy: HubOperationalPolicy; readonly decisions: Readonly<Record<GroupCapability, HubSelfUseDecision>> }>;
}
export function createHubGroupPolicyStore(options: {
  db: Database.Database; hubId: string; realm: string; generation: string; directory: HubDirectory;
  audit: Pick<HubAuditStore, "appendInTransaction">; current(): boolean; now?: () => number;
  roles?: { root: PersonKey; assertAuthorizationTime(): void };
}): HubGroupPolicyStore {
  const { db, directory, audit } = options, hubId = validated(identifier, options.hubId);
  const binding = initialGroupPolicy(options.realm, options.generation), current = options.current, now = options.now ?? Date.now;
  if (directory.realm !== binding.realm) throw new HubGroupPolicyError("unavailable");
  const inflight = new Map<string, number>(); let total = 0;
  const assert = (caller: () => boolean = () => true) => { if (current() !== true || caller() !== true) throw new HubGroupPolicyError("unavailable"); };
  const reader = createHubCanonicalPolicyReader({ db, hubId, realm: binding.realm, generation: binding.generation, current });
  const canonical = (): HubCanonicalPolicy => {
    try { return reader(); } catch { throw new HubGroupPolicyError("unavailable"); }
  };
  const read = (): HubGroupPolicy => {
    const value = canonical();
    if (value.kind !== "group") throw new HubGroupPolicyError("unavailable");
    return value.policy;
  };
  const root = options.roles ? validated(person, options.roles.root) : null;
  const roleClock = options.roles?.assertAuthorizationTime.bind(options.roles);
  const eligibilityMethod = directory.checkEligibility, groupsMethod = directory.readPolicyGroups;
  let latestRoleTime = 0, roleClockRetired = false;
  const authorizationPolicy = (): HubCanonicalPolicy => {
    const selected = canonical();
    if (selected.kind === "roles") {
      if (!root || root.realm !== binding.realm || !roleClock || directory.realm !== binding.realm
        || directory.checkEligibility !== eligibilityMethod || directory.readPolicyGroups !== groupsMethod) throw new HubGroupPolicyError("unavailable");
      const at = now();
      if (!Number.isSafeInteger(at) || at < latestRoleTime) roleClockRetired = true;
      if (roleClockRetired) throw new HubGroupPolicyError("unavailable");
      latestRoleTime = at;
      const result: unknown = roleClock();
      if (result && typeof (result as { then?: unknown }).then === "function") {
        void Promise.resolve(result).catch(() => undefined); throw new HubGroupPolicyError("unavailable");
      }
      if (canonical().raw !== selected.raw) throw new HubGroupPolicyError("conflict");
    }
    return selected;
  };
  const operational = () => authorizationPolicy().policy;
  const evaluate = (p: HubOperationalPolicy, who: PersonKey, cap: GroupCapability, facts: RolePersonFacts): HubSelfUseDecision =>
    "rolesActive" in p ? evaluateRolePolicy(p, who, cap, null, { subject: facts }, now(), root!)
      : evaluateGroupPolicy(p, who, cap, facts.kind === "eligible" ? { kind: "unknown" } : facts);
  const observe = async (p: HubOperationalPolicy, who: PersonKey, caps: readonly GroupCapability[]): Promise<RolePersonFacts> => {
    if (p.state !== "enabled") return { kind: "unknown" };
    const started = now(); let facts: RolePersonFacts = { kind: "unknown" };
    const needsGroups = !("rolesActive" in p) || p.assignments.some(a => a.subject.kind === "group"
      && a.startsAt <= started && (a.expiresAt === null || a.expiresAt > started)
      && p.roles.find(r => r.id === a.roleId)!.permissions.some(c => caps.includes(c as GroupCapability)));
    try {
      if (needsGroups && directory.groupPolicy === "ad-direct-guid") facts = await groupsMethod?.call(directory, Object.freeze({ ...who })) ?? { kind: "unknown" };
      else if (!needsGroups && eligibilityMethod) {
        const result = await eligibilityMethod.call(directory, Object.freeze({ ...who }));
        facts = result.eligible === true ? { kind: "eligible", person: validated(person, result.person.key), observedAt: now() }
          : result.eligible === false && (result.reason === "gone" || result.reason === "disabled")
            ? { kind: "ineligible", person: who, reason: result.reason, observedAt: now() } : { kind: "unknown" };
      }
    } catch { /* Unknown never supplies negative authority. */ }
    const snapshot = snapshotRolePersonFacts(facts, who, now());
    return snapshot && snapshot.observedAt >= started ? snapshot : { kind: "unknown" };
  };
  const context = (input: GroupCheckContext) => ({ requestId: validated(identifier, input.requestId),
    resource: validated(resources, input.resource ?? {}), current: input.current });
  const record = (actor: HubAuditRecord["actor"], action: string, result: HubAuditRecord["result"], p: HubOperationalPolicy, ctx: ReturnType<typeof context>, payload: unknown) => {
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
  canonical(); // Missing/corrupt state is not an excuse to restore permissive legacy behavior.
  return { read, canonical, authorizationPolicy, async withDirectoryRead<T>(subject: PersonKey, read: () => Promise<T>): Promise<T> {
    const who = validated(person, subject); assert();
    const key = `${who.realm}/${who.objectId}`, count = inflight.get(key) ?? 0;
    if (count >= 4 || total >= 32) throw new HubGroupReadOverload();
    inflight.set(key, count + 1); total++;
    try { return await read(); }
    finally {
      const left = (inflight.get(key) ?? 1) - 1;
      if (left) inflight.set(key, left); else inflight.delete(key);
      total--;
    }
  }, async resolveEnrolmentGroup(subject, group, dn, incoming) {
    const target = validated(person, group), who = validated(person, subject), ctx = context(incoming), before = operational(); assert(ctx.current);
    if (target.realm !== binding.realm || directory.groupPolicy !== "ad-direct-guid" || !directory.resolvePolicyGroup) return false;
    return this.withDirectoryRead(who, async () => {
      let result; try { result = await directory.resolvePolicyGroup!(dn); } catch { return false; }
      assert(ctx.current); if (JSON.stringify(operational()) !== JSON.stringify(before)) throw new HubGroupPolicyError("conflict");
      return result.ok && result.group.key.realm === target.realm && result.group.key.objectId === target.objectId && result.group.dn.toLowerCase() === dn.toLowerCase();
    });
  }, async checkEnrolmentGroup(subject, group, incoming) {
    const who = validated(person, subject), target = validated(person, group), ctx = context(incoming), before = operational();
    assert(ctx.current);
    if (who.realm !== binding.realm || target.realm !== binding.realm || directory.groupPolicy !== "ad-direct-guid") return false;
    // withDirectoryRead owns physical admission. An overload remains retryable, not an authoritative scope refusal.
    return this.withDirectoryRead(who, async () => {
      const started = now(); let facts: PolicyGroupFacts;
      try { facts = await directory.readPolicyGroups?.(Object.freeze({ ...who })) ?? { kind: "unknown" }; } catch { facts = { kind: "unknown" }; }
      assert(ctx.current); if (JSON.stringify(operational()) !== JSON.stringify(before)) throw new HubGroupPolicyError("conflict");
      return facts.kind === "complete" && facts.person.realm === who.realm && facts.person.objectId === who.objectId
        && Number.isSafeInteger(facts.observedAt) && facts.observedAt >= started && facts.observedAt <= now()
        && Array.isArray(facts.groups) && facts.groups.length <= 256 && facts.groups.every(id => uuid.safeParse(id).success)
        && facts.groups.includes(target.objectId);
    });
  }, replace(input, actor, incoming) {
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
    const who = validated(person, subject), cap = parseGroupCapability(capability), ctx = context(incoming);
    assert(ctx.current); const before = operational(), image = JSON.stringify(before);
    if (before.state === "never-enabled") return evaluate(before, who, cap, { kind: "unknown" });
    return this.withDirectoryRead(who, async () => {
      const facts = await observe(before, who, [cap]); assert(ctx.current);
      return db.transaction(() => {
        assert(ctx.current); const p = operational();
        if (JSON.stringify(p) !== image) throw new HubGroupPolicyError("conflict");
        const decision = evaluate(p, who, cap, facts);
        record({ kind: "person", person: who }, `group-policy.${cap.replaceAll("_", "-")}`, decision.outcome === "allow" ? "allowed" : decision.outcome === "unknown" ? "held" : "denied", p, ctx,
          { person: who, capability: cap, ...decision });
        if (JSON.stringify(operational()) !== image) throw new HubGroupPolicyError("conflict");
        assertHubSelfUseDecisionCurrent(decision, now()); return decision;
      }).immediate();
    });
  }, async describe(subject, incoming) {
    const who = validated(person, subject), ctx = context(incoming);
    assert(ctx.current); const before = operational();
    const all = (p: HubOperationalPolicy, facts: RolePersonFacts) => Object.freeze(Object.fromEntries(GROUP_CAPABILITIES.map(cap => [cap, evaluate(p, who, cap, facts)]))) as Readonly<Record<GroupCapability, HubSelfUseDecision>>;
    if (before.state === "never-enabled") return Object.freeze({ policy: before, decisions: all(before, { kind: "unknown" }) });
    return this.withDirectoryRead(who, async () => {
      const facts = await observe(before, who, GROUP_CAPABILITIES); assert(ctx.current);
      const p = operational();
      return Object.freeze({ policy: p, decisions: all(p, JSON.stringify(p) === JSON.stringify(before) ? facts : { kind: "unknown" }) });
    });
  } };
}
