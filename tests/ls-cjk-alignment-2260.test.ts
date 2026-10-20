/**
 * Tests for CJK-aware column alignment in agend ls and attach picker (#2260).
 */
import { describe, expect, it } from "vitest";
import { displayWidth } from "../src/ls-rows.js";
import { ambiguityLine, pickerLine } from "../src/ls-attach-resolve.js";
import type { Candidate } from "../src/ls-attach-resolve.js";

// ── displayWidth sanity ──────────────────────────────────────────────────────

describe("displayWidth (used by ls padding)", () => {
  it("ASCII: 1 col each", () => expect(displayWidth("hello")).toBe(5));
  it("CJK: 2 cols each",  () => {
    expect(displayWidth("鬥破")).toBe(4);
    expect(displayWidth("研一官網")).toBe(8);
  });
  it("emoji: 2 cols each", () => expect(displayWidth("🎉")).toBe(2));
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
