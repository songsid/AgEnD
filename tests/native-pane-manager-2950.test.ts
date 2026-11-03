/** Real metadata/profile/host/authority integration, inert native process only, no credentials or provider files. */
import {afterEach,expect,it,vi} from "vitest";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {NativePaneManager,type NativePaneManagerOptions} from "../src/native-pane-manager.js";
import {RuntimePaneHost} from "../src/runtime-pane-host.js";
import {RuntimePaneStore} from "../src/runtime-pane-store.js";
import {WindowsAgents} from "../src/windows-agents.js";
import {nativeInstanceConfig} from "../src/native-instance-registry.js";
import type {PaneMcpOwner} from "../src/runtime-pane-mcp-protocol.js";
const clean:Array<()=>unknown>=[];afterEach(async()=>{for(const f of clean.splice(0).reverse())await f();vi.restoreAllMocks();});
async function fixture(provider:"codex"|"claude-code"="claude-code"){
 const root=mkdtempSync(join(tmpdir(),"agend-native-manager-"));clean.push(()=>rmSync(root,{recursive:true,force:true}));const bridge:any={start:vi.fn(()=>{throw Error("No exec spawn");}),get:()=>null,prepareWorkspace:vi.fn()};
 const store=new WindowsAgents(root,bridge),agent=await store.create({name:"Native",cwd:"C:\\scratch",cli:provider,sandbox:"read-only"});store.bindInstance(agent.id,"native");const config={...nativeInstanceConfig(agent),native_adapter:"pane" as const},hostBootId=randomUUID(),machineId=randomUUID();let owner:PaneMcpOwner|undefined,exit=(value:any)=>{};
 const process={pid:12345,write:vi.fn(),resize:vi.fn(),pause:vi.fn(),resume:vi.fn(),kill:vi.fn(()=>exit({exitCode:0})),onData:()=>({dispose(){}}),onExit:(fn:typeof exit)=>{exit=fn;return{dispose(){}};}};
 const spawn=vi.fn(async()=>process),host=new RuntimePaneHost({store:new RuntimePaneStore(join(root,"runner")),bootId:hostBootId,systemBootId:"a".repeat(64),online:()=>true,maxAgents:()=>4,spawn,mcpConnection:(value,tools)=>{owner=value;return{endpoint:"http://127.0.0.1:1/agent",token:"a".repeat(64),owner:value,tools};},transcript:()=>({read:async cursor=>{if(!cursor)throw Error("Fixture requires a transcript cursor");return {state:"pending" as const,cursor,data:"",lines:[],complete:false,gap:false};},close:async()=>{}})});let hostAbandoned=false;clean.push(()=>hostAbandoned?Promise.resolve():host.stop());
 let published=false,version=provider==="codex"?"Codex 0.165.0":"Claude Code 2.1.316";const invoke=vi.fn(async()=>({result:"ok"})),endpoint={machineId:"local",online:()=>true,epoch:()=>"connection-1",version:()=>version,call:vi.fn((request:any)=>host.request(request)),subscribe:()=>()=>{}};
 const options:NativePaneManagerOptions={home:root,store,config:()=>config,endpoint:async()=>endpoint,admit:vi.fn(),instructions:()=>"Fixed scoped instructions",menu:()=>[{name:"reply"}],allowed:()=>true,published:()=>published,invoke};
 const manager=new NativePaneManager(options);return{root,store,agent,config,spawn,process,endpoint,options,manager,host,abandon:()=>{hostAbandoned=true;},owner:()=>owner!,publish:()=>{published=true;},version:(value:string)=>{version=value;},invoke};
}
it("prepare reserves no process; helper menu/presence can initialize but mutations require the exact published daemon",async()=>{
 const f=await fixture(),native=await f.manager.prepare("native",f.config,()=>{});expect(f.store.get(f.agent.id).activeId).toBeUndefined();expect(f.spawn).not.toHaveBeenCalled();native.bindDaemon({paneToolResponseWritten:vi.fn()} as never);await native.acquire(()=>{});
 const owner=f.owner(),helperId=randomUUID(),common={op:"pane-mcp" as const,owner,helperId};expect(await f.manager.handle("local",{...common,method:"tools/list",params:{}},()=>true)).toEqual({result:{tools:[{name:"reply"}]}});
 await f.manager.handle("local",{...common,method:"presence",params:{}},()=>true);expect(native.mcpProof()).toBe("alive");
 const call={...common,method:"tools/call" as const,callId:"a".repeat(64),params:{name:"reply",arguments:{text:"small"}}};expect(await f.manager.handle("local",call,()=>true)).toMatchObject({result:{isError:true}});expect(f.invoke).not.toHaveBeenCalled();
 f.publish();const confirmed={...call,callId:"b".repeat(64)};expect(await f.manager.handle("local",confirmed,()=>true)).toMatchObject({result:{content:[{type:"text",text:"ok"}]}});await f.manager.handle("local",confirmed,()=>true);expect(f.invoke).toHaveBeenCalledOnce();await native.release("detach");
});
it("a new coordinator reattaches the retained exact launch and helper without a second process or input",async()=>{
 const f=await fixture(),native=await f.manager.prepare("native",f.config,()=>{});await native.acquire(()=>{});const original=native.port.ownedSnapshot();await native.release("detach");
 const nextManager=new NativePaneManager(f.options),next=await nextManager.prepare("native",f.config,()=>{}),opened=await next.acquire(()=>{});expect(opened.disposition).toBe("reattached");expect(next.port.ownedSnapshot()).toEqual(original);expect(f.spawn).toHaveBeenCalledOnce();expect(f.process.write).not.toHaveBeenCalled();expect(f.store.get(f.agent.id).paneLaunchId).toBe(original?.launchId);await next.release("detach");
});
it("only positive close allows a new launch, which resumes the same pinned conversation",async()=>{
 const f=await fixture(),first=await f.manager.prepare("native",f.config,()=>{});await first.acquire(()=>{});const original=first.port.ownedSnapshot()!;await first.release("close");expect(f.store.get(f.agent.id).activeId).toBeUndefined();expect(JSON.parse(readFileSync(join(f.root,"native-panes",f.agent.id,"active.json"),"utf8")).exited.state).toBe("exited");
 const second=await f.manager.prepare("native",f.config,()=>{});await second.acquire(()=>{});expect(second.port.ownedSnapshot()).toMatchObject({sessionId:original.sessionId,state:"running"});expect(second.port.ownedSnapshot()?.launchId).not.toBe(original.launchId);expect(f.spawn).toHaveBeenCalledTimes(2);await second.release("close");
});
it("a positive exit while the coordinator is detached releases the slot and resumes the same pin on a new launch",async()=>{
 const f=await fixture(),first=await f.manager.prepare("native",f.config,()=>{});await first.acquire(()=>{});const old=first.port.ownedSnapshot()!;await first.release("detach");
 f.process.kill();expect(f.store.get(f.agent.id).activeId).toBe(old.launchId);
 const next=await new NativePaneManager(f.options).prepare("native",f.config,()=>{});expect(f.store.get(f.agent.id).activeId).toBeUndefined();
 await next.acquire(()=>{});expect(f.store.get(f.agent.id).threadId).toBe(old.sessionId);expect(next.port.ownedSnapshot()?.launchId).not.toBe(old.launchId);
 expect(f.spawn).toHaveBeenCalledTimes(2);await next.release("close");
});
it("a lost definitive admission refusal is inspected as no-launch and releases only its exact reservation",async()=>{
 const f=await fixture();
 for(let i=0;i<4;i++){
  let exit=(value:any)=>{};f.spawn.mockImplementationOnce(async()=>({...f.process,kill:vi.fn(()=>exit({exitCode:0})),onExit:(fn:typeof exit)=>{exit=fn;return{dispose(){}};}}));
  await f.host.request({action:"open",operationId:randomUUID(),launch:{paneId:randomUUID(),agentId:randomUUID(),instance:`other-${i}`,cli:"codex",cwd:"C:\\scratch",sandbox:"read-only",columns:80,rows:24}});
 }
 const native=await f.manager.prepare("native",f.config,()=>{}),call=f.endpoint.call.getMockImplementation()!;
 f.endpoint.call.mockImplementationOnce(async request=>{const result:any=await call(request);expect(result.noLaunch).toBe(true);throw Error("refusal ACK lost");});
 await expect(native.acquire(()=>{})).rejects.toThrow("ACK lost");expect(f.store.get(f.agent.id).activeId).toBeDefined();
 f.endpoint.call.mockClear();await native.release("close");expect(f.store.get(f.agent.id).activeId).toBeUndefined();expect(f.store.get(f.agent.id).threadId).toBeUndefined();
 expect(f.endpoint.call.mock.calls.some(([request])=>request.action==="open")).toBe(false);expect(f.spawn).toHaveBeenCalledTimes(4);expect(f.process.kill).not.toHaveBeenCalled();
});
it("a mismatched exit and an absent inventory row cannot release a retained profile",async()=>{
 const f=await fixture(),first=await f.manager.prepare("native",f.config,()=>{});await first.acquire(()=>{});const old=first.port.ownedSnapshot()!;await first.release("detach");
 const call=f.endpoint.call.getMockImplementation()!;
 f.endpoint.call.mockImplementationOnce(async request=>{const inventory:any=await call(request);return{...inventory,panes:[{...inventory.panes[0],launchId:randomUUID(),state:"exited"}]};});
 await expect(new NativePaneManager(f.options).prepare("native",f.config,()=>{})).rejects.toThrow("exit scope");expect(f.store.get(f.agent.id).activeId).toBe(old.launchId);
 f.endpoint.call.mockImplementationOnce(async request=>{const inventory:any=await call(request);return{...inventory,panes:[]};});
 await expect(new NativePaneManager(f.options).prepare("native",f.config,()=>{})).rejects.toThrow("exit is unconfirmed");expect(f.store.get(f.agent.id).activeId).toBe(old.launchId);expect(f.store.get(f.agent.id).paneRecovery?.kind).toBe("exit-unconfirmed");expect(f.spawn).toHaveBeenCalledOnce();
});
it("changed retained settings or an unknown active profile hold instead of fresh or exec fallback",async()=>{
 const f=await fixture(),first=await f.manager.prepare("native",f.config,()=>{});await first.acquire(()=>{});await first.release("detach");f.config.model="different-model";
 await expect(f.manager.prepare("native",f.config,()=>{})).rejects.toThrow("settings differ");expect(f.spawn).toHaveBeenCalledOnce();expect(f.process.kill).not.toHaveBeenCalled();
});
it.each(["Claude Code 2.1.315","Claude Code 2.1.316-alpha","prefix 1.2.1.316","unknown"])("unaudited version %s is refused before a launch manifest or reservation",async version=>{
 const f=await fixture();f.version(version);await expect(f.manager.prepare("native",f.config,()=>{})).rejects.toThrow("not passed");expect(f.store.get(f.agent.id).activeId).toBeUndefined();expect(f.spawn).not.toHaveBeenCalled();
});
it("a profile changed while host discovery is held cannot be admitted from its old snapshot",async()=>{
 const f=await fixture();let release!:(value:any)=>void;f.endpoint.call.mockImplementationOnce(()=>new Promise(done=>{release=done;}));const pending=f.manager.prepare("native",f.config,()=>{});await Promise.resolve();await Promise.resolve();f.store.reservePane(f.agent.id,randomUUID());release({hostBootId:randomUUID(),panes:[]});await expect(pending).rejects.toThrow("changed during host");expect(f.spawn).not.toHaveBeenCalled();
});
it("concurrent preparation for one profile is refused before any second host request",async()=>{
 const f=await fixture();let release!:(value:any)=>void;f.endpoint.call.mockImplementationOnce(()=>new Promise(done=>{release=done;}));const pending=f.manager.prepare("native",f.config,()=>{});await Promise.resolve();await Promise.resolve();await expect(f.manager.prepare("native",f.config,()=>{})).rejects.toThrow("already has an owner");release({hostBootId:randomUUID(),capabilities:{openDisposition:true,recovery:true},panes:[]});const native=await pending;await native.release("detach");
});
it("lost open ACK is inspected and closed through the retained identity, never by another open or PID",async()=>{
 const f=await fixture(),native=await f.manager.prepare("native",f.config,()=>{}),call=f.endpoint.call.getMockImplementation()!;f.endpoint.call.mockImplementationOnce(async request=>{await call(request);throw Error("open ACK lost");});await expect(native.acquire(()=>{})).rejects.toThrow("ACK lost");expect(f.spawn).toHaveBeenCalledOnce();await native.release("detach");f.endpoint.call.mockClear();
 const next=new NativePaneManager(f.options);await next.closeRetained("native",f.config,()=>{});expect(f.spawn).toHaveBeenCalledOnce();expect(f.process.kill).toHaveBeenCalledOnce();expect(f.endpoint.call.mock.calls.some(([request])=>request.action==="open")).toBe(false);expect(f.store.get(f.agent.id).activeId).toBeUndefined();
});
it("a failed open with no positive native observation cannot be reported closed or release its reservation",async()=>{
 const f=await fixture(),native=await f.manager.prepare("native",f.config,()=>{});f.endpoint.call.mockRejectedValueOnce(Error("open interrupted"));await expect(native.acquire(()=>{})).rejects.toThrow("interrupted");await native.release("detach");
 await expect(new NativePaneManager(f.options).closeRetained("native",f.config,()=>{})).rejects.toThrow();expect(f.store.get(f.agent.id).activeId).toBeDefined();expect(f.spawn).not.toHaveBeenCalled();expect(f.process.kill).not.toHaveBeenCalled();
});
it("an endpoint for another machine is refused before host discovery or profile reservation",async()=>{
 const f=await fixture();f.endpoint.machineId=randomUUID();await expect(f.manager.prepare("native",f.config,()=>{})).rejects.toThrow("machine scope differs");expect(f.endpoint.call).not.toHaveBeenCalled();expect(f.store.get(f.agent.id).activeId).toBeUndefined();
});
it("hot display metadata and updated bundled instructions retain the running exact pane; cold role/model edits still require close",async()=>{
 const f=await fixture();f.options.instructions=(_name,config)=>`name=${config.display_name}`;const first=await f.manager.prepare("native",f.config,()=>{});await first.acquire(()=>{});const id=first.port.ownedSnapshot()?.launchId;await first.release("detach");f.config.display_name="New name";f.options.instructions=()=>"updated bundled instruction text";
 const next=await f.manager.prepare("native",f.config,()=>{});await next.acquire(()=>{});expect(next.port.ownedSnapshot()?.launchId).toBe(id);expect(f.spawn).toHaveBeenCalledOnce();await next.release("detach");f.config.systemPrompt="Different cold role";await expect(f.manager.prepare("native",f.config,()=>{})).rejects.toThrow("settings differ");
});

function rebootHost(f:Awaited<ReturnType<typeof fixture>>,systemBootId?:string){
 f.abandon();const store=new RuntimePaneStore(join(f.root,"runner"));store.recoverInterrupted(systemBootId);
 const host=new RuntimePaneHost({store,bootId:randomUUID(),systemBootId,online:()=>true,maxAgents:()=>4,spawn:f.spawn,mcpConnection:(owner,tools)=>({endpoint:"http://127.0.0.1:1/agent",token:"a".repeat(64),owner,tools})});
 clean.push(()=>host.stop());f.endpoint.call.mockImplementation(request=>host.request(request));return{host,store};
}
it("old-host compatibility is checked before open; its held state is visible and no process is launched",async()=>{
 const f=await fixture(),call=f.endpoint.call.getMockImplementation()!;
 f.endpoint.call.mockImplementationOnce(async request=>{const result:any=await call(request);delete result.capabilities;return result;});
 await expect(f.manager.prepare("native",f.config,()=>{})).rejects.toThrow("older adapter");
 expect(f.store.get(f.agent.id).paneRecovery?.kind).toBe("host-upgrade");expect(f.spawn).not.toHaveBeenCalled();
 expect(f.endpoint.call.mock.calls.map(([request])=>request.action)).toEqual(["list"]);
});
it("a real old ledger is held before rebinding to a new host, then exact admin recovery keeps the conversation and old tool receipts",async()=>{
 const f=await fixture(),native=await f.manager.prepare("native",f.config,()=>{});native.bindDaemon({paneToolResponseWritten:vi.fn()} as never);await native.acquire(()=>{});f.publish();
 const common={op:"pane-mcp" as const,owner:f.owner(),helperId:randomUUID()};
 await f.manager.handle("local",{...common,method:"tools/call",callId:"d".repeat(64),params:{name:"reply",arguments:{text:"inert"}}},()=>true);
 const old=native.port.ownedSnapshot()!,ledger=join(f.root,"native-panes",f.agent.id,`${old.launchId}.mcp.json`),bytes=readFileSync(ledger,"utf8");await native.release("detach");
 const {store}=rebootHost(f),manager=new NativePaneManager(f.options);
 await expect(manager.prepare("native",f.config,()=>{})).rejects.toThrow("exit is unconfirmed");
 expect(f.store.get(f.agent.id).paneRecovery).toEqual({kind:"exit-unconfirmed",launchId:old.launchId,hostBootId:old.hostBootId});
 await expect(manager.recover("native",f.config,randomUUID(),true,()=>{})).rejects.toThrow("changed");
 await expect(manager.recover("native",f.config,old.launchId,false,()=>{})).rejects.toThrow("changed");
 await manager.recover("native",f.config,old.launchId,true,()=>{});
 expect(f.store.get(f.agent.id).activeId).toBeUndefined();expect(store.get(old.paneId)?.snapshot.exitProof).toBe("admin-confirmed");expect(readFileSync(ledger,"utf8")).toBe(bytes);
 const next=await manager.prepare("native",f.config,()=>{});await next.acquire(()=>{});
 expect(next.port.ownedSnapshot()).toMatchObject({sessionId:old.sessionId,state:"running"});expect(next.port.ownedSnapshot()?.launchId).not.toBe(old.launchId);expect(f.invoke).toHaveBeenCalledOnce();expect(f.process.write).not.toHaveBeenCalled();await next.release("close");
});
it("a proven Windows reboot automatically releases the old reservation and resumes its original pin",async()=>{
 const f=await fixture(),native=await f.manager.prepare("native",f.config,()=>{});await native.acquire(()=>{});const old=native.port.ownedSnapshot()!;await native.release("detach");
 rebootHost(f,"b".repeat(64));const manager=new NativePaneManager(f.options),next=await manager.prepare("native",f.config,()=>{});await next.acquire(()=>{});
 expect(next.port.ownedSnapshot()).toMatchObject({sessionId:old.sessionId,state:"running"});expect(next.port.ownedSnapshot()?.launchId).not.toBe(old.launchId);expect(f.store.get(f.agent.id).paneRecovery).toBeUndefined();expect(f.process.write).not.toHaveBeenCalled();await next.release("close");
});
it("a current live host cannot be admin-unlocked and another profile's work is untouched",async()=>{
 const f=await fixture(),native=await f.manager.prepare("native",f.config,()=>{});await native.acquire(()=>{});const old=native.port.ownedSnapshot()!;
 await expect(f.manager.recover("native",f.config,old.launchId,true,()=>{})).rejects.toThrow();
 expect(f.store.get(f.agent.id).activeId).toBe(old.launchId);expect(f.process.kill).not.toHaveBeenCalled();await native.release("close");
});

it("a reboot cannot silently replace a previously launched Codex conversation whose pin was never proven",async()=>{
 const f=await fixture("codex"),native=await f.manager.prepare("native",f.config,()=>{}),manifest=JSON.parse(readFileSync(join(f.root,"native-panes",f.agent.id,"active.json"),"utf8"));
 f.store.reservePane(f.agent.id,manifest.launch.launchId);
 await f.endpoint.call({action:"open",operationId:randomUUID(),launch:manifest.launch});await native.release("detach");
 rebootHost(f,"b".repeat(64));
 await expect(new NativePaneManager(f.options).prepare("native",f.config,()=>{})).rejects.toThrow("exit is unconfirmed");
 expect(f.spawn).toHaveBeenCalledOnce();expect(f.store.get(f.agent.id).activeId).toBe(manifest.launch.launchId);expect(f.store.get(f.agent.id).threadId).toBeUndefined();expect(f.process.write).not.toHaveBeenCalled();
});

it("a positively observed unknown host pane cannot keep its old daemon tool authority",async()=>{
 const f=await fixture(),native=await f.manager.prepare("native",f.config,()=>{});native.bindDaemon({paneToolResponseWritten:vi.fn()} as never);await native.acquire(()=>{});f.publish();
 const call=f.endpoint.call.getMockImplementation()!;f.endpoint.call.mockImplementationOnce(async request=>{const result:any=await call(request);return{...result,state:"unknown"};});
 expect(await native.port.getPaneStatus()).toBeNull();expect(native.current()).toBe(false);
 await expect(f.manager.handle("local",{op:"pane-mcp",owner:f.owner(),helperId:randomUUID(),method:"tools/call",callId:"e".repeat(64),params:{name:"reply",arguments:{text:"never sent"}}},()=>true)).rejects.toThrow("no longer current");
 expect(f.invoke).not.toHaveBeenCalled();await native.release("detach");
});
