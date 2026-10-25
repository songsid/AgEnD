import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { loginNoticeMode, tipNoticeMode, normalizeNoticeDelivery, setNoticeMode } from "../src/notice-delivery.js";
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
  it("a legacy \"dm\" through setNoticeMode writes only the boolean and drops any route", () => {
    const config: any = { defaults: {}, web: { notice_delivery: { login: "dm", tips: "dm" } }, instances: {} };
    setNoticeMode(config, "login", "dm"); setNoticeMode(config, "tips", "dm");
    expect(config).toEqual({ defaults: { tips: true }, web: { notify_login: true }, instances: {} });
    expect(validateFleetConfig(config).valid).toBe(true);
  });
  it("startup migrates both short-lived string forms, backs up and preserves comments", () => {
    const original = "# Keep my settings\ndefaults:\n  tips: dm\nweb:\n  notify_login: dm\ninstances: {}\n";
    const h = rig(original); h.fm.slimFleetConfigAtStartup();
    const raw = h.read();
    expect([raw.web.notify_login, raw.defaults.tips]).toEqual([true, true]);
    expect(raw.web.notice_delivery).toBeUndefined();                             // hmsg-d1809f2a/3b8ac2af: no DM routes
    expect([loginNoticeMode(raw.web), tipNoticeMode(raw)]).toEqual([true, true]);
    expect(readFileSync(h.file, "utf8")).toContain("# Keep my settings");
    expect(readFileSync(h.file + ".bak", "utf8")).toBe(original);
  });
  it("startup drops #2591's stored routes and backs up", () => {
    const original = "# Keep my settings\ndefaults:\n  tips: true\nweb:\n  notify_login: true\n  notice_delivery:\n    login: dm\n    tips: dm\ninstances: {}\n";
    const h = rig(original); h.fm.slimFleetConfigAtStartup();
    const raw = h.read();
    expect([raw.defaults.tips, raw.web.notify_login]).toEqual([true, true]);
    expect(raw.web.notice_delivery).toBeUndefined();
    expect(readFileSync(h.file, "utf8")).toContain("# Keep my settings");
    expect(readFileSync(h.file + ".bak", "utf8")).toBe(original);
    const off = rig("defaults:\n  tips: false\nweb:\n  notice_delivery:\n    tips: dm\ninstances: {}\n"); off.fm.slimFleetConfigAtStartup();
    expect(off.read().defaults.tips).toBe(false); expect(off.read().web?.notice_delivery).toBeUndefined();
    const empty = rig("web:\n  notify_login: false\n  notice_delivery: {}\ninstances: {}\n"); empty.fm.slimFleetConfigAtStartup();
    expect(empty.read().web).toEqual({ notify_login: false });
    const cfg: any = { defaults: {}, instances: {}, web: { notice_delivery: {} } }; normalizeNoticeDelivery(cfg);
    expect(cfg.web).not.toHaveProperty("notice_delivery"); expect(cfg.web.notify_login).toBeUndefined();
    const login = "web:\n  notify_login: true\n  notice_delivery:\n    login: dm\ninstances: {}\n";
    const only = rig(login); only.fm.slimFleetConfigAtStartup();
    expect(only.read().web).toEqual({ notify_login: true }); expect(readFileSync(only.file + ".bak", "utf8")).toBe(login);
  });
  it("an accepted hot reload converts legacy strings before a later rollback", async () => {
    const h = rig();
    h.fm.reconcilePreviewListener = vi.fn(); h.fm.reregisterClassicChannels = vi.fn();
    h.fm.startInstanceUnattended = () => { throw Error("no spawning in this data-only test"); };
    h.fm.startClassicInstanceUnattended = h.fm.startInstanceUnattended;
    writeFileSync(h.file, "defaults:\n  tips: dm\nweb:\n  notify_login: dm\ninstances: {}\n");
    expect(await h.fm.reconcileInstances()).toEqual({});
    expect([h.read().web.notify_login, h.read().defaults.tips]).toEqual([true, true]);
    expect(h.read().web.notice_delivery).toBeUndefined();
  });
  it("real Settings saves, reloads, and clears both modes without ever persisting a string boolean", async () => {
    const h = rig();
    expect(await put(h.fm, "/api/settings/fleet/defaults", { tips: "dm" })).toBe(200);    // a stale client's "dm" = on, topic
    expect(await put(h.fm, "/api/settings/fleet/web", { notify_login: "dm" })).toBe(200);
    expect([h.read().defaults.tips, h.read().web.notify_login]).toEqual([true, true]);
    expect(h.read().web.notice_delivery).toBeUndefined();
    h.fm.loadConfig(h.file);
    expect([loginNoticeMode(h.fm.fleetConfig.web), tipNoticeMode(h.fm.fleetConfig)]).toEqual([true, true]);
    expect(await put(h.fm, "/api/settings/fleet/web", { notify_login: false })).toBe(200);
    expect(h.read().web.notify_login).toBe(false);
    expect(await put(h.fm, "/api/settings/fleet/defaults", { tips: false })).toBe(200);
    expect([loginNoticeMode(h.read().web), tipNoticeMode(h.read())]).toEqual([false, false]);
    expect(h.read().web.notice_delivery).toBeUndefined();
  });
  it.each([["/api/settings/fleet/web", { notify_login: true }], ["/api/settings/fleet/defaults", { tips: true }], ["/api/settings/fleet/web", { log_tab: true }]])(
    "a managed save (%s %j) drops the stale #2591 routes from the file", async (path, body) => {
      const h = rig("web:\n  notify_login: true\n  notice_delivery:\n    login: dm\n    tips: dm\ndefaults:\n  tips: true\ninstances: {}\n");
      expect(await put(h.fm, path, body)).toBe(200);
      expect(h.read().web.notice_delivery).toBeUndefined();
      expect([h.read().web.notify_login, h.read().defaults.tips]).toEqual([true, true]);
    });
  it("off overrides retained routing metadata; legacy shorthand normalizes idempotently", () => {
    const cfg = { defaults: { tips: "dm" as const }, web: { notify_login: "dm" as const } };
    normalizeNoticeDelivery(cfg); const once = structuredClone(cfg); normalizeNoticeDelivery(cfg);
    expect(cfg).toEqual(once);
    expect(cfg).toEqual({ defaults: { tips: true }, web: { notify_login: true } });
    expect(loginNoticeMode({ notify_login: false, notice_delivery: { login: "dm" } })).toBe(false);
    expect(loginNoticeMode({ notify_login: true, notice_delivery: { login: "dm" } })).toBe(true);
    expect(loginNoticeMode({ notify_login: "dm" })).toBe(true);
    expect(tipNoticeMode({ defaults: { tips: false }, web: { notice_delivery: { tips: "dm" } } })).toBe(false);
    expect(tipNoticeMode({ defaults: { tips: true }, web: { notice_delivery: { tips: "dm" } } })).toBe(true);
    expect(tipNoticeMode({ defaults: { tips: "dm" } })).toBe(true);
  });
  it("routing has a closed schema and cannot hide unknown Settings effects", () => {
    expect(validateFleetConfig({ defaults: {}, instances: {}, web: { notice_delivery: { login: "email" } } }).valid).toBe(false);
    expect(validateFleetConfig({ defaults: {}, instances: {}, web: { notice_delivery: { extra: "dm" } } }).valid).toBe(false);
    expect(() => prepareSettingsEffect("PUT", "/api/settings/fleet/defaults", { tips: "dm" }, { config: { defaults: {}, instances: {} } as any, classic: {} })).not.toThrow();
  });
});
