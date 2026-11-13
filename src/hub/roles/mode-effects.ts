/** Unmounted identity-only effects for the roles on/off control, not a generic role-edit adapter. */
import type Database from "better-sqlite3";
import type {HubTransportStore} from "../store.js";
import {HubProtocolError} from "../validation.js";
import {captureRoleCutoverInventory} from "./cutover-inventory.js";
import type {RoleWriteEffects} from "./writer.js";
export function createHubRoleModeEffects(db:Database.Database,transport:Pick<HubTransportStore,"read">,current:()=>boolean):RoleWriteEffects{
 const live=()=>{if(current()!==true)throw new HubProtocolError("unavailable");};
 const snapshot=()=>{const inventory=captureRoleCutoverInventory(db,transport,live);return{fingerprint:inventory.digest,ordinaryFingerprint:inventory.digest,people:[]};};
 return{snapshot,async prepare(plan,_facts,assertCurrent){
  // Forward projection of the current document only: no state/latch, assignments, denies or snapshot restoration.
  const image=(p:typeof plan.before)=>{const{rolesActive:_active,...rest}=p;return JSON.stringify(rest);};
  if(image(plan.before)!==image(plan.next))throw new HubProtocolError("invalid");
  const before=snapshot().fingerprint,prove=()=>{if(snapshot().fingerprint!==before)throw new HubProtocolError("conflict");};
  const beforeProof=()=>{assertCurrent();prove();};
  prove();return{fingerprint:before,changed:false,impact:{selfUseChanged:false,resourcesChanged:false,retainedAssignments:plan.before.assignments.length},
   assertCurrent:beforeProof,commit(tx){if(tx!==db||!db.inTransaction)throw new HubProtocolError("unavailable");beforeProof();},assertCommitted:prove};
 }};
}
