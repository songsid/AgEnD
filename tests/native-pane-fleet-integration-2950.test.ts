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
async function fixture(delayFrame=false){
 const root=mkdtempSync(join(tmpdir(),"agend-native-fleet-integrated-"));clean.push(()=>rmSync(root,{recursive:true,force:true}));setConfiguredRuntimeSwitches({remote_runtime:true});
 const fleet:any=new FleetManager(root),machineId=randomUUID(),exec=vi.fn(()=>{throw Error("No per-turn exec");});
 const store=windowsAgentsFor(fleet,{start:exec,get:()=>null,prepareWorkspace:async()=>"C:\\scratch"} as never),agent=await store.create({name:"Native",cwd:"C:\\scratch",cli:"claude-code",sandbox:"read-only",machineId});store.bindInstance(agent.id,"native");
 const config={...nativeInstanceConfig(agent),native_adapter:"pane",log_level:"silent"};fleet.fleetConfig={defaults:{},runtimes:{remote_runtime:true},instances:{native:config}};
 let owner:PaneMcpOwner|undefined,exit=(value:any)=>{},paint=()=>{};const cli={pid:12345,write:vi.fn(),resize:vi.fn(),pause:vi.fn(),resume:vi.fn(),kill:vi.fn(()=>exit({exitCode:0})),onData:(fn:(data:string)=>void)=>{paint=()=>fn("─".repeat(40)+"\r\n❯ \r\n"+"─".repeat(40)+"\r\n");if(!delayFrame)queueMicrotask(paint);return{dispose(){}};},onExit:(fn:typeof exit)=>{exit=fn;return{dispose(){}};}};
 const spawn=vi.fn(async()=>cli),host=new RuntimePaneHost({store:new RuntimePaneStore(join(root,"runner")),bootId:randomUUID(),online:()=>true,maxAgents:()=>4,spawn,mcpConnection:(value,tools)=>{owner=value;return{endpoint:"http://127.0.0.1:1/agent",token:"a".repeat(64),owner:value,tools};},transcript:()=>({read:async cursor=>{if(!cursor)throw Error("Fixture requires a transcript cursor");return {state:"pending" as const,cursor,data:"",lines:[],complete:false,gap:false};},close:async()=>{}})});let hostAbandoned=false;clean.push(()=>hostAbandoned?Promise.resolve():host.stop());
 const hub={machine:()=>({status:"online",platform:"win32",inventory:{clis:[{id:"claude-code",runnable:true,version:"Claude Code 2.1.316"}]}}),callPane:vi.fn((_id:string,request:any)=>host.request(request)),subscribe:()=>()=>{},paneTransportEpoch:()=>"private-epoch",task:()=>null,tasks:()=>[],hasActiveTask:()=>false};fleet.runtimeHub=hub;
 if(fleet.memoryPressure)vi.spyOn(fleet.memoryPressure,"start").mockImplementation(()=>{});
 const skills=vi.spyOn(fleet,"syncRoleSkills").mockImplementation(()=>{throw Error("No Linux skills in Windows cwd");}),models=vi.spyOn(fleet,"resolveInstanceModel").mockImplementation(()=>{throw Error("No Linux model state for native start");});
 clean.push(async()=>{for(const daemon of fleet.daemons.values())await daemon.abortStartup();for(const channel of fleet.instanceIpcClients.values())await channel.close();fleet.memoryPressure?.stop();});return{root,fleet,config,store,agent,spawn,cli,hub,exec,skills,models,abandon:()=>{hostAbandoned=true;},owner:()=>owner!,paint:()=>paint()};
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
 const f=await fixture();await f.fleet.startInstance("native",f.config,true);const daemon=f.fleet.daemons.get("native");daemon.instanceState="working";await f.fleet.lifecycle.pause("native");expect(f.cli.kill).not.toHaveBeenCalled();expect(f.store.get(f.agent.id).paused).not.toBe(true);
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
it('the ordinary Fleet delivery facade reaches a published native daemon and arms its reply guard',async()=>{
 const f=await fixture();await f.fleet.startInstance('native',f.config,true);const daemon=f.fleet.daemons.get('native');
 const deliver=vi.spyOn(daemon,'deliverMessage').mockResolvedValue(true),push=vi.spyOn(daemon,'pushChannelMessage');
 expect(await f.fleet.deliverToInstance('native',{type:'fleet_inbound',content:'minimal',meta:{source:'user',user:'person',chat_id:'private',thread_id:'native',message_id:randomUUID()}})).toBe(true);
 await vi.waitFor(()=>expect(push).toHaveBeenCalledOnce());await vi.waitFor(()=>expect(deliver).toHaveBeenCalledOnce());
 expect(daemon.turnReplyGuard.snapshot()).not.toBeNull();expect(f.exec).not.toHaveBeenCalled();
});
it('native model/effort presentation and menus never read coordinator configuration or inherit its account defaults',async()=>{
 const f=await fixture();f.models.mockRestore();f.fleet.fleetConfig.defaults={model:'coordinator-model',effort:'max'};
 const local=vi.spyOn(f.fleet,'readCliEnv').mockImplementation(()=>{throw Error('No coordinator CLI account');});
 const probe=vi.spyOn(f.fleet,'probeBackendBounded').mockImplementation(()=>{throw Error('No coordinator provider probe');});
 expect(f.fleet.resolveInstanceModel('native')).toMatchObject({model:'default',source:'unresolved'});
 expect(f.fleet.effortStrategyFor('native')).toBe('unsupported');expect(f.fleet.effortLevelsFor('native')).toEqual([]);expect(f.fleet.resolveInstanceEffort('native')).toEqual({effort:null,source:'unset'});
 const save=vi.spyOn(f.fleet,'saveFleetConfig').mockImplementation(()=>{throw Error('No ignored setting write');}),restart=vi.spyOn(f.fleet,'restartSingleInstance').mockImplementation(()=>{throw Error('No ignored setting restart');});
 await f.fleet.applyEffort('native','high');expect(f.config).not.toHaveProperty('effort');expect(save).not.toHaveBeenCalled();expect(restart).not.toHaveBeenCalled();
 f.hub.machine=()=>({status:'online',platform:'win32',inventory:{clis:[{id:'claude-code',runnable:true,version:'Claude Code 2.1.316',models:[{id:'native-only'}]}],probedAt:123}});
 expect(await f.fleet.getModelOptionsWithSource('native',{refresh:true})).toMatchObject({source:'cache',models:[{id:'native-only'}]});expect(local).not.toHaveBeenCalled();expect(probe).not.toHaveBeenCalled();
});
it('hot native identity settings leave the same pane and conversation running',async()=>{
 const f=await fixture();await f.fleet.startInstance('native',f.config,true);f.models.mockRestore();const daemon=f.fleet.daemons.get('native'),before=f.store.get(f.agent.id);
 await f.fleet.updateNativePaneConfig('native',{display_name:'Renamed',description:'New description',tags:['windows']},()=>true);
 expect(f.fleet.daemons.get('native')).toBe(daemon);expect(f.cli.kill).not.toHaveBeenCalled();expect(f.store.get(f.agent.id)).toMatchObject({name:'Renamed',description:'New description',threadId:before.threadId,activeId:before.activeId});
 expect(f.fleet.fleetConfig.instances.native.tags).toEqual(['windows']);
});
it('cold native settings close positively before updating and resume the same session once',async()=>{
 const f=await fixture();await f.fleet.startInstance('native',f.config,true);f.models.mockRestore();const daemon=f.fleet.daemons.get('native'),pin=f.store.get(f.agent.id).threadId;
 vi.spyOn(daemon,'nativePauseReady').mockResolvedValue(true);vi.spyOn(daemon,'nativePauseStillReady').mockReturnValue(true);
 const update=f.store.update.bind(f.store);vi.spyOn(f.store,'update').mockImplementation((id:any,patch:any,authorized:any)=>{expect(f.cli.kill).toHaveBeenCalledOnce();expect(f.store.get(id).activeId).toBeUndefined();return update(id,patch,authorized);});
 await f.fleet.updateNativePaneConfig('native',{model:' native-model '},()=>true);
 expect(f.fleet.fleetConfig.instances.native.model).toBe('native-model');expect(f.fleet.daemons.get('native')).not.toBe(daemon);expect(f.store.get(f.agent.id)).toMatchObject({model:'native-model',threadId:pin});expect(f.spawn).toHaveBeenCalledTimes(2);
 const launch=f.fleet.daemons.get('native').nativePaneLifecycle.port.ownedSnapshot();expect(launch.sessionId).toBe(pin);expect(f.exec).not.toHaveBeenCalled();
});
it.each([{working_directory:'C:\\other'},{model:'bad\nmodel'},{native_adapter:'exec'},{tags:[42]}])('invalid native settings %j refuse before stopping or changing the profile',async patch=>{
 const f=await fixture();await f.fleet.startInstance('native',f.config,true);const before=f.store.get(f.agent.id),daemon=f.fleet.daemons.get('native');vi.spyOn(daemon,'nativePauseReady').mockResolvedValue(true);vi.spyOn(daemon,'nativePauseStillReady').mockReturnValue(true);
 await expect(f.fleet.updateNativePaneConfig('native',patch,()=>true)).rejects.toThrow();expect(f.cli.kill).not.toHaveBeenCalled();expect(f.store.get(f.agent.id)).toEqual(before);
});
it('unknown owned exit cannot save cold settings or launch a replacement',async()=>{
 const f=await fixture();await f.fleet.startInstance('native',f.config,true);const daemon=f.fleet.daemons.get('native');vi.spyOn(daemon,'nativePauseReady').mockResolvedValue(true);vi.spyOn(daemon,'nativePauseStillReady').mockReturnValue(true);
 vi.spyOn(daemon.nativePaneLifecycle,'release').mockRejectedValueOnce(Error('exit unconfirmed'));
 await expect(f.fleet.updateNativePaneConfig('native',{model:'native-model'},()=>true)).rejects.toThrow('unconfirmed');expect(f.store.get(f.agent.id).model).toBeUndefined();expect(f.store.get(f.agent.id).activeId).toBeTruthy();expect(f.spawn).toHaveBeenCalledOnce();
});
it('revoked authority after positive close leaves old settings stopped without a replacement',async()=>{
 const f=await fixture();await f.fleet.startInstance('native',f.config,true);let allowed=true;const daemon=f.fleet.daemons.get('native');vi.spyOn(daemon,'nativePauseReady').mockResolvedValue(true);vi.spyOn(daemon,'nativePauseStillReady').mockReturnValue(true);
 const kill=f.cli.kill.getMockImplementation()!;f.cli.kill.mockImplementation(()=>{allowed=false;return kill();});
 await expect(f.fleet.updateNativePaneConfig('native',{model:'native-model'},()=>allowed)).rejects.toThrow('expired');expect(f.store.get(f.agent.id).model).toBeUndefined();expect(f.store.get(f.agent.id).activeId).toBeUndefined();expect(f.spawn).toHaveBeenCalledOnce();
});

it('a retained pane allows identity previews but keeps effective launch fields fenced until positive close',async()=>{
 const f=await fixture();await f.fleet.startInstance('native',f.config,true);const before=f.store.get(f.agent.id);
 expect(f.store.previewUpdate(f.agent.id,{instructions:'new role'}).instructions).toBe('new role');expect(f.store.get(f.agent.id)).toEqual(before);
 expect(()=>f.store.update(f.agent.id,{instructions:'new role'})).toThrow('finish');expect(()=>f.store.update(f.agent.id,{model:'new-model'})).toThrow('finish');expect(f.store.get(f.agent.id)).toEqual(before);
});
it('native model selection validates that machine inventory and uses the exact close/resume settings transaction',async()=>{
 const f=await fixture();f.models.mockRestore();f.hub.machine=()=>({status:'online',platform:'win32',inventory:{clis:[{id:'claude-code',runnable:true,version:'Claude Code 2.1.316',models:[{id:'native-only'}]}],probedAt:123}});await f.fleet.startInstance('native',f.config,true);const daemon=f.fleet.daemons.get('native');
 const local=vi.spyOn(f.fleet,'claudeModelKnown').mockImplementation(()=>{throw Error('No coordinator account');});vi.spyOn(f.fleet,'readCliEnv').mockImplementation(()=>{throw Error('No coordinator cache');});
 await f.fleet.applyModel('native','unknown');expect(f.cli.kill).not.toHaveBeenCalled();expect(f.store.get(f.agent.id).model).toBeUndefined();
 vi.spyOn(daemon,'nativePauseReady').mockResolvedValue(true);vi.spyOn(daemon,'nativePauseStillReady').mockReturnValue(true);
 expect(await f.fleet.applyModel('native','native-only')).toContain('native-only');expect(f.cli.kill).toHaveBeenCalledOnce();expect(f.spawn).toHaveBeenCalledTimes(2);expect(f.store.get(f.agent.id).model).toBe('native-only');expect(local).not.toHaveBeenCalled();
});
it('native status offers pane controls without coordinator cost/context or effort',async()=>{
 const f=await fixture();f.models.mockRestore();vi.spyOn(f.fleet,'readCliEnv').mockImplementation(()=>{throw Error('No coordinator cache');});
 const row=f.fleet.getUiStatus().instances.find((value:any)=>value.name==='native');expect(row).toMatchObject({runtime:'windows',native_adapter:'pane',cost:null,context_pct:null,effort:null,capabilities:{commands:true,effort:false,log:true,details:true,attachments:false,terminal:false,send_while_busy:true}});
});
async function nativeExit(f:Awaited<ReturnType<typeof fixture>>,code=1){
 const daemon=f.fleet.daemons.get('native');f.cli.kill();await daemon.tmux.getPaneStatus();
 const snapshot={...daemon.nativePaneLifecycle.snapshot(),exitCode:code};
 // The inert host reported zero; replace only this exact private observation for nonzero-exit policy cases.
 daemon.nativePaneLifecycle.port.lastObservation=snapshot;daemon.setProcessStatus(code===0?"stopped":"crashed");
 const event={name:'native',snapshot,owner:daemon.getInteractionSnapshot().owner};daemon.emit('native_pane_exited',event);return{daemon,event};
}
it('positive native crashes close only their owned receipt and resume the same pin through a replacement daemon',async()=>{
 const f=await fixture();f.config.restart_policy={...f.config.restart_policy,reset_after:300000};await f.fleet.startInstance('native',f.config,true);const pin=f.store.get(f.agent.id).threadId;vi.useFakeTimers();
 try{const {daemon}=await nativeExit(f);await vi.waitFor(()=>expect(f.store.get(f.agent.id).activeId).toBeUndefined());expect(f.fleet.isInstanceRestarting('native')).toBe(true);expect(f.spawn).toHaveBeenCalledOnce();
 await vi.advanceTimersByTimeAsync(1001);await vi.waitFor(()=>expect(f.fleet.daemons.get('native')).not.toBe(daemon));await vi.waitFor(()=>expect(f.fleet.isInstanceRestarting('native')).toBe(false));expect(f.spawn).toHaveBeenCalledTimes(2);expect(f.store.get(f.agent.id).threadId).toBe(pin);expect(f.exec).not.toHaveBeenCalled();
 }finally{vi.useRealTimers();f.fleet.lifecycle.cancelNativeRecovery();}
});
it.each(['stop','pause','planned'])('a %s during native retry backoff prevents any replacement',async action=>{
 const f=await fixture();await f.fleet.startInstance('native',f.config,true);vi.useFakeTimers();
 try{await nativeExit(f);await vi.waitFor(()=>expect(f.store.get(f.agent.id).activeId).toBeUndefined());
 if(action==='stop')await f.fleet.stopInstance('native');else if(action==='pause'){await f.fleet.lifecycle.pause('native');expect(f.fleet.getInstanceStatus('native')).toBe('paused');}else{vi.spyOn(f.fleet,'isPlannedRestart').mockReturnValue(true);f.fleet.lifecycle.cancelNativeRecovery();}
 await vi.advanceTimersByTimeAsync(60000);expect(f.spawn).toHaveBeenCalledOnce();expect(f.exec).not.toHaveBeenCalled();
 }finally{vi.useRealTimers();f.fleet.lifecycle.cancelNativeRecovery();}
});
it.each([0,1])('native exit %i with no automatic retries stays stopped/crashed without a fresh launch',async code=>{
 const f=await fixture();f.config.restart_policy={...f.config.restart_policy,max_retries:0};await f.fleet.startInstance('native',f.config,true);const normal=vi.spyOn(f.fleet,'notifyNormalExit').mockResolvedValue(undefined),notice=vi.spyOn(f.fleet.lifecycle,'notifyIncident').mockReturnValue(true);vi.useFakeTimers();
 try{await nativeExit(f,code);await vi.waitFor(()=>expect(f.store.get(f.agent.id).activeId).toBeUndefined());await vi.advanceTimersByTimeAsync(60000);expect(f.spawn).toHaveBeenCalledOnce();expect(f.fleet.isInstanceRestarting('native')).toBe(false);expect(f.fleet.getInstanceStatus('native')).toBe(code===0?'stopped':'crashed');if(code===0)expect(normal).toHaveBeenCalledOnce();else expect(notice).toHaveBeenCalled();expect(f.store.get(f.agent.id).threadId).toBeTruthy();
 }finally{vi.useRealTimers();f.fleet.lifecycle.cancelNativeRecovery();}
});
it('three native crashes preserve the pin and trip one shared budget across replacement daemons',async()=>{
 const f=await fixture();f.config.restart_policy={...f.config.restart_policy,reset_after:300000};await f.fleet.startInstance('native',f.config,true);const pin=f.store.get(f.agent.id).threadId,notice=vi.spyOn(f.fleet.lifecycle,'notifyIncident').mockReturnValue(true);vi.useFakeTimers();
 try{for(let n=0;n<3;n++){const {daemon}=await nativeExit(f);await vi.waitFor(()=>expect(f.store.get(f.agent.id).activeId).toBeUndefined());if(n<2){await vi.advanceTimersByTimeAsync(2**n*1000+1);await vi.waitFor(()=>expect(f.fleet.daemons.get('native')).not.toBe(daemon));await vi.waitFor(()=>expect(f.fleet.isInstanceRestarting('native')).toBe(false));}}
 await vi.advanceTimersByTimeAsync(60000);expect(f.spawn).toHaveBeenCalledTimes(3);expect(f.store.get(f.agent.id).threadId).toBe(pin);expect(notice).toHaveBeenCalledWith('native','crash_loop',expect.any(String));
 }finally{vi.useRealTimers();f.fleet.lifecycle.cancelNativeRecovery();}
});
it('a forged native exit from another launch never releases or restarts the retained owner',async()=>{
 const f=await fixture();await f.fleet.startInstance('native',f.config,true);const daemon=f.fleet.daemons.get('native'),before=f.store.get(f.agent.id);daemon.emit('native_pane_exited',{name:'native',snapshot:{...daemon.nativePaneLifecycle.port.ownedSnapshot(),state:'exited',launchId:randomUUID()},owner:daemon.getInteractionSnapshot().owner});await f.fleet.lifecycle.runTransition('native',async()=>{});expect(f.fleet.isInstanceRestarting('native')).toBe(false);expect(f.store.get(f.agent.id)).toEqual(before);expect(f.cli.kill).not.toHaveBeenCalled();expect(f.spawn).toHaveBeenCalledOnce();
});

it('an operator stop while native close is awaiting cannot be undone by the automatic retry',async()=>{
 const f=await fixture();await f.fleet.startInstance('native',f.config,true);const daemon=f.fleet.daemons.get('native'),native=daemon.nativePaneLifecycle,release=native.release.bind(native);let finish!:()=>void;const gate=new Promise<void>(done=>{finish=done;});
 const closing=vi.spyOn(native,'release').mockImplementationOnce(async intent=>{await gate;return release(intent);});vi.useFakeTimers();
 try{await nativeExit(f);await vi.waitFor(()=>expect(closing).toHaveBeenCalledOnce());const stopping=f.fleet.stopInstance('native');finish();await stopping;await vi.advanceTimersByTimeAsync(60000);expect(f.spawn).toHaveBeenCalledOnce();expect(f.fleet.daemons.has('native')).toBe(false);expect(f.store.get(f.agent.id).activeId).toBeUndefined();
 }finally{finish();vi.useRealTimers();f.fleet.lifecycle.cancelNativeRecovery();}
});
it('native exit reconciles the old outbox before releasing its launch authority',async()=>{
 const f=await fixture();f.config.restart_policy={...f.config.restart_policy,max_retries:0};await f.fleet.startInstance('native',f.config,true);const daemon=f.fleet.daemons.get('native'),outbox={markTargetReconciliationPending:vi.fn(),getReconciliationCandidates:vi.fn(()=>[]),reconcileAttempt:vi.fn()};f.fleet.deliveryOutbox=outbox;
 const native=daemon.nativePaneLifecycle,release=native.release.bind(native);vi.spyOn(native,'release').mockImplementation(async intent=>{expect(outbox.markTargetReconciliationPending).toHaveBeenCalledWith('native',daemon.bootId);expect(outbox.getReconciliationCandidates).toHaveBeenCalledWith('native');return release(intent);});
 await nativeExit(f);await vi.waitFor(()=>expect(f.store.get(f.agent.id).activeId).toBeUndefined());expect(f.spawn).toHaveBeenCalledOnce();f.fleet.deliveryOutbox=null;f.fleet.lifecycle.cancelNativeRecovery();
});

it('a stop during native factory preparation releases the unacquired binding so the next start can own it',async()=>{
 const f=await fixture(),prepare=f.fleet.nativePaneFor.bind(f.fleet);const hook=vi.spyOn(f.fleet,'nativePaneFor').mockImplementationOnce(async(name:any,config:any,current:any)=>{const native=await prepare(name,config,current);f.fleet.lifecycle.invalidate(name);return native;});
 await expect(f.fleet.startInstance('native',f.config,true)).rejects.toThrow('superseded');expect(f.spawn).not.toHaveBeenCalled();expect(f.store.get(f.agent.id).activeId).toBeUndefined();hook.mockRestore();
 await expect(f.fleet.startInstance('native',f.config,true)).resolves.toBeUndefined();expect(f.spawn).toHaveBeenCalledOnce();expect(f.fleet.daemons.get('native').usesNativePane()).toBe(true);
});

it('native process status cannot fall back to the coordinator daemon.pid or a stale IPC status',async()=>{
 const f=await fixture();await f.fleet.startInstance('native',f.config,true);const daemon=f.fleet.daemons.get('native');daemon.setProcessStatus('crashed');f.fleet.instanceProcessStatus.set('native','running');const kill=vi.spyOn(process,'kill').mockImplementation(()=>{throw Error('No native local-PID probe');});expect(f.fleet.getInstanceStatus('native')).toBe('crashed');expect(kill).not.toHaveBeenCalled();kill.mockRestore();
});

it('switch-off drains the exact pane before disconnect; quick re-enable admits no replacement during cleanup',async()=>{
 const f=await fixture();await f.fleet.startInstance('native',f.config,true);const daemon=f.fleet.daemons.get('native'),hub:any=f.hub;hub.close=vi.fn();
 f.fleet.runtimeEffects={windows_cli:false,remote_runtime:true};let close!:(value:any)=>void;const call=hub.callPane.getMockImplementation();hub.callPane.mockImplementation((machine:string,request:any)=>request.action==='close'?new Promise(resolve=>{close=async()=>resolve(await call(machine,request));}):call(machine,request));
 setConfiguredRuntimeSwitches({});f.fleet.applyRuntimeSwitches();await vi.waitFor(()=>expect(close).toBeTypeOf('function'));
 expect(hub.close).not.toHaveBeenCalled();expect(f.store.get(f.agent.id).activeId).toBeTruthy();
 const invokes=vi.spyOn(f.fleet,'handleOutboundFromInstance');await expect(f.fleet.paneManager.handle(f.config.machine_id,{op:'pane-mcp',owner:f.owner(),helperId:randomUUID(),method:'tools/list',params:{}},()=>true)).rejects.toThrow();expect(invokes).not.toHaveBeenCalled();
 setConfiguredRuntimeSwitches({remote_runtime:true});f.fleet.applyRuntimeSwitches();const second=await f.store.create({name:'Second',cwd:'C:\\scratch',cli:'claude-code',sandbox:'read-only',machineId:f.config.machine_id});f.store.bindInstance(second.id,'second');const secondConfig={...nativeInstanceConfig(second),native_adapter:'pane'};f.fleet.fleetConfig.instances.second=secondConfig;await expect(f.fleet.nativePaneFor('second',secondConfig,()=>{})).rejects.toThrow();expect(f.spawn).toHaveBeenCalledOnce();
 const drain=f.fleet.remotePaneDrain;await close(undefined);await drain;await Promise.resolve();expect(hub.close).toHaveBeenCalledOnce();expect(f.fleet.runtimeHub).toBeNull();expect(f.store.get(f.agent.id).activeId).toBeUndefined();expect(f.fleet.daemons.has('native')).toBe(false);expect(f.cli.kill).toHaveBeenCalledOnce();expect(daemon.nativePaneCurrent()).toBe(false);
});
it('offline switch cleanup retains the reservation and never manufactures an exit',async()=>{
 const f=await fixture();await f.fleet.startInstance('native',f.config,true);const hub:any=f.hub;hub.close=vi.fn();hub.machine=()=>({status:'offline'});f.fleet.runtimeEffects={windows_cli:false,remote_runtime:true};setConfiguredRuntimeSwitches({});f.fleet.applyRuntimeSwitches();await f.fleet.remotePaneDrain;
 expect(hub.close).toHaveBeenCalledOnce();expect(f.store.get(f.agent.id).activeId).toBeTruthy();expect(f.cli.kill).not.toHaveBeenCalled();expect(f.spawn).toHaveBeenCalledOnce();
});

it('a disconnected native pane is held and never reports a live process from stale metadata; switch-off shows stopped',async()=>{
 const f=await fixture();await f.fleet.startInstance('native',f.config,true);expect(f.fleet.getInstanceStatus('native')).toBe('running');const online=f.hub.machine();f.hub.machine=()=>({...online,status:'offline'});expect(f.fleet.getInstanceStatus('native')).toBe('crashed');setConfiguredRuntimeSwitches({});expect(f.fleet.getInstanceStatus('native')).toBe('stopped');expect(f.cli.kill).not.toHaveBeenCalled();expect(f.store.get(f.agent.id).activeId).toBeTruthy();
});

it('a real fresh daemon cannot release startup while its native Claude terminal is blank',async()=>{
 const f=await fixture(true);let started=false;const start=f.fleet.startInstance('native',f.config,true).then(()=>{started=true;});
 await vi.waitFor(()=>expect(f.spawn).toHaveBeenCalledOnce());await new Promise(resolve=>setTimeout(resolve,20));expect(started).toBe(false);
 f.paint();await start;expect(started).toBe(true);const daemon=f.fleet.daemons.get('native');expect(daemon.backend.readInputRow(await daemon.tmux.capturePane())).not.toBeNull();expect(f.cli.write).not.toHaveBeenCalled();
});
it('a newer explicit Stop supersedes queued admin pane recovery before any host RPC',async()=>{
 const f=await fixture();let release!:()=>void;
 const barrier=f.fleet.lifecycle.runTransition('native',()=>new Promise<void>(done=>{release=done;}));
 await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
 const recovery=f.fleet.recoverNativePane('native',randomUUID(),()=>true),held=expect(recovery).rejects.toThrow('authority expired');
 const stopping=f.fleet.stopInstance('native');release();await barrier;await held;await stopping;
 expect(f.hub.callPane).not.toHaveBeenCalled();expect(f.spawn).not.toHaveBeenCalled();expect(f.cli.kill).not.toHaveBeenCalled();
});
it('an old-host compatibility hold is visible once and does not schedule automatic start retries',async()=>{
 const f=await fixture(),call=f.hub.callPane.getMockImplementation()!;f.models.mockRestore();
 f.hub.callPane.mockImplementationOnce(async(machine,request)=>{const result:any=await call(machine,request);delete result.capabilities;return result;});
 const schedule=vi.spyOn(f.fleet,'scheduleStartupRetry');
 await expect(f.fleet.startInstanceUnattended('native',f.config,true,'instance')).resolves.toBe(false);
 expect(f.store.get(f.agent.id).paneRecovery?.kind).toBe('host-upgrade');expect(schedule).not.toHaveBeenCalled();expect(f.spawn).not.toHaveBeenCalled();
 expect(f.fleet.getUiStatus().instances.find((row:any)=>row.name==='native').native_recovery?.kind).toBe('host-upgrade');
});

it('the real admin pane recovery retires only the orphan and ordinary Start resumes its same session',async()=>{
 const f=await fixture();f.models.mockRestore();await f.fleet.startInstance('native',f.config,true);const daemon=f.fleet.daemons.get('native'),pin=f.store.get(f.agent.id).threadId,old=daemon.nativePaneLifecycle.snapshot();
 f.abandon();const state=new RuntimePaneStore(join(f.root,'runner'));state.recoverInterrupted();
 let exit=(value:any)=>{};const replacement={...f.cli,kill:vi.fn(()=>exit({exitCode:0})),onExit:(fn:typeof exit)=>{exit=fn;return{dispose(){}};},onData:(fn:(data:string)=>void)=>{queueMicrotask(()=>fn('─'.repeat(40)+'\r\n❯ \r\n'+'─'.repeat(40)+'\r\n'));return{dispose(){}};}};
 f.spawn.mockResolvedValue(replacement);const host=new RuntimePaneHost({store:state,bootId:randomUUID(),online:()=>true,maxAgents:()=>4,spawn:f.spawn,mcpConnection:(owner,tools)=>({endpoint:'http://127.0.0.1:1/agent',token:'a'.repeat(64),owner,tools})});clean.push(()=>host.stop());
 f.hub.callPane.mockImplementation((_machine,request)=>host.request(request));vi.spyOn(daemon,'nativePaneCurrent').mockReturnValue(false);
 // A dead local relay stays dead on the old binding even though recovery discovers a fresh endpoint.
 daemon.nativePaneLifecycle.options.endpoint.online=()=>false;
 expect(f.store.get(f.agent.id).paneRecovery).toBeUndefined();
 expect(f.fleet.getUiStatus().instances.find((row:any)=>row.name==='native').native_recovery).toMatchObject({kind:'exit-unconfirmed',launchId:old.launchId});
 await f.fleet.recoverNativePane('native',old.launchId,()=>true);
 expect(f.fleet.daemons.has('native')).toBe(false);expect(f.store.get(f.agent.id).activeId).toBeUndefined();expect(f.store.get(f.agent.id).threadId).toBe(pin);expect(f.cli.kill).not.toHaveBeenCalled();expect(replacement.kill).not.toHaveBeenCalled();
 await f.fleet.startInstance('native',f.config,true);expect(f.store.get(f.agent.id).threadId).toBe(pin);expect(f.fleet.daemons.get('native').nativePaneLifecycle.snapshot().launchId).not.toBe(old.launchId);expect(f.spawn).toHaveBeenCalledTimes(2);await f.fleet.stopInstance('native');
});
