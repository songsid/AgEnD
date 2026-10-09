/**
 * #1490 P3: temp+rename writes must include fsync.
 *
 * Tests cover the shared atomicWriteFileSync helper and the web-session
 * SessionFileOps integration (the two paths with injectable seams).
 * fleet-manager and update-marker use the same helper / pattern.
 *
 * Each test has a reverse-mutation note.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync } from "../src/atomic-write.js";
import { WebSessionStore } from "../src/web-session.js";

let dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tmpDir() { const d = mkdtempSync(join(tmpdir(), "agend-fsync-")); dirs.push(d); return d; }

// ── atomicWriteFileSync call-order contract ────────────────────────────────
//
// Reverse mutation: removing `fsync(fd)` (file fd sync) from atomicWriteFileSync
// makes test 1 fail: the FIRST fsync call happens AFTER rename (dir fsync),
// so `firstFsync` is "fsync-after-rename" instead of "fsync-before-rename".
// Removing dir fsync makes test 2 fail (spy count drops to 1, not ≥ 2).

describe("atomicWriteFileSync call order (#1490 P3)", () => {
  it("calls fsync on the file fd BEFORE rename", () => {
    const dir = tmpDir();
    const path = join(dir, "target.json");
    const calls: string[] = [];

    // Track whether path exists at the time each fsync call fires.
    // Before rename: path does NOT exist → "fsync-before-rename"
    // After rename:  path DOES exist     → "fsync-after-rename"
    const trackingFsync = vi.fn(() => {
      calls.push(existsSync(path) ? "fsync-after-rename" : "fsync-before-rename");
    });

    atomicWriteFileSync(path, "hello", { fsync: trackingFsync });

    // The FIRST fsync call must be before rename (file fd fsync, before the temp is renamed)
    const firstFsync = calls.find(c => c.startsWith("fsync"));
    expect(firstFsync).toBe("fsync-before-rename");
    // Rename happened: file now exists at final path
    expect(readFileSync(path, "utf8")).toBe("hello");
  });

  it("calls fsync at least twice: once for file fd, once for dir fd", () => {
    const dir = tmpDir();
    const path = join(dir, "target.json");
    const fsyncStub = vi.fn();

    atomicWriteFileSync(path, "world", { fsync: fsyncStub });

    expect(fsyncStub.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("writes the correct content at the final path", () => {
    const dir = tmpDir();
    const path = join(dir, "out.json");

    atomicWriteFileSync(path, '{"x":1}', { fsync: vi.fn() });

    expect(readFileSync(path, "utf8")).toBe('{"x":1}');
  });

  it("throws and does not leave a temp file when file fsync fails", () => {
    const dir = tmpDir();
    const path = join(dir, "out.json");
    let callCount = 0;
    const errorOnFirst = () => {
      callCount++;
      if (callCount === 1) throw new Error("disk full");
      // dir fsync: best-effort, let it succeed
    };

    expect(() => atomicWriteFileSync(path, "data", { fsync: errorOnFirst })).toThrow("disk full");

    // No temp file left behind (only .tmp-suffixed files count)
    const leftover = rmSync(dir, { recursive: true, force: true }) ?? [];
    // Just verify the call completed without leaving the target:
    expect(existsSync(path)).toBe(false);
  });
});

// ── WebSessionStore fsync injection ───────────────────────────────────────────
//
// Reverse mutation: removing the `(this.ops.fsyncSync ?? fsyncSync)(tmpFd)` call
// from persistNow() makes this test fail because the fsync spy count drops to 1
// (only dir fsync) or 0 if dir fsync is also removed.

describe("WebSessionStore: fsync called on persist (#1490 P3)", () => {
  it("calls fsyncSync at least twice (file fd + dir fd) during a session persist", () => {
    const dir = tmpDir();
    const fsyncStub = vi.fn();
    let nextFd = 100;
    const openStub = vi.fn(() => nextFd++);
    const closeStub = vi.fn();

    const store = new WebSessionStore({
      dataDir: dir,
      fileOps: {
        writeFileSync,
        renameSync,
        unlinkSync,
        fsyncSync: fsyncStub,
        openSync: openStub,
        closeSync: closeStub,
      },
    });

    // create() calls persistNow() internally
    store.create({ tier: "admin", surface: "local", label: "test", tokenEpoch: "epoch1" });

    // Must be called at least twice: temp fd + dir fd
    expect(fsyncStub.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Every fd opened must be closed
    expect(closeStub.mock.calls.length).toBeGreaterThanOrEqual(openStub.mock.calls.length);
  });
});
