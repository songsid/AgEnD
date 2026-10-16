/** Scratch listeners/browsers only. Build first. PW_DIR + PLAYWRIGHT_BROWSERS_PATH use private tools.
 * PROBE_ENGINES=chromium,firefox,webkit OUT_DIR=<own scratch> node scripts/manual/effect-geometry-1629.mts
 * Linux WebKit is not a real-Safari claim. This exercises unmounted helpers, not a product registry.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
// @ts-ignore built production helper; run npm run build first.
import {createPreviewListener} from '../../dist/web-preview.js';
if(!process.env.PW_DIR) throw Error('Set PW_DIR to an isolated Playwright prefix');
const pw=createRequire(join(resolve(process.env.PW_DIR),'package.json'))('playwright');
const out=resolve(process.env.OUT_DIR||'.artifacts/geometry-native');mkdirSync(out,{recursive:true});
const scratch=mkdtempSync(join(out,'private-'));mkdirSync(join(scratch,'home'));mkdirSync(join(scratch,'tmp'));
const boot='b'.repeat(32),receipts=[];let preview,browser;
// Decode only our own bounded 8-bit, non-interlaced Playwright screenshots. No production PNG reader.
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
const server=createServer((req,res)=>{
 const path=req.url?.slice(1);
 if(path==='assets/app.css'){res.setHeader('Content-Type','text/css');res.end('/* fixed host stylesheet fixture */');return;}
 if(['effect-frame.js','effect-policy.js','effect-geometry.js','effect-host-style.js','effect-baseline.js','effect-stock-snapshot.js'].includes(path)){res.setHeader('Content-Type','text/javascript');res.end(readFileSync(resolve('src/ui/shared',path)));return;}
 res.setHeader('Content-Type','text/html');res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'self' 'nonce-geometry-probe'; style-src 'self' 'nonce-geometry-probe'; frame-src http://127.0.0.1:${preview?.settings.port}; connect-src 'none'; img-src 'none'; worker-src 'none'`);
 res.end(`<!doctype html><link rel=stylesheet href=/assets/app.css><style nonce=geometry-probe>body{margin:0;background:white}#region{position:absolute;left:20px;top:20px;width:400px;height:200px}button{position:absolute;width:80px;height:40px;border:0;padding:0;background:#0077ff;color:white}#composer{left:80px;top:60px}#reply{left:140px;top:60px}#approval{left:300px;top:60px}#composer.moved{left:220px}iframe.shift{left:111px!important}body.exposed iframe.agend-effect-frame{visibility:visible!important}</style><div id=region></div><button id=composer data-trust=composer></button><button id=reply data-trust=reply-buttons></button><button id=approval data-trust=approval></button><div id=root></div><script type=module nonce=geometry-probe>
import {createEffectFrame} from '/effect-frame.js';import {createEffectGeometry,hostEffectRect} from '/effect-geometry.js';import {captureEffectBaseline} from '/effect-baseline.js';
window.R={ready:0,clicks:[],removed:[]};for(const el of document.querySelectorAll('button'))el.onclick=()=>R.clicks.push(el.id);
window.calibrate=()=>captureEffectBaseline({window,empty:()=>document.querySelectorAll('iframe').length===0}).promise;
window.start=()=>{window.G=createEffectGeometry({window});if(!G.ok)throw Error(G.reason);window.F=createEffectFrame({window,root:document.querySelector('#root'),origin:'http://127.0.0.1:${preview?.settings.port}',boot:'${boot}',render:{code:"const c=agend.canvas.getContext('2d');c.fillStyle='#ff0000';c.fillRect(0,0,400,200);agend.ready()",params:{},instance:'own',width:400,height:200,dpr:1,assets:[],wants:[]},onReady:()=>R.ready++,onRemove:x=>R.removed.push(x)});window.B=G.bind(F.element,{layer:'front',by:'agent'});if(!B.ok)F.remove("geometry_refused");return B.ok;};
window.sync=()=>B.sync(hostEffectRect(document.querySelector('#region')),{ok:true,front:true,agentFront:true,rects:[...document.querySelectorAll('[data-trust]')].map(el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})});window.done=true;
</script>`);
});
const listen=async s=>{s.listen(0,'127.0.0.1');await once(s,'listening');return s.address().port;};
try{
 const port=await listen(server);preview=createPreviewListener({settings:{enabled:true,port:0,origin:null},healthPort:port,config:{},bootId:boot});await listen(preview.server);
 for(const engine of (process.env.PROBE_ENGINES||'chromium,firefox,webkit').split(',')){
  browser=await pw[engine].launch({headless:true,env:{HOME:join(scratch,'home'),TMPDIR:join(scratch,'tmp'),PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
  const context=await browser.newContext({viewport:{width:500,height:300},deviceScaleFactor:1}),page=await context.newPage(),errors=[],outside=[];
  page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>{const u=new URL(r.request().url());if(['blob:','data:'].includes(u.protocol)||u.hostname==='127.0.0.1'&&[String(port),String(preview.settings.port)].includes(u.port))return r.continue();outside.push(u.origin);return r.abort();});
  try{
   await page.goto(`http://127.0.0.1:${port}/`);await page.waitForFunction(()=>window.done);
   const baseline=await page.evaluate(()=>calibrate());assert.equal(baseline.ok,true);assert.ok(baseline.baselineFps>1&&baseline.baselineFps<=1000);
   assert.equal(await page.locator('iframe').count(),0);const before=await page.screenshot({path:join(out,engine+'-before.png')});
   assert.equal(await page.evaluate(()=>start()),true);await page.waitForFunction(()=>R.ready===1);assert.equal(await page.evaluate(()=>getComputedStyle(F.element).visibility),'hidden');const waiting=await page.screenshot();assert.deepEqual(pixel(waiting,100,80),pixel(before,100,80));assert.deepEqual(pixel(waiting,30,30),pixel(before,30,30));assert.equal(await page.evaluate(()=>sync()),true);
   await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));const after=await page.screenshot({path:join(out,engine+'-clipped.png')});
   const safe=[[100,80],[160,80],[320,80],[75,80],[225,80],[295,80]];
   for(const [x,y]of safe)assert.deepEqual(pixel(after,x,y),pixel(before,x,y),`protected ${x},${y}`);
   const red=pixel(after,30,30);assert.ok(red[0]>240&&red[1]<60&&red[2]<60,JSON.stringify(red));
   await page.mouse.click(100,80);assert.deepEqual(await page.evaluate(()=>R.clicks),['composer']);
   assert.equal(await page.locator('[style]').count(),0);assert.deepEqual(await page.evaluate(()=>F.state()),{ready:true,removed:false,loads:1});
   await page.evaluate(()=>F.element.classList.add('shift'));assert.equal(await page.evaluate(()=>sync()),false);assert.equal(await page.evaluate(()=>getComputedStyle(F.element).visibility),'hidden');
   await page.evaluate(()=>{F.element.classList.remove('shift');document.querySelector('#composer').classList.add('moved');B.hide();});assert.equal(await page.evaluate(()=>sync()),true);
   const moved=await page.screenshot({path:join(out,engine+'-moved.png')});assert.deepEqual(pixel(moved,240,80),[0,119,255]);assert.ok(pixel(moved,100,80)[1]<60);
   await page.evaluate(()=>{const s=document.querySelector('link[rel=stylesheet]').sheet;s.insertRule('body{transform:scale(.8)}',s.cssRules.length);});assert.equal(await page.evaluate(()=>sync()),false);assert.equal(await page.evaluate(()=>getComputedStyle(F.element).visibility),'hidden');
   await page.evaluate(()=>{G.dispose();F.remove("geometry_dispose")});assert.equal(await page.locator('iframe').count(),0);assert.equal(await page.locator('[style]').count(),0);
   // Reproduce the reviewer's initial-cascade witness before any sync or child readiness.
   await page.goto(`http://127.0.0.1:${port}/`);await page.waitForFunction(()=>window.done);
   await page.evaluate(()=>document.body.classList.add('exposed'));assert.equal(await page.evaluate(()=>start()),false);
   await page.waitForTimeout(150);assert.equal(await page.locator('iframe').count(),0);assert.equal(await page.evaluate(()=>R.ready),0);
   assert.deepEqual(await page.evaluate(()=>R.removed),['geometry_refused']);const refused=await page.screenshot({path:join(out,engine+'-initial-refused.png')});assert.deepEqual(pixel(refused,100,80),[0,119,255]);await page.evaluate(()=>G.dispose());
   assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
   receipts.push({engine,version:browser.version(),status:'pass',baselineFps:baseline.baselineFps,protectedPixels:safe.length,redPixel:red,oneLoad:true,acceptedInitiallyHidden:true,strongInitialCascadeRefused:true,clickThrough:true,computedMismatchHidden:true,transformedSpaceHidden:true,inlineAttributes:0,disposedFrames:0});console.log('PASS',engine);
  }catch(error){let observation;try{observation=await page.evaluate(()=>({ready:R.ready,frame:F?.state(),bind:B?.ok,computed:F?.element?{space:getComputedStyle(F.element).transform,clip:getComputedStyle(F.element).clipPath,visibility:getComputedStyle(F.element).visibility}:null}));}catch{}receipts.push({engine,version:browser.version(),status:'failed',error:error.message,stack:error.stack,observation,errors,outside});console.log('FAIL',engine,error.message);}
  finally{await context.close();await browser.close();browser=null;}
 }
}finally{
 if(browser)await browser.close();for(const s of [preview?.server,server])if(s?.listening){s.closeAllConnections();s.close();await once(s,'close');}
 writeFileSync(join(out,'receipt.json'),JSON.stringify({receipts,passed:receipts.filter(x=>x.status==='pass').length,failed:receipts.filter(x=>x.status!=='pass').length},null,2));rmSync(scratch,{recursive:true,force:true});
}
if(receipts.some(x=>x.status!=='pass'))process.exitCode=1;
