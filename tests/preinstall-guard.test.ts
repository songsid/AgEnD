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
import { afterAll, describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const REPO = join(import.meta.dirname ?? "", "..");
/**
 * The guard reads the package.json beside it. Since #1450's pins landed, the repo's own manifest pins the bundled
 * runtime, so on a supported host an old Node proceeds (postinstall proves the runtime). The engine boundary below is
 * the refusal for a release that bundles no runtime: a copy of the guard beside the same manifest WITHOUT the pins.
 */
const unpinned = mkdtempSync(join(tmpdir(), "agend-guard-unpinned-"));
afterAll(() => rmSync(unpinned, { recursive: true, force: true }));
mkdirSync(join(unpinned, "scripts"));
cpSync(join(REPO, "scripts", "preinstall-guard.cjs"), join(unpinned, "scripts", "preinstall-guard.cjs"));
cpSync(join(REPO, "launcher"), join(unpinned, "launcher"), { recursive: true });
{
  const manifest = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  delete manifest.optionalDependencies;
  writeFileSync(join(unpinned, "package.json"), JSON.stringify(manifest, null, 2));
}
const GUARD = join(unpinned, "scripts", "preinstall-guard.cjs");

function runGuard(nodeVersion: string, guard = GUARD): { exitCode: number; stderr: string } {
  // Override process.versions.node via a preload and run the guard.
  const preload = `Object.defineProperty(process.versions,"node",{value:${JSON.stringify(nodeVersion)},configurable:true});`;
  const tmpPreload = `/tmp/guard-preload-${Date.now()}.cjs`;
  require("node:fs").writeFileSync(tmpPreload, preload);
  const r = spawnSync(process.execPath, ["--require", tmpPreload, guard], {
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
    expect(stderr).toMatch(/AgEnD 2\.2 needs Node.*aborting/is);
    expect(stderr).toMatch(/22\.14/);
    expect(stderr).toMatch(/20\.0\.0/);
    expect(stderr).toMatch(/aborting this install/i);
  });

  // #1450 pins: the shipped manifest pins all four runtime packages, so on a host they cover an old Node proceeds.
  const platform = createRequire(import.meta.url)("../launcher/runtime-platform.cjs") as { runtimeSupport(h: unknown): { supported: boolean }; hostPlatform(): unknown };
  it.skipIf(!platform.runtimeSupport(platform.hostPlatform()).supported)("the repo's own (pinned) manifest: an old Node proceeds on a supported host", () => {
    expect(runGuard("20.19.0", join(REPO, "scripts", "preinstall-guard.cjs")).exitCode).toBe(0);
  });

  it("the guard file is in the package files list (included in npm pack)", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname ?? "", "../package.json"), "utf-8"));
    expect(pkg.files, "scripts/preinstall-guard.cjs must be in package.json files").toContain("scripts/preinstall-guard.cjs");
    expect(pkg.scripts.preinstall, "preinstall must invoke the guard").toContain("preinstall-guard.cjs");
  });
});
