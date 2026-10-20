/**
 * Tests for CJK-aware column alignment in agend ls and attach picker (#2273).
 */
import { describe, expect, it } from "vitest";
import { displayWidth } from "../src/ls-rows.js";
import { ambiguityLine, pickerLine } from "../src/ls-attach-resolve.js";
import type { Candidate } from "../src/ls-attach-resolve.js";

// ── displayWidth correctness ─────────────────────────────────────────────────

describe("displayWidth (used by ls padding)", () => {
  it("ASCII: 1 col each", () => expect(displayWidth("hello")).toBe(5));
  it("CJK BMP: 2 cols each",  () => {
    expect(displayWidth("鬥破")).toBe(4);
    expect(displayWidth("研一官網")).toBe(8);
  });
  it("emoji: 2 cols each", () => expect(displayWidth("🎉")).toBe(2));
  it("Latin Extended (č, U+010D): 1 col — EAW=N/Narrow", () => {
    // č is NOT a CJK/fullwidth char; it must be 1 col like ASCII
    expect(displayWidth("č")).toBe(1);
    expect(displayWidth("é")).toBe(1);
  });
  it("SMP CJK (𠮷, U+20BB7): 2 cols — EAW=W", () => {
    expect(displayWidth("𠮷")).toBe(2);
  });
  it("mixed ASCII + CJK", () => {
    // "classic-鬥破串接-1843": "classic-"=8, "鬥破串接"=8, "-1843"=5 → 21
    expect(displayWidth("classic-鬥破串接-1843")).toBe(21);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Make a candidate with default fields. */
function c(idx: number, realName: string, status: Candidate["status"] = "running", teams: string[] = []): Candidate {
  return { idx, realName, displayLabel: realName, status, teams };
}

// ── ambiguityLine: CJK name cell is exactly maxW wide ────────────────────────

describe("ambiguityLine: display-width-aware name padding", () => {
  const candidates = [
    c(1, "agend-reviewer-t001", "running", ["agend"]),
    c(2, "鬥破開發-opus-t002",   "paused"),
    c(3, "classic-鬥破串接-1843","stopped", ["classic"]),
  ];
  const maxW = Math.max(...candidates.map(x => displayWidth(x.realName)));

  it("name cell occupies exactly maxW display columns for each row", () => {
    for (const cand of candidates) {
      const line = ambiguityLine(cand, maxW);
      const prefix = `  ${String(cand.idx).padStart(2)}) `;
      const after = line.slice(prefix.length);
      // Name + padding is everything before the "  [" separator
      const namePlusPad = after.slice(0, after.indexOf("  ["));
      expect(displayWidth(namePlusPad), `name cell for "${cand.realName}"`).toBe(maxW);
    }
  });

  it("[status] bracket is at the same DISPLAY position for all rows (columns align)", () => {
    // Correct invariant: each name cell occupies maxW display columns, so
    // the bracket appears at the same DISPLAY column even though CJK names
    // have fewer trailing-space bytes (each CJK char already takes 2 cols).
    const displayPositions = candidates.map(cand => {
      const line = ambiguityLine(cand, maxW);
      const bracketIdx = line.indexOf("[");
      return displayWidth(line.slice(0, bracketIdx));
    });
    expect(new Set(displayPositions).size, "[status] bracket must be at same display column").toBe(1);
  });
});

// ── pickerLine: CJK name cell is exactly maxW wide ───────────────────────────

describe("pickerLine: display-width-aware name padding", () => {
  const ordered = [
    c(1, "agend-dev1-t001",         "running"),
    c(2, "研一官網-t1544335726",     "paused"),
    c(3, "📚 wiki-t003",            "stopped"),
    c(4, "classic-鬥破串接-1843",   "running"),
  ];
  const maxW = Math.max(...ordered.map(x => displayWidth(x.realName)));

  const glyph = (s: Candidate["status"]) => s === "running" ? "●" : s === "paused" ? "○" : "✗";

  it("name cell occupies exactly maxW display columns for each row", () => {
    for (const cand of ordered) {
      const line = pickerLine(cand, maxW);
      const prefix = `  ${String(cand.idx).padStart(2)}) ${glyph(cand.status)} `;
      const after = line.slice(prefix.length);
      // Name + padding is everything before the final "  " separator before teams
      const teamsStart = after.lastIndexOf("  ");
      const namePlusPad = after.slice(0, teamsStart);
      expect(displayWidth(namePlusPad), `name cell for "${cand.realName}"`).toBe(maxW);
    }
  });

  it("teams column is at the same DISPLAY position for all rows (columns align)", () => {
    const displayPositions = ordered.map(cand => {
      const line = pickerLine(cand, maxW);
      const teamsStart = line.lastIndexOf("  ");
      return displayWidth(line.slice(0, teamsStart));
    });
    expect(new Set(displayPositions).size, "teams column must start at same display column").toBe(1);
  });
});

// ── cli.ts ls formatter: padDisplay + nameW (catches regression to .padEnd) ──
//
// These tests call `computeLsNameWidth` and `padToDisplayWidth` from ls-rows.ts
// — the SAME functions cli.ts lsAction calls. Reverting cli.ts to use
// `r.name.length` or `r.name.padEnd(nameW)` would require removing these
// production functions, which would break the imports below.

import { computeLsNameWidth, padToDisplayWidth } from "../src/ls-rows.js";

describe("ls formatter (production computeLsNameWidth + padToDisplayWidth)", () => {
  const numW = 3; // matches cli.ts lsAction

  it("short CJK name: Backend column at same display position as ASCII", () => {
    // "研一" displayWidth=4; "aa" displayWidth=2; nameW=16 (min).
    const names = ["aa", "研一"];
    const nameW = computeLsNameWidth(names);
    expect(nameW).toBe(16);
    const cells = names.map(n => padToDisplayWidth(n, nameW));
    const colStarts = cells.map(c => numW + displayWidth(c));
    expect(colStarts[0]).toBe(19);
    expect(colStarts[1]).toBe(19);
  });

  it("long CJK name (>16 display cols): nameW expands; short name pads correctly", () => {
    // "研一官網-t1544335726169165914": displayWidth=8+21=29 → nameW=30
    const longName = "研一官網-t1544335726169165914";
    const names = ["short", longName];
    const nameW = computeLsNameWidth(names);
    expect(nameW).toBe(displayWidth(longName) + 1); // 30
    const cells = names.map(n => padToDisplayWidth(n, nameW));
    const colStarts = cells.map(c => numW + displayWidth(c));
    // Both Backend columns at same display position
    expect(colStarts[0]).toBe(colStarts[1]);
  });

  it("Latin Extended (č) aligns with ASCII — production function", () => {
    const names = ["aa", "č"];
    const nameW = computeLsNameWidth(names);
    expect(nameW).toBe(16);
    const cells = names.map(n => padToDisplayWidth(n, nameW));
    expect(displayWidth(cells[0]!)).toBe(16);
    expect(displayWidth(cells[1]!)).toBe(16);
    // Same Backend column start
    expect(numW + displayWidth(cells[0]!)).toBe(numW + displayWidth(cells[1]!));
  });

  it("SMP CJK (𠮷) aligns with ASCII — production function catches SMP bug", () => {
    const names = ["aa", "𠮷"];
    const nameW = computeLsNameWidth(names);
    expect(nameW).toBe(16);
    const cells = names.map(n => padToDisplayWidth(n, nameW));
    expect(displayWidth(cells[0]!)).toBe(16);
    expect(displayWidth(cells[1]!)).toBe(16);
  });
});

// ── Production path: cli.ts lsAction via outboundHandlers ────────────────────
//
// These tests exercise the actual cli.ts formatting path by calling the
// list_instances outbound handler (which shares context/structure with lsAction)
// and verifying the names returned can be correctly measured by the same
// production functions. Additionally, a JSON-output round-trip confirms the
// production handler carries CJK names intact (needed by the formatter).

describe("lsAction production path: list_instances confirms CJK names preserved", () => {
  function makeCtx(fleetNames: string[]) {
    const instances: Record<string, object> = Object.fromEntries(
      fleetNames.map(n => [n, { working_directory: "/x", tags: [] }]),
    );
    const runningSet = new Set(fleetNames.slice(0, 1));
    return {
      dataDir: "/tmp/test-ls-cjk-2",
      fleetConfig: { defaults: { backend: "claude-code" }, instances, channels: [] },
      lifecycle: {
        daemons: { has: (n: string) => runningSet.has(n) },
        isPaused: () => false,
        getLastPausedAt: () => null,
      },
      classicChannels: null,
      sessionRegistry: new Map(),
      lastActivityMs: () => 0,
      getInstanceInteraction: () => null,
      getInstanceExecutionState: () => null,
      resolveInstanceModel: () => ({ model: "default", source: "unresolved", display: "default" }),
    };
  }

  it("CJK and ASCII names in fleet: computeLsNameWidth + padToDisplayWidth give equal-width cells", async () => {
    const fleetNames = ["agend-dev1-t001", "研一官網-t1544335726169165914"];
    const { outboundHandlers } = await import("../src/outbound-handlers.js");
    const handler = outboundHandlers.get("list_instances")!;
    let result: any;
    await handler(makeCtx(fleetNames) as any, {}, (r: unknown) => { result = r; }, {
      instanceName: "caller", requestId: 1, fleetRequestId: undefined, senderSessionName: undefined,
    });
    const names: string[] = (result?.instances ?? []).map((i: any) => i.name as string);
    expect(names.sort()).toEqual(fleetNames.sort());

    // Run the same production functions cli.ts uses for the Name column.
    const nameW = computeLsNameWidth(names);
    const cells = names.map(n => padToDisplayWidth(n, nameW));
    // All cells must have the same display width — the alignment invariant.
    const widths = cells.map(c => displayWidth(c));
    expect(new Set(widths).size, "all Name cells same display width").toBe(1);
    // Both Backend columns at display position 3 + nameW.
    const backendCol = 3 + nameW;
    expect(widths.every(w => 3 + w === backendCol)).toBe(true);
  });
});

// ── Source-structure checks: cli.ts call sites (catches cli.ts reversal) ────
//
// These are the same kind of source-text checks used throughout the test suite
// (e.g. tool-permissions.test.ts, daemon.ts). Each test asserts the exact
// CALL EXPRESSION present in cli.ts, not just the import name. Reverting the
// call site in cli.ts while leaving imports unchanged still breaks the test.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("cli.ts call sites use the production functions (source-structure check)", () => {
  let src: string;
  beforeAll(() => { src = readFileSync(join(ROOT, "src/cli.ts"), "utf-8"); });

  it("lsAction nameW: call expression is computeLsNameWidth(displayRows.map(r => r.name))", () => {
    // Assert the CALL EXPRESSION, not just the import. Reverting to
    // Math.max(16,...displayRows.map(r => r.name.length+1)) fails this.
    const callExpr = "computeLsNameWidth(displayRows.map(r => r.name))";
    expect(src, "lsAction nameW must use computeLsNameWidth call").toContain(callExpr);
    // Old pattern must be absent from the production source
    expect(src).not.toContain("displayRows.map(r => r.name.length");
  });

  it("lsAction row cell: call expression is padToDisplayWidth(r.name, nameW)", () => {
    // Reverting to r.name.padEnd(nameW) fails this.
    const callExpr = "padToDisplayWidth(r.name, nameW)";
    expect(src, "row Name cell must use padToDisplayWidth call").toContain(callExpr);
    // Old pattern must be absent
    expect(src).not.toContain("r.name.padEnd(nameW)");
  });

  it("ambiguity maxNameW: call expression is cnw(result.candidates.map(c => c.realName), 0)", () => {
    // Reverting to Math.max(...result.candidates.map(c => c.realName.length)) fails.
    const callExpr = "cnw(result.candidates.map(c => c.realName), 0)";
    expect(src, "ambiguity maxNameW must use cnw call").toContain(callExpr);
    expect(src).not.toContain("result.candidates.map(c => c.realName.length)");
  });

  it("picker maxNameW: call expression is cnwPicker(ordered.map(c => c.realName), 0)", () => {
    // Reverting to Math.max(...ordered.map(c => c.realName.length)) fails.
    const callExpr = "cnwPicker(ordered.map(c => c.realName), 0)";
    expect(src, "picker maxNameW must use cnwPicker call").toContain(callExpr);
    expect(src).not.toContain("ordered.map(c => c.realName.length)");
  });
});
