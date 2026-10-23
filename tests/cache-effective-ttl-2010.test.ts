/**
 * #2010 (b) / #1469: the effective TTL — what a 5-minute Claude cache label really behaves as, measured from the last
 * 7 days of 5–60 minute gaps (one definition, agreed with #1469's keep-warm design) — and how the report uses it:
 * the simulation pings and judges expiry by it, writes stay priced at the label, a measured 5 minutes recommends the
 * 1-hour setting instead of keep-warm, too little evidence says so (an estimate). Plus the 5m/1h write mix (#2001).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CacheService } from "../src/cache-service.js";
import { addTurn, emptyLedger, type FileCursor, type GapEvent, type Ledger, type Turn } from "../src/cache-ledger.js";
import { analyzeLedger, effectiveTtl, latestLabelSec, EFFECTIVE_TTL_HIT_MAX, EFFECTIVE_TTL_MIN_SAMPLES, EFFECTIVE_TTL_MISS_MIN, EFFECTIVE_TTL_WINDOW_MS, type EffectiveTtl } from "../src/cache-analysis.js";
import type { Rates } from "../src/cache-prices.js";

const R: Rates = { input: 1, read: 0.1, write5m: 1.25, write1h: 2, write: 1.25, output: 5 };
const rates = (): Rates => R;
const C = 1_000_000, MIN = 60_000, H = 3_600_000, DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
/** A gap event: ends at `tEnd`, `gapSec` long, after a write labelled `label`, rewriting `write` of a context C. */
const gap = (tEnd: number, gapSec: number, write: number, label = 300, measured: number | null = write): GapEvent =>
  [tEnd, gapSec, C, "m", label, "m", C, measured, write];
const gaps = (n: number, misses: number, o: { gapSec?: number; label?: number; at?: number } = {}): GapEvent[] =>
  Array.from({ length: n }, (_, i) => gap((o.at ?? NOW) - i * MIN, o.gapSec ?? 1200, i < misses ? C : 1000, o.label ?? 300));
const pick = (e: EffectiveTtl) => [e.ttlSec, e.basis, e.sample, e.misses];

describe("effectiveTtl: the rule", () => {
  it("the thresholds are the agreed ones", () => {
    expect([EFFECTIVE_TTL_WINDOW_MS, EFFECTIVE_TTL_MIN_SAMPLES, EFFECTIVE_TTL_HIT_MAX, EFFECTIVE_TTL_MISS_MIN]).toEqual([7 * DAY, 10, 0.1, 0.5]);
  });
  it("a 5-minute label: ≥10 gaps and ≤10% rewritten → 1 h; ≥50% → 5 min; anything else → not enough evidence", () => {
    expect(pick(effectiveTtl(gaps(10, 0), 300, "claude", NOW))).toEqual([3600, "measured", 10, 0]);
    expect(pick(effectiveTtl(gaps(10, 1), 300, "claude", NOW))).toEqual([3600, "measured", 10, 1]);
    expect(pick(effectiveTtl(gaps(10, 5), 300, "claude", NOW))).toEqual([300, "measured", 10, 5]);
    expect(pick(effectiveTtl(gaps(10, 2), 300, "claude", NOW))).toEqual([null, "insufficient", 10, 2]);
    expect(pick(effectiveTtl(gaps(9, 0), 300, "claude", NOW))).toEqual([null, "insufficient", 9, 0]);
    expect(effectiveTtl(gaps(9, 9), 300, "claude", NOW).ttlSec, "nine misses are still too few").toBeNull();
    expect(effectiveTtl([], 300, "claude", NOW)).toEqual({ ttlSec: null, fiveMinute: null, basis: "insufficient", sample: 0, misses: 0, rate: null });
  });
  it("latestLabelSec: the latest session's label, else the backend's default (#1469's executor calls effectiveTtl with it)", () => {
    expect([latestLabelSec(emptyLedger(), "claude", NOW), latestLabelSec(emptyLedger(), "codex", NOW)]).toEqual([3600, 1800]);
    const l = fiveMinute({ gapsCount: 2, rewritten: 0 });
    expect(latestLabelSec(l, "claude", NOW)).toBe(300);
    addTurn(l, l.files["a"]!, { t: NOW - DAY, model: "m", prompt: C, uncached: 0, read: 0, write5m: 0, write1h: 500, write: null, output: 0 }, 0);
    expect(latestLabelSec(l, "claude", NOW)).toBe(3600);
  });
  it("a 1-hour label is 1 hour (the signal is still counted); Codex is 30 minutes", () => {
    expect(pick(effectiveTtl(gaps(12, 12), 3600, "claude", NOW))).toEqual([3600, "label_1h", 12, 12]);
    // Fable: what 5 minutes measured as is kept even when the latest label is 1 hour — the simulation uses it.
    expect([effectiveTtl(gaps(12, 12), 3600, "claude", NOW).fiveMinute, effectiveTtl(gaps(12, 0), 3600, "claude", NOW).fiveMinute, effectiveTtl(gaps(5, 5), 3600, "claude", NOW).fiveMinute]).toEqual([300, 3600, null]);
    expect(pick(effectiveTtl(gaps(12, 12), 1800, "codex", NOW))).toEqual([1800, "codex", 12, 12]);
  });
  it("a sample: a 5-minute write, 300 s < gap ≤ 3600 s, a context, ending in (to − 7 days, to]", () => {
    const edge = [gap(NOW, 300, C), gap(NOW, 3601, C), gap(NOW, 3600, C), gap(NOW, 301, C), gap(NOW, 1200, C, 3600), gap(NOW + 1, 1200, C),
      gap(NOW - 7 * DAY, 1200, C), gap(NOW - 7 * DAY + 1, 1200, C), [NOW, 1200, 0, "m", 300, "m", C, C, C] as GapEvent];
    expect(effectiveTtl(edge, 300, "claude", NOW)).toMatchObject({ sample: 3, misses: 3 });      // 3600, 301, and just inside 7 days
  });
  it("a miss: the write after the gap (measured, else estimated) is at least half the context", () => {
    const g = [gap(NOW, 1200, C / 2), gap(NOW, 1200, C / 2 - 1), gap(NOW, 1200, 1000, 300, null), [NOW, 1200, C, "m", 300, "m", C, null, C] as GapEvent];
    expect(effectiveTtl(g, 300, "claude", NOW)).toMatchObject({ sample: 4, misses: 2, rate: 0.5 });
  });
});

/** A one-session Claude ledger written with the 5-minute label: requests every `everyMin`, each 20 min apart gap. */
function fiveMinute(o: { gapsCount: number; rewritten: number; tail?: boolean }): Ledger {
  const ledger = emptyLedger();
  const file: FileCursor = ledger.files["a"] = { kind: "claude", ino: 1, offset: 0 };
  let t = NOW - 2 * DAY;
  const turn = (write: number): Turn => ({ t, model: "m", prompt: C, uncached: 0, read: C - write, write5m: write, write1h: 0, write: null, output: 0 });
  addTurn(ledger, file, turn(C), 0);
  for (let i = 0; i < o.gapsCount; i++) {
    t += 20 * MIN;
    addTurn(ledger, file, turn(i < o.rewritten ? C : 1000), 0);
  }
  return ledger;
}

describe("the report uses it", () => {
  const analyze = (l: Ledger) => analyzeLedger(l, { backend: "claude", from: NOW - 7 * DAY, to: NOW, rates });
  it("a 5-minute label that survives its gaps is simulated as 1 hour: far fewer pings, and the effective TTL is shown", () => {
    const a = analyze(fiveMinute({ gapsCount: 20, rewritten: 0 }));
    expect([a.ttlSec, a.effectiveTtl.ttlSec, a.effectiveTtl.basis, a.effectiveTtl.sample]).toEqual([300, 3600, "measured", 20]);
    expect(a.sim.pastTtl, "no 20-minute gap is past an hour").toBe(0);
    expect(a.sim.pings, "pinging every 54 min, not every 4.5 min, inside 20-minute gaps: none").toBe(0);
    expect(a.estimate).toBe(false);
  });
  it("a 5-minute label that really expires: switch to the 1-hour setting, not keep-warm; writes priced at the 5-minute rate", () => {
    const a = analyze(fiveMinute({ gapsCount: 20, rewritten: 20 }));
    expect([a.effectiveTtl.ttlSec, a.effectiveTtl.misses, a.recommendation]).toEqual([300, 20, { on: false, reason: "switch_to_1h" }]);
    expect(a.sim.expired).toBe(20);
    expect(a.sim.expiryCost, "each rewrite of C at write5m (1.25) − read (0.1)").toBeCloseTo(20 * (1.25 - 0.1), 6);
  });
  it("too few gaps, with an expiry: not enough evidence — said, and an estimate", () => {
    const a = analyze(fiveMinute({ gapsCount: 4, rewritten: 4 }));
    expect([a.effectiveTtl.ttlSec, a.effectiveTtl.basis, a.recommendation.reason, a.estimate]).toEqual([null, "insufficient", "insufficient_evidence", true]);
    expect(a.sim.pastTtl, "simulated with the label").toBe(4);
  });
  it("Fable: after a switch back to 1 hour, the 5-minute gaps are still judged by what 5 minutes measured as", () => {
    const expiring = fiveMinute({ gapsCount: 12, rewritten: 12 }), surviving = fiveMinute({ gapsCount: 12, rewritten: 0 });
    for (const l of [expiring, surviving]) {
      const file = l.files["a"]!;
      addTurn(l, file, { t: NOW - DAY, model: "m", prompt: C, uncached: 0, read: C - 1000, write5m: 0, write1h: 1000, write: null, output: 0 }, 0);   // now writes 1 h
    }
    const e = analyze(expiring), s = analyze(surviving);
    expect([e.ttlSec, e.effectiveTtl.basis, e.effectiveTtl.fiveMinute]).toEqual([3600, "label_1h", 300]);
    expect(e.sim.pastTtl, "twelve 20-minute gaps past a measured 5 minutes — not recast as 1 hour — and the day-long gap before the switch").toBe(13);
    expect(e.sim.expired).toBe(12);
    expect([s.effectiveTtl.fiveMinute, s.sim.pastTtl, s.estimate], "only the day-long gap is past a measured hour").toEqual([3600, 1, false]);
    const few = fiveMinute({ gapsCount: 4, rewritten: 4 });
    addTurn(few, few.files["a"]!, { t: NOW - DAY, model: "m", prompt: C, uncached: 0, read: C - 1000, write5m: 0, write1h: 1000, write: null, output: 0 }, 0);
    expect([analyze(few).effectiveTtl.basis, analyze(few).estimate], "1-hour now, but its 5-minute gaps had no evidence: an estimate").toEqual(["label_1h", true]);
  });
  it("an expiry on a 5-minute label measured as 1 hour is still priced at the 5-minute write rate", () => {
    const l = fiveMinute({ gapsCount: 12, rewritten: 0 });
    const file = l.files["a"]!, last = file.last!.t;
    addTurn(l, file, { t: last + 2 * H, model: "m", prompt: C, uncached: 0, read: 0, write5m: C, write1h: 0, write: null, output: 0 }, 0);   // 2 h later: rewritten
    const a = analyze(l);
    expect([a.effectiveTtl.fiveMinute, a.sim.pastTtl, a.sim.expired]).toEqual([3600, 1, 1]);
    expect(a.sim.expiryCost, "C at write5m (1.25) − read (0.1), not the 1-hour write rate").toBeCloseTo(1.25 - 0.1, 6);
  });
  it("the service's fleet row counts the instances to switch to 1 hour", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-2010-svc-"));
    try {
      const expiring = fiveMinute({ gapsCount: 12, rewritten: 12 }), surviving = fiveMinute({ gapsCount: 12, rewritten: 0 });
      writeFileSync(join(dir, "e.json"), JSON.stringify(expiring)); writeFileSync(join(dir, "s.json"), JSON.stringify(surviving));
      const inst = (name: string, f: string) => ({ name, backend: "claude-code", workingDirectory: join(dir, `w-${name}`), ledgerPath: join(dir, f), claudeConfigDir: join(dir, "none") });
      const svc = new CacheService({ instances: () => [inst("e", "e.json"), inst("s", "s.json")], claudeProjectsDir: () => join(dir, "none", "projects"), claudeKey: (d) => d,
        codexSessionsDir: () => join(dir, "none"), listRollouts: () => [], metaPath: join(dir, "meta.json"), now: () => NOW });
      // This report fixture has ledger cursors, not backing transcripts. Keep
      // catch-up from deleting them while report() reads the seeded history.
      await svc.stop();
      const r = await svc.report("7d");
      expect(r.instances.map((x) => [x.name, x.analysis?.recommendation.reason])).toEqual([["e", "switch_to_1h"], ["s", "never_expired"]]);
      expect([r.fleet.switchTo1h, r.fleet.analysed]).toEqual([1, 2]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("the 5m / 1h write mix in the window", () => {
    const l = fiveMinute({ gapsCount: 3, rewritten: 1 });
    const file = l.files["a"]!;
    addTurn(l, file, { t: NOW - DAY, model: "m", prompt: C, uncached: 0, read: 0, write5m: 0, write1h: 500, write: null, output: 0 }, 0);
    expect(analyze(l).writeMix).toEqual({ "5m": C + C + 1000 + 1000, "1h": 500 });
  });
});
