/**
 * #2955 review (Prism P2): "Use this PC's Windows CLIs" is asked again synchronously immediately before each Windows
 * process starts. Finding the transport awaits (PowerShell, then wslpath), and the switch can be turned off meanwhile —
 * the fleet's close is queued after the save — so a check before those awaits alone let a preparing operation spawn.
 * The real coordinator bridge (windowsBridgeFor) with the transport lookup held open while the switch goes off: a
 * forced detection, a workspace and a task each start nothing (and the task settles as failed, certainly not run);
 * with the switch left on, each starts its process. The standalone runner's bridge is not switched (it has no fleet).
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/child-process.js", () => ({ spawn: vi.fn(), execFile: vi.fn() }));
import { execFile, spawn } from "../src/child-process.js";
import { LOCAL_WINDOWS_CLI_OFF, WindowsCliBridge, admitLocalWindowsCli, nativeWindowsTransport, windowsBridgeFor, WINDOWS_CLI_INVENTORY_FILE } from "../src/windows-cli.js";
import { setConfiguredRuntimeSwitches } from "../src/runtime-switches.js";
import { nativeProvider } from "../src/windows-cli-providers.js";

const roots: string[] = [];
let release: (() => void) | null = null, lookups = 0;
class FakeChild extends EventEmitter { stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); kill = vi.fn(); }
beforeEach(() => {
  vi.clearAllMocks(); lookups = 0;
  vi.stubEnv("AGEND_WINDOWS_CLI", ""); vi.stubEnv("AGEND_REMOTE_RUNTIME", "");
  // The WSL transport lookup: PowerShell finds node.exe (held until the test releases it), then wslpath twice.
  vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], _opts: unknown, done: (e: Error | null, v: { stdout: string }) => void) => {
    lookups++;
    const answer = cmd.endsWith("powershell.exe") ? "C:\\Program Files\\nodejs\\node.exe" : args[0] === "-u" ? "/mnt/c/Program Files/nodejs/node.exe" : "C:\\AgEnD\\windows-cli-worker.js";
    if (cmd.endsWith("powershell.exe")) release = () => done(null, { stdout: answer }); else done(null, { stdout: answer });
  }) as never);
  vi.mocked(spawn).mockImplementation((() => new FakeChild()) as never);
});
afterEach(() => {
  vi.unstubAllEnvs(); setConfiguredRuntimeSwitches(undefined); release = null;
  for (const dir of roots.splice(0)) { if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw Error("unsafe cleanup"); rmSync(dir, { recursive: true, force: true }); }
});
/** A fleet owner whose last detection found Codex runnable (a task needs one). */
function owner() {
  const dataDir = mkdtempSync(join(tmpdir(), "agend-admission-")); roots.push(dataDir);
  writeFileSync(join(dataDir, WINDOWS_CLI_INVENTORY_FILE), JSON.stringify({ home: "C:\\Users\\Test", probedAt: 1, clis: [{ id: "codex", path: "C:\\codex.exe", version: "1.0",
    authenticated: true, runnable: true, readOnlySupport: true, supports: nativeProvider("codex").supports, models: [] }] }));
  return { dataDir };
}
const held = async () => { await vi.waitFor(() => expect(release).not.toBeNull()); };
const task = { requestId: "12345678-1234-4321-abcd-123456789012", cli: "codex", cwd: "J:\\Project", prompt: "Hi", sandbox: "read-only" } as const;
const PATHS = {
  "a forced detection": (bridge: WindowsCliBridge) => bridge.probe({ force: true }),
  "a workspace": (bridge: WindowsCliBridge) => bridge.prepareWorkspace("12345678-1234-4321-abcd-123456789013"),
  "a task": async (bridge: WindowsCliBridge) => {
    bridge.start(task);
    await vi.waitFor(() => expect(["failed", "running", "starting"]).toContain(bridge.get(task.requestId)!.status));
    await vi.waitFor(() => expect(vi.mocked(spawn).mock.calls.length > 0 || bridge.get(task.requestId)!.status === "failed").toBe(true));
    const now = bridge.get(task.requestId)!;
    if (now.status === "failed") throw new Error(now.error);
    return now;
  },
} as const;

describe("this PC's switch is asked again right before the Windows process starts", () => {
  for (const [name, run] of Object.entries(PATHS)) {
    it(`${name}: turned off while the transport is being found → nothing starts`, async () => {
      setConfiguredRuntimeSwitches({ windows_cli: true });
      const bridge = windowsBridgeFor(owner());
      const outcome = run(bridge).then(() => "started", (e: Error) => e.message);
      await held();
      setConfiguredRuntimeSwitches({});                                 // the save; the queued close has not run yet
      release!();
      expect(await outcome).toBe(LOCAL_WINDOWS_CLI_OFF);
      expect([lookups, vi.mocked(spawn).mock.calls.length]).toEqual([3, 0]);
      if (name === "a task") expect(bridge.get(task.requestId)).toMatchObject({ status: "failed", outcomeConfirmed: true, error: LOCAL_WINDOWS_CLI_OFF });
      if (name === "a task") expect(bridge.hasActiveTask()).toBe(false);
    });
    it(`${name}: control — left on, its process starts`, async () => {
      setConfiguredRuntimeSwitches({ windows_cli: true });
      const bridge = windowsBridgeFor(owner());
      void run(bridge).catch(() => {});
      await held(); release!();
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
      expect(vi.mocked(spawn).mock.calls[0]![0]).toBe("/mnt/c/Program Files/nodejs/node.exe");
      bridge.close();
    });
  }
  it("off from the start: refused before the lookup (nothing asked of Windows)", async () => {
    const bridge = windowsBridgeFor(owner());
    await expect(bridge.probe({ force: true })).rejects.toThrow(LOCAL_WINDOWS_CLI_OFF);
    expect([lookups, vi.mocked(spawn).mock.calls.length]).toEqual([0, 0]);
  });
  it("the coordinator's bridge carries the switch; the standalone runner's does not (it has no fleet), and still starts", async () => {
    expect(windowsBridgeFor(owner()).admit).toBe(admitLocalWindowsCli);
    const runner = new WindowsCliBridge(nativeWindowsTransport);
    expect(runner.admit).toBeUndefined();
    const probing = runner.probe({ force: true }).catch(() => {});
    await held(); release!();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    runner.close(); void probing;
  });
});
