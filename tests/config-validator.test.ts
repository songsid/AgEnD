import { describe, expect, it } from "vitest";
import { validateFleetConfig } from "../src/config-validator.js";

describe("validateFleetConfig auto_pause_after", () => {
  const config = (value: unknown, at: "defaults" | "instance") => ({
    defaults: at === "defaults" ? { auto_pause_after: value } : {},
    instances: {
      worker: at === "instance"
        ? { working_directory: "/tmp/worker", auto_pause_after: value }
        : { working_directory: "/tmp/worker" },
    },
  });

  it.each([0, 0.5, 30])("accepts non-negative finite value %s", (value) => {
    expect(validateFleetConfig(config(value, "defaults")).errors).toEqual([]);
    expect(validateFleetConfig(config(value, "instance")).errors).toEqual([]);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "10", null])("rejects invalid value %s", (value) => {
    expect(validateFleetConfig(config(value, "defaults")).errors.some(e => e.path === "defaults.auto_pause_after")).toBe(true);
    expect(validateFleetConfig(config(value, "instance")).errors.some(e => e.path === "instances.worker.auto_pause_after")).toBe(true);
  });
});

describe("validateFleetConfig Settings Round 2 fields", () => {
  const base = {
    defaults: {},
    instances: { worker: { working_directory: "/tmp/worker" } },
  };

  it("accepts supported runtime, detection, and startup settings", () => {
    const result = validateFleetConfig({
      ...base,
      defaults: {
        agent_mode: "cli",
        tool_set: "minimal",
        log_level: "trace",
        hang_detector: { enabled: true, timeout_minutes: 8.5 },
        startup: { concurrency: 4, stagger_delay_ms: 250 },
      },
      instances: {
        worker: {
          working_directory: "/tmp/worker",
          agent_mode: "mcp",
          tool_set: "standard",
          log_level: "warn",
          lightweight: true,
          display_name: "Worker",
          model_failover: ["sonnet"],
          hang_detector: { timeout_minutes: 12 },
        },
      },
    });
    expect(result.errors).toEqual([]);
  });

  it.each([
    ["defaults.agent_mode", { agent_mode: "http" }],
    ["defaults.tool_set", { tool_set: "everything" }],
    ["defaults.log_level", { log_level: "verbose" }],
    ["defaults.hang_detector.timeout_minutes", { hang_detector: { timeout_minutes: 0 } }],
    ["defaults.startup.concurrency", { startup: { concurrency: 1.5 } }],
    ["defaults.startup.stagger_delay_ms", { startup: { stagger_delay_ms: -1 } }],
  ])("rejects invalid %s", (path, defaults) => {
    const result = validateFleetConfig({ ...base, defaults });
    expect(result.errors.some(e => e.path === path)).toBe(true);
  });

  it("validates editable channel access mode", () => {
    const result = validateFleetConfig({
      ...base,
      channels: [{ type: "discord", bot_token_env: "TOKEN", access: { mode: "paired", allowed_users: [] } }],
    });
    expect(result.errors.some(e => e.path === "channels[0].access.mode")).toBe(true);
  });
});
