import { settingsRequestExecution } from "./settings-request-capability.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { evaluateWebRequest } from "./web-auth.js";
import { gatewayRequestContext } from "./web-request-context.js";
import type { WebSessionStore } from "./web-session.js";
/** Recheck AFTER a body/authorization await and BEFORE admitting a new public mutation. */
export function permitWebContinuation(req: IncomingMessage, res: ServerResponse,
  ctx: { readonly webToken?: string | null; readonly webSessions?: WebSessionStore | null }): boolean {
  const execution = settingsRequestExecution(req);
  if (execution) { execution.assert(); return !res.destroyed; }
  if (!gatewayRequestContext(req)) return true;
  const verdict = evaluateWebRequest(req, new URL(req.url ?? "/", "http://localhost"), ctx.webToken ?? null, ctx.webSessions, { touch: false });
  if (verdict.kind === "allow" && !res.destroyed) return true;
  if (!res.headersSent && !res.destroyed) {
    res.writeHead(verdict.kind === "reject" ? verdict.status : 401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "public request no longer authorized" }));
  }
  return false;
}
