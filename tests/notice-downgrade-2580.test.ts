import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { loginNoticeMode, tipNoticeMode, normalizeNoticeDelivery, NEW_FLEET_WEB } from "../src/notice-delivery.js";
import { handleSettingsRequest } from "../src/settings-api.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function rig(text = "defaults: {}\ninstances: {}\n") {
  const dir = mkdtempSync(join(tmpdir(), "agend-notice-downgrade-")); dirs.push(dir);
  const file = join(dir, "fleet.yaml"); writeFileSync(file, text);
  const fm = new FleetManager(dir) as any; fm.loadConfig(file);
  return { fm, file, read: () => yaml.load(readFileSync(file, "utf8")) as any };
}
function put(fm: any, path: string, body: unknown): Promise<number> {
  return new Promise(resolve => {
    const req = Object.assign(new EventEmitter(), { method: "PUT", destroy() {} });
    let code = 0; const res = { writeHead(status: number) { code = status; }, end() { resolve(code); } };
    expect(handleSettingsRequest(req as never, res as never, new URL(path, "http://localhost"), fm)).toBe(true);
    queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
  });
}
describe("#2580 downgrade-safe notice storage", () => {
  it("new fleets keep the legacy field boolean, with DM in the ignored optional key", () => {
    const config = { defaults: {}, web: { ...NEW_FLEET_WEB }, instances: {} };
    expect(config.web.notify_login).toBe(true); expect(loginNoticeMode(config.web)).toBe("dm");
    expect(validateFleetConfig(config).valid).toBe(true);
  });
  it("startup migrates both short-lived string forms, backs up and preserves comments", () => {
    const original = "# Keep my settings\ndefaults:\n  tips: dm\nweb:\n  notify_login: dm\ninstances: {}\n";
    const h = rig(original); h.fm.slimFleetConfigAtStartup();
    const raw = h.read();
    expect([raw.web.notify_login, raw.defaults.tips]).toEqual([true, true]);
    expect(raw.web.notice_delivery).toEqual({ login: "dm", tips: "dm" });
    expect([loginNoticeMode(raw.web), tipNoticeMode(raw)]).toEqual(["dm", "dm"]);
    expect(readFileSync(h.file, "utf8")).toContain("# Keep my settings");
    expect(readFileSync(h.file + ".bak", "utf8")).toBe(original);
  });
  it("an accepted hot reload converts legacy strings before a later rollback", async () => {
    const h = rig();
    h.fm.reconcilePreviewListener = vi.fn(); h.fm.reregisterClassicChannels = vi.fn();
    h.fm.startInstanceUnattended = () => { throw Error("no spawning in this data-only test"); };
    h.fm.startClassicInstanceUnattended = h.fm.startInstanceUnattended;
    writeFileSync(h.file, "defaults:\n  tips: dm\nweb:\n  notify_login: dm\ninstances: {}\n");
    expect(await h.fm.reconcileInstances()).toEqual({});
    expect([h.read().web.notify_login, h.read().defaults.tips]).toEqual([true, true]);
    expect(h.read().web.notice_delivery).toEqual({ login: "dm", tips: "dm" });
  });
  it("real Settings saves, reloads, and clears both modes without ever persisting a string boolean", async () => {
    const h = rig();
    expect(await put(h.fm, "/api/settings/fleet/defaults", { tips: "dm" })).toBe(200);
    expect(await put(h.fm, "/api/settings/fleet/web", { notify_login: "dm" })).toBe(200);
    expect([h.read().defaults.tips, h.read().web.notify_login]).toEqual([true, true]);
    expect(h.read().web.notice_delivery).toEqual({ login: "dm", tips: "dm" });
    h.fm.loadConfig(h.file);
    expect([loginNoticeMode(h.fm.fleetConfig.web), tipNoticeMode(h.fm.fleetConfig)]).toEqual(["dm", "dm"]);
    expect(await put(h.fm, "/api/settings/fleet/web", { notify_login: true })).toBe(200);
    expect(h.read().web.notice_delivery).toEqual({ tips: "dm" });
    expect(await put(h.fm, "/api/settings/fleet/defaults", { tips: false })).toBe(200);
    expect([loginNoticeMode(h.read().web), tipNoticeMode(h.read())]).toEqual([true, false]);
    expect(h.read().web.notice_delivery).toBeUndefined();
  });
  it("off overrides retained routing metadata; legacy shorthand normalizes idempotently", () => {
    const cfg = { defaults: { tips: "dm" as const }, web: { notify_login: "dm" as const } };
    normalizeNoticeDelivery(cfg); const once = structuredClone(cfg); normalizeNoticeDelivery(cfg);
    expect(cfg).toEqual(once);
    expect(loginNoticeMode({ notify_login: false, notice_delivery: { login: "dm" } })).toBe(false);
    expect(tipNoticeMode({ defaults: { tips: false }, web: { notice_delivery: { tips: "dm" } } })).toBe(false);
  });
  it("routing has a closed schema and cannot hide unknown Settings effects", () => {
    expect(validateFleetConfig({ defaults: {}, instances: {}, web: { notice_delivery: { login: "email" } } }).valid).toBe(false);
    expect(validateFleetConfig({ defaults: {}, instances: {}, web: { notice_delivery: { extra: "dm" } } }).valid).toBe(false);
    expect(() => prepareSettingsEffect("PUT", "/api/settings/fleet/defaults", { tips: "dm" }, { config: { defaults: {}, instances: {} } as any, classic: {} })).not.toThrow();
  });
});
