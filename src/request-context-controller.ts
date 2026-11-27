/** Stable Settings host. Readiness is explanatory; only independently confirmed changes reach its effect owner. */
import type {RequestContextEnableOffer} from "./request-context-enable-offer.js";
import type {RequestContextInstallationState} from "./request-context-installation.js";
import {RequestContextControlViewSchema,type RequestContextControlView,type RequestContextControlHost,type RequestContextControlPrincipal,type RequestContextControlDecision} from "./request-context-control-api.js";
import {requestContextDigest} from "./request-context-store.js";
export type RequestContextBlocker=RequestContextControlView["blockers"][number];
export interface RequestContextControllerPorts {
 current():boolean;
 principal:RequestContextControlHost["principal"];
 permitContinuation:RequestContextControlHost["permitContinuation"];
 base():{state:RequestContextInstallationState|null;offer:RequestContextEnableOffer;restartCount:number;timeZone:string};
 inspect():readonly RequestContextBlocker[];
 enable(actor:RequestContextControlPrincipal,offer:RequestContextEnableOffer,decisionCurrent:()=>boolean):Promise<void>;
 disable(actor:RequestContextControlPrincipal,decisionCurrent:()=>boolean):void|Promise<void>;
 resolve(blocker:Readonly<RequestContextBlocker>,actor:RequestContextControlPrincipal,decisionCurrent:()=>boolean):void|Promise<void>;
 changed():void;
}
export class RequestContextController implements RequestContextControlHost {
 readonly principal:RequestContextControlHost["principal"];
 readonly permitContinuation:RequestContextControlHost["permitContinuation"];
 private cached:RequestContextControlView|null=null;
 private offer:RequestContextEnableOffer|null=null;
 private image="";private revision=0;private attempted=false;private busy=false;
 constructor(private readonly ports:RequestContextControllerPorts){this.principal=ports.principal;this.permitContinuation=ports.permitContinuation;}
 snapshot():RequestContextControlView|null{return this.cached?structuredClone({...this.cached,canChange:!this.busy&&this.ports.current()}):null;}
 private require(actor:RequestContextControlPrincipal,decision=false):void {
  if(!this.ports.current()||actor.current()!==true)throw Error("owner-required");
  if(decision){if(!actor.verified||!actor.execution)throw Error("verification-required");actor.execution.assert();}
 }
 private refresh():RequestContextControlView {
  if(!this.ports.current())throw Error("unavailable");
  const base=this.ports.base(),state=base.state,blockers=this.attempted||state?this.ports.inspect().map(row=>structuredClone(row)):[];
  const next={enabled:state?.mode==="active",everActivated:!!state,attempted:this.attempted,phase:state?.mode==="draining"?"draining" as const:blockers.length?"blocked" as const:state?.mode==="active"?"on" as const:"off" as const,canChange:true,blockers,
   ...(base.restartCount?{restartCount:base.restartCount}:{}),...(base.offer.latestDeadline!==null?{goBack:{attemptIds:[...base.offer.invalidates],availableUntil:new Date(base.offer.latestDeadline).toISOString(),timeZone:base.timeZone}}:{})};
  const image=requestContextDigest([next,base.offer.sha256,state]);
  if(image!==this.image){this.revision++;this.image=image;}
  this.offer=base.offer;this.cached=RequestContextControlViewSchema.parse({...next,revision:this.revision});return this.snapshot()!;
 }
 read(actor:RequestContextControlPrincipal):RequestContextControlView{this.require(actor);const value=this.busy?this.snapshot():this.refresh();this.require(actor);if(!value)throw Error("unavailable");return {...value,canChange:value.canChange&&actor.verified};}
 recheck(actor:RequestContextControlPrincipal):RequestContextControlView{return this.read(actor);}
 async change(input:Readonly<RequestContextControlDecision>,actor:RequestContextControlPrincipal):Promise<RequestContextControlView>{
  this.require(actor,true);if(this.busy)throw Error("stale");
  const view=this.refresh(),offer=this.offer!;
  if(view.revision!==input.revision)throw Error("stale");
  if(input.action==="check")return this.read(actor);
  const blocker=input.action==="resolve"?view.blockers.find(row=>row.id===input.blockerId&&row.action===input.resolution):undefined;
  if(input.action==="resolve"&&!blocker)throw Error("stale");
  const captured=this.image;
  const current=()=>{try{return this.ports.current()&&actor.current()===true&&actor.verified&&actor.execution?.current()===true&&this.image===captured;}catch{return false;}};
  this.busy=true;
  try{
   if(input.action==="enable"){
    this.attempted=true;
    await this.ports.enable(actor,offer,current);
   }else if(input.action==="disable")await this.ports.disable(actor,current);
   else await this.ports.resolve(Object.freeze(structuredClone(blocker!)),actor,current);
   // commit() consumes the decision, not the person or the installed process owner.
   this.require(actor);
  }finally{this.busy=false;try{this.refresh();}catch{this.cached=null;}this.ports.changed();}
  const result=this.snapshot();if(!result)throw Error("unavailable");return result;
 }
 /** Only actual owner events refresh passive surfaces; this never performs a pending On. */
 changed():void {if(!this.busy&&this.ports.current()){try{this.refresh();}catch{/* GET reports unavailable rather than a stale authoritative success. */}this.ports.changed();}}
}
