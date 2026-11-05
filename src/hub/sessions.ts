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
 * - Local-host repair sign-in is reserved: P1 refuses it (requireAdmin is the configured administrator's current
 *   directory identity).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { HubProtocolError } from "./validation.js";
import { personKeyString } from "./identity.js";
import type { HubActor, HubRequestContext, PersonKey } from "./types.js";
import type { HubCore } from "./http/core.js";

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

interface SessionRow { id: string; person: string; realm: string; object_id: string; display_name: string; login_label: string; created_at: number; seen_at: number; expires_at: number; state: string }
export interface HubSessionView { sessionId: string; person: PersonKey; displayName: string; login: string; admin: boolean; csrf: string }

export class HubSessions {
  private readonly failures = new Map<string, { since: number; count: number }>();
  private signingIn = 0;
  constructor(private readonly core: HubCore) {}
  private get hubId() { return this.core.deps.config.hubId; }
  isAdmin(person: PersonKey): boolean { return personKeyString(person) === personKeyString(this.core.deps.config.administrator); }

  /** Directory sign-in → a new session. Errors are generic to the browser ("denied"), bounded to the audit. */
  async signIn(login: unknown, password: unknown): Promise<{ token: string; view: HubSessionView; maxAgeMs: number }> {
    this.core.check();
    if (typeof login !== "string" || typeof password !== "string" || !login.trim() || !password
      || login.length > LOGIN_MAX || password.length > PASSWORD_MAX) throw new HubProtocolError("invalid");
    const label = login.trim();
    const key = digest(label.toLowerCase()), now = this.core.now();
    const f = this.failures.get(key);
    if (f && now - f.since < SIGNIN_WINDOW && f.count >= SIGNIN_PER_LOGIN) throw new HubProtocolError("backpressure");
    if (this.signingIn >= SIGNIN_INFLIGHT) throw new HubProtocolError("backpressure");
    this.signingIn++;
    let result;
    try { result = await this.core.deps.directory.signIn(label, password); } finally { this.signingIn--; }
    this.core.check();
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
      db.prepare(`INSERT INTO hub_people(person, realm, object_id, display_name, login_label, status, last_checked_at) VALUES(?,?,?,?,?,'active',?)
        ON CONFLICT(person) DO UPDATE SET display_name=excluded.display_name, login_label=excluded.login_label, status='active', last_checked_at=excluded.last_checked_at`)
        .run(id, person.realm, person.objectId, displayName, result.person.login.slice(0, LOGIN_MAX), now);
      db.prepare("INSERT INTO hub_sessions(token_hash, id, person, created_at, seen_at, expires_at, state) VALUES(?,?,?,?,?,?,'active')")
        .run(digest(token), sessionId, id, now, now, now + HUB_SESSION_TTL);
      this.core.audit(tx, { requestId: randomUUID(), actor: { kind: "person", person }, action: "session.signed-in", result: "completed" });
    });
    return { token, maxAgeMs: HUB_SESSION_TTL,
      view: { sessionId, person, displayName, login: result.person.login, admin: this.isAdmin(person), csrf: hubCsrfOf(token) } };
  }

  /** The current session of this token, or null (ended, expired, idle, or the server fenced). Refreshes "seen". */
  session(token: string | null): (HubSessionView & { token: string }) | null {
    if (!token || !this.core.live()) return null;
    const now = this.core.now();
    return this.core.atomic((db) => {
      const row = db.prepare(`SELECT s.id, s.person, s.created_at, s.seen_at, s.expires_at, s.state, p.realm, p.object_id, p.display_name, p.login_label
        FROM hub_sessions s JOIN hub_people p ON p.person = s.person WHERE s.token_hash = ?`).get(digest(token)) as SessionRow | undefined;
      if (!row || row.state !== "active") return null;
      if (row.expires_at <= now || now - row.seen_at > HUB_SESSION_IDLE) {
        db.prepare("UPDATE hub_sessions SET state='ended' WHERE id=?").run(row.id);
        return null;
      }
      if (now - row.seen_at > 60_000) db.prepare("UPDATE hub_sessions SET seen_at=? WHERE id=?").run(now, row.id);
      const person = { realm: row.realm, objectId: row.object_id };
      return { token, sessionId: row.id, person, displayName: row.display_name, login: row.login_label, admin: this.isAdmin(person), csrf: hubCsrfOf(token) };
    });
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
   * `requirePerson()` adds a fresh directory check; `requireAdmin()` is the configured administrator's identity, fresh.
   */
  context(req: IncomingMessage): HubRequestContext & { token: string | null } {
    const token = readHubCookie(req.headers.cookie, this.hubId);
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
      const person = await requirePerson();
      if (!this.isAdmin(person)) throw new HubProtocolError("denied");
      return current();
    };
    return { requestId, token, current, requirePerson, requireAdmin };
  }
}
