import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";

afterEach(() => vi.useRealTimers());

describe("fleet startup queue", () => {
  it("excludes paused instances before applying the stagger delay", async () => {
    vi.useFakeTimers();
    const dataDir = mkdtempSync(join(tmpdir(), "agend-paused-startup-"));
    try {
      const fm = new FleetManager(dataDir);
      fm.fleetConfig = {
        defaults: { startup: { concurrency: 1, stagger_delay_ms: 5_000 } },
        instances: {},
      } as any;
      vi.spyOn(fm.lifecycle, "isPaused").mockImplementation(name => name === "paused");
      const startInstance = vi.spyOn(fm, "startInstance").mockImplementation(async name => {
        (fm as any).daemons.set(name, {});
      });
      const onReady = vi.fn();

      const startup = (fm as any).startInstancesWithConcurrency([
        ["paused", { working_directory: "/tmp/paused" }],
        ["running", { working_directory: "/tmp/running" }],
      ], false, onReady);
      await vi.advanceTimersByTimeAsync(0);
      await startup;

      expect(startInstance).toHaveBeenCalledTimes(1);
      expect(startInstance).toHaveBeenCalledWith(
        "running",
        expect.objectContaining({ working_directory: "/tmp/running" }),
        false,
      );
      expect(onReady).toHaveBeenCalledOnce();
      expect(onReady).toHaveBeenCalledWith("running");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
