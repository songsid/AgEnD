/** Full Daemon start/stop with an inert native port; every host/process boundary throws if reached. */
import{afterEach,expect,it,vi}from'vitest';import{EventEmitter}from'node:events';import{mkdtempSync,rmSync,writeFileSync,existsSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{randomUUID}from'node:crypto';import pino from'pino';
import{Daemon}from'../src/daemon.js';import{createNativePaneBackend}from'../src/backend/native-pane.js';import{DEFAULT_INSTANCE_CONFIG}from'../src/config.js';
const clean:Array<()=>unknown>=[];afterEach(async()=>{for(const f of clean.splice(0).reverse())await f();vi.useRealTimers();vi.restoreAllMocks();});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'agend-native-daemon-lifecycle-'));clean.push(()=>rmSync(dir,{recursive:true,force:true}));const sessionId=randomUUID(),paneId=randomUUID();
 const forbidden=vi.fn(()=>{throw Error('No local host/process operation is permitted');}),pane={getWindowId:()=>paneId,getPaneStatus:vi.fn(async()=>({alive:true})),capturePane:vi.fn(async()=>''),capturePaneWithHistory:vi.fn(async()=>''),pipeOutput:vi.fn(async()=>{}),killWindow:forbidden,sendSpecialKey:forbidden};
 const observation=Object.assign(new EventEmitter(),{start:vi.fn(),stop:vi.fn(),registerWindow:vi.fn(async()=>{}),unregisterWindow:vi.fn(),getObservationResetAt:()=>Date.now(),isObservationBlind:()=>false,isIdle:()=>true,getLastOutputAt:()=>undefined,hasOutputSince:()=>false});
 const backend=createNativePaneBackend('codex',()=>({sessionId,contextPercentage:null,statusLineItems:['context-remaining'],resumes:true})),source={initialize:vi.fn(async()=>{}),poll:vi.fn(async()=>({toolUses:[],toolResults:[],assistantTexts:[]})),close:vi.fn(),reset:vi.fn(),currentPath:()=>null,following:()=>true,turnStateKnown:()=>true};
 const native={snapshot:vi.fn(()=>null as any),backend,host:{executionHost:'remote',bind:forbidden,ensureSession:forbidden,getPanePid:forbidden},observation,acquire:vi.fn(async(assert:()=>void)=>{assert();return{pane,source,disposition:'reattached'};}),release:vi.fn(async()=>{}),checkpointSession:vi.fn(),mcpProof:vi.fn(()=> 'unknown'),current:()=>true};
 const daemon:any=new Daemon('native-agent',{...structuredClone(DEFAULT_INSTANCE_CONFIG),working_directory:'C:\\not-a-coordinator-path',runtime:'windows',backend:'codex',agent_mode:'mcp',log_level:'error'},dir,true,backend,undefined,pino({level:'silent'})as never);daemon.setNativePaneLifecycle(native as never);clean.push(async()=>{await daemon.abortStartup();await daemon.ipcServer?.close();});
 return{dir,daemon,native,forbidden,pane,source};
}
it('native startup acquires and baselines its pane without IPC, local launch files, saved-window retirement or snapshot injection',async()=>{
 const f=fixture();writeFileSync(join(f.dir,'window-id'),'%OFF_LIMITS');const snapshot=vi.spyOn(f.daemon,'injectSnapshotMessage').mockImplementation(()=>{throw Error('No fresh snapshot injection on reattach');});
 await f.daemon.start();expect(f.native.acquire).toHaveBeenCalledOnce();expect(f.pane.pipeOutput).toHaveBeenCalledExactlyOnceWith(join(f.dir,'output.log'));expect(f.source.initialize).toHaveBeenCalledOnce();expect(f.forbidden).not.toHaveBeenCalled();expect(snapshot).not.toHaveBeenCalled();expect(f.daemon.tmux).toBe(f.pane);expect(f.daemon.isNewSession).toBe(false);expect(f.daemon.transcriptMonitor.currentPath()).toBeNull();expect(f.daemon.guardian).toBeNull();expect(existsSync(join(f.dir,'channel.sock'))).toBe(false);
 await f.daemon.stop();expect(f.native.release).toHaveBeenCalledExactlyOnceWith('detach');expect(f.forbidden).not.toHaveBeenCalled();
});
it('an explicit stop selects close while startup-abort only detaches, with no local PID or quit path',async()=>{
 const f=fixture();await f.daemon.start();await f.daemon.stop({nativePane:'close'});expect(f.native.release).toHaveBeenCalledWith('close');expect(f.forbidden).not.toHaveBeenCalled();
});
it('an acquisition failure preserves its native reservation and never enters local resume/fresh retries',async()=>{
 const f=fixture();f.native.acquire.mockRejectedValueOnce(Error('retained native owner'));await expect(f.daemon.start()).rejects.toThrow('retained native owner');await f.daemon.abortStartup();expect(f.native.release).toHaveBeenCalledExactlyOnceWith('detach');expect(f.native.acquire).toHaveBeenCalledOnce();expect(f.forbidden).not.toHaveBeenCalled();
 await expect(f.daemon.spawnClaudeWindow()).rejects.toThrow('never enter local');await expect(f.daemon.trySpawnInsideGate()).rejects.toThrow('owned exit');
});
it('native MCP readiness ignores a live coordinator-local pid slot and reports only retained helper proof',()=>{
 const f=fixture();writeFileSync(join(f.dir,'channel.mcp.pid'),String(process.pid));expect(f.daemon.mcpServerAlive()).toEqual({alive:false,source:'none'});f.native.mcpProof.mockReturnValue('alive');expect(f.daemon.mcpServerAlive()).toEqual({alive:true,source:'connection'});expect(f.forbidden).not.toHaveBeenCalled();
});
it('native health reports a positive exit once, never probes local PIDs or runs a fresh fallback',async()=>{
 const f=fixture();f.daemon.config.restart_policy.health_check_interval_ms=1000;vi.useFakeTimers();await f.daemon.start();const ended=vi.fn();f.daemon.on('native_pane_exited',ended);f.pane.getPaneStatus.mockResolvedValue({alive:false});const snapshot={hostBootId:randomUUID(),paneId:f.pane.getWindowId(),launchId:randomUUID(),agentId:randomUUID(),instance:'native-agent',state:'exited',columns:120,rows:40,seq:1,outputAt:0,commandSequence:0,sessionId:randomUUID()};f.native.snapshot.mockReturnValue(snapshot);
 await vi.advanceTimersByTimeAsync(2100);expect(ended).toHaveBeenCalledExactlyOnceWith({name:'native-agent',snapshot,owner:expect.any(Object)});expect(f.forbidden).not.toHaveBeenCalled();expect(f.native.acquire).toHaveBeenCalledOnce();await f.daemon.stop();
});
it('native pause rechecks idle, paste queue and pane owner after its capture, and never signals anything',async()=>{
 const f=fixture();await f.daemon.start();f.daemon.instanceState='working';expect(await f.daemon.nativePauseReady()).toBe(false);f.daemon.instanceState='idle';vi.spyOn(f.daemon,'paneAuthoritativelyIdle').mockReturnValue(true);expect(await f.daemon.nativePauseReady()).toBe(true);
 let release!:(value:string)=>void;f.pane.capturePane.mockImplementationOnce(()=>new Promise(done=>{release=done;}));const pending=f.daemon.nativePauseReady();f.daemon.pasteQueueDepth=1;release('idle');expect(await pending).toBe(false);expect(f.forbidden).not.toHaveBeenCalled();await f.daemon.stop();
});
it('native person turns arm the reply guard without scanning any coordinator provider store',()=>{
 const f=fixture(),roots=vi.spyOn(f.daemon,'resumeRoots').mockImplementation(()=>{throw Error('No coordinator session lookup');});
 f.daemon.markTurnStarted({chat_id:'person-chat'},'a person needs an answer');
 expect(f.daemon.turnReplyGuard.snapshot()).toMatchObject({phase:'awaiting',completionDelivered:false});expect(roots).not.toHaveBeenCalled();expect(existsSync(join(f.dir,'in-flight-turn.json'))).toBe(false);
});
it('even a stale concrete window id cannot make native cleanup resolve or signal a coordinator PID',async()=>{
 const f=fixture();f.daemon.tmux=f.pane;await expect(f.daemon.killProcessTree('SIGTERM','test')).rejects.toThrow('owned runtime pane');expect(f.forbidden).not.toHaveBeenCalled();
});

it('starting or unknown observations never become positive native exit evidence',async()=>{
 const f=fixture();f.daemon.config.restart_policy.health_check_interval_ms=1000;vi.useFakeTimers();await f.daemon.start();const ended=vi.fn();f.daemon.on('native_pane_exited',ended);f.pane.getPaneStatus.mockResolvedValue({alive:false});f.native.snapshot.mockReturnValue({state:'starting'});await vi.advanceTimersByTimeAsync(1100);f.native.snapshot.mockReturnValue({state:'unknown'});await vi.advanceTimersByTimeAsync(1100);expect(ended).not.toHaveBeenCalled();expect(f.native.acquire).toHaveBeenCalledOnce();await f.daemon.stop();
});
