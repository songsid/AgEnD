/** S-119 Story5: actual Hub HTTPS, production AD against owned recorded LDAPS, no API reply substitution. */
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
const repo=resolve(process.env.REPO??process.cwd()),out=resolve(process.env.OUT??".artifacts/admin-browser"),skew=process.env.SKEW??"",before=process.env.BEFORE==="1",base="ffd4eba02";
mkdirSync(out,{recursive:true});
const require=createRequire(import.meta.url),tls=require("node:tls"),connect=tls.connect;let dcPort=0;
tls.connect=(o:any,...args:any[])=>connect({...o,...(o.host==="127.0.0.1"&&o.port===636?{port:dcPort}:{})},...args);syncBuiltinESMExports();
const {companyJoinRig}=await import(repo+"/tests/support/hub-company-join-rig.ts"),{matrix,caseName,VIEWPORTS}=await import(repo+"/scripts/manual/smoke-fixture/index.mts");
const r=await companyJoinRig((port:number)=>{dcPort=port;},{host:"dashboard.lan.example"}),admin=await r.signIn("alice");await r.enable(admin,8);
const pw=createRequire(process.env.PW_DIR+"/")("playwright-core"),browser=await pw.chromium.launch({executablePath:process.env.CHROME,args:["--no-sandbox","--host-resolver-rules=MAP dashboard.lan.example 127.0.0.1"]});
const result:any={base,before,skew,browser:browser.version(),checks:[],cases:[],shots:[],errors:[],cleaned:false,scope:"Owned Hub HTTPS + recorded LDAPS; actual admin session, CSRF, group navigation, company link, scoped invitation and manual pairing offer. No Fleet/native/model/CLI/pilot/real directory or account. No API replies replaced."};
const check=(name:string,ok:any,detail?:any)=>{result.checks.push({name,ok:!!ok,...(!ok?{detail}:{})});if(!ok)throw Error(name+" "+JSON.stringify(detail??""));};
const paint=async(p:any)=>p.evaluate(async()=>{await document.fonts.ready;await new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())));});
try{
 for(const[index,c]of matrix().entries()){
  const tag=caseName(c),zh=c.lang==="zh-TW",login="individual-"+index;
  r.people.push({id:randomUUID(),login,dn:`CN=${login},DC=example,DC=test`,password:"Dummy-"+login,groups:["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]});
  const settings=await r.call(admin,"GET","/hub/v1/admin/company-join");if(settings.body.enabled)await r.call(admin,"PUT","/hub/v1/admin/company-join",{enabled:false,expectedRevision:settings.body.revision});
  const ctx=await browser.newContext({viewport:VIEWPORTS[c.device],isMobile:c.device==="phone",hasTouch:c.device==="phone",colorScheme:c.theme,ignoreHTTPSErrors:true,permissions:["clipboard-read","clipboard-write"]});
  await ctx.addInitScript({content:`try{localStorage.setItem('agend_lang',${JSON.stringify(c.lang)});localStorage.setItem('agend_theme',${JSON.stringify(c.theme)});localStorage.setItem('agend_tour_done','1');}catch{}window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective));`});
  const retained:any={"old-panel":"panel-hub.js","old-company":"hub-company-join.js","old-words":"hub-company-join-strings.js","old-owner-words":"hub-owner-strings.js","old-css":"shared/hub-owner.css"};if(skew&&!retained[skew])throw Error("unknown skew");
  await ctx.route("**/*",(route:any)=>{const u=new URL(route.request().url());if(u.origin!==r.webOrigin)return route.abort();const file=retained[skew];if(file&&u.pathname.endsWith("/"+file.split("/").pop()))return route.fulfill({contentType:file.endsWith(".css")?"text/css":"application/javascript",body:execFileSync("git",["show",base+":src/ui/"+file],{cwd:repo,encoding:"utf8"})});return route.continue();});
  const page=await ctx.newPage(),writes:any[]=[];page.on("pageerror",(e:Error)=>result.errors.push({tag,text:e.message}));page.on("request",(q:any)=>{if(q.method()!=="GET")writes.push({method:q.method(),path:new URL(q.url()).pathname});});
  const shot=async(label:string)=>{await paint(page);await page.screenshot({path:join(out,tag+"-"+label+".png"),fullPage:true});result.shots.push(tag+"-"+label+".png");};
  try{
   await page.goto(r.webOrigin+"/ui/hub/admin");await page.locator("#hubLogin").fill("alice");await page.locator("#hubPassword").fill("Dummy-alice-only");await page.getByRole("button",{name:zh?"登入":"Sign in",exact:true}).click();await page.locator(".hub-admin").waitFor();
   const oldMode=before||skew&&skew!=="old-css";
   if(oldMode){await page.locator('.hub-company-join input[role="switch"]').waitFor();check(tag+" retained earlier entry",await page.locator(".hub-admin-access").count()===0);await page.locator(".hub-groups-entry").waitFor();await shot("earlier-entry");if(before){await page.locator('.hub-company-join input[role="switch"]').click();await page.locator(".hub-company-join textarea").waitFor();await shot("earlier-enabled");}result.cases.push({tag,ok:true});continue;}
   await page.locator(".hub-admin-access").waitFor();await page.getByText(zh?"請先開啟公司帳號連接":"Turn on company-account Fleet connections",{exact:false}).waitFor();
   check(tag+" access first",await page.locator(".hub-admin .s-section-layout > :first-child").getAttribute("data-entry")==="allowed-groups-people");
   const copy=page.getByRole("button",{name:zh?"複製同仁連線連結":"Copy colleague connection link",exact:true});check(tag+" off copy explained",await copy.isDisabled());check(tag+" manual starts folded",(await page.locator("details.hub-admin-manual").getAttribute("open"))===null&&await page.locator("#hubOwnerLogin").isHidden());await shot("off");
   await page.locator('.hub-admin-access input[role="switch"]').click();await copy.waitFor();await page.waitForFunction(()=>!(document.querySelector('.hub-admin-access .field-row button')as HTMLButtonElement)?.disabled);await copy.click();
   const saved=await r.call(admin,"GET","/hub/v1/admin/company-join"),clip=await page.evaluate(()=>navigator.clipboard.readText());check(tag+" exact address and identity link",clip===saved.body.companyLink&&clip.startsWith(r.webOrigin+"/join-info#hub="));
   const individual=page.locator(".hub-admin-individual input");await individual.fill(login);await page.locator(".hub-admin-individual button[type=submit]").click();await page.locator(".hub-admin-individual textarea").waitFor();check(tag+" explicit invitation",(await page.locator(".hub-admin-individual textarea").inputValue()).startsWith(r.webOrigin+"/join-info#invite="));
   check(tag+" scoped invitation explained",(await page.locator(".hub-admin-individual").innerText()).includes(zh?"不會授予":"does not grant permission"));await shot("allowed-and-individual");if(c.device==="phone"){await page.locator(".hub-admin-individual > button").scrollIntoViewIfNeeded();await shot("individual-invitation");}
   await page.locator('a[href="/ui/hub/admin?view=groups"]').click();await page.locator(".hub-groups").waitFor();check(tag+" existing group editor",(await page.locator(".hub-groups").innerText()).length>0);await page.goto(r.webOrigin+"/ui/hub/admin");await page.locator(".hub-admin-access").waitFor();
   await page.locator(".hub-admin-manual summary").click();await page.locator("#hubOwnerLogin").fill(login);await page.locator(".hub-admin-manual button[type=submit]").click();await page.locator(".hub-offer .hub-code").waitFor();check(tag+" manual code retained",(await page.locator(".hub-offer .hub-code").innerText()).length>=6);await page.locator(".hub-admin-manual summary").scrollIntoViewIfNeeded();await shot("advanced-overview");await page.locator(".hub-offer").scrollIntoViewIfNeeded();await shot("advanced-code");
   const geometry=await page.locator(".hub-admin").evaluate((root:HTMLElement)=>({overflow:document.documentElement.scrollWidth>innerWidth+1,bad:[...root.querySelectorAll("button,a.btn,input,summary")].filter((e:any)=>!e.disabled&&e.getClientRects().length&&e.offsetParent!==null).map((e:any)=>{const el=e.type==="checkbox"?e.closest("label"):e,b=el.getBoundingClientRect();return{text:e.textContent,w:b.width,h:b.height};}).filter(x=>Math.min(x.w,x.h)<43.5)}));check(tag+" no overflow",!geometry.overflow,geometry);if(c.device==="phone")check(tag+" phone tap",geometry.bad.length===0,geometry.bad);
   check(tag+" only explicit effects",writes.filter(x=>x.path.endsWith("/invitations")).length===1&&writes.filter(x=>x.path==="/hub/v1/admin/pairings").length===1,writes);check(tag+" no CSP",(await page.evaluate(()=>((window as any).__csp??[]))).length===0);result.cases.push({tag,ok:true});
  }catch(error){await shot("FAIL");throw error;}finally{await ctx.close();}
 }
 check("nonempty matrix",result.cases.length===matrix().length&&result.cases.length>0);check("no script errors",result.errors.length===0,result.errors);result.status="PASS";
}catch(error:any){result.status="FAIL";result.error=error.stack;throw error;}finally{await browser.close();await r.close();tls.connect=connect;syncBuiltinESMExports();result.cleaned=true;writeFileSync(join(out,"receipt.json"),JSON.stringify(result,null,2));}
console.log(JSON.stringify({status:result.status,cases:result.cases.length,checks:result.checks.length,cleaned:result.cleaned}));
