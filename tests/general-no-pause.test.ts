import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { outboundHandlers } from "../src/outbound-handlers.js";

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "agend-general-no-pause-"));
  const fm = new FleetManager(dataDir);
  fm.fleetConfig = {
    defaults: {},
    instances: {
      coordinator: { working_directory: dataDir, general_topic: true },
      worker: { working_directory: dataDir },
    },
  } as any;
  const generalPause = vi.fn().mockResolvedValue(undefined);
  const workerPause = vi.fn().mockResolvedValue(undefined);
  fm.lifecycle.daemons.set("coordinator", { pause: generalPause, isPaused: false } as any);
  fm.lifecycle.daemons.set("worker", { pause: workerPause, isPaused: true } as any);
  return { dataDir, fm, generalPause, workerPause };
}

describe("General manual pause guard", () => {
  it("rejects the FleetManager facade and final lifecycle backstop", async () => {
    const { dataDir, fm, generalPause } = setup();
    try {
      await expect(fm.changeInstancePauseState("coordinator", "pause"))
        .rejects.toThrow("General cannot be paused");
      await expect(fm.lifecycle.pause("coordinator"))
        .rejects.toThrow("General cannot be paused");
      expect(generalPause).not.toHaveBeenCalled();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("returns a direct MCP error without calling lifecycle.pause", async () => {
    const { dataDir, fm, generalPause } = setup();
    const respond = vi.fn();
    try {
      await outboundHandlers.get("pause_instance")!(
        fm,
        { name: "coordinator" },
        respond,
        { instanceName: "caller" },
      );

      expect(respond).toHaveBeenCalledWith(null, "General cannot be paused");
      expect(generalPause).not.toHaveBeenCalled();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not change worker pause behavior", async () => {
    const { dataDir, fm, workerPause } = setup();
    try {
      await fm.lifecycle.pause("worker");
      expect(workerPause).toHaveBeenCalledOnce();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("never selects General for warm-cap eviction", () => {
    const { dataDir, fm } = setup();
    fm.fleetConfig!.defaults.warm_cap = 1;
    vi.spyOn(fm, "getInstanceStatus").mockReturnValue("running");
    vi.spyOn(fm, "getInstanceExecutionState").mockReturnValue("idle");
    const pause = vi.spyOn(fm.lifecycle, "pause").mockResolvedValue(undefined);
    try {
      (fm as any).enforceWarmCap();
      expect(pause).toHaveBeenCalledOnce();
      expect(pause).toHaveBeenCalledWith("worker");
      expect(pause).not.toHaveBeenCalledWith("coordinator");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
