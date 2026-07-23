import { describe, expect, it } from "vitest";
import { selectLruEvictions } from "../src/fleet-manager.js";

/** Build an opts object from simple per-instance maps. */
function opts(cfg: {
  general?: Set<string>;
  working?: Set<string>;
  evicting?: Set<string>;
  lastInbound?: Record<string, number>;
  exclude?: string;
}) {
  const general = cfg.general ?? new Set<string>();
  const working = cfg.working ?? new Set<string>();
  const evicting = cfg.evicting ?? new Set<string>();
  const lastInbound = cfg.lastInbound ?? {};
  return {
    exclude: cfg.exclude,
    isEvicting: (n: string) => evicting.has(n),
    isGeneral: (n: string) => general.has(n),
    isIdle: (n: string) => !working.has(n),
    lastInboundAt: (n: string) => lastInbound[n] ?? 0,
  };
}

describe("selectLruEvictions (warm_cap)", () => {
  it("cap 8 + 10 idle → evicts the 2 oldest by last-inbound", () => {
    const warm = Array.from({ length: 10 }, (_, i) => `inst-${i}`);
    // inst-0 oldest … inst-9 newest
    const lastInbound = Object.fromEntries(warm.map((n, i) => [n, 1_000 + i]));
    const victims = selectLruEvictions(warm, 8, opts({ lastInbound }));
    expect(victims).toEqual(["inst-0", "inst-1"]);
  });

  it("never evicts a general instance (even if it is the LRU)", () => {
    const warm = ["general", "a", "b"];
    const victims = selectLruEvictions(warm, 2, opts({
      general: new Set(["general"]),
      lastInbound: { general: 1, a: 100, b: 200 }, // general is oldest
    }));
    expect(victims).toEqual(["a"]); // general skipped, next-oldest idle evicted
  });

  it("never evicts a working/stuck instance", () => {
    const warm = ["w", "idle1", "idle2"];
    const victims = selectLruEvictions(warm, 2, opts({
      working: new Set(["w"]),
      lastInbound: { w: 1, idle1: 100, idle2: 200 }, // w oldest but working
    }));
    expect(victims).toEqual(["idle1"]);
  });

  it("cap 0 = unlimited → no eviction", () => {
    const warm = Array.from({ length: 20 }, (_, i) => `i${i}`);
    expect(selectLruEvictions(warm, 0, opts({}))).toEqual([]);
  });

  it("at or under cap → no eviction", () => {
    expect(selectLruEvictions(["a", "b"], 2, opts({}))).toEqual([]);
    expect(selectLruEvictions(["a"], 8, opts({}))).toEqual([]);
  });

  it("excludes the just-woken instance from eviction", () => {
    const warm = ["woken", "a", "b"];
    const victims = selectLruEvictions(warm, 2, opts({
      exclude: "woken",
      lastInbound: { woken: 1, a: 100, b: 200 }, // woken oldest but excluded
    }));
    expect(victims).toEqual(["a"]);
  });

  it("skips instances already being evicted (no double-pause)", () => {
    const warm = ["a", "b", "c"];
    const victims = selectLruEvictions(warm, 2, opts({
      evicting: new Set(["a"]),           // a already in-flight
      lastInbound: { a: 1, b: 100, c: 200 },
    }));
    expect(victims).toEqual(["b"]);       // a skipped, next-oldest chosen
  });

  it("evicts fewer than needed when not enough idle candidates exist", () => {
    // 5 warm, cap 2 → want to drop 3, but only 1 is idle-evictable
    const warm = ["w1", "w2", "gen", "w3", "idle"];
    const victims = selectLruEvictions(warm, 2, opts({
      working: new Set(["w1", "w2", "w3"]),
      general: new Set(["gen"]),
      lastInbound: { idle: 500 },
    }));
    expect(victims).toEqual(["idle"]);    // best-effort: only the one idle
  });

  it("missing last-inbound timestamp sorts oldest (evicted first)", () => {
    const warm = ["hasTs", "noTs", "x"];
    const victims = selectLruEvictions(warm, 2, opts({
      lastInbound: { hasTs: 100, x: 200 }, // noTs → 0
    }));
    expect(victims).toEqual(["noTs"]);
  });
});
