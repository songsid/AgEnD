/** Real Settings shell + D3 session + fake verified LDAPS + normal Hub HTTPS. Never starts a Fleet/CLI/OS service. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import { loadavg } from "node:os";
import { createHash, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { matrix, VIEWPORTS, caseName } from "../smoke-fixture/index.mts";
import { directoryCertificates } from "../../../tests/support/hub-directory-ca-fixture.js";
import { groupWirePeer, PERSON_ID } from "../../../tests/support/hub-group-directory-wire.js";
import { freeHubPort } from "../../../tests/helpers/hub-rig.js";
const mode=process.env.MODE??"current", base=process.env.BASE_REF??"a6557a6b3e328b1586de0f853390aabb8f0ad99f";
const skew=process.env.SKEW??"";
if(skew&&!["old-words","old-server"].includes(skew))throw Error("unknown SKEW mode");
const REPO=process.env.REPO??process.cwd(),OUT=process.env.OUT??join(REPO,".artifacts/m2989/setup"),PW=process.env.PW_DIR??join(REPO,"../../node_modules");
mkdirSync(OUT,{recursive:true});process.env.AGEND_HOME=mkdtempSync(join(tmpdir(),"hub-setup-ui-env-"));
const envHome=process.env.AGEND_HOME;
const {FleetManager}=await import(REPO+"/src/fleet-manager.ts");
const {HubRuntime}=await import(REPO+"/src/hub/runtime.ts");
const pw=createRequire(PW+"/")("playwright-core"),browser=await pw.chromium.launch({...(process.env.CHROME?{executablePath:process.env.CHROME}:{}),args:["--no-sandbox"]});
const digest=(body:any)=>createHash("sha256").update(body).digest("hex");
const git=(...args:string[])=>execFileSync("git",["-C",REPO,...args],{encoding:"utf8"}).trim();
const inputs=["src/ui/settings-hub-setup.js","src/ui/settings-hub-setup-strings.js","src/hub/init/web.ts","src/fleet-manager.ts","src/hub/runtime.ts","scripts/manual/hub-story-fixes-b-m2989/setup.mts"];
const bindings:Record<string,string[]>={}; for(const p of inputs){const hash=digest(readFileSync(join(REPO,p)));(bindings[hash]??=[]).push(p);}
const certs=directoryCertificates(),result:any={head:git("rev-parse","HEAD"),tree:git("rev-parse","HEAD^{tree}"),trackedDirty:git("status","--porcelain","--untracked-files=no"),inputDigests:bindings,servedDigests:{},substitutions:[],cases:[],mode,base,skew,limits:"owned scratch only, fake people/LDAPS, no real AD/account/CLI/native service/pilot",failures:[]};
const get=(port:number,path:string,method="GET",headers:any={},body?:any)=>new Promise<any>((resolve,reject)=>{
 const q=request({host:"127.0.0.1",port,path,method,headers},res=>{let b="";res.on("data",c=>b+=c);res.on("end",()=>resolve({status:res.statusCode,headers:res.headers,text:b,json:()=>JSON.parse(b)}));});q.on("error",reject);q.end(body?JSON.stringify(body):undefined);
});
const https=(port:number,ca:Buffer,path:string)=>new Promise<any>((resolve,reject)=>{const q=httpsRequest({host:"127.0.0.1",port,path,ca,agent:false},res=>{let body="";res.on("data",b=>body+=b);res.on("end",()=>resolve({status:res.statusCode,body}));});q.on("error",reject);q.end();});
const check=(r:any,name:string,value:boolean,detail?:any)=>{r[name]=value?"PASS":{FAIL:detail??true};if(!value)throw Error(name+": "+JSON.stringify(detail));};
const wait=async(fn:()=>boolean)=>{for(let i=0;i<200&&!fn();i++)await new Promise(r=>setTimeout(r,25));if(!fn())throw Error("owned listener did not start");};
const users=[{id:PERSON_ID,login:"avery",dn:"CN=Avery,DC=example,DC=test",password:"Dummy-person-only",eligible:true}];
try{for(const c of matrix()){
 if(loadavg()[0]!>10)throw Error("Paused: host load above 10");
 const name=caseName(c),r:any={case:name};result.cases.push(r);let fm:any,ctx:any,peer:any,runtime:any;const home=mkdtempSync(join(tmpdir(),"hub-setup-ui-"));
 try{
  peer=await groupWirePeer(certs.leaf,users);writeFileSync(join(home,"fleet.yaml"),"# Unrelated settings survive setup\ninstances: {}\nweb:\n  verified_authority:\n    enabled: true\n",{mode:0o600});
  fm=new FleetManager(home);const sink=()=>{};fm.logger={info:sink,warn:sink,error:sink,debug:sink,trace:sink,fatal:sink,child:()=>fm.logger};
  fm.loadConfig(join(home,"fleet.yaml"));fm.initializeWebAuthTokens();fm.startHealthServer(0);await wait(()=>fm.getDashboardAccess().ready);
  const port=fm.healthServer.address().port,origin=`http://127.0.0.1:${port}`,issued=await get(port,"/auth/issue-code","POST",{"x-agend-token":fm.getDashboardAccess().token,origin});
  const login=await get(port,"/auth/login","POST",{"content-type":"application/json",origin},{code:issued.json().code});check(r,"host-login",login.status===200);
  const cookie=login.headers["set-cookie"][0].split(";")[0].split("=");ctx=await browser.newContext({viewport:VIEWPORTS[c.device],colorScheme:c.theme,locale:c.lang==="zh-TW"?"zh-TW":"en-US",isMobile:c.device==="phone",hasTouch:c.device==="phone"});
  await ctx.addCookies([{name:cookie[0],value:cookie[1],url:origin}]);
  fm.webPrefs.write("operator",new Map([["theme",c.theme],["lang",c.lang]]));
  await ctx.addInitScript({content:`window.__name=fn=>fn;localStorage.setItem("agend_tour_done","1");localStorage.setItem("agend_firstrun_dismissed","1");localStorage.setItem("agend_usage_rail","0");window.__csp=[];document.addEventListener("securitypolicyviolation",e=>window.__csp.push(e.violatedDirective));`});
  const page=await ctx.newPage(),errors:string[]=[],wire:any[]=[];page.on("pageerror",(e:any)=>errors.push(e.message));page.on("response",(q:any)=>{if(q.url().includes("/api/settings/hub/setup"))wire.push({path:new URL(q.url()).pathname,status:q.status()});});
  const resources:Promise<void>[]=[];
  page.on("response",(response:any)=>{const u=new URL(response.url());if(/\.(js|css)$/.test(u.pathname))resources.push((async()=>{try{const hash=digest(await response.body()),paths=result.servedDigests[hash]??=[];if(!paths.includes(u.pathname))paths.push(u.pathname);}catch{}})());});
  if(mode==="before"||skew==="old-words"){
    const file=mode==="before"?"settings-hub-setup.js":"settings-hub-setup-strings.js";
    const old=execFileSync("git",["show",base+":src/ui/"+file],{cwd:REPO,encoding:"utf8"});
    result.substitutions.push({ref:base,path:"src/ui/"+file,digest:digest(old)});
    await page.route("**/ui/js/"+file,(route:any)=>route.fulfill({status:200,contentType:"text/javascript",body:old}));
  }
  let afterCommit=false,releaseRead!:()=>void;const readGate=new Promise<void>(r=>{releaseRead=r;});
  await page.route(origin+"/api/settings/hub/setup",async(route:any)=>{
    if(afterCommit&&mode!=="before")await readGate;
    if(afterCommit&&skew==="old-server"){const response=await route.fetch();const body=await response.json();delete body.runtime;await route.fulfill({response,json:body});}
    else await route.continue();
  });
  await page.route(origin+"/api/settings/hub/setup/commit",async(route:any)=>{
    const response=await route.fetch();check(r,"commit-success",response.ok());
    runtime=new HubRuntime({home,log:sink});await runtime.apply({hub:fm.getRawFleetConfig().hub});fm.hubRuntime=runtime;
    afterCommit=true;await route.fulfill({response});
  });
  await page.goto(origin+"/settings/hub");
  await page.locator("#hub-setup").waitFor();await page.locator("#hub-setup button").first().waitFor();
  check(r,"real-shell",await page.locator("#sidebar").count()===1&&await page.locator('.s-nav a[href="/settings/hub"], .s-nav [data-section="hub"], .s-nav a.active').count()>0);
  check(r,"host-mark",await page.evaluate(()=>document.body.dataset.hubSetup==="1"));
  const shot=async(step:string)=>{
    if(!["created","checking","ready","waiting"].includes(step))return;
    const geometry=await page.evaluate(() => {
      const col=document.querySelector(".p-settings .panel-body>.col"),b=col.getBoundingClientRect(),box=document.querySelector("#hub-setup");
      const visible=(e)=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=="hidden";};
      const over=[...box.querySelectorAll("*")].filter(e=>visible(e)&&e.getBoundingClientRect().right>b.right+1).map(e=>e.tagName+"."+e.className);
      const tap=parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tap"))||44;
      const small=innerWidth>600?[]:[...box.querySelectorAll("button,input,select,textarea,summary,a[href]")].filter(e=>{
        if(!visible(e)||e.disabled||e.closest("fieldset[disabled]"))return false;
        let r=e.getBoundingClientRect();if(e.matches('input[type="checkbox"]'))for(const label of e.labels||[])if(label.getBoundingClientRect().height>r.height)r=label.getBoundingClientRect();
        return Math.min(r.width,r.height)<tap-.5;
      }).map(e=>e.tagName+"#"+e.id);
      return {page:document.documentElement.scrollWidth-innerWidth,over,small};
    });
    check(r,"geometry-"+step,geometry.page<=1&&geometry.over.length===0&&geometry.small.length===0,geometry);
    await page.evaluate(()=>{const e=document.querySelector(".p-settings>.panel-body");if(e)e.scrollTop=0;});
    await page.screenshot({path:join(OUT,`${name}-${step}.png`),fullPage:true});

  };
  await shot("before");await page.locator("#hub-setup button").first().click();
  const fill=(key:string,v:string)=>page.locator("#hubSetup-"+key).fill(v);
  const webPort=await freeHubPort();let memberPort=await freeHubPort();while(memberPort===webPort)memberPort=await freeHubPort();
  await fill("webOrigin",`https://127.0.0.1:${webPort}`);await fill("memberOrigin",`https://127.0.0.1:${memberPort}`);await fill("webPort",String(webPort));await fill("memberPort",String(memberPort));
  await shot("addresses");await page.locator('#hub-setup button[type="submit"]').click();
  await fill("realm","fictional");await fill("url",`ldaps://127.0.0.1:${peer.port}`);await fill("baseDn","DC=example,DC=test");await fill("bindDn","CN=Reader,DC=example,DC=test");await fill("bindPassword","Dummy-service-only");
  await page.locator("#hubSetup-ca").selectOption("paste");await fill("caPem",certs.ca);await page.locator('#hub-setup input[type="checkbox"]').waitFor();
  const caText=await page.locator("#hub-setup").innerText();check(r,"ca-fingerprint",caText.includes(new X509Certificate(certs.ca).fingerprint256));
  await page.locator('#hub-setup input[type="checkbox"]').check();await shot("directory");
  check(r,"no-binds-before-test",peer.bindRecords.length===0);await page.locator('#hub-setup button[type="submit"]').click();await fill("administratorLogin","avery");await shot("administrator");
  await page.locator('#hub-setup button[type="submit"]').click();await page.locator('#hub-setup .kv').first().waitFor({timeout:30000});await shot("review");
  check(r,"only-service-binds",peer.bindRecords.length>0&&peer.bindRecords.every((b:any)=>b.password==="Dummy-service-only"));
  check(r,"no-secret-readback",!(await page.locator("#hub-setup").innerText()).includes("Dummy-service-only")&&await page.locator('#hub-setup input[type="password"]').count()===0);
  check(r,"no-early-ready",!await page.locator("#hub-setup").innerText().then((s:string)=>s.includes("Hub created")||s.includes("Hub 已建立")));
  const measure=await page.evaluate(()=>{const col=document.querySelector(".p-settings .panel-body>.col")!,b=col.getBoundingClientRect();return {page:document.documentElement.scrollWidth-innerWidth,over:[...col.querySelectorAll("*")].filter(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().right>b.right+1).map(e=>e.tagName+"."+e.className).slice(0,10)};});
  check(r,"review-overflow",measure.page<=1&&measure.over.length===0,measure);
  await page.locator('#hub-setup button[type="button"].btn-primary').click();
  await page.locator("#hub-setup h3").filter({hasText:c.lang==="en"?"Hub created":"Hub 已建立"}).waitFor();
  if(mode==="before"){
    check(r,"baseline-opens-without-readiness",await page.locator('#hub-setup a[target="_blank"]').count()===1);
    check(r,"baseline-manual-reload",await page.locator('#hub-setup a[href="/settings/hub"]').count()===1);await shot("created");
  }else{
    check(r,"no-link-before-readiness-read",await page.locator('#hub-setup a[target="_blank"]').count()===0);await shot("checking");
    releaseRead();
    if(skew==="old-server"){
      await page.locator("#hub-setup button").filter({hasText:c.lang==="en"?"Check again":"再次檢查"}).waitFor();
      check(r,"missing-readiness-fails-closed",await page.locator('#hub-setup a[target="_blank"]').count()===0);await shot("waiting");
    }else{await page.locator('#hub-setup a[target="_blank"]').waitFor();await shot("ready");}
    check(r,"no-manual-reload",await page.locator('#hub-setup a[href="/settings/hub"]').count()===0);
  }
  releaseRead();
  const raw=fm.getRawFleetConfig();check(r,"sealed-enabled",raw.hub?.enabled===true&&raw.hub?.name===undefined);
  check(r,"no-holds",runtime.currentHolds().length===0,runtime.currentHolds());
  const hub=await https(webPort,readFileSync(join(home,"hub/web-tls/cert.pem")),"/ui/hub");check(r,"verified-hub-https",hub.status===200&&hub.body.includes('data-hub="hub"'));
  const dbMod=createRequire(REPO+"/")("better-sqlite3"),db=new dbMod(join(home,"hub/hub.sqlite"),{readonly:true});try{check(r,"group-off",JSON.parse(db.prepare("SELECT body FROM hub_group_policy WHERE singleton=1").get().body).state==="never-enabled");check(r,"no-admin-session-minted",db.prepare("SELECT count(*) AS n FROM hub_sessions").get().n===0);check(r,"setup-audit-imported",db.prepare("SELECT count(*) AS n FROM hub_web_initialization_audit").get().n>=4);}finally{db.close();}
  check(r,"real-api-only",wire.some((w:any)=>w.path.endsWith("/commit")&&w.status===200)&&wire.every((w:any)=>w.status===200),wire);r.requests=wire;
  await Promise.all(resources);
  check(r,"no-page-errors",errors.length===0,errors);check(r,"no-csp",(await page.evaluate(()=>window.__csp)).length===0);
 }catch(e){r.error=String(e);result.failures.push(name+": "+String(e));}
 finally{await ctx?.close();await fm?.hubSetupController?.close();await fm?.hubRuntime?.close();await runtime?.close();const server=fm?.healthServer;if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));fm.healthServer=null;}fm?.webSessions?.flush?.();await peer?.close();rmSync(home,{recursive:true,force:true});r.cleaned=true;}
 writeFileSync(join(OUT,"receipt.json"),JSON.stringify(result,null,2));
 if(result.failures.length)break;
}}
finally{await browser.close();certs.cleanup();rmSync(envHome,{recursive:true,force:true});result.cleaned=true;writeFileSync(join(OUT,"receipt.json"),JSON.stringify(result,null,2));}
console.log(JSON.stringify({cases:result.cases.length,failures:result.failures,output:OUT}));process.exit(result.failures.length?1:0);
