/** Actual FleetManager + lifecycle + daemon + manager + runtime host. Only the CLI/transport boundary is inert. */
import {afterEach,expect,it,vi} from "vitest";
import {mkdtempSync,rmSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {FleetManager} from "../src/fleet-manager.js";
import {windowsAgentsFor} from "../src/windows-agents.js";
import {nativeInstanceConfig} from "../src/native-instance-registry.js";
import {setConfiguredRuntimeSwitches} from "../src/runtime-switches.js";
import {RuntimePaneHost} from "../src/runtime-pane-host.js";
import {RuntimePaneStore} from "../src/runtime-pane-store.js";
import type {PaneMcpOwner} from "../src/runtime-pane-mcp-protocol.js";
const clean:Array<()=>unknown>=[];afterEach(async()=>{for(const f of clean.splice(0).reverse())await f();setConfiguredRuntimeSwitches({});vi.restoreAllMocks();});
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),"agend-native-fleet-integrated-"));clean.push(()=>rmSync(root,{recursive:true,force:true}));setConfiguredRuntimeSwitches({remote_runtime:true});
 const fleet:any=new FleetManager(root),machineId=randomUUID(),exec=vi.fn(()=>{throw Error("No per-turn exec");});
 const store=windowsAgentsFor(fleet,{start:exec,get:()=>null,prepareWorkspace:async()=>"C:\\scratch"} as never),agent=await store.create({name:"Native",cwd:"C:\\scratch",cli:"claude-code",sandbox:"read-only",machineId});store.bindInstance(agent.id,"native");
 const config={...nativeInstanceConfig(agent),native_adapter:"pane",log_level:"silent"};fleet.fleetConfig={defaults:{},runtimes:{remote_runtime:true},instances:{native:config}};
 let owner:PaneMcpOwner|undefined,exit=(value:any)=>{};const cli={pid:12345,write:vi.fn(),resize:vi.fn(),pause:vi.fn(),resume:vi.fn(),kill:vi.fn(()=>exit({exitCode:0})),onData:()=>({dispose(){}}),onExit:(fn:typeof exit)=>{exit=fn;return{dispose(){}};}};
 const spawn=vi.fn(async()=>cli),host=new RuntimePaneHost({store:new RuntimePaneStore(join(root,"runner")),bootId:randomUUID(),online:()=>true,maxAgents:()=>4,spawn,mcpConnection:(value,tools)=>{owner=value;return{endpoint:"http://127.0.0.1:1/agent",token:"a".repeat(64),owner:value,tools};},transcript:()=>({read:async cursor=>({state:"pending",cursor,data:"",lines:[],complete:false,gap:false}),close:async()=>{}})});clean.push(()=>host.stop());
 const hub={machine:()=>({status:"online",platform:"win32",inventory:{clis:[{id:"claude-code",runnable:true,version:"Claude Code 2.1.316"}]}}),callPane:vi.fn((_id:string,request:any)=>host.request(request)),subscribe:()=>()=>{},paneTransportEpoch:()=>"private-epoch",task:()=>null,tasks:()=>[],hasActiveTask:()=>false};fleet.runtimeHub=hub;
 if(fleet.memoryPressure)vi.spyOn(fleet.memoryPressure,"start").mockImplementation(()=>{});
 const skills=vi.spyOn(fleet,"syncRoleSkills").mockImplementation(()=>{throw Error("No Linux skills in Windows cwd");}),models=vi.spyOn(fleet,"resolveInstanceModel").mockImplementation(()=>{throw Error("No Linux model state for native start");});
 clean.push(async()=>{for(const daemon of fleet.daemons.values())await daemon.abortStartup();for(const channel of fleet.instanceIpcClients.values())await channel.close();fleet.memoryPressure?.stop();});return{root,fleet,config,store,agent,spawn,cli,hub,exec,skills,models,owner:()=>owner!};
}
it("opt-in starts a resident daemon, receives ordinary delivery, publishes progress and closes only its owned pane",async()=>{
 const f=await fixture();await f.fleet.startInstance("native",f.config,true);const daemon=f.fleet.daemons.get("native");expect(daemon?.usesNativePane()).toBe(true);expect(f.spawn).toHaveBeenCalledOnce();expect(f.exec).not.toHaveBeenCalled();expect(f.skills).not.toHaveBeenCalled();expect(f.models).not.toHaveBeenCalled();expect(existsSync(join(f.fleet.getInstanceDir("native"),"channel.sock"))).toBe(false);expect(f.fleet.getInstanceStatus("native")).toBe("running");
 const push=vi.spyOn(daemon,"pushChannelMessage").mockImplementation(()=>{});await expect(f.fleet.deliverToInstance("native",{type:"fleet_inbound",content:"normal message",meta:{message_id:"unique"}})).resolves.toBe(true);await Promise.resolve();expect(push).toHaveBeenCalledWith("normal message",expect.objectContaining({message_id:"unique"}),undefined,expect.any(Number));
 const progress=vi.spyOn(f.fleet,"cacheInstanceProgress").mockImplementation(()=>{});daemon.broadcastFleetMessage({type:"instance_progress",progress:"native work"});expect(progress).toHaveBeenCalledWith("native","native work");
 await f.fleet.stopInstance("native");expect(f.cli.kill).toHaveBeenCalledOnce();expect(f.store.get(f.agent.id).activeId).toBeUndefined();expect(f.fleet.daemons.has("native")).toBe(false);expect(f.exec).not.toHaveBeenCalled();
});
it("the retained helper uses ordinary reply routing and waits for its own stdout ACK before marking response delivery",async()=>{
 const f=await fixture();await f.fleet.startInstance("native",f.config,true);const daemon=f.fleet.daemons.get("native"),operation=vi.fn();daemon.on("mcp_tool_response_written",operation);
 vi.spyOn(f.fleet,"handleOutboundFromInstance").mockImplementation(async(name:any,message:any)=>{f.fleet.instanceIpcClients.get(name).send({type:"fleet_outbound_response",fleetRequestId:message.fleetRequestId,result:{messageId:"posted"}});});
 const common={op:"pane-mcp" as const,owner:f.owner(),helperId:randomUUID()},response=await f.fleet.paneManager.handle(f.owner().agentId?f.config.machine_id:"",{...common,method:"tools/call",callId:"c".repeat(64),params:{name:"reply",arguments:{text:"minimal"}}},()=>true);
 expect(response.result.isError).not.toBe(true);expect(f.fleet.handleOutboundFromInstance).toHaveBeenCalledOnce();expect(operation).not.toHaveBeenCalled();await f.fleet.paneManager.handle(f.config.machine_id,{...common,method:"response-written",callId:"c".repeat(64),responseId:response.responseId},()=>true);expect(operation).toHaveBeenCalledOnce();
});
it("a native pause refuses a working pane and uses positive close plus pause metadata only after idle proof",async()=>{
 const f=await fixture();await f.fleet.startInstance("native",f.config,true);const daemon=f.fleet.daemons.get("native");await f.fleet.lifecycle.pause("native");expect(f.cli.kill).not.toHaveBeenCalled();expect(f.store.get(f.agent.id).paused).not.toBe(true);
 vi.spyOn(daemon,"nativePauseReady").mockResolvedValue(true);vi.spyOn(daemon,"nativePauseStillReady").mockReturnValue(true);await f.fleet.lifecycle.pause("native");expect(f.cli.kill).toHaveBeenCalledOnce();expect(f.store.get(f.agent.id).paused).toBe(true);expect(f.fleet.lifecycle.isPaused("native")).toBe(true);
});
it.each(["auth_error","quota"])("native %s never probes or changes the coordinator's login/quota",async type=>{
 const f=await fixture();await f.fleet.startInstance("native",f.config,true);const daemon=f.fleet.daemons.get("native"),auth=vi.spyOn(f.fleet.lifecycle,"verifyAuthError").mockImplementation(()=>{throw Error("No Linux auth");}),quota=vi.spyOn(f.fleet.lifecycle,"verifyClaudeQuota").mockImplementation(()=>{throw Error("No Linux quota");}),notice=vi.spyOn(f.fleet.lifecycle,"notifyIncident").mockReturnValue(true),pause=vi.spyOn(daemon,"requestPauseWhenIdle").mockImplementation(()=>{});
 daemon.emit("pty_error",{name:"native",type,action:"pause",message:"native account needs attention",fleetWide:true,verifyQuota:true});await vi.waitFor(()=>expect(notice).toHaveBeenCalledWith("native",type,"native account needs attention"));expect(auth).not.toHaveBeenCalled();expect(quota).not.toHaveBeenCalled();expect(pause).toHaveBeenCalledWith(type==="auth_error"?{reconfirmAuth:true,reason:"auth"}:{reason:"error"});
});
it("a new queued paste between the idle proof and lifecycle continuation prevents native pause",async()=>{
 const f=await fixture();await f.fleet.startInstance("native",f.config,true);const daemon=f.fleet.daemons.get("native");daemon.instanceState="idle";vi.spyOn(daemon,"paneAuthoritativelyIdle").mockReturnValue(true);const observe=daemon.nativePauseReady.bind(daemon);vi.spyOn(daemon,"nativePauseReady").mockImplementation(async(admission:any)=>{const ready=await observe(admission);queueMicrotask(()=>{daemon.pasteQueueDepth=1;});return ready;});
 await f.fleet.lifecycle.pause("native");expect(f.cli.kill).not.toHaveBeenCalled();expect(f.fleet.daemons.get("native")).toBe(daemon);expect(f.store.get(f.agent.id).paused).not.toBe(true);
});
it('native models use only that machine inventory, including MCP calls with no explicit instance',async()=>{
 const f=await fixture();f.hub.machine=()=>({status:'online',platform:'win32',inventory:{clis:[{id:'claude-code',runnable:true,version:'Claude Code 2.1.316',models:[{id:'windows-only',name:'Windows only'}]}],probedAt:123}});
 const global=vi.spyOn(f.fleet,'globalModelCatalog').mockImplementation(()=>{throw Error('No host account');}),probe=vi.spyOn(f.fleet,'runBackendProbeWorker').mockImplementation(()=>{throw Error('No host probe');});await f.fleet.startInstance('native',f.config,true);
 const common={op:'pane-mcp' as const,owner:f.owner(),helperId:randomUUID()};const answer:any=await f.fleet.paneManager.handle(f.config.machine_id,{...common,method:'tools/call',callId:'d'.repeat(64),params:{name:'list_models',arguments:{}}},()=>true);
 expect(answer.result.isError).not.toBe(true);expect(JSON.stringify(answer.result)).toContain('windows-only');expect(JSON.stringify(answer.result)).toContain('Windows only');expect(global).not.toHaveBeenCalled();expect(probe).not.toHaveBeenCalled();expect(f.models).not.toHaveBeenCalled();
 f.hub.machine=()=>({status:'online',platform:'win32',inventory:{clis:[]}});expect(await f.fleet.listModelCatalog({instanceName:'native'})).toMatchObject({scope:'instance',models:[],source:'fallback'});expect(global).not.toHaveBeenCalled();expect(probe).not.toHaveBeenCalled();
 const menu:any=await f.fleet.paneManager.handle(f.config.machine_id,{...common,method:'tools/list',params:{}},()=>true);for(const tool of ['checkout_repo','release_repo','get_usage'])expect(JSON.stringify(menu)).not.toContain('"name":"'+tool+'"');
});
it('native model calls cannot request a coordinator account through an explicit local instance',async()=>{
 const f=await fixture();f.fleet.fleetConfig.instances.local={working_directory:f.root,backend:'codex'};await f.fleet.startInstance('native',f.config,true);const outbound=vi.spyOn(f.fleet,'handleOutboundFromInstance');
 const answer:any=await f.fleet.paneManager.handle(f.config.machine_id,{op:'pane-mcp',owner:f.owner(),helperId:randomUUID(),method:'tools/call',callId:'e'.repeat(64),params:{name:'list_models',arguments:{instance_name:'local'}}},()=>true);
 expect(answer.result.isError).toBe(true);expect(outbound).not.toHaveBeenCalled();
});
