import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { outboundHandlers } from "../src/outbound-handlers.js";

const dataDirs: string[] = [];
function makeFleet(): FleetManager {
  const dir = join(tmpdir(), `agend-ls-state-${process.pid}-${Date.now()}-${dataDirs.length}`);
  mkdirSync(dir, { recursive: true });
  dataDirs.push(dir);
  const fm = new FleetManager(dir);
  fm.fleetConfig = { defaults: {}, instances: { worker: { working_directory: dir } } } as any;
  return fm;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("agend ls execution-state recovery", () => {
  it("does not keep a stale crashed cache after the in-process daemon is running", () => {
    const fm = makeFleet();
    const instance = "worker";
    fm.lifecycle.daemons.set(instance, { getProcessStatus: () => "running" } as any);
    (fm as any).instanceProcessStatus.set(instance, "crashed");

    expect(fm.getInstanceStatus(instance)).toBe("running");
    expect((fm as any).instanceProcessStatus.has(instance)).toBe(false);
  });

  it("removes a persisted crash marker when a running process is reported", () => {
    const fm = makeFleet();
    const marker = join(fm.getInstanceDir("worker"), "crash-state.json");
    mkdirSync(join(fm.getInstanceDir("worker")), { recursive: true });
    writeFileSync(marker, JSON.stringify({ crashesInWindow: 3, resumeDisabled: true }));

    (fm as any).cacheInstanceProcessStatus("worker", "running");

    expect(existsSync(marker)).toBe(false);
  });

  it("treats start_instance on a paused target as an explicit wake", async () => {
    const fm = makeFleet();
    vi.spyOn(fm.lifecycle, "isPaused").mockReturnValue(true);
    const wake = vi.spyOn(fm.lifecycle, "wake").mockResolvedValue(undefined);
    const explicit = vi.spyOn(fm, "explicitWake");
    const respond = vi.fn();

    await outboundHandlers.get("start_instance")!(
      fm,
      { name: "worker" },
      respond,
      { instanceName: "caller" } as any,
    );

    expect(wake).toHaveBeenCalledWith("worker", 30_000);
    expect(explicit).toHaveBeenCalledWith("worker", 30_000, true);
    expect(respond).toHaveBeenCalledWith({ success: true, status: "started" });
  });

  it.each(["cold", "crashed", "classic", "wake"] as const)("#2473 MCP %s recovery preserves explicit per-instance intent", async kind => {
    const fm = makeFleet(); const start = vi.spyOn(fm, "startInstance").mockResolvedValue(undefined);
    const restart = vi.spyOn(fm, "restartSingleInstance").mockResolvedValue(undefined);
    const wake = vi.spyOn(fm, "explicitWake").mockResolvedValue(undefined);
    vi.spyOn(fm, "connectIpcToInstance").mockResolvedValue(undefined);
    if (kind === "crashed") {
      fm.lifecycle.daemons.set("worker", { getProcessStatus: () => "crashed" } as any);
      vi.spyOn(fm, "getInstanceStatus").mockReturnValue("crashed");
    } else if (kind === "classic") {
      delete fm.fleetConfig!.instances.worker;
      (fm as any).classicChannels = { getChannelIdByInstance: () => "channel" };
    }
    const respond = vi.fn();
    await outboundHandlers.get(kind === "wake" ? "wake_instance" : "start_instance")!(fm, { name: "worker" }, respond, { instanceName: "caller" } as any);
    if (kind === "cold") expect(start).toHaveBeenCalledWith("worker", fm.fleetConfig!.instances.worker, true, "fleet-topic", true);
    else if (kind === "wake") expect(wake).toHaveBeenCalledWith("worker", 30_000, true);
    else expect(restart).toHaveBeenCalledWith("worker", { explicit: true });
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it("keeps fleet startup pause-safe but wakes on an explicit FleetManager start", async () => {
    const fm = makeFleet();
    const isPaused = vi.spyOn(fm.lifecycle, "isPaused").mockReturnValue(true);
    const wake = vi.spyOn(fm.lifecycle, "wake").mockResolvedValue(undefined);

    await fm.startInstance("worker", fm.fleetConfig!.instances.worker, false);
    expect(wake).not.toHaveBeenCalled();

    await fm.startInstance("worker", fm.fleetConfig!.instances.worker, false, "fleet-topic", true);
    expect(wake).toHaveBeenCalledWith("worker", 30_000);
    expect(isPaused).toHaveBeenCalled();
  });
});
