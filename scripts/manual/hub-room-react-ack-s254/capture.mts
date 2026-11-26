/** Real Hub UI + actual HTTP/SQLite room reaction acknowledgement; synthetic accounts, no Fleet/CLI/directory/model. */
import {createRequire} from "node:module";
import {createServer} from "node:https";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {randomUUID,createHash} from "node:crypto";
import {s3bRig} from "../../../tests/helpers/hub-s3b-rig.js";
import {provisionHubIdentity} from "../../../src/hub/tls.js";
import {personKeyString} from "../../../src/hub/identity.js";
const out=resolve(process.env.OUT!),repo=resolve(process.env.REPO??".");mkdirSync(out,{recursive:true});
const home=mkdtempSync(join(out,".scratch-"));
let liveContext:any;
let r:Awaited<ReturnType<typeof s3bRig>>|undefined,server:ReturnType<typeof createServer>|undefined,browser:any;
const records:any[]=[],sha=(v:Buffer|string)=>createHash("sha256").update(v).digest("hex");
try{
 await provisionHubIdentity({home,memberOrigin:"https://127.0.0.1"});
 server=createServer({key:readFileSync(join(home,"hub/keys/tls-key.pem")),cert:readFileSync(join(home,"hub/keys/tls-cert.pem"))},(req,res)=>{if(!r?.http.handle(req,res)){res.writeHead(404);res.end();}});
 await new Promise<void>((done,reject)=>{server!.once("error",reject);server!.listen(0,"127.0.0.1",done);});
 const address=server.address();if(!address||typeof address==="string")throw Error("missing owned listener address");
 const origin=`https://127.0.0.1:${address.port}`;
 r=await s3bRig({webOrigin:origin,realAudit:true});
 const person=r.addPerson("reader","Reader"),admin=await r.signIn("admin"),viewer=await r.signIn("reader"),fleetId=randomUUID(),exposureId=randomUUID();
 const caps=["welcome-caps-v1","room-ask-v1","room-answer-buttons-v1","room-react-ack-v1"],link=r.link(fleetId,r.admin,1,caps);
 await r.http.receive(r.frame("exposure.snapshot",{revision:1,exposures:[{id:exposureId,fleetId,owner:r.admin,displayName:"Notes",revision:1,state:"published",dataViewId:"notes",allowedTools:[],policyDigest:"a".repeat(64)}]},link) as never,link);
 const made=await r.call(admin,"POST","/hub/v1/rooms",{name:"Weekly",people:[personKeyString(person)],agents:[exposureId]});if(made.status!==200)throw Error("room setup failed");const roomId=made.json.room.id;
 const posted=await r.call(viewer,"POST",`/hub/v1/rooms/${roomId}/messages`,{text:"Thanks, received. / 謝謝，收到了。",mentions:[exposureId],idempotencyKey:randomUUID()});if(posted.status!==200)throw Error("post setup failed");
 for(let i=0;i<50&&!r.sent.some(x=>x.frame.type==="room.ask");i++)await new Promise(done=>setTimeout(done,20));
 const ask=r.sent.find(x=>x.frame.type==="room.ask")?.frame.payload as any;if(!ask)throw Error("actual room ask missing");
 const pw=createRequire(resolve(process.env.PW_DIR!,"package.json"))("playwright-core");browser=await pw.chromium.launch({executablePath:process.env.CHROME,args:["--no-sandbox"]});
 const cases=[];for(const device of ["desk","phone"])for(const lang of ["en","zh-TW"])for(const theme of ["light","dark"])cases.push({device,lang,theme});
 const capture=async(stage:string,c:typeof cases[number])=>{
  const ctx=await browser.newContext({ignoreHTTPSErrors:true,viewport:c.device==="desk"?{width:1366,height:900}:{width:390,height:844},isMobile:c.device==="phone",hasTouch:c.device==="phone",colorScheme:c.theme,locale:c.lang==="en"?"en-US":"zh-TW"});
  try{
   const eq=viewer.cookie.indexOf("=");await ctx.addCookies([{name:viewer.cookie.slice(0,eq),value:viewer.cookie.slice(eq+1),url:origin,httpOnly:true,secure:true,sameSite:"Strict"}]);
   await ctx.addInitScript(({lang,theme}:any)=>{localStorage.setItem("agend_lang",lang);localStorage.setItem("agend_theme",theme);},c);
   const page=await ctx.newPage(),errors:string[]=[];page.on("pageerror",(e:Error)=>errors.push(e.message));
   await page.goto(`${origin}/ui/hub?room=${roomId}`);await page.getByText("Thanks, received.",{exact:false}).first().waitFor({timeout:15000});await page.evaluate(()=>document.fonts.ready);
   const msg=page.locator(".hub-room-page .thread .msg",{has:page.locator(".md",{hasText:"Thanks, received."})}).first();
   if(stage==="after")await msg.locator(".react-chip").waitFor();
   const chips=await msg.locator(".react-chip").evaluateAll((els:Element[])=>els.map(e=>({text:e.textContent,label:e.getAttribute("aria-label")})));
   if(stage==="after"&&(!chips.some((x:any)=>x.text?.includes("👍")&&x.label?.includes("Notes"))))throw Error("stored agent reaction not shown/named");
   if(stage==="after"&&await page.getByText(/Notes (is working on it|正在處理)/).count())throw Error("completed ask still shows working");
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);if(overflow||errors.length)throw Error(JSON.stringify({overflow,errors}));
   const file=`${stage}-${c.device}-${c.theme}-${c.lang}.png`;await page.screenshot({path:join(out,file),fullPage:false});
   records.push({stage,...c,file,sha256:sha(readFileSync(join(out,file))),reactionVisible:chips.length>0,pageErrors:errors.length,overflow});
  }finally{await ctx.close();}
 };
 await capture("before",{device:"desk",lang:"en",theme:"light"});await capture("before",{device:"phone",lang:"zh-TW",theme:"dark"});
 liveContext=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:844}});
 const eq=viewer.cookie.indexOf("=");await liveContext.addCookies([{name:viewer.cookie.slice(0,eq),value:viewer.cookie.slice(eq+1),url:origin,httpOnly:true,secure:true,sameSite:"Strict"}]);
 await liveContext.addInitScript(()=>{localStorage.setItem("agend_lang","en");});
 const livePage=await liveContext.newPage();await livePage.goto(`${origin}/ui/hub?room=${roomId}`);
 const working=livePage.getByText("Notes is working on it",{exact:true});await working.waitFor({timeout:15000});
 const result=await r.http.receive(r.frame("room.react",{messageId:ask.messageId,roomId,exposureId,emoji:"👍",acknowledge:true},link) as never,link);
 if(result?.type!=="room.react-result"||!result.payload.ok||!result.payload.acknowledged)throw Error("Hub did not acknowledge actual reaction");
 const messages=(await r.call(viewer,"GET",`/hub/v1/rooms/${roomId}/messages`)).json.messages,question=messages.find((m:any)=>m.id===posted.json.id);
 if(question.ask.answered!==1||question.ask.working!==0||question.ask.later!==0||question.reactions?.[0]?.emoji!=="👍")throw Error("actual Hub readback not settled");
 await working.waitFor({state:"hidden",timeout:15000});
 await livePage.reload();await livePage.getByText("Thanks, received.",{exact:false}).first().waitFor();
 if(await working.count())throw Error("working status returned after reload");
 await liveContext.close();liveContext=undefined;
 await r.restartHttp();
 const reopened=(await r.call(viewer,"GET",`/hub/v1/rooms/${roomId}/messages`)).json.messages;
 if(!reopened.some((m:any)=>m.answerTo===question.id&&m.stage==="answered"&&m.acknowledgedByReaction===true))throw Error("reaction completion lost after Hub service restart");
 for(const c of cases)await capture("after",c);
 writeFileSync(join(out,"checks.json"),JSON.stringify({scope:"Real Hub UI and actual stored room.react acknowledgement; synthetic people/agent/messages. No model/CLI/Fleet or live directory.",liveStatus:{beforeWorking:true,clearedWithoutReload:true,clearAfterReload:true,clearAfterHubServiceRestart:true},actualReadback:{answered:1,working:0,later:0,reaction:"👍"},records},null,2)+"\n");
}finally{
 await liveContext?.close();await browser?.close();if(server)await new Promise<void>(done=>server!.close(()=>done()));await r?.close();rmSync(home,{recursive:true,force:true});
}
console.log(JSON.stringify({count:records.length,closed:true}));
