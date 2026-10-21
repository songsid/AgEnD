/**
 * #2348: the people AgEnD has seen in chat — the Settings → Guests picker's source. One row per platform account
 * (`adapter_id`, `user_id`), written where a platform message is admitted as human input (a human receipt: never a bot,
 * never the web), so only real senders appear. Kept 400 days since last seen (the receipts themselves are pruned at
 * `retention_days`, 30 by default — too short for "pick someone who wrote last month"). Backfilled once from the
 * receipts still kept. Ids leave this table only through the admin's Settings read.
 */
import type Database from "better-sqlite3";

export const SEEN_PEOPLE_KEEP_DAYS = 400;
/** The picker reads at most this many, most recently seen first. */
export const SEEN_PEOPLE_LIST_MAX = 500;
/** Instances remembered per person (the most recent). */
const INSTANCES_MAX = 20;

export interface SeenPerson {
  adapterId: string;
  userId: string;
  username: string | null;
  firstSeen: string;
  lastSeen: string;
  /** The instances they wrote to, most recent first, with when. */
  instances: Array<{ name: string; at: string }>;
}

export function initializeSeenPeople(db: Database.Database): void {
  const existed = !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'seen_people'").get();
  db.exec(`CREATE TABLE IF NOT EXISTS seen_people (
    adapter_id TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
    instances_json TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (adapter_id, user_id));
    CREATE INDEX IF NOT EXISTS idx_seen_people_last ON seen_people(last_seen);`);
  if (existed) return;
  // Once, when the table is new: everyone the receipts still name (platform messages only).
  const rows = db.prepare("SELECT target_instance, origin_json, created_at FROM human_delivery_receipts ORDER BY created_at").all() as
    Array<{ target_instance: string; origin_json: string; created_at: string }>;
  const tx = db.transaction(() => {
    for (const r of rows) {
      let o: { platform?: unknown; adapter_id?: unknown; user_id?: unknown; username?: unknown };
      try { o = JSON.parse(r.origin_json) as typeof o; } catch { continue; }
      if ((o.platform !== "discord" && o.platform !== "telegram") || typeof o.adapter_id !== "string" || typeof o.user_id !== "string") continue;
      noteSeenPerson(db, { adapterId: o.adapter_id, userId: o.user_id, username: typeof o.username === "string" ? o.username : null, instance: r.target_instance, at: r.created_at });
    }
  });
  tx();
}

/** A platform sender seen writing to `instance` at `at` (ISO). */
export function noteSeenPerson(db: Database.Database, p: { adapterId: string; userId: string; username: string | null; instance: string; at: string }): void {
  if (!p.adapterId || !p.userId) return;
  const row = db.prepare("SELECT first_seen, last_seen, instances_json, username FROM seen_people WHERE adapter_id = ? AND user_id = ?").get(p.adapterId, p.userId) as
    { first_seen: string; last_seen: string; instances_json: string; username: string | null } | undefined;
  let instances: Array<{ name: string; at: string }> = [];
  if (row) { try { instances = JSON.parse(row.instances_json) as typeof instances; } catch { instances = []; } }
  instances = [{ name: p.instance, at: p.at }, ...instances.filter((i) => i.name !== p.instance)]
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, INSTANCES_MAX);
  const last = row && row.last_seen > p.at ? row.last_seen : p.at;
  const first = row && row.first_seen < p.at ? row.first_seen : p.at;
  // The handle as last seen (a rename shows up); an older message never overwrites a newer one's.
  const username = row && row.last_seen > p.at ? row.username : (p.username ?? row?.username ?? null);
  db.prepare(`INSERT INTO seen_people (adapter_id, user_id, username, first_seen, last_seen, instances_json) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(adapter_id, user_id) DO UPDATE SET username = excluded.username, first_seen = excluded.first_seen, last_seen = excluded.last_seen, instances_json = excluded.instances_json`)
    .run(p.adapterId, p.userId, username, first, last, JSON.stringify(instances));
}

/** The picker's list: most recently seen first, at most SEEN_PEOPLE_LIST_MAX. */
export function listSeenPeople(db: Database.Database, limit = SEEN_PEOPLE_LIST_MAX): SeenPerson[] {
  const rows = db.prepare("SELECT * FROM seen_people ORDER BY last_seen DESC LIMIT ?").all(Math.max(1, Math.min(limit, SEEN_PEOPLE_LIST_MAX))) as
    Array<{ adapter_id: string; user_id: string; username: string | null; first_seen: string; last_seen: string; instances_json: string }>;
  return rows.map((r) => {
    let instances: SeenPerson["instances"] = [];
    try { instances = JSON.parse(r.instances_json) as SeenPerson["instances"]; } catch { instances = []; }
    return { adapterId: r.adapter_id, userId: r.user_id, username: r.username, firstSeen: r.first_seen, lastSeen: r.last_seen, instances };
  });
}

/** Whether an account was ever seen (and is still kept): a grant may only name one (or one already granted). */
export function isSeenPerson(db: Database.Database, adapterId: string, userId: string): boolean {
  return !!db.prepare("SELECT 1 FROM seen_people WHERE adapter_id = ? AND user_id = ?").get(adapterId, userId);
}

/** Forget whoever was last seen before `cutoffIso`. */
export function pruneSeenPeople(db: Database.Database, cutoffIso: string): number {
  return db.prepare("DELETE FROM seen_people WHERE last_seen < ?").run(cutoffIso).changes;
}
