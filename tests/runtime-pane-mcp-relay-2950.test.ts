/** Real loopback HTTP + both authenticated WS hops; no account, CLI, process or fleet. */
import { afterEach, expect, it, vi } from "vitest";
import { createServer, request, type Server } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeClient } from "../src/runtime-client.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { RuntimeCoordinator, type RuntimeCoordinatorOptions } from "../src/runtime-coordinator.js";
import { RuntimePaneLink } from "../src/runtime-pane-link.js";
import { RuntimePaneHost, type RuntimePaneHostOptions } from "../src/runtime-pane-host.js";
import { startPaneService } from "../src/runtime-pane-service.js";
import { PaneMcpSession, paneMcpHttp, type PaneMcpConnection } from "../src/windows-pane-mcp.js";
import type { RuntimePaneSnapshot } from "../src/runtime-pane-protocol.js";
const clean: Array<()=>unknown|Promise<unknown>>=[];
afterEach(async()=>{ for (const done of clean.splice(0).reverse()) await done(); vi.restoreAllMocks(); });
function dir(){const path=mkdtempSync(join(tmpdir(),'agend-pane-mcp-relay-'));clean.push(()=>rmSync(path,{recursive:true,force:true}));return path;}
function fakeProcess(){let exit:(v:{exitCode:number})=>void=()=>{};return{pid:12345,write:vi.fn(),resize:vi.fn(),pause:vi.fn(),resume:vi.fn(),kill:()=>exit({exitCode:0}),onExit:(fn:typeof exit)=>{exit=fn;return{dispose(){}};},onData:()=>({dispose(){}})};}
async function rig(handle:RuntimeCoordinatorOptions['handlePaneMcp']){
 const home=dir(),hub=new RuntimeCoordinator(home,{handlePaneMcp:handle});clean.push(()=>hub.close());
 const pair=hub.createPairing(),pending=hub.pair({code:pair.code,name:'MCP fixture',platform:'win32'});hub.approve(pending.machineId,hub.machine(pending.machineId)!.pairingFingerprint);
 const claim=hub.claim({machineId:pending.machineId,claimSecret:pending.claimSecret});if(claim.status!=='approved')throw Error('pair fixture');
 const server=createServer();clean.push(()=>new Promise<void>(done=>server.close(()=>done())));server.on('upgrade',(req,socket,head)=>{if(!hub.handleUpgrade(req,socket,head))socket.destroy();});server.listen(0,'127.0.0.1');await once(server,'listening');
 let hostOptions!:RuntimePaneHostOptions;
 const service=await startPaneService({directory:dir(),scope:'a'.repeat(64),createHost:opts=>{hostOptions=opts;return new RuntimePaneHost({...opts,spawn:async()=>fakeProcess()});}});clean.push(()=>service.close());
 const store=new RuntimeClientStore(dir());store.saveCredentials({server:`http://127.0.0.1:${(server.address()as any).port}`,name:'MCP fixture',machineId:claim.machineId,credential:claim.credential});
 const client=new RuntimeClient({store,reconnectMs:10,bridge:{probe:async()=>({home:'C:\\fixture',clis:[],probedAt:Date.now()}),prepareWorkspace:async()=>{throw Error('unused');},start:()=>{throw Error('no exec');},get:()=>null,cancel:()=>{throw Error('unused');},close(){},releaseUnknown(){}},
 openPaneLink:opts=>RuntimePaneLink.attach(service.descriptor,opts)});clean.push(()=>client.stop());await client.start();await vi.waitFor(()=>expect(client.online()).toBe(true));
 const launch={paneId:randomUUID(),agentId:randomUUID(),instance:'pane-agent',cli:'codex'as const,cwd:'C:\\fixture',sandbox:'read-only'as const,columns:80,rows:24};
 const pane=await hub.callPane(claim.machineId,{action:'open',operationId:randomUUID(),launch})as RuntimePaneSnapshot;
 const owner={hostBootId:pane.hostBootId,paneId:pane.paneId,launchId:pane.launchId,agentId:pane.agentId,instance:pane.instance};
 return{home,hub,client,pane,owner,machineId:claim.machineId,connection:hostOptions.mcpConnection!(owner,['reply']),closePane:()=>hub.callPane(claim.machineId,{action:'close',paneId:pane.paneId,launchId:pane.launchId,operationId:randomUUID(),sequence:1})};
}
it('routes a pane call separately from exec and sends the written receipt only after the helper write barrier',async()=>{
 const calls:unknown[]=[];const handler=vi.fn(async(machine,body,current)=>{expect(current()).toBe(true);calls.push({machine,body});return body.method==='response-written'?{result:{ok:true}}:{result:{content:[{type:'text',text:'done'}]},responseId:'c'.repeat(64)};});
 const f=await rig(handler),session=new PaneMcpSession(f.connection);const response=await session.rpc({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'reply',arguments:{text:'minimal'}}});
 expect(response).toMatchObject({result:{content:[{text:'done'}]}});expect(handler).toHaveBeenCalledTimes(1);
 expect(calls[0]).toMatchObject({machine:f.machineId,body:{owner:f.owner,method:'tools/call'}});
 expect(JSON.parse(readFileSync(join(f.home,'runtime-machines.json'),'utf8')).commands).toHaveLength(0);
 await session.responseWritten(response!);await session.responseWritten(response!);expect(handler).toHaveBeenCalledTimes(2);expect(calls[1]).toMatchObject({body:{method:'response-written',responseId:'c'.repeat(64)}});
});
it('the CLI scope cannot impersonate another pane or the host credential, and exits revoke it',async()=>{
 const handler=vi.fn(async()=>({result:{tools:[]}})),f=await rig(handler);
 const body={op:'pane-mcp'as const,method:'tools/list'as const,params:{},owner:f.owner,helperId:randomUUID()};
 const other={...f.owner,agentId:randomUUID()};
 await expect(paneMcpHttp(f.connection,{...body,owner:other})).rejects.toThrow('unavailable');
 expect(handler).not.toHaveBeenCalled();await paneMcpHttp(f.connection,body);expect(handler).toHaveBeenCalledOnce();
 await f.closePane();await expect(paneMcpHttp(f.connection,body)).rejects.toThrow('unavailable');expect(handler).toHaveBeenCalledOnce();
});
it('disconnect during a held tool call invalidates the commit lease and never sends it again on reconnect',async()=>{
 let release!:(value:unknown)=>void,current!:()=>boolean;const held=new Promise(done=>release=done);
 const handler=vi.fn(async(_machine,_body,lease)=>{current=lease;return held;});const f=await rig(handler);
 const pending=paneMcpHttp(f.connection,{op:'pane-mcp',method:'tools/call',params:{name:'reply',arguments:{}},callId:'a'.repeat(64),owner:f.owner,helperId:randomUUID()});
 const rejected=expect(pending).rejects.toThrow('unavailable');await vi.waitFor(()=>expect(handler).toHaveBeenCalledOnce());await f.client.stop();await rejected;
 expect(current()).toBe(false);release({result:{ok:true}});expect(handler).toHaveBeenCalledOnce();
});
it('rejects origin, query, malformed UTF-8 and extra shell fields before any dispatch',async()=>{
 const handler=vi.fn(),f=await rig(handler);
 async function post(path:string,body:Buffer,headers:Record<string,string>={}){return new Promise<number>((done,reject)=>{const req=request(f.connection.endpoint+path,{method:'POST',headers:{'X-Agend-Native-Token':f.connection.token,...headers}},res=>{res.resume();res.on('end',()=>done(res.statusCode!));});req.on('error',reject);req.end(body);});}
 const body=Buffer.from(JSON.stringify({op:'pane-mcp',method:'tools/list',params:{},owner:f.owner,helperId:randomUUID()}));
 expect(await post('',body,{Origin:'https://foreign.invalid'})).toBe(403);expect(await post('?x=1',body)).toBe(404);expect(await post('',Buffer.from([0xff]))).toBe(403);
 expect(await post('',Buffer.from(JSON.stringify({...JSON.parse(body.toString()),shell:'whoami'})))).toBe(403);expect(handler).not.toHaveBeenCalled();
});
