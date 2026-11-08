/**
 * M-2682 part B: the host route behind "HTML previews on this Hub" — GET for the host admin, PUT only as a server-owned
 * confirmed replay (like retention), never over the public link, conflicts refused before anything is written, the local
 * admin re-checked at the save, and an unfinished sealed-settings commit making it wait.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import type { IncomingMessage } from "node:http";
import { handleSettingsRequest } from "../src/settings-api.js";
import { createSettingsReplay } from "../src/settings-request-capability.js";
import { SettingsExecution } from "../src/settings-transaction.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

const path = "/api/settings/hub/preview";
const caps: SettingsExecution[] = [];
afterEach(() => { for (const cap of caps.splice(0)) cap.close(); });
const freePort = async () => { const s = createServer(); await new Promise<void>((r) => s.listen({ host: "127.0.0.1", port: 0 }, r)); const p = (s.address() as { port: number }).port; await new Promise<void>((r) => s.close(() => r())); return p; };
const hubRaw = () => ({ health_port: 19280, hub: { enabled: true, webOrigin: "https://hub.example.test:8444", memberOrigin: "https://hub.example.test:8443",
  webListen: { host: "127.0.0.1", port: 8444 }, memberListen: { host: "127.0.0.1", port: 8443 } } });

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
    saveFleetConfig: (patches: Array<{ path: string[]; value?: unknown; remove?: boolean }>) => {
      saves.push(patches);
      for (const p of patches) { const web = { ...(raw.hub.web ?? {}) }; if (p.remove) delete web.preview_port; else web.preview_port = p.value; raw = { ...raw, hub: { ...raw.hub, web } }; }
    } };
  const response = await new Promise<{ status: number; body: any }>((resolve) => {
    let status = 0;
    const res = { writeHead(v: number) { status = v; }, setHeader() {}, end(v: string) { resolve({ status, body: JSON.parse(v) }); } };
    expect(handleSettingsRequest(req, res as never, new URL(path, "http://localhost"), ctx as never)).toBe(true);
    if (!o.replay) { req.emit("data", body); req.emit("end"); }
  });
  return { ...response, saves };
}

describe("host route: HTML previews on this Hub (M-2682)", () => {
  it("reads for the host admin only; a Hub cookie or the public link gives nothing", async () => {
    expect(await call({ method: "GET" })).toMatchObject({ status: 200, body: { ok: true, hosted: true, enabled: false, port: null, suggested: 8445 } });
    expect((await call({ method: "GET", admin: false })).status).toBe(403);
    expect((await call({ method: "GET", gateway: true })).status).toBe(403);
  });
  it("saves only as a confirmed replay; then writes exactly hub.web.preview_port", async () => {
    const port = await freePort();
    for (const options of [{}, { replay: true, admin: false }, { replay: true, gateway: true }]) {
      const r = await call({ ...options, json: { enabled: true, port } }); expect(r.status).toBe(403); expect(r.saves).toEqual([]);
    }
    const on = await call({ replay: true, json: { enabled: true, port } });
    expect(on).toMatchObject({ status: 200, body: { ok: true, enabled: true, port } });
    expect(on.saves).toEqual([[{ path: ["hub", "web", "preview_port"], value: port }]]);
    const off = await call({ replay: true, json: { enabled: false }, raw: { ...hubRaw(), hub: { ...hubRaw().hub, web: { preview_port: port } } } });
    expect(off).toMatchObject({ status: 200, body: { ok: true, enabled: false, port: null } });
    expect(off.saves).toEqual([[{ path: ["hub", "web", "preview_port"], remove: true }]]);
  });
  it("conflicts and an unfinished commit are refused before anything is written; the admin is re-checked at the save", async () => {
    for (const [json, extra, code, status] of [[{ enabled: true, port: 8444 }, {}, "port_conflict", 409], [{ enabled: true, port: 0 }, {}, "invalid_port", 400],
      [{ enabled: true, port: 19280 }, {}, "port_conflict", 409], [{ enabled: false }, { busy: true }, "busy", 409],
      [{ enabled: false }, { raw: { hub: { enabled: false } } }, "not_hosted", 404]] as const) {
      const r = await call({ replay: true, json, ...extra });
      expect([r.status, r.body.error, r.saves]).toEqual([status, code, []]);
    }
    const localAdmin = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const r = await call({ replay: true, json: { enabled: false }, localAdmin });
    expect([r.status, r.body.error, r.saves]).toEqual([503, "unsaved", []]);
  });
});
