/** From-defaults #2115 diagnostics: actual app, cookie auth, routes, stores, preview and Worker. No seeded preferences or consents; only visible UI changes them.
 * No component overlays, auth/loader/registry/safety doubles, fleet process or external network.
 * Local sign-in uses the visible form and a fixture-issued one-time code (no seeded cookie or external DM). The separately named gateway case uses a synthetic session; neither proves a real human login/tunnel.
 * Build first; PW_DIR/OUT_DIR as the other native recipes. Linux WebKit is not real Safari. */
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { execFileSync } from "node:child_process";
// @ts-ignore
import { bindGatewayRequest } from "../../dist/web-request-context.js";
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
import {WebLoginCodes} from "../../dist/web-login.js";
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
const rows:any[]=[],serverErrors:string[]=[],requests:any[]=[];let browser:any,preview:any,ctx:any,publicServer:any;
const logger={info(){},debug(){},error(o:any){serverErrors.push(JSON.stringify(o));}};
const token="private-trial-product-fixture",sessions=new WebSessionStore({dataDir:scratch}),codes=new WebLoginCodes();
let prefs=new WebPrefsStore(scratch),ownerCss=new OwnerCssStore(scratch,prefs);
const library=new WebEffectLibrary(scratch),themes=new ThemeStore(scratch),profiles=new WebEffectProfiles(scratch);
const trials=new WebEffectTrials({library,known:n=>n==="worker"}),history=new WebChatHistory();
library.registerReferenceSource("themes",()=>themes.placedEffects().flatMap(x=>x.ids.map(id=>({id,holder:`instance:${x.name}`}))));
let service=new WebEffectService({library,themes,profiles,trials,prefs,known:n=>n==="worker",changed(){}});
const manifest={v:1,runtime:"canvas-worker-v1",worker:"worker.js",name:"trial-native",title:"Native Trial",regions:["chat"],layer:"front",wants:["state","reply","theme","pointer"]};
const source=process.env.PROBE_MUTATION==="no-paint"?"agend.ready()":"const c=agend.canvas.getContext('2d');c.fillStyle='#ff0000';c.fillRect(0,0,4096,4096);agend.ready()";
const staged=library.stage(new Map([["effect.json",Buffer.from(JSON.stringify(manifest))],["worker.js",Buffer.from(source)]]),{kind:"agent",id:"worker"});assert.equal(staged.ok,true);const committed=library.commit(staged.stageId);assert.equal(committed.ok,true);const id=committed.ids[0];
assert.equal(themes.setPlacements("worker",{effects:[id]},"agent",()=>null).ok,true);
const offered=trials.offer("worker",id);assert.equal(offered.ok,true);assert.ok(history.recordEffectTrial("worker",offered.offer,new Date().toISOString()));
const status=()=>({instances:[{name:"worker",backend:"codex",status:"running",state:"idle",working_directory:scratch}],connections:1,uptime:1,prefs_rev:prefs.rev(),themes_rev:themes.rev()});
const handler=(req,res)=>{
 const url=new URL(req.url||"/","http://localhost");requests.push({method:req.method,path:url.pathname,query:url.search});
 try{
  if(handleAuthRequest(req,res,url,{webToken:token,webSessions:sessions,webLoginCodes:codes,logger}))return;
  if(handleWebRequest(req,res,url,ctx))return;
  // Inert metadata only; no effect, session, preference, preview or asset route is substituted.
  if(url.pathname==="/api/profile"){res.setHeader("Content-Type","application/json");res.end(JSON.stringify({}));return;}
  res.statusCode=404;res.end("not found");
 }catch(e){console.error(e);serverErrors.push(String(e));res.statusCode=500;res.setHeader("Content-Type","text/plain; charset=utf-8");res.end("Internal fixture error");}
};
const server=createServer(handler);
const listen=async(s:any,port=0)=>{s.listen(port,"0.0.0.0");await once(s,"listening");return s.address().port;};

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

try {
 const port=await listen(server,19280);preview=createPreviewListener({settings:{enabled:true,port:19281,origin:null},healthPort:port,config:{}});await listen(preview.server,19281);
 ctx={webToken:token,webSessions:sessions,dataDir:scratch,sseClients:new Set(),fleetConfig:{instances:{worker:{backend:"codex",working_directory:scratch}},web:{usage_panel:false}},logger,
  webPrefs:prefs,ownerCss,effectService:service,themeStore:themes,webChatHistory:history,instanceIpcClients:new Map(),daemons:new Map(),adapter:null,eventLog:null,
  getUiStatus:status,getInstanceStatus:()=>"running",getInstanceDir:()=>scratch,
  previewForUi:(host,secure)=>({...previewAvailability(preview.settings,host,secure,preview.origins),boot:preview.bootId}),
  emitSseEvent:(event,data)=>{for(const s of ctx.sseClients)s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);}};
 const base=`http://localhost:${port}`;
 const publicOrigin="https://127.0.0.2:19282",exposureId="d".repeat(32);
 execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",join(scratch,"tls.key"),"-out",join(scratch,"tls.crt"),"-days","1","-subj","/CN=private-fixture","-addext","subjectAltName=IP:127.0.0.2"],{stdio:"ignore"});
 publicServer=createSecureServer({key:readFileSync(join(scratch,"tls.key")),cert:readFileSync(join(scratch,"tls.crt"))},(req,res)=>{
  bindGatewayRequest(req,{surface:"gateway",exposureId,expectedOrigin:publicOrigin,isCurrent:()=>true});handler(req,res);
 });await listen(publicServer,19282);

 for(const engine of(process.env.PROBE_ENGINES||"chromium,firefox,webkit").split(",")) {
  browser=await pw[engine].launch({headless:true,env:{HOME:join(scratch,"home"),TMPDIR:join(scratch,"tmp"),PATH:"/usr/bin:/bin",LANG:"C.UTF-8",FONTCONFIG_FILE:"/etc/fonts/fonts.conf"}});
  for(const width of(process.env.PROBE_WIDTHS||"1366,390").split(",").map(Number))for(const motion of ["no-preference","reduce"]) {
   // New private fixture defaults as well as a fresh browser. No pref/consent is seeded.
   rmSync(join(scratch,"web-prefs.json"),{force:true});
   prefs=new WebPrefsStore(scratch);ownerCss=new OwnerCssStore(scratch,prefs);service=new WebEffectService({library,themes,profiles,trials,prefs,known:n=>n==="worker",changed(){}});
   Object.assign(ctx,{webPrefs:prefs,ownerCss,effectService:service});assert.deepEqual(prefs.readForViewer(OPERATOR).values,{});
   const issued=codes.issue({tier:"admin",epoch:tokenEpoch(token)});
   const context=await browser.newContext({viewport:{width,height:900},reducedMotion:motion,locale:"en-US"});
   const page=await context.newPage(),errors=[],outside=[],startRequest=requests.length,tag=`${engine}-${width}-${motion}`;
   page.on("pageerror",e=>errors.push(e.message));
   await page.route("**/*",r=>{const u=new URL(r.request().url());if(["blob:","data:"].includes(u.protocol)||["localhost","127.0.0.1"].includes(u.hostname)&&["19280","19281"].includes(u.port))return r.continue();outside.push(u.origin);return r.abort();});
   const view=()=>page.evaluate(async()=>{const m=await import("/ui/js/app-effects.js");return m.getAppEffects()?.api.snapshot();});
   const until=async read=>{const end=Date.now()+30000;while(Date.now()<end){if(await read())return;await page.waitForTimeout(25);}throw Error("native condition did not become true");};
   const waitReason=async reason=>until(()=>page.evaluate(async reason=>{const m=await import("/ui/js/app-effects.js");return m.getAppEffects()?.api.snapshot().rows.some(r=>r.reason===reason)===true},reason));
   try {
    await page.goto(base+"/signin?next="+encodeURIComponent("/ui/chat/worker"));
    await page.getByLabel("One-time code",{exact:true}).waitFor();
    await page.screenshot({path:join(out,tag+"-fresh-signin.png")});
    await page.getByLabel("One-time code",{exact:true}).fill(issued.display);
    await page.getByRole("button",{name:"Sign in",exact:true}).click();await page.waitForURL("**/ui/chat/worker");
    const initialReason=motion==="reduce"?"reduced_motion":"preview_not_consented";
    await waitReason(initialReason);await page.locator(".chat-fx-notice").waitFor();
    assert.equal(await page.locator("iframe.agend-effect-frame").count(),0);
    const message=await page.locator(".chat-fx-notice").innerText();assert.match(message,motion==="reduce"?/reduced motion/:/allow HTML previews/);
    assert.equal(await page.evaluate(()=>matchMedia("(prefers-reduced-motion: reduce)").matches),motion==="reduce");
    const beforePixels=redPixels(await page.screenshot({path:join(out,tag+"-defaults-blocked.png")}));
    const noCode=requests.slice(startRequest).filter(r=>r.path.startsWith("/ui/effects/resource/"));assert.equal(noCode.length,0);
    if(motion==="reduce") {
     // Real browser media emulation reproduces the gate; not evidence about the reporter's Windows value.
     await page.waitForTimeout(11000);assert.deepEqual(service.playbackSummary("worker",id),{status:"reported_blocked",reasons:["reduced_motion"]});
     rows.push({engine,width,motion,defaults:true,status:"pass",reason:initialReason,message,visibleSignIn:true,seededCookies:false,seededPrefs:false,seededConsent:false,noCodeRead:true,aggregateOnly:service.playbackSummary("worker",id)});
    } else {
     await page.getByRole("button",{name:"Open device preferences",exact:true}).click();await page.waitForURL("**/settings/device");
     await page.getByLabel("Allow HTML previews",{exact:true}).check();
     const saved=page.waitForResponse(r=>r.request().method()==="POST"&&new URL(r.url()).pathname==="/ui/prefs");
     await page.getByRole("button",{name:"Allow previews",exact:true}).click();assert.equal((await saved).status(),200);
     await page.waitForFunction(()=>window.AgendPreview?.optedIn()===true);
     if(width<900)await page.getByRole("button",{name:"Open the sidebar",exact:true}).click();
     await page.locator('.inst[href="/ui/chat/worker"]').click();await page.waitForURL("**/ui/chat/worker");await page.locator(".p-chat > .panel-head").waitFor();
     await page.waitForTimeout(500);await page.locator(".p-chat > .panel-head").click({position:{x:6,y:6}});
     await page.evaluate(async()=>{const m=await import("/ui/js/app-effects.js");window.__diagnosticTrace=[];m.getAppEffects()?.subscribe(()=>{const value=m.getAppEffects()?.api.snapshot();window.__diagnosticTrace.push({at:performance.now(),rows:value?.rows,gates:m.getAppEffects()?.gates(),focus:document.activeElement?.tagName});if(window.__diagnosticTrace.length>80)window.__diagnosticTrace.shift();});});
     await until(()=>page.evaluate(async()=>{const m=await import("/ui/js/app-effects.js");return m.getAppEffects()?.api.snapshot().rows.some(r=>r.phase==="running")===true}));
     let paintPixels=0,paintDelayMs=0;
     // Ready is a protocol event, not a compositor presentation receipt. Await actual pixels within a bounded 2s.
     for(const delay of [0,100,300,600,1000]) {await page.waitForTimeout(delay);paintDelayMs+=delay;paintPixels=redPixels(await page.screenshot({path:join(out,tag+"-ui-consented-playing.png")}));if(paintPixels>beforePixels+1000)break;}
     assert.ok(paintPixels>beforePixels+1000,"independent visible Worker paint");
     assert.ok((await view()).rows.some(r=>r.phase==="running"));
     // An actual click inside the clipped Try stage must not be mistaken for window blur.
     await page.getByRole("button",{name:"Try",exact:true}).click();
     await until(()=>page.evaluate(async()=>{const m=await import("/assets/effect-trial-shadow.js");const s=m.effectTrialShadow(window,document.querySelector(".effect-trial-panel"));if(s)window.__trialShell=s;return !!s?.stage.querySelector("iframe")}));
     await until(()=>page.evaluate(async()=>{const m=await import("/ui/js/app-effects.js");return m.getAppEffects()?.api.trialSnapshot().rows.some(r=>r.phase==="running")===true}));
     const rect=await page.evaluate(()=>{const r=window.__trialShell.stage.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}});
     await page.mouse.click(rect.x,rect.y);await page.waitForTimeout(200);
     assert.equal(await page.evaluate(()=>window.__trialShell.stage.querySelectorAll("iframe").length),1,"real stage click keeps the trial");
     let trialPixels=0,trialPaintDelayMs=0;
     for(const delay of [0,100,300,600,1000]) {await page.waitForTimeout(delay);trialPaintDelayMs+=delay;trialPixels=redPixels(await page.screenshot({path:join(out,tag+"-trial-click-alive.png")}));if(trialPixels>1000)break;}
     assert.ok(trialPixels>1000,"independent visible trial paint after actual click");
     await page.evaluate(()=>window.dispatchEvent(new Event("blur")));
     assert.equal(await page.evaluate(()=>window.__trialShell.stage.querySelectorAll("iframe").length),0,"dispatched window blur event still stops");
     rows.push({engine,width,motion,defaults:true,status:"pass",reason:initialReason,message,visibleSignIn:true,seededCookies:false,seededPrefs:false,seededConsent:false,visibleUiConsent:true,visibleReturnNavigation:true,actualWorkerRunning:true,independentPaint:{beforePixels,paintPixels,trialPixels,paintDelayMs,trialPaintDelayMs},actualStageClickSurvives:true,windowBlurStops:true});
    }
    assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);console.log("PASS",tag);
   } catch(e) {await page.screenshot({path:join(out,tag+"-failure.png")}).catch(()=>{});writeFileSync(join(out,tag+"-failure.json"),JSON.stringify({error:String(e),errors,outside,snapshot:await view().catch(()=>null),trace:await page.evaluate(()=>window.__diagnosticTrace).catch(()=>null),trial:await page.evaluate(async()=>{const m=await import("/ui/js/app-effects.js");const frame=window.__trialShell?.stage.querySelector("iframe"),c=frame?getComputedStyle(frame):null;return{rows:m.getAppEffects()?.api.trialSnapshot().rows,focus:document.hasFocus(),frame:frame?{visibility:c.visibility,display:c.display,opacity:c.opacity,clip:c.clipPath,rect:frame.getBoundingClientRect().toJSON()}:null}}).catch(()=>null),requests:requests.slice(startRequest)},null,2));throw e;}
   finally {await context.close();}
  }
  const gateway=sessions.create({tier:"read",surface:"gateway",exposureId,label:"private public-link fixture",tokenEpoch:tokenEpoch(token)});
  const pubContext=await browser.newContext({viewport:{width:390,height:900},reducedMotion:"no-preference",locale:"en-US",ignoreHTTPSErrors:true});
  await pubContext.addCookies([{name:"__Host-agend_session",value:gateway.sessionId,url:publicOrigin,secure:true}]);
  const pubPage=await pubContext.newPage(),pubStart=requests.length;
  await pubPage.goto(publicOrigin+"/ui/chat/worker");await pubPage.locator(".chat-fx-notice").waitFor();
  const publicMessage=await pubPage.locator(".chat-fx-notice").innerText();assert.match(publicMessage,/public link/);
  assert.equal(await pubPage.locator("iframe.agend-effect-frame").count(),0);assert.equal(await pubPage.locator(".effect-trial-start").count(),0);
  assert.equal(requests.slice(pubStart).filter(r=>r.path==="/ui/effects/placements"||r.path.startsWith("/ui/effects/resource/")).length,0);
  await pubPage.screenshot({path:join(out,engine+"-public-nonlocalhost-current-policy.png")});
  rows.push({engine,width:390,origin:"non-localhost private HTTPS gateway fixture",publicLink:true,status:"current-policy-blocked",reason:"public_link",message:publicMessage,noPrivateMetadata:true,noWorker:true,noRealTunnel:true,workingPlaybackRemedy:"deferred to approved #2118 public transport change"});
  await pubContext.close();
  await browser.close();browser=null;
 }
} finally {
 await browser?.close();trials.dispose();for(const s of ctx?.sseClients??[])s.end();server.closeAllConnections();if(publicServer){publicServer.closeAllConnections();await new Promise<void>(r=>publicServer.close(()=>r()));}if(preview){preview.server.closeAllConnections();await new Promise<void>(r=>preview.server.close(()=>r()));}await new Promise<void>(r=>server.close(()=>r()));rmSync(scratch,{recursive:true,force:true});writeFileSync(join(out,"receipt.json"),JSON.stringify({rows,serverErrors,scratchRemoved:true,noFleet:true,productionShell:true,productionAuth:true,localVisibleSignIn:true,localSeededCookies:false,publicSyntheticSession:true,reporterWindowsNotMeasured:true},null,2));
}
