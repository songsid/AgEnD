/**
 * #3066 §1: how much is 100% of an account's weekly quota, measured — what this account's agents used while the vendor's
 * weekly percent moved (the readings of quota-history.ts, the hours of the usage ledger). Pure: the fleet gathers both.
 *
 * Within one reset window (the same `resetsAt`, the percent never going down) the first and last readings bound an
 * interval: capacity = consumed in it ÷ Δ%. Two uncertainties, both carried into the range, never hidden:
 * - the vendors report whole percents, so Δ is ±1: the range divides by Δ+1 … Δ−1;
 * - the ledger is hourly, so the two boundary hours are uncertain: without them is the low end, with them the high.
 * A window counts only when Δ ≥ 10 points (rounding then costs ≤ ~±10%). Several windows: the median of their midpoints,
 * the range their lowest low … highest high.
 *
 * Three bases, because the vendor's weighting is not published: the API-equivalent at list price (likely what the quota
 * tracks — it weighs Opus over Sonnet, cache reads far below input), output tokens, all tokens. With three windows or
 * more, the basis whose capacity varies least across weeks (coefficient of variation) is named as the best fit.
 *
 * What it cannot see: the same account used outside this fleet (claude.ai, another machine) spends the quota without a
 * token here, so the estimate comes out LOW; a window whose bases disagree with each other by more than 2× is marked
 * `mixed`. The page says so (usage.capacity.only_agend, usage.capacity.mixed).
 */
import type { QuotaReading } from "./quota-history.js";

export const CAPACITY_MIN_DELTA = 10;
export const BASES = ["api", "output", "all"] as const;
export type CapacityBasis = typeof BASES[number];
const H = 3_600_000;

/** One hour of one account's usage, on each basis (api null: a model in it has no list price). */
export interface CapacityHour { hour: number; api: number | null; output: number; all: number }

export interface BasisEstimate { median: number; low: number; high: number; cv: number | null }
export type CapacityEstimate =
  | { status: "ok"; windows: number; deltaPct: number; bases: Partial<Record<CapacityBasis, BasisEstimate>>; bestFit: CapacityBasis | null; mixed: boolean }
  | { status: "not_enough"; deltaPct: number };

interface Window { t1: number; p1: number; t2: number; p2: number }

/** The reset windows the readings span: a new `resetsAt`, or a percent that went down, starts the next. */
export function quotaWindows(readings: readonly QuotaReading[]): Window[] {
  const out: Window[] = [];
  let cur: (Window & { resetsAt: string | null }) | null = null;
  for (const r of [...readings].sort((a, b) => a.t - b.t)) {
    if (!cur || r.resetsAt !== cur.resetsAt || r.used < cur.p2) {
      if (cur) out.push(cur);
      cur = { t1: r.t, p1: r.used, t2: r.t, p2: r.used, resetsAt: r.resetsAt };
    } else { cur.t2 = r.t; cur.p2 = r.used; }
  }
  if (cur) out.push(cur);
  return out.map(({ t1, p1, t2, p2 }) => ({ t1, p1, t2, p2 }));
}

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const cv = (xs: number[]): number | null => {
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return mean > 0 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length) / mean : null;
};

/** The estimate for one account's one weekly metric. */
export function estimateCapacity(readings: readonly QuotaReading[], hours: readonly CapacityHour[]): CapacityEstimate {
  const windows = quotaWindows(readings);
  const usable = windows.filter((w) => w.p2 - w.p1 >= CAPACITY_MIN_DELTA);
  if (!usable.length) return { status: "not_enough", deltaPct: Math.max(0, ...windows.map((w) => w.p2 - w.p1)) };
  const per: Array<Partial<Record<CapacityBasis, { low: number; mid: number; high: number }>>> = usable.map((w) => {
    const delta = w.p2 - w.p1;
    const inside = hours.filter((h) => h.hour >= w.t1 && h.hour + H <= w.t2);                // whole hours within: low
    const touching = hours.filter((h) => h.hour + H > w.t1 && h.hour < w.t2);               // any hour touching: high
    const sum = (list: readonly CapacityHour[], b: CapacityBasis): number | null => {
      let n = 0;
      for (const h of list) { const v = h[b]; if (v === null) return null; n += v; }
      return n;
    };
    const out: Partial<Record<CapacityBasis, { low: number; mid: number; high: number }>> = {};
    for (const b of BASES) {
      const lo = sum(inside, b), hi = sum(touching, b);
      if (lo === null || hi === null || hi <= 0) continue;               // a basis with an unpriced hour, or nothing used
      out[b] = { low: lo / ((delta + 1) / 100), mid: ((lo + hi) / 2) / (delta / 100), high: hi / ((delta - 1) / 100) };
    }
    return out;
  });
  const bases: Partial<Record<CapacityBasis, BasisEstimate>> = {};
  for (const b of BASES) {
    const ws = per.map((p) => p[b]).filter((x): x is { low: number; mid: number; high: number } => !!x);
    if (!ws.length) continue;
    const mids = ws.map((x) => x.mid);
    bases[b] = { median: median(mids), low: Math.min(...ws.map((x) => x.low)), high: Math.max(...ws.map((x) => x.high)), cv: cv(mids) };
  }
  // Best fit: with three windows or more, the basis that varies least across them.
  const scored = BASES.filter((b) => bases[b]?.cv !== null && bases[b]?.cv !== undefined && per.filter((p) => p[b]).length >= 3);
  const bestFit = scored.length ? scored.reduce((a, b) => (bases[b]!.cv! < bases[a]!.cv! ? b : a)) : null;
  // Mixed: in some window the API-equivalent and the token count disagree (each against its own median) by over 2×.
  let mixed = false;
  if (bases.api && bases.all && usable.length >= 2) {
    for (const p of per) {
      if (!p.api || !p.all) continue;
      const ra = p.api.mid / bases.api.median, rt = p.all.mid / bases.all.median;
      if (Math.max(ra / rt, rt / ra) > 2) mixed = true;
    }
  }
  return { status: "ok", windows: usable.length, deltaPct: Math.max(...usable.map((w) => w.p2 - w.p1)), bases, bestFit, mixed };
}
