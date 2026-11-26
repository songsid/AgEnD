import type { IncomingMessage, ServerResponse } from "node:http";
import type { ContactPerson, ContactOriginClear, ContactPermissions, ContactPermissionsWrite, ContactTicket, ContactTicketDecision, ContactTicketPage } from "./contact-auth-types.js";
import { ContactDecisionSchema, ContactOriginClearSchema, ContactPermissionsSchema } from "./contact-auth-policy.js";
import { readBoundedWebBody } from "./web-body.js";
import { UPDATE_TRIAL_REFUSAL, UPDATE_TRIAL_RETRY_SECONDS } from "./update-quiescence.js";
export interface ContactApiHost {
  contactActor(req: IncomingMessage, url: URL): ContactPerson | null;
  clearContactOrigin(name: string, input: ContactOriginClear, actor: ContactPerson): ContactPermissions;
  contactPermissions(name: string, actor: ContactPerson): ContactPermissions;
  writeContactPermissions(name: string, input: ContactPermissionsWrite, actor: ContactPerson): ContactPermissions;
  contactAuthorization(id: string, actor: ContactPerson): ContactTicket;
  contactAuthorizations(actor: ContactPerson, filter: { agent?: string; person?: string; status?: string; cursor?: string }): ContactTicketPage;
  decideContactAuthorization(id: string, input: ContactTicketDecision, actor: ContactPerson): ContactTicket;
}
function answer(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
export function handleContactAuthorizationApi(req: IncomingMessage, res: ServerResponse, url: URL, host: ContactApiHost): boolean {
  const permissions = /^\/ui\/api\/instances\/([^/]+)\/contact-permissions(\/origin-clear)?$/.exec(url.pathname);
  const ticket = /^\/ui\/api\/contact-authorizations(?:\/(R[a-f0-9-]{36})(\/decision)?)?$/.exec(url.pathname);
  if (!permissions && !ticket) return false;
  const method = req.method ?? "GET", actor = host.contactActor(req, url);
  // M-3680: no verified administrator behind this session (e.g. a browser not yet authorized over a link): say so, so the
  // page can point to Sign-in status rather than read as "not this agent's manager".
  if (!actor) { answer(res, 403, { error: "verification-required" }); return true; }
  void (async () => {
    try {
      const name = permissions ? decodeURIComponent(permissions[1]!) : "";
      if (method === "GET") {
        if (permissions?.[2]) { answer(res, 405, { error: "method-not-allowed" }); return; }
        if (permissions && !permissions[2]) answer(res, 200, host.contactPermissions(name, actor));
        else if (ticket?.[1] && !ticket[2]) answer(res, 200, host.contactAuthorization(ticket[1], actor));
        else if (!ticket?.[1]) {
          const filter = Object.fromEntries(url.searchParams);
          if (Object.keys(filter).some(key => !["agent", "person", "status", "cursor"].includes(key))
            || Object.values(filter).some(value => value.length > 512)) throw Error("invalid-request");
          answer(res, 200, host.contactAuthorizations(actor, filter));
        } else answer(res, 405, { error: "method-not-allowed" });
        return;
      }
      if (!(permissions && !permissions[2] && method === "PUT") && !(permissions?.[2] && method === "POST") && !(ticket?.[2] && method === "POST")) {
        answer(res, 405, { error: "method-not-allowed" }); return;
      }
      const bytes = await readBoundedWebBody(req, 48 * 1024);
      const current = host.contactActor(req, url);
      if (!current || current.platform !== actor.platform || current.adapterId !== actor.adapterId || current.userId !== actor.userId) throw Error("forbidden");
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw Error("invalid-request"); }
      if (permissions?.[2]) {
        const parsed = ContactOriginClearSchema.safeParse(value);
        if (!parsed.success) throw Error("invalid-request");
        answer(res, 200, host.clearContactOrigin(name, parsed.data, current));
      } else if (permissions) {
        const parsed = ContactPermissionsSchema.safeParse(value);
        if (!parsed.success) throw Error("invalid-request");
        answer(res, 200, host.writeContactPermissions(name, parsed.data, current));
      } else {
        const parsed = ContactDecisionSchema.safeParse(value);
        if (!parsed.success || !ticket?.[1]) throw Error("invalid-request");
        if (parsed.data.grant && Date.parse(parsed.data.grant.expiresAt) <= Date.now()) throw Error("invalid-request");
        answer(res, 200, host.decideContactAuthorization(ticket[1], parsed.data, current));
      }
    } catch (error) {
      // M-3770 part 3 (Fable): an update's trial refused the approval's delivery; the decision rolled back with it.
      if ((error as { code?: unknown } | null)?.code === UPDATE_TRIAL_REFUSAL) {
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Retry-After": String(UPDATE_TRIAL_RETRY_SECONDS) });
          res.end(JSON.stringify({ error: "updating" }));
        }
        return;
      }
      const code = error instanceof Error ? error.message : "unavailable";
      const status = code === "forbidden" ? 403 : code === "not-found" ? 404
        : ["conflict", "already-decided", "expired", "stale-generation", "operation-conflict"].includes(code) ? 409
        : ["invalid-request", "invalid-grant", "invalid-approver", "invalid-cursor", "invalid-decision", "invalid-grant-origin"].includes(code) ? 400 : 503;
      answer(res, status, { error: status === 503 ? "unavailable" : code });
    }
  })();
  return true;
}
