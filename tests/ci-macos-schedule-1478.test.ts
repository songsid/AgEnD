import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

type Job = { "runs-on": string; needs?: string[]; if?: string;
  strategy?: { matrix: { os: string; node?: string[]; npm?: string[] } };
  steps: { name?: string; run?: string }[] };
type Workflow = { on: Record<string, any>; concurrency: { group: string; "cancel-in-progress": string }; jobs: Record<string, Job> };
const root = join(import.meta.dirname, "..");
const load = (file: string) => yaml.load(readFileSync(join(root, ".github/workflows", file), "utf8")) as Workflow;
const workflows = [
  ["ci.yml", "install-smoke"],
  ["npm-rollback-proof.yml", "rollback"],
] as const;

// These checked-in expressions use only the JS-compatible Actions subset:
// strings, ==, &&, ||, property access, fromJSON and startsWith. This is not a
// general Actions emulator. Real PR CI also verifies the selected runner jobs.
function evaluate(expression: string, event: string, ref = "refs/heads/main") {
  expect(expression).toMatch(/^\$\{\{[\s\S]*\}\}$/);
  const source = expression.slice(3, -2).trim();
  const github = { event_name: event, ref, workflow: "test", event: { pull_request: { number: 42 } } };
  return new Function("github", "fromJSON", "startsWith", `return (${source});`)(
    github, JSON.parse, (a: string, b: string) => a.toLowerCase().startsWith(b.toLowerCase()),
  );
}

describe.each(workflows)("%s deferred macOS runner selection", (file, jobId) => {
  const workflow = load(file);
  const job = workflow.jobs[jobId];
  it.each([
    ["pull_request", "refs/pull/42/merge", ["ubuntu-latest"]],
    ["push", "refs/heads/main", ["ubuntu-latest"]],
    ["push", "refs/heads/release/2.1", ["ubuntu-latest"]],
    ["push", "refs/tags/v2.2.0", ["ubuntu-latest", "macos-latest"]],
    ["push", "refs/tags/v2.2.0-beta.1", ["ubuntu-latest", "macos-latest"]],
    ["push", "refs/tags/not-a-release", ["ubuntu-latest"]],
    ["workflow_dispatch", "refs/heads/main", ["ubuntu-latest", "macos-latest"]],
    ["schedule", "refs/heads/main", ["ubuntu-latest", "macos-latest"]],
  ])("%s / %s creates exactly the intended OS cells", (event, ref, expected) => {
    expect(evaluate(job.strategy!.matrix.os, event as string, ref as string)).toEqual(expected);
    expect(job.if).toBeUndefined(); // optional Mac cells are absent, not skipped
    expect(job["runs-on"]).toBe("${{ matrix.os }}");
  });
  it("retains explicit tag, manual and weekly triggers", () => {
    expect(workflow.on.push.tags).toContain("v*");
    expect(workflow.on.push.branches).toContain("main");
    expect(Object.hasOwn(workflow.on, "pull_request")).toBe(true);
    expect(Object.hasOwn(workflow.on, "workflow_dispatch")).toBe(true);
    expect(Array.isArray(workflow.on.schedule)).toBe(true);
    expect(workflow.on.schedule).toHaveLength(1);
    const fields = workflow.on.schedule[0].cron.split(" ");
    expect(fields).toHaveLength(5);
    expect(fields.slice(2, 4)).toEqual(["*", "*"]);
    expect(fields[4]).toMatch(/^[0-6]$/); // one day a week, not every day
  });
});

describe("CI admission and cancellation", () => {
  it.each(["ci.yml", "data-downgrade.yml", "gitleaks.yml", "npm-rollback-proof.yml"])("%s cancels only superseded PR runs", file => {
    const concurrency = load(file).concurrency;
    expect(concurrency.group).toContain("github.event.pull_request.number || github.ref");
    expect(evaluate(concurrency["cancel-in-progress"], "pull_request")).toBe(true);
    for (const event of ["push", "schedule", "workflow_dispatch"]) {
      expect(evaluate(concurrency["cancel-in-progress"], event)).toBe(false);
    }
  });
  it("keeps data-downgrade Linux-only", () => {
    expect(Object.values(load("data-downgrade.yml").jobs).every(job => job["runs-on"] === "ubuntu-latest")).toBe(true);
  });
  it("retains every claimed Node/npm smoke cell", () => {
    expect(load("ci.yml").jobs["install-smoke"].strategy!.matrix.node).toEqual(["22.14.0", "22", "24", "26"]);
    expect(load("npm-rollback-proof.yml").jobs.rollback.strategy!.matrix.npm).toEqual(["9.9.4", "10.8.2", "11.6.2"]);
  });
  const ci = load("ci.yml");
  const aggregate = ci.jobs.build.steps.find(step => step.name === "Check all jobs succeeded")!;
  function runAggregate(result = "success") {
    return execFileSync("/bin/bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", aggregate.run!], {
      encoding: "utf8", env: { PATH: process.env.PATH, DOCS_ONLY: "false", CHANGELOG: "success",
        SETUP: "success", SHARD: "success", INTEGRATION: "success", SMOKE: result, ROLLBACK: "success" },
      stdio: "pipe",
    });
  }
  it("keeps the required build aggregate and strict Linux smoke result", () => {
    expect(ci.jobs.build.if).toBe("always()");
    expect(ci.jobs.build.needs).toContain("install-smoke");
    expect(runAggregate()).toContain("All jobs succeeded.");
  });
  it.each(["failure", "cancelled", "skipped", "", "unknown"])("a %s Linux smoke cannot make build green", result => {
    expect(() => runAggregate(result)).toThrow();
  });
});
