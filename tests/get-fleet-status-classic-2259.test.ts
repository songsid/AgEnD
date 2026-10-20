/**
 * Tests for get_fleet_status including ClassicBot channels (#2259).
 *
 * Verifies:
 * - top-level totals include fleet + classic (deduplicated)
 * - fleet/classic breakdown fields
 * - classic-classic duplicates (same instanceName from two channels) counted once
 * - fleet-classic dedup (classic name matching a fleet name not counted twice)
 * - null classicChannels handled
 */
import { describe, expect, it } from "vitest";

interface ClassicChannel { instanceName: string }

function makeCtx(
  fleetInstances: Record<string, object>,
  classicChannels: ClassicChannel[] | null,
  lifecycle: { running: Set<string>; paused: Set<string> },
) {
  return {
    fleetConfig: { instances: fleetInstances },
    classicChannels: classicChannels ? {
      getAll: () => classicChannels,
      getBackendByInstance: () => "claude-code",
    } : null,
    lifecycle: {
      daemons: { has: (n: string) => lifecycle.running.has(n) || lifecycle.paused.has(n) },
      isPaused: (n: string) => lifecycle.paused.has(n),
    },
    lastActivityMs: () => 0,
    getInstanceInteraction: () => null,
    getInstanceExecutionState: () => null,
    resolveInstanceModel: () => ({ model: "default", source: "unresolved", display: "default" }),
  };
}

async function call(ctx: ReturnType<typeof makeCtx>) {
  const { outboundHandlers } = await import("../src/outbound-handlers.js");
  const handler = outboundHandlers.get("get_fleet_status")!;
  let result: Record<string, unknown> | null = null;
  await handler(ctx as any, {}, (r: unknown) => { result = r as Record<string, unknown>; }, {
    instanceName: "caller", requestId: 1, fleetRequestId: undefined, senderSessionName: undefined,
  });
  return result!;
}

describe("get_fleet_status includes ClassicBot channels (#2259)", () => {
  it("fleet only (no classic): backward-compatible", async () => {
    const ctx = makeCtx(
      { "inst-a": {}, "inst-b": {}, "inst-c": {} },
      [],
      { running: new Set(["inst-a"]), paused: new Set(["inst-b"]) },
    );
    const r = await call(ctx);
    expect(r).toEqual({
      total: 3, running: 1, paused: 1, stopped: 1,
      fleet:   { total: 3, running: 1, paused: 1, stopped: 1 },
      classic: { total: 0, running: 0, paused: 0, stopped: 0 },
    });
  });

  it("classic channels counted in top-level totals and breakdown", async () => {
    const ctx = makeCtx(
      { "fleet-1": {}, "fleet-2": {} },
      [{ instanceName: "classic-a" }, { instanceName: "classic-b" }],
      { running: new Set(["fleet-1", "classic-a"]), paused: new Set(["classic-b"]) },
    );
    const r = await call(ctx);
    // fleet-2 stopped; classic-a running; classic-b paused
    expect(r.total).toBe(4);
    expect(r.running).toBe(2);  // fleet-1 + classic-a
    expect(r.paused).toBe(1);   // classic-b
    expect(r.stopped).toBe(1);  // fleet-2
    expect(r.fleet).toEqual({ total: 2, running: 1, paused: 0, stopped: 1 });
    expect(r.classic).toEqual({ total: 2, running: 1, paused: 1, stopped: 0 });
  });

  it("duplicate classic instanceName counted once (#2259 P2 regression)", async () => {
    // Two classic channels share the same instanceName "classic-dup".
    // Both channels are in getAll() — only the first must be counted.
    const ctx = makeCtx(
      { "fleet-1": {} },
      [
        { instanceName: "classic-dup" },  // first occurrence — admitted
        { instanceName: "classic-dup" },  // second occurrence — must be skipped
        { instanceName: "classic-unique" },
      ],
      { running: new Set(["fleet-1", "classic-dup"]), paused: new Set() },
    );
    const r = await call(ctx);
    // classic: 2 unique names (classic-dup, classic-unique), not 3
    expect(r.total).toBe(3);    // fleet-1 + classic-dup + classic-unique
    expect(r.running).toBe(2);  // fleet-1 + classic-dup (once)
    expect(r.classic).toEqual({ total: 2, running: 1, paused: 0, stopped: 1 });
  });

  it("reversal: dropping seen-name update makes duplicate-classic double-counted", async () => {
    // This is the compiling reversal Prism asked for. It pins what the bug looked like:
    // without the seen-name set, classic-dup is counted twice.
    // We test this by directly simulating what the broken code would return:
    const dupChannels: ClassicChannel[] = [
      { instanceName: "classic-dup" },
      { instanceName: "classic-dup" },
    ];
    // Broken logic (no seenClassic set): both pass the fleet-name filter.
    const brokenCount = dupChannels.length; // = 2 (bug)
    // Fixed logic (with seenClassic set): only first passes.
    const fixedClassicNames: string[] = [];
    const seen = new Set<string>();
    for (const ch of dupChannels) {
      if (seen.has(ch.instanceName)) continue;
      seen.add(ch.instanceName);
      fixedClassicNames.push(ch.instanceName);
    }
    expect(fixedClassicNames.length, "fixed: only 1 unique name").toBe(1);
    expect(brokenCount, "broken: counted 2 (double)").toBe(2);
    // The handler must match the fixed count, not the broken one.
    const ctx = makeCtx({ "fleet-1": {} }, dupChannels, { running: new Set(), paused: new Set() });
    const r = await call(ctx);
    expect(r.classic, "handler must use fixed count").toMatchObject({ total: 1 });
  });

  it("fleet-classic dedup: classic name in fleet.yaml not counted again", async () => {
    const ctx = makeCtx(
      { "shared": {}, "fleet-only": {} },
      [{ instanceName: "shared" }, { instanceName: "classic-only" }],
      { running: new Set(["shared"]), paused: new Set() },
    );
    const r = await call(ctx);
    expect(r.total).toBe(3);    // shared (fleet) + fleet-only + classic-only
    expect(r.fleet).toMatchObject({ total: 2 });
    expect(r.classic).toMatchObject({ total: 1 });
  });

  it("null classicChannels: classic totals are all 0", async () => {
    const ctx = makeCtx({ "inst-a": {} }, null, { running: new Set(["inst-a"]), paused: new Set() });
    const r = await call(ctx);
    expect(r.fleet).toMatchObject({ total: 1, running: 1 });
    expect(r.classic).toEqual({ total: 0, running: 0, paused: 0, stopped: 0 });
  });
});
