/** The owner's Off request pauses independent roots, never the returns needed to finish the drain. */
import type {RequestContextDrain} from "./request-context-drain.js";
import {RequestContextInstallationStore,RequestContextPublication,type RequestContextInstallationOwner,type RequestContextInstallationState} from "./request-context-installation.js";

export class RequestContextOffOwner<T extends object> {
 constructor(private readonly installation:RequestContextInstallationStore,private readonly drain:RequestContextDrain,
  private readonly publication:RequestContextPublication<T>,private readonly owner:RequestContextInstallationOwner,
  private readonly prepared?:{readonly ports:Readonly<T>;current():boolean}){}
 /** Called only for the independently confirmed Settings decision. Role/session currency joins the DB checks. */
 begin(expectedRevision:number,decisionCurrent:()=>boolean):RequestContextInstallationState {
  const previous=this.installation.read();
  if(!previous||previous.revision!==expectedRevision||previous.mode!=="active"||decisionCurrent()!==true)throw Error("stale");
  const unpublished=this.publication.heldUnpublished();
  // This is an actual prepared bridge, never a manufactured execution lease. Cold boot remains fenced
  // until this mode owner publishes its real ports; all durable/memory families still participate in drain.
  const execution=unpublished?null:this.publication.captureExecution();
  if(execution&&(execution.state.revision!==previous.revision||execution.state.epoch!==previous.epoch)
    ||unpublished&&(!this.prepared||this.prepared.current()!==true))throw Error("unavailable");
  const ports=execution?.ports??this.prepared!.ports,portsCurrent=execution?.portsCurrent??(()=>this.prepared?.current()===true);
  const fence=this.publication.fence();
  let committed=false;
  try{
   const state=this.installation.beginOff(expectedRevision,{owner:this.owner.owner,current:()=>this.owner.current()&&decisionCurrent()});committed=true;
   this.publishDraining(state,ports,portsCurrent,fence);
   return state;
  }catch(error){
   // A failed role/CAS check grants nothing, but must not revoke the existing executions or strand their input.
   if(!committed&&!unpublished)this.publication.resume(fence,()=>this.installation.read());
   throw error;
  }
 }
 /** One synchronous bounded attempt. The original decision survives its browser; never invent a timer completion. */
 advance(expectedRevision:number):{state:RequestContextInstallationState;blockers:readonly string[]} {
  const previous=this.installation.read(),execution=this.publication.captureExecution();
  if(!previous||previous.mode!=="draining"||previous.revision!==expectedRevision||execution.state.revision!==previous.revision
    ||execution.state.epoch!==previous.epoch||!this.owner.current())throw Error("stale");
  const fence=this.publication.fence();let committed=false;
  try{
   const proof=this.drain.proveOff(this.installation,fence.current);
   const state=this.installation.finishOff(expectedRevision,this.owner,proof);committed=true;
   this.publication.publish(state,execution.ports,fence,execution.portsCurrent,()=>this.installation.read(),execution.portsCurrent);
   return {state,blockers:[]};
  }catch(error){
   if(committed)throw error; // Durable Off can recover only through the capable installer, never legacy.
   this.publication.resume(fence,()=>this.installation.read());
   const now=this.installation.read();
   if(!now||now.mode!=="draining"||now.revision!==expectedRevision||!this.owner.current())throw error;
   // The assessor reports concrete owned rows/families, with no network or producer mutation.
   const roots=this.installation.drainRoots(),blockers=[...roots].flatMap(root=>this.drain.inspectWork(root).blockers.map(reason=>`${root}:${reason}`));
   // An empty snapshot still needs all eight families; preserve the actual failed proof reason.
   if(!blockers.length)blockers.push(error instanceof Error?error.message:"request-context drain unavailable");
   return {state:now,blockers};
  }
 }
 private publishDraining(state:RequestContextInstallationState,ports:Readonly<T>,current:()=>boolean,fence:{current():boolean}):void {
  const roots=this.installation.drainRoots();
  this.publication.publish(state,ports,fence,current,()=>this.installation.read(),current,root=>roots.has(root));
 }
}
