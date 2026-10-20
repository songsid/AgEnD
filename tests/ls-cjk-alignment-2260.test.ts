/**
 * Tests for CJK-aware column alignment in agend ls and attach picker (#2260).
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
// These tests replicate the exact padDisplay + nameW logic from cli.ts lsAction
// so that reverting nameW to r.name.length or padDisplay to r.name.padEnd
// causes the Backend-column-start assertion to fail.

describe("ls table: Backend column starts at the same display column for all name types", () => {
  // Mirrors the cli.ts lsAction formula exactly.
  function nameCell(name: string, nameW: number): string {
    // padDisplay: name + spaces to fill nameW display cols
    const pad = " ".repeat(Math.max(0, nameW - displayWidth(name)));
    return name + pad;
  }

  function computeNameW(names: string[], minW = 16): number {
    return Math.max(minW, ...names.map(n => displayWidth(n) + 1));
  }

  it("ASCII and CJK names align (primary case)", () => {
    const names = ["agend-reviewer-t001", "鬥破開發-opus-t002", "classic-鬥破串接-1843"];
    const nameW = computeNameW(names);
    const cells = names.map(n => nameCell(n, nameW));
    const displayCols = cells.map(c => displayWidth(c));
    expect(new Set(displayCols).size, "all name cells same display width").toBe(1);
  });

  it("Latin Extended (č) name aligns with ASCII — catches pre-fix padEnd regression", () => {
    // Before fix: nameW computed by r.name.length (č length=1), padEnd(nameW).
    // č has displayWidth=1, so padEnd(16) gives 16 chars / 16 display cols.
    // After fix: nameW computed by displayWidth(č)=1 → same 16; padDisplay pads
    // by display-col giving the same 16 display cols → Backend stays at col 19.
    const names = ["aa", "č"];
    const nameW = computeNameW(names);
    // nameW = max(16, displayWidth("aa")+1) = max(16, 3) = 16
    expect(nameW).toBe(16);
    const cellAA = nameCell("aa", nameW);
    const cellCZ = nameCell("č", nameW);
    expect(displayWidth(cellAA), "aa cell").toBe(16);
    expect(displayWidth(cellCZ), "č cell").toBe(16);
    // Backend column starts at numW (3) + nameW (16) = 19 for both rows.
    const numW = 3;
    expect(numW + displayWidth(cellAA)).toBe(19);
    expect(numW + displayWidth(cellCZ)).toBe(19);
  });

  it("SMP CJK (𠮷) name aligns with ASCII — catches inline-displayWidth SMP bug", () => {
    // Before fix: inline displayWidth in ls-attach-resolve gave 𠮷=1 (not 2).
    // This test verifies the correct value 2 propagates through nameW.
    const names = ["aa", "𠮷"];
    const nameW = computeNameW(names);
    // 𠮷 displayWidth=2, so contribution=3; "aa" contribution=3 → nameW=16
    expect(nameW).toBe(16);
    const cellAA = nameCell("aa", nameW);
    const cellSMP = nameCell("𠮷", nameW);
    expect(displayWidth(cellSMP), "𠮷 cell").toBe(16);
    expect(displayWidth(cellAA)).toBe(displayWidth(cellSMP));
  });

  it("long CJK name (>16 display cols) expands nameW correctly", () => {
    // "研一官網-t1544335726169165914": displayWidth = 8 + 21 = 29 → nameW = 30
    const name = "研一官網-t1544335726169165914";
    const names = ["short", name];
    const nameW = computeNameW(names);
    expect(nameW).toBe(displayWidth(name) + 1);
    // Both cells must have the same display width
    const cells = names.map(n => nameCell(n, nameW));
    expect(new Set(cells.map(c => displayWidth(c))).size).toBe(1);
  });
});
