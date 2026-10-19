/** Actual Shell+ChatPanel, inert data, host canvas probes only. No fleet, account, preview/effect iframe or Worker. */
import assert from "node:assert/strict";
import { inflateSync, deflateSync } from "node:zlib";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const pw = createRequire(join(resolve(process.env.PW_DIR!), "package.json"))("playwright");
const out = resolve(process.env.OUT_DIR || ".artifacts/stock-native"); mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(out, "private-")); mkdirSync(join(scratch, "home")); mkdirSync(join(scratch, "tmp"));
const crc = (data: Buffer) => { let n=0xffffffff;for(const b of data){n^=b;for(let j=0;j<8;j++)n=(n>>>1)^(n&1?0xedb88320:0);}return(n^0xffffffff)>>>0; };
const chunk = (type: string, data: Buffer) => {const name=Buffer.from(type),len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([len,name,data,sum]);};
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6;
const background=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,32,96,224,255]))),chunk('IEND',Buffer.alloc(0))]);
const actions: string[] = [];
const rows: any[] = [], ts = new Date().toISOString();
const message = { boot: "probe", id: 1, instance: "worker", sender: "worker", role: "agent", text: "A stock conversation with a protected reply control and [a link](https://example.invalid).\n\n```js\nconst n = 1;\n```\n\n```html\n<p>unterminated", ts, attachments:[{id:"d".repeat(32),name:"wide.csv",mime:"text/csv",size:600}], buttons: { id: "a".repeat(32), state: "open", labels: ["Approve", "Decline"] } };
function pixel(png,x,y){
 assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');let at=8,width=0,height=0,channels=0;const parts=[];
 while(at<png.length){const size=png.readUInt32BE(at),type=png.subarray(at+4,at+8).toString(),data=png.subarray(at+8,at+8+size);at+=size+12;
  if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);assert.equal(data[8],8);channels=data[9]===2?3:data[9]===6?4:0;assert.ok(channels);assert.equal(data[12],0);assert.ok(width*height<2e6);}
  if(type==='IDAT')parts.push(data);if(type==='IEND')break;
 }
 assert.ok(x>=0&&x<width&&y>=0&&y<height);const raw=inflateSync(Buffer.concat(parts)),stride=width*channels,rows=Buffer.alloc(stride*height);assert.equal(raw.length,(stride+1)*height);
 const paeth=(a,b,c)=>{const p=a+b-c,A=Math.abs(p-a),B=Math.abs(p-b),C=Math.abs(p-c);return A<=B&&A<=C?a:B<=C?b:c;};
 for(let row=0;row<height;row++){const filter=raw[row*(stride+1)];assert.ok(filter<=4);for(let i=0;i<stride;i++){const left=i>=channels?rows[row*stride+i-channels]:0,up=row?rows[(row-1)*stride+i]:0,corner=row&&i>=channels?rows[(row-1)*stride+i-channels]:0;rows[row*stride+i]=(raw[row*(stride+1)+i+1]+(filter===0?0:filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):paeth(left,up,corner)))&255;}}
 return [...rows.subarray((y*width+x)*channels,(y*width+x)*channels+3)];
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost"), path = url.pathname;
  if (/^\/assets\/[a-z0-9._-]+$/.test(path) || /^\/ui\/js\/[a-z0-9_-]+\.js$/.test(path)) {
    try { res.setHeader("Content-Type", path.endsWith(".css") ? "text/css" : "text/javascript"); res.end(readFileSync(join("src/ui", path.startsWith("/assets/") ? "shared" : "", path.split("/").at(-1)!))); }
    catch { res.statusCode = 404; res.end(); } return;
  }
  if(path === "/ui/file/"+"d".repeat(32)){res.setHeader("Content-Type","text/csv");res.end(Array.from({length:51},(_,i)=>"column"+i).join(","));return;}
  if(path.startsWith("/ui/img/theme/")){res.setHeader("Content-Type","image/png");res.end(background);return;}
  if (path !== "/") {
    res.setHeader("Content-Type", "application/json");
    if(req.method === "POST")actions.push(path);
    const answer = path === "/api/card/worker" ? {tagline:{text:"Stock identity card",by:"agent"}} : path === "/ui/reply-button" ? {answered:true} : path === "/ui/history" ? { messages: [message] } : path === "/auth/session" ? { label: "Scratch browser", expiresAt: Date.now() + 60000, idleMs: 60000 } : path === "/auth/sessions" ? { sessions: [] } : { ok: true, instances: [], themes: {}, records: [], entries: [] };
    res.end(JSON.stringify(answer)); return;
  }
  res.setHeader("Content-Type", "text/html");
  res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self' 'nonce-stock-probe'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'");
  res.end(`<!doctype html><html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><link rel=stylesheet href=/assets/tokens.css><link rel=stylesheet href=/assets/app.css><body data-mode=full><div id=app class=app-root></div><script type=module nonce=stock-probe>
import{html,render}from'/assets/app-html.js';import{Shell,openDrawer,closeDrawer,showDialog,closeDialog}from'/assets/app-shell.js';import{appStore}from'/assets/app-store.js';import{navStore}from'/assets/app-nav.js';import{ChatPanel,boot}from'/ui/js/panel-chat.js';import{stockEffectTrust}from'/assets/effect-stock-trust.js';import{createEffectGeometry}from'/assets/effect-geometry.js';import{Dialog}from'/assets/ui-dialog.js';import{setLang}from'/assets/app-i18n.js';import{themesStore}from'/assets/app-themes.js';import{toast}from'/assets/ui-toast.js';import{ownerCssTrial}from'/assets/owner-css.js';import{openPanel,closePanel}from'/ui/js/preview-panel.js';import{startTour,endTour as stopTour}from'/ui/js/chat-tour.js';
const q=new URL(location.href).searchParams;setLang(q.get('lang')||'en',{store:false});document.documentElement.dataset.theme=q.get('dark')==='1'?'dark':'light';
const data={ready:true,connection:'open',instances:[{name:'worker',backend:'codex',state:'idle',model:'probe',card_v:'native-card'}],exec:{worker:'idle'},awaiting:{worker:null},connections:1};appStore.set(data);navStore.set({route:{panel:'chat',instance:'worker'},seq:1});
const store=boot({stream:{on(){return()=>{}}},boot:null,deps:{announce(){},toast(){}}});
store.onPrompt({nonce:'probe-permission',instance:'worker',text:'Host-owned permission question for worker',links:[{offset:35,length:6,url:'/view/worker'}],actions:[{id:'yes',label:'Allow'},{id:'no',label:'Deny'}],expiresAt:Date.now()+600000});
render(html\`<\${Shell} panels=\${new Map([['chat',{Component:ChatPanel}]])} onNewInstance=\${()=>{}} />\`,document.querySelector('#app'));
let root=null,geometry=null,binding=null;
const removePaint=()=>{geometry?.dispose();geometry=null;binding=null;root?.remove();root=null;};
const paint=(layer='behind',by='agent')=>{removePaint();root=document.createElement('div');root.className='agend-effect-layer';document.body.append(root);const snapshot=stockEffectTrust(window,{frameRoot:root,ownerCss:'off'});if(!snapshot.ok||layer==='front'&&!snapshot.front||layer==='front'&&by!=='human'&&!snapshot.agentFront){removePaint();return false;}const canvas=document.createElement('canvas');canvas.className='agend-effect-frame';canvas.width=innerWidth;canvas.height=innerHeight;const c=canvas.getContext('2d');c.fillStyle='#ff1414';c.fillRect(0,0,canvas.width,canvas.height);root.append(canvas);geometry=createEffectGeometry({window});if(!geometry.ok){removePaint();return false;}binding=geometry.bind(canvas,{layer,by});if(!binding.ok||!binding.sync({x:0,y:0,width:innerWidth,height:innerHeight},snapshot)){removePaint();return false;}return true;};
window.stock={longThread:()=>{for(let i=0;i<6;i++)store.ingest({boot:'probe',id:50+i,instance:'worker',role:'agent',sender:'worker',text:('A stock paragraph '+i+'\\n\\n').repeat(20),ts:new Date().toISOString()});},theme:()=>themesStore.set({shown:true,themes:{worker:{background:{image:'c'.repeat(32),fit:'cover',opacity:0.6}}},widgets:{worker:{chat_header:{spec:{v:1,title:'Host widget',items:[{type:'stat',label:'Count',key:'count'}]},data:{count:7},by:'agent'}}}}),paint,removePaint,hide:()=>binding?.hide(),snapshot:(ownerCss='off')=>stockEffectTrust(window,{ownerCss}),openDrawer,closeDrawer,closeDialog,dialog:()=>showDialog(Dialog,{title:'Host dialog',children:'A protected host dialog'}),toast:()=>toast('Host notification'),keep:()=>ownerCssTrial.set({id:'a'.repeat(32),sha:'b'.repeat(32),deadline:performance.now()+15000}),revert:()=>ownerCssTrial.set(()=>null),preview:()=>openPanel({key:'probe',instance:'worker',msgKey:'probe:1',n:0,code:'<p>Inert code only</p>',sender:'worker',ts:'probe'},{run:false}),closePanel,tour:()=>startTour(),stopTour,store};
</script>`);
});
let browser: any;
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const port = (server.address() as any).port;
  for (const engine of (process.env.PROBE_ENGINES || "chromium,firefox,webkit").split(",")) {
    browser = await pw[engine].launch({ headless: true, env: { HOME: join(scratch, "home"), TMPDIR: join(scratch, "tmp"), PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
    for (const [width,lang,dark] of [[1366,"en",false],[390,"zh-TW",true]] as const) {
    const context = await browser.newContext({ viewport: { width, height: 900 } }), page = await context.newPage(), errors: string[] = [], resources: string[] = [];
    // #2217: the chat's card is hidden by default and has no toggle row; it is shown here (this device's choice), and its
    // card control — the header's card menu button (2026-10-20: no control on the card) — is the stock control probed.
    await context.addInitScript({ content: 'try { localStorage.setItem("agend_chat_card", "open"); } catch {}' });
    page.on("pageerror", (e: Error) => { errors.push(e.message); console.error("pageerror", e.message); });
    await page.route("**/*", (r: any) => { const u = new URL(r.request().url()); resources.push(u.pathname); return u.hostname === "127.0.0.1" && u.port === String(port) ? r.continue() : r.abort(); });
    try {
      await page.goto(`http://127.0.0.1:${port}/?lang=${lang}&dark=${dark?1:0}`); await page.locator('.rb-row').waitFor({timeout:5000}); await page.locator('.prompts').waitFor({timeout:5000}); await page.locator('.panel-head .chat-card-menu > button').waitFor({timeout:5000});
      await page.waitForTimeout(150);
      await page.evaluate(() => { const el=document.activeElement; if(el instanceof HTMLElement)el.blur(); });
      const snapshot = await page.evaluate(() => (window as any).stock.snapshot());
      const diagnostics = await page.evaluate(() => ({ active: document.activeElement?.tagName, barriers: [...document.querySelectorAll('[role=menu],[role=dialog],[role=alertdialog],[role=listbox],dialog[open],details[open],.toast,.pending-stack:not(.inline),.oc-keep,.shell.sb-open,.p-chat.dragging,.agend-session-ended')].filter(e=>e.getClientRects().length>0&&getComputedStyle(e).display!=="none"&&getComputedStyle(e).visibility==="visible").map(e=>e.className), markers: [...document.querySelectorAll('[data-trust]')].map(e => ({ tag: e.tagName, cls: e.className, kind: e.getAttribute('data-trust') })), style: [...document.querySelectorAll('html,body,#app,.shell,.main,.p-chat,.chat-split,.chat-main,.scroller,.dock,.panel-head')].map(e => { const s=getComputedStyle(e); return { cls:e.className,tag:e.tagName,z:s.zIndex,opacity:s.opacity,isolation:s.isolation,contain:s.contain,will:s.willChange,transform:s.transform,mask:s.maskImage,clip:s.clipPath,zoom:s.zoom,blend:s.mixBlendMode }; }) }));
      assert.deepEqual(errors, []); assert.equal(snapshot.ok, true, JSON.stringify({snapshot,diagnostics})); assert.equal(snapshot.agentFront, true);
      const baseline = await page.screenshot({ path: join(out, `${engine}-${width}-stock.png`) });
      const points = await page.evaluate(() => ['.composer-box','.rb-btn','.prompts .btn','.panel-head .chat-card-menu > button',...(innerWidth>=900?['.side-resize']:[])].map(q=>{const r=document.querySelector(q).getBoundingClientRect();return{x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2),q};}));
      const permissionPaint=await page.locator('.prompt').evaluate(el=>{const r=el.getBoundingClientRect();return{x:Math.floor(r.x+8),y:Math.floor(r.y+r.height/2)};});
      assert.equal(await page.evaluate(()=>(window as any).stock.paint('behind')),true);
      const behind=await page.screenshot({path:join(out,`${engine}-${width}-behind.png`)});
      // Card toggle / resize use transparent stock backgrounds; their front protection is tested below.
      for(const p of points.filter(p=>!['.panel-head .chat-card-menu > button','.side-resize'].includes(p.q)))assert.deepEqual(pixel(behind,p.x,p.y),pixel(baseline,p.x,p.y),'behind '+p.q);
      const free=await page.evaluate(()=>{const r=document.querySelector('.chat-main > .scroller').getBoundingClientRect(),holes=(window as any).stock.snapshot().rects;for(let y=Math.ceil(r.y+8);y<r.y+r.height-8;y+=8)for(const x of [Math.ceil(r.x+8),Math.floor(r.x+r.width-8)])if(holes.every(h=>x<h.x-10||x>h.x+h.width+10||y<h.y-10||y>h.y+h.height+10))return{x,y};throw Error('no uncovered sample');});
      assert.notDeepEqual(pixel(behind,free.x,free.y),pixel(baseline,free.x,free.y),'behind must actually paint');
      assert.equal(await page.evaluate(()=>(window as any).stock.paint('front')),true);const front=await page.screenshot({path:join(out,`${engine}-${width}-front.png`)});
      for(const p of [...points,permissionPaint])assert.deepEqual(pixel(front,p.x,p.y),pixel(baseline,p.x,p.y),'front '+JSON.stringify(p));
      assert.notDeepEqual(pixel(front,free.x,free.y),pixel(baseline,free.x,free.y),'front must actually paint');
      const clicks=actions.filter(p=>p==='/ui/reply-button').length;await Promise.all([page.waitForResponse(r=>r.url().endsWith('/ui/reply-button')),page.locator('.rb-btn').first().click()]);await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('.rb-btn')?.disabled);assert.equal(actions.filter(p=>p==='/ui/reply-button').length,clicks+1);
      await page.evaluate(()=>(window as any).stock.removePaint());
      const overlays=[];
      await page.locator('.panel-head .menu>button').last().click();await page.locator('.menu-list').waitFor();assert.equal(await page.locator('.menu-list').evaluate(el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return !!hit&&el.contains(hit);}),true,'stock menu must paint/hit above chat content');assert.equal(await page.evaluate(()=>(window as any).stock.snapshot().front),false);overlays.push('menu');await page.locator('.menu-list [role=menuitem]').first().focus();await page.keyboard.press('Escape');await page.locator('.menu-list').waitFor({state:'detached'});
      await page.evaluate(()=>(window as any).stock.dialog());await page.locator('dialog[open]').waitFor();assert.equal(await page.evaluate(()=>(window as any).stock.snapshot().front),false);overlays.push('native-dialog');await page.evaluate(()=>(window as any).stock.closeDialog());
      await page.evaluate(()=>(window as any).stock.keep());await page.locator('.oc-keep').waitFor();assert.equal(await page.evaluate(()=>(window as any).stock.snapshot().front),false);overlays.push('keep');await page.evaluate(()=>(window as any).stock.revert());
      await page.evaluate(()=>(window as any).stock.tour());await page.locator('#tour').waitFor();assert.equal(await page.evaluate(()=>(window as any).stock.snapshot().front),false);overlays.push('tour-portal');await page.evaluate(()=>(window as any).stock.stopTour());
      // #2129: the stock composer's focus no longer blocks unrelated drawing (its protected pixels and editable-focus pointer
      // denial stay — checked by their own probes); #2220: this probe had kept the old rule.
      await page.locator('.composer textarea').focus();assert.equal(await page.evaluate(()=>(window as any).stock.snapshot().front),true);overlays.push('composer-focus');await page.locator('.composer textarea').blur();
      if(width<900){await page.evaluate(()=>(window as any).stock.openDrawer());assert.equal(await page.evaluate(()=>(window as any).stock.snapshot().front),false);overlays.push('drawer');await page.evaluate(()=>(window as any).stock.closeDrawer());}
      const controls=[];
      for(const change of ['missing-trust','root-z','negative-content','isolation','transform']){
        await page.evaluate(c=>{const s=document.querySelector('link[href="/assets/app.css"]').sheet;(window as any).badRule=s.cssRules.length;const rules={'root-z':'#app{position:relative!important;z-index:1!important}','negative-content':'.chat-main>.scroller{z-index:-1!important}','isolation':'#app{isolation:isolate!important}','transform':'#app{transform:translateX(1px)!important}'};if(c==='missing-trust')document.querySelector('.dock').removeAttribute('data-trust');else s.insertRule(rules[c],s.cssRules.length);},change);
        assert.equal(await page.evaluate(()=>(window as any).stock.snapshot().ok),false,change);assert.equal(await page.evaluate(()=>(window as any).stock.paint('behind')),false,change);assert.equal(await page.locator('canvas').count(),0);controls.push(change);
        await page.evaluate(c=>{if(c==='missing-trust')document.querySelector('.dock').setAttribute('data-trust','composer');else document.querySelector('link[href="/assets/app.css"]').sheet.deleteRule((window as any).badRule);},change);
      }
      assert.equal(await page.evaluate(()=>(window as any).stock.snapshot().ok),true);
      await page.evaluate(()=>(window as any).stock.theme());await page.waitForFunction(()=>{const img=document.querySelector<HTMLImageElement>('.th-bg');return img?.complete&&img.naturalWidth===1;});
      const themed=await page.evaluate(()=>(window as any).stock.snapshot());if(!themed.ok){const styles=await page.evaluate(()=>[...document.querySelectorAll('html,body,#app,.shell,.main,.p-chat,.chat-split,.chat-main,.conn,.panel-head,.chat-card,.aw-chat_header,.scroller,.dock,.side-head,.side-nav,.side-section,.side-widget,.side-foot,.u-rail-head,.u-rail-body')].map(el=>{const s=getComputedStyle(el);return{tag:el.tagName,cls:el.className,rects:el.getClientRects().length,style:Object.fromEntries(['position','display','zIndex','opacity','isolation','mixBlendMode','contain','willChange','contentVisibility','zoom','transform','perspective','filter','backdropFilter','rotate','scale','translate','offsetPath','clipPath','maskImage'].map(k=>[k,s[k]]))};}));writeFileSync(join(out,engine+'-'+width+'-unknown.json'),JSON.stringify(styles,null,2));}assert.equal(themed.ok,true,JSON.stringify(themed));await page.locator('.aw-chat_header[data-trust="widget"]').waitFor();const themeBase=await page.screenshot();const themePoint=await page.locator('.composer-box').evaluate(el=>{const r=el.getBoundingClientRect();return{x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2)};});assert.equal(await page.evaluate(()=>(window as any).stock.paint('behind')),true);const themePaint=await page.screenshot({path:join(out,`${engine}-${width}-theme-behind.png`)});assert.deepEqual(pixel(themePaint,themePoint.x,themePoint.y),pixel(themeBase,themePoint.x,themePoint.y));await page.evaluate(()=>(window as any).stock.removePaint());
      // Reviewer R2: real opened preview is a desktop level1 owner, or the narrow modal sheet.
      await page.evaluate(()=>(window as any).stock.preview());await page.locator('.pv-panel').waitFor();await page.evaluate(()=>{const a=document.activeElement;if(a instanceof HTMLElement)a.blur();});
      assert.equal(await page.evaluate(()=>(window as any).stock.snapshot().ok),true);
      if(width>=900){
        const previewState=await page.evaluate(()=>({s:(window as any).stock.snapshot(),active:document.activeElement?.outerHTML?.slice(0,180),barriers:[...document.querySelectorAll('[role=menu],[role=dialog],[role=alertdialog],[role=listbox],dialog[open],details[open],.toast,.pending-stack:not(.inline),.oc-keep,.shell.sb-open,.p-chat.dragging,.agend-session-ended,audio[controls],video[controls]')].filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility==='visible'&&getComputedStyle(el).display!=='none').map(el=>el.outerHTML.slice(0,180))}));assert.equal(previewState.s.front,true,JSON.stringify(previewState));
        const basePreview=await page.screenshot();const pp=await page.locator('.pv-panel-bar .btn').first().evaluate(el=>{const r=el.getBoundingClientRect();return{x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2)};});
        for(const layer of ['behind','front']){assert.equal(await page.evaluate(l=>(window as any).stock.paint(l),layer),true);const shot=await page.screenshot();assert.deepEqual(pixel(shot,pp.x,pp.y),pixel(basePreview,pp.x,pp.y),'preview '+layer);await page.evaluate(()=>(window as any).stock.removePaint());}
        for(const rule of ['.chat-split>.pv-panel{z-index:-1!important}', '.chat-split>.pv-divider{z-index:-1!important}', '.chat-split>.pv-panel{transform:translateX(1px)!important}', '.chat-split>.pv-panel{opacity:.5!important}', '.chat-split>.pv-panel{display:contents!important}']){
          const at=await page.evaluate(rule=>{const s=document.querySelector('link[href="/assets/app.css"]').sheet;return s.insertRule(rule,s.cssRules.length);},rule);assert.equal(await page.evaluate(()=>(window as any).stock.snapshot().ok),false);assert.equal(await page.evaluate(()=>(window as any).stock.paint('behind')),false);await page.evaluate(at=>document.querySelector('link[href="/assets/app.css"]').sheet.deleteRule(at),at);
        }
      }else{assert.equal(await page.evaluate(()=>(window as any).stock.snapshot().front),false);overlays.push('preview-sheet');}
      await page.evaluate(()=>(window as any).stock.closePanel());await page.locator('.pv-panel').waitFor({state:'detached'});
      // Real truncated HTML and too-wide CSV fallback notes, not modeled note elements.
      await page.locator('.tc-show').click();await page.waitForFunction(()=>document.querySelectorAll('.thread .pv-note').length>=3);
      const noteKinds=await page.locator('.thread .pv-note').evaluateAll(xs=>xs.map(x=>x.getAttribute('data-trust')));assert.ok(noteKinds.every(x=>x==='thread-control'));
      for(const index of [0,2]){await page.locator('.thread .pv-note').nth(index).scrollIntoViewIfNeeded();const noteBase=await page.screenshot(),np=await page.locator('.thread .pv-note').nth(index).evaluate(el=>{const r=el.getBoundingClientRect();return{x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2)};});assert.equal(await page.evaluate(()=>(window as any).stock.paint('front')),true);const noteFront=await page.screenshot();assert.deepEqual(pixel(noteFront,np.x,np.y),pixel(noteBase,np.x,np.y));await page.evaluate(()=>(window as any).stock.removePaint());await page.locator('.thread .pv-note').nth(index).evaluate(x=>x.removeAttribute('data-trust'));assert.equal(await page.evaluate(()=>(window as any).stock.snapshot().ok),false);await page.locator('.thread .pv-note').nth(index).evaluate(x=>x.setAttribute('data-trust','thread-control'));}
      // Actual host offer renderer: its text is protected paint and never markup. #2041: a signed-in local admin's card has
      // the host's own Try button (an explicit click is the consent); #2193: the card is drawn once while the effects
      // runtime wakes ("checking") and again with the runtime's answer — so it is located after that settles (#2220).
      await page.evaluate(() => (window as any).stock.store.ingest({boot:'probe',id:900,instance:'worker',role:'status',sender:'agend',text:'Host trial offer',ts:new Date().toISOString(),effectTrial:{v:1,offer:'e'.repeat(32),id:'f'.repeat(32),title:'<b>Host offer</b>',expiresAt:Date.now()+600000}}));
      const checking=lang==='zh-TW'?'正在確認工作階段':'Checking this session';
      await page.waitForFunction(c=>{const el=document.querySelector('.thread .effect-trial-offer');return !!el&&!(el.textContent||'').includes(c);},checking,{timeout:15000});
      const card=page.locator('.thread .effect-trial-offer');await card.scrollIntoViewIfNeeded();
      assert.equal(await card.getAttribute('data-trust'),'thread-control');assert.equal(await card.locator('b,a,iframe,canvas,input').count(),0);
      const offerButtons=await card.locator('button').evaluateAll(xs=>xs.map(x=>x.className));assert.deepEqual(offerButtons,['btn btn-sm effect-trial-start'],'exactly the host Try button');
      assert.equal(await card.locator('strong').textContent(),(lang==='zh-TW'?'效果試播':'Effect trial')+': <b>Host offer</b>');
      const offerBase=await page.screenshot(),offerPoints=await card.evaluate(el=>{const r=el.getBoundingClientRect();return[{x:Math.floor(r.x+3),y:Math.floor(r.y+3)},{x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2)},{x:Math.floor(r.right-3),y:Math.floor(r.bottom-3)}];});
      assert.equal(await page.evaluate(()=>(window as any).stock.paint('front')),true);const offerFront=await page.screenshot();
      for(const point of offerPoints)assert.deepEqual(pixel(offerFront,point.x,point.y),pixel(offerBase,point.x,point.y),'offer protected pixel');
      await page.evaluate(()=>(window as any).stock.removePaint());const beforeOfferClick=actions.length;await card.locator('strong').click();assert.equal(actions.length,beforeOfferClick);
      for(const marker of [null,'reply']){await card.evaluate((el,value)=>value===null?el.removeAttribute('data-trust'):el.setAttribute('data-trust',value),marker);assert.equal(await page.evaluate(()=>(window as any).stock.snapshot().ok),false);await card.evaluate(el=>el.setAttribute('data-trust','thread-control'));}
      assert.equal(await page.evaluate(()=>(window as any).stock.snapshot().ok),true);
      // Main carry: the actual click chip is a protected stock control, including its full child paint.
      await page.evaluate(() => (window as any).stock.store.ingest({boot:'probe',id:901,instance:'worker',role:'user',sender:'person',text:'clicked value must not be shown',ts:new Date().toISOString(),click:{label:'Approve',of:'a'.repeat(32)}}));
      const chip=page.locator('.thread .click-chip');await chip.waitFor();await chip.scrollIntoViewIfNeeded();await page.evaluate(()=>{const a=document.activeElement;if(a instanceof HTMLElement)a.blur();});
      assert.equal(await chip.getAttribute('data-trust'),'thread-control');assert.equal(await chip.locator('button[data-act=showButtons]').count(),1);
      const chipBase=await page.screenshot(),chipPoints=await chip.evaluate(el=>{const r=el.getBoundingClientRect();return[{x:Math.floor(r.x+2),y:Math.floor(r.y+2)},{x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2)},{x:Math.floor(r.right-2),y:Math.floor(r.bottom-2)}];});
      assert.equal(await page.evaluate(()=>(window as any).stock.paint('front')),true);const chipFront=await page.screenshot();for(const p of chipPoints)assert.deepEqual(pixel(chipFront,p.x,p.y),pixel(chipBase,p.x,p.y),'click chip protected pixel');await page.evaluate(()=>(window as any).stock.removePaint());
      for(const marker of [null,'reply']){await chip.evaluate((el,value)=>value===null?el.removeAttribute('data-trust'):el.setAttribute('data-trust',value),marker);assert.equal(await page.evaluate(()=>(window as any).stock.snapshot().ok),false);await chip.evaluate(el=>el.setAttribute('data-trust','thread-control'));}
      const beforeShow=actions.length;await chip.locator('button').click();assert.equal(actions.length,beforeShow);await page.evaluate(()=>{const a=document.activeElement;if(a instanceof HTMLElement)a.blur();});
      // Main topic-link carry: both actual status and permission producers are protected stock links.
      await page.evaluate(() => (window as any).stock.store.ingest({boot:'probe',id:902,instance:'worker',role:'status',sender:'agend',text:'Open worker',links:[{offset:5,length:6,url:'/ui/chat/worker'}],ts:new Date().toISOString()}));
      for(const selector of ['.thread .st-text > a.st-link','.dock .prompts .txt > a.st-link']){
        const link=page.locator(selector);await link.waitFor();await link.scrollIntoViewIfNeeded();
        assert.equal(await link.getAttribute('data-trust'),'link');
        // Keep hover and layout settlement identical across both screenshots; exact pixels stay required.
        await page.mouse.move(0,0);await page.waitForTimeout(100);const linkBase=await page.screenshot(),linkPoints=await link.evaluate(el=>{const r=el.getBoundingClientRect();return[{x:Math.floor(r.x+1),y:Math.floor(r.y+1)},{x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2)},{x:Math.floor(r.right-1),y:Math.floor(r.bottom-1)}];});
        assert.equal(await page.evaluate(()=>(window as any).stock.paint('front')),true);const linkFront=await page.screenshot();await page.evaluate(()=>(window as any).stock.removePaint());const linkAfter=await page.screenshot();writeFileSync(join(out,engine+'-'+width+(selector.startsWith('.thread')?'-status':'-prompt')+'-topic-pixels.json'),JSON.stringify({selector,linkPoints,pixels:linkPoints.map(p=>({p,base:pixel(linkBase,p.x,p.y),front:pixel(linkFront,p.x,p.y),after:pixel(linkAfter,p.x,p.y)}))},null,2));for(const p of linkPoints)assert.deepEqual(pixel(linkFront,p.x,p.y),pixel(linkBase,p.x,p.y),'topic link protected pixel');
        for(const marker of [null,'reply']){await link.evaluate((el,value)=>value===null?el.removeAttribute('data-trust'):el.setAttribute('data-trust',value),marker);assert.equal(await page.evaluate(()=>(window as any).stock.snapshot().ok),false);await link.evaluate(el=>el.setAttribute('data-trust','link'));}
      }
      await page.evaluate(()=>(window as any).stock.longThread());await page.waitForTimeout(50);await page.locator('.scroller').evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll'));});await page.locator('.jump-latest').waitFor();
      const jumpBase=await page.screenshot();const jp=await page.locator('.jump-latest').evaluate(el=>{const r=el.getBoundingClientRect();return{x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2)};});assert.equal(await page.evaluate(()=>(window as any).stock.paint('front')),true);const jumpFront=await page.screenshot();assert.deepEqual(pixel(jumpFront,jp.x,jp.y),pixel(jumpBase,jp.x,jp.y));await page.evaluate(()=>(window as any).stock.removePaint());
      for(const selector of ['.chat-card','.jump-latest',...(width>=900?['.side-resize']:[])])for(const kind of ['', 'wrong']){
        const old=await page.locator(selector).getAttribute('data-trust');await page.locator(selector).evaluate((el,k)=>el.setAttribute('data-trust',k),kind);assert.equal(await page.evaluate(()=>(window as any).stock.snapshot().ok),false,selector+kind);await page.locator(selector).evaluate((el,k)=>el.setAttribute('data-trust',k),old);
      }
      for(const css of ['on','loading','unknown']){const v=await page.evaluate(c=>(window as any).stock.snapshot(c),css);assert.equal(v.agentFront,false);assert.equal(v.front,true);assert.equal(v.agentReason,'owner_css');}
      assert.equal(await page.locator('iframe').count(),0);assert.deepEqual(errors,[]);
      rows.push({ engine,width,lang,dark,snapshot,diagnostics,points,free,permissionBackground:{stock:pixel(baseline,permissionPaint.x,permissionPaint.y),behind:pixel(behind,permissionPaint.x,permissionPaint.y),front:pixel(front,permissionPaint.x,permissionPaint.y)},painted:true,themeImage:true,topicLinks:{status:true,prompt:true,protectedPixels:6,missingWrongMarker:true},clickChip:{protectedPixels:3,missingWrongMarker:true,noReplyPost:true},trialOffer:{protectedPixels:3,inert:true,missingWrongMarker:true},reviewerR2:{identity:true,jump:true,resize:width>=900,preview:true,notes:noteKinds},overlays,controls,errors,resources });
    } finally { await context.close(); }
    }
    await browser.close(); browser = null;
  }
} finally {
  await browser?.close(); await new Promise<void>(r => server.close(() => r())); rmSync(scratch, { recursive: true, force: true });
  writeFileSync(join(out, "receipt.json"), JSON.stringify({ scratchRemoved: true, noFleet: true, noEffectExecution: true, rows }, null, 2));
}
console.log(JSON.stringify(rows));
