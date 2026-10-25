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
      steps: Array<{ name?: string; run?: string; uses?: string; if?: string; "working-directory"?: string; "continue-on-error"?: boolean }>;
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

function run(bin: string) {
  return spawnSync("bash", [script, ROOT], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
  });
}

const missingOnly = JSON.stringify({
  invalid: [],
  missing: [{
    name: "unsigned-pkg",
    version: "1.0.0",
    registry: "https://registry.npmjs.org/",
    location: "node_modules/unsigned-pkg",
    integrity: "sha512-deadbeef",
    resolved: "https://registry.npmjs.org/unsigned-pkg/-/unsigned-pkg-1.0.0.tgz",
  }],
}, null, 2);

const invalidSignature = JSON.stringify({
  invalid: [{
    code: "EINTEGRITYSIGNATURE",
    message: "integrity checksum failed",
    name: "evil",
    version: "1.0.0",
    registry: "https://registry.npmjs.org/",
  }],
  missing: [],
}, null, 2);

const invalidAttestation = JSON.stringify({
  invalid: [{
    code: "EATTESTATIONVERIFY",
    message: "attestation verification failed",
    name: "evil",
    version: "1.0.0",
    registry: "https://registry.npmjs.org/",
  }],
  missing: [],
}, null, 2);

const mixed = JSON.stringify({
  invalid: [{
    code: "EINTEGRITYSIGNATURE",
    message: "integrity checksum failed",
    name: "evil",
    version: "1.0.0",
    registry: "https://registry.npmjs.org/",
  }],
  missing: [{
    name: "unsigned-pkg",
    version: "1.0.0",
    registry: "https://registry.npmjs.org/",
  }],
}, null, 2);

const valid = JSON.stringify({ invalid: [], missing: [] }, null, 2);

const npmError = JSON.stringify({
  error: {
    code: "EAUDITNOPACKAGES",
    summary: "found no installed dependencies to audit",
    detail: "",
  },
}, null, 2);

describe("npm audit signatures (#2528 PR 2)", () => {
  it("runs on PRs and pushes to main, release/** and feat/** PRs, contents: read", () => {
    expect(wf.on.push?.branches).toEqual(["main", "release/**"]);
    expect(wf.on.pull_request?.branches).toEqual(["main", "release/**", "feat/**"]);
    expect(wf.permissions).toEqual({ contents: "read" });
  });

  it("installs with --ignore-scripts and verifies root then website", () => {
    const real = wf.jobs.signatures.steps.filter(s => s.if === "steps.changes.outputs.deps == 'true'" && s.run);
    expect(real.map(s => s.run)).toEqual([
      "npm ci --ignore-scripts",
      "bash scripts/ci/audit-signatures.sh .",
      "npm ci --ignore-scripts",
      "bash scripts/ci/audit-signatures.sh website",
    ]);
    expect(real[2]!["working-directory"]).toBe("website");
    expect(wf.jobs.signatures.steps.every(s => s["continue-on-error"] !== true)).toBe(true);
  });

  it("pins checkout and setup-node to 40-char SHAs", () => {
    const uses = wf.jobs.signatures.steps.map(s => s.uses).filter(Boolean) as string[];
    expect(uses).toHaveLength(2);
    for (const u of uses) expect(u).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/);
  });

  it("workflow comment names missing-only as our policy", () => {
    const yml = readFileSync(join(ROOT, ".github/workflows/npm-audit-signatures.yml"), "utf8");
    expect(yml).toMatch(/our policy/);
    expect(yml).not.toMatch(/npm's (own )?rule/i);
  });

  it("fails on invalid signatures (npm --json exit 1)", () => {
    const { bin } = stubNpm(1, invalidSignature);
    const r = run(bin);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/invalid signatures or attestations/);
  });

  it("fails on invalid attestations (npm --json exit 1)", () => {
    const { bin } = stubNpm(1, invalidAttestation);
    const r = run(bin);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/invalid signatures or attestations/);
  });

  it("reports missing-only findings without failing (npm --json exit 1)", () => {
    const { dir, bin } = stubNpm(1, missingOnly);
    const r = run(bin);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/missing signatures reported/);
    expect(readFileSync(join(dir, "log"), "utf8")).toMatch(/audit signatures --json/);
  });

  it("fails on mixed invalid and missing (npm --json exit 1)", () => {
    const { bin } = stubNpm(1, mixed);
    const r = run(bin);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/invalid signatures or attestations/);
  });

  it("fails on unparseable output (exit 1)", () => {
    const { bin } = stubNpm(1, "not-json garbage from npm");
    const r = run(bin);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/unparseable npm audit signatures output/);
  });

  it("fails on npm operational error JSON (exit 1)", () => {
    const { bin } = stubNpm(1, npmError);
    const r = run(bin);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/npm audit signatures failed/);
  });

  it("passes when invalid and missing are empty (exit 0)", () => {
    const { bin } = stubNpm(0, valid);
    const r = run(bin);
    expect(r.status).toBe(0);
  });
});
