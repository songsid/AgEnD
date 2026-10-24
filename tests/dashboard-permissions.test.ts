/**
 * Which dashboard features an agent may use (src/dashboard-permissions.ts): `dashboard:` per instance and in `defaults`,
 * merged key by key, on top of the tool profile. A feature switched off is refused at the fleet's sinks (the outbound
 * IPC and the agent endpoint, read at each call), leaves the agent's MCP menu from its next start (AGEND_DASHBOARD_OFF),
 * and is kept current by the daemon. Settings: one feature at a time (null follows the default again); switching off
 * applies directly, switching on — in effect, for an agent or through the default — waits for the confirmation.
 *
 * Isolation: temp directories; the sinks with minimal contexts (tool-permissions.test.ts's pattern); the settings gate's
 * pure functions.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOLS } from "../src/channel/mcp-tools.js";
import { TOOL_PROFILES } from "../src/tool-permissions.js";
import {
  DASHBOARD_FEATURES, DASHBOARD_FEATURE_TOOLS, dashboardAccessProblem, dashboardFeatureOf, dashboardFeaturesOff, dashboardRefusal,
  featuresOffFromEnv, withoutFeatures,
} from "../src/dashboard-permissions.js";
import { dispatchAgentOperation, ToolNotPermittedError } from "../src/agent-endpoint.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { loadFleetConfig } from "../src/config.js";
import { normalizeSettingsInstancePatch } from "../src/settings-instance-patch.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { SettingsConfirmationError } from "../src/settings-confirmation.js";
import { HOT_INSTANCE_CONFIG_KEYS } from "../src/instance-config-impact.js";
// @ts-expect-error — a JS module of the app, with no types
import { agentForm, agentPatch, dashboardDefault, dashboardForm } from "../src/ui/settings-model.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "dash-perms-")); dirs.push(d); return d; };

describe("the features and their tools", () => {
  it("every tool a feature names exists, and every dashboard tool the profiles carry belongs to its feature", () => {
    const known = new Set(TOOLS.map((t) => t.name));
    for (const f of DASHBOARD_FEATURES) for (const tool of DASHBOARD_FEATURE_TOOLS[f]) expect(known.has(tool), tool).toBe(true);
    const appearance = [...known].filter((t) => /_web_(theme|appearance|widget|ambient|mod|effects?)$|^set_web_theme_asset$/.test(t));
    expect(appearance.sort()).toEqual([...DASHBOARD_FEATURE_TOOLS.appearance].sort());
    expect([...known].filter((t) => /_web_settings$/.test(t)).sort()).toEqual(["get_web_settings", "set_web_settings"]);
    expect(dashboardFeatureOf("task")).toBe("task_board");
    expect(dashboardFeatureOf("reply")).toBeNull();
    // What a worker has of them today: all but the person's web settings.
    const worker = new Set(TOOL_PROFILES.worker);
    expect(DASHBOARD_FEATURE_TOOLS.appearance.every((t) => worker.has(t)) && worker.has("task")).toBe(true);
  });

  it("only false switches a feature off (office: anything but true, #2578); the refusal names it and says not to retry", () => {
    expect(dashboardFeaturesOff(undefined)).toEqual(["office"]);
    expect(dashboardFeaturesOff({ appearance: true, task_board: false, web_settings: null, office: true })).toEqual(["task_board"]);
    expect(dashboardRefusal({ task_board: false }, "task")).toMatch(/task is not available.*"task_board".*dashboard\.task_board: false.*Do not retry/);
    expect(dashboardRefusal({ task_board: false }, "set_web_theme")).toBeNull();
    expect(dashboardRefusal({ appearance: true }, "set_web_theme")).toBeNull();
    expect(dashboardRefusal(undefined, "set_web_settings")).toBeNull();
  });

  it("the MCP menu leaves out the switched-off features' tools; the env names only known features", () => {
    expect(featuresOffFromEnv(" appearance,bogus,task_board,appearance ")).toEqual(["appearance", "task_board"]);
    expect(featuresOffFromEnv(undefined)).toEqual([]);
    const menu = withoutFeatures(TOOLS.filter((t) => TOOL_PROFILES.worker.includes(t.name)), ["appearance", "task_board"]).map((t) => t.name);
    expect(menu).toContain("reply");
    expect(menu.some((t) => DASHBOARD_FEATURE_TOOLS.appearance.includes(t) || t === "task")).toBe(false);
  });
});

describe("fleet.yaml: a mapping of known features to booleans; defaults and an instance merge key by key", () => {
  it("the validator refuses an unknown feature, a non-boolean and a non-mapping, in defaults and instances", () => {
    expect(dashboardAccessProblem({ appearance: false })).toBeNull();
    const errors = (cfg: unknown) => validateFleetConfig(cfg).errors.filter((e) => e.path.includes("dashboard")).map((e) => `${e.path}: ${e.message}`);
    expect(errors({ defaults: { dashboard: { apperance: false } }, instances: {} })).toEqual(['defaults.dashboard: unknown feature "apperance" (known: appearance, task_board, web_settings, office)']);
    expect(errors({ defaults: {}, instances: { a: { dashboard: { task_board: "no" } } } })).toEqual(["instances.a.dashboard: task_board must be true or false"]);
    expect(errors({ defaults: {}, instances: { a: { dashboard: "off" } } }).join()).toMatch(/must be a mapping/);
    expect(errors({ defaults: { dashboard: { web_settings: false } }, instances: { a: { dashboard: { appearance: false } } } })).toEqual([]);
  });

  it("an instance sets only what differs from the default", () => {
    const d = tempDir();
    const file = join(d, "fleet.yaml");
    writeFileSync(file, "defaults:\n  dashboard: { appearance: false, web_settings: false }\ninstances:\n  dev:\n    working_directory: " + d + "\n    dashboard: { appearance: true, task_board: false }\n  plain:\n    working_directory: " + d + "\n");
    const cfg = loadFleetConfig(file);
    expect(cfg.instances.dev!.dashboard).toEqual({ appearance: true, web_settings: false, task_board: false });
    expect(dashboardFeaturesOff(cfg.instances.plain!.dashboard)).toEqual(["appearance", "web_settings", "office"]);
  });
});

describe("enforced at the fleet's sinks, as configured now", () => {
  it("the outbound IPC: a switched-off feature's tool is refused with its reason; the profile still decides the rest", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const warn = vi.fn();
    const fm = { fleetConfig: { defaults: {}, instances: { dev: { working_directory: "/tmp/d", dashboard: { task_board: false } } } },
      logger: { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }, canvasWorkerEnabled: () => false };
    const check = (FleetManager.prototype as any).checkToolPermission.bind(fm);
    expect(check("ipc-outbound", "dev", "task")).toEqual({ allowed: false, message: dashboardRefusal({ task_board: false }, "task") });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ sink: "ipc-outbound", tool: "task", dashboard: true }), expect.stringContaining("refused"));
    expect(check("ipc-outbound", "dev", "set_web_theme").allowed).toBe(true);
    expect(check("ipc-outbound", "dev", "create_instance").message).toMatch(/create_instance is not available/);   // the profile's
    fm.fleetConfig.instances.dev.dashboard = { task_board: true };                                              // read at each call
    expect(check("ipc-outbound", "dev", "task").allowed).toBe(true);
  }, 30_000);                                       // the first import of the fleet is slow under load

  it("the agent endpoint (`agend task …`): refused before the board is touched", async () => {
    const handled = vi.fn(async () => ({ ok: true }));
    const ctx = { dataDir: tempDir(), fleetConfig: { defaults: {}, instances: { dev: { working_directory: "/tmp/d", dashboard: { task_board: false } } } },
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }, handleTaskCrudHttp: handled };
    const err = await dispatchAgentOperation(ctx as never, "dev", "task", {}).catch((e) => e as Error);
    expect(err).toBeInstanceOf(ToolNotPermittedError);
    expect((err as Error).message).toMatch(/dashboard\.task_board: false/);
    expect(handled).not.toHaveBeenCalled();
    ctx.fleetConfig.instances.dev.dashboard = {} as never;
    await expect(dispatchAgentOperation(ctx as never, "dev", "task", {})).resolves.toEqual({ ok: true });
  });
});

describe("the agent's side: its tool menu from its next start; the daemon keeps the setting current", () => {
  it("a hot key: applied without a restart, the daemon keeps it, and the spawn names what is off", async () => {
    expect(HOT_INSTANCE_CONFIG_KEYS.has("dashboard")).toBe(true);
    const { Daemon } = await import("../src/daemon.js");
    const self = { config: { dashboard: { appearance: false } } as Record<string, any>, updateToolProgress: () => {} };
    (Daemon.prototype as any).applyConfigUpdate.call(self, { dashboard: { task_board: false } });
    expect(self.config.dashboard).toEqual({ task_board: false });
    (Daemon.prototype as any).applyConfigUpdate.call(self, { dashboard: { bogus: false } });                // refused shape: kept
    expect(self.config.dashboard).toEqual({ task_board: false });
    (Daemon.prototype as any).applyConfigUpdate.call(self, { dashboard: null });
    expect(self.config.dashboard).toBeUndefined();
    const source = (await import("node:fs")).readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");
    expect(source).toMatch(/mcpEnv\.AGEND_DASHBOARD_OFF = dashboardOff\.join\(","\)/);
    const mcp = (await import("node:fs")).readFileSync(new URL("../src/channel/mcp-server.ts", import.meta.url), "utf8");
    expect(mcp).toMatch(/withoutFeatures\(TOOLS\.filter\(t => allowedTools\.has\(t\.name\)\), dashboardOffNow\(\)\)/);
    expect(mcp).toMatch(/watchDashboardOff\(featureDataDir, menuInstance, spawnDashboardOff, \(\) => \{ void mcp\.sendToolListChanged\(\)/);
  }, 30_000);
});

describe("Settings: one feature at a time; switching off applies directly, switching on is confirmed", () => {
  const config = () => ({
    defaults: { backend: "claude-code" } as Record<string, any>,
    channels: [{ id: "main", type: "telegram", mode: "topic", group_id: "-1001", bot_token_env: "BOT", access: { mode: "locked", allowed_users: ["1"] } }],
    instances: { dev: { working_directory: "/tmp/dev" } as Record<string, any>, other: { working_directory: "/tmp/o" } as Record<string, any> },
  });
  const gate = (method: string, path: string, body: unknown, cfg: any): "direct" | string[] | string => {
    try {
      const { diff } = prepareSettingsEffect(method, path, body, { config: cfg, classic: {} });
      return diff ? [...diff.summary] : "direct";
    } catch (e) {
      if (e instanceof SettingsConfirmationError) return `refused:${(e as any).code ?? e.message}`;
      throw e;
    }
  };
  const agent = (body: unknown, cfg = config()) => gate("PATCH", "/api/settings/fleet/instances/dev", body, cfg);
  const defaults = (body: unknown, cfg = config()) => gate("PUT", "/api/settings/fleet/defaults", body, cfg);

  it("an agent's patch: a feature set to null follows the default again; none left, the key goes", () => {
    expect(normalizeSettingsInstancePatch({ dashboard: { appearance: false, task_board: false } }, { dashboard: { appearance: null, web_settings: false } }))
      .toEqual({ dashboard: { task_board: false, web_settings: false } });
    expect(normalizeSettingsInstancePatch({ dashboard: { appearance: false } }, { dashboard: { appearance: null } })).toEqual({});
  });

  it("an agent: switching a feature off is direct; on again — or back to a default that allows it — is confirmed", () => {
    expect(agent({ dashboard: { task_board: false } })).toBe("direct");
    const off = config(); off.instances.dev.dashboard = { task_board: false };
    expect(agent({ dashboard: { task_board: true } }, off)).toEqual([expect.any(String), "instances.dev.dashboard.task\\_board \\(in effect\\): false → true"]);
    expect(agent({ dashboard: { task_board: null } }, off)).toEqual([expect.any(String), "instances.dev.dashboard.task\\_board \\(in effect\\): false → true"]);
    // Back to a default that switches it off too: nothing opens.
    const both = config(); both.defaults.dashboard = { task_board: false }; both.instances.dev.dashboard = { task_board: false };
    expect(agent({ dashboard: { task_board: null } }, both)).toBe("direct");
    expect(String(agent({ dashboard: { task_board: "yes" } }))).not.toBe("direct");
  });

  it("the default: switching off is direct; on again names the agents it opens up for", () => {
    expect(defaults({ dashboard: { appearance: false, task_board: true, web_settings: true } })).toBe("direct");
    const off = config(); off.defaults.dashboard = { appearance: false };
    off.instances.other.dashboard = { appearance: false };                       // its own: stays off
    expect(defaults({ dashboard: { appearance: true, task_board: true, web_settings: true } }, off))
      .toEqual([expect.any(String), "defaults.dashboard.appearance \\(in effect\\): false → true — 1 agent(s) inherit it: dev"]);
  });

  it("the page: the agent dialog's three choices and the defaults' ticks", () => {
    expect(dashboardForm({ dashboard: { appearance: false, task_board: true } })).toEqual({ appearance: "off", task_board: "on", web_settings: "inherit", office: "inherit" });
    expect(dashboardDefault({ dashboard: { web_settings: false } }, "web_settings")).toBe(false);
    expect(dashboardDefault({}, "appearance")).toBe(true);
    const inst = { working_directory: "/w", dashboard: { appearance: false } };
    const form = agentForm(inst, {});
    expect(agentPatch(form, inst, {}, null, null)).toEqual({});                                   // nothing touched, nothing sent
    form.dashboard = { appearance: "inherit", task_board: "off", web_settings: "inherit", office: "inherit" };
    expect(agentPatch(form, inst, {}, null, null)).toEqual({ dashboard: { appearance: null, task_board: false, web_settings: null } });
  });
  it("the Office picker reads and writes the compatible scalar without a dashboard.office key", () => {
    const inst = { working_directory: "/w", office_access: false };
    const form = agentForm(inst, { office_access: true });
    expect(form.dashboard.office).toBe("off");
    expect(dashboardDefault({ office_access: true }, "office")).toBe(true);
    expect(agentPatch(form, inst, { office_access: true }, null, null)).toEqual({});
    form.dashboard.office = "on";
    expect(agentPatch(form, inst, { office_access: true }, null, null)).toEqual({ office_access: true });
    form.dashboard.office = "inherit";
    expect(agentPatch(form, inst, { office_access: true }, null, null)).toEqual({ office_access: null });
  });

});
