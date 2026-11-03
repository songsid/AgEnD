/** Real-browser stale-tab smoke. Inert processes, private files, actual component/API/manager; no fleet or account. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sourceReceipt } from './source-receipt.mjs';

const project=process.cwd(), compiled=resolve(process.argv[2]||'dist');
const load=name=>import(pathToFileURL(join(compiled,name)).href);
const [{NativePaneManager},{RuntimePaneHost},{RuntimePaneStore},{WindowsAgents},{nativeInstanceConfig},
 {handleNativeInstanceRequest},{setConfiguredRuntimeSwitches},{setLocale}]=await Promise.all([
 'native-pane-manager.js','runtime-pane-host.js','runtime-pane-store.js','windows-agents.js',
 'native-instance-registry.js','native-instance-api.js','runtime-switches.js','locale.js'].map(load));
const {chromium}=await import(pathToFileURL(resolve(process.env.AGEND_PLAYWRIGHT||'.artifacts/browser-deps/node_modules/playwright/index.mjs')).href);
const root=await mkdtemp(join(project,'.artifacts/stale-tab-')), token=randomUUID();
setConfiguredRuntimeSwitches({windows_cli:true});setLocale('en');
let browser, server, upgraded=false, lifecycle, opens=0, actions=0;
const store=new WindowsAgents(root,{get:()=>null,start(){throw Error('No exec permitted');}});
const agent=await store.create({name:'Unwritten',cli:'claude-code',cwd:'C:\\scratch\\stale-tab',sandbox:'read-only'});
const name='stale-proof';store.bindInstance(agent.id,name);
const config={...nativeInstanceConfig(agent),native_adapter:'pane'};
const host=new RuntimePaneHost({store:new RuntimePaneStore(join(root,'runner')),bootId:randomUUID(),online:()=>true,maxAgents:()=>4,
 sessionProof:async()=> 'unknown',
 spawn:async()=>{opens++;let onExit=()=>{};return {pid:12121,write(){},resize(){},pause(){},resume(){},
  kill(){onExit({exitCode:1});},onData:()=>({dispose(){}}),onExit:callback=>{onExit=callback;return {dispose(){}};}};},
 mcpConnection:(owner,tools)=>({owner,tools,endpoint:'http://127.0.0.1:1/agent',token:'a'.repeat(64)})});
const endpoint={machineId:'local',online:()=>true,epoch:()=> 'private',version:()=> 'Claude Code 2.1.316',
 call:request=>host.request(request),subscribe:()=>()=>{}};
const manager=new NativePaneManager({home:root,store,config:()=>config,endpoint:async()=>endpoint,admit(){},
 instructions:()=> 'No work',menu:()=>[{name:'reply'}],allowed:()=>false,published:()=>false,invoke:async()=>{throw Error('No tools');}});
const previousComponent=execFileSync('git',['show','89073899056df6452f2cc1435a447c9607b041ff:src/ui/native-pane-recovery.js'],{encoding:'utf8'});
const previousStrings=execFileSync('git',['show','89073899056df6452f2cc1435a447c9607b041ff:src/ui/chat-strings.js'],{encoding:'utf8'});
const status=()=>({native_adapter:'pane',status:'stopped',native_recovery:store.get(agent.id).paneRecovery});
const ctx={webToken:token,fleetConfig:{instances:{[name]:config}},nativeInstanceRuntime:()=>({get:()=>store.get(agent.id)}),
 emitSseEvent(){},getUiStatus:status,
 recoverNativePane:async(_name,launchId,authorized)=>{assert(authorized());await manager.recover(name,config,launchId,true,()=>assert(authorized()));},
 startFreshNativePane:async(_name,launchId,sessionId,authorized)=>{assert(authorized());await manager.startFresh(name,config,launchId,sessionId,()=>assert(authorized()));actions++;}};
const html=`<!doctype html><html lang="en"><body><div id="app"></div><script type="module">
 import {h,render} from '/assets/app-html.js';import {setLang} from '/assets/app-i18n.js';
 import {Toasts} from '/assets/ui-toast.js';import {NativePaneRecovery} from '/ui/js/native-pane-recovery.js';
 setLang('en',{store:false});let state=await (await fetch('/status')).json();
 const lease={current:()=>true,fetch:(path,options)=>fetch(path,{...options,headers:{...options?.headers,'x-agend-token':${JSON.stringify(token)}}})};
 function paint(){render(h('div',null,h(NativePaneRecovery,{name:${JSON.stringify(name)},inst:state,lease}),h(Toasts)),document.getElementById('app'));}
 window.refreshStatus=async()=>{state=await(await fetch('/status')).json();paint();};paint();
 </script></body></html>`;
try{
 lifecycle=await manager.prepare(name,config,()=>{});await lifecycle.acquire(()=>{});
 const pin=store.get(agent.id).threadId;await lifecycle.release('close');lifecycle=undefined;
 const launchId=JSON.parse(await readFile(join(root,'native-panes',agent.id,'active.json'),'utf8')).launch.launchId;
 // Before the upgrade the tab offers the old process-exit recovery.
 store.setPaneRecovery(agent.id,{kind:'exit-unconfirmed',launchId});
 server=createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/status'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(status()));return;}
  if(url.pathname.startsWith('/ui/instances/')&&handleNativeInstanceRequest(req,res,url,ctx))return;
  res.setHeader('Cache-Control','no-store');
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
  let content;
  if(url.pathname==='/ui/js/native-pane-recovery.js')content=upgraded?await readFile(join(project,'src/ui/native-pane-recovery.js'),'utf8'):previousComponent;
  else if(url.pathname==='/ui/js/chat-strings.js')content=upgraded?await readFile(join(project,'src/ui/chat-strings.js'),'utf8'):previousStrings;
  else if(/^\/assets\/[a-z0-9.-]+\.js$/.test(url.pathname))content=await readFile(join(project,'src/ui/shared',basename(url.pathname)),'utf8');
  else{res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type','text/javascript');res.end(content);
 }catch{res.writeHead(500);res.end('Scratch smoke failed');}});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const page=await browser.newPage(), errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 await page.getByRole('button',{name:'Recover saved session',exact:true}).click();
 await page.getByRole('checkbox').check();
 upgraded=true;
 await assert.rejects(manager.prepare(name,config,()=>{}),error=>error.name==='NativePaneRecoveryError');
 assert.equal(store.get(agent.id).paneRecovery.kind,'session-unconfirmed');
 const before=store.get(agent.id).threadId;
 const rejected=page.waitForResponse(response=>response.url().endsWith('/recover-pane'));
 await page.getByRole('dialog').getByRole('button',{name:'Processes stopped — recover session',exact:true}).click();
 const response=await rejected;assert.equal(response.status(),400);
 assert.match((await response.json()).error,/Refresh this page/);assert.equal(store.get(agent.id).threadId,before);assert.equal(opens,1);
 // The already-open JS cannot bypass the new server policy. A real reload loads the new action.
 await page.reload();await page.getByRole('button',{name:'Start a new conversation',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Start a new conversation',exact:true}).count(),1);
 await page.getByRole('button',{name:'Start a new conversation',exact:true}).click();
 const request=page.waitForRequest(request=>request.url().endsWith('/new-conversation'));
 const accepted=page.waitForResponse(response=>response.url().endsWith('/new-conversation'));
 await page.getByRole('dialog').getByRole('button',{name:'Start a new conversation',exact:true}).click();
 assert.deepEqual((await request).postDataJSON(),{confirmedNewConversation:true,launchId,sessionId:pin});
 assert.equal((await accepted).status(),200);assert.equal(actions,1);assert.notEqual(store.get(agent.id).threadId,pin);
 assert.equal(opens,1,'This smoke commits the explicit intent; it never launches a second inert pane');
 assert.deepEqual(errors,[]);
 const receipt={...sourceReceipt(),kind:'real-browser-stale-session-tab',browser:await browser.version(),
  oldTabOpenedBeforeUpgrade:true,oldRecoveryRefused:true,pinUnchangedOnRefusal:true,
  reloadShowsOneNewConversationAction:true,exactLaunchAndSessionConfirmed:true,adminIntentCommitted:true,
  noFleetOrAccountCalls:true};
 await writeFile(join(project,'.artifacts/stale-session-tab-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
 process.stdout.write(JSON.stringify(receipt)+'\n');
}finally{
 await browser?.close();if(server)await new Promise(done=>server.close(done));
 await lifecycle?.release('close');await host.stop();await rm(root,{recursive:true,force:true});
}
