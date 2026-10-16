/** Actual Shell+ChatPanel product mount + built service/library/preview, private synthetic session only. No fleet/account/service. Linux WebKit is not Safari. Build first; see the private container runner. */
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
let preview:any,css=false,rev=1,resources=0,epoch='e'.repeat(16),profileWrites=0;
const service=new WebEffectService({library,themes,profiles,known:n=>['worker','worker-b'].includes(n),changed:()=>rev++});
library.registerReferenceSource('themes',()=>themes.placedEffects().flatMap(p=>p.ids.map(id=>({id,holder:'instance:'+p.name}))));
const ids=[]; const resourceScopes: string[] = [];
for(let n=0;n<2;n++){
 const worker=`const c=agend.canvas.getContext('2d');let color='#ff1414';const paint=()=>{c.fillStyle=color;c.fillRect(0,0,agend.canvas.width,agend.canvas.height)};paint();agend.on('env',paint);agend.on('reply',()=>{color='#14ff14';paint()});agend.ready();`;
 const files=new Map([['effect.json',Buffer.from(JSON.stringify({v:1,runtime:'canvas-worker-v1',worker:'worker.js',name:'native-'+n,title:'Native '+n,regions:['chat'],layer:n===0?'front':'behind',wants:['reply','pointer','state','theme']}))],['worker.js',Buffer.from(worker)]]);
 const r=service.upload('alice',encodeEffectFiles(files));assert.equal(typeof r.id,'string');ids.push(r.id);
}
assert.equal(themes.setPlacements('worker',{effects:ids.map(id=>({id}))},'agent',()=>null).ok,true);
assert.equal(themes.setPlacements('worker-b',{effects:ids.map(id=>({id}))},'agent',()=>null).ok,true);
const server=createServer(async(req,res)=>{
 const u=new URL(req.url||'/','http://localhost'),p=u.pathname;
 if(/^\/assets\/[a-z0-9._-]+$/.test(p)||/^\/ui\/js\/[a-z0-9_-]+\.js$/.test(p)){
  try{res.setHeader('Content-Type',p.endsWith('.css')?'text/css':p.endsWith('.woff2')?'font/woff2':'text/javascript');res.end(readFileSync(join('src/ui',p.startsWith('/assets/')?'shared':'',p.split('/').at(-1))));}catch{res.statusCode=404;res.end();}return;
 }
 if(p==='/ui/owner-css.css'){res.setHeader('Content-Type','text/css');res.end('/* neutral owner CSS; still blocks agent front */');return;}
 if(p!=='/'){
  res.setHeader('Content-Type','application/json');let answer:any={ok:true,instances:[],themes:{},records:[],entries:[]};
  if(p==='/ui/effects/owner'){answer={rev,slots:Object.fromEntries(['fx.page','fx.header','fx.sidebar','fx.box','fx.cursor'].map(k=>[k,{status:'none',id:null}]))};}
  else if(p.startsWith('/ui/effects/')){
   assert.ok(['worker','worker-b'].includes(u.searchParams.get('instance')!));assert.equal(u.searchParams.get('ownerEpoch'),epoch);
   if(p==='/ui/effects/placements')answer=service.placements('alice',u.searchParams.get('instance'));
   else if(p.startsWith('/ui/effects/resource/')){resources++;resourceScopes.push(u.searchParams.get('instance')!);answer=service.resource('alice',p.split('/').at(-1),u.searchParams.get('instance'));}
   else if(p.startsWith('/ui/effects/profile/')){let body='';for await(const b of req)body+=b;answer=service.report('alice',p.split('/').at(-1),JSON.parse(body));if(!answer.error)profileWrites++;}
  }else if(p==='/auth/session')answer={csrf:'probe-csrf',handle:epoch,tier:'admin'};
  else if(p==='/auth/logout'){return;}// Held to prove synchronous teardown before logout completes.
  else if(p==='/ui/owner-css/state')answer={active:css?'a'.repeat(32):null,effectState:css?'on':'off',pending:null};
  else if(p==='/ui/history')answer={messages:[message]};
  else if(p==='/api/card/worker')answer={tagline:{text:'Real Chat card',by:'agent'}};
  else if(p==='/ui/prefs')answer={rev,values:{'preview.optIn':true,'fx.show':true},ownerScope:'person',ownerEpoch:epoch};
  else if(p==='/probe/css'){css=u.searchParams.get('on')==='1';rev++;answer={rev};}
  else if(p==='/probe/status')answer={resources,profileWrites};
  if(answer.error){res.statusCode=400;}res.end(JSON.stringify(answer));return;
 }
 const origin='http://127.0.0.1:'+port,previewOrigin='http://127.0.0.1:'+preview.settings.port;
 const prefs=JSON.stringify({rev,values:{'preview.optIn':true,'fx.show':true},ownerScope:'person',ownerEpoch:epoch});
 res.setHeader('Content-Type','text/html');res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'self' 'nonce-chat-probe'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-src ${previewOrigin}/frame ${previewOrigin}/effect; worker-src 'none'; object-src 'none'; base-uri 'none'`);
 res.end(`<!doctype html><html data-prefs='${prefs}'><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><link rel=stylesheet href=/assets/tokens.css><link rel=stylesheet href=/assets/app.css><body data-mode=full data-dashboard-origin="${origin}" data-preview-origin="${previewOrigin}" data-preview-boot="${'b'.repeat(32)}" data-owner-css-state=off><div id=app class=app-root></div><script src=/assets/agend-auth.js></script><script src=/ui/js/preview.js></script><script type=module nonce=chat-probe>
import{html,render}from'/assets/app-html.js';import{Shell}from'/assets/app-shell.js';import{appStore}from'/assets/app-store.js';import{navStore}from'/assets/app-nav.js';import{ChatPanel,boot}from'/ui/js/panel-chat.js';import{FleetPanel}from'/ui/js/panel-fleet.js';import{getAppEffects}from'/ui/js/app-effects.js';import{installOwnerCss,ownerCssLifecycle}from'/assets/owner-css.js';import{setLang}from'/assets/app-i18n.js';import{stockEffectTrust}from'/assets/effect-stock-trust.js';import{savePref,bootPrefs}from'/assets/app-prefs.js';
setLang(new URL(location.href).searchParams.get('lang')||'en',{store:false});localStorage.setItem('agend_tour_seen','1');window.AgendPreview.setOptIn(true);bootPrefs();installOwnerCss();
appStore.set({ready:true,connection:'live',instances:[{name:'worker',backend:'codex',status:'running',state:'idle',card_v:'probe-card'},{name:'worker-b',backend:'codex',status:'running',state:'idle',card_v:'probe-card'}],exec:{worker:'idle','worker-b':'idle'},awaiting:{},themesRev:1,prefsRev:1,connections:1});navStore.set({route:{panel:'fleet'},seq:1});
const handlers={};const store=boot({stream:{on(k,fn){handlers[k]=fn;return()=>delete handlers[k]}},boot:document.body.dataset,deps:{announce(){},toast(){}}});
render(html\`<\${Shell} panels=\${new Map([['chat',{Component:ChatPanel}],['fleet',{Component:FleetPanel}]])} onNewInstance=\${()=>{}} />\`,document.querySelector('#app'));
const appOwner=getAppEffects();const layer=document.querySelector('.agend-effect-layer');window.probe={sameOwner:()=>appOwner===getAppEffects()&&layer===document.querySelector('.agend-effect-layer')&&[...document.querySelectorAll('iframe.agend-effect-frame')].every(f=>f.parentElement===layer),goto:(name)=>navStore.set({seq:navStore.get().seq+1,route:name?{panel:'chat',instance:name}:{panel:'fleet'}}),trust:()=>stockEffectTrust(window,{ownerCss:ownerCssLifecycle.get().state}),off:()=>{savePref('fx.show',false);window.AgendPreview.setOptIn(false)},css:async(on)=>{const r=await fetch('/probe/css?on='+(on?1:0)).then(r=>r.json());appStore.set({prefsRev:r.rev})},cssState:()=>ownerCssLifecycle.get().state,unmount:()=>render(null,document.querySelector('#app')),rev:()=>appStore.set({themesRev:appStore.get().themesRev+1}),reply:()=>{const meta=Object.freeze({source:'sse',receivedAt:performance.now()}),m={boot:'bb',id:50,role:'agent',instance:'worker',sender:'worker',text:'fresh',ts:new Date().toISOString()};handlers.message(m,meta);handlers.agent_reply_live({v:1,boot:'bb',id:50,instance:'worker'},meta)}};
</script>`);
});
let browser:any,port:number;
try{
 server.listen(0,'127.0.0.1');await once(server,'listening');port=(server.address()as any).port;
 preview=createPreviewListener({settings:{enabled:true,port:0,origin:null},healthPort:port,config:{},bootId:'b'.repeat(32)});preview.server.listen(0,'127.0.0.1');await once(preview.server,'listening');
 for(const engine of(process.env.PROBE_ENGINES||'chromium,firefox,webkit').split(',')){
  browser=await pw[engine].launch({headless:true,env:{HOME:join(scratch,'home'),TMPDIR:join(scratch,'tmp'),PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
  for(const width of [1366,390]){
   css=false;const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[],outside=[];
   await context.addInitScript(n=>{Object.defineProperty(navigator,'hardwareConcurrency',{value:n});Object.defineProperty(navigator,'deviceMemory',{value:n})},width===390?4:8);page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>{const u=new URL(r.request().url());if(['blob:','data:'].includes(u.protocol)||u.hostname==='127.0.0.1'&&[String(port),String(preview.settings.port)].includes(u.port))return r.continue();outside.push(u.origin);return r.abort();});
   try{
    await page.goto('http://127.0.0.1:'+port+'/?lang='+(width===390?'zh-TW':'en'));await page.locator('.p-fleet').waitFor();
    assert.equal(await page.evaluate(()=>probe.sameOwner()),true);assert.equal(await page.locator('iframe.agend-effect-frame').count(),0);
    await page.evaluate(()=>probe.goto('worker'));await page.locator('.composer').waitFor();
    await page.waitForTimeout(250);await page.evaluate(()=>{const e=document.activeElement;if(e instanceof HTMLElement)e.blur()});
    const expected=width===390?1:2;await page.waitForFunction(n=>document.querySelectorAll('iframe.agend-effect-frame').length===n,expected,{timeout:15000});
    await page.waitForFunction(()=>[...document.querySelectorAll('iframe.agend-effect-frame')].every(f=>getComputedStyle(f).visibility==='visible'),undefined,{timeout:15000});
    // Real route producer handoffs retain exactly the original page owner/layer and share cap limits.
    for(const name of ['worker-b',null,'worker']){
      console.log('ROUTE',engine,width,name);
      await page.evaluate(n=>probe.goto(n),name);
      if(name){await page.locator('.composer').waitFor();await page.waitForTimeout(250);await page.evaluate(()=>{const e=document.activeElement;if(e instanceof HTMLElement)e.blur()});await page.waitForFunction(n=>document.querySelectorAll('iframe.agend-effect-frame').length===n,expected,{timeout:15000});}
      else{await page.locator('.p-fleet').waitFor();await page.waitForFunction(()=>document.querySelectorAll('iframe.agend-effect-frame').length===0);}
      assert.equal(await page.evaluate(()=>probe.sameOwner()),true);
    }
    await page.waitForFunction(()=>[...document.querySelectorAll('iframe.agend-effect-frame')].every(f=>getComputedStyle(f).visibility==='visible'),undefined,{timeout:15000});
    const firstReports=profileWrites;
    await page.waitForFunction(async initial=>(await fetch('/probe/status').then(r=>r.json())).profileWrites>initial,firstReports,{timeout:16000,polling:500});
    const screenshot=await page.screenshot({path:join(out,engine+'-'+width+'-running.png')});
    const noAttributes=await page.locator('iframe').evaluateAll(fs=>fs.every(f=>f.getAttribute('sandbox')==='allow-scripts'&&!f.hasAttribute('style')));assert.equal(noAttributes,true);
    const before=await page.locator('.composer').evaluate(el=>{const r=el.getBoundingClientRect();return{x:Math.floor(r.x+16),y:Math.floor(r.y+r.height/2)}});
    const protectedPixel=pixel(screenshot,before.x,before.y);
    const point=await page.evaluate(()=>{const r=document.querySelector('.chat-main>.scroller').getBoundingClientRect(),holes=probe.trust().rects;for(let y=Math.ceil(r.y+8);y<r.y+r.height-8;y+=8)for(const x of[Math.ceil(r.x+8),Math.floor(r.x+r.width-8)])if(holes.every(h=>x<h.x-10||x>h.x+h.width+10||y<h.y-10||y>h.y+h.height+10))return{x,y};throw Error('no free pixel')});
    assert.ok(pixel(screenshot,point.x,point.y)[0]>240,'Worker must really paint');
    await page.evaluate(()=>probe.reply());let replyPixel;
    for(let i=0;i<20;i++){replyPixel=pixel(await page.screenshot(),point.x,point.y);if(replyPixel[1]>240&&replyPixel[0]<65)break;await page.waitForTimeout(25)}
    assert.ok(replyPixel[1]>240&&replyPixel[0]<65,'fresh reply signal must reach the actual Worker: '+replyPixel);
    // An explicit pause survives an unrelated theme revision. Closing the dialog itself updates modal gates.
    const fxLabel=width===390?'效果':'Effects';
    const openEffects=async()=>{await page.locator('.panel-head .menu>button').last().click();await page.getByRole('menuitem',{name:fxLabel,exact:true}).click();await page.locator('dialog[open]').waitFor()};
    await openEffects();await page.getByRole('button',{name:width===390?'暫停':'Pause',exact:true}).first().click();await page.keyboard.press('Escape');await page.locator('dialog[open]').waitFor({state:'detached'});
    await page.evaluate(()=>probe.rev());await page.waitForFunction(()=>document.querySelectorAll('iframe.agend-effect-frame').length===1,undefined,{timeout:15000});
    // On a constrained device the queued behind effect may take the released slot, but the paused front stays gone.
    assert.equal(await page.locator('iframe.agend-effect-frame').evaluateAll(fs=>fs.some(f=>getComputedStyle(f).zIndex==='20')),false);
    await openEffects();await page.getByRole('button',{name:width===390?'恢復':'Resume',exact:true}).first().click();await page.keyboard.press('Escape');await page.locator('dialog[open]').waitFor({state:'detached'});
    await page.waitForFunction(n=>document.querySelectorAll('iframe.agend-effect-frame').length===n,expected,{timeout:15000});

    await page.evaluate(()=>probe.off());await page.waitForFunction(()=>document.querySelectorAll('iframe.agend-effect-frame').length===0);
    const stopped=await page.screenshot();assert.deepEqual(pixel(stopped,before.x,before.y),protectedPixel,'protected composer pixel');
    // A fresh page is the explicit recovery boundary; no old epoch/pending controller is reused.
    await page.reload();await page.locator('.p-fleet').waitFor();await page.evaluate(()=>{window.AgendPreview.setOptIn(true);probe.goto('worker')});await page.locator('.composer').waitFor();await page.waitForTimeout(250);await page.evaluate(()=>{const e=document.activeElement;if(e instanceof HTMLElement)e.blur()});
    await page.waitForFunction(n=>document.querySelectorAll('iframe.agend-effect-frame').length===n,expected,{timeout:15000});
    await page.evaluate(()=>probe.css(true));await page.waitForFunction(()=>probe.cssState()==='on');
    await page.waitForFunction(()=>[...document.querySelectorAll('iframe.agend-effect-frame')].every(f=>getComputedStyle(f).zIndex!=='20'));
    await page.locator('.panel-head .menu>button').last().click();await page.getByRole('menuitem',{name:width===390?'效果':'Effects',exact:true}).click();await page.locator('dialog[open]').waitFor();
    const label=width===390?'開啟外觀設定':'Open Appearance settings';assert.equal(await page.getByRole('button',{name:label,exact:true}).count(),1);
    await page.keyboard.press('Escape');await page.locator('dialog[open]').waitFor({state:'detached'});
    await page.evaluate(()=>probe.css(false));await page.waitForFunction(()=>probe.cssState()==='off');await page.waitForFunction(n=>document.querySelectorAll('iframe.agend-effect-frame').length===n,expected,{timeout:15000});
    // Sign-out notifies before its network call. Even a changed route cannot keep a frame alive.
    await page.evaluate(()=>{void window.AgendAuth.signOut()});await page.waitForFunction(()=>document.querySelectorAll('iframe.agend-effect-frame').length===0);
    assert.ok(resourceScopes.includes('worker-b'));assert.equal(await page.locator('.agend-effect-layer').count(),0);assert.deepEqual(outside,[]);assert.deepEqual(errors,[]);rows.push({engine,version:browser.version(),width,status:'pass',actualChatPanel:true,appOwnedPool:true,initialFleetHasNoFrames:true,routeHandoffsKeepSameOwner:true,sameIdExactScopes:resourceScopes.includes('worker')&&resourceScopes.includes('worker-b'),explicitDeviceSignals:true,builtServiceProjection:true,builtPreview:true,cap:expected,ownerCssSuppressesAgentFront:true,plainBilingualSettingLink:true,signOutTeardown:true,freshReplyReachesWorker:true,profileRecorded:true,pauseSurvivesRevision:true,resumeAfterDialog:true,protectedComposerPixel:true,noInlineStyle:true});console.log('PASS',engine,width);
   }catch(e){let diagnostic;try{diagnostic=await page.evaluate(()=>({body:document.body.dataset,trust:probe.trust(),device:{cores:navigator.hardwareConcurrency,memory:navigator.deviceMemory,offscreen:typeof OffscreenCanvas,worker:typeof Worker},frames:[...document.querySelectorAll('iframe')].map(f=>({visibility:getComputedStyle(f).visibility,z:getComputedStyle(f).zIndex})),text:document.body.innerText.slice(-2000)}))}catch{}rows.push({engine,width,status:'failed',error:e.message,stack:e.stack,errors,outside,diagnostic});console.log('FAIL',engine,width,e.stack,JSON.stringify({errors,diagnostic}))}finally{await context.close()}
  }await browser.close();browser=null;
 }
}finally{
 if(browser)await browser.close();for(const s of [preview?.server,server])if(s?.listening){s.closeAllConnections();s.close();await once(s,'close')}
 writeFileSync(join(out,'receipt.json'),JSON.stringify({rows,passed:rows.filter(r=>r.status==='pass').length,failed:rows.filter(r=>r.status!=='pass').length},null,2));rmSync(scratch,{recursive:true,force:true});
}if(rows.some(r=>r.status!=='pass'))process.exitCode=1;
