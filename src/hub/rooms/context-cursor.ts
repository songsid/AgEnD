import type Database from "better-sqlite3";
import type { HubRoomContextState } from "../room-context-model.js";

export function migrateRoomContext(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS hub_room_context_generations(
      exposure_id TEXT PRIMARY KEY,binding TEXT NOT NULL,generation TEXT NOT NULL,link_epoch INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS hub_room_context_seen(
      exposure_id TEXT NOT NULL,binding TEXT NOT NULL,generation TEXT NOT NULL,
      PRIMARY KEY(exposure_id,binding,generation));
    CREATE TABLE IF NOT EXISTS hub_room_context_positions(
      room_id TEXT NOT NULL,exposure_id TEXT NOT NULL,binding TEXT NOT NULL,generation TEXT NOT NULL,last_sequence INTEGER NOT NULL,
      PRIMARY KEY(room_id,exposure_id,binding,generation));`);
  const columns = db.prepare("PRAGMA table_info(hub_room_deliveries)").all() as {name:string}[];
  if (columns.length && !columns.some(c => c.name === "context_generation")) db.exec("ALTER TABLE hub_room_deliveries ADD COLUMN context_generation TEXT");
}
export const HUB_ROOM_CONTEXT_MIGRATION = Object.freeze({ component: "s3-room-context", version: 1, up: migrateRoomContext });

/** Called only inside the room host's existing atomic, after current link/publication/member checks. */
export class RoomContextCursor {
  constructor(private readonly db: Database.Database) {}
  generation(exposure: string, binding: string, linkEpoch?: number): string | null {
    const row = this.db.prepare("SELECT generation FROM hub_room_context_generations WHERE exposure_id=? AND binding=? AND (? IS NULL OR link_epoch=?)")
      .get(exposure,binding,linkEpoch ?? null,linkEpoch ?? null) as {generation:string}|undefined;
    return row?.generation ?? null;
  }
  observe(exposure: string, binding: string, generation: string, linkEpoch = 0): boolean {
    if (this.generation(exposure,binding) === generation) {
      this.db.prepare("UPDATE hub_room_context_generations SET link_epoch=? WHERE exposure_id=? AND binding=?").run(linkEpoch,exposure,binding);
      return true;
    }
    if (this.db.prepare("SELECT 1 FROM hub_room_context_seen WHERE exposure_id=? AND binding=? AND generation=?").get(exposure,binding,generation)) return false;
    this.db.prepare("INSERT INTO hub_room_context_seen VALUES(?,?,?)").run(exposure,binding,generation);
    this.db.prepare("INSERT INTO hub_room_context_generations VALUES(?,?,?,?) ON CONFLICT(exposure_id) DO UPDATE SET binding=excluded.binding,generation=excluded.generation,link_epoch=excluded.link_epoch")
      .run(exposure,binding,generation,linkEpoch);
    return true;
  }
  position(room: string, exposure: string, binding: string, generation: string): number {
    return (this.db.prepare("SELECT last_sequence FROM hub_room_context_positions WHERE room_id=? AND exposure_id=? AND binding=? AND generation=?")
      .get(room,exposure,binding,generation) as {last_sequence:number}|undefined)?.last_sequence ?? 0;
  }
  snapshot(room: string, exposure: string, binding: string, through: number, linkEpoch?: number): HubRoomContextState | null {
    const generation = this.generation(exposure,binding,linkEpoch);
    if (!generation) return null;
    const after = Math.min(this.position(room,exposure,binding,generation), through - 1);
    return { generation, after, through };
  }
  received(room: string, exposure: string, binding: string, generation: string, interval: HubRoomContextState): boolean {
    if (interval.generation !== generation || this.generation(exposure,binding) !== generation) return false;
    const current = this.position(room,exposure,binding,generation);
    if (interval.after > current || interval.through <= interval.after) return false;
    this.db.prepare(`INSERT INTO hub_room_context_positions VALUES(?,?,?,?,?)
      ON CONFLICT(room_id,exposure_id,binding,generation) DO UPDATE SET last_sequence=MAX(last_sequence,excluded.last_sequence)`)
      .run(room,exposure,binding,generation,interval.through);
    return true;
  }
}
