/** r2 static design gallery; no product behavior is implemented. */
import {readFileSync,writeFileSync,mkdirSync,existsSync} from "node:fs";
import {createHash} from "node:crypto";
import {resolve,join} from "node:path";
import {execFileSync} from "node:child_process";
import {processGuard} from "../../../../../tests/support/process-guard.ts";
import {bootFixture} from "../../../../../scripts/manual/smoke-fixture/index.mts";
import {renderMock} from "../../mock-dom.mjs";
import {renderR2} from "../mock-dom.mjs";
import {renderHeaderRow} from "./mock-dom.mjs";
const repo=resolve(process.env.REPO!),out=resolve(process.env.OUT||join(repo,"docs/screenshots/desktop-split-chat-m2889/r2/header-row"));
mkdirSync(out,{recursive:true});
const hash=(s:string|Buffer)=>createHash("sha256").update(s).digest("hex");
const git=(...args:string[])=>execFileSync("git",args,{cwd:repo,encoding:"utf8"}).trim();
const inputs=["src/ui/app.html","src/ui/shared/app.css","src/ui/shared/instance-switch.js","src/ui/shared/ui-icons.js","src/ui/panel-chat.js","src/ui/panel-log.js","src/ui/shared/app.js","src/ui/shared/app-shell.js","src/ui/shared/chat-composer.js","scripts/manual/smoke-fixture/index.mts","scripts/manual/smoke-fixture/data.mts","scripts/ci/ui-gate-fonts.json","docs/design/desktop-split-chat.md","docs/screenshots/desktop-split-chat-m2889/mock-dom.mjs","docs/screenshots/desktop-split-chat-m2889/mock.css","docs/screenshots/desktop-split-chat-m2889/r2/header-row/render.mts","docs/screenshots/desktop-split-chat-m2889/r2/mock-dom.mjs","docs/screenshots/desktop-split-chat-m2889/r2/mock.css","docs/screenshots/desktop-split-chat-m2889/r2/header-row/mock-dom.mjs","docs/screenshots/desktop-split-chat-m2889/r2/header-row/mock.css"];
const receipt:any={schema:2,scope:"Single-header-row r2 addendum static design composition over real disposable app shell. Pop-out comparison uses two cloned app surfaces with illustrative browser frames, not a functional popup. No product/drag/keyboard/URL/a11y/SKEW/performance acceptance.",head:git("rev-parse","HEAD"),tree:git("rev-parse","HEAD^{tree}"),workingTree:git("status","--short"),viewport:{width:1600,height:1000},lang:"zh-TW",theme:"light",inputs:inputs.map(p=>({[hash(readFileSync(join(repo,p)))]:p})),served:[],cases:[],guardViolations:[],cleanup:false};
if(!process.env.FONTCONFIG_FILE||!existsSync(process.env.FONTCONFIG_FILE))throw Error("Prepare pinned CJK fonts first");
receipt.fontconfig=hash(readFileSync(process.env.FONTCONFIG_FILE));receipt.classicScrollbars=process.env.PW_SCROLLBARS==="1";
const css=readFileSync(new URL("../../mock.css",import.meta.url),"utf8")+"\n"+readFileSync(new URL("../mock.css",import.meta.url),"utf8")+"\n"+readFileSync(new URL("./mock.css",import.meta.url),"utf8");
const iconSource=readFileSync(join(repo,"src/ui/shared/ui-icons.js"),"utf8");
const tabIcons=Object.fromEntries(Object.entries({chat:"chat",view:"view",log:"file",details:"settings"}).map(([id,key])=>{
 const line=iconSource.split("\n").find(l=>l.startsWith("  "+key+":"))!;
 const paths=line.split("html"+String.fromCharCode(96))[1]!.split(String.fromCharCode(96))[0]!;
 return [id,'<svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'+paths+'</svg>'];
}));
const fx=await bootFixture({port:Number(process.env.PORT||49470),instances:4,classic:false,webYaml:"  log_tab: true"});
try {
 const a=fx.instances.find(i=>!i.general)!.name,now=Date.now()-60000;
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
  for(const scene of ["right","log","float","popout","narrow360"]) {
   await p.page.reload();await p.page.waitForSelector(".p-chat .dock");
   const headHTML=await p.page.locator(".p-chat .panel-head").evaluate((e:any)=>e.outerHTML);
   if(!["single","sidebar"].includes(scene))await p.page.evaluate(renderMock,{scene:scene==="stack"?"stack":scene==="float"?"float":"right"});
   await p.page.evaluate(renderR2,{scene,headHTML,logHTML,tabIcons});
   await p.page.evaluate(renderHeaderRow,{scene});
   await p.page.evaluate(async()=>{await document.fonts.ready;});
   await p.page.screenshot({path:join(out,"light-"+scene+".png")});
   const geometry=await p.page.evaluate(()=>{
    const panes=[...document.querySelectorAll(".mock-pane")].map(e=>{
     const r=e.getBoundingClientRect(),field=e.querySelector("textarea"),tabs=[...e.querySelectorAll(".inst-switch .seg-item")].map(t=>t.textContent);
     const head=e.querySelector(".panel-head"),name=head.querySelector("h1"),nav=head.querySelector(".inst-switch"),actions=head.querySelector(".panel-actions");
     const [hb,nb,tb,ab]=[head,name,nav,actions].map(n=>{const b=n.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,cy:(b.top+b.bottom)/2,width:b.width,height:b.height};});
     const singleRow=Math.max(nb.cy,tb.cy,ab.cy)-Math.min(nb.cy,tb.cy,ab.cy)<3;
     const labelsVisible=[...nav.querySelectorAll(".r3-tab-label")].every(x=>getComputedStyle(x).display!=="none");
     const tabNames=[...nav.querySelectorAll(".seg-item")].every(x=>x.title===x.getAttribute("aria-label")&&!!x.title);
     const header={head:hb,name:nb,tabs:tb,actions:ab,singleRow,labelsVisible,tabNames,nameTruncated:name.scrollWidth>name.clientWidth};
     return {pane:e.getAttribute("data-mock-pane"),box:[r.x,r.y,r.width,r.height],header,tabs,tabIcons:e.querySelectorAll(".inst-switch .seg-item svg").length,logFilters:e.querySelectorAll(".log-bar").length,view:e.classList.contains("r2-log-pane")?"log":"chat",overflow:e.scrollWidth>e.clientWidth,draftClipped:field?field.scrollHeight>field.clientHeight:false};
    });
    const ids=[...document.querySelectorAll("[id]")].map(e=>e.id);
    return {panes,duplicateIds:ids.filter((s,i)=>ids.indexOf(s)!==i),workspaceBars:document.querySelectorAll(".mock-toolbar").length,documentOverflow:document.documentElement.scrollWidth>innerWidth};
   });
   if(geometry.documentOverflow||geometry.duplicateIds.length||geometry.workspaceBars||geometry.panes.some((p:any)=>p.overflow||p.draftClipped||!p.header.singleRow||!p.header.tabNames||p.header.tabs.right>p.header.actions.left||p.header.actions.right>p.header.head.right||p.header.labelsVisible!==(p.box[2]>=640)||p.tabs.length!==4||p.tabIcons!==4||(p.view==="log"&&p.logFilters!==1)))throw Error("Invalid r2 geometry "+scene+" "+JSON.stringify(geometry));
   if(scene==="narrow360"&&(!geometry.panes[0].header.nameTruncated||geometry.panes[0].box[2]!==360))throw Error("Minimum-pane truncation control failed");
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
