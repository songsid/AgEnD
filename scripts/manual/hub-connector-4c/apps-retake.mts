/** PM-requested two apps views, plus one consent view for the new return-address disclosure. No repeated matrix. */
import {createRequire} from "node:module";
import {mkdirSync,mkdtempSync,rmSync,writeFileSync,readFileSync} from "node:fs";
import {resolve,join} from "node:path";
import {createHash} from "node:crypto";
import {createOwnedPki,trustOwnedBrowserCa,startOwnedHub} from "./rig.mjs";
if(process.platform!=="linux")throw new Error("Headless Linux only");
const launchLoad=Number(readFileSync("/proc/loadavg","utf8").split(/\s+/)[0]);if(!Number.isFinite(launchLoad)||launchLoad>10)throw new Error("Host load exceeds the owned browser limit");
const out=resolve(process.env.OUT||".artifacts/hub-connector-4c/ui/apps-r1");mkdirSync(out,{recursive:true});const scratch=mkdtempSync(join(out,"owned-")),browserHome=join(scratch,"browser-home");mkdirSync(browserHome,{mode:0o700});
process.env.PLAYWRIGHT_BROWSERS_PATH=resolve(".artifacts/hub-connector-4c/ui/pw/browsers");
const pw=createRequire(resolve(".artifacts/hub-connector-4c/ui/pw/package.json"))("playwright-core"),env={...process.env,HOME:browserHome};
for(const key of["DISPLAY","WAYLAND_DISPLAY","WSL_INTEROP","CHROME"])delete env[key];
const checks:{key:string;ok:boolean}[]=[],assets=new Map<string,string>();const check=(key:string,ok:boolean)=>{checks.push({key,ok});if(!ok)throw new Error(key);};
let pngs=0;let browser:any,hub:Awaited<ReturnType<typeof startOwnedHub>>|undefined;
try{
 const pki=createOwnedPki(join(scratch,"pki"));trustOwnedBrowserCa(pki,browserHome,resolve(".artifacts/hub-connector-4c/ui/tools/nss/usr/bin/certutil"));hub=await startOwnedHub(pki);const r=hub;await r.setEnabled(true);
 browser=await pw.chromium.launch({headless:true,env,args:["--no-sandbox","--no-proxy-server",`--log-file=${join(scratch,"chromium.log")}`,"--host-resolver-rules=MAP hub.example.com 127.0.0.1"]});
 for(const c of[{tag:"desk-light-en",lang:"en",theme:"light",width:1366,height:900},{tag:"phone-dark-zh-TW",lang:"zh-TW",theme:"dark",width:390,height:844}].filter(c=>!process.env.CASES||process.env.CASES.split(",").includes(c.tag))){
  const zh=c.lang==="zh-TW",context=await browser.newContext({viewport:{width:c.width,height:c.height},locale:c.lang,ignoreHTTPSErrors:false});
  await context.grantPermissions(["clipboard-read","clipboard-write"],{origin:r.origin});await context.addInitScript(({lang,theme}:any)=>{localStorage.setItem("agend_lang",lang);localStorage.setItem("agend_theme",theme);localStorage.setItem("agend_tour_done","1");localStorage.setItem("agend_firstrun_dismissed","1");},{lang:c.lang,theme:c.theme});
  const page=await context.newPage(),errors:string[]=[];page.on("pageerror",(e:Error)=>errors.push(e.name));page.on("response",async(res:any)=>{const path=new URL(res.url()).pathname;if(res.status()===200&&/^(\/assets\/|\/ui\/js\/)/.test(path))try{assets.set(path,createHash("sha256").update(await res.body()).digest("hex"));}catch{}});
  try{
   const pending=await r.begin();await page.goto(r.origin+pending.path);await page.locator("#hubLogin").fill("casey");await page.locator("#hubPassword").fill("pw-casey");await page.locator(".hub-signin-form button[type=submit]").click();await page.locator("#hubLogin").waitFor({state:"detached"});
   const consent=page.locator(".hub-ai-apps"),allow=consent.getByRole("button",{name:zh?"允許":"Allow",exact:true});await allow.waitFor();
   check(c.tag+": exact destination shown",(await consent.locator(".hub-app-destination").innerText()).includes(new URL(r.origin).host));
   for(const field of await consent.locator("[data-app-scope]").all())await field.uncheck();check(c.tag+": Allow disabled without scopes",await allow.isDisabled());for(const field of await consent.locator("[data-app-scope]").all())await field.check();
   if(!zh){await consent.screenshot({path:join(out,"desk-light-en-consent.png")});pngs++;}await allow.click();await page.waitForURL("**/owned-callback?*");
   await page.goto(r.origin+"/ui/hub?view=ai-apps");const apps=page.locator(".hub-ai-apps"),disconnect=apps.getByRole("button",{name:zh?"中斷連接":"Disconnect",exact:true});await disconnect.waitFor();
   check(c.tag+": primary address action",(await apps.getByRole("button",{name:zh?"複製位址":"Copy address",exact:true}).getAttribute("class")).includes("btn-primary"));
   check(c.tag+": setup hint names app",(await apps.innerText()).includes(zh?"貼到 Claude Code":"Paste this into Claude Code"));
   const detail=apps.locator("details.s-ui-disclosure");check(c.tag+": closed shared disclosure",!await detail.evaluate((el:HTMLDetailsElement)=>el.open));
   await apps.locator("select").selectOption("generic");check(c.tag+": generic has no prompt button",await apps.getByRole("button",{name:zh?"複製設定提示":"Copy setup prompt",exact:true}).count()===0);check(c.tag+": generic remote address hint",(await apps.innerText()).includes(zh?"遠端 MCP 伺服器":"remote MCP server"));await apps.locator("select").selectOption("claude");
   await apps.locator(".hub-app-entry").scrollIntoViewIfNeeded();const row=await apps.locator(".hub-app-entry").boundingBox(),button=await disconnect.boundingBox();check(c.tag+": Disconnect visible inside row",!!row&&!!button&&button.x+button.width<=row.x+row.width&&button.y>=row.y&&button.y+button.height<=c.height);check(c.tag+": complete permission row visible",!!row&&row.y>=0&&row.y+row.height<=c.height);check(c.tag+": right aligned action",!!row&&!!button&&row.x+row.width-button.x-button.width<24);check(c.tag+": 44px action",!!button&&button.width>=44&&button.height>=44);
   check(c.tag+": readable permission lead",(await apps.locator(".hub-app-entry").innerText()).includes(zh?"可以：":"May:"));
   await page.screenshot({path:join(out,c.tag+"-apps.png")});pngs++;await disconnect.click();await apps.getByText(zh?"尚未連接任何 AI App。":"No AI apps are connected.",{exact:true}).waitFor();check(c.tag+": scoped disconnect succeeds",(r.hub.db.prepare("SELECT COUNT(*) AS n FROM hub_mcp_apps WHERE state='active'").get() as {n:number}).n===0);check(c.tag+": no page error",errors.length===0);
  }finally{await context.close();}
 }
 writeFileSync(join(out,"receipt.json"),JSON.stringify({checks,servedAssets:[...assets].map(([path,sha256])=>({path,sha256})),scope:"Bounded PM apps EN/zh retake + EN destination disclosure, actual HTTPS/SQLite/audit, inert directory/member. Existing full gates and native proofs are not repeated."},null,2)+"\n");console.log(JSON.stringify({checks:checks.length,pngs}));
}finally{await browser?.close();await hub?.close();rmSync(scratch,{recursive:true,force:true});}
