/** Isolated product shell + real Hub HTTP/SQL/audit. Runtime inventory/execution are inert. Linux headless only. */
import {createServer} from "node:https";
import {createRequire} from "node:module";
import {execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {s3bRig} from "../../../tests/helpers/hub-s3b-rig.js";
import {runtimeUpdateTlsFixture} from "../../../tests/support/runtime-update-tls.js";
import {RuntimeCoordinator} from "../../../src/runtime-coordinator.js";
import {readRuntimeInfo} from "../../../src/runtime-build-info.js";
import {HubPersonalOwnerHost} from "../../../src/hub/personal/owner-host.js";
import {HubPersonalTurns} from "../../../src/hub/personal/turns.js";
import {createHubTeams,HUB_TEAMS_MIGRATION,HUB_TEAM_MANAGEMENT_MIGRATION,HUB_TEAM_GRANTS_MIGRATION} from "../../../src/hub/teams/index.js";
import {personKeyString} from "../../../src/hub/identity.js";
if(process.platform!=="linux")throw Error("This walk runs headless inside Linux/WSL only");
const phase=process.env.PHASE??"before";
const out=resolve(process.env.OUT??`.artifacts/m3262/${phase}`);mkdirSync(out,{recursive:true});
const privateHome=mkdtempSync(join(out,"private-")),runtime=new RuntimeCoordinator(privateHome),tasks=new Map<string,any>();let reported:any=null,turns!:HubPersonalTurns;
const machine=runtime.machine.bind(runtime);runtime.machine=id=>reported?.id===id?structuredClone(reported):machine(id);
runtime.task=id=>tasks.get(id)??null;
runtime.call=async(_id,operation,payload:any)=>{if(operation==="run"){const task={id:payload.task.requestId,cli:payload.task.cli,cwd:payload.task.cwd,sandbox:"read-only",status:"running",startedAt:Date.now(),output:""};tasks.set(task.id,task);return task;}return reported?.inventory??{};};
let rig:Awaited<ReturnType<typeof s3bRig>>|undefined;
const server=createServer(runtimeUpdateTlsFixture(),(req,res)=>{if(!rig?.http.handle(req,res))res.writeHead(404).end();});
await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const origin=`https://127.0.0.1:${(server.address() as {port:number}).port}`;
rig=await s3bRig({realAudit:true,webOrigin:origin});const r=rig;
for(const migration of [HUB_TEAMS_MIGRATION,HUB_TEAM_MANAGEMENT_MIGRATION,HUB_TEAM_GRANTS_MIGRATION])migration.up(r.db);
r.httpDeps.teams=core=>createHubTeams(core);
r.httpDeps.personalAgents=core=>{const owner=new HubPersonalOwnerHost(core,runtime);turns=new HubPersonalTurns(core,runtime,owner);return {owner,turns};};
r.httpDeps.personalInstaller=()=>({version:"2.4.0-fixture",scriptSha256:"a".repeat(64),scriptBytes:1,bundleSha256:"b".repeat(64)});
const owners=[r.addPerson("alex","Alex"),r.addPerson("wang","王經理")];
r.directory.searchGrantPeople=async q=>({ok:true,truncated:false,people:owners.filter((_,i)=>["Alex","王經理"][i]!.toLowerCase().includes(q.toLowerCase())).map((person,i)=>({person,login:personKeyString(person)===personKeyString(owners[0]!)?"alex":"wang",displayName:personKeyString(person)===personKeyString(owners[0]!)?"Alex":"王經理"}))});
await r.restartHttp();const admin=await r.signIn("admin");
const pw=createRequire(resolve(process.env.PW_DIR??".artifacts/browser-tools","package.json"))("playwright");
let browser:any;
const receipt:any={sourceCommit:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),phase,scope:"M3262; Headless WSL; real product shell/HTTP/SQL/audit; inert directory and Runtime inventory/turn; no Windows process/auth/provider/installer execution. Command token masked only in screenshot.",checks:[],pictures:[]};
const check=(name:string,ok:unknown)=>{receipt.checks.push({name,pass:!!ok});if(!ok)throw Error(name);};
const until=async(fn:()=>boolean)=>{const deadline=Date.now()+5000;while(!fn()){if(Date.now()>=deadline)throw Error("State wait expired");await new Promise(resolve=>setTimeout(resolve,25));}};
try{
 browser=await pw.chromium.launch({headless:true,args:["--no-sandbox"]});
 for(const [index,[device,language,theme]] of [["desktop","en","light"],["phone","zh-TW","dark"]].entries()){
  const login=index?"wang":"alex",person=owners[index]!,tag=`${device}-${language}-${theme}`,cookieOwner=await r.signIn(login);
  await r.call(admin,"PUT","/hub/v1/admin/personal-agents",{enabled:false,people:[],teams:[]});
  const ctx=await browser.newContext({viewport:device==="phone"?{width:390,height:844}:{width:1366,height:900},locale:language,colorScheme:theme,ignoreHTTPSErrors:true});
  await ctx.addInitScript(({language,theme}:any)=>{localStorage.setItem("agend_lang",language);localStorage.setItem("agend_theme",theme);localStorage.setItem("agend_tour_done","1");localStorage.setItem("agend_firstrun_dismissed","1");},{language,theme});
  await ctx.route("**/*",(route:any)=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await ctx.addInitScript(()=>{Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async(text:string)=>{(window as any).__copied=text;}}});});
  await ctx.addInitScript(()=>{const scroll=Element.prototype.scrollIntoView;Element.prototype.scrollIntoView=function(...args:any[]){if(this.id==="hub-personal-agents")(window as any).__personalScroll=((window as any).__personalScroll??0)+1;return scroll.apply(this,args);};});
  const p=await ctx.newPage(),errors:string[]=[];p.on("pageerror",(error:Error)=>errors.push(error.message));
  const sign=async(cookie:string)=>{const i=cookie.indexOf("=");await ctx.clearCookies();await ctx.addCookies([{name:cookie.slice(0,i),value:cookie.slice(i+1),url:origin,httpOnly:true,secure:true,sameSite:"Strict"}]);};
  const shot=async(name:string,selector:string)=>{
   if(!["disabled-admin","disabled-member","setup","install","ready","working","offline"].includes(name))return;
   const card=p.locator(selector),viewport=p.viewportSize();
   // Preserve responsive width; expand height only to capture the full card inside the shell's scroll container.
   const bounds=await card.boundingBox();await p.setViewportSize({...viewport,height:Math.max(viewport.height,Math.ceil(bounds.height)+180)});
   await card.scrollIntoViewIfNeeded();check(`${tag}/${name}/fits`,await card.evaluate((el:HTMLElement)=>el.scrollWidth<=el.clientWidth+1));
   const codes=card.locator("pre code"),originals=await codes.allTextContents();
   for(let n=0;n<originals.length;n++)await codes.nth(n).evaluate((el:HTMLElement)=>{el.textContent=el.textContent!.replace(/agend_enroll_[A-Za-z0-9_-]+/g,"[private one-time token]");});
   check(`${tag}/${name}/no-token`,!(/agend_enroll_[A-Za-z0-9_-]{43}/.test(await card.textContent())));
   const file=`${tag}-${name}.png`;await card.screenshot({path:join(out,file)});receipt.pictures.push(file);
   for(let n=0;n<originals.length;n++)await codes.nth(n).evaluate((el:HTMLElement,text:string)=>{el.textContent=text;},originals[n]);
   await p.setViewportSize(viewport);
  };
  const openMine=async(cookie:string)=>{await sign(cookie);const response=p.waitForResponse((res:any)=>res.url().endsWith("/hub/v1/me/personal-agent")&&res.request().method()==="GET");await p.goto(origin+"/ui/hub/exposures");await response;};
  await openMine(admin.cookie);await p.getByText(phase==="before"?(index?"這個 Hub 尚未啟用個人 Agent。":"Personal agents are not enabled on this Hub."):(index?'這個 Hub 還沒有開啟個人 Agent。請到「管理 → 管理項目 → 個人 Agent」開啟「允許個人 Agent」。':'Personal agents are turned off on this Hub. Turn on "Allow personal agents" in Administration → Manage → Personal agents.'),{exact:true}).waitFor();await shot("disabled-admin","[data-personal-agent]");
  if(phase!=="before"){await p.getByRole("link",{name:index?"前往管理":"Open Administration",exact:true}).click();await p.locator("#hub-personal-agents form").waitFor();await p.waitForFunction(()=>{const heading=document.querySelector("#hub-personal-agents h3"),box=heading?.getBoundingClientRect();return new URLSearchParams(location.search).get("section")==="personal-agents"&&(window as any).__personalScroll>0&&box&&box.top>=0&&box.bottom<=innerHeight;});check(`${tag}/admin-link-target`,true);}
  if(process.env.CHECK_LINK_ONLY){await ctx.close();break;}
  await openMine(cookieOwner.cookie);await p.getByText(phase==="before"?(index?"這個 Hub 尚未啟用個人 Agent。":"Personal agents are not enabled on this Hub."):(index?"這個 Hub 還沒有開啟個人 Agent，請洽 Hub 管理員。":"Personal agents are turned off on this Hub. Ask your Hub administrator."),{exact:true}).waitFor();await shot("disabled-member","[data-personal-agent]");
  await sign(admin.cookie);await p.goto(origin+"/ui/hub/admin?view=manage");await p.locator('[data-personal-admin] input[role="switch"]').waitFor();
  const adminCard=p.locator("[data-personal-admin]");await shot("admin-empty","[data-personal-admin]");await adminCard.locator('input[role="switch"]').check();await adminCard.locator('input[type="search"]').fill(index?"王經":"Al");
  await adminCard.getByRole("button",{name:index?"搜尋":"Search",exact:true}).click();await adminCard.getByRole("button",{name:index?"新增":"Add",exact:true}).click();await adminCard.locator('button[type="submit"],button:not([type])').click();
  await p.waitForFunction(expected=>document.querySelector("[data-personal-admin]")?.textContent?.includes(expected),index?"已儲存":"Saved");
  check(`${tag}/admin-allow`,(await r.call(admin,"GET","/hub/v1/admin/personal-agents")).json.people.includes(personKeyString(person)));await shot("admin","[data-personal-admin]");
  await sign(cookieOwner.cookie);await p.goto(origin+"/ui/hub/exposures");const ownerCard=p.locator("[data-personal-agent]");await ownerCard.getByRole("button",{name:phase==="before"?(index?"新增個人 Agent":"Add a personal agent"):(index?"取得安裝指令":"Get install command"),exact:true}).waitFor();
  if(phase!=="before")check(`${tag}/four-steps`,await ownerCard.locator("ol.runtime-steps > li").count()===4&&await ownerCard.locator('a[href="https://nodejs.org/"]').count()===1);
  await shot("setup","[data-personal-agent]");
  const issuedResponse=p.waitForResponse((res:any)=>res.url().endsWith("/hub/v1/me/personal-agent/enrollment")&&res.request().method()==="POST");
  await ownerCard.getByRole("button",{name:phase==="before"?(index?"新增個人 Agent":"Add a personal agent"):(index?"取得安裝指令":"Get install command"),exact:true}).click();const issued=await (await issuedResponse).json();await ownerCard.locator("pre code").waitFor();
  await shot("install","[data-personal-agent]");
  if(phase!=="before"){await ownerCard.getByRole("button",{name:index?"複製指令":"Copy command",exact:true}).click();await ownerCard.getByRole("button",{name:index?"已複製":"Copied",exact:true}).waitFor();check(`${tag}/copy-exact-command`,await p.evaluate((token:string)=>typeof (window as any).__copied==="string"&&(window as any).__copied.includes(token),issued.token));}
 await ownerCard.locator("details summary").click();await shot("install-help","[data-personal-agent]");await ownerCard.locator("details summary").click();
  const joined=runtime.enroll({token:issued.token,fingerprint:issued.fingerprint,name:index?"王經理的電腦":"Alex's computer",platform:"win32"});
  reported={...machine(joined.machineId),status:"online",runtimeInfo:{...readRuntimeInfo(),capabilities:["exec","personal-agent-v1"]},inventory:{home:"C:\\Users\\colleague",personalFolder:"C:\\Users\\colleague\\Hub agent",probedAt:Date.now(),clis:[
   {id:"codex",path:"C:\\codex.exe",version:"fixture",runnable:true,authenticated:true,personalStatus:"sandbox-unavailable",supports:{execution:true,resume:false,model:true,mcp:false},readOnlySupport:false,permissionNote:"",models:[]},
   {id:"claude-code",path:"C:\\claude.exe",version:"fixture",runnable:true,authenticated:true,personalStatus:"ready",supports:{execution:true,resume:false,model:true,mcp:false},readOnlySupport:true,permissionNote:"",models:[]}]}};
  await ownerCard.getByRole("button",{name:index?"重新整理":"Refresh",exact:true}).click();await ownerCard.locator("form").waitFor();await ownerCard.locator("form input").nth(0).fill(index?"王經理的筆記":"Personal notes");await ownerCard.locator("form input").nth(1).fill(index?"Hub agent 資料夾中的工作筆記":"Notes from the Hub agent folder");await ownerCard.locator("form select").nth(0).selectOption("claude-code");
  check(`${tag}/eligible-options`,JSON.stringify(await ownerCard.locator("form select").nth(0).locator("option").evaluateAll((options:HTMLOptionElement[])=>options.map(option=>option.value)))===JSON.stringify(["","claude-code"]));
  if(phase!=="before")check(`${tag}/finished-steps-gone`,await ownerCard.locator("ol.runtime-steps,pre").count()===0);
  const savedResponse=p.waitForResponse((res:any)=>res.url().endsWith("/hub/v1/me/personal-agent")&&res.request().method()==="PUT");await ownerCard.locator("form button").click();const publication=await (await savedResponse).json();check(`${tag}/published`,publication.exposure.kind==="personal");await ownerCard.getByRole("link",{name:index?"選擇誰可以問":"Choose who may ask",exact:true}).waitFor();await shot("ready","[data-personal-agent]");
  const g=await r.call(cookieOwner,"POST","/hub/v1/grants",{exposureId:publication.exposure.id,exposureRevision:1,login:"admin",days:1});const room=await r.call(admin,"POST","/hub/v1/rooms",{exposureId:publication.exposure.id,grantId:g.json.grant.id});
  await r.call(admin,"POST",`/hub/v1/rooms/${room.json.room.id}/messages`,{text:"Read the shared notes",idempotencyKey:crypto.randomUUID()});await until(()=>[...tasks.values()].some(t=>t.status==="running"));await ownerCard.getByRole("button",{name:index?"重新整理":"Refresh",exact:true}).click();await p.waitForFunction(expected=>document.querySelector("[data-personal-agent] .tag")?.textContent===expected,index?"處理中":"Working");await shot("working","[data-personal-agent]");
  const running=[...tasks.values()].find(t=>t.status==="running");tasks.set(running.id,{...running,status:"completed",finishedAt:Date.now(),outcomeConfirmed:true,answer:"The final inert note answer."});turns.wake();await until(()=>(r.db.prepare("SELECT state FROM hub_personal_jobs WHERE id=?").get(running.id) as {state:string}).state==="answered");
  reported.status="offline";await ownerCard.getByRole("button",{name:index?"重新整理":"Refresh",exact:true}).click();await p.waitForFunction(expected=>document.querySelector("[data-personal-agent] .tag")?.textContent===expected,index?"上線時回答":"Answers when connected");await shot("offline","[data-personal-agent]");
  check(`${tag}/no-page-errors`,errors.length===0);await ctx.close();
 }
 check("checked-screens",receipt.pictures.length===(process.env.CHECK_LINK_ONLY?1:14)&&receipt.checks.length>0);
 writeFileSync(join(out,"receipt.json"),JSON.stringify(receipt,null,2)+"\n");console.log(JSON.stringify({checks:receipt.checks.length,pictures:receipt.pictures.length,pass:true}));
}finally{await browser?.close();await r.close();runtime.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(privateHome,{recursive:true});}
