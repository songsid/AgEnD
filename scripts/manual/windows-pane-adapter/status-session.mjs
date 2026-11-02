/** Signed-in native status proof. Run only in the explicitly authorized prototype folder; no model turn. */
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path'; import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto'; import { createInterface } from 'node:readline';
const [bundle,scratch]=process.argv.slice(2);
if(process.platform!=='win32'||!bundle||resolve(scratch||'').toLowerCase()!==resolve(process.env.USERPROFILE||'','agend-adapter-proto').toLowerCase())throw Error('Approved native prototype folder required');
const {RuntimePaneHost}=await import(pathToFileURL(join(bundle,'dist/runtime-pane-host.js')).href);
const {RuntimePaneStore}=await import(pathToFileURL(join(bundle,'dist/runtime-pane-store.js')).href);
const {NativePaneTranscriptReader}=await import(pathToFileURL(join(bundle,'dist/runtime-pane-transcript.js')).href);
const root=await mkdtemp(join(scratch,'status-proof-')),host=new RuntimePaneHost({store:new RuntimePaneStore(root),bootId:randomUUID(),online:()=>true,maxAgents:()=>4});
const lines=createInterface({input:process.stdin});let pane,seq=0,closing=false,tail=Promise.resolve();
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const close=async()=>{if(closing)return;closing=true;clearTimeout(deadline);await host.stop();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});};
const deadline=setTimeout(()=>{void close().finally(()=>process.exit(1));},180000);
lines.on('close',()=>{void close();});
lines.on('line',line=>{tail=tail.then(async()=>{
 const v=JSON.parse(line);if(!v||Object.keys(v).some(k=>!['id','action','sessionId'].includes(k)))throw Error('Closed test request required');
 const call=(action,fields={})=>host.request({action,paneId:pane.paneId,launchId:pane.launchId,...fields});
 if(v.action==='open'){
  if(pane)throw Error('Only one owned test pane');
  pane=await host.request({action:'open',operationId:randomUUID(),launch:{paneId:randomUUID(),agentId:randomUUID(),instance:'status-session-proof',cli:'codex',cwd:scratch,sandbox:'read-only',columns:140,rows:42}});send({id:v.id,ok:true});
 }else if(v.action==='capture')send({id:v.id,ok:true,...await call('capture',{history:300,joined:true})});
 else if(v.action==='status'){
  // The WSL controller must first prove the empty live composer with the production detector.
  await call('input',{operationId:randomUUID(),sequence:++seq,kind:'literal',text:'/status'});
  // Match TmuxManager.pasteText's settle boundary; a contiguous input+Enter is classified as a paste burst.
  await new Promise(resolve=>setTimeout(resolve,500));
  await call('key',{operationId:randomUUID(),sequence:++seq,key:'Enter'});send({id:v.id,ok:true});
 }else if(v.action==='metadata'){
  const result=await new NativePaneTranscriptReader('codex',scratch,v.sessionId).read();
  const entries=result.lines.map(line=>JSON.parse(line));
  const ownedUser=entries.some(e=>e.type==='response_item'&&e.payload?.type==='message'&&e.payload.role==='user'&&e.payload.content?.some(b=>typeof b.text==='string'&&b.text.includes('PANE_SESSION_PROOF_OK')));
  const answer=entries.some(e=>e.type==='response_item'&&e.payload?.type==='message'&&e.payload.role==='assistant'&&e.payload.content?.some(b=>typeof b.text==='string'&&b.text.trim()==='PANE_SESSION_PROOF_OK'));
  send({id:v.id,ok:true,state:result.state,sessionId:result.cursor.sessionId,records:result.lines.length,complete:result.complete,ownedUser,answer});
 }else if(v.action==='turn'){
  await call('input',{operationId:randomUUID(),sequence:++seq,kind:'paste',text:'Reply only PANE_SESSION_PROOF_OK. Do not run tools or edit files.'});
  await new Promise(resolve=>setTimeout(resolve,500));await call('key',{operationId:randomUUID(),sequence:++seq,key:'Enter'});send({id:v.id,ok:true});
 }else if(v.action==='close'){await close();send({id:v.id,ok:true});lines.close();}
 else throw Error('Unknown test operation');
 }).catch(()=>{send({ok:false,error:'Owned status proof failed'});void close().finally(()=>process.exit(1));});});
