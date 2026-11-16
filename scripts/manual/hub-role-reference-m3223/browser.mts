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
const requested=process.env.STAGES?.split(","),wanted=(stage:string)=>!requested||requested.includes(stage);receipt.stages=requested??["roles","permissions","create","assign","review","audit"];
let runtime:any,browser:any,certs:any;
try{
 const [{createHubInitializer},{hubIdentityProvider},{makeTestCerts,ADMIN},{HubRuntime},{default:yaml}]=await Promise.all([load("src/hub/init/initializer.ts"),load("src/hub/init/identity.ts"),load("tests/support/hub-init-fixtures.ts"),load("src/hub/runtime.ts"),import("js-yaml")]);
 certs=makeTestCerts();const webPort=await port();let memberPort=await port();while(memberPort===webPort)memberPort=await port();
 const origin=`https://hub.example.test:${webPort}`;
 const alex={key:{realm:"corp",objectId:"11111111-1111-4111-8111-111111111111"},login:"alex",displayName:"Alex Chen · 陳同仁",dn:"uid=alex,dc=example,dc=test",groups:[]};
 const jo={key:{realm:"corp",objectId:"22222222-2222-4222-8222-222222222222"},login:"jo",displayName:"Jo Lin · 林同仁",dn:"uid=jo,dc=example,dc=test",groups:[]};
 const product={objectId:"33333333-3333-4333-8333-333333333333",cn:"Product",dn:"CN=Product,DC=example,DC=test"};
 const people=[{...ADMIN,displayName:"Avery Chen · 陳管理員",groups:[]},alex,jo];
 const plan={name:"Example company",webOrigin:origin,memberOrigin:`https://hub.example.test:${memberPort}`,webListen:{host:"127.0.0.1",port:webPort},memberListen:{host:"127.0.0.1",port:memberPort},webTls:{certFile:certs.cert,keyFile:certs.key},directory:{realm:"corp",url:"ldaps://directory.example.test",baseDn:"dc=example,dc=test",bindDn:"cn=reader,dc=example,dc=test",profile:"openldap"},bindPasswordRef:"file:hub/secrets/directory-bind",administrator:ADMIN.key,retention:{contentDays:30,eventDays:180},coexistence:"dedicated"};
 const init=createHubInitializer({home,identity:hubIdentityProvider(),probe:{pidAlive:()=>false}}),confirmation=await init.prepareConfirmation(plan,{bindPassword:"Synthetic-bind-password-only"});await init.commit(plan,confirmation.reference);
 const config=yaml.load(readFileSync(join(home,"fleet.yaml"),"utf8"));
 runtime=new HubRuntime({home,readConfig:()=>config,log:(level:string,message:string,meta:any)=>{receipt.runtimeLog??=[];receipt.runtimeLog.push({level,message,meta});},createDirectory:()=>({realm:"corp",groupPolicy:"ad-direct-guid",close:async()=>{},signIn:async(login:string,password:string)=>{const p=people.find(p=>p.login===login);return p&&password==="Synthetic-browser-only"?{ok:true,person:p}:{ok:false,reason:"invalid-credentials"};},checkEligibility:async(key:any)=>{const p=people.find(p=>p.key.objectId===key.objectId&&p.key.realm===key.realm);return p?{eligible:true,person:p}:{eligible:false,reason:"disabled"};},searchGrantPeople:async(q:string)=>({ok:true,people:[alex,jo].filter(p=>p.displayName.toLowerCase().includes(q.toLowerCase())).map(p=>({person:p.key,displayName:p.displayName,login:p.login})),truncated:false}),searchPolicyGroups:async()=>({ok:true,groups:[product],truncated:false}),resolvePolicyGroup:async(dn:string)=>({ok:true,group:{key:{realm:"corp",objectId:product.objectId},dn}}),readPolicyGroups:async(key:any)=>({kind:"complete",person:key,groups:[product.objectId],observedAt:Date.now()})})});
 await runtime.apply(config);check("production Hub ready",runtime.serverHealth(config.hub)==="ready");
 const pw=createRequire(join(process.cwd(),"package.json"))("playwright-core");
 browser=await pw.chromium.launch({headless:true,args:["--no-sandbox","--host-resolver-rules=MAP hub.example.test 127.0.0.1"]});receipt.browser=browser.version();
 let seeded=false;
 for(const device of ["desk","phone"])for(const theme of ["light","dark"])for(const lang of ["en","zh-TW"]){
  const tag=`${mode}-${device}-${theme}-${lang}`,zh=lang==="zh-TW",ctx=await browser.newContext({ignoreHTTPSErrors:true,acceptDownloads:true,viewport:device==="phone"?{width:390,height:844}:{width:1440,height:1000},isMobile:device==="phone",hasTouch:device==="phone",locale:lang});
  try{
   await ctx.addInitScript("window.__name=fn=>fn;");await ctx.addInitScript(({theme,lang}:any)=>{localStorage.setItem("agend_theme",theme);localStorage.setItem("agend_lang",lang);localStorage.setItem("agend_tour_done","1");localStorage.setItem("agend_firstrun_dismissed","1");},{theme,lang});
   const page=await ctx.newPage();page.on("pageerror",(e:any)=>receipt.errors.push({tag,error:e.message}));
   await page.goto(origin+"/ui/hub/admin?view=roles");await page.locator("#hubLogin").fill(ADMIN.login);await page.locator("#hubPassword").fill("Synthetic-browser-only");await page.locator("#hubPassword").press("Enter");await page.locator(".hub-roles .hub-role-list").first().waitFor();
   if(!seeded){
    const result=await page.evaluate(async({alex}:any)=>{
     const session=await(await fetch("/hub/v1/session")).json();
     const request=async(path:string,body?:any)=>{const r=await fetch("/hub/v1/roles"+path,{method:body===undefined?"GET":"POST",headers:body===undefined?{}:{"Content-Type":"application/json","X-AgEnD-Hub-CSRF":session.csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});const out=await r.json();if(!r.ok||out.ok===false)throw Error(path+" "+JSON.stringify(out));return out;};
     const save=async(policy:any)=>{const before=await request("/preview",{policy});await request("/apply",{policy,previewDigest:before.previewDigest});};
     await request("/search?kind=person&q=Alex");let view=(await request("")).view;
     view.policy.roles.push({id:"custom:support",kind:"custom",name:"Support leads",description:"Help colleagues review Hub activity.",permissions:["ask_agents","audit.view"],defaultMaxFleets:0});await save(view.policy);
     view=(await request("")).view;view.policy.assignments.push({id:"support-alex",roleId:"custom:support",subject:{kind:"person",person:alex.key},scope:{kind:"hub"},startsAt:0,expiresAt:null,maxFleets:null,assignedBy:view.actor,assignedAt:0});await save(view.policy);
     const root=await request("/root-self/preview",{});await request("/root-self/apply",{previewDigest:root.previewDigest});
     view=(await request("")).view;view.policy.roles.find((r:any)=>r.id==="custom:support").description="Reviews Hub activity with colleagues.";await save(view.policy);
     return {roles:(await request("")).view.policy.roles.length};
    },{alex});check("real HTTP creates described role, named assignment and own-access defaults",result.roles===5);seeded=true;await page.goto(origin+"/ui/hub/admin?view=roles");await page.locator(".hub-roles .hub-role-list").first().waitFor();
   }
   await page.evaluate(()=>document.fonts.ready);
   const click=async(name:string,root:any=page)=>root.getByRole("button",{name,exact:true}).click();
   const geometry=async(stage:string)=>{
    const dimensions=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth-innerWidth,dialogs:[...document.querySelectorAll("dialog[open]")].map(el=>el.getBoundingClientRect().toJSON())}));
    check(tag+" "+stage+" no horizontal overflow",dimensions.overflow<=1);if(device==="phone"&&mode==="after")check(tag+" "+stage+" panel fits phone",dimensions.dialogs.every((d:any)=>d.x>=-1&&d.width<=391));
   };
   const capture=async(stage:string,selector:string)=>{
    if(!wanted(stage))return;
    const el=page.locator(selector).first();await el.evaluate((el:any)=>{el.scrollIntoView({block:"start"});if(el.scrollHeight>el.clientHeight&&/auto|scroll/.test(getComputedStyle(el).overflowY))el.scrollTop=0;});
    for(let part=1;part<=(stage==="audit"?2:4);part++){
     const file=`${tag}-${stage}${part>1?"-"+part:""}.png`;await page.screenshot({path:join(out,file)});receipt.screens.push({tag:`${tag}-${stage}${part>1?"-"+part:""}`,file,sha256:hash(readFileSync(join(out,file)))});
     const moved=await el.evaluate((el:any)=>{
      if(el.scrollHeight>el.clientHeight&&/auto|scroll/.test(getComputedStyle(el).overflowY)){const old=el.scrollTop;el.scrollTop+=el.clientHeight*.75;return el.scrollTop>old;}
      let scroll=el.parentElement;while(scroll&&!(scroll.scrollHeight>scroll.clientHeight&&/auto|scroll/.test(getComputedStyle(scroll).overflowY)))scroll=scroll.parentElement;
      if(!scroll)return false;const box=el.getBoundingClientRect(),s=scroll.getBoundingClientRect(),bottom=Math.min(innerHeight,s.bottom);if(box.bottom<=bottom+1)return false;
      const old=scroll.scrollTop;scroll.scrollTop+=Math.min(scroll.clientHeight*.75,box.bottom-bottom);return scroll.scrollTop>old;
     });if(!moved)break;
    }
    await geometry(stage);
   };
   const fresh=async()=>{await page.goto(origin+"/ui/hub/admin?view=roles");await page.locator(".hub-roles .hub-role-list").first().waitFor();};
   await capture("roles",".hub-roles");
   if(mode==="before"){
    const row=page.locator(".hub-role-list > li").filter({has:page.locator("strong",{hasText:zh?"主管":"Manager"})});await click(zh?"編輯":"Edit",row);await capture("permissions",".hub-role-editor");
   }else{await click(zh?"主管":"Manager");await page.getByRole("tab",{name:new RegExp("^"+(zh?"權限":"Permissions"))}).click();await capture("permissions",".hub-role-detail");}
   await fresh();await click(mode==="before"?(zh?"新增角色":"New role"):(zh?"新增角色":"Create new role"));
   if(mode==="after"){
    const form=page.locator(".hub-role-info");await form.locator("select").selectOption("builtin:member");await form.locator('input[maxlength="120"]').fill("Release helpers");await form.locator('input[maxlength="500"]').fill("Helps colleagues ask and share agents.");await click(zh?"繼續":"Continue",form);check(tag+" exactly nine choosable permissions",await page.locator('.hub-role-editor input[type="checkbox"]').count()===9);
   }
   await capture("create",mode==="before"?".hub-role-editor":".hub-role-wizard");
   await fresh();
   if(mode==="before")await click(zh?"指派角色":"Assign role");else{const row=page.locator(".hub-role-list tbody tr").filter({has:page.locator("button",{hasText:zh?"主管":"Manager"})});await click(zh?"指派":"Assign",row);}
   const assignment=page.locator(mode==="before"?".hub-role-assignment":".hub-role-panel");
   if(mode==="before"){
    await assignment.locator("select").first().selectOption("builtin:manager");await assignment.locator("#hubRoleSubject").fill("Jo");await assignment.getByRole("button",{name:new RegExp("^"+(zh?"選擇":"Choose")+" Jo")}).click();await assignment.locator("#hubRoleScope").fill("Product");await assignment.getByRole("button",{name:new RegExp("Product")}).click();
   }else{
    await assignment.locator("#hubRoleSubject").fill("Jo");await assignment.getByRole("button",{name:new RegExp("^"+(zh?"選擇":"Choose")+" Jo")}).click();await assignment.locator("#hubRoleScope").fill("Product");await assignment.getByRole("button",{name:new RegExp("Product")}).click();
   }
   await capture("assign",mode==="before"?".hub-role-assignment":".hub-role-panel .dlg-body");
   if(wanted("review")){
   await fresh();
   if(mode==="before"){const row=page.locator(".hub-role-list > li").filter({has:page.locator("strong",{hasText:"Support leads"})});await click(zh?"編輯":"Edit",row);}
   else{await click("Support leads");await page.getByRole("tab",{name:new RegExp("^"+(zh?"權限":"Permissions"))}).click();await click(zh?"編輯權限":"Edit permissions");await click(zh?"繼續":"Continue",page.locator(".hub-role-info"));}
   const editor=page.locator(".hub-role-editor");await editor.getByRole("checkbox",{name:new RegExp(zh?"查看稽核紀錄":"View audit log")}).uncheck();await click(mode==="before"?(zh?"先檢查變更":"Check changes"):(zh?"檢查變更":"Review"));
   await page.locator(mode==="before"?".hub-role-preview":"[data-role-review]").waitFor();if(mode==="after"){check(tag+" actual named non-zero role impact",(await page.locator("[data-role-review]").textContent()).includes("Alex Chen"));check(tag+" does not claim nobody loses access",!(await page.locator("[data-role-review]").textContent()).includes(zh?"沒有人會失去權限":"Nobody loses access"));}
   await capture("review",mode==="before"?".hub-role-preview":".hub-role-wizard");
   }
   if(wanted("audit")){
   await fresh();if(mode==="after")await page.getByRole("tab",{name:zh?"稽核紀錄":"Audit log",exact:true}).click();
   const audit=page.locator(mode==="before"?".hub-roles section:has(h3:text-is('"+(zh?"稽核紀錄":"Audit log")+"'))":".hub-role-audit-page");await audit.locator("tbody tr").first().waitFor();
   if(mode==="after"){await audit.locator("tbody details summary").first().click();if(device==="desk"&&theme==="light"&&lang==="en"){
     const downloading=page.waitForEvent("download");await click("Export CSV",audit);const download=await downloading,stream=await download.createReadStream(),chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));const csv=Buffer.concat(chunks).toString("utf8");check("actual browser metadata CSV includes named role history",csv.includes("Support leads")&&csv.includes("Before")&&!csv.includes("contentRef"));receipt.csv={bytes:Buffer.byteLength(csv),sha256:hash(csv)};
    }}
   await capture("audit",mode==="before"?".hub-roles section:has(h3:text-is('"+(zh?"稽核紀錄":"Audit log")+"'))":".hub-role-audit-page");
   }
   await page.close();
  }finally{await ctx.close();}
 }
 check("all8 combinations and requested views",["desk","phone"].every(d=>["light","dark"].every(t=>["en","zh-TW"].every(l=>(requested??["roles","permissions","create","assign","review","audit"]).every(v=>receipt.screens.some((s:any)=>s.tag===`${mode}-${d}-${t}-${l}-${v}`))))));check("no browser exceptions",receipt.errors.length===0);receipt.status="PASS";
}catch(error:any){receipt.status="FAIL";receipt.error=error.stack;throw error;}
finally{await browser?.close();await runtime?.close();rmSync(home,{recursive:true,force:true});if(certs)rmSync(certs.dir,{recursive:true,force:true});receipt.cleaned=true;writeFileSync(join(out,"receipt.json"),JSON.stringify(receipt,null,2));}
console.log(JSON.stringify({status:receipt.status,mode,checks:receipt.checks.length,screens:receipt.screens.length,out}));
