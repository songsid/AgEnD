/** Native localStorage receipt controls; private loopback/context only, no frames or product boot. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {once} from 'node:events';import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
if(!process.env.PW_DIR)throw Error('Set PW_DIR to private Playwright tools');
const pw=createRequire(join(resolve(process.env.PW_DIR),'package.json'))('playwright'),out=resolve(process.env.OUT_DIR||'.artifacts/safety-native');mkdirSync(out,{recursive:true});
const scratch=mkdtempSync(join(out,'private-'));mkdirSync(join(scratch,'home'));mkdirSync(join(scratch,'tmp'));let browser;const rows=[];
const server=createServer((req,res)=>{
 const path=req.url?.slice(1);
 if(['effect-safety.js','effect-profiler.js'].includes(path)){res.setHeader('Content-Type','text/javascript');res.end(readFileSync(resolve('src/ui/shared',path)));return;}
 res.setHeader('Content-Type','text/html');res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self' 'nonce-safety-probe'; connect-src 'none'; frame-src 'none'; worker-src 'none'");
 res.end(`<!doctype html><script type=module nonce=safety-probe>import{createEffectSafety}from'/effect-safety.js';window.wall=1000;window.id='a'.repeat(32);window.createEffectSafetyForProbe=()=>createEffectSafety({storage:localStorage,crypto,wall:()=>wall});window.s=createEffectSafetyForProbe();window.done=true;</script>`);
});
try{
 server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
 for(const engine of (process.env.PROBE_ENGINES||'chromium,firefox,webkit').split(',')){
  browser=await pw[engine].launch({headless:true,env:{HOME:join(scratch,'home'),TMPDIR:join(scratch,'tmp'),PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
  const context=await browser.newContext(),a=await context.newPage(),b=await context.newPage(),errors=[],outside=[];
  for(const page of[a,b]){page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>{if(new URL(r.request().url()).origin===origin)return r.continue();outside.push(r.request().url());return r.abort();});}
  const open=async page=>{await page.goto(origin);await page.waitForFunction(()=>window.done)};
  try{
   await open(a);assert.equal(await a.evaluate(()=>localStorage.length),0);assert.equal(await a.evaluate(()=>s.allowed(id,'standard')),true);
   const token=await a.evaluate(()=>s.begin({id,device:'standard',key:'effect-0'}));assert.match(token,/^[a-f0-9]{32}$/);assert.equal(await a.evaluate(()=>localStorage.length),1);
   await open(b);assert.equal(await b.evaluate(()=>s.status(id,'standard').state),'interrupted');assert.equal(await b.evaluate(()=>s.begin({id,device:'standard',key:'effect-0'})),null);
   await a.reload();await a.waitForFunction(()=>window.done);assert.equal(await a.evaluate(()=>s.status(id,'standard').state),'interrupted');assert.equal(await a.evaluate(()=>s.resume(id,'standard')),true);
   // Cross-process localStorage delivery can lag a completed evaluate, especially in WebKit.
   // Wait for each observed receipt before the next dependent human action; this is no atomicity claim.
   const pause=page=>page.evaluate(()=>s.pause({id,device:'standard',reason:'host_budget'}));
   assert.equal(await pause(a),true);assert.equal(await pause(b),true);await a.waitForFunction(()=>s.status(id,'standard').history?.pauses.length===2);assert.equal(await a.evaluate(()=>s.status(id,'standard').history.pauses.length),2);
   assert.equal(await a.evaluate(()=>s.resume(id,'standard')),true);await b.waitForFunction(()=>s.status(id,'standard').state==='ok');assert.equal(await pause(b),true);await a.waitForFunction(()=>s.status(id,'standard').state==='off');assert.equal(await a.evaluate(()=>s.status(id,'standard').state),'off');
   await a.reload();await a.waitForFunction(()=>window.done);assert.equal(await a.evaluate(()=>{wall=86400000*7;return s.status(id,'standard').state}),'off');assert.equal(await a.evaluate(()=>s.resume(id,'standard')),false);
   assert.equal(await a.evaluate(()=>s.allowed(id,'constrained')),true);assert.equal(await a.evaluate(()=>s.allowed('b'.repeat(32),'standard')),true);
   // A live page cannot keep its authority after another tab explicitly clears its pending marker.
   await a.evaluate(()=>{window.id='c'.repeat(32);window.s=createEffectSafetyForProbe();window.liveToken=s.begin({id,device:'standard',key:'live'})});
   await b.waitForFunction(()=>s.status('c'.repeat(32),'standard').state==='interrupted');assert.equal(await b.evaluate(()=>s.resume('c'.repeat(32),'standard')),true);await a.waitForFunction(()=>s.status(id,'standard').state==='unknown');
   assert.equal(await a.evaluate(()=>s.status(id,'standard').state),'unknown');assert.equal(await a.evaluate(()=>s.finish(liveToken,'healthy')),false);
   assert.equal(await a.locator('iframe').count(),0);assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
   rows.push({engine,version:browser.version(),status:'pass',persistedBeforeReceipt:true,reloadInterrupted:true,foreignTabRefused:true,independentPauseReceipts:3,stickyAfterReloadAndAging:true,foreignResumeRevokesLiveOwner:true,noFrames:true});console.log('PASS',engine);
  }catch(error){const storage=await Promise.all([a,b].map(page=>page.evaluate(()=>({rows:Object.entries(localStorage),state:s.status(id,'standard'),wall})).catch(()=>null)));rows.push({engine,status:'failed',error:error.message,stack:error.stack,storage,errors,outside});console.log('FAIL',engine,error.message);}
  finally{await context.close();await browser.close();browser=null;}
 }
}finally{
 if(browser)await browser.close();if(server.listening){server.closeAllConnections();server.close();await once(server,'close');}rmSync(scratch,{recursive:true,force:true});writeFileSync(join(out,'receipt.json'),JSON.stringify({rows,passed:rows.filter(r=>r.status==='pass').length,failed:rows.filter(r=>r.status!=='pass').length},null,2));
}
if(rows.some(r=>r.status!=='pass'))process.exitCode=1;
