/** #1206: bounded async tail — correctness, byte cap, multibyte safety. Scratch files only. */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTailLines, TAIL_BYTE_CAP } from "../src/output-log-tail.js";

const tmpFile = (content: string | Buffer): string => {
  const dir = mkdtempSync(join(tmpdir(), "agend-logtail-"));
  const f = join(dir, "output.log");
  writeFileSync(f, content);
  return f;
};

describe("readTailLines", () => {
  it("empty file → empty text, zero lines", async () => {
    await expect(readTailLines(tmpFile(""), 50)).resolves.toEqual({ text: "", totalLines: 0, truncated: false });
  });

  it("short file → exact full content and exact count (old semantics)", async () => {
    const content = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const r = await readTailLines(tmpFile(content), 50);
    expect(r.text).toBe(content.split("\n").slice(-50).join("\n"));
    expect(r.totalLines).toBe(31); // trailing newline keeps the old split().length count
    expect(r.truncated).toBe(false);
  });

  it("returns exactly the last N lines of a mid-size file", async () => {
    const content = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const r = await readTailLines(tmpFile(content), 50);
    expect(r.text).toBe(Array.from({ length: 50 }, (_, i) => `line ${450 + i}`).join("\n"));
    expect(r.totalLines).toBe(500);
    expect(r.truncated).toBe(false);
  });

  it("file over the byte cap → bounded tail, unknown total, never half a line", async () => {
    const lines = Array.from({ length: 40000 }, (_, i) => `log line number ${i} with padding xxxxxxxx`);
    const content = lines.join("\n");
    expect(Buffer.byteLength(content)).toBeGreaterThan(TAIL_BYTE_CAP);
    const r = await readTailLines(tmpFile(content), 50);
    expect(r.text).toBe(lines.slice(-50).join("\n"));
    expect(r.totalLines).toBeNull();
    expect(r.truncated).toBe(true);
  });

  it("a multibyte character split across a chunk boundary still decodes", async () => {
    // 4-byte emoji bytes 12-15; file size 65549 puts the first backwards-chunk
    // edge at offset 13 — inside the emoji — so the two chunks rejoin it.
    const head = "x".repeat(12);
    const rest = "y".repeat(65526) + "\nlast\n";
    const r = await readTailLines(tmpFile(head + "😀\n" + rest), 2);
    expect(r.text).toBe("last\n");
    // The emoji sits on the 4th line from the end; the file fits the cap so
    // the scan is whole and the split-boundary bytes rejoin exactly.
    const r2 = await readTailLines(tmpFile(head + "😀\n" + rest), 4);
    expect(r2.text).toContain("😀");
    expect(r2.text.endsWith("last\n")).toBe(true);
    expect(r2.truncated).toBe(false);
  });

  it("missing file rejects so the caller reports the error", async () => {
    await expect(readTailLines(join(tmpdir(), "agend-logtail-no-such-file.log"), 50)).rejects.toThrow();
  });

  it("non-positive maxLines rejects", async () => {
    await expect(readTailLines(tmpFile("x\n"), 0)).rejects.toThrow();
  });
});

describe("get_instance_logs handler (#1206)", () => {
  const callHandler = async (dataDir: string, args: Record<string, unknown>) => {
    const { outboundHandlers } = await import("../src/outbound-handlers.js");
    const handler = outboundHandlers.get("get_instance_logs")!;
    let result: unknown;
    let failure: unknown;
    await handler({ dataDir } as never, args as never, ((r: unknown, e?: unknown) => { result = r; failure = e; }) as never, {
      instanceName: "caller", requestId: 1, fleetRequestId: undefined, senderSessionName: undefined,
    } as never);
    return { result: result as { lines?: string; total_lines?: number | null; _note?: string } | null, failure };
  };

  it("large log → bounded tail with unknown total and a note (no whole-file read)", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const dataDir = mkdtempSync(join(tmpdir(), "agend-logs-"));
    mkdirSync(join(dataDir, "instances", "inst"), { recursive: true });
    const lines = Array.from({ length: 40000 }, (_, i) => `log line number ${i} with padding xxxxxxxx`);
    writeFileSync(join(dataDir, "instances", "inst", "output.log"), lines.join("\n"));
    const { result, failure } = await callHandler(dataDir, { name: "inst", lines: 50 });
    expect(failure).toBeUndefined();
    expect(result?.lines).toBe(lines.slice(-50).join("\n"));
    expect(result?.total_lines).toBeNull();
    expect(result?._note).toContain("bounded tail");
  });

  it("missing log → error is reported, not swallowed", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-logs-"));
    const { result, failure } = await callHandler(dataDir, { name: "ghost", lines: 50 });
    expect(result).toBeNull();
    expect(String(failure)).toContain("Cannot read logs for 'ghost'");
  });
});
