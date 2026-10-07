/**
 * Server-side web sessions.
 *
 * The cookie is an opaque 256-bit random id and nothing else: it is not derived
 * from `web.token`, from a login code, or from anything a guess could be
 * checked against offline. The server keeps only `sha256(id)`, so neither the
 * process nor the file on disk can be replayed as a cookie.
 *
 * What that buys over the old `sha256(web.token)` cookie:
 * - it expires on the *server* (absolute cap + sliding idle), not only in the
 *   browser's `Max-Age`;
 * - one device can be signed out without signing out the rest;
 * - a stolen one is one session, not a value shared by every device.
 *
 * `tokenEpoch` keeps the property the old cookie had for free: `agend web-token
 * rotate` (a separate process) changes `web.token`, every record made under the
 * old one stops matching on its next request, and no restart is needed.
 *
 * Sessions are persisted (hashes only) because Settings can restart the fleet,
 * and a session that lived only in memory would sign the operator out at the
 * moment they pressed the button — with no way back except a new chat code.
 *
 * See `docs/design/web-unification-secure-login.zh-TW.md` §3.3.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type SessionSurface = "local" | "gateway";
/** `admin` may do everything the panel can; `read` is reserved for the read-only tier (design D6). */
export type SessionTier = "admin" | "read";

export interface SessionPolicy {
  /** Hard cap from creation; activity never extends it. */
  readonly absoluteMs: number;
  /** Slides with activity, never past the absolute cap. */
  readonly idleMs: number;
}

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/** Design D4. The gateway numbers are shorter because a session there is reachable from the internet. */
export const DEFAULT_SESSION_POLICY: Readonly<Record<SessionSurface, SessionPolicy>> = {
  local: { absoluteMs: 12 * HOUR, idleMs: 2 * HOUR },
  gateway: { absoluteMs: 4 * HOUR, idleMs: 30 * MINUTE },
};

/** More than this and the least recently used one is dropped. */
export const MAX_WEB_SESSIONS = 8;

/** `lastSeen` is only written to disk this often; creation and revocation always write. */
export const SESSION_PERSIST_DEBOUNCE_MS = 60 * 1000;

const SESSION_ID_PATTERN = /^[0-9a-f]{64}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const HANDLE_PATTERN = /^[0-9a-f]{16}$/;
const LABEL_MAX = 80;

export interface SessionRecord {
  /** Opaque, safe to show and to name in a revoke request. Not the id and not its hash. */
  readonly handle: string;
  readonly idHash: string;
  readonly created: number;
  lastSeen: number;
  readonly absoluteExpiry: number;
  idleExpiry: number;
  readonly tier: SessionTier;
  readonly surface: SessionSurface;
  /** What the person sees in the device list. Display only, never an input to a decision. */
  readonly label: string;
  /** `sha256(web.token)` when the session was made; a mismatch means the token was rotated. */
  readonly tokenEpoch: string;
}

export interface SessionSummary {
  readonly handle: string;
  readonly created: number;
  readonly lastSeen: number;
  readonly absoluteExpiry: number;
  readonly idleExpiry: number;
  readonly tier: SessionTier;
  readonly surface: SessionSurface;
  readonly label: string;
  readonly current: boolean;
}

export function sessionIdHash(sessionId: string): string {
  return createHash("sha256").update(`agend-web-session-id-v2:${sessionId}`).digest("hex");
}

/** Binds a session to the `web.token` it was issued under. */
export function tokenEpoch(webToken: string): string {
  return createHash("sha256").update(`agend-web-epoch-v1:${webToken}`).digest("hex");
}

/**
 * The value a page sends back in `X-Agend-CSRF`.
 *
 * Derived from the session id so it needs no storage, and different from the
 * cookie value so it can be handed to script that must never see the cookie.
 */
export function csrfTokenFor(sessionId: string): string {
  return createHash("sha256").update(`agend-web-csrf-v1:${sessionId}`).digest("hex");
}

export function isWellFormedSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

/** Printable, bounded, and never empty: a label is drawn in a page by other people's code. */
export function sanitizeLabel(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f<>"'`&]/g, "").replace(/\s+/g, " ").trim().slice(0, LABEL_MAX);
  return cleaned || "unknown device";
}

/** "Chrome on macOS" out of a User-Agent, coarse on purpose — it is a hint for a person, not a fingerprint. */
export function labelFromUserAgent(userAgent: string | undefined): string {
  if (!userAgent) return "unknown device";
  const ua = userAgent;
  const browser = /Edg\//.test(ua) ? "Edge"
    : /OPR\/|Opera/.test(ua) ? "Opera"
      : /Firefox\//.test(ua) ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua) ? "Chrome"
          : /Safari\//.test(ua) ? "Safari"
            : /curl\//.test(ua) ? "curl"
              : "browser";
  const os = /iPhone|iPad|iOS/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
      : /Mac OS X|Macintosh/.test(ua) ? "macOS"
        : /Windows/.test(ua) ? "Windows"
          : /Linux|X11/.test(ua) ? "Linux"
            : "";
  return sanitizeLabel(os ? `${browser} on ${os}` : browser);
}

/** The three file operations the store makes, so a test can make one of them fail. */
export interface SessionFileOps {
  writeFileSync: typeof writeFileSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
}

export interface WebSessionStoreOptions {
  /** Where `web-sessions.json` lives. Omit for a memory-only store (tests). */
  readonly dataDir?: string;
  /** Override individual file operations (tests only). */
  readonly fileOps?: Partial<SessionFileOps>;
  readonly now?: () => number;
  readonly policy?: Partial<Record<SessionSurface, SessionPolicy>>;
  readonly maxSessions?: number;
  readonly onWarn?: (message: string) => void;
}

function isRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.handle === "string" && HANDLE_PATTERN.test(v.handle)
    && typeof v.idHash === "string" && HASH_PATTERN.test(v.idHash)
    && typeof v.created === "number" && Number.isFinite(v.created)
    && typeof v.lastSeen === "number" && Number.isFinite(v.lastSeen)
    && typeof v.absoluteExpiry === "number" && Number.isFinite(v.absoluteExpiry)
    && typeof v.idleExpiry === "number" && Number.isFinite(v.idleExpiry)
    && (v.tier === "admin" || v.tier === "read")
    && (v.surface === "local" || v.surface === "gateway")
    && typeof v.label === "string" && v.label.length <= LABEL_MAX
    && typeof v.tokenEpoch === "string" && HASH_PATTERN.test(v.tokenEpoch);
}

export class WebSessionStore {
  private readonly byHash = new Map<string, SessionRecord>();
  private readonly now: () => number;
  private readonly policy: Record<SessionSurface, SessionPolicy>;
  private readonly maxSessions: number;
  private readonly path: string | null;
  private readonly warn: (message: string) => void;
  private dirty = false;
  private lastPersist = 0;
  private readonly ops: SessionFileOps;
  /** The sessions the file on disk holds right now, as far as this process knows. */
  private persisted = new Set<string>();

  constructor(opts: WebSessionStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.policy = {
      local: opts.policy?.local ?? DEFAULT_SESSION_POLICY.local,
      gateway: opts.policy?.gateway ?? DEFAULT_SESSION_POLICY.gateway,
    };
    this.maxSessions = opts.maxSessions ?? MAX_WEB_SESSIONS;
    this.path = opts.dataDir ? join(opts.dataDir, "web-sessions.json") : null;
    this.warn = opts.onWarn ?? (() => {});
    this.ops = { writeFileSync, renameSync, unlinkSync, ...opts.fileOps };
    this.load();
  }

  get size(): number { return this.byHash.size; }

  /** How long a session on this surface may sit unused before it ends. For showing people, not for deciding. */
  idleWindowMs(surface: SessionSurface): number { return this.policy[surface].idleMs; }

  /**
   * Make a session. The id is returned once and never stored; the caller puts it
   * in a cookie and forgets it.
   */
  create(input: { tier: SessionTier; surface: SessionSurface; label: string; tokenEpoch: string }): { sessionId: string; record: SessionRecord } {
    const now = this.now();
    this.purgeExpired(now);
    const sessionId = randomBytes(32).toString("hex");
    const policy = this.policy[input.surface];
    const absoluteExpiry = now + policy.absoluteMs;
    const record: SessionRecord = {
      handle: randomBytes(8).toString("hex"),
      idHash: sessionIdHash(sessionId),
      created: now,
      lastSeen: now,
      absoluteExpiry,
      idleExpiry: Math.min(now + policy.idleMs, absoluteExpiry),
      tier: input.tier,
      surface: input.surface,
      label: sanitizeLabel(input.label),
      tokenEpoch: input.tokenEpoch,
    };
    this.byHash.set(record.idHash, record);
    while (this.byHash.size > this.maxSessions) this.evictLeastRecentlyUsed();
    this.persistNow();
    return { sessionId, record };
  }

  /**
   * The session this id belongs to, if it is still good.
   *
   * Expiry and a rotated `web.token` are decided here, on the server, on every
   * call — nothing is taken on the cookie's word. An expired or stale record is
   * deleted as it is found so it cannot be revived by a clock or config change.
   *
   * `touch: false` is for a stream that re-checks itself on a timer: counting
   * that as activity would keep an idle session alive for as long as a tab is
   * open.
   */
  authenticate(sessionId: string | undefined, currentEpoch: string, opts: { touch?: boolean } = {}): SessionRecord | null {
    if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) return null;
    const record = this.byHash.get(sessionIdHash(sessionId));
    if (!record) return null;
    const now = this.now();
    if (now >= record.absoluteExpiry || now >= record.idleExpiry || record.tokenEpoch !== currentEpoch) {
      this.byHash.delete(record.idHash);
      this.persistNow();
      return null;
    }
    if (opts.touch !== false) {
      record.lastSeen = now;
      record.idleExpiry = Math.min(now + this.policy[record.surface].idleMs, record.absoluteExpiry);
      this.dirty = true;
      this.persistIfDue(now);
    }
    return record;
  }

  /** Every live session, newest activity first. `currentIdHash` marks the caller's own. */
  list(currentIdHash?: string): SessionSummary[] {
    this.purgeExpired(this.now());
    return [...this.byHash.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map(r => ({
        handle: r.handle,
        created: r.created,
        lastSeen: r.lastSeen,
        absoluteExpiry: r.absoluteExpiry,
        idleExpiry: r.idleExpiry,
        tier: r.tier,
        surface: r.surface,
        label: r.label,
        current: r.idHash === currentIdHash,
      }));
  }

  /*
   * Every revocation says whether it is DURABLE: whether a restart could bring the revoked session back.
   * Memory forgets it at once; the file may not. A caller that reports "signed out" must not report it
   * when it is not durable — the operator would believe a session is dead that the next start revives.
   */

  revokeByHandle(handle: string): { found: boolean; durable: boolean } {
    if (!HANDLE_PATTERN.test(handle)) return { found: false, durable: true };
    for (const [hash, record] of this.byHash) {
      if (record.handle === handle) {
        this.byHash.delete(hash);
        return { found: true, durable: this.persistNow() };
      }
    }
    return { found: false, durable: true };
  }

  revokeById(sessionId: string): { removed: boolean; durable: boolean } {
    if (!SESSION_ID_PATTERN.test(sessionId)) return { removed: false, durable: true };
    const removed = this.byHash.delete(sessionIdHash(sessionId));
    return { removed, durable: removed ? this.persistNow() : true };
  }

  /** Every session: how many there were, and whether the revocation is durable. */
  revokeAll(): { count: number; durable: boolean } {
    const count = this.byHash.size;
    this.byHash.clear();
    return { count, durable: this.persistNow() };
  }

  /** Write anything pending. Called on shutdown. */
  flush(): void {
    if (this.dirty) this.persistNow();
  }

  private purgeExpired(now: number): void {
    let removed = false;
    for (const [hash, record] of this.byHash) {
      if (now >= record.absoluteExpiry || now >= record.idleExpiry) { this.byHash.delete(hash); removed = true; }
    }
    if (removed) this.dirty = true;
  }

  private evictLeastRecentlyUsed(): void {
    let oldest: SessionRecord | null = null;
    for (const record of this.byHash.values()) {
      if (!oldest || record.lastSeen < oldest.lastSeen) oldest = record;
    }
    if (oldest) this.byHash.delete(oldest.idHash);
  }

  private persistIfDue(now: number): void {
    if (this.dirty && now - this.lastPersist >= SESSION_PERSIST_DEBOUNCE_MS) this.persistNow();
  }

  /**
   * Write the store. Returns whether it is DURABLE: whether a restart is now unable to bring back a
   * session memory has dropped — true when the file was replaced, when the old file held nothing memory
   * dropped (it is merely behind), or when it was removed; false only when a stale file is still there.
   *
   * The failure path matters more than the success path. Memory forgets a revoked
   * session at once; if the file cannot be replaced it still holds that session, and a
   * restart would read it back — a revoked session, alive again. So when a write fails:
   * the store stays owing the disk a write (`dirty`, retried by the next change, the
   * next debounce and shutdown), and if the old file holds anything memory has since
   * dropped, the old file is removed. A restart then finds no sessions and everyone
   * signs in again, which is the failure that is safe; it says so, loudly, when even
   * that removal is impossible.
   */
  private persistNow(): boolean {
    this.lastPersist = this.now();
    if (!this.path) { this.dirty = false; return true; }
    const dir = dirname(this.path);
    const temp = `${this.path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      mkdirSync(dir, { recursive: true });
      const body = JSON.stringify({ version: 1, sessions: [...this.byHash.values()] });
      this.ops.writeFileSync(temp, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
      this.ops.renameSync(temp, this.path);
      try { chmodSync(this.path, 0o600); } catch { /* best effort */ }
      this.persisted = new Set(this.byHash.keys());
      this.dirty = false;
      return true;
    } catch (err) {
      try { this.ops.unlinkSync(temp); } catch { /* never created or already moved */ }
      this.dirty = true;
      const message = (err as Error).message;
      const staleOnDisk = [...this.persisted].some(hash => !this.byHash.has(hash));
      if (!staleOnDisk) {
        // Nothing on disk that memory has dropped: the file is merely behind, and a restart only loses the newest sign-ins.
        this.warn(`web sessions could not be saved (will retry): ${message}`);
        return true;
      }
      try {
        this.ops.unlinkSync(this.path);
        this.persisted = new Set();
        this.warn(`web sessions could not be saved (${message}); removed the old file so a restart cannot bring back a revoked session — everyone will have to sign in again`);
        return true;
      } catch {
        this.warn(`web sessions could not be saved (${message}) and the old file could not be removed: a restart may restore sessions that were revoked since the last successful save. Fix the permissions on ${this.path}`);
        return false;
      }
    }
  }

  private load(): void {
    if (!this.path) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.warn("web sessions file is unreadable — starting with none");
      return;
    }
    const list = (parsed as { sessions?: unknown } | null)?.sessions;
    if (!Array.isArray(list)) return;
    const now = this.now();
    for (const entry of list) {
      if (!isRecord(entry)) continue;
      if (now >= entry.absoluteExpiry || now >= entry.idleExpiry) continue;
      this.byHash.set(entry.idHash, { ...entry });
    }
    while (this.byHash.size > this.maxSessions) this.evictLeastRecentlyUsed();
    this.persisted = new Set(this.byHash.keys());
  }
}
