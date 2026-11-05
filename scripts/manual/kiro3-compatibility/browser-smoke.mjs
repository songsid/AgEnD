/** Fixture-only browser: an old loaded Needs-you tab receives the new server item. No fleet or account. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const root=process.cwd(),out=process.env.SMOKE_OUT??resolve('.artifacts/kiro3'),base=process.env.SMOKE_BASE??'213bd6b58';
const {chromium}=await import(pathToFileURL(resolve('.artifacts/browser-smoke/node_modules/playwright/index.mjs')).href);
const old=new Map(await Promise.all(['src/ui/panel-needs.js','src/ui/shared/app-i18n.js','src/ui/shared/app-needs.js'].map(async p=>[p,process.env.SMOKE_BASE_DIR?await readFile(join(process.env.SMOKE_BASE_DIR,p),'utf8'):execFileSync('git',['show',base+':'+p],{encoding:'utf8'})])));
const detail={en:'Kiro CLI 3.0.0 no longer supports Classic, so this agent was not started. Its saved conversation is unchanged. Use Kiro CLI 2.x to continue, or migrate this agent on 2.x before upgrading to 3.x.', 'zh-TW':'Kiro CLI 3.0.0 已不支援 Classic，所以這個 Agent 沒有啟動，已存的對話沒有變動。要繼續使用，請改用 Kiro CLI 2.x；或先在 2.x 把這個 Agent 遷移到新介面，再升級到 3.x。'};
let upgraded=false;const requests=[],errors=[];
const html=`<!doctype html><meta charset=utf-8><div id=app></div><script type=module>
import {appStore} from '/assets/app-store.js';import {h,render} from '/assets/preact.module.js';import {NeedsPanel} from '/ui/js/panel-needs.js';
appStore.set({needs:[],instances:[],connections:0});render(h(NeedsPanel,{navKey:'smoke'}),document.getElementById('app'));
window.acceptHold=async(lang)=>appStore.set({needs:await fetch('/new-needs?lang='+lang).then(r=>r.json())});window.proofReady=true;</script>`;
const server=createServer(async(req,res)=>{try{
 const u=new URL(req.url,'http://localhost');requests.push(u.pathname);
 if(u.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
 if(u.pathname==='/new-needs'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify([{id:'kiro-choice:general:1',type:'instance',instance:'general',reason:'dialog',kiroChoice:true,since:1,detail:detail[u.searchParams.get('lang')]??detail.en}]));return;}
 let path;if(/^\/assets\/[a-z0-9_.-]+\.js$/.test(u.pathname))path='src/ui/shared/'+u.pathname.slice(8);else if(/^\/ui\/js\/[a-z0-9_.-]+\.js$/.test(u.pathname))path='src/ui/'+u.pathname.slice(7);else{res.writeHead(404);res.end();return;}
 const bytes=!upgraded&&old.has(path)?old.get(path):await readFile(join(root,path));res.setHeader('Content-Type','text/javascript');res.end(bytes);
 }catch{res.writeHead(404);res.end();}});server.listen(0,'127.0.0.1');await once(server,'listening');
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
try{
 const ctx=await browser.newContext({locale:'en-US'}),page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.proofReady);await page.getByText('Nothing needs you right now',{exact:true}).waitFor();
 upgraded=true;await page.evaluate(()=>window.acceptHold('en'));await page.getByText(detail.en,{exact:true}).waitFor();assert.equal(await page.locator('.n-title strong').textContent(),'Waiting at a dialog');assert.equal(await page.getByText('Open chat',{exact:true}).getAttribute('href'),'/ui/chat/general');await page.screenshot({path:join(out,'stale-tab.png')});
 const fresh=await ctx.newPage();fresh.on('pageerror',e=>errors.push(e.message));await fresh.goto('http://127.0.0.1:'+server.address().port);await fresh.waitForFunction(()=>window.proofReady);await fresh.evaluate(()=>window.acceptHold('en'));await fresh.getByText('Kiro needs your decision',{exact:true}).waitFor();assert.equal(await fresh.getByText('Open agent',{exact:true}).getAttribute('href'),'/ui/chat/general');assert.match(await fresh.getByText('Migration instructions',{exact:true}).getAttribute('href'),/kiro-engine-migration\/SKILL.md$/);await fresh.screenshot({path:join(out,'fresh-tab.png')});
 const zhctx=await browser.newContext({locale:'zh-TW'}),zh=await zhctx.newPage();zh.on('pageerror',e=>errors.push(e.message));await zh.goto('http://127.0.0.1:'+server.address().port);await zh.waitForFunction(()=>window.proofReady);await zh.evaluate(()=>window.acceptHold('zh-TW'));await zh.getByText('Kiro 需要你決定',{exact:true}).waitFor();await zh.getByText(detail['zh-TW'],{exact:true}).waitFor();await zh.getByText('開啟 Agent',{exact:true}).waitFor();await zh.getByText('遷移說明',{exact:true}).waitFor();await zh.screenshot({path:join(out,'zh-tab.png')});assert.deepEqual(errors,[]);
 await writeFile(join(out,'browser-receipt.json'),JSON.stringify({sourceHead:process.env.SMOKE_SOURCE_HEAD??execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),oldAssetBase:base,oldTabHeldOpen:true,staleBodyVisible:true,staleOpenAction:true,newActionsReadOnly:true,en:true,zhTW:true,pageErrors:errors,fixtureOnly:true,passed:true},null,2));
}finally{await browser.close();server.closeAllConnections();await new Promise(done=>server.close(done));}
