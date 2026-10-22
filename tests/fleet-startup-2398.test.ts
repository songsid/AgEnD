import { describe, expect, it } from "vitest";
import { FleetStartup } from "../src/fleet-startup.js";
import { guestStatus } from "../src/web-guest-access.js";

describe("one boot's dashboard progress", () => {
  it("starts queued, then observes attempts without counting failures as ready", () => {
    const boot = new FleetStartup(["general", "worker", "classic"]);
    expect(boot.phase("general")).toBe("queued");
    expect(boot.snapshot()).toEqual({ phase: "starting", ready: 0, total: 3, failed: 0 });
    const first = boot.begin("general")!;
    expect(boot.phase("general")).toBe("starting");
    expect(boot.finish("general", first, true)).toBe(true);
    expect(boot.phase("general")).toBeUndefined();
    const failed = boot.begin("worker")!;
    boot.finish("worker", failed, false);
    expect(boot.snapshot()).toEqual({ phase: "starting", ready: 1, total: 3, failed: 1 });
    const retry = boot.begin("worker")!;
    boot.finish("worker", retry, true);
    expect(boot.snapshot()).toEqual({ phase: "starting", ready: 2, total: 3, failed: 0 });
  });

  it("a stale completion cannot replace a newer attempt, and unknown names cannot enlarge the roster", () => {
    const boot = new FleetStartup(["worker"]);
    const old = boot.begin("worker")!;
    const replacement = boot.begin("worker")!;
    expect(boot.finish("worker", old, true)).toBe(false);
    expect(boot.phase("worker")).toBe("starting");
    expect(boot.begin("unknown")).toBeNull();
    boot.finish("worker", replacement, false);
    expect(boot.snapshot()).toEqual({ phase: "starting", ready: 0, total: 1, failed: 1 });
  });

  it("guest status carries only its instance phases, with no fleet counts or hidden names", () => {
    const projected = guestStatus({ startup: { ready: 1, total: 50 }, instances: [
      { name: "mine", status: "stopped", startup_phase: "queued" },
      { name: "hidden", status: "running", startup_phase: "starting" },
    ] }, new Set(["mine"]));
    expect(projected).toEqual({ canvas_worker: false, instances: [{ name: "mine", status: "stopped", startup_phase: "queued" }] });
  });
});
