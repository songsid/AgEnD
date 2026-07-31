import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";

// /health used to answer 200 "ok" with a count of CONFIGURED instances, so every
// agent could be dead and every adapter down and it still looked green to an
// external monitor. getFleetHealth() reports what is actually true.

type Internals = {
  fleetConfig: unknown;
  adapterState: Map<string, { status: string; retryCount: number; lastError?: string }>;
  startupComplete: boolean;
  getInstanceStatus(name: string): string;
};

function makeFleet(opts: {
  instances?: Record<string, string>;          // name -> status
  adapters?: Record<string, string>;           // id -> status
  startupComplete?: boolean;
} = {}) {
  const fm = new FleetManager(mkdtempSync(join(tmpdir(), "agend-health-")));
  const internals = fm as unknown as Internals;
  const instances = opts.instances ?? {};
  internals.fleetConfig = {
    defaults: {},
    instances: Object.fromEntries(Object.keys(instances).map(n => [n, {}])),
  };
  internals.getInstanceStatus = (name: string) => instances[name] ?? "stopped";
  internals.adapterState = new Map(
    Object.entries(opts.adapters ?? {}).map(([id, status]) => [id, { status, retryCount: 0 }]),
  );
  internals.startupComplete = opts.startupComplete ?? true;
  return fm;
}

describe("getFleetHealth", () => {
  it("is ok when an adapter is connected and every instance runs", () => {
    const health = makeFleet({
      instances: { alpha: "running", beta: "running" },
      adapters: { telegram: "connected" },
    }).getFleetHealth();

    expect(health.status).toBe("ok");
    expect(health.problems).toEqual([]);
    expect(health.instances).toMatchObject({ configured: 2, running: 2, crashed: 0 });
    expect(health.adapters).toMatchObject({ total: 1, connected: 1 });
  });

  it("is down when adapters are configured but none is connected", () => {
    // The fleet cannot receive or answer a message at all — the case the old
    // endpoint reported as "ok".
    const health = makeFleet({
      instances: { alpha: "running" },
      adapters: { telegram: "retrying" },
    }).getFleetHealth();

    expect(health.status).toBe("down");
    expect(health.problems).toContain("no channel adapter is connected");
  });

  it("is degraded when an instance crashed but the channel still works", () => {
    const health = makeFleet({
      instances: { alpha: "running", beta: "crashed" },
      adapters: { telegram: "connected" },
    }).getFleetHealth();

    expect(health.status).toBe("degraded");
    expect(health.instances.crashed).toBe(1);
    expect(health.problems.some(p => p.includes("crashed"))).toBe(true);
  });

  it("reports per-adapter state so a retrying adapter is visible", () => {
    const health = makeFleet({
      instances: { alpha: "running" },
      adapters: { telegram: "connected", discord: "retrying" },
    }).getFleetHealth();

    expect(health.status).toBe("degraded");
    expect(health.adapters.states).toEqual({ telegram: "connected", discord: "retrying" });
    expect(health.problems.some(p => p.includes("discord"))).toBe(true);
  });

  it("counts paused and stopped instances without calling them problems", () => {
    const health = makeFleet({
      instances: { alpha: "running", beta: "paused", gamma: "stopped" },
      adapters: { telegram: "connected" },
    }).getFleetHealth();

    expect(health.instances).toMatchObject({ configured: 3, running: 1, paused: 1, stopped: 1 });
    expect(health.status).toBe("ok");
  });

  it("flags incomplete startup", () => {
    const health = makeFleet({
      instances: { alpha: "running" },
      adapters: { telegram: "connected" },
      startupComplete: false,
    }).getFleetHealth();

    expect(health.status).toBe("degraded");
    expect(health.problems).toContain("startup has not completed");
  });

  it("is ok with no adapters configured at all (a local-only fleet)", () => {
    const health = makeFleet({ instances: { alpha: "running" } }).getFleetHealth();
    expect(health.status).toBe("ok");
  });
});
