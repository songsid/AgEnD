/** Actual SQL, sessions, transport floor and expiry clock; inert directory, no mounted role routes. */
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { afterEach, vi } from "vitest";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../../src/hub/audit/index.js";
import { applyHubMigrations, bindHubInstance, createHubUnitOfWork, hubTxDatabase } from "../../src/hub/db.js";
import { HUB_GROUP_RESOURCES_MIGRATION } from "../../src/hub/group-policy/resources.js";
import { createHubGroupPolicyStore, groupPolicyMigration } from "../../src/hub/group-policy/store.js";
import { HubCore } from "../../src/hub/http/core.js";
import { HUB_HTTP_MIGRATIONS } from "../../src/hub/http/compose.js";
import { HubPairingService } from "../../src/hub/pairing.js";
import { createHubManagementAuthority } from "../../src/hub/roles/authority.js";
import { createHubRoleExpirySettlement, HUB_ROLE_EXPIRY_MIGRATION } from "../../src/hub/roles/expiry.js";
import { builtinRoles, BUILTIN_ROLE_IDS, type HubRolePolicy } from "../../src/hub/roles/model.js";
import { HUB_ROLE_WRITER_MIGRATION } from "../../src/hub/roles/writer.js";
import { HubSessions, hubCookieName } from "../../src/hub/sessions.js";
import { HubTransportStore, HUB_TRANSPORT_MIGRATION } from "../../src/hub/store.js";
import type { Eligibility, HubDirectory } from "../../src/hub/directory/types.js";
import type { PersonKey } from "../../src/hub/types.js";
import { createHubRoleCutover } from "../../src/hub/roles/cutover.js";
import { roleCutoverLegacyPlan } from "./hub-role-cutover-plan.js";

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); vi.restoreAllMocks(); });
const key = (): PersonKey => ({ realm: "corp", objectId: randomUUID() });
export async function roleAuthorityWorld(input: { hubId?: string; cutover?: boolean } = {}) {
  const db = new Database(":memory:"); dbs.push(db); db.pragma("foreign_keys=ON"); const hubId = input.hubId ?? randomUUID();
  const migrations = roleCutoverLegacyPlan(hubId);
  if (input.cutover) { applyHubMigrations(db, migrations); bindHubInstance(db, hubId, "new", 100); }
  else for (const m of [HUB_AUDIT_MIGRATION, HUB_TRANSPORT_MIGRATION, ...HUB_HTTP_MIGRATIONS,
    groupPolicyMigration(hubId, "corp", "g1"), HUB_GROUP_RESOURCES_MIGRATION, HUB_ROLE_WRITER_MIGRATION, HUB_ROLE_EXPIRY_MIGRATION]) m.up(db);
  const root = key(), admin = key(), other = key(); let time = 100, elapsed = 0, live = true, floor = 0;
  const audit = createHubAudit({ db, contentKey: randomBytes(32), now: () => time });
  const store = new HubTransportStore(db, { floor: { read: () => floor, raise: n => { floor = n; } },
    appendAudit(event, tx) { audit.appendInTransaction(event, tx); } }); store.initialize();
  const legacyRaw = (db.prepare("SELECT body FROM hub_group_policy").get() as { body: string }).body;
  if (input.cutover) {
    const result = createHubRoleCutover({ db, hubId, root, realm: "corp", generation: "g1", migrations,
      transport: store, current: () => live, now: () => time, refreshAuthorization() {} }).migrate();
    if (!result.ok || !result.changed) throw Error("fixture actual cutover failed");
  }
  const person = (who: PersonKey) => ({ key: structuredClone(who), login: who.objectId, dn: "CN=Synthetic", groups: [] });
  const eligible = vi.fn(async (who: PersonKey): Promise<Eligibility> => ({ eligible: true, person: person(who) }));
  const directory: HubDirectory = { realm: "corp", checkEligibility: eligible,
    async signIn(login, password) { const who = [root, admin, other].find(who => who.objectId === login);
      return who && password === "synthetic" ? { ok: true, person: person(who) } : { ok: false, reason: "invalid-credentials" }; }, async close() {} };
  let expiry: ReturnType<typeof createHubRoleExpirySettlement> | undefined;
  const pool = createHubGroupPolicyStore({ db, hubId, realm: "corp", generation: "g1", directory, audit, current: () => live, now: () => time, roles: { root, assertAuthorizationTime() { if (!expiry) throw Error("clock not installed"); expiry.assertAuthorizationTime(); } } });
  const policy: HubRolePolicy = { realm: "corp", generation: "g1", revision: 1, rolesActive: true, state: "enabled", everEnabled: true,
    roles: builtinRoles(), assignments: [{ id: "auxiliary", roleId: BUILTIN_ROLE_IDS.admin, subject: { kind: "person", person: admin }, scope: { kind: "hub" },
      maxFleets: null, startsAt: 0, expiresAt: null, assignedBy: root, assignedAt: 0 }], denies: [] };
  const save = (next: HubRolePolicy) => db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(next)); save(policy);
  const deps = { store, directory, config: { hubId, name: "Synthetic", memberOrigin: "https://member.example.test", webOrigin: "https://hub.example.test", administrator: root },
    uow: createHubUnitOfWork(db), audit, current: () => ({ serverEnabled: () => live, memberEnabled: () => false, epoch: () => 0 }), now: () => time,
    pairing: new HubPairingService({ store, directory, enabled: () => live, fenceFleet() {}, identity: { hubId, webOrigin: "https://hub.example.test",
      memberOrigin: "https://member.example.test", spkiSha256: "a".repeat(64), issuerPublicKey: "unused-synthetic" } }),
    issuer: { keyId: "unused", sign(): never { throw Error("unused"); } }, transport: () => null,
    content: { put(): never { throw Error("unused"); }, get() { return undefined; } },
  } satisfies ConstructorParameters<typeof HubCore>[0];
  const core = new HubCore(deps, hubTxDatabase), sessions = new HubSessions(core);
  const browser = async (who = admin) => { const signed = await sessions.signIn(who.objectId, "synthetic");
    return { ctx: sessions.context({ headers: { cookie: `${hubCookieName(hubId)}=${signed.token}` } } as IncomingMessage), token: signed.token }; };
  const ctx = await browser();
  const advance = () => store.mutate({ at: time, requestId: randomUUID(), actor: { kind: "local-host" }, action: "synthetic.epoch", result: "completed" }, state => { state.revocationVersion++; });
  expiry = createHubRoleExpirySettlement({ db, hubId, realm: "corp", generation: "g1", root, audit, directory, reads: pool,
    current: () => live, version: () => store.read().revocationVersion, now: () => time,
    advanceAuthorization: advance, refreshAuthorization() {},
    effects: { snapshot: () => ({ fingerprint: "unused", ordinaryFingerprint: "unused", people: [] }), async prepare(): Promise<never> { throw Error("unmounted"); } } });
  const options = { root, directory, reads: pool, policy: () => pool.canonical!(), current: () => live,
    version: () => store.read().revocationVersion, assertAuthorizationTime: expiry.assertAuthorizationTime, now: () => time, elapsedNow: () => elapsed };
  const authority = createHubManagementAuthority(options);
  return { db, hubId, audit, store, root, admin, other, policy, save, legacyRaw, directory, eligible, person, pool, core, sessions, browser, ctx, advance, options, authority,
    time: (ms: number) => { time += ms; }, elapsed: (ms: number) => { elapsed += ms; }, stop: () => { live = false; }, floor: () => { floor += 10; } };
}
