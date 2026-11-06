import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installedBuildLabel, parseBuildProvenance, readInstalledBuild, type BuildProvenance } from "../src/build-provenance.js";
const builder = await import(new URL("../scripts/write-build-provenance.mjs", import.meta.url).href);
const roots: string[] = [], sha = "a".repeat(40);
const alpha: BuildProvenance = { format: 1, commit: sha, ref: "release/2.3.5-alpha", channel: "alpha", modified: false, from: "git" };
function scratch() { const root = mkdtempSync(join(tmpdir(), "agend-build-info-")); roots.push(root); return root; }
function repository() {
  const root = scratch(), env = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  for (const key of ["HOME", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"] as const) vi.stubEnv(key, env[key]);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env, encoding: "utf8", timeout: 3000 });
  git("-c", "init.templateDir=", "init", "-q", "-b", "release/2.3.5-alpha");
  git("config", "user.name", "Build Fixture"); git("config", "user.email", "fixture@example.invalid");
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, ".gitattributes"), readFileSync(new URL("../.gitattributes", import.meta.url)));
  writeFileSync(join(root, "scripts/source-build.txt"), readFileSync(new URL("../scripts/source-build.txt", import.meta.url)));
  writeFileSync(join(root, "program.txt"), "fixture\n"); git("add", "."); git("commit", "-qm", "fixture");
  return { root, git, commit: git("rev-parse", "HEAD").trim() };
}
function installed() {
  const root = scratch(), dist = join(root, "dist"); mkdirSync(dist);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@songsid/agend", version: "1.22.0" }));
  writeFileSync(join(dist, "build-provenance.json"), JSON.stringify(alpha));
  return { root, dist };
}
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("fixed build-time source provenance", () => {
  it("records the actual alpha HEAD and distinguishes clean, tracked and untracked edits", () => {
    const f = repository();
    expect(builder.buildProvenance(f.root)).toEqual({ ...alpha, commit: f.commit });
    writeFileSync(join(f.root, "program.txt"), "changed\n"); expect(builder.buildProvenance(f.root).modified).toBe(true);
    f.git("checkout", "--", "program.txt"); writeFileSync(join(f.root, "extra.ts"), "new code");
    expect(builder.buildProvenance(f.root).modified).toBe(true);
  });
  it("records a tagged release without changing the package version, and does not call a failed dirty check clean", () => {
    const f = repository(); f.git("tag", "v2.3.5-beta.4");
    const release = builder.buildProvenance(f.root); expect(release).toMatchObject({ ref: "v2.3.5-beta.4", channel: "release" });
    expect(installedBuildLabel("2.3.5-beta.4", release)).toBe("2.3.5-beta.4");
    expect(installedBuildLabel("1.22.0", release)).toBe(`source · ${f.commit.slice(0, 12)}`);
    const unavailable = builder.buildProvenance(f.root, (exe: string, args: string[], opts: any) => {
      if (args.includes("status")) throw Error("fixture unavailable"); return execFileSync(exe, args, opts);
    });
    expect(unavailable.modified).toBeNull();
    expect(installedBuildLabel("1.22.0", unavailable)).toContain("changes unknown");
  });
  it("retains export-substituted identity in an archive, without inheriting a surrounding checkout", () => {
    const f = repository();
    const tar = execFileSync("git", ["-C", f.root, "archive", "--format=tar", "HEAD"], { timeout: 3000 });
    const extracted = join(f.root, "extracted"); mkdirSync(extracted);
    execFileSync("tar", ["-xf", "-", "-C", extracted], { input: tar, timeout: 3000 });
    const result = builder.writeBuildProvenance(extracted);
    expect(result).toEqual({ ...alpha, commit: f.commit, modified: null, from: "archive" });
    expect(JSON.parse(readFileSync(join(extracted, "dist/build-provenance.json"), "utf8"))).toEqual(result);
    expect(installedBuildLabel("1.22.0", result)).toContain("changes unknown");
  });
  it("keeps unknown, invalid and oversized source templates unknown", () => {
    const root = scratch(); mkdirSync(join(root, "scripts"));
    expect(builder.buildProvenance(root)).toMatchObject({ commit: null, from: "unknown", modified: null });
    for (const input of [readFileSync(new URL("../scripts/source-build.txt", import.meta.url)), `format=1\ncommit=${sha}\nrefs=release/2.3.5-alpha\nINJECTED`, Buffer.alloc(4097)]) {
      writeFileSync(join(root, "scripts/source-build.txt"), input);
      expect(builder.buildProvenance(root)).toMatchObject({ commit: null, from: "unknown", modified: null });
    }
  });
});
describe("installed source metadata with no Git dependency", () => {
  it("reads fixed packed files, preserves SemVer, and ignores environment/profile overrides", () => {
    const f = installed(), original = process.env.AGEND_BUILD_SHA; process.env.AGEND_BUILD_SHA = "b".repeat(40);
    try { expect(readInstalledBuild(f.dist)).toEqual({ version: "1.22.0", source: alpha, label: `2.3.5-alpha · ${sha.slice(0, 12)}` }); }
    finally { if (original === undefined) delete process.env.AGEND_BUILD_SHA; else process.env.AGEND_BUILD_SHA = original; }
    writeFileSync(join(f.root, "package.json"), JSON.stringify({ name: "@songsid/agend", version: "2.3.5" }));
    writeFileSync(join(f.dist, "build-provenance.json"), JSON.stringify({ ...alpha, ref: "v2.3.5", channel: "release" }));
    expect(readInstalledBuild(f.dist).label).toBe("2.3.5");
    expect(installedBuildLabel("2.3.5", { ...alpha, ref: "v2.3.5", channel: "release", modified: true })).toBe(`2.3.5 · ${sha.slice(0, 12)} (modified)`);
  });
  it("falls back for older or damaged packages and bounds both fixed files", () => {
    const f = installed(); rmSync(join(f.dist, "build-provenance.json"));
    expect(readInstalledBuild(f.dist)).toEqual({ version: "1.22.0", source: null, label: "1.22.0" });
    for (const raw of ["{", JSON.stringify({ ...alpha, commit: "bad" }), JSON.stringify(alpha) + " ".repeat(4097)]) {
      writeFileSync(join(f.dist, "build-provenance.json"), raw); expect(readInstalledBuild(f.dist).source).toBeNull();
    }
    for (const raw of ["{", JSON.stringify({ name: "other-package", version: "9.9.9" }), JSON.stringify({ name: "@songsid/agend", version: "not-semver" }), JSON.stringify({ name: "@songsid/agend", version: "1.22.0" }) + " ".repeat(65537)]) {
      writeFileSync(join(f.root, "package.json"), raw); expect(readInstalledBuild(f.dist).version).toBe("unknown");
    }
  });
  it("refuses ambiguous schema/channel data, while allowing detached and archive provenance", () => {
    for (const bad of [null, [], { ...alpha, extra: true }, { ...alpha, format: 2 }, { ...alpha, ref: "https://private.invalid" },
      { ...alpha, commit: "A".repeat(40) }, { ...alpha, modified: "false" }, { ...alpha, channel: "unknown" }, { ...alpha, channel: ["alpha"] }, { ...alpha, from: ["git"] },
      { ...alpha, channel: "release" }, { ...alpha, from: "archive" }, { ...alpha, from: "unknown" }]) expect(parseBuildProvenance(bad)).toBeNull();
    expect(parseBuildProvenance({ ...alpha, channel: "source", ref: null })).not.toBeNull();
    expect(parseBuildProvenance({ ...alpha, from: "archive", modified: null })).not.toBeNull();
    expect(installedBuildLabel("1.22.0", { ...alpha, modified: null }, { source: "原始碼", modified: "有變更", unknown: "狀態不明" })).toContain("狀態不明");
  });
});
