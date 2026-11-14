import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { HubGroupPolicyError } from "../src/hub/group-policy/errors.js";
import type { HubGroupResource } from "../src/hub/group-policy/resources.js";

type Rig = Awaited<ReturnType<typeof s3bRig>>;
let r: Rig | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
async function world(groupsEnabled = true) {
  r = await s3bRig();
  const owner = r.addPerson("carol"), dave = r.addPerson("dave"), alice = r.addPerson("alice");
  const admin = await r.signIn("admin"), carol = await r.signIn("carol"), viewers = [await r.signIn("dave"), await r.signIn("alice")];
  const old = r.link(randomUUID(), owner), healthy = r.link(randomUUID(), r.admin);
  r.store.mutate({ at: Date.now(), requestId: randomUUID(), actor: { kind: "local-host" }, action: "fixture.fleets", result: "completed" }, state => {
    for (const link of [old, healthy]) state.fleets.push({ id: link.fleetId, owner: link.owner, status: "active", generation: 1, credentialHash: "a".repeat(64) });
  });
  const publish = async (link: typeof old, name: string) => {
    const exposure = { id: randomUUID(), fleetId: link.fleetId, owner: link.owner, displayName: name, revision: 1, state: "published" as const, dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) };
    await r!.http.receive(r!.frame("exposure.snapshot", { revision: 1, exposures: [exposure] }, link) as never, link); return exposure;
  };
  const stale = await publish(old, "Old probe"), good = await publish(healthy, "Working helper");
  const roomIds: string[] = [];
  for (const [i, login] of ["dave", "alice"].entries()) {
    for (const [browser, exposure] of [[carol, stale], [admin, good]] as const) {
      const grant = await r.call(browser, "POST", "/hub/v1/grants", { exposureId: exposure.id, exposureRevision: 1, login, days: 7 }); expect(grant.status).toBe(200);
      const room = await r.call(viewers[i]!, "POST", "/hub/v1/rooms", { exposureId: exposure.id, grantId: grant.json.grant.id }); expect(room.status).toBe(200);
      if (exposure === good) roomIds.push(room.json.room.id);
    }
  }
  const enrollments = new Set([JSON.stringify([old.fleetId, 1]), JSON.stringify([healthy.fleetId, 1])]);
  if (groupsEnabled) {
    const permit = { source: "group" as const, assertCurrent() {} };
    // The preserved rig's real authority fails at this exact missing-generation lookup.
    r.httpDeps.groups = { asker: async () => permit, check: async (resource: HubGroupResource) => {
      if (resource.kind === "fleet" && !enrollments.has(JSON.stringify([resource.id, resource.revision]))) throw new HubGroupPolicyError("invalid");
      return permit;
    } } as unknown as NonNullable<Rig["httpDeps"]["groups"]>;
    await r.restartHttp();
  }
  const actor = { kind: "directory" as const, person: r.admin, sessionId: randomUUID() };
  await r.pairing.revoke({ requestId: randomUUID(), current: async () => actor, isCurrent: () => true,
    requirePerson: async () => r!.admin, requireAdmin: async () => actor }, old.fleetId);
  const replacement = randomUUID();
  r.store.mutate({ at: Date.now(), requestId: randomUUID(), actor: { kind: "local-host" }, action: "fixture.repair", result: "completed" }, state => {
    state.fleets.push({ id: replacement, owner, status: "active", generation: 1, credentialHash: "c".repeat(64) });
  });
  enrollments.add(JSON.stringify([replacement, 1]));
  return { admin, carol, viewers, stale, good, roomIds };
}

it("skips the revoked Fleet before its absent next-generation group record, retaining healthy exposures and rooms after restart", async () => {
  const w = await world();
  for (const restart of [false, true]) {
    if (restart) await r!.restartHttp();
    for (const [i, browser] of w.viewers.entries()) {
      const catalog = await r!.call(browser, "GET", "/hub/v1/exposures");
      expect(catalog.status).toBe(200);
      expect(catalog.json.askable.map((x: any) => x.exposure.id)).toEqual([w.good.id]);
      const rooms = await r!.call(browser, "GET", "/hub/v1/rooms?v=2");
      expect(rooms.status).toBe(200);
      expect(rooms.json.rooms.map((x: any) => x.id)).toEqual([w.roomIds[i]]);
    }
    const owned = await r!.call(w.carol, "GET", "/hub/v1/exposures"); expect(owned.status).toBe(200); expect(owned.json.mine).toEqual([]);
  }
});

it("hides a known revoked Fleet's own publications in legacy compositions without deleting retained rows", async () => {
  const w = await world(false), before = r!.db.prepare("SELECT * FROM hub_exposures WHERE id=?").get(w.stale.id);
  const catalog = await r!.call(w.carol, "GET", "/hub/v1/exposures");
  expect(catalog.status).toBe(200); expect(catalog.json.mine).toEqual([]);
  expect(r!.db.prepare("SELECT * FROM hub_exposures WHERE id=?").get(w.stale.id)).toEqual(before);
});

it("logs the group-policy cause when a genuine active-resource failure still returns503", async () => {
  const w = await world(), logged: unknown[][] = [];
  Object.assign(r!.httpDeps, { log: (...args: unknown[]) => { logged.push(args); } });
  r!.httpDeps.groups!.check = async () => { throw new HubGroupPolicyError("invalid"); };
  await r!.restartHttp();
  const response = await r!.call(w.viewers[0]!, "GET", "/hub/v1/exposures");
  expect(response.status).toBe(503);
  expect(logged).toContainEqual(["warn", "Hub HTTP unavailable", {
    method: "GET", path: "/hub/v1/exposures", code: "unavailable", cause: "group_policy_invalid",
  }]);
});
