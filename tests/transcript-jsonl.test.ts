import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ stat: vi.fn(), open: vi.fn(), read: vi.fn(), close: vi.fn() }));
vi.mock("node:fs/promises", () => ({ stat: io.stat, open: io.open }));
import { readNewLines } from "../src/transcript-jsonl.js";

beforeEach(() => {
  vi.resetAllMocks();
  io.open.mockResolvedValue({ read: io.read, close: io.close });
});

function scriptedRead(text: string, fromOffset = 0, size = fromOffset + Buffer.byteLength(text)) {
  const bytes = Buffer.from(text);
  io.stat.mockResolvedValue({ size });
  io.read.mockImplementation(async (buffer: Buffer, offset: number, length: number, position: number) => {
    expect(offset).toBe(0);
    expect(length).toBe(size - fromOffset);
    expect(position).toBe(fromOffset);
    bytes.copy(buffer);
    return { bytesRead: bytes.length, buffer };
  });
}

describe("complete JSONL byte boundaries", () => {
  it("retains the entire range when there is no newline", async () => {
    scriptedRead('{"complete_json":true}', 50);
    expect(await readNewLines("fixture", 50)).toEqual({ lines: [], newOffset: 50 });
    expect(io.close).toHaveBeenCalledOnce();
  });

  it("uses the last newline byte, including non-ASCII complete lines", async () => {
    const prefix = '{"text":"中文🛠"}\n{"next":1}\n';
    scriptedRead(prefix + '{"pending":', 123);
    expect(await readNewLines("fixture", 123)).toEqual({ lines: ['{"text":"中文🛠"}', '{"next":1}'], newOffset: 123 + Buffer.byteLength(prefix) });
  });

  it("consumes a newline-terminated final line immediately", async () => {
    const text = '{"last":true}\n';
    scriptedRead(text, 25);
    expect(await readNewLines("fixture", 25)).toEqual({ lines: ['{"last":true}'], newOffset: 25 + Buffer.byteLength(text) });
  });

  it("advances past blank lines too, so an empty batch is not replayed", async () => {
    scriptedRead(" \n\n", 10);
    expect(await readNewLines("fixture", 10)).toEqual({ lines: [], newOffset: 13 });
  });

  it("only consumes the complete prefix of a short read, not the larger stat size", async () => {
    scriptedRead('{"read":true}\n{"partial":', 80, 180);
    expect(await readNewLines("fixture", 80)).toEqual({ lines: ['{"read":true}'], newOffset: 94 });
    expect(io.close).toHaveBeenCalledOnce();
  });

  it("keeps the offset when read returns zero bytes after stat", async () => {
    scriptedRead("", 50, 100);
    expect(await readNewLines("fixture", 50)).toEqual({ lines: [], newOffset: 50 });
    expect(io.close).toHaveBeenCalledOnce();
  });

  it("does not open a file that has no new bytes", async () => {
    io.stat.mockResolvedValue({ size: 50 });
    expect(await readNewLines("fixture", 50)).toEqual({ lines: [], newOffset: 50 });
    expect(io.open).not.toHaveBeenCalled();
  });

  it("closes the handle on a read failure without advancing an offset", async () => {
    io.stat.mockResolvedValue({ size: 50 });
    io.read.mockRejectedValue(new Error("fixture read failure"));
    await expect(readNewLines("fixture", 0)).rejects.toThrow("fixture read failure");
    expect(io.close).toHaveBeenCalledOnce();
  });
});
