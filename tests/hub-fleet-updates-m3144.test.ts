import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; vi.useRealTimers(); });
const path = "/hub/v1/admin/fleet-updates";
async function world() {
  let at = 1_800_000_000_000;
  r = await s3bRig({ now: () => at, versionRegistry: async () => "found" });
  const owner = r.addPerson("owner"), id = randomUUID(), admin = await r.signIn("admin");
  r.store.mutate({ requestId: randomUUID(), at, actor: { kind: "local-host" }, action: "fixture", result: "completed" }, state => {
    state.fleets.push({ id, owner, generation: 1, credentialHash: "a".repeat(64), status: "active" });
  });
  const link = r.link(id, owner, 1, ["welcome-caps-v1", "fleet-info-v1", "fleet-update-v1"]);
  await r.http.receive(r.frame("fleet.info", { version: "2.3.5", runsAsService: true, updatesAllowed: true }, link) as never, link);
  await r.call(admin, "PUT", "/hub/v1/admin/recommended-version", { mode: "specific", version: "2.4.0", ifRevision: 0 });
  const body = () => ({ fleetIds: [id], ifRevision: 1, idempotencyKey: randomUUID() });
  const row = async () => (await r!.call(admin, "GET", "/hub/v1/admin/overview")).json.fleets[0];
  return { owner, id, admin, link, body, row, advance: (ms: number) => { at += ms; } };
}
it("accepts only the saved recommendation and makes repeated presses idempotent", async () => {
  const w = await world(), b = w.body();
  const reply = await r!.call(w.admin, "POST", path, b);
  expect(reply.status).toBe(200);
  expect(reply.json).toMatchObject({ requests: [{ fleetId: w.id, version: "2.4.0", state: "queued", requestedBy: { name: "Hub Admin" } }], refused: [] });
  const again = await r!.call(w.admin, "POST", path, b);
  expect(again.json.requests[0].id).toBe(reply.json.requests[0].id);
  expect((await w.row()).updateRequest.id).toBe(reply.json.requests[0].id);
  expect((await r!.call(w.admin, "POST", path, { ...w.body(), version: "2.5.0" })).status).toBe(400);
  expect((await r!.call(w.admin, "POST", path, { ...w.body(), ifRevision: 0 })).json).toEqual({ code: "revision-conflict" });
  expect(r!.db.prepare("SELECT COUNT(*) n FROM hub_fleet_update_requests").get()).toEqual({ n: 1 });
  expect(r!.audits.filter(a => a.action === "fleet.update-request")).toHaveLength(1);
});
it("requires admin and CSRF and refuses an owner's disabled permission", async () => {
  const w = await world(), owner = await r!.signIn("owner");
  expect((await r!.call(owner, "POST", path, w.body())).status).toBe(403);
  expect((await r!.call(w.admin, "POST", path, w.body(), { "X-AgEnD-Hub-CSRF": "wrong" })).status).toBe(403);
  await r!.http.receive(r!.frame("fleet.info", { version: "2.3.5", runsAsService: true, updatesAllowed: false }, w.link) as never, w.link);
  expect((await r!.call(w.admin, "POST", path, w.body())).json).toEqual({ requests: [], refused: [{ fleetId: w.id, code: "owner-disabled" }] });
});
it("retains offline work for seven days, cancels never-sent work immediately, and survives restart", async () => {
  const w = await world(); w.link.alive = false;
  const first = (await r!.call(w.admin, "POST", path, w.body())).json.requests[0];
  expect((await r!.call(w.admin, "POST", `${path}/${first.id}/cancel`, {})).json.state).toBe("cancelled");
  const next = (await r!.call(w.admin, "POST", path, w.body())).json.requests[0];
  await r!.restartHttp(); w.advance(7 * 86_400_000);
  const fresh = await r!.signIn("admin");
  expect((await r!.call(fresh, "GET", "/hub/v1/admin/overview")).json.fleets[0].updateRequest).toMatchObject({ id: next.id, state: "expired", reasonCode: "offline-7d" });
});
it("waits for Fleet confirmation of sent cancellation and admits only matching monotonic status", async () => {
  const w = await world(); r!.http.memberReady!(w.link);
  const req = (await r!.call(w.admin, "POST", path, w.body())).json.requests[0];
  await vi.waitFor(() => expect(r!.sent.some(s => s.frame.type === "fleet.update")).toBe(true));
  expect((await r!.call(w.admin, "POST", `${path}/${req.id}/cancel`, {})).json).toMatchObject({ state: "queued", cancelRequested: true });
  const status = { id: req.id, version: req.version, sequence: 1, state: "waiting", waitingSince: 1_800_000_000_001, expiresAt: 1_800_086_400_001 };
  await r!.http.receive(r!.frame("fleet.update-status", status, w.link) as never, w.link);
  expect((await w.row()).updateRequest).toMatchObject({ state: "waiting", cancelRequested: true });
  await r!.http.receive(r!.frame("fleet.update-status", { ...status, sequence: 2, state: "cancelled" }, w.link) as never, w.link);
  await r!.http.receive(r!.frame("fleet.update-status", status, w.link) as never, w.link);
  expect((await w.row()).updateRequest).toMatchObject({ state: "cancelled", cancelRequested: false });
  expect(r!.sent.filter(s => s.frame.type === "fleet.update-status-ack")).toHaveLength(3);
});
it("keeps an accepted target frozen, replaces waiting work only after cancellation, and fences revoked links", async () => {
  const w = await world(); r!.http.memberReady!(w.link);
  const req = (await r!.call(w.admin, "POST", path, w.body())).json.requests[0];
  await vi.waitFor(() => expect(r!.sent.some(s => s.frame.type === "fleet.update")).toBe(true));
  await r!.http.receive(r!.frame("fleet.update-status", { id: req.id, version: req.version, sequence: 1, state: "waiting" }, w.link) as never, w.link);
  await r!.call(w.admin, "PUT", "/hub/v1/admin/recommended-version", { mode: "specific", version: "2.5.0", ifRevision: 1 });
  expect((await w.row()).updateRequest.version).toBe("2.4.0");
  const next = (await r!.call(w.admin, "POST", path, { ...w.body(), ifRevision: 2 })).json.requests[0];
  expect(next.version).toBe("2.5.0");
  expect(r!.sent.filter(s => s.frame.type === "fleet.update" && s.frame.payload.id === next.id)).toHaveLength(0);
  await r!.http.receive(r!.frame("fleet.update-status", { id: req.id, version: req.version, sequence: 2, state: "cancelled" }, w.link) as never, w.link);
  await vi.waitFor(() => expect(r!.sent.some(s => s.frame.type === "fleet.update" && s.frame.payload.id === next.id)).toBe(true));
  r!.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "revoke", result: "completed" }, state => { state.fleets[0]!.status = "revoked"; });
  await r!.http.receive(r!.frame("fleet.update-status", { id: next.id, version: next.version, sequence: 1, state: "updating" }, w.link) as never, w.link);
  expect((await w.row()).updateRequest).toMatchObject({ state: "cancelled", reasonCode: "revoked" });
});

it("ignores foreign/version/conflicting status, rejects backward transitions and cancels no claimed update", async () => {
  const w = await world(); r!.http.memberReady!(w.link);
  const req = (await r!.call(w.admin, "POST", path, w.body())).json.requests[0];
  await vi.waitFor(() => expect(r!.sent.some(s => s.frame.type === "fleet.update")).toBe(true));
  const send = (value: object, link = w.link) => r!.http.receive(r!.frame("fleet.update-status", { id: req.id, version: req.version, sequence: 1, state: "waiting", ...value }, link) as never, link);
  const other = r!.link(randomUUID(), w.owner, 2, [...w.link.features]); r!.http.memberReady!(other);
  await send({}, other); await send({ version: "2.5.0" });
  expect((await w.row()).updateRequest.state).toBe("queued");
  await send({}); await send({ state: "done" }); // same sequence, changed body
  expect((await w.row()).updateRequest.state).toBe("waiting");
  await send({ sequence: 2, state: "updating" });
  await send({ sequence: 3, state: "waiting" });
  expect((await w.row()).updateRequest.state).toBe("updating");
  expect((await r!.call(w.admin, "POST", `${path}/${req.id}/cancel`, {})).status).toBe(409);
});
it("fails closed on legacy reconnects, non-service Fleets and already-current versions", async () => {
  const w = await world();
  for (const [info, code] of [
    [{ version: "2.3.5", runsAsService: false, updatesAllowed: true }, "not-service"],
    [{ version: "2.5.0", runsAsService: true, updatesAllowed: true }, "already-current"],
  ] as const) {
    await r!.http.receive(r!.frame("fleet.info", info, w.link) as never, w.link);
    expect((await r!.call(w.admin, "POST", path, w.body())).json.refused).toEqual([{ fleetId: w.id, code }]);
  }
  w.link.alive = false;
  const old = r!.link(w.id, w.owner, 2, ["welcome-caps-v1", "fleet-info-v1"]);
  r!.http.memberConnected!(old);
  expect((await w.row()).updatesAllowed).toBeNull();
  expect((await r!.call(w.admin, "POST", path, w.body())).json.refused).toEqual([{ fleetId: w.id, code: "unsupported" }]);
});

it("rolls back the entire press when its audit cannot commit", async () => {
  const w = await world(); r!.setAuditFails(true);
  expect((await r!.call(w.admin, "POST", path, w.body())).status).toBe(500);
  expect(r!.db.prepare("SELECT COUNT(*) n FROM hub_fleet_update_requests").get()).toEqual({ n: 0 });
  expect(r!.db.prepare("SELECT COUNT(*) n FROM hub_fleet_update_batches").get()).toEqual({ n: 0 });
});

it("clears a cancellation request when the Fleet already claimed, and ACKs a late status without reopening expiry", async () => {
  const w = await world(); r!.http.memberReady!(w.link);
  const req = (await r!.call(w.admin, "POST", path, w.body())).json.requests[0];
  await vi.waitFor(() => expect(r!.sent.some(s => s.frame.type === "fleet.update")).toBe(true));
  await r!.call(w.admin, "POST", `${path}/${req.id}/cancel`, {});
  await r!.http.receive(r!.frame("fleet.update-status", { id: req.id, version: req.version, sequence: 1, state: "updating" }, w.link) as never, w.link);
  expect((await w.row()).updateRequest).toMatchObject({ state: "updating", cancelRequested: false });
  // A separate sent-but-unaccepted request reaches its Hub queue deadline before a delayed status arrives.
  await r!.http.receive(r!.frame("fleet.update-status", { id: req.id, version: req.version, sequence: 2, state: "done" }, w.link) as never, w.link);
  const delayed = (await r!.call(w.admin, "POST", path, w.body())).json.requests[0];
  await vi.waitFor(() => expect(r!.sent.some(s => s.frame.type === "fleet.update" && s.frame.payload.id === delayed.id)).toBe(true));
  w.advance(7 * 86_400_000); const admin = await r!.signIn("admin");
  expect((await r!.call(admin, "GET", "/hub/v1/admin/overview")).json.fleets[0].updateRequest.state).toBe("expired");
  const before = r!.sent.filter(s => s.frame.type === "fleet.update-status-ack").length;
  await r!.http.receive(r!.frame("fleet.update-status", { id: delayed.id, version: delayed.version, sequence: 1, state: "expired", reasonCode: "busy-24h" }, w.link) as never, w.link);
  expect(r!.sent.filter(s => s.frame.type === "fleet.update-status-ack")).toHaveLength(before + 1);
  expect((await r!.call(admin, "GET", "/hub/v1/admin/overview")).json.fleets[0].updateRequest).toMatchObject({ state: "expired", reasonCode: "offline-7d" });
});
it("rejects a new-generation status before pending reconciliation has retired the old request", async () => {
  const w = await world(); r!.http.memberReady!(w.link);
  const transport = r!.httpDeps.transport()!;
  let release!: () => void, blocked = false;
  const hold = new Promise<void>(resolve => { release = resolve; });
  r!.httpDeps.transport = () => ({ send: async (id, frame) => { if (frame.type === "fleet.update") { blocked = true; await hold; } await transport.send(id, frame); } });
  try {
    const req = (await r!.call(w.admin, "POST", path, w.body())).json.requests[0];
    await vi.waitFor(() => expect(blocked).toBe(true));
    w.link.alive = false;
    r!.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "fixture.repair", result: "completed" }, state => { state.fleets[0]!.generation = 2; });
    const next = r!.link(w.id, w.owner, 2, [...w.link.features]); r!.http.memberReady!(next);
    // The held send keeps reconcile queued. This is the new authenticated generation reporting against the old row.
    await r!.http.receive(r!.frame("fleet.update-status", { id: req.id, version: req.version, sequence: 1, state: "updating" }, next) as never, next);
    expect(r!.db.prepare("SELECT state,sequence FROM hub_fleet_update_requests WHERE id=?").get(req.id)).toEqual({ state: "queued", sequence: 0 });
    expect(r!.sent.filter(s => s.frame.type === "fleet.update-status-ack")).toHaveLength(0);
  } finally { release(); await Promise.resolve(); }
});
it("refuses another press while updating or while predecessor cancellation is pending", async () => {
  const w = await world(); r!.http.memberReady!(w.link);
  const req = (await r!.call(w.admin, "POST", path, w.body())).json.requests[0];
  await vi.waitFor(() => expect(r!.sent.some(s => s.frame.type === "fleet.update")).toBe(true));
  await r!.http.receive(r!.frame("fleet.update-status", { id: req.id, version: req.version, sequence: 1, state: "updating" }, w.link) as never, w.link);
  expect((await r!.call(w.admin, "POST", path, w.body())).json.refused).toEqual([{ fleetId: w.id, code: "request-open" }]);
  await r!.http.receive(r!.frame("fleet.update-status", { id: req.id, version: req.version, sequence: 2, state: "done" }, w.link) as never, w.link);
  const waiting = (await r!.call(w.admin, "POST", path, w.body())).json.requests[0];
  await vi.waitFor(() => expect(r!.sent.some(s => s.frame.type === "fleet.update" && s.frame.payload.id === waiting.id)).toBe(true));
  await r!.http.receive(r!.frame("fleet.update-status", { id: waiting.id, version: waiting.version, sequence: 1, state: "waiting" }, w.link) as never, w.link);
  await r!.call(w.admin, "PUT", "/hub/v1/admin/recommended-version", { mode: "specific", version: "2.5.0", ifRevision: 1 });
  expect((await r!.call(w.admin, "POST", path, { ...w.body(), ifRevision: 2 })).json.requests).toHaveLength(1);
  expect((await r!.call(w.admin, "POST", path, { ...w.body(), ifRevision: 2 })).json.refused).toEqual([{ fleetId: w.id, code: "request-open" }]);
});
it("does not let a second authorized administrator replay the first administrator's operation key", async () => {
  const w = await world(), b = w.body();
  expect((await r!.call(w.admin, "POST", path, b)).status).toBe(200);
  const second = r!.addPerson("second-admin");
  r!.httpDeps.management = { require: async (ctx, permission) => {
    const actor = await ctx.current();
    if (actor.kind !== "directory" || ![r!.admin.objectId, second.objectId].includes(actor.person.objectId)) throw Error("test role denied");
    return { actor, permission, source: "roles", expiresAt: (r!.httpDeps.now?.() ?? Date.now()) + 5000, assertCurrent() { if (ctx.isCurrent?.() !== true) throw Error("stale test role"); } };
  } };
  const adminB = await r!.signIn("second-admin");
  const replay = await r!.call(adminB, "POST", path, b);
  expect(replay.status).toBe(409); expect(replay.json).toEqual({ code: "idempotency-conflict" });
  expect(r!.db.prepare("SELECT COUNT(*) n FROM hub_fleet_update_requests").get()).toEqual({ n: 1 });
});
