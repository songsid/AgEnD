import assert from 'node:assert/strict';
import {readFile,writeFile,appendFile,mkdir} from 'node:fs/promises';
import {existsSync,watch} from 'node:fs';import {join,win32} from 'node:path';import {pathToFileURL} from 'node:url';import {spawn} from 'node:child_process';import {randomUUID,createHash} from 'node:crypto';import {createInterface} from 'node:readline';
const s=JSON.parse(await readFile('.artifacts/m4012-matched-fixed/state.json','utf8')),runBoot=randomUUID(),name='m4012-native-codex';
assert.equal(await readFile(join(s.root,'.m4012-owned'),'utf8'),s.tag);
process.env.AGEND_HOME=s.coordinator;delete process.env.NOTIFY_SOCKET;delete process.env.WATCHDOG_USEC;delete process.env.WATCHDOG_PID;delete process.env.TMUX;process.env.AGEND_TMUX_SESSION='m4012-'+s.tag;
const load=n=>import(pathToFileURL(join(s.compiled,n)));
const [{FleetManager},{windowsAgentsFor},{nativeInstanceConfig},{setConfiguredRuntimeSwitches},{LocalPaneEndpoint},{TmuxManager},{getTmuxSocketName},{nativeCliEnvironment},{QueuedHandoffStore},{newWebMessageId},{webHumanOrigin},{tokenEpoch}]=await Promise.all(['fleet-manager.js','windows-agents.js','native-instance-registry.js','runtime-switches.js','local-pane-endpoint.js','tmux-manager.js','paths.js','windows-cli-worker.js','queued-handoffs.js','web-chat-history.js','human-delivery-receipts.js','web-session.js'].map(load));
assert(getTmuxSocketName()&&getTmuxSocketName()!=='agend');TmuxManager.setSocketName(getTmuxSocketName());
for(const m of ['ensureSession','createWindow','respawnWindow','killWindow','killWindowConfirmed','getPanePid'])if(typeof TmuxManager.prototype[m]==='function')TmuxManager.prototype[m]=()=>{throw Error('Forbidden coordinator tmux boundary');};
const out=x=>process.stdout.write(JSON.stringify(x)+'\n');
const log=async x=>{await appendFile('.artifacts/m4012-matched-fixed/events.jsonl',JSON.stringify({at:Date.now(),runBoot,...x})+'\n');out(x);};
const native=mode=>spawn(s.node,[win32.join(s.nativeRoot,'native-runner.mjs'),mode,s.nativeRoot,s.scope,s.windowsCode],{shell:false,stdio:['pipe','pipe','pipe'],env:nativeCliEnvironment()});
const fleet=new FleetManager(s.coordinator),quiet=()=>{};
fleet.logger={info:quiet,warn:quiet,error:quiet,debug:quiet,trace:quiet,fatal:quiet,child:()=>fleet.logger};
fleet.syncRoleSkills=()=>{throw Error('No coordinator skills in Windows cwd');};fleet.readCliEnv=()=>{throw Error('No coordinator provider probe');};
fleet.startPreviewListener=()=>{};fleet.notifyFleetError=()=>true;
const relays=[],rpc={input:0,key:0},versions=new Map([['codex',s.inventory.codex]]);
setConfiguredRuntimeSwitches({windows_cli:true,max_agents_per_machine:1});
const privateConfig=join(s.coordinator,'fleet.yaml');await writeFile(privateConfig,JSON.stringify({defaults:{},web:{preview:false},runtimes:{windows_cli:true,max_agents_per_machine:1},instances:{}}));fleet.loadConfig(privateConfig,{remember:false});fleet.initializeWebAuthTokens();
fleet.localNativePaneEndpoint=async()=>{
 const old=relays.at(-1);if(old?.online())return old;
 const endpoint=await LocalPaneEndpoint.open({scope:s.scope,admit:()=>{if(fleet.shuttingDown)throw Error('stopping');},maxAgents:()=>1,version:p=>versions.get(p)||null,launch:async()=>native('relay'),mcp:async(body,current)=>(await fleet.nativePanes()).handle('local',body,current)});
 const call=endpoint.call.bind(endpoint);endpoint.call=async request=>{
  if(request.action==='input'||request.action==='key'){
   rpc[request.action]++;await appendFile('.artifacts/m4012-matched-fixed/rpc.jsonl',JSON.stringify({at:Date.now(),runBoot,action:request.action,...(request.action==='input'?{textHash:createHash('sha256').update(request.text).digest('hex'),textLength:request.text.length}: {key:request.key})})+'\n');
  }
  if(request.action==='input'&&request.text.startsWith('['))await writeFile('.artifacts/m4012-matched-fixed/wire-private.txt',request.text);const response=await call(request);if(request.action==='input'||request.action==='key')await appendFile('.artifacts/m4012-matched-fixed/acks.jsonl',JSON.stringify({at:Date.now(),runBoot,action:request.action,operationId:request.operationId,sequence:request.sequence,expectedSeq:request.expectedSeq,observedSeq:response.seq,inputRefused:response.inputRefused===true})+'\n');return response;
 };relays.push(endpoint);return endpoint;
};
fleet.ensureDeliveryOutbox();
const store=windowsAgentsFor(fleet,{start(){throw Error('Exec fallback forbidden');},get:()=>null,prepareWorkspace:async()=>s.nativeRoot});
let saved;try{saved=JSON.parse(await readFile('.artifacts/m4012-matched-fixed/agent.json','utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
const model=s.inventory.codexModels.find(x=>/-luna$/.test(x));assert(model);
const agent=saved?store.get(saved.id):await store.create({name,cli:'codex',cwd:s.nativeRoot,sandbox:'read-only',model});assert(agent);store.bindInstance(agent.id,name);
const config={...nativeInstanceConfig(agent),native_adapter:'pane',log_level:'debug',tool_progress:'standard',restart_policy:{max_retries:0,backoff:'linear',reset_after:60000,health_check_interval_ms:1000}};
fleet.fleetConfig.instances[name]=config;
await writeFile('.artifacts/m4012-matched-fixed/agent.json',JSON.stringify({id:agent.id,name,model})+'\n');
fleet.handleOutboundFromInstance=async(n,message)=>{
 assert.equal(n,name);assert.equal(message.tool,'reply','Only canary reply is permitted');const text=message.args?.text??message.payload?.text;
 assert(/^M4012_[A-Z0-9_]+$/.test(text),'Unexpected reply is not retained');
 const id=newWebMessageId();fleet.emitSseEvent('message',{instance:name,sender:'Native Codex',role:'assistant',text,ts:new Date().toISOString(),messageId:id});
 await log({kind:'reply',text});fleet.instanceIpcClients.get(name).send({type:'fleet_outbound_response',fleetRequestId:message.fleetRequestId,result:{messageId:id}});
};
// Rehydrate only this harness's own real input events, without writing to the pane again.
let messages=[];try{messages=JSON.parse(await readFile('.artifacts/m4012-matched-fixed/messages.json','utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
for(const m of messages)fleet.emitSseEvent('message',m);
await fleet.startInstance(name,config,true);
let daemon=fleet.daemons.get(name);assert(daemon?.usesNativePane());for(const level of ['debug','info','warn','error']){const original=daemon.logger[level].bind(daemon.logger);daemon.logger[level]=(value,msg)=>{const label=typeof value==='string'?value:msg;if(typeof label==='string'&&/Native|Codex|[Qq]ueue|[Pp]aste|[Dd]eliver|[Hh]and-off|[Tt]ranscript/i.test(label)){const data={};for(const key of ['reason','retryCount','expectedSeq','observedSeq','operationId','commandSequence','phase','proof','outcome','sent','handoff','redeliveries','taken','unverifiable','watching'])if(value?.[key]!==undefined)data[key]=value[key];void appendFile('.artifacts/m4012-matched-fixed/diagnostics.jsonl',JSON.stringify({at:Date.now(),runBoot,level,msg:label,...data})+'\n');}original(value,msg);};};
for(const event of ['message_queued','message_delivered','message_confirmed','message_failed','human_handoffs_unsettled'])daemon.on(event,data=>{void log({kind:'event',event,data});});
await fleet.startHealthServer(0);fleet.healthServer.prependListener('request',(_req,res)=>res.setHeader('X-M4012-Scratch',s.tag));const address=fleet.healthServer.address();assert(address&&address.address==='127.0.0.1');
const base='http://127.0.0.1:'+address.port;
const row=store.get(agent.id),initial=daemon.nativePaneLifecycle.snapshot();
await writeFile('.artifacts/m4012-matched-fixed/owned-pane.json',JSON.stringify({agentId:agent.id,sessionId:row.threadId,pane:initial,rootTag:s.tag})+'\n');
await log({kind:'coordinator-ready',runBoot,pid:process.pid,base,sessionId:row.threadId,pane:{paneId:initial.paneId,launchId:initial.launchId,hostBootId:initial.hostBootId},model});
const handoffs=()=>new QueuedHandoffStore(fleet.getInstanceDir(name)).list();
async function snapshot(){
 let flags={unreadable:true};try{const pane=await daemon.tmux.capturePane();flags={unreadable:false,busy:!!daemon.backend.getBusyPattern?.()?.test(pane),idle:await daemon.nativePauseReady(),trust:/trust this (?:folder|workspace)|Do you trust the contents/i.test(pane),login:/sign in|log in to/i.test(pane),approval:/Would you like to|Yes, proceed|allow once/i.test(pane),queueMention:/queued|Queue/i.test(pane)};}catch{}
 const h=handoffs().map(x=>({id:x.id,holder:x.holder,hasRuntime:!!x.runtime,hasPath:'path'in x,redeliveries:x.redeliveries,metaId:x.meta.message_id,wireHash:createHash('sha256').update(x.wire??'').digest('hex'),runtime:x.runtime?{paneId:x.runtime.paneId,launchId:x.runtime.launchId,hostBootId:x.runtime.hostBootId,sessionId:x.runtime.cursor.sessionId}:null}));
 const p=daemon.nativePaneLifecycle.snapshot();return{kind:'snapshot',nativeCurrent:daemon.nativePaneCurrent(),instanceState:daemon.getInstanceState(),isPaused:daemon.isPaused,runBoot,flags,handoffs:h,rpc,pane:{paneId:p.paneId,launchId:p.launchId,hostBootId:p.hostBootId},sessionId:store.get(agent.id).threadId};
}
let previousHandoff='';const observeHandoffs=async()=>{const rows=handoffs().map(x=>({id:x.id,holder:x.holder,hasRuntime:!!x.runtime,hasPath:'path'in x,redeliveries:x.redeliveries,metaId:x.meta.message_id,wireHash:createHash('sha256').update(x.wire??'').digest('hex'),runtime:x.runtime})),body=JSON.stringify(rows);if(body!==previousHandoff){previousHandoff=body;await appendFile('.artifacts/m4012-matched-fixed/handoff-events.jsonl',JSON.stringify({at:Date.now(),runBoot,rows})+'\n');}};await observeHandoffs();const handoffWatch=watch(fleet.getInstanceDir(name),(_event,file)=>{if(String(file)==='queued-handoffs.json')void observeHandoffs();});
const input=createInterface({input:process.stdin});let chain=Promise.resolve();
async function command(c){
 if(c.action==='snapshot'){out(await snapshot());return;}
 if(c.action==='capture'){let text;for(let i=0;i<8;i++){try{text=await daemon.tmux.capturePaneJoined(100);break;}catch{await new Promise(r=>setTimeout(r,150));}}assert.equal(typeof text,'string','Owned capture unavailable');await writeFile('.artifacts/m4012-matched-fixed/pane-private.txt',text);out({kind:'captured-owned-pane'});return;}
 if(c.action==='arm'){
  assert(/^[A-D]$/.test(c.label));
  const release=win32.join(s.nativeRoot,'release_'+c.label+'.txt');
  const text=`Run powershell.exe -NoProfile -Command "while(-not(Test-Path 'release_${c.label}.txt')){Start-Sleep -Milliseconds 250}" using exec_command with yield_time_ms=30000 in one blocking call; do not poll or invoke another tool until it returns; then reply M4012_BUSY_${c.label}. No other commands or file edits.`;
  await daemon.tmux.sendKeys(text);await new Promise(r=>setTimeout(r,1000));await daemon.tmux.sendSpecialKey('Enter');await log({kind:'setup-submitted',label:c.label});
  const deadline=Date.now()+90000;let sawWait=false;
  while(Date.now()<deadline){
   let pane='';try{pane=await daemon.tmux.capturePane();}catch{}
   if(/trust this (?:folder|workspace)|sign in to|Yes, proceed|Would you like to run/i.test(pane))throw Error('Owned CLI requires a decision; no settings/approval change made');
   if(daemon.backend.getBusyPattern?.()?.test(pane)&&/background terminal running/.test(pane)&&Number(/Working \((\d+)s/.exec(pane)?.[1])>=12){sawWait=true;break;}
   await new Promise(r=>setTimeout(r,250));
  }
  assert(sawWait,'No positive owned busy wait observed');
  await command({action:'send',text:`Use the AgEnD reply tool once with exactly M4012_TAKEN_${c.label}. Do not run commands or edit files. Then finish.`,label:'queued-'+c.label});
  await log({kind:'armed',label:c.label,releaseBasename:'release_'+c.label+'.txt'});return;
 }

 if(c.action==='send'){
  assert(typeof c.text==='string'&&!/[\r\n]/.test(c.text)&&c.text.length<=1000,'One-line prompt only');
  const id=newWebMessageId(),m={instance:name,sender:'Acceptance operator',role:'user',text:c.text,ts:new Date().toISOString(),messageId:id};messages.push(m);await writeFile('.artifacts/m4012-matched-fixed/messages.json',JSON.stringify(messages)+'\n');fleet.emitSseEvent('message',m);
  const accepted=await fleet.deliverHumanToInstance(name,{type:'fleet_inbound',content:c.text,meta:{source:'web',adapter_id:'private-acceptance',chat_id:'',thread_id:name,message_id:id,user:'Acceptance operator',runtime:'m4012'}},webHumanOrigin(),c.text);
  assert.notEqual(accepted,false);await log({kind:'sent',id,label:c.label??null});out(await snapshot());return;
 }
 if(c.action==='key'){assert(['Escape','C-c','Enter'].includes(c.key));await daemon.tmux.sendSpecialKey(c.key);await log({kind:'owned-key',key:c.key});return;}
 if(c.action==='web-code'){
  fleet.initializeWebSessions();const code=fleet.webLoginCodes.issue({tier:'admin',epoch:tokenEpoch(fleet.webToken)}).display;
  await writeFile('.artifacts/m4012-matched-fixed/browser-auth.json',JSON.stringify({base,code,name,tag:s.tag})+'\n');out({kind:'web-code-ready'});return;
 }
 if(c.action==='stop'){
  assert(c.pane==='detach'||c.pane==='exit');
  if(c.pane==='exit')await fleet.stopInstance(name);else await daemon.stop({nativePane:'detach'});
  for(const e of relays)e.stop();for(const client of fleet.instanceIpcClients.values())await client.close();
  fleet.memoryPressure?.stop();fleet.wakeCoordinator?.stop?.();clearInterval(fleet.replyObligationTimer);
  await new Promise(resolve=>{fleet.healthServer.closeAllConnections?.();fleet.healthServer.close(resolve);});
  fleet.deliveryOutbox?.close();await log({kind:'coordinator-stopped',paneMode:c.pane,runBoot});process.exit(0);
 }
 throw Error('Unknown owned harness action');
}
input.on('line',line=>{chain=chain.then(()=>command(JSON.parse(line))).catch(async error=>{await writeFile('.artifacts/m4012-matched-fixed/coordinator-error.log',String(error.stack??error));out({kind:'command-error',type:error.name,code:error.code??null});});});
