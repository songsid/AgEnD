import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import {
  csrfTokenFor,
  labelFromUserAgent,
  tokenEpoch,
  type SessionRecord,
  type WebSessionStore,
} from "./web-session.js";

export const WEB_TOKEN_INVALID_MESSAGE = "Token expired or invalid — run /dashboard again";
/** No credential at all. Distinct from "wrong credential" so a browser that
 * silently drops cookies is diagnosable instead of looking like a bad token. */
export const WEB_SESSION_REQUIRED_MESSAGE =
  "No session — open the dashboard link again (cookies must be enabled for this site)";
/** A cookie was sent and the server no longer honours it: expired, signed out, revoked or rotated away. */
export const WEB_SESSION_EXPIRED_MESSAGE = "Session expired or signed out — sign in again";
export const WEB_CROSS_SITE_MESSAGE = "Cross-site request rejected";

const WEB_TOKEN_PATTERN = /^[0-9a-f]{48}$/i;

/** Plain over http (loopback); `__Host-` over https, which pins Secure + Path=/ + no Domain in the browser. */
export const WEB_SESSION_COOKIE = "agend_session";
export const WEB_SESSION_COOKIE_SECURE = "__Host-agend_session";
/** Sent by pages on every write; the value is `csrfTokenFor(sessionId)`, handed out by `GET /auth/session`. */
export const WEB_CSRF_HEADER = "x-agend-csrf";
export const WEB_CSRF_MESSAGE = "Write rejected — missing or wrong CSRF token (reload the page)";

function readValidToken(path: string): string | null {
  try {
    const token = readFileSync(path, "utf8").trim();
    return WEB_TOKEN_PATTERN.test(token) ? token : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function replaceTokenAtomically(path: string, token: string): void {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temp, token, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* temp was never created or already moved */ }
    throw err;
  }
}

function tokenPath(dataDir: string): string {
  return join(dataDir, "web.token");
}

/**
 * Load the fleet-wide web bearer token, creating it only when absent/invalid.
 * A fleet restart must not revoke every previously issued /dashboard URL.
 */
export function loadOrCreateWebToken(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const path = tokenPath(dataDir);
  const existing = readValidToken(path);
  if (existing) {
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
    return existing;
  }

  const token = randomBytes(24).toString("hex");
  replaceTokenAtomically(path, token);
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  return token;
}

/**
 * The token as it is on disk right now, without creating one.
 *
 * Deliberately unbuffered: `agend web-token rotate` writes the file from a
 * separate process, and a cached copy would keep authorizing revoked sessions
 * until the fleet restarted — which is the whole point of having rotation.
 * mtime/size caching cannot be used either, since a rotation within the same
 * millisecond produces a same-size file.
 */
export function readWebToken(dataDir: string): string | null {
  try {
    return readValidToken(tokenPath(dataDir));
  } catch {
    // This runs inside the request handler. A permissions or I/O error must
    // close the panel, not throw out of the HTTP callback.
    return null;
  }
}

/**
 * Replace the token with a fresh one. Every previously issued URL, header token
 * and session cookie stops being accepted as soon as the next request is served.
 */
export function rotateWebToken(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const path = tokenPath(dataDir);
  const token = randomBytes(24).toString("hex");
  replaceTokenAtomically(path, token);
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  return token;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself leak length.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function parseCookieHeader(header: string | undefined): Map<string, string> {
  const jar = new Map<string, string>();
  if (!header) return jar;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || jar.has(name)) continue;
    jar.set(name, part.slice(eq + 1).trim());
  }
  return jar;
}

/** Minimal request shape — everything the gate reads, and nothing more, so the
 * decision can be unit-tested without a socket. */
export interface WebGateRequest {
  readonly method?: string | undefined;
  readonly headers: NodeJS.Dict<string | string[]>;
}

export type WebGateDecision =
  | { readonly kind: "allow"; readonly via: "session"; readonly session: SessionRecord }
  | { readonly kind: "allow"; readonly via: "header-token" }
  | {
      readonly kind: "reject";
      readonly status: 401 | 403;
      readonly message: string;
      /** `no-credential` is "nothing was presented" — the case a browser navigation answers with the sign-in page. */
      readonly reason: "closed" | "no-credential" | "invalid" | "cross-site" | "csrf";
    };

function headerValue(req: WebGateRequest, name: string): string | null {
  const raw = req.headers[name];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw[0] ?? null;
  return null;
}

/**
 * True when the request either carries no Origin (a CLI, or a top-level GET
 * navigation, neither of which a cross-site attacker controls) or carries one
 * that matches the Host it was sent to.
 *
 * Only a *mismatch* rejects: requiring Origin would break every non-browser
 * caller, which is the same `X-Agend-Token` path the CLI uses.
 */
export function isSameOriginRequest(req: WebGateRequest): boolean {
  const origin = headerValue(req, "origin");
  if (!origin) return true;
  const host = headerValue(req, "host");
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    // Anything unparseable is cross-site, including the opaque `null` origin
    // that sandboxed frames and some redirect chains send.
    return false;
  }
}

/** Whether the browser reached us over TLS, which decides the cookie's Secure
 * attribute. The health server is always plain HTTP, so the only signal is the
 * tunnel/proxy in front of it. A forged header can only make us set Secure on a
 * plain-HTTP response, which costs the forger their own cookie and nothing else. */
export function isSecureRequest(req: WebGateRequest): boolean {
  const proto = headerValue(req, "x-forwarded-proto");
  if (!proto) return false;
  return proto.split(",")[0]!.trim().toLowerCase() === "https";
}

/**
 * The session cookie for a freshly minted session.
 *
 * `Max-Age` is a courtesy so the browser forgets it when the server would; the
 * server enforces the expiry itself and does not rely on the browser doing so.
 */
export function buildSessionCookie(sessionId: string, secure: boolean, maxAgeSeconds: number): string {
  const attrs = [
    `${secure ? WEB_SESSION_COOKIE_SECURE : WEB_SESSION_COOKIE}=${sessionId}`,
    "Path=/",
    "HttpOnly",
    // Strict, not Lax: the panel can restart instances, so a cross-site
    // navigation must not arrive already authenticated. The sign-in page
    // handles the resulting "landed from a chat link" case.
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** Expire the cookie under both names: which one was set depends on how the browser reached us. */
export function buildClearedSessionCookies(): string[] {
  return [
    `${WEB_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    `${WEB_SESSION_COOKIE_SECURE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure`,
  ];
}

/** The presented session id, or undefined. A `__Host-` cookie wins: it cannot have been planted by a sibling site. */
export function readSessionCookie(req: WebGateRequest): string | undefined {
  const jar = parseCookieHeader(headerValue(req, "cookie") ?? undefined);
  return jar.get(WEB_SESSION_COOKIE_SECURE) ?? jar.get(WEB_SESSION_COOKIE);
}

export function hasValidHeaderToken(req: WebGateRequest, token: string): boolean {
  const provided = headerValue(req, "x-agend-token");
  return !!provided && constantTimeEquals(provided, token);
}

function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

/**
 * The extra checks a write must pass when the only thing authorizing it is a
 * cookie — an ambient credential the browser attaches to whatever page asks.
 *
 * Three independent ones, so that a gap in any single one (a browser without
 * `Sec-Fetch-Site`, a same-site sibling that SameSite cannot tell from us) is
 * not the whole defence:
 * 1. `Origin` must be present and equal to `Host`. Present, unlike the read
 *    path: every browser sends it on a same-origin write, and its absence on a
 *    cookie-authenticated POST is a request nobody legitimate makes.
 * 2. `Sec-Fetch-Site`, when the browser sends it, must say `same-origin`.
 * 3. `X-Agend-CSRF` must equal the value derived from this session's id. A
 *    cross-site page cannot set a custom header without a preflight this server
 *    never approves, and cannot read the value.
 */
function passesCookieWriteChecks(req: WebGateRequest, sessionId: string): boolean {
  if (!headerValue(req, "origin")) return false;
  const site = headerValue(req, "sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  const presented = headerValue(req, WEB_CSRF_HEADER);
  return !!presented && constantTimeEquals(presented, csrfTokenFor(sessionId));
}

export type SessionAuthResult =
  | { readonly kind: "ok"; readonly session: SessionRecord; readonly sessionId: string }
  | { readonly kind: "reject"; readonly status: 401 | 403; readonly message: string };

/**
 * Session-only authorization, for the endpoints that are *about* the session
 * (who am I, sign out, list devices). A header token is not a session and is not
 * accepted here; everything else — Origin, expiry, rotation, and the write
 * checks for an unsafe method — is the same as for any gated route.
 */
export function authorizeSession(
  req: WebGateRequest,
  token: string | null,
  sessions: WebSessionStore | null | undefined,
  opts: { touch?: boolean } = {},
): SessionAuthResult {
  if (!token) return { kind: "reject", status: 401, message: WEB_TOKEN_INVALID_MESSAGE };
  if (!isSameOriginRequest(req)) return { kind: "reject", status: 403, message: WEB_CROSS_SITE_MESSAGE };
  const cookie = readSessionCookie(req);
  const session = sessions && cookie ? sessions.authenticate(cookie, tokenEpoch(token), { touch: opts.touch !== false }) : null;
  if (!session || !cookie) {
    return { kind: "reject", status: 401, message: cookie ? WEB_SESSION_EXPIRED_MESSAGE : WEB_SESSION_REQUIRED_MESSAGE };
  }
  const method = (req.method ?? "GET").toUpperCase();
  if (!isSafeMethod(method) && !passesCookieWriteChecks(req, cookie)) {
    return { kind: "reject", status: 403, message: WEB_CSRF_MESSAGE };
  }
  return { kind: "ok", session, sessionId: cookie };
}

interface AuthorizeOptions {
  /** Whether a valid cookie counts as activity (slides the idle expiry). */
  readonly touch: boolean;
}

function authorize(
  req: WebGateRequest,
  url: URL,
  token: string | null,
  sessions: WebSessionStore | null | undefined,
  opts: AuthorizeOptions,
): WebGateDecision {
  // No token on disk means the panel is closed, not open to everyone. Without
  // this, a null token compared against a missing credential authorizes.
  if (!token) return { kind: "reject", status: 401, message: WEB_TOKEN_INVALID_MESSAGE, reason: "closed" };

  if (!isSameOriginRequest(req)) {
    return { kind: "reject", status: 403, message: WEB_CROSS_SITE_MESSAGE, reason: "cross-site" };
  }

  const method = (req.method ?? "GET").toUpperCase();

  // A header credential is not ambient — a page cannot make the browser add it —
  // so it needs none of the cookie write checks, and is tried first: a request
  // carrying both is the CLI's, not a forged form's.
  if (hasValidHeaderToken(req, token)) return { kind: "allow", via: "header-token" };

  const cookie = readSessionCookie(req);
  if (sessions && cookie) {
    const session = sessions.authenticate(cookie, tokenEpoch(token), { touch: opts.touch });
    if (session) {
      if (!isSafeMethod(method) && !passesCookieWriteChecks(req, cookie)) {
        return { kind: "reject", status: 403, message: WEB_CSRF_MESSAGE, reason: "csrf" };
      }
      return { kind: "allow", via: "session", session };
    }
  }

  // A `?token=` in the URL is not a credential (it used to be redeemed for a cookie on a GET). A URL
  // ends up in browser history, chat scrollback, screenshots and request logs; the dashboard now
  // gives a one-time sign-in code instead, and the CLI and scripts send the X-Agend-Token header.
  // A link that still carries one is answered like no credential at all: the sign-in page.

  // A wrong header token is somebody presenting a credential and getting it wrong.
  // A cookie that no longer works is the ordinary end of a session, not that: it is the same
  // "you need to sign in" as no cookie at all, and a browser navigation should be answered
  // with the sign-in page either way.
  if (headerValue(req, "x-agend-token")) {
    return { kind: "reject", status: 401, message: WEB_TOKEN_INVALID_MESSAGE, reason: "invalid" };
  }
  return {
    kind: "reject",
    status: 401,
    message: cookie ? WEB_SESSION_EXPIRED_MESSAGE : WEB_SESSION_REQUIRED_MESSAGE,
    reason: "no-credential",
  };
}

/**
 * The single authorization decision for every gated web route.
 *
 * Accepts, in order: an `X-Agend-Token` header (CLI and scripts) and a session
 * cookie (made by signing in with a one-time code). Never a credential in the URL.
 */
export function decideWebGate(
  req: WebGateRequest,
  url: URL,
  token: string | null,
  sessions: WebSessionStore | null | undefined,
): WebGateDecision {
  return authorize(req, url, token, sessions, { touch: true });
}

/**
 * Defence in depth for handlers that run behind the gate: the same decision, as a boolean.
 *
 * `touch: false` is for a long-lived stream re-checking itself on a timer, which
 * must be able to notice a revocation without counting as activity.
 */
export function isWebRequestAuthorized(
  req: WebGateRequest,
  url: URL,
  token: string | null,
  sessions?: WebSessionStore | null,
  opts: { touch?: boolean } = {},
): boolean {
  return authorize(req, url, token, sessions, { touch: opts.touch !== false }).kind === "allow";
}
