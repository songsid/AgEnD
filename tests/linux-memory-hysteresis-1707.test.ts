import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readHostMemory } from "../src/host-memory.js";
import { MemoryPressure } from "../src/memory-pressure.js";
import { SpawnGate } from "../src/spawn-gate.js";
import { StormWindow } from "../src/storm-window.js";

const MiB = 1024 * 1024;
function fixture(available: number, some = 0, full = 0, swapFree = 4000, missing = false) {
  return readHostMemory({
    platform: "linux", includePressure: true,
    meminfo: () => `MemTotal: ${16000 * 1024} kB\nMemAvailable: ${available * 1024} kB\nSwapTotal: ${8000 * 1024} kB\nSwapFree: ${swapFree * 1024} kB\n`,
    psi: () => {
      if (missing) throw Object.assign(new Error("missing PSI"), { code: "ENOENT" });
      return `some avg10=${Math.max(some, full)} avg60=${some} avg300=0 total=0\nfull avg10=${full} avg60=0 avg300=0 total=0\n`;
    },
    totalmem: () => 16000 * MiB, freemem: () => available * MiB,
  });
}

describe("#1707 source-specific RAM hysteresis", () => {
  const gates: SpawnGate[] = [];
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-12T00:00:00Z")); });
  afterEach(() => { gates.splice(0).forEach(g => g.shutdown()); vi.useRealTimers(); });

  it.each([false, true])("PSI-only critical releases without borrowing a RAM hold (missing=%s)", async missing => {
    let value = fixture(400, 0, 25);
    const pressure = new MemoryPressure({ platform: "linux", read: () => value });
    expect(pressure.sample().level).toBe("critical");
    const gate = new SpawnGate({ storm: new StormWindow(), memoryPressure: pressure, concurrency: () => 3, staggerMs: () => 0 });
    gates.push(gate);
    const operation = vi.fn(async () => 42);
    const work = gate.run({ instanceName: "worker", workingDirectory: "/fixture", reason: "wake" }, operation);
    void work.catch(() => {});
    expect(operation).not.toHaveBeenCalled();
    value = fixture(400, 0, 0, 4000, missing);
    expect(pressure.sample()).toMatchObject({ level: "elevated", recovering: true });
    await vi.advanceTimersByTimeAsync(120000);
    expect(operation).toHaveBeenCalledOnce();
    expect(pressure.sample()).toMatchObject({ level: "elevated", recovering: false });
    await expect(work).resolves.toBe(42);
  });

  it("PSI-only elevated releases without borrowing a low-RAM threshold", () => {
    let value = fixture(850, 15);
    const pressure = new MemoryPressure({ platform: "linux", read: () => value });
    expect(pressure.sample().level).toBe("elevated");
    value = fixture(850);
    expect(pressure.sample().level).toBe("normal");
  });

  it("actual RAM critical arms its hold even while PSI also fires", () => {
    let value = fixture(100, 0, 25);
    const pressure = new MemoryPressure({ platform: "linux", read: () => value });
    expect(pressure.sample().level).toBe("critical");
    value = fixture(400);
    expect(pressure.sample().level).toBe("critical");
    value = fixture(480);
    expect(pressure.sample()).toMatchObject({ level: "elevated", recovering: true });
  });

  it("actual low RAM arms hysteresis even while PSI also fires", () => {
    let value = fixture(700, 15);
    const pressure = new MemoryPressure({ platform: "linux", read: () => value });
    expect(pressure.sample().level).toBe("elevated");
    value = fixture(850);
    expect(pressure.sample().level).toBe("elevated");
    value = fixture(960);
    expect(pressure.sample().level).toBe("normal");
  });

  it("PSI-only elevated cannot arm a never-tight swap fallback", () => {
    let value = fixture(1200, 15, 0, 480);
    const pressure = new MemoryPressure({ platform: "linux", read: () => value });
    expect(pressure.sample().level).toBe("elevated");
    value = fixture(1200, 0, 0, 480, true);
    expect(pressure.sample().level).toBe("normal");
  });

  it("actual tight-swap/low-headroom retains its own release hysteresis", () => {
    let value = fixture(1200, 0, 0, 0, true);
    const pressure = new MemoryPressure({ platform: "linux", read: () => value });
    expect(pressure.sample().level).toBe("elevated");
    value = fixture(1200, 0, 0, 480, true);
    expect(pressure.sample().level).toBe("elevated");
    value = fixture(1200, 0, 0, 801, true);
    expect(pressure.sample().level).toBe("normal");
  });
});
