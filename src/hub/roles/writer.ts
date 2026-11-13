/** Inactive SQL writer. No route or migration registry calls it before cutover and permit conversion. */
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { personKeyString } from "../identity.js";
import { HubProtocolError, epoch, identifier, parseStrictJson, person, validated } from "../validation.js";
import { parseRolePolicy, SELF_PERMISSIONS, MANAGEMENT_PERMISSIONS } from "./model.js";
import { planRoleChange } from "./change.js";
import { heldRoleBundle, checkRoleChange } from "./delegation.js";
import { snapshotRolePersonFacts } from "./evaluate.js";
import type { HubAuditStore } from "../audit/index.js";
import type { HubDirectory } from "../directory/types.js";
import type { HubMigration } from "../db.js";
import type { HubGroupPolicyStore } from "../group-policy/store.js";
import type { HubRequestContext, PersonKey } from "../types.js";
import type { RolePersonFacts } from "./evaluate.js";
import type { HubRolePolicy } from "./model.js";
import type { RoleChangePlan } from "./change.js";
export interface RoleWriteEffects {
  /** Private server inventory/impact preparation; never a browser-supplied callback or effect. */
  prepare(plan: RoleChangePlan, facts: ReadonlyMap<string, RolePersonFacts>, current: () => void): Promise<{
    fingerprint: string; changed: boolean; impact: unknown;
    assertCurrent(): void;
    /** Exact retained-resource consequences, synchronously in the policy transaction. */
    commit(database: Database.Database): void;
    assertCommitted(): void;
  }>;
  /** Full inventory binds preview; ordinary excludes only this plan's exact lifecycle consequences. */
  snapshot(): { fingerprint: string; ordinaryFingerprint: string; people: readonly PersonKey[] };
}
export interface RoleWriterOptions {
  db: Database.Database; hubId: string; realm: string; generation: string; root: PersonKey;
  audit: Pick<HubAuditStore, "appendInTransaction">; directory: HubDirectory;
  reads: Pick<HubGroupPolicyStore, "withDirectoryRead">; effects: RoleWriteEffects;
  current(): boolean; version(): number; advanceAuthorization(database: Database.Database): void;
  refreshAuthorization(): void; now?: () => number; elapsedNow?: () => number;
}
export const HUB_ROLE_WRITER_MIGRATION: HubMigration = { component: "roles-writer", version: 1, up(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS hub_role_events(id TEXT PRIMARY KEY REFERENCES hub_audit(id) ON DELETE CASCADE, body TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS hub_role_notices(id TEXT NOT NULL REFERENCES hub_role_events(id) ON DELETE CASCADE, person TEXT NOT NULL, acknowledged_at INTEGER, PRIMARY KEY(id,person));
    CREATE TABLE IF NOT EXISTS hub_role_root_self(person TEXT PRIMARY KEY, role_id TEXT NOT NULL, assignment_id TEXT NOT NULL, audit_id TEXT NOT NULL);`);
} };
export type RoleWriteCode = "denied" | "unknown" | "self-target" | "conflict" | "stale-preview" | "expired" | "invalid" | "unavailable";
type Failure = { ok: false; code: RoleWriteCode };
export type RolePreviewResponse = Failure | { ok: true; revision: number; previewDigest: string; expiresAt: number; impact: unknown };
export type RoleApplyResponse = Failure | { ok: true; revision: number };
class Refusal extends Error { constructor(readonly code: RoleWriteCode) { super(code); } }
const json = (value: unknown) => JSON.stringify(value);
const hash = (value: unknown) => createHash("sha256").update(json(value)).digest("hex");
const same = (a: PersonKey, b: PersonKey) => personKeyString(a) === personKeyString(b);
function sync(result: unknown): void {
  if (result && typeof (result as { then?: unknown }).then === "function") {
    void Promise.resolve(result).catch(() => undefined); throw new Refusal("unavailable");
  }
}
/** Server stamps are excluded only from the private logical comparison, never from the bound request body. */
function logical(plan: RoleChangePlan): string {
  const changed = new Set(plan.assignments.map(a => a.after?.id));
  return json({ ...plan.next, assignments: plan.next.assignments.map(a => {
    if (!changed.has(a.id)) return a;
    const { assignedBy: _by, assignedAt: _at, ...publicFields } = a; return publicFields;
  }) });
}
interface Captured { requestId: string; current(): ReturnType<HubRequestContext["current"]>; requirePerson(): Promise<PersonKey>; isCurrent(): boolean }
interface Identity { person: PersonKey; sessionId: string }
type Operation = "ordinary" | "root-self";
interface Candidate { operation: Operation; actor: Identity; raw: string; before: string; epoch: number; inventory: string; logical: string; facts: string; impact: string; effects: string; created: number; expiresAt: number }
export function createHubRoleWriter(options: RoleWriterOptions) {
  const { db, audit, reads, directory, effects, current, version: readVersion, advanceAuthorization, refreshAuthorization } = options;
  const hubId = validated(identifier, options.hubId), root = validated(person, options.root);
  const realm = options.realm, generation = options.generation, clock = options.now ?? Date.now, elapsedClock = options.elapsedNow ?? (() => performance.now());
  const readGroups = directory.readPolicyGroups?.bind(directory), resolveGroup = directory.resolvePolicyGroup?.bind(directory), eligibility = directory.checkEligibility.bind(directory);
  const candidates = new Map<string, Candidate>(); let closed = false, working = 0;
  const now = () => validated(epoch, clock()), version = () => validated(epoch, readVersion());
  const elapsed = () => { const at = elapsedClock(); if (!Number.isFinite(at) || at < 0) throw new Refusal("expired"); return at; };
  const live = () => { try { return !closed && current() === true && directory.realm === realm && root.realm === realm; } catch { return false; } };
  const assert = (ctx: Captured) => { if (!live() || ctx.isCurrent() !== true) throw new Refusal("unavailable"); };
  const capture = (ctx: HubRequestContext): Captured => {
    if (!ctx || typeof ctx.current !== "function" || typeof ctx.requirePerson !== "function" || typeof ctx.isCurrent !== "function") throw new Refusal("invalid");
    return Object.freeze({ requestId: validated(identifier, ctx.requestId), current: ctx.current.bind(ctx), requirePerson: ctx.requirePerson.bind(ctx), isCurrent: ctx.isCurrent.bind(ctx) });
  };
  const authenticate = async (ctx: Captured, previous?: Identity): Promise<Identity> => {
    assert(ctx); const a = await ctx.current(); assert(ctx);
    if (a.kind !== "directory") throw new Refusal("denied");
    const actor = { person: validated(person, a.person), sessionId: validated(identifier, a.sessionId) };
    if (actor.person.realm !== realm || previous && (!same(actor.person, previous.person) || actor.sessionId !== previous.sessionId)) throw new Refusal("conflict");
    const who = validated(person, await ctx.requirePerson()); assert(ctx);
    const after = await ctx.current(); assert(ctx);
    if (!same(who, actor.person) || after.kind !== "directory" || !same(after.person, actor.person) || after.sessionId !== actor.sessionId) throw new Refusal("conflict");
    return actor;
  };
  const read = () => {
    if (!live()) throw new Refusal("unavailable");
    const row = db.prepare("SELECT hub_id,body FROM hub_group_policy WHERE singleton=1").get() as { hub_id: string; body: string } | undefined;
    if (!row || row.hub_id !== hubId) throw new Refusal("unavailable");
    const policy = parseRolePolicy(parseStrictJson(row.body));
    if (policy.realm !== realm || policy.generation !== generation) throw new Refusal("unavailable");
    return { raw: row.body, policy };
  };
  read(); // A missing, old or corrupt policy cannot create a role policy. Only the future cutover may do that.
  const record = (ctx: Captured, actor: Identity, action: string, result: "completed" | "denied", revision: number, payload: unknown) => {
    if (!db.inTransaction || !live()) throw new Refusal("unavailable");
    const id = randomUUID(), at = now(), body = json(payload);
    sync(audit.appendInTransaction({ id, at, sequence: 0, requestId: ctx.requestId, actor: { kind: "person", person: actor.person }, action, result, policyVersion: revision, reasonCode: hash(payload) }, db));
    db.prepare("INSERT INTO hub_role_events VALUES(?,?,?)").run(id, body, at); return id;
  };
  const refused = (ctx: Captured | undefined, actor: Identity | undefined, error: unknown): Failure => {
    const code: RoleWriteCode = error instanceof Refusal ? error.code : error instanceof HubProtocolError && error.code === "invalid" ? "invalid" : "unknown";
    if (ctx && actor) {
      try { db.transaction(() => { record(ctx, actor, "role.write-refused", "denied", read().policy.revision, { code }); }).immediate(); }
      catch { return { ok: false, code: "unavailable" }; }
    }
    return { ok: false, code };
  };
  const snapshot = () => {
    const s = effects.snapshot(); if (!s || typeof s.fingerprint !== "string" || s.fingerprint.length > 1024 || typeof s.ordinaryFingerprint !== "string" || s.ordinaryFingerprint.length > 1024 || !Array.isArray(s.people) || s.people.length > 256) throw new Refusal("unknown");
    return { fingerprint: s.fingerprint, ordinaryFingerprint: s.ordinaryFingerprint, people: s.people.map(p => validated(person, p)) };
  };
  const rootId = `root-self:${root.objectId}`;
  const rootMarker = () => db.prepare("SELECT * FROM hub_role_root_self WHERE person=?").get(personKeyString(root));
  const rootProposal = (before: HubRolePolicy): HubRolePolicy => {
    if (rootMarker() || before.roles.some(r => r.id === rootId) || before.assignments.some(a => a.id === rootId)) throw new Refusal("conflict");
    const next = parseRolePolicy(before);
    next.roles.push({ id: rootId, name: "Root self-use", kind: "custom", permissions: [...SELF_PERMISSIONS], defaultMaxFleets: 8 });
    next.assignments.push({ id: rootId, roleId: rootId, subject: { kind: "person", person: root }, scope: { kind: "hub" }, maxFleets: 8, startsAt: 0, expiresAt: null, assignedBy: root, assignedAt: 0 });
    return next;
  };
  const prepare = async (input: HubRolePolicy, ctx: Captured, actor: Identity, operation: Operation) => {
    if (db.inTransaction) throw new Refusal("invalid");
    const before = read(), authEpoch = version(), started = now(), elapsedStart = elapsed();
    let inventory: ReturnType<typeof snapshot> | null = null;
    const assertBudget = () => { const at = elapsed(); if (now() < started || at < elapsedStart || at >= elapsedStart + 20_000) throw new Refusal("expired"); };
    const assertBefore = () => {
      assert(ctx); assertBudget();
      if (read().raw !== before.raw || version() !== authEpoch || inventory && snapshot().fingerprint !== inventory.fingerprint) throw new Refusal("conflict");
    };
    let plan = planRoleChange(before.policy, input, actor.person, now());
    const authorize = (bundle: ReturnType<typeof heldRoleBundle>) => {
      if (operation === "root-self") {
        if (!same(actor.person, root) || bundle.kind !== "known" || !bundle.administrator) throw new Refusal("denied");
        if (logical(plan) !== logical(planRoleChange(before.policy, rootProposal(before.policy), root, now()))) throw new Refusal("invalid");
      } else {
        if (plan.roles.some(d => d.after?.id.startsWith("root-self:"))) throw new Refusal("invalid");
        const answer = checkRoleChange(plan, bundle); if (answer !== "allow") throw new Refusal(answer);
      }
    };
    const facts = new Map<string, RolePersonFacts>();
    const observe = async (who: PersonKey) => {
      assertBefore(); const began = now();
      const f = await reads.withDirectoryRead(actor.person, async () => {
        if (readGroups) return snapshotRolePersonFacts(await readGroups(Object.freeze({ ...who })), who, now());
        const e = await eligibility(Object.freeze({ ...who }));
        return e.eligible && same(e.person.key, who) ? { kind: "eligible" as const, person: who, observedAt: now() } : e.eligible === false && e.reason !== "unavailable" ? { kind: "ineligible" as const, person: who, reason: e.reason, observedAt: now() } : null;
      });
      assertBefore(); facts.set(personKeyString(who), f && f.observedAt >= began ? f : { kind: "unknown" });
    };
    // A person without delegation authority must not trigger inventory/other-person directory scans.
    await observe(actor.person);
    authorize(heldRoleBundle(before.policy, actor.person, facts.get(personKeyString(actor.person))!, now(), root));
    inventory = snapshot(); const people = new Map<string, PersonKey>();
    for (const p of [actor.person, root, ...inventory.people, ...before.policy.assignments.flatMap(a => a.subject.kind === "person" ? [a.subject.person] : []), ...input.assignments.flatMap(a => a.subject.kind === "person" ? [a.subject.person] : [])]) people.set(personKeyString(p), p);
    if (people.size > 256) throw new Refusal("unknown");
    for (const [id, who] of [...people].sort(([a], [b]) => a.localeCompare(b))) if (!facts.has(id)) await observe(who);
    // Resolve every newly affected group by GUID. A search hit or a DN label cannot stand in for this proof.
    for (const d of plan.affected) if (d.after) {
      const a = d.after;
      if (a.subject.kind === "person") {
        const target = a.subject.person;
        const e = await reads.withDirectoryRead(actor.person, () => eligibility(Object.freeze({ ...target })));
        assertBefore(); if (!e.eligible || !same(e.person.key, a.subject.person)) throw new Refusal(e.eligible === false && e.reason === "unavailable" ? "unknown" : "denied");
      }
      for (const g of [a.subject.kind === "group" ? a.subject : null, a.scope.kind === "group" ? a.scope : null]) if (g) {
        if (!resolveGroup) throw new Refusal("unknown");
        const result = await reads.withDirectoryRead(actor.person, () => resolveGroup(g.dn)); assertBefore();
        if (!result.ok || !same(validated(person, result.group.key), g.group)) throw new Refusal("unknown");
      }
    }
    await authenticate(ctx, actor); assertBefore();
    // Authentication may have awaited past an assignment's expiry: recompute the held bundle at this exact time.
    plan = planRoleChange(before.policy, input, actor.person, now());
    const finalBundle = heldRoleBundle(before.policy, actor.person, facts.get(personKeyString(actor.person))!, now(), root);
    authorize(finalBundle);
    const value = await effects.prepare(plan, new Map([...facts].map(([id, fact]) => [id, structuredClone(fact)])), assertBefore); assertBefore();
    if (typeof value.fingerprint !== "string" || value.fingerprint.length > 1024 || typeof value.changed !== "boolean") throw new Refusal("unknown");
    const impact = structuredClone(value.impact), serializedImpact = json(impact);
    if (typeof serializedImpact !== "string" || Buffer.byteLength(serializedImpact,"utf8") > 256 * 1024) throw new Refusal("unknown");
    const prepared = Object.freeze({ fingerprint: value.fingerprint, changed: value.changed, impact,
      assertCurrent: value.assertCurrent.bind(value), commit: value.commit.bind(value), assertCommitted: value.assertCommitted.bind(value) });
    sync(prepared.assertCurrent());
    await authenticate(ctx, actor); assertBefore();
    plan = planRoleChange(before.policy, input, actor.person, now());
    const semanticFacts = json([...facts].map(([id, f]) => [id, f.kind === "complete" ? { kind: f.kind, person: f.person, groups: [...f.groups].sort() } : f.kind === "unknown" ? { kind: f.kind } : { kind: f.kind, person: f.person }]));
    const recipients = [...people].filter(([id, who]) => [before.policy, plan.next].some(p => heldRoleBundle(p, who, facts.get(id)!, now(), root).administrator && facts.get(id)!.kind !== "ineligible" && facts.get(id)!.kind !== "unknown")).map(([id]) => id).sort();
    const assertAuthority = () => {
      const bundle = heldRoleBundle(before.policy, actor.person, facts.get(personKeyString(actor.person))!, now(), root);
      if (operation === "root-self") {
        if (!same(actor.person, root) || bundle.kind !== "known" || !bundle.administrator) throw new Refusal("denied");
      } else { const answer = checkRoleChange(plan, bundle); if (answer !== "allow") throw new Refusal(answer); }
    };
    return { before, plan, authEpoch, inventory, facts: semanticFacts, prepared, recipients, started, assertBudget, assertBefore, assertAuthority, logical: logical(plan) };
  };
  const prune = () => { const at = now(); for (const [id, c] of candidates) if (at < c.created || at >= c.expiresAt) candidates.delete(id); };
  const preview = async (input: unknown, incoming: HubRequestContext, operation: Operation = "ordinary"): Promise<RolePreviewResponse> => {
    let ctx: Captured | undefined, actor: Identity | undefined;
    try {
      ctx = capture(incoming); const proposed = structuredClone(input); actor = await authenticate(ctx); const raw = parseRolePolicy(proposed);
      if (working >= 2) throw new Refusal("unavailable"); working++;
      try {
        prune(); const p = await prepare(raw, ctx, actor, operation);
        for (const [id, c] of candidates) if (c.actor.sessionId === actor.sessionId) candidates.delete(id);
        if (candidates.size >= 16) throw new Refusal("unavailable");
        const created = now(), expiresAt = created + 120_000, previewDigest = randomUUID();
        candidates.set(previewDigest, { operation, actor, raw: json(raw), before: p.before.raw, epoch: p.authEpoch, inventory: p.inventory.fingerprint,
          logical: p.logical, facts: p.facts, impact: json(p.prepared.impact), effects: json([p.prepared.fingerprint,p.prepared.changed]), created, expiresAt });
        return { ok: true, revision: p.before.policy.revision, previewDigest, expiresAt, impact: structuredClone(p.prepared.impact) };
      } finally { working--; }
    } catch (error) { return refused(ctx, actor, error); }
  };
  const apply = async (input: unknown, digest: string, incoming: HubRequestContext, operation: Operation = "ordinary"): Promise<RoleApplyResponse> => {
    let ctx: Captured | undefined, actor: Identity | undefined, committedRevision: number | undefined;
    try {
      ctx = capture(incoming); const proposed = structuredClone(input), c = candidates.get(digest); candidates.delete(digest);
      actor = await authenticate(ctx); const raw = parseRolePolicy(proposed);
      if (!c || c.operation !== operation || json(c.actor) !== json(actor) || c.raw !== json(raw)) throw new Refusal("stale-preview");
      const unexpired = () => { if (now() < c.created || now() >= c.expiresAt) throw new Refusal("expired"); };
      unexpired(); if (working >= 2) throw new Refusal("unavailable"); working++;
      try {
        const p = await prepare(raw, ctx, actor, operation); unexpired();
        if (c.before !== p.before.raw || c.epoch !== p.authEpoch || c.inventory !== p.inventory.fingerprint) throw new Refusal("conflict");
        if (c.logical !== p.logical || c.facts !== p.facts || c.impact !== json(p.prepared.impact) || c.effects !== json([p.prepared.fingerprint,p.prepared.changed])) throw new Refusal("stale-preview");
        const saved = db.transaction(() => {
          unexpired(); p.assertBefore(); sync(p.prepared.assertCurrent());
          // No await after this final authority/time check until the transaction commits.
          p.assertAuthority();
          if (p.before.policy.revision === Number.MAX_SAFE_INTEGER) throw new Refusal("conflict");
          const next = { ...p.plan.next, revision: p.before.policy.revision + (p.plan.changed ? 1 : 0) }, serialized = json(next);
          if (operation === "root-self" && rootMarker()) throw new Refusal("conflict");
          sync(p.prepared.commit(db));
          if (db.prepare("UPDATE hub_group_policy SET body=? WHERE singleton=1 AND hub_id=? AND body=?").run(serialized, hubId, p.before.raw).changes !== 1) throw new Refusal("conflict");
          const id = record(ctx!, actor!, operation === "root-self" ? "role.root-self-use-activated" : "role.policy-changed", "completed", next.revision, { policy: next, impact: p.prepared.impact });
          const management = (p: readonly string[]) => p.some(c => (MANAGEMENT_PERMISSIONS as readonly string[]).includes(c));
          const notify = operation === "root-self" || p.plan.before.rolesActive !== next.rolesActive || p.plan.roles.some(d => management(d.before?.permissions ?? []) || management(d.after?.permissions ?? []))
            || p.plan.assignments.some(d => [d.before, d.after].some(a => a && management((a === d.before ? p.plan.before : next).roles.find(r => r.id === a.roleId)!.permissions)));
          if (operation === "root-self") db.prepare("INSERT INTO hub_role_root_self VALUES(?,?,?,?)").run(personKeyString(root), rootId, rootId, id);
          if (notify) for (const recipient of p.recipients) db.prepare("INSERT INTO hub_role_notices(id,person) VALUES(?,?)").run(id, recipient);
          const committed = () => { assert(ctx!); unexpired(); p.assertBudget(); p.assertAuthority();
            if (read().raw !== serialized || snapshot().ordinaryFingerprint !== p.inventory.ordinaryFingerprint) throw new Refusal("conflict");
            if (operation === "root-self" && json(rootMarker()) !== json({ person: personKeyString(root), role_id: rootId, assignment_id: rootId, audit_id: id })) throw new Refusal("conflict");
            sync(p.prepared.assertCommitted());
          };
          committed(); if (version() !== p.authEpoch) throw new Refusal("conflict");
          if (p.plan.changed || p.prepared.changed) sync(advanceAuthorization(db));
          if (version() !== p.authEpoch + (p.plan.changed || p.prepared.changed ? 1 : 0)) throw new Refusal("conflict");
          committed(); return next;
        }).immediate();
        committedRevision = saved.revision;
        if (p.plan.changed || p.prepared.changed) sync(refreshAuthorization());
        assert(ctx); return { ok: true, revision: saved.revision };
      } finally { working--; }
    } catch (error) { return committedRevision === undefined ? refused(ctx, actor, error) : {ok:false,code:"unavailable"}; }
  };
  const noticeBoundary = async (incoming: HubRequestContext, captured?: (ctx: Captured, actor: Identity) => void) => {
    const ctx = capture(incoming), actor = await authenticate(ctx), selected = read(), authEpoch = version();
    captured?.(ctx,actor);
    const prove = () => {
      assert(ctx); if (read().raw !== selected.raw || version() !== authEpoch) throw new Refusal("conflict");
      const bundle = heldRoleBundle(selected.policy, actor.person, {kind:"eligible", person:actor.person, observedAt:now()}, now(), root);
      if (!bundle.administrator) throw new Refusal("denied");
    };
    prove(); return { ctx, actor, selected, prove };
  };
  const notices = async (incoming: HubRequestContext): Promise<Failure | {ok:true; notices:{id:string; body:unknown; at:number}[]}> => {
    try {
      const b = await noticeBoundary(incoming);
      const rows = db.prepare("SELECT e.id,e.body,e.at FROM hub_role_notices n JOIN hub_role_events e ON e.id=n.id WHERE n.person=? AND n.acknowledged_at IS NULL ORDER BY e.at DESC,e.id LIMIT 100").all(personKeyString(b.actor.person)) as {id:string;body:string;at:number}[];
      b.prove(); return {ok:true,notices:rows.map(r => ({...r,body:parseStrictJson(r.body,1024*1024)}))};
    } catch(error) { return refused(undefined, undefined, error); }
  };
  const acknowledge = async (id: string, incoming: HubRequestContext): Promise<Failure | {ok:true}> => {
    let ctx: Captured | undefined, actor: Identity | undefined;
    try {
      const b = await noticeBoundary(incoming,(c,a) => {ctx=c;actor=a;}); validated(identifier,id);
      db.transaction(() => {
        b.prove(); const row = db.prepare("SELECT acknowledged_at FROM hub_role_notices WHERE id=? AND person=?").get(id,personKeyString(b.actor.person)) as {acknowledged_at:number|null}|undefined;
        if (!row) throw new Refusal("denied"); if (row.acknowledged_at !== null) return;
        const at = now(); db.prepare("UPDATE hub_role_notices SET acknowledged_at=? WHERE id=? AND person=? AND acknowledged_at IS NULL").run(at,id,personKeyString(b.actor.person));
        record(b.ctx,b.actor,"role.notice-acknowledged","completed",b.selected.policy.revision,{id}); b.prove();
        const after = db.prepare("SELECT acknowledged_at FROM hub_role_notices WHERE id=? AND person=?").get(id,personKeyString(b.actor.person)) as {acknowledged_at:number}|undefined;
        if (after?.acknowledged_at !== at) throw new Refusal("conflict");
      }).immediate(); return {ok:true};
    } catch(error) { return refused(ctx,actor,error); }
  };
  return {
    preview: (input: unknown, ctx: HubRequestContext) => preview(input,ctx),
    apply: (input: unknown, digest: string, ctx: HubRequestContext) => apply(input,digest,ctx), notices, acknowledge,
    async previewRootSelf(ctx: HubRequestContext): Promise<RolePreviewResponse> {
      let captured: Captured | undefined, actor: Identity | undefined;
      try {
        captured = capture(ctx); actor = await authenticate(captured);
        if (!same(actor.person, root)) throw new Refusal("denied");
        return await preview(rootProposal(read().policy),ctx,"root-self");
      } catch(error) { return refused(captured,actor,error); }
    },
    async applyRootSelf(digest: string, ctx: HubRequestContext): Promise<RoleApplyResponse> {
      const candidate = candidates.get(digest);
      return apply(candidate ? parseStrictJson(candidate.raw) : null,digest,ctx,"root-self");
    },
    close() { closed = true; candidates.clear(); },
  };
}
