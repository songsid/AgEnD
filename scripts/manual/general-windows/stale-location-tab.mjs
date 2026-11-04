/** Real-browser location controls + real confirmation/replay + durable binding; inert processes only. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {sourceReceipt} from '../windows-pane-adapter/source-receipt.mjs';
const project=process.cwd(),load=name=>import(pathToFileURL(resolve('dist',name+'.js')).href);
const [{GeneralBindings,generalBindingRevision,switchGeneralLocation},{SettingsExecution},{SettingsConfirmationStore},{SettingsHttpConfirmation},{handleSettingsRequest},{prepareSettingsEffect},{DEFAULT_INSTANCE_CONFIG}]=await Promise.all(['general-binding','settings-transaction','settings-confirmation','settings-http-confirmation','settings-api','settings-effect','config'].map(load));
const {chromium}=await import(pathToFileURL(resolve('.artifacts/browser-deps/node_modules/playwright/index.mjs')).href);
const root=await mkdtemp(resolve('.artifacts/general-location-tab-')),store=new GeneralBindings(root),id=randomUUID(),agentId=randomUUID(),machineId=randomUUID();
let cfg={...structuredClone(DEFAULT_INSTANCE_CONFIG),working_directory:root,general_topic:true,backend:'claude-code'},stops=0,starts=0,upgraded=false;
const windows={id,agentId,machineId,cli:'claude-code',config:{...cfg,runtime:'windows',native_adapter:'pane',native_general_binding:id,native_agent_id:agentId,machine_id:machineId,backend:'claude-code',model:'haiku',working_directory:'C:\\scratch\\general'}};
const target={location:'windows',machineId,cli:'claude-code',model:'haiku'};
const current=()=>({instances:{general:cfg}});
const preview=input=>{assert.equal(input.revision,generalBindingRevision(store.read('general'),cfg),'stale location revision');return{summary:['Host and Windows conversations stay separate. Switching does not copy or merge their history.'],connections:[]};};
const switchIt=async(input,execution)=>switchGeneralLocation({store,current:()=>cfg,assert(){},prepare:async()=>windows,idle:async()=>true,
 stop:async()=>{stops++;},save:next=>{cfg=next;},start:async()=>{starts++;},notify(){}},input,execution);
const confirmation=new SettingsConfirmationStore({audit(){},notify(){}});
const gate=new SettingsHttpConfirmation(confirmation,{principal:()=>({id:'scratch-admin',label:'scratch-admin',source:'web_session',current:()=>true,localAdmin:()=>true}),baseline:async()=>({config:current(),classic:{},generalLocation:preview}),snapshot:()=>current()});
const view=()=>({generals:[{name:'general',displayName:'General',location:cfg.runtime==='windows'?'windows':'host',machineId:cfg.machine_id,cli:cfg.backend,model:cfg.model||'',revision:generalBindingRevision(store.read('general'),cfg),canSwitchBack:cfg.runtime==='windows',hold:null,offline:false,switching:false}],machines:[{id:machineId,name:'Scratch PC',online:true,clis:[{id:'claude-code',version:'2.1.316'}]}]});
const ctx={logger:{warn(){}},generalLocations:view,switchGeneralLocation:async(input,authorized,execution)=>{assert(authorized());return switchIt(input,execution);}};
let server,browser;
try{
 server=createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/settings/')){if(gate.handle(req,res,url,(r,s,u)=>handleSettingsRequest(r,s,u,ctx)))return;if(handleSettingsRequest(req,res,url,ctx))return;}
  res.setHeader('Cache-Control','no-store');
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(`<!doctype html><html lang="en"><body><div id="app"></div><script type="module">import{h,render}from'/assets/app-html.js';import{setLang}from'/assets/app-i18n.js';import{Toasts}from'/assets/ui-toast.js';import{GeneralLocation}from'/ui/js/general-location.js';setLang('en',{store:false});render(h('div',null,h(GeneralLocation),h(Toasts)),document.querySelector('#app'));</script></body></html>`);return;}
  let file;if(/^\/assets\/[a-z0-9.-]+\.js$/.test(url.pathname)){file=join(project,'src/ui/shared',basename(url.pathname));try{await readFile(file);}catch{file=join(project,'src/ui/vendor',basename(url.pathname));}}
  else if(/^\/ui\/js\/[a-z0-9.-]+\.js$/.test(url.pathname))file=join(project,'src/ui',basename(url.pathname));
  else{res.writeHead(404);res.end('{}');return;}
  res.setHeader('Content-Type','text/javascript');res.end(await readFile(file));
 }catch(error){res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto('http://127.0.0.1:'+server.address().port);
 await page.getByRole('button',{name:'Refresh',exact:true}).waitFor();await page.locator('.general-location-row > label select').first().selectOption(machineId);
 // The open page retains the original revision. A different confirmed switch commits during a backend upgrade.
 const cap=new SettingsExecution({current:()=>true,snapshot:current});await switchIt({name:'general',revision:generalBindingRevision(null,cfg),target},cap);cap.close();upgraded=true;
 const response=page.waitForResponse(r=>r.url().endsWith('/api/settings/general-location')&&r.request().method()==='POST');await page.getByRole('button',{name:'Save',exact:true}).click();assert.equal((await response).status(),409);assert.equal(stops,1);assert.equal(starts,1);
 // Refresh is a human action; only the newly rendered revision may request switch-back.
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'This AgEnD host',exact:true}).waitFor();
 await page.getByRole('button',{name:'This AgEnD host',exact:true}).click();
 const until=async fn=>{const end=Date.now()+10000;while(!fn()){assert(Date.now()<end,'pending confirmation');await new Promise(r=>setTimeout(r,30));}};
 await until(()=>confirmation.list('scratch-admin').some(row=>row.state==='pending'));const pending=confirmation.list('scratch-admin').find(row=>row.state==='pending');
 assert.equal(stops,1,'No stop before confirmation');await confirmation.decide(pending.id,'confirm',{label:'scratch host operator',current:()=>true});await until(()=>starts===2);
 await page.getByRole('button',{name:'Save',exact:true}).waitFor();assert.equal(cfg.runtime,undefined);assert.equal(stops,2);assert.equal(store.read('general').windows[0].agentId,agentId);assert.deepEqual(errors,[]);
 const receipt={...sourceReceipt(),kind:'real-browser-General-location-stale-tab',browser:await browser.version(),openedBeforeUpgrade:true,backendUpgraded:upgraded,noReload:true,oldRevisionRefusedBeforeEffects:true,newRevisionRequiresAdminConfirmation:true,switchBackRetainsWindowsBinding:true,processes:'inert',noAccountOrFleetCalls:true};
 await writeFile('.artifacts/general-location-stale-tab.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
}finally{await browser?.close();confirmation.close();if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}await rm(root,{recursive:true,force:true});}
