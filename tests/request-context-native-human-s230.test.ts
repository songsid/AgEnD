/** Private outbox fixtures only; no daemon, CLI, worker or live Fleet. */
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {afterEach,expect,it} from "vitest";
import {DeliveryOutbox} from "../src/delivery-outbox.js";
import {nativeHumanOrigin,webHumanOrigin,formatHumanInboundMessage,isHumanPositiveProof} from "../src/human-delivery-receipts.js";
import {claimNativeExecInput,nativeExecInputBytes,NativeExecInputWitness,type NativeExecInputProof} from "../src/native-exec-input.js";
import {createRequestContextExecOwner} from "../src/request-context-exec-owner.js";
import {makeRequestHumanInputResolver} from "../src/request-context-human-resolver.js";
import {RequestContextLocalTurns,type RequestContextRuntimeOwner} from "../src/request-context-turns.js";
const homes:string[]=[],boxes:DeliveryOutbox[]=[];
afterEach(()=>{for(const b of boxes.splice(0))if(b.isOpen)b.close();for(const p of homes.splice(0))rmSync(p,{recursive:true,force:true});});
function rig(active=true,guest=false,body="Exact accepted human question"){
 const home=mkdtempSync(join(tmpdir(),"native-human-s230-"));homes.push(home);const box=new DeliveryOutbox(join(home,"box.db"),"manager",{requestContextDispatchVersion:1});boxes.push(box);if(active)box.activateRequestContextBarrier();
 const owner:RequestContextRuntimeOwner={instance:"worker",incarnation:"agent-v1",daemonBootId:"manager",workGeneration:randomUUID(),spawnGeneration:0,launchFenceEpoch:0,deliveryEpoch:0};
 const origin=guest?webHumanOrigin():nativeHumanOrigin("telegram","fixture","demo-person","Demo person",false,"message")!;
 const receiptInput={targetInstance:"worker",originalBody:body,origin,inputKind:"fleet_inbound",managerBootId:"manager"};
 const receipt=active?box.createHumanReceiptWithRequestContext(receiptInput,{incarnation:owner.incarnation,room:null,web:guest?{guest:true}:null,route:guest?{kind:"web",sessionHandle:"0123456789abcdef"}:{kind:"instance"},platform:()=>"telegram"}).receipt:box.createHumanReceipt(receiptInput);
 const human=formatHumanInboundMessage(body,{source:guest?"web":"telegram",user:"Demo person",user_id:"demo-person",...(guest?{web_guest:"1"}:{}),verification_id:receipt.message_id},"mcp",{dialect:"compact",replyHint:false});
 const task={requestId:randomUUID(),cli:"codex",cwd:"C:\\Fixture",sandbox:"read-only",prompt:`Agent instructions:\nWorker scope\n\nUser task:\n${human}`}as const,options={context:"Exact admitted execution"};
 const claim=claimNativeExecInput(task,options),wire=nativeExecInputBytes(task,options).toString("utf8");let alive=true,checks=0,limit=Infinity;
 const input={receiptId:receipt.receipt_id,instance:"worker",managerBootId:"manager",owner,claim,wire,current:()=>alive&&++checks<=limit};
 const proof=()=>{let out!:NativeExecInputProof;const w=new NativeExecInputWitness(claim,task,options,"stdin-text",wire,p=>out=p);w.spawnedMain();w.stdinFinished();return out;};
 return {box,receipt,input,owner,claim,wire,task,options,proof,lose:()=>alive=false,limit:(n:number)=>{checks=0;limit=n;},prepare:()=>box.prepareRequestContextNativeHumanInput(input)};
}
it("the native run binds the actual C wire and settles one positive receipt without borrowing a daemon",()=>{
 const r=rig(),prepared=r.prepare(),before=r.box.getHumanReceipt(r.receipt.receipt_id)!;
 const resolver=makeRequestHumanInputResolver(r.box,{instance:"worker",managerBootId:"manager",current:prepared.current,runtimeOwner:()=>r.owner,humanOwner:()=>prepared.ownerKey,active:()=>null,canManage:()=>false,admitted:()=>true});
 const turns=new RequestContextLocalTurns(r.box.requestContextRecovery.ports("worker",resolver.prepare,()=>false)),snapshot=turns.beforeWrite(prepared.inputId,prepared.wireSha256,r.owner);
 expect(snapshot.context.rootEvidenceRef).toBe(`human:${r.receipt.message_id}`);expect(snapshot.context.initiatingActor).toMatchObject({kind:"person",platform:"telegram",userId:"demo-person"});expect(before.state).toBe("queued");
 expect(prepared.written(r.proof())).toBe(true);expect(prepared.written(r.proof())).toBe(true);
 const after=r.box.getHumanReceipt(r.receipt.receipt_id)!;expect(after).toMatchObject({state:"delivered",proof_tag:"owned-native-exec",proof_mode:"native_exec",wire_sha256:r.claim.wireSha256});expect(after.authority_json).toBe(before.authority_json);
 expect(r.box.deliveredMessageHours(Date.now()-3_600_000,Date.now()+3_600_000).reduce((sum,row)=>sum+row.count,0)).toBe(1);
 prepared.dispose();expect(()=>prepared.written(r.proof())).toThrow("owner changed");expect(r.box.getHumanReceipt(r.receipt.receipt_id)?.state).toBe("delivered");expect(()=>r.prepare()).toThrow("untouched");
});
it("the pane IPC proof validator and settlement never acquire the native run's owner namespace",()=>{
 const r=rig(),p=r.prepare();const native={receipt_id:r.receipt.receipt_id,verification_id:r.receipt.message_id,wire_sha256:p.wireSha256,owner_key:p.ownerKey,mode:"native_exec",tag:"owned-native-exec"};
 expect(isHumanPositiveProof(native)).toBe(false);expect(r.box.settleHumanReceipt(r.receipt.receipt_id,"worker",p.ownerKey,native,p.ownerKey)).toBe(false);
 expect(r.box.settleHumanReceipt(r.receipt.receipt_id,"worker",p.ownerKey,{...native,mode:"idle_submit",tag:"unique-id-pane"},p.ownerKey)).toBe(false);expect(r.box.getHumanReceipt(r.receipt.receipt_id)?.state).toBe("queued");
});
it.each(["token","wire","transport","owner","manager","incarnation"])("a changed %s refuses native delivery evidence",kind=>{
 const r=rig();if(kind==="manager"){r.input.managerBootId="another-manager";r.input.owner={...r.owner,daemonBootId:"another-manager"};expect(()=>r.prepare()).toThrow("manager changed");return;}
 if(kind==="incarnation"){r.input.owner={...r.owner,incarnation:"another-agent"};expect(()=>r.prepare()).toThrow("unavailable");return;}
 const p=r.prepare(),proof={...r.proof()};if(kind==="owner")r.lose();else if(kind==="token")proof.token=randomUUID();else if(kind==="transport")proof.transport="file";else proof.inputSha256="a".repeat(64);
 expect(()=>p.written(proof)).toThrow();expect(r.box.getHumanReceipt(r.receipt.receipt_id)?.state).toBe("queued");
});
it("the positive write rechecks ownership inside the SQLite commit and rolls back the receipt and count",()=>{
 const r=rig(),p=r.prepare();r.limit(2);expect(()=>p.written(r.proof())).toThrow("owner changed");expect(r.box.getHumanReceipt(r.receipt.receipt_id)?.state).toBe("queued");expect(r.box.deliveredMessageHours(Date.now()-3_600_000,Date.now()+3_600_000)).toEqual([]);
});
it("binding-owner loss rolls back the first wire write, and later caller object edits cannot retarget a prepared receipt",()=>{
 const failed=rig();failed.limit(1);expect(()=>failed.prepare()).toThrow("owner changed");expect(failed.box.getHumanReceipt(failed.receipt.receipt_id)?.owner_key).toBeNull();
 const r=rig(),p=r.prepare();r.input.receiptId=randomUUID();r.input.wire="Changed caller object";expect(p.current()).toBe(true);expect(p.written(r.proof())).toBe(true);expect(r.box.getHumanReceipt(r.receipt.receipt_id)?.state).toBe("delivered");
});
it("delivered guest input remains outside work with no authority",()=>{
 const r=rig(true,true),p=r.prepare(),before=r.box.getHumanReceipt(r.receipt.receipt_id)!.authority_json;p.written(r.proof());expect(r.box.getHumanReceipt(r.receipt.receipt_id)!.authority_json).toBe(before);
 expect(r.box.requestContextHumans.read(r.receipt.receipt_id)?.context).toMatchObject({ingress:"guest",initiatingActor:{kind:"unknown"}});
});
it("Off, raw input, a closed store and a legacy-bound receipt never acquire a native positive proof",()=>{
 const off=rig(false);expect(()=>off.prepare()).toThrow("not ready");expect(off.box.getHumanReceipt(off.receipt.receipt_id)?.owner_key).toBeNull();
 const raw=rig(true,false,"/raw exact text");expect(()=>raw.prepare()).toThrow("unavailable");
 const legacy=rig();legacy.box.bindHumanReceipt(legacy.receipt.receipt_id,"worker","pane-owner",legacy.wire,"manager");expect(()=>legacy.prepare()).toThrow("untouched");
 const closed=rig(),p=closed.prepare();closed.box.close();expect(p.current()).toBe(false);expect(()=>p.written(closed.proof())).toThrow("owner changed");
});

it("ending an unproven native owner records uncertainty, and a late signal cannot turn it into delivery",()=>{
 const r=rig(),p=r.prepare();p.dispose();expect(r.box.getHumanReceipt(r.receipt.receipt_id)?.state).toBe("uncertain");expect(()=>p.written(r.proof())).toThrow("owner changed");expect(r.box.deliveredMessageHours(Date.now()-3_600_000,Date.now()+3_600_000)).toEqual([]);
});

function execOwner(r:ReturnType<typeof rig>){
 let alive=true;
 const registration={assertRegistration:()=>{}};
 const runtime=createRequestContextExecOwner(r.box,{instance:"worker",managerBootId:"manager",registration,
  work:{current:()=>alive,identity:()=>({incarnation:r.owner.incarnation,workGeneration:r.owner.workGeneration}),fresh:()=>{throw Error("No fresh launch in this fixture");}},
  current:()=>alive,incarnation:()=>r.owner.incarnation,deliveryEpoch:()=>0,admitted:()=>true,canManage:()=>false,consumptionCurrent:()=>true});
 return {...runtime,lose:()=>alive=false};
}
it("the native owner composes C and its positive human proof without granting tools at claim or turn binding",async()=>{
 const r=rig(),o=execOwner(r),f=o.prepare(`human:${r.receipt.message_id}`,r.task,r.options,r.claim);
 let ready=false;void f.inputReady().then(v=>ready=v);
 const snapshot=o.turns.beforeWrite(f.inputId,f.wireSha256,o.owner());f.bind(snapshot);
 await Promise.resolve();expect(ready).toBe(false);expect(r.box.getHumanReceipt(r.receipt.receipt_id)?.state).toBe("queued");
 expect(()=>o.prepare(f.inputId,r.task,r.options,r.claim)).toThrow("must wait");
 f.written(r.proof());expect(await f.inputReady()).toBe(true);expect(r.box.getHumanReceipt(r.receipt.receipt_id)?.state).toBe("delivered");
 f.finish();expect(o.turns.current(o.owner())?.token).toBe(snapshot.token);expect(()=>f.written(r.proof())).toThrow("owner changed");
 // Unconfirmed process completion cannot retire C; the owned confirmed-run path must do so explicitly.
 o.turns.ended(snapshot,o.owner());expect(o.turns.current(o.owner())).toBeNull();
});
it("a failed or retired native run cannot release a waiting tool call, or attach another input to the active turn",async()=>{
 const r=rig(),o=execOwner(r),f=o.prepare(`human:${r.receipt.message_id}`,r.task,r.options,r.claim);
 const snapshot=o.turns.beforeWrite(f.inputId,f.wireSha256,o.owner());f.bind(snapshot);f.finish();expect(await f.inputReady()).toBe(false);
 expect(r.box.getHumanReceipt(r.receipt.receipt_id)?.state).toBe("uncertain");expect(()=>o.prepare(f.inputId,r.task,r.options,r.claim)).toThrow("must wait");
 o.lose();expect(f.current()).toBe(false);expect(()=>f.written(r.proof())).toThrow("owner changed");
});
it("native preparation refuses a forged accepted-input key and changed composed bytes before binding a receipt",()=>{
 const r=rig(),o=execOwner(r);
 expect(()=>o.prepare("hub:body-selected",r.task,r.options,r.claim)).toThrow("unsupported");
 expect(()=>o.prepare(`human:${r.receipt.message_id}`,r.task,{context:"changed"},r.claim)).toThrow("composition changed");
 expect(r.box.getHumanReceipt(r.receipt.receipt_id)?.owner_key).toBeNull();
});
