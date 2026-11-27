import {createRequestContextExecOwner} from "../src/request-context-exec-owner.js";
import {claimNativeExecInput,NativeExecInputWitness,nativeExecInputBytes} from "../src/native-exec-input.js";
import {makeRequestDeliveryInputResolver} from "../src/request-context-delivery-resolver.js";
import {randomUUID} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,it} from "vitest";
import {DeliveryOutbox} from "../src/delivery-outbox.js";
import {requestContextReturnBlockers,REQUEST_CONTEXT_RETURNS_TABLE} from "../src/request-context-returns.js";
import {RequestContextLocalTurns,type PreparedRequestContextInput,type RequestContextRuntimeOwner} from "../src/request-context-turns.js";
import {requestContextDigest} from "../src/request-context-store.js";
import {labelHubRequest} from "../src/request-hub-context.js";
import type {RequestContextV1} from "../src/request-context-protocol.js";
const cleanup:Array<()=>void>=[];afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
const wire=requestContextDigest("actual formatted wire"),owner=(instance:string,incarnation="v1"):RequestContextRuntimeOwner=>({instance,incarnation,workGeneration:"work",daemonBootId:`boot-${instance}`,spawnGeneration:1,launchFenceEpoch:0,deliveryEpoch:0});
function fixture(relay:0|1=1){
 const home=mkdtempSync(join(tmpdir(),"s232-return-"));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));const path=join(home,"outbox.db"),box=new DeliveryOutbox(path,"manager",{requestContextDispatchVersion:1,requestContextRelayVersion:relay});cleanup.push(()=>box.close());box.activateRequestContextBarrier();const db=(box as any).db;
 const root=():RequestContextV1=>{const id=randomUUID();return {ref:{version:1,contextId:id,rootContextId:id},rootEvidenceRef:"fixture",ingress:"hub",initiatingActor:{kind:"person",platform:"hub",hubId:randomUUID(),id:"directory/demo-person",displayName:"Demo person"},source:{instance:"a",incarnation:"v1"},sourceAudience:{kind:"hub",ref:randomUUID()}};};
 function admit(context:RequestContextV1,target:string,verb="send_to_instance",selector=randomUUID(),reply=false,extra:Record<string,unknown>={}){
  const operationId=randomUUID(),meta={from_instance:context.source.instance,requires_reply:reply?"true":"false",correlation_id:selector},content=labelHubRequest(context,"fixture message",meta).content;
  const input={operationId,sourceKey:operationId,sourceInstance:context.source.instance,sourceDaemonBootId:`boot-${context.source.instance}`,targetInstance:target,targetSession:target,kind:"fleet_inbound",correlationId:selector,payload:{type:"fleet_inbound",content,meta},...extra};
  const binding={version:1 as const,operationId,contextId:context.ref.contextId,rootContextId:context.ref.rootContextId,source:context.source,target:{instance:target,incarnation:"v1"},verb,payloadSha256:requestContextDigest(input.payload)};
  const result=box.admitWithRequestContext(input,context,binding);return {result,input,binding,context};
 }
 const bind=(prepared:PreparedRequestContextInput)=>{const inputs=new Map([[prepared.inputId,prepared]]),turns=new RequestContextLocalTurns({input:id=>inputs.get(id)??null,context:id=>box.requestContext(id),retain:()=>{},canManage:()=>false,recovery:()=>null,saveRecovery:()=>{}});return {inputs,turns,turn:turns.beforeWrite(prepared.inputId,prepared.wireSha256,prepared.owner)};};
 return {box,db,path,root,admit,bind};
}
it("OFF does not create a return table and cannot consume a scoped delivery through H",()=>{const f=fixture(0),request=f.admit(f.root(),"b","request_information");expect(f.db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(REQUEST_CONTEXT_RETURNS_TABLE)).toBeUndefined();expect(()=>f.box.prepareRequestContextDeliveryInput(request.result.delivery.deliveryId,1,owner("b"),wire,()=>true)).toThrow(/not ready/);});
it("registers one exact obligation only at B admission and preserves exact retry",()=>{const f=fixture(),root=f.root(),request=f.admit(root,"b","request_information");expect(f.box.requestContextReturns.get(request.result.delivery.deliveryId)).toMatchObject({state:"open",rootContextId:root.ref.rootContextId,requesterContextId:root.ref.contextId,requester:{instance:"a",incarnation:"v1"},responder:{instance:"b",incarnation:"v1"}});expect(f.box.admitWithRequestContext(request.input,root,request.binding).inserted).toBe(false);expect(f.db.prepare(`SELECT COUNT(*) n FROM ${REQUEST_CONTEXT_RETURNS_TABLE}`).get()).toEqual({n:1});});
it("only request_information or explicit send requires_reply bears an obligation",()=>{const f=fixture(),r=f.root(),plain=f.admit(r,"b"),explicit=f.admit(r,"b","send_to_instance",randomUUID(),true),info=f.admit(r,"b","request_information");expect(f.box.requestContextReturns.get(plain.result.delivery.deliveryId)).toBeNull();expect(f.box.requestContextReturns.get(explicit.result.delivery.deliveryId)?.state).toBe("open");expect(f.box.requestContextReturns.get(info.result.delivery.deliveryId)?.state).toBe("open");});
it("ambiguity is refused at admission with complete delivery/operation rollback",()=>{const f=fixture(),request=f.admit(f.root(),"b","request_information"),before=f.box.listPending().length;expect(()=>f.admit(f.root(),"b","request_information",request.input.correlationId)).toThrow(/selector already pending/);expect(f.box.listPending()).toHaveLength(before);expect(f.db.prepare(`SELECT COUNT(*) n FROM ${REQUEST_CONTEXT_RETURNS_TABLE}`).get()).toEqual({n:1});});
it("relay retries reuse one deterministic receiving child and reject another incarnation",()=>{const f=fixture(),request=f.admit(f.root(),"b","request_information"),id=request.result.delivery.deliveryId,first=f.box.prepareRequestContextDeliveryInput(id,1,owner("b"),wire,()=>true),retry=f.box.prepareRequestContextDeliveryInput(id,2,owner("b"),wire,()=>true);expect(retry.context).toEqual(first.context);expect(retry.inputId).not.toBe(first.inputId);expect(first.proof).toMatchObject({kind:"admitted-delivery",parentContextId:request.context.ref.contextId,sender:{instance:"a",incarnation:"v1"}});expect(()=>f.box.prepareRequestContextDeliveryInput(id,1,owner("b","replacement"),wire,()=>true)).toThrow(/target unavailable/);});
it("a same-root sibling relay defers rather than joining an active receiving turn",()=>{const f=fixture(),root=f.root(),one=f.admit(root,"b"),two=f.admit(root,"b"),first=f.box.prepareRequestContextDeliveryInput(one.result.delivery.deliveryId,1,owner("b"),wire,()=>true),second=f.box.prepareRequestContextDeliveryInput(two.result.delivery.deliveryId,1,owner("b"),wire,()=>true),state=f.bind(first);state.inputs.set(second.inputId,second);expect(()=>state.turns.beforeWrite(second.inputId,wire,owner("b"))).toThrow(/wait/);expect(state.turns.current(owner("b"))).toBe(state.turn);});
it("a proved late return binds the original requesting parent in a fresh turn, without Hub input",()=>{
 const f=fixture(),root=f.root(),request=f.admit(root,"b","request_information"),b=f.box.prepareRequestContextDeliveryInput(request.result.delivery.deliveryId,1,owner("b"),wire,()=>true),bTurn=f.bind(b);
 const response=f.admit(bTurn.turn.context,"a","report_result",request.input.correlationId),record=f.box.requestContextReturns.get(request.result.delivery.deliveryId)!;expect(record).toMatchObject({state:"answered",responseOperationId:response.input.operationId,responseDeliveryId:response.result.delivery.deliveryId});
 const returned=f.box.prepareRequestContextDeliveryInput(response.result.delivery.deliveryId,1,owner("a"),wire,()=>true);expect(returned.proof).toMatchObject({kind:"expected-return",parentContextId:root.ref.contextId,expectedSender:{kind:"peer",instance:"b",incarnation:"v1"},actualSender:{kind:"peer",instance:"b",incarnation:"v1"}});expect(returned.context?.ref.parentContextId).toBe(root.ref.contextId);expect(returned.context?.initiatingActor).toEqual(root.initiatingActor);expect((response.input.payload.meta as any).from_instance).toBe("b");expect(response.input.payload).not.toHaveProperty("hubQuestion");
 const late=f.bind(returned);expect(late.turn.context.ref.rootContextId).toBe(root.ref.rootContextId);expect(late.turn.context.source.instance).toBe("a");expect(f.box.admitWithRequestContext(response.input,response.context,response.binding).inserted).toBe(false);expect(()=>f.admit(bTurn.turn.context,"a","report_result",request.input.correlationId)).toThrow(/already completed/);
});
it("an unrelated root with the same history selector never consumes the old obligation",()=>{const f=fixture(),request=f.admit(f.root(),"b","request_information"),newRoot={...f.root(),source:{instance:"b",incarnation:"v1"}},response=f.admit(newRoot,"a","report_result",request.input.correlationId);expect(f.box.requestContextReturns.get(request.result.delivery.deliveryId)?.state).toBe("open");const input=f.box.prepareRequestContextDeliveryInput(response.result.delivery.deliveryId,1,owner("a"),wire,()=>true);expect(input.proof.kind).toBe("admitted-delivery");expect(input.context?.ref.rootContextId).toBe(newRoot.ref.rootContextId);});
it("a wrong responder session cannot claim the expected answer",()=>{const f=fixture(),request=f.admit(f.root(),"b","request_information"),b=f.box.prepareRequestContextDeliveryInput(request.result.delivery.deliveryId,1,owner("b"),wire,()=>true),before=f.box.listPending().length;expect(()=>f.admit(b.context!,"a","report_result",request.input.correlationId,false,{payload:{content:labelHubRequest(b.context!,"fixture",{from_instance:"wrong-session"}).content,meta:{from_instance:"wrong-session"}}})).toThrow(/peer is no longer current/);expect(f.box.listPending()).toHaveLength(before);expect(f.box.requestContextReturns.get(request.result.delivery.deliveryId)?.state).toBe("open");});
it("a failed registration rolls back the B row and context companion together",()=>{const f=fixture(),first=f.admit(f.root(),"b");f.db.exec(`CREATE TRIGGER controlled_s232_failure BEFORE INSERT ON ${REQUEST_CONTEXT_RETURNS_TABLE} BEGIN SELECT RAISE(ABORT,'controlled failure'); END`);const before=f.box.listPending().length;expect(()=>f.admit(f.root(),"b","request_information")).toThrow(/controlled failure/);expect(f.box.listPending()).toHaveLength(before);expect(f.box.get(first.result.delivery.deliveryId)).toBeTruthy();});
it("pending answers block drain; time alone never closes them; only a proved closure can",()=>{const f=fixture(),root=f.root(),request=f.admit(root,"b","request_information"),id=request.result.delivery.deliveryId;expect(requestContextReturnBlockers(f.db,root.ref.rootContextId)).toEqual([`expected-return:${id}`]);expect(()=>f.box.requestContextReturns.close(id,"work-closed",()=>false)).toThrow(/unproved/);expect(f.box.requestContextReturns.get(id)?.state).toBe("open");f.box.requestContextReturns.close(id,"work-closed",()=>true);expect(requestContextReturnBlockers(f.db,root.ref.rootContextId)).toEqual([]);});
it("missing or changed schema/state refuses, including a capability-0 reopen",()=>{const f=fixture(),root=f.root(),request=f.admit(root,"b","request_information");expect(()=>new DeliveryOutbox(f.path,"other",{requestContextDispatchVersion:1})).toThrow(/unsupported/);f.db.prepare(`UPDATE ${REQUEST_CONTEXT_RETURNS_TABLE} SET state='closed' WHERE request_delivery_id=?`).run(request.result.delivery.deliveryId);expect(requestContextReturnBlockers(f.db,root.ref.rootContextId)).toEqual(["expected-returns-unavailable"]);f.db.exec("DROP INDEX request_context_one_open_return_v1");expect(()=>f.box.requestContextReturns.get(request.result.delivery.deliveryId)).toThrow(/schema unavailable/);});

it("a retired physical consumption attempt cannot install its child context",()=>{const f=fixture(),request=f.admit(f.root(),"b"),before=f.db.prepare("SELECT COUNT(*) n FROM request_contexts_v1").get();let calls=0;expect(()=>f.box.prepareRequestContextDeliveryInput(request.result.delivery.deliveryId,1,owner("b"),wire,()=>++calls===1)).toThrow(/no longer current/);expect(f.db.prepare("SELECT COUNT(*) n FROM request_contexts_v1").get()).toEqual(before);});

it("H return rows retire before B operations without an FK stall",()=>{
 const f=fixture(),root=f.root(),request=f.admit(root,"b","request_information"),id=request.result.delivery.deliveryId;
 f.db.prepare("UPDATE deliveries SET state='failed',finished_at=?,updated_at=? WHERE delivery_id=?").run("2000-01-01T00:00:00Z","2000-01-01T00:00:00Z",id);
 expect(requestContextReturnBlockers(f.db,root.ref.rootContextId)).toEqual([]);const gate=f.box.requestHubContactGate({current:()=>true,person:()=>null,adminOf:()=>false,canDecide:()=>true,canManage:()=>true,rootRetired:()=>true});
 gate.retireRoot(root.ref.rootContextId);expect(f.box.requestContext(root.ref.contextId)).toBeNull();expect(f.box.requestContextForDelivery(id)).toBeNull();expect(f.db.prepare(`SELECT COUNT(*) n FROM ${REQUEST_CONTEXT_RETURNS_TABLE}`).get()).toEqual({n:0});
});
it("final delivery resolver requires the actual current physical claim and B-owned peer, never display sender",()=>{
 const f=fixture(),root=f.root(),request=f.admit(root,"b"),runtime=owner("b");let owned=true,consume=true;
 const resolver=makeRequestDeliveryInputResolver(f.box,{instance:"b",managerBootId:"manager",current:()=>owned,runtimeOwner:()=>runtime,consumptionCurrent:()=>consume}),id=request.result.delivery.deliveryId,input=`delivery:${id}:1`;
 expect(resolver.prepare("human:unrelated",wire,runtime)).toBeNull();expect(()=>resolver.prepare(input,wire,runtime)).toThrow(/current/);
 const claimed=f.box.claimNext("manager",()=>runtime.daemonBootId,new Set())!;expect(claimed.deliveryId).toBe(id);
 const prepared=resolver.prepare(input,wire,runtime)!;expect(prepared.proof).toMatchObject({kind:"admitted-delivery",sender:{instance:"a",incarnation:"v1"}});expect(prepared.context?.ref.rootContextId).toBe(root.ref.contextId);
 expect(f.bind(prepared).turn.context).toEqual(prepared.context);expect(()=>resolver.prepare(`delivery:${id}:2`,wire,runtime)).toThrow(/current/);
 consume=false;expect(()=>resolver.prepare(input,wire,runtime)).toThrow(/current/);consume=true;owned=false;expect(()=>resolver.prepare(input,wire,runtime)).toThrow(/current/);owned=true;
 expect(()=>resolver.prepare(input,wire,{...runtime,daemonBootId:"another-boot"})).toThrow(/current/);
 expect(f.box.begin(id,runtime.daemonBootId,1)).toBe("begun");expect(resolver.prepare(input,wire,runtime)?.context).toEqual(prepared.context);
 f.box.complete(id,runtime.daemonBootId,1,"delivered");expect(()=>resolver.prepare(input,wire,runtime)).toThrow(/current/);
});
it("a foreign manager or a replacement during final delivery validation cannot retain a child",()=>{
 const f=fixture(),request=f.admit(f.root(),"b"),runtime=owner("b"),id=request.result.delivery.deliveryId,input=`delivery:${id}:1`;f.box.claimNext("manager",()=>runtime.daemonBootId,new Set());
 const before=f.db.prepare("SELECT COUNT(*) n FROM request_contexts_v1").get();
 const wrong=makeRequestDeliveryInputResolver(f.box,{instance:"b",managerBootId:"another-manager",current:()=>true,runtimeOwner:()=>runtime,consumptionCurrent:()=>true});expect(()=>wrong.prepare(input,wire,runtime)).toThrow(/current/);
 let calls=0;const replaced=makeRequestDeliveryInputResolver(f.box,{instance:"b",managerBootId:"manager",current:()=>++calls<4,runtimeOwner:()=>runtime,consumptionCurrent:()=>true});expect(()=>replaced.prepare(input,wire,runtime)).toThrow(/current/);
 expect(f.db.prepare("SELECT COUNT(*) n FROM request_contexts_v1").get()).toEqual(before);
});


it("an exec peer consumes only its exact B attempt after the owned main-child input write",async()=>{
 const f=fixture(),request=f.admit(f.root(),"b","request_information"),id=request.result.delivery.deliveryId;
 const registration={assertRegistration:()=>{}},generation=randomUUID();
 const stable=createRequestContextExecOwner(f.box,{instance:"b",managerBootId:"manager",registration,work:{current:()=>true,identity:()=>({incarnation:"v1",workGeneration:generation}),fresh:()=>{}},current:()=>true,incarnation:()=>"v1",deliveryEpoch:()=>0,admitted:()=>true,canManage:()=>false,consumptionCurrent:()=>true});
 const claimed=f.box.claimNext("manager",()=>"manager",new Set())!;
 const task={requestId:id,cli:"codex" as const,cwd:"C:\\Fixture",sandbox:"read-only" as const,prompt:String(claimed.payload.content)},options={context:"Exact native execution"},claim=claimNativeExecInput(task,options);
 const frame=stable.prepare(`delivery:${id}:1`,task,options,claim),snapshot=stable.turns.beforeWrite(frame.inputId,frame.wireSha256,stable.owner());frame.bind(snapshot);
 expect(snapshot.context.ref.parentContextId).toBe(request.context.ref.contextId);expect(snapshot.context.source.instance).toBe("b");expect(f.box.begin(id,"manager",1)).toBe("begun");
 let written=false;void frame.inputReady().then(v=>written=v);
 const proof=new NativeExecInputWitness(claim,task,options,"stdin-text",nativeExecInputBytes(task,options),p=>frame.written(p));proof.spawnedMain();await Promise.resolve();expect(written).toBe(false);expect(f.box.get(id)?.state).toBe("submission_started");
 proof.stdinFinished();expect(await frame.inputReady()).toBe(true);expect(f.box.get(id)?.state).toBe("delivered");expect(f.box.queryStatusForInstance("b",{deliveryId:id}).items[0]?.consumed_at).toBeTruthy();expect(f.box.requestContextReturns.get(id)?.state).toBe("open");
 // Provider completion and positive input consumption are distinct; failure cannot erase the input proof.
 expect(f.box.complete(id,"manager",1,"failed")).toBe(false);frame.finish();expect(stable.turns.current(stable.owner())?.token).toBe(snapshot.token);
});

it("explicit stop-waiting atomically closes the exact obligation and admits one provenance-bound requester outcome",()=>{
 const f=fixture(),root=f.root(),request=f.admit(root,"b","request_information"),id=request.result.delivery.deliveryId,row=f.box.requestContextReturns.get(id)!;
 const before=f.box.listPending().length;let checks=0;
 expect(()=>f.box.closeRequestContextReturn(id,requestContextDigest(row),"Stopped waiting",()=>++checks<3)).toThrow();
 expect(f.box.requestContextReturns.get(id)?.state).toBe("open");expect(f.box.listPending()).toHaveLength(before);
 const noticeId=f.box.closeRequestContextReturn(id,requestContextDigest(row),"Stopped waiting",()=>true),notice=f.box.get(noticeId)!;
 expect(f.box.requestContextReturns.get(id)?.state).toBe("closed");expect(notice).toMatchObject({sourceInstance:"a",targetInstance:"a",payload:{meta:{source:"agend-system",requires_reply:"false"}}});
 expect(f.box.requestContextForDelivery(noticeId)?.binding.rootContextId).toBe(root.ref.rootContextId);expect(notice.payload.content).toContain("Stopped waiting");
 expect(()=>f.box.closeRequestContextReturn(id,requestContextDigest(row),"duplicate",()=>true)).toThrow(/stale/);expect(f.box.listPending()).toHaveLength(before+1);
 const input=f.box.prepareRequestContextDeliveryInput(noticeId,1,owner("a"),wire,()=>true);expect(input.context?.initiatingActor).toEqual(root.initiatingActor);expect(input.proof.kind).toBe("admitted-delivery");
});
