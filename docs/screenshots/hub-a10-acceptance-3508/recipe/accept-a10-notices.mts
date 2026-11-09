/** AD editor in the real Settings/Hub shells. Owned scratch HTTPS + fake verified LDAPS, no API reply substitution. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { matrix, VIEWPORTS, caseName } from "../smoke-fixture/index.mts";
import { directoryCertificates, CA_DN } from "../../../tests/support/hub-directory-ca-fixture.js";
import { groupWirePeer, PERSON_ID } from "../../../tests/support/hub-group-directory-wire.js";
import { freeHubPort } from "../../../tests/helpers/hub-rig.js";
const REPO=process.env.REPO??process.cwd(),OUT=process.env.OUT??join(REPO,".artifacts/hub-directory-editor"),PW=process.env.PW_DIR!,CHROME=process.env.CHROME;
const RECOVERY=process.env.RECOVERY==="1",SKEW=process.env.SKEW??"",BEFORE=process.env.BEFORE==="1",CANDIDATE=process.env.CANDIDATE??REPO;
if(SKEW&&!["old-modules","old-shell","old-server"].includes(SKEW))throw Error("unknown skew");
mkdirSync(OUT,{recursive:true});const envHome=mkdtempSync(join(tmpdir(),"hub-editor-env-"));process.env.AGEND_HOME=envHome;
const {FleetManager}=await import(REPO+"/src/fleet-manager.ts"),{csrfTokenFor}=await import(REPO+"/src/web-session.ts"),{WEB_CSRF_HEADER}=await import(REPO+"/src/web-auth.ts");
const Database=createRequire(REPO+"/")("better-sqlite3"),pw=createRequire(PW+"/")("playwright-core");
const browser=await pw.chromium.launch({executablePath:CHROME,args:["--no-sandbox"]}),certs=directoryCertificates(),candidateCerts=RECOVERY?directoryCertificates():certs;
const result:any={cases:[],skew:SKEW,before:BEFORE,limits:"scratch only; fake people/LDAPS; initializer public D3 API is fixture preparation; no API reply stubs; no real AD/account/pilot/CLI/native service",cleaned:false};
const home=mkdtempSync(join(tmpdir(),"hub-editor-"));let fm:any,peerA:any,peerB:any,peerC:any;const contexts:any[]=[];
const api=(port:number,path:string,method="GET",headers:any={},body?:unknown)=>new Promise<any>((resolve,reject)=>{
 const q=request({host:"127.0.0.1",port,path,method,headers},res=>{let text="";res.on("data",b=>text+=b);res.on("end",()=>resolve({status:res.statusCode,headers:res.headers,text,body:()=>JSON.parse(text)}));});q.on("error",reject);q.end(body===undefined?undefined:JSON.stringify(body));
});
const wait=async(fn:()=>boolean)=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,25));}throw Error("fixture startup timed out");};
const check=(r:any,name:string,ok:boolean,detail?:unknown)=>{r[name]=ok?"PASS":{FAIL:detail??true};if(!ok)throw Error(name);};
const painted=async(page:any)=>page.evaluate(async()=>{await document.fonts.ready;await new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())));});
const buttonText=async(page:any)=>{await painted(page);return page.locator("dialog.hub-directory-editor .btn").evaluateAll((buttons:HTMLElement[])=>buttons.filter(e=>e.scrollWidth>e.clientWidth+1||e.scrollHeight>e.clientHeight+1).map(e=>({text:e.textContent,width:e.clientWidth,textWidth:e.scrollWidth,height:e.clientHeight,textHeight:e.scrollHeight})));};
const epoch=()=>{const db=new Database(join(home,"hub/hub.sqlite"),{readonly:true});try{return db.prepare("SELECT epoch FROM hub_directory_epoch").get().epoch;}finally{db.close();}};
try{
 const users=[{id:PERSON_ID,login:"avery",dn:"CN=Avery,DC=example,DC=test",password:"Dummy-person-only",eligible:true}];
 peerA=await groupWirePeer(certs.leaf,users);peerB=await groupWirePeer(candidateCerts.leaf,users,RECOVERY?{dn:CA_DN,pem:candidateCerts.ca,requireBind:true}:undefined);
 writeFileSync(join(home,"fleet.yaml"),"# Scratch editor fixture\ninstances: {}\nweb:\n  verified_authority:\n    enabled: true\n",{mode:0o600});
 fm=new FleetManager(home);const sink=()=>{},log=(...args:unknown[])=>{(result.diagnostics??=[]).push(args);};fm.logger={info:sink,warn:log,error:log,debug:sink,trace:sink,fatal:log,child:()=>fm.logger};fm.loadConfig(join(home,"fleet.yaml"));fm.initializeWebAuthTokens();fm.startHealthServer(0);await wait(()=>fm.getDashboardAccess().ready);
 const port=fm.healthServer.address().port,origin=`http://127.0.0.1:${port}`,issued=await api(port,"/auth/issue-code","POST",{"x-agend-token":fm.getDashboardAccess().token,origin});
 const signed=await api(port,"/auth/login","POST",{"content-type":"application/json",origin},{code:issued.body().code});if(signed.status!==200)throw Error("host fixture sign-in");
 const [cookieName,cookieValue]=signed.headers["set-cookie"][0].split(";")[0].split("="),headers={origin,"content-type":"application/json",cookie:`${cookieName}=${cookieValue}`,[WEB_CSRF_HEADER]:csrfTokenFor(cookieValue)};
 const webPort=await freeHubPort();let memberPort=await freeHubPort();while(memberPort===webPort)memberPort=await freeHubPort();
 const input={name:"Fictional Hub",webOrigin:`https://127.0.0.1:${webPort}`,memberOrigin:`https://127.0.0.1:${memberPort}`,webListen:{host:"127.0.0.1",port:webPort},memberListen:{host:"127.0.0.1",port:memberPort},
  directory:{realm:"fictional",profile:"ad",url:`ldaps://127.0.0.1:${peerA.port}`,baseDn:"DC=example,DC=test",bindDn:"CN=Reader,DC=example,DC=test",caPem:certs.ca},
  bindPassword:"Dummy-service-only",administratorLogin:"avery",confirmedCa:[new X509Certificate(certs.ca).fingerprint256],retention:{contentDays:30,eventDays:90},coexistence:"dedicated"};
 const p=await api(port,"/api/settings/hub/setup/prepare","POST",headers,input);if(p.status!==200)throw Error("fixture prepare");
 for(const action of ["test","commit"]){const r=await api(port,"/api/settings/hub/setup/"+action,"POST",headers,{ref:p.body().ref});if(r.status!==200)throw Error("fixture "+action);}
 fm.hubEffectsReady=true;await fm.applyHubSwitches();await wait(()=>fm.hubRuntime.serverHealth(fm.getRawFleetConfig().hub)==="ready");
 // Every presentation journey starts from A via the supported D3 settings writer,
 // then edits to B. This keeps the candidate form, trust dialog and saved endpoint
 // identical across both surfaces and all screenshots, without reply stubs or DB edits.
 const resetDirectory=async()=>{
  if(fm.getRawFleetConfig().hub.directory.url===input.directory.url)return;
  const view=await api(port,"/api/settings/hub/directory","GET",headers);if(view.status!==200)throw Error("fixture reset read "+view.text);
  const {realm:_realm,profile:_profile,...directory}=view.body().directory;directory.url=input.directory.url;
  const prepared=await api(port,"/api/settings/hub/directory/prepare","POST",headers,{directory,bindPassword:input.bindPassword});
  if(prepared.status!==200)throw Error("fixture reset prepare "+prepared.text);
  const draft=prepared.body(),saved=await api(port,"/api/settings/hub/directory/save","POST",headers,{ref:draft.ref,...(draft.trust?{confirmation:draft.trust.challenge}:{})});
  if(saved.status!==200||saved.body().state!=="ready")throw Error("fixture reset save "+saved.text);
  await wait(()=>fm.hubRuntime.serverHealth(fm.getRawFleetConfig().hub)==="ready");
  if(fm.getRawFleetConfig().hub.directory.url!==input.directory.url)throw Error("fixture reset endpoint");
 };
 const galleryServer=`ldaps://127.0.0.1:${peerB.port}`;result.gallery={server:galleryServer,sequence:"supported D3 reset to A before each journey; candidate form → trust → saved B on both surfaces"};
 const identity=readFileSync(join(home,"hub/keys/identity.json")),browserCert=readFileSync(join(home,"hub/web-tls/cert.pem"));
 const nodeHealth=await new Promise<number>((resolve,reject)=>{const q=httpsRequest({host:"127.0.0.1",port:webPort,path:"/ui/hub",ca:browserCert,agent:false},r=>{r.resume();r.on("end",()=>resolve(r.statusCode!));});q.on("error",reject);q.end();});if(nodeHealth!==200)throw Error("verified HTTPS");
 for(const c of RECOVERY?[]:matrix()){
  const tag=caseName(c),r:any={case:tag};result.cases.push(r);const zh=c.lang==="zh-TW";
  for(const surface of ["host","hub"]){
   if(!BEFORE&&!SKEW)await resetDirectory();
   const ctx=await browser.newContext({viewport:VIEWPORTS[c.device],colorScheme:c.theme,locale:zh?"zh-TW":"en-US",isMobile:c.device==="phone",hasTouch:c.device==="phone",ignoreHTTPSErrors:true});contexts.push(ctx);
   await ctx.addInitScript({content:`localStorage.setItem("agend_lang",${JSON.stringify(c.lang)});localStorage.setItem("agend_theme",${JSON.stringify(c.theme)});localStorage.setItem("agend_tour_done","1");localStorage.setItem("agend_firstrun_dismissed","1");localStorage.setItem("agend_usage_rail","0");`});
   if(surface==="host"){await ctx.addCookies([{name:cookieName,value:cookieValue,url:origin}]);fm.webPrefs.write("operator",new Map([["theme",c.theme],["lang",c.lang]]));}
   const page=await ctx.newPage(),errors:string[]=[],wire:any[]=[];page.on("pageerror",(e:any)=>errors.push(e.message));page.on("response",(res:any)=>{const u=new URL(res.url());if(u.pathname.includes("/directory"))wire.push({path:u.pathname,status:res.status()});});
   const modules=surface==="host"?["settings-hub-section.js"]:["panel-hub.js","hub-client.js","hub-this-hub.js"];
   if(SKEW==="old-modules"||SKEW==="old-server")for(const file of modules){
    const text=SKEW==="old-modules"?execFileSync("git",["show","31a973af77729b48e59d31fcf446e8ba48d836de:src/ui/"+file],{cwd:REPO,encoding:"utf8"}):readFileSync(join(CANDIDATE,"src/ui",file),"utf8");
    await page.route("**/ui/js/"+file,(route:any)=>route.fulfill({status:200,contentType:"text/javascript",body:text}));
   }
   if(SKEW==="old-shell"&&surface==="host")await page.route(origin+"/settings/hub",async(route:any)=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replace(' data-hub-directory-settings="1"',"")});});
   await page.goto(surface==="host"?origin+"/settings/hub":input.webOrigin+"/ui/hub/admin");
   if(surface==="hub"){
    await page.locator("#hubLogin").fill("avery");await page.locator("#hubPassword").fill("Dummy-person-only");await page.locator(".hub-signin-form button[type=submit]").click();
    await page.locator(".hub-this-hub").waitFor();
   }
   if(BEFORE||SKEW&&!(SKEW==="old-shell"&&surface==="hub")){
    await page.waitForTimeout(250);check(r,surface+":no-editor",await page.locator("#hub-directory-editor").count()===0);check(r,surface+":no-private-read",wire.length===0,wire);
    check(r,surface+":no-js-error",errors.length===0,errors);await page.screenshot({path:join(OUT,tag+"-"+surface+"-retained.png"),fullPage:true});await ctx.close();contexts.splice(contexts.indexOf(ctx),1);continue;
   }
   if(surface==="hub")await page.locator('a[href="/ui/hub/admin?view=directory"]').click();
   await page.locator("#hubDirectory-url").waitFor();await page.locator("#hubDirectory-bindPassword").waitFor();
   if(surface==="host"){
    for(const selector of [".hub-run-settings", ".hub-retention", ".hub-browser-certificate", ".hub-preview-settings"]){await page.locator(selector+" h3").waitFor();check(r,"host:title:"+selector,(await page.locator(selector+" h3").innerText()).trim().length>0);}
    await page.locator(".hub-retention input").first().waitFor();await painted(page);
    for(const [selector,label] of [[".s-company-join","company"],[".hub-run-settings","run"],[".hub-retention","retention"]]){
     const card=page.locator(selector);await card.evaluate((el:HTMLElement)=>el.scrollIntoView({block:"center",behavior:"instant"}));await painted(page);
     const detail=await card.evaluate((el:HTMLElement)=>{const b=el.getBoundingClientRect(),nav=document.querySelector(".tab-bar, .tabs")?.getBoundingClientRect();const title=el.querySelector("h3")!;return {title:title.textContent?.trim(),top:b.top,bottom:b.bottom,limit:nav&&nav.top>0?nav.top:innerHeight,controls:[...el.querySelectorAll("input,button")].map(e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};})};});
     check(r,"host:card-title:"+label,!!detail.title);
     if(label==="retention"){check(r,"host:retention-visible",detail.controls.every((b:any)=>b.top>=0&&b.bottom<=detail.limit&&b.left>=0&&b.right<=VIEWPORTS[c.device].width),detail);if(c.device==="phone")check(r,"host:retention-tap",detail.controls.every((b:any)=>b.width>=43&&b.height>=43),detail);}
     if(label==="company")check(r,"host:company-reason",await page.locator("#hubCompanyStartHint").count()===1);
     await page.screenshot({path:join(OUT,tag+"-host-"+label+".png")});
    }
   }
   await page.locator("#hubDirectory-url").evaluate((el:HTMLElement)=>el.scrollIntoView({block:"center",behavior:"instant"}));await painted(page);
   check(r,surface+":type-label",await page.locator(".hub-directory-type").innerText()===(zh?"Active Directory（AD）":"Active Directory (AD)"));
   const aligned=await page.evaluate(()=>{const a=document.querySelector("#hubDirectory-url")!.getBoundingClientRect(),b=document.querySelector("#hubDirectory-ca")!.getBoundingClientRect();return Math.abs(a.left-b.left)<=1&&Math.abs(a.width-b.width)<=1;});check(r,surface+":select-aligned",aligned);

   const geometry=async()=>page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+1,
    bad:[...document.querySelectorAll("#hub-directory-editor button, #hub-directory-editor input, #hub-directory-editor select, dialog.hub-directory-editor button")].filter(e=>{const b=e.getBoundingClientRect();return b.width&&b.height&&((e as HTMLElement).offsetParent!==null||e.closest("dialog[open]"))&&(b.height<43||b.width<43);}).map(e=>({tag:e.tagName,cls:e.className,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))}));
   const g=await geometry();check(r,surface+":overflow",!g.overflow);if(c.device==="phone")check(r,surface+":tap",g.bad.length===0,g.bad);
   check(r,surface+":real-shell",await page.locator("#sidebar").count()===1&&(surface!=="host"||await page.locator('.s-nav a[aria-current="page"]').getAttribute("href")==="/settings/hub"));
   // Frame the URL and the password field together above any fixed phone navigation.
   await page.locator("#hubDirectory-bindPassword").evaluate((e:HTMLElement)=>{const nav=document.querySelector(".tab-bar, .tabs")?.getBoundingClientRect(),limit=nav&&nav.top>0?nav.top:innerHeight;const delta=Math.max(0,e.getBoundingClientRect().bottom-limit+16);if(delta)for(let p=e.parentElement;p;p=p.parentElement){if(p.scrollHeight>p.clientHeight&&/(auto|scroll)/.test(getComputedStyle(p).overflowY)){p.scrollTop+=delta;break;}}});await painted(page);
   check(r,surface+":stored-password-visible",await page.locator("#hubDirectory-password-state").isVisible()&&(await page.locator("#hubDirectory-password-state").innerText())===(zh?"已設定（留空則不變更）":"Configured (leave blank to keep it)"));
   const statusBounds=await page.locator("#hubDirectory-password-state").evaluate((e:HTMLElement)=>{const b=e.getBoundingClientRect(),nav=document.querySelector(".tab-bar, .tabs")?.getBoundingClientRect();return {top:b.top,bottom:b.bottom,limit:nav&&nav.top>0?nav.top:innerHeight};});check(r,surface+":stored-password-in-viewport",statusBounds.top>=0&&statusBounds.bottom<=statusBounds.limit,statusBounds);
   const metadata=await page.locator(".hub-directory-value").evaluateAll((values:HTMLElement[])=>values.map(e=>{const s=getComputedStyle(e);return {font:s.fontFamily,size:s.fontSize,weight:s.fontWeight};}));check(r,surface+":metadata-style",metadata.length===2&&JSON.stringify(metadata[0])===JSON.stringify(metadata[1]),metadata);
   const before=epoch(),targetUrl=galleryServer;
   await page.locator("#hubDirectory-url").fill(targetUrl);await page.locator("#hubDirectory-bindPassword").fill("Dummy-service-only");
   await page.locator("#hubDirectory-url").evaluate((el:HTMLElement)=>el.scrollIntoView({block:"center",behavior:"instant"}));await painted(page);
   await page.screenshot({path:join(OUT,tag+"-"+surface+"-form.png"),fullPage:true});
   await page.locator("#hubDirectory-ca").evaluate((el:HTMLElement)=>el.scrollIntoView({block:"center",behavior:"instant"}));await painted(page);await page.screenshot({path:join(OUT,tag+"-"+surface+"-trust-source.png")});
   await page.locator("#hub-directory-editor button[type=submit]").scrollIntoViewIfNeeded();await painted(page);await page.screenshot({path:join(OUT,tag+"-"+surface+"-actions.png"),fullPage:true});
   const oldCookie=surface==="hub"?(await ctx.cookies()).find((x:any)=>x.name.startsWith("__Host-agend_hub_"))?.value:null;
   await page.locator("#hub-directory-editor button[type=submit]").click();await page.locator("dialog.hub-directory-editor[open]").waitFor();
   check(r,surface+":no-early-effect",epoch()===before);check(r,surface+":one-dialog",await page.locator("dialog[open]").count()===1);await page.locator("dialog .hub-directory-fingerprint").first().waitFor();
   const dialogServer=await page.locator("dialog .field code").first().innerText();check(r,surface+":trust-server-matches-candidate",dialogServer===targetUrl&&await page.locator("#hubDirectory-url").inputValue()===targetUrl,{dialogServer,targetUrl});
   const groupShape=await page.locator("dialog .hub-directory-fingerprint").evaluateAll((values:HTMLElement[])=>values.length>0&&values.every(e=>{const groups=[...e.querySelectorAll("span")];return groups.length===8&&[...new Set(groups.map(g=>Math.round(g.getBoundingClientRect().top)))].length===2&&groups.slice(0,4).every(g=>Math.abs(g.getBoundingClientRect().top-groups[0].getBoundingClientRect().top)<1)&&groups.slice(4).every(g=>Math.abs(g.getBoundingClientRect().top-groups[4].getBoundingClientRect().top)<1)&&groups.every(g=>/^[A-F0-9]{8}$/.test(g.textContent??"")&&g.scrollWidth<=g.clientWidth+1);}));check(r,surface+":fingerprint-groups",groupShape);const clipped=await buttonText(page);check(r,surface+":trust-text-fits",clipped.length===0,clipped);const bounds=await page.locator("dialog .dlg-actions").evaluate((e:HTMLElement)=>({top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom,height:innerHeight}));check(r,surface+":trust-actions-visible",bounds.top>=0&&bounds.bottom<=bounds.height+1,bounds);await page.screenshot({path:join(OUT,tag+"-"+surface+"-trust.png")});const t=await geometry();check(r,surface+":trust-overflow",!t.overflow);if(c.device==="phone")check(r,surface+":trust-tap",t.bad.length===0,t.bad);
   await page.getByRole("button",{name:zh?"確認指紋並儲存":"Confirm fingerprints and save",exact:true}).click();
   await page.getByRole("status").filter({hasText:zh?"已儲存 AD 連線。":"AD connection saved."}).waitFor({timeout:25000});
   check(r,surface+":saved",epoch()===before+1);check(r,surface+":saved-server-matches-dialog",fm.getRawFleetConfig().hub.directory.url===dialogServer);check(r,surface+":secret-cleared",await page.locator("#hubDirectory-bindPassword").inputValue()==="");
   check(r,surface+":no-failed-request",wire.every(x=>x.status<400),wire);check(r,surface+":no-js-error",errors.length===0,errors);check(r,surface+":healthy",fm.hubRuntime.serverHealth(fm.getRawFleetConfig().hub)==="ready");
   if(surface==="hub")check(r,"hub:rotated-session",(await ctx.cookies()).some((x:any)=>x.name===`__Host-agend_hub_${fm.getRawFleetConfig().hub.hubId}`&&x.value!==oldCookie));
   if(surface==="hub"){
    const db=new Database(join(home,"hub/hub.sqlite")); const id=db.prepare("SELECT id FROM hub_settings_security_notices ORDER BY rowid DESC LIMIT 1").get().id;
    const targets=()=>db.prepare("SELECT kind,state FROM hub_settings_security_targets WHERE notice_id=? ORDER BY kind").all(id);
    const hc=await browser.newContext({viewport:VIEWPORTS[c.device],locale:zh?"zh-TW":"en",colorScheme:c.theme,isMobile:c.device==="phone",hasTouch:c.device==="phone"});contexts.push(hc);await hc.addCookies([{name:cookieName,value:cookieValue,url:origin}]);
    await hc.addInitScript({content:`localStorage.setItem("agend_lang",${JSON.stringify(c.lang)});localStorage.setItem("agend_theme",${JSON.stringify(c.theme)});localStorage.setItem("agend_tour_done","1");localStorage.setItem("agend_firstrun_dismissed","1");`});const hp=await hc.newPage();await hp.goto(origin+"/ui/needs");
    await hp.locator(`[data-directory-notice="${id}"]`).waitFor();await hp.locator(`[data-directory-notice="${id}"]`).scrollIntoViewIfNeeded();await hp.screenshot({path:join(OUT,tag+"-host-notice.png")});
    await hp.locator(`[data-directory-notice="${id}"] button`).click();await hp.locator(`[data-directory-notice="${id}"] button`).waitFor({state:"detached"});
    check(r,"notice:host-ack-person-independent",targets().some(x=>x.kind==="host"&&x.state==="delivered")&&targets().some(x=>x.kind==="person"&&x.state==="queued"));
    await page.goto(input.webOrigin+"/ui/hub?view=notices");await page.locator(`[data-directory-notice="${id}"]`).waitFor();await page.locator(`[data-directory-notice="${id}"]`).scrollIntoViewIfNeeded();await page.screenshot({path:join(OUT,tag+"-hub-notice.png")});
    const nt=await page.locator(`[data-directory-notice="${id}"]`).innerText();check(r,"notice:no-directory-values",!nt.includes("Dummy-")&&!nt.includes("ldaps://"));await page.locator(`[data-directory-notice="${id}"] button`).click();await page.locator(`[data-directory-notice="${id}"] button`).waitFor({state:"detached"});await page.reload();
    check(r,"notice:both-durable",targets().every(x=>x.state==="delivered"));await hc.close();contexts.splice(contexts.indexOf(hc),1);db.close();
   }
   await ctx.close();contexts.splice(contexts.indexOf(ctx),1);
  }
 }
 if(RECOVERY){
  const r:any={case:"host-offline-and-CA-bootstrap"};result.cases.push(r);
  const ctx=await browser.newContext({viewport:VIEWPORTS.phone,isMobile:true,hasTouch:true,colorScheme:"dark"});contexts.push(ctx);
  await ctx.addCookies([{name:cookieName,value:cookieValue,url:origin}]);fm.webPrefs.write("operator",new Map([["theme","dark"],["lang","en"]]));
  await ctx.addInitScript({content:'localStorage.setItem("agend_lang","en");localStorage.setItem("agend_tour_done","1");localStorage.setItem("agend_firstrun_dismissed","1");'});
  const page=await ctx.newPage(),errors:string[]=[],wire:any[]=[];page.on("pageerror",(e:any)=>errors.push(e.message));page.on("response",(res:any)=>{const path=new URL(res.url()).pathname;if(path.startsWith("/api/settings/hub/directory"))wire.push({path,status:res.status()});});
  await peerA.close();await page.goto(origin+"/settings/hub");await page.locator("#hubDirectory-url").waitFor();
  check(r,"old-AD-down-read",wire.some(x=>x.path==="/api/settings/hub/directory"&&x.status===200));
  await page.locator("#hubDirectory-url").fill(`ldaps://127.0.0.1:${peerB.port}`);await page.getByRole("button",{name:"Fetch CA and save…",exact:true}).click();
  await page.locator("dialog[open]").waitFor();const dialog=page.locator("dialog[open]");check(r,"inspect-no-bind",peerB.bindRecords.length===0);
  await page.getByRole("button",{name:"Fingerprint matches — fetch CA",exact:true}).click();await page.getByRole("button",{name:"Use service account and fetch CA",exact:true}).waitFor();
  check(r,"anonymous-first",peerB.bindRecords.every(x=>!x.dn&&!x.password));const serviceText=await buttonText(page);check(r,"CA-service-text-fits",serviceText.length===0,serviceText);await page.screenshot({path:join(OUT,"phone-dark-en-host-CA-service.png")});
  await dialog.locator('input[type="password"]').fill("Dummy-service-only");await page.getByRole("button",{name:"Use service account and fetch CA",exact:true}).click();
  await page.getByRole("button",{name:"Confirm fingerprints and save",exact:true}).waitFor();check(r,"same-trust-dialog",await page.locator("dialog[open]").count()===1);
  check(r,"new-CA-shown",(await dialog.innerText()).includes("CA fingerprint"));check(r,"no-save-before-confirm",epoch()===0);const confirmText=await buttonText(page);check(r,"CA-confirm-text-fits",confirmText.length===0,confirmText);await page.screenshot({path:join(OUT,"phone-dark-en-host-CA-final.png")});
  await page.getByRole("button",{name:"Confirm fingerprints and save",exact:true}).click();await page.getByRole("status").filter({hasText:"AD connection saved."}).waitFor({timeout:25000});
  check(r,"CA-save-ready",epoch()===1&&fm.hubRuntime.serverHealth(fm.getRawFleetConfig().hub)==="ready");check(r,"service-only-bootstrap",peerB.bindRecords.every(x=>!x.dn&&!x.password||x.dn===input.directory.bindDn&&x.password==="Dummy-service-only"));
  // The existing local Run switch remains usable when AD is unreachable. No fixture config write here.
  await peerB.close();await page.locator("#hubRunOn").click();await page.getByRole("button",{name:"Stop the Hub",exact:true}).click();await page.getByRole("status").filter({hasText:"The Hub is stopped."}).waitFor();await wait(()=>fm.hubRuntime.serverHealth(fm.getRawFleetConfig().hub)==="off");check(r,"host-Run-off-with-AD-down",true);
  peerC=await groupWirePeer(candidateCerts.leaf,users);await page.reload();await page.locator("#hubDirectory-url").waitFor();
  check(r,"stopped-offline-editor",fm.hubRuntime.serverHealth(fm.getRawFleetConfig().hub)==="off");await page.locator("#hubDirectory-url").fill(`ldaps://127.0.0.1:${peerC.port}`);await page.locator("#hubDirectory-bindPassword").fill("Dummy-service-only");
  await page.locator("#hub-directory-editor button[type=submit]").click();await page.getByRole("button",{name:"Confirm fingerprints and save",exact:true}).click();await page.getByRole("status").filter({hasText:"AD connection saved."}).waitFor({timeout:25000});
  check(r,"stopped-save-stays-off",epoch()===2&&fm.hubRuntime.serverHealth(fm.getRawFleetConfig().hub)==="off");await page.screenshot({path:join(OUT,"phone-dark-en-host-offline-saved.png"),fullPage:true});
  await page.locator("#hub-directory-editor details summary").click();await page.locator("#hubDirectory-timeoutMs").fill("5500");
  await page.getByRole("button",{name:"Test connection",exact:true}).click();await page.getByRole("status").filter({hasText:"Connection test passed. Nothing was saved."}).waitFor();
  check(r,"test-has-no-effect",epoch()===2);check(r,"same-host-test-no-dialog",await page.locator("dialog[open]").count()===0);
  await page.locator("#hub-directory-editor button[type=submit]").click();await page.getByRole("status").filter({hasText:"AD connection saved."}).waitFor({timeout:25000});
  check(r,"same-host-one-save",epoch()===3&&await page.locator("dialog[open]").count()===0);check(r,"plain-save-stays-off",fm.hubRuntime.serverHealth(fm.getRawFleetConfig().hub)==="off");
  await page.locator("#hubRunOn").click();await page.getByRole("status").filter({hasText:"The Hub is starting."}).waitFor();await wait(()=>fm.hubRuntime.serverHealth(fm.getRawFleetConfig().hub)==="ready");check(r,"host-Run-on-ready",true);
  check(r,"no-page-errors",errors.length===0,errors);check(r,"only-expected-CA-refusal",wire.filter(x=>x.status>=400).every(x=>x.path.endsWith("/ca/fetch")&&x.status===403),wire);
  await ctx.close();contexts.splice(contexts.indexOf(ctx),1);
 }
 check(result,"cases-exercised",result.cases.length>0);check(result,"identity-kept",readFileSync(join(home,"hub/keys/identity.json")).equals(identity));check(result,"certificate-kept",readFileSync(join(home,"hub/web-tls/cert.pem")).equals(browserCert));
 const db=new Database(join(home,"hub/hub.sqlite"),{readonly:true});try{check(result,"groups-off",JSON.parse(db.prepare("SELECT body FROM hub_group_policy").get().body).state==="never-enabled");check(result,"known-fixture-credentials-only",[...peerA.bindRecords,...peerB.bindRecords].every(x=>x.password==="Dummy-service-only"||x.password==="Dummy-person-only"||!x.dn&&!x.password));}finally{db.close();}
}catch(e){result.failure=(e as Error).stack;throw e;}
finally{for(const c of contexts)await c.close();await browser.close();await fm?.hubSetupController?.close();await fm?.hubDirectoryControl?.close();await fm?.hubRuntime?.close();if(fm?.healthServer){fm.healthServer.closeAllConnections();await new Promise<void>(r=>fm.healthServer.close(()=>r()));}fm?.webSessions?.flush?.();await peerA?.close();await peerB?.close();await peerC?.close();certs.cleanup();if(candidateCerts!==certs)candidateCerts.cleanup();rmSync(home,{recursive:true,force:true});rmSync(envHome,{recursive:true,force:true});result.cleaned=true;writeFileSync(join(OUT,"receipt.json"),JSON.stringify(result,null,2));}

console.log(JSON.stringify({cases:result.cases.length,cleaned:result.cleaned,skew:SKEW}));process.exit(0);
