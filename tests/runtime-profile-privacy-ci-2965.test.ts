import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import yaml from "js-yaml";
import { expect, it } from "vitest";
type Step = { uses?: string; name?: string; run?: string; shell?: string; with?: Record<string, string> };
type Job = { if?: string; "runs-on": string; "timeout-minutes"?: number; needs?: string[]; steps: Step[] };
const ci = yaml.load(readFileSync(".github/workflows/ci.yml", "utf8")) as { jobs: Record<string, Job> };
const gate = ci.jobs.build.steps.find(s => s.name === "Check all jobs succeeded")!;
function aggregate(result: string, required: boolean) {
  return execFileSync("/bin/bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", gate.run!], {
    encoding: "utf8", stdio: "pipe", env: { PATH: process.env.PATH, CHANGELOG: "success", ACTIONS_PINNED: "success", SETUP: "success", SHARD: "success", INTEGRATION: "success", PWSH: "success", HUB_DIRECTORY: "success", DOCS_TESTS: "success", UI_GATE: "success", SMOKE: "success", ROLLBACK: "success", PROFILE_PRIVACY: result, PROFILE_PRIVACY_REQUIRED: String(required) },
  });
}
it("runs exact-head NTFS proof only on release PRs and branch pushes, with a short deadline and no install", () => {
  const job = ci.jobs["runtime-profile-privacy"]!;
  expect(job["runs-on"]).toBe("windows-latest"); expect(job["timeout-minutes"]).toBeLessThanOrEqual(5);
  expect(job.if).toBe("(github.event_name == 'pull_request' && startsWith(github.base_ref, 'release/')) || (github.event_name == 'push' && startsWith(github.ref, 'refs/heads/release/'))");
  expect(job.steps).toHaveLength(2); expect(job.steps[0]!.with?.ref).toBe("${{ github.event.pull_request.head.sha || github.sha }}");
  expect(job.steps[1]!.shell).toBe("powershell"); expect(job.steps[1]!.run).toContain("-PrivacyScript ./templates/runtime-assets/runtime-pane-private.ps1 -ScratchParent $env:TEMP -SharedScratchParent $env:RUNNER_TEMP");
  expect(job.steps[1]!.run).toContain("$personalTemp.StartsWith($userHome");
  expect(ci.jobs.build.needs).toContain("runtime-profile-privacy");
});
it.each(["failure", "cancelled", "skipped", "", "unknown"])("a required NTFS result of %s cannot make build green", result => {
  expect(() => aggregate(result, true)).toThrow();
});
it("accepts NTFS success and its deliberate skip outside release events", () => {
  expect(aggregate("success", true)).toContain("All jobs succeeded");
  expect(aggregate("skipped", false)).toContain("All jobs succeeded");
  expect(() => aggregate("failure", false)).toThrow();
});
