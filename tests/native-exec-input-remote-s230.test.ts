/** Loopback protocol only. The worker/CLI/pane ports are fixtures; no live Fleet or provider is started. */
import {createServer,type Server} from "node:http";
import {once} from "node:events";
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {afterEach,expect,it,vi} from "vitest";
import {RuntimeCoordinator} from "../src/runtime-coordinator.js";
import {RuntimeClient,type RuntimeBridge} from "../src/runtime-client.js";
import {RuntimeClientStore} from "../src/runtime-client-store.js";
import {RuntimeWindowsBridge} from "../src/runtime-windows-bridge.js";
import {nativeExecInputBytes,claimNativeExecInput,NativeExecInputWitness,NATIVE_EXEC_INPUT_CAPABILITY,type NativeExecInputProof} from "../src/native-exec-input.js";
import type {NativeTaskInput} from "../src/windows-cli-worker.js";
import type {WindowsCliTask,WindowsRunOptions} from "../src/windows-cli.js";
const homes:string[]=[],clients:RuntimeClient[]=[],hubs:RuntimeCoordinator[]=[],servers:Server[]=[],routers:RuntimeWindowsBridge[]=[];
const home=()=>{const p=mkdtempSync(join(tmpdir(),"exec-input-remote-s230-"));homes.push(p);return p;};
afterEach(async()=>{for(const c of clients.splice(0))await c.stop();for(const r of routers.splice(0))r.close();for(const h of hubs.splice(0))h.close();for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(done=>s.close(()=>done()));}for(const p of homes.splice(0))rmSync(p,{recursive:true,force:true});});
class Worker implements RuntimeBridge {
 tasks=new Map<string,WindowsCliTask>();options=new Map<string,WindowsRunOptions>();launches=0;
 probe=async()=>({home:"C:\\Fixture",probedAt:1,clis:[]});prepareWorkspace=async()=>"C:\\Fixture";
 start(value:unknown,_authorized?:()=>boolean,options:WindowsRunOptions={}){const input=value as NativeTaskInput;this.launches++;this.options.set(input.requestId,options);
  const task:WindowsCliTask={id:input.requestId,cli:input.cli,cwd:input.cwd,sandbox:input.sandbox,status:"running",startedAt:1,output:""};this.tasks.set(task.id,task);return structuredClone(task);}
 get(id:string){return structuredClone(this.tasks.get(id)??null);}
 cancel(id:string){const task=this.tasks.get(id)!;Object.assign(task,{status:"cancelled",finishedAt:2,outcomeConfirmed:true});this.options.get(id)?.onSettled?.(structuredClone(task));return structuredClone(task);}
 close(){for(const [id,t]of this.tasks)if(!t.finishedAt)this.cancel(id);}releaseUnknown(){}
 input(task:NativeTaskInput,wrong=false){const options=this.options.get(task.requestId)!;let proof!:NativeExecInputProof;
  const witness=new NativeExecInputWitness(options.execInput!,task,options,"stdin-text",nativeExecInputBytes(task,options),value=>{proof=value;});witness.spawnedMain();witness.stdinFinished();
  if(wrong)proof={...proof,token:randomUUID()};this.tasks.get(task.requestId)!.execInputProof=proof;options.onInputWritten?.(proof);return proof;}
}
async function fixture(coordinatorOn=true,clientOn=true){
 const hub=new RuntimeCoordinator(home(),coordinatorOn?{requestContextProtocol:1}:{});hubs.push(hub);
 const p=hub.createPairing(),pending=hub.pair({code:p.code,name:"Fixture PC",platform:"win32"});hub.approve(pending.machineId,hub.machine(pending.machineId)?.pairingFingerprint);
 const identity=hub.claim({machineId:pending.machineId,claimSecret:pending.claimSecret});if(identity.status!=="approved")throw Error("Fixture pairing failed");
 const server=createServer((req,res)=>{if(!hub.handlePublicRequest(req,res,new URL(req.url??"/","http://localhost"))){res.writeHead(404);res.end();}});servers.push(server);server.on("upgrade",(req,socket,head)=>{if(!hub.handleUpgrade(req,socket,head))socket.destroy();});server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();if(!address||typeof address==="string")throw Error("No private fixture listener");
 const store=new RuntimeClientStore(home()),worker=new Worker();store.saveCredentials({server:`http://127.0.0.1:${address.port}`,machineId:identity.machineId,credential:identity.credential,name:"Fixture PC"});
 const client=new RuntimeClient({store,bridge:worker,pollMs:10,reconnectMs:25,disconnectGraceMs:10,...(clientOn?{requestContextProtocol:1 as const}:{}),createPaneHost:()=>{throw Error("No real pane");}});clients.push(client);await client.start();await vi.waitFor(()=>expect(client.online()).toBe(true));
 const router=new RuntimeWindowsBridge({},()=>hub,{close(){}}as never);routers.push(router);
 const task:NativeTaskInput={requestId:randomUUID(),cli:"codex",cwd:"C:\\Fixture",prompt:"Fixture only; never call a provider",sandbox:"read-only"};
 return {hub,store,worker,client,router,task,machineId:identity.machineId};
}
it("the negotiated owned worker proof crosses real client/store/coordinator/bridge once and survives terminal cancellation",async()=>{
 const f=await fixture(),options={context:"Exact request context",resumeSessionId:randomUUID()},claim=claimNativeExecInput(f.task,options),written=vi.fn(),settled=vi.fn();
 expect(f.hub.machine(f.machineId)?.runtimeInfo?.capabilities).toContain(NATIVE_EXEC_INPUT_CAPABILITY);
 f.router.start(f.task,()=>true,{machineId:f.machineId,...options,execInput:claim,onInputWritten:written,onSettled:settled});await vi.waitFor(()=>expect(f.worker.launches).toBe(1));expect(written).not.toHaveBeenCalled();
 const proof=f.worker.input(f.task);await vi.waitFor(()=>expect(written).toHaveBeenCalledOnce());expect(written).toHaveBeenCalledWith(proof);
 expect(new RuntimeClientStore(f.store.directory).get(f.task.requestId)?.task.execInputProof).toEqual(proof);
 // A later cancellation/status producer cannot erase evidence already accepted for this exact run.
 delete f.worker.tasks.get(f.task.requestId)!.execInputProof;f.worker.cancel(f.task.requestId);await vi.waitFor(()=>expect(settled).toHaveBeenCalledOnce());
 expect(f.hub.task(f.task.requestId)?.execInputProof).toEqual(proof);expect(written).toHaveBeenCalledOnce();
});
it.each([[false,true],[true,false]])("missing bilateral negotiation (%s/%s) refuses before a run is journaled or started",async(serverOn,clientOn)=>{
 const f=await fixture(serverOn,clientOn),claim=claimNativeExecInput(f.task,{});
 expect(()=>f.router.start(f.task,()=>true,{machineId:f.machineId,execInput:claim,onInputWritten:()=>{}})).toThrow("not negotiated");
 await expect(f.hub.call(f.machineId,"run",{task:f.task,execInput:claim})).rejects.toThrow("not negotiated");expect(f.worker.launches).toBe(0);expect(f.hub.task(f.task.requestId)).toBeNull();
});
it("a different run token in a paired worker's status never satisfies the Fleet's claim",async()=>{
 const f=await fixture(),claim=claimNativeExecInput(f.task,{}),written=vi.fn();f.router.start(f.task,()=>true,{machineId:f.machineId,execInput:claim,onInputWritten:written});await vi.waitFor(()=>expect(f.worker.launches).toBe(1));
 f.worker.input(f.task,true);await vi.waitFor(()=>expect(f.hub.machine(f.machineId)?.status).toBe("offline"));expect(written).not.toHaveBeenCalled();expect(f.hub.task(f.task.requestId)?.execInputProof).toBeUndefined();
});
it("a native proof retained in a v1 runtime journal is strict and cannot be moved to another task",()=>{
 const root=home(),store=new RuntimeClientStore(root),task={id:randomUUID(),cli:"codex",cwd:"C:\\Fixture",sandbox:"read-only",status:"running",output:"",startedAt:1}as const;
 store.accept(task,"a".repeat(64));const proof={v:1,requestId:task.id,token:randomUUID(),requestSha256:"b".repeat(64),wireSha256:"c".repeat(64),transport:"stdin-text",inputSha256:"c".repeat(64)}as const;
 store.update({...task,execInputProof:proof});expect(new RuntimeClientStore(root).get(task.id)?.task.execInputProof).toEqual(proof);
 expect(()=>store.update({...task,execInputProof:{...proof,token:randomUUID()}})).toThrow("proof changed");
 const file=join(root,"jobs.json"),raw=JSON.parse(readFileSync(file,"utf8"));raw.jobs[task.id].task.execInputProof.requestId=randomUUID();writeFileSync(file,JSON.stringify(raw));expect(()=>new RuntimeClientStore(root)).toThrow("another run");
});
