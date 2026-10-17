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
 if(path==="/assets/inter.woff2"){res.setHeader("Content-Type","font/woff2");res.end(readFileSync("src/ui/shared/fonts/inter.woff2"));return;}
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
 import{html,render}from'/assets/app-html.js';import{Shell,showDialog,closeDialog}from'/assets/app-shell.js';import{Dialog}from'/assets/ui-dialog.js';import{appStore}from'/assets/app-store.js';import{navStore}from'/assets/app-nav.js';import{ChatPanel,boot}from'/ui/js/panel-chat.js';import{stockEffectTrust}from'/assets/effect-stock-trust.js';import{effectTrialStage}from'/assets/effect-trial-stage.js';import{effectTrialShadow}from'/assets/effect-trial-shadow.js';import{createEffectFrame}from'/assets/effect-frame.js';import{setLang}from'/assets/app-i18n.js';
 const q=new URL(location.href).searchParams;setLang(q.get('lang')||'en',{store:false});document.documentElement.dataset.theme=q.get('dark')==='1'?'dark':'light';
 const binding=Object.freeze({key:'trial:a',id:'a'.repeat(32),run:'c'.repeat(32),instance:'worker',generation:1});
 window.R={ready:0,removed:[],stops:[]};let api=null,F=null,B=null,css='off',live=true;
 window.trialProps={binding,title:'<img src=x> sample',current:()=>live,ownerCss:()=>css,onStage:x=>api=x,onStop:x=>{R.stops.push(x);F?.remove('stage_stopped')},onClose:x=>{R.stops.push('closed');F?.remove('stage_closed')}};
 appStore.set({ready:true,connection:'open',instances:[{name:'worker',backend:'codex',state:'idle'}],exec:{worker:'idle'},awaiting:{worker:null},connections:1});navStore.set({route:{panel:'chat',instance:'worker'},seq:1});boot({stream:{on(){return()=>{}}},boot:null,deps:{announce(){},toast(){}}});
 render(html\`<\${Shell} panels=\${new Map([['chat',{Component:ChatPanel}]])} onNewInstance=\${()=>{}} />\`,document.querySelector('#app'));
 const stock=()=>stockEffectTrust(window,{ownerCss:css});
 const projection=()=>api&&effectTrialStage(api.receipt,binding,stock());
 window.T={root:()=>effectTrialShadow(window,document.querySelector('.effect-trial-panel'))?.root,stock,projection,start:()=>{const p=projection();if(!p)return false;
 F=createEffectFrame({window,root:p.root,origin:'http://127.0.0.1:${preview.settings.port}',boot:'${boot}',render:{code:"const c=agend.canvas.getContext('2d');c.fillStyle='#ff0000';c.fillRect(0,0,4096,4096);agend.ready()",params:{},instance:'worker',width:p.rect.width,height:p.rect.height,dpr:1,assets:[],wants:[]},onReady:()=>R.ready++,onRemove:x=>R.removed.push(x)});
 if(!F.ok)return false;B=p.bind(F.element,{layer:'front'},stock());if(!B.ok)F.remove('stage_refused');return B.ok;},sync:()=>B?.sync(stock())===true,dispose:()=>{api?.dispose();F?.remove('disposed')},css:v=>css=v,stale:()=>live=false,dialog:()=>showDialog(Dialog,{title:'Other dialog',children:'Protected host dialog'}),closeDialog,
 unmount:()=>render(null,document.querySelector('#app')),rule:text=>{const s=effectTrialShadow(window,document.querySelector('.effect-trial-panel')).sheet;return s.insertRule(text,s.cssRules.length)},clearRule:i=>document.querySelector('link[href="/assets/app.css"]').sheet.deleteRule(i)};
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
   const load=async()=>{await page.goto(`http://127.0.0.1:${port}/?lang=${lang}&dark=${dark?1:0}`);await page.waitForFunction(()=>!!window.T?.root());await page.waitForTimeout(80);await page.evaluate(()=>{const e=document.activeElement;if(e instanceof HTMLElement)e.blur();});};
   try{
    await load();const state=await page.evaluate(()=>({stock:(window as any).T.stock(),p:(window as any).T.projection(),css:getComputedStyle(window.T.root().querySelector('.effect-trial-stage')),focus:document.hasFocus()}));
    assert.equal(state.stock.ok,true,JSON.stringify(state.stock));assert.equal(state.stock.front,false);assert.equal(state.stock.agentFront,false);assert.ok(state.p,JSON.stringify(state));
    const base=await page.screenshot({path:join(out,`${engine}-${width}-host.png`)});
    const controls=await page.evaluate(()=>['.effect-trial-head strong','.effect-trial-close','.effect-trial-stop','.effect-trial-note',...(innerWidth>=900?['.composer-box']:[])].map(q=>{const r=(q==='.composer-box'?document:window.T.root()).querySelector(q).getBoundingClientRect();return{q,x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2)}}));
    assert.equal(await page.evaluate(()=>(window as any).T.start()),true);await page.waitForFunction(()=>(window as any).R.ready===1);assert.equal(await page.evaluate(()=>getComputedStyle(window.T.root().querySelector('iframe')).visibility),'hidden');assert.equal(await page.evaluate(()=>(window as any).T.sync()),true);
    await page.waitForTimeout(60);const shot=await page.screenshot({path:join(out,`${engine}-${width}-sample.png`)});
    for(const p of controls)assert.deepEqual(pixel(shot,p.x,p.y),pixel(base,p.x,p.y),'protected '+p.q);
    const r=await page.evaluate(()=>{const r=window.T.root().querySelector('.effect-trial-stage').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}});
    const middle={x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2)};assert.notDeepEqual(pixel(shot,middle.x,middle.y),pixel(base,middle.x,middle.y),'real effect must paint');
    // Force an oversized local frame via private CSS after the proof. The stage itself must physically clip it.
    await page.evaluate(()=>(window as any).T.rule('.effect-trial-stage > iframe {width:4096px!important;height:4096px!important;left:-40px!important;top:-40px!important}'));
    const oversize=await page.screenshot();for(const p of controls)assert.deepEqual(pixel(oversize,p.x,p.y),pixel(base,p.x,p.y),'physical clip '+p.q);
    for(const [x,y]of [[Math.floor(r.x-2),middle.y],[middle.x,Math.floor(r.y-2)],[Math.ceil(r.x+r.width+2),middle.y],[middle.x,Math.ceil(r.y+r.height+2)]])if(x>=0&&y>=0&&x<width&&y<900)assert.deepEqual(pixel(oversize,x,y),pixel(base,x,y),'clip edge '+[x,y]);
    assert.equal(await page.evaluate(()=>(window as any).T.sync()),false);assert.equal(await page.evaluate(()=>window.T.root()?.querySelectorAll('iframe').length??0),0);
    const faults=['clip','contain','transform','initial-visible','stale','dialog','menu','blur'];
    for(const fault of faults){await load();
     if(fault==='initial-visible'){await page.evaluate(()=>(window as any).T.rule('iframe.agend-effect-frame{visibility:visible!important}'));assert.equal(await page.evaluate(()=>(window as any).T.start()),false);}
     else{assert.equal(await page.evaluate(()=>(window as any).T.start()),true);await page.waitForFunction(()=>(window as any).R.ready===1);
      await page.evaluate(f=>{const t=(window as any).T;if(f==='clip')t.rule('.effect-trial-stage{overflow:visible!important}');if(f==='contain')t.rule('.effect-trial-stage{contain:none!important}');if(f==='transform')document.querySelector('link[href="/assets/app.css"]').sheet.insertRule('.chat-split{transform:translateX(1px)!important}',0);if(f.startsWith('owner-'))t.css(f.slice(6));if(f==='stale')t.stale();if(f==='dialog')t.dialog();if(f==='menu')document.querySelector('.panel-head .menu>button').click();if(f==='blur')window.dispatchEvent(new Event('blur'));},fault);
      if(fault==='dialog')await page.locator('dialog[open]').waitFor();if(fault==='menu')await page.locator('.menu-list').waitFor();assert.equal(await page.evaluate(()=>(window as any).T.sync()),false,fault);
     }assert.equal(await page.evaluate(()=>window.T.root()?.querySelectorAll('iframe').length??0),0,fault);assert.equal(await page.evaluate(()=>(window as any).T.projection()),null,fault);
    }
    await load();assert.equal(await page.evaluate(()=>(window as any).T.start()),true);await page.waitForFunction(()=>(window as any).R.ready===1);await page.evaluate(()=>window.T.root().querySelector('.effect-trial-stop').click());assert.equal(await page.evaluate(()=>window.T.root()?.querySelectorAll('iframe').length??0),0);assert.deepEqual(await page.evaluate(()=>(window as any).R.stops),['stopped']);await page.evaluate(()=>window.T.root().querySelector('.effect-trial-close').click());assert.deepEqual(await page.evaluate(()=>(window as any).R.stops),['stopped','closed']);
    await load();assert.equal(await page.evaluate(()=>(window as any).T.start()),true);await page.evaluate(()=>window.T.root().querySelector('.effect-trial-close').click());assert.equal(await page.evaluate(()=>window.T.root()?.querySelectorAll('iframe').length??0),0);assert.deepEqual(await page.evaluate(()=>(window as any).R.stops),['closed']);
    await load();assert.equal(await page.evaluate(()=>(window as any).T.start()),true);await page.waitForFunction(()=>(window as any).R.ready===1);await page.evaluate(()=>(window as any).T.unmount());assert.equal(await page.evaluate(()=>window.T.root()?.querySelectorAll('iframe').length??0),0);assert.deepEqual(await page.evaluate(()=>(window as any).R.stops),['stopped']);
    assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);rows.push({engine,width,lang,dark,stockSuppressed:true,actualShell:true,actualPanel:true,onePrivateSlotOverlay:true,realFactoryAndBuiltPreview:true,protectedControls:controls,rect:r,physicalOversizeClip:true,faults,stop:true,closeAfterStop:true,close:true,unmount:true,errors,outside});
   }finally{await context.close();}
  }await browser.close();browser=null;
 }
}finally{await browser?.close();if(preview)await new Promise<void>(r=>preview.server.close(()=>r()));await new Promise<void>(r=>server.close(()=>r()));rmSync(scratch,{recursive:true,force:true});writeFileSync(join(out,'receipt.json'),JSON.stringify({rows,scratchRemoved:true,noFleet:true,noProductMount:true},null,2));}
console.log(JSON.stringify(rows));
