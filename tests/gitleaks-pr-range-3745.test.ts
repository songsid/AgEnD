import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";

const script = join(process.cwd(), "scripts/ci/gitleaks-pr.sh");
const workflow = yaml.load(readFileSync(".github/workflows/gitleaks.yml", "utf8")) as {
  jobs: { scan: { steps: { name?: string; uses?: string; if?: string; env?: Record<string, string>; run?: string; with?: Record<string, unknown> }[] } };
};
let home: string, repo: string, bin: string, base: string, head: string, tree: string;
const git = (...args: string[]) => {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
  if (r.status !== 0) throw Error(r.stderr);
  return r.stdout.trim();
};
let serial = 0;
const commit = (...parents: string[]) => git("commit-tree", tree, ...parents.flatMap(p => ["-p", p]), "-m", `fixture ${++serial}`);
function scan(env: Record<string, string> = {}, cwd = repo) {
  return spawnSync("bash", [script], { cwd, encoding: "utf8", env: { ...process.env,
    PATH: bin + ":" + process.env.PATH, PR_BASE_SHA: base, PR_HEAD_SHA: head, ...env } });
}
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "gitleaks-pr-3745-")); repo = join(home, "repo"); bin = join(home, "bin");
  // mkdir via git and shell so the fixture has no dependency on the product.
  spawnSync("mkdir", ["-p", repo, bin]);
  git("init", "-q");
  writeFileSync(join(repo, "seed"), "fixture\n"); git("add", "seed"); tree = git("write-tree");
  base = commit(); head = base;
  for (let i = 0; i < 37; i++) head = commit(head);
  git("update-ref", "refs/heads/main", head); git("symbolic-ref", "HEAD", "refs/heads/main");
  copyFileSync(".gitleaks.toml", join(repo, ".gitleaks.toml")); copyFileSync(".gitleaksignore", join(repo, ".gitleaksignore"));
  writeFileSync(join(bin, "gitleaks"), '#!/bin/bash\nif [[ "$1" == version ]]; then echo "${FAKE_VERSION:-8.24.3}"; exit; fi\nprintf "%s\\n" "$@"\nexit "${FAKE_SCAN_EXIT:-0}"\n');
  chmodSync(join(bin, "gitleaks"), 0o700);
}, 30_000);
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("complete fail-closed PR range", () => {
  it("reaches the exact head beyond commit 30 with explicit shared config and ignores", () => {
    const r = scan(); expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("37 commits"); expect(r.stdout).toContain(`--log-opts=--diff-merges=first-parent ${base}..${head}`);
    expect(r.stdout).toContain("--config=.gitleaks.toml"); expect(r.stdout).toContain("--gitleaks-ignore-path=.gitleaksignore");
    expect(r.stdout).not.toMatch(/--first-parent|--no-merges/);
  });
  it("uses the merge base, including side history and excluding base-only commits", () => {
    const baseOnly = commit(base); const side = commit(base); const merged = commit(head, side);
    const r = scan({ PR_BASE_SHA: baseOnly, PR_HEAD_SHA: merged });
    expect(r.status, r.stderr).toBe(0); expect(r.stdout).toContain(`--log-opts=--diff-merges=first-parent ${base}..${merged}`);
  });
  it.each(["", "main", "$(echo unsafe)", "f".repeat(40)])("refuses unknown or unsafe head %s", value => {
    const r = scan({ PR_HEAD_SHA: value }); expect(r.status).not.toBe(0); expect(r.stdout).not.toContain("--log-opts");
    expect(r.stderr).toContain("Gitleaks PR scan refused");
  });
  it("refuses a blob instead of a commit", () => {
    const r = scan({ PR_HEAD_SHA: git("rev-parse", head + ":seed") }); expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("not available as a commit");
  });
  it("refuses disconnected histories", () => {
    const otherTree = git("mktree"); const other = git("commit-tree", otherTree, "-m", "unrelated");
    const r = scan({ PR_HEAD_SHA: other }); expect(r.status).not.toBe(0); expect(r.stderr).toContain("merge base is unknown");
  });
  it("refuses ambiguous criss-cross merge bases", () => {
    const a = commit(head), b = commit(base); const x = commit(a, b), y = commit(b, a);
    const r = scan({ PR_BASE_SHA: x, PR_HEAD_SHA: y }); expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("merge base is missing or ambiguous");
  });
  it("refuses a shallow checkout instead of scanning a partial history", () => {
    const shallow = join(home, "shallow");
    const clone = spawnSync("git", ["clone", "-q", "--depth=1", "file://" + repo, shallow], { encoding: "utf8" });
    expect(clone.status, clone.stderr).toBe(0);
    const r = scan({ PR_BASE_SHA: head }, shallow); expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("complete history is required");
  });
  it("requires both scan configuration files", () => {
    const isolated = join(home, "isolated"); git("worktree", "add", "--detach", isolated, head);
    const r = scan({}, isolated); expect(r.status).not.toBe(0); expect(r.stderr).toContain("configuration or fingerprint ignore file is missing");
  });
  it("refuses a different scanner version", () => {
    const r = scan({ FAKE_VERSION: "8.25.0" }); expect(r.status).not.toBe(0); expect(r.stderr).toContain("expected pinned Gitleaks");
  });
  it.each([1, 2])("propagates scanner failure %s", code => expect(scan({ FAKE_SCAN_EXIT: String(code) }).status).toBe(code));
});

describe("PR workflow wiring", () => {
  it("uses event SHAs via env and complete checkout, never the action's commit-list for PRs", () => {
    const steps = workflow.jobs.scan.steps;
    expect(steps.find(s => s.uses?.startsWith("actions/checkout@"))?.with?.["fetch-depth"]).toBe(0);
    const scan = steps.find(s => s.name === "Scan complete PR history")!;
    expect(scan.if).toBe("github.event_name == 'pull_request'");
    expect(scan.env).toEqual({ PR_BASE_SHA: "${{ github.event.pull_request.base.sha }}", PR_HEAD_SHA: "${{ github.event.pull_request.head.sha }}" });
    expect(scan.run).toBe("bash scripts/ci/gitleaks-pr.sh");
    const action = steps.find(s => s.uses?.startsWith("gitleaks/"))!;
    expect(action.if).toBe("github.event_name == 'push'"); expect(action.env?.GITLEAKS_VERSION).toBe("8.24.3");
  });
  it("verifies the pinned binary before exposing it on PATH", () => {
    const install = workflow.jobs.scan.steps.find(s => s.name === "Install pinned Gitleaks for PR scan")!;
    expect(install.if).toBe("github.event_name == 'pull_request'");
    expect(install.run).toContain("v8.24.3/gitleaks_8.24.3_linux_x64.tar.gz");
    expect(install.run).toContain("9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c");
    expect(install.run).toContain("sha256sum --check --strict");
    expect(install.run!.indexOf("sha256sum")).toBeLessThan(install.run!.indexOf("tar -xzf"));
  });
});
