import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * The last part of a text file, without reading the rest (#1161, D4).
 *
 * Classic ingress used to read and split the WHOLE day's chat log on every message just
 * to take its last few entries; a busy day made that grow without bound. This reads a
 * bounded block from the end, and the caller asks for a bigger one only while the
 * block does not yet hold what it needs.
 */
export interface FileTail {
  /** Whole lines, in order. The first one is never a fragment: a block that starts mid-line drops it. */
  lines: string[];
  /** The block begins at the start of the file (nothing earlier exists). */
  atStart: boolean;
}

export function readFileTail(path: string, maxBytes: number): FileTail {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    let text = buffer.toString("utf-8", 0, read);
    const atStart = start === 0;
    if (!atStart) {
      // Mid-file: everything up to the first newline is the end of a line we only have part of.
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }
    text = atStart ? text.trim() : text.trimEnd();
    return { lines: text === "" ? [] : text.split("\n"), atStart };
  } finally {
    closeSync(fd);
  }
}

const ENTRY_HEADER = /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] <.*> /;

/**
 * The chat context an agent gets with a Classic message: the last `maxLines` lines BEFORE the
 * triggering message's own entry (written to the log just before this runs, and passed
 * separately — repeating it would show the agent the same message twice). A chat message
 * may span physical lines, so the entry is cut from its timestamped header, not at its last line.
 *
 * `complete` is false when `lines` cannot answer yet — the entry's header (or `maxLines`
 * lines before it) lies beyond the block — and the caller should read a larger tail.
 */
export function selectRecentChatLines(lines: readonly string[], maxLines: number): { text: string | undefined; complete: boolean } {
  const kept = [...lines];
  let currentEntryStart = kept.length - 1;
  while (currentEntryStart > 0 && !ENTRY_HEADER.test(kept[currentEntryStart]!)) currentEntryStart--;
  const complete = currentEntryStart >= Math.max(0, maxLines);
  kept.splice(Math.max(0, currentEntryStart));
  if (kept.length === 0 || maxLines <= 0) return { text: undefined, complete };
  return { text: kept.slice(-maxLines).join("\n") || undefined, complete };
}

/**
 * `selectRecentChatLines` over the end of `path`: a bounded block first, a 4× larger one only while the
 * block cannot answer yet, never more than `maxBytes`. The same text the whole-file read gave,
 * as long as the entries asked for fit in `maxBytes` (past that the answer is what fits).
 */
export function recentChatContext(path: string, maxLines: number, startBytes: number, maxBytes: number): string | undefined {
  let bytes = startBytes;
  for (;;) {
    const tail = readFileTail(path, bytes);
    const picked = selectRecentChatLines(tail.lines, maxLines);
    if (picked.complete || tail.atStart || bytes >= maxBytes) return picked.text;
    bytes *= 4;
  }
}
