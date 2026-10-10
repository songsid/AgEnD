import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Bundled, inert branding only. Never resolve a request path into a filesystem path. */
const ICONS = {
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
  "/favicon.ico": { file: "favicon.ico", type: "image/vnd.microsoft.icon" },
  "/apple-touch-icon.png": { file: "apple-touch-icon.png", type: "image/png" },
} as const;
type IconPath = keyof typeof ICONS;
const bodies = new Map<IconPath, Buffer>();

export function isWebIconPath(path: string): path is IconPath {
  return Object.hasOwn(ICONS, path);
}

/** Called after Host admission, before session authentication. GET/HEAD need no credential. */
export function handleWebIconRequest(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  if (!isWebIconPath(path)) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return true;
  }
  const icon = ICONS[path];
  try {
    // Each small shipped file is read once, rather than on every automatic browser request.
    let body = bodies.get(path);
    if (!body) {
      body = readFileSync(new URL(`./ui/icons/${icon.file}`, import.meta.url));
      bodies.set(path, body);
    }
    res.writeHead(200, { "Content-Type": icon.type, "Content-Length": String(body.length) });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404);
    res.end();
  }
  return true;
}
