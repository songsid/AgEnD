/**
 * Atomic file write with fsync.
 *
 * Sequence: open(temp, wx) → write → fsync(fd) → close → rename → fsync(dir).
 *
 * The directory fsync is best-effort: a failure there is logged but does NOT
 * undo the rename (the data is safe on disk after the file fsync + rename).
 *
 * This is the shared helper for fleet.yaml, web-sessions.json, and
 * update-marker.json (#1490 P3 — those three files used write+rename without
 * fsync before this module).
 */
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export interface AtomicWriteOpts {
  /**
   * File permission bits for the temp file (and therefore the final file after
   * rename). Default: 0o644.
   */
  mode?: number;
  /** Injected fsync for testing. Default: `fsyncSync` from node:fs. */
  fsync?: (fd: number) => void;
}

/**
 * Write `data` to `path` atomically with fsync:
 * open(temp) → write → fsync(fd) → close → rename → fsync(dir, best-effort).
 */
export function atomicWriteFileSync(
  path: string,
  data: string,
  opts: AtomicWriteOpts = {},
): void {
  const mode = opts.mode ?? 0o644;
  const fsync = opts.fsync ?? fsyncSync;
  const dir = dirname(path);
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;

  mkdirSync(dir, { recursive: true });

  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", mode);
    writeSync(fd, data, undefined, "utf8");
    fsync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw err;
  }

  // Dir fsync: best-effort. A failure here means the directory entry may not
  // be durable, but the file data and the rename are already on disk.
  const dirFd = openSync(dir, "r");
  try { fsync(dirFd); } catch { /* best effort — do not undo rename */ } finally { closeSync(dirFd); }
}
