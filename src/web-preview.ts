/**
 * #1306: the preview listener — where an agent's HTML may run, away from the dashboard's authority.
 * Design: docs/design/1306-inline-html-preview.md (r3, approved).
 *
 * A second loopback listener (default health_port + 1) serves one static document, `GET /frame`: a shim that
 * receives HTML by postMessage only from the dashboard origins it was built with, and writes it into its own
 * opaque, sandboxed document. Everything else is an empty 404. It reads no cookie, no header but Host, and logs
 * nothing about a request. The dashboard decides per /ui load whether a preview origin is reachable from the
 * browser's address (Host only — never X-Forwarded-Host), and the page re-checks that against location.origin.
 *
 * What this does NOT promise: that a preview cannot send data out (WebRTC and self-navigation are known ways
 * around the restrictions — design §4.3). It promises the account boundary only (G1): the preview cannot act as
 * the signed-in person.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { allowedHostNames, hostnameOf, LOOPBACK_HOST_NAMES, type HostGuardConfig } from "./web-host-guard.js";

/** The most HTML a preview takes (UTF-8 bytes): the parent refuses more before sending, the shim refuses it too. */
export const PREVIEW_HTML_MAX_BYTES = 1024 * 1024;

export interface PreviewWebConfig {
  preview?: unknown;
  preview_port?: unknown;
  preview_origin?: unknown;
}

export interface PreviewSettings {
  /** `web.preview` (default true): false means no listener, and cards show Source / Download only. */
  enabled: boolean;
  /** The preview listener's port, on 127.0.0.1; null when there is no valid one (health_port 65535 and no preview_port). */
  port: number | null;
  /** `web.preview_origin`, normalised to scheme://host[:port], or null. */
  origin: string | null;
}

/** The settings a fleet runs with: `web.preview`, `web.preview_port` (default health_port + 1), `web.preview_origin`. */
export function previewSettings(web: PreviewWebConfig | null | undefined, healthPort: number): PreviewSettings {
  // An ephemeral web listener (port 0: tests, harnesses) gets an ephemeral preview listener; its real port is filled
  // in once it listens (createPreviewListener). Otherwise the fixed default, so an SSH user can forward it too.
  const port = typeof web?.preview_port === "number" && Number.isInteger(web.preview_port) ? web.preview_port
    : healthPort === 0 ? 0 : healthPort + 1 <= 65535 ? healthPort + 1 : null;
  const origin = typeof web?.preview_origin === "string" ? normalizeOrigin(web.preview_origin) : null;
  return { enabled: web?.preview !== false, port, origin };
}

/** scheme://host[:port] for an http(s) URL with nothing else in it; null otherwise. A default port is dropped. */
export function normalizeOrigin(value: string): string | null {
  let u: URL;
  try { u = new URL(value.trim()); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
  if (!u.hostname || u.hostname.includes("*")) return null;
  // The raw text must not carry a query/fragment marker either ("https://x/?" parses to an empty search).
  if (/[?#]/.test(value)) return null;
  return u.origin;
}

/**
 * Why a `web.preview_origin` cannot be used, or null when it can (design §3.1). It must be a bare http(s) origin
 * (no path, query, credentials or wildcard), and its host must not be one the dashboard answers to — that would be
 * a same-origin preview by another name.
 */
export function previewOriginProblem(value: unknown, config: HostGuardConfig | null | undefined): string | null {
  if (typeof value !== "string") return "must be an origin such as https://preview.example.net";
  const origin = normalizeOrigin(value);
  if (!origin) return "must be a bare http(s) origin — scheme, host and optional port; no path, query, fragment, credentials or wildcard";
  const host = hostnameOf(new URL(origin).host);
  if (!host || allowedHostNames(config).has(host)) return "must be a separate host name, not one the dashboard answers to (loopback names, hostname, web.allowed_hosts)";
  return null;
}

// ── Which preview origin a /ui load gets (design §3.2) ─────────────────────────────────────────────────────

export interface PreviewAvailability {
  /** The origin the server believes the browser is at (from Host and the TLS signal), or null. */
  dashboardOrigin: string | null;
  /** The preview origin for this load, or null: preview disabled for it. */
  previewOrigin: string | null;
  /** Why it is disabled, when it is. */
  reason: string | null;
  /** The same reason as a stable code the page translates (#1554); null when enabled. */
  code: PreviewOffCode | null;
}

/**
 * #1554: why previews are off for a load, for the page's own words (chat.pvServer_<code>). The first seven come from
 * previewAvailability; `publicLink` and `notOffered` from the app shell, which asks it for neither the public link nor
 * a page that is not the full app. One list: the page's dictionary is checked against it.
 */
export const PREVIEW_OFF_CODES = ["fleetOff", "unchecked", "noPort", "notListed", "needOrigin", "needHttps", "sameOrigin", "publicLink", "notOffered"] as const;
export type PreviewOffCode = typeof PREVIEW_OFF_CODES[number];

const DEFAULT_PORT: Record<string, string> = { "http:": "80", "https:": "443" };

/** scheme://host[:port] from a Host header the host guard already accepted; a default port is dropped. */
export function dashboardOriginFor(hostHeader: string | undefined, secure: boolean): string | null {
  if (typeof hostHeader !== "string" || hostnameOf(hostHeader) === null) return null;
  const scheme = secure ? "https:" : "http:";
  try { return new URL(`${scheme}//${hostHeader.trim().toLowerCase()}`).origin; } catch { return null; }
  // (URL drops a default port: http://x:80 → http://x, so it matches what the browser reports as location.origin.)
}

/**
 * For one /ui request: a loopback Host and no preview_origin → the same loopback name on the preview port;
 * preview_origin set → that; anything else (a tunnel, a proxy, `hostname`, `allowed_hosts`) → disabled.
 * Only Host is read; X-Forwarded-Host never is.
 */
export function previewAvailability(settings: PreviewSettings | null, hostHeader: string | undefined, secure: boolean, accepted?: readonly string[]): PreviewAvailability {
  const dashboardOrigin = dashboardOriginFor(hostHeader, secure);
  const off = (code: PreviewOffCode, reason: string): PreviewAvailability => ({ dashboardOrigin, previewOrigin: null, reason, code });
  if (!settings || !settings.enabled) return off("fleetOff", "Previews are turned off for this fleet (web.preview: false).");
  if (!dashboardOrigin) return off("unchecked", "This address cannot be checked.");
  if (settings.port === null && !settings.origin) return off("noPort", "Previews have no port: set web.preview_port (health_port is the highest port).");
  // The page must be at an origin the shim takes HTML from (and that may frame it) — exactly, or a frame would never
  // render. A name in web.allowed_hosts served on a non-default port must be listed with that port.
  if (accepted && !accepted.includes(dashboardOrigin)) return off("notListed", `Previews are not offered at ${dashboardOrigin}: list this address (with its port) in web.allowed_hosts, and set web.preview_origin.`);
  let preview: string;
  if (settings.origin) preview = settings.origin;
  else {
    const host = hostnameOf(hostHeader!)!;
    if (!LOOPBACK_HOST_NAMES.includes(host)) return off("needOrigin", "Previews need web.preview_origin when the dashboard is reached through a tunnel or proxy.");
    preview = `http://${host}:${settings.port}`;
  }
  // An https page cannot frame an http preview (mixed content).
  if (dashboardOrigin.startsWith("https:") && preview.startsWith("http:")) return off("needHttps", "Previews need an https web.preview_origin when the dashboard is reached over https.");
  if (preview === dashboardOrigin) return off("sameOrigin", "The preview origin cannot be the dashboard's own.");
  return { dashboardOrigin, previewOrigin: preview, reason: null, code: null };
}

/**
 * The exact dashboard origins a preview may be framed by, and accept HTML from (design §5.1): the loopback names on
 * the dashboard's port, plus — when a preview_origin is set — `https://<name>` for each name the dashboard answers to
 * besides loopback (`hostname`, `web.allowed_hosts`). Never 'self', never *.
 */
export function dashboardOrigins(settings: PreviewSettings, healthPort: number, config: HostGuardConfig | null | undefined): string[] {
  // As the browser writes location.origin: a default port is dropped (http://127.0.0.1:80 → http://127.0.0.1).
  const origin = (u: string): string | null => { try { return new URL(u).origin; } catch { return null; } };
  const out = LOOPBACK_HOST_NAMES.map(h => origin(`http://${h}:${healthPort}`)).filter((o): o is string => !!o);
  if (settings.origin) {
    // Each extra dashboard name as written — with its port when it has one (fleet.example.net:8443).
    const extra = [config?.hostname, ...(Array.isArray(config?.web?.allowed_hosts) ? config!.web!.allowed_hosts as unknown[] : [])];
    for (const entry of extra) {
      if (typeof entry !== "string") continue;
      const name = hostnameOf(entry);
      if (!name || LOOPBACK_HOST_NAMES.includes(name)) continue;
      const o = origin(`https://${entry.trim().toLowerCase()}`);
      if (o) out.push(o);
    }
  }
  return [...new Set(out)];
}

// ── The listener ────────────────────────────────────────────────────────────────────────────────────────────

const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), display-capture=(), fullscreen=()";

/** The /frame response's Content-Security-Policy (design §5.1): exact, no 'self', no *. */
export function previewFrameCsp(ancestors: readonly string[]): string {
  return [
    "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
    "img-src data: blob:", "font-src data:", "media-src data: blob:",
    "connect-src 'none'", "worker-src 'none'", "frame-src 'none'", "child-src 'none'",
    "form-action 'none'", "base-uri 'none'", "manifest-src 'none'", "object-src 'none'",
    "webrtc 'block'",
    `frame-ancestors ${ancestors.join(" ")}`,
    "sandbox allow-scripts",
  ].join("; ");
}

/**
 * The shim (design §4): posts `ready` with the listener's boot id; takes ONE `render` — from its parent window, from
 * an exact listed dashboard origin (never "null"), with exactly {v, type, ch, html}, html ≤ 1 MiB — removes the WebRTC
 * entry points from its realm (defence in depth only), and writes a heartbeat/height prologue and the HTML into its
 * own document. Every later message is ignored.
 */
export function buildShim(bootId: string, origins: readonly string[]): string {
  const script = `(function () {
  "use strict";
  var BOOT = ${JSON.stringify(bootId)}, ORIGINS = ${JSON.stringify([...origins])}, MAX = ${PREVIEW_HTML_MAX_BYTES};
  var done = false;
  function bytes(s) { try { return new TextEncoder().encode(s).length; } catch (e) { return s.length * 3; } }
  window.addEventListener("message", function (e) {
    if (done || e.source !== window.parent || ORIGINS.indexOf(e.origin) < 0) return;
    var d = e.data;
    if (!d || typeof d !== "object" || Object.getPrototypeOf(d) !== Object.prototype) return;
    if (Object.keys(d).sort().join(",") !== "ch,html,type,v" || d.v !== 1 || d.type !== "render") return;
    if (typeof d.ch !== "string" || !/^[0-9a-f]{16,64}$/.test(d.ch) || typeof d.html !== "string" || bytes(d.html) > MAX) return;
    done = true;
    ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceTransport", "RTCSctpTransport"].forEach(function (k) {
      try { delete window[k]; } catch (x) { /* not configurable */ }
      try { if (window[k]) Object.defineProperty(window, k, { value: undefined, configurable: false, writable: false }); } catch (x) { /* best effort */ }
    });
    var prologue = "<script>(function(){var ch=" + JSON.stringify(d.ch) + ",p=window.parent,last=-1;" +
      "function size(){var h=Math.ceil(Math.max(document.documentElement?document.documentElement.scrollHeight:0,document.body?document.body.scrollHeight:0));" +
      "if(h!==last){last=h;p.postMessage({v:1,type:\\"resize\\",ch:ch,height:h},\\"*\\");}}" +
      "setInterval(function(){p.postMessage({v:1,type:\\"heartbeat\\",ch:ch},\\"*\\");},2000);" +
      "p.postMessage({v:1,type:\\"heartbeat\\",ch:ch},\\"*\\");" +
      "try{new ResizeObserver(size).observe(document.documentElement);}catch(e){setInterval(size,500);}" +
      "addEventListener(\\"load\\",size);setTimeout(size,0);})();<\\/script>";
    document.open();
    document.write(prologue + d.html);
    document.close();
  });
  window.parent.postMessage({ v: 1, type: "ready", ch: null, boot: BOOT }, "*");
})();`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Preview</title></head><body><script>${script}</script></body></html>`;
}

export interface PreviewListener {
  readonly server: Server;
  readonly bootId: string;
  readonly settings: PreviewSettings;
  /** The dashboard origins the shim accepts HTML from and may be framed by. */
  readonly origins: readonly string[];
  close(): void;
}

/**
 * The preview listener: GET /frame (no query) → the shim with the §5.1 headers; anything else → empty 404; a Host
 * it does not answer to → empty 403. No X-Frame-Options (it must be framable by the dashboard), no cookie or
 * header parsing beyond Host, nothing logged per request. Built once: the shim and its headers never change.
 */
export function createPreviewListener(opts: { settings: PreviewSettings; healthPort: number; config: HostGuardConfig | null | undefined; bootId?: string }): PreviewListener {
  const bootId = opts.bootId ?? randomBytes(16).toString("hex");
  const origins = dashboardOrigins(opts.settings, opts.healthPort, opts.config);
  const body = Buffer.from(buildShim(bootId, origins), "utf8");
  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": previewFrameCsp(origins),
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Content-Length": String(body.length),
  };
  const hosts = new Set<string>(LOOPBACK_HOST_NAMES);
  if (opts.settings.origin) { const h = hostnameOf(new URL(opts.settings.origin).host); if (h) hosts.add(h); }
  const empty = (res: ServerResponse, status: number) => {
    res.writeHead(status, { "Content-Length": "0", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    res.end();
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Host only. The cookie a same-host port receives (cookies are not port-isolated) is never read.
    const host = typeof req.headers.host === "string" ? hostnameOf(req.headers.host) : null;
    if (!host || !hosts.has(host)) return empty(res, 403);
    if (req.method !== "GET" || req.url !== "/frame") return empty(res, 404);
    res.writeHead(200, headers);
    res.end(body);
  });
  const settings: PreviewSettings = { ...opts.settings };
  // A listener on port 0 learns its real port when it binds: that is the one a /ui load must be offered.
  server.on("listening", () => { const a = server.address(); if (a && typeof a === "object") settings.port = a.port; });
  return { server, bootId, settings, origins, close: () => { server.close(); } };
}
