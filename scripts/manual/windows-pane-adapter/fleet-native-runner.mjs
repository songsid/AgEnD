/** Native scratch service/relay for full Daemon acceptance. No credential or raw-pane output is printed. */
import{join,win32}from'node:path';import{createInterface}from'node:readline';
import{startPaneService}from'../../../dist/runtime-pane-service.js';
import{serveLocalPaneRelay}from'../../../dist/runtime-pane-stdio.js';
import{RuntimePaneLink}from'../../../dist/runtime-pane-link.js';
import{readPaneHostDescriptor}from'../../../dist/runtime-pane-private.js';
const[mode,root,scope]=process.argv.slice(2),approved='c:\\users\\changhansung\\agend-adapter-proto';
if(process.platform!=='win32'||!['host','relay'].includes(mode)||!win32.normalize(root||'').toLowerCase().startsWith(approved+'\\')||!/^[a-f0-9]{64}$/.test(scope||''))throw Error('Explicit approved native scratch scope required');
const directory=join(root,'host');
if(mode==='host'){
 const service=await startPaneService({directory,scope}),input=createInterface({input:process.stdin});let closing=false;
 const close=()=>{if(closing)return;closing=true;void service.close().then(()=>{input.close();process.stdin.destroy();process.exitCode=0;},()=>{process.exitCode=1;});};
 input.on('line',line=>{if(line==='stop')close();else{process.exitCode=1;close();}});input.on('close',close);process.stdin.once('end',close);process.stdout.write('{"ready":true}\n');
}else{
 serveLocalPaneRelay(process.stdin,process.stdout,async options=>{
  const descriptor=readPaneHostDescriptor(directory,scope);if(!descriptor)throw Error('Owned scratch service not ready');
  return RuntimePaneLink.attach(descriptor,options);
 });
}
