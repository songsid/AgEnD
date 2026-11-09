/** First Hub setup is the host's own D3 cookie session HERE, not generic Settings/admin authority. No Hub I/O on import. */
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { WebSessionStore } from "../web-session.js";
import { tokenEpoch } from "../web-session.js";
import { authorizeSession, isSecureRequest } from "../web-auth.js";
import { hostSessionHere } from "./web-authority.js";
import { isHostAllowed, allowedHostNames, type HostGuardConfig } from "../web-host-guard.js";
import type { HubInitHostOwner } from "../hub/init/types.js";
export function hubInitializationSession(req: IncomingMessage, input: {
  token: string | null;
  sessions: WebSessionStore | null;
  config: HostGuardConfig | null;
  epoch: number;
  current(record: object): boolean;
}): (HubInitHostOwner & {
  fleetOrigin: string;
}) | null {
  const { token, sessions } = input;
  if (!token || !sessions || !Number.isSafeInteger(input.epoch) || input.epoch < 0
    || req.headers["x-agend-token"] !== undefined || req.headers.authorization !== undefined
    || !isHostAllowed(req.headers.host, allowedHostNames(input.config)))
    return null;
  const auth = authorizeSession(req, token, sessions, { touch: false });
  if (auth.kind !== "ok" || !hostSessionHere(auth.session, req))
    return null;
  const record = auth.session;
  const fleetOrigin = `${isSecureRequest(req) ? "https" : "http"}://${req.headers.host}`;
  if (!["GET", "HEAD"].includes(req.method ?? "GET") && req.headers.origin !== fleetOrigin)
    return null;
  const current = () => {
    const latest = authorizeSession(req, token, sessions, { touch: false });
    return latest.kind === "ok" && latest.session === record && hostSessionHere(record, req)
      && input.current(record) === true && sessions.isCurrent(record, tokenEpoch(token)) && hostSessionHere(record, req);
  };
  if (!current())
    return null;
  return Object.freeze({ kind: "host-session", ownerKey: record, sessionId: record.idHash,
    authorityEpoch: input.epoch, requestId: randomUUID(), fleetOrigin, current });
}
