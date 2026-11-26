import {randomUUID} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {afterEach,expect,it,vi} from "vitest";
import {DeliveryOutbox,type NewOutboxDelivery} from "../src/delivery-outbox.js";
import {ContactHeldError} from "../src/contact-auth-service.js";
import {requestContextDigest} from "../src/request-context-store.js";
import type {RequestContactCardsHost} from "../src/request-contact-card.js";
import type {RequestContactPrincipal} from "../src/request-contact-types.js";
import type {RequestContextV1,RequestOperationBindingV1} from "../src/request-context-protocol.js";
const clean:Array<()=>void>=[];afterEach(()=>{vi.restoreAllMocks();for(const fn of clean.splice(0).reverse())fn();});
const manager={platform:"discord" as const,adapterId:"fixture",userId:"demo-admin",label:"Demo admin"};
function rig(){
 const home=mkdtempSync(join(tmpdir(),"s227-card-"));clean.push(()=>rmSync(home,{recursive:true,force:true}));const box=new DeliveryOutbox(join(home,"outbox.db"),"fixture",{requestContextDispatchVersion:1});clean.push(()=>box.close());box.activateRequestContextBarrier();const db=(box as any).db;
 const generations=new Map([["source","source-v1"],["target","target-v1"],["other","other-v1"],["hidden","hidden-v1"]]),roles=new Set(["target","other"]);let live=true,verified=false,eligible=true,rolesRevision="roles-a";
 const host:RequestContactCardsHost={current:()=>true,canManage:(target,p)=>p.platform===manager.platform&&p.userId===manager.userId&&roles.has(target),canDecide:(target,p)=>eligible&&host.canManage(target,p),adminOf:()=>false,
  person:actor=>actor.kind==="person"&&actor.platform!=="hub"?{platform:actor.platform,userId:actor.userId,adapterId:"fixture",label:"Demo person"}:null,
  generation:name=>generations.get(name)??null,roleRevision:()=>rolesRevision,managedTargets:()=>[...roles],label:name=>`Demo ${name}`,deliveryState:ticket=>ticket.deliveryId?box.get(ticket.deliveryId)?.state:undefined,
  legacyCurrent:()=>true,admitLegacy:(request,id)=>box.admit({operationId:request.operationId,sourceKey:`contact:${id}`,sourceInstance:request.source,sourceDaemonBootId:"boot",targetInstance:request.target,kind:"fleet_inbound",payload:request.payload}).delivery.deliveryId,changed:vi.fn()};
 const cards=box.requestContactCards(host),gate=box.requestContactGate(host);
 const actor=(adapterId="fixture",userId="demo-admin"):RequestContactPrincipal=>({person:{...manager,adapterId,userId},binding:"session-a",verified,current:()=>live});
 const context=(ingress:RequestContextV1["ingress"]="restricted-room"):RequestContextV1=>{const id=randomUUID();return {ref:{version:1,contextId:id,rootContextId:id},rootEvidenceRef:"fixture",ingress,initiatingActor:{kind:"person",platform:"discord",userId:"demo-person"},source:{instance:"source",incarnation:"source-v1"},sourceAudience:{kind:"room",ref:randomUUID()}};};
 const hold=(c=context(),target="target")=>{
  const operationId=randomUUID(),delivery:NewOutboxDelivery={operationId,sourceKey:operationId,sourceInstance:"source",sourceDaemonBootId:"boot",targetInstance:target,kind:"fleet_inbound",payload:{content:"PRIVATE_MESSAGE",files:[{name:"demo.txt",sha256:"a".repeat(64)}]},forwards:[]};
  const binding:RequestOperationBindingV1={version:1,operationId,contextId:c.ref.contextId,rootContextId:c.ref.rootContextId,source:c.source,target:{instance:target,incarnation:generations.get(target)!},verb:"send_to_instance",payloadSha256:requestContextDigest(delivery.payload)};
  try{gate.admit(delivery,c,binding);throw Error("expected hold");}catch(e){if(!(e instanceof ContactHeldError))throw e;return box.contactAuthorizations.get(e.result.authorization_id)!;}
 };
 const legacy=(source="source",target="target")=>{if(!generations.has(source))generations.set(source,`${source}-v1`);return box.contactAuthorizations.hold({operationId:randomUUID(),source,target,sourceGeneration:generations.get(source)!,targetGeneration:generations.get(target)!,verb:"send_to_instance",origin:{kind:"human",people:[{...manager,userId:"demo-person",label:"Demo person"}],receiptIds:["PRIVATE_RECEIPT"],chain:[]},message:"PRIVATE_MESSAGE",correlationId:randomUUID(),resultRecipient:source,payload:{content:"PRIVATE_MESSAGE",files:[{name:"original.txt"}]},forwards:["PRIVATE_RECEIPT"]});};
 const decide=(id:string,decision:"approve-once"|"decline"="approve-once")=>{const snapshot=cards.read(id,actor()).snapshot;return cards.decide(id,{snapshot,decision},actor());};
 return {box,db,host,cards,gate,generations,roles,actor,context,hold,legacy,decide,verified:(v:boolean)=>{verified=v;},live:(v:boolean)=>{live=v;},eligible:(v:boolean)=>{eligible=v;},roleRevision:(v:string)=>{rolesRevision=v;}};
}
it("unverified scoped reads use the recorded requester and reveal no private receipt fields or authority",()=>{
 const f=rig(),ticket=f.hold(),card=f.cards.read(ticket.id,f.actor());expect(card).toMatchObject({engine:"request-v1",approvalScope:"root-request",authority:"none",requester:{userId:"demo-person"},actions:{canDecide:false,requiresVerification:true,canGrant:true}});
 expect(JSON.stringify(card)).not.toContain("PRIVATE_RECEIPT");expect(JSON.stringify(card)).not.toContain("adapterId");expect(f.box.listPending()).toEqual([]);
});
it("scoped companion and legacy snapshots do not persist unread expiry or stale policy",()=>{
 const f=rig(),ticket=f.hold(),legacy=f.legacy();f.db.prepare("UPDATE contact_auth_tickets SET ticket_json=json_set(ticket_json,'$.expiresAt','2000-01-01T00:00:00Z')").run();
 f.db.prepare("INSERT INTO contact_auth_policies(instance,revision,policy_json) VALUES(?,?,?)").run("target",4,JSON.stringify({revision:4,generation:"old-generation",grants:[],roomTools:{publicRead:true,allowedMcpTools:[],wouldDisable:[]}}));
 const before=f.db.prepare("SELECT total_changes() n").get();expect(f.box.contactAuthorizations.policySnapshot("target","target-v1").revision).toBe(5);expect(f.gate.snapshot(ticket.id).ticket.state).toBe("expired");expect(f.cards.read(legacy.id,f.actor()).ticket.state).toBe("expired");expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(before);
});
it("a sibling-bot manager remains the same person, while another account sees no ticket",()=>{
 const f=rig(),ticket=f.hold();expect(f.cards.read(ticket.id,f.actor("sibling-bot")).ticket.id).toBe(ticket.id);expect(()=>f.cards.read(ticket.id,f.actor("sibling-bot","other-admin"))).toThrow(/not-found/);
});
it("a managing administrator who is not an eligible approver can read but not decide",()=>{
 const f=rig(),ticket=f.hold();f.verified(true);f.eligible(false);expect(f.cards.read(ticket.id,f.actor()).actions.canDecide).toBe(false);expect(()=>f.decide(ticket.id)).toThrow(/forbidden/);expect(f.box.listPending()).toEqual([]);
});
it("verification itself dispatches nothing; one explicit Continue admits once and duplicate gets409 semantics",()=>{
 const f=rig(),ticket=f.hold(),initial=f.cards.read(ticket.id,f.actor());expect(()=>f.cards.decide(ticket.id,{snapshot:initial.snapshot,decision:"approve-once"},f.actor())).toThrow(/verification-required/);f.verified(true);expect(f.box.listPending()).toEqual([]);
 expect(f.decide(ticket.id)).toMatchObject({ticket:{state:"approved"},authority:"none"});expect(f.box.listPending()).toHaveLength(1);expect(()=>f.cards.decide(ticket.id,{snapshot:initial.snapshot,decision:"approve-once"},f.actor())).toThrow(/already-decided/);expect(f.box.listPending()).toHaveLength(1);
});
it.each(["scoped","legacy"])("%s image digest and policy revision are CAS-checked inside the writer",kind=>{
 const f=rig(),ticket=kind==="scoped"?f.hold():f.legacy();f.verified(true);const snapshot=f.cards.read(ticket.id,f.actor()).snapshot;
 expect(()=>f.cards.decide(ticket.id,{snapshot:{...snapshot,imageSha256:"b".repeat(64)},decision:"approve-once"},f.actor())).toThrow(/operation-conflict/);
 expect(()=>f.cards.decide(ticket.id,{snapshot:{...snapshot,policyRevision:999},decision:"approve-once"},f.actor())).toThrow(/policy-conflict/);expect(f.box.listPending()).toEqual([]);expect(f.box.contactAuthorizations.get(ticket.id)?.state).toBe("pending");
});
it("legacy file-only mutation conflicts even though requestHash omits files",()=>{
 const f=rig(),ticket=f.legacy();f.verified(true);const snapshot=f.cards.read(ticket.id,f.actor()).snapshot,requestHash=ticket.requestHash;
 f.db.prepare("UPDATE contact_auth_tickets SET request_json=json_set(request_json,'$.payload.files[0].name','changed.txt') WHERE id=?").run(ticket.id);
 expect(f.box.contactAuthorizations.get(ticket.id)?.requestHash).toBe(requestHash);expect(()=>f.cards.decide(ticket.id,{snapshot,decision:"approve-once"},f.actor())).toThrow(/operation-conflict/);expect(f.box.listPending()).toEqual([]);
});
it.each(["source","target"])("a changed %s incarnation never borrows an old card approval",which=>{
 const f=rig(),ticket=f.hold();f.verified(true);const snapshot=f.cards.read(ticket.id,f.actor()).snapshot;f.generations.set(which,"replacement");expect(()=>f.cards.decide(ticket.id,{snapshot,decision:"approve-once"},f.actor())).toThrow(/stale-generation|forbidden/);expect(f.box.listPending()).toEqual([]);
});
it("a role change inside admission rolls back delivery and decision together",()=>{
 const f=rig(),ticket=f.legacy();f.verified(true);const admit=f.host.admitLegacy;f.host.admitLegacy=(...args)=>{const id=admit(...args);f.roles.clear();return id;};expect(()=>f.decide(ticket.id)).toThrow(/forbidden/);expect(f.box.listPending()).toEqual([]);expect(f.box.contactAuthorizations.get(ticket.id)?.state).toBe("pending");
});
it("continued D1 outcomes name the original ticket and have no decision actions",()=>{
 const f=rig(),c=f.context(),first=f.hold(c),next=f.hold(c,"other");f.verified(true);f.decide(first.id);f.gate.reevaluate(c.ref.rootContextId);expect(f.cards.read(next.id,f.actor())).toMatchObject({continuedFrom:first.id,ticket:{state:"approved"},actions:{canDecide:false,canGrant:false}});
});
it("representable native guest persons align with E; Hub persons never become native grants",()=>{
 const f=rig(),native=f.hold(f.context("guest"));expect(f.cards.read(native.id,f.actor()).actions.canGrant).toBe(true);
 const c={...f.context("hub"),initiatingActor:{kind:"person" as const,platform:"hub" as const,hubId:"demo-hub",id:"demo-person",displayName:"Demo Hub person"}},hub=f.hold(c);const view=f.cards.read(hub.id,f.actor());expect(view.requester).toEqual(c.initiatingActor);expect(view.actions.canGrant).toBe(false);expect(view.grantCandidates).toEqual([]);
});
it("the legacy writer refuses a scoped companion rather than falling back",()=>{
 const f=rig(),ticket=f.hold(),snapshot=f.cards.read(ticket.id,f.actor()).snapshot;
 expect(()=>f.box.contactAuthorizations.decideExpected(ticket.id,{revision:ticket.revision,decision:"approve-once"},manager,{canDecide:()=>true,current:()=>true,admit:()=>"wrong"},snapshot)).toThrow(/scoped/);
});
it("list scopes before paging and binds cursors to actor, filters and role revision",()=>{
 const f=rig();for(let n=0;n<65;n++)f.legacy(`source-${n}`);f.legacy("hidden-source","hidden");const first=f.cards.list({},f.actor());expect(first.items).toHaveLength(32);expect(first.nextCursor).toBeTruthy();expect(JSON.stringify(first)).not.toContain("hidden");
 const second=f.cards.list({cursor:first.nextCursor!},f.actor("sibling-bot"));expect(second.items).toHaveLength(32);const third=f.cards.list({cursor:second.nextCursor!},f.actor());expect(third.items).toHaveLength(1);expect(third.nextCursor).toBeNull();
 expect(()=>f.cards.list({cursor:first.nextCursor!,agent:"target"},f.actor())).toThrow(/invalid-cursor/);expect(()=>f.cards.list({cursor:first.nextCursor!},f.actor("fixture","other-admin"))).toThrow(/invalid-cursor/);f.roleRevision("roles-b");expect(()=>f.cards.list({cursor:first.nextCursor!},f.actor())).toThrow(/invalid-cursor/);
});
it("native proposal preparation supplies no actor or decision authority and rechecks its posting owner",()=>{
 const f=rig(),ticket=f.hold();expect(()=>f.cards.prepareForNativePost(ticket.id,()=>false)).toThrow(/forbidden/);let checks=0;expect(()=>f.cards.prepareForNativePost(ticket.id,()=>++checks===1)).toThrow(/forbidden/);
 expect(f.cards.prepareForNativePost(ticket.id,()=>true)).toMatchObject({authority:"none",actions:{canDecide:false}});expect(f.box.listPending()).toEqual([]);
});

it.each(["scoped","legacy"])("%s optional grant is written by the same decision transaction",kind=>{
 const f=rig(),ticket=kind==="scoped"?f.hold():f.legacy();f.verified(true);const card=f.cards.read(ticket.id,f.actor());
 const outcome=f.cards.decide(ticket.id,{snapshot:card.snapshot,decision:"approve-once",grant:{expiresAt:new Date(Date.now()+86400_000).toISOString(),remainingUses:null,personKeys:[card.grantCandidates[0]!.key]}},f.actor());
 expect(outcome.ticket.state).toBe("approved");const stored=f.box.contactAuthorizations.get(ticket.id)!;
 expect(stored.grantIds).toHaveLength(1);expect(f.box.contactAuthorizations.policy("target","target-v1").grants.map(row=>row.id)).toEqual(stored.grantIds);expect(f.box.listPending()).toHaveLength(1);
});
it("expired cards are read-only outcomes and cannot turn into an approval",()=>{
 const f=rig(),ticket=f.hold();f.verified(true);f.db.prepare("UPDATE contact_auth_tickets SET ticket_json=json_set(ticket_json,'$.expiresAt','2000-01-01T00:00:00Z') WHERE id=?").run(ticket.id);
 const card=f.cards.read(ticket.id,f.actor());expect(card).toMatchObject({ticket:{state:"expired"},actions:{canDecide:false,canGrant:false}});expect(f.cards.list({status:"expired"},f.actor()).items.map(row=>row.ticket.id)).toEqual([ticket.id]);
 expect(()=>f.cards.decide(ticket.id,{snapshot:card.snapshot,decision:"approve-once"},f.actor())).toThrow("expired");expect(f.box.listPending()).toEqual([]);
});

it("All includes terminal outcomes while the omitted status remains pending",()=>{
 const f=rig(),declined=f.hold(),pending=f.hold();f.verified(true);f.decide(declined.id,"decline");expect(f.cards.list({},f.actor()).items.map(card=>card.ticket.id)).toEqual([pending.id]);expect(new Set(f.cards.list({status:"all"},f.actor()).items.map(card=>card.ticket.id))).toEqual(new Set([declined.id,pending.id]));
});
