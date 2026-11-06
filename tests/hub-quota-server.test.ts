import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { applyHubMigrations } from "../src/hub/db.js";
import { HUB_HTTP_MIGRATIONS } from "../src/hub/http/schema.js";
import type { HubExposure, HubQuota } from "../src/hub/types.js";

type Rig = Awaited<ReturnType<typeof s3bRig>>;
let rig: Rig | null = null;
afterEach(async () => { await rig?.close(); rig = null; });
async function world() {
  let now = Date.parse("2026-11-06T10:00:00Z");
  const r = rig = await s3bRig({ now: () => now });
  const owner = r.addPerson("owner"), asker = r.addPerson("asker");
  const link = r.link(randomUUID(), owner);
  (link.features as Set<string>).add("welcome-caps-v1"); (link.features as Set<string>).add("quota-band-v1");
  const e: HubExposure = { id: randomUUID(), fleetId: link.fleetId, owner, displayName: "Representative", revision: 1,
    state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) };
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [e] }, link) as never, link);
  const o = await r.signIn("owner"), a = await r.signIn("asker"), admin = await r.signIn("admin");
  const grant = (await r.call(o, "POST", "/hub/v1/grants", { exposureId: e.id, exposureRevision: 1, login: "asker", days: 7 })).json.grant;
  const room = (await r.call(a, "POST", "/hub/v1/rooms", { exposureId: e.id, grantId: grant.id })).json.room;
  const update = (quota: HubQuota, exposureId = e.id, l = link) => r.http.receive(r.frame("exposure.quota", { exposureId, quota }, l) as never, l);
  const roomView = async () => (await r.call(a, "GET", "/hub/v1/rooms")).json.rooms[0];
  return { r, o, a, admin, link, e, grant, room, update, roomView, advance: (ms = 30_000) => { now += ms; } };
}
describe("Hub quota projection and privacy", () => {
  it("migrates an existing Hub with the real migration runner, reopens, and refuses an older build", () => {
    const db = new Database(":memory:");
    try {
      applyHubMigrations(db, HUB_HTTP_MIGRATIONS.slice(0, 1));
      expect(() => applyHubMigrations(db, HUB_HTTP_MIGRATIONS)).not.toThrow();
      expect(() => applyHubMigrations(db, HUB_HTTP_MIGRATIONS)).not.toThrow();
      expect(db.prepare("SELECT COUNT(*) AS n FROM hub_quota_preferences").get()).toEqual({ n: 0 });
      expect(() => applyHubMigrations(db, HUB_HTTP_MIGRATIONS.slice(0, 1))).toThrow("s3-quota");
    } finally { db.close(); }
  });
  it("refreshes both room projections without auditing quota or changing consent/grant revisions", async () => {
    const w = await world(), auditCount = w.r.audits.length;
    await w.update({ band: "near_limit" });
    expect(w.r.audits).toHaveLength(auditCount);
    expect(await w.roomView()).toMatchObject({ quota: { band: "near_limit" } });
    const messages = await w.r.call(w.a, "GET", `/hub/v1/rooms/${w.room.id}/messages`);
    expect(messages.status).toBe(200); expect(messages.json.room.quota).toEqual({ band: "near_limit" });
    const mine = (await w.r.call(w.o, "GET", "/hub/v1/exposures")).json.mine[0];
    expect(mine).toMatchObject({ revision: 1, quotaVisible: true, quota: { band: "near_limit" } });
    expect(mine.grants[0].revision).toBe(1);
    const question = await w.r.call(w.a, "POST", `/hub/v1/rooms/${w.room.id}/messages`, { idempotencyKey: randomUUID(), text: "Can still ask" });
    expect(question.status).toBe(200);
  });
  it("the owner hides per agent; every asker/owner projection omits the value, while grants keep working", async () => {
    const w = await world(); await w.update({ band: "exhausted" });
    const count = w.r.audits.length;
    expect((await w.r.call(w.o, "POST", `/hub/v1/exposures/${w.e.id}/quota`, { revision: 1, visible: false })).json).toEqual({ quotaVisible: false });
    expect(w.r.audits).toHaveLength(count);
    expect(await w.roomView()).not.toHaveProperty("quota");
    expect((await w.r.call(w.a, "GET", `/hub/v1/rooms/${w.room.id}/messages`)).json.room).not.toHaveProperty("quota");
    const mine = (await w.r.call(w.o, "GET", "/hub/v1/exposures")).json.mine[0];
    expect(mine).toMatchObject({ quotaVisible: false, revision: 1 }); expect(mine).not.toHaveProperty("quota");
    expect(w.r.db.prepare("SELECT visible FROM hub_quota_preferences WHERE exposure_id=?").get(w.e.id)).toEqual({ visible: 0 });
    expect((await w.r.call(w.o, "POST", `/hub/v1/exposures/${w.e.id}/quota`, { revision: 1, visible: true })).json).toMatchObject({ quotaVisible: true, quota: { band: "exhausted" } });
  });
  it("visibility writes require the owner, current revision, Origin and CSRF, with strict boolean input", async () => {
    const w = await world(), path = `/hub/v1/exposures/${w.e.id}/quota`, body = { revision: 1, visible: false };
    for (const who of [w.a, w.admin]) expect((await w.r.call(who, "POST", path, body)).status).toBe(404);
    expect((await w.r.call(null, "POST", path, body)).status).toBe(401);
    expect((await w.r.call(w.o, "POST", path, { ...body, revision: 0 })).status).toBe(409);
    expect((await w.r.call(w.o, "POST", path, { ...body, visible: "false" })).status).toBe(400);
    expect((await w.r.call(w.o, "POST", path, { ...body, percent: 95 })).status).toBe(400);
    expect((await w.r.call(w.o, "POST", path, body, { Origin: "https://other.invalid" })).status).toBe(403);
    expect((await w.r.call(w.o, "POST", path, body, { "X-AgEnD-Hub-CSRF": "bad" })).status).toBe(403);
    expect((await w.roomView()).quota.band).toBe("unknown");
  });
  it("refuses unnegotiated or cross-fleet updates, rate-limits band changes and forgets a retired link", async () => {
    const w = await world(); await w.update({ band: "available" });
    await w.update({ band: "near_limit" }); expect((await w.roomView()).quota.band).toBe("available");
    w.advance(); await w.update({ band: "near_limit" }); expect((await w.roomView()).quota.band).toBe("near_limit");
    await expect(w.update({ band: "exhausted" }, randomUUID())).rejects.toThrow("denied");
    const other = w.r.link(randomUUID(), w.link.owner); (other.features as Set<string>).add("quota-band-v1"); (other.features as Set<string>).add("welcome-caps-v1");
    await expect(w.update({ band: "exhausted" }, w.e.id, other)).rejects.toThrow("denied");
    (w.link.features as Set<string>).delete("quota-band-v1");
    await expect(w.update({ band: "exhausted" })).rejects.toThrow("denied");
    w.link.alive = false; expect((await w.roomView()).quota.band).toBe("unknown");
    const fresh = w.r.link(w.link.fleetId, w.link.owner, 2); (fresh.features as Set<string>).add("quota-band-v1"); (fresh.features as Set<string>).add("welcome-caps-v1");
    await w.update({ band: "exhausted" }, w.e.id, fresh); expect((await w.roomView()).quota.band).toBe("exhausted");
  });
  it("does not reveal quota through an expired grant or a different asker's room", async () => {
    const w = await world(); await w.update({ band: "near_limit" });
    expect((await w.r.call(w.o, "GET", `/hub/v1/rooms/${w.room.id}/messages`)).status).toBe(404);
    w.r.db.prepare("UPDATE hub_grants SET expires_at=? WHERE id=?").run(Date.parse("2026-11-06T10:00:30Z"), w.grant.id);
    w.advance(31_000);
    expect(await w.roomView()).not.toHaveProperty("quota");
    expect((await w.r.call(w.a, "GET", `/hub/v1/rooms/${w.room.id}/messages`)).status).toBe(403);
  });
  it("a passed approximate reset becomes unknown, never a stale promise of exhausted/available", async () => {
    const w = await world(), resetsAt = Date.parse("2026-11-06T10:05:00Z");
    await w.update({ band: "exhausted", resetsAt });
    expect((await w.roomView()).quota).toEqual({ band: "exhausted", resetsAt });
    w.advance(300_000); expect((await w.roomView()).quota).toEqual({ band: "unknown" });
  });
  it("coalesces an early arrival instead of losing the only band change to network jitter", async () => {
    const w = await world(); await w.update({ band: "available" }); w.advance(29_999);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await w.update({ band: "near_limit" }); await w.update({ band: "exhausted" });
      w.advance(1); await vi.advanceTimersByTimeAsync(1);
    } finally { vi.useRealTimers(); }
    expect((await w.roomView()).quota).toEqual({ band: "exhausted" });
  });
});
