import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Daemon } from "../src/daemon.js";
import { TmuxManager } from "../src/tmux-manager.js";

/** A backend that must ask its CLI something before the launch command exists does it in `prepareLaunch`, before buildCommand. */
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-prep-launch-")); mkdirSync(join(dir, "instance"), { recursive: true }); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

function launch(prepareLaunch?: () => Promise<void>) {
  const order: string[] = [];
  const daemon: any = new Daemon("worker", {
    working_directory: dir, backend: "opencode", log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
  } as any, join(dir, "instance"), false, undefined, undefined, pino({ level: "silent" }) as any);
  daemon.backend = {
    binaryName: "opencode",
    writeConfig: vi.fn(() => { order.push("writeConfig"); }),
    buildCommand: vi.fn(() => { order.push("buildCommand"); return "opencode"; }),
    ...(prepareLaunch ? { prepareLaunch: vi.fn(async () => { order.push("prepareLaunch:start"); await prepareLaunch(); order.push("prepareLaunch:done"); }) } : {}),
  };
  vi.spyOn(TmuxManager, "ensureSession").mockRejectedValue(new Error("stop after the command is built"));
  return { daemon, order };
}

describe("Daemon.trySpawnInsideGate and the backend's prepareLaunch", () => {
  it("awaits it — asynchronously, to completion — before it builds the launch command", async () => {
    const { daemon, order } = launch(() => new Promise(resolve => setTimeout(resolve, 30)));
    await expect(daemon.trySpawnInsideGate()).rejects.toThrow(/stop after the command/);
    expect(order).toEqual(["prepareLaunch:start", "prepareLaunch:done", "writeConfig", "buildCommand"]);
  });

  it("a prepareLaunch that throws does not fail the launch", async () => {
    const { daemon, order } = launch(async () => { throw new Error("help probe failed"); });
    await expect(daemon.trySpawnInsideGate()).rejects.toThrow(/stop after the command/);
    expect(order).toContain("buildCommand");
  });

  it("a backend without the hook launches as before", async () => {
    const { daemon, order } = launch();
    await expect(daemon.trySpawnInsideGate()).rejects.toThrow(/stop after the command/);
    expect(order).toEqual(["writeConfig", "buildCommand"]);
  });
});
