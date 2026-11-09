/** Actual Fleet web + private captured-record files. No daemon, CLI, tmux, model, account or ledger child entries. */
import {readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {bootFixture,matrix,caseName} from '../smoke-fixture/index.mts';
import {SubagentService,type SubagentSource} from '../../../src/subagent-service.js';
import {subagentFixture} from '../../../tests/helpers/subagent-fixtures.js';
const out=process.env.OUT!;mkdirSync(out,{recursive:true});
const receipt:any={kind:'real product web; filesystem fixtures from audited mock CLI records; inert lifecycle source only',source:[],cases:[],checks:[],cleanup:null};
for(const f of ['src/subagent-records.ts','src/subagent-service.ts','src/ui/subagent-row.js','src/ui/panel-chat.js','src/ui/shared/subagent-row.css','src/web-api.ts'])receipt.source.push({file:f,sha256:createHash('sha256').update(readFileSync(join(process.env.REPO!,f))).digest('hex')});
const fx=await bootFixture({port:Number(process.env.HP??48772),instances:3,classic:false});
const roots=join(fx.dir,'subagent-records');mkdirSync(roots,{recursive:true});
let active:SubagentSource|null=null;
fx.fm.subagentReader=new SubagentService(()=>active);
function seed(backend:'claude-code'|'codex',unknown=false,running=false){
 const f=subagentFixture(backend);const shift=Date.now()-f.now;
 const patch=(v:any):any=>{if(Array.isArray(v))return v.map(patch);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,k==='timestamp'&&typeof x==='string'?new Date(Date.parse(x)+shift).toISOString():patch(x)]));return v;};
 f.parent=patch(f.parent);for(const c of f.children.values())c.records=patch(c.records);
 if(running&&backend==='claude-code'){const id='a9947907a82e086d7';delete(f.children.get(id)!.meta as any).finished;f.parent=f.parent.filter((r:any)=>!r.message?.content?.includes?.(`<task-id>${id}</task-id>`));}
 const root=join(roots,backend);rmSync(root,{recursive:true,force:true});mkdirSync(root,{recursive:true});
 const day=backend==='codex'?join(root,'2026/11/09'):root;mkdirSync(day,{recursive:true});
 const path=join(day,backend==='codex'?`rollout-2026-11-09T15-18-16-${f.sessionId}.jsonl`:f.sessionId+'.jsonl');writeFileSync(path,f.parent.map(r=>JSON.stringify(r)).join('\n')+'\n');
 if(!unknown)for(const[id,c]of f.children){const p=backend==='claude-code'?join(root,f.sessionId,'subagents',`agent-${id}`):join(day,`rollout-2026-11-09T15-18-36-${id}`);mkdirSync(join(p,'..'),{recursive:true});writeFileSync(p+'.jsonl',c.records.map(r=>JSON.stringify(r)).join('\n')+'\n');if(c.meta)writeFileSync(p+'.meta.json',JSON.stringify(c.meta));}
 active={backend,sessionId:f.sessionId,cwd:f.cwd,path,root,owner:backend+'-'+(unknown?'missing':running?'live':'finished')};
}
try{
 for(const c of matrix()){
  const name=caseName(c);active=null;const {ctx,page,csp}=await fx.page(c,{path:'/ui/chat/general'});
  const errors:string[]=[];page.on('pageerror',(e:any)=>errors.push(String(e)));
  await page.locator('.composer-box').waitFor();if(await page.locator('.subagent-progress').count())throw Error('no child source shows empty disclosure');await page.screenshot({path:join(out,name+'-before.png')});
  // This is the real service reading files, not an HTTP reply stub. Reload starts a new observer owner.
  seed('claude-code',false,true);await page.reload();await page.locator('.subagent-progress').waitFor();
  if(await page.locator('.subagent-progress[open]').count())throw Error('not collapsed by default');
  await page.screenshot({path:join(out,name+'-collapsed.png')});
  await page.locator('.subagent-progress>summary').click();await page.locator('.subagent-item').nth(1).waitFor();
  const body=await page.locator('.subagent-progress').innerText();if(!body.includes(c.lang==='zh-TW'?'主 Agent 工作：':'Main Agent task:'))throw Error('missing parent attribution');
  const placement=await page.locator('.subagent-progress').evaluate((e:any)=>({ledger:!!e.closest('.msg'),composer:!!e.parentElement?.querySelector('.composer-box'),overflow:document.documentElement.scrollWidth>innerWidth,buttons:e.querySelectorAll('button').length,style:(()=>{const summary=e.querySelector('summary'),b=summary.getBoundingClientRect(),s=getComputedStyle(e),tap=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tap'));return {targetWidth:b.width,targetHeight:b.height,tap,roundedAccent:parseFloat(s.borderTopLeftRadius)>0&&(s.borderLeftWidth!==s.borderTopWidth||s.borderLeftColor!==s.borderTopColor),inlineStyles:e.querySelectorAll('[style]').length};})(),css:[...document.styleSheets].some((s:any)=>s.href?.endsWith('/assets/subagent-row.css'))}));
  if(placement.ledger||!placement.composer||placement.overflow||placement.buttons||!placement.css||placement.style.targetWidth<placement.style.tap||placement.style.targetHeight<placement.style.tap||placement.style.roundedAccent||placement.style.inlineStyles)throw Error(JSON.stringify(placement));
  await page.screenshot({path:join(out,name+'-expanded.png')});
  const scroll=await page.locator('.subagent-scroll').evaluate((e:any)=>{e.scrollTop=e.scrollHeight;const last=e.querySelector('.subagent-item:last-child');const a=last.getBoundingClientRect(),b=e.getBoundingClientRect();return {scrollable:e.scrollHeight>e.clientHeight,reachedBottom:e.scrollTop+e.clientHeight>=e.scrollHeight-1,visibleLast:a.bottom>b.top&&a.top<b.bottom};});
  if(!scroll.reachedBottom||!scroll.visibleLast)throw Error('last child unreachable '+JSON.stringify(scroll));await page.screenshot({path:join(out,name+'-expanded-bottom.png')});
  seed('codex',true);await page.reload();await page.locator('.subagent-progress>summary').click();await page.waitForFunction(()=>document.querySelectorAll('.subagent-item').length===2);if(await page.locator('.subagent-report').count())throw Error('missing records retain summary');
  await page.screenshot({path:join(out,name+'-unknown.png')});
  seed('codex');await page.reload();await page.locator('.subagent-progress>summary').click();await page.waitForFunction(()=>document.querySelectorAll('.subagent-report').length===2);await page.screenshot({path:join(out,name+'-codex.png')});
  const violations=await csp();if(errors.length||violations.length)throw Error(JSON.stringify({errors,violations}));receipt.cases.push({name,placement,errors,violations,states:['collapsed','completed+running','missing unknown','Codex completed']});await ctx.close();
 }
 const oldPanel=execFileSync('git',['show','170d0a60:src/ui/panel-chat.js'],{cwd:process.env.REPO!,encoding:'utf8'});
 const oldCss=execFileSync('git',['show','170d0a60:src/ui/shared/app.css'],{cwd:process.env.REPO!,encoding:'utf8'});
 for(const mode of ['old-panel','old-css','old-server','missing-module']){
  seed('claude-code');const c={device:'phone',theme:'dark',lang:'zh-TW'}as const;const {ctx,page}=await fx.page(c,{path:'/ui/chat/general'});const errors:string[]=[];page.on('pageerror',(e:any)=>errors.push(String(e)));
  if(mode==='old-panel')await page.route('**/ui/js/panel-chat.js',r=>r.fulfill({status:200,contentType:'text/javascript',body:oldPanel}));
  if(mode==='old-css')await page.route('**/assets/app.css',r=>r.fulfill({status:200,contentType:'text/css',body:oldCss}));
  if(mode==='old-server')await page.route('**/ui/subagents?*',r=>r.fulfill({status:404,body:'{}',contentType:'application/json'}));
  if(mode==='missing-module')await page.route('**/ui/js/subagent-row.js',r=>r.fulfill({status:404,body:''}));
  await page.reload();await page.locator('.composer-box').waitFor();await page.waitForTimeout(300);
  if(mode==='old-css'){await page.locator('.subagent-progress').waitFor();if(!await page.locator('link[href="/assets/subagent-row.css"]').count())throw Error('own css absent');}else if(await page.locator('.subagent-progress').count())throw Error('optional old dependency projected');
  if(errors.length)throw Error(errors.join('\n'));await page.screenshot({path:join(out,'skew-'+mode+'.png')});receipt.checks.push({mode,composer:true,pageErrors:errors});await ctx.close();
 }
}finally{await fx.close();receipt.cleanup={fixtureClosed:true};writeFileSync(join(out,'receipt.json'),JSON.stringify(receipt,null,2));}
