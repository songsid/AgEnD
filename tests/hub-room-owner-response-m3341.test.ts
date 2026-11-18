import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import type { HubCore } from "../src/hub/http/core.js";
import type { PersonKey } from "../src/hub/types.js";
import { createHubRoomAgentRequests, HUB_ROOM_AGENT_REQUESTS_MIGRATION, ROOM_AGENT_REQUEST_TTL } from "../src/hub/room-agent-requests.js";
import { groupPolicyMigration, createHubGroupPolicyStore, inspectHubGroupPolicyBinding } from "../src/hub/group-policy/store.js";
import { HUB_GROUP_RESOURCES_MIGRATION } from "../src/hub/group-policy/resources.js";
import { createHubGroupAuthorization } from "../src/hub/group-policy/authorization.js";

let rig: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { vi.restoreAllMocks(); await rig?.close(); rig = undefined; });
async function world() {
  let now = Date.UTC(2026, 10, 19, 12);
  const r = rig = await s3bRig({ realAudit: true, now: () => now });
  const owner = r.addPerson("example-owner", "Example owner"), other = r.addPerson("example-other", "Other owner");
  const manager = await r.signIn("admin"), browser = await r.signIn("example-owner"), outsider = await r.signIn("example-other");
  if (!r.db.prepare("SELECT 1 FROM sqlite_master WHERE name='hub_room_agent_requests'").get()) HUB_ROOM_AGENT_REQUESTS_MIGRATION.up(r.db);
  let core!: HubCore;
  r.httpDeps.roomAgentRequests = (c, host) => { core = c; return createHubRoomAgentRequests(c, host); };
  await r.restartHttp();
  const made = await r.call(manager, "POST", "/hub/v1/rooms", { name: "Example project" });
  expect(made.status).toBe(200); const roomId = made.json.room.id;
  const sent = await r.call(manager, "POST", "/hub/v1/rooms/" + roomId + "/agent-requests", {
    owner: personKeyString(owner), note: "The agent for release notes", idempotencyKey: randomUUID(),
  });
  expect(sent.status).toBe(200); const id = sent.json.request.id, path = "/hub/v1/agent-requests/" + id;
  const publish = async (person: PersonKey, name: string) => {
    const link = r.link(randomUUID(), person), exposure = { id: randomUUID(), fleetId: link.fleetId, owner: person,
      displayName: name, state: "published" as const, revision: 1, dataViewId: "example", allowedTools: [], policyDigest: "c".repeat(64) };
    await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [exposure] }, link) as never, link);
    return exposure;
  };
  const shared = await publish(owner, "Release helper"), unshared = await publish(owner, "Scratch helper"), foreign = await publish(other, "Other helper");
  r.db.prepare("UPDATE hub_exposures SET state='withdrawn' WHERE id=?").run(unshared.id);
  const accept = (body: unknown = { exposureId: shared.id, revision: 1 }, who = browser) => r.call(who, "POST", path + "/accept", body);
  const row = () => r.db.prepare("SELECT * FROM hub_room_agent_requests WHERE id=?").get(id) as any;
  const members = () => r.db.prepare("SELECT * FROM hub_room_members WHERE room_id=? AND kind='agent'").all(roomId);
  return { r, owner, other, manager, browser, outsider, id, roomId, path, shared, unshared, foreign, accept, row, members,
    get core() { return core; }, now: () => now, setNow: (value: number) => { now = value; } };
}

it("shows only the recipient's choices and adds one shared agent without a direct grant or owner membership", async () => {
  const w = await world();
  const view = await w.r.call(w.browser, "GET", w.path);
  expect(view.status).toBe(200);
  expect(view.json.request).toMatchObject({ note: "The agent for release notes", room: { id: w.roomId, people: 1 } });
  expect(view.json.choices.find((x: any) => x.exposureId === w.shared.id)).toMatchObject({ name: "Release helper", canAdd: true, revision: 1 });
  expect(view.json.choices.find((x: any) => x.exposureId === w.unshared.id)).toMatchObject({ name: "Scratch helper", canAdd: false, shared: false });
  expect(JSON.stringify(view.json)).not.toContain(w.foreign.id);
  expect((await w.r.call(w.outsider, "GET", w.path)).status).toBe(404);
  expect((await w.r.call(w.manager, "GET", w.path)).status).toBe(404);
  expect((await w.accept()).status).toBe(200);
  expect(w.row()).toMatchObject({ state: "accepted", exposure_id: w.shared.id });
  expect(w.members()).toHaveLength(1);
  expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_grants").get()).toEqual({ n: 0 });
  expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_room_members WHERE room_id=? AND kind='person' AND subject=?").get(w.roomId, personKeyString(w.owner))).toEqual({ n: 0 });
  expect((await w.accept()).status).toBe(200); expect(w.members()).toHaveLength(1);
});

it("refuses unshared, foreign, stale and supplied-authority targets without changing membership", async () => {
  const w = await world();
  expect((await w.accept({ exposureId: w.unshared.id, revision: 1 })).status).toBe(409);
  expect((await w.accept({ exposureId: w.foreign.id, revision: 1 })).status).toBe(404);
  expect((await w.accept({ exposureId: w.shared.id, revision: 2 })).status).toBe(409);
  expect((await w.accept({ exposureId: w.shared.id, revision: 1, owner: personKeyString(w.owner) })).status).toBe(400);
  expect((await w.accept(undefined, w.outsider)).status).toBe(404);
  expect(w.row().state).toBe("pending"); expect(w.members()).toEqual([]);
});

it("keeps a pending request answerable after the owner turns off new requests", async () => {
  const w = await world();
  expect((await w.r.call(w.browser, "PUT", "/hub/v1/me/agent-request-settings", { accepting: false })).status).toBe(200);
  expect((await w.accept()).status).toBe(200);
  expect(w.row().state).toBe("accepted");
});

it("counts requests only for their owner and only for an opted-in rooms reader", async () => {
  const w = await world();
  expect((await w.r.call(w.browser, "GET", "/hub/v1/rooms?v=2")).json.invitations).toBe(0);
  expect((await w.r.call(w.browser, "GET", "/hub/v1/rooms?v=2&ownerRequests=1")).json.invitations).toBe(1);
  expect((await w.r.call(w.outsider, "GET", "/hub/v1/rooms?v=2&ownerRequests=1")).json.invitations).toBe(0);
  expect((await w.r.call(w.browser, "POST", w.path + "/decline", {})).status).toBe(200);
  expect((await w.r.call(w.browser, "GET", "/hub/v1/rooms?v=2&ownerRequests=1")).json.invitations).toBe(0);
});

it("lets only the owner decline, privately and idempotently", async () => {
  const w = await world();
  expect((await w.r.call(w.outsider, "POST", w.path + "/decline", {})).status).toBe(404);
  expect((await w.r.call(w.browser, "POST", w.path + "/decline", {})).status).toBe(200);
  expect((await w.r.call(w.browser, "POST", w.path + "/decline", {})).status).toBe(200);
  expect((await w.accept()).status).toBe(404);
  const manager = await w.r.call(w.manager, "GET", "/hub/v1/rooms/" + w.roomId + "/agent-requests");
  expect(manager.json.requests[0].state).toBe("declined");
  expect(JSON.stringify(manager.json)).not.toMatch(/Release helper|Scratch helper|release notes/);
  expect(w.members()).toEqual([]);
});

it.each(["cancel", "expiry"])("does not add an agent after %s wins", async state => {
  const w = await world();
  if (state === "cancel") expect((await w.r.call(w.manager, "DELETE", "/hub/v1/rooms/" + w.roomId + "/agent-requests/" + w.id)).status).toBe(200);
  else { w.setNow(w.now() + ROOM_AGENT_REQUEST_TTL); w.browser = await w.r.signIn("example-owner"); }
  expect((await w.r.call(w.browser, "POST", w.path + "/accept", { exposureId: w.shared.id, revision: 1 })).status).toBe(404);
  expect(w.row().state).toBe(state === "cancel" ? "cancelled" : "expired");
  expect(w.members()).toEqual([]);
});

it.each(["publication", "request"])("rechecks the %s after a held permission read", async changed => {
  const w = await world(), original = w.core.groupExposure.bind(w.core);
  let release!: () => void, entered = false;
  const hold = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(w.core, "groupExposure").mockImplementation(async (...args) => {
    const permit = await original(...args); entered = true; await hold; return permit;
  });
  const attempt = w.accept();
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    if (changed === "publication") w.r.db.prepare("UPDATE hub_exposures SET revision=2 WHERE id=?").run(w.shared.id);
    else w.r.db.prepare("UPDATE hub_room_agent_requests SET state='cancelled' WHERE id=?").run(w.id);
  } finally { release(); }
  expect((await attempt).status).toBe(changed === "publication" ? 409 : 404);
  expect(w.members()).toEqual([]);
  expect(w.row().state).toBe(changed === "publication" ? "pending" : "cancelled");
});

it.each(["missing", "mismatched"])("refuses retention before deleting when a pending hint has a %s request anchor", async anchor => {
  const w = await world(), ref = w.row().note_ref;
  expect(w.r.http.retainedContentRefs!()).toContain(ref);
  const noise = w.core.atomic((_db, tx) => {
    const ref = w.core.deps.content.put(tx, { question: "Unrelated old hint" });
    w.core.audit(tx, { requestId: randomUUID(), actor: { kind: "local-host" }, action: "example.retention", result: "completed", contentRef: ref });
    return ref;
  });
  if (anchor === "missing") w.r.db.prepare("DELETE FROM hub_audit WHERE content_ref=?").run(ref);
  else w.r.db.prepare("UPDATE hub_audit SET action='example.unrelated-anchor' WHERE content_ref=?").run(ref);
  w.setNow(w.now() + 2 * 86_400_000);
  const snapshot = () => ({ content: w.r.db.prepare("SELECT * FROM hub_audit_content ORDER BY ref").all(),
    events: w.r.db.prepare("SELECT id,sequence FROM hub_audit ORDER BY sequence").all() });
  const before = snapshot();
  expect(() => w.r.auditStore!.purge({ contentDays: 1, eventDays: 1 }, undefined, { protectedContentRefs: w.r.http.retainedContentRefs! })).toThrow();
  expect(snapshot()).toEqual(before);
  expect(w.core.deps.content.get(noise)).toEqual({ question: "Unrelated old hint" });
});

it("rechecks the real group permission before committing an owner acceptance", async () => {
  const w = await world(), r = w.r, group = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", now = w.now;
  r.store.mutate({ requestId: randomUUID(), at: now(), actor: { kind: "local-host" }, action: "fixture.fleet", result: "completed" }, state => {
    state.fleets.push({ id: w.shared.fleetId, owner: w.owner, generation: 1, credentialHash: null, status: "active" });
  });
  groupPolicyMigration(r.hubId, "corp", "generation-1").up(r.db);
  HUB_GROUP_RESOURCES_MIGRATION.up(r.db);
  Object.assign(r.directory, { groupPolicy: "ad-direct-guid", readPolicyGroups: async (person: PersonKey) => ({
    kind: "complete", person, groups: [group], observedAt: now(),
  }) });
  const audit = r.auditStore!, current = () => true, context = { requestId: randomUUID(), current };
  const policy = createHubGroupPolicyStore({ db: r.db, hubId: r.hubId, realm: "corp", generation: "generation-1", directory: r.directory, audit, current, now });
  policy.replace({ ...policy.read(), state: "enabled", groups: [{ group: { realm: "corp", objectId: group },
    dn: "CN=Example,DC=example,DC=test", allow: ["publish_agents", "pair_fleet"], maxFleets: 2 }] }, r.admin, context);
  const actions = createHubGroupAuthorization({ db: r.db, administrator: r.admin, policy: () => policy,
    binding: () => inspectHubGroupPolicyBinding(r.db, r.hubId, "corp", "generation-1"), audit, current, now,
    version: () => r.store.read().revocationVersion, advanceAuthorization: () => {}, refreshAuthorization: () => {} });
  await actions.enroll({ kind: "fleet", id: w.shared.fleetId, revision: 1, owner: w.owner }, context);
  await actions.enroll({ kind: "exposure", id: w.shared.id, revision: 1, owner: w.owner }, context);
  r.httpDeps.groups = actions;
  const original = w.core.groupExposure.bind(w.core); let entered = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(w.core, "groupExposure").mockImplementation(async (...args) => {
    const permit = await original(...args); entered = true; await held; return permit;
  });
  const pending = w.accept();
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    policy.replace({ ...policy.read(), groups: [] }, r.admin, context);
  } finally { release(); }
  expect((await pending).status).toBe(503);
  expect(w.row().state).toBe("pending"); expect(w.members()).toEqual([]);
});

it.each(["accepted", "cancelled", "expired"])("does not turn a %s request into a decline", async state => {
  const w = await world();
  if (state === "accepted") expect((await w.accept()).status).toBe(200);
  if (state === "cancelled") expect((await w.r.call(w.manager, "DELETE", `/hub/v1/rooms/${w.roomId}/agent-requests/${w.id}`)).status).toBe(200);
  if (state === "expired") { w.setNow(w.now() + ROOM_AGENT_REQUEST_TTL); w.browser = await w.r.signIn("example-owner"); }
  expect((await w.r.call(w.browser, "POST", w.path + "/decline", {})).status).toBe(404);
  expect(w.row().state).toBe(state);
  expect(w.members()).toHaveLength(state === "accepted" ? 1 : 0);
});

it("withholds a revoked Fleet's retained exposures from owner choices", async () => {
  const w = await world(), r = w.r;
  r.store.mutate({ requestId: randomUUID(), at: w.now(), actor: { kind: "local-host" }, action: "fixture.fleet", result: "completed" }, state => {
    state.fleets.push({ id: w.shared.fleetId, owner: w.owner, generation: 1, credentialHash: null, status: "active" });
  });
  const visible = await r.call(w.browser, "GET", w.path);
  expect(visible.status).toBe(200); expect(visible.json.choices.some((c: any) => c.exposureId === w.shared.id)).toBe(true);
  r.store.mutate({ requestId: randomUUID(), at: w.now(), actor: { kind: "local-host" }, action: "fixture.revoke", result: "completed" }, state => {
    state.fleets.find(f => f.id === w.shared.fleetId)!.status = "revoked";
  });
  const hidden = await r.call(w.browser, "GET", w.path);
  expect(hidden.status).toBe(200); expect(JSON.stringify(hidden.json.choices)).not.toContain(w.shared.id);
  expect(JSON.stringify(hidden.json.choices)).not.toContain(w.shared.displayName);
  expect(hidden.json.choices.some((c: any) => c.exposureId === w.unshared.id)).toBe(true);
});
