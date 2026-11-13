/** Agent-only projections. Never change the shared web/slash snapshots or their caches. */
import type { UsagePayload, UsageCapacity } from "./usage-api.js";
import type { UsageMetric, ProviderUsage } from "./providers.js";
import type { UsageReport } from "../usage-report.js";

const number = (n: number): string => Number.isFinite(n) ? String(Math.round(n * 10) / 10) : "unknown";
const label = (m: UsageMetric): string => m.pool ? `${m.pool.label} / ${m.label}` : m.label;

function time(iso: string | null | undefined, now: number, kind: "reset" | "expires"): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return ` (${kind} unknown)`;
  if (ms <= 0) return ` (${kind === "reset" ? "reset due" : "expired"})`;
  const minutes = Math.ceil(ms / 60_000);
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), mins = minutes % 60;
  const duration = days ? `${days}d${hours ? `${hours}h` : ""}` : hours ? `${hours}h${mins ? `${mins}m` : ""}` : `${mins}m`;
  return ` (${kind} ${duration})`;
}

function metric(m: UsageMetric, now: number): string {
  let value: string;
  if (m.resetPassed) value = "unknown (previous window reset)";
  else if (m.type === "percent") value = m.used === undefined ? "unknown" : `${number(m.used)}%`;
  else if (m.type === "dollars") value = m.used === undefined ? "unknown" : `$${m.used.toFixed(2)}${m.limit === undefined ? "" : `/$${m.limit.toFixed(2)}`}`;
  else value = `${m.value ?? "unknown"}${m.unit ? ` ${m.unit}` : ""}`;
  // An expiring allowance (bonus credits) is not a refilling quota.
  const reset = time(m.resetsAt, now, m.resetKind === "expiry" ? "expires" : "reset");
  const expiry = time(m.expiresAt, now, "expires");
  return `${label(m)} ${value}${reset}${expiry}${m.note && !/^binding\b/.test(m.note) ? ` · ${m.note}` : ""}`;
}

function account(p: ProviderUsage, now: number) {
  const binding = p.metrics.filter(m => /^binding\b/.test(m.note ?? "")).map(label);
  const status = [
    p.status !== "ok" ? p.status : "",
    p.stale ? `stale${p.staleCause ? ` (${p.staleCause})` : ""}` : p.transient ? "temporarily unavailable" : "",
    p.cachedAt ? `cached ${p.cachedAt}` : "",
    ...new Set([p.error, p.hint].filter(Boolean)),
  ].filter(Boolean).join("; ");
  return {
    name: p.name,
    ...(p.profile ? { profile: p.profile } : {}),
    ...(p.plan ? { plan: p.plan } : {}),
    ...(p.unlimited ? { unlimited: true } : {}),
    windows: p.metrics.map(m => metric(m, now)),
    // Only vendor-reported binding evidence; highest percentage alone is not proof.
    ...(binding.length ? { binding } : {}),
    ...(status ? { status } : {}),
  };
}

export function agentUsage(payload: UsagePayload, detail = false, now = Date.now()) {
  if (detail) return payload;
  const hasCapacity = payload.providers.some(p => p.metrics.some(m => !!(m as UsageMetric & { capacity?: UsageCapacity }).capacity));
  return {
    fetchedAt: payload.fetchedAt,
    ...(payload.refreshing ? { refreshing: true } : {}),
    providers: payload.providers.map(p => account(p, now)),
    ...(hasCapacity ? { note: "Counts only this fleet's agents; use of the same account elsewhere makes capacity estimates low. detail:true includes capacity." } : {}),
  };
}

/** The report has already been scoped to the caller before it reaches this projection. */
export function agentUsageReport(r: UsageReport, top = 10, detail = false) {
  const row = (value: UsageReport["totals"]) => {
    if (detail) return { ...value, basis: r.basis };
    const { speed: _speed, ...compact } = value;
    return compact;
  };
  return {
    basis: r.basis, range: r.range, zone: r.zone, granularity: r.granularity, group: r.group,
    rows: r.rows.slice(0, top).map(row), more: Math.max(0, r.rows.length - top),
    totals: row(r.totals), notMeasured: r.notMeasured, shared: r.shared, scanning: r.scanning,
  };
}
