import { existsSync, readFileSync } from "node:fs";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { unitTestConfig } from "../vitest.config.js";
import { durableTestConfig } from "../vitest.config.durable.js";
import { DURABLE_CI_SUITES } from "./support/durable-ci-suites.js";
import { PWSH_CI_SUITES } from "./support/pwsh-ci-suites.js";

describe("durable CI fixture scheduling (M-3496)", () => {
  it("runs every present affected suite once, outside the parallel shards", () => {
    const affected = ["tests/fleet-manager.test.ts", "tests/hub-compose.test.ts", "tests/hub-directory-settings-decision.test.ts", "tests/hub-company-join-restart.test.ts", "src/delivery-outbox.test.ts"].filter(existsSync);
    expect(DURABLE_CI_SUITES).toEqual(affected);
    const local = unitTestConfig("").test!, shards = unitTestConfig("unit").test!, serial = durableTestConfig().test!;
    expect(serial.include).toEqual(DURABLE_CI_SUITES);
    expect(new Set(serial.include).size).toBe(DURABLE_CI_SUITES.length);
    for (const file of DURABLE_CI_SUITES) {
      expect(local.exclude).not.toContain(file);
      expect(shards.exclude).toContain(file);
      expect(serial.exclude).not.toContain(file);
      expect(PWSH_CI_SUITES).not.toContain(file);
    }
  });
  it("preserves guards, environment, real fixtures and original budgets without retries", () => {
    const local = unitTestConfig("").test!, serial = durableTestConfig().test!;
    expect(serial.fileParallelism).toBe(false);
    expect(serial.maxWorkers).toBe(1);
    expect(serial.testTimeout).toBe(10_000);
    expect(serial.hookTimeout).toBe(local.hookTimeout);
    expect(serial.retry).toBe(local.retry);
    expect(serial.setupFiles).toEqual(local.setupFiles);
    expect(serial.globalSetup).toEqual(local.globalSetup);
    expect(serial.env).toEqual(local.env);
  });
  it("runs the serial invocation once per OS, after this shard's unit workers have exited", () => {
    const wf = yaml.load(readFileSync(".github/workflows/ci.yml", "utf8")) as any;
    const steps = wf.jobs["test-shard"].steps;
    const slots = steps.filter((s: any) => s.name === "Run serial durable fixtures");
    expect(slots).toHaveLength(1);
    expect(slots[0].if).toBe("needs.detect-changes.outputs.text-only != 'true' && matrix.shard == 1");
    expect(slots[0].run).toBe("npx vitest run --config vitest.config.durable.ts");
    expect(slots[0]["continue-on-error"]).toBeUndefined();
    expect(steps.indexOf(slots[0])).toBeGreaterThan(steps.findIndex((s: any) => s.name?.startsWith("Run test shard")));
  });
});
