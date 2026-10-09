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
fs.appendFileSync(path.join(dir, "calls.log"), args.filter((a, i) => a !== "--body-file" && args[i-1] !== "--body-file").join(" ") + "\n");
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
  const base = opt("--base"), head = opt("--head");
  out(Object.entries(st.prs).filter(([, p]) => head ? p.headRefName === head : p.state === "OPEN" && p.baseRefName === base).map(([n,p]) => head ? {number: Number(n), ...p} : {number: Number(n)}));
}
if (args[0] === "pr" && args[1] === "edit") {
  if ((st.failEdit ?? []).includes(Number(args[2]))) fail("edit refused");
  if (!(st.ignoreEdit ?? []).includes(Number(args[2]))) st.prs[args[2]].baseRefName = opt("--base");
  save();
  // Applied, but the answer was lost.
  if ((st.editAppliedButFails ?? []).includes(Number(args[2]))) fail("HTTP 502 (after the write)");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  const cp = require("node:child_process");
  const h = cp.execFileSync("git", ["--git-dir", st.origin, "rev-parse", "refs/heads/"+opt("--head")], {encoding:"utf8"}).trim();
  st.prs[99] = {state:"OPEN",isDraft:false,headRefOid:h,headRefName:opt("--head"),baseRefName:opt("--base"),isCrossRepository:false};
  st.checkRuns[h] = st.autoRevertGreen ? st.greenRuns : [];
  save();
  if (st.createAppliedButFails) fail("lost create ACK");
  process.stdout.write("https://example.invalid/pull/99"); process.exit(0);
}
if (args[0] === "pr" && args[1] === "merge") {
  const pr = st.prs[args[2]];
  if (st.failMerge) fail(st.failMerge);
  if (opt("--match-head-commit") !== pr.headRefOid) fail("Head branch was modified. Review and try the merge again.");
  if (!args.includes("--squash")) fail("not squash");
  let merged = "f".repeat(40);
  if (st.actualMerge) {
    const cp = require("node:child_process"), server = path.join(dir,"server");
    const git = (...a) => cp.execFileSync("git", a, {cwd:server,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
    if (!fs.existsSync(server)) cp.execFileSync("git", ["clone","-q",st.origin,server]);
    git("fetch","-q","origin"); git("checkout","-q","-B","merge-work","origin/"+pr.baseRefName);
    git("merge","--squash","origin/"+pr.headRefName);
    const body = opt("--body-file") ? fs.readFileSync(opt("--body-file"),"utf8") : "automatic revert";
    git("commit","-q","-m","Squash #"+args[2]+"\n\n"+body);
    merged = git("rev-parse","HEAD"); git("push","-q","origin","HEAD:refs/heads/"+pr.baseRefName);
    st.commitMetadata ??= {}; st.commitMetadata[merged] = {sha:merged,parents:[{sha:git("rev-parse","HEAD^")}],commit:{message:git("show","-s","--format=%B","HEAD")}};
  }
  pr.state = "MERGED"; pr.mergeCommit = { oid: merged }; st.merged = true; save();
  if (st.mergeAppliedButFails) fail("HTTP 502 (after the merge)");
  process.exit(0);
}
if (args[0] === "api" && args[1] === "-X" && args[2] === "DELETE") { process.exit(st.failDelete ? 1 : 0); }
if (args[0] === "api" && /\/rules\/branches\//.test(args[1])) { if (st.failRules) fail("HTTP 500"); out(st.rules ?? []); }
if (args[0] === "api") {
  if (args[1].includes("actions/runs")) { if(st.failMainCi) fail("CI unavailable"); out(st.mainCi); }
  const c = /commits\/([0-9a-f]{40})$/.exec(args[1]); if(c) {if(st.commitMetadata?.[c[1]]) out(st.commitMetadata[c[1]]); fail("no commit metadata");}
  const m = /commits\/([0-9a-f]{40})\/check-runs/.exec(args[1]);
  if (m) { if(st.moveMainAfterChecks) { require("node:child_process").execFileSync("git", ["--git-dir",st.origin,"update-ref","refs/heads/main",st.moveMainAfterChecks]); delete st.moveMainAfterChecks; save(); } const runs = st.checkRuns[m[1]] ?? []; out({ total_count: st.totalCount ?? runs.length, check_runs: runs }); }
}
fail("unexpected gh " + args.join(" "));
`;

type Pr = { state: string; isDraft: boolean; headRefOid: string; headRefName: string; baseRefName: string; isCrossRepository: boolean; mergeCommit?: { oid: string } };
type State = {
  prs: Record<string, Pr>; checkRuns: Record<string, unknown[]>; failMerge?: string; failEdit?: number[]; ignoreEdit?: number[]; totalCount?: number;
  failDelete?: boolean; rules?: unknown[]; failRules?: boolean; viewFails?: number[]; viewFailsAfterMerge?: boolean; merged?: boolean;
  editAppliedButFails?: number[]; mergeAppliedButFails?: boolean;
  actualMerge?: boolean; origin?: string; greenRuns?: unknown[]; autoRevertGreen?: boolean; mainCi?: unknown; failMainCi?: boolean;
  commitMetadata?: Record<string, any>; createAppliedButFails?: boolean; moveMainAfterChecks?: string;
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
    origin, greenRuns: green(ok, 1),
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
  const writes = (calls: string[]) => calls.filter(c => /^pr (merge|edit|create)|^api -X DELETE/.test(c));
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
  it("behind main with disjoint paths → admitted without sync", () => {
    const w = world();
    w.sh(w.dev, "checkout", "-q", "main");
    w.commit("main moves", { "src/b.ts": "b\n" });
    w.sh(w.dev, "push", "-q", "origin", "main");
    const r = w.run(["7", w.approved, "xmsg-approve-1"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.line).toMatch(/^MERGED /);
    expect(r.stderr).toContain("merged behind main, disjoint");
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

  // ── #gate-1348: CodeQL optional for release/** base ──────────────────────────────────────────────────────────

  it("release/* base + only build+scan green (no CodeQL) → WOULD_MERGE (#gate-1348)", () => {
    const w = world();
    // Set PR base to release/2.1 — fetch also needs the ref; push it on origin.
    w.sh(w.dev, "checkout", "-q", "main");
    w.sh(w.dev, "push", "-q", "origin", "HEAD:refs/heads/release/2.1");
    w.state.prs[7]!.baseRefName = "release/2.1";
    // Only build and scan are present (no CodeQL/Analyze).
    w.state.checkRuns[w.approved] = [w.ok("build", 1), w.ok("scan", 2)];
    const r = w.run(["--dry-run", "7", w.approved, "xmsg-approve-1"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines).toEqual([`WOULD_MERGE ${w.approved}`]);
  });

  it("release/* base + no build → BLOCKED even without CodeQL (#gate-1348)", () => {
    const w = world();
    w.sh(w.dev, "checkout", "-q", "main");
    w.sh(w.dev, "push", "-q", "origin", "HEAD:refs/heads/release/2.1");
    w.state.prs[7]!.baseRefName = "release/2.1";
    // scan only — no build.
    w.state.checkRuns[w.approved] = [w.ok("scan", 2)];
    const r = w.run(["--dry-run", "7", w.approved, "xmsg-approve-1"]);
    expect(r.status).toBe(1);
    expect(r.line).toMatch(/^BLOCKED CI on \S+: build=missing/);
  });

  it("main base + no CodeQL → still BLOCKED (base=main behaviour unchanged) (#gate-1348 mutation)", () => {
    // Mutation check: removing the release check makes the release-base test above pass for main too,
    // but this test ensures the original main behaviour is kept.
    const w = world();
    // base is main (the default in world()); provide build+scan only.
    w.state.checkRuns[w.approved] = [w.ok("build", 1), w.ok("scan", 2)];
    const r = w.run(["--dry-run", "7", w.approved, "xmsg-approve-1"]);
    expect(r.status).toBe(1);
    expect(r.line).toMatch(/CodeQL=missing/);
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

// User-approved 4e928ba6: preserve all original auth/carry/CI/write-contract assertions above.
describe("gate workflow 1480: reviewer prefixes and disjoint bases", () => {
  it.each(["agend-reviewer-t1", "claude-fable-t1"])("default prefix admits %s", source_instance => {
    const w = world();
    const r = w.run(["--dry-run", "7", w.approved, "xmsg-approve-1"], w.approval(w.approveText(w.approved), { source_instance }));
    expect(r.lines).toEqual([`WOULD_MERGE ${w.approved}`]);
  });
  it.each(["xclaude-fable-t1", "claude-fable", "agend-dev-sol", ""])("non-allowlisted %s refused", source_instance => {
    const w = world();
    const r = w.run(["7", w.approved, "xmsg-approve-1"], w.approval(w.approveText(w.approved), { source_instance }));
    expect(r.status).toBe(1); expect(w.writes(r.calls)).toEqual([]);
  });
  it("trims custom comma prefixes and refuses empty effective lists", () => {
    const w = world();
    w.setEnv({ GATE_APPROVER: " alpha- , beta- " });
    const d = w.approval(w.approveText(w.approved), { source_instance: "beta-1" });
    expect(w.run(["--dry-run", "7", w.approved, "xmsg-approve-1"], d).status).toBe(0);
    for (const value of ["", " , "]) {
      w.setEnv({ GATE_APPROVER: value });
      const r = w.run(["7", w.approved, "xmsg-approve-1"], d);
      expect(r.status).toBe(1); expect(w.writes(r.calls)).toEqual([]);
    }
  });
  it.each(["src/a.ts", "package.json", "package-lock.json", ".github/workflows/new.yml"])("overlap/global %s still requires sync", file => {
    const w = world(); w.sh(w.dev, "checkout", "-q", "main");
    w.commit("main moves", { [file]: "new\n" }); w.sh(w.dev, "push", "-q", "origin", "main");
    const r = w.run(["7", w.approved, "xmsg-approve-1"]);
    expect(r.status).toBe(1); expect(r.line).toContain("merge-sync first"); expect(r.line).toContain(file); expect(w.writes(r.calls)).toEqual([]);
  });
  it.each(["source", "destination", "unrelated"])("main rename counts both ends: %s", kind => {
    const w = world(); w.sh(w.dev, "checkout", "-q", "main");
    if (kind === "source") w.sh(w.dev, "mv", "src/a.ts", "src/moved.ts");
    else if (kind === "destination") w.sh(w.dev, "mv", "-f", "docs/x.md", "src/a.ts");
    else w.sh(w.dev, "mv", "docs/x.md", "docs/renamed.md");
    w.commit("rename", {}); w.sh(w.dev, "push", "-q", "origin", "main");
    const r = w.run(["--dry-run", "7", w.approved, "xmsg-approve-1"]);
    expect(r.status).toBe(kind === "unrelated" ? 0 : 1);
    if (kind !== "unrelated") expect(r.line).toContain("src/a.ts");
  });
  it("PR rename destination and deleted source both count", () => {
    const w = world(); w.sh(w.dev, "mv", "src/a.ts", "src/renamed.ts");
    const head = w.commit("rename", {}); w.publish(); w.state.prs[7]!.headRefOid = head; w.state.checkRuns[head] = green(w.ok, 1);
    w.sh(w.dev, "checkout", "-q", "main"); w.commit("destination", { "src/renamed.ts": "unrelated\n" }); w.sh(w.dev, "push", "-q", "origin", "main");
    const r = w.run(["7", head, "xmsg-approve-1"]);
    expect(r.status).toBe(1); expect(r.line).toContain("src/renamed.ts");
  });
  it("a new overlap appearing during CI reads is refused at the final merge boundary", () => {
    const w = world(); w.sh(w.dev,"checkout","-q","main");
    w.state.moveMainAfterChecks = w.commit("late main", {"src/a.ts":"late\n"});
    w.sh(w.dev,"push","-q","origin","main:refs/heads/future");
    const r = w.run(["7",w.approved,"xmsg-approve-1"]);
    expect(r.status).toBe(1); expect(r.line).toContain("base moved or overlaps"); expect(w.writes(r.calls)).toEqual([]);
  });
  it("disjoint diff read failure never grants an exemption", () => {
    const w = world(); w.sh(w.dev, "checkout", "-q", "main"); w.commit("main", { "src/b.ts": "b\n" }); w.sh(w.dev, "push", "-q", "origin", "main");
    w.setEnv({ GIT_FAIL_ON: "diff --name-only -z" });
    const r = w.run(["7", w.approved, "xmsg-approve-1"]);
    expect(r.status).toBe(1); expect(r.line).toContain("cannot read changed paths"); expect(w.writes(r.calls)).toEqual([]);
  });
});

function mergedWorld() {
  const w = world(); w.state.actualMerge = true;
  const r = w.run(["7", w.approved, "xmsg-approve-1"]);
  expect(r.status, r.stderr + r.line).toBe(0);
  expect(r.stderr).not.toContain("receipt could not be verified");
  const merged = w.state.prs[7]!.mergeCommit!.oid;
  const ci = (status: string, conclusion: string | null, extras: Record<string, unknown> = {}) => {
    w.state.mainCi = { total_count: 1, workflow_runs: [{ id: 100, workflow_id: 1, run_attempt: 1, head_sha: merged, head_branch: "main", event: "push", status, conclusion, ...extras }] };
  };
  ci("completed", "failure");
  const post = () => w.run(["--post-merge-check", merged]);
  return { ...w, merged, ci, post, receipt: join(w.work, ".git", "agend-gate", `${merged}.json`) };
}

describe("gate workflow 1480: exact main CI and private single-squash revert", () => {
  it("failed main CI creates one real single-commit revert and waits for exact-head CI, then merges once", () => {
    const w = mergedWorld();
    const first = w.post(); expect(first.status, first.stderr + first.line).toBe(0); expect(first.line).toMatch(/^REVERT_PENDING #99 /);
    expect(first.calls.filter(c => c.startsWith("pr create"))).toHaveLength(1);
    expect(first.calls.filter(c => c.startsWith("pr merge"))).toEqual([]);
    const head = w.state.prs[99]!.headRefOid;
    expect(w.sh(w.work, "rev-list", "--parents", "-n", "1", head)).toBe(`${head} ${w.merged}`);
    expect(w.sh(w.work, "show", `${head}:src/a.ts`)).toBe("a1");
    const again = w.post(); expect(again.line).toBe(first.line); expect(w.writes(again.calls)).toEqual([]);
    w.state.checkRuns[head] = green(w.ok, 20);
    const done = w.post(); expect(done.status, done.stderr + done.line).toBe(0); expect(done.line).toMatch(/^REVERTED [a-f0-9]{40}/);
    expect(w.writes(done.calls)).toEqual([`pr merge 99 -R ${REPO} --squash --match-head-commit ${head}`]);
    expect(w.post().line).toBe(done.line); expect(w.writes(w.post().calls)).toEqual([]);
  });
  it.each([
    ["running", "in_progress", null, {}, "PENDING"],
    ["success", "completed", "success", {}, "HEALTHY"],
    ["cancelled", "completed", "cancelled", {}, "BLOCKED"],
    ["skipped", "completed", "skipped", {}, "BLOCKED"],
    ["wrong sha", "completed", "failure", { head_sha: "a".repeat(40) }, "BLOCKED"],
    ["wrong branch", "completed", "failure", { head_branch: "feature" }, "BLOCKED"],
    ["wrong event", "completed", "failure", { event: "pull_request" }, "BLOCKED"],
  ] as const)("%s main CI causes no writes", (_name, status, conclusion, extras, prefix) => {
    const w = mergedWorld(); w.ci(status, conclusion, extras);
    const r = w.post(); expect(r.line).toMatch(new RegExp(`^${prefix} `)); expect(w.writes(r.calls)).toEqual([]); expect(w.state.prs[99]).toBeUndefined();
  });
  it.each(["unreadable", "empty", "partial", "later success"])("%s failure evidence cannot cause revert", kind => {
    const w = mergedWorld();
    if (kind === "unreadable") w.state.failMainCi = true;
    else if (kind === "empty") w.state.mainCi = { total_count: 0, workflow_runs: [] };
    else if (kind === "partial") w.state.mainCi = { total_count: 101, workflow_runs: [{id:100,workflow_id:1,run_attempt:1,head_sha:w.merged,head_branch:"main",event:"push",status:"completed",conclusion:"failure"}] };
    else w.state.mainCi = { total_count: 2, workflow_runs: [
      {id:100,workflow_id:1,run_attempt:1,head_sha:w.merged,head_branch:"main",event:"push",status:"completed",conclusion:"failure"},
      {id:101,workflow_id:1,run_attempt:1,head_sha:w.merged,head_branch:"main",event:"push",status:"completed",conclusion:"success"},
    ]};
    const r = w.post(); expect(w.writes(r.calls)).toEqual([]); expect(r.line).toMatch(/^(BLOCKED|HEALTHY) /);
  });
  it("success in one workflow cannot mask an exact failure in another", () => {
    const w = mergedWorld(); w.state.mainCi = {total_count:2,workflow_runs:[
      {id:100,workflow_id:1,head_sha:w.merged,head_branch:"main",event:"push",status:"completed",conclusion:"failure"},
      {id:101,workflow_id:2,head_sha:w.merged,head_branch:"main",event:"push",status:"completed",conclusion:"success"},
    ]};
    const r=w.post(); expect(r.line).toMatch(/^REVERT_PENDING/); expect(r.calls.filter(c=>c.startsWith("pr create"))).toHaveLength(1);
  });
  it.each(["absent", "wrong repo", "wrong parent", "wrong operation", "not main", "revert kind"])("%s receipt refuses automatic revert", kind => {
    const w = mergedWorld(); const data = JSON.parse(readFileSync(w.receipt, "utf8"));
    if (kind === "absent") rmSync(w.receipt);
    else { if(kind === "wrong repo") data.repo = "other/repo"; if(kind === "wrong parent") data.parent = w.approved; if(kind === "wrong operation") data.op = "a".repeat(48); if(kind === "not main") data.base = "feature"; if(kind === "revert kind") data.kind = "revert"; writeFileSync(w.receipt, JSON.stringify(data)); }
    const r = w.post(); expect(r.status).toBe(1); expect(w.writes(r.calls)).toEqual([]);
  });
  it("a non-gate commit is refused even when its CI fails", () => {
    const w = mergedWorld();
    const r = w.run(["--post-merge-check", w.approved]); expect(r.status).toBe(1); expect(w.writes(r.calls)).toEqual([]);
  });
  it("a lost PR-create response resumes the same recorded proposal", () => {
    const w = mergedWorld(); w.state.createAppliedButFails = true;
    expect(w.post().status).toBe(1); expect(w.state.prs[99]).toBeDefined();
    w.state.createAppliedButFails = false; const r = w.post();
    expect(r.line).toMatch(/^REVERT_PENDING #99 /); expect(w.writes(r.calls)).toEqual([]);
  });
  it.each(["failed CI", "skipped CI", "missing CodeQL", "changed head", "retargeted", "original now green"])("%s revert cannot be landed", kind => {
    const w = mergedWorld(); expect(w.post().line).toMatch(/^REVERT_PENDING/); const p = w.state.prs[99]!;
    w.state.checkRuns[p.headRefOid] = green(w.ok, 20);
    if(kind === "failed CI" || kind === "skipped CI") w.state.checkRuns[p.headRefOid]!.push({id:99,name:"extra",status:"completed",conclusion:kind === "failed CI" ? "failure" : "skipped"});
    if(kind === "missing CodeQL") w.state.checkRuns[p.headRefOid] = green(w.ok,20).filter((r:any) => r.name !== "CodeQL");
    if(kind === "changed head") p.headRefOid = w.approved;
    if(kind === "retargeted") p.baseRefName = "feature";
    if(kind === "original now green") w.ci("completed","success");
    const r = w.post(); expect(w.writes(r.calls)).toEqual([]); expect(r.line).not.toMatch(/^REVERTED/);
  });
  it("changed remote revert content cannot acquire the recorded ownership", () => {
    const w = mergedWorld(); expect(w.post().line).toMatch(/^REVERT_PENDING/);
    const p = w.state.prs[99]!; w.state.checkRuns[p.headRefOid] = green(w.ok,20);
    w.sh(w.dev,"fetch","-q","origin"); w.sh(w.dev,"checkout","-q","-B","edited","origin/"+p.headRefName);
    w.commit("manual changes", {"src/b.ts":"not a revert\n"}); w.sh(w.dev,"push","-q","origin",`HEAD:refs/heads/${p.headRefName}`);
    const r = w.post(); expect(r.status).toBe(1); expect(r.line).toContain("revert branch changed"); expect(w.writes(r.calls)).toEqual([]);
  });
  it("unreadable revert rules and checks never authorize a merge", () => {
    const w = mergedWorld(); expect(w.post().line).toMatch(/^REVERT_PENDING/); w.state.failRules = true;
    const r = w.post(); expect(r.status).toBe(1); expect(w.writes(r.calls)).toEqual([]);
  });
  it("a public-readable receipt is not operator authority", () => {
    const w = mergedWorld(); chmodSync(w.receipt,0o644);
    const r = w.post(); expect(r.status).toBe(1); expect(w.writes(r.calls)).toEqual([]);
  });
  it("an existing claim blocks a concurrent invocation", () => {
    const w = mergedWorld(); mkdirSync(join(dirname(w.receipt), `lock-${w.merged}`), {mode:0o700});
    const r = w.post(); expect(r.status).toBe(1); expect(w.writes(r.calls)).toEqual([]);
  });
  it("main conflicts prevent a revert branch from being pushed", () => {
    const w = mergedWorld(); w.sh(w.dev, "fetch", "-q", "origin"); w.sh(w.dev, "checkout", "-q", "-B", "main", "origin/main");
    w.commit("later same-path change", {"src/a.ts":"later\n"}); w.sh(w.dev,"push","-q","origin","main");
    const r = w.post(); expect(r.status).toBe(1); expect(w.writes(r.calls)).toEqual([]);
    expect(w.sh(w.dev,"ls-remote","--heads","origin",`refs/heads/gate-revert/${w.merged}`)).toBe("");
  });
});
