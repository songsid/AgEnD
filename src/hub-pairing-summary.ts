/**
 * S3c PR B: the pairing projection's types and the confirmation summary — no I/O and no S1 import, so the fleet can
 * name a pairing step's summary without loading the Hub's pairing client (which loads only with hub_member on).
 */
export type HubPairingHold = "unknown_outcome" | "expired" | "unsaved" | "refused" | "revoked" | "disconnected";
export type HubPairingView =
  | { state: "unpaired" }
  | { state: "pending"; memberOrigin: string; fingerprint: { kind: "pairing"; digest: string }; expiresAt: number; ownerConfirmed: null; adminApproved: null; localConfirmed: boolean }
  | { state: "paired"; hub: { hubId: string; name: null; memberOrigin: string; webOrigin: string; fingerprint: { kind: "hub-key"; digest: string } }; link: "online" | "offline"; binding?: string }
  | { state: "held"; hold: HubPairingHold; memberOrigin?: string; hubId?: string; binding?: string };
export type HubConnectError = "address" | "code" | "busy" | "unreachable" | "refused";
export function httpsOrigin(address: string): string | null {
  try { const u = new URL(address.trim()); return u.protocol === "https:" && !u.username && !u.password && (u.pathname === "/" || u.pathname === "") && !u.search && !u.hash ? u.origin : null; } catch { return null; }
}

/** What the owner is asked to confirm for a pairing step (Settings confirmation's summary); a refused input throws. */
export function pairingSummary(action: "connect" | "confirm" | "disconnect", input: unknown, view: HubPairingView, bound: { hubId: string; binding: string | null } | null = null): { summary: string[] } {
  const body = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const refuse = (code: string) => { throw Object.assign(new Error(code), { code }); };
  const groups = (d: string) => d.toLowerCase().slice(0, 32).replace(/(.{4})(?=.)/g, "$1 ");
  if (action === "connect") {
    const origin = typeof body.address === "string" ? httpsOrigin(body.address) : null;
    if (!origin) refuse("address");
    if (view.state !== "unpaired") refuse("busy");
    return { summary: [`Connect this fleet to the Hub at ${origin}`, "It asks the Hub's owner and administrator to approve it"] };
  }
  if (action === "confirm") {
    if (view.state !== "pending" || body.digest !== view.fingerprint.digest) refuse("conflict");
    return { summary: [`Confirm the pairing fingerprint for ${(view as { memberOrigin: string }).memberOrigin}`, groups(String(body.digest))] };
  }
  if (view.state !== "paired" && !(view.state === "held" && view.hold !== "disconnected" && view.memberOrigin)) refuse("conflict");
  // #3115 r1 P2: the confirmation names the exact Hub (its id, in the body the owner confirms); apply rechecks it.
  if (!bound || body.hubId !== bound.hubId || !bound.binding || body.binding !== bound.binding) refuse("conflict");
  const origin = view.state === "paired" ? view.hub.memberOrigin : (view as { memberOrigin: string }).memberOrigin;
  return { summary: [`Disconnect this fleet from the Hub at ${origin} (${bound!.hubId}, pairing ${bound!.binding!.slice(0, 12)})`, "Every agent shared there is withdrawn; the Hub's administrator revokes the fleet there"] };
}
