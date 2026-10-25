import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { FleetManager } from "../src/fleet-manager.js";
import { SpawnGate } from "../src/spawn-gate.js";
import { StormWindow } from "../src/storm-window.js";

const owned: Array<{ fm: FleetManager; dir: string; storm: StormWindow }> = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-21T00:00:00Z")); });
afterEach(() => {
  for (const { fm, dir, storm } of owned.splice(0)) { fm.spawnGate.shutdown(); fm.memoryPressure.stop(); fm.stormWindow.shutdown(); storm.shutdown(); rmSync(dir, { recursive: true, force: true }); }
  vi.restoreAllMocks(); vi.useRealTimers();
});
it("logs actual batch totals, elapsed time and peak admitted lifecycle operations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agend-summary2288-"));
  const fm = new FleetManager(dir); const f = fm as any; const storm = new StormWindow(); owned.push({ fm, dir, storm });
  fm.spawnGate.shutdown(); f.spawnGate = new SpawnGate({ storm, concurrency: () => 6, staggerMs: () => 500, lowMemoryBytes: 0 });
  f.fleetConfig = { defaults: { startup: { concurrency: 6 } }, instances: {} };
  f.logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  vi.spyOn(fm.lifecycle, "isPaused").mockImplementation(name => name === "paused");
  // Only real queue/scheduler/summary run: no daemon construction, CLI, tmux or fleet lifecycle.
  const start = vi.spyOn(f, "startInstanceUnattended").mockImplementation(async (name: unknown) => {
    await new Promise<void>(resolve => setTimeout(resolve, 2000)); return name !== "failed";
  });
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  const onReady = vi.fn();
  const running = f.startInstancesWithConcurrency(["a", "b", "failed", "c", "paused"].map(name => [name, { working_directory: `/inert/${name === "a" || name === "failed" ? "one" : "two"}` }]), false, onReady);
  await vi.advanceTimersByTimeAsync(5000); await running;
  expect(start).toHaveBeenCalledTimes(4); expect(onReady).toHaveBeenCalledTimes(3);
  expect(f.logger.info).toHaveBeenCalledWith({ totalInstances: 4, classicInstances: 0, readyInstances: 3, elapsedSeconds: 4.5, peakConcurrentStarts: 2 }, "Fleet startup batch completed");
  expect(f.logger.info.mock.calls.filter(([, text]: unknown[]) => text === "Fleet startup batch completed")).toHaveLength(1);
});

it("ClassicBot rooms queue with the fleet instances in one batch: same gate, same summary; paused and fleet-named rooms are left out (#2642 follow-up)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agend-summary2288-"));
  const fm = new FleetManager(dir); const f = fm as any; const storm = new StormWindow(); owned.push({ fm, dir, storm });
  fm.spawnGate.shutdown(); f.spawnGate = new SpawnGate({ storm, concurrency: () => 6, staggerMs: () => 0, lowMemoryBytes: 0 });
  f.fleetConfig = { defaults: { startup: { concurrency: 6 } }, instances: {} };
  f.logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  vi.spyOn(fm.lifecycle, "isPaused").mockImplementation(name => name === "room-paused");
  const order: string[] = [];
  vi.spyOn(f, "startInstanceUnattended").mockImplementation(async (name: unknown) => {
    order.push(`fleet:${name}`); await new Promise<void>(resolve => setTimeout(resolve, 1000)); return true;
  });
  const classic = vi.spyOn(f, "startClassicInstanceUnattended").mockImplementation(async (ch: any) => {
    order.push(`classic:${ch.instanceName}`); await new Promise<void>(resolve => setTimeout(resolve, 1000)); return ch.instanceName !== "room-b";
  });
  const gate = vi.spyOn(f.spawnGate, "run");
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  const onReady = vi.fn();
  const rooms = ["room-a", "room-b", "room-paused", "a"].map(instanceName => ({ instanceName, channelId: `c-${instanceName}`, adapterId: "main" }));
  const running = f.startInstancesWithConcurrency([["a", { working_directory: "/inert/a" }]], true, onReady, rooms);
  await vi.advanceTimersByTimeAsync(10); 
  // All three admitted at once — the rooms do not wait for the fleet instance to finish.
  expect(order.sort()).toEqual(["classic:room-a", "classic:room-b", "fleet:a"]);
  await vi.advanceTimersByTimeAsync(2000); await running;
  expect(classic).toHaveBeenCalledTimes(2);
  expect(classic).toHaveBeenCalledWith(expect.objectContaining({ instanceName: "room-a" }), "classic instance");
  expect(gate.mock.calls.map(([req]: any[]) => [req.instanceName, req.reason, req.stage]).sort()).toEqual([
    ["a", "startup", "lifecycle"], ["room-a", "startup", "lifecycle"], ["room-b", "startup", "lifecycle"]]);
  expect(onReady.mock.calls.map(([n]) => n).sort()).toEqual(["a", "room-a"]);
  expect(f.logger.info).toHaveBeenCalledWith(expect.objectContaining({ totalInstances: 3, classicInstances: 2, readyInstances: 2 }), "Fleet startup batch completed");
});

it("a batch of only ClassicBot rooms still runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agend-summary2288-"));
  const fm = new FleetManager(dir); const f = fm as any; const storm = new StormWindow(); owned.push({ fm, dir, storm });
  fm.spawnGate.shutdown(); f.spawnGate = new SpawnGate({ storm, concurrency: () => 6, staggerMs: () => 0, lowMemoryBytes: 0 });
  f.fleetConfig = { defaults: { startup: { concurrency: 6 } }, instances: {} };
  f.logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const classic = vi.spyOn(f, "startClassicInstanceUnattended").mockResolvedValue(true);
  const running = f.startInstancesWithConcurrency([], true, undefined, [{ instanceName: "room", channelId: "c", adapterId: "main" }]);
  await vi.advanceTimersByTimeAsync(10); await running;
  expect(classic).toHaveBeenCalledOnce();
});
