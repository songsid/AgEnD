import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });

it("shows a never-connected Fleet as unknown and exposes only the signed-in owner's active Fleets", async () => {
  r = await s3bRig();
  const owner = r.addPerson("owner"), other = r.addPerson("other");
  const id = randomUUID();
  r.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "fixture", result: "completed" }, state => {
    state.fleets.push({ id, owner, generation: 1, credentialHash: "a".repeat(64), status: "active", label: "Office" },
      { id: randomUUID(), owner: other, generation: 1, credentialHash: "b".repeat(64), status: "active" },
      { id: randomUUID(), owner, generation: 2, credentialHash: null, status: "revoked" });
  });
  const admin = await r.signIn("admin"), person = await r.signIn("owner");
  const overview = await r.call(admin, "GET", "/hub/v1/admin/overview");
  expect(overview.status).toBe(200);
  expect(overview.json.recommendedVersion).toBeNull();
  expect(overview.json.fleets.find((f: any) => f.id === id)).toMatchObject({ version: null, runsAsService: null,
    versionReportedAt: null, lastConnectedAt: null, connected: false, versionState: "unknown" });
  expect((await r.call(person, "GET", "/hub/v1/me/fleets")).json).toEqual({ fleets: [{ id, label: "Office", version: null, versionState: "unknown" }] });
  expect((await r.call(person, "GET", "/hub/v1/admin/overview")).status).toBe(403);
  expect((await r.call(null, "GET", "/hub/v1/me/fleets")).status).toBe(401);
});

it("retains the last report across disconnect/restart and learns old-link capability state on reconnect", async () => {
  let at = 1_800_000_000_000;
  r = await s3bRig({ now: () => at });
  const owner = r.addPerson("owner"), id = randomUUID();
  r.store.mutate({ requestId: randomUUID(), at, actor: { kind: "local-host" }, action: "fixture", result: "completed" }, state => {
    state.fleets.push({ id, owner, generation: 1, credentialHash: "a".repeat(64), status: "active" });
  });
  const admin = await r.signIn("admin");
  const first = r.link(id, owner, 1, ["welcome-caps-v1", "room-ask-v1", "fleet-info-v1"]);
  r.http.memberConnected!(first);
  at += 50;
  await r.http.receive(r.frame("fleet.info", { version: "2.4.0-beta.4", runsAsService: true }, first) as never, first);
  const view = async () => (await r!.call(admin, "GET", "/hub/v1/admin/overview")).json.fleets[0];
  expect(await view()).toMatchObject({ version: "2.4.0-beta.4", runsAsService: true, versionReportedAt: at,
    lastConnectedAt: at - 50, connected: true, versionState: "current" });
  first.alive = false;
  expect(await view()).toMatchObject({ connected: false, version: "2.4.0-beta.4", versionState: "current" });
  await r.restartHttp();
  expect(await view()).toMatchObject({ connected: false, lastConnectedAt: at - 50, versionReportedAt: at });
  at += 5_000;
  const second = r.link(id, owner, 2, []);
  r.http.memberConnected!(second);
  expect(await view()).toMatchObject({ connected: true, version: "2.4.0-beta.4", versionReportedAt: at - 5_000,
    lastConnectedAt: at, versionState: "too-old-rooms" });
  second.alive = false;
  await expect(r.http.receive(r.frame("fleet.info", { version: "9.0.0", runsAsService: false }, first) as never, first)).rejects.toMatchObject({ code: "stale" });
  expect(await view()).toMatchObject({ version: "2.4.0-beta.4", connected: false });
});

it("refuses malformed, unoffered and foreign-owner reports without changing stored diagnostics", async () => {
  r = await s3bRig();
  const owner = r.addPerson("owner"), other = r.addPerson("other"), id = randomUUID();
  r.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "fixture", result: "completed" }, state => {
    state.fleets.push({ id, owner, generation: 1, credentialHash: "a".repeat(64), status: "active" });
  });
  const caps = ["welcome-caps-v1", "room-ask-v1", "fleet-info-v1"], link = r.link(id, owner, 1, caps);
  r.http.memberConnected!(link);
  const report = (payload: unknown, l = link) => r!.http.receive(r!.frame("fleet.info", payload, l) as never, l);
  await expect(report({ version: "not a version", runsAsService: true })).rejects.toMatchObject({ code: "invalid" });
  await expect(report({ version: "2.4.0", runsAsService: "true" })).rejects.toMatchObject({ code: "invalid" });
  await expect(report({ version: "2.4.0", runsAsService: true, owner })).rejects.toMatchObject({ code: "invalid" });
  await expect(report({ version: "2.4.0", runsAsService: true }, r.link(id, other, 2, caps))).rejects.toMatchObject({ code: "revoked" });
  await expect(report({ version: "2.4.0", runsAsService: true }, r.link(id, owner, 3, ["welcome-caps-v1"]))).rejects.toMatchObject({ code: "incompatible" });
  expect(r.db.prepare("SELECT version FROM hub_fleet_versions WHERE fleet_id=?").get(id)).toEqual({ version: null });
  r.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "fixture.revoke", result: "completed" }, state => {
    const fleet = state.fleets.find(f => f.id === id)!; fleet.status = "revoked"; fleet.credentialHash = null;
  });
  await expect(report({ version: "2.4.0", runsAsService: true })).rejects.toMatchObject({ code: "revoked" });
  const ownerSession = await r.signIn("owner");
  r.setEligible("owner", false);
  expect((await r.call(ownerSession, "GET", "/hub/v1/me/fleets")).status).toBe(401);
  const expired = await r.signIn("other");
  expect((await r.call(expired, "GET", "/hub/v1/me/fleets?owner=other")).status).toBe(400);
});
