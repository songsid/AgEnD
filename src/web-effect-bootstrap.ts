import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildCanvasEffectShim } from "./web-effect-worker.js";
import { gatewayRequestContext } from "./web-request-context.js";

/** #2118: fixed trusted document; no uploaded source, account data or resource authorization lives here. */
export const EFFECT_BOOTSTRAP_PATH = "/effect-bootstrap";

export function effectBootstrapResponse(boot: string): { body: Buffer; headers: Readonly<Record<string, string>> } {
  if (!/^[0-9a-f]{32}$/.test(boot)) throw new Error("invalid effect bootstrap boot");
  // The URL's origin is the actual navigation origin, even though the sandboxed realm is opaque. Do not derive
  // the parent allowlist from Origin, forwarded headers, cookies, a preview listener or a request parameter.
  const html = buildCanvasEffectShim(boot, [], true), body = Buffer.from(html, "utf8");
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
  const hash = (value: string) => "'sha256-" + createHash("sha256").update(value).digest("base64") + "'";
  const csp = [
    "default-src 'none'", "script-src " + hash(script) + " blob:", "style-src " + hash(style),
    "worker-src blob:", "img-src data: blob:", "font-src 'none'", "media-src 'none'",
    "connect-src 'none'", "frame-src 'none'", "child-src 'none'", "object-src 'none'",
    "form-action 'none'", "base-uri 'none'", "manifest-src 'none'", "webrtc 'block'",
    "frame-ancestors 'self'", "sandbox allow-scripts",
  ].join("; ");
  return { body, headers: Object.freeze({
    "Content-Type": "text/html; charset=utf-8", "Content-Length": String(body.length),
    "Content-Security-Policy": csp, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), display-capture=(), fullscreen=()",
  }) };
}

/** Call only after the listener's Host/shutdown admission. No session lookup/touch or credential parsing. */
export function createEffectBootstrap(boot = randomBytes(16).toString("hex")): {
  readonly boot: string; handle(req: IncomingMessage, res: ServerResponse): boolean;
} {
  const response = effectBootstrapResponse(boot);
  return Object.freeze({ boot, handle(req: IncomingMessage, res: ServerResponse): boolean {
    const raw = req.url ?? "/";
    if (raw.split(/[?#]/, 1)[0] !== EFFECT_BOOTSTRAP_PATH) return false;
    const gateway = gatewayRequestContext(req);
    if (raw !== EFFECT_BOOTSTRAP_PATH || req.method !== "GET" || gateway && !gateway.isCurrent()) {
      res.writeHead(404, { "Content-Length": "0", "Cache-Control": "no-store" }); res.end(); return true;
    }
    // The ordinary shell must stay unframable; this document is instead confined by response CSP sandbox.
    res.removeHeader("X-Frame-Options");
    res.writeHead(200, response.headers); res.end(response.body); return true;
  } });
}
