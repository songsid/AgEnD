import { describe, expect, it } from "vitest";
import { readFleetMemory } from "../src/process-memory.js";

/**
 * #386 asked whether the fleet leaks, citing "RSS 10.1GB / 1959 tasks".
 *
 * Measured on the live fleet: the fleet manager process was **162 MB after
 * 11h40m**, while the service *cgroup* was 11.2 GB across 2145 tasks — ~35 CLI
 * agents plus their MCP servers and helpers, all started at boot, none
 * accumulating. Those are the numbers `systemctl status` prints, and they are not
 * the fleet process.
 *
 * The two differ by ~60x, both get called "memory", and nothing in the fleet
 * reported either. This module reports both, separately labelled, so a real
 * fleet-manager leak shows up as a rising `fleetRssBytes` instead of being lost
 * inside an aggregate that CLIs dominate.
 */

describe("readFleetMemory", () => {
  it("reports this process's own RSS as a positive number", () => {
    const memory = readFleetMemory();

    expect(memory.fleetRssBytes).toBeGreaterThan(0);
    // Sanity bound: a vitest worker is tens of MB, nowhere near the 10 GB the
    // issue attributed to the fleet process.
    expect(memory.fleetRssBytes).toBeLessThan(4 * 1024 ** 3);
  });

  it("keeps the process figure separate from the cgroup figure", () => {
    const memory = readFleetMemory();

    // The whole point: conflating these is what produced the 10.1 GB claim.
    expect(memory).toHaveProperty("fleetRssBytes");
    expect(memory).toHaveProperty("cgroupAnonBytes");
    expect(memory).toHaveProperty("cgroupTotalBytes");
    expect(memory).toHaveProperty("cgroupTasks");
  });

  it("reports null rather than zero when cgroup data is unavailable", () => {
    const memory = readFleetMemory();

    // null means "not measured here" (macOS, no cgroup); 0 would read as "nothing
    // is using memory", which is a different and wrong claim.
    for (const value of [memory.cgroupAnonBytes, memory.cgroupTotalBytes, memory.cgroupTasks]) {
      expect(value === null || typeof value === "number").toBe(true);
      if (value !== null) expect(value).toBeGreaterThan(0);
    }
  });

  it("distinguishes anonymous memory from everything the cgroup is charged for", () => {
    const memory = readFleetMemory();
    if (memory.cgroupAnonBytes === null || memory.cgroupTotalBytes === null) return;

    // memory.current includes reclaimable page cache — on the fleet, 1.0 GB of the
    // 11.2 GB was file cache. Reporting only the total would overstate the leak.
    expect(memory.cgroupAnonBytes).toBeLessThanOrEqual(memory.cgroupTotalBytes);
  });

  it("never throws for a pid that does not exist", () => {
    // Health must not become the thing that breaks; every source is best-effort.
    expect(() => readFleetMemory(2 ** 30)).not.toThrow();
    expect(readFleetMemory(2 ** 30).fleetRssBytes).toBeGreaterThanOrEqual(0);
  });
});
