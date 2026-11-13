/**
 * AgEnD Hub P1, slice 3: Hub web sessions (hub.md §1 "Web entry", §5 "S1/S3").
 *
 * - Sign-in goes through S2's directory (`signIn`), never through a fleet session, bearer token or member credential.
 * - The cookie is `__Host-agend_hub_<hubId>` (Secure, HttpOnly, Path=/, no Domain, SameSite=Strict). Only that one name
 *   is ever looked at; a fleet's cookies (`agend_session`, `__Host-agend_session`, …) are never read or parsed, and the
 *   fleet never reads this one.
 * - Mutations need the page's own origin (`Origin` = the configured webOrigin) and a CSRF token derived from the
 *   session token, which only a same-origin read of /hub/v1/session can learn.
 * - Every check is fresh: the session row and the server's switch on each call, the directory's eligibility on
 *   `requirePerson`/`requireAdmin` (hub.md §5: no eligibility allow-cache). An ineligible person's sessions end.
 * - Local-host repair sign-in is reserved. Administrative authority always needs a current directory session:
 *   the configured root by default, or the composed hub.admin proof.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { HubProtocolError } from "./validation.js";
import { personKeyString } from "./identity.js";
import type { HubActor, HubRequestContext, PersonKey } from "./types.js";
import { recentHubDirectoryAuthentication, prepareHubDirectorySessionRotation, completeHubDirectorySessionRotation, type HubDirectorySessionRotation } from "./session-directory-transition.js";
import type { HubDirectoryDecisionRequest } from "./settings-directory-decision.js";
import type { HubCore } from "./http/core.js";
import type { HubManagementPermit } from "./roles/authority.js";

/** Absolute and idle lifetimes of a Hub session. */
export const HUB_SESSION_TTL = 8 * 60 * 60_000;
export const HUB_SESSION_IDLE = 60 * 60_000;
/** Sign-in attempts: per login label in a window, and in flight in all. */
const SIGNIN_WINDOW = 5 * 60_000, SIGNIN_PER_LOGIN = 5, SIGNIN_INFLIGHT = 8;
const LOGIN_MAX = 256, PASSWORD_MAX = 1024;

const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export const hubCookieName = (hubId: string) => `__Host-agend_hub_${hubId}`;
/** The CSRF token of a session: derived from its token, so it is never stored and only the session's holder can know it. */
export const hubCsrfOf = (token: string) => digest(`agend-hub-csrf\u0000${token}`);

/**
 * This Hub's session token from a Cookie header — only the exact `__Host-agend_hub_<hubId>` name, only 64 lowercase hex.
 * Every other cookie (a fleet's included) is skipped by name without its value being used.
 */
export function readHubCookie(header: string | string[] | undefined, hubId: string): string | null {
  const name = hubCookieName(hubId);
  const text = Array.isArray(header) ? header.join("; ") : header;
  if (typeof text !== "string" || text.length > 8192) return null;
  let found: string | null = null;
  for (const part of text.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    if (found !== null) return null;                    // two values for our name: neither is trusted
    found = part.slice(eq + 1).trim();
  }
  return found !== null && /^[a-f0-9]{64}$/.test(found) ? found : null;
}
export function hubSetCookie(hubId: string, token: string, maxAgeMs: number): string {
  return `${hubCookieName(hubId)}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`;
}
export function hubClearCookie(hubId: string): string {
  return `${hubCookieName(hubId)}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

interface SessionRow { id: string; person: string; realm: string; object_id: string; display_name: string; login_label: string; created_at: number; seen_at: number; expires_at: number; state: string; directory_epoch: number }
export interface HubSessionView { sessionId: string; person: PersonKey; displayName: string; login: string; admin: boolean; csrf: string }

export class HubSessions {
  private readonly failures = new Map<string, { since: number; count: number }>();
  private signingIn = 0;
  constructor(private readonly core: HubCore) {}
  private get hubId() { return this.core.deps.config.hubId; }
  /** Configured-root identity only (claim witness and legacy presentation), never a role permission. */
  isAdmin(person: PersonKey): boolean { return personKeyString(person) === personKeyString(this.core.deps.config.administrator); }
  private roleSessionMode(): boolean {
    const classify = this.core.deps.roleSessionMode;
    if (!classify) return true; // Older injected authority owns its own classification.
    const roles = classify();
    if (typeof roles !== "boolean") throw new HubProtocolError("unavailable");
    return roles;
  }

  /** Directory sign-in → a new session. Errors are generic to the browser ("denied"), bounded to the audit. */
  async signIn(login: unknown, password: unknown): Promise<{ token: string; view: HubSessionView; maxAgeMs: number }> {
    this.core.atomic(() => undefined); // refuse an old mount before sending credentials to its directory
    if (typeof login !== "string" || typeof password !== "string" || !login.trim() || !password
      || login.length > LOGIN_MAX || password.length > PASSWORD_MAX) throw new HubProtocolError("invalid");
    const label = login.trim();
    const key = digest(label.toLowerCase()), now = this.core.now();
    const f = this.failures.get(key);
    if (f && now - f.since < SIGNIN_WINDOW && f.count >= SIGNIN_PER_LOGIN) throw new HubProtocolError("backpressure");
    if (this.signingIn >= SIGNIN_INFLIGHT) throw new HubProtocolError("backpressure");
    this.signingIn++;
    let result;
    try { result = await this.core.directoryLogin(label, () => this.core.deps.directory.signIn(label, password)); } finally { this.signingIn--; }
    this.core.atomic(() => undefined); // held old-directory results cannot mint a new-epoch session
    if (!result.ok) {
      if (result.reason === "unavailable") throw new HubProtocolError("unavailable");
      const cur = this.failures.get(key);
      if (!cur || now - cur.since >= SIGNIN_WINDOW) this.failures.set(key, { since: now, count: 1 }); else cur.count++;
      if (this.failures.size > 4096) for (const [k, v] of this.failures) if (now - v.since >= SIGNIN_WINDOW) this.failures.delete(k);
      throw new HubProtocolError("denied");
    }
    this.failures.delete(key);
    const person = result.person.key, id = personKeyString(person);
    const token = randomBytes(32).toString("hex"), sessionId = randomUUID();
    const displayName = (result.person.displayName || result.person.login || label).slice(0, 256);
    this.core.atomic((db, tx) => {
      // A person row is created only by successful directory sign-in. Its first insertion is the durable claim
      // witness; checking it in this same transaction keeps concurrent sign-ins from claiming/auditing twice.
      const firstAdmin = this.isAdmin(person) && !db.prepare("SELECT 1 FROM hub_people WHERE person=?").get(id);
      db.prepare(`INSERT INTO hub_people(person, realm, object_id, display_name, login_label, status, last_checked_at) VALUES(?,?,?,?,?,'active',?)
        ON CONFLICT(person) DO UPDATE SET display_name=excluded.display_name, login_label=excluded.login_label, status='active', last_checked_at=excluded.last_checked_at`)
        .run(id, person.realm, person.objectId, displayName, result.person.login.slice(0, LOGIN_MAX), now);
      db.prepare("INSERT INTO hub_sessions(token_hash, id, person, created_at, seen_at, expires_at, state, directory_epoch) VALUES(?,?,?,?,?,?,'active',?)")
        .run(digest(token), sessionId, id, now, now, now + HUB_SESSION_TTL, this.core.directoryEpoch);
      db.prepare("INSERT INTO hub_session_authentication VALUES(?,?,?)").run(sessionId, this.core.directoryEpoch, now);
      this.core.audit(tx, { requestId: randomUUID(), actor: { kind: "person", person }, action: "session.signed-in", result: "completed" });
      if (firstAdmin) this.core.audit(tx, { requestId: randomUUID(), actor: { kind: "person", person }, action: "administrator.claimed", result: "completed" });
    });
    return { token, maxAgeMs: HUB_SESSION_TTL,
      view: { sessionId, person, displayName, login: result.person.login, admin: this.isAdmin(person), csrf: hubCsrfOf(token) } };
  }

  /** Internal server adapters only; never mounted as token/ref lookup routes. */
  recentAuthentication(actor: Extract<HubDirectoryDecisionRequest["actor"], { kind: "hub-administrator" }>): number | null {
    return recentHubDirectoryAuthentication(this.core, actor);
  }
  prepareDirectoryRotation(token: string, actor: Extract<HubDirectoryDecisionRequest["actor"], { kind: "hub-administrator" }>): HubDirectorySessionRotation {
    return prepareHubDirectorySessionRotation(this.core, token, actor);
  }
  completeDirectoryRotation(rotation: HubDirectorySessionRotation, operationId: string) {
    return completeHubDirectorySessionRotation(this.core, rotation, operationId);
  }

  /** The current session of this token, or null (ended, expired, idle, or the server fenced). Refreshes "seen". */
  session(token: string | null): (HubSessionView & { token: string }) | null {
    if (!token || !this.core.live()) return null;
    const now = this.core.now();
    try { return this.core.atomic((db) => {
      const row = db.prepare(`SELECT s.id, s.person, s.created_at, s.seen_at, s.expires_at, s.state, s.directory_epoch, p.realm, p.object_id, p.display_name, p.login_label
        FROM hub_sessions s JOIN hub_people p ON p.person = s.person WHERE s.token_hash = ?`).get(digest(token)) as SessionRow | undefined;
      if (!row || row.state !== "active" || row.directory_epoch !== this.core.directoryEpoch) return null;
      if (row.expires_at <= now || now - row.seen_at > HUB_SESSION_IDLE) {
        db.prepare("UPDATE hub_sessions SET state='ended' WHERE id=?").run(row.id);
        return null;
      }
      if (now - row.seen_at > 60_000) db.prepare("UPDATE hub_sessions SET seen_at=? WHERE id=?").run(now, row.id);
      const person = { realm: row.realm, objectId: row.object_id };
      return { token, sessionId: row.id, person, displayName: row.display_name, login: row.login_label, admin: this.isAdmin(person), csrf: hubCsrfOf(token) };
    }); } catch (error) {
      // An old mounted handler/context is no longer an authenticated session. Corrupt authority remains 503.
      if (error instanceof HubProtocolError && error.code === "unavailable") return null;
      throw error;
    }
  }

  /** Presentation only. The retained positive proof is checked again immediately before disclosure. */
  async presentation(token: string | null) {
    const selected = this.session(token);
    if (!selected) return null;
    const management = this.core.deps.management;
    const classify = this.core.deps.roleSessionMode;
    let admin = selected.admin, permit: Pick<HubManagementPermit, "assertCurrent"> | undefined;
    // The immutable root's existing repair presentation does not depend on a healthy policy binding.
    // This flag never replaces the clock/current proof required by a management operation.
    if (management && !this.isAdmin(selected.person) && this.roleSessionMode()) {
      try { permit = await this.core.management(this.contextOf(token), "hub.admin"); admin = true; }
      catch (error) {
        if (!this.session(token)) throw new HubProtocolError("revoked");
        if (!(error instanceof HubProtocolError) || error.code !== "denied") throw error;
        admin = false;
      }
    }
    let retired = false;
    const assertCurrent = () => {
      try {
        const current = this.session(token);
        if (retired || !current || current.sessionId !== selected.sessionId || personKeyString(current.person) !== personKeyString(selected.person)) throw new HubProtocolError("revoked");
        if (this.core.deps.management !== management) throw new HubProtocolError("unavailable");
        if (this.core.deps.roleSessionMode !== classify) throw new HubProtocolError("unavailable");
        permit?.assertCurrent();
      } catch (error) { retired = true; throw error; }
    };
    assertCurrent();
    const { token: _token, ...view } = selected;
    return { view: { ...view, admin }, assertCurrent };
  }

  signOut(token: string | null): void {
    if (!token) return;
    this.core.atomic((db, tx) => {
      const row = db.prepare("SELECT s.id, p.realm, p.object_id FROM hub_sessions s JOIN hub_people p ON p.person = s.person WHERE s.token_hash=? AND s.state='active'")
        .get(digest(token)) as { id: string; realm: string; object_id: string } | undefined;
      if (!row) return;
      db.prepare("UPDATE hub_sessions SET state='ended' WHERE id=?").run(row.id);
      this.core.audit(tx, { requestId: randomUUID(), actor: { kind: "person", person: { realm: row.realm, objectId: row.object_id } }, action: "session.signed-out", result: "completed" });
    });
  }

  /** Same origin and the session's CSRF token: what every mutation needs (constant-time compare). */
  sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin !== this.core.deps.config.webOrigin) return false;
    const site = req.headers["sec-fetch-site"];
    return site === undefined || site === "same-origin";
  }
  csrfOk(req: IncomingMessage, token: string): boolean {
    const sent = req.headers["x-agend-hub-csrf"];
    if (typeof sent !== "string" || !/^[a-f0-9]{64}$/.test(sent)) return false;
    return timingSafeEqual(Buffer.from(sent, "hex"), Buffer.from(hubCsrfOf(token), "hex"));
  }

  /**
   * The request context of hub.md §5 for this request's cookie. `current()` authenticates again (session row, switch);
   * `requirePerson()` adds a fresh directory check. A composed authority proves hub.admin; absent, the root-only rule remains.
   */
  context(req: IncomingMessage): HubRequestContext & { token: string | null } {
    return this.contextOf(readHubCookie(req.headers.cookie, this.hubId));
  }
  /** Only actual session tokens are accepted; no actor or administrative flag is supplied by a caller. */
  private contextOf(token: string | null): HubRequestContext & { token: string | null } {
    const requestId = randomUUID();
    const current = async (): Promise<HubActor> => {
      const s = this.session(token);
      if (!s) throw new HubProtocolError("revoked");
      return { kind: "directory", person: s.person, sessionId: s.sessionId };
    };
    const requirePerson = async (): Promise<PersonKey> => {
      const actor = await current();
      if (actor.kind !== "directory") throw new HubProtocolError("denied");
      if (!(await this.core.eligible(actor.person))) throw new HubProtocolError("revoked");
      await current();                                     // the session may have ended while the directory answered
      return actor.person;
    };
    const requireAdmin = async (): Promise<HubActor> => {
      const selected = await current();
      const classify = this.core.deps.roleSessionMode;
      // Preserve the configured root's existing fresh-directory repair boundary. Every role-aware
      // operation must still consume its own named management permit, including for this root.
      if (selected.kind === "directory" && !this.isAdmin(selected.person) && this.core.deps.management && this.roleSessionMode()) {
        try {
          const permit = await this.core.management(context, "hub.admin");
          if (this.core.deps.roleSessionMode !== classify || !this.roleSessionMode()) throw new HubProtocolError("unavailable");
          permit.assertCurrent();
          return permit.actor;
        }
        catch (error) { await current(); throw error; }
      }
      const person = await requirePerson();
      if (!this.isAdmin(person)) throw new HubProtocolError("denied");
      return current();
    };
    const isCurrent = () => this.session(token) !== null;
    const isIdentityCurrent = (person: PersonKey, sessionId: string) => {
      const s = this.session(token);
      return s !== null && s.sessionId === sessionId && personKeyString(s.person) === personKeyString(person);
    };
    const context = { requestId, token, current, isCurrent, isIdentityCurrent, requirePerson, requireAdmin };
    return context;
  }
}
