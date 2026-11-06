import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { handleSettingsRequest } from "../src/settings-api.js";
import { createSettingsReplay } from "../src/settings-request-capability.js";
import { SettingsExecution } from "../src/settings-transaction.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

const path = "/api/settings/hub/retention", input = { contentDays: 7, eventDays: 30, revision: 1 };
const caps: SettingsExecution[] = [];
afterEach(() => { for (const cap of caps.splice(0)) cap.close(); });
async function call(o: { method?: string; replay?: boolean; admin?: boolean; gateway?: boolean; absent?: boolean;
  json?: unknown; meanwhile?: (ctx: any, cap: SettingsExecution) => void } = {}) {
  const body = Buffer.from(JSON.stringify(o.json ?? input)), method = o.method ?? "PUT";
  const cap = new SettingsExecution({ current: () => true, snapshot: () => null }); caps.push(cap);
  const req = o.replay ? createSettingsReplay({ method, url: path, body, binding: "owner", localAdmin: () => o.admin !== false }, cap)
    : Object.assign(new EventEmitter(), { method, url: path, headers: o.admin === false ? { cookie: "__Host-agend_hub_fake=not-a-host-session" } : { "x-agend-token": "tok" } }) as unknown as IncomingMessage;
  if (o.gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "scratch", expectedOrigin: "https://scratch.invalid", isCurrent: () => true });
  const control = { read: vi.fn(() => ({ contentDays: 30, eventDays: 180, revision: 1 })),
    update: vi.fn((p: unknown, current: () => boolean) => { if (!current()) throw Error("unavailable"); return { ...(p as any), revision: 2 }; }) };
  const ctx = { webToken: "tok", webSessions: null, fleetConfig: { defaults: {}, instances: {} }, logger: { warn: vi.fn() }, hubRetention: () => o.absent ? null : control };
  const response = await new Promise<{ status: number; body: any }>(resolve => {
    let status = 0;
    const res = { writeHead(v: number) { status = v; }, setHeader() {}, end(v: string) { resolve({ status, body: JSON.parse(v) }); } };
    expect(handleSettingsRequest(req, res as never, new URL(path, "http://localhost"), ctx as never)).toBe(true);
    o.meanwhile?.(ctx, cap);
    if (!o.replay) { req.emit("data", body); req.emit("end"); }
  });
  return { ...response, control };
}
describe("host Hub retention Settings routes", () => {
  it("reads only for the host admin; a Hub cookie gives no host authority", async () => {
    expect(await call({ method: "GET" })).toMatchObject({ status: 200, body: { policy: { contentDays: 30 } } });
    expect(await call({ method: "GET", admin: false })).toMatchObject({ status: 403 });
    expect(await call({ method: "GET", absent: true })).toMatchObject({ status: 404 });
  });
  it("requires an actual server-owned confirmed replay, not a token, body or public-link claim", async () => {
    for (const options of [{}, { replay: true, admin: false }, { replay: true, gateway: true }]) {
      const r = await call(options); expect(r.status).toBe(403); expect(r.control.update).not.toHaveBeenCalled();
    }
    const r = await call({ replay: true });
    expect(r).toMatchObject({ status: 200, body: { ok: true, policy: { ...input, revision: 2 } } });
    expect(r.control.update).toHaveBeenCalledWith(input, expect.any(Function));
  });
  it("rechecks authority and the mounted policy after the body read", async () => {
    for (const meanwhile of [(ctx: any) => { ctx.hubRetention = () => null; }, (_ctx: any, cap: SettingsExecution) => cap.cancel()]) {
      const r = await call({ replay: true, meanwhile }); expect(r.status).toBe(503); expect(r.control.update).not.toHaveBeenCalled();
    }
  });
});
