import { afterEach, expect, it, vi } from "vitest";
import { TmuxManager } from "../src/tmux-manager.js";
import { tmuxExecHelper } from "../src/tmux-exec-helper.js";
import { SettingsExecution } from "../src/settings-transaction.js";
vi.mock("../src/tmux-binary.js", () => ({ tmuxBinary: () => "/inert/tmux", tmuxConfArgs: () => [], tmuxEnv: () => ({}), tmuxSocket: () => null }));

afterEach(() => vi.restoreAllMocks());
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

it.each([false, true])("host install admission is checked after tmux preparation, before dispatch (reuse=%s)", async reuse => {
  const held = deferred(), arrived = deferred();
  const exec = vi.spyOn(tmuxExecHelper, "exec").mockImplementation(async () => ({ stdout: "@7\n", stderr: "" }) as never);
  vi.spyOn(TmuxManager, "listWindowsStrict").mockImplementation(async () => {
    if (!reuse) { arrived.resolve(); await held.promise; }
    return reuse ? [{ id: "@7", name: "owned-install" }] as never : [];
  });
  const tm = new TmuxManager("owned-test-only", "");
  vi.spyOn(tm as any, "applyLogicalSize").mockImplementation(async () => { if (reuse) { arrived.resolve(); await held.promise; } });
  let current = true;
  const execution = new SettingsExecution({ current: () => current, snapshot: () => null });
  try {
    const start = tm.createWindow("never-executed-fixture", "/owned", "owned-install", () => execution.complete());
    await arrived.promise; current = false; held.resolve();
    await expect(start).rejects.toThrow("settings_execution_stale");
    expect(exec.mock.calls.some(c => (c[1] as string[]).some(x => x === "new-window" || x === "respawn-window"))).toBe(false);
    expect(execution.completed).toBe(false);
  } finally { execution.close(); }
});

it("a current exact install admits once at dispatch and remains accepted after admission", async () => {
  const exec = vi.spyOn(tmuxExecHelper, "exec").mockImplementation(async () => ({ stdout: "@7\n", stderr: "" }) as never);
  vi.spyOn(TmuxManager, "listWindowsStrict").mockResolvedValue([]);
  const tm = new TmuxManager("owned-test-only", "");
  vi.spyOn(tm as any, "applyLogicalSize").mockResolvedValue(undefined);
  const execution = new SettingsExecution({ current: () => true, snapshot: () => null });
  const launch = vi.fn(() => execution.complete());
  try {
    expect(await tm.createWindow("never-executed-fixture", "/owned", "owned-install", launch)).toBe("@7");
    expect(launch).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls.filter(c => (c[1] as string[]).includes("new-window"))).toHaveLength(1);
    expect(execution.completed).toBe(true);
  } finally { execution.close(); }
});
