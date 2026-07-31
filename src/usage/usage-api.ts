/**
 * AI usage HTTP API.
 *
 *   GET /api/ai-usage → { fetchedAt, providers: [...] } — live subscription
 *   usage for the CLI backends logged in on this machine (see providers.ts).
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
import { fetchAllUsage, type ProviderUsage } from "./providers.js";

export interface UsageApiContext {
  readonly fleetConfig: FleetConfig | null;
  readonly logger: Logger;
}

type UsagePayload = { fetchedAt: string; providers: ProviderUsage[] };

const CACHE_MS = 5 * 60 * 1000;
let cache: { at: number; payload: UsagePayload } | null = null;
let inflight: Promise<UsagePayload> | null = null;
// Test seam: lets tests stub the network layer without real credentials.
let fetcher: () => Promise<UsagePayload> = fetchAllUsage;

export function setUsageFetcherForTests(fn: (() => Promise<UsagePayload>) | null): void {
  fetcher = fn ?? fetchAllUsage;
  cache = null;
  inflight = null;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function usage(force: boolean): Promise<UsagePayload> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.payload;
  inflight ??= fetcher()
    .then(payload => { cache = { at: Date.now(), payload }; return payload; })
    .finally(() => { inflight = null; });
  return inflight;
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

  usage(url.searchParams.has("force"))
    .then(payload => json(res, 200, payload))
    .catch(err => {
      ctx.logger.debug({ err }, "ai-usage fetch failed");
      json(res, 500, { error: String((err as Error)?.message ?? err) });
    });
  return true;
}
