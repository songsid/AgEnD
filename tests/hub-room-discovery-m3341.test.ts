import { groupPolicyMigration, createHubGroupPolicyStore, inspectHubGroupPolicyBinding } from "../src/hub/group-policy/store.js";
import { HUB_GROUP_RESOURCES_MIGRATION } from "../src/hub/group-policy/resources.js";
import { createHubGroupAuthorization } from "../src/hub/group-policy/authorization.js";
import { HubCore } from "../src/hub/http/core.js";
import { personKeyString } from "../src/hub/identity.js";
import { HUB_ROOM_AGENT_DISCOVERY_MIGRATION } from "../src/hub/room-agent-discovery-model.js";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { createHubRoomInvitations, HUB_ROOM_INVITATIONS_MIGRATION } from "../src/hub/invitations.js";
import { createHubRoomAgentRequests } from "../src/hub/room-agent-requests.js";

let rig: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { vi.restoreAllMocks(); await rig?.close(); rig = undefined; });
async function world() {
  const r = rig = await s3bRig({ realAudit: true });
  const owner = r.addPerson("example-owner", "Example owner"), manager = await r.signIn("admin"), browser = await r.signIn("example-owner");
  if (!r.db.prepare("SELECT 1 FROM sqlite_master WHERE name='hub_room_agent_discovery'").get()) HUB_ROOM_AGENT_DISCOVERY_MIGRATION.up(r.db);
  HUB_ROOM_INVITATIONS_MIGRATION.up(r.db); r.httpDeps.roomInvitations = createHubRoomInvitations;
  r.httpDeps.roomAgentRequests = createHubRoomAgentRequests; await r.restartHttp();
  const link = r.link(randomUUID(), owner), exposure = { id: randomUUID(), fleetId: link.fleetId, owner,
    displayName: "Example release helper", revision: 1, state: "published" as const, dataViewId: "agent", allowedTools: [], policyDigest: "c".repeat(64) };
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [exposure] }, link) as never, link);
  const created = await r.call(manager, "POST", "/hub/v1/rooms", { name: "Example project" }); expect(created.status).toBe(200);
  const room = created.json.room.id, path = `/hub/v1/exposures/${exposure.id}/room-discovery`;
  const settings = () => r.call(browser, "GET", path);
  const save = (findable: boolean, ifRevision: number, exposureRevision = 1) => r.call(browser, "PUT", path, { findable, ifRevision, exposureRevision });
  const candidates = () => r.call(manager, "GET", "/hub/v1/rooms/candidates?kind=agent&discovery=1&q=Example");
  const invite = () => r.call(manager, "POST", `/hub/v1/rooms/${room}/invitations`, { agents: [exposure.id] });
  return { r, owner, manager, browser, link, exposure, room, path, settings, save, candidates, invite };
}
it("defaults discovery off, then permits a room-only invitation without direct ask rights", async () => {
  const w = await world(), initial = await w.settings();
  expect(initial.status).toBe(200); expect(initial.json).toMatchObject({ findable: false, available: true, revision: 0, exposureRevision: 1 });
  expect((await w.candidates()).json.candidates).toEqual([]); expect((await w.invite()).status).toBe(404);
  const saved = await w.save(true, 0); expect(saved.status).toBe(200); expect(saved.json).toMatchObject({ findable: true, revision: 1 });
  const found = await w.candidates(); expect(found.status).toBe(200);
  expect(found.json.candidates).toMatchObject([{ id: w.exposure.id, name: w.exposure.displayName, discoverable: true, mine: false, owner: { name: "Example owner" } }]);
  expect((await w.r.call(w.manager, "GET", "/hub/v1/rooms/candidates?kind=agent&q=Example")).json.candidates).toEqual([]);
  const direct = await w.r.call(w.manager, "GET", "/hub/v1/exposures");
  expect(direct.json.askable).toEqual([]); expect(JSON.stringify(direct.json)).not.toContain(w.exposure.id);
  const invited = await w.invite(); expect(invited.status).toBe(200); expect(invited.json.invited).toHaveLength(1);
  expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_grants").get()).toEqual({ n: 0 });
  expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_room_members WHERE kind='agent'").get()).toEqual({ n: 0 });
});

it("keeps settings owner-only, revision-bound and protected by CSRF", async () => {
  const w = await world();
  expect((await w.r.call(w.manager, "GET", w.path)).status).toBe(404);
  expect((await w.r.call(w.manager, "PUT", w.path, { findable: true, ifRevision: 0, exposureRevision: 1 })).status).toBe(404);
  expect((await w.r.call(w.browser, "PUT", w.path, { findable: true, ifRevision: 0, exposureRevision: 1 }, { "X-AgEnD-Hub-CSRF": "wrong" })).status).toBe(403);
  expect((await w.r.call(w.browser, "PUT", w.path, { findable: true, ifRevision: 0, exposureRevision: 1, owner: w.owner })).status).toBe(400);
  expect((await w.save(true, 0, 2)).status).toBe(409);
  expect((await w.save(true, 7)).status).toBe(409);
  expect((await w.save(true, 0)).status).toBe(200);
  expect((await w.save(false, 0)).status).toBe(409);
  expect((await w.settings()).json).toMatchObject({ findable: true, revision: 1 });
});

it("owner opt-out suppresses discovery while retaining the per-agent choice", async () => {
  const w = await world(); expect((await w.save(true, 0)).status).toBe(200);
  expect((await w.r.call(w.browser, "PUT", "/hub/v1/me/agent-request-settings", { accepting: false })).status).toBe(200);
  expect((await w.settings()).json).toMatchObject({ findable: true, available: false, reason: "owner-disabled" });
  expect((await w.candidates()).json.candidates).toEqual([]); expect((await w.invite()).status).toBe(404);
  expect((await w.save(false, 1)).status).toBe(403);
  expect((await w.r.call(w.browser, "PUT", "/hub/v1/me/agent-request-settings", { accepting: true })).status).toBe(200);
  expect((await w.candidates()).json.candidates).toHaveLength(1);
  expect((await w.settings()).json).toMatchObject({ findable: true, revision: 1, available: true });
});

it("preserves ordinary askable invitations during opt-out without a discovery badge", async () => {
  const w = await world();
  expect((await w.r.call(w.browser, "POST", "/hub/v1/grants", { exposureId: w.exposure.id, exposureRevision: 1, login: "admin", days: 7 })).status).toBe(200);
  expect((await w.save(true, 0)).status).toBe(200);
  expect((await w.r.call(w.browser, "PUT", "/hub/v1/me/agent-request-settings", { accepting: false })).status).toBe(200);
  const rows = (await w.candidates()).json.candidates;
  expect(rows).toHaveLength(1); expect(rows[0]).not.toHaveProperty("discoverable");
  expect((await w.invite()).status).toBe(200);
});

it("switching discovery off preserves pending invitations and existing room membership", async () => {
  const w = await world(); expect((await w.save(true, 0)).status).toBe(200);
  const invited = await w.invite(); expect(invited.status).toBe(200);
  expect((await w.save(false, 1)).status).toBe(200);
  expect((await w.candidates()).json.candidates).toEqual([]); expect((await w.invite()).status).toBe(404);
  expect((await w.r.call(w.browser, "POST", `/hub/v1/invitations/${invited.json.invited[0].id}/accept`, {})).status).toBe(200);
  expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_room_members WHERE kind='agent'").get()).toEqual({ n: 1 });
  expect((await w.save(true, 2)).status).toBe(200); expect((await w.save(false, 3)).status).toBe(200);
  expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_room_members WHERE kind='agent'").get()).toEqual({ n: 1 });
});

it("hides paused or unshared agents, restores on resume and resets on a new publication revision", async () => {
  const w = await world(); expect((await w.save(true, 0)).status).toBe(200);
  w.r.db.prepare("UPDATE hub_exposures SET sharing_paused=1,sharing_epoch=sharing_epoch+1 WHERE id=?").run(w.exposure.id);
  expect((await w.settings()).json).toMatchObject({ findable: true, available: false, reason: "paused" });
  expect((await w.candidates()).json.candidates).toEqual([]);
  w.r.db.prepare("UPDATE hub_exposures SET sharing_paused=0,sharing_epoch=sharing_epoch+1 WHERE id=?").run(w.exposure.id);
  expect((await w.candidates()).json.candidates).toHaveLength(1);
  for (const state of ["frozen", "withdrawn"]) {
    w.r.db.prepare("UPDATE hub_exposures SET state=? WHERE id=?").run(state, w.exposure.id);
    expect((await w.settings()).json).toMatchObject({ findable: false, available: false, reason: "not-shared" });
    expect((await w.candidates()).json.candidates).toEqual([]);
  }
  w.r.db.prepare("UPDATE hub_exposures SET state='published',revision=2 WHERE id=?").run(w.exposure.id);
  expect((await w.settings()).json).toMatchObject({ findable: false, exposureRevision: 2, revision: 1 });
  expect((await w.candidates()).json.candidates).toEqual([]);
});

it("withholds a revoked Fleet's discoverable publication", async () => {
  const w = await world();
  w.r.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "fixture.fleet", result: "completed" }, state => {
    state.fleets.push({ id: w.exposure.fleetId, owner: w.owner, generation: 1, credentialHash: null, status: "active" });
  });
  expect((await w.save(true, 0)).status).toBe(200); expect((await w.candidates()).json.candidates).toHaveLength(1);
  w.r.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "fixture.revoke", result: "completed" }, state => {
    state.fleets.find(f => f.id === w.exposure.fleetId)!.status = "revoked";
  });
  expect((await w.candidates()).json.candidates).toEqual([]); expect((await w.invite()).status).toBe(404);
});

it("retires a picker selection after discovery is turned off and on during a held permission read", async () => {
  const w = await world(); expect((await w.save(true, 0)).status).toBe(200);
  const original = HubCore.prototype.groupExposure; let entered = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(HubCore.prototype, "groupExposure").mockImplementationOnce(async function (this: HubCore, ...args) {
    const permit = await original.apply(this, args); entered = true; await held; return permit;
  });
  const pending = w.candidates();
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    expect((await w.save(false, 1)).status).toBe(200); expect((await w.save(true, 2)).status).toBe(200);
  } finally { release(); }
  const result = await pending; expect(result.status).toBe(409); expect(JSON.stringify(result.json)).not.toContain(w.exposure.displayName);
  expect((await w.candidates()).json.candidates).toHaveLength(1);
});

it("does not disclose candidates after the requester's last manager permission ends", async () => {
  const w = await world(); expect((await w.save(true, 0)).status).toBe(200);
  const person = w.r.addPerson("example-manager"), who = await w.r.signIn("example-manager"), id = personKeyString(person);
  w.r.db.prepare("INSERT INTO hub_room_creators VALUES('person',?)").run(id);
  expect((await w.r.call(who, "POST", "/hub/v1/rooms", { name: "Another example project" })).status).toBe(200);
  w.r.db.prepare("DELETE FROM hub_room_creators WHERE subject=?").run(id);
  const original = HubCore.prototype.groupExposure; let entered = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(HubCore.prototype, "groupExposure").mockImplementationOnce(async function (this: HubCore, ...args) {
    const permit = await original.apply(this, args); entered = true; await held; return permit;
  });
  const pending = w.r.call(who, "GET", "/hub/v1/rooms/candidates?kind=agent&discovery=1&q=Example");
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    w.r.db.prepare("DELETE FROM hub_room_members WHERE kind='person' AND subject=?").run(id);
  } finally { release(); }
  const result = await pending; expect(result.status).toBe(403); expect(JSON.stringify(result.json)).not.toContain(w.exposure.displayName);
});

it("rechecks the owner's opt-out after a held setting permission read", async () => {
  const w = await world(), original = HubCore.prototype.groupExposure;
  let entered = false, release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(HubCore.prototype, "groupExposure").mockImplementationOnce(async function (this: HubCore, ...args) {
    const permit = await original.apply(this, args); entered = true; await held; return permit;
  });
  const pending = w.save(true, 0);
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    expect((await w.r.call(w.browser, "PUT", "/hub/v1/me/agent-request-settings", { accepting: false })).status).toBe(200);
  } finally { release(); }
  expect((await pending).status).toBe(409);
  expect((await w.settings()).json).toMatchObject({ findable: false, revision: 0 });
});

it("rolls back a named invitation when its discovery permission changes inside the final transaction", async () => {
  const w = await world(); expect((await w.save(true, 0)).status).toBe(200);
  const original = w.r.httpDeps.audit.append;
  vi.spyOn(w.r.httpDeps.audit, "append").mockImplementation((tx, record) => {
    original(tx, record);
    if (record.action === "room.invitation-created") w.r.db.prepare("UPDATE hub_room_agent_discovery SET findable=0,revision=revision+1 WHERE exposure_id=?").run(w.exposure.id);
  });
  expect((await w.invite()).status).toBe(409);
  expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_room_invitations").get()).toEqual({ n: 0 });
  expect((await w.settings()).json).toMatchObject({ findable: true, revision: 1 });
});

it("keeps a legacy schema's capability and routes absent", async () => {
  const w = await world();
  expect((await w.r.call(w.browser, "GET", "/hub/v1/session")).json.features).toContain("room-agent-discovery-v1");
  w.r.db.exec("DROP TABLE hub_room_agent_discovery"); await w.r.restartHttp();
  expect((await w.r.call(w.browser, "GET", "/hub/v1/session")).json.features).not.toContain("room-agent-discovery-v1");
  expect((await w.settings()).status).toBe(404);
  expect((await w.candidates()).json.candidates).toEqual([]);
});

it("rechecks real group permission before committing the owner switch", async () => {
  const w = await world(), r = w.r, group = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", now = () => Date.now();
  r.store.mutate({ requestId: randomUUID(), at: now(), actor: { kind: "local-host" }, action: "fixture.fleet", result: "completed" }, state => {
    state.fleets.push({ id: w.exposure.fleetId, owner: w.owner, generation: 1, credentialHash: null, status: "active" });
  });
  groupPolicyMigration(r.hubId, "corp", "generation-1").up(r.db); HUB_GROUP_RESOURCES_MIGRATION.up(r.db);
  Object.assign(r.directory, { groupPolicy: "ad-direct-guid", readPolicyGroups: async (person: typeof w.owner) => ({ kind: "complete", person, groups: [group], observedAt: now() }) });
  const audit = r.auditStore!, current = () => true, context = { requestId: randomUUID(), current };
  const policy = createHubGroupPolicyStore({ db: r.db, hubId: r.hubId, realm: "corp", generation: "generation-1", directory: r.directory, audit, current, now });
  policy.replace({ ...policy.read(), state: "enabled", groups: [{ group: { realm: "corp", objectId: group }, dn: "CN=Example,DC=example,DC=test", allow: ["publish_agents", "pair_fleet"], maxFleets: 2 }] }, r.admin, context);
  const actions = createHubGroupAuthorization({ db: r.db, administrator: r.admin, policy: () => policy,
    binding: () => inspectHubGroupPolicyBinding(r.db, r.hubId, "corp", "generation-1"), audit, current, now,
    version: () => r.store.read().revocationVersion, advanceAuthorization: () => {}, refreshAuthorization: () => {} });
  await actions.enroll({ kind: "fleet", id: w.exposure.fleetId, revision: 1, owner: w.owner }, context);
  await actions.enroll({ kind: "exposure", id: w.exposure.id, revision: 1, owner: w.owner }, context); r.httpDeps.groups = actions;
  const original = HubCore.prototype.groupExposure; let entered = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(HubCore.prototype, "groupExposure").mockImplementationOnce(async function (this: HubCore, ...args) {
    const permit = await original.apply(this, args); entered = true; await held; return permit;
  });
  const pending = w.save(true, 0);
  try { await vi.waitFor(() => expect(entered).toBe(true)); policy.replace({ ...policy.read(), groups: [] }, r.admin, context); }
  finally { release(); }
  expect((await pending).status).toBe(503); expect((await w.settings()).json).toMatchObject({ findable: false, revision: 0 });
});

it("applies the same discovery visibility to team expansion without an omitted-agent count", async () => {
  const w = await world(); expect((await w.save(true, 0)).status).toBe(200);
  const link = w.r.link(randomUUID(), w.owner), hidden = { ...w.exposure, id: randomUUID(), fleetId: link.fleetId, displayName: "Hidden example helper" };
  await w.r.http.receive(w.r.frame("exposure.snapshot", { revision: 1, exposures: [hidden] }, link) as never, link);
  const team = randomUUID();
  w.r.httpDeps.roomTeams = { read: () => null, isMember: () => null, expand: (_db, ids) => ({ teams: ids.map(id => ({ id, revision: 1 })), people: [personKeyString(w.owner)], missing: [] }) };
  const first = await w.r.call(w.manager, "POST", `/hub/v1/rooms/${w.room}/invitations`, { team });
  expect(first.status).toBe(200); expect(first.json.invited).toHaveLength(1);
  expect(first.json.invited[0].exposureId).toBe(w.exposure.id); expect(JSON.stringify(first.json)).not.toContain(hidden.id);
  expect((await w.r.call(w.browser, "PUT", "/hub/v1/me/agent-request-settings", { accepting: false })).status).toBe(200);
  const second = await w.r.call(w.manager, "POST", `/hub/v1/rooms/${w.room}/invitations`, { team });
  expect(second.status).toBe(200); expect(second.json).toEqual({ invited: [] });
  expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_room_invitations").get()).toEqual({ n: 1 });
});

it("does not let discovery opt-out interrupt an already askable invitation", async () => {
  const w = await world();
  expect((await w.r.call(w.browser, "POST", "/hub/v1/grants", { exposureId: w.exposure.id, exposureRevision: 1, login: "admin", days: 7 })).status).toBe(200);
  expect((await w.save(true, 0)).status).toBe(200);
  const original = HubCore.prototype.groupExposure; let entered = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(HubCore.prototype, "groupExposure").mockImplementationOnce(async function (this: HubCore, ...args) {
    const permit = await original.apply(this, args); entered = true; await held; return permit;
  });
  const pending = w.invite();
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    expect((await w.r.call(w.browser, "PUT", "/hub/v1/me/agent-request-settings", { accepting: false })).status).toBe(200);
  } finally { release(); }
  expect((await pending).status).toBe(200);
});
