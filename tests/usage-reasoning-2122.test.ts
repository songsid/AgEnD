/**
 * #2122 §10.3 step 1: the usage ledger keeps reasoning, a part of output, so the report can give tokscale's daily-row
 * units: output without reasoning, reasoning beside it. Amounts don't move (the whole output is priced once).
 *
 * Downgrade (Fable #2604 P1): published readers keep a totals array only when it has exactly 7 entries, and rewrite
 * what they revived. So the totals stay 7 entries on disk and reasoning sits beside them (`rs` per hour and source,
 * `r` per day row), where an older reader ignores it: the totals survive a downgrade, only the reasoning split is lost.
 */
import { describe, expect, it } from "vitest";
import { addTurn, codexLine, emptyLedger, reviveLedger, type FileCursor, type Ledger } from "../src/cache-ledger.js";
import { emptyDays, foldHours, hourSources, reviveDays, type UsageDays } from "../src/usage-rollup.js";
import { buildUsageReport, type UsageInstanceInput } from "../src/usage-report.js";
import { ratesFor } from "../src/cache-prices.js";

const HOUR = 3_600_000, DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 18, 12);
const H = Date.UTC(2026, 9, 17, 9);
const MK = "gpt-5.6-sol|0";
const line = (o: object) => { const whole = Buffer.from(JSON.stringify(o)); return { whole, length: whole.length }; };
const tokenCount = (u: object, total: number) => line({ timestamp: new Date(H + 60_000).toISOString(), type: "event_msg",
  payload: { type: "token_count", info: { last_token_usage: u, total_token_usage: { total_tokens: total } } } });

function codexLedger(): Ledger {
  const l = emptyLedger(), file: FileCursor = { kind: "codex", ino: 1, offset: 0, model: "gpt-5.6-sol" };
  const turn = codexLine(tokenCount({ input_tokens: 10_000, cached_input_tokens: 8000, output_tokens: 900, reasoning_output_tokens: 600, total_tokens: 10_900 }, 10_900), file)!;
  addTurn(l, file, turn, 0, "unrecorded");
  return l;
}
const covered = (): UsageDays => ({ ...emptyDays(), coverage: [[NOW - 31 * DAY, NOW]] });
const inst = (l: Ledger, days = covered()): UsageInstanceInput => ({ name: "indexer", backend: "codex", team: null, status: "ok", ledger: l, days });
const report = (...i: UsageInstanceInput[]) => buildUsageReport({ now: NOW, zone: "UTC", range: { kind: "7d" }, group: "instance", messages: [],
  scanning: { active: false, caughtUp: true, pendingBytes: 0, pendingFiles: 0 }, instances: i });

/**
 * The published readers' checks, pinned (cache-ledger.ts reviveLedger and usage-rollup.ts reviveDays as 2.3.1 and
 * 2.3.2-beta.4 ship them): a totals array is kept only with exactly 7 finite entries; anything else is dropped.
 */
const publishedTotals = (t: unknown) => Array.isArray(t) && t.length === 7;
function publishedReviveLedger(raw: any): any {
  const hours: any = {};
  for (const [k, v] of Object.entries<any>(raw.hours ?? {})) {
    const m: any = {};
    for (const [mk, tot] of Object.entries(v.m ?? {})) if (publishedTotals(tot)) m[mk] = tot;
    const src: any = {};
    for (const [sk, sm] of Object.entries<any>(v.src ?? {})) {
      const into: any = {};
      for (const [mk, tot] of Object.entries(sm)) if (publishedTotals(tot) && (tot as number[]).every(n => Number.isFinite(n))) into[mk] = tot;
      src[sk] = into;
    }
    hours[k] = { m, g: v.g, ...(Object.keys(src).length ? { src } : {}) };
  }
  return { v: 2, files: raw.files, hours, gaps: raw.gaps };
}
function publishedReviveDays(raw: any): any {
  const rows = [];
  for (const row of raw.rows) {
    const m: any = {};
    for (const [k, t] of Object.entries(row.m ?? {})) if (publishedTotals(t) && (t as number[]).every(n => Number.isFinite(n))) m[k] = t;
    rows.push({ date: row.date, zone: row.zone, be: row.be, pf: row.pf, m });
  }
  return { v: 1, checkpoint: raw.checkpoint, rows, coverage: raw.coverage };
}

describe("Codex: reasoning_output_tokens is a part of output_tokens", () => {
  it("is read as the turn's reasoning, capped at its output", () => {
    const file: FileCursor = { kind: "codex", ino: 1, offset: 0, model: "gpt-5.6-sol" };
    expect(codexLine(tokenCount({ input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 30 }, 150), file)).toMatchObject({ output: 50, reasoning: 30 });
    expect(codexLine(tokenCount({ input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 80 }, 160), file)).toMatchObject({ output: 50, reasoning: 50 });
    expect(codexLine(tokenCount({ input_tokens: 100, output_tokens: 50 }, 170), file)).toMatchObject({ output: 50, reasoning: 0 });
  });
  it("two requests in one hour: their reasoning adds up", () => {
    const l = codexLedger(), file: FileCursor = { kind: "codex", ino: 1, offset: 0, model: "gpt-5.6-sol" };
    addTurn(l, file, codexLine(tokenCount({ input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 40 }, 20_000), file)!, 0, "unrecorded");
    expect(l.hours[String(H)]!.rs).toEqual({ "codex:unrecorded": { [MK]: 640 } });
  });
  it("the hour keeps 7 totals, and the reasoning beside them under its source", () => {
    const hour = codexLedger().hours[String(H)]!;
    expect(hour.m[MK]).toEqual([1, 2000, 8000, 0, 0, 0, 900]);
    expect(hour.rs).toEqual({ "codex:unrecorded": { [MK]: 600 } });
    expect(hourSources(hour)).toEqual([{ backend: "codex", profile: "unrecorded", m: { [MK]: [1, 2000, 8000, 0, 0, 0, 900] }, r: { [MK]: 600 }, c: {} }]);
  });
});

describe("the report: tokscale's units, the same amount", () => {
  it("output is net of reasoning, reasoning is beside it, and the total and the amount are unchanged", () => {
    const r = report(inst(codexLedger()));
    const row = r.rows[0]!;
    expect([row.input, row.output, row.reasoning, row.cacheRead, row.reasoningReported]).toEqual([2000, 300, 600, 8000, true]);
    expect(row.total).toBe(2000 + 900 + 8000);
    const rates = ratesFor("gpt-5.6-sol", 0)!;
    expect(row.amount).toBeCloseTo((2000 * rates.input + 8000 * rates.read + 900 * rates.output) / 1_000_000, 12);
    expect([r.totals.output, r.totals.reasoning, r.totals.total, r.totals.reasoningReported]).toEqual([300, 600, row.total, true]);
    expect(r.daily.map(d => [d.output, d.reasoning, d.reasoningReported])).toEqual([[300, 600, true]]);
  });
  it("the same after the ledger's round trip, and after the hour is folded into the rollup and read back", () => {
    const l = reviveLedger(JSON.parse(JSON.stringify(codexLedger())));
    expect(report(inst(l)).rows[0]).toMatchObject({ output: 300, reasoning: 600 });
    const days = covered();
    foldHours(days, l, H + 2 * HOUR, "UTC");
    delete l.hours[String(H)];
    const back = reviveDays(JSON.parse(JSON.stringify(days)));
    expect(back.rows[0]).toMatchObject({ m: { [MK]: [1, 2000, 8000, 0, 0, 0, 900] }, r: { [MK]: 600 } });
    expect(report(inst(l, back)).rows[0]).toMatchObject({ output: 300, reasoning: 600 });
  });
  it("a backend that reports no reasoning: 0, and said to be not reported (the page shows —)", () => {
    const l = emptyLedger();
    addTurn(l, { kind: "claude", ino: 1, offset: 0 }, { t: H, model: "claude-opus-4-5", prompt: 1000, uncached: 100, read: 800, write5m: 100, write1h: 0, write: null, output: 50 }, 0, "default");
    const r = report({ ...inst(l), name: "billing", backend: "claude-code" });
    expect(r.rows[0]).toMatchObject({ output: 50, reasoning: 0, reasoningReported: false });
    expect(r.daily[0]).toMatchObject({ reasoning: 0, reasoningReported: false });
  });
  it("reasoning that names no source or no totals is not revived", () => {
    const raw = JSON.parse(JSON.stringify(codexLedger()));
    raw.hours[String(H)].rs = { "codex:unrecorded": { [MK]: 600, "ghost|0": 5, bad: "x" }, "codex:elsewhere": { [MK]: 7 } };
    expect(reviveLedger(raw).hours[String(H)]!.rs).toEqual({ "codex:unrecorded": { [MK]: 600 } });
    const days = covered();
    foldHours(days, codexLedger(), H + 2 * HOUR, "UTC");
    const rawDays = JSON.parse(JSON.stringify(days));
    rawDays.rows[0].r = { [MK]: 600, "ghost|0": 5, neg: -1 };
    expect(reviveDays(rawDays).rows[0]!.r).toEqual({ [MK]: 600 });
  });
});

describe("a downgrade keeps the totals (Fable #2604 P1)", () => {
  it("what this version writes, read and rewritten by a published reader, still holds every total; only the reasoning split is lost", () => {
    const l = codexLedger(), days = covered();
    foldHours(days, codexLedger(), H + 2 * HOUR, "UTC");
    const oldLedger = JSON.parse(JSON.stringify(publishedReviveLedger(JSON.parse(JSON.stringify(l)))));
    const oldDays = JSON.parse(JSON.stringify(publishedReviveDays(JSON.parse(JSON.stringify(days)))));
    expect(oldLedger.hours[String(H)].m).toEqual({ [MK]: [1, 2000, 8000, 0, 0, 0, 900] });
    expect(oldLedger.hours[String(H)].src).toEqual({ "codex:unrecorded": { [MK]: [1, 2000, 8000, 0, 0, 0, 900] } });
    expect(oldDays.rows[0].m).toEqual({ [MK]: [1, 2000, 8000, 0, 0, 0, 900] });
    // Back on this version: the same tokens and amount, with the reasoning back inside output.
    const before = report(inst(l)).rows[0]!, after = report(inst(reviveLedger(oldLedger))).rows[0]!;
    expect([after.input, after.output + after.reasoning, after.cacheRead, after.total, after.amount]).toEqual([before.input, before.output + before.reasoning, before.cacheRead, before.total, before.amount]);
    expect(after.reasoning).toBe(0);
    expect(reviveDays(oldDays).rows[0]!.m).toEqual({ [MK]: [1, 2000, 8000, 0, 0, 0, 900] });
  });
});
