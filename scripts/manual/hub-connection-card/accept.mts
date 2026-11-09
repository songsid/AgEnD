/** S-119 Story4: real Fleet Settings + sealed Hub + production AD driver over owned recorded LDAPS.
 * No API reply stubs, daemon/model/native/CLI invocation, real account or directory. Exact fixtures only.
 */
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import yaml from "js-yaml";
const repo=resolve(process.env.REPO??process.cwd()),out=resolve(process.env.OUT??join(repo,".artifacts/connection-card"));mkdirSync(out,{recursive:true});
const before=process.env.BEFORE==="1",skew=process.env.SKEW??"",base="a32b177df",candidate=process.env.CANDIDATE??repo;
if(skew&&!["old-section","old-membership","old-company","old-manual","old-server"].includes(skew))throw Error("unknown skew");
const scratch=mkdtempSync(join(out,"owned-")),bin=join(scratch,"bin");mkdirSync(bin,{mode:0o700});
process.env.AGEND_HOME=join(scratch,"home");mkdirSync(process.env.AGEND_HOME,{mode:0o700});
for(const key of ["OPENAI_API_KEY","ANTHROPIC_API_KEY","DISCORD_BOT_TOKEN","TELEGRAM_BOT_TOKEN"])delete process.env[key];
for(const command of ["tmux","agend","claude","codex","kiro-cli"]){const file=join(bin,command);writeFileSync(file,`#!${process.execPath}\nprocess.exit(97)\n`);chmodSync(file,0o755);}
process.env.AGEND_TMUX_BIN=join(bin,"tmux");process.env.PATH=[bin,dirname(process.execPath),"/usr/bin","/bin"].join(":");
const require=createRequire(import.meta.url),tls=require("node:tls"),connect=tls.connect,host="dashboard.lan.example";let dcPort=0;
tls.connect=(options:any,...args:any[])=>connect({...options,...(options.host==="127.0.0.1"&&options.port===636?{port:dcPort}:{}),...(options.host===host?{host:"127.0.0.1"}:{})},...args);syncBuiltinESMExports();
const {companyJoinRig}=await import(repo+"/tests/support/hub-company-join-rig.ts"),{CompanyJoinClient}=await import(repo+"/src/hub/join/client.ts");
const {bootFixture,matrix,VIEWPORTS,caseName}=await import(repo+"/scripts/manual/smoke-fixture/index.mts");
const r=await companyJoinRig((port:number)=>{dcPort=port;},{host}),admin=await r.signIn("alice");await r.enable(admin,8);
// Fixture policy set through the actual guarded preview/apply API: the dummy department may pair and publish.
const readPolicy=await r.call(admin,"GET","/hub/v1/admin/group-policy"),policy=readPolicy.body.policy;
policy.groups[0].allow=["pair_fleet","publish_agents","ask_agents"];
const preview=await r.call(admin,"POST","/hub/v1/admin/group-policy/preview",{policy});if(preview.status!==200)throw Error("fixture preview");
if((await r.call(admin,"PUT","/hub/v1/admin/group-policy",{policy,previewDigest:preview.body.previewDigest})).status!==200)throw Error("fixture policy apply");
const enabled=await r.call(admin,"PUT","/hub/v1/admin/company-join",{enabled:true,expectedRevision:1});if(enabled.status!==200)throw Error("fixture joining");
const result:any={before,skew,base,checks:[],cases:[],shots:[],errors:[],cleaned:false,limits:"Owned fake LDAPS and sealed Hub; real cookie/CSRF/Settings/transport/publish paths. No API reply substitution. Lifecycle/model/CLI blocked; no question sent to an agent."};
const check=(name:string,value:any,detail?:unknown)=>{result.checks.push({name,ok:!!value,...(!value?{detail}:{})});if(!value)throw Error(name+" "+JSON.stringify(detail??""));};
const paint=async(p:any)=>p.evaluate(async()=>{await document.fonts.ready;await new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())));});
const geometry=async(p:any)=>p.locator(".s-hub-connection").evaluate((card:HTMLElement)=>({overflow:document.documentElement.scrollWidth>innerWidth+1,bad:[...card.querySelectorAll("button,a.btn,input,summary")].filter((el:any)=>!el.disabled&&el.getClientRects().length&&el.offsetParent!==null).map((el:any)=>{const e=el.matches("input[type=checkbox]")&&el.labels?.length?el.labels[0]:el,b=e.getBoundingClientRect();return {text:el.textContent,id:el.id,w:b.width,h:b.height};}).filter(b=>Math.min(b.w,b.h)<43.5)}));
let fx:any=null;
try{
 for(const [index,c]of matrix().entries()){
  const tag=caseName(c),zh=c.lang==="zh-TW",login="connection-person-"+index;
  r.people.push({id:randomUUID(),login,dn:`CN=${login},DC=example,DC=test`,password:"Dummy-"+login,groups:["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]});
  fx=await bootFixture({port:Number(process.env.HP??54820),instances:1,classic:false});const fm=fx.fm;
  let lifecycle=0;for(const method of ["startInstance","startInstanceUnattended","restartInstance","restartFleet","stopInstance"])fm[method]=async()=>{lifecycle++;throw Error("No native lifecycle");};
  const cfg=join(fx.dir,"fleet.yaml"),raw:any=yaml.load(readFileSync(cfg,"utf8"));
  if(index%2)raw.channels=[{id:"tg",type:"telegram",mode:"topic",bot_token_env:"DUMMY_TELEGRAM_TOKEN",group_id:"-1001234567890",access:{mode:"locked",allowed_users:["1234"]}}];
  if(skew==="old-manual")raw.hub_member={enabled:true};writeFileSync(cfg,yaml.dump(raw));fm.loadConfig(cfg);fm.hubEffectsReady=true;await fm.applyHubSwitches();
  const controller:any=await fm.hubCompanyJoin();controller.client=new CompanyJoinClient({ca:readFileSync(r.certs.caCert),lookup:(_h:any,o:any,cb:any)=>o.all?cb(null,[{address:"127.0.0.1",family:4}]):cb(null,"127.0.0.1",4)});
  fm.webPrefs.write("operator",new Map([["theme",c.theme],["lang",c.lang]]));
  const ctx=await fx.browser.newContext({viewport:VIEWPORTS[c.device],isMobile:c.device==="phone",hasTouch:c.device==="phone",colorScheme:c.theme,ignoreHTTPSErrors:true});
  await ctx.addInitScript({content:`window.__name=fn=>fn;try{localStorage.setItem('agend_lang',${JSON.stringify(c.lang)});localStorage.setItem('agend_theme',${JSON.stringify(c.theme)});localStorage.setItem('agend_tour_done','1');localStorage.setItem('agend_firstrun_dismissed','1');}catch{}window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective));`});
  const oldFile=skew==="old-section"?"settings-hub-section.js":skew==="old-membership"?"settings-hub-membership.js":skew==="old-company"?"settings-hub-company-join.js":skew==="old-manual"?"settings-hub.js":null;
  const network:any[]=[];
  await ctx.route("**/*",(route:any)=>{const u=new URL(route.request().url());if(![fx.base,r.webOrigin].includes(u.origin))return route.abort();
   if(oldFile&&u.pathname.endsWith("/"+oldFile))return route.fulfill({contentType:"text/javascript",body:execFileSync("git",["show",base+":src/ui/"+oldFile],{cwd:candidate,encoding:"utf8"})});
   if(skew==="old-server"&&(u.pathname.startsWith("/ui/js/")||u.pathname.startsWith("/assets/"))){const file=join(candidate,"src/ui",u.pathname.startsWith("/assets/")?"shared":"",u.pathname.split("/").pop()!);if(existsSync(file))return route.fulfill({path:file,contentType:file.endsWith(".css")?"text/css":"application/javascript"});}
   return route.continue();});
  const page=await ctx.newPage();ctx.on("page",(p:any)=>p.on("pageerror",(e:Error)=>result.errors.push({tag,text:e.message})));page.on("pageerror",(e:Error)=>result.errors.push({tag,text:e.message}));page.on("request",(q:any)=>{if(q.url().includes("/api/")&&q.method()!=="GET")network.push({path:new URL(q.url()).pathname,method:q.method()});});
  const shot=async(label:string)=>{if(!before&&!skew&&["unconnected","connected","paused-reloaded","resumed"].includes(label))await page.locator("#hub-connection").evaluate((el:any)=>{for(let p=el.parentElement;p;p=p.parentElement)if(p.scrollHeight>p.clientHeight&&["auto","scroll"].includes(getComputedStyle(p).overflowY)){p.scrollTop+=el.getBoundingClientRect().top-p.getBoundingClientRect().top;break;}});await paint(page);await page.screenshot({path:join(out,tag+"-"+label+".png"),fullPage:true});result.shots.push(tag+"-"+label+".png");};
  try{
   const code=await(await ctx.request.post(fx.base+"/auth/issue-code",{headers:{"X-Agend-Token":fm.webToken,Origin:fx.base}})).json();
   await page.goto(fx.base+"/signin");await page.fill("#code",code.code);await page.click("#go");await page.waitForURL(fx.base+"/ui");await page.goto(fx.base+"/settings/hub");
   const initial=await ctx.request.get(fx.base+"/api/settings/hub/membership?v=2");(result.initialReads??=[]).push({tag,status:initial.status(),text:await initial.text()});
   if(skew){await page.locator("#hub-membership").waitFor();check(tag+" retained UI after skew",await page.locator("#hub-connection").count()===0);check(tag+" skew never writes",network.length===0,network);await shot("skew-"+skew);result.cases.push({tag,ok:true});continue;}
   await page.locator("#hubCompanyAddress").waitFor();
   if(!before){check(tag+" single frame",await page.locator("#hub-connection").count()===1&&await page.locator("#hub-connection section.card,#hub-membership").count()===0);check(tag+" no startup effect",network.length===0,network);}
   await shot("unconnected");
   await page.locator("#hubCompanyAddress").fill(enabled.body.companyLink);await page.locator("#hubCompanyFleetName").fill("Example Fleet "+index);
   const startResponse=page.waitForResponse((q:any)=>new URL(q.url()).pathname.endsWith("/company-join/start")&&q.request().method()==="POST"),popup=ctx.waitForEvent("page");await page.locator(".s-company-join button[type=submit]").click();const hub=await popup,start=await startResponse,body=await start.json();(result.starts??=[]).push({tag,status:start.status(),result:body.result,pending:body.pending_change?.state});
   // Confirm only through the shared exact-id card if this genuine local session is asked for it.
   if(body.result==="pending_confirmation"&&body.pending_change?.state==="pending"){await page.locator(".pending-card[data-pending=\""+body.pending_change.id+"\"]").getByRole("button",{name:zh?"立即套用":"Apply now",exact:true}).click();}
   await hub.waitForURL(r.webOrigin+"/ui/hub?join=*");await hub.locator("#hubLogin").fill(login);await hub.locator("#hubPassword").fill("Dummy-"+login);
   await hub.getByRole("button",{name:zh?"登入並連接 Fleet":"Sign in and connect Fleet",exact:true}).click();
   await page.locator(before?".hub-paired":'#hub-connection[data-state="connected"]').waitFor({timeout:30000});check(tag+" actual ready link",fm.hubMemberLink==="online");
   await page.locator(".hub-exposures").waitFor();await shot("connected");
   check(tag+" no automatic sharing",fm.hubMemberExposures().list().every((row:any)=>row.state!=="published"));
   if(!before){const g=await geometry(page);check(tag+" no overflow",!g.overflow,g);if(c.device==="phone")check(tag+" phone tap",g.bad.length===0,g.bad);}
   const savedProfile=readFileSync(join(fm.dataDir,"hub-member/state.json"));
   // Normal configured inert Agent; publishing is real local consent, never starts or addresses its process.
   const share=page.locator(".hub-exposure-main input").first();await share.click();
   const pending=page.locator(".pending-card[data-pending]").getByRole("button",{name:zh?"立即套用":"Apply now",exact:true});await Promise.race([page.waitForFunction(()=>!!(document.querySelector(".hub-exposure-main input")as HTMLInputElement)?.checked),pending.waitFor()]);if(await pending.isVisible())await pending.click();
   await share.waitFor();await page.waitForFunction(()=>!!(document.querySelector(".hub-exposure-main input")as HTMLInputElement)?.checked);
   check(tag+" explicit share saved",fm.hubMemberExposures().list().some((row:any)=>row.state==="published"));await share.scrollIntoViewIfNeeded();await shot("agents-chosen");
   if(before){await page.locator("#hubMemberEnabled").click();}else await page.getByRole("button",{name:zh?"暫停連接":"Pause connection",exact:true}).click();
   await page.waitForFunction(()=>document.querySelector("#hubMemberEnabled")?(document.querySelector("#hubMemberEnabled")as HTMLInputElement).checked===false:document.querySelector('#hub-connection[data-state="paused"]')!==null);
   await page.reload();await page.locator(before?"#hubMemberEnabled":'#hub-connection[data-state="paused"]').waitFor();await shot("paused-reloaded");
   check(tag+" pause retained profile",readFileSync(join(fm.dataDir,"hub-member/state.json")).equals(savedProfile));check(tag+" no active member after pause",fm.hubMemberPairing()===null);
   if(!before){check(tag+" retained summary",await page.locator(".hub-connection-summary").count()===1);await page.getByRole("button",{name:zh?"恢復連接":"Resume connection",exact:true}).click();
    const confirm=page.locator(".pending-card[data-pending]").getByRole("button",{name:zh?"立即套用":"Apply now",exact:true});await Promise.race([page.locator('#hub-connection[data-state="connected"]').waitFor(),confirm.waitFor()]);if(await confirm.isVisible())await confirm.click();
    await page.locator('#hub-connection[data-state="connected"]').waitFor({timeout:30000});check(tag+" resume preserved chosen Agents",fm.hubMemberExposures().list().some((row:any)=>row.state==="published"));await shot("resumed");}
   check(tag+" no native lifecycle",lifecycle===0);check(tag+" no CSP",(await page.evaluate(()=>((window as any).__csp??[]))).length===0);result.cases.push({tag,ok:true});
  }catch(error){await shot("FAIL");throw error;}
  finally{await ctx.close();controller.close();fm.hubRuntime?.fence();await fm.hubRuntime?.close();fm.hubEffectsReady=false;await fx.close();fx=null;}
 }
 check("nonempty selection",result.cases.length===matrix().length&&result.cases.length>0);check("no script errors",result.errors.length===0,result.errors);result.status="PASS";
}catch(error:any){result.status="FAIL";result.error=error.stack;throw error;}
finally{if(fx){fx.fm.companyJoinController?.close();fx.fm.hubRuntime?.fence();await fx.fm.hubRuntime?.close();fx.fm.hubEffectsReady=false;await fx.close();}await r.close();tls.connect=connect;syncBuiltinESMExports();rmSync(scratch,{recursive:true,force:true});result.cleaned=true;writeFileSync(join(out,"receipt.json"),JSON.stringify(result,null,2));}
console.log(JSON.stringify({status:result.status,cases:result.cases.length,checks:result.checks.length,cleaned:result.cleaned}));process.exit(0);
