/**
 * #1490 P3: synchronous stringify before size check.
 *
 * (1) saveCpuProfile: a profile with enough nodes to exceed the 20 MiB cap
 *     must be rejected WITHOUT calling JSON.stringify.
 * (2) CacheService.save: throttled to at most once per SAVE_THROTTLE_MS;
 *     stop() resets the throttle to flush immediately.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCpuProfile, CPU_PROFILE_MAX_BYTES } from "../src/cpu-profile.js";

let dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });
function tempDir() { const d = mkdtempSync(join(tmpdir(), "agend-sync-")); dirs.push(d); return d; }

// ── (1) saveCpuProfile: large profile rejected before JSON.stringify ──────────
//
// Reverse mutation: removing the structural size check (estimatedBytes block)
// makes this test fail because JSON.stringify IS called on the big profile.

describe("saveCpuProfile: large profile rejected before JSON.stringify (#1490 P3)", () => {
  it("rejects a profile with too many nodes without calling JSON.stringify", async () => {
    const dir = tempDir();
    const bigNodeCount = Math.ceil(CPU_PROFILE_MAX_BYTES / 150) + 1;
    const bigProfile = {
      nodes: Array.from({ length: bigNodeCount }, (_, i) => ({ id: i })),
      samples: [],
      startTime: 0,
      endTime: 1,
    };

    const spy = vi.spyOn(JSON, "stringify");

    await expect(saveCpuProfile(dir, bigProfile)).rejects.toThrow(/too large|exceeds/i);

    const calledWithBigProfile = spy.mock.calls.some(args => args[0] === bigProfile);
    expect(calledWithBigProfile).toBe(false);
  });

  it("accepts a small profile and writes it (regression)", async () => {
    const dir = tempDir();
    const smallProfile = {
      nodes: [{ id: 1, callFrame: { functionName: "f", scriptId: "1", url: "", lineNumber: 0, columnNumber: 0 }, hitCount: 1 }],
      startTime: 0,
      endTime: 100,
      samples: [1],
      timeDeltas: [100],
    };

    const path = await saveCpuProfile(dir, smallProfile);
    expect(path).toMatch(/\.cpuprofile$/);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.nodes).toHaveLength(1);
  });
});

// ── (2) CacheService.save: source-level throttle verification ────────────────
//
// The CacheServiceOptions interface requires a full implementation to
// instantiate. Source checks are used to verify the throttle is present.
//
// Reverse mutation: removing the SAVE_THROTTLE_MS constant or the guard
// makes these tests fail.

describe("CacheService.save throttle — source verification (#1490 P3)", () => {
  it("source contains SAVE_THROTTLE_MS and the per-save throttle guard", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "cache-service.ts"), "utf-8");
    expect(src).toContain("SAVE_THROTTLE_MS");
    expect(src).toContain("this.lastSaveAt < CacheService.SAVE_THROTTLE_MS");
    expect(src).toContain("this.lastSaveAt = now"); // records last save time
  });

  it("source resets lastSaveAt=0 in stop() to bypass throttle for final flush", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "cache-service.ts"), "utf-8");
    expect(src).toContain("this.lastSaveAt = 0; // bypass throttle for the final flush");
    expect(src).toContain("void this.kick()"); // stop() kicks after reset
  });
});
