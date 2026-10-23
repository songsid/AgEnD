import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const script = join(ROOT, "scripts/ci/audit-signatures.sh");
const wf = yaml.load(readFileSync(join(ROOT, ".github/workflows/npm-audit-signatures.yml"), "utf8")) as {
  on: { push?: { branches?: string[] }; pull_request?: { branches?: string[] } };
  permissions: Record<string, string>;
  jobs: {
    signatures: {
      steps: Array<{ name?: string; run?: string; uses?: string; "working-directory"?: string; "continue-on-error"?: boolean }>;
    };
  };
};

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function stubNpm(exit: number, stdout: string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-sig-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  spawnSync("mkdir", ["-p", bin]);
  writeFileSync(join(bin, "npm"), `#!/bin/bash\necho "$*" >> "${dir}/log"\ncat <<'OUT'\n${stdout}\nOUT\nexit ${exit}\n`);
  chmodSync(join(bin, "npm"), 0o755);
  return { dir, bin };
}

describe("npm audit signatures (#2528 PR 2)", () => {
  it("runs on PRs and pushes to main, release/** and feat/** PRs, contents: read", () => {
    expect(wf.on.push?.branches).toEqual(["main", "release/**"]);
    expect(wf.on.pull_request?.branches).toEqual(["main", "release/**", "feat/**"]);
    expect(wf.permissions).toEqual({ contents: "read" });
  });

  it("installs with --ignore-scripts and verifies root then website", () => {
    const runs = wf.jobs.signatures.steps.filter(s => s.run);
    expect(runs.map(s => s.run)).toEqual([
      "npm ci --ignore-scripts",
      "bash scripts/ci/audit-signatures.sh .",
      "npm ci --ignore-scripts",
      "bash scripts/ci/audit-signatures.sh website",
    ]);
    expect(runs[2]!["working-directory"]).toBe("website");
    expect(runs.every(s => s["continue-on-error"] !== true)).toBe(true);
  });

  it("pins checkout and setup-node to 40-char SHAs", () => {
    const uses = wf.jobs.signatures.steps.map(s => s.uses).filter(Boolean) as string[];
    expect(uses).toHaveLength(2);
    for (const u of uses) expect(u).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/);
  });

  it("fails on invalid signatures (synthetic npm)", () => {
    const { bin } = stubNpm(1, "error: invalid signature for evil@1.0.0");
    const r = spawnSync("bash", [script, ROOT], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
    });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/invalid/);
  });

  it("reports missing signatures without failing (synthetic npm)", () => {
    const { bin } = stubNpm(0, "12 packages have verified registry signatures\n3 packages are missing registry signatures");
    const r = spawnSync("bash", [script, ROOT], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/missing signatures reported/);
  });
});
