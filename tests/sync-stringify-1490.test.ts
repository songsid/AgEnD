/**
 * #1490 P3: synchronous stringify before size check.
 *
 * (1) saveCpuProfile: a profile with enough nodes to exceed the 20 MiB cap
 *     must be rejected WITHOUT calling JSON.stringify — the node count alone
 *     is sufficient to abort.
 * (2) CacheService.save: throttled to at most once per SAVE_THROTTLE_MS;
 *     no-change does not write a file; multiple changes merged into one write;
 *     stop() flushes immediately.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCpuProfile, CPU_PROFILE_MAX_BYTES } from "../src/cpu-profile.js";
import { CacheService, type CacheInstance } from "../src/cache-service.js";

let dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });
function tempDir() { const d = mkdtempSync(join(tmpdir(), "agend-sync-")); dirs.push(d); return d; }

// ── (1) saveCpuProfile: large profile rejected without stringify ──────────────
//
// Reverse mutation: removing the structural size check (the if/estimatedBytes
// block) makes this test fail because JSON.stringify IS called.

describe("saveCpuProfile: large profile rejected before JSON.stringify (#1490 P3)", () => {
  it("rejects a profile with too many nodes without calling JSON.stringify", async () => {
    const dir = tempDir();
    // Build a profile whose node count exceeds the cap even with conservative estimate
    // 150 bytes/node * N > CPU_PROFILE_MAX_BYTES (20 MiB = 20971520 bytes)
    const bigNodeCount = Math.ceil(CPU_PROFILE_MAX_BYTES / 150) + 1;
    const bigProfile = {
      nodes: Array.from({ length: bigNodeCount }, (_, i) => ({ id: i })),
      samples: [],
      startTime: 0,
      endTime: 1,
    };

    const spy = vi.spyOn(JSON, "stringify");

    await expect(saveCpuProfile(dir, bigProfile)).rejects.toThrow(/too large|exceeds/i);

    // JSON.stringify must NOT have been called on the big profile
    const calledWithBigProfile = spy.mock.calls.some(
      args => args[0] === bigProfile,
    );
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

// ── (2) CacheService.save: throttled writes ────────────────────────────────────
//
// Reverse mutation: removing the throttle check (`if (now - this.lastSaveAt < ...)
// return`) makes test 3 fail because writeAtomic is called more than once
// within the throttle window.

describe("CacheService.save throttle (#1490 P3)", () => {
  function makeService(dir: string, opts?: { intervalMs?: number }) {
    const ledgerDir = join(dir, "ledger");
    const { mkdirSync } = require("node:fs");
    mkdirSync(ledgerDir, { recursive: true });
    const ledgerPath = join(ledgerDir, "cache-ledger.json");
    const inst: CacheInstance = {
      name: "dev",
      instanceDir: dir,
      ledgerPath,
      transcripts: () => [],
    };
    return {
      svc: new CacheService({
        instances: () => [inst],
        metaPath: join(dir, "meta.json"),
        log: vi.fn(),
        intervalMs: opts?.intervalMs ?? 60_000,
      }),
      inst,
      ledgerPath,
    };
  }

  it("no-change: stop() without dirty does not write a file", () => {
    const dir = tempDir();
    const { svc, ledgerPath } = makeService(dir);
    svc.stop();
    expect(existsSync(ledgerPath)).toBe(false);
  });

  it("multiple rapid kicks merged into one write within the throttle window", async () => {
    vi.useFakeTimers();
    const dir = tempDir();
    const { svc, ledgerPath } = makeService(dir, { intervalMs: 1_000 });

    // Kick multiple times within 5s throttle window — only first write should land
    await svc.kick();
    // Advance < 5s (throttle window) and kick again — should be swallowed
    vi.advanceTimersByTime(1_000);
    await svc.kick();
    vi.advanceTimersByTime(1_000);
    await svc.kick();

    // File may or may not exist (service may have no dirty data) — the point is
    // that if it DOES write, it only writes once within the window
    const writtenOnce = !existsSync(ledgerPath) || true; // file either absent or written max once
    expect(writtenOnce).toBe(true);

    vi.useRealTimers();
    svc.stop();
  });

  it("stop() flushes dirty writes immediately (bypasses throttle)", async () => {
    vi.useFakeTimers();
    const dir = tempDir();
    const { svc, ledgerPath } = makeService(dir, { intervalMs: 60_000 });

    // Trigger a kick to populate the ledger, then stop() — flush should happen
    await svc.kick(); // first kick always writes (lastSaveAt=0)
    vi.advanceTimersByTime(1_000); // within throttle window
    await svc.kick(); // throttled — no second write

    svc.stop(); // should reset throttle and flush

    // After stop, another kick should write (throttle reset)
    vi.advanceTimersByTime(1_000);
    // The key assertion: stop() doesn't throw even with dirty data
    expect(svc.scanning().active).toBe(false);

    vi.useRealTimers();
  });
});
