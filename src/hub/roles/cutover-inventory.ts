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
export interface RoleCutoverInventory {readonly digest:string;readonly tables:readonly {readonly name:string;readonly rows:number;readonly digest:string}[]}
const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
/** Caller binds the exact policy/epoch and takes another snapshot in its owning immediate transaction. */
export function captureRoleCutoverInventory(db:Database.Database,transport:Pick<HubTransportStore,"read">,assertCurrent:()=>void):RoleCutoverInventory{
 const guard=()=>{const r:unknown=assertCurrent();if(r&&typeof(r as{then?:unknown}).then==="function"){void Promise.resolve(r).catch(()=>{});throw new HubStateError("hub-storage","inventory proof must be synchronous");}};
 guard();const first=transport.read(),{revision:_r,revocationVersion:_v,...ordinary}=first;
 const tables:{name:string;rows:number;digest:string}[]=[{name:"hub_transport_state",rows:1,digest:sha(JSON.stringify(ordinary))}];
 const quote=(s:string)=>`"${s.replaceAll('"','""')}"`;
 for(const name of ROLE_CUTOVER_TABLES){
  guard();const columns=db.prepare(`PRAGMA table_info(${quote(name)})`).all()as{name:string;type:string;pk:number}[];
  const keys=columns.filter(c=>c.pk>0).sort((a,b)=>a.pk-b.pk);
  if(!columns.length||!keys.length)throw new HubStateError("hub-state-mismatch","authority inventory table is missing or unkeyed");
  const digest=createHash("sha256").update(JSON.stringify(columns.map(c=>[c.name,c.type,c.pk])));let rows=0;
  for(const row of db.prepare(`SELECT * FROM ${quote(name)} ORDER BY ${keys.map(c=>quote(c.name)).join(",")}`).iterate()){
   guard();const encoded=JSON.stringify(row),bytes=Buffer.byteLength(encoded,"utf8");
   if(bytes>2*1024*1024)throw new HubStateError("hub-storage","authority metadata row exceeds its bound");
   digest.update(String(bytes)).update(":").update(encoded);rows++;
  }
  tables.push({name,rows,digest:digest.digest("hex")});
 }
 guard();if(JSON.stringify(transport.read())!==JSON.stringify(first))throw new HubStateError("hub-state-mismatch","transport changed during authority inventory");
 return Object.freeze({digest:sha(JSON.stringify(tables)),tables:Object.freeze(tables.map(t=>Object.freeze(t)))});
}
