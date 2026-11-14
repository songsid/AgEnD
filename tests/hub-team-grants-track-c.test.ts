/** Actual HTTP/session/SQLite grant consumers; selected Team roster and inert directory, no external AD. */
import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { HubCore } from "../src/hub/http/core.js";
import { HubSessions } from "../src/hub/sessions.js";
import { grantOf, HubCatalogService } from "../src/hub/catalog.js";
import { personKeyString } from "../src/hub/identity.js";
import { HubProtocolError } from "../src/hub/validation.js";
import { createHubTeams, HUB_TEAMS_MIGRATION, HUB_TEAM_GRANTS_MIGRATION } from "../src/hub/teams/index.js";
import { HUB_GROUP_RESOURCES_MIGRATION } from "../src/hub/group-policy/resources.js";
import { createHubGroupAdminInventory } from "../src/hub/group-policy/admin-inventory.js";
import { createHubGroupImpactInventory } from "../src/hub/group-policy/impact-inventory.js";

type Rig = Awaited<ReturnType<typeof s3bRig>>;
const rigs: Rig[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); });
async function world() {
  let at = Date.now();
  const r = await s3bRig({ now: () => at }); rigs.push(r);
  const owner = r.addPerson("olivia"), recipient = r.addPerson("alex"), outsider = r.addPerson("other");
  const department = randomUUID();
  r.directory.checkPolicyGroup = async key => ({ ok: true, group: { key, dn: "CN=Engineering,DC=example,DC=test" } });
  r.httpDeps.uow.atomic(tx => { HUB_TEAMS_MIGRATION.up(r.sql(tx)); HUB_TEAM_GRANTS_MIGRATION.up(r.sql(tx)); });
  const core = new HubCore(r.httpDeps, r.sql), teams = createHubTeams(core), sessions = new HubSessions(core);
  r.httpDeps.roomTeams = teams; r.httpDeps.roomTeamCandidates = teams.candidates;
  const browser = await r.signIn("olivia"), asker = await r.signIn("alex"), other = await r.signIn("other"), admin = await r.signIn("admin");
  const ctx = sessions.context({ headers: { cookie: admin.cookie } } as IncomingMessage);
  const team = await teams.create(ctx, { name: "Project", department, lead: personKeyString(owner), members: [personKeyString(recipient)] });
  const exposureId = randomUUID(), link = r.link(randomUUID(), owner);
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [{ id: exposureId, fleetId: link.fleetId, owner,
    displayName: "Shared agent", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) }] }, link) as never, link);
  const grant = (extra: Record<string, unknown> = {}, b = browser) => r.call(b, "POST", "/hub/v1/grants", {
    exposureId, exposureRevision: 1, days: 90, subject: { kind: "team", teamId: team.id }, ...extra });
  const read = (id: string) => grantOf(r.db.prepare("SELECT * FROM hub_grants WHERE id=?").get(id) as Parameters<typeof grantOf>[0]);
  return { r, core, teams, ctx, team, browser, asker, other, owner, recipient, outsider, exposureId, grant, read,
    now: () => at, advance: (ms: number) => { at += ms; } };
}

it("creates one immutable Team subject, caps new expiry at90d, and keeps the stored grant across Team rename", async () => {
  const w = await world();
  expect((await w.grant({ days: 91 })).status).toBe(400);
  expect((await w.grant({ subject: { kind: "team", teamId: "Project" } })).status).toBe(400);
  expect((await w.grant({}, w.other)).status).toBe(404);
  const out = await w.grant(); expect(out.status).toBe(200);
  expect(out.json.grant).toMatchObject({ subject: { kind: "team", teamId: w.team.id }, expiresAt: w.now() + 90 * 86_400_000 });
  const before = w.r.db.prepare("SELECT * FROM hub_grants WHERE id=?").get(out.json.grant.id);
  await w.teams.update(w.ctx, w.team.id, { name: "Renamed project" });
  const view = await w.r.call(w.browser, "GET", "/hub/v1/exposures"); expect(view.status).toBe(200);
  expect(view.json.mine[0].grants[0]).toMatchObject({ id: out.json.grant.id, subjectName: "Renamed project", subjectLabel: "Project" });
  expect(w.r.db.prepare("SELECT * FROM hub_grants WHERE id=?").get(out.json.grant.id)).toEqual(before);
});

it("live roster removal ends catalog visibility and access to an existing private conversation without changing its grant", async () => {
  const w = await world(), out = await w.grant(); expect(out.status).toBe(200);
  const room = await w.r.call(w.asker, "POST", "/hub/v1/rooms", { exposureId: w.exposureId, grantId: out.json.grant.id });
  expect(room.status).toBe(200);
  expect((await w.r.call(w.asker, "GET", "/hub/v1/exposures")).json.askable).toHaveLength(1);
  expect((await w.r.call(w.other, "GET", "/hub/v1/exposures")).json.askable).toEqual([]);
  await w.teams.update(w.ctx, w.team.id, { members: [personKeyString(w.owner)] });
  expect((await w.r.call(w.asker, "GET", "/hub/v1/exposures")).json.askable).toEqual([]);
  expect((await w.r.call(w.asker, "GET", `/hub/v1/rooms/${room.json.room.id}/messages`)).status).toBe(403);
  expect(w.read(out.json.grant.id)).toMatchObject({ state: "active", revision: 1, expiresAt: out.json.grant.expiresAt });
});

it("deleting the Team ends its future permission while preserving the recorded grant and room history", async () => {
  const w = await world(), out = await w.grant(); expect(out.status).toBe(200);
  const room = await w.r.call(w.asker, "POST", "/hub/v1/rooms", { exposureId: w.exposureId, grantId: out.json.grant.id });
  expect(room.status).toBe(200);
  await w.teams.remove(w.ctx, w.team.id);
  expect((await w.r.call(w.asker, "GET", "/hub/v1/exposures")).json.askable).toEqual([]);
  expect((await w.r.call(w.asker, "GET", `/hub/v1/rooms/${room.json.room.id}/messages`)).status).toBe(403);
  expect(w.read(out.json.grant.id)).toMatchObject({ state: "active", expiresAt: out.json.grant.expiresAt });
  expect(w.r.db.prepare("SELECT id FROM hub_rooms WHERE id=?").get(room.json.room.id)).toEqual({ id: room.json.room.id });
});

it("a finite durable operation proof needs its exact asker, current roster and provider, independently of a browser", async () => {
  const w = await world(), out = await w.grant(); expect(out.status).toBe(200);
  const grant = w.read(out.json.grant.id), ctx = { requestId: randomUUID(), current: () => true };
  const proof = await w.core.grantAccess([grant.id], w.recipient, ctx);
  expect(proof.allows(grant, w.recipient)).toBe(true); expect(proof.allows(grant, w.outsider)).toBe(false);
  await w.teams.update(w.ctx, w.team.id, { members: [personKeyString(w.owner)] });
  expect(() => proof.assertCurrent()).toThrow();
  const denied = await w.core.grantAccess([grant.id], w.recipient, ctx); expect(denied.allows(grant, w.recipient)).toBe(false);
  await w.teams.update(w.ctx, w.team.id, { members: [personKeyString(w.owner), personKeyString(w.recipient)] });
  const fresh = await w.core.grantAccess([grant.id], w.recipient, ctx); expect(fresh.allows(grant, w.recipient)).toBe(true);
  w.advance(5_000); expect(() => fresh.assertCurrent()).toThrow();
  const replaced = await w.core.grantAccess([grant.id], w.recipient, ctx);
  w.r.httpDeps.roomTeams = { ...w.teams, read: w.teams.read, expand: w.teams.expand, isMember: w.teams.isMember };
  expect(() => replaced.assertCurrent()).toThrow();
});

it("Team grant feedback is bounded, owner/exposure-scoped, and conveys no permission", async () => {
  const w = await world();
  const search = (browser = w.browser, revision = 1) => w.r.call(browser, "POST", `/hub/v1/exposures/${w.exposureId}/grant-subjects/search`,
    { exposureRevision: revision, kind: "team", q: "Pro" });
  expect((await search()).json).toEqual({ ok: true, teams: [{ id: w.team.id, name: "Project", people: 2 }], truncated: false });
  expect((await search(w.other)).status).toBe(404); expect((await search(w.browser, 2)).status).toBe(409);
  expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_grants").get()).toEqual({ n: 0 });
});

it("refuses a Team grant if its selected roster changes while the owner reauthentication is held", async () => {
  const w = await world(), catalog = new HubCatalogService(w.core);
  const ctx = new HubSessions(w.core).context({ headers: { cookie: w.browser.cookie } } as IncomingMessage);
  const current = ctx.current.bind(ctx);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  ctx.current = async () => { entered(); await held; return current(); };
  const changing = catalog.grant(ctx, { exposureId: w.exposureId, exposureRevision: 1, days: 7, subject: { kind: "team", teamId: w.team.id } });
  await started;
  await w.teams.update(w.ctx, w.team.id, { members: [personKeyString(w.owner)] }); release();
  await expect(changing).rejects.toMatchObject({ code: "conflict" });
  expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_grants").get()).toEqual({ n: 0 });
});

it("a Team owner grant remains ANDed with the Hub operational ask gate", async () => {
  const w = await world(), out = await w.grant(); expect(out.status).toBe(200);
  w.r.httpDeps.groups = { asker: async () => { throw new HubProtocolError("denied"); }, check: async () => ({ source: "legacy", assertCurrent() {} }) } as never;
  const view = await w.r.call(w.asker, "GET", "/hub/v1/exposures"); expect(view.status).toBe(200); expect(view.json.askable).toEqual([]);
  expect((await w.r.call(w.asker, "POST", "/hub/v1/rooms", { exposureId: w.exposureId, grantId: out.json.grant.id })).status).toBe(403);
});

it("retains immutable GUID validation when reading a group next to the new Team subject", async () => {
  const w = await world(), out = await w.grant(); expect(out.status).toBe(200);
  const row = w.r.db.prepare("SELECT * FROM hub_grants WHERE id=?").get(out.json.grant.id) as Parameters<typeof grantOf>[0];
  expect(() => grantOf({ ...row, subject_kind: "group", subject: "corp/not-a-guid" })).toThrow();
});

it("policy impact observes live Team grants for known Hub people only and invalidates a preview on roster change", async () => {
  const w = await world(), out = await w.grant(); expect(out.status).toBe(200);
  const unseen = w.r.addPerson("not-signed-in");
  await w.teams.update(w.ctx, w.team.id, { members: [personKeyString(w.owner), personKeyString(w.recipient), personKeyString(unseen)] });
  // The HTTP rig's current link is inert. The real inventory independently requires its exact active transport Fleet.
  const exposure = w.r.db.prepare("SELECT fleet_id FROM hub_exposures WHERE id=?").get(w.exposureId) as { fleet_id: string };
  w.r.store.mutate({ at: w.now(), requestId: randomUUID(), actor: { kind: "local-host" }, action: "test.fleet", result: "completed" }, state => {
    state.fleets.push({ id: exposure.fleet_id, owner: w.owner, credentialHash: "c".repeat(64), generation: 1, status: "active" });
  });
  HUB_GROUP_RESOURCES_MIGRATION.up(w.r.db);
  const inventory = createHubGroupAdminInventory({ db: w.r.db, transport: w.r.store, realm: "corp" });
  const impact = createHubGroupImpactInventory({ db: w.r.db, transport: w.r.store, administrator: w.r.admin, inventory,
    current: () => true, now: w.now });
  const before = impact.snapshot();
  expect(before.people.find(p => personKeyString(p.key) === personKeyString(w.recipient))?.hasAskGrant).toBe(true);
  expect(before.people.some(p => personKeyString(p.key) === personKeyString(unseen))).toBe(false);
  expect(w.r.db.prepare("SELECT 1 FROM hub_people WHERE person=?").get(personKeyString(unseen))).toBeUndefined();
  await w.teams.update(w.ctx, w.team.id, { members: [personKeyString(w.owner), personKeyString(unseen)] });
  const after = impact.snapshot();
  expect(after.people.find(p => personKeyString(p.key) === personKeyString(w.recipient))?.hasAskGrant).toBe(false);
  expect(after.ordinaryFingerprint).not.toBe(before.ordinaryFingerprint);
});
