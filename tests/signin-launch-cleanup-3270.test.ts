/**
 * #3270: `agend web` deletes its 0600 launch file from a detached helper process. The helper waits 45 s (a browser that is
 * slow to start has not read the file yet at 15 s) and, on Windows, must not flash a console window.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => { vi.resetModules(); vi.doUnmock("node:child_process"); });

describe("#3270 scheduleSigninLaunchCleanup", () => {
  it("starts a detached, hidden, unref'd helper that waits SIGNIN_LAUNCH_FILE_TTL_MS before deleting the file", async () => {
    const unref = vi.fn(), on = vi.fn();
    const spawn = vi.fn(() => ({ unref, on }));
    vi.resetModules();
    vi.doMock("node:child_process", () => ({ spawn }));
    const link = await import("../src/web-signin-link.js");
    link.scheduleSigninLaunchCleanup("/tmp/agend-signin-x.html");
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(command).toBe(process.execPath);
    expect(args.slice(-2)).toEqual(["/tmp/agend-signin-x.html", "45000"]);
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
