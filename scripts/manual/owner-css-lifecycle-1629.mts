/** Actual stylesheet load/error events in private browsers. No effect runtime, account, fleet or service. */
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const pw = createRequire(join(resolve(process.env.PW_DIR!), "package.json"))("playwright");
const out=resolve(process.env.OUT_DIR||'.artifacts/owner-css-native');mkdirSync(out,{recursive:true});
const scratch=mkdtempSync(join(out,'private-'));mkdirSync(join(scratch,'home'));mkdirSync(join(scratch,'tmp'));
const A='a'.repeat(32),B='b'.repeat(32),C='c'.repeat(32),rows:any[]=[];
let active:string|null=null,evidence='off',stateFailure=false,holdState=false,holdCss=false;
const cssHeld:ServerResponse[]=[],stateHeld:ServerResponse[]=[];
const json=(res:ServerResponse,body:unknown,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
const css=(res:ServerResponse,color:string)=>{res.writeHead(200,{'Content-Type':'text/css','Cache-Control':'no-store'});res.end(`.sample{color:${color}}`);};
const server=createServer((req,res)=>{
 const u=new URL(req.url||'/', 'http://127.0.0.1'),p=u.pathname;
 if(/^\/assets\/[a-z0-9._-]+$/.test(p)){
  try{res.writeHead(200,{'Content-Type':p.endsWith('.css')?'text/css':'text/javascript'});res.end(readFileSync(join('src/ui/shared',p.split('/').at(-1)!)));}catch{res.statusCode=404;res.end();}return;
 }
 if(p==='/ui/owner-css/state'){
  if(holdState){stateHeld.push(res);server.emit('state-held');return;}
  json(res,{active,pending:null,effectState:evidence},stateFailure?503:200);return;
 }
 if(p==='/ui/owner-css.css'){
  const v=u.searchParams.get('v');if(v===C){res.writeHead(404);res.end();return;}
  if(v===B&&holdCss){cssHeld.push(res);server.emit('css-held');return;}
  css(res,v===A?'rgb(255,0,0)':'rgb(0,0,255)');return;
 }
 if(p!=='/'){json(res,{ok:true});return;}
 res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':"default-src 'none'; script-src 'self' 'nonce-css-lifecycle'; style-src 'self'; connect-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'",'Cache-Control':'no-store'});
 res.end(`<!doctype html><html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><link rel=stylesheet href=/assets/tokens.css><link rel=stylesheet href=/assets/app.css><body data-mode=full data-owner-css-state=off><div class=sample>Host stylesheet lifecycle</div><script type=module nonce=css-lifecycle>
import * as oc from '/assets/owner-css.js';import{navStore}from'/assets/app-nav.js';import{appStore}from'/assets/app-store.js';
navStore.set({route:{panel:'chat',instance:'fixture'},seq:1});appStore.set({prefsRev:0});
const events=[];oc.ownerCssLifecycle.subscribe(s=>events.push({...s,links:document.querySelectorAll('#owner-css').length}));
let old=null;window.probe={events,snapshot:()=>({...oc.ownerCssLifecycle.get(),links:document.querySelectorAll('#owner-css').length,color:getComputedStyle(document.querySelector('.sample')).color}),select:v=>{old=document.getElementById('owner-css');oc.setOwnerCssActive(v);},late:()=>{old?.dispatchEvent(new Event('load'));old?.dispatchEvent(new Event('error'));},off:v=>oc.setOwnerCssOffHere(v),route:panel=>navStore.set({route:{panel,instance:'fixture'},seq:navStore.get().seq+1}),rev:()=>appStore.set({prefsRev:appStore.get().prefsRev+1})};oc.installOwnerCss();
</script></body></html>`);
});
let browser:any;
const snap=(page:any)=>page.evaluate(()=>(window as any).probe.snapshot());
const waitState=(page:any,state:string)=>page.waitForFunction(s=>(window as any).probe?.snapshot().state===s,state,{timeout:5000});
try{
 server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as any).port;
 for(const engine of (process.env.PROBE_ENGINES||'chromium,firefox,webkit').split(',')){
  browser=await pw[engine].launch({headless:true,env:{HOME:join(scratch,'home'),TMPDIR:join(scratch,'tmp'),PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
  for(const width of [1366,390]){
   active=null;evidence='off';stateFailure=false;holdState=false;holdCss=false;
   const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors:string[]=[],requests:string[]=[];
   page.on('pageerror',(e:Error)=>errors.push(e.message));await page.route('**/*',(r:any)=>{const u=new URL(r.request().url());requests.push(u.pathname);return u.hostname==='127.0.0.1'&&u.port===String(port)?r.continue():r.abort();});
   try{
    await page.goto(`http://127.0.0.1:${port}/`);await waitState(page,'off');assert.equal((await snap(page)).links,0);
    active=A;evidence='on';await page.evaluate(v=>(window as any).probe.select(v),A);await waitState(page,'on');assert.deepEqual(await snap(page),{...(await snap(page)),links:1,color:'rgb(255, 0, 0)'});
    active=B;holdCss=true;const held=once(server,'css-held');await page.evaluate(v=>(window as any).probe.select(v),B);await held;assert.equal((await snap(page)).state,'loading');await page.evaluate(()=>(window as any).probe.late());assert.equal((await snap(page)).state,'loading');for(const res of cssHeld.splice(0))css(res,'rgb(0,0,255)');holdCss=false;await waitState(page,'on');assert.equal((await snap(page)).color,'rgb(0, 0, 255)');
    active=C;await page.evaluate(v=>(window as any).probe.select(v),C);await waitState(page,'unknown');assert.equal((await snap(page)).reason,'load_failed');
    await page.evaluate(()=>(window as any).probe.off(true));await waitState(page,'off');assert.equal((await snap(page)).links,0);await page.evaluate(()=>(window as any).probe.late());assert.equal((await snap(page)).state,'off');
    active=A;await page.evaluate(v=>(window as any).probe.select(v),A);assert.equal((await snap(page)).links,0);await page.evaluate(()=>(window as any).probe.off(false));await waitState(page,'on');assert.equal((await snap(page)).color,'rgb(255, 0, 0)');
    await page.evaluate(()=>(window as any).probe.route('settings'));await waitState(page,'off');assert.equal((await snap(page)).links,0);await page.evaluate(()=>(window as any).probe.route('chat'));await waitState(page,'on');
    stateFailure=true;await page.evaluate(()=>(window as any).probe.rev());await waitState(page,'unknown');assert.equal((await snap(page)).color,'rgb(255, 0, 0)');stateFailure=false;
    active=null;evidence='unknown';await page.evaluate(()=>(window as any).probe.rev());await page.waitForFunction(()=>!(window as any).probe.snapshot().links);assert.equal((await snap(page)).state,'unknown');
    holdState=true;const stale=once(server,'state-held');await page.evaluate(()=>(window as any).probe.rev());await stale;await page.evaluate(()=>(window as any).probe.select(null));assert.equal((await snap(page)).state,'off');for(const res of stateHeld.splice(0))json(res,{active:A,effectState:'on',pending:null});holdState=false;await page.waitForTimeout(50);assert.equal((await snap(page)).state,'off');assert.equal((await snap(page)).links,0);
    const events=await page.evaluate(()=>(window as any).probe.events);assert.ok(events.some(e=>e.state==='loading')&&events.some(e=>e.state==='on')&&events.some(e=>e.state==='unknown')&&events.some(e=>e.state==='off'));assert.ok(events.filter(e=>e.state==='off').every(e=>e.links===0));assert.ok(events.every((e,i)=>i===0||e.generation>events[i-1].generation));
    assert.equal(await page.locator('iframe,canvas').count(),0);assert.deepEqual(errors,[]);assert.ok(!requests.some(p=>p.includes('/effect')));rows.push({engine,version:browser.version(),width,events,requests,final:await snap(page),errors});
   }finally{await context.close();}
  }
  await browser.close();browser=null;
 }
}finally{
 for(const res of [...cssHeld,...stateHeld])res.destroy();await browser?.close();await new Promise<void>(r=>server.close(()=>r()));rmSync(scratch,{recursive:true,force:true});writeFileSync(join(out,'receipt.json'),JSON.stringify({scratchRemoved:true,noFleet:true,noEffects:true,rows},null,2));
}
console.log(JSON.stringify(rows.map(({engine,width,final})=>({engine,width,final}))));
