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
