/** Real renderers with server-derived summaries/refusals. Private fixture only; no Fleet/CLI/runtime starts. */
import {createHash,randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {bootFixture,matrix,caseName} from "../smoke-fixture/index.mts";
const repo=process.env.REPO!,out=join(process.env.OUT!,"request-context-cutover-s230-completion");mkdirSync(out,{recursive:true});
const git=(...args:string[])=>execFileSync("git",["-C",repo,...args],{encoding:"utf8"}).trim();
if(git("status","--porcelain","--","src","scripts/manual/request-context-cutover-s230"))throw Error("Commit capture source first");
const receipt:any={sourceHead:git("rev-parse","HEAD"),scope:"Real Settings pending and chat/refusal renderers; synthetic session/turn, no activation or provider",pictures:[],checks:[]};
const check=(name:string,ok:unknown)=>{receipt.checks.push({name,ok:!!ok});if(!ok)throw Error(name);};
const selected=new Set((process.env.STATES??"settings-pending,destination-refusal,stop-waiting-outcome").split(","));
const fx=await bootFixture({port:0,classic:false,host:true,roster:[{name:"general",displayName:"General",backend:"claude-code",general:true},{name:"worker",displayName:"Demo worker",backend:"codex"}]});
const {setLocale}=await import(repo+"/src/locale.ts"),{prepareSettingsEffect}=await import(repo+"/src/settings-effect.ts"),{captureRequestContextCall}=await import(repo+"/src/request-context-call.ts");
Object.defineProperty(fx.fm,"currentVersion",{get:()=>"2.4.0-beta.25",configurable:true});Object.defineProperty(fx.fm,"currentBuild",{get:()=>null,configurable:true});
const view:any={revision:1,enabled:false,everActivated:false,attempted:false,phase:"off",canChange:true,blockers:[],restartCount:2,
 goBack:{attemptIds:["20261126T010203Z-0a1b2c3d"],availableUntil:"2026-12-03T02:30:00Z",timeZone:"Asia/Taipei"}};
const never=()=>{throw Error("Capture cannot activate, deliver or launch");};
fx.fm.requestContextControl={principal:(req:any)=>{const owner=fx.fm.liveOwner(req,{hostOnly:false});return owner&&{binding:owner.handle,verified:true,current:owner.current};},permitContinuation:()=>false,read:()=>view,snapshot:()=>view,recheck:()=>view,change:never};
fx.fm.deliverToInstance=never;fx.fm.deliverHumanToInstance=never;fx.fm.saveFleetConfig=never;
try{
 for(const c of matrix()){
  setLocale(c.lang);const tag=caseName(c),{ctx,page,csp}=await fx.page(c,{path:"/settings/access#request-context",host:true});
  const shot=async(state:string)=>{if(!selected.has(state))return;check(`${tag}-${state}: no overflow`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));check(`${tag}-${state}: CSP`,!(await csp()).length);const name=`${tag}-${state}.png`,path=join(out,name);await page.screenshot({path});receipt.pictures.push({name,sha256:createHash("sha256").update(readFileSync(path)).digest("hex")});};
  try{
   const diff=prepareSettingsEffect("POST","/api/settings/request-context",{revision:1,action:"enable"},{config:fx.fm.fleetConfig,requestContextControl:()=>view}as any).diff!;
   const id="0123456789abcdef0123456789abcdef",pending={id,state:"pending",section:"access",requested_at:Date.now(),requested_by:"Demo admin",expires_at:Date.now()+300000,remaining_ms:287000,source:"public_link",summary:diff.summary,summary_i18n:diff.summary_i18n,can_withdraw:true,can_self_confirm:true,confirmation:{kind:"chat",where:[{platform:"discord",connection:"Demo connection"}]},outcome:null};
   await page.route(`**/api/settings/pending/${id}`,r=>r.fulfill({status:200,contentType:"application/json",body:JSON.stringify(pending)}));
   await page.locator("#request-context").waitFor();
   await page.evaluate(async value=>{
     const loaded=performance.getEntriesByType("resource").map(row=>row.name).filter(name=>/\/ui\/js\/(?:v-[^/]+\/)?settings-confirm\.js(?:[?#]|$)/.test(name));
     const path=loaded.find(name=>name.includes("/v-"))??loaded[0]??"/ui/js/settings-confirm.js";
     const m:any=await import(path),control:any=await import(path.replace(/settings-confirm\.js(?:[?#].*)?$/,"request-context-control.js"));void m.track(value,control.requestContextControlText("title"));
   },pending);
   await page.locator(".pending-card").waitFor();await page.locator(".pending-card .pending-details > summary").click();await page.locator(".pending-card").scrollIntoViewIfNeeded();await page.waitForTimeout(120);
   check(`${tag}: irreversible lead before details`,await page.locator(".pending-card .notice.warn").innerText() === (c.lang==="en"?"Once on, AgEnD can't go back to an older version.":"開啟後就不能再降回舊版 AgEnD。"));
   check(`${tag}: Apply now has no conflicting General direction`,!(await page.locator(".pending-card").innerText()).includes(c.lang==="en"?"press Confirm on the card in General":"請到 Discord"));
   check(`${tag}: fixture badge uses 2.4`,await page.getByText("v2.4.0-beta.25",{exact:true}).count()===1);
   check(`${tag}: pending summary carries irreversible effect`,(await page.locator(".pending-card").innerText()).includes(c.lang==="en"?"older AgEnD":"舊版 AgEnD"));await shot("settings-pending");
   if(!selected.has("destination-refusal")&&!selected.has("stop-waiting-outcome"))continue;
   await page.goto(`${fx.base}/ui/chat/worker`);await page.waitForTimeout(200);
   const root=randomUUID(),context:any={ref:{version:1,contextId:randomUUID(),rootContextId:root,parentContextId:root},rootEvidenceRef:"synthetic-delegation",ingress:"owner",source:{instance:"worker",incarnation:"fixture"},initiatingActor:{kind:"person",platform:"discord",userId:"demo-person",displayName:"Demo person"},sourceAudience:{kind:"instance",ref:randomUUID()}};
   const lease=captureRequestContextCall({token:randomUUID(),inputId:"synthetic-delivered-child",context,wireSha256:"a".repeat(64),owner:{instance:"worker",incarnation:"fixture",workGeneration:"fixture",daemonBootId:"fixture",spawnGeneration:1,launchFenceEpoch:0,deliveryEpoch:0}},()=>true);
   let refused=false;try{fx.fm.makeRequestContextPolicy().assert({instance:"worker",tool:"reply",args:{text:"Fixture reply"},admission:{coverage:"covered",lease}});}catch(error){refused=String(error).includes(c.lang==="en"?"reply through":"透過提出請求");}
   check(`${tag}: actual destination guard refused`,refused);await page.getByText(c.lang==="en"?"Not sent: reply through the agent that asked.":"未送出：請透過提出請求的 Agent 回覆。",{exact:true}).last().waitFor();await shot("destination-refusal");
   fx.fm.emitSseEvent("message",{instance:"worker",sender:"AgEnD",role:"status",wrap:true,text:c.lang==="zh-TW"?"擁有者已結束這次等候；不再等候這則回覆。":"The owner stopped waiting for this reply.",ts:new Date().toISOString()});
   await page.getByText(c.lang==="zh-TW"?"擁有者已結束這次等候；不再等候這則回覆。":"The owner stopped waiting for this reply.",{exact:true}).last().waitFor();await shot("stop-waiting-outcome");
  }catch(error){
    await page.screenshot({path:join(out,`${tag}-failure.png`)});
    writeFileSync(join(out,`${tag}-failure.json`),JSON.stringify(await page.evaluate(async()=>({url:location.pathname,body:document.body.innerText.slice(0,5000),control:await fetch("/api/settings/request-context").then(async response=>({status:response.status,body:await response.text()})),resources:performance.getEntriesByType("resource").map(row=>row.name).filter(name=>name.includes("settings"))})),null,2));throw error;
  }finally{await ctx.close();fx.fm.webChatHistory.forget("worker");}
 }
 writeFileSync(join(out,"capture.json"),JSON.stringify(receipt,null,2)+"\n");console.log(JSON.stringify({sourceHead:receipt.sourceHead,pictures:receipt.pictures.length,checks:receipt.checks.length}));
}finally{await fx.close();}
