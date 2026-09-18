import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

export const WEB_TOKEN_INVALID_MESSAGE = "Token expired or invalid — run /dashboard again";
/** No credential at all. Distinct from "wrong credential" so a browser that
 * silently drops cookies is diagnosable instead of looking like a bad token. */
export const WEB_SESSION_REQUIRED_MESSAGE =
  "No session — open the dashboard link again (cookies must be enabled for this site)";
export const WEB_CROSS_SITE_MESSAGE = "Cross-site request rejected";
/** A URL token is redeemed for a session cookie on a GET; it is never a
 * credential for a write, where it would also survive in history and logs. */
export const WEB_URL_TOKEN_WRITE_MESSAGE =
  "URL tokens are only redeemed on GET — send X-Agend-Token for API writes";

const WEB_TOKEN_PATTERN = /^[0-9a-f]{48}$/i;

export const WEB_SESSION_COOKIE = "agend_session";
/** 12h. The old model was "valid forever"; the panel is an escape hatch, so the
 * cookie outlives a working day and nothing more. `web-token rotate` kills every
 * issued cookie immediately regardless of this. */
export const WEB_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

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

/**
 * The cookie carries a derivation of the token, never the token itself: a
 * stolen cookie opens the panel but cannot be replayed as `?token=` /
 * `X-Agend-Token` (which also authorize /view writes and the CLI). Rotating
 * `web.token` changes the derivation, so every issued cookie dies with it.
 */
export function webSessionCookieValue(token: string): string {
  return createHash("sha256").update(`agend-web-session-v1:${token}`).digest("hex");
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
  | { readonly kind: "allow" }
  | { readonly kind: "exchange"; readonly setCookie: string; readonly location: string }
  | { readonly kind: "reject"; readonly status: 401 | 403; readonly message: string };

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
function isSecureRequest(req: WebGateRequest): boolean {
  const proto = headerValue(req, "x-forwarded-proto");
  if (!proto) return false;
  return proto.split(",")[0]!.trim().toLowerCase() === "https";
}

export function buildSessionCookie(token: string, secure: boolean): string {
  const attrs = [
    `${WEB_SESSION_COOKIE}=${webSessionCookieValue(token)}`,
    "Path=/",
    "HttpOnly",
    // Strict, not Lax: the panel can restart instances, so a cross-site
    // navigation must not arrive already authenticated.
    "SameSite=Strict",
    `Max-Age=${WEB_SESSION_MAX_AGE_SECONDS}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function hasValidSessionCookie(req: WebGateRequest, token: string): boolean {
  const cookie = parseCookieHeader(headerValue(req, "cookie") ?? undefined).get(WEB_SESSION_COOKIE);
  return !!cookie && constantTimeEquals(cookie, webSessionCookieValue(token));
}

function hasValidHeaderToken(req: WebGateRequest, token: string): boolean {
  const provided = headerValue(req, "x-agend-token");
  return !!provided && constantTimeEquals(provided, token);
}

/** Same-origin relative target with the token stripped and every other query
 * parameter kept. Relative on purpose: an absolute Location built from
 * attacker-supplied Host would be an open redirect. */
function locationWithoutToken(url: URL): string {
  const stripped = new URL(url.href);
  stripped.searchParams.delete("token");
  return `${stripped.pathname}${stripped.search}`;
}

/**
 * The single authorization decision for every gated web route.
 *
 * Accepts, in order: a session cookie, an `X-Agend-Token` header (CLI and
 * scripts), and — only to be redeemed for a cookie on a GET — a `?token=` in
 * the URL. After the redemption the token is gone from the address bar, from
 * browser history, and from anything that logs request URLs.
 */
export function decideWebGate(req: WebGateRequest, url: URL, token: string | null): WebGateDecision {
  // No token on disk means the panel is closed, not open to everyone. Without
  // this, a null token compared against a missing credential authorizes.
  if (!token) return { kind: "reject", status: 401, message: WEB_TOKEN_INVALID_MESSAGE };

  if (!isSameOriginRequest(req)) {
    return { kind: "reject", status: 403, message: WEB_CROSS_SITE_MESSAGE };
  }

  if (hasValidSessionCookie(req, token)) return { kind: "allow" };
  if (hasValidHeaderToken(req, token)) return { kind: "allow" };

  const queryToken = url.searchParams.get("token");
  if (queryToken && constantTimeEquals(queryToken, token)) {
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return { kind: "reject", status: 401, message: WEB_URL_TOKEN_WRITE_MESSAGE };
    }
    return {
      kind: "exchange",
      setCookie: buildSessionCookie(token, isSecureRequest(req)),
      location: locationWithoutToken(url),
    };
  }

  const presented = queryToken ?? headerValue(req, "x-agend-token") ?? headerValue(req, "cookie");
  return {
    kind: "reject",
    status: 401,
    message: presented ? WEB_TOKEN_INVALID_MESSAGE : WEB_SESSION_REQUIRED_MESSAGE,
  };
}

/** Defence in depth for handlers that run behind the gate: authorization only,
 * no cookie issuing (the gate already did that). */
export function isWebRequestAuthorized(req: WebGateRequest, url: URL, token: string | null): boolean {
  if (!token) return false;
  if (!isSameOriginRequest(req)) return false;
  if (hasValidSessionCookie(req, token)) return true;
  if (hasValidHeaderToken(req, token)) return true;
  const queryToken = url.searchParams.get("token");
  return !!queryToken && constantTimeEquals(queryToken, token);
}
