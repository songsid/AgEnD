/** Opaque same-listener transport SECURITY probe, not product/from-defaults acceptance. Synthetic parent cookie/storage sentinels only; no fleet, account, consent, prefs or external network.
 * npm run build; PW_DIR=<isolated Playwright prefix> PLAYWRIGHT_BROWSERS_PATH=<private cache>
 * node scripts/manual/effect-opaque-2118.mts (Node >=22 with type stripping; this file uses JS syntax).
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
import {createEffectBootstrap} from '../../dist/web-effect-bootstrap.js';
import {panelContentSecurityPolicy} from '../../dist/web-host-guard.js';
import {inflateSync} from 'node:zlib';
const out=resolve(process.env.OUT_DIR||'.artifacts/worker-smoke');mkdirSync(out,{recursive:true});
if(!process.env.PW_DIR)throw Error('Set PW_DIR to an isolated Playwright installation');
const pw=createRequire(join(resolve(process.env.PW_DIR),'package.json'))('playwright');
const privateDir=mkdtempSync(join(out,'private-'));mkdirSync(join(privateDir,'home'));mkdirSync(join(privateDir,'tmp'));
const boot='c'.repeat(32),bootstrap=createEffectBootstrap(boot),receipts=[],trapPaths=[],cleanupErrors=[];let browser,trap=0;
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

TEST.workerOrigin=self.origin;TEST.workerUrlOrigin=self.location.origin;TEST.storage={};
async function denied(name,fn){try{const value=await fn();TEST.storage[name]={blocked:false,value}}catch(e){TEST.storage[name]={blocked:true,reason:e.name}}}
const storageDone=Promise.all([
 denied('cookie',()=>document.cookie),denied('localStorage',()=>localStorage.getItem('bootstrap-secret')),
 denied('sessionStorage',()=>sessionStorage.getItem('bootstrap-secret')),
 denied('indexedDB',()=>new Promise((ok,no)=>{const r=indexedDB.open('bootstrap-secret');r.onerror=()=>no(r.error);r.onsuccess=()=>{const db=r.result;if(!db.objectStoreNames.contains('secrets')){db.close();ok('empty');return}const read=db.transaction('secrets').objectStore('secrets').get('sentinel');read.onsuccess=()=>{db.close();ok(read.result||'empty')};read.onerror=()=>{db.close();no(read.error)}}})),
 denied('cacheStorage',async()=>{const cache=await caches.open('bootstrap-secret');const r=await cache.match(__TRAP_ORIGIN__+'/cache-sentinel'),peer=await cache.match(__TRAP_ORIGIN__+'/worker-sentinel');const value={parent:r?await r.text():'empty',peer:peer?await peer.text():'empty'};await cache.put(__TRAP_ORIGIN__+'/worker-sentinel',new Response('worker-cache'));return value}),
 denied('cookieStore',()=>cookieStore.get('bootstrap_secret')),
 denied('opfs',()=>navigator.storage.getDirectory())
]);
const rasterDone=(async()=>{try{await createImageBitmap(__TRAP_ORIGIN__+'/trap/raster-url');TEST.rasterUrlBlocked=false}catch(_){TEST.rasterUrlBlocked=true}
 try{agend.canvas.getContext('2d').drawImage(__TRAP_ORIGIN__+'/trap/canvas-url',0,0);TEST.canvasUrlBlocked=false}catch(_){TEST.canvasUrlBlocked=true}
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><image href="'+__TRAP_ORIGIN__+'/trap/svg-image" width="8" height="8"/></svg>';
 try{const bitmap=await createImageBitmap(new Blob([svg],{type:'image/svg+xml'}));TEST.svg='decoded-no-network';bitmap.close()}catch(e){TEST.svg=e.name}
})();
const networkDone=Promise.all([probeNetwork(__TRAP_ORIGIN__),storageDone,rasterDone,
 fetch(__TRAP_ORIGIN__+'/trap/protected-api',{credentials:'include'}).then(r=>r.text()).then(v=>{TEST.apiExposed=v},()=>{TEST.apiBlocked=true})
]);

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
 if(bootstrap.handle(req,res))return;
 if(/^\/assets\/[a-z0-9_-]+\.js$/.test(req.url||'')){res.setHeader('Content-Type','text/javascript');res.end(readFileSync(join('dist/ui/shared',req.url.split('/').pop())));return;}
 if(req.url?.startsWith('/trap')){trap++;trapPaths.push(req.url);res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Content-Type',req.url.endsWith('/eventsource')?'text/event-stream':'text/javascript');
  res.end(req.url.endsWith('/protected-api')?'private-protected-api-secret':req.url.endsWith('/eventsource')?'data: control\n\n':req.url.endsWith('/dynamic-import')?'export default 1;':'self.postMessage("loaded");');return;}
 if(req.url==='/network-positive'){
  res.setHeader('Content-Type','text/html');const code='globalThis.TEST={network:[]};'+networkProbe+';probeNetwork('+JSON.stringify('http://127.0.0.1:'+parent.address().port)+').then(()=>fetch('+JSON.stringify('http://127.0.0.1:'+parent.address().port+'/trap/protected-api')+',{credentials:"include"})).then(r=>r.text()).then(v=>{TEST.api=v;TEST.done=true});';
  res.end('<!doctype html><script>new Worker(URL.createObjectURL(new Blob(['+safe(code)+'],{type:"text/javascript"})));</script>');return;
 }
 if(req.url==='/dom-control'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><input id=intruder><script>window.KEYS=[];addEventListener("keydown",e=>KEYS.push(e.key));intruder.focus()</script>');return;}
 const kind=new URL(req.url,'http://fixture').searchParams.get('kind')||'worker';
 const origin='http://127.0.0.1:'+parent.address().port,nonce='private-transport-probe';
 res.setHeader('Content-Type','text/html');res.setHeader('Content-Security-Policy',panelContentSecurityPolicy(nonce,{frameSrc:origin+'/effect-bootstrap'}));
 const code=kind==='hang'?'while(true){}':hostile.replaceAll('__TRAP_ORIGIN__',safe(origin));
 const script=[
  'import {createOpaqueEffectFrame} from "/assets/effect-frame.js";',
  'window.R={loads:0,ready:[],hello:[]};document.cookie="bootstrap_secret=private-cookie; SameSite=Strict";localStorage.setItem("bootstrap-secret","private-storage");',
  'window.SEEDED={};try{await new Promise((ok,no)=>{const r=indexedDB.open("bootstrap-secret",1);r.onupgradeneeded=()=>r.result.createObjectStore("secrets");r.onerror=()=>no(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction("secrets","readwrite");tx.objectStore("secrets").put("private-idb","sentinel");tx.oncomplete=()=>{db.close();SEEDED.idb=true;ok()}}})}catch(e){SEEDED.idb=e.name}try{const c=await caches.open("bootstrap-secret");await c.put(location.origin+"/cache-sentinel",new Response("private-cache"));SEEDED.cache=true}catch(e){SEEDED.cache=e.name}',
  'addEventListener("message",e=>{if(e.data?.type==="ready")R.hello.push({origin:e.origin,own:e.source===document.querySelector("#fx")?.contentWindow})});',
  'const canvas=new OffscreenCanvas(1,1);canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray([0,0,255,255]),1,1),0,0);const png=new Uint8Array(await(await canvas.convertToBlob({type:"image/png"})).arrayBuffer());',
  'window.OPTIONS={window,root:document.querySelector("#root"),origin:location.origin,boot:'+safe(boot)+',render:{code:'+safe(code)+',params:{density:2},instance:"fixture",width:64,height:64,dpr:1,assets:[{name:"assets/blue.png",mime:"image/png",bytes:png}],wants:["pointer","state","theme","reply","mention"]},onReady:()=>R.ready.push({type:"ready"})};window.FX=createOpaqueEffectFrame(OPTIONS);window.makePeer=()=>createOpaqueEffectFrame({...OPTIONS,onReady:()=>R.peerReady=true});',
  'if(!FX.ok)throw Error(FX.reason);FX.element.id="fx";FX.element.addEventListener("load",()=>R.loads++);',
  'window.postMessage({v:1,type:"ready",ch:null,boot:'+safe(boot)+'},"*");const sibling=document.createElement("iframe");sibling.sandbox="allow-scripts";sibling.className="forger";sibling.src="/effect-bootstrap";document.body.append(sibling);',
 ].join('\n');
 res.end('<!doctype html><style nonce="'+nonce+'">.agend-effect-frame{width:64px;height:64px;border:0;pointer-events:none;color-scheme:normal}.forger{display:none}</style><input id="trusted"><div id="root"></div><script type="module" nonce="'+nonce+'">'+script+'</script>');
});

parent.on('upgrade',(req,socket)=>{trap++;trapPaths.push(req.url);socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');});
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;}
function redPixels(png){
 assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');let at=8,width=0,height=0,channels=0;const parts=[];
 while(at<png.length){const size=png.readUInt32BE(at),type=png.subarray(at+4,at+8).toString(),data=png.subarray(at+8,at+8+size);at+=size+12;
  if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);assert.equal(data[8],8);channels=data[9]===2?3:data[9]===6?4:0;assert.ok(channels);assert.equal(data[12],0);assert.ok(width*height<2e6);}
  if(type==='IDAT')parts.push(data);if(type==='IEND')break;
 }
 const raw=inflateSync(Buffer.concat(parts)),stride=width*channels,rows=Buffer.alloc(stride*height);assert.equal(raw.length,(stride+1)*height);
 const paeth=(a,b,c)=>{const p=a+b-c,A=Math.abs(p-a),B=Math.abs(p-b),C=Math.abs(p-c);return A<=B&&A<=C?a:B<=C?b:c;};
 for(let row=0;row<height;row++){const filter=raw[row*(stride+1)];assert.ok(filter<=4);for(let i=0;i<stride;i++){const left=i>=channels?rows[row*stride+i-channels]:0,up=row?rows[(row-1)*stride+i]:0,corner=row&&i>=channels?rows[(row-1)*stride+i-channels]:0;rows[row*stride+i]=(raw[row*(stride+1)+i+1]+(filter===0?0:filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):paeth(left,up,corner)))&255;}}
 let count=0;for(let i=0;i<rows.length;i+=channels)if(rows[i]>200&&rows[i]>rows[i+1]+100&&rows[i]>rows[i+2]+100)count++;return count;
}

try{
 const port=await listen(parent);
 for(const engine of (process.env.PROBE_ENGINES||'chromium,firefox,webkit').split(',')){
  browser=await pw[engine].launch({headless:true,env:{HOME:join(privateDir,'home'),TMPDIR:join(privateDir,'tmp'),PATH:'/usr/bin:/bin',LANG:'C.UTF-8',FONTCONFIG_FILE:'/etc/fonts/fonts.conf'}});
  for(const kind of ['worker','hang','dom-positive','network-positive']){
   const context=await browser.newContext({viewport:{width:256,height:160}}),page=await context.newPage(),errors=[],outside=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',route=>{const u=new URL(route.request().url());if(['blob:','data:'].includes(u.protocol)||u.hostname==='127.0.0.1'&&u.port===String(port))return route.continue();outside.push(u.origin+u.pathname);return route.abort()});
   const trapStart=trap,pathsStart=trapPaths.length;
   try{
    if(kind==='network-positive'){
     const born=page.waitForEvent('worker',{timeout:10000});await page.goto(`http://127.0.0.1:${port}/network-positive`);const control=await born;
     for(let i=0;i<100;i++){if(await control.evaluate(()=>!!globalThis.TEST?.done))break;await page.waitForTimeout(100);}assert.equal(await control.evaluate(()=>!!globalThis.TEST?.done),true);const network=await control.evaluate(()=>TEST.network),hits=trapPaths.slice(pathsStart);
     for(const row of network)if(row.available)assert.ok(hits.includes('/trap/'+row.name),'missing positive transport: '+row.name);
     assert.equal(await control.evaluate(()=>TEST.api),'private-protected-api-secret');assert.ok(trap>trapStart);receipts.push({engine,version:browser.version(),kind,status:'pass',network,hits});continue;
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
     for(const d of [{v:1,type:'state',ts:1,instance:'fixture',state:'working'},{v:1,type:'reply',ts:1,instance:'fixture'},{v:1,type:'mention',ts:1},{v:1,type:'theme',ts:1,mode:'dark'},{v:1,type:'env',ts:1,width:64,height:64,dpr:1,quality:'normal'},{v:1,type:'pointer',ts:1,kind:'click',x:10,y:20,buttons:1},{v:1,type:'reply',ts:1,text:'private-secret'},{v:1,type:'state',ts:1,instance:'sibling',state:'working'}])FX.send(d);
    });
    const frame=await(await page.locator('#fx').elementHandle()).contentFrame();assert.ok(frame);
    await page.waitForTimeout(100);await page.locator('#trusted').fill('host');await page.locator('#trusted').focus();let focusMode='contentWindow.focus';await page.evaluate(()=>document.querySelector('iframe').contentWindow.focus());try{await page.waitForFunction(()=>document.activeElement.id==='fx',undefined,{timeout:1000})}catch(_){focusMode='test-only trusted canvas tabindex';await frame.evaluate(()=>{const canvas=document.querySelector('canvas');canvas.tabIndex=-1;canvas.focus()});await page.waitForFunction(()=>document.activeElement.id==='fx',undefined,{timeout:1000})}assert.equal(await page.evaluate(()=>document.activeElement.id),'fx');await page.keyboard.type('private-secret');
    let ime='not-run';if(engine==='chromium'){const cdp=await context.newCDPSession(page);await cdp.send('Input.imeSetComposition',{text:'private-ime',selectionStart:11,selectionEnd:11});ime='CDP accepted, not physical IME';}
    await page.waitForTimeout(100);
    const result=await worker.evaluate(()=>globalThis.TEST),dom=await frame.evaluate(()=>({nodes:[...document.querySelectorAll('body>*')].map(n=>n.tagName),editables:document.querySelectorAll('input,textarea,[contenteditable]').length,designMode:document.designMode}));
    assert.equal(trap-trapStart,0);assert.ok(result.network.every(row=>!row.available||row.settled&&!row.timedOut));
    for(const name of ['fetch','websocket','dynamic-import','fontface','eventsource'])assert.ok(result.network.some(row=>row.name===name),'missing network probe: '+name);
    assert.equal(result.caps.document,'undefined');assert.equal(result.caps.focus,'undefined');assert.equal(result.caps.Worker,'undefined');assert.equal(result.caps.importScripts,'undefined');assert.equal(result.create,'ReferenceError');assert.equal(result.focus,'ReferenceError');assert.deepEqual(result.keys,[]);assert.equal(result.getterCalls,0);assert.equal(result.callbackPort,false);assert.deepEqual(result.params,{density:2});
    assert.deepEqual(result.events.map(d=>d.type),['state','reply','theme','env','pointer']);assert.ok(!JSON.stringify(result).includes('private-'));assert.deepEqual(dom,{nodes:['CANVAS','SCRIPT'],editables:0,designMode:'off'});assert.equal(await page.evaluate(()=>typeof DOM_ESCAPE),'undefined');assert.deepEqual(await page.evaluate(()=>R.ready),[{type:'ready'}]);assert.equal(await page.evaluate(()=>R.loads),1);
    const pixel=await worker.evaluate(()=>Array.from(agend.canvas.getContext('2d').getImageData(8,8,1,1).data));assert.deepEqual(pixel,[0,0,255,255]);await page.locator('#fx').screenshot({path:join(out,engine+'-worker.png')});
    // Test-only injection into the trusted document: nested browsing contexts must still be denied by its CSP.
    await frame.evaluate(url=>{globalThis.CSP_VIOLATIONS=[];document.addEventListener('securitypolicyviolation',e=>CSP_VIOLATIONS.push(e.effectiveDirective));const nested=document.createElement('iframe');nested.src=url;document.body.append(nested)},`http://127.0.0.1:${port}/trap`);await frame.waitForFunction(()=>CSP_VIOLATIONS.some(x=>['frame-src','child-src'].includes(x)),undefined,{timeout:3000});assert.equal(trap-trapStart,0);

    const realm=await frame.evaluate(()=>{const denied={};for(const key of ['cookie','storage','parentDOM'])try{if(key==='cookie')document.cookie;else if(key==='storage')localStorage.getItem('bootstrap-secret');else parent.document.body;denied[key]=false}catch(_){denied[key]=true}return{origin:globalThis.origin,urlOrigin:new URL(location.href).origin,denied}});
    assert.equal(realm.origin,'null');assert.equal(realm.urlOrigin,'http://127.0.0.1:'+port);assert.ok(Object.values(realm.denied).every(Boolean));
    assert.equal(result.workerOrigin,'null');assert.equal(result.workerUrlOrigin,'null');for(const [name,r] of Object.entries(result.storage))if(name==='cacheStorage'&&!r.blocked)assert.deepEqual(r.value,{parent:'empty',peer:'empty'});else assert.equal(r.blocked,true);
    assert.equal(result.apiBlocked,true);assert.equal(result.apiExposed,undefined);assert.equal(result.rasterUrlBlocked,true);assert.equal(result.canvasUrlBlocked,true);
    assert.ok(await page.evaluate(()=>document.cookie.includes('private-cookie')&&localStorage.getItem('bootstrap-secret')==='private-storage'));
    let painted=0;for(const delay of [0,100,300,600,1000]){await page.waitForTimeout(delay);painted=redPixels(await page.locator('#fx').screenshot({path:join(out,engine+'-actual-worker-paint.png')}));if(painted>1000)break}assert.ok(painted>1000,'independent visible paint');
    const hello=await page.evaluate(()=>R.hello);assert.ok(hello.some(h=>h.own&&h.origin==='null'));assert.equal(await page.evaluate(()=>FX.state().loads),1);
    const parentCache=await page.evaluate(async()=>{try{const c=await caches.open('bootstrap-secret');return{parent:await(await c.match(location.origin+'/cache-sentinel')).text(),worker:!!await c.match(location.origin+'/worker-sentinel')}}catch(e){return{unavailable:e.name}}});
    if(!parentCache.unavailable)assert.deepEqual(parentCache,{parent:'private-cache',worker:false});
    const peerBorn=page.waitForEvent('worker',{timeout:10000});await page.evaluate(()=>{window.PEER=makePeer();PEER.element.id='peer'});const peerWorker=await peerBorn;await page.waitForFunction(()=>R.peerReady===true,undefined,{timeout:10000});
    const peerStorage=await peerWorker.evaluate(()=>TEST.storage);for(const [name,r]of Object.entries(peerStorage))if(name==='cacheStorage'&&!r.blocked)assert.deepEqual(r.value,{parent:'empty',peer:'empty'});else assert.equal(r.blocked,true);
    assert.equal(trap-trapStart,0);const peerClosed=peerWorker.waitForEvent('close');await page.evaluate(()=>PEER.remove('probe_done'));await peerClosed;
    const closed=worker.waitForEvent('close',{timeout:5000});await frame.evaluate(()=>dispatchEvent(new Event('pagehide')));await closed;assert.deepEqual(outside,[]);assert.deepEqual(errors,[]);
    receipts.push({engine,version:browser.version(),kind,status:'pass',ime,focusMode,result,dom,loads:1,ready:[{type:'ready'}],nestedCspTrap:0,workerNetworkTrap:0,sameListener:true,realm,parentCache,peerStorage,independentRedPixels:painted,pagehideTerminates:true,errors,outside});
   }catch(error){receipts.push({engine,version:browser.version(),kind,status:'failed',errorName:error.name,error:error.message,errors,outside,worker:await page.workers()[0]?.evaluate(()=>globalThis.TEST).catch(()=>null),seeded:await page.evaluate(()=>globalThis.SEEDED).catch(()=>null)});}
   finally{await context.close();}
  }
  await browser.close();browser=null;
 }
}finally{
 const attempt=async(name,fn)=>{try{await fn()}catch(error){cleanupErrors.push({name,error:String(error)})}};
 await attempt('browser',async()=>{if(browser)await browser.close()});
 await attempt('listener',async()=>{if(parent.listening){parent.closeAllConnections();parent.close();await once(parent,'close')}});
 await attempt('scratch',async()=>rmSync(privateDir,{recursive:true,force:true}));
 const hashes=Object.fromEntries(['src/web-effect-worker.ts','src/web-effect-bootstrap.ts','src/ui/shared/effect-frame.js','dist/web-effect-worker.js','dist/web-effect-bootstrap.js','scripts/manual/effect-opaque-2118.mts'].map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')]));
 writeFileSync(join(out,'receipt.json'),JSON.stringify({securityProbe:true,fromDefaultsAcceptance:false,syntheticSecretSentinels:true,productMount:false,realSafari:false,physicalIme:false,hashes,trap,trapPaths,receipts,cleanupErrors},null,2)+'\n');console.log(JSON.stringify(receipts.map(({engine,kind,status,error})=>({engine,kind,status,error})),null,2));
}
if(cleanupErrors.length||receipts.some(r=>r.status!=='pass'))process.exitCode=1;
