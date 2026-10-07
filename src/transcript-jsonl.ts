import { open, stat } from "node:fs/promises";

/**
 * Tail only newline-terminated JSONL records. A CLI can flush one record in
 * several writes; the unfinished suffix must remain before the next offset.
 */
export async function readNewLines(path: string, fromOffset: number): Promise<{ lines: string[]; newOffset: number }> {
  const stats = await stat(path);
  if (stats.size <= fromOffset) return { lines: [], newOffset: fromOffset };
  const fh = await open(path, "r");
  try {
    const length = stats.size - fromOffset;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buffer, 0, length, fromOffset);
    // Find LF in the bytes actually read, before decoding (UTF-8 characters
    // may themselves span writes). stat.size is not a consumed-byte boundary.
    const completeLength = buffer.subarray(0, bytesRead).lastIndexOf(0x0a) + 1;
    return {
      lines: buffer.toString("utf-8", 0, completeLength).split("\n").filter(line => line.trim()),
      newOffset: fromOffset + completeLength,
    };
  } finally {
    await fh.close();
  }
}

const BOUNDARY_CHUNK = 64 * 1024;

/**
 * Where the last complete record at or before `size` ends: just after the last LF, or 0 when there is none
 * (#1250). A baseline or checkpoint taken while the CLI is mid-write must not land inside that record — the
 * next read would start with its tail, skip it as malformed, and the record would be lost. Anchoring at the
 * line boundary keeps the invariant readNewLines holds (an offset is always a record boundary), so the
 * in-progress record is read once it is complete. Scans backwards from `size` (default: the current size).
 *
 * Every byte of the range is read before it is judged (#1283 review): a short read is continued, and a read that
 * makes no progress throws instead of being taken as "no LF here". Callers treat a throw as "no baseline yet" and
 * retry; they never save a guessed one.
 */
export async function lastLineBoundary(path: string, size?: number): Promise<number> {
  const fh = await open(path, "r");
  try {
    let position = size ?? (await fh.stat()).size;
    while (position > 0) {
      const length = Math.min(BOUNDARY_CHUNK, position);
      const start = position - length;
      const buffer = Buffer.alloc(length);
      for (let filled = 0; filled < length;) {
        const { bytesRead } = await fh.read(buffer, filled, length - filled, start + filled);
        if (bytesRead <= 0) throw new Error(`lastLineBoundary: no progress reading ${path} at ${start + filled}`);
        filled += bytesRead;
      }
      const at = buffer.lastIndexOf(0x0a);
      if (at >= 0) return start + at + 1;
      position = start;
    }
    return 0;
  } finally {
    await fh.close();
  }
}
