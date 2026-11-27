// M-3694 (S-263): General sets another agent's reasoning effort through update_instance_config {effort} — the agent's
// Settings page's and /effort's own path (FleetManager.applyEffort: clamped, saved, switched or restarted). Alone, or
// with a backend switch (its launch check); never mixed with other fields, and never the caller's own effort.
import { describe, expect, it, vi } from "vitest";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { UpdateInstanceConfigArgs } from "../src/outbound-schemas.js";

function rig() {
  const applyEffort = vi.fn(async (name: string, level: string) => `${name} now runs at ${level}.`);
  const ctx: any = { fleetConfig: { defaults: {}, instances: { general: { general_topic: true }, worker: { backend: "claude-code" } } }, classicChannels: { getAll: () => [] }, applyEffort };
  const call = (name: string, config: Record<string, unknown>, caller = "general") => new Promise<{ result: unknown; error?: string }>(resolve => {
    void outboundHandlers.get("update_instance_config")!(ctx, { name, config } as never, (result, error) => resolve({ result, error }), { instanceName: caller } as never);
  });
  return { ctx, applyEffort, call };
}

describe("M-3694 S-263: update_instance_config {effort}", () => {
  it("alone: through applyEffort (Settings' and /effort's path), its own words back", async () => {
    const r = rig();
    expect(await r.call("worker", { effort: "low" })).toEqual({ result: { success: true, name: "worker", effort: "low", result: "worker now runs at low." }, error: undefined });
    expect(r.applyEffort).toHaveBeenCalledWith("worker", "low");
  });

  it("never the caller's own effort (a restart would end the turn asking)", async () => {
    const r = rig();
    expect((await r.call("general", { effort: "high" })).error).toBe("Not changed: an agent doesn't set its own effort (a restart would end this turn). The person sets it in Settings, or with /effort in its topic.");
    expect(r.applyEffort).not.toHaveBeenCalled();
  });

  it("mixed with other fields: refused, nothing changed; with a backend switch it rides the switch (no applyEffort)", async () => {
    const r = rig();
    expect((await r.call("worker", { effort: "low", model: "opus" })).error).toBe("Set effort in its own update_instance_config call (or together with a backend switch).");
    expect(r.applyEffort).not.toHaveBeenCalled();
    expect(r.ctx.fleetConfig.instances.worker).toEqual({ backend: "claude-code" });
    await r.call("worker", { backend: "codex", effort: "low" });
    expect(r.applyEffort).not.toHaveBeenCalled();
  });

  it("only a level AgEnD knows", () => {
    expect(UpdateInstanceConfigArgs.safeParse({ name: "worker", config: { effort: "turbo" } }).success).toBe(false);
    expect(UpdateInstanceConfigArgs.safeParse({ name: "worker", config: { effort: "xhigh" } }).success).toBe(true);
  });
});
