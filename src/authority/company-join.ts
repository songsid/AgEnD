/** Cookie-only local Fleet authority. Header tokens, AD identity and copied operation handles cannot mint this. */
import type { IncomingMessage } from "node:http";
import type { WebSessionStore } from "../web-session.js";
import { tokenEpoch } from "../web-session.js";
import { authorizeSession, isSecureRequest } from "../web-auth.js";
import { hostSessionHere } from "./web-authority.js";
import { gatewayRequestContext } from "../web-request-context.js";
import { isHostAllowed, allowedHostNames, type HostGuardConfig } from "../web-host-guard.js";
import type { JoinLocalSession } from "../hub/join/local-journal.js";
/** Canonical browser origin shared with the lazy Hub protocol, without importing a Hub runtime on an off Fleet. */
export function canonicalCompanyFleetOrigin(input: string): string {
  const u = new URL(input), loopback = ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname);
  if (u.origin !== input || u.username || u.password || u.pathname !== "/" || u.search || u.hash || u.hostname.endsWith(".")
    || !(u.protocol === "https:" || u.protocol === "http:" && loopback)) throw Error("Invalid Fleet browser origin");
  return u.origin;
}
export function companyJoinSession(req: IncomingMessage, input: { token: string | null; sessions: WebSessionStore | null;
  config: HostGuardConfig | null; epoch: number; current(record: object): boolean }): (JoinLocalSession & { fleetOrigin: string }) | null {
  if (!input.token || !input.sessions || gatewayRequestContext(req) || !isHostAllowed(req.headers.host, allowedHostNames(input.config))) return null;
  const auth = authorizeSession(req, input.token, input.sessions, { touch: false });
  if (auth.kind !== "ok" || auth.session.tier !== "admin" || auth.session.surface !== "local") return null;
  const record = auth.session;
  let fleetOrigin: string;
  try {
    // This Host already passed the configured listener allowlist and same-origin cookie/CSRF gate. Never use a forwarded Host or return_to.
    fleetOrigin = canonicalCompanyFleetOrigin(`${isSecureRequest(req) ? "https" : "http"}://${req.headers.host}`);
    if (req.method === "POST" && req.headers.origin !== fleetOrigin) return null;
  } catch { return null; }
  const current = () => input.sessions!.isCurrent(record, tokenEpoch(input.token!)) && input.current(record);
  if (!current()) return null;
  return Object.freeze({ ownerKey: record, sessionId: record.idHash, authorityEpoch: input.epoch,
    hostHere: hostSessionHere(record, req), fleetOrigin, current });
}
