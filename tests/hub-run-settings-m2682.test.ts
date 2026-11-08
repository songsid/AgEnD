/**
 * M-2682 (leader, cid-hubname-ui): fleet Settings → Hub → "Run this Hub" — hub.enabled, host owner only. The view and patch
 * (src/hub-host-settings.ts) and the route: GET for the host admin, PUT only as a server-owned confirmed replay, never over
 * the public link, an uninitialized Hub or an unfinished sealed-settings commit refused with nothing written, the local admin
 * re-checked at the save.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { hubRunPatch, hubRunView } from "../src/hub-host-settings.js";
import { handleSettingsRequest } from "../src/settings-api.js";
import { createSettingsReplay } from "../src/settings-request-capability.js";
import { SettingsExecution } from "../src/settings-transaction.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

const path = "/api/settings/hub/run";
const caps: SettingsExecution[] = [];
afterEach(() => { for (const cap of caps.splice(0)) cap.close(); });
const hubRaw = (enabled = true) => ({ hub: { enabled, hubId: "4c3b2a19-0e8f-4d7c-9b6a-5f4e3d2c1b0a" } });

async function call(o: { method?: string; replay?: boolean; admin?: boolean; gateway?: boolean; json?: unknown; raw?: any; busy?: boolean; localAdmin?: () => boolean } = {}) {
  const body = Buffer.from(JSON.stringify(o.json ?? { enabled: false })), method = o.method ?? "PUT";
  const cap = new SettingsExecution({ current: () => true, snapshot: () => null }); caps.push(cap);
  const req = o.replay ? createSettingsReplay({ method, url: path, body, binding: "owner", localAdmin: o.localAdmin ?? (() => o.admin !== false) }, cap)
    : Object.assign(new EventEmitter(), { method, url: path, headers: o.admin === false ? { cookie: "__Host-agend_hub_fake=x" } : { "x-agend-token": "tok" } }) as unknown as IncomingMessage;
  if (o.gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "scratch", expectedOrigin: "https://scratch.invalid", isCurrent: () => true });
  let raw = o.raw ?? hubRaw();
  const saves: unknown[] = [];
  const ctx = { webToken: "tok", webSessions: null, fleetConfig: { defaults: {}, instances: {} }, logger: { warn: vi.fn() },
    getRawFleetConfig: () => raw, hubSettingsBusy: () => o.busy === true,
    saveFleetConfig: (patches: Array<{ path: string[]; value?: unknown }>) => { saves.push(patches); for (const p of patches) raw = { ...raw, hub: { ...raw.hub, enabled: p.value } }; } };
  const response = await new Promise<{ status: number; body: any }>((resolve) => {
    let status = 0;
    const res = { writeHead(v: number) { status = v; }, setHeader() {}, end(v: string) { resolve({ status, body: JSON.parse(v) }); } };
    expect(handleSettingsRequest(req, res as never, new URL(path, "http://localhost"), ctx as never)).toBe(true);
    if (!o.replay) { req.emit("data", body); req.emit("end"); }
  });
  return { ...response, saves };
}

describe("Run this Hub (M-2682)", () => {
  it("the view and the patch", () => {
    expect(hubRunView(hubRaw())).toEqual({ initialized: true, enabled: true });
    expect(hubRunView(hubRaw(false))).toEqual({ initialized: true, enabled: false });
    expect(hubRunView({ hub: { enabled: false } })).toEqual({ initialized: false, enabled: false });
    expect(hubRunView({})).toEqual({ initialized: false, enabled: false });
    expect(hubRunPatch(hubRaw(false), { enabled: true })).toEqual({ patch: { path: ["hub", "enabled"], value: true } });
    expect(hubRunPatch(hubRaw(), { enabled: false })).toEqual({ patch: { path: ["hub", "enabled"], value: false } });
    expect(hubRunPatch(hubRaw(), { enabled: "false" })).toEqual({ refused: "invalid" });
    expect(hubRunPatch({ hub: { enabled: false } }, { enabled: true })).toEqual({ refused: "not_initialized" });
    expect(hubRunPatch(hubRaw(), { enabled: false }, { busy: () => true })).toEqual({ refused: "busy" });
  });
  it("reads for the host admin only; a Hub cookie or the public link gives nothing", async () => {
    expect(await call({ method: "GET" })).toMatchObject({ status: 200, body: { ok: true, initialized: true, enabled: true } });
    expect((await call({ method: "GET", admin: false })).status).toBe(403);
    expect((await call({ method: "GET", gateway: true })).status).toBe(403);
  });
  it("saves only as a confirmed replay, exactly hub.enabled", async () => {
    for (const options of [{}, { replay: true, admin: false }, { replay: true, gateway: true }]) {
      const r = await call(options); expect(r.status).toBe(403); expect(r.saves).toEqual([]);
    }
    const off = await call({ replay: true, json: { enabled: false } });
    expect(off).toMatchObject({ status: 200, body: { ok: true, enabled: false } });
    expect(off.saves).toEqual([[{ path: ["hub", "enabled"], value: false }]]);
    const on = await call({ replay: true, json: { enabled: true }, raw: hubRaw(false) });
    expect(on).toMatchObject({ status: 200, body: { ok: true, enabled: true } });
  });
  it("refusals write nothing; the admin is re-checked at the save", async () => {
    for (const [extra, code, status] of [[{ busy: true }, "busy", 409], [{ raw: { hub: { enabled: false } } }, "not_initialized", 404], [{ json: { enabled: 1 } }, "invalid", 400]] as const) {
      const r = await call({ replay: true, ...extra });
      expect([r.status, r.body.error, r.saves]).toEqual([status, code, []]);
    }
    const localAdmin = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const r = await call({ replay: true, localAdmin });
    expect([r.status, r.body.error, r.saves]).toEqual([503, "unsaved", []]);
  });
});
