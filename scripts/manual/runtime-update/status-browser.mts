/** Runtime diagnostics with real product HTTP/Chromium and fake machines; never starts a fleet or native Runtime.
 * REPO=<checkout> PW_DIR=<own playwright-core prefix> PLAYWRIGHT_BROWSERS_PATH=<own browsers> OUT=<own output>
 * npx tsx scripts/manual/runtime-update/status-browser.mts
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, freshPage, mounted } from "../smoke-fixture/index.mts";
const repo=process.env.REPO!, out=process.env.OUT!;if(!repo||!out)throw Error("REPO and OUT required");
mkdirSync(out,{recursive:true,mode:0o700});process.env.AGEND_REMOTE_RUNTIME="1";
const oldHead="941296864bf30e60ee092a356665518401582b63", old=(path:string)=>execFileSync("git",["show",`${oldHead}:${path}`],{cwd:repo,encoding:"utf8"});
const oldI18n=old("src/ui/shared/app-i18n.js"), oldCommands=old("src/ui/runtime-commands.js"), oldPanel=old("src/ui/panel-runtimes.js"), oldNeeds=old("src/ui/panel-needs.js");
const fx=await bootFixture({port:Number(process.env.HP??49096),instances:1,classic:false}), fm=fx.fm;
const {createRuntimeBundle}=await import(repo+"/src/runtime-bundle.ts"), {RuntimeInstallService}=await import(repo+"/src/runtime-install.ts");
const {setLocale}=await import(repo+"/src/locale.ts");
fm.runtimeInstall=new RuntimeInstallService({bundle:()=>createRuntimeBundle({moduleDirectory:join(repo,"dist")}),template:()=>readFileSync(join(repo,"templates/runtime-install/install.ps1"),"utf8")});
const hub=fm.runtimeCoordinator(), target={version:"2.3.5-alpha.12",bundleSha256:"a".repeat(64)}, bootId="22345678-1234-4321-abcd-123456789012";
for(const [n,name,status] of [[1,"Fake desktop · documents",{state:"pending",target}],[2,"Fake laptop · previous build kept",{state:"failed",target}],[3,"Fake shared installation",{state:"manual",reason:"shared"}]] as const){
  const pair=hub.createPairing(),pending=hub.pair({code:pair.code,name,platform:"win32"});hub.approve(pending.machineId,hub.machine(pending.machineId)!.pairingFingerprint);
  const record=(hub as any).state.machines.find((row:any)=>row.machine.id===pending.machineId);
  Object.assign(record.machine,{status:"online",bootId,generation:n,inventory:{home:"C:\\fake",clis:[],probedAt:1},runtimeInfo:{version:"2.3.5-alpha.11",buildId:"b".repeat(64),protocolVersions:[1],capabilities:["exec","managed-update-status-v1"]},updateReport:{bootId,generation:n,reportedAt:Date.now(),status}});
}
fm.startNeedsYou();const results:any[]=[];
try{
for(const device of ["desk","phone"] as const)for(const lang of ["en","zh-TW"] as const)for(const mode of ["fresh","retained","old-panel"] as const){
  const label=`${device}-${lang}-${mode}`, c={device,lang,theme:"dark" as const};let p:any;
  try{
    setLocale(lang);fm.needsYou.poke();
    p=await freshPage(fx,c,{account:"operator",beforeNavigate:async(ctx:any)=>{
      if(mode!=="fresh")await ctx.route("**/assets/app-i18n.js*",(route:any)=>route.fulfill({contentType:"text/javascript",body:oldI18n}));
      if(mode!=="fresh")await ctx.route("**/ui/js/runtime-commands.js*",(route:any)=>route.fulfill({contentType:"text/javascript",body:oldCommands}));
      if(mode==="old-panel"){
        await ctx.route("**/ui/js/panel-runtimes.js*",(route:any)=>route.fulfill({contentType:"text/javascript",body:oldPanel}));
        await ctx.route("**/ui/js/panel-needs.js*",(route:any)=>route.fulfill({contentType:"text/javascript",body:oldNeeds}));
      }
    }});
    const page=p.page;
    if(!await mounted(page,30000))throw Error("App bootstrap did not mount before navigation");
    await page.evaluate(async()=>{await import("/ui/js/runtime-commands.js");});
    // Wait for the initial chat/stream boot before navigating, as a page retained across an upgrade would.
    // Keep the two old-module routes installed: removing routes can interrupt an in-flight import.
    await page.waitForFunction(async()=>{const {appStore}=await import("/assets/app-store.js");return appStore.get().ready;});
    const navigate=async(path:string)=>{await page.evaluate((next:string)=>{history.pushState({},"",next);dispatchEvent(new PopStateEvent("popstate"));},path);};
    await navigate("/settings/runtimes");await page.waitForSelector(".runtime-machine");
    if(mode!=="old-panel")await page.waitForSelector(".runtime-update-notice");
    const cards=await page.locator(".runtime-machines").innerText();
    const need=(ok:boolean,what:string)=>{if(!ok)throw Error(what);};
    need(!/runtimeUpdate\.|needs_reason_/.test(cards),"no raw locale key");
    if(mode!=="old-panel"){
      need(cards.includes(lang==="en"?"Update pending":"更新待執行"),"pending copy");need(cards.includes(lang==="en"?"Update failed":"更新失敗"),"failed copy");
      need(cards.includes(target.version)&&cards.includes("aaaaaaaa")&&cards.includes("2.3.5-alpha.11"),"target and running code are distinct");
      await page.locator('.runtime-update-notice').nth(0).screenshot({path:join(out,`${label}-pending.png`)});
      await page.locator('.runtime-update-notice').nth(1).screenshot({path:join(out,`${label}-failed.png`)});
      const button=page.getByRole("button",{name:lang==="en"?"Show reinstall command":"顯示重新安裝指令"});await button.first().click();await page.waitForSelector(".runtime-command-card");
      const commands=await page.locator(".runtime-command-card").innerText();
      need(commands.includes("AGEND_RUNTIME_INSTALL_DIR")&&commands.includes("[Guid]::NewGuid()"),"fresh separate root");
      need(commands.includes(fm.runtimeInstaller().installer().scriptSha256),"server-pinned script hash");need(!commands.includes("connect --server"),"no new pairing");
      await page.locator(".dlg-x").click();
    }else need(await page.locator(".runtime-update-notice").count()===0,"actual old panel ignores new fields");
    await page.screenshot({path:join(out,`${label}-runtime.png`),fullPage:true});
    await navigate("/ui/needs");await page.waitForSelector(".n-item");
    const needs=await page.locator(".n-item").allInnerTexts();need(needs.some((text:string)=>text.includes(target.version)&&text.includes("aaaaaaaa")),"failed target in Needs you");need(!needs.join(" ").includes("runtime.update."),"no raw server locale key");
    if(mode!=="old-panel"){
      need(await page.locator('.n-item a[href="/settings/runtimes"]').count()===1,"repair navigation without an approval action");
      need((await page.locator('.n-group-head').allInnerTexts()).includes(lang==="en"?"Runtime update needs attention":"Runtime 更新需要處理"),"Runtime has its own heading");
    }
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);need(overflow<=1,"no phone overflow");need(p.errors.length===0,JSON.stringify(p.errors));
    await page.screenshot({path:join(out,`${label}-needs.png`),fullPage:true});results.push({label,pass:true,errors:p.errors});
  }catch(error){results.push({label,pass:false,error:String(error),errors:p?.errors??[]});if(p)await p.page.screenshot({path:join(out,`${label}-failure.png`),fullPage:true});}finally{await p?.ctx.close();}
}
}finally{await fm.stopNeedsYou();hub.close();await fx.close();}
writeFileSync(join(out,"results.json"),JSON.stringify({oldHead,oldModules:[oldI18n,oldCommands,oldPanel,oldNeeds].map(text=>createHash("sha256").update(text).digest("hex")),results},null,2));
console.log(JSON.stringify(results));if(results.some(row=>!row.pass))process.exitCode=1;
