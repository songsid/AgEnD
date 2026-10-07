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

/** Run publish.yml up to and including its Publish step for `tag`; npm answers `latest` for `npm view`. */
function publish(tag: string, latest: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "agend-publish-1259-"));
  dirs.push(dir);
  const bin = join(dir, "bin"), log = join(dir, "npm.log"), envFile = join(dir, "github.env");
  spawnSync("mkdir", ["-p", bin]);
  writeFileSync(log, ""); writeFileSync(envFile, "");
  // `npm view …` prints the current latest (or fails when there is none); every other npm/npx call is logged only.
  const stub = `#!/bin/bash\necho "$(basename "$0") $*" >> "${log}"\nif [ "$1" = view ]; then [ -n "$STUB_LATEST" ] || exit 1; echo "$STUB_LATEST"; fi\nexit 0\n`;
  for (const name of ["npm", "npx"]) { writeFileSync(join(bin, name), stub); chmodSync(join(bin, name), 0o755); }
  const env: Record<string, string> = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir,
    GITHUB_REF: `refs/tags/${tag}`, GITHUB_ENV: envFile, STUB_LATEST: latest ?? "",
  };
  let failedStep: string | null = null, stderr = "";
  const ran: string[] = [];
  for (const step of steps) {
    if (step.uses || !step.run) continue;
    if (step.name === "Notify Discord") break;
    // Actions exports what earlier steps appended to GITHUB_ENV.
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const at = line.indexOf("=");
      if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
    }
    const label = step.name ?? step.run.split("\n")[0]!;
    ran.push(label);
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], { cwd: ROOT, env, encoding: "utf8" });
    if (result.status !== 0) { failedStep = label; stderr = result.stderr; break; }
    if (step.name === "Publish") break;
  }
  const npm = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { failedStep, stderr, ran, npm, published: npm.find(line => line.startsWith("npm publish")) ?? null };
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
    expect(run.failedStep).toBeNull();
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

  it("a stable older than the current latest fails the job (latest never moves backwards)", () => {
    const run = publish("v2.1.10", "2.1.11");
    expect(run.failedStep).toBe("Determine npm tag");
    expect(run.stderr).toContain("would move latest backwards");
    expect(run.published).toBeNull();
    // Equal or newer is fine (an equal version is npm's own refusal to make).
    expect(publish("v2.1.11", "2.1.11").published).toBe("npm publish --access public --tag latest");
    expect(publish("v2.10.0", "2.9.99").published).toBe("npm publish --access public --tag latest");
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
