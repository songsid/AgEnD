/** Production consequences reuse the existing retained-resource ledger; no policy flattening or snapshot restore. */
import type Database from "better-sqlite3";
import type {PersonKey} from "../types.js";
import type {HubTransportStore} from "../store.js";
import type {HubAuditStore} from "../audit/index.js";
import {HubProtocolError} from "../validation.js";
import {createHubGroupAdminInventory} from "../group-policy/admin-inventory.js";
import {createHubGroupImpactInventory} from "../group-policy/impact-inventory.js";
import {buildHubRoleImpact} from "../group-policy/admin-impact.js";
import {createHubGroupResources} from "../group-policy/resources.js";
import {readHubOperationalPolicy,type HubGroupPolicyStore} from "../group-policy/store.js";
import {parseRolePolicy} from "./model.js";
import type {RoleWriteEffects} from "./writer.js";
export function createHubRoleResourceEffects(options:{
 db:Database.Database;root:PersonKey;transport:Pick<HubTransportStore,"read">;policy:HubGroupPolicyStore;
 audit:Pick<HubAuditStore,"appendInTransaction">;current():boolean;now():number;
}):RoleWriteEffects{
 const {db,root,transport,policy,audit,current,now}=options;
 const live=()=>{if(current()!==true)throw new HubProtocolError("unavailable");};
 const inventory=createHubGroupAdminInventory({db,transport,realm:root.realm});
 const observations=createHubGroupImpactInventory({db,transport,administrator:root,inventory,current,now});
 const read=()=>{live();return parseRolePolicy(readHubOperationalPolicy(policy));};
 const snapshot=()=>{const s=observations.snapshot([read()]);return{fingerprint:s.fingerprint,ordinaryFingerprint:s.ordinaryFingerprint,people:s.people.map(p=>p.key)};};
 return{snapshot,async prepare(plan,facts,assertCurrent,context){
  assertCurrent();live();if(!context||context.actor.realm!==root.realm)throw new HubProtocolError("unavailable");
  const before=observations.snapshot([plan.before,plan.next]);
  const impact=buildHubRoleImpact({before:plan.before,next:plan.next,administrator:root,...before,facts,at:now()});
  const ctx={requestId:context.requestId,current:()=>current()===true};
  const resources=createHubGroupResources({db,policy,audit,current,now});
  const row=(resource:Parameters<typeof inventory.ledger>[0])=>{const r=inventory.ledger(resource);return r?{source:r.source,state:r.state,revision:r.revision}:null;};
  const prove=()=>{assertCurrent();live();if(observations.snapshot([plan.before,plan.next]).fingerprint!==before.fingerprint)throw new HubProtocolError("conflict");};
  const transaction=(tx:Database.Database)=>{live();if(tx!==db||!db.inTransaction)throw new HubProtocolError("unavailable");};
  return{fingerprint:before.fingerprint,changed:impact.capture.length>0||impact.suspend.length>0,impact:impact.impact,
   assertCurrent:prove,
   commit(tx){transaction(tx);prove();for(const r of impact.capture){if(row(r)!==null)throw new HubProtocolError("conflict");resources.captureManual(r,ctx,context.actor);}},
   afterPolicyWrite(tx){transaction(tx);for(const r of impact.suspend){
    const old=before.resources.find(item=>JSON.stringify(item.resource)===JSON.stringify(r));
    const expected=old?.lifecycle??{source:"manual",state:"active",revision:1};
    if(!old||JSON.stringify(row(r))!==JSON.stringify(expected))throw new HubProtocolError("conflict");resources.suspend(r,context.actor,ctx);
   }},
   assertCommitted(){
    live();if(observations.snapshot([plan.before,plan.next]).ordinaryFingerprint!==before.ordinaryFingerprint)throw new HubProtocolError("conflict");
    const captured=new Set(impact.capture.map(r=>JSON.stringify(r))),suspended=new Set(impact.suspend.map(r=>JSON.stringify(r)));
    for(const old of before.resources){const id=JSON.stringify(old.resource),initial=old.lifecycle??(captured.has(id)?{source:"manual",state:"active",revision:1}:null);
     const expected=initial&&suspended.has(id)?{...initial,state:"suspended",revision:initial.revision+1}:initial;
     if(JSON.stringify(row(old.resource))!==JSON.stringify(expected))throw new HubProtocolError("conflict");
    }
   },
  };
 }};
}
