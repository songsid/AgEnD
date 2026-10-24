import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { dashboardFeaturesOffIn, dashboardAccessOf, dashboardFeaturesOff, withoutFeatures, dashboardRefusalIn } from "../src/dashboard-permissions.js";
import { handleSettingsRequest } from "../src/settings-api.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function rig(text = "defaults: {}\ninstances: {}\n") {
  const dir = mkdtempSync(join(tmpdir(), "agend-office-downgrade-")); dirs.push(dir);
  const file = join(dir, "fleet.yaml"); writeFileSync(file, text);
  const fm = new FleetManager(dir) as any; fm.loadConfig(file);
  return { fm, file, read: () => yaml.load(readFileSync(file, "utf8")) as any };
}
function put(fm: any, path: string, body: unknown, method = "PUT"): Promise<number> {
  return new Promise(resolve => {
    const req = Object.assign(new EventEmitter(), { method, destroy() {} });
    let code = 0; const res = { writeHead(status: number) { code = status; }, end() { resolve(code); } };
    expect(handleSettingsRequest(req as never, res as never, new URL(path, "http://localhost"), fm)).toBe(true);
    queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
  });
}
describe("Office downgrade-safe storage", () => {
  it("startup migrates default on and instance off with a backup and unchanged effective access", () => {
    const original = "# retain me\ndefaults:\n  dashboard: {office: true, task_board: false}\ninstances:\n  dev:\n    working_directory: /tmp\n    dashboard: {office: false}\n";
    const h = rig(original); h.fm.slimFleetConfigAtStartup();
    const raw = h.read();
    expect(raw.defaults.office_access).toBe(true);
    expect(raw.instances.dev.office_access).toBe(false);
    expect(raw.defaults.dashboard).toEqual({ task_board: false });
    expect(raw.instances.dev.dashboard?.office).toBeUndefined();
    expect(dashboardFeaturesOffIn(h.fm.fleetConfig, "dev")).toContain("office");
    expect(dashboardFeaturesOffIn(h.fm.fleetConfig, "classic-room")).not.toContain("office");
    expect(readFileSync(h.file + ".bak", "utf8")).toBe(original);
    expect(readFileSync(h.file, "utf8")).toContain("# retain me");
  });
  it("accepted reload migrates off too without spawning anything", async () => {
    const h = rig(); h.fm.reconcilePreviewListener = vi.fn(); h.fm.reregisterClassicChannels = vi.fn();
    h.fm.startInstanceUnattended = h.fm.startClassicInstanceUnattended = () => { throw Error("forbidden spawn"); };
    const legacy = "defaults:\n  dashboard: {office: false}\ninstances: {}\n";
    writeFileSync(h.file, legacy); await h.fm.reconcileInstances();
    expect(h.read().defaults.office_access).toBe(false);
    expect(h.read().defaults.dashboard?.office).toBeUndefined();
    expect(readFileSync(h.file + ".bak", "utf8")).toBe(legacy);
  });
  it("Settings writes only safe fields, and instance inherit removes its override", async () => {
    const h = rig("defaults: {}\ninstances:\n  dev: {working_directory: /tmp}\n");
    expect(await put(h.fm, "/api/settings/fleet/defaults", { dashboard: { office: true } })).toBe(200);
    expect(h.read().defaults.office_access).toBe(true);
    expect(h.read().defaults.dashboard?.office).toBeUndefined();
    expect(await put(h.fm, "/api/settings/fleet/instances/dev", { office_access: false }, "PATCH")).toBe(200);
    expect(h.read().instances.dev.office_access).toBe(false);
    expect(dashboardFeaturesOffIn(h.fm.fleetConfig, "dev")).toContain("office");
    expect(await put(h.fm, "/api/settings/fleet/instances/dev", { office_access: null }, "PATCH")).toBe(200);
    expect(h.read().instances.dev.office_access).toBeUndefined();
    h.fm.loadConfig(h.file);
    expect(dashboardFeaturesOffIn(h.fm.fleetConfig, "dev")).not.toContain("office");
    expect(await put(h.fm, "/api/settings/fleet/instances/dev", { dashboard: { office: false } }, "PATCH")).toBe(200);
    expect(h.read().instances.dev.office_access).toBe(false);
    expect(h.read().instances.dev.dashboard?.office).toBeUndefined();
  });
  it("canonical off wins over conflicting legacy on during migration", () => {
    const h = rig("defaults:\n  office_access: false\n  dashboard: {office: true}\ninstances: {}\n");
    h.fm.slimFleetConfigAtStartup();
    expect(h.read().defaults.office_access).toBe(false);
    expect(h.read().defaults.dashboard?.office).toBeUndefined();
    expect(dashboardFeaturesOffIn(h.fm.fleetConfig, "room")).toContain("office");
  });
  it("invalid legacy input is refused without migration or a rewrite", () => {
    const original = "defaults:\n  dashboard: {office: wrong}\ninstances: {}\n";
    const h = rig(original); h.fm.slimFleetConfigAtStartup();
    expect(readFileSync(h.file, "utf8")).toBe(original);
    expect(validateFleetConfig(h.read()).valid).toBe(false);
  });
  it("canonical on is confirmed, off is direct, and malformed values are refused", () => {
    const cfg: any = { defaults: {}, instances: { dev: { working_directory: "/tmp" } } };
    const gate = (body: unknown) => prepareSettingsEffect("PATCH", "/api/settings/fleet/instances/dev", body, { config: cfg, classic: {} }).diff;
    expect(gate({ office_access: true })?.section).toBe("access");
    expect(gate({ office_access: false })).toBeNull();
    cfg.defaults.office_access = true; cfg.instances.dev.office_access = false;
    expect(gate({ office_access: null })?.section).toBe("access");
    expect(validateFleetConfig({ ...cfg, defaults: { office_access: "yes" } }).valid).toBe(false);
  });

  it("direct managed saves canonicalize a legacy edit; current menu and call gate agree", () => {
    const h = rig("defaults: {}\ninstances:\n  dev: {working_directory: /tmp}\n");
    h.fm.fleetConfig.defaults.dashboard = { office: true }; h.fm.saveFleetConfig();
    expect(h.read().defaults.office_access).toBe(true);
    expect(h.read().defaults.dashboard?.office).toBeUndefined();
    h.fm.loadConfig(h.file);
    const access = () => dashboardFeaturesOff(dashboardAccessOf(h.fm.fleetConfig.instances.dev));
    const tools = [{ name: "office_view" }, { name: "office_set" }, { name: "task" }];
    expect(withoutFeatures(tools, access())).toEqual(tools);
    expect(dashboardRefusalIn(h.fm.fleetConfig, "dev", "office_set")).toBeNull();
    h.fm.fleetConfig.instances.dev.office_access = false;
    expect(withoutFeatures(tools, access())).toEqual([{ name: "task" }]);
    expect(dashboardRefusalIn(h.fm.fleetConfig, "dev", "office_set")).toContain("office_access");
  });

  it("a manual null follows the default in loaded menus and call-time gates", () => {
    const h = rig("defaults: {office_access: true}\ninstances:\n  dev: {working_directory: /tmp, office_access: null}\n");
    expect(dashboardFeaturesOffIn(h.fm.fleetConfig, "dev")).not.toContain("office");
    expect(dashboardFeaturesOff(dashboardAccessOf(h.fm.fleetConfig.instances.dev))).not.toContain("office");
  });

});
