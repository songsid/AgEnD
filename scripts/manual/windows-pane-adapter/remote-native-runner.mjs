/** Outbound paired-runtime proof; private inert providers, no installed CLI/account. */
import {join,dirname,delimiter,win32} from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const [bundle,root]=process.argv.slice(2);
assert(process.platform==='win32'&&win32.normalize(root).toLowerCase().startsWith('c:\\users\\changhansung\\agend-adapter-proto\\'));
const lines=createInterface({input:process.stdin}),send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const first=await new Promise(resolve=>lines.once('line',line=>resolve(JSON.parse(line))));
const bin=join(root,'bin'),script=join(bin,'node_modules','@openai','codex','bin','codex.js');await mkdir(dirname(script),{recursive:true});
await writeFile(script,await readFile(join(root,'inert-remote-cli.cjs')));
await writeFile(join(bin,'codex.cmd'),'@echo off\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
process.env.PATH=[bin,dirname(process.execPath),join(process.env.SystemRoot||'C:\\Windows','System32')].join(delimiter);
for(const key of ['USERPROFILE','HOME','APPDATA','LOCALAPPDATA','CODEX_HOME','CLAUDE_CONFIG_DIR'])process.env[key]=root;
const load=name=>import(pathToFileURL(join(bundle,'dist',name+'.js')).href);
const [{RuntimeClient,pairRuntime,rotateRuntimeCredentials},{RuntimeClientStore,runtimeJobDigest},{startPaneService},{RuntimePaneLink}]=await Promise.all(['runtime-client','runtime-client-store','runtime-pane-service','runtime-pane-link'].map(load));
const directory=join(root,'profile'),store=new RuntimeClientStore(directory),abort=new AbortController();
let service,client,closing=false;
const close=async()=>{if(closing)return;closing=true;abort.abort();await client?.stop();await service?.close();lines.close();process.stdin.destroy();};
lines.once('close',()=>{if(!closing)void close();});
try{
 const credentials=await pairRuntime({...first,name:'private-native-pane-proof',store,signal:abort.signal,pollMs:100,report:text=>{const fingerprint=/Pairing fingerprint: ([A-F0-9-]+)/.exec(text)?.[1];if(fingerprint)send({kind:'fingerprint',fingerprint});}});
 service=await startPaneService({directory:join(directory,'pane-host'),scope:runtimeJobDigest({server:credentials.server,machineId:credentials.machineId})});
 const start=async()=>{client=new RuntimeClient({store,reconnectMs:50,pollMs:25,bridge:{probe:async()=>({home:root,clis:[]}),prepareWorkspace:async()=>{throw Error('No exec workspace')},start:()=>{throw Error('No exec fallback')},get:()=>null,cancel:()=>{throw Error('No exec cancellation')},close(){},releaseUnknown(){}},openPaneLink:options=>RuntimePaneLink.attach(service.descriptor,options)});await client.start();};
 await start();send({kind:'paired',machineId:credentials.machineId,cwd:root});
 // Commands are acceptance orchestration only, not a product RPC. No executable/argv or shell input accepted.
 let chain=Promise.resolve();
 lines.on('line',line=>{chain=chain.then(async()=>{const command=JSON.parse(line);assert.deepEqual(Object.keys(command),['action']);
  if(command.action==='rotate'){await client.stop();await rotateRuntimeCredentials({store});await start();send({kind:'rotated'});}
  else if(command.action==='revoked'){await client.waitUntilStopped();send({kind:'retired'});}
  else if(command.action==='close'){await close();send({kind:'closed'});}
  else throw Error('Unknown acceptance control');
 }).catch(async()=>{send({kind:'failed'});await close();process.exitCode=1;});});
}catch{await close();send({kind:'failed'});process.exitCode=1;}
