/**
 * #1468: the prompt-cache expiry analysis — pure, over a ledger (cache-ledger.ts). For a window [from, to]:
 *
 * - The cache's TTL: Claude Code writes 1-hour entries on a subscription (5-minute ones otherwise; the ledger's write
 *   split says which); Codex on GPT-5.6 and later keeps a prefix 30 minutes after its last write or reuse.
 * - An expired request: one that came after a gap longer than the TTL and had to write at least half of the context
 *   the previous request left cached (the cache can outlive its TTL; then nothing was lost). What it rewrote, up to
 *   that context, is the expiry's tokens; its cost is those tokens at the write rate minus what reading them would
 *   have cost.
 * - Keep-warm, simulated: a ping every I = TTL − margin (margin = TTL/10) during each gap, each one reading the
 *   cached context: floor(gap / I) pings. A gap that ended in an expired request saves its expiry cost; any other gap
 *   only pays for its pings. After a session's last request — until the next session starts, or the window ends — the
 *   pings are pure loss: nothing ever reads that cache again.
 * - Recommendation: on when the simulated pings cost less than the expiries they prevent (by a margin), else off.
 *
 * Money is list price (cache-prices.ts). A model missing from the table is weighed in input-price units instead
 * (write 1.25x, 1-hour write 2x, read 0.1x, output 5x) and shows no dollars.
 */
import { ratesFor, type Rates } from "./cache-prices.js";
import { GAP_BUCKETS, type GapEvent, type Ledger } from "./cache-ledger.js";

export type Backend = "claude" | "codex";

export interface SimOptions {
  ttlSec: number;
  /** Rates for a request of `model` with `prompt` tokens; null: not priced. */
  rates?: (model: string, prompt: number) => Rates | null;
  from: number;
  to: number;
}

export interface SimTail { t: number; ctx: number; model: string; until: number }

export interface SimResult {
  pastTtl: number;
  expired: number;
  rewriteTokens: number;
  /** Expiry cost — and, below, every amount — in USD, or in input-price units when `priced` is false. */
  expiryCost: number;
  pings: number;
  pingCost: number;
  tailPings: number;
  tailCost: number;
  /** What keep-warm would have saved, net of every ping. */
  net: number;
  priced: boolean;
}

const UNITS: Rates = { input: 1, read: 0.1, write5m: 1.25, write1h: 2, write: 1.25, output: 5 };
const M = 1_000_000;

export const marginFor = (ttlSec: number): number => ttlSec / 10;
export const pingInterval = (ttlSec: number): number => ttlSec - marginFor(ttlSec);
const writeRate = (r: Rates, ttlSec: number): number => (ttlSec >= 3600 ? r.write1h : ttlSec <= 300 ? r.write5m : r.write);

/** Pings at t + k·I (k ≥ 1) that fall in (max(t, from), min(until, to)]. */
export function pingsBetween(t: number, until: number, intervalSec: number, from: number, to: number): number {
  const I = intervalSec * 1000;
  const lo = Math.max(t, from), hi = Math.min(until, to);
  if (!(I > 0) || hi <= lo) return 0;
  return Math.max(0, Math.floor((hi - t) / I) - Math.floor((lo - t) / I));
}

/** The keep-warm simulation over a window's long gaps and its sessions' ends. */
export function simulate(gaps: readonly GapEvent[], tails: readonly SimTail[], o: SimOptions): SimResult {
  const I = pingInterval(o.ttlSec);
  let priced = true;
  const rates = (model: string, prompt: number): Rates => {
    const r = o.rates ? o.rates(model, prompt) : null;
    if (!r) { priced = false; return UNITS; }
    return r;
  };
  const res: SimResult = { pastTtl: 0, expired: 0, rewriteTokens: 0, expiryCost: 0, pings: 0, pingCost: 0, tailPings: 0, tailCost: 0, net: 0, priced: true };
  let saved = 0;
  for (const [tEnd, gap, ctx, rewrite, model, prompt] of gaps) {
    if (tEnd < o.from || tEnd > o.to) continue;
    const r = rates(model, prompt);
    if (gap > o.ttlSec) res.pastTtl++;
    const lost = Math.min(rewrite, ctx);
    if (gap > o.ttlSec && ctx > 0 && lost >= ctx / 2) {
      res.expired++;
      res.rewriteTokens += lost;
      const cost = lost * (writeRate(r, o.ttlSec) - r.read) / M;
      res.expiryCost += cost;
      saved += cost;
    }
    const pings = gap > I ? Math.floor(gap / I) : 0;
    res.pings += pings;
    res.pingCost += pings * ctx * r.read / M;
  }
  for (const tail of tails) {
    const n = pingsBetween(tail.t, tail.until, I, o.from, o.to);
    if (!n) continue;
    res.tailPings += n;
    res.tailCost += n * tail.ctx * rates(tail.model, tail.ctx).read / M;
  }
  res.net = saved - res.pingCost - res.tailCost;
  res.priced = priced;
  return res;
}

/** Each session's end as the simulation needs it: its last request, until the next session of the instance started. */
export function sessionTails(ledger: Ledger, to: number): SimTail[] {
  const sessions = Object.values(ledger.files).filter((f) => f.last && f.first !== undefined)
    .map((f) => ({ first: f.first!, last: f.last! })).sort((a, b) => a.first - b.first);
  return sessions.map((s) => {
    const next = sessions.find((o) => o.first > s.last.t);
    return { t: s.last.t, ctx: s.last.ctx, model: s.last.model, until: next ? next.first : to };
  });
}

/** Codex GPT-5.6 and later bill cache writes and keep a prefix 30 minutes. */
export const isOpenAiTtlModel = (model: string): boolean => /^gpt-(5\.(6|[7-9])|[6-9])/.test(model);

export interface InstanceAnalysis {
  requests: number;
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

export interface AnalyzeOptions { backend: Backend; from: number; to: number; rates?: SimOptions["rates"] }

/** Requests in a window below this are too few to say anything. */
export const MIN_REQUESTS = 3;

export function analyzeLedger(ledger: Ledger, o: AnalyzeOptions): InstanceAnalysis {
  const listed = o.rates ?? ratesFor;
  const inWindow = (h: number): boolean => h + 3_600_000 > o.from && h <= o.to;
  // One unit for the whole instance: dollars when every model it used is priced, input-price units otherwise.
  const models = new Set<string>();
  for (const [hk, hour] of Object.entries(ledger.hours)) {
    if (!inWindow(Number(hk))) continue;
    for (const mk of Object.keys(hour.m)) models.add(mk.slice(0, mk.lastIndexOf("|")));
  }
  for (const g of ledger.gaps) if (g[0] >= o.from && g[0] <= o.to) models.add(g[4]);
  const priced = [...models].every((m) => listed(m, 0) !== null);
  const rates = (model: string, prompt: number): Rates => (priced ? listed(model, prompt) : null) ?? UNITS;
  const gapBuckets = new Array<number>(GAP_BUCKETS).fill(0);
  let requests = 0, w5 = 0, w1h = 0, totalCost = 0;
  const estimated = o.backend === "codex" && !ledger.writesSeen;
  for (const [hk, hour] of Object.entries(ledger.hours)) {
    if (!inWindow(Number(hk))) continue;
    hour.g.forEach((n, i) => { gapBuckets[i]! += n; });
    for (const [mk, [n, uncached, read, write5m, write1h, write, output]] of Object.entries(hour.m)) {
      const bar = mk.lastIndexOf("|");
      const model = mk.slice(0, bar), long = mk.slice(bar + 1) === "1";
      requests += n; w5 += write5m; w1h += write1h;
      const r = rates(model, long ? Number.MAX_SAFE_INTEGER : 0);
      // Codex on GPT-5.6+ with no recorded writes: its uncached input is what got written (the estimate).
      const uncachedRate = estimated && isOpenAiTtlModel(model) ? r.write : r.input;
      totalCost += (uncached * uncachedRate + read * r.read + write5m * r.write5m + write1h * r.write1h + write * r.write + output * r.output) / M;
    }
  }
  const ttlSec = o.backend === "codex" ? 1800 : w5 > w1h ? 300 : 3600;
  const sim = simulate(ledger.gaps, sessionTails(ledger, o.to), { ttlSec, rates, from: o.from, to: o.to });
  const assumedTtl = o.backend === "codex" && [...models].some((m) => !isOpenAiTtlModel(m));
  let recommendation: InstanceAnalysis["recommendation"];
  if (requests < MIN_REQUESTS) recommendation = { on: false, reason: "quiet" };
  else if (!sim.expired) recommendation = { on: false, reason: "never_expired" };
  else if (sim.net > 0 && sim.net >= sim.expiryCost * 0.1) recommendation = { on: true, reason: "saves" };
  else recommendation = { on: false, reason: "costs_more", pingsPerExpiry: Math.round((sim.pings + sim.tailPings) / sim.expired) };
  return {
    requests, ttlSec, estimate: estimated || assumedTtl, priced, models: [...models].sort(), gapBuckets, sim,
    totalCost, share: totalCost > 0 ? sim.expiryCost / totalCost : null, recommendation,
  };
}
