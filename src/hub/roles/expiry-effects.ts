/** Fresh, bounded expiry consequences over known local people; manual/code provenance is never revoked by expiry. */
import {randomUUID} from "node:crypto";
import {HubProtocolError} from "../validation.js";
import {createHubGroupAdminInventory} from "../group-policy/admin-inventory.js";
import {createHubGroupImpactInventory} from "../group-policy/impact-inventory.js";
import {readHubGroupImpactFacts} from "../group-policy/admin-facts.js";
import {buildHubRoleImpact} from "../group-policy/admin-impact.js";
import {createHubGroupResources} from "../group-policy/resources.js";
import {readHubOperationalPolicy} from "../group-policy/store.js";
import {parseRolePolicy} from "./model.js";
import type {RoleResourceOptions} from "./resource-effects.js";
import type {RoleExpiryOptions} from "./expiry.js";
import type {HubDirectory} from "../directory/types.js";
import type {HubDirectoryReads} from "../directory/admission.js";
export function createHubRoleExpiryEffects(options:RoleResourceOptions & {directory:HubDirectory;reads:Pick<HubDirectoryReads,"withDirectoryRead">}):RoleExpiryOptions["effects"]{
 const {db,root,transport,policy,audit,current,now,directory,reads}=options;
 const live=()=>{if(current()!==true)throw new HubProtocolError("unavailable");};
 const inventory=createHubGroupAdminInventory({db,transport,realm:root.realm});
 const observations=createHubGroupImpactInventory({db,transport,administrator:root,inventory,current,now});
 const snapshot=()=>{live();const policyNow=parseRolePolicy(readHubOperationalPolicy(policy)),s=observations.snapshot([policyNow]);return{fingerprint:s.fingerprint,ordinaryFingerprint:s.ordinaryFingerprint,people:s.people.map(p=>p.key)};};
 return{snapshot,async prepare(input,assertCurrent){
  assertCurrent();live();const before=observations.snapshot([input.policy]);
  const observed=await readHubGroupImpactFacts({directory,people:before.people,now,deadline:input.at+20000,assertCurrent,
   preferEligibility:!input.policy.assignments.some(a=>a.subject.kind==="group"&&input.policy.roles.find(r=>r.id===a.roleId)!.permissions.some(c=>["ask_agents","publish_agents","pair_fleet"].includes(c)))&&before.people.every(p=>!p.askGroups?.length),
   withDirectoryRead:work=>reads.withDirectoryRead(root,work),
  });assertCurrent();
  const impact=buildHubRoleImpact({before:input.policy,next:input.policy,administrator:root,...before,facts:observed.facts,at:now()});
  const selected=impact.suspend.filter(r=>inventory.ledger(r)?.source==="group"),selectedIds=new Set(selected.map(r=>JSON.stringify(r)));
  const ctx={requestId:randomUUID(),current},resources=createHubGroupResources({db,policy,audit,current,now});
  const row=(resource:Parameters<typeof inventory.ledger>[0])=>{const r=inventory.ledger(resource);return r?{source:r.source,state:r.state,revision:r.revision}:null;};
  const prove=()=>{assertCurrent();if(observations.snapshot([input.policy]).fingerprint!==before.fingerprint)throw new HubProtocolError("conflict");};
  prove();return{fingerprint:before.fingerprint,changed:selected.length>0,impact:{...impact.impact,suspendedOnSave:impact.impact.suspendedOnSave.filter(r=>selected.some(s=>s.kind===r.kind&&s.id===r.id&&s.revision===r.revision))},assertCurrent:prove,
   commit(tx){if(tx!==db||!db.inTransaction)throw new HubProtocolError("unavailable");prove();for(const r of selected)resources.suspendExpired(r,ctx);},
   assertCommitted(){live();if(observations.snapshot([input.policy]).ordinaryFingerprint!==before.ordinaryFingerprint)throw new HubProtocolError("conflict");
    for(const old of before.resources){const expected=old.lifecycle&&selectedIds.has(JSON.stringify(old.resource))?{...old.lifecycle,state:"suspended",revision:old.lifecycle.revision+1}:old.lifecycle;
     if(JSON.stringify(row(old.resource))!==JSON.stringify(expected))throw new HubProtocolError("conflict");
    }
   },
  };
 }};
}
