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
import { fetchAllUsage, isHostLoginUsageProvider, type ProviderUsage, type UsageMetric, type UsageStaleCause } from "./providers.js";
import { museUsageRevision } from "../muse-usage-relay.js";
import { readFileSync, statSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgendHome } from "../paths.js";
import { t } from "../locale.js";
import { usageExpiryText, usageResetSinceText, usageResetText, usageRowName, usageStaleText, usageText } from "./i18n.js";
import { guestRequestOf } from "../web-guest-access.js";
import { quotaHistoryOffForTests, recordQuotaReadings } from "./quota-history.js";
import type { CapacityBasis, CapacityEstimate } from "./capacity.js";
import type { UsageI18nRef } from "./providers.js";

export interface UsageApiContext {
  readonly fleetConfig: FleetConfig | null;
  readonly logger: Logger;
  /** Providers used by running or paused fleet/Classic instances. */
  getActiveUsageProviderIds?(): ReadonlySet<string>;
}

/**
 * `refreshing` (#1585): this is the last snapshot, served while a fresh one is being fetched — `fetchedAt` says how old
 * it is. Only the dashboard panel is ever answered this way; chat, tools and Discord presence wait for a fresh one.
 */
export type UsagePayload = { fetchedAt: string; providers: ProviderUsage[]; refreshing?: boolean };

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
    case "muse": return "muse";
    default: return null;
  }
}

/** Filter a cached all-provider snapshot without mutating the shared cache. */
export function filterUsageProviders(
  payload: UsagePayload,
  providerIds?: Iterable<string>,
  opts: { hostLogins?: boolean } = {},
): UsagePayload {
  const active = providerIds
    ? (providerIds instanceof Set ? providerIds : new Set(providerIds))
    : null;
  return {
    ...payload,
    providers: payload.providers
      // #2236: with `hostLogins`, a Claude login on the host stays though no running instance uses it.
      .filter(provider => !active || active.has(provider.id) || (opts.hostLogins === true && isHostLoginUsageProvider(provider.id)))
      .map(provider => ({
        ...provider,
        metrics: provider.metrics.filter(isVisibleUsageMetric),
      })),
  };
}

/** Completed owned reads only; observers never trigger additional provider calls. */
const usageObservers = new Set<(payload: UsagePayload) => void>();
export function onUsageSnapshot(observer: (payload: UsagePayload) => void): () => void {
  usageObservers.add(observer); return () => { usageObservers.delete(observer); };
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
/** How old an expired snapshot may be and still be answered at once to the dashboard panel (#1585). */
const STALE_MAX_MS = 60 * 60 * 1000;
/**
 * How old a provider's last good numbers may be and still stand in for a failed read: a week. Older weekly numbers
 * say nothing; a window that has reset since is marked as such (`resetPassed`) at any age.
 */
const LAST_KNOWN_MAX_MS = 7 * 24 * 60 * 60 * 1000;
/** Cap for Retry-After backoff. Prevents a single 429 from locking /usage for days.
 * Note: the backoff is global — one provider's 429 blocks force-refresh for all
 * providers (because fetchAllUsage fetches all at once). Per-provider backoff would
 * require a larger refactor; this is an accepted trade-off. */
const RETRY_AFTER_MAX_MS = 15 * 60 * 1000; // 15 minutes

let cache: { at: number; ttlMs: number; payload: UsagePayload; owner: UsageOwner } | null = null;

/**
 * #1585: which fleet config a snapshot was taken under — fleet.yaml's and classicBot.yaml's size and mtime. A snapshot
 * is served, fresh or stale, and an in-flight fetch is joined, only under the config it was fetched for: a credential
 * profile or binding added, removed or moved since means another set of accounts, so that read waits for its own
 * fetch. Metadata only; at most every 5 s. `null` when a file's metadata cannot be read (anything but ENOENT): an unknown
 * config matches nothing, not even another unknown one, and is not remembered.
 */
let configKeyMemo: { at: number; key: string } | null = null;
const CONFIG_KEY_MS = 5_000;
function usageConfigKey(now = Date.now()): string | null {
  if (configKeyMemo && now - configKeyMemo.at < CONFIG_KEY_MS) return configKeyMemo.key;
  const parts: string[] = [];
  for (const f of ["fleet.yaml", "classicBot.yaml"]) {
    try {
      const st = statSync(join(getAgendHome(), f));
      parts.push(`${f}:${st.size}:${st.mtimeMs}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
      parts.push(`${f}:-`);                                  // known to be absent
    }
  }
  configKeyMemo = { at: now, key: parts.join("|") };
  return configKeyMemo.key;
}
/** The config a snapshot or a fetch belongs to: the fleet config and the Muse usage revision. */
type UsageOwner = { configKey: string | null; museRevision: number };
const sameOwner = (a: UsageOwner, b: UsageOwner) =>
  a.configKey !== null && a.configKey === b.configKey && a.museRevision === b.museRevision;
let inflight: { promise: Promise<UsagePayload>; owner: UsageOwner } | null = null;
let lastForcedFetchStartedAt: number | null = null;
/**
 * Last successful per-provider rows: a failed read shows these, marked (withStaleFallback). Kept on disk too
 * (usage-last-good.json in AGEND_HOME), so a restart with an expired token still shows the numbers it had.
 */
type LastGood = { at: number; provider: ProviderUsage };
const lastGood = new Map<string, LastGood>();
/** Where lastGood persists (null: memory only, as in tests); read once, on first use. */
let lastGoodFile: (() => string) | null = () => join(getAgendHome(), "usage-last-good.json");
let lastGoodLoaded = false;
let lastGoodWrite: Promise<void> = Promise.resolve();
/** Retry-After deadline per provider: do not fetch until after this timestamp. */
const retryAfterUntil = new Map<string, number>();
// Test seam: lets tests stub the network layer without real credentials.
let fetcher: () => Promise<UsagePayload> = fetchAllUsage;

export function setUsageFetcherForTests(fn: (() => Promise<UsagePayload>) | null): void {
  fetcher = fn ?? fetchAllUsage;
  cache = null;
  configKeyMemo = null;
  inflight = null;
  lastForcedFetchStartedAt = null;
  lastGood.clear();
  lastGoodFile = null;
  lastGoodLoaded = true;
  quotaHistoryOffForTests();
  retryAfterUntil.clear();
}

/** Tests: persist lastGood at `path` (read it on the next use), or not at all (null). */
export function setUsageLastGoodFileForTests(path: string | null): Promise<void> {
  lastGoodFile = path === null ? null : () => path;
  lastGoodLoaded = false;
  return lastGoodWrite;
}

/** The latest time a Date can hold (ECMAScript: ±8.64e15 ms). */
const MAX_DATE_MS = 8.64e15;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const opt = (v: unknown, ok: (x: unknown) => boolean) => v === undefined || ok(v);
const isStr = (v: unknown) => typeof v === "string";
const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const isTime = (v: unknown) => v === null || (typeof v === "string" && Number.isFinite(Date.parse(v)));
const isI18n = (v: unknown) => isObj(v) && typeof v.key === "string"
  && opt(v.args, a => Array.isArray(a) && a.every(x => typeof x === "string" || isNum(x)));

/** A metric as the renderers read it: every field it has is of its type (a persisted file is not trusted). */
function isUsageMetric(v: unknown): v is UsageMetric {
  return isObj(v) && isStr(v.label) && (v.type === "percent" || v.type === "dollars" || v.type === "count" || v.type === "text")
    && opt(v.labelI18n, isI18n) && opt(v.scope, x => x === "model") && opt(v.used, isNum) && opt(v.limit, isNum)
    && opt(v.value, x => isNum(x) || isStr(x)) && opt(v.valueI18n, isI18n) && opt(v.unit, isStr) && opt(v.unitI18n, isI18n)
    && opt(v.note, isStr) && opt(v.noteI18n, isI18n) && opt(v.resetsAt, isTime) && opt(v.resetKind, x => x === "expiry")
    && opt(v.expiresAt, isTime) && opt(v.windowMs, x => x === null || isNum(x)) && opt(v.resetPassed, x => x === true)
    && opt(v.pool, x => isObj(x) && isStr(x.label) && opt(x.labelI18n, isI18n));
}

/**
 * A persisted entry, checked whole before it is admitted (Prism #2257 P2): a good read at a time a Date can hold, not in
 * the future, of a row whose every field is of its type. One bad entry is skipped; the rest still load.
 */
function isLastGood(v: unknown, now: number): v is LastGood {
  if (!isObj(v) || !isNum(v.at) || (v.at as number) > now || (v.at as number) < -MAX_DATE_MS) return false;
  const p = v.provider;
  return isObj(p) && isStr(p.id) && isStr(p.name) && p.status === "ok" && Array.isArray(p.metrics) && p.metrics.every(isUsageMetric)
    && opt(p.plan, x => x === null || isStr(x)) && opt(p.unlimited, x => typeof x === "boolean") && opt(p.profile, isStr)
    && opt(p.defaultLogin, x => x === true) && opt(p.hint, isStr) && opt(p.hintI18n, isI18n);
}

/** Read the persisted rows once (a missing or unreadable file is no rows); a row read since wins. */
function loadLastGood(now: number): void {
  if (lastGoodLoaded) return;
  lastGoodLoaded = true;
  if (!lastGoodFile) return;
  try {
    const data = JSON.parse(readFileSync(lastGoodFile(), "utf8")) as { v?: number; rows?: Record<string, unknown> };
    if (data?.v !== 1 || !data.rows || typeof data.rows !== "object") return;
    for (const [id, entry] of Object.entries(data.rows)) {
      if (!isLastGood(entry, now) || entry.provider.id !== id || now - entry.at >= LAST_KNOWN_MAX_MS || lastGood.has(id)) continue;
      lastGood.set(id, entry);
    }
  } catch { /* none yet, or unreadable: memory only until the next good read */ }
}

/** Write the rows (atomically: a temp file renamed over it), one write at a time, off the fleet's loop. */
function saveLastGood(): void {
  if (!lastGoodFile) return;
  const path = lastGoodFile();
  const body = JSON.stringify({ v: 1, rows: Object.fromEntries(lastGood) });
  lastGoodWrite = lastGoodWrite.then(async () => {
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, path);
  }).catch(() => { /* the next good read writes again */ });
}

/**
 * Transient fetch failures — a network jitter, a timed-out query, an overloaded vendor's 5xx: like a 429 they say
 * nothing about the user's subscription, so their last known numbers are marked "transient" (when, nothing more).
 * Every other failure (an expired or refused login, a schema error) keeps its numbers too since #2236's follow-up,
 * marked "expired" or "error" with the error itself beside them — never hidden (withStaleFallback).
 */
const TRANSIENT_ERROR_PATTERNS = [
  /could not reach/i, // provider fail-soft rows (fetch + 16s-deadline alike)
  /timed? ?out/i, /deadline/i, // timeouts surfacing raw past the fetch wrappers
  /econnreset|econnrefused|econnaborted|epipe/i,
  /eai_again|enotfound/i, // DNS blips
  /socket hang up|fetch failed|network/i,
  /\b5\d{2}\b|bad gateway|service unavailable|gateway timeout/i, // any HTTP 5xx: vendors report every non-2xx as `Usage request failed (HTTP <status>)`
];

function isTransientFailure(p: ProviderUsage): boolean {
  return p.status === "error"
    && TRANSIENT_ERROR_PATTERNS.some(re => re.test(p.error ?? ""));
}

/**
 * Usage copy keys whose error means the login's token expired or was refused: the row says "expired" and the error is
 * how to refresh it.
 */
const EXPIRED_ERROR_KEYS = new Set<string>([
  "usage.error.token_rejected", "usage.error.claude_token_expired", "usage.error.codex_token_expired",
  "usage.error.grok_expired", "usage.error.agy_no_refresh", "usage.error.agy_token_expired",
  "usage.error.agy_login_expired", "usage.error.grok_auth_readonly", "usage.error.grok_no_refresh",
]);
function isExpiredFailure(p: ProviderUsage): boolean {
  return EXPIRED_ERROR_KEYS.has(p.errorI18n?.key ?? "")
    || /expired|unauthori[sz]ed|\b401\b|\b403\b|invalid api key|token (?:was )?(?:rejected|revoked)/i.test(p.error ?? "");
}

/**
 * A metric of the last known numbers whose window has reset since they were read: its number is dropped (it was for
 * a window that has ended) and it says so. An expiry (`resetKind: "expiry"`) is not a reset and is left alone.
 */
function ageMetric(m: UsageMetric, now: number): UsageMetric {
  if (!m.resetsAt || m.resetKind === "expiry") return m;
  const at = Date.parse(m.resetsAt);
  if (!(at <= now)) return m;
  const { used: _used, value: _value, valueI18n: _valueI18n, ...rest } = m;
  return { ...rest, resetPassed: true };
}

/**
 * A failed read's row, shown as its last known numbers: marked `stale` with when they were read (`cachedAt`) and why
 * (`staleCause`); `hint` says what to do (an expiry or another error) or how old the numbers are (a transient failure).
 * Never made up: with no good read in the last week, the failed row stands as it is.
 */
function lastKnown(p: ProviderUsage, now: number, cause: UsageStaleCause, hint: Pick<ProviderUsage, "hint" | "hintI18n">): ProviderUsage | null {
  const good = lastGood.get(p.id);
  if (!good || now - good.at >= LAST_KNOWN_MAX_MS) return null;
  try { return lastKnownRow(p, good, now, cause, hint); } catch { return null; }   // never break the read: the error row stands
}
function lastKnownRow(p: ProviderUsage, good: LastGood, now: number, cause: UsageStaleCause, hint: Pick<ProviderUsage, "hint" | "hintI18n">): ProviderUsage {
  const { hint: _hint, hintI18n: _hintI18n, profile: _profile, defaultLogin: _defaultLogin, ...row } = good.provider;
  return {
    ...row,
    // The row as it is now (its name, a profile, the default login), with the numbers as they were.
    id: p.id, name: p.name, ...(p.profile ? { profile: p.profile } : {}), ...(p.defaultLogin ? { defaultLogin: true as const } : {}),
    stale: true, cachedAt: new Date(good.at).toISOString(), staleCause: cause,
    ...(hint.hint !== undefined ? { hint: hint.hint } : {}), ...(hint.hintI18n ? { hintI18n: hint.hintI18n } : {}),
    metrics: good.provider.metrics.map(m => ageMetric(m, now)),
  };
}

/**
 * A row whose live read failed keeps its last known numbers, marked (#2236 follow-up, the user's request): a token
 * that expired, a rate limit, a network blip or any other failure shows the numbers from the last good read, with when
 * that was and what went wrong, instead of wiping the row. A provider never read successfully keeps its error row.
 * A good read replaces them (and clears the mark).
 */
function withStaleFallback(payload: UsagePayload): UsagePayload {
  const now = Date.now();
  loadLastGood(now);
  let changed = false;
  const providers = payload.providers.map(p => {
    if (p.status === "ok" && p.metrics.length > 0) {
      lastGood.set(p.id, { at: now, provider: p });
      recordQuotaReadings(p, now);                         // #3066 §1d: the weekly percent over time (only when it moved)
      changed = true;
      return p;
    }
    const ageMin = (): number => Math.max(1, Math.round((now - (lastGood.get(p.id)?.at ?? now)) / 60_000));
    const transientHint = (why: string): Pick<ProviderUsage, "hint" | "hintI18n"> => ({
      hint: `cached ${ageMin()}m ago — ${why}`,
      hintI18n: { key: "usage.stale_rate_limited" as import("./i18n-keys.js").UsageI18nKey, args: [ageMin()] },
    });
    if (isTransientEmpty(p)) return lastKnown(p, now, "transient", transientHint(p.hint ?? "")) ?? p;
    if (p.status === "error" && /rate.?limit/i.test(p.error ?? "")) {
      // Parse Retry-After from the hint field (set by providers.ts on 429)
      const retryAfterMatch = p.hint?.match(/^retry-after:(\d+)$/);
      if (retryAfterMatch) {
        const seconds = parseInt(retryAfterMatch[1], 10);
        // Cap the backoff so a large Retry-After (e.g. 86400) cannot lock /usage
        // for all providers for an excessive time. Note: parseInt of an HTTP-date
        // Retry-After format returns NaN, which falls back to 60 s — acceptable.
        const cappedMs = Math.min(seconds * 1000, RETRY_AFTER_MAX_MS);
        retryAfterUntil.set(p.id, now + cappedMs);
        // Prune any expired entries from previous fetches.
        for (const [id, until] of retryAfterUntil) { if (until <= now) retryAfterUntil.delete(id); }
      }
      const known = lastKnown(p, now, "transient", transientHint("live query is rate limited"));
      if (known) return known;
      // No stale data: use a gentler message and mark as transient so format-rich
      // shows a neutral icon instead of alarming 🔴.
      return {
        ...p,
        transient: true,
        hint: undefined,
        error: p.error,
        errorI18n: { key: "usage.error.rate_limited_transient" as import("./i18n-keys.js").UsageI18nKey, args: [p.name] },
      };
    }
    if (isTransientFailure(p)) return lastKnown(p, now, "transient", transientHint("live query failed, will retry")) ?? p;
    if (p.status === "error") {
      // An expired login or any other failure: the numbers stay, and the error is what to do about it.
      const detail = { hint: p.error ?? "", ...(p.errorI18n ? { hintI18n: p.errorI18n } : {}) };
      return lastKnown(p, now, isExpiredFailure(p) ? "expired" : "error", detail) ?? p;
    }
    return p;
  });
  if (changed) saveLastGood();
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
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function usage(force: boolean, allowStale = false): Promise<UsagePayload> {
  // A user's first force refresh must work even immediately after an automatic
  // fetch (notably when Kiro refreshed its token just after that fetch). Only
  // repeated force requests are floored to protect vendor endpoints.
  const now = Date.now();
  // Within a Retry-After window, even a force refresh must use the cache.
  const anyBackoffActive = retryAfterUntil.size > 0
    && [...retryAfterUntil.values()].some(until => until > now);
  const effectiveForce = !anyBackoffActive && force && (
    lastForcedFetchStartedAt === null
    || now - lastForcedFetchStartedAt >= FORCE_FLOOR_MS
  );
  const owner: UsageOwner = { configKey: usageConfigKey(now), museRevision: museUsageRevision() };
  const ownCache = cache && sameOwner(cache.owner, owner) ? cache : null;
  if (!effectiveForce && ownCache && now - ownCache.at < ownCache.ttlMs) return ownCache.payload;
  // An unknown config is served nothing cached, and vendors are still called no more often than the TTL allows: within
  // the last fetch's TTL such a read fails (every caller reports a failed read) instead of starting another round.
  if (owner.configKey === null && !effectiveForce && cache && now - cache.at < cache.ttlMs) {
    throw new Error("the fleet config cannot be read: usage is not shown for an unknown config");
  }
  // #1585, stale-while-revalidate (the dashboard panel only): an expired snapshot of this same config and Muse
  // revision, younger than STALE_MAX_MS, is answered at once while the one refresh the expiry would have started anyway
  // runs. Vendors are called exactly as before — the same condition starts the same single shared fetch; only the panel
  // stops waiting for it.
  const stale = allowStale && !effectiveForce && ownCache && now - ownCache.at < STALE_MAX_MS ? ownCache.payload : null;
  const fresh = fetchFor(owner, effectiveForce, () => usage(force, false));
  if (stale) {
    fresh.catch(() => { /* a failed background refresh: the next read tries again, as before */ });
    return { ...stale, refreshing: true };
  }
  // A read that waited is answered only if the config it waited under is still the one it reads now: a profile or
  // binding changed meanwhile means another set of accounts, so it decides again (the result stays cached under the
  // owner it was fetched for). An unknown config that is still unknown gets the round it waited for (never a cache).
  return fresh.then(payload => {
    const configKey = usageConfigKey();
    return configKey === owner.configKey && museUsageRevision() === owner.museRevision ? payload : usage(false, false);
  });
}

/**
 * The fetch for `owner`: joins the one in flight when it belongs to the same config; one for another config is waited
 * out first (never a second vendor round in parallel), then the read is decided again and this config gets its own. Its result is cached under the
 * owner it was started for, so it is never served to another.
 */
function fetchFor(owner: UsageOwner, effectiveForce: boolean, again: () => Promise<UsagePayload>): Promise<UsagePayload> {
  if (inflight && sameOwner(inflight.owner, owner)) return inflight.promise;
  // Another config's fetch: wait it out, then decide again (its result is never this read's).
  if (inflight) return inflight.promise.then(() => undefined, () => undefined).then(again);
  if (effectiveForce) lastForcedFetchStartedAt = Date.now();
  const promise = fetcher()
    .then(payload => {
      const transient = hasTransientEmpty(payload);
      const resolved = withStaleFallback(payload);
      // Extend cache TTL to the longest Retry-After deadline so we don't
      // hammer vendor endpoints during a backoff window.
      const maxRetryAfterMs = retryAfterUntil.size > 0
        ? Math.max(0, Math.max(...retryAfterUntil.values()) - Date.now())
        : 0;
      cache = {
        at: Date.now(),
        ttlMs: Math.max(transient ? TRANSIENT_CACHE_MS : CACHE_MS, maxRetryAfterMs),
        payload: resolved,
        owner,
      };
      // Recheck the source owner after the fetch. Unknown/config-switched reads are not notice evidence.
      configKeyMemo = null;
      if (sameOwner(owner, { configKey: usageConfigKey(), museRevision: museUsageRevision() })) {
        for (const observer of usageObservers) { try { observer(resolved); } catch { /* usage reads must survive observer failure */ } }
      }
      return resolved;
    })
    .finally(() => { if (inflight?.promise === promise) inflight = null; });
  inflight = { promise, owner };
  return promise;
}

/**
 * The same cached snapshot the HTTP route serves, for in-process callers: the
 * `/usage` slash command and the `get_usage` MCP tool. One cache for all three
 * surfaces, because the 5-minute TTL exists to protect vendor rate limits and a
 * second entry point that bypassed it would defeat that.
 */
export async function getUsageSnapshot(force = false, providerIds?: Iterable<string>, opts: { allowStale?: boolean } = {}): Promise<UsagePayload> {
  return withCapacity(filterUsageProviders(reageStale(await usage(force, opts.allowStale === true), Date.now()), providerIds, { hostLogins: true }));
}

// ── #3066 §1: the measured capacity of each weekly quota, attached when served (never cached or persisted) ──
/** A weekly metric's measured 100%, as served: the numbers, and its lines in words (text + key, like a metric's note). */
export interface UsageCapacity {
  status: "ok" | "not_enough";
  deltaPct: number;
  windows?: number;
  basis?: CapacityBasis;
  median?: number;
  low?: number;
  high?: number;
  /** All tokens at 100% (median), beside an API-equivalent line. */
  tokens?: number;
  bestFit?: CapacityBasis | null;
  mixed?: boolean;
  line: { text: string; i18n: UsageI18nRef };
  notes: Array<{ text: string; i18n: UsageI18nRef }>;
}
/** Published by the fleet (FleetManager.refreshCapacity): the estimate for a provider's metric, read synchronously. */
let capacityLookup: ((provider: string, metric: string) => CapacityEstimate | null) | null = null;
export function setCapacityLookup(fn: ((provider: string, metric: string) => CapacityEstimate | null) | null): void { capacityLookup = fn; }

const money0 = (n: number): string => `$${n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2)}`;
export const compactTokens = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const ref = (key: string, args: Array<string | number>): UsageI18nRef => ({ key: key as UsageI18nRef["key"], args });
const fill = (text: string, args: Array<string | number>): string => args.reduce<string>((s, a, i) => s.split(`{${i}}`).join(String(a)), text);

/**
 * The words for an estimate (English text; the page shows its own language from the key). Null when an "ok" estimate
 * has no basis (Prism #3073 P1: estimateCapacity never makes one, but a read must not fail on it).
 */
export function capacityText(est: CapacityEstimate): UsageCapacity | null {
  const onlyAgend = { text: "Counts only this fleet's agents; use of the same account elsewhere makes this low.", i18n: ref("usage.capacity.only_agend", []) };
  if (est.status === "not_enough") {
    const args = [est.deltaPct];
    return { status: "not_enough", deltaPct: est.deltaPct, line: { text: fill("Not enough usage yet to measure 100% (Δ {0}% of 10%)", args), i18n: ref("usage.capacity.not_enough", args) }, notes: [onlyAgend] };
  }
  const api = est.bases.api, tokensBasis = est.bases.all ?? est.bases.output;
  if (!api && !tokensBasis) return null;
  const basis: CapacityBasis = api ? "api" : est.bases.all ? "all" : "output";
  const chosen = est.bases[basis]!;
  let line: { text: string; i18n: UsageI18nRef };
  if (api && est.bases.all) {
    const args = [money0(api.median), money0(api.low), money0(api.high), compactTokens(est.bases.all.median), api.windows];
    line = { text: fill("100% ≈ {0} ({1}–{2}) · ≈ {3} tokens · from {4} weeks", args), i18n: ref("usage.capacity.line", args) };
  } else {
    const args = [compactTokens(chosen.median), compactTokens(chosen.low), compactTokens(chosen.high), chosen.windows];
    line = { text: fill("100% ≈ {0} tokens ({1}–{2}) · from {3} weeks", args), i18n: ref("usage.capacity.line_tokens", args) };
  }
  const notes = [onlyAgend];
  const fit = est.bestFit ? est.bases[est.bestFit] : undefined;
  if (est.bestFit && fit && fit.cv !== null) {
    const args = [Math.round(fit.cv * 100), fit.windows];
    const sentence = { api: "API-equivalent fits best: ±{0}% across {1} weeks", output: "Output tokens fit best: ±{0}% across {1} weeks", all: "All tokens fit best: ±{0}% across {1} weeks" }[est.bestFit];
    notes.push({ text: fill(sentence, args), i18n: ref(`usage.capacity.best_fit_${est.bestFit}`, args) });
  }
  if (est.mixed) notes.push({ text: "Bases disagree — possibly used outside this fleet", i18n: ref("usage.capacity.mixed", []) });
  return { status: "ok", deltaPct: est.deltaPct, windows: chosen.windows, basis, median: chosen.median, low: chosen.low, high: chosen.high,
    ...(api && est.bases.all ? { tokens: est.bases.all.median } : {}), bestFit: est.bestFit, mixed: est.mixed, line, notes };
}

/** Each weekly percent metric with an estimate gets `capacity` — on copies: the cached payload stays as read. */
function withCapacity(payload: UsagePayload): UsagePayload {
  const look = capacityLookup;
  if (!look) return payload;
  let any = false;
  const providers = payload.providers.map((p) => {
    if (p.status !== "ok") return p;
    let changed = false;
    const metrics = p.metrics.map((m) => {
      if (m.type !== "percent" || typeof m.windowMs !== "number" || m.windowMs < 24 * 3_600_000) return m;
      let capacity: UsageCapacity | null = null;
      try { const est = look(p.id, m.label); capacity = est ? capacityText(est) : null; } catch { capacity = null; }
      if (!capacity) return m;                       // an estimate that cannot be put in words never fails the read
      changed = true;
      return { ...m, capacity };
    });
    if (!changed) return p;
    any = true;
    return { ...p, metrics };
  });
  return any ? { ...payload, providers } : payload;
}

/**
 * Last known numbers age while they are served (Prism #2257 P2): a snapshot is reused for minutes, and a window may
 * reset in between. Every read re-marks a stale row's metrics against now — the cached snapshot itself is left as it
 * is (ageMetric is idempotent), and nothing is fetched for it.
 */
function reageStale(payload: UsagePayload, now: number): UsagePayload {
  if (!payload.providers.some(p => p.stale && p.cachedAt)) return payload;
  return { ...payload, providers: payload.providers.map(p => (p.stale && p.cachedAt ? { ...p, metrics: p.metrics.map(m => ageMetric(m, now)) } : p)) };
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
    const name = provider.plan ? `${usageRowName(provider)} (${provider.plan})` : usageRowName(provider);
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
    const marked = usageStaleText(provider);
    const staleness = marked ? ` (${marked})` : provider.hint ? ` (${usageText(provider.hint, provider.hintI18n)})` : "";
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
/**
 * Compact locale-neutral `XdYh` reset countdown for the activity line. Same
 * resetsAt countdown as usageResetText, without window names or reset verbs —
 * the activity line must read identically in every locale.
 */
function activityCountdown(resetsAt?: string | null): string {
  if (!resetsAt) return "";
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return "";
  const remainingMs = at.getTime() - Date.now();
  if (remainingMs <= 0) return "";
  const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  return `${days}d${hours}h`;
}

export function formatDiscordUsageActivity(payload: UsagePayload): string {
  // The scoped payload contains all providers owned by this adapter, including
  // rows that are currently unavailable. Use logical provider ids (profile
  // suffixes such as codex:work still count as the Codex backend) so a single
  // backend can afford a useful reset countdown without leaking it into a
  // crowded multi-backend activity line.
  const backendIds = new Set(payload.providers.map(provider => provider.id.split(":", 1)[0]));
  const singleBackend = backendIds.size === 1;
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
    const stale = provider.stale === true || /^cached\s+/i.test(provider.hint ?? "");
    if (stale) return [{ text: `${name}: stale`, stale: true, index }];
    // A glance, not a report: `<Backend> <pct>%` plus a compact `(<XdYh>)`
    // countdown for a single backend, entries joined by ` | ` for several. No
    // window names, no reset verbs — the /usage output keeps the long form.
    const countdown = singleBackend ? activityCountdown(percent.resetsAt) : "";
    return [{ text: `${name} ${Math.round(percent.used ?? 0)}%${countdown ? ` (${countdown})` : ""}`, stale: false, index }];
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
  if (m.resetPassed) return `${label} ${usageResetSinceText(m.resetsAt)}`;
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
      return `${label} ${m.value ?? "?"}${unit ? ` ${unit}` : ""}${note ? ` (${note})` : ""}${expirySuffix(m.expiresAt)}`;
    }
    case "text": {
      const value = m.value != null ? usageText(String(m.value), m.valueI18n) : null;
      return value != null ? `${label} ${value}${note ? ` (${note})` : ""}` : "";
    }
  }
}

function expirySuffix(expiresAt?: string | null): string {
  const text = usageExpiryText(expiresAt);
  return text ? ` · ${text}` : "";
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

/** #2855: whether this read forces a refresh — asked for, and not a guest's (it reads the snapshot the fleet keeps, which
 * is refreshed behind it as for anyone). */
export function usageForce(req: IncomingMessage, url: URL): boolean { return url.searchParams.has("force") && !guestRequestOf(req); }

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

  // #1585: the panel opens from the last snapshot at once (refreshing behind it); never a browser or proxy cache — the
  // snapshot lives in this process, behind the same gate as every read, and goes when a request may not see it.
  getUsageSnapshot(usageForce(req, url), ctx.getActiveUsageProviderIds?.(), { allowStale: true })
    .then(payload => json(res, 200, payload))
    .catch(err => {
      ctx.logger.debug({ err }, "ai-usage fetch failed");
      json(res, 500, { error: String((err as Error)?.message ?? err) });
    });
  return true;
}
