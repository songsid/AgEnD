/**
 * #3270: `agend web` deletes its 0600 launch file from a detached helper process. The helper waits 2 minutes (a browser that is
 * cold-starting on a slow machine has not read the file yet at 15 s, or at 45), still well inside the code's 5 minutes, and on
 * Windows it must not flash a console window. The file is also created with `wx`: a path that already exists — a file someone
 * planted, or a symlink to somewhere else — is refused, never written through.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => { vi.resetModules(); vi.doUnmock("node:child_process"); });

describe("#3270 scheduleSigninLaunchCleanup", () => {
  it("starts a detached, hidden, unref'd helper that waits SIGNIN_LAUNCH_FILE_TTL_MS (2 minutes) before deleting the file", async () => {
    const unref = vi.fn(), on = vi.fn();
    const spawn = vi.fn(() => ({ unref, on }));
    vi.resetModules();
    vi.doMock("node:child_process", () => ({ spawn }));
    const link = await import("../src/web-signin-link.js");
    link.scheduleSigninLaunchCleanup("/tmp/agend-signin-x.html");
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(command).toBe(process.execPath);
    expect(args.slice(-2)).toEqual(["/tmp/agend-signin-x.html", "120000"]);
    expect(options).toMatchObject({ detached: true, stdio: "ignore", windowsHide: true });
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("a helper that cannot start is swept by the next run, never thrown", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({ spawn: () => { throw new Error("EAGAIN"); } }));
    const link = await import("../src/web-signin-link.js");
    expect(() => link.scheduleSigninLaunchCleanup("/tmp/agend-signin-x.html")).not.toThrow();
  });

  it("the helper really deletes the file once the delay has passed (a short delay here)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-launch-cleanup-"));
    try {
      const file = join(dir, "agend-signin-x.html");
      writeFileSync(file, "x");
      const link = await import("../src/web-signin-link.js");
      link.scheduleSigninLaunchCleanup(file, 300);
      expect(existsSync(file)).toBe(true);
      await expect.poll(() => existsSync(file), { timeout: 10_000, interval: 100 }).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("#3270 writeSigninLaunchFile refuses a path that already exists (wx)", () => {
  // The name is random (12 bytes); pin it so a test can stand something on exactly that path.
  const FIXED = "ab".repeat(12);
  async function writerWithFixedName() {
    vi.resetModules();
    vi.doMock("node:crypto", async importOriginal => ({ ...(await importOriginal<typeof import("node:crypto")>()), randomBytes: () => Buffer.from(FIXED, "hex") }));
    return (await import("../src/web-signin-link.js")).writeSigninLaunchFile;
  }
  afterEach(() => { vi.doUnmock("node:crypto"); });
  const launchPath = (home: string) => join(home, "signin-launch", `agend-signin-${FIXED}.html`);

  it("an existing file at the path is not overwritten", async () => {
    const home = mkdtempSync(join(tmpdir(), "agend-launch-wx-"));
    try {
      const write = await writerWithFixedName();
      mkdirSync(join(home, "signin-launch"), { recursive: true, mode: 0o700 });
      writeFileSync(launchPath(home), "planted");
      expect(() => write(home, "http://localhost:1/signin#code=ABCD-2345")).toThrow(/EEXIST/);
      expect(readFileSync(launchPath(home), "utf8")).toBe("planted");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32")("a symlink at the path is not followed — what it points at is untouched, the link stays a link", async () => {
    const home = mkdtempSync(join(tmpdir(), "agend-launch-wx-"));
    try {
      const write = await writerWithFixedName();
      const victim = join(home, "victim.txt");
      writeFileSync(victim, "do not touch");
      mkdirSync(join(home, "signin-launch"), { recursive: true, mode: 0o700 });
      symlinkSync(victim, launchPath(home));
      expect(() => write(home, "http://localhost:1/signin#code=ABCD-2345")).toThrow(/EEXIST/);
      expect(readFileSync(victim, "utf8")).toBe("do not touch");
      expect(lstatSync(launchPath(home)).isSymbolicLink()).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("a dangling symlink at the path is refused too (nothing is created at its target)", async () => {
    if (process.platform === "win32") return;
    const home = mkdtempSync(join(tmpdir(), "agend-launch-wx-"));
    try {
      const write = await writerWithFixedName();
      const target = join(home, "not-yet.txt");
      mkdirSync(join(home, "signin-launch"), { recursive: true, mode: 0o700 });
      symlinkSync(target, launchPath(home));
      expect(() => write(home, "http://localhost:1/signin#code=ABCD-2345")).toThrow(/EEXIST/);
      expect(existsSync(target)).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
