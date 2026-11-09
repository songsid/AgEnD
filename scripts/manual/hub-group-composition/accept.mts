// Real sealed S5/S3 HTTPS + real group control, fake directory only. No API stubs except retained-module SKEW.
// REPO=<checkout> OUT=<owned-output> PW_DIR=<private playwright install> PLAYWRIGHT_BROWSERS_PATH=<private browsers> npx tsx scripts/manual/hub-group-composition/accept.mts
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, chmodSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import yaml from "js-yaml";
const regression=process.env.REGRESSION??"";
const repo=process.env.REPO!,out=process.env.OUT!,oldRef=process.env.OLD_REF??"ae9c91e255e3e1e459e108ea8944bff795786076";
if(!repo||!out||!process.env.PW_DIR)throw Error("REPO, OUT and PW_DIR required");mkdirSync(out,{recursive:true});
const home=mkdtempSync(join(out,"private-home-"));chmodSync(home,0o700);
const {makeTestCerts,ADMIN}=await import(repo+"/tests/support/hub-init-fixtures.ts"),certs=makeTestCerts();
const {freeHubPort}=await import(repo+"/tests/helpers/hub-rig.ts");const memberPort=await freeHubPort();let webPort=await freeHubPort();while(webPort===memberPort)webPort=await freeHubPort();
const origin=`https://hub.example.test:${webPort}`,group=randomUUID(),askGroup=randomUUID(),otherGroup=randomUUID();
const makePerson=(login:string,name:string)=>({key:{realm:"corp",objectId:randomUUID()},login,displayName:name,dn:`CN=${name},DC=example,DC=test`,groups:[]});
const people=[ADMIN,makePerson("morgan","Morgan Example"),makePerson("riley","Riley Example")];
const dn="CN=Hub Members,DC=example,DC=test",askDn="CN=Hub Readers,DC=example,DC=test";
let unknown=false;const facts=new Map([[ADMIN.key.objectId,[group]],[people[1].key.objectId,[askGroup]],[people[2].key.objectId,[otherGroup]]]);
const directory={realm:"corp",groupPolicy:"ad-direct-guid",async signIn(login:string,password:string){const person=people.find(p=>p.login===login);return person&&password===`test-${login}`?{ok:true,person}:{ok:false,reason:"invalid-credentials"}},
 async checkEligibility(key:any){const person=people.find(p=>p.key.realm===key.realm&&p.key.objectId===key.objectId);return person?{eligible:true,person}:{eligible:false,reason:"disabled"}},
 async resolvePolicyGroup(value:string){return {ok:true,group:{key:{realm:"corp",objectId:value===askDn?askGroup:group},dn:value}}},
 async readPolicyGroups(person:any){return unknown?{kind:"unknown"}:{kind:"complete",person,groups:facts.get(person.objectId)??[otherGroup],observedAt:Date.now()}},async close(){}};
const {createHubInitializer}=await import(repo+"/src/hub/init/initializer.ts"),{hubIdentityProvider}=await import(repo+"/src/hub/init/identity.ts");
const plan={name:"Example Team Hub",webOrigin:origin,memberOrigin:`https://hub.example.test:${memberPort}`,webListen:{host:"127.0.0.1",port:webPort},memberListen:{host:"127.0.0.1",port:memberPort},
 webTls:{certFile:certs.cert,keyFile:certs.key},directory:{realm:"corp",url:"ldaps://directory.example.test:636",profile:"ad",baseDn:"DC=example,DC=test",bindDn:"CN=Reader,DC=example,DC=test"},
 bindPasswordRef:"file:hub/secrets/directory-bind",administrator:ADMIN.key,retention:{contentDays:7,eventDays:30},coexistence:"dedicated"};
const init=createHubInitializer({home,identity:hubIdentityProvider(),probe:{pidAlive:()=>false}}),confirmation=await init.prepareConfirmation(plan,{bindPassword:"test-bind-not-an-account"});await init.commit(plan,confirmation.reference);
const cfg=(yaml.load(readFileSync(join(home,"fleet.yaml"),"utf8"))as any).hub;
const {createHubServerFactory}=await import(repo+"/src/hub/compose/server.ts"),{S3B_HTTP_ENTRY}=await import(repo+"/src/hub/runtime.ts");
const service=await createHubServerFactory({home,components:{http:S3B_HTTP_ENTRY},createDirectory:()=>directory,report:()=>{},log:()=>{}})(cfg,()=>true);await service.start();
const pw=createRequire(process.env.PW_DIR+"/")("playwright"),browser=await pw.chromium.launch({args:["--no-sandbox","--no-proxy-server","--host-resolver-rules=MAP hub.example.test 127.0.0.1"]});
const result:any={regression,source:execFileSync("git",["-C",repo,"rev-parse","HEAD"],{encoding:"utf8"}).trim(),browser:browser.version(),boundary:"Actual sealed S5/S3 HTTPS and group control. Inert directory. No real accounts, LDAP, CLIs, native manager, pilot or deployment.",checks:[],shots:[],errors:[],csp:[],foreign:[],api:[]};
const check=(name:string,ok:any)=>{result.checks.push({name,ok:!!ok});if(!ok)throw Error(name)};
const shot=async(page:any,name:string)=>{await page.screenshot({path:join(out,name+".png"),fullPage:true});result.shots.push(name+".png")};
const cases=[{device:"desk",lang:"en",theme:"light"},{device:"desk",lang:"zh-TW",theme:"dark"},{device:"phone",lang:"en",theme:"dark"},{device:"phone",lang:"zh-TW",theme:"light"}];
async function context(c:any,oldFile?:string){const ctx=await browser.newContext({viewport:c.device==="phone"?{width:390,height:844}:{width:1366,height:900},isMobile:c.device==="phone",hasTouch:c.device==="phone",locale:c.lang==="en"?"en-US":"zh-TW",colorScheme:c.theme,ignoreHTTPSErrors:true});
 await ctx.addInitScript({content:`window.__name=fn=>fn;try{localStorage.setItem('agend_lang',${JSON.stringify(c.lang)});localStorage.setItem('agend_theme',${JSON.stringify(c.theme)});localStorage.setItem('agend_tour_done','1');localStorage.setItem('agend_firstrun_dismissed','1')}catch{};window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective));`});
 await ctx.route("**/*",(route:any)=>{const url=new URL(route.request().url());if(url.origin!==origin){result.foreign.push(url.origin);return route.abort()};
  if(regression&&url.pathname===`/ui/js/${regression==="draft"?"hub-group-policy.js":"panel-hub.js"}`){result.regressionHits=(result.regressionHits??0)+1;const file=regression==="draft"?"hub-group-policy.js":"panel-hub.js";return route.fulfill({contentType:"text/javascript",body:execFileSync("git",["-C",repo,"show",`38d198e081dd1cbb3a17c5e6acc59b3a38620647:src/ui/${file}`],{encoding:"utf8"})})}
  if(oldFile&&url.pathname===`/ui/js/${oldFile}`){result.skewHits=(result.skewHits??0)+1;return route.fulfill({contentType:"text/javascript",body:execFileSync("git",["-C",repo,"show",`${oldRef}:src/ui/${oldFile}`],{encoding:"utf8"})})}return route.continue()});
 const page=await ctx.newPage();page.on("pageerror",(e:any)=>result.errors.push(String(e)));page.on("response",(r:any)=>{if(r.url().includes("/group-policy"))result.api.push({method:r.request().method(),status:r.status()})});return {ctx,page};}
async function signin(page:any,login:string,path="/ui/hub"){await page.goto(origin+path);await page.fill("#hubLogin",login);await page.fill("#hubPassword",`test-${login}`);await page.locator(".hub-signin button[type=submit]").click()}
async function inspect(page:any,tag:string){check(tag+" no horizontal overflow",await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));result.csp.push(...await page.evaluate("window.__csp"))}
try{
 for(const [i,c]of (regression?cases.slice(0,1):cases).entries()){
  const tag=`${c.device}-${c.lang}-${c.theme}`,a=await context(c);
  try{await signin(a.page,ADMIN.login,"/ui/hub/admin");await a.page.locator('[data-entry="group-permissions"]').waitFor();await a.page.locator('[data-entry="group-permissions"] .btn').click();await a.page.locator('.hub-groups-list').waitFor();
   if(i===0){await a.page.locator('.hub-step-form input').fill(dn);await a.page.locator('.hub-step-form button').click();await a.page.locator('.hub-group-row').waitFor();
    await a.page.locator('.hub-group-row input[type=checkbox]').nth(1).check();await a.page.locator('.hub-group-row input[type=checkbox]').nth(2).check();await a.page.locator('.hub-groups-state button').click();
    await a.page.locator('.hub-step-form input').fill(askDn);await a.page.locator('.hub-step-form button').click();await a.page.locator('.hub-group-row').nth(1).waitFor();
   }else{await a.page.locator('.hub-group-row input[type=number]').first().fill(String(i%2+1))}
   await a.page.locator('.hub-groups-preview .btn-primary').waitFor();if(i===0&&regression!=="welcome")check(tag+" unsaved enable remains off",await a.page.locator('.hub-groups-state [data-pending="on"]').count()===1&&/Off|關閉/.test(await a.page.locator('.hub-groups-state h3').innerText()));await a.page.locator('.hub-groups-preview .btn-primary').scrollIntoViewIfNeeded();await shot(a.page,tag+"-confirmed-preview");await inspect(a.page,tag+" preview");
   const put=a.page.waitForResponse((r:any)=>r.url().endsWith('/hub/v1/admin/group-policy')&&r.request().method()==='PUT');await a.page.locator('.hub-groups-preview .btn-primary').click();check(tag+" actual save",(await put).status()===200);await a.page.locator('.hub-groups-preview').waitFor({state:"detached"});await shot(a.page,tag+"-saved-editor");
  }finally{await a.ctx.close()}
  for(const [login,state]of [["riley","none"],["morgan","ask"],[ADMIN.login,"full"]]){const o=await context(c);try{await signin(o.page,login);await o.page.locator('.hub-welcome-card').first().waitFor();const flags=await o.page.locator('.hub-welcome-card').evaluateAll((rows:any[])=>rows.map(x=>x.getAttribute('aria-disabled')));
    check(tag+" welcome "+state,JSON.stringify(flags)===JSON.stringify(state==="none"?["true","true"]:state==="ask"?["false","true"]:["false","false"]));if(state==="none")check(tag+" no-actions is not an error",await o.page.locator('.error-state[role="alert"]').count()===0);await inspect(o.page,tag+state);await shot(o.page,tag+"-welcome-"+state);
   }finally{await o.ctx.close()}}
 }
 for(const file of ["hub-client.js","panel-hub.js"]){const c=cases[file==="hub-client.js"?0:3],o=await context(c,file);try{await signin(o.page,ADMIN.login,"/ui/hub/admin");await o.page.locator('.hub-steps').waitFor();check("retained "+file+" hides feature",await o.page.locator('[data-entry="group-permissions"]').count()===0);await shot(o.page,"skew-"+c.device+"-"+c.lang+"-"+file.replace('.js',''));await inspect(o.page,"skew "+file)}finally{await o.ctx.close()}}
 check("real preview and apply",result.api.some((x:any)=>x.method==="POST"&&x.status===200)&&result.api.filter((x:any)=>x.method==="PUT"&&x.status===200).length===4);check("old modules exercised",result.skewHits>=2);check("no browser errors",result.errors.length===0);check("no CSP violations",result.csp.length===0);check("no foreign requests",result.foreign.length===0);result.status="PASS";
}catch(error:any){result.status="FAIL";result.error=error.stack;throw error}
finally{writeFileSync(join(out,"receipt.json"),JSON.stringify(result,null,2));await browser.close();await service.close();rmSync(home,{recursive:true,force:true});rmSync(certs.dir,{recursive:true,force:true})}
console.log(JSON.stringify({status:result.status,shots:result.shots.length,checks:result.checks.length}));
