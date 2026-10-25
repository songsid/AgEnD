/**
 * Regressions for scripts/ci/detect-changes.sh (ci.yml's detect-changes job).
 *
 *   P3a — pipefail+SIGPIPE fail-open: the old `git diff | grep -q` treated a
 *         large src/ change as docs-only.
 *   P3b — git failure fail-open: a bad SHA ran the fast path.
 *
 * Fail closed: unreadable diffs and non-pull_request events run the full suite
 * (text-only=false, packaging/deps/src=true).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rm as rmAsync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname ?? import.meta.url.replace(/\/[^/]+$/, ""), "..");
const SCRIPT = join(ROOT, "scripts", "ci", "detect-changes.sh");

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

type Flags = {
  docsOnly: boolean;
  textOnly: boolean;
  packaging: boolean;
  deps: boolean;
  src: boolean;
  exitCode: number;
};

function flag(output: string, name: string): boolean {
  const m = output.match(new RegExp(`^${name}=(true|false)$`, "m"));
  return m?.[1] === "true";
}

/** Run detect-changes.sh with given BASE/HEAD SHAs in a git repo. */
function run(repoDir: string, baseSha: string, headSha: string, eventName = "pull_request"): Flags {
  const githubOutput = join(repoDir, "github_output.txt");
  writeFileSync(githubOutput, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", SCRIPT], {
    cwd: repoDir,
    env: {
      ...process.env,
      EVENT_NAME: eventName,
      BASE_SHA: baseSha,
      HEAD_SHA: headSha,
      GITHUB_OUTPUT: githubOutput,
      HOME: repoDir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      PATH: process.env.PATH,
    },
    encoding: "utf8",
  });
  const output = readFileSync(githubOutput, "utf8");
  return {
    docsOnly: flag(output, "docs-only"),
    textOnly: flag(output, "text-only"),
    packaging: flag(output, "packaging"),
    deps: flag(output, "deps"),
    src: flag(output, "src"),
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
  // The 5,000-file cases otherwise start detached auto-GC while afterAll
  // removes their repositories. Scratch fixtures must own all their work.
  git("config", "gc.auto", "0");
  git("config", "maintenance.auto", "false");
  return { dir, git, commit, run: (b: string, h: string, event?: string) => run(dir, b, h, event) };
}

describe("detect-changes: docs-only classification", () => {
  // #1932: tests read docs/ and the root READMEs (docs/cli.zh-TW.md's command table, docs/features*, README.md …),
  // so a change there must run the suite. #1929 changed a docs/cli.zh-TW.md row a test pins and merged red.
  it.each([
    ["the docs/cli.zh-TW.md row #1929 changed", { "docs/cli.zh-TW.md": "v2\n" }],
    ["docs/features.md", { "docs/features.md": "v2\n" }],
    ["a root README", { "README.md": "v2\n" }],
    ["docs/ plus a changelog fragment", { "docs/features.md": "v2\n", "changes/9.md": "---\nsection: Fixed\n---\n- x\n" }],
    // #1933 review: under changes/, only a fragment the assembler takes counts — a test pins changes/README.md.
    ["changes/README.md edited", { "changes/README.md": "v2\n" }],
    ["a file under changes/ that is not a fragment name", { "changes/notes/1.md": "x\n" }],
  ])("%s → docs-only=false (the tests run)", (_n, files) => {
    const r = makeRepo();
    const base = r.commit("init", { "src/a.ts": "1\n", "docs/features.md": "v1\n", "docs/cli.zh-TW.md": "v1\n", "README.md": "v1\n", "changes/README.md": "v1\n" });
    r.git("checkout", "-q", "-b", "pr");
    const head = r.commit("docs", files);
    expect(r.run(base, head).docsOnly).toBe(false);
  });

  it("deleting changes/README.md alone → docs-only=false (#1933 review: a test asserts it exists)", () => {
    const r = makeRepo();
    const base = r.commit("init", { "src/a.ts": "1\n", "changes/README.md": "v1\n", "changes/1.md": "x\n" });
    r.git("checkout", "-q", "-b", "pr");
    r.git("rm", "-q", "changes/README.md");
    r.git("commit", "-q", "-m", "drop readme");
    const head = r.git("rev-parse", "HEAD").trim();
    expect(r.run(base, head).docsOnly).toBe(false);
  });

  it.each([
    ["an issue fragment pair", { "changes/100.md": "x\n", "changes/100.zh-TW.md": "y\n" }],
    ["a slugged fragment pair", { "changes/1932-ci-docs-run-tests.md": "x\n", "changes/1932-ci-docs-run-tests.zh-TW.md": "y\n" }],
  ])("%s alone → docs-only=true (the fast path stays for real fragments)", (_n, files) => {
    const r = makeRepo();
    const base = r.commit("init", { "src/a.ts": "1\n", "changes/README.md": "v1\n" });
    r.git("checkout", "-q", "-b", "pr");
    const head = r.commit("frag", files);
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
    expect(result.packaging).toBe(true);
    expect(result.deps).toBe(true);
    expect(result.src).toBe(true);
  });
});

describe("detect-changes: text-only / packaging / deps / src", () => {
  it("ci.yml's detect-changes job runs the script and publishes the four flags", () => {
    const ci = yaml.load(readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8")) as {
      jobs: { "detect-changes": { outputs: Record<string, string>; steps: Array<{ id?: string; run?: string }> } };
    };
    const job = ci.jobs["detect-changes"];
    for (const k of ["docs-only", "text-only", "packaging", "deps", "src"]) {
      expect(job.outputs[k]).toBe(`\${{ steps.check.outputs.${k} }}`);
    }
    expect(job.steps.find(s => s.id === "check")?.run).toContain("scripts/ci/detect-changes.sh");
  });

  it("docs/ and a root README are text-only, not packaging", () => {
    const r = makeRepo();
    const base = r.commit("init", { "src/a.ts": "1\n", "docs/cli.md": "v1\n", "README.md": "v1\n" });
    r.git("checkout", "-q", "-b", "pr");
    const head = r.commit("docs", { "docs/cli.md": "v2\n", "README.md": "v2\n" });
    const out = r.run(base, head);
    expect(out).toMatchObject({ textOnly: true, packaging: false, deps: false, src: false, docsOnly: false, exitCode: 0 });
  });

  it("website content pages are text-only; website src/components are not", () => {
    const r = makeRepo();
    const base = r.commit("init", { "website/src/content/docs/docs/web-guide.md": "a\n", "website/src/components/x.ts": "a\n" });
    r.git("checkout", "-q", "-b", "pr");
    const content = r.commit("content", { "website/src/content/docs/docs/web-guide.md": "b\n" });
    expect(r.run(base, content).textOnly).toBe(true);
    const mixed = r.commit("comp", { "website/src/components/x.ts": "b\n" });
    expect(r.run(base, mixed).textOnly).toBe(false);
  });

  it("a changelog fragment is both docs-only and text-only", () => {
    const r = makeRepo();
    const base = r.commit("init", { "src/a.ts": "1\n" });
    r.git("checkout", "-q", "-b", "pr");
    const head = r.commit("frag", { "changes/100.md": "x\n", "changes/100.zh-TW.md": "y\n" });
    expect(r.run(base, head)).toMatchObject({ docsOnly: true, textOnly: true, packaging: false, src: false });
  });

  it("src/** sets src and is not text-only", () => {
    const r = makeRepo();
    const base = r.commit("init", { "src/a.ts": "1\n" });
    r.git("checkout", "-q", "-b", "pr");
    const head = r.commit("src", { "src/a.ts": "2\n" });
    expect(r.run(base, head)).toMatchObject({ src: true, textOnly: false, packaging: false, deps: false });
  });

  it("package.json sets packaging and deps", () => {
    const r = makeRepo();
    const base = r.commit("init", { "package.json": "{}\n", "src/a.ts": "1\n" });
    r.git("checkout", "-q", "-b", "pr");
    const head = r.commit("pkg", { "package.json": "{\"a\":1}\n" });
    expect(r.run(base, head)).toMatchObject({ packaging: true, deps: true, src: false, textOnly: false });
  });

  it("launcher/ is packaging, not deps", () => {
    const r = makeRepo();
    const base = r.commit("init", { "launcher/agend": "1\n" });
    r.git("checkout", "-q", "-b", "pr");
    const head = r.commit("launch", { "launcher/agend": "2\n" });
    expect(r.run(base, head)).toMatchObject({ packaging: true, deps: false, textOnly: false });
  });

  it.each(["push", "schedule", "workflow_dispatch"])("%s events run the full suite even for a docs-only tree", (event) => {
    const r = makeRepo();
    const base = r.commit("init", { "docs/a.md": "1\n" });
    r.git("checkout", "-q", "-b", "pr");
    const head = r.commit("docs", { "docs/a.md": "2\n" });
    expect(r.run(base, head, event)).toMatchObject({
      textOnly: false, packaging: true, deps: true, src: true, docsOnly: false, exitCode: 0,
    });
  });

  it("an empty diff is fail-closed (full suite)", () => {
    const r = makeRepo();
    const sha = r.commit("init", { "src/a.ts": "1\n" });
    expect(r.run(sha, sha)).toMatchObject({
      textOnly: false, packaging: true, deps: true, src: true, docsOnly: false, exitCode: 0,
    });
  });

  it("package-lock.json and website/package.json set packaging and deps", () => {
    const r = makeRepo();
    const base = r.commit("init", { "package-lock.json": "{}\n", "website/package.json": "{}\n" });
    r.git("checkout", "-q", "-b", "pr");
    const lock = r.commit("lock", { "package-lock.json": "{\"a\":1}\n" });
    expect(r.run(base, lock)).toMatchObject({ packaging: true, deps: true, textOnly: false, src: false });
    const site = r.commit("site", { "website/package.json": "{\"a\":1}\n" });
    expect(r.run(base, site)).toMatchObject({ packaging: true, deps: true, textOnly: false });
  });

  it("src/service- and launcher/ are packaging; tests/ and workflows are not text-only", () => {
    const r = makeRepo();
    const base = r.commit("init", {
      "src/service-installer.ts": "1\n",
      "launcher/agend": "1\n",
      "tests/a.test.ts": "1\n",
      ".github/workflows/ci.yml": "name: CI\n",
    });
    r.git("checkout", "-q", "-b", "pr");
    const svc = r.commit("svc", { "src/service-installer.ts": "2\n" });
    expect(r.run(base, svc)).toMatchObject({ packaging: true, src: true, deps: false, textOnly: false });
    const launch = r.commit("launch", { "launcher/agend": "2\n" });
    expect(r.run(base, launch)).toMatchObject({ packaging: true, deps: false, textOnly: false });
    const tests = r.commit("tests", { "tests/a.test.ts": "2\n" });
    expect(r.run(base, tests).textOnly).toBe(false);
    const wf = r.commit("wf", { ".github/workflows/ci.yml": "name: CI\non: push\n" });
    expect(r.run(base, wf).textOnly).toBe(false);
  });

  it("a .github/workflows/data-downgrade.yml diff runs the full suite (src, packaging, deps)", () => {
    const r = makeRepo();
    const base = r.commit("init", {
      "src/a.ts": "1\n",
      ".github/workflows/data-downgrade.yml": "name: old\n",
    });
    r.git("checkout", "-q", "-b", "pr");
    const head = r.commit("wf", { ".github/workflows/data-downgrade.yml": "name: new\n" });
    expect(r.run(base, head)).toMatchObject({
      src: true, packaging: true, deps: true, textOnly: false, docsOnly: false, exitCode: 0,
    });
  });

  it("a scripts/data-downgrade-phase.mjs diff sets src", () => {
    const r = makeRepo();
    const base = r.commit("init", {
      "src/a.ts": "1\n",
      "scripts/data-downgrade-phase.mjs": "1\n",
    });
    r.git("checkout", "-q", "-b", "pr");
    const head = r.commit("script", { "scripts/data-downgrade-phase.mjs": "2\n" });
    expect(r.run(base, head)).toMatchObject({
      src: true, packaging: true, deps: false, textOnly: false, exitCode: 0,
    });
  });
});
