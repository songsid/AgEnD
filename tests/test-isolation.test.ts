import { describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  getUnsafeInstanceDaemonPidReason,
  InstanceLifecycle,
  isFleetStartCommandLine,
} from "../src/instance-lifecycle.js";
import { getAgendHome, getTmuxSessionName, getTmuxSocketName } from "../src/paths.js";

describe("test process isolation", () => {
  it("never uses the production AgEnD home or tmux namespace", () => {
    expect(process.env.AGEND_HOME).toBeTruthy();
    expect(getAgendHome()).not.toBe(join(homedir(), ".agend"));
    expect(getTmuxSessionName()).not.toBe("agend");
    expect(getTmuxSocketName()).not.toBeNull();
    expect(process.env.NOTIFY_SOCKET).toBe("");
  });

  it("collects tests from source only, never from the dist build output", () => {
    // dist/**/*.test.js are stale copies produced by `npm run build`. Running
    // them doubles up ~26 tests and invites a "dist fails but src passes"
    // false alarm the next time source changes.
    const cfg = readFileSync(join(process.cwd(), "vitest.config.ts"), "utf-8");
    expect(cfg).toContain('"dist/**"');
  });
});

describe("instance daemon PID guard", () => {
  it("recognizes supported fleet-start command lines", () => {
    expect(isFleetStartCommandLine("/usr/bin/node /opt/agend/dist/cli.js fleet start")).toBe(true);
    expect(isFleetStartCommandLine("/usr/local/bin/agend fleet start")).toBe(true);
    expect(isFleetStartCommandLine("/usr/bin/node worker.js")).toBe(false);
  });

  it("rejects the current process and the PID recorded in fleet.pid", () => {
    const dataDir = join(tmpdir(), `agend-pid-guard-${process.pid}-${Date.now()}`);
    mkdirSync(dataDir, { recursive: true });
    try {
      expect(getUnsafeInstanceDaemonPidReason(process.pid, dataDir)).toContain("current shared fleet");

      const fleetPid = process.pid + 100_000;
      writeFileSync(join(dataDir, "fleet.pid"), String(fleetPid));
      expect(getUnsafeInstanceDaemonPidReason(fleetPid, dataDir)).toContain("fleet.pid");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not SIGTERM fleet.pid through the stale instance fallback", async () => {
    const dataDir = join(tmpdir(), `agend-lifecycle-guard-${process.pid}-${Date.now()}`);
    const instanceDir = join(dataDir, "instances", "detached");
    mkdirSync(instanceDir, { recursive: true });
    const fleetPid = process.pid + 100_001;
    writeFileSync(join(dataDir, "fleet.pid"), String(fleetPid));
    writeFileSync(join(instanceDir, "daemon.pid"), String(fleetPid));

    const logger = { error: vi.fn(), debug: vi.fn() };
    const lifecycle = new InstanceLifecycle({
      dataDir,
      logger,
      getInstanceDir: () => instanceDir,
      setTopicIcon: vi.fn(),
      instanceIpcClients: new Map(),
      ipcStoppingInstances: new Set(),
      sessionRegistry: new Map(),
    } as any);
    const kill = vi.spyOn(process, "kill");
    try {
      await lifecycle.stop("detached");

      expect(kill).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ instance: "detached", pid: fleetPid }),
        expect.stringContaining("Refusing to SIGTERM"),
      );
    } finally {
      kill.mockRestore();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
