/** Pure parser probes only: timeout the child, never the fleet's event loop (#2416, CodeQL #74/#76). */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GrokBackend } from "../src/backend/grok.js";
import { cardCode } from "../src/scheduler/task-board.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const rate = new GrokBackend("/tmp/codeql-parser-only").getErrorPatterns().find(p => p.type === "rate_limit")!.pattern;

// Keep catastrophic regressions out of the Vitest worker. This program loads only parsers and an in-memory DB;
// no backend process, tmux, fleet, network or operator files are opened. The generous deadline includes tsx startup.
const probe = String.raw`
  import { readFileSync } from "node:fs";
  const input = JSON.parse(readFileSync(0, "utf8"));
  let result;
  if (input.kind === "grok") {
    const pattern = new RegExp(input.source, input.flags + "g");
    result = [...input.text.matchAll(pattern)].length;
  } else {
    const { SchedulerDb } = await import("./src/scheduler/db.ts");
    const { boardToolAction } = await import("./src/task-board-tool.ts");
    const db = new SchedulerDb(":memory:");
    try {
      result = boardToolAction(db, "synthetic-agent", { action: "get", id: input.text }) ?? null;
    } finally { db.close(); }
  }
  console.log(JSON.stringify({ result }));
`;

function bounded(input: Record<string, unknown>): unknown {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
    cwd: root, input: JSON.stringify(input), encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024,
  });
  expect(child.error, `parser must finish within 5 s: ${child.stderr}`).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout).result;
}

describe("CodeQL untrusted parser regressions", () => {
  it("rejects a whitespace-heavy Grok pane without exponential backtracking", () => {
    const text = "┃\tRetry failed:\tSome resource has been exhausted:\n┃" + "\t\t\n┃".repeat(40);
    expect(bounded({ kind: "grok", source: rate.source, flags: rate.flags, text })).toBe(0);
  });

  it("an agent's invalid task reference returns without quadratic backtracking", () => {
    // Below the MCP body limit, with a suffix so the tool's trim() retains the interior whitespace.
    expect(bounded({ kind: "task", text: "m" + " ".repeat(240_000) + "!" })).toBeNull();
  });

  it.each([" ", "\t", " \t  "])("still recognizes wrapped exhaustion with %j separators", separator => {
    const text = `┃ Retry failed: Some resource has been exhausted:\n┃${separator}\n┃${separator}its rate limit.`;
    expect(rate.test(text)).toBe(true);
    expect(rate.test("┃ Retry failed: unrelated\n┃ scan_rate_limit()")).toBe(false);
  });

  it.each([
    ["m3", "M-3"], [" S - 0004 ", "S-4"], ["\tm \t-\n 7\r\n", "M-7"],
    ["M\n8", "M-8"], ["M -- 3", null], ["M -", null], ["m !", null],
  ])("preserves card parsing for %j", (raw, expected) => {
    expect(cardCode(raw!)).toBe(expected);
  });
});
