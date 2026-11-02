import {afterEach,expect,it,vi} from 'vitest';
import {PassThrough} from 'node:stream';import {EventEmitter} from 'node:events';import {randomUUID} from 'node:crypto';
import {LocalPaneEndpoint} from '../src/local-pane-endpoint.js';import {serveLocalPaneRelay} from '../src/runtime-pane-stdio.js';import {PaneStdioFramer,paneStdioInput,paneStdioOutput,PANE_STDIO_LIMIT} from '../src/runtime-pane-stdio-protocol.js';import type {PaneLinkOptions} from '../src/runtime-pane-link.js';
const stops:Array<()=>unknown>=[];afterEach(()=>{for(const f of stops.splice(0).reverse())f();vi.useRealTimers();});
async function fixture(){
 const input=new PassThrough(),output=new PassThrough(),stderr=new PassThrough();const child=Object.assign(new EventEmitter(),{stdin:input,stdout:output,stderr,kill:vi.fn()}),request=vi.fn(async()=>({hostBootId,panes:[]})),stop=vi.fn(async()=>{}),changed=vi.fn();let settings!:PaneLinkOptions,allowed=true,limit=4;const hostBootId=randomUUID();
 const detach=serveLocalPaneRelay(input,output,async options=>{settings=options;return{hostBootId,request,stop,connectionChanged:changed} as never;});stops.push(detach);const mcp=vi.fn(async()=>({tools:[]}));
 const options={scope:'a'.repeat(64),admit:()=>{if(!allowed)throw Error('off');},maxAgents:()=>limit,version:()=> 'Codex 0.165.0',launch:async()=>child as never,mcp};const endpoint=await LocalPaneEndpoint.open(options);stops.push(()=>endpoint.stop());return{endpoint,settings,options,input,output,child,request,stop,changed,mcp,setAllowed:(value:boolean)=>{allowed=value;},setLimit:(value:number)=>{limit=value;}};
}
it('fragments UTF-8, coalesces frames and rejects malformed/oversized/arbitrary-command frames',()=>{
 const got:unknown[]=[],framer=new PaneStdioFramer(),epoch=randomUUID(),line=Buffer.from(JSON.stringify({label:'中文'})+'\n');for(const byte of line)framer.feed(Buffer.from([byte]),value=>got.push(value));framer.feed(Buffer.from('{}\n{}\n'),value=>got.push(value));expect(got).toEqual([{label:'中文'},{},{}]);
 expect(()=>new PaneStdioFramer().feed(Buffer.alloc(PANE_STDIO_LIMIT+1,65),()=>{})).toThrow('limit');expect(()=>new PaneStdioFramer().feed(Buffer.from([0xff]),()=>{})).toThrow();expect(()=>paneStdioInput({type:'request',epoch,id:randomUUID(),request:{action:'shell',command:'no'}})).toThrow();expect(()=>paneStdioInput({type:'init',epoch,scope:'a'.repeat(64),maxAgents:4,path:'C:\\other'})).toThrow();expect(()=>paneStdioOutput({type:'hello',epoch,hostBootId:randomUUID(),token:'never'})).toThrow();
});
it('uses the fixed installation scope and main-loop lease, routes closed RPC, and detaches without killing panes',async()=>{
 const f=await fixture();expect(f.endpoint.online()).toBe(true);expect(f.settings.directory).toContain('pane-adapter');expect(f.settings.directory).toContain('a'.repeat(64));expect(f.endpoint.machineId).toBe('local');expect(f.endpoint.version('codex')).toBe('Codex 0.165.0');
 await expect(f.endpoint.call({action:'list'})).resolves.toHaveProperty('panes',[]);expect(f.request).toHaveBeenCalledExactlyOnceWith({action:'list'},expect.any(Function));f.endpoint.stop();await vi.waitFor(()=>expect(f.stop).toHaveBeenCalledOnce());expect(f.child.kill).not.toHaveBeenCalled();expect(f.endpoint.online()).toBe(false);
});
it('relays MCP in the exact connection epoch without leaking any bearer onto stdio',async()=>{
 const f=await fixture(),body={op:'pane-mcp' as const,owner:{hostBootId:randomUUID(),paneId:randomUUID(),launchId:randomUUID(),agentId:randomUUID(),instance:'native'},helperId:randomUUID(),method:'tools/list' as const,params:{}};
 expect(await f.settings.mcp!(body,()=>true)).toEqual({tools:[]});expect(f.mcp).toHaveBeenCalledWith(body,expect.any(Function));
});
it('switch-off during launcher resolution sends no init and signals nothing',async()=>{
 const input=new PassThrough(),output=new PassThrough(),child=Object.assign(new EventEmitter(),{stdin:input,stdout:output,stderr:new PassThrough(),kill:vi.fn()});let release!:(value:any)=>void,allowed=true;const bytes:string[]=[];input.on('data',value=>{bytes.push(value.toString());const frame=JSON.parse(value.toString());if(frame.type==='init')output.write(JSON.stringify({type:'hello',epoch:frame.epoch,hostBootId:randomUUID()})+'\n');});
 const pending=LocalPaneEndpoint.open({scope:'b'.repeat(64),admit:()=>{if(!allowed)throw Error('off');},maxAgents:()=>4,version:()=>null,mcp:async()=>null,launch:()=>new Promise(resolve=>{release=resolve;})});allowed=false;release(child);await expect(pending).rejects.toThrow('off');expect(bytes).toEqual([]);expect(child.kill).not.toHaveBeenCalled();
});
it('lost reply becomes unconfirmed without replay or a process signal',async()=>{
 const f=await fixture();let finish!:(value:unknown)=>void;f.request.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const request=f.endpoint.call({action:'list'});const caught=expect(request).rejects.toThrow('retained');await Promise.resolve();f.endpoint.stop();await caught;finish({panes:[]});await Promise.resolve();expect(f.request).toHaveBeenCalledOnce();expect(f.child.kill).not.toHaveBeenCalled();
});
it('a stale frame cannot renew an attachment or dispatch work',async()=>{
 const f=await fixture();f.output.write(JSON.stringify({type:'response',epoch:randomUUID(),id:randomUUID(),ok:true,result:{}})+'\n');await Promise.resolve();expect(f.endpoint.online()).toBe(false);expect(f.request).not.toHaveBeenCalled();expect(f.child.kill).not.toHaveBeenCalled();
});
it('expired parent progress revokes the relay lease even when its own timer still runs',async()=>{
 vi.useFakeTimers();const f=await fixture();expect(f.settings.online()).toBe(true);vi.setSystemTime(Date.now()+20_000); // performance time is advanced separately by the fake timer.
 // A child timer can run while the coordinator loop does not. Remove only the parent's interval to model that gap.
 const endpoint:any=f.endpoint;clearInterval(endpoint.interval);await vi.advanceTimersByTimeAsync(20_000);expect(f.settings.online()).toBe(false);expect(f.endpoint.online()).toBe(false);expect(f.child.kill).not.toHaveBeenCalled();
});
