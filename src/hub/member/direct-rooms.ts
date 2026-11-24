/** Signed question room identities stay outside the strict encrypted question journal (rollback-safe metadata). */
import type Database from "better-sqlite3";
export class HubDirectRooms {
  constructor(private db:Database.Database){db.exec(`CREATE TABLE IF NOT EXISTS hub_member_direct_rooms(message_id TEXT PRIMARY KEY,room_id TEXT NOT NULL,exposure_id TEXT NOT NULL,token TEXT NOT NULL)`);}
  remember(message:string,room:string,exposure:string,token:string):void {
    this.db.prepare("DELETE FROM hub_member_direct_rooms WHERE message_id NOT LIKE 'listed:%' AND message_id NOT IN(SELECT message_id FROM hub_representative_questions)").run();
    this.db.prepare("INSERT INTO hub_member_direct_rooms VALUES(?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET room_id=excluded.room_id,exposure_id=excluded.exposure_id,token=excluded.token").run(message,room,exposure,token);
  }
  room(message:string):string|undefined{return (this.db.prepare("SELECT room_id FROM hub_member_direct_rooms WHERE message_id=?").get(message) as {room_id:string}|undefined)?.room_id;}
  has(room:string,exposure:string,token:string):boolean{return !!this.db.prepare("SELECT 1 FROM hub_member_direct_rooms WHERE room_id=? AND exposure_id=? AND token=? LIMIT 1").get(room,exposure,token);}
}
