// M-2556: real Fleet listener; cached-asset overrides provide before and both SKEW directions without worktrees.
// REPO=$PWD PW_DIR=<playwright-core prefix> OUT=<PNG dir> [BASE_REF=<tabs head>] [MODES=before,after,old-css,old-panel] npx tsx ...
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bootFixture, mounted } from "../smoke-fixture/index.mts";
const out = resolve(process.env.OUT ?? "docs/screenshots/fleet-memory-header"), base = process.env.BASE_REF ?? "345ea079eb0bc9065e5c03a0420e7af9ee6017fc";
mkdirSync(out, { recursive: true });
const blob = (path: string) => execFileSync("git", ["show", `${base}:${path}`], { encoding: "utf8", maxBuffer: 8 << 20 });
const oldCss = blob("src/ui/shared/app.css"), oldPanel = blob("src/ui/panel-fleet.js");
const modes = (process.env.MODES ?? "before,after,old-css,old-panel").split(",");
const widths = (process.env.WIDTHS ?? "360,900,1366,1920").split(",").map(Number);
const langs = (process.env.LANGS ?? "en,zh-TW").split(",") as ("en"|"zh-TW")[];
const fx = await bootFixture({ port: Number(process.env.HP ?? 48935), classic: false });
fx.fm.getInstanceStatus = () => "running";
const top = [
 {name:"claude",pid:4242,rssBytes:3400000000,owner:"instance",instance:"agend-dev-claude2-t481212"},
 {name:"chrome-headless-shell",pid:5151,rssBytes:1900000000,owner:"other"},
 {name:"node",pid:6161,rssBytes:900000000,owner:"fleet"}];
let pressured = false;
const status = fx.fm.getUiStatusSync.bind(fx.fm);
fx.fm.getUiStatusSync = () => ({...status(),host_memory:pressured?"critical":null,host_memory_top:pressured?top:[]});
const pressure = `(async()=>{const{appStore}=await import('/assets/app-store.js');const fixed={hostMemory:'critical',hostMemoryTop:${JSON.stringify(top)}};window.__unpinMemory=appStore.subscribe(s=>{if(s.hostMemory!=='critical'||s.hostMemoryTop?.length!==3)appStore.set(fixed);});appStore.set(fixed);})()`;
const read = `(()=>{
const root=document.querySelector('.p-fleet'), head=root.querySelector('.panel-head'), top=head.querySelector('.host-mem-top'), status=head.querySelector('.host-mem');
const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}};
const overlap=(a,b)=>Math.min(a.right,b.right)>Math.max(a.x,b.x)+0.5&&Math.min(a.bottom,b.bottom)>Math.max(a.y,b.y)+0.5;
const t=rect(top), s=rect(status), tools=[...head.querySelectorAll('.panel-actions > *')].map(rect), nav=root.querySelector('nav[data-trust="panel-navigation"]');
const items=[...nav.querySelectorAll('a')], n=rect(nav), h=rect(head);
return {inHeader:head.contains(nav),navWidth:n.w,tabWidths:items.map(e=>rect(e).w),titleWidths:[...head.querySelector(".panel-title").children].map(e=>({width:rect(e).w,scroll:e.scrollWidth})),top:t,status:s,tools,head:h,title:top.title,text:top.textContent,
truncated:top.scrollWidth>top.clientWidth, wrapped:getComputedStyle(top).whiteSpace!=='nowrap',clipped:getComputedStyle(top).overflowX==='hidden',
overlap:tools.some(b=>overlap(t,b)||overlap(s,b)),inside:t.x>=h.x&&t.right<=h.right+0.5,
allTabs:items.length===6&&items.every(e=>{const r=rect(e);return r.w>0&&r.x>=n.x-0.5&&r.right<=n.right+0.5}),
scrollWidth:document.documentElement.scrollWidth,width:innerWidth,healed:!!document.getElementById('fleet-memory-css')};})()`;
const results: any[] = [];
try {
 for (const mode of modes) for (const lang of langs) for (const width of widths) {
  const p = await fx.page({device:width<900?"phone":"desk",theme:lang==="en"?"light":"dark",lang});
  const errors: string[] = []; p.page.on("pageerror", (e: Error) => errors.push(e.message));
  await p.page.setViewportSize({width,height:800});
  await p.page.route("**/assets/app.css*", (route: any) => {
   const u = new URL(route.request().url());
   return (mode==="before"||mode==="old-css")&&!u.searchParams.has("fleet-memory") ? route.fulfill({contentType:"text/css",body:oldCss}) : route.continue();
  });
  if(mode==="before"||mode==="old-panel") await p.page.route("**/ui/js/panel-fleet.js*", (route: any) => route.fulfill({contentType:"text/javascript",body:oldPanel}));
  await p.page.goto(new URL("/ui/fleet/usage",p.page.url()).href); await mounted(p.page,30000); await p.page.locator(".p-fleet").waitFor();
  pressured = true; await p.page.evaluate(pressure); await p.page.waitForTimeout(600);
  const result = await p.page.evaluate(read);
  console.log(JSON.stringify({mode,lang,width,...result}));
  if(mode!=="before") {
   assert.equal(result.overlap,false,"memory warning overlaps tools"); assert.equal(result.inside,true,"warning outside header");
   assert(result.scrollWidth<=width,"page overflows horizontally"); assert.equal(result.allTabs,true,"a tab is clipped");
   assert(result.title===result.text||result.wrapped,"truncated content needs a tooltip or full wrapping");
   assert(!result.truncated||result.clipped,"long process text paints outside its box");
   if(width===1920)assert.equal(result.inHeader,true,"capped warning should allow tabs when they fit");
   if(mode==="old-css") assert.equal(result.healed,true,"cached CSS not refreshed");
   assert.deepEqual(errors,[]);
  }
  if((mode==="before"||mode==="after")&&width!==1920) await p.page.screenshot({path:join(out,`${width}-${lang}-${mode}.png`),clip:{x:0,y:0,width,height:Math.min(400,Math.max(200,result.head.bottom+70))}});
  pressured = false; await p.page.evaluate(`(async()=>{const{appStore}=await import('/assets/app-store.js');window.__unpinMemory?.();appStore.set({hostMemory:null,hostMemoryTop:[]});})()`);
  await p.page.waitForTimeout(200);
  const cleared=await p.page.evaluate(`(()=>{const r=document.querySelector('.p-fleet');return {warning:!!r.querySelector('.host-mem'),tabs:!!r.querySelector('.panel-head nav'),overflow:document.documentElement.scrollWidth>innerWidth};})()`);
  if(mode!=="before"){assert.equal(cleared.warning,false);assert.equal(cleared.overflow,false);if(width===1366)assert.equal(cleared.tabs,true);}
  results.push({mode,lang,width,...result,cleared,errors}); await p.ctx.close();
 }
 mkdirSync(".artifacts/fleet-memory-header",{recursive:true});writeFileSync(".artifacts/fleet-memory-header/results.json",JSON.stringify({base,results},null,2)+"\n");
 if(modes.includes("before")) assert(results.filter(r=>r.mode==="before"&&r.width>=900&&r.overlap).length>=4,"before fixture missed desktop overlap");
 console.log(JSON.stringify({cases:results.length,out}));
}finally{await fx.close();}
