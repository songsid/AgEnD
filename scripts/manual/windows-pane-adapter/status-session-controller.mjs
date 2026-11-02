/** Own Windows scratch only; all raw pane output remains in this private in-memory pipe. */
import {spawn}from'node:child_process';import{createInterface}from'node:readline';import{CodexPaneDetectors}from'../../../dist/backend/codex.js';
const exe='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const child=spawn(exe,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','C:\\Users\\changhansung\\agend-adapter-proto\\run-status-session.ps1'],{stdio:['pipe','pipe','pipe']});
child.stderr.resume();const input=createInterface({input:child.stdout}),pending=new Map();let id=0,exited=false;
input.on('line',line=>{try{const v=JSON.parse(line);const waiter=pending.get(v.id);if(waiter){pending.delete(v.id);v.ok?waiter.resolve(v):waiter.reject(Error('Native status driver refused'));}}catch{/* Never echo native screen/account output. */}});
child.on('close',()=>{exited=true;for(const waiter of pending.values())waiter.reject(Error('Native status driver exited'));pending.clear();});
function call(action,fields={}){return new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(Error('Native status operation deadline'));},15000);pending.set(key,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});child.stdin.write(JSON.stringify({id:key,action,...fields})+'\n');});}
const detector=new CodexPaneDetectors({statusLineItems:()=>['context-remaining'],launchMayResume:()=>false,windowsConpty:true});
const ready=pane=>detector.isDeliveryInputReadyPane(pane)&&!detector.getBusyPattern().test(pane)&&![...detector.getStartupDialogs(),...detector.getRuntimeDialogs()].some(d=>d.pattern.test(pane)&&(!d.isActive||d.isActive(pane)));
const shape=pane=>({inputReady:detector.isDeliveryInputReadyPane(pane),busy:detector.getBusyPattern().test(pane),
 startup:detector.getStartupDialogs().filter(d=>d.pattern.test(pane)&&(!d.isActive||d.isActive(pane))).map(d=>d.description),
 runtime:detector.getRuntimeDialogs().filter(d=>d.pattern.test(pane)&&(!d.isActive||d.isActive(pane))).map(d=>d.description),
 errors:detector.getErrorPatterns().filter(d=>d.pattern.test(pane)).map(d=>d.type),
 version:/OpenAI Codex \(v([0-9.]+)\)/.exec(pane)?.[1]??null,
 composer:/^[>›]/m.test(pane),context:/\bcontext\b/i.test(pane),
 footerWords:pane.trimEnd().split('\n').slice(-6).map(row=>(row.toLowerCase().match(/\b(?:context|left|remaining|used|codex|ask|shortcuts|help|approval|sandbox|session|error|failed|update|login|trust|folder|permissions|sign|in|chatgpt)\b/g)||[])),
 fixedUiRows:pane.split('\n').filter(row=>/^\s*(?:\? for shortcuts|Context \d+% left|\d+% context left|[›>] Ask Codex to do anything)\s*$/.test(row)).map(row=>row.trim())});
const pause=()=>new Promise(r=>setTimeout(r,250));let receipt;
try{
 await call('open');let before='',deadline=Date.now()+40000;
 for(;;){before=(await call('capture')).text;if(ready(before))break;if(Date.now()>deadline)throw Error('Production idle detector did not prove the native composer: '+JSON.stringify(shape(before)));await pause();}
 if(/\bSession:\s*[a-f0-9-]{36}/i.test(before))throw Error('Fresh pane already contains an identity card');
 await call('status');let sessionId,after='';deadline=Date.now()+15000;
 for(;;){after=(await call('capture')).text;const ids=[...after.matchAll(/\bSession:\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/gi)].map(m=>m[1]);if(ids.length===1&&ready(after)){sessionId=ids[0];break;}if(Date.now()>deadline)throw Error('Status did not yield one exact identity and an idle composer: '+JSON.stringify({identities:ids.length,pendingStatus:/^[>›]\s*\/status/m.test(after),shape:shape(after)}));await pause();}
 const metadata=await call('metadata',{sessionId});receipt={passed:true,kind:'native Codex status, no model turn',idleDetector:true,statusIdentity:true,sessionId,metadataState:metadata.state,metadataRecords:metadata.records,noRawCaptureSaved:true};
 if(process.argv.includes('--turn')){
  await call('turn');deadline=Date.now()+90000;let result;
  for(;;){result=await call('metadata',{sessionId});const pane=(await call('capture')).text;if(result.answer&&result.ownedUser&&ready(pane))break;if(Date.now()>deadline)throw Error('Owned minimal turn did not produce exact transcript and idle proofs');await pause();}
  Object.assign(receipt,{kind:'native Codex status plus one minimal read-only turn',exactTranscript:true,ownedUser:result.ownedUser,answer:result.answer,metadataRecords:result.records});
 }
}finally{if(!exited)await call('close').catch(()=>{});child.stdin.end();input.close();}
process.stdout.write(JSON.stringify(receipt)+'\n');
