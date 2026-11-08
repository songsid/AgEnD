/** Narrow cross-origin browser-open + cookie-free machine endpoints. Ordinary Hub session CSRF is unchanged. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { HubProtocolError, parseStrictJson, validated, hash, uuid } from "../validation.js";
import { CompanyJoinLimit, type HubCompanyJoin } from "./service.js";
const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" };
const status: Record<string, number> = { denied: 403, invalid: 400, stale: 409, conflict: 409, expired: 410, revoked: 403,
  "not-found": 404, backpressure: 429, incompatible: 400, unavailable: 503, uncertain: 503 };
export function companyFlowCookieName(hubId: string, requestId: string): string { return `__Host-agend_hub_join_${validated(uuid, hubId)}_${validated(uuid, requestId)}`; }
export function companyFlowCookie(req: IncomingMessage, hubId: string, requestId: string): string {
  const name = companyFlowCookieName(hubId, requestId), rows = String(req.headers.cookie ?? "").split(";").map(s => s.trim()).filter(s => s.startsWith(name + "="));
  if (rows.length !== 1) throw new HubProtocolError("denied");
  return validated(hash, rows[0]!.slice(name.length + 1));
}
export function sendCompanyJoinError(res: ServerResponse, error: unknown): void {
  if (res.writableEnded || res.headersSent) return;
  const code = error instanceof CompanyJoinLimit ? "limit-reached" : error instanceof HubProtocolError ? error.code : "unavailable";
  res.writeHead(error instanceof CompanyJoinLimit ? 429 : status[code] ?? 503, headers); res.end(JSON.stringify({ code }));
}
async function bytes(req: IncomingMessage, contentType: string, maximum = 24 * 1024): Promise<string> {
  if (String(req.headers["content-type"] ?? "").split(";")[0]!.toLowerCase() !== contentType || req.headers["content-encoding"] !== undefined)
    throw new HubProtocolError("invalid");
  const declared = req.headers["content-length"];
  if (typeof declared !== "string" || !/^\d{1,6}$/.test(declared) || Number(declared) > maximum || req.headers["transfer-encoding"] !== undefined)
    throw new HubProtocolError("invalid");
  const chunks: Buffer[] = []; let total = 0;
  for await (const part of req) {
    total += part.length; if (total > maximum) { req.destroy(); throw new HubProtocolError("invalid"); }
    chunks.push(Buffer.from(part));
  }
  if (total !== Number(declared)) throw new HubProtocolError("invalid");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw new HubProtocolError("invalid"); }
}
/** Returns false for protected browser/admin routes; they stay inside createHubHttp's ordinary Origin/CSRF gate. */
export function handleCompanyJoin(req: IncomingMessage, res: ServerResponse, service: HubCompanyJoin, surface: "browser" | "machine" = "browser"): boolean {
  const path = req.url ?? "", machine = /^\/hub\/v1\/join\/(challenge|push|status|redeem|ack|cancel|tombstone)$/.exec(path);
  if (surface === "machine" ? !machine : path !== "/hub/join/open" && path !== "/hub/v1/join/metadata") return false;
  const send = (body: unknown) => { if (!res.writableEnded) { res.writeHead(200, headers); res.end(JSON.stringify(body)); } };
  void (async () => {
    if (path === "/hub/v1/join/metadata") {
      if (req.method !== "GET") throw new HubProtocolError("invalid");
      return send(service.metadata());
    }
    if (req.method !== "POST") throw new HubProtocolError("invalid");
    if (path === "/hub/join/open") {
      let origins = 0;
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]!.toLowerCase() === "origin") origins++;
      if (origins !== 1 || typeof req.headers.origin !== "string" || !req.headers.origin || req.headers.origin === "null") throw new HubProtocolError("denied");
      const form = new URLSearchParams(await bytes(req, "application/x-www-form-urlencoded", 2048));
      const pairs = [...form];
      if (pairs.length !== 2 || form.getAll("requestId").length !== 1 || form.getAll("state").length !== 1) throw new HubProtocolError("invalid");
      const requestId = validated(uuid, form.get("requestId"));
      const cookie = service.browserOpen(requestId, validated(hash, form.get("state")), req.headers.origin);
      const id = service.metadata().hub.hubId;
      res.writeHead(303, { ...headers, Location: `/ui/hub/join?request=${requestId}`, "Set-Cookie": `${companyFlowCookieName(id, requestId)}=${cookie}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=600` });
      res.end(); return;
    }
    // Do not turn a cookie-bearing browser request into a backchannel key holder.
    if (req.headers.cookie !== undefined || req.headers.origin !== undefined || req.headers.authorization !== undefined)
      throw new HubProtocolError("denied");
    const body = parseStrictJson(await bytes(req, "application/json"), 24 * 1024);
    if (machine![1] === "challenge") {
      const b = validated(z.strictObject({ binding: z.unknown(), purpose: z.unknown() }), body);
      return send(service.challenge(b.binding, b.purpose));
    }
    const b = validated(z.strictObject({ binding: z.unknown(), proof: z.unknown(), payload: z.unknown() }), body);
    switch (machine![1]) {
      case "push": return send(service.push(b.binding, b.payload, b.proof));
      case "status": return send(service.status(b.binding, b.proof, b.payload));
      case "tombstone": return send(service.status(b.binding, b.proof, b.payload, "tombstone"));
      case "cancel": return send(service.cancel(b.binding, b.proof, b.payload));
      case "redeem": return send(await service.redeem(b.binding, b.proof, b.payload));
      case "ack": return send(await service.acknowledge(b.binding, b.proof, b.payload));
    }
  })().catch(error => sendCompanyJoinError(res, error));
  return true;
}
