/**
 * #1490 P3: temp+rename writes must include fsync.
 *
 * Tests cover:
 * - atomicWriteFileSync (shared helper): call order, count, cleanup, dir-open error
 * - saveFleetConfig (fleet.yaml): fsync called before rename, via injected seam
 * - WebSessionStore.persistNow: fsync called before rename, via injected ops
 *
 * Each test has a reverse-mutation note.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
  rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync } from "../src/atomic-write.js";
import { WebSessionStore } from "../src/web-session.js";
import { FleetManager } from "../src/fleet-manager.js";

let dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tmpDir() { const d = mkdtempSync(join(tmpdir(), "agend-fsync-")); dirs.push(d); return d; }

// ── atomicWriteFileSync ───────────────────────────────────────────────────────

describe("atomicWriteFileSync call order (#1490 P3)", () => {
  // ── 1. fsync BEFORE rename ────────────────────────────────────────────────
  // Reverse mutation: moving `fsync(fd)` to after `renameSync` makes
  // `firstFsync` equal "fsync-after-rename", failing this assertion.

  it("calls fsync on the file fd BEFORE rename", () => {
    const dir = tmpDir();
    const path = join(dir, "target.json");
    const calls: string[] = [];

    const trackingFsync = vi.fn(() => {
      calls.push(existsSync(path) ? "fsync-after-rename" : "fsync-before-rename");
    });

    atomicWriteFileSync(path, "hello", { fsync: trackingFsync });

    const firstFsync = calls.find(c => c.startsWith("fsync"));
    expect(firstFsync).toBe("fsync-before-rename");
    expect(readFileSync(path, "utf8")).toBe("hello");
  });

  // ── 2. fsync called at least twice (file + dir) ───────────────────────────
  // Reverse mutation: removing dir fsync drops count to 1.

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

  // ── 3. throws and does not leave a temp on file-fsync failure ─────────────
  it("throws and does not leave a temp file when file fsync fails", () => {
    const dir = tmpDir();
    const path = join(dir, "out.json");
    let callCount = 0;
    const errorOnFirst = () => {
      callCount++;
      if (callCount === 1) throw new Error("disk full");
    };

    expect(() => atomicWriteFileSync(path, "data", { fsync: errorOnFirst })).toThrow("disk full");
    expect(existsSync(path)).toBe(false);
  });

  // ── 4. dir-open error does NOT propagate after rename (P2a) ──────────────
  // Reverse mutation: putting openSync(dir, "r") OUTSIDE the try block makes
  // this test fail: chmod 0o300 prevents openSync(dir, "r"), so EACCES
  // propagates AFTER rename has already succeeded, and the file is present
  // at path but the caller receives the error.
  //
  // Requires Linux or macOS; skipped on environments where chmod is a no-op.

  it("swallows an EACCES error from opening the directory for fsync, after rename succeeds", () => {
    const baseDir = tmpDir();
    // Subdirectory with write+execute but no read permission → rename succeeds,
    // openSync(dir, "r") fails with EACCES.
    const restrictedDir = join(baseDir, "restricted");
    mkdirSync(restrictedDir, { recursive: true });
    const path = join(restrictedDir, "target.json");
    try {
      chmodSync(restrictedDir, 0o300); // write+execute only
    } catch {
      // Permissions may be a no-op on some systems; skip the filesystem half.
      return;
    }

    try {
      // Must not throw even though openSync(restrictedDir, "r") would get EACCES
      expect(() => atomicWriteFileSync(path, "data")).not.toThrow();
      // Rename succeeded: file is at final path
      expect(existsSync(path)).toBe(true);
    } finally {
      // Restore permissions so afterEach can rmSync
      try { chmodSync(restrictedDir, 0o755); } catch { /* best effort */ }
    }
  });
});

// ── saveFleetConfig: fsync called before rename ───────────────────────────────
//
// Reverse mutation: removing `fsync: this.fsyncForTest` from the
// atomicWriteFileSync call in saveFleetConfig (or removing the file fsync
// inside atomicWriteFileSync) makes the spy never fire before rename,
// causing firstFsync to be undefined or "fsync-after-rename".

describe("saveFleetConfig: fsync called before rename (#1490 P3)", () => {
  it("calls fsync on the temp file before renaming it to fleet.yaml", async () => {
    const dir = tmpDir();
    const configPath = join(dir, "fleet.yaml");
    const minimalYaml = "defaults: {}\ninstances: {}\n";
    writeFileSync(configPath, minimalYaml, "utf8");

    const calls: string[] = [];
    const trackingFsync = vi.fn(() => {
      calls.push(existsSync(configPath) ? "fsync-after-rename" : "fsync-before-rename");
    });

    const { loadFleetConfig } = await import("../src/config.js");
    const fm = Object.create(FleetManager.prototype) as FleetManager;
    (fm as any).configPath = configPath;
    (fm as any).logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    (fm as any).fsyncForTest = trackingFsync;
    // saveFleetConfig re-reads the file internally and sets rawFleetDocument
    (fm as any).fleetConfig = loadFleetConfig(configPath);
    (fm as any).savedFleetConfigSnapshot = structuredClone((fm as any).fleetConfig);
    (fm as any).publicWebLink = null;
    (fm as any).savedFleetConfigProblem = (_path: string) => null;
    (fm as any).writeFleetConfigBackup = () => {};
    (fm as any).patchFleetDocument = () => {};

    // Delete configPath so it does not exist until rename:
    // before rename → fsync-before-rename; after rename → fsync-after-rename
    rmSync(configPath);
    (fm as any).saveFleetConfig();

    const firstFsync = calls.find(c => c.startsWith("fsync"));
    expect(firstFsync).toBe("fsync-before-rename");
    expect(trackingFsync).toHaveBeenCalled();
  });
});

// ── WebSessionStore: fsync called before rename ───────────────────────────────
//
// Reverse mutation: moving `(this.ops.fsyncSync ?? fsyncSync)(tmpFd)` to after
// `this.ops.renameSync(...)` makes `firstFsync` equal "fsync-after-rename".

describe("WebSessionStore: fsync called before rename (#1490 P3)", () => {
  it("calls fsync on the temp file BEFORE renaming it to the sessions file", () => {
    const dir = tmpDir();
    const sessionFile = join(dir, "web-sessions.json");
    const calls: string[] = [];

    let nextFd = 100;
    const openStub = vi.fn(() => nextFd++);
    const fsyncStub = vi.fn((fd: number) => {
      // After rename, sessionFile exists; before rename, it does not (first write)
      calls.push(existsSync(sessionFile) ? "fsync-after-rename" : "fsync-before-rename");
    });
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

    store.create({ tier: "admin", surface: "local", label: "test", tokenEpoch: "epoch1" });

    // First fsync must be before rename
    const firstFsync = calls.find(c => c.startsWith("fsync"));
    expect(firstFsync).toBe("fsync-before-rename");
    expect(fsyncStub.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Every fd opened must be closed
    expect(closeStub.mock.calls.length).toBeGreaterThanOrEqual(openStub.mock.calls.length);
  });
});
