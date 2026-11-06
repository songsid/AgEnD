/**
 * #3160 (P2 of #3153): what Follow agent records and sends.
 * - followStepOf: Claude's Read / Edit / Write / MultiEdit / Grep / Glob / LS, Codex's apply_patch (exact) and shell
 *   reads, searches and listings (best-effort). A search pattern, file contents or an edit's text is never kept.
 * - FollowLog: this turn only, capped, read after a sequence number.
 * - resolveFollowSteps: confined to the agent's folder like the panel's reads — outside, `..`, a symlink (file or
 *   parent) and AgEnD's state are dropped silently; a secret-looking path is sent as hidden.
 * - workspaceFileDiff: one file's patch for highlighting; hidden refused; no repo → none.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOLLOW_LIMITS, FollowLog, followStepOf, resolveFollowSteps, shellStep, applyPatchPaths, type FollowStep } from "../src/workspace-follow.js";
import { workspaceFileDiff, workspaceRoot, WorkspaceError } from "../src/agent-workspace.js";

describe("followStepOf: Claude Code's tool calls", () => {
  it("Read (with its range), Edit / MultiEdit / Write / NotebookEdit, Grep / Glob (path or the folder), LS", () => {
    expect(followStepOf("Read", { file_path: "/w/src/a.ts", offset: 10, limit: 20 })).toEqual({ kind: "read", tool: "Read", paths: ["/w/src/a.ts"], exact: true, range: { from: 10, to: 29 } });
    expect(followStepOf("Read", { file_path: "/w/src/a.ts" })).toEqual({ kind: "read", tool: "Read", paths: ["/w/src/a.ts"], exact: true });
    for (const tool of ["Edit", "MultiEdit", "Write"]) expect(followStepOf(tool, { file_path: "/w/b.ts", old_string: "x", new_string: "y", content: "z" })).toEqual({ kind: "edit", tool, paths: ["/w/b.ts"], exact: true });
    expect(followStepOf("NotebookEdit", { notebook_path: "/w/n.ipynb" })?.kind).toBe("edit");
    expect(followStepOf("Grep", { pattern: "SECRET_TOKEN_123", path: "/w/src" })).toEqual({ kind: "search", tool: "Grep", paths: ["/w/src"], exact: true });
    expect(followStepOf("Glob", { pattern: "**/*.ts" })).toEqual({ kind: "search", tool: "Glob", paths: ["."], exact: true });
    expect(followStepOf("LS", { path: "/w/src" })?.kind).toBe("list");
  });
  it("keeps no pattern, contents or edit text; ignores tools that name no file, and bad input", () => {
    const s = JSON.stringify([followStepOf("Grep", { pattern: "SECRET_TOKEN_123", path: "/w" }), followStepOf("Edit", { file_path: "/w/a", old_string: "PASSWORD=1", new_string: "PASSWORD=2" }),
      followStepOf("Write", { file_path: "/w/a", content: "API_KEY=abc" })]);
    for (const leak of ["SECRET_TOKEN_123", "PASSWORD", "API_KEY"]) expect(s).not.toContain(leak);
    for (const [tool, input] of [["ToolSearch", { query: "ls" }], ["WebFetch", { url: "https://x" }], ["Read", {}], ["Read", { file_path: 7 }], ["Read", { file_path: "a\u0000b" }], ["Edit", null]] as const)
      expect(followStepOf(tool, input), tool).toBeNull();
  });
});

describe("followStepOf: Codex's rollout", () => {
  const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: docs/new.md\n+hi\n*** Delete File: old.txt\n*** Update File: b.ts\n*** Move to: c.ts\n*** End Patch\n";
  it("apply_patch: its file paths, exact — as a custom tool (raw text) or a function call ({ input })", () => {
    expect(applyPatchPaths(patch)).toEqual(["src/a.ts", "docs/new.md", "old.txt", "b.ts", "c.ts"]);
    expect(followStepOf("apply_patch", patch)).toEqual({ kind: "edit", tool: "apply_patch", paths: ["src/a.ts", "docs/new.md", "old.txt", "b.ts", "c.ts"], exact: true });
    expect(followStepOf("apply_patch", { input: patch })?.paths).toHaveLength(5);
    expect(followStepOf("apply_patch", "no headers")).toBeNull();
  });
  it("shell: reads, searches and listings are best-effort; the search pattern is never kept", () => {
    const sh = (line: string) => followStepOf("shell", { command: ["bash", "-lc", line] });
    expect(sh("sed -n '120,180p' src/web-api.ts")).toEqual({ kind: "read", tool: "shell", paths: ["src/web-api.ts"], exact: false, range: { from: 120, to: 180 } });
    expect(sh("cat a.ts b.ts | head -5")).toEqual({ kind: "read", tool: "shell", paths: ["a.ts", "b.ts"], exact: false });
    expect(sh("nl -ba src/x.ts")?.paths).toEqual(["src/x.ts"]);
    expect(sh("head -n 40 README.md")?.paths).toEqual(["README.md"]);
    const rg = sh("rg -n 'SECRET_TOKEN_123' src tests");
    expect(rg).toEqual({ kind: "search", tool: "shell", paths: ["src", "tests"], exact: false });
    expect(JSON.stringify(rg)).not.toContain("SECRET_TOKEN_123");
    expect(sh("ls -la src")).toEqual({ kind: "list", tool: "shell", paths: ["src"], exact: false });
    expect(sh("ls")?.paths).toEqual(["."]);
    expect(sh("cd other && cat a.ts"), "after a cd the folder is not known").toBeNull();
    expect(sh("npm test")).toBeNull();
    expect(followStepOf("exec_command", { cmd: "cat src/a.ts" })?.paths).toEqual(["src/a.ts"]);
    expect(followStepOf("local_shell", { command: ["cat", "z.txt"] })?.paths).toEqual(["z.txt"]);
    expect(shellStep("sed -n 5p f.txt")?.range).toEqual({ from: 5, to: 5 });
  });
  it("consumes search option values and rejects ambiguous commands instead of treating patterns as paths", () => {
    for (const cmd of ["rg --glob '*.ts' PRIVATE_PATTERN src", "rg -e FIRST -e PRIVATE_PATTERN src", "rg --regexp=PRIVATE_PATTERN src", "grep -n -e PRIVATE_PATTERN src", "rg -g'*.ts' PRIVATE_PATTERN src",
      "rg -- -ePRIVATE_PATTERN src", "rg -- --regexp=PRIVATE_PATTERN src", "rg --glob -e PRIVATE_PATTERN src", "rg --glob --files PRIVATE_PATTERN src"]) {
      const step = shellStep(cmd);
      expect(step?.paths, cmd).toEqual(["src"]);
      expect(JSON.stringify(step), cmd).not.toMatch(/PRIVATE_PATTERN|FIRST|\*\.ts/);
    }
    for (const cmd of ["rg --unknown SECRET src", "grep --files PRIVATE_PATTERN src", "git grep --files PRIVATE_PATTERN src", "rg '$TOKEN' $DIR", "cat $(whoami)", "sed -n 'unterminated", "env SECRET=x cat a", "node -e 'cat a'"])
      expect(shellStep(cmd), cmd).toBeNull();
    expect(followStepOf("exec_command", { cmd: "cat a.ts", workdir: "/other" })?.cwd).toBe("/other");
    expect(followStepOf("Bash", { command: "grep -n NEEDLE src/a.ts" })?.paths).toEqual(["src/a.ts"]);
  });
});

describe("FollowLog: this turn only", () => {
  it("records steps, reads after a sequence number, starts over on a new turn, and keeps at most the cap", () => {
    let now = 1000;
    const log = new FollowLog(() => now++);
    log.record("Read", { file_path: "/w/a" }); log.record("ToolSearch", { query: "ls" }); log.record("Edit", { file_path: "/w/b" });
    const s1 = log.snapshot();
    expect([s1.steps.map((s) => s.kind), s1.last]).toEqual([["read", "edit"], 2]);
    expect(log.snapshot(1, s1.turn).steps.map((s) => s.seq)).toEqual([2]);
    log.newTurn();
    const s2 = log.snapshot(2, s1.turn);
    expect([s2.turn, s2.steps]).toEqual([s1.turn + 1, []]);
    log.record("Read", { file_path: "/w/c" });
    expect(log.snapshot(2, s1.turn).steps.map((s) => s.paths[0]), "another turn: all of this one").toEqual(["/w/c"]);
    for (let i = 0; i < FOLLOW_LIMITS.steps + 5; i++) log.record("Read", { file_path: `/w/f${i}` });
    expect(log.snapshot().steps).toHaveLength(FOLLOW_LIMITS.steps);
    log.record("Read", "not an object");
  });
});

let base: string, work: string;
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "agend-follow-"));
  work = join(base, "work"); mkdirSync(join(work, "src"), { recursive: true }); mkdirSync(join(work, "state"));
  mkdirSync(join(base, "outside"));
  writeFileSync(join(work, "src", "a.ts"), "one\ntwo\nthree\n");
  writeFileSync(join(work, ".env"), "TOKEN=x\n");
  writeFileSync(join(base, "outside", "secret.txt"), "x\n");
  symlinkSync(join(base, "outside", "secret.txt"), join(work, "link.txt"));
  symlinkSync(join(base, "outside"), join(work, "linkdir"));
  execFileSync("git", ["-C", work, "init", "-q"]);
  execFileSync("git", ["-C", work, "-c", "user.email=t@e", "-c", "user.name=t", "add", "src/a.ts"]);
  execFileSync("git", ["-C", work, "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init"]);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));
const step = (paths: string[], kind: FollowStep["kind"] = "read"): FollowStep => ({ seq: 1, at: 1, kind, tool: "Read", paths, exact: true });

describe("resolveFollowSteps: confined like the panel's reads", () => {
  it.each([
    [{ cmd: "rg NEEDLE_LITERAL src # retry NEEDLE_LITERAL" }, ["src"]],
    [{ command: ["grep", "-c", "cat NEEDLE_LITERAL", "README.md"] }, ["README.md"]],
    [{ cmd: "rg 'NEEDLE_LITERAL' 'src/#literal.ts'" }, ["src/#literal.ts"]],
    [{ command: ["/bin/bash", "-lc", "rg 'cat NEEDLE_LITERAL' src"] }, ["src"]],
    [{ cmd: "rg NEEDLE_LITERAL src#literal.ts" }, ["src#literal.ts"]],
    [{ command: ["rg", "NEEDLE_LITERAL", "src", "#literal"] }, ["src", "#literal"]],
  ])("projects only paths from commented commands and literal argv: %j", async (input, expected) => {
    const parsed = followStepOf("local_shell", input);
    expect(parsed).not.toBeNull();
    const safe = await resolveFollowSteps(await workspaceRoot(work, join(work, "state")), [{ ...parsed!, seq: 1, at: 1 }]);
    expect(safe.flatMap(s => s.paths.map(p => p.path))).toEqual(expected);
    expect(JSON.stringify(safe)).not.toContain("NEEDLE_LITERAL");
  });

  it("inside (absolute or relative) → the folder's own path; a directory is marked; a file about to be written is kept", async () => {
    const ws = await workspaceRoot(work, join(work, "state"));
    const r = await resolveFollowSteps(ws, [step([join(work, "src", "a.ts"), "src/a.ts", "src", ".", "src/new-file.ts"])]);
    expect(r[0]!.paths).toEqual([{ path: "src/a.ts", hidden: false, dir: false }, { path: "src", hidden: false, dir: true }, { path: "", hidden: false, dir: true },
      { path: "src/new-file.ts", hidden: false, dir: false }]);
  });
  it("outside, `..`, a symlinked file or parent, and AgEnD's state are dropped (a step left with none is dropped); a secret is hidden", async () => {
    const ws = await workspaceRoot(work, join(work, "state"));
    const r = await resolveFollowSteps(ws, [
      step([join(base, "outside", "secret.txt"), "../outside/secret.txt", "link.txt", "linkdir/secret.txt", "state/x", "/etc/passwd"]),
      step([".env", "src/a.ts"]),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]!.paths).toEqual([{ path: ".env", hidden: true, dir: false }, { path: "src/a.ts", hidden: false, dir: false }]);
  });
  it("binds relative shell paths to the explicit cwd and never returns the cwd itself", async () => {
    const ws = await workspaceRoot(work, join(work, "state"));
    const inside = await resolveFollowSteps(ws, [{ ...step(["a.ts"]), cwd: join(work, "src") }]);
    expect(inside[0]!.paths[0]!.path).toBe("src/a.ts");
    expect(JSON.stringify(inside)).not.toContain(work);
    expect(await resolveFollowSteps(ws, [{ ...step(["src/a.ts"]), cwd: join(base, "outside") }])).toEqual([]);
  });
});

describe("workspaceFileDiff", () => {
  it("a tracked change, an untracked file as an addition; hidden refused; outside a repository nothing", async () => {
    const ws = await workspaceRoot(work, join(work, "state"));
    writeFileSync(join(work, "src", "a.ts"), "one\nTWO\nthree\nfour\n");
    const d = await workspaceFileDiff(ws, "src/a.ts");
    expect([d.repo, d.patch.includes("+TWO"), d.patch.includes("+four")]).toEqual([true, true, true]);
    writeFileSync(join(work, "src", "u.ts"), "u1\nu2\n");
    expect((await workspaceFileDiff(ws, "src/u.ts")).patch).toContain("+u2");
    await expect(workspaceFileDiff(ws, ".env")).rejects.toBeInstanceOf(WorkspaceError);
    await expect(workspaceFileDiff(ws, "link.txt")).rejects.toBeInstanceOf(WorkspaceError);
    const plain = mkdtempSync(join(tmpdir(), "agend-follow-plain-"));
    writeFileSync(join(plain, "f.txt"), "x\n");
    try { expect((await workspaceFileDiff(await workspaceRoot(plain, join(plain, "s")), "f.txt")).repo).toBe(false); }
    finally { rmSync(plain, { recursive: true, force: true }); }
  });
});
