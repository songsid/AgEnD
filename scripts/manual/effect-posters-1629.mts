/** Static poster transport/paint controls, not a product UI mount.
 * npm run build; PW_DIR=<isolated Playwright prefix> PLAYWRIGHT_BROWSERS_PATH=<private cache>
 * OUT_DIR=<own output> PROBE_ENGINES=chromium,firefox,webkit node scripts/manual/effect-posters-1629.mts
 * Private stores/HTTP/browser only; no fleet, real account, process manager, tmux or tunnel.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {deflateSync,inflateSync} from 'node:zlib';
// @ts-ignore built production modules; run only after build.
import {WebEffectLibrary} from '../../dist/web-effect-library.js';
// @ts-ignore
import {ThemeStore} from '../../dist/web-theme-store.js';
// @ts-ignore
import {WebEffectProfiles} from '../../dist/web-effect-profiles.js';
// @ts-ignore
import {WebEffectService} from '../../dist/web-effect-service.js';
// @ts-ignore
import {WebSessionStore,tokenEpoch} from '../../dist/web-session.js';
// @ts-ignore
import {handleWebRequest} from '../../dist/web-api.js';
// @ts-ignore
import {encodeEffectFiles} from '../../dist/web-effect-upload.js';
const out=resolve(process.env.OUT_DIR||'.artifacts/poster-native');mkdirSync(out,{recursive:true});
if(!process.env.PW_DIR)throw Error('Set PW_DIR to an isolated Playwright installation');
const pw=createRequire(join(resolve(process.env.PW_DIR),'package.json'))('playwright');
const root=mkdtempSync(join(out,'private-'));mkdirSync(join(root,'home'));mkdirSync(join(root,'tmp'));
const rows=[],paths=[],token='private-poster-recipe',library=new WebEffectLibrary(root),themes=new ThemeStore(root),profiles=new WebEffectProfiles(root),sessions=new WebSessionStore();
library.registerReferenceSource('placements',()=>themes.placedEffects().flatMap(p=>p.ids.map(id=>({id,holder:'instance:'+p.name}))));
const service=new WebEffectService({library,themes,profiles,known:n=>n==='fixture',changed(){}});
function chunk(type,data=Buffer.alloc(0)){
 const bytes=Buffer.alloc(data.length+12);bytes.writeUInt32BE(data.length);bytes.write(type,4);data.copy(bytes,8);
 let crc=0xffffffff;for(const b of bytes.subarray(4,-4)){crc^=b;for(let bit=0;bit<8;bit++)crc=crc>>>1^(crc&1?0xedb88320:0);}bytes.writeUInt32BE((crc^0xffffffff)>>>0,bytes.length-4);return bytes;
}
const signature=Buffer.from([137,80,78,71,13,10,26,10]),ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6;
const actl=Buffer.alloc(8);actl.writeUInt32BE(2);
function control(seq){const b=Buffer.alloc(26);b.writeUInt32BE(seq);b.writeUInt32BE(1,4);b.writeUInt32BE(1,8);b.writeUInt16BE(20,20);b.writeUInt16BE(100,22);return chunk('fcTL',b);}
const red=deflateSync(Buffer.from([0,255,0,0,255])),blue=deflateSync(Buffer.from([0,0,0,255,255])),seq=Buffer.alloc(4);seq.writeUInt32BE(2);
const animated=Buffer.concat([signature,chunk('IHDR',ihdr),chunk('acTL',actl),control(0),chunk('IDAT',red),control(1),chunk('fdAT',Buffer.concat([seq,blue])),chunk('IEND')]);
const files=new Map([['effect.json',Buffer.from(JSON.stringify({v:1,runtime:'canvas-worker-v1',worker:'worker.js',name:'poster',title:'Poster',regions:['chat'],layer:'front',wants:[],poster:'poster.png'}))],['worker.js',Buffer.from('throw Error("Poster read must not run this private code")')],['poster.png',animated]]);
const uploaded=service.upload('private-owner',encodeEffectFiles(files));assert.equal(typeof uploaded.id,'string');const id=uploaded.id;assert.equal(service.apply('private-owner',{instance:'fixture',id}).id,id);
const ctx={webToken:token,webSessions:sessions,effectService:service};let browser;
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
 paths.push(req.url);
 if(req.url==='/fixture'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><style>body{margin:0}img{width:32px;height:32px;image-rendering:pixelated}</style><img id=raw src=/raw-apng><img id=poster src="/ui/effect-posters/'+id+'.png?instance=fixture">');return;}
 if(req.url==='/raw-apng'){res.setHeader('Content-Type','image/png');res.end(animated);return;}
 if(!handleWebRequest(req,res,new URL(req.url,'http://localhost'),ctx)){res.writeHead(404);res.end();}
});
try{
 server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
 for(const engine of (process.env.PROBE_ENGINES||'chromium,firefox,webkit').split(',')){
  browser=await pw[engine].launch({headless:true,env:{HOME:join(root,'home'),TMPDIR:join(root,'tmp'),PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
  const context=await browser.newContext({viewport:{width:100,height:64}}),page=await context.newPage(),outside=[],errors=[];
  const made=sessions.create({tier:'read',surface:'local',label:'private recipe',tokenEpoch:tokenEpoch(token)});
  await context.addCookies([{name:'agend_session',value:made.sessionId,url:origin}]);
  await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin===origin)return route.continue();outside.push(u.href);return route.abort();});
  page.on('pageerror',e=>errors.push(e.message));
  try{
   await page.goto(origin+'/fixture');await page.waitForFunction(()=>[...document.images].every(i=>i.complete&&i.naturalWidth===1));
   const image=await page.request.get(origin+'/ui/effect-posters/'+id+'.png?instance=fixture');assert.equal(image.status(),200);
   assert.equal(image.headers()['content-security-policy'],"default-src 'none'; sandbox");
   const bytes=await image.body();for(const name of ['acTL','fcTL','fdAT'])assert.equal(bytes.includes(Buffer.from(name)),false);
   const positive=new Set();for(let i=0;i<16;i++){
    const shot=await page.screenshot();positive.add(pixel(shot,12,12).join(','));assert.deepEqual(pixel(shot,44,12),[255,0,0]);await page.waitForTimeout(70);
   }
   assert.ok(positive.has('255,0,0')&&positive.has('0,0,255'),'real APNG positive must visibly animate: '+JSON.stringify([...positive]));
   assert.equal(await page.locator('iframe,canvas').count(),0);assert.equal(page.workers().length,0);assert.deepEqual(outside,[]);assert.deepEqual(errors,[]);
   const summary=await page.request.get(origin+'/ui/effect-posters?instance=fixture');assert.deepEqual(await summary.json(),{rev:themes.rev(),posters:[{id,title:'Poster'}]});
   await page.screenshot({path:join(out,engine+'-static.png')});
   rows.push({engine,version:browser.version(),status:'pass',builtService:true,authenticatedRead:true,rawApngAnimates:true,staticSamples:16,noWorkerOrFrame:true,productUi:false});console.log('PASS',engine);
  }catch(e){rows.push({engine,status:'fail',error:String(e)});console.error(e);}
  finally{await context.close();await browser.close();browser=null;}
 }
 // Current placement, not a prior successful summary, authorizes each subsequent image fetch.
 service.remove('private-owner',{instance:'fixture',id});assert.equal(service.placedPoster(id,'fixture').ok,false);
 assert.ok(!paths.some(p=>p.startsWith('/ui/effects')));
}finally{
 if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(()=>r()));
 writeFileSync(join(out,'receipt.json'),JSON.stringify({rows,paths,privateStoresRemoved:true},null,2)+'\n');rmSync(root,{recursive:true,force:true});
}
assert.equal(rows.length,(process.env.PROBE_ENGINES||'chromium,firefox,webkit').split(',').length);assert.ok(rows.every(r=>r.status==='pass'));
