/** Host-only transport address input. Normal users keep the browser Hub address and choose Reconnect. */
import { z } from "zod";
import { listenProblems, originProblems } from "./init/initializer.js";
import { hubPreviewSettings } from "./preview.js";
export class HubMemberAddressError extends Error {
  constructor(readonly code: "invalid" | "port_conflict" | "port_in_use" | "certificate" | "unavailable" | "stale" | "denied" | "busy" | "joining" | "expired" | "unchanged" | "recovery", readonly retryAt?: number) { super(code); this.name = "HubMemberAddressError"; }
}
const listener = z.strictObject({ host: z.string().min(1).max(253), port: z.number().int().min(1).max(65535) });
const candidate = z.strictObject({ origin: z.string().min(1).max(2048), listen: listener });
export type HubMemberAddressCandidate = z.infer<typeof candidate>;
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const hubMemberAddressBoundary = (raw: unknown) => { const h = object(raw); return { memberOrigin: h.memberOrigin, memberListen: h.memberListen, memberAddress: h.memberAddress }; };
export function parseHubMemberAddressCandidate(raw: unknown, currentHub: unknown): HubMemberAddressCandidate {
  const p = candidate.safeParse(raw), hub = object(currentHub), web = listener.safeParse(hub.webListen);
  if (!p.success || !web.success || typeof hub.webOrigin !== "string") throw new HubMemberAddressError("invalid");
  if (originProblems("memberOrigin", p.data.origin).length || listenProblems("memberListen", p.data.listen).length || new URL(p.data.origin).hostname.endsWith(".")) throw new HubMemberAddressError("invalid");
  p.data.origin = new URL(p.data.origin).origin;
  if (p.data.origin === new URL(hub.webOrigin).origin || p.data.listen.port === web.data.port) throw new HubMemberAddressError("port_conflict");
  try { hubPreviewSettings({ web: hub.web, webOrigin: hub.webOrigin, memberOrigin: p.data.origin, webListen: web.data, memberListen: p.data.listen }); }
  catch { throw new HubMemberAddressError("port_conflict"); }
  return p.data;
}
