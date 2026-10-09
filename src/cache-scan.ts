/**
 * #1468: read a JSONL file from a byte offset, line by line, without ever holding a large line or blocking the
 * fleet loop. Transcripts reach hundreds of MB, and a single line (a tool result) can be tens of MB:
 * - every chunk read is awaited, so the event loop runs between chunks;
 * - a line up to `wholeUpTo` bytes is handed over whole; a longer one only as its first `headBytes` and last
 *   `tailBytes` (a Claude assistant line has its model/id at the start and its usage/timestamp at the end);
 * - a pass stops at the first line end past `maxBytes` and returns the offset to resume from — always a line
 *   start, never inside a line. An unfinished last line (a file being appended to) is left for the next pass.
 */
import { open } from "node:fs/promises";

export interface ScanOptions {
  maxBytes: number;
  chunkBytes?: number;
  wholeUpTo?: number;
  headBytes?: number;
  tailBytes?: number;
}

/** A whole line (`whole`), or a long one's two ends (`head`/`tail`). `length` is the line's size in bytes. */
export type ScanLine = { whole: Buffer; length: number } | { head: Buffer; tail: Buffer; length: number };

export interface ScanResult {
  /** Where the next pass starts: just after the last complete line read. */
  offset: number;
  /** The file's size when this pass started. */
  size: number;
  /** Nothing complete is left before `size`. */
  done: boolean;
  bytes: number;
}

export const SCAN_CHUNK_BYTES = 256 * 1024;
export const SCAN_WHOLE_UP_TO = 1024 * 1024;
const HEAD_BYTES = 8 * 1024;
const TAIL_BYTES = 64 * 1024;

export async function scanJsonl(path: string, from: number, opts: ScanOptions, onLine: (line: ScanLine) => void): Promise<ScanResult> {
  const chunkBytes = opts.chunkBytes ?? SCAN_CHUNK_BYTES;
  const wholeUpTo = opts.wholeUpTo ?? SCAN_WHOLE_UP_TO;
  const headBytes = opts.headBytes ?? HEAD_BYTES;
  const tailBytes = opts.tailBytes ?? TAIL_BYTES;
  const fh = await open(path, "r");
  try {
    const size = (await fh.stat()).size;
    let pos = from, committed = from;
    let parts: Buffer[] = [], partLen = 0;
    let big = false, head = Buffer.alloc(0), tail = Buffer.alloc(0), total = 0;
    const append = (seg: Buffer): void => {
      if (!big) {
        if (partLen + seg.length <= wholeUpTo) { parts.push(seg); partLen += seg.length; return; }
        const all = Buffer.concat([...parts, seg]);
        head = Buffer.from(all.subarray(0, headBytes));
        tail = Buffer.from(all.subarray(Math.max(0, all.length - tailBytes)));
        total = all.length; big = true; parts = []; partLen = 0;
        return;
      }
      total += seg.length;
      const joined = seg.length >= tailBytes ? seg : Buffer.concat([tail, seg]);
      tail = Buffer.from(joined.subarray(Math.max(0, joined.length - tailBytes)));
    };
    const emit = (): void => {
      if (big) onLine({ head, tail, length: total });
      else if (partLen > 0) onLine({ whole: parts.length === 1 ? parts[0]! : Buffer.concat(parts, partLen), length: partLen });
      parts = []; partLen = 0; big = false; head = Buffer.alloc(0); tail = Buffer.alloc(0); total = 0;
    };
    while (pos < size) {
      const want = Math.min(chunkBytes, size - pos);
      const chunk = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(chunk, 0, want, pos);
      if (bytesRead <= 0) break;
      let i = 0;
      while (i < bytesRead) {
        const nl = chunk.indexOf(10, i);
        if (nl === -1 || nl >= bytesRead) { append(chunk.subarray(i, bytesRead)); i = bytesRead; break; }
        append(chunk.subarray(i, nl));
        emit();
        committed = pos + nl + 1;
        i = nl + 1;
        if (committed - from >= opts.maxBytes) return { offset: committed, size, done: committed >= size, bytes: committed - from };
      }
      pos += bytesRead;
    }
    return { offset: committed, size, done: true, bytes: committed - from };
  } finally {
    await fh.close();
  }
}

/** The JSON object that starts at `start` (an opening brace) in `text`, or null if it does not close there. */
export function objectAt(text: string, start: number): string | null {
  if (text[start] !== "{") return null;
  let depth = 0, inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === "\"") inString = false;
    } else if (c === "\"") inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}
