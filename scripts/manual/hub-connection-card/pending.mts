/** S-119 retained #3487/#3491 controls. Actual Fleet Settings and its Settings confirmation gate, no Hub request until local approval.
 * REPO=$PWD OUT=<owned-output> PW_DIR=<private-playwright> CHROME=<binary> node --import tsx <this-file>
 * MATRIX=full default. The timeout leg advances only the browser clock, never the server authorization deadline.
 */
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,chmodSync,rmSync,existsSync} from "node:fs";
import {resolve,join,dirname} from "node:path";
import {execFileSync} from "node:child_process";
const repo=resolve(process.env.REPO!),out=resolve(process.env.OUT!);mkdirSync(out,{recursive:true});
const home=mkdtempSync(join(out,"owned-")),bin=join(home,"bin");mkdirSync(bin);
process.env.AGEND_HOME=home;process.env.TMUX_TMPDIR=join(home,"tmux");
for(const k of ["OPENAI_API_KEY","ANTHROPIC_API_KEY","DISCORD_BOT_TOKEN","TELEGRAM_BOT_TOKEN"])delete process.env[k];
for(const name of ["tmux","agend","claude","codex","kiro-cli"]){const file=join(bin,name);writeFileSync(file,`#!${process.execPath}\nprocess.exit(97)\n`);chmodSync(file,0o755)}
process.env.PATH=[bin,dirname(process.execPath),"/usr/bin","/bin"].join(":");process.env.AGEND_TMUX_BIN=join(bin,"tmux");
const {bootFixture,matrix,caseName}=await import("../smoke-fixture/index.mts");
const r:any={head:execFileSync("git",["rev-parse","HEAD"],{cwd:repo,encoding:"utf8"}).trim(),checks:[],shots:[],errors:[],foreign:[],cases:[],assetSkew:!!process.env.ASSET_ROOT,scope:"Real Fleet HTTP/browser/Settings gate; dummy Hub address is never contacted. No native/model/account/live fleet. Browser-only clock for timeout."};
const check=(name:string,ok:boolean,detail?:unknown)=>{r.checks.push({name,ok,detail});if(!ok)throw Error(name)};
let fx:any;
try{
 fx=await bootFixture({port:Number(process.env.HP??54910),instances:1,classic:false});r.browser=fx.browser.version();
 for(const name of ["startInstance","startInstanceUnattended","restartInstance","restartFleet","stopInstance"])fx.fm[name]=async()=>{throw Error("Refused lifecycle "+name)};
 const measureSource=readFileSync(join(repo,"scripts/manual/smoke/smoke-settings-ui-gate.mts"),"utf8");
 const raw=/const MEASURE = (`[\s\S]*?`);/.exec(measureSource);if(!raw)throw Error("Shared style measure missing");const measure=new Function("return "+raw[1])();
 const shot=async(p:any,name:string)=>{await p.evaluate(()=>document.fonts.ready);await p.screenshot({path:join(out,name+".png"),fullPage:true});r.shots.push(name)};
 for(const c of matrix()){
  const tag=caseName(c),zh=c.lang==="zh-TW",{ctx,page:p}=await fx.page(c,{path:"/settings/hub"});
  try{
   ctx.on("page",(p:any)=>p.on("pageerror",(e:Error)=>r.errors.push({tag,message:e.message})));
   await ctx.route("**/*",(route:any)=>{const u=new URL(route.request().url());if(u.origin!==fx.base){r.foreign.push(u.origin);return route.abort()}const assets=process.env.ASSET_ROOT;
    if(assets&&(u.pathname.startsWith("/assets/")||u.pathname.startsWith("/ui/js/"))){const file=join(resolve(assets),u.pathname.split("/").pop()!);if(existsSync(file))return route.fulfill({path:file,contentType:file.endsWith(".css")?"text/css":"application/javascript"});}
    return route.continue()});
   if(process.env.ASSET_ROOT)await p.reload();
   await p.locator("#hubCompanyAddress").waitFor();await p.fill("#hubCompanyAddress","https://synthetic-hub.example.test");await p.fill("#hubCompanyFleetName","QA Fleet");
   const response=p.waitForResponse((q:any)=>new URL(q.url()).pathname.endsWith("/company-join/start")&&q.request().method()==="POST"),popup=ctx.waitForEvent("page");
   await p.locator(".s-company-join button[type=submit]").click();const first=await response,body=await first.json(),wait=await popup;wait.setDefaultTimeout(15000);
   const id=body.pending_change?.id;check(tag+" actual non-host Start is held",first.status()===202&&typeof id==="string");
   await wait.waitForLoadState("domcontentloaded");await wait.getByText(zh?"需要先完成本機確認，Hub 登入尚未開始。":"Local confirmation is required. Hub sign-in has not started.",{exact:true}).waitFor();
   check(tag+" loaded wait has no skeleton",await wait.locator(".s-company-join .skeleton").count()===0);
   await shot(wait,tag+"-waiting");
   await wait.locator(".s-company-join").getByRole("button",{name:zh?"開啟本機確認":"Review local confirmation",exact:true}).click();
   await wait.locator(".pending-card[data-pending='"+id+"']").waitFor();await shot(wait,tag+"-review");
   const m=await wait.evaluate(measure);check(tag+" shared gate frame/overflow/accent",new Set(m.cards.map((x:any)=>x.frame)).size<=1&&m.overCount===0&&m.pageX<=0&&m.accentCount===0,m);
   if(c.device==="phone"){
    const tap=await wait.locator(".company-local-wait button,.company-local-wait a").evaluateAll((es:any[])=>es.map(e=>({label:e.textContent,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height})));
    check(tag+" new phone controls meet tap size",tap.length>=2&&tap.every((b:any)=>b.w>=43.5&&b.h>=43.5),tap);
   }
   if(zh){
    await wait.clock.install();await wait.reload();await wait.getByText("需要先完成本機確認，Hub 登入尚未開始。",{exact:true}).waitFor();
    await wait.clock.fastForward(300001);await wait.getByText("等候本機確認的時間已到，目前仍未確認這次連接的結果。請先檢查這次請求，再開始其他連接。",{exact:true}).waitFor();
    check(tag+" timeout retains inspect and exit",await wait.locator('.s-company-join a[href="/settings/hub"]').count()===1&&await wait.locator('.s-company-join').getByRole('button',{name:'再次檢查',exact:true}).count()===1);
    const current=await(await ctx.request.get(fx.base+"/api/settings/pending/"+id)).json();check(tag+" local timeout does not decide server authorization",current.state==="pending");
    await shot(wait,tag+"-timeout");
   }
   await p.locator(".s-company-join").getByRole("button",{name:zh?"開啟本機確認":"Review local confirmation",exact:true}).click();
   await p.locator(".pending-card[data-pending='"+id+"']").getByRole("button",{name:zh?"撤回":"Withdraw",exact:true}).click();
   await p.getByText(zh?"已撤回本機確認，尚未開始 Hub 登入。":"Local confirmation was withdrawn. Hub sign-in did not start.",{exact:true}).waitFor();
   const final=await(await ctx.request.get(fx.base+"/api/settings/pending/"+id)).json();
   check(tag+" exact withdrawal known",final.state==="rejected"&&final.outcome?.reason_code==="withdrawn");
   const operation=await(await ctx.request.get(fx.base+"/api/hub/member/company-join")).json();check(tag+" no enrollment created",operation.operation===null);
   await shot(p,tag+"-withdrawn");check(tag+" no CSP",(await p.evaluate(()=>((window as any).__csp??[]))).length===0);
   r.cases.push({tag,ok:true,pendingId:id});
  }finally{await ctx.close()}
 }
 check("nonempty matrix",r.cases.length===matrix().length&&r.cases.length>0);check("no page errors/foreign requests",r.errors.length===0&&r.foreign.length===0);r.status="PASS";
}catch(e:any){r.status="FAIL";r.error=e.stack;process.exitCode=1}
finally{if(fx)await fx.close();rmSync(home,{recursive:true,force:true});r.cleaned=true;writeFileSync(join(out,"receipt.json"),JSON.stringify(r,null,2));console.log(JSON.stringify({status:r.status,cases:r.cases.length,checks:r.checks.length,shots:r.shots.length,error:r.error}));}
