/**
 * #1259: which npm dist-tag a pushed release tag publishes to. publish.yml used to send every tag that did not
 * contain "-beta" to `latest`, so `v2.2.0-alpha.1` would have been installed by every stable user's `agend update`.
 *
 * The workflow is exercised by running its own steps, read out of the YAML, in order and as Actions runs them
 * (bash -eo pipefail, GITHUB_ENV carried from step to step), with `npm` and `npx` stubbed: nothing is installed,
 * built or published, and the real node runs the real scripts/npm-dist-tag.mjs.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
type Step = { name?: string; run?: string; uses?: string };
const steps = (yaml.load(readFileSync(join(ROOT, ".github", "workflows", "publish.yml"), "utf8")) as { jobs: { publish: { steps: Step[] } } })
  .jobs.publish.steps;

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/**
 * One release run of publish.yml with `npm`/`npx` stubbed. `npm view` reads the shared registry file (empty
 * means the lookup fails); `npm publish … --tag latest` writes the run's VERSION to it, so two runs can share a
 * registry. `steps(until)` runs the next steps up to (not including) the named one; `steps()` runs to Publish.
 */
/** What `npm pack` packs: by default a manifest that pins the bundled runtime (#1488), as a 2.2 release must. */
const PINNED = { name: "@songsid/agend", optionalDependencies: Object.fromEntries(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].map(id => [`@songsid/agend-node-${id}`, "22.23.3"])) };
function release(tag: string, registry: string, ref = `refs/tags/${tag}`, packed: object = PINNED) {
  const dir = mkdtempSync(join(tmpdir(), "agend-publish-1259-"));
  dirs.push(dir);
  const bin = join(dir, "bin"), log = join(dir, "npm.log"), envFile = join(dir, "github.env");
  spawnSync("mkdir", ["-p", bin]);
  writeFileSync(log, ""); writeFileSync(envFile, "");
  const stub = [
    "#!/bin/bash",
    `echo "$(basename "$0") $*" >> "${log}"`,
    // npm pack → a real .tgz of the test's manifest in the destination (the last argument), as npm prints it (#1488).
    `if [ "$1" = pack ]; then d="\${@: -1}"; mkdir -p "${dir}/pack/package"; cp "${dir}/packed.json" "${dir}/pack/package/package.json"; tar -czf "$d/agend-pack.tgz" -C "${dir}/pack" package; echo '[{"filename":"agend-pack.tgz"}]'; exit 0; fi`,
    // The runtime packages a pinned manifest names are on this registry.
    `if [ "$1" = view ] && [[ "$2" == @songsid/agend-node-* ]]; then printf '"%s"\\n' "\${2##*@}"; exit 0; fi`,
    `if [ "$1" = view ]; then v="$(cat "${registry}" 2>/dev/null)"; [ -n "$v" ] || exit 1; echo "$v"; fi`,
    `if [ "$1" = publish ] && [[ " $* " == *" --tag latest "* ]]; then echo "$VERSION" > "${registry}"; fi`,
    "exit 0", "",
  ].join("\n");
  for (const name of ["npm", "npx"]) { writeFileSync(join(bin, name), stub); chmodSync(join(bin, name), 0o755); }
  writeFileSync(join(dir, "packed.json"), JSON.stringify(packed));
  const env: Record<string, string> = { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir, GITHUB_REF: ref, GITHUB_ENV: envFile, RUNNER_TEMP: dir };
  const runnable = steps.filter(step => step.run && !step.uses);
  let next = 0, failedStep: string | null = null, stderr = "";
  const runSteps = (until?: string) => {
    while (failedStep === null && next < runnable.length) {
      const step = runnable[next]!;
      if (step.name === "Notify Discord" || (until && step.name === until)) return;
      next++;
      // Actions exports what earlier steps appended to GITHUB_ENV.
      for (const line of readFileSync(envFile, "utf8").split("\n")) {
        const at = line.indexOf("=");
        if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
      }
      const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run!], { cwd: ROOT, env, encoding: "utf8" });
      // `::error::` annotations go to stdout; keep both so a failure's reason can be asserted.
      if (result.status !== 0) { failedStep = step.name ?? step.run!.split("\n")[0]!; stderr = result.stderr + result.stdout; return; }
      if (step.name === "Publish") return;
    }
  };
  const outcome = () => {
    const npm = readFileSync(log, "utf8").split("\n").filter(Boolean);
    return { failedStep, stderr, npm, published: npm.find(line => line.startsWith("npm publish")) ?? null };
  };
  return { steps: runSteps, outcome };
}

/** A whole run against a registry whose latest is `latest` (null: the lookup fails). */
function publish(tag: string, latest: string | null, packed: object = PINNED) {
  const dir = mkdtempSync(join(tmpdir(), "agend-registry-1259-"));
  dirs.push(dir);
  const registry = join(dir, "latest");
  writeFileSync(registry, latest ?? "");
  const run = release(tag, registry, `refs/tags/${tag}`, packed);
  run.steps();
  return run.outcome();
}

describe("publish.yml: tag → npm dist-tag, by running the workflow's steps (#1259)", () => {
  it.each([
    ["v2.1.12", "2.1.11", "latest"],
    ["v2.1.12-beta.4", "2.1.11", "beta"],
    ["v2.2.0-alpha.1", "2.1.11", "alpha"],
    ["v2.2.0-alpha.12", "2.1.11", "alpha"],
    ["v3.0.0", "2.1.11", "latest"],
    ["v2.1.12", null, "latest"],              // no current latest (lookup failed): only the backwards check is skipped
  ])("%s publishes to %s… → --tag %s", (tag, latest, distTag) => {
    const run = publish(tag, latest);
    expect(run.failedStep, run.stderr).toBeNull();
    expect(run.published).toBe(`npm publish --access public --tag ${distTag}`);
    expect(run.npm).toContain(`npm pkg set version=${tag.slice(1)}`);
  });

  it.each([
    ["v2.2.0-rc.1"], ["v2.2.0-alpha"], ["v2.2.0-beta"], ["v2.2.0-preview.1"], ["v2.2.0-Alpha.1"],
    ["v2.2.0-alpha.01"], ["v2.2.0-beta.1+build.5"], ["v2.2.0-alpha.1.2"], ["v2.2"], ["vfoo"], ["v02.2.0"],
  ])("%s fails the job at Determine npm tag, before anything is built or published", tag => {
    const run = publish(tag, "2.1.11");
    expect(run.failedStep).toBe("Determine npm tag");
    expect(run.stderr).toContain("refusing to guess a dist-tag");
    expect(run.published).toBeNull();
    expect(run.npm.some(line => /^npm (ci|run build)|^npx tsc/.test(line))).toBe(false);
  });

  // #1488: a package that would ship without its bundled Node is never published.
  it.each([
    ["no pins at all", { name: "@songsid/agend" }],
    ["a pin missing", { name: "@songsid/agend", optionalDependencies: { "@songsid/agend-node-linux-x64": "22.23.3" } }],
  ])("the packed manifest has %s → the job fails at the pin check; npm publish never runs", (_n, packed) => {
    const run = publish("v2.2.0-alpha.2", "2.1.12", packed);
    expect(run.failedStep).toBe("The packed package pins its bundled Node, as published runtime packages");
    expect(run.stderr).toContain("would ship without its bundled Node");
    expect(run.published).toBeNull();
  });

  it("a stable older than the current latest fails the job (latest never moves backwards)", () => {
    const run = publish("v2.1.10", "2.1.11");
    expect(run.failedStep).toBe("Determine npm tag");
    expect(run.stderr).toContain("would move latest backwards");
    expect(run.published).toBeNull();
    // Equal or newer is fine (an equal version is npm's own refusal to make).
    expect(publish("v2.1.11", "2.1.11").published).toBe("npm publish --access public --tag latest");
    expect(publish("v2.10.0", "2.9.99").published).toBe("npm publish --access public --tag latest");
  });

  it.each([
    ["v2.1.12", "2.2.0-alpha.1", "would move latest backwards"],   // an old workflow had put an alpha on latest
    ["v2.1.11", "2.1.12+build.1", "would move latest backwards"],  // build metadata does not hide the version
    ["v2.1.12", "garbage", "cannot read the current latest"],      // an answer that is not a version: fail closed
  ])("%s against latest %s fails the job (#1271 review: any readable latest is compared)", (tag, latest, why) => {
    const run = publish(tag, latest);
    expect(run.failedStep).toBe("Determine npm tag");
    expect(run.stderr).toContain(why);
    expect(run.published).toBeNull();
  });

  it("a newer stable still replaces a prerelease that got onto latest", () => {
    expect(publish("v2.2.1", "2.2.0-alpha.1").published).toBe("npm publish --access public --tag latest");
  });

  it("two releases interleaved (#1271 review): an older stable checked before a newer one published does not publish", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-registry-1259-"));
    dirs.push(dir);
    const registry = join(dir, "latest");
    writeFileSync(registry, "2.1.11");
    const older = release("v2.1.12", registry), newer = release("v2.1.13", registry);
    older.steps("Publish");                    // checked against 2.1.11 and built, not yet published
    expect(older.outcome().failedStep).toBeNull();
    newer.steps();                             // the whole newer release, latest is now 2.1.13
    expect(newer.outcome().published).toBe("npm publish --access public --tag latest");
    expect(readFileSync(registry, "utf8").trim()).toBe("2.1.13");
    older.steps();                             // resumes at Publish
    expect(older.outcome().failedStep).toBe("Publish");
    expect(older.outcome().stderr).toContain("would move latest backwards");
    expect(older.outcome().published).toBeNull();
    expect(readFileSync(registry, "utf8").trim()).toBe("2.1.13");
  });

  it("release runs are serialised: one fixed concurrency group, never cancelled mid-run", () => {
    const doc = yaml.load(readFileSync(join(ROOT, ".github", "workflows", "publish.yml"), "utf8")) as { concurrency?: { group?: string; "cancel-in-progress"?: boolean } };
    expect(doc.concurrency?.group).toBe("npm-publish");
    expect(doc.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it.each([
    ["refs/tags/v2.2.0-alpha.1\nVERSION=2.2.0", "unexpected characters"],
    ["refs/heads/main", "not a v* tag"],
    ["refs/tags/2.2.0", "not a v* tag"],
  ])("a ref that is not a plain v-tag never reaches GITHUB_ENV (%j)", (ref, why) => {
    const dir = mkdtempSync(join(tmpdir(), "agend-registry-1259-"));
    dirs.push(dir);
    const registry = join(dir, "latest");
    writeFileSync(registry, "2.1.11");
    const run = release("v2.2.0-alpha.1", registry, ref);
    run.steps();
    expect(run.outcome().failedStep).toBe("Set version from tag");
    expect(run.outcome().stderr).toContain(why);
    expect(run.outcome().published).toBeNull();
  });

  it("a prerelease never consults or is limited by latest", () => {
    expect(publish("v2.0.0-beta.1", "2.1.11").published).toBe("npm publish --access public --tag beta");
    expect(publish("v2.0.0-alpha.1", "2.1.11").published).toBe("npm publish --access public --tag alpha");
  });

  it("the tag is decided before the build; the old `*-beta*` test is gone", () => {
    const names = steps.map(s => s.name ?? s.run ?? s.uses);
    expect(names.indexOf("Determine npm tag")).toBeLessThan(names.indexOf("npm ci"));
    expect(readFileSync(join(ROOT, ".github", "workflows", "publish.yml"), "utf8")).not.toContain("*-beta*");
  });

  it("the only release path is a tag: scripts/publish.sh (stable-only, untagged, a removed plugin) is retired", () => {
    expect(existsSync(join(ROOT, "scripts", "publish.sh"))).toBe(false);
  });
});
