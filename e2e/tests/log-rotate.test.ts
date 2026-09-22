/**
 * E2E Test: daemon.log size management.
 *
 * This file used to import `truncateLogIfNeeded` and assert that an oversized
 * log was tail-preserved in place with no backup files. That function no longer
 * exists — it became `rotateLogIfNeeded`, whose contract is the opposite: the
 * live file is emptied and its content moves to `.1`, because the writer holds
 * an open fd and has to keep appending to the same inode.
 *
 * Nothing caught the drift: `npm test` excludes `e2e/**`, and `typecheck:tests`
 * was red for other reasons, so an import of a deleted export sat here. The
 * assertions below describe what the code does now, at sizes small enough to
 * run in milliseconds rather than by writing 12MB.
 */
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync, statSync, readFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { rotateLogIfNeeded } from "../../src/logger.js";

const testDir = `/tmp/ae2e-logrotate-${Date.now().toString(36)}`;
const MAX = 1024; // stand-in for the 10MB production threshold

const write = (name: string, bytes: number, fill = "A") => {
  const path = join(testDir, name);
  writeFileSync(path, Buffer.alloc(bytes, fill));
  return path;
};

describe("log rotation", () => {
  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });
  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  it("leaves a file under the threshold alone", () => {
    const path = write("small.log", MAX - 1);
    rotateLogIfNeeded(path, MAX);
    expect(statSync(path).size).toBe(MAX - 1);
    expect(readdirSync(testDir)).toEqual(["small.log"]);
  });

  it("empties the live file and keeps its content in .1", () => {
    // The live file is truncated rather than renamed: the process writing to it
    // has the inode open, and a rename would leave it appending to a file
    // nothing reads.
    const path = write("big.log", MAX * 2, "B");
    rotateLogIfNeeded(path, MAX);

    expect(statSync(path).size).toBe(0);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(statSync(`${path}.1`).size).toBe(MAX * 2);
    expect(readFileSync(`${path}.1`, "utf-8")).toBe("B".repeat(MAX * 2));
  });

  it("shifts an existing .1 down to .2 rather than overwriting it", () => {
    const path = join(testDir, "shift.log");
    writeFileSync(path, "older".padEnd(MAX * 2, "x"));
    rotateLogIfNeeded(path, MAX);
    writeFileSync(path, "newer".padEnd(MAX * 2, "y"));
    rotateLogIfNeeded(path, MAX);

    expect(readFileSync(`${path}.1`, "utf-8").startsWith("newer")).toBe(true);
    expect(readFileSync(`${path}.2`, "utf-8").startsWith("older")).toBe(true);
  });

  it("drops a ballooned log in place instead of copying it", () => {
    // Past 10x the limit, copying is the wrong trade — a never-rotated TUI
    // animation flood can reach hundreds of MB, and the point is to reclaim the
    // space now. Existing rotations go too.
    const path = join(testDir, "huge.log");
    writeFileSync(`${path}.1`, "previous rotation");
    writeFileSync(path, Buffer.alloc(MAX * 11, "C"));
    rotateLogIfNeeded(path, MAX);

    expect(statSync(path).size).toBe(0);
    expect(existsSync(`${path}.1`), "a ballooned log should not be copied to .1").toBe(false);
  });

  it("says nothing about a file that is not there", () => {
    expect(() => rotateLogIfNeeded(join(testDir, "absent.log"), MAX)).not.toThrow();
  });
});
