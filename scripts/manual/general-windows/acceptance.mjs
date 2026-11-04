/** Real paired Windows General/Fleet/Daemon/MCP, own scratch only. Signed-in test approval required. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdir,mkdtemp,readFile,writeFile,cp,rm} from 'node:fs/promises';
import {join,resolve,win32} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {sourceReceipt,codeBundleReceipt} from '../windows-pane-adapter/source-receipt.mjs';
import {deliverStates} from '../windows-pane-adapter/session-recovery-cases.mjs';
const source=sourceReceipt();assert(source.sourceTrackedClean,'Commit the source before acceptance');
const compiled=resolve('dist'),bundle=resolve('.artifacts/runtime-bundle'),tag=randomUUID().slice(0,8);
const root='/mnt/c/Users/changhansung/agend-adapter-proto/general-'+tag,nativeRoot='C:\\Users\\changhansung\\agend-adapter-proto\\general-'+tag;
const home=await mkdtemp(join(process.cwd(),'.artifacts/general-proof-'));
process.env.AGEND_HOME=home;process.env.AGEND_TMUX_SESSION='general-proof-'+tag;
for(const key of ['NOTIFY_SOCKET','WATCHDOG_USEC','WATCHDOG_PID','TMUX','AGEND_REMOTE_RUNTIME'])delete process.env[key];
const load=name=>import(pathToFileURL(join(compiled,name+'.js')).href);
const [{FleetManager},{RuntimeCoordinator},{windowsAgentsFor},{nativeInstanceConfig},{setConfiguredRuntimeSwitches},{TmuxManager},{getTmuxSocketName},{resolveToolSet},{loadGeneralKnowledge},{GENERAL_SKILL_NAMES}]=await Promise.all([
 ...['fleet-manager','runtime-coordinator','windows-agents','native-instance-registry','runtime-switches','tmux-manager','paths','tool-permissions','runtime-general-workspace','general-role'].map(load)]);
assert(getTmuxSocketName()&&getTmuxSocketName()!=='agend');TmuxManager.setSocketName(getTmuxSocketName());
for(const method of ['ensureSession','createWindow','respawnWindow','killWindow','killWindowConfirmed','getPanePid'])TmuxManager.prototype[method]=()=>{throw Error('Forbidden coordinator tmux: '+method);};
const fleet=new FleetManager(home),agents=[],replies=[],progress=[],proofs=new Set(),guards=new Set(),messages=[];
const {Scheduler,DEFAULT_SCHEDULER_CONFIG}=await load('scheduler/index');
fleet.scheduler=new Scheduler(join(home,'scheduler.db'),()=>{throw Error('No scheduled actions');},DEFAULT_SCHEDULER_CONFIG,()=>false); // Own empty DB; no init, timers or jobs.
const actualOutbound=fleet.handleOutboundFromInstance.bind(fleet);
let runner,reader,closed=false,phase='setup',passed=false,cleanup=false,machine,model;
const receipt={...source,...await codeBundleReceipt(bundle),kind:'paired-General-native',scratchCwd:nativeRoot,states:{},archived:[]};
const until=async(check,label,timeout=120000)=>{const end=performance.now()+timeout;while(!await check()){
 assert(!messages.some(m=>m.failed),'Scratch runner failed');assert(!closed,'Scratch runner closed');assert(performance.now()<end,'Deadline: '+label);await new Promise(done=>setTimeout(done,200));}};
const hub=new RuntimeCoordinator(join(home,'hub'),{requestTimeoutMs:45000,handlePaneMcp:async(machineId,body,current)=>(await fleet.nativePanes()).handle(machineId,body,current)});
fleet.runtimeHub=hub;setConfiguredRuntimeSwitches({remote_runtime:true,max_agents_per_machine:4});
fleet.fleetConfig={defaults:{},runtimes:{remote_runtime:true,max_agents_per_machine:4},instances:{}};
const toolCalls=[];
const store=windowsAgentsFor(fleet,{get:()=>null,start(){throw Error('No exec fallback');},prepareWorkspace(){throw Error('No host workspace');}});
fleet.readCliEnv=()=>{throw Error('No coordinator account/catalog probe');};
fleet.localNativePaneEndpoint=()=>{throw Error('General proof requires the paired runtime');};
fleet.syncRoleSkills=()=>{throw Error('No Linux skills written to Windows');};
fleet.cacheInstanceProgress=(name,text)=>progress.push({name,present:!!text});
fleet.handleOutboundFromInstance=async(name,message)=>{
 if(message.tool!=='reply'){assert(['list_teams'].includes(message.tool),'Only read-only General startup and the minimal reply are allowed');return actualOutbound(name,message);}
 const text=message.args?.text??message.payload?.text;assert(/^NATIVE_(CODEX|CLAUDE)_FLEET_OK_(IDLE|WHILE_BUSY|JUST_RESUMED)$/.test(text));
 replies.push({name,text});fleet.instanceIpcClients.get(name).send({type:'fleet_outbound_response',fleetRequestId:message.fleetRequestId,result:{messageId:'scratch-'+randomUUID()}});
};
const server=createServer((req,res)=>{if(req.url==='/scratch-ready'){res.end('ok');return;}if(!hub.handlePublicRequest(req,res,new URL(req.url,'http://localhost'))){res.writeHead(404);res.end();}});
server.on('upgrade',(req,socket,head)=>{if(!hub.handleUpgrade(req,socket,head))socket.destroy();});server.listen(0,'127.0.0.1');await once(server,'listening');
let node;
try{
 await mkdir(root);await cp(bundle,join(root,'bundle'),{recursive:true});await cp('scripts/manual/general-windows/runner.mjs',join(root,'runner.mjs'));
 // Reuse the reviewed exact-ID supported archive/metadata control; it never changes the provider home.
 let archiveWorker=await readFile('scripts/manual/windows-pane-adapter/fleet-native-runner.mjs','utf8');
 const code=win32.join(nativeRoot,'bundle','dist'),base='file:///'+code.replaceAll('\\','/')+'/';
 archiveWorker=archiveWorker.replace(/from'\.\.\/\.\.\/\.\.\/dist\/([^']+)'/g,(_all,file)=>'from'+JSON.stringify(new URL(file,base).href));
 await writeFile(join(root,'archive.mjs'),archiveWorker);
 const ps='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
 const script="[Console]::Write((Get-Command node.exe -CommandType Application | Select-Object -First 1).Source)";
 const nativeNode=execFileSync(ps,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:15000}).trim();
 node=execFileSync('wslpath',['-u',nativeNode],{encoding:'utf8'}).trim();
 runner=spawn(node,[win32.join(nativeRoot,'runner.mjs'),win32.join(nativeRoot,'bundle'),nativeRoot],{shell:false,stdio:['pipe','pipe','pipe']});
 runner.stderr.resume();runner.once('close',()=>{closed=true;});reader=createInterface({input:runner.stdout});reader.on('line',line=>{try{messages.push(JSON.parse(line));}catch{messages.push({failed:true,phase:'invalid-frame'});}});
 phase='pair';const pair=hub.createPairing();runner.stdin.write(JSON.stringify({server:'http://127.0.0.1:'+server.address().port,code:pair.code})+'\n');
 await until(()=>messages.some(row=>row.fingerprint),'fingerprint');const pending=hub.listMachines().filter(row=>row.status==='pending');assert.equal(pending.length,1);
 const fingerprint=messages.find(row=>row.fingerprint).fingerprint;assert.equal(pending[0].pairingFingerprint,fingerprint);hub.approve(pending[0].id,fingerprint);
 await until(()=>messages.some(row=>row.ready),'runner ready');const ready=messages.find(row=>row.ready);machine=ready.machineId;model=ready.model;receipt.versions=ready.versions;assert.equal(ready.junctionRefused,true);receipt.junctionRefused=true;
 await until(()=>hub.machine(machine)?.status==='online'&&hub.machine(machine)?.inventory?.clis.length===2,'cached CLI inventory');
 for(const cli of ['claude-code','codex']){
  phase='publish-'+cli;process.stdout.write('phase:'+phase+'\n');
  const name='native-'+(cli==='codex'?'codex':'claude')+'-proof',bindingId=randomUUID();
  fleet.fleetConfig.instances[name]={working_directory:home,general_topic:true,backend:cli};
  const publication=await fleet.prepareWindowsGeneralWorkspace(name,machine,cli,bindingId,()=>true);
  assert.equal(publication.packHash,loadGeneralKnowledge(cli).hash);assert(publication.cwd.toLowerCase().startsWith(nativeRoot.toLowerCase()+'\\'));
  const workspace=root+publication.cwd.slice(nativeRoot.length).replaceAll('\\','/'),file=cli==='codex'?'AGENTS.md':'CLAUDE.md',skills=cli==='codex'?'.agents':'.claude';
  assert((await readFile(join(workspace,file),'utf8')).includes('# Fleet Coordinator'));
  for(const skill of GENERAL_SKILL_NAMES)assert.equal(await readFile(join(workspace,skills,'skills',skill,'SKILL.md'),'utf8'),loadGeneralKnowledge(cli).files[skills+'/skills/'+skill+'/SKILL.md']);
  const before=createHash('sha256').update(await readFile(join(workspace,'.agend-general.json'))).digest('hex');
  const agent=await store.create({name,cli,cwd:publication.cwd,machineId:machine,sandbox:'read-only',model:cli==='codex'?model:'haiku'});store.bindInstance(agent.id,name);
  const config={...nativeInstanceConfig(agent),general_topic:true,native_general_binding:bindingId,native_adapter:'pane',log_level:'silent',tool_progress:'standard',restart_policy:{max_retries:0,backoff:'linear',reset_after:60000,health_check_interval_ms:1000}};
  assert.equal(resolveToolSet(config,name),'general');fleet.fleetConfig.instances[name]=config;const row={name,agent,config,workspace,manifestHash:before};agents.push(row);
  phase='start-'+cli;process.stdout.write('phase:'+phase+'\n');
  if(!fleet.paneManager){const manager=await fleet.nativePanes(),invoke=manager.options.invoke.bind(manager.options);manager.options.invoke=async(daemon,input,...rest)=>{const result=await invoke(daemon,input,...rest);toolCalls.push({tool:input.tool,failed:!!result.error});return result;};}
  await fleet.startInstance(name,config,true);const daemon=fleet.daemons.get(name);assert(daemon?.usesNativePane());
  for(const method of ['arm','settleToolAttempt']){const original=daemon.turnReplyGuard[method].bind(daemon.turnReplyGuard);daemon.turnReplyGuard[method]=(...args)=>{const value=original(...args);if(daemon.turnReplyGuard.snapshot()?.completionDelivered)guards.add(name);return value;};}
  daemon.on('mcp_tool_response_written',()=>{proofs.add(name);if(daemon.turnReplyGuard.snapshot()?.completionDelivered)guards.add(name);});
  await deliverStates({fleet,row,replies,until});receipt.states[cli]={idle:true,busy:true};
 }
 phase='reattach';const identities=agents.map(row=>({name:row.name,pin:store.get(row.agent.id).threadId,snapshot:fleet.daemons.get(row.name).nativePaneLifecycle.snapshot()}));
 for(const row of agents){const daemon=fleet.daemons.get(row.name);await daemon.stop({nativePane:'detach'});fleet.daemons.delete(row.name);await fleet.instanceIpcClients.get(row.name)?.close();fleet.instanceIpcClients.delete(row.name);}
 fleet.paneManager=null;
 const calls=[],call=hub.callPane.bind(hub);hub.callPane=(id,request,...rest)=>{calls.push(request.action);return call(id,request,...rest);};
 for(const row of agents){await fleet.startInstance(row.name,row.config,true);const same=fleet.daemons.get(row.name).nativePaneLifecycle.snapshot(),old=identities.find(i=>i.name===row.name);
  assert.equal(same.launchId,old.snapshot.launchId);assert.equal(same.hostBootId,old.snapshot.hostBootId);assert.equal(store.get(row.agent.id).threadId,old.pin);
  assert.equal(createHash('sha256').update(await readFile(join(row.workspace,'.agend-general.json'))).digest('hex'),row.manifestHash);}
 assert(!calls.some(action=>['input','key','edit','general-workspace'].includes(action)));receipt.sameLaunchReattachWithoutInputOrPublication=true;
 for(const row of agents){phase='resume-'+row.agent.cli;process.stdout.write('phase:'+phase+'\n');const old=store.get(row.agent.id).threadId;await fleet.stopInstance(row.name);assert(!store.get(row.agent.id).activeId);await fleet.startInstance(row.name,row.config,true);
  assert.equal(store.get(row.agent.id).threadId,old);await deliverStates({fleet,row,replies,until,resumed:true});receipt.states[row.agent.cli].justResumed=true;}
 assert.equal(replies.length,6);assert(agents.every(row=>guards.has(row.name)&&proofs.has(row.name)));assert(progress.some(p=>p.present));
 receipt.replies=6;receipt.replyGuard=true;receipt.progress=true;receipt.fixedSkills=GENERAL_SKILL_NAMES.length;receipt.noExecFallback=true;receipt.noCoordinatorTmux=true;passed=true;
}catch(error){receipt.failure={phase,kind:error.name,reason:String(error.message).slice(0,220)};}
finally{
 receipt.toolCalls=toolCalls;receipt.replyStates=replies.map(r=>({provider:r.name.includes('codex')?'codex':'claude-code',state:r.text.split('_FLEET_OK_')[1]}));
 for(const row of agents){const daemon=fleet.daemons.get(row.name);try{const screen=await daemon.tmux.capturePane();const ds=[...(daemon.backend.getRuntimeDialogs?.()??[]),...(daemon.backend.getStartupDialogs?.()??[])];(receipt.finalScreens??=[]).push({provider:row.agent.cli,ready:daemon.backend.isDeliveryInputReadyPane?.(screen)??daemon.backend.getReadyPattern().test(screen),busy:daemon.backend.getBusyPattern?.()?.test(screen)??false,dialogs:ds.filter(d=>d.pattern.test(screen)&&(!d.isActive||d.isActive(screen))).map(d=>d.description)});}catch{}}
 phase='cleanup';for(const row of [...agents].reverse())await fleet.stopInstance(row.name).catch(()=>{});
 const released=agents.every(row=>!store.get(row.agent.id).activeId);for(const client of fleet.instanceIpcClients.values())await client.close();fleet.memoryPressure?.stop();fleet.scheduler?.shutdown();
 if(released&&machine)await hub.shutdownPaneHosts().catch(()=>{});
 if(runner&&!closed){runner.stdin.write('close\n');runner.stdin.end();await Promise.race([once(runner,'close'),new Promise(done=>setTimeout(done,20000))]);}reader?.close();
 let archived=true;
 if(released&&closed&&node)for(const row of agents.filter(row=>row.agent.cli==='codex')){
  const id=store.get(row.agent.id).threadId;if(!id)continue;
  try{const result=JSON.parse(execFileSync(node,[win32.join(nativeRoot,'archive.mjs'),'archive',nativeRoot,'a'.repeat(64),win32.join(nativeRoot,'bundle','dist'),id],{encoding:'utf8',timeout:30000,maxBuffer:8192,stdio:['ignore','pipe','pipe']}));assert.equal(result.id,id);assert(result.archived||result.unmaterialized);if(result.archived)receipt.archived.push(id);else receipt.unmaterialized=[...(receipt.unmaterialized??[]),id];}catch{archived=false;}
 }
 hub.close();server.closeAllConnections();await new Promise(done=>server.close(done));
 cleanup=released&&closed&&archived;receipt.ownedProcessExit=released&&closed;receipt.passed=passed;receipt.cleaned=cleanup;
 if(cleanup){await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});await rm(home,{recursive:true,force:true});}
 else receipt.retainedScratch=home;
 await writeFile('.artifacts/general-native-receipt.json',JSON.stringify(receipt,null,2)+'\n');process.stdout.write(JSON.stringify(receipt)+'\n',()=>process.exit(passed&&cleanup?0:1));
}
if(!passed||!cleanup)process.exitCode=1;
