/** Private native host-cursor controller fixture only. No actual app mount or live session claimed.
 * PW_DIR + PLAYWRIGHT_BROWSERS_PATH use private tools. PROBE_ENGINES=chromium,firefox,webkit.
 * The external stock app.css and production helpers are real; HTML is a fixed minimal stock-control fixture.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {deflateSync} from 'node:zlib';
import {createRequire} from 'node:module';
import {readFileSync,mkdirSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
const out=resolve(process.env.OUT_DIR||'.artifacts/cursor-controller-native');mkdirSync(out,{recursive:true});
const scratch=mkdtempSync(join(out,'private-'));mkdirSync(join(scratch,'home'));mkdirSync(join(scratch,'tmp'));
if(!process.env.PW_DIR)throw Error('PW_DIR is required');const pw=createRequire(join(resolve(process.env.PW_DIR),'package.json'))('playwright');
function chunk(type,bytes=Buffer.alloc(0)){const b=Buffer.alloc(bytes.length+12);b.writeUInt32BE(bytes.length);b.write(type,4);b.set(bytes,8);let crc=0xffffffff;for(const byte of b.subarray(4,-4)){crc^=byte;for(let n=0;n<8;n++)crc=crc>>>1^(crc&1?0xedb88320:0)}b.writeUInt32BE((crc^0xffffffff)>>>0,b.length-4);return b}
const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0,255]))),chunk('IEND')]);
const modules=['effect-cursor.js','effect-host-style.js','effect-runtime-loader.js','effect-poster-reader.js'];
const server=createServer((req,res)=>{
 const path=new URL(req.url!,'http://127.0.0.1').pathname;
 if(path==='/assets/app.css'){res.setHeader('Content-Type','text/css');res.end(readFileSync('src/ui/shared/app.css'));return;}
 if(modules.includes(path.slice(1))){res.setHeader('Content-Type','text/javascript');res.end(readFileSync(resolve('src/ui/shared',path.slice(1))));return;}
 if(path==='/cursor.png'){res.setHeader('Content-Type','image/png');res.end(png);return;}
 res.setHeader('Content-Type','text/html');res.setHeader('Content-Security-Policy',"default-src 'none';script-src 'self' 'nonce-cursor-probe';style-src 'self' 'nonce-cursor-probe';img-src 'self' blob:;connect-src 'self';worker-src 'none';frame-src 'none'");
 res.end(`<!doctype html><link rel=stylesheet href=/assets/app.css><style nonce=cursor-probe>.shell{display:block;width:100%;min-height:300px}.plain{padding:20px}.explicit-text{cursor:text}body.cascade .shell{cursor:crosshair!important}</style><div id=app><div class=shell><div class=plain>Plain space</div><button class=btn>Button</button><input class=explicit-text value=Text><div class=side-resize></div><div class=pv-divider>Resize</div></div></div><script nonce=cursor-probe type=module>
import{createEffectCursor}from'/effect-cursor.js';import{createEffectRuntimeLoader}from'/effect-runtime-loader.js';
const id='${'a'.repeat(32)}',epoch='${'b'.repeat(16)}';let live=true;window.R={reads:0,ended:false};
const original=fetch;window.fetch=(path,options)=>{if(String(path).startsWith('/ui/effects/image/')){R.reads++;return original('/cursor.png',options)}return original(path,options)};
const loader=createEffectRuntimeLoader({window,ownerEpoch:epoch,current:()=>live});window.C=createEffectCursor({window,current:()=>live,readImage:(selection,signal)=>loader.cursorImageSettled(selection.id,signal)});
window.choose=(generation=1)=>C.update({id,generation,hotspot:[0,0]},true);window.off=()=>C.update(null,false);window.end=()=>{live=false;C.dispose();loader.dispose();R.ended=true};window.done=true;
</script>`);
});
const receipts=[];let browser;
try{
 server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;
 for(const engine of(process.env.PROBE_ENGINES||'chromium,firefox,webkit').split(','))for(const width of[1366,390]){
  browser=await pw[engine].launch({headless:true,env:{HOME:join(scratch,'home'),TMPDIR:join(scratch,'tmp'),PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
  const context=await browser.newContext({viewport:{width,height:768}}),page=await context.newPage(),errors=[],outside=[];
  page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.protocol==='blob:'||u.hostname==='127.0.0.1'&&u.port===String(port))return route.continue();outside.push(u.href);return route.abort()});
  try{
   await page.goto(`http://127.0.0.1:${port}`);await page.waitForFunction(()=>window.done);
   const values=()=>page.evaluate(()=>Object.fromEntries(['.shell','.plain','.btn','.explicit-text','.side-resize','.pv-divider'].map(s=>[s,getComputedStyle(document.querySelector(s)).cursor])));
   const original=await values();await page.evaluate(()=>choose());await page.waitForFunction(()=>C.snapshot().status==='running');
   const active=await values();assert.match(active['.shell'],/^url\(["']?blob:/);assert.match(active['.shell'],/0 0,\s*auto$/);assert.equal(active['.plain'],active['.shell']);assert.equal(active['.btn'],'pointer');assert.equal(active['.explicit-text'],'text');assert.equal(active['.side-resize'],'col-resize');assert.equal(active['.pv-divider'],'col-resize');
   assert.equal(await page.locator('iframe,canvas,img,[style]').count(),0);assert.equal(await page.evaluate(()=>R.reads),1);
   await page.evaluate(()=>{document.querySelector('.shell').className='shell collapsed';choose()});assert.equal((await values())['.shell'],active['.shell']);assert.equal(await page.evaluate(()=>R.reads),1);
   await page.evaluate(()=>off());assert.equal((await values())['.shell'],original['.shell']);assert.equal(await page.locator('[data-agend-effect-cursor]').count(),0);
   await page.evaluate(()=>{document.body.classList.add('cascade');choose(2)});await page.waitForFunction(()=>C.snapshot().status==='unavailable');assert.equal((await values())['.shell'],'crosshair');assert.equal(await page.locator('[data-agend-effect-cursor]').count(),0);
   await page.evaluate(()=>{document.body.classList.remove('cascade');choose(3)});await page.waitForFunction(()=>C.snapshot().status==='running');
   await page.evaluate(()=>document.body.classList.add('side-resizing'));const resize=await values();assert.equal(resize['.shell'],'col-resize');assert.equal(resize['.plain'],'col-resize');await page.evaluate(()=>document.body.classList.remove('side-resizing'));
   await page.evaluate(()=>end());assert.equal((await values())['.shell'],original['.shell']);assert.equal(await page.locator('[data-agend-effect-cursor]').count(),0);assert.equal(await page.evaluate(()=>[...document.querySelector('link').sheet.cssRules].filter(r=>r.selectorText?.includes('data-agend-effect-cursor')).length),0);
   assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);receipts.push({engine,version:browser.version(),width,status:'pass',nativeDecode:true,sharedLoader:true,staticBlobCursor:true,shellOnlyInheritance:true,explicitPointerTextResize:true,sidebarDragOverride:true,cascadeRefused:true,shellClassSafe:true,noInlineDomFrames:true,cleanup:true,actualApp:false});console.log('PASS',engine,width);
  }catch(error){let state;try{state=await page.evaluate(()=>({snapshot:C.snapshot(),reads:R.reads,cursor:getComputedStyle(document.querySelector('.shell')).cursor}))}catch{}receipts.push({engine,width,status:'failed',error:error.message,stack:error.stack,state,errors,outside});console.log('FAIL',engine,width,error.message)}
  finally{await context.close();await browser.close();browser=null}
 }
}finally{if(browser)await browser.close();server.closeAllConnections();if(server.listening){server.close();await once(server,'close')}writeFileSync(join(out,'receipt.json'),JSON.stringify({receipts,passed:receipts.filter(x=>x.status==='pass').length,failed:receipts.filter(x=>x.status!=='pass').length},null,2));rmSync(scratch,{recursive:true,force:true})}
if(receipts.length!==6||receipts.some(x=>x.status!=='pass'))process.exitCode=1;
