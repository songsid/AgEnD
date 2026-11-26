import {EventEmitter} from "node:events";
import {PassThrough,Writable} from "node:stream";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {afterEach,expect,it,vi} from "vitest";
vi.mock("../src/child-process.js",()=>({spawn:vi.fn(),execFile:vi.fn()}));
import {spawn} from "../src/child-process.js";
import {prepareNativeExecInputWrite,claimNativeExecInput,NativeExecInputWitness,nativeExecInputRequestDigest,validateNativeExecInputProof,type NativeExecInputProof} from "../src/native-exec-input.js";
import {WindowsCliBridge} from "../src/windows-cli.js";
import {nativeProvider} from "../src/windows-cli-providers.js";
const task={requestId:"12345678-1234-4321-abcd-123456789012",cli:"codex",cwd:"C:\\Work",prompt:"Exact user input",sandbox:"read-only"}as const;
const roots:string[]=[];
afterEach(()=>{vi.clearAllMocks();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function witness(transport:"stdin-text"|"stdin-json"|"file"="stdin-text"){
 const options={context:"Exact context",resumeSessionId:"12345678-1234-4321-abcd-123456789013"},claim=claimNativeExecInput(task,options),published=vi.fn();
 const bytes=Buffer.from('actual provider bytes\n{"user":"input"}');
 return {options,claim,published,bytes,value:new NativeExecInputWitness(claim,task,options,transport,bytes,published)};
}
it.each(["stdin-text","stdin-json"]as const)("%s requires both spawn and successful stdin completion, in either order",transport=>{
 for(const order of [true,false]){const w=witness(transport);if(order)w.value.spawnedMain();else w.value.stdinFinished();expect(w.published).not.toHaveBeenCalled();
  if(order)w.value.stdinFinished();else w.value.spawnedMain();expect(w.published).toHaveBeenCalledOnce();
  expect(w.published.mock.calls[0][0]).toMatchObject({...w.claim,transport,inputSha256:createHash("sha256").update(w.bytes).digest("hex")});
  w.value.spawnedMain();w.value.stdinFinished();expect(w.published).toHaveBeenCalledOnce();}
});
it.each(["write-error","stdin-error","spawn-error","close-before-write"])("%s before positive input never becomes delivery",kind=>{
 const w=witness();if(kind!=="spawn-error")w.value.spawnedMain();
 if(kind==="write-error")w.value.stdinFinished(Error("EPIPE"));else if(kind==="close-before-write")w.value.closedMain();else w.value.failedInput();
 w.value.spawnedMain();w.value.stdinFinished();expect(w.published).not.toHaveBeenCalled();
});
it("a private prompt-file uses its actual bytes and main spawn; later cancellation cannot erase or repeat the proof",()=>{
 const w=witness("file");expect(w.published).not.toHaveBeenCalled();w.value.spawnedMain();expect(w.published).toHaveBeenCalledOnce();w.value.failedInput();w.value.closedMain();w.value.stdinFinished();expect(w.published).toHaveBeenCalledOnce();
});
it.each(["prompt","context","resumeSessionId","personal","answerOnly"])("the immutable run binding includes %s",field=>{
 const w=witness(),changedTask={...task},changedOptions:any={...w.options};
 if(field==="prompt")changedTask.prompt="changed"as typeof task.prompt;else changedOptions[field]=field==="personal"||field==="answerOnly"?true:"changed";
 expect(nativeExecInputRequestDigest(changedTask,changedOptions)).not.toBe(w.claim.requestSha256);
 expect(()=>new NativeExecInputWitness(w.claim,changedTask,changedOptions,"stdin-text","bytes",()=>{})).toThrow("composition changed");
});
it("a prior run token or forged extra authority field cannot satisfy the current proof",()=>{
 const w=witness();w.value.spawnedMain();w.value.stdinFinished();const proof=w.published.mock.calls[0][0];
 expect(()=>validateNativeExecInputProof(proof,claimNativeExecInput(task,w.options))).toThrow("another run");expect(()=>validateNativeExecInputProof({...proof,authority:"owner"},w.claim)).toThrow("invalid");
});
class Child extends EventEmitter {stdin=new PassThrough();stdout=new PassThrough();stderr=new PassThrough();send(value:unknown){this.stdout.write(JSON.stringify(value)+"\n");}close(){this.emit("close",0);}}
function bridge(){
 const root=mkdtempSync(join(tmpdir(),"exec-input-s230-"));roots.push(root);const inventory=join(root,"inventory.json");
 writeFileSync(inventory,JSON.stringify({home:"C:\\Users\\Demo",probedAt:1,clis:[{id:"codex",path:"C:\\codex.exe",version:"1",authenticated:true,runnable:true,readOnlySupport:true,supports:nativeProvider("codex").supports,models:[]}]}));
 const child=new Child();vi.mocked(spawn).mockReturnValue(child as never);return {child,service:new WindowsCliBridge(async()=>({executable:"fixture-worker",args:[]}),inventory)};
}
it("the real bridge binds the worker pipe to the run claim and preserves one positive proof across cancellation",async()=>{
 const r=bridge(),options={context:"Exact context"},claim=claimNativeExecInput(task,options),written=vi.fn(),settled=vi.fn();
 r.service.start(task,()=>true,{...options,execInput:claim,onInputWritten:written,onSettled:settled});await vi.waitFor(()=>expect(spawn).toHaveBeenCalledOnce());
 expect(JSON.parse(r.child.stdin.read().toString())).toMatchObject({execInput:claim,context:options.context,task});expect(written).not.toHaveBeenCalled();
 r.child.send({type:"started"});expect(written).not.toHaveBeenCalled();let proof!:NativeExecInputProof;
 const w=new NativeExecInputWitness(claim,task,options,nativeProvider(task.cli).promptTransport,"actual stdin",value=>{proof=value;});w.spawnedMain();w.stdinFinished();
 r.child.send({type:"input-written",proof});r.child.send({type:"input-written",proof});expect(written).toHaveBeenCalledOnce();r.child.send({type:"finished",code:null,cancelled:true});r.child.close();
 await vi.waitFor(()=>expect(settled).toHaveBeenCalledOnce());expect(r.service.get(task.requestId)).toMatchObject({status:"cancelled",execInputProof:proof});
});
it.each(["no-spawn","wrong-run","unexpected"])("the real bridge refuses %s worker proof without granting input delivery",async kind=>{
 const r=bridge(),claim=claimNativeExecInput(task,{}),written=vi.fn();r.service.start(task,()=>true,kind==="unexpected"?{}:{execInput:claim,onInputWritten:written});await vi.waitFor(()=>expect(spawn).toHaveBeenCalledOnce());
 if(kind!=="no-spawn")r.child.send({type:"started"});const proof={...claim,transport:nativeProvider(task.cli).promptTransport,inputSha256:"a".repeat(64),...(kind==="wrong-run"?{token:claimNativeExecInput(task,{}).token}:{})};
 r.child.send({type:"input-written",proof});expect(written).not.toHaveBeenCalled();expect(r.service.get(task.requestId)?.execInputProof).toBeUndefined();r.child.close();
});
it("a same-id retry with changed composition or a different claim conflicts before another worker",async()=>{
 const r=bridge(),claim=claimNativeExecInput(task,{context:"A"}),written=vi.fn();r.service.start(task,()=>true,{context:"A",execInput:claim,onInputWritten:written});await vi.waitFor(()=>expect(spawn).toHaveBeenCalledOnce());
 expect(()=>r.service.start(task,()=>true,{context:"B",execInput:claim,onInputWritten:written})).toThrow("composition changed");
 expect(()=>r.service.start(task,()=>true,{context:"A",execInput:claimNativeExecInput(task,{context:"A"}),onInputWritten:written})).toThrow("another native input claim");expect(spawn).toHaveBeenCalledOnce();r.child.close();
});

it.each(["write","error","close"])("the actual worker pipe helper waits for its callback and fails closed on %s",async outcome=>{
 let flush!:(error?:Error|null)=>void;const received:Buffer[]=[];
 const pipe=new Writable({write(chunk,_encoding,done){received.push(Buffer.from(chunk));flush=done;}});
 const child=Object.assign(new EventEmitter(),{stdin:pipe}),w=witness(),write=prepareNativeExecInputWrite(child as any,w.value,w.bytes.toString());
 write();child.emit("spawn");expect(w.published).not.toHaveBeenCalled();expect(()=>write()).toThrow("already written");
 if(outcome==="close")child.emit("close",0);flush(outcome==="error"?Error("EPIPE"):undefined);
 await new Promise<void>(done=>setImmediate(done));expect(Buffer.concat(received)).toEqual(w.bytes);
 expect(w.published).toHaveBeenCalledTimes(outcome==="write"?1:0);
});
it("file input is observed before the worker's cancel-on-spawn listener, with no stdin flush standing in for it",()=>{
 const child=Object.assign(new EventEmitter(),{stdin:new PassThrough()}),w=witness("file");prepareNativeExecInputWrite(child as any,w.value,"");
 child.once("spawn",()=>{child.emit("close",0);});child.emit("spawn");expect(w.published).toHaveBeenCalledOnce();
});
