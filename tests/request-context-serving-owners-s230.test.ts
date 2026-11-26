/** Real gate, cards and outbox; all runtime/notification ports are inert. No Fleet/provider starts. */
import {afterEach,expect,it,vi} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {DeliveryOutbox} from "../src/delivery-outbox.js";
import {FleetManager} from "../src/fleet-manager.js";
import {ContactHeldError} from "../src/contact-auth-service.js";
import {captureRequestContextCall} from "../src/request-context-call.js";
import type {RequestContextV1} from "../src/request-context-protocol.js";
const cleanup:Array<()=>void>=[];afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
function rig(){
 const h=mkdtempSync(join(tmpdir(),"serving-owners-"));cleanup.push(()=>rmSync(h,{recursive:true,force:true}));const box=new DeliveryOutbox(join(h,"box.db"),"manager",{requestContextDispatchVersion:1,requestContextRelayVersion:1});cleanup.push(()=>box.close());box.activateRequestContextBarrier();
 let live=true,admitted=true,mode:"active"|"draining"|"off"|null="active";const generations=new Map([["a","a-v1"],["b","b-v1"],["c","c-v1"]]);
 const admin={platform:"discord" as const,adapterId:"discord",userId:"admin",label:"Demo admin"},changed=vi.fn(),forbidden=vi.fn(()=>{throw Error("Forbidden lifetime/Hub timer lookup");});
 const m:any=Object.create(FleetManager.prototype);Object.assign(m,{dataDir:h,configPath:join(h,"fleet.yaml"),deliveryOutbox:box,managerBootId:"manager",lifecycle:{daemons:new Map()},
  fleetConfig:{instances:Object.fromEntries([...generations.keys()].map(name=>[name,{working_directory:h}]))},adapters:new Map([["discord",{id:"discord",type:"discord"}]]),worlds:new Map(),
  ensureDeliveryOutbox:()=>{},contactGeneration:(name:string)=>{const value=generations.get(name);if(!value)throw Error("unavailable");return value;},
  requestContextNativeAdmissionCurrent:vi.fn(()=>admitted),contactAdminOf:(_name:string,person:any)=>person.userId==="admin",contactDefaultApprovers:()=>[admin],
  contactService:()=>({host:{store:box.contactAuthorizations,defaultApprovers:()=>[admin],changed,admit:()=>{throw Error("Legacy admission forbidden");}}}),hubContactRestricted:forbidden,
  scheduleDeliveryOutboxPump:vi.fn(),sweepContactAuthorizationOutcomes:vi.fn(),emitSseEvent:vi.fn(),syncHeldTicketCard:vi.fn(),needsYou:{poke:vi.fn()},logger:{warn:vi.fn()},classicChannels:undefined});
 const graph=m.prepareRequestContextServingOwners(()=>live,()=>false,()=>null,()=>mode),actor={person:admin,binding:"session",verified:true,current:()=>live};
 const context=(ingress:RequestContextV1["ingress"]="restricted-room"):RequestContextV1=>{const id=randomUUID();return {ref:{version:1,contextId:id,rootContextId:id},rootEvidenceRef:"fixture",ingress,source:{instance:"a",incarnation:"a-v1"},initiatingActor:ingress==="hub"?{kind:"person",platform:"hub",hubId:randomUUID(),id:"directory/demo",displayName:"Demo person"}:{kind:"person",platform:"discord",userId:"outside",displayName:"Demo person"},sourceAudience:{kind:ingress==="hub"?"hub":"room",ref:randomUUID()}};};
 const send=(c:RequestContextV1,target="b")=>{
  const inputId=randomUUID(),operationId=randomUUID(),lease=captureRequestContextCall({token:randomUUID(),inputId,context:c,wireSha256:"a".repeat(64),owner:{instance:c.source.instance,incarnation:c.source.incarnation,workGeneration:randomUUID(),daemonBootId:`boot-${c.source.instance}`,spawnGeneration:1,launchFenceEpoch:1,deliveryEpoch:0}},()=>live);
  return graph.relay.admit({sourceInstance:c.source.instance,sourceDaemonBootId:`boot-${c.source.instance}`,targetInstance:target,targetSession:target,operationId,kind:"fleet_inbound",payload:{type:"fleet_inbound",content:"Fixture message",meta:{from_instance:c.source.instance,request_kind:"query"}}},{instance:c.source.instance,tool:"send_to_instance",args:{instance_name:target},admission:{coverage:"covered",lease}},()=>live);
 };
 return {m,box,graph,actor,changed,forbidden,generations,context,send,live:(value:boolean)=>{live=value;},admitted:(value:boolean)=>{admitted=value;},mode:(value:typeof mode)=>{mode=value;}};
}
it("one serving graph uses the same gate for the hold, same-card decision and D1 onward admission",()=>{
 const r=rig(),context=r.context();let id="";try{r.send(context);}catch(error){if(!(error instanceof ContactHeldError))throw error;id=error.result.authorization_id;}
 expect(id).not.toBe("");expect(r.changed).toHaveBeenCalledWith("b",id);const card=r.graph.cards.read(id,r.actor);
 expect(card).toMatchObject({engine:"request-v1",authority:"none",approvalScope:"root-request"});expect(r.box.listPending()).toHaveLength(0);
 const outcome=r.graph.cards.decide(id,{snapshot:card.snapshot,decision:"approve-once"},r.actor);expect(outcome.ticket.state).toBe("approved");expect(r.box.listPending()).toHaveLength(1);
 const child={...context,ref:{...context.ref,contextId:randomUUID(),parentContextId:context.ref.contextId},source:{instance:"b",incarnation:"b-v1"}};
 expect(r.send(child,"c")).toMatchObject({state:"queued"});expect(r.box.listPending()).toHaveLength(2);expect(r.forbidden).not.toHaveBeenCalled();
});
it("accepted Hub requests pass with their baked label even when the old Hub timer would refuse",()=>{
 const r=rig(),result=r.send(r.context("hub")),delivery=r.box.get(result.deliveryId)!;
 expect(result.state).toBe("queued");expect(delivery.payload.content).toContain("request_provenance=");expect(delivery.payload.content).toContain("Demo person");expect(r.forbidden).not.toHaveBeenCalled();
});
it.each(["access","target","process"])("the serving host refuses current %s loss without a legacy fallback",kind=>{
 const r=rig(),context=r.context("owner");if(kind==="access")r.admitted(false);if(kind==="target")r.generations.delete("b");if(kind==="process")r.live(false);
 expect(()=>r.send(context)).toThrow();expect(r.box.listPending()).toHaveLength(0);expect(r.forbidden).not.toHaveBeenCalled();
});
it("the published facade reads one object per ingress and keeps tracked decisions available under an admission fence",async()=>{
 const {RequestContextBoot}=await import("../src/request-context-boot.js");const r=rig(),state={revision:1,epoch:"fixture-publication",owner:"fleet",mode:"active" as const};
 let owner=true,ports=true;const boot=new RequestContextBoot(state,{id:"process",current:()=>owner}),fence=boot.publication.fence();
 r.m.requestContextBoot=boot;r.m.requestContextAdmission=boot.publication.admission;r.m.bindRequestContextServingPublication(boot);
 expect(()=>r.m.requestContextHumanAdmission("a",{},{} as any,"text")).toThrow(/fenced/);expect(()=>r.m.requestContactApi.needs(r.actor)).toThrow(/unavailable/);
 const human=vi.fn(()=>({receipt_id:"fixture"})),hub=vi.fn(()=>({inputId:"fixture"})),serving={...r.graph,human,hub,current:()=>ports};
 boot.publication.publish(state,{policy:r.graph.policy,serving:serving as any},fence,()=>true,()=>state,()=>ports);
 expect(r.m.requestContextHumanAdmission("a",{},{} as any,"text")).toEqual({receipt_id:"fixture"});expect(human).toHaveBeenCalledOnce();
 boot.publication.fence();expect(()=>r.m.requestContextHubAdmission({})).toThrow(/fenced/);expect(hub).not.toHaveBeenCalled();
 expect(r.m.requestContactApi.needs(r.actor)).toEqual([]); // Scoped reads/decisions are execution paths, not new ingress.
 ports=false;expect(()=>r.m.requestContactApi.needs(r.actor)).toThrow(/unavailable/);ports=true;
 owner=false;expect(()=>r.m.requestContactApi.needs(r.actor)).toThrow(/unavailable/);expect(()=>r.m.requestContextHumanAdmission("a",{},{} as any,"text")).toThrow();
});
it("the actual root-access helper checks the original Hub source incarnation before its separate Hub resource check",()=>{
 const r=rig(),root=r.context("hub");r.box.requestContextRecovery.retain(root);delete r.m.requestContextNativeAdmissionCurrent;
 expect(r.m.requestContextNativeAdmissionCurrent(root)).toBe(true);r.generations.set("a","replacement");expect(r.m.requestContextNativeAdmissionCurrent(root)).toBe(false);
});

it("capable Off keeps fresh owner contact, holds outside work, and never restores changed lifetime origins",()=>{
 const r=rig(),outside=r.context("owner");expect(r.send(outside).state).toBe("queued");
 r.box.contactAuthorizations.inheritOrigin("a",{kind:"unknown",people:[],receiptIds:[],chain:["a"]});r.mode("off");
 expect(()=>r.send(outside)).toThrow(ContactHeldError);expect(()=>r.send(r.context("hub"))).toThrow(ContactHeldError);
 const fresh={...r.context("owner"),rootEvidenceRef:`human:hmsg-${randomUUID()}`,initiatingActor:{kind:"person" as const,platform:"discord" as const,userId:"admin"}};
 expect(r.send(fresh).state).toBe("queued");expect(r.forbidden).not.toHaveBeenCalled();
});
