/**
 * #1939: whether a web chat message, command or click carries `web-verified` authority — the design's §3 checks, made
 * per request, on a session its account has authorized once (§0) — the `authority` a human receipt records (§4), and how
 * delivery_status reads it now (§10: the switch, the revocation epoch, "Only this computer can authorize"). Agents take it
 * as a go-ahead as WEB_RECEIPT_RULE (src/instructions.ts) says.
 * docs/design/1939-verified-web-sessions.md.
 */
import type { SessionRecord } from "../web-session.js";
import type { WebConfig } from "../types.js";
import { hostnameOf, LOOPBACK_HOST_NAMES } from "../web-host-guard.js";
import type { SessionAuthorization } from "./session-authorizations.js";

/**
 * Where one request came from (§3.4): `loopback` is this machine naming a loopback host; `lan` is only "not loopback".
 * §0.2 (#2453): `named_link` is the admin's own named tunnel, known only from the public gateway's provenance (its exact
 * configured hostname) — never from the TCP peer (cloudflared is local) or a header. §0.3: `quick_link` is every other
 * request over the public gateway (the temporary quick-tunnel link), likewise from provenance only.
 */
export type WebPeer = "loopback" | "lan" | "named_link" | "quick_link";

/** The account behind a human receipt, written by AgEnD at admission — nothing in a message can set it (§4). */
export interface HumanAuthority {
  kind: "platform" | "web-verified" | "none";
  /** The platform sender, or the web session's bound account. */
  actor: { adapter_id: string; user_id: string } | null;
  /** web-verified only. `handle` is the opaque one the device list shows; `authorized_at`: when its account authorized it. */
  session?: { handle: string; peer: WebPeer; signed_in_at: string; authorized_at: string };
  /** The revocation epoch it was granted under (§10; authority-state.ts). */
  authority_epoch: number;
  /** delivery_status only, never stored: why a web-verified receipt reads as none now (§10). */
  downgraded?: AuthorityDowngrade;
}

/** §10: what turned a web-verified receipt into none after it was written. */
export type AuthorityDowngrade = "disabled" | "revoked" | "loopback_only" | "named_link_off" | "quick_link_off";

/** Why a web request carries no authority — the first §3 check it failed. */
export type WebAuthorityRefusal =
  | "disabled"             // §10: the server switch (web.verified_authority.enabled) is off
  | "public_link"          // §3.5: a quick-tunnel request or session never qualifies
  | "named_link_off"       // §0.2: over the admin's named link, while web.verified_authority.named_link is off
  | "quick_link_off"       // §0.3: over the temporary public link, while web.verified_authority.quick_link is off
  | "not_session"          // §3.1: a header token, a CLI call, or no session
  | "not_admin_session"    // §3.1: a guest (or read) session
  | "token_rotated"        // §3.1: the session's token epoch is not the current one
  | "no_account"           // §3.2: an `agend web --code` session — the host operator, not an account
  | "not_admin"            // §3.3: no longer in its adapter's access.allowed_users
  | "other_namespace"      // §3.3: the target instance belongs to another adapter
  | "loopback_only"        // §3.4: "Only this computer can authorize" is on and this request is not loopback
  | "not_authorized"       // §0: its account has not authorized this session (or not under the current epoch)
  | "authorization_expired" // §0: authorized longer ago than max_session_hours
  | "session_changed";     // the session after the body is not the one the request arrived with

export interface WebAuthorityResult {
  authority: HumanAuthority;
  refusal: WebAuthorityRefusal | null;
}

/** §0: a session's authorization lasts at most this long after it was given (web.verified_authority.max_session_hours). */
export const VERIFIED_SESSION_HOURS = { min: 1, max: 48, default: 48 } as const;

export interface WebAuthorityPolicy {
  /** The server switch as in force (authority-state.ts: off while its state cannot be written). */
  enabled: boolean;
  loopbackOnly: boolean;
  /** §0.2: sessions over the admin's own named tunnel may qualify (web.verified_authority.named_link; off by default). */
  namedLink: boolean;
  /** §0.3: sessions over the temporary public link may qualify (web.verified_authority.quick_link; quickLinkEffective). */
  quickLink: boolean;
  maxSessionMs: number;
}

/** The policy in fleet.yaml; a value the validator refuses never loosens it (a bad number is the 48 h default, clamped). */
export function webAuthorityPolicy(web: WebConfig | undefined): WebAuthorityPolicy {
  const v = web?.verified_authority;
  const hours = typeof v?.max_session_hours === "number" && Number.isFinite(v.max_session_hours)
    ? Math.min(VERIFIED_SESSION_HOURS.max, Math.max(VERIFIED_SESSION_HOURS.min, v.max_session_hours)) : VERIFIED_SESSION_HOURS.default;
  // §0.1: the switch is on unless fleet.yaml says false (nothing carries authority until its account confirms anyway).
  return { enabled: v?.enabled !== false, loopbackOnly: v?.loopback_only === true, namedLink: v?.named_link === true,
    quickLink: quickLinkEffective(v), maxSessionMs: hours * 3_600_000 };
}

/** §0.3: the release default of `web.verified_authority.quick_link` — off (the user's decision, 2026-10-23). */
export const QUICK_LINK_DEFAULT = false;
/**
 * §0.3: the quick-link option as in force — its explicit value, else the release default. Every widening is judged on
 * this (settings-change.ts, settings-effect.ts), never on the raw key: a key removed to inherit is a change of value too.
 */
export function quickLinkEffective(v: { quick_link?: unknown } | undefined | null, fallback: boolean = QUICK_LINK_DEFAULT): boolean {
  return typeof v?.quick_link === "boolean" ? v.quick_link : fallback;
}

/** Headers a proxy adds; any one of them makes a request `lan`, whatever its peer address (§3.4). */
const FORWARDING_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "cf-connecting-ip", "via"] as const;

function loopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  return address === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * §3.4, from this request alone: `loopback` only when its TCP peer is a loopback address, its Host names a loopback host,
 * and it carries no forwarding header. It does not prove who sits at the machine (a local proxy that strips forwarding
 * headers looks the same — out of scope). The caller has already ruled out the public link, whose tunnel is local too.
 */
export function classifyWebPeer(req: { socket?: { remoteAddress?: string | undefined } | null; headers: NodeJS.Dict<string | string[]> }): WebPeer {
  if (!loopbackAddress(req.socket?.remoteAddress)) return "lan";
  const host = req.headers.host;
  const name = typeof host === "string" ? hostnameOf(host) : null;
  if (!name || !LOOPBACK_HOST_NAMES.includes(name)) return "lan";
  return FORWARDING_HEADERS.some(h => req.headers[h] !== undefined) ? "lan" : "loopback";
}

export interface WebAuthorityInput {
  /** The cookie session this request authenticated with; null for a header token, a CLI call, or none. */
  session: SessionRecord | null;
  /** The request came over the public link (its peer `named_link` when it is the admin's named tunnel, §0.2). */
  gateway: boolean;
  peer: WebPeer;
  /** sha256 of the current web token (web-session.ts tokenEpoch); null when there is none. */
  tokenEpoch: string | null;
  /** The adapter that owns the target instance. Absent on arrival, before the body names the instance. */
  target?: { adapterId: string | undefined };
  /** adminGate(userId, adapterId) === "ok": in that adapter's access.allowed_users, now. */
  isAdmin: (userId: string, adapterId: string) => boolean;
  /** §0: this session's authorization (session-authorizations.ts), or null when its account has not given one. */
  authorization: SessionAuthorization | null;
  policy: WebAuthorityPolicy;
  epoch: number;
  now: number;
}

export const noAuthority = (epoch: number): HumanAuthority => ({ kind: "none", actor: null, authority_epoch: epoch });

/** §3: every check, in order, for one request. The first that fails is the refusal; all passing is `web-verified`. */
export function evaluateWebAuthority(i: WebAuthorityInput): WebAuthorityResult {
  const refuse = (refusal: WebAuthorityRefusal): WebAuthorityResult => ({ authority: noAuthority(i.epoch), refusal });
  const s = i.session;
  if (!i.policy.enabled) return refuse("disabled");
  // §3.5 / §0.2: the public link never qualifies — except the admin's own named tunnel (provenance, exact hostname)
  // while the option is on and "Only this computer can authorize" is off. A peer that says named off the gateway is not.
  // §0.3: the temporary public link (a gateway request that is not named) likewise, by its own option.
  if (i.gateway) {
    if (i.peer !== "named_link" && i.peer !== "quick_link") return refuse("public_link");
    if (i.policy.loopbackOnly) return refuse("loopback_only");
    if (i.peer === "named_link" ? !i.policy.namedLink : !i.policy.quickLink) return refuse(i.peer === "named_link" ? "named_link_off" : "quick_link_off");
  } else if (i.peer === "named_link" || i.peer === "quick_link") return refuse("public_link");
  if (!s) return refuse("not_session");
  if (s.tier !== "admin") return refuse("not_admin_session");
  if (s.surface !== (i.gateway ? "gateway" : "local")) return refuse("public_link");
  if (!i.tokenEpoch || s.tokenEpoch !== i.tokenEpoch) return refuse("token_rotated");
  const owner = s.owner;
  if (!owner?.adapterId || !owner.userId) return refuse("no_account");
  if (!i.isAdmin(owner.userId, owner.adapterId)) return refuse("not_admin");
  if (i.target && i.target.adapterId !== owner.adapterId) return refuse("other_namespace");
  if (i.policy.loopbackOnly && i.peer !== "loopback") return refuse("loopback_only");
  // §0: authorized once, by this account, for this session, under the current epoch, and not longer ago than allowed.
  const a = i.authorization;
  if (!a || a.handle !== s.handle || a.owner.adapterId !== owner.adapterId || a.owner.userId !== owner.userId || a.epoch !== i.epoch) return refuse("not_authorized");
  // §0.1: the end it was given with, or sooner if the hours were lowered since — never later.
  if (!(i.now <= Math.min(a.until, a.authorizedAt + i.policy.maxSessionMs))) return refuse("authorization_expired");
  return {
    authority: {
      kind: "web-verified", actor: { adapter_id: owner.adapterId, user_id: owner.userId },
      session: { handle: s.handle, peer: i.peer, signed_in_at: new Date(s.created).toISOString(), authorized_at: new Date(a.authorizedAt).toISOString() },
      authority_epoch: i.epoch,
    },
    refusal: null,
  };
}

/**
 * §3: the request qualified when it arrived AND again now that its body is in, under the same session. A request that
 * failed on arrival keeps that refusal; one whose session changed meanwhile carries nothing.
 */
export function confirmAfterBody(arrival: WebAuthorityResult, now: WebAuthorityResult): WebAuthorityResult {
  if (arrival.refusal) return { authority: noAuthority(now.authority.authority_epoch), refusal: arrival.refusal };
  if (now.refusal) return now;
  if (now.authority.session?.handle !== arrival.authority.session?.handle) return { authority: noAuthority(now.authority.authority_epoch), refusal: "session_changed" };
  return now;
}

/**
 * §10: a receipt's authority as it reads NOW. A web-verified one reads as none, saying why, while the switch is off, once
 * the epoch has moved past the one it was granted under, (every peer but loopback) while "Only this computer can
 * authorize" is on, or (named_link, §0.2; quick_link, §0.3) while that link's option is off.
 * Platform and none are unchanged. The receiver applies the rule to this, never to the stored value.
 */
export function authorityNow(stored: HumanAuthority, state: { enabled: boolean; loopbackOnly: boolean; namedLink: boolean; quickLink: boolean; epoch: number }): HumanAuthority {
  if (stored.kind !== "web-verified") return stored;
  const down = (downgraded: AuthorityDowngrade): HumanAuthority => ({ kind: "none", actor: null, authority_epoch: stored.authority_epoch, downgraded });
  if (!state.enabled) return down("disabled");
  if (stored.authority_epoch < state.epoch) return down("revoked");
  if (state.loopbackOnly && stored.session?.peer !== "loopback") return down("loopback_only");
  // §0.2: the named-link option off — every receipt from a session over it reads as none at once.
  if (!state.namedLink && stored.session?.peer === "named_link") return down("named_link_off");
  // §0.3: the quick-link option off — likewise for every receipt from a session over the temporary public link.
  if (!state.quickLink && stored.session?.peer === "quick_link") return down("quick_link_off");
  return stored;
}

/** A Discord or Telegram message or click: its sender, from the platform's own event. */
export function platformAuthority(origin: { platform: string; adapter_id: string | null; user_id: string | null }, epoch: number): HumanAuthority {
  return origin.platform !== "web" && origin.adapter_id && origin.user_id
    ? { kind: "platform", actor: { adapter_id: origin.adapter_id, user_id: origin.user_id }, authority_epoch: epoch }
    : noAuthority(epoch);
}

/** Exactly the shape this module writes; anything else is not authority. */
export function isHumanAuthority(v: unknown): v is HumanAuthority {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  if (!Number.isSafeInteger(a.authority_epoch) || (a.authority_epoch as number) < 0) return false;
  if (a.downgraded !== undefined) return false;                  // a read-now view, never a stored value
  const actor = a.actor as Record<string, unknown> | null;
  const actorOk = actor !== null && typeof actor === "object" && typeof actor.adapter_id === "string" && !!actor.adapter_id
    && typeof actor.user_id === "string" && !!actor.user_id;
  if (a.kind === "none") return a.actor === null && a.session === undefined;
  if (a.kind === "platform") return actorOk && a.session === undefined;
  // S1's observe-only "web-session" is not authority any more (§0: never an authorization): it fails here, so reads none.
  if (a.kind !== "web-verified" || !actorOk) return false;
  const s = a.session as Record<string, unknown> | undefined;
  return !!s && typeof s === "object" && typeof s.handle === "string" && !!s.handle && (s.peer === "loopback" || s.peer === "lan" || s.peer === "named_link" || s.peer === "quick_link")
    && typeof s.signed_in_at === "string" && typeof s.authorized_at === "string";
}

/**
 * What a stored receipt says (§4). A row written before #1939 has none: from Discord or Telegram it is `platform`, from
 * the web `none` — so nothing accepted before changes meaning. A stored value that is not authority is `none`.
 */
export function receiptAuthority(origin: { platform: string; adapter_id: string | null; user_id: string | null }, stored: string | null): HumanAuthority {
  if (stored === null) return platformAuthority(origin, 0);
  let parsed: unknown;
  try { parsed = JSON.parse(stored); } catch { return noAuthority(0); }
  if (!isHumanAuthority(parsed)) return noAuthority(0);
  // Web traffic is never platform authority, and platform traffic never web-verified (§4).
  const crossed = parsed.kind === "platform" ? origin.platform === "web" : parsed.kind === "web-verified" && origin.platform !== "web";
  if (crossed) return noAuthority(parsed.authority_epoch);
  return parsed;
}
