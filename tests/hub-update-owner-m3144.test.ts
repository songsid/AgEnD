/** Actual owner HTTP and Fleet host; npm and every updater launch are inert. */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { HubMemberUpdates, HUB_MEMBER_UPDATES_MIGRATION, type MemberUpdatesOptions } from "../src/hub/member/updates.js";
import { IDLE_UPDATE_MIGRATION } from "../src/update-idle.js";
import type { HubMemberLink } from "../src/hub/client.js";
import { csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { clearUpdateMarker, readUpdateProgress, setUpdateProgressStage } from "../src/update-marker.js";
import { WebNotices, WEB_NOTICES_FILE } from "../src/web-notices.js";
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const f of cleanup.splice(0).reverse()) await f(); vi.restoreAllMocks(); });
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => { const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
    const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("end", () => { const text = Buffer.concat(chunks).toString(); let body: unknown = text; try { body = JSON.parse(text); } catch {} resolve({ status: res.statusCode!, body }); });
  }); r.on("error", reject); if (body !== undefined) r.write(JSON.stringify(body)); r.end(); });
}
async function world() {
  const dir = mkdtempSync(join(tmpdir(), "hub-owner-update-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const fm = new FleetManager(dir) as any;
  const quiet = () => {}; fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, child: () => fm.logger };
  fm.fleetConfig = { instances: { agent: { working_directory: "/tmp" } }, defaults: {} }; fm.startupComplete = true;
  vi.spyOn(fm, "runningAgendVersion").mockReturnValue("2.3.5");
  vi.spyOn(fm, "getInstanceStatus").mockReturnValue("running");
  vi.spyOn(fm, "getInstanceExecutionState").mockReturnValue("working");
  vi.spyOn(fm, "getInstanceInteraction").mockReturnValue(null);
  vi.spyOn(fm, "hasPendingIdleGatedDelivery").mockReturnValue(false);
  const child = Object.assign(new EventEmitter(), { unref() {} });
  const launcher = vi.spyOn(fm, "launchInstalledUpdate").mockImplementation(async (_origin: unknown, current: unknown) => (current as () => boolean)() ? child : null);
  const db = new Database(":memory:"); cleanup.push(() => { db.close(); }); IDLE_UPDATE_MIGRATION.up(db); HUB_MEMBER_UPDATES_MIGRATION.up(db);
  let now = Date.now();
  const options: MemberUpdatesOptions = { db, binding: "profile-A", hubName: "Team Hub", version: "2.3.5", current: () => true, service: () => true,
    idle: () => fm.hubUpdateIdle(), busy: () => false, now: () => now, lookup: vi.fn(async () => "found" as const), canInstall: vi.fn(async () => true),
    launch: (row, control, pressed) => fm.launchHubUpdate(row, control, pressed), active: id => fm.hubUpdateOwned?.id === id, outcome: row => fm.hubUpdateOutcome(row), notify: n => fm.recordHubUpdateNotice(n) };
  const updates = new HubMemberUpdates(options); fm.hubUpdates = updates; cleanup.push(() => updates.close());
  const link = { features: new Set(["fleet-update-v1"]), linkEpoch: 1, current: () => true, send: async () => {} } as unknown as HubMemberLink;
  const admit = async () => { updates.setConsent(true); const value = { id: randomUUID(), version: "2.4.0", requestedAt: now, expiresAt: now + 7 * 86_400_000, requestedBy: { name: "Alex" } }; updates.receive(value, link); await updates.tick(); return value; };
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  cleanup.push(async () => { fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); await new Promise<void>(r => (fm.healthServer as Server).close(() => r())); });
  const port = ((fm.healthServer as Server).address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
  const session = (tier: "admin" | "read" | "guest" = "admin") => { const { sessionId } = fm.webSessions.create({ tier, surface: "local", label: "t", tokenEpoch: tokenEpoch(fm.webToken), owner: { adapterId: "discord", userId: tier === "guest" ? "7" : "1" } }); return { id: sessionId, read: { cookie: `agend_session=${sessionId}` }, write: { cookie: `agend_session=${sessionId}`, origin, "x-agend-csrf": csrfTokenFor(sessionId), "content-type": "application/json", "idempotency-key": `owner-key-${randomUUID()}` } }; };
  return { fm, dir, db, options, updates, child, launcher, port, session, admit, advance: (ms: number) => { now += ms; } };
}
const consent = "/api/settings/hub/update-consent", reqPath = (id: string) => `/api/settings/hub/fleet-updates/${id}`;
it("offers consent only to a signed-in local administrator, with CSRF and exact body validation", async () => {
  const w = await world(), a = w.session();
  expect((await raw(w.port, "GET", consent)).status).toBe(401);
  for (const tier of ["read", "guest"] as const) expect([401, 403]).toContain((await raw(w.port, "GET", consent, w.session(tier).read)).status);
  expect((await raw(w.port, "GET", consent, { "x-agend-token": w.fm.webToken })).status).toBe(403);
  expect((await raw(w.port, "PUT", consent, a.read, { on: true })).status).toBe(403);
  expect((await raw(w.port, "PUT", consent, a.write, { on: true, version: "9.0.0" })).status).toBe(400);
  expect(await raw(w.port, "PUT", consent, a.write, { on: true })).toEqual({ status: 200, body: { on: true, available: true } });
  expect(w.launcher).not.toHaveBeenCalled();
});
it("reads and cancels one retained request, and ignores a browser's version choice", async () => {
  const w = await world(), a = w.session(), request = await w.admit();
  expect((await raw(w.port, "GET", reqPath(request.id), a.read)).body).toMatchObject({ id: request.id, version: "2.4.0", state: "waiting" });
  expect((await raw(w.port, "POST", `${reqPath(request.id)}/cancel`, a.write, { version: "9.0.0" })).status).toBe(400);
  expect((await raw(w.port, "POST", `${reqPath(request.id)}/cancel`, a.write, {})).body.state).toBe("cancelled");
  expect((await raw(w.port, "GET", reqPath(randomUUID()), a.read)).status).toBe(404);
  expect(w.launcher).not.toHaveBeenCalled();
});
it("starts the same waiting request once after the owner's explicit confirmation, despite a working agent", async () => {
  const w = await world(), a = w.session(), request = await w.admit();
  const body = { confirm: "update-agend", hubRequestId: request.id, version: "9.9.9" };
  expect((await raw(w.port, "POST", "/ui/update/start", a.write, { hubRequestId: request.id })).status).toBe(400);
  expect((await raw(w.port, "POST", "/ui/update/start", a.write, { ...body, recommended: { revision: 1, version: "9.9.9" } })).status).toBe(400);
  expect((await raw(w.port, "POST", "/ui/update/start", a.write, body)).status).toBe(202);
  expect((await raw(w.port, "POST", "/ui/update/start", a.write, body)).status).toBe(202);
  expect(w.launcher).toHaveBeenCalledTimes(1); expect(w.launcher.mock.calls[0]![2]).toBe(request.version);
  expect(w.updates.view(request.id)?.state).toBe("updating");
  expect((await raw(w.port, "POST", `${reqPath(request.id)}/cancel`, a.write, {})).status).toBe(409);
});
it("honors session revocation during launch preparation without consuming the update claim", async () => {
  const w = await world(), a = w.session(), request = await w.admit();
  let release!: () => void, entered = false;
  w.launcher.mockImplementation(async (_origin, current) => { entered = true; await new Promise<void>(r => { release = r; }); return (current as () => boolean)() ? w.child : null; });
  const start = raw(w.port, "POST", "/ui/update/start", a.write, { confirm: "update-agend", hubRequestId: request.id });
  await vi.waitFor(() => expect(entered).toBe(true)); try { w.fm.webSessions.revokeById(a.id); } finally { release(); }
  expect((await start).status).toBe(409); expect(w.updates.view(request.id)?.state).toBe("waiting");
});
it("uses an expired request's verified target as a new local update without reopening its Hub outcome", async () => {
  const w = await world(), a = w.session(), request = await w.admit(); w.advance(86_400_000); await w.updates.tick();
  expect(w.updates.view(request.id)?.state).toBe("expired");
  expect((await raw(w.port, "POST", "/ui/update/start", a.write, { confirm: "update-agend", hubRequestId: request.id })).status).toBe(202);
  expect(w.launcher.mock.calls.at(-1)![2]).toBe(request.version); expect(w.updates.view(request.id)?.state).toBe("expired");
});
it("treats unknown execution, approval and an in-flight delivery as busy", async () => {
  const w = await world();
  expect(w.fm.hubUpdateIdle()).toBe(false);
  w.fm.getInstanceExecutionState.mockReturnValue("idle"); expect(w.fm.hubUpdateIdle()).toBe(true);
  w.fm.getInstanceInteraction.mockReturnValue({ phase: "waiting" }); expect(w.fm.hubUpdateIdle()).toBe(false);
  w.fm.getInstanceInteraction.mockReturnValue(null); w.fm.hasPendingIdleGatedDelivery.mockReturnValue(true); expect(w.fm.hubUpdateIdle()).toBe(false);
  w.fm.hasPendingIdleGatedDelivery.mockReturnValue(false); w.fm.getInstanceExecutionState.mockReturnValue("unknown"); expect(w.fm.hubUpdateIdle()).toBe(false);
  w.fm.getInstanceStatus.mockReturnValue("stopped"); expect(w.fm.hubUpdateIdle()).toBe(true);
});
it("keeps request-bound owner notices durable and deduplicated across a notice-store restart", async () => {
  const w = await world(), request = await w.admit();
  const first = w.fm.webNoticeStore().view().items[0];
  expect(first.hubUpdate).toMatchObject({ requestId: request.id, state: "waiting", version: request.version, requestedBy: "Alex" });
  w.fm.recordHubUpdateNotice(first.hubUpdate);
  const reopened = new WebNotices(join(w.dir, WEB_NOTICES_FILE), w.fm.logger);
  expect(reopened.view().items).toHaveLength(1); expect(reopened.view().items[0]!.hubUpdate).toEqual(first.hubUpdate);
  w.updates.cancel({ id: request.id, version: request.version }); expect(w.fm.webNoticeStore().view().items[0].hubUpdate.state).toBe("cancelled");
});
it("does not mistake a detached launcher's successful exit for completion and eventually settles its failed marker", async () => {
  const w = await world(), request = await w.admit(); await w.updates.updateNow(request.id, () => true);
  vi.useFakeTimers(); w.child.emit("exit", 0);
  expect(w.updates.view(request.id)?.state).toBe("updating");
  setUpdateProgressStage(w.dir, "failed", { error: "inert updater failure" });
  await vi.advanceTimersByTimeAsync(5000);
  expect(w.updates.view(request.id)).toMatchObject({ state: "failed", currentVersion: "2.3.5" }); expect(w.fm.hubUpdateOwned).toBeNull();
});
it("keeps a request-bound chat button for an administrator after refusing a stranger", async () => {
  const w = await world(), request = await w.admit(), alerts: any[] = [];
  const adapter = { notifyAlert: vi.fn(async (_chat: string, alert: unknown) => { alerts.push(alert); return { chatId: "-100", messageId: "m1" }; }), editMessage: vi.fn(async () => {}) };
  vi.spyOn(w.fm, "findGeneralInstance").mockReturnValue("agent"); vi.spyOn(w.fm, "getInstanceAdapterId").mockReturnValue("tg");
  vi.spyOn(w.fm, "getAdapterForInstance").mockReturnValue(adapter); vi.spyOn(w.fm, "getGroupIdForInstance").mockReturnValue("-100");
  vi.spyOn(w.fm, "fleetAdminGate").mockImplementation((id: unknown) => id === "1" ? "ok" : "denied");
  vi.spyOn(w.fm, "retireNonceButtons").mockImplementation(async () => {});
  await w.fm.postHubUpdateChat({ requestId: request.id, hubName: "Team Hub", requestedBy: "Alex", version: request.version, state: "waiting" }, "waiting");
  const id = alerts[0].choices[0].id as string, nonce = id.slice("hub-fleet-update:".length, "hub-fleet-update:".length + 32);
  const press = (userId: string) => w.fm.handleHubFleetUpdateCallback({ callbackData: id, userId, chatId: "-100", messageId: "m1", ack: vi.fn() }, "tg", adapter);
  expect(await press("9")).toBe(true); expect(w.launcher).not.toHaveBeenCalled(); expect(w.fm.pendingHubFleetUpdates.get(nonce)).toBe(request.id);
  expect(await press("1")).toBe(true); expect(w.launcher).toHaveBeenCalledTimes(1); expect(w.launcher.mock.calls[0]![2]).toBe(request.version);
});

it("keeps exact boot progress for a late Hub mount after startup clears the ordinary marker", async () => {
  const w = await world(), request = await w.admit(); await w.updates.updateNow(request.id, () => true);
  setUpdateProgressStage(w.dir, "starting"); w.fm.hubUpdateBootProgress = readUpdateProgress(w.dir);
  w.fm.hubUpdateOwned = null; clearUpdateMarker(w.dir);
  expect(w.fm.hubUpdateOutcome({ id: request.id, version: request.version })).toEqual({ state: "rolled-back", currentVersion: "2.3.5" });
  expect(w.fm.hubUpdateOutcome({ id: randomUUID(), version: request.version }).state).toBe("failed");
  w.fm.runningAgendVersion.mockReturnValue(request.version); w.fm.startupComplete = false;
  expect(w.fm.hubUpdateOutcome({ id: request.id, version: request.version })).toBeNull(); w.fm.startupComplete = true;
  expect(w.fm.hubUpdateOutcome({ id: request.id, version: request.version })).toEqual({ state: "done", currentVersion: request.version });
});
it("refuses the expired-request Update button without a committed local verification", async () => {
  const w = await world(), a = w.session();
  w.options.lookup = async () => { w.advance(7 * 86_400_000); return "found"; };
  const request = await w.admit(); expect(w.updates.view(request.id)?.state).toBe("expired");
  const result = await raw(w.port, "POST", "/ui/update/start", a.write, { confirm: "update-agend", hubRequestId: request.id });
  expect(result).toEqual({ status: 404, body: { error: "request_not_found" } }); expect(w.launcher).not.toHaveBeenCalled();
});
it("M-3770 (#4480 §4.1): the idle launch of a Hub request is unattended — its pre-flight must be self; the owner's own press is a press", async () => {
  const w = await world(); await w.admit();
  w.fm.getInstanceExecutionState.mockReturnValue("idle");
  await w.updates.tick();
  await vi.waitFor(() => expect(w.launcher).toHaveBeenCalledTimes(1));
  expect(w.launcher.mock.calls[0]![3]).toBe("unattended");
  const p = await world(), owner = p.session(), asked = await p.admit();
  expect((await raw(p.port, "POST", "/ui/update/start", owner.write, { confirm: "update-agend", hubRequestId: asked.id })).status).toBe(202);
  expect(p.launcher.mock.calls[0]![3]).toBe("press");
});
