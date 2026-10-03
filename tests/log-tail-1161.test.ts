import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileTail, recentChatContext, selectRecentChatLines } from "../src/log-tail.js";

/** #1161 (D4): Classic ingress reads the END of today's chat log, not the whole file. */
let dir: string;
let log: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-log-tail-")); log = join(dir, "2026-10-04.log"); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** The whole-file algorithm this replaced — the oracle. */
function reference(text: string, maxLines: number): string | undefined {
  const lines = text.trim().split("\n");
  const entryHeader = /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] <.*> /;
  let currentEntryStart = lines.length - 1;
  while (currentEntryStart > 0 && !entryHeader.test(lines[currentEntryStart]!)) currentEntryStart--;
  lines.splice(currentEntryStart);
  if (lines.length === 0 || maxLines <= 0) return undefined;
  return lines.slice(-maxLines).join("\n") || undefined;
}

const entry = (i: number, extra = 0) =>
  [`[2026-10-04T10:${String(i % 60).padStart(2, "0")}:00.000Z] <user${i}> message number ${i}`, ...Array.from({ length: extra }, (_, k) => `  continuation ${i}.${k}`)].join("\n");

describe("readFileTail", () => {
  it("a file smaller than the block is returned whole, trimmed, and says it starts at the start", () => {
    writeFileSync(log, "\n\nfirst\nsecond\n\n");
    expect(readFileTail(log, 1024)).toEqual({ lines: ["first", "second"], atStart: true });
  });

  it("a block that begins mid-file drops the fragment of the line it cut into", () => {
    writeFileSync(log, "aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\n");
    const tail = readFileTail(log, 16);                      // starts inside "bbbbbbbbbb"
    expect(tail.atStart).toBe(false);
    expect(tail.lines).toEqual(["cccccccccc"]);
  });

  it("a block that holds no newline at all yields nothing (the caller asks for more)", () => {
    writeFileSync(log, `${"x".repeat(1000)}\n`);
    expect(readFileTail(log, 100)).toEqual({ lines: [], atStart: false });
  });

  it("an empty file", () => {
    writeFileSync(log, "");
    expect(readFileTail(log, 100)).toEqual({ lines: [], atStart: true });
  });

  it("reads at most the block it was asked for", () => {
    writeFileSync(log, Array.from({ length: 5000 }, (_, i) => entry(i)).join("\n") + "\n");
    const tail = readFileTail(log, 4096);
    expect(tail.lines.join("\n").length).toBeLessThanOrEqual(4096);
    expect(tail.lines.at(-1)).toContain("message number 4999");
  });

  it("a multi-byte character cut by the block start only costs the (dropped) fragment", () => {
    writeFileSync(log, `${"你好".repeat(50)}\nlast line\n`);
    const tail = readFileTail(log, 14);                      // starts in the middle of a 3-byte character
    expect(tail.lines).toEqual(["last line"]);
  });
});

describe("selectRecentChatLines", () => {
  it("excludes the triggering entry, wherever its header is, and takes the last maxLines before it", () => {
    const lines = [entry(1), entry(2, 2), entry(3), entry(4, 3)].join("\n").split("\n");
    expect(selectRecentChatLines(lines, 10)).toEqual({ text: reference(lines.join("\n"), 10), complete: false });
    expect(selectRecentChatLines(lines, 2).text).toBe(reference(lines.join("\n"), 2));
  });

  it("says `complete` only when the block holds maxLines before the entry", () => {
    const lines = [entry(1), entry(2), entry(3), entry(4)].join("\n").split("\n");
    expect(selectRecentChatLines(lines, 3).complete).toBe(true);     // 3 lines precede the last entry
    expect(selectRecentChatLines(lines, 4).complete).toBe(false);
  });

  it("no header in the block at all is incomplete, not 'no context'", () => {
    expect(selectRecentChatLines(["  continuation 1", "  continuation 2"], 3)).toEqual({ text: undefined, complete: false });
  });

  it("maxLines <= 0 is nothing", () => {
    expect(selectRecentChatLines([entry(1), entry(2)], 0).text).toBeUndefined();
    expect(selectRecentChatLines([entry(1), entry(2)], -1).text).toBeUndefined();
  });
});

describe("recentChatContext = the whole-file answer", () => {
  it("is identical to the old algorithm over many logs, block sizes and maxLines (multi-line entries included)", () => {
    let seed = 42;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let trial = 0; trial < 40; trial++) {
      const entries = Array.from({ length: 1 + rand(60) }, (_, i) => entry(i, rand(4)));
      const text = entries.join("\n") + (rand(2) ? "\n" : "");
      writeFileSync(log, text);
      for (const maxLines of [1, 3, 10, 25]) {
        for (const start of [32, 100, 512, 100_000]) {
          expect(recentChatContext(log, maxLines, start, 1 << 20), `trial ${trial} maxLines ${maxLines} start ${start}`).toBe(reference(text, maxLines));
        }
      }
    }
  });

  it("grows the block only as far as it must", () => {
    // 200 entries; the last 10 lines before the trigger fit in a few hundred bytes
    writeFileSync(log, Array.from({ length: 200 }, (_, i) => entry(i)).join("\n") + "\n");
    expect(recentChatContext(log, 10, 400, 1 << 20)).toBe(reference(readLog(), 10));
  });

  it("gives what fits when the entries asked for do not fit in the cap", () => {
    writeFileSync(log, Array.from({ length: 200 }, (_, i) => entry(i)).join("\n") + "\n");
    const capped = recentChatContext(log, 100, 64, 256);     // 100 lines can never fit in 256 bytes
    expect(capped).toBeDefined();
    expect(capped!.split("\n").length).toBeLessThan(100);
    expect(capped!.split("\n").at(-1)).toContain("message number 198");
  });

  it("an entry bigger than the first block is still excluded in full", () => {
    const huge = entry(9, 400);                              // a 400-line message, the trigger
    writeFileSync(log, [entry(1), entry(2), entry(3), huge].join("\n") + "\n");
    expect(recentChatContext(log, 2, 128, 1 << 20)).toBe(reference(readLog(), 2));
    expect(recentChatContext(log, 2, 128, 1 << 20)).toContain("message number 3");
  });

  function readLog(): string { return require("node:fs").readFileSync(log, "utf8"); }
});
