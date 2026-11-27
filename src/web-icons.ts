import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppIconFile, AppIconStore } from "./web-app-icon.js";

/**
 * Branding: bundled, inert files, or the person's own app icon (#2308) where one is set — the SVG is always the bundled
 * one (a custom icon's pages do not link it). Never resolve a request path into a filesystem path.
 */
const ICONS = {
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml", custom: null },
  "/favicon.ico": { file: "favicon.ico", type: "image/vnd.microsoft.icon", custom: "favicon.ico" },
  "/apple-touch-icon.png": { file: "apple-touch-icon.png", type: "image/png", custom: "apple-touch-icon.png" },
  "/icon-192.png": { file: "icon-192.png", type: "image/png", custom: "icon-192.png" },
  "/icon-512.png": { file: "icon-512.png", type: "image/png", custom: "icon-512.png" },
  "/manifest.webmanifest": { file: null, type: "application/manifest+json", custom: null },
  "/sw.js": { file: null, type: "text/javascript; charset=utf-8", custom: null },
} as const satisfies Record<string, { file: string | null; type: string; custom: AppIconFile | null }>;
type IconPath = keyof typeof ICONS;
/**
 * M-3882: the Hub's own icon set, so an installed AgEnD Hub and an installed AgEnD dashboard can be told apart (the same
 * Ag mark, inverted onto the navy tile, with a three-node badge). The Hub's listener serves these at the same paths;
 * a fleet's custom app icon (#2308) is the fleet's own and never applies to the Hub. The maskable pair is the Hub's only.
 */
export type IconFlavor = "fleet" | "hub";
const HUB_ICONS: Record<string, { file: string | null; type: string }> = {
  "/favicon.svg": { file: "hub-favicon.svg", type: "image/svg+xml" },
  "/favicon.ico": { file: "hub-favicon.ico", type: "image/vnd.microsoft.icon" },
  "/apple-touch-icon.png": { file: "hub-apple-touch-icon.png", type: "image/png" },
  "/icon-192.png": { file: "hub-icon-192.png", type: "image/png" },
  "/icon-512.png": { file: "hub-icon-512.png", type: "image/png" },
  "/icon-maskable-192.png": { file: "hub-icon-maskable-192.png", type: "image/png" },
  "/icon-maskable-512.png": { file: "hub-icon-maskable-512.png", type: "image/png" },
  "/manifest.webmanifest": { file: null, type: "application/manifest+json" },
  "/sw.js": { file: null, type: "text/javascript; charset=utf-8" },
};
/** The Hub's icons are bundled and fixed: their version names the set, so a browser that cached the dashboard's refetches. */
const HUB_ICON_VERSION = "hub-1";
const bodies = new Map<string, Buffer>();

/** The fleet's app icon store (set once the fleet knows its state dir); none: the bundled icons only. */
let store: Pick<AppIconStore, "current" | "file"> | null = null;
export function useAppIconStore(s: Pick<AppIconStore, "current" | "file"> | null): void {
  store = s;
}

/** What icon URLs carry, so a browser fetches a new icon when it changes: the custom icon's version, else "default". */
export function appIconVersion(): string {
  try { return store?.current()?.version ?? "default"; } catch { return "default"; }
}

/**
 * S-255: the service worker that makes the page an app (installed window, and later closed-tab notifications). It has
 * no fetch handler and opens no cache: nothing the dashboard or the Hub serves — API answers, chat, files — is ever
 * stored or answered by it, so signing out, a revoked session or a changed page behave exactly as without it.
 */
export const SERVICE_WORKER = [
  "// AgEnD: no fetch handler and no cache. The pages and every API call go to the server as before.",
  "self.addEventListener(\"install\", () => { self.skipWaiting(); });",
  "self.addEventListener(\"activate\", (event) => { event.waitUntil(self.clients.claim()); });",
  "",
].join("\n");

/** The page colour a browser paints around the app (tokens.css --bg, dark and light). */
const THEME = { dark: "#212121" };

/** The web app manifest: the fixed name, `/`, standalone, and the 192/512 icons of the version in force. */
export function appManifest(flavor: IconFlavor = "fleet"): string {
  if (flavor === "hub") {
    const v = HUB_ICON_VERSION;
    return JSON.stringify({
      id: "/",
      name: "AgEnD Hub",
      short_name: "AgEnD Hub",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: THEME.dark,
      theme_color: THEME.dark,
      icons: [
        { src: `/icon-192.png?v=${v}`, sizes: "192x192", type: "image/png", purpose: "any" },
        { src: `/icon-512.png?v=${v}`, sizes: "512x512", type: "image/png", purpose: "any" },
        { src: `/icon-maskable-192.png?v=${v}`, sizes: "192x192", type: "image/png", purpose: "maskable" },
        { src: `/icon-maskable-512.png?v=${v}`, sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    });
  }
  const v = encodeURIComponent(appIconVersion());
  return JSON.stringify({
    id: "/",
    name: "AgEnD",
    short_name: "AgEnD",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: THEME.dark,
    theme_color: THEME.dark,
    icons: [
      { src: `/icon-192.png?v=${v}`, sizes: "192x192", type: "image/png" },
      { src: `/icon-512.png?v=${v}`, sizes: "512x512", type: "image/png" },
    ],
  });
}

/**
 * The page's icon links, between its `<!--app-icon-->` markers: versioned, the SVG dropped when a custom icon is set
 * (browsers prefer an SVG and would keep the bundled logo), plus the manifest and the theme colour.
 */
export function withAppIconLinks(html: string, flavor: IconFlavor = "fleet"): string {
  const version = flavor === "hub" ? HUB_ICON_VERSION : appIconVersion();
  const v = encodeURIComponent(version);
  const custom = flavor === "fleet" && version !== "default";
  const links = [
    custom ? `<link rel="icon" href="/favicon.ico?v=${v}" sizes="32x32 48x48">` : `<link rel="icon" href="/favicon.ico?v=${v}" sizes="16x16 32x32 64x64">`,
    ...(custom ? [] : [`<link rel="icon" href="/favicon.svg?v=${v}" type="image/svg+xml" sizes="any">`]),
    `<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${v}" sizes="180x180">`,
    `<link rel="manifest" href="/manifest.webmanifest?v=${v}">`,
    `<meta name="theme-color" content="${THEME.dark}">`,
  ].join("\n");
  return html.replace(/<!--app-icon-->[\s\S]*?<!--\/app-icon-->\n?/, `${links}\n`);
}

export function isWebIconPath(path: string): path is IconPath {
  return Object.hasOwn(ICONS, path);
}

function bundled(file: string): Buffer {
  let body = bodies.get(file);
  if (!body) {
    // Each small shipped file is read once, rather than on every automatic browser request.
    body = readFileSync(new URL(`./ui/icons/${file}`, import.meta.url));
    bodies.set(file, body);
  }
  return body;
}

/** Called after Host admission, before session authentication. GET/HEAD need no credential. */
export function handleWebIconRequest(req: IncomingMessage, res: ServerResponse, path: string, flavor: IconFlavor = "fleet"): boolean {
  if (flavor === "hub") return handleHubIconRequest(req, res, path);
  if (!isWebIconPath(path)) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return true;
  }
  const icon = ICONS[path];
  const asked = new URL(req.url ?? "/", "http://localhost").searchParams.get("v");
  const version = appIconVersion();
  // The version in force, asked for by name, never changes: cached for good. Anything else is checked each time.
  const cache = path !== "/sw.js" && asked !== null && asked === version ? "public, max-age=31536000, immutable" : "no-cache";
  try {
    let body: Buffer | null = null;
    if (icon.file === null) body = Buffer.from(path === "/sw.js" ? SERVICE_WORKER : appManifest());
    else if (icon.custom && version !== "default") body = store?.file(icon.custom, version) ?? null;
    body ??= icon.file === null ? null : bundled(icon.file);
    if (!body) throw new Error("no icon");
    res.writeHead(200, { "Content-Type": icon.type, "Content-Length": String(body.length), "Cache-Control": cache });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404);
    res.end();
  }
  return true;
}

/** M-3882: the Hub listener's icons, manifest and worker: bundled only, versioned by HUB_ICON_VERSION. */
function handleHubIconRequest(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  if (!Object.hasOwn(HUB_ICONS, path)) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return true;
  }
  const icon = HUB_ICONS[path]!;
  const asked = new URL(req.url ?? "/", "http://localhost").searchParams.get("v");
  const cache = path !== "/sw.js" && asked === HUB_ICON_VERSION ? "public, max-age=31536000, immutable" : "no-cache";
  try {
    const body = icon.file === null ? Buffer.from(path === "/sw.js" ? SERVICE_WORKER : appManifest("hub")) : bundled(icon.file);
    res.writeHead(200, { "Content-Type": icon.type, "Content-Length": String(body.length), "Cache-Control": cache });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404);
    res.end();
  }
  return true;
}
