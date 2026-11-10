/**
 * Model discovery may start from an unrelated saveFleetConfig(). Its isolate does not inherit
 * parent backend mocks. Default only that isolate to the existing fake, retaining Node's
 * other exports and all other Worker kinds. Real probe tests opt in explicitly through
 * useRealProbeWorkers(); they still run beneath the unchanged native process guard.
 */
import { afterEach, beforeEach, vi } from "vitest";
import { drainProbeWorkers, resetProbeWorkerDefault } from "./support/probe-worker-default.js";

vi.mock("node:worker_threads", async original => {
  const native = await original<typeof import("node:worker_threads")>();
  const { testWorkerConstructor } = await import("./support/probe-worker-default.js");
  return { ...native, Worker: testWorkerConstructor(native.Worker) };
});

resetProbeWorkerDefault();
beforeEach(resetProbeWorkerDefault);
afterEach(drainProbeWorkers);
