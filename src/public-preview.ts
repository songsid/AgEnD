/**
 * #1723: HTML previews over the temporary public link. Design: #1723 issuecomment-6127793728.
 *
 * The public dashboard (`https://<a>.trycloudflare.com`) gets a preview origin of its own: a second quick tunnel to a
 * per-exposure preview gateway, at `https://<b>.trycloudflare.com`. trycloudflare.com is on the Public Suffix List, so
 * the two are different sites — the frame is cross-site to the dashboard (its own process, no shared cookies), which
 * isolates better than the local same-site default.
 *
 * The gateway serves exactly the local listener's frame (web-preview.ts: the shim, its CSP, sandbox, no network) with
 * `frame-ancestors` = this exposure's dashboard origin and nothing else; a readiness page for the tunnel's probe; and
 * nothing more. It is never the dashboard host, and the dashboard host never serves it (isPublicWebRoute has no
 * /frame).
 *
 * It never delays the link: PublicWebLink starts it without awaiting it, and nothing of the link's steps reads it.
 * Until it is ready the page says "Preview is starting…" and asks /ui/preview-status; if it fails, the link is
 * untouched and the page says why. It lives and dies with its exposure.
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { normalizeOrigin, previewFrameResponse } from "./web-preview.js";
import { failureOf, type PublicLinkFailure } from "./public-link-progress.js";
import { newTunnelSid, type ManagedTunnel } from "./tunnel/manager.js";
import type { TunnelProvider, TunnelStopResult } from "./tunnel/types.js";

const QUICK_TUNNEL_HOST = /^[a-z0-9-]+\.trycloudflare\.com$/;

/**
 * What a public-link page may frame: any quick tunnel's /frame — the preview host is not known when the page may
 * load. The page only ever points its frame at the origin its exposure names; the boundary is the preview side's
 * exact frame-ancestors, its sandbox and its connect-src 'none' (#1723 design, option 1). Public-link pages only.
 */
export const PUBLIC_PREVIEW_FRAME_SRC = "https://*.trycloudflare.com/frame";

/**
 * #1732: a preview tunnel that came up unreachable is started once more, with a fresh quick tunnel — only if the first
 * attempt ended within this long of the preview's start, so that the second (one 60 s startup budget) still ends
 * inside the page's 5-minute wait for it (preview-status.js).
 */
export const PREVIEW_RETRY_WITHIN_MS = 180_000;

/** Where the public link's preview tunnel keeps its own lease (never the fleet's one `tunnel.lease`). */
export const PUBLIC_PREVIEW_TUNNEL_DIR = "preview-tunnel";

/**
 * Whether a public link gets a preview tunnel of its own: previews on (`web.preview`), on for the public link
 * (`web.preview_on_public_link`, default true), and no `web.preview_origin` — a configured one is used instead.
 */
export function publicPreviewWanted(web: { preview?: unknown; preview_on_public_link?: unknown; preview_origin?: unknown } | null | undefined): boolean {
  if (web?.preview === false || web?.preview_on_public_link === false) return false;
  return !(typeof web?.preview_origin === "string" && normalizeOrigin(web.preview_origin));
}

/** Why the public link has no preview: a tunnel step's reason, or `exited` — it was up and then went away. */
export type PublicPreviewFailure = PublicLinkFailure | "exited";

export type PublicPreviewStatus =
  | { readonly state: "starting" }
  | { readonly state: "ready"; readonly origin: string; readonly boot: string }
  | { readonly state: "failed"; readonly reason: PublicPreviewFailure };

export interface PublicPreviewGateway {
  readonly server: Server;
  readonly readinessMarker: string;
  readonly bootId: string;
  listen(): Promise<URL>;
  setHost(host: string | null): void;
  close(): void;
}

/**
 * The preview gateway: `GET /frame` → the shim, framable only by `dashboardOrigin()` (503 until that is known);
 * `GET /ready` → the tunnel's readiness marker; anything else → empty 404. A Host other than this tunnel's own, or an
 * exposure no longer current → empty 403. No cookie or header but Host is read, nothing is logged per request.
 */
export function createPublicPreviewGateway(opts: {
  exposureId: string;
  dashboardOrigin(): string | null;
  isCurrent(): boolean;
  bootId?: string;
  create?: typeof createServer;
}): PublicPreviewGateway {
  let host: string | null = null;
  const bootId = opts.bootId ?? randomBytes(16).toString("hex");
  const marker = `agend-preview-${opts.exposureId}`;
  const sockets = new Set<Socket>();
  let frame: { origin: string; body: Buffer; headers: Record<string, string> } | null = null;
  const empty = (res: ServerResponse, status: number): void => {
    res.writeHead(status, { "Content-Length": "0", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    res.end();
  };
  const server = (opts.create ?? createServer)((req, res) => {
    try {
      if (!opts.isCurrent() || !host || req.headers.host !== host) return empty(res, 403);
      if (req.method !== "GET") return empty(res, 404);
      if (req.url === "/ready") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        res.end(`<html><body>${marker}</body></html>`);
        return;
      }
      if (req.url !== "/frame") return empty(res, 404);
      const origin = opts.dashboardOrigin();
      if (!origin) return empty(res, 503);
      // Built for the one dashboard origin this exposure has; rebuilt only if that ever changes.
      if (frame?.origin !== origin) frame = { origin, ...previewFrameResponse(bootId, [origin]) };
      res.writeHead(200, frame.headers);
      res.end(frame.body);
    } catch {
      if (!res.headersSent) empty(res, 400); else res.destroy();
    }
  });
  server.maxHeadersCount = 32;
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.setTimeout(15_000, socket => socket.destroy());
  server.on("connection", socket => { if (sockets.size >= 32) { socket.destroy(); return; } sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("connect", (_req, socket) => socket.destroy());
  server.on("clientError", (_err, socket) => socket.destroy());
  server.on("error", () => { host = null; });
  return {
    server, readinessMarker: marker, bootId,
    listen: () => new Promise((resolve, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", rejectListen);
        const address = server.address();
        if (!address || typeof address === "string") { rejectListen(new Error("preview gateway not bound")); return; }
        resolve(new URL(`http://127.0.0.1:${address.port}`));
      });
    }),
    setHost: value => {
      if (value !== null && !QUICK_TUNNEL_HOST.test(value)) throw new Error("invalid tunnel host");
      host = value;
    },
    close: () => {
      host = null;
      server.close();
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
    },
  };
}

/**
 * One exposure's preview: its gateway and its quick tunnel, on a manager (and lease) of its own — never the fleet's
 * one tunnel lane, which the dashboard link holds while this exists. start() returns at once; the work runs behind it
 * and only ever changes this object's status.
 */
export class PublicPreview {
  private current: PublicPreviewStatus = { state: "starting" };
  private readonly abort = new AbortController();
  private gateway: PublicPreviewGateway | null = null;
  private running: Promise<void> = Promise.resolve();
  private stopping: Promise<TunnelStopResult> | null = null;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: {
    exposureId: string;
    /** This exposure's dashboard origin (`https://<host>`), once its tunnel has one. */
    dashboardOrigin(): string | null;
    /** The exposure is still the open one: false fences every request and every later step. */
    isCurrent(): boolean;
    expiresAt: number;
    manager: Pick<ManagedTunnel, "start" | "stop">;
    provider(): TunnelProvider;
    createGateway?: (opts: Parameters<typeof createPublicPreviewGateway>[0]) => PublicPreviewGateway;
    /** Monotonic clock (ms) for the retry's bound; performance.now by default. */
    now?(): number;
    /** Told once when the preview settles (ready or failed), for the link's progress message. */
    onSettled?(status: PublicPreviewStatus): void;
    log?(event: string): void;
  }) {}

  status(): PublicPreviewStatus { return this.current; }

  /** Start in the background. Never throws, never awaited by the link: its outcome is only ever this status. */
  start(): void {
    this.running = this.run().catch((err: unknown) => {
      this.settle({ state: "failed", reason: err instanceof PreviewStartFailure ? err.reason : this.abort.signal.aborted ? "closed" : "unknown" });
    });
  }

  private live(): boolean { return !this.abort.signal.aborted && !this.stopping && this.deps.isCurrent(); }

  private settle(status: PublicPreviewStatus): void {
    if (this.current.state !== "starting" && status.state !== "failed") return;
    if (this.current.state === "failed") return;
    this.current = status;
    if (status.state === "failed") this.gateway?.setHost(null);
    this.deps.log?.(status.state === "failed" ? `preview ${status.reason}` : "preview ready");
    try { this.deps.onSettled?.(status); } catch { /* a progress message is no reason to fail */ }
  }

  private async run(): Promise<void> {
    const now = this.deps.now ?? (() => performance.now());
    const startedAt = now();
    const gateway = (this.deps.createGateway ?? createPublicPreviewGateway)({
      exposureId: this.deps.exposureId, dashboardOrigin: () => this.deps.dashboardOrigin(),
      isCurrent: () => this.live() && this.current.state !== "failed",
    });
    this.gateway = gateway;
    const origin = await gateway.listen().catch(() => { throw new PreviewStartFailure("gateway-failed"); });
    if (!this.live()) throw new PreviewStartFailure("closed");
    const attempt = () => this.deps.manager.start(this.deps.provider(), {
      sid: newTunnelSid(), origin, pagePath: "/ready", readinessMarker: gateway.readinessMarker, expiresAt: this.deps.expiresAt,
      signal: this.abort.signal, onCandidateHost: host => { if (this.live()) gateway.setHost(host); },
    });
    let result = await attempt();
    // #1732: unreachable is often the edge's jitter, and a fresh quick tunnel comes up: once, while this exposure is
    // live, its child proven gone (no lease held), and early enough to end inside the page's wait. Still "starting".
    if (!result.ok && failureOf(result.errorKind) === "unreachable" && !result.leaseHeld && this.live()
      && this.current.state === "starting" && now() - startedAt <= PREVIEW_RETRY_WITHIN_MS) {
      gateway.setHost(null);   // the first tunnel's host is never answered again
      this.deps.log?.("preview unreachable; retrying once");
      result = await attempt();
    }
    if (!result.ok) throw new PreviewStartFailure(failureOf(result.errorKind));
    if (!this.live()) throw new PreviewStartFailure("closed");
    const published = new URL(result.handle.pageUrl);
    if (published.protocol !== "https:" || published.pathname !== "/ready" || !QUICK_TUNNEL_HOST.test(published.host)) {
      throw new PreviewStartFailure("no-address");
    }
    gateway.setHost(published.host);
    this.unsubscribe = result.handle.onUnexpectedExit(() => { this.settle({ state: "failed", reason: "exited" }); });
    this.settle({ state: "ready", origin: published.origin, boot: gateway.bootId });
  }

  /**
   * The exposure is closing: fence now (no request is answered from here on), then end the start in flight and the
   * tunnel — on proof, as the link's own tunnel is stopped.
   */
  stop(reason: string): Promise<TunnelStopResult> {
    if (this.stopping) return this.stopping;
    this.abort.abort();
    this.unsubscribe?.();
    this.gateway?.setHost(null); this.gateway?.close();
    this.stopping = (async () => {
      await this.running.catch(() => {});
      this.gateway?.close();   // listen may have finished after the first close
      return this.deps.manager.stop(reason);
    })();
    return this.stopping;
  }
}

class PreviewStartFailure extends Error {
  constructor(readonly reason: PublicPreviewFailure) { super(reason); }
}
