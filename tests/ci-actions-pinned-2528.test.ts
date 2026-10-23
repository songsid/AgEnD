import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts/ci/assert-actions-pinned.mjs");
const run = (root: string) => {
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, [script, "--root", root], { encoding: "utf8" }),
      stderr: "",
    };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

describe("assert-actions-pinned (#2528)", () => {
  it("passes on this checkout", () => {
    const r = run(process.cwd());
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/every remote uses: is a 40-char SHA/);
  });

  it("fails on a tag-pinned uses:", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-actions-pin-"));
    try {
      mkdirSync(join(dir, ".github/workflows"), { recursive: true });
      writeFileSync(join(dir, ".github/workflows/x.yml"), "jobs:\n  j:\n    steps:\n      - uses: actions/checkout@v4\n");
      const r = run(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("actions/checkout@v4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows a local composite path", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-actions-local-"));
    try {
      mkdirSync(join(dir, ".github/workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github/workflows/x.yml"),
        "jobs:\n  j:\n    steps:\n      - uses: ./.github/actions/published-agend-tarball\n",
      );
      const r = run(dir);
      expect(r.status, r.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a 40-char SHA with a tag comment", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-actions-sha-"));
    try {
      mkdirSync(join(dir, ".github/workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github/workflows/x.yml"),
        "jobs:\n  j:\n    steps:\n      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n",
      );
      const r = run(dir);
      expect(r.status, r.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
