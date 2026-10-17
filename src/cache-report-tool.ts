/**
 * #2001: get_cache_report's answer — the cache report (cache-service.ts, the same as GET /ui/cache) shaped for an
 * agent: one compact row per instance, the costliest expiries first, at most `top` analysed rows; the fleet summary
 * only for a caller who reads the fleet. Pure: the report comes from CacheService.published (no transcript read).
 */
import type { CacheReport, InstanceReport } from "./cache-service.js";
import type { InstanceAnalysis } from "./cache-analysis.js";

export const CACHE_REPORT_TOP_DEFAULT = 10;

export interface CacheReportQuery {
  /** "fleet": every row and the fleet summary; "own": only `caller`'s row. */
  scope: "fleet" | "own";
  caller: string;
  instance?: string;
  top?: number;
}

const ttlText = (sec: number | null): string | null => (sec === null ? null : sec >= 3600 ? `${sec / 3600}h` : `${Math.round(sec / 60)}m`);
const round = (n: number): number => Math.round(n * 1e4) / 1e4;

function row(r: InstanceReport): Record<string, unknown> {
  const a = r.analysis as InstanceAnalysis, s = a.sim, e = a.effectiveTtl;
  const writes = a.writeMix["5m"] + a.writeMix["1h"];
  return {
    name: r.name, backend: r.backend, status: r.status, models: a.models, requests: a.requests,
    ttl_written: ttlText(a.ttlSec),
    write_mix: { "5m_tokens": a.writeMix["5m"], "1h_tokens": a.writeMix["1h"], "1h_share": writes ? round(a.writeMix["1h"] / writes) : null },
    effective_ttl: { ttl: ttlText(e.ttlSec), basis: e.basis, five_minute_measured_as: ttlText(e.fiveMinute), gap_miss: { gaps: e.sample, rewritten: e.misses, rate: e.rate === null ? null : round(e.rate) } },
    past_ttl: s.pastTtl, expired: s.expired, rewrite_tokens: s.rewriteTokens,
    unit: a.priced ? "usd" : "input_price_units",
    expiry_cost: round(s.expiryCost), share_of_cost: a.share === null ? null : round(a.share),
    keep_warm: { pings: s.pings + s.tailPings, pings_after_last_request: s.tailPings, ping_cost: round(s.pingCost + s.tailCost), net: round(s.net) },
    recommendation: a.recommendation,
    estimate: a.estimate,
  };
}

export function cacheReportForTool(report: CacheReport, q: CacheReportQuery): Record<string, unknown> | { error: string } {
  const name = q.scope === "own" ? q.caller : q.instance;
  if (q.scope === "own" && q.instance !== undefined && q.instance !== q.caller) {
    return { error: `get_cache_report: you may read only your own row (${q.caller}); General, coordinators and full-profile instances read the fleet.` };
  }
  const rows = name === undefined ? report.instances : report.instances.filter((r) => r.name === name);
  if (name !== undefined && !rows.length) return { error: `get_cache_report: no instance named ${name}` };
  const ok = rows.filter((r) => r.status === "ok" && r.analysis)
    .sort((x, y) => (Number(y.analysis!.priced) - Number(x.analysis!.priced)) || (y.analysis!.sim.expiryCost - x.analysis!.sim.expiryCost));
  const top = name === undefined ? Math.max(1, Math.min(50, q.top ?? CACHE_REPORT_TOP_DEFAULT)) : ok.length;
  return {
    window: report.window, from: new Date(report.from).toISOString(), to: new Date(report.to).toISOString(),
    scope: q.scope, prices_checked: report.pricesChecked, scanning: report.scanning,
    ...(q.scope === "fleet" && name === undefined ? { fleet: report.fleet } : {}),
    instances: ok.slice(0, top).map(row),
    ...(ok.length > top ? { omitted: ok.length - top } : {}),
    other: rows.filter((r) => r.status !== "ok" || !r.analysis).map((r) => ({ name: r.name, backend: r.backend, status: r.status, ...(r.with ? { with: r.with } : {}) })),
  };
}
