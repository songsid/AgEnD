/** Actual unmounted registry + helpers + built preview. Private loopback/profile/browser only.
 * Build first. PW_DIR/PLAYWRIGHT_BROWSERS_PATH private tools; PROBE_ENGINES and OUT_DIR as other effect recipes.
 * Linux WebKit is not real Safari; this fixture's safety adapter is in-memory, not product persistence.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {once} from 'node:events';import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
// @ts-ignore built production listener; run npm run build first.
import {createPreviewListener} from '../../dist/web-preview.js';
if(!process.env.PW_DIR)throw Error('Set PW_DIR to private Playwright tools');
const pw=createRequire(join(resolve(process.env.PW_DIR),'package.json'))('playwright'),out=resolve(process.env.OUT_DIR||'.artifacts/registry-native');mkdirSync(out,{recursive:true});
const scratch=mkdtempSync(join(out,'private-'));mkdirSync(join(scratch,'home'));mkdirSync(join(scratch,'tmp'));const rows=[],boot='b'.repeat(32);let preview,browser;
const literal=x=>JSON.stringify(x).replace(/</g,'\\u003c');
const modules=['effect-registry.js','effect-baseline.js','effect-geometry.js','effect-host-style.js','effect-frame.js','effect-policy.js','effect-profiler.js','effect-stock-snapshot.js'];
const worker=`const c=agend.canvas.getContext('2d');c.fillStyle='#ff0000';c.fillRect(0,0,agend.canvas.width,agend.canvas.height);agend.on('state',()=>{c.fillStyle='#00ff00';c.fillRect(0,0,agend.canvas.width,agend.canvas.height)});postMessage({type:'metrics',hostFps:999});agend.ready();agend.ready();`;
const server=createServer((req,res)=>{
 const path=req.url?.slice(1);
 if(modules.includes(path)){res.setHeader('Content-Type','text/javascript');res.end(readFileSync(resolve('src/ui/shared',path)));return;}
 if(path==='assets/app.css'){res.setHeader('Content-Type','text/css');res.end('body{margin:0;background:white}#ui{position:relative;z-index:1;height:300px}#region{position:absolute;left:20px;top:20px;width:400px;height:200px}button{position:absolute;top:60px;width:60px;height:40px;border:0;padding:0;background:#0077ff}#composer{left:60px}#reply{left:160px}#approval{left:260px}@media(max-width:600px){#region{width:calc(100vw - 40px)}}');return;}
 res.setHeader('Content-Type','text/html');res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'self' 'nonce-registry-probe'; style-src 'self'; frame-src http://127.0.0.1:${preview?.settings.port}; connect-src 'none'; img-src 'none'; worker-src 'none'`);
 res.end(`<!doctype html><link rel=stylesheet href=/assets/app.css><div id=ui><div id=region></div><button id=composer data-trust=composer></button><button id=reply data-trust=reply-buttons></button><button id=approval data-trust=approval></button></div><script type=module nonce=registry-probe>
import {createEffectRegistry} from '/effect-registry.js';
window.R={loads:[],markers:[],finishes:[],pauses:[],profiles:[],profileOwnerFailures:[],owners:[],retired:[],state:[],clicks:[],began:performance.now()};for(const el of document.querySelectorAll('button'))el.onclick=()=>R.clicks.push(el.id);
const states=new Map(),get=(id,device)=>{const k=id+':'+device;if(!states.has(k))states.set(k,{paused:false,off:false,count:0});return states.get(k)};
const safety={allowed:(id,d)=>{const s=get(id,d);return !s.paused&&!s.off},begin:x=>{R.markers.push({...x,frames:document.querySelectorAll('iframe').length,at:performance.now()});return 'token-'+R.markers.length},finish:(token,reason)=>{R.finishes.push({token,reason,at:performance.now()});return true},pause:r=>{const s=get(r.id,r.device);s.paused=true;s.count++;s.off=s.count>=3;R.pauses.push({...r,at:performance.now()});return true},resume:(id,d)=>{const s=get(id,d);if(s.off)return false;s.paused=false;return true}};
window.start=(phone=false)=>{window.ctx={safe:false,publicLink:false,reducedMotion:false,saveData:false,hidden:false,enabled:true,show:true,previewReady:true,optIn:true,constrained:phone,modal:false,openInstance:'own'};window.ds=Array.from({length:4},(_,i)=>({key:'effect-'+i,id:(i+1).toString(16).padStart(32,'0'),region:'chat',layer:i<3?'front':'behind',by:'agent',order:i,paused:false,visible:true,instance:'own',params:{},element:document.querySelector('#region')}));window.fx=createEffectRegistry({window,origin:'http://127.0.0.1:${preview?.settings.port}',boot:'${boot}',stockSnapshot:({frameRoot})=>({ok:frameRoot.isConnected&&frameRoot.parentElement===document.body&&document.querySelectorAll('[data-trust]').length===3&&getComputedStyle(document.querySelector('#ui')).zIndex==='1',front:true,agentFront:true,rects:[...document.querySelectorAll('[data-trust]')].map(el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})}),safety,load:async d=>{R.loads.push({key:d.key,at:performance.now()});return{id:d.id,code:${literal(worker)},params:{},assets:[],wants:['state','pointer']}},onChange:s=>R.state=s,onMount:o=>R.owners.push(o),onRetire:(o,reason)=>{R.retired.push({same:R.owners.includes(o),current:o.current(),reason});if(R.reenter&&o.key==='effect-0'){R.reenter=false;ds=ds.filter(d=>d.key==='effect-1');fx.update(ds,ctx)}},onProfile:(p,o)=>{if(!o||!o.current()||!R.owners.includes(o)){R.profileOwnerFailures.push("stale");return;}R.profiles.push({...p,at:performance.now(),owned:true})}});fx.update(ds,ctx);return fx.ok};
window.update=patch=>{Object.assign(ctx,patch);return fx.update(ds,ctx)};window.jank=()=>{window.jankAt=performance.now();window.jankTimer=setInterval(()=>{const until=performance.now()+100;while(performance.now()<until){}},150)};window.done=true;
</script>`);
});
const listen=async s=>{s.listen(0,'127.0.0.1');await once(s,'listening');return s.address().port;};
async function sample(page,png,points){return page.evaluate(async({bytes,points})=>{const image=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'})),canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const c=canvas.getContext('2d');c.drawImage(image,0,0);const result=points.map(([x,y])=>[...c.getImageData(x,y,1,1).data].slice(0,3));image.close();return result;},{bytes:[...png],points});}
try{
 const port=await listen(server);preview=createPreviewListener({settings:{enabled:true,port:0,origin:null},healthPort:port,config:{},bootId:boot});await listen(preview.server);
 for(const engine of (process.env.PROBE_ENGINES||'chromium,firefox,webkit').split(',')){
  browser=await pw[engine].launch({headless:true,env:{HOME:join(scratch,'home'),TMPDIR:join(scratch,'tmp'),PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
  for(const mode of ['standard','constrained']){
   const context=await browser.newContext({viewport:mode==='standard'?{width:500,height:300}:{width:390,height:844},deviceScaleFactor:1}),page=await context.newPage(),errors=[],outside=[];
   page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>{const u=new URL(r.request().url());if(['blob:','data:'].includes(u.protocol)||u.hostname==='127.0.0.1'&&[String(port),String(preview.settings.port)].includes(u.port))return r.continue();outside.push(u.origin);return r.abort();});
   let throttled=false;
   try{
    if(engine==='chromium'&&mode==='constrained'){const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});throttled=true;}
    await page.goto(`http://127.0.0.1:${port}/`);await page.waitForFunction(()=>window.done);assert.equal(await page.evaluate(phone=>start(phone),mode==='constrained'),true);
    const cap=mode==='standard'?3:1;
    await page.waitForFunction(n=>R.state.filter(s=>s.phase==='running').length===n,cap,{timeout:15000});assert.equal(await page.locator('iframe').count(),cap);
    const observations=await page.evaluate(()=>({loads:R.loads,markers:R.markers,began:R.began,front:[...document.querySelectorAll('iframe')].filter(f=>getComputedStyle(f).zIndex==='20').length,attrs:document.querySelectorAll('[style]').length,state:R.state}));
    assert.equal(await page.evaluate(()=>R.owners.length),cap);assert.equal(await page.evaluate(()=>R.owners.every(o=>Object.isFrozen(o)&&o.current())),true);assert.equal(observations.loads.length,cap);assert.equal(observations.front,mode==='standard'?2:1);assert.equal(observations.attrs,0);assert.ok(observations.loads[0].at-observations.began>=1900);assert.deepEqual(observations.markers.map(m=>m.frames),mode==='standard'?[0,1,2]:[0]);
    // Ready is not a compositor/geometry flush. Drain host frames, then bound observation of this known red fixture.
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));let pixels;
    for(let attempt=0;attempt<12;attempt++){
     const screenshot=await page.screenshot({path:join(out,engine+'-'+mode+'.png')});pixels=await sample(page,screenshot,[[80,80],[180,80],[280,80],[30,30]]);
     for(const p of pixels.slice(0,3))assert.deepEqual(p,[0,119,255]);
     if(pixels[3][0]>240&&pixels[3][1]<65&&pixels[3][2]<65)break;await page.waitForTimeout(25);
    }
    assert.ok(pixels[3][0]>240&&pixels[3][1]<65&&pixels[3][2]<65,JSON.stringify(pixels));
    await page.mouse.click(80,80);assert.deepEqual(await page.evaluate(()=>R.clicks),['composer']);
    await page.evaluate(()=>{fx.update(ds,ctx);fx.update(ds,ctx)});await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>R.loads.length),cap);assert.equal(await page.evaluate(()=>R.owners.length),cap);
    let pauseMs=null;
    if(mode==='constrained'){
     await page.waitForFunction(()=>R.finishes.some(f=>f.reason==='healthy'),undefined,{timeout:15000});assert.equal(await page.locator('iframe').count(),1);
     await page.evaluate(()=>{ds=ds.slice(0,1);fx.update(ds,ctx);jank()});await page.waitForFunction(()=>R.pauses.length===1,undefined,{timeout:8000});
     pauseMs=await page.evaluate(()=>{clearInterval(jankTimer);return R.pauses[0].at-jankAt});assert.ok(pauseMs<6500,'host jank pause '+pauseMs);assert.equal(await page.locator('iframe').count(),0);
     await page.evaluate(()=>fx.update(ds,ctx));await page.waitForTimeout(100);assert.equal(await page.locator('iframe').count(),0);assert.equal(await page.evaluate(()=>R.loads.length),1);
    }else{
     await page.evaluate(()=>{R.keptB=R.owners.find(o=>o.key==='effect-1');R.reenter=true;fx.update([],ctx)});
     assert.equal(await page.evaluate(()=>R.keptB.current()),true);assert.equal(await page.locator('iframe').count(),1);assert.equal(await page.evaluate(()=>R.retired.some(r=>r.reason==='superseded'&&r.current)),false);
     await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>R.keptB.current()&&R.loads.length===3&&R.owners.length===3),true);
     await page.evaluate(()=>update({publicLink:true}));assert.equal(await page.locator('iframe').count(),0);await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>R.loads.length),3);
    }
    assert.deepEqual(await page.evaluate(()=>R.profileOwnerFailures),[]);const profiles=await page.evaluate(()=>R.profiles);if(mode==='constrained')assert.ok(profiles.length>0);assert.ok(profiles.every(p=>!p.metrics||p.metrics.hostFps<=1000));assert.ok(profiles.every(p=>!('workerFps'in p)&&!('workerCpuMs'in p)));
    await page.evaluate(()=>fx.dispose());assert.equal(await page.locator('iframe').count(),0);assert.equal(await page.evaluate(()=>R.owners.every(o=>!o.current())&&R.retired.length===R.owners.length&&R.retired.every(r=>r.same&&!r.current)),true);assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
    rows.push({engine,version:browser.version(),mode,throttled4x:throttled,status:'pass',cap,front:observations.front,markerBeforeMount:true,calibrationBeforeLoads:true,mountReceiptOwnership:true,retireReceiptsRevoked:true,reentrantRetainedSibling:mode==='standard',protectedPixels:3,clickThrough:true,pauseMs,inlineAttributes:0,disposedFrames:0});console.log('PASS',engine,mode);
   }catch(error){let state;try{state=await page.evaluate(()=>({rows:R.state,loads:R.loads.length,markers:R.markers,pauses:R.pauses,profiles:R.profiles.slice(-3),frames:document.querySelectorAll('iframe').length}));}catch{}rows.push({engine,version:browser.version(),mode,status:'failed',error:error.message,stack:error.stack,state,errors,outside});console.log('FAIL',engine,mode,error.message);}
   finally{await context.close();}
  }
  await browser.close();browser=null;
 }
}finally{
 if(browser)await browser.close();for(const s of [preview?.server,server])if(s?.listening){s.closeAllConnections();s.close();await once(s,'close');}
 writeFileSync(join(out,'receipt.json'),JSON.stringify({rows,passed:rows.filter(r=>r.status==='pass').length,failed:rows.filter(r=>r.status!=='pass').length},null,2));rmSync(scratch,{recursive:true,force:true});
}
if(rows.some(r=>r.status!=='pass'))process.exitCode=1;
