/**
 * The sign-in surface: the page, the exchange, and session management.
 *
 *   GET    /signin                  static page — no side effects, no secret
 *   GET    /assets/<file>           the two scripts the page and the panels load
 *   POST   /auth/login              {code} → session cookie
 *   GET    /auth/session            who am I (+ the CSRF value this session must send)
 *   POST   /auth/logout             end this session
 *   GET    /auth/sessions           this operator's signed-in devices
 *   DELETE /auth/sessions/<handle>  end one of them
 *   DELETE /auth/sessions           end all of them
 *   POST   /auth/issue-code         X-Agend-Token only — how `agend web --code` asks for a code
 *
 * Every GET here is free of side effects: a chat client that previews a link
 * cannot spend a code, mint a session, or move a counter. The only thing that
 * consumes a code is a POST from the page's own origin.
 *
 * Nothing here is behind the global gate — this *is* the way through it — so each
 * route does its own checks, with the same primitives the gate uses.
 *
 * See `docs/design/web-unification-secure-login.zh-TW.md` §3.
 */
import { sendPanelHtml } from "./web-host-guard.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "./logger.js";
import {
  authorizeSession,
  buildClearedSessionCookies,
  buildSessionCookie,
  hasValidHeaderToken,
  isSameOriginRequest,
  isSecureRequest,
  readSessionCookie,
  WEB_CSRF_MESSAGE,
  type WebGateRequest,
} from "./web-auth.js";
import { csrfTokenFor, labelFromUserAgent, sessionIdHash, tokenEpoch, type SessionTier, type WebSessionStore } from "./web-session.js";
import type { WebLoginCodes } from "./web-login.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const LOGIN_REFUSED_MESSAGE =
  "That code did not work — it may be wrong, expired or already used. Ask for a new one with /dashboard.";
export const LOGIN_PAUSED_MESSAGE = "Too many wrong codes — sign-in is paused for a few minutes.";

const MAX_LOGIN_BODY = 1024;

export interface AuthApiContext {
  readonly webToken: string | null;
  readonly webSessions: WebSessionStore | null;
  readonly webLoginCodes: WebLoginCodes | null;
  readonly logger: Logger;
  /** Told after every successful sign-in, so the operator can be shown one they did not make. */
  onWebLogin?(info: { label: string; surface: "local" | "gateway"; tier: SessionTier; handle: string }): void;
}

/** The only files `/assets/` will serve. A map, not a directory: nothing else can be named into it. */
const ASSETS: Readonly<Record<string, { file: string; type: string }>> = {
  "agend-auth.js": { file: join("shared", "agend-auth.js"), type: "text/javascript; charset=utf-8" },
  "signin.js": { file: join("shared", "signin.js"), type: "text/javascript; charset=utf-8" },
  "shell.js": { file: join("shared", "shell.js"), type: "text/javascript; charset=utf-8" },
  "shell.css": { file: join("shared", "shell.css"), type: "text/css; charset=utf-8" },
};

export function isAuthPath(path: string): boolean {
  return path === "/" || path === "/signin" || path.startsWith("/auth/") || path.startsWith("/assets/");
}

/**
 * Whether a request skips the global gate. Everything not named here goes
 * through `decideWebGate`.
 *
 * - `/health` (GET) is the monitor's probe; `/agent` (POST) authenticates itself
 *   with an instance token.
 * - The sign-in page and its endpoints are the way *through* the gate; each route
 *   in this file does its own checks.
 * - `/view`'s reads and `/api/ai-usage` are open by default, and only reads: a
 *   write to any of them is gated like everything else, so it needs a session
 *   (with the cookie-write checks) or the header token, never a `?token=`.
 *   `web.view_access: session` closes the reads too.
 */
export function bypassesWebGate(
  req: { method?: string | undefined; url?: string | undefined },
  path: string,
  config: { web?: { view_access?: string } | undefined } | null | undefined,
  isViewRead: (path: string) => boolean,
): boolean {
  const method = req.method ?? "GET";
  if (method === "GET" && req.url === "/health") return true;
  if (method === "POST" && req.url === "/agent") return true;
  if (isAuthPath(path)) return true;
  return (method === "GET" || method === "HEAD") && config?.web?.view_access !== "session" && isViewRead(path);
}

function json(res: ServerResponse, code: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** The sign-in page. Also what a browser navigation gets from a gated page it has no cookie for. */
export function serveSigninPage(res: ServerResponse, status = 200): void {
  try {
    const html = readFileSync(join(__dirname, "ui", "signin.html"), "utf-8");
    sendPanelHtml(res, html, status, { "Cache-Control": "no-store" });
  } catch {
    json(res, 500, { error: "signin.html not found" });
  }
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: Record<string, unknown> | null): void => { if (!done) { done = true; resolve(value); } };
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_LOGIN_BODY) { finish(null); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        finish(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null);
      } catch { finish(null); }
    });
    req.on("error", () => finish(null));
  });
}

function isJsonRequest(req: IncomingMessage): boolean {
  return String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json");
}

export function handleAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: AuthApiContext,
): boolean {
  const path = url.pathname;
  if (!isAuthPath(path)) return false;
  const method = req.method ?? "GET";
  const gateReq = req as unknown as WebGateRequest;

  // ── `/` is a door, not a page: everything about who may enter is decided at /ui ──
  if (path === "/") {
    if (method !== "GET" && method !== "HEAD") { json(res, 405, { error: "method not allowed" }); return true; }
    res.writeHead(302, { Location: "/ui", "Cache-Control": "no-store" });
    res.end();
    return true;
  }

  // ── The page and its scripts: public, inert ──
  if (path === "/signin") {
    if (method !== "GET" && method !== "HEAD") { json(res, 405, { error: "method not allowed" }); return true; }
    serveSigninPage(res);
    return true;
  }

  if (path.startsWith("/assets/")) {
    const asset = method === "GET" ? ASSETS[path.slice("/assets/".length)] : undefined;
    if (!asset) { json(res, 404, { error: "not found" }); return true; }
    try {
      const body = readFileSync(join(__dirname, "ui", asset.file));
      res.writeHead(200, { "Content-Type": asset.type });
      res.end(body);
    } catch {
      json(res, 404, { error: "not found" });
    }
    return true;
  }

  // ── POST /auth/login ──
  if (path === "/auth/login") {
    if (method !== "POST") { json(res, 405, { error: "method not allowed" }); return true; }
    // Origin is required, not merely checked: the sign-in page is always same-origin,
    // and a login POST with no Origin is nobody's legitimate request.
    if (!req.headers.origin || !isSameOriginRequest(gateReq)) { json(res, 403, { error: "Cross-site request rejected" }); return true; }
    if (!isJsonRequest(req)) { json(res, 415, { error: "expected application/json" }); return true; }
    const token = ctx.webToken;
    if (!token || !ctx.webSessions || !ctx.webLoginCodes) { json(res, 401, { error: LOGIN_REFUSED_MESSAGE }); return true; }
    const sessions = ctx.webSessions;
    const codes = ctx.webLoginCodes;
    void readJsonBody(req).then(body => {
      if (!body || typeof body.code !== "string") { json(res, 400, { error: "expected {\"code\": \"XXXX-XXXX\"}" }); return; }
      const result = codes.redeem(body.code, tokenEpoch(token));
      if (result.kind === "paused") {
        json(res, 429, { error: LOGIN_PAUSED_MESSAGE }, { "Retry-After": String(Math.ceil(result.retryAfterMs / 1000)) });
        return;
      }
      if (result.kind === "invalid") {
        ctx.logger.debug("web sign-in refused");
        json(res, 401, { error: LOGIN_REFUSED_MESSAGE });
        return;
      }
      // A new id every time, whatever the request carried: the browser never
      // gets to choose the value it will be authenticated by, and a cookie it
      // already had is retired rather than upgraded.
      const previous = readSessionCookie(gateReq);
      if (previous) sessions.revokeById(previous);
      const label = labelFromUserAgent(typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined);
      const { sessionId, record } = sessions.create({ tier: result.tier, surface: "local", label, tokenEpoch: tokenEpoch(token) });
      ctx.logger.info({ handle: record.handle, label, tier: record.tier, surface: record.surface }, "Web sign-in");
      try { ctx.onWebLogin?.({ label, surface: record.surface, tier: record.tier, handle: record.handle }); } catch (err) { ctx.logger.debug({ err }, "web sign-in notice failed"); }
      json(res, 200, { ok: true, csrf: csrfTokenFor(sessionId), tier: record.tier, expiresAt: record.absoluteExpiry }, {
        "Set-Cookie": buildSessionCookie(sessionId, isSecureRequest(gateReq), (record.absoluteExpiry - record.created) / 1000),
      });
    });
    return true;
  }

  // ── POST /auth/issue-code — a local script's way to ask for a code ──
  if (path === "/auth/issue-code") {
    if (method !== "POST") { json(res, 405, { error: "method not allowed" }); return true; }
    const token = ctx.webToken;
    if (!token || !ctx.webLoginCodes || !isSameOriginRequest(gateReq) || !hasValidHeaderToken(gateReq, token)) {
      json(res, 401, { error: "X-Agend-Token required" });
      return true;
    }
    const issued = ctx.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(token) });
    ctx.logger.info({ source: "cli" }, "Web login code issued");
    json(res, 200, { code: issued.display, expiresAt: issued.expiresAt });
    return true;
  }

  // ── The session's own endpoints: a session, and nothing else, is the credential ──
  if (path === "/auth/session" || path === "/auth/logout" || path === "/auth/sessions" || path.startsWith("/auth/sessions/")) {
    const auth = authorizeSession(gateReq, ctx.webToken, ctx.webSessions, { touch: path === "/auth/session" });
    if (auth.kind === "reject") {
      json(res, auth.status, auth.message === WEB_CSRF_MESSAGE ? { error: auth.message } : { ok: false, error: auth.message });
      return true;
    }
    const sessions = ctx.webSessions!;
    const { session, sessionId } = auth;

    if (path === "/auth/session" && method === "GET") {
      json(res, 200, {
        ok: true,
        csrf: csrfTokenFor(sessionId),
        handle: session.handle,
        tier: session.tier,
        surface: session.surface,
        label: session.label,
        created: session.created,
        expiresAt: session.absoluteExpiry,
        idleExpiresAt: session.idleExpiry,
        idleMs: sessions.idleWindowMs(session.surface),
      });
      return true;
    }

    if (path === "/auth/logout" && method === "POST") {
      const { durable } = sessions.revokeById(sessionId);
      if (!durable) return notDurable(res, ctx, { handle: session.handle }, "Web sign-out not saved");
      ctx.logger.info({ handle: session.handle }, "Web sign-out");
      json(res, 200, { ok: true }, { "Set-Cookie": buildClearedSessionCookies() });
      return true;
    }

    if (path === "/auth/sessions" && method === "GET") {
      json(res, 200, { sessions: sessions.list(sessionIdHash(sessionId)) });
      return true;
    }

    if (path === "/auth/sessions" && method === "DELETE") {
      const { count, durable } = sessions.revokeAll();
      if (!durable) return notDurable(res, ctx, { count }, "Web sessions revoked in memory only");
      ctx.logger.info({ count }, "Web sessions revoked (all)");
      json(res, 200, { ok: true, revoked: count }, { "Set-Cookie": buildClearedSessionCookies() });
      return true;
    }

    if (path.startsWith("/auth/sessions/") && method === "DELETE") {
      const handle = path.slice("/auth/sessions/".length);
      const wasCurrent = handle === session.handle;
      const { found, durable } = sessions.revokeByHandle(handle);
      if (!found) { json(res, 404, { error: "no such session" }); return true; }
      if (!durable) return notDurable(res, ctx, { handle }, "Web session revoked in memory only", wasCurrent);
      ctx.logger.info({ handle }, "Web session revoked");
      json(res, 200, { ok: true, current: wasCurrent }, wasCurrent ? { "Set-Cookie": buildClearedSessionCookies() } : {});
      return true;
    }

    json(res, 405, { error: "method not allowed" });
    return true;
  }

  json(res, 404, { error: "not found" });
  return true;
}

export const REVOCATION_NOT_DURABLE_MESSAGE =
  "Signed out for now, but the change could not be saved: the session file could not be updated or removed, so a fleet restart may bring the session back. Fix the permissions on ~/.agend/web-sessions.json and sign out again, or rotate the token (agend web-token rotate).";

/**
 * A revocation that holds only in memory is reported as a failure (500), never as "ok": the browser is
 * still told to drop its cookie (it is signed out here), but whoever asked must not believe a session is
 * dead that the next start revives.
 */
function notDurable(res: ServerResponse, ctx: { logger: Logger }, detail: Record<string, unknown>, msg: string, clearCookie = true): true {
  ctx.logger.warn({ ...detail, durable: false }, msg);
  json(res, 500, { ok: false, durable: false, error: REVOCATION_NOT_DURABLE_MESSAGE }, clearCookie ? { "Set-Cookie": buildClearedSessionCookies() } : {});
  return true;
}
