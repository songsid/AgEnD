/** Group checks through real HTTP/room/policy services and real SQLite; all people and directory facts are fake. */
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { HUB_AUDIT_MIGRATION, createHubAudit } from "../src/hub/audit/index.js";
import { groupPolicyMigration, createHubGroupPolicyStore, inspectHubGroupPolicyBinding } from "../src/hub/group-policy/store.js";
import { HUB_GROUP_RESOURCES_MIGRATION, createHubGroupResources } from "../src/hub/group-policy/resources.js";
import { createHubGroupAuthorization } from "../src/hub/group-policy/authorization.js";
import { HubCore } from "../src/hub/http/core.js";
import { HubPolicyService } from "../src/hub/policy.js";
import { HubSessions } from "../src/hub/sessions.js";
import type { IncomingMessage } from "node:http";
import { HubRoomsService } from "../src/hub/rooms.js";
import { buttonsDigest } from "../src/hub/buttons-model.js";
import { messageContentDigest } from "../src/hub/identity.js";
import type { HubAnswerButtons, HubExposure, PersonKey } from "../src/hub/types.js";
import type { PolicyGroupFacts } from "../src/hub/directory/groups.js";

type Rig = Awaited<ReturnType<typeof s3bRig>>;
let rig: Rig | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; vi.restoreAllMocks(); });
const group = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
async function world(options: { manual?: boolean; enable?: boolean } = {}) {
  let time = 100_000; const now = () => time;
  const r = rig = await s3bRig({ now, attachments: true });
  const owner = r.addPerson("owner"), asker = r.addPerson("asker"), fleetId = randomUUID();
  r.store.mutate({ at: now(), requestId: randomUUID(), actor: { kind: "person", person: owner }, action: "fixture.fleet", result: "completed" }, s => {
    s.fleets.push({ id: fleetId, owner, credentialHash: null, generation: 1, status: "active" });
  });
  const link = r.link(fleetId, owner, 1, ["attachments-v1", "buttons-v1"]);
  const exposure: HubExposure = { id: randomUUID(), fleetId, owner, displayName: "Representative", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) };
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [exposure] }, link) as never, link);
  const o = await r.signIn("owner"), a = await r.signIn("asker");
  const grant = await r.call(o, "POST", "/hub/v1/grants", { exposureId: exposure.id, exposureRevision: 1, login: "asker", days: 7 });
  expect(grant.status).toBe(200);
  const opened = await r.call(a, "POST", "/hub/v1/rooms", { exposureId: exposure.id, grantId: grant.json.grant.id });
  expect(opened.status).toBe(200);
  const roomId = opened.json.room.id as string;
  HUB_AUDIT_MIGRATION.up(r.db); groupPolicyMigration(r.hubId, "corp", "generation-1").up(r.db); HUB_GROUP_RESOURCES_MIGRATION.up(r.db);
  const audit = createHubAudit({ db: r.db, contentKey: randomBytes(32), now });
  const facts = new Map<string, "allow" | "deny" | "unknown">();
  const read = vi.fn(async (person: PersonKey): Promise<PolicyGroupFacts> => {
    const state = facts.get(person.objectId) ?? "allow";
    return state === "unknown" ? { kind: "unknown" } : { kind: "complete", person, groups: [state === "allow" ? group : other], observedAt: now() };
  });
  Object.assign(r.directory, { groupPolicy: "ad-direct-guid", readPolicyGroups: read });
  const current = () => r.httpDeps.current().serverEnabled();
  const ctx = { requestId: randomUUID(), current };
  const policy = createHubGroupPolicyStore({ db: r.db, hubId: r.hubId, realm: "corp", generation: "generation-1", directory: r.directory, audit, current, now });
  const resources = createHubGroupResources({ db: r.db, policy, audit, current, now });
  const fleetResource = { kind: "fleet" as const, id: fleetId, revision: 1, owner };
  const exposureResource = { kind: "exposure" as const, id: exposure.id, revision: 1, owner };
  if (options.manual) { resources.captureManual(fleetResource, ctx); resources.captureManual(exposureResource, ctx); }
  if (options.enable !== false) policy.replace({ ...policy.read(), state: "enabled", groups: [{ group: { realm: "corp", objectId: group }, dn: "CN=Members,DC=example,DC=test", allow: ["ask_agents", "publish_agents", "pair_fleet"], maxFleets: 2 }] }, r.admin, ctx);
  const refresh = vi.fn();
  const actions = createHubGroupAuthorization({ db: r.db, administrator: r.admin, policy: () => policy,
    binding: () => inspectHubGroupPolicyBinding(r.db, r.hubId, "corp", "generation-1"), audit, current, now,
    version: () => r.store.read().revocationVersion,
    advanceAuthorization: () => r.store.mutate({ at: now(), requestId: randomUUID(), actor: { kind: "local-host" }, action: "fixture.authorization", result: "completed" }, s => { s.revocationVersion++; }),
    refreshAuthorization: refresh });
  if (!options.manual && options.enable !== false) { await actions.enroll(fleetResource, ctx); await actions.enroll(exposureResource, ctx); }
  r.httpDeps.groups = actions;
  await r.restartHttp();
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [exposure] }, link) as never, link);
  const core = new HubCore(r.httpDeps, r.sql), messagePolicy = new HubPolicyService(core), rooms = new HubRoomsService(core, messagePolicy);
  rooms.noteLink(link);
  const ask = (files: string[] = []) => r.call(a, "POST", `/hub/v1/rooms/${roomId}/messages`, { idempotencyKey: randomUUID(), text: "Private question", ...(files.length ? { files } : {}) });
  const message = () => r.db.prepare("SELECT * FROM hub_messages ORDER BY created_at LIMIT 1").get() as import("../src/hub/policy.js").MessageRow;
  const authorize = (phase: "admit" | "begin") => messagePolicy.authorize({ messageId: message().id, operationId: randomUUID(), exposureRevision: 1, phase }, link);
  const answer = async (buttons?: HubAnswerButtons) => {
    const text = "Private answer", answerId = randomUUID(), contentDigest = messageContentDigest("answer", text, { buttonsDigest: buttonsDigest(buttons) }), msg = message();
    const authorization = await messagePolicy.authorize({ messageId: msg.id, operationId: randomUUID(), exposureRevision: 1, phase: "release-answer", answer: { answerId, contentDigest } }, link);
    if (!authorization.ok) throw Error("answer control refused");
    return { messageId: msg.id, answerId, text, contentDigest, ...(buttons ? { buttons } : {}), releaseLease: authorization.lease };
  };
  return { r, owner, asker, exposure, fleetId, link, o, a, roomId, grant: grant.json.grant, facts, read, actions, resources, policy, refresh, rooms, core, messagePolicy, ask, authorize, answer, message, advance: (ms: number) => { time += ms; } };
}

describe("group permits at message effects", () => {
  it("never-enabled preserves the ordinary path without a group directory read", async () => {
    const w = await world({ enable: false });
    w.facts.set(w.asker.objectId, "deny"); expect((await w.ask()).status).toBe(200);
    expect(w.read).not.toHaveBeenCalled(); expect(w.r.db.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]);
  });
  it("denies an existing grant to a group-less asker, while sign-in and narrowing stay available", async () => {
    const w = await world(); w.facts.set(w.asker.objectId, "deny");
    expect((await w.r.signIn("asker")).status).toBe(200);
    expect((await w.ask()).status).toBe(403); // First denied action cannot create asker provenance.
    expect((await w.r.call(w.a, "POST", "/hub/v1/rooms", { exposureId: w.exposure.id, grantId: w.grant.id })).status).toBe(403);
    expect(w.r.db.prepare("SELECT * FROM hub_messages").all()).toEqual([]);
    expect((await w.r.call(w.o, "DELETE", `/hub/v1/grants/${w.grant.id}?revision=1`)).status).toBe(200);
  });
  it("a fresh allowance admits one question; a complete removal suspends its canonical asker and blocks later leases and reads", async () => {
    const w = await world(); expect((await w.ask()).status).toBe(200);
    expect(await w.authorize("admit")).toMatchObject({ ok: true });
    w.facts.set(w.asker.objectId, "deny"); expect(await w.authorize("begin")).toMatchObject({ ok: false, reasonCode: "denied" });
    expect(w.refresh).toHaveBeenCalledOnce();
    expect(w.resources.read({ kind: "asker", id: w.asker.objectId, revision: 1, owner: w.asker })).toMatchObject({ state: "suspended" });
    expect((await w.r.call(w.a, "GET", `/hub/v1/rooms/${w.roomId}/messages`)).status).toBe(403);
    expect((await w.r.call(w.a, "GET", "/hub/v1/rooms")).status).toBe(403);
    expect((await w.r.call(w.a, "GET", "/hub/v1/exposures")).json.askable).toEqual([]);
    w.facts.set(w.asker.objectId, "allow"); expect((await w.ask()).status).toBe(403);
  });
  it("unknown dispatch holds the queued row unchanged; a later complete read can dispatch it", async () => {
    const w = await world(); w.r.setTransport(false); expect((await w.ask()).status).toBe(200); w.r.setTransport(true);
    const before = w.message(), version = w.r.store.read().revocationVersion;
    w.facts.set(w.asker.objectId, "unknown"); expect(await w.rooms.flush(w.fleetId)).toBe(false);
    expect(w.message()).toEqual(before); expect(w.r.sent).toEqual([]); expect(w.r.store.read().revocationVersion).toBe(version);
    w.facts.set(w.asker.objectId, "allow"); expect(await w.rooms.flush(w.fleetId)).toBe(true);
    expect(w.r.sent.filter(s => s.frame.type === "question")).toHaveLength(1);
  });
  it("answer commit rechecks groups after the exact release lease was issued", async () => {
    const w = await world(); expect((await w.ask()).status).toBe(200); const answer = await w.answer();
    w.facts.set(w.owner.objectId, "deny"); await expect(w.rooms.answer(answer, w.link)).rejects.toMatchObject({ code: "denied" });
    expect(w.message().answer_id).toBeNull(); expect(w.r.db.prepare("SELECT consumed FROM hub_leases WHERE decision_id=?").get(answer.releaseLease.decisionId)).toEqual({ consumed: 0 });
  });
  it("an exposure revision cannot inherit a manual allowance from the previous revision", async () => {
    const w = await world({ manual: true }); expect((await w.ask()).status).toBe(200);
    w.r.db.prepare("UPDATE hub_exposures SET revision=2").run();
    await expect(w.core.groupExposure(w.exposure.id, w.asker, { requestId: randomUUID(), current: () => true })).rejects.toThrow();
    expect(w.resources.read({ kind: "exposure", id: w.exposure.id, revision: 2, owner: w.owner })).toBeNull();
  });
  it("the synchronous session fence refuses a held group lookup after sign-out", async () => {
    const w = await world(); expect((await w.ask()).status).toBe(200);
    let release!: (value: PolicyGroupFacts) => void, entered!: () => void;
    const enteredPromise = new Promise<void>(r => { entered = r; });
    w.read.mockImplementationOnce(() => { entered(); return new Promise(r => { release = r; }); });
    const pending = w.ask(); await enteredPromise;
    expect((await w.r.call(w.a, "DELETE", "/hub/v1/session")).status).toBe(200);
    release({ kind: "complete", person: w.asker, groups: [group], observedAt: 100_000 });
    expect((await pending).status).toBe(503);
    expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_messages").get()).toEqual({ n: 1 });
  });
  it("withholds a permission reentrantly invalidated by the write audit and rolls back the question", async () => {
    const w = await world(); expect((await w.ask()).status).toBe(200);
    const append = w.r.httpDeps.audit.append.bind(w.r.httpDeps.audit);
    vi.spyOn(w.r.httpDeps.audit, "append").mockImplementation((tx, record) => {
      append(tx, record);
      if (record.action === "question.accepted") w.actions.close();
    });
    expect((await w.ask()).status).toBe(503);
    expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_messages").get()).toEqual({ n: 1 });
  });
  it("every browser file read and member chunk rechecks the same group permission", async () => {
    const w = await world();
    const response = await fetch(`${w.r.base}/hub/v1/rooms/${w.roomId}/files`, { method: "POST", body: "private file", headers: {
      Origin: "https://hub.example.test", Cookie: w.a.cookie, "X-AgEnD-Hub-CSRF": w.a.csrf, "X-File-Name": "example.txt" } });
    expect(response.status).toBe(200); const file = (await response.json() as any).file;
    expect((await w.ask([file.id])).status).toBe(200);
    expect((await w.r.call(w.a, "GET", file.url)).status).toBe(200);
    expect(Buffer.from((await w.rooms.attachmentGet({ id: file.id, offset: 0 }, w.link)).data, "base64").toString()).toBe("private file");
    w.facts.set(w.asker.objectId, "deny");
    expect((await w.r.call(w.a, "GET", file.url)).status).toBe(403);
    await expect(w.rooms.attachmentGet({ id: file.id, offset: 0 }, w.link)).rejects.toMatchObject({ code: "denied" });
  });
  it("a button cannot enqueue a new question after group removal", async () => {
    const w = await world(); expect((await w.ask()).status).toBe(200);
    const buttons: HubAnswerButtons = { id: randomUUID().replaceAll("-", ""), labels: ["Continue"] };
    await w.rooms.answer(await w.answer(buttons), w.link);
    w.facts.set(w.asker.objectId, "deny");
    const result = await w.r.call(w.a, "POST", `/hub/v1/rooms/${w.roomId}/buttons`, { setId: buttons.id, index: 0, idempotencyKey: randomUUID() });
    expect(result.status).toBe(403);
    expect(w.r.db.prepare("SELECT state FROM hub_answer_buttons").get()).toEqual({ state: "open" });
    expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_messages").get()).toEqual({ n: 1 });
  });
  it("automatic poll results hold on unknown groups, then use a new allowance when retried", async () => {
    const w = await world(); expect((await w.ask()).status).toBe(200);
    const buttons: HubAnswerButtons = { id: randomUUID().replaceAll("-", ""), labels: ["Continue", "Stop"], poll: { seconds: 10, multi: true, reveal: "close", showVoters: false, question: "Continue?" } };
    await w.rooms.answer(await w.answer(buttons), w.link);
    w.facts.set(w.asker.objectId, "unknown"); w.advance(10_001);
    await w.rooms.buttons.sweep();
    expect(w.r.db.prepare("SELECT state, result_state FROM hub_answer_buttons").get()).toEqual({ state: "closed", result_state: "held" });
    expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_messages").get()).toEqual({ n: 1 });
    w.facts.set(w.asker.objectId, "allow"); w.advance(30_001); await w.rooms.buttons.sweep();
    expect(w.r.db.prepare("SELECT result_state FROM hub_answer_buttons").get()).toEqual({ result_state: "queued" });
    expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_messages").get()).toEqual({ n: 2 });
  });

  it("concurrent first actions create one canonical asker record without losing either fresh check", async () => {
    const w = await world();
    expect((await Promise.all([w.ask(), w.ask()])).map(r => r.status)).toEqual([200, 200]);
    expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_group_resources WHERE json_extract(body,'$.kind')='asker'").get()).toEqual({ n: 1 });
    expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_messages").get()).toEqual({ n: 2 });
  });
  it("a first unknown lookup creates no provenance or suspension and a later complete positive recovers", async () => {
    const w = await world(); w.facts.set(w.asker.objectId, "unknown");
    const version = w.r.store.read().revocationVersion;
    expect((await w.ask()).status).toBe(503);
    expect(w.resources.read({ kind: "asker", id: w.asker.objectId, revision: 1, owner: w.asker })).toBeNull();
    expect(w.r.store.read().revocationVersion).toBe(version); expect(w.refresh).not.toHaveBeenCalled();
    w.facts.set(w.asker.objectId, "allow"); expect((await w.ask()).status).toBe(200);
  });
  it.each(["pair_fleet", "publish_agents"] as const)("checks the separate %s manual-resource denial before using an existing grant", async capability => {
    const w = await world({ manual: true }); expect((await w.ask()).status).toBe(200);
    w.policy.replace({ ...w.policy.read(), denies: [{ person: w.owner, deny: [capability] }] }, w.r.admin, { requestId: randomUUID(), current: () => true });
    expect((await w.ask()).status).toBe(403);
    const kind = capability === "pair_fleet" ? "fleet" : "exposure", id = kind === "fleet" ? w.fleetId : w.exposure.id;
    expect(w.resources.read({ kind, id, revision: 1, owner: w.owner })).toMatchObject({ state: "suspended" });
  });
  it.each(["exposure", "fleet", "provider"] as const)("fences a captured permit when the %s binding changes during a group read", async changed => {
    const w = await world(); expect((await w.ask()).status).toBe(200);
    let release!: (value: PolicyGroupFacts) => void, entered!: () => void;
    const enteredPromise = new Promise<void>(r => { entered = r; });
    w.read.mockImplementationOnce(() => { entered(); return new Promise(r => { release = r; }); });
    const pending = w.core.groupExposure(w.exposure.id, w.asker, { requestId: randomUUID(), current: () => true });
    const rejected = expect(pending).rejects.toThrow(); await enteredPromise;
    if (changed === "exposure") w.r.db.prepare("UPDATE hub_exposures SET policy_digest=?").run("c".repeat(64));
    if (changed === "fleet") w.r.store.mutate({ at: 100_000, requestId: randomUUID(), actor: { kind: "local-host" }, action: "fixture.replace", result: "completed" }, s => { s.fleets[0]!.credentialHash = "c".repeat(64); });
    if (changed === "provider") w.r.httpDeps.groups = { ...w.actions };
    release({ kind: "complete", person: w.asker, groups: [group], observedAt: 100_000 }); await rejected;
  });

  it("an old HTTP generation cannot commit a held action after replacement", async () => {
    const w = await world(); expect((await w.ask()).status).toBe(200);
    let release!: (value: PolicyGroupFacts) => void, entered!: () => void;
    const enteredPromise = new Promise<void>(r => { entered = r; });
    w.read.mockImplementationOnce(() => { entered(); return new Promise(r => { release = r; }); });
    const pending = w.ask(); await enteredPromise; await w.r.restartHttp();
    release({ kind: "complete", person: w.asker, groups: [group], observedAt: 100_000 });
    expect((await pending).status).toBe(503);
    expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_messages").get()).toEqual({ n: 1 });
  });

  it("withholds room content when building its projection invalidates the permit", async () => {
    const w = await world(); expect((await w.ask()).status).toBe(200);
    const get = w.r.httpDeps.content.get.bind(w.r.httpDeps.content);
    vi.spyOn(w.r.httpDeps.content, "get").mockImplementation(ref => { const value = get(ref); w.actions.close(); return value; });
    const ctx = new HubSessions(w.core).context({ headers: { cookie: w.a.cookie } } as IncomingMessage);
    await expect(w.rooms.read(ctx, w.roomId, 0, "direct-projection")).rejects.toMatchObject({ code: "unavailable" });
  });
  it("a frame assembled after reentrant invalidation is withheld before transport hand-off", async () => {
    const w = await world(); w.r.setTransport(false); expect((await w.ask()).status).toBe(200); w.r.setTransport(true);
    const sign = w.r.httpDeps.issuer.sign.bind(w.r.httpDeps.issuer);
    vi.spyOn(w.r.httpDeps.issuer, "sign").mockImplementation(envelope => { const identity = sign(envelope); w.actions.close(); return identity; });
    expect(await w.rooms.flush(w.fleetId)).toBe(false); expect(w.r.sent).toEqual([]); expect(w.message().sent_epoch).toBe(0);
  });

});
