import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { HubPreviousAccess } from "../src/hub/sharing-previous-access.js";
import { HubAgentCatalogs } from "../src/hub/agent-catalog.js";
import { HubCore } from "../src/hub/http/core.js";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import type { HubFleetExposure, HubRequestContext } from "../src/hub/types.js";
let rig: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; });
async function world() {
  let now = 1_800_000_000_000;
  const r = rig = await s3bRig({ now: () => now }), owner = r.addPerson("owner", "Owner");
  r.addPerson("reader", "Reader"); const fleetId = randomUUID(), exposureId = randomUUID();
  r.store.mutate({ requestId: randomUUID(), at: now, actor: { kind: "local-host" }, action: "fixture", result: "completed" }, state => {
    state.fleets.push({ id: fleetId, owner, generation: 1, credentialHash: "a".repeat(64), status: "active" });
  });
  await r.signIn("reader");
  const browser = await r.signIn("owner"), other = await r.signIn("admin");
  const link = r.link(fleetId, owner, 1, ["welcome-caps-v1", "room-ask-v1", "agent-catalog-v1", "exposure-request-v1"]);
  r.http.memberConnected!(link);
  const exposure = (revision: number): HubFleetExposure => ({ id: exposureId, fleetId, owner, revision, displayName: "Documents", state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) });
  const snapshot = async (rows: HubFleetExposure[], revision: number) => r.http.receive(r.frame("exposure.snapshot", { revision, exposures: rows }, link), link);
  await r.http.receive(r.frame("agent.catalog", { enabled: true, requests: true, revision: "a".repeat(64), agents: [{ instance: "docs", displayName: "Documents", description: "A helper", avatar: null, kind: "agent" as const, general: false, shareable: true as const, exposure: null }] }, link), link);
  return { r, browser, other, link, fleetId, exposureId, exposure, snapshot, now: () => now, setNow: (value: number) => { now = value; } };
}
it("requests a refresh only on the owner's opted-in current link and never claims a report arrived", async () => {
  const w = await world(), path = "/hub/v1/me/agents/refresh";
  expect((await w.r.call(w.other, "POST", path, { fleetId: w.fleetId })).status).toBe(404);
  expect((await w.r.call(w.browser, "POST", path, { fleetId: w.fleetId }, { "X-AgEnD-Hub-CSRF": "wrong" })).status).toBe(403);
  const out = await w.r.call(w.browser, "POST", path, { fleetId: w.fleetId });
  expect(out.status).toBe(200); expect(out.json).toMatchObject({ requested: true, fleetId: w.fleetId });
  expect(w.r.sent.filter(x => x.frame.type === "agent.catalog-refresh")).toHaveLength(1);
  w.link.alive = false;
  expect((await w.r.call(w.browser, "POST", path, { fleetId: w.fleetId })).status).toBe(503);
});
it("offers a retained list but never restores it until explicitly selected; selection keeps expiry and is replay safe", async () => {
  const w = await world(); await w.snapshot([w.exposure(1)], 1);
  const granted = await w.r.call(w.browser, "POST", "/hub/v1/grants", { exposureId: w.exposureId, exposureRevision: 1, login: "reader", days: 7 });
  expect(granted.status).toBe(200); const grant = granted.json.grant;
  await w.snapshot([], 2); await w.snapshot([w.exposure(3)], 3);
  const path = `/hub/v1/me/agents/${w.exposureId}/previous-access`;
  expect(w.r.db.prepare("SELECT id FROM hub_grants WHERE state='active'").all()).toEqual([]);
  expect((await w.r.call(w.other, "GET", path)).status).toBe(404);
  const preview = await w.r.call(w.browser, "GET", path);
  expect(preview.status).toBe(200); expect(preview.json.previous).toMatchObject({ count: 1, expiresAt: w.now() + 86_400_000 });
  const input = { revision: 3, digest: preview.json.previous.digest };
  expect((await w.r.call(w.browser, "POST", path, { ...input, revision: 1 })).status).toBe(409);
  expect((await w.r.call(w.browser, "POST", path, { ...input, digest: "0".repeat(64) })).status).toBe(409);
  expect((await w.r.call(w.browser, "POST", path, input)).status).toBe(200);
  expect((await w.r.call(w.browser, "POST", path, input)).status).toBe(200);
  const active = w.r.db.prepare("SELECT id,exposure_revision,expires_at FROM hub_grants WHERE state='active'").all() as any[];
  expect(active).toHaveLength(1); expect(active[0]).toMatchObject({ exposure_revision: 3, expires_at: grant.expiresAt }); expect(active[0].id).not.toBe(grant.id);
  w.r.db.prepare("UPDATE hub_grants SET state='revoked',revision=revision+1 WHERE id=?").run(active[0].id);
  expect((await w.r.call(w.browser, "POST", path, input)).status).toBe(200);
  expect(w.r.db.prepare("SELECT id FROM hub_grants WHERE state='active'").all()).toEqual([]);
  w.setNow(w.now() + 86_400_000);
  w.browser = await w.r.signIn("owner");
  expect((await w.r.call(w.browser, "GET", path)).json.previous).toBeNull();
  expect((await w.r.call(w.browser, "POST", path, input)).status).toBe(409);
});
it("never refreshes an old peer, accepts an owner selector, or carries over retained access to another Fleet generation", async () => {
 const w = await world();
 const path = "/hub/v1/me/agents/refresh";
 expect((await w.r.call(w.browser, "POST", path, { fleetId: w.fleetId, owner: "someone" })).status).toBe(400);
 (w.link.features as Set<string>).delete("agent-catalog-v1");
 expect((await w.r.call(w.browser, "POST", path, { fleetId: w.fleetId })).status).toBe(503);
 expect(w.r.sent.filter(x => x.frame.type === "agent.catalog-refresh")).toHaveLength(0);
 await w.snapshot([w.exposure(1)], 1);
 expect((await w.r.call(w.browser, "POST", "/hub/v1/grants", { exposureId: w.exposureId, exposureRevision: 1, login: "reader", days: 7 })).status).toBe(200);
 await w.snapshot([], 2); await w.snapshot([w.exposure(3)], 3);
 const retained = `/hub/v1/me/agents/${w.exposureId}/previous-access`;
 const preview = (await w.r.call(w.browser, "GET", retained)).json.previous;
 expect(preview.count).toBe(1);
 w.r.store.mutate({ requestId: randomUUID(), at: w.now(), actor: { kind: "local-host" }, action: "fixture", result: "completed" }, state => { state.fleets.find(x => x.id === w.fleetId)!.generation++; });
 expect((await w.r.call(w.browser, "GET", retained)).json.previous).toBeNull();
 expect((await w.r.call(w.browser, "POST", retained, { revision: 3, digest: preview.digest })).status).toBe(409);
});

it("refuses an application-shaped directory actor on every owner-only page service", async () => {
 const w = await world(), core = new HubCore(w.r.httpDeps, w.r.sql), catalogs = new HubAgentCatalogs(core), previous = new HubPreviousAccess(core, catalogs);
 const owner = w.r.store.read().fleets.find(f => f.id === w.fleetId)!.owner;
 const ctx: HubRequestContext = { requestId: randomUUID(), requirePerson: async () => owner, requireAdmin: async () => { throw Error("not used"); }, current: async () => ({ kind: "directory", person: owner, sessionId: `mcp:${randomUUID()}` }), isCurrent: () => true };
 await expect(catalogs.refresh(ctx, { fleetId: w.fleetId })).rejects.toMatchObject({ code: "denied" });
 await expect(previous.view(ctx, w.exposureId)).rejects.toMatchObject({ code: "denied" });
 await expect(previous.use(ctx, w.exposureId, { revision: 1, digest: "a".repeat(64) })).rejects.toMatchObject({ code: "denied" });
 expect(w.r.sent.filter(x => x.frame.type === "agent.catalog-refresh")).toHaveLength(0); catalogs.close();
});
