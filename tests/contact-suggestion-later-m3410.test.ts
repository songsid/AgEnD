import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { WebSessionStore, tokenEpoch, csrfTokenFor } from "../src/web-session.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { handleWebRequest } from "../src/web-api.js";
const disposers: Array<() => void> = [];
afterEach(() => { for (const close of disposers.splice(0)) close(); });
const token = "x".repeat(48), room = "room-demo", adapter = { id: "fake-bot", type: "discord" };
function rig() {
  const root = mkdtempSync(join(tmpdir(), "contact-later-")), outbox = new DeliveryOutbox(join(root, "outbox.db")), sessions = new WebSessionStore();
  disposers.push(() => { outbox.close(); rmSync(root, { recursive: true, force: true }); });
  const m = Object.assign(Object.create(FleetManager.prototype), {
    dataDir: root, deliveryOutbox: outbox, fleetConfig: { defaults: {}, instances: {} }, webSessions: sessions,
    adapters: new Map([[adapter.id, adapter]]),
    classicChannels: { getAll: () => [{ instanceName: room, adapterId: adapter.id, restrictedMode: false }], isAdmin: () => false },
    getAdapterForInstance: () => adapter, getInstanceAdapterId: () => adapter.id,
    isFleetAdmin: (user: string, bot: string) => user === "fake-admin" && bot === adapter.id,
    webAuthority: vi.fn(() => ({ authority: { kind: "none", actor: null }, refusal: "not_authorized" })),
    emitSseEvent: vi.fn(), needsYouItems: () => [], logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }) as any;
  Object.defineProperty(m, "webToken", { value: token });
  return { m, sessions, store: outbox.contactAuthorizations };
}
function call(r: ReturnType<typeof rig>, opts: { remote?: boolean; tier?: "admin" | "read"; bot?: string; user?: string; header?: boolean; csrf?: boolean; beforeBody?: (sessionId: string) => void } = {}) {
  const origin = opts.remote ? "https://dashboard.example.test" : "http://127.0.0.1:19280", exposureId = "a".repeat(32);
  const s = r.sessions.create({ tier: opts.tier ?? "admin", surface: opts.remote ? "gateway" : "local", label: "Synthetic browser", tokenEpoch: tokenEpoch(token),
    ...(opts.remote ? { exposureId } : {}), owner: { adapterId: opts.bot ?? adapter.id, userId: opts.user ?? "fake-admin" } });
  const req = Object.assign(new EventEmitter(), { method: "POST", url: "/ui/needs/ack", socket: { remoteAddress: "127.0.0.1" },
    headers: { host: new URL(origin).host, origin, ...(opts.header ? { "x-agend-token": token } : {
      cookie: `${opts.remote ? "__Host-agend_session" : "agend_session"}=${s.sessionId}`,
      ...(opts.csrf === false ? {} : { "x-agend-csrf": csrfTokenFor(s.sessionId) }),
    }) } });
  if (opts.remote) bindGatewayRequest(req, { surface: "gateway", exposureId, expectedOrigin: origin, isCurrent: () => true });
  let status = 0, finish!: (v: { status: number; body: any }) => void;
  const done = new Promise<{ status: number; body: any }>(resolve => { finish = resolve; });
  const res = { destroyed: false, headersSent: false, setHeader() {}, writeHead(n: number) { status = n; }, end(body: string) { finish({ status, body: JSON.parse(body) }); } };
  expect(r.m.contactActor(req, new URL(req.url, origin)), "no verified action authority").toBeNull();
  handleWebRequest(req as any, res as any, new URL(req.url, origin), r.m);
  opts.beforeBody?.(s.sessionId); req.emit("data", Buffer.from(JSON.stringify({ id: `contact-suggest:${room}` }))); req.emit("end");
  return done;
}
it.each([false, true])("a current room-admin session can dismiss without verification (public=%s); no authority or mode changes", async remote => {
  const r = rig(); const response = await call(r, { remote });
  expect(response).toEqual({ status: 200, body: { acknowledged: true } });
  expect(r.store.suggestionDismissed(room)).toBe(true);
  expect(r.m.classicChannels.getAll()[0].restrictedMode).toBe(false);
  expect(r.m.webAuthority().authority.kind).toBe("none");
});
it.each([{ tier: "read" as const }, { bot: "other-bot" }, { user: "not-an-admin" }, { header: true }, { csrf: false }])("refuses readers, other namespaces, removed admins, CLI tokens and missing CSRF: %j", async opts => {
  const r = rig(); expect((await call(r, opts)).status).toBeGreaterThanOrEqual(400);
  expect(r.store.suggestionDismissed(room)).toBe(false);
});
it("rechecks the current room-admin role after reading the body", async () => {
  const r = rig(); expect((await call(r, { beforeBody: () => { r.m.isFleetAdmin = () => false; } })).status).toBe(403);
  expect(r.store.suggestionDismissed(room)).toBe(false);
});
it("a storage failure is unavailable, not a false authority refusal, and is logged", async () => {
  const r = rig(); vi.spyOn(r.store, "dismissSuggestion").mockImplementation(() => { throw Object.assign(Error("synthetic storage fault"), { code: "SQLITE_READONLY" }); });
  expect(await call(r)).toEqual({ status: 503, body: { error: "unavailable", code: "unavailable" } });
  expect(r.m.logger.error).toHaveBeenCalledWith({ code: "SQLITE_READONLY" }, "Contact suggestion dismissal could not be saved"); expect(r.store.suggestionDismissed(room)).toBe(false);
});

it("a session revoked while the body is read cannot dismiss", async () => {
  const r = rig(); expect((await call(r, { beforeBody: id => { r.sessions.revokeById(id); } })).status).toBeGreaterThanOrEqual(400);
  expect(r.store.suggestionDismissed(room)).toBe(false);
});
it("an unverified admin's passive list includes room suggestions but never pending approval tickets", () => {
  const r = rig(), s = r.sessions.create({ tier: "admin", surface: "local", label: "Synthetic browser", tokenEpoch: tokenEpoch(token), owner: { adapterId: adapter.id, userId: "fake-admin" } });
  const suggestion = { id: `contact-suggest:${room}`, type: "contact", reason: "contact_restricted_suggestion", instance: room };
  r.m.contactNeeds = () => [{ id: "contact:Rfake", type: "contact", reason: "contact_request", detail: "private pending work" }, suggestion];
  r.m.getUiStatus = () => ({ instances: [] }); r.m.listWebPrompts = () => [];
  const req = Object.assign(new EventEmitter(), { method: "GET", url: "/ui/poll", headers: { host: "localhost", cookie: `agend_session=${s.sessionId}` }, socket: { remoteAddress: "127.0.0.1" } });
  let data: any;
  const res = { setHeader() {}, writeHead() {}, end(body: string) { data = JSON.parse(body); } };
  handleWebRequest(req as any, res as any, new URL(req.url, "http://localhost"), r.m);
  expect(data.needs).toEqual([suggestion]); expect(JSON.stringify(data)).not.toContain("private pending work");
});
