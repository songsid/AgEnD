import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSettingsRequest } from "../src/settings-api.js";
import { createSettingsReplay } from "../src/settings-request-capability.js";
import { SettingsExecution } from "../src/settings-transaction.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
const runtime = vi.hoisted(() => ({ imports: 0, applies: [] as any[] }));
vi.mock("../src/hub/runtime.js", () => { runtime.imports++; return { HubRuntime: class {
  apply(v: unknown) { runtime.applies.push(v); return Promise.resolve(); } refresh() { return Promise.resolve(); }
  fence() {} close() { return Promise.resolve(); } currentHolds() { return []; }
} }; });
const { FleetManager } = await import("../src/fleet-manager.js");
const path = "/api/settings/hub/membership", caps: SettingsExecution[] = [], fleets: any[] = [];
afterEach(async () => {
  for (const cap of caps.splice(0)) cap.close();
  for (const { fm, root } of fleets.splice(0)) {
    fm.shuttingDown = true; fm.hubEffectsReady = false; fm.settingsConfirmation?.store.close();
    await fm.hubRuntime?.close(); rmSync(root, { recursive: true, force: true });
  }
  runtime.applies.length = 0;
});
async function call(o: { method?: string; replay?: boolean; admin?: boolean; gateway?: boolean; body?: unknown; raw?: unknown;
  localAdmin?: () => boolean; meanwhile?: (ctx: any, cap: SettingsExecution) => void; saveFails?: boolean } = {}) {
  const bytes = Buffer.from(JSON.stringify(o.body ?? { enabled: true })), method = o.method ?? "PUT";
  const cap = new SettingsExecution({ current: () => true, snapshot: () => null }); caps.push(cap);
  const req: any = o.replay ? createSettingsReplay({ method, url: path, body: bytes, binding: "owner", localAdmin: o.localAdmin ?? (() => o.admin !== false) }, cap)
    : Object.assign(new EventEmitter(), { method, url: path, headers: o.admin === false ? { cookie: "__Host-agend_hub_fake=not-a-host-session" } : { "x-agend-token": "tok" } });
  if (o.gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "scratch", expectedOrigin: "https://scratch.invalid", isCurrent: () => true });
  let raw: any = o.raw ?? {};
  const save = vi.fn((patches: any[]) => { if (o.saveFails) throw Error("dummy-private-path"); raw = { ...raw, hub_member: { ...raw.hub_member, enabled: patches[0].value } }; });
  const ctx: any = { webToken: "tok", webSessions: null, fleetConfig: { defaults: {}, instances: {} }, configPath: "/unused-scratch/fleet.yaml",
    logger: { warn: vi.fn() }, getRawFleetConfig: () => raw, saveFleetConfig: save };
  const response = await new Promise<{ status: number; body: any }>(resolve => {
    let status = 0;
    const res = { writeHead(v: number) { status = v; }, setHeader() {}, end(v: string) { resolve({ status, body: JSON.parse(v) }); } };
    expect(handleSettingsRequest(req, res as never, new URL(path, "http://localhost"), ctx)).toBe(true);
    o.meanwhile?.(ctx, cap);
    if (!o.replay) { req.emit("data", bytes); req.emit("end"); }
  });
  return { ...response, save, raw };
}
function fleet() {
  const root = mkdtempSync(join(tmpdir(), "agend-membership-")), file = join(root, "fleet.yaml");
  writeFileSync(file, "# retained owner comment\ninstances: {}\nhub_member:\n  enabled: false\n  remembered: keep\n");
  const fm: any = new FleetManager(root); fm.loadConfig(file);
  fm.promptSettingsChange = vi.fn(async () => {});
  const gate = fm.settingsGate();
  let live = true, admin = true;
  gate.options.principal = () => ({ id: "local-owner", label: "owner", source: "web_session", current: () => live, localAdmin: () => admin });
  gate.options.selfConfirm = () => null;
  fleets.push({ fm, root });
  async function request(enabled: boolean, gateway = false) {
    return new Promise<{ status: number; body: any }>(resolve => {
      const req: any = Object.assign(new EventEmitter(), { method: "PUT", url: path, headers: {} });
      if (gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "scratch", expectedOrigin: "https://scratch.invalid", isCurrent: () => true });
      const res: any = new EventEmitter(); let status = 0;
      Object.assign(res, { writeHead(code: number) { status = code; }, setHeader() {}, end(text: string) { resolve({ status, body: JSON.parse(text) }); res.emit("finish"); } });
      const next = (r: any, s: any, u: URL) => handleSettingsRequest(r, s, u, fm);
      expect(gate.handle(req, res, new URL(path, "http://localhost"), next) || next(req, res, new URL(path, "http://localhost"))).toBe(true);
      req.emit("data", Buffer.from(JSON.stringify({ enabled }))); req.emit("end");
    });
  }
  return { fm, gate, file, request, revoke: () => { live = false; }, unadmin: () => { admin = false; } };
}
describe("owner membership API and real FleetManager Settings composition", () => {
  it("reads off while no member exists, and refuses a Hub cookie, public link or invalid state", async () => {
    expect(await call({ method: "GET" })).toMatchObject({ status: 200, body: { ok: true, enabled: false } });
    expect(await call({ method: "GET", raw: { hub_member: { enabled: true } } })).toMatchObject({ status: 200, body: { enabled: true } });
    expect(await call({ method: "GET", admin: false })).toMatchObject({ status: 403 });
    expect(await call({ method: "GET", gateway: true })).toMatchObject({ status: 403 });
    expect(await call({ method: "GET", raw: { hub_member: { enabled: "true" } } })).toMatchObject({ status: 409, body: { error: "invalid_hub_membership" } });
  });
  it("only a server-owned local-admin continuation writes; body and save errors are bounded", async () => {
    for (const o of [{}, { replay: true, admin: false }, { replay: true, gateway: true }]) {
      const r = await call(o); expect(r.status).toBe(403); expect(r.save).not.toHaveBeenCalled();
    }
    const good = await call({ replay: true, raw: { hub_member: { remembered: "keep" } } });
    expect(good).toMatchObject({ status: 200, body: { ok: true, enabled: true }, raw: { hub_member: { enabled: true, remembered: "keep" } } });
    expect(good.save).toHaveBeenCalledWith([{ path: ["hub_member", "enabled"], value: true }]);
    for (const body of [{ enabled: "yes" }, { enabled: true, hubId: "other" }, { enabled: true, data: "x".repeat(1100) }]) {
      const r = await call({ replay: true, body }); expect(r.status).toBe(400); expect(r.save).not.toHaveBeenCalled();
    }
    expect(await call({ replay: true, saveFails: true })).toMatchObject({ status: 503, body: { ok: false, error: "unavailable" } });
  });
  it("rechecks session, config owner and local-admin authority after body read and at commit", async () => {
    for (const meanwhile of [(_ctx: any, cap: SettingsExecution) => cap.cancel(), (ctx: any) => { ctx.fleetConfig = {}; }, (ctx: any) => { ctx.configPath = "/other"; }, (ctx: any) => { ctx.getRawFleetConfig = () => ({ hub_member: "invalid" }); }]) {
      const r = await call({ replay: true, meanwhile }); expect(r.status).toBe(503); expect(r.save).not.toHaveBeenCalled();
    }
    for (const localAdmin of [vi.fn().mockReturnValueOnce(true).mockReturnValue(false), vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false)]) {
      const r = await call({ replay: true, localAdmin }); expect(r.status).toBe(503); expect(r.save).not.toHaveBeenCalled();
    }
  });
  it("off page uses the actual raw baseline; enable waits for confirmation, off narrows immediately, preserving owner YAML", async () => {
    const before = runtime.imports, h = fleet();
    expect((h.fm.fleetConfig as any).hub_member).toBeUndefined(); // the resolved config deliberately omits raw Hub switches
    const baseline = await h.fm.settingsBaselineReader.read();
    expect(baseline.hubMembership).toBeTypeOf("function");
    expect(baseline.hubMembership()).toEqual({ enabled: false });
    expect(runtime.imports).toBe(before);
    const pending = await h.request(true);
    expect(pending.status).toBe(202); expect(h.fm.getRawFleetConfig().hub_member.enabled).toBe(false);
    expect((await h.gate.store.decide(pending.body.pending_change.id, "confirm", { label: "host", current: () => true })).state).toBe("applied");
    expect(h.fm.getRawFleetConfig().hub_member).toEqual({ enabled: true, remembered: "keep" });
    expect((await h.fm.settingsBaselineReader.read()).hubMembership()).toEqual({ enabled: true });
    h.fm.hubEffectsReady = true; await h.fm.applyHubSwitches();
    expect(runtime.applies.at(-1).hub_member.enabled).toBe(true);
    const off = await h.request(false); expect(off).toMatchObject({ status: 200, body: { ok: true, enabled: false } });
    await h.fm.applyHubSwitches(); expect(runtime.applies.at(-1).hub_member.enabled).toBe(false);
    expect(readFileSync(h.file, "utf8")).toContain("# retained owner comment");
    expect((yaml.load(readFileSync(h.file, "utf8")) as any).hub_member).toEqual({ enabled: false, remembered: "keep" });
    expect((await h.gate.store.list("local-owner")).filter((v: any) => v.state === "pending")).toHaveLength(0);
  });
  it("pending enable never survives a changed baseline or revoked local owner; public requests make no proposal", async () => {
    for (const mode of ["baseline", "session", "admin"] as const) {
      const h = fleet(), r = await h.request(true);
      if (mode === "baseline") h.fm.saveFleetConfig([{ path: ["hub_member", "remembered"], value: "newer" }]);
      if (mode === "session") h.revoke();
      if (mode === "admin") h.unadmin();
      const settled = await h.gate.store.decide(r.body.pending_change.id, "confirm", { label: "host", current: () => true });
      expect(["stale", "failed"]).toContain(settled.state); expect(h.fm.getRawFleetConfig().hub_member.enabled).toBe(false);
    }
    const h = fleet(); expect((await h.request(true, true)).status).toBe(403); expect(h.gate.store.list("local-owner")).toEqual([]);
  });
  it("a cached on value cannot bypass confirmation after the owner manually turned the file off", async () => {
    const h = fleet(); h.fm.saveFleetConfig([{ path: ["hub_member", "enabled"], value: true }]);
    writeFileSync(h.file, readFileSync(h.file, "utf8").replace("enabled: true", "enabled: false"));
    expect(h.fm.getRawFleetConfig().hub_member.enabled).toBe(true);
    const r = await h.request(true); expect(r.status).toBe(202);
    expect((yaml.load(readFileSync(h.file, "utf8")) as any).hub_member.enabled).toBe(false);
    expect((await h.gate.store.decide(r.body.pending_change.id, "confirm", { label: "host", current: () => true })).state).toBe("applied");
    expect((yaml.load(readFileSync(h.file, "utf8")) as any).hub_member.enabled).toBe(true);
  });
  it("an invalid member switch does not block unrelated Settings classification", async () => {
    const h = fleet(); writeFileSync(h.file, "instances: {}\nhub_member: invalid\n");
    const read = h.gate.options.baseline();
    await expect(read).resolves.toMatchObject({ config: expect.any(Object) });
    const baseline = await read;
    expect(prepareSettingsEffect("PUT", "/api/settings/fleet/defaults", { model: "new-model" }, baseline).diff).toBeNull();
    expect(() => baseline.hubMembership()).toThrow("invalid_hub_membership");
  });
});
