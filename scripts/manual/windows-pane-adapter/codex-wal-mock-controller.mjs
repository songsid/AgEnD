/** #3219 / M-2423 native Windows legs, with NO account: audited Codex in a private CODEX_HOME talking only to a local mock
 * Responses API (vendor egress pointed at a dead proxy). Ordinary FleetManager/Daemon/native pane manager; codex only.
 *  1. a cleanly exited no-turn Codex leaves a non-empty state_5.sqlite-wal on Windows too;
 *  2. its unwritten pin proves absent → exactly one automatic fresh launch, bound to the observed provider UUID;
 *  3. a written session still resumes the same conversation;
 *  4. a written session whose thread row is only in the WAL (rollout moved aside) holds, never an automatic fresh.
 * Usage (from a clean worktree after `npm run build`): node scripts/manual/windows-pane-adapter/codex-wal-mock-controller.mjs dist
 * Receipts hold ids, sizes and booleans only. Everything lives under the approved agend-adapter-proto scratch tree. */
import{sourceReceipt}from'./source-receipt.mjs';
import{spawn,execFileSync}from'node:child_process';import{mkdir,readFile,writeFile,cp,rm,rename,stat,readdir}from'node:fs/promises';import{mkdtempSync,existsSync}from'node:fs';
import{join,resolve,win32}from'node:path';import{pathToFileURL}from'node:url';import{randomUUID,createHash}from'node:crypto';import{createInterface}from'node:readline';import assert from'node:assert/strict';
const source=sourceReceipt(),project=process.cwd(),compiled=resolve(process.argv[2]||'dist'),tag=randomUUID().slice(0,8);
const nativeRoot='C:\\Users\\changhansung\\agend-adapter-proto\\codexwal-'+tag,root='/mnt/c/Users/changhansung/agend-adapter-proto/codexwal-'+tag;
const codexHomeWin=nativeRoot+'\\codex-home',codexHome=root+'/codex-home',workWin=nativeRoot+'\\work',PORT=18000+Math.floor(Math.random()*2000);
const coordinator=mkdtempSync(join(project,'.artifacts/codex-wal-proof-'));process.env.AGEND_HOME=coordinator;
for(const k of ['NOTIFY_SOCKET','WATCHDOG_USEC','WATCHDOG_PID','TMUX'])delete process.env[k];process.env.AGEND_TMUX_SESSION='codexwal-'+tag;
const load=name=>import(pathToFileURL(join(compiled,name)).href);
const[{FleetManager},{windowsAgentsFor},{nativeInstanceConfig},{setConfiguredRuntimeSwitches},{LocalPaneEndpoint},{createRuntimeBundle},{TmuxManager},{getTmuxSocketName},{nativeCliEnvironment}]=await Promise.all(['fleet-manager.js','windows-agents.js','native-instance-registry.js','runtime-switches.js','local-pane-endpoint.js','runtime-bundle.js','tmux-manager.js','paths.js','windows-cli-worker.js'].map(load));
const{withNativePaneVerification}=await load('runtime-pane-native.js');
assert(getTmuxSocketName()&&getTmuxSocketName()!=='agend');TmuxManager.setSocketName(getTmuxSocketName());
for(const method of ['ensureSession','createWindow','respawnWindow','killWindow','killWindowConfirmed','getPanePid'])if(typeof TmuxManager.prototype[method]==='function')TmuxManager.prototype[method]=()=>{throw Error('Forbidden coordinator tmux boundary: '+method);};
const receipt={...source,kind:'codex-wal-mock-native',scratchTag:tag,noAccount:true,mockOnly:true,legs:{},archived:[],unmaterialized:[]};
const log=line=>process.stdout.write(line+'\n');
// ── stage the runtime and the private provider home ─────────────────────────────────────────────
await mkdir(join(root,'LocalData'),{recursive:true});await mkdir(codexHome);await mkdir(root+'/work');await mkdir(root+'/held');
const toml=s=>"'"+s+"'";
await writeFile(codexHome+'/config.toml',[`model = "mock-model"`,`model_provider = "mock"`,`check_for_update_on_startup = false`,
 `[model_providers.mock]`,`name = "mock"`,`base_url = "http://127.0.0.1:${PORT}/v1"`,`wire_api = "responses"`,`requires_openai_auth = false`,
 `[projects.${toml(workWin)}]`,`trust_level = "trusted"`,`[projects.${toml(workWin.toLowerCase())}]`,`trust_level = "trusted"`,''].join('\n'));
const scope=createHash('sha256').update(coordinator).digest('hex'),bundle=createRuntimeBundle({moduleDirectory:compiled,licensePath:join(project,'LICENSE'),packageVersion:'2.3.5-alpha.0'});
await writeFile(join(root,'runtime.zip'),bundle.bytes);await cp(join(compiled,'local-pane-stage.ps1'),join(root,'stage.ps1'));
const quote=v=>"'"+v.replaceAll("'","''")+"'",ps=code=>execFileSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{encoding:'utf8',timeout:120000,maxBuffer:8192,stdio:['ignore','pipe','pipe']});
const staged=JSON.parse(ps(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $env:LOCALAPPDATA=${quote(nativeRoot+'\\LocalData')}; & ${quote(nativeRoot+'\\stage.ps1')} -Archive ${quote(nativeRoot+'\\runtime.zip')} -Sha256 ${quote(bundle.sha256)} -Scope ${quote(scope)}`));
assert(staged.relay.startsWith(nativeRoot+'\\'));const windowsCode=win32.dirname(staged.relay),node=execFileSync('wslpath',['-u',staged.node],{encoding:'utf8'}).trim();
let runner=await readFile(join(project,'scripts/manual/windows-pane-adapter/fleet-native-runner.mjs'),'utf8');const base='file:///'+windowsCode.replaceAll('\\','/')+'/';
runner=runner.replace(/from'\.\.\/\.\.\/\.\.\/dist\/([^']+)'/g,(_a,file)=>'from'+JSON.stringify(new URL(file,base).href));await writeFile(join(root,'acceptance-native-runner.mjs'),runner);
// The private provider home and the egress block reach the host, its CLI workers and the runner's own proof through
// the ordinary allowed environment (CODEX_HOME, proxies). Set before the runner module runs.
const envPrelude=`process.env.CODEX_HOME=${JSON.stringify(codexHomeWin)};process.env.HTTPS_PROXY=process.env.HTTP_PROXY=process.env.ALL_PROXY='http://127.0.0.1:9';process.env.NO_PROXY='127.0.0.1,localhost';\n`;
await writeFile(join(root,'private-runner.mjs'),envPrelude+`await import('./acceptance-native-runner.mjs');\n`);
await cp(join(project,'scripts/manual/codex-version-audit/mock.mjs'),join(root,'mock.mjs'));
await writeFile(join(root,'mock-runner.mjs'),`process.stdin.on('end',()=>process.exit(0));process.stdin.on('close',()=>process.exit(0));process.stdin.resume();await import('./mock.mjs');\n`);
await writeFile(join(root,'mode'),'ok');
const run=(mode,...rest)=>execFileSync(node,[win32.join(nativeRoot,'private-runner.mjs'),mode,nativeRoot,scope,windowsCode,...rest],{cwd:project,env:nativeCliEnvironment(),encoding:'utf8',timeout:60000,maxBuffer:65536,stdio:['ignore','pipe','pipe']});
const native=mode=>spawn(node,[win32.join(nativeRoot,'private-runner.mjs'),mode,nativeRoot,scope,windowsCode],{shell:false,stdio:['pipe','pipe','pipe'],env:nativeCliEnvironment()});
const inventory=JSON.parse(run('versions'));receipt.versions={codex:inventory.codex};assert.equal(inventory.codex,'0.165.0');
// ── mock and host ────────────────────────────────────────────────────────────────────────────────
const mock=spawn(node,[win32.join(nativeRoot,'mock-runner.mjs')],{shell:false,stdio:['pipe','ignore','pipe'],env:{...nativeCliEnvironment(),PORT:String(PORT),MOCK_MODE_FILE:nativeRoot+'\\mode',MOCK_LOG:nativeRoot+'\\mock.log',WSLENV:'PORT/w:MOCK_MODE_FILE/w:MOCK_LOG/w'}});
let mockClosed=false;mock.once('close',()=>{mockClosed=true;});
const until=async(check,what,timeout=90000)=>{const end=Date.now()+timeout;for(;;){if(await check())return;if(Date.now()>=end)throw Error('deadline: '+what);await new Promise(r=>setTimeout(r,250));}};
await until(async()=>{try{return (await readFile(root+'/mock.log','utf8')).includes('listening '+PORT);}catch{return false;}},'mock listening',20000);
const host=native('host'),hostLines=createInterface({input:host.stdout});let hostClosed=false;host.once('close',()=>{hostClosed=true;});
await new Promise((ok,fail)=>{const t=setTimeout(()=>fail(Error('host start deadline')),120000);hostLines.once('line',l=>{clearTimeout(t);try{assert.deepEqual(JSON.parse(l),{ready:true});ok();}catch(e){fail(e);}});host.once('close',()=>{clearTimeout(t);fail(Error('host exited early'));});});
// ── ordinary fleet, codex only ───────────────────────────────────────────────────────────────────
const fleet=new FleetManager(coordinator),relays=[],notices=[];let rpcInput=0;
const store=windowsAgentsFor(fleet,{start(){throw Error('Exec fallback is forbidden');},get:()=>null,prepareWorkspace:async()=>nativeRoot});
setConfiguredRuntimeSwitches({windows_cli:true,max_agents_per_machine:4});fleet.fleetConfig={defaults:{},runtimes:{windows_cli:true,max_agents_per_machine:4},instances:{}};
const versions=new Map([['codex','0.165.0']]);
fleet.localNativePaneEndpoint=async()=>{const current=relays.at(-1);if(current?.online())return current;const endpoint=await LocalPaneEndpoint.open({scope,admit:()=>{if(fleet.shuttingDown)throw Error('stopping');},maxAgents:()=>4,version:p=>versions.get(p)||null,launch:async()=>native('relay'),mcp:async(body,cur)=>(await fleet.nativePanes()).handle('local',body,cur)});const call=endpoint.call.bind(endpoint);endpoint.call=async req=>{if(req.action==='input'||req.action==='key'||req.action==='edit')rpcInput++;return call(req);};relays.push(endpoint);return endpoint;};
fleet.syncRoleSkills=()=>{throw Error('No Linux skills in Windows cwd');};fleet.readCliEnv=()=>{throw Error('No coordinator provider account');};
fleet.notifyInstanceTopic=async(_n,text)=>{notices.push(text);};
const name='native-codex-wal-proof',agent=await store.create({name,cli:'codex',cwd:workWin,sandbox:'read-only'});store.bindInstance(agent.id,name);
const config={...nativeInstanceConfig(agent),native_adapter:'pane',log_level:'silent',restart_policy:{max_retries:0,backoff:'linear',reset_after:60000,health_check_interval_ms:1000}};
fleet.fleetConfig.instances[name]=config;
const ids=new Set(),pin=()=>{const id=store.get(agent.id).threadId;if(id)ids.add(id);return id;};
const intent=async()=>JSON.parse(await readFile(join(coordinator,'native-panes',agent.id,'active.json'),'utf8'));
const walSize=async()=>{try{return (await stat(codexHome+'/state_5.sqlite-wal')).size;}catch{return 0;}};
const rollouts=async()=>{const out=[];const walk=async d=>{let rows;try{rows=await readdir(d,{withFileTypes:true});}catch{return;}for(const r of rows){if(r.isDirectory())await walk(d+'/'+r.name);else if(r.name.endsWith('.jsonl'))out.push(d+'/'+r.name);}};await walk(codexHome+'/sessions');return out;};
const{coherentSqliteWal}=await load('runtime-pane-codex-index.js');
// Shape only (frame counts per generation), read from a copy of the WAL bytes; nothing is written back.
const walShape=async()=>{const b=await readFile(codexHome+'/state_5.sqlite-wal'),frame=24+b.readUInt32BE(8),n=(b.length-32)/frame;let current=0,commits=0;for(let i=0;i<n;i++){const at=32+i*frame;if(b.readUInt32BE(at+8)===b.readUInt32BE(16)&&b.readUInt32BE(at+12)===b.readUInt32BE(20)){current++;if(b.readUInt32BE(at+4))commits++;}}return{frames:n,currentGeneration:current,commits,coherent:coherentSqliteWal(b)};};
let passed=false,phase='start';
try{
 // Leg 1+2: no-turn pin, clean stop, then the automatic fresh.
 phase='leg2-first-start';log('phase:'+phase);await fleet.startInstance(name,config,true);const original=pin();assert(original);
 // cc3ce4fe (#3243): the version the helper recorded for this launch, and the agent's status label from it.
 { const st=fleet.getUiStatus().instances.find(x=>x.name===name)??{};
   receipt.legs.label={launchedVersion:fleet.daemons.get(name).nativePaneCliVersion()??null,statusVersion:st.native_cli_version??null,verification:st.native_cli_verification??null,
     inventoryLabel:withNativePaneVerification({clis:[{id:'codex',version:inventory.codex}]}).clis[0].paneVerification}; }
 await until(()=>fleet.daemons.get(name)?.nativePauseReady(),'idle before stop',60000);await fleet.stopInstance(name);assert(!store.get(agent.id).activeId);
 receipt.legs.wal={walBytesAfterCleanExit:await walSize(),rollouts:(await rollouts()).length,...await walShape()};assert.equal(receipt.legs.wal.coherent,true,'Windows Codex WAL is not fully current-generation and committed');assert(receipt.legs.wal.walBytesAfterCleanExit>0,'Windows Codex left no WAL');assert.equal(receipt.legs.wal.rollouts,0);
 if(process.env.UNVERIFIED==='1'){
  // A local build that does not list this version as audited: the absence proof is only unknown → held, no fresh.
  phase='unverified-absence';log('phase:'+phase);const noticesBefore=notices.length;
  await assert.rejects(fleet.startInstance(name,config,true),e=>e.name==='NativePaneRecoveryError'&&e.recovery?.kind==='session-unconfirmed');
  assert.equal(pin(),original);assert.equal(store.get(agent.id).activeId,undefined);assert.equal(notices.length,noticesBefore);
  receipt.legs.unverifiedAbsence={held:true,noAutomaticFresh:true,pinKept:true};
 } else {
 phase='leg2-automatic-fresh';log('phase:'+phase);const noticesBefore=notices.length;
 await fleet.startInstance(name,config,true);const fresh=pin(),i=await intent(),snap=fleet.daemons.get(name).nativePaneLifecycle.snapshot();
 assert(fresh&&fresh!==original);assert.equal(i.fresh?.automatic,true);assert.equal(i.fresh.previous.sessionId,original);assert.equal(i.fresh.sessionId,fresh);
 assert.equal(snap.sessionId,fresh,'bound to the UUID the pane reported');assert.notEqual(fresh,snap.launchId);
 assert.equal(notices.length-noticesBefore,1);assert.match(notices.at(-1),/^Windows Codex had no saved conversation/);
 receipt.legs.absentFresh={originalPin:original,freshPin:fresh,automatic:true,boundToObservedUuid:true,notices:1};
 // Leg 3: a written session resumes.
 phase='leg3-turn';log('phase:'+phase);await until(()=>fleet.daemons.get(name)?.nativePauseReady(),'idle before turn',60000);
 assert(await fleet.deliverToInstance(name,{type:'fleet_inbound',content:'Reply with OK. Do not use tools.',meta:{source:'user',adapter_id:'private-acceptance',chat_id:'private-chat',thread_id:name,message_id:randomUUID(),user:'private-person',runtime:'native-proof'}}));
 await until(async()=>(await rollouts()).some(p=>p.endsWith('-'+fresh+'.jsonl')),'rollout for the fresh session',90000);
 await until(()=>fleet.daemons.get(name)?.nativePauseReady(),'idle after turn',90000);
 phase='leg3-resume';log('phase:'+phase);const launchBefore=fleet.daemons.get(name).nativePaneLifecycle.snapshot().launchId,noticesMid=notices.length;
 await fleet.stopInstance(name);await fleet.startInstance(name,config,true);const after=fleet.daemons.get(name).nativePaneLifecycle.snapshot();
 assert.notEqual(after.launchId,launchBefore);assert.equal(after.sessionId,fresh);assert.equal(pin(),fresh);assert.equal(notices.length,noticesMid);
 receipt.legs.writtenResumes={sessionId:fresh,newLaunch:true,sameSession:true,noNotice:true};
 // Leg 4: the row only in the WAL holds.
 phase='leg4-wal-only';log('phase:'+phase);await until(()=>fleet.daemons.get(name)?.nativePauseReady(),'idle before stop',60000);await fleet.stopInstance(name);
 const rollout=(await rollouts()).find(p=>p.endsWith('-'+fresh+'.jsonl'));const held=root+'/held/'+rollout.split('/').at(-1);await rename(rollout,held);
 const walOnly={walBytes:await walSize(),...await walShape()};
 await assert.rejects(fleet.startInstance(name,config,true),e=>e.name==='NativePaneRecoveryError'&&e.recovery?.kind==='session-unconfirmed');
 assert.equal(pin(),fresh);assert.equal(store.get(agent.id).activeId,undefined);walOnly.held=true;walOnly.noAutomaticFresh=true;
 await rename(held,rollout);
 try{await fleet.startInstance(name,config,true);walOnly.afterRestoreResumed=fleet.daemons.get(name)?.nativePaneLifecycle.snapshot().sessionId===fresh;}catch(e){walOnly.afterRestore=e.name+':'+(e.recovery?.kind??'');}
 receipt.legs.walOnlyRow=walOnly;
 }
 passed=true;
}catch(error){receipt.error=String(error?.message??error).replace(/[A-Z]:\\[^\s'"]+/g,'[path]').slice(0,300);}
finally{
 receipt.phase=phase;receipt.inputRpcs=rpcInput;
 await fleet.stopInstance(name).catch(()=>{});const closeConfirmed=!store.get(agent.id).activeId;
 for(const e of relays)e.stop();for(const c of fleet.instanceIpcClients.values())await c.close();fleet.memoryPressure?.stop();
 host.stdin.write('stop\n');host.stdin.end();await until(()=>hostClosed,'host close',30000).catch(()=>{});hostLines.close();
 for(const id of ids){try{const r=JSON.parse(run('archive',id));if(r.archived)receipt.archived.push(id);else receipt.unmaterialized.push(id);}catch{receipt.archiveUnconfirmed=true;}}
 mock.stdin.end();await until(()=>mockClosed,'mock close',15000).catch(()=>{});
 Object.assign(receipt,{passed,positiveOwnedClose:closeConfirmed,hostClosed,mockClosed,bundleSha256:bundle.sha256});
 const clean=closeConfirmed&&hostClosed&&mockClosed&&!receipt.archiveUnconfirmed;
 if(clean){await rm(coordinator,{recursive:true,force:true});await rm(root,{recursive:true,force:true});receipt.scratchRemoved=!existsSync(root);}else receipt.retainedScratchForOwnedCleanup=true;
 await writeFile(join(project,'.artifacts/codex-wal-native-receipt.json'),JSON.stringify(receipt,null,2)+'\n');log(JSON.stringify(receipt));
 process.exitCode=passed&&clean?0:1;
}
