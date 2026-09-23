/**
 * AI usage HTTP API.
 *
 *   GET /api/ai-usage → { fetchedAt, providers: [...] } — live subscription
 *   usage for providers used by running or paused instances (see providers.ts).
 *
 * Auth: read-only GET, open like the other /view data routes (the caller's
 * global token gate exempts isUsagePath, mirroring isViewPath). Server binds
 * 127.0.0.1 only. Disabled entirely with `web.usage_panel: false` in fleet.yaml.
 *
 * Vendors rate-limit their usage endpoints aggressively, so responses are
 * cached for 5 minutes with in-flight dedup; `?force=1` bypasses the cache.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FleetConfig } from "../types.js";
import type { Logger } from "pino";
import { fetchAllUsage, type ProviderUsage, type UsageMetric } from "./providers.js";
import { t } from "../locale.js";
import { usageResetText, usageText } from "./i18n.js";

export interface UsageApiContext {
  readonly fleetConfig: FleetConfig | null;
  readonly logger: Logger;
  /** Providers used by running or paused fleet/Classic instances. */
  getActiveUsageProviderIds?(): ReadonlySet<string>;
}

export type UsagePayload = { fetchedAt: string; providers: ProviderUsage[] };

/** Keep primary account limits even at zero; hide only unused per-model noise. */
export function isVisibleUsageMetric(metric: UsageMetric): boolean {
  return !(metric.scope === "model"
    && metric.type === "percent"
    && typeof metric.used === "number"
    && metric.used <= 0);
}

/** Map runtime backend names to the subscription provider row they consume. */
export function usageProviderIdForBackend(backend: string | undefined): string | null {
  switch (backend) {
    case "claude-code": return "claude";
    case "codex": return "codex";
    case "grok": return "grok";
    case "kiro-cli": return "kiro";
    case "antigravity": return "antigravity";
    default: return null;
  }
}

/** Filter a cached all-provider snapshot without mutating the shared cache. */
export function filterUsageProviders(
  payload: UsagePayload,
  providerIds?: Iterable<string>,
): UsagePayload {
  const active = providerIds
    ? (providerIds instanceof Set ? providerIds : new Set(providerIds))
    : null;
  return {
    ...payload,
    providers: payload.providers
      .filter(provider => !active || active.has(provider.id))
      .map(provider => ({
        ...provider,
        metrics: provider.metrics.filter(isVisibleUsageMetric),
      })),
  };
}

const CACHE_MS = 5 * 60 * 1000;
/** Token rollover is routine and normally heals within seconds. */
const TRANSIENT_CACHE_MS = 30 * 1000;
/**
 * `?force=1` still cannot fire more often than this. Force exists so the panel's
 * refresh button can beat the 5-minute TTL, not so repeated clicks can hammer
 * vendor endpoints — the Anthropic usage endpoint is shared with every
 * claude-code CLI on the same account, which polls it for its own statusline,
 * so our margin there is thinner than it looks.
 */
const FORCE_FLOOR_MS = 30 * 1000;
/** How old a last-good snapshot may be and still stand in for a rate-limited row. */
const STALE_MAX_MS = 60 * 60 * 1000;

let cache: { at: number; ttlMs: number; payload: UsagePayload } | null = null;
let inflight: Promise<UsagePayload> | null = null;
let lastForcedFetchStartedAt: number | null = null;
/** Last successful per-provider rows, for stale-while-rate-limited. */
const lastGood = new Map<string, { at: number; provider: ProviderUsage }>();
// Test seam: lets tests stub the network layer without real credentials.
let fetcher: () => Promise<UsagePayload> = fetchAllUsage;

export function setUsageFetcherForTests(fn: (() => Promise<UsagePayload>) | null): void {
  fetcher = fn ?? fetchAllUsage;
  cache = null;
  inflight = null;
  lastForcedFetchStartedAt = null;
  lastGood.clear();
}

/**
 * Swap rate-limited provider rows for their last good snapshot, visibly.
 *
 * A vendor 429 on OUR usage query says nothing about the user's subscription —
 * showing a red error where numbers stood a minute ago reads as "something
 * broke", when the truth is "the numbers are 3 minutes old". Only rate-limit
 * errors are softened this way: an auth failure or a schema error must stay
 * loud, because stale data would hide a problem the user needs to act on.
 */
function withStaleFallback(payload: UsagePayload): UsagePayload {
  const now = Date.now();
  const providers = payload.providers.map(p => {
    if (p.status === "ok" && p.metrics.length > 0) {
      lastGood.set(p.id, { at: now, provider: p });
      return p;
    }
    if (isTransientEmpty(p)) {
      const good = lastGood.get(p.id);
      if (good && now - good.at < STALE_MAX_MS) {
        const ageMin = Math.max(1, Math.round((now - good.at) / 60_000));
        return {
          ...good.provider,
          hint: `cached ${ageMin}m ago — ${p.hint}`,
        };
      }
      return p;
    }
    if (p.status === "error" && /rate.?limit/i.test(p.error ?? "")) {
      const good = lastGood.get(p.id);
      if (good && now - good.at < STALE_MAX_MS) {
        const ageMin = Math.max(1, Math.round((now - good.at) / 60_000));
        return {
          ...good.provider,
          hint: `cached ${ageMin}m ago — live query is rate limited`,
        };
      }
    }
    return p;
  });
  return { ...payload, providers };
}

function isTransientEmpty(provider: ProviderUsage): boolean {
  return provider.status === "ok"
    && provider.metrics.length === 0
    && /token refreshing/i.test(provider.hint ?? "");
}

function hasTransientEmpty(payload: UsagePayload): boolean {
  return payload.providers.some(isTransientEmpty);
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function usage(force: boolean): Promise<UsagePayload> {
  // A user's first force refresh must work even immediately after an automatic
  // fetch (notably when Kiro refreshed its token just after that fetch). Only
  // repeated force requests are floored to protect vendor endpoints.
  const now = Date.now();
  const effectiveForce = force && (
    lastForcedFetchStartedAt === null
    || now - lastForcedFetchStartedAt >= FORCE_FLOOR_MS
  );
  if (!effectiveForce && cache && now - cache.at < cache.ttlMs) return cache.payload;
  inflight ??= (() => {
    if (effectiveForce) lastForcedFetchStartedAt = Date.now();
    return fetcher()
      .then(payload => {
        const transient = hasTransientEmpty(payload);
        const resolved = withStaleFallback(payload);
        cache = {
          at: Date.now(),
          ttlMs: transient ? TRANSIENT_CACHE_MS : CACHE_MS,
          payload: resolved,
        };
        return resolved;
      })
      .finally(() => { inflight = null; });
  })();
  return inflight;
}

/**
 * The same cached snapshot the HTTP route serves, for in-process callers: the
 * `/usage` slash command and the `get_usage` MCP tool. One cache for all three
 * surfaces, because the 5-minute TTL exists to protect vendor rate limits and a
 * second entry point that bypassed it would defeat that.
 */
export async function getUsageSnapshot(force = false, providerIds?: Iterable<string>): Promise<UsagePayload> {
  return filterUsageProviders(await usage(force), providerIds);
}

/**
 * Render a usage payload as one compact chat message.
 *
 * Plain text on purpose: it is sent through adapter.sendText with no parse mode,
 * so any markup would be shown literally. One line per provider; errors and
 * missing credentials say so inline rather than being silently omitted — "Codex:
 * not logged in" is information, an absent row is a question.
 */
export function formatUsageSummary(payload: UsagePayload): string {
  const lines: string[] = [`📊 ${t("usage.title_plain")}`];
  if (payload.providers.length === 0) {
    lines.push(t("usage.empty_active"));
  }
  for (const provider of payload.providers) {
    const name = provider.plan ? `${provider.name} (${provider.plan})` : provider.name;
    if (provider.status === "no-credentials") {
      lines.push(`· ${name}: ${t("usage.not_logged_in")}`);
      continue;
    }
    if (provider.status === "error") {
      lines.push(`· ${name}: ⚠️ ${usageText(provider.error ?? t("usage.error_fallback"), provider.errorI18n)}`);
      continue;
    }
    if (provider.unlimited) {
      lines.push(`· ${name}: ${t("usage.value.unlimited")}`);
      continue;
    }
    const parts = provider.metrics.filter(isVisibleUsageMetric).map(formatMetric).filter(Boolean);
    const staleness = provider.hint ? ` (${usageText(provider.hint, provider.hintI18n)})` : "";
    lines.push(`· ${name}: ${parts.length ? parts.join(" | ") : t("usage.no_data")}${staleness}`);
  }
  return lines.join("\n");
}

/**
 * Render the compact, public Discord activity line for the current usage
 * snapshot.  Percentage metrics and explicit non-metered entitlements are
 * surfaced; raw provider errors and hints are intentionally not copied into a
 * public presence (they may contain URLs or account-specific detail).
 * Error/expired and missing-login states remain omitted instead of displaying
 * a stale percentage.
 *
 * Discord limits activity names to 128 Unicode code points.  Keep the leading
 * lightning marker and truncate complete code points so a long profile name or
 * many credential profiles cannot make the update fail.
 */
export function formatDiscordUsageActivity(payload: UsagePayload): string {
  const rows = payload.providers.flatMap((provider, index) => {
    const name = provider.name.trim() || provider.id;
    // Presence is a compact live signal, not a diagnostic surface.  Missing
    // credentials, provider errors, and rows without a percentage are omitted
    // entirely, except for explicit unlimited entitlements below; the full
    // /usage output retains other actionable details.
    if (provider.status !== "ok") return [];
    if (provider.unlimited) {
      return [{ text: `${name} ${t("usage.value.unlimited")}`, stale: false, index }];
    }
    // A stale-while-rate-limited row has the old metrics but says so in its
    // hint.  Do not turn an old number into a falsely live presence.
    const percent = provider.metrics
      .filter(isVisibleUsageMetric)
      .filter(metric => metric.type === "percent" && typeof metric.used === "number")
      .sort((a, b) => Number(/weekly/i.test(b.label)) - Number(/weekly/i.test(a.label)))[0];
    if (!percent) return [];
    const stale = /^cached\s+/i.test(provider.hint ?? "");
    if (stale) return [{ text: `${name}: stale`, stale: true, index }];
    const window = /weekly/i.test(percent.label) ? " weekly" : "";
    return [{ text: `${name} ${Math.round(percent.used ?? 0)}%${window}`, stale: false, index }];
  });
  rows.sort((a, b) => Number(a.stale) - Number(b.stale) || a.index - b.index);
  if (rows.length === 0) return "⚡ Usage unavailable";

  // Keep complete provider entries whenever possible.  Provider/profile names
  // are bounded by config validation, so an individual entry fits; truncation
  // only drops later entries and never exposes a half-written percentage.
  const prefix = "⚡ ";
  const kept: string[] = [];
  let truncated = false;
  for (const row of rows) {
    const candidate = `${prefix}${kept.concat(row.text).join(" | ")}`;
    if (Array.from(candidate).length + 1 > 128) {
      truncated = true;
      break;
    }
    kept.push(row.text);
  }
  if (kept.length === 0) return "⚡ Usage unavailable";
  const body = `${prefix}${kept.join(" | ")}`;
  return truncated ? `${body}…` : body;
}

function formatMetric(m: UsageMetric): string {
  const label = usageText(m.label, m.labelI18n);
  const note = m.note ? usageText(m.note, m.noteI18n) : "";
  switch (m.type) {
    case "percent":
      return `${label} ${Math.round(m.used ?? 0)}%${resetSuffix(m.resetsAt)}${note ? ` (${note})` : ""}`;
    case "dollars": {
      const used = `$${(m.used ?? 0).toFixed(2)}`;
      return m.limit ? `${label} ${used}/$${m.limit.toFixed(2)}` : `${label} ${used}`;
    }
    case "count": {
      const unit = m.unit ? usageText(m.unit, m.unitI18n) : "";
      return `${label} ${m.value ?? "?"}${unit ? ` ${unit}` : ""}${note ? ` (${note})` : ""}`;
    }
    case "text": {
      const value = m.value != null ? usageText(String(m.value), m.valueI18n) : null;
      return value != null ? `${label} ${value}${note ? ` (${note})` : ""}` : "";
    }
  }
}

function resetSuffix(resetsAt?: string | null): string {
  const text = usageResetText(resetsAt);
  return text ? ` (${text})` : "";
}

/** True if the path belongs to the usage feature (so the caller can skip the
 * global web-token gate and let this module answer, like isViewPath). */
export function isUsagePath(path: string): boolean {
  return path === "/api/ai-usage";
}

/**
 * Handle a usage API request. Returns true if the request was ours (and has
 * been answered), false otherwise.
 */
export function handleUsageRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: UsageApiContext,
): boolean {
  if (!isUsagePath(url.pathname)) return false;

  if (ctx.fleetConfig?.web?.usage_panel === false) {
    json(res, 404, { error: "usage panel disabled" });
    return true;
  }
  if ((req.method ?? "GET") !== "GET") {
    json(res, 405, { error: "method not allowed" });
    return true;
  }

  getUsageSnapshot(url.searchParams.has("force"), ctx.getActiveUsageProviderIds?.())
    .then(payload => json(res, 200, payload))
    .catch(err => {
      ctx.logger.debug({ err }, "ai-usage fetch failed");
      json(res, 500, { error: String((err as Error)?.message ?? err) });
    });
  return true;
}
