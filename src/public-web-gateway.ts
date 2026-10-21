import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { bindGatewayRequest } from "./web-request-context.js";
import { applyWebSecurityHeaders } from "./web-host-guard.js";
import { isServedAsset } from "./auth-api.js";
import { shellRoute } from "./web-shell-routes.js";
import { isWebIconPath } from "./web-icons.js";
import { UPLOAD_REQUEST_TIMEOUT_MS } from "./web-upload.js";
import { LIBAVOID_PATHS } from "./web-libavoid.js";

/** #1937: how long a public-link request other than an upload may take to arrive whole (the gateway's old requestTimeout). */
export const PUBLIC_GATEWAY_RECEIVE_MS = 10_000;

/** Reviewed panel routes. No health, agent, issue-code, preview, legacy restart or SSE. */
export function isPublicWebRoute(method: string, path: string): boolean {
  const reads = method === "GET" || method === "HEAD";
  // #2118: fixed trusted opaque bootstrap only. No library/resource, personal or Trial grant.
  if (method === "GET" && path === "/effect-bootstrap") return true;
  if (reads && isWebIconPath(path)) return true;
  if (reads && ["/", "/signin", "/ui", "/view", "/auth/session", "/auth/sessions", "/auth/device", "/api/fleet", "/api/profiles", "/api/sort-order", "/api/ai-usage"].includes(path)) return true;
  if (method === "GET" && path.startsWith("/assets/") && isServedAsset(path.slice("/assets/".length))) return true;
  // #1408: the app shell's pages, exactly as the classifier names them (a malformed one is answered 400 behind it).
  if (reads && shellRoute(method, path) !== null) return true;
  if (method === "POST" && ["/auth/login", "/auth/logout", "/auth/request-code"].includes(path)) return true;
  if (method === "DELETE" && /^\/auth\/sessions(?:\/[0-9a-f]{16})?$/.test(path)) return true;
  if (reads && /^\/api\/(pane|profile|avatar)\/[^/]+$/.test(path)) return true;
  // #1665: the sidebar's order is a host preference now (/ui/prefs, read-only here); the old fleet-wide /api/sort-order
  // write, which the page no longer makes, is not offered on the public link either.
  if (method === "POST" && /^\/api\/(profile|avatar)\/[^/]+$/.test(path)) return true;
  if (method === "DELETE" && /^\/api\/avatar\/[^/]+$/.test(path)) return true;   // #1630 follow-up: removing it, as uploading it
  // #1629 r4.1 Q2: the identity card follows the profile and avatar (the person's card, read and edited here); the
  // agent's theme, its reset and lock stay off this list.
  if (reads && /^\/api\/card\/[^/]+(?:\/(?:portrait|banner))?$/.test(path)) return true;
  if ((method === "POST" || method === "DELETE") && /^\/api\/card\/[^/]+\/(?:portrait|banner)$/.test(path)) return true;
  if (method === "DELETE" && /^\/api\/card\/[^/]+$/.test(path)) return true;   // Clear card
  if (method === "POST" && (/^\/stop\/[^/]+$/.test(path) || /^\/api\/instance\/[^/]+\/start$/.test(path))) return true;
  if (method === "GET" && /^\/ui\/js\/[a-z0-9_-]+\.js$/.test(path)) return true;
  // #2182: the org canvas's router, libavoid's two files (the route worker itself is under /ui/js/ above).
  if (method === "GET" && LIBAVOID_PATHS.includes(path)) return true;
  if (method === "GET" && /^\/ui\/(backends|poll|history|file\/[^/]+|prompts|instance\/[^/]+|instances|tasks(?:\/[^/]+)?|schedules(?:\/[^/]+)?|teams(?:\/[^/]+)?|config|org|traffic|cache|usage-report|prefs|preview-status|steps)$/.test(path)) return true;
  // #1629: agents' themes and their pictures, read-only — the public link views themes; reset and lock are not here.
  if (method === "GET" && (path === "/ui/themes" || /^\/ui\/img\/theme\/[^/]+\/[0-9a-f]{32}$/.test(path))) return true;
  // #2118: exact current-Chat reads only; handler rechecks session/epoch/exposure/instance/retention.
  if (method === "GET" && (path === "/ui/effects/placements" || /^\/ui\/effects\/resource\/[0-9a-f]{32}$/.test(path))) return true;
  // Static posters remain available without granting library, personal slots or writes.
  if (method === "GET" && (path === "/ui/effect-posters" || /^\/ui\/effect-posters\/[0-9a-f]{32}\.png$/.test(path))) return true;
  // #1630: avatars and server emoji, read-only — nothing a signed-in public user cannot already see in the page.
  if (method === "GET" && /^\/ui\/(?:img\/(?:bot|avatar|emoji)\/[^/]+|emojis|mentions)$/.test(path)) return true;
  if (method === "POST" && /^\/ui\/(send|upload|prompt|reply-button|command|needs\/ack|cancel\/[^/]+|stop\/[^/]+|start\/[^/]+|instances\/[^/]+\/delete|restart\/[^/]+|instances|config)$/.test(path)) return true;
  // The task board (scheduler/task-board.ts) is read over the public link — a card too — and changed only on the local
  // page, the old /ui/tasks create and update included: the handlers refuse a write over the public link too
  // (confirming, sending back and assigning are the person's authority, never carried here).
  if (method === "GET" && /^\/ui\/tasks\/cards\/[^/]+$/.test(path)) return true;
  // #1827: the person's own name (a profile edit, which the public link may make).
  if ((method === "GET" || method === "POST") && path === "/ui/profile") return true;
  // #1724: schedules are not created, edited or deleted over the public link (the handlers refuse it too).
  // #1689: teams are not created, edited or deleted over the public link (the handlers refuse it too).
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
  // #1937: an upload may take long on a slow link (its own clocks bound it); every other request is still dropped if it
  // has not arrived whole in PUBLIC_GATEWAY_RECEIVE_MS (limitRequestReceive, where the request is dispatched).
  server.requestTimeout = UPLOAD_REQUEST_TIMEOUT_MS;
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
