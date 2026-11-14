const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
const root=__dirname,src=path.resolve(root,'../../../src/ui/shared');const NOW=Date.UTC(2026,10,15,1,0,0);
const prefs={rev:1,values:{lang:'zh-TW',theme:'light','nav.favorites':['sentinel','lumen'],'nav.sort':{mode:'custom',favs:'fixed'}}};
const rows=[['general','General','🌿','claude-code','',35,1],['sentinel','Sentinel','🛡️','codex','開發',48,3],['lumen','Lumen','🔎','claude-code','審查',22,5],['ridge','Ridge','🏔️','codex','開發',61,8],['cairn','Cairn','🪨','claude-code','開發',17,12],['web','Web · 側邊欄與聊天體驗','🎨','claude-code','開發',39,17],['argon','Argon','A','antigravity','開發',28,24],['fable','Fable','📖','claude-code','審查',52,35],['prism','Prism','🔷','codex','審查',37,48],['scout','Scout','🔭','grok','其他',9,60],['archive','Archive','🗂️','codex','其他',0,1440]];
const instances=rows.map(([name,display_name,emoji,backend,team,context_pct,age])=>({name,display_name,backend,status:name==='archive'?'paused':'running',avatar:{kind:'emoji',text:emoji},tags:[],teams:team?[team]:[],context_pct,last_reply:new Date(NOW-age*60000).toISOString(),description:'示範 Agent；未連接任何真實 Fleet。'}));
const attr=s=>s.replaceAll('&','&amp;').replaceAll('"','&quot;');
const fixture=(theme='light',density='detailed')=>`<!doctype html><html lang="zh-Hant" data-theme="${theme}" data-prefs="${attr(JSON.stringify({...prefs,values:{...prefs.values,theme,"nav.density":density}}))}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/tokens.css"><link rel="stylesheet" href="/assets/app.css"></head><body><div id="app" class="app-root"></div><script>window.AgendAuth={canWrite:async()=>true,onSessionEnd:()=>{},sessionEnded:()=>false};Date.now=()=>${NOW};</script><script type="module">
import {html,render} from '/assets/app-html.js';import {FixtureSidebar,canCreateStore} from '/assets/app-shell.js';import {appStore} from '/assets/app-store.js';import {setLang} from '/assets/app-i18n.js';
setLang('zh-TW',{store:false});canCreateStore.set({value:true});appStore.set({ready:true,instances:${JSON.stringify(instances)},exec:{sentinel:'working',cairn:'working'},awaiting:{},needs:[{},{}],connections:1,proposals:[],connection:'connected'});
render(html\`<div class="shell sb-open"><\${FixtureSidebar} route=\${{panel:'chat',instance:'sentinel'}} onNewInstance=\${()=>{}} /><main class="main"><div class="panel-head">Sentinel</div></main></div>\`,document.querySelector('#app'));await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));window.fixtureReady=true;
</script></body></html>`;
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost');if(u.pathname==='/fixture'){res.setHeader('content-type','text/html');res.end(fixture(u.searchParams.get('theme')||'light',u.searchParams.get('density')||'detailed'));return}if(u.pathname.startsWith('/assets/')){let file=u.pathname.slice(8);if(file==='inter.woff2')file='fonts/inter.woff2';const p=path.resolve(src,file);if(!p.startsWith(src+path.sep)||!fs.existsSync(p)){res.writeHead(404);res.end();return}const type=p.endsWith('.css')?'text/css':p.endsWith('.js')?'text/javascript':p.endsWith('.woff2')?'font/woff2':'application/octet-stream';res.setHeader('content-type',type);if(file==='app-shell.js')res.end(fs.readFileSync(p,'utf8')+'\nexport { Sidebar as FixtureSidebar };\n');else res.end(fs.readFileSync(p));return}res.setHeader('content-type','application/json');res.end(JSON.stringify(u.pathname==='/auth/session'?{tier:'admin',label:'Preview',expiresAt:NOW+3600000,idleMs:3600000}:u.pathname==='/ui/authorization'?{state:'verified'}:u.pathname==='/ui/prefs'?prefs:{}))});

(async()=>{if(require('node:os').loadavg()[0]>10)throw Error('load gate>10');await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;try{
 browser=await chromium.launch({headless:true});const results=[];const errors=[];
 for(const device of ['desktop','phone'])for(const theme of ['light','dark']){
  const width=device==='phone'?390:1200;
  const p=await browser.newPage({viewport:{width:device==='phone'?680:600,height:850}});p.on('pageerror',e=>errors.push(e.message));
  await p.route('**/comparison',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:20px;background:${theme==='dark'?'#17191f':'#f6f7f8'};color:${theme==='dark'?'#e5e7eb':'#252a33'};font:14px system-ui}main{display:flex;gap:20px}h2{font-size:14px;margin:0 0 10px}.clip{width:${device==='phone'?300:260}px;height:760px;overflow:hidden;border:1px solid #8885;border-radius:7px}iframe{border:0;width:${width}px;height:760px}</style></head><body><main>${['detailed','compact'].map(d=>`<section><h2>${d==='detailed'?'詳細（預設）':'精簡'} · ${device==='phone'?'手機':'桌面'}</h2><div class="clip"><iframe src="/fixture?theme=${theme}&density=${d}"></iframe></div></section>`).join('')}</main></body></html>`}));
  await p.goto(`http://127.0.0.1:${server.address().port}/comparison`);const frames=p.locator('iframe');
  for(let i=0;i<2;i++){await frames.nth(i).contentFrame().locator('.v-li').first().waitFor();await frames.nth(i).contentFrame().locator('body').evaluate(()=>document.fonts.ready);}
  const detail=frames.nth(0).contentFrame(),compact=frames.nth(1).contentFrame();
  assert.equal(await compact.locator('.av').count(),0);assert.equal(await detail.locator('.av').count(),11);
  assert.equal(await compact.locator('.inst-status').count(),11);assert.equal(await compact.locator('.inst-status.busy').count(),2);
  assert.equal(await compact.locator('.inst-when').count(),11);
  const heights=await compact.locator('.v-li').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().height));assert.ok(heights.every(h=>h===(device==='phone'?40:30)));
  const pulse=await compact.locator('.inst-status.busy').first().evaluate(e=>getComputedStyle(e).animationName);assert.equal(pulse,'pulse');
  const groupBefore=await compact.locator('.v-group-head').allTextContents();assert.deepEqual(groupBefore,await detail.locator('.v-group-head').allTextContents());
  // Same theme/identity text colours and selected row fill, for both densities.
  const style=async f=>f.locator('.inst.active').evaluate(e=>{const s=getComputedStyle(e),n=getComputedStyle(e.querySelector('.inst-name'));return [s.backgroundColor,s.borderRadius,n.fontFamily,n.fontSize,n.color]});assert.deepEqual(await style(compact),await style(detail));
  const count=async f=>f.locator('.side-section').evaluate(e=>{const b=e.getBoundingClientRect();return [...e.querySelectorAll('.v-li')].filter(r=>{const q=r.getBoundingClientRect();return q.top>=b.top&&q.bottom<=b.bottom}).length});
  const counts=[await count(detail),await count(compact)];await p.screenshot({path:path.join(root,`${device}-${theme}.png`),fullPage:true});
  results.push({device,theme,heights,counts,workingPulse:pulse});await p.close();
 }
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(root,'browser-results.json'),JSON.stringify({results,errors},null,2));console.log(JSON.stringify({scenarios:results.length,errors}));
}finally{await browser?.close();await new Promise(r=>server.close(r))}})().catch(e=>{console.error(e);process.exitCode=1});
