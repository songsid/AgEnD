/** One serial headless WSL campaign. Test authority is trusted only in the owned browser home; never ignore TLS errors. */
import {createRequire} from "node:module";
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {resolve,join} from "node:path";
import {request} from "node:https";
import {createHash} from "node:crypto";
import {createOwnedPki,trustOwnedBrowserCa,startOwnedHub} from "./rig.mjs";
if(process.platform!=="linux")throw new Error("This campaign requires headless Linux inside WSL.");
const launchLoad=Number(readFileSync("/proc/loadavg","utf8").split(/\s+/)[0]);if(!Number.isFinite(launchLoad)||launchLoad>10)throw new Error("Host load exceeds the owned browser limit");
const out=resolve(process.env.OUT||".artifacts/hub-connector-4c/ui/browser");mkdirSync(out,{recursive:true});
const scratch=mkdtempSync(join(out,"owned-")),browserHome=join(scratch,"browser-home");mkdirSync(browserHome,{mode:0o700});
process.env.PLAYWRIGHT_BROWSERS_PATH=resolve(process.env.PW_BROWSERS||".artifacts/hub-connector-4c/ui/pw/browsers");
const pw=createRequire(resolve(process.env.PW_DIR||".artifacts/hub-connector-4c/ui/pw","package.json"))("playwright-core");
const env={...process.env,HOME:browserHome,XDG_CONFIG_HOME:join(browserHome,".config"),XDG_DATA_HOME:join(browserHome,".local/share")};
for(const key of["DISPLAY","WAYLAND_DISPLAY","WSL_INTEROP","CHROME"])delete env[key];
const checks:{key:string;ok:boolean;detail?:unknown}[]=[],assets=new Map<string,string>(),errors:string[]=[];
const cases=[{tag:"desk-light-en",lang:"en",theme:"light",width:1366,height:900},{tag:"phone-dark-zh-TW",lang:"zh-TW",theme:"dark",width:390,height:844}].filter(c=>!process.env.CASES||process.env.CASES.split(",").includes(c.tag));
if(!cases.length)throw new Error("No owned browser cases selected");
const check=(key:string,ok:boolean,detail?:unknown)=>{checks.push({key,ok,detail});if(!ok)throw new Error(key);};
let browser:any,hub:Awaited<ReturnType<typeof startOwnedHub>>|undefined;
const tlsRefusal=(origin:string,ca?:Buffer,servername="hub.example.com")=>new Promise<string>((yes,no)=>{const u=new URL(origin),req=request({hostname:"127.0.0.1",port:u.port,path:"/",servername,...(ca?{ca}:{}),rejectUnauthorized:true},res=>{res.resume();no(new Error("A negative trust control unexpectedly connected"));});req.on("error",(e:NodeJS.ErrnoException)=>yes(e.code||"unknown"));req.end();});
try{
 const pki=createOwnedPki(join(scratch,"pki"));
 trustOwnedBrowserCa(pki,browserHome,resolve(process.env.CERTUTIL||".artifacts/hub-connector-4c/ui/tools/nss/usr/bin/certutil"));
 hub=await startOwnedHub(pki);const r=hub;
 check("untrusted authority refused",["UNABLE_TO_VERIFY_LEAF_SIGNATURE","SELF_SIGNED_CERT_IN_CHAIN","UNABLE_TO_GET_ISSUER_CERT_LOCALLY"].includes(await tlsRefusal(r.origin)));
 check("wrong hostname refused",await tlsRefusal(r.origin,readFileSync(pki.ca),"not-hub.example.com")==="ERR_TLS_CERT_ALTNAME_INVALID");
 browser=await pw.chromium.launch({headless:true,env,args:["--no-sandbox","--no-proxy-server",`--log-file=${join(scratch,"chromium.log")}`,"--host-resolver-rules=MAP hub.example.com 127.0.0.1"]});
 for(const c of cases){
  await r.setEnabled(false);const zh=c.lang==="zh-TW";
  const options={viewport:{width:c.width,height:c.height},locale:c.lang,ignoreHTTPSErrors:false};const context=await browser.newContext(options),personContext=await browser.newContext(options);await personContext.grantPermissions(["clipboard-read","clipboard-write"],{origin:r.origin});
  for(const current of[context,personContext])await current.addInitScript(({lang,theme}:any)=>{localStorage.setItem("agend_lang",lang);localStorage.setItem("agend_theme",theme);localStorage.setItem("agend_tour_done","1");localStorage.setItem("agend_firstrun_dismissed","1");},{lang:c.lang,theme:c.theme});
  const page=await context.newPage();page.on("pageerror",(error:Error)=>errors.push(error.name));
  page.on("response",async(response:any)=>{const path=new URL(response.url()).pathname;if(response.status()===200&&/^(\/assets\/|\/ui\/js\/)/.test(path)){try{assets.set(path,createHash("sha256").update(await response.body()).digest("hex"));}catch{}}});
  const login=async(p:any,path:string,user:string)=>{await p.goto(r.origin+path);await p.locator("#hubLogin").waitFor();await p.locator("#hubLogin").fill(user);await p.locator("#hubPassword").fill(`pw-${user}`);await p.locator(".hub-signin-form button[type=submit]").click();await p.locator("#hubLogin").waitFor({state:"detached"});};
  try{
   await login(page,"/ui/hub/admin?view=this-hub","admin");const policy=page.locator(".hub-ai-apps");await policy.getByRole("switch").waitFor();
   check(c.tag+": policy starts off",!await policy.getByRole("switch").isChecked());await policy.screenshot({path:join(out,c.tag+"-admin.png")});
   await policy.getByRole("switch").check();await policy.getByRole("button",{name:zh?"儲存":"Save",exact:true}).click();await policy.getByText(zh?"已儲存。":"Saved.",{exact:true}).waitFor();
   const pending=await r.begin(),person=await personContext.newPage();person.on("pageerror",(error:Error)=>errors.push(error.name));
   await login(person,pending.path,"casey");const consent=person.locator(".hub-ai-apps");await consent.locator("[data-app-scope]").first().waitFor();
   check(c.tag+": three default scopes",await consent.locator("[data-app-scope]:checked").count()===3);
   check(c.tag+": fourth permission disabled",await consent.locator('input[type=checkbox]:disabled').count()===1);
   check(c.tag+": provider disclosure",(await consent.innerText()).includes(zh?"服務商":"provider"));await consent.screenshot({path:join(out,c.tag+"-consent.png")});
   await consent.locator('[data-app-scope="rooms:post"]').uncheck();await consent.getByRole("button",{name:zh?"允許":"Allow",exact:true}).click();await person.waitForURL("**/owned-callback?*");
   const scopes=r.hub.db.prepare("SELECT scopes,person FROM hub_mcp_apps WHERE state='active' ORDER BY created_at DESC LIMIT 1").get() as {scopes:string;person:string};check(c.tag+": exact selected scopes committed",scopes.scopes==='["rooms:read","agents:ask"]');check(c.tag+": colleague identity committed",scopes.person===r.personKey);
   await person.goto(r.origin+"/ui/hub?view=ai-apps");await person.getByRole("button",{name:zh?"中斷連接":"Disconnect",exact:true}).waitFor();
   const apps=person.locator(".hub-ai-apps");check(c.tag+": listed actual grant",(await apps.innerText()).includes("Example AI"));
   for(const app of["claude","codex","generic"]){await apps.locator("select").selectOption(app);await apps.getByRole("button",{name:app==="generic"?(zh?"複製位址":"Copy address"):(zh?"複製設定提示":"Copy setup prompt"),exact:true}).click();const copied=await person.evaluate(()=>navigator.clipboard.readText());check(c.tag+":"+app+": address-only setup",copied.includes(r.origin+"/mcp")&&!/access_token|refresh_token|client_secret|wsl\.exe|\"command\"/.test(copied));}
   const metrics=await apps.evaluate((el:HTMLElement)=>({width:el.clientWidth,scroll:el.scrollWidth,controls:[...el.querySelectorAll("button,select,summary")].map(n=>({h:n.getBoundingClientRect().height,w:n.getBoundingClientRect().width}))}));
   check(c.tag+": no horizontal overflow",metrics.scroll<=metrics.width+1,metrics);check(c.tag+": touch sizes",metrics.controls.every((m:any)=>m.h>=44&&m.w>=44),metrics.controls);
   await apps.screenshot({path:join(out,c.tag+"-apps.png")});await apps.getByRole("button",{name:zh?"中斷連接":"Disconnect",exact:true}).click();await apps.getByText(zh?"尚未連接任何 AI App。":"No AI apps are connected.",{exact:true}).waitFor();
   check(c.tag+": disconnect ends grant",(r.hub.db.prepare("SELECT COUNT(*) AS n FROM hub_mcp_apps WHERE state='active'").get() as {n:number}).n===0);
   await page.goto(r.origin+`/ui/hub?room=${r.roomId}`);await page.locator(".hub-room-menu button[aria-haspopup=menu]").click();await page.getByRole("menuitem",{name:zh?"房間設定":"Room settings",exact:true}).click();await page.locator("#hubRoomAiApps").waitFor();
   check(c.tag+": room apps default on",await page.locator("#hubRoomAiApps").isChecked());const saved=page.waitForResponse((res:any)=>res.request().method()==="PATCH"&&new URL(res.url()).pathname.endsWith("/ai-apps"));await page.locator("#hubRoomAiApps").uncheck();await saved;
   check(c.tag+": room switch actual SQLite",(await r.hub.call(r.admin,"GET",`/hub/v1/rooms/${r.roomId}`)).json.settings.aiApps===false);await page.locator("#hubRoomAiApps").scrollIntoViewIfNeeded();await page.screenshot({path:join(out,c.tag+"-room.png")});
   await r.hub.call(r.admin,"PATCH",`/hub/v1/rooms/${r.roomId}/ai-apps`,{enabled:true});await person.close();
  }catch(error){await page.screenshot({path:join(out,c.tag+"-failure.private.png")}).catch(()=>{});writeFileSync(join(out,c.tag+"-failure.private.html"),await page.content().catch(()=>""));throw error;}
  finally{await personContext.close();await context.close();}
 }
 check("no page errors",errors.length===0,errors);check("no inert agent delivery errors",r.failures.length===0,r.failures);
 writeFileSync(join(out,"receipt.json"),JSON.stringify({checks,servedAssets:[...assets].map(([path,sha256])=>({path,sha256})),scope:"Actual headless Linux Chromium / trusted owned CA / Hub HTTP / SQLite and real audit; inert directory and member input. No real CLI/model/live Fleet/AD or production factory claim."},null,2)+"\n");
 console.log(JSON.stringify({passed:checks.length,pngs:cases.length*4}));
}finally{await browser?.close();await hub?.close();rmSync(scratch,{recursive:true,force:true});}
