/** #1206: bounded async tail — correctness, byte cap, multibyte safety. Scratch files only. */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTailLines, TAIL_BYTE_CAP, TAIL_CHUNK_BYTES } from "../src/output-log-tail.js";

const tmpFile = (content: string | Buffer): string => {
  const dir = mkdtempSync(join(tmpdir(), "agend-logtail-"));
  const f = join(dir, "output.log");
  writeFileSync(f, content);
  return f;
};

describe("readTailLines", () => {
  it("empty file → empty text, zero lines", async () => {
    await expect(readTailLines(tmpFile(""), 50)).resolves.toEqual({ text: "", totalLines: 0, truncated: false, partial: false });
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

  it("lines:0 is an argument error, not a read failure", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-logs-"));
    const { result, failure } = await callHandler(dataDir, { name: "ghost", lines: 0 });
    expect(result).toBeNull();
    expect(String(failure)).toMatch(/lines/i);
    expect(String(failure)).not.toContain("Cannot read logs");
  });
});

describe("readTailLines reviewer round (a)-(c) + P1", () => {
  it("(a) long lines past the cap → bounded scan, whole lines only, truncated", async () => {
    // 60 × 30 KiB lines ≈ 1.8 MiB: the last 1 MiB holds ~34 newlines, so a
    // cap-ignoring mutant would return exactly 50 lines and a half-line
    // keeper would return a short first line.
    const LINE = 30 * 1024;
    const lines = Array.from({ length: 60 }, (_, i) => `L${i}` + "z".repeat(LINE - `L${i}`.length));
    const r = await readTailLines(tmpFile(lines.join("\n")), 50);
    expect(r.truncated).toBe(true);
    expect(r.totalLines).toBeNull();
    expect(r.partial).toBe(false);
    const out = r.text.split("\n");
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(50); // the cap stopped the scan, not the line count
    for (const line of out) expect(line).toHaveLength(LINE); // no half line
    expect(out[out.length - 1]).toBe(lines[lines.length - 1]); // exact file tail
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(TAIL_BYTE_CAP);
  });

  it("(b) exactly CAP bytes → exact total; one byte more → unknown", async () => {
    const unit = "x".repeat(99) + "\n"; // 100 B
    const filler = unit.repeat(10485); // 1,048,500 B
    const exact = filler + "y".repeat(75) + "\n"; // +76 B = 1,048,576 B
    expect(Buffer.byteLength(exact)).toBe(TAIL_BYTE_CAP);
    const rExact = await readTailLines(tmpFile(exact), 5);
    expect(rExact.truncated).toBe(false);
    expect(rExact.totalLines).toBe(exact.split("\n").length);
    const rOver = await readTailLines(tmpFile(exact + "!"), 5);
    expect(rOver.truncated).toBe(true);
    expect(rOver.totalLines).toBeNull();
    expect(rOver.text.endsWith("!")).toBe(true);
  });

  it("(c) multi-chunk file inside the cap → exact total and exact tail", async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `m${i}` + "x".repeat(96)); // ~300 KiB
    const content = lines.join("\n") + "\n";
    expect(Buffer.byteLength(content)).toBeGreaterThan(64 * 1024);
    expect(Buffer.byteLength(content)).toBeLessThan(TAIL_BYTE_CAP);
    const r = await readTailLines(tmpFile(content), 50);
    expect(r.truncated).toBe(false);
    expect(r.totalLines).toBe(content.split("\n").length);
    // Trailing newline: split leaves a final "", so the last 50 elements are
    // lines 2951..2999 plus "" — identical to the old whole-file slice.
    expect(r.text).toBe([...lines.slice(-49), ""].join("\n"));
  });

  for (const ending of ["\n", "\r\n", "\n\n"]) {
    it(`P1: 2MB line terminated by ${JSON.stringify(ending)} → non-empty end-anchored partial`, async () => {
      const content = "A".repeat(2 * 1024 * 1024) + ending;
      const r = await readTailLines(tmpFile(content), 50);
      expect(r.truncated).toBe(true);
      expect(r.totalLines).toBeNull();
      expect(r.partial).toBe(true);
      expect(r.text.length).toBeGreaterThan(0);
      // End-anchored: exactly the last 64 KiB of bytes, decoded.
      const expected = Buffer.from(content).subarray(-TAIL_CHUNK_BYTES).toString("utf-8");
      expect(r.text).toBe(expected);
    });
  }

  it("P1: tail megabytes without a line break → window tail, flagged partial, never empty", async () => {
    const head = Array.from({ length: 8000 }, (_, i) => `h${i}`).join("\n") + "\n";
    const tailRun = "Z".repeat(1_200_000);
    const content = head + tailRun;
    expect(Buffer.byteLength(content)).toBeGreaterThan(TAIL_BYTE_CAP);
    const r = await readTailLines(tmpFile(content), 50);
    expect(r.truncated).toBe(true);
    expect(r.totalLines).toBeNull();
    expect(r.partial).toBe(true);
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.text.length).toBeLessThanOrEqual(TAIL_CHUNK_BYTES);
    expect(r.text).toBe("Z".repeat(r.text.length)); // file-tail bytes, nothing else
  });
});

describe("attachPipePaneLog (d)", () => {
  const makeDaemon = async () => {
    const { Daemon } = await import("../src/daemon.js");
    const { default: pino } = await import("pino");
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-attach-"));
    const daemon = new Daemon("attach-test", {
      working_directory: tmpdir(),
      restart_policy: { max_retries: 1, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      log_level: "error",
    }, instanceDir, true, undefined, undefined, pino({ level: "silent" }) as never) as unknown as {
      attachPipePaneLog: () => Promise<void>;
      logger: { warn: (...args: unknown[]) => void };
      tmux: unknown;
    };
    return daemon;
  };

  it("pipeOutput rejection warns with the attach message instead of vanishing", async () => {
    const { vi } = await import("vitest");
    const daemon = await makeDaemon();
    daemon.tmux = { pipeOutput: vi.fn().mockRejectedValue(new Error("attach boom")) };
    const warn = vi.spyOn(daemon.logger, "warn");
    await daemon.attachPipePaneLog();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[1])).toContain("Failed to attach pipe-pane");
  });

  it("successful attach does not warn", async () => {
    const { vi } = await import("vitest");
    const daemon = await makeDaemon();
    daemon.tmux = { pipeOutput: vi.fn().mockResolvedValue(undefined) };
    const warn = vi.spyOn(daemon.logger, "warn");
    await daemon.attachPipePaneLog();
    expect(warn).not.toHaveBeenCalled();
  });
});
