/** Optional authority-free preview origin: HTML arrives only through the fleet shim's postMessage. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { previewFrameResponse } from "../web-preview.js";
import { HubStateError } from "./db.js";

export interface HubPreviewSettings { host: string; port: number; origin: string }
export interface HubPreviewView {
  dashboardOrigin: string; previewOrigin: string | null; bootId: string | null;
  reasonCode?: "notOffered"; reason?: string;
}
const record = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;

/** Local setting, outside the sealed initialization digest, but included in runtime reload admission. */
export function hubPreviewReloadKey(web: unknown): string {
  if (web === undefined) return "off";
  const value = record(web);
  if (!value) return JSON.stringify(["invalid", web]);
  return Object.prototype.hasOwnProperty.call(value, "preview_port") ? JSON.stringify(["port", value.preview_port]) : "off";
}

export function hubPreviewSettings(input: {
  web?: unknown; webOrigin: string; memberOrigin: string;
  webListen: { host: string; port: number }; memberListen: { host: string; port: number };
}): HubPreviewSettings | null {
  const bad = (detail: string): never => { throw new HubStateError("hub-unsealed", `hub.web.preview_port ${detail}`); };
  if (input.web === undefined) return null;
  const web = record(input.web);
  if (!web) return bad("requires hub.web to be an object");
  if (!Object.prototype.hasOwnProperty.call(web, "preview_port")) return null;
  const port = web.preview_port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return bad("must be an integer from 1 to 65535 (omit it to disable previews)");
  let origin: URL;
  try { origin = new URL(input.webOrigin); } catch { return bad("requires a bare HTTPS Hub web origin"); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") return bad("requires a bare HTTPS Hub web origin");
  const dashboardOrigin = origin.origin;
  origin.port = String(port);
  if (origin.origin === dashboardOrigin || origin.origin === new URL(input.memberOrigin).origin
    || port === input.webListen.port || port === input.memberListen.port) return bad("must differ from the Hub web and member listeners and origins");
  return { host: input.webListen.host, port, origin: origin.origin };
}

export function hubPreviewView(webOrigin: string, settings: HubPreviewSettings | null, bootId: string): Readonly<HubPreviewView> {
  const dashboardOrigin = new URL(webOrigin).origin;
  const view: HubPreviewView = settings ? { dashboardOrigin, previewOrigin: settings.origin, bootId }
    : { dashboardOrigin, previewOrigin: null, bootId: null, reasonCode: "notOffered", reason: "HTML previews are not configured on this Hub." };
  return Object.freeze(view);
}

/** No session, file, token, Cookie, Origin or Referer is read. Exact Host + GET /frame is the entire surface. */
export function createHubPreviewHandler(settings: HubPreviewSettings, webOrigin: string, bootId: string, current: () => boolean) {
  const response = previewFrameResponse(bootId, [new URL(webOrigin).origin], { cdn: false });
  const host = new URL(settings.origin).host;
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (!current()) { res.writeHead(503, { "Cache-Control": "no-store" }).end(); return; }
    if (req.method !== "GET" || req.url !== "/frame" || typeof req.headers.host !== "string" || req.headers.host.toLowerCase() !== host) {
      res.writeHead(404, { "Cache-Control": "no-store" }).end(); return;
    }
    res.writeHead(200, response.headers); res.end(response.body);
  };
}
