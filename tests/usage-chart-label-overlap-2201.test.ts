/**
 * Tests for the usage chart x-axis label thinning (#2201).
 *
 * Pure unit tests for thinXLabels + real Trend-render regressions via
 * mini-dom (SVG attribute inspection, no browser bbox needed).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { addTurn, emptyLedger, type Ledger } from "../src/cache-ledger.js";
import { emptyDays } from "../src/usage-rollup.js";
import { buildUsageReport, type UsageInstanceInput } from "../src/usage-report.js";

// ── Pure unit tests for thinXLabels ─────────────────────────────────────────

// Mirrors the Trend component's constants.
const SLOT = 14;          // px per bar slot
const LABEL_W = 5 * 5.5; // "MM-DD" (5 chars) × ~5.5 px/char at 9 px

let U: any;

/** Assert that no two consecutive shown indices are closer than minPx apart. */
function assertNoOverlap(indices: number[], slotPx: number, labelWidthPx: number) {
  const sorted = [...indices].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i]! - sorted[i - 1]!) * slotPx;
    expect(gap, `labels at ${sorted[i - 1]} and ${sorted[i]} are only ${gap}px apart (need ≥ ${labelWidthPx}px)`).toBeGreaterThanOrEqual(labelWidthPx);
  }
}

let p: AppPage, fleet: any;
let reqs: string[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: null };
const HOUR = 3_600_000, DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 18, 12);
const at = (daysAgo: number) => Date.UTC(2026, 9, 18 - daysAgo, 9);
function ledger(turns: Array<[number, string]>): Ledger {
  const l = emptyLedger(), c = { kind: "claude" as const, ino: 1, offset: 0 };
  for (const [t, model] of turns) addTurn(l, c, { t, model, prompt: 1000, uncached: 1000, read: 8000, write5m: 0, write1h: 500, write: null, output: 200 }, 0, "default");
  return l;
}
const coverage = (from: number, to: number) => ({ ...emptyDays(), coverage: [[from, to]] as Array<[number, number]> });
const inst = (name: string, l?: Ledger): UsageInstanceInput => ({
  name, backend: "claude-code", team: null, status: "ok",
  ledger: l ?? emptyLedger(), days: coverage(NOW - 31 * DAY, NOW),
});
function buildReport(from: string, to: string) {
  return buildUsageReport({
    now: NOW, zone: "UTC",
    range: { kind: "custom", from, to },
    group: "instance",
    scanning: { active: false, caughtUp: true, pendingBytes: 0, pendingFiles: 0 },
    messages: [],
    instances: [inst("billing", ledger([[at(1), "claude-opus-4-5"]]))],
  });
}

const fetchFake = async (url: string) => {
  reqs.push(url);
  return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
};
const mount = async () => { await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "usage" }, navKey: "fleet:usage|1|en" })); await settle(6); };

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/usage" });
  (globalThis as any).fetch = fetchFake;
  fleet = await import("/ui/js/panel-fleet.js");
  U = await import("/ui/js/fleet-usage.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });

// ── Pure thinXLabels tests ───────────────────────────────────────────────────

describe("thinXLabels (#2201)", () => {
  it("returns empty set for n=0", () => {
    expect([...U.thinXLabels(0, SLOT, LABEL_W)]).toEqual([]);
  });

  it("returns only index 0 for n=1", () => {
    expect([...U.thinXLabels(1, SLOT, LABEL_W)]).toEqual([0]);
  });

  it("n=2: only last shown (first+last would overlap — overlap-free wins)", () => {
    // thinXLabels(2,14,27.5): step=3, n-1=1 < step → {1} only, not {0,1}.
    const shown = U.thinXLabels(2, SLOT, LABEL_W);
    expect(shown.has(1), "last must be included").toBe(true);
    expect(shown.has(0), "first must NOT be included (would overlap)").toBe(false);
    assertNoOverlap([...shown], SLOT, LABEL_W); // trivially true for size 1
  });

  it("n=3: only last shown (1 slot = 14px < step=3)", () => {
    // n-1=2, step=3: 2 < 3 → {2} only
    const shown = U.thinXLabels(3, SLOT, LABEL_W);
    expect(shown.has(2)).toBe(true);
    expect(shown.size).toBe(1);
  });

  it("always includes index 0 and n-1 for larger ranges (n>=4 at SLOT=14)", () => {
    for (const n of [4, 7, 8, 30, 90, 365]) {
      const shown = U.thinXLabels(n, SLOT, LABEL_W);
      expect(shown.has(0), `n=${n}: missing first`).toBe(true);
      expect(shown.has(n - 1), `n=${n}: missing last`).toBe(true);
    }
  });

  it("7-day range: labels don't overlap (was the primary regression case)", () => {
    const shown = U.thinXLabels(7, SLOT, LABEL_W);
    assertNoOverlap([...shown], SLOT, LABEL_W);
    expect(shown.has(0)).toBe(true);
    expect(shown.has(6)).toBe(true);
  });

  it("8-day range: no overlapping labels", () => {
    assertNoOverlap([...U.thinXLabels(8, SLOT, LABEL_W)], SLOT, LABEL_W);
  });

  it("30-day (month) range: no overlapping labels", () => {
    assertNoOverlap([...U.thinXLabels(30, SLOT, LABEL_W)], SLOT, LABEL_W);
  });

  it("365-day (all) range: no overlapping labels", () => {
    const shown = U.thinXLabels(365, SLOT, LABEL_W);
    assertNoOverlap([...shown], SLOT, LABEL_W);
    expect(shown.has(364)).toBe(true);
  });

  it("labelWidthPx=0: all labels shown", () => {
    const n = 10;
    const shown = U.thinXLabels(n, SLOT, 0);
    expect(shown.size).toBe(n);
  });
});

// ── Trend render regression (catches revert to old modulo/<=8 logic) ─────────

describe("Trend render via mini-dom (#2201)", () => {
  it("7-day: exactly 3 labels at correct dates — catches old dates.length<=8 and new Set() regressions", async () => {
    // thinXLabels(7,14,27.5) → step=3 → indices {0,3,6} → "10-12","10-15","10-18".
    // Old code (<=8): 7 labels. new Set() regression: 0 labels. Both fail this.
    const r = buildReport("2026-10-12", "2026-10-18");
    answer = { status: 200, body: r };
    await p.unmount(); reqs = [];
    await mount();
    const labels = p.root.querySelectorAll(".us-chart .us-xlabel");
    expect(labels.length, "7-day: must have exactly 3 x-axis labels (indices 0,3,6)").toBe(3);
    const texts = Array.from(labels).map((el: any) => el.textContent);
    expect(texts).toContain("10-12"); // first
    expect(texts).toContain("10-15"); // middle (index 3)
    expect(texts).toContain("10-18"); // last
    // Spacing must be >= LABEL_W
    const xs = Array.from(labels).map((el: any) => parseFloat(el.getAttribute("x")));
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]! - xs[i - 1]!, `consecutive x gap`).toBeGreaterThanOrEqual(LABEL_W);
    }
  });

  it("2-day custom range: exactly 1 label, the most recent date (n=2 overlap regression)", async () => {
    // thinXLabels(2,14,27.5) = {1} only: shows last date "10-18".
    // Old code (<=8): 2 labels. new Set() regression: 0 labels. Both fail this.
    const r = buildReport("2026-10-17", "2026-10-18");
    answer = { status: 200, body: r };
    await p.unmount(); reqs = [];
    await mount();
    const labels = p.root.querySelectorAll(".us-chart .us-xlabel");
    expect(labels.length, "2-day: must have exactly 1 x-axis label (last only)").toBe(1);
    expect(labels[0].textContent, "2-day: label must be the most recent date").toBe("10-18");
  });
});
