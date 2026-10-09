/**
 * #814: update_instance_config now accepts tool_set.
 *
 * Tests:
 * - accepted valid values
 * - rejected invalid value
 * - persisted to the instance config
 */
import { describe, expect, it, vi } from "vitest";
import { outboundHandlers } from "../src/outbound-handlers.js";

function context(instance: Record<string, unknown> = {}) {
  return {
    fleetConfig: {
      defaults: {},
      instances: { worker: instance },
    },
    classicChannels: { getAll: () => [] },
    saveFleetConfig: vi.fn(),
    dataDir: "/tmp/fake-data-dir",
  } as any;
}

async function update(ctx: any, config: Record<string, unknown>) {
  let result: unknown;
  let error: string | null | undefined;
  await outboundHandlers.get("update_instance_config")!(
    ctx,
    { name: "worker", config },
    (value, message) => { result = value; error = message; },
    {} as any,
  );
  return { result, error };
}

describe("update_instance_config — tool_set (#814)", () => {
  it("accepts all valid tool_set values", async () => {
    const validValues = ["full", "standard", "worker", "coordinator", "minimal", "general"] as const;
    for (const tool_set of validValues) {
      const instance: Record<string, unknown> = {};
      const ctx = context(instance);
      const { result, error } = await update(ctx, { tool_set });
      expect(error, `tool_set="${tool_set}" should be accepted`).toBeUndefined();
      expect(result, `tool_set="${tool_set}" should succeed`).toMatchObject({ success: true });
    }
  });

  it("persists tool_set to the instance config", async () => {
    const instance: Record<string, unknown> = {};
    const ctx = context(instance);
    const { result, error } = await update(ctx, { tool_set: "coordinator" });
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ success: true, applied: { tool_set: "coordinator" } });
    expect(instance.tool_set).toBe("coordinator");
    expect(ctx.saveFleetConfig).toHaveBeenCalledOnce();
  });

  it("rejects an invalid tool_set value", async () => {
    const instance: Record<string, unknown> = {};
    const ctx = context(instance);
    const { result, error } = await update(ctx, { tool_set: "super-admin" });
    expect(result).toBeNull();
    expect(error).toMatch(/tool_set|invalid/i);
    // Instance must not be mutated on rejection
    expect(instance.tool_set).toBeUndefined();
    expect(ctx.saveFleetConfig).not.toHaveBeenCalled();
  });

  it("can update tool_set alongside other fields", async () => {
    const instance: Record<string, unknown> = { model: "claude-opus" };
    const ctx = context(instance);
    const { error } = await update(ctx, { tool_set: "minimal", display_name: "Worker" });
    expect(error).toBeUndefined();
    expect(instance.tool_set).toBe("minimal");
    expect(instance.display_name).toBe("Worker");
  });
});
