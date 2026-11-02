/** Native scratch service/relay for full Daemon acceptance. No credential or raw-pane output is printed. */
import{join,win32}from'node:path';import{execFile}from'node:child_process';import{promisify}from'node:util';
import{findCli,nativeCliEnvironment}from'../../../dist/windows-cli-worker.js';import{createInterface}from'node:readline';
import{startPaneService}from'../../../dist/runtime-pane-service.js';
import{serveLocalPaneRelay}from'../../../dist/runtime-pane-stdio.js';
import{RuntimePaneLink}from'../../../dist/runtime-pane-link.js';
import{readPaneHostDescriptor}from'../../../dist/runtime-pane-private.js';
const[mode,root,scope]=process.argv.slice(2),approved='c:\\users\\changhansung\\agend-adapter-proto';
if(process.platform!=='win32'||!['host','relay','versions'].includes(mode)||!win32.normalize(root||'').toLowerCase().startsWith(approved+'\\')||!/^[a-f0-9]{64}$/.test(scope||''))throw Error('Explicit approved native scratch scope required');
const directory=join(root,'host');
if(mode==='versions'){
 const versions={};for(const provider of ['codex','claude-code']){const cli=await findCli(provider);if(!cli)throw Error('Expected native CLI is unavailable');const result=await promisify(execFile)(cli.command,[...cli.args,'--version'],{cwd:root,env:nativeCliEnvironment(),timeout:10000,maxBuffer:4096,windowsHide:true,shell:false});const version=result.stdout.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0];if(!version)throw Error('Native version not recognized');versions[provider]=version;}process.stdout.write(JSON.stringify(versions)+'\n');
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
