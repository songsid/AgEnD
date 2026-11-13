import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { HubCore } from "../src/hub/http/core.js";
import { HubPolicyService } from "../src/hub/policy.js";
import { createHubGroupPolicyStore, groupPolicyMigration } from "../src/hub/group-policy/store.js";
import { HubProtocolError } from "../src/hub/validation.js";

type Rig = Awaited<ReturnType<typeof s3bRig>>;
const rigs: Rig[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); });
async function world() {
  let at = Date.now(); const r = await s3bRig({ now: () => at }); rigs.push(r);
  const owner = r.addPerson("owner"), asker = r.addPerson("asker"); r.addPerson("stranger");
  const o = await r.signIn("owner"), a = await r.signIn("asker"), outsider = await r.signIn("stranger");
  const link = r.link(randomUUID(), owner), e = { id: randomUUID(), fleetId: link.fleetId, owner, displayName: "Helper", revision: 1,
    state: "published" as const, dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) };
  const snapshot = (revision: number, l = link, exposures = [e]) => r.http.receive(r.frame("exposure.snapshot", { revision, exposures }, l) as never, l);
  await snapshot(1);
  const granted = await r.call(o, "POST", "/hub/v1/grants", { exposureId: e.id, exposureRevision: 1, login: "asker", days: 7 });
  expect(granted.status).toBe(200);
  const room = await r.call(a, "POST", "/hub/v1/rooms", { exposureId: e.id, grantId: granted.json.grant.id }); expect(room.status).toBe(200);
  const change = (paused: boolean, sharingEpoch: number, browser = o, extra = {}) => r.call(browser, "POST", `/hub/v1/exposures/${e.id}/sharing`, { revision: 1, sharingEpoch, paused, ...extra });
  return { r, e, link, o, a, asker, outsider, roomId: room.json.room.id, snapshot, change, now: () => at, advance: (ms: number) => { at += ms; } };
}
describe("M-3015 resumable sharing", () => {
  it("pauses without changing grants/rooms, hides new asks, and resumes the exact allow list", async () => {
    const w = await world(), rows = w.r.db.prepare("SELECT * FROM hub_grants").all();
    expect((await w.change(true, 0)).status).toBe(200);
    expect(w.r.db.prepare("SELECT * FROM hub_grants").all()).toEqual(rows);
    const mine = await w.r.call(w.o, "GET", "/hub/v1/exposures"); expect(mine.json.mine[0]).toMatchObject({ state: "paused", sharingEpoch: 1 });
    expect((await w.r.call(w.a, "GET", "/hub/v1/exposures")).json.askable).toEqual([]);
    const read = await w.r.call(w.a, "GET", `/hub/v1/rooms/${w.roomId}/messages`);
    expect(read.status).toBe(200); expect(read.json.room.exposureState).toBe("paused");
    expect((await w.r.call(w.a, "POST", `/hub/v1/rooms/${w.roomId}/messages`, { idempotencyKey: randomUUID(), text: "blocked" })).json.code).toBe("sharing-paused");
    expect((await w.change(false, 1)).status).toBe(200);
    expect(w.r.db.prepare("SELECT * FROM hub_grants").all()).toEqual(rows);
    expect((await w.r.call(w.a, "GET", "/hub/v1/exposures")).json.askable).toHaveLength(1);
    expect((await w.r.call(w.a, "POST", `/hub/v1/rooms/${w.roomId}/messages`, { idempotencyKey: randomUUID(), text: "resumed" })).status).toBe(200);
    expect(w.r.audits.filter((e: any) => ["exposure.paused", "exposure.resumed"].includes(e.action)).map((e: any) => e.action)).toEqual(["exposure.paused", "exposure.resumed"]);
  });
  it("retains an owner pause across a repeated/new snapshot, member reconnect and Hub restart", async () => {
    const w = await world(); expect((await w.change(true, 0)).status).toBe(200);
    w.link.alive = false; const next = w.r.link(w.link.fleetId, w.e.owner, 2);
    await w.snapshot(1, next); await w.snapshot(2, next); await w.r.restartHttp();
    const view = await w.r.call(w.o, "GET", "/hub/v1/exposures"); expect(view.json.mine[0]).toMatchObject({ state: "paused", sharingEpoch: 1 });
    expect((await w.r.call(w.a, "GET", "/hub/v1/exposures")).json.askable).toEqual([]);
    expect((await w.change(false, 1)).status).toBe(200);
  });
  it("runs absolute expiry during pause, without rewriting retained long or expired grants", async () => {
    const w = await world(); const expiry = Date.now() + 365 * 86_400_000;
    w.r.db.prepare("UPDATE hub_grants SET expires_at=?").run(expiry);
    const rows = w.r.db.prepare("SELECT * FROM hub_grants").all();
    expect((await w.change(true, 0)).status).toBe(200); w.advance(366 * 86_400_000);
    const fresh = await w.r.signIn("owner"); expect((await w.change(false, 1, fresh)).status).toBe(200);
    expect(w.r.db.prepare("SELECT * FROM hub_grants").all()).toEqual(rows);
    const a = await w.r.signIn("asker"); expect((await w.r.call(a, "GET", "/hub/v1/exposures")).json.askable).toEqual([]);
  });
  it("requires the exact owner/session, publication revision, sharing epoch and strict input", async () => {
    const w = await world();
    expect((await w.change(true, 0, w.outsider)).status).toBe(404);
    expect((await w.change(true, 0, w.o, { revision: 2 })).status).toBe(409);
    expect((await w.change(true, 0, w.o, { authority: "admin" })).status).toBe(400);
    expect((await w.change(true, 0)).status).toBe(200);
    expect((await w.change(false, 0)).status).toBe(409);
    expect((await w.r.call(w.o, "POST", `/hub/v1/exposures/${w.e.id}/sharing`, { revision: 1, sharingEpoch: 1, paused: false }, { Origin: "https://evil.test" })).status).toBe(403);
    await w.r.call(w.o, "DELETE", "/hub/v1/session"); expect((await w.change(false, 1)).status).toBe(401);
  });
  it("permanent Stop sharing cannot be undone by Resume or a reconnect", async () => {
    const w = await world(); expect((await w.change(true, 0)).status).toBe(200);
    expect((await w.r.call(w.o, "POST", `/hub/v1/exposures/${w.e.id}/freeze`, { revision: 1 })).status).toBe(200);
    expect((await w.change(false, 2)).status).toBe(403); await w.snapshot(2);
    expect((await w.r.call(w.a, "GET", "/hub/v1/exposures")).json.askable).toEqual([]);
  });
  it.each(["pause", "resume"])("rolls back %s when its audit cannot be appended", async action => {
    const w = await world(); if (action === "resume") expect((await w.change(true, 0)).status).toBe(200);
    w.r.setAuditFails(true, action === "pause" ? "exposure.paused" : "exposure.resumed");
    expect((await w.change(action === "pause", action === "pause" ? 0 : 1)).status).toBe(500);
    w.r.setAuditFails(false); const view = await w.r.call(w.o, "GET", "/hub/v1/exposures");
    expect(view.json.mine[0].state).toBe(action === "pause" ? "published" : "paused");
  });
  it("retires a pre-pause operation after pause/resume even on legacy-policy fleets", async () => {
    const w = await world(), core = new HubCore(w.r.httpDeps, w.r.sql);
    const proof = await core.groupExposure(w.e.id, w.asker, { requestId: randomUUID(), current: () => true }); proof.assertCurrent();
    expect((await w.change(true, 0)).status).toBe(200); expect((await w.change(false, 1)).status).toBe(200);
    expect(() => proof.assertCurrent()).toThrow();
    (await core.groupExposure(w.e.id, w.asker, { requestId: randomUUID(), current: () => true })).assertCurrent();
  });
  it("keeps GUID group grants intact but rechecks membership after Resume", async () => {
    const w = await world(), group = { realm: "corp", objectId: randomUUID() }, dn = "CN=Engineering,DC=test";
    let member = true;
    Object.assign(w.r.directory, { groupPolicy: "ad-direct-guid",
      resolvePolicyGroup: async () => ({ ok: true, group: { key: group, dn } }),
      readPolicyGroups: async (person: typeof w.asker) => ({ kind: "complete", person, groups: member ? [group.objectId] : [], observedAt: w.now() }),
    });
    groupPolicyMigration(w.r.hubId, "corp", "directory-v1").up(w.r.db);
    const policy = createHubGroupPolicyStore({ db: w.r.db, hubId: w.r.hubId, realm: "corp", generation: "directory-v1", directory: w.r.directory,
      audit: { appendInTransaction() {} } as never, current: () => true, now: w.now });
    w.r.httpDeps.grantDirectory = { policy: () => policy, binding: () => ({ kind: "ready" }) };
    w.r.db.prepare("UPDATE hub_grants SET state='revoked'").run();
    expect((await w.r.call(w.o, "POST", "/hub/v1/grants", { exposureId: w.e.id, exposureRevision: 1, days: 30, subject: { kind: "group", group, dn } })).status).toBe(200);
    const rows = w.r.db.prepare("SELECT * FROM hub_grants").all();
    expect((await w.change(true, 0)).status).toBe(200); expect((await w.change(false, 1)).status).toBe(200);
    expect(w.r.db.prepare("SELECT * FROM hub_grants").all()).toEqual(rows);
    expect((await w.r.call(w.a, "GET", "/hub/v1/exposures")).json.askable).toHaveLength(1);
    member = false; expect((await w.r.call(w.a, "GET", "/hub/v1/exposures")).json.askable).toEqual([]);
  });
  it("invalidates pre-pause release capabilities permanently, not just while paused", async () => {
    const w = await world(), sent = await w.r.call(w.a, "POST", `/hub/v1/rooms/${w.roomId}/messages`, { idempotencyKey: randomUUID(), text: "accepted before pause" });
    const core = new HubCore(w.r.httpDeps, w.r.sql), policy = new HubPolicyService(core), answerId = randomUUID(), digest = "a".repeat(64);
    const request = { messageId: sent.json.receipt.messageId, operationId: randomUUID(), exposureRevision: 1, phase: "release-answer" as const, answer: { answerId, contentDigest: digest } };
    const result = await policy.authorize(request, w.link); expect(result.ok).toBe(true); if (!result.ok) return;
    expect((await w.change(true, 0)).status).toBe(200);
    expect((await policy.authorize({ ...request, operationId: randomUUID() }, w.link)).ok).toBe(false);
    expect((await w.change(false, 1)).status).toBe(200);
    expect(() => core.atomic(db => policy.spendReleaseLease(db, result.lease, { messageId: request.messageId, answerId, contentDigest: digest }, w.link, w.now()))).toThrow();
  });
  it("Resume never bypasses independent operational group suspension", async () => {
    const w = await world(); expect((await w.change(true, 0)).status).toBe(200);
    w.r.store.mutate({ requestId: randomUUID(), actor: { kind: "local-host" }, action: "fixture.fleet", result: "completed", at: w.now() }, state => {
      state.fleets.push({ id: w.link.fleetId, owner: w.e.owner, generation: 1, status: "active", credentialHash: "a".repeat(64) });
    });
    w.r.httpDeps.groups = { check: async () => { throw new HubProtocolError("denied"); } } as never;
    expect((await w.change(false, 1)).status).toBe(403);
    expect(w.r.db.prepare("SELECT sharing_paused,sharing_epoch FROM hub_exposures WHERE id=?").get(w.e.id)).toEqual({ sharing_paused: 1, sharing_epoch: 1 });
  });
});
