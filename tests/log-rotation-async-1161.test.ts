import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync, promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateLogIfNeeded, rotateLogIfNeededAsync } from "../src/logger.js";

/**
 * #1161 (D1): the same copytruncate rotation, off the event loop. The sync version's
 * semantics stay pinned in logger.test.ts; these pin what the async one adds or must keep.
 */
let dir: string;
let log: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-rotate-async-")); log = join(dir, "output.log"); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

describe("rotateLogIfNeededAsync: same result as the sync rotation", () => {
  it("copies to .1, truncates the live file in place (same inode), shifts .1 → .2 → .3 and drops the oldest", async () => {
    writeFileSync(log, "x".repeat(100));
    writeFileSync(`${log}.1`, "one"); writeFileSync(`${log}.2`, "two"); writeFileSync(`${log}.3`, "three");
    const inode = statSync(log).ino;
    await rotateLogIfNeededAsync(log, 50, 3);
    expect(statSync(log).size).toBe(0);
    expect(statSync(log).ino).toBe(inode);                       // a writer holding the fd keeps writing here
    expect(readFileSync(`${log}.1`, "utf8")).toBe("x".repeat(100));
    expect(readFileSync(`${log}.2`, "utf8")).toBe("one");
    expect(readFileSync(`${log}.3`, "utf8")).toBe("two");        // "three" is gone
  });

  it("agrees with the sync version byte for byte", async () => {
    const other = join(dir, "other.log");
    for (const file of [log, other]) { writeFileSync(file, "y".repeat(80)); writeFileSync(`${file}.1`, "old"); }
    rotateLogIfNeeded(other, 50, 3);
    await rotateLogIfNeededAsync(log, 50, 3);
    for (const suffix of ["", ".1", ".2", ".3"]) {
      const a = existsSync(`${log}${suffix}`) ? readFileSync(`${log}${suffix}`, "utf8") : null;
      const b = existsSync(`${other}${suffix}`) ? readFileSync(`${other}${suffix}`, "utf8") : null;
      expect(a, suffix || "live").toEqual(b);
    }
  });

  it("the oldest rotated file is dropped even when the one that would replace it is missing (same as sync)", async () => {
    const other = join(dir, "other.log");
    for (const file of [log, other]) { writeFileSync(file, "z".repeat(80)); writeFileSync(`${file}.3`, "oldest"); }
    rotateLogIfNeeded(other, 50, 3);
    await rotateLogIfNeededAsync(log, 50, 3);
    expect(existsSync(`${other}.3`)).toBe(false);                 // the reference behaviour
    expect(existsSync(`${log}.3`)).toBe(false);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("z".repeat(80));
  });

  it("with nothing appended during the copy the live file is not even re-read", async () => {
    writeFileSync(log, "A".repeat(100));
    const open = vi.spyOn(fsp, "open");
    await rotateLogIfNeededAsync(log, 50, 3);
    expect(open).not.toHaveBeenCalled();
  });

  it("a ballooned log is dropped in place without a copy, rotated files removed", async () => {
    writeFileSync(log, "y".repeat(120));
    writeFileSync(`${log}.1`, "old");
    const copy = vi.spyOn(fsp, "copyFile");
    await rotateLogIfNeededAsync(log, 10, 3);
    expect(copy).not.toHaveBeenCalled();
    expect(statSync(log).size).toBe(0);
    expect(existsSync(`${log}.1`)).toBe(false);
  });

  it("under the limit, or no file at all: nothing happens", async () => {
    const copy = vi.spyOn(fsp, "copyFile");
    await rotateLogIfNeededAsync(log, 1000, 3);                   // missing
    writeFileSync(log, "tiny");
    await rotateLogIfNeededAsync(log, 1000, 3);
    expect(copy).not.toHaveBeenCalled();
    expect(readFileSync(log, "utf8")).toBe("tiny");
    expect(existsSync(`${log}.1`)).toBe(false);
  });
});

describe("rotateLogIfNeededAsync: the writer keeps appending while the copy runs", () => {
  it("what was appended during the copy is carried into .1 before the truncate — nothing lost", async () => {
    writeFileSync(log, "A".repeat(100));
    const realCopy = fsp.copyFile.bind(fsp);
    vi.spyOn(fsp, "copyFile").mockImplementation(async (src, dst, mode) => {
      await realCopy(src, dst, mode);
      appendFileSync(log, "LATE-1");                              // the pipe-pane `cat >>` / pino fd, mid-rotation
      appendFileSync(log, "LATE-2");
    });
    await rotateLogIfNeededAsync(log, 50, 3);
    expect(readFileSync(`${log}.1`, "utf8")).toBe(`${"A".repeat(100)}LATE-1LATE-2`);
    expect(statSync(log).size).toBe(0);
  });

  it("a writer that keeps up through several passes is still followed (bounded), and the live file ends empty", async () => {
    writeFileSync(log, "A".repeat(100));
    const realCopy = fsp.copyFile.bind(fsp);
    let appended = 0;
    vi.spyOn(fsp, "copyFile").mockImplementation(async (src, dst, mode) => {
      await realCopy(src, dst, mode);
      appendFileSync(log, "1"); appended++;
    });
    const realOpen = fsp.open.bind(fsp);
    vi.spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      if (appended < 3) { appendFileSync(log, "N"); appended++; }   // more arrives before each re-read
      return realOpen(...args);
    }) as never);
    await rotateLogIfNeededAsync(log, 50, 3);
    expect(readFileSync(`${log}.1`, "utf8").startsWith("A".repeat(100))).toBe(true);
    expect(readFileSync(`${log}.1`, "utf8").length).toBeGreaterThan(101);
    expect(statSync(log).size).toBe(0);
  });

  it("the live file is only truncated AFTER the copy is complete", async () => {
    writeFileSync(log, "A".repeat(100));
    const order: string[] = [];
    const realCopy = fsp.copyFile.bind(fsp);
    const realTruncate = fsp.truncate.bind(fsp);
    vi.spyOn(fsp, "copyFile").mockImplementation(async (src, dst, mode) => { await realCopy(src, dst, mode); order.push("copied"); });
    vi.spyOn(fsp, "truncate").mockImplementation(async (path, len) => { order.push("truncated"); return realTruncate(path, len); });
    await rotateLogIfNeededAsync(log, 50, 3);
    expect(order).toEqual(["copied", "truncated"]);
  });
});

describe("rotateLogIfNeededAsync: one rotation per file", () => {
  function gatedCopy() {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const realCopy = fsp.copyFile.bind(fsp);
    const copy = vi.spyOn(fsp, "copyFile").mockImplementation(async (src, dst, mode) => { await gate; await realCopy(src, dst, mode); });
    return { release, copy };
  }

  it("a second request while one runs joins it: one copy, both resolve after the rotation is DONE", async () => {
    writeFileSync(log, "A".repeat(100));
    const { release, copy } = gatedCopy();
    const first = rotateLogIfNeededAsync(log, 50, 3);
    const second = rotateLogIfNeededAsync(log, 50, 3);
    expect(second).toBe(first);                                   // the very same promise: spawn/wake awaiting it see a rotated file
    let settled = false; void second.then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false);                                  // not "done" while the copy is parked
    release();
    await Promise.all([first, second]);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(statSync(log).size).toBe(0);
  });

  it("the sync rotation stands aside while an async one is in flight (no double shift)", async () => {
    writeFileSync(log, "A".repeat(100));
    const { release } = gatedCopy();
    const running = rotateLogIfNeededAsync(log, 50, 3);
    rotateLogIfNeeded(log, 50, 3);                                // e.g. the daily sweep
    expect(statSync(log).size).toBe(100);                          // untouched by the sync call
    expect(existsSync(`${log}.1`)).toBe(false);
    release();
    await running;
    expect(readFileSync(`${log}.1`, "utf8")).toBe("A".repeat(100));
  });

  it("different files rotate independently", async () => {
    const other = join(dir, "other.log");
    writeFileSync(log, "A".repeat(100)); writeFileSync(other, "B".repeat(100));
    await Promise.all([rotateLogIfNeededAsync(log, 50, 3), rotateLogIfNeededAsync(other, 50, 3)]);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("A".repeat(100));
    expect(readFileSync(`${other}.1`, "utf8")).toBe("B".repeat(100));
  });

  it("once finished the file can rotate again", async () => {
    writeFileSync(log, "A".repeat(100));
    await rotateLogIfNeededAsync(log, 50, 3);
    writeFileSync(log, "C".repeat(100));
    await rotateLogIfNeededAsync(log, 50, 3);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("C".repeat(100));
    expect(readFileSync(`${log}.2`, "utf8")).toBe("A".repeat(100));
  });
});

describe("rotateLogIfNeededAsync: never throws, never wedges", () => {
  it("a failing copy resolves quietly, leaves the log untouched, and the next call can retry", async () => {
    writeFileSync(log, "A".repeat(100));
    const copy = vi.spyOn(fsp, "copyFile").mockRejectedValueOnce(Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }));
    await expect(rotateLogIfNeededAsync(log, 50, 3)).resolves.toBeUndefined();
    expect(statSync(log).size).toBe(100);                          // nothing truncated without a copy
    await rotateLogIfNeededAsync(log, 50, 3);                      // the in-flight entry was cleared
    expect(copy).toHaveBeenCalledTimes(2);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("A".repeat(100));
    expect(statSync(log).size).toBe(0);
  });

  it("the size check is synchronous: nothing is scheduled when no rotation is due", () => {
    writeFileSync(log, "tiny");
    const open = vi.spyOn(fsp, "stat");
    void rotateLogIfNeededAsync(log, 1000, 3);
    expect(open).not.toHaveBeenCalled();                           // no async fs work at all on the common path
  });
});
