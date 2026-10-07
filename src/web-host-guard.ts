/**
 * Which `Host` values the dashboard/health listener answers to, and the
 * response headers every one of its answers carries.
 *
 * Binding to 127.0.0.1 is not a boundary against a web page. DNS rebinding
 * points an attacker's own domain at 127.0.0.1 after the browser has loaded
 * their page, so the page's requests reach this listener with
 * `Origin == Host == attacker.example` — which is exactly what the same-origin
 * check accepts — and the routes that need no cookie (`/view`'s pane capture,
 * the roster, usage) can be read from script. The one thing the attacker cannot
 * change is the name the browser puts in `Host`, so that name is the check.
 *
 * Port is deliberately not compared: a port-forward or a reverse proxy changes
 * it legitimately, and the attack does not depend on it.
 */
import type { ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

export const WEB_HOST_REJECTED_MESSAGE =
  "Host not allowed — if you reach AgEnD through a reverse proxy or another name, add it to web.allowed_hosts in fleet.yaml";

/** Names a browser on this machine uses for a loopback listener. */
export const LOOPBACK_HOST_NAMES: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

/**
 * The host name in a `Host` header (or a configured host), lower-cased and
 * without port, or null for anything that is not a plain name/IP.
 *
 * Strict on purpose: userinfo, paths, whitespace and scheme have no business in
 * a Host header, and a value that only *contains* an allowed name must not be
 * mistaken for it.
 */
export function hostnameOf(value: string): string | null {
  const host = value.trim().toLowerCase();
  if (!host || host.length > 255) return null;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end < 0) return null;
    const rest = host.slice(end + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return null;
    const literal = host.slice(0, end + 1);
    return /^\[[0-9a-f:.]+\]$/.test(literal) ? literal : null;
  }
  const match = /^([a-z0-9._-]+)(?::\d{1,5})?$/.exec(host);
  if (!match) return null;
  // `localhost.` is the same name; an absolute FQDN must not be a bypass in
  // either direction.
  return match[1]!.replace(/\.$/, "") || null;
}

/**
 * What a page served here may load and where it may send anything.
 *
 * `script-src` is this origin only — no `'unsafe-inline'` (#1268): a panel's own inline
 * script runs because the panel is served with a per-response nonce for it
 * (sendPanelHtml), and no panel has an inline `on*=` handler. Injected markup can
 * therefore not run script. `connect-src`, `img-src` and `form-action` are this
 * origin, so nothing read can be posted elsewhere, and `base-uri`, `object-src` and
 * `frame-ancestors` are closed. `style-src` keeps `'unsafe-inline'` for now: the
 * panels still carry `style="…"` attributes (and a nonce in style-src would make
 * browsers ignore `'unsafe-inline'`, blocking them); styles cannot run code.
 *
 * Fonts, scripts and styles are all served from here; nothing loads from a CDN.
 */
export const WEB_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export interface HostGuardConfig {
  hostname?: string;
  web?: { allowed_hosts?: unknown } | null;
}

/** Loopback names, the `hostname:` handed out in /dashboard links, and `web.allowed_hosts`. */
export function allowedHostNames(config: HostGuardConfig | null | undefined): Set<string> {
  const names = new Set<string>(LOOPBACK_HOST_NAMES);
  const add = (candidate: unknown): void => {
    if (typeof candidate !== "string") return;
    const name = hostnameOf(candidate);
    if (name) names.add(name);
  };
  add(config?.hostname);
  const extra = config?.web?.allowed_hosts;
  if (Array.isArray(extra)) for (const entry of extra) add(entry);
  return names;
}

/** A missing or malformed Host is refused: every real browser sends one. */
export function isHostAllowed(hostHeader: string | string[] | undefined, allowed: ReadonlySet<string>): boolean {
  if (typeof hostHeader !== "string") return false;
  const name = hostnameOf(hostHeader);
  return name !== null && allowed.has(name);
}

/**
 * Headers for every response the listener sends, set before routing so the
 * rejections carry them too.
 *
 * `Cache-Control: no-store` is a default, not a mandate: a route that writes its
 * own Cache-Control in `writeHead` (the avatar, the SSE stream) wins, because
 * Node merges `writeHead` headers over `setHeader` ones.
 */
export function applyWebSecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  // These pages have buttons that restart instances and change configuration;
  // a page that can be framed can be clicked through.
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", WEB_CONTENT_SECURITY_POLICY);
  // Authorization now depends on a cookie, so a shared cache (a tunnel, a
  // corporate proxy) must not keep or replay any of it.
  res.setHeader("Cache-Control", "no-store");
}

/** The panel policy for one response: WEB_CONTENT_SECURITY_POLICY with this response's script nonce. */
export function panelContentSecurityPolicy(nonce: string): string {
  return WEB_CONTENT_SECURITY_POLICY.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`);
}

/**
 * Send a panel page (/ui, /view, /settings, the sign-in page). Its own inline `<script>` blocks get a fresh nonce,
 * and the response's CSP names that nonce and nothing else inline (#1268): a script that was not in the file as
 * served — anything injected into the page — has no nonce and does not run.
 */
export function sendPanelHtml(res: ServerResponse, html: string, status = 200, headers: Record<string, string> = {}): void {
  const nonce = randomBytes(18).toString("base64");
  res.setHeader("Content-Security-Policy", panelContentSecurityPolicy(nonce));
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...headers });
  res.end(html.replace(/<script>/g, `<script nonce="${nonce}">`));
}
