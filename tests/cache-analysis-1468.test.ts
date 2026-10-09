/**
 * #1468: the prompt-cache expiry analysis.
 * - Prices: one table, exact keys, the long-prompt rows.
 * - The keep-warm simulation on hand-built gap series — all short, one long overnight gap, a daily schedule, a gap
 *   that never ends in a request, a cache that outlived its TTL — for both TTLs (Claude 1 h, Codex 30 min).
 * - Reading real transcript shapes (redacted fixtures): Claude Code (one message over several lines, a subagent's
 *   request, no write split) and Codex (a re-announced total, a rollout with and without the write field).
 * - The scanner: long lines by their two ends, a pass that stops on a line start, an unfinished last line.
 * - The service: per-instance files, a persisted cursor (a restart does not count twice), a replaced file, the
 *   statuses; a 100+ MB transcript read in bounded passes with the event loop measured.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, openSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PRICES_CHECKED, priceKey, ratesFor, type Rates } from "../src/cache-prices.js";
import { addTurn, claudeLine, codexLine, emptyLedger, type FileCursor, type Ledger, type TranscriptKind, type Turn } from "../src/cache-ledger.js";
import { analyzeLedger, pingsBetween, simulate, sessionTails } from "../src/cache-analysis.js";
import { ratesFor as listedRates } from "../src/cache-prices.js";
import { objectAt, scanJsonl, type ScanLine } from "../src/cache-scan.js";
import { CacheService, type CacheInstance } from "../src/cache-service.js";

const FIX = join(process.cwd(), "tests", "fixtures", "cache-1468");
// Round rates, so a context of a million tokens costs its multiplier: write 2 (1 h) / 1.25, read 0.1.
const R: Rates = { input: 1, read: 0.1, write5m: 1.25, write1h: 2, write: 1.25, output: 5 };
const rates = (): Rates => R;
const C = 1_000_000;
const H = 3_600_000, T0 = Date.UTC(2026, 9, 1, 9, 0, 0);

describe("prices", () => {
  it("one table, checked on a date; exact keys (opus-5 never prices opus-5-5); date and [1m] suffixes", () => {
    expect(PRICES_CHECKED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(priceKey("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(priceKey("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
    expect(priceKey("claude-opus-4-5-20251101")).toBe("claude-opus-4-5");
    expect(ratesFor("claude-opus-5")!.read).toBe(0.5);
    expect(ratesFor("claude-opus-5-5")).toMatchObject({ input: 4, read: 0.2, write5m: 5, write1h: 8, output: 20 });
    expect(ratesFor("claude-sonnet-5-5")).toMatchObject({ input: 2, read: 0.1, write1h: 4 });
    expect(ratesFor("gpt-6.1-sol")).toMatchObject({ input: 2, read: 0.1, write: 2.5, output: 10 });
    expect(priceKey("gpt-reserve")).toBeNull();
    // A model the table does not know never borrows a shorter key's prices.
    expect(priceKey("claude-opus-5-6")).toBeNull();
    expect(priceKey("gpt-6-sol-mini")).toBeNull();
    expect(priceKey("constructor")).toBeNull();
    expect(ratesFor(undefined)).toBeNull();
  });
  it("the long-prompt rows: Haiku 5.5 over 100K tokens, OpenAI over 272K", () => {
    expect(ratesFor("claude-haiku-5-5", 100_000)!.input).toBe(0.1);
    expect(ratesFor("claude-haiku-5-5", 100_001)!.input).toBe(0.5);
    expect(ratesFor("gpt-6.1-sol", 272_000)!.read).toBe(0.1);
    expect(ratesFor("gpt-6.1-sol", 272_001)).toMatchObject({ input: 4, read: 0.2, write: 5 });
    expect(ratesFor("claude-opus-5-5", 900_000)!.input).toBe(4);       // the full window at standard price
  });
});

/** A ledger from request times (ms) in one session: each request carries a context of C; after a gap past `ttlSec`
 *  it rewrites the whole context (unless `survives`), otherwise only a little. */
function series(kind: TranscriptKind, times: number[], ttlSec: number, o: { survives?: boolean; ledger?: Ledger; file?: string } = {}): Ledger {
  const ledger = o.ledger ?? emptyLedger();
  const file: FileCursor = ledger.files[o.file ?? "a"] ??= { kind, ino: 1, offset: 0 };
  let prev: number | null = null;
  for (const t of times) {
    const gap = prev === null ? Infinity : (t - prev) / 1000;
    const rewrite = gap > ttlSec && !o.survives ? C : 1000;
    const turn: Turn = kind === "claude"
      ? { t, model: "m", prompt: C, uncached: 0, read: C - rewrite, write5m: 0, write1h: rewrite, write: null, output: 0 }
      : { t, model: "gpt-6.1-sol", prompt: C, uncached: rewrite, read: C - rewrite, write5m: 0, write1h: 0, write: 0, output: 0 };
    addTurn(ledger, file, turn, 0);
    prev = t;
  }
  return ledger;
}
// Each gap is judged by its own session's TTL (from the ledger); Codex series record writes as 0, so they are estimates.
const sim = (l: Ledger, _ttlSec: number, from: number, to: number) => simulate(l.gaps, sessionTails(l, to),
  { rates, from, to, measured: Object.values(l.files).every((f) => f.kind === "claude") || !!l.writesSeen });

describe("keep-warm simulation on hand-built gap series", () => {
  it("pingsBetween: pings at t + k·I inside the window", () => {
    expect(pingsBetween(0, 10_000_000, 3_240_000, 0, 10_000_000)).toBe(3);   // 3240, 6480, 9720 s
    expect(pingsBetween(0, 10_000_000, 3_240_000, 5_000_000, 10_000_000)).toBe(2);
    expect(pingsBetween(0, 3_000_000, 3_240_000, 0, 10_000_000)).toBe(0);
    // The moment the gap ends counts (floor(gap / I)); so do both window edges.
    expect(pingsBetween(0, 3_240_000, 3_240_000, 0, 10_000_000)).toBe(1);
    expect(pingsBetween(0, 10_000_000, 3_240_000, 3_240_000, 6_480_000)).toBe(2);
  });

  it("all short gaps: nothing expires, nothing to ping — for both TTLs", () => {
    const times = Array.from({ length: 61 }, (_, k) => T0 + k * 120_000);
    for (const [kind, ttl] of [["claude", 3600], ["codex", 1800]] as const) {
      const l = series(kind, times, ttl);
      const r = sim(l, ttl, T0, times.at(-1)!);
      expect(r, kind).toMatchObject({ pastTtl: 0, expired: 0, pings: 0, tailPings: 0, expiryCost: 0, net: 0 });
      expect(analyzeLedger(l, { backend: kind, from: T0, to: times.at(-1)!, rates }).recommendation, kind).toEqual({ on: false, reason: "never_expired" });
    }
  });

  it("one long overnight gap that ends in a request: 1 h TTL — pings cost less than the rewrite (on)", () => {
    const times = [T0, T0 + 60_000, T0 + 120_000, T0 + 120_000 + 10 * H];
    const l = series("claude", times, 3600);
    const r = sim(l, 3600, T0, times.at(-1)!);
    // I = 3600 − 360 = 3240 s → floor(36000 / 3240) = 11 pings of C at 0.1; the rewrite costs C × (2 − 0.1).
    expect(r.pastTtl).toBe(1); expect(r.expired).toBe(1); expect(r.rewriteTokens).toBe(C);
    expect(r.pings).toBe(11);
    expect(r.pingCost).toBeCloseTo(1.1, 10);
    expect(r.expiryCost).toBeCloseTo(1.9, 10);
    expect(r.net).toBeCloseTo(0.8, 10);
    expect(analyzeLedger(l, { backend: "claude", from: T0, to: times.at(-1)!, rates }).recommendation).toEqual({ on: true, reason: "saves" });
  });

  it("the same night on Codex's 30-minute TTL: twice the pings, a cheaper write — off", () => {
    const times = [T0, T0 + 60_000, T0 + 120_000, T0 + 120_000 + 10 * H];
    const l = series("codex", times, 1800);
    const r = sim(l, 1800, T0, times.at(-1)!);
    // I = 1620 s → 22 pings (2.2); the rewrite at 1.25 − 0.1 = 1.15.
    expect(r.pings).toBe(22);
    expect(r.pingCost).toBeCloseTo(2.2, 10);
    expect(r.expiryCost).toBeCloseTo(1.15, 10);
    expect(r.net).toBeCloseTo(-1.05, 10);
    expect(analyzeLedger(l, { backend: "codex", from: T0, to: times.at(-1)!, rates }).recommendation).toEqual({ on: false, reason: "costs_more", pingsPerExpiry: 22 });
  });

  it("a daily schedule (one request a day) and the idle tail after the last: keep-warm burns 26 pings a day — off", () => {
    const times = Array.from({ length: 7 }, (_, k) => T0 + k * 24 * H);
    const to = times.at(-1)! + 15 * H;
    const l = series("claude", times, 3600);
    const r = sim(l, 3600, T0, to);
    expect(r.expired).toBe(6);
    expect(r.pings).toBe(6 * 26);                       // floor(86400 / 3240) = 26 per day
    expect(r.tailPings).toBe(16);                       // floor(54000 / 3240): after the last run, nothing reads it
    expect(r.tailCost).toBeCloseTo(1.6, 10);
    expect(r.net).toBeCloseTo(6 * 1.9 - 6 * 2.6 - 1.6, 10);
    expect(analyzeLedger(l, { backend: "claude", from: T0, to, rates }).recommendation).toEqual({ on: false, reason: "costs_more", pingsPerExpiry: 29 });
  });

  it("a gap that never ends in a request: pure loss, for both TTLs", () => {
    const times = [T0, T0 + 60_000, T0 + 120_000];
    const to = T0 + 120_000 + 10 * H;
    for (const [kind, ttl, pings] of [["claude", 3600, 11], ["codex", 1800, 22]] as const) {
      const r = sim(series(kind, times, ttl), ttl, T0, to);
      expect(r.tailPings, kind).toBe(pings);
      expect(r.net, kind).toBeCloseTo(-pings * 0.1, 10);
      expect(r.expired, kind).toBe(0);
    }
  });

  it("a session's tail ends where the next session starts", () => {
    const l = series("claude", [T0, T0 + 60_000], 3600, { file: "a" });
    series("claude", [T0 + 60_000 + 5 * H, T0 + 60_000 + 5 * H + 60_000], 3600, { ledger: l, file: "b" });
    const to = T0 + 60_000 + 5 * H + 60_000;
    const tails = sessionTails(l, to);
    expect(tails.map((x) => x.until)).toEqual([T0 + 60_000 + 5 * H, to]);
    expect(sim(l, 3600, T0, to).tailPings).toBe(5);         // floor(18000 / 3240), then nothing after the last
  });

  it("a cache that outlived its TTL (Codex): past the TTL, not expired — the pings are only cost", () => {
    const times = [T0, T0 + 60_000, T0 + 60_000 + 72 * 60_000];
    const r = sim(series("codex", times, 1800, { survives: true }), 1800, T0, times.at(-1)!);
    expect(r).toMatchObject({ pastTtl: 1, expired: 0, pings: 2 });
    expect(r.net).toBeCloseTo(-0.2, 10);
  });

  it("only the window counts: a gap that ended before it is not in it", () => {
    const times = [T0, T0 + 10 * H, T0 + 10 * H + 60_000, T0 + 20 * H];
    const r = sim(series("claude", times, 3600), 3600, T0 + 12 * H, T0 + 20 * H);
    expect(r.expired).toBe(1);
  });

  it("the TTL: Claude's write split decides (5-minute writes → 5 min); Codex is 30 min", () => {
    const l = emptyLedger();
    const f: FileCursor = l.files.a = { kind: "claude", ino: 1, offset: 0 };
    addTurn(l, f, { t: T0, model: "m", prompt: C, uncached: 0, read: 0, write5m: C, write1h: 0, write: null, output: 0 }, 0);
    addTurn(l, f, { t: T0 + 1000, model: "m", prompt: C, uncached: 0, read: C, write5m: 10, write1h: 0, write: null, output: 0 }, 0);
    expect(analyzeLedger(l, { backend: "claude", from: T0, to: T0 + H, rates }).ttlSec).toBe(300);
    expect(analyzeLedger(series("claude", [T0], 3600), { backend: "claude", from: T0, to: T0 + H, rates }).ttlSec).toBe(3600);
    expect(analyzeLedger(series("codex", [T0], 1800), { backend: "codex", from: T0, to: T0 + H, rates }).ttlSec).toBe(1800);
  });

  it("too few requests: no recommendation either way", () => {
    expect(analyzeLedger(series("claude", [T0, T0 + 10 * H], 3600), { backend: "claude", from: T0, to: T0 + 10 * H, rates }).recommendation)
      .toEqual({ on: false, reason: "quiet" });
  });
});

describe("costs and estimates", () => {
  it("total cost and the expiry share at list price; a model not in the table → input-price units, no dollars", () => {
    const l = series("claude", [T0, T0 + 60_000, T0 + 120_000, T0 + 120_000 + 10 * H], 3600);
    const a = analyzeLedger(l, { backend: "claude", from: T0, to: T0 + 11 * H, rates });
    // Writes: C (first) + C (after the night) + 2 × 1000, at 2; reads: 2 × (C − 1000), at 0.1.
    expect(a.totalCost).toBeCloseTo(((2 * C + 2000) * 2 + 2 * (C - 1000) * 0.1) / 1e6, 10);
    expect(a.share).toBeCloseTo(1.9 / a.totalCost, 10);
    expect(a.priced).toBe(true);
    const unknown = analyzeLedger(l, { backend: "claude", from: T0, to: T0 + 11 * H });   // the real table: model "m" is not in it
    expect(unknown.priced).toBe(false);
    expect(unknown.sim.expiryCost).toBeCloseTo(1.9, 10);                                    // units: write 2, read 0.1
  });
  it("Codex with no recorded writes: an estimate, its uncached input priced as written; a recorded write ends the estimate", () => {
    const l = series("codex", [T0, T0 + 60_000, T0 + 120_000, T0 + 10 * H], 1800);
    const a = analyzeLedger(l, { backend: "codex", from: T0, to: T0 + 11 * H });
    expect(a.estimate).toBe(true);
    const r = ratesFor("gpt-6.1-sol", C)!;
    expect(r.input).toBe(4);                                                  // a million-token prompt: the long-context row
    // Uncached: C (first) + 2 × 1000 + C (after the gap), all at the write rate; reads at the read rate.
    expect(a.totalCost).toBeCloseTo(((2 * C + 2000) * r.write + 2 * (C - 1000) * r.read) / 1e6, 10);
    l.writesSeen = true;
    expect(analyzeLedger(l, { backend: "codex", from: T0, to: T0 + 11 * H }).estimate).toBe(false);
  });
});

// ── Reading transcripts ──
async function readAll(path: string, kind: TranscriptKind) {
  const ledger = emptyLedger();
  const file: FileCursor = { kind, ino: 1, offset: 0 };
  const turns: Turn[] = [];
  const res = await scanJsonl(path, 0, { maxBytes: Number.MAX_SAFE_INTEGER }, (line) => {
    const turn = kind === "claude" ? claudeLine(line, file) : codexLine(line, file);
    if (turn) { turns.push(turn); addTurn(ledger, file, turn, 0); }
  });
  return { ledger, file, turns, res };
}

describe("real transcript shapes (redacted fixtures)", () => {
  it("Claude Code: one message over two lines counted once, a subagent's request skipped, the write split kept", async () => {
    const { turns, ledger } = await readAll(join(FIX, "claude-transcript.jsonl"), "claude");
    expect(turns.map((x) => new Date(x.t).toISOString().slice(11, 19))).toEqual(["09:00:05", "09:00:20", "11:05:00", "11:06:00"]);
    expect(turns[0]).toMatchObject({ model: "claude-opus-5-5", prompt: 20_003, uncached: 3, read: 0, write1h: 20_000, write5m: 0, output: 120 });
    expect(turns[3]).toMatchObject({ write5m: 100, write1h: 0 });          // no split recorded: a 5-minute write
    // The two-hour gap: the context the previous request left (20,502 + 80) and what the next one wrote.
    // [end, gap, context left cached, its model, its TTL, model after, prompt after, measured write, estimated write]
    expect(ledger.gaps).toEqual([[turns[2]!.t, 7480, 20_582, "claude-opus-5-5", 3600, "claude-opus-5-5", 20_804, 20_800, 20_800]]);
  });

  it("Codex 0.160: the model from turn_context, a re-announced total skipped, writes recorded as 0 → the uncached input", async () => {
    const { turns, ledger } = await readAll(join(FIX, "codex-rollout.jsonl"), "codex");
    expect(turns).toHaveLength(4);
    expect(turns[0]).toMatchObject({ model: "gpt-6.1-sol", prompt: 14_949, read: 11_008, uncached: 3_941, write: 0, output: 147 });
    expect(ledger.writesSeen).toBeUndefined();
    // The write field says 0 (measured) and the uncached input is the estimate; this instance never recorded a write.
    expect(ledger.gaps.map((g) => [g[1], g[2], g[4], g[7], g[8]])).toEqual([[4320, 16_952, 1800, 0, 2_549], [36_000, 56_454, 1800, 0, 94_592]]);
    const a = analyzeLedger(ledger, { backend: "codex", from: turns[0]!.t, to: turns[3]!.t });
    expect(a).toMatchObject({ ttlSec: 1800, estimate: true, priced: true });
    expect(a.sim).toMatchObject({ pastTtl: 2, expired: 1, rewriteTokens: 56_454 });   // the 72-minute gap kept its cache
  });

  it("Codex without the write field at all (older CLI): write unknown, the same estimate", async () => {
    const { turns } = await readAll(join(FIX, "codex-rollout-no-write-field.jsonl"), "codex");
    expect(turns.map((x) => [x.model, x.write, x.uncached])).toEqual([["gpt-5.6-sol", null, 3_941], ["gpt-5.6-sol", null, 30_000]]);
  });
});

describe("the scanner", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cache-scan-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("a pass stops on a line start past maxBytes and resumes there; an unfinished last line waits", async () => {
    const p = join(dir, "a.jsonl");
    const line = (k: number) => `{"k":${k},"pad":"${"x".repeat(80)}"}\n`;
    writeFileSync(p, Array.from({ length: 10 }, (_, k) => line(k)).join("") + "{\"k\":10");
    const seen: number[] = [];
    const on = (l: ScanLine) => { if ("whole" in l) seen.push(JSON.parse(l.whole.toString()).k); };
    // Physically read: chunks of 64 up to the first line end at or past 300 bytes read.
    const first = await scanJsonl(p, 0, { maxBytes: 300, chunkBytes: 64 }, on);
    expect(seen).toEqual([0, 1, 2]);
    expect(first.offset).toBe(line(0).length * 3);
    expect(first.done).toBe(false);
    const second = await scanJsonl(p, first.offset, { maxBytes: 1e9, chunkBytes: 64 }, on);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(second.offset).toBe(line(0).length * 10);                         // not past the unfinished line
    appendFileSync(p, "}\n");
    await scanJsonl(p, second.offset, { maxBytes: 1e9 }, on);
    expect(seen.at(-1)).toBe(10);
  });

  it("a line longer than wholeUpTo arrives as its two ends, and a Claude request on one is still read", async () => {
    const p = join(dir, "long.jsonl");
    const usage = { input_tokens: 5, cache_read_input_tokens: 70_000, cache_creation_input_tokens: 300, cache_creation: { ephemeral_1h_input_tokens: 300, ephemeral_5m_input_tokens: 0 }, output_tokens: 9 };
    const big = JSON.stringify({ parentUuid: null, isSidechain: false, message: { model: "claude-sonnet-5-5", id: "msg_big", type: "message", role: "assistant",
      content: [{ type: "text", text: "y".repeat(3 * 1024 * 1024) }], usage }, type: "assistant", uuid: "u", timestamp: "2026-10-08T10:00:00.000Z" });
    const user = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "z".repeat(5 * 1024 * 1024) }] }, timestamp: "2026-10-08T10:00:01.000Z" });
    writeFileSync(p, `${big}\n${user}\n`);
    const lines: ScanLine[] = [];
    await scanJsonl(p, 0, { maxBytes: 1e9 }, (l) => lines.push(l));
    expect(lines.map((l) => ("whole" in l ? "whole" : "ends"))).toEqual(["ends", "ends"]);
    expect(lines.map((l) => l.length)).toEqual([Buffer.byteLength(big), Buffer.byteLength(user)]);
    const file: FileCursor = { kind: "claude", ino: 1, offset: 0 };
    expect(claudeLine(lines[0]!, file)).toMatchObject({ model: "claude-sonnet-5-5", prompt: 70_305, read: 70_000, write1h: 300, output: 9, t: Date.parse("2026-10-08T10:00:00.000Z") });
    expect(claudeLine(lines[0]!, file)).toBeNull();                          // the same message again: counted once
    expect(claudeLine(lines[1]!, file)).toBeNull();
  });

  it("objectAt: a balanced object, strings with braces and escapes", () => {
    expect(objectAt('x{"a":"}{\\"","b":{"c":1}}tail', 1)).toBe('{"a":"}{\\"","b":{"c":1}}');
    expect(objectAt('{"a":1', 0)).toBeNull();
  });
});

// ── The service ──
function walk(root: string): Array<{ path: string; mtimeMs: number }> {
  const out: Array<{ path: string; mtimeMs: number }> = [];
  const go = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) go(p); else if (e.name.startsWith("rollout-")) out.push({ path: p, mtimeMs: statSync(p).mtimeMs }); } };
  try { go(root); } catch { /* none */ }
  return out;
}

describe("the service", () => {
  let dir: string;
  let insts: CacheInstance[];
  const NOW = Date.parse("2026-10-08T21:00:00.000Z");
  const make = (over: Partial<ConstructorParameters<typeof CacheService>[0]> = {}) => new CacheService({
    instances: () => insts,
    claudeProjectsDir: () => join(dir, "projects"),
    claudeKey: (wd) => wd.replace(/[^a-zA-Z0-9]/g, "-"),
    codexSessionsDir: () => join(dir, "sessions"),
    listRollouts: walk,
    metaPath: join(dir, "codex-meta.json"),
    now: () => NOW,
    ...over,
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cache-svc-"));
    const wdClaude = join(dir, "wd-claude"), wdCodex = join(dir, "wd-codex");
    mkdirSync(wdClaude); mkdirSync(wdCodex); mkdirSync(join(dir, "state"));
    insts = [
      { name: "dev", backend: "claude-code", workingDirectory: wdClaude, ledgerPath: join(dir, "state", "dev.json") },
      { name: "cx", backend: "codex", workingDirectory: wdCodex, ledgerPath: join(dir, "state", "cx.json") },
      { name: "kiro", backend: "kiro-cli", workingDirectory: dir, ledgerPath: join(dir, "state", "kiro.json") },
      { name: "grok", backend: "grok", workingDirectory: dir, ledgerPath: join(dir, "state", "grok.json") },
      { name: "idle", backend: "claude-code", workingDirectory: join(dir, "nowhere"), ledgerPath: join(dir, "state", "idle.json") },
      // An instance never started: no instance directory yet — its ledger still persists.
      { name: "new", backend: "claude-code", workingDirectory: join(dir, "wd-new"), ledgerPath: join(dir, "state", "never", "new.json") },
    ];
    const proj = join(dir, "projects", wdClaude.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(proj, { recursive: true });
    copyFileSync(join(FIX, "claude-transcript.jsonl"), join(proj, "s1.jsonl"));
    const projNew = join(dir, "projects", join(dir, "wd-new").replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(projNew, { recursive: true });
    copyFileSync(join(FIX, "claude-transcript.jsonl"), join(projNew, "s1.jsonl"));
    const day = join(dir, "sessions", "2026", "10", "08");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-a.jsonl"), readFileSync(join(FIX, "codex-rollout.jsonl"), "utf8").replaceAll("/work/codex-sample", wdCodex));
    // Another directory's rollout: not this instance's.
    writeFileSync(join(day, "rollout-b.jsonl"), readFileSync(join(FIX, "codex-rollout.jsonl"), "utf8"));
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("reads each instance's own files; the statuses for kiro, other CLIs and no transcript", async () => {
    const s = make();
    expect(s.scanning().caughtUp).toBe(false);
    await s.kick();
    expect(s.scanning().caughtUp).toBe(true);
    const r = await s.report("24h");
    s.stop();
    const by = Object.fromEntries(r.instances.map((i) => [i.name, i]));
    expect(by.dev!.status).toBe("ok");
    expect(by.dev!.analysis!.requests).toBe(4);
    expect(by.cx!.analysis!.requests).toBe(4);                                // rollout-b names another directory
    expect(by.cx!.analysis!.estimate).toBe(true);
    expect([by.kiro!.status, by.grok!.status, by.idle!.status, by.new!.status]).toEqual(["credit_billed", "unsupported", "no_data", "ok"]);
    expect(r.pricesChecked).toBe(PRICES_CHECKED);
    expect(r.scanning.pendingBytes).toBe(0);
    expect(r.fleet.analysed).toBe(3);
    expect(existsSync(join(dir, "state", "never", "new.json"))).toBe(true);
  });

  it("a restart resumes from the persisted cursor: nothing counted twice, an appended request counted once", async () => {
    const a = make(); await a.kick(); a.stop();
    const b = make(); await b.kick();
    expect((await b.report("24h")).instances.find((i) => i.name === "dev")!.analysis!.requests).toBe(4);
    b.stop();
    const proj = join(dir, "projects", insts[0]!.workingDirectory.replace(/[^a-zA-Z0-9]/g, "-"));
    const last = readFileSync(join(proj, "s1.jsonl"), "utf8").trim().split("\n").at(-1)!;
    appendFileSync(join(proj, "s1.jsonl"), last.replace("msg_05", "msg_06").replace("11:06:00", "11:07:00") + "\n");
    const c = make(); await c.kick();
    expect((await c.report("24h")).instances.find((i) => i.name === "dev")!.analysis!.requests).toBe(5);
    c.stop();
  });

  it("a replaced file (another inode) is followed from its end, not read again", async () => {
    const a = make(); await a.kick(); a.stop();
    const proj = join(dir, "projects", insts[0]!.workingDirectory.replace(/[^a-zA-Z0-9]/g, "-"));
    const copy = join(dir, "copy.jsonl");
    copyFileSync(join(proj, "s1.jsonl"), copy);
    renameSync(copy, join(proj, "s1.jsonl"));
    const b = make(); await b.kick();
    expect((await b.report("24h")).instances.find((i) => i.name === "dev")!.analysis!.requests).toBe(4);
    b.stop();
  });

  it("a 100+ MB transcript: bounded passes, the event loop keeps running, memory stays flat", async () => {
    const proj = join(dir, "projects", insts[0]!.workingDirectory.replace(/[^a-zA-Z0-9]/g, "-"));
    const big = join(proj, "big.jsonl");
    const fd = openSync(big, "w");
    const tool = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "z".repeat(4 * 1024 * 1024) }] }, timestamp: "2026-10-08T12:00:00.000Z" }) + "\n";
    let requests = 0;
    for (let k = 0; k < 27; k++) {
      const ts = new Date(Date.parse("2026-10-08T12:00:00.000Z") + k * 60_000).toISOString();
      writeSync(fd, JSON.stringify({ isSidechain: false, message: { model: "claude-opus-5-5", id: `msg_b${k}`, role: "assistant", content: [{ type: "text", text: "[redacted]" }],
        usage: { input_tokens: 1, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 }, output_tokens: 5 } },
        type: "assistant", timestamp: ts }) + "\n");
      requests++;
      writeSync(fd, tool);
    }
    closeSync(fd);
    expect(statSync(big).size).toBeGreaterThan(100 * 1024 * 1024);
    const base = process.memoryUsage();
    let maxGap = 0, peak = 0, last = performance.now();
    const beat = setInterval(() => {
      const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now;
      const m = process.memoryUsage(); peak = Math.max(peak, m.heapUsed + m.arrayBuffers - base.heapUsed - base.arrayBuffers);
    }, 5);
    const started = performance.now();
    const s = make({ passBytes: 16 * 1024 * 1024 });
    try {
      await s.kick();
    } finally { clearInterval(beat); s.stop(); }
    const took = performance.now() - started;
    if (process.env.CACHE_BENCH) console.log(JSON.stringify({ took: Math.round(took), maxGap: Math.round(maxGap), peakMB: Math.round(peak / 1048576) }));
    const r = await make().report("24h");
    expect(r.instances.find((i) => i.name === "dev")!.analysis!.requests).toBe(4 + requests);
    expect(took).toBeLessThan(30_000);
    expect(maxGap).toBeLessThan(150);                    // a 5 ms heartbeat never waited 150 ms
    expect(peak).toBeLessThan(96 * 1024 * 1024);          // never the file, never a 4 MB line held whole
  }, 60_000);
});

// ── #1470 review: one witness per finding ──
const turnC = (t: number, o: Partial<Turn> = {}): Turn => ({ t, model: "m", prompt: C, uncached: 0, read: C, write5m: 0, write1h: 0, write: null, output: 0, ...o });

describe("#1470 review — the model", () => {
  it("1. pings are counted at their own instants inside the window (a 48 h gap in a 24 h window: 27, not 53)", () => {
    const l = series("claude", [T0, T0 + 48 * H], 3600);
    const r = sim(l, 3600, T0 + 24 * H, T0 + 48 * H);
    expect(r.pings).toBe(27);                                   // k = ceil(86400/3240) … floor(172800/3240)
    expect(r.expired).toBe(1);
  });
  it("1. a gap exactly one interval long gets its ping; a session replaced at the instant of its last request has no tail", () => {
    expect(sim(series("claude", [T0, T0 + 3_240_000], 3600), 3600, T0, T0 + 3_240_000).pings).toBe(1);
    const l = series("claude", [T0, T0 + 60_000], 3600, { file: "a" });
    series("claude", [T0 + 60_000, T0 + 120_000], 3600, { ledger: l, file: "b" });
    expect(sessionTails(l, T0 + 120_000).map((x) => [x.t, x.until])).toEqual([[T0 + 60_000, T0 + 60_000], [T0 + 120_000, T0 + 120_000]]);
  });
  it("2. a ping reads the context it pings, at that context's price tier (not the larger request after the gap)", () => {
    const l = emptyLedger();
    const f: FileCursor = l.files.a = { kind: "codex", ino: 1, offset: 0 };
    addTurn(l, f, { t: T0, model: "gpt-6.1-sol", prompt: 200_000, uncached: 200_000, read: 0, write5m: 0, write1h: 0, write: 0, output: 0 }, 0);
    addTurn(l, f, { t: T0 + H, model: "gpt-6.1-sol", prompt: 300_000, uncached: 300_000, read: 0, write5m: 0, write1h: 0, write: 0, output: 0 }, 0);
    const a = analyzeLedger(l, { backend: "codex", from: T0, to: T0 + H });
    expect(a.sim.pings).toBe(2);                                // floor(3600 / 1620)
    expect(a.sim.pingCost).toBeCloseTo(2 * 200_000 * listedRates("gpt-6.1-sol", 200_000)!.read / 1e6, 12);
    expect(listedRates("gpt-6.1-sol", 200_000)!.read).not.toBe(listedRates("gpt-6.1-sol", 300_000)!.read);
  });
  it("2. an idle tail on a model the table does not know makes the whole instance unpriced", () => {
    const l = emptyLedger();
    const a: FileCursor = l.files.a = { kind: "claude", ino: 1, offset: 0 };
    addTurn(l, a, turnC(T0 - 2 * H, { model: "mystery", write1h: C, read: 0 }), 0);
    const b: FileCursor = l.files.b = { kind: "claude", ino: 2, offset: 0 };
    for (const k of [0, 1, 2]) addTurn(l, b, turnC(T0 + 10 * H + k * 60_000, { model: "claude-opus-5-5", write1h: 1000 }), 0);
    const r = analyzeLedger(l, { backend: "claude", from: T0, to: T0 + 11 * H });
    expect(r.sim.tailPings).toBeGreaterThan(0);
    expect(r.priced).toBe(false);
  });
  it("3. Codex that records real writes: a measured 0 after a gap is no expiry (not the uncached input)", () => {
    const l = emptyLedger();
    const f: FileCursor = l.files.a = { kind: "codex", ino: 1, offset: 0 };
    addTurn(l, f, { t: T0, model: "gpt-6.1-sol", prompt: C, uncached: 0, read: C - 1000, write5m: 0, write1h: 0, write: 1000, output: 0 }, 0);
    addTurn(l, f, { t: T0 + 60_000, model: "gpt-6.1-sol", prompt: C, uncached: 0, read: C - 1000, write5m: 0, write1h: 0, write: 1000, output: 0 }, 0);
    addTurn(l, f, { t: T0 + 2 * H, model: "gpt-6.1-sol", prompt: C, uncached: 900_000, read: 100_000, write5m: 0, write1h: 0, write: 0, output: 0 }, 0);
    const r = analyzeLedger(l, { backend: "codex", from: T0, to: T0 + 2 * H });
    expect(r.estimate).toBe(false);
    expect(r.sim.pastTtl).toBe(1);
    expect(r.sim.expired).toBe(0);
  });
  it("4. each session keeps its own TTL: a 5-minute session after a 1-hour one expires after 10-minute gaps", () => {
    const l = emptyLedger();
    const a: FileCursor = l.files.a = { kind: "claude", ino: 1, offset: 0 };
    addTurn(l, a, turnC(T0, { write1h: 5 * C, read: 0, model: "claude-opus-5-5" }), 0);
    const b: FileCursor = l.files.b = { kind: "claude", ino: 2, offset: 0 };
    for (const k of [0, 1, 2]) addTurn(l, b, turnC(T0 + H + k * 600_000, { model: "claude-sonnet-4-6", write5m: C, read: 0 }), 0);
    const r = analyzeLedger(l, { backend: "claude", from: T0, to: T0 + 2 * H });
    expect(l.gaps.map((g) => g[4])).toEqual([300, 300]);
    expect(r.sim.expired).toBe(2);
    expect(r.ttlSec).toBe(300);
  });
});

describe("#1470 review — reading", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cache-rev-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("5. a long record: `type` at the start is read; `isSidechain: true` at the end is a subagent's", async () => {
    const usage = { input_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, cache_creation: { ephemeral_1h_input_tokens: 5, ephemeral_5m_input_tokens: 0 }, output_tokens: 2 };
    const pad = "q".repeat(2 * 1024 * 1024 + 10);
    const typeFirst = `{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_head","content":[{"type":"text","text":"${pad}"}],"usage":${JSON.stringify(usage)}},"timestamp":"2026-10-08T10:00:00.000Z"}`;
    const sideLast = `{"message":{"model":"claude-opus-5-5","id":"msg_side","content":[{"type":"text","text":"${pad}"}],"usage":${JSON.stringify(usage)}},"type":"assistant","timestamp":"2026-10-08T10:01:00.000Z","isSidechain":true}`;
    const p = join(dir, "t.jsonl");
    writeFileSync(p, `${typeFirst}\n${sideLast}\n`);
    const { turns } = await readAll(p, "claude");
    expect(turns.map((x) => x.t)).toEqual([Date.parse("2026-10-08T10:00:00.000Z")]);
  });

  it("7. the descriptor read is checked against the cursor: another file at the path is followed from its end, not read", async () => {
    const p = join(dir, "s.jsonl");
    copyFileSync(join(FIX, "claude-transcript.jsonl"), p);
    const real = statSync(p);
    let lines = 0;
    const res = await scanJsonl(p, 0, { maxBytes: 1e9, ino: real.ino + 1 }, () => { lines++; });
    expect(lines).toBe(0);
    expect(res).toMatchObject({ replaced: true, ino: real.ino, bytes: 0, read: 0 });
    const svc = new CacheService({ instances: () => [], claudeProjectsDir: () => dir, claudeKey: (x) => x, codexSessionsDir: () => dir, listRollouts: () => [], metaPath: join(dir, "m.json") });
    const ledger = emptyLedger();
    const cur: FileCursor = ledger.files[p] = { kind: "claude", ino: real.ino + 1, offset: 0 };
    await (svc as any).read(ledger, cur, p, 1e9, 0);
    expect(Object.keys(ledger.hours)).toEqual([]);
    expect(ledger.files[p]).toMatchObject({ ino: real.ino, offset: real.size });
  });
});

describe("#1470 review — the service", () => {
  it("passes never overlap: two asked for at once read a file once", async () => {
    const d = mkdtempSync(join(tmpdir(), "cache-overlap-"));
    try {
      const wd = join(d, "w"); mkdirSync(wd);
      const proj = join(d, "projects", wd.replace(/[^a-zA-Z0-9]/g, "-")); mkdirSync(proj, { recursive: true });
      copyFileSync(join(FIX, "claude-transcript.jsonl"), join(proj, "s.jsonl"));
      const s = new CacheService({ instances: () => [{ name: "w", backend: "claude-code", workingDirectory: wd, ledgerPath: join(d, "w.json") }],
        claudeProjectsDir: () => join(d, "projects"), claudeKey: (x) => x.replace(/[^a-zA-Z0-9]/g, "-"), codexSessionsDir: () => d, listRollouts: () => [],
        metaPath: join(d, "m.json"), now: () => Date.parse("2026-10-08T21:00:00.000Z") });
      await Promise.all([s.pass(), s.pass(), s.kick()]);
      const r = await s.report("24h"); s.stop();
      expect(r.instances[0]!.analysis!.requests).toBe(4);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  let dir: string;
  const NOW = Date.parse("2026-10-08T21:00:00.000Z");
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cache-rev-svc-")); mkdirSync(join(dir, "sessions", "d"), { recursive: true }); mkdirSync(join(dir, "projects"), { recursive: true }); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const codexInst = (name: string, wd: string): CacheInstance => ({ name, backend: "codex", workingDirectory: wd, ledgerPath: join(dir, "state", `${name}.json`) });
  const svc = (insts: CacheInstance[], over: Record<string, unknown> = {}) => new CacheService({
    instances: () => insts, claudeProjectsDir: () => join(dir, "projects"), claudeKey: (wd) => wd.replace(/[^a-zA-Z0-9]/g, "-"),
    codexSessionsDir: () => join(dir, "sessions"), listRollouts: walk, metaPath: join(dir, "meta.json"), now: () => NOW, ...over,
  });
  const rollout = (cwd: string) => readFileSync(join(FIX, "codex-rollout.jsonl"), "utf8").replaceAll("/work/codex-sample", cwd);
  const requestsOf = async (s: CacheService, name: string) => (await s.report("24h")).instances.find((i) => i.name === name)!;
  /** Requests read for an instance — asserting first that it was analysed at all. */
  const countOf = async (s: CacheService, name: string): Promise<number> => {
    const r = await requestsOf(s, name);
    expect(r.status, name).toBe("ok");
    return r.analysis?.requests ?? -1;
  };

  it("6. a session_meta still being written is read again later; a replaced rollout is attributed by its new meta", async () => {
    const wdA = join(dir, "a"), wdB = join(dir, "b");
    mkdirSync(wdA); mkdirSync(wdB);
    const p = join(dir, "sessions", "d", "rollout-1.jsonl");
    const full = rollout(wdA);
    const nl = full.indexOf("\n");
    writeFileSync(p, full.slice(0, nl - 5));                     // the first line, unfinished
    const s = svc([codexInst("a", wdA), codexInst("b", wdB)]);
    await s.pass();
    expect((await requestsOf(s, "a")).status).toBe("no_data");
    writeFileSync(p, full);
    await s.pass();
    expect(await countOf(s, "a")).toBe(4);
    const tmp = join(dir, "sessions", "d", "x.tmp");
    writeFileSync(tmp, rollout(wdB));
    renameSync(tmp, p);
    await s.pass();
    // The path now holds b's rollout (another inode, another session_meta): b reads it, a no longer does.
    expect(await countOf(s, "b")).toBe(4);
    appendFileSync(p, readFileSync(p, "utf8").trim().split("\n").at(-1)!.replace("20:12:12", "20:30:00").replace("195223", "300000") + "\n");
    await s.pass();
    s.stop();
    expect(await countOf(s, "b")).toBe(5);
    expect(await countOf(s, "a")).toBe(4);
  });

  it("8. two Codex instances on one directory: neither is analysed, both say why — whatever the configured order", async () => {
    const wd = join(dir, "same"); mkdirSync(wd);
    writeFileSync(join(dir, "sessions", "d", "rollout-1.jsonl"), rollout(wd));
    for (const order of [["x", "y"], ["y", "x"]]) {
      const s = svc(order.map((n) => codexInst(n, wd)));
      await s.pass();
      const r = await s.report("24h");
      s.stop();
      expect(r.instances.map((i) => [i.name, i.status, i.with])).toEqual(order.map((n) => [n, "shared", order.filter((m) => m !== n)]));
      expect(existsSync(join(dir, "state", "x.json")) || existsSync(join(dir, "state", "y.json"))).toBe(false);
    }
  });

  it("9. a ledger that could not be written is written by the next pass, even with nothing new to read", async () => {
    const wd = join(dir, "w"); mkdirSync(wd);
    writeFileSync(join(dir, "sessions", "d", "rollout-1.jsonl"), rollout(wd));
    const inst = codexInst("w", wd);
    mkdirSync(inst.ledgerPath, { recursive: true });            // a directory where the file goes: the rename fails
    const s = svc([inst]);
    await s.pass();
    expect(statSync(inst.ledgerPath).isDirectory()).toBe(true);
    rmSync(inst.ledgerPath, { recursive: true });
    await s.pass();
    s.stop();
    expect(existsSync(inst.ledgerPath) && statSync(inst.ledgerPath).isFile()).toBe(true);
  });

  it("10. the budget is charged what was read: two unfinished 20 MiB lines take two passes; an unchanged one is not read again", async () => {
    const wd = join(dir, "c"); mkdirSync(wd);
    const proj = join(dir, "projects", wd.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(proj);
    const big = "{\"type\":\"user\",\"x\":\"" + "u".repeat(20 * 1024 * 1024);   // no newline: still being written
    writeFileSync(join(proj, "a.jsonl"), big); writeFileSync(join(proj, "b.jsonl"), big);
    const logs: string[] = [];
    const s = svc([{ name: "c", backend: "claude-code", workingDirectory: wd, ledgerPath: join(dir, "state", "c.json") }],
      { passBytes: 16 * 1024 * 1024, log: (_l: string, msg: string) => logs.push(msg) });
    expect(await s.pass()).toBe(big.length);                    // one file read (one long line may overshoot), one left
    expect(s.scanning().pendingFiles).toBe(1);
    expect(await s.pass()).toBe(0);
    const ledger = (s as any).ledgers.get("c");
    expect(Object.values(ledger.files).map((f: any) => f.stalled)).toEqual([big.length, big.length]);
    for (const f of ["a.jsonl", "b.jsonl"]) chmodSync(join(proj, f), 0o000);   // a read now would fail and log
    await s.pass();
    for (const f of ["a.jsonl", "b.jsonl"]) chmodSync(join(proj, f), 0o644);
    s.stop();
    expect(logs).toEqual([]);
  });
});
