/** Design only: genuine app.html + application modules; fake protocol; prototype content only is mounted in-panel. */
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {render} from './mockup-content.mjs';
const here=dirname(fileURLToPath(import.meta.url)),repo=resolve(here,'../../..'),owner=resolve(repo,'../..');
const pw=process.env.PW_DIR||join(owner,'.worktrees/hub-group-composition/.artifacts/group-composition/browser');
const chrome=process.env.CHROME||join(owner,'.worktrees/hub-group-composition/.artifacts/group-composition/browsers/chromium-1194/chrome-linux/chrome');
const font=process.env.DESIGN_FONT||join(owner,'.artifacts/hub-web-setup-design/fonts/NotoSansCJKtc-Regular.otf');
const out=join(here,'png');await mkdir(out,{recursive:true});
const {chromium}=createRequire(join(pw,'package.json'))('playwright-core');
const appHtml=await readFile(join(repo,'src/ui/app.html'),'utf8');
const requestPaths=new Set(),errors=[];
const htmlAttr=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const json=(res,value,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
const hubScreen=s=>['existing','reauth','error','ca-change','server-change'].includes(s);
const server=createServer(async(req,res)=>{try{
 const u=new URL(req.url,'http://localhost'),p=u.pathname;requestPaths.add(p);
 const lang=req.headers['x-design-lang']||'zh-TW',theme=req.headers['x-design-theme']||'light';
 if(p==='/design-font.otf'){res.setHeader('Content-Type','font/otf');res.end(await readFile(font));return;}
 if(p==='/mockups.css'){res.setHeader('Content-Type','text/css');res.end(await readFile(join(here,'mockups.css')));return;}
 if(p.startsWith('/assets/')||p.startsWith('/ui/js/')){
  const name=decodeURIComponent(p.replace(/^\/(assets|ui\/js)\//,''));if(name.includes('..')||name.includes('\\'))throw Error('asset path');
  const candidates=p.startsWith('/ui/js/')?[join(repo,'src/ui',name)]:[join(repo,'src/ui/shared',name),join(repo,'src/ui',name),join(repo,'src/ui/shared/fonts',name)];
  for(const file of candidates){try{if(!(await stat(file)).isFile())continue;res.setHeader('Content-Type',name.endsWith('.css')?'text/css':name.endsWith('.woff2')?'font/woff2':name.endsWith('.svg')?'image/svg+xml':'text/javascript');res.end(await readFile(file));return;}catch{}}
  res.statusCode=404;res.end();return;
 }
 if(p==='/settings/hub'||p==='/ui/hub/admin'){
  const hub=p.startsWith('/ui/hub');let html=appHtml.replace('<html lang="en">',`<html lang="${lang}" data-theme="${theme}" data-prefs="${htmlAttr(JSON.stringify({rev:1,values:{lang,theme}}))}">`)
   .replace('<body>',`<body data-mode="full" data-web-transport="none" data-usage-panel="0" data-log-tab="0"${hub?' data-hub="hub"':''}>`)
   .replace('</head>','<link rel="stylesheet" href="/mockups.css"></head>');
  if(hub)html=html.replace('<script src="/assets/agend-auth.js"></script>','');
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;
 }
 if(p==='/auth/session'){json(res,{csrf:'design-only',handle:'design-only',tier:'admin',surface:'local',host:true});return;}
 if(p==='/api/settings/schema'){json(res,{},404);return;}
 if(p==='/api/settings/fleet/raw'){json(res,{instances:{},defaults:{},web:{}});return;}
 if(p==='/api/settings/classic'){json(res,{channels:{},defaults:{}});return;}
 if(p==='/api/fleet'){json(res,{instances:[],version:'',uptime:0});return;}
 if(p==='/ui/prefs'){json(res,{rev:1,values:{lang,theme}});return;}
 if(p==='/ui/owner-css/state'){json(res,{active:null,previous:null,pending:null});return;}
 if(p==='/ui/themes'){json(res,{themes:[],active:null});return;}
 if(p==='/hub/v1/session'){json(res,{signedIn:true,displayName:'Avery (fictional)',login:'avery',admin:true,csrf:'design-only',hub:{name:''},features:[]});return;}
 if(p==='/hub/v1/admin/overview'){json(res,{pairings:[],fleets:[],people:[],grants:[],audit:[]});return;}
 if(p==='/hub/v1/exposures'){json(res,{mine:[],askable:[]});return;}
 if(p==='/api/settings/hub-membership'){json(res,{enabled:false,revision:1});return;}
 if(p.includes('/notices')||p.includes('/needs')){json(res,{items:[]});return;}
 if(p==='/ui/poll'){json(res,{cursor:0,events:[]});return;}
 if(p.startsWith('/hub/v1/')||p.startsWith('/api/')||p.startsWith('/ui/')){json(res,[]);return;}
 res.statusCode=404;res.end();
}catch(e){errors.push(String(e));res.statusCode=500;res.end('design server error');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const matrix=[];
for(const screen of ['basics','directory','trust','review','existing','reauth','error','ca-change','server-change'])for(const size of ['desktop','phone'])matrix.push({screen,lang:'zh-TW',size,theme:size==='desktop'?'light':'dark'});
for(const screen of ['directory','existing','reauth'])for(const size of ['desktop','phone'])matrix.push({screen,lang:'en',size,theme:screen==='existing'?'dark':'light'});
const hubOnly=process.env.HUB_ONLY==='1';
const previous=hubOnly?JSON.parse(await readFile(join(here,'mockup-checks.json'),'utf8')):null;
const selected=hubOnly?matrix.filter(x=>hubScreen(x.screen)):process.env.MATRIX==='quick'?matrix.slice(0,2):matrix;
let browser;const checks=[];
try{
 browser=await chromium.launch({headless:true,executablePath:chrome,args:['--no-sandbox'],env:{...process.env,TMPDIR:join(owner,'.q3402')}});
 for(let n=0;n<selected.length;n++){
  const x=selected[n],hub=hubScreen(x.screen),context=await browser.newContext({viewport:{width:x.size==='desktop'?1366:390,height:x.size==='desktop'?1000:844},locale:x.lang,deviceScaleFactor:1,extraHTTPHeaders:{'X-Design-Lang':x.lang,'X-Design-Theme':x.theme}}),page=await context.newPage();
  const pageErrors=[];page.on('pageerror',e=>pageErrors.push(String(e)));
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.goto(origin+(hub?'/ui/hub/admin':'/settings/hub'),{waitUntil:'networkidle'});
  if(hub)await page.locator('.p-hub-admin .panel-body').waitFor();
  else await page.locator('.p-settings #hub-membership').waitFor();
  await page.evaluate(async()=>{const m=await import('/assets/app-store.js');m.appStore.set({ready:true,instances:[],needsLoaded:true,needs:[],connections:0,connection:'sse'});});
  const content=render(['ca-change','server-change'].includes(x.screen)?'existing':x.screen,x.lang,x.theme);
  await page.evaluate(({hub,content})=>{
   const target=document.querySelector(hub?'.p-hub-admin .panel-body':'.col[data-settings-section="hub"]');
   if(!target)throw Error('real panel missing');const back=hub?'':target.querySelector('.s-back')?.outerHTML||'';
   target.innerHTML=back+(hub?`<div class="col hub-owner">${content}</div>`:content);target.dataset.designPrototype='1';
  },{hub,content});
  await page.evaluate(async()=>{await document.fonts.load('16px "Noto Sans TC"','繁體中文');await document.fonts.ready;});
  if(['ca-change','server-change'].includes(x.screen)){
   await page.evaluate(async({lang,screen})=>{
    const z=lang==='zh-TW',{confirmDialog}=await import('/assets/ui-confirm.js');
    const bytes=Array(4).fill('A1:B2:C3:D4:E5:F6:07:18').join('\n');
    const host=screen==='server-change'?'directory-new.example.test':'directory.example.test';
    const text=screen==='server-change'?(z?'伺服器已變更。新的 leaf 憑證通過原 CA 驗證。':'The server changed. Its new leaf certificate chains to the current trusted CA.'):(z?'CA 已變更。請與目錄管理者提供的指紋比對。':'The CA changed. Compare this fingerprint with your directory administrator.');
    void confirmDialog({title:z?'確認目錄信任變更':'Confirm directory trust change',message:text+'\n\n'+host+'\n\n'+(screen==='server-change'?'Leaf SHA-256':'CA SHA-256')+'\n'+bytes+'\n\n'+(z?'不相符請取消。確認後才儲存。':'Cancel if it differs. Save only after confirmation.'),confirmLabel:z?'確認並儲存':'Confirm and save'});
   },{lang:x.lang,screen:x.screen});
   await page.locator('[data-confirm="yes"]').waitFor();
  }
  const overflow=await page.evaluate(()=>{const p=document.querySelector('.panel-body');return p?Math.max(0,p.scrollHeight-p.clientHeight):0;});
  if(overflow&&!['ca-change','server-change'].includes(x.screen))await page.setViewportSize({width:x.size==='desktop'?1366:390,height:(x.size==='desktop'?1000:844)+overflow+20});
  const metrics=await page.evaluate(hub=>{
   const brand=document.querySelector('#sidebar .side-head .brand'),rg=document.createRange();if(brand)rg.selectNodeContents(brand);
   const frames=[...document.querySelectorAll('.p-hub .s-section-layout .card')].map(el=>{const s=getComputedStyle(el);return [s.padding,s.borderTopWidth,s.borderTopStyle,s.borderRadius].join(' ');});
   return {width:innerWidth,scroll:document.documentElement.scrollWidth,fonts:document.fonts.check('16px "Noto Sans TC"'),dialogClipped:[...document.querySelectorAll('.confirm-text')].some(p=>p.scrollWidth>p.clientWidth),realApp:!!document.querySelector('#app.app-root > *'),realSidebar:!!document.querySelector('#sidebar'),settingsHub:hub?null:document.querySelector('.s-nav .seg-item.active')?.getAttribute('href'),prototypeOnlyInPanel:!!document.querySelector('.panel-body [data-design-prototype],.panel-body[data-design-prototype]'),hubColumn:hub?!!document.querySelector('.p-hub .col.hub-owner'):null,hubPanelHeader:hub?!!document.querySelector('.p-hub .panel-head'):null,hubBrand:hub?brand?.textContent.trim():null,hubBrandLines:hub&&brand?new Set([...rg.getClientRects()].filter(b=>b.width>0).map(b=>Math.round(b.top))).size:null,hubCardFrames:hub?new Set(frames).size:null,hubColumnPadding:hub?parseFloat(getComputedStyle(document.querySelector('.hub-page-body > .col')).paddingLeft):null,hubNotices:hub?document.querySelectorAll('.hub-security-notices').length:null,hubDuplicateTitle:hub?[...document.querySelectorAll('.s-page-head h2')].some(el=>el.textContent.trim()===document.querySelector('.panel-head h1')?.textContent.trim()):null,hubBreadcrumb:hub?!!document.querySelector('.mock-content > a.hub-crumb + header.s-page-head'):null,tabTitle:document.title};
  },hub);
  if(metrics.scroll>metrics.width||metrics.dialogClipped||!metrics.fonts||!metrics.realApp||!metrics.realSidebar||(!hub&&metrics.settingsHub!=='/settings/hub'))throw Error('real-shell geometry: '+JSON.stringify({x,metrics}));
  if(hub&&(!metrics.hubColumn||!metrics.hubPanelHeader||metrics.hubBrand!=='AgEnD Hub'||metrics.hubCardFrames!==1||(x.size==='desktop'&&metrics.hubBrandLines!==1)))throw Error('new Hub shell: '+JSON.stringify({x,metrics}));
  if(hub&&(metrics.hubColumnPadding!==0||metrics.hubNotices!==0||metrics.hubDuplicateTitle||!metrics.hubBreadcrumb||!metrics.tabTitle.includes(x.lang==='zh-TW'?'管理':'Administration')))throw Error('fixed Hub UX: '+JSON.stringify({x,metrics}));
  if(pageErrors.length)throw Error('app errors: '+JSON.stringify({x,pageErrors}));
  const file=`${String(matrix.indexOf(x)+1).padStart(2,'0')}-${x.screen}-${x.lang}-${x.size}.png`;
  await page.screenshot({path:join(out,file),fullPage:true});checks.push({...x,file,...metrics,pageErrors});await context.close();
 }
 const allChecks=previous?matrix.map(x=>checks.find(c=>c.screen===x.screen&&c.lang===x.lang&&c.size===x.size)||previous.checks.find(c=>c.screen===x.screen&&c.lang===x.lang&&c.size===x.size)):checks;
 if(allChecks.some(x=>!x)||allChecks.length!==24)throw Error('incomplete matrix');
 await writeFile(join(here,'mockup-checks.json'),JSON.stringify({scope:'real app.html/app.js/sidebar/Settings nav; fake protocol and in-panel design content only; no product behavior tested',base:'Hub:62d4306e (#3434 UX fixes); fleet:10a695e6 (preserved byte-for-byte)',appHtmlSha256:createHash('sha256').update(appHtml).digest('hex'),hubShell:'landed #3434: single title, sub-page crumb, one body gutter, no notices outside their page',rendered:checks.length,preservedFleet:previous?10:0,checks:allChecks,requestPaths:[...requestPaths].sort(),serverErrors:errors},null,2)+'\n');
 console.log(JSON.stringify({pngs:checks.length,realShell:true,settingsHubSelected:checks.filter(x=>x.settingsHub).length,pageErrors:checks.flatMap(x=>x.pageErrors).length,serverErrors:errors.length}));
}finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
