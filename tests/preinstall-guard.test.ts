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

function runGuard(nodeVersion: string, guard = GUARD, env: Record<string, string> = {}): { exitCode: number; stderr: string } {
  // Override process.versions.node via a preload and run the guard.
  const preload = `Object.defineProperty(process.versions,"node",{value:${JSON.stringify(nodeVersion)},configurable:true});`;
  const tmpPreload = `/tmp/guard-preload-${Date.now()}.cjs`;
  require("node:fs").writeFileSync(tmpPreload, preload);
  const r = spawnSync(process.execPath, ["--require", tmpPreload, guard], {
    encoding: "utf-8",
    timeout: 5_000,
    // A private data directory unless a test gives one: the real ~/.agend is never read here.
    env: { ...process.env, AGEND_HOME: unpinned, AGEND_UPDATE_KEEPS_PREVIOUS: "", ...env },
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

/**
 * #1487 (user decision 2026-10-10, no 2.1.13): AgEnD 2.1's updater unlinks the installed AgEnD before `npm install -g`,
 * so a refusal then leaves nothing installed. The refusal must say so, in plain words, with the exact restore commands.
 * Proven on the real-Mac test host (#1487 issuecomment-6094404688).
 */
describe("#1487: a refusal after AgEnD 2.1's updater says the previous AgEnD is gone, and how to put it back", () => {
  const note = createRequire(import.meta.url)("../launcher/old-updater-note.cjs") as {
    oldUpdaterState(env: Record<string, string | undefined>, now?: number): "removed" | "maybe" | "kept"; FRESH_MS: number;
  };
  const RESTORE = /npm install -g @songsid\/agend@2\.1\.12\n\s+agend install/;
  const home = () => { const d = mkdtempSync(join(tmpdir(), "agend-1487-")); return d; };
  const marker = (dir: string, startedAt: number | string) => writeFileSync(join(dir, "update-in-progress.json"), JSON.stringify({ startedAt, pid: 4242 }));

  it("the state: a fresh 2.1-updater marker → removed; none, stale, future or unreadable → maybe; 2.2's updater → kept", () => {
    const now = Date.parse("2026-10-10T06:00:00Z");
    const d = home();
    expect(note.oldUpdaterState({ AGEND_HOME: d }, now)).toBe("maybe");
    marker(d, now - 60_000); expect(note.oldUpdaterState({ AGEND_HOME: d }, now)).toBe("removed");
    expect(note.oldUpdaterState({ AGEND_HOME: d, AGEND_UPDATE_KEEPS_PREVIOUS: "1" }, now)).toBe("kept");
    marker(d, now - note.FRESH_MS - 1); expect(note.oldUpdaterState({ AGEND_HOME: d }, now), "stale").toBe("maybe");
    marker(d, now + 60_000); expect(note.oldUpdaterState({ AGEND_HOME: d }, now), "from the future").toBe("maybe");
    marker(d, "yesterday"); expect(note.oldUpdaterState({ AGEND_HOME: d }, now), "not a number").toBe("maybe");
    writeFileSync(join(d, "update-in-progress.json"), "{not json"); expect(note.oldUpdaterState({ AGEND_HOME: d }, now)).toBe("maybe");
    rmSync(d, { recursive: true, force: true });
  });

  it("the guard, started by 2.1's updater: the previous AgEnD is gone, and the exact restore commands", () => {
    const d = home(); marker(d, Date.now() - 30_000);
    const { exitCode, stderr } = runGuard("20.19.0", GUARD, { AGEND_HOME: d });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("ALREADY\n  REMOVED the previous AgEnD");
    expect(stderr).toContain("there is no `agend`");
    expect(stderr).toMatch(RESTORE);
    rmSync(d, { recursive: true, force: true });
  });

  it("the guard, a plain npm install: the same commands, said conditionally; 2.2's own updater: no such note", () => {
    const plain = runGuard("20.19.0");
    expect(plain.exitCode).toBe(1);
    expect(plain.stderr).toContain("If this install was started by AgEnD 2.1's updater");
    expect(plain.stderr).toMatch(RESTORE);
    const ours = runGuard("20.19.0", GUARD, { AGEND_UPDATE_KEEPS_PREVIOUS: "1" });
    expect(ours.exitCode).toBe(1);
    expect(ours.stderr).not.toContain("2.1's updater");
  });

  it("the helper keeps the guard's old syntax (it runs under any Node that runs npm)", () => {
    const source = readFileSync(join(REPO, "launcher", "old-updater-note.cjs"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/\?\.|\?\?|\blet\b|\bconst\b|=>/);
  });
});
