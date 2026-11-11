/** r2 static design gallery; no product behavior is implemented. */
import {readFileSync,writeFileSync,mkdirSync,existsSync} from "node:fs";
import {createHash} from "node:crypto";
import {resolve,join} from "node:path";
import {execFileSync} from "node:child_process";
import {processGuard} from "../../../../../tests/support/process-guard.ts";
import {bootFixture} from "../../../../../scripts/manual/smoke-fixture/index.mts";
import {renderMock} from "../../mock-dom.mjs";
import {renderR2} from "../mock-dom.mjs";
import {renderTextTabs} from "./mock-dom.mjs";
const repo=resolve(process.env.REPO!),out=resolve(process.env.OUT||join(repo,"docs/screenshots/desktop-split-chat-m2889/r2/text-tabs"));
mkdirSync(out,{recursive:true});
const hash=(s:string|Buffer)=>createHash("sha256").update(s).digest("hex");
const git=(...args:string[])=>execFileSync("git",args,{cwd:repo,encoding:"utf8"}).trim();
const inputs=["src/ui/app.html","src/ui/shared/app.css","src/ui/shared/instance-switch.js","src/ui/shared/header-tools.js","src/ui/shared/ui-menu.js","src/ui/shared/app-i18n.js","src/ui/shared/ui-icons.js","src/ui/panel-chat.js","src/ui/panel-log.js","src/ui/shared/app.js","src/ui/shared/app-shell.js","src/ui/shared/chat-composer.js","scripts/manual/smoke-fixture/index.mts","scripts/manual/smoke-fixture/data.mts","scripts/ci/ui-gate-fonts.json","docs/design/desktop-split-chat.md","docs/screenshots/desktop-split-chat-m2889/mock-dom.mjs","docs/screenshots/desktop-split-chat-m2889/mock.css","docs/screenshots/desktop-split-chat-m2889/r2/text-tabs/render.mts","docs/screenshots/desktop-split-chat-m2889/r2/mock-dom.mjs","docs/screenshots/desktop-split-chat-m2889/r2/mock.css","docs/screenshots/desktop-split-chat-m2889/r2/text-tabs/mock-dom.mjs","docs/screenshots/desktop-split-chat-m2889/r2/text-tabs/mock.css"];
const receipt:any={schema:2,scope:"Single-text-tabs r2 addendum static design composition over real disposable app shell. Pop-out comparison uses two cloned app surfaces with illustrative browser frames, not a functional popup. No product/drag/keyboard/URL/a11y/SKEW/performance acceptance.",head:git("rev-parse","HEAD"),tree:git("rev-parse","HEAD^{tree}"),workingTree:git("status","--short"),viewport:{width:1600,height:1000},lang:"zh-TW",theme:"light",inputs:inputs.map(p=>({[hash(readFileSync(join(repo,p)))]:p})),served:[],cases:[],guardViolations:[],cleanup:false};
if(!process.env.FONTCONFIG_FILE||!existsSync(process.env.FONTCONFIG_FILE))throw Error("Prepare pinned CJK fonts first");
receipt.fontconfig=hash(readFileSync(process.env.FONTCONFIG_FILE));receipt.classicScrollbars=process.env.PW_SCROLLBARS==="1";
const support=readFileSync(new URL("../mock.css",import.meta.url),"utf8").split("\n");
const supportingCss=support.slice(support.findIndex(s=>s.startsWith(".r2-workspace .mock-float {"))).filter(s=>!s.includes("inst-switch")&&!s.includes(".panel-head")).join("\n");
const css=readFileSync(new URL("../../mock.css",import.meta.url),"utf8")+"\n"+supportingCss+"\n"+readFileSync(new URL("./mock.css",import.meta.url),"utf8");
const iconSource=readFileSync(join(repo,"src/ui/shared/ui-icons.js"),"utf8");
const tabIcons=Object.fromEntries(Object.entries({chat:"chat",view:"view",log:"file",details:"settings"}).map(([id,key])=>{
 const line=iconSource.split("\n").find(l=>l.startsWith("  "+key+":"))!;
 const paths=line.split("html"+String.fromCharCode(96))[1]!.split(String.fromCharCode(96))[0]!;
 return [id,'<svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'+paths+'</svg>'];
}));
const fx=await bootFixture({port:Number(process.env.PORT||49470),instances:4,classic:false,webYaml:"  log_tab: true"});
try {
 const agentIds=fx.instances.filter(i=>!i.general).slice(0,2).map(i=>i.name);
 const a=agentIds[0]!,now=Date.now()-60000;
 fx.seedTheme(a,{card:{tagline:"本機設計稿：提案與比較"}});
 fx.fm.emitSseEvent("message",{instance:a,sender:"你",role:"user",text:"請比較兩個方案，整理成可以直接轉貼的重點。",ts:new Date(now).toISOString()});
 fx.fm.emitSseEvent("message",{instance:a,sender:a,role:"agent",text:"保留每個 Agent 的聊天、視窗、紀錄與設定。\n\n- 預設左右並排\n- 拖標頭重新排列\n- 引用後仍由人送出",ts:new Date(now+10000).toISOString()});
 const log=await fx.page({device:"desk",theme:"light",lang:"zh-TW"},{path:"/ui/log/"+encodeURIComponent(a)});
 let logHTML:string;
 try {await log.page.waitForSelector(".p-log .log-col"); logHTML=await log.page.locator(".p-log").evaluate((e:any)=>e.outerHTML);}
 finally {await log.ctx.close();}
 const p=await fx.page({device:"desk",theme:"light",lang:"zh-TW"},{path:"/ui/chat/"+encodeURIComponent(a)});
 try {
  await p.page.setViewportSize(receipt.viewport);
  await p.page.route("**/assets/app.css*",async(route:any)=>{const response=await route.fetch();await route.fulfill({response,body:await response.text()+"\n"+css});});
  for(const scene of ["baseline","right","log","float","narrow360","popout"]) {
   await p.page.reload();await p.page.waitForSelector(".p-chat .dock");await p.page.waitForSelector(".p-chat .chat-card-menu");
   await p.page.evaluate(async()=>{await document.fonts.ready;});
   const sourceMeta=await p.page.evaluate(()=>({labels:[...document.querySelectorAll(".p-chat .inst-switch .seg-item")].map(x=>x.textContent),styles:[...document.querySelectorAll(".p-chat .inst-switch .seg-item")].map(x=>({active:x.classList.contains("active"),values:Object.fromEntries(["font-size","font-family","font-weight","line-height","padding-left","padding-right","border-radius","min-height","color","background-color"].map(k=>[k,getComputedStyle(x).getPropertyValue(k)]))})),card:document.querySelectorAll(".p-chat .chat-card-menu").length,font:document.querySelectorAll(".p-chat .hd-text").length,usage:document.querySelectorAll(".p-chat .hd-usage").length}));
   if(scene==="baseline"){receipt.originalTopBar=sourceMeta;await p.page.screenshot({path:join(out,"light-baseline.png")});receipt.cases.push({file:"light-baseline.png",scene,original:sourceMeta});continue;}
   const originalMenu=p.page.locator(".p-chat .panel-actions > .menu").last();
   await originalMenu.locator("button").first().click();await originalMenu.locator(".menu-list").waitFor();
   const pageMenuHTML=await originalMenu.locator(".menu-list").evaluate((e:any)=>e.outerHTML);await p.page.keyboard.press("Escape");
   const headHTML=await p.page.locator(".p-chat .panel-head").evaluate((e:any)=>e.outerHTML);
   if(!["single","sidebar"].includes(scene))await p.page.evaluate(renderMock,{scene:scene==="stack"?"stack":scene==="float"?"float":"right"});
   await p.page.evaluate(renderR2,{scene,headHTML,logHTML,tabIcons});
   await p.page.evaluate(renderTextTabs,{scene,headHTML,pageMenuHTML,agentIds});
   await p.page.evaluate(async()=>{await document.fonts.ready;});
   await p.page.screenshot({path:join(out,"light-"+scene+".png")});
   const geometry=await p.page.evaluate((original)=>{
    const panes=[...document.querySelectorAll(".mock-pane")].map(e=>{
     const r=e.getBoundingClientRect(),field=e.querySelector("textarea"),head=e.querySelector(".panel-head"),name=head.querySelector("h1"),nav=head.querySelector(".inst-switch"),actions=head.querySelector(".panel-actions");
     const links=[...nav.querySelectorAll(".seg-item")],visible=links.filter(x=>!x.hidden),hidden=links.filter(x=>x.hidden);
     const boxes=[name,nav,actions].map(x=>{const b=x.getBoundingClientRect();return {left:b.left,right:b.right,cy:(b.top+b.bottom)/2};});
     const styleParity=links.every(x=>{const expected=original.styles.find(y=>y.active===x.classList.contains("active")).values;return Object.entries(expected).every(([k,v])=>getComputedStyle(x).getPropertyValue(k)===v);});
     const visibleLabels=visible.map(x=>x.textContent),hiddenLabels=hidden.map(x=>x.textContent);
     return {pane:e.getAttribute("data-mock-pane"),width:r.width,allLabels:links.map(x=>x.textContent),visibleLabels,hiddenLabels,tabIcons:nav.querySelectorAll("svg,img").length,styleParity,singleRow:Math.max(...boxes.map(b=>b.cy))-Math.min(...boxes.map(b=>b.cy))<3,noOverlap:boxes[0].right<=boxes[1].left+1&&boxes[1].right<=boxes[2].left+1&&boxes[2].right<=r.right,activeVisible:links.some(x=>!x.hidden&&x.classList.contains("active")),nameTruncated:name.scrollWidth>name.clientWidth,sharedTools:e.querySelectorAll(".page-shared-tools").length,overflow:e.scrollWidth>e.clientWidth,draftClipped:field?field.scrollHeight>field.clientHeight:false,overflowMenuLabels:[...e.querySelectorAll("[data-overflow-tab]")].map(x=>x.textContent)};
    });
    const ids=[...document.querySelectorAll("[id]")].map(e=>e.id);
    return {panes,sharedGroups:document.querySelectorAll(".page-shared-tools").length,card:document.querySelectorAll(".page-shared-tools .chat-card-menu").length,font:document.querySelectorAll(".page-shared-tools .hd-text").length,usage:document.querySelectorAll(".page-shared-tools .hd-usage").length,duplicateIds:ids.filter((x,i)=>ids.indexOf(x)!==i),documentOverflow:document.documentElement.scrollWidth>innerWidth};
   },sourceMeta);
   const groups=scene==="popout"?2:1;
   if(geometry.documentOverflow||geometry.duplicateIds.length||[geometry.sharedGroups,geometry.card,geometry.font,geometry.usage].some(n=>n!==groups)||geometry.panes.some(p=>p.overflow||p.draftClipped||!p.singleRow||!p.noOverlap||!p.activeVisible||!p.styleParity||p.tabIcons!==0||JSON.stringify(p.allLabels)!==JSON.stringify(sourceMeta.labels)))throw Error("Invalid original-tab geometry "+scene+" "+JSON.stringify(geometry));
   if(scene==="narrow360"&&(!geometry.panes[0].nameTruncated||geometry.panes[0].width!==360||geometry.panes[0].hiddenLabels.length<1||JSON.stringify(geometry.panes[0].hiddenLabels)!==JSON.stringify(geometry.panes[0].overflowMenuLabels)))throw Error("Minimum-pane text overflow failed");
   receipt.cases.push({file:"light-"+scene+".png",scene,geometry});
   if(scene==="right")receipt.served=await p.page.evaluate(async()=>{
    const urls=[...new Set(performance.getEntriesByType("resource").map((r:any)=>r.name).filter((s:string)=>/\.(?:js|css)(?:\?|$)/.test(s)))],out=[];
    for(const url of urls){const bytes=await(await fetch(url)).arrayBuffer();const digest=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(b=>b.toString(16).padStart(2,"0")).join("");out.push({[digest]:new URL(url).pathname});}return out;
   });
  }
 } finally {await p.page.unrouteAll({behavior:"wait"});await p.ctx.close();}
 receipt.guardViolations=processGuard.takeViolations();if(receipt.guardViolations.length)throw Error("Process guard violations");
} finally {await fx.close();receipt.cleanup=true;writeFileSync(join(out,"receipt.json"),JSON.stringify(receipt,null,2)+"\n");}
console.log(JSON.stringify({cases:receipt.cases.length,guardViolations:receipt.guardViolations,cleanup:receipt.cleanup}));
