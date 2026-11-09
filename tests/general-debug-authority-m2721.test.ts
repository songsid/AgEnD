/** Decision 36525f1b: exercise the authenticated outbound sink, not a mocked permission decision. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import type { FleetConfig } from "../src/types.js";

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const proto = FleetManager.prototype as unknown as {
  checkToolPermission: unknown;
  handleOutboundFromInstance(instance: string, msg: Record<string, unknown>): Promise<void>;
};
function rig() {
  const home = mkdtempSync(join(tmpdir(), "agend-general-m2721-")); dirs.push(home);
  vi.stubEnv("AGEND_HOME", home);
  const config = { defaults: {}, instances: {
    admin: { working_directory: join(home, "admin"), general_topic: true },
    general: { working_directory: join(home, "general") }, // legacy name fallback
    worker: { working_directory: join(home, "worker"), skipPermissions: false, tags: ["deployment:demo"] },
    coord: { working_directory: join(home, "coord"), tool_set: "coordinator" },
    wide: { working_directory: join(home, "wide"), tool_set: "full" },
  } } as unknown as FleetConfig;
  const saveFleetConfig = vi.fn(() => writeFileSync(join(home, "fleet.yaml"), yaml.dump(config)));
  saveFleetConfig(); saveFleetConfig.mockClear();
  mkdirSync(join(home, "instances", "worker"), { recursive: true });
  writeFileSync(join(home, "instances", "worker", "output.log"), "scratch diagnostic output\n");
  const handleCreate = vi.fn(async (_args, respond) => respond({ success: true }));
  const responses: Array<{ result: unknown; error?: string }> = [];
  const adapter = { type: "telegram" };
  const fm = {
    fleetConfig: config, dataDir: home, saveFleetConfig,
    lifecycle: { handleCreate, has: () => false },
    classicChannels: { getAll: () => [], getChannelIdByInstance: () => undefined },
    worlds: new Map([["test", { adapter }]]), adapter,
    getAdapterForInstance: () => adapter, getWorldForInstance: () => ({ id: "test" }),
    getGroupIdForInstance: () => "123", getInstanceAdapterId: () => "test",
    instanceIpcClients: new Map(Object.keys(config.instances).map(name => [name, { send: (m: { result: unknown; error?: string }) => { responses.push(m); return true; } }])),
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    eventLog: null, touchActivity: () => {}, setTopicIcon: () => {}, checkToolPermission: proto.checkToolPermission,
  };
  const call = async (caller: string, tool: string, args: Record<string, unknown>, senderSessionName?: string) => {
    responses.length = 0;
    await proto.handleOutboundFromInstance.call(fm as never, caller, { tool, args, fleetRequestId: "test", senderSessionName });
    expect(responses).toHaveLength(1);
    return responses[0]!;
  };
  return { home, config, saveFleetConfig, handleCreate, call };
}
function argsFor(tool: string, extra: Record<string, unknown>) {
  return tool === "create_instance" ? { topic_name: "new-agent", ...extra } : { name: "worker", config: extra };
}

const configTools = ["update_instance_config", "create_instance"] as const;
describe("General debug and tool-set authority (36525f1b)", () => {
  it.each(["get_instance_logs", "get_fleet_config", "validate_config", "list_deployments"])("General reaches the real %s handler", async tool => {
    const r = rig();
    const args = tool === "get_instance_logs" ? { name: "worker" } : tool === "get_fleet_config" ? { scope: "instance", name: "worker" } : {};
    const out = await r.call("admin", tool, args);
    expect(out.error).toBeUndefined();
    if (tool === "get_instance_logs") expect(out.result).toMatchObject({ lines: "scratch diagnostic output\n" });
    if (tool === "get_fleet_config") expect(out.result).toMatchObject({ name: "worker", config: { skipPermissions: false } });
    if (tool === "validate_config") expect(out.result).toHaveProperty("fleet.errors");
    if (tool === "list_deployments") expect(out.result).toEqual([expect.objectContaining({ name: "demo" })]);
    expect(r.saveFleetConfig).not.toHaveBeenCalled(); expect(r.handleCreate).not.toHaveBeenCalled();
  });

  it.each(configTools)("General directly sets every writable profile through %s", async tool => {
    const r = rig();
    for (const tool_set of ["full", "standard", "worker", "coordinator", "minimal"]) {
      const out = await r.call("admin", tool, argsFor(tool, { tool_set }));
      expect(out.error).toBeUndefined(); expect(out.result).toMatchObject({ success: true });
      if (tool === "update_instance_config") {
        expect(r.config.instances.worker!.tool_set).toBe(tool_set);
        expect((yaml.load(readFileSync(join(r.home, "fleet.yaml"), "utf8")) as FleetConfig).instances.worker!.tool_set).toBe(tool_set);
      } else expect(r.handleCreate).toHaveBeenLastCalledWith(expect.objectContaining({ tool_set }), expect.any(Function), "test");
    }
    if (tool === "update_instance_config") expect(r.saveFleetConfig).toHaveBeenCalledTimes(5);
    else expect(r.handleCreate).toHaveBeenCalledTimes(5);
  });

  it.each(configTools)("the legacy General name may set a profile through %s", async tool => {
    const r = rig(); expect((await r.call("general", tool, argsFor(tool, { tool_set: "worker" }))).error).toBeUndefined();
  });

  it.each(configTools)("%s refuses non-General callers, even with full/coordinator or a forged sender", async tool => {
    const r = rig();
    for (const caller of ["worker", "coord", "wide"]) {
      const out = await r.call(caller, tool, argsFor(tool, { tool_set: "full", general_topic: true }), "admin");
      expect(out.result).toBeNull();
      expect(out.error).toMatch(caller === "worker" ? /not available/ : /#804\/#814/);
    }
    expect(r.config.instances.worker!.tool_set).toBeUndefined();
    expect(r.saveFleetConfig).not.toHaveBeenCalled(); expect(r.handleCreate).not.toHaveBeenCalled();
  });

  it.each(configTools)("%s refuses skipPermissions for everyone, including General", async tool => {
    const r = rig();
    for (const caller of ["admin", "coord", "wide", "worker"]) for (const skipPermissions of [true, false]) {
      const out = await r.call(caller, tool, argsFor(tool, { description: "must not save", skipPermissions }));
      expect(out.result).toBeNull(); expect(out.error).toBeTruthy();
      if (caller === "admin") expect(out.error).toMatch(/skipPermissions.*#804\/#814/);
    }
    expect(r.config.instances.worker!.skipPermissions).toBe(false);
    expect(r.config.instances.worker!.description).toBeUndefined();
    expect(r.saveFleetConfig).not.toHaveBeenCalled(); expect(r.handleCreate).not.toHaveBeenCalled();
  });

  it.each(configTools)("%s validates General's tool_set before any write or lifecycle call", async tool => {
    const r = rig();
    for (const tool_set of ["unknown", "general", "constructor", "__proto__", null, 42]) {
      const out = await r.call("admin", tool, argsFor(tool, { tool_set, description: "must not save" }));
      expect(out.result).toBeNull(); expect(out.error).toMatch(/Invalid.*tool_set/s);
    }
    expect(r.config.instances.worker!.tool_set).toBeUndefined(); expect(r.config.instances.worker!.description).toBeUndefined();
    expect(r.saveFleetConfig).not.toHaveBeenCalled(); expect(r.handleCreate).not.toHaveBeenCalled();
  });

  it.each(["checkout_repo", "release_repo"])("keeps %s out of General", async tool => {
    const r = rig(); const out = await r.call("admin", tool, {});
    expect(out.result).toBeNull(); expect(out.error).toMatch(/not available/);
  });

  it("rolls back the profile and sibling fields if saving fails", async () => {
    const r = rig(); r.config.instances.worker!.tool_set = "worker";
    r.saveFleetConfig.mockImplementationOnce(() => { throw new Error("owned write failed"); });
    const out = await r.call("admin", "update_instance_config", argsFor("update_instance_config", { tool_set: "full", description: "must roll back" }));
    expect(out.result).toBeNull(); expect(out.error).toContain("owned write failed");
    expect(r.config.instances.worker!.tool_set).toBe("worker");
    expect(r.config.instances.worker!.description).toBeUndefined();
  });

  it("a saved profile is enforced on the next outbound call", async () => {
    const r = rig();
    expect((await r.call("worker", "get_fleet_config", { scope: "instance", name: "worker" })).error).toBeUndefined();
    expect((await r.call("admin", "update_instance_config", argsFor("update_instance_config", { tool_set: "minimal" }))).error).toBeUndefined();
    expect((await r.call("worker", "get_fleet_config", { scope: "instance", name: "worker" })).error).toMatch(/not available/);
  });

  it("keeps an explicitly narrowed General narrowed", async () => {
    const r = rig(); r.config.instances.admin!.tool_set = "minimal";
    expect((await r.call("admin", "update_instance_config", argsFor("update_instance_config", { tool_set: "full" }))).error).toMatch(/not available/);
    expect(r.saveFleetConfig).not.toHaveBeenCalled();
  });
});
