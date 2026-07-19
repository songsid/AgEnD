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
