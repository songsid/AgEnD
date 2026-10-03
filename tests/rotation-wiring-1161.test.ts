import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The rotation itself is covered in log-rotation-async-1161.test.ts; this file pins how the DAEMON uses it.
const rotation = vi.hoisted(() => ({ pending: [] as Array<() => void>, calls: [] as string[], order: [] as string[], hang: true }));
vi.mock("../src/logger.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/logger.js")>();
  return {
    ...real,
    rotateLogIfNeededAsync: vi.fn((path: string) => {
      rotation.calls.push(path);
      rotation.order.push("rotate:start");
      if (!rotation.hang) { rotation.order.push("rotate:done"); return Promise.resolve(); }
      return new Promise<void>(resolve => rotation.pending.push(() => { rotation.order.push("rotate:done"); resolve(); }));
    }),
  };
});
import { Daemon } from "../src/daemon.js";
import { TmuxManager } from "../src/tmux-manager.js";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger } as any;
let dir: string;
beforeEach(() => {
  vi.useFakeTimers();
  rotation.pending.length = 0; rotation.calls.length = 0; rotation.order.length = 0; rotation.hang = true;
  dir = mkdtempSync(join(tmpdir(), "agend-rot-wire-"));
  vi.spyOn(TmuxManager, "sessionExists").mockResolvedValue(true);
  vi.spyOn(TmuxManager, "getServerPid").mockResolvedValue(4242);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

function daemon(extra: Record<string, unknown> = {}): any {
  const instanceDir = join(dir, "instance");
  mkdirSync(instanceDir, { recursive: true });
  const d: any = new Daemon("worker", {
    working_directory: dir, backend: "claude-code",
    restart_policy: { max_retries: 5, backoff: "linear", reset_after: 0, health_check_interval_ms: 1_000 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
    ...extra,
  } as any, instanceDir, false, { binaryName: "claude", getReadyPattern: () => /❯/ } as any, undefined, logger);
  d.checkMcpServerAlive = () => {};
  d.setProcessStatus("running");
  return d;
}

describe("the health tick does not wait for a rotation (#1161)", () => {
  it("a rotation that never finishes does not stop the ticks: every tick still checks the pane and re-arms", async () => {
    const d = daemon();
    d.tmux = { getPaneStatus: vi.fn(async () => ({ alive: true })), getWindowId: () => "@1" };
    d.startHealthCheck();
    await vi.advanceTimersByTimeAsync(3_500);
    expect(d.tmux.getPaneStatus.mock.calls.length).toBeGreaterThanOrEqual(3);   // ticks kept firing…
    expect(rotation.calls.length).toBeGreaterThanOrEqual(3);                    // …and each one asked for the rotation
    expect(rotation.calls.every(path => path === join(dir, "instance", "output.log"))).toBe(true);
    d.stopHealthCheck?.();
  });

  it("a lightweight instance has no output.log to rotate", async () => {
    const d = daemon({ lightweight: true });
    d.tmux = { getPaneStatus: vi.fn(async () => ({ alive: true })), getWindowId: () => "@1" };
    d.startHealthCheck();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(d.tmux.getPaneStatus).toHaveBeenCalled();
    expect(rotation.calls).toEqual([]);
    d.stopHealthCheck?.();
  });

  it("a dead pane takes the window-loss path, not the rotation (they are different branches)", async () => {
    const d = daemon();
    d.tmux = { getPaneStatus: vi.fn(async () => null), getWindowId: () => "@1", capturePaneWithHistory: vi.fn(async () => ""), killWindow: vi.fn(async () => {}) };
    vi.spyOn(TmuxManager, "listWindows").mockResolvedValue([{ id: "@1", name: "worker" }] as never);   // the window is still there
    d.startHealthCheck();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(rotation.calls).toEqual([]);
    d.stopHealthCheck?.();
  });
});

describe("wake waits for the rotation before it re-attaches pipe-pane", () => {
  it("rotate completes → THEN pipeOutput (the order is the point: pipe-pane must attach to the rotated file)", async () => {
    rotation.hang = false;
    const d = daemon();
    d.tmux = {
      getWindowId: () => "@1",
      respawnWindow: vi.fn(async () => {}),
      setRemainOnExit: vi.fn(async () => {}),
      pipeOutput: vi.fn(async () => { rotation.order.push("pipeOutput"); }),
    };
    vi.spyOn(TmuxManager, "ensureSession").mockResolvedValue(undefined);
    d.bindInstanceStateOutputListener = () => { throw new Error("stop after pipeOutput"); };
    d.backend = { binaryName: "claude", writeConfig: vi.fn(), buildCommand: vi.fn(() => "claude"), getReadyPattern: () => /❯/ };
    await expect(d.trySpawnInsideGate(true)).rejects.toThrow(/stop after pipeOutput/);
    expect(rotation.order).toEqual(["rotate:start", "rotate:done", "pipeOutput"]);
  });

  it("a rotation still running holds pipeOutput back until it is done", async () => {
    const d = daemon();
    d.tmux = {
      getWindowId: () => "@1",
      respawnWindow: vi.fn(async () => {}),
      setRemainOnExit: vi.fn(async () => {}),
      pipeOutput: vi.fn(async () => { rotation.order.push("pipeOutput"); }),
    };
    vi.spyOn(TmuxManager, "ensureSession").mockResolvedValue(undefined);
    d.bindInstanceStateOutputListener = () => { throw new Error("stop after pipeOutput"); };
    d.backend = { binaryName: "claude", writeConfig: vi.fn(), buildCommand: vi.fn(() => "claude"), getReadyPattern: () => /❯/ };
    const spawning = d.trySpawnInsideGate(true).catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(50);
    expect(rotation.order).toEqual(["rotate:start"]);            // parked on the rotation, pipeOutput not attached yet
    expect(d.tmux.pipeOutput).not.toHaveBeenCalled();
    rotation.pending.forEach(release => release());
    expect(String(await spawning)).toMatch(/stop after pipeOutput/);
    expect(rotation.order).toEqual(["rotate:start", "rotate:done", "pipeOutput"]);
  });
});
