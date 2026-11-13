/** Owned cookie/HTTP UI rehearsal; no Fleet start, CLI, account or settings writes. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadavg } from "node:os";
import { bootFixture } from "../smoke-fixture/index.mts";
const repo=resolve(process.env.REPO!),out=resolve(process.env.OUT!);
const git=(...a:string[])=>execFileSync("git",a,{cwd:repo,encoding:"utf8"}).trim();
const digest=(b:string|Buffer)=>createHash("sha256").update(b).digest("hex");
const dirty=!!git("status","--porcelain","--untracked-files=no");assert.ok(!dirty||process.env.DIAGNOSTIC_DIRTY==="1");
assert.ok(loadavg()[0]<=10,"pause above host load10");
const theme=process.env.THEME||"light",language=process.env.LANGUAGE||"zh-TW",phone=process.env.SCREEN==="phone",retain=process.env.RETAIN||"";
const oldRef="8ac895063b4309b83b5d847e529c585a244b6d80";
const changed=["src/ui/shared/instance-nav.js","src/ui/panel-details.js","src/ui/chat-workspace.js","src/ui/chat-popout-header.js"];
const sources=[...changed,"src/ui/shared/app-shell.js","src/ui/shared/app-nav.js","src/ui/shared/app-route.js","src/ui/shared/app-store.js","src/ui/shared/app-ctx.js","src/ui/shared/app-i18n.js","src/ui/shared/app.css","src/ui/shared/tokens.css","src/ui/agent-details-settings.js","src/ui/settings-dialogs.js","src/web-api.ts","src/fleet-manager.ts","scripts/manual/smoke-fixture/index.mts","scripts/manual/smoke-fixture/data.mts"];
const inputs:Record<string,string[]>={},assets:Record<string,string[]>={},substitutions:Record<string,string[]>={};
const record=(m:Record<string,string[]>,path:string,b:string|Buffer)=>{const paths=m[digest(b)]||=[];if(!paths.includes(path))paths.push(path);};
for(const p of sources)record(inputs,p,readFileSync(join(repo,p)));record(inputs,"harness",readFileSync(new URL(import.meta.url)));mkdirSync(out,{recursive:true});
const receipt:any={head:git("rev-parse","HEAD"),tree:git("rev-parse","HEAD^{tree}"),dirty,theme,language,phone,retain,oldRef,inputs,assets,substitutions,cases:[],errors:[],effects:[],previews:[],external:[],scope:"Owned scratch FleetManager with real cookie/HTTP/SSE/UI; fixture status and names, no Fleet start/CLI/account/AD/live work; edit unsaved description only, never Apply"};
const fx=await bootFixture({port:Number(process.env.HP||56046),instances:6,classic:false});let ctx:any;const jobs:Promise<unknown>[]=[];
try{
 receipt.browserVersion=fx.browser.version();const a=fx.instances[1].name,b=fx.instances[2].name,status=fx.fm.getUiStatus.bind(fx.fm);
 fx.fm.getUiStatus=(...args:any[])=>{const s=status(...args);return {...s,instances:s.instances.map((it:any)=>({...it,...(it.name===a?{display_name:"Cairn"}:{}),...(it.name===b?{display_name:"AgEnD Leader"}:{})}))};};
 fx.fm.webPrefs.write("operator",new Map([["theme",theme],["lang",language],["nav.favorites",[a]]]));
 ctx=await fx.browser.newContext({viewport:phone?{width:390,height:844}:{width:1600,height:1000},colorScheme:theme,locale:language,hasTouch:phone});
 await ctx.addInitScript({content:"window.__name = (f) => f;"});
 await ctx.addInitScript(()=>{const Source=window.EventSource;(window as any).__streams={active:0,max:0};window.EventSource=class extends Source{ended=false;constructor(url:string|URL,opts?:EventSourceInit){super(url,opts);const c=(window as any).__streams;c.max=Math.max(c.max,++c.active);}close(){if(!this.ended){this.ended=true;(window as any).__streams.active--;}super.close();}};for(const key of ["agend_tour_done","agend_firstrun_dismissed","agend_prefs_synced"])localStorage.setItem(key,"1");});
 const page=await ctx.newPage();page.setDefaultTimeout(10000);page.on("pageerror",(e:Error)=>receipt.errors.push(e.message));
 ctx.on("request",(r:any)=>{const u=new URL(r.url());if(u.origin!==fx.base&&!["data:","blob:"].includes(u.protocol))receipt.external.push(u.origin);if(r.method()!=="GET"&&u.pathname!=="/auth/login"){if(u.pathname==="/api/settings/status-emojis/preview"&&r.method()==="POST")receipt.previews.push(u.pathname);else receipt.effects.push({path:u.pathname,method:r.method()});}});
 page.on("response",(r:any)=>{const u=new URL(r.url());if(u.origin===fx.base&&/\.(js|css)$/.test(u.pathname))jobs.push(r.body().then((bytes:Buffer)=>record(assets,u.pathname,bytes)).catch(()=>{(receipt.omitted||=[]).push(u.pathname);}));});
 await page.route("**/*",async(route:any)=>{const u=new URL(route.request().url());if(u.origin!==fx.base&&!["data:","blob:"].includes(u.protocol))return route.abort();const p=u.pathname.startsWith("/assets/")?"src/ui/shared/"+u.pathname.slice(8):u.pathname.startsWith("/ui/js/")?"src/ui/"+u.pathname.slice(7):"";const keep=retain==="all"?changed:retain==="sidebar"?[changed[0]]:retain==="details"?[changed[1]]:retain==="workspace"?[changed[2]]:retain==="popup"?[changed[3]]:[];if(keep.includes(p)){const bytes=execFileSync("git",["show",`${oldRef}:${p}`],{cwd:repo});record(substitutions,p,bytes);return route.fulfill({body:bytes,contentType:"text/javascript"});}return route.continue();});
 const {tokenEpoch}=await import(repo+"/src/web-session.ts");fx.fm.initializeWebSessions();const code=fx.fm.webLoginCodes.issue({tier:"admin",epoch:tokenEpoch(fx.fm.webToken)}).display;
 await page.goto(fx.base+"/signin");await page.locator("#code").evaluate((el:HTMLInputElement,code:string)=>{el.value=code;el.dispatchEvent(new Event("input",{bubbles:true}));el.form!.requestSubmit();},code);await page.waitForURL(fx.base+"/ui");
 const tr=(en:string,zh:string)=>language==="en"?en:zh,details=(name:string)=>`/ui/fleet/agent/${encodeURIComponent(name)}`,chat=(name:string)=>`/ui/chat/${encodeURIComponent(name)}`;
 const go=async(path:string)=>{await page.evaluate(async(path:string)=>(await import("/assets/app-nav.js")).navigate(path),path);};
 const settings=async(name:string)=>{await go(details(name)+"?cat=basic");await page.locator('.p-details input[id$="ag-desc"]').waitFor();};
 const showSidebar=async()=>{if(phone){await page.locator("#sbOpen").click();await page.waitForFunction(()=>document.querySelector("#sidebar")!.getBoundingClientRect().left>=-.5);}};
 const row=(name:string)=>page.locator(`.inst-nav a.inst[href$="/${encodeURIComponent(name)}"]`).first();
 const check=(label:string,value:unknown)=>receipt.cases.push({label,value});
 async function shot(label:string){await page.evaluate(async()=>{await document.fonts.ready;await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);});assert.ok(loadavg()[0]<=10,"load above10: close owned browser and pause");const geometry=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,streams:(window as any).__streams,buttons:[...document.querySelectorAll<HTMLElement>('.agent-back-chat,.ws-pane-close')].map(el=>{const r=el.getBoundingClientRect();return{label:el.getAttribute("aria-label"),x:r.x,y:r.y,width:r.width,height:r.height,visible:r.width>0&&r.height>0};})}));assert.equal(geometry.overflow,false);assert.deepEqual(geometry.streams,{active:1,max:1});if(phone&&!retain)for(const r of geometry.buttons.filter((r:any)=>r.visible))assert.ok(r.width>=44&&r.height>=44);const file=`${theme}-${language}-${label}.png`;await page.screenshot({path:join(out,file)});receipt.cases.push({label,file,geometry});}
 await settings(a);await shot("settings");
 if(retain==="all"||retain==="details"){
  assert.equal(await page.locator(".agent-back-chat").count(),0);await showSidebar();await row(a).press("Enter");
  if(retain==="all"){await page.waitForURL(fx.base+details(a));assert.equal(await page.locator("#msgIn").count(),0);check("baseline","selected row stays on Settings; no Settings X");}
  else{await page.locator("#msgIn").waitFor();check("retained-details","new selected-row link opens Chat; old Settings has no X");}
 }else{
  const back=page.locator(".agent-back-chat");assert.equal(await back.getAttribute("aria-label"),tr("Back to chat","回到聊天"));
  await showSidebar();await row(a).focus();await row(a).press("Enter");
  if(retain==="sidebar"){await page.waitForURL(fx.base+details(a));await back.click();check("retained-sidebar","old row keeps Settings; current X opens Chat");}
  await page.locator("#msgIn").waitFor();check("native-enter",retain==="sidebar"?"legacy row + current X":"real Enter opens the selected agent Chat");
  if(!retain){
   await settings(a);await showSidebar();await row(b).click();await page.waitForURL(fx.base+details(b));await page.locator('.p-details .panel-title h1').filter({hasText:b}).waitFor();
   assert.equal(await row(b).getAttribute("href"),chat(b));await showSidebar();await row(b).click();await page.locator("#msgIn").waitFor();check("second-click","first click changes agent and keeps Settings; second click opens Chat");
   await settings(a);const field=page.locator('.p-details input[id$="ag-desc"]');await field.fill("Unsent M-2960 note");await page.locator(".s-pending").waitFor();
   await page.locator(".agent-back-chat").click();await page.locator('dialog[open] [data-confirm="yes"]').waitFor();await page.locator('dialog[open]').getByRole("button",{name:tr("Cancel","取消"),exact:true}).click();
   assert.equal(await field.inputValue(),"Unsent M-2960 note");assert.ok(page.url().includes(details(a)));check("cancel-preserves-draft","Back to chat asks the existing unsaved-settings guard; Cancel keeps the draft");
   await page.locator(".agent-back-chat").click();await page.locator('dialog[open] [data-confirm="yes"]').click();await page.locator("#msgIn").waitFor();await shot("returned-chat");
  }
  if(!phone){
   const target=row(b).locator("xpath=..");await target.hover();await target.locator(".inst-row-menu > button").click();await target.getByRole("menuitem",{name:tr("Open beside","在旁邊開啟"),exact:true}).click();
   await page.locator('[data-pane="a"] textarea').fill("Preserved peer draft");await go(details(b)+"?cat=basic");await page.locator('[data-pane="b"] input[id$="ag-desc"]').waitFor();await shot("split-settings");
   const close=page.locator('[data-pane="b"] .ws-pane-close');
   if(retain==="workspace"){assert.equal(await close.getAttribute("aria-label"),tr("Close this pane","收起此格"));await row(b).press("Enter");check("retained-workspace","old header keeps its old Close pane label; new sidebar returns focus to Chat");}
   else{assert.equal(await close.getAttribute("aria-label"),tr("Back to chat","回到聊天"));await close.click();}
   await page.locator('[data-pane="b"] textarea').waitFor();assert.equal(await page.locator(".ws-pane").count(),2);assert.equal(await page.locator('[data-pane="a"] textarea').inputValue(),"Preserved peer draft");check("split-back","own pane returns to Chat, peer draft and two-pane layout preserved");await shot("split-returned-chat");
  }
 }
 await Promise.all(jobs);assert.deepEqual(receipt.errors,[]);assert.deepEqual(receipt.effects,[]);assert.deepEqual(receipt.external,[]);receipt.completed=true;
}finally{await ctx?.close();await fx.close();for(const p of sources)assert.ok(inputs[digest(readFileSync(join(repo,p)))]?.includes(p),`source changed:${p}`);writeFileSync(join(out,"receipt.json"),JSON.stringify(receipt,null,2)+"\n");}
console.log(JSON.stringify({out,checks:receipt.cases.length,errors:receipt.errors.length}));
