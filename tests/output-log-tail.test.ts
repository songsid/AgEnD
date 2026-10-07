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

describe("readTailLines regression (#1225)", () => {
  // R1 — kills the CR-strip mutant: removing `.replace(/\r$/, "")` from the
  //   partial-fallback blank-check makes `"\r" === ""` false, so the branch is
  //   never entered and partial stays false instead of true.
  it("R1: \\r\\n\\r\\n after a 2 MiB line — CR strip enables the partial fallback", async () => {
    // A 2 MiB content run terminated by \r\n\r\n. After the backwards scan
    // reads the last ~1 MiB, the scanned window holds one giant content run
    // and two CR+LF blank lines. head-cut (parts.shift) removes the partial
    // content run, leaving ["\r", ""]. The CR strip turns both to "":
    //   parts.every(p => p.replace(/\r$/, "") === "") → true → partial fallback.
    // Mutant: strip removed → "\r" === "" is false → no partial → partial: false.
    const content = "A".repeat(2 * 1024 * 1024) + "\r\n\r\n";
    const r = await readTailLines(tmpFile(content), 50);
    expect(r.truncated, "file exceeds the byte cap").toBe(true);
    expect(r.totalLines).toBeNull();
    expect(r.partial, "CR strip made the blank check true → partial fallback").toBe(true);
    expect(r.text.length).toBeGreaterThan(0);
  });

  // R2 — kills the per-chunk-decode mutant: decoding each backwards chunk
  //   separately before concat produces U+FFFD for every orphaned byte of a
  //   multibyte char split at the chunk edge; concat-before-decode repairs it.
  it("R2: 3-byte CJK at a chunk boundary — concat-before-decode, no U+FFFD", async () => {
    // A 3-byte CJK char (中, U+4E2D: E4 B8 AD) is placed so E4 is the last byte
    // of chunk_B (the small backwards chunk) and B8+AD open chunk_A (64 KiB).
    // Buffer.concat(chunks).toString("utf-8") assembles the char correctly;
    // chunk-by-chunk decoding produces U+FFFD for each orphaned byte instead.
    //
    // Layout:  [head "x"×9][中  ][y×65525][\n][中][\nlast]
    //           ^-- chunk_B (10 B) --^
    //           boundary at byte 10: E4 in chunk_B, B8+AD in chunk_A.
    //           File size = TAIL_CHUNK_BYTES + 10.
    const cjk = "\u4e2d"; // 中: UTF-8 E4 B8 AD
    const head = "x".repeat(9);
    const rest = "y".repeat(65525) + "\n" + cjk + "\nlast";
    const content = head + cjk + rest;
    expect(Buffer.byteLength(content)).toBe(TAIL_CHUNK_BYTES + 10); // self-check
    const r = await readTailLines(tmpFile(content), 3);
    expect(r.truncated).toBe(false);
    expect(r.text).not.toContain("\uFFFD"); // concat-before-decode: no orphaned bytes
    expect(r.text).toContain(cjk);          // char is present and intact in the tail
  });

  // R2b — kills the char-slice mutant on the partial-fallback branch:
  //   `raw.subarray(raw.length - TAIL_CHUNK_BYTES).toString("utf-8")` bounds by
  //   *bytes*; replacing it with `text.slice(-TAIL_CHUNK_BYTES)` bounds by *chars*.
  //   With ASCII fixtures bytes === chars, so the mutant survives. This CJK fixture
  //   has 3 bytes per char, so the char-slice mutant returns ~3× more bytes.
  it("R2b: partial-fallback byte slice, not char slice — CJK line past the cap", async () => {
    // File: "中" × N + "\n", where 3N + 1 > TAIL_BYTE_CAP.
    // The scan reads the last TAIL_BYTE_CAP bytes (stopEarly = true), so
    // reachedStart = false. After decoding and head-cut the only remaining
    // part is [""], so the partial fallback fires.
    // The fallback slices raw by bytes: raw.subarray(raw.length - TAIL_CHUNK_BYTES).
    // Char-slice mutant: text.slice(-TAIL_CHUNK_BYTES) returns TAIL_CHUNK_BYTES
    // *characters* — each "中" is 3 bytes, so Buffer.byteLength ≈ 3 × 65 KiB.
    const CJK = "\u4e2d"; // 中: 3 UTF-8 bytes each
    const N = Math.ceil(TAIL_BYTE_CAP / 3) + 1; // 3N+1 just past the byte cap
    const content = CJK.repeat(N) + "\n";
    expect(Buffer.byteLength(content)).toBeGreaterThan(TAIL_BYTE_CAP); // self-check

    const r = await readTailLines(tmpFile(content), 50);
    expect(r.partial).toBe(true);   // fallback was entered
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeGreaterThan(0);
    // Key assertion: byte-bounded slice, not char-bounded.
    // The char-slice mutant yields ~3 × TAIL_CHUNK_BYTES bytes here.
    expect(Buffer.byteLength(r.text, "utf-8")).toBeLessThanOrEqual(TAIL_CHUNK_BYTES);
    // End-anchored: the file's last character "\n" is present.
    expect(r.text.endsWith("\n")).toBe(true);
    // A byte cut may split one char at the very start; at most one U+FFFD and
    // only there (per the code comment in output-log-tail.ts).
    const stripped = r.text.startsWith("\uFFFD") ? r.text.slice(1) : r.text;
    expect(stripped).not.toContain("\uFFFD");
  });

  // R3 — kills the !reachedStart guard mutant: removing `!reachedStart &&`
  //   from the partial-fallback condition makes a fully-scanned small file with
  //   only blank lines enter the partial branch (partial: true); the guard
  //   ensures a whole-file scan never hits that path (partial: false).
  it("R3: small file of only blank lines — !reachedStart guard keeps partial false", async () => {
    // File = "\n\n\n\n\n" (five blank lines, 5 bytes < TAIL_BYTE_CAP).
    // reachedStart = true (entire file scanned); the guard `!reachedStart &&`
    // short-circuits the blank check → partial branch is never entered.
    // Mutant: guard removed → parts.every(p => "" === "") is true → partial: true.
    const content = "\n\n\n\n\n";
    const r = await readTailLines(tmpFile(content), 50);
    expect(r.partial, "whole-file scan: !reachedStart guard prevents partial fallback").toBe(false);
    expect(r.truncated).toBe(false);
    expect(r.totalLines).toBe(content.split("\n").length); // 6
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
