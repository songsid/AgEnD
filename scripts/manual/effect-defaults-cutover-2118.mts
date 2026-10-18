/** #2118 PR2 transport acceptance: visible sign-in, fresh prefs/consents, private source-product fixture.
 * node --import tsx scripts/manual/effect-defaults-cutover-2118.mts; PW_DIR, REPO, OUT_DIR.
 * No fleet/backend/real-account/tunnel operation. The real PublicWebLink/gateway uses the shared fixture's explicit tunnel/transport stubs.
 * This PR still expects reduced-motion refusal/baseline; PR3 supplies their separate remedy. Not real Safari/Windows/phone.
 */
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {inflateSync} from 'node:zlib';
import {createServer,request as proxyRequest} from 'node:http';
import {bootFixture,freshPage,openPublicLink} from './smoke-fixture/index.mts';
process.env.REPO=process.cwd();const out=resolve(process.env.OUT_DIR||'.artifacts/effect-cutover');process.env.OUT=out;mkdirSync(out,{recursive:true});
const pw=createRequire(process.env.PW_DIR+'/')('playwright-core');
const engines=(process.env.PROBE_ENGINES||'chromium,firefox,webkit').split(',');
const origins=(process.env.PROBE_SURFACES||'loopback,lan,public').split(',');
const widths=(process.env.PROBE_WIDTHS||'1366,390').split(',').map(Number),modes=(process.env.PROBE_MODES||'light,dark').split(',');
const asGuest=process.env.PROBE_GROUPS==='guest',reductions=asGuest||process.env.PROBE_GROUPS==='fresh-only'?[false]:[false,true],rows=[];
function pixels(png){
 assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');let i=8,w=0,h=0,c=0;const parts=[];
 while(i<png.length){const n=png.readUInt32BE(i),t=png.subarray(i+4,i+8).toString(),d=png.subarray(i+8,i+8+n);i+=n+12;if(t==='IHDR'){w=d.readUInt32BE(0);h=d.readUInt32BE(4);assert.equal(d[8],8);c=d[9]===2?3:d[9]===6?4:0;assert.ok(c);assert.equal(d[12],0)}if(t==='IDAT')parts.push(d);if(t==='IEND')break}
 const raw=inflateSync(Buffer.concat(parts)),stride=w*c,b=Buffer.alloc(stride*h);assert.equal(raw.length,(stride+1)*h);
 const paeth=(a,b,c)=>{const p=a+b-c,A=Math.abs(p-a),B=Math.abs(p-b),C=Math.abs(p-c);return A<=B&&A<=C?a:B<=C?b:c};
 for(let y=0;y<h;y++){const f=raw[y*(stride+1)];assert.ok(f<=4);for(let x=0;x<stride;x++){const a=x>=c?b[y*stride+x-c]:0,u=y?b[(y-1)*stride+x]:0,v=y&&x>=c?b[(y-1)*stride+x-c]:0;b[y*stride+x]=(raw[y*(stride+1)+x+1]+(f===0?0:f===1?a:f===2?u:f===3?Math.floor((a+u)/2):paeth(a,u,v)))&255}}
 let red=0;for(let j=0;j<b.length;j+=c)if(b[j]>200&&b[j+1]<60&&b[j+2]>40&&b[j+2]<110)red++;
 return{red,width:w,height:h,pixel:(x,y)=>[...b.subarray((Math.floor(y)*w+Math.floor(x))*c,(Math.floor(y)*w+Math.floor(x))*c+3)]};
}
for(const engine of engines)for(const origin of origins)for(const width of widths)for(const theme of modes)for(const reduced of reductions){
 const key=[engine,origin,width,theme,reduced?'reduce':'normal'].join('-');let fx=null,browser=null,ctx=null,link=null,page=null,capture=null,lanProxy=null;const row={key,engine,origin,width,theme,reduced,status:'failed',fromDefaults:true,visibleSignIn:true,seededPrefs:false,seededConsent:false,realSafari:false,physicalPhone:false};
 try{
  fx=await bootFixture({port:19280,instances:8});await fx.fm.stopPreviewListener();fx.fm.fleetConfig.web.preview=false;
  assert.ok(!fx.fm.previewListener?.server?.listening);row.previewListenerAbsentBeforeSignIn=true;
  browser=engine==='chromium'?fx.browser:await pw[engine].launch({headless:true});
  // WebKit ignores and Firefox intermittently loses the private container hosts entry. A private
  // HTTP forward proxy substitutes DNS only, preserves the browser URL/Host/cookies/CSP/Origin
  // and streams SSE. It refuses every destination except this fixture's one LAN listener.
  if(engine!=='chromium'&&origin==='lan'){
   lanProxy=createServer((req,res)=>{let u;try{u=new URL(req.url)}catch{res.writeHead(400);res.end();return}if(u.origin!=='http://dashboard.lan.example:19280'){res.writeHead(403);res.end();return}const r=proxyRequest({host:'127.0.0.1',port:19280,path:u.pathname+u.search,method:req.method,headers:{...req.headers,host:u.host}},q=>{res.writeHead(q.statusCode,q.headers);q.pipe(res)});r.on('error',()=>res.destroy());res.on('close',()=>r.destroy());req.pipe(r)});
   await new Promise(r=>lanProxy.listen(0,'127.0.0.1',r));row.lanTransport='private fixed-destination HTTP proxy substitutes container DNS; actual LAN URL/Host/Origin retained';
  }
  const actualBrowser={newContext:opts=>browser.newContext({...opts,...(engine==='firefox'?{isMobile:false}:{}),...(lanProxy?{proxy:{server:'http://127.0.0.1:'+lanProxy.address().port}}:{})})};
  const view={...fx,browser:actualBrowser},name=fx.instances[0].name;
  const code=process.env.PROBE_MUTATION==='no-paint'?'agend.ready();':"const c=agend.canvas.getContext('2d');function draw(){c.fillStyle='#ed174c';c.fillRect(0,0,4096,4096)}draw();agend.on('env',draw);agend.ready();";
  const staged=fx.fm.effectLibrary.stage(new Map([['effect.json',Buffer.from(JSON.stringify({v:1,runtime:'canvas-worker-v1',worker:'worker.js',name:'defaults-smoke',title:'Visible defaults sample',regions:['chat'],layer:'front',wants:[]}))],['worker.js',Buffer.from(code)]]),{kind:'agent',id:name});assert.equal(staged.ok,true);const commit=fx.fm.effectLibrary.commit(staged.stageId);assert.equal(commit.ok,true);const id=commit.ids[0];if(!asGuest)assert.ok(!fx.fm.effectTools.apply(name,{id}).error);assert.equal((await fx.fm.effectTools.preview(name,{id})).status,"offered");
  const beforeNavigate=async (ctx,debugPage)=>{debugPage.on('pageerror',e=>(row.pageErrorStacks??=[]).push(e.stack));debugPage.on('requestfailed',r=>(row.requestFailures??=[]).push({path:new URL(r.url()).pathname,error:r.failure()}));debugPage.on('response',r=>{if(r.status()>=400)(row.httpFailures??=[]).push({path:new URL(r.url()).pathname,status:r.status()})});return ctx.addInitScript(()=>{globalThis.__defaultViolations=[];globalThis.__defaultStyleInserts=[];new MutationObserver(rs=>{for(const r of rs)for(const n of r.addedNodes)if(n.nodeName==='STYLE')globalThis.__defaultStyleInserts.push(n.textContent)}).observe(document,{childList:true,subtree:true});document.addEventListener('securitypolicyviolation',e=>globalThis.__defaultViolations.push({directive:e.effectiveDirective,blocked:e.blockedURI,source:e.sourceFile,line:e.lineNumber,column:e.columnNumber,sample:e.sample,target:e.target?.outerHTML?.slice(0,500)}))})};
  const guestSetup=()=>{if(!asGuest)return;fx.fm.initializeWebSessions();fx.fm.fleetConfig.web.guests={enabled:true};fx.fm.guestScope=()=>new Set([name]);fx.fm.confirmGuestPublicWebLogin=async()=>{};const issue=fx.fm.webLoginCodes.issue.bind(fx.fm.webLoginCodes);fx.fm.webLoginCodes.issue=input=>issue({...input,tier:'guest',owner:undefined,recipient:input.recipient??{adapterId:input.owner.adapterId,userId:input.owner.userId}});row.syntheticGuestScope=[name]};
  const c={device:width<900?'phone':'desk',theme,lang:'en'};let fresh;
  if(origin==='public'){link=await openPublicLink(view);guestSetup();fresh=await link.publicPage(c,{reducedMotion:reduced,beforeNavigate})}else {guestSetup();fresh=await freshPage(view,c,{origin,reducedMotion:reduced,beforeNavigate});}
  ({page,ctx}=fresh);
  capture=async options=>{
   const count=async()=>new Map(await Promise.all(page.frames().map(async f=>[f,await f.evaluate(()=>globalThis.__defaultStyleInserts?.filter(s=>s==='body {}').length||0).catch(()=>0)])));
   const prior=await count(),start=fresh.errors.length,buffer=await page.screenshot({caret:"initial",...options});await page.waitForTimeout(0);
   const after=await count(),injected=[...after].reduce((n,[f,v])=>n+Math.max(0,v-(prior.get(f)||0)),0);
   const indices=fresh.errors.map((e,i)=>i>=start&&/^Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy\. @ https?:\/\//.test(e)?i:null).filter(i=>i!==null);
   // Playwright/WebKit screenshot synchronization inserts exactly `body {}` into each frame.
   // Its no-op inline stylesheet is correctly refused by the product CSP. Match each observed
   // DOM insertion to one capture-local diagnostic; unrelated/outside-capture violations stay errors.
   if(engine==='webkit'&&indices.length&&indices.length===injected){(row.captureCompatibility??=[]).push({injectedBodyRules:injected,diagnostics:indices.map(i=>fresh.errors[i])});for(const i of indices)(row.captureErrorIndices??=[]).push(i)}
   return buffer;
  };
  row.browserErrors=fresh.errors;
  // A locator uses the driver's visibility polling; the shared helper's string eval trips
  // Firefox's strict CSP on an insecure LAN origin. No page CSP bypass is used here.
  await page.locator('#app .sidebar a,#app .tabs a,#app .tabs button,#app button[aria-controls=sidebar]').filter({visible:true}).first().waitFor({state:'visible',timeout:30000});row.version=browser.version();row.signInErrors=fresh.expected;
  const requests=[];page.on('response',r=>{if(/\/effect-bootstrap|\/ui\/effects\//.test(r.url()))requests.push({url:new URL(r.url()).pathname,status:r.status()})});
  const a=page.locator(`.sidebar a[href="/ui/chat/${name}"]`);await a.waitFor({state:"attached"});if(width>=900)await a.waitFor({state:"visible"});else if(!await a.isVisible())await page.locator('button[aria-controls="sidebar"][aria-expanded]').filter({visible:true}).click();
  await a.click();await page.waitForSelector('.p-chat .chat-main');if(asGuest){await page.waitForFunction(async()=>{const m=await import('/ui/js/app-effects.js'),s=m.getAppEffects()?.api.snapshot();return s&&!s.loading&&s.effects.length===0});assert.equal(await page.locator('iframe.agend-effect-frame').count(),0);assert.ok(!fx.fm.effectTools.apply(name,{id}).error);row.guestInitialEmptyToApply=true;}
  if(reduced){await page.waitForFunction(()=>[...document.querySelectorAll('.chat-fx-notice[role=status]')].some(n=>n.textContent.includes('reduced motion')),undefined,{timeout:12000});assert.equal(await page.locator('iframe.agend-effect-frame').count(),0);row.blocked='reduced_motion';row.url=page.url();row.pageText=await page.locator('body').innerText().catch(()=>null);row.notice=await page.locator('.chat-fx-notice').allTextContents();await capture({path:join(out,key+'.png')});}
  else{
   await page.waitForFunction(()=>[...document.querySelectorAll('iframe.agend-effect-frame')].some(f=>getComputedStyle(f).visibility==='visible'),undefined,{timeout:15000});
   // ready/visible precedes the browser's asynchronous OffscreenCanvas presentation.
   // Wait for independent screenshot pixels, never infer paint from port/DOM readiness.
   row.errorsBeforePaint=[...fresh.errors];let image;const paintUntil=Date.now()+8000;do{image=pixels(await capture({path:join(out,key+'.png')}));if(image.red>500)break;await page.waitForTimeout(500)}while(Date.now()<paintUntil);
   assert.ok(image.red>500,'actual independent red paint');row.redPixels=image.red;
   const controls=await page.evaluate(()=>[...document.querySelectorAll('.dock textarea,.dock button,.panel-head button,.panel-head input')].filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height).slice(0,8).map(e=>{const r=e.getBoundingClientRect();return{tag:e.tagName,x:r.left+3,y:r.top+3}}));
   assert.ok(controls.length>1);row.protected=controls.map(p=>({...p,rgb:image.pixel(p.x,p.y)}));assert.ok(row.protected.every(p=>!(p.rgb[0]>200&&p.rgb[1]<60&&p.rgb[2]>40&&p.rgb[2]<110)),'protected control pixels must not turn red');
   row.active=await page.evaluate(()=>document.activeElement?.tagName);assert.ok(requests.some(r=>r.url==='/effect-bootstrap'&&r.status===200));assert.ok(requests.some(r=>r.url.startsWith('/ui/effects/resource/')&&r.status===200));row.requests=requests;
   if(origin==='public'||asGuest){
    const rev=fx.fm.webPrefs.rev(),hostBefore=JSON.stringify(fx.fm.webPrefs.readForViewer(null)),checkbox=page.getByRole('checkbox',{name:'Show themes, effects and widgets here'});assert.equal(await checkbox.count(),1);await checkbox.uncheck();
    await page.waitForFunction(()=>!document.querySelector('iframe.agend-effect-frame'));await page.getByText('Effects are switched off.',{exact:false}).first().waitFor();await capture({path:join(out,key+'-viewer-off.png')});
    await page.getByRole('button',{name:'Turn effects on here',exact:true}).click();await page.waitForFunction(()=>[...document.querySelectorAll('iframe.agend-effect-frame')].some(f=>getComputedStyle(f).visibility==='visible'),undefined,{timeout:15000});
    let recovered;const recoverUntil=Date.now()+8000;do{recovered=pixels(await capture({path:join(out,key+'-viewer-on.png')}));if(recovered.red>500)break;await page.waitForTimeout(500)}while(Date.now()<recoverUntil);assert.ok(recovered.red>500,'viewer-local recovery must paint');row.recoveredRedPixels=recovered.red;
    assert.equal(await checkbox.isChecked(),true);assert.equal(fx.fm.webPrefs.rev(),rev);assert.equal(JSON.stringify(fx.fm.webPrefs.readForViewer(null)),hostBefore);assert.equal(await page.getByRole('button',{name:'Remove from chat',exact:true}).count(),0);row.viewerControl='visible local off clears frame; inline on recovers; host prefs unchanged; no Remove';
   }
   // The same visible offer uses one click on any non-public admin dashboard origin.
   if(origin==='public'||asGuest) { assert.equal(await page.locator('.effect-trial-start').count(),0);row.trial='public/guest has no Start authority';if(asGuest){const same=await page.locator('iframe.agend-effect-frame').elementHandle();fx.fm.emitSseEvent('status',fx.fm.getUiStatus());await page.waitForTimeout(500);assert.equal(await same.evaluate(e=>e.isConnected),true,'identical scoped version preserves its frame');assert.equal(fx.fm.themeStore.setPlacements(name,{effects:[]},'human',()=>null).ok,true);fx.fm.emitSseEvent('status',fx.fm.getUiStatus());await page.waitForFunction(()=>!document.querySelector('iframe.agend-effect-frame'),undefined,{timeout:10000});row.guestRemoveObserved=true;} }
   else {
    await page.waitForFunction(()=>document.querySelector('.effect-trial-start')?.textContent==='Try');await page.locator('.effect-trial-start').click();
    await page.waitForFunction(async()=>{const m=await import('/assets/effect-trial-shadow.js');const p=document.querySelector('.effect-trial-panel'),s=p&&m.effectTrialShadow(window,p);const f=s?.stage.querySelector('iframe');return f&&getComputedStyle(f).visibility==='visible'},undefined,{timeout:15000});
    let trialPaint;const until=Date.now()+8000;do{trialPaint=pixels(await capture({path:join(out,key+'-try.png')}));if(trialPaint.red>500)break;await page.waitForTimeout(500)}while(Date.now()<until);assert.ok(trialPaint.red>500,'independent Trial pixels');
    const shell=await page.evaluate(async()=>{const m=await import('/assets/effect-trial-shadow.js'),s=m.effectTrialShadow(window,document.querySelector('.effect-trial-panel'));const r=s.stage.getBoundingClientRect(),c=getComputedStyle(s.stage),b=s.root.querySelector('.effect-trial-stop').getBoundingClientRect();return{contain:c.contain,overflow:c.overflow,stage:{x:r.x,y:r.y,width:r.width,height:r.height},stop:{x:b.x+b.width/2,y:b.y+b.height/2}}});
    assert.ok(shell.contain.includes('paint'));assert.equal(shell.overflow,'clip');await page.mouse.click(shell.stop.x,shell.stop.y);
    await page.waitForFunction(async()=>{const m=await import('/assets/effect-trial-shadow.js'),p=document.querySelector('.effect-trial-panel');return !p||!m.effectTrialShadow(window,p)?.stage.querySelector('iframe')});row.trial={status:'explicit-click painted and Stop removed',redPixels:trialPaint.red,...shell};
   }
  }
  // Chromium logs this draft directive as an error; keep that exact bootstrap-only
  // compatibility diagnostic, without ignoring runtime/CSP violations. The Worker shim
  // and tested network traps do not rely on support for the extra WebRTC directive.
  row.bootstrapCompatibility=fresh.errors.filter(e=>/^Unrecognized Content-Security-Policy directive 'webrtc'\.\s+@ (?:https?:\/\/[^/]+\/effect-bootstrap|\?)$/.test(e)||/^Viewport argument key "interactive-widget" not recognized and ignored\. @ https?:\/\/[^/]+\/ui(?:\/chat\/[^?]+)?$/.test(e));
  assert.deepEqual(fresh.errors.filter((e,i)=>!row.bootstrapCompatibility.includes(e)&&!row.captureErrorIndices?.includes(i)),[]);row.status='pass';
 }catch(error){row.error=String(error);if(page){row.url=page.url();row.pageText=await page.locator('body').innerText().catch(()=>null);row.notice=await page.locator('.chat-fx-notice').allTextContents().catch(()=>[]);row.violations=await Promise.all(page.frames().map(f=>f.evaluate(()=>({url:location.href,violations:globalThis.__defaultViolations,styles:globalThis.__defaultStyleInserts})).catch(()=>null)));row.diagnostic=await page.evaluate(async()=>{const m=await import('/ui/js/app-effects.js');const trust=await import('/assets/effect-stock-trust.js');return{body:document.body.dataset,gates:m.getAppEffects()?.gates(),stock:trust.stockEffectTrust(window,{frameRoot:document.querySelector('.agend-effect-layer'),ownerCss:'off'}),paints:[...document.querySelectorAll('.panel-head *')].map(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return{tag:e.tagName,text:e.textContent?.slice(0,30),filter:s.filter,backdrop:s.backdropFilter,textShadow:s.textShadow,boxShadow:s.boxShadow,outline:[s.outlineStyle,s.outlineWidth,s.outlineOffset],rect:{x:r.x,y:r.y,width:r.width,height:r.height}}}),rows:m.getAppEffects()?.api.snapshot()}}).catch(()=>null);await page.screenshot({caret:'initial',path:join(out,key+'-failed.png')}).catch(()=>{});}}
 finally{for(const fn of [()=>ctx?.close(),()=>link?.close(),()=>browser&&browser!==fx?.browser?browser.close():null,()=>lanProxy?new Promise(r=>{lanProxy.closeAllConnections();lanProxy.close(r)}):null,()=>fx?.close()])try{await fn()}catch(e){row.cleanupError=String(e);row.status='failed'}rows.push(row);writeFileSync(join(out,'receipt.json'),JSON.stringify({phase:'PR2 transport cutover; motion/baseline remain pending PR3',publicTransport:'real PublicWebLink/gateway; provider/tunnel/HTTPS transport stubbed by shared fixture',rows},null,2)+'\n');console.log(key,row.status,row.error||'');}
}
const files=['src/web-api.ts','src/public-web-gateway.ts','src/ui/app-effects.js','src/ui/shared/effect-app-runtime.js','src/ui/shared/effect-registry.js','src/ui/shared/effect-policy.js','scripts/manual/effect-defaults-cutover-2118.mts'];writeFileSync(join(out,'hashes.json'),JSON.stringify(Object.fromEntries(files.map(f=>[f,createHash('sha256').update(readFileSync(f)).digest('hex')])),null,2)+'\n');
if(rows.some(r=>r.status!=='pass'))process.exitCode=1;
