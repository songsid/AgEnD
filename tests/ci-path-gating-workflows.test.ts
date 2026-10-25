/**
 * Workflow contracts for CI path gating: jobs always run (no job-level `if:`
 * on matrix or required names), and heavy steps key off detect-changes flags.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const load = (rel: string) => yaml.load(readFileSync(join(ROOT, rel), "utf8")) as {
  jobs: Record<string, {
    if?: string;
    needs?: string | string[];
    steps: Array<{ id?: string; name?: string; if?: string; run?: string; uses?: string }>;
  }>;
};

describe("CI path-gating workflow contracts", () => {
  it("matrix and always-run jobs have no job-level if (a skip would leave required names pending)", () => {
    const ci = load(".github/workflows/ci.yml");
    for (const id of [
      "detect-changes", "changelog", "actions-pinned", "setup", "test-shard",
      "test-integration", "docs-tests", "install-smoke", "node20-rollback-smoke",
    ]) {
      expect(ci.jobs[id].if, id).toBeUndefined();
    }
    expect(ci.jobs.build.if).toBe("always()");
  });

  it("install-smoke and node20-rollback-smoke heavy steps gate on packaging", () => {
    const ci = load(".github/workflows/ci.yml");
    const smoke = ci.jobs["install-smoke"];
    expect(smoke.needs).toContain("detect-changes");
    const pack = smoke.steps.find(s => s.name === "Pack and install globally");
    expect(pack?.if).toBe("needs.detect-changes.outputs.packaging == 'true'");
    const node = smoke.steps.find(s => typeof s.uses === "string" && s.uses.startsWith("actions/setup-node"));
    expect(node?.if).toBe("needs.detect-changes.outputs.packaging == 'true'");

    const rollback = ci.jobs["node20-rollback-smoke"];
    expect(rollback.needs).toContain("detect-changes");
    const heavy = rollback.steps.filter(s => s.if === "needs.detect-changes.outputs.packaging == 'true'");
    expect(heavy.length).toBeGreaterThanOrEqual(4);
    expect(rollback.steps.some(s => s.if === "needs.detect-changes.outputs.packaging != 'true'")).toBe(true);
  });

  it("docs-tests runs the list file only when text-only", () => {
    const ci = load(".github/workflows/ci.yml");
    const job = ci.jobs["docs-tests"];
    const run = job.steps.find(s => s.name === "Run tests that read docs");
    expect(run?.if).toBe("needs.detect-changes.outputs.text-only == 'true'");
    expect(run?.run).toContain("scripts/ci/docs-reading-tests.txt");
    expect(run?.run).toContain('npx vitest run "${files[@]}"');
    expect(run?.run).not.toContain("npx vitest run --");
    expect(run?.run).toContain("${#files[@]} -eq 0");
  });

  it("setup, shards and integration skip heavy work on text-only without a job-level if", () => {
    const ci = load(".github/workflows/ci.yml");
    expect(ci.jobs.setup.steps.some(s => s.if === "needs.detect-changes.outputs.text-only != 'true'")).toBe(true);
    expect(ci.jobs["test-shard"].steps.some(s => s.if === "needs.detect-changes.outputs.text-only != 'true'")).toBe(true);
    expect(ci.jobs["test-integration"].steps.some(s => s.if === "needs.detect-changes.outputs.text-only != 'true'")).toBe(true);
  });

  it("npm-audit-signatures real steps gate on deps; the job always runs", () => {
    const wf = load(".github/workflows/npm-audit-signatures.yml");
    expect(wf.jobs.signatures.if).toBeUndefined();
    const classify = wf.jobs.signatures.steps.find(s => s.id === "changes");
    expect(classify?.run).toContain("scripts/ci/detect-changes.sh");
    const real = wf.jobs.signatures.steps.filter(s => s.if === "steps.changes.outputs.deps == 'true'");
    expect(real.length).toBeGreaterThanOrEqual(4);
    expect(wf.jobs.signatures.steps.some(s => s.if === "steps.changes.outputs.deps != 'true'")).toBe(true);
  });

  it("dependency-review real step gates on deps; the job always runs", () => {
    const wf = load(".github/workflows/dependency-review.yml");
    expect(wf.jobs["dependency-review"].if).toBeUndefined();
    const action = wf.jobs["dependency-review"].steps.find(
      s => typeof s.uses === "string" && s.uses.startsWith("actions/dependency-review-action"),
    );
    expect(action?.if).toBe("steps.changes.outputs.deps == 'true'");
  });

  it("data-downgrade real steps gate on src; the job always runs", () => {
    const wf = load(".github/workflows/data-downgrade.yml");
    expect(wf.jobs["data-downgrade"].if).toBeUndefined();
    const steps = wf.jobs["data-downgrade"].steps;
    expect(steps.some(s => s.id === "changes" && String(s.run).includes("detect-changes.sh"))).toBe(true);
    expect(steps.some(s => s.if === "steps.changes.outputs.src != 'true'")).toBe(true);
    const heavy = steps.filter(s => s.if && s.if.includes("src == 'true'"));
    expect(heavy.length).toBeGreaterThanOrEqual(8);
  });
});
