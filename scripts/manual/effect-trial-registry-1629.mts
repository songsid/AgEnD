/** Actual Shell+Chat + actual unmounted TrialPanel through ONE private component-slot overlay.
 * Built preview/factory and Canvas Worker; private offline listeners only. Not a product mount/cap/auth proof.
 * Build first. PW_DIR/OUT_DIR required as for the other effect recipes. Linux WebKit is not Safari. */
import assert from "node:assert/strict";
import {inflateSync} from "node:zlib";
import {createServer} from "node:http";
import {once} from "node:events";
import {createRequire} from "node:module";
import {join,resolve} from "node:path";
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
// @ts-ignore Build first; the real effect response, not a copied shim.
import {createPreviewListener} from "../../dist/web-preview.js";
const pw=createRequire(join(resolve(process.env.PW_DIR!),"package.json"))("playwright");
const out=resolve(process.env.OUT_DIR||".artifacts/trial-stage-native");mkdirSync(out,{recursive:true});
const scratch=mkdtempSync(join(out,"private-"));mkdirSync(join(scratch,"home"));mkdirSync(join(scratch,"tmp"));
const boot="b".repeat(32),rows:any[]=[];let browser:any,preview:any;
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
 const u=new URL(req.url||"/","http://localhost"),path=u.pathname;
 if(/^\/assets\/[a-z0-9._-]+$/.test(path)||/^\/ui\/js\/[a-z0-9_-]+\.js$/.test(path)){
  try{let source=readFileSync(join("src/ui",path.startsWith("/assets/")?"shared":"",path.split("/").at(-1)!),"utf8");
   if(path==="/ui/js/panel-chat.js"){
    const slot=/<\$\{PreviewPanel\} name=\$\{name\} split=\$\{split\}[\s\S]*?setPreviewOptIn\(true, commit\)\} \/>/g;
    assert.equal([...source.matchAll(slot)].length,1,"one exact component overlay; original Chat and Shell otherwise unchanged");
    source='import {EffectTrialPanel} from "/ui/js/effect-trial-panel.js";\n'+source.replace(slot,'<'+ '${EffectTrialPanel} ...'+ '${window.trialProps} />');
   }
   res.setHeader("Content-Type",path.endsWith(".css")?"text/css":"text/javascript");res.end(source);
  }catch(e){console.error(e);res.statusCode=500;res.setHeader("Content-Type","text/plain; charset=utf-8");res.end("Internal fixture error");}return;
 }
 if(path!=="/"){res.setHeader("Content-Type","application/json");res.end(JSON.stringify(path==="/ui/history"?{messages:[]} :path==="/auth/session"?{tier:"admin",label:"private fixture",expiresAt:Date.now()+60000}:{ok:true}));return;}
 res.setHeader("Content-Type","text/html");res.setHeader("Content-Security-Policy",`default-src 'none'; script-src 'self' 'nonce-trial-probe'; style-src 'self'; connect-src 'self'; frame-src http://127.0.0.1:${preview.settings.port}; img-src 'self' blob:; font-src 'self'; worker-src 'none'`);
 res.end(`<!doctype html><link rel=stylesheet href=/assets/tokens.css><link rel=stylesheet href=/assets/app.css><body data-mode=full><div id=app class=app-root></div><script type=module nonce=trial-probe>
 import{html,render}from'/assets/app-html.js';import{Shell,showDialog,closeDialog}from'/assets/app-shell.js';import{Dialog}from'/assets/ui-dialog.js';import{appStore}from'/assets/app-store.js';import{navStore}from'/assets/app-nav.js';import{ChatPanel,boot}from'/ui/js/panel-chat.js';import{stockEffectTrust}from'/assets/effect-stock-trust.js';import{effectTrialStage}from'/assets/effect-trial-stage.js';import{createEffectRegistry}from'/assets/effect-registry.js';import{setLang}from'/assets/app-i18n.js';
 const q=new URL(location.href).searchParams;setLang(q.get('lang')||'en',{store:false});document.documentElement.dataset.theme=q.get('dark')==='1'?'dark':'light';
 const binding=Object.freeze({key:'trial:a',id:'a'.repeat(32),run:'c'.repeat(32),instance:'worker',generation:1});
 window.R={ready:0,stops:[],markers:[],finishes:[],profiles:[],loads:[]};let api=null,pool=null,css='off',live=true,token=0;
 window.trialProps={binding,title:'<img src=x> sample',current:()=>live,ownerCss:()=>css,onStage:x=>api=x,onStop:x=>R.stops.push(x),onClose:x=>R.stops.push('closed')};
 appStore.set({ready:true,connection:'open',instances:[{name:'worker',backend:'codex',state:'idle'}],exec:{worker:'idle'},awaiting:{worker:null},connections:1});navStore.set({route:{panel:'chat',instance:'worker'},seq:1});boot({stream:{on(){return()=>{}}},boot:null,deps:{announce(){},toast(){}}});
 render(html\`<\${Shell} panels=\${new Map([['chat',{Component:ChatPanel}]])} onNewInstance=\${()=>{}} />\`,document.querySelector('#app'));
 const stock=()=>stockEffectTrust(window,{ownerCss:css});
 const projection=()=>api&&effectTrialStage(api.receipt,binding,stock());
 const gates=()=>({safe:false,publicLink:false,reducedMotion:false,saveData:false,hidden:false,enabled:true,show:true,previewReady:true,optIn:true,constrained:innerWidth<900,modal:true,openInstance:'worker'});
 const trial=()=>{const p=projection();return p?{key:binding.key,id:binding.id,region:'chat',layer:'front',by:'agent',order:0,paused:false,visible:true,instance:'worker',params:{},element:p.root,trialStage:api.receipt,generation:binding.generation}:null};
 window.T={stock,projection,start:()=>{const d=trial();if(!d)return false;
 pool=createEffectRegistry({window,origin:'http://127.0.0.1:${preview.settings.port}',boot:'${boot}',stockSnapshot:input=>stockEffectTrust(window,{...input,ownerCss:css}),
 load:async d=>{R.loads.push(d);return{id:d.id,code:"const c=agend.canvas.getContext('2d');c.fillStyle='#ff0000';c.fillRect(0,0,4096,4096);agend.ready()",params:{},assets:[],wants:['state','reply','theme','pointer']}},
 safety:{allowed:()=>true,begin:d=>{const t='marker-'+(++token);R.markers.push({t,d,frames:document.querySelectorAll('iframe').length});return t},finish:(t,why)=>{R.finishes.push({t,why});return true},pause:r=>{R.pause=r;return true},resume:()=>true},onProfile:r=>R.profiles.push(r),onChange:rows=>{R.ready=rows.filter(r=>r.key===binding.key&&r.phase==='running').length}});
 if(!pool.ok)return false;
 const others=[1,2,3].map(n=>({key:'other-'+n,id:String(n).repeat(32),region:'chat',layer:'behind',by:'agent',order:n,paused:false,visible:true,instance:'worker',params:{},element:document.querySelector('.chat-main')}));
 others.push({...others[0],key:'forbidden-front',id:'f'.repeat(32),layer:'front',by:'human',order:8});pool.update([d,...others],gates());return true;},
 snapshot:()=>pool.snapshot(),dispose:()=>{pool?.dispose();api?.dispose()},css:v=>css=v,stale:()=>live=false,dialog:()=>showDialog(Dialog,{title:'Other dialog',children:'Protected host dialog'}),closeDialog,
 publish:()=>pool.publish('state',{state:'working'},'worker'),blur:()=>window.dispatchEvent(new Event('blur')),
 unmount:()=>render(null,document.querySelector('#app')),
 rule:text=>{const s=document.querySelector('link[href="/assets/app.css"]').sheet;return s.insertRule(text,s.cssRules.length)}};
 </script>`);
});
const listen=async(s:any)=>{s.listen(0,"127.0.0.1");await once(s,"listening");return s.address().port;};

try{
 const port=await listen(server);const fault=await fetch(`http://127.0.0.1:${port}/assets/fixture-missing.js`);assert.equal(fault.status,500);assert.equal(fault.headers.get("content-type"),"text/plain; charset=utf-8");assert.equal(await fault.text(),"Internal fixture error");preview=createPreviewListener({settings:{enabled:true,port:0,origin:null},healthPort:port,config:{},bootId:boot});await listen(preview.server);
 for(const engine of(process.env.PROBE_ENGINES||"chromium,firefox,webkit").split(",")){
  browser=await pw[engine].launch({headless:true,env:{HOME:join(scratch,"home"),TMPDIR:join(scratch,"tmp"),PATH:"/usr/bin:/bin",LANG:"C.UTF-8"}});
  for(const [width,lang,dark]of [[1366,"en",false],[390,"zh-TW",true]] as const){
   const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors:string[]=[],outside:string[]=[];
   page.on("pageerror",(e:Error)=>errors.push(e.message));await page.route("**/*",(r:any)=>{const u=new URL(r.request().url());if(['blob:','data:'].includes(u.protocol)||u.hostname==='127.0.0.1'&&[String(port),String(preview.settings.port)].includes(u.port))return r.continue();outside.push(u.origin);return r.abort();});
   const max=width<900?1:3;
   const load=async()=>{await page.goto(`http://127.0.0.1:${port}/?lang=${lang}&dark=${dark?1:0}`);await page.locator('.effect-trial-stage').waitFor();await page.waitForTimeout(80);await page.evaluate(()=>{const e=document.activeElement;if(e instanceof HTMLElement)e.blur();});};
   const start=async()=>{assert.equal(await page.evaluate(()=>(window as any).T.start()),true);assert.equal(await page.locator('iframe').count(),0,'empty shared baseline first');await page.waitForFunction(()=>(window as any).R.ready===1,{},{timeout:15000});await page.waitForTimeout(80);};
   try{
    await load();const stock=await page.evaluate(()=>(window as any).T.stock());assert.equal(stock.ok,true);assert.equal(stock.front,false);assert.equal(stock.agentFront,false);
    const baseline=await page.screenshot();const points=await page.evaluate(()=>['.effect-trial-head strong','.effect-trial-controls button','.effect-trial-note',...(innerWidth>=900?['.composer-box']:[])].map(q=>{const r=document.querySelector(q).getBoundingClientRect();return{q,x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2)}}));
    await start();assert.equal(await page.locator('iframe').count(),max);assert.equal(await page.locator('.effect-trial-stage > iframe').count(),1);assert.equal(await page.locator('.agend-effect-layer').count(),1);
    const state=await page.evaluate(()=>({s:(window as any).T.snapshot(),markers:(window as any).R.markers,loads:(window as any).R.loads}));assert.equal(state.loads.length,max);assert.equal(state.s.find(r=>r.key==='forbidden-front').phase,null);assert.equal(state.markers.length,max);assert.equal(state.markers[0].frames,0);assert.equal(state.s.filter(r=>r.verdict==='queued').length,width<900?3:1);
    const painted=await page.screenshot({path:join(out,`${engine}-${width}-common-pool.png`)});for(const p of points)assert.deepEqual(pixel(painted,p.x,p.y),pixel(baseline,p.x,p.y),'protected '+p.q);
    assert.ok(await page.evaluate(()=>(window as any).T.publish())>=1);assert.equal(JSON.stringify(state.loads).includes('trialStage'),false);
    const frame=await page.locator('.effect-trial-stage > iframe').getAttribute('id');assert.ok(frame);
    await page.locator('.effect-trial-controls button').click();assert.equal(await page.locator('.effect-trial-stage > iframe').count(),0,'synchronous stage/factory retirement');assert.equal(await page.evaluate(()=>(window as any).R.finishes.filter(x=>x.t==='marker-1').length),1);await page.waitForTimeout(80);assert.ok(await page.locator('iframe').count()<=max);
    const faults=['owner-on','owner-loading','owner-unknown','dialog','menu','blur','stale','contain'];
    for(const fault of faults){await load();await start();await page.evaluate(f=>{const t=(window as any).T;if(f.startsWith('owner-'))t.css(f.slice(6));if(f==='dialog')t.dialog();if(f==='menu')document.querySelector('.panel-head .menu>button').click();if(f==='blur')t.blur();if(f==='stale')t.stale();if(f==='contain')t.rule('.effect-trial-stage{contain:none!important}');},fault);await page.waitForFunction(()=>!document.querySelector('.effect-trial-stage > iframe'));assert.equal(await page.evaluate(()=>(window as any).T.projection()),null);assert.equal(await page.evaluate(()=>(window as any).R.finishes.filter(x=>x.t==='marker-1').length),1);}
    await load();await start();await page.evaluate(()=>(window as any).T.dispose());assert.equal(await page.locator('iframe,.agend-effect-layer').count(),0);assert.equal(await page.evaluate(()=>(window as any).R.finishes.length),max);
    assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);rows.push({engine,width,lang,dark,max,samePool:true,declaredFront:true,ordinaryFrontSuppressed:true,emptyBaseline:true,markerBeforeFrame:true,exactMarkerFinish:true,protectedPoints:points,faults,dispose:true,errors,outside});
   }finally{await context.close();}
  }await browser.close();browser=null;
 }
}finally{await browser?.close();if(preview)await new Promise<void>(r=>preview.server.close(()=>r()));await new Promise<void>(r=>server.close(()=>r()));rmSync(scratch,{recursive:true,force:true});writeFileSync(join(out,'receipt.json'),JSON.stringify({rows,scratchRemoved:true,noFleet:true,noProductMount:true,modeledSafetyStorage:true},null,2));}
console.log(JSON.stringify(rows));
