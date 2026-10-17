/** Actual production app.html/app.js, Chat, preview slot, cookie auth, Trial API, stores and safety.
 * No component overlays, auth/loader/registry/safety doubles, fleet process or external network.
 * Browser sessions are minted by the real session store in a private fixture (not a human login proof).
 * Build first; PW_DIR/OUT_DIR as the other native recipes. Linux WebKit is not real Safari. */
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
// @ts-ignore Build first; all server modules below are built product modules.
import {createPreviewListener, previewAvailability} from "../../dist/web-preview.js";
// @ts-ignore
import {handleAuthRequest} from "../../dist/auth-api.js";
// @ts-ignore
import {handleWebRequest} from "../../dist/web-api.js";
// @ts-ignore
import {WebSessionStore, tokenEpoch} from "../../dist/web-session.js";
// @ts-ignore
import {WebPrefsStore, OPERATOR} from "../../dist/web-prefs.js";
// @ts-ignore
import {OwnerCssStore} from "../../dist/web-owner-css-store.js";
// @ts-ignore
import {WebEffectLibrary} from "../../dist/web-effect-library.js";
// @ts-ignore
import {ThemeStore} from "../../dist/web-theme-store.js";
// @ts-ignore
import {WebEffectProfiles} from "../../dist/web-effect-profiles.js";
// @ts-ignore
import {WebEffectTrials} from "../../dist/web-effect-trials.js";
// @ts-ignore
import {WebEffectService} from "../../dist/web-effect-service.js";
// @ts-ignore
import {WebChatHistory} from "../../dist/web-chat-history.js";
const pw=createRequire(join(resolve(process.env.PW_DIR!),"package.json"))("playwright");
const out=resolve(process.env.OUT_DIR||".artifacts/trial-product-native");mkdirSync(out,{recursive:true});
const scratch=mkdtempSync(join(out,"private-"));mkdirSync(join(scratch,"home"));mkdirSync(join(scratch,"tmp"));
const rows:any[]=[],serverErrors:string[]=[],requests:any[]=[];let browser:any,preview:any,ctx:any;
const logger={info(){},debug(){},error(o:any){serverErrors.push(JSON.stringify(o));}};
const token="private-trial-product-fixture",sessions=new WebSessionStore({dataDir:scratch});
const prefs=new WebPrefsStore(scratch),ownerCss=new OwnerCssStore(scratch,prefs),library=new WebEffectLibrary(scratch),themes=new ThemeStore(scratch),profiles=new WebEffectProfiles(scratch);
const trials=new WebEffectTrials({library,known:n=>n==="worker"}),history=new WebChatHistory();
library.registerReferenceSource("themes",()=>themes.placedEffects().flatMap(x=>x.ids.map(id=>({id,holder:`instance:${x.name}`}))));
const service=new WebEffectService({library,themes,profiles,trials,prefs,known:n=>n==="worker",changed(){}});
const manifest={v:1,runtime:"canvas-worker-v1",worker:"worker.js",name:"trial-native",title:"Native Trial",regions:["page"],layer:"front",wants:["state","reply","theme","pointer"]};
const source="const c=agend.canvas.getContext('2d');c.fillStyle='#ff0000';c.fillRect(0,0,4096,4096);agend.ready()";
const staged=library.stage(new Map([["effect.json",Buffer.from(JSON.stringify(manifest))],["worker.js",Buffer.from(source)]]),{kind:"agent",id:"worker"});assert.equal(staged.ok,true);const committed=library.commit(staged.stageId);assert.equal(committed.ok,true);const id=committed.ids[0];
const offered=trials.offer("worker",id);assert.equal(offered.ok,true);assert.ok(history.recordEffectTrial("worker",offered.offer,new Date().toISOString()));
const status=()=>({instances:[{name:"worker",backend:"codex",status:"running",state:"idle",working_directory:scratch}],connections:1,uptime:1,prefs_rev:prefs.rev(),themes_rev:themes.rev()});
const server=createServer((req,res)=>{
 const url=new URL(req.url||"/","http://localhost");requests.push({method:req.method,path:url.pathname,query:url.search});
 try{
  if(handleAuthRequest(req,res,url,{webToken:token,webSessions:sessions,webLoginCodes:null,logger}))return;
  if(handleWebRequest(req,res,url,ctx))return;
  // Inert metadata only; no effect, session, preference, preview or asset route is substituted.
  if(url.pathname==="/api/profile"){res.setHeader("Content-Type","application/json");res.end(JSON.stringify({}));return;}
  res.statusCode=404;res.end("not found");
 }catch(e){console.error(e);serverErrors.push(String(e));res.statusCode=500;res.setHeader("Content-Type","text/plain; charset=utf-8");res.end("Internal fixture error");}
});
const listen=async(s:any)=>{s.listen(0,"127.0.0.1");await once(s,"listening");return s.address().port;};
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

try{
 const port=await listen(server);preview=createPreviewListener({settings:{enabled:true,port:0,origin:null},healthPort:port,config:{}});await listen(preview.server);
 ctx={webToken:token,webSessions:sessions,dataDir:scratch,sseClients:new Set(),fleetConfig:{instances:{worker:{backend:"codex",working_directory:scratch}},web:{usage_panel:false}},logger,
  webPrefs:prefs,ownerCss,effectService:service,themeStore:themes,webChatHistory:history,instanceIpcClients:new Map(),daemons:new Map(),adapter:null,eventLog:null,
  getUiStatus:status,getInstanceStatus:()=>"running",getInstanceDir:()=>scratch,
  previewForUi:(host,secure)=>({...previewAvailability(preview.settings,host,secure,preview.origins),boot:preview.bootId}),
  emitSseEvent:(event,data)=>{for(const s of ctx.sseClients)s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);}};
 const base=`http://127.0.0.1:${port}`;
 const originalStatus=ctx.getUiStatus;ctx.getUiStatus=()=>{throw Error("private-fixture-error-sentinel");};
 try{const fault=await fetch(base+"/ui/poll",{headers:{"X-Agend-Token":token}});assert.equal(fault.status,500);assert.equal(fault.headers.get("content-type"),"text/plain; charset=utf-8");assert.equal(await fault.text(),"Internal fixture error");assert.equal(serverErrors.pop(),"Error: private-fixture-error-sentinel");}finally{ctx.getUiStatus=originalStatus;}

 for(const engine of(process.env.PROBE_ENGINES||"chromium,firefox,webkit").split(",")){
  browser=await pw[engine].launch({headless:true,env:{HOME:join(scratch,"home"),TMPDIR:join(scratch,"tmp"),PATH:"/usr/bin:/bin",LANG:"C.UTF-8"}});
  for(const width of(process.env.PROBE_WIDTHS||"1366,390").split(",").map(Number)){
   const lang=width<900?"zh-TW":"en",dark=width<900;
   assert.equal(prefs.writeForViewer(OPERATOR,new Map([["preview.optIn",false],["fx.show",true],["lang",lang],["theme",dark?"dark":"light"]])).ok,true);
   const made=sessions.create({tier:"admin",surface:"local",label:"native private fixture",tokenEpoch:tokenEpoch(token)});
   const context=await browser.newContext({viewport:{width,height:900},reducedMotion:"no-preference"});
   await context.addCookies([{name:"agend_session",value:made.sessionId,url:base}]);
   await context.addInitScript(()=>{if(window===window.top)try{sessionStorage.setItem("agend_html_preview_never","1");}catch{}});
   const page=await context.newPage(),errors:string[]=[],outside:string[]=[],http:any[]=[];
   page.on("pageerror",e=>errors.push(e.message));page.on("response",r=>{if(r.status()>=400)http.push({url:r.url(),status:r.status()});});
   await page.route("**/*",r=>{const u=new URL(r.request().url());if(["blob:","data:"].includes(u.protocol)||u.hostname==="127.0.0.1"&&[String(port),String(preview.settings.port)].includes(u.port))return r.continue();outside.push(u.origin);return r.abort();});
   const load=async()=>{await page.goto(base+"/ui/chat/worker");await page.locator(".effect-trial-start").waitFor({timeout:20000}); await page.waitForFunction(() => ["Try","試播"].includes(document.querySelector(".effect-trial-start")?.textContent));};
   const until = async (read: () => Promise<boolean>) => { const end=Date.now()+30000; while(Date.now()<end){if(await read())return;await page.waitForTimeout(20);}throw Error("native condition timed out"); };
   const capture = async () => until(() => page.evaluate(async () => { const m = await import("/assets/effect-trial-shadow.js"); const s=m.effectTrialShadow(window, document.querySelector(".effect-trial-panel")); if(s)window.__trialShell=s; return !!s; }));
   const frames = async () => page.evaluate(() => window.__trialShell?.stage.querySelectorAll("iframe").length ?? 0);
   const control = async (selector: string) => { const point = await page.evaluate(q => { const r = window.__trialShell.root.querySelector(q).getBoundingClientRect(); return { x: r.x+r.width/2, y: r.y+r.height/2 }; }, selector); await page.mouse.click(point.x, point.y); };
   const waitFrame = async () => { await capture(); await page.waitForFunction(() => !!window.__trialShell?.stage.querySelector("iframe")); };
   const start=async()=>{await page.locator(".effect-trial-start").click();await waitFrame();await until(() => page.evaluate(async()=>{const m=await import("/ui/js/app-effects.js");return m.getAppEffects()?.api?.trialSnapshot?.().rows.some(r=>r.phase==="running")===true}));};
   try{
    await load();assert.equal(await page.locator("iframe").count(),0,"no code before explicit click");
    const before=await page.evaluate(()=>({boot:{...document.body.dataset},prefs:JSON.parse(document.documentElement.dataset.prefs),auth:!!window.AgendAuth}));
    assert.equal(before.boot.mode,"full");assert.equal(before.boot.ownerCssState,"off");assert.equal(before.prefs.ownerEpoch,made.record.handle);assert.equal(before.prefs.ownerScope,"operator");
    const requestStart=requests.length;
    let release!:()=>void; const hold=new Promise<void>(r=>release=r);
    await page.route("**/ui/effect-trials/*/resource?*",async route=>{await hold;await route.continue();});
    await page.locator(".effect-trial-start").click();await capture();
    const protectedPoints=await page.evaluate(()=>[".effect-trial-label",".effect-trial-stop",".effect-trial-note"].map(q=>{const r=window.__trialShell.root.querySelector(q).getBoundingClientRect();return{q,x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2)}}));
    const unpainted=await page.screenshot();release();await page.unroute("**/ui/effect-trials/*/resource?*");
    await waitFrame();await until(() => page.evaluate(async()=>{const m=await import("/ui/js/app-effects.js");return m.getAppEffects()?.api?.trialSnapshot?.().rows.some(r=>r.phase==="running")===true}));
    assert.equal(await frames(),1);assert.equal(await page.locator(".effect-trial-panel").count(),1);
    await page.waitForTimeout(100); // Ready precedes the browser compositor, especially in WebKit.
    const geometry=await page.evaluate(()=>{const e=window.__trialShell.stage,f=e.querySelector("iframe"),r=e.getBoundingClientRect(),a=f.getBoundingClientRect(),s=getComputedStyle(e);return {stage:{x:r.x,y:r.y,width:r.width,height:r.height},frame:{x:a.x,y:a.y,width:a.width,height:a.height},contain:s.contain,overflowX:s.overflowX,overflowY:s.overflowY,sandbox:f.getAttribute("sandbox"),tabindex:f.getAttribute("tabindex")};});
    assert.ok(geometry.contain.includes("paint"));assert.equal(geometry.overflowX,"clip");assert.equal(geometry.overflowY,"clip");assert.equal(geometry.sandbox,"allow-scripts");assert.equal(geometry.tabindex,"-1");assert.equal(geometry.frame.x,geometry.stage.x);assert.equal(geometry.frame.y,geometry.stage.y);assert.equal(geometry.frame.width,Math.floor(geometry.stage.width));assert.equal(geometry.frame.height,Math.floor(geometry.stage.height));
    const interior={x:Math.floor(geometry.stage.x+geometry.stage.width/2),y:Math.floor(geometry.stage.y+geometry.stage.height/2)};
    const safetyBefore=await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith("agend_effect_safety_v1:")).map(k=>JSON.parse(localStorage.getItem(k))));
    assert.equal(safetyBefore.filter(r=>r.kind==="probation").length,1,"real durable probation before painting");
    if(engine==="chromium"&&width===1366)await page.waitForTimeout(6000);
    const painted=await page.screenshot({path:join(out,`${engine}-${width}-product-trial.png`)});const rgb=pixel(painted,interior.x,interior.y);assert.ok(rgb[0]>rgb[1]+40&&rgb[0]>rgb[2]+40,"real red Canvas Worker paint: "+JSON.stringify(rgb));
    const controls=protectedPoints;for(const p of controls)assert.deepEqual(pixel(painted,p.x,p.y),pixel(unpainted,p.x,p.y),"protected host control: "+p.q);
    await control(".effect-trial-stop");assert.equal(await frames(),0,"Stop removes synchronously");
    const stopped=await page.screenshot();assert.notDeepEqual(pixel(stopped,interior.x,interior.y),rgb);
    await page.waitForFunction(()=>document.querySelector(".effect-trial-start"));
    const runRequests=requests.slice(requestStart);assert.equal(runRequests.filter(r=>r.path==="/ui/effect-trials/start").length,1);assert.equal(runRequests.filter(r=>r.path.endsWith("/resource")&&r.path.includes("effect-trials")).length,1);assert.equal(runRequests.filter(r=>r.path.endsWith("/stop")).length,1);assert.ok(runRequests.filter(r=>r.path.includes("effect-trials")).every(r=>r.query.includes(`ownerEpoch=${made.record.handle}`)));
    assert.equal(runRequests.filter(r=>r.method==="POST"&&r.path.startsWith("/ui/effects/profile/")).length,0);assert.equal(existsSync(join(scratch,"web-effect-profiles.json")),false);
    const safetyAfter=await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith("agend_effect_safety_v1:")).map(k=>JSON.parse(localStorage.getItem(k))));assert.equal(safetyAfter.filter(r=>r.kind==="probation").length,0,"Stop clears exact durable probation");
    for(const fault of ["close","menu","blur","navigation"]){
     await load();await start();
     if(fault==="close")await control(".effect-trial-close");
     if(fault==="menu"){if(width>=900)await page.locator(".panel-head .menu > button").click();else await page.locator(".panel-head .menu > button").evaluate(el=>el.click());}
     if(fault==="blur"){const other=await context.newPage();await other.goto("about:blank");await other.bringToFront();await page.evaluate(()=>window.dispatchEvent(new Event("blur")));await other.close();}
     if(fault==="navigation")await page.evaluate(async()=>{const m=await import("/assets/app-nav.js");m.navigate("/ui/fleet")});
     await page.waitForFunction(()=>!window.__trialShell?.stage.isConnected || !window.__trialShell.stage.querySelector("iframe"));
    }
    const cssSnapshot=ownerCss.snapshot(OPERATOR);
    const hostile = `.chat-split { color: rgb(250,0,250); font: 900 48px/4 monospace; direction: rtl; }
      .effect-trial-panel { display:none!important; visibility:hidden!important; opacity:0!important; color:rgb(250,0,250)!important; font:900 0px/0 monospace!important; }
      .effect-trial-panel::after, .effect-trial-controls button::after {content:"Continue"!important;font-size:48px!important;display:block!important;}
      .effect-trial-panel *, .effect-trial-controls button, .effect-trial-stage { display:none!important;font-size:0!important;color:rgb(250,0,250)!important; }
      :host { display:none!important;font-size:0!important; }
      .effect-trial-panel::part(stop), .effect-trial-panel::part(stage), .effect-trial-panel::part(close) { display:none!important;font-size:0!important; }`;
    const cssSaved=ownerCss.save(OPERATOR,hostile);assert.equal(cssSaved.ok,true,JSON.stringify(cssSaved));assert.equal(ownerCss.keep(OPERATOR,cssSaved.trial).ok,true);
    await load(); await until(() => page.evaluate(async()=>{const m=await import("/assets/owner-css.js");return m.ownerCssLifecycle.get().state==="on"}));
    await start();
    const isolated = await page.evaluate(() => {
      const s = window.__trialShell, styles = [s.panel,s.stop,s.close,s.stage,s.panel.parentElement].map(el => { const c=getComputedStyle(el); return {color:c.color,font:c.font,fontSize:c.fontSize,display:c.display,visibility:c.visibility}; });
      return {closed:s.panel.shadowRoot===null,lightControls:s.panel.querySelectorAll("button").length,host:styles[0],stop:styles[1],close:styles[2],stage:styles[3],stopText:s.stop.textContent,closeText:s.close.textContent,after:getComputedStyle(s.stop,"::after").content,hostAfter:getComputedStyle(s.panel,"::after").content,parts:s.root.querySelectorAll("[part],[exportparts],slot").length,htmlNever:window.AgendPreview.never(),htmlOptIn:window.AgendPreview.optedIn(),parent:styles[4]};
    });
    assert.equal(isolated.closed,true);assert.equal(isolated.lightControls,0);assert.equal(isolated.parts,0);assert.equal(isolated.stop.fontSize,"16px");assert.equal(isolated.close.fontSize,"16px");assert.equal(isolated.stop.visibility,"visible");assert.notEqual(isolated.stop.display,"none");assert.notEqual(isolated.stage.display,"none");assert.notEqual(isolated.stop.color,"rgb(250, 0, 250)");assert.notEqual(isolated.stop.font,isolated.parent.font);assert.ok(["none","normal"].includes(isolated.after));assert.ok(["none","normal"].includes(isolated.hostAfter));assert.equal(isolated.stopText,lang==="en"?"Stop trial":"停止試播");assert.equal(isolated.closeText,lang==="en"?"Close":"關閉");assert.equal(isolated.htmlNever,true);assert.equal(isolated.htmlOptIn,false);assert.equal(prefs.readForViewer(OPERATOR).values["preview.optIn"],false);
    await control(".effect-trial-stop");assert.equal(await frames(),0);assert.equal(ownerCss.active(OPERATOR)!==null,true,"owner CSS remains selected");assert.equal(ownerCss.restoreSnapshot(OPERATOR,cssSnapshot).ok,true);
    const readSession=sessions.create({tier:"read",surface:"local",label:"native read fixture",tokenEpoch:tokenEpoch(token)});await context.clearCookies();await context.addCookies([{name:"agend_session",value:readSession.sessionId,url:base}]);
    await page.goto(base+"/ui/chat/worker");await page.locator(".effect-trial-offer").waitFor();await page.evaluate(()=>window.AgendAuth.trialSession());assert.equal(await page.locator("iframe").count(),0,"read-tier session has no frame"); assert.equal(await page.locator(".effect-trial-start").textContent(),lang==="en"?"Sign in here":"在此登入");
    assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);assert.deepEqual(serverErrors,[]);
    rows.push({engine,width,lang,dark,actualShell:true,realSessionStore:true,actualAuthRoutes:true,hostOperator:true,explicitClick:true,geometry,protectedSamples:controls,stop:true,stopOn:["close","menu","window-blur-event","navigation"],noDiagnosticWrite:true,activeCssIsolated:isolated,htmlPreviewConsentUnchanged:true,readTierDenied:true,menuOnPhone:"host-handler programmatic click because sheet covers header",errors,outside,http});console.log(JSON.stringify({engine,width,done:true}));
   }catch(e){const diagnostic=await page.evaluate(async()=>{const m=await import("/ui/js/app-effects.js");const sh=await import("/assets/effect-trial-shadow.js");const panel=document.querySelector(".effect-trial-panel");return{trial:m.getAppEffects()?.api?.trialSnapshot?.(),gates:m.getAppEffects()?.gates(),shell:!!sh.effectTrialShadow(window,panel),panel:panel?.outerHTML,captured:!!window.__trialShell};}).catch(e=>String(e)); console.error(JSON.stringify({diagnostic}));await page.screenshot({path:join(out,`${engine}-${width}-failed.png`)}).catch(()=>{});writeFileSync(join(out,`${engine}-${width}-failure.json`),JSON.stringify({error:String(e),errors,outside,http,serverErrors,requests:requests.slice(-50),html:await page.content().catch(()=>"")},null,2));throw e;}
   finally{await context.close();}
  }await browser.close();browser=null;
 }
}finally{
 await browser?.close();trials.dispose();for(const s of ctx?.sseClients??[])s.end();server.closeAllConnections();if(preview){preview.server.closeAllConnections();await new Promise<void>(r=>preview.server.close(()=>r()));}await new Promise<void>(r=>server.close(()=>r()));rmSync(scratch,{recursive:true,force:true});writeFileSync(join(out,"receipt.json"),JSON.stringify({rows,serverErrors,scratchRemoved:true,noFleet:true,productionShell:true,productionAuth:true,privateMintedSessions:true,productionSafety:true},null,2));
}
console.log(JSON.stringify(rows));
