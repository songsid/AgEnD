/**
 * #1488: publish.yml refuses a 2.2 release that would ship without its bundled Node — the packed manifest must pin each
 * runtime package AgEnD ships, exactly, to one version that is already on the registry
 * (scripts/release/check-runtime-pins.mjs). The CLI is run on a real .tgz with `npm view` answered by a stub on PATH.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script, no type declarations
import { judgePins } from "../scripts/release/check-runtime-pins.mjs";

const IDS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
const pinned = (version = "22.23.3", ids = IDS) => Object.fromEntries(ids.map(id => [`@songsid/agend-node-${id}`, version]));
const manifest = (optionalDependencies: Record<string, string> | undefined) => ({ name: "@songsid/agend", version: "2.2.0-alpha.2", optionalDependencies });
const all = () => true;

describe("judgePins", () => {
  it("all four shipped runtime packages, exact, one version, on the registry → ok", () => {
    expect(judgePins(manifest(pinned()), all)).toEqual({ ok: true, pin: "22.23.3" });
    expect(judgePins(manifest(pinned("22.23.3-agend.1")), all)).toEqual({ ok: true, pin: "22.23.3-agend.1" });   // a repack
  });
  it.each([
    ["no optionalDependencies at all (the bug: a 2.2 without its Node)", manifest(undefined), "does not pin"],
    ["one platform missing", manifest(pinned("22.23.3", IDS.slice(1))), "does not pin @songsid/agend-node-linux-x64"],
    ["a range instead of an exact version", manifest({ ...pinned(), "@songsid/agend-node-darwin-arm64": "^22.23.3" }), "not an exact version"],
    ["two versions", manifest({ ...pinned(), "@songsid/agend-node-linux-arm64": "22.23.2" }), "different versions"],
    ["a runtime package AgEnD does not ship", manifest({ ...pinned(), "@songsid/agend-node-linux-ia32": "22.23.3" }), "does not ship"],
  ])("refused: %s", (_n, m, why) => {
    expect(judgePins(m, all)).toMatchObject({ ok: false, reason: expect.stringContaining(why) });
  });
  it("a pinned version npm does not have is refused, naming it", () => {
    const verdict = judgePins(manifest(pinned()), (name: string) => name !== "@songsid/agend-node-darwin-x64");
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringContaining("not on the registry: @songsid/agend-node-darwin-x64@22.23.3") });
  });
});

describe("check-runtime-pins.mjs on a packed tarball (npm view stubbed)", () => {
  const roots: string[] = [];
  afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
  function run(optionalDependencies: Record<string, string> | undefined, npmView: "published" | "missing" | "error") {
    const root = mkdtempSync(join(tmpdir(), "agend-pins-"));
    roots.push(root);
    mkdirSync(join(root, "package"));
    writeFileSync(join(root, "package", "package.json"), JSON.stringify(manifest(optionalDependencies)));
    expect(spawnSync("tar", ["-czf", join(root, "agend.tgz"), "-C", root, "package"]).status).toBe(0);
    const bin = join(root, "bin");
    mkdirSync(bin);
    const body = npmView === "published" ? `v="\${2#*@songsid/agend-node-*@}"; echo "\\"$v\\""; exit 0`
      : npmView === "missing" ? `echo "npm error code E404" >&2; echo "npm error 404 Not Found - GET https://registry.npmjs.org/x" >&2; exit 1`
      : `echo "npm error code ETIMEDOUT" >&2; exit 1`;
    writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "npm $*" >> '${join(root, "calls")}'\n[ "$1" = view ] || exit 9\n${body}\n`);
    chmodSync(join(bin, "npm"), 0o755);
    const r = spawnSync(process.execPath, [join(process.cwd(), "scripts", "release", "check-runtime-pins.mjs"), join(root, "agend.tgz")], {
      encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root },
    });
    let calls = "";
    try { calls = readFileSync(join(root, "calls"), "utf8"); } catch { /* none */ }
    return { ...r, calls };
  }
  it("pinned and published: passes, after asking npm for each exact version", () => {
    const r = run(pinned(), "published");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("pins its bundled Node");
    for (const id of IDS) expect(r.calls).toContain(`npm view @songsid/agend-node-${id}@22.23.3 version --json`);
  });
  it("no pins (as main is before the runtime publish): fails before asking npm anything", () => {
    const r = run(undefined, "published");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("would ship without its bundled Node");
    expect(r.calls).toBe("");
  });
  it("pinned but not published yet: fails", () => {
    const r = run(pinned(), "missing");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not on the registry");
  });
  it("a registry lookup that fails another way is not 'unpublished' and not 'ok': fails, naming it", () => {
    const r = run(pinned(), "error");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("npm view @songsid/agend-node-");
  });
});

describe("publish.yml runs the check on what it packs, before it publishes", () => {
  it("the step comes after the version is set and before npm publish, on the packed tarball", () => {
    const yml = readFileSync(join(process.cwd(), ".github", "workflows", "publish.yml"), "utf8");
    const setVersion = yml.indexOf('npm pkg set "version=$VERSION"');
    const check = yml.indexOf("node scripts/release/check-runtime-pins.mjs \"$RUNNER_TEMP/$TARBALL\"");
    const publish = yml.indexOf("npm publish --access public");
    expect(setVersion).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(setVersion);
    expect(publish).toBeGreaterThan(check);
    expect(yml).toContain("npm pack --json --pack-destination \"$RUNNER_TEMP\"");
  });
});
