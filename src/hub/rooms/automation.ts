/** Durable Hub-owned episodes. No Fleet-supplied ancestry and no work started by a timer. */
import type Database from "better-sqlite3";
import type { RoomPostRow } from "./agents.js";
type DB = Database.Database;
type Lineage = { root_id: string; depth: number; audience_sequence: number; return_post_id: string | null };
export const ROOM_AGENT_QUIET_MS = 30 * 60_000;
export class RoomAutomation {
  constructor(private readonly now: () => number) {}
  human(db: DB, post: RoomPostRow): void {
    db.prepare("INSERT INTO hub_room_post_lineage VALUES(?,?,0,?,NULL)").run(post.id, post.id, post.sequence);
    db.prepare(`INSERT INTO hub_room_automation VALUES(?,?,?) ON CONFLICT(room_id) DO UPDATE SET root_id=excluded.root_id,last_agent_ask=excluded.last_agent_ask`)
      .run(post.room_id, post.id, this.now());
  }
  proactive(db: DB, post: RoomPostRow): void {
    const current = db.prepare("SELECT root_id,last_agent_ask FROM hub_room_automation WHERE room_id=?").get(post.room_id) as { root_id: string; last_agent_ask: number } | undefined;
    const pending = db.prepare(`SELECT 1 FROM hub_room_deliveries WHERE room_id=? AND source_exposure_id IS NOT NULL AND on_behalf=0 AND state IN ('queued','sent') AND expires_at>? LIMIT 1`).get(post.room_id, this.now());
    const root = !current || this.now() - current.last_agent_ask >= ROOM_AGENT_QUIET_MS && !pending ? post.id : current.root_id;
    if (root === post.id) db.prepare(`INSERT INTO hub_room_automation VALUES(?,?,?) ON CONFLICT(room_id) DO UPDATE SET root_id=excluded.root_id,last_agent_ask=excluded.last_agent_ask`).run(post.room_id, root, this.now());
    const depth = (db.prepare("SELECT depth FROM hub_room_agent_depths WHERE root_id=? AND exposure_id=?").get(root, post.author_id) as { depth: number } | undefined)?.depth ?? 0;
    db.prepare("INSERT INTO hub_room_post_lineage VALUES(?,?,?,?,NULL)").run(post.id, root, depth, post.sequence);
  }
  onBehalf(db: DB, post: RoomPostRow, owner: string, receipt: string, exposure: string): void {
    const old = db.prepare("SELECT root_id FROM hub_room_human_receipts WHERE room_id=? AND owner=? AND receipt_id=?").get(post.room_id, owner, receipt) as { root_id: string } | undefined;
    const root = old?.root_id ?? post.id;
    if (!old) {
      db.prepare("INSERT INTO hub_room_human_receipts VALUES(?,?,?,?)").run(post.room_id, owner, receipt, root);
      db.prepare(`INSERT INTO hub_room_automation VALUES(?,?,?) ON CONFLICT(room_id) DO UPDATE SET root_id=excluded.root_id,last_agent_ask=excluded.last_agent_ask`).run(post.room_id, root, this.now());
    }
    // Reusing a receipt never opens a fresh room episode or lowers its source's depth.
    const depth = old ? (db.prepare("SELECT depth FROM hub_room_agent_depths WHERE root_id=? AND exposure_id=?").get(root, exposure) as { depth: number } | undefined)?.depth ?? 0 : 0;
    db.prepare("INSERT INTO hub_room_post_lineage VALUES(?,?,?,?,?)").run(post.id, root, depth, post.sequence, post.id);
  }
  lineage(db: DB, post: RoomPostRow): Lineage {
    // Pre-feature outstanding answers are conservatively terminal. Only a fresh human/proactive root resets them.
    const lineage = db.prepare("SELECT * FROM hub_room_post_lineage WHERE post_id=?").get(post.id) as Lineage | undefined;
    if (lineage) return lineage;
    const parent = post.answer_to ? db.prepare("SELECT sequence FROM hub_room_posts WHERE id=?").get(post.answer_to) as { sequence: number } | undefined : undefined;
    const value = { root_id: post.id, depth: post.author_kind === "person" ? 0 : 3, audience_sequence: parent?.sequence ?? post.sequence, return_post_id: null };
    db.prepare("INSERT INTO hub_room_post_lineage VALUES(?,?,?,?,NULL)").run(post.id, value.root_id, value.depth, value.audience_sequence); return value;
  }
  depth(db: DB, post: RoomPostRow): number {
    const l = this.lineage(db, post), source = (db.prepare("SELECT exposure_id FROM hub_room_agent_operations WHERE post_id=?").get(post.id) as { exposure_id: string } | undefined)?.exposure_id ?? post.author_id;
    return Math.max(l.depth, (db.prepare("SELECT depth FROM hub_room_agent_depths WHERE root_id=? AND exposure_id=?").get(l.root_id, source) as { depth: number } | undefined)?.depth ?? 0);
  }
  child(db: DB, parent: RoomPostRow, replyId: string, exposure: string): void {
    const l = this.lineage(db, parent), depth = this.depth(db, parent) + 1;
    db.prepare("INSERT INTO hub_room_post_lineage VALUES(?,?,?,?,?)").run(replyId, l.root_id, depth, l.audience_sequence, l.return_post_id);
    db.prepare(`INSERT INTO hub_room_agent_depths VALUES(?,?,?) ON CONFLICT(root_id,exposure_id) DO UPDATE SET depth=MAX(depth,excluded.depth)`).run(l.root_id, exposure, depth);
    if (parent.author_kind === "agent") db.prepare("UPDATE hub_room_automation SET last_agent_ask=? WHERE room_id=?").run(this.now(), parent.room_id);
  }
  /** One accepted post / routed target is one action; failed admission spends nothing. */
  admit(db: DB, room: string, exposure: string): number | null {
    const now = this.now(); db.prepare("DELETE FROM hub_room_agent_actions WHERE at<=?").run(now - 60_000);
    const rows = db.prepare("SELECT exposure_id,at FROM hub_room_agent_actions WHERE room_id=? ORDER BY at").all(room) as { exposure_id: string; at: number }[];
    const own = db.prepare("SELECT at FROM hub_room_agent_actions WHERE exposure_id=? ORDER BY at").all(exposure) as { at: number }[];
    const retry = Math.max(rows.length >= 30 ? rows[rows.length - 30]!.at + 60_000 : 0, own.length >= 5 ? own[own.length - 5]!.at + 60_000 : 0);
    if (retry) return retry;
    db.prepare("INSERT INTO hub_room_agent_actions(room_id,exposure_id,at) VALUES(?,?,?)").run(room, exposure, now); return null;
  }
}
