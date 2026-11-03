/** Native scratch service/relay for full Daemon acceptance. No credential or raw-pane output is printed. */
import{join,win32}from'node:path';import{execFile}from'node:child_process';import{promisify}from'node:util';
import{findCli,nativeCliEnvironment,readNativeCodexModels}from'../../../dist/windows-cli-worker.js';import{createInterface}from'node:readline';
import{startPaneService}from'../../../dist/runtime-pane-service.js';
import{serveLocalPaneRelay}from'../../../dist/runtime-pane-stdio.js';
import{RuntimePaneLink}from'../../../dist/runtime-pane-link.js';
import{readPaneHostDescriptor}from'../../../dist/runtime-pane-private.js';
import{runtimeJobDigest}from'../../../dist/runtime-client-store.js';
import{existsSync}from'node:fs';
const[mode,root,scope,codeRoot,sessionId]=process.argv.slice(2),approved='c:\\users\\changhansung\\agend-adapter-proto';
if(process.platform!=='win32'||!['host','relay','versions','detached-empty','archive'].includes(mode)||!win32.normalize(root||'').toLowerCase().startsWith(approved+'\\')||!/^[a-f0-9]{64}$/.test(scope||''))throw Error('Explicit approved native scratch scope required');
const directory=join(root,'LocalData','AgEnD','pane-adapter',scope.slice(0,16),'state','pane-host');
if(mode==='versions'){
 const versions={};for(const provider of ['codex','claude-code']){const cli=await findCli(provider);if(!cli)throw Error('Expected native CLI is unavailable');const result=await promisify(execFile)(cli.command,[...cli.args,'--version'],{cwd:root,env:nativeCliEnvironment(),timeout:10000,maxBuffer:4096,windowsHide:true,shell:false});const version=result.stdout.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0];if(!version)throw Error('Native version not recognized');versions[provider]=version;}const codexModels=readNativeCodexModels().map(row=>row.id).filter(id=>/^gpt-[0-9][a-z0-9.-]{0,80}$/i.test(id)).slice(0,64);process.stdout.write(JSON.stringify({...versions,codexModels})+'\n');
}else if(mode==='archive'){
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sessionId||''))throw Error('Expected exact scratch session id');
 const cli=await findCli('codex');if(!cli)throw Error('Native Codex unavailable');
 const result=await promisify(execFile)(cli.command,[...cli.args,'-c','check_for_update_on_startup=false','archive',sessionId],{cwd:root,env:nativeCliEnvironment(),timeout:25000,maxBuffer:4096,windowsHide:true,shell:false});
 if(!result.stdout.includes('Archived session '+sessionId+'.'))throw Error('Scratch session archive unconfirmed');
 process.stdout.write(JSON.stringify({id:sessionId,archived:true})+'\n');
}else if(mode==='detached-empty'){
 // No CLI is opened. This proves the actual detached production host launch/reconnect in a unique private scope.
 if(!codeRoot||!win32.normalize(codeRoot).toLowerCase().startsWith(win32.normalize(root).toLowerCase()+'\\'))throw Error('Expected immutable scratch code scope missing');
 const state=join(root,'production-state'),server='http://127.0.0.1',hostScope=runtimeJobDigest({server,machineId:scope});
 if(existsSync(state))throw Error('Detached proof requires a fresh scratch state');
 const options={directory:state,server,machineId:scope,online:()=>true,maxAgents:()=>4};
 let descriptor,first,link,proven=false;const inspect=async pid=>{
  const script=`$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ProcessId,CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
  const result=await promisify(execFile)(join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:15000,maxBuffer:8192,windowsHide:true,shell:false});
  return JSON.parse(result.stdout);
 };
 let reattached=false,closed=false;
 try{
  link=await RuntimePaneLink.open(options);descriptor=readPaneHostDescriptor(join(state,'pane-host'),hostScope);if(!descriptor)throw Error('Detached host proof missing');
  first=await inspect(descriptor.pid);const normalize=text=>String(text).replaceAll('/','\\').toLowerCase();
  if(first.ProcessId!==descriptor.pid||normalize(first.ExecutablePath)!==normalize(process.execPath)||!normalize(first.CommandLine).includes(normalize(join(codeRoot,'runtime-pane-service.js')))||!first.CommandLine.includes(hostScope)||!normalize(first.CommandLine).includes(normalize(state)))throw Error('Detached host ownership not proven');proven=true;
  const before=await link.request({action:'list'});if(before.panes.length)throw Error('Fresh detached host unexpectedly has panes');
  await link.stop();link=await RuntimePaneLink.open(options);const after=await link.request({action:'list'});reattached=before.hostBootId===after.hostBootId&&after.hostBootId===descriptor.hostBootId&&after.panes.length===0;if(!reattached)throw Error('Detached host reattachment differs');
 }finally{
  await link?.stop();
  if(descriptor&&first&&proven){const current=await inspect(descriptor.pid);if(current.ProcessId!==first.ProcessId||current.CreationDate!==first.CreationDate||current.CommandLine!==first.CommandLine||current.ExecutablePath!==first.ExecutablePath)throw Error('Detached host identity changed; no signal sent');
   // Only our freshly authenticated, command/birth-verified empty scratch host. Never a CLI or shared fleet process.
   process.kill(descriptor.pid,'SIGTERM');const until=performance.now()+15000;while(performance.now()<until){try{process.kill(descriptor.pid,0);}catch(error){if(error.code==='ESRCH'){closed=true;break;}throw error;}await new Promise(done=>setTimeout(done,50));}
  }
 }
 process.stdout.write(JSON.stringify({kind:'production-detached-empty',reattached,positiveOwnedHostExit:closed,noCliOrAccountCalls:true})+'\n');if(!reattached||!closed)process.exitCode=1;
}else if(mode==='host'){
 const service=await startPaneService({directory,scope}),input=createInterface({input:process.stdin});let closing=false;
 const close=()=>{if(closing)return;closing=true;void service.close().then(()=>{input.close();process.stdin.destroy();process.exitCode=0;},()=>{process.exitCode=1;});};
 input.on('line',line=>{if(line==='stop')close();else{process.exitCode=1;close();}});input.on('close',close);process.stdin.once('end',close);process.stdout.write('{"ready":true}\n');
}else{
 serveLocalPaneRelay(process.stdin,process.stdout,async options=>{
  const descriptor=readPaneHostDescriptor(directory,scope);if(!descriptor)throw Error('Owned scratch service not ready');
  return RuntimePaneLink.attach(descriptor,options);
 });
}
