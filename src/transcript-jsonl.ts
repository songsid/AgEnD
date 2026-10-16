import { open, stat, type FileHandle } from "node:fs/promises";

/** #1218 P0: the most one look reads. A busy session's delta is read over several looks, never in one buffer. */
export const READ_MAX_BYTES = 1024 * 1024;
/** #1218 P0: a line longer than this is not parsed: only its head is kept (LongLine). A tool result can be MBs. */
export const LINE_MAX_BYTES = 256 * 1024;
/** #1218 P0: how much of a long line's start is kept, enough for its type, ids and tool name. */
export const LONG_HEAD_BYTES = 8 * 1024;

/**
 * A line too long to parse: where it sits among `lines` (`at`: how many complete lines come before it), the start
 * of it as text (a JSON fragment), and how many bytes it has (`complete`: its end was seen in this look; otherwise
 * `bytes` is what was seen so far and the rest is skipped by the next looks).
 */
export interface LongLine { at: number; head: string; bytes: number; complete: boolean; /** Where it starts in the file. */ offset: number }

/**
 * #1218 P0 (#1786 review): a long line that a caller must not lose — a turn's record (codex `task_complete` with a long
 * final reply, a pasted prompt) — is read whole and parsed, up to this size. Longer: skipped like any long line.
 */
export const WHOLE_LINE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The line of `bytes` bytes at `offset`, as text, when it is at most `max` bytes; null otherwise or when it cannot be read whole.
 * `handle`: read from this open file (the caller's, left open) instead of opening `path`.
 */
export async function readWholeLine(path: string, offset: number, bytes: number, max = WHOLE_LINE_MAX_BYTES, handle?: FileHandle): Promise<string | null> {
  if (bytes <= 0 || bytes > max) return null;
  const fh = handle ?? await open(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    for (let filled = 0; filled < bytes;) {
      const { bytesRead } = await fh.read(buf, filled, bytes - filled, offset + filled);
      if (bytesRead <= 0) return null;
      filled += bytesRead;
    }
    return buf.toString("utf-8");
  } finally {
    if (!handle) await fh.close();
  }
}

export interface ReadNewLinesResult {
  lines: string[];
  /** #1218: where each of `lines` starts in the file (same order). */
  offsets: number[];
  newOffset: number;
  /** #1218 P0: lines over LINE_MAX_BYTES, by position (empty when none). */
  long: LongLine[];
  /** #1218 P0: more complete bytes may be waiting past `newOffset` (the look stopped at READ_MAX_BYTES). */
  more: boolean;
  /** #1218 P0: `newOffset` is inside a long line: pass `skipping: true` to the next look, which drops up to its end. */
  skipping: boolean;
  /** #1218 P0: this look found the end of the long line it was skipping: the offset just past its line end. */
  longEnd?: number;
}

/** A look's records in file order: each complete line, and each long line where it sits among them. */
export function* recordsInOrder(read: Pick<ReadNewLinesResult, "lines" | "long">): Generator<{ line: string } | { long: LongLine }> {
  let next = 0;
  for (let i = 0; i <= read.lines.length; i++) {
    while (next < read.long.length && read.long[next]!.at === i) yield { long: read.long[next++]! };
    if (i < read.lines.length) yield { line: read.lines[i]! };
  }
}

/**
 * #1218 P0 (#1786 review): a caller's way through one look's records when some long lines must be read whole. `whole`
 * picks them by their head (a turn record); each is read (≤ WHOLE_LINE_MAX_BYTES) and given back as a line, in its
 * place. A picked long line that runs past this look is held in `pending` and given back once a later look finds its
 * end (`longEnd`). Every other long line is given back as itself (its head). Lines the CLI is still writing wait.
 */
export async function resolveLongLines(path: string, read: ReadNewLinesResult, pending: { offset: number } | null,
  whole: (head: string) => boolean): Promise<{ records: Array<{ line: string } | { long: LongLine }>; pending: { offset: number } | null }> {
  const records: Array<{ line: string } | { long: LongLine }> = [];
  if (pending && read.longEnd !== undefined) {
    const line = await readWholeLine(path, pending.offset, read.longEnd - 1 - pending.offset).catch(() => null);
    if (line !== null) records.push({ line });
    pending = null;
  }
  for (const record of recordsInOrder(read)) {
    if (!("long" in record) || !whole(record.long.head)) { records.push(record); continue; }
    if (!record.long.complete) { pending = { offset: record.long.offset }; continue; }
    const line = await readWholeLine(path, record.long.offset, record.long.bytes).catch(() => null);
    records.push(line !== null ? { line } : record);
  }
  return { records, pending };
}

/**
 * #1786 review (Fable P3): a claude-code assistant line, known by its head. Claude often writes `message` before `type`
 * (parentUuid, isSidechain, message, requestId, type): a long reply's `"type":"assistant"` can sit past the head, while
 * its message's `"role":"assistant"` is near the start.
 */
export function isClaudeAssistantHead(head: string): boolean {
  return head.includes('"type":"assistant"') || /"message":\{[^{}]{0,400}?"role":"assistant"/.test(head);
}

/** #1218 P0: looks per poll — a busy session is followed at up to this many READ_MAX_BYTES per poll, each awaited. */
export const LOOKS_PER_POLL = 4;

/** The first `max` bytes of `buf` as text, never ending inside a UTF-8 character. */
function headText(buf: Buffer, max: number): string {
  let end = Math.min(max, buf.length);
  if (end < buf.length) while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.toString("utf-8", 0, end);
}

/**
 * Tail only newline-terminated JSONL records. A CLI can flush one record in
 * several writes; the unfinished suffix must remain before the next offset.
 *
 * #1218 P0: bounded. One look reads at most `maxBytes` (READ_MAX_BYTES); what is beyond waits for the next look
 * (`more`). A line over `maxLine` (LINE_MAX_BYTES) is never decoded or parsed whole: it is reported in `long` with
 * its head, and the offset moves past it — across several looks if it is longer than one (`skipping`). Transcripts
 * reach hundreds of MB and one tool result can be tens of MB; the fleet loop must not hold either in one buffer.
 */
export async function readNewLines(path: string, fromOffset: number, opts: { maxBytes?: number; maxLine?: number; skipping?: boolean; handle?: FileHandle } = {}): Promise<ReadNewLinesResult> {
  const maxBytes = Math.max(1, opts.maxBytes ?? READ_MAX_BYTES);
  const maxLine = Math.max(1, opts.maxLine ?? LINE_MAX_BYTES);
  // `handle`: one file the caller opened and checked (its identity), read and sized through that handle only.
  const stats = opts.handle ? await opts.handle.stat() : await stat(path);
  const empty = (offset: number, skipping: boolean, more: boolean, longEnd?: number): ReadNewLinesResult =>
    ({ lines: [], offsets: [], newOffset: offset, long: [], more, skipping, ...(longEnd !== undefined ? { longEnd } : {}) });
  if (stats.size <= fromOffset) return empty(fromOffset, !!opts.skipping, false);
  const fh = opts.handle ?? await open(path, "r");
  try {
    const read = async (at: number, length: number): Promise<Buffer> => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buffer, 0, length, at);
      return buffer.subarray(0, bytesRead);
    };
    let pos = fromOffset;
    let budget = maxBytes;
    let longEnd: number | undefined;
    // Inside a long line already reported: drop through its end (its LF), within this look's budget.
    if (opts.skipping) {
      const chunk = await read(pos, Math.min(budget, stats.size - pos));
      const lf = chunk.indexOf(0x0a);
      if (lf < 0) return empty(pos + chunk.length, true, pos + chunk.length < stats.size);
      pos += lf + 1;
      budget -= lf + 1;
      longEnd = pos;
      if (budget <= 0 || pos >= stats.size) return empty(pos, false, pos < stats.size, longEnd);
    }
    // Find LF in the bytes actually read, before decoding (UTF-8 characters
    // may themselves span writes). stat.size is not a consumed-byte boundary.
    const window = await read(pos, Math.min(budget, stats.size - pos));
    const complete = window.lastIndexOf(0x0a) + 1;
    const lines: string[] = [];
    const offsets: number[] = [];
    const long: LongLine[] = [];
    let start = 0;
    while (start < complete) {
      const end = window.indexOf(0x0a, start);
      const length = end - start;
      if (length > maxLine) long.push({ at: lines.length, head: headText(window.subarray(start, end), LONG_HEAD_BYTES), bytes: length, complete: true, offset: pos + start });
      else {
        const line = window.toString("utf-8", start, end);
        if (line.trim()) { lines.push(line); offsets.push(pos + start); }
      }
      start = end + 1;
    }
    const ended = longEnd !== undefined ? { longEnd } : {};
    // No line end after `complete`: a record still being written — unless it is already too long to be one we parse.
    const tail = window.length - complete;
    if (tail >= maxLine) {
      long.push({ at: lines.length, head: headText(window.subarray(complete), LONG_HEAD_BYTES), bytes: tail, complete: false, offset: pos + complete });
      const newOffset = pos + window.length;
      return { lines, offsets, newOffset, long, more: newOffset < stats.size, skipping: true, ...ended };
    }
    const newOffset = pos + complete;
    // More: this look was cut short by its budget, so complete records may wait past the offset.
    return { lines, offsets, newOffset, long, more: window.length === budget && newOffset < stats.size, skipping: false, ...ended };
  } finally {
    if (!opts.handle) await fh.close();
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
