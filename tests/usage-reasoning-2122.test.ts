/**
 * #2122 §10.3 step 1: the usage ledger keeps reasoning as its own bucket, a part of output, so the report can give
 * tokscale's daily-row units: output without reasoning, reasoning beside it. Amounts don't move (the whole output is
 * priced at the output rate once), and ledgers and rollups written before the bucket read back with reasoning 0.
 */
import { describe, expect, it } from "vitest";
import { addTurn, codexLine, emptyLedger, reviveLedger, reviveTotals, type FileCursor } from "../src/cache-ledger.js";
import { emptyDays, foldHours, hourSources, reviveDays } from "../src/usage-rollup.js";
import { buildUsageReport, type UsageInstanceInput } from "../src/usage-report.js";
import { ratesFor } from "../src/cache-prices.js";

const HOUR = 3_600_000, DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 18, 12);
const H = Date.UTC(2026, 9, 17, 9);
const MK = "gpt-5.6-sol|0";
const line = (o: object) => { const whole = Buffer.from(JSON.stringify(o)); return { whole, length: whole.length }; };
const tokenCount = (u: object, total: number) => line({ timestamp: new Date(H + 60_000).toISOString(), type: "event_msg",
  payload: { type: "token_count", info: { last_token_usage: u, total_token_usage: { total_tokens: total } } } });

function codexLedger(): ReturnType<typeof emptyLedger> {
  const l = emptyLedger(), file: FileCursor = { kind: "codex", ino: 1, offset: 0, model: "gpt-5.6-sol" };
  const turn = codexLine(tokenCount({ input_tokens: 10_000, cached_input_tokens: 8000, output_tokens: 900, reasoning_output_tokens: 600, total_tokens: 10_900 }, 10_900), file)!;
  addTurn(l, file, turn, 0, "unrecorded");
  return l;
}
const inst = (l: ReturnType<typeof emptyLedger>, days = { ...emptyDays(), coverage: [[NOW - 31 * DAY, NOW]] as Array<[number, number]> }): UsageInstanceInput =>
  ({ name: "indexer", backend: "codex", team: null, status: "ok", ledger: l, days });
const report = (i: UsageInstanceInput) => buildUsageReport({ now: NOW, zone: "UTC", range: { kind: "7d" }, group: "instance", messages: [],
  scanning: { active: false, caughtUp: true, pendingBytes: 0, pendingFiles: 0 }, instances: [i] });

describe("Codex: reasoning_output_tokens is a part of output_tokens", () => {
  it("is read as the turn's reasoning, capped at its output", () => {
    const file: FileCursor = { kind: "codex", ino: 1, offset: 0, model: "gpt-5.6-sol" };
    expect(codexLine(tokenCount({ input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 30 }, 150), file)).toMatchObject({ output: 50, reasoning: 30 });
    expect(codexLine(tokenCount({ input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 80 }, 160), file)).toMatchObject({ output: 50, reasoning: 50 });
    expect(codexLine(tokenCount({ input_tokens: 100, output_tokens: 50 }, 170), file)).toMatchObject({ output: 50, reasoning: 0 });
  });
  it("the ledger's hour keeps it as the 8th total, under the source too", () => {
    const l = codexLedger();
    expect(l.hours[String(H)]!.m[MK]).toEqual([1, 2000, 8000, 0, 0, 0, 900, 600]);
    expect(hourSources(l.hours[String(H)]!)).toEqual([{ backend: "codex", profile: "unrecorded", m: { [MK]: [1, 2000, 8000, 0, 0, 0, 900, 600] } }]);
  });
});

describe("the report: tokscale's units, the same amount", () => {
  it("output is net of reasoning, reasoning is beside it, and the total and the amount are unchanged", () => {
    const r = report(inst(codexLedger()));
    const row = r.rows[0]!;
    expect([row.input, row.output, row.reasoning, row.cacheRead]).toEqual([2000, 300, 600, 8000]);
    expect(row.total).toBe(2000 + 900 + 8000);
    const rates = ratesFor("gpt-5.6-sol", 0)!;
    expect(row.amount).toBeCloseTo((2000 * rates.input + 8000 * rates.read + 900 * rates.output) / 1_000_000, 12);
    expect([r.totals.output, r.totals.reasoning, r.totals.total]).toEqual([300, 600, row.total]);
    expect(r.daily.map(d => [d.output, d.reasoning])).toEqual([[300, 600]]);
  });
  it("the same after the hour is folded into the rollup", () => {
    const l = codexLedger(), days = { ...emptyDays(), coverage: [[NOW - 31 * DAY, NOW]] as Array<[number, number]> };
    foldHours(days, l, H + 2 * HOUR, "UTC");
    delete l.hours[String(H)];
    const back = reviveDays(JSON.parse(JSON.stringify(days)));
    expect(back.rows[0]!.m[MK]).toEqual([1, 2000, 8000, 0, 0, 0, 900, 600]);
    const row = report(inst(l, back)).rows[0]!;
    expect([row.output, row.reasoning]).toEqual([300, 600]);
  });
});

describe("written before the bucket: 7 totals read back with reasoning 0", () => {
  it("a ledger hour and a rollup row", () => {
    const old = { v: 2, files: {}, gaps: [], hours: { [String(H)]: { m: { [MK]: [1, 2000, 8000, 0, 0, 0, 900] }, g: [0, 0, 0, 0, 0, 0, 0],
      src: { "codex:unrecorded": { [MK]: [1, 2000, 8000, 0, 0, 0, 900] } } } } };
    const l = reviveLedger(old);
    expect(l.hours[String(H)]!.m[MK]).toEqual([1, 2000, 8000, 0, 0, 0, 900, 0]);
    expect(hourSources(l.hours[String(H)]!)).toHaveLength(1);              // no phantom "unknown" source from the padding
    const d = reviveDays({ v: 1, checkpoint: H, coverage: [], rows: [{ date: "2026-10-17", zone: "UTC", be: "codex", pf: "unrecorded", m: { [MK]: [1, 2000, 8000, 0, 0, 0, 900] } }] });
    expect(d.rows[0]!.m[MK]).toEqual([1, 2000, 8000, 0, 0, 0, 900, 0]);
    expect(report(inst(l)).rows[0]).toMatchObject({ output: 900, reasoning: 0 });
  });
  it("anything else is dropped, as before", () => {
    for (const bad of [[1, 2, 3], [1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 5, 6, Number.NaN], "x", null]) expect(reviveTotals(bad)).toBeNull();
    expect(reviveTotals([1, 2, 3, 4, 5, 6, 7])).toEqual([1, 2, 3, 4, 5, 6, 7, 0]);
  });
});
