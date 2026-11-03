/** Signed-in scratch-only Codex recovery. Provider text stays in memory; receipts contain only own IDs and proof flags. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
export async function prepareUnwrittenCodex({fleet,store,row,coordinator,evidence,deriveNeedsYou}){
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
 assert(interrupted);assert.equal(store.get(row.agent.id).activeId,undefined,'Only positive cleanup can release the interrupted launch');
 await assert.rejects(fleet.startInstance(row.name,row.config,true),error=>error.name==='NativePaneRecoveryError');
 const interruptedHold=store.get(row.agent.id).paneRecovery,held=remember();assert.equal(interruptedHold.kind,'session-unconfirmed');
 await fleet.startFreshNativePane(row.name,interruptedHold.launchId,interruptedHold.sessionId,()=>true);const final=remember();assert(final&&final!==held);
 evidence.codex={originalPin:original,firstFreshPin:first,finalPin:final,proof,automatic,interruptedBeforeProfileCommit:true,needsYou:true,noAutomaticChain:true,staleDecisionRefused:true,sessionIds:[...ids]};
}
