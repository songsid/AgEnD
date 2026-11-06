/** Private inert runner + real terminal/parser/receipt paths. No installed provider or user home is read. */
import{afterEach,expect,it,vi}from'vitest';import{randomUUID}from'node:crypto';import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import{RuntimeNativePaneLifecycle,type NativePaneLifecycleOptions}from'../src/native-pane-lifecycle.js';import{RuntimePaneHost}from'../src/runtime-pane-host.js';import{RuntimePaneStore}from'../src/runtime-pane-store.js';import type{RuntimePaneLaunch}from'../src/runtime-pane-protocol.js';
const clean:Array<()=>unknown>=[];afterEach(async()=>{for(const f of clean.splice(0).reverse())await f();vi.restoreAllMocks();});
async function fixture(cli:'codex'|'claude-code'='codex',expected?:string,contextless=false){
 const root=mkdtempSync(join(tmpdir(),'agend-native-lifecycle-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));const actual=randomUUID(),launch:RuntimePaneLaunch={paneId:randomUUID(),launchId:randomUUID(),agentId:randomUUID(),instance:'native-agent',cli,cwd:'C:\\scratch',sandbox:'read-only',columns:100,rows:30,...(expected?{sessionId:expected}:{})};
 let output:(text:string)=>void=()=>{},exit:(value:{exitCode:number})=>void=()=>{};const idle=contextless?'› Ask Codex to do anything\r\n\r\n  ? for shortcuts    ⚠ 2 warnings · f2 to view\r\n':'› Ask Codex to do anything\r\n\r\n  Context 100% left\r\n';
 const write=vi.fn((text:string)=>{if(text==='/status')output('\x1b[2J\x1b[H'+idle.replace('Ask Codex to do anything','/status'));if(text==='\r')output(`\x1b[2J\x1b[HSession: ${actual}\r\n${idle}`);});
 const process={pid:12345,write,resize:vi.fn(),pause:vi.fn(),resume:vi.fn(),kill:vi.fn(()=>exit({exitCode:0})),onData:(fn:typeof output)=>{output=fn;setTimeout(()=>output(cli==='codex'?idle:'Accessing workspace:\r\nC:\\scratch\r\nYes, I trust this folder\r\n❯ No, exit\r\n'),0);return{dispose(){}};},onExit:(fn:typeof exit)=>{exit=fn;return{dispose(){}};}};
 const spawn=vi.fn(async()=>process),host=new RuntimePaneHost({store:new RuntimePaneStore(join(root,'runner')),bootId:randomUUID(),online:()=>true,maxAgents:()=>4,spawn,transcript:()=>({read:async cursor=>{if(!cursor)throw Error("Fixture requires a transcript cursor");return {state:'pending' as const,cursor,data:'',lines:[],complete:false,gap:false};},close:async()=>{}})});clean.push(()=>host.stop());
 const options:NativePaneLifecycleOptions={endpoint:{machineId:randomUUID(),online:()=>true,call:request=>host.request(request),subscribe:()=>()=>{}},receiptFile:join(root,'receipt.json'),launch,admit:vi.fn(),reserve:vi.fn(),pin:vi.fn(),exited:vi.fn(),mcpProof:()=> 'unknown',releaseAuthority:vi.fn()};const make=()=>new RuntimeNativePaneLifecycle(options);
 return{root,actual,launch,options,host,spawn,process,write,make,output:(text:string)=>output(text)};
}
it('fresh Codex asks status once after the real idle detector, pins it and exposes only runtime metadata',async()=>{
 const f=await fixture(),native=f.make(),acquisition=await native.acquire(()=>{});expect(acquisition.disposition).toBe('fresh');expect(f.options.reserve).toHaveBeenCalledExactlyOnceWith(f.launch.launchId);expect(f.options.pin).toHaveBeenCalledWith(f.launch.launchId,f.actual);expect(f.write.mock.calls.map(x=>x[0])).toEqual(['/status','\r']);expect(native.backend.getSessionId()).toBe(f.actual);expect(native.host.executionHost).toBe('remote');
 await acquisition.source.initialize?.();expect((await acquisition.source.runtimeCheckpoint?.())?.cursor.sessionId).toBe(f.actual);expect(acquisition.source.currentPath?.()).toBeNull();const ref=await acquisition.source.runtimeCheckpoint?.();const proof=native.proofReader(ref!,randomUUID());await native.release('detach');expect(await proof.look()).toBe('unavailable');expect(f.process.kill).not.toHaveBeenCalled();
});
it('coordinator reconnect reattaches a busy pinned pane without typing, respawning or waiting for idle',async()=>{
 const f=await fixture(),first=f.make();await first.acquire(()=>{});await first.release('detach');f.output('\x1b[2J\x1b[HWorking on the existing task...\r\n');
 const next=f.make(),acquisition=await next.acquire(()=>{});expect(acquisition.disposition).toBe('reattached');expect(f.spawn).toHaveBeenCalledOnce();expect(f.write.mock.calls.map(x=>x[0])).toEqual(['/status','\r']);expect(f.process.kill).not.toHaveBeenCalled();await expect(first.release('close')).rejects.toThrow('detached');expect(f.process.kill).not.toHaveBeenCalled();await next.release('detach');
});
it.each([true,false])('lost initial open ACK uses host reattach proof and never types startup keys (pinned=%s)',async pinned=>{
 const f=await fixture('codex',pinned?randomUUID():undefined),call=f.options.endpoint.call,first=f.make();
 f.options.endpoint.call=async request=>{const result=await call(request);if(request.action==='open')throw Error('open ACK lost');return result;};
 await expect(first.acquire(()=>{})).rejects.toThrow('ACK lost');await first.release('detach');
 f.options.endpoint.call=call;
 f.output(pinned?'\x1b[2J\x1b[HWorking on the existing task...\r\n':'\x1b[2J\x1b[H› Ask Codex to do anything\r\n\r\n  Context 100% left\r\n');
 const next=f.make();
 if(pinned)expect((await next.acquire(()=>{})).disposition).toBe('reattached');
 else await expect(next.acquire(()=>{})).rejects.toThrow('no startup input');
 expect(f.write).not.toHaveBeenCalled();expect(f.spawn).toHaveBeenCalledOnce();await next.release('detach');
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
 const f=await fixture('claude-code'),native=f.make();await native.acquire(()=>{});
 await vi.waitFor(async()=>expect(await native.port.capturePane()).toContain('Yes, I trust this folder'));
 const screen=await native.port.capturePane();f.write.mockImplementationOnce(()=>{throw Error('uncertain explicit Escape');});
 expect(await native.port.sendSpecialKey('Escape',undefined,{kind:'dialog',screen})).toBe(false);expect(f.write).toHaveBeenCalledExactlyOnceWith('\x1b');
 await native.release('close');const pins=vi.mocked(f.options.pin).mock.calls.length;native.checkpointSession();expect(f.options.pin).toHaveBeenCalledTimes(pins);expect(f.process.kill).toHaveBeenCalledOnce();expect(f.options.exited).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({launchId:f.launch.launchId,state:'exited'}));expect(f.options.releaseAuthority).toHaveBeenCalledOnce();
});
it('failed pre-admission never reserves a profile or starts a process',async()=>{
 const f=await fixture(),native=f.make();f.options.admit=()=>{throw Error('not admitted');};await expect(native.acquire(()=>{})).rejects.toThrow('not admitted');expect(f.options.reserve).not.toHaveBeenCalled();expect(f.spawn).not.toHaveBeenCalled();
});
it('a profile reservation storage failure precedes every pane side effect',async()=>{
 const f=await fixture(),native=f.make();f.options.reserve=()=>{throw Error('reservation disk full');};await expect(native.acquire(()=>{})).rejects.toThrow('reservation disk full');expect(f.spawn).not.toHaveBeenCalled();expect(f.write).not.toHaveBeenCalled();
});

it('a startup repaint positively refusing the fixed status input retries only that unsent command',async()=>{
 const f=await fixture(),call=f.options.endpoint.call;let refused=false;
 f.options.endpoint.call=async request=>{if(request.action==='input'&&!refused){refused=true;f.output('queued MCP registration output\r\n› Ask Codex to do anything\r\n\r\n  Context 100% left\r\n');}return call(request);};
 const native=f.make();await native.acquire(()=>{});expect(refused).toBe(true);expect(f.write.mock.calls.map(row=>row[0])).toEqual(['/status','\r']);expect(f.options.pin).toHaveBeenCalledWith(f.launch.launchId,f.actual);
});
it('a lost fixed status input response never repeats that command or sends Enter',async()=>{
 const f=await fixture(),call=f.options.endpoint.call;let lost=false;
 f.options.endpoint.call=async request=>{const result=await call(request);if(request.action==='input'&&!lost){lost=true;throw Error('lost input ACK');}return result;};
 const native=f.make();await expect(native.acquire(()=>{})).rejects.toThrow('status input');expect(f.write.mock.calls.map(row=>row[0])).toEqual(['/status']);expect(f.options.pin).not.toHaveBeenCalled();
});

it('transient capture failures during startup and status repaint retry only reads, never the actual input',async()=>{
 const f=await fixture(),call=f.options.endpoint.call;let initial=false,paint=false;
 f.options.endpoint.call=async request=>{if(request.action==='capture'&&(!initial||f.write.mock.calls.some(row=>row[0]==='/status')&&!paint)){if(!initial)initial=true;else paint=true;throw Error('output arrived during capture');}return call(request);};
 const native=f.make();await native.acquire(()=>{});expect(initial&&paint).toBe(true);expect(f.write.mock.calls.map(row=>row[0])).toEqual(['/status','\r']);expect(f.options.pin).toHaveBeenCalledWith(f.launch.launchId,f.actual);
});
it('a typed /status still painting at the first read is re-read until it shows, then submitted exactly once (S-35 B)',async()=>{
 const f=await fixture(),paintScreen=f.write.getMockImplementation()!;
 f.write.mockImplementation((text:string)=>{if(text==='/status'){setTimeout(()=>paintScreen(text),900);return;}paintScreen(text);});
 const native=f.make();await native.acquire(()=>{});
 expect(f.write.mock.calls.map(row=>row[0])).toEqual(['/status','\r']);expect(f.options.pin).toHaveBeenCalledExactlyOnceWith(f.launch.launchId,f.actual);expect(native.backend.getSessionId()).toBe(f.actual);
},30_000);
it('a /status that never paints fails inside the bound with no Enter and no retyped /status (S-35 B)',async()=>{
 const f=await fixture();f.write.mockImplementation((text:string)=>{if(text!=='/status')f.output('\x1b[2J\x1b[H› Ask Codex to do anything\r\n\r\n  Context 100% left\r\n');});
 const native=f.make();await expect(native.acquire(()=>{})).rejects.toThrow('composer changed; no Enter was sent');
 expect(f.write.mock.calls.map(row=>row[0])).toEqual(['/status']);expect(f.options.pin).not.toHaveBeenCalled();await native.release('detach');
},40_000);
it('a lost Enter acknowledgement after a painted /status is never resubmitted (S-35 B)',async()=>{
 const f=await fixture(),call=f.options.endpoint.call;let inputs=0;
 f.options.endpoint.call=async request=>{const result=await call(request);if(request.action==='key'){inputs++;if(inputs===1)throw Error('lost Enter ACK');}return result;};
 const native=f.make();await expect(native.acquire(()=>{})).rejects.toThrow('submission is unconfirmed');
 expect(f.write.mock.calls.map(row=>row[0])).toEqual(['/status','\r']);expect(f.options.pin).not.toHaveBeenCalled();await native.release('detach');
});
it('the native Enter proof accepts a long owned pasted envelope, and refuses one under a transcript output row (S-35 A)',async()=>{
 const f=await fixture(),native=f.make();const inputIsComposer=(native.port as unknown as {inputIsComposer(screen:string):boolean}).inputIsComposer;
 const envelope=Array.from({length:6},(_,i)=>`  wrapped envelope line ${i+1} of the pasted message body`);
 const owned=['› [agend-human-id:hmsg-1] first line of the pasted message',...envelope,'','  Context 95% left'].join('\n');
 const history=['› old echoed prompt','  wrapped history','• Called agend.reply',...envelope,'','  Context 95% left'].join('\n');
 expect(inputIsComposer(owned)).toBe(true);expect(inputIsComposer(history)).toBe(false);await native.release('detach');
});

it('a contextless exact native resume verifies only its once-typed status command and retains the session',async()=>{
 const f=await fixture('codex',undefined,true);f.launch.sessionId=f.actual;const native=f.make();let retired=false,result:unknown;
 const pending=native.acquire(()=>{if(retired)throw Error('test admission retired');});void pending.then(value=>{result=value;},()=>{});
 try{
  await vi.waitFor(()=>expect(result).toBeDefined(),{timeout:8000});
  expect(result).toMatchObject({disposition:'resumed'});expect(f.write.mock.calls.map(row=>row[0])).toEqual(['/status','\r']);
  expect(f.options.pin).toHaveBeenCalledExactlyOnceWith(f.launch.launchId,f.actual);expect(native.backend.getSessionId()).toBe(f.actual);
 }finally{retired=true;await native.release('detach');await pending.catch(()=>{});}
});

it('a contextless fixed-status draft containing extra text never takes Enter',async()=>{
 const f=await fixture('codex',undefined,true);f.launch.sessionId=f.actual;const paint=f.write.getMockImplementation()!;
 f.write.mockImplementation(text=>{if(text==='/status'){f.output('\x1b[2J\x1b[H› /status\r\n  unrelated draft text\r\n\r\n  ? for shortcuts    ⚠ 2 warnings · f2 to view\r\n');return;}paint(text);});
 const call=f.options.endpoint.call;let reads=0,retired=false;
 f.options.endpoint.call=async request=>{const result=await call(request);if(request.action==='capture'&&f.write.mock.calls.some(row=>row[0]==='/status'))reads++;return result;};
 const native=f.make(),pending=native.acquire(()=>{if(retired)throw Error('test admission retired');});void pending.catch(()=>{});
 try{await vi.waitFor(()=>expect(reads).toBeGreaterThanOrEqual(2),{timeout:8000});expect(f.write.mock.calls.map(row=>row[0])).toEqual(['/status']);expect(f.options.pin).not.toHaveBeenCalled();}
 finally{retired=true;await native.release('detach');await pending.catch(()=>{});}
});
it('contextless fixed-status readiness still needs its native owned-composer proof',async()=>{
 const f=await fixture('codex',undefined,true);f.launch.sessionId=f.actual;const native=f.make();
 const screen='› /status\n\n  ? for shortcuts    ⚠ 2 warnings · f2 to view';
 expect((native as unknown as {ready(text:string,fixed?:boolean):boolean}).ready(screen)).toBe(false);
 expect((native as unknown as {ready(text:string,fixed?:boolean):boolean}).ready(screen,true)).toBe(true);
 vi.spyOn(native.backend,'ownsComposerRows').mockReturnValue(false);
 expect((native as unknown as {ready(text:string,fixed?:boolean):boolean}).ready(screen,true)).toBe(false);await native.release('detach');
});
