/**
 * #3153 P1: the read-only Files / Changes view of an agent's working directory (src/agent-workspace.ts), on a REAL
 * scratch git repository with the cases the acceptance names: modified, untracked, binary, a symlink escaping the
 * folder, `.env` and other secrets, a big diff, a nested secret directory, `..` and absolute paths, AgEnD's own state
 * inside the folder, and a FIFO.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHiddenPath, workspaceChanges, workspaceFile, workspaceImage, workspaceList, workspaceRoot, WORKSPACE_LIMITS } from "../src/agent-workspace.js";

let dir = "", outside = "", state = "";
const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } });
beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), "agend-ws-3153-"));
  dir = join(base, "work"); outside = join(base, "outside"); state = join(dir, ".agend-state");
  mkdirSync(dir); mkdirSync(outside); mkdirSync(state);
  writeFileSync(join(outside, "secret.txt"), "TOP SECRET outside the folder");
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "app.js"), "const a = 1;\nconsole.log(a);\n");
  writeFileSync(join(dir, ".gitignore"), "build/\n*.log\n");
  writeFileSync(join(dir, "big.txt"), "x\n");
  writeFileSync(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "util.ts"), "export const x = 1;\n");
  git("add", "."); git("commit", "-q", "-m", "init");
  // The working state: modified, untracked, binary, big, secrets, a symlink out, ignored, AgEnD state.
  writeFileSync(join(dir, "app.js"), "const a = 2;\nconsole.log(a);\nconsole.log('more');\n");
  writeFileSync(join(dir, "notes.md"), "# New file\n\nhello\n");
  writeFileSync(join(dir, "blob.bin"), Buffer.from([1, 2, 0, 3, 4, 0, 5]));
  writeFileSync(join(dir, "big.txt"), Array.from({ length: 200_000 }, (_, i) => `line ${i} ${"y".repeat(20)}`).join("\n"));
  writeFileSync(join(dir, ".env"), "API_KEY=sk-should-never-leave\n");
  writeFileSync(join(dir, ".env.local"), "TOKEN=nope\n");
  writeFileSync(join(dir, "server.key"), "-----BEGIN PRIVATE KEY-----\n");
  mkdirSync(join(dir, ".ssh")); writeFileSync(join(dir, ".ssh", "id_ed25519"), "private");
  symlinkSync(join(outside, "secret.txt"), join(dir, "escape.txt"));
  symlinkSync(outside, join(dir, "escape-dir"));
  mkdirSync(join(dir, "build")); writeFileSync(join(dir, "build", "out.js"), "ignored");
  writeFileSync(join(dir, "debug.log"), "ignored");
  writeFileSync(join(state, "fleet.yaml"), "agend: private");
  try { execFileSync("mkfifo", [join(dir, "pipe")]); } catch { /* no mkfifo: that case is skipped below */ }
});
afterAll(() => { rmSync(join(dir, ".."), { recursive: true, force: true }); });
const root = () => workspaceRoot(dir, state);

describe("Changes (#3153 P1)", () => {
  it("modified and untracked files with their diff against HEAD; binary flagged; secrets listed without a diff", async () => {
    const c = await workspaceChanges(await root());
    expect(c.repo).toBe(true);
    expect(c.branch).toBe("main");
    const by = Object.fromEntries(c.files.map((f) => [f.path, f]));
    expect(by["app.js"]).toMatchObject({ status: "modified", adds: 2, dels: 1, hidden: false, untracked: false });
    expect(by["notes.md"]).toMatchObject({ status: "untracked", untracked: true, hidden: false, adds: 3 });
    expect(by["blob.bin"]).toMatchObject({ untracked: true, binary: true });
    for (const s of [".env", ".env.local", "server.key", ".ssh/id_ed25519"]) expect(by[s], s).toMatchObject({ hidden: true });
    expect(c.patch).toContain("+console.log('more');");
    expect(c.patch).toContain("+# New file");
    // Nothing of a secret, of AgEnD's state or of what a symlink points at is ever in the answer.
    const all = JSON.stringify(c);
    for (const leak of ["sk-should-never-leave", "TOKEN=nope", "BEGIN PRIVATE KEY", "private", "TOP SECRET", "agend: private"]) expect(all, leak).not.toContain(leak);
    expect(c.files.some((f) => f.path.startsWith(".agend-state"))).toBe(false);
    expect(c.files.some((f) => f.path.startsWith("build/") || f.path === "debug.log")).toBe(false);   // gitignored
  });

  it("a big file's diff is left out and marked, the others still shown; the whole stays within its byte limit", async () => {
    const c = await workspaceChanges(await root());
    const big = c.files.find((f) => f.path === "big.txt")!;
    expect(big).toMatchObject({ status: "modified", tooLarge: true });
    expect(c.patch).not.toContain("line 1 yyyy");
    expect(c.patch).toContain("+console.log('more');");
    expect(Buffer.byteLength(c.patch)).toBeLessThanOrEqual(WORKSPACE_LIMITS.diffBytes);
  });

  it("not a repository: no changes, said as such", async () => {
    const c = await workspaceChanges(await workspaceRoot(outside, state));
    expect(c).toMatchObject({ repo: false, files: [], patch: "" });
  });
});

describe("Files (#3153 P1)", () => {
  it("lists a directory gitignore-aware, secrets hidden, symlinks as links (never followed), AgEnD state left out", async () => {
    const l = await workspaceList(await root(), "");
    const by = Object.fromEntries(l.entries.map((e) => [e.name, e]));
    expect(by["build"]).toBeUndefined();
    expect(by["debug.log"]).toBeUndefined();
    expect(by[".agend-state"]).toBeUndefined();
    expect(by["src"]).toMatchObject({ type: "dir", hidden: false });
    expect(by["escape.txt"]).toMatchObject({ type: "symlink", size: null });
    expect(by["escape-dir"]).toMatchObject({ type: "symlink" });
    expect(by[".env"]).toMatchObject({ hidden: true });
    expect(by[".git"]).toMatchObject({ type: "dir", hidden: true });
    expect(l.entries[0]!.type).toBe("dir");                                    // directories first
    expect((await workspaceList(await root(), "src")).entries.map((e) => e.name)).toEqual(["util.ts"]);
  });

  it("refuses to walk through a symlinked directory, into a hidden one, or out of the folder", async () => {
    const ws = await root();
    await expect(workspaceList(ws, "escape-dir")).rejects.toMatchObject({ code: "symlink" });
    await expect(workspaceFile(ws, "escape-dir/secret.txt")).rejects.toMatchObject({ code: "symlink" });
    await expect(workspaceList(ws, ".ssh")).rejects.toMatchObject({ code: "hidden" });
    await expect(workspaceFile(ws, ".ssh/id_ed25519")).rejects.toMatchObject({ code: "hidden" });
    for (const bad of ["../outside/secret.txt", "src/../../outside/secret.txt", "/etc/passwd", "./app.js", "a\u0000b", "src\\..\\..\\x"]) {
      await expect(workspaceFile(ws, bad), bad).rejects.toMatchObject({ code: expect.stringMatching(/outside|invalid/) });
    }
    await expect(workspaceFile(ws, ".agend-state/fleet.yaml")).rejects.toMatchObject({ code: "hidden" });
  });

  it("a text file is read; a symlink, a secret, a binary, a big file and a FIFO are not", async () => {
    const ws = await root();
    expect(await workspaceFile(ws, "app.js")).toMatchObject({ kind: "text", text: "const a = 2;\nconsole.log(a);\nconsole.log('more');\n" });
    await expect(workspaceFile(ws, "escape.txt")).rejects.toMatchObject({ code: "symlink" });
    await expect(workspaceFile(ws, ".env")).rejects.toMatchObject({ code: "hidden" });
    await expect(workspaceFile(ws, "server.key")).rejects.toMatchObject({ code: "hidden" });
    expect(await workspaceFile(ws, "blob.bin")).toMatchObject({ kind: "binary" });
    expect(await workspaceFile(ws, "big.txt")).toMatchObject({ kind: "too_large" });
    expect(await workspaceFile(ws, "logo.png")).toMatchObject({ kind: "image", mime: "image/png" });
    expect((await workspaceImage(ws, "logo.png")).bytes.length).toBe(12);
    await expect(workspaceImage(ws, "app.js")).rejects.toMatchObject({ code: "not_a_file" });
    let fifo = false; try { execFileSync("test", ["-p", join(dir, "pipe")]); fifo = true; } catch { /* none */ }
    if (fifo) await expect(workspaceFile(ws, "pipe")).rejects.toMatchObject({ code: "not_a_file" });
  });
});

describe("the fixed deny-list (#3153: not configurable in P1)", () => {
  it.each([".env", ".env.production", "config/.env.local", "id_rsa", "id_ed25519.pub", "keys/server.pem", "cert.p12", "app.key", ".npmrc", ".netrc",
    "credentials.json", "aws_credentials", "db-password.txt", "my-secret.yaml", ".git/config", ".ssh/known_hosts", ".aws/credentials", "auth.json", "api.token"])("%s is hidden", (p) => {
    expect(isHiddenPath(p)).toBe(true);
  });
  it.each(["app.js", "README.md", "src/env.ts", "docs/secrets-handling.md.txt2", "keyboard.ts", "tokens.css", "package.json"])("%s is shown", (p) => {
    expect(isHiddenPath(p)).toBe(p === "docs/secrets-handling.md.txt2");
  });
});
