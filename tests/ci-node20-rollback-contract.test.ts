/**
 * CI contract regression for node20-rollback-smoke (#1442 / #1441-A).
 *
 * P2 (Prism r2): node20-rollback-smoke declared `needs: setup` but referenced
 * `needs.detect-changes.outputs.docs-only`. GitHub only populates `needs`
 * context from direct dependencies; detect-changes was absent, so the value
 * was always empty and heavy steps always ran on docs-only PRs.
 *
 * Fix: `needs: [setup, detect-changes]`. This test catches a regression back
 * to the broken form and verifies the docs-only step condition uses the
 * correct output reference.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

const ROOT = join(import.meta.dirname ?? import.meta.url.replace(/\/[^/]+$/, ""), "..");
const ci = yaml.load(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf-8")) as {
  jobs: {
    "node20-rollback-smoke": {
      needs: string[];
      steps: Array<{ if?: string; name?: string }>;
    };
    "detect-changes": { outputs: Record<string, string> };
  };
};

const smoke = ci.jobs["node20-rollback-smoke"];

describe("node20-rollback-smoke CI contract", () => {
  it("has detect-changes as a direct dependency (not just setup)", () => {
    // GitHub's needs context only populates from direct deps.
    // If detect-changes is absent, needs.detect-changes.outputs.docs-only
    // is empty and != 'true' is always true → heavy steps always run.
    expect(smoke.needs).toContain("detect-changes");
    expect(smoke.needs).toContain("setup");
  });

  it("every heavy step references needs.detect-changes.outputs.docs-only", () => {
    // All steps that touch npm/install/rollback must be gated. Collect them
    // by presence of the expected condition (or absence meaning always-run,
    // which is fine for no-op steps that emit a message).
    const heavySteps = smoke.steps.filter(s =>
      s.name && /pack|rollback proof/i.test(s.name),
    );
    expect(heavySteps.length, "expected at least 2 heavy named steps").toBeGreaterThanOrEqual(2);
    for (const step of heavySteps) {
      expect(
        step.if,
        `step "${step.name}" must have a docs-only guard`,
      ).toMatch(/needs\.detect-changes\.outputs\.docs-only/);
    }
  });

  it("detect-changes exposes docs-only output", () => {
    const outputs = ci.jobs["detect-changes"].outputs ?? {};
    expect(outputs).toHaveProperty("docs-only");
  });
});
