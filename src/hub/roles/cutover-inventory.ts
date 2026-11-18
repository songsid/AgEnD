/** Unmounted, read-only authority inventory. No contents or secret values are returned. */
import type Database from "better-sqlite3";
import {createHash} from "node:crypto";
import type {HubTransportStore} from "../store.js";
import {HubStateError} from "../db.js";
export const ROLE_CUTOVER_TABLES=Object.freeze([
 "hub_group_resources","hub_group_resource_events","hub_exposures","hub_grants","hub_rooms","hub_catalog_cursor","hub_quota_preferences","hub_auditors",
 "hub_company_join_control","hub_company_join_requests","hub_company_join_invites","hub_company_join_nonces","hub_company_join_cipher_nonces",
 "hub_enrolment_codes","hub_enrolment_code_uses","hub_enrolment_code_key","hub_pairing_notices","hub_pairing_notice_targets",
]as const);
/** Older HTTP entries may omit the personal schema; a half-present authority model is never a valid proof. */
export const PERSONAL_ROLE_AUTHORITY_TABLES=Object.freeze([
 "hub_personal_settings","hub_personal_creators","hub_personal_enrollments","hub_personal_computers","hub_personal_agents",
]as const);
export const ROOM_REQUEST_ROLE_AUTHORITY_TABLES=Object.freeze([
 "hub_room_agent_requests","hub_room_agent_request_settings","hub_room_agent_request_days",
]as const);
export interface RoleCutoverInventory {readonly v?:2;readonly digest:string;readonly tables:readonly {readonly name:string;readonly rows:number;readonly digest:string}[]}
const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
/** Caller binds the exact policy/epoch and takes another snapshot in its owning immediate transaction. */
export function captureRoleCutoverInventory(db:Database.Database,transport:Pick<HubTransportStore,"read">,assertCurrent:()=>void):RoleCutoverInventory{
 const guard=()=>{const r:unknown=assertCurrent();if(r&&typeof(r as{then?:unknown}).then==="function"){void Promise.resolve(r).catch(()=>{});throw new HubStateError("hub-storage","inventory proof must be synchronous");}};
 guard();const first=transport.read(),{revision:_r,revocationVersion:_v,...ordinary}=first;
 const tables:{name:string;rows:number;digest:string}[]=[{name:"hub_transport_state",rows:1,digest:sha(JSON.stringify(ordinary))}];
 const quote=(s:string)=>`"${s.replaceAll('"','""')}"`;
 const personal=PERSONAL_ROLE_AUTHORITY_TABLES.filter(name=>!!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
 if(personal.length&&personal.length!==PERSONAL_ROLE_AUTHORITY_TABLES.length)throw new HubStateError("hub-state-mismatch","personal authority inventory is incomplete");
 const requests=ROOM_REQUEST_ROLE_AUTHORITY_TABLES.filter(name=>!!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
 const registered=db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='hub_schema'").get()
  ?db.prepare("SELECT version FROM hub_schema WHERE component='s3-room-agent-requests'").get()as{version:number}|undefined:undefined;
 if(registered?registered.version!==1||requests.length!==ROOM_REQUEST_ROLE_AUTHORITY_TABLES.length:requests.length!==0)
  throw new HubStateError("hub-state-mismatch","room request authority inventory is incomplete or unsupported");
 for(const name of [...ROLE_CUTOVER_TABLES,...personal,...requests]){
  guard();const columns=db.prepare(`PRAGMA table_info(${quote(name)})`).all()as{name:string;type:string;pk:number}[];
  const keys=columns.filter(c=>c.pk>0).sort((a,b)=>a.pk-b.pk);
  if(!columns.length||!keys.length)throw new HubStateError("hub-state-mismatch","authority inventory table is missing or unkeyed");
  const metadata=columns.filter(c=>name!=="hub_room_agent_requests"||!["note_ref","digest"].includes(c.name));
  const digest=createHash("sha256").update(JSON.stringify(metadata.map(c=>[c.name,c.type,c.pk])));let rows=0;
  for(const row of db.prepare(`SELECT ${metadata.map(c=>quote(c.name)).join(",")} FROM ${quote(name)} ORDER BY ${keys.map(c=>quote(c.name)).join(",")}`).iterate()){
   guard();const encoded=JSON.stringify(row),bytes=Buffer.byteLength(encoded,"utf8");
   if(bytes>2*1024*1024)throw new HubStateError("hub-storage","authority metadata row exceeds its bound");
   digest.update(String(bytes)).update(":").update(encoded);rows++;
  }
  tables.push({name,rows,digest:digest.digest("hex")});
 }
 guard();if(JSON.stringify(transport.read())!==JSON.stringify(first))throw new HubStateError("hub-state-mismatch","transport changed during authority inventory");
 return Object.freeze({...(registered?{v:2 as const}:{}),digest:sha(JSON.stringify(registered?{v:2,tables}:tables)),tables:Object.freeze(tables.map(t=>Object.freeze(t)))});
}
