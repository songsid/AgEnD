/** Durable per-row owner intent/results; mutation receipts join the canonical writer's own transaction. */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { canonicalArguments, personKeyString, sha256 } from "../identity.js";
import { epoch, hash, identifier, plain, uuid, validated, HubProtocolError } from "../validation.js";
import { exposureRequestSchema, exposureRequestRefusalSchema, type HubExposureRequest } from "../agent-catalog-model.js";
import { hubLocalExposureSchema, type HubLocalExposure } from "../execution/service.js";
import type { PersonKey } from "../types.js";

export const HUB_SHARING_UNDO_MS = 24 * 60 * 60_000;
export const HUB_MEMBER_SHARING_MIGRATION = Object.freeze({ component:"s3c-hub-sharing",version:1,up(db:Database.Database) {
  db.exec(`CREATE TABLE hub_member_sharing_requests(id TEXT PRIMARY KEY,binding TEXT NOT NULL,notice_key TEXT UNIQUE NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX hub_member_sharing_binding ON hub_member_sharing_requests(binding);`);
} });
const outcomeSchema=z.union([z.strictObject({ok:z.literal(true)}),z.strictObject({ok:z.literal(false),code:exposureRequestRefusalSchema})]);
export const sharingPlanSchema=z.strictObject({action:z.enum(["share","stop"]),target:plain(128),agent:identifier.nullable(),
  name:plain(256),kind:z.enum(["agent","classic-room"]),incarnation:hash.nullable(),before:hubLocalExposureSchema.nullable()});
const rowSchema=sharingPlanSchema.extend({after:hubLocalExposureSchema.nullable(),outcome:outcomeSchema.nullable(),
  undoAfter:hubLocalExposureSchema.nullable(),undoOutcome:outcomeSchema.nullable()});
const recordSchema=z.strictObject({id:uuid,binding:plain(512),noticeKey:hash,request:exposureRequestSchema,requestDigest:hash,
  receivedAt:epoch,noticeAt:epoch.nullable(),undoUntil:epoch.nullable(),noticeDurable:z.boolean(),finalNoticeDurable:z.boolean(),
  rows:z.array(rowSchema).min(1).max(64),resultAcked:z.boolean(),undoId:uuid.nullable(),undoAt:epoch.nullable(),undoActor:plain(256).nullable(),undoAcked:z.boolean(),undoNoticeDurable:z.boolean()});
export type SharingPlan=z.infer<typeof sharingPlanSchema>;
export type SharingOutcome=z.infer<typeof outcomeSchema>;
export type SharingRecord=z.infer<typeof recordSchema>;
interface Raw {id:string;notice_key:string;binding:string;body:string;digest:string}

export class HubMemberSharingJournal {
  constructor(private readonly options:{db:Database.Database;binding:string;owner:PersonKey;fleetId:string;agentToken(agent:string):string|null;current():boolean;now():number}) {}
  private current():void {if(!this.options.current())throw new HubProtocolError("stale");}
  private decode(raw:Raw):SharingRecord {
    if(raw.binding!==this.options.binding)throw new HubProtocolError("denied");
    try {
      if(sha256(raw.body)!==raw.digest)throw Error("digest");
      const r=validated(recordSchema,JSON.parse(raw.body));
      if(r.id!==raw.id||r.noticeKey!==raw.notice_key||r.noticeKey!==sha256(canonicalArguments([r.binding,r.id]))||r.binding!==raw.binding||sha256(canonicalArguments(r.request))!==r.requestDigest||personKeyString(r.request.by)!==personKeyString(this.options.owner))throw Error("binding");
      return r;
    }catch{throw new HubProtocolError("uncertain");}
  }
  private save(r:SharingRecord):void {
    this.current();validated(recordSchema,r);const body=canonicalArguments(r);
    if(this.options.db.prepare("UPDATE hub_member_sharing_requests SET body=?,digest=?,updated_at=? WHERE id=? AND binding=?").run(body,sha256(body),this.options.now(),r.id,this.options.binding).changes!==1)throw new HubProtocolError("stale");
  }
  read(id:string):SharingRecord|null {
    this.current();validated(uuid,id);
    const raw=this.options.db.prepare("SELECT id,notice_key,binding,body,digest FROM hub_member_sharing_requests WHERE id=?").get(id) as Raw|undefined;
    return raw&&raw.binding===this.options.binding?this.decode(raw):null;
  }
  byNotice(key:string):SharingRecord|null {
    this.current();validated(hash,key);
    const raw=this.options.db.prepare("SELECT id,notice_key,binding,body,digest FROM hub_member_sharing_requests WHERE notice_key=? AND binding=?").get(key,this.options.binding) as Raw|undefined;
    return raw?this.decode(raw):null;
  }
  private edit<T>(id:string,work:(record:SharingRecord)=>T):T {
    const change=()=>{this.current();const r=this.read(id);if(!r)throw new HubProtocolError("not-found");const result=work(r);this.save(r);return result;};
    return this.options.db.inTransaction?change():this.options.db.transaction(change).immediate();
  }
  reserve(id:string,input:HubExposureRequest,plans:SharingPlan[],refusal?:z.infer<typeof exposureRequestRefusalSchema>):SharingRecord {
    this.current();validated(uuid,id);const request=validated(exposureRequestSchema,input),now=this.options.now();
    if(personKeyString(request.by)!==personKeyString(this.options.owner))throw new HubProtocolError("denied");
    return this.options.db.transaction(()=>{
      const raw=this.options.db.prepare("SELECT id,notice_key,binding,body,digest FROM hub_member_sharing_requests WHERE id=?").get(id) as Raw|undefined;
      if(raw){const r=this.decode(raw);if(r.requestDigest!==sha256(canonicalArguments(request)))throw new HubProtocolError("conflict");return r;}
      if(now>=request.expiresAt||request.createdAt>now+30_000)throw new HubProtocolError("expired");
      const targets=[...request.share.map(target=>({action:"share",target})),...request.stop.map(target=>({action:"stop",target}))];
      const checked=plans.map(p=>validated(sharingPlanSchema,p));
      if(checked.length!==targets.length||checked.some((p,i)=>p.action!==targets[i]!.action||p.target!==targets[i]!.target))throw new HubProtocolError("invalid");
      for(const p of checked)if(p.before&&(personKeyString(p.before.exposure.owner)!==personKeyString(request.by)||p.before.exposure.fleetId!==this.options.fleetId||p.before.agent!==p.agent))throw new HubProtocolError("denied");
      if((this.options.db.prepare("SELECT count(*) n FROM hub_member_sharing_requests WHERE binding=?").get(this.options.binding) as {n:number}).n>=512)throw new HubProtocolError("backpressure");
      const r:SharingRecord={id,binding:this.options.binding,noticeKey:sha256(canonicalArguments([this.options.binding,id])),request,requestDigest:sha256(canonicalArguments(request)),receivedAt:now,
        noticeAt:null,undoUntil:null,noticeDurable:false,finalNoticeDurable:false,resultAcked:false,undoId:null,undoAt:null,undoActor:null,undoAcked:false,undoNoticeDurable:false,
        rows:checked.map(p=>({...p,after:null,outcome:refusal?{ok:false,code:validated(exposureRequestRefusalSchema,refusal)}:null,undoAfter:null,undoOutcome:null}))};
      const body=canonicalArguments(validated(recordSchema,r));this.current();
      this.options.db.prepare("INSERT INTO hub_member_sharing_requests VALUES(?,?,?,?,?,?)").run(id,this.options.binding,r.noticeKey,body,sha256(body),now);return r;
    }).immediate();
  }
  prepareNotice(id:string):SharingRecord {
    this.edit(id,r=>{if(r.noticeAt===null){r.noticeAt=this.options.now();r.undoUntil=r.noticeAt+HUB_SHARING_UNDO_MS;}});return this.read(id)!;
  }
  noticeSaved(id:string):void {this.edit(id,r=>{if(r.noticeAt===null)throw new HubProtocolError("conflict");r.noticeDurable=true;});}
  noticeRefused(id:string):void {this.edit(id,r=>{if(!r.noticeDurable){r.noticeAt=null;r.undoUntil=null;}});}
  finalNoticeSaved(id:string):void {this.edit(id,r=>{if(r.rows.some(row=>row.outcome===null))throw new HubProtocolError("conflict");r.finalNoticeDurable=true;});}
  private committed(id:string,index:number,next:HubLocalExposure,undo:boolean):undefined {
    if(!this.options.db.inTransaction)throw Error("A sharing receipt requires the exposure writer transaction");
    this.edit(id,r=>{
      const row=r.rows[index];if(!row||!r.noticeDurable||row[undo?"undoOutcome":"outcome"]!==null)throw new HubProtocolError("conflict");
      if(!undo&&this.options.now()>=r.request.expiresAt)throw new HubProtocolError("expired");
      if(undo&&(!r.undoId||r.undoUntil===null||this.options.now()>=r.undoUntil||row.outcome?.ok!==true))throw new HubProtocolError("expired");
      if(!row.agent||!row.incarnation||this.options.agentToken(row.agent)!==row.incarnation)throw new HubProtocolError("stale");
      const before=undo?row.after:row.before;
      const after=validated(hubLocalExposureSchema,next);
      if(after.agent!==row.agent||after.exposure.fleetId!==this.options.fleetId||personKeyString(after.exposure.owner)!==personKeyString(this.options.owner)
        ||after.exposure.revision!==(before?.exposure.revision??0)+1||(before&&after.exposure.id!==before.exposure.id))throw new HubProtocolError("conflict");
      const expected=(row.action==="share")!==undo?"published":"withdrawn";
      const stored=this.options.db.prepare("SELECT committed FROM hub_exposures WHERE id=?").get(after.exposure.id) as {committed:string}|undefined;
      if(after.exposure.state!==expected||!stored||canonicalArguments(JSON.parse(stored.committed))!==canonicalArguments(after))throw new HubProtocolError("conflict");
      if(undo){row.undoAfter=after;row.undoOutcome={ok:true};}else{row.after=after;row.outcome={ok:true};}
    });return undefined;
  }
  applied(id:string,index:number,next:HubLocalExposure):undefined {return this.committed(id,index,next,false);}
  undone(id:string,index:number,next:HubLocalExposure):undefined {return this.committed(id,index,next,true);}
  refuse(id:string,index:number,code:z.infer<typeof exposureRequestRefusalSchema>,undo=false):void {
    validated(exposureRequestRefusalSchema,code);
    this.edit(id,r=>{const row=r.rows[index];if(!row)throw new HubProtocolError("invalid");const key=undo?"undoOutcome":"outcome";
      if(row[key]!==null){if(row[key]?.ok===false&&row[key].code===code)return;throw new HubProtocolError("conflict");}row[key]={ok:false,code};});
  }
  beginUndo(id:string,actor:string):SharingRecord {
    this.edit(id,r=>{if(r.undoId)return;if(!r.rows.some(row=>row.outcome?.ok===true))throw new HubProtocolError("denied");if(!r.noticeDurable||!r.finalNoticeDurable||r.undoUntil===null||this.options.now()>=r.undoUntil)throw new HubProtocolError("expired");
      r.undoId=randomUUID();r.undoAt=this.options.now();r.undoActor=validated(plain(256),actor);});return this.read(id)!;
  }
  undoNoticeSaved(id:string):void {this.edit(id,r=>{if(!r.undoId||r.rows.some(row=>row.outcome?.ok===true&&row.undoOutcome===null))throw new HubProtocolError("conflict");r.undoNoticeDurable=true;});}
  acknowledge(id:string,undo=false):void {
    this.edit(id,r=>{if(undo){if(!r.undoId||!r.undoNoticeDurable||r.rows.some(row=>row.outcome?.ok===true&&row.undoOutcome===null))throw new HubProtocolError("conflict");r.undoAcked=true;}
      else {if(!r.finalNoticeDurable)throw new HubProtocolError("conflict");r.resultAcked=true;}});
  }
  pending():SharingRecord[] {
    this.current();return (this.options.db.prepare("SELECT id,notice_key,binding,body,digest FROM hub_member_sharing_requests WHERE binding=? ORDER BY updated_at LIMIT 512").all(this.options.binding) as Raw[])
      .map(raw=>this.decode(raw)).filter(r=>!r.resultAcked||!!r.undoId&&!r.undoAcked);
  }
  prune():void {
    this.current();this.options.db.transaction(()=>{for(const raw of this.options.db.prepare("SELECT id,notice_key,binding,body,digest FROM hub_member_sharing_requests WHERE binding=?").all(this.options.binding) as Raw[]){
      const r=this.decode(raw);if(this.options.now()>=(r.undoUntil??r.receivedAt+HUB_SHARING_UNDO_MS))this.options.db.prepare("DELETE FROM hub_member_sharing_requests WHERE id=? AND binding=?").run(r.id,this.options.binding);
    }}).immediate();
  }
}
