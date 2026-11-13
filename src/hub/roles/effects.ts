/** Unmounted resource effects. The writer/expiry owner still proves actor, policy, epoch and the owning transaction. */
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { HubAuditStore } from "../audit/index.js";
import type { HubDirectory } from "../directory/types.js";
import { createHubGroupAdminInventory } from "../group-policy/admin-inventory.js";
import { createHubGroupImpactInventory } from "../group-policy/impact-inventory.js";
import type { HubGroupPolicyStore } from "../group-policy/store.js";
import { parseStoredHubGroupResource } from "../group-policy/resources.js";
import { canonicalArguments, personKeyString } from "../identity.js";
import type { HubTransportStore } from "../store.js";
import type { PersonKey } from "../types.js";
import { epoch, HubProtocolError, identifier, parseStrictJson, person, uuid, validated } from "../validation.js";
import { planRoleChange } from "./change.js";
import { captureRoleCutoverInventory } from "./cutover-inventory.js";
import { evaluateRolePolicy, snapshotRolePersonFacts, type RolePersonFacts } from "./evaluate.js";
import { parseRolePolicy, SELF_PERMISSIONS, type HubRoleAssignment, type HubRolePolicy } from "./model.js";
import type { RoleWriteEffects } from "./writer.js";
interface LedgerRow {
    resource_key: string;
    body: string;
    source: "group" | "manual" | "code";
    state: "active" | "suspended";
    revision: number;
}
type Action = {
    kind: "capture" | "suspend";
    key: string;
    before: LedgerRow | null;
    after: LedgerRow;
};
export interface HubRoleResourceEffectsOptions {
    db: Database.Database;
    hubId: string;
    realm: string;
    generation: string;
    root: PersonKey;
    transport: Pick<HubTransportStore, "read">;
    audit: Pick<HubAuditStore, "appendInTransaction">;
    directory: Pick<HubDirectory, "realm" | "checkEligibility" | "readPolicyGroups">;
    reads: Pick<HubGroupPolicyStore, "withDirectoryRead">;
    current(): boolean;
    assertAuthorizationTime(): void;
    now?: () => number;
    elapsedNow?: () => number;
}
const json = (v: unknown) => JSON.stringify(v), sha = (v: unknown) => createHash("sha256").update(json(v)).digest("hex");
const keyOf = (r: {
    kind: string;
    id: string;
    revision: number;
}) => json([r.kind, r.id, r.revision]);
function sync(result: unknown): void {
    if (result && typeof (result as {
        then?: unknown;
    }).then === "function") {
        void Promise.resolve(result).catch(() => undefined);
        throw new HubProtocolError("unavailable");
    }
}
export function createHubRoleResourceEffects(options: HubRoleResourceEffectsOptions) {
    const { db, transport, audit, directory, reads, current, assertAuthorizationTime } = options;
    const root = validated(person, options.root), hubId = validated(uuid, options.hubId), { realm, generation } = options;
    const readTransport = transport.read, append = audit.appendInTransaction, eligible = directory.checkEligibility, readGroups = directory.readPolicyGroups, readMethod = reads.withDirectoryRead;
    const withRead = <T>(who: PersonKey, work: () => Promise<T>): Promise<T> => readMethod.call(reads, who, work) as Promise<T>;
    const clock = options.now ?? Date.now, elapsed = options.elapsedNow ?? (() => performance.now());
    const now = () => validated(epoch, clock());
    let closed = false;
    const live = () => {
        if (closed || current() !== true || root.realm !== realm || directory.realm !== realm || transport.read !== readTransport
            || reads.withDirectoryRead !== readMethod || audit.appendInTransaction !== append || directory.checkEligibility !== eligible || directory.readPolicyGroups !== readGroups)
            throw new HubProtocolError("unavailable");
    };
    const guard = () => { live(); sync(assertAuthorizationTime()); live(); };
    const policy = () => {
        const row = db.prepare("SELECT hub_id,body FROM hub_group_policy WHERE singleton=1").get() as {
            hub_id: string;
            body: string;
        } | undefined;
        if (!row || row.hub_id !== hubId)
            throw new HubProtocolError("unavailable");
        const value = parseRolePolicy(parseStrictJson(row.body));
        if (value.realm !== realm || value.generation !== generation)
            throw new HubProtocolError("unavailable");
        return { raw: row.body, value };
    };
    const ordinary = createHubGroupAdminInventory({ db, transport, realm });
    const impactInventory = createHubGroupImpactInventory({ db, transport, administrator: root, inventory: ordinary, current: () => { live(); return true; }, now });
    const scanGuard = () => {
        const start = elapsed();
        return () => {
            live();
            const at = elapsed();
            if (!Number.isFinite(start) || !Number.isFinite(at) || at < start || at >= start + 20000)
                throw new HubProtocolError("unavailable");
        };
    };
    const validateRow = (row: LedgerRow) => {
        if (Buffer.byteLength(row.body, "utf8") > 4096 || !["group", "manual", "code"].includes(row.source)
            || !["active", "suspended"].includes(row.state) || !Number.isSafeInteger(row.revision) || row.revision < 1)
            throw new HubProtocolError("unavailable");
        const parsed = parseStoredHubGroupResource(parseStrictJson(row.body), row.source);
        if (row.resource_key !== keyOf(parsed.resource))
            throw new HubProtocolError("unavailable");
        return row;
    };
    const rowOf = (key: string) => {
        const row = db.prepare("SELECT * FROM hub_group_resources WHERE resource_key=?").get(key) as LedgerRow | undefined;
        return row ? validateRow(row) : null;
    };
    const ledgerDigest = (changes: ReadonlyMap<string, {
        before: LedgerRow | null;
        after: LedgerRow;
    }> = new Map()) => {
        const h = createHash("sha256"), seen = new Set<string>(), check = scanGuard();
        for (const raw of db.prepare("SELECT * FROM hub_group_resources ORDER BY resource_key").iterate() as Iterable<LedgerRow>) {
            check();
            const row = validateRow(raw), own = changes.get(row.resource_key);
            if (own) {
                if (json(row) !== json(own.after))
                    throw new HubProtocolError("conflict");
                seen.add(row.resource_key);
                if (own.before)
                    h.update(json(own.before));
            }
            else
                h.update(json(row));
        }
        check();
        if (seen.size !== changes.size)
            throw new HubProtocolError("conflict");
        return h.digest("hex");
    };
    const eventDigest = (expected: ReadonlyMap<string, string> = new Map()) => {
        const h = createHash("sha256"), seen = new Set<string>(), check = scanGuard();
        for (const row of db.prepare("SELECT id,body FROM hub_group_resource_events ORDER BY id").iterate() as Iterable<{
            id: string;
            body: string;
        }>) {
            check();
            const own = expected.get(row.id);
            if (own !== undefined) {
                if (row.body !== own)
                    throw new HubProtocolError("conflict");
                seen.add(row.id);
            }
            else {
                if (Buffer.byteLength(row.body, "utf8") > 2 * 1024 * 1024)
                    throw new HubProtocolError("unavailable");
                h.update(json(row));
            }
        }
        check();
        if (seen.size !== expected.size)
            throw new HubProtocolError("conflict");
        return h.digest("hex");
    };
    const snapshot = () => {
        guard();
        policy();
        const started = elapsed();
        const check = () => {
            live();
            const at = elapsed();
            if (!Number.isFinite(started) || !Number.isFinite(at) || at < started || at >= started + 20000)
                throw new HubProtocolError("unavailable");
        };
        const inventory = captureRoleCutoverInventory(db, transport, check);
        const people = db.prepare("SELECT person,realm,object_id,display_name,login_label,status FROM hub_people ORDER BY person LIMIT 257").all();
        if (people.length > 256)
            throw new HubProtocolError("unavailable");
        const known = impactInventory.snapshot();
        if (known.people.length > 256)
            throw new HubProtocolError("unavailable");
        const ordinaryFingerprint = sha({ tables: inventory.tables.filter(t => !["hub_group_resources", "hub_group_resource_events"].includes(t.name)), people });
        guard();
        check();
        return { fingerprint: sha([inventory.digest, people]), ordinaryFingerprint, people: known.people.map(p => structuredClone(p.key)), resources: known.resources };
    };
    type Prepare = ReturnType<RoleWriteEffects["prepare"]>;
    const prepare = async (beforeInput: HubRolePolicy, nextInput: HubRolePolicy, inputFacts: ReadonlyMap<string, RolePersonFacts>, assertBefore: () => void, actor: {
        kind: "person";
        person: PersonKey;
    } | {
        kind: "local-host";
    }, requestId: string, policyVersion: number, cause: "role-policy" | "role-expiry"): Prepare => {
        guard();
        sync(assertBefore());
        const before = parseRolePolicy(beforeInput), next = parseRolePolicy(nextInput), start = now(), started = elapsed(), selected = policy();
        const canonical = (p: HubRolePolicy) => json(planRoleChange(p, p, root, start).before);
        if (canonical(selected.value) !== canonical(before) || next.realm !== realm || next.generation !== generation
            || next.revision !== before.revision)
            throw new HubProtocolError("conflict");
        const facts = new Map([...inputFacts].map(([id, f]) => [id, structuredClone(f)]));
        const initial = snapshot(), rows = new Map(initial.resources.map(item => [keyOf(item.resource), rowOf(keyOf(item.resource))])), oldLedger = ledgerDigest(), oldEvents = eventDigest(), expected = new Map<string, {
            before: LedgerRow | null;
            after: LedgerRow;
        }>();
        const firstEnable = before.state === "never-enabled" && next.state === "enabled";
        const persons = new Map(initial.people.map(who => [personKeyString(who), who]));
        for (const p of [before, next])
            for (const assignment of p.assignments)
                if (assignment.subject.kind === "person")
                    persons.set(personKeyString(assignment.subject.person), assignment.subject.person);
        if (persons.size > 256)
            throw new HubProtocolError("unavailable");
        const resourcePlan = () => {
            const actions: Action[] = [], held: unknown[] = [], decisions: unknown[] = [], grandfathered: string[] = [], peopleChanges: unknown[] = [];
            for (const [id, who] of [...persons].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
                const fact = facts.get(id) ?? { kind: "unknown" as const };
                const gained: string[] = [], lost: string[] = [], unknown: string[] = [], legacyChanged: string[] = [];
                let fleetLimit: {
                    before: number;
                    after: number;
                } | undefined;
                for (const cap of SELF_PERMISSIONS) {
                    const old = evaluateRolePolicy(before, who, cap, null, { subject: fact }, now(), root), after = evaluateRolePolicy(next, who, cap, null, { subject: fact }, now(), root);
                    decisions.push([id, cap, old, after]);
                    if (old.outcome === "unknown" || after.outcome === "unknown")
                        unknown.push(cap);
                    else if (old.outcome === "deny" && after.outcome === "allow")
                        gained.push(cap);
                    else if (old.outcome === "allow" && after.outcome === "deny")
                        lost.push(cap);
                    if (old.outcome !== after.outcome && (old.outcome === "legacy" || after.outcome === "legacy"))
                        legacyChanged.push(cap);
                    if (cap === "pair_fleet" && old.outcome === "allow" && after.outcome === "allow" && old.maxFleets !== after.maxFleets)
                        fleetLimit = { before: old.maxFleets, after: after.maxFleets };
                }
                if (gained.length || lost.length || unknown.length || legacyChanged.length || fleetLimit)
                    peopleChanges.push({ person: who, gained, lost, unknown, legacyChanged, ...(fleetLimit ? { fleetLimit } : {}) });
            }
            for (const item of initial.resources) {
                const r = item.resource, key = keyOf(r), row = rows.get(key) ?? null;
                const cap = r.kind === "fleet" ? "pair_fleet" : r.kind === "exposure" ? "publish_agents" : "ask_agents";
                const f = facts.get(personKeyString(r.owner)) ?? { kind: "unknown" as const };
                const result = evaluateRolePolicy(next, r.owner, cap, null, { subject: f }, now(), root);
                decisions.push([key, result]);
                if (firstEnable && row?.source === "group")
                    throw new HubProtocolError("conflict");
                let target = row;
                if (firstEnable && !row && r.kind !== "asker") {
                    target = { resource_key: key, body: json(r), source: "manual", state: "active", revision: 1 };
                    actions.push({ kind: "capture", key, before: null, after: target });
                }
                if (!target)
                    continue;
                const explicit = (target.source === "code" || next.state !== "never-enabled")
                    && next.denies.some(d => personKeyString(d.person) === personKeyString(r.owner) && d.deny.includes(cap));
                const observed = snapshotRolePersonFacts(f, r.owner, now());
                const ineligible = observed?.kind === "ineligible";
                const narrow = target.source === "group" ? explicit || result.outcome === "deny" && result.authoritative : explicit || ineligible;
                if (target.state === "active" && narrow) {
                    if (target.revision === Number.MAX_SAFE_INTEGER)
                        throw new HubProtocolError("conflict");
                    actions.push({ kind: "suspend", key, before: target, after: { ...target, state: "suspended", revision: target.revision + 1 } });
                }
                else if (target.state === "active" && target.source !== "group")
                    grandfathered.push(key);
                if (result.outcome === "unknown" && target.source === "group" && !narrow)
                    held.push({ resource: r, reason: "membership-unknown" });
            }
            return { actions, impact: { cause, peopleChanges, capture: actions.filter(a => a.kind === "capture").map(a => a.key), suspend: actions.filter(a => a.kind === "suspend").map(a => a.key), held, grandfathered }, decisions };
        };
        const planned = resourcePlan(), stablePlan = json(planned), additions = new Map<string, string>(), auditImages = new Map<string, string>();
        let used = false, retired = false;
        const stable = () => {
            try {
                guard();
                const at = now(), tick = elapsed();
                if (retired || at < start || !Number.isFinite(tick) || tick < started || tick >= started + 20000 || json(resourcePlan()) !== stablePlan)
                    throw new HubProtocolError("conflict");
            }
            catch (error) {
                retired = true;
                throw error;
            }
        };
        const retire = (work: () => void) => {
            try {
                work();
            }
            catch (error) {
                retired = true;
                throw error;
            }
        };
        const assertCurrent = () => retire(() => {
            stable();
            sync(assertBefore());
            if (policy().raw !== selected.raw || snapshot().fingerprint !== initial.fingerprint)
                throw new HubProtocolError("conflict");
        });
        const assertExpected = () => retire(() => {
            stable();
            if (snapshot().ordinaryFingerprint !== initial.ordinaryFingerprint || ledgerDigest(expected) !== oldLedger
                || eventDigest(additions) !== oldEvents || [...auditImages].some(([id, image]) => json(db.prepare("SELECT * FROM hub_audit WHERE id=?").get(id)) !== image))
                throw new HubProtocolError("conflict");
        });
        assertCurrent();
        return { fingerprint: sha([initial.fingerprint, planned]), changed: planned.actions.length > 0, impact: structuredClone(planned.impact), assertCurrent,
            commit(database) {
                if (database !== db || !db.inTransaction || used) {
                    retired = true;
                    throw new HubProtocolError("unavailable");
                }
                used = true;
                assertCurrent();
                for (const action of planned.actions) {
                    const id = randomUUID(), body = json({ resource: parseStoredHubGroupResource(parseStrictJson(action.after.body), action.after.source).resource,
                        generation, policyRevision: policyVersion, payload: { source: action.after.source, from: action.before?.state ?? null, to: action.after.state, reason: cause, provenance: parseStrictJson(action.after.body) } });
                    const at = now(), name = action.kind === "capture" ? "role.resource-grandfathered" : "role.resource-suspended", reason = sha(body);
                    sync(append.call(audit, { id, sequence: 0, at, requestId, actor: structuredClone(actor),
                        action: name, result: "completed", policyVersion, reasonCode: reason }, db));
                    const receipt = db.prepare("SELECT * FROM hub_audit WHERE id=?").get(id) as {
                        at: number;
                        request_id: string;
                        actor: string;
                        action: string;
                        result: string;
                        policy_version: number;
                        reason_code: string;
                    } | undefined;
                    if (!receipt || receipt.at !== at || receipt.request_id !== requestId || receipt.actor !== canonicalArguments(actor) || receipt.action !== name || receipt.result !== "completed"
                        || receipt.policy_version !== policyVersion || receipt.reason_code !== reason)
                        throw new HubProtocolError("unavailable");
                    auditImages.set(id, json(receipt));
                    assertExpected();
                    if (action.kind === "capture")
                        db.prepare("INSERT INTO hub_group_resources(resource_key,body,source,state,revision) VALUES(@resource_key,@body,@source,@state,@revision)").run(action.after);
                    else if (db.prepare("UPDATE hub_group_resources SET state='suspended',revision=revision+1 WHERE resource_key=? AND body=? AND source=? AND state='active' AND revision=?")
                        .run(action.key, action.before!.body, action.before!.source, action.before!.revision).changes !== 1)
                        throw new HubProtocolError("conflict");
                    expected.set(action.key, { before: expected.has(action.key) ? expected.get(action.key)!.before : action.before, after: { ...action.after } });
                    db.prepare("INSERT INTO hub_group_resource_events VALUES(?,?)").run(id, body);
                    additions.set(id, body);
                    assertExpected();
                }
                assertExpected();
            },
            assertCommitted() {
                if (!used)
                    throw new HubProtocolError("unavailable");
                assertExpected();
            },
        };
    };
    const write: RoleWriteEffects = { snapshot, prepare(plan, facts, assertCurrent, provenance) {
            if (!provenance)
                return Promise.reject(new HubProtocolError("unavailable"));
            const who = validated(person, provenance.actor), requestId = validated(identifier, provenance.requestId);
            if (who.realm !== realm)
                return Promise.reject(new HubProtocolError("unavailable"));
            return prepare(plan.before, plan.next, facts, assertCurrent, { kind: "person", person: who }, requestId, plan.before.revision + (plan.changed ? 1 : 0), "role-policy");
        } };
    return { write, async prepareExpiry(input: {
            policy: HubRolePolicy;
            expired: readonly HubRoleAssignment[];
            at: number;
        }, assertCurrent: () => void) {
            const captured = parseRolePolicy(input.policy), at = validated(epoch, input.at);
            if (!input.expired.length || new Set(input.expired.map(a => a.id)).size !== input.expired.length
                || input.expired.some(a => a.expiresAt === null || a.expiresAt > at || json(captured.assignments.find(x => x.id === a.id)) !== json(a)))
                throw new HubProtocolError("unavailable");
            const initial = snapshot(), facts = new Map<string, RolePersonFacts>();
            for (const who of initial.people) {
                guard();
                sync(assertCurrent());
                const began = now();
                const fact = await withRead(root, async () => {
                    if (readGroups)
                        return snapshotRolePersonFacts(await readGroups.call(directory, Object.freeze({ ...who })), who, now());
                    const e = await eligible.call(directory, Object.freeze({ ...who }));
                    return e.eligible && personKeyString(e.person.key) === personKeyString(who) ? { kind: "eligible" as const, person: who, observedAt: now() }
                        : e.eligible === false && ["gone", "disabled"].includes(e.reason) ? { kind: "ineligible" as const, person: who, reason: e.reason as "gone" | "disabled", observedAt: now() } : null;
                });
                guard();
                sync(assertCurrent());
                if (snapshot().fingerprint !== initial.fingerprint || now() < at)
                    throw new HubProtocolError("conflict");
                facts.set(personKeyString(who), fact && fact.observedAt >= began ? fact : { kind: "unknown" });
            }
            return prepare(captured, captured, facts, assertCurrent, { kind: "local-host" }, randomUUID(), captured.revision, "role-expiry");
        }, close() { closed = true; } };
}
