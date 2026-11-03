/**
 * #2987 (M-2295): a beta tag publishes to `rc`; `beta` moves to a candidate only through promote-beta.yml, run by the
 * leader. The workflow is exercised by running its own steps, read out of the YAML, in order and as Actions runs them
 * (bash -eo pipefail, GITHUB_ENV carried from step to step, each step's `if:` evaluated), with `npm` and `sleep`
 * stubbed against a registry file: nothing is moved on the real registry. The real node runs the real
 * scripts/release/promote-beta.mjs.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
type Step = { name?: string; run?: string; uses?: string; if?: string; env?: Record<string, string> };
const workflow = yaml.load(readFileSync(join(ROOT, ".github", "workflows", "promote-beta.yml"), "utf8")) as {
  on: { workflow_dispatch: { inputs: Record<string, { default?: unknown; required?: boolean }> } };
  concurrency: { group: string; "cancel-in-progress": boolean };
  permissions: Record<string, string>;
  jobs: { promote: { env: Record<string, string>; steps: Step[] } };
};
const steps = workflow.jobs.promote.steps;

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** `env.X == 'v'` / `!=` joined by `&&` — the only shapes the workflow uses. */
function evalIf(cond: string, env: Record<string, string>): boolean {
  return cond.split("&&").every(part => {
    const m = /^\s*env\.(\w+)\s*(==|!=)\s*'([^']*)'\s*$/.exec(part);
    if (!m) throw new Error(`unsupported if: ${cond}`);
    return m[2] === "==" ? env[m[1]!] === m[3] : env[m[1]!] !== m[3];
  });
}

/** A registry: versions published, and the dist-tags. `npm dist-tag add pkg@v tag` moves one (needs a token). */
function promote(input: { version: string; dryRun: boolean; token?: string; published: string[]; tags: Record<string, string>; lagLooks?: number }) {
  const dir = mkdtempSync(join(tmpdir(), "agend-promote-2987-"));
  dirs.push(dir);
  const bin = join(dir, "bin"), log = join(dir, "npm.log"), envFile = join(dir, "github.env"), reg = join(dir, "registry.json");
  spawnSync("mkdir", ["-p", bin]);
  writeFileSync(log, ""); writeFileSync(envFile, "");
  writeFileSync(reg, JSON.stringify({ published: input.published, tags: input.tags, lag: input.lagLooks ?? 0 }));
  const npm = `#!/usr/bin/env node
const fs = require("fs");
const reg = JSON.parse(fs.readFileSync(${JSON.stringify(reg)}, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, "npm " + args.join(" ") + (args[0] === "dist-tag" ? " token=" + (process.env.NODE_AUTH_TOKEN ? "yes" : "no") : "") + "\\n");
if (args[0] === "view") {
  const sel = args[1].slice(args[1].lastIndexOf("@") + 1);
  let v = reg.published.includes(sel) ? sel : reg.tags[sel];
  // The registry answering with the old tag for a few looks after a move.
  if (sel === "beta" && reg.moved && reg.lag > 0) { reg.lag--; v = reg.oldBeta; fs.writeFileSync(${JSON.stringify(reg)}, JSON.stringify(reg)); }
  if (!v) process.exit(1);
  console.log(v);
} else if (args[0] === "dist-tag" && args[1] === "add") {
  if (!process.env.NODE_AUTH_TOKEN) { console.error("ENEEDAUTH"); process.exit(1); }
  const at = args[2].lastIndexOf("@");
  reg.oldBeta = reg.tags[args[3]]; reg.moved = true;
  reg.tags[args[3]] = args[2].slice(at + 1);
  fs.writeFileSync(${JSON.stringify(reg)}, JSON.stringify(reg));
}
`;
  writeFileSync(join(bin, "npm"), npm); chmodSync(join(bin, "npm"), 0o755);
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, "sleep"), 0o755);
  const env: Record<string, string> = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir, GITHUB_ENV: envFile,
    PACKAGE: "@songsid/agend", VERSION: input.version, DRY_RUN: String(input.dryRun),
  };
  let failedStep: string | null = null, output = "";
  for (const step of steps) {
    if (!step.run || step.uses) continue;
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const at = line.indexOf("=");
      if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
    }
    if (step.if && !evalIf(step.if, env)) continue;
    const stepEnv = { ...env, ...(step.env?.NODE_AUTH_TOKEN !== undefined && input.token ? { NODE_AUTH_TOKEN: input.token } : {}) };
    const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], { cwd: ROOT, env: stepEnv, encoding: "utf8" });
    output += r.stdout + r.stderr;
    if (r.status !== 0) { failedStep = step.name ?? "?"; break; }
  }
  const registry = JSON.parse(readFileSync(reg, "utf8")) as { tags: Record<string, string> };
  return { failedStep, output, npm: readFileSync(log, "utf8").split("\n").filter(Boolean), tags: registry.tags };
}

const REG = { published: ["2.3.4", "2.3.5-beta.1", "2.3.5-beta.2"], tags: { latest: "2.3.4", beta: "2.3.5-beta.1", rc: "2.3.5-beta.2" } };

describe("promote-beta.yml: beta moves to a candidate only when the leader runs it (#2987)", () => {
  it("dispatch-only, dry_run on by default, the publish concurrency group, no OIDC needed", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.on.workflow_dispatch.inputs.dry_run!.default).toBe(true);
    expect(workflow.concurrency).toEqual({ group: "npm-publish", "cancel-in-progress": false });
    expect(workflow.permissions).toEqual({ contents: "read" });
    // Inputs reach the scripts through env only.
    for (const step of steps) expect(step.run ?? "").not.toMatch(/\$\{\{/);
  });

  it("a real run moves beta to the candidate with the token, and verifies it", () => {
    const run = promote({ version: "2.3.5-beta.2", dryRun: false, token: "t", ...structuredClone(REG) });
    expect(run.failedStep, run.output).toBeNull();
    expect(run.npm).toContain("npm dist-tag add @songsid/agend@2.3.5-beta.2 beta token=yes");
    expect(run.tags).toEqual({ latest: "2.3.4", beta: "2.3.5-beta.2", rc: "2.3.5-beta.2" });
    expect(run.output).toContain("@beta is 2.3.5-beta.2");
  });

  it("the registry answering with the old beta for a few looks: verified once it catches up", () => {
    const run = promote({ version: "2.3.5-beta.2", dryRun: false, token: "t", ...structuredClone(REG), lagLooks: 3 });
    expect(run.failedStep, run.output).toBeNull();
    expect(run.npm.filter(l => l === "npm view @songsid/agend@beta version").length).toBeGreaterThanOrEqual(4);
  });

  it("a dry run checks and prints, and moves nothing", () => {
    const run = promote({ version: "2.3.5-beta.2", dryRun: true, token: "t", ...structuredClone(REG) });
    expect(run.failedStep, run.output).toBeNull();
    expect(run.npm.some(l => l.startsWith("npm dist-tag"))).toBe(false);
    expect(run.tags.beta).toBe("2.3.5-beta.1");
    expect(run.output).toContain("dry run — would run: npm dist-tag add @songsid/agend@2.3.5-beta.2 beta");
  });

  it("a version that is not on the registry fails at the check; nothing moves", () => {
    const run = promote({ version: "2.3.5-beta.9", dryRun: false, token: "t", ...structuredClone(REG) });
    expect(run.failedStep).toBe("Check the candidate");
    expect(run.output).toContain("is not on the registry");
    expect(run.npm.some(l => l.startsWith("npm dist-tag"))).toBe(false);
  });

  it("beta never moves backwards", () => {
    const run = promote({ version: "2.3.5-beta.1", dryRun: false, token: "t", published: REG.published, tags: { latest: "2.3.4", beta: "2.3.5-beta.2", rc: "2.3.5-beta.2" } });
    expect(run.failedStep).toBe("Check the candidate");
    expect(run.output).toContain("would move beta backwards");
    expect(run.tags.beta).toBe("2.3.5-beta.2");
  });

  it("only a beta candidate is promoted: a stable or an alpha is refused", () => {
    for (const version of ["2.3.4", "2.4.0-alpha.1"]) {
      const run = promote({ version, dryRun: false, token: "t", published: [...REG.published, "2.4.0-alpha.1"], tags: { ...REG.tags } });
      expect(run.failedStep).toBe("Check the candidate");
      expect(run.output).toContain("only a beta candidate is promoted");
    }
  });

  it("beta already on the candidate: nothing to move, and the verify passes", () => {
    const run = promote({ version: "2.3.5-beta.1", dryRun: false, token: "t", ...structuredClone(REG) });
    expect(run.failedStep, run.output).toBeNull();
    expect(run.npm.some(l => l.startsWith("npm dist-tag"))).toBe(false);
  });

  it("no NPM_TOKEN: a real run fails before any move (OIDC cannot move a dist-tag)", () => {
    const run = promote({ version: "2.3.5-beta.2", dryRun: false, ...structuredClone(REG) });
    expect(run.failedStep).toBe("Move beta to the candidate");
    expect(run.output).toContain("NPM_TOKEN secret is not set");
    expect(run.tags.beta).toBe("2.3.5-beta.1");
  });

  it("promoting an older candidate than @rc warns", () => {
    const run = promote({ version: "2.3.5-beta.2", dryRun: true, published: [...REG.published, "2.3.5-beta.3"], tags: { latest: "2.3.4", beta: "2.3.5-beta.1", rc: "2.3.5-beta.3" } });
    expect(run.failedStep, run.output).toBeNull();
    expect(run.output).toContain("::warning::@rc is 2.3.5-beta.3, not 2.3.5-beta.2");
  });
});
