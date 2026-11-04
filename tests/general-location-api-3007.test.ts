import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { handleSettingsRequest } from "../src/settings-api.js";
import { createSettingsReplay } from "../src/settings-request-capability.js";
import { SettingsExecution } from "../src/settings-transaction.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
const caps: SettingsExecution[] = []; afterEach(() => caps.splice(0).forEach(cap => cap.close()));
const input = { name: "general", revision: "a".repeat(64), target: { location: "windows", machineId: randomUUID(), cli: "codex", model: "" } };
async function call(replay: boolean, admin = true, before?: (cap: SettingsExecution) => void, gateway = false) {
  let granted = admin;
  const cap = new SettingsExecution({ current: () => true, snapshot: () => null }); caps.push(cap);
  const body = Buffer.from(JSON.stringify(input));
  const req = replay ? createSettingsReplay({ method: "POST", url: "/api/settings/general-location", body, binding: "owned", localAdmin: () => granted }, cap)
    : Object.assign(new EventEmitter(), { method: "POST", url: "/api/settings/general-location", headers: { "x-replay": "true", "cookie": "forged" } }) as unknown as IncomingMessage;
  if (gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "scratch", expectedOrigin: "https://scratch.invalid", isCurrent: () => true });
  const switchLocation = vi.fn(async (_raw, authorized: () => boolean, execution: SettingsExecution) => { expect(authorized()).toBe(true); execution.complete(); expect(authorized()).toBe(true); return { started: true }; });
  const context = { fleetConfig: { instances: {} }, generalLocations: () => ({}), switchGeneralLocation: switchLocation, logger: { warn: vi.fn() } };
  before?.(cap);
  const result = await new Promise<{ status: number; body: any }>(resolve => { let status = 0;
    const res = { writeHead(value: number) { status = value; }, end(value: string) { resolve({ status, body: JSON.parse(value) }); } };
    expect(handleSettingsRequest(req, res as never, new URL(req.url!, "http://localhost"), context as never)).toBe(true);
    if (!replay) { req.emit("data", body); req.emit("end"); }
  });
  return { ...result, switchLocation };
}
it("only a server-created, currently local-admin Settings replay can switch, including settlement after commit", async () => {
  const yes = await call(true); expect(yes.status).toBe(200); expect(yes.switchLocation).toHaveBeenCalledOnce();
  for (const result of [await call(false), await call(true, false), await call(true, true, cap => cap.cancel()), await call(true, true, undefined, true)]) {
    expect(result.status).toBe(403); expect(result.switchLocation).not.toHaveBeenCalled();
  }
});
it("a location proposal always requires General admin confirmation and closed revision-bound input", () => {
  const preview = vi.fn(() => ({ summary: ["approved summary"], connections: ["world"] }));
  const effect = prepareSettingsEffect("POST", "/api/settings/general-location", input, { config: { instances: {} } as never, classic: {}, generalLocation: preview });
  expect(preview).toHaveBeenCalledWith(input); expect(effect.diff).toMatchObject({ summary: ["approved summary"], affectedConnections: [], authority: { connections: ["world"], primaryGeneral: true, unknown: false } });
  expect(() => prepareSettingsEffect("POST", "/api/settings/general-location", { ...input, path: "C:\\arbitrary" }, { config: { instances: {} } as never, classic: {}, generalLocation: preview })).toThrow();
});
