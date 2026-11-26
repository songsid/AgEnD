/** Dormant gate acceptance: actual SQLite/outbox, synthetic actors only. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { DeliveryOutbox, type NewOutboxDelivery } from "../src/delivery-outbox.js";
import type { RequestContactGateHost } from "../src/request-contact-gate.js";
import { getLocale, setLocale, tForLocale } from "../src/locale.js";
import { ContactHeldError } from "../src/contact-auth-service.js";
import { requestContextDigest } from "../src/request-context-store.js";
import type { ContactPerson, ContactTicketDecision } from "../src/contact-auth-types.js";
import type { RequestContextV1, RequestOperationBindingV1 } from "../src/request-context-protocol.js";
const originalLocale=getLocale();
const cleanup: Array<()=>void> = [];
afterEach(()=>{setLocale(originalLocale);vi.restoreAllMocks();for(const fn of cleanup.splice(0).reverse())fn();});
const manager:ContactPerson={platform:"discord",adapterId:"fixture",userId:"demo-manager",label:"Demo manager"};
function rig(active=true){
 const root=mkdtempSync(join(tmpdir(),"s225-gate-")),file=join(root,"outbox.db");cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
 const box=new DeliveryOutbox(file,"fixture",active?{requestContextDispatchVersion:1}:{});cleanup.push(()=>box.close());
 if(active)box.activateRequestContextBarrier();
 let current=true,managerAllowed=true,admin=false;
 const host:RequestContactGateHost={current:()=>current,canDecide:()=>managerAllowed,canManage:()=>managerAllowed,adminOf:()=>admin,
  person:(actor:any)=>actor.kind==="person"&&actor.platform!=="hub"?{platform:actor.platform,adapterId:actor.platform==="host"?"host":"fixture",userId:actor.userId,label:actor.displayName??"Demo person"}:null};
 const context=(ingress:RequestContextV1["ingress"]="restricted-room"):RequestContextV1=>{const id=randomUUID();return {ref:{version:1,contextId:id,rootContextId:id},rootEvidenceRef:"accepted-fixture",ingress,
  initiatingActor:{kind:"person",platform:"discord",userId:"demo-person"},source:{instance:"source",incarnation:"source-v1"},sourceAudience:{kind:"room",ref:randomUUID()}};};
 const input=(c=context(),operationId=randomUUID(),target="target")=>{const delivery:NewOutboxDelivery={operationId,sourceKey:`fixture:${c.source.instance}:${operationId}`,sourceInstance:c.source.instance,sourceDaemonBootId:"boot",targetInstance:target,kind:"fleet_inbound",payload:{type:"fleet_inbound",content:"Synthetic labelled request; authority none"}};
 const binding:RequestOperationBindingV1={version:1,operationId,contextId:c.ref.contextId,rootContextId:c.ref.rootContextId,source:c.source,target:{instance:target,incarnation:`${target}-v1`},verb:"send_to_instance",payloadSha256:requestContextDigest(delivery.payload)};return {delivery,context:c,binding};};
 const gate=()=>box.requestContactGate(host);
 const hold=(g:ReturnType<typeof gate>,i:ReturnType<typeof input>)=>{try{g.admit(i.delivery,i.context,i.binding);throw Error("expected hold");}catch(e){if(!(e instanceof ContactHeldError))throw e;return box.contactAuthorizations.get(e.result.authorization_id)!;}};
 const approve=(g:ReturnType<typeof gate>,id:string,grant?:ContactTicketDecision["grant"])=>{const ticket=box.contactAuthorizations.get(id)!;return g.decide(id,{revision:ticket.revision,decision:"approve-once",...(grant?{grant}:{})},manager,box.contactAuthorizations.policy(ticket.target,ticket.targetGeneration).revision,g.snapshot(id).imageSha256);};
 const raw=()=>{const db=new Database(file);db.function("agend_request_context_dispatch_version",()=>1);cleanup.push(()=>db.close());return db;};
 return {box,file,raw,host,gate,context,input,hold,approve,current:(v:boolean)=>{current=v;},managerAllowed:(v:boolean)=>{managerAllowed=v;},admin:(v:boolean)=>{admin=v;}};
}
it("OFF refuses the dormant gate and creates no companion artifacts",()=>{
 const f=rig(false);expect(()=>f.gate()).toThrow(/not ready/);
 const db=new Database(f.file,{readonly:true});cleanup.push(()=>db.close());
 expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='request_context_contacts_v1'").get()).toEqual({n:0});
});
it("holds one exact outside operation; Continue commits a single delivery and same-root onward release",()=>{
 const f=rig(),g=f.gate(),i=f.input(),ticket=f.hold(g,i);
 expect(f.hold(g,i).id).toBe(ticket.id);expect(f.box.listPending()).toHaveLength(0);
 const approved=f.approve(g,ticket.id);expect(approved.deliveryId).toBeTruthy();
 expect(g.admit(i.delivery,i.context,i.binding).delivery.deliveryId).toBe(approved.deliveryId);
 const child:RequestContextV1={...i.context,ref:{version:1,contextId:randomUUID(),rootContextId:i.context.ref.rootContextId,parentContextId:i.context.ref.contextId},source:{instance:"target",incarnation:"target-v1"}};
 const onward=f.input(child,randomUUID(),"third");g.admit(onward.delivery,onward.context,onward.binding);
 expect(f.box.listPending()).toHaveLength(2);
 expect(f.box.requestContextForDelivery(approved.deliveryId!)?.binding.contextId).toBe(i.context.ref.contextId);
 expect(f.hold(g,f.input()).state).toBe("pending");
});
it.each(["owner","free-room"] as const)("%s passes without consulting retained origin",ingress=>{
 const f=rig(),g=f.gate(),i=f.input(f.context(ingress));f.box.contactAuthorizations.inheritOrigin("source",{kind:"unknown",people:[],receiptIds:[],chain:[]});
 expect(g.admit(i.delivery,i.context,i.binding).inserted).toBe(true);
 expect(f.box.contactAuthorizations.origin("source")?.kind).toBe("unknown");
});
it("a current root-source admin passes restricted input; role loss or guest ingress does not borrow that pass",()=>{
 const f=rig(),g=f.gate();f.admin(true);const i=f.input();expect(g.admit(i.delivery,i.context,i.binding).inserted).toBe(true);
 f.admin(false);expect(f.hold(g,f.input()).state).toBe("pending");f.admin(true);expect(f.hold(g,f.input(f.context("guest"))).state).toBe("pending");
});
it("a changed retry conflicts before returning an old held or admitted operation",()=>{
 const f=rig(),g=f.gate(),i=f.input();const ticket=f.hold(g,i);
 const changed={...i.delivery,payload:{...i.delivery.payload,content:"Different bytes"}};
 expect(()=>g.admit(changed,i.context,{...i.binding,payloadSha256:requestContextDigest(changed.payload)})).toThrow(/conflict/);
 f.approve(g,ticket.id);
 expect(()=>g.admit({...i.delivery,sourceDaemonBootId:"other-boot"},i.context,i.binding)).toThrow(/conflict/);
});
it("a legacy decision callback cannot admit a scoped ticket",()=>{
 const f=rig(),g=f.gate(),ticket=f.hold(g,f.input());let invoked=false;
 expect(()=>f.box.contactAuthorizations.decide(ticket.id,{revision:ticket.revision,decision:"approve-once"},manager,{canDecide:()=>true,current:()=>true,admit:()=>{invoked=true;return "legacy";}})).toThrow(/request-context/);
 expect(invoked).toBe(false);expect(f.box.contactAuthorizations.get(ticket.id)?.state).toBe("pending");
});
it("current permission, policy CAS and approver removal refuse without a root release",()=>{
 const f=rig(),g=f.gate(),ticket=f.hold(g,f.input());f.managerAllowed(false);
 expect(()=>f.approve(g,ticket.id)).toThrow(/forbidden/);f.managerAllowed(true);f.current(false);
 expect(()=>f.approve(g,ticket.id)).toThrow(/stale|current/);f.current(true);
 expect(()=>g.decide(ticket.id,{revision:ticket.revision,decision:"approve-once"},manager,999,g.snapshot(ticket.id).imageSha256)).toThrow(/conflict/);
 expect(f.box.contactAuthorizations.get(ticket.id)?.state).toBe("pending");expect(f.box.listPending()).toHaveLength(0);
});
it("same-root re-evaluation skips declined operations and admits pending exact operations once",()=>{
 const f=rig(),g=f.gate(),c=f.context(),a=f.hold(g,f.input(c)),b=f.hold(g,f.input(c)),no=f.hold(g,f.input(c));
 g.decide(no.id,{revision:no.revision,decision:"decline"},manager,f.box.contactAuthorizations.policy(no.target,no.targetGeneration).revision,g.snapshot(no.id).imageSha256);f.approve(g,a.id);
 expect(g.reevaluate(c.ref.rootContextId).approved.map(t=>t.id)).toEqual([b.id]);expect(g.reevaluate(c.ref.rootContextId)).toEqual({approved:[],refused:[]});
 expect(f.box.listPending()).toHaveLength(2);expect(f.box.contactAuthorizations.get(no.id)?.state).toBe("declined");
});

it("all legacy decision and grant paths reject scoped tickets; scoped decisions reject legacy tickets",()=>{
 const f=rig(),g=f.gate(),i=f.input(),ticket=f.hold(g,i);let called=false;
 const legacy={canDecide:()=>true,current:()=>true,admit:()=>{called=true;return "bad";}};
 expect(()=>f.box.contactAuthorizations.applyStandingGrant(ticket.id,legacy)).toThrow(/scoped-ticket/);
 expect(()=>f.box.admit(i.delivery)).toThrow(/request-context/);expect(called).toBe(false);
 const legacyTicket=f.box.contactAuthorizations.hold({operationId:randomUUID(),source:"other",target:"target",sourceGeneration:"o",targetGeneration:"t",verb:"send_to_instance",origin:{kind:"unknown",people:[],receiptIds:[],chain:[]},message:"legacy",correlationId:"old",resultRecipient:"other",payload:{content:"legacy"}});
 expect(()=>g.decide(legacyTicket.id,{revision:1,decision:"approve-once"},manager,0,"0".repeat(64))).toThrow(/scoped/);
});
it("matching grants atomically use once and release only their proven request root",()=>{
 const f=rig(),g=f.gate(),first=f.input(),ticket=f.hold(g,first);
 f.approve(g,ticket.id,{expiresAt:new Date(Date.now()+86400_000).toISOString(),remainingUses:1});
 const independent=f.input();const admitted=g.admit(independent.delivery,independent.context,independent.binding);
 expect(admitted.delivery.deliveryId).toBeTruthy();expect(f.box.contactAuthorizations.policy("target","target-v1").grants[0]?.remainingUses).toBe(0);
 expect(f.hold(g,f.input()).state).toBe("pending");
 expect(g.admit(independent.delivery,independent.context,independent.binding).delivery.deliveryId).toBe(admitted.delivery.deliveryId);
});
it("an admission failure rolls back ticket, optional grant, policy audit and D1",()=>{
 const f=rig(),g=f.gate(),i=f.input(),ticket=f.hold(g,i),before=f.box.contactAuthorizations.histories("target");
 const admit=vi.spyOn(f.box,"admitWithRequestContext").mockImplementationOnce(()=>{throw Error("synthetic commit failure");});
 expect(()=>f.approve(g,ticket.id,{expiresAt:new Date(Date.now()+86400_000).toISOString(),remainingUses:1})).toThrow(/commit failure/);
 expect(f.box.contactAuthorizations.get(ticket.id)?.state).toBe("pending");expect(f.box.contactAuthorizations.policy("target","target-v1").grants).toEqual([]);
 expect(f.box.contactAuthorizations.histories("target")).toEqual(before);expect(f.box.listPending()).toHaveLength(0);admit.mockRestore();
 expect(f.approve(g,ticket.id).deliveryId).toBeTruthy();
});
it("same-root sweep isolates one stale target and still continues its current sibling",()=>{
 const f=rig(),g=f.gate(),c=f.context(),first=f.hold(g,f.input(c)),bad=f.hold(g,f.input(c,randomUUID(),"bad")),good=f.hold(g,f.input(c,randomUUID(),"good"));
 f.approve(g,first.id);f.host.current=(_c:any,b:any)=>b.target.instance!=="bad";
 const result=g.reevaluate(c.ref.rootContextId);expect(result.approved.map(t=>t.id)).toEqual([good.id]);expect(result.refused.map(t=>t.ticketId)).toEqual([bad.id]);
 expect(f.box.contactAuthorizations.get(bad.id)?.state).toBe("pending");expect(f.box.listPending()).toHaveLength(2);
});
it("correlation returns and lifetime origins never supply a scoped release",()=>{
 const f=rig(),g=f.gate();for(const name of ["approvedReturn","origin","inheritOrigin"]as const)vi.spyOn(f.box.contactAuthorizations,name).mockImplementation(()=>{throw Error("forbidden lifetime/correlation read");});
 expect(f.hold(g,f.input()).state).toBe("pending");expect(g.sweep()).toEqual({approved:[],refused:[]});
});
it("ordinary pruning skips retained bound deliveries and still prunes unrelated legacy rows",async()=>{
 const f=rig(),g=f.gate(),i=f.input(),ticket=f.hold(g,i),approved=f.approve(g,ticket.id),old="2000-01-01T00:00:00.000Z";
 const legacy=f.box.admit({...i.delivery,operationId:"legacy",sourceKey:"legacy",payload:{content:"legacy"}}).delivery;
 const db=f.raw();db.prepare("UPDATE deliveries SET state='delivered',finished_at=?,updated_at=?").run(old,old);
 const pruned=await f.box.prune(30);expect(pruned.pruned).toBe(1);expect(f.box.get(approved.deliveryId!)).not.toBeNull();expect(f.box.get(legacy.deliveryId)).toBeUndefined();
 expect(f.box.requestContextOperation(i.delivery.sourceInstance,i.delivery.operationId)?.deliveryId).toBe(approved.deliveryId);
});
it("explicit drained-root retirement removes ticket, proof and terminal delivery together after retention",()=>{
 const f=rig(),g=f.gate(),i=f.input(),ticket=f.hold(g,i),approved=f.approve(g,ticket.id);
 expect(()=>g.retireRoot(i.context.ref.rootContextId)).toThrow(/not drained/);
 f.host.rootRetired=()=>true;expect(()=>g.retireRoot(i.context.ref.rootContextId)).toThrow(/retention/);
 const db=f.raw(),old="2000-01-01T00:00:00.000Z";
 db.prepare("UPDATE deliveries SET state='delivered',finished_at=?,updated_at=?").run(old,old);
 db.prepare("UPDATE contact_auth_tickets SET ticket_json=json_set(ticket_json,'$.decidedAt',?,'$.createdAt',?,'$.expiresAt',?)").run(old,old,old);
 expect(g.retireRoot(i.context.ref.rootContextId)).toBe(1);
 expect(f.box.requestContext(i.context.ref.contextId)).toBeNull();expect(f.box.contactAuthorizations.get(ticket.id)).toBeUndefined();expect(f.box.get(approved.deliveryId!)).toBeUndefined();
});

it("scoped outcome notices and markers roll back together, then announce once without authority",()=>{
 const f=rig(),g=f.gate(),ticket=f.hold(g,f.input());g.decide(ticket.id,{revision:ticket.revision,decision:"decline"},manager,0,g.snapshot(ticket.id).imageSha256);
 expect(()=>f.box.contactAuthorizations.notifyOutcomes(t=>{f.box.admitSystemNotice(t.source,`outcome:${t.id}`,"Synthetic informational outcome");throw Error("notice commit failed");})).toThrow(/commit failed/);
 expect(f.box.listPending()).toHaveLength(0);
 const send=(t:any)=>{f.box.admitSystemNotice(t.source,`outcome:${t.id}`,"Synthetic informational outcome");};
 expect(f.box.contactAuthorizations.notifyOutcomes(send)).toBe(1);expect(f.box.contactAuthorizations.notifyOutcomes(send)).toBe(0);
 const rows=f.box.listPending();expect(rows).toHaveLength(1);expect(f.box.requestContextForDelivery(rows[0]!.deliveryId)).toBeNull();
});
it("legacy age pruning preserves referenced scoped tickets and their original D1 proof",()=>{
 const f=rig(),g=f.gate(),i=f.input(),ticket=f.hold(g,i);f.approve(g,ticket.id);const db=f.raw();
 db.prepare("UPDATE contact_auth_tickets SET created_at=0").run();f.hold(g,f.input());
 expect(f.box.contactAuthorizations.get(ticket.id)?.state).toBe("approved");
 const next=f.input(i.context);expect(g.admit(next.delivery,next.context,next.binding).delivery.deliveryId).toBeTruthy();
});
it("files-only and boot-only changes conflict even when the legacy ticket hash would match",()=>{
 const f=rig(),g=f.gate(),i=f.input();f.hold(g,i);
 for(const delivery of [{...i.delivery,payload:{...i.delivery.payload,files:[{name:"different.txt",sha256:"b".repeat(64)}]}},{...i.delivery,sourceDaemonBootId:"new-boot"}]) {
  expect(()=>g.admit(delivery,i.context,{...i.binding,payloadSha256:requestContextDigest(delivery.payload)})).toThrow(/conflict/);
 }
});
it("a non-native Hub actor and unknown actor cannot match a native standing grant",()=>{
 const f=rig(),g=f.gate();for(const actor of [{kind:"unknown",reason:"unidentified"},{kind:"person",platform:"hub",hubId:"demo-hub",id:"demo-person",displayName:"Demo manager"}]as const){
  const base=f.context(actor.kind==="unknown"?"guest":"hub"),c={...base,initiatingActor:actor};
  const ticket=f.hold(g,f.input(c));expect(ticket.origin.kind).toBe("unknown");
  expect(()=>f.approve(g,ticket.id,{expiresAt:new Date(Date.now()+86400_000).toISOString(),remainingUses:null})).toThrow(/invalid-grant-origin/);
 }
});

it("two SQLite connections keep one scoped decision and exact delivery",()=>{
 const f=rig(),g=f.gate(),i=f.input(),ticket=f.hold(g,i);
 const second=new DeliveryOutbox(f.file,"fixture-two",{requestContextDispatchVersion:1});cleanup.push(()=>second.close());
 const other=second.requestContactGate(f.host);const approved=f.approve(g,ticket.id);
 expect(()=>other.decide(ticket.id,{revision:ticket.revision,decision:"approve-once"},manager,0,other.snapshot(ticket.id).imageSha256)).toThrow(/already-decided/);
 expect(other.admit(i.delivery,i.context,i.binding).delivery.deliveryId).toBe(approved.deliveryId);expect(second.listPending()).toHaveLength(1);
});
it("failed automatic grant use consumes nothing and a true retry then consumes exactly once",()=>{
 const f=rig(),g=f.gate(),first=f.input(),ticket=f.hold(g,first);f.approve(g,ticket.id,{expiresAt:new Date(Date.now()+86400_000).toISOString(),remainingUses:1});
 const next=f.input(),admit=vi.spyOn(f.box,"admitWithRequestContext").mockImplementationOnce(()=>{throw Error("automatic admission failed");});
 expect(()=>g.admit(next.delivery,next.context,next.binding)).toThrow(/admission failed/);
 expect(f.box.requestContext(next.context.ref.contextId)).toBeNull();expect(f.box.contactAuthorizations.policy("target","target-v1").grants[0]?.remainingUses).toBe(1);
 admit.mockRestore();g.admit(next.delivery,next.context,next.binding);g.admit(next.delivery,next.context,next.binding);
 expect(f.box.contactAuthorizations.policy("target","target-v1").grants[0]?.remainingUses).toBe(0);expect(f.box.listPending()).toHaveLength(2);
});
it("a bounded re-evaluation leaves the rest for the next sweep",()=>{
 const f=rig(),g=f.gate(),c=f.context(),first=f.hold(g,f.input(c));f.hold(g,f.input(c));f.hold(g,f.input(c));f.approve(g,first.id);
 expect(g.reevaluate(c.ref.rootContextId,1).approved).toHaveLength(1);expect(g.sweep(1).approved).toHaveLength(1);expect(g.sweep()).toEqual({approved:[],refused:[]});expect(f.box.listPending()).toHaveLength(3);
});
it("a forged child actor cannot replace the restricted root initiator with a later administrator",()=>{
 const f=rig(),g=f.gate(),i=f.input();f.hold(g,i);
 const child:any={...i.context,ref:{version:1,contextId:randomUUID(),rootContextId:i.context.ref.rootContextId,parentContextId:i.context.ref.contextId},initiatingActor:{kind:"person",platform:"discord",userId:manager.userId},source:{instance:"other",incarnation:"other-v1"}};
 f.admin(true);const changed=f.input(child);expect(()=>g.admit(changed.delivery,child,changed.binding)).toThrow(/lineage conflict/);
});

it("an operation's policy becoming stale at admission rolls back the exact delivery and approval",()=>{
 const f=rig(),g=f.gate(),ticket=f.hold(g,f.input()),real=f.box.admitWithRequestContext.bind(f.box);
 vi.spyOn(f.box,"admitWithRequestContext").mockImplementationOnce((...args)=>{const result=real(...args);f.current(false);return result;});
 expect(()=>f.approve(g,ticket.id)).toThrow(/no longer current/);expect(f.box.listPending()).toHaveLength(0);expect(f.box.contactAuthorizations.get(ticket.id)?.state).toBe("pending");
});
it("a changing drained-root proof rolls retirement back without deleting the root or delivery",()=>{
 const f=rig(),g=f.gate(),i=f.input(),ticket=f.hold(g,i),approved=f.approve(g,ticket.id),db=f.raw(),old="2000-01-01T00:00:00.000Z";
 db.prepare("UPDATE deliveries SET state='delivered',finished_at=?,updated_at=?").run(old,old);
 db.prepare("UPDATE contact_auth_tickets SET ticket_json=json_set(ticket_json,'$.decidedAt',?,'$.createdAt',?,'$.expiresAt',?)").run(old,old,old);
 let reads=0;f.host.rootRetired=()=>++reads===1;
 expect(()=>g.retireRoot(i.context.ref.rootContextId)).toThrow(/retirement changed/);
 expect(f.box.requestContext(i.context.ref.contextId)).not.toBeNull();expect(f.box.contactAuthorizations.get(ticket.id)?.deliveryId).toBe(approved.deliveryId);expect(f.box.get(approved.deliveryId!)).toBeTruthy();
});

it("a changed retained request cannot alter a scoped decision's target, grant or delivered bytes",()=>{
 const f=rig(),g=f.gate(),ticket=f.hold(g,f.input()),db=f.raw();
 db.prepare("UPDATE contact_auth_tickets SET request_json=json_set(request_json,'$.payload.content','forged') WHERE id=?").run(ticket.id);
 expect(()=>f.approve(g,ticket.id)).toThrow(/companion unavailable/);expect(f.box.listPending()).toHaveLength(0);
});

it("a refused pending operation rotates so the next bounded tick reaches a current sibling",()=>{
 const f=rig(),g=f.gate(),c=f.context(),first=f.hold(g,f.input(c)),bad=f.hold(g,f.input(c,randomUUID(),"bad")),good=f.hold(g,f.input(c,randomUUID(),"good"));f.approve(g,first.id);
 f.host.current=(_c,b)=>b.target.instance!=="bad";
 expect(g.reevaluate(c.ref.rootContextId,1).refused.map(t=>t.ticketId)).toEqual([bad.id]);
 expect(g.reevaluate(c.ref.rootContextId,1).approved.map(t=>t.id)).toEqual([good.id]);
});

it.each(["en","zh-TW"]as const)("terminal retry says declined or expired, never waiting, in %s",locale=>{
 setLocale(locale);
 for(const state of ["declined","expired"]as const){
  const f=rig(),g=f.gate(),i=f.input(),ticket=f.hold(g,i);
  if(state==="declined")g.decide(ticket.id,{revision:ticket.revision,decision:"decline"},manager,0,g.snapshot(ticket.id).imageSha256);
  else f.raw().prepare("UPDATE contact_auth_tickets SET ticket_json=json_set(ticket_json,'$.expiresAt',?) WHERE id=?").run("2000-01-01T00:00:00.000Z",ticket.id);
  let caught:unknown;try{g.admit(i.delivery,i.context,i.binding);}catch(error){caught=error;}
  expect(caught).toBeInstanceOf(ContactHeldError);const result=(caught as ContactHeldError).result;
  expect(result.authorization_state).toBe(state);expect(result.message).toBe(tForLocale(locale,state==="declined"?"contact.noticeDeclined":"contact.noticeExpired",ticket.id,ticket.target));
  expect(result.message).not.toBe(tForLocale(locale,"contact.heldAgent"));expect(f.box.listPending()).toHaveLength(0);
 }
});
it("the retirement boundary resolves an unread expired ticket before its terminal retention check",()=>{
 const f=rig(),g=f.gate(),i=f.input(),ticket=f.hold(g,i),db=f.raw(),old="2000-01-01T00:00:00.000Z";
 db.prepare("UPDATE contact_auth_tickets SET ticket_json=json_set(ticket_json,'$.createdAt',?,'$.expiresAt',?) WHERE id=?").run(old,old,ticket.id);
 expect(JSON.parse((db.prepare("SELECT ticket_json FROM contact_auth_tickets WHERE id=?").get(ticket.id)as {ticket_json:string}).ticket_json).state).toBe("pending");
 // Direct internal retirement port: no earlier gate/read is allowed to perform its expiry work for it.
 expect((f.box as any).retireRequestContextRoot(i.context.ref.rootContextId,()=>true)).toBe(0);
 expect(f.box.contactAuthorizations.get(ticket.id)).toBeUndefined();expect(f.box.requestContext(i.context.ref.contextId)).toBeNull();
});
it("already-pending work preserves its decision after promotion; new operations use the current admin exception",()=>{
 const f=rig(),g=f.gate(),i=f.input(),held=f.hold(g,i);f.admin(true);
 expect(f.hold(g,i).id).toBe(held.id);expect(g.sweep().approved).toEqual([]);expect(g.reevaluate(i.context.ref.rootContextId).approved).toEqual([]);
 const next=f.input(i.context);expect(g.admit(next.delivery,next.context,next.binding).inserted).toBe(true);
 expect(f.box.contactAuthorizations.get(held.id)?.state).toBe("pending");f.admin(false);expect(f.hold(g,f.input(i.context)).state).toBe("pending");
});
it("the legacy-adoption probe uses its scoped-only expression index",()=>{
 const f=rig();f.gate();const plan=f.raw().prepare("EXPLAIN QUERY PLAN SELECT 1 FROM contact_auth_tickets WHERE json_extract(request_json,'$.source')=? AND json_extract(request_json,'$.operationId')=? LIMIT 1").all("source","operation") as Array<{detail:string}>;
 expect(plan.some(row=>row.detail.includes("request_context_contact_legacy_operation_v1"))).toBe(true);
});

it("ordinary native root contact stays normal after demotion, but current-access removal refuses its next operation",()=>{
 const f=rig(),g=f.gate(),root=f.context("owner");f.admin(true);
 const first=f.input(root);expect(g.admit(first.delivery,root,first.binding).inserted).toBe(true);
 f.admin(false);const next=f.input(root);expect(g.admit(next.delivery,root,next.binding).inserted).toBe(true);
 expect(f.box.contactAuthorizations.pending()).toHaveLength(0);
 f.current(false);const removed=f.input(root);
 expect(()=>g.admit(removed.delivery,root,removed.binding)).toThrow("request-context contact is no longer current");
 expect(f.box.listPending()).toHaveLength(2);expect(f.box.contactAuthorizations.pending()).toHaveLength(0);
 expect(root.initiatingActor).toEqual({kind:"person",platform:"discord",userId:"demo-person"});
});

it("a Free source switched to Restricted holds its next new operation without relabelling its root",()=>{
 const f=rig(),g=f.gate(),root=f.context("free-room");let restricted=false;f.host.sourceRestricted=()=>restricted;
 const before=f.input(root);expect(g.admit(before.delivery,root,before.binding).inserted).toBe(true);
 restricted=true;const later=f.input(root),ticket=f.hold(g,later);expect(ticket.state).toBe("pending");
 expect(f.box.requestContext(root.ref.contextId)?.ingress).toBe("free-room");
 f.admin(true);const asAdmin=f.input(root);expect(g.admit(asAdmin.delivery,root,asAdmin.binding).inserted).toBe(true);
 expect(f.hold(g,later).id).toBe(ticket.id); // preserve-pending, even after promotion
 f.admin(false);restricted=false;const freeAgain=f.input(root);expect(g.admit(freeAgain.delivery,root,freeAgain.binding).inserted).toBe(true);
 expect(f.box.requestContext(root.ref.contextId)).toEqual(root);
});
it("current Free room permission allows new contact without relabelling Restricted provenance",()=>{
 const f=rig(),g=f.gate(),root=f.context("restricted-room");f.host.sourceRestricted=()=>false;
 const next=f.input(root);expect(g.admit(next.delivery,root,next.binding).inserted).toBe(true);expect(f.box.requestContext(root.ref.contextId)?.ingress).toBe("restricted-room");
});
it("an unavailable current-room basis cannot turn an unknown restricted root into Free work",()=>{
 const f=rig(),g=f.gate(),root={...f.context("restricted-room"),initiatingActor:{kind:"unknown" as const,reason:"unproved-recovery" as const}};f.host.sourceRestricted=()=>undefined;
 expect(f.hold(g,f.input(root)).state).toBe("pending");expect(f.box.requestContext(root.ref.contextId)?.ingress).toBe("restricted-room");
});
