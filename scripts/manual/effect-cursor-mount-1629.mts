/** Actual Shell/Chat/Settings host cursor mount + built service/library/preview, private synthetic session only. No fleet/account/service. Linux WebKit is not Safari. Build first; see the private container runner. */
import assert from "node:assert/strict";
import { inflateSync, deflateSync } from "node:zlib";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const pw = createRequire(join(resolve(process.env.PW_DIR!), "package.json"))("playwright");
const out = resolve(process.env.OUT_DIR || ".artifacts/stock-native"); mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(out, "private-")); mkdirSync(join(scratch, "home")); mkdirSync(join(scratch, "tmp"));
const crc = (data: Buffer) => { let n=0xffffffff;for(const b of data){n^=b;for(let j=0;j<8;j++)n=(n>>>1)^(n&1?0xedb88320:0);}return(n^0xffffffff)>>>0; };
const chunk = (type: string, data: Buffer) => {const name=Buffer.from(type),len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([len,name,data,sum]);};
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6;
const background=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,32,96,224,255]))),chunk('IEND',Buffer.alloc(0))]);
const actions: string[] = [];
const rows: any[] = [], ts = new Date().toISOString();
const message = { boot: "probe", id: 1, instance: "worker", sender: "worker", role: "agent", text: "A stock conversation with a protected reply control and [a link](https://example.invalid).\n\n```js\nconst n = 1;\n```\n\n```html\n<p>unterminated", ts, attachments:[{id:"d".repeat(32),name:"wide.csv",mime:"text/csv",size:600}], buttons: { id: "a".repeat(32), state: "open", labels: ["Approve", "Decline"] } };
function pixel(png,x,y){
 assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');let at=8,width=0,height=0,channels=0;const parts=[];
 while(at<png.length){const size=png.readUInt32BE(at),type=png.subarray(at+4,at+8).toString(),data=png.subarray(at+8,at+8+size);at+=size+12;
  if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);assert.equal(data[8],8);channels=data[9]===2?3:data[9]===6?4:0;assert.ok(channels);assert.equal(data[12],0);assert.ok(width*height<2e6);}
  if(type==='IDAT')parts.push(data);if(type==='IEND')break;
 }
 assert.ok(x>=0&&x<width&&y>=0&&y<height);const raw=inflateSync(Buffer.concat(parts)),stride=width*channels,rows=Buffer.alloc(stride*height);assert.equal(raw.length,(stride+1)*height);
 const paeth=(a,b,c)=>{const p=a+b-c,A=Math.abs(p-a),B=Math.abs(p-b),C=Math.abs(p-c);return A<=B&&A<=C?a:B<=C?b:c;};
 for(let row=0;row<height;row++){const filter=raw[row*(stride+1)];assert.ok(filter<=4);for(let i=0;i<stride;i++){const left=i>=channels?rows[row*stride+i-channels]:0,up=row?rows[(row-1)*stride+i]:0,corner=row&&i>=channels?rows[(row-1)*stride+i-channels]:0;rows[row*stride+i]=(raw[row*(stride+1)+i+1]+(filter===0?0:filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):paeth(left,up,corner)))&255;}}
 return [...rows.subarray((y*width+x)*channels,(y*width+x)*channels+3)];
}

// @ts-ignore built service projection, private scratch stores only.
import {WebEffectLibrary} from '../../dist/web-effect-library.js';
import {WebPrefsStore} from '../../dist/web-prefs.js';
// @ts-ignore built stores.
import {ThemeStore} from '../../dist/web-theme-store.js';
// @ts-ignore built profiles.
import {WebEffectProfiles} from '../../dist/web-effect-profiles.js';
// @ts-ignore built service.
import {WebEffectService} from '../../dist/web-effect-service.js';
// @ts-ignore built upload codec.
import {encodeEffectFiles} from '../../dist/web-effect-upload.js';
// @ts-ignore built preview only, not a fleet.
import {createPreviewListener} from '../../dist/web-preview.js';
const library=new WebEffectLibrary(scratch),themes=new ThemeStore(scratch),profiles=new WebEffectProfiles(scratch),prefs=new WebPrefsStore(scratch);
let preview:any,css=false,rev=1,resources=0,epoch='e'.repeat(16),profileWrites=0;
const service=new WebEffectService({library,themes,profiles,prefs,known:n=>['worker','worker-b'].includes(n),changed:()=>rev++});
library.registerReferenceSource('themes',()=>themes.placedEffects().flatMap(p=>p.ids.map(id=>({id,holder:'instance:'+p.name}))));
library.registerReferenceSource('owner-prefs',()=>prefs.ownerEffectReferences());
const ids=[]; const resourceScopes: string[] = [], prefWrites:any[]=[];
for(let n=0;n<4;n++){
 const worker=`const c=agend.canvas.getContext('2d');let color='#ff1414';const paint=()=>{c.fillStyle=color;c.fillRect(0,0,agend.canvas.width,agend.canvas.height)};paint();agend.on('env',paint);agend.on('reply',()=>{color='#14ff14';paint()});agend.ready();`;
 const files=new Map([['effect.json',Buffer.from(JSON.stringify({v:1,runtime:'canvas-worker-v1',worker:'worker.js',name:'native-'+n,title:'Native '+n,regions:['chat','page','header','sidebar','box'],box:{anchor:'top-left',width:100,height:80,offset:8},layer:n===1?'behind':'front',wants:['reply','pointer','state','theme'],...(n===3?{cursor:{hotspot:[0,0]}}:{})}))],['worker.js',Buffer.from(worker)]]);
 if(n===3)files.set('cursor.png',Buffer.concat([background.subarray(0,33),chunk('acTL',Buffer.alloc(8)),chunk('fcTL',Buffer.alloc(26)),background.subarray(33,background.length-12),chunk('fdAT',Buffer.from([0,0,0,1,99])),background.subarray(background.length-12)]));
 const r=service.upload(n>=2?'bob':'alice',encodeEffectFiles(files));assert.equal(typeof r.id,'string');ids.push(r.id);
}
assert.equal(themes.setPlacements('worker',{effects:ids.slice(0,2).map(id=>({id}))},'agent',()=>null).ok,true);
assert.equal(themes.setPlacements('worker-b',{effects:ids.slice(0,2).map(id=>({id}))},'agent',()=>null).ok,true);
const keys=['fx.page','fx.header','fx.sidebar','fx.box'];
function choose(mode){const values=Object.fromEntries(keys.map(k=>[k,mode==='all'?k==='fx.page'?ids[0]:ids[1]:mode==='shared'&&k==='fx.page'?ids[2]:mode==='box'&&k==='fx.box'||mode==='header'&&k==='fx.header'?ids[1]:null]));values['fx.cursor']=mode==='all'||mode==='cursor'?ids[3]:null;const r=prefs.writeForViewer('alice',new Map(Object.entries(values)),{validateEffect:(person,key,id)=>service.validateOwnerSelection(person,key,id)});assert.equal(r.ok,true);if(!r.ok)throw Error('selection');return r.view.rev}
const config={defaults:{backend:'codex'},instances:{worker:{working_directory:'/inert'}},channels:[]};
const server=createServer(async(req,res)=>{
 const u=new URL(req.url||'/','http://localhost'),p=u.pathname;
 if(/^\/assets\/[a-z0-9._-]+$/.test(p)||/^\/ui\/js\/[a-z0-9_-]+\.js$/.test(p)){
  try{res.setHeader('Content-Type',p.endsWith('.css')?'text/css':p.endsWith('.woff2')?'font/woff2':'text/javascript');res.end(readFileSync(join('src/ui',p.startsWith('/assets/')?'shared':'',p.split('/').at(-1))));}catch{res.statusCode=404;res.end();}return;
 }
 if(p==='/ui/owner-css.css'){res.setHeader('Content-Type','text/css');res.end('/* neutral owner CSS; still blocks agent front */');return;}
 if(p!=='/'){
  res.setHeader('Content-Type','application/json');let answer:any={ok:true,instances:[],themes:{},records:[],entries:[]};
  if(p==='/ui/effects/owner')answer=service.ownerSelections('alice');
  else if(p==='/ui/effects')answer={...service.list('alice'),canWrite:true};
  else if(p.startsWith('/ui/effects/')){
   assert.equal(u.searchParams.get('ownerEpoch'),epoch);
   if(p==='/ui/effects/placements'){assert.ok(['worker','worker-b'].includes(u.searchParams.get('instance')!));answer=service.placements('alice',u.searchParams.get('instance'));}
   else if(p.startsWith('/ui/effects/image/')){assert.equal(u.searchParams.get('slot'),'fx.cursor');assert.equal(p.split('/').at(-1),'cursor.png');const image=service.ownerImage('alice',p.split('/').at(-2),'cursor','fx.cursor');if(!image.ok){res.statusCode=404;res.end(JSON.stringify({error:'not_found'}));return}assert.equal(Buffer.from(image.bytes).includes(Buffer.from('acTL')),false);res.setHeader('Content-Type','image/png');res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.end(image.bytes);return}
   else if(p.startsWith('/ui/effects/resource/')){resources++;const slot=u.searchParams.get('slot'),instance=u.searchParams.get('instance');assert.ok(slot?!instance:!!instance);resourceScopes.push(slot||instance!);answer=slot?service.ownerResource('alice',p.split('/').at(-1),slot):service.resource('alice',p.split('/').at(-1),instance);}
   else if(p.startsWith('/ui/effects/profile/')){let body='';for await(const b of req)body+=b;answer=service.report('alice',p.split('/').at(-1),JSON.parse(body));if(!answer.error)profileWrites++;}
  }else if(p==='/auth/session')answer={csrf:'probe-csrf',handle:epoch,tier:'admin'};
  else if(p==='/auth/logout'){return;}// Held to prove synchronous teardown before logout completes.
  else if(p==='/ui/owner-css/state')answer={active:css?'a'.repeat(32):null,effectState:css?'on':'off',pending:null,text:'',assets:[],versions:[],limits:{maxAssets:16}};
  else if(p==='/ui/history')answer={messages:[message]};
  else if(p==='/api/card/worker')answer={tagline:{text:'Real Chat card',by:'agent'}};
  else if(p==='/ui/prefs'){
   if(req.method==='POST'){let body='';for await(const b of req)body+=b;const parsed=JSON.parse(body);assert.equal(parsed.ownerEpoch,epoch);prefWrites.push(parsed.set);const r=prefs.writeForViewer('alice',new Map(Object.entries(parsed.set)),{validateEffect:(person,key,id)=>service.validateOwnerSelection(person,key,id)});assert.equal(r.ok,true);}
   const v=prefs.readForViewer('alice');answer={...v,values:{...v.values,'preview.optIn':true,'fx.show':true},ownerScope:'person',ownerEpoch:epoch};
  }
  else if(p==='/probe/select')answer={rev:choose(u.searchParams.get('mode'))};
  else if(p==='/probe/unshare-cursor'){answer=service.share('bob',{id:ids[3],shared:false});assert.equal(service.ownerImage('alice',ids[3],'cursor','fx.cursor').ok,false);}
  else if(p==='/probe/unshare'){answer=service.share('bob',{id:ids[2],shared:false});assert.equal(service.ownerResource('alice',ids[2],'fx.page').error,'not_found');}
  else if(p==='/api/settings/schema')answer={provider_secrets:false,order:['now','instance','fleet']};
  else if(p==='/api/settings/fleet/raw')answer=config;
  else if(p==='/api/settings/classic')answer={defaults:{},channels:{}};
  else if(p==='/api/settings/connections'||p==='/auth/sessions')answer=[];
  else if(p==='/api/fleet')answer={instances:[{name:'worker',backend:'codex',status:'running',state:'idle'}]};
  else if(p==='/api/settings/fleet/appearance')answer={};
  else if(p==='/probe/css'){css=u.searchParams.get('on')==='1';const saved=prefs.setOwnerCss('alice',{active:css?'a'.repeat(32):null});assert.equal(saved.ok,true);answer={rev:prefs.rev()};}
  else if(p==='/probe/status')answer={resources,profileWrites};
  if(answer.error){res.statusCode=answer.error==='not_found'?404:400;}res.end(JSON.stringify(answer));return;
 }
 const origin='http://127.0.0.1:'+port,previewOrigin='http://127.0.0.1:'+preview.settings.port;
 const bootPrefs=JSON.stringify({rev:prefs.rev(),values:{'preview.optIn':true,'fx.show':true},ownerScope:'person',ownerEpoch:epoch});
 res.setHeader('Content-Type','text/html');res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'self' 'nonce-chat-probe'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; font-src 'self'; frame-src ${previewOrigin}/frame ${previewOrigin}/effect; worker-src 'none'; object-src 'none'; base-uri 'none'`);
 res.end(`<!doctype html><html data-prefs='${bootPrefs}'><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><link rel=stylesheet href=/assets/tokens.css><link rel=stylesheet href=/assets/app.css><body data-mode=full data-dashboard-origin="${origin}" data-preview-origin="${previewOrigin}" data-preview-boot="${'b'.repeat(32)}" data-owner-css-state=off><div id=app class=app-root></div><script src=/assets/agend-auth.js></script><script src=/ui/js/preview.js></script><script type=module nonce=chat-probe>
import{html,render}from'/assets/app-html.js';import{Shell}from'/assets/app-shell.js';import{appStore}from'/assets/app-store.js';import{navStore}from'/assets/app-nav.js';import{ChatPanel,boot}from'/ui/js/panel-chat.js';import{FleetPanel}from'/ui/js/panel-fleet.js';import{SettingsPanel}from'/ui/js/panel-settings.js';import{getAppEffects}from'/ui/js/app-effects.js';import{ownerEffectsStore}from'/assets/owner-effect-prefs.js';import{installOwnerCss,ownerCssLifecycle}from'/assets/owner-css.js';import{setLang}from'/assets/app-i18n.js';import{stockEffectTrust}from'/assets/effect-stock-trust.js';import{savePref,bootPrefs}from'/assets/app-prefs.js';
setLang(new URL(location.href).searchParams.get('lang')||'en',{store:false});localStorage.setItem('agend_tour_seen','1');window.AgendPreview.setOptIn(true);bootPrefs();installOwnerCss();
appStore.set({ready:true,connection:'live',instances:[{name:'worker',backend:'codex',status:'running',state:'idle',card_v:'probe-card'},{name:'worker-b',backend:'codex',status:'running',state:'idle',card_v:'probe-card'}],exec:{worker:'idle','worker-b':'idle'},awaiting:{},themesRev:1,prefsRev:${prefs.rev()},connections:1});navStore.set({route:{panel:'fleet'},seq:1});
const handlers={};const store=boot({stream:{on(k,fn){handlers[k]=fn;return()=>delete handlers[k]}},boot:document.body.dataset,deps:{announce(){},toast(){}}});
render(html\`<\${Shell} panels=\${new Map([['chat',{Component:ChatPanel}],['fleet',{Component:FleetPanel}],['settings',{Component:SettingsPanel}]])} onNewInstance=\${()=>{}} />\`,document.querySelector('#app'));
const appOwner=getAppEffects();const ownerHook=()=>{const stack=[document.querySelector('#app').__k];let i=0;while(stack.length&&i++<5000){const v=stack.pop();if(!v)continue;if(v.type?.name==='OwnerEffects')return{dirty:v.__c?.__d,state:v.__c?.__H?.__[0]?.__?.[0],pending:v.__c?.__H?.__[0]?.__N?.[0]};if(Array.isArray(v.__k))stack.push(...v.__k)}return null};
window.probe={cursor:()=>appOwner.cursorSnapshot(),preview:on=>window.AgendPreview.setOptIn(on),ownerHook,settingsState:()=>ownerEffectsStore.get(),prefsRev:()=>appStore.get().prefsRev,rows:()=>[...appOwner.api.ownerSnapshot().rows,...appOwner.api.snapshot().rows],owners:()=>appOwner.api.ownerSnapshot(),pause:slot=>appOwner.api.pauseOwner(slot),resume:slot=>appOwner.api.resumeOwner(slot),refreshOwners:()=>appOwner.api.changedOwner(),settings:()=>navStore.set({seq:navStore.get().seq+1,route:{panel:'settings',section:'appearance'}}),select:async(mode)=>{const r=await fetch('/probe/select?mode='+mode).then(r=>r.json());appStore.set({prefsRev:r.rev})},sameOwner:()=>appOwner===getAppEffects(),goto:(name)=>navStore.set({seq:navStore.get().seq+1,route:name?{panel:'chat',instance:name}:{panel:'fleet'}}),trust:()=>stockEffectTrust(window,{ownerCss:ownerCssLifecycle.get().state}),off:()=>{savePref('fx.show',false);window.AgendPreview.setOptIn(false)},css:async(on)=>{const r=await fetch('/probe/css?on='+(on?1:0)).then(r=>r.json());appStore.set({prefsRev:r.rev})},cssState:()=>ownerCssLifecycle.get().state,unmount:()=>render(null,document.querySelector('#app')),rev:()=>appStore.set({themesRev:appStore.get().themesRev+1}),reply:()=>{const meta=Object.freeze({source:'sse',receivedAt:performance.now()}),m={boot:'bb',id:50,role:'agent',instance:'worker',sender:'worker',text:'fresh',ts:new Date().toISOString()};handlers.message(m,meta);handlers.agent_reply_live({v:1,boot:'bb',id:50,instance:'worker'},meta)}};
</script>`);
});
let browser:any,port:number;
try{
 server.listen(0,'127.0.0.1');await once(server,'listening');port=(server.address()as any).port;
 preview=createPreviewListener({settings:{enabled:true,port:0,origin:null},healthPort:port,config:{},bootId:'b'.repeat(32)});preview.server.listen(0,'127.0.0.1');await once(preview.server,'listening');
 for(const engine of(process.env.PROBE_ENGINES||'chromium,firefox,webkit').split(',')){
  browser=await pw[engine].launch({headless:true,env:{HOME:join(scratch,'home'),TMPDIR:join(scratch,'tmp'),PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
  for(const width of(process.env.PROBE_WIDTHS||"1366,390").split(",").map(Number)){
   css=false;service.share('bob',{id:ids[2],shared:true});service.share('bob',{id:ids[3],shared:true});choose('all');
   const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[],outside=[];
   await context.addInitScript(n=>{Object.defineProperty(navigator,'hardwareConcurrency',{value:n});Object.defineProperty(navigator,'deviceMemory',{value:n})},width===390?4:8);
   if(engine==='chromium'&&width===390){const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4})}
   page.on('pageerror',e=>errors.push(e.stack||e.message));await page.route('**/*',r=>{const u=new URL(r.request().url());if(['blob:','data:'].includes(u.protocol)||u.hostname==='127.0.0.1'&&[String(port),String(preview.settings.port)].includes(u.port))return r.continue();outside.push(u.origin);return r.abort();});
   const count=width===390?1:3;
   const visible=async(n=count)=>{await page.waitForFunction(n=>document.querySelectorAll('iframe.agend-effect-frame').length===n,n,{timeout:18000});if(n){await page.waitForFunction(()=>[...document.querySelectorAll('iframe.agend-effect-frame')].every(f=>getComputedStyle(f).visibility==='visible'),undefined,{timeout:18000});await page.waitForFunction(n=>probe.rows().filter(r=>r.phase==='running').length===n,n,{timeout:18000})}};
   const blur=async()=>{await page.waitForTimeout(250);await page.evaluate(()=>{const e=document.activeElement;if(e instanceof HTMLElement)e.blur()})};
   try{
    await page.goto('http://127.0.0.1:'+port+'/?lang='+(width===390?'zh-TW':'en'));await page.locator('.p-fleet').waitFor();await visible();
    await page.waitForFunction(()=>probe.cursor().status==='running');
    const cursor=()=>page.locator('#app > .shell').evaluate(el=>getComputedStyle(el).cursor);
    assert.match(await cursor(),/^url\(["']?blob:/);assert.equal(await page.locator('iframe.agend-effect-frame').count(),count);
    assert.equal(await page.locator('.p-fleet .btn').first().evaluate(el=>getComputedStyle(el).cursor),'pointer');
    for(const name of ['worker',null]){await page.evaluate(n=>probe.goto(n),name);await page.locator(name?'.composer':'.p-fleet').waitFor();await blur();await visible();await page.waitForFunction(()=>probe.cursor().status==='running');assert.equal(await page.evaluate(()=>probe.sameOwner()),true)}
    // Stock sidebar dragging must temporarily restore col-resize and then restore the selected cursor.
    await page.evaluate(()=>document.body.classList.add('side-resizing'));await page.waitForFunction(()=>probe.cursor().status==='off');assert.equal(await cursor(),'col-resize');
    await page.evaluate(()=>document.body.classList.remove('side-resizing'));await page.waitForFunction(()=>probe.cursor().status==='running');assert.match(await cursor(),/^url\(["']?blob:/);
    await page.evaluate(()=>probe.preview(false));await page.waitForFunction(()=>probe.cursor().status==='off');assert.equal(await page.locator('[data-agend-effect-cursor]').count(),0);await visible(0);
    // Keep already-read metadata. The next cursor-image authorization, not a metadata refresh, must deny unshare.
    await page.evaluate(async()=>{await fetch('/probe/unshare-cursor');probe.preview(true)});await page.waitForFunction(()=>probe.owners().slots['fx.cursor'].status==='unavailable');assert.equal(await page.locator('[data-agend-effect-cursor]').count(),0);
    assert.equal(prefs.readForViewer('alice').values['fx.cursor'],ids[3]);assert.ok(prefs.ownerEffectReferences().some(r=>r.id===ids[3]));assert.ok(!resourceScopes.includes('fx.cursor'));
    await page.evaluate(()=>probe.settings());await page.locator('[data-owner-clear="fx.cursor"]').waitFor();await page.locator('[data-owner-clear="fx.cursor"]').click();await page.locator('[data-owner-clear="fx.cursor"]').waitFor({state:'detached'});assert.equal(prefs.readForViewer('alice').values['fx.cursor'],undefined);assert.deepEqual(prefWrites.at(-1),{'fx.cursor':null});
    service.share('bob',{id:ids[3],shared:true});await page.evaluate(()=>probe.select('cursor'));await blur();await page.waitForFunction(()=>probe.cursor().status==='running');await page.locator('[data-owner-runtime="fx.cursor"]').waitFor();assert.match(await page.locator('[data-owner-runtime="fx.cursor"]').innerText(),width===390?/播放中/:/Running/);await visible(0);
    await page.screenshot({path:join(out,engine+'-'+width+'-cursor.png')});
    await page.evaluate(()=>{void window.AgendAuth.signOut()});await page.waitForFunction(()=>!document.querySelector('[data-agend-effect-cursor]'));assert.equal(await page.locator('.agend-effect-layer').count(),0);assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
    rows.push({engine,version:browser.version(),width,cpuThrottle:engine==='chromium'&&width===390?4:1,status:'pass',actualShellFleetChatSettings:true,staticAPNGProjection:true,sharedFrameCap:count,cursorDoesNotConsumeFrames:true,noCursorWorkerRead:true,stockDragFallbackAndResume:true,unshareNextImageAuthorization:true,savedReferenceAndClear:true,settingsStatus:true,sameAppOwner:true,activeCursorSignOutCleanup:true});console.log('PASS',engine,width);
   }catch(e){let diagnostic;try{diagnostic=await page.evaluate(()=>({owners:probe.owners(),settingsState:probe.settingsState(),ownerHook:probe.ownerHook(),prefsRev:probe.prefsRev(),selects:[...document.querySelectorAll('[data-owner-slot]')].map(e=>[e.getAttribute('data-owner-slot'),e.value]),trust:probe.trust(),text:document.body.innerText.slice(-1500),frames:[...document.querySelectorAll('iframe')].map(f=>({v:getComputedStyle(f).visibility,z:getComputedStyle(f).zIndex}))}))}catch{}rows.push({engine,width,status:'failed',error:e.message,stack:e.stack,errors,outside,diagnostic});console.log('FAIL',engine,width,e.stack,JSON.stringify(diagnostic))}finally{await context.close()}
  }await browser.close();browser=null;
 }
}finally{
 if(browser)await browser.close();for(const s of [preview?.server,server])if(s?.listening){s.closeAllConnections();s.close();await once(s,'close')}
 writeFileSync(join(out,'receipt.json'),JSON.stringify({rows,passed:rows.filter(r=>r.status==='pass').length,failed:rows.filter(r=>r.status!=='pass').length},null,2));rmSync(scratch,{recursive:true,force:true});
}if(rows.some(r=>r.status!=='pass'))process.exitCode=1;
