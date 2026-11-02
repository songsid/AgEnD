/**
 * M-2239 P1-1: a Windows agent is created and configured only by an administrator in the web dashboard. No MCP path
 * reaches it: create_instance refuses `runtime: "windows"` and `sandbox`, the schema does not offer them, handleCreate
 * (deploy_template's path too) refuses the runtime, and update_instance_config / replace_instance refuse a Windows
 * target. Messages to a Windows agent (send_to_instance) are untouched.
 */
import { describe, expect, it, vi } from "vitest";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { CreateInstanceArgs } from "../src/outbound-schemas.js";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";
import { WINDOWS_CONFIG_REFUSED, WINDOWS_CREATE_REFUSED } from "../src/native-instance-registry.js";

const WINDOWS = { runtime: "windows", native_agent_id: "12345678-1234-4321-abcd-123456789012", native_sandbox: "read-only", working_directory: "C:\\Work" };
const META = { instanceName: "general", requestId: undefined, fleetRequestId: undefined, senderSessionName: undefined } as const;

function ctx() {
  return {
    fleetConfig: { defaults: {}, instances: { dev: { working_directory: "/tmp" }, win: WINDOWS } },
    classicChannels: { getAll: () => [] },
    saveFleetConfig: vi.fn(),
    lifecycle: { handleCreate: vi.fn().mockResolvedValue(undefined), handleReplace: vi.fn().mockResolvedValue(undefined) },
    getWorldForInstance: vi.fn(),
    dataDir: "/tmp/fake",
    adapters: new Map(),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  } as any;
}
async function call(c: any, tool: string, args: Record<string, unknown>) {
  let result: unknown, error: string | null | undefined;
  await outboundHandlers.get(tool)!(c, args, (r, e) => { result = r; error = e; }, META);
  return { result, error };
}

describe("M-2239 P1-1: no MCP path creates or configures a Windows agent", () => {
  it.each([
    [{ runtime: "windows", topic_name: "Native" }],
    [{ runtime: "windows", directory: "C:\\", sandbox: "workspace-write", backend: "codex", topic_name: "Root" }],
    [{ topic_name: "Linux", sandbox: "read-only" }],
  ])("create_instance refuses %j before validation or the lifecycle", async args => {
    const c = ctx();
    const { error } = await call(c, "create_instance", args);
    expect(error).toBe(WINDOWS_CREATE_REFUSED);
    expect(c.lifecycle.handleCreate).not.toHaveBeenCalled();
  });

  it("create_instance still creates a Linux agent, an explicit wsl runtime included", async () => {
    for (const args of [{ topic_name: "Linux" }, { topic_name: "Linux", runtime: "wsl" }]) {
      const c = ctx();
      await call(c, "create_instance", args);
      expect(c.lifecycle.handleCreate).toHaveBeenCalledOnce();
    }
  });

  it("the MCP schema no longer offers runtime or sandbox", () => {
    expect(Object.keys(CreateInstanceArgs.shape)).not.toContain("runtime");
    expect(Object.keys(CreateInstanceArgs.shape)).not.toContain("sandbox");
    expect(JSON.stringify(CreateInstanceArgs.shape.backend.description)).not.toMatch(/Windows/);
  });

  it("handleCreate refuses the Windows runtime whoever calls it (deploy_template's path too), touching nothing", async () => {
    const create = vi.fn();
    const lifecycleCtx = { fleetConfig: { instances: {}, defaults: {} }, isPlannedRestart: () => false, nativeInstanceRuntime: () => ({ create }),
      getInstanceDir: vi.fn(() => { throw new Error("Linux instance directory must not be touched"); }) } as unknown as LifecycleContext;
    const respond = vi.fn();
    await new InstanceLifecycle(lifecycleCtx).handleCreate({ runtime: "windows", topic_name: "Native", directory: "C:\\Work" }, respond);
    expect(respond).toHaveBeenCalledWith(null, WINDOWS_CREATE_REFUSED);
    expect(create).not.toHaveBeenCalled();
    expect(lifecycleCtx.getInstanceDir).not.toHaveBeenCalled();
  });

  it("update_instance_config and replace_instance refuse a Windows target; a Linux one goes on", async () => {
    const c = ctx();
    const update = await call(c, "update_instance_config", { name: "win", config: { backend: "grok", model: "x" } });
    expect(update.error).toBe(WINDOWS_CONFIG_REFUSED);
    expect(c.fleetConfig.instances.win).toEqual(WINDOWS);
    expect(c.saveFleetConfig).not.toHaveBeenCalled();
    const replace = await call(c, "replace_instance", { name: "win" });
    expect(replace.error).toBe(WINDOWS_CONFIG_REFUSED);
    expect(c.lifecycle.handleReplace).not.toHaveBeenCalled();
    await call(c, "replace_instance", { name: "dev" });
    expect(c.lifecycle.handleReplace).toHaveBeenCalledOnce();
  });
});
