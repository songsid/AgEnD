/** Real paired WebSocket → native ConPTY proof, loopback only, inert providers/private homes. */
import {sourceReceipt,codeBundleReceipt} from './source-receipt.mjs';
import {createServer} from 'node:http';import {spawn,execFileSync} from 'node:child_process';import {once} from 'node:events';import {createInterface} from 'node:readline';
import {mkdir,cp,rm,writeFile} from 'node:fs/promises';import {mkdtempSync} from 'node:fs';import {join,resolve,win32} from 'node:path';import {pathToFileURL} from 'node:url';import {randomUUID} from 'node:crypto';import assert from 'node:assert/strict';
const compiled=resolve(process.argv[2]||'.artifacts/pane-full-package/dist'),bundle=resolve(process.argv[3]||'.artifacts/pane-stage4-bundle'),tag=randomUUID().slice(0,8),root='/mnt/c/Users/changhansung/agend-adapter-proto/remote-'+tag,nativeRoot='C:\\Users\\changhansung\\agend-adapter-proto\\remote-'+tag;
const source={...sourceReceipt(),...await codeBundleReceipt(bundle)};
const home=mkdtempSync(join(process.cwd(),'.artifacts/remote-native-proof-'));
const [{RuntimeCoordinator},{PaneMcpAuthorityLease}]=await Promise.all(['runtime-coordinator.js','runtime-pane-mcp.js'].map(name=>import(pathToFileURL(join(compiled,name)).href)));
const planned=new Map(),leases=new Map();let toolCalls=0,writtenReceipts=0;
const hubOptions=()=>({requestTimeoutMs:45000,handlePaneMcp:async(machineId,body,current)=>{assert(current());const launch=planned.get(body.owner.paneId);assert(launch&&launch.agentId===body.owner.agentId&&launch.instance===body.owner.instance);let lease=leases.get(body.owner.launchId);if(!lease){lease=new PaneMcpAuthorityLease(join(home,body.owner.launchId+'.json'),{machineId,owner:body.owner,current:()=>hub.machine(machineId)?.status==='online',transportEpoch:()=>hub.paneTransportEpoch(machineId),menu:()=>[{name:'reply',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}],allowed:(tool,args)=>tool==='reply'&&args.text==='REMOTE_INERT_REPLY_OK',invoke:async(input,allowed)=>{assert(allowed());toolCalls++;return{result:'REMOTE_RESULT_OK'};},responseWritten:()=>{writtenReceipts++;}});leases.set(body.owner.launchId,lease);}return lease.handle(machineId,body,current);}});
let hub=new RuntimeCoordinator(home,hubOptions()),runner,reader,closed=false,passed=false,phase='pair';const messages=[],panes=[];
const until=async(check,timeout=45000)=>{const end=performance.now()+timeout;while(!await check()){if(messages.some(value=>value.kind==='failed')||closed)throw Error('Native remote proof stopped');if(performance.now()>end)throw Error('Remote proof deadline: '+phase);await new Promise(done=>setTimeout(done,50));}};
const server=createServer((req,res)=>{if(!hub.handlePublicRequest(req,res,new URL(req.url,'http://localhost'))){res.writeHead(404);res.end();}});
server.on('upgrade',(req,socket,head)=>{if(!hub.handleUpgrade(req,socket,head))socket.destroy();});server.listen(0,'127.0.0.1');await once(server,'listening');
let receipt={...source,passed:false,kind:'paired-native-inert',scratchTag:tag,noCliOrAccountCalls:true};
try{
 await mkdir(root);await cp(bundle,join(root,'bundle'),{recursive:true});await cp('scripts/manual/windows-pane-adapter/remote-native-runner.mjs',join(root,'runner.mjs'));await cp('scripts/manual/windows-pane-adapter/inert-remote-cli.cjs',join(root,'inert-remote-cli.cjs'));
 const ps='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',code="$ProgressPreference='SilentlyContinue'; [Console]::Write((Get-Command node.exe -CommandType Application | Select-Object -First 1).Source)",nativeNode=execFileSync(ps,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{encoding:'utf8',timeout:10000}).trim(),node=execFileSync('wslpath',['-u',nativeNode],{encoding:'utf8',timeout:5000}).trim();
 runner=spawn(node,[win32.join(nativeRoot,'runner.mjs'),win32.join(nativeRoot,'bundle'),nativeRoot],{stdio:['pipe','pipe','pipe'],shell:false});runner.stderr.resume();runner.once('close',()=>{closed=true;});reader=createInterface({input:runner.stdout});reader.on('line',line=>{try{messages.push(JSON.parse(line));}catch{messages.push({kind:'failed'});}});
 const pair=hub.createPairing();runner.stdin.write(JSON.stringify({server:'http://127.0.0.1:'+server.address().port,code:pair.code})+'\n');await until(()=>messages.some(row=>row.kind==='fingerprint'));
 const pending=hub.listMachines().filter(row=>row.status==='pending');assert.equal(pending.length,1);const fingerprint=messages.find(row=>row.kind==='fingerprint').fingerprint;assert.equal(pending[0].pairingFingerprint,fingerprint);hub.approve(pending[0].id,fingerprint);
 await until(()=>messages.some(row=>row.kind==='paired'));const paired=messages.find(row=>row.kind==='paired'),machine=paired.machineId;await until(()=>hub.machine(machine)?.status==='online');
 phase='two-panes';const launch=()=>({paneId:randomUUID(),agentId:randomUUID(),instance:'remote-inert-'+randomUUID().slice(0,8),cli:'codex',cwd:paired.cwd,sandbox:'read-only',columns:100,rows:24,mcpTools:['reply']});
 await assert.rejects(()=>hub.callPane(machine,{action:'open',operationId:randomUUID(),launch:{...launch(),executable:'cmd.exe'}},2));
 for(let i=0;i<2;i++){const command={action:'open',operationId:randomUUID(),launch:launch()};planned.set(command.launch.paneId,command.launch);const pane=await hub.callPane(machine,command,2);panes.push({pane,command});}
 const capture=row=>hub.callPane(machine,{action:'capture',paneId:row.pane.paneId,launchId:row.pane.launchId},2);
 for(const row of panes)await until(async()=>(await capture(row)).text.includes('MCP_CANARY_DONE'));
 await until(()=>toolCalls===2&&writtenReceipts===2);
 await assert.rejects(()=>hub.callPane(machine,{action:'open',operationId:randomUUID(),launch:launch()},2));
 const row=panes[0],input={action:'input',paneId:row.pane.paneId,launchId:row.pane.launchId,operationId:randomUUID(),sequence:1,expectedSeq:row.pane.seq,kind:'literal',text:'inert-once'};
 await hub.callPane(machine,input,2);await until(async()=>(await capture(row)).text.includes('WRITES 1'));
 phase='coordinator-reconnect';const before=hub.paneTransportEpoch(machine);hub.close();hub=new RuntimeCoordinator(home,hubOptions());await until(()=>hub.machine(machine)?.status==='online'&&hub.paneTransportEpoch(machine)!==before);
 for(const row of panes){const same=await hub.callPane(machine,row.command,2);assert.equal(same.launchId,row.pane.launchId);assert.equal(same.hostBootId,row.pane.hostBootId);}
 await hub.callPane(machine,input,2);assert(!(await capture(row)).text.includes('WRITES 2'));
 phase='rotation';runner.stdin.write('{"action":"rotate"}\n');await until(()=>messages.some(row=>row.kind==='rotated'));await until(()=>hub.machine(machine)?.status==='online');assert.equal((await hub.callPane(machine,row.command,2)).launchId,row.pane.launchId);assert(!(await capture(row)).text.includes('WRITES 2'));
 assert.equal(toolCalls,2);assert.equal(writtenReceipts,2);phase='revocation';hub.revoke(machine);runner.stdin.write('{"action":"revoked"}\n');await until(()=>messages.some(row=>row.kind==='retired'));
 // Retirement completes before the client releases its profile: verify exact private native journal entries from this scratch only.
 const {readFile}=await import('node:fs/promises');const journal=JSON.parse(await readFile(join(root,'profile','pane-host','state','panes.json'),'utf8'));
 for(const {pane} of panes){const snapshot=journal.panes[pane.paneId].snapshot;assert.equal(snapshot.launchId,pane.launchId);assert.equal(snapshot.state,'exited');}
 passed=true;receipt={...receipt,passed:true,fingerprintCompared:true,scopedMcpCalls:toolCalls,stdioWrittenReceipts:writtenReceipts,twoConcurrentPanes:true,perMachineCap:true,closedLaunchUnion:true,coordinatorReconnectSamePanes:true,duplicateInputNotReplayed:true,rotationPreservesPanes:true,explicitRevocationRetiresOwned:true};
}catch(error){receipt={...receipt,phase,failureClass:error?.name,error:'Acceptance assertion or deadline; no raw provider data retained'};}
finally{
 if(runner&&!closed){runner.stdin.write('{"action":"close"}\n');runner.stdin.end();const end=performance.now()+20000;while(!closed&&performance.now()<end)await new Promise(done=>setTimeout(done,50));}
 reader?.close();for(const lease of leases.values())lease.close();hub.close();server.closeAllConnections();await new Promise(done=>server.close(done));
 receipt.runnerClosed=closed;if(closed){await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});await rm(home,{recursive:true,force:true});}else receipt.ownedScratchRetained=true;
 await writeFile('.artifacts/pane-remote-native-receipt.json',JSON.stringify(receipt,null,2)+'\n');process.stdout.write(JSON.stringify(receipt)+'\n');
}
if(!passed||!closed)process.exitCode=1;
