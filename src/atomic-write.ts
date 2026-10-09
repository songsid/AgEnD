/**
 * Atomic file write with fsync.
 *
 * Sequence: open(temp, wx) → write → fsync(fd) → close → [beforeRename(temp)]
 *           → rename → fsync(dir, best-effort).
 *
 * The directory fsync is best-effort: a failure there is silently ignored
 * because rename has already committed the data.
 *
 * Used by src/update-marker.ts directly. src/fleet-manager.ts saveFleetConfig
 * and src/web-session.ts persistNow use the same sequence inline (fleet.yaml
 * needs a pre-rename validation step; web-session uses injectable fs ops).
 */
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
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
  /**
   * Optional hook called with the temp-file path after fsync and close,
   * immediately before rename. Throw to abort the write (the temp file will
   * be cleaned up).
   */
  beforeRename?: (tempPath: string) => void;
}

/**
 * Write `data` to `path` atomically with fsync:
 * open(temp) → write → fsync(fd) → close → [beforeRename(temp)] → rename
 * → fsync(dir, best-effort).
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

  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", mode);
    writeSync(fd, data, undefined, "utf8");
    fsync(fd);
    closeSync(fd);
    fd = undefined;
    opts.beforeRename?.(temp);
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
  // openSync is inside the try so an EACCES on the directory does not
  // propagate after rename has already succeeded.
  let dirFd: number | undefined;
  try {
    dirFd = openSync(dir, "r");
    fsync(dirFd);
  } catch { /* best effort — do not undo rename */ } finally {
    if (dirFd !== undefined) closeSync(dirFd);
  }
}
