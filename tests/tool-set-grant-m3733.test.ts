/**
 * M-3733 (#4459 1A): any creator may pass tool_set up to its own profile.
 * full and general are never grantable by a non-General creator.
 *
 * Reverse mutation: removing toolSetGrantRefusal (or the handler/lifecycle
 * calls) lets tool_set full reach handleCreate or the saved config.
 * Inverting toolSetAboveCap (`<` to `<=`) refuses an equal profile, so
 * "a worker may set worker" and "a coordinator may set coordinator" go red.
 */
import { describe, expect, it, vi } from "vitest";
import { InstanceLifecycle } from "../src/instance-lifecycle.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import {
  TOOL_SET_RANK,
  effectiveGrantedToolSet,
  toolSetAboveCap,
  toolSetGrantCap,
  toolSetGrantRefusal,
  toolSetRank,
  type ToolSetName,
} from "../src/tool-permissions.js";

const ORDER: readonly ToolSetName[] = ["full", "general", "coordinator", "worker", "standard", "minimal"];

function ctxFor(instances: Record<string, Record<string, unknown>>, defaults: Record<string, unknown> = {}) {
  const fleetConfig = { defaults, instances, templates: {} as Record<string, unknown>, profiles: {} as Record<string, unknown>, teams: {} };
  const handleCreate = vi.fn(async (args: { tool_set?: string }, respond: (r: unknown) => void) => {
    fleetConfig.instances.made = { tool_set: args.tool_set };
    respond({ success: true, name: "made", status: "running" });
  });
  return {
    fleetConfig,
    classicChannels: { getAll: () => [] },
    saveFleetConfig: vi.fn(),
    lifecycle: { handleCreate, handleDelete: vi.fn(async (_a: unknown, respond: (r: unknown) => void) => respond({})) },
    getWorldForInstance: vi.fn(),
    dataDir: "/tmp/fake",
    adapters: new Map(),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    requestWindowsCreate: vi.fn(async () => ({ id: "pending-create", state: "pending" })),
    requestWindowsConfig: vi.fn(async () => ({ id: "pending-config", state: "pending" })),
  } as any;
}

async function call(ctx: any, tool: string, args: Record<string, unknown>, instanceName?: string) {
  let result: unknown;
  let error: string | undefined;
  await outboundHandlers.get(tool)!(ctx, args, (value, message) => { result = value; error = message; }, { instanceName } as any);
  return { result, error };
}

describe("tool set grant order (one definition)", () => {
  it("TOOL_SET_RANK is the only order, highest privilege first", () => {
    expect([...TOOL_SET_RANK]).toEqual([...ORDER]);
    ORDER.forEach((name, index) => expect(toolSetRank(name)).toBe(index));
  });

  it("collapses full and general to coordinator and leaves the rest as themselves", () => {
    expect(toolSetGrantCap("full")).toBe("coordinator");
    expect(toolSetGrantCap("general")).toBe("coordinator");
    expect(toolSetGrantCap("coordinator")).toBe("coordinator");
    expect(toolSetGrantCap("worker")).toBe("worker");
    expect(toolSetGrantCap("standard")).toBe("standard");
    expect(toolSetGrantCap("minimal")).toBe("minimal");
  });

  it("allows an equal profile and refuses one step above", () => {
    for (const name of ORDER) expect(toolSetAboveCap(name, name)).toBe(false);
    expect(toolSetAboveCap("coordinator", "worker")).toBe(true);
    expect(toolSetAboveCap("worker", "standard")).toBe(true);
    expect(toolSetAboveCap("standard", "worker")).toBe(false);
  });

  it("copies a recognized fleet default only when tool_set is omitted", () => {
    expect(effectiveGrantedToolSet(undefined, "full")).toBe("full");
    expect(effectiveGrantedToolSet("worker", "full")).toBe("worker");
    expect(effectiveGrantedToolSet(undefined, "nope")).toBe("worker");
    expect(effectiveGrantedToolSet("nope", "full")).toBe("worker");
  });

  it("names the cap for an over-cap grant and refuses an unidentified explicit profile", () => {
    expect(toolSetGrantRefusal({ caller: "coord", creator: "coordinator", explicit: "full", defaultsToolSet: undefined, isGeneral: false }))
      .toMatch(/above coord's cap[\s\S]*highest profile this agent can set is coordinator/);
    expect(toolSetGrantRefusal({ caller: "coord", creator: "coordinator", explicit: "coordinator", defaultsToolSet: undefined, isGeneral: false })).toBeNull();
    expect(toolSetGrantRefusal({ caller: "", creator: undefined, explicit: "worker", defaultsToolSet: undefined, isGeneral: false }))
      .toMatch(/Settings or fleet\.yaml/);
    expect(toolSetGrantRefusal({ caller: "admin", creator: "general", explicit: "full", defaultsToolSet: "full", isGeneral: true })).toBeNull();
  });
});

describe("create_instance cap (M-3733)", () => {
  const instances = {
    coord: { tool_set: "coordinator" },
    dev: {},
    wide: { tool_set: "full" },
    std: { tool_set: "standard" },
    mini: { tool_set: "minimal" },
    posed: { tool_set: "general" },
    admin: { general_topic: true },
  };

  it("lets a coordinator create coordinator and refuses full", async () => {
    const ctx = ctxFor(structuredClone(instances));
    const ok = await call(ctx, "create_instance", { topic_name: "child", tool_set: "coordinator" }, "coord");
    expect(ok.error).toBeUndefined();
    expect(ctx.lifecycle.handleCreate).toHaveBeenCalledOnce();
    ctx.lifecycle.handleCreate.mockClear();
    const over = await call(ctx, "create_instance", { topic_name: "child", tool_set: "full" }, "coord");
    expect(over.result).toBeNull();
    expect(over.error).toMatch(/above coord's cap[\s\S]*coordinator/);
    expect(ctx.lifecycle.handleCreate).not.toHaveBeenCalled();
  });

  it("lets a worker set worker, standard or minimal and refuses coordinator", async () => {
    for (const tool_set of ["worker", "standard", "minimal"]) {
      const ctx = ctxFor(structuredClone(instances));
      const out = await call(ctx, "create_instance", { topic_name: "child", tool_set }, "dev");
      expect(out.error, tool_set).toBeUndefined();
      expect(ctx.lifecycle.handleCreate).toHaveBeenCalledOnce();
    }
    const ctx = ctxFor(structuredClone(instances));
    const over = await call(ctx, "create_instance", { topic_name: "child", tool_set: "coordinator" }, "dev");
    expect(over.error).toMatch(/highest profile this agent can set is worker/);
    expect(ctx.lifecycle.handleCreate).not.toHaveBeenCalled();
  });

  it("caps a non-General full profile, and an explicit general profile, at coordinator", async () => {
    for (const caller of ["wide", "posed"]) {
      const ctx = ctxFor(structuredClone(instances));
      const ok = await call(ctx, "create_instance", { topic_name: "child", tool_set: "coordinator" }, caller);
      expect(ok.error, caller).toBeUndefined();
      const over = await call(ctx, "create_instance", { topic_name: "child", tool_set: "full" }, caller);
      expect(over.error, caller).toMatch(/highest profile this agent can set is coordinator/);
      const role = await call(ctx, "create_instance", { topic_name: "child", tool_set: "general" }, caller);
      expect(role.error, caller).toMatch(/"general" is above/);
      expect(ctx.lifecycle.handleCreate).toHaveBeenCalledOnce();
    }
  });

  it("lets a standard creator set standard and refuses worker", async () => {
    const ctx = ctxFor(structuredClone(instances));
    expect((await call(ctx, "create_instance", { topic_name: "child", tool_set: "standard" }, "std")).error).toBeUndefined();
    const over = await call(ctx, "create_instance", { topic_name: "child", tool_set: "worker" }, "std");
    expect(over.error).toMatch(/highest profile this agent can set is standard/);
  });

  it("lets General set full and still refuses skipPermissions for General and a coordinator", async () => {
    const ctx = ctxFor(structuredClone(instances));
    expect((await call(ctx, "create_instance", { topic_name: "child", tool_set: "full" }, "admin")).error).toBeUndefined();
    expect(ctx.lifecycle.handleCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ tool_set: "full" }), expect.any(Function), undefined, undefined, "admin", "admin",
    );
    for (const caller of ["admin", "coord"]) {
      const out = await call(ctx, "create_instance", { topic_name: "child", skipPermissions: true }, caller);
      expect(out.result).toBeNull();
      expect(out.error).toMatch(/skipPermissions.*#804\/#814/);
    }
    expect(ctx.lifecycle.handleCreate).toHaveBeenCalledOnce();
  });

  it("refuses an omitted tool_set when the fleet default is above the cap, and names a typo against the cap", async () => {
    const ctx = ctxFor(structuredClone(instances), { tool_set: "full" });
    const omitted = await call(ctx, "create_instance", { topic_name: "child" }, "coord");
    expect(omitted.error).toMatch(/"full" is above coord's cap[\s\S]*coordinator/);
    expect(ctx.lifecycle.handleCreate).not.toHaveBeenCalled();
    const typo = await call(ctx, "create_instance", { topic_name: "child", tool_set: "nope" }, "mini");
    expect(typo.error).toMatch(/"nope" is not a profile[\s\S]*minimal/);
    expect(ctx.lifecycle.handleCreate).not.toHaveBeenCalled();
  });

  it("fail-closes an unidentified caller on any explicit profile or an elevated default, and allows a plain worker create", async () => {
    const explicit = await call(ctxFor(structuredClone(instances)), "create_instance", { topic_name: "child", tool_set: "worker" });
    expect(explicit.error).toMatch(/identified agent[\s\S]*Settings or fleet\.yaml[\s\S]*#804\/#814/);
    const elevated = await call(ctxFor(structuredClone(instances), { tool_set: "full" }), "create_instance", { topic_name: "child" });
    expect(elevated.error).toMatch(/Settings or fleet\.yaml/);
    const plainCtx = ctxFor(structuredClone(instances));
    const plain = await call(plainCtx, "create_instance", { topic_name: "child" });
    expect(plain.error).toBeUndefined();
    expect(plain.result).toMatchObject({ success: true, name: "made" });
    expect(plainCtx.lifecycle.handleCreate).toHaveBeenCalledOnce();
  });

  it("keeps a Windows create request ahead of the cap", async () => {
    const ctx = ctxFor(structuredClone(instances), { tool_set: "full" });
    const withSet = await call(ctx, "create_instance", { runtime: "windows", topic_name: "native", tool_set: "worker" }, "coord");
    expect(withSet.error).toMatch(/Windows agent's tool_set/);
    expect(ctx.requestWindowsCreate).not.toHaveBeenCalled();
    const pending = await call(ctx, "create_instance", { runtime: "windows", topic_name: "native" }, "coord");
    expect(pending.error).toBeUndefined();
    expect(pending.result).toMatchObject({ state: "pending" });
    expect(ctx.requestWindowsCreate).toHaveBeenCalledOnce();
    expect(ctx.lifecycle.handleCreate).not.toHaveBeenCalled();
  });
});

describe("update_instance_config cap (M-3733)", () => {
  function fleet() {
    return ctxFor({
      coord: { tool_set: "coordinator" },
      dev: { tool_set: "worker" },
      admin: { general_topic: true },
      win: { runtime: "windows", tool_set: "worker" },
    });
  }

  it("lets a coordinator set a worker to coordinator and refuses full and its own profile", async () => {
    const ctx = fleet();
    const ok = await call(ctx, "update_instance_config", { name: "dev", config: { tool_set: "coordinator" } }, "coord");
    expect(ok.error).toBeUndefined();
    expect(ctx.fleetConfig.instances.dev.tool_set).toBe("coordinator");
    expect(ctx.saveFleetConfig).toHaveBeenCalledOnce();
    const over = await call(ctx, "update_instance_config", { name: "dev", config: { tool_set: "full" } }, "coord");
    expect(over.error).toMatch(/highest profile this agent can set is coordinator/);
    expect(ctx.fleetConfig.instances.dev.tool_set).toBe("coordinator");
    const self = await call(ctx, "update_instance_config", { name: "coord", config: { tool_set: "worker" } }, "coord");
    expect(self.error).toMatch(/own tool_set.*#804\/#814/);
    expect(ctx.saveFleetConfig).toHaveBeenCalledOnce();
  });

  it("lets General set full and refuses skipPermissions for General and a coordinator", async () => {
    const ctx = fleet();
    expect((await call(ctx, "update_instance_config", { name: "dev", config: { tool_set: "full" } }, "admin")).error).toBeUndefined();
    expect(ctx.fleetConfig.instances.dev.tool_set).toBe("full");
    for (const caller of ["admin", "coord"]) {
      const out = await call(ctx, "update_instance_config", { name: "dev", config: { skipPermissions: true } }, caller);
      expect(out.error).toMatch(/skipPermissions.*#804\/#814/);
    }
    expect(ctx.fleetConfig.instances.dev.skipPermissions).toBeUndefined();
  });

  it("names the cap before the Windows refusal, and still refuses an in-cap tool_set on a Windows agent", async () => {
    const ctx = fleet();
    const over = await call(ctx, "update_instance_config", { name: "win", config: { tool_set: "full" } }, "coord");
    expect(over.error).toMatch(/highest profile this agent can set is coordinator/);
    expect(over.error).not.toMatch(/Windows/);
    const inside = await call(ctx, "update_instance_config", { name: "win", config: { tool_set: "worker" } }, "coord");
    expect(inside.error).toMatch(/Windows agent's tool_set/);
    expect(ctx.fleetConfig.instances.win.tool_set).toBe("worker");
    expect(ctx.saveFleetConfig).not.toHaveBeenCalled();
  });
});

describe("deploy_template cap (M-3733)", () => {
  const dir = "/tmp/agend-m3733-deploy";

  function deployCtx(callerToolSet: string, instanceToolSet: unknown, defaults: Record<string, unknown> = {}, general = false) {
    const ctx = ctxFor({
      coord: general ? { general_topic: true } : { tool_set: callerToolSet },
    }, defaults);
    ctx.fleetConfig.templates.pack = { instances: { role: instanceToolSet === undefined ? {} : { tool_set: instanceToolSet } } };
    ctx.fleetConfig.profiles.lead = { tool_set: "full" };
    return ctx;
  }

  it("refuses a template tool_set of full from a coordinator and allows coordinator", async () => {
    const refused = deployCtx("coordinator", "full");
    const over = await call(refused, "deploy_template", { template: "pack", directory: dir }, "coord");
    expect(over.result).toBeNull();
    expect(over.error).toMatch(/role "role"[\s\S]*highest profile this agent can set is coordinator/);
    expect(refused.lifecycle.handleCreate).not.toHaveBeenCalled();
    const allowed = deployCtx("coordinator", "coordinator");
    const ok = await call(allowed, "deploy_template", { template: "pack", directory: dir }, "coord");
    expect(ok.error).toBeUndefined();
    expect(allowed.lifecycle.handleCreate).toHaveBeenCalledOnce();
    expect(allowed.lifecycle.handleCreate.mock.calls[0][0]).toMatchObject({ tool_set: "coordinator" });
  });

  it("applies the cap to a profile-copied tool_set and to an elevated fleet default", async () => {
    const ctx = ctxFor({ coord: { tool_set: "coordinator" } });
    ctx.fleetConfig.templates.pack = { instances: { role: { profile: "lead" } } };
    ctx.fleetConfig.profiles.lead = { tool_set: "full" };
    const over = await call(ctx, "deploy_template", { template: "pack", directory: dir }, "coord");
    expect(over.error).toMatch(/"full" is above coord's cap/);
    expect(ctx.lifecycle.handleCreate).not.toHaveBeenCalled();
    const elevated = deployCtx("coordinator", undefined, { tool_set: "full" });
    const omitted = await call(elevated, "deploy_template", { template: "pack", directory: dir }, "coord");
    expect(omitted.error).toMatch(/"full" is above coord's cap/);
    expect(elevated.lifecycle.handleCreate).not.toHaveBeenCalled();
  });

  it("does not newly refuse skipPermissions on a template, and General may deploy full", async () => {
    const ctx = deployCtx("coordinator", "worker");
    ctx.fleetConfig.templates.pack.instances.role.skipPermissions = true;
    const out = await call(ctx, "deploy_template", { template: "pack", directory: dir }, "coord");
    expect(out.error).toBeUndefined();
    expect(ctx.lifecycle.handleCreate.mock.calls[0][0]).toMatchObject({ tool_set: "worker", skipPermissions: true });
    const general = deployCtx("coordinator", "full", {}, true);
    const ok = await call(general, "deploy_template", { template: "pack", directory: dir }, "coord");
    expect(ok.error).toBeUndefined();
    expect(general.lifecycle.handleCreate.mock.calls[0][0]).toMatchObject({ tool_set: "full" });
  });
});

describe("handleCreate backstop (M-3733)", () => {
  function life(fleet: Record<string, unknown>) {
    const saveFleetConfig = vi.fn();
    const lifecycle = new InstanceLifecycle({
      fleetConfig: fleet,
      saveFleetConfig,
      dataDir: "/tmp/agend-m3733-life",
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      getInstanceDir: (name: string) => `/tmp/agend-m3733-life/${name}`,
    } as never);
    return { lifecycle, saveFleetConfig };
  }

  async function create(lifecycle: InstanceLifecycle, args: Record<string, unknown>, origin?: string, toolSetCaller?: string) {
    let result: unknown;
    let error: string | undefined;
    await lifecycle.handleCreate(args as never, (value, message) => { result = value; error = message; }, undefined, undefined, toolSetCaller, origin);
    return { result, error };
  }

  it("refuses a worker granting coordinator, and a fleet default of full, before any save", async () => {
    const { lifecycle, saveFleetConfig } = life({
      defaults: { tool_set: "full" },
      instances: { dev: { tool_set: "worker" } },
    });
    const explicit = await create(lifecycle, { topic_name: "child", tool_set: "coordinator" }, "dev");
    expect(explicit.result).toBeNull();
    expect(explicit.error).toMatch(/highest profile this agent can set is worker/);
    const omitted = await create(lifecycle, { topic_name: "child" }, "dev");
    expect(omitted.error).toMatch(/"full" is above dev's cap/);
    expect(saveFleetConfig).not.toHaveBeenCalled();
  });

  it("leaves a no-caller create uncapped, so Settings and the web can still write full", async () => {
    const { lifecycle, saveFleetConfig } = life({ defaults: {}, instances: {} });
    const out = await create(lifecycle, { directory: "/tmp/agend-m3733-missing", topic_name: "child", tool_set: "full" });
    expect(out.error).toMatch(/Directory does not exist/);
    expect(out.error).not.toMatch(/cap|privilege boundary/);
    expect(saveFleetConfig).not.toHaveBeenCalled();
  });
});
