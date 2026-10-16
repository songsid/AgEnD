/** Actual static-poster Chat mount; private synthetic session projection, not a real public TLS/tunnel. Gateway HTTP is tested separately. No fleet/account/service. Linux WebKit is not Safari. Build first. */
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
const background=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,255,20,20,255]))),chunk('IEND',Buffer.alloc(0))]);
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
const library=new WebEffectLibrary(scratch),themes=new ThemeStore(scratch),profiles=new WebEffectProfiles(scratch);
let preview:any,css=false,rev=1,resources=0,epoch='e'.repeat(16),profileWrites=0,scenario='optout',fxShow=true,posterReads=0;
const service=new WebEffectService({library,themes,profiles,known:n=>n==='worker',changed:()=>rev++});
library.registerReferenceSource('themes',()=>themes.placedEffects().flatMap(p=>p.ids.map(id=>({id,holder:'instance:'+p.name}))));
const ids=[];
for(let n=0;n<2;n++){
 const worker=`const c=agend.canvas.getContext('2d');let color='#ff1414';const paint=()=>{c.fillStyle=color;c.fillRect(0,0,agend.canvas.width,agend.canvas.height)};paint();agend.on('env',paint);agend.on('reply',()=>{color='#14ff14';paint()});agend.ready();`;
 const files=new Map([['effect.json',Buffer.from(JSON.stringify({v:1,runtime:'canvas-worker-v1',worker:'worker.js',name:'native-'+n,title:'Native '+n,regions:['chat'],layer:n===0?'front':'behind',wants:['reply','pointer','state','theme'],poster:'poster.png'}))],['worker.js',Buffer.from(worker)],['poster.png',background]]);
 const r=service.upload('alice',encodeEffectFiles(files));assert.equal(typeof r.id,'string');ids.push(r.id);
}
assert.equal(themes.setPlacements('worker',{effects:ids.map(id=>({id}))},'agent',()=>null).ok,true);
const server=createServer(async(req,res)=>{
 const u=new URL(req.url||'/','http://localhost'),p=u.pathname;
 if(/^\/assets\/[a-z0-9._-]+$/.test(p)||/^\/ui\/js\/[a-z0-9_-]+\.js$/.test(p)){
  try{res.setHeader('Content-Type',p.endsWith('.css')?'text/css':p.endsWith('.woff2')?'font/woff2':'text/javascript');res.end(readFileSync(join('src/ui',p.startsWith('/assets/')?'shared':'',p.split('/').at(-1))));}catch{res.statusCode=404;res.end();}return;
 }
 if(p==='/ui/owner-css.css'){res.setHeader('Content-Type','text/css');res.end('/* neutral owner CSS; still blocks agent front */');return;}
 if(p!=='/'){
  res.setHeader('Content-Type','application/json');let answer:any={ok:true,instances:[],themes:{},records:[],entries:[]};
  if(p==='/ui/effect-posters'){posterReads++;answer=service.posterPlacements('worker');}
  else if(/^\/ui\/effect-posters\/[a-f0-9]{32}\.png$/.test(p)){posterReads++;const r=service.placedPoster(p.split('/').at(-1).slice(0,-4),'worker');res.setHeader('Content-Type','image/png');res.statusCode=r.ok?200:404;res.end(r.ok?r.bytes:undefined);return;}
  else if(p.startsWith('/ui/effects/')){
   assert.equal(u.searchParams.get('instance'),'worker');assert.equal(u.searchParams.get('ownerEpoch'),epoch);
   if(p==='/ui/effects/placements')answer=service.placements('alice','worker');
   else if(p.startsWith('/ui/effects/resource/')){resources++;answer=service.resource('alice',p.split('/').at(-1),'worker');}
   else if(p.startsWith('/ui/effects/profile/')){let body='';for await(const b of req)body+=b;answer=service.report('alice',p.split('/').at(-1),JSON.parse(body));if(!answer.error)profileWrites++;}
  }else if(p==='/auth/session')answer={csrf:'probe-csrf',handle:epoch,tier:'admin'};
  else if(p==='/auth/logout'){return;}// Held to prove synchronous teardown before logout completes.
  else if(p==='/ui/owner-css/state')answer={active:css?'a'.repeat(32):null,effectState:css?'on':'off',pending:null};
  else if(p==='/ui/history')answer={messages:[message]};
  else if(p==='/api/card/worker')answer={tagline:{text:'Real Chat card',by:'agent'}};
  else if(p==='/ui/prefs'){
   if(req.method==='POST'){let text='';for await(const b of req)text+=b;const input=JSON.parse(text||'{}');if(Object.hasOwn(input.set||{},'fx.show'))fxShow=input.set['fx.show']!==false;rev++;}
   answer={rev,values:{'preview.optIn':scenario!=='optout','fx.show':fxShow},ownerScope:'person',ownerEpoch:epoch};
  }
  else if(p==='/probe/css'){css=u.searchParams.get('on')==='1';rev++;answer={rev};}
  else if(p==='/probe/status')answer={resources,profileWrites};
  if(answer.error){res.statusCode=400;}res.end(JSON.stringify(answer));return;
 }
 const origin='http://127.0.0.1:'+port,previewOrigin='http://127.0.0.1:'+preview.settings.port;
 const prefs=JSON.stringify({rev,values:{'preview.optIn':scenario!=='optout','fx.show':fxShow},ownerScope:'person',ownerEpoch:epoch});
 res.setHeader('Content-Type','text/html');res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'self' 'nonce-chat-probe'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; frame-src ${previewOrigin}/frame ${previewOrigin}/effect; worker-src 'none'; object-src 'none'; base-uri 'none'`);
 res.end(`<!doctype html><html data-prefs='${prefs}'><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><link rel=stylesheet href=/assets/tokens.css><link rel=stylesheet href=/assets/app.css><body data-mode=full data-public-link="${scenario==='public'?'1':'0'}" data-dashboard-origin="${origin}" data-preview-origin="${scenario==='unavailable'?'':previewOrigin}" data-preview-boot="${'b'.repeat(32)}" data-owner-css-state=off><div id=app class=app-root></div><script src=/assets/agend-auth.js></script><script src=/ui/js/preview.js></script><script type=module nonce=chat-probe>
import{html,render}from'/assets/app-html.js';import{Shell}from'/assets/app-shell.js';import{appStore}from'/assets/app-store.js';import{navStore}from'/assets/app-nav.js';import{ChatPanel,boot}from'/ui/js/panel-chat.js';import{installOwnerCss,ownerCssLifecycle}from'/assets/owner-css.js';import{setLang}from'/assets/app-i18n.js';import{stockEffectTrust}from'/assets/effect-stock-trust.js';import{savePref,bootPrefs}from'/assets/app-prefs.js';import{setThemesShown}from'/assets/app-themes.js';
setLang(new URL(location.href).searchParams.get('lang')||'en',{store:false});localStorage.setItem('agend_tour_seen','1');window.AgendPreview.setOptIn(${scenario!=='optout'});bootPrefs();installOwnerCss();
appStore.set({ready:true,connection:'live',instances:[{name:'worker',backend:'codex',status:'running',state:'idle',card_v:'probe-card'}],exec:{worker:'idle'},awaiting:{},themesRev:1,prefsRev:1,connections:1});navStore.set({route:{panel:'chat',instance:'worker'},seq:1});
const handlers={};const store=boot({stream:{on(k,fn){handlers[k]=fn;return()=>delete handlers[k]}},boot:document.body.dataset,deps:{announce(){},toast(){}}});
render(html\`<\${Shell} panels=\${new Map([['chat',{Component:ChatPanel}]])} onNewInstance=\${()=>{}} />\`,document.querySelector('#app'));
window.probe={trust:()=>stockEffectTrust(window,{ownerCss:ownerCssLifecycle.get().state}),off:()=>setThemesShown(false),on:()=>setThemesShown(true),css:async(on)=>{const r=await fetch('/probe/css?on='+(on?1:0)).then(r=>r.json());appStore.set({prefsRev:r.rev})},cssState:()=>ownerCssLifecycle.get().state,unmount:()=>render(null,document.querySelector('#app')),rev:()=>appStore.set({themesRev:appStore.get().themesRev+1}),reply:()=>{const meta=Object.freeze({source:'sse',receivedAt:performance.now()}),m={boot:'bb',id:50,role:'agent',instance:'worker',sender:'worker',text:'fresh',ts:new Date().toISOString()};handlers.message(m,meta);handlers.agent_reply_live({v:1,boot:'bb',id:50,instance:'worker'},meta)}};
</script>`);
});
let browser:any,port:number;
try{
 server.listen(0,'127.0.0.1');await once(server,'listening');port=(server.address()as any).port;
 preview=createPreviewListener({settings:{enabled:true,port:0,origin:null},healthPort:port,config:{},bootId:'b'.repeat(32)});preview.server.listen(0,'127.0.0.1');await once(preview.server,'listening');
 for(const engine of(process.env.PROBE_ENGINES||'chromium,firefox,webkit').split(',')){
  browser=await pw[engine].launch({headless:true,env:{HOME:join(scratch,'home'),TMPDIR:join(scratch,'tmp'),PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
  for(const width of [1366,390])for(const kind of ['optout','public','unavailable']){
   scenario=kind;css=false;fxShow=true;const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[],outside=[];
   // WebKit's screenshot preparation itself adds/removes <style> to synchronize animations.
   // Let the real fail-closed observer hide and the real next-rAF proof recover before native capture.
   // This is a pinned Playwright in-process capture hook, not a DOM/proof/mutation override.
   const nativePage=page._connection.toImpl(page),capture=nativePage.screenshotter._screenshot.bind(nativePage.screenshotter);
   nativePage.screenshotter._screenshot=async(...args)=>{await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));return capture(...args)};
   page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>{const u=new URL(r.request().url());if(['blob:','data:'].includes(u.protocol)||u.hostname==='127.0.0.1'&&[String(port),String(preview.settings.port)].includes(u.port))return r.continue();outside.push(u.origin);return r.abort();});
   try{
    const startResources=resources,startProfiles=profileWrites;
    await page.goto('http://127.0.0.1:'+port+'/?lang='+(width===390?'zh-TW':'en'));await page.locator('.composer').waitFor();
    await page.waitForFunction(()=>document.querySelectorAll('img.agend-effect-poster').length===2&&[...document.querySelectorAll('img.agend-effect-poster')].every(i=>getComputedStyle(i).visibility==='visible'),undefined,{timeout:15000});
    assert.equal(await page.locator('iframe').count(),0);assert.equal(page.workers().length,0);assert.equal(resources,startResources);assert.equal(profileWrites,startProfiles);
    assert.equal(await page.locator('.agend-effect-poster').evaluateAll(xs=>xs.every(i=>getComputedStyle(i).zIndex==='0'&&getComputedStyle(i).pointerEvents==='none'&&!i.hasAttribute('style')&&i.getAttribute('src').startsWith('blob:'))),true);
    // A real host mutation must hide immediately, before a fresh animation-frame proof restores paint.
    assert.equal(await page.evaluate(async()=>{const el=document.createElement('span');document.body.append(el);await Promise.resolve();const hidden=[...document.querySelectorAll('.agend-effect-poster')].every(i=>getComputedStyle(i).visibility==='hidden');el.remove();return hidden}),true);
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const point=await page.evaluate(()=>{const r=document.querySelector('.chat-main>.scroller').getBoundingClientRect(),holes=probe.trust().rects;for(let y=Math.ceil(r.y+8);y<r.y+r.height-8;y+=8)for(const x of[Math.ceil(r.x+8),Math.floor(r.x+r.width-8)])if(holes.every(h=>x<h.x-10||x>h.x+h.width+10||y<h.y-10||y>h.y+h.height+10))return{x,y};throw Error('no free pixel')});
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const on=await page.screenshot({caret:'initial',path:join(out,engine+'-'+width+'-'+kind+'-on.png')});assert.deepEqual(pixel(on,point.x,point.y),[255,20,20]);
    const protectedPoint=await page.locator('.composer').evaluate(el=>{const r=el.getBoundingClientRect();return{x:Math.floor(r.x+16),y:Math.floor(r.y+r.height/2)}}),protectedPixel=pixel(on,protectedPoint.x,protectedPoint.y);
    await page.locator('.panel-head .menu>button').last().click();assert.equal(await page.getByRole('menuitem',{name:width===390?'效果':'Effects',exact:true}).count(),kind==='public'?0:1);await page.keyboard.press('Escape');
    await page.evaluate(()=>probe.off());await page.waitForFunction(()=>document.querySelectorAll('.agend-effect-poster').length===0);
    const off=await page.screenshot({caret:'initial'});assert.deepEqual(pixel(off,protectedPoint.x,protectedPoint.y),protectedPixel);assert.notDeepEqual(pixel(off,point.x,point.y),[255,20,20]);
    // A fresh synthetic-session page proves no prior reader/URL can revive; stock ordering changes refuse paint.
    fxShow=true;await page.evaluate(()=>{probe.on();localStorage.removeItem('agend_fx_show')});await page.reload();await page.locator('.composer').waitFor();await page.waitForFunction(()=>document.querySelectorAll('.agend-effect-poster').length===2);
    await page.evaluate(()=>{const sheet=document.querySelector('link[href="/assets/app.css"]').sheet;sheet.insertRule('.chat-main>.scroller{z-index:-1!important}',sheet.cssRules.length)});
    await page.waitForFunction(()=>document.querySelectorAll('.agend-effect-poster').length===0);
    fxShow=true;await page.evaluate(()=>{probe.on();localStorage.removeItem('agend_fx_show')});await page.reload();await page.locator('.composer').waitFor();await page.waitForFunction(()=>document.querySelectorAll('.agend-effect-poster').length===2);
    await page.evaluate(()=>{void window.AgendAuth.signOut().catch(()=>{})});await page.waitForFunction(()=>document.querySelectorAll('.agend-effect-poster').length===0);
    const safeReads=posterReads;await page.goto('http://127.0.0.1:'+port+'/?safe=1&lang='+(width===390?'zh-TW':'en'));await page.locator('.composer').waitFor();await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('.agend-effect-poster,iframe.agend-effect-frame').count(),0);assert.equal(posterReads,safeReads,'safe mode must not read posters');
    assert.equal(resources,startResources);assert.equal(profileWrites,startProfiles);assert.deepEqual(outside,[]);assert.deepEqual(errors,[]);
    rows.push({engine,version:browser.version(),width,kind,status:'pass',actualChatPanel:true,syntheticSession:true,publicFlagOnly:kind==='public',builtServiceProjection:true,behindOnly:true,protectedComposerPixel:true,stockOrderRefusal:true,switchClears:true,safeNoReads:true,signOutClears:true,noWorkerOrRuntimeRead:true});console.log('PASS',engine,width,kind);
   }catch(e){let diagnostic;try{diagnostic=await page.evaluate(()=>({body:document.body.dataset,trust:probe.trust(),images:[...document.querySelectorAll('.agend-effect-poster')].map(i=>({visibility:getComputedStyle(i).visibility,src:i.src,width:i.naturalWidth,rect:i.getBoundingClientRect().toJSON()})),text:document.body.innerText.slice(-1200)}))}catch{}rows.push({engine,width,kind,status:'failed',error:e.message,stack:e.stack,errors,outside,diagnostic});console.log('FAIL',engine,width,kind,e.message)}finally{await context.close()}
  }await browser.close();browser=null;
 }
}finally{
 if(browser)await browser.close();for(const s of [preview?.server,server])if(s?.listening){s.closeAllConnections();s.close();await once(s,'close')}
 writeFileSync(join(out,'receipt.json'),JSON.stringify({rows,passed:rows.filter(r=>r.status==='pass').length,failed:rows.filter(r=>r.status!=='pass').length,publicGatewayHttpTest:'tests/web-effect-posters-1629.test.ts; browser public flag uses private synthetic session projection'},null,2));rmSync(scratch,{recursive:true,force:true});
}if(rows.some(r=>r.status!=='pass'))process.exitCode=1;
