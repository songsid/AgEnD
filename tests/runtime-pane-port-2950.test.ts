import {RuntimePaneScreen} from "../src/runtime-pane-screen.js";
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';import{tmpdir}from'node:os';import{randomUUID}from'node:crypto';
import {RuntimePanePort,RuntimePaneObservation,RuntimePaneHostPort,type PaneEndpoint}from'../src/runtime-pane-port.js';
import{RuntimePaneHost}from'../src/runtime-pane-host.js';import{RuntimePaneStore}from'../src/runtime-pane-store.js';
import type{RuntimePaneLaunch}from'../src/runtime-pane-protocol.js';import type{RuntimeCoordinatorEvent}from'../src/runtime-coordinator.js';
import{CodexPaneDetectors}from'../src/backend/codex.js';
const clean:Array<()=>void|Promise<void>>=[];afterEach(async()=>{for(const f of clean.splice(0).reverse())await f();vi.restoreAllMocks();});
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'agend-remote-port-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));
 let exit:(v:{exitCode:number})=>void=()=>{},output:(data:string)=>void=()=>{},online=true;const write=vi.fn();
 const native={pid:55555,write,resize:vi.fn(),pause:vi.fn(),resume:vi.fn(),kill:vi.fn(()=>exit({exitCode:0})),onData:(listener:typeof output)=>{output=listener;return{dispose(){}};},onExit:(f:typeof exit)=>{exit=f;return{dispose(){}};}};
 const spawn=vi.fn(async()=>native),host=new RuntimePaneHost({store:new RuntimePaneStore(join(root,'runner')),bootId:randomUUID(),online:()=>online,maxAgents:()=>4,spawn});clean.push(()=>host.stop());
 const listeners=new Set<(e:RuntimeCoordinatorEvent)=>void>();const endpoint:PaneEndpoint={machineId:randomUUID(),online:()=>online,call:r=>host.request(r),subscribe:f=>{listeners.add(f);return()=>{listeners.delete(f);};}};
 const launch:RuntimePaneLaunch={paneId:randomUUID(),agentId:randomUUID(),instance:'test-中文',cli:'codex',cwd:'C:\\scratch',sandbox:'read-only',columns:80,rows:24};
 const file=join(root,'receipt.json');const make=()=>new RuntimePanePort(endpoint,file,launch, screen => new CodexPaneDetectors({statusLineItems:()=>["context-remaining"],launchMayResume:()=>false}).isDeliveryInputReadyPane(screen));const port=make();await port.open();output("› Ask Codex to do anything\r\n\r\nContext 100% left\r\n");await port.capturePane();
 return{host,spawn,native,write,endpoint,port,make,file,launch,output:(data:string)=>output(data),offline:()=>{online=false;},emit:(e:RuntimeCoordinatorEvent)=>{for(const f of listeners)f(e);}};
}
it('feeds ordinary detectors rendered plain cells rather than VT replay control sequences',async()=>{
 const f=await fixture(),detector=new CodexPaneDetectors({statusLineItems:()=>['context-remaining'],launchMayResume:()=>false});
 f.output('\x1b[32m› Ask Codex to do anything\x1b[0m\r\n\r\n  Context 100% left\r\n');
 const pane=await f.port.capturePane();expect(pane).not.toContain('\x1b[');expect(detector.getReadyPattern().test(pane)).toBe(true);expect(detector.isDeliveryInputReadyPane(pane)).toBe(true);
});
it('reconciles a lost response by command digest with no plaintext or second Enter',async()=>{
 const f=await fixture(),call=f.endpoint.call;let lost=false;
 f.endpoint.call=async request=>{const result=await call(request);if(request.action==='input'&&!lost){lost=true;throw Error('lost response');}return result;};
 const secret='PRIVATE_INPUT_CANARY';expect(await f.port.pasteBuffer(secret)).toBe(false);
 expect(readFileSync(f.file,'utf8')).not.toContain(secret);expect(f.write).toHaveBeenCalledExactlyOnceWith(`\x1b[200~${secret}\x1b[201~`);
 const recovered=f.make();expect((await recovered.open()).reattached).toBe(true);expect(f.spawn).toHaveBeenCalledOnce();expect(f.write).toHaveBeenCalledTimes(1);
 expect(await recovered.sendSpecialKey('Enter')).toBe(true);expect(f.write.mock.calls.map(x=>x[0])).toEqual([`\x1b[200~${secret}\x1b[201~`,'\r']);
});
it('holds a prepared write and never converts uncertainty into a replacement or retry',async()=>{
 const f=await fixture();f.write.mockImplementationOnce(()=>{throw Error('native write outcome unknown');});
 expect(await f.port.sendSpecialKey('Enter')).toBe(false);
 await expect(f.make().open()).rejects.toThrow('unconfirmed');expect(f.spawn).toHaveBeenCalledOnce();expect(f.write).toHaveBeenCalledOnce();
 expect(await f.port.sendKeys('again')).toBe(false);expect(f.write).toHaveBeenCalledOnce();
});
it('exposes no remote PID and disconnect is unknown, never a dead pane',async()=>{
 const f=await fixture();expect(await f.port.getPaneStatus()).toEqual({alive:true});
 f.offline();expect(await f.port.getPaneStatus()).toBeNull();await expect(f.port.isWindowAlive()).rejects.toThrow('unconfirmed');expect(f.native.kill).not.toHaveBeenCalled();
});
it('keeps edits closed and pasteText submits exactly once without Enter retry',async()=>{
 const f=await fixture();expect(await f.port.sendKeySequence(['Enter'])).toBe(false);expect(await f.port.deleteBackward(8193)).toBe(false);
 expect(await f.port.sendKeySequence(['C-a','C-k'])).toBe(true);expect(await f.port.deleteBackward(3)).toBe(true);expect(await f.port.pasteText('message')).toBe(true);
 expect(f.write.mock.calls.map(x=>x[0])).toEqual(['\x01\x0b','\x7f\x7f\x7f','\x1b[200~message\x1b[201~','\r']);
});
it('settles the paste before Enter and a disconnect in that interval sends nothing else',async()=>{
 const f=await fixture();vi.useFakeTimers();
 try{
  const result=f.port.pasteText('settled message');await vi.advanceTimersByTimeAsync(0);expect(f.write.mock.calls.map(x=>x[0])).toEqual(['\x1b[200~settled message\x1b[201~']);
  await vi.advanceTimersByTimeAsync(499);expect(f.write).toHaveBeenCalledTimes(1);f.offline();await vi.advanceTimersByTimeAsync(1);expect(await result).toBe(false);expect(f.write).toHaveBeenCalledTimes(1);
 }finally{vi.useRealTimers();}
});
it('observation is blind offline and rejects output from another launch',async()=>{
 const f=await fixture(),owned=f.port.ownedSnapshot()!,observation=new RuntimePaneObservation(f.endpoint,()=>f.port.ownedSnapshot(),0);clean.push(()=>observation.stop());observation.start();await observation.registerWindow(owned.paneId);
 f.emit({type:'pane',machineId:f.endpoint.machineId,pane:{...owned,launchId:randomUUID()}});expect(observation.isIdle(owned.paneId)).toBe(false);
 f.emit({type:'pane',machineId:f.endpoint.machineId,pane:owned});expect(observation.isIdle(owned.paneId)).toBe(true);f.emit({type:'machine',machineId:f.endpoint.machineId});expect(observation.isIdle(owned.paneId)).toBe(true);f.offline();expect(observation.isIdle(owned.paneId)).toBe(false);expect(observation.getLastOutputAt(owned.paneId)).toBeUndefined();
});

it('host facade retains handle identity and exposes no remote PID as a local signal target',async()=>{
 const f=await fixture(),host=new RuntimePaneHostPort(f.port,f.endpoint);
 expect(host.bind('ignored','')).toBe(f.port);expect(host.bind('ignored',f.port.getWindowId())).toBe(f.port);
 expect(()=>host.bind('ignored',randomUUID())).toThrow('outside');expect(host.executionHost).toBe('remote');
 expect(await host.getServerPid()).toBeNull();expect(await host.getPanePid()).toBeNull();expect(await host.listPanePids()).toEqual([]);
 expect(await host.listWindows()).toEqual([{id:f.port.getWindowId(),name:f.launch.instance}]);
});

import {PANE_TRANSCRIPT_EMPTY_ANCHOR}from'../src/runtime-pane-transcript-protocol.js';
it('pins one conversation, preserves it on reattach, and refuses foreign transcript scope',async()=>{
 const f=await fixture(),sessionId=randomUUID(),cursor={sessionId,offset:0,fileId:null,anchor:PANE_TRANSCRIPT_EMPTY_ANCHOR};
 expect(()=>f.port.runtimeTranscriptReference(cursor)).toThrow('not pinned');f.output(`Session: ${sessionId}\r\n`);
 await f.port.bindConversation(sessionId);const ref=f.port.runtimeTranscriptReference(cursor);
 expect(f.port.isTranscriptObservationCurrent(ref)).toBe(true);
 for(const key of ['machineId','hostBootId','paneId','launchId','agentId']as const)expect(f.port.isTranscriptObservationCurrent({...ref,[key]:randomUUID()})).toBe(false);
 expect(f.port.isTranscriptObservationCurrent({...ref,provider:'claude-code'})).toBe(false);
 expect(f.port.isTranscriptObservationCurrent({...ref,cursor:{...cursor,sessionId:randomUUID()}})).toBe(false);
 const next=f.make();await next.open();expect(next.ownedSnapshot()?.sessionId).toBe(sessionId);expect(f.write).not.toHaveBeenCalled();
});
it.each(['disconnect','lease'])('rejects a transcript response after %s without changing the cursor or sending keys',async kind=>{
 const f=await fixture(),sessionId=randomUUID(),cursor={sessionId,offset:0,fileId:null,anchor:PANE_TRANSCRIPT_EMPTY_ANCHOR};
 f.output(`Session: ${sessionId}\r\n`);await f.port.bindConversation(sessionId);const before=readFileSync(f.file,'utf8');
 let release!:(value:unknown)=>void,current=true;f.endpoint.call=vi.fn(()=>new Promise(done=>{release=done;}));
 const pending=f.port.readTranscript(cursor,()=>current);if(kind==='disconnect')f.offline();else current=false;
 release({state:'pending',cursor,data:'',complete:false,gap:false});await expect(pending).rejects.toThrow('stale');
 expect(readFileSync(f.file,'utf8')).toBe(before);expect(f.write).not.toHaveBeenCalled();
});
it('explicit close remains available after an uncertain input and never repeats that input',async()=>{
 const f=await fixture();f.write.mockImplementationOnce(()=>{throw Error('write may have landed');});expect(await f.port.sendSpecialKey('Enter')).toBe(false);
 expect(await f.port.killWindowConfirmed()).toBe(true);expect(f.native.kill).toHaveBeenCalledOnce();expect(f.write).toHaveBeenCalledOnce();expect(f.port.ownedSnapshot()?.state).toBe('exited');
});
it('close bypasses a held input response and rejects all later input until its exit is confirmed',async()=>{
 const f=await fixture(),call=f.endpoint.call;let release!:(value:unknown)=>void;
 f.endpoint.call=async request=>{const result=await call(request);if(request.action==='key')return new Promise(done=>{release=()=>done(result);});return result;};
 const write=f.port.sendSpecialKey('Enter');await vi.waitFor(()=>expect(release).toBeDefined());const close=f.port.killWindowConfirmed();expect(await close).toBe(true);
 const after=f.port.sendKeys('never after close');release(undefined);expect(await write).toBe(false);expect(await after).toBe(false);expect(f.native.kill).toHaveBeenCalledOnce();expect(f.write).toHaveBeenCalledExactlyOnceWith('\r');
});
it('a lost close response is recovered by positive exit without replaying close or Enter',async()=>{
 const f=await fixture(),call=f.endpoint.call;let lost=true;f.endpoint.call=async request=>{const result=await call(request);if(request.action==='close'&&lost){lost=false;throw Error('lost close response');}return result;};
 expect(await f.port.killWindowConfirmed()).toBe(false);await expect(f.make().open()).rejects.toThrow('close outcome');const recovered=f.make();expect(await recovered.killWindowConfirmed()).toBe(true);expect(f.native.kill).toHaveBeenCalledOnce();expect(f.write).not.toHaveBeenCalled();
});
it('the automatic status request has a durable one-shot intent across coordinator restart',async()=>{
 const f=await fixture();expect(await f.port.beginStatusRequest()).toBe(true);const next=f.make();await next.open();expect(await next.beginStatusRequest()).toBe(false);expect(f.write).not.toHaveBeenCalled();
});

it('explicit close needs owned metadata but never a healthy terminal capture',async()=>{
 const f=await fixture();vi.spyOn(RuntimePaneScreen.prototype,'capture').mockRejectedValue(Error('parser unavailable'));expect(await f.port.killWindowConfirmed()).toBe(true);expect(f.native.kill).toHaveBeenCalledOnce();expect(f.write).not.toHaveBeenCalled();
});
it.each(['starting','unknown'] as const)('%s metadata cannot be reported as a positive pane exit',async state=>{
 const f=await fixture(),call=f.endpoint.call;f.endpoint.call=async request=>request.action==='snapshot'?{...f.port.ownedSnapshot(),state}:call(request);expect(await f.port.getPaneStatus()).toBeNull();expect(f.native.kill).not.toHaveBeenCalled();expect(f.write).not.toHaveBeenCalled();
});
it('a positively observed exact native exit can be finalized after disconnect without another host call',async()=>{
 const f=await fixture();f.native.kill();expect(await f.port.getPaneStatus()).toEqual({alive:false,exitCode:0});f.offline();const call=vi.spyOn(f.endpoint,'call');expect(await f.port.killWindowConfirmed()).toBe(true);expect(call).not.toHaveBeenCalled();expect(f.port.ownedSnapshot()?.state).toBe('exited');expect(f.native.kill).toHaveBeenCalledOnce();
});

const nativeApproval = readFileSync(join(__dirname,'fixtures/codex-audit-0166/01650/approval.pane.txt'),'utf8');
function repaint(f:Awaited<ReturnType<typeof fixture>>,text:string){f.output('\x1b[2J\x1b[H'+text.replace(/\r?\n/g,'\r\n'));}
it('a permission card appearing after paste gets no implicit native Enter or literal/edit key',async()=>{
 const f=await fixture();expect(await f.port.pasteBuffer('owned prompt')).toBe(true);f.write.mockClear();repaint(f,nativeApproval);
 expect(await f.port.sendSpecialKey('Enter')).toBe(false);expect(await f.port.sendKeys('yes')).toBe(false);expect(await f.port.sendKeySequence(['C-a'])).toBe(false);expect(await f.port.deleteBackward(1)).toBe(false);expect(await f.port.pasteBuffer('yes')).toBe(false);
 expect(f.write).not.toHaveBeenCalled();expect(f.port.getLastSendSpecialKeyError()).toContain('withheld');
});
it('output arriving between composer proof and key is refused at the owned host without becoming uncertain',async()=>{
 const f=await fixture(),screen=await f.port.capturePane(),call=f.endpoint.call;let raced=false;
 f.endpoint.call=async request=>{if(request.action==='key'&&!raced){raced=true;repaint(f,nativeApproval);}return call(request);};
 expect(await f.port.sendSpecialKey('Enter',undefined,{kind:'composer',screen})).toBe(false);expect(f.write).not.toHaveBeenCalled();expect(f.port.ownedSnapshot()).toMatchObject({commandSequence:1,inputRefused:true});expect(readFileSync(f.file,'utf8')).not.toContain('pending');
 repaint(f,'› Ask Codex to do anything\n\nContext 100% left\n');expect(await f.port.sendSpecialKey('Enter')).toBe(true);expect(f.write).toHaveBeenCalledExactlyOnceWith('\r');expect(f.port.ownedSnapshot()?.commandSequence).toBe(2);
});
it('an ACK lost after positive input refusal reconciles to no input and never replays the refused Enter',async()=>{
 const f=await fixture(),screen=await f.port.capturePane(),call=f.endpoint.call;let lost=false;
 f.endpoint.call=async request=>{if(request.action==='key'&&!lost){lost=true;repaint(f,nativeApproval);await call(request);throw Error('lost refusal ACK');}return call(request);};
 expect(await f.port.sendSpecialKey('Enter',undefined,{kind:'composer',screen})).toBe(false);expect(f.write).not.toHaveBeenCalled();const next=f.make();await next.open();expect(f.write).not.toHaveBeenCalled();expect(next.ownedSnapshot()?.inputRefused).toBe(true);expect(await next.sendSpecialKey('Enter')).toBe(false);expect(f.write).not.toHaveBeenCalled();
});
it('only an explicit exact-screen dialog proof can walk the card; its changed-screen answer is refused',async()=>{
 const f=await fixture();repaint(f,nativeApproval);const screen=await f.port.capturePane();expect(await f.port.sendSpecialKey('Down',undefined,{kind:'dialog',screen})).toBe(true);expect(f.write).toHaveBeenCalledExactlyOnceWith('\x1b[B');f.write.mockClear();
 repaint(f,'another question');await f.port.capturePane();expect(await f.port.sendSpecialKey('Enter',undefined,{kind:'dialog',screen})).toBe(false);expect(f.write).not.toHaveBeenCalled();
});
it('a capture that races output cannot create native input proof',async()=>{
 const f=await fixture(),capture=RuntimePaneScreen.prototype.capture;vi.spyOn(RuntimePaneScreen.prototype,'capture').mockImplementationOnce(async function(this:RuntimePaneScreen,options){const screen=await capture.call(this,options);repaint(f,nativeApproval);return screen;});
 await expect(f.port.capturePane()).rejects.toThrow('changed during capture');expect(f.write).not.toHaveBeenCalled();expect(await f.port.sendSpecialKey('Enter')).toBe(false);expect(f.write).not.toHaveBeenCalled();
});

it('quiet native panes still receive safety captures; offline and detached observations never do',async()=>{
 const f=await fixture(),observation=new RuntimePaneObservation(f.endpoint,()=>f.port.ownedSnapshot()),sweep=vi.fn(),output=vi.fn();clean.push(()=>observation.stop());
 vi.useFakeTimers();try{observation.on('safety_sweep',sweep);observation.on(`output:${f.port.getWindowId()}`,output);observation.start();observation.start();await observation.registerWindow(f.port.getWindowId());
  await vi.advanceTimersByTimeAsync(5000);expect(sweep).toHaveBeenCalledOnce();expect(output).not.toHaveBeenCalled();expect(observation.isIdle(f.port.getWindowId())).toBe(false);expect(observation.getLastOutputAt(f.port.getWindowId())).toBeUndefined();
  f.offline();await vi.advanceTimersByTimeAsync(5000);expect(sweep).toHaveBeenCalledOnce();observation.stop();await vi.advanceTimersByTimeAsync(10000);expect(sweep).toHaveBeenCalledOnce();
 }finally{vi.useRealTimers();}
});

import {Daemon} from '../src/daemon.js';
import {ClaudeCodeBackend} from '../src/backend/claude-code.js';
it('ordinary native delivery retries only the positively refused Enter with new proof and no paste',async()=>{
 const f=await fixture(),root=join(f.file,'..'),backend=new ClaudeCodeBackend(root);
 const logger={info(){},warn(){},error(){},debug(){},child(){return this;}};
 const daemon:any=new Daemon('private-proof',{working_directory:root,backend:'claude-code',log_level:'silent'}as never,root,true,backend,undefined,logger as never);
 daemon.tmux=f.port;daemon.nativePaneLifecycle={};daemon.backend=new CodexPaneDetectors({statusLineItems:()=>['context-remaining'],launchMayResume:()=>false});
 const mark=vi.fn(()=>true);daemon.deliveryOutbox={markEnterStarted:mark};const call=f.endpoint.call;let raced=false;const operations:string[]=[];
 f.endpoint.call=async request=>{operations.push(request.action);if(request.action==='key'&&!raced){raced=true;f.output('\x1b[2J\x1b[H› Ask Codex to do anything\r\n\r\nContext 100% left\r\n');}return call(request);};
 expect(await daemon.sendDeliveryEnter('initial-submit',undefined,{deliveryId:'private-delivery',attemptNo:1})).toBe(true);
 expect(operations.filter(action=>action==='key')).toHaveLength(2);expect(operations.filter(action=>action==='input')).toHaveLength(0);
 expect(f.write).toHaveBeenCalledExactlyOnceWith('\r');expect(mark).toHaveBeenCalledOnce();
});
