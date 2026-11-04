/** Stale-tab API smoke: no UI assets change in this PR. Real browser, sessions, authority, store and lifetime fence. */
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {sourceReceipt} from '../windows-pane-adapter/source-receipt.mjs';
const root=await mkdtemp(join(process.cwd(),'.artifacts/general-stale-tab-'));process.env.AGEND_HOME=root;
const load=name=>import(pathToFileURL(resolve('dist',name+'.js')).href);
const [{FleetManager},{AccessManager},{SettingsConfirmationStore},{prepareSettingsEffect},{tokenEpoch,csrfTokenFor},{WEB_CSRF_HEADER},{setLocale}]=await Promise.all([
 'fleet-manager','channel/access-manager','settings-confirmation','settings-effect','web-session','web-auth','locale'].map(load));
const {chromium}=await import(pathToFileURL(resolve(process.env.AGEND_PLAYWRIGHT||'.artifacts/browser-deps/node_modules/playwright/index.mjs')).href);
setLocale('en');const fm=new FleetManager(root),token=randomBytes(24).toString('hex');let browser,server,upgraded=false,applied=0,baselineEntered,releaseBaseline;
const channels=['a','b'].map((id,i)=>({id,type:'telegram',mode:'topic',group_id:'100'+i,access:{mode:'locked',allowed_users:['admin']}}));
fm.fleetConfig={defaults:{},channels,web:{verified_authority:{enabled:true}},instances:Object.fromEntries(channels.map((ch,i)=>['general_'+ch.id,{working_directory:root,general_topic:true,channel_id:ch.id,topic_id:String(i+1)}]))};
for(const ch of channels){const adapter=Object.assign(new EventEmitter(),{id:ch.id,type:ch.type,notifyAlert:async(chatId,_alert,opts)=>({chatId,messageId:'scratch-prompt',threadId:opts?.threadId}),editMessageRemoveButtons:async()=>{},sendText:async()=>({chatId:ch.group_id,messageId:'scratch-notice'})});
 fm.adapters.set(ch.id,adapter);fm.adapter??=adapter;fm.worlds.set(ch.id,{id:ch.id,adapter,groupId:ch.group_id,channelConfig:ch,accessManager:new AccessManager(ch.access,join(root,ch.id+'.json'))});fm.adapterState.set(ch.id,{status:'connected'});fm.daemons.set('general_'+ch.id,new EventEmitter());}
await writeFile(join(root,'web.token'),token,{mode:0o600});fm.initializeWebSessions();
const session=fm.webSessions.create({tier:'admin',surface:'local',label:'scratch-browser',tokenEpoch:tokenEpoch(token),owner:{adapterId:'a',userId:'admin'}});
assert(fm.authorizeWebSession(session.record,'loopback',false).ok);
const store=new SettingsConfirmationStore({audit(){},notify(){}});
const effect=prepareSettingsEffect('PUT','/api/settings/fleet/channels',channels.map(ch=>ch.id==='a'?{...ch,access:{...ch.access,allowed_users:['admin','new-person']}}:ch),{config:fm.fleetConfig,classic:{}}).diff;
const propose=(key,held=false)=>store.propose({session:'scratch',key,bytes:1,source:'web_session',section:effect.section,requestedBy:'scratch-browser',fingerprint:effect.fingerprint,summary:effect.summary,
 affectedConnections:effect.affectedConnections,authority:effect.authority,current:()=>true,snapshot:()=>null,
 unchanged:()=>held?new Promise(done=>{releaseBaseline=()=>done(true);baselineEntered?.();}):Promise.resolve(true),
 apply:async(_current,execution)=>execution.commit(()=>{applied++;return'applied';})}).view;
const normal=propose('normal');let stale;
try{
 server=createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><body>Unchanged Settings request contract; tab opened before server upgrade.</body></html>');return;}
  if(req.method!=='POST'||url.pathname!=='/apply'){res.writeHead(404);res.end();return;}
  const id=url.searchParams.get('case')==='stale'?stale?.id:normal.id;
  const self=!upgraded&&!fm.daemons.has('general_b')?null:fm.settingsSelfConfirmation(store,req,id);
  if(!self){res.writeHead(403,{'Content-Type':'application/json'});res.end(JSON.stringify({refused:true}));return;}
  const view=await store.decide(id,'confirm',{...self,via:'web'});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({state:view.state,applied}));
 }catch{res.writeHead(500);res.end('{}');}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});const context=await browser.newContext();await context.addCookies([{name:'agend_session',value:session.sessionId,url:origin}]);const page=await context.newPage();await page.goto(origin);
 const apply=kind=>page.evaluate(async({kind,header,csrf})=>{const response=await fetch('/apply?case='+kind,{method:'POST',headers:{[header]:csrf},signal:AbortSignal.timeout(10000)});return{status:response.status,body:await response.json()};},{kind,header:WEB_CSRF_HEADER,csrf:csrfTokenFor(session.sessionId)});
 upgraded=true;fm.daemons.delete('general_b'); // Same open tab, new backend, Windows/model unavailable.
 const accepted=await apply('normal');assert.equal(accepted.body.state,'applied');assert.equal(applied,1);
 await apply('normal');assert.equal(applied,1,'Old-tab replay must not apply twice');
 stale=propose('stale',true);assert.notEqual(stale.id,normal.id);
 const reached=new Promise(done=>{baselineEntered=done;});const pending=apply('stale');await Promise.race([reached,new Promise((_done,reject)=>setTimeout(()=>reject(Error('Stale browser baseline deadline')),10000))]);
 fm.lifecycle.invalidate('general_b');releaseBaseline();const refused=await pending;assert.equal(refused.body.state,'stale');assert.equal(applied,1);
 const receipt={...sourceReceipt(),kind:'real-browser-stale-card-api',browser:await browser.version(),openedBeforeUpgrade:true,noReload:true,offlineModelAdminAppliedOnce:true,lifecycleChangeDuringApplyRefused:true,noFleetCliAccountOrPlatformCalls:true};
 await writeFile('.artifacts/general-stale-card-tab.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
}finally{await browser?.close();store.close();for(const item of fm.pendingNonceButtons.values())clearTimeout(item.timer);fm.stormWindow.shutdown();fm.spawnGate.shutdown();if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}await rm(root,{recursive:true,force:true});}
