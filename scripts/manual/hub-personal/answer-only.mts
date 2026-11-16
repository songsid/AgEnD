/** Real Hub shell/HTTP/SQL/audit, inert Runtime and directory. No Windows process or model. */
import {createServer} from "node:https";
import {createRequire} from "node:module";
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {s3bRig} from "../../../tests/helpers/hub-s3b-rig.js";
import {runtimeUpdateTlsFixture} from "../../../tests/support/runtime-update-tls.js";
import {RuntimeCoordinator} from "../../../src/runtime-coordinator.js";
import {readRuntimeInfo} from "../../../src/runtime-build-info.js";
import {HubPersonalOwnerHost} from "../../../src/hub/personal/owner-host.js";
import {HubGroupRooms} from "../../../src/hub/rooms/service.js";
import {HubPersonalTurns} from "../../../src/hub/personal/turns.js";
import {personKeyString} from "../../../src/hub/identity.js";
if(process.platform!=="linux")throw Error("Headless Linux only");
const out=resolve(process.env.OUT??".artifacts/m3257/browser"),home=mkdtempSync(join(tmpdir(),"agend-words-browser-"));mkdirSync(out,{recursive:true});
const runtime=new RuntimeCoordinator(home),machine=runtime.machine.bind(runtime);let reported:any;
runtime.machine=id=>reported?.id===id?structuredClone(reported):machine(id);
runtime.call=async(_id,op)=>{if(op==="probe")return reported?.inventory??{};throw Error("No turn is executed by this visual rig");};
let rig:Awaited<ReturnType<typeof s3bRig>>|undefined;
const server=createServer(runtimeUpdateTlsFixture(),(req,res)=>{if(!rig?.http.handle(req,res))res.writeHead(404).end();});
await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const origin=`https://127.0.0.1:${(server.address() as {port:number}).port}`;
rig=await s3bRig({realAudit:true,webOrigin:origin});const r=rig;
r.httpDeps.groupRooms=core=>new HubGroupRooms(core);
r.httpDeps.personalAgents=core=>{const owner=new HubPersonalOwnerHost(core,runtime);return {owner,turns:new HubPersonalTurns(core,runtime,owner)};};
const owners=[r.addPerson("alex","Alex"),r.addPerson("wang","王經理")];await r.restartHttp();const admin=await r.signIn("admin");
await r.call(admin,"PUT","/hub/v1/admin/personal-agents",{enabled:true,people:owners.map(personKeyString),teams:[]});
const pw=createRequire(resolve(process.env.PW_DIR!,"package.json"))("playwright");
const browser=await pw.chromium.launch({headless:true,args:["--no-sandbox"]}),receipt:any={scope:"Headless Linux only; product HTTP/SQL/audit, inert directory/Runtime; no Windows, credentials, installer, model or updater",checks:[],pictures:[]};
const check=(name:string,ok:boolean)=>{receipt.checks.push({name,pass:ok});if(!ok)throw Error(name);};
try{
 for(const [index,[language,theme,width]] of [["en","light",1366],["zh-TW","dark",390]].entries()){
  if(process.env.ONLY_LANG && process.env.ONLY_LANG!==language)continue;
  const person=owners[index]!,login=index?"wang":"alex",owner=await r.signIn(login),issued=await r.call(owner,"POST","/hub/v1/me/personal-agent/enrollment",{});
  const joined=runtime.enroll({token:issued.json.token,fingerprint:issued.json.fingerprint,name:index?"王經理的電腦":"Alex's computer",platform:"win32"});
  reported={...machine(joined.machineId),status:"online",runtimeInfo:{...readRuntimeInfo(),capabilities:["exec","personal-agent-v1","personal-agent-answer-only-v1"]},inventory:{home:"C:\\Users\\colleague",personalFolder:"C:\\Users\\colleague\\Hub agent",probedAt:Date.now(),clis:[
   {id:"codex",path:"C:\\codex.exe",version:"inert",runnable:true,authenticated:true,personalStatus:"sandbox-unavailable",answerOnlyStatus:"ready",supports:{execution:true,resume:false,model:true,mcp:false},readOnlySupport:true,permissionNote:"",models:[{id:"local-model"}]},
   {id:"claude-code",path:"C:\\claude.exe",version:"inert",runnable:true,authenticated:true,personalStatus:"ready",supports:{execution:true,resume:false,model:true,mcp:false},readOnlySupport:true,permissionNote:"",models:[]}]}};
  const context=await browser.newContext({viewport:{width,height:1000},colorScheme:theme,locale:language,ignoreHTTPSErrors:true});
  await context.addInitScript(({language,theme}:any)=>{localStorage.setItem("agend_lang",language);localStorage.setItem("agend_theme",theme);localStorage.setItem("agend_tour_done","1");localStorage.setItem("agend_firstrun_dismissed","1");},{language,theme});
  await context.route("**/*",(route:any)=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await context.newPage(),errors:string[]=[];page.on("pageerror",(e:Error)=>errors.push(e.message));
  const sign=async(cookie:string)=>{const cut=cookie.indexOf("=");await context.clearCookies();await context.addCookies([{name:cookie.slice(0,cut),value:cookie.slice(cut+1),url:origin,httpOnly:true,secure:true,sameSite:"Strict"}]);};
  const shot=async(name:string,selector:string)=>{if(process.env.ONLY_ASKER && name!=="asker")return;const el=page.locator(selector);await el.scrollIntoViewIfNeeded();const bounds=await el.boundingBox();await page.setViewportSize({width,height:Math.max(1000,Math.ceil(bounds.height)+180)});await el.scrollIntoViewIfNeeded();check(`${language}/${name}/fits`,await el.evaluate((e:HTMLElement)=>e.scrollWidth<=e.clientWidth+1));const file=`${language}-${name}.png`;await el.screenshot({path:join(out,file)});receipt.pictures.push(file);};
  await sign(owner.cookie);await page.goto(origin+"/ui/hub/exposures");const card=page.locator("[data-personal-agent]"),tick=card.locator("[data-answer-only-option] input");await tick.waitFor();check(`${language}/default-off`,!await tick.isChecked());console.log("tick-metrics",JSON.stringify(await tick.evaluate((input:HTMLInputElement)=>{const l=input.closest("label")!,s=l.querySelector("span")!,a=input.getBoundingClientRect(),b=s.getBoundingClientRect(),c=l.getBoundingClientRect();return {width:a.width,left:a.left-c.left,gap:b.left-a.right,height:b.height,lineHeight:getComputedStyle(s).lineHeight,font:getComputedStyle(s).fontSize};})));check(`${language}/tick-layout`,await tick.evaluate((input:HTMLInputElement)=>{const label=input.closest("label")!,span=label.querySelector("span")!,a=input.getBoundingClientRect(),b=span.getBoundingClientRect(),c=label.getBoundingClientRect();return a.width<=24&&Math.abs(a.left-c.left)<=5&&b.left-a.right<=16&&b.left>=a.right&&b.height<=parseFloat(getComputedStyle(span).lineHeight)+1;}));await shot("off","[data-personal-agent]");
  reported.inventory.clis[0].answerOnlyStatus="profile-unavailable";await card.getByRole("button",{name:index?"重新整理":"Refresh",exact:true}).click();await card.getByText(index?"這裡不能使用 Codex：這台電腦無法把它限制在單一資料夾內，也無法使用「只回答」模式。可以使用 Claude。":"Codex can't be used here: this computer can't keep it inside one folder, and Answer only mode isn't available either. Claude can be used.",{exact:true}).waitFor();check(`${language}/failed-option-hidden`,await card.locator("[data-answer-only-option]").count()===0);await shot("check-failed","[data-personal-agent]");
  reported.inventory.clis[0].answerOnlyStatus="ready";await card.getByRole("button",{name:index?"重新整理":"Refresh",exact:true}).click();await tick.check();
  await card.locator("form input").nth(0).fill(index?"王經理的知識助理":"General knowledge");await card.locator("form input").nth(1).fill(index?"一般知識問答":"General questions");
  check(`${language}/folder-hidden`,!(await card.textContent()).includes("C:\\Users\\colleague\\Hub agent"));await shot("on","[data-personal-agent]");
  const saved=page.waitForResponse((res:any)=>res.url().endsWith("/hub/v1/me/personal-agent")&&res.request().method()==="PUT");await card.locator("form button").click();const publication=await (await saved).json();check(`${language}/saved-mode`,publication.exposure?.answerOnly===true);
  await page.waitForFunction(()=>!document.querySelector("[data-answer-only-option] strong")&&(document.querySelector('[data-answer-only-option] input') as HTMLInputElement)?.checked===true);await shot("saved","[data-personal-agent]");
  const grant=await r.call(owner,"POST","/hub/v1/grants",{exposureId:publication.exposure.id,exposureRevision:1,login:"admin",days:1});
  const room=await r.call(admin,"POST","/hub/v1/rooms",{exposureId:publication.exposure.id,grantId:grant.json.grant.id});check(`${language}/opened`,room.status===200);
  await sign(admin.cookie);await page.goto(origin+`/ui/hub?room=${room.json.room.id}`);const line=index?"只根據一般知識回答，無法查看任何檔案。":"Answers from general knowledge only. It can't look at any files.";
  await page.locator(".hub-chat-head .s").filter({hasText:line}).waitFor();await page.getByText(index?"它在 王經理 的電腦上執行，那台電腦連接時才會回答，可能需要幾分鐘。每個問題都是分開回答的，它不會記得之前的內容，請把需要的資訊一次寫清楚。":"It runs on Alex's computer and answers when that computer is connected. An answer can take a few minutes. Each question is answered on its own: it doesn't remember earlier ones, so include what it needs.",{exact:true}).waitFor();check(`${language}/no-shared-personal-warning`,!(await page.locator(".hub-room-page").textContent()).includes(index?"所有提問的人":"Everyone who asks this agent"));
  await shot("asker",".hub-room-page");
  const folderAgent=await r.call(owner,"PUT","/hub/v1/me/personal-agent",{name:index?"王經理的筆記":"Personal notes",description:"One-folder personal agent",cli:"claude-code",ifRevision:1});check(`${language}/folder-published`,folderAgent.status===200&&!folderAgent.json.exposure.answerOnly);
  const fg=await r.call(owner,"POST","/hub/v1/grants",{exposureId:publication.exposure.id,exposureRevision:2,login:"admin",days:1}),fr=await r.call(admin,"POST","/hub/v1/rooms",{exposureId:publication.exposure.id,grantId:fg.json.grant.id});
  await page.goto(origin+`/ui/hub?room=${fr.json.room.id}`);await page.getByText(index?"它在 王經理 的電腦上執行，那台電腦連接時才會回答，可能需要幾分鐘。每個問題都是分開回答的，它不會記得之前的內容，請把需要的資訊一次寫清楚。":"It runs on Alex's computer and answers when that computer is connected. An answer can take a few minutes. Each question is answered on its own: it doesn't remember earlier ones, so include what it needs.",{exact:true}).waitFor();await shot("folder-asker",".hub-room-page");check(`${language}/no-page-errors`,errors.length===0);await context.close();
 }
 writeFileSync(join(out,"receipt.json"),JSON.stringify(receipt,null,2)+"\n");console.log(JSON.stringify({checks:receipt.checks.length,pictures:receipt.pictures.length,pass:true}));
}finally{await browser.close();await r.close();runtime.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(home,{recursive:true});}
