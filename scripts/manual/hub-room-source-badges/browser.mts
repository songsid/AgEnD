/** M3256: actual owned Hub HTTP/SQLite/audit, inert directory/member. Headless Linux only. */
import {createRequire} from "node:module";
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {resolve,join} from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {createOwnedPki,trustOwnedBrowserCa,startOwnedHub} from "../hub-connector-4c/rig.mjs";

if(process.platform!=="linux")throw new Error("Headless Linux/WSL is required");
const load=Number(readFileSync("/proc/loadavg","utf8").split(/\s+/)[0]);
if(!Number.isFinite(load)||load>10)throw new Error("Host load exceeds 10");
if(!process.env.PW_DIR||!process.env.CERTUTIL)throw new Error("Owned Playwright and certutil paths required");
const stage=process.env.STAGE||"after",out=resolve(process.env.OUT||`.artifacts/hub-room-source-badges/${stage}`);
mkdirSync(out,{recursive:true});const scratch=mkdtempSync(join(out,"owned-")),home=join(scratch,"home");mkdirSync(home,{recursive:true,mode:0o700});
const pw=createRequire(join(resolve(process.env.PW_DIR),"package.json"))("playwright-core");
const env={...process.env,HOME:home,XDG_CONFIG_HOME:join(home,".config"),XDG_DATA_HOME:join(home,".local/share")};
for(const key of["DISPLAY","WAYLAND_DISPLAY","WSL_INTEROP","CHROME"])delete env[key];
const checks:{key:string;ok:boolean}[]=[],assets=new Map<string,string>(),errors:string[]=[],clients:Client[]=[];
const check=(key:string,ok:boolean)=>{checks.push({key,ok});if(!ok)throw new Error(key);};
let browser:any,hub:Awaited<ReturnType<typeof startOwnedHub>>|undefined;
try{
 const pki=createOwnedPki(join(scratch,"pki"));trustOwnedBrowserCa(pki,home,resolve(process.env.CERTUTIL));
 hub=await startOwnedHub(pki);const r=hub;await r.setEnabled(true);
 for(const name of["Claude Code","Codex"]){
  const pending=await r.begin(name),request=new URL(pending.path,r.origin).searchParams.get("request");
  const approval=await r.hub.call(r.person,"POST","/hub/v1/mcp/consent",{request,scopes:["rooms:read","rooms:post","agents:ask"]});
  check(name+": consent",approval.status===200);
  const code=new URL(approval.json.location).searchParams.get("code")!;
  const token=await fetch(r.hub.base+"/mcp/oauth/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"authorization_code",client_id:pending.clientId,code,code_verifier:pending.verifier,redirect_uri:r.origin+"/owned-callback",resource:r.origin+"/mcp"})});
  check(name+": token",token.status===200);const credentials=await token.json() as {access_token:string};
  const client=new Client({name:"Owned badge rig",version:"1"});clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(r.hub.base+"/mcp"),{requestInit:{headers:{Authorization:`Bearer ${credentials.access_token}`}}}));
  const post=await client.callTool({name:"hub_room_post",arguments:{room:r.roomId,text:name==="Codex"?"The checklist is ready.":"The project notes are ready.",operationId:randomUUID()}});
  check(name+": actual app post",JSON.parse((post.content as {text:string}[])[0]!.text).ok===true);
 }
 await r.hub.call(r.person,"POST",`/hub/v1/rooms/${r.roomId}/messages`,{text:"I will review the notes.",idempotencyKey:randomUUID()});
 await r.hub.call(r.admin,"POST",`/hub/v1/rooms/${r.roomId}/messages`,{text:"@Project helper When is the meeting?",mentions:[r.exposureId],idempotencyKey:randomUUID()});
 for(let n=0;n<100&&!r.deliveries.length;n++)await new Promise(yes=>setTimeout(yes,20));check("inert Fleet answer committed",r.deliveries.length>0);
 browser=await pw.chromium.launch({headless:true,env,args:["--no-sandbox","--no-proxy-server","--host-resolver-rules=MAP hub.example.com 127.0.0.1"]});
 for(const c of[{tag:"desk-light-en",lang:"en",theme:"light",width:1366,height:900},{tag:"phone-dark-zh-TW",lang:"zh-TW",theme:"dark",width:390,height:844}].filter(c=>!process.env.CASES||process.env.CASES.split(",").includes(c.tag))){
  const context=await browser.newContext({viewport:{width:c.width,height:c.height},locale:c.lang,ignoreHTTPSErrors:false});
  await context.addInitScript(({lang,theme}:any)=>{localStorage.setItem("agend_lang",lang);localStorage.setItem("agend_theme",theme);localStorage.setItem("agend_tour_done","1");localStorage.setItem("agend_firstrun_dismissed","1");},{lang:c.lang,theme:c.theme});
  const page=await context.newPage();page.on("pageerror",(e:Error)=>errors.push(e.name));
  page.on("response",async(res:any)=>{const path=new URL(res.url()).pathname;if(res.status()===200&&/^(\/assets\/|\/ui\/js\/)/.test(path))try{assets.set(path,createHash("sha256").update(await res.body()).digest("hex"));}catch{}});
  try{
   await page.goto(r.origin+`/ui/hub?room=${r.roomId}`);await page.locator("#hubLogin").fill("admin");await page.locator("#hubPassword").fill("pw-admin");await page.locator(".hub-signin-form button[type=submit]").click();
   await page.locator(".hub-room-page .thread .msg").filter({hasText:"LARCH-42"}).waitFor();
   const names=await page.locator(".hub-room-page .thread .meta .sender").allTextContents();
   check(c.tag+": both app attributions",names.some((x:string)=>x.includes("Casey")&&x.includes("Claude Code"))&&names.some((x:string)=>x.includes("Casey")&&x.includes("Codex")));
   if(stage==="after"){
    check(c.tag+": generic app marks",await page.locator('.thread [data-room-source="app"]').count()===2);
    check(c.tag+": AgEnD answer mark",await page.locator('.thread [data-room-source="agend"]').count()===1);
    const app=page.locator('.thread .hub-source-trigger').filter({hasText:"Codex"});
    check(c.tag+": explained accessible name",(await app.getAttribute("aria-label"))?.includes(c.lang==="en"?"The app gave":"App 自己提供")===true);
    await page.waitForFunction(()=>[...document.querySelectorAll<HTMLImageElement>(".hub-source-mark img")].every(img=>img.complete&&img.naturalWidth>0));
    check(c.tag+": bundled AgEnD image loaded",true);
    if(c.width<600)check(c.tag+": header tap targets",await page.locator(".thread .hub-source-trigger").evaluateAll((buttons:HTMLElement[])=>buttons.every(b=>b.getBoundingClientRect().height>=44&&b.getBoundingClientRect().width>=44)));
   }
   check(c.tag+": no horizontal overflow",await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   await page.screenshot({path:join(out,c.tag+"-thread.png")});
   if(c.width<600)await page.locator(".hub-room-rail-toggle").click();
   await page.locator(".hub-room-members .hub-member-agent").waitFor();
   if(stage==="after"){
    check(c.tag+": agent member mark",await page.locator('.hub-room-members .hub-member-agent [data-room-source="agend"]').count()===1);
    check(c.tag+": people unchanged",await page.locator('.hub-room-members .hub-member:not(.hub-member-agent) [data-room-source]').count()===0);
    if(c.width<600){
      await page.locator(".hub-member-agent .hub-member-open").click();await page.locator(".hub-source-explanation").filter({hasText:"Fleet"}).waitFor();
      check(c.tag+": member tap explains source",true);await page.locator(".hub-member-agent .hub-member-open").click();
    }
   }
   await page.screenshot({path:join(out,c.tag+"-members.png")});
   if(stage==="after"&&c.width<600){
    await page.keyboard.press("Escape");await page.locator('.thread .hub-source-trigger').filter({hasText:"Codex"}).click();
    const explanation=page.locator(".toast-detail").filter({hasText:"App 自己提供"});
    await explanation.waitFor();check(c.tag+": tap explains app",true);
    await explanation.evaluate(async(el:HTMLElement)=>{await Promise.all(el.getAnimations().map(a=>a.finished.catch(()=>{})));});
    check(c.tag+": explanation wraps",await explanation.evaluate((el:HTMLElement)=>getComputedStyle(el).whiteSpace!=="nowrap"));
    const box=await explanation.boundingBox();
    check(c.tag+": explanation inside viewport",!!box&&box.y>=0&&box.y+box.height<=c.height);
    await page.screenshot({path:join(out,c.tag+"-tap.png")});
   }
  }finally{await context.close();}
 }
 check("no page errors",errors.length===0);check("no inert delivery errors",r.failures.length===0);
 writeFileSync(join(out,"receipt.json"),JSON.stringify({stage,checks,servedAssets:[...assets].map(([path,sha256])=>({path,sha256})),scope:"Actual Hub HTTP/SQLite/audit and MCP person posts; headless Linux Chromium and rig-only trusted CA. Inert AD/member, no live Hub/Fleet/model/personal host."},null,2)+"\n");
 console.log(JSON.stringify({stage,checks:checks.length,passed:checks.filter(c=>c.ok).length}));
}finally{await browser?.close();for(const c of clients)await c.close();await hub?.close();rmSync(scratch,{recursive:true,force:true});}
