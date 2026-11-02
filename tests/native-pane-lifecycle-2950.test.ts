/** Private inert runner + real terminal/parser/receipt paths. No installed provider or user home is read. */
import{afterEach,expect,it,vi}from'vitest';import{randomUUID}from'node:crypto';import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import{RuntimeNativePaneLifecycle,type NativePaneLifecycleOptions}from'../src/native-pane-lifecycle.js';import{RuntimePaneHost}from'../src/runtime-pane-host.js';import{RuntimePaneStore}from'../src/runtime-pane-store.js';import type{RuntimePaneLaunch}from'../src/runtime-pane-protocol.js';
const clean:Array<()=>unknown>=[];afterEach(async()=>{for(const f of clean.splice(0).reverse())await f();vi.restoreAllMocks();});
async function fixture(cli:'codex'|'claude-code'='codex',expected?:string){
 const root=mkdtempSync(join(tmpdir(),'agend-native-lifecycle-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));const actual=randomUUID(),launch:RuntimePaneLaunch={paneId:randomUUID(),launchId:randomUUID(),agentId:randomUUID(),instance:'native-agent',cli,cwd:'C:\\scratch',sandbox:'read-only',columns:100,rows:30,...(expected?{sessionId:expected}:{})};
 let output:(text:string)=>void=()=>{},exit:(value:{exitCode:number})=>void=()=>{};const idle='› Ask Codex to do anything\r\n\r\n  Context 100% left\r\n';
 const write=vi.fn((text:string)=>{if(text==='\r')output(`\x1b[2J\x1b[HSession: ${actual}\r\n${idle}`);});
 const process={pid:12345,write,resize:vi.fn(),pause:vi.fn(),resume:vi.fn(),kill:vi.fn(()=>exit({exitCode:0})),onData:(fn:typeof output)=>{output=fn;setTimeout(()=>output(cli==='codex'?idle:'Accessing workspace:\r\nC:\\scratch\r\nYes, I trust this folder\r\n❯ No, exit\r\n'),0);return{dispose(){}};},onExit:(fn:typeof exit)=>{exit=fn;return{dispose(){}};}};
 const spawn=vi.fn(async()=>process),host=new RuntimePaneHost({store:new RuntimePaneStore(join(root,'runner')),bootId:randomUUID(),online:()=>true,maxAgents:()=>4,spawn,transcript:()=>({read:async cursor=>({state:'pending',cursor,data:'',lines:[],complete:false,gap:false}),close:async()=>{}})});clean.push(()=>host.stop());
 const options:NativePaneLifecycleOptions={endpoint:{machineId:randomUUID(),online:()=>true,call:request=>host.request(request),subscribe:()=>()=>{}},receiptFile:join(root,'receipt.json'),launch,admit:vi.fn(),reserve:vi.fn(),pin:vi.fn(),exited:vi.fn(),mcpProof:()=> 'unknown',releaseAuthority:vi.fn()};const make=()=>new RuntimeNativePaneLifecycle(options);
 return{root,actual,launch,options,host,spawn,process,write,make,output:(text:string)=>output(text)};
}
it('fresh Codex asks status once after the real idle detector, pins it and exposes only runtime metadata',async()=>{
 const f=await fixture(),native=f.make(),acquisition=await native.acquire(()=>{});expect(acquisition.disposition).toBe('fresh');expect(f.options.reserve).toHaveBeenCalledExactlyOnceWith(f.launch.launchId);expect(f.options.pin).toHaveBeenCalledWith(f.launch.launchId,f.actual);expect(f.write.mock.calls.map(x=>x[0])).toEqual(['/status','\r']);expect(native.backend.getSessionId()).toBe(f.actual);expect(native.host.executionHost).toBe('remote');
 await acquisition.source.initialize?.();expect((await acquisition.source.runtimeCheckpoint?.())?.cursor.sessionId).toBe(f.actual);expect(acquisition.source.currentPath?.()).toBeNull();const ref=await acquisition.source.runtimeCheckpoint?.();const proof=native.proofReader(ref!,randomUUID());await native.release('detach');expect(await proof.look()).toBe('unavailable');expect(f.process.kill).not.toHaveBeenCalled();
});
it('coordinator reconnect reattaches a busy pinned pane without typing, respawning or waiting for idle',async()=>{
 const f=await fixture(),first=f.make();await first.acquire(()=>{});await first.release('detach');f.output('\x1b[2J\x1b[HWorking on the existing task...\r\n');
 const next=f.make(),acquisition=await next.acquire(()=>{});expect(acquisition.disposition).toBe('reattached');expect(f.spawn).toHaveBeenCalledOnce();expect(f.write.mock.calls.map(x=>x[0])).toEqual(['/status','\r']);expect(f.process.kill).not.toHaveBeenCalled();await next.release('detach');
});
it('a resumed pane that displays another id is held without any model prompt or fresh fallback',async()=>{
 const f=await fixture('codex',randomUUID()),native=f.make();await expect(native.acquire(()=>{})).rejects.toThrow('different conversation');expect(f.options.pin).not.toHaveBeenCalled();expect(f.spawn).toHaveBeenCalledOnce();expect(f.write.mock.calls.map(x=>x[0])).toEqual(['/status','\r']);await native.release('detach');expect(f.process.kill).not.toHaveBeenCalled();
});
it('an interrupted automatic status intent is never typed or submitted a second time',async()=>{
 const f=await fixture(),native=f.make();f.options.admit=()=>{if(f.write.mock.calls.some(call=>call[0]==='/status'))throw Error('admission expired');};
 await expect(native.acquire(()=>{})).rejects.toThrow('admission expired');expect(f.write.mock.calls.map(x=>x[0])).toEqual(['/status']);await native.release('detach');f.options.admit=()=>{};
 const next=f.make();await expect(next.acquire(()=>{})).rejects.toThrow('retained');expect(f.write.mock.calls.map(x=>x[0])).toEqual(['/status']);expect(f.spawn).toHaveBeenCalledOnce();await next.release('detach');
});
it('Claude uses its reserved UUID while a trust dialog stays unanswered for the ordinary Needs-you path',async()=>{
 const f=await fixture('claude-code'),native=f.make(),acquisition=await native.acquire(()=>{});expect(native.backend.getSessionId()).toBe(f.launch.launchId);expect(f.options.pin).toHaveBeenCalledWith(f.launch.launchId,f.launch.launchId);expect(f.write).not.toHaveBeenCalled();expect(acquisition.disposition).toBe('fresh');await native.release('detach');expect(f.process.kill).not.toHaveBeenCalled();
});
it('explicit close retires only its owned pane after uncertain input and releases the profile on positive exit',async()=>{
 const f=await fixture('claude-code'),native=f.make();await native.acquire(()=>{});f.write.mockImplementationOnce(()=>{throw Error('uncertain write');});expect(await native.port.sendSpecialKey('Enter')).toBe(false);await native.release('close');expect(f.process.kill).toHaveBeenCalledOnce();expect(f.options.exited).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({launchId:f.launch.launchId,state:'exited'}));expect(f.options.releaseAuthority).toHaveBeenCalledOnce();
});
it('failed pre-admission never reserves a profile or starts a process',async()=>{
 const f=await fixture(),native=f.make();f.options.admit=()=>{throw Error('not admitted');};await expect(native.acquire(()=>{})).rejects.toThrow('not admitted');expect(f.options.reserve).not.toHaveBeenCalled();expect(f.spawn).not.toHaveBeenCalled();
});
it('a profile reservation storage failure precedes every pane side effect',async()=>{
 const f=await fixture(),native=f.make();f.options.reserve=()=>{throw Error('reservation disk full');};await expect(native.acquire(()=>{})).rejects.toThrow('reservation disk full');expect(f.spawn).not.toHaveBeenCalled();expect(f.write).not.toHaveBeenCalled();
});
