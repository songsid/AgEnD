/**
 * AGEND-122 (upstream #3486, R1): who may confirm a held Settings change by pressing Apply now — a role, asked of the
 * live session on each request, not a proof given once per browser. A signed-in human fleet admin on a web cookie
 * session confirms from wherever the dashboard is reached (this computer, a LAN or tailnet name, a link). What it does
 * NOT do, and what stays as it was:
 *   - an agent never confirms its own request: this decision is only asked of a browser's cookie session (a header token,
 *     the CLI and an agent's environment are not one: `agend settings confirm` still refuses an agent's environment);
 *   - a guest, a read-only session, a header token and a paired Windows computer never confirm;
 *   - the owner's own knobs still hold: the web authorization switch, "Only this computer can authorize"
 *     (`loopback_only`), and the named / quick link options for a session that arrived over that link.
 * It replaces the per-change proof the earlier rule asked for (#2170: the account's one DM confirmation of this browser
 * for a chat fleet; #2910: the host operator's own session on this computer for a web-only one). It is not
 * `evaluateWebAuthority` (#1939), which still decides what a human *message* from the web carries to an agent.
 */
import type { SessionRecord } from "../web-session.js";
import { HOST_OPERATOR, type WebAuthorityPolicy, type WebPeer } from "./web-authority.js";

/** Why a session has no say over a held change — the first check that failed. */
export type SettingsRoleRefusal =
  | "not_session"         // a header token, the CLI, an agent's request, or no cookie session
  | "not_admin_session"   // a guest or read-only session
  | "token_rotated"       // the session's token epoch is not the current one
  | "disabled"            // web.verified_authority.enabled is off: no web session confirms anything
  | "loopback_only"       // "Only this computer can authorize" is on and this request is not on this computer
  | "public_link"         // a request that is neither a direct connection nor one of the two links
  | "link_off"            // over the named / quick link while that link's option is off
  | "outside_sign_in"     // a web-only fleet's session over the link, but not the owner signed in from outside (#3008)
  | "no_account"          // a chat fleet's admin session with no chat account that is not the host's own
  | "not_admin";          // the chat account is no longer an admin of its connection

export interface SettingsRoleInput {
  /** The cookie session this request authenticated with; null for a header token, the CLI, or none. */
  session: SessionRecord | null;
  /** Over the public gateway (the link itself), known only from the gateway's own binding — never a header. */
  gateway: boolean;
  peer: WebPeer;
  /** sha256 of the current web token (web-session.ts tokenEpoch); null when there is none. */
  tokenEpoch: string | null;
  /** This fleet has no chat connection: every admin session is the fleet's own admin (there is no account to prove). */
  webOnly: boolean;
  /** The web authority policy as in force (authority-state.ts): the switch, "Only this computer…", the link options. */
  policy: Pick<WebAuthorityPolicy, "enabled" | "loopbackOnly" | "namedLink" | "quickLink">;
  /** adminGate(userId, adapterId) === "ok": in that connection's admin list, now. */
  isAdmin: (userId: string, adapterId: string) => boolean;
  /** #3008: the link a web-only fleet's connections from outside opened, while it is open. */
  outside: { exposureId: string } | null;
}

export type SettingsRole =
  | {
    ok: true;
    /** The confirmer as the audit trail names it: the chat account, or the host operator (HOST_OPERATOR). */
    actor: { adapter_id: string; user_id: string };
    /** A chat account (its adapter's admin list decides), not the host operator. */
    account: boolean;
    /** On this computer's own browser: a direct connection from a loopback peer (classifyWebPeer), never over a link. */
    onHost: boolean;
    /** Over a link, as the owner signed in from outside with the authenticator's code (#3008). */
    outsideSession: boolean;
  }
  | { ok: false; reason: SettingsRoleRefusal };

const no = (reason: SettingsRoleRefusal): SettingsRole => ({ ok: false, reason });

/** The checks, in order, for one request. All passing is a role that may press Apply now (or, when the owner asks for it, enter the code). */
export function evaluateSettingsRole(i: SettingsRoleInput): SettingsRole {
  const s = i.session;
  if (!s) return no("not_session");
  if (s.tier !== "admin") return no("not_admin_session");
  if (!i.tokenEpoch || s.tokenEpoch !== i.tokenEpoch) return no("token_rotated");
  if (s.surface !== (i.gateway ? "gateway" : "local")) return no("public_link");
  if (!i.policy.enabled) return no("disabled");
  const onHost = !i.gateway && i.peer === "loopback";
  if (i.policy.loopbackOnly && !onHost) return no("loopback_only");
  if (i.gateway ? i.peer !== "named_link" && i.peer !== "quick_link" : i.peer !== "loopback" && i.peer !== "lan") return no("public_link");
  let actor: { adapter_id: string; user_id: string }, account = false;
  if (s.owner) {
    if (!i.isAdmin(s.owner.userId, s.owner.adapterId)) return no("not_admin");
    actor = { adapter_id: s.owner.adapterId, user_id: s.owner.userId }; account = true;
  } else if (i.webOnly || s.host === true) {
    // A web-only fleet has no accounts: its admin sessions are the owner's (a sign-in code, the host's own `agend web`
    // session, a device the owner approved, or the owner from outside). On a chat fleet only the host's own session is.
    actor = { adapter_id: HOST_OPERATOR.adapterId, user_id: HOST_OPERATOR.userId };
  } else return no("no_account");
  let outsideSession = false;
  if (i.gateway) {
    if (i.webOnly && !s.owner) {
      // #3008: over the link only the owner who signed in from outside — its opt-in is the switch, not the link options.
      if (!(s.remote === "totp" && i.outside && s.exposureId === i.outside.exposureId)) return no("outside_sign_in");
      outsideSession = true;
    } else if (i.peer === "named_link" ? !i.policy.namedLink : !i.policy.quickLink) return no("link_off");
  }
  return { ok: true, actor, account, onHost, outsideSession };
}
