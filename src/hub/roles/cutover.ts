/** Unmounted cutover preparation. Never registered or invoked by production startup in this slice. */
import type Database from "better-sqlite3";
import {createHash,randomUUID} from "node:crypto";
import {performance} from "node:perf_hooks";
import {z} from "zod";
import {applyHubMigrations,assertHubMigrationsCurrent,type HubMigration} from "../db.js";
import type {HubTransportStore} from "../store.js";
import type {PersonKey} from "../types.js";
import {epoch,hash,identifier,parseStrictJson,person,uuid,validated} from "../validation.js";
import {parseGroupPolicy} from "../group-policy/model.js";
import {convertGroupPolicy} from "./convert.js";
import {parseRolePolicy} from "./model.js";
import {HUB_ROLE_WRITER_MIGRATION} from "./writer.js";
import {HUB_ROLE_EXPIRY_MIGRATION} from "./expiry.js";
import {captureRoleCutoverInventory} from "./cutover-inventory.js";
export const HUB_ROLE_CUTOVER_MIGRATION:HubMigration={component:"roles-cutover",version:1,up(db){db.exec("CREATE TABLE IF NOT EXISTS hub_role_cutover(singleton INTEGER PRIMARY KEY CHECK(singleton=1),body TEXT NOT NULL)");}};
export interface RoleCutoverOptions {db:Database.Database;hubId:string;realm:string;generation:string;root:PersonKey;
 transport:Pick<HubTransportStore,"read"|"mutate">;migrations:readonly HubMigration[];current():boolean;refreshAuthorization():void;now?:()=>number;elapsedNow?:()=>number;}
export type RoleCutoverResult={ok:true;changed:boolean;revision:number;epoch:number}|{ok:false;code:"unavailable"|"conflict"|"expired"};
class Refusal extends Error{constructor(readonly code:"unavailable"|"conflict"|"expired"){super(code);}}
const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
const part=z.strictObject({name:identifier,rows:epoch,digest:hash});
const markerSchema=z.strictObject({v:z.literal(1),hubId:uuid,realm:person.shape.realm,generation:identifier,root:person,at:epoch,
 oldRaw:z.string().max(256*1024),oldDigest:hash,roleDigest:hash,fromRevision:epoch,transportRevision:epoch,authorizationVersion:epoch,
 inventory:z.strictObject({digest:hash,tables:z.array(part).max(64)}),auditId:uuid});
function sync(value:unknown){if(value&&typeof(value as{then?:unknown}).then==="function"){void Promise.resolve(value).catch(()=>{});throw new Refusal("unavailable");}}
export function createHubRoleCutover(options:RoleCutoverOptions){
 const{db,transport,current,refreshAuthorization}=options,hubId=validated(uuid,options.hubId),root=validated(person,options.root),{realm,generation}=options;
 const readTransportMethod=transport.read,mutateMethod=transport.mutate,readTransport=readTransportMethod.bind(transport),mutate=mutateMethod.bind(transport);
 const base=options.migrations.map(m=>Object.freeze({...m,up:m.up.bind(m)})),roleMigrations=[HUB_ROLE_WRITER_MIGRATION,HUB_ROLE_EXPIRY_MIGRATION,HUB_ROLE_CUTOVER_MIGRATION];
 if(base.some(m=>roleMigrations.some(r=>r.component===m.component)))throw new Refusal("unavailable");
 const full=[...base,...roleMigrations],clock=options.now??Date.now,elapsedClock=options.elapsedNow??(()=>performance.now());let closed=false,working=false,publishedEpoch:number|null=null;
 const now=()=>validated(epoch,clock());
 const live=()=>{if(closed||current()!==true||root.realm!==realm||transport.read!==readTransportMethod||transport.mutate!==mutateMethod)throw new Refusal("unavailable");};
 const rawPolicy=()=>{live();const row=db.prepare("SELECT hub_id,body FROM hub_group_policy WHERE singleton=1").get()as{hub_id:string;body:string}|undefined;
  const owner=db.prepare("SELECT hub_id FROM hub_instance WHERE singleton=1").get()as{hub_id:string}|undefined;
  if(!row||row.hub_id!==hubId||owner?.hub_id!==hubId||Buffer.byteLength(row.body,"utf8")>256*1024)throw new Refusal("unavailable");return row.body;};
 const hasMarkerTable=()=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hub_role_cutover'").get());
 const markerRaw=()=>{if(!hasMarkerTable())return null;const rows=db.prepare("SELECT body FROM hub_role_cutover").all()as{body:string}[];
  if(rows.length>1)throw new Refusal("unavailable");return rows[0]?.body??null;};
 const registry=()=>{const count=(db.prepare("SELECT COUNT(*) AS n FROM hub_schema WHERE component IN ('roles-writer','roles-expiry','roles-cutover')").get()as{n:number}).n;
  assertHubMigrationsCurrent(db,count?full:base);if(markerRaw()!==null&&!count)throw new Refusal("unavailable");};
 const readMarker=()=>{const raw=markerRaw();if(raw===null)return null;const m=validated(markerSchema,parseStrictJson(raw,512*1024));
  const old=parseGroupPolicy(parseStrictJson(m.oldRaw)),converted=convertGroupPolicy(old,{root:m.root,now:m.at,rolesActive:true});
  if(m.hubId!==hubId||m.root.realm!==m.realm||old.realm!==m.realm||old.generation!==m.generation||old.revision!==m.fromRevision||m.oldDigest!==sha(m.oldRaw)
   ||m.roleDigest!==sha(JSON.stringify(converted))||m.inventory.digest!==sha(JSON.stringify(m.inventory.tables))||m.transportRevision<1||m.authorizationVersion<1)throw new Refusal("unavailable");
  return{raw,marker:m};};
 const publish=(authorizationVersion:number)=>{live();if(publishedEpoch!==authorizationVersion){sync(refreshAuthorization());live();publishedEpoch=authorizationVersion;}};
 return{
  migrate():RoleCutoverResult{
   if(working||db.inTransaction)return{ok:false,code:"unavailable"};working=true;let committed=false;
   try{
    live();const started=now(),elapsedStart=elapsedClock();
    const guard=()=>{live();const t=elapsedClock();if(!Number.isFinite(t)||!Number.isFinite(elapsedStart)||elapsedStart<0||now()<started||t<elapsedStart||t>=elapsedStart+20_000)throw new Refusal("expired");};
    guard();registry();const existing=readMarker();
    if(existing){
     if(now()<existing.marker.at)throw new Refusal("expired");
     const p=parseRolePolicy(parseStrictJson(rawPolicy())),s=readTransport(),m=existing.marker;
     if(p.realm!==realm||p.generation!==generation||s.revision<m.transportRevision||s.revocationVersion<m.authorizationVersion
      ||p.realm===m.realm&&p.generation===m.generation&&p.revision<m.fromRevision)throw new Refusal("conflict");
     assertHubMigrationsCurrent(db,full);guard();publish(s.revocationVersion);return{ok:true,changed:false,revision:p.revision,epoch:s.revocationVersion};
    }
    const beforeRaw=rawPolicy(),before=parseGroupPolicy(parseStrictJson(beforeRaw));
    if(before.realm!==realm||before.generation!==generation)throw new Refusal("conflict");
    for(const table of ["hub_role_events","hub_role_notices","hub_role_root_self","hub_role_expiry_terms"]){
     if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)&&(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()as{n:number}).n)throw new Refusal("conflict");
    }
    const state=readTransport();if(state.revision===Number.MAX_SAFE_INTEGER||state.revocationVersion===Number.MAX_SAFE_INTEGER)throw new Refusal("conflict");
    const converted=convertGroupPolicy(before,{root,now:started,rolesActive:true}),serialized=JSON.stringify(converted),inventory=captureRoleCutoverInventory(db,transport,guard),requestId=randomUUID();
    const initial=()=>{guard();if(rawPolicy()!==beforeRaw||JSON.stringify(readTransport())!==JSON.stringify(state)||markerRaw()!==null)throw new Refusal("conflict");
     if(captureRoleCutoverInventory(db,transport,guard).digest!==inventory.digest)throw new Refusal("conflict");};
    initial();let exactMarker:string|null=null,auditId:string|null=null,auditImage:string|null=null;
    const expectedEpoch=state.revocationVersion+1,expectedRevision=state.revision+1;
    const final=(staged:boolean)=>{
     guard();assertHubMigrationsCurrent(db,full);
     const s=readTransport();if(s.revision!==expectedRevision||s.revocationVersion!==(staged?state.revocationVersion:expectedEpoch)||rawPolicy()!==serialized||markerRaw()!==exactMarker
      ||captureRoleCutoverInventory(db,transport,guard).digest!==inventory.digest)throw new Refusal("conflict");
     if(JSON.stringify(db.prepare("SELECT * FROM hub_audit WHERE id=?").get(auditId))!==auditImage)throw new Refusal("conflict");
     const recipients=db.prepare("SELECT person,acknowledged_at FROM hub_role_notices WHERE id=?").all(auditId);
     if(JSON.stringify(recipients)!==JSON.stringify([{person:`${root.realm}/${root.objectId}`,acknowledged_at:null}]))throw new Refusal("conflict");
     const e=db.prepare("SELECT body FROM hub_role_events WHERE id=?").get(auditId)as{body:string}|undefined;
     if(e?.body!==JSON.stringify({kind:"roles-available",accessChanged:false,roleDigest:sha(serialized),inventoryDigest:inventory.digest,fromRevision:before.revision}))throw new Refusal("conflict");
    };
    db.transaction(()=>{
     initial();applyHubMigrations(db,full);initial();
     mutate({at:started,requestId,actor:{kind:"local-host"},action:"role.migrated",result:"completed"},(s,owning)=>{
      if(owning!==db||!db.inTransaction||JSON.stringify(s)!==JSON.stringify(state))throw new Refusal("conflict");guard();
      if(db.prepare("UPDATE hub_group_policy SET body=? WHERE singleton=1 AND hub_id=? AND body=?").run(serialized,hubId,beforeRaw).changes!==1)throw new Refusal("conflict");
      s.revocationVersion++;
     },()=>{
      guard();const events=db.prepare("SELECT id,at,actor,result,policy_version,component_sequence FROM hub_audit WHERE request_id=? AND action='role.migrated'").all(requestId)as{id:string;at:number;actor:string;result:string;policy_version:number;component_sequence:number}[];
      if(events.length!==1||events[0]!.at!==started||events[0]!.actor!==JSON.stringify({kind:"local-host"})||events[0]!.result!=="completed"||events[0]!.policy_version!==expectedEpoch||events[0]!.component_sequence!==expectedRevision)throw new Refusal("unavailable");
      auditId=validated(uuid,events[0]!.id);auditImage=JSON.stringify(db.prepare("SELECT * FROM hub_audit WHERE id=?").get(auditId));
      const m=validated(markerSchema,{v:1,hubId,realm,generation,root,at:started,oldRaw:beforeRaw,oldDigest:sha(beforeRaw),roleDigest:sha(serialized),fromRevision:before.revision,
       transportRevision:expectedRevision,authorizationVersion:expectedEpoch,inventory,auditId});exactMarker=JSON.stringify(m);
      db.prepare("INSERT INTO hub_role_cutover VALUES(1,?)").run(exactMarker);
      db.prepare("INSERT INTO hub_role_events VALUES(?,?,?)").run(auditId,JSON.stringify({kind:"roles-available",accessChanged:false,roleDigest:sha(serialized),inventoryDigest:inventory.digest,fromRevision:before.revision}),started);
      db.prepare("INSERT INTO hub_role_notices(id,person) VALUES(?,?)").run(auditId,`${root.realm}/${root.objectId}`);final(true);
     });
     final(false);
    }).immediate();
    committed=true;publish(expectedEpoch);return{ok:true,changed:true,revision:converted.revision,epoch:expectedEpoch};
   }catch(error){return{ok:false,code:!committed&&error instanceof Refusal?error.code:"unavailable"};}finally{working=false;}
  },
  close(){closed=true;},
 };
}
