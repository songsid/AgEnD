import type Database from "better-sqlite3";
import {agentIntro} from "../agent-intro.js";
import {formatRoomBrief,type RoomBrief} from "../room-brief-model.js";
export const HUB_ROOM_BRIEF_MIGRATION=Object.freeze({component:"s3-room-brief",version:1,up(db:Database.Database){
 db.exec(`CREATE TABLE hub_room_brief_positions(room_id TEXT NOT NULL,exposure_id TEXT NOT NULL,binding TEXT NOT NULL,generation TEXT NOT NULL,through_sequence INTEGER NOT NULL,roster TEXT NOT NULL,PRIMARY KEY(room_id,exposure_id,binding,generation));
 CREATE TABLE hub_room_brief_deliveries(delivery_id TEXT PRIMARY KEY REFERENCES hub_room_deliveries(id) ON DELETE CASCADE,roster TEXT NOT NULL);`);
}});
interface Person {id:string;kind:"person"|"agent";name:string;intro?:string}
export function roomRoster(db:Database.Database,room:string):Person[]{
 return (db.prepare("SELECT m.id,m.kind,m.subject,COALESCE(e.display_name,h.display_name,p.display_name,m.subject) name FROM hub_room_members m LEFT JOIN hub_exposures e ON m.kind='agent' AND e.id=m.subject LEFT JOIN hub_people h ON m.kind='person' AND h.person=m.subject LEFT JOIN hub_room_people p ON m.kind='person' AND p.person=m.subject WHERE m.room_id=? AND m.kind IN ('person','agent') ORDER BY m.kind,m.id").all(room) as {id:string;kind:"person"|"agent";subject:string;name:string}[]).map(m=>({id:m.id,kind:m.kind,name:m.name,...(m.kind==="agent"?{intro:agentIntro(db,m.subject).intro??""}:{})}));
}
export function previousRoster(db:Database.Database,room:string,exposure:string,binding:string,generation:string):Person[]|null{
 const row=db.prepare("SELECT roster FROM hub_room_brief_positions WHERE room_id=? AND exposure_id=? AND binding=? AND generation=?").get(room,exposure,binding,generation) as {roster:string}|undefined;
 return row?JSON.parse(row.roster):null;
}
export function buildRoomBrief(purpose:string,roster:Person[],previous:Person[]|null):RoomBrief|undefined{
 if(!previous)return {kind:"first",purpose,people:roster.filter(m=>m.kind==="person").length,agents:roster.filter(m=>m.kind==="agent").length};
 const joined=roster.filter(m=>!previous.some(p=>p.id===m.id)),left=previous.filter(m=>!roster.some(p=>p.id===m.id));
 if(!joined.length&&!left.length)return;
 const brief:Extract<RoomBrief,{kind:"delta"}>={kind:"delta",joined:joined.slice(0,5).map(({id,...m})=>m),left:left.slice(0,Math.max(0,5-joined.length)).map(({kind,name})=>({kind,name})),omitted:Math.max(0,joined.length+left.length-5)};
 // Drop whole rows, never split a visible name/introduction. Both fixed-language lines remain under 600 bytes.
 while(Math.max(...(["en","zh-TW"] as const).map(lang=>Buffer.byteLength(formatRoomBrief(brief,lang))))>=600){
   if(brief.left.length)brief.left.pop();else if(brief.joined.length)brief.joined.pop();else break;brief.omitted++;
 }
 return brief;
}
export function confirmRoomBrief(db:Database.Database,delivery:string,room:string,exposure:string,binding:string,generation:string,through:number):void{
 const snapshot=db.prepare("SELECT roster FROM hub_room_brief_deliveries WHERE delivery_id=?").get(delivery) as {roster:string}|undefined;
 if(!snapshot)return;
 db.prepare(`INSERT INTO hub_room_brief_positions VALUES(?,?,?,?,?,?) ON CONFLICT(room_id,exposure_id,binding,generation) DO UPDATE SET through_sequence=excluded.through_sequence,roster=excluded.roster WHERE excluded.through_sequence>hub_room_brief_positions.through_sequence`).run(room,exposure,binding,generation,through,snapshot.roster);
}
