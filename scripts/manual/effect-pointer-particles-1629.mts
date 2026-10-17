/** Click sparks: actual stock Shell/Chat + service/library/preview, private synthetic session only.
 * No live fleet/account. Host MessagePort observation never changes or invents packets.
 * Build first. PW_DIR, OUT_DIR, PROBE_ENGINES, PROBE_WIDTHS, PROBE_MODES; Linux WebKit is not Safari. */
import assert from "node:assert/strict";
import { pointerCaseFailure, particlePaintDelta } from "./effect-pointer-evidence.mjs";
import { inflateSync, deflateSync } from "node:zlib";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const pw = createRequire(join(resolve(process.env.PW_DIR!), "package.json"))("playwright");
const out = resolve(process.env.OUT_DIR || ".artifacts/pointer-particles-native"); mkdirSync(out, { recursive: true });
const browserTmpParent=resolve(process.env.PROBE_TMP_DIR||out);mkdirSync(browserTmpParent,{recursive:true});const browserTmp=mkdtempSync(join(browserTmpParent,'b-'));
const scratch = mkdtempSync(join(out, "private-")); mkdirSync(join(scratch, "home")); mkdirSync(join(scratch, "tmp"));
const crc = (data: Buffer) => { let n=0xffffffff;for(const b of data){n^=b;for(let j=0;j<8;j++)n=(n>>>1)^(n&1?0xedb88320:0);}return(n^0xffffffff)>>>0; };
const chunk = (type: string, data: Buffer) => {const name=Buffer.from(type),len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([len,name,data,sum]);};
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6;
const background=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,32,96,224,255]))),chunk('IEND',Buffer.alloc(0))]);
const actions: string[] = [];
const rows: any[] = [], ts = new Date().toISOString();
const stressMs=Number(process.env.PROBE_STRESS_MS||75),stressPeriod=Number(process.env.PROBE_STRESS_PERIOD||180);
assert.ok(Number.isInteger(stressMs)&&stressMs>=50&&stressMs<=200&&Number.isInteger(stressPeriod)&&stressPeriod>=stressMs+15&&stressPeriod<=500,'bounded private load fixture');
const message = { boot: "probe", id: 1, instance: "worker", sender: "worker", role: "agent", text: "Click the plain message text for sparks. Drag across this message to leave a trail. Protected controls stay clear. [This link is protected](https://example.invalid).\n\n```js\nconst n = 1;\n```\n\n```html\n<p>unterminated", ts, attachments:[{id:"d".repeat(32),name:"wide.csv",mime:"text/csv",size:600}], buttons: { id: "a".repeat(32), state: "open", labels: ["Approve", "Decline"] } };
function decode(png){
 assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');let at=8,width=0,height=0,channels=0;const parts=[];
 while(at<png.length){const size=png.readUInt32BE(at),type=png.subarray(at+4,at+8).toString(),data=png.subarray(at+8,at+8+size);at+=size+12;
  if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);assert.equal(data[8],8);channels=data[9]===2?3:data[9]===6?4:0;assert.ok(channels);assert.equal(data[12],0);assert.ok(width*height<2e6);}
  if(type==='IDAT')parts.push(data);if(type==='IEND')break;
 }
 const raw=inflateSync(Buffer.concat(parts)),stride=width*channels,rows=Buffer.alloc(stride*height);assert.equal(raw.length,(stride+1)*height);
 const paeth=(a,b,c)=>{const p=a+b-c,A=Math.abs(p-a),B=Math.abs(p-b),C=Math.abs(p-c);return A<=B&&A<=C?a:B<=C?b:c;};
 for(let row=0;row<height;row++){const filter=raw[row*(stride+1)];assert.ok(filter<=4);for(let i=0;i<stride;i++){const left=i>=channels?rows[row*stride+i-channels]:0,up=row?rows[(row-1)*stride+i]:0,corner=row&&i>=channels?rows[(row-1)*stride+i-channels]:0;rows[row*stride+i]=(raw[row*(stride+1)+i+1]+(filter===0?0:filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):paeth(left,up,corner)))&255;}}
 return {width,height,channels,data:rows};
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
const resourceScopes: string[] = [], prefWrites: any[] = [];
let preview:any,css=false,rev=1,resources=0,epoch='e'.repeat(16),profileWrites=0;
const service=new WebEffectService({library,themes,profiles,prefs,known:n=>['worker','worker-b'].includes(n),changed:()=>rev++});
library.registerReferenceSource('themes',()=>themes.placedEffects().flatMap(p=>p.ids.map(id=>({id,holder:'instance:'+p.name}))));
library.registerReferenceSource('owner-prefs',()=>prefs.ownerEffectReferences());
const sampleFiles=new Map(['effect.json','worker.js'].map(name=>[name,readFileSync(join('docs/examples/click-sparks',name))]));
if(process.env.PROBE_MUTATION==='no-paint')sampleFiles.set('worker.js',Buffer.from(sampleFiles.get('worker.js').toString().replace('ctx.fill();','void 0;')));
const uploaded=service.upload('alice',encodeEffectFiles(sampleFiles));assert.equal(typeof uploaded.id,'string');
const ids=[uploaded.id];
const staged=library.stage(sampleFiles,{kind:'agent',id:'worker'});assert.equal(staged.ok,true);if(!staged.ok)throw Error('agent stage');assert.equal(library.commit(staged.stageId).ok,true);
const {WebEffectTools}=await import('../../dist/web-effect-tools.js');
const {AppearanceLimiter}=await import('../../dist/web-appearance-policy.js');
const tools=new WebEffectTools({library,limiter:new AppearanceLimiter(),authorize:()=>null,placed:name=>themes.get(name)?.placements?.effects||[],place:(name,effects)=>themes.setPlacements(name,{effects},'agent',()=>null),changed:()=>rev++,preview:async()=>({}),profiles:()=>({})});
function choose(mode){
 assert.equal(themes.setPlacements('worker',{effects:[]},'human',()=>null).ok,true);
 if(mode==='chat'){const r=tools.apply('worker',{id:ids[0]});assert.equal(r.id,ids[0]);}
 const values={'fx.page':mode==='page'?ids[0]:null,'fx.box':mode==='box'?ids[0]:null};
 const r=prefs.writeForViewer('alice',new Map(Object.entries(values)),{validateEffect:(person,key,id)=>service.validateOwnerSelection(person,key,id)});assert.equal(r.ok,true);if(!r.ok)throw Error('selection');return r.view.rev;
}
const config={defaults:{backend:'codex'},instances:{worker:{working_directory:'/inert'}},channels:[]};
const server=createServer(async(req,res)=>{
 const u=new URL(req.url||'/','http://localhost'),p=u.pathname;
 if(/^\/assets\/[a-z0-9._-]+$/.test(p)||/^\/ui\/js\/[a-z0-9_-]+\.js$/.test(p)){
  try{res.setHeader('Content-Type',p.endsWith('.css')?'text/css':p.endsWith('.woff2')?'font/woff2':'text/javascript');let file=readFileSync(join('src/ui',p.startsWith('/assets/')?'shared':'',p.split('/').at(-1)));if(p==='/assets/effect-registry.js'&&process.env.PROBE_MUTATION==='old-focus')file=Buffer.from(file.toString().replace(' || stockMain',''));if(p==='/assets/effect-registry.js'&&process.env.PROBE_MUTATION==='overwrite-discrete')file=Buffer.from(file.toString().replace('kind !== "move" || !s.pointer || s.pointer.fields.kind === "move" || at - s.pointer.at > 100', 'true'));if(p==='/assets/effect-registry.js'&&process.env.PROBE_MUTATION==='drop-pending')file=Buffer.from(file.toString().replace('const packet = s.pointer;', 'const packet = s.pointer; s.pointer = null;'));res.end(file);}catch{res.statusCode=404;res.end();}return;
 }
 if(p==='/ui/owner-css.css'){res.setHeader('Content-Type','text/css');res.end('/* neutral owner CSS; still blocks agent front */');return;}
 if(p!=='/'&&!p.startsWith('/ui/chat/')){
  res.setHeader('Content-Type','application/json');let answer:any={ok:true,instances:[],themes:{},records:[],entries:[]};
  if(p==='/ui/effects/owner')answer=service.ownerSelections('alice');
  else if(p==='/ui/effects')answer={...service.list('alice'),canWrite:true};
  else if(p.startsWith('/ui/effects/')){
   assert.equal(u.searchParams.get('ownerEpoch'),epoch);
   if(p==='/ui/effects/placements'){assert.ok(['worker','worker-b'].includes(u.searchParams.get('instance')!));answer=service.placements('alice',u.searchParams.get('instance'));}
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
 const mode=u.searchParams.get('mode')==='dark'?'dark':'light';const bootPrefs=JSON.stringify({rev:prefs.rev(),values:{theme:mode,'preview.optIn':true,'fx.show':true},ownerScope:'person',ownerEpoch:epoch});
 res.setHeader('Content-Type','text/html');res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'self' 'nonce-chat-probe'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-src ${previewOrigin}/frame ${previewOrigin}/effect; worker-src 'none'; object-src 'none'; base-uri 'none'`);
 res.end(`<!doctype html><html data-theme="${mode}" data-prefs='${bootPrefs}'><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><link rel=stylesheet href=/assets/tokens.css><link rel=stylesheet href=/assets/app.css><body data-mode=full data-dashboard-origin="${origin}" data-preview-origin="${previewOrigin}" data-preview-boot="${'b'.repeat(32)}" data-owner-css-state=off><div id=app class=app-root></div><script src=/assets/agend-auth.js></script><script src=/ui/js/preview.js></script><script type=module nonce=chat-probe>
import{html,render}from'/assets/app-html.js';import{Shell,showDialog,closeDialog}from'/assets/app-shell.js';import{appStore}from'/assets/app-store.js';import{navStore}from'/assets/app-nav.js';import{ChatPanel,boot}from'/ui/js/panel-chat.js';import{FleetPanel}from'/ui/js/panel-fleet.js';import{SettingsPanel}from'/ui/js/panel-settings.js';import{getAppEffects}from'/ui/js/app-effects.js';import{ownerEffectsStore}from'/assets/owner-effect-prefs.js';import{installOwnerCss,ownerCssLifecycle}from'/assets/owner-css.js';import{setLang}from'/assets/app-i18n.js';import{stockEffectTrust}from'/assets/effect-stock-trust.js';import{Dialog}from'/assets/ui-dialog.js';import{savePref,bootPrefs}from'/assets/app-prefs.js';
setLang(new URL(location.href).searchParams.get('lang')||'en',{store:false});localStorage.setItem('agend_tour_seen','1');window.AgendPreview.setOptIn(true);bootPrefs();installOwnerCss();
appStore.set({ready:true,connection:'live',instances:[{name:'worker',backend:'codex',status:'running',state:'idle',card_v:'probe-card'},{name:'worker-b',backend:'codex',status:'running',state:'idle',card_v:'probe-card'}],exec:{worker:'idle','worker-b':'idle'},awaiting:{},themesRev:1,prefsRev:${prefs.rev()},connections:1});navStore.set({route:{panel:'chat',instance:'worker'},seq:1});
const handlers={};const store=boot({stream:{on(k,fn){handlers[k]=fn;return()=>delete handlers[k]}},boot:document.body.dataset,deps:{announce(){},toast(){}}});
render(html\`<\${Shell} panels=\${new Map([['chat',{Component:ChatPanel}],['fleet',{Component:FleetPanel}],['settings',{Component:SettingsPanel}]])} onNewInstance=\${()=>{}} />\`,document.querySelector('#app'));
const appOwner=getAppEffects();const ownerHook=()=>{const stack=[document.querySelector('#app').__k];let i=0;while(stack.length&&i++<5000){const v=stack.pop();if(!v)continue;if(v.type?.name==='OwnerEffects')return{dirty:v.__c?.__d,state:v.__c?.__H?.__[0]?.__?.[0],pending:v.__c?.__H?.__[0]?.__N?.[0]};if(Array.isArray(v.__k))stack.push(...v.__k)}return null};
window.probe={dialog:()=>showDialog(Dialog,{title:'Protected dialog',children:'No particle input here'}),closeDialog,ownerHook,settingsState:()=>ownerEffectsStore.get(),prefsRev:()=>appStore.get().prefsRev,rows:()=>[...appOwner.api.ownerSnapshot().rows,...appOwner.api.snapshot().rows],owners:()=>appOwner.api.ownerSnapshot(),pause:slot=>appOwner.api.pauseOwner(slot),resume:slot=>appOwner.api.resumeOwner(slot),refreshOwners:()=>appOwner.api.changedOwner(),settings:()=>navStore.set({seq:navStore.get().seq+1,route:{panel:'settings',section:'appearance'}}),select:async(mode)=>{const r=await fetch('/probe/select?mode='+mode).then(r=>r.json());appStore.set({prefsRev:r.rev})},sameOwner:()=>appOwner===getAppEffects(),goto:(name)=>navStore.set({seq:navStore.get().seq+1,route:name?{panel:'chat',instance:name}:{panel:'fleet'}}),trust:()=>stockEffectTrust(window,{ownerCss:ownerCssLifecycle.get().state}),off:()=>{savePref('fx.show',false);window.AgendPreview.setOptIn(false)},css:async(on)=>{const r=await fetch('/probe/css?on='+(on?1:0)).then(r=>r.json());appStore.set({prefsRev:r.rev})},cssState:()=>ownerCssLifecycle.get().state,unmount:()=>{appOwner.dispose();render(null,document.querySelector('#app'))},rev:()=>appStore.set({themesRev:appStore.get().themesRev+1}),reply:()=>{const meta=Object.freeze({source:'sse',receivedAt:performance.now()}),m={boot:'bb',id:50,role:'agent',instance:'worker',sender:'worker',text:'fresh',ts:new Date().toISOString()};handlers.message(m,meta);handlers.agent_reply_live({v:1,boot:'bb',id:50,instance:'worker'},meta)}};
</script>`);
});
let browser:any,port:number;
try {
 server.listen(0,'127.0.0.1');await once(server,'listening');port=(server.address()as any).port;
 preview=createPreviewListener({settings:{enabled:true,port:0,origin:null},healthPort:port,config:{},bootId:'b'.repeat(32)});preview.server.listen(0,'127.0.0.1');await once(preview.server,'listening');
 for(const engine of(process.env.PROBE_ENGINES||'chromium,firefox,webkit').split(',')){
  browser=await pw[engine].launch({headless:true,env:{HOME:join(scratch,'home'),TMPDIR:browserTmp,PATH:'/usr/bin:/bin',LANG:'C.UTF-8',FONTCONFIG_FILE:'/etc/fonts/fonts.conf'}});
  for(const width of(process.env.PROBE_WIDTHS||'1366,390').split(',').map(Number))for(const mode of(process.env.PROBE_MODES||'light,dark').split(','))for(const selectedSurface of(process.env.PROBE_SURFACES||'chat,page,box').split(','))for(const group of(process.env.PROBE_GROUPS||'clicks,protected,drag-slow,drag-fast,degraded,touch').split(',')){
   if(!['all','clicks','protected','drag-slow','drag-fast','degraded','coalesced-click','touch'].includes(group))throw Error('unknown PROBE_GROUPS');
   if(group==='touch'&&(width!==390||engine==='firefox'))continue;
   const context=await browser.newContext({viewport:{width,height:900},colorScheme:mode,hasTouch:width===390&&engine!=='firefox'}),page=await context.newPage(),errors=[],outside=[];
   await context.addInitScript(cores=>{
    Object.defineProperty(navigator,'hardwareConcurrency',{value:cores});Object.defineProperty(navigator,'deviceMemory',{value:cores});
    // Observe the real outbound host port. No packet alteration, fabricated events or Worker reply channel.
    window.pointerPackets=[];window.pointerNative=[];window.pointerFrames=0;
    const nativeRaf=requestAnimationFrame.bind(window);
    Object.defineProperty(window,'requestAnimationFrame',{value(fn){return nativeRaf(t=>{window.pointerFrames++;Reflect.apply(fn,window,[t])})}});
    const nativeNow=performance.now.bind(performance);
    Object.defineProperty(performance,'now',{value(){const n=nativeNow();window.pointerClock=n;return n}});
    // The last native clock read is during final factory validation, not necessarily the registry's acceptance clock.
    const post=MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage=function(value,...args){if(value?.type==='env')window.pointerQuality=value.quality;if(value?.type==='pointer')window.pointerPackets.push({...value,validatedAt:window.pointerClock,postedAt:nativeNow(),quality:window.pointerQuality});return Reflect.apply(post,this,[value,...args])};
    for(const type of ['pointerdown','pointermove','pointerup','pointercancel','click'])addEventListener(type,e=>{if(e.isTrusted)window.pointerNative.push({type,at:performance.now(),buttons:e.buttons,focus:document.activeElement?.tagName,editable:document.activeElement?.isContentEditable})});
   },width===390?4:8);
   page.on('pageerror',e=>errors.push(e.stack||e.message));
   await page.route('**/*',r=>{const u=new URL(r.request().url());if(['blob:','data:'].includes(u.protocol)||u.hostname==='127.0.0.1'&&[String(port),String(preview.settings.port)].includes(u.port))return r.continue();outside.push(u.origin);return r.abort()});
   const prefix=engine+'-'+width+'-'+mode+'-'+selectedSurface+'-'+group,record={engine,version:browser.version(),width,mode,selectedSurface,group,stress:{ms:stressMs,period:stressPeriod},timings:[],surfaces:[],errors,outside,status:'pass'};
   const running=async()=>{await page.waitForFunction(()=>probe.rows().filter(r=>r.phase==='running').length===1,undefined,{timeout:20000});await page.waitForFunction(()=>[...document.querySelectorAll('iframe.agend-effect-frame')].some(f=>getComputedStyle(f).visibility==='visible'),undefined,{timeout:20000})};
   const reset=async()=>{await page.waitForTimeout(1350);await page.evaluate(()=>{document.activeElement?.blur?.();window.pointerPackets=[];window.pointerNative=[]});await page.waitForTimeout(70)};
   const shot=async(label)=>{const name=prefix+'-'+label+'.png';const before=await page.evaluate(()=>({at:performance.now(),frames:window.pointerFrames,fonts:document.fonts.status,visible:document.visibilityState,focus:document.hasFocus(),rows:probe.rows()}));if(engine==='firefox'&&process.env.PROBE_RAW_SCREENSHOT!=='0'){const impl=page._connection.toImpl(page);const result=await impl.delegate._session.send('Page.screenshot',{mimeType:'image/png',clip:{x:0,y:0,width,height:900},omitDeviceScaleFactor:true});writeFileSync(join(out,name),Buffer.from(result.data,'base64'));}else await page.screenshot({path:join(out,name),caret:'initial',animations:'allow'});const after=await page.evaluate(()=>({at:performance.now(),frames:window.pointerFrames}));record.timings.push({label,file:name,before,after});return name};
   const packets=()=>page.evaluate(()=>({packets:window.pointerPackets,native:window.pointerNative,focus:{tag:document.activeElement?.tagName,id:document.activeElement?.id,editable:document.activeElement?.isContentEditable}}));
   const point=async(selector,protectedPoint=false)=>page.evaluate(({selector,protectedPoint})=>{
    const frame=document.querySelector('iframe.agend-effect-frame'),fr=frame?.getBoundingClientRect();if(!fr)return null;
    const root=selector?document.querySelector(selector):document.querySelector('.thread');if(!root)return null;const r=root.getBoundingClientRect();
    for(let y=Math.max(2,r.top+10);y<Math.min(innerHeight-4,r.bottom-3);y+=9)for(let x=Math.max(2,r.left+10);x<Math.min(innerWidth-4,r.right-3);x+=9){
     const hit=document.elementFromPoint(x,y),inside=x>fr.left+6&&x<fr.right-6&&y>fr.top+6&&y<fr.bottom-6;
     if(!hit||!root.contains(hit))continue;
     if(protectedPoint?!!hit.closest('[data-trust]'):inside&&!hit.closest('[data-trust]')&&(!selector?!hit.closest('.msg'):true))return{x,y,inside,tag:hit.tagName,trust:hit.closest('[data-trust]')?.getAttribute('data-trust')||null};
    }return null;
   },{selector,protectedPoint});
   try{
    for(const surface of [selectedSurface]){
     choose(surface);await page.goto('http://127.0.0.1:'+port+'/ui/chat/worker?mode='+mode);await page.bringToFront();await page.locator('.composer').waitFor();await page.evaluate(()=>document.activeElement?.blur?.());await running();
     const cases=[],surfaceRecord={surface,cases};record.surfaces.push(surfaceRecord);
     const testClick=async(label,p,allowed)=>{
      if(!p){cases.push({label,expected:allowed?'sparks':'suppressed',status:'FINDING:no-unprotected-point'});return}
      await reset();const before=await shot(surface+'-'+label+'-before');await page.mouse.click(p.x,p.y);await page.waitForTimeout(180);const after=await shot(surface+'-'+label+'-after');const seen=await packets();
      const received=seen.packets.filter(e=>['down','click'].includes(e.kind));
      const paint={pending:true};
      cases.push({label,point:p,paint,expected:allowed?'sparks':'suppressed',status:allowed?received.length?'delivered':'FINDING:no-burst-packet':seen.packets.length?'FAIL:protected-packet':'suppressed',...seen,before,after});
      if(!allowed)assert.equal(seen.packets.length,0,label+' protected');
     };
     const empty=await point(null),bubble=await point('.msg.agent .md');assert.ok(empty,'unprotected point in declared region');
     if(group==='all'||group==='clicks'){await testClick('empty',empty,true);await testClick('bubble',bubble,true);}
     if(group==='all'||group==='protected'){
     await testClick('composer',await point('.composer textarea',true),false);
     await testClick('button',await point('.rb-row button',true)||await point('.panel-head button[aria-haspopup=menu]',true),false);if(await page.locator('.menu-list').count()){await page.keyboard.press('Escape');await page.evaluate(()=>document.activeElement?.blur?.());await running()}
     // Open the real host menu by a trusted browser click, then click a harmless area of its protected surface.
     await reset();const menuButton=page.locator('.panel-head .menu button').first();
     const headButtons=await page.locator('.panel-head button').evaluateAll(es=>es.map(e=>({label:e.getAttribute('aria-label'),title:e.title,text:e.textContent})));surfaceRecord.headButtons=headButtons;
     const more=page.locator('.panel-head button').filter({hasText:'⋯'}).first();
     const moreCandidate=await more.count()?more:page.locator('.panel-head button[aria-haspopup="menu"]').first();
     if(await moreCandidate.count()){
      await moreCandidate.click();await page.waitForTimeout(80);const opening=await packets();assert.equal(opening.packets.length,0,'protected menu button');const buttonIndex=cases.findIndex(c=>c.label==='button');if(buttonIndex>=0)cases[buttonIndex]={label:'button',expected:'suppressed',status:'suppressed',...opening,after:await shot(surface+'-button')};const menu=page.locator('.menu-list').first();
      if(await menu.count()){const b=await menu.boundingBox();await page.evaluate(()=>{window.pointerPackets=[];window.pointerNative=[]});await page.mouse.click(b.x+1,b.y+1);await page.waitForTimeout(50);const seen=await packets();assert.equal(seen.packets.length,0);cases.push({label:'menu',expected:'suppressed',status:'suppressed',...seen,after:await shot(surface+'-menu')});await page.keyboard.press('Escape');}
     }else cases.push({label:'menu',status:'FINDING:menu-locator'});
     await page.evaluate(()=>probe.dialog());await page.locator('dialog[open]').waitFor();await page.evaluate(()=>{window.pointerPackets=[];window.pointerNative=[]});const db=await page.locator('dialog .dlg-body').boundingBox();await page.mouse.click(db.x+db.width/2,db.y+db.height/2);await page.waitForTimeout(70);assert.equal((await packets()).packets.length,0);cases.push({label:'dialog',status:'suppressed',expected:'suppressed',after:await shot(surface+'-dialog')});await page.evaluate(()=>probe.closeDialog());await page.evaluate(()=>document.activeElement?.blur?.());await running();}
     if(empty)for(const [label,steps,delay]of[['drag-slow',12,55],['drag-fast',80,0]]){
      if(group!=='all'&&group!==label)continue;
      await reset();const before=await shot(surface+'-'+label+'-before');await page.mouse.move(empty.x,empty.y);await page.waitForTimeout(70);await page.mouse.down();
      // Native trusted mouse moves; constrain path to a short horizontal unprotected span.
      const end=await page.evaluate(p=>{let x=p.x;for(let n=1;n<=100;n++){const hit=document.elementFromPoint(p.x+n,p.y);if(p.x+n>=innerWidth-8||!hit||hit.closest('[data-trust]'))break;x=p.x+n}return x},empty);
      for(let i=1;i<=steps;i++){await page.mouse.move(empty.x+(end-empty.x)*i/steps,empty.y);if(delay)await page.waitForTimeout(delay)}
      await page.waitForTimeout(180);const after=await shot(surface+'-'+label+'-after');await page.mouse.up();const seen=await packets(),held=seen.packets.filter(e=>e.buttons&1),gaps=held.slice(1).map((e,i)=>e.validatedAt-held[i].validatedAt);
      if(!held.length)surfaceRecord.finding='native drag receives no held samples';cases.push({label,point:empty,end:{x:end,y:empty.y},paint:{pending:true},status:held.length?'delivered':'FINDING:no-held-samples',expected:'trail',...seen,gaps,before,after});
     }
     if((group==='all'||group==='touch')&&width===390&&engine!=='firefox'&&empty){
      await reset();await page.touchscreen.tap(empty.x,empty.y);await page.waitForTimeout(65);const seen=await packets();cases.push({label:'touch-tap',optional:true,status:seen.packets.some(e=>e.kind==='click'||e.kind==='down')?'delivered':'FINDING:no-burst-packet',...seen,after:await shot(surface+'-touch-tap')});
      if(engine==='chromium'){
       await reset();const cdp=await context.newCDPSession(page);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:empty.x,y:empty.y}]});for(let n=1;n<=8;n++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:empty.x+n*3,y:empty.y}]});await page.waitForTimeout(45)}const after=await shot(surface+'-touch-drag');await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});cases.push({label:'touch-drag',optional:true,...await packets(),after,status:'observed-native-touch'});await cdp.detach();
      }
     }
     if((group==='all'||group==='degraded')&&empty){
      await reset();const lowPoint=await point(null);assert.ok(lowPoint,'fresh unprotected point after touch');const before=await shot(surface+'-drag-degraded-before');await page.evaluate(({ms,period})=>{window.pointerStress=setInterval(()=>{const end=performance.now()+ms;while(performance.now()<end){}},period)},{ms:stressMs,period:stressPeriod});
      try{
       await page.waitForFunction(()=>probe.rows().some(r=>r.quality==='low'),undefined,{timeout:5000});
       await page.evaluate(()=>{clearInterval(window.pointerStress);window.pointerPackets=[];window.pointerNative=[]});
       await page.mouse.move(lowPoint.x,lowPoint.y);await page.mouse.down();
       for(let n=1;n<=12;n++){await page.mouse.move(lowPoint.x+n*2,lowPoint.y);await page.waitForTimeout(8)}
       await page.waitForTimeout(100);const after=await shot(surface+'-drag-degraded');await page.mouse.up();const seen=await packets(),held=seen.packets.filter(e=>e.buttons&1),gaps=held.slice(1).map((e,i)=>e.validatedAt-held[i].validatedAt);
       cases.push({label:'drag-degraded',point:lowPoint,end:{x:lowPoint.x+24,y:lowPoint.y},paint:{pending:true},before,expected:'trail capped at30Hz',status:held.length>=2?'delivered':'FINDING:no-degraded-held-samples',...seen,gaps,after});assert.ok(held.length>=2,'degraded samples present');
       // Send timestamps include final factory validation/IPC latency; gaps observe pacing, not the exact acceptance clock.
      }finally{await page.evaluate(()=>clearInterval(window.pointerStress))}
     }
     if(group==='coalesced-click'&&empty){
      await reset();const p=await point(null);assert.ok(p);const before=await shot(surface+'-coalesced-before');
      await page.evaluate(({ms,period})=>{window.pointerStress=setInterval(()=>{const end=performance.now()+ms;while(performance.now()<end){}},period)},{ms:stressMs,period:stressPeriod});
      try{
       await page.waitForFunction(()=>probe.rows().some(r=>r.quality==='low'),undefined,{timeout:5000});
       await page.evaluate(()=>{clearInterval(window.pointerStress);window.pointerPackets=[];window.pointerNative=[]});
       // Prime a real low-quality move, then click and move again. Driver latency may cross
       // a send interval; deterministic unit clocks separately pin the exact 1ms interleaving.
       await page.mouse.move(p.x,p.y);await page.waitForFunction(()=>window.pointerPackets.some(e=>e.kind==='move'&&e.quality==='low'),undefined,{timeout:1000});
       await page.mouse.click(p.x,p.y);await page.mouse.move(p.x+1,p.y);await page.waitForTimeout(120);const after=await shot(surface+'-coalesced-after'),seen=await packets();
       cases.push({label:'coalesced-click',expected:'sparks',point:p,paint:{pending:true},before,after,status:seen.packets.some(e=>e.kind==='click'||e.kind==='down')?'delivered':'FINDING:no-burst-packet',...seen});
      }finally{await page.evaluate(()=>clearInterval(window.pointerStress))}
     }
     // Keep packet evidence; screenshots are checked separately for actual paint, never inferred from this spy.
     await page.evaluate(()=>probe.unmount());await page.waitForFunction(()=>document.querySelectorAll('iframe.agend-effect-frame').length===0);
    }
    for(const surface of record.surfaces)for(const c of surface.cases)if(c.paint?.pending&&c.point&&c.before&&c.after){
     c.paint=particlePaintDelta(decode(readFileSync(join(out,c.before))),decode(readFileSync(join(out,c.after))),c.point,c.end);
     c.capture=Object.fromEntries(['before','after'].map(k=>{const t=record.timings.find(t=>t.file===c[k]);return[k,t?t.after.at-t.before.at:null]}));
    }
    assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);record.findings=record.surfaces.flatMap(s=>s.cases.map(c=>({surface:s.surface,label:c.label,status:pointerCaseFailure(c)})).filter(c=>c.status));const required={clicks:['empty','bubble'],protected:['composer','button','menu','dialog'],'drag-slow':['drag-slow'],'drag-fast':['drag-fast'],degraded:['drag-degraded'],'coalesced-click':['coalesced-click'],touch:[]};for(const label of required[group]??[])if(!record.surfaces.some(s=>s.cases.some(c=>c.label===label)))record.findings.push({label,status:'required case missing'});record.status=record.findings.length?'failed':'pass';console.log(record.findings.length?'FINDINGS':'PASS',prefix,JSON.stringify(record.findings));
   }catch(e){record.status='failed';record.error=e.message;record.stack=e.stack;record.history=service.profile('alice',ids[0]);record.diagnostic=await page.evaluate(()=>({rows:window.probe?.rows(),trust:window.probe?.trust(),text:document.body.innerText.slice(-1200)})).catch(()=>null);console.log('FAIL',prefix,e.stack,JSON.stringify(record.diagnostic));}
   finally{rows.push(record);writeFileSync(join(out,'receipt.json'),JSON.stringify({source:'actual Shell/Chat + built private service/library/preview; synthetic auth, no live fleet',rows},null,2));await context.close()}
  }await browser.close();browser=null;
 }
}finally{
 if(browser)await browser.close();for(const s of[preview?.server,server])if(s?.listening){s.closeAllConnections();s.close();await once(s,'close')}
 rmSync(scratch,{recursive:true,force:true});rmSync(browserTmp,{recursive:true,force:true});
}if(rows.some(r=>r.status!=='pass'))process.exitCode=1;
