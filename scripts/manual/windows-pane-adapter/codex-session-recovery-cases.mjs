/** Signed-in scratch-only Codex recovery. Provider text stays in memory; receipts contain only own IDs and proof flags. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
export async function prepareUnwrittenCodex({fleet,store,row,coordinator,evidence,deriveNeedsYou,inputCounts}){
 const ids=new Set(),remember=()=>{const id=store.get(row.agent.id).threadId;if(id)ids.add(id);return id;};
 const readIntent=async()=>JSON.parse(await readFile(join(coordinator,'native-panes',row.agent.id,'active.json'),'utf8'));
 const original=remember();assert(original);await fleet.stopInstance(row.name);
 let automatic=false,proof;
 try{await fleet.startInstance(row.name,row.config,true);automatic=true;proof='absent';}
 catch(error){assert.equal(error.name,'NativePaneRecoveryError');const hold=store.get(row.agent.id).paneRecovery;assert.equal(hold?.kind,'session-unconfirmed');proof='unknown';await fleet.startFreshNativePane(row.name,hold.launchId,hold.sessionId,()=>true);}
 const first=remember();assert(first&&first!==original);const receipt=await readIntent();assert.equal(receipt.fresh.previous.sessionId,original);assert.equal(receipt.fresh.sessionId,first);assert.equal(receipt.fresh.automatic,automatic);
 await fleet.stopInstance(row.name);
 for(let count=0;count<3;count++){await assert.rejects(fleet.startInstance(row.name,row.config,true),error=>error.name==='NativePaneRecoveryError');assert.equal(remember(),first);assert.equal(store.get(row.agent.id).activeId,undefined);}
 const hold=store.get(row.agent.id).paneRecovery,needs=deriveNeedsYou({prompts:[],deliveries:[],instances:fleet.needsYouInstances(),ownerOf:()=>undefined});assert(needs.some(item=>item.instance===row.name&&item.reason==='native_pane_hold'));
 await assert.rejects(fleet.startFreshNativePane(row.name,randomUUID(),first,()=>true));
 // Fault only our coordinator's profile commit, after the runner's UUID and durable fresh receipt. Never a provider edit.
 const originalPin=store.pinFreshCodexSession.bind(store);let interrupted=false;
 store.pinFreshCodexSession=(...args)=>{if(!interrupted){interrupted=true;throw Error('Scratch profile commit interrupted');}return originalPin(...args);};
 try{await assert.rejects(fleet.startFreshNativePane(row.name,hold.launchId,first,()=>true),/Scratch profile commit interrupted/);}
 finally{store.pinFreshCodexSession=originalPin;remember();const intent=await readIntent();if(intent.fresh?.sessionId)ids.add(intent.fresh.sessionId);}
 assert(interrupted);const retained=store.get(row.agent.id).activeId,intent=await readIntent(),beforeInput=inputCounts();assert.equal(retained,intent.launch.launchId);assert.equal(remember(),first,'The old pin remains until exact observed binding completes');
 await fleet.startInstance(row.name,row.config,true);assert.equal(store.get(row.agent.id).activeId,retained);assert.equal(remember(),intent.fresh.sessionId);assert.deepEqual(inputCounts(),beforeInput,'Live interrupted reattach sends no startup input');
 await fleet.stopInstance(row.name);assert.equal(store.get(row.agent.id).activeId,undefined,'Release only after positive owned close');
 await assert.rejects(fleet.startInstance(row.name,row.config,true),error=>error.name==='NativePaneRecoveryError');
 const interruptedHold=store.get(row.agent.id).paneRecovery,held=remember();assert.equal(interruptedHold.kind,'session-unconfirmed');
 await fleet.startFreshNativePane(row.name,interruptedHold.launchId,interruptedHold.sessionId,()=>true);const final=remember();assert(final&&final!==held);
 evidence.codex={originalPin:original,firstFreshPin:first,finalPin:final,proof,automatic,interruptedBeforeProfileCommit:true,interruptedReattachedWithoutInput:true,needsYou:true,noAutomaticChain:true,staleDecisionRefused:true,sessionIds:[...ids]};
}

/** End an own no-turn pane before /status. A physical exit must free its slot without inventing a UUID. */
export async function proveUnpinnedCodexExit({fleet,store,coordinator,cwd,model,nativeInstanceConfig,evidence,supplemental}){
 const name='native-codex-unpinned-proof',agent=await store.create({name,cli:'codex',cwd,sandbox:'read-only',...(model?{model}:{})});store.bindInstance(agent.id,name);
 const config={...nativeInstanceConfig(agent),native_adapter:'pane',log_level:'silent',restart_policy:{max_retries:0,backoff:'linear',reset_after:60000,health_check_interval_ms:1000}};
 fleet.fleetConfig.instances[name]=config;supplemental.push({name,agent,config});let native;
 try{
  native=await fleet.nativePaneFor(name,config,()=>{});const file=join(coordinator,'native-panes',agent.id,'active.json'),intent=JSON.parse(await readFile(file,'utf8'));
  store.reservePane(agent.id,intent.launch.launchId);await native.port.open();assert.equal(native.port.ownedSnapshot().sessionId,undefined);await native.release('close');native=undefined;
  assert.equal(store.get(agent.id).activeId,undefined);assert.equal(store.get(agent.id).threadId,undefined);
  for(let n=0;n<3;n++)await assert.rejects(fleet.startInstance(name,config,true),error=>error.name==='NativePaneRecoveryError'&&error.recovery.kind==='session-unconfirmed');
  assert.equal(store.get(agent.id).activeId,undefined);assert.equal(store.get(agent.id).paneRecovery.sessionId,undefined);
  await assert.rejects(fleet.startFreshNativePane(name,intent.launch.launchId,randomUUID(),()=>true));
  await fleet.startFreshNativePane(name,intent.launch.launchId,null,()=>true);const pin=store.get(agent.id).threadId;assert(pin);assert.notEqual(pin,intent.launch.launchId);
  evidence.codexNoPin={positiveExitReleasedSlot:true,noAutomaticResume:true,exactNullPinAdminAction:true,launchId:intent.launch.launchId,newPin:pin,sessionIds:[pin]};
 }finally{await native?.release('close');await fleet.stopInstance(name);}
}
