import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { InstanceLifecycle } from "../src/instance-lifecycle.js";
import { TmuxManager } from "../src/tmux-manager.js";
import { tmuxReadArgs, tmuxWindowTarget } from "../src/tmux-read.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("#2806 pre-window failed-start cleanup", () => {
  it.each(["", " "])("never looks up a PID or signals when the failed daemon has window id %j", async windowId => {
    const dir = mkdtempSync(join(tmpdir(), "agend-owned-cleanup-")); dirs.push(dir);
    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const daemon = new Daemon("failed", { working_directory: dir, log_level: "silent" } as any,
      dir, false, undefined, undefined, { child: () => logger } as any) as any;
    daemon.tmux = new TmuxManager("private-fixture", windowId);
    // Model the writeConfig rejection before createWindow. Keep the lifecycle's
    // real disposal path and the daemon's real abortStartup/killProcessTree.
    daemon.start = vi.fn(async () => { throw new Error("retained session needs repair"); });
    const lookup = vi.spyOn(TmuxManager, "getPanePid").mockResolvedValue(999999);
    const signal = vi.spyOn(process, "kill").mockReturnValue(true);
    const close = vi.fn(async () => {}); daemon.ipcServer = { close };
    await expect(InstanceLifecycle.startOrDispose(daemon, "failed", logger as any)).rejects.toThrow("retained session needs repair");
    expect(lookup).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["", " \t"])("rejects an empty window in PID, read and mutation targets (%j)", async window => {
    expect(() => tmuxWindowTarget("s", window)).toThrow("without a window id");
    expect(() => tmuxReadArgs({ kind: "capture", session: "s", window })).toThrow("without a window id");
    expect(await TmuxManager.getPanePid("s", window)).toBeNull();
    const manager = new TmuxManager("s", window);
    expect(await manager.sendKeys("must never reach an active pane")).toBe(false);
    await expect(manager.setRemainOnExit()).rejects.toThrow("without a window id");
    const read = vi.fn();
    const withPort = new TmuxManager("s", window, undefined, { isFor: () => true, read });
    await expect(withPort.capturePane()).rejects.toThrow("without a window id");
    expect(read).not.toHaveBeenCalled();
  });
});
