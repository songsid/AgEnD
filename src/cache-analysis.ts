/**
 * #1468: the prompt-cache expiry analysis — pure, over a ledger (cache-ledger.ts). For a window [from, to]:
 *
 * - Each gap carries the TTL of the cache it sat on, as that session last wrote it: Claude Code's own write split
 *   (1 hour, or 5 minutes), Codex's 30 minutes (GPT-5.6 and later). Sessions of one instance can differ.
 * - An expired request: one that came after a gap longer than its TTL and had to write at least half of the context
 *   the previous request left cached (the cache can outlive its TTL; then nothing was lost). What it rewrote, up to
 *   that context, is the expiry's tokens; its cost is those tokens at the write rate minus what reading them would
 *   have cost, at the returning request's own price tier.
 * - Keep-warm, simulated: a ping at every I = TTL − TTL/10 after a request (t + k·I, k ≥ 1, up to and including
 *   the moment the gap ends — floor(gap / I) of them), each reading the cached context at that context's own tier.
 *   Only pings whose instant falls inside the window are counted. A gap that ended in an expired request inside the
 *   window saves its expiry cost; any other gap only pays for its pings. After a session's last request the pings
 *   are pure loss, up to the moment the next session of the instance starts, or the window ends.
 * - Recommendation: on when the simulated pings cost less than the expiries they prevent (by a margin), else off.
 *
 * Money is list price (cache-prices.ts). If any model the window touches — requests, pinged contexts, idle tails —
 * is missing from the table, the whole instance is weighed in input-price units instead (write 1.25x, 1-hour write
 * 2x, read 0.1x, output 5x) and shows no dollars.
 */
import { ratesFor, type Rates } from "./cache-prices.js";
import { GAP_BUCKETS, type GapEvent, type Ledger } from "./cache-ledger.js";

export type Backend = "claude" | "codex";

export interface SimOptions {
  rates: (model: string, prompt: number) => Rates;
  from: number;
  to: number;
  /** Codex: use each event's measured write (the instance records real writes) rather than the estimate. */
  measured: boolean;
}

export interface SimTail { t: number; ctx: number; model: string; ttl: number; until: number }

export interface SimResult {
  pastTtl: number;
  expired: number;
  rewriteTokens: number;
  /** Expiry cost — and, below, every amount — in USD, or in input-price units when the instance is not priced. */
  expiryCost: number;
  pings: number;
  pingCost: number;
  tailPings: number;
  tailCost: number;
  /** What keep-warm would have saved, net of every ping. */
  net: number;
  /** A gap judged in this window used an estimated write (Codex's uncached input), not a recorded one. */
  estimated: boolean;
}

export const UNITS: Rates = { input: 1, read: 0.1, write5m: 1.25, write1h: 2, write: 1.25, output: 5 };
const M = 1_000_000;

export const pingIntervalMs = (ttlSec: number): number => Math.round(ttlSec * 900);
const writeRate = (r: Rates, ttlSec: number): number => (ttlSec >= 3600 ? r.write1h : ttlSec <= 300 ? r.write5m : r.write);

/** Pings at t + k·I (k ≥ 1) no later than `end`, counted only where they fall inside [from, to]. */
export function pingsBetween(t: number, end: number, intervalMs: number, from: number, to: number): number {
  if (!(intervalMs > 0)) return 0;
  const kMin = Math.max(1, Math.ceil((from - t) / intervalMs));
  const kMax = Math.floor((Math.min(end, to) - t) / intervalMs);
  return Math.max(0, kMax - kMin + 1);
}

/** The keep-warm simulation over a window's long gaps and its sessions' ends. */
export function simulate(gaps: readonly GapEvent[], tails: readonly SimTail[], o: SimOptions): SimResult {
  const res: SimResult = { pastTtl: 0, expired: 0, rewriteTokens: 0, expiryCost: 0, pings: 0, pingCost: 0, tailPings: 0, tailCost: 0, net: 0, estimated: false };
  let saved = 0;
  for (const [tEnd, gap, ctx, ctxModel, ttl, model, prompt, measured, estimated] of gaps) {
    if (tEnd < o.from) continue;
    const start = tEnd - Math.round(gap * 1000);
    const pings = pingsBetween(start, tEnd, pingIntervalMs(ttl), o.from, o.to);
    if (pings) {
      res.pings += pings;
      res.pingCost += pings * ctx * o.rates(ctxModel, ctx).read / M;
    }
    if (tEnd > o.to || !(gap > ttl)) continue;
    res.pastTtl++;
    const useMeasured = o.measured && measured !== null;
    if (!useMeasured) res.estimated = true;
    const rewrite = useMeasured ? measured : estimated;
    const lost = Math.min(rewrite, ctx);
    if (ctx > 0 && lost >= ctx / 2) {
      const r = o.rates(model, prompt);
      const cost = lost * (writeRate(r, ttl) - r.read) / M;
      res.expired++;
      res.rewriteTokens += lost;
      res.expiryCost += cost;
      saved += cost;
    }
  }
  for (const tail of tails) {
    const n = pingsBetween(tail.t, tail.until, pingIntervalMs(tail.ttl), o.from, o.to);
    if (!n) continue;
    res.tailPings += n;
    res.tailCost += n * tail.ctx * o.rates(tail.model, tail.ctx).read / M;
  }
  res.net = saved - res.pingCost - res.tailCost;
  return res;
}

/**
 * Each session's end: its last request, until the next session of the instance starts (the earliest other session
 * that starts at or after it — one that starts at the same instant leaves no idle time), or `to`.
 */
export function sessionTails(ledger: Ledger, to: number): SimTail[] {
  const sessions = Object.values(ledger.files).filter((f) => f.last && f.first !== undefined).map((f) => ({ first: f.first!, last: f.last! }));
  return sessions.map((s) => {
    let until = to;
    for (const o of sessions) if (o !== s && o.first >= s.last.t && o.first < until) until = o.first;
    return { t: s.last.t, ctx: s.last.ctx, model: s.last.model, ttl: s.last.ttl, until };
  });
}

/** Codex GPT-5.6 and later bill cache writes and keep a prefix 30 minutes. */
export const isOpenAiTtlModel = (model: string): boolean => /^gpt-(5\.(6|[7-9])|[6-9])/.test(model);

export interface InstanceAnalysis {
  requests: number;
  /** The TTL the instance's latest session uses (each gap is judged by its own session's TTL). */
  ttlSec: number;
  /** Writes (and so expiries) are estimated: Codex records none. Also true for a Codex model whose TTL is assumed. */
  estimate: boolean;
  priced: boolean;
  models: string[];
  gapBuckets: number[];
  sim: SimResult;
  totalCost: number;
  share: number | null;
  recommendation: { on: boolean; reason: "quiet" | "never_expired" | "saves" | "costs_more"; pingsPerExpiry?: number };
}

export interface AnalyzeOptions { backend: Backend; from: number; to: number; rates?: (model: string, prompt: number) => Rates | null }

/** Requests in a window below this are too few to say anything. */
export const MIN_REQUESTS = 3;

export function analyzeLedger(ledger: Ledger, o: AnalyzeOptions): InstanceAnalysis {
  const listed = o.rates ?? ratesFor;
  const inWindow = (h: number): boolean => h + 3_600_000 > o.from && h <= o.to;
  const tails = sessionTails(ledger, o.to);
  const estimatedTotals = o.backend === "codex" && !ledger.writesSeen;
  // One unit for the whole instance: dollars when every model that contributes to this window is priced — the
  // window's requests, and whatever the simulation itself prices (a pinged context, an expired request, an idle tail).
  // A probe run records exactly the models the simulation asks a rate for.
  const requestModels = new Set<string>();
  for (const [hk, hour] of Object.entries(ledger.hours)) {
    if (!inWindow(Number(hk))) continue;
    for (const mk of Object.keys(hour.m)) requestModels.add(mk.slice(0, mk.lastIndexOf("|")));
  }
  const touched = new Set<string>(requestModels);
  simulate(ledger.gaps, tails, { rates: (model) => { touched.add(model); return UNITS; }, from: o.from, to: o.to, measured: !estimatedTotals });
  const priced = [...touched].every((m) => listed(m, 0) !== null);
  const rates = (model: string, prompt: number): Rates => (priced ? listed(model, prompt) : null) ?? UNITS;
  const gapBuckets = new Array<number>(GAP_BUCKETS).fill(0);
  let requests = 0, totalCost = 0;
  for (const [hk, hour] of Object.entries(ledger.hours)) {
    if (!inWindow(Number(hk))) continue;
    hour.g.forEach((n, i) => { gapBuckets[i]! += n; });
    for (const [mk, [n, uncached, read, write5m, write1h, write, output]] of Object.entries(hour.m)) {
      const bar = mk.lastIndexOf("|");
      const model = mk.slice(0, bar), long = mk.slice(bar + 1) === "1";
      requests += n;
      const r = rates(model, long ? Number.MAX_SAFE_INTEGER : 0);
      // Codex on GPT-5.6+ with no recorded writes: its uncached input is what got written (the estimate).
      const uncachedRate = estimatedTotals && isOpenAiTtlModel(model) ? r.write : r.input;
      totalCost += (uncached * uncachedRate + read * r.read + write5m * r.write5m + write1h * r.write1h + write * r.write + output * r.output) / M;
    }
  }
  const sim = simulate(ledger.gaps, tails, { rates, from: o.from, to: o.to, measured: !estimatedTotals });
  const latest = tails.reduce<SimTail | null>((a, t) => (!a || t.t > a.t ? t : a), null);
  const ttlSec = latest ? latest.ttl : o.backend === "codex" ? 1800 : 3600;
  const assumedTtl = o.backend === "codex" && [...requestModels].some((m) => !isOpenAiTtlModel(m));
  let recommendation: InstanceAnalysis["recommendation"];
  if (requests < MIN_REQUESTS) recommendation = { on: false, reason: "quiet" };
  else if (!sim.expired) recommendation = { on: false, reason: "never_expired" };
  else if (sim.net > 0 && sim.net >= sim.expiryCost * 0.1) recommendation = { on: true, reason: "saves" };
  else recommendation = { on: false, reason: "costs_more", pingsPerExpiry: Math.round((sim.pings + sim.tailPings) / sim.expired) };
  return {
    // An estimate when anything shown used one: the totals (Codex with no recorded write), a gap's rewrite, a TTL.
    requests, ttlSec, estimate: (estimatedTotals && requests > 0) || sim.estimated || assumedTtl, priced, models: [...requestModels].sort(), gapBuckets, sim,
    totalCost, share: totalCost > 0 ? sim.expiryCost / totalCost : null, recommendation,
  };
}
