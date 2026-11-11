/**
 * M-2921 (A-L8 at the route): the read-only probe answers a private admin session of this computer — the same session
 * Start needs — with no Settings replay; a header token, a guest (neither holds that session) and the public link are
 * refused before the controller is reached. reconnect and remove are confirmed writes: never without the replay.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { handleSettingsRequest } from "../src/settings-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

function call(path: string, body: unknown, o: { session?: boolean; gateway?: boolean } = {}) {
  const req: any = Object.assign(new EventEmitter(), { method: "POST", url: path, headers: { "content-type": "application/json" } });
  if (o.gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "fixture", expectedOrigin: "https://fixture.invalid", isCurrent: () => true });
  const controller = { probe: vi.fn(async () => ({ ok: true, hubName: "Acme Hub" })), reconnect: vi.fn(), remove: vi.fn(), display: () => null };
  const ctx: any = { webToken: "fixture-token", webSessions: null, fleetConfig: { defaults: {}, instances: {} }, getRawFleetConfig: () => ({}),
    hubCompanyJoin: async () => controller, hubMemberPairing: () => ({}),
    hubCompanySession: () => o.session === false ? null : { current: () => true, fleetOrigin: "http://127.0.0.1:4444", sessionId: "s" } };
  const answer = new Promise<{ status: number; body: any }>(resolve => {
    let status = 0;
    const res: any = { writeHead(n: number) { status = n; }, setHeader() {}, end(text: string) { resolve({ status, body: JSON.parse(text) }); } };
    expect(handleSettingsRequest(req, res, new URL(path, "http://127.0.0.1"), ctx)).toBe(true);
  });
  queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
  return { answer, controller };
}
describe("M-2921: the probe, reconnect and remove routes", () => {
  it("probe: a private admin session of this computer gets the answer, with this Fleet's own origin (not the browser's word)", async () => {
    const r = call("/api/hub/member/company-join/probe", { address: "https://hub.example.test" });
    expect(await r.answer).toEqual({ status: 200, body: { ok: true, hubName: "Acme Hub" } });
    expect(r.controller.probe).toHaveBeenCalledWith({ address: "https://hub.example.test", fleetOrigin: "http://127.0.0.1:4444" }, expect.anything());
  });
  it.each([[{ session: false }, 403], [{ gateway: true }, 403]] as const)("probe refused %j", async (o, status) => {
    const r = call("/api/hub/member/company-join/probe", { address: "https://hub.example.test" }, o);
    expect((await r.answer).status).toBe(status); expect(r.controller.probe).not.toHaveBeenCalled();
  });
  it.each([{ address: "https://hub.example.test", fleetOrigin: "https://victim.test" }, {}, { address: 1 }])("probe takes the address only: %j is invalid", async body => {
    const r = call("/api/hub/member/company-join/probe", body);
    expect((await r.answer).status).toBe(400); expect(r.controller.probe).not.toHaveBeenCalled();
  });
  it.each(["reconnect", "remove"])("%s without a confirmed Settings replay: refused, nothing done", async step => {
    const r = call(`/api/hub/member/company-join/${step}`, { hubId: "11111111-2222-4333-8444-555555555555", binding: "b".repeat(64), address: "https://hub.example.test" });
    expect(await r.answer).toMatchObject({ status: 403, body: { error: expect.stringMatching(/^(private_session_required|admin_confirmation_required)$/) } });
    expect(r.controller.reconnect).not.toHaveBeenCalled(); expect(r.controller.remove).not.toHaveBeenCalled();
  });
  it.each(["reconnect", "remove"])("%s from the public link or with no private session: refused", async step => {
    for (const o of [{ gateway: true }, { session: false }]) {
      const r = call(`/api/hub/member/company-join/${step}`, {}, o);
      expect((await r.answer).status).toBe(403);
    }
  });
});
