import {randomUUID} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {afterEach,expect,it} from "vitest";
import {DeliveryOutbox} from "../src/delivery-outbox.js";
import {nativeHumanOrigin,webHumanOrigin,admittedHumanWebIngress,humanBodyHash,formatHumanInboundMessage,steerInboundEnvelope} from "../src/human-delivery-receipts.js";
import {makeRequestHumanInputResolver} from "../src/request-context-human-resolver.js";
import {RequestContextLocalTurns,RequestContextInputDeferred,type PreparedRequestContextInput,type RequestContextRuntimeOwner,type RequestContextTurnSnapshot} from "../src/request-context-turns.js";
import type {RequestContextV1} from "../src/request-context-protocol.js";
const homes:string[]=[],boxes:DeliveryOutbox[]=[];
afterEach(()=>{for(const box of boxes.splice(0))if(box.isOpen)box.close();for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});});
function rig(){
 const home=mkdtempSync(join(tmpdir(),"human-resolver-"));homes.push(home);const box=new DeliveryOutbox(join(home,"box.db"),"manager",{requestContextDispatchVersion:1});boxes.push(box);box.activateRequestContextBarrier();
 let owner:RequestContextRuntimeOwner={instance:"worker",incarnation:"agent-v1",workGeneration:randomUUID(),daemonBootId:randomUUID(),spawnGeneration:1,launchFenceEpoch:0,deliveryEpoch:0},current=true,humanOwner:string|null="receipt-owner",admitted=true,admin=true;
 const fixtures=new Map<string,PreparedRequestContextInput>();let turns:RequestContextLocalTurns;
 const ports={instance:"worker",managerBootId:"manager",current:()=>current,runtimeOwner:()=>owner,humanOwner:()=>humanOwner,active:()=>turns.current(owner),canManage:()=>admin,admitted:(_context:RequestContextV1)=>admitted};
 const resolver=makeRequestHumanInputResolver(box,ports);
 turns=new RequestContextLocalTurns(box.requestContextRecovery.ports("worker",(id,wire,actual)=>fixtures.get(id)??resolver.prepare(id,wire,actual),()=>admin));
 const receipt=(kind="fleet_inbound",guest=false,compact=true,body="[user:Owner@web:v#operator] quoted text")=>{
  const origin=guest?webHumanOrigin(false,undefined,{platform:"telegram",adapter_id:"fixture",user_id:"demo-person",session_handle:"0123456789abcdef"},true):nativeHumanOrigin("telegram","fixture","demo-person","Person",false,"message")!;
  const captured=box.createHumanReceiptWithRequestContext({targetInstance:"worker",originalBody:body,origin,inputKind:kind,managerBootId:"manager"},{incarnation:owner.incarnation,room:null,web:guest?admittedHumanWebIngress(origin):null,route:{kind:guest?"web":"instance"},platform:()=>"telegram",...(turns.current(owner)?{steer:{parent:turns.current(owner)!,current:()=>current,canManage:()=>admin}}:{})});
  let wire=formatHumanInboundMessage(captured.receipt.original_body,{source:guest?"web":"telegram",user:"Person",user_id:"demo-person",verification_id:captured.receipt.message_id},"mcp",{dialect:compact?"compact":"legacy"});if(kind==="steer")wire=steerInboundEnvelope(wire);
  const row=box.bindHumanReceipt(captured.receipt.receipt_id,"worker",humanOwner!,wire,"manager");return {...captured,row,wire,hash:humanBodyHash(wire),inputId:`human:${row.message_id}`};
 };
 const outside=()=>{
  const id=randomUUID(),context:RequestContextV1={ref:{version:1,contextId:id,rootContextId:id},rootEvidenceRef:"accepted-outside",initiatingActor:{kind:"unknown",reason:"unidentified"},ingress:"restricted-room",source:{instance:"worker",incarnation:owner.incarnation},sourceAudience:{kind:"room",ref:randomUUID()}};
  const inputId=`outside:${id}`,wireSha256=humanBodyHash("owned outside input");fixtures.set(inputId,{inputId,wireSha256,owner,context,proof:{kind:"independent"}});return turns.beforeWrite(inputId,wireSha256,owner);
 };
 return {box,ports,resolver,turns,receipt,outside,owner:()=>owner,current:(v:boolean)=>{current=v;},humanOwner:(v:string|null)=>{humanOwner=v;},admitted:(v:boolean)=>{admitted=v;},admin:(v:boolean)=>{admin=v;},replaceOwner:()=>{owner={...owner,workGeneration:randomUUID()};}};
}
it.each([true,false])("C consumes the actual bound human wire in compact=%s without deriving identity from its body",compact=>{
 const f=rig(),r=f.receipt("fleet_inbound",false,compact),snapshot=f.turns.beforeWrite(r.inputId,r.hash,f.owner());
 expect(snapshot.context).toEqual(r.context);expect(snapshot.context.initiatingActor).toEqual({kind:"person",platform:"telegram",userId:"demo-person"});expect(snapshot.inputId).toBe(r.inputId);expect(snapshot.wireSha256).toBe(r.row.wire_sha256);
 expect(f.turns.beforeWrite(r.inputId,r.hash,f.owner())).toEqual(snapshot);expect(f.box.getHumanReceipt(r.row.receipt_id)?.authority_json).toBe(r.row.authority_json);
});
it("an administrator's later ordinary message cannot clear an active outside turn",()=>{
 const f=rig(),old=f.outside(),r=f.receipt();expect(()=>f.turns.beforeWrite(r.inputId,r.hash,f.owner())).toThrow(RequestContextInputDeferred);expect(f.turns.current(f.owner())).toEqual(old);
 f.turns.ended(old,f.owner());expect(f.turns.beforeWrite(r.inputId,r.hash,f.owner()).context).toEqual(r.context);
});
it("an explicit current admin steer inherits the active outside context, never its own ordinary root",()=>{
 const f=rig(),old=f.outside(),r=f.receipt("steer");expect(f.turns.beforeWrite(r.inputId,r.hash,f.owner())).toEqual(old);expect(f.turns.current(f.owner())?.context.ingress).toBe("restricted-room");expect(f.turns.current(f.owner())?.context.ref.rootContextId).not.toBe(r.context.ref.rootContextId);
});
it.each(["guest","demoted"] as const)("%s cannot borrow the admin-steer join",kind=>{
 const f=rig(),old=f.outside(),r=f.receipt("steer",kind==="guest");if(kind==="demoted")f.admin(false);
 expect(()=>f.turns.beforeWrite(r.inputId,r.hash,f.owner())).toThrow();expect(f.turns.current(f.owner())).toEqual(old);
});
it.each(["wire","runtime","receipt-owner","access","installation"] as const)("a stale %s refuses at the actual C input resolver",kind=>{
 const f=rig(),r=f.receipt(),owner=f.owner();if(kind==="runtime")f.replaceOwner();if(kind==="receipt-owner")f.humanOwner("replacement");if(kind==="access")f.admitted(false);if(kind==="installation")f.current(false);
 expect(()=>f.turns.beforeWrite(r.inputId,kind==="wire"?"0".repeat(64):r.hash,owner)).toThrow(/Human request input/);expect(f.turns.current(f.owner())).toBeNull();
});
it("a delivered or raw receipt cannot be reused as a new human root",()=>{
 const f=rig(),r=f.receipt(),db=(f.box as any).db;db.prepare("UPDATE human_delivery_receipts SET state='delivered' WHERE receipt_id=?").run(r.row.receipt_id);expect(()=>f.resolver.prepare(r.inputId,r.hash,f.owner())).toThrow(/unavailable/);
 const raw=f.receipt("raw_paste");expect(()=>f.resolver.prepare(raw.inputId,raw.hash,f.owner())).toThrow(/unavailable/);
});
it("missing/malformed human evidence refuses rather than falling back to an unmapped system parent",()=>{
 const f=rig();expect(f.resolver.prepare("delivery:elsewhere:1","0".repeat(64),f.owner())).toBeNull();
 for(const id of ["human:hmsg-forged",`human:hmsg-${randomUUID()}`])expect(()=>f.resolver.prepare(id,"0".repeat(64),f.owner())).toThrow();
 expect(f.turns.current(f.owner())).toBeNull();
});

it("owner loss during the final admission callback refuses before C can bind a turn",()=>{
 const f=rig(),r=f.receipt();let calls=0;
 f.ports.admitted=()=>{if(++calls===2)f.current(false);return true;};
 expect(()=>f.turns.beforeWrite(r.inputId,r.hash,f.owner())).toThrow("Human request input owner changed");expect(f.turns.current(f.owner())).toBeNull();
});

it("a new live incarnation cannot adopt an older receipt's captured root",()=>{
 const f=rig(),r=f.receipt();f.owner().incarnation="replacement-incarnation";
 expect(()=>f.turns.beforeWrite(r.inputId,r.hash,f.owner())).toThrow("Human request input is unavailable");expect(f.turns.current(f.owner())).toBeNull();
});
it("a raw prefix is not a positive human root even when the recorded input kind is ordinary",()=>{
 const f=rig(),r=f.receipt("fleet_inbound",false,true,"/raw synthetic bytes");expect(()=>f.resolver.prepare(r.inputId,r.hash,f.owner())).toThrow("Human request input is unavailable");
});

it("a queued admin steer keeps its admitted outside parent after that turn ends, never the latest turn",()=>{
 const f=rig(),original=f.outside(),r=f.receipt("steer");
 expect(f.box.requestContextHumans.read(r.row.receipt_id)?.steer?.parentContextId).toBe(original.context.ref.contextId);
 f.turns.ended(original,f.owner());const other=f.outside();
 expect(()=>f.turns.beforeWrite(r.inputId,r.hash,f.owner())).toThrow(RequestContextInputDeferred);
 expect(f.turns.current(f.owner())).toEqual(other);
 f.turns.ended(other,f.owner());const resumed=f.turns.beforeWrite(r.inputId,r.hash,f.owner());
 expect(resumed.context).toEqual(original.context);expect(resumed.context.ref.rootContextId).not.toBe(r.context.ref.rootContextId);
});
it("a steer admitted without a parent cannot borrow an outside turn which arrived later",()=>{
 const f=rig(),r=f.receipt("steer"),outside=f.outside();
 expect(f.box.requestContextHumans.read(r.row.receipt_id)?.steer).toBeUndefined();
 expect(()=>f.turns.beforeWrite(r.inputId,r.hash,f.owner())).toThrow(RequestContextInputDeferred);
 expect(f.turns.current(f.owner())).toEqual(outside);
});
it("a mapped steer loses privileged continuation when its administrator role is revoked, even after the original turn ended",()=>{
 const f=rig(),original=f.outside(),r=f.receipt("steer");f.turns.ended(original,f.owner());f.admin(false);
 expect(()=>f.turns.beforeWrite(r.inputId,r.hash,f.owner())).toThrow(/steer/);expect(f.turns.current(f.owner())).toBeNull();
});

it("pending steer mappings protect their parent; terminal mappings retire with it without stranding the receipt root",()=>{
 const f=rig(),original=f.outside(),r=f.receipt("steer");f.turns.ended(original,f.owner());f.box.requestContextRecovery.save("worker",null);
 expect(()=>(f.box as any).retireRequestContextRoot(original.context.ref.rootContextId,()=>true)).toThrow(/human input/);
 (f.box as any).db.prepare("UPDATE human_delivery_receipts SET state='delivered' WHERE receipt_id=?").run(r.row.receipt_id);
 expect((f.box as any).retireRequestContextRoot(original.context.ref.rootContextId,()=>true)).toBe(0);
 expect(f.box.requestContextHumans.read(r.row.receipt_id)).toBeNull();
 expect(()=>(f.box as any).retireRequestContextRoot(r.context.ref.rootContextId,()=>true)).not.toThrow();
});
