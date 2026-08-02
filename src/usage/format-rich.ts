/**
 * Rich chat rendering for the usage payload — the pretty counterpart of
 * `formatUsageSummary` (which stays as the plain-text/MCP shape).
 *
 * One structural core, two serialisers, because the platforms disagree about
 * markup: Discord renders Markdown in ordinary message content natively (no
 * adapter change needed — embeds would have meant growing the ChannelAdapter
 * interface for one command), while Telegram needs `parse_mode: HTML` and
 * entity-escaped text. The block-character bars are identical on both: █ and ░
 * are the same advance width even in proportional fonts, so the bars line up
 * without a code block.
 */
import type { ProviderUsage, UsageMetric } from "./providers.js";
import type { UsagePayload } from "./usage-api.js";

const BAR_WIDTH = 10;

/** `████░░░░░░` for 40%. Clamped — a vendor "105% used" must not overflow. */
export function usageBar(percent: number): string {
  const filled = Math.round(Math.min(100, Math.max(0, percent)) / 100 * BAR_WIDTH);
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

function statusDot(p: ProviderUsage): string {
  if (p.status === "error") return "🔴";
  if (p.status === "no-credentials") return "⚪";
  // Highest metric drives the colour: the reader scans for "which one is hot".
  const hottest = Math.max(0, ...p.metrics.map(metricPercent).filter((v): v is number => v !== null));
  return hottest >= 90 ? "🔴" : hottest >= 70 ? "🟡" : "🟢";
}

/** A metric's fill percentage, when one can honestly be computed. */
function metricPercent(m: UsageMetric): number | null {
  if (m.type === "percent" && typeof m.used === "number") return m.used;
  if (m.type === "dollars" && typeof m.used === "number" && m.limit) return (m.used / m.limit) * 100;
  return null;
}

function resetSuffix(resetsAt?: string | null): string {
  if (!resetsAt) return "";
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return "";
  const hours = Math.round((at.getTime() - Date.now()) / 3_600_000);
  if (hours <= 0) return "";
  return hours >= 48 ? ` · resets in ${Math.round(hours / 24)}d` : ` · resets in ${hours}h`;
}

interface MetricLine {
  bar: string | null;
  text: string;
}

function metricLine(m: UsageMetric): MetricLine | null {
  const pct = metricPercent(m);
  switch (m.type) {
    case "percent":
      return {
        bar: usageBar(pct ?? 0),
        // note explains WHICH number this is (e.g. "busiest of 8 models"); it is
        // what stops a legitimate 0% from reading as a broken meter.
        text: `${Math.round(m.used ?? 0)}% ${m.label}${m.note ? ` (${m.note})` : ""}${resetSuffix(m.resetsAt)}`,
      };
    case "dollars": {
      const used = `$${(m.used ?? 0).toFixed(2)}`;
      return m.limit
        ? { bar: usageBar(pct ?? 0), text: `${used}/$${m.limit.toFixed(2)} ${m.label}` }
        : { bar: null, text: `${used} ${m.label}` };
    }
    case "count":
      return { bar: null, text: `${m.label}: ${m.value ?? "?"}${m.unit ? ` ${m.unit}` : ""}` };
    case "text":
      return m.value != null ? { bar: null, text: `${m.label}: ${m.value}` } : null;
  }
}

interface ProviderBlock {
  dot: string;
  name: string;
  plan: string | null;
  note: string | null;      // "not logged in" / error text — instead of metrics
  okHint: string | null;    // context under an ok row's metrics (e.g. staleness)
  lines: MetricLine[];
}

function toBlocks(payload: UsagePayload): ProviderBlock[] {
  return payload.providers.map(p => ({
    dot: statusDot(p),
    name: p.name,
    plan: p.plan ?? null,
    // An ok row can carry a hint too — e.g. "cached 3m ago — live query is rate
    // limited" from the stale fallback. Shown under the metrics, not instead of
    // them, so old numbers still read as numbers.
    note: p.status === "no-credentials" ? "not logged in"
      : p.status === "error" ? `⚠️ ${p.error ?? "error"}`
        : null,
    okHint: p.status === "ok" && p.hint ? p.hint : null,
    lines: p.status === "ok" ? p.metrics.map(metricLine).filter((l): l is MetricLine => l !== null) : [],
  }));
}

/** Discord: native Markdown in plain message content. */
export function renderUsageMarkdown(payload: UsagePayload): string {
  const out: string[] = ["📊 **AI Subscription Usage**"];
  for (const b of toBlocks(payload)) {
    out.push("", `${b.dot} **${b.name}**${b.plan ? ` (${b.plan})` : ""}`);
    if (b.note) { out.push(`> ${b.note}`); continue; }
    if (b.lines.length === 0) { out.push("> no data"); continue; }
    for (const l of b.lines) {
      out.push(l.bar ? `\`${l.bar}\` ${l.text}` : l.text);
    }
    if (b.okHint) out.push(`> ${b.okHint}`);
  }
  return out.join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Telegram: HTML parse mode. Every payload-derived string is entity-escaped —
 * provider errors and metric labels come from vendor responses, and one stray
 * `<` would make Telegram reject the whole message.
 */
export function renderUsageHtml(payload: UsagePayload): string {
  const out: string[] = ["📊 <b>AI Subscription Usage</b>"];
  for (const b of toBlocks(payload)) {
    out.push("", `${b.dot} <b>${escapeHtml(b.name)}</b>${b.plan ? ` (${escapeHtml(b.plan)})` : ""}`);
    if (b.note) { out.push(escapeHtml(b.note)); continue; }
    if (b.lines.length === 0) { out.push("no data"); continue; }
    for (const l of b.lines) {
      out.push(l.bar ? `<code>${l.bar}</code> ${escapeHtml(l.text)}` : escapeHtml(l.text));
    }
    if (b.okHint) out.push(escapeHtml(b.okHint));
  }
  return out.join("\n");
}
