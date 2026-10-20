/**
 * Tests for get_fleet_status including ClassicBot channels (#2204).
 *
 * Verifies that:
 * - top-level totals include both fleet and classic instances
 * - breakdown fleet/classic fields are present
 * - totals match what agend ls would show for the same fixture
 * - dedup: classic names already in fleet.yaml are not double-counted
 */
import { describe, expect, it } from "vitest";

// ── Minimal handler harness ──────────────────────────────────────────────────

type Status = "running" | "paused" | "stopped";
interface ClassicChannel { instanceName: string }

function makeCtx(
  fleetInstances: Record<string, object>,
  classicChannels: ClassicChannel[],
  lifecycle: { running: Set<string>; paused: Set<string> },
) {
  return {
    fleetConfig: { instances: fleetInstances },
    classicChannels: {
      getAll: () => classicChannels,
      getBackendByInstance: () => "claude-code",
    },
    lifecycle: {
      daemons: {
        has: (n: string) => lifecycle.running.has(n) || lifecycle.paused.has(n),
      },
      isPaused: (n: string) => lifecycle.paused.has(n),
    },
    lastActivityMs: () => 0,
    getInstanceInteraction: () => null,
    getInstanceExecutionState: () => null,
    resolveInstanceModel: () => ({ model: "default", source: "unresolved", display: "default" }),
  };
}

async function callGetFleetStatus(ctx: ReturnType<typeof makeCtx>) {
  const { outboundHandlers } = await import("../src/outbound-handlers.js");
  const handler = outboundHandlers.get("get_fleet_status")!;
  let result: Record<string, unknown> | null = null;
  await handler(ctx as any, {}, (r: unknown) => { result = r as Record<string, unknown>; }, {
    instanceName: "caller", requestId: 1, fleetRequestId: undefined, senderSessionName: undefined,
  });
  return result!;
}

// ── Helpers matching agend ls summary logic ──────────────────────────────────

function lsSummary(
  fleetInstances: Record<string, object>,
  classicChannels: ClassicChannel[],
  lifecycle: { running: Set<string>; paused: Set<string> },
) {
  const fleetNames = Object.keys(fleetInstances);
  const fleetNameSet = new Set(fleetNames);
  const classic = classicChannels.filter(ch => !fleetNameSet.has(ch.instanceName));
  const allNames = [...fleetNames, ...classic.map(c => c.instanceName)];
  const getStatus = (n: string): Status =>
    lifecycle.paused.has(n) ? "paused"
    : (lifecycle.running.has(n) || lifecycle.paused.has(n)) && !lifecycle.paused.has(n) && lifecycle.running.has(n) ? "running"
    : "stopped";
  const running = allNames.filter(n => !lifecycle.paused.has(n) && (lifecycle.running.has(n) || lifecycle.paused.has(n)) && !lifecycle.paused.has(n)).length;
  // Simpler:
  const r = allNames.filter(n => lifecycle.running.has(n) && !lifecycle.paused.has(n)).length;
  const p = allNames.filter(n => lifecycle.paused.has(n)).length;
  const s = allNames.length - r - p;
  return { total: allNames.length, running: r, paused: p, stopped: s };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("get_fleet_status includes ClassicBot channels (#2204)", () => {
  it("fleet only (no classic): same as before", async () => {
    const ctx = makeCtx(
      { "inst-a": {}, "inst-b": {}, "inst-c": {} },
      [],
      { running: new Set(["inst-a"]), paused: new Set(["inst-b"]) },
    );
    const r = await callGetFleetStatus(ctx);
    expect(r.total).toBe(3);
    expect(r.running).toBe(1);
    expect(r.paused).toBe(1);
    expect(r.stopped).toBe(1);
    expect(r.fleet).toEqual({ total: 3, running: 1, paused: 1, stopped: 1 });
    expect(r.classic).toEqual({ total: 0, running: 0, paused: 0, stopped: 0 });
  });

  it("classic channels are included in top-level totals", async () => {
    const ctx = makeCtx(
      { "fleet-1": {}, "fleet-2": {} },
      [
        { instanceName: "classic-a" },
        { instanceName: "classic-b" },
        { instanceName: "classic-c" },
      ],
      {
        running: new Set(["fleet-1", "classic-a"]),
        paused: new Set(["classic-b"]),
      },
    );
    const r = await callGetFleetStatus(ctx);
    expect(r.total).toBe(5);     // 2 fleet + 3 classic
    expect(r.running).toBe(2);   // fleet-1 + classic-a
    expect(r.paused).toBe(1);    // classic-b
    expect(r.stopped).toBe(2);   // fleet-2 + classic-c
  });

  it("breakdown fleet/classic fields match their respective subsets", async () => {
    const ctx = makeCtx(
      { "fleet-1": {}, "fleet-2": {}, "fleet-3": {} },
      [{ instanceName: "classic-x" }, { instanceName: "classic-y" }],
      {
        running: new Set(["fleet-1", "classic-x"]),
        paused: new Set(["fleet-2"]),
      },
    );
    const r = await callGetFleetStatus(ctx);
    expect(r.fleet).toEqual({ total: 3, running: 1, paused: 1, stopped: 1 });
    expect(r.classic).toEqual({ total: 2, running: 1, paused: 0, stopped: 1 });
  });

  it("classic name already in fleet.yaml is not double-counted", async () => {
    const ctx = makeCtx(
      { "shared-name": {}, "fleet-only": {} },
      // "shared-name" also appears as a classic channel — must be skipped.
      [{ instanceName: "shared-name" }, { instanceName: "classic-only" }],
      { running: new Set(["shared-name"]), paused: new Set() },
    );
    const r = await callGetFleetStatus(ctx);
    // fleet: 2, classic (deduped): 1 → total 3
    expect(r.total).toBe(3);
    expect(r.fleet).toMatchObject({ total: 2 });
    expect(r.classic).toMatchObject({ total: 1 });
  });

  it("top-level totals match agend ls summary for the same fixture", async () => {
    // This test pins the equivalence the leader requested.
    const fleetInstances = { "agent-a": {}, "agent-b": {}, "agent-c": {} };
    const classicChannels = [
      { instanceName: "classic-p" },
      { instanceName: "classic-q" },
      { instanceName: "classic-r" },
    ];
    const lifecycle = {
      running: new Set(["agent-a", "agent-c", "classic-p", "classic-r"]),
      paused: new Set(["agent-b", "classic-q"]),
    };

    const ctx = makeCtx(fleetInstances, classicChannels, lifecycle);
    const toolResult = await callGetFleetStatus(ctx);
    const lsResult = lsSummary(fleetInstances, classicChannels, lifecycle);

    expect(toolResult.total).toBe(lsResult.total);
    expect(toolResult.running).toBe(lsResult.running);
    expect(toolResult.paused).toBe(lsResult.paused);
    expect(toolResult.stopped).toBe(lsResult.stopped);
  });

  it("no classic channels configured (null classicChannels): classic totals are 0", async () => {
    const ctx = makeCtx(
      { "inst-a": {} },
      [],
      { running: new Set(["inst-a"]), paused: new Set() },
    );
    // Simulate null classicChannels
    (ctx as any).classicChannels = null;
    const r = await callGetFleetStatus(ctx);
    expect(r.fleet).toMatchObject({ total: 1 });
    expect(r.classic).toEqual({ total: 0, running: 0, paused: 0, stopped: 0 });
  });
});
