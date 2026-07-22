import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { clearPausedMarker, hasPausedMarker, readPausedAt, writePausedMarker } from "../src/pause-marker.js";

const dirs: string[] = [];
const makeDataDir = () => {
  const dir = join(tmpdir(), `agend-pause-persist-${process.pid}-${Date.now()}-${dirs.length}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("persisted pause markers", () => {
  it("writes, reads, and clears the marker timestamp", () => {
    const instanceDir = join(makeDataDir(), "instances", "worker");
    writePausedMarker(instanceDir, 123_456);

    expect(hasPausedMarker(instanceDir)).toBe(true);
    expect(readPausedAt(instanceDir)).toBe(123_456);
    expect(existsSync(join(instanceDir, "paused"))).toBe(true);

    clearPausedMarker(instanceDir);
    expect(hasPausedMarker(instanceDir)).toBe(false);
  });

  it("recognizes and clears the legacy paused-state marker", () => {
    const instanceDir = join(makeDataDir(), "instances", "worker");
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(join(instanceDir, "paused-state.json"), JSON.stringify({ paused_at: 789 }));

    expect(hasPausedMarker(instanceDir)).toBe(true);
    expect(readPausedAt(instanceDir)).toBe(789);
    clearPausedMarker(instanceDir);
    expect(hasPausedMarker(instanceDir)).toBe(false);
  });

  it("skips startup and reports paused when a marker exists without a daemon", async () => {
    const dataDir = makeDataDir();
    const fm = new FleetManager(dataDir);
    const config = { working_directory: join(dataDir, "work") } as any;
    fm.fleetConfig = { defaults: {}, instances: { worker: config } };
    writePausedMarker(fm.getInstanceDir("worker"), 1_000);
    const start = vi.spyOn(fm.lifecycle, "start");

    await fm.startInstance("worker", config, false);

    expect(start).not.toHaveBeenCalled();
    expect(fm.getInstanceStatus("worker")).toBe("paused");
    expect(fm.getInstanceExecutionState("worker")).toBeNull();
  });

  it("wakes a marker-only fleet instance and keeps it paused if startup fails", async () => {
    const dataDir = makeDataDir();
    const fm = new FleetManager(dataDir);
    const config = { working_directory: join(dataDir, "work") } as any;
    fm.fleetConfig = { defaults: {}, instances: { worker: config } };
    const instanceDir = fm.getInstanceDir("worker");
    writePausedMarker(instanceDir, 2_000);
    const start = vi.spyOn(fm, "startInstance").mockRejectedValueOnce(new Error("boom"));

    await expect(fm.lifecycle.wake("worker")).rejects.toThrow("boom");
    expect(start).toHaveBeenCalledWith("worker", config, false);
    expect(hasPausedMarker(instanceDir)).toBe(true);

    start.mockResolvedValueOnce(undefined);
    await fm.lifecycle.wake("worker");
    expect(hasPausedMarker(instanceDir)).toBe(false);
  });

  it("wakes a marker-only ClassicBot instance through the same lifecycle", async () => {
    const dataDir = makeDataDir();
    const fm = new FleetManager(dataDir);
    fm.fleetConfig = { defaults: { backend: "codex" }, instances: {} };
    const classic = new ClassicChannelManager(dataDir, fm.logger);
    classic.setPrimaryAdapterId("discord");
    classic.register("channel-1", "discord", "classic-one", "Classic One", "owner", "codex");
    fm.classicChannels = classic;
    writePausedMarker(fm.getInstanceDir("classic-one"), 3_000);
    const start = vi.spyOn(fm as any, "startClassicInstance").mockResolvedValue(undefined);

    await fm.lifecycle.wake("classic-one");

    expect(start).toHaveBeenCalledWith("classic-one", "codex", undefined, undefined);
    expect(hasPausedMarker(fm.getInstanceDir("classic-one"))).toBe(false);
  });
});
