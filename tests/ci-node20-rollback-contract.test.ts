/**
 * CI contract regression for node20-rollback-smoke (#1442 / #1441-A).
 *
 * P2 (Prism r2): node20-rollback-smoke declared `needs: setup` but referenced
 * `needs.detect-changes.outputs.packaging`. GitHub only populates `needs`
 * context from direct dependencies; detect-changes was absent, so the value
 * was always empty and heavy steps always ran.
 *
 * Fix: `needs: [setup, detect-changes]`. This test catches a regression back
 * to the broken form and verifies the packaging step condition uses the
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
    // If detect-changes is absent, needs.detect-changes.outputs.packaging
    // is empty and == 'true' is always false → heavy steps never run.
    expect(smoke.needs).toContain("detect-changes");
    expect(smoke.needs).toContain("setup");
  });

  it("every heavy step references needs.detect-changes.outputs.packaging", () => {
    const heavySteps = smoke.steps.filter(s =>
      s.name && /pack|rollback proof/i.test(s.name),
    );
    expect(heavySteps.length, "expected at least 2 heavy named steps").toBeGreaterThanOrEqual(2);
    for (const step of heavySteps) {
      expect(
        step.if,
        `step "${step.name}" must have a packaging guard`,
      ).toMatch(/needs\.detect-changes\.outputs\.packaging/);
    }
  });

  it("detect-changes exposes packaging output", () => {
    const outputs = ci.jobs["detect-changes"].outputs ?? {};
    expect(outputs).toHaveProperty("packaging");
    expect(outputs).toHaveProperty("text-only");
    expect(outputs).toHaveProperty("deps");
    expect(outputs).toHaveProperty("src");
  });
});
