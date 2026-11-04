/** Durable identities and dynamic owner/permission fences; no process or account. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PaneMcpAuthorityLease, type PaneMcpAuthority } from '../src/runtime-pane-mcp.js';
import type { PaneMcpBody } from '../src/runtime-pane-mcp-protocol.js';
const roots:string[]=[];
afterEach(()=>{roots.splice(0).forEach(path=>rmSync(path,{recursive:true,force:true}));vi.restoreAllMocks();});
function rig(){const root=mkdtempSync(join(tmpdir(),'agend-pane-tool-'));roots.push(root);let active=true,permitted=true;
 const owner={hostBootId:randomUUID(),paneId:randomUUID(),launchId:randomUUID(),agentId:randomUUID(),instance:'agent-中文'},machineId=randomUUID(),file=join(root,'calls.json');
 const invoke=vi.fn(async(_input:any,_current:()=>boolean)=>({result:{ok:true}})),written=vi.fn();
 const authority:PaneMcpAuthority={machineId,owner,current:()=>active,menu:()=>permitted?[{name:'reply'}]:[],allowed:()=>permitted,invoke,responseWritten:written};
 const lease=new PaneMcpAuthorityLease(file,authority),body:Extract<PaneMcpBody,{method:'tools/call'}>={op:'pane-mcp',method:'tools/call',owner,helperId:randomUUID(),callId:'a'.repeat(64),params:{name:'reply',arguments:{text:'PRIVATE_PROMPT'}}};
 return{lease,authority,file,owner,machineId,body,invoke,written,inactive:()=>active=false,revoke:()=>permitted=false,call:(b:unknown=body,current=()=>true)=>lease.handle(machineId,b,current)};
}
it('reserves one durable operation before invocation and never persists prompt or result content',async()=>{
 const f=rig();f.invoke.mockImplementationOnce(async(input)=>{const ledger=readFileSync(f.file,'utf8');expect(ledger).toContain(input.operationId);expect(ledger).toContain('prepared');return{result:{ok:true,secret:'PRIVATE_RESULT'}};});
 const first=await f.call()as any;expect(first.result.content[0].text).toContain('PRIVATE_RESULT');expect(f.written).not.toHaveBeenCalled();
 expect(await f.call()).toEqual(first);expect(f.invoke).toHaveBeenCalledOnce();expect(readFileSync(f.file,'utf8')).not.toMatch(/PRIVATE_PROMPT|PRIVATE_RESULT/);
 const ack={op:'pane-mcp',method:'response-written',owner:f.owner,helperId:f.body.helperId,callId:f.body.callId,responseId:first.responseId};
 await expect(f.call({...ack,responseId:'b'.repeat(64)})).rejects.toThrow('receipt');await f.call(ack);await f.call(ack);expect(f.written).toHaveBeenCalledExactlyOnceWith(f.invoke.mock.calls[0][0].operationId);
 expect(await f.call()).toMatchObject({result:{isError:true}});expect(f.invoke).toHaveBeenCalledOnce();
});
it('joins an in-flight call and rejects changing its arguments',async()=>{
 const f=rig();let finish!:(v:{result:{ok:boolean}})=>void;f.invoke.mockImplementationOnce(()=>new Promise(done=>finish=done));
 const one=f.call();await vi.waitFor(()=>expect(f.invoke).toHaveBeenCalledOnce());const two=f.call();
 await expect(f.call({...f.body,params:{name:'reply',arguments:{text:'changed'}}})).rejects.toThrow('different arguments');finish({result:{ok:true}});expect(await two).toEqual(await one);expect(f.invoke).toHaveBeenCalledOnce();
});
it('a helper restart can reuse JSON-RPC ids without reusing the previous tool identity',async()=>{
 const f=rig();await f.call();await f.call({...f.body,helperId:randomUUID()});expect(f.invoke).toHaveBeenCalledTimes(2);expect(f.invoke.mock.calls[0][0].operationId).not.toBe(f.invoke.mock.calls[1][0].operationId);
});
it('a coordinator restart keeps the prior identity and refuses a second dispatch even without its response cache',async()=>{
 const f=rig();await f.call();const restored=new PaneMcpAuthorityLease(f.file,f.authority);
 expect(await restored.handle(f.machineId,f.body,()=>true)).toMatchObject({result:{isError:true}});expect(f.invoke).toHaveBeenCalledOnce();
});
it('does not dispatch or advertise tools after permission revocation, and checks permission again before commit',async()=>{
 const f=rig();let release!:(v:{result:{ok:boolean}})=>void,current!:()=>boolean;
 f.invoke.mockImplementationOnce((_input,lease)=>{current=lease;return new Promise(done=>release=done);});
 const promise=f.call(),rejection=expect(promise).rejects.toThrow('expired');await vi.waitFor(()=>expect(f.invoke).toHaveBeenCalledOnce());f.revoke();expect(current()).toBe(false);release({result:{ok:true}});await rejection;
 expect(await f.call({op:'pane-mcp',method:'tools/list',owner:f.owner,helperId:f.body.helperId,params:{}})).toEqual({result:{tools:[]}});
 await expect(f.call()).rejects.toThrow('revoked');
});
it('keeps a prepared operation after process interruption and refuses replay',async()=>{
 const f=rig();let release!:(v:{result:{ok:boolean}})=>void;f.invoke.mockImplementationOnce(()=>new Promise(done=>release=done));const pending=f.call();await vi.waitFor(()=>expect(f.invoke).toHaveBeenCalledOnce());
 const restored=new PaneMcpAuthorityLease(f.file,f.authority);expect(await restored.handle(f.machineId,f.body,()=>true)).toMatchObject({result:{isError:true}});expect(f.invoke).toHaveBeenCalledOnce();release({result:{ok:true}});await pending;
});
it('foreign machine, agent, host boot or launch cannot use or acknowledge a scope',async()=>{
 const f=rig();await expect(f.lease.handle(randomUUID(),f.body,()=>true)).rejects.toThrow('owner');
 for(const key of ['agentId','hostBootId','launchId','paneId']as const)await expect(f.call({...f.body,owner:{...f.owner,[key]:randomUUID()}})).rejects.toThrow('owner');
 await expect(f.call(f.body,()=>false)).rejects.toThrow('owner');f.inactive();await expect(f.call()).rejects.toThrow('owner');expect(f.invoke).not.toHaveBeenCalled();
});
it('acknowledged calls clear the bounded response backlog so a long-lived agent exceeds 64 calls',async()=>{
 const f=rig();for(let index=0;index<70;index++){const callId=index.toString(16).padStart(64,'0');const response=await f.call({...f.body,callId})as any;await f.call({op:'pane-mcp',method:'response-written',owner:f.owner,helperId:f.body.helperId,callId,responseId:response.responseId});}expect(f.invoke).toHaveBeenCalledTimes(70);expect(f.written).toHaveBeenCalledTimes(70);
});
it('helper presence is bound to the stable connection generation, not the lifetime of one completed RPC',async()=>{
 const f=rig();let epoch:string|null='connection-1',rpc=true;f.authority.transportEpoch=()=>epoch;
 const presence={op:'pane-mcp',owner:f.owner,helperId:f.body.helperId,method:'presence',params:{}};expect(f.lease.serving()).toBe(false);
 await f.call(presence,()=>rpc);rpc=false;expect(f.lease.serving()).toBe(true);expect(f.invoke).not.toHaveBeenCalled();epoch=null;expect(f.lease.serving()).toBe(false);epoch='connection-2';expect(f.lease.serving()).toBe(false);
 await f.call(presence);expect(f.lease.serving()).toBe(true);f.inactive();expect(f.lease.serving()).toBe(false);
});
it('presence expires monotonically and unknown or foreign transports never prove a live helper',async()=>{
 const f=rig(),presence={op:'pane-mcp',owner:f.owner,helperId:f.body.helperId,method:'presence',params:{}};
 await expect(f.call(presence)).rejects.toThrow('transport identity');expect(f.lease.serving()).toBe(false);f.authority.transportEpoch=()=> 'current';
 await expect(f.call({...presence,owner:{...f.owner,launchId:randomUUID()}})).rejects.toThrow('owner');expect(f.lease.serving()).toBe(false);await f.call(presence);expect(f.lease.serving()).toBe(true);
 vi.spyOn(performance,'now').mockReturnValue(performance.now()+15000);expect(f.lease.serving()).toBe(false);f.lease.close();expect(f.lease.serving()).toBe(false);
});

it('preserves the redacted lower failure reason/code in the tool result and one metadata log without persisting it',async()=>{
 const f=rig(),failed=vi.fn();f.authority.toolFailed=failed;f.authority.invoke=vi.fn(async()=>({result:null,error:'Fleet outbound timed out after 30s; token=PRIVATE_TOKEN_CANARY; content=PRIVATE_REPLY_CANARY',errorCode:'ETIMEDOUT'}));
 const first=await f.call()as any,detail=first.result.structuredContent.error;
 expect(first.result.isError).toBe(true);expect(first.result.content[0].text).toContain('Fleet outbound timed out after 30s');expect(first.result.content[0].text).toContain('ETIMEDOUT');
 expect(detail).toMatchObject({reason:expect.stringContaining('Fleet outbound timed out after 30s'),code:'ETIMEDOUT',operationId:expect.any(String)});
 expect(failed).toHaveBeenCalledExactlyOnceWith({tool:'reply',...detail});expect(JSON.stringify(first)).not.toMatch(/PRIVATE_TOKEN_CANARY|PRIVATE_REPLY_CANARY|PRIVATE_PROMPT/);
 expect(readFileSync(f.file,'utf8')).not.toMatch(/PRIVATE_|timed out|ETIMEDOUT/);
 expect(await f.call()).toEqual(first);expect(f.authority.invoke).toHaveBeenCalledOnce();expect(failed).toHaveBeenCalledOnce();
});
it.each([undefined,-32001])('keeps an absent or numeric code %s without inventing an error or changing the outcome when logging fails',async code=>{
 const f=rig();f.authority.invoke=async()=>({result:null,error:'No active chat context',...(code===undefined?{}:{errorCode:code})});f.authority.toolFailed=()=>{throw Error('logger offline');};
 const response=await f.call()as any;expect(response.result).toMatchObject({isError:true,structuredContent:{error:{reason:'No active chat context',code:code??null}}});
 expect(response.result.content[0].text).not.toContain('Tool outcome is unconfirmed');
});
