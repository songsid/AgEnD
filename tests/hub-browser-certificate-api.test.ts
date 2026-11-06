import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { handleSettingsRequest } from "../src/settings-api.js";
import { createSettingsReplay } from "../src/settings-request-capability.js";
import { SettingsExecution } from "../src/settings-transaction.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

const base = "/api/settings/hub/browser-certificate", caps: SettingsExecution[] = [];
afterEach(() => { for (const cap of caps.splice(0)) cap.close(); });
async function call(o: { suffix?: string; method?: string; replay?: boolean; admin?: boolean; gateway?: boolean;
  localAdmin?: () => boolean; absent?: boolean; meanwhile?: (ctx: any, cap: SettingsExecution) => void;
  uncheckedPrepare?: boolean; duringPrepare?: (ctx: any) => void } = {}) {
  const path = base + (o.suffix ?? ""), method = o.method ?? "GET", input = { reference: "ref", revision: "revision" }, body = Buffer.from(JSON.stringify(input));
  const cap = new SettingsExecution({ current: () => true, snapshot: () => null }); caps.push(cap);
  const req = o.replay ? createSettingsReplay({ method, url: path, body, binding: "owner", localAdmin: o.localAdmin ?? (() => o.admin !== false) }, cap)
    : Object.assign(new EventEmitter(), { method, url: path, headers: o.admin === false ? { cookie: "__Host-agend_hub_fake=not-host-authority" } : { "x-agend-token": "tok" } }) as unknown as IncomingMessage;
  if (o.gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "scratch", expectedOrigin: "https://scratch.invalid", isCurrent: () => true });
  const control = { read: vi.fn(() => ({ selected: { fingerprint256: "public-fingerprint" } })),
    apply: vi.fn((_p: unknown, _binding: string, current: () => boolean) => { if (!current()) throw Error("unavailable"); return { restartRequired: false }; }),
    prepare: vi.fn(async (_p: unknown, _binding: string, current: () => boolean) => {
      o.duringPrepare?.(ctx); if (!o.uncheckedPrepare && !current()) throw Error("unavailable"); return { reference: "opaque-reference" };
    }) };
  const ctx = { webToken: "tok", webSessions: null, fleetConfig: { defaults: {}, instances: {} }, logger: { warn: vi.fn() }, hubBrowserCertificate: () => o.absent ? null : control };
  const response = await new Promise<{ status: number; body: any }>(resolve => {
    let status = 0;
    const res = { writeHead(v: number) { status = v; }, setHeader() {}, end(v: string) { resolve({ status, body: JSON.parse(v) }); } };
    expect(handleSettingsRequest(req, res as never, new URL(path, "http://localhost"), ctx as never)).toBe(true);
    o.meanwhile?.(ctx, cap);
    if (!o.replay) { req.emit("data", body); req.emit("end"); }
  });
  return { ...response, control };
}
describe("host browser-certificate Settings authority", () => {
  it("shows public metadata only to host admins and requires a mounted running Hub", async () => {
    expect(await call()).toMatchObject({ status: 200, body: { certificate: { selected: { fingerprint256: "public-fingerprint" } } } });
    expect(await call({ admin: false })).toMatchObject({ status: 403 });
    expect(await call({ absent: true })).toMatchObject({ status: 404 });
    for (const suffix of ["", "/prepare", "/apply"]) expect(await call({ suffix, method: suffix ? "POST" : "GET", gateway: true, replay: suffix === "/apply" })).toMatchObject({ status: 403 });
  });
  it("requires server-owned confirmation with current local authority to select a certificate", async () => {
    for (const o of [{}, { replay: true, admin: false }]) {
      const r = await call({ ...o, suffix: "/apply", method: "POST" }); expect(r.status).toBe(403); expect(r.control.apply).not.toHaveBeenCalled();
    }
    const r = await call({ suffix: "/apply", method: "POST", replay: true });
    expect(r).toMatchObject({ status: 200, body: { ok: true, certificate: { restartRequired: false } } });
    expect(r.control.apply).toHaveBeenCalledWith({ reference: "ref", revision: "revision" }, "owner", expect.any(Function));
    const admin = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    expect(await call({ suffix: "/apply", method: "POST", replay: true, localAdmin: admin })).toMatchObject({ status: 503 });
  });
  it("rechecks mounted control and confirmed execution after reading the apply body", async () => {
    for (const meanwhile of [(ctx: any) => { ctx.hubBrowserCertificate = () => null; }, (_ctx: any, cap: SettingsExecution) => cap.cancel()]) {
      const r = await call({ suffix: "/apply", method: "POST", replay: true, meanwhile }); expect(r.status).toBe(503); expect(r.control.apply).not.toHaveBeenCalled();
    }
  });
  it("binds preparation to the same host session and rechecks it after body read and generation", async () => {
    expect(await call({ suffix: "/prepare", method: "POST", admin: false })).toMatchObject({ status: 403 });
    const ok = await call({ suffix: "/prepare", method: "POST" }); expect(ok).toMatchObject({ status: 200, body: { proposal: { reference: "opaque-reference" } } });
    expect(ok.control.prepare).toHaveBeenCalledWith(expect.any(Object), expect.stringMatching(/^[0-9a-f]{64}$/), expect.any(Function));
    for (const change of [(ctx: any) => { ctx.webToken = "rotated"; }, (ctx: any) => { ctx.hubBrowserCertificate = () => null; }]) {
      const before = await call({ suffix: "/prepare", method: "POST", meanwhile: change }); expect(before.status).toBe(503); expect(before.control.prepare).not.toHaveBeenCalled();
      const after = await call({ suffix: "/prepare", method: "POST", duringPrepare: change }); expect(after.status).toBe(503);
      expect(await call({ suffix: "/prepare", method: "POST", duringPrepare: change, uncheckedPrepare: true })).toMatchObject({ status: 503 });
    }
  });
});
