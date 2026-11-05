import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { DEFAULT_INSTANCE_CONFIG } from "../src/config.js";
import { TmuxManager } from "../src/tmux-manager.js";

const roots: string[] = [];
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function rig(provider = "claude") {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "agend-cli-exit-3037-")); roots.push(root);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const daemon = new Daemon("worker", { ...structuredClone(DEFAULT_INSTANCE_CONFIG), working_directory: root,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0, health_check_interval_ms: 25 },
  }, root, false, { binaryName: provider, getErrorPatterns: () => [] } as never, undefined, { child: () => logger } as never);
  const read = vi.fn(async () => "1  1234\n");
  const manager = new TmuxManager("private-exit-test", "@1", undefined, { isFor: () => true, read });
  const kill = vi.spyOn(manager, "killWindow").mockResolvedValue();
  vi.spyOn(manager, "capturePaneWithHistory").mockResolvedValue("CLI closed its terminal");
  const d = daemon as any; d.tmux = manager;
  d.stopInstanceStateMonitor = vi.fn(); d.startInstanceStateMonitor = vi.fn();
  d.checkMcpServerAlive = vi.fn(); d.spawnClaudeWindow = vi.fn();
  const ended = vi.fn(); daemon.on("supervision_ended", ended);
  return { daemon, d, read, kill, ended, logger };
}
it.each(["claude", "codex"])("%s waits for the real zero status after tmux first reports only a dead PTY", async provider => {
  const r = rig(provider);
  r.read.mockResolvedValueOnce("1  1234\n").mockResolvedValue("1 0 1234\n");
  r.d.startHealthCheck(); await vi.advanceTimersByTimeAsync(25);
  expect(r.kill).not.toHaveBeenCalled(); expect(r.ended).not.toHaveBeenCalled();
  // Its MCP child goes away on an ordinary CLI shutdown too; it must not schedule a competing revival.
  expect(r.d.checkMcpServerAlive).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_250);
  expect(r.ended).toHaveBeenCalledOnce(); expect(r.ended.mock.calls[0][0]).toMatchObject({ name: "worker", exitCode: 0 });
  expect(r.daemon.getProcessStatus()).toBe("stopped"); expect(r.d.healthCheckPaused).toBe(true);
  expect(r.d.crashCount).toBe(0); expect(r.d.spawnClaudeWindow).not.toHaveBeenCalled(); expect(r.kill).toHaveBeenCalledOnce();
});
it("an eventually nonzero exit stays a crash, never a normal-exit offer", async () => {
  const r = rig(); r.read.mockResolvedValueOnce("1  1234\n").mockResolvedValue("1 7 1234\n");
  r.d.startHealthCheck(); await vi.advanceTimersByTimeAsync(1_275);
  expect(r.daemon.getProcessStatus()).toBe("crashed"); expect(r.ended.mock.calls[0][0].exitCode).not.toBe(0);
  expect(r.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 7 }), expect.stringContaining("process exited"));
});
it("a permanently missing status is bounded and is never guessed to be zero", async () => {
  const r = rig(); r.d.startHealthCheck(); await vi.advanceTimersByTimeAsync(2_025);
  expect(r.read.mock.calls.length).toBeGreaterThan(1); expect(r.read.mock.calls.length).toBeLessThanOrEqual(5);
  expect(r.daemon.getProcessStatus()).toBe("crashed"); expect(r.d.healthCheckPaused).toBe(true);
  expect(r.ended).toHaveBeenCalledOnce(); expect(r.ended.mock.calls[0][0].exitCode).toBeUndefined();
});
it("failed status rechecks retain unknown rather than inventing a normal exit", async () => {
  const r = rig(); r.read.mockResolvedValueOnce("1  1234\n").mockResolvedValue("");
  r.d.startHealthCheck(); await vi.advanceTimersByTimeAsync(1_275);
  expect(r.ended).toHaveBeenCalledOnce(); expect(r.ended.mock.calls[0][0].exitCode).toBeUndefined();
  expect(r.daemon.getProcessStatus()).toBe("crashed"); expect(r.read).toHaveBeenCalledTimes(5);
});
it("a positively live CLI still receives its MCP liveness check", async () => {
  const r = rig(); r.read.mockResolvedValue("0  \n");
  r.d.startHealthCheck(); await vi.advanceTimersByTimeAsync(25);
  expect(r.d.checkMcpServerAlive).toHaveBeenCalledOnce(); expect(r.ended).not.toHaveBeenCalled();
  expect(r.kill).not.toHaveBeenCalled(); expect(r.d.healthCheckTimer).not.toBeNull();
});
it("a changed launch during the exit-status wait cannot stop or report on the replacement", async () => {
  const r = rig(); r.read.mockResolvedValueOnce("1  1234\n").mockResolvedValue("1 0 1234\n");
  r.d.startHealthCheck(); await vi.advanceTimersByTimeAsync(25); r.d.spawnGeneration++;
  await vi.advanceTimersByTimeAsync(250);
  expect(r.ended).not.toHaveBeenCalled(); expect(r.kill).not.toHaveBeenCalled(); expect(r.d.spawnClaudeWindow).not.toHaveBeenCalled();
});
it("a pane that is alive on recheck is monitored again without an exit or respawn", async () => {
  const r = rig(); r.read.mockResolvedValueOnce("1  1234\n").mockResolvedValue("0  1234\n");
  r.d.startHealthCheck(); await vi.advanceTimersByTimeAsync(275);
  expect(r.ended).not.toHaveBeenCalled(); expect(r.kill).not.toHaveBeenCalled(); expect(r.d.spawnClaudeWindow).not.toHaveBeenCalled();
  expect(r.d.healthCheckTimer).not.toBeNull();
});
