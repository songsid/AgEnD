/** Scratch SQLite and an inert native input witness only. No process, runtime, Fleet or provider starts. */
import {afterEach,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import {DeliveryOutbox} from "../src/delivery-outbox.js";
import {createRequestContextExecOwner} from "../src/request-context-exec-owner.js";
import {admitRequestContextNativeResult} from "../src/request-context-native-result.js";
import {makeRequestContextRelay} from "../src/request-context-relay.js";
import {claimNativeExecInput,nativeExecInputBytes,NativeExecInputWitness,type NativeExecInputProof} from "../src/native-exec-input.js";
import {requestContextDigest} from "../src/request-context-store.js";
import {labelHubRequest} from "../src/request-hub-context.js";
import type {RequestContextV1} from "../src/request-context-protocol.js";
import type {NativeExecutionResult} from "../src/fleet-windows-runtime.js";
const cleanup:Array<()=>void>=[];afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
function fixture(){
 const home=mkdtempSync(join(tmpdir(),"native-result-s230-"));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 const box=new DeliveryOutbox(join(home,"outbox.db"),"manager",{requestContextDispatchVersion:1,requestContextRelayVersion:1});cleanup.push(()=>box.close());box.activateRequestContextBarrier();
 const rootId=randomUUID(),root:RequestContextV1={ref:{version:1,contextId:rootId,rootContextId:rootId},source:{instance:"a",incarnation:"v1"},ingress:"hub",rootEvidenceRef:`hub:${randomUUID()}`,initiatingActor:{kind:"person",platform:"hub",hubId:randomUUID(),id:"directory/demo-person",displayName:"Demo person"},sourceAudience:{kind:"hub",ref:randomUUID()}};
 const operationId=randomUUID(),selector=randomUUID(),meta={from_instance:"a",requires_reply:"true",correlation_id:selector},payload={type:"fleet_inbound",content:labelHubRequest(root,"Question",meta).content,meta};
 const admitted=box.admitWithRequestContext({sourceKey:operationId,operationId,sourceInstance:"a",sourceDaemonBootId:"boot-a",targetInstance:"b",targetSession:"b",kind:"fleet_inbound",correlationId:selector,payload},root,
  {version:1,operationId,contextId:rootId,rootContextId:rootId,source:root.source,target:{instance:"b",incarnation:"v1"},verb:"request_information",payloadSha256:requestContextDigest(payload)});
 const id=admitted.delivery.deliveryId;box.claimNext("manager",()=>"manager",new Set());
 let current=true;const registration={assertRegistration:()=>{}},workGeneration=randomUUID();
 const owner=createRequestContextExecOwner(box,{instance:"b",managerBootId:"manager",registration,work:{current:()=>current,identity:()=>({incarnation:"v1",workGeneration}),fresh:()=>{}},current:()=>current,incarnation:()=>"v1",deliveryEpoch:()=>0,admitted:()=>true,canManage:()=>false,consumptionCurrent:()=>true});
 const native={requestId:id,cli:"codex" as const,cwd:"C:\\Fixture",sandbox:"read-only" as const,prompt:payload.content},options={context:"Exact exec input"},claim=claimNativeExecInput(native,options),frame=owner.prepare(`delivery:${id}:1`,native,options,claim),snapshot=owner.turns.beforeWrite(frame.inputId,frame.wireSha256,owner.owner());frame.bind(snapshot);box.begin(id,"manager",1);
 let proof!:Readonly<NativeExecInputProof>;const witness=new NativeExecInputWitness(claim,native,options,"stdin-text",nativeExecInputBytes(native,options),value=>{proof=value;frame.written(value);});
 const host={incarnation:()=>"v1",current:()=>current,person:()=>null,adminOf:()=>false,canManage:()=>false,canDecide:()=>false,hubRelayAllowed:()=>true};
 const relay=makeRequestContextRelay(box,host);
 const finish=()=>{witness.spawnedMain();witness.stdinFinished();frame.finish();owner.turns.ended(snapshot,owner.owner());return {id,cli:native.cli,cwd:native.cwd,sandbox:native.sandbox,status:"completed",startedAt:1,finishedAt:2,outcomeConfirmed:true,output:"Exact native answer",execInputProof:proof} as NativeExecutionResult;};
 return {box,root,id,claim,owner,relay,selector,finish,lose:()=>current=false};
}
it("a completed native run reports once through the retained receiving child after C ends, keeping the outside label and exact return",()=>{
 const f=fixture(),task=f.finish();expect(f.owner.turns.current(f.owner.owner())).toBeNull();
 const input={deliveryId:f.id,task,claim:f.claim,owner:f.owner.owner(),current:f.owner.current},result=admitRequestContextNativeResult(f.box,f.relay,input)!;
 const response=f.box.get(result.deliveryId)!,binding=f.box.requestContextForDelivery(result.deliveryId)!;
 expect(response.targetInstance).toBe("a");expect(response.correlationId).toBe(f.selector);expect(response.payload.content).toContain("Exact native answer");expect(response.payload.content).toContain('"authority":"none"');
 expect(binding.binding).toMatchObject({verb:"report_result",source:{instance:"b",incarnation:"v1"},target:{instance:"a",incarnation:"v1"},rootContextId:f.root.ref.rootContextId});
 expect(f.box.requestContextReturns.get(f.id)).toMatchObject({state:"answered",responseDeliveryId:result.deliveryId});
 expect(admitRequestContextNativeResult(f.box,f.relay,input)).toEqual({deliveryId:result.deliveryId,duplicate:true});
 expect(f.box.listPending()).toHaveLength(1);expect(f.box.contactAuthorizations.origin("a")).toBeUndefined();
});
it.each(["missing-proof","wrong-token","wrong-run","unconfirmed","wrong-owner","lost-owner"])("%s cannot auto-report or consume the expected return",kind=>{
 const f=fixture(),task=f.finish(),input={deliveryId:f.id,task,claim:f.claim,owner:f.owner.owner(),current:f.owner.current};
 if(kind==="missing-proof")delete task.execInputProof;else if(kind==="wrong-token")task.execInputProof={...task.execInputProof!,token:randomUUID()};else if(kind==="wrong-run")task.id=randomUUID();else if(kind==="unconfirmed")task.outcomeConfirmed=false;else if(kind==="wrong-owner")input.owner={...input.owner,incarnation:"another"};else f.lose();
 expect(()=>admitRequestContextNativeResult(f.box,f.relay,input)).toThrow();expect(f.box.requestContextReturns.get(f.id)?.state).toBe("open");expect(f.box.listPending()).toEqual([]);
});
it("explicitly closing the original expected return prevents a late native result without inventing another request",()=>{
 const f=fixture(),task=f.finish();f.box.requestContextReturns.close(f.id,"work-closed",()=>true);
 expect(admitRequestContextNativeResult(f.box,f.relay,{deliveryId:f.id,task,claim:f.claim,owner:f.owner.owner(),current:f.owner.current})).toBeNull();expect(f.box.listPending()).toEqual([]);
});
