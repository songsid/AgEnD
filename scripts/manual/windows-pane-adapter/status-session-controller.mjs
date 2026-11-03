/** Own Windows scratch only; all raw pane output remains in this private in-memory pipe. */
import {spawn}from'node:child_process';import{createInterface}from'node:readline';import{win32}from'node:path';import{CodexPaneDetectors}from'../../../dist/backend/codex.js';import{ClaudePaneDetectors,claudeTrustDialogState}from'../../../dist/backend/claude-code.js';
const provider=process.argv.includes('--claude')?'claude-code':'codex';
const exe='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const child=spawn(exe,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','C:\\Users\\changhansung\\agend-adapter-proto\\run-status-session.ps1','-Provider',provider],{stdio:['pipe','pipe','pipe']});
child.stderr.resume();const input=createInterface({input:child.stdout}),pending=new Map();let id=0,exited=false;
input.on('line',line=>{try{const v=JSON.parse(line);const waiter=pending.get(v.id);if(waiter){pending.delete(v.id);v.ok?waiter.resolve(v):waiter.reject(Error('Native status driver refused'));}}catch{/* Never echo native screen/account output. */}});
child.on('close',()=>{exited=true;for(const waiter of pending.values())waiter.reject(Error('Native status driver exited'));pending.clear();});
function call(action,fields={}){return new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(Error('Native status operation deadline'));},15000);pending.set(key,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});child.stdin.write(JSON.stringify({id:key,action,...fields})+'\n');});}
const detector=provider==='codex'?new CodexPaneDetectors({statusLineItems:()=>['context-remaining'],launchMayResume:()=>false,windowsConpty:true}):new ClaudePaneDetectors();
const inputReady=pane=>typeof detector.isDeliveryInputReadyPane==='function'?detector.isDeliveryInputReadyPane(pane):detector.getReadyPattern().test(pane);
const ready=pane=>inputReady(pane)&&!detector.getBusyPattern().test(pane)&&![...detector.getStartupDialogs(),...detector.getRuntimeDialogs()].some(d=>d.pattern.test(pane)&&(!d.isActive||d.isActive(pane)));
const shape=pane=>({inputReady:inputReady(pane),busy:detector.getBusyPattern().test(pane),
 startup:detector.getStartupDialogs().filter(d=>d.pattern.test(pane)&&(!d.isActive||d.isActive(pane))).map(d=>d.description),
 runtime:detector.getRuntimeDialogs().filter(d=>d.pattern.test(pane)&&(!d.isActive||d.isActive(pane))).map(d=>d.description),
 errors:detector.getErrorPatterns().filter(d=>d.pattern.test(pane)).map(d=>d.type),
 version:/OpenAI Codex \(v([0-9.]+)\)/.exec(pane)?.[1]??null,
 composer:/^[>›]/m.test(pane),context:/\bcontext\b/i.test(pane),
 footerWords:pane.trimEnd().split('\n').slice(-6).map(row=>(row.toLowerCase().match(/\b(?:context|left|remaining|used|codex|ask|shortcuts|help|approval|sandbox|session|error|failed|update|login|trust|folder|permissions|sign|in|chatgpt)\b/g)||[])),
 fixedUiRows:pane.split('\n').filter(row=>/^\s*(?:\? for shortcuts|Context \d+% left|\d+% context left|[›>] Ask Codex to do anything)\s*$/.test(row)).map(row=>row.trim())});
const pause=()=>new Promise(r=>setTimeout(r,250));let receipt,trustMoved=false,trustAccepted=false,trustStepAt=0;
const trustedScratch=pane=>{
 const paths=pane.split('\n').map(row=>/^(?:Accessing workspace:\s*)?([a-z]:[\\/][^\r\n]*)$/i.exec(row.trim())?.[1]).filter(Boolean).map(path=>win32.normalize(path).toLowerCase());
 const approved='c:\\users\\changhansung\\agend-adapter-proto';
 if(paths.length!==1||!(paths[0]===approved||paths[0].startsWith(approved+'\\')))throw Error('Trust screen does not name exactly the approved scratch workspace');
 const extra=detector.getStartupDialogs().filter(d=>d.pattern.test(pane)&&(!d.isActive||d.isActive(pane))&&!d.description.startsWith('Claude workspace trust dialog')&&!d.description.startsWith('Claude trust/Bypass Permissions screen'));
 if(extra.length||detector.getErrorPatterns().some(d=>d.pattern.test(pane)))throw Error('Another dialog or error is present; no trust key sent');
 return claudeTrustDialogState(pane);
};
try{
 const opened=await call('open');let before='',deadline=Date.now()+40000;
 for(;;){
  before=(await call('capture')).text;if(ready(before))break;
  if(provider==='claude-code'&&process.argv.includes('--trust-scratch')&&claudeTrustDialogState(before).active){
   const trust=trustedScratch(before);
   if(trust.cursor==='decline'&&trust.declineLabel==='No, exit'&&!trustMoved&&!trustAccepted){await call('trust-down');trustMoved=true;trustStepAt=Date.now();await pause();continue;}
   if(trust.cursor==='accept'&&!trustAccepted){await call('trust-confirm');trustAccepted=true;trustStepAt=Date.now();await pause();continue;}
   if(trustMoved&&trust.cursor==='decline'&&!trustAccepted||trustAccepted&&trust.cursor==='accept'){
    if(Date.now()-trustStepAt<4000){await pause();continue;}
   }
   throw Error('Trust cursor was not proved stepwise; no further key sent: '+JSON.stringify({trustMoved,trustAccepted,state:trust}));
  }
  if(Date.now()>deadline)throw Error('Production idle detector did not prove the native composer: '+JSON.stringify(shape(before)));await pause();
 }
 let sessionId=opened.sessionId,after='';
 if(provider==='codex'){
 if(/\bSession:\s*[a-f0-9-]{36}/i.test(before))throw Error('Fresh pane already contains an identity card');
 await call('status');deadline=Date.now()+15000;
 for(;;){after=(await call('capture')).text;const ids=[...after.matchAll(/\bSession:\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/gi)].map(m=>m[1]);if(ids.length===1&&ready(after)){sessionId=ids[0];break;}if(Date.now()>deadline)throw Error('Status did not yield one exact identity and an idle composer: '+JSON.stringify({identities:ids.length,pendingStatus:/^[>›]\s*\/status/m.test(after),shape:shape(after)}));await pause();}
 }
 const metadata=await call('metadata',{sessionId});receipt={passed:true,provider,kind:'native exact session identity, no model turn',idleDetector:true,statusIdentity:provider==='codex',reservedIdentity:provider==='claude-code',sessionId,metadataState:metadata.state,metadataRecords:metadata.records,noRawCaptureSaved:true,trustAccepted,...(trustAccepted?{trustPath:'C:\\Users\\changhansung\\agend-adapter-proto',trustCursorVerified:true}: {})};
 if(process.argv.includes('--turn')){
  await call('turn');deadline=Date.now()+90000;let result;
  for(;;){result=await call('metadata',{sessionId});const pane=(await call('capture')).text;if(result.answer&&result.ownedUser&&ready(pane))break;if(Date.now()>deadline)throw Error('Owned minimal turn did not produce exact transcript and idle proofs');await pause();}
  Object.assign(receipt,{kind:'native exact session plus one minimal read-only turn',exactTranscript:true,ownedUser:result.ownedUser,answer:result.answer,metadataRecords:result.records});
 }
}catch(error){error.message+=' '+JSON.stringify({trustMoved,trustAccepted});throw error;}
finally{if(!exited)await call('close').catch(()=>{});child.stdin.end();input.close();}
process.stdout.write(JSON.stringify(receipt)+'\n');
