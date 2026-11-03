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
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),"agend-native-manager-"));clean.push(()=>rmSync(root,{recursive:true,force:true}));const bridge:any={start:vi.fn(()=>{throw Error("No exec spawn");}),get:()=>null,prepareWorkspace:vi.fn()};
 const store=new WindowsAgents(root,bridge),agent=await store.create({name:"Native",cwd:"C:\\scratch",cli:"claude-code",sandbox:"read-only"});store.bindInstance(agent.id,"native");const config={...nativeInstanceConfig(agent),native_adapter:"pane" as const},hostBootId=randomUUID(),machineId=randomUUID();let owner:PaneMcpOwner|undefined,exit=(value:any)=>{};
 const process={pid:12345,write:vi.fn(),resize:vi.fn(),pause:vi.fn(),resume:vi.fn(),kill:vi.fn(()=>exit({exitCode:0})),onData:()=>({dispose(){}}),onExit:(fn:typeof exit)=>{exit=fn;return{dispose(){}};}};
 const spawn=vi.fn(async()=>process),host=new RuntimePaneHost({store:new RuntimePaneStore(join(root,"runner")),bootId:hostBootId,online:()=>true,maxAgents:()=>4,spawn,mcpConnection:(value,tools)=>{owner=value;return{endpoint:"http://127.0.0.1:1/agent",token:"a".repeat(64),owner:value,tools};},transcript:()=>({read:async cursor=>{if(!cursor)throw Error("Fixture requires a transcript cursor");return {state:"pending" as const,cursor,data:"",lines:[],complete:false,gap:false};},close:async()=>{}})});clean.push(()=>host.stop());
 let published=false,version="Claude Code 2.1.316";const invoke=vi.fn(async()=>({result:"ok"})),endpoint={machineId:"local",online:()=>true,epoch:()=>"connection-1",version:()=>version,call:vi.fn((request:any)=>host.request(request)),subscribe:()=>()=>{}};
 const options:NativePaneManagerOptions={home:root,store,config:()=>config,endpoint:async()=>endpoint,admit:vi.fn(),instructions:()=>"Fixed scoped instructions",menu:()=>[{name:"reply"}],allowed:()=>true,published:()=>published,invoke};
 const manager=new NativePaneManager(options);return{root,store,agent,config,spawn,process,endpoint,options,manager,host,owner:()=>owner!,publish:()=>{published=true;},version:(value:string)=>{version=value;},invoke};
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
 const f=await fixture();let release!:(value:any)=>void;f.endpoint.call.mockImplementationOnce(()=>new Promise(done=>{release=done;}));const pending=f.manager.prepare("native",f.config,()=>{});await Promise.resolve();await Promise.resolve();await expect(f.manager.prepare("native",f.config,()=>{})).rejects.toThrow("already has an owner");release({hostBootId:randomUUID(),panes:[]});const native=await pending;await native.release("detach");
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
