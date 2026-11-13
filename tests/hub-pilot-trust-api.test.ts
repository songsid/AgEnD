import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSettingsRequest } from "../src/settings-api.js";
import { createSettingsReplay } from "../src/settings-request-capability.js";
import { SettingsExecution } from "../src/settings-transaction.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { isSettingsMutation, prepareSettingsEffect } from "../src/settings-effect.js";
const path = "/api/settings/hub/pilot-trust", caps: SettingsExecution[] = [];
afterEach(() => { for (const cap of caps.splice(0)) cap.close(); });
async function call(o: { method?: string; replay?: boolean; admin?: boolean; gateway?: boolean; body?: unknown; beforeBody?: () => void } = {}) {
  const method = o.method ?? "PUT", bytes = Buffer.from(JSON.stringify(o.body ?? { enabled: false }));
  const cap = new SettingsExecution({ current: () => true, snapshot: () => null }); caps.push(cap);
  const req: any = o.replay ? createSettingsReplay({ method, url: path, body: bytes, binding: "owner", localAdmin: () => o.admin !== false }, cap)
    : Object.assign(new EventEmitter(), { method, url: path, headers: o.admin === false ? {} : { "x-agend-token": "test-token" } });
  if (o.gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "scratch", expectedOrigin: "https://scratch.invalid", isCurrent: () => true });
  let raw: any = { hub_member: { enabled: true, pilot_trust: true, retained: "keep" } };
  const save = vi.fn((patches: any[]) => { for (const patch of patches) raw.hub_member[patch.path[1]] = patch.value; });
  const ctx: any = { webToken: "test-token", webSessions: null, fleetConfig: { defaults: {}, instances: {} }, configPath: "/scratch/fleet.yaml",
    getRawFleetConfig: () => raw, saveFleetConfig: save };
  const result = await new Promise<{ status: number; body: any }>(resolve => {
    let status = 0;
    const res: any = { writeHead(code: number) { status = code; }, end(text: string) { resolve({ status, body: JSON.parse(text) }); } };
    expect(handleSettingsRequest(req, res, new URL(path, "http://localhost"), ctx)).toBe(true);
    o.beforeBody?.();
    if (!o.replay) { req.emit("data", bytes); req.emit("end"); }
  });
  return { ...result, save, raw };
}
describe("the Fleet pilot-trust setting", () => {
  it("reads the saved setting; public links and non-admin callers cannot read it", async () => {
    expect(await call({ method: "GET" })).toMatchObject({ status: 200, body: { ok: true, enabled: true } });
    expect(await call({ method: "GET", gateway: true })).toMatchObject({ status: 403 });
    expect(await call({ method: "GET", admin: false })).toMatchObject({ status: 403 });
  });
  it("only a confirmed local admin writes the one raw leaf, preserving membership and other fields", async () => {
    for (const o of [{}, { replay: true, admin: false }, { replay: true, gateway: true }]) {
      const r = await call(o); expect(r.status).toBe(403); expect(r.save).not.toHaveBeenCalled();
    }
    const r = await call({ replay: true });
    expect(r).toMatchObject({ status: 200, body: { enabled: false }, raw: { hub_member: { enabled: true, pilot_trust: false, retained: "keep" } } });
    expect(r.save).toHaveBeenCalledExactlyOnceWith([{ path: ["hub_member", "pilot_trust"], value: false }]);
  });
  it("rejects extra fields and includes trust consent in the existing start fingerprint", async () => {
    expect(await call({ replay: true, body: { enabled: true, fingerprint: "a".repeat(64) } })).toMatchObject({ status: 400 });
    expect(isSettingsMutation("PUT", path)).toBe(true);
    const ctx: any = { config: { defaults: {}, instances: {} }, classic: {}, hubPilotTrust: () => ({ enabled: true }) };
    expect(prepareSettingsEffect("PUT", path, { enabled: false }, ctx).diff?.summary.join(" ")).toContain("certificate");
    const body = { address: "https://pilot.example.test", label: "Fleet", trust: { fingerprint: "a".repeat(64), previous: null } };
    const first = prepareSettingsEffect("POST", "/api/hub/member/company-join/start", body, ctx).diff;
    const second = prepareSettingsEffect("POST", "/api/hub/member/company-join/start", { ...body, trust: { ...body.trust, fingerprint: "b".repeat(64) } }, ctx).diff;
    expect(first?.fingerprint).not.toBe(second?.fingerprint);
    expect(() => prepareSettingsEffect("POST", "/api/hub/member/company-join/start", { ...body, trust: { fingerprint: "bad", previous: null } }, ctx)).toThrow();
  });
});
