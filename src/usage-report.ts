/**
 * #2122: the usage report — tokens, requests, delivered messages and their API-equivalent at list price, per instance
 * (or by backend, model, credential profile or team), over a range of days. Pure: it reads the ledgers' hours after the
 * rollup's checkpoint and the rollup's days up to it (usage-rollup.ts), and the delivered-message counts; it never reads
 * a transcript. docs/design/2122-usage-analysis.md.
 *
 * Honest by construction: an amount is "API-equivalent at list price (checked <date>) — not money spent"; an unpriced
 * model's tokens are shown and its amount is not; Codex's cache writes are "not reported" (every CLI seen records 0),
 * never priced as uncached; an instance whose backend AgEnD cannot measure is listed with its reason, never as $0.
 * Kiro records no token counts: its rows are ESTIMATED from text size (kiro-usage.ts, design §10.2) and say so — on the
 * row (`estimated`), on any total that includes one (`includes_estimates`, with the estimated part of the amount), in
 * the API, on the page and in the CSV. An estimate never mixes silently into a measured number.
 */
import type { HourTotals, Ledger } from "./cache-ledger.js";
import { PRICES_CHECKED, ratesFor } from "./cache-prices.js";
import { hourSources, localDate, type UsageDays } from "./usage-rollup.js";

export const USAGE_GROUPS = ["instance", "backend", "model", "profile", "team"] as const;
export type UsageGroup = typeof USAGE_GROUPS[number];
export const USAGE_RANGES = ["today", "7d", "month", "all"] as const;
export type UsageRange = { kind: typeof USAGE_RANGES[number] } | { kind: "custom"; from: string; to: string };
/** What every amount is, in words — the page, the CSV and the agent tool all carry it. */
export const usageBasis = (checked = PRICES_CHECKED): string => `API-equivalent at list price (checked ${checked}) — not money spent`;
/**
 * Daily rows returned at most (the CSV and the trend): one per day, source and model. Beyond it the report keeps the
 * latest whole days and says from which date (`dailyFrom`); the rows and totals always cover the whole range.
 */
export const USAGE_DAILY_MAX = 20_000;

const M = 1_000_000;
/** The backends whose usage is estimated, not measured (#2122 §10.2: Kiro records no token counts). */
export const ESTIMATED_BACKENDS: ReadonlySet<string> = new Set(["kiro-cli"]);
/** The backends whose transcripts report reasoning tokens (#2122 §10.3); elsewhere a 0 means not reported. */
export const REPORTS_REASONING: ReadonlySet<string> = new Set(["codex", "grok", "muse", "opencode"]);
/** The backends whose transcripts carry a cache-write field that stays 0: "not reported" until a real write is seen. */
export const WRITES_UNREPORTED: ReadonlySet<string> = new Set(["codex", "muse"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface UsageInstanceInput {
  name: string;
  /** Its backend now: what it is collected with from here on (each slice of its history carries its own). */
  backend: string;
  /** The team it is in now (fleet.yaml), for the one grouping built from current settings. */
  team: string | null;
  /** Whether it is collected now; what it measured before (`ledger`, `days`) is reported either way. */
  status: "ok" | "no_data" | "credit_billed" | "unsupported" | "shared";
  with?: string[];
  /** A snapshot taken together with `days` (cache-service.ts usageData): read-only here. */
  ledger?: Ledger;
  days?: UsageDays;
}
export interface UsageInput {
  now: number;
  zone: string;
  range: UsageRange;
  group: UsageGroup;
  instances: UsageInstanceInput[];
  messages: Array<{ instance: string; hour: number; count: number }>;
  scanning: { active: boolean; caughtUp: boolean; pendingBytes: number; pendingFiles: number };
  /** Daily rows at most (default USAGE_DAILY_MAX; tests lower it to reach the same path). */
  dailyMax?: number;
}

export interface UsageTotals {
  /** Uncached input. */
  input: number;
  /** Output without its reasoning part — the units of tokscale's daily rows (design §10.3). */
  output: number;
  /** The part of the output a CLI reports as reasoning (Codex); 0 where none is reported (Claude). */
  reasoning: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** OpenAI's one write column (Codex records 0: see `flags`). */
  cacheWrite: number;
  requests: number;
}
export interface UsageRow extends UsageTotals {
  key: string;
  /** Whether any of it comes from a CLI that reports reasoning (REPORTS_REASONING): false → its 0 is "not reported". */
  reasoningReported: boolean;
  /** Some of it is estimated (ESTIMATED_BACKENDS); flagged "estimated" (a row) or "includes_estimates" (the totals). */
  estimated: boolean;
  /** The estimated part of `amount` (null: nothing estimated is priced). */
  amountEstimated: number | null;
  total: number;
  /** Delivered messages; null where a message has no such key (by model, by profile). */
  messages: number | null;
  /** The API-equivalent at list price of what is priced; null when nothing in it is. */
  amount: number | null;
  priced: "all" | "partial" | "none";
  /**
   * "cache_write_not_reported" (Codex), "not_priced" (with `unpriced`), "source_unknown" (hours counted before #2122:
   * which backend and profile read them was not recorded).
   */
  flags: string[];
  unpriced: string[];
  instances: string[];
  backends: string[];
  models: string[];
  profiles: string[];
}
export interface UsageDaily extends UsageTotals {
  date: string;
  reasoningReported: boolean;
  estimated: boolean;
  zone: string;
  instance: string;
  backend: string;
  model: string;
  tier: "long" | "standard";
  profile: string;
  amount: number | null;
  flags: string[];
}
export interface UsageReport {
  range: { kind: UsageRange["kind"]; from: string; to: string };
  zone: string;
  /** Days are made of whole UTC hours (§5.3): in a half-hour zone a day's edge falls on the hour that holds midnight. */
  granularity: "hour";
  basis: string;
  pricesChecked: string;
  group: UsageGroup;
  rows: UsageRow[];
  totals: UsageRow;
  daily: UsageDaily[];
  /**
   * The daily rows (and the messages by day) are not the whole range: they start at `dailyFrom` (earlier days were too
   * many rows to send), or — `dailyFrom` null — there are none at all (the latest day alone was more than the cap: a
   * part of a day is never sent as if it were the day). The rows and totals always cover the whole range.
   */
  dailyTruncated: boolean;
  dailyFrom: string | null;
  messagesDaily: Array<{ date: string; instance: string; count: number }>;
  notMeasured: Array<{ name: string; backend: string; reason: "credit_billed" | "unsupported" | "no_data" }>;
  shared: Array<{ name: string; backend: string; with: string[] }>;
  /** Per measured instance: the merged UTC intervals its transcripts were read over (§5.5) — never inferred. */
  coverage: Array<{ name: string; intervals: Array<[number, number]> }>;
  scanning: UsageInput["scanning"];
}

/** A range as asked (query string or tool argument); anything else is the last 7 days. */
export function usageRange(kind: unknown, from?: unknown, to?: unknown): UsageRange {
  if (kind === "custom" && typeof from === "string" && typeof to === "string" && DATE.test(from) && DATE.test(to) && from <= to) return { kind: "custom", from, to };
  return (USAGE_RANGES as readonly unknown[]).includes(kind) ? { kind: kind as typeof USAGE_RANGES[number] } : { kind: "7d" };
}
export const usageGroup = (g: unknown): UsageGroup => (USAGE_GROUPS as readonly unknown[]).includes(g) ? g as UsageGroup : "instance";

/** A local date (YYYY-MM-DD) moved by `n` calendar days — a date's arithmetic, never 24-hour steps (a DST day is 23 or 25). */
export const shiftDate = (date: string, n: number): string =>
  new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + n)).toISOString().slice(0, 10);

/** The range's first and last local dates (inclusive) in `zone`: "7d" is today and the 6 calendar days before it. */
export function rangeDates(range: UsageRange, now: number, zone: string): { from: string; to: string } {
  const today = localDate(now, zone);
  switch (range.kind) {
    case "today": return { from: today, to: today };
    case "7d": return { from: shiftDate(today, -6), to: today };
    case "month": return { from: `${today.slice(0, 8)}01`, to: today };
    case "all": return { from: "0000-01-01", to: today };
    case "custom": return { from: range.from, to: range.to };
  }
}

const zero = (): UsageTotals => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 0, requests: 0 });
/** One slice into a row: `reasoning` is the part of the slice's output reported as reasoning (shown beside the rest). */
const addTotals = (into: UsageTotals, [n, uncached, read, w5, w1h, w, out]: HourTotals, reasoning: number): void => {
  const r = Math.min(Math.max(0, reasoning), out);
  into.requests += n; into.input += uncached; into.cacheRead += read; into.cacheWrite5m += w5; into.cacheWrite1h += w1h; into.cacheWrite += w; into.output += out - r; into.reasoning += r;
};
const splitKey = (mk: string): { model: string; long: boolean } => { const bar = mk.lastIndexOf("|"); return { model: mk.slice(0, bar), long: mk.slice(bar + 1) === "1" }; };

/**
 * The list-price amount of one slice, or null when its model is not in the table. Reasoning is a part of the slice's
 * output, so the whole output is priced at the output rate once. Codex writes not reported are 0 in the
 * ledger (it marks writesSeen on the first one above 0), so they add nothing and are never priced as uncached input.
 */
function amountOf(model: string, long: boolean, [, uncached, read, w5, w1h, w, out]: HourTotals): number | null {
  const r = ratesFor(model, long ? Number.MAX_SAFE_INTEGER : 0);
  if (!r) return null;
  return (uncached * r.input + read * r.read + w5 * r.write5m + w1h * r.write1h + w * r.write + out * r.output) / M;
}

interface Slice { date: string; zone: string; instance: string; backend: string; team: string | null; profile: string; model: string; long: boolean; tot: HourTotals; reasoning: number; cost: number; writesReported: boolean }
const estimatedSlice = (s: Slice): boolean => ESTIMATED_BACKENDS.has(s.backend);
const unknownSource = (s: Slice): boolean => s.backend === "unknown" || s.profile === "unknown";

export function buildUsageReport(input: UsageInput): UsageReport {
  const { from, to } = rangeDates(input.range, input.now, input.zone);
  const inRange = (date: string) => date >= from && date <= to;
  const slices: Slice[] = [];
  const notMeasured: UsageReport["notMeasured"] = [];
  const shared: UsageReport["shared"] = [];
  const coverage: UsageReport["coverage"] = [];
  for (const i of input.instances) {
    // Its status is about collecting now; what it measured before — under another backend, or before it shared a
    // working directory — is still its history and is reported below.
    if (i.status === "shared") shared.push({ name: i.name, backend: i.backend, with: i.with ?? [] });
    else if (i.status !== "ok") notMeasured.push({ name: i.name, backend: i.backend, reason: i.status === "credit_billed" ? "credit_billed" : i.status === "no_data" ? "no_data" : "unsupported" });
    if (!i.ledger || !i.days) continue;
    coverage.push({ name: i.name, intervals: i.days.coverage.map(([a, b]) => [a, b] as [number, number]) });
    // Codex and Muse: a write is reported only once a real one has been seen (every CLI so far records 0).
    const writesSeen = i.ledger.writesSeen === true;
    const base = { instance: i.name, team: i.team };
    for (const row of i.days.rows) {
      if (!inRange(row.date)) continue;
      for (const [mk, tot] of Object.entries(row.m)) slices.push({ ...base, backend: row.be, writesReported: !WRITES_UNREPORTED.has(row.be) || writesSeen, date: row.date, zone: row.zone, profile: row.pf, ...splitKey(mk), tot, reasoning: row.r?.[mk] ?? 0, cost: row.c?.[mk] ?? 0 });
    }
    for (const [hk, hour] of Object.entries(i.ledger.hours)) {
      const h = Number(hk);
      if (h <= i.days.checkpoint) continue;                 // already in the rollup: counted once (§5.2)
      const date = localDate(h, input.zone);
      if (!inRange(date)) continue;
      for (const src of hourSources(hour)) {
        for (const [mk, tot] of Object.entries(src.m)) slices.push({ ...base, backend: src.backend, writesReported: !WRITES_UNREPORTED.has(src.backend) || writesSeen, date, zone: input.zone, profile: src.profile, ...splitKey(mk), tot, reasoning: src.r[mk] ?? 0, cost: src.c[mk] ?? 0 });
      }
    }
  }

  const keyOf = (s: Slice): string => {
    switch (input.group) {
      case "instance": return s.instance;
      case "backend": return s.backend;
      case "model": return s.model;
      case "profile": return s.profile;
      case "team": return s.team ?? "";
    }
  };
  type Acc = UsageRow & { _amount: number; _pricedAny: boolean; _unpricedAny: boolean; _estAmount: number; _estPriced: boolean };
  const rows = new Map<string, Acc>();
  const newRow = (key: string): Acc => ({ key, ...zero(), reasoningReported: false, estimated: false, amountEstimated: null, _estAmount: 0, _estPriced: false, total: 0, messages: null, amount: null, priced: "none", flags: [], unpriced: [], instances: [], backends: [], models: [], profiles: [], _amount: 0, _pricedAny: false, _unpricedAny: false });
  const uniq = (list: string[], v: string) => { if (!list.includes(v)) list.push(v); };
  // Daily rows: one per day, zone, agent, backend, model, tier and profile (an hour's slices summed into their day).
  const dailyBy = new Map<string, UsageDaily>();
  for (const s of slices) {
    const key = keyOf(s);
    const row = rows.get(key) ?? (rows.set(key, newRow(key)), rows.get(key)!);
    addTotals(row, s.tot, s.reasoning);
    if (REPORTS_REASONING.has(s.backend)) row.reasoningReported = true;
    uniq(row.instances, s.instance); uniq(row.backends, s.backend); uniq(row.models, s.model); uniq(row.profiles, s.profile);
    // List price first; a model the table lacks takes the cost its CLI reported (Grok), said so (design §10.2).
    const listed = amountOf(s.model, s.long, s.tot), reported = listed === null && s.cost > 0;
    const amount = listed ?? (reported ? s.cost : null);
    if (reported) uniq(row.flags, "cost_reported");
    if (amount === null) { row._unpricedAny = true; uniq(row.unpriced, s.model); } else { row._pricedAny = true; row._amount += amount; }
    if (estimatedSlice(s)) { row.estimated = true; uniq(row.flags, "estimated"); if (amount !== null) { row._estPriced = true; row._estAmount += amount; } }
    if (!s.writesReported) uniq(row.flags, "cache_write_not_reported");
    if (unknownSource(s)) uniq(row.flags, "source_unknown");
    const tier = s.long ? "long" : "standard";
    const dk = [s.date, s.zone, s.instance, s.backend, s.model, tier, s.profile].join("\u0000");
    let d = dailyBy.get(dk);
    if (!d) {
      d = { date: s.date, zone: s.zone, instance: s.instance, backend: s.backend, model: s.model, tier, profile: s.profile, ...zero(), reasoningReported: REPORTS_REASONING.has(s.backend), estimated: estimatedSlice(s), amount: amount === null ? null : 0,
        flags: [...(estimatedSlice(s) ? ["estimated"] : []), ...(s.writesReported ? [] : ["cache_write_not_reported"]), ...(amount === null ? ["not_priced"] : []), ...(unknownSource(s) ? ["source_unknown"] : [])] };
      dailyBy.set(dk, d);
    }
    addTotals(d, s.tot, s.reasoning);
    if (reported && !d.flags.includes("cost_reported")) d.flags.push("cost_reported");
    if (amount !== null && d.amount !== null) d.amount += amount;
  }
  const allDaily = [...dailyBy.values()].sort((a, b) => a.date.localeCompare(b.date) || a.instance.localeCompare(b.instance) || a.model.localeCompare(b.model) || a.zone.localeCompare(b.zone));
  // Too many: the latest whole days that fit — never part of a day (a missing row would read as nothing used). Not even
  // the latest day fits: no daily rows at all, said so (dailyTruncated with no dailyFrom).
  let dailyFrom: string | null = null, daily = allDaily, truncated = false;
  const cap = input.dailyMax ?? USAGE_DAILY_MAX;
  if (allDaily.length > cap) {
    truncated = true;
    const perDate = new Map<string, number>();
    for (const d of allDaily) perDate.set(d.date, (perDate.get(d.date) ?? 0) + 1);
    let kept = 0;
    for (const date of [...perDate.keys()].sort().reverse()) {
      if (kept + perDate.get(date)! > cap) break;
      kept += perDate.get(date)!; dailyFrom = date;
    }
    daily = dailyFrom === null ? [] : allDaily.filter(d => d.date >= dailyFrom!);
  }

  // Messages: delivered, per instance and hour (§5.4); placed on days the same way as tokens.
  const messagesDaily = new Map<string, { date: string; instance: string; count: number }>();
  const perInstance = new Map<string, number>();
  for (const m of input.messages) {
    const date = localDate(m.hour, input.zone);
    if (!inRange(date)) continue;
    perInstance.set(m.instance, (perInstance.get(m.instance) ?? 0) + m.count);
    const k = `${date}\u0000${m.instance}`;
    const e = messagesDaily.get(k) ?? (messagesDaily.set(k, { date, instance: m.instance, count: 0 }), messagesDaily.get(k)!);
    e.count += m.count;
  }
  const instTeam = new Map(input.instances.map(i => [i.name, i]));
  if (input.group === "instance" || input.group === "backend" || input.group === "team") {
    // An instance with messages but no measured tokens still gets a row (its tokens are not measured; it says so). A
    // message is counted per instance only, so by backend it goes under the instance's backend now.
    for (const [name, count] of perInstance) {
      const i = instTeam.get(name);
      const key = input.group === "instance" ? name : input.group === "backend" ? (i?.backend ?? "") : (i?.team ?? "");
      const row = rows.get(key) ?? (rows.set(key, newRow(key)), rows.get(key)!);
      row.messages = (row.messages ?? 0) + count;
      uniq(row.instances, name);
      if (i) uniq(row.backends, i.backend);
    }
    for (const row of rows.values()) row.messages ??= 0;
  }

  const finish = (row: Acc): UsageRow => {
    const { _amount, _pricedAny, _unpricedAny, _estAmount, _estPriced, ...rest } = row;
    rest.amountEstimated = _estPriced ? _estAmount : null;
    rest.total = rest.input + rest.output + rest.reasoning + rest.cacheRead + rest.cacheWrite5m + rest.cacheWrite1h + rest.cacheWrite;
    rest.amount = _pricedAny ? _amount : null;
    rest.priced = _pricedAny ? (_unpricedAny ? "partial" : "all") : "none";
    if (_unpricedAny) uniq(rest.flags, "not_priced");
    return rest;
  };
  const out = [...rows.values()].map(finish)
    .sort((a, b) => (b.amount ?? -1) - (a.amount ?? -1) || b.total - a.total || a.key.localeCompare(b.key));
  const totals = finish(newRow("all"));
  for (const r of out) {
    for (const k of ["input", "output", "reasoning", "cacheRead", "cacheWrite5m", "cacheWrite1h", "cacheWrite", "requests"] as const) totals[k] += r[k];
    totals.total += r.total;
    if (r.messages !== null) totals.messages = (totals.messages ?? 0) + r.messages;
    if (r.amount !== null) totals.amount = (totals.amount ?? 0) + r.amount;
    if (r.reasoningReported) totals.reasoningReported = true;
    if (r.estimated) { totals.estimated = true; uniq(totals.flags, "includes_estimates"); }
    if (r.amountEstimated !== null) totals.amountEstimated = (totals.amountEstimated ?? 0) + r.amountEstimated;
    for (const f of r.flags) if (f !== "estimated") uniq(totals.flags, f);
    for (const m of r.unpriced) uniq(totals.unpriced, m);
  }
  totals.priced = out.some(r => r.priced !== "none") ? (out.some(r => r.priced !== "all" && r.total > 0) ? "partial" : "all") : "none";

  return {
    range: { kind: input.range.kind, from, to }, zone: input.zone, granularity: "hour", basis: usageBasis(), pricesChecked: PRICES_CHECKED,
    group: input.group, rows: out, totals,
    daily, dailyTruncated: truncated, dailyFrom,
    // Messages by day: the same window as the daily rows (none when there are none); their total stays in `totals`.
    messagesDaily: [...messagesDaily.values()].filter(m => !truncated || (dailyFrom !== null && m.date >= dailyFrom))
      .sort((a, b) => a.date.localeCompare(b.date) || a.instance.localeCompare(b.instance)),
    notMeasured, shared, coverage, scanning: input.scanning,
  };
}
