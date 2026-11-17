import { expect,it } from "vitest";
import { isSettingsMutation,prepareSettingsEffect } from "../src/settings-effect.js";
const path="/api/settings/hub/share-from-hub";
const effect=(before:boolean,enabled:boolean)=>prepareSettingsEffect("PUT",path,{enabled},{config:{defaults:{},instances:{}} as never,classic:{},hubPageSharing:()=>({enabled:before})} as any);
it("registers the switch with the existing Settings execution gate",()=>{expect(isSettingsMutation("PUT",path)).toBe(true);});
it("keeps off and unchanged immediate, and applies existing access confirmation only when enabled after off",()=>{
 expect(effect(true,false).diff).toBeNull();expect(effect(true,true).diff).toBeNull();
 expect(effect(false,true).diff).toMatchObject({section:"access",authority:{connections:[],primaryGeneral:true,unknown:false}});
});

import { EventEmitter } from "node:events";
import { afterEach, vi } from "vitest";
import { hubPageSharingSettings, parseHubPageSharing } from "../src/hub-page-sharing-settings.js";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import { SettingsExecution } from "../src/settings-transaction.js";
import { createSettingsReplay } from "../src/settings-request-capability.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
const executions: SettingsExecution[] = [];
afterEach(() => { for (const execution of executions.splice(0)) execution.close(); });
it("defaults on from absent own fields, keeps false, and refuses malformed or extra values", () => {
  expect(hubPageSharingSettings({})).toEqual({ enabled: true });
  expect(hubPageSharingSettings({ hub_member: {} })).toEqual({ enabled: true });
  expect(hubPageSharingSettings({ hub_member: Object.create({ share_from_hub: false }) })).toEqual({ enabled: true });
  expect(hubPageSharingSettings({ hub_member: { share_from_hub: false } })).toEqual({ enabled: false });
  for (const value of [null, "false", 0, {}]) expect(() => hubPageSharingSettings({ hub_member: { share_from_hub: value } })).toThrow();
  for (const value of [{}, { enabled: 1 }, { enabled: true, other: true }, Object.create({ enabled: true })]) expect(() => parseHubPageSharing(value)).toThrow();
});
async function requestSettings(options: { method?: string; replay?: boolean; admin?: boolean; gateway?: boolean; body?: unknown;
  raw?: Record<string, unknown>; meanwhile?(ctx: SettingsApiContext, execution: SettingsExecution): void } = {}) {
  const method = options.method ?? "PUT", body = Buffer.from(JSON.stringify(options.body ?? { enabled: false }));
  const execution = new SettingsExecution({ current: () => true, snapshot: () => null }); executions.push(execution);
  const emitter = new EventEmitter();
  const req = options.replay ? createSettingsReplay({ method, url: path, body, binding: "owner", localAdmin: () => options.admin !== false }, execution)
    : Object.assign(emitter, { method, url: path, headers: options.admin === false ? { cookie: "guest=fixture" } : { "x-agend-token": "fixture" } });
  if (options.gateway) bindGatewayRequest(req as never, { surface: "gateway", exposureId: "fixture", expectedOrigin: "https://preview.example.test", isCurrent: () => true });
  let raw = options.raw ?? { hub_member: { enabled: true, remembered: "keep" } };
  const save = vi.fn((patches: { path: string[]; value?: unknown }[]) => {
    raw = { ...raw, hub_member: { ...(raw.hub_member as Record<string, unknown>), [patches[0].path.at(-1)!]: patches[0].value } };
  });
  const ctx = { fleetConfig: { defaults: {}, instances: {} }, configPath: "/scratch/fleet.yaml", getRawFleetConfig: () => raw,
    webToken: "fixture", webSessions: null, logger: { warn() {} }, saveFleetConfig: save } as unknown as SettingsApiContext;
  const response = await new Promise<{ status: number; body: unknown }>(resolve => {
    let status = 0;
    const res = { writeHead(code: number) { status = code; }, setHeader() {}, end(text: string) { resolve({ status, body: JSON.parse(text) }); } };
    expect(handleSettingsRequest(req as never, res as never, new URL(path, "http://localhost"), ctx)).toBe(true);
    options.meanwhile?.(ctx, execution);
    if (!options.replay) { emitter.emit("data", body); emitter.emit("end"); }
  });
  return { ...response, raw, save };
}
it("uses the existing admin replay writer, including over a link, and preserves membership and other raw keys", async () => {
  expect(await requestSettings({ method: "GET", raw: {} })).toMatchObject({ status: 200, body: { ok: true, enabled: true } });
  expect(await requestSettings({ method: "GET", admin: false })).toMatchObject({ status: 403 });
  for (const options of [{}, { replay: true, admin: false }]) {
    const result = await requestSettings(options); expect(result.status).toBe(403); expect(result.save).not.toHaveBeenCalled();
  }
  const saved = await requestSettings({ replay: true, gateway: true });
  expect(saved).toMatchObject({ status: 200, body: { enabled: false }, raw: { hub_member: { enabled: true, share_from_hub: false, remembered: "keep" } } });
  expect(saved.save).toHaveBeenCalledWith([{ path: ["hub_member", "share_from_hub"], value: false }]);
});
it("refuses stale body continuations and malformed input without changing raw configuration", async () => {
  for (const meanwhile of [(_ctx: SettingsApiContext, execution: SettingsExecution) => execution.cancel(), (ctx: SettingsApiContext) => { ctx.configPath = "/other"; },
    (ctx: SettingsApiContext) => { ctx.getRawFleetConfig = () => ({ hub_member: { share_from_hub: "invalid" } }); }]) {
    const result = await requestSettings({ replay: true, meanwhile }); expect(result.status).toBe(503); expect(result.save).not.toHaveBeenCalled();
  }
  for (const body of [{ enabled: "false" }, { enabled: false, owner: "someone" }]) {
    const result = await requestSettings({ replay: true, body }); expect(result.status).toBe(400); expect(result.save).not.toHaveBeenCalled();
  }
});
