/** Actual dormant C/D/E registries and SQLite. No process, account or remote host. */
import { PassThrough } from "node:stream";
import { NativeMcpSessions } from "../src/native-mcp.js";
import { captureRequestContextCall } from "../src/request-context-call.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DeliveryOutbox, deliveryContentDigest, type NewOutboxDelivery } from "../src/delivery-outbox.js";
import { RequestContextReferenceMap } from "../src/request-context-fence.js";
import { REQUEST_CONTEXT_DRAIN_FAMILIES } from "../src/request-context-drain.js";
import { RequestContextLocalTurns, type PreparedRequestContextInput, type RequestContextRuntimeOwner, type RequestContextTurnSnapshot } from "../src/request-context-turns.js";
import { RequestContextPaneProofs } from "../src/request-context-pane.js";
import { requestContextDigest, RequestContextStore } from "../src/request-context-store.js";
import { ContactHeldError } from "../src/contact-auth-service.js";
import type { RequestContextV1, RequestOperationBindingV1 } from "../src/request-context-protocol.js";
const cleanup:Array<()=>void>=[];
afterEach(()=>{vi.unstubAllEnvs();for(const fn of cleanup.splice(0).reverse())fn();});
const owner:RequestContextRuntimeOwner={instance:"source",incarnation:"source-v1",workGeneration:"work",daemonBootId:"boot",spawnGeneration:1,launchFenceEpoch:0,deliveryEpoch:0};
function rig(active=true){
 const dir=mkdtempSync(join(tmpdir(),"s226-drain-"));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
 const box=new DeliveryOutbox(join(dir,"outbox.db"),"fixture",active?{requestContextDispatchVersion:1}:{});cleanup.push(()=>box.close());if(active)box.activateRequestContextBarrier();
 const db=(box as any).db;let currentOwner:string|null="coordinator-a";
 const drain=()=>box.requestContextDrain(()=>currentOwner);
 const context=(ingress:RequestContextV1["ingress"]="owner"):RequestContextV1=>{const id=randomUUID();return {ref:{version:1,contextId:id,rootContextId:id},ingress,rootEvidenceRef:"fixture-input",initiatingActor:{kind:"person",platform:"discord",userId:"demo-person"},source:{instance:"source",incarnation:"source-v1"},sourceAudience:{kind:"room",ref:randomUUID()}};};
 const admit=(c=context())=>{
 const operationId=randomUUID(),delivery:NewOutboxDelivery={operationId,sourceKey:`fixture:${operationId}`,sourceInstance:"source",sourceDaemonBootId:"boot",targetInstance:"target",kind:"fleet_inbound",payload:{content:"Synthetic request"}};
 const binding:RequestOperationBindingV1={version:1,operationId,contextId:c.ref.contextId,rootContextId:c.ref.rootContextId,source:c.source,target:{instance:"target",incarnation:"target-v1"},verb:"send_to_instance",payloadSha256:requestContextDigest(delivery.payload)};
 return {c,delivery,binding,result:box.admitWithRequestContext(delivery,c,binding)};};
 const terminal=(id:string)=>db.prepare("UPDATE deliveries SET state='delivered',finished_at='2000-01-01T00:00:00Z',updated_at='2000-01-01T00:00:00Z' WHERE delivery_id=?").run(id);
 return {box,db,drain,context,admit,terminal,owner:(v:string|null)=>{currentOwner=v;}};
}
/** Fixture owners stand in ONLY for later slices; no production assembly installs these. */
function participants(d:ReturnType<ReturnType<typeof rig>["drain"]>){
 const maps=new Map<string,RequestContextReferenceMap<string,string>>(),remove=new Map<string,()=>void>();
 for(const family of REQUEST_CONTEXT_DRAIN_FAMILIES){const gate=d.registration(),map=new RequestContextReferenceMap<string,string>(v=>v,(_,k)=>k);map.installRegistration(gate);maps.set(family,map);
 remove.set(family,d.register(family,family,{registration:gate,revision:()=>map.revision,inspect:root=>map.view(root)}));}
 return {maps,remove};
}
it("OFF cannot construct or install a drain fence",()=>{const f=rig(false);expect(()=>f.drain()).toThrow(/not ready/);expect(f.db.prepare("SELECT name FROM sqlite_master WHERE name='request_context_drain_v1'").get()).toBeUndefined();});
it("requires all families and never equates an uninstalled owner with empty",()=>{
 const f=rig(),i=f.admit();f.terminal(i.result.delivery.deliveryId);const d=f.drain(),epoch=d.fence(i.c.ref.rootContextId);
 expect(d.inspect(i.c.ref.rootContextId,epoch).blockers).toContain("missing:turns");expect(()=>d.prove(i.c.ref.rootContextId,epoch)).toThrow(/not drained/);
 const p=participants(d);expect(d.prove(i.c.ref.rootContextId,epoch).current()).toBe(true);p.remove.get("registered-work")!();expect(()=>d.prove(i.c.ref.rootContextId,epoch)).toThrow(/missing:registered-work/);
});
it.each(REQUEST_CONTEXT_DRAIN_FAMILIES)("a live %s reference blocks its root and its removal advances the revision",family=>{
 const f=rig(),i=f.admit();f.terminal(i.result.delivery.deliveryId);const d=f.drain(),p=participants(d),root=i.c.ref.rootContextId,map=p.maps.get(family)!;
 map.set("owned-reference",root);const epoch=d.fence(root);expect(d.inspect(root,epoch).blockers.some(b=>b.includes("owned-reference"))).toBe(true);expect(()=>d.prove(root,epoch)).toThrow(/not drained/);
 const before=map.revision;map.delete("owned-reference");expect(map.revision).not.toBe(before);expect(d.prove(root,epoch).current()).toBe(true);expect(()=>map.set("late",root)).toThrow(/draining/);
});
it("revision ABA, participant removal, owner change and fence release invalidate a minted proof",()=>{
 const f=rig(),i=f.admit();f.terminal(i.result.delivery.deliveryId);const d=f.drain(),p=participants(d),root=i.c.ref.rootContextId,epoch=d.fence(root);
 const a=d.prove(root,epoch),map=p.maps.get("fleet-calls")!;map.set("other",randomUUID());map.delete("other");expect(a.current()).toBe(false);
 const b=d.prove(root,epoch);f.owner("coordinator-b");expect(b.current()).toBe(false);f.owner("coordinator-a");const c=d.prove(root,epoch);p.remove.get("registered-work")!();expect(c.current()).toBe(false);
});
it("a released fence invalidates proof and permits only the still-retained root again",()=>{
 const f=rig(),i=f.admit();f.terminal(i.result.delivery.deliveryId);const d=f.drain(),p=participants(d),root=i.c.ref.rootContextId,epoch=d.fence(root),proof=d.prove(root,epoch);
 d.release(root,epoch);expect(proof.current()).toBe(false);expect(()=>p.maps.get("turns")!.set("new",root)).not.toThrow();
});
it("a producer which used an owned gate but has no registered inventory refuses proof",()=>{
 const f=rig(),i=f.admit();f.terminal(i.result.delivery.deliveryId);const d=f.drain();participants(d);const unregistered=d.registration();unregistered.assertRegistration(i.c.ref.rootContextId);
 const epoch=d.fence(i.c.ref.rootContextId);expect(d.inspect(i.c.ref.rootContextId,epoch).blockers).toContain("unregistered-producer");
});
it("pending delivery and durable recovery pointer independently block retirement",()=>{
 const f=rig(),i=f.admit(),d=f.drain();participants(d);const root=i.c.ref.rootContextId,epoch=d.fence(root);
 expect(d.inspect(root,epoch).blockers).toContain(`delivery:${i.result.delivery.deliveryId}`);f.terminal(i.result.delivery.deliveryId);
 f.db.exec("CREATE TABLE request_context_recovery_v1(pointer_json TEXT)");f.db.prepare("INSERT INTO request_context_recovery_v1 VALUES (?)").run(JSON.stringify({contextId:root}));
 expect(d.inspect(root,epoch).blockers).toContain("recovery-pointer");
});
it("actual C input registration is fenced, while independent roots remain writable",()=>{
 const f=rig(),i=f.admit(),root=i.c.ref.rootContextId,d=f.drain(),registration=d.registration(),inputs=new Map<string,PreparedRequestContextInput>();
 let retains=0;const turns=new RequestContextLocalTurns({registration,input:id=>inputs.get(id)??null,context:id=>f.box.requestContext(id),retain:c=>{retains++;new RequestContextStore(f.db).recordContext(c);},canManage:()=>true,recovery:()=>null,saveRecovery:()=>{}});
 const prepare=(id:string,c:RequestContextV1)=>{const wireSha256=deliveryContentDigest("input");inputs.set(id,{inputId:id,wireSha256,owner,context:c,proof:{kind:"independent"}});return wireSha256;};
 // Context is retained before mint; this control tests C's real fence before its retain callback.
 const snapshot=turns.beforeWrite("a",prepare("a",i.c),owner);expect(turns.drainView(root).references).toHaveLength(1);turns.ended(snapshot,owner);
 const before=turns.drainRevision;d.fence(root);expect(()=>turns.beforeWrite("a2",prepare("a2",i.c),owner)).toThrow(/draining/);expect(turns.drainRevision).toBe(before);expect(retains).toBe(1);
 const other=f.admit().c;expect(()=>turns.beforeWrite("b",prepare("b",other),owner)).not.toThrow();
});
it("actual pane proofs retain ended-turn references until exact launch retirement; fencing refuses a mint",()=>{
 const f=rig(),i=f.admit(),root=i.c.ref.rootContextId,d=f.drain(),gate=d.registration(),proofs=new RequestContextPaneProofs("synthetic-proof-key".repeat(4),gate);
 const pane={hostBootId:randomUUID(),paneId:randomUUID(),launchId:randomUUID(),agentId:randomUUID(),instance:"source"};
 const snapshot:RequestContextTurnSnapshot={token:randomUUID(),inputId:"input",wireSha256:"a".repeat(64),owner,context:i.c};
 const stamp=proofs.mint(pane,snapshot,()=>true);expect(proofs.drainView(root).references).toHaveLength(1);d.fence(root);expect(()=>proofs.mint(pane,snapshot,()=>true)).toThrow(/draining/);
 proofs.retire({...pane,launchId:randomUUID()});expect(proofs.drainView(root).references).toHaveLength(1);proofs.retire(pane);expect(proofs.drainView(root).references).toEqual([]);expect(()=>proofs.resolve(pane,stamp)).toThrow(/unavailable/);
});
it("E retirement consumes a current certificate atomically and leaves a non-reopenable tombstone",()=>{
 const f=rig(),i=f.admit();f.terminal(i.result.delivery.deliveryId);const d=f.drain();participants(d);const root=i.c.ref.rootContextId,epoch=d.fence(root),proof=d.prove(root,epoch);
 const gate=f.box.requestContactGate({current:()=>true,canDecide:()=>true,canManage:()=>true,adminOf:()=>false,person:()=>null,rootRetired:()=>proof.current()});
 expect(gate.retireRoot(root)).toBe(1);expect(f.box.requestContext(root)).toBeNull();expect(()=>d.release(root,epoch)).toThrow(/cannot reopen/);expect(()=>f.admit(i.c)).toThrow(/draining/);
});
it("E rolls back all retirement writes if a registry changes during its transaction",()=>{
 const f=rig(),i=f.admit();f.terminal(i.result.delivery.deliveryId);const d=f.drain(),p=participants(d),root=i.c.ref.rootContextId,epoch=d.fence(root),proof=d.prove(root,epoch);let checks=0;
 const gate=f.box.requestContactGate({current:()=>true,canDecide:()=>true,canManage:()=>true,adminOf:()=>false,person:()=>null,rootRetired:()=>{if(++checks===2)p.maps.get("registered-work")!.clear();return proof.current();}});
 expect(()=>gate.retireRoot(root)).toThrow(/changed/);expect(f.box.requestContext(root)).not.toBeNull();expect(f.box.get(i.result.delivery.deliveryId)).toBeDefined();
});
it("an unread expired hold is logically terminal for drain and E resolves it during retirement",()=>{
 const f=rig(),c=f.context("guest"),operationId=randomUUID(),delivery:NewOutboxDelivery={operationId,sourceKey:operationId,sourceInstance:"source",sourceDaemonBootId:"boot",targetInstance:"target",kind:"fleet_inbound",payload:{content:"synthetic held"}},binding:RequestOperationBindingV1={version:1,operationId,contextId:c.ref.contextId,rootContextId:c.ref.rootContextId,source:c.source,target:{instance:"target",incarnation:"target-v1"},verb:"send_to_instance",payloadSha256:requestContextDigest(delivery.payload)};
 let certificate:{current():boolean}|null=null;
 const gate=f.box.requestContactGate({current:()=>true,canDecide:()=>true,canManage:()=>true,adminOf:()=>false,person:()=>null,rootRetired:()=>certificate?.current()??false});
 expect(()=>gate.admit(delivery,c,binding)).toThrow(ContactHeldError);const d=f.drain();participants(d);const epoch=d.fence(c.ref.rootContextId);
 expect(d.inspect(c.ref.rootContextId,epoch).blockers.some(b=>b.startsWith("held:"))).toBe(true);
 f.db.prepare("UPDATE contact_auth_tickets SET ticket_json=json_set(ticket_json,'$.createdAt','2000-01-01T00:00:00Z','$.expiresAt','2000-01-01T00:00:00Z')").run();
 certificate=d.prove(c.ref.rootContextId,epoch);expect(gate.retireRoot(c.ref.rootContextId)).toBe(0);expect(f.box.requestContext(c.ref.contextId)).toBeNull();
});
it("a durable recovery pointer cannot be newly attached to a fenced root",()=>{
 const f=rig(),i=f.admit(f.context("guest")),store=f.box.requestContextRecovery,pointer={instance:"source",incarnation:"source-v1",workGeneration:"work",contextId:i.c.ref.contextId};
 const d=f.drain();d.fence(i.c.ref.rootContextId);expect(()=>store.save("source",pointer)).toThrow(/draining/);
});

it("a native grant's actual pending call retains the root after grant close until its own result settles",async()=>{
 vi.stubEnv("AGEND_WINDOWS_CLI","1");const f=rig(),i=f.admit(),d=f.drain(),registration=d.registration(),agentId=randomUUID(),name=`windows-${agentId}`;
 let entered!:()=>void,release!:(v:unknown)=>void;const enteredPromise=new Promise<void>(done=>{entered=done;}),waiting=new Promise<unknown>(done=>{release=done;});
 const ctx:any={fleetConfig:{defaults:{},instances:{[name]:{runtime:"windows",native_agent_id:agentId,backend:"codex",native_sandbox:"workspace-write",tool_set:"worker",working_directory:"C:\\Scratch"}}},handleTaskCrudHttp:()=>{entered();return waiting;}};
 const sessions=new NativeMcpSessions(ctx,registration);cleanup.push(()=>sessions.closeAll());
 const c={...i.c,source:{instance:name,incarnation:"source-v1"}},snapshot:RequestContextTurnSnapshot={token:randomUUID(),inputId:"input",wireSha256:"a".repeat(64),owner:{...owner,instance:name},context:c};
 const scope=captureRequestContextCall(snapshot,()=>true),grant=()=>sessions.grant({instance:name,requestId:randomUUID(),sandbox:"workspace-write",endpoint:"http://127.0.0.1:19280/agent",stillCurrent:()=>true,requestContext:scope}),lease=grant();
 const req=Object.assign(new PassThrough(),{method:"POST",url:"/agent",headers:{"x-agend-native-token":lease.connection.token},socket:{remoteAddress:"127.0.0.1"}});
 let finished!:()=>void;const done=new Promise<void>(resolve=>{finished=resolve;}),res:any={destroyed:false,writableEnded:false,writeHead:vi.fn(),end:()=>{res.writableEnded=true;finished();}};
 sessions.handleRequest(req as any,res);req.end(JSON.stringify({op:"native-mcp",method:"tools/call",callId:randomUUID(),params:{name:"task",arguments:{action:"list"}}}));
 await enteredPromise;expect(sessions.drainView(i.c.ref.rootContextId).references).toHaveLength(2);lease.close();expect(sessions.drainView(i.c.ref.rootContextId).references).toHaveLength(1);
 d.fence(i.c.ref.rootContextId);expect(()=>grant()).toThrow(/draining/);release({items:[]});await done;expect(sessions.drainView(i.c.ref.rootContextId).references).toEqual([]);
});
it("a fenced hold may still be declined, while approval cannot create work or consume a grant",()=>{
 const f=rig(),c=f.context("guest"),operationId=randomUUID(),delivery:NewOutboxDelivery={operationId,sourceKey:operationId,sourceInstance:"source",sourceDaemonBootId:"boot",targetInstance:"target",kind:"fleet_inbound",payload:{content:"held fixture"}},binding:RequestOperationBindingV1={version:1,operationId,contextId:c.ref.contextId,rootContextId:c.ref.rootContextId,source:c.source,target:{instance:"target",incarnation:"target-v1"},verb:"send_to_instance",payloadSha256:requestContextDigest(delivery.payload)};
 const gate=f.box.requestContactGate({current:()=>true,canDecide:()=>true,canManage:()=>true,adminOf:()=>false,person:()=>null});let id="";
 try{gate.admit(delivery,c,binding);}catch(e){if(!(e instanceof ContactHeldError))throw e;id=e.result.authorization_id;}
 const ticket=f.box.contactAuthorizations.get(id)!,admin={platform:"host" as const,adapterId:"host",userId:"operator",label:"Demo admin"};f.drain().fence(c.ref.rootContextId);
 expect(()=>gate.decide(id,{revision:ticket.revision,decision:"approve-once"},admin,0)).toThrow(/draining/);expect(f.box.contactAuthorizations.get(id)?.state).toBe("pending");expect(f.box.listPending()).toEqual([]);
 expect(gate.sweep().approved).toEqual([]);expect(gate.decide(id,{revision:ticket.revision,decision:"decline"},admin,0).state).toBe("declined");
});
