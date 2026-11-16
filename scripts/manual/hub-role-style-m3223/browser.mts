/** Separate real initialized Hub servers, production runtime/HTTPS/UI/SQLite; inert AD, no Fleet or vendor CLI. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const repo=process.env.REPO??process.cwd(),out=process.env.OUT!,mode=process.env.MODE??"after",current=true;
if(!out)throw Error("OUT is required");
if(!readFileSync("/proc/version","utf8").toLowerCase().includes("microsoft"))throw Error("Run headless inside WSL only");
mkdirSync(out,{recursive:true});mkdirSync(join(repo,".artifacts"),{recursive:true});
const home=mkdtempSync(join(repo,".artifacts/roles-browser-"));process.env.AGEND_HOME=home;
const load=(file:string)=>import(join(repo,file));
const git=(...args:string[])=>execFileSync("git",["-C",repo,...args],{encoding:"utf8"}).trim();
const hash=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
const receipt:any={mode,head:git("rev-parse","HEAD"),tree:git("rev-parse","HEAD^{tree}"),dirty:git("status","--porcelain","--untracked-files=no"),checks:[],screens:[],errors:[],scope:"Separate initialized production Hub runtime/HTTPS/SQLite and assets from REPO. Synthetic AD people/groups; no real credentials, Fleet or model process. Headless Chromium inside WSL."};
const check=(label:string,value:unknown)=>{receipt.checks.push({label,pass:!!value});if(!value)throw Error(label);};
const port=async()=>{const server=createServer();await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const value=(server.address() as any).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return value;};
let runtime:any,browser:any,certs:any;
try{
 const [{createHubInitializer},{hubIdentityProvider},{makeTestCerts,ADMIN},{HubRuntime},{default:yaml}]=await Promise.all([load("src/hub/init/initializer.ts"),load("src/hub/init/identity.ts"),load("tests/support/hub-init-fixtures.ts"),load("src/hub/runtime.ts"),import("js-yaml")]);
 certs=makeTestCerts();const webPort=await port();let memberPort=await port();while(memberPort===webPort)memberPort=await port();
 const origin=`https://hub.example.test:${webPort}`;
 const alex={key:{realm:"corp",objectId:"11111111-1111-4111-8111-111111111111"},login:"alex",displayName:"Alex Chen · 陳同仁",dn:"uid=alex,dc=example,dc=test",groups:[]};
 const people=[{...ADMIN,displayName:"Avery Chen · 陳管理員",groups:[]},alex];
 const plan={name:"Example company",webOrigin:origin,memberOrigin:`https://hub.example.test:${memberPort}`,webListen:{host:"127.0.0.1",port:webPort},memberListen:{host:"127.0.0.1",port:memberPort},webTls:{certFile:certs.cert,keyFile:certs.key},directory:{realm:"corp",url:"ldaps://directory.example.test",baseDn:"dc=example,dc=test",bindDn:"cn=reader,dc=example,dc=test",profile:"openldap"},bindPasswordRef:"file:hub/secrets/directory-bind",administrator:ADMIN.key,retention:{contentDays:30,eventDays:180},coexistence:"dedicated"};
 const init=createHubInitializer({home,identity:hubIdentityProvider(),probe:{pidAlive:()=>false}}),confirmation=await init.prepareConfirmation(plan,{bindPassword:"Synthetic-bind-password-only"});await init.commit(plan,confirmation.reference);
 const config=yaml.load(readFileSync(join(home,"fleet.yaml"),"utf8"));
 runtime=new HubRuntime({home,readConfig:()=>config,log:(level:string,message:string,meta:any)=>{receipt.runtimeLog??=[];receipt.runtimeLog.push({level,message,meta});},createDirectory:()=>({realm:"corp",groupPolicy:"ad-direct-guid",close:async()=>{},signIn:async(login:string,password:string)=>{const p=people.find(p=>p.login===login);return p&&password==="Synthetic-browser-only"?{ok:true,person:p}:{ok:false,reason:"invalid-credentials"};},checkEligibility:async(key:any)=>{const p=people.find(p=>p.key.objectId===key.objectId&&p.key.realm===key.realm);return p?{eligible:true,person:p}:{eligible:false,reason:"disabled"};},searchGrantPeople:async()=>({ok:true,people:[{person:alex.key,displayName:alex.displayName,login:alex.login}],truncated:false}),searchPolicyGroups:async()=>({ok:true,groups:[],truncated:false}),readPolicyGroups:async(key:any)=>({kind:"complete",person:key,groups:[],observedAt:Date.now()})})});
 await runtime.apply(config);check("production Hub ready",runtime.serverHealth(config.hub)==="ready");
 const pw=createRequire(join(process.cwd(),"package.json"))("playwright-core");
 browser=await pw.chromium.launch({headless:true,args:["--no-sandbox","--host-resolver-rules=MAP hub.example.test 127.0.0.1"]});receipt.browser=browser.version();
 for(const device of ["desk","phone"])for(const theme of ["light","dark"])for(const lang of ["en","zh-TW"]){
  const tag=`${mode}-${device}-${theme}-${lang}`,ctx=await browser.newContext({ignoreHTTPSErrors:true,viewport:device==="phone"?{width:390,height:844}:{width:1440,height:1000},isMobile:device==="phone",hasTouch:device==="phone",locale:lang});
  try{
   await ctx.addInitScript("window.__name=fn=>fn;");await ctx.addInitScript(({theme,lang}:any)=>{localStorage.setItem("agend_theme",theme);localStorage.setItem("agend_lang",lang);localStorage.setItem("agend_tour_done","1");localStorage.setItem("agend_firstrun_dismissed","1");},{theme,lang});
   const page=await ctx.newPage();page.on("pageerror",(e:any)=>receipt.errors.push({tag,error:e.message}));
   await page.goto(origin+"/ui/hub/admin?view=groups");await page.locator("#hubLogin").fill(ADMIN.login);await page.locator("#hubPassword").fill("Synthetic-browser-only");await page.locator("#hubPassword").press("Enter");
   await page.locator(".hub-roles .hub-role-list").first().waitFor();await page.evaluate(()=>document.fonts.ready);
   check(tag+" real role capability",await page.evaluate(async()=>{const r=await fetch("/hub/v1/session");return(await r.json()).features.includes("role-settings-v1");}));
   const capture=async(stage:string,selector?:string)=>{
    const save=async(part:number)=>{const file=`${tag}-${stage}${part>1?"-"+part:""}.png`;await page.screenshot({path:join(out,file),fullPage:false});receipt.screens.push({tag:tag+"-"+stage+(part>1?"-"+part:""),file,sha256:hash(readFileSync(join(out,file)))});};
    if(!selector){await save(1);return;}
    const element=page.locator(selector);await element.evaluate((el:any)=>el.scrollIntoView({block:"start"}));await save(1);
    for(let part=2;part<=8;part++){
     const moved=await element.evaluate((el:any)=>{
      let scroll=el.parentElement;while(scroll&&!(scroll.scrollHeight>scroll.clientHeight&&/auto|scroll/.test(getComputedStyle(scroll).overflowY)))scroll=scroll.parentElement;
      if(!scroll)return false;const r=el.getBoundingClientRect(),s=scroll.getBoundingClientRect(),bottom=Math.min(innerHeight,s.bottom);
      if(r.bottom<=bottom+1)return false;const old=scroll.scrollTop;scroll.scrollTop+=Math.min(scroll.clientHeight*.75,r.bottom-bottom);return scroll.scrollTop>old;
     });if(!moved)break;await save(part);
    }
   };
   const geometry=async(stage:string)=>{
    const g=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth-innerWidth,controls:[...document.querySelectorAll(".hub-roles button,.hub-roles input:not([type=checkbox]),.hub-roles select")].map(el=>({text:el.textContent,box:el.getBoundingClientRect().toJSON()})),labels:[...document.querySelectorAll(".hub-role-check")].map(el=>el.getBoundingClientRect().height)}));
    check(tag+" "+stage+" no horizontal overflow",g.overflow<=1);
    if(mode==="after"&&device==="phone"){check(tag+" "+stage+" touch controls44px",g.controls.every((b:any)=>b.box.width>=44&&b.box.height>=44));check(tag+" "+stage+" checkbox labels44px",g.labels.every((h:number)=>h>=44));}
   };
   await geometry("overview");await capture("overview");
   await page.getByRole("button",{name:lang==="en"?"New role":"新增角色",exact:true}).click();await page.locator(".hub-role-editor").waitFor();
   check(tag+" twelve permission controls",await page.locator('.hub-role-editor input[type="checkbox"]').count()===12);await geometry("editor");await capture("editor",".hub-role-editor");
   await page.locator(".hub-role-editor").getByRole("button",{name:lang==="en"?"Cancel":"取消",exact:true}).click();
   const assignment=page.locator(".hub-roles section").filter({has:page.locator("h3",{hasText:lang==="en"?"Assignments":"角色指派"})});
   const existing=assignment.getByRole("button",{name:lang==="en"?"Edit":"編輯",exact:true});
   if(await existing.count())await existing.first().click();else{
    await page.getByRole("button",{name:lang==="en"?"Assign role":"指派角色",exact:true}).click();
    const form=page.locator(".hub-role-assignment");
    if(mode==="before"){await form.locator('.hub-role-search input').fill("Al");await form.getByRole("button",{name:lang==="en"?"Search":"搜尋",exact:true}).click();}
    else await form.locator('input[type="search"]').fill("Al");
    await form.getByRole("button",{name:mode==="before"?(lang==="en"?"Choose":"選擇"):(lang==="en"?/^Choose Alex/:/^選擇 Alex/),exact:mode==="before"}).click();
   }
   await geometry("assignment");await capture("assignment",".hub-role-assignment");
   await page.locator(".hub-role-assignment").getByRole("button",{name:lang==="en"?"Check changes":"先檢查變更",exact:true}).click();await page.locator(".hub-role-preview").waitFor();
   await capture("preview",".hub-role-preview");
   await page.getByRole("button",{name:lang==="en"?"Save checked changes":"儲存已檢查的變更",exact:true}).click();await page.locator(".hub-role-preview").waitFor({state:"detached"});await page.locator(".hub-role-list").filter({hasText:"Alex Chen"}).waitFor();
   check(tag+" assignment stored via actual HTTP",await page.evaluate(async()=>{const body=await(await fetch("/hub/v1/roles")).json();return body.view.policy.assignments.some((a:any)=>a.subject.kind==="person"&&a.subject.person.objectId==="11111111-1111-4111-8111-111111111111"&&a.roleId==="builtin:admin");}));
   await geometry("saved");await capture("saved",".hub-roles section:has(h3:text-is('"+(lang==="en"?"Assignments":"角色指派")+"'))");
   await capture("audit",".hub-roles section:has(h3:text-is('"+(lang==="en"?"Audit log":"稽核紀錄")+"'))");
   if(mode==="after")check(tag+" grouped row actions",await page.locator(".hub-assignment-row .hub-role-row-actions").evaluate((el:any)=>{const b=[...el.querySelectorAll("button")].map((b:any)=>b.getBoundingClientRect());return b.length===2&&Math.abs(b[0].top-b[1].top)<1;}));
   await page.close();
  }finally{await ctx.close();}
 }
 check("all 8 combinations and 6 views captured",["desk","phone"].every(device=>["light","dark"].every(theme=>["en","zh-TW"].every(lang=>["overview","editor","assignment","preview","saved","audit"].every(stage=>receipt.screens.some((s:any)=>s.tag===`${mode}-${device}-${theme}-${lang}-${stage}`))))));check("no browser errors",receipt.errors.length===0);receipt.status="PASS";
}catch(error:any){receipt.status="FAIL";receipt.error=error.stack;throw error;}
finally{await browser?.close();await runtime?.close();rmSync(home,{recursive:true,force:true});if(certs)rmSync(certs.dir,{recursive:true,force:true});receipt.cleaned=true;writeFileSync(join(out,"receipt.json"),JSON.stringify(receipt,null,2));}
console.log(JSON.stringify({status:receipt.status,mode,checks:receipt.checks.length,screens:receipt.screens.length,out}));
