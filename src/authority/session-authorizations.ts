/**
 * #1939 §0: which web sessions their account has authorized — once per session, by confirming on Discord or Telegram
 * (S2b's Confirm card or DM code). Kept beside the fleet in `web-authorizations.json` (0600, atomic) so a restart keeps
 * them, keyed by the session's opaque handle, each stamped with the account it was given by and the revocation epoch it
 * was given under (authority-state.ts): an epoch bump (`/web revoke`, the switch, loopback_only off) ends every one at
 * once. Losing this file only loses authorizations — a person authorizes again; it can never grant one.
 */
import { readFileSync, unlinkSync } from "node:fs";
import { atomicWriteFileSync } from "../atomic-write.js";
import type { WebPeer } from "./web-authority.js";

export interface SessionAuthorization {
  readonly handle: string;
  readonly owner: { readonly adapterId: string; readonly userId: string };
  /** Wall clock (ms): when its account confirmed it; compared with the session store's own wall clock. */
  readonly authorizedAt: number;
  /** §0.1: the end it was given with (authorizedAt + max_session_hours then): a longer setting later never stretches it. */
  readonly until: number;
  readonly epoch: number;
  /**
   * §0.3: where the session was when its account confirmed it — so a link's option turned off drops only that link's
   * authorizations. Absent on records written before §0.3 (then only a local session or a named-link one could be).
   */
  readonly peer?: WebPeer;
}
const PEERS: readonly string[] = ["loopback", "lan", "named_link", "quick_link"];

/** At most this many kept: one per signed-in session (the store's own caps are far lower). */
export const SESSION_AUTHORIZATIONS_MAX = 256;
const HANDLE = /^[0-9a-f]{16}$/;

export interface SessionAuthorizationsIo {
  read(path: string): string;
  write(path: string, data: string): void;
  /** Remove the file (the fallback when it cannot be rewritten); absent: it cannot be removed. */
  unlink?(path: string): void;
}
const fileIo: SessionAuthorizationsIo = { read: p => readFileSync(p, "utf8"), write: (p, d) => atomicWriteFileSync(p, d, { mode: 0o600 }), unlink: p => unlinkSync(p) };
/** A write owed to the disk is tried again by the next change, and by a read at most this often (ms, monotonic). */
export const SESSION_AUTHORIZATIONS_RETRY_MS = 5_000;

function valid(v: unknown): v is SessionAuthorization {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, any>;
  return typeof a.handle === "string" && HANDLE.test(a.handle) && !!a.owner && typeof a.owner.adapterId === "string" && !!a.owner.adapterId
    && typeof a.owner.userId === "string" && !!a.owner.userId && Number.isSafeInteger(a.authorizedAt) && a.authorizedAt > 0
    && Number.isSafeInteger(a.until) && a.until > a.authorizedAt && Number.isSafeInteger(a.epoch) && a.epoch >= 0
    && (a.peer === undefined || PEERS.includes(a.peer));
}

export class SessionAuthorizations {
  private byHandle: Map<string, SessionAuthorization> | null = null;
  private warned = false;
  /** The handles the file holds as far as this process knows (what a restart would read back). */
  private persisted = new Set<string>();
  /** A write is owed to the disk (the last one failed): retried by the next change, or a read after `retryAt`. */
  private dirty = false;
  private retryAt = 0;

  constructor(private readonly path: string, private readonly log: { warn(obj: object, msg?: string): void }, private readonly io: SessionAuthorizationsIo = fileIo,
    private readonly now: () => number = () => performance.now()) {}

  private load(): Map<string, SessionAuthorization> {
    if (this.byHandle) return this.byHandle;
    this.byHandle = new Map();
    let raw: string;
    try { raw = this.io.read(this.path); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.log.warn({ path: this.path }, "Web session authorizations unreadable; none are kept");
      return this.byHandle;
    }
    try {
      const v = JSON.parse(raw) as { v?: unknown; authorizations?: unknown };
      if (v.v === 1 && Array.isArray(v.authorizations)) for (const a of v.authorizations.slice(0, SESSION_AUTHORIZATIONS_MAX)) {
        if (valid(a)) this.persisted.add(a.handle);
        if (valid(a)) this.byHandle.set(a.handle, Object.freeze({ handle: a.handle, owner: Object.freeze({ adapterId: a.owner.adapterId, userId: a.owner.userId }), authorizedAt: a.authorizedAt, until: a.until, epoch: a.epoch, ...(a.peer ? { peer: a.peer } : {}) }));
      }
    } catch { this.log.warn({ path: this.path }, "Web session authorizations unreadable; none are kept"); }
    return this.byHandle;
  }

  /**
   * Persist. `written`: the file now holds what memory holds. `safe`: no authorization memory has dropped can come back
   * on a restart. A failed write leaves the store owing the disk one (retried by the next change, and a read every
   * SESSION_AUTHORIZATIONS_RETRY_MS) — never the old file quietly standing: when it still holds one memory has dropped,
   * it is removed (a restart then only asks again: losing authorizations never grants one); `safe` is false only when
   * even that is impossible (as WebSessionStore does for sessions).
   */
  private flush(): { written: boolean; safe: boolean } {
    const map = this.load();
    try {
      this.io.write(this.path, JSON.stringify({ v: 1, authorizations: [...map.values()] }) + "\n");
      this.persisted = new Set(map.keys());
      this.dirty = false;
      this.warned = false;
      return { written: true, safe: true };
    } catch (err) {
      this.dirty = true;
      this.retryAt = this.now() + SESSION_AUTHORIZATIONS_RETRY_MS;
      const message = (err as Error).message;
      if (![...this.persisted].some(h => !map.has(h))) {
        // The file is only behind (nothing on it that memory dropped): a restart only forgets the newest.
        if (!this.warned) this.log.warn({ err: message, path: this.path }, "Web session authorizations could not be saved (will retry); a restart forgets the newest");
        this.warned = true;
        return { written: false, safe: true };
      }
      try {
        if (!this.io.unlink) throw new Error("cannot remove");
        this.io.unlink(this.path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          this.log.warn({ err: message, path: this.path }, "Web session authorizations could not be saved and the old file could not be removed: a restart may bring back an authorization that ended. Fix the permissions on web-authorizations.json");
          return { written: false, safe: false };
        }
      }
      this.persisted = new Set();
      this.log.warn({ err: message, path: this.path }, "Web session authorizations could not be saved; removed the old file so a restart cannot bring back an authorization that ended (sessions will be asked again)");
      return { written: false, safe: true };
    }
  }

  /** A write owed to the disk, tried again once its wait is over. */
  private retry(): void { if (this.dirty && this.now() >= this.retryAt) this.flush(); }

  get(handle: string): SessionAuthorization | null { this.retry(); return this.load().get(handle) ?? null; }

  /** §0: this session is authorized by its account, from now until `until`, under `epoch` (it replaces an earlier one). */
  authorize(handle: string, owner: { adapterId: string; userId: string }, authorizedAt: number, epoch: number, until: number, peer?: WebPeer): { authorization: SessionAuthorization; durable: boolean } {
    const a = Object.freeze({ handle, owner: Object.freeze({ adapterId: owner.adapterId, userId: owner.userId }), authorizedAt, until, epoch, ...(peer ? { peer } : {}) });
    if (!valid(a)) throw new Error("invalid session authorization");
    const map = this.load();
    map.delete(handle);
    map.set(handle, a);
    // Oldest first out at the cap (the sessions themselves are capped far lower; this only bounds the file).
    while (map.size > SESSION_AUTHORIZATIONS_MAX) map.delete(map.keys().next().value!);
    return { authorization: a, durable: this.flush().written };
  }

  /**
   * Drop the ones no longer worth keeping: their session is gone, their epoch is old, or they have run out. `durable`:
   * none dropped (now or by an earlier failed write) can come back on a restart.
   */
  prune(keep: (a: SessionAuthorization) => boolean): { dropped: number; durable: boolean } {
    const map = this.load();
    let dropped = 0;
    for (const [handle, a] of map) if (!keep(a)) { map.delete(handle); dropped++; }
    if (!dropped && !this.dirty) return { dropped, durable: true };
    return { dropped, durable: this.flush().safe };
  }

  list(): SessionAuthorization[] { this.retry(); return [...this.load().values()]; }
}
