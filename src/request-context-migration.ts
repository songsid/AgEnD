/** Read-only migration shadow. No context, decision, normalization, admission or authority is created. */
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { ContactPerson } from "./contact-auth-types.js";
import { requestContextDigest } from "./request-context-store.js";
export interface RequestMigrationHost {
  owner(): string | null;
  policyEpoch(): string | null;
  generation(instance: string): string | null;
  canManage(instance: string, person: ContactPerson): boolean;
}
export interface RequestMigrationCursor { tickets?: string | null; policies?: string | null; origins?: string | null }
export interface RequestMigrationOptions { limit?: number; cursor?: RequestMigrationCursor; now?: number }
export interface RequestMigrationEntry {
  id: string; sha256: string | null; disposition: string; state?: string; storedState?: string; deliveryState?: string;
  grants?: Array<{ id: string; sha256: string; disposition: string }>;
}
export interface RequestMigrationSnapshot {
  version: 1; readOnly: true; page: {limit:number;cursor:RequestMigrationCursor}; owner: string | null; policyEpoch: string | null; complete: boolean; truncated: boolean;
  tickets: RequestMigrationEntry[]; policies: RequestMigrationEntry[]; origins: RequestMigrationEntry[];
  nextCursor: RequestMigrationCursor | null; blockers: Array<{id:string;reason:string}>; sha256: string;
}
const hash=(value:string):string=>createHash("sha256").update(value).digest("hex");
/** M-3897: the dispositions an owner may retire (nothing here can settle them; absence is never proof of delivery). */
export const RETIRABLE_LEGACY_DISPOSITIONS:readonly string[]=["legacy-unconfirmed","missing-receipt","malformed"];
/** M-3897: an earlier ticket's exact stored image, as the shadow digests it; a retirement binds to it (a changed row is not retired). */
export function legacyTicketDigest(row:{id:string;request_json:string;ticket_json:string;operation_key:string;request_hash:string;created_at:number}):string{
  return requestContextDigest({id:row.id,request_json:row.request_json,ticket_json:row.ticket_json,operation_key:row.operation_key,request_hash:row.request_hash,created_at:row.created_at});
}
const record=(v:unknown):v is Record<string,any>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const text=(v:unknown):v is string=>typeof v==="string"&&v.length>0&&v.length<=256&&!/[\x00-\x1f\x7f]/.test(v);
const person=(v:unknown):v is ContactPerson=>record(v)&&["discord","telegram","host"].includes(v.platform)&&text(v.userId)&&text(v.adapterId)&&typeof v.label==="string"&&(v.platform!=="host"||v.userId==="operator"&&v.adapterId==="host");
const verbs=new Set(["send_to_instance","delegate_task","request_information","broadcast","report_result"]);
/** A fresh page is a read transaction; incomplete pages can never be treated as a migration plan. */
export class RequestContextMigrationShadow {
  constructor(private readonly db:Database.Database,private readonly host:RequestMigrationHost){}
  private has(table:string):boolean{return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);}
  private page<T>(sql:string,after:string,limit:number):{rows:T[];more:boolean} {
    const rows:T[]=[];let bytes=0,more=false;
    for(const row of this.db.prepare(sql).iterate(after,limit+1)){
      const size=Buffer.byteLength(JSON.stringify(row));
      if(rows.length>=limit||bytes+size>16*1024*1024){more=true;break;}
      rows.push(row as T);bytes+=size;
    }
    return {rows,more};
  }
  private grant(raw:unknown,target:string,policyGeneration:unknown,now:number):string {
    if(!record(raw)||!text(raw.id)||!text(raw.source)||raw.target!==target||!person(raw.person)||!person(raw.createdBy)
      ||!Array.isArray(raw.verbs)||!raw.verbs.length||raw.verbs.some((v:unknown)=>typeof v!=="string"||!verbs.has(v))
      ||!Number.isFinite(Date.parse(raw.expiresAt))||!Number.isFinite(Date.parse(raw.createdAt))||raw.remainingUses!==null&&(!Number.isInteger(raw.remainingUses)||raw.remainingUses<0||raw.remainingUses>10000))return "malformed";
    if(Date.parse(raw.expiresAt)<=now)return "expired";
    if(raw.remainingUses===0)return "spent";
    try{
      const source=this.host.generation(raw.source),currentTarget=this.host.generation(target);
      if(!source||!currentTarget)return "unavailable";
      if(raw.sourceGeneration!==source||raw.targetGeneration!==currentTarget||policyGeneration!==currentTarget)return "stale-generation";
      return this.host.canManage(target,raw.createdBy)?"live":"manager-revoked";
    }catch{return "unavailable";}
  }
  inspect(options:RequestMigrationOptions={}):RequestMigrationSnapshot {
    const limit=options.limit??10000,cursor=options.cursor??{},now=options.now??Date.now();
    if(!Number.isInteger(limit)||limit<1||limit>10000||!Number.isFinite(now)||Object.keys(cursor).some(k=>!["tickets","policies","origins"].includes(k))
      ||Object.values(cursor).some(v=>v!==null&&!text(v)))throw Error("invalid migration shadow page");
    return this.db.transaction(()=>{
      const writes=(this.db.prepare("SELECT total_changes() AS n").get() as {n:number}).n;
      const owner=this.host.owner(),policyEpoch=this.host.policyEpoch();let complete=!!owner&&!!policyEpoch,truncated=false;
      const next:RequestMigrationCursor={tickets:null,policies:null,origins:null},tickets:RequestMigrationEntry[]=[],policies:RequestMigrationEntry[]=[],origins:RequestMigrationEntry[]=[];
      if(cursor.tickets!==null&&this.has("contact_auth_tickets")){
        const scoped=this.has("request_context_contacts_v1");
        // Oversized/corrupt rows are explicitly incomplete without loading an unbounded body.
        const page=this.page<{id:string;request_json:string|null;ticket_json:string|null;operation_key:string;request_hash:string;created_at:number}>(`SELECT t.id,CASE WHEN length(CAST(t.request_json AS BLOB))+length(CAST(t.ticket_json AS BLOB))<=262144 THEN t.request_json END AS request_json,
          CASE WHEN length(CAST(t.request_json AS BLOB))+length(CAST(t.ticket_json AS BLOB))<=262144 THEN t.ticket_json END AS ticket_json,
          t.operation_key,t.request_hash,t.created_at FROM contact_auth_tickets t ${scoped?"LEFT JOIN request_context_contacts_v1 c ON c.ticket_id=t.id":""}
          WHERE t.id>? ${scoped?"AND c.ticket_id IS NULL":""} ORDER BY t.id LIMIT ?`,cursor.tickets??"",limit),rows=page.rows;
        if(page.more){truncated=true;next.tickets=rows.at(-1)?.id??cursor.tickets??"";}
        // M-3897: an owner's retirement of this exact image (append-only; a changed row is not covered by it).
        const retired=this.has("contact_auth_retirements")?new Set((this.db.prepare("SELECT ticket_id,ticket_sha256 FROM contact_auth_retirements").all() as {ticket_id:string;ticket_sha256:string}[]).map(r=>`${r.ticket_id}\n${r.ticket_sha256}`)):new Set<string>();
        for(const row of rows.slice(0,limit)){
          const digest=row.request_json===null||row.ticket_json===null?null:legacyTicketDigest(row as {id:string;request_json:string;ticket_json:string;operation_key:string;request_hash:string;created_at:number});
          const entry:RequestMigrationEntry={id:row.id,sha256:digest,disposition:"malformed"};
          let unreadable=false;
          try{
            if(!row.request_json||!row.ticket_json)throw Error("oversized row");
            const request=JSON.parse(row.request_json),ticket=JSON.parse(row.ticket_json);
            if(!record(request)||!record(ticket)||request.requestContext||ticket.requestContext||ticket.id!==row.id
              ||!text(request.operationId)||request.source!==ticket.source||request.target!==ticket.target
              ||request.verb!==ticket.verb||row.operation_key!==JSON.stringify([request.source,request.operationId,request.target,request.verb])
              ||!["pending","approved","delivered","declined","expired","unknown"].includes(ticket.state)||!Number.isFinite(Date.parse(ticket.expiresAt)))throw Error("invalid legacy ticket");
            entry.storedState=ticket.state;entry.state=ticket.state==="pending"&&Date.parse(ticket.expiresAt)<=now?"expired":ticket.state;
            if(entry.state==="pending")entry.disposition="preserve-legacy-pending";
            else if(entry.state==="declined"||entry.state==="expired")entry.disposition="preserve-terminal";
            else if(text(ticket.deliveryId)){
              const delivery=this.db.prepare("SELECT state,source_instance,target_instance,operation_id FROM deliveries WHERE delivery_id=?").get(ticket.deliveryId) as {state:string;source_instance:string;target_instance:string;operation_id:string}|undefined;
              if(!delivery||delivery.source_instance!==request.source||delivery.target_instance!==request.target||delivery.operation_id!==request.operationId)entry.disposition="missing-receipt";
              else{entry.deliveryState=delivery.state;entry.disposition=["delivered","failed","cancelled"].includes(delivery.state)?"preserve-receipt":["queued","delivering","submission_started","retry_wait"].includes(delivery.state)?"legacy-inflight":"legacy-unconfirmed";}
            }else entry.disposition="missing-receipt";
          }catch{unreadable=true;}
          if(digest&&RETIRABLE_LEGACY_DISPOSITIONS.includes(entry.disposition)&&retired.has(`${row.id}\n${digest}`))entry.disposition="retired-unknown";
          else if(unreadable)complete=false;
          tickets.push(entry);
        }
      }
      if(cursor.policies!==null&&this.has("contact_auth_policies")){
        const page=this.page<{instance:string;revision:number;policy_json:string|null}>("SELECT instance,revision,CASE WHEN length(CAST(policy_json AS BLOB))<=262144 THEN policy_json END AS policy_json FROM contact_auth_policies WHERE instance>? ORDER BY instance LIMIT ?",cursor.policies??"",limit),rows=page.rows;
        if(page.more){truncated=true;next.policies=rows.at(-1)?.instance??cursor.policies??"";}
        for(const row of rows.slice(0,limit)){
          const entry:RequestMigrationEntry={id:row.instance,sha256:row.policy_json===null?null:requestContextDigest(row),disposition:"preserve-policy"};
          try{
            if(!row.policy_json)throw Error("oversized policy");const policy=JSON.parse(row.policy_json);
            if(!record(policy)||policy.revision!==row.revision||!Array.isArray(policy.grants)||policy.grants.length>100)throw Error("invalid policy");
            entry.grants=policy.grants.map((grant:unknown)=>({id:record(grant)&&typeof grant.id==="string"?grant.id:"invalid",sha256:requestContextDigest(grant),disposition:this.grant(grant,row.instance,policy.generation,now)}));
            if(entry.grants!.some(grant=>["malformed","unavailable"].includes(grant.disposition)))complete=false;
          }catch{entry.disposition="malformed";complete=false;}
          policies.push(entry);
        }
      }
      if(cursor.origins!==null&&this.has("contact_auth_origins")){
        const page=this.page<{instance:string;origin_json:string|null}>("SELECT instance,CASE WHEN length(CAST(origin_json AS BLOB))<=32768 THEN origin_json END AS origin_json FROM contact_auth_origins WHERE instance>? ORDER BY instance LIMIT ?",cursor.origins??"",limit),rows=page.rows;
        if(page.more){truncated=true;next.origins=rows.at(-1)?.instance??cursor.origins??"";}
        for(const row of rows.slice(0,limit)){if(row.origin_json===null)complete=false;origins.push({id:row.instance,sha256:row.origin_json===null?null:hash(row.origin_json),disposition:"history-only"});}
      }
      if(owner!==this.host.owner()||policyEpoch!==this.host.policyEpoch()||(this.db.prepare("SELECT total_changes() AS n").get() as {n:number}).n!==writes)complete=false;
      const blockers=tickets.filter(row=>!["preserve-terminal","preserve-receipt","retired-unknown"].includes(row.disposition)).map(row=>({id:row.id,reason:row.disposition==="malformed"?"legacy-ticket-unreadable":"legacy-decision-input-unsupported"}));
      const result={version:1 as const,readOnly:true as const,page:{limit,cursor},owner,policyEpoch,complete:complete&&!truncated&&!Object.keys(cursor).length,truncated,tickets,policies,origins,blockers,nextCursor:Object.values(next).some(value=>value!==null)?next:null};
      return {...result,sha256:requestContextDigest(result)};
    })();
  }
  unchanged(previous:RequestMigrationSnapshot,options:RequestMigrationOptions={}):boolean {
    const current=this.inspect({...previous.page,...options});return previous.complete&&current.complete&&previous.sha256===current.sha256;
  }
}
