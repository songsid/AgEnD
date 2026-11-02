/** Two inert CLI-shaped Node fixtures through the production runner/helper/ConPTY path. No accounts or fleet. */
import { mkdir, mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { dirname, join, delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
const bundle=process.argv[2],scratch=process.argv[3];
if(process.platform!=='win32'||!bundle||!scratch||!/agend-adapter-proto/i.test(scratch))throw Error('Native Windows Node and approved prototype scratch required');
const {RuntimePaneHost}=await import(pathToFileURL(join(bundle,'dist/runtime-pane-host.js')).href);
const {RuntimePaneStore}=await import(pathToFileURL(join(bundle,'dist/runtime-pane-store.js')).href);
const {startPaneService}=await import(pathToFileURL(join(bundle,'dist/runtime-pane-service.js')).href);
const {RuntimePaneLink}=await import(pathToFileURL(join(bundle,'dist/runtime-pane-link.js')).href);
const {findCli}=await import(pathToFileURL(join(bundle,'dist/windows-cli-worker.js')).href);
const {persistentNativeArguments,nativePaneCommandLineLength}=await import(pathToFileURL(join(bundle,'dist/runtime-pane-native.js')).href);
const root=await mkdtemp(join(scratch,'stage2-'));
const bin=join(root,'bin'), script=join(bin,'node_modules','@openai','codex','bin','codex.js');
await mkdir(dirname(script),{recursive:true});
await writeFile(script,`process.getBuiltinModule('node:fs').writeFileSync(process.getBuiltinModule('node:path').join(process.cwd(),'.inert-started'),'started');
const role=process.argv.slice(2).find(a=>a.startsWith('developer_instructions=')),instructions=role?JSON.parse(role.slice('developer_instructions='.length)):'',label=/Agent (one|two) only/.exec(instructions)?.[1]||process.cwd().split(/[/\\\\]/).pop();
process.stdin.setRawMode(true);process.stdout.write('\\x1b[?2004h\\x1b[2J\\x1b[HREADY '+label+' 中文 😀\\r\\n');
if(role)process.stdout.write('ROLE '+process.getBuiltinModule('node:crypto').createHash('sha256').update(instructions).digest('hex')+'\\r\\n');
let input='';process.stdin.on('data',b=>{const t=b.toString();input+=t;if(input.includes('SHUTDOWN_FIXTURE'))process.exit(0);process.stdout.write('INPUT '+JSON.stringify(t)+'\\r\\n');});`);
await writeFile(join(bin,'codex.cmd'),'@echo off\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
// No installed CLI or credential directory is visible to findCli. Only the known scratch npm shim may be selected.
process.env.PATH=[bin,dirname(process.execPath),join(process.env.SystemRoot||'C:\\Windows','System32')].join(delimiter);
for(const key of ['USERPROFILE','HOME','APPDATA','LOCALAPPDATA','CODEX_HOME','CLAUDE_CONFIG_DIR'])process.env[key]=root;
const executable=await findCli('codex');assert.equal(executable?.path.toLowerCase(),join(bin,'codex.cmd').toLowerCase(),'Only the inert CLI shim may be selected');
const store=new RuntimePaneStore(join(root,'profile'));
const host=new RuntimePaneHost({store,bootId:randomUUID(),online:()=>true,maxAgents:()=>4});
const until=async check=>{const end=performance.now()+20000;while(!await check()){if(performance.now()>end)throw Error('Native fixture deadline');await new Promise(r=>setTimeout(r,25));}};
const call=(pane,action,fields={})=>host.request({action,paneId:pane.paneId,launchId:pane.launchId,...fields});
let receipt;const runners=[];
try{
 const panes=[],launchMs=[];
 const commonCwd=join(root,'common-workspace');await mkdir(commonCwd);
 for(const label of ['one','two']){
  const cwd=commonCwd;
  const instructions='Agent '+label+' only 中文 "quoted" \\ backslash\nnext line';
  const launch={paneId:randomUUID(),agentId:randomUUID(),instance:'fixture-'+label,cli:'codex',cwd,sandbox:'read-only',columns:100,rows:24,instructions};
  const started=performance.now();const pane=await host.request({action:'open',operationId:randomUUID(),launch});panes.push(pane);launchMs.push(Math.round(performance.now()-started));
  await until(async()=>(await call(pane,'capture')).text.includes('READY '+label+' 中文 😀'));
  await until(async()=>(await call(pane,'capture')).text.includes('ROLE '+createHash('sha256').update(instructions).digest('hex')));
 }
 await assert.rejects(()=>access(join(commonCwd,'AGENTS.md')));
 await call(panes[0],'input',{operationId:randomUUID(),sequence:1,kind:'paste',text:'literal 中文\nline2'});
 await until(async()=>(await call(panes[0],'capture')).text.includes('literal 中文'));
 assert(!(await call(panes[1],'capture')).text.includes('literal 中文'));
 await call(panes[0],'resize',{operationId:randomUUID(),sequence:2,columns:80,rows:30});
 await call(panes[0],'input',{operationId:randomUUID(),sequence:3,kind:'literal',text:'SHUTDOWN_FIXTURE'});
 await until(()=>host.list().find(p=>p.paneId===panes[0].paneId).state==='exited');
 assert.equal(host.list().find(p=>p.paneId===panes[0].paneId).exitCode,0);
 const cancelled=await call(panes[1],'close',{operationId:randomUUID(),sequence:1});assert.equal(cancelled.state,'exited');
 const oversizedCwd=join(root,'oversized');await mkdir(oversizedCwd);const oversized={paneId:randomUUID(),agentId:randomUUID(),instance:'fixture-oversized',cli:'codex',cwd:oversizedCwd,sandbox:'read-only',columns:100,rows:24,instructions:'x'.repeat(31000)};
 const commandLength=nativePaneCommandLineLength(executable.command,[...executable.args,...persistentNativeArguments(oversized)]);assert(commandLength>30000&&commandLength<32766,'Exercise the installer guard, below the OS hard limit');
 await assert.rejects(()=>host.request({action:'open',operationId:randomUUID(),launch:oversized}));
 await until(()=>host.list().find(p=>p.paneId===oversized.paneId)?.state==='exited');
 await assert.rejects(()=>access(join(oversizedCwd,'.inert-started'))); // Failed before even the inert CLI began.
 const service=await startPaneService({directory:join(root,'private-host'),scope:'a'.repeat(64)});
 try {
  const clientScript=join(root,'inert-client.mjs'),clientCwd=join(root,'client-crash');await mkdir(clientCwd);
  const clientLaunch={paneId:randomUUID(),agentId:randomUUID(),instance:'fixture-client-crash',cli:'codex',cwd:clientCwd,sandbox:'read-only',columns:100,rows:24};
  const clientOpen={action:'open',operationId:randomUUID(),launch:clientLaunch};
  await writeFile(clientScript,`import {readFileSync} from 'node:fs';import {RuntimePaneLink} from ${JSON.stringify(pathToFileURL(join(bundle,'dist/runtime-pane-link.js')).href)};
const descriptor=JSON.parse(readFileSync(${JSON.stringify(join(root,'private-host','host.json'))},'utf8'));
const client=await RuntimePaneLink.attach(descriptor,{online:()=>true,maxAgents:()=>4});
const pane=await client.request(${JSON.stringify(clientOpen)});process.stdout.write(JSON.stringify(pane)+String.fromCharCode(10));`);
  const client=spawn(process.execPath,[clientScript],{cwd:root,env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']});runners.push(client);
  client.stderr.resume();const lines=createInterface({input:client.stdout});
  const [line]=await Promise.race([once(lines,'line'),new Promise((_,reject)=>setTimeout(()=>reject(Error('Private client deadline')),30000).unref())]);
  const before=JSON.parse(line),closed=once(client,'close');client.kill();await closed;lines.close();
  const replacement=await RuntimePaneLink.attach(service.descriptor,{online:()=>true,maxAgents:()=>4});
  try {
   const after=await replacement.request(clientOpen);assert.equal(after.launchId,before.launchId);assert.equal(after.hostBootId,before.hostBootId);
   await until(async()=>(await replacement.request({action:'capture',paneId:after.paneId,launchId:after.launchId})).text.includes('READY client-crash'));
   await replacement.retireOwned();const retired=await replacement.request({action:'snapshot',paneId:after.paneId,launchId:after.launchId});assert.equal(retired.state,'exited');await assert.rejects(()=>replacement.request({action:'open',launch:clientLaunch,operationId:randomUUID()}));
  }finally{await replacement.stop();}
 }finally{await service.close();}
 const crashProfile=join(root,'crash-profile'),runner=join(root,'inert-runner.mjs'),crashCwd=join(root,'crash');await mkdir(crashCwd);
 const crashLaunch={paneId:randomUUID(),agentId:randomUUID(),instance:'fixture-crash',cli:'codex',cwd:crashCwd,sandbox:'read-only',columns:100,rows:24};
 await writeFile(runner,`import {RuntimePaneHost} from ${JSON.stringify(pathToFileURL(join(bundle,'dist/runtime-pane-host.js')).href)};
import {RuntimePaneStore} from ${JSON.stringify(pathToFileURL(join(bundle,'dist/runtime-pane-store.js')).href)};
const host=new RuntimePaneHost({store:new RuntimePaneStore(${JSON.stringify(crashProfile)}),bootId:${JSON.stringify(randomUUID())},online:()=>true,maxAgents:()=>4});
const pane=await host.request({action:'open',operationId:${JSON.stringify(randomUUID())},launch:${JSON.stringify(crashLaunch)}});
process.stdout.write(JSON.stringify(pane)+String.fromCharCode(10));setInterval(()=>{},1000);`);
 const child=spawn(process.execPath,[runner],{cwd:root,env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 runners.push(child);let childErrors='';child.stderr.on('data',part=>{childErrors+=part.toString().slice(0,2048);});const lines=createInterface({input:child.stdout});
 const ready=await Promise.race([once(lines,'line'),new Promise((_,reject)=>setTimeout(()=>reject(Error('Crash fixture startup deadline: '+childErrors)),20000).unref())]);
 const old=JSON.parse(ready[0]);
 const closed=once(child,'close');child.kill();await closed;lines.close(); // only our directly owned inert runner handle
 await until(()=>{const recovered=new RuntimePaneStore(crashProfile);recovered.recoverInterrupted();return recovered.get(old.paneId)?.snapshot.state==='exited';});
 const resumedStore=new RuntimePaneStore(crashProfile),resumedHost=new RuntimePaneHost({store:resumedStore,bootId:randomUUID(),online:()=>true,maxAgents:()=>4});
 const resumed=await resumedHost.request({action:'open',operationId:randomUUID(),launch:{...crashLaunch,paneId:randomUUID(),sessionId:randomUUID()}});
 await resumedHost.request({action:'close',paneId:resumed.paneId,launchId:resumed.launchId,operationId:randomUUID(),sequence:1});await resumedHost.stop();
 receipt={passed:true,stage:2,kind:'production host+worker; inert CLI-shaped fixtures, no coding CLI/account',platform:process.platform,node:process.version,
  panes:2,launchMs,launchMeasurement:"first+second inert CLI opens, no cache flush or AV changes",unicode:true,perAgentInstructions:true,sameCwdRoleIsolation:true,commandLineLimitBeforeCli:true,bracketedPaste:true,independentScreens:true,resize:true,naturalExit:true,ownedCancellation:true,positiveHelperExit:true,explicitEnrollmentRetirement:true,connectionClientCrashReattach:true,sameHostAndCliAfterClientCrash:true,privateCurrentUserAcl:true,runnerDeathExitReceipt:true,restartAdmissionFromExitProof:true};
}finally{
 await host.stop();
 for(const child of runners)if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'close');child.kill();await closed;}
 await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
// Deliberately no process.exit: helper/native handles must not keep this runner alive.
process.stdout.write(JSON.stringify(receipt)+'\n');
