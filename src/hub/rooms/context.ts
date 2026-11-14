import type Database from "better-sqlite3";
import type { HubCore } from "../http/core.js";
import type { HubRoomContextRow } from "../types.js";
export const boundedRoomText = (value: string, bytes: number): string => {
  if (Buffer.byteLength(value) <= bytes) return value;
  let out = "", used = 0;
  for (const c of value) { const n = Buffer.byteLength(c); if (used + n > bytes) break; out += c; used += n; }
  return out;
};
export function roomContext(core: HubCore, db: Database.Database, post: { id: string; room_id: string; sequence: number; reply_to: string | null }, floor: number): HubRoomContextRow[] {
  type Row = { id: string; sequence: number; author_name: string; content_ref: string; created_at: number };
  const rows = db.prepare("SELECT * FROM hub_room_posts WHERE room_id=? AND sequence<? AND sequence>=? AND author_kind<>'system' AND (stage IS NULL OR stage='answered') ORDER BY sequence DESC LIMIT 30")
    .all(post.room_id, post.sequence, floor) as Row[];
  const anchor = post.reply_to ? db.prepare("SELECT * FROM hub_room_posts WHERE id=? AND room_id=? AND sequence>=?").get(post.reply_to, post.room_id, floor) as Row | undefined : undefined;
  if (anchor && !rows.some(r => r.id === anchor.id)) rows.push(anchor);
  return rows.sort((a, b) => a.sequence - b.sequence).map(row => ({ author: boundedRoomText(row.author_name, 256),
    text: boundedRoomText(core.deps.content.get(row.content_ref)?.question ?? "", 2048), at: row.created_at,
    ...(row.id === post.reply_to ? { repliedTo: true as const } : {}) }));
}
