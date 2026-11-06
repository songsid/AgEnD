import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { unitTestConfig } from "../vitest.config.js";
import { pwshTestConfig } from "../vitest.config.pwsh.js";
import { PWSH_CI_SUITES } from "./support/pwsh-ci-suites.js";
import { discoverPwshSuites } from "./support/pwsh-ci-discovery.js";

interface Job {
  if?: string; needs?: string[]; "runs-on"?: string;
  strategy?: { matrix: { os: string } };
  steps: Array<{ name?: string; if?: string; run?: string; env?: Record<string, string> }>;
}
const workflow = () => yaml.load(readFileSync(".github/workflows/ci.yml", "utf8")) as { jobs: Record<string, Job> };

describe("PowerShell CI resource partition", () => {
  it("covers every static pwsh launcher and transitive consumer, with no stale or duplicate paths", () => {
    expect(PWSH_CI_SUITES).toEqual([...new Set(PWSH_CI_SUITES)].sort());
    expect(PWSH_CI_SUITES.every(f => existsSync(f))).toBe(true);
    expect(PWSH_CI_SUITES).toEqual(discoverPwshSuites(process.cwd()));
  });
  it("preserves local coverage and partitions CI without dropping or duplicating a suite", () => {
    const normal = unitTestConfig("").test!;
    const unit = unitTestConfig("unit").test!;
    const pwsh = pwshTestConfig().test!;
    expect(pwsh.include).toEqual(PWSH_CI_SUITES);
    for (const file of PWSH_CI_SUITES) {
      expect(normal.exclude, file).not.toContain(file);
      expect(unit.exclude, file).toContain(file);
      expect(pwsh.exclude, file).not.toContain(file);
    }
    expect(unit.exclude?.filter(f => !normal.exclude?.includes(f))).toEqual(PWSH_CI_SUITES);
  });
  it("isolates startup from other test workers while retaining guards and all budgets", () => {
    const normal = unitTestConfig("").test!;
    const serial = pwshTestConfig().test!;
    expect(serial.fileParallelism).toBe(false);
    expect(serial.maxWorkers).toBe(1);
    expect(serial.testTimeout).toBe(10_000);
    expect(serial.hookTimeout).toBe(normal.hookTimeout);
    expect(serial.setupFiles).toEqual(normal.setupFiles);
    expect(serial.globalSetup).toEqual(normal.globalSetup);
    expect(serial.env).toEqual(normal.env);
    expect(serial.env?.AGEND_HOME).toBeTruthy();
    expect(serial.env?.NOTIFY_SOCKET).toBe("");
  });
  it("runs the partition on its own CI machine with the same release OS matrix", () => {
    const { jobs } = workflow();
    const shards = jobs["test-shard"]!;
    const serial = jobs["test-pwsh"]!;
    expect(serial.if).toBeUndefined();
    expect(serial.needs).toEqual(["detect-changes", "setup"]);
    expect(serial["runs-on"]).toBe(shards["runs-on"]);
    expect(serial.strategy?.matrix.os).toBe(shards.strategy?.matrix.os);
    const unit = shards.steps.find(s => s.name?.startsWith("Run test shard"));
    expect(unit?.env?.AGEND_CI_TEST_PARTITION).toBe("unit");
    const at = serial.steps.findIndex(s => s.name === "Run isolated installer tests");
    expect(at).toBeGreaterThan(-1);
    expect(serial.steps[at]?.if).toBe("needs.detect-changes.outputs.text-only != 'true'");
    expect(serial.steps[at]?.run).toContain("command -v pwsh");
    expect(serial.steps[at]?.run).toContain("npx vitest run --config vitest.config.pwsh.ts");
    // No extra pwsh process warms the cache before the actual test clock.
    expect(serial.steps.slice(0, at + 1).some(s => s.run?.includes("pwsh --version"))).toBe(false);
    expect(serial.steps.findIndex(s => s.name === "PowerShell version")).toBeGreaterThan(at);
    expect(jobs.build?.needs).toContain("test-pwsh");
  });
  it.each(["success", "failure", "cancelled", "skipped", ""])("the actual aggregate fails closed for installer result %j", result => {
    const step = workflow().jobs.build!.steps[0]!;
    expect(step.env?.PWSH).toBe("${{ needs.test-pwsh.result }}");
    const env = { ...process.env, ...Object.fromEntries(Object.keys(step.env!).map(k => [k, "success"])), PWSH: result };
    const run = spawnSync("bash", ["-c", step.run!], { env, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(result === "success" ? 0 : 1);
    if (result !== "success") expect(run.stderr).toContain("test-pwsh");
  });
});
