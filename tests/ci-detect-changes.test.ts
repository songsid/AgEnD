/**
 * Regressions for the detect-changes step in ci.yml's detect-changes job.
 *
 * Tests run the bash fragment that classifies a PR as docs-only or full.  The
 * key bugs being guarded (Prism review of #1392):
 *
 *   P3a — pipefail+SIGPIPE fail-open: the old `git diff | grep -q` caused git
 *         to receive SIGPIPE when grep exited early on a large diff; with
 *         `pipefail` the pipeline exit was 141, which the `if` evaluated as
 *         false → else-branch → docs-only=true for any large src/ change.
 *
 *   P3b — git failure fail-open: a bad/missing SHA produced `git diff` exit 1,
 *         same SIGPIPE / non-zero propagation → docs-only=true.
 *
 * The fix (captured here): collect the diff into a variable first:
 *   if ! diff_files=$(git diff …); then echo "docs-only=false"; exit 0; fi
 * Then grep on the variable (no pipes to git).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, rm as rmAsync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname ?? import.meta.url.replace(/\/[^/]+$/, ""), "..");

// Extract the detect-changes run script from ci.yml.
// Substitute the github.event_name expression to "pull_request" so the
// early-exit for push events does not fire.
const rawScript = (() => {
  const ci = yaml.load(readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8")) as {
    jobs: { "detect-changes": { steps: Array<{ id?: string; run?: string }> } };
  };
  const step = ci.jobs["detect-changes"].steps.find(s => s.id === "check");
  if (!step?.run) throw new Error("detect-changes 'check' step not found in ci.yml");
  return step.run;
})();

// Replace the github expression with the literal "pull_request" so tests can
// exercise the PR classification path without a real Actions context.
const SCRIPT = rawScript.replace(/"\$\{\{ github\.event_name \}\}"/g, '"pull_request"');

const dirs: string[] = [];

afterAll(async () => {
  // Use async rm with maxRetries so that git background processes (pack, gc)
  // that briefly hold file handles don't cause ENOTEMPTY flakes.
  const toRemove = dirs.splice(0);
  await Promise.allSettled(
    toRemove.map(d =>
      new Promise<void>((resolve) =>
        rmAsync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }, () => resolve()),
      ),
    ),
  );
});

/** Run the detect-changes script with given BASE/HEAD SHAs in a git repo. */
function run(repoDir: string, baseSha: string, headSha: string): { docsOnly: boolean; exitCode: number } {
  const githubOutput = join(repoDir, "github_output.txt");
  writeFileSync(githubOutput, "");
  const result = spawnSync(
    "bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", SCRIPT],
    {
      cwd: repoDir,
      env: {
        ...process.env,
        BASE_SHA: baseSha,
        HEAD_SHA: headSha,
        GITHUB_OUTPUT: githubOutput,
        HOME: repoDir,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        PATH: process.env.PATH,
      },
      encoding: "utf8",
    }
  );
  const output = readFileSync(githubOutput, "utf8");
  const match = output.match(/^docs-only=(true|false)$/m);
  return {
    docsOnly: match?.[1] === "true",
    exitCode: result.status ?? 1,
  };
}

/** Create a scratch git repo, return helpers. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "agend-detect-changes-"));
  dirs.push(dir);
  const env = {
    ...process.env,
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@x.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@x.invalid",
  };
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (path: string, text: string) => {
    const full = join(dir, path);
    const parts = full.split("/");
    // ensure parent directory exists
    const { mkdirSync } = require("node:fs");
    mkdirSync(parts.slice(0, -1).join("/"), { recursive: true });
    writeFileSync(full, text);
  };
  const commit = (msg: string, files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) write(p, t);
    git("add", "-A");
    git("commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  return { dir, git, commit, run: (b: string, h: string) => run(dir, b, h) };
}

describe("detect-changes: docs-only classification", () => {
  it("docs/ change only → docs-only=true", () => {
    const r = makeRepo();
    const base = r.commit("init", { "src/a.ts": "1\n", "docs/features.md": "v1\n" });
    r.git("checkout", "-q", "-b", "pr");
    const head = r.commit("docs", { "docs/features.md": "v2\n" });
    expect(r.run(base, head).docsOnly).toBe(true);
  });

  it("changes/ fragment → docs-only=true", () => {
    const r = makeRepo();
    const base = r.commit("init", { "src/a.ts": "1\n" });
    r.git("checkout", "-q", "-b", "pr");
    const head = r.commit("frag", { "changes/100.md": "---\nsection: Fixed\n---\n- x\n", "changes/100.zh-TW.md": "---\nsection: Fixed\n---\n- y\n" });
    expect(r.run(base, head).docsOnly).toBe(true);
  });

  it("src/ change → docs-only=false", () => {
    const r = makeRepo();
    const base = r.commit("init", { "src/a.ts": "1\n" });
    r.git("checkout", "-q", "-b", "pr");
    const head = r.commit("src", { "src/a.ts": "2\n" });
    expect(r.run(base, head).docsOnly).toBe(false);
  });

  it(".github/ change → docs-only=false even if only other files are docs", () => {
    const r = makeRepo();
    const base = r.commit("init", { "docs/a.md": "1\n" });
    r.git("checkout", "-q", "-b", "pr");
    const head = r.commit("ci", { "docs/a.md": "2\n", ".github/workflows/ci.yml": "name: CI\n" });
    expect(r.run(base, head).docsOnly).toBe(false);
  });
});

describe("P3a regression: large diff does not fail-open via SIGPIPE", () => {
  it("5 000 src/ files (>64 KB pipe buffer) → docs-only=false (not a false positive from SIGPIPE)", () => {
    // The old `git diff --name-only | grep -qvE` and the intermediate
    // `echo "$diff_files" | grep -qvE` caused grep to exit early after
    // finding the first non-matching line; echo got SIGPIPE (exit 141);
    // with pipefail the if took the else-branch → docs-only=true.
    //
    // 200 short paths (~4 KB) fit inside the pipe buffer and never trigger
    // the bug. This test uses 5 000 paths (~225 KB) to reliably overflow
    // the buffer and expose the defect.
    //
    // The fix: write diff_files to a temp file and grep the file directly.
    // When grep exits after a -q match it just stops reading; no echo
    // process is left behind to receive SIGPIPE.
    const r = makeRepo();
    const initFiles: Record<string, string> = { "docs/a.md": "init\n" };
    for (let i = 0; i < 5000; i++) initFiles[`src/subdirectory/nested/file${String(i).padStart(5, "0")}.typescript`] = `// ${i}\n`;
    const base = r.commit("init", initFiles);
    r.git("checkout", "-q", "-b", "pr");
    const prFiles: Record<string, string> = {};
    for (let i = 0; i < 5000; i++) prFiles[`src/subdirectory/nested/file${String(i).padStart(5, "0")}.typescript`] = `// ${i} changed\n`;
    const head = r.commit("large-src-change", prFiles);
    const result = r.run(base, head);
    expect(result.exitCode, "script must not crash").toBe(0);
    expect(result.docsOnly, "5000 src files must be docs-only=false").toBe(false);
  });

  it("P3a mutation: echo-pipe approach is red on large diff (documents the defect the fix closes)", () => {
    // This test proves that the old echo | grep -q pattern IS broken for
    // large diffs, confirming the fix is necessary. If this test starts
    // passing, the mutation has regressed back to the broken approach.
    const r = makeRepo();
    const initFiles: Record<string, string> = {};
    for (let i = 0; i < 5000; i++) initFiles[`src/subdirectory/nested/file${String(i).padStart(5, "0")}.typescript`] = `// ${i}\n`;
    const base = r.commit("init", initFiles);
    r.git("checkout", "-q", "-b", "pr");
    const prFiles: Record<string, string> = {};
    for (let i = 0; i < 5000; i++) prFiles[`src/subdirectory/nested/file${String(i).padStart(5, "0")}.typescript`] = `// ${i} changed\n`;
    const head = r.commit("large", prFiles);
    // Run the BROKEN echo-pipe variant directly to document the defect.
    const { readFileSync, writeFileSync } = require("node:fs");
    const githubOutput = require("node:path").join(r.dir, "github_output_broken.txt");
    writeFileSync(githubOutput, "");
    const brokenScript = `
      set -euo pipefail
      diff_files=$(git diff --name-only "${base}...${head}")
      if echo "$diff_files" | grep -qvE '^(docs|changes)/|^[^/]+\\.md$'; then
        echo "docs-only=false" >> "$GITHUB_OUTPUT"
      else
        echo "docs-only=true" >> "$GITHUB_OUTPUT"
      fi
    `;
    const { spawnSync } = require("node:child_process");
    spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", brokenScript], {
      cwd: r.dir,
      env: { ...process.env, GITHUB_OUTPUT: githubOutput, HOME: r.dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      encoding: "utf8",
    });
    const out = readFileSync(githubOutput, "utf8");
    // The broken approach produces docs-only=true for large src/ diffs.
    expect(out.trim()).toBe("docs-only=true");
  });

  it("mixed docs + src → docs-only=false, not confused by early grep exit", () => {
    const r = makeRepo();
    const base = r.commit("init", { "docs/a.md": "1\n", "src/a.ts": "1\n" });
    r.git("checkout", "-q", "-b", "pr");
    const head = r.commit("mixed", { "docs/a.md": "2\n", "src/a.ts": "2\n" });
    expect(r.run(base, head).docsOnly).toBe(false);
  });
});

describe("P3b regression: git failure is fail-closed (not fail-open)", () => {
  it("missing/invalid BASE_SHA → docs-only=false (full CI)", () => {
    // The old pipe: `git diff | grep -q` with a bad SHA exits 128 from git,
    // which with pipefail propagated through the pipe and made the `if` take
    // the else branch → docs-only=true. The fix catches git failure explicitly.
    const r = makeRepo();
    r.commit("init", { "src/a.ts": "1\n" });
    r.git("checkout", "-q", "-b", "pr");
    const head = r.commit("x", { "src/a.ts": "2\n" });
    // Intentionally bad base SHA
    const result = r.run("0000000000000000000000000000000000000000", head);
    expect(result.exitCode).toBe(0);        // script itself must not crash
    expect(result.docsOnly).toBe(false);    // fail-closed: run full CI
  });

  it("both SHAs missing → docs-only=false", () => {
    const r = makeRepo();
    r.commit("init", { "src/a.ts": "1\n" });
    const result = r.run("", "");
    expect(result.exitCode).toBe(0);
    expect(result.docsOnly).toBe(false);
  });
});
