/**
 * #814 decision (2026-10-09): update_instance_config must REFUSE any patch
 * that includes tool_set. This is a privilege boundary (#804/#814): only an
 * administrator via Settings or fleet.yaml may change the tool-permission
 * profile.
 *
 * Tests:
 * - call with tool_set is refused, fleet.yaml unchanged
 * - call without tool_set succeeds as normal (no regression)
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

describe("update_instance_config — tool_set (#814 privilege boundary)", () => {
  it.each(["full", "standard", "worker", "coordinator", "minimal"])(
    "refuses tool_set=%s with a privilege-boundary error",
    async (tool_set) => {
      const instance: Record<string, unknown> = {};
      const ctx = context(instance);
      const { result, error } = await update(ctx, { tool_set });
      expect(result).toBeNull();
      expect(error, `tool_set="${tool_set}" must be refused`).toMatch(
        /tool_set.*Settings.*fleet\.yaml|privilege boundary/i,
      );
      // Nothing must be written to the config or saved.
      expect(instance.tool_set).toBeUndefined();
      expect(ctx.saveFleetConfig).not.toHaveBeenCalled();
    },
  );

  it("refuses with the canonical error message (#804/#814 cited)", async () => {
    const ctx = context({});
    const { error } = await update(ctx, { tool_set: "coordinator" });
    expect(error).toContain("Settings or fleet.yaml");
    expect(error).toContain("#804");
    expect(error).toContain("#814");
  });

  it("a call without tool_set still updates other fields (no regression)", async () => {
    const instance: Record<string, unknown> = { model: "claude-opus" };
    const ctx = context(instance);
    const { result, error } = await update(ctx, { display_name: "Worker", model: "gpt-4o" });
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ success: true });
    expect(instance.display_name).toBe("Worker");
    expect(instance.model).toBe("gpt-4o");
    expect(ctx.saveFleetConfig).toHaveBeenCalledOnce();
  });
});
