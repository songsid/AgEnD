/**
 * #1939 §0: which web sessions their account has authorized — once per session, by confirming on Discord or Telegram
 * (S2b's Confirm card or DM code). Kept beside the fleet in `web-authorizations.json` (0600, atomic) so a restart keeps
 * them, keyed by the session's opaque handle, each stamped with the account it was given by and the revocation epoch it
 * was given under (authority-state.ts): an epoch bump (`/web revoke`, the switch, loopback_only off) ends every one at
 * once. Losing this file only loses authorizations — a person authorizes again; it can never grant one.
 */
import { readFileSync } from "node:fs";
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
}
const fileIo: SessionAuthorizationsIo = { read: p => readFileSync(p, "utf8"), write: (p, d) => atomicWriteFileSync(p, d, { mode: 0o600 }) };

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

  constructor(private readonly path: string, private readonly log: { warn(obj: object, msg?: string): void }, private readonly io: SessionAuthorizationsIo = fileIo) {}

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
        if (valid(a)) this.byHandle.set(a.handle, Object.freeze({ handle: a.handle, owner: Object.freeze({ adapterId: a.owner.adapterId, userId: a.owner.userId }), authorizedAt: a.authorizedAt, until: a.until, epoch: a.epoch, ...(a.peer ? { peer: a.peer } : {}) }));
      }
    } catch { this.log.warn({ path: this.path }, "Web session authorizations unreadable; none are kept"); }
    return this.byHandle;
  }

  /** Persist; false when it could not be written (it still holds for this process: an authorization lost later is only re-asked). */
  private flush(): boolean {
    try {
      this.io.write(this.path, JSON.stringify({ v: 1, authorizations: [...this.load().values()] }) + "\n");
      this.warned = false;
      return true;
    } catch (err) {
      if (!this.warned) this.log.warn({ err: (err as Error).message, path: this.path }, "Web session authorizations could not be saved; a restart forgets them");
      this.warned = true;
      return false;
    }
  }

  get(handle: string): SessionAuthorization | null { return this.load().get(handle) ?? null; }

  /** §0: this session is authorized by its account, from now until `until`, under `epoch` (it replaces an earlier one). */
  authorize(handle: string, owner: { adapterId: string; userId: string }, authorizedAt: number, epoch: number, until: number, peer?: WebPeer): { authorization: SessionAuthorization; durable: boolean } {
    const a = Object.freeze({ handle, owner: Object.freeze({ adapterId: owner.adapterId, userId: owner.userId }), authorizedAt, until, epoch, ...(peer ? { peer } : {}) });
    if (!valid(a)) throw new Error("invalid session authorization");
    const map = this.load();
    map.delete(handle);
    map.set(handle, a);
    // Oldest first out at the cap (the sessions themselves are capped far lower; this only bounds the file).
    while (map.size > SESSION_AUTHORIZATIONS_MAX) map.delete(map.keys().next().value!);
    return { authorization: a, durable: this.flush() };
  }

  /** Drop the ones no longer worth keeping: their session is gone, their epoch is old, or they have run out. */
  prune(keep: (a: SessionAuthorization) => boolean): number {
    const map = this.load();
    let dropped = 0;
    for (const [handle, a] of map) if (!keep(a)) { map.delete(handle); dropped++; }
    if (dropped) this.flush();
    return dropped;
  }

  list(): SessionAuthorization[] { return [...this.load().values()]; }
}
