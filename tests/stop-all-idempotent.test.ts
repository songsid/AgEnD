import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";

// SIGINT and SIGTERM share one shutdown handler, and the uncaughtException path
// calls stopAll() too, so overlapping runs were possible. Each run snapshotted the
// daemon map and called stop() on the same daemons concurrently.

describe("FleetManager.stopAll", () => {
  it("returns the same promise for concurrent calls", async () => {
    const fm = new FleetManager(mkdtempSync(join(tmpdir(), "agend-stopall-")));
    const a = fm.stopAll();
    const b = fm.stopAll();
    expect(a).toBe(b);
    await expect(a).resolves.toBeUndefined();
  });

  it("still works for a genuine later stop (the latch is not permanent)", async () => {
    // A fleet can be stopped, started again, and stopped again in one process, so
    // the guard must only cover the in-flight window.
    const fm = new FleetManager(mkdtempSync(join(tmpdir(), "agend-stopall-")));
    const first = fm.stopAll();
    await first;
    const second = fm.stopAll();
    expect(second).not.toBe(first);
    await expect(second).resolves.toBeUndefined();
  });
});
