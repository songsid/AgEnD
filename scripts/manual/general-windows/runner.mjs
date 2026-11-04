/** Explicit signed-in scratch runner. No real chat/fleet, profile edits or raw provider output. */
import assert from 'node:assert/strict';
import {join,win32} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
const [bundle,root]=process.argv.slice(2);
assert(process.platform==='win32'&&win32.normalize(root).toLowerCase().startsWith('c:\\users\\changhansung\\agend-adapter-proto\\general-'));
const load=name=>import(pathToFileURL(join(bundle,'dist',name+'.js')).href);
const [{RuntimeClient,pairRuntime},{RuntimeClientStore,runtimeJobDigest},{startPaneService},{RuntimePaneLink},{findCli,nativeCliEnvironment,readNativeCodexModels},{execFile},{promisify}]=await Promise.all([
 ...['runtime-client','runtime-client-store','runtime-pane-service','runtime-pane-link','windows-cli-worker'].map(load),import('node:child_process'),import('node:util')]);
const input=createInterface({input:process.stdin}),send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const initial=await new Promise(done=>input.once('line',line=>done(JSON.parse(line)))),store=new RuntimeClientStore(join(root,'profile'));
let client,service,closing=false;
const close=async()=>{if(closing)return;closing=true;await client?.stop();await service?.close();input.close();process.stdin.destroy();};
input.once('close',()=>{if(!closing)void close();});
try{
 const {RuntimeGeneralWorkspace,loadGeneralKnowledge}=await load('runtime-general-workspace');
 const proofRoot=join(root,'filesystem-proof');mkdirSync(proofRoot);const publisher=new RuntimeGeneralWorkspace(proofRoot,join(bundle,'dist'));
 const request={action:'general-workspace',bindingId:randomUUID(),instance:'scratch-general-junction',cli:'codex',packHash:loadGeneralKnowledge('codex',join(bundle,'dist')).hash};
 const prepared=publisher.prepare(request,()=>true,()=>true),outside=join(root,'outside-junction');mkdirSync(outside);writeFileSync(join(outside,'keep'),'keep');
 rmSync(join(prepared.cwd,'.agents'),{recursive:true});symlinkSync(outside,join(prepared.cwd,'.agents'),'junction');
 assert.throws(()=>publisher.prepare(request,()=>true,()=>true));assert.equal(readFileSync(join(outside,'keep'),'utf8'),'keep');
 rmSync(proofRoot,{recursive:true});rmSync(outside,{recursive:true});
 const inventory={home:root,clis:[]};
 for(const id of ['codex','claude-code']){
  const cli=await findCli(id);assert(cli);const result=await promisify(execFile)(cli.command,[...cli.args,'--version'],{cwd:root,env:nativeCliEnvironment(),shell:false,windowsHide:true,timeout:10000,maxBuffer:4096});
  const version=result.stdout.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0];assert(version);
  inventory.clis.push({id,runnable:true,version,readOnlySupport:true,authenticated:null,path:null,permissionNote:"Scratch read-only acceptance",models:[],supports:{resume:true}});
 }
 assert.deepEqual(inventory.clis.map(row=>row.version),['0.165.0','2.1.316']);
 const models=readNativeCodexModels().map(row=>row.id),model=models.find(id=>/-luna$/.test(id))??models.find(id=>/-(?:mini|nano)$/.test(id));assert(model);
 for(const row of inventory.clis)row.models=row.id==='codex'?[{id:model}]:[{id:'haiku'}];
 const credentials=await pairRuntime({...initial,store,name:'scratch-General-proof',pollMs:100,report:text=>{const fingerprint=/Pairing fingerprint: ([A-F0-9-]+)/.exec(text)?.[1];if(fingerprint)send({fingerprint});}});
 service=await startPaneService({directory:join(root,'profile','pane-host'),scope:runtimeJobDigest({server:credentials.server,machineId:credentials.machineId})});
 client=new RuntimeClient({store,reconnectMs:100,pollMs:50,bridge:{probe:async()=>inventory,prepareWorkspace(){throw Error('No exec');},start(){throw Error('No exec');},get:()=>null,cancel(){throw Error('No exec');},close(){},releaseUnknown(){}},openPaneLink:options=>RuntimePaneLink.attach(service.descriptor,options)});
 await client.start();send({ready:true,junctionRefused:true,machineId:credentials.machineId,versions:inventory.clis.map(({id,version})=>({id,version})),model});
 input.on('line',line=>{if(line==='close')void close();else{send({failed:true,phase:'unexpected-control'});void close();process.exitCode=1;}});
}catch(error){send({failed:true,phase:'runner',kind:error.name,code:error.code});await close();process.exitCode=1;}
