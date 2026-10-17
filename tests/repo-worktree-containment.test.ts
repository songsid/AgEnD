/**
 * release_repo / checkout_repo path containment: an instance creates and removes git worktrees only inside its own
 * `<instanceDir>/repos`, and removes only a directory git confirms is a linked worktree. Everything else is refused,
 * and nothing refused is ever deleted.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CHECKOUTS_FILE, checkoutTarget, releaseCandidate, verifyWorktree } from "../src/repo-worktree-guard.js";
import { Daemon } from "../src/daemon.js";

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const gitAsync = async (args: string[], cwd: string) => git(args, cwd);

let base: string, instanceDir: string, repos: string, source: string, outside: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "repo-guard-")));
  instanceDir = join(base, "instances", "w"); repos = join(instanceDir, "repos"); mkdirSync(repos, { recursive: true });
  source = join(base, "src-repo"); mkdirSync(source);
  git(["init", "-q", "-b", "main"], source); writeFileSync(join(source, "f"), "x"); git(["add", "f"], source); git(["commit", "-q", "-m", "c"], source);
  outside = join(base, "precious"); mkdirSync(outside); writeFileSync(join(outside, "keep"), "do not delete");
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

async function release(path: unknown) {
  let result: unknown, error: string | undefined;
  await (Daemon.prototype as any).handleReleaseRepo.call({ instanceDir }, { path }, (r: unknown, e?: string) => { result = r; error = e; });
  return { result, error };
}
async function checkout(branch = "main") {
  let result: any, error: string | undefined;
  await (Daemon.prototype as any).handleCheckoutRepo.call({ instanceDir }, { source, branch }, (r: unknown, e?: string) => { result = r; error = e; });
  return { result, error };
}

describe("release_repo containment", () => {
  it("happy path: a recorded checkout is removed, unregistered from its repository and forgotten", async () => {
    const co = await checkout();
    expect(co.error).toBeUndefined();
    const path = co.result.path as string;
    expect(path).toBe(join(realpathSync(repos), "src-repo-main"));
    expect(JSON.parse(readFileSync(join(repos, CHECKOUTS_FILE), "utf8"))[path]).toBe(realpathSync(join(source, ".git")));
    const r = await release(path);
    expect(r).toEqual({ result: { released: true, path }, error: undefined });
    expect(existsSync(path)).toBe(false);
    expect(git(["worktree", "list", "--porcelain"], source)).not.toContain(path);
    expect(JSON.parse(readFileSync(join(repos, CHECKOUTS_FILE), "utf8"))[path]).toBeUndefined();
  });

  it.each([
    ["repos/../..", () => join(repos, "..", "..")],
    ["repos-x sibling", () => { const p = join(instanceDir, "repos-x", "a"); mkdirSync(p, { recursive: true }); return p; }],
    ["an absolute path elsewhere", () => outside],
    // A real, listed worktree of the same repository — only containment stops it.
    ["another instance's checkout", () => { const p = join(base, "instances", "other", "repos", "src-repo-main"); mkdirSync(join(base, "instances", "other", "repos"), { recursive: true }); git(["worktree", "add", "-q", "--detach", p, "main"], source); writeFileSync(join(p, "keep"), "do not delete"); return p; }],
    ["the repos directory itself", () => repos],
    ["relative climbing", () => "../../../precious"],
  ])("%s is refused and nothing is deleted", async (_name, make) => {
    const path = make();
    expect(releaseCandidate(instanceDir, path).ok).toBe(false);
    const r = await release(path);
    expect(r.result).toBeNull(); expect(r.error).toMatch(/^Cannot release: /);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("do not delete");
    expect(existsSync(repos)).toBe(true); expect(existsSync(source)).toBe(true);
    if (typeof path === "string" && path.includes("other")) expect(readFileSync(join(path, "keep"), "utf8")).toBe("do not delete");
  });

  it("a symlink inside repos/ pointing outside is refused, and its target survives", async () => {
    const link = join(repos, "escape"); symlinkSync(outside, link);
    expect(releaseCandidate(instanceDir, link)).toEqual({ ok: false, reason: "not a checkout directory" });
    expect((await release(link)).error).toMatch(/^Cannot release: /);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("do not delete");
  });

  it("a real directory reached through a symlinked parent inside repos/ resolves outside and is refused", async () => {
    mkdirSync(join(outside, "sub")); symlinkSync(outside, join(repos, "hop"));
    const path = join(repos, "hop", "sub");
    expect(releaseCandidate(instanceDir, path)).toEqual({ ok: false, reason: "path outside the instance repos directory" });
    expect((await release(path)).error).toMatch(/^Cannot release: /);
    expect(existsSync(join(outside, "sub"))).toBe(true);
  });

  it("a contained directory that is not a linked worktree is not removed", async () => {
    const plain = join(repos, "plain"); mkdirSync(plain); writeFileSync(join(plain, "data"), "keep");
    const main = join(repos, "own-main"); mkdirSync(main); git(["init", "-q"], main); writeFileSync(join(main, "data"), "keep");
    for (const p of [plain, main]) {
      expect(releaseCandidate(instanceDir, p).ok).toBe(true);
      expect((await release(p)).error).toMatch(/^Cannot release: not (a git worktree|a linked git worktree)/);
      expect(readFileSync(join(p, "data"), "utf8")).toBe("keep");
    }
  });

  it("a subdirectory of a worktree is not the worktree", async () => {
    const co = await checkout(); const sub = join(co.result.path, "nested"); mkdirSync(sub);
    expect(await verifyWorktree(realpathSync(repos), sub, gitAsync)).toEqual({ ok: false, reason: "not the top of a git worktree" });
    expect((await release(sub)).error).toMatch(/^Cannot release: /);
    expect(existsSync(co.result.path)).toBe(true);
  });

  it("a recorded path now holding another repository's worktree is refused", async () => {
    const co = await checkout(); const path = co.result.path as string;
    writeFileSync(join(repos, CHECKOUTS_FILE), JSON.stringify({ [path]: join(base, "some-other-repo", ".git") }));
    expect((await release(path)).error).toBe("Cannot release: a different repository than the one checked out");
    expect(existsSync(path)).toBe(true);
  });

  it("an unrecorded checkout from before records were kept is released when its repository lists it", async () => {
    const path = join(realpathSync(repos), "legacy"); git(["worktree", "add", "-q", "--detach", path, "main"], source);
    expect((await release(path)).result).toEqual({ released: true, path });
    expect(existsSync(path)).toBe(false);
  });

  it("a copy of a worktree (its .git file still pointing at the original's) is not a worktree of that repository", async () => {
    const path = join(realpathSync(repos), "legacy"); git(["worktree", "add", "-q", "--detach", path, "main"], source);
    const copy = join(realpathSync(repos), "copy"); execFileSync("cp", ["-r", path, copy]); writeFileSync(join(copy, "data"), "keep");
    expect((await release(copy)).error).toMatch(/^Cannot release: /);
    expect(readFileSync(join(copy, "data"), "utf8")).toBe("keep");
  });

  it("a symlinked repos/ directory is refused outright", async () => {
    rmSync(repos, { recursive: true }); symlinkSync(outside, repos);
    expect(releaseCandidate(instanceDir, join(repos, "keep")).ok).toBe(false);
    expect((await release(join(repos, "keep"))).error).toMatch(/^Cannot release: /);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("do not delete");
  });
});

describe("checkout_repo containment", () => {
  it("creates a fresh direct child of repos/ only", () => {
    expect(checkoutTarget(instanceDir, source, "main")).toEqual({ ok: true, path: join(realpathSync(repos), "src-repo-main") });
    mkdirSync(join(repos, "src-repo-main"));
    expect(checkoutTarget(instanceDir, source, "main")).toEqual({ ok: false, reason: "a checkout already exists at that path" });
  });
  it("refuses through a symlinked repos/ (it would write outside)", async () => {
    rmSync(repos, { recursive: true }); symlinkSync(outside, repos);
    expect(checkoutTarget(instanceDir, source, "main").ok).toBe(false);
    const co = await checkout();
    expect(co.result).toBeNull(); expect(co.error).toMatch(/^checkout_repo: /);
    expect(existsSync(join(outside, "src-repo-main"))).toBe(false);
  });
  it("a branch with slashes still names one direct child", () => {
    expect(checkoutTarget(instanceDir, source, "feat/a/b")).toEqual({ ok: true, path: join(realpathSync(repos), "src-repo-feat-a-b") });
  });
});
