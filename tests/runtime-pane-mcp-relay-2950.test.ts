/** Real loopback HTTP + both authenticated WS hops; no account, CLI, process or fleet. */
import { afterEach, expect, it, vi } from "vitest";
import { createServer, request, type Server } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeClient, RUNTIME_CONNECTED_REPORT } from "../src/runtime-client.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { RuntimeCoordinator, type RuntimeCoordinatorOptions } from "../src/runtime-coordinator.js";
import { PaneMcpRelay } from "../src/runtime-pane-mcp-relay.js";
import { RuntimePaneLink } from "../src/runtime-pane-link.js";
import { RuntimePaneHost, type RuntimePaneHostOptions } from "../src/runtime-pane-host.js";
import { startPaneService } from "../src/runtime-pane-service.js";
import { PaneMcpSession, paneMcpHttp, type PaneMcpConnection } from "../src/windows-pane-mcp.js";
import type { RuntimePaneSnapshot } from "../src/runtime-pane-protocol.js";
const clean: Array<()=>unknown|Promise<unknown>>=[];
afterEach(async()=>{ for (const done of clean.splice(0).reverse()) await done(); vi.restoreAllMocks(); });
function dir(){const path=mkdtempSync(join(tmpdir(),'agend-pane-mcp-relay-'));clean.push(()=>rmSync(path,{recursive:true,force:true}));return path;}
function fakeProcess(){let exit:(v:{exitCode:number})=>void=()=>{};return{pid:12345,write:vi.fn(),resize:vi.fn(),pause:vi.fn(),resume:vi.fn(),kill:()=>exit({exitCode:0}),onExit:(fn:typeof exit)=>{exit=fn;return{dispose(){}};},onData:()=>({dispose(){}})};}
async function rig(handle:RuntimeCoordinatorOptions['handlePaneMcp'], protocol: { server?:1; client?:1; host?:1 } = {}){
 const home=dir(),hub=new RuntimeCoordinator(home,{handlePaneMcp:handle,...(protocol.server?{requestContextProtocol:1 as const}:{})});clean.push(()=>hub.close());
 const pair=hub.createPairing(),pending=hub.pair({code:pair.code,name:'MCP fixture',platform:'win32'});hub.approve(pending.machineId,hub.machine(pending.machineId)!.pairingFingerprint);
 const claim=hub.claim({machineId:pending.machineId,claimSecret:pending.claimSecret});if(claim.status!=='approved')throw Error('pair fixture');
 const server=createServer();clean.push(()=>new Promise<void>(done=>server.close(()=>done())));server.on('upgrade',(req,socket,head)=>{if(!hub.handleUpgrade(req,socket,head))socket.destroy();});server.listen(0,'127.0.0.1');await once(server,'listening');
 let hostOptions!:RuntimePaneHostOptions;
 const service=await startPaneService({...(protocol.host?{requestContextProtocol:1 as const}:{}),directory:dir(),scope:'a'.repeat(64),createHost:opts=>{hostOptions=opts;return new RuntimePaneHost({...opts,spawn:async()=>fakeProcess()});}});clean.push(()=>service.close());
 const store=new RuntimeClientStore(dir());store.saveCredentials({server:`http://127.0.0.1:${(server.address()as any).port}`,name:'MCP fixture',machineId:claim.machineId,credential:claim.credential});
 let connected!:()=>void;const welcomed=new Promise<void>(done=>{connected=done;});
 const client=new RuntimeClient({report:text=>{if(text===RUNTIME_CONNECTED_REPORT)connected();},store,...(protocol.client?{requestContextProtocol:1 as const}:{}),reconnectMs:10,bridge:{probe:async()=>({home:'C:\\fixture',clis:[],probedAt:Date.now()}),prepareWorkspace:async()=>{throw Error('unused');},start:()=>{throw Error('no exec');},get:()=>null,cancel:()=>{throw Error('unused');},close(){},releaseUnknown(){}},
 openPaneLink:opts=>RuntimePaneLink.attach(service.descriptor,opts)});clean.push(()=>client.stop());await client.start();await welcomed;expect(client.online()).toBe(true);
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
it.each(['finish','close'] as const)('retains physical HTTP ownership until a held response reaches %s',async outcome=>{
 let entered!:()=>void,flush!:()=>void,destroy!:()=>void,settled=false;
 const answering=new Promise<void>(done=>{entered=done;});
 const relay=new PaneMcpRelay({secret:'a'.repeat(64),endpoint:()=>'',owned:()=>false,forward:vi.fn()});
 const server=createServer((req,res)=>{
  const end=res.end.bind(res);
  vi.spyOn(res,'end').mockImplementation((...args:any[])=>{flush=()=>{(end as any)(...args);};destroy=()=>res.destroy();entered();return res;});
  void relay.handle(req,res).then(()=>{settled=true;});
 });
 clean.push(()=>new Promise<void>(done=>server.close(()=>done())));
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const response=new Promise<number>(done=>{
  const req=request(`http://127.0.0.1:${(server.address()as any).port}/agent`,{method:'POST',headers:{'X-Agend-Native-Token':'b'.repeat(64)}},res=>{res.resume();res.on('end',()=>done(res.statusCode!));res.on('error',()=>done(0));});
  req.on('error',()=>done(0));req.end('{}');
 });
 await answering;
 try{expect(relay.pendingCount).toBe(1);expect(settled).toBe(false);}
 finally{if(outcome==='finish')flush();else destroy();}
 expect(await response).toBe(outcome==='finish'?403:0);
 await vi.waitFor(()=>{expect(relay.pendingCount).toBe(0);expect(settled).toBe(true);});
});

it("S-224 carries the final-write stamp through both negotiated WS hops without changing the helper body", async () => {
 const handler=vi.fn(async(_machine,_body,_current,_stamp)=>({result:{tools:[]}}));
 const f=await rig(handler,{server:1,client:1,host:1}), stamp={version:1 as const,coverage:"covered" as const,proof:"d".repeat(64)};
 const input={action:"input" as const,paneId:f.pane.paneId,launchId:f.pane.launchId,operationId:randomUUID(),sequence:1,expectedSeq:f.pane.seq,kind:"paste" as const,text:"Synthetic admitted input",requestContext:stamp};
 await f.hub.callPane(f.machineId,input);
 const body={op:"pane-mcp" as const,method:"tools/list" as const,params:{},owner:f.owner,helperId:randomUUID()};
 await paneMcpHttp(f.connection,body);expect(handler).toHaveBeenCalledExactlyOnceWith(f.machineId,body,expect.any(Function),stamp);
 expect(body).not.toHaveProperty("requestContext");
});
it.each([{server:1 as const,client:1 as const},{server:1 as const,host:1 as const},{client:1 as const,host:1 as const}])("S-224 refuses stamped input with a missing negotiation participant %j",async protocol=>{
 const handler=vi.fn(async()=>({})),f=await rig(handler,protocol);
 await expect(f.hub.callPane(f.machineId,{action:"input",paneId:f.pane.paneId,launchId:f.pane.launchId,operationId:randomUUID(),sequence:1,expectedSeq:f.pane.seq,kind:"paste",text:"must not write",requestContext:{version:1,coverage:"covered",proof:"d".repeat(64)}})).rejects.toThrow();
 expect(handler).not.toHaveBeenCalled();
 const after=await f.hub.callPane(f.machineId,{action:"snapshot",paneId:f.pane.paneId,launchId:f.pane.launchId})as RuntimePaneSnapshot;
 expect(after.commandSequence).toBe(0);
});

it("S-224 a non-negotiated Runtime cannot inject a stamped tool envelope at the coordinator boundary",async()=>{
 let invoked!:()=>void;const invocation=new Promise<void>(done=>{invoked=done;}),handler=vi.fn(async()=>{invoked();return{};});
 const f=await rig(handler),socket=(f.client as any).socket;const closed=once(socket,"close");
 const body={op:"pane-mcp",method:"tools/list",params:{},owner:f.owner,helperId:randomUUID()};
 (f.client as any).send({v:1,type:"pane.tool.request",id:randomUUID(),body,requestContext:{version:1,coverage:"covered",proof:"d".repeat(64)}});
 expect(await Promise.race([closed.then(()=>"refused"),invocation.then(()=>"dispatched")])).toBe("refused");expect(handler).not.toHaveBeenCalled();
});
it("S-224 the Runtime's own non-negotiated outgoing boundary emits no stamp or frame",async()=>{
 const f=await rig(vi.fn(async()=>({}))),send=vi.spyOn(f.client as any,"send").mockImplementation(()=>{throw Error("boundary probe");});
 const body={op:"pane-mcp",method:"tools/list",params:{},owner:f.owner,helperId:randomUUID()};
 await expect((f.client as any).forwardPaneMcp(body,()=>true,{version:1,coverage:"covered",proof:"d".repeat(64)})).rejects.toThrow(/not negotiated/);
 expect(send).not.toHaveBeenCalled();send.mockRestore();
});
