import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { bindGatewayRequest } from "./web-request-context.js";
import { applyWebSecurityHeaders } from "./web-host-guard.js";
import { isServedAsset } from "./auth-api.js";
import { shellRoute } from "./web-shell-routes.js";
import { isWebIconPath } from "./web-icons.js";

/** Reviewed panel routes. No health, agent, issue-code, preview, legacy restart or SSE. */
export function isPublicWebRoute(method: string, path: string): boolean {
  const reads = method === "GET" || method === "HEAD";
  if (reads && isWebIconPath(path)) return true;
  if (reads && ["/", "/signin", "/ui", "/view", "/auth/session", "/auth/sessions", "/auth/device", "/api/fleet", "/api/profiles", "/api/sort-order", "/api/ai-usage"].includes(path)) return true;
  if (method === "GET" && path.startsWith("/assets/") && isServedAsset(path.slice("/assets/".length))) return true;
  // #1408: the app shell's pages, exactly as the classifier names them (a malformed one is answered 400 behind it).
  if (reads && shellRoute(method, path) !== null) return true;
  if (method === "POST" && ["/auth/login", "/auth/logout", "/auth/request-code"].includes(path)) return true;
  if (method === "DELETE" && /^\/auth\/sessions(?:\/[0-9a-f]{16})?$/.test(path)) return true;
  if (reads && /^\/api\/(pane|profile|avatar)\/[^/]+$/.test(path)) return true;
  if (method === "POST" && (path === "/api/sort-order" || /^\/api\/(profile|avatar)\/[^/]+$/.test(path))) return true;
  if (method === "POST" && (/^\/stop\/[^/]+$/.test(path) || /^\/api\/instance\/[^/]+\/start$/.test(path))) return true;
  if (method === "GET" && /^\/ui\/js\/[a-z0-9_-]+\.js$/.test(path)) return true;
  if (method === "GET" && /^\/ui\/(backends|poll|history|file\/[^/]+|prompts|instance\/[^/]+|instances|tasks(?:\/[^/]+)?|schedules(?:\/[^/]+)?|teams(?:\/[^/]+)?|config|org|cache)$/.test(path)) return true;
  if (method === "POST" && /^\/ui\/(send|upload|prompt|reply-button|command|needs\/ack|cancel\/[^/]+|stop\/[^/]+|start\/[^/]+|instances\/[^/]+\/delete|restart\/[^/]+|instances|tasks|schedules|teams|config)$/.test(path)) return true;
  if (((method === "POST" && /^\/ui\/tasks\/[^/]+$/.test(path))) || (method === "DELETE" && /^\/ui\/(schedules|teams)\/[^/]+$/.test(path))) return true;
  // Settings has an explicit method/subroute manifest (not an arbitrary /api prefix).
  return isPublicSettingsRoute(method, path);
}
function isPublicSettingsRoute(method: string, path: string): boolean {
  if (method === "GET" && /^\/api\/settings\/pending(?:\/[0-9a-f]{32})?$/.test(path)) return true;
  if (method === "DELETE" && /^\/api\/settings\/pending\/[0-9a-f]{32}$/.test(path)) return true;
  if (method === "GET") return /^\/api\/settings\/(schema|fleet|fleet\/raw|classic|status-emojis|status-emojis\/guild-emojis|connections|provider-secrets|secrets|apply\/[^/]+|quickstart\/environment)$/.test(path)
    || /^\/api\/settings\/(provider-secrets|secrets)\/[^/]+\/apply\/[^/]+$/.test(path)
    || /^\/api\/settings\/connections\/[^/]+\/(secret|binding)\/apply\/[^/]+$/.test(path);
  if (method === "POST") return /^\/api\/settings\/(status-emojis\/preview|apply|restart-fleet|reload|fleet\/instances|quickstart\/(probe|plan|commit))$/.test(path)
    || /^\/api\/settings\/(provider-secrets|secrets)\/[^/]+\/(verify|apply)$/.test(path)
    || /^\/api\/settings\/connections\/[^/]+\/(secret|binding)\/(verify|apply)$/.test(path)
    || /^\/api\/settings\/instances\/[^/]+\/(pause|wake)$/.test(path);
  if (method === "PUT") return /^\/api\/settings\/(fleet\/(web|defaults|channels)|classic\/defaults)$/.test(path);
  if (method === "PATCH" && /^\/api\/settings\/classic\/channels\/[^/]+$/.test(path)) return true;
  return ["POST", "PATCH", "DELETE"].includes(method) && /^\/api\/settings\/fleet\/instances\/[^/]+$/.test(path);
}

export interface PublicGateway {
  readonly server: Server;
  readonly readinessMarker: string;
  listen(): Promise<URL>;
  setHost(host: string | null): void;
  close(): void;
}
export function createPublicWebGateway(opts: {
  exposureId: string;
  isCurrent(): boolean;
  isOpen(): boolean;
  dispatch(req: IncomingMessage, res: ServerResponse): void;
  onError?(): void;
  create?: typeof createServer;
}): PublicGateway {
  let host: string | null = null;
  const marker = `agend-public-${opts.exposureId}`;
  const sockets = new Set<Socket>();
  const reject = (res: ServerResponse, status: number): void => { res.writeHead(status); res.end(JSON.stringify({ error: "public web request refused" })); };
  const server = (opts.create ?? createServer)((req, res) => {
    applyWebSecurityHeaders(res);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Vary", "Cookie");
    const raw = req.url ?? "/";
    try {
      if (!opts.isCurrent() || !host || req.headers.host !== host) return reject(res, 403);
      if (!raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(raw)) return reject(res, 400);
      const url = new URL(raw, `https://${host}`);
      // Decode once now; reject malformed encodings before any shared route can throw.
      const decoded = decodeURIComponent(url.pathname);
      if (decoded.includes("\\") || decoded.includes("\0") || /%2f|%5c/i.test(url.pathname)) return reject(res, 400);
      if (!isPublicWebRoute(req.method ?? "GET", url.pathname)) return reject(res, 404);
      if (!opts.isOpen()) {
        if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/signin") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(`<html><body>${marker}</body></html>`); return;
        }
        return reject(res, 503);
      }
      bindGatewayRequest(req, { surface: "gateway", exposureId: opts.exposureId, expectedOrigin: `https://${host}`, isCurrent: () => opts.isCurrent() && opts.isOpen() });
      opts.dispatch(req, res);
    } catch {
      if (!res.headersSent) reject(res, 400); else res.destroy();
    }
  });
  server.maxHeadersCount = 64;
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.setTimeout(15_000, socket => socket.destroy());
  server.on("connection", socket => { if (sockets.size >= 32) { socket.destroy(); return; } sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  // Upgrades are never accepted, but they still leave HTTP's ordinary connection accounting.
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("connect", (_req, socket) => socket.destroy());
  server.on("clientError", (_err, socket) => socket.destroy());
  server.on("error", () => { host = null; opts.onError?.(); });
  return {
    server, readinessMarker: marker,
    listen: () => new Promise((resolve, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", rejectListen);
        const address = server.address();
        if (!address || typeof address === "string") { rejectListen(new Error("gateway not bound")); return; }
        resolve(new URL(`http://127.0.0.1:${address.port}`));
      });
    }),
    setHost: value => {
      // Provider-validated only, pinned again at this boundary.
      if (value !== null && !/^[a-z0-9-]+\.trycloudflare\.com$/.test(value)) throw new Error("invalid tunnel host");
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
