/** Read-only local projection for the single connection card, including persisted bindings while paused. */
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleSettingsRequest } from "../src/settings-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { FleetManager } from "../src/fleet-manager.js";
import { hubRig } from "./helpers/hub-rig.js";
const deferred = () => { let release!: (v: unknown) => void; const promise = new Promise<unknown>(r => { release = r; }); return { promise, release }; };
function request(options: { query?: string; owner?: boolean; admin?: boolean; gateway?: boolean; read?: () => Promise<unknown> } = {}) {
  let live = true, raw: unknown = { hub_member: { enabled: false } };
  const req = Object.assign(new EventEmitter(), { method: "GET", url: "/api/settings/hub/membership" + (options.query ?? "?v=2"), headers: { "x-agend-token": options.admin === false ? "wrong" : "fixture-token" } });
  if (options.gateway) bindGatewayRequest(req as never, { surface: "gateway", exposureId: "fixture", expectedOrigin: "https://fixture.invalid", isCurrent: () => true });
  const read = vi.fn(options.read ?? (async () => ({ state: "unpaired" })));
  const ctx: any = { webToken: "fixture-token", webSessions: null, configPath: "/owned/fixture/fleet.yaml", fleetConfig: { defaults: {}, instances: {} }, getRawFleetConfig: () => structuredClone(raw),
    hubCompanySession: () => options.owner === false ? null : { current: () => live }, hubMemberPairingView: read };
  const answer = new Promise<{ status: number; body: any }>(resolve => {
    let status = 0;
    const res: any = { writeHead(n: number) { status = n; }, setHeader() {}, end(text: string) { resolve({ status, body: JSON.parse(text) }); } };
    expect(handleSettingsRequest(req as never, res, new URL(req.url, "http://127.0.0.1"), ctx)).toBe(true);
  });
  return { answer, read, expire: () => { live = false; }, replace: () => { raw = { hub_member: { enabled: false } }; ctx.fleetConfig = { defaults: {}, instances: {} }; }, move: () => { ctx.configPath += ".new"; }, enable: () => { raw = { hub_member: { enabled: true } }; } };
}
describe("connection card's passive Settings projection", () => {
  it("offers v1 only for the explicit new read; the legacy boolean read stays lazy", async () => {
    const legacy = request({ query: "" });
    expect(await legacy.answer).toEqual({ status: 200, body: { ok: true, enabled: false } }); expect(legacy.read).not.toHaveBeenCalled();
    const next = request();
    expect(await next.answer).toEqual({ status: 200, body: { ok: true, enabled: false, connectionCardV1: true, pairing: { state: "unpaired" } } }); expect(next.read).toHaveBeenCalledOnce();
  });
  it.each([{ owner: false }, { admin: false }, { gateway: true }])("refuses before private-file access %j", async options => {
    const r = request(options); expect((await r.answer).status).toBe(403); expect(r.read).not.toHaveBeenCalled();
  });
  it.each(["?v=1", "?v=2&v=2", "?v=2&extra=1"])("refuses an ambiguous version %s", async query => {
    const r = request({ query }); expect((await r.answer).status).toBe(400); expect(r.read).not.toHaveBeenCalled();
  });
  it.each(["session", "config", "path", "membership"])("fences a held read after its %s changes", async fault => {
    const d = deferred(), r = request({ read: () => d.promise });
    if (fault === "session") r.expire(); else if (fault === "path") r.move(); else if (fault === "membership") r.enable(); else r.replace();
    d.release({ state: "paired", hub: { webOrigin: "https://hub.invalid" } });
    expect(await r.answer).toEqual({ status: 409, body: { ok: false, error: "unavailable" } });
  });
  it("keeps private errors bounded", async () => {
    const r = request({ read: async () => { throw Error("private-path-and-key"); } });
    expect(await r.answer).toEqual({ status: 503, body: { ok: false, error: "unavailable" } });
  });
  it("reads an actual paused profile without activating, writing or exposing credentials", async () => {
    const rig = await hubRig();
    try {
      const profile = await rig.pair(), path = join(rig.memberHome, "hub-member/state.json");
      writeFileSync(path, JSON.stringify({ hubId: profile.hub.hubId }), { mode: 0o600 });
      const saved = readFileSync(path), profilePath = join(rig.memberHome, "hub-member", profile.hub.hubId, "pairing.json"), bytes = readFileSync(profilePath);
      const host: any = { dataDir: rig.memberHome, rawFleetConfig: { hub_member: { enabled: false } }, shuttingDown: false,
        hubMemberPairingApi: null, applyHubSwitches: vi.fn(), attachHubMemberPairing: vi.fn() };
      const view = await FleetManager.prototype.hubMemberPairingView.call(host);
      expect(view).toMatchObject({ state: "paired", hub: { hubId: profile.hub.hubId, webOrigin: profile.hub.webOrigin }, link: "offline" });
      expect(JSON.stringify(view)).not.toContain(profile.credential); expect(JSON.stringify(view)).not.toContain("issuerPublicKey");
      expect(readFileSync(path)).toEqual(saved); expect(readFileSync(profilePath)).toEqual(bytes);
      expect(host.applyHubSwitches).not.toHaveBeenCalled(); expect(host.attachHubMemberPairing).not.toHaveBeenCalled(); expect(host.hubMemberPairingApi).toBeNull();
      writeFileSync(path, "{broken", { mode: 0o600 });
      expect(await FleetManager.prototype.hubMemberPairingView.call(host)).toEqual({ state: "held", hold: "unsaved" });
    } finally { await rig.close(); }
  });
  it.each(["stop", "config"])("a late %s cannot publish a passive projection", async fault => {
    const host: any = { dataDir: "/never-read", rawFleetConfig: {}, shuttingDown: false, hubMemberPairingApi: null };
    const reading = FleetManager.prototype.hubMemberPairingView.call(host);
    if (fault === "stop") host.shuttingDown = true; else host.rawFleetConfig = {};
    await expect(reading).rejects.toThrow();
  });
});
