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
const receipt:any={mode,head:git("rev-parse","HEAD"),tree:git("rev-parse","HEAD^{tree}"),dirty:git("status","--porcelain","--untracked-files=no"),checks:[],screens:[],errors:[],scope:"Initialized production Hub runtime, HTTPS, SQLite and UI with synthetic directory identities only. No Fleet or provider process; Chromium headless under WSL."};
const check=(label:string,value:unknown)=>{receipt.checks.push({label,pass:!!value});if(!value)throw Error(label);};
const port=async()=>{const server=createServer();await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const value=(server.address() as any).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return value;};
const requested=process.env.STAGES?.split(","),wanted=(stage:string)=>!requested||requested.includes(stage);receipt.stages=requested??["roles","permissions","create","assign","review","audit"];
let runtime:any,browser:any,certs:any;
try{
 const [{createHubInitializer},{hubIdentityProvider},{makeTestCerts,ADMIN},{HubRuntime},{default:yaml}]=await Promise.all([load("src/hub/init/initializer.ts"),load("src/hub/init/identity.ts"),load("tests/support/hub-init-fixtures.ts"),load("src/hub/runtime.ts"),import("js-yaml")]);
 certs=makeTestCerts();const webPort=await port();let memberPort=await port();while(memberPort===webPort)memberPort=await port();
 const origin=`https://hub.example.test:${webPort}`;
 const alex={key:{realm:"corp",objectId:"11111111-1111-4111-8111-111111111111"},login:"alex",displayName:"Example Member",dn:"uid=alex,dc=example,dc=test",groups:[]};
 const jo={key:{realm:"corp",objectId:"22222222-2222-4222-8222-222222222222"},login:"jo",displayName:"Example Colleague",dn:"uid=jo,dc=example,dc=test",groups:[]};
 const product={objectId:"33333333-3333-4333-8333-333333333333",cn:"Product",dn:"CN=Product,DC=example,DC=test"};
 let roomCreatorMember=true;
 const people=[{...ADMIN,displayName:"Example Administrator",groups:[]},alex,jo];
 const plan={name:"Example Hub",webOrigin:origin,memberOrigin:`https://hub.example.test:${memberPort}`,webListen:{host:"127.0.0.1",port:webPort},memberListen:{host:"127.0.0.1",port:memberPort},webTls:{certFile:certs.cert,keyFile:certs.key},directory:{realm:"corp",url:"ldaps://directory.example.test",baseDn:"dc=example,dc=test",bindDn:"cn=reader,dc=example,dc=test",profile:"openldap"},bindPasswordRef:"file:hub/secrets/directory-bind",administrator:ADMIN.key,retention:{contentDays:30,eventDays:180},coexistence:"dedicated"};
 const init=createHubInitializer({home,identity:hubIdentityProvider(),probe:{pidAlive:()=>false}}),confirmation=await init.prepareConfirmation(plan,{bindPassword:"Synthetic-bind-password-only"});await init.commit(plan,confirmation.reference);
 const config=yaml.load(readFileSync(join(home,"fleet.yaml"),"utf8"));
 runtime=new HubRuntime({home,readConfig:()=>config,log:(level:string,message:string,meta:any)=>{receipt.runtimeLog??=[];receipt.runtimeLog.push({level,message,meta});},createDirectory:()=>({realm:"corp",groupPolicy:"ad-direct-guid",close:async()=>{},signIn:async(login:string,password:string)=>{const p=people.find(p=>p.login===login);return p&&password==="Synthetic-browser-only"?{ok:true,person:p}:{ok:false,reason:"invalid-credentials"};},checkEligibility:async(key:any)=>{const p=people.find(p=>p.key.objectId===key.objectId&&p.key.realm===key.realm);return p?{eligible:true,person:p}:{eligible:false,reason:"disabled"};},searchGrantPeople:async(q:string)=>({ok:true,people:[alex,jo].filter(p=>p.displayName.toLowerCase().includes(q.toLowerCase())).map(p=>({person:p.key,displayName:p.displayName,login:p.login})),truncated:false}),searchPolicyGroups:async()=>({ok:true,groups:[product],truncated:false}),resolvePolicyGroup:async(dn:string)=>({ok:true,group:{key:{realm:"corp",objectId:product.objectId},dn}}),readPolicyGroups:async(key:any)=>({kind:"complete",person:key,groups:roomCreatorMember&&key.objectId===alex.key.objectId?[product.objectId]:[],observedAt:Date.now()})})});
 await runtime.apply(config);check("production Hub ready",runtime.serverHealth(config.hub)==="ready");
 const pw=createRequire(join(process.env.PW_DIR??process.cwd(),"package.json"))("playwright-core");
 browser=await pw.chromium.launch({headless:true,...(process.env.CHROMIUM?{executablePath:process.env.CHROMIUM}:{}),args:["--no-sandbox","--host-resolver-rules=MAP hub.example.test 127.0.0.1"]});receipt.browser=browser.version();
 const seedContext=await browser.newContext({ignoreHTTPSErrors:true});
 await seedContext.addInitScript("window.__name=fn=>fn;");
 const seed=await seedContext.newPage();await seed.goto(origin+"/ui/hub/admin?view=roles");
 await seed.locator("#hubLogin").fill(ADMIN.login);await seed.locator("#hubPassword").fill("Synthetic-browser-only");await seed.locator("#hubPassword").press("Enter");await seed.locator(".hub-role-list").first().waitFor();
 await seed.evaluate(async({product}:any)=>{
  const session=await(await fetch("/hub/v1/session")).json();
  const request=async(path:string,body?:any)=>{const r=await fetch("/hub/v1/roles"+path,{method:body===undefined?"GET":"POST",headers:body===undefined?{}:{"Content-Type":"application/json","X-AgEnD-Hub-CSRF":session.csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});const out=await r.json();if(!r.ok||out.ok===false)throw Error(path+" "+out.code);return out;};
  await request("/search?kind=person&q=Example");const {view}=await request("");view.policy.rolesActive=true;
  view.policy.roles.push({id:"custom:room-creators",kind:"custom",name:"Example room creators",description:"Start group rooms for shared work.",permissions:["rooms.create"],defaultMaxFleets:0});
  view.policy.assignments.push({id:"example-creator",roleId:"custom:room-creators",subject:{kind:"group",group:{realm:"corp",objectId:product.objectId},dn:product.dn},scope:{kind:"hub"},startsAt:0,expiresAt:null,maxFleets:null,assignedBy:view.actor,assignedAt:0});
  const preview=await request("/preview",{policy:view.policy});await request("/apply",{policy:view.policy,previewDigest:preview.previewDigest});
 },{product});
 check("real HTTP saves a custom creation role and eligible AD-group assignment",true);
 const memberContext=await browser.newContext({ignoreHTTPSErrors:true});await memberContext.addInitScript("window.__name=fn=>fn;");
 const member=await memberContext.newPage();await member.goto(origin+"/ui/hub");await member.locator("#hubLogin").fill(alex.login);await member.locator("#hubPassword").fill("Synthetic-browser-only");await member.locator("#hubPassword").press("Enter");await member.locator("#hubLogin").waitFor({state:"detached"});
 const memberCall=async(path:string,body?:any)=>member.evaluate(async({path,body}:any)=>{const session=await(await fetch("/hub/v1/session")).json();const response=await fetch(path,{method:body===undefined?"GET":"POST",headers:body===undefined?{}:{"Content-Type":"application/json","X-AgEnD-Hub-CSRF":session.csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};},{path,body});
 const made=await memberCall("/hub/v1/rooms",{name:"Example project room"});check("real HTTP AD-group member creates a room",made.status===200&&!!made.body.room?.id);
 roomCreatorMember=false;const refused=await memberCall("/hub/v1/rooms",{name:"No longer a creator"});check("fresh AD membership removal refuses new creation",refused.status===403);
 const kept=await memberCall("/hub/v1/rooms/"+made.body.room.id);check("AD membership removal preserves existing room manager",kept.status===200&&kept.body.me?.role==="manager");
 roomCreatorMember=true;await memberContext.close();
 await seedContext.close();
 for(const device of ["desk","phone"])for(const lang of ["en","zh-TW"]){
  const tag=`${device}-dark-${lang}`,zh=lang==="zh-TW",context=await browser.newContext({ignoreHTTPSErrors:true,viewport:device==="phone"?{width:390,height:844}:{width:1366,height:1000},isMobile:device==="phone",hasTouch:device==="phone",locale:lang});
  try{
   await context.addInitScript("window.__name=fn=>fn;");
   await context.addInitScript(({lang}:any)=>{localStorage.setItem("agend_theme","dark");localStorage.setItem("agend_lang",lang);localStorage.setItem("agend_tour_done","1");localStorage.setItem("agend_firstrun_dismissed","1");},{lang});
   const page=await context.newPage();page.on("pageerror",(error:any)=>receipt.errors.push({tag,error:error.message}));
   await context.route("**/*",(route:any)=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
   await page.goto(origin+"/ui/hub/admin?view=roles");await page.locator("#hubLogin").fill(ADMIN.login);await page.locator("#hubPassword").fill("Synthetic-browser-only");await page.locator("#hubPassword").press("Enter");await page.locator(".hub-role-list").first().waitFor();
   await page.getByRole("button",{name:"Example room creators",exact:true}).click();
   await page.getByRole("tab",{name:new RegExp("^"+(zh?"權限":"Permissions"))}).click();
   const row=page.locator(".hub-role-permission").filter({has:page.locator("strong",{hasText:zh?"開房間":"Create rooms"})});
   const section=row.locator("xpath=ancestor::details[1]");if(!await section.evaluate((el:any)=>el.open))await section.locator(":scope > summary").click();
   await row.scrollIntoViewIfNeeded();check(tag+" granted role row",(await row.innerText()).includes("✓"));
   await page.evaluate(()=>document.fonts.ready);
   const capture=async(stage:string)=>{check(tag+" "+stage+" no horizontal overflow",await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth<=1));const file=`${tag}-${stage}.png`;await page.screenshot({path:join(out,file),fullPage:true});receipt.screens.push({file,sha256:hash(readFileSync(join(out,file)))});};
   await capture("role");
   await page.goto(origin+"/ui/hub/admin?view=manage");await page.locator(".hub-admin-creators").waitFor();await page.locator(".hub-admin-creators").scrollIntoViewIfNeeded();
   check(tag+" Administration explains independent role grants",(await page.locator(".hub-admin-creators").innerText()).includes(zh?"開房間」權限":"Create rooms role permission"));
   check(tag+" list and role grants remain independent",(await page.locator(".hub-admin-creators").innerText()).includes(zh?"不會移除他的角色授權":"does not remove their role grant"));
   await capture("creators");
  }finally{await context.close();}
 }
 check("no page errors",receipt.errors.length===0);
 receipt.bindings=Object.fromEntries(["src/hub/roles/model.ts","src/hub/roles/authority.ts","src/hub/roles/delegation.ts","src/hub/compose/server.ts","src/hub/http/deps.ts","src/hub/roles/admin-control.ts","src/hub/roles/review.ts","src/hub/rooms/admin.ts","src/hub/rooms/service.ts","src/ui/hub-roles.js","src/ui/hub-role-view.js","src/ui/hub-roles-strings.js","src/ui/hub-admin-rooms.js","src/ui/hub-admin-rooms-strings.js","src/ui/hub-room-strings.js","scripts/manual/hub-room-create-role-s256/browser.mts"].map(file=>[file,hash(readFileSync(join(repo,file)))]));
}finally{
 writeFileSync(join(out,"report.json"),JSON.stringify(receipt,null,2));await browser?.close();await runtime?.close?.();if(certs)rmSync(certs.dir,{recursive:true,force:true});rmSync(home,{recursive:true,force:true});
}
