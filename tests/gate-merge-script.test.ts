/**
 * scripts/gate-merge.sh (fleet decision e723a50a): the coordinator's merge gate.
 *
 * Every case runs the real script with bash, from a clone whose `origin` is a scratch bare repository (real git:
 * refs/pull/<n>/head is pushed there as GitHub would expose it). `gh` is a stub on PATH that answers from a JSON state
 * file and records every call, so the order of retarget → merge → delete can be asserted. Nothing reaches GitHub.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts", "gate-merge.sh");
const REPO = "songsid/AgEnD";
const PRISM = "agend-reviewer-t1503382598640996543";
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// The gh stub: `pr view|list|edit|merge` and `api` (check-runs, DELETE ref), from state.json; calls → calls.log.
const GH_STUB = String.raw`#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const dir = path.dirname(process.argv[1]);
const statePath = path.join(dir, "state.json");
const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), args.join(" ") + "\n");
const save = () => fs.writeFileSync(statePath, JSON.stringify(st));
const out = v => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
const fail = m => { process.stderr.write(m + "\n"); process.exit(1); };
const opt = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (args[0] === "pr" && args[1] === "view") {
  const pr = st.prs[args[2]]; if (!pr) fail("no such PR");
  if ((st.viewFails ?? []).includes(Number(args[2])) || (st.viewFailsAfterMerge && st.merged)) fail("HTTP 502");
  out(pr);
}
if (args[0] === "pr" && args[1] === "list") {
  const base = opt("--base");
  out(Object.entries(st.prs).filter(([, p]) => p.state === "OPEN" && p.baseRefName === base).map(([n]) => ({ number: Number(n) })));
}
if (args[0] === "pr" && args[1] === "edit") {
  if ((st.failEdit ?? []).includes(Number(args[2]))) fail("edit refused");
  if (!(st.ignoreEdit ?? []).includes(Number(args[2]))) st.prs[args[2]].baseRefName = opt("--base");
  save();
  // Applied, but the answer was lost.
  if ((st.editAppliedButFails ?? []).includes(Number(args[2]))) fail("HTTP 502 (after the write)");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "merge") {
  const pr = st.prs[args[2]];
  if (st.failMerge) fail(st.failMerge);
  if (opt("--match-head-commit") !== pr.headRefOid) fail("Head branch was modified. Review and try the merge again.");
  if (!args.includes("--squash")) fail("not squash");
  pr.state = "MERGED"; pr.mergeCommit = { oid: "f".repeat(40) }; st.merged = true; save();
  if (st.mergeAppliedButFails) fail("HTTP 502 (after the merge)");
  process.exit(0);
}
if (args[0] === "api" && args[1] === "-X" && args[2] === "DELETE") { process.exit(st.failDelete ? 1 : 0); }
if (args[0] === "api" && /\/rules\/branches\//.test(args[1])) { if (st.failRules) fail("HTTP 500"); out(st.rules ?? []); }
if (args[0] === "api") {
  const m = /commits\/([0-9a-f]{40})\/check-runs/.exec(args[1]);
  if (m) { const runs = st.checkRuns[m[1]] ?? []; out({ total_count: st.totalCount ?? runs.length, check_runs: runs }); }
}
fail("unexpected gh " + args.join(" "));
`;

type Pr = { state: string; isDraft: boolean; headRefOid: string; headRefName: string; baseRefName: string; isCrossRepository: boolean; mergeCommit?: { oid: string } };
type State = {
  prs: Record<string, Pr>; checkRuns: Record<string, unknown[]>; failMerge?: string; failEdit?: number[]; ignoreEdit?: number[]; totalCount?: number;
  failDelete?: boolean; rules?: unknown[]; failRules?: boolean; viewFails?: number[]; viewFailsAfterMerge?: boolean; merged?: boolean;
  editAppliedButFails?: number[]; mergeAppliedButFails?: boolean;
};

// main's gate: every required check, green.
const REQUIRED = ["build", "scan", "CodeQL", "Analyze (javascript-typescript)", "Analyze (actions)"];
const green = (ok: (name: string, id?: number) => unknown, from: number) => REQUIRED.map((name, i) => ok(name, from + i));

function world() {
  const dir = mkdtempSync(join(tmpdir(), "agend-gate-"));
  dirs.push(dir);
  const env = { ...process.env, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const sh = (cwd: string, ...args: string[]) => {
    const res = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
    return res.stdout.trim();
  };
  const origin = join(dir, "origin.git"), dev = join(dir, "dev"), work = join(dir, "work"), bin = join(dir, "bin");
  mkdirSync(bin);
  sh(dir, "init", "-q", "--bare", "-b", "main", origin);
  sh(dir, "init", "-q", "-b", "main", dev);
  sh(dev, "remote", "add", "origin", origin);
  const commit = (message: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(dev, path)), { recursive: true }); writeFileSync(join(dev, path), text); }
    sh(dev, "add", "-A"); sh(dev, "commit", "-q", "-m", message);
    return sh(dev, "rev-parse", "HEAD");
  };
  commit("init", { "src/a.ts": "a1\n", "tests/a.test.ts": "t1\n", "docs/x.md": "d1\n", "scripts/x.sh": "s1\n" });
  sh(dev, "push", "-q", "origin", "main");
  sh(dev, "checkout", "-q", "-b", "feature");
  const approved = commit("feat", { "src/a.ts": "a2\n", "tests/a.test.ts": "t2\n" });
  // Publish: main, the PR branch, and GitHub's refs/pull/7/head.
  const publish = (pr = 7, ref = "feature") => { sh(dev, "push", "-q", "-f", "origin", `HEAD:refs/heads/${ref}`, `HEAD:refs/pull/${pr}/head`); return sh(dev, "rev-parse", "HEAD"); };
  publish();
  sh(dir, "clone", "-q", origin, work);
  writeFileSync(join(bin, "gh"), GH_STUB); chmodSync(join(bin, "gh"), 0o755);
  const ok = (name: string, id = 1) => ({ id, name, status: "completed", conclusion: "success" });
  const state: State = {
    prs: { 7: { state: "OPEN", isDraft: false, headRefOid: approved, headRefName: "feature", baseRefName: "main", isCrossRepository: false } },
    checkRuns: { [approved]: green(ok, 1) },
  };
  const saveState = () => writeFileSync(join(bin, "state.json"), JSON.stringify(state));
  const approval = (content: string, overrides: Record<string, unknown> = {}) => JSON.stringify({ items: [{
    message_id: "xmsg-approve-1", source_instance: PRISM, target_instance: "agend-coordinator-kiro", state: "delivered",
    content, content_sha256: createHash("sha256").update(content, "utf8").digest("hex"), ...overrides,
  }] });
  const approveText = (sha: string, pr = 7) => `APPROVE — PR #${pr} @${sha}（GH exact head、CI 5/5 SUCCESS）。\nNotes: none.`;
  // GIT_FAIL_ON: a regex over git's arguments; a matching call fails (a stand-in for a git read failure).
  writeFileSync(join(bin, "git"), `#!/bin/bash\nif [ -n "\${GIT_FAIL_ON:-}" ] && [[ " $* " =~ $GIT_FAIL_ON ]]; then echo "fatal: injected" >&2; exit 128; fi\nexec ${spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim()} "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  let extraEnv: Record<string, string> = {};
  const setEnv = (e: Record<string, string>) => { extraEnv = e; };
  const run = (args: string[], input?: string) => {
    saveState();
    writeFileSync(join(bin, "calls.log"), "");
    const res = spawnSync("bash", [SCRIPT, ...args], {
      cwd: work, input: input ?? approval(approveText(state.prs[7]!.headRefOid)), encoding: "utf8",
      env: { ...env, ...extraEnv, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
    });
    const calls = readFileSync(join(bin, "calls.log"), "utf8").split("\n").filter(Boolean);
    Object.assign(state, JSON.parse(readFileSync(join(bin, "state.json"), "utf8")));
    // The private fetch refs never outlive a run, whatever its verdict.
    expect(sh(work, "for-each-ref", "--format=%(refname)", "refs/gate")).toBe("");
    return { status: res.status, line: res.stdout, lines: res.stdout.split("\n").filter(Boolean), stderr: res.stderr, calls };
  };
  const writes = (calls: string[]) => calls.filter(c => /^pr (merge|edit)|^api -X DELETE/.test(c));
  return { dir, dev, work, sh, commit, publish, approved, state, ok, approval, approveText, run, writes, setEnv };
}

describe("gate-merge: the happy path and the one-line verdict", () => {
  it("head = approved, CI green → squash-merges with --match-head-commit, deletes the branch, prints MERGED <sha>", () => {
    const w = world();
    const r = w.run(["7", w.approved, "xmsg-approve-1"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines).toEqual([`MERGED ${"f".repeat(40)}`]);
    expect(w.writes(r.calls)).toEqual([
      `pr merge 7 -R ${REPO} --squash --match-head-commit ${w.approved}`,
      `api -X DELETE repos/${REPO}/git/refs/heads/feature`,
    ]);
    // Private refs only: the clone's own branches are untouched, and the gate refs are cleaned up.
    expect(w.sh(w.work, "for-each-ref", "--format=%(refname)", "refs/gate")).toBe("");
    expect(w.sh(w.work, "branch", "--format=%(refname:short)")).toBe("main");
  });

  it("--dry-run runs every check and changes nothing → WOULD_MERGE <head>", () => {
    const w = world();
    w.state.prs[8] = { ...w.state.prs[7]!, headRefName: "feature-2", baseRefName: "feature" };
    const r = w.run(["--dry-run", "7", w.approved, "xmsg-approve-1"]);
    expect(r.status).toBe(0);
    expect(r.lines).toEqual([`WOULD_MERGE ${w.approved}`]);
    expect(r.stderr).toContain("would retarget #8");
    expect(w.writes(r.calls)).toEqual([]);
  });

  it("the delivery JSON can come from a file", () => {
    const w = world();
    const file = join(w.dir, "approval.json");
    writeFileSync(file, w.approval(w.approveText(w.approved)));
    expect(w.run(["--dry-run", "--delivery-json", file, "7", w.approved, "xmsg-approve-1"], "").lines).toEqual([`WOULD_MERGE ${w.approved}`]);
  });
});

describe("gate-merge: the approval must be verified", () => {
  const cases: [string, (w: ReturnType<typeof world>) => string, RegExp][] = [
    ["Delivery not found (not JSON)", () => "Delivery not found", /not JSON/],
    ["no delivery with that message_id", w => w.approval(w.approveText(w.approved), { message_id: "xmsg-other" }), /0 deliveries/],
    ["not from the reviewer", w => w.approval(w.approveText(w.approved), { source_instance: "agend-dev-claude-t1" }), /not agend-reviewer/],
    ["content tampered (sha256 mismatch)", w => w.approval(w.approveText(w.approved), { content_sha256: "0".repeat(64) }), /content_sha256/],
    ["no APPROVE", w => w.approval(`LGTM — PR #7 @${w.approved}`), /no line "APPROVE — PR #<pr> @<sha>"/],
    ["REQUEST_CHANGES", w => w.approval(`REQUEST_CHANGES — PR #7 @${w.approved}; APPROVE after the fix`), /no line "APPROVE/],
    ["another PR (#70)", w => w.approval(w.approveText(w.approved, 70)), /are for #70 /],
    ["another SHA", w => w.approval(w.approveText("a".repeat(40))), /are for #7 @aaaaaaaaaaaa, not #7/],
    ["a SHA prefix only", w => w.approval(`APPROVE — PR #7 @${w.approved.slice(0, 12)}`), /no line "APPROVE/],
    ["a longer hex run around the SHA", w => w.approval(`APPROVE — PR #7 @${w.approved}0`), /no line "APPROVE/],
    // Prism #1334 r1: the approval names another PR; this PR and SHA appear only in a sentence that blocks it.
    ["another PR's verdict, this PR mentioned as blocked", w => w.approval(`APPROVE — PR #8 @${"b".repeat(40)}\nPR #7 @${w.approved} is BLOCKED: security review pending.`), /are for #8 /],
    ["the verdict quoted", w => w.approval(`> APPROVE — PR #7 @${w.approved}\nThat was last round; not yet.`), /no line "APPROVE/],
    ["the verdict negated", w => w.approval(`Not APPROVE — PR #7 @${w.approved}`), /no line "APPROVE/],
    ["APPROVE and PR on one line, the SHA on the next", w => w.approval(`APPROVE — PR #7\n@${w.approved}`), /no line "APPROVE/],
  ];
  it.each(cases)("%s → BLOCKED, nothing written", (_label, delivery, why) => {
    const w = world();
    const r = w.run(["7", w.approved, "xmsg-approve-1"], delivery(w));
    expect(r.status).toBe(1);
    expect(r.lines).toHaveLength(1);
    expect(r.line).toMatch(/^BLOCKED approval not verified: /);
    expect(r.line).toMatch(why);
    expect(w.writes(r.calls)).toEqual([]);
  });

  it.each([
    ["the usual form", (sha: string) => `APPROVE — PR #7 @${sha}（GH exact head）`],
    ["no dash, no PR, no @", (sha: string) => `APPROVE #7 ${sha}`],
    ["a colon", (sha: string) => `APPROVE: PR #7 @${sha} — CI 5/5`],
    ["one verdict line among several, for several PRs", (sha: string) => `Round 2.\nAPPROVE — PR #1333 @${"c".repeat(40)}\nAPPROVE — PR #7 @${sha}\nThanks.`],
  ])("an approval verdict: %s → accepted", (_label, text) => {
    const w = world();
    const r = w.run(["--dry-run", "7", w.approved, "xmsg-approve-1"], w.approval(text(w.approved)));
    expect(r.lines, r.stderr).toEqual([`WOULD_MERGE ${w.approved}`]);
  });

  it("bad arguments → exit 2 before anything runs", () => {
    const w = world();
    for (const args of [["7", w.approved.slice(0, 12), "x"], ["seven", w.approved, "x"], ["7", w.approved], ["--force", "7", w.approved, "x"]]) {
      const r = w.run(args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.calls).toEqual([]);
    }
  });
});

describe("gate-merge: the PR state", () => {
  it.each([["CLOSED", false], ["MERGED", false], ["OPEN", true]] as const)("%s%s → BLOCKED", (state, draft) => {
    const w = world();
    Object.assign(w.state.prs[7]!, { state, isDraft: draft });
    const r = w.run(["7", w.approved, "xmsg-approve-1"]);
    expect(r.status).toBe(1);
    expect(r.line).toMatch(draft ? /draft/ : new RegExp(`is ${state}`));
    expect(w.writes(r.calls)).toEqual([]);
  });

  it("gh's head and the fetched refs/pull head disagree → BLOCKED (moved while gating)", () => {
    const w = world();
    w.commit("more", { "src/a.ts": "a3\n" });
    w.publish();                                                            // origin moved; gh still says approved
    const r = w.run(["7", w.approved, "xmsg-approve-1"]);
    expect(r.line).toMatch(/^BLOCKED #7 moved while gating/);
  });
});

describe("gate-merge: a head that moved after the approval", () => {
  const moved = (w: ReturnType<typeof world>, head: string) => {
    w.state.prs[7]!.headRefOid = head;
    w.state.checkRuns[head] = green(w.ok, 11);
  };

  it("docs/ and changes/ only → carried (tree), merged at the new head", () => {
    const w = world();
    const head = w.commit("docs", { "docs/x.md": "d2\n", "changes/7.md": "---\nsection: Fixed\n---\n- x\n" });
    w.publish(); moved(w, head);
    const r = w.run(["7", w.approved, "xmsg-approve-1"], w.approval(w.approveText(w.approved)));
    expect(r.status, r.line + r.stderr).toBe(0);
    expect(r.stderr).toContain("tree-identical");
    expect(w.writes(r.calls)[0]).toBe(`pr merge 7 -R ${REPO} --squash --match-head-commit ${head}`);
  });

  it("a merge-sync of main (main changed src/) → carried (own change from the merge-base)", () => {
    const w = world();
    w.sh(w.dev, "checkout", "-q", "main");
    w.commit("main moves", { "src/b.ts": "b\n", "scripts/x.sh": "s2\n" });
    w.sh(w.dev, "push", "-q", "origin", "main");
    w.sh(w.dev, "checkout", "-q", "feature");
    w.sh(w.dev, "merge", "-q", "--no-edit", "main");
    const head = w.publish(); moved(w, head);
    const r = w.run(["7", w.approved, "xmsg-approve-1"], w.approval(w.approveText(w.approved)));
    expect(r.status, r.line + r.stderr).toBe(0);
    expect(r.stderr).toContain("own-change-identical");
  });

  it.each([
    ["src/", { "src/a.ts": "a3\n" }, "src/a.ts"],
    ["tests/", { "tests/a.test.ts": "t3\n" }, "tests/a.test.ts"],
    ["scripts/ (code outside src and tests)", { "scripts/x.sh": "s9\n" }, "scripts/x.sh"],
    ["a workflow", { ".github/workflows/ci.yml": "on: push\n" }, ".github/workflows/ci.yml"],
  ])("a change in %s → NEEDS_REVIEW with the path, exit 3, nothing written", (_label, files, path) => {
    const w = world();
    const head = w.commit("after approval", files);
    w.publish(); moved(w, head);
    const r = w.run(["7", w.approved, "xmsg-approve-1"], w.approval(w.approveText(w.approved)));
    expect(r.status).toBe(3);
    expect(r.lines).toEqual([`NEEDS_REVIEW ${path}`]);
    expect(w.writes(r.calls)).toEqual([]);
  });

  it("a merge-sync plus a src change → NEEDS_REVIEW names only the PR's own changed file", () => {
    const w = world();
    w.sh(w.dev, "checkout", "-q", "main");
    w.commit("main moves", { "src/b.ts": "b\n" });
    w.sh(w.dev, "push", "-q", "origin", "main");
    w.sh(w.dev, "checkout", "-q", "feature");
    w.sh(w.dev, "merge", "-q", "--no-edit", "main");
    const head = w.commit("and a fix", { "tests/a.test.ts": "t4\n" });
    w.publish(); moved(w, head);
    const r = w.run(["7", w.approved, "xmsg-approve-1"], w.approval(w.approveText(w.approved)));
    expect(r.lines).toEqual(["NEEDS_REVIEW tests/a.test.ts"]);
  });

  // Prism #1334 r1: git patch-id ignores whitespace, so these would have been carried.
  it.each([
    ["a space inside a string", { "src/a.ts": "a2 \n" }, "src/a.ts"],
    ["indentation (Python, YAML)", { "scripts/x.sh": " s1\n" }, "scripts/x.sh"],
    ["a regex's whitespace", { "tests/a.test.ts": "t2\t\n" }, "tests/a.test.ts"],
  ])("a whitespace-only change that means something — %s → NEEDS_REVIEW", (_label, files, path) => {
    const w = world();
    const head = w.commit("after approval", files);
    w.publish(); moved(w, head);
    const r = w.run(["7", w.approved, "xmsg-approve-1"], w.approval(w.approveText(w.approved)));
    expect(r.status).toBe(3);
    expect(r.lines).toEqual([`NEEDS_REVIEW ${path}`]);
  });

  it("a merge-sync that shifts the PR's hunk (main added lines above it in the same file) → still carried", () => {
    const w = world();
    const long = (top: string, mid: string) => `${top}${Array.from({ length: 20 }, (_, i) => (i === 10 ? mid : `line ${i}`)).join("\n")}\n`;
    // Re-approve on a base that has the long file, so the PR's own change is one hunk in the middle of it.
    w.sh(w.dev, "checkout", "-q", "main");
    w.commit("long file", { "src/long.ts": long("", "line 10") });
    w.sh(w.dev, "push", "-q", "origin", "main");
    w.sh(w.dev, "checkout", "-q", "feature");
    w.sh(w.dev, "merge", "-q", "--no-edit", "main");
    const approved = w.commit("change the middle", { "src/long.ts": long("", "line 10 changed") });
    w.publish(); moved(w, approved);
    w.sh(w.dev, "checkout", "-q", "main");
    w.commit("main adds lines at the top", { "src/long.ts": long("// header\n// more\n", "line 10") });
    w.sh(w.dev, "push", "-q", "origin", "main");
    w.sh(w.dev, "checkout", "-q", "feature");
    w.sh(w.dev, "merge", "-q", "--no-edit", "main");
    const head = w.publish(); moved(w, head);
    const r = w.run(["7", approved, "xmsg-approve-1"], w.approval(w.approveText(approved)));
    expect(r.status, r.line + r.stderr).toBe(0);
    expect(r.stderr).toContain("own-change-identical");
  });

  it.each([
    ["the fingerprint diff", " diff --binary ", /git failed fingerprinting/],
    ["the tree comparison", " diff --quiet ", /git diff of the approved and current heads failed/],
    ["the ancestry check", " merge-base --is-ancestor ", /git merge-base --is-ancestor failed/],
  ])("git failing in %s → BLOCKED, never carried or merged", (_label, failOn, why) => {
    const w = world();
    const head = w.commit("after approval", { "src/a.ts": "a3\n" });
    w.publish(); moved(w, head);
    w.setEnv({ GIT_FAIL_ON: failOn });
    const r = w.run(["7", w.approved, "xmsg-approve-1"], w.approval(w.approveText(w.approved)));
    expect(r.status).toBe(1);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(why);
    expect(w.writes(r.calls)).toEqual([]);
  });

  it("a rewritten history (the approved SHA is not an ancestor) → NEEDS_REVIEW", () => {
    const w = world();
    w.sh(w.dev, "reset", "-q", "--hard", "main");
    const head = w.commit("rewritten", { "src/a.ts": "a2\n", "tests/a.test.ts": "t2\n" });
    w.publish(); moved(w, head);
    const r = w.run(["7", w.approved, "xmsg-approve-1"], w.approval(w.approveText(w.approved)));
    expect(r.status).toBe(3);
    expect(r.line).toMatch(/^NEEDS_REVIEW .*(does not descend|not in #7's history)/);
  });

  it("an approved SHA that does not exist → NEEDS_REVIEW", () => {
    const w = world();
    const ghost = "c".repeat(40);
    const r = w.run(["7", ghost, "xmsg-approve-1"], w.approval(w.approveText(ghost)));
    expect(r.status).toBe(3);
    expect(r.line).toMatch(/not in #7's history/);
  });
});

describe("gate-merge: merge-synced and green", () => {
  it("behind the base (main moved, not merged in) → BLOCKED", () => {
    const w = world();
    w.sh(w.dev, "checkout", "-q", "main");
    w.commit("main moves", { "src/b.ts": "b\n" });
    w.sh(w.dev, "push", "-q", "origin", "main");
    const r = w.run(["7", w.approved, "xmsg-approve-1"]);
    expect(r.status).toBe(1);
    expect(r.line).toMatch(/^BLOCKED #7 is behind main/);
  });

  it.each([
    ["a failed run", (w: ReturnType<typeof world>) => [w.ok("build", 1), { id: 2, name: "scan", status: "completed", conclusion: "failure" }], /scan=failure/],
    ["a run still going", (w: ReturnType<typeof world>) => [w.ok("build", 1), { id: 2, name: "scan", status: "in_progress", conclusion: null }], /scan=in_progress/],
    ["skipped is not success", (w: ReturnType<typeof world>) => [{ id: 2, name: "build", status: "completed", conclusion: "skipped" }], /build=skipped/],
    ["no runs at all", () => [], /build=missing/],
    // Prism #1334 r1: only some jobs registered so far — the rest of main's gate has not run.
    ["only scan registered, green", (w: ReturnType<typeof world>) => [w.ok("scan", 2)], /build=missing,CodeQL=missing,Analyze \(javascript-typescript\)=missing,Analyze \(actions\)=missing/],
    ["everything but build", (w: ReturnType<typeof world>) => green(w.ok, 1).filter((r: any) => r.name !== "build"), /^BLOCKED CI on \S+: build=missing$/],
    ["an older green run, the latest red", (w: ReturnType<typeof world>) => [w.ok("build", 1), { id: 9, name: "build", status: "completed", conclusion: "failure" }], /build=failure/],
  ])("%s → BLOCKED", (_label, runs, why) => {
    const w = world();
    w.state.checkRuns[w.approved] = runs(w);
    const r = w.run(["7", w.approved, "xmsg-approve-1"]);
    expect(r.status).toBe(1);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^BLOCKED CI on /);
    expect(r.lines[0]).toMatch(why);
    expect(w.writes(r.calls)).toEqual([]);
  });

  it("a check a ruleset of the base requires must have run too", () => {
    const w = world();
    w.state.rules = [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "e2e" }] } }];
    expect(w.run(["7", w.approved, "xmsg-approve-1"]).line).toMatch(/^BLOCKED CI on \S+: e2e=missing/);
    w.state.checkRuns[w.approved]!.push(w.ok("e2e", 50));
    expect(w.run(["--dry-run", "7", w.approved, "xmsg-approve-1"]).lines).toEqual([`WOULD_MERGE ${w.approved}`]);
  });

  it("GATE_REQUIRED_CHECKS replaces the default list; unreadable rules → BLOCKED", () => {
    const w = world();
    w.state.checkRuns[w.approved] = [w.ok("unit", 1)];
    w.setEnv({ GATE_REQUIRED_CHECKS: "unit" });
    expect(w.run(["--dry-run", "7", w.approved, "xmsg-approve-1"]).lines).toEqual([`WOULD_MERGE ${w.approved}`]);
    w.state.failRules = true;
    expect(w.run(["--dry-run", "7", w.approved, "xmsg-approve-1"]).line).toMatch(/^BLOCKED the rules of main are unreadable/);
  });

  it("a re-run: the older run failed, the latest passed → merged", () => {
    const w = world();
    w.state.checkRuns[w.approved] = [{ id: 0, name: "build", status: "completed", conclusion: "failure" }, ...green(w.ok, 5)];
    expect(w.run(["7", w.approved, "xmsg-approve-1"]).status).toBe(0);
  });

  it("more runs than one page holds → BLOCKED (a partial list never passes)", () => {
    const w = world();
    w.state.totalCount = 101;
    expect(w.run(["7", w.approved, "xmsg-approve-1"]).line).toMatch(/^BLOCKED CI on .*101 check-runs, read 5/);
  });
});

describe("gate-merge: stacked PRs (never delete a branch another PR is based on)", () => {
  const stacked = () => {
    const w = world();
    w.state.prs[8] = { state: "OPEN", isDraft: false, headRefOid: "e".repeat(40), headRefName: "feature-2", baseRefName: "feature", isCrossRepository: false };
    return w;
  };

  it("retargets the dependent to this PR's base first, then merges, then deletes the branch", () => {
    const w = stacked();
    const r = w.run(["7", w.approved, "xmsg-approve-1"]);
    expect(r.status, r.stderr).toBe(0);
    expect(w.writes(r.calls)).toEqual([
      `pr edit 8 -R ${REPO} --base main`,
      `pr merge 7 -R ${REPO} --squash --match-head-commit ${w.approved}`,
      `api -X DELETE repos/${REPO}/git/refs/heads/feature`,
    ]);
    expect(w.state.prs[8]!.baseRefName).toBe("main");
  });

  it("a dependent still on the branch after the merge → the branch is kept", () => {
    const w = stacked();
    w.state.ignoreEdit = [8];
    const r = w.run(["7", w.approved, "xmsg-approve-1"]);
    expect(r.status).toBe(0);
    expect(r.calls.some(c => c.startsWith("api -X DELETE"))).toBe(false);
    expect(r.stderr).toContain("kept feature");
  });

  it("a retarget refused → BLOCKED, the ones already done are put back, no merge", () => {
    const w = stacked();
    w.state.prs[9] = { ...w.state.prs[8]!, headRefName: "feature-3" };
    w.state.failEdit = [9];
    const r = w.run(["7", w.approved, "xmsg-approve-1"]);
    expect(r.status).toBe(1);
    expect(r.line).toMatch(/^BLOCKED could not retarget #9/);
    expect(w.writes(r.calls)).toEqual([`pr edit 8 -R ${REPO} --base main`, `pr edit 9 -R ${REPO} --base main`, `pr edit 8 -R ${REPO} --base feature`]);
    expect(w.state.prs[8]!.baseRefName).toBe("feature");
  });

  it("the merge refused (head modified) → BLOCKED, the retarget is put back, the branch stays", () => {
    const w = stacked();
    w.state.failMerge = "Head branch was modified. Review and try the merge again.";
    const r = w.run(["7", w.approved, "xmsg-approve-1"]);
    expect(r.status).toBe(1);
    expect(r.line).toBe("BLOCKED merge failed: Head branch was modified. Review and try the merge again.\n");
    expect(w.writes(r.calls)).toEqual([
      `pr edit 8 -R ${REPO} --base main`,
      `pr merge 7 -R ${REPO} --squash --match-head-commit ${w.approved}`,
      `pr edit 8 -R ${REPO} --base feature`,
    ]);
  });

  // Prism #1334 r1: a write that happened but whose answer was lost is read back, not taken at gh's word.
  it("a retarget that applied but reported failure counts as done; a later genuine failure puts it back too", () => {
    const w = stacked();
    w.state.prs[9] = { ...w.state.prs[8]!, headRefName: "feature-3" };
    w.state.editAppliedButFails = [8];
    w.state.failEdit = [9];
    const r = w.run(["7", w.approved, "xmsg-approve-1"]);
    expect(r.status).toBe(1);
    expect(r.lines[0]).toMatch(/^BLOCKED could not retarget #9/);
    expect(w.state.prs[8]!.baseRefName).toBe("feature");                  // put back, though gh said its retarget failed
    expect(r.calls.some(c => c.startsWith("pr merge"))).toBe(false);
  });

  it("a retarget that applied but reported failure, then the merge → MERGED, the dependent on main", () => {
    const w = stacked();
    w.state.editAppliedButFails = [8];
    const r = w.run(["7", w.approved, "xmsg-approve-1"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("#8: gh reported a failure, but its base is now main");
    expect(w.state.prs[8]!.baseRefName).toBe("main");
  });

  it("a retarget that failed and whose base is unreadable → BLOCKED uncertain, nothing reverted", () => {
    const w = stacked();
    w.state.prs[9] = { ...w.state.prs[8]!, headRefName: "feature-3" };
    w.state.failEdit = [9]; w.state.viewFails = [9];
    const r = w.run(["7", w.approved, "xmsg-approve-1"]);
    expect(r.lines[0]).toMatch(/^BLOCKED uncertain: retargeting #9 failed and its base is unreadable; nothing reverted \(done: 8\)/);
    expect(w.writes(r.calls)).toEqual([`pr edit 8 -R ${REPO} --base main`, `pr edit 9 -R ${REPO} --base main`]);
  });

  it("a merge that happened but reported failure → MERGED, no rollback", () => {
    const w = stacked();
    w.state.mergeAppliedButFails = true;
    const r = w.run(["7", w.approved, "xmsg-approve-1"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines).toEqual([`MERGED ${"f".repeat(40)}`]);
    expect(r.stderr).toContain("gh pr merge reported a failure, but #7 is MERGED");
    expect(w.state.prs[8]!.baseRefName).toBe("main");
    expect(r.calls.filter(c => c === `pr edit 8 -R ${REPO} --base feature`)).toEqual([]);
  });

  it("a merge whose outcome cannot be read back → BLOCKED uncertain, the retarget is not reverted", () => {
    const w = stacked();
    w.state.mergeAppliedButFails = true; w.state.viewFailsAfterMerge = true;
    const r = w.run(["7", w.approved, "xmsg-approve-1"]);
    expect(r.status).toBe(1);
    expect(r.lines[0]).toMatch(/^BLOCKED uncertain: gh pr merge failed and #7 is unreadable; nothing reverted \(retargeted: 8\)/);
    expect(w.writes(r.calls)).toEqual([`pr edit 8 -R ${REPO} --base main`, `pr merge 7 -R ${REPO} --squash --match-head-commit ${w.approved}`]);
  });

  it("a PR from a fork: same-named branches here are not its dependents, and nothing is deleted", () => {
    const w = stacked();
    w.state.prs[7]!.isCrossRepository = true;
    const r = w.run(["7", w.approved, "xmsg-approve-1"]);
    expect(r.status).toBe(0);
    expect(w.writes(r.calls)).toEqual([`pr merge 7 -R ${REPO} --squash --match-head-commit ${w.approved}`]);
  });
});
