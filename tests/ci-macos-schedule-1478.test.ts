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
    ["pull_request", "refs/pull/42/merge", ["ubuntu-24.04"]],
    ["push", "refs/heads/main", ["ubuntu-24.04"]],
    ["push", "refs/heads/release/2.1", ["ubuntu-24.04"]],
    ["push", "refs/tags/v2.2.0", ["ubuntu-24.04", "ubuntu-26.04", "macos-latest"]],
    ["push", "refs/tags/v2.2.0-beta.1", ["ubuntu-24.04", "ubuntu-26.04", "macos-latest"]],
    ["push", "refs/tags/not-a-release", ["ubuntu-24.04"]],
    ["workflow_dispatch", "refs/heads/main", ["ubuntu-24.04", "ubuntu-26.04", "macos-latest"]],
    ["schedule", "refs/heads/main", ["ubuntu-24.04", "ubuntu-26.04", "macos-latest"]],
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
    expect(Object.values(load("data-downgrade.yml").jobs).every(job => job["runs-on"] === "ubuntu-24.04")).toBe(true);
  });
  it("retains every claimed Node/npm smoke cell", () => {
    expect(load("ci.yml").jobs["install-smoke"].strategy!.matrix.node).toEqual(["22.14.0", "22", "24", "26"]);
    expect(load("npm-rollback-proof.yml").jobs.rollback.strategy!.matrix.npm).toEqual(["10.9.9", "11.6.2"]);
  });
  const ci = load("ci.yml");
  const aggregate = ci.jobs.build.steps.find(step => step.name === "Check all jobs succeeded")!;
  function runAggregate(result = "success", extra: Record<string, string> = {}) {
    return execFileSync("/bin/bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", aggregate.run!], {
      encoding: "utf8", env: { PATH: process.env.PATH, CHANGELOG: "success",
        ACTIONS_PINNED: "success", SETUP: "success", SHARD: "success", INTEGRATION: "success",
        HUB_DIRECTORY: "success", PWSH: "success", DOCS_TESTS: "success", SMOKE: result, ROLLBACK: "success", ...extra },
      stdio: "pipe",
    });
  }
  it("keeps the required build aggregate and strict Linux smoke result", () => {
    expect(ci.jobs.build.if).toBe("always()");
    expect(ci.jobs.build.needs).toContain("install-smoke");
    expect(ci.jobs.build.needs).toContain("actions-pinned");
    expect(runAggregate()).toContain("All jobs succeeded.");
  });
  it.each(["failure", "cancelled", "skipped", ""])("a %s hub-directory rig job cannot make build green", result => {
    expect(() => runAggregate("success", { HUB_DIRECTORY: result })).toThrow();
  });
  it.each(["failure", "cancelled", "skipped", "", "unknown"])("a %s Linux smoke cannot make build green", result => {
    expect(() => runAggregate(result)).toThrow();
  });
  it("a failed SHA-pin guard cannot make build green, even for docs-only", () => {
    expect(() => runAggregate("success", { DOCS_ONLY: "true", ACTIONS_PINNED: "failure" })).toThrow();
  });
});

// The Linux release matrix uses exactly the same event boundary as deferred Mac cells.
describe.each(["test-shard", "test-integration"])("%s supported Ubuntu matrix", jobId => {
  const job = load("ci.yml").jobs[jobId];
  it.each([
    ["pull_request", "refs/pull/42/merge", ["ubuntu-24.04"]],
    ["push", "refs/heads/main", ["ubuntu-24.04"]],
    ["push", "refs/heads/release/2.3.5-alpha", ["ubuntu-24.04"]],
    ["push", "refs/tags/v2.3.4", ["ubuntu-24.04", "ubuntu-26.04"]],
    ["workflow_dispatch", "refs/heads/test", ["ubuntu-24.04", "ubuntu-26.04"]],
    ["schedule", "refs/heads/main", ["ubuntu-24.04", "ubuntu-26.04"]],
  ])("%s uses only the supported Ubuntu cells", (event, ref, expected) => {
    expect(evaluate(job.strategy!.matrix.os, event as string, ref as string)).toEqual(expected);
    expect(job["runs-on"]).toBe("${{ matrix.os }}");
    expect(job.if).toBeUndefined();
  });
});

// Workflow titles and explicit aggregate verdicts remain stable for protection rules.
describe.each([
  ['data-downgrade.yml', 'Data downgrade compatibility', 'data-downgrade'],
  ['npm-rollback-proof.yml', 'npm rollback proof', 'rollback'],
])('%s required verdict', (file, name, dependency) => {
  const wf = load(file) as Workflow & {name: string};
  const job = wf.jobs.verdict as Job & {name: string};
  it('retains the public check name and always evaluates the entire proof', () => {
    expect(wf.name).toBe(name);
    expect(job.name).toBe(name);
    expect(job.needs).toEqual([dependency]);
    expect(job.if).toBe('always()');
  });
  it.each(['success', 'failure', 'cancelled', 'skipped', ''])('reports %s truthfully', result => {
    const execute = () => execFileSync('/bin/bash', ['-eo', 'pipefail', '-c', job.steps[0].run!], {
      env: {PATH: process.env.PATH, RESULT: result}, stdio: 'pipe',
    });
    if (result === 'success') expect(execute).not.toThrow();
    else expect(execute).toThrow();
  });
});
