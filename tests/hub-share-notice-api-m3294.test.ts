import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import { WebSessionStore, tokenEpoch, csrfTokenFor } from "../src/web-session.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import type { HubSharingController, HubSharingNotice } from "../src/hub-sharing-notice.js";
function world() {
  const token = "fixture", sessions = new WebSessionStore({ exposureEnd: () => Date.now() + 60_000 });
  const value: HubSharingNotice = { key: "a".repeat(64), hubName: "Demo Hub", byName: "Owner", at: Date.now(), undoUntil: Date.now() + 86_400_000,
    version: 2, state: "complete", rows: [{ name: "Documents", action: "share", kind: "agent", state: "shared" }] };
  let controller: HubSharingController | null = { view: () => value, undo: vi.fn(async (_key, _actor, current) => { if (!current()) throw Error("revoked"); return { ...value, state: "undone" as const }; }) };
  const ctx = { webToken: token, webSessions: sessions, hubSharing: () => controller } as SettingsApiContext;
  const issue = (tier: "admin" | "read" | "guest", gateway = false) => sessions.create({ tier, surface: gateway ? "gateway" : "local", label: "Test device",
    tokenEpoch: tokenEpoch(token), ...(gateway ? { exposureId: "fixture" } : {}), ...(tier === "guest" ? { owner: { adapterId: "chat", userId: "fake-reader" } } : {}) });
  const call = async (who: ReturnType<typeof issue> | null, options: { method?: string; gateway?: boolean; body?: unknown; beforeBody?(): void; header?: boolean } = {}) => {
    const method = options.method ?? "POST", path = `/api/settings/hub/sharing-notices/${value.key}${method === "POST" ? "/undo" : ""}`;
    const origin = options.gateway ? "https://preview.example.test" : "http://127.0.0.1:9999";
    const req = Object.assign(new EventEmitter(), { method, url: path, socket: { remoteAddress: "127.0.0.1" }, headers: {
      host: new URL(origin).host, origin, "content-type": "application/json",
      ...(who ? { cookie: `${options.gateway ? "__Host-agend_session" : "agend_session"}=${who.sessionId}`, "x-agend-csrf": csrfTokenFor(who.sessionId) } : {}),
      ...(options.header ? { "x-agend-token": token } : {}),
    } });
    if (options.gateway) bindGatewayRequest(req as never, { surface: "gateway", exposureId: "fixture", expectedOrigin: origin, isCurrent: () => true });
    return new Promise<{ status: number; body: any }>(resolve => {
      let status = 0;
      const res = { writeHead(code: number) { status = code; }, setHeader() {}, end(text: string) { resolve({ status, body: JSON.parse(text) }); } };
      expect(handleSettingsRequest(req as never, res as never, new URL(path, origin), ctx)).toBe(true);
      options.beforeBody?.(); req.emit("data", Buffer.from(JSON.stringify(options.body ?? {}))); req.emit("end");
    });
  };
  return { token, sessions, value, ctx, issue, call, get controller() { return controller!; }, detach: () => { controller = null; } };
}
it("requires an actual admin session on either listener; guest, read-only and header-only callers cannot Undo", async () => {
  const w = world();
  for (const who of [null, w.issue("guest"), w.issue("read")]) expect((await w.call(who, { header: true })).status).toBe(403);
  expect((await w.call(w.issue("admin"))).status).toBe(200);
  expect((await w.call(w.issue("admin", true), { gateway: true })).status).toBe(200);
  expect(w.controller.undo).toHaveBeenCalledTimes(2);
});
it("pins the captured session and controller across body reading and refuses caller-supplied action fields", async () => {
  const w = world(), admin = w.issue("admin");
  expect((await w.call(admin, { body: { owner: "someone" } })).status).toBe(400);
  expect((await w.call(admin, { beforeBody: () => w.sessions.revokeByHandle(admin.record.handle) })).status).toBe(403);
  expect(w.controller.undo).not.toHaveBeenCalled();
  const another = world(), next = another.issue("admin"), controller = another.controller;
  expect((await another.call(next, { beforeBody: another.detach })).status).toBe(403); expect(controller.undo).not.toHaveBeenCalled();
});
it("refuses a known expiry and reports an uncertain effect as pending rather than a definite failure", async () => {
  const w = world(), admin = w.issue("admin"); w.value.undoUntil = Date.now() - 1;
  expect(await w.call(admin)).toMatchObject({ status: 409, body: { error: "expired" } }); expect(w.controller.undo).not.toHaveBeenCalled();
  w.value.undoUntil = Date.now() + 60_000; w.controller.undo = vi.fn(async () => { throw Error("lost result"); });
  expect(await w.call(admin)).toMatchObject({ status: 202, body: { pending: true, notice: { state: "complete" } } });
});
