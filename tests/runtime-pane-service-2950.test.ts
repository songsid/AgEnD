/** Real private loopback channel, inert processes. Connection replacement cannot replay input or replace a CLI. */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { startPaneService } from "../src/runtime-pane-service.js";
import { RuntimePaneLink } from "../src/runtime-pane-link.js";
import { RuntimePaneScreen } from "../src/runtime-pane-screen.js";
import { RuntimePaneHost } from "../src/runtime-pane-host.js";
import { readPaneHostDescriptor } from "../src/runtime-pane-private.js";
import type { RuntimePaneSnapshot } from "../src/runtime-pane-protocol.js";
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
function processFixture() {
 let output: (text:string)=>void=()=>{}, exit:(value:{exitCode:number})=>void=()=>{};
 return { pid: 32123, write:vi.fn(), resize:vi.fn(),pause:vi.fn(),resume:vi.fn(),kill:vi.fn(()=>exit({exitCode:0})),
 onData:(fn:typeof output)=>{output=fn;return{dispose(){}};},onExit:(fn:typeof exit)=>{exit=fn;return{dispose(){}};},emit:(text:string)=>output(text)};
}
async function setup() {
 const directory=mkdtempSync(join(tmpdir(),'agend-pane-service-'));cleanup.push(()=>rmSync(directory,{recursive:true,force:true}));
 const processes:ReturnType<typeof processFixture>[]=[];
 const service=await startPaneService({directory,scope:'a'.repeat(64),createHost:opts=>new RuntimePaneHost({...opts,spawn:async()=>{const p=processFixture();processes.push(p);return p;}})});
 cleanup.push(()=>service.close());
 const connect=async()=>{const client=await RuntimePaneLink.attach(service.descriptor,{online:()=>true,maxAgents:()=>4});cleanup.push(()=>client.stop());return client;};
 const launch=()=>({paneId:randomUUID(),agentId:randomUUID(),instance:'private-agent',cli:'codex' as const,cwd:'C:\\scratch',sandbox:'read-only' as const,columns:80,rows:24});
 return {directory,processes,service,connect,launch};
}
it('reattaches after client closure with the same process, screen and applied Enter',async()=>{
 const f=await setup(),first=await f.connect(),launch=f.launch(),operationId=randomUUID();
 const pane=await first.request({action:'open',launch,operationId}) as RuntimePaneSnapshot;
 f.processes[0].emit('original screen 中文\r\n');
 const observed=await first.request({action:'snapshot',paneId:pane.paneId,launchId:pane.launchId}) as RuntimePaneSnapshot;
 const key={action:'key',paneId:pane.paneId,launchId:pane.launchId,operationId:randomUUID(),sequence:1,expectedSeq:observed.seq,key:'Enter'};
 await first.request(key);await first.stop();
 expect(f.processes[0].kill).not.toHaveBeenCalled();
 const next=await f.connect();
 expect(await next.request({action:'open',launch,operationId})).toMatchObject({launchId:pane.launchId,commandSequence:1});
 expect(await next.request({action:'capture',paneId:pane.paneId,launchId:pane.launchId})).toMatchObject({text:expect.stringContaining('original screen 中文')});
 await next.request(key);expect(f.processes).toHaveLength(1);expect(f.processes[0].write).toHaveBeenCalledExactlyOnceWith('\r');
});
it('replacing a connected client closes the old lease and leaves its pane alive',async()=>{
 const f=await setup(),old=await f.connect();const pane=await old.request({action:'open',launch:f.launch(),operationId:randomUUID()}) as RuntimePaneSnapshot;
 const current=await f.connect();
 await vi.waitFor(async()=>expect((await current.request({action:'list'}) as any).panes).toHaveLength(1));
 await expect(old.request({action:'key',paneId:pane.paneId,launchId:pane.launchId,operationId:randomUUID(),sequence:1,expectedSeq:pane.seq,key:'Enter'})).rejects.toThrow();
 expect(f.processes[0].write).not.toHaveBeenCalled();expect(f.processes[0].kill).not.toHaveBeenCalled();
});
it('rejects an unauthenticated local connection and enrollment/boot mismatch',async()=>{
 const f=await setup();
 expect(()=>readPaneHostDescriptor(f.directory,'b'.repeat(64))).toThrow('scope');
 await expect(RuntimePaneLink.attach({...f.service.descriptor,hostBootId:randomUUID()},{online:()=>true,maxAgents:()=>4})).rejects.toThrow();
 const socket=new WebSocket(`ws://127.0.0.1:${f.service.descriptor.port}/pane/v1`,{headers:{Authorization:'Bearer '+'0'.repeat(64)}});socket.on('error',()=>{});
 await new Promise<void>(done=>socket.once('close',()=>done()));expect(f.processes).toHaveLength(0);
});
it('does not interpret unreadable or symlink discovery state as absence',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'agend-pane-private-'));cleanup.push(()=>rmSync(directory,{recursive:true,force:true}));
 const path=join(directory,'host.json');symlinkSync(path,path);
 expect(()=>readPaneHostDescriptor(directory,'a'.repeat(64))).toThrow();
 rmSync(path);writeFileSync(path,'', {mode:0o600});expect(()=>readPaneHostDescriptor(directory,'a'.repeat(64))).toThrow();
});
it('queued input rechecks the client fence after pending parser work',async()=>{
 const f=await setup();let host:RuntimePaneHost|undefined;
 // A direct host seam exposes the exact asynchronous capture/parser interleaving.
 const {RuntimePaneStore}=await import('../src/runtime-pane-store.js');const p=processFixture();
 host=new RuntimePaneHost({store:new RuntimePaneStore(join(f.directory,'fenced')),bootId:randomUUID(),online:()=>true,maxAgents:()=>4,spawn:async()=>p});cleanup.push(()=>host!.stop());
 const pane=await host.request({action:'open',launch:f.launch(),operationId:randomUUID()}) as RuntimePaneSnapshot;
 let release!:()=>void;const parser=new Promise<void>(done=>{release=done;});
 vi.spyOn(RuntimePaneScreen.prototype,'write').mockImplementationOnce(()=>parser);p.emit('held parser output');
 let current=true;let checks=0;const pending=host.request({action:'key',paneId:pane.paneId,launchId:pane.launchId,key:'Enter',expectedSeq:pane.seq,sequence:1,operationId:randomUUID()},()=>{checks++;return current;});
 await vi.waitFor(()=>expect(checks).toBeGreaterThanOrEqual(2));current=false;release();await expect(pending).rejects.toThrow();expect(p.write).not.toHaveBeenCalled();
});
it('an upstream reconnect epoch cancels an old queued write on the same local host connection',async()=>{
 const f=await setup();let epoch=randomUUID();
 const client=await RuntimePaneLink.attach(f.service.descriptor,{online:()=>true,maxAgents:()=>4,epoch:()=>epoch});cleanup.push(()=>client.stop());
 const pane=await client.request({action:'open',launch:f.launch(),operationId:randomUUID()})as RuntimePaneSnapshot;
 let release!:()=>void;const parser=new Promise<void>(done=>{release=done;});vi.spyOn(RuntimePaneScreen.prototype,'write').mockImplementationOnce(()=>parser);
 f.processes[0].emit('held output');const called=vi.spyOn(RuntimePaneHost.prototype,'request');
 const pending=client.request({action:'key',paneId:pane.paneId,launchId:pane.launchId,key:'Enter',expectedSeq:pane.seq,sequence:1,operationId:randomUUID()});
 await vi.waitFor(()=>expect(called).toHaveBeenCalled());epoch=randomUUID();client.connectionChanged();
 // The list reply proves the newer lease frame has crossed the ordered socket before we release the parser.
 await client.request({action:'list'});release();await expect(pending).rejects.toThrow('refused');expect(f.processes[0].write).not.toHaveBeenCalled();
});

it('explicit retirement after coordinator loss closes only this authenticated host roster and permits no input',async()=>{
 const f=await setup();let online=true;const client=await RuntimePaneLink.attach(f.service.descriptor,{online:()=>online,maxAgents:()=>4});cleanup.push(()=>client.stop());
 for(let i=0;i<2;i++)await client.request({action:'open',launch:f.launch(),operationId:randomUUID()});online=false;await client.retireOwned();expect(f.processes).toHaveLength(2);for(const process of f.processes){expect(process.kill).toHaveBeenCalledOnce();expect(process.write).not.toHaveBeenCalled();}
 await expect(client.request({action:'open',launch:f.launch(),operationId:randomUUID()})).rejects.toThrow('retirement');
 const inventory:any=await client.request({action:'list'});expect(inventory.panes.every((pane:any)=>pane.state==='exited')).toBe(true);
});
it('retirement refuses a changed host before any close or input request',async()=>{
 const f=await setup(),client=await f.connect();await client.request({action:'open',launch:f.launch(),operationId:randomUUID()});const original=client.request.bind(client);
 vi.spyOn(client,'request').mockImplementation(async(raw:any)=>raw.action==='list'?{hostBootId:randomUUID(),panes:[]}:original(raw));await expect(client.retireOwned()).rejects.toThrow('inventory');expect(f.processes[0].kill).not.toHaveBeenCalled();expect(f.processes[0].write).not.toHaveBeenCalled();
});
it('retirement does not promote a mismatched or nonterminal close response into success',async()=>{
 const f=await setup(),client=await f.connect(),pane:any=await client.request({action:'open',launch:f.launch(),operationId:randomUUID()});const original=client.request.bind(client);
 vi.spyOn(client,'request').mockImplementation((raw:any)=>raw.action==='close'?Promise.resolve({...pane,state:'running'}):original(raw));await expect(client.retireOwned()).rejects.toThrow('exit is unconfirmed');expect(f.processes[0].kill).not.toHaveBeenCalled();
});
it('a stalled retirement is bounded and sends no replacement command after its deadline',async()=>{
 const f=await setup(),client=await f.connect();const call=vi.spyOn(client,'request').mockImplementation(()=>new Promise(()=>{}));vi.useFakeTimers();try{let outcome='pending';const pending=client.retireOwned().then(()=>{outcome='ok';},error=>{outcome=error.message;});await vi.advanceTimersByTimeAsync(125001);expect(outcome).toContain('deadline');await pending;expect(call).toHaveBeenCalledOnce();}finally{vi.useRealTimers();}
});

it('retirement keeps positive exited history from an older host without trying to retire it again',async()=>{
 const f=await setup(),client=await f.connect(),pane:any=await client.request({action:'open',launch:f.launch(),operationId:randomUUID()}),original=client.request.bind(client);
 vi.spyOn(client,'request').mockImplementation(async(raw:any)=>{const result:any=await original(raw);return raw.action==='list'?{...result,panes:[...result.panes,{...pane,paneId:randomUUID(),launchId:randomUUID(),hostBootId:randomUUID(),state:'exited',exitCode:0}]}:result;});await client.retireOwned();expect(f.processes[0].kill).toHaveBeenCalledOnce();
});
