/**
 * #1939 S2b (design §0, §0.1): "Authorize this browser". A signed-in session asks; AgEnD posts a Confirm card in the DM of
 * the account the session was signed in as; **Confirm** there authorizes that session, **Not me** signs it out. The card
 * is the one gate that stops a stolen cookie speaking as the person, so it is guarded against confirm fatigue:
 * - it says exactly what it authorizes (this browser, its device label, this computer or the network, when, until when);
 * - one pending card per session, at most 3 asks an hour per account; a refusal is explained in the app;
 * - a card expires after 5 minutes (marked in place), and Confirm is judged at the tap (the session read again by its
 *   handle and §3 run again — FleetManager.authorizeWebSession);
 * - after Confirm the card stays as the notice, with Not me (sign the session out) for as long as the authorization lasts,
 *   and says so (no buttons) when it ends;
 * - when no DM can be sent, the adapter's General gets one line with no details.
 * Durations use a monotonic clock; what the card shows is wall-clock time.
 */
import { randomBytes } from "node:crypto";
import type { WebAuthorityRefusal, WebPeer } from "./authority/web-authority.js";

export const AUTHORIZATION_CARD_TTL_MS = 5 * 60_000;
export const AUTHORIZATION_ASKS_PER_HOUR = 3;
const HOUR_MS = 3_600_000;
export const AUTHORIZATION_CALLBACK_PREFIX = "wauth:";

export type AuthorizationAskRefusal = WebAuthorityRefusal | "pending" | "rate_limited" | "dm_unavailable";

export interface AuthorizationOwner { adapterId: string; userId: string }

interface Card {
  nonce: string;
  handle: string;
  owner: AuthorizationOwner;
  label: string;
  peer: WebPeer;
  /** Monotonic deadline for a pending card. */
  expiresAt: number;
  state: "pending" | "confirmed" | "denied" | "expired" | "refused" | "revoked" | "ended";
  /** Where the card is (to edit it in place). */
  where: { chatId: string; messageId: string } | null;
  timer?: ReturnType<typeof setTimeout>;
  /** Wall-clock end of the authorization, once confirmed. */
  until?: number;
}

export interface AuthorizationCardText {
  ask(c: { label: string; peer: WebPeer; askedAt: number; until: number }): string;
  confirmed(c: { label: string; peer: WebPeer; until: number }): string;
  denied(c: { label: string }): string;
  expired(c: { label: string }): string;
  refused(c: { label: string; refusal: string }): string;
  revoked(c: { label: string }): string;
  ended(c: { label: string }): string;
  generalHint(): string;
  confirmLabel(): string;
  notMeLabel(): string;
  notYours(): string;
}

export interface SessionAuthorizationDeps {
  /** Monotonic ms (performance.now). */
  now(): number;
  /** Wall-clock ms (Date.now): only what the card and the app show. */
  wallNow(): number;
  /** How long an authorization given now would last (max_session_hours). */
  maxSessionMs(): number;
  /** The account's DM, with buttons; null when no DM can be sent. */
  sendDirect(owner: AuthorizationOwner, text: string, choices: Array<{ id: string; label: string }>): Promise<{ chatId: string; messageId: string } | null>;
  /** One line with no details in the account's adapter's General (no DM could be sent). */
  sendGeneralHint(owner: AuthorizationOwner, text: string): Promise<void>;
  /** Edit the card in place: new text, these buttons (none: removed). */
  editCard(owner: AuthorizationOwner, where: { chatId: string; messageId: string }, text: string, choices: Array<{ id: string; label: string }>): Promise<void>;
  /** §3 at the tap, then record it (FleetManager.authorizeWebSession); the session read again by its handle. */
  authorize(handle: string, peer: WebPeer): { ok: true; until: number } | { ok: false; refusal: WebAuthorityRefusal | "session_gone" };
  /** Not me: sign this session out and end its authorization. */
  signOut(handle: string): void;
  event(type: string, payload: Record<string, unknown>): void;
  text: AuthorizationCardText;
  log: { warn(obj: object, msg?: string): void };
}

export class SessionAuthorizationRequests {
  private byNonce = new Map<string, Card>();
  /** One pending card per session. */
  private pendingByHandle = new Map<string, Card>();
  /** Monotonic times of each account's asks in the last hour. */
  private asks = new Map<string, number[]>();

  constructor(private readonly deps: SessionAuthorizationDeps) {}

  private choices(c: Card, confirm: boolean): Array<{ id: string; label: string }> {
    return [
      ...(confirm ? [{ id: `${AUTHORIZATION_CALLBACK_PREFIX}${c.nonce}:confirm`, label: this.deps.text.confirmLabel() }] : []),
      { id: `${AUTHORIZATION_CALLBACK_PREFIX}${c.nonce}:notme`, label: this.deps.text.notMeLabel() },
    ];
  }

  private recentAsks(key: string): number[] {
    const now = this.deps.now();
    const kept = (this.asks.get(key) ?? []).filter(t => now - t < HOUR_MS);
    if (kept.length) this.asks.set(key, kept); else this.asks.delete(key);
    return kept;
  }

  /**
   * This session's pending card. One past its deadline is expired now, whether or not its timer has run yet (a timer can
   * run late): the app never shows "waiting 0:00", and a new ask is not refused as "pending".
   */
  private livePending(handle: string): Card | null {
    const c = this.pendingByHandle.get(handle);
    if (!c || c.state !== "pending") return null;
    if (this.deps.now() >= c.expiresAt) { void this.expire(c); return null; }
    return c;
  }

  /** What the app shows for this session: a pending card (until when), or nothing pending. */
  pending(handle: string): { expiresInMs: number } | null {
    const c = this.livePending(handle);
    return c ? { expiresInMs: Math.max(0, c.expiresAt - this.deps.now()) } : null;
  }

  /**
   * The session asks (it qualifies under §3 — the caller checked, on this request). Refused while a card for it is
   * pending, after 3 asks this hour by the account, or when no DM can be sent (General then gets a line, no details).
   */
  async ask(input: { handle: string; owner: AuthorizationOwner; label: string; peer: WebPeer; sessionEnd: number }): Promise<{ ok: true; expiresInMs: number } | { ok: false; refusal: AuthorizationAskRefusal; retryAfterMs?: number }> {
    const existing = this.livePending(input.handle);
    if (existing) return { ok: false, refusal: "pending", retryAfterMs: Math.max(0, existing.expiresAt - this.deps.now()) };
    const key = `${input.owner.adapterId}:${input.owner.userId}`;
    const recent = this.recentAsks(key);
    if (recent.length >= AUTHORIZATION_ASKS_PER_HOUR) return { ok: false, refusal: "rate_limited", retryAfterMs: Math.max(0, recent[0]! + HOUR_MS - this.deps.now()) };
    recent.push(this.deps.now());
    this.asks.set(key, recent);
    const c: Card = { nonce: randomBytes(16).toString("hex"), handle: input.handle, owner: { ...input.owner }, label: input.label, peer: input.peer,
      expiresAt: this.deps.now() + AUTHORIZATION_CARD_TTL_MS, state: "pending", where: null };
    this.byNonce.set(c.nonce, c);
    this.pendingByHandle.set(c.handle, c);
    const wall = this.deps.wallNow();
    let where: { chatId: string; messageId: string } | null = null;
    try {
      // Until when it would last: the authorization's end, or the session's own when that comes first (as Confirm says).
      const until = Math.min(wall + this.deps.maxSessionMs(), input.sessionEnd);
      where = await this.deps.sendDirect(c.owner, this.deps.text.ask({ label: c.label, peer: c.peer, askedAt: wall, until }), this.choices(c, true));
    } catch (err) { this.deps.log.warn({ err: (err as Error)?.message }, "Web authorization card could not be sent"); }
    if (!where) {
      this.forget(c);
      try { await this.deps.sendGeneralHint(c.owner, this.deps.text.generalHint()); } catch { /* best effort: the app says why */ }
      this.deps.event("session_authorization_failed", { session: c.handle, actor: key, peer: c.peer, reason: "dm_unavailable" });
      return { ok: false, refusal: "dm_unavailable" };
    }
    c.where = where;
    c.timer = setTimeout(() => { void this.expire(c); }, AUTHORIZATION_CARD_TTL_MS);
    c.timer.unref?.();
    this.deps.event("session_authorization_issued", { challenge: c.nonce, session: c.handle, actor: key, peer: c.peer });
    return { ok: true, expiresInMs: AUTHORIZATION_CARD_TTL_MS };
  }

  private forget(c: Card): void {
    if (c.timer) clearTimeout(c.timer);
    if (this.pendingByHandle.get(c.handle) === c) this.pendingByHandle.delete(c.handle);
  }

  private async edit(c: Card, text: string, confirm: boolean | null): Promise<void> {
    if (!c.where) return;
    try { await this.deps.editCard(c.owner, c.where, text, confirm === null ? [] : this.choices(c, confirm)); }
    catch (err) { this.deps.log.warn({ err: (err as Error)?.message }, "Web authorization card could not be updated"); }
  }

  private async expire(c: Card): Promise<void> {
    if (c.state !== "pending") return;
    c.state = "expired";
    this.forget(c);
    this.byNonce.delete(c.nonce);
    this.deps.event("session_authorization_expired", { challenge: c.nonce, session: c.handle, actor: `${c.owner.adapterId}:${c.owner.userId}`, peer: c.peer });
    await this.edit(c, this.deps.text.expired({ label: c.label }), null);
  }

  /** A confirmed card at its authorization's end: forgotten, and edited to say so (no Not me left to press). */
  private async end(c: Card): Promise<void> {
    if (c.state !== "confirmed" || this.byNonce.get(c.nonce) !== c) return;
    c.state = "ended";
    this.byNonce.delete(c.nonce);
    await this.edit(c, this.deps.text.ended({ label: c.label }), null);
  }

  /** A tap on a card's button. Only the account it was sent to may tap it; anyone else is told it is not theirs. */
  async handleCallback(data: { callbackData: string; userId?: string; ack?: (notice?: string) => void }, adapterId: string): Promise<boolean> {
    if (!data.callbackData.startsWith(AUTHORIZATION_CALLBACK_PREFIX)) return false;
    const m = /^wauth:([0-9a-f]{32}):(confirm|notme)$/.exec(data.callbackData);
    const c = m ? this.byNonce.get(m[1]!) : undefined;
    if (!m || !c) { data.ack?.(); return true; }
    if (c.owner.adapterId !== adapterId || c.owner.userId !== String(data.userId ?? "")) { data.ack?.(this.deps.text.notYours()); return true; }
    const key = `${c.owner.adapterId}:${c.owner.userId}`;
    if (m[2] === "notme") {
      // Before or after Confirm: sign that session out (its authorization ends with it).
      const was = c.state;
      c.state = was === "confirmed" ? "revoked" : "denied";
      this.forget(c);
      this.byNonce.delete(c.nonce);
      this.deps.signOut(c.handle);
      this.deps.event("session_authorization_failed", { challenge: c.nonce, session: c.handle, actor: key, peer: c.peer, reason: was === "confirmed" ? "not_me_after_confirm" : "not_me" });
      data.ack?.();
      await this.edit(c, was === "confirmed" ? this.deps.text.revoked({ label: c.label }) : this.deps.text.denied({ label: c.label }), null);
      return true;
    }
    // Confirm: only a pending card, before it expires, judged now.
    if (c.state !== "pending" || this.deps.now() >= c.expiresAt) { data.ack?.(); if (c.state === "pending") await this.expire(c); return true; }
    this.forget(c);
    const r = this.deps.authorize(c.handle, c.peer);
    data.ack?.();
    if (!r.ok) {
      c.state = "refused";
      this.byNonce.delete(c.nonce);
      this.deps.event("session_authorization_failed", { challenge: c.nonce, session: c.handle, actor: key, peer: c.peer, reason: r.refusal });
      await this.edit(c, this.deps.text.refused({ label: c.label, refusal: r.refusal }), null);
      return true;
    }
    c.state = "confirmed";
    c.until = r.until;
    this.deps.event("session_authorization_verified", { challenge: c.nonce, session: c.handle, actor: key, peer: c.peer });
    // The card stays as the notice, with Not me, for as long as the authorization lasts; then it says it ended.
    await this.edit(c, this.deps.text.confirmed({ label: c.label, peer: c.peer, until: r.until }), false);
    const end = setTimeout(() => { void this.end(c); }, Math.max(0, Math.min(c.until - this.deps.wallNow(), 2 ** 31 - 1)));
    end.unref?.();
    return true;
  }
}
