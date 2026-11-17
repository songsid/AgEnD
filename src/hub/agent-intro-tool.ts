/** Negotiated member edits and an owner's single persistent introduction notice. */
import type Database from "better-sqlite3";
import {agentIntro,normalizeAgentIntro} from "./agent-intro.js";
import {agentIntroSchema,HUB_AGENT_INTRO_CAPABILITY,type HubAgentIntroResult} from "./agent-intro-model.js";
import {readExposure} from "./catalog.js";
import {personKeyString} from "./identity.js";
import type {HubCore} from "./http/core.js";
import type {HubLinkContext} from "./server.js";
import type {HubRequestContext} from "./types.js";
import {HubProtocolError} from "./validation.js";
export const HUB_AGENT_INTRO_TOOL_MIGRATION=Object.freeze({component:"s3-agent-intro-tool",version:1,up(db:Database.Database){db.exec(`
 CREATE TABLE hub_agent_intro_changes(exposure_id TEXT NOT NULL REFERENCES hub_exposures(id) ON DELETE CASCADE,day INTEGER NOT NULL,changes INTEGER NOT NULL,PRIMARY KEY(exposure_id,day));
 CREATE TABLE hub_agent_intro_operations(fleet_id TEXT NOT NULL,operation_id TEXT NOT NULL,input TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(fleet_id,operation_id));
 CREATE TABLE hub_agent_intro_existing(exposure_id TEXT PRIMARY KEY REFERENCES hub_exposures(id) ON DELETE CASCADE);
 INSERT INTO hub_agent_intro_existing SELECT id FROM hub_exposures WHERE source_kind='fleet' AND state!='withdrawn' AND NOT EXISTS(SELECT 1 FROM hub_agent_intros i WHERE i.exposure_id=hub_exposures.id);
 CREATE TABLE hub_agent_intro_notices(owner TEXT PRIMARY KEY,batches TEXT NOT NULL,acknowledged_at INTEGER,seen INTEGER NOT NULL DEFAULT 0);
`);}});
interface IntroNoticeBatch{fleetId:string;fleet:string|null;more:boolean;agents:{id:string;name:string}[]}
export class HubAgentIntroTool {
 constructor(private core:HubCore){}
 receive(raw:unknown,link:HubLinkContext,operationId:string):HubAgentIntroResult {
  if(!link.current())return {ok:false,code:"stale"};
  if(!link.features.has(HUB_AGENT_INTRO_CAPABILITY))return {ok:false,code:"unsupported"};
  const parsed=agentIntroSchema.safeParse(raw);if(!parsed.success)return {ok:false,code:"invalid"};
  let text:string;try{text=normalizeAgentIntro(parsed.data.text);}catch{return {ok:false,code:"invalid"};}
  const value={...parsed.data,text},input=JSON.stringify(value),owner=personKeyString(link.owner);
  return this.core.atomic((db,tx)=>{
   const e=readExposure(db,value.exposureId);
   if(!link.current()||!e||e.owner!==owner||e.fleet_id!==link.fleetId||e.state==='withdrawn'||e.revision!==value.revision)return {ok:false,code:"denied"};
   const previous=db.prepare("SELECT input,result FROM hub_agent_intro_operations WHERE fleet_id=? AND operation_id=?").get(link.fleetId,operationId) as {input:string;result:string}|undefined;
   if(previous)return previous.input===input?JSON.parse(previous.result) as HubAgentIntroResult:{ok:false,code:"invalid"};
   const now=this.core.now(),old=agentIntro(db,e.id),exists=old.introBy!==undefined,changed=!(value.source==="default"&&exists)&&(!exists||old.intro!==text);
   const day=Math.floor(now/86400000),row=db.prepare("SELECT changes FROM hub_agent_intro_changes WHERE exposure_id=? AND day=?").get(e.id,day) as {changes:number}|undefined;
   if(changed&&value.source==="agent"&&(row?.changes??0)>=5)return {ok:false,code:"limit",resetsAt:(day+1)*86400000};
   if(changed){
    db.prepare("INSERT INTO hub_agent_intros(exposure_id,text,source,updated_at) VALUES(?,?,?,?) ON CONFLICT(exposure_id) DO UPDATE SET text=excluded.text,source=excluded.source,updated_at=excluded.updated_at").run(e.id,text,value.source,now);
    if(value.source==="agent")db.prepare("INSERT INTO hub_agent_intro_changes VALUES(?,?,1) ON CONFLICT(exposure_id,day) DO UPDATE SET changes=changes+1").run(e.id,day);
    if(value.source==="default"&&text&&db.prepare("SELECT 1 FROM hub_agent_intro_existing WHERE exposure_id=?").get(e.id)){
     const n=db.prepare("SELECT batches,acknowledged_at,seen FROM hub_agent_intro_notices WHERE owner=?").get(owner) as {batches:string;acknowledged_at:number|null;seen:number}|undefined;
     const batches:IntroNoticeBatch[]=n&&n.acknowledged_at===null?JSON.parse(n.batches):[];
     let batch=batches.find(b=>b.fleetId===link.fleetId);
     if(!batch){batch={fleetId:link.fleetId,fleet:this.core.deps.store.read().fleets.find(f=>f.id===link.fleetId)?.label??null,more:!!n&&(n.seen===1||batches.length>0),agents:[]};batches.push(batch);}
     if(!batch.agents.some(a=>a.id===e.id))batch.agents.push({id:e.id,name:e.display_name});
     db.prepare("INSERT INTO hub_agent_intro_notices(owner,batches) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET batches=excluded.batches,acknowledged_at=NULL").run(owner,JSON.stringify(batches));
    }
    this.core.audit(tx,{requestId:operationId,actor:{kind:"member",fleetId:link.fleetId},action:"agent.intro-updated",result:"completed",exposureId:e.id,ownerAtEvent:link.owner});
   }
   const result={ok:true as const,...agentIntro(db,e.id),changed} as HubAgentIntroResult;
   db.prepare("INSERT INTO hub_agent_intro_operations VALUES(?,?,?,?)").run(link.fleetId,operationId,input,JSON.stringify(result));
   db.prepare("DELETE FROM hub_agent_intro_changes WHERE exposure_id=? AND day<?").run(e.id,day-1);
   return result;
  });
 }
 async notice(ctx:HubRequestContext){
  const owner=personKeyString(await ctx.requirePerson());
  return this.core.atomic(db=>{
   const row=db.prepare("SELECT batches FROM hub_agent_intro_notices WHERE owner=? AND acknowledged_at IS NULL").get(owner) as {batches:string}|undefined;
   return {notice:row?{id:"agent-introductions",batches:JSON.parse(row.batches) as IntroNoticeBatch[]}:null};
  });
 }
 async acknowledge(ctx:HubRequestContext){const owner=personKeyString(await ctx.requirePerson());this.core.atomic(db=>{if(ctx.isCurrent&&!ctx.isCurrent())throw new HubProtocolError("revoked");db.prepare("UPDATE hub_agent_intro_notices SET acknowledged_at=?,seen=1 WHERE owner=?").run(this.core.now(),owner);});return {ok:true};}
}
