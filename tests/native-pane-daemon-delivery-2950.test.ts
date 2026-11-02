/** Real Daemon proof/evidence methods, no start/lifecycle handler and no live CLI or provider home. */
import{afterEach,expect,it,vi}from'vitest';import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{randomUUID}from'node:crypto';import pino from'pino';
import{Daemon}from'../src/daemon.js';import{createNativePaneBackend}from'../src/backend/native-pane.js';import{PANE_TRANSCRIPT_EMPTY_ANCHOR,type RuntimeTranscriptReference}from'../src/runtime-pane-transcript-protocol.js';import{consumedWatches}from'../src/delivery-consumed-watch.js';
const roots:string[]=[];afterEach(()=>{consumedWatches.stopAll();vi.useRealTimers();vi.restoreAllMocks();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'agend-native-daemon-delivery-'));roots.push(dir);const ref:RuntimeTranscriptReference={version:1,machineId:randomUUID(),hostBootId:randomUUID(),paneId:randomUUID(),launchId:randomUUID(),agentId:randomUUID(),provider:'codex',cursor:{sessionId:randomUUID(),fileId:null,offset:0,anchor:PANE_TRANSCRIPT_EMPTY_ANCHOR}};
 const backend=createNativePaneBackend('codex',()=>({sessionId:ref.cursor.sessionId,contextPercentage:null,statusLineItems:['context-remaining'],resumes:false}));
 const daemon:any=new Daemon('native-agent',{working_directory:'C:\\private-native-cwd',backend:'codex',runtime:'windows',log_level:'silent'}as never,dir,true,backend,undefined,pino({level:'silent'})as never);
 const reader={look:vi.fn(async()=> 'user' as const),readPosition:0,close:vi.fn()},current=vi.fn(()=>true),native={backend,host:{executionHost:'remote'},observation:{},current,proofReader:vi.fn(()=>reader)};daemon.setNativePaneLifecycle(native as never);
 const monitor={reconciliationRuntimeCheckpoint:vi.fn(async()=>ref),reconciliationCheckpoint:vi.fn(async()=>{throw Error('coordinator-local path must never be used');})};daemon.transcriptMonitor=monitor;
 return{dir,daemon,ref,native,reader,monitor};
}
it('durable begin evidence contains a closed runtime reference and no coordinator path',async()=>{
 const f=fixture(),evidence=await f.daemon.durableAttemptEvidence(f.ref.paneId,false,false);
 expect(evidence).toMatchObject({backend:'codex',windowId:f.ref.paneId,transcriptPath:null,transcriptOffset:0,transcriptSessionId:f.ref.cursor.sessionId,runtimeTranscript:f.ref});expect(f.monitor.reconciliationCheckpoint).not.toHaveBeenCalled();
});
it.each(['missing','stale'])('a %s native checkpoint refuses before durable begin and never falls back locally',async kind=>{
 const f=fixture();if(kind==='missing')f.monitor.reconciliationRuntimeCheckpoint.mockResolvedValue(null as never);else f.native.current.mockReturnValue(false);
 await expect(f.daemon.durableAttemptEvidence(f.ref.paneId,false,false)).rejects.toThrow('no delivery was written');expect(f.monitor.reconciliationCheckpoint).not.toHaveBeenCalled();
});
it('signature proof is tied to both the daemon epochs and the current runtime scope',async()=>{
 const f=fixture(),proof=f.daemon.transcriptProofFor({backend:'codex',runtime:f.ref},'delivery',f.daemon.spawnGeneration,()=>true,()=>{});
 expect(f.native.proofReader).toHaveBeenCalledExactlyOnceWith(f.ref,'delivery');expect(proof.current()).toBe(true);f.native.current.mockReturnValue(false);expect(proof.current()).toBe(false);f.native.current.mockReturnValue(true);f.daemon.launchFenceEpoch++;expect(proof.current()).toBe(false);
 expect(()=>f.daemon.transcriptProofFor({backend:'codex',path:'/never-read',offset:0},'delivery',f.daemon.spawnGeneration,()=>true,()=>{})).toThrow('coordinator-local');
});
it('native output-edge proof settles only on positive runtime evidence',async()=>{
 const f=fixture(),finish=vi.spyOn(f.daemon,'finishDurableDelivery').mockImplementation(()=>{});
 await f.daemon.proveDeliveryFromTranscript({deliveryId:'delivery',attemptNo:1},{backend:'codex',runtime:f.ref});expect(finish).toHaveBeenCalledWith({deliveryId:'delivery',attemptNo:1},'delivered',expect.stringContaining('transcript'));
 f.native.proofReader.mockImplementation(()=>{throw Error('offline');});await f.daemon.proveDeliveryFromTranscript({deliveryId:'other',attemptNo:1},{backend:'codex',runtime:f.ref});expect(finish).toHaveBeenLastCalledWith({deliveryId:'other',attemptNo:1},'uncertain','runtime-transcript-unconfirmed');
});
it('a positive runtime read arriving after a daemon generation change settles no delivered proof',async()=>{
 const f=fixture(),finish=vi.spyOn(f.daemon,'finishDurableDelivery').mockImplementation(()=>{});let release!:(value:'user')=>void;f.reader.look.mockImplementationOnce(()=>new Promise(done=>{release=done;}));
 const pending=f.daemon.proveDeliveryFromTranscript({deliveryId:'delivery',attemptNo:1},{backend:'codex',runtime:f.ref});f.daemon.spawnGeneration++;release('user');await pending;expect(finish).toHaveBeenCalledWith({deliveryId:'delivery',attemptNo:1},'uncertain','runtime-transcript-unconfirmed');
});
it('native consumed watches use the runtime reader and no local transcript fallback',()=>{
 const f=fixture(),start=vi.spyOn(consumedWatches,'start').mockReturnValue(true);f.daemon.deliveryOutbox={markConsumed:vi.fn()};
 f.daemon.startConsumedWatch({deliveryId:'delivery',attemptNo:1},{transcriptCheckpoint:{backend:'codex',runtime:f.ref},submissionMode:'steer'});expect(start).toHaveBeenCalledWith(expect.objectContaining({reader:f.reader,backend:'codex'}));expect(start.mock.calls[0][0]).not.toHaveProperty('path');
 start.mockClear();f.daemon.startConsumedWatch({deliveryId:'delivery',attemptNo:1},{transcriptCheckpoint:{backend:'codex',path:'/never-read',offset:0},submissionMode:'steer'});expect(start).not.toHaveBeenCalled();
});
