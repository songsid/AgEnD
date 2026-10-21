import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANVAS_WORKER_EXPERIMENTAL_MESSAGE, canvasWorkerEnabled, isCanvasWorkerTool, readCanvasWorkerEnabled, scopedFleetConfigEnvironment, watchCanvasWorkerEnabled } from "../src/web-experimental.js";
import { TOOLS, toolsWithCanvasWorker } from "../src/channel/mcp-tools.js";
import { toolsFor, TOOL_PROFILES } from "../src/tool-permissions.js";
import { dispatchAgentOperation, type AgentEndpointContext } from "../src/agent-endpoint.js";
import { WebAppearance } from "../src/web-appearance.js";
import { ThemeStore } from "../src/web-theme-store.js";
import { AppearanceTools } from "../src/web-appearance-tools.js";
import { WebSettingsTools, type WebSettingsDeps } from "../src/web-settings-tools.js";

const dirs: string[] = [];
const tmp = () => { const p = mkdtempSync(join(tmpdir(), "agend-cw-agent-")); dirs.push(p); return p; };
afterEach(() => { vi.unstubAllEnvs(); for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }); });
const NAMES = ["upload_web_effect", "list_web_effects", "preview_web_effect", "profile_web_effect", "apply_web_effect", "remove_web_effect", "delete_web_effect", "export_web_mod", "propose_web_mod"];

describe("CW agent menus and current configuration", () => {
  it("requires an explicit boolean true and fails closed for absent/corrupt disk settings", () => {
    expect(canvasWorkerEnabled()).toBe(false);
    for (const value of [false, undefined, "true", 1]) expect(canvasWorkerEnabled({ experimental: { canvas_worker: value } } as never)).toBe(false);
    expect(canvasWorkerEnabled({ experimental: { canvas_worker: true } })).toBe(true);
    const dir = tmp();
    expect(readCanvasWorkerEnabled(dir)).toBe(false);
    writeFileSync(join(dir, "fleet.yaml"), "web:\n  experimental:\n    canvas_worker: true\n");
    expect(readCanvasWorkerEnabled(dir)).toBe(true);
    writeFileSync(join(dir, "fleet.yaml"), "web: [\n");
    expect(readCanvasWorkerEnabled(dir)).toBe(false);
  });
  it("uses a scoped custom config without allowing another home's inherited override", () => {
    const owner = tmp(), other = tmp(), custom = join(tmp(), "custom.yaml");
    writeFileSync(join(owner, "fleet.yaml"), "web: {}\n");
    writeFileSync(custom, "web:\n  experimental:\n    canvas_worker: true\n");
    vi.stubEnv("AGEND_FLEET_DATA_DIR", other);
    vi.stubEnv("AGEND_FLEET_CONFIG_PATH", custom);
    expect(scopedFleetConfigEnvironment(owner)).toEqual({});
    expect(readCanvasWorkerEnabled(owner)).toBe(false);
    vi.stubEnv("AGEND_FLEET_DATA_DIR", owner);
    expect(scopedFleetConfigEnvironment(owner)).toEqual({ AGEND_FLEET_DATA_DIR: owner, AGEND_FLEET_CONFIG_PATH: custom });
    expect(readCanvasWorkerEnabled(owner)).toBe(true);
    vi.stubEnv("AGEND_FLEET_CONFIG_PATH", "relative.yaml");
    expect(readCanvasWorkerEnabled(owner)).toBe(false);
    vi.stubEnv("AGEND_FLEET_CONFIG_PATH", custom + ".missing");
    expect(readCanvasWorkerEnabled(owner)).toBe(false);
  });
  it("FleetManager publishes only a successfully loaded custom config, and Daemon forwards only its own reference", async () => {
    const owner = tmp(), foreign = tmp(), custom = join(tmp(), "chosen.yaml");
    vi.stubEnv("AGEND_HOME", owner);
    vi.stubEnv("AGEND_FLEET_DATA_DIR", foreign);
    vi.stubEnv("AGEND_FLEET_CONFIG_PATH", join(foreign, "fleet.yaml"));
    writeFileSync(custom, "web:\n  experimental:\n    canvas_worker: true\ninstances: {}\n");
    const { FleetManager } = await import("../src/fleet-manager.js");
    const { Daemon } = await import("../src/daemon.js");
    const fm = new FleetManager(owner);
    const noop = () => {};
    const logger: any = { info: noop, warn: noop, debug: noop, trace: noop, error: noop, fatal: noop, child: () => logger };
    (fm as any).logger = logger;
    fm.loadConfig(custom);
    expect(scopedFleetConfigEnvironment(owner)).toEqual({ AGEND_FLEET_DATA_DIR: owner, AGEND_FLEET_CONFIG_PATH: custom });
    expect(readCanvasWorkerEnabled(owner)).toBe(true);
    expect(readCanvasWorkerEnabled(foreign)).toBe(false);
    const daemon = new Daemon("worker", { working_directory: owner, workflow: false,
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, log_level: "error" },
      join(owner, "instances", "worker"), false, undefined, undefined, logger as never);
    const build = () => (daemon as unknown as { buildBackendConfig(): { mcpServers: { agend: { env: Record<string, string> } } } }).buildBackendConfig().mcpServers.agend.env;
    expect(build()).toMatchObject({ AGEND_FLEET_DATA_DIR: owner, AGEND_FLEET_CONFIG_PATH: custom });
    vi.stubEnv("AGEND_FLEET_DATA_DIR", foreign);
    expect(build()).toMatchObject({ AGEND_FLEET_DATA_DIR: "", AGEND_FLEET_CONFIG_PATH: "" });
    vi.stubEnv("AGEND_FLEET_DATA_DIR", owner);
    const broken = join(owner, "invalid.yaml");
    writeFileSync(broken, "web: [\n");
    expect(() => fm.loadConfig(broken)).toThrow();
    expect(scopedFleetConfigEnvironment(owner)).toEqual({ AGEND_FLEET_DATA_DIR: owner, AGEND_FLEET_CONFIG_PATH: custom });
  });
  it("filters every profile's current menu, with ambient preserved and on menus unchanged", () => {
    for (const profile of Object.keys(TOOL_PROFILES) as Array<keyof typeof TOOL_PROFILES>) {
      const defs = TOOLS.filter(t => toolsFor(profile).has(t.name));
      const off = toolsWithCanvasWorker(false, defs);
      expect(off.some(t => NAMES.includes(t.name)), profile).toBe(false);
      expect(off.some(t => t.name === "set_web_ambient"), profile).toBe(defs.some(t => t.name === "set_web_ambient"));
      expect(toolsWithCanvasWorker(true, defs)).toEqual(defs);
    }
    expect(NAMES.every(isCanvasWorkerTool)).toBe(true);
    expect(isCanvasWorkerTool("set_web_ambient")).toBe(false);
    expect(isCanvasWorkerTool("clear_web_ambient")).toBe(false);
  });
  it("removes CW branches and advertisements from retained settings/appearance schemas", () => {
    const off = toolsWithCanvasWorker(false);
    const settings = off.find(t => t.name === "set_web_settings")!;
    const encoded = JSON.stringify(settings);
    for (const what of ["effect", "effect_slot", "mod"]) expect(encoded).not.toContain(`"const":"${what}"`);
    expect(encoded).toContain('"const":"ambient"');
    expect(encoded).toContain('"const":"custom_css"');
    expect(JSON.stringify(off)).not.toMatch(/Canvas Worker|upload_web_effect|effect slots/);
    expect(JSON.stringify(toolsWithCanvasWorker(true).find(t => t.name === "set_web_settings"))).toContain('"const":"effect"');
  });
  it("observes atomic replacement in both directions without restarting the MCP child", async () => {
    const dir = tmp(), changes: boolean[] = [];
    writeFileSync(join(dir, "fleet.yaml"), "web: {}\n");
    const stop = watchCanvasWorkerEnabled(dir, v => changes.push(v), 10);
    try {
      writeFileSync(join(dir, "next.yaml"), "web:\n  experimental:\n    canvas_worker: true\n");
      renameSync(join(dir, "next.yaml"), join(dir, "fleet.yaml"));
      await vi.waitFor(() => expect(changes).toEqual([true]), { interval: 15 });
      writeFileSync(join(dir, "fleet.yaml"), "web: {}\n");
      await vi.waitFor(() => expect(changes).toEqual([true, false]), { interval: 15 });
    } finally { stop(); }
  });
});

describe("HTTP agent calls cannot bypass the hidden menu", () => {
  it.each(["effect-upload", "effect-list", "effect-preview", "effect-profile", "effect-apply", "effect-remove", "effect-delete", "mod-export", "mod-propose"])("refuses guessed %s while off and restores it while on", async op => {
    let enabled = false;
    const handleWebThemeHttp = vi.fn(async (_instance: string, _tool: string, _args: Record<string, unknown>) => ({ ok: true }));
    const ctx = { fleetConfig: { instances: { worker: { tool_set: "full" } } }, logger: { warn: vi.fn() }, canvasWorkerEnabled: () => enabled, handleWebThemeHttp } as unknown as AgentEndpointContext;
    await expect(dispatchAgentOperation(ctx, "worker", op, {})).rejects.toThrow(CANVAS_WORKER_EXPERIMENTAL_MESSAGE);
    expect(handleWebThemeHttp).not.toHaveBeenCalled();
    enabled = true;
    await expect(dispatchAgentOperation(ctx, "worker", op, {})).resolves.toEqual({ ok: true });
    expect(handleWebThemeHttp).toHaveBeenCalledOnce();
  });
  it("leaves declarative ambient set/clear calls available in either state", async () => {
    for (const enabled of [false, true]) {
      const handleWebThemeHttp = vi.fn(async (_instance: string, _tool: string, _args: Record<string, unknown>) => ({ ok: true }));
      const ctx = { fleetConfig: { instances: { worker: { tool_set: "full" } } }, canvasWorkerEnabled: () => enabled, handleWebThemeHttp } as unknown as AgentEndpointContext;
      for (const op of ["ambient-set", "ambient-clear"]) await expect(dispatchAgentOperation(ctx, "worker", op, {})).resolves.toEqual({ ok: true });
      expect(handleWebThemeHttp.mock.calls.map(c => c[1])).toEqual(["set_web_ambient", "clear_web_ambient"]);
    }
  });
});

describe("retained appearance reads keep disabled CW private and preserve saved data", () => {
  it("get_web_theme hides CW placements, preserves ambient and restores the saved IDs on enable", () => {
    const dir = tmp(), store = new ThemeStore(dir), id = "a".repeat(32);
    expect(store.setPlacements("worker", { effects: [id] }, "agent", () => null).ok).toBe(true);
    let enabled = false;
    const appearance = new WebAppearance(store, () => ({ experimental: { canvas_worker: enabled } }));
    const before = readFileSync(store.path, "utf8");
    expect(appearance.getTheme("worker")).not.toHaveProperty("effects");
    expect(appearance.getTheme("worker")).toHaveProperty("ambient");
    expect(appearance.resetTheme("worker")).not.toHaveProperty("error");
    expect(appearance.humanReset("worker")).toMatchObject({ ok: true });
    expect(store.get("worker").placements.effects).toEqual([{ id, by: "agent", at: expect.any(Number) }]);
    enabled = true;
    expect(appearance.getTheme("worker").effects).toEqual([{ id, by: "agent", at: expect.any(Number) }]);
    // Reads do not write; explicit resets may change theme state but keep the hidden selections.
    expect(JSON.parse(before).instances.worker.placements.effects).toEqual(store.get("worker").placements.effects);
    expect(appearance.humanReset("worker")).toMatchObject({ ok: true });
    expect(store.get("worker").placements.effects).toEqual([]);
  });
  it("get_web_appearance omits effects and never reads their library while off", () => {
    let enabled = false;
    const effects = vi.fn(() => [{ id: "a".repeat(32), by: "agent" as const, playback: {} }]);
    const tools = new AppearanceTools({ canvasWorkerEnabled: () => enabled, frame: name => ({ name }), theme: () => ({ theme: { v: 1 }, locked: false }), card: () => ({}), cardPicture: () => null, themeAsset: () => null, profileAvatar: () => null, botAvatar: () => null, themeAnswer: () => ({}), effects });
    expect(tools.handle("worker", "get_web_appearance", {})).not.toHaveProperty("effects");
    expect(effects).not.toHaveBeenCalled();
    enabled = true;
    expect(tools.handle("worker", "get_web_appearance", {}).effects).toEqual([{ id: "a".repeat(32), by: "agent", playback: {} }]);
    expect(effects).toHaveBeenCalledOnce();
  });
  it("General settings hide CW state and refuse CW mutations while preserving ambient and Restore defaults", () => {
    let enabled = false;
    const values: Record<string, unknown> = { "fx.sidebar": "b".repeat(32) };
    const mods = { list: vi.fn(() => ({ mods: [] })), proposals: vi.fn(() => []) };
    const placements = vi.fn(() => [{ id: "a".repeat(32) }]);
    const setAmbient = vi.fn(() => ({ ok: true }));
    const deps = { canvasWorkerEnabled: () => enabled, prefs: { people: () => [], read: () => ({ values }), readForViewer: () => ({ values }), parsePatch: (set: Record<string, unknown>) => ({ ok: true, patch: set }), writeForViewer: (_: unknown, patch: Record<string, unknown>) => { for (const [k, v] of Object.entries(patch)) if (v === null) delete values[k]; else values[k] = v; return { ok: true, changed: Object.keys(patch), view: { values } }; } }, ownerCss: { state: () => ({ active: null, pending: null, versions: [] }) }, mods, effects: { collectOwnerReplaced: vi.fn() }, instances: () => ["worker"], colour: () => ({ color: null, show: null }), ambient: () => ({ loop: { spec: { preset: "fall" }, by: "agent" } }), placements, setAmbient, announce: vi.fn() } as unknown as WebSettingsDeps;
    const tools = new WebSettingsTools(deps);
    const read = tools.read();
    expect(read).not.toHaveProperty("effect_slots");
    expect(read).not.toHaveProperty("mods");
    expect(JSON.stringify(read)).not.toContain("a".repeat(32));
    expect(JSON.stringify(read)).not.toContain("b".repeat(32));
    expect(JSON.stringify(read)).toContain("fall");
    expect(mods.list).not.toHaveBeenCalled();
    expect(placements).not.toHaveBeenCalled();
    for (const what of ["effect", "effect_slot", "mod"]) expect(tools.change(undefined, { what })).toMatchObject({ ok: false, error: "experimental_feature_disabled", detail: CANVAS_WORKER_EXPERIMENTAL_MESSAGE });
    expect(tools.change(undefined, { what: "ambient", instance: "worker", ambient: null })).toMatchObject({ ok: true });
    expect(setAmbient).toHaveBeenCalledOnce();
    expect(tools.change(undefined, { what: "restore_defaults" })).toMatchObject({ ok: true });
    expect(values["fx.sidebar"]).toBe("b".repeat(32));
    enabled = true;
    expect(tools.read()).toHaveProperty("effect_slots.sidebar", "b".repeat(32));
    expect(tools.read()).toHaveProperty("agents.0.effects.0.id", "a".repeat(32));
  });
});
