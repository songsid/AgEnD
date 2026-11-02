/** Isolated, no-account standalone-runtime acceptance. Never imports Fleet or launches a provider CLI.
 * Prepare ROOT/{hub,bundle}; on Windows pass the scratch-only node-pty module path as the second argument.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root=resolve(process.argv[2]||'.'), ptyPath=process.argv[3];
const {RuntimeCoordinator}=await import(pathToFileURL(join(root,'hub/runtime-coordinator.js')));
const {RuntimeClientStore}=await import(pathToFileURL(join(root,'bundle/dist/runtime-client-store.js')));
const {runtimeClaimFingerprint}=await import(pathToFileURL(join(root,'bundle/dist/runtime-protocol.js')));
const require=createRequire(pathToFileURL(join(root,'bundle/package.json'))), {WebSocket}=require('ws');
const state=mkdtempSync(join(root,'state-')), profile=join(state,'profile'), entry=join(root,'bundle/dist/runtime-cli.js');
const env={SystemRoot:process.env.SystemRoot, WINDIR:process.env.WINDIR, PATH:dirname(process.execPath), TEMP:state,TMP:state,
  HOME:state,USERPROFILE:state,APPDATA:state,LOCALAPPDATA:state,AGEND_HOME:join(state,'agend'),AGEND_RUNTIME_HOME:profile};
for(const k of Object.keys(env))if(env[k]===undefined)delete env[k];
let hub=new RuntimeCoordinator(join(state,'hub')), tty, ttyExited=true, server, loseResponse=false, receipt;
const checks=[], sockets=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){const end=Date.now()+20000;while(!check()){if(Date.now()>end)throw Error('Acceptance deadline');await sleep(25);}}
async function cli(...args){
 const child=spawn(process.execPath,[entry,...args,'--profile',profile],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 const timer=setTimeout(()=>child.kill(),20000);try{const [code]=await once(child,'exit');return {code,output};}finally{clearTimeout(timer);}
}
function noSecrets(output,...values){for(const value of values.filter(Boolean))assert(!output.includes(value),'CLI printed a test credential');}
async function post(path,body,credential){return fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(credential?{Authorization:`Bearer ${credential}`}:{})},body:JSON.stringify(body)});}
async function websocket(credential,allowed){
 const ws=new WebSocket(base.replace('http:','ws:')+'/runtime/v1/connect',{headers:{Authorization:`Bearer ${credential}`}});sockets.push(ws);ws.on('error',()=>{});
 if(!allowed){const [,response]=await once(ws,'unexpected-response');assert.equal(response.statusCode,401);response.resume();ws.terminate();return;}
 await once(ws,'open');const hello=once(ws,'message');ws.send(JSON.stringify({v:1,type:'hello',bootId:'acceptance-only'}));assert.equal(JSON.parse(String((await hello)[0])).type,'welcome');ws.close();
}
let base;
try{
 server=createServer((req,res)=>{
  if(req.url==='/runtime/v1/rotate'&&loseResponse){const end=res.end.bind(res);res.end=(...args)=>{if(res.statusCode===200){loseResponse=false;res.destroy();return res;}return end(...args);};}
  if(!hub.handlePublicRequest(req,res,new URL(req.url,'http://localhost'))){res.writeHead(404);res.end();}
 });
 server.on('upgrade',(req,sock,head)=>{if(!hub.handleUpgrade(req,sock,head))sock.destroy();});
 server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
 const store=new RuntimeClientStore(profile);
 if(process.platform==='win32'){
  assert(ptyPath,'Native Windows connect proof requires scratch node-pty');const pty=require(ptyPath), pairing=hub.createPairing();let screen='',exited=false,exitCode;
  tty=pty.spawn(process.execPath,[entry,'connect','--server',base,'--name','Acceptance only','--profile',profile],{cwd:root,env,cols:140,rows:30,useConpty:true});
  ttyExited=false;tty.onData(data=>{screen+=data;if(screen.length>32768)screen=screen.slice(-32768);});tty.onExit(e=>{exited=true;ttyExited=true;exitCode=e.exitCode;});
  await until(()=>screen.includes('One-time pairing code'));tty.write(pairing.code+'\r');
  await until(()=>/Pairing fingerprint: [A-F0-9-]{14}/.test(screen));const fingerprint=/Pairing fingerprint: ([A-F0-9-]{14})/.exec(screen)[1];
  const machine=hub.listMachines()[0];assert.equal(machine.pairingFingerprint,fingerprint);hub.approve(machine.id,fingerprint);
  await until(()=>hub.machine(machine.id)?.status==='online');checks.push('native Windows CLI connect prints matching claim fingerprint; approval and WebSocket welcome succeed');
  const before=readFileSync(join(profile,'connection.json'),'utf8'), refused=await cli('rotate');assert.equal(refused.code,1);assert.equal(readFileSync(join(profile,'connection.json'),'utf8'),before);assert.match(refused.output,/Another runtime/);
  checks.push('running profile refuses rotation with local and coordinator credential unchanged');
  tty.write('\x03');await until(()=>exited);assert.equal(exitCode,0);tty=null;screen='';
 }else{
  const pairing=hub.createPairing(), request=hub.pair({code:pairing.code,name:'Acceptance only',platform:'win32'});hub.approve(request.machineId,runtimeClaimFingerprint(request.claimSecret));
  const claim=hub.claim({machineId:request.machineId,claimSecret:request.claimSecret});assert.equal(claim.status,'approved');store.saveCredentials({server:base,machineId:claim.machineId,credential:claim.credential,name:'Acceptance only'});
  checks.push('non-Windows bootstrap uses fixture pairing; native connect proof not claimed');
 }
 const initial=store.credentials(), status=await cli('status');assert.equal(status.code,0);assert.equal(JSON.parse(status.output).machineId,initial.machineId);noSecrets(status.output,initial.credential);
 const unlock=store.lock('fixture-blocker'), before=readFileSync(join(profile,'connection.json'),'utf8'), blocked=await cli('rotate');unlock();assert.equal(blocked.code,1);assert.equal(readFileSync(join(profile,'connection.json'),'utf8'),before);
 const rotated=await cli('rotate');assert.equal(rotated.code,0);const current=store.credentials();assert.notEqual(current.credential,initial.credential);assert.equal(current.machineId,initial.machineId);noSecrets(rotated.output,initial.credential,current.credential);
 await websocket(initial.credential,false);await websocket(current.credential,true);checks.push('real standalone CLI rotate/status: same machine, old credential rejected, replacement connects, no credential output');
 loseResponse=true;const lost=await cli('rotate');assert.equal(lost.code,1);const pending=store.credentials();assert(pending.pendingCredential);noSecrets(lost.output,pending.credential,pending.pendingCredential);
 hub.close();hub=new RuntimeCoordinator(join(state,'hub'));
 const recovered=await cli('rotate');assert.equal(recovered.code,0);const final=store.credentials();assert.equal(final.credential,pending.pendingCredential);assert.equal(final.pendingCredential,undefined);assert.equal(final.machineId,initial.machineId);noSecrets(recovered.output,pending.credential,final.credential);
 await websocket(pending.credential,false);await websocket(final.credential,true);assert.equal(hub.listMachines().length,1);checks.push('lost response + real coordinator restart: same persisted replacement completes, no re-pair and no duplicate machine');
 const one=hub.pair({code:hub.createPairing().code,name:'One',platform:'win32'}), two=hub.pair({code:hub.createPairing().code,name:'Two',platform:'win32'});
 for(let i=0;i<121;i++){const response=await post('/runtime/v1/claim',{machineId:one.machineId,claimSecret:one.claimSecret});assert.equal(response.status,i===120?429:202);}
 assert.equal((await post('/runtime/v1/claim',{machineId:two.machineId,claimSecret:two.claimSecret})).status,202);checks.push('two loopback clients have independent claim budgets');
 assert.deepEqual(JSON.parse(readFileSync(join(state,'hub/runtime-machines.json'),'utf8')).commands,[]);assert.deepEqual(store.list(),[]);
 checks.push('no task, probe, workspace, provider CLI, account or fleet operation');
 receipt={pass:true,platform:process.platform,node:process.version,checks,cleanup:'scratch profiles removed; no credentials/screens emitted'};
}finally{
 if(tty){try{tty.write('\x03');await until(()=>ttyExited);}catch{tty.kill();await until(()=>ttyExited);}}
 for(const s of sockets)s.terminate();hub.close();
 if(server){server.closeAllConnections();await new Promise(r=>server.close(()=>r()));}
 rmSync(state,{recursive:true,force:true});
}

// The ConPTY library can retain native pipe handles after its child has positively exited.
// All owned children and HTTP state are already closed; finish only this fixture host after stdout drains.
process.stdout.write(JSON.stringify(receipt,null,2)+'\n',()=>process.exit(0));
