/**
 * M-3592: how long a Hub sign-in lasts, set by the Hub administrator (Administration → Sign-in). Two limits:
 * - absolute: from sign-in, whatever the person does (default 8 h; 1 h – 7 d);
 * - idle: since the session was last used (default 1 h; 15 min – 24 h). An open Hub page keeps a session in use: its
 *   event stream checks the session every 15 s, so idle ends a session only when no Hub page is open for it.
 * A lower limit applies to every session at once; a higher one to sessions signed in from then on (their end was set at
 * sign-in). No row: the defaults (a Hub never configured, or one from before this setting).
 */
import { z } from "zod";
import type Database from "better-sqlite3";
import { validated } from "./validation.js";
import type { HubCore } from "./http/core.js";
import type { HubRequestContext } from "./types.js";

const MIN = 60_000;
/** Bounds and defaults, in minutes. */
export const HUB_SESSION_LIMIT_BOUNDS = Object.freeze({
  absolute: Object.freeze({ min: 60, max: 7 * 24 * 60, default: 8 * 60 }),
  idle: Object.freeze({ min: 15, max: 24 * 60, default: 60 }),
});
export interface HubSessionLimits { absoluteMs: number; idleMs: number }
export const HUB_SESSION_DEFAULT_LIMITS: Readonly<HubSessionLimits> = Object.freeze({
  absoluteMs: HUB_SESSION_LIMIT_BOUNDS.absolute.default * MIN, idleMs: HUB_SESSION_LIMIT_BOUNDS.idle.default * MIN,
});

export const HUB_SESSION_LIMITS_MIGRATION = Object.freeze({ component: "s5-session-limits" as const, version: 1, up(db: Database.Database) {
  const a = HUB_SESSION_LIMIT_BOUNDS.absolute, i = HUB_SESSION_LIMIT_BOUNDS.idle;
  db.exec(`CREATE TABLE hub_session_limits(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    absolute_minutes INTEGER NOT NULL CHECK(absolute_minutes BETWEEN ${a.min} AND ${a.max}),
    idle_minutes INTEGER NOT NULL CHECK(idle_minutes BETWEEN ${i.min} AND ${i.max}),
    revision INTEGER NOT NULL CHECK(revision>=1), set_at INTEGER NOT NULL);`);
} });

interface Row { absolute_minutes: number; idle_minutes: number; revision: number; set_at: number }
const within = (n: unknown, b: { min: number; max: number }) => Number.isInteger(n) && (n as number) >= b.min && (n as number) <= b.max;
/** The stored row, or null (none saved, or a database without the table: an old or partial Hub schema). */
function row(db: Database.Database): Row | null {
  let r: Row | undefined;
  try { r = db.prepare("SELECT absolute_minutes, idle_minutes, revision, set_at FROM hub_session_limits WHERE singleton=1").get() as Row | undefined; }
  catch (e) { if (/no such table/i.test(String((e as Error)?.message))) return null; throw e; }
  if (!r) return null;
  // The table's CHECKs hold these; a row out of bounds anyway is never trusted to lengthen a session.
  if (!within(r.absolute_minutes, HUB_SESSION_LIMIT_BOUNDS.absolute) || !within(r.idle_minutes, HUB_SESSION_LIMIT_BOUNDS.idle)) throw Error("session_limits_invalid");
  return r;
}
/** The limits in force (ms): the saved ones, else the defaults. Cheap: one indexed read, inside the caller's transaction. */
export function hubSessionLimits(db: Database.Database): HubSessionLimits {
  const r = row(db);
  return r ? { absoluteMs: r.absolute_minutes * MIN, idleMs: r.idle_minutes * MIN } : { ...HUB_SESSION_DEFAULT_LIMITS };
}

/**
 * Whether a session row is within the limits at `now`: used within the idle limit, and signed in less than the absolute
 * limit ago (a lower limit ends sessions signed in before it). Its own expires_at (set at sign-in) is the caller's
 * check too. The one rule for HubSessions, the company-join approval and the directory session rotation.
 */
export function withinHubSessionLimits(row: { created_at: number; seen_at: number }, limits: HubSessionLimits, now: number): boolean {
  return now - row.seen_at <= limits.idleMs && now < row.created_at + limits.absoluteMs;
}
export interface HubSessionLimitsView {
  absoluteMinutes: number; idleMinutes: number; revision: number; configured: boolean; setAt: number | null;
  bounds: typeof HUB_SESSION_LIMIT_BOUNDS;
}
const saveSchema = z.strictObject({
  absoluteMinutes: z.number().int().min(HUB_SESSION_LIMIT_BOUNDS.absolute.min).max(HUB_SESSION_LIMIT_BOUNDS.absolute.max),
  idleMinutes: z.number().int().min(HUB_SESSION_LIMIT_BOUNDS.idle.min).max(HUB_SESSION_LIMIT_BOUNDS.idle.max),
  ifRevision: z.number().int().min(0),
});
export class HubSessionLimitRefusal extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/** The administrator's read and save (`hub.admin`), audited as `session.limits-updated`. */
export class HubSessionLimitSettings {
  constructor(private readonly core: HubCore) {}
  private view(db: Database.Database): HubSessionLimitsView {
    const r = row(db), d = HUB_SESSION_LIMIT_BOUNDS;
    return { absoluteMinutes: r?.absolute_minutes ?? d.absolute.default, idleMinutes: r?.idle_minutes ?? d.idle.default,
      revision: r?.revision ?? 0, configured: !!r, setAt: r?.set_at ?? null, bounds: HUB_SESSION_LIMIT_BOUNDS };
  }
  async settings(ctx: HubRequestContext): Promise<HubSessionLimitsView> {
    const permit = await this.core.management(ctx, "hub.admin");
    return this.core.atomic((db) => { permit.assertCurrent(); return this.view(db); });
  }
  async save(ctx: HubRequestContext, value: unknown): Promise<HubSessionLimitsView> {
    const permit = await this.core.management(ctx, "hub.admin"), input = validated(saveSchema, value);
    // An idle limit longer than the whole sign-in would never apply: refused rather than silently meaningless.
    if (input.idleMinutes > input.absoluteMinutes) throw new HubSessionLimitRefusal(400, "idle-longer-than-absolute");
    return this.core.atomic((db, tx) => {
      this.core.check(); permit.assertCurrent();
      if (ctx.isCurrent?.() === false) throw new HubSessionLimitRefusal(401, "revoked");
      const before = this.view(db);
      if (input.ifRevision !== before.revision) throw new HubSessionLimitRefusal(409, "revision-conflict");
      if (before.configured && before.absoluteMinutes === input.absoluteMinutes && before.idleMinutes === input.idleMinutes) return before;
      db.prepare(`INSERT INTO hub_session_limits VALUES(1,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET
        absolute_minutes=excluded.absolute_minutes, idle_minutes=excluded.idle_minutes, revision=excluded.revision, set_at=excluded.set_at`)
        .run(input.absoluteMinutes, input.idleMinutes, before.revision + 1, this.core.now());
      // #4397 review: the new limits are written into the sessions now, not only when each is next used — so a lower
      // limit raised again before a session is next checked still ended it. Each active session's end is pulled in to
      // its sign-in + the absolute limit (never pushed out); any already past it, or unused longer than the idle limit,
      // ends now.
      const now = this.core.now(), absMs = input.absoluteMinutes * 60_000, idleMs = input.idleMinutes * 60_000;
      db.prepare("UPDATE hub_sessions SET expires_at=created_at+? WHERE state='active' AND expires_at>created_at+?").run(absMs, absMs);
      db.prepare("UPDATE hub_sessions SET state='ended' WHERE state='active' AND (expires_at<=? OR ?-seen_at>?)").run(now, now, idleMs);
      this.core.audit(tx, { requestId: ctx.requestId,
        actor: permit.actor.kind === "directory" ? { kind: "person", person: permit.actor.person } : { kind: "local-host" },
        action: "session.limits-updated", result: "completed",
        reasonCode: `absolute:${input.absoluteMinutes},idle:${input.idleMinutes}` });
      return this.view(db);
    });
  }
}
