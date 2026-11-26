import {requestHumanInputBlockers} from "./request-context-human.js";
import {requestContextReturnBlockers} from "./request-context-returns.js";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertRequestContextRootOpen, type RequestContextDrainView, type RequestContextRegistrationGate } from "./request-context-fence.js";
import { RequestContextStore } from "./request-context-store.js";
const ROOT=z.uuid();
export const REQUEST_CONTEXT_DRAIN_FAMILIES=["turns","daemon-calls","fleet-calls","native-exec","native-grants","pane-proofs","pane-ledgers","registered-work"]as const;
export type RequestContextDrainFamily=typeof REQUEST_CONTEXT_DRAIN_FAMILIES[number];
export interface RequestContextDrainParticipant {
  registration:RequestContextRegistrationGate;
  revision():string;
  inspect(rootId:string):RequestContextDrainView;
}
export interface RequestContextRetirementProof { rootId:string; epoch:string; current():boolean }
/** Owner assembly only. No production constructor or tool/API route installs this before cutover. */
export class RequestContextDrain {
  private readonly registrations=new Set<RequestContextRegistrationGate>();
  private readonly participants=new Map<string,{family:RequestContextDrainFamily;value:RequestContextDrainParticipant}>();
  private membership=0;
  private readonly usedRegistrations=new Set<RequestContextRegistrationGate>();
  constructor(private readonly db:Database.Database,private readonly ready:()=>void,private readonly owner:()=>string|null){}
  registration():RequestContextRegistrationGate {
    const registration=Object.freeze({assertRegistration:(rootId:string)=>{ROOT.parse(rootId);this.ready();assertRequestContextRootOpen(this.db,rootId);if(!this.usedRegistrations.has(registration)){this.usedRegistrations.add(registration);this.membership++;}}});
    this.registrations.add(registration);return registration;
  }
  register(family:RequestContextDrainFamily,id:string,participant:RequestContextDrainParticipant):()=>void {
    if(!REQUEST_CONTEXT_DRAIN_FAMILIES.includes(family)||!id||id.length>256||!this.registrations.has(participant.registration))throw Error("request-context drain participant is not owned");
    const key=JSON.stringify([family,id]);if(this.participants.has(key))throw Error("request-context drain participant already registered");
    const row={family,value:participant};this.participants.set(key,row);this.membership++;
    return ()=>{if(this.participants.get(key)===row){this.participants.delete(key);this.membership++;}};
  }
  fence(rootId:string):string {
    ROOT.parse(rootId);this.ready();
    return this.db.transaction(()=>{
      const context=new RequestContextStore(this.db).context(rootId),owner=this.owner();
      if(!owner||!context||context.ref.rootContextId!==rootId||context.ref.parentContextId)throw Error("request-context drain root unavailable");
      this.db.exec("CREATE TABLE IF NOT EXISTS request_context_drain_v1(root_id TEXT PRIMARY KEY,epoch TEXT NOT NULL,owner TEXT NOT NULL)");
      if(this.db.prepare("SELECT 1 FROM request_context_drain_v1 WHERE root_id=?").get(rootId))throw Error("request-context root already fenced");
      const epoch=randomUUID();this.db.prepare("INSERT INTO request_context_drain_v1 VALUES (?,?,?)").run(rootId,epoch,owner);return epoch;
    })();
  }
  /** owner() is the durable Fleet identity while its exclusive coordinator lease is current.
   * A fresh process must explicitly rotate the retained epoch; a retired tombstone cannot resume. */
  resume(rootId:string,previousEpoch:string):string {
    ROOT.parse(rootId);ROOT.parse(previousEpoch);this.ready();
    return this.db.transaction(()=>{
      const context=new RequestContextStore(this.db).context(rootId),owner=this.owner();
      if(!owner||!context||context.ref.rootContextId!==rootId||context.ref.parentContextId)throw Error("request-context drain root unavailable");
      const epoch=randomUUID();
      if(this.db.prepare("UPDATE request_context_drain_v1 SET epoch=? WHERE root_id=? AND epoch=? AND owner=?").run(epoch,rootId,previousEpoch,owner).changes!==1)throw Error("request-context drain owner or epoch changed");
      return epoch;
    })();
  }
  release(rootId:string,epoch:string):void {
    this.ready();this.db.transaction(()=>{
      const context=new RequestContextStore(this.db).context(rootId);
      // A retired root keeps its tombstone; a stale input can never recreate it after collection.
      if(!context||context.ref.rootContextId!==rootId)throw Error("request-context retired root cannot reopen");
      if(this.db.prepare("DELETE FROM request_context_drain_v1 WHERE root_id=? AND epoch=? AND owner=?").run(rootId,epoch,this.owner()).changes!==1)throw Error("request-context drain owner changed");
    })();
  }
  private fenced(rootId:string,epoch:string,owner:string):boolean {
    return !!this.db.prepare("SELECT 1 FROM request_context_drain_v1 WHERE root_id=? AND epoch=? AND owner=?").get(rootId,epoch,owner);
  }
  private durable(rootId:string):string[] {
    const blockers:string[]=[...requestContextReturnBlockers(this.db,rootId),...requestHumanInputBlockers(this.db,rootId)];
    const exists=(table:string)=>!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if(!exists("request_contexts_v1"))return ["context-store-unavailable"];
    const contexts="SELECT context_id FROM request_contexts_v1 WHERE json_extract(context_json,'$.ref.rootContextId')=?";
    if(exists("request_context_operations_v1")){
      const rows=this.db.prepare(`SELECT d.delivery_id FROM deliveries d JOIN request_context_operations_v1 o ON o.delivery_id=d.delivery_id WHERE o.context_id IN (${contexts}) AND d.state NOT IN ('delivered','failed','cancelled') LIMIT 65`).all(rootId)as Array<{delivery_id:string}>;
      blockers.push(...rows.map(row=>`delivery:${row.delivery_id}`));
    }
    if(exists("request_context_contacts_v1")){
      const rows=this.db.prepare("SELECT c.ticket_id FROM request_context_contacts_v1 c JOIN contact_auth_tickets t ON t.id=c.ticket_id WHERE c.root_id=? AND json_extract(t.ticket_json,'$.state')='pending' AND (julianday(json_extract(t.ticket_json,'$.expiresAt')) IS NULL OR julianday(json_extract(t.ticket_json,'$.expiresAt'))>julianday('now')) LIMIT 65").all(rootId)as Array<{ticket_id:string}>;
      blockers.push(...rows.map(row=>`held:${row.ticket_id}`));
    }
    if(exists("request_context_recovery_v1")&&this.db.prepare(`SELECT 1 FROM request_context_recovery_v1 WHERE json_extract(pointer_json,'$.contextId') IN (${contexts}) LIMIT 1`).get(rootId))blockers.push("recovery-pointer");
    return blockers;
  }
  inspect(rootId:string,epoch:string):{blockers:string[];revisions:Map<string,string>} {
    ROOT.parse(rootId);this.ready();const owner=this.owner(),blockers=this.durable(rootId),revisions=new Map<string,string>();
    if(!owner||!this.fenced(rootId,epoch,owner))blockers.push("drain-owner-or-fence");
    for(const registration of this.usedRegistrations)if(![...this.participants.values()].some(row=>row.value.registration===registration))blockers.push("unregistered-producer");
    for(const family of REQUEST_CONTEXT_DRAIN_FAMILIES)if(![...this.participants.values()].some(row=>row.family===family))blockers.push(`missing:${family}`);
    for(const [id,row]of this.participants){
      try{
        const before=row.value.revision(),view=row.value.inspect(rootId),after=row.value.revision();
        if(!before||before!==after||view.revision!==after||view.registration!==row.value.registration||view.unknown)blockers.push(`unknown:${id}`);
        else{revisions.set(id,after);blockers.push(...view.references.slice(0,65).map(ref=>`${id}:${ref}`));}
      }catch{blockers.push(`unavailable:${id}`);}
    }
    return {blockers,revisions};
  }
  prove(rootId:string,epoch:string):RequestContextRetirementProof {
    const owner=this.owner(),membership=this.membership,inspected=this.inspect(rootId,epoch);
    if(!owner||inspected.blockers.length)throw Error(`request-context root is not drained: ${inspected.blockers.join(", ").slice(0,2000)}`);
    const current=():boolean=>{
      try{
        this.ready();if(this.owner()!==owner||this.membership!==membership||!this.fenced(rootId,epoch,owner))return false;
        for(const [id,revision]of inspected.revisions)if(this.participants.get(id)?.value.revision()!==revision)return false;
        // E independently rechecks durable rows in its transaction; a proof never supplies permission.
        return true;
      }catch{return false;}
    };
    if(!current())throw Error("request-context drain changed while proving");
    return Object.freeze({rootId,epoch,current});
  }
}
