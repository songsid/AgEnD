/**
 * Tests for scripts/preinstall-guard.cjs — the npm preinstall lifecycle hook.
 *
 * The guard exits 1 on incompatible Node so npm aborts the install and rolls
 * back to the previously installed version. This is the P1 mechanism for
 * protecting machines running the OLD 2.1.x updater that only warns on
 * EBADENGINE but still runs the install.
 *
 * --ignore-scripts: bypasses this check entirely. npm installs successfully
 * but the binary will crash at the first DB open. This is a known npm
 * limitation; see Upgrade Notes in the changelog.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const GUARD = join(import.meta.dirname ?? "", "../scripts/preinstall-guard.cjs");

function runGuard(nodeVersion: string): { exitCode: number; stderr: string } {
  // Override process.versions.node via a preload and run the guard.
  const preload = `Object.defineProperty(process.versions,"node",{value:${JSON.stringify(nodeVersion)},configurable:true});`;
  const tmpPreload = `/tmp/guard-preload-${Date.now()}.cjs`;
  require("node:fs").writeFileSync(tmpPreload, preload);
  const r = spawnSync(process.execPath, ["--require", tmpPreload, GUARD], {
    encoding: "utf-8",
    timeout: 5_000,
  });
  try { require("node:fs").unlinkSync(tmpPreload); } catch {}
  return { exitCode: r.status ?? 1, stderr: r.stderr };
}

describe("preinstall-guard — boundary cases", () => {
  it.each([
    "20.0.0", "20.19.0",
    "21.0.0", "21.7.0",
    "22.0.0", "22.13.0",
    "23.0.0", "23.5.9",
  ])("exits 1 on incompatible Node %s", (v) => {
    const { exitCode } = runGuard(v);
    expect(exitCode).toBe(1);
  });

  it.each([
    "22.14.0", "22.15.0",
    "23.6.0", "23.7.0",
    "24.0.0", "26.0.0",
  ])("exits 0 on compatible Node %s", (v) => {
    const { exitCode } = runGuard(v);
    expect(exitCode).toBe(0);
  });

  it("prints a human-readable error on incompatible Node", () => {
    const { stderr } = runGuard("20.0.0");
    expect(stderr).toMatch(/AgEnD 2\.2 needs Node/i);
    expect(stderr).toMatch(/22\.14/);
    expect(stderr).toMatch(/20\.0\.0/);
    expect(stderr).toMatch(/install was left unchanged/i);
  });

  it("the guard file is in the package files list (included in npm pack)", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname ?? "", "../package.json"), "utf-8"));
    expect(pkg.files, "scripts/preinstall-guard.cjs must be in package.json files").toContain("scripts/preinstall-guard.cjs");
    expect(pkg.scripts.preinstall, "preinstall must invoke the guard").toContain("preinstall-guard.cjs");
  });
});
