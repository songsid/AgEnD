import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const wf = yaml.load(readFileSync(join(ROOT, ".github/workflows/dependency-review.yml"), "utf8")) as {
  on: { pull_request?: { branches?: string[] } };
  permissions: Record<string, string>;
  jobs: {
    "dependency-review": {
      steps: Array<{ uses?: string; with?: Record<string, string>; "continue-on-error"?: boolean }>;
    };
  };
};
const cfg = yaml.load(readFileSync(join(ROOT, ".github/dependency-review-config.yml"), "utf8")) as {
  "fail-on-severity": string;
  "fail-on-scopes": string[];
  "allow-licenses": string[];
};

describe("dependency-review (#2528 PR 3)", () => {
  it("runs on PRs into main and release/**, contents: read", () => {
    expect(wf.on.pull_request?.branches).toEqual(["main", "release/**"]);
    expect(wf.permissions).toEqual({ contents: "read" });
  });

  it("fails high/critical advisories and disallowed licences", () => {
    expect(cfg["fail-on-severity"]).toBe("high");
    expect(cfg["fail-on-scopes"].sort()).toEqual(["development", "runtime"]);
    expect(cfg["allow-licenses"]).toEqual([
      "0BSD",
      "Apache-2.0",
      "Apache-2.0 AND LGPL-3.0-or-later AND MIT",
      "BSD-2-Clause",
      "BSD-3-Clause",
      "BlueOak-1.0.0",
      "CC0-1.0",
      "ISC",
      "LGPL-2.1-or-later",
      "LGPL-3.0-or-later",
      "MIT",
      "MPL-2.0",
      "Python-2.0",
    ]);
  });

  it("pins checkout and dependency-review-action to 40-char SHAs", () => {
    const steps = wf.jobs["dependency-review"].steps;
    expect(steps.every(s => s["continue-on-error"] !== true)).toBe(true);
    expect(steps[0]!.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(steps[1]!.uses).toMatch(/^actions\/dependency-review-action@[0-9a-f]{40}$/);
    expect(steps[1]!.with?.["config-file"]).toBe("./.github/dependency-review-config.yml");
  });

  it("a licence not on the allow-list is a synthetic fail (the action would reject it)", () => {
    expect(cfg["allow-licenses"]).not.toContain("GPL-3.0");
    expect(cfg["allow-licenses"]).not.toContain("AGPL-3.0");
    expect(["low", "moderate"]).not.toContain(cfg["fail-on-severity"]);
  });
});
