/**
 * The gateway: the one listener that is allowed to face the outside.
 *
 * The dashboard/health server carries things that must never cross a tunnel or a
 * reverse proxy — `POST /agent` (instance-token RPC), the CLI's `X-Agend-Token`
 * header, the fleet-control routes, `/health`. Pointing a tunnel at that port would
 * make the path list and the gate the only thing between the internet and them.
 * A separate listener makes the boundary the *port*: it answers only what is named
 * here, to only the Host names the operator listed, and honours only a session — so
 * a bug in the gate cannot expose a route the gateway never routes.
 *
 * This file is the policy, with no I/O, so it can be tested directly. The listener
 * itself and the shared request handler live in `fleet-manager.ts`.
 *
 * See `docs/design/web-unification-secure-login.zh-TW.md` §6.3.
 */
import { isIP } from "node:net";
import { hostnameOf } from "./web-host-guard.js";

/** Enough for a few browsers with their parallel requests; a scanner cannot hold the process open with more. */
export const GATEWAY_MAX_CONNECTIONS = 64;
/** A request that has not finished arriving by then is dropped (slow-loris). */
export const GATEWAY_REQUEST_TIMEOUT_MS = 30_000;

/** The Host names the gateway answers to: exactly `web.external_hosts`. Loopback names are not among them. */
export function gatewayHostNames(config: { web?: { external_hosts?: unknown } | null } | null | undefined): Set<string> {
  const names = new Set<string>();
  const list = config?.web?.external_hosts;
  if (!Array.isArray(list)) return names;
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const name = hostnameOf(entry);
    if (name) names.add(name);
  }
  return names;
}

/** Whether a gateway should exist at all: an explicit host list and an explicit port. Otherwise there is no such listener. */
export function gatewayConfigured(config: { web?: { external_hosts?: unknown; gateway_port?: unknown } | null } | null | undefined): number | null {
  const port = config?.web?.gateway_port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return gatewayHostNames(config).size > 0 ? port : null;
}

const PANEL_PREFIXES = ["/ui", "/settings", "/view"];

/**
 * Every route the gateway serves. Anything else is a 404 before the gate is even
 * asked — including `/agent`, `/health`, `/status`, `/activity`, `/api/activity`,
 * `/restart/*` and `/auth/issue-code`.
 *
 * What is here is what the three panels actually call (checked against
 * `src/ui/*.html`), and no more: the Settings page starts and stops instances with
 * `/stop/:n` and `/api/instance/:n/start` and reads `/api/fleet`.
 */
export function isGatewayRoute(method: string | undefined, path: string): boolean {
  const m = method ?? "GET";
  if (path === "/" || path === "/signin" || path === "/favicon.ico") return m === "GET" || m === "HEAD";

  if (path.startsWith("/assets/")) return m === "GET";

  // Everything under /auth/ except the CLI's way to ask for a code, which needs the header token the gateway never accepts.
  if (path === "/auth/login") return m === "POST";
  if (path === "/auth/session") return m === "GET";
  if (path === "/auth/logout") return m === "POST";
  if (path === "/auth/sessions") return m === "GET" || m === "DELETE";
  if (path.startsWith("/auth/sessions/")) return m === "DELETE" && !path.slice("/auth/sessions/".length).includes("/");

  for (const prefix of PANEL_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return true;
  }
  if (path.startsWith("/api/settings/")) return true;

  // /view's data routes
  if (path.startsWith("/api/pane/") || path.startsWith("/api/profile/") || path.startsWith("/api/avatar/")) return true;
  if (path === "/api/profiles" || path === "/api/sort-order" || path === "/api/ai-usage") return true;

  // What the Settings page calls to start/stop an instance and to read live state.
  if (path === "/api/fleet") return m === "GET";
  if (path.startsWith("/stop/")) return m === "POST" && !path.slice("/stop/".length).includes("/");
  if (/^\/api\/instance\/[^/]+\/start$/.test(path)) return m === "POST";
  return false;
}

/**
 * Where a gateway request says it came from, for the device list and the sign-in
 * notice. `CF-Connecting-IP` is set by Cloudflare, but anything that reaches the
 * gateway port can set it, so it is a label for a person to look at and never an
 * input to a decision. Only a well-formed IP is shown.
 */
export function gatewaySourceHint(headers: NodeJS.Dict<string | string[]>): string | null {
  const raw = headers["cf-connecting-ip"];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value && isIP(value) ? value : null;
}

/**
 * How recently a gateway session must have signed in to do something that amounts to
 * running code on this machine. Thirty minutes: long enough to work, short enough
 * that a cookie lifted from a browser an hour ago cannot restart your fleet.
 */
export const GATEWAY_RECENT_AUTH_MS = 30 * 60 * 1000;

/** The machine-readable answer a page recognises; not a sentence, so nothing has to parse prose. */
export const WEB_REAUTH_REQUIRED = "reauth_required";

/**
 * Writes that change what is shown or remembered, and nothing about what runs.
 * Everything else that writes is Tier 2 by default: a route added later is
 * protected until someone decides otherwise, rather than exposed until someone
 * remembers to list it.
 *
 * Deliberately conservative next to the design's table: tasks, schedules and teams
 * are Tier 2 here, because a task or a schedule is a message an agent will act on.
 */
const TIER1_WRITE_PREFIXES = ["/api/profile/", "/api/avatar/", "/api/sort-order", "/auth/"];

/**
 * Tier 2 — the requests that, from a session, are close to a shell: sending an agent
 * a message, creating or removing or restarting one, changing settings, applying or
 * restarting the fleet, handling secrets. Reads are never Tier 2.
 */
export function requiresRecentAuth(method: string | undefined, path: string): boolean {
  const m = (method ?? "GET").toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return false;
  return !TIER1_WRITE_PREFIXES.some(prefix => path === prefix || path.startsWith(prefix));
}
