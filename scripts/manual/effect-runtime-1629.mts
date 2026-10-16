/** Scratch browser controls for the actual built Worker shim; no fleet, tmux, account or service.
 * npm run build; PW_DIR=<isolated Playwright prefix> PLAYWRIGHT_BROWSERS_PATH=<private cache>
 * node scripts/manual/effect-runtime-1629.mts (Node >=22 with type stripping; this file uses JS syntax).
 * PROBE_ENGINES=chromium,firefox,webkit; OUT_DIR=<own scratch output>.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
// @ts-ignore compiled production module; script runs only after build.
import {createPreviewListener} from '../../dist/web-preview.js';
const out=resolve(process.env.OUT_DIR||'.artifacts/worker-smoke');mkdirSync(out,{recursive:true});
if(!process.env.PW_DIR)throw Error('Set PW_DIR to an isolated Playwright installation');
const pw=createRequire(join(resolve(process.env.PW_DIR),'package.json'))('playwright');
const privateDir=mkdtempSync(join(out,'private-'));mkdirSync(join(privateDir,'home'));mkdirSync(join(privateDir,'tmp'));
const boot='c'.repeat(32),receipts=[],trapPaths=[];let preview,browser,trap=0;
// The same probe runs without CSP as a positive transport control. All destinations are this scratch server.
const networkProbe=String.raw`
async function probeNetwork(base) {
 const later=self.setTimeout.bind(self), checks=[];
 function attempt(name,available,start) {
  const row={name,available,settled:false,timedOut:false};TEST.network.push(row);if(!available)return;
  checks.push(new Promise(resolve=>{let ended=false;const done=()=>{if(ended)return;ended=true;row.settled=true;resolve();};later(()=>{if(!ended){row.timedOut=true;done();}},1500);try{start(base+'/trap/'+name,done);}catch(_){done();}}));
 }
 attempt('fetch',typeof fetch==='function',(url,done)=>fetch(url).then(done,done));
 attempt('image-fetch',typeof fetch==='function',(url,done)=>fetch(url).then(r=>r.blob()).then(done,done));
 attempt('websocket',typeof WebSocket==='function',(url,done)=>{const socket=new WebSocket(url.replace('http:','ws:'));socket.onopen=()=>{socket.close();done();};socket.onerror=done;later(()=>{try{socket.close();}catch(_){}},1400);});
 attempt('eventsource',typeof EventSource==='function',(url,done)=>{const stream=new EventSource(url);const end=()=>{stream.close();done();};stream.onopen=end;stream.onerror=end;later(end,1400);});
 attempt('dynamic-import',true,(url,done)=>import(url).then(done,done));
 attempt('fontface',typeof FontFace==='function',(url,done)=>new FontFace('scratch','url('+url+')').load().then(done,done));
 attempt('xhr',typeof XMLHttpRequest==='function',(url,done)=>{const xhr=new XMLHttpRequest();xhr.open('GET',url);xhr.timeout=1400;xhr.onloadend=done;xhr.send();});
 attempt('nested-worker',typeof Worker==='function',(url,done)=>{const child=new Worker(url);const end=()=>{child.terminate();done();};child.onmessage=end;child.onerror=end;later(end,1400);});
 await Promise.all(checks);
}
`;

const hostile=String.raw`
globalThis.TEST={caps:{},keys:[],events:[],params:agend.params,getterCalls:0,callbackPort:false,network:[]};
${networkProbe}
const networkDone=probeNetwork(__TRAP_ORIGIN__);
for(const k of ['document','window','HTMLElement','Element','DOMParser','focus','parent','Worker','SharedWorker','importScripts'])TEST.caps[k]=typeof globalThis[k];
try{document.createElement('input');TEST.created=true}catch(e){TEST.create=e.name}
try{focus();TEST.focused=true}catch(e){TEST.focus=e.name}
for(const k of ['keydown','keyup','keypress','beforeinput','input','compositionstart','compositionupdate','compositionend','paste','drop'])addEventListener(k,()=>TEST.keys.push(k));
const originalData=Object.getOwnPropertyDescriptor(MessageEvent.prototype,'data').get;Object.defineProperty(MessageEvent.prototype,'data',{get(){TEST.getterCalls++;return originalData.call(this)}});self.setTimeout=function(fn){fn();return 0};
const delimiter='</script><script>globalThis.DOM_ESCAPE=true</script>';
const c=agend.canvas,x=c.getContext('2d');x.fillStyle='#ff0000';x.fillRect(0,0,64,64);x.drawImage(agend.asset('assets/blue.png'),0,0,16,16);x.fillStyle='#ffffff';x.font='12px sans-serif';x.fillText('Ag',20,28);
for(const k of ['state','reply','mention','theme','env','pointer'])agend.on(k,e=>TEST.events.push(e));
agend.on('state',()=>{TEST.callbackPort=!!globalThis.event?.ports?.length;x.fillStyle='#00ff00';x.fillRect(0,48,64,16)});
self.postMessage({type:'focus'});self.postMessage({type:'ready',extra:'forged'});self.postMessage({type:'frame-time',ms:0});
networkDone.then(()=>{agend.ready();agend.ready();});
`;
function safe(value){return JSON.stringify(value).replace(/</g,'\\u003c');}
const parent=createServer((req,res)=>{
 if(req.url?.startsWith('/trap')){trap++;trapPaths.push(req.url);res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Content-Type',req.url.endsWith('/eventsource')?'text/event-stream':'text/javascript');
  res.end(req.url.endsWith('/eventsource')?'data: control\n\n':req.url.endsWith('/dynamic-import')?'export default 1;':'self.postMessage("loaded");');return;}
 if(req.url==='/network-positive'){
  res.setHeader('Content-Type','text/html');const code='globalThis.TEST={network:[]};'+networkProbe+';probeNetwork('+JSON.stringify('http://127.0.0.1:'+parent.address().port)+').then(()=>TEST.done=true);';
  res.end('<!doctype html><script>new Worker(URL.createObjectURL(new Blob(['+safe(code)+'],{type:"text/javascript"})));</script>');return;
 }
 if(req.url==='/dom-control'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><input id=intruder><script>window.KEYS=[];addEventListener("keydown",e=>KEYS.push(e.key));intruder.focus()</script>');return;}
 const kind=new URL(req.url,'http://fixture').searchParams.get('kind')||'worker';
 res.setHeader('Content-Type','text/html');res.end(`<!doctype html><input id=trusted><script>
 window.R={loads:0,ready:[],boot:0};const f=document.createElement('iframe');f.id='fx';f.sandbox='allow-scripts';f.tabIndex=-1;f.style='width:64px;height:64px;border:0;pointer-events:none';
 f.addEventListener('load',()=>{R.loads++;if(R.loads>1)f.remove()});let sent=false;
 addEventListener('message',async e=>{if(sent||e.source!==f.contentWindow||e.origin!=='null'||JSON.stringify(e.data)!==JSON.stringify({v:1,type:'ready',ch:null,boot:${safe(boot)}}))return;sent=true;R.boot++;
 const canvas=new OffscreenCanvas(1,1);canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray([0,0,255,255]),1,1),0,0);const png=new Uint8Array(await(await canvas.convertToBlob({type:'image/png'})).arrayBuffer());
 const channel=new MessageChannel();window.PORT=channel.port1;PORT.onmessage=e=>R.ready.push(e.data);PORT.start();
 f.contentWindow.postMessage({v:1,type:'render',ch:'0123456789abcdef',code:${safe(kind==='hang'?'while(true){}':hostile.replace('__TRAP_ORIGIN__',safe('http://127.0.0.1:'+parent.address().port)))},params:{density:2},instance:'fixture',width:64,height:64,dpr:1,assets:[{name:'assets/blue.png',mime:'image/png',bytes:png}]},'*',[channel.port2]);
 });f.src='http://127.0.0.1:${preview?.settings.port}/effect';document.body.append(f);</script>`);
});
parent.on('upgrade',(req,socket)=>{trap++;trapPaths.push(req.url);socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');});
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;}
try{
 const port=await listen(parent);preview=createPreviewListener({settings:{enabled:true,port:0,origin:null},healthPort:port,config:{},bootId:boot});await listen(preview.server);
 for(const engine of (process.env.PROBE_ENGINES||'chromium,firefox,webkit').split(',')){
  browser=await pw[engine].launch({headless:true,env:{HOME:join(privateDir,'home'),TMPDIR:join(privateDir,'tmp'),PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
  for(const kind of ['worker','hang','dom-positive','network-positive']){
   const context=await browser.newContext({viewport:{width:256,height:160}}),page=await context.newPage(),errors=[],outside=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',route=>{const u=new URL(route.request().url());if(['blob:','data:'].includes(u.protocol)||u.hostname==='127.0.0.1'&&[String(port),String(preview.settings.port)].includes(u.port))return route.continue();outside.push(u.origin+u.pathname);return route.abort()});
   const trapStart=trap,pathsStart=trapPaths.length;
   try{
    if(kind==='network-positive'){
     const born=page.waitForEvent('worker',{timeout:10000});await page.goto(`http://127.0.0.1:${port}/network-positive`);const control=await born;
     for(let i=0;i<100;i++){if(await control.evaluate(()=>!!globalThis.TEST?.done))break;await page.waitForTimeout(100);}assert.equal(await control.evaluate(()=>!!globalThis.TEST?.done),true);const network=await control.evaluate(()=>TEST.network),hits=trapPaths.slice(pathsStart);
     for(const row of network)if(row.available)assert.ok(hits.includes('/trap/'+row.name),'missing positive transport: '+row.name);
     assert.ok(trap>trapStart);receipts.push({engine,version:browser.version(),kind,status:'pass',network,hits});continue;
    }
    if(kind==='dom-positive'){
     await page.goto(`http://127.0.0.1:${port}/dom-control`);await page.locator('#intruder').focus();await page.keyboard.type('positive-key');
     assert.equal(await page.locator('#intruder').inputValue(),'positive-key');assert.ok(await page.evaluate(()=>KEYS.length)>0);
     receipts.push({engine,version:browser.version(),kind,status:'pass'});continue;
    }
    const born=page.waitForEvent('worker',{timeout:10000});await page.goto(`http://127.0.0.1:${port}/?kind=${kind}`);const worker=await born;
    if(kind==='hang'){
     await worker.waitForEvent('close',{timeout:15000});assert.deepEqual(await page.evaluate(()=>R.ready),[]);assert.equal(await page.evaluate(()=>R.loads),1);receipts.push({engine,version:browser.version(),kind,status:'pass',startupDeadlineMs:10000});continue;
    }
    await page.waitForFunction(()=>R.ready.length===1,undefined,{timeout:10000});
    await page.evaluate(()=>{
     for(const d of [{v:1,type:'state',ts:1,instance:'fixture',state:'working'},{v:1,type:'reply',ts:1},{v:1,type:'mention',ts:1},{v:1,type:'theme',ts:1,mode:'dark'},{v:1,type:'env',ts:1,width:64,height:64,dpr:1,quality:'normal'},{v:1,type:'pointer',ts:1,kind:'click',x:10,y:20,buttons:1},{v:1,type:'reply',ts:1,text:'private-secret'},{v:1,type:'state',ts:1,instance:'sibling',state:'working'}])PORT.postMessage(d);
    });
    const frame=page.frames().find(f=>f.url().endsWith('/effect'));assert.ok(frame);
    await page.waitForTimeout(100);await page.locator('#trusted').fill('host');await page.locator('#trusted').focus();let focusMode='contentWindow.focus';await page.evaluate(()=>document.querySelector('iframe').contentWindow.focus());try{await page.waitForFunction(()=>document.activeElement.id==='fx',undefined,{timeout:1000})}catch(_){focusMode='test-only trusted canvas tabindex';await frame.evaluate(()=>{const canvas=document.querySelector('canvas');canvas.tabIndex=-1;canvas.focus()});await page.waitForFunction(()=>document.activeElement.id==='fx',undefined,{timeout:1000})}assert.equal(await page.evaluate(()=>document.activeElement.id),'fx');await page.keyboard.type('private-secret');
    let ime='not-run';if(engine==='chromium'){const cdp=await context.newCDPSession(page);await cdp.send('Input.imeSetComposition',{text:'private-ime',selectionStart:11,selectionEnd:11});ime='CDP accepted, not physical IME';}
    await page.waitForTimeout(100);
    const result=await worker.evaluate(()=>globalThis.TEST),dom=await frame.evaluate(()=>({nodes:[...document.querySelectorAll('body>*')].map(n=>n.tagName),editables:document.querySelectorAll('input,textarea,[contenteditable]').length,designMode:document.designMode}));
    assert.equal(trap-trapStart,0);assert.ok(result.network.every(row=>!row.available||row.settled&&!row.timedOut));
    for(const name of ['fetch','websocket','dynamic-import','fontface','eventsource'])assert.ok(result.network.some(row=>row.name===name),'missing network probe: '+name);
    assert.equal(result.caps.document,'undefined');assert.equal(result.caps.focus,'undefined');assert.equal(result.caps.Worker,'undefined');assert.equal(result.caps.importScripts,'undefined');assert.equal(result.create,'ReferenceError');assert.equal(result.focus,'ReferenceError');assert.deepEqual(result.keys,[]);assert.equal(result.getterCalls,0);assert.equal(result.callbackPort,false);assert.deepEqual(result.params,{density:2});
    assert.deepEqual(result.events.map(d=>d.type),['state','reply','mention','theme','env','pointer']);assert.ok(!JSON.stringify(result).includes('private-'));assert.deepEqual(dom,{nodes:['CANVAS','SCRIPT'],editables:0,designMode:'off'});assert.equal(await page.evaluate(()=>typeof DOM_ESCAPE),'undefined');assert.deepEqual(await page.evaluate(()=>R.ready),[{type:'ready'}]);assert.equal(await page.evaluate(()=>R.loads),1);
    const pixel=await worker.evaluate(()=>Array.from(agend.canvas.getContext('2d').getImageData(8,8,1,1).data));assert.deepEqual(pixel,[0,0,255,255]);await page.locator('#fx').screenshot({path:join(out,engine+'-worker.png')});
    // Test-only injection into the trusted document: nested browsing contexts must still be denied by its CSP.
    await frame.evaluate(url=>{globalThis.CSP_VIOLATIONS=[];document.addEventListener('securitypolicyviolation',e=>CSP_VIOLATIONS.push(e.effectiveDirective));const nested=document.createElement('iframe');nested.src=url;document.body.append(nested)},`http://127.0.0.1:${port}/trap`);await frame.waitForFunction(()=>CSP_VIOLATIONS.some(x=>['frame-src','child-src'].includes(x)),undefined,{timeout:3000});assert.equal(trap-trapStart,0);
    const closed=worker.waitForEvent('close',{timeout:5000});await frame.evaluate(()=>dispatchEvent(new Event('pagehide')));await closed;assert.deepEqual(outside,[]);assert.deepEqual(errors,[]);
    receipts.push({engine,version:browser.version(),kind,status:'pass',ime,focusMode,result,dom,loads:1,ready:[{type:'ready'}],nestedCspTrap:0,workerNetworkTrap:0,pagehideTerminates:true,errors,outside});
   }catch(error){receipts.push({engine,version:browser.version(),kind,status:'failed',errorName:error.name,error:error.message,errors,outside});}
   finally{await context.close();}
  }
  await browser.close();browser=null;
 }
}finally{
 if(browser)await browser.close();for(const server of [preview?.server,parent])if(server?.listening){server.closeAllConnections();server.close();await once(server,'close');}rmSync(privateDir,{recursive:true,force:true});
 const hashes=Object.fromEntries(['src/web-effect-worker.ts','src/web-preview.ts','dist/web-effect-worker.js','dist/web-preview.js','scripts/manual/effect-runtime-1629.mts'].map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')]));
 writeFileSync(join(out,'receipt.json'),JSON.stringify({productMount:false,realSafari:false,physicalIme:false,hashes,trap,trapPaths,receipts},null,2)+'\n');console.log(JSON.stringify(receipts.map(({engine,kind,status,error})=>({engine,kind,status,error})),null,2));
}
if(receipts.some(r=>r.status!=='pass'))process.exitCode=1;
