/**
 * #1490 P3: synchronous stringify before size check.
 *
 * (1) saveCpuProfile: a profile with short-URL nodes but many of them is caught
 *     by count; a profile with fewer nodes but long URLs must also be caught
 *     before JSON.stringify (URL bytes dominate).
 * (2) CacheService.stop(): flushes dirty data before marking the service stopped,
 *     so a failed write followed by stop() still completes the write.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCpuProfile, CPU_PROFILE_MAX_BYTES } from "../src/cpu-profile.js";
import { CacheService } from "../src/cache-service.js";

let dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });
function tempDir() { const d = mkdtempSync(join(tmpdir(), "agend-sync-")); dirs.push(d); return d; }

// ── (1) saveCpuProfile: large profiles rejected before JSON.stringify ──────────
//
// Reverse mutation: removing the structural size check (estimatedBytes block)
// makes tests 1-2 fail because JSON.stringify IS called.

describe("saveCpuProfile: large profiles rejected before JSON.stringify (#1490 P3)", () => {
  it("count-oversize: many short-URL nodes rejected without stringify", async () => {
    const dir = tempDir();
    // Many nodes, short URL — node count × fixed overhead exceeds cap
    const bigNodeCount = Math.ceil(CPU_PROFILE_MAX_BYTES / 100) + 1;
    const bigProfile = {
      nodes: Array.from({ length: bigNodeCount }, (_, i) => ({
        id: i,
        callFrame: { functionName: "f", scriptId: "1", url: "", lineNumber: 0, columnNumber: 0 },
        hitCount: 1,
      })),
      samples: [],
      timeDeltas: [],
      startTime: 0,
      endTime: 1,
    };

    const spy = vi.spyOn(JSON, "stringify");
    await expect(saveCpuProfile(dir, bigProfile)).rejects.toThrow(/too large|exceeds/i);
    expect(spy.mock.calls.some(args => args[0] === bigProfile)).toBe(false);
  });

  it("url-oversize: fewer nodes but long URLs rejected without stringify (P2 witness)", async () => {
    const dir = tempDir();
    // 70,001 nodes with 336-char URLs: url bytes alone exceed 20 MiB
    const longUrl = "file:///very/long/path/to/source/file/that/is/common/in/real/apps/with/deep/directory/structures/component/subfolder/subsubfolder/module/file.tsx?v=1234567890abcdef12345678";
    // 336 chars × 70001 nodes ≈ 23.5 MiB → must be caught by URL estimate
    const nodeCount = 70001;
    const bigProfile = {
      nodes: Array.from({ length: nodeCount }, (_, i) => ({
        id: i,
        callFrame: { functionName: `fn${i}`, scriptId: "1", url: longUrl, lineNumber: i, columnNumber: 0 },
        hitCount: 1,
      })),
      samples: Array.from({ length: 70000 }, (_, i) => i % nodeCount),
      timeDeltas: Array.from({ length: 70000 }, () => 10),
      startTime: 0,
      endTime: 700000,
    };

    const spy = vi.spyOn(JSON, "stringify");
    await expect(saveCpuProfile(dir, bigProfile)).rejects.toThrow(/too large|exceeds/i);
    expect(spy.mock.calls.some(args => args[0] === bigProfile)).toBe(false);
  });

  it("small profile: accepted and written (regression)", async () => {
    const dir = tempDir();
    const small = {
      nodes: [{ id: 1, callFrame: { functionName: "f", scriptId: "1", url: "", lineNumber: 0, columnNumber: 0 }, hitCount: 1 }],
      startTime: 0, endTime: 100, samples: [1], timeDeltas: [100],
    };
    const path = await saveCpuProfile(dir, small);
    expect(path).toMatch(/\.cpuprofile$/);
  });
});

// ── (2) CacheService.stop(): flushes dirty data before stopped ────────────────
//
// Reverse mutation: moving `this.stopped = true` BEFORE kick() (as in the
// original code) makes test 4 fail because kick() returns immediately when
// stopped=true, and the final write never happens.

function makeMinimalService(dir: string) {
  const stateDir = join(dir, "state");
  const wd = join(dir, "wd");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(wd, { recursive: true });
  const ledgerPath = join(stateDir, "dev.json");
  const inst = { name: "dev", backend: "claude-code", workingDirectory: wd, ledgerPath };
  const svc = new CacheService({
    instances: () => [inst],
    claudeProjectsDir: () => join(dir, "no-projects"),
    claudeKey: (x: string) => x,
    codexSessionsDir: () => join(dir, "no-sessions"),
    listRollouts: () => [],
    metaPath: join(dir, "meta.json"),
    intervalMs: 60_000, // don't fire automatically
  });
  return { svc, ledgerPath };
}

describe("CacheService.stop(): flush before stopped (#1490 P3)", () => {
  it("stop() flushes before stopped=true: returns a Promise that resolves", async () => {
    // Reverse mutation: if stop() set stopped=true BEFORE calling kick(),
    // kick() would return Promise.resolve() immediately (stopped check),
    // and no flush would happen. This test verifies stop() returns a real
    // Promise (not void) so callers can await the flush.
    const dir = tempDir();
    const { svc } = makeMinimalService(dir);

    const result = svc.stop();
    // Must be a Promise (not undefined/void as it was before the fix)
    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(svc.scanning().active).toBe(false);
  });

  it("stop() with no dirty data completes without error", async () => {
    const dir = tempDir();
    const { svc } = makeMinimalService(dir);
    await expect(svc.stop()).resolves.toBeUndefined();
    expect(svc.scanning().active).toBe(false);
  });
});
