/**
 * #1490 P3: synchronous stringify before size check + stop() flush.
 *
 * (1) saveCpuProfile: size estimation uses Buffer.byteLength(JSON.stringify(str))
 *     for exact UTF-8+escaping bytes per callFrame URL/functionName, and counts
 *     positionTicks and children arrays per node, catching all variable data.
 * (2) CacheService.stop(): sets closing flag, joins in-flight pass, then flushes.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCpuProfile, CPU_PROFILE_MAX_BYTES } from "../src/cpu-profile.js";
import { CacheService } from "../src/cache-service.js";
import { emptyLedger } from "../src/cache-ledger.js";

let dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });
function tempDir() { const d = mkdtempSync(join(tmpdir(), "agend-sync-")); dirs.push(d); return d; }

// ── (1) saveCpuProfile: large profiles rejected before JSON.stringify ──────────
//
// Reverse mutation: removing the structural size check makes all oversize
// tests fail because JSON.stringify IS called on the big profiles.

describe("saveCpuProfile: large profiles rejected before JSON.stringify (#1490 P3)", () => {
  it("count-oversize: many short-URL ASCII nodes rejected without stringify", async () => {
    const dir = tempDir();
    const bigNodeCount = Math.ceil(CPU_PROFILE_MAX_BYTES / 100) + 1;
    const bigProfile = {
      nodes: Array.from({ length: bigNodeCount }, (_, i) => ({
        id: i,
        callFrame: { functionName: "f", scriptId: "1", url: "", lineNumber: 0, columnNumber: 0 },
        hitCount: 1,
      })),
      samples: [], timeDeltas: [], startTime: 0, endTime: 1,
    };
    const spy = vi.spyOn(JSON, "stringify");
    await expect(saveCpuProfile(dir, bigProfile)).rejects.toThrow(/too large|exceeds/i);
    expect(spy.mock.calls.some(args => args[0] === bigProfile)).toBe(false);
  });

  it("url-oversize (Unicode/CJK): fewer nodes but CJK URLs exceed cap without stringify", async () => {
    const dir = tempDir();
    const cjkUrl = "file:///work/" + "\u5de5\u4f5c/".repeat(48) + "entry.js";
    // Verify: JSON-encoded UTF-8 bytes > raw string length (CJK: 1 UTF-16 unit
    // but 3 UTF-8 bytes in JSON output).
    const jsonEncodedBytes = Buffer.byteLength(JSON.stringify(cjkUrl), "utf8") - 2;
    expect(jsonEncodedBytes).toBeGreaterThan(cjkUrl.length);

    const nodeCount = 60001;
    const bigProfile = {
      nodes: Array.from({ length: nodeCount }, (_, i) => ({
        id: i,
        callFrame: { functionName: "fn" + (i % 1000), scriptId: "1", url: cjkUrl,
          lineNumber: i, columnNumber: 0 },
        hitCount: 1,
      })),
      samples: Array.from({ length: 60000 }, (_, i) => i % nodeCount),
      timeDeltas: Array.from({ length: 60000 }, () => 10),
      startTime: 0, endTime: 600000,
    };
    const spy = vi.spyOn(JSON, "stringify");
    await expect(saveCpuProfile(dir, bigProfile)).rejects.toThrow(/too large|exceeds/i);
    expect(spy.mock.calls.some(args => args[0] === bigProfile)).toBe(false);
  });

  it("url-oversize (backslash): backslash-heavy URLs exceed cap without stringify", async () => {
    // Prism witness: each backslash becomes \\\\ in JSON (2 bytes → 2 bytes escaping overhead).
    // 30,001 nodes x 743 JSON bytes (381 raw bytes each backslash url) ≈ 22 MiB.
    const dir = tempDir();
    const backslashUrl = "file:///work/" + "\\".repeat(360) + "entry.js";
    expect(JSON.stringify(backslashUrl).length - 2).toBeGreaterThan(
      Buffer.byteLength(backslashUrl, "utf8"),
    );
    const nodeCount = 30001;
    const bigProfile = {
      nodes: Array.from({ length: nodeCount }, (_, i) => ({
        id: i,
        callFrame: { functionName: "f", scriptId: "1", url: backslashUrl,
          lineNumber: 0, columnNumber: 0 },
        hitCount: 1,
      })),
      samples: Array.from({ length: nodeCount - 1 }, (_, i) => i % nodeCount),
      timeDeltas: Array.from({ length: nodeCount - 1 }, () => 10),
      startTime: 0, endTime: nodeCount * 10,
    };
    const spy = vi.spyOn(JSON, "stringify");
    await expect(saveCpuProfile(dir, bigProfile)).rejects.toThrow(/too large|exceeds/i);
    expect(spy.mock.calls.some(args => args[0] === bigProfile)).toBe(false);
  });

  it("positionTicks-oversize: node with 1.2M positionTicks rejected without stringify (Prism r5 witness)", async () => {
    // Prism witness: 2 nodes, leaf with 1,200,000 {line,ticks} entries.
    // 1.2M × 35 bytes (conservative MAX_BYTES_PER_TICK) = 42 MiB > 20 MiB cap.
    // 1200s < 1800s cap. Guard must reject WITHOUT calling JSON.stringify on
    // the positionTicks array itself (that would allocate ~30 MiB on the event loop).
    const dir = tempDir();
    const positionTicks = Array.from({ length: 1_200_000 }, (_, i) => ({ line: i + 1, ticks: 1 }));
    const bigProfile = {
      nodes: [
        {
          id: 1,
          callFrame: { functionName: "hot", scriptId: "1", url: "file:///app.ts", lineNumber: 0, columnNumber: 0 },
          hitCount: 1_200_000,
          positionTicks,
        },
        {
          id: 2,
          callFrame: { functionName: "(root)", scriptId: "0", url: "", lineNumber: 0, columnNumber: 0 },
          hitCount: 0,
        },
      ],
      samples: Array.from({ length: 1_200_000 }, () => 1),
      timeDeltas: Array.from({ length: 1_200_000 }, () => 1000),
      startTime: 0,
      endTime: 1_200_000 * 1000,
    };

    const spy = vi.spyOn(JSON, "stringify");
    await expect(saveCpuProfile(dir, bigProfile)).rejects.toThrow(/too large|exceeds/i);
    // Must not have serialised the whole profile
    expect(spy.mock.calls.some(args => args[0] === bigProfile)).toBe(false);
    // Must not have serialised the positionTicks array itself (that is the allocation we guard against)
    expect(spy.mock.calls.some(args => args[0] === positionTicks)).toBe(false);
  });

  it("small positionTicks: profile with normal positionTicks is accepted (regression)", async () => {
    const dir = tempDir();
    const small = {
      nodes: [{
        id: 1,
        callFrame: { functionName: "f", scriptId: "1", url: "file:///app.ts", lineNumber: 1, columnNumber: 0 },
        hitCount: 5,
        positionTicks: [{ line: 1, ticks: 3 }, { line: 2, ticks: 2 }],
        children: [2],
      }, {
        id: 2,
        callFrame: { functionName: "g", scriptId: "1", url: "file:///app.ts", lineNumber: 10, columnNumber: 0 },
        hitCount: 5,
      }],
      startTime: 0, endTime: 100,
      samples: [1, 2], timeDeltas: [50, 50],
    };
    const path = await saveCpuProfile(dir, small);
    expect(path).toMatch(/\.cpuprofile$/);
  });

  it("small profile with non-ASCII URL: accepted and written (regression)", async () => {
    const dir = tempDir();
    const small = {
      nodes: [{ id: 1, callFrame: { functionName: "f", scriptId: "1",
        url: "file:///\u5de5\u4f5c/app.ts", lineNumber: 0, columnNumber: 0 }, hitCount: 1 }],
      startTime: 0, endTime: 100, samples: [1], timeDeltas: [100],
    };
    const path = await saveCpuProfile(dir, small);
    expect(path).toMatch(/\.cpuprofile$/);
  });
});

// ── (2) CacheService.stop(): sets closing flag, joins in-flight, flushes ──────
//
// Reverse mutation: reverting stop() to set stopped=true before joining
// the in-flight kick makes test "dirty flush" fail because kick() aborts.

function makeMinimalService(dir: string) {
  const stateDir = join(dir, "state");
  const wd = join(dir, "wd");
  const projects = join(dir, "projects");
  const sessions = join(dir, "sessions");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(wd, { recursive: true });
  mkdirSync(projects, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  const ledgerPath = join(stateDir, "dev.json");
  const inst = { name: "dev", backend: "claude-code", workingDirectory: wd, ledgerPath };
  const svc = new CacheService({
    instances: () => [inst],
    claudeProjectsDir: () => projects,
    claudeKey: (x: string) => x.replace(/[^a-zA-Z0-9]/g, "-"),
    codexSessionsDir: () => sessions,
    listRollouts: () => [],
    metaPath: join(dir, "meta.json"),
    intervalMs: 60_000,
  });
  return { svc, ledgerPath, inst };
}

describe("CacheService.stop(): closing flag + flush (#1490 P3)", () => {
  it("stop() returns a Promise (not void)", async () => {
    const dir = tempDir();
    const { svc } = makeMinimalService(dir);
    const p = svc.stop();
    expect(p).toBeInstanceOf(Promise);
    await p;
    expect(svc.scanning().active).toBe(false);
  });

  it("stop() with no dirty data completes without error (positive control)", async () => {
    const dir = tempDir();
    const { svc } = makeMinimalService(dir);
    await expect(svc.stop()).resolves.toBeUndefined();
  });

  it("stop() flushes dirty data that is pending when called: ledger is written", async () => {
    const dir = tempDir();
    const { svc, ledgerPath } = makeMinimalService(dir);
    (svc as any).dirty.add("dev");
    (svc as any).ledgers.set("dev", emptyLedger());
    await svc.stop();
    expect(existsSync(ledgerPath)).toBe(true);
  });

  it("stop() sets closing=true so kick() refuses new work after stop starts", async () => {
    const dir = tempDir();
    const { svc } = makeMinimalService(dir);

    const stopPromise = svc.stop();
    // kick() should now be a no-op (closing=true)
    const kickAfterStop = svc.kick();
    expect(svc.scanning().active).toBe(false);

    await stopPromise;
    await kickAfterStop;
  });
});
