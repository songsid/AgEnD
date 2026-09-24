import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { createBrotliDecompress, createGunzip } from "node:zlib";
import { join } from "node:path";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { getAgendHome } from "./paths.js";
import type { ClientRequest, IncomingHttpHeaders } from "node:http";

/** The upstream is deliberately code-owned: callers cannot turn this into an open proxy. */
export const MUSE_UPSTREAM_ORIGIN = "https://api.meta.ai";
export const MUSE_USAGE_STATE_FILE = "muse-usage.json";
export const MUSE_USAGE_STALE_MS = 15 * 60_000;

export interface MuseUsageWindow {
  usedPercent: number;
  resetsAt: number;
  windowMs?: number;
}

export interface MuseUsageSnapshot {
  observedAt: number;
  plan?: string;
  session?: MuseUsageWindow;
  weekly?: MuseUsageWindow;
}

function finitePercent(value: unknown): number | null {
  // Meta reports overage as a percentage above 100. Keep it: turning an
  // exceeded subscription into "unavailable" hides the most useful state.
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

const SAFE_MUSE_PLANS = new Set(["free", "basic", "pro", "plus", "team", "business", "enterprise", "subscription"]);

function safeMusePlan(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const plan = value.trim().toLowerCase();
  return SAFE_MUSE_PLANS.has(plan) ? plan[0].toUpperCase() + plan.slice(1) : undefined;
}

function epochSeconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value > 10_000_000_000 ? value / 1000 : value);
}

function readWindow(value: unknown): MuseUsageWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const used = finitePercent(row.used_percent ?? row.usedPercent ?? row.percent_used);
  const reset = epochSeconds(row.resets_at ?? row.resetsAt ?? row.reset_at);
  const mins = typeof row.window_duration_mins === "number" && Number.isFinite(row.window_duration_mins)
    && row.window_duration_mins > 0 && row.window_duration_mins <= 7 * 24 * 60
    ? row.window_duration_mins : undefined;
  return used == null || reset == null
    ? undefined
    : { usedPercent: used, resetsAt: reset, ...(mins ? { windowMs: mins * 60_000 } : {}) };
}

/**
 * Parse only the subscription_usage event.  The event has changed nesting in
 * early Muse builds, so the known wrappers are accepted while arbitrary events
 * and malformed JSON remain invisible to the usage layer.
 */
export function parseMuseSubscriptionUsage(data: string): Partial<MuseUsageSnapshot> | null {
  let value: unknown;
  try { value = JSON.parse(data); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const root = value as Record<string, unknown>;
  const usage = (root.response && typeof root.response === "object"
    ? (root.response as Record<string, unknown>).subscription_usage
    : undefined)
    ?? root.subscription_usage
    ?? value;
  if (!usage || typeof usage !== "object") return null;
  const row = usage as Record<string, unknown>;
  const subscription = row.subscription && typeof row.subscription === "object"
    ? row.subscription as Record<string, unknown> : row;
  const session = readWindow(row.session ?? row.window ?? row.five_hour ?? row.fiveHour
    ?? subscription.window ?? subscription.five_hour ?? subscription.fiveHour);
  const weekly = readWindow(row.weekly ?? row.seven_day ?? row.sevenDay
    ?? subscription.weekly ?? subscription.seven_day ?? subscription.sevenDay);
  const planValue = row.plan ?? row.plan_name ?? row.planName ?? row.tier ?? row.tier_id
    ?? subscription.plan ?? subscription.plan_name ?? subscription.planName ?? subscription.tier ?? subscription.tier_id;
  // Never expose an opaque tier/account id in `/usage`, activity, or the
  // token-free state file. Human plan names are allowlisted; everything else
  // is represented by the neutral Subscription fallback downstream.
  const plan = safeMusePlan(planValue);
  if (!session && !weekly && !plan) return null;
  return { session, weekly, plan };
}

/** Small incremental SSE parser; it never stores event payloads beyond one event. */
export class MuseUsageSseParser {
  private pending = "";
  private event = "";
  private data: string[] = [];

  feed(chunk: Uint8Array | string): Partial<MuseUsageSnapshot>[] {
    this.pending += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const out: Partial<MuseUsageSnapshot>[] = [];
    let newline: number;
    while ((newline = this.pending.indexOf("\n")) >= 0) {
      let line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (this.event === "response.subscription_usage" && this.data.length > 0) {
          const parsed = parseMuseSubscriptionUsage(this.data.join("\n"));
          if (parsed) out.push(parsed);
        }
        this.event = "";
        this.data = [];
      } else if (line.startsWith("event:")) {
        this.event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        this.data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    return out;
  }

  end(): Partial<MuseUsageSnapshot>[] {
    // A server is allowed to omit the final blank SSE line. Treat the pending
    // line as data but still require the canonical event name.
    if (this.pending || this.event || this.data.length > 0) return this.feed("\n\n");
    return [];
  }
}

function mergeSnapshot(previous: MuseUsageSnapshot | undefined, update: Partial<MuseUsageSnapshot>): MuseUsageSnapshot {
  return {
    observedAt: Date.now(),
    plan: update.plan ?? previous?.plan,
    session: update.session ?? previous?.session,
    weekly: update.weekly ?? previous?.weekly,
  };
}

export function usageStatePath(instanceDir: string): string {
  return join(instanceDir, MUSE_USAGE_STATE_FILE);
}

export function readMuseUsageSnapshot(instanceDir: string): MuseUsageSnapshot | null {
  try {
    const value = JSON.parse(readFileSync(usageStatePath(instanceDir), "utf8")) as MuseUsageSnapshot;
    if (!value || typeof value.observedAt !== "number" || !Number.isFinite(value.observedAt)) return null;
    const snapshot = { ...value, plan: safeMusePlan(value.plan) };
    if (Date.now() - snapshot.observedAt <= MUSE_USAGE_STALE_MS) return snapshot;
    // Past the idle threshold the last-known windows are still the truth until
    // their own reset flips (#904): prune rolled-over windows, and only discard
    // when nothing usable remains. A window without a usable reset cannot be
    // proven unflipped, so it is dropped rather than shown.
    const now = Date.now();
    const live = (window: MuseUsageWindow | undefined): MuseUsageWindow | undefined =>
      window && typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)
      && window.resetsAt * 1000 > now ? window : undefined;
    const session = live(snapshot.session);
    const weekly = live(snapshot.weekly);
    if (!session && !weekly) return null;
    return { ...snapshot, session, weekly };
  } catch { return null; }
}

export function writeMuseUsageSnapshot(instanceDir: string, snapshot: MuseUsageSnapshot): void {
  mkdirSync(instanceDir, { recursive: true });
  const target = usageStatePath(instanceDir);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600 });
  renameSync(temp, target);
}

export function clearMuseUsageSnapshot(instanceDir: string): void {
  try { unlinkSync(usageStatePath(instanceDir)); } catch { /* absent */ }
}

/** Revision used by the fleet usage cache; only daemon state files are read. */
export function museUsageRevision(): number {
  const root = join(getAgendHome(), "instances");
  let revision = 0;
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const state = readFileSync(usageStatePath(join(root, entry.name)), "utf8");
        revision = Math.max(revision, state.length + statMtime(usageStatePath(join(root, entry.name))));
      } catch { /* absent or concurrently replaced */ }
    }
  } catch { /* no instances directory */ }
  return revision;
}

function statMtime(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

function forwardHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase()) || name.toLowerCase() === "host") continue;
    if (value !== undefined) out[name] = value;
  }
  return out;
}

export function rewriteMuseRelayPath(path: string): string {
  const parsed = new URL(path, "http://127.0.0.1");
  const pathname = parsed.pathname === "/muse-code" || parsed.pathname.startsWith("/muse-code/")
    ? parsed.pathname
    : parsed.pathname.startsWith("/v1/") || parsed.pathname === "/v1"
      ? parsed.pathname
      : `/v1${parsed.pathname.startsWith("/") ? parsed.pathname : `/${parsed.pathname}`}`;
  return `${pathname}${parsed.search}`;
}

export interface MuseUsageRelayOptions {
  instanceDir: string;
  upstreamOrigin?: string;
  /** Optional fixed port for restart/tests; production defaults to an ephemeral port. */
  port?: number;
  /** Test seam; production always uses node's HTTP(S) request implementation. */
  request?: typeof httpRequest;
  onUsage?: (snapshot: MuseUsageSnapshot) => void;
  /** Called after bounded recovery cannot reclaim the original loopback port. */
  onUnavailable?: () => void;
}

/**
 * Local-only byte-streaming relay.  It is intentionally not a generic fetch
 * proxy: the upstream origin is fixed and the only special behaviour is a
 * side-channel parser for response.subscription_usage SSE events.
 */
export class MuseUsageRelay {
  private server: Server | null = null;
  private currentPort: number | null = null;
  private stopped = false;
  private snapshot: MuseUsageSnapshot | undefined;
  private recovering = false;
  private readonly upstreamOrigin: URL;
  private readonly requestImpl: typeof httpRequest;

  constructor(private readonly options: MuseUsageRelayOptions) {
    this.upstreamOrigin = new URL(options.upstreamOrigin ?? MUSE_UPSTREAM_ORIGIN);
    // A custom origin is accepted only for an explicit loopback HTTP test
    // seam. Production callers cannot turn this into an arbitrary proxy, even
    // by passing a custom transport implementation.
    const loopbackTestOrigin = options.request
      && this.upstreamOrigin.protocol === "http:"
      && (this.upstreamOrigin.hostname === "127.0.0.1" || this.upstreamOrigin.hostname === "[::1]" || this.upstreamOrigin.hostname === "::1");
    if ((this.upstreamOrigin.protocol !== "https:" || this.upstreamOrigin.hostname !== "api.meta.ai") && !loopbackTestOrigin) {
      throw new Error("Muse relay upstream must be https://api.meta.ai");
    }
    this.requestImpl = options.request ?? httpRequest;
  }

  get port(): number | null { return this.currentPort; }
  get baseUrl(): string | null { return this.currentPort == null ? null : `http://127.0.0.1:${this.currentPort}`; }

  async start(): Promise<string> {
    if (this.baseUrl) return this.baseUrl;
    this.stopped = false;
    this.snapshot = undefined;
    clearMuseUsageSnapshot(this.options.instanceDir);
    await this.listen(this.options.port ?? 0);
    return this.baseUrl!;
  }

  private async listen(port: number): Promise<void> {
    const server = createServer((req, res) => { void this.handle(req, res); });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      // Node enables SO_REUSEADDR for TCP servers by default. Recovery starts
      // before the old server's active sockets drain, then retries briefly for
      // a transient EADDRINUSE window instead of changing Muse's baked-in port.
      server.listen({ port, host: "127.0.0.1", reusePort: false });
    }).catch(error => {
      this.server = null;
      throw error;
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Muse relay did not expose a TCP port");
    this.currentPort = address.port;
    // `close` waits for active keep-alive streams before emitting its event.
    // Wrap it so an unexpected close starts same-port recovery immediately;
    // the old sockets can drain while the replacement listener accepts new
    // requests. stop() marks the relay stopped and therefore never recovers.
    const close = server.close.bind(server);
    server.close = ((callback?: (error?: Error) => void) => {
      const unexpected = !this.stopped && !this.recovering && this.server === server && this.currentPort === address.port;
      const result = close(callback);
      if (unexpected) void this.recoverAfterClose(address.port);
      return result;
    }) as Server["close"];
    server.once("close", () => {
      if (!this.stopped && this.server === server && !this.recovering) void this.recoverAfterClose(address.port);
    });
  }

  private async recoverAfterClose(port: number): Promise<void> {
    if (this.stopped || this.recovering) return;
    this.recovering = true;
    this.server = null;
    this.currentPort = null;
    for (let attempt = 0; attempt < 3 && !this.stopped; attempt++) {
      try {
        await this.listen(port);
        this.recovering = false;
        return;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
    this.recovering = false;
    clearMuseUsageSnapshot(this.options.instanceDir);
    this.options.onUnavailable?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.recovering = false;
    const server = this.server;
    this.server = null;
    this.currentPort = null;
    clearMuseUsageSnapshot(this.options.instanceDir);
    if (!server) return;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private record(update: Partial<MuseUsageSnapshot>): void {
    this.snapshot = mergeSnapshot(this.snapshot, update);
    try { writeMuseUsageSnapshot(this.options.instanceDir, this.snapshot); } catch { /* usage is best effort */ }
    this.options.onUsage?.(this.snapshot);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = new URL(rewriteMuseRelayPath(req.url ?? "/"), this.upstreamOrigin);
    const headers = forwardHeaders(req.headers);
    const requestOptions = {
      method: req.method ?? "GET",
      headers,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      protocol: target.protocol,
      // Never allow ambient proxy/CA settings to turn this into an egress hop.
      rejectUnauthorized: true,
    };
    const transport = target.protocol === "https:" ? httpsRequest : this.requestImpl;
    let upstream: ClientRequest | null = null;
    let completed = false;
    const abort = () => { if (!completed) upstream?.destroy(); };
    req.once("aborted", abort);
    res.once("close", abort);
    try {
      await new Promise<void>((resolve) => {
        upstream = transport(requestOptions as never, upstreamRes => {
          const responseHeaders = forwardHeaders(upstreamRes.headers);
          res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
          const contentType = String(upstreamRes.headers["content-type"] ?? "");
          const parser = /text\/event-stream/i.test(contentType) ? new MuseUsageSseParser() : null;
          let parserDone: Promise<void> | undefined;
          if (parser) {
            const encoding = String(upstreamRes.headers["content-encoding"] ?? "").split(",")[0].trim().toLowerCase();
            const decoder = encoding === "gzip"
              ? createGunzip()
              : encoding === "br" ? createBrotliDecompress() : null;
            const parserInput = decoder ?? upstreamRes;
            parserDone = new Promise<void>(done => {
              parserInput.on("data", chunk => {
                for (const update of parser.feed(chunk as Buffer)) this.record(update);
              });
              parserInput.once("end", () => {
                for (const update of parser.end()) this.record(update);
                done();
              });
              parserInput.once("error", () => done());
            });
            if (decoder) upstreamRes.pipe(decoder);
          }
          upstreamRes.once("end", () => {
            void (parserDone ?? Promise.resolve()).then(() => {
              completed = true;
              resolve();
            });
          });
          upstreamRes.once("error", () => {
            // Preserve a mid-stream disconnect instead of manufacturing a
            // successful end-of-stream for Muse.
            if (!res.destroyed) res.destroy();
            completed = true;
            resolve();
          });
          // Direct pipe keeps response bytes and backpressure untouched. The
          // parser's data listener is a side channel and never rewrites chunks.
          upstreamRes.pipe(res);
        });
        upstream.once("error", () => {
          if (!res.headersSent) { res.writeHead(502, { "content-type": "text/plain" }); res.end("upstream unavailable"); }
          else res.destroy();
          completed = true;
          resolve();
        });
        if (req.method === "GET" || req.method === "HEAD") upstream.end();
        else req.pipe(upstream);
      });
    } catch {
      if (!res.headersSent) { res.writeHead(502); res.end("upstream unavailable"); }
    } finally {
      req.off("aborted", abort);
      res.off("close", abort);
    }
  }
}
