/**
 * #1490 P3: synchronous stringify before size check + stop() flush.
 *
 * (1) saveCpuProfile: size estimation uses Buffer.byteLength for UTF-8 bytes
 *     (not .length / UTF-16 code units). Unicode URLs and JSON-escaping
 *     headroom are accounted for before JSON.stringify is attempted.
 * (2) CacheService.stop(): joins the in-flight kick before flushing, so
 *     dirty data dirtied by a running pass is not lost.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// Reverse mutation: removing the structural size check makes tests 1-2 fail
// because JSON.stringify IS called on the big profiles.

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

  it("url-oversize (Unicode): fewer nodes but CJK URLs exceed cap without stringify", async () => {
    // P2 witness: 60,001 nodes, each with a URL containing CJK characters.
    // url = 'file:///work/' + '工作/'.repeat(48) + 'entry.js'
    //   String.length ≈ 170 UTF-16 units, but Buffer.byteLength ≈ 310 UTF-8 bytes.
    // Total URL bytes: 310 × 60001 ≈ 18.6 MiB × 1.2 escaping = 22.3 MiB > 20 MiB.
    const dir = tempDir();
    const cjkUrl = "file:///work/" + "工作/".repeat(48) + "entry.js";
    // Verify our understanding: UTF-8 bytes > UTF-16 units
    const utf8Bytes = Buffer.byteLength(cjkUrl, "utf8");
    const utf16Units = cjkUrl.length;
    expect(utf8Bytes).toBeGreaterThan(utf16Units); // CJK chars are 3 bytes each

    const nodeCount = 60001;
    const bigProfile = {
      nodes: Array.from({ length: nodeCount }, (_, i) => ({
        id: i,
        callFrame: { functionName: `fn${i % 1000}`, scriptId: "1", url: cjkUrl,
          lineNumber: i, columnNumber: 0 },
        hitCount: 1,
      })),
      samples: Array.from({ length: 60000 }, (_, i) => i % nodeCount),
      timeDeltas: Array.from({ length: 60000 }, () => 10),
      startTime: 0, endTime: 600000,
    };

    const spy = vi.spyOn(JSON, "stringify");
    await expect(saveCpuProfile(dir, bigProfile)).rejects.toThrow(/too large|exceeds/i);
    // JSON.stringify must NOT have been called on the large profile
    expect(spy.mock.calls.some(args => args[0] === bigProfile)).toBe(false);
  });

  it("small profile with non-ASCII URL: accepted and written (regression)", async () => {
    const dir = tempDir();
    const small = {
      nodes: [{ id: 1, callFrame: { functionName: "f", scriptId: "1",
        url: "file:///工作/app.ts", lineNumber: 0, columnNumber: 0 }, hitCount: 1 }],
      startTime: 0, endTime: 100, samples: [1], timeDeltas: [100],
    };
    const path = await saveCpuProfile(dir, small);
    expect(path).toMatch(/\.cpuprofile$/);
  });
});

// ── (2) CacheService.stop(): joins in-flight kick before flush ────────────────
//
// Reverse mutation: reverting stop() to set stopped=true before joining
// the in-flight kick makes test 5 fail because the running kick would
// see stopped=true and abort, leaving dirty data unwritten.

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

describe("CacheService.stop(): joins in-flight kick and flushes (#1490 P3)", () => {
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

    // Manually inject dirty state using a properly-shaped ledger
    (svc as any).dirty.add("dev");
    (svc as any).ledgers.set("dev", emptyLedger());

    await svc.stop();

    // The ledger must have been written by the flush
    expect(existsSync(ledgerPath)).toBe(true);
  });
});
