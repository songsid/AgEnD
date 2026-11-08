/** Real Hub HTTPS/SQLite/browser; synthetic directory and protocol member, no API response stubs or fleet/native/account. */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { createServer } from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
const repo=process.env.REPO!,out=process.env.OUT!,pwDir=process.env.PW_DIR!;
if(!repo||!out||!pwDir)throw Error("REPO/OUT/PW_DIR required");
mkdirSync(out,{recursive:true});
const {s3bRig}=await import(repo+"/tests/helpers/hub-s3b-rig.ts");
const {freeHubPort}=await import(repo+"/tests/helpers/hub-rig.ts");
const {provisionHubIdentity}=await import(repo+"/src/hub/tls.ts");
const {messageContentDigest}=await import(repo+"/src/hub/identity.ts");
const port=await freeHubPort(),origin=`https://127.0.0.1:${port}`;
const rig=await s3bRig({webOrigin:origin});
const keys=mkdtempSync(join(out,"owned-keys-"));chmodSync(keys,0o700);
await provisionHubIdentity({home:keys,memberOrigin:origin});
const server=createServer({key:readFileSync(join(keys,"hub/keys/tls-key.pem")),cert:readFileSync(join(keys,"hub/keys/tls-cert.pem"))},(req,res)=>{if(!rig.http.handle(req,res)){res.writeHead(404);res.end();}});
await new Promise<void>((r,j)=>{server.once("error",j);server.listen(port,"127.0.0.1",r);});
const pw=createRequire(pwDir+"/")("playwright-core");
const browser=await pw.chromium.launch({executablePath:process.env.CHROME,args:["--no-sandbox"]});
const receipt:any={source:execFileSync("git",["-C",repo,"rev-parse","HEAD"],{encoding:"utf8"}).trim(),sourceFiles:Object.fromEntries(["src/hub/rooms.ts","src/ui/panel-hub.js",...(process.env.BASELINE==="1"?[]:["src/hub/room-read-pacer.ts"])].map(f=>[f,createHash("sha256").update(readFileSync(join(repo,f))).digest("hex")])),mode:process.env.BASELINE==="1"?"baseline":process.env.RETAINED_PANEL?"retained-panel":"candidate",retainedPanelSha256:process.env.RETAINED_PANEL?createHash("sha256").update(readFileSync(process.env.RETAINED_PANEL)).digest("hex"):undefined,browser:browser.version(),cases:[],network:[],pageErrors:[],foreign:[],csp:[],scope:"Real HTTP/SQLite/auth/grants/history/lease release with synthetic directory and protocol-member replies; no API response replacement, real account/model/native/fleet."};
const owner=rig.addPerson("owner","Example Owner");
const link=rig.link(randomUUID(),owner);
const cs:any[]=[];
for(const device of ["desk","phone"])for(const theme of ["light","dark"])for(const lang of ["en","zh-TW"])cs.push({device,theme,lang});
if(process.env.MATRIX==="quick")cs.splice(0,cs.length,cs[0],cs[7]);
const exposures=cs.map((c,i)=>({id:randomUUID(),fleetId:link.fleetId,owner,displayName:`Reload agent ${i+1}`,revision:1,state:"published",dataViewId:"agent",allowedTools:[],policyDigest:"b".repeat(64)}));
await rig.http.receive(rig.frame("exposure.snapshot",{revision:1,exposures},link) as never,link);
const o=await rig.signIn("owner");
const shot=async(p:any,n:string)=>{await p.evaluate(()=>document.fonts.ready);await p.screenshot({path:join(out,n+".png"),fullPage:true});};
const check=(ok:unknown,msg:string)=>{if(!ok)throw Error(msg);};
async function answer(question:string,text:string){
 const end=Date.now()+15000;let q:any;
 while(!q&&Date.now()<end){q=rig.sent.find((v:any)=>v.frame.type==="question"&&v.frame.payload.text===question)?.frame;if(!q)await new Promise(r=>setTimeout(r,25));}
 check(q,"question did not reach inert member");
 const answerId=randomUUID(),digest=messageContentDigest("answer",text);
 const lease:any=await rig.http.receive(rig.frame("authorize.request",{messageId:q.payload.identity.messageId,operationId:randomUUID(),exposureRevision:1,phase:"release-answer",answer:{answerId,contentDigest:digest}},link) as never,link);
 check(lease?.type==="authorize.result"&&lease.payload.lease,"release lease refused");
 await rig.http.receive(rig.frame("answer",{messageId:q.payload.identity.messageId,answerId,text,contentDigest:digest,releaseLease:lease.payload.lease},link) as never,link);
}
try{
 for(let i=0;i<cs.length;i++){
  const c=cs[i],tag=`${c.device}-${c.theme}-${c.lang}`,row:any={tag,checks:[]};receipt.cases.push(row);
  const asker=rig.addPerson("asker"+i,"Example Asker");
  await rig.signIn("asker"+i);
  const grant=await rig.call(o,"POST","/hub/v1/grants",{exposureId:exposures[i]!.id,exposureRevision:1,login:"asker"+i,days:7});check(grant.status===200,"grant setup failed");
  const ctx=await browser.newContext({viewport:c.device==="phone"?{width:390,height:844}:{width:1366,height:900},isMobile:c.device==="phone",hasTouch:c.device==="phone",locale:c.lang==="en"?"en-US":"zh-TW",colorScheme:c.theme,ignoreHTTPSErrors:true});
  await ctx.addInitScript({content:`window.__name=fn=>fn;localStorage.setItem('agend_lang',${JSON.stringify(c.lang)});localStorage.setItem('agend_theme',${JSON.stringify(c.theme)});window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective));`});
  await ctx.route("**/*",(route:any)=>{const u=new URL(route.request().url());if(u.origin!==origin){receipt.foreign.push(u.origin);return route.abort();}if(process.env.RETAINED_PANEL&&u.pathname==="/ui/js/panel-hub.js")return route.fulfill({status:200,contentType:"application/javascript",body:readFileSync(process.env.RETAINED_PANEL,"utf8")});return route.continue();});
  const p=await ctx.newPage();p.setDefaultTimeout(15000);
  p.on("pageerror",(e:any)=>receipt.pageErrors.push(String(e)));
  p.on("response",(r:any)=>{if(new URL(r.url()).pathname.endsWith("/messages"))receipt.network.push({tag,at:Date.now(),path:new URL(r.url()).pathname,status:r.status(),method:r.request().method(),retryAfter:r.headers()["retry-after"]});});
  try{
   await p.goto(origin+"/ui/hub");await p.fill("#hubLogin","asker"+i);await p.fill("#hubPassword","pw-asker"+i);await p.locator(".hub-signin button[type=submit]").click();await p.locator(".hub-home").waitFor();
   await p.locator(c.device==="desk"?".sidebar .hub-new":".hub-home .hub-new").click();await p.locator(".hub-pick-row button").first().click();await p.locator(".hub-room-empty").waitFor();
   const roomURL=p.url(),path="/hub/v1/rooms/"+new URL(roomURL).searchParams.get("room")+"/messages";
   const q=`Reload question ${tag}`,a=`Visible reply ${tag}`;await p.fill("#msgIn",q);await p.locator("#sendBtn").click();await answer(q,a);
   const r=p.waitForResponse((r:any)=>new URL(r.url()).pathname===path&&r.request().method()==="GET");await p.reload();const response=await r;row.reloadStatus=response.status();
   if(response.status()!==200){row.status="BASELINE_REPRODUCED";await p.getByText(c.lang==="en"?"Too many requests just now.":"目前要求太多，請稍後再試。",{exact:false}).waitFor({timeout:2000}).catch(()=>{});await shot(p,tag+"-reload-refused");check(process.env.BASELINE==="1","ordinary reload returned "+response.status());continue;}
   await p.getByText(a,{exact:true}).waitFor();check(await p.getByText(q,{exact:true}).count()===1,"question lost/duplicated on reload");row.checks.push("reload returns current question and answer");
   const another=p.waitForResponse((r:any)=>new URL(r.url()).pathname===path&&r.request().method()==="GET");await p.goto(origin+"/ui/hub");await p.goto(roomURL);check((await another).status()===200,"reopen refused");await p.getByText(a,{exact:true}).waitFor();row.checks.push("reopen within10s shows chat");
   check(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),"horizontal overflow");await shot(p,tag+"-reload-visible");
   if(process.env.RETAINED_PANEL){receipt.csp.push(...await p.evaluate(()=>window.__csp));row.checks.push("retained panel/new server reload and reopen");row.status="PASS";continue;}
   const cookies=await ctx.cookies(),cookie=cookies.map((x:any)=>x.name+"="+x.value).join("; ");
   const original=rig.directory.checkEligibility.bind(rig.directory);let release!:()=>void,entered!:()=>void,count=0;
   const gate=new Promise<void>(r=>release=r),both=new Promise<void>(r=>entered=r);
   rig.directory.checkEligibility=async(person:any)=>{if(person.objectId===asker.objectId&&count<2){count++;if(count===2)entered();await gate;}return original(person);};
   const held=[rig.call({cookie,csrf:""},"GET",path),rig.call({cookie,csrf:""},"GET",path)];
   try{
    await both;const busy=p.waitForResponse((r:any)=>new URL(r.url()).pathname===path&&r.request().method()==="GET");await p.reload();const b=await busy;check(b.status()===429&&b.headers()["retry-after"]==="10","genuine capacity not bounded");
    const busyText=c.lang==="en"?"The Hub is busy. Retrying shortly…":"Hub 忙碌中，稍後會自動重試…";await p.getByText(busyText,{exact:true}).waitFor();row.busy={status:b.status(),retryAfter:b.headers()["retry-after"]};await shot(p,tag+"-busy-retrying");row.checks.push("actual held-capacity429 has plain localized busy/retrying");
   }finally{release();rig.directory.checkEligibility=original;}
   check((await Promise.all(held)).every(x=>x.status===200),"held reads failed after release");
   await p.getByText(a,{exact:true}).waitFor({timeout:25000});await shot(p,tag+"-retry-recovered");row.checks.push("automatic Retry-After recovery returns chat");
   receipt.csp.push(...await p.evaluate(()=>window.__csp));row.status="PASS";
  }catch(e:any){row.status="FAIL";row.error=e.stack;await shot(p,tag+"-FAIL").catch(()=>{});}
  finally{await ctx.close();}
 }
}finally{
 await browser.close();await new Promise<void>(r=>server.close(()=>r()));await rig.close();rmSync(keys,{recursive:true,force:true});
 receipt.cleaned={browserClosed:true,httpsClosed:true,rigClosed:true,keyRootRemoved:true,port,pid:process.pid};
 receipt.status=receipt.cases.every((c:any)=>c.status===(process.env.BASELINE==="1"?"BASELINE_REPRODUCED":"PASS"))?"PASS":"FAIL";
 writeFileSync(join(out,"receipt.json"),JSON.stringify(receipt,null,2));console.log(JSON.stringify({source:receipt.source,mode:receipt.mode,status:receipt.status,cases:receipt.cases,pageErrors:receipt.pageErrors,csp:receipt.csp,foreign:receipt.foreign}));
}
process.exitCode=receipt.status==="PASS"?0:1;
