/** Actual SQL/audit/cutover/transport; owned synthetic floor and directory facts, no runtime activation. */
import Database from "better-sqlite3";
import type { IncomingMessage } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyHubMigrations, bindHubInstance, createHubUnitOfWork, hubTxDatabase } from "../src/hub/db.js";
import { createHubAudit } from "../src/hub/audit/index.js";
import { HubTransportStore } from "../src/hub/store.js";
import { createHubRoleCutover } from "../src/hub/roles/cutover.js";
import { createHubRoleAuthorizationClock } from "../src/hub/roles/clock.js";
import { createHubRoleResourceEffects } from "../src/hub/roles/effects.js";
import type { RolePersonFacts } from "../src/hub/roles/evaluate.js";
import { parseRolePolicy, BUILTIN_ROLE_IDS } from "../src/hub/roles/model.js";
import { planRoleChange } from "../src/hub/roles/change.js";
import { personKeyString } from "../src/hub/identity.js";
import { HubCore } from "../src/hub/http/core.js";
import { HubSessions, hubCookieName } from "../src/hub/sessions.js";
import { HubPairingService } from "../src/hub/pairing.js";
import { createHubDirectoryAdmission } from "../src/hub/directory/admission.js";
import { createHubRoleWriter } from "../src/hub/roles/writer.js";
import { createHubRoleExpirySettlement } from "../src/hub/roles/expiry.js";
import type { PolicyGroupFacts } from "../src/hub/directory/groups.js";
import type { PersonKey } from "../src/hub/types.js";
import { HubGroupReadOverload } from "../src/hub/group-policy/store.js";
import type { HubDirectory } from "../src/hub/directory/types.js";
import { roleCutoverLegacyPlan } from "./support/hub-role-cutover-plan.js";
const dbs: Database.Database[] = [];
afterEach(() => {
    for (const db of dbs.splice(0))
        if (db.open)
            db.close();
});
function world(source: "group" | "manual" | "code" = "group", state: "never-enabled" | "enabled" = "enabled", ad = false) {
    const db = new Database(":memory:");
    dbs.push(db);
    db.pragma("foreign_keys=ON");
    const hubId = randomUUID(), root: PersonKey = { realm: "corp", objectId: randomUUID() }, owner: PersonKey = { realm: "corp", objectId: randomUUID() };
    const migrations = roleCutoverLegacyPlan(hubId);
    let at = 100, floor = 0, live = true, elapsed = 0;
    applyHubMigrations(db, migrations);
    bindHubInstance(db, hubId, "new", at);
    db.prepare("UPDATE hub_group_policy SET body=json_set(body,'$.state',?)").run(state);
    const baseAudit = createHubAudit({ db, contentKey: randomBytes(32), now: () => at });
    let hook: ((record: Parameters<typeof baseAudit.appendInTransaction>[0]) => void) | undefined, asyncAudit = false;
    const audit = { ...baseAudit, appendInTransaction(...args: Parameters<typeof baseAudit.appendInTransaction>) {
            const result = baseAudit.appendInTransaction(...args);
            hook?.(args[0]);
            return asyncAudit ? Promise.resolve(result) as unknown as typeof result : result;
        } };
    const transport = new HubTransportStore(db, { floor: { read: () => floor, raise(value) { floor = value; } },
        appendAudit(event, tx) { audit.appendInTransaction(event, tx); } });
    transport.initialize();
    expect(createHubRoleCutover({ db, hubId, root, realm: "corp", generation: "g1", migrations, transport,
        current: () => live, now: () => at, refreshAuthorization() { } }).migrate()).toMatchObject({ ok: true, changed: true });
    const policy = parseRolePolicy(JSON.parse((db.prepare("SELECT body FROM hub_group_policy").get() as {
        body: string;
    }).body));
    policy.assignments.push({ id: "owner", roleId: BUILTIN_ROLE_IDS.member, subject: { kind: "person", person: owner }, scope: { kind: "hub" },
        maxFleets: 2, startsAt: 0, expiresAt: null, assignedBy: root, assignedAt: at });
    db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(policy));
    const resource = { kind: "fleet" as const, id: randomUUID(), revision: 1, owner };
    transport.mutate({ at, requestId: randomUUID(), actor: { kind: "local-host" }, action: "synthetic.fleet", result: "completed" }, state => {
        state.fleets.push({ id: resource.id, owner, credentialHash: "c".repeat(64), generation: 1, status: "active" });
    });
    const body = { ...resource, ...(source === "code" ? { codeId: randomUUID(), approvedBy: root } : {}) };
    db.prepare("INSERT INTO hub_group_resources VALUES(?,?,?,'active',1)").run(JSON.stringify([resource.kind, resource.id, resource.revision]), JSON.stringify(body), source);
    const clock = createHubRoleAuthorizationClock({ db, hubId, realm: "corp", generation: "g1", root, transport, current: () => live, now: () => at });
    const facts = new Map<string, RolePersonFacts>([root, owner].map(who => [personKeyString(who), { kind: "eligible" as const, person: who, observedAt: at }]));
    let onRead: (() => void) | undefined, holdRead: (() => Promise<void>) | undefined, groupAnswer: ((who: PersonKey) => PolicyGroupFacts) | undefined;
    const people = [root, owner];
    const person = (who: typeof root) => ({ key: who, login: who.objectId, dn: "synthetic", groups: [] });
    const directory: HubDirectory = { realm: "corp", ...(ad ? { groupPolicy: "ad-direct-guid" as const, async readPolicyGroups(who: PersonKey) { return groupAnswer ? groupAnswer(who) : { kind: "complete" as const, person: who, groups: [], observedAt: at }; } } : {}), async checkEligibility(who) { onRead?.(); await holdRead?.(); return { eligible: true, person: person(who) }; },
        async signIn(login, password) { const who = people.find(p => p.objectId === login); return who && password === "synthetic" ? { ok: true, person: person(who) } : { ok: false, reason: "invalid-credentials" }; }, async close() { } };
    const reads = createHubDirectoryAdmission(() => live);
    const adapter = createHubRoleResourceEffects({ db, hubId, realm: "corp", generation: "g1", root, transport, audit,
        directory, reads, current: () => live, assertAuthorizationTime: clock.assertAuthorizationTime, now: () => at, elapsedNow: () => elapsed });
    const effects = adapter.write;
    const read = () => parseRolePolicy(JSON.parse((db.prepare("SELECT body FROM hub_group_policy").get() as {
        body: string;
    }).body));
    const prepare = (next: typeof policy) => effects.prepare(planRoleChange(read(), next, root, at), facts, () => {
        if (!live)
            throw Error("old owner");
    }, { actor: root, requestId: "effect-test" });
    const row = () => db.prepare("SELECT * FROM hub_group_resources").get() as {
        resource_key: string;
        body: string;
        source: string;
        state: string;
        revision: number;
    };
    const apply = async (next: typeof policy) => {
        const plan = planRoleChange(read(), next, root, at), p = await effects.prepare(plan, facts, () => {
            if (!live)
                throw Error("old owner");
        }, { actor: root, requestId: "effect-test" });
        db.transaction(() => { p.commit(db); db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify({ ...plan.next, revision: plan.before.revision + (plan.changed ? 1 : 0) })); p.assertCommitted(); }).immediate();
        return p;
    };
    const refresh = vi.fn(() => { expect(db.inTransaction).toBe(false); });
    const advance = (database: Database.Database) => {
        if (database !== db || !db.inTransaction)
            throw Error("foreign transaction");
        transport.mutate({ at, requestId: randomUUID(), actor: { kind: "local-host" }, action: "synthetic.role-version", result: "completed" }, s => { s.revocationVersion++; });
    };
    const options = { db, hubId, root, realm: "corp", generation: "g1", audit, directory, reads, current: () => live, version: () => transport.read().revocationVersion, advanceAuthorization: advance, refreshAuthorization: refresh, now: () => at };
    const core = new HubCore({ uow: createHubUnitOfWork(db), audit, content: audit.content, store: transport, directory, directoryReads: reads,
        pairing: new HubPairingService({ store: transport, directory, enabled: () => live, fenceFleet() { }, identity: { hubId, webOrigin: "https://hub.example.test", memberOrigin: "https://member.example.test", spkiSha256: "a".repeat(64), issuerPublicKey: "unused" } }),
        config: { hubId, name: "Synthetic", webOrigin: "https://hub.example.test", memberOrigin: "https://member.example.test", administrator: root }, issuer: { keyId: "unused", sign() { throw Error("unused"); } }, transport: () => null,
        current: () => ({ serverEnabled: () => live, memberEnabled: () => false, epoch: () => 0 }), now: () => at }, hubTxDatabase);
    const sessions = new HubSessions(core), browser = async (who = root) => { const s = await sessions.signIn(who.objectId, "synthetic"); return sessions.context({ headers: { cookie: `${hubCookieName(hubId)}=${s.token}` } } as IncomingMessage); };
    return { db, hubId, root, owner, policy, resource, body, audit, transport, clock, facts, effects, adapter, prepare, apply, row, read, directory, reads, options, browser, refresh,
        addPerson: (who: typeof root) => people.push(who), holdRead: (action: typeof holdRead) => { holdRead = action; }, asyncAudit: (value: boolean) => { asyncAudit = value; }, groupAnswer: (action: typeof groupAnswer) => { groupAnswer = action; }, elapsed: (n: number) => { elapsed = n; }, onRead: (action: typeof onRead) => { onRead = action; }, hook: (action: typeof hook) => { hook = action; },
        now: () => at, time: (n: number) => { at = n; }, stop: () => { live = false; } };
}
describe("S129 role resource effects contract", () => {
    it("suspends an exact active group resource after its role is removed", async () => {
        const w = world(), next = structuredClone(w.policy), before = w.row();
        next.assignments = [];
        const p = await w.prepare(next);
        w.db.transaction(() => { p.commit(w.db); p.assertCommitted(); }).immediate();
        expect(w.row()).toEqual({ ...before, state: "suspended", revision: 2 });
    });
    it("applies an explicit code-consent deny without changing its retained approver", async () => {
        const w = world("code"), next = structuredClone(w.policy), before = w.row();
        next.denies = [{ person: w.owner, deny: ["pair_fleet"] }];
        const p = await w.prepare(next);
        w.db.transaction(() => { p.commit(w.db); p.assertCommitted(); }).immediate();
        expect(w.row()).toEqual({ ...before, state: "suspended", revision: 2 });
        expect(JSON.parse(w.row().body).approvedBy).toEqual(w.root);
    });
    it("retains ordinary bytes when only management roles are turned off", async () => {
        const w = world(), next = structuredClone(w.policy), before = w.row();
        next.rolesActive = false;
        const p = await w.prepare(next);
        w.db.transaction(() => { p.commit(w.db); p.assertCommitted(); }).immediate();
        expect(w.row()).toEqual(before);
        expect(p.changed).toBe(false);
    });
});
describe("S129 exact resource effects and retirement", () => {
    it.each(["manual", "code"] as const)("keeps %s consent when self-service roles are removed", async (source) => {
        const w = world(source), next = structuredClone(w.policy), before = w.row();
        next.assignments = [];
        const p = await w.apply(next);
        expect(p.changed).toBe(false);
        expect(w.row()).toEqual(before);
    });
    it("keeps unknown membership held but an explicit deny still suspends", async () => {
        const w = world(), next = structuredClone(w.policy);
        next.assignments = [];
        w.facts.delete(personKeyString(w.owner));
        const p = await w.apply(next);
        expect(w.row().state).toBe("active");
        expect(p.impact).toMatchObject({ held: [{ reason: "membership-unknown" }] });
        const denied = w.read();
        denied.denies = [{ person: w.owner, deny: ["pair_fleet"] }];
        await w.apply(denied);
        expect(w.row().state).toBe("suspended");
    });
    it("does not resume a suspended resource when its role is restored", async () => {
        const w = world(), next = structuredClone(w.policy);
        next.assignments = [];
        await w.apply(next);
        const held = w.row();
        const restored = w.read();
        restored.assignments = w.policy.assignments;
        await w.apply(restored);
        expect(w.row()).toEqual(held);
    });
    it("grandfathers first activation without rewriting ordinary fleet bytes", async () => {
        const w = world("manual", "never-enabled");
        w.db.exec("DELETE FROM hub_group_resources");
        const ordinary = w.transport.read().fleets, next = w.read();
        next.state = "enabled";
        next.everEnabled = true;
        const p = await w.apply(next);
        expect(p.impact).toMatchObject({ capture: [JSON.stringify(["fleet", w.resource.id, 1])] });
        expect(w.row()).toMatchObject({ source: "manual", state: "active", revision: 1 });
        expect(w.transport.read().fleets).toEqual(ordinary);
    });
    it("refuses a group lifecycle row in a never-enabled first-activation image", async () => {
        const w = world("group", "never-enabled");
        const next = w.read();
        next.state = "enabled";
        next.everEnabled = true;
        await expect(w.prepare(next)).rejects.toThrow();
    });
    it.each(["manual", "code", "group"] as const)("narrows %s provenance on a known disabled owner", async (source) => {
        const w = world(source), next = structuredClone(w.policy);
        next.rolesActive = false;
        w.facts.set(personKeyString(w.owner), { kind: "ineligible", person: w.owner, reason: "disabled", observedAt: w.now() });
        await w.apply(next);
        expect(w.row()).toMatchObject({ source, state: "suspended", revision: 2 });
    });
    it("preserves the actual actor in required audit and keeps the audit chain valid", async () => {
        const w = world(), next = structuredClone(w.policy);
        next.assignments = [];
        await w.apply(next);
        const rows = w.db.prepare("SELECT actor,policy_version FROM hub_audit WHERE action='role.resource-suspended'").all() as {
            actor: string;
            policy_version: number;
        }[];
        expect(rows.map(r => ({ actor: JSON.parse(r.actor), version: r.policy_version }))).toEqual([{ actor: { kind: "person", person: w.root }, version: w.read().revision }]);
        expect(w.audit.verifyChain()).toMatchObject({ ok: true });
    });
    it.each(["ledger", "audit", "event", "late"] as const)("rolls back a required-audit %s mutation", async (mode) => {
        const w = world(), next = structuredClone(w.policy);
        next.assignments = [];
        const p = await w.prepare(next), before = w.db.serialize();
        w.hook(record => {
            if (!record.action.startsWith("role.resource"))
                return;
            if (mode === "ledger")
                w.db.prepare("UPDATE hub_group_resources SET revision=revision+1").run();
            if (mode === "audit")
                w.db.prepare("UPDATE hub_audit SET actor=? WHERE id=?").run(JSON.stringify({ kind: "local-host" }), record.id);
            if (mode === "event")
                w.db.prepare("INSERT INTO hub_group_resource_events VALUES(?,?)").run(record.id, "foreign-event");
            if (mode === "late")
                w.time(99);
        });
        expect(() => w.db.transaction(() => p.commit(w.db)).immediate()).toThrow();
        expect(w.db.serialize()).toEqual(before);
        w.hook(undefined);
        w.time(100);
        await expect(w.apply(next)).resolves.toBeDefined();
    });
    it("permanently retires a prepare after a policy ABA was observed", async () => {
        const w = world(), next = structuredClone(w.policy);
        next.assignments = [];
        const p = await w.prepare(next);
        const row = (w.db.prepare("SELECT body FROM hub_group_policy").get() as {
            body: string;
        }).body;
        w.db.prepare("UPDATE hub_group_policy SET body=json_set(body,'$.rolesActive',json('false'))").run();
        expect(() => p.assertCurrent()).toThrow();
        w.db.prepare("UPDATE hub_group_policy SET body=?").run(row);
        expect(() => w.db.transaction(() => p.commit(w.db)).immediate()).toThrow();
        await expect(w.apply(next)).resolves.toBeDefined();
    });
    it("refuses a missing audit provenance and a closed owner without writing", async () => {
        const w = world(), next = structuredClone(w.policy);
        next.assignments = [];
        const before = w.db.serialize(), plan = planRoleChange(w.policy, next, w.root, w.now());
        await expect(w.effects.prepare(plan, w.facts, () => { })).rejects.toThrow();
        expect(w.db.serialize()).toEqual(before);
        const p = await w.prepare(next);
        w.stop();
        expect(() => w.db.transaction(() => p.commit(w.db)).immediate()).toThrow();
        expect(w.db.serialize()).toEqual(before);
    });
});
function pausedExposure(w: ReturnType<typeof world>) {
    // Future-compatible raw-column fixture, not execution of M3015's Pause writer.
    w.db.exec("ALTER TABLE hub_exposures ADD COLUMN sharing_paused INTEGER NOT NULL DEFAULT 0;ALTER TABLE hub_exposures ADD COLUMN sharing_epoch INTEGER NOT NULL DEFAULT 0");
    const resource = { kind: "exposure" as const, id: randomUUID(), revision: 1, owner: w.owner };
    w.db.prepare("INSERT INTO hub_exposures(id,fleet_id,owner,display_name,revision,state,data_view_id,allowed_tools,policy_digest,updated_at,sharing_paused,sharing_epoch) VALUES(?,?,?,?,1,'published','agent','[]',?,100,1,7)")
        .run(resource.id, w.resource.id, personKeyString(w.owner), "Synthetic", "a".repeat(64));
    w.db.prepare("INSERT INTO hub_group_resources VALUES(?,?,'group','active',1)").run(JSON.stringify([resource.kind, resource.id, 1]), JSON.stringify(resource));
    const grant = randomUUID();
    w.db.prepare("INSERT INTO hub_grants(id,revision,owner,exposure_id,exposure_revision,approved_by,approved_at,subject,permissions,starts_at,expires_at,state) VALUES(?,1,?,?,1,?,100,?,?,0,1000,'active')")
        .run(grant, personKeyString(w.owner), resource.id, personKeyString(w.owner), personKeyString(w.root), JSON.stringify(["ask"]));
    return { resource, raw: () => w.db.prepare("SELECT * FROM hub_exposures WHERE id=?").get(resource.id), grant: () => w.db.prepare("SELECT * FROM hub_grants WHERE id=?").get(grant) };
}
describe("S129 ordinary sharing boundaries and actual writer/expiry", () => {
    it("preserves raw owner-pause fields and grants across role loss and restoration", async () => {
        const w = world(), e = pausedExposure(w), raw = e.raw(), grant = e.grant(), next = w.read();
        next.assignments = [];
        await w.apply(next);
        expect(e.raw()).toEqual(raw);
        expect(e.grant()).toEqual(grant);
        const restore = w.read();
        restore.assignments = w.policy.assignments;
        await w.apply(restore);
        expect(e.raw()).toEqual(raw);
        expect(e.grant()).toEqual(grant);
        expect(w.db.prepare("SELECT state FROM hub_group_resources WHERE resource_key=?").get(JSON.stringify(["exposure", e.resource.id, 1]))).toEqual({ state: "suspended" });
    });
    it("rolls back an owner-pause ABA observed during required audit", async () => {
        const w = world(), e = pausedExposure(w), next = w.read();
        next.assignments = [];
        const p = await w.prepare(next), before = w.db.serialize();
        w.hook(record => {
            if (record.action.startsWith("role.resource"))
                w.db.prepare("UPDATE hub_exposures SET sharing_paused=1,sharing_epoch=sharing_epoch+2 WHERE id=?").run(e.resource.id);
        });
        expect(() => w.db.transaction(() => p.commit(w.db)).immediate()).toThrow();
        expect(w.db.serialize()).toEqual(before);
    });
    it("commits a real preview/apply with the original actor while authentication freshness advances", async () => {
        const w = world(), ctx = await w.browser(), writer = createHubRoleWriter({ ...w.options, effects: w.effects }), next = w.read();
        next.assignments = [];
        w.onRead(() => w.time(w.now() + 1));
        const preview = await writer.preview(next, ctx);
        expect(preview).toMatchObject({ ok: true });
        if (!preview.ok)
            throw Error("preview refused");
        const result = await writer.apply(next, preview.previewDigest, ctx);
        expect(result).toMatchObject({ ok: true });
        expect(w.row().state).toBe("suspended");
        expect(w.refresh).toHaveBeenCalledOnce();
        expect(w.audit.verifyChain()).toMatchObject({ ok: true });
    });
    it("settles actual assignment expiry through the resource adapter without resuming later", async () => {
        const w = world(), p = w.read();
        p.assignments[0]!.expiresAt = 200;
        w.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(p));
        w.time(200);
        const expiry = createHubRoleExpirySettlement({ ...w.options, effects: { snapshot: w.effects.snapshot, prepare: w.adapter.prepareExpiry } });
        expect(await expiry.settle()).toEqual({ ok: true, settled: 1 });
        expect(w.row().state).toBe("suspended");
        expect(w.refresh).toHaveBeenCalledOnce();
        expect(await expiry.settle()).toEqual({ ok: true, settled: 0 });
        expect(w.refresh).toHaveBeenCalledOnce();
        expect(w.db.prepare("SELECT actor FROM hub_audit WHERE action='role.resource-suspended'").all()).toEqual([{ actor: JSON.stringify({ kind: "local-host" }) }]);
        expect(w.audit.verifyChain()).toMatchObject({ ok: true });
    });
});
describe("S129 expiry timing, physical ownership and audit controls", () => {
    it("keeps an auxiliary administrator as the real policy and resource audit actor", async () => {
        const w = world(), aux = { realm: "corp", objectId: randomUUID() };
        w.addPerson(aux);
        const before = w.read();
        before.assignments.push({ id: "aux-admin", roleId: BUILTIN_ROLE_IDS.admin, subject: { kind: "person", person: aux }, scope: { kind: "hub" }, maxFleets: 8, startsAt: 0, expiresAt: null, assignedBy: w.root, assignedAt: w.now() });
        w.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(before));
        const writer = createHubRoleWriter({ ...w.options, effects: w.effects }), ctx = await w.browser(aux), next = w.read();
        next.assignments = next.assignments.filter(a => a.id !== "owner");
        const preview = await writer.preview(next, ctx);
        if (!preview.ok)
            throw Error("auxiliary preview refused");
        expect(await writer.apply(next, preview.previewDigest, ctx)).toMatchObject({ ok: true });
        const rows = w.db.prepare("SELECT actor FROM hub_audit WHERE action IN ('role.resource-suspended','role.policy-changed')").all() as {
            actor: string;
        }[];
        expect(rows).toHaveLength(2);
        expect(rows.map(r => JSON.parse(r.actor))).toEqual([{ kind: "person", person: aux }, { kind: "person", person: aux }]);
    });
    it("rolls back when another person's assignment expires during the policy audit", async () => {
        const w = world(), before = w.read();
        before.assignments[0]!.expiresAt = 150;
        w.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(before));
        const writer = createHubRoleWriter({ ...w.options, effects: w.effects }), ctx = await w.browser(), next = w.read();
        next.rolesActive = false;
        const p = await writer.preview(next, ctx);
        if (!p.ok)
            throw Error("positive preview refused");
        const row = w.row(), version = w.transport.read().revocationVersion;
        w.hook(record => {
            if (record.action === "role.policy-changed")
                w.time(150);
        });
        expect(await writer.apply(next, p.previewDigest, ctx)).toMatchObject({ ok: false });
        expect(w.row()).toEqual(row);
        expect(w.read().rolesActive).toBe(true);
        expect(w.transport.read().revocationVersion).toBe(version);
        expect(w.refresh).not.toHaveBeenCalled();
    });
    it("holds the actual directory slot until an expiry observation settles", async () => {
        const w = world(), p = w.read();
        p.assignments[0]!.expiresAt = 200;
        w.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(p));
        w.time(200);
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>(r => { release = r; }), admitted = new Promise<void>(r => { entered = r; });
        w.holdRead(() => { entered(); return gate; });
        const preparation = w.adapter.prepareExpiry({ policy: p, expired: [p.assignments[0]!], at: 200 }, () => { });
        await admitted;
        const others = Array.from({ length: 3 }, () => w.reads.withDirectoryRead(w.root, () => gate));
        try {
            await expect(w.reads.withDirectoryRead(w.root, async () => true)).rejects.toBeInstanceOf(HubGroupReadOverload);
            release();
            await Promise.all(others);
            const prepared = await preparation;
            expect(prepared.changed).toBe(true);
        }
        finally {
            release();
            await Promise.allSettled([...others, preparation]);
        }
    });
    it("refuses a thenable required audit and a changed final receipt without retaining effects", async () => {
        const w = world(), next = w.read();
        next.assignments = [];
        let p = await w.prepare(next);
        const before = w.db.serialize();
        w.asyncAudit(true);
        expect(() => w.db.transaction(() => p.commit(w.db)).immediate()).toThrow();
        expect(w.db.serialize()).toEqual(before);
        w.asyncAudit(false);
        p = await w.prepare(next);
        expect(() => w.db.transaction(() => { p.commit(w.db); w.db.prepare("UPDATE hub_audit SET result='denied' WHERE action='role.resource-suspended'").run(); p.assertCommitted(); }).immediate()).toThrow();
        expect(w.db.serialize()).toEqual(before);
    });
    it("consumes an invalid commit attempt instead of reviving it in another transaction", async () => {
        const w = world(), next = w.read();
        next.assignments = [];
        const p = await w.prepare(next), foreign = new Database(":memory:");
        try {
            expect(() => foreign.transaction(() => p.commit(foreign)).immediate()).toThrow();
            expect(() => w.db.transaction(() => p.commit(w.db)).immediate()).toThrow();
        }
        finally {
            foreign.close();
        }
        await expect(w.apply(next)).resolves.toBeDefined();
    });
});
describe("S129 role impact and final owner boundaries", () => {
    it("previews a new person's effective gains even before that person owns a resource", async () => {
        const w = world(), who = { realm: "corp", objectId: randomUUID() }, next = w.read();
        w.facts.set(personKeyString(who), { kind: "eligible", person: who, observedAt: w.now() });
        next.assignments.push({ id: "new-person", roleId: BUILTIN_ROLE_IDS.member, subject: { kind: "person", person: who }, scope: { kind: "hub" }, maxFleets: 1, startsAt: 0, expiresAt: null, assignedBy: w.root, assignedAt: w.now() });
        const p = await w.prepare(next);
        expect(p.impact).toMatchObject({ peopleChanges: [{ person: who, gained: expect.arrayContaining(["ask_agents", "publish_agents", "pair_fleet"]) }] });
        expect(p.changed).toBe(false);
    });
    it("reports the effective MAX quota reduction without stopping an existing allowed Fleet", async () => {
        const w = world(), next = w.read();
        next.assignments[0]!.maxFleets = 1;
        const before = w.row(), p = await w.apply(next);
        expect(p.impact).toMatchObject({ peopleChanges: [{ person: w.owner, fleetLimit: { before: 2, after: 1 } }] });
        expect(w.row()).toEqual(before);
    });
    it("closes a held expiry read without releasing its physical slot early", async () => {
        const w = world(), p = w.read();
        p.assignments[0]!.expiresAt = 200;
        w.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(p));
        w.time(200);
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>(r => { release = r; }), admitted = new Promise<void>(r => { entered = r; });
        w.holdRead(() => { entered(); return gate; });
        const result = w.adapter.prepareExpiry({ policy: p, expired: [p.assignments[0]!], at: 200 }, () => { }).then(() => "allowed", () => "refused");
        await admitted;
        w.adapter.close();
        let drained = false;
        const draining = w.reads.drain().then(() => { drained = true; });
        await Promise.resolve();
        expect(drained).toBe(false);
        release();
        expect(await result).toBe("refused");
        await draining;
        expect(drained).toBe(true);
        expect(w.row().state).toBe("active");
    });
});
describe("S129 normalized-history and clock boundaries", () => {
    it.each(["ledger", "event"] as const)("retains exact unrelated %s history through required audit", async (mode) => {
        const w = world(), next = w.read();
        next.assignments = [];
        const ghost = { ...w.resource, id: randomUUID() }, ghostKey = JSON.stringify(["fleet", ghost.id, 1]);
        const historical = (w.db.prepare("SELECT id FROM hub_audit WHERE action='role.migrated'").get() as {
            id: string;
        }).id;
        if (mode === "ledger")
            w.db.prepare("INSERT INTO hub_group_resources VALUES(?,?,'manual','active',1)").run(ghostKey, JSON.stringify(ghost));
        else
            w.db.prepare("INSERT INTO hub_group_resource_events VALUES(?,?)").run(historical, "historical-event");
        const p = await w.prepare(next), before = w.db.serialize();
        w.hook(record => {
            if (!record.action.startsWith("role.resource"))
                return;
            if (mode === "ledger")
                w.db.prepare("UPDATE hub_group_resources SET state='suspended',revision=revision+1 WHERE resource_key=?").run(ghostKey);
            else
                w.db.prepare("UPDATE hub_group_resource_events SET body='rewritten-history' WHERE id=?").run(historical);
        });
        expect(() => w.db.transaction(() => p.commit(w.db)).immediate()).toThrow();
        expect(w.db.serialize()).toEqual(before);
    });
    it("requires the real persisted clock before preparing a narrowing", async () => {
        const w = world(), next = w.read();
        next.assignments = [];
        w.db.prepare("INSERT INTO hub_role_expiry_terms VALUES(?,?,?,?,?)").run(randomUUID(), "synthetic-floor", 200, randomUUID(), 200);
        await expect(w.prepare(next)).rejects.toThrow();
        w.time(200);
        await expect(w.apply(next)).resolves.toBeDefined();
    });
    it("refuses a foreign database argument even inside the actual owning transaction", async () => {
        const w = world(), next = w.read();
        next.assignments = [];
        const p = await w.prepare(next), foreign = new Database(":memory:"), before = w.db.serialize();
        try {
            expect(() => w.db.transaction(() => p.commit(foreign)).immediate()).toThrow();
            expect(w.db.serialize()).toEqual(before);
        }
        finally {
            foreign.close();
        }
    });
});
describe("S129 fresh observation and monotonic retirement", () => {
    it("keeps an old AD observation unknown instead of treating it as a new expiry refusal", async () => {
        const w = world("group", "enabled", true), p = w.read();
        p.assignments[0]!.expiresAt = 200;
        w.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(p));
        w.time(200);
        w.groupAnswer(who => ({ kind: "complete", person: who, groups: [], observedAt: 199 }));
        const prepared = await w.adapter.prepareExpiry({ policy: p, expired: [p.assignments[0]!], at: 200 }, () => { });
        expect(prepared.changed).toBe(false);
        expect(prepared.impact).toMatchObject({ held: [{ reason: "membership-unknown" }] });
        expect(w.row().state).toBe("active");
    });
    it("retires an effect after its monotonic preparation budget without reviving it", async () => {
        const w = world(), next = w.read();
        next.assignments = [];
        const p = await w.prepare(next);
        w.elapsed(20000);
        expect(() => p.assertCurrent()).toThrow();
        w.elapsed(0);
        expect(() => w.db.transaction(() => p.commit(w.db)).immediate()).toThrow();
        await expect(w.apply(next)).resolves.toBeDefined();
    });
});
