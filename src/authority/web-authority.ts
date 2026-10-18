/**
 * #1939 S1 (observe only): whether a web chat message, command or click carries `web-session` authority — the design's
 * §3 checks, made per request — and the `authority` a human receipt records (§4). Nothing tells an agent to accept it
 * yet: receipts record it and delivery_status returns it, and the instructions still say web grants nothing (S3 changes
 * that). docs/design/1939-verified-web-sessions.md.
 */
import type { SessionRecord } from "../web-session.js";
import type { WebConfig } from "../types.js";
import { hostnameOf, LOOPBACK_HOST_NAMES } from "../web-host-guard.js";

/** Where one request came from (§3.4): `loopback` is this machine naming a loopback host; `lan` is only "not loopback". */
export type WebPeer = "loopback" | "lan";

/** The account behind a human receipt, written by AgEnD at admission — nothing in a message can set it (§4). */
export interface HumanAuthority {
  kind: "platform" | "web-session" | "none";
  /** The platform sender, or the web session's bound account. */
  actor: { adapter_id: string; user_id: string } | null;
  /** web-session only. `handle` is the opaque one the device list shows. */
  session?: { handle: string; peer: WebPeer; signed_in_at: string; age_s: number };
  /** The revocation epoch it was granted under (§10). S1 has no revocation yet: always 0. */
  authority_epoch: number;
}

/** Why a web request carries no authority — the first §3 check it failed. */
export type WebAuthorityRefusal =
  | "public_link"          // §3.5: a public-link request or session never qualifies
  | "not_session"          // §3.1: a header token, a CLI call, or no session
  | "not_admin_session"    // §3.1: a guest (or read) session
  | "token_rotated"        // §3.1: the session's token epoch is not the current one
  | "no_account"           // §3.2: an `agend web --code` session — the host operator, not an account
  | "not_admin"            // §3.3: no longer in its adapter's access.allowed_users
  | "other_namespace"      // §3.3: the target instance belongs to another adapter
  | "loopback_only"        // §3.4: "Only this computer can authorize" is on and this request is not loopback
  | "too_old"              // §3.6: signed in longer ago than max_session_hours
  | "session_changed";     // the session after the body is not the one the request arrived with

export interface WebAuthorityResult {
  authority: HumanAuthority;
  refusal: WebAuthorityRefusal | null;
}

/** §3.6: ordinary authority lasts at most this long after sign-in (web.verified_authority.max_session_hours). */
export const VERIFIED_SESSION_HOURS = { min: 1, max: 48, default: 48 } as const;

export interface WebAuthorityPolicy {
  loopbackOnly: boolean;
  maxSessionMs: number;
}

/** The policy in fleet.yaml; a value the validator refuses never loosens it (a bad number is the 48 h default, clamped). */
export function webAuthorityPolicy(web: WebConfig | undefined): WebAuthorityPolicy {
  const v = web?.verified_authority;
  const hours = typeof v?.max_session_hours === "number" && Number.isFinite(v.max_session_hours)
    ? Math.min(VERIFIED_SESSION_HOURS.max, Math.max(VERIFIED_SESSION_HOURS.min, v.max_session_hours)) : VERIFIED_SESSION_HOURS.default;
  return { loopbackOnly: v?.loopback_only === true, maxSessionMs: hours * 3_600_000 };
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
  /** The request came over the public link. */
  gateway: boolean;
  peer: WebPeer;
  /** sha256 of the current web token (web-session.ts tokenEpoch); null when there is none. */
  tokenEpoch: string | null;
  /** The adapter that owns the target instance. Absent on arrival, before the body names the instance. */
  target?: { adapterId: string | undefined };
  /** adminGate(userId, adapterId) === "ok": in that adapter's access.allowed_users, now. */
  isAdmin: (userId: string, adapterId: string) => boolean;
  policy: WebAuthorityPolicy;
  epoch: number;
  now: number;
}

export const noAuthority = (epoch: number): HumanAuthority => ({ kind: "none", actor: null, authority_epoch: epoch });

/** §3: every check, in order, for one request. The first that fails is the refusal; all passing is `web-session`. */
export function evaluateWebAuthority(i: WebAuthorityInput): WebAuthorityResult {
  const refuse = (refusal: WebAuthorityRefusal): WebAuthorityResult => ({ authority: noAuthority(i.epoch), refusal });
  const s = i.session;
  if (i.gateway) return refuse("public_link");
  if (!s) return refuse("not_session");
  if (s.tier !== "admin") return refuse("not_admin_session");
  if (s.surface !== "local") return refuse("public_link");
  if (!i.tokenEpoch || s.tokenEpoch !== i.tokenEpoch) return refuse("token_rotated");
  const owner = s.owner;
  if (!owner?.adapterId || !owner.userId) return refuse("no_account");
  if (!i.isAdmin(owner.userId, owner.adapterId)) return refuse("not_admin");
  if (i.target && i.target.adapterId !== owner.adapterId) return refuse("other_namespace");
  if (i.policy.loopbackOnly && i.peer !== "loopback") return refuse("loopback_only");
  const age = i.now - s.created;
  if (!(age <= i.policy.maxSessionMs)) return refuse("too_old");
  return {
    authority: {
      kind: "web-session", actor: { adapter_id: owner.adapterId, user_id: owner.userId },
      session: { handle: s.handle, peer: i.peer, signed_in_at: new Date(s.created).toISOString(), age_s: Math.max(0, Math.floor(age / 1000)) },
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
  const actor = a.actor as Record<string, unknown> | null;
  const actorOk = actor !== null && typeof actor === "object" && typeof actor.adapter_id === "string" && !!actor.adapter_id
    && typeof actor.user_id === "string" && !!actor.user_id;
  if (a.kind === "none") return a.actor === null && a.session === undefined;
  if (a.kind === "platform") return actorOk && a.session === undefined;
  if (a.kind !== "web-session" || !actorOk) return false;
  const s = a.session as Record<string, unknown> | undefined;
  return !!s && typeof s === "object" && typeof s.handle === "string" && !!s.handle && (s.peer === "loopback" || s.peer === "lan")
    && typeof s.signed_in_at === "string" && Number.isSafeInteger(s.age_s) && (s.age_s as number) >= 0;
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
  // Web traffic is never platform authority, and platform traffic never web-session (§4).
  const crossed = parsed.kind === "platform" ? origin.platform === "web" : parsed.kind === "web-session" && origin.platform !== "web";
  if (crossed) return noAuthority(parsed.authority_epoch);
  return parsed;
}
