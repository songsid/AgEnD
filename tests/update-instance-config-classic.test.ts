import { describe, expect, it, vi } from "vitest";
import { outboundHandlers } from "../src/outbound-handlers.js";

function context(options: { classicName?: string; fleetInstance?: Record<string, unknown> } = {}) {
  return {
    fleetConfig: {
      defaults: {},
      instances: options.fleetInstance ? { worker: options.fleetInstance } : {},
    },
    classicChannels: {
      getAll: () => options.classicName ? [{
        instanceName: options.classicName,
        name: "Classic room",
        channelId: "room-1",
      }] : [],
    },
    saveFleetConfig: vi.fn(),
  } as any;
}

async function update(ctx: any, name: string, config: Record<string, unknown>) {
  let result: unknown;
  let error: string | null | undefined;
  await outboundHandlers.get("update_instance_config")!(
    ctx,
    { name, config },
    (value, message) => { result = value; error = message; },
    {} as any,
  );
  return { result, error };
}

describe("update_instance_config ClassicBot hint", () => {
  it("explains how to configure a ClassicBot instance", async () => {
    const ctx = context({ classicName: "classic-room" });

    const response = await update(ctx, "classic-room", { description: "new role" });

    expect(response).toEqual({
      result: null,
      error: "This is a ClassicBot instance (managed in classicBot.yaml). Use set_display_name or set_description to configure it.",
    });
    expect(ctx.saveFleetConfig).not.toHaveBeenCalled();
  });

  it("keeps applying fleet instance patches", async () => {
    const instance = { description: "old role" };
    const ctx = context({ fleetInstance: instance });

    const response = await update(ctx, "worker", { description: "new role" });

    expect(response).toEqual({
      result: { success: true, name: "worker", applied: { description: "new role" } },
      error: undefined,
    });
    expect(instance.description).toBe("new role");
    expect(ctx.saveFleetConfig).toHaveBeenCalledOnce();
  });

  it("keeps the generic error for an unknown instance", async () => {
    const ctx = context();

    const response = await update(ctx, "missing", { description: "new role" });

    expect(response).toEqual({
      result: null,
      error: "Instance 'missing' not found in fleet config",
    });
  });
});
