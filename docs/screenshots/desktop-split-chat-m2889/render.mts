/** Design stills only. Starts an owned disposable fixture, never a Fleet/CLI. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { processGuard } from '../../../tests/support/process-guard.ts';
import { bootFixture } from '../../../scripts/manual/smoke-fixture/index.mts';
import { renderMock } from './mock-dom.mjs';

const repo = resolve(process.env.REPO!);
const out = resolve(process.env.OUT || join(repo, 'docs/screenshots/desktop-split-chat-m2889'));
mkdirSync(out, { recursive:true });
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const git = (...args: string[]) => execFileSync('git', args, {cwd:repo, encoding:'utf8'}).trim();
const inputs = ['src/ui/app.html','src/ui/shared/app.css','src/ui/panel-chat.js','src/ui/shared/app.js','src/ui/shared/app-shell.js','src/ui/shared/chat-composer.js','scripts/manual/smoke-fixture/index.mts','scripts/manual/smoke-fixture/data.mts','scripts/ci/ui-gate-fonts.json','docs/screenshots/desktop-split-chat-m2889/render.mts','docs/screenshots/desktop-split-chat-m2889/mock-dom.mjs','docs/screenshots/desktop-split-chat-m2889/mock.css'];
const receipt: any = {schema:1, scope:'Static design composition over the real disposable app shell; no two-pane implementation or behavior/performance acceptance.', base:git('rev-parse','HEAD'), tree:git('rev-parse','HEAD^{tree}'), workingTree:git('status','--short'), viewport:{width:1600,height:1000}, lang:'zh-TW', inputs:inputs.map(p=>({[hash(readFileSync(join(repo,p)))]:p})), served:[], cases:[], guardViolations:[], cleanup:false};
if (!process.env.FONTCONFIG_FILE || !existsSync(process.env.FONTCONFIG_FILE)) throw new Error('Prepare pinned CJK font and set FONTCONFIG_FILE');
receipt.fontconfig = hash(readFileSync(process.env.FONTCONFIG_FILE));
receipt.classicScrollbars = process.env.PW_SCROLLBARS === '1';
const css = readFileSync(new URL('./mock.css', import.meta.url),'utf8');
const fx = await bootFixture({port:Number(process.env.PORT || 49470),instances:4,classic:false});
try {
 const a = fx.instances.find(i=>!i.general)!.name;
 const now = Date.now()-60000;
 fx.fm.emitSseEvent('message',{instance:a,sender:'你',role:'user',text:'請比較兩個方案，整理成我可以直接轉貼的重點。',ts:new Date(now).toISOString()});
 fx.fm.emitSseEvent('message',{instance:a,sender:a,role:'agent',text:'建議先保留左右並排。\n\n- 左側整理提案\n- 右側檢查差異\n- 拖曳標頭即可調整位置',ts:new Date(now+10000).toISOString()});
 for (const theme of ['light','dark'] as const) {
  const p = await fx.page({device:'desk',theme,lang:'zh-TW'},{path:'/ui/chat/'+encodeURIComponent(a)});
  try {
   await p.page.setViewportSize(receipt.viewport);
   await p.page.route('**/assets/app.css*',async(route:any)=>{const response=await route.fetch(); const body=await response.text(); await route.fulfill({response,body:body+'\n'+css});});
   await p.page.reload();
   await p.page.waitForSelector('.p-chat .dock');
   await p.page.evaluate(async()=>{await document.fonts.ready;});
   receipt.served.push(...await p.page.evaluate(async()=>{const urls=[...new Set(performance.getEntriesByType('resource').map((r:any)=>r.name).filter((s:string)=>/\.(?:js|css)(?:\?|$)/.test(s)))];const out=[];for(const url of urls){const bytes=await (await fetch(url)).arrayBuffer();const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');out.push({[digest]:new URL(url).pathname});}return out;}));
   for (const scene of ['sidebar','header','right','stack','float','snap']) {
    if (scene !== 'sidebar') { await p.page.reload(); await p.page.waitForSelector('.p-chat .dock'); }
    await p.page.evaluate(renderMock, {scene});
    await p.page.evaluate(async()=>{await document.fonts.ready;});
    const geometry=await p.page.evaluate(()=>{
     const panes=[...document.querySelectorAll('.mock-pane')].map(e=>{const r=e.getBoundingClientRect();const field=e.querySelector('textarea')!;const input=field.getBoundingClientRect();return {pane:e.getAttribute('data-mock-pane'),box:[r.x,r.y,r.width,r.height],composer:[input.x,input.y,input.width,input.height],draftClipped:field.scrollHeight>field.clientHeight,overflow:e.scrollWidth>e.clientWidth};});
     const ids=[...document.querySelectorAll('[id]')].map(e=>e.id);
     const sidebar=[...document.querySelectorAll('.sidebar a.inst.active .inst-name')].map(e=>e.textContent);
     const focused=[...document.querySelectorAll('.mock-pane.is-focused .panel-title h2')].map(e=>e.firstChild!.textContent);
     return {panes,sidebar,focused,duplicateIds:ids.filter((s,i)=>ids.indexOf(s)!==i),documentOverflow:document.documentElement.scrollWidth>innerWidth};
    });
    if(geometry.duplicateIds.length||geometry.documentOverflow||geometry.panes.some((p:any)=>p.overflow||p.draftClipped)||geometry.focused.some((s:string)=>!geometry.sidebar.includes(s))) throw new Error('Invalid design geometry '+JSON.stringify(geometry));
    const file=theme+'-'+scene+'.png'; await p.page.screenshot({path:join(out,file)});
    receipt.cases.push({file,theme,scene,geometry});
   }
  } finally {await p.ctx.close();}
 }
 receipt.guardViolations=processGuard.takeViolations();
 if(receipt.guardViolations.length)throw new Error('Process guard violations');
} finally {await fx.close(); receipt.cleanup=true; writeFileSync(join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');}
console.log(JSON.stringify({cases:receipt.cases.length,guardViolations:receipt.guardViolations,cleanup:receipt.cleanup}));
