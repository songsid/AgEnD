/** Separate real initialized Hub servers, production runtime/HTTPS/UI/SQLite; inert AD, no Fleet or vendor CLI. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const repo=process.env.REPO??process.cwd(),out=process.env.OUT!,mode=process.env.MODE??"after";
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
   await page.locator(mode==="after"?".hub-roles":".hub-groups").waitFor();
   await page.locator(mode==="after"?".hub-roles .hub-role-list":".hub-groups .hub-groups-state").first().waitFor();
   await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(out,tag+".png"),fullPage:true});receipt.screens.push({tag,file:tag+".png",sha256:hash(readFileSync(join(out,tag+".png")))});
   const geometry=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth-innerWidth,buttons:[...document.querySelectorAll(".hub-roles button,.hub-roles input,.hub-roles select")].map(el=>({text:el.textContent,box:el.getBoundingClientRect().toJSON()}))}));
   check(tag+" no horizontal overflow",geometry.overflow<=1);
   if(device==="phone"&&mode==="after")check(tag+" tap controls44px",geometry.buttons.every((b:any)=>b.box.width>=44&&b.box.height>=44));
   if(mode==="after"){
    check(tag+" real role capability",await page.evaluate(async()=>{const r=await fetch("/hub/v1/session");return(await r.json()).features.includes("role-settings-v1");}));
    if(device==="desk"&&theme==="light"){
     await page.getByRole("button",{name:lang==="en"?"New role":"新增角色",exact:true}).click();await page.locator(".hub-role-editor").waitFor();
     await page.screenshot({path:join(out,tag+"-editor.png"),fullPage:true});receipt.screens.push({tag:tag+"-editor",file:tag+"-editor.png",sha256:hash(readFileSync(join(out,tag+"-editor.png")))});
     check(tag+" twelve permissions",await page.locator('.hub-role-editor input[type="checkbox"]').count()===12);
    }
   }
   await page.close();
  }finally{await ctx.close();}
 }
 check("all eight theme/device/locale cases captured",receipt.screens.filter((s:any)=>!s.tag.endsWith("-editor")).length===8);check("no browser errors",receipt.errors.length===0);receipt.status="PASS";
}catch(error:any){receipt.status="FAIL";receipt.error=error.stack;throw error;}
finally{await browser?.close();await runtime?.close();rmSync(home,{recursive:true,force:true});if(certs)rmSync(certs.dir,{recursive:true,force:true});receipt.cleaned=true;writeFileSync(join(out,"receipt.json"),JSON.stringify(receipt,null,2));}
console.log(JSON.stringify({status:receipt.status,mode,checks:receipt.checks.length,screens:receipt.screens.length,out}));
