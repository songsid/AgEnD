import type Database from "better-sqlite3";
import {HubProtocolError} from "../validation.js";
export const HUB_ROOM_PURPOSE_MIGRATION=Object.freeze({component:"s3-room-purpose",version:1,up(db:Database.Database){
 db.exec("ALTER TABLE hub_group_rooms ADD COLUMN purpose TEXT NOT NULL DEFAULT ''");
 db.exec("CREATE TABLE hub_room_purpose_events(post_id TEXT PRIMARY KEY REFERENCES hub_room_posts(id) ON DELETE CASCADE,purpose TEXT NOT NULL)");
}});
export function normalizeRoomPurpose(value:unknown):string{
 if(typeof value!=="string")throw new HubProtocolError("invalid");
 const text=value.normalize("NFC").replace(/[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/gu," ").replace(/\s+/gu," ").trim();
 if([...new Intl.Segmenter(undefined,{granularity:"grapheme"}).segment(text)].length>200)throw new HubProtocolError("invalid");
 return text;
}
