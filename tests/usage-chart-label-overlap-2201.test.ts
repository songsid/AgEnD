/**
 * Unit tests for thinXLabels (#2201).
 *
 * The function selects which x-axis date indices to label so that no two
 * consecutive shown labels are closer than `labelWidthPx` pixels apart.
 * It always keeps the first and last index.
 */
import { describe, expect, it } from "vitest";
import { thinXLabels } from "/ui/js/fleet-usage.js";

// Mirrors the Trend component's constants.
const SLOT = 14;          // px per bar slot
const LABEL_W = 5 * 5.5; // "MM-DD" (5 chars) × ~5.5 px/char at 9 px

/** Assert that no two consecutive shown indices are closer than minPx apart. */
function assertNoOverlap(indices: number[], slotPx: number, labelWidthPx: number) {
  const sorted = [...indices].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i]! - sorted[i - 1]!) * slotPx;
    expect(gap, `labels at ${sorted[i - 1]} and ${sorted[i]} are only ${gap}px apart (need ≥ ${labelWidthPx}px)`).toBeGreaterThanOrEqual(labelWidthPx);
  }
}

describe("thinXLabels (#2201)", () => {
  it("returns empty set for n=0", () => {
    expect([...thinXLabels(0, SLOT, LABEL_W)]).toEqual([]);
  });

  it("returns only index 0 for n=1", () => {
    expect([...thinXLabels(1, SLOT, LABEL_W)]).toEqual([0]);
  });

  it("always includes first (0) and last (n-1)", () => {
    for (const n of [2, 7, 8, 30, 90, 365]) {
      const shown = thinXLabels(n, SLOT, LABEL_W);
      expect(shown.has(0), `n=${n}: missing first`).toBe(true);
      expect(shown.has(n - 1), `n=${n}: missing last`).toBe(true);
    }
  });

  it("7-day range: no overlapping labels (was the regression case)", () => {
    const shown = thinXLabels(7, SLOT, LABEL_W);
    assertNoOverlap([...shown], SLOT, LABEL_W);
    expect(shown.has(0)).toBe(true);
    expect(shown.has(6)).toBe(true);
  });

  it("8-day range: no overlapping labels (was edge case for dates.length <= 8)", () => {
    const shown = thinXLabels(8, SLOT, LABEL_W);
    assertNoOverlap([...shown], SLOT, LABEL_W);
  });

  it("30-day (month) range: no overlapping labels", () => {
    const shown = thinXLabels(30, SLOT, LABEL_W);
    assertNoOverlap([...shown], SLOT, LABEL_W);
    expect(shown.has(0)).toBe(true);
    expect(shown.has(29)).toBe(true);
  });

  it("365-day (all) range: no overlapping labels", () => {
    const shown = thinXLabels(365, SLOT, LABEL_W);
    assertNoOverlap([...shown], SLOT, LABEL_W);
    expect(shown.has(0)).toBe(true);
    expect(shown.has(364)).toBe(true);
  });

  it("single-day range (today): only index 0", () => {
    const shown = thinXLabels(1, SLOT, LABEL_W);
    expect([...shown]).toEqual([0]);
  });

  it("very narrow slot (slot=1): labels still don't overlap", () => {
    // stress test: slot=1px means every step is at least ceil((labelW+2)/1) = 30 slots
    const shown = thinXLabels(100, 1, LABEL_W);
    assertNoOverlap([...shown], 1, LABEL_W);
  });

  it("labelWidthPx=0: all labels shown", () => {
    const n = 10;
    const shown = thinXLabels(n, SLOT, 0);
    // step = max(1, ceil(2/14)) = 1 → all included
    expect(shown.size).toBe(n);
  });
});
