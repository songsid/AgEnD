/**
 * #1206: byte/line-bounded async tail for instance output logs.
 *
 * `output.log` is a tmux pipe-pane ANSI stream that can grow to many MB; a
 * whole-file synchronous read blocks the event loop and can blow the 30s IPC
 * budget. This reads backwards from the end in fixed chunks and never scans
 * more than TAIL_BYTE_CAP, so I/O stays bounded no matter how large the log
 * is. A file fully covered by the scan reports an exact line count; a file
 * larger than the cap reports the tail with totalLines null (unknown) rather
 * than a silently complete-looking answer.
 *
 * (Distinct from log-tail.ts `readFileTail`, which serves chat-log entry
 * context with trim/header semantics; this one serves raw last-N-lines with
 * an exact-or-unknown count for the logs RPC.)
 */
import { open } from "node:fs/promises";

/** One backwards chunk; small enough to stay cheap, large enough to rarely loop. */
export const TAIL_CHUNK_BYTES = 64 * 1024;
/** Hard cap on bytes scanned from the end of the file per call. */
export const TAIL_BYTE_CAP = 1024 * 1024;

export interface TailResult {
  /** The last `maxLines` lines (a cut first line is dropped, never half-shown). */
  text: string;
  /** Exact line count, or null when the file exceeds the byte cap. */
  totalLines: number | null;
  /** True when the head of the file was not scanned. */
  truncated: boolean;
}

export async function readTailLines(path: string, maxLines: number): Promise<TailResult> {
  if (!Number.isInteger(maxLines) || maxLines <= 0) {
    throw new Error(`maxLines must be a positive integer, got ${maxLines}`);
  }
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    if (size === 0) return { text: "", totalLines: 0, truncated: false };
    const chunks: Buffer[] = [];
    let position = size;
    let scanned = 0;
    let newlineCount = 0;
    // A file that fits the cap is always scanned whole, so small logs keep an
    // exact total. Only a file larger than the cap stops early once it holds
    // maxLines+1 newlines (the +1 proves the first kept line is whole).
    const stopEarly = size > TAIL_BYTE_CAP;
    while (position > 0 && scanned < TAIL_BYTE_CAP && (!stopEarly || newlineCount <= maxLines)) {
      const want = Math.min(TAIL_CHUNK_BYTES, position, TAIL_BYTE_CAP - scanned);
      position -= want;
      scanned += want;
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, position);
      const slice = bytesRead === want ? buf : buf.subarray(0, bytesRead);
      chunks.unshift(slice);
      for (let i = slice.length - 1; i >= 0; i--) {
        if (slice[i] === 0x0a && ++newlineCount > maxLines) break;
      }
    }
    const reachedStart = position === 0;
    // Buffers are concatenated whole before decoding so a multibyte character
    // split across a chunk boundary still decodes correctly.
    const text = Buffer.concat(chunks).toString("utf-8");
    const parts = text.split("\n");
    if (!reachedStart) parts.shift(); // head-cut partial line: drop, never half-show
    const kept = parts.slice(-maxLines);
    return {
      text: kept.join("\n"),
      // A trailing newline leaves a final "" element, matching the old
      // whole-file split().length semantics exactly.
      totalLines: reachedStart ? parts.length : null,
      truncated: !reachedStart,
    };
  } finally {
    await fh.close().catch(() => {});
  }
}
